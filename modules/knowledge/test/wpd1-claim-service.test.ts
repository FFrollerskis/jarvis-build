import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { LocalHashEmbedding, MemoryWriter, RuleBasedExtractor, withMemoryTransaction } from "@jarvis/memory";
import {
  CLAIM_NOT_FOUND_NOTICE,
  CLAIM_REPORT_CLAIM_FIELDS,
  CLAIM_REPORT_EVIDENCE_FIELDS,
  CLAIM_REPORT_FIELDS,
  CLAIM_STATUS_NOTICE,
  ClaimError,
  ClaimVerificationService,
  MAX_CLAIMS_PER_SPACE,
  MAX_EVIDENCE_PER_CLAIM,
  claimHash,
  displayedClaimStatus,
  normalizeClaimText,
  normalizeSourceRef,
  type ClaimPromotionPort
} from "../src/claim-service.ts";
import { InvalidClaimPolicyError } from "../src/claim-verification.ts";

/**
 * WP-D1 (UA-2, Q-26): `ClaimVerificationService` mot EKTE embedded Postgres som app-rolle (FORCE RLS). Beviser at tilstandsmaskinen anvendes i samme transaksjon som hver endring, at tenant- og
 * romisolasjonen holder, at samtidige kall ikke kan gi en tilstand ingen av dem regnet ut, at lesing aldri viser bedre status enn gjenværende evidens støtter, og at promotering bare er et
 * FORSLAG i minnets karantene (aldri autoritativt).
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: ClaimVerificationService;
let writer: MemoryWriter;

const TENANT_A = "tenant-claim-a";
const TENANT_B = "tenant-claim-b";
const NOW = new Date("2026-10-09T12:00:00Z");
const DAY = 86_400_000;
let clockNow = NOW;

function identity(space: MemorySpace = "personal", tenant = TENANT_A): IdentityContext {
  return { person_id: tenant === TENANT_A ? "person-tobias" : "person-other", tenant_id: tenant, memory_space_id: space, session_id: `${tenant}-sess`, device_id: `${tenant}-dev`, channel: "api", auth_strength: "active" };
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd1-claims-"));
  const leased = await startLeasedEmbeddedPostgres(
    (port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_claims LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_claims");
  for (const [tenant, person] of [[TENANT_A, "person-tobias"], [TENANT_B, "person-other"]] as const) {
    // (parametriserte spørringer kan ikke inneholde flere setninger)
    await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, $1, 'person')", [tenant]);
    await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1, $1)", [person]);
    await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($2, $1)", [tenant, person]);
    await adminPool.query(
      "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1 || '-personal', $1, 'personal'), ($1 || '-health', $1, 'health'), ($1 || '-business', $1, 'business')",
      [tenant]
    );
    await adminPool.query("INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ($1 || '-dev', $1, $2, 'pc')", [tenant, person]);
    await adminPool.query(
      "INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id, status) VALUES ($1 || '-sess', $1, $2, 'api', $1 || '-dev', 'active')",
      [tenant, person]
    );
  }
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_claims", password: "pw2" });
  service = new ClaimVerificationService(appPool, { now: () => clockNow });
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch() });
  writer = new MemoryWriter(appPool, new LocalHashEmbedding(), new RuleBasedExtractor(), policy);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

let counter = 0;
const uniqueText = (label: string): string => `${label} påstand nummer ${(counter += 1)} om dokumentert fakta`;
const url = (host: string, path = "/a"): string => `https://${host}${path}`;

async function newClaim(label: string, opts: { space?: MemorySpace; tenant?: string; time_sensitive?: boolean; min?: number; start?: boolean } = {}) {
  const id = identity(opts.space ?? "personal", opts.tenant ?? TENANT_A);
  const result = await service.registerClaim(id, id.memory_space_id, {
    claim_text: uniqueText(label), time_sensitive: opts.time_sensitive, min_independent_sources: opts.min, start_research: opts.start ?? true
  });
  return { id, claim: result.claim };
}

describe("A: registrering - sanert, dedupet og aldri svekket av en ny registrering", () => {
  it("ny påstand er UNKNOWN (eller RESEARCHING med start_research), privat som standard, og teksten renses (kontrolltegn, <>, hemmeligheter)", async () => {
    const id = identity();
    const created = await service.registerClaim(id, "personal", { claim_text: "  Selskapet <b>Acme</b>\u0000 ligger i Oslo.  \n ok  " });
    expect(created.created).toBe(true);
    expect(created.claim.status).toBe("UNKNOWN");
    expect(created.claim.sensitivity).toBe("sensitive");
    expect(created.claim.min_independent_sources).toBe(2);
    expect(created.claim.claim_text).toBe("Selskapet ‹b›Acme‹/b› ligger i Oslo. ok");
    // Hemmeligheter i påstandsteksten redigeres bort FØR lagring (og påstanden løftes til special).
    const secret = await service.registerClaim(id, "personal", { claim_text: "Passordet mitt er bananflue77 for tjenesten" });
    expect(secret.claim.claim_text).not.toContain("bananflue77");
    expect(secret.claim.claim_text).toContain("[REDACTED:spoken_password]");

    const started = await service.registerClaim(id, "personal", { claim_text: uniqueText("start"), start_research: true });
    expect(started.claim.status).toBe("RESEARCHING");
    expect(started.claim.researching_since).toBe(NOW.toISOString());
  });

  it("samme påstand (annen kasus/mellomrom/avsluttende punktum) gir den eksisterende raden UENDRET - N og time_sensitive kan ikke svekkes ved re-registrering", async () => {
    const id = identity();
    const text = uniqueText("dedupe");
    const first = await service.registerClaim(id, "personal", { claim_text: text, min_independent_sources: 4, time_sensitive: true });
    const again = await service.registerClaim(id, "personal", { claim_text: `  ${text.toUpperCase()}.  `, min_independent_sources: 2, time_sensitive: false });
    expect(again.created).toBe(false);
    expect(again.claim.claim_id).toBe(first.claim.claim_id);
    expect(again.claim).toMatchObject({ min_independent_sources: 4, time_sensitive: true });
    const count = await adminPool.query("SELECT count(*)::int AS n FROM claim_verifications WHERE tenant_id = $1 AND claim_hash = $2", [TENANT_A, claimHash(normalizeClaimText(text))]);
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it("ugyldig tekst og ugyldig N avvises (aldri en stille klemming): <3 / >1000 tegn, ikke-streng, N=1 og N=11", async () => {
    const id = identity();
    for (const bad of ["ab", "  \u0000 ", "x".repeat(1001), 42 as unknown as string, null as unknown as string]) {
      await expect(service.registerClaim(id, "personal", { claim_text: bad }), String(bad).slice(0, 10)).rejects.toMatchObject({ reason: "claim_text_invalid" });
    }
    for (const n of [1, 11, 0, 2.5]) {
      await expect(service.registerClaim(id, "personal", { claim_text: uniqueText("n"), min_independent_sources: n }), `N=${n}`).rejects.toBeInstanceOf(InvalidClaimPolicyError);
    }
  });

  it("sensitivitet: helse-rommet er alltid special, og helse-/hemmelighetsinnhold i andre rom løfter til special (aldri til skymodell)", async () => {
    const health = await service.registerClaim(identity("health"), "health", { claim_text: uniqueText("generell") });
    expect(health.claim.sensitivity).toBe("special");
    const text = await service.registerClaim(identity("personal"), "personal", { claim_text: "Legen stilte diagnosen diabetes og ga ny medisin til Tobias" });
    expect(text.claim.sensitivity).toBe("special");
  });

  it("tak på antall påstander per rom (claim_limit_reached)", async () => {
    const id = identity("project");
    await adminPool.query(
      `INSERT INTO claim_verifications (claim_id, tenant_id, memory_space_id, claim_text, claim_hash)
       SELECT 'cl-fill-' || g, $1, 'project', 'fyll ' || g, 'fill-hash-' || g FROM generate_series(1, $2::int) g`,
      [TENANT_A, MAX_CLAIMS_PER_SPACE]
    );
    await expect(service.registerClaim(id, "project", { claim_text: uniqueText("over taket") })).rejects.toMatchObject({ reason: "claim_limit_reached" });
    // Et annet rom og en annen tenant påvirkes ikke.
    await expect(service.registerClaim(identity("personal"), "personal", { claim_text: uniqueText("annet rom") })).resolves.toMatchObject({ created: true });
    await expect(service.registerClaim(identity("business", TENANT_B), "business", { claim_text: uniqueText("annen tenant") })).resolves.toMatchObject({ created: true });
  }, 60_000);
});

describe("B: tilstandsmaskinen anvendt ved hver endring", () => {
  it("evidens før research er startet avvises (ukjent blir aldri stille sannhet), og research kan bare startes én gang", async () => {
    const { id, claim } = await newClaim("ikke startet", { start: false });
    await expect(service.addEvidence(id, "personal", claim.claim_id, { stance: "supports", source_ref: url("a.no") })).rejects.toMatchObject({ reason: "research_not_started" });
    expect((await service.startResearch(id, "personal", claim.claim_id)).status).toBe("RESEARCHING");
    await expect(service.startResearch(id, "personal", claim.claim_id)).rejects.toMatchObject({ reason: "research_already_started" });
  });

  it("tre kopier av samme oppstrøms-påstand er ÉN uavhengig kilde; to sekundære er ikke nok; tre uavhengige gir VERIFIED", async () => {
    const { id, claim } = await newClaim("kopier");
    const add = (ref: string, upstream?: string) => service.addEvidence(id, "personal", claim.claim_id, { stance: "supports", source_ref: ref, upstream_origin: upstream });
    const r1 = await add(url("www.vg.no", "/artikkel-1"), "NTB");
    expect(r1.claim.status).toBe("PROVISIONAL");
    expect(r1.transition).toEqual(["PROVISIONAL"]);
    // To gjengivelser til av samme byrå-sak: fortsatt én uavhengig kilde.
    await add(url("www.dagbladet.no", "/sak"), "NTB");
    const r3 = await add(url("www.nrk.no", "/sak"), "ntb");
    expect(r3.claim).toMatchObject({ status: "PROVISIONAL", independent_support: 1 });
    expect(r3.evaluation.reasons).toContain("duplicate_copies_counted_once");
    // En andre uavhengig kilde, men ingen primærkilde: fortsatt ikke VERIFIED.
    const r4 = await add(url("www.aftenposten.no", "/sak"));
    expect(r4.claim).toMatchObject({ status: "PROVISIONAL", independent_support: 2 });
    expect(r4.evaluation.reasons).toContain("no_primary_source");
    // Tredje uavhengige kilde: oppfylt.
    const r5 = await add(url("www.e24.no", "/sak"));
    expect(r5.claim).toMatchObject({ status: "VERIFIED", independent_support: 3 });
    expect(r5.transition).toEqual(["VERIFIED"]);
    expect(r5.claim.verified_at).toBe(NOW.toISOString());
  });

  it("primærkilde + én uavhengig kilde = VERIFIED; så gir motstridende evidens DISPUTED; tilbaketrekking (med grunn) gir tilbake VERIFIED via PROVISIONAL", async () => {
    const { id, claim } = await newClaim("primær");
    const primary = await service.addEvidence(id, "personal", claim.claim_id, { stance: "supports", source_ref: url("norges-bank.no", "/rente"), is_primary: true });
    expect(primary.claim.status).toBe("PROVISIONAL");
    const second = await service.addEvidence(id, "personal", claim.claim_id, { stance: "supports", source_ref: url("ssb.no", "/tall") });
    expect(second.claim).toMatchObject({ status: "VERIFIED", has_primary_support: true });
    const contra = await service.addEvidence(id, "personal", claim.claim_id, { stance: "contradicts", source_ref: url("motstander.no", "/nei"), excerpt: "Dette stemmer ikke." });
    expect(contra.claim).toMatchObject({ status: "DISPUTED", contradicting_count: 1 });
    expect(contra.transition).toEqual(["DISPUTED"]);
    await expect(service.retractEvidence(id, "personal", claim.claim_id, contra.evidence_id, "   ")).rejects.toMatchObject({ reason: "retraction_reason_required" });
    await expect(service.retractEvidence(id, "personal", claim.claim_id, "ev-finnes-ikke", "feil")).rejects.toMatchObject({ reason: "evidence_not_found" });
    const retracted = await service.retractEvidence(id, "personal", claim.claim_id, contra.evidence_id, "kilden viste seg å være satire");
    expect(retracted.claim.status).toBe("VERIFIED");
    expect(retracted.transition).toEqual(["PROVISIONAL", "VERIFIED"]);
    // Raden beholdes for sporbarhet, og kan ikke trekkes tilbake to ganger eller gjenopplives.
    await expect(service.retractEvidence(id, "personal", claim.claim_id, contra.evidence_id, "igjen")).rejects.toMatchObject({ reason: "evidence_not_found" });
    await expect(service.addEvidence(id, "personal", claim.claim_id, { stance: "contradicts", source_ref: url("motstander.no", "/nei") })).rejects.toMatchObject({ reason: "evidence_retracted" });
    const row = await adminPool.query("SELECT retracted, retraction_reason FROM claim_evidence WHERE evidence_id = $1", [contra.evidence_id]);
    expect(row.rows[0]).toMatchObject({ retracted: true, retraction_reason: "kilden viste seg å være satire" });
  });

  it("samme kilde og holdning en gang til fornyer bare sjekketidspunkt og utdrag - is_primary og opphav kan ikke endres, og antall teller ikke dobbelt", async () => {
    const { id, claim } = await newClaim("fornyelse");
    const first = await service.addEvidence(id, "personal", claim.claim_id, { stance: "supports", source_ref: url("ssb.no", "/x#del"), retrieved_at: new Date(NOW.getTime() - 10 * DAY), excerpt: "gammelt utdrag" });
    expect(first.inserted).toBe(true);
    const again = await service.addEvidence(id, "personal", claim.claim_id, { stance: "supports", source_ref: url("SSB.no", "/x"), is_primary: true, upstream_origin: "Annen", retrieved_at: NOW, excerpt: "nytt utdrag" });
    expect(again.inserted).toBe(false);
    expect(again.evidence_id).toBe(first.evidence_id);
    const row = (await adminPool.query("SELECT is_primary, upstream_origin, retrieved_at, excerpt, source_ref FROM claim_evidence WHERE evidence_id = $1", [first.evidence_id])).rows[0] as Record<string, unknown>;
    expect(row["is_primary"]).toBe(false); // forsøket på å bli primærkilde ble ignorert
    expect(row["upstream_origin"]).toBeNull();
    expect((row["retrieved_at"] as Date).toISOString()).toBe(NOW.toISOString());
    expect(row["excerpt"]).toBe("nytt utdrag");
    expect(row["source_ref"]).toBe("https://ssb.no/x"); // fragment fjernet, vert i små bokstaver
    expect(again.claim.independent_support).toBe(1);
  });

  it("tidssensitiv påstand: udatert evidens teller ikke, fersk gjør, og når kildene eldes ut faller visningen UMIDDELBART (før noen har kjørt reverify), og reverify lagrer det", async () => {
    clockNow = NOW;
    const { id, claim } = await newClaim("tidssensitiv", { time_sensitive: true });
    const undated = await service.addEvidence(id, "personal", claim.claim_id, { stance: "supports", source_ref: url("undated.no"), is_primary: true });
    expect(undated.claim.status).toBe("RESEARCHING");
    expect(undated.evaluation.reasons).toContain("undated_evidence_excluded");
    await service.addEvidence(id, "personal", claim.claim_id, { stance: "supports", source_ref: url("a.no"), is_primary: true, published_at: new Date(NOW.getTime() - 5 * DAY) });
    const verified = await service.addEvidence(id, "personal", claim.claim_id, { stance: "supports", source_ref: url("b.no"), published_at: new Date(NOW.getTime() - 5 * DAY) });
    expect(verified.claim.status).toBe("VERIFIED");
    expect(verified.claim.reverify_by).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString());

    clockNow = new Date(NOW.getTime() + 31 * DAY);
    try {
      const view = await service.getClaim(id, "personal", { claim_id: claim.claim_id });
      expect(view?.claim).toMatchObject({ status: "RESEARCHING", stored_status: "VERIFIED", reverification_due: true });
      expect(view?.claim.independent_support).toBe(0);
      const refreshed = await service.reverify(id, "personal", claim.claim_id);
      expect(refreshed.claim).toMatchObject({ status: "RESEARCHING", stored_status: "RESEARCHING" });
      expect(refreshed.transition).toEqual(["PROVISIONAL", "RESEARCHING"]);
      // Fersk sjekk av en kilde (samme kilde en gang til) bringer påstanden tilbake til PROVISIONAL - ikke til VERIFIED før regelen er oppfylt igjen.
      const renewed = await service.addEvidence(id, "personal", claim.claim_id, { stance: "supports", source_ref: url("a.no"), published_at: new Date(clockNow.getTime() - DAY) });
      expect(renewed.claim.status).toBe("PROVISIONAL");
    } finally {
      clockNow = NOW;
    }
  });

  it("visning er aldri bedre enn gjenværende evidens: forsvinner evidensen (f.eks. erasure av dokumentet) vises ikke lenger VERIFIED, og en DISPUTED påstand forblir DISPUTED til eieren trekker tilbake motstriden", async () => {
    const verifiedClaim = await newClaim("evidens forsvinner");
    const add = (ref: string, primary = false) => service.addEvidence(verifiedClaim.id, "personal", verifiedClaim.claim.claim_id, { stance: "supports", source_ref: ref, is_primary: primary });
    await add(url("a.no"), true);
    await add(url("b.no"));
    expect((await service.getClaim(verifiedClaim.id, "personal", { claim_id: verifiedClaim.claim.claim_id }))?.claim.status).toBe("VERIFIED");
    await adminPool.query("DELETE FROM claim_evidence WHERE claim_id = $1 AND source_ref = $2", [verifiedClaim.claim.claim_id, "https://a.no/a"]);
    const after = await service.getClaim(verifiedClaim.id, "personal", { claim_id: verifiedClaim.claim.claim_id });
    expect(after?.claim).toMatchObject({ status: "PROVISIONAL", stored_status: "VERIFIED", reverification_due: true, independent_support: 1 });

    const disputed = await newClaim("omstridt");
    await service.addEvidence(disputed.id, "personal", disputed.claim.claim_id, { stance: "supports", source_ref: url("a.no"), is_primary: true });
    await service.addEvidence(disputed.id, "personal", disputed.claim.claim_id, { stance: "supports", source_ref: url("b.no") });
    const contra = await service.addEvidence(disputed.id, "personal", disputed.claim.claim_id, { stance: "contradicts", source_ref: url("c.no") });
    expect(contra.claim.status).toBe("DISPUTED");
    await adminPool.query("DELETE FROM claim_evidence WHERE evidence_id = $1", [contra.evidence_id]); // motstriden "forsvinner" uten at noen avgjorde uenigheten
    expect((await service.getClaim(disputed.id, "personal", { claim_id: disputed.claim.claim_id }))?.claim.status).toBe("DISPUTED");
  });

  it("displayedClaimStatus: UNKNOWN/DISPUTED er klebrige, ellers det laveste av lagret og utledet", () => {
    expect(displayedClaimStatus("UNKNOWN", "VERIFIED")).toBe("UNKNOWN");
    expect(displayedClaimStatus("DISPUTED", "VERIFIED")).toBe("DISPUTED");
    expect(displayedClaimStatus("VERIFIED", "DISPUTED")).toBe("DISPUTED");
    expect(displayedClaimStatus("VERIFIED", "PROVISIONAL")).toBe("PROVISIONAL");
    expect(displayedClaimStatus("PROVISIONAL", "VERIFIED")).toBe("PROVISIONAL");
    expect(displayedClaimStatus("PROVISIONAL", "RESEARCHING")).toBe("RESEARCHING");
    expect(displayedClaimStatus("VERIFIED", "VERIFIED")).toBe("VERIFIED");
  });

  it("evidens-tak per påstand (evidence_limit_reached), og ugyldig evidens avvises: holdning, URL med passord/token, skjema, datoer, dokumentreferanser", async () => {
    const { id, claim } = await newClaim("tak og validering");
    const add = (input: Parameters<ClaimVerificationService["addEvidence"]>[3]) => service.addEvidence(id, "personal", claim.claim_id, input);
    const bad: Array<[string, Parameters<ClaimVerificationService["addEvidence"]>[3], string]> = [
      ["holdning", { stance: "kanskje" as unknown as "supports", source_ref: url("x.no") }, "stance_invalid"],
      ["passord i URL", { stance: "supports", source_ref: "https://bruker:hemmelig@x.no/a" }, "source_ref_has_credentials"],
      ["ftp", { stance: "supports", source_ref: "ftp://x.no/a" }, "source_ref_invalid"],
      ["tom kilde", { stance: "supports", source_ref: "   " }, "source_ref_invalid"],
      ["token i URL", { stance: "supports", source_ref: "https://x.no/a?key=AIza" + "A".repeat(35) }, "source_ref_contains_secret"],
      ["for lang kilde", { stance: "supports", source_ref: `https://x.no/${"a".repeat(600)}` }, "source_ref_invalid"],
      ["fremtidig sjekk", { stance: "supports", source_ref: url("x.no"), retrieved_at: new Date(NOW.getTime() + 3600_000) }, "retrieved_at_in_future"],
      ["fremtidig utgivelse", { stance: "supports", source_ref: url("x.no"), published_at: "2027-01-01T00:00:00Z" }, "published_at_in_future"],
      ["utgitt før 1990", { stance: "supports", source_ref: url("x.no"), published_at: "1970-01-01T00:00:00Z" }, "published_at_too_old"],
      ["ugyldig dato", { stance: "supports", source_ref: url("x.no"), published_at: "ikke en dato" }, "published_at_invalid"],
      ["utgitt etter sjekk", { stance: "supports", source_ref: url("x.no"), published_at: NOW, retrieved_at: new Date(NOW.getTime() - 10 * DAY) }, "published_at_after_retrieved_at"],
      ["dokument-id format", { stance: "supports", source_ref: url("x.no"), knowledge_document_id: "../../etc" }, "knowledge_document_id_invalid"],
      ["dokument finnes ikke", { stance: "supports", source_ref: url("x.no"), knowledge_document_id: "kd-00000000-0000-0000-0000-000000000000" }, "knowledge_document_not_found"],
      ["is_primary ikke boolsk", { stance: "supports", source_ref: url("x.no"), is_primary: "ja" as unknown as boolean }, "is_primary_invalid"]
    ];
    for (const [label, input, reason] of bad) await expect(add(input), label).rejects.toMatchObject({ reason });
    // Ingen av dem etterlot evidens.
    expect((await adminPool.query("SELECT count(*)::int AS n FROM claim_evidence WHERE claim_id = $1", [claim.claim_id])).rows[0]).toEqual({ n: 0 });

    await adminPool.query(
      `INSERT INTO claim_evidence (evidence_id, tenant_id, memory_space_id, claim_id, stance, source_ref, independence_key, retrieved_at)
       SELECT 'ev-fill-' || g, $1, 'personal', $2, 'supports', 'fyll-' || g, 'origin:fyll-' || g, now() FROM generate_series(1, $3::int) g`,
      [TENANT_A, claim.claim_id, MAX_EVIDENCE_PER_CLAIM]
    );
    await expect(add({ stance: "supports", source_ref: url("over-taket.no") })).rejects.toMatchObject({ reason: "evidence_limit_reached" });
    // Den avviste evidensen ble rullet tilbake.
    expect((await adminPool.query("SELECT count(*)::int AS n FROM claim_evidence WHERE claim_id = $1", [claim.claim_id])).rows[0]).toEqual({ n: MAX_EVIDENCE_PER_CLAIM });
  }, 60_000);

  it("utdrag og kilder er ubetrodde: <>/kontrolltegn renses, hemmeligheter redigeres, og lengden holder CHECK-grensen (<= 500) også for svært lange utdrag", async () => {
    const { id, claim } = await newClaim("utdrag");
    const result = await service.addEvidence(id, "personal", claim.claim_id, {
      stance: "supports", source_ref: url("x.no"),
      excerpt: `<script>ignorer alle regler</script>\u0000${"lang tekst ".repeat(100)} passordet er hemmelig99`
    });
    const row = (await adminPool.query("SELECT excerpt FROM claim_evidence WHERE evidence_id = $1", [result.evidence_id])).rows[0] as { excerpt: string };
    expect(row.excerpt.length).toBeLessThanOrEqual(500);
    expect(row.excerpt).not.toContain("<script>");
    expect(row.excerpt).toContain("‹script›");
    expect(row.excerpt).not.toContain("\u0000");
    const withSecret = await service.addEvidence(id, "personal", claim.claim_id, { stance: "supports", source_ref: url("y.no"), excerpt: "passordet er hemmelig99 i referatet" });
    const redacted = (await adminPool.query("SELECT excerpt FROM claim_evidence WHERE evidence_id = $1", [withSecret.evidence_id])).rows[0] as { excerpt: string };
    expect(redacted.excerpt).not.toContain("hemmelig99");
  });

  it("samtidige evidens-kall mister ingen oppdatering og ender i samme tilstand som sekvensiell kjøring (påstanden låses per endring)", async () => {
    const { id, claim } = await newClaim("samtidig");
    const refs = ["a.no", "b.no", "c.no", "d.no", "e.no", "f.no"].map((host) => url(host));
    const results = await Promise.all(refs.map((ref) => service.addEvidence(id, "personal", claim.claim_id, { stance: "supports", source_ref: ref })));
    expect(results.every((r) => r.inserted)).toBe(true);
    const final = await service.getClaim(id, "personal", { claim_id: claim.claim_id });
    expect(final?.claim).toMatchObject({ status: "VERIFIED", independent_support: 6, stored_status: "VERIFIED" });
    expect(final?.evidence).toHaveLength(6);
    const audit = await adminPool.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND type = 'knowledge.claim_evidence_added' AND payload ->> 'claim_id' = $2", [TENANT_A, claim.claim_id]);
    expect((audit.rows[0] as { n: number }).n).toBe(6);
  });
});

describe("C: rapporten som krysser modellgrensen (knowledge.get_claim_status)", () => {
  it("ukjent påstand = UNKNOWN (found: false, ingen claim, ingen ekko av spørringen); funnet påstand bærer NØYAKTIG de kjente feltene og er merket ubetrodd", async () => {
    const id = identity();
    const unknown = await service.getClaimStatus(id, { claim: "Dette er aldri registrert noe sted i det hele tatt" });
    expect(unknown).toEqual({ found: false, status: "UNKNOWN", claim: null, notice: CLAIM_NOT_FOUND_NOTICE });
    expect(JSON.stringify(unknown)).not.toContain("aldri registrert");

    const { claim } = await newClaim("rapport");
    await service.addEvidence(id, "personal", claim.claim_id, { stance: "supports", source_ref: url("a.no"), excerpt: "utdrag", is_primary: true });
    const report = await service.getClaimStatus(id, { claim_id: claim.claim_id });
    expect(report.found).toBe(true);
    expect(report.notice).toBe(CLAIM_STATUS_NOTICE);
    expect(Object.keys(report).every((k) => CLAIM_REPORT_FIELDS.has(k))).toBe(true);
    expect(Object.keys(report.claim ?? {}).sort()).toEqual([...CLAIM_REPORT_CLAIM_FIELDS].filter((k) => !["withheld_count", "note"].includes(k)).sort());
    expect(report.claim?.trust_level).toBe("untrusted");
    expect(report.claim?.evidence).toHaveLength(1);
    expect(Object.keys(report.claim?.evidence[0] ?? {}).sort()).toEqual([...CLAIM_REPORT_EVIDENCE_FIELDS].sort());
    // Tekstoppslag finner samme påstand uansett kasus og avsluttende tegnsetting.
    const byText = await service.getClaimStatus(id, { claim: `${claim.claim_text.toUpperCase()}!` });
    expect(byText.claim?.claim_id).toBe(claim.claim_id);
    await expect(service.getClaimStatus(id, {})).rejects.toMatchObject({ reason: "claim_reference_required" });
  });

  it("rapporten viser maks 20 evidensrader", async () => {
    const { id, claim } = await newClaim("mange rader");
    await adminPool.query(
      `INSERT INTO claim_evidence (evidence_id, tenant_id, memory_space_id, claim_id, stance, source_ref, independence_key, retrieved_at)
       SELECT 'ev-rep-' || g, $1, 'personal', $2, 'supports', 'rep-' || g, 'origin:rep-' || g, now() FROM generate_series(1, 30) g`,
      [TENANT_A, claim.claim_id]
    );
    const report = await service.getClaimStatus(id, { claim_id: claim.claim_id });
    expect(report.claim?.evidence).toHaveLength(20);
  });
});

describe("D: promotering er KUN et forslag i minnets karantene", () => {
  async function verified(label: string, space: MemorySpace = "personal") {
    const made = await newClaim(label, { space });
    await service.addEvidence(made.id, space, made.claim.claim_id, { stance: "supports", source_ref: url("norges-bank.no"), is_primary: true });
    await service.addEvidence(made.id, space, made.claim.claim_id, { stance: "supports", source_ref: url("ssb.no") });
    return made;
  }

  it("ukjent, under research, foreløpig og omstridt kan aldri foreslås som etablert kunnskap - og porten kalles aldri", async () => {
    let calls = 0;
    const port: ClaimPromotionPort = { propose: async () => { calls += 1; return { op: "ADD", memory_item_id: "x" }; } };
    const unknown = await newClaim("p unknown", { start: false });
    const researching = await newClaim("p researching");
    const provisional = await newClaim("p provisional");
    await service.addEvidence(provisional.id, "personal", provisional.claim.claim_id, { stance: "supports", source_ref: url("a.no") });
    const disputed = await verified("p disputed");
    await service.addEvidence(disputed.id, "personal", disputed.claim.claim_id, { stance: "contradicts", source_ref: url("c.no") });
    for (const { id, claim } of [unknown, researching, provisional, disputed]) {
      await expect(service.proposePromotion(id, "personal", claim.claim_id, port), claim.claim_text).rejects.toMatchObject({ reason: "only_verified_claims_can_be_proposed" });
    }
    await expect(service.proposePromotion(identity(), "personal", "cl-finnes-ikke", port)).rejects.toMatchObject({ reason: "claim_not_found" });
    expect(calls).toBe(0);
  });

  it("VERIFIED -> forslag i karantene via ekte MemoryWriter: aldri aktivt minne, vises som forslag, påstanden merkes som foreslått, og et nytt kall foreslår ikke på nytt", async () => {
    const { id, claim } = await verified("promotering");
    const outcome = await service.proposePromotion(id, "personal", claim.claim_id, writer);
    expect(outcome.outcome).toBe("proposed");
    const memoryItemId = outcome.memory_item_id as string;
    expect(memoryItemId).toBeTruthy();

    const item = (await adminPool.query("SELECT status, type, subject, content, trust_level FROM memory_items WHERE memory_item_id = $1", [memoryItemId])).rows[0] as Record<string, string>;
    expect(item["status"]).toBe("quarantined"); // ALDRI «active»
    expect(item["type"]).toBe("semantic");
    expect(String(item["subject"]).startsWith("verifisert: ")).toBe(true);
    expect(item["content"]).toContain("2 uavhengige kilder, inkl. primærkilde");
    const proposals = await writer.listProposals(identity());
    expect(proposals.some((p) => p.memory_item_id === memoryItemId)).toBe(true);
    // Ingen aktive minner ble skrevet for påstanden.
    const active = await adminPool.query("SELECT count(*)::int AS n FROM memory_items WHERE tenant_id = $1 AND status = 'active' AND subject LIKE 'verifisert:%'", [TENANT_A]);
    expect((active.rows[0] as { n: number }).n).toBe(0);

    const stored = (await adminPool.query("SELECT promotion_status, promotion_memory_item_id, promotion_proposed_at FROM claim_verifications WHERE claim_id = $1", [claim.claim_id])).rows[0] as Record<string, unknown>;
    expect(stored["promotion_status"]).toBe("proposed");
    expect(stored["promotion_memory_item_id"]).toBe(memoryItemId);
    expect(stored["promotion_proposed_at"]).toBeInstanceOf(Date);

    const items = (await adminPool.query("SELECT count(*)::int AS n FROM memory_items WHERE subject = $1", [item["subject"]])).rows[0] as { n: number };
    const again = await service.proposePromotion(id, "personal", claim.claim_id, writer);
    expect(again).toEqual({ outcome: "already_proposed", memory_item_id: memoryItemId });
    expect(((await adminPool.query("SELECT count(*)::int AS n FROM memory_items WHERE subject = $1", [item["subject"]])).rows[0] as { n: number }).n).toBe(items.n);
  });

  it("forslaget bygges deterministisk av tilstanden (ingen owner_stated, kun semantisk tekst), og porten får identiteten med påstandens rom", async () => {
    const { id, claim } = await verified("deterministisk");
    const seen: Array<{ identity: IdentityContext; input: Record<string, unknown> }> = [];
    const port: ClaimPromotionPort = { propose: async (identityArg, input) => { seen.push({ identity: identityArg, input }); return { op: "ADD", memory_item_id: "mi-1", status: "quarantined" }; } };
    await service.proposePromotion({ ...id, memory_space_id: "business" }, "personal", claim.claim_id, port);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.identity.memory_space_id).toBe("personal"); // påstandens rom, ikke kallerens
    expect(Object.keys(seen[0]?.input ?? {}).sort()).toEqual(["content", "subject", "type"]);
    expect(seen[0]?.input["type"]).toBe("semantic");
    expect(String(seen[0]?.input["content"])).toContain(claim.claim_text);
  });

  it("feiler porten (f.eks. karantenen avviser teksten), forblir påstanden «ikke foreslått» og kan prøves igjen", async () => {
    const { id, claim } = await verified("port feiler");
    await expect(service.proposePromotion(id, "personal", claim.claim_id, { propose: async () => { throw new Error("invalid_proposal_secret"); } })).rejects.toThrow("invalid_proposal_secret");
    expect((await adminPool.query("SELECT promotion_status FROM claim_verifications WHERE claim_id = $1", [claim.claim_id])).rows[0]).toEqual({ promotion_status: "none" });
    await expect(service.proposePromotion(id, "personal", claim.claim_id, { propose: async () => ({ op: "ADD", memory_item_id: "mi-ok" }) })).resolves.toMatchObject({ outcome: "proposed" });
  });

  it("to samtidige promoteringer gir nøyaktig ÉN registrert forslags-markering", async () => {
    const { id, claim } = await verified("race");
    let calls = 0;
    const port: ClaimPromotionPort = { propose: async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return { op: "ADD", memory_item_id: `mi-${calls}` }; } };
    const [a, b] = await Promise.all([service.proposePromotion(id, "personal", claim.claim_id, port), service.proposePromotion(id, "personal", claim.claim_id, port)]);
    expect([a.outcome, b.outcome].sort()).toEqual(["already_proposed", "proposed"]);
    const audit = await adminPool.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND type = 'knowledge.claim_promotion_proposed' AND payload ->> 'claim_id' = $2", [TENANT_A, claim.claim_id]);
    expect((audit.rows[0] as { n: number }).n).toBe(1);
  });

  it("en VERIFIED tidssensitiv påstand etter fristen kan ikke foreslås (beviset beregnes på nytt, ikke bare den lagrede statusen)", async () => {
    clockNow = NOW;
    const made = await newClaim("utløper", { time_sensitive: true });
    for (const [host, primary] of [["a.no", true], ["b.no", false]] as const) {
      await service.addEvidence(made.id, "personal", made.claim.claim_id, { stance: "supports", source_ref: url(host), is_primary: primary, published_at: new Date(NOW.getTime() - DAY) });
    }
    clockNow = new Date(NOW.getTime() + 40 * DAY);
    try {
      await expect(service.proposePromotion(made.id, "personal", made.claim.claim_id, { propose: async () => ({ op: "ADD", memory_item_id: "x" }) })).rejects.toMatchObject({ reason: "only_verified_claims_can_be_proposed" });
    } finally {
      clockNow = NOW;
    }
  });
});

describe("E: tenant- og romisolasjon (RLS som app-rolle)", () => {
  it("en annen tenant ser ingenting og kan ikke endre: oppslag gir null, evidens/start/retract/promotering gir claim_not_found, selv med riktig claim_id", async () => {
    const { id, claim } = await newClaim("isolasjon");
    await service.addEvidence(id, "personal", claim.claim_id, { stance: "supports", source_ref: url("a.no") });
    const other = identity("personal", TENANT_B);
    expect(await service.getClaim(other, "personal", { claim_id: claim.claim_id })).toBeNull();
    expect(await service.getClaim(other, "personal", { claim_text: claim.claim_text })).toBeNull();
    expect((await service.getClaimStatus(other, { claim_id: claim.claim_id })).found).toBe(false);
    for (const attempt of [
      () => service.addEvidence(other, "personal", claim.claim_id, { stance: "supports", source_ref: url("x.no") }),
      () => service.startResearch(other, "personal", claim.claim_id),
      () => service.retractEvidence(other, "personal", claim.claim_id, "ev-x", "grunn"),
      () => service.reverify(other, "personal", claim.claim_id),
      () => service.proposePromotion(other, "personal", claim.claim_id, { propose: async () => ({ op: "ADD" }) })
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(ClaimError);
    }
    // Samme tekst i den andre tenanten er en HELT egen påstand.
    const theirs = await service.registerClaim(other, "personal", { claim_text: claim.claim_text });
    expect(theirs.created).toBe(true);
    expect(theirs.claim.claim_id).not.toBe(claim.claim_id);
  });

  it("et annet rom i samme tenant ser ingenting (selv med riktig id), og samme tekst i to rom er to påstander", async () => {
    const { id, claim } = await newClaim("rom");
    const business = identity("business");
    expect(await service.getClaim(business, "business", { claim_id: claim.claim_id })).toBeNull();
    await expect(service.addEvidence(business, "business", claim.claim_id, { stance: "supports", source_ref: url("a.no") })).rejects.toMatchObject({ reason: "claim_not_found" });
    const same = await service.registerClaim(business, "business", { claim_text: claim.claim_text });
    expect(same.created).toBe(true);
    expect(same.claim.claim_id).not.toBe(claim.claim_id);
    void id;
  });

  it("app-rollen ser ingenting uten rommet i RLS-konteksten, og kan ikke skrive evidens i et annet rom enn påstandens (space-bevisst FK)", async () => {
    const { claim } = await newClaim("rls");
    const wrongSpace = await withMemoryTransaction(appPool, TENANT_A, ["business"], async (client) => (await client.query("SELECT count(*)::int AS n FROM claim_verifications WHERE claim_id = $1", [claim.claim_id])).rows[0] as { n: number });
    expect(wrongSpace.n).toBe(0);
    await expect(
      withMemoryTransaction(appPool, TENANT_A, ["personal", "business"], (client) =>
        client.query(
          `INSERT INTO claim_evidence (evidence_id, tenant_id, memory_space_id, claim_id, stance, source_ref, independence_key, retrieved_at)
           VALUES ('ev-feil-rom', $1, 'business', $2, 'supports', 'x', 'origin:x', now())`,
          [TENANT_A, claim.claim_id]
        )
      )
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("claim_text og claim_id kan ikke bære injeksjon inn i SQL (parametrisert) - lookup med SQL-tegn gir bare «ikke funnet»", async () => {
    const id = identity();
    const report = await service.getClaimStatus(id, { claim_id: "x' OR '1'='1" });
    expect(report.found).toBe(false);
    const byText = await service.getClaimStatus(id, { claim: "'; DROP TABLE claim_verifications; --" });
    expect(byText.found).toBe(false);
    expect((await adminPool.query("SELECT to_regclass('claim_verifications') AS t")).rows[0]).toEqual({ t: "claim_verifications" });
  });
});

describe("F: små hjelpere", () => {
  it("normalizeClaimText / normalizeSourceRef: rens, grenser og kun trygge URL-er", () => {
    expect(normalizeClaimText("  a\u0000b   c ")).toBe("a b c");
    expect(() => normalizeClaimText("ab")).toThrow(ClaimError);
    expect(normalizeSourceRef("HTTPS://Www.Example.COM/Sti?x=1#frag")).toBe("https://www.example.com/Sti?x=1");
    expect(normalizeSourceRef("doi:10.1000/xyz")).toBe("doi:10.1000/xyz");
    expect(normalizeSourceRef("kd-123e4567-e89b-12d3-a456-426614174000")).toBe("kd-123e4567-e89b-12d3-a456-426614174000");
    for (const bad of ["file:///etc/passwd", "javascript://x", "gopher://x", "https://u:p@x.no", "", 7 as unknown as string]) {
      expect(() => normalizeSourceRef(bad), String(bad)).toThrow(ClaimError);
    }
    expect(claimHash("Oslo er hovedstaden.")).toBe(claimHash("  OSLO   er hovedstaden  "));
    expect(claimHash("Oslo er hovedstaden")).not.toBe(claimHash("Bergen er hovedstaden"));
  });
});

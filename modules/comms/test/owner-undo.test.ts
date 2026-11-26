import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { optOutHash, recipientHint, validateLiftReason } from "../src/index.ts";
import { TENANT_A, TENANT_B, OWNER } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1c K5 (JARVIS-112 f2, Q-72 pkt 10): eierens ANGRE av en feilregistrert STOP (`comms.lift_owner_opt_out`, klasse D). Kun `owner_recorded`-rader kan løftes - aldri `recipient_request`, aldri mottakerens eget stopp-ord eller en
 * leverandørfeil. Krever step-up (gatewayen SELV, `step_up_required`), obligatorisk begrunnelse, revisjonsspor (raden + ledger + audit + eier-varsel uten begrunnelsen) og idempotensnøkkel (G1b-mønsteret: nyttelast-avtrykk i den skopede
 * nøkkelen). Går gjennom databasetriggeren (141) - den ENESTE lovlige veien. Alt mot ekte Postgres og den ekte eier-kjeden. `record_opt_out` er fortsatt uten step-up (se `apps/api/test/wpg1-comms-routes.test.ts`).
 */
let chain: Chain;
const BASIS = { purpose_basis: "existing_customer_relationship" } as const;
const sendP = (recipient: string): Record<string, JsonValue> => ({ channel: "sms", account_ref: "+4791000000", recipient, purpose: "transactional", text: "Hei, timen din er bekreftet.", ...BASIS });
const hashOf = (num: string) => optOutHash(TENANT_A, "sms", num);
const REASON = "Feilregistrert: feil nummer lagt inn av meg";

type OptRow = { opt_out_id: string; status: string; source: string; lifted_by: string | null; lift_reason: string | null; lifted_by_person_id: string | null; lift_session_id: string | null; lifted_at: Date | null };
const rowsFor = async (num: string): Promise<OptRow[]> => (await chain.db.admin.query(
  "SELECT opt_out_id, status, source, lifted_by, lift_reason, lifted_by_person_id, lift_session_id, lifted_at FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2 ORDER BY created_at, opt_out_id", [TENANT_A, hashOf(num)]
)).rows as OptRow[];
const idOf = async (num: string, source: string): Promise<string> => (await rowsFor(num)).find((r) => r.source === source)!.opt_out_id;
async function seed(source: "inbound_stop_keyword" | "provider_error" | "owner_recorded" | "recipient_request"): Promise<{ num: string; id: string }> {
  const num = chain.phone();
  await chain.store.recordOptOut(TENANT_A, "business", { channel: "sms", recipient_hash: hashOf(num), recipient_hint: recipientHint("sms", num), source, recorded_by: OWNER });
  return { num, id: await idOf(num, source) };
}
const lift = (id: string, reason = REASON, key = chain.key("lift"), identity?: IdentityContext) => chain.act("lift_owner_opt_out", { opt_out_id: id, reason }, key, identity);
const blocked = async (num: string): Promise<boolean> => {
  const r = await chain.act("send", sendP(num), chain.key("u"));
  return !r.ok && r.status === "denied" && r.denial_codes.includes("recipient_opted_out");
};

beforeAll(async () => {
  chain = await startChain("g1c5", {}, { lenientToolLimits: true });
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("K5: eierens angre av en feilregistrert STOP - ende til ende", () => {
  it("record_opt_out (uten step-up) blokkerer sending; lift_owner_opt_out opphever; mottakeren kan nås igjen; raden bærer begrunnelse, hvem og sesjon; eieren varsles uten begrunnelsen", async () => {
    const num = chain.phone();
    const rec = await chain.act("record_opt_out", { channel: "sms", recipient: num });
    expect(rec.ok).toBe(true);
    expect(await blocked(num)).toBe(true);
    const id = await idOf(num, "owner_recorded");

    const notified = chain.notifications.length;
    const sent = chain.twilio.calls.filter((c) => c.op === "send").length;
    const r = await lift(id);
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, deduplicated: false, external_id: id, data: { opt_out_id: id, lifted: true, channel: "sms", still_opted_out: false } });

    const row = (await rowsFor(num))[0]!;
    expect(row).toMatchObject({ status: "lifted", source: "owner_recorded", lifted_by: "owner_undo", lift_reason: REASON, lifted_by_person_id: OWNER, lift_session_id: chain.owner.session_id });
    expect(row.lifted_at).toBeInstanceOf(Date);

    // klasse D: umiddelbart eier-varsel med kanal og maskert mottaker - men ALDRI begrunnelsen (fritekst) og aldri hele nummeret
    const n = chain.notifications.slice(notified);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ tool_id: "comms", action: "lift_owner_opt_out", outcome: "executed" });
    expect(JSON.stringify(n[0])).not.toContain(REASON);
    expect(JSON.stringify(n[0])).not.toContain(num);
    expect(String(n[0]!.summary)).toContain("eierens angre");

    // revisjonsspor: ledger og audit finnes, og bærer IKKE begrunnelsen (den ligger kun på raden)
    const ledger = await chain.db.admin.query("SELECT status FROM tool_executions WHERE tool_id = 'comms' AND action = 'lift_owner_opt_out' AND tenant_id = $1", [TENANT_A]);
    expect(ledger.rows.map((x: { status: string }) => x.status)).toContain("succeeded");
    expect(((await chain.db.admin.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND tool_id = 'comms' AND action = 'lift_owner_opt_out'", [TENANT_A])).rows[0] as { n: number }).n).toBeGreaterThan(0);
    for (const table of ["tool_executions", "audit_events"]) {
      expect(((await chain.db.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${table}::text LIKE $1`, [`%${REASON}%`])).rows[0] as { n: number }).n, `${table} skal ikke bære begrunnelsen`).toBe(0);
    }

    // mottakeren er nåbar igjen
    expect((await chain.act("send", sendP(num), chain.key("after"))).ok).toBe(true);
    expect(chain.twilio.calls.filter((c) => c.op === "send").length - sent).toBe(1);
    expect(sent).toBeGreaterThanOrEqual(0);

    // list_opt_outs viser hvem som opphevet og hvorfor (eier-lesing)
    const listed = await chain.act("list_opt_outs", { limit: 200 });
    const entry = (listed.ok ? (listed.data as unknown as Array<Record<string, unknown>>) : []).find((x) => x["opt_out_id"] === id);
    expect(entry).toMatchObject({ status: "lifted", source: "owner_recorded", lifted_by: "owner_undo", lift_reason: REASON });
  });

  it("angre er reversibelt for eieren: record_opt_out på nytt gir en NY eierregistrert rad som blokkerer igjen; den opphevede raden står igjen som historikk", async () => {
    const num = chain.phone();
    await chain.act("record_opt_out", { channel: "sms", recipient: num });
    await lift(await idOf(num, "owner_recorded"));
    expect(await blocked(num)).toBe(false);
    const again = await chain.act("record_opt_out", { channel: "sms", recipient: num });
    expect(again.ok && (again.data as { created: boolean }).created).toBe(true);
    expect(await blocked(num)).toBe(true);
    // to rader med samme (injiserte, faste) `created_at`: rekkefølgen er ikke definert, så sammenlign som mengde
    expect((await rowsFor(num)).map((r) => r.status).sort()).toEqual(["active", "lifted"]);
  });
});

describe("K5: kun eierens egne avmeldinger kan angres - aldri mottakerens", () => {
  for (const source of ["recipient_request", "inbound_stop_keyword", "provider_error"] as const) {
    it(`en ${source}-avmelding kan IKKE angres av eieren (preflight avviser, raden er uendret, mottakeren er fortsatt avmeldt)`, async () => {
      const { num, id } = await seed(source);
      const key = chain.key("nl");
      const r = await lift(id, REASON, key);
      // avvist av PREFLIGHT (før noe reserveres eller utføres): ingen ledger-rad for forsøket
      expect(r).toEqual({ ok: false, status: "failed", reason: `preflight_invalid:opt_out_not_liftable_by_owner:${source}` });
      expect(((await chain.db.admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE tool_id = 'comms' AND action = 'lift_owner_opt_out' AND idempotency_key LIKE $1", [`%${key}`])).rows[0] as { n: number }).n).toBe(0);
      const row = (await rowsFor(num))[0]!;
      expect(row).toMatchObject({ status: "active", lifted_by: null, lift_reason: null });
      expect(await blocked(num)).toBe(true);
    });
  }

  it("databasetriggeren stopper også en KODEFEIL: store.liftOwnerOptOut mot en ikke-eierregistrert rad kaster (app-sjekken) og SQL rett mot raden feiler (se stop-start-order.test.ts)", async () => {
    const { num, id } = await seed("recipient_request");
    await expect(chain.store.liftOwnerOptOut(TENANT_A, { opt_out_id: id, reason: REASON }, { person_id: OWNER, session_id: "sess-x" })).rejects.toThrow("comms_opt_out_not_liftable_by_owner:recipient_request");
    expect((await rowsFor(num))[0]!.status).toBe("active");
  });

  it("mottakerens START løfter aldri en eierregistrert rad, selv ETTER at eieren har registrert den (K1-regel, uendret)", async () => {
    const num = chain.phone();
    await chain.act("record_opt_out", { channel: "sms", recipient: num });
    expect(await chain.store.liftByStartKeyword(TENANT_A, { channel: "sms", recipient_hash: hashOf(num) })).toBe(0);
    expect(await blocked(num)).toBe(true);
  });

  it("eierens angre fjerner KUN den eierregistrerte raden: har mottakeren også et eget stopp-ord, er hen fortsatt avmeldt (`still_opted_out: true`)", async () => {
    const num = chain.phone();
    await chain.store.recordOptOut(TENANT_A, "business", { channel: "sms", recipient_hash: hashOf(num), recipient_hint: recipientHint("sms", num), source: "inbound_stop_keyword", recorded_by: "system" });
    await chain.act("record_opt_out", { channel: "sms", recipient: num });
    const r = await lift(await idOf(num, "owner_recorded"));
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, data: { lifted: true, still_opted_out: true } });
    expect(await blocked(num)).toBe(true);
    expect((await rowsFor(num)).map((x) => `${x.source}:${x.status}`).sort()).toEqual(["inbound_stop_keyword:active", "owner_recorded:lifted"]);
  });

  it("tenant-isolasjon: en avmelding i en ANNEN tenant kan ikke angres (finnes ikke for eierens tenant)", async () => {
    const id = "optout-other-tenant-0001";
    await chain.db.admin.query("INSERT INTO comms_recipient_opt_outs (tenant_id, opt_out_id, memory_space_id, channel, account_ref, recipient_hash, recipient_hint, source, recorded_by) VALUES ($1, $2, 'business', 'sms', '*owner', $3, 'x', 'owner_recorded', 'x')", [TENANT_B, id, "f".repeat(64)]);
    const r = await lift(id);
    expect(r.ok).toBe(false);
    expect(((await chain.db.admin.query("SELECT status FROM comms_recipient_opt_outs WHERE opt_out_id = $1", [id])).rows[0] as { status: string }).status).toBe("active");
  });
});

describe("K5: obligatorisk begrunnelse", () => {
  it("validateLiftReason: 3-200 tegn, én linje, uten kontrolltegn og hemmeligheter; trimmes", () => {
    expect(validateLiftReason("  ok grunn  ")).toBe("ok grunn");
    for (const bad of [undefined, null, 42, "", "  ", "ab", "x".repeat(201), "to\nlinjer", "med\ttab", "kontroll\u0007tegn", "usynlig​tegn"]) expect(validateLiftReason(bad), String(bad)).toBeNull();
    expect(validateLiftReason("x".repeat(200))).toBe("x".repeat(200));
  });

  it("uten, for kort, flerlinjet eller hemmelighetsholdig begrunnelse: ingenting skjer (ingen løfting, ingen ledger-rad som utførte noe)", async () => {
    const { num, id } = await seed("owner_recorded");
    const missing = await chain.act("lift_owner_opt_out", { opt_out_id: id }, chain.key("m"));
    expect(missing.ok).toBe(false);
    for (const reason of ["", "ab", "to\nlinjer", "Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"]) {
      const r = await lift(id, reason);
      expect(r.ok, JSON.stringify(reason)).toBe(false);
      expect(JSON.stringify(r), JSON.stringify(reason)).toMatch(/invalid/);
    }
    expect(await lift(id, "to\nlinjer")).toEqual({ ok: false, status: "failed", reason: "preflight_failed:comms_invalid_parameters:lift_reason_invalid" });
    expect((await rowsFor(num))[0]!).toMatchObject({ status: "active", lift_reason: null });
    expect(await blocked(num)).toBe(true);
  });
});

describe("K5: step-up (håndhevet av gatewayen selv; kanalen er klient-påstått inntil WP-S1/JARVIS-111)", () => {
  it("en svak økt (ikke enhetssignert) eller en ikke-eier-kanal (Telegram, tale) kan ikke angre - ingenting skjer", async () => {
    const { num, id } = await seed("owner_recorded");
    for (const weak of [{ ...chain.owner, auth_strength: "active" as const }, { ...chain.owner, auth_strength: "passive" as const }, { ...chain.owner, channel: "telegram" as const }, { ...chain.owner, channel: "voice" as const }]) {
      const r = await lift(id, REASON, chain.key("su"), weak as IdentityContext);
      expect(r.ok, JSON.stringify(weak)).toBe(false);
      expect(JSON.stringify(r)).toContain("step_up_required");
    }
    expect((await rowsFor(num))[0]!.status).toBe("active");
    // kontroll: en enhetssignert eier-kanal-økt går gjennom
    expect((await lift(id)).ok).toBe(true);
  });

  it("en ikke-eier (delegat/annen person) avvises FØR noe annet (eier-porten)", async () => {
    const { num, id } = await seed("owner_recorded");
    const r = await lift(id, REASON, chain.key("g"), { ...chain.owner, person_id: "person-g1-guest" });
    expect(r).toEqual({ ok: false, status: "rejected", reason: "owner_required" });
    expect((await rowsFor(num))[0]!.status).toBe("active");
  });
});

describe("K5: idempotens (G1b-mønsteret) og nøkkelkrav", () => {
  it("nøkkel er påkrevd (klasse D); samme nøkkel + samme nyttelast er en gjenspilling uten ny løfting; samme nøkkel + ULIK nyttelast er en uavhengig forespørsel som utføres", async () => {
    const a = await seed("owner_recorded");
    const b = await seed("owner_recorded");
    const noKey = await chain.act("lift_owner_opt_out", { opt_out_id: a.id, reason: REASON });
    expect(noKey).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_required" });
    const key = chain.key("idem");
    const first = await lift(a.id, REASON, key);
    expect(first.ok && first.deduplicated).toBe(false);
    const replay = await lift(a.id, REASON, key);
    // en gjenspilling etter vellykket løfting gir enten `deduplicated` eller (som meeting_delete/contacts_delete) en preflight-avvisning fordi målet allerede er borte - aldri en ny løfting
    expect(replay.ok ? replay.deduplicated : JSON.stringify(replay)).toSatisfy((x: unknown) => x === true || (typeof x === "string" && x.includes("preflight_target_not_found")));
    const other = await lift(b.id, REASON, key); // samme nøkkel, ANNEN nyttelast (annen avmelding)
    expect(other, JSON.stringify(other)).toMatchObject({ ok: true, deduplicated: false, data: { lifted: true } });
    expect((await rowsFor(a.num))[0]!.status).toBe("lifted");
    expect((await rowsFor(b.num))[0]!.status).toBe("lifted");
  });

  it("en allerede opphevet avmelding kan ikke angres på nytt (målet er borte), og noe annet enn opphevingen endres ikke", async () => {
    const { num, id } = await seed("owner_recorded");
    expect((await lift(id)).ok).toBe(true);
    const again = await lift(id, "en annen begrunnelse", chain.key("again"));
    expect(again.ok).toBe(false);
    expect((await rowsFor(num))[0]).toMatchObject({ status: "lifted", lift_reason: REASON });
  });
});

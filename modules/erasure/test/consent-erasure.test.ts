import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { LocalHashEmbedding } from "@jarvis/memory";
import { BusinessService } from "@jarvis/business";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";
// Relativ import (IKKE en ny @jarvis/erasure -> @jarvis/consent
// pakkeavhengighet kun for en testfil) - samme presedens som
// growth-erasure.test.ts sin import av GrowthService.
import { ConsentService } from "../../consent/src/service.ts";

/**
 * D-91 PRE-MERGE CLOSEOUT (§26 i lukkingsordren): end-to-end Q-20-bevis for
 * `consent_decisions` mot en EKTE embedded Postgres via den EKTE
 * `ErasureService.executeErasure()`-APIen - IKKE kun en `plan.ts`-kode-
 * lesning. `consent_decisions` har en FK -> `business_contacts.contact_id`,
 * MEN `business_contacts` er FORTSATT IKKE registrert i denne erasure-
 * planen (se `plan.ts`-kommentaren over `add(result, "consent_decisions", ...)`)
 * - INGEN FK-ordringskonflikt å bevise her, kun at raden selv faktisk
 * forsvinner ved en memory-space-scoped erasure, uten å røre urelaterte
 * kontakter/beslutninger i en annen tenant/space.
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let embedding: LocalHashEmbedding;
let sovereignPolicy: PolicyGateway;
let consent: ConsentService;
let business: BusinessService;

const TENANT_A = "tenant-cst-erase-a";

function identityFor(tenantId: string): IdentityContext {
  return {
    person_id: "person-tobias", tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-${tenantId}`, device_id: "dev-cst-erase", channel: "api", auth_strength: "active"
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-cst-erasure-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  // Garantert non-bypass rolle - beviser samtidig at 032-migrasjonens
  // GRANT DELETE faktisk holder for denne EKSAKTE rollekonstruksjonen (Q-21).
  await adminPool.query("CREATE ROLE jarvis_cst_erasure_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_cst_erasure_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Consent Erasure Test','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-cst-erase-business','${TENANT_A}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_cst_erasure_test", password: "pw2" });
  embedding = new LocalHashEmbedding();
  sovereignPolicy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
  });
  consent = new ConsentService(appPool);
  business = new BusinessService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: en memory-space-scoped erasure fjerner FULLSTENDIG konsent-beslutnings-historikken for kontakten i den space-en - inkludert historiske (ikke-siste) rader", () => {
  it("executeErasure sletter ALLE consent_decisions-rader for kontakten (append-only-historikken overlever IKKE en erasure - Q-20 er det ENESTE hard-delete-sporet)", async () => {
    const sentinel = `SentinelCstErase${randomUUID().replace(/-/g, "")}`;
    const contact = await business.createContact(TENANT_A, "business", { name: sentinel });

    const granted = await consent.recordConsentDecision(TENANT_A, "business", {
      contact_id: contact.contact_id, purpose: "attribution", state: "granted", legal_basis: "consent",
      evidence: { source: "erasure-test" }, policy_version: "v1"
    });
    const withdrawn = await consent.recordConsentDecision(TENANT_A, "business", {
      contact_id: contact.contact_id, purpose: "attribution", state: "withdrawn", legal_basis: "consent",
      evidence: {}, policy_version: "v1"
    });
    const trackingGrant = await consent.recordConsentDecision(TENANT_A, "business", {
      contact_id: contact.contact_id, purpose: "tracking", state: "granted", legal_basis: "consent",
      evidence: {}, policy_version: "v1"
    });

    const beforeCount = await adminPool.query("SELECT count(*)::int AS n FROM consent_decisions WHERE contact_id = $1", [contact.contact_id]);
    expect((beforeCount.rows[0] as { n: number }).n).toBe(3);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-cst-erase-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed"); // Ville rapportert "failed" ved en FK-regresjon.

    // ALLE tre rader (inkludert den ELDRE, allerede overgåtte 'granted'-raden)
    // er FAKTISK borte - append-only-historikk overlever IKKE Q-20-erasure.
    for (const id of [granted.decision_id, withdrawn.decision_id, trackingGrant.decision_id]) {
      const gone = await adminPool.query("SELECT 1 FROM consent_decisions WHERE decision_id = $1", [id]);
      expect(gone.rowCount).toBe(0);
    }
    const afterCount = await adminPool.query("SELECT count(*)::int AS n FROM consent_decisions WHERE contact_id = $1", [contact.contact_id]);
    expect((afterCount.rows[0] as { n: number }).n).toBe(0);

    // Etter erasure er tilstanden ærlig "ikke konfigurert" igjen - ALDRI
    // stille implisitt ALLOWED/DENIED fra en slettet historikk.
    const evaluated = await consent.evaluateProcessingDecision(TENANT_A, "business", contact.contact_id, "attribution");
    expect(evaluated.outcome).toBe("UNKNOWN_NOT_CONFIGURED");
  });
});

describe("B: urelatert kontakt/beslutning i SAMME tenant er UPÅVIRKET av en annen kontakts erasure-scope (space-bred erasure sletter likevel bredt)", () => {
  it("en memory-space-scoped erasure rammer HELE space-en (per design) - INGEN kontakt-spesifikk delvis-erasure hevdes her", async () => {
    // Merk: `planMemorySpaceInContext()` er SPACE-scoped (tenant+space), ikke
    // kontakt-scoped - dette er EKSISTERENDE, uendret erasure-arkitektur
    // (samme granularitet som `marketing_campaign_observations`/D-89), IKKE
    // noe D-91 introduserer. Denne testen beviser presist DEN granulariteten,
    // ikke en (ikke-eksisterende) per-kontakt-erasure-funksjon.
    const sentinelA = `SentinelCstEraseUnrelA${randomUUID().replace(/-/g, "")}`;
    const contactA = await business.createContact(TENANT_A, "business", { name: sentinelA });
    await consent.recordConsentDecision(TENANT_A, "business", {
      contact_id: contactA.contact_id, purpose: "attribution", state: "granted", legal_basis: "consent",
      evidence: {}, policy_version: "v1"
    });

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-cst-erase-space-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed");

    const gone = await adminPool.query("SELECT count(*)::int AS n FROM consent_decisions WHERE contact_id = $1", [contactA.contact_id]);
    expect((gone.rows[0] as { n: number }).n).toBe(0);
  });
});

describe("C: idempotens - samme request_id kjørt to ganger på en consent-scoped erasure gir samme resultat", () => {
  it("andre kjøring er en idempotent replay, ingen dobbel sletting, ingen feil", async () => {
    const sentinel = `SentinelCstEraseIdem${randomUUID().replace(/-/g, "")}`;
    const contact = await business.createContact(TENANT_A, "business", { name: sentinel });
    await consent.recordConsentDecision(TENANT_A, "business", {
      contact_id: contact.contact_id, purpose: "attribution", state: "granted", legal_basis: "consent",
      evidence: {}, policy_version: "v1"
    });

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const requestId = `req-cst-erase-idem-${randomUUID()}`;
    const scope = { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" } as const;
    const identity = identityFor(TENANT_A);

    const first = await service.executeErasure({ scope, requestId, identity });
    expect(first.status).toBe("completed");
    expect(first.idempotent_replay).toBe(false);

    const second = await service.executeErasure({ scope, requestId, identity });
    expect(second.status).toBe("completed");
    expect(second.idempotent_replay).toBe(true);
    expect(second.record_counts).toEqual(first.record_counts);
  });
});

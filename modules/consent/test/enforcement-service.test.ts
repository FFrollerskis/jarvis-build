import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { ConsentEnforcementService } from "../src/enforcement-service.ts";
import { ConsentService } from "../src/service.ts";
import type { EnforcementSubject } from "../src/types.ts";

/**
 * D-92 (UA-4 NESTE SLICE): ekte Postgres/RLS-integrasjonsbevis for
 * `ConsentEnforcementService` - rollout-modus-lagring, fail-closed
 * håndheving, purpose-/tenant-/space-isolasjon, observasjonslogg,
 * mot en EKTE NOSUPERUSER/NOBYPASSRLS-rolle (SAMME mønster som D-91 sin
 * service-rls.test.ts).
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let consent: ConsentService;
let enforcement: ConsentEnforcementService;

const TENANT_A = "tenant-cst-enf-a";
const TENANT_B = "tenant-cst-enf-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-consent-enf-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_cst_enf_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_cst_enf_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Consent Enf A', 'business'), ('${TENANT_B}', 'Consent Enf B', 'business')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-cst-enf-owner', 'Owner One')`);
  await adminPool.query(
    `INSERT INTO business_contacts (contact_id, tenant_id, name, email) VALUES
       ('ct-cst-enf-a1', '${TENANT_A}', 'Kari A', 'kari@a.example'),
       ('ct-cst-enf-a2', '${TENANT_A}', 'Ola A', 'ola@a.example'),
       ('ct-cst-enf-b1', '${TENANT_B}', 'Kari B', 'kari@b.example')`
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_cst_enf_test", password: "pw2" });
  consent = new ConsentService(appPool);
  enforcement = new ConsentEnforcementService(appPool, consent);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

/** Hjelper: kjør enforcement.enforce() inne i en EKTE withMemoryTransaction, akkurat som GrowthService gjør. */
async function enforceInTx(tenantId: string, memorySpace: "business", contactId: string | null, purpose: "attribution" | "tracking", operation: string) {
  const subject: EnforcementSubject = contactId === null ? { kind: "no_data_subject" } : { kind: "resolved", contact_id: contactId };
  return withMemoryTransaction(appPool, tenantId, [memorySpace], (client) => enforcement.enforce(client, tenantId, memorySpace, subject, purpose, operation));
}

/** D-92 CLOSEOUT (PR #32 pre-merge audit): egen hjelper for `unresolved`-tilstanden - IKKE det samme som `contactId === null` (se `EnforcementSubject`-JSDoc). */
async function enforceUnresolvedInTx(tenantId: string, memorySpace: "business", purpose: "attribution" | "tracking", operation: string) {
  const subject: EnforcementSubject = { kind: "unresolved" };
  return withMemoryTransaction(appPool, tenantId, [memorySpace], (client) => enforcement.enforce(client, tenantId, memorySpace, subject, purpose, operation));
}

describe("A: default (ingen rad) => 'disabled', ALDRI stille 'enforce' (§10 i byggeordren)", () => {
  it("getEnforcementMode returnerer 'disabled' for et tenant/space/formål uten NOEN konfigurert policy", async () => {
    const mode = await enforcement.getEnforcementMode(TENANT_A, "business", "attribution");
    expect(mode).toBe("disabled");
  });

  it("enforce() i 'disabled'-modus gjør INGEN evaluering (processing_decision === null) og fortsetter alltid", async () => {
    const result = await enforceInTx(TENANT_A, "business", "ct-cst-enf-a1", "attribution", "test.op");
    expect(result.enforcement_mode).toBe("disabled");
    expect(result.enforcement_result).toBe("proceed");
    expect(result.processing_decision).toBeNull();
  });
});

describe("B: eksplisitt eier-aktivering er purpose-spesifikk (§19 i byggeordren)", () => {
  it("setEnforcementMode for 'attribution' aktiverer ALDRI 'tracking' implisitt for SAMME tenant/space", async () => {
    await enforcement.setEnforcementMode(TENANT_A, "business", { purpose: "attribution", mode: "enforce" });
    const attributionMode = await enforcement.getEnforcementMode(TENANT_A, "business", "attribution");
    const trackingMode = await enforcement.getEnforcementMode(TENANT_A, "business", "tracking");
    expect(attributionMode).toBe("enforce");
    expect(trackingMode).toBe("disabled");
  });

  it("setEnforcementMode er idempotent-upsert - andre kall for SAMME nøkkel oppdaterer, oppretter ALDRI en ny rad", async () => {
    await enforcement.setEnforcementMode(TENANT_A, "business", { purpose: "tracking", mode: "audit" });
    await enforcement.setEnforcementMode(TENANT_A, "business", { purpose: "tracking", mode: "enforce" });
    const policy = await enforcement.getEnforcementPolicy(TENANT_A, "business", "tracking");
    expect(policy?.mode).toBe("enforce");
    const { rows } = await adminPool.query(
      "SELECT count(*)::int AS n FROM consent_enforcement_policies WHERE tenant_id = $1 AND purpose = 'tracking'", [TENANT_A]
    );
    expect((rows[0] as { n: number }).n).toBe(1);
    // Rydd opp igjen til 'disabled' for resten av testene i denne filen.
    await enforcement.setEnforcementMode(TENANT_A, "business", { purpose: "tracking", mode: "disabled" });
  });
});

describe("C: 'enforce'-modus - ALLOWED fortsetter, DENIED/UNKNOWN blokkerer (§13/§22-24 i byggeordren)", () => {
  it("ALLOWED (aktivt samtykke) => enforcement_result='proceed'", async () => {
    await consent.recordConsentDecision(TENANT_A, "business", {
      contact_id: "ct-cst-enf-a1", purpose: "attribution", state: "granted", legal_basis: "consent",
      evidence: {}, policy_version: "v1"
    });
    const result = await enforceInTx(TENANT_A, "business", "ct-cst-enf-a1", "attribution", "test.allowed");
    expect(result.enforcement_mode).toBe("enforce");
    expect(result.enforcement_result).toBe("proceed");
    expect(result.processing_decision?.outcome).toBe("ALLOWED");
  });

  it("DENIED (eksplisitt nektet) => enforcement_result='blocked'", async () => {
    await consent.recordConsentDecision(TENANT_A, "business", {
      contact_id: "ct-cst-enf-a2", purpose: "attribution", state: "denied", legal_basis: "consent",
      evidence: {}, policy_version: "v1"
    });
    const result = await enforceInTx(TENANT_A, "business", "ct-cst-enf-a2", "attribution", "test.denied");
    expect(result.enforcement_result).toBe("blocked");
    expect(result.processing_decision?.outcome).toBe("DENIED");
  });

  it("UNKNOWN_NOT_CONFIGURED (ingen beslutning registrert) => enforcement_result='blocked' - fail-closed, ALDRI en gjettet ALLOWED", async () => {
    await adminPool.query(
      `INSERT INTO business_contacts (contact_id, tenant_id, name, email) VALUES ('ct-cst-enf-a3', '${TENANT_A}', 'Ny A', 'ny@a.example')`
    );
    const result = await enforceInTx(TENANT_A, "business", "ct-cst-enf-a3", "attribution", "test.unknown");
    expect(result.enforcement_result).toBe("blocked");
    expect(result.processing_decision?.outcome).toBe("UNKNOWN_NOT_CONFIGURED");
  });

  it("tilbaketrekking ETTER tidligere 'granted' => enforcement_result='blocked' for NESTE håndhevingsforsøk (withdrawal-lifecycle, §40 i byggeordren)", async () => {
    const contactId = "ct-cst-enf-a1"; // allerede 'granted' fra tidligere test i denne filen
    const before = await enforceInTx(TENANT_A, "business", contactId, "attribution", "test.withdraw.before");
    expect(before.enforcement_result).toBe("proceed");

    await consent.recordConsentDecision(TENANT_A, "business", {
      contact_id: contactId, purpose: "attribution", state: "withdrawn", legal_basis: "consent",
      evidence: {}, policy_version: "v1"
    });
    const after = await enforceInTx(TENANT_A, "business", contactId, "attribution", "test.withdraw.after");
    expect(after.enforcement_result).toBe("blocked");
    expect(after.processing_decision?.outcome).toBe("DENIED");
  });
});

describe("D: 'audit'-modus - evaluerer og logger, MEN blokkerer ALDRI (§14 i byggeordren)", () => {
  it("DENIED i audit-modus gir FORTSATT enforcement_result='proceed' - kun observasjon", async () => {
    await enforcement.setEnforcementMode(TENANT_A, "business", { purpose: "tracking", mode: "audit" });
    await consent.recordConsentDecision(TENANT_A, "business", {
      contact_id: "ct-cst-enf-a2", purpose: "tracking", state: "denied", legal_basis: "consent",
      evidence: {}, policy_version: "v1"
    });
    const result = await enforceInTx(TENANT_A, "business", "ct-cst-enf-a2", "tracking", "test.audit.denied");
    expect(result.enforcement_mode).toBe("audit");
    expect(result.enforcement_result).toBe("proceed");
    expect(result.processing_decision?.outcome).toBe("DENIED");
    await enforcement.setEnforcementMode(TENANT_A, "business", { purpose: "tracking", mode: "disabled" });
  });
});

describe("E: ingen lenket kontakt (contact_id === null) => proceed, ALDRI en spørring mot consent_decisions (§10 i attributeToCampaign-JSDoc)", () => {
  it("enforce() med contactId=null returnerer proceed med en EGEN, eksplisitt forklart reason - ikke forvekslet med disabled/ALLOWED", async () => {
    const result = await enforceInTx(TENANT_A, "business", null, "attribution", "test.no_contact");
    expect(result.enforcement_result).toBe("proceed");
    expect(result.processing_decision).toBeNull();
    expect(result.reason).toMatch(/no_linked_contact/);
  });
});

describe("E2: subject.kind === 'unresolved' - ALDRI det samme som 'no_data_subject' (D-92 CLOSEOUT, PR #32 pre-merge audit §8)", () => {
  it("i 'enforce'-modus blokkerer 'unresolved' FAIL-CLOSED - kan IKKE bevise at det ikke finnes et datasubjekt", async () => {
    await enforcement.setEnforcementMode(TENANT_A, "business", { purpose: "attribution", mode: "enforce" });
    const result = await enforceUnresolvedInTx(TENANT_A, "business", "attribution", "test.unresolved.enforce");
    expect(result.enforcement_result).toBe("blocked");
    expect(result.processing_decision).toBeNull();
    expect(result.reason).toMatch(/unresolved/);
  });

  it("i 'audit'-modus blokkerer 'unresolved' ALDRI (audit blokkerer aldri), men logger INGEN hendelse (ingen gyldig contact_id å skrive mot)", async () => {
    await enforcement.setEnforcementMode(TENANT_A, "business", { purpose: "tracking", mode: "audit" });
    const before = await enforcement.listEnforcementEvents(TENANT_A, "business", {});
    const result = await enforceUnresolvedInTx(TENANT_A, "business", "tracking", "test.unresolved.audit");
    expect(result.enforcement_result).toBe("proceed");
    expect(result.processing_decision).toBeNull();
    const after = await enforcement.listEnforcementEvents(TENANT_A, "business", {});
    expect(after.length).toBe(before.length);
    await enforcement.setEnforcementMode(TENANT_A, "business", { purpose: "tracking", mode: "disabled" });
    await enforcement.setEnforcementMode(TENANT_A, "business", { purpose: "attribution", mode: "disabled" });
  });
});

describe("F: observasjonslogg - kun skrevet for audit/enforce, ALDRI for disabled (§35 i byggeordren)", () => {
  it("listEnforcementEvents inneholder rader for de audit/enforce-håndhevingene som allerede kjørte i denne filen, men INGEN for disabled-modus-testene", async () => {
    const events = await enforcement.listEnforcementEvents(TENANT_A, "business", {});
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.enforcement_mode === "audit" || e.enforcement_mode === "enforce")).toBe(true);
  });

  it("hver rad har fullstendig forklarbarhet - operation/enforcement_mode/processing_outcome/enforcement_result/decision_id/policy_version (§17/§35 i byggeordren)", async () => {
    const events = await enforcement.listEnforcementEvents(TENANT_A, "business", { contact_id: "ct-cst-enf-a2", purpose: "attribution" });
    expect(events.length).toBeGreaterThan(0);
    const event = events[0]!;
    expect(event.operation).toBe("test.denied");
    expect(event.processing_outcome).toBe("DENIED");
    expect(event.enforcement_result).toBe("blocked");
    expect(event.decision_id).not.toBeNull();
    expect(event.policy_version).toBe("v1");
  });
});

describe("G: append-only observasjonslogg - STRUKTURELT umulig å UPDATE-re (§35, samme mønster som D-91 test §H)", () => {
  it("jarvis_app-rollen har INGEN UPDATE-grant på consent_enforcement_events", async () => {
    const events = await enforcement.listEnforcementEvents(TENANT_A, "business", { contact_id: "ct-cst-enf-a2" });
    const anyEvent = events[0]!;
    await expect(
      appPool.query(`UPDATE consent_enforcement_events SET enforcement_result = 'proceed' WHERE event_id = $1`, [anyEvent.event_id])
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("H: tenant-/space-isolasjon (RLS) for BEGGE nye tabeller", () => {
  it("TENANT_B ser ALDRI TENANT_A sin enforcement-policy eller -events", async () => {
    await enforcement.setEnforcementMode(TENANT_A, "business", { purpose: "attribution", mode: "enforce" });
    const policyFromB = await enforcement.getEnforcementPolicy(TENANT_B, "business", "attribution");
    expect(policyFromB).toBeNull(); // TENANT_A sin rad er usynlig - TENANT_B har rett og slett ingen egen rad heller.

    const eventsFromB = await enforcement.listEnforcementEvents(TENANT_B, "business", {});
    expect(eventsFromB).toHaveLength(0);
  });

  it("en policy satt i 'business'-space er usynlig fra 'personal'-space for SAMME tenant", async () => {
    const fromPersonal = await enforcement.getEnforcementPolicy(TENANT_A, "personal", "attribution");
    expect(fromPersonal).toBeNull();
  });
});

describe("I: deterministisk hendelse-rekkefølge (§18/D-91-tie-break-lærdom gjenbrukt for D-92)", () => {
  it("listEnforcementEvents er ordnet nyeste-først, seq-tie-break inkludert i spørringen", async () => {
    const events = await enforcement.listEnforcementEvents(TENANT_A, "business", { contact_id: "ct-cst-enf-a3" });
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i - 1]!.recorded_at).getTime()).toBeGreaterThanOrEqual(new Date(events[i]!.recorded_at).getTime());
    }
  });
});

describe("J: hendelse-loggens 'forsøk'-semantikk - INGEN dedup-nøkkel (D-92 CLOSEOUT, PR #32 pre-merge audit §22)", () => {
  it("to GENUINT separate enforce()-kall med IDENTISKE parametre (kontakt/formål/operasjon) gir TO separate rader - ALDRI stille kollapset til én (append-only-loggen skal ALDRI miste meningsfull revisjonshistorikk, jf. byggeordrens 'ikke oppnå no-spam ved å miste historikk')", async () => {
    await enforcement.setEnforcementMode(TENANT_A, "business", { purpose: "attribution", mode: "enforce" });
    const before = await enforcement.listEnforcementEvents(TENANT_A, "business", { contact_id: "ct-cst-enf-a2", purpose: "attribution" });
    await enforceInTx(TENANT_A, "business", "ct-cst-enf-a2", "attribution", "test.repeated_attempt");
    await enforceInTx(TENANT_A, "business", "ct-cst-enf-a2", "attribution", "test.repeated_attempt");
    const after = await enforcement.listEnforcementEvents(TENANT_A, "business", { contact_id: "ct-cst-enf-a2", purpose: "attribution" });
    // MERK (ærlighets-presisering, ikke overstat): dette beviser at arkitekturen ALDRI kollapser/dedupliserer -
    // hvert `enforce()`-kall er en EGEN, permanent hendelse (event_id = tilfeldig UUID, ingen ON CONFLICT).
    // Dette betyr OGSÅ at en EKTE HTTP-nivå-retry av samme logiske operasjon (f.eks. en klient som prøver på
    // nytt etter timeout) SKAPER en ny rad hver gang - IKKE "no duplicate event spam" slik et tidligere
    // sluttrapport-utsagn upresist hevdet uten test-bevis. Dette er en BEVISST design ("forsøk"-logg, ikke
    // "tilstand"-logg), IKKE en defekt - nedstrøms konsumenter som ønsker per-logisk-operasjon-dedup kan
    // gruppere klient-side på (contact_id, purpose, operation, decision_id).
    expect(after.length).toBe(before.length + 2);
    await enforcement.setEnforcementMode(TENANT_A, "business", { purpose: "attribution", mode: "disabled" });
  });
});

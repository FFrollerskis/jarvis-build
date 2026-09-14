import { mkdtemp } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { ConsentService } from "../src/service.ts";

/**
 * D-91 (UA-4 NESTE SLICE): ekte Postgres/RLS-integrasjonsbevis for
 * `ConsentService` - append-only-loggen, fail-closed evaluering,
 * tenant-/space-isolasjon, mot en EKTE NOSUPERUSER/NOBYPASSRLS-rolle
 * (SAMME mønster som agreements/growth/support sine service-rls.test.ts-
 * filer, IKKE en `fakePool()`-mock).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: ConsentService;

const TENANT_A = "tenant-cst-svc-a";
const TENANT_B = "tenant-cst-svc-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-consent-svc-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_cst_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_cst_svc_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Consent Svc A', 'business'), ('${TENANT_B}', 'Consent Svc B', 'business')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-cst-owner', 'Owner One')`);
  await adminPool.query(
    `INSERT INTO business_contacts (contact_id, tenant_id, name, email) VALUES
       ('ct-cst-a1', '${TENANT_A}', 'Kari A', 'kari@a.example'),
       ('ct-cst-a2', '${TENANT_A}', 'Ola A', 'ola@a.example'),
       ('ct-cst-b1', '${TENANT_B}', 'Kari B', 'kari@b.example')`
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_cst_svc_test", password: "pw2" });
  service = new ConsentService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: ingen registrert beslutning => UNKNOWN_NOT_CONFIGURED, ALDRI implisitt ALLOWED (fail-closed)", () => {
  it("evaluateProcessingDecision for en kontakt/formål uten NOEN registrert beslutning returnerer UNKNOWN_NOT_CONFIGURED", async () => {
    const result = await service.evaluateProcessingDecision(TENANT_A, "business", "ct-cst-a1", "attribution");
    expect(result.outcome).toBe("UNKNOWN_NOT_CONFIGURED");
    expect(result.provenance).toBeNull();
    expect(result.policy_version).toBeNull();
    expect(result.reason).not.toBe("");
  });

  it("getCurrentConsentState returnerer null (ærlig 'ikke konfigurert', aldri gjettet)", async () => {
    const state = await service.getCurrentConsentState(TENANT_A, "business", "ct-cst-a1", "tracking");
    expect(state).toBeNull();
  });
});

describe("B: 'granted' beslutning => ALLOWED, med full proveniens", () => {
  it("recordConsentDecision('granted') gjør evaluateProcessingDecision() ALLOWED, med provenance = decision_id", async () => {
    const decision = await service.recordConsentDecision(TENANT_A, "business", {
      contact_id: "ct-cst-a1", purpose: "attribution", state: "granted", legal_basis: "consent",
      evidence: { source: "signup_form", form_version: "v3" }, policy_version: "2026-08-01"
    });
    expect(decision.decision_id).toMatch(/^cst-dec-/);
    expect(decision.state).toBe("granted");

    const result = await service.evaluateProcessingDecision(TENANT_A, "business", "ct-cst-a1", "attribution");
    expect(result.outcome).toBe("ALLOWED");
    expect(result.provenance).toBe(decision.decision_id);
    expect(result.policy_version).toBe("2026-08-01");
  });

  it("evidence inneholder KUN det som ble registrert - ingen skjult berikelse/inferens", async () => {
    const decision = await service.recordConsentDecision(TENANT_A, "business", {
      contact_id: "ct-cst-a2", purpose: "tracking", state: "granted", legal_basis: "consent",
      evidence: { source: "cookie_banner_v2", channel: "web" }, policy_version: "2026-08-01"
    });
    expect(decision.evidence).toEqual({ source: "cookie_banner_v2", channel: "web" });
  });
});

describe("C: 'denied'/'withdrawn' beslutning => DENIED, ALDRI ALLOWED", () => {
  it("'denied' gir DENIED", async () => {
    await service.recordConsentDecision(TENANT_A, "business", {
      contact_id: "ct-cst-a1", purpose: "tracking", state: "denied", legal_basis: "consent",
      evidence: {}, policy_version: "2026-08-01"
    });
    const result = await service.evaluateProcessingDecision(TENANT_A, "business", "ct-cst-a1", "tracking");
    expect(result.outcome).toBe("DENIED");
  });

  it("'granted' etterfulgt av 'withdrawn' gir DENIED - IKKE en sletting av den forrige raden (append-only, historikken bevart)", async () => {
    const contactId = "ct-cst-a2";
    const granted = await service.recordConsentDecision(TENANT_A, "business", {
      contact_id: contactId, purpose: "attribution", state: "granted", legal_basis: "consent",
      evidence: {}, policy_version: "2026-08-01"
    });
    const withdrawn = await service.recordConsentDecision(TENANT_A, "business", {
      contact_id: contactId, purpose: "attribution", state: "withdrawn", legal_basis: "consent",
      evidence: { reason: "kontakt ba om å trekke samtykke" }, policy_version: "2026-08-01"
    });
    expect(withdrawn.decision_id).not.toBe(granted.decision_id); // NY rad, ALDRI en overskriving.

    const result = await service.evaluateProcessingDecision(TENANT_A, "business", contactId, "attribution");
    expect(result.outcome).toBe("DENIED");
    expect(result.provenance).toBe(withdrawn.decision_id); // nyeste rad avgjør - IKKE den eldre 'granted'.

    const history = await service.listConsentDecisions(TENANT_A, "business", { contact_id: contactId, purpose: "attribution" });
    expect(history.map((d) => d.decision_id)).toEqual(expect.arrayContaining([granted.decision_id, withdrawn.decision_id]));
    expect(history).toHaveLength(2); // BEGGE rader eksisterer fortsatt - append-only, ALDRI slettet/overskrevet.
  });
});

describe("D: utløpt 'granted' => DENIED, ALDRI ALLOWED", () => {
  it("expires_at i fortiden gjør en ellers 'granted' beslutning DENIED", async () => {
    const contactId = "ct-cst-a1";
    await service.recordConsentDecision(TENANT_A, "business", {
      contact_id: contactId, purpose: "tracking", state: "granted", legal_basis: "consent",
      evidence: {}, policy_version: "2026-08-01", expires_at: "2020-01-01T00:00:00Z"
    });
    const result = await service.evaluateProcessingDecision(TENANT_A, "business", contactId, "tracking");
    expect(result.outcome).toBe("DENIED");
    expect(result.reason).toMatch(/utløpt/);
  });

  it("expires_at i fremtiden forblir ALLOWED", async () => {
    const contactId = "ct-cst-a2";
    await service.recordConsentDecision(TENANT_A, "business", {
      contact_id: contactId, purpose: "tracking", state: "granted", legal_basis: "consent",
      evidence: {}, policy_version: "2026-08-01", expires_at: "2099-01-01T00:00:00Z"
    });
    const result = await service.evaluateProcessingDecision(TENANT_A, "business", contactId, "tracking");
    expect(result.outcome).toBe("ALLOWED");
  });
});

describe("E: formål-isolasjon - en tillatelse for ETT formål gir ALDRI stilltiende tillatelse for et annet", () => {
  it("'granted' for 'attribution' påvirker IKKE 'tracking' for SAMME kontakt", async () => {
    const contactId = "ct-cst-a1";
    await service.recordConsentDecision(TENANT_A, "business", {
      contact_id: contactId, purpose: "attribution", state: "granted", legal_basis: "consent",
      evidence: {}, policy_version: "2026-08-01"
    });
    const trackingResult = await service.evaluateProcessingDecision(TENANT_A, "business", contactId, "tracking");
    expect(trackingResult.outcome).not.toBe("ALLOWED"); // uendret av attribution-tillatelsen (UNKNOWN_NOT_CONFIGURED med mindre en tidligere test allerede satte tracking - sjekk kun at den IKKE er ALLOWED via attribution-lekkasje).
  });
});

describe("F: tenant-/space-isolasjon (RLS)", () => {
  it("TENANT_B kan ALDRI se TENANT_A sine beslutninger, selv for en kontakt-ID med samme streng-mønster", async () => {
    await service.recordConsentDecision(TENANT_A, "business", {
      contact_id: "ct-cst-a1", purpose: "attribution", state: "granted", legal_basis: "consent",
      evidence: {}, policy_version: "2026-08-01"
    });
    const fromB = await service.listConsentDecisions(TENANT_B, "business", { contact_id: "ct-cst-a1" });
    expect(fromB).toHaveLength(0);
    const resultFromB = await service.evaluateProcessingDecision(TENANT_B, "business", "ct-cst-a1", "attribution");
    expect(resultFromB.outcome).toBe("UNKNOWN_NOT_CONFIGURED"); // TENANT_A sin 'granted' er usynlig for TENANT_B.
  });

  it("en beslutning registrert i 'business'-space er usynlig fra 'personal'-space-kontekst for SAMME tenant", async () => {
    await service.recordConsentDecision(TENANT_A, "business", {
      contact_id: "ct-cst-a2", purpose: "tracking", state: "granted", legal_basis: "consent",
      evidence: {}, policy_version: "2026-08-01"
    });
    const fromPersonalSpace = await service.listConsentDecisions(TENANT_A, "personal", { contact_id: "ct-cst-a2" });
    expect(fromPersonalSpace).toHaveLength(0);
  });
});

describe("G: legal_basis - eier-konfigurert autoritetsreferanse, IKKE en Jarvis-avledet konklusjon (strukturelt bevis)", () => {
  it("alle fire CHECK-tillatte legal_basis-verdier kan registreres - Jarvis håndhever verdien, avgjør den aldri selv", async () => {
    const bases: Array<"consent" | "legitimate_interest" | "contract" | "legal_obligation"> = [
      "consent", "legitimate_interest", "contract", "legal_obligation"
    ];
    for (const legalBasis of bases) {
      const decision = await service.recordConsentDecision(TENANT_A, "business", {
        contact_id: "ct-cst-a1", purpose: "attribution", state: "granted", legal_basis: legalBasis,
        evidence: {}, policy_version: `test-${legalBasis}`
      });
      expect(decision.legal_basis).toBe(legalBasis);
    }
  });

  it("databasens CHECK-constraint gjør en UGYLDIG legal_basis-verdi UMULIG å sette, selv med et direkte INSERT-forsøk", async () => {
    await expect(
      adminPool.query(
        `INSERT INTO consent_decisions (decision_id, tenant_id, memory_space_id, contact_id, purpose, state, legal_basis, evidence, policy_version)
         VALUES ('cst-dec-bad', $1, 'business', 'ct-cst-a1', 'attribution', 'granted', 'ai_inferred_probably', '{}'::jsonb, 'v1')`,
        [TENANT_A]
      )
    ).rejects.toThrow();
  });

  it("databasens CHECK-constraint gjør en UGYLDIG purpose-verdi UMULIG å sette (lukket formål-sett)", async () => {
    await expect(
      adminPool.query(
        `INSERT INTO consent_decisions (decision_id, tenant_id, memory_space_id, contact_id, purpose, state, legal_basis, evidence, policy_version)
         VALUES ('cst-dec-bad2', $1, 'business', 'ct-cst-a1', 'advertising_retargeting', 'granted', 'consent', '{}'::jsonb, 'v1')`,
        [TENANT_A]
      )
    ).rejects.toThrow();
  });
});

describe("H: append-only-loggen er STRUKTURELT umulig å UPDATE-re (databasegrant, ikke bare konvensjon)", () => {
  it("jarvis_app-rollen har INGEN UPDATE-grant på consent_decisions - et direkte UPDATE-forsøk feiler på tilgangsnivå", async () => {
    const decision = await service.recordConsentDecision(TENANT_A, "business", {
      contact_id: "ct-cst-a1", purpose: "attribution", state: "granted", legal_basis: "consent",
      evidence: {}, policy_version: "2026-08-01"
    });
    await expect(
      appPool.query(`UPDATE consent_decisions SET state = 'denied' WHERE decision_id = $1`, [decision.decision_id])
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("I: ZERO ModelGateway/AI-inferens noe sted i @jarvis/consent (strukturelt bevis)", () => {
  it("src/*.ts importerer ALDRI @jarvis/model-gateway/@jarvis/provider-adapters eller en provider-SDK direkte", async () => {
    const files = ["../src/service.ts", "../src/transport.ts", "../src/types.ts"];
    for (const f of files) {
      const source = await readFile(fileURLToPath(new URL(f, import.meta.url)), "utf8");
      expect(source).not.toMatch(/@jarvis\/model-gateway|@jarvis\/provider-adapters|openai|anthropic/i);
    }
  });

  it("@jarvis/consent sin src/ importerer ALDRI @jarvis/business (kun DB-håndhevet FK mot contact_id - ingen ny pakkeavhengighet i kjøretid)", async () => {
    const files = ["../src/service.ts", "../src/transport.ts", "../src/types.ts", "../src/index.ts"];
    for (const f of files) {
      const source = await readFile(fileURLToPath(new URL(f, import.meta.url)), "utf8");
      expect(source).not.toMatch(/from ["']@jarvis\/business["']/);
    }
  });
});

describe("K: deterministisk current-state-rekkefølge selv ved IDENTISK recorded_at (§11 i PR #31-lukkingsordren)", () => {
  it("to rader med EKSAKT samme recorded_at løses deterministisk via 'seq' (monotonisk tie-breaker) - ALDRI uspesifisert SQL-rekkefølge", async () => {
    const contactId = "ct-cst-a1";
    // I FREMTIDEN (ikke fortiden) - garanterer at denne raden er NYERE enn
    // ALLE andre rader denne delte fixture-filen skriver via `DEFAULT now()`
    // i andre describe-blokker, slik at testen isolert beviser tie-break-
    // determinismen mellom DISSE to radene, uavhengig av kjørerekkefølge.
    const sameTimestamp = "2099-06-01T12:00:00.000000Z";
    // Direkte adminPool-INSERT (bypasser tjenestens `DEFAULT now()`) for å
    // TVINGE frem en identisk `recorded_at` - noe som i EKTE drift kan skje
    // under samtidige innsettinger (timestamptz har mikrosekund-presisjon,
    // men to transaksjoner KAN fortsatt committe innenfor samme mikrosekund).
    await adminPool.query(
      `INSERT INTO consent_decisions (decision_id, tenant_id, memory_space_id, contact_id, purpose, state, legal_basis, evidence, policy_version, recorded_at)
       VALUES ('cst-dec-tie-older', $1, 'business', $2, 'attribution', 'denied', 'consent', '{}'::jsonb, 'tie-test', $3)`,
      [TENANT_A, contactId, sameTimestamp]
    );
    await adminPool.query(
      `INSERT INTO consent_decisions (decision_id, tenant_id, memory_space_id, contact_id, purpose, state, legal_basis, evidence, policy_version, recorded_at)
       VALUES ('cst-dec-tie-newer', $1, 'business', $2, 'attribution', 'granted', 'consent', '{}'::jsonb, 'tie-test', $3)`,
      [TENANT_A, contactId, sameTimestamp]
    );
    // 'tie-newer' ble satt inn SIST -> høyere 'seq' -> MÅ vinne selv om
    // `recorded_at` er byte-for-byte identisk med 'tie-older' sin.
    for (let i = 0; i < 5; i++) {
      const state = await service.getCurrentConsentState(TENANT_A, "business", contactId, "attribution");
      expect(state?.decision_id).toBe("cst-dec-tie-newer");
      expect(state?.state).toBe("granted");
    }
  });
});

describe("J: listConsentDecisions filtrerer korrekt", () => {
  it("filtrerer på contact_id/purpose uavhengig av hverandre", async () => {
    await service.recordConsentDecision(TENANT_A, "business", {
      contact_id: "ct-cst-a1", purpose: "attribution", state: "granted", legal_basis: "consent",
      evidence: {}, policy_version: "j-test"
    });
    await service.recordConsentDecision(TENANT_A, "business", {
      contact_id: "ct-cst-a1", purpose: "tracking", state: "granted", legal_basis: "consent",
      evidence: {}, policy_version: "j-test"
    });
    const byContact = await service.listConsentDecisions(TENANT_A, "business", { contact_id: "ct-cst-a1" });
    expect(byContact.length).toBeGreaterThanOrEqual(2);
    expect(byContact.every((d) => d.contact_id === "ct-cst-a1")).toBe(true);
    const byPurpose = await service.listConsentDecisions(TENANT_A, "business", { purpose: "tracking" });
    expect(byPurpose.every((d) => d.purpose === "tracking")).toBe(true);
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateEmbeddedPostgresPort, createPool, runMigrations, withTenantTransaction } from "@jarvis/core";
import { DiagnosisService } from "../src/diagnosis.ts";
import { IncidentService } from "../src/service.ts";

/**
 * D-105 Part G: diagnose ATSKILT fra rå evidens (EKTE embedded-Postgres,
 * samme presedens som incidents-core.test.ts). Beviser: diagnose er en egen
 * type/tabell (ikke bare en evidens-rad), en MOTSAGT/revurdert diagnose
 * forblir UENDRET og spørrbar (ALDRI overskrevet), og tenant-isolasjon.
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT_A = "tenant-diag-a";
const TENANT_B = "tenant-diag-b";

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-diagnosis-"));
  epg = new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_diagnosis LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_diagnosis");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','DiagA','business'), ('${TENANT_B}','DiagB','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test_diagnosis", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("D-105 Part G: IncidentDiagnosis (evidens vs. konklusjon)", () => {
  it("A: opprett diagnose knyttet til en hendelse + bevis-lenker (supports/contradicts)", async () => {
    const incidents = new IncidentService(appPool);
    const diagnosis = new DiagnosisService(appPool);
    const incident = await incidents.createIncident(TENANT_A, "business", { title: "API 500s" });
    const ev1 = await incidents.addEvidence(TENANT_A, "business", incident.incident_id, {
      source_type: "log", summary: "500 error observed", observed_at: new Date().toISOString()
    });
    const dx = await diagnosis.createDiagnosis(TENANT_A, "business", incident.incident_id, {
      conclusion: "Deploy at 12:00 introduced a regression", source: "deterministic", supporting_evidence_ids: [ev1.evidence_id]
    });
    expect(dx.status).toBe("UNVERIFIED");
    expect(dx.source).toBe("deterministic");
    const links = await diagnosis.listEvidenceLinks(TENANT_A, "business", dx.diagnosis_id);
    expect(links).toEqual([{ evidence_id: ev1.evidence_id, relation: "supports" }]);
  });

  it("B: en REVURDERT diagnose oppretter en NY rad (supersedes_diagnosis_id) - den GAMLE forblir UENDRET og spørrbar, ALDRI overskrevet", async () => {
    const incidents = new IncidentService(appPool);
    const diagnosis = new DiagnosisService(appPool);
    const incident = await incidents.createIncident(TENANT_A, "business", { title: "Latency spike" });
    const first = await diagnosis.createDiagnosis(TENANT_A, "business", incident.incident_id, {
      conclusion: "Suspected DB lock contention", source: "deterministic"
    });
    const revised = await diagnosis.createDiagnosis(TENANT_A, "business", incident.incident_id, {
      conclusion: "Actually a network partition, not DB-related", source: "owner", supersedes_diagnosis_id: first.diagnosis_id
    });
    const all = await diagnosis.listDiagnoses(TENANT_A, "business", incident.incident_id);
    expect(all).toHaveLength(2);
    const stillThere = await diagnosis.getDiagnosis(TENANT_A, "business", first.diagnosis_id);
    expect(stillThere?.conclusion).toBe("Suspected DB lock contention"); // uendret
    expect(revised.supersedes_diagnosis_id).toBe(first.diagnosis_id);
  });

  it("C: diagnose mot en IKKE-eksisterende hendelse kastes eksplisitt, ingen stille opprettelse", async () => {
    const diagnosis = new DiagnosisService(appPool);
    await expect(diagnosis.createDiagnosis(TENANT_A, "business", "inc-does-not-exist", {
      conclusion: "x", source: "deterministic"
    })).rejects.toThrow(/incident_not_found/);
  });

  it("D: TENANT-ISOLASJON - tenant B kan IKKE lese/liste tenant A sin diagnose", async () => {
    const incidents = new IncidentService(appPool);
    const diagnosis = new DiagnosisService(appPool);
    const incident = await incidents.createIncident(TENANT_A, "business", { title: "Isolation test" });
    const dx = await diagnosis.createDiagnosis(TENANT_A, "business", incident.incident_id, { conclusion: "secret conclusion", source: "owner" });
    const asOtherTenant = await diagnosis.getDiagnosis(TENANT_B, "business", dx.diagnosis_id);
    expect(asOtherTenant).toBeNull();
    const listAsOtherTenant = await diagnosis.listDiagnoses(TENANT_B, "business", incident.incident_id);
    expect(listAsOtherTenant).toEqual([]);
  });

  it("E: RLS håndheves faktisk (rå superbruker-spørring bekrefter raden eksisterer, app-rollen ser den bare under riktig tenant-kontekst)", async () => {
    const incidents = new IncidentService(appPool);
    const diagnosis = new DiagnosisService(appPool);
    const incident = await incidents.createIncident(TENANT_A, "business", { title: "RLS check" });
    const dx = await diagnosis.createDiagnosis(TENANT_A, "business", incident.incident_id, { conclusion: "x", source: "deterministic" });
    const raw = await adminPool.query("SELECT 1 FROM incident_diagnoses WHERE diagnosis_id = $1", [dx.diagnosis_id]);
    expect(raw.rowCount).toBe(1); // raden eksisterer FAKTISK
    const asWrongTenant = await withTenantTransaction(appPool, TENANT_B, (client) =>
      client.query("SELECT 1 FROM incident_diagnoses WHERE diagnosis_id = $1", [dx.diagnosis_id]).then((r) => r.rowCount)
    );
    expect(asWrongTenant).toBe(0); // men usynlig under feil tenant-kontekst
  });
});

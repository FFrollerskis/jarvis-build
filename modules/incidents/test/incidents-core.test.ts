import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { ErasureService } from "@jarvis/erasure";
import { LocalHashEmbedding } from "@jarvis/memory";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { correlateIncident } from "../src/correlation.ts";
import { DeploymentService } from "../src/deployments.ts";
import { IncidentService } from "../src/service.ts";

/**
 * D-104 (UA-5 Production Operations Control Plane v1): EKTE embedded-Postgres
 * - beviser Part I-testkravene 1/2/14/15 (deploy-korrelasjon, motstridende
 * bevis bevart, tenant-isolasjon, audit-linkage) mot den faktiske RLS-
 * håndhevede schemaet (036_incidents.sql), ALDRI en mock av Postgres-laget.
 */

const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let incidents: IncidentService;
let deployments: DeploymentService;

const TENANT_A = "tenant-a-incidents";
const TENANT_B = "tenant-b-incidents";

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-incidents-"));
  epg = new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_incidents LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_incidents");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','business'), ('${TENANT_B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-a','A'), ('person-b','B');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-a','${TENANT_A}'), ('person-b','${TENANT_B}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test_incidents", password: "pw2" });
  incidents = new IncidentService(appPool);
  deployments = new DeploymentService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("D-104: IncidentService - lifecycle + bevis (EKTE Postgres)", () => {
  it("A: createIncident + getIncident round-trip", async () => {
    const created = await incidents.createIncident(TENANT_A, "business", { title: "API 500-feil" });
    expect(created.status).toBe("open");
    expect(created.severity).toBe("normal");
    const fetched = await incidents.getIncident(TENANT_A, "business", created.incident_id);
    expect(fetched?.title).toBe("API 500-feil");
  });

  it("B: setStatus håndhever state-machine - ugyldig overgang kaster, endrer ingenting", async () => {
    const incident = await incidents.createIncident(TENANT_A, "business", { title: "test" });
    await expect(incidents.setStatus(TENANT_A, "business", incident.incident_id, "repair_in_progress")).rejects.toThrow();
    const unchanged = await incidents.getIncident(TENANT_A, "business", incident.incident_id);
    expect(unchanged?.status).toBe("open");
  });

  it("C: addEvidence lagrer med UNVERIFIED-default - Q-26-stil, INGEN automatisk VERIFIED", async () => {
    const incident = await incidents.createIncident(TENANT_A, "business", { title: "test" });
    const evidence = await incidents.addEvidence(TENANT_A, "business", incident.incident_id, {
      source_type: "application_error", summary: "500 på /checkout", observed_at: new Date().toISOString()
    });
    expect(evidence.status).toBe("UNVERIFIED");
  });

  it("D: motstridende bevis BEVARES, ALDRI stille overskrevet - begge rader eksisterer, contradicts_evidence_id peker korrekt", async () => {
    const incident = await incidents.createIncident(TENANT_A, "business", { title: "test" });
    const first = await incidents.addEvidence(TENANT_A, "business", incident.incident_id, {
      source_type: "uptime", summary: "tjeneste nede", observed_at: "2026-08-21T10:00:00Z"
    });
    const contradicting = await incidents.addEvidence(TENANT_A, "business", incident.incident_id, {
      source_type: "uptime", summary: "tjeneste faktisk oppe - falsk alarm", observed_at: "2026-08-21T10:05:00Z",
      contradicts_evidence_id: first.evidence_id
    });
    const all = await incidents.listEvidence(TENANT_A, "business", incident.incident_id);
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.evidence_id === first.evidence_id)).toBeDefined();
    expect(contradicting.contradicts_evidence_id).toBe(first.evidence_id);
  });

  it("E: tenant-isolasjon - tenant B ser ALDRI tenant A sine hendelser", async () => {
    const incidentA = await incidents.createIncident(TENANT_A, "business", { title: "kun A" });
    const listB = await incidents.listIncidents(TENANT_B, "business", "all");
    expect(listB.find((i) => i.incident_id === incidentA.incident_id)).toBeUndefined();
    const getFromB = await incidents.getIncident(TENANT_B, "business", incidentA.incident_id);
    expect(getFromB).toBeNull();
  });
});

describe("D-104: DeploymentService + korrelasjon (EKTE Postgres)", () => {
  const REPO = "tsworkflow/example-repo";

  it("F: recordDeployment er idempotent - samme workflow_run_id gir INGEN duplikat", async () => {
    const first = await deployments.recordDeployment(TENANT_A, {
      source: "github_actions", repo: REPO, commit_sha: "sha1", workflow_run_id: "run-1",
      status: "success", deployed_at: "2026-08-21T09:00:00Z"
    });
    expect(first.created).toBe(true);
    const second = await deployments.recordDeployment(TENANT_A, {
      source: "github_actions", repo: REPO, commit_sha: "sha1", workflow_run_id: "run-1",
      status: "success", deployed_at: "2026-08-21T09:00:00Z"
    });
    expect(second.created).toBe(false);
    expect(second.deployment.deployment_id).toBe(first.deployment.deployment_id);
    const all = await deployments.listDeployments(TENANT_A, REPO);
    expect(all.filter((d) => d.workflow_run_id === "run-1")).toHaveLength(1);
  });

  it("G: findSuspectDeployment finner nyeste deploy FØR et gitt tidspunkt, ALDRI en senere en", async () => {
    await deployments.recordDeployment(TENANT_A, {
      source: "github_actions", repo: REPO, commit_sha: "sha-early", workflow_run_id: "run-early",
      status: "success", deployed_at: "2026-08-20T08:00:00Z"
    });
    await deployments.recordDeployment(TENANT_A, {
      source: "github_actions", repo: REPO, commit_sha: "sha-late", workflow_run_id: "run-late",
      status: "success", deployed_at: "2026-08-22T08:00:00Z"
    });
    const suspect = await deployments.findSuspectDeployment(TENANT_A, REPO, "2026-08-21T00:00:00Z");
    expect(suspect?.commit_sha).toBe("sha-early");
  });

  it("H: deploy-korrelasjon (item 1) - hendelse->aktiv deploy->commit forfremmer matchende evidence til VERIFIED, deterministisk", async () => {
    const dep = await deployments.recordDeployment(TENANT_A, {
      source: "github_actions", repo: REPO, commit_sha: "sha-suspect", workflow_run_id: "run-suspect",
      status: "success", deployed_at: "2026-08-21T12:00:00Z"
    });
    const incident = await incidents.createIncident(TENANT_A, "business", { title: "post-deploy regresjon" });
    await incidents.addEvidence(TENANT_A, "business", incident.incident_id, {
      source_type: "deployment", source_ref: dep.deployment.deployment_id,
      summary: "deploy identifisert som mistenkt", observed_at: "2026-08-21T12:30:00Z"
    });
    const result = await correlateIncident(incidents, deployments, TENANT_A, "business", incident.incident_id, REPO);
    expect(result.suspect_deployment?.deployment_id).toBe(dep.deployment.deployment_id);
    const promoted = result.evidence.find((e) => e.source_ref === dep.deployment.deployment_id);
    expect(promoted?.status).toBe("VERIFIED");
  });

  it("I: korrelasjon returnerer kontradiksjoner EKSPLISITT (item 2, ALDRI filtrert bort)", async () => {
    const incident = await incidents.createIncident(TENANT_A, "business", { title: "test" });
    const first = await incidents.addEvidence(TENANT_A, "business", incident.incident_id, {
      source_type: "log", summary: "loggmønster A", observed_at: "2026-08-21T10:00:00Z"
    });
    await incidents.addEvidence(TENANT_A, "business", incident.incident_id, {
      source_type: "log", summary: "loggmønster A var feiltolket", observed_at: "2026-08-21T10:10:00Z",
      contradicts_evidence_id: first.evidence_id
    });
    const result = await correlateIncident(incidents, deployments, TENANT_A, "business", incident.incident_id, REPO);
    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]?.contradicts_evidence_id).toBe(first.evidence_id);
  });

  it("J: findActiveDeployment/active_deployment er 'hva er live nå' UAVHENGIG av hendelsens tidsvindu - viser den NYESTE deployen (sha-late fra test G, 2026-08-22), IKKE den mistenkte deployen fra hendelsens EGET tidsvindu (sha-suspect, 2026-08-21)", async () => {
    const incident = await incidents.createIncident(TENANT_A, "business", { title: "test" });
    const result = await correlateIncident(incidents, deployments, TENANT_A, "business", incident.incident_id, REPO);
    expect(result.active_deployment?.commit_sha).toBe("sha-late");
    expect(result.active_deployment?.commit_sha).not.toBe(result.suspect_deployment?.commit_sha);
  });
});

describe("D-104: Q-20 erasure-plan-integrasjon (EKTE Postgres, item 15-relatert)", () => {
  it("K: incidents/incident_evidence telles av ErasureService.previewErasure() for det riktige memory_space-scopet - registrert, IKKE stille utelatt", async () => {
    const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch() });
    const erasure = new ErasureService(appPool, policy, new LocalHashEmbedding());
    const incident = await incidents.createIncident(TENANT_A, "business", { title: "erasure test" });
    await incidents.addEvidence(TENANT_A, "business", incident.incident_id, {
      source_type: "manual", summary: "test evidence", observed_at: new Date().toISOString()
    });
    const preview = await erasure.previewErasure({ type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" });
    expect(preview.affected["incidents"]).toBeGreaterThanOrEqual(1);
    expect(preview.affected["incident_evidence"]).toBeGreaterThanOrEqual(1);
  });
});

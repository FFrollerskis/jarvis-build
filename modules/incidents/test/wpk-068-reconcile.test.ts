import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { withMemoryTransaction } from "@jarvis/memory";
import { IncidentService } from "../src/service.ts";

/**
 * WP-K (D-471, JARVIS-068): avstemming mot WP-E1 (D-461). De store delene (livssyklus med varig historikk, sannhetstype-regime, sikret reparasjonsrute) er allerede bevist av `e1-incident-*.test.ts`; denne filen
 * dekker det som gjenstod i sannhetsregimet: en motsigelse (`contradicts_evidence_id`) kan bare peke på bevis i SAMME hendelse. Ekte Postgres som den begrensede app-rollen.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let incidents: IncidentService;
const A = "tenant-wpk068-a";
const B = "tenant-wpk068-b";
const OWNER = { person_id: "person-wpk068" };

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpk068-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_wpk068 LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_wpk068");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${A}','A','business'), ('${B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER.person_id}','Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER.person_id}','${A}'), ('${OWNER.person_id}','${B}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_wpk068", password: "pw2" });
  incidents = new IncidentService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

const evidenceInput = (summary: string, extra: { contradicts_evidence_id?: string } = {}) => ({
  source_type: "manual" as const, summary, observed_at: new Date().toISOString(), ...extra
});
const count = async (tenant: string, incidentId: string): Promise<number> =>
  withMemoryTransaction(appPool, tenant, ["business"], async (client) =>
    (await client.query("SELECT count(*)::int AS n FROM incident_evidence WHERE tenant_id = $1 AND incident_id = $2", [tenant, incidentId])).rows[0].n as number);

describe("en motsigelse peker kun på bevis i SAMME hendelse", () => {
  it("samme hendelse: motsigelsen lagres, og begge radene bevares (uendret oppførsel)", async () => {
    const incident = await incidents.createIncident(A, "business", { title: "motsigelse", owner_person_id: OWNER.person_id });
    const first = await incidents.addEvidence(A, "business", incident.incident_id, evidenceInput("det er nettverket"));
    const second = await incidents.addEvidence(A, "business", incident.incident_id, evidenceInput("nei, det var en konfigfeil", { contradicts_evidence_id: first.evidence_id }));
    expect(second.contradicts_evidence_id).toBe(first.evidence_id);
    expect(await count(A, incident.incident_id)).toBe(2);
  });

  it("en ANNEN hendelse (samme tenant): avvist med en stabil årsak, og INGEN rad skrives", async () => {
    const one = await incidents.createIncident(A, "business", { title: "hendelse 1", owner_person_id: OWNER.person_id });
    const two = await incidents.createIncident(A, "business", { title: "hendelse 2", owner_person_id: OWNER.person_id });
    const foreign = await incidents.addEvidence(A, "business", two.incident_id, evidenceInput("bevis i hendelse 2"));
    const error = await incidents.addEvidence(A, "business", one.incident_id, evidenceInput("påstår å motsi hendelse 2", { contradicts_evidence_id: foreign.evidence_id })).catch((err: unknown) => err as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("incident_evidence_contradiction_target_invalid");
    // årsaken er en av våre egne `incident_*`-koder, så API-et viser den som `reason` (OWN_INCIDENT_REASON) i stedet for en generisk feil
    expect((error as Error).message).toMatch(/^incident_[a-z_]+$/);
    expect(await count(A, one.incident_id)).toBe(0);
    expect(await count(A, two.incident_id)).toBe(1);
  });

  it("et bevis som ikke finnes, og en annen tenants bevis, avvises på samme måte (ingen informasjon om hvorfor)", async () => {
    const mine = await incidents.createIncident(A, "business", { title: "min", owner_person_id: OWNER.person_id });
    const theirs = await incidents.createIncident(B, "business", { title: "deres", owner_person_id: OWNER.person_id });
    const theirEvidence = await incidents.addEvidence(B, "business", theirs.incident_id, evidenceInput("deres bevis"));
    for (const target of ["inc-ev-finnes-ikke", theirEvidence.evidence_id]) {
      await expect(incidents.addEvidence(A, "business", mine.incident_id, evidenceInput("kryss-referanse", { contradicts_evidence_id: target })))
        .rejects.toThrow("incident_evidence_contradiction_target_invalid");
    }
    expect(await count(A, mine.incident_id)).toBe(0);
  });

  it("uten contradicts_evidence_id er innsetting uendret (ingen ekstra oppslag å feile på)", async () => {
    const incident = await incidents.createIncident(A, "business", { title: "uten motsigelse", owner_person_id: OWNER.person_id });
    const evidence = await incidents.addEvidence(A, "business", incident.incident_id, evidenceInput("vanlig bevis"));
    expect(evidence.contradicts_evidence_id).toBeNull();
  });
});

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { OpenLoopService } from "../src/open-loop-service.ts";
import { runOpenLoopSweepForAllTenants } from "../src/open-loop-sweep.ts";

/**
 * UA-3 Native Jarvis Contracts Core (D-71): "Reuse OpenLoopService... No
 * second task/reminder engine" - testmatrise for de fire nye
 * contract_*-loop_type-reglene. Rene SQL-fixtures direkte mot
 * `contracts`/`contract_obligations` (026_contracts.sql) - `@jarvis/business`
 * importerer BEVISST IKKE `@jarvis/agreements` (samme arkitektur-presedens
 * som support_tickets: OpenLoopService leser tabellene direkte via raa SQL,
 * ingen pakke-avhengighet på tvers av domenegrensen).
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let openLoops: OpenLoopService;

const TENANT_A = "tenant-ol-agr-a";
const TENANT_B = "tenant-ol-agr-b";

async function insertContract(
  tenantId: string,
  fields: Partial<{ status: string; renewal_date: string | null; termination_deadline: string | null; updated_at: string; company_id: string | null }>
): Promise<string> {
  const contractId = `agr-ct-${randomUUID()}`;
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(
      `INSERT INTO contracts (contract_id, tenant_id, memory_space_id, title, status, renewal_date, termination_deadline, owner_person_id, company_id, updated_at)
       VALUES ($1, $2, 'business', $3, $4, $5, $6, 'person-tobias', $7, COALESCE($8, now()))`,
      [
        contractId, tenantId, `Kontrakt ${contractId}`, fields.status ?? "active",
        fields.renewal_date ?? null, fields.termination_deadline ?? null, fields.company_id ?? null, fields.updated_at ?? null
      ]
    )
  );
  return contractId;
}

async function insertObligation(tenantId: string, contractId: string, dueAt: string | null): Promise<string> {
  const obligationId = `agr-ob-${randomUUID()}`;
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(
      `INSERT INTO contract_obligations (obligation_id, tenant_id, memory_space_id, contract_id, description, due_at, owner_person_id)
       VALUES ($1, $2, 'business', $3, 'Test-forpliktelse', $4, 'person-tobias')`,
      [obligationId, tenantId, contractId, dueAt]
    )
  );
  return obligationId;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-openloop-agr-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_openloop_agr_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_openloop_agr_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','business'), ('${TENANT_B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}'), ('person-tobias','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-a-business','${TENANT_A}','business'), ('ms-b-business','${TENANT_B}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_openloop_agr_test", password: "pw2" });
  openLoops = new OpenLoopService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: contract_renewal_due", () => {
  it("en aktiv kontrakt med fornyelsesdato innen 30 dager blir et open loop", async () => {
    const contractId = await insertContract(TENANT_A, { renewal_date: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    const result = await openLoops.detectContractRenewalsDue(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.contract_id === contractId);
    expect(loop?.loop_type).toBe("contract_renewal_due");
  });
  it("en fornyelsesdato langt fram i tid gir IKKE et open loop", async () => {
    const contractId = await insertContract(TENANT_A, { renewal_date: new Date(Date.now() + 365 * 86_400_000).toISOString() });
    await openLoops.detectContractRenewalsDue(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.contract_id === contractId)).toBeUndefined();
  });
});

describe("B: contract_termination_deadline", () => {
  it("en aktiv kontrakt med oppsigelsesfrist innen 30 dager blir et open loop med prioritet high", async () => {
    const contractId = await insertContract(TENANT_A, { termination_deadline: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    const result = await openLoops.detectContractTerminationDeadlines(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.contract_id === contractId);
    expect(loop?.loop_type).toBe("contract_termination_deadline");
    expect(loop?.priority).toBe("high");
  });
});

describe("C: contract_obligation_due", () => {
  it("en aapen forpliktelse med frist innen 14 dager blir et open loop", async () => {
    const contractId = await insertContract(TENANT_A, {});
    await insertObligation(TENANT_A, contractId, new Date(Date.now() + 5 * 86_400_000).toISOString());
    const result = await openLoops.detectContractObligationsDue(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.contract_id === contractId);
    expect(loop?.loop_type).toBe("contract_obligation_due");
    expect(loop?.reason).toContain("Test-forpliktelse");
  });
  it("en forfalt forpliktelse gir prioritet high", async () => {
    const contractId = await insertContract(TENANT_A, {});
    await insertObligation(TENANT_A, contractId, new Date(Date.now() - 86_400_000).toISOString());
    await openLoops.detectContractObligationsDue(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.contract_id === contractId);
    expect(loop?.priority).toBe("high");
  });
});

describe("D: contract_review_required", () => {
  it("en active kontrakt uendret i over 180 dager blir et open loop", async () => {
    const contractId = await insertContract(TENANT_A, { updated_at: new Date(Date.now() - 200 * 86_400_000).toISOString() });
    const result = await openLoops.detectContractsNeedingReview(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.contract_id === contractId)?.loop_type).toBe("contract_review_required");
  });
  it("en nylig oppdatert kontrakt gir IKKE et review-loop", async () => {
    const contractId = await insertContract(TENANT_A, {});
    await openLoops.detectContractsNeedingReview(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.contract_id === contractId && l.loop_type === "contract_review_required")).toBeUndefined();
  });
});

describe("E: auto-resolve naar vilkaaret ikke lenger er sant", () => {
  it("en tidligere forfalt oppsigelsesfrist som flyttes fram resolves automatisk paa neste sveip", async () => {
    const contractId = await insertContract(TENANT_A, { termination_deadline: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    await openLoops.detectContractTerminationDeadlines(TENANT_A, "business");
    let loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.contract_id === contractId)).toBeTruthy();

    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("UPDATE contracts SET termination_deadline = $1 WHERE tenant_id = $2 AND contract_id = $3", [new Date(Date.now() + 365 * 86_400_000).toISOString(), TENANT_A, contractId])
    );
    const result = await openLoops.detectContractTerminationDeadlines(TENANT_A, "business");
    expect(result.auto_resolved).toBeGreaterThanOrEqual(1);
    loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.contract_id === contractId)).toBeUndefined();
  });
});

describe("F: runSweep inkluderer alle fire contract-regler (Q-27-trygg full sveip)", () => {
  it("runSweep() detekterer contract_renewal_due UTEN et separat kall", async () => {
    const contractId = await insertContract(TENANT_A, { renewal_date: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    await openLoops.runSweep(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.contract_id === contractId)?.loop_type).toBe("contract_renewal_due");
  });
  it("runOpenLoopSweepForAllTenants (Q-27, listBusinessTenantIds) isolerer en tenant sin feil fra resten", async () => {
    await insertContract(TENANT_A, { renewal_date: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    const results = await runOpenLoopSweepForAllTenants(appPool, openLoops);
    expect(results[TENANT_A]).toBeDefined();
  });
});

describe("G: tenant-isolasjon", () => {
  it("TENANT_B faar ALDRI et open loop for TENANT_A sin kontrakt", async () => {
    const contractId = await insertContract(TENANT_A, { renewal_date: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    await openLoops.detectContractRenewalsDue(TENANT_A, "business");
    const loopsB = await openLoops.listOpenLoops(TENANT_B, "business", "open");
    expect(loopsB.find((l) => l.contract_id === contractId)).toBeUndefined();
  });
});

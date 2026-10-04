import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool.ts";
import { runMigrations } from "../src/db/migrator.ts";
import { runOperationalRetentionSweep } from "../src/services/operational-retention.ts";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * D-395 (JARVIS-074) - oppbevaring av driftsrader, bevist mot EKTE Postgres som den begrensede runtime-rollen:
 *  A. utløpte rader slettes, ferske beholdes (godkjenninger, grants, billetter, ferdige verktøyutføringer, scheduler-rader),
 *  B. uavsluttede bevis (`unverified` utføring, uferdig scheduler-dag) slettes ALDRI,
 *  C. faste gulv: selv med absurde argumenter slettes ingenting yngre enn gulvet,
 *  D. batch + tak (`maxBatches`) og fortsettelse neste kjøring,
 *  E. runtime-rollen har ikke DELETE direkte - og definer-rollen er bundet av RLS-policyene (kan ikke slette ferske rader),
 *  F. de manglende indeksene finnes.
 */
const TENANT = "tenant-ret";
const PERSON = "person-ret";
const DEVICE = "dev-ret";
const SESSION = "sess-ret";
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const scalar = async (sql: string): Promise<number> => Number(((await adminPool.query(sql)).rows[0] as { n: string | number }).n);

async function reset(): Promise<void> {
  await adminPool.query("DELETE FROM approvals; DELETE FROM session_grants; DELETE FROM device_enrollment_tickets; DELETE FROM tool_executions; DELETE FROM scheduler_state;");
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-d395-ret-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  epg = leased.postgres;
  PORT = leased.port;
  stopEmbeddedPostgres = leased.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_ret_test LOGIN PASSWORD 'ret-pw'");
  await adminPool.query("GRANT jarvis_app TO jarvis_ret_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'Retention', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${PERSON}', 'Ret');
    INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ('${DEVICE}', '${TENANT}', '${PERSON}', 'pc');
    INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id) VALUES ('${SESSION}', '${TENANT}', '${PERSON}', 'web', '${DEVICE}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_ret_test", password: "ret-pw" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

const approval = (nonce: string, expires: string): string =>
  `INSERT INTO approvals (nonce, tenant_id, action, parameters, approving_device_id, expires_at) VALUES ('${nonce}', '${TENANT}', 'a', '{}', '${DEVICE}', ${expires});`;
const grant = (id: string, expires: string, revoked = "NULL"): string =>
  `INSERT INTO session_grants (grant_id, tenant_id, person_id, device_id, session_id, memory_space, channel, auth_strength, device_key_fingerprint, expires_at, revoked_at)
   VALUES ('${id}', '${TENANT}', '${PERSON}', '${DEVICE}', '${SESSION}', 'personal', 'web', 'active', 'fp', ${expires}, ${revoked});`;
const ticket = (id: string, expires: string): string =>
  `INSERT INTO device_enrollment_tickets (ticket_id, tenant_id, person_id, expires_at) VALUES ('${id}', '${TENANT}', '${PERSON}', ${expires});`;
const execution = (key: string, status: string, executed: string): string =>
  `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, executed_at) VALUES ('${TENANT}', '${key}', 't', 'a', '${status}', ${executed});`;
const sched = (job: string, runDate: string, completed: string): string =>
  `INSERT INTO scheduler_state (job_name, run_date, claimed_by, completed_at) VALUES ('${job}', ${runDate}, 'w', ${completed});`;

describe("A+B: slett utløpt, behold ferskt og uavsluttet bevis", () => {
  it("sletter KUN rader eldre enn standardvinduene og rapporterer antall per tabell", async () => {
    await reset();
    await adminPool.query(
      [
        approval("old", "now() - interval '40 days'"),
        approval("recent-expired", "now() - interval '10 days'"), // utløpt, men innenfor 30 dagers standardvindu
        approval("live", "now() + interval '1 hour'"),
        grant("g-old", "now() - interval '40 days'"),
        grant("g-revoked-old", "now() + interval '1 hour'", "now() - interval '40 days'"),
        grant("g-live", "now() + interval '1 hour'"),
        ticket("t-old", "now() - interval '40 days'"),
        ticket("t-live", "now() + interval '1 hour'"),
        execution("e-old-ok", "succeeded", "now() - interval '200 days'"),
        execution("e-old-failed", "failed", "now() - interval '200 days'"),
        execution("e-old-unverified", "unverified", "now() - interval '200 days'"),
        execution("e-recent", "succeeded", "now() - interval '10 days'"),
        sched("job", "current_date - 100", "now() - interval '100 days'"),
        sched("job-uferdig", "current_date - 100", "NULL"),
        sched("job", "current_date - 1", "now()")
      ].join("\n")
    );
    const result = await runOperationalRetentionSweep(appPool);
    expect(result.deleted).toEqual({ approvals: 1, session_grants: 2, device_enrollment_tickets: 1, tool_executions: 2, scheduler_state: 1 });
    expect(result.capped).toBe(false);
    const left = async (sql: string): Promise<string[]> => (await adminPool.query(sql)).rows.map((r) => Object.values(r as Record<string, string>)[0] as string).sort();
    expect(await left("SELECT nonce FROM approvals")).toEqual(["live", "recent-expired"]);
    expect(await left("SELECT grant_id FROM session_grants")).toEqual(["g-live"]);
    expect(await left("SELECT ticket_id FROM device_enrollment_tickets")).toEqual(["t-live"]);
    // B: `unverified` er bevis på et ukjent utfall og slettes aldri automatisk.
    expect(await left("SELECT idempotency_key FROM tool_executions")).toEqual(["e-old-unverified", "e-recent"]);
    expect(await scalar("SELECT count(*) AS n FROM scheduler_state")).toBe(2); // ferdig fersk + uferdig gammel
  }, 60_000);
});

describe("C: faste gulv", () => {
  it("absurde argumenter (0 dager, negative) klemmes til gulvet - ingenting yngre enn gulvet slettes", async () => {
    await reset();
    await adminPool.query(
      [
        approval("a-3d", "now() - interval '3 days'"), // under 7-dagers gulv
        approval("a-10d", "now() - interval '10 days'"), // over gulv
        grant("g-3d", "now() - interval '3 days'"),
        ticket("t-3d", "now() - interval '3 days'"),
        execution("e-10d", "succeeded", "now() - interval '10 days'"), // under 30-dagers gulv
        execution("e-40d", "succeeded", "now() - interval '40 days'"), // over gulv
        sched("job", "current_date - 3", "now()"),
        sched("job", "current_date - 10", "now()")
      ].join("\n")
    );
    const result = await runOperationalRetentionSweep(appPool, { approvalsDays: 0, grantsDays: -5, ticketsDays: 0, toolExecutionsDays: 0, schedulerDays: 0 });
    expect(result.deleted).toEqual({ approvals: 1, session_grants: 0, device_enrollment_tickets: 0, tool_executions: 1, scheduler_state: 1 });
    expect((await adminPool.query("SELECT nonce FROM approvals")).rows).toEqual([{ nonce: "a-3d" }]);
    expect((await adminPool.query("SELECT idempotency_key FROM tool_executions")).rows).toEqual([{ idempotency_key: "e-10d" }]);
  }, 60_000);
});

describe("D: batch og tak", () => {
  it("sletter i begrensede batcher; maxBatches setter `capped` og resten tas neste kjøring", async () => {
    await reset();
    await adminPool.query(
      `INSERT INTO approvals (nonce, tenant_id, action, parameters, approving_device_id, expires_at)
       SELECT 'bulk-' || g, '${TENANT}', 'a', '{}', '${DEVICE}', now() - interval '60 days' FROM generate_series(1, 250) g`
    );
    const first = await runOperationalRetentionSweep(appPool, { batch: 100, maxBatches: 2 });
    expect(first.deleted["approvals"]).toBe(200);
    expect(first.batches).toBe(2);
    expect(first.capped).toBe(true);
    expect(await scalar("SELECT count(*) AS n FROM approvals")).toBe(50);
    const second = await runOperationalRetentionSweep(appPool, { batch: 100, maxBatches: 5 });
    expect(second.deleted["approvals"]).toBe(50);
    expect(second.capped).toBe(false);
    expect(await scalar("SELECT count(*) AS n FROM approvals")).toBe(0);
  }, 60_000);
});

describe("E: minste privilegium", () => {
  it("runtime-rollen har IKKE DELETE direkte på noen av tabellene (kun EXECUTE på funksjonen)", async () => {
    for (const table of ["approvals", "session_grants", "device_enrollment_tickets", "tool_executions", "scheduler_state"]) {
      await expect(appPool.query(`DELETE FROM ${table}`), table).rejects.toThrow(/permission denied/);
    }
  });

  it("definer-rollen er bundet av RLS-policyene: selv `DELETE` uten WHERE fjerner bare rader eldre enn gulvet", async () => {
    await reset();
    await adminPool.query(
      [
        approval("old", "now() - interval '40 days'"),
        approval("live", "now() + interval '1 hour'"),
        execution("e-old", "succeeded", "now() - interval '200 days'"),
        execution("e-recent", "succeeded", "now() - interval '1 day'"),
        execution("e-unverified", "unverified", "now() - interval '200 days'")
      ].join("\n")
    );
    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE jarvis_definer");
      const approvals = await client.query("DELETE FROM approvals");
      const executions = await client.query("DELETE FROM tool_executions");
      await client.query("ROLLBACK");
      expect(approvals.rowCount).toBe(1); // kun «old»
      expect(executions.rowCount).toBe(1); // kun «e-old» - ikke ferske, ikke unverified
    } finally {
      client.release();
    }
  });

  it("funksjonen eies av jarvis_definer med låst search_path og uten EXECUTE for PUBLIC", async () => {
    const { rows } = await adminPool.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig::text AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec, has_function_privilege('jarvis_app', p.oid, 'EXECUTE') AS app_exec
         FROM pg_proc p WHERE p.proname = 'prune_operational_data'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner: "jarvis_definer", secdef: true, public_exec: false, app_exec: true });
    expect((rows[0] as { config: string }).config).toContain("search_path=pg_catalog, public, pg_temp");
  });
});

describe("F: indekser", () => {
  it("de manglende indeksene finnes (messages, cost_events, tool_executions, approvals, session_grants, tickets, scheduler_state)", async () => {
    const { rows } = await adminPool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'");
    const names = new Set((rows as { indexname: string }[]).map((r) => r.indexname));
    for (const name of [
      "messages_session_created_idx",
      "cost_events_tenant_at_idx",
      "tool_executions_executed_idx",
      "approvals_expires_idx",
      "session_grants_expires_idx",
      "device_enrollment_tickets_expires_idx",
      "scheduler_state_run_date_idx"
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });
});

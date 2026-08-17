import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@jarvis/core";

/**
 * UA-3 P0 HOST FIX #2 (2026-08-17, ekte host-funn run_id `ad45603d`): ALLE
 * faktiske Business OS-kapabiliteter PASSET live (q21_runtime_role_safe,
 * ua3_business_runtime_role, company/contact/lead/opportunity/activity/
 * followup/metrics/tenant-isolasjon/space-isolasjon/ToolGateway-wiring/
 * audit) - KUN akseptanse-CLEANUP feilet:
 *   1. `DELETE FROM audit_events` kastet (append-only-triggeren forbyr det
 *      ubetinget) og stoppet RESTEN av `cleanupTenant()` - tool_executions/
 *      memory_spaces/person_tenants/tenants ble ALDRI slettet
 *      (`leftover_tenants=1`).
 *   2. Den etterfølgende `DELETE FROM people` feilet DERETTER med
 *      `person_tenants_person_id_fkey` - en direkte følge av at
 *      person_tenants aldri ble ryddet i (1).
 *
 * `audit_events.tenant_id` har INGEN fremmednøkkel mot `tenants` (kun
 * `cost_events.tenant_id` har det - `004_audit_cost.sql`) - append-only-
 * revisjonsrader for en slettet syntetisk akseptanse-tenant er derfor VERKEN
 * et FK-hinder for tenant-sletting NOCH noe cleanup-koden noensinne skal
 * prøve å slette. Denne suiten reproduserer/beviser den FK-sikre
 * rekkefølgen (samme SQL-sekvens som `cleanupTenant()` i
 * `ua3-business-live.ts`) direkte mot ekte embedded Postgres.
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;

const TENANT = "tenant-ua3-cleanup-test-a";
const UNRELATED_TENANT = "tenant-ua3-cleanup-test-unrelated";
const PERSON = "person-ua3-cleanup-test";
const UNRELATED_PERSON = "person-ua3-cleanup-test-unrelated";

async function seedTenant(tenantId: string, personId: string): Promise<void> {
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business')", [tenantId, `Cleanup test ${tenantId}`]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [personId, "Cleanup Tester"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2)", [personId, tenantId]);
  await adminPool.query("INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business')", [`ms-${tenantId}`, tenantId]);
  await adminPool.query(
    "INSERT INTO audit_events (tenant_id, person_id, type, decision, tool_id, action, capability_class, payload) VALUES ($1,$2,'tool.executed','ALLOW','business','create_contact','B','{}'::jsonb)",
    [tenantId, personId]
  );
  await adminPool.query(
    "INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status) VALUES ($1,$2,'business','create_contact','succeeded')",
    [tenantId, `idem-${tenantId}`]
  );
}

// Nøyaktig samme rekkefølge som cleanupTenant() i ua3-business-live.ts - BEVISST INGEN
// "DELETE FROM audit_events"-linje (se doc-blokken over).
async function cleanupTenantLikeLiveScript(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM business_followups WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_activities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_opportunities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_leads WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_contacts WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_companies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-ua3-cleanup-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
}, 240_000);

afterAll(async () => {
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: append-only audit_events kan ALDRI slettes (triggeren beviser hvorfor cleanup aldri skal forsøke det)", () => {
  it("DELETE FROM audit_events kastes ubetinget av audit_events_append_only-triggeren", async () => {
    await seedTenant(TENANT, PERSON);
    await expect(adminPool.query("DELETE FROM audit_events WHERE tenant_id = $1", [TENANT])).rejects.toThrow(/append_only|append-only/i);
    await cleanupTenantLikeLiveScript(TENANT);
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [PERSON]);
  });
});

describe("B/E: en beholdt audit-rad (aldri forsøkt slettet) hindrer IKKE resten av cleanup/tenant-sletting fra å lykkes", () => {
  it("cleanupTenantLikeLiveScript() (uten audit_events-linje) fullfører helt og sletter tenanten, selv med en gjenværende audit_events-rad", async () => {
    await seedTenant(TENANT, PERSON);
    await cleanupTenantLikeLiveScript(TENANT);
    const tenantGone = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = $1", [TENANT]);
    expect((tenantGone.rows[0] as { n: number }).n).toBe(0);
    const auditStillThere = await adminPool.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1", [TENANT]);
    expect((auditStillThere.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [PERSON]);
  });
});

describe("C/D: person_tenants slettes FØR people - kun DENNE kjøringens lenker fjernes", () => {
  it("DELETE FROM people feiler med FK-brudd DERSOM person_tenants ikke er ryddet FØRST (reproduserer host-funnets andre feilmelding)", async () => {
    await seedTenant(TENANT, PERSON);
    await expect(adminPool.query("DELETE FROM people WHERE person_id = $1", [PERSON])).rejects.toMatchObject({ code: "23503" });
    await cleanupTenantLikeLiveScript(TENANT);
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [PERSON]);
  });

  it("cleanupTenantLikeLiveScript() sletter person_tenants FØR tenants, og people-sletting lykkes ETTERPÅ", async () => {
    await seedTenant(TENANT, PERSON);
    await cleanupTenantLikeLiveScript(TENANT);
    const links = await adminPool.query("SELECT count(*)::int AS n FROM person_tenants WHERE person_id = $1", [PERSON]);
    expect((links.rows[0] as { n: number }).n).toBe(0);
    await expect(adminPool.query("DELETE FROM people WHERE person_id = $1", [PERSON])).resolves.toMatchObject({ rowCount: 1 });
  });
});

describe("F/G/H: urelaterte tenant/person/audit-rader røres aldri", () => {
  it("opprydding av TENANT rører aldri UNRELATED_TENANT sine tenants/person_tenants/audit_events-rader", async () => {
    await seedTenant(TENANT, PERSON);
    await seedTenant(UNRELATED_TENANT, UNRELATED_PERSON);
    await cleanupTenantLikeLiveScript(TENANT);
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [PERSON]);

    const unrelatedTenant = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = $1", [UNRELATED_TENANT]);
    expect((unrelatedTenant.rows[0] as { n: number }).n).toBe(1);
    const unrelatedPerson = await adminPool.query("SELECT count(*)::int AS n FROM people WHERE person_id = $1", [UNRELATED_PERSON]);
    expect((unrelatedPerson.rows[0] as { n: number }).n).toBe(1);
    const unrelatedAudit = await adminPool.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1", [UNRELATED_TENANT]);
    expect((unrelatedAudit.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);

    await cleanupTenantLikeLiveScript(UNRELATED_TENANT);
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [UNRELATED_PERSON]);
  });
});

describe("I: gjentatt opprydding er idempotent", () => {
  it("cleanupTenantLikeLiveScript() kjørt to ganger på rad kaster ikke - andre kjøring er en no-op", async () => {
    await seedTenant(TENANT, PERSON);
    await cleanupTenantLikeLiveScript(TENANT);
    await expect(cleanupTenantLikeLiveScript(TENANT)).resolves.toBeUndefined();
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [PERSON]);
  });
});

describe("J: ingen trigger-deaktivering/TRUNCATE/row_security-omgåelse noe sted i live-scriptet", () => {
  it("ua3-business-live.ts inneholder ingen kjørbar DELETE FROM audit_events, TRUNCATE, eller DISABLE TRIGGER (kommentarer som NEVNER teknikkene i dokumentasjonsøyemed er greit)", async () => {
    const source = await readFile(fileURLToPath(new URL("../scripts/ua3-business-live.ts", import.meta.url)), "utf8");
    const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    expect(codeOnly).not.toMatch(/DELETE FROM audit_events/);
    expect(codeOnly).not.toMatch(/TRUNCATE/i);
    expect(codeOnly).not.toMatch(/DISABLE TRIGGER/i);
    expect(codeOnly).not.toMatch(/row_security\s*=\s*off/i);
  });
});

describe("N: metrics()-spørringen bruker ALDRI samtidige client.query()-kall på samme client", () => {
  it("service.ts sin metrics()-metode kjører spørringene SEKVENSIELT (await hver for seg), ikke Promise.all([client.query(...), ...])", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/service.ts", import.meta.url)), "utf8");
    const metricsStart = source.indexOf("async metrics(");
    const metricsBlock = source.slice(metricsStart, source.indexOf("\n  }\n}", metricsStart));
    expect(metricsBlock).not.toMatch(/Promise\.all\(\s*\[\s*client\.query/);
    const awaitedQueries = [...metricsBlock.matchAll(/const \w+ = await client\.query\(/g)];
    expect(awaitedQueries.length).toBe(4);
  });
});

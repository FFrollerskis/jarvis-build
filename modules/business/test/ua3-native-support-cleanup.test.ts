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
import { BusinessService, OpenLoopService } from "@jarvis/business";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../../erasure/src/erasure-service.ts";
import { SupportService } from "../../support/src/service.ts";

/**
 * UA-3 Native Support Core HOST FIX #3 (D-69, ekte host-funn run_id
 * `1e821a86`, `hard_fail=true` - ALLE funksjonelle/sikkerhets-/Q-20-markører
 * PASSET, KUN `ua3_support_cleanup=FAIL`): `ua3-native-support-live.ts` sin
 * Q-20-seksjon oppretter BEVISST en `business_followups`-fixture (for å
 * bevise erasure-scope-presisjon) OG en EKTE `erasure_requests`/
 * `erasure_fingerprints`-revisjonsrad (via den ekte `ErasureService`) - ingen
 * av dem ble ryddet av `cleanupTenant()`, som blokkerte
 * `DELETE FROM tenants` (`business_followups_tenant_id_fkey`/
 * `erasure_requests_tenant_id_fkey`).
 *
 * Denne suiten speiler EKSAKT samme DELETE-rekkefølge som ble lagt til i
 * `cleanupTenant()` (`modules/business/scripts/ua3-native-support-live.ts`)
 * mot en EKTE embedded Postgres - scriptets egne, lokale funksjoner
 * eksporteres bevisst ikke (samme etablerte konvensjon som `q20-erasure-
 * live.ts`/`ua3-open-loops-live.ts` osv. - direkte-kjørte akseptanseskript,
 * ikke gjenbrukbare moduler). Byggeordrens §10 A-H.
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let runtimePool: pg.Pool;

const TENANT_A = `tenant-sup-cleanup-a-${randomUUID().slice(0, 8)}`;
const TENANT_B = `tenant-sup-cleanup-b-${randomUUID().slice(0, 8)}`; // urelatert - skal forbli urørt
const OWNER = "person-sup-cleanup-owner";

function identityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-${tenantId}`, device_id: "dev-sup-cleanup", channel: "api", auth_strength: "active"
  };
}

function sovereignPolicyFor(tenantId: string): PolicyGateway {
  return new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER, owner_tenants: [tenantId] }
  });
}

/** EKSAKT samme sekvens som `cleanupTenant()` i ua3-native-support-live.ts etter HOST FIX #3. */
async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM support_ticket_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM support_tickets WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_followups WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM erasure_fingerprints WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM erasure_requests WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_activities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_contacts WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_companies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);

  const { rows: fkRows } = await adminPool.query(`
    SELECT tc.table_name, tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'tenants' AND kcu.column_name = 'tenant_id'
  `);
  const blockers: Array<{ table: string; rows: number }> = [];
  for (const row of fkRows as Array<{ table_name: string }>) {
    if (!/^[a-z_][a-z0-9_]*$/.test(row.table_name)) throw new Error("unsafe_identifier");
    const { rows } = await adminPool.query(`SELECT count(*)::int AS n FROM "${row.table_name}" WHERE tenant_id = $1`, [tenantId]);
    const n = (rows[0] as { n: number }).n;
    if (n > 0) blockers.push({ table: row.table_name, rows: n });
  }
  if (blockers.length > 0) {
    throw new Error(`cleanup_blocked: ${JSON.stringify(blockers)}`);
  }
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

/** Setter opp NØYAKTIG samme fixture-scenario som live-scriptets Q-20-seksjon skapte i det ekte host-funnet. */
async function seedTenantWithFixtures(tenantId: string): Promise<{ followupId: string; requestId: string }> {
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business')", [tenantId, `Cleanup Test ${tenantId}`]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,'Owner') ON CONFLICT (person_id) DO NOTHING", [OWNER]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2)", [OWNER, tenantId]);
  await adminPool.query("INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business')", [`ms-${tenantId}`, tenantId]);

  const support = new SupportService(runtimePool);
  const openLoops = new OpenLoopService(runtimePool);
  const business = new BusinessService(runtimePool);

  const ticket = await support.createTicket(tenantId, "business", { subject: "Cleanup ticket" });
  await support.setNextResponseDue(tenantId, "business", ticket.ticket_id, new Date(Date.now() - 3_600_000).toISOString());
  await openLoops.runSweep(tenantId, "business");

  const followup = await business.createFollowup(tenantId, "business", { title: "Cleanup unrelated followup", due_at: "2020-01-01T00:00:00Z" });

  const erasure = new ErasureService(runtimePool, sovereignPolicyFor(tenantId), new LocalHashEmbedding());
  const requestId = `req-sup-cleanup-${randomUUID()}`;
  const result = await erasure.executeErasure({
    scope: { type: "memory_space", tenant_id: tenantId, memory_space_id: "business" },
    requestId, identity: identityFor(tenantId)
  });
  expect(result.status).toBe("completed");

  return { followupId: followup.followup_id, requestId };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-sup-cleanup-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_sup_cleanup_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sup_cleanup_test");
  runtimePool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sup_cleanup_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await runtimePool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: en akseptanse-stil synteisk tenant kan faktisk reprodusere BÅDE business_followups- og erasure_requests-fixturene", () => {
  it("seedTenantWithFixtures oppretter en business_followups-rad OG en fullført erasure_requests-rad for tenanten", async () => {
    const { followupId, requestId } = await seedTenantWithFixtures(TENANT_A);
    const followupRow = await adminPool.query("SELECT 1 FROM business_followups WHERE tenant_id = $1 AND followup_id = $2", [TENANT_A, followupId]);
    const requestRow = await adminPool.query("SELECT status FROM erasure_requests WHERE tenant_id = $1 AND request_id = $2", [TENANT_A, requestId]);
    expect(followupRow.rowCount).toBe(1);
    expect(requestRow.rowCount).toBe(1);
    expect((requestRow.rows[0] as { status: string }).status).toBe("completed");
  });
});

describe("B/C: cleanup fjerner de synteiske avhengige radene i korrekt rekkefølge, og tenanten kan deretter slettes", () => {
  it("cleanupTenant() lykkes uten FK-brudd og tenant-raden er faktisk borte etterpå", async () => {
    await expect(cleanupTenant(TENANT_A)).resolves.toBeUndefined();
    const tenantGone = await adminPool.query("SELECT 1 FROM tenants WHERE tenant_id = $1", [TENANT_A]);
    expect(tenantGone.rowCount).toBe(0);
    const followupsGone = await adminPool.query("SELECT count(*)::int AS n FROM business_followups WHERE tenant_id = $1", [TENANT_A]);
    const requestsGone = await adminPool.query("SELECT count(*)::int AS n FROM erasure_requests WHERE tenant_id = $1", [TENANT_A]);
    expect((followupsGone.rows[0] as { n: number }).n).toBe(0);
    expect((requestsGone.rows[0] as { n: number }).n).toBe(0);
  });
});

describe("D: urelatert tenant sin business_followups/erasure_requests forblir uendret", () => {
  it("rydding av TENANT_A rører aldri TENANT_B sine fixtures", async () => {
    const a = await seedTenantWithFixtures(TENANT_A);
    const b = await seedTenantWithFixtures(TENANT_B);
    await cleanupTenant(TENANT_A);

    const bFollowup = await adminPool.query("SELECT 1 FROM business_followups WHERE tenant_id = $1 AND followup_id = $2", [TENANT_B, b.followupId]);
    const bRequest = await adminPool.query("SELECT 1 FROM erasure_requests WHERE tenant_id = $1 AND request_id = $2", [TENANT_B, b.requestId]);
    expect(bFollowup.rowCount).toBe(1);
    expect(bRequest.rowCount).toBe(1);

    const aFollowup = await adminPool.query("SELECT 1 FROM business_followups WHERE tenant_id = $1 AND followup_id = $2", [TENANT_A, a.followupId]);
    expect(aFollowup.rowCount).toBe(0);

    await cleanupTenant(TENANT_B); // rydd opp etter denne testen
  });
});

describe("E: produksjonens ErasureService-retensjon er UENDRET - runtime-rollen kan fortsatt ALDRI slette erasure_requests selv", () => {
  it("jarvis_app-rollen (runtimePool) får et permission-avslag på DELETE FROM erasure_requests - kun SELECT/INSERT/UPDATE, som i 018_erasure.sql", async () => {
    await expect(runtimePool.query("DELETE FROM erasure_requests WHERE tenant_id = 'nonexistent'")).rejects.toThrow(/permission denied/i);
  });
});

describe("F: runtime-rollens tillatelser er for øvrig uendret - fortsatt ingen DELETE på business_followups, fortsatt NOSUPERUSER/NOBYPASSRLS", () => {
  it("jarvis_app kan fortsatt ikke slette fra business_followups direkte", async () => {
    await expect(runtimePool.query("DELETE FROM business_followups WHERE tenant_id = 'nonexistent'")).rejects.toThrow(/permission denied/i);
  });
  it("jarvis_sup_cleanup_test er fortsatt NOSUPERUSER/NOBYPASSRLS (Q-21 uendret)", async () => {
    const { rows } = await runtimePool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    const row = rows[0] as { rolsuper: boolean; rolbypassrls: boolean };
    expect(row.rolsuper).toBe(false);
    expect(row.rolbypassrls).toBe(false);
  });
});

describe("G/H: stale-run-opprydding (selvhelbredelse) er idempotent - trygt å kjøre på en allerede ryddet ELLER aldri-eksisterende tenant, ogsaa flere ganger", () => {
  it("cleanupTenant() på en tenant som IKKE finnes lykkes uten feil (ingen rader å slette noe sted)", async () => {
    await expect(cleanupTenant(`tenant-does-not-exist-${randomUUID()}`)).resolves.toBeUndefined();
  });

  it("cleanupTenant() kjørt to ganger paa RAD for SAMME (allerede ryddede) tenant lykkes begge ganger", async () => {
    const tenantId = `tenant-sup-cleanup-twice-${randomUUID().slice(0, 8)}`;
    await seedTenantWithFixtures(tenantId);
    await expect(cleanupTenant(tenantId)).resolves.toBeUndefined();
    await expect(cleanupTenant(tenantId)).resolves.toBeUndefined(); // andre kjøring: tenanten finnes ikke lenger - fortsatt trygt
  });
});

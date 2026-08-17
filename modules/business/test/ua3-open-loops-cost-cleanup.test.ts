import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { BusinessService } from "../src/service.ts";
import { OpenLoopService } from "../src/open-loop-service.ts";

/**
 * UA-3 NEXT SLICE HOST FIX #1 (D-54, ekte host-funn av Tobias, `run_id 19a7f3a4`):
 * to distinkte funn i `ua3-open-loops-live.ts`.
 *
 * (1) `ua3_open_loop_idempotency=FAIL` selv om host-loggen viste
 *     `open_loops_before=2 open_loops_after=2 duplicate_rows_for_same_key=0` - en
 *     ACCEPTANCE-HARNESS-bug, ikke en produksjonsfeil. Root cause: IDEMPOTENS-
 *     seksjonens verifikasjonsspørring brukte raw `pool.query(...)` DIREKTE mot
 *     `business_open_loops` (som har FORCE ROW LEVEL SECURITY) UTEN å gå via
 *     `withMemoryTransaction` - under den ekte NOSUPERUSER/NOBYPASSRLS runtime-
 *     rollen (Q-21) settes ALDRI `jarvis.tenant_id`/`jarvis.memory_spaces`-
 *     session-GUC-ene RLS-policyen krever, `current_setting(..., true)` returnerer
 *     NULL, USING-predikatet blir NULL (ikke true) - spørringen ser derfor 0 rader
 *     UANSETT faktisk databasetilstand. `OpenLoopService` sine egne metoder (bevist
 *     i `open-loop-service.test.ts` §B) bruker `withMemoryTransaction` KORREKT
 *     overalt - produksjonslogikken var aldri broken. Denne suiten reproduserer
 *     PRESIST det samme mønsteret (raw query vs. withMemoryTransaction-wrappet
 *     query mot samme data under en ekte non-bypass rolle) for å BEVISE årsaken,
 *     ikke bare anta den.
 *
 * (2) Akseptanse-CLEANUP feilet med `cost_events_tenant_id_fkey` - en genuint NY
 *     avhengighet i dette sliceet: `get_business_brief` (period=daily) konstruerer
 *     `new DailyBrief([...], pool)`, og `DailyBrief.generate()` skriver DA en
 *     `cost_events`-rad per genererte brief (se `daily-brief.ts` sin
 *     "Run-rate: én rad per generert brief"-kommentar). P0 hadde ingen brief-
 *     handling og traff derfor aldri dette. Bekreftet mot faktisk skjema
 *     (`004_audit_cost.sql`): `cost_events.tenant_id REFERENCES tenants` (FK, ingen
 *     CASCADE) OG INGEN append-only-trigger (i motsetning til `audit_events`) -
 *     derfor trygt slettbar operasjonell test-metadata for KUN den midlertidige
 *     akseptanse-tenanten. Samme presedens/rekkefølge (FØRST i cleanupTenant()) som
 *     `modules/knowledge/scripts/ua2-p1b-a-host-run.ts` sin D-45 HOST FIX for
 *     identisk FK-klasse.
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const TENANT = "tenant-ua3-ol-cleanup-test-a";
const UNRELATED_TENANT = "tenant-ua3-ol-cleanup-test-unrelated";
const PERSON = "person-ua3-ol-cleanup-test";
const UNRELATED_PERSON = "person-ua3-ol-cleanup-test-unrelated";

async function seedTenant(tenantId: string, personId: string): Promise<void> {
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business')", [tenantId, `OL cleanup test ${tenantId}`]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [personId, "OL Cleanup Tester"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2)", [personId, tenantId]);
  await adminPool.query("INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business')", [`ms-${tenantId}`, tenantId]);
}

// Samme rekkefølge som den FIKSEDE cleanupTenant() i ua3-open-loops-live.ts.
async function cleanupTenantLikeFixedLiveScript(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM cost_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
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
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-ua3-ol-cleanup-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_ol_cleanup_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_ol_cleanup_test");
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_ol_cleanup_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: reproduserer den EKSAKTE root cause for ua3_open_loop_idempotency=FAIL - raw pool.query() mot en FORCE-RLS-tabell uten withMemoryTransaction ser 0 rader selv om raden finnes", () => {
  it("en raw appPool.query() (non-bypass rolle, INGEN jarvis.tenant_id/jarvis.memory_spaces satt) finner 0 rader for et open loop som FAKTISK eksisterer", async () => {
    await seedTenant(TENANT, PERSON);
    const business = new BusinessService(appPool);
    const openLoops = new OpenLoopService(appPool);
    const followup = await business.createFollowup(TENANT, "business", { title: "Harness-bug-repro", due_at: "2020-01-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT, "business");

    const raw = await appPool.query("SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = $1 AND detection_key = $2", [
      TENANT, `overdue_followup:${followup.followup_id}`
    ]);
    expect((raw.rows[0] as { n: number }).n).toBe(0);

    const viaAdmin = await adminPool.query("SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = $1 AND detection_key = $2", [
      TENANT, `overdue_followup:${followup.followup_id}`
    ]);
    expect((viaAdmin.rows[0] as { n: number }).n).toBe(1);

    await cleanupTenantLikeFixedLiveScript(TENANT);
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [PERSON]);
  });

  it("den FIKSEDE spørringen (withMemoryTransaction, samme non-bypass rolle) finner den EKSAKTE raden korrekt - 1, ikke 0", async () => {
    await seedTenant(TENANT, PERSON);
    const business = new BusinessService(appPool);
    const openLoops = new OpenLoopService(appPool);
    const followup = await business.createFollowup(TENANT, "business", { title: "Harness-bug-fix", due_at: "2020-01-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT, "business");

    const { rows } = await withMemoryTransaction(appPool, TENANT, ["business"], (client) =>
      client.query("SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = $1 AND detection_key = $2", [
        TENANT, `overdue_followup:${followup.followup_id}`
      ])
    );
    expect((rows[0] as { n: number }).n).toBe(1);

    await cleanupTenantLikeFixedLiveScript(TENANT);
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [PERSON]);
  });
});

describe("B: cost_events blokkerer faktisk tenant-sletting (reproduserer host-funnets EKSAKTE FK-brudd)", () => {
  it("DELETE FROM tenants feiler PRESIST med cost_events_tenant_id_fkey NAAR alt annet allerede er ryddet OG en cost_events-rad for tenanten finnes (simulerer DailyBrief.generate() sin brief:generation-rad)", async () => {
    await seedTenant(TENANT, PERSON);
    await adminPool.query(
      "INSERT INTO cost_events (tenant_id, session_id, kind, amount_ore, currency) VALUES ($1,$2,'brief:generation',0,'NOK')",
      [TENANT, "sess-ol-cleanup-repro"]
    );
    // Rydd ALLE andre tenant-scopede avhengigheter FØRST (person_tenants/memory_spaces/business_*)
    // slik at det GJENVÆRENDE, isolerte FK-bruddet er PRESIST det host-funnet viste - ikke et
    // vilkårlig annet FK-brudd Postgres tilfeldigvis rapporterer først.
    await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [TENANT]);
    await adminPool.query("DELETE FROM business_followups WHERE tenant_id = $1", [TENANT]);
    await adminPool.query("DELETE FROM business_activities WHERE tenant_id = $1", [TENANT]);
    await adminPool.query("DELETE FROM business_opportunities WHERE tenant_id = $1", [TENANT]);
    await adminPool.query("DELETE FROM business_leads WHERE tenant_id = $1", [TENANT]);
    await adminPool.query("DELETE FROM business_contacts WHERE tenant_id = $1", [TENANT]);
    await adminPool.query("DELETE FROM business_companies WHERE tenant_id = $1", [TENANT]);
    await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [TENANT]);
    await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [TENANT]);
    await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [TENANT]);
    await expect(adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [TENANT])).rejects.toMatchObject({ code: "23503" });
    await adminPool.query("DELETE FROM cost_events WHERE tenant_id = $1", [TENANT]);
    await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [TENANT]);
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [PERSON]);
  });
});

describe("C: den FIKSEDE cleanupTenant() (cost_events FØRST) fullfører helt, selv med en cost_events-rad til stede", () => {
  it("cleanupTenantLikeFixedLiveScript() sletter cost_events FØR tenants og fullfører uten feil", async () => {
    await seedTenant(TENANT, PERSON);
    await adminPool.query(
      "INSERT INTO cost_events (tenant_id, session_id, kind, amount_ore, currency) VALUES ($1,$2,'brief:generation',0,'NOK')",
      [TENANT, "sess-ol-cleanup-fix"]
    );
    await expect(cleanupTenantLikeFixedLiveScript(TENANT)).resolves.toBeUndefined();
    const tenantGone = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = $1", [TENANT]);
    expect((tenantGone.rows[0] as { n: number }).n).toBe(0);
    const costEventsGone = await adminPool.query("SELECT count(*)::int AS n FROM cost_events WHERE tenant_id = $1", [TENANT]);
    expect((costEventsGone.rows[0] as { n: number }).n).toBe(0);
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [PERSON]);
  });
});

describe("D/E: kun DENNE tenantens cost_events fjernes - urelaterte cost_events røres aldri", () => {
  it("cleanup av TENANT sletter aldri UNRELATED_TENANT sin cost_events-rad", async () => {
    await seedTenant(TENANT, PERSON);
    await seedTenant(UNRELATED_TENANT, UNRELATED_PERSON);
    await adminPool.query(
      "INSERT INTO cost_events (tenant_id, session_id, kind, amount_ore, currency) VALUES ($1,$2,'brief:generation',0,'NOK')",
      [TENANT, "sess-ol-a"]
    );
    await adminPool.query(
      "INSERT INTO cost_events (tenant_id, session_id, kind, amount_ore, currency) VALUES ($1,$2,'brief:generation',0,'NOK')",
      [UNRELATED_TENANT, "sess-ol-b"]
    );
    await cleanupTenantLikeFixedLiveScript(TENANT);
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [PERSON]);

    const unrelatedCostEvents = await adminPool.query("SELECT count(*)::int AS n FROM cost_events WHERE tenant_id = $1", [UNRELATED_TENANT]);
    expect((unrelatedCostEvents.rows[0] as { n: number }).n).toBe(1);
    const unrelatedTenant = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = $1", [UNRELATED_TENANT]);
    expect((unrelatedTenant.rows[0] as { n: number }).n).toBe(1);

    await cleanupTenantLikeFixedLiveScript(UNRELATED_TENANT);
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [UNRELATED_PERSON]);
  });
});

describe("F: gjentatt opprydding er idempotent, selv med cost_events i blandingen", () => {
  it("cleanupTenantLikeFixedLiveScript() kjørt to ganger paa rad kaster ikke - andre kjøring er en no-op", async () => {
    await seedTenant(TENANT, PERSON);
    await adminPool.query(
      "INSERT INTO cost_events (tenant_id, session_id, kind, amount_ore, currency) VALUES ($1,$2,'brief:generation',0,'NOK')",
      [TENANT, "sess-ol-idempotent"]
    );
    await cleanupTenantLikeFixedLiveScript(TENANT);
    await expect(cleanupTenantLikeFixedLiveScript(TENANT)).resolves.toBeUndefined();
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [PERSON]);
  });
});

describe("G: audit_events forblir BEVISST fraværende fra cleanup - append-only, uendret av denne fiksen", () => {
  it("cleanupTenantLikeFixedLiveScript() inneholder ingen DELETE FROM audit_events", () => {
    const source = cleanupTenantLikeFixedLiveScript.toString();
    expect(source).not.toMatch(/DELETE FROM audit_events/);
  });
});

describe("H: ingen trigger-deaktivering/TRUNCATE/row_security-omgåelse noe sted i det fiksede live-scriptet", () => {
  it("ua3-open-loops-live.ts inneholder ingen kjørbar DELETE FROM audit_events, TRUNCATE, eller DISABLE TRIGGER", async () => {
    const source = await readFile(fileURLToPath(new URL("../scripts/ua3-open-loops-live.ts", import.meta.url)), "utf8");
    const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    expect(codeOnly).not.toMatch(/DELETE FROM audit_events/);
    expect(codeOnly).not.toMatch(/TRUNCATE/i);
    expect(codeOnly).not.toMatch(/DISABLE TRIGGER/i);
    expect(codeOnly).not.toMatch(/row_security\s*=\s*off/i);
  });

  it("cost_events-slettingen skjer FØRST i cleanupTenant(), FØR business_open_loops og alle andre rader", async () => {
    const source = await readFile(fileURLToPath(new URL("../scripts/ua3-open-loops-live.ts", import.meta.url)), "utf8");
    const fnStart = source.indexOf("async function cleanupTenant");
    const fnBody = source.slice(fnStart, source.indexOf("\n}\n", fnStart));
    const costEventsIdx = fnBody.indexOf("DELETE FROM cost_events");
    const openLoopsIdx = fnBody.indexOf("DELETE FROM business_open_loops");
    const tenantsIdx = fnBody.indexOf("DELETE FROM tenants");
    expect(costEventsIdx).toBeGreaterThan(-1);
    expect(costEventsIdx).toBeLessThan(openLoopsIdx);
    expect(costEventsIdx).toBeLessThan(tenantsIdx);
  });

  it("IDEMPOTENS-seksjonens verifikasjonsspørring bruker withMemoryTransaction, ikke raw pool.query, mot business_open_loops", async () => {
    const source = await readFile(fileURLToPath(new URL("../scripts/ua3-open-loops-live.ts", import.meta.url)), "utf8");
    const sectionStart = source.indexOf('section("IDEMPOTENS');
    const sectionBody = source.slice(sectionStart, source.indexOf("});", sectionStart));
    expect(sectionBody).toContain("withMemoryTransaction(pool, TENANT_A");
    expect(sectionBody).not.toMatch(/await pool\.query\(\s*"SELECT count/);
  });
});

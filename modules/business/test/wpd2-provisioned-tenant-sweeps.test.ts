import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, provisionBusinessTenant, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { BusinessService, OpenLoopService, ScoringService, runOpenLoopSweepForAllTenants, runScoringSweepForAllTenants } from "../src/index.ts";

/**
 * WP-D2 (JARVIS-044): FØR tenant-provisjonering er alle business-sveip no-ops (tom katalog). ETTER begynner de å finne tenanten - og en ANNEN tenant ser
 * aldri noe av dens data (RLS som app-rolle). Dette er beviset for at provisjoneringen faktisk "tenner" sveipene uten å lekke på tvers.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
const OWNER_TENANT = "tenant-wpd2sw-owner";
const OWNER_PERSON = "person-wpd2sw-owner";
const owner = { owner_person_id: OWNER_PERSON, owner_tenant_id: OWNER_TENANT };
let before: Record<string, unknown> | undefined;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd2-sweeps-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpd2_sw LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_wpd2_sw");
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd2_sw", password: "pw2" });
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${OWNER_TENANT}', 'Eier', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER_PERSON}', 'Eier');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER_PERSON}', '${OWNER_TENANT}');
  `);
  // FØR provisjonering: sveipene kjøres mot en tom katalog.
  before = await runOpenLoopSweepForAllTenants(app, new OpenLoopService(app));
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("sveipene før og etter provisjonering", () => {
  it("FØR: open-loop-sveipet er en no-op (ingen bedrifts-tenant å behandle)", () => {
    expect(before).toEqual({});
  });

  it("ETTER: begge nyprovisjonerte tenants behandles av open-loop- og scoring-sveipet, og BARE tenant A får loops/scorer fra sine egne data", async () => {
    await provisionBusinessTenant(app, owner, { name: "Tenant A AS", slug: "sw-a" }, { via: "cli" });
    await provisionBusinessTenant(app, owner, { name: "Tenant B AS", slug: "sw-b" }, { via: "cli" });
    const business = new BusinessService(app);
    const openLoops = new OpenLoopService(app);
    const scoring = new ScoringService(app);

    // Data KUN i A: et selskap, en lead, og en forfalt oppfølging (-> overdue_followup-loop).
    const company = await business.createCompany("tenant-sw-a", "business", { name: "Acme A" });
    const lead = await business.createLead("tenant-sw-a", "business", { title: "Interessert i tjeneste", company_id: company.company_id });
    await business.createFollowup("tenant-sw-a", "business", {
      title: "Send tilbud", company_id: company.company_id, lead_id: lead.lead_id, due_at: new Date(Date.now() - 5 * 86_400_000).toISOString(), idempotency_key: "wpd2-sw-1"
    });

    const loopResults = await runOpenLoopSweepForAllTenants(app, openLoops);
    expect(Object.keys(loopResults).sort()).toEqual(["tenant-sw-a", "tenant-sw-b"]);
    expect(loopResults["tenant-sw-a"]).toMatchObject({ detected: 1 });
    expect(loopResults["tenant-sw-b"]).toEqual({ detected: 0, updated: 0, auto_resolved: 0 });

    const scoreResults = await runScoringSweepForAllTenants(app, scoring);
    expect(Object.keys(scoreResults).sort()).toEqual(["tenant-sw-a", "tenant-sw-b"]);
    expect(scoreResults["tenant-sw-a"]?.leads).toBe(1);
    expect(scoreResults["tenant-sw-b"]).toEqual({ leads: 0, opportunities: 0 });

    // A har sin loop; B ser ingenting (hverken loopen, selskapet, leaden eller oppfølgingen) - selv ved direkte forespørsel med A sine id-er.
    expect((await openLoops.listOpenLoops("tenant-sw-a", "business", "open")).map((l) => l.loop_type)).toEqual(["overdue_followup"]);
    expect(await openLoops.listOpenLoops("tenant-sw-b", "business", "all")).toEqual([]);
    expect(await business.overdueFollowups("tenant-sw-b", "business")).toEqual([]);
    expect(await business.companyTimeline("tenant-sw-b", "business", company.company_id)).toEqual([]);
    expect(await business.customerOverview("tenant-sw-b", "business", company.company_id)).toBeNull();
    expect(await business.findCompanies("tenant-sw-b", "business", "Acme")).toEqual([]);
    expect(await business.findCompanies("tenant-sw-a", "business", "Acme")).toHaveLength(1);
    // eierens person-tenant (ikke business) behandles ikke av business-sveipene
    expect(Object.keys(loopResults)).not.toContain(OWNER_TENANT);
  });

  it("A kan ikke skrive til B: en lead med B sin tenant_id fra A sin kontekst avvises av RLS (WITH CHECK)", async () => {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', 'tenant-sw-a', true), set_config('jarvis.memory_spaces', 'business', true)");
      await expect(client.query("INSERT INTO business_companies (company_id, tenant_id, memory_space_id, name) VALUES ('biz-co-evil', 'tenant-sw-b', 'business', 'Evil')")).rejects.toThrow(/row-level security/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

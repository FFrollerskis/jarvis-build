import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { BusinessService } from "@jarvis/business";
import { AgreementsService } from "../src/service.ts";

/**
 * UA-3 akseptansekriterium 1 ("Hva skjer med kunde X?") - HOST FIX: ekte
 * Postgres/RLS-bevis for at `AgreementsService`s kontrakt-lifecycle nå
 * FAKTISK speiles inn i `business_activities` og dukker opp i
 * `BusinessService.companyTimeline()` - se `recordContractTimelineActivity()`
 * i `../src/service.ts`. FØR denne fiksen skrev ingenting i
 * `modules/agreements` noensinne til `business_activities` (bekreftet ved
 * grep av hele modulen FØR denne testen ble skrevet - se øktrapporten).
 * Samme mønster som `service-rls.test.ts`, IKKE en `fakePool()`-mock.
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let agreements: AgreementsService;
let business: BusinessService;

const TENANT_A = "tenant-agr-tl-a";
const TENANT_B = "tenant-agr-tl-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-agreements-timeline-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_agr_tl_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_agr_tl_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Agreements Timeline A', 'business'), ('${TENANT_B}', 'Agreements Timeline B', 'business')`
  );
  // `business_companies.company_id` er en GLOBAL PRIMARY KEY (ikke
  // tenant-scoped) - to tenants kan derfor ALDRI dele samme `company_id`
  // (se samme kommentar i support-business-timeline.test.ts).
  await adminPool.query(
    `INSERT INTO business_companies (company_id, tenant_id, name) VALUES
       ('co-agr-tl', '${TENANT_A}', 'Acme AS'), ('co-agr-tl-b', '${TENANT_B}', 'Acme AS')`
  );
  await adminPool.query(
    `INSERT INTO business_contacts (contact_id, tenant_id, company_id, name, email) VALUES
       ('ct-agr-tl-a', '${TENANT_A}', 'co-agr-tl', 'Kari', 'kari@acme.no')`
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_agr_tl_test", password: "pw2" });
  agreements = new AgreementsService(appPool);
  business = new BusinessService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("D: kontrakt-opprettelse havner i selskapets tidslinje", () => {
  it("en kontrakt med company_id/contact_id gir en synlig business_activities-rad via companyTimeline()", async () => {
    const contract = await agreements.createContract(TENANT_A, "business", {
      title: "SaaS-avtale 2026", company_id: "co-agr-tl", contact_id: "ct-agr-tl-a"
    });
    const timeline = await business.companyTimeline(TENANT_A, "business", "co-agr-tl");
    const entry = timeline.find((e) => e.summary.includes("SaaS-avtale 2026"));
    expect(entry).toBeDefined();
    expect(entry?.activity_type).toBe("external_event");
    // Pointer-not-payload: peker til kontrakten, ALDRI en kopi av kontraktinnhold.
    expect(entry?.canonical_uri).toBe(`jarvis:contract:${contract.contract_id}`);
  });
});

describe("E: kontrakt-statusovergang gir en DISTINKT tidslinje-post", () => {
  it("setStatus produserer en egen 'status_change'-rad, ikke en duplikat av opprettelsen", async () => {
    const contract = await agreements.createContract(TENANT_A, "business", { title: "Status-Kontrakt", company_id: "co-agr-tl" });
    await agreements.setStatus(TENANT_A, "business", contract.contract_id, "review");
    const timeline = await business.companyTimeline(TENANT_A, "business", "co-agr-tl");
    const created = timeline.find((e) => e.activity_type === "external_event" && e.summary.includes("Status-Kontrakt"));
    const statusChange = timeline.find((e) => e.activity_type === "status_change" && e.summary.includes("draft -> review"));
    expect(created).toBeDefined();
    expect(statusChange).toBeDefined();
    expect(created?.activity_id).not.toBe(statusChange?.activity_id);
  });

  it("addVersion() gir en egen 'document'-rad i tidslinjen", async () => {
    const contract = await agreements.createContract(TENANT_A, "business", { title: "Versjonert-Kontrakt", company_id: "co-agr-tl" });
    await agreements.addVersion(TENANT_A, "business", contract.contract_id, { summary: "Justerte betalingsvilkaar" });
    const timeline = await business.companyTimeline(TENANT_A, "business", "co-agr-tl");
    const versionEntry = timeline.find((e) => e.activity_type === "document" && e.summary.includes("Justerte betalingsvilkaar"));
    expect(versionEntry).toBeDefined();
  });
});

describe("C: idempotens - gjentatt kontrakt-hendelse dupliserer ALDRI", () => {
  it("to setStatus-kall til SAMME maal-status gir kun EN business_activities-rad", async () => {
    const contract = await agreements.createContract(TENANT_A, "business", { title: "Idempotens-Kontrakt", company_id: "co-agr-tl" });
    await agreements.setStatus(TENANT_A, "business", contract.contract_id, "review");
    await agreements.setStatus(TENANT_A, "business", contract.contract_id, "draft");
    await agreements.setStatus(TENANT_A, "business", contract.contract_id, "review");
    const { rows } = await adminPool.query(
      `SELECT * FROM business_activities WHERE tenant_id = $1 AND source_type = 'contract' AND external_id = $2`,
      [TENANT_A, `${contract.contract_id}:status:review`]
    );
    expect(rows).toHaveLength(1);
  });
});

describe("F: kontrakt uten company_id/contact_id skaper INGEN tidslinje-rad", () => {
  it("createContract uten motpart kaster ikke, og etterlater INGEN business_activities-rad for kontrakten", async () => {
    const contract = await agreements.createContract(TENANT_A, "business", { title: "Ingen motpart" });
    expect(contract.company_id).toBeNull();
    expect(contract.contact_id).toBeNull();
    const { rows } = await adminPool.query(
      `SELECT * FROM business_activities WHERE tenant_id = $1 AND source_type = 'contract' AND external_id = $2`,
      [TENANT_A, `${contract.contract_id}:created`]
    );
    expect(rows).toHaveLength(0);
  });
});

describe("H: tenant-isolasjon", () => {
  it("en kontrakt i tenant B er ALDRI synlig i tenant A sin companyTimeline()", async () => {
    await agreements.createContract(TENANT_B, "business", { title: "Hemmelig-B-kontrakt", company_id: "co-agr-tl-b" });
    const timelineA = await business.companyTimeline(TENANT_A, "business", "co-agr-tl");
    expect(timelineA.some((e) => e.summary.includes("Hemmelig-B-kontrakt"))).toBe(false);
    const timelineB = await business.companyTimeline(TENANT_B, "business", "co-agr-tl-b");
    expect(timelineB.some((e) => e.summary.includes("Hemmelig-B-kontrakt"))).toBe(true);
  });
});

import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { allocateEmbeddedPostgresPort, createPool, runMigrations, withTenantTransaction } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService, ScoringService } from "../src/index.ts";

/**
 * UA-3 profiling/scoring HOST FIX #1 (D-62, ekte host-funn av Tobias,
 * `run_id 22226237`): EVERY funksjonell scoring-kapabilitet PASSET LIVE -
 * KUN `ua3_scoring_idempotent=FAIL` (`duplicate_rows_for_same_lead=0`).
 * Rotårsak (kildekode-sporet, IKKE gjettet): IDEMPOTENS-seksjonen i
 * `ua3-profiling-scoring-live.ts` verifiserte `business_scores` med
 * `withTenantTransaction()` - denne hjelperen setter KUN
 * `jarvis.tenant_id`, ALDRI `jarvis.memory_spaces`. `business_scores`
 * (`022_business_scoring.sql`) har - i MOTSETNING til `audit_events` (som
 * D-59 fikset MED `withTenantTransaction` fordi `audit_events` KUN har en
 * tenant-policy, ingen memory-space-policy) - BÅDE en tenant-policy OG en
 * RESTRICTIVE memory-space-policy (samme mønster som `business_open_loops`).
 * Naar `jarvis.memory_spaces` er usatt evaluerer
 * `memory_space_id = ANY(string_to_array(current_setting('jarvis.memory_spaces', true), ','))`
 * til NULL (ikke true), og den RESTRICTIVE policyen blokkerer strukturelt
 * ALLE rader - UANSETT faktisk databasetilstand. Dette er SAMME feilklasse
 * som D-54/D-59, men en NY konkret forekomst (feil hjelpefunksjon valgt for
 * en tabell med et EKSTRA policy-lag `withTenantTransaction` aldri satte).
 * Selve SKRIVINGEN var korrekt hele tiden - `ScoringService` bruker
 * `withMemoryTransaction()` konsekvent overalt (`scoring-service.ts`), og
 * host-loggen sitt eget `ua3_scoring_lead=PASS`/`ua3_scoring_manual_
 * override=PASS` beviser at raden faktisk ble lest korrekt via SAMME
 * ToolGateway-vei rett før idempotens-seksjonen kjørte.
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let toolGateway: ToolGateway;
let scoring: ScoringService;

const TENANT = "tenant-biz-scoring-rls";
let leadId = "";
let opportunityId = "";

const ownerIdentity: IdentityContext = {
  person_id: "person-tobias", tenant_id: TENANT, memory_space_id: "business",
  session_id: "sess-scoring-rls", device_id: "dev-scoring-rls", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-scoring-idempotency-rls-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_scoring_rls_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_scoring_rls_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Scoring RLS Test','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-scoring-rls-business','${TENANT}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_scoring_rls_test", password: "pw2" });

  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT] }
  });
  toolGateway = new ToolGateway(appPool, policy, new BusinessInternalSecretProvider());
  const service = new BusinessService(appPool);
  const openLoops = new OpenLoopService(appPool);
  scoring = new ScoringService(appPool);
  const businessTransport = new BusinessTransport(service, openLoops, appPool, toolGateway, scoring);
  for (const tool of firstWaveTools({ business: businessTransport })) toolGateway.register(tool);

  // Samme ekte kall-monster som live-skriptet: opprett en lead/opportunity, kjor recalculate_score
  // GJENNOM ToolGateway TO ganger (samme "IDEMPOTENS"-seksjon som host-loggen traff).
  const lead = await service.createLead(TENANT, "business", { title: "RLS-bevis-lead", status: "qualified" });
  leadId = lead.lead_id;
  const opp = await service.createOpportunity(TENANT, "business", { title: "RLS-bevis-opportunity", stage: "proposal" });
  opportunityId = opp.opportunity_id;

  for (let i = 0; i < 2; i++) {
    const result = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "recalculate_score",
      parameters: { tenant_id: TENANT, memory_space: "business", entity_type: "lead", entity_id: leadId }
    });
    expect(result.ok).toBe(true);
  }
  const oppResult = await toolGateway.execute({
    identity: ownerIdentity, tool_id: "business", action: "recalculate_score",
    parameters: { tenant_id: TENANT, memory_space: "business", entity_type: "opportunity", entity_id: opportunityId }
  });
  expect(oppResult.ok).toBe(true);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: score-rekalkulering via ToolGateway skriver EN reell, persistert business_scores-rad (adminPool bekrefter)", () => {
  it("adminPool (superuser, bypasser RLS) ser eksakt 1 rad for lead_priority", async () => {
    const { rows } = await adminPool.query(
      "SELECT count(*)::int AS n FROM business_scores WHERE tenant_id = $1 AND entity_id = $2 AND score_type = 'lead_priority'",
      [TENANT, leadId]
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});

describe("D: RLS-BLIND raw/withTenantTransaction-spørring (SAMME bug-klasse som D-54/D-59) reproduserer EKSAKT host-funnet", () => {
  it("en raw appPool.query() mot business_scores under den ekte non-bypass rollen finner 0 rader, til tross for at raden BEVISLIG finnes", async () => {
    const raw = await appPool.query(
      "SELECT count(*)::int AS n FROM business_scores WHERE tenant_id = $1 AND entity_id = $2 AND score_type = 'lead_priority'",
      [TENANT, leadId]
    );
    expect((raw.rows[0] as { n: number }).n).toBe(0);
  });

  it("SAMME spørring wrappet i withTenantTransaction() (kun jarvis.tenant_id, ALDRI jarvis.memory_spaces) finner FORTSATT 0 rader - dette er EKSAKT host-loggens duplicate_rows_for_same_lead=0", async () => {
    const { rows } = await withTenantTransaction(appPool, TENANT, (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM business_scores WHERE tenant_id = $1 AND entity_id = $2 AND score_type = 'lead_priority'",
        [TENANT, leadId]
      )
    );
    // business_scores har (i motsetning til audit_events) en EKSTRA RESTRICTIVE
    // memory-space-policy - withTenantTransaction() setter aldri jarvis.memory_spaces, saa denne
    // policyen evaluerer til NULL og blokkerer strukturelt alle rader, uansett faktisk data.
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});

describe("C: withMemoryTransaction() (SAMME hjelper ScoringService selv bruker) finner raden korrekt", () => {
  it("SAMME spørring wrappet i withMemoryTransaction(appPool, TENANT, ['business'], ...) finner eksakt 1 rad", async () => {
    const { rows } = await withMemoryTransaction(appPool, TENANT, ["business"], (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM business_scores WHERE tenant_id = $1 AND entity_id = $2 AND score_type = 'lead_priority'",
        [TENANT, leadId]
      )
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});

describe("B: eksakt idempotens-identitet - gjentatt rekalkulering oppdaterer SAMME logiske rad, oppretter ALDRI en duplikat", () => {
  it("(tenant_id, entity_type, entity_id, score_type) er den fullstendige UNIQUE-identiteten (022_business_scoring.sql) - rule_version deltar IKKE, men det er tiltenkt design (kun ÉN gjeldende score per entitet, ikke en versjonshistorikk-tabell - audit_events er historikken)", async () => {
    const { rows } = await adminPool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'business_scores'::regclass AND contype = 'u'`
    );
    const uniqueDefs = (rows as Array<{ conname: string; def: string }>).map((r) => r.def);
    expect(uniqueDefs.some((d) => d.includes("tenant_id") && d.includes("entity_type") && d.includes("entity_id") && d.includes("score_type"))).toBe(true);
    expect(uniqueDefs.some((d) => d.includes("rule_version"))).toBe(false);
  });

  it("tre påfølgende rekalkuleringer for SAMME lead gir fortsatt eksakt 1 logisk rad (score_id uendret)", async () => {
    const first = await scoring.recalculateLeadScore(TENANT, "business", leadId);
    const second = await scoring.recalculateLeadScore(TENANT, "business", leadId);
    const third = await scoring.recalculateLeadScore(TENANT, "business", leadId);
    expect(first?.score_id).toBe(second?.score_id);
    expect(second?.score_id).toBe(third?.score_id);
    const { rows } = await adminPool.query(
      "SELECT count(*)::int AS n FROM business_scores WHERE tenant_id = $1 AND entity_id = $2 AND score_type = 'lead_priority'",
      [TENANT, leadId]
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});

describe("E: opportunity-scoring er idempotent via SAMME persistence-vei", () => {
  it("adminPool ser eksakt 1 rad for opportunity_risk, withMemoryTransaction bekrefter samme resultat", async () => {
    const viaAdmin = await adminPool.query(
      "SELECT count(*)::int AS n FROM business_scores WHERE tenant_id = $1 AND entity_id = $2 AND score_type = 'opportunity_risk'",
      [TENANT, opportunityId]
    );
    expect((viaAdmin.rows[0] as { n: number }).n).toBe(1);
    const { rows } = await withMemoryTransaction(appPool, TENANT, ["business"], (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM business_scores WHERE tenant_id = $1 AND entity_id = $2 AND score_type = 'opportunity_risk'",
        [TENANT, opportunityId]
      )
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});

describe("K/L: Q-21 forblir uendret av denne fiksen - ingen RLS/rollesvekkelse", () => {
  it("appPool sin rolle er fortsatt jarvis_scoring_rls_test (non-superuser, non-bypass)", async () => {
    const { rows } = await adminPool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'jarvis_scoring_rls_test'");
    const role = rows[0] as { rolsuper: boolean; rolbypassrls: boolean };
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });
});

describe("M: live-scriptet bruker withMemoryTransaction for IDEMPOTENS-seksjonen, ikke withTenantTransaction", () => {
  it("ua3-profiling-scoring-live.ts sin IDEMPOTENS-seksjon bruker withMemoryTransaction(pool, TENANT_A, ['business'], ...), aldri withTenantTransaction mot business_scores", async () => {
    const source = await readFile(fileURLToPath(new URL("../scripts/ua3-profiling-scoring-live.ts", import.meta.url)), "utf8");
    const idempotensIdx = source.indexOf("IDEMPOTENS");
    const idempotensSection = source.slice(idempotensIdx, source.indexOf("await section(", idempotensIdx + 20));
    expect(idempotensSection).toContain('withMemoryTransaction(pool, TENANT_A, ["business"]');
    expect(idempotensSection).not.toMatch(/withTenantTransaction\(pool, TENANT_A/);
    expect(source).toMatch(/import\s*\{[^}]*withMemoryTransaction[^}]*\}\s*from\s*"@jarvis\/memory"/s);
  });
});

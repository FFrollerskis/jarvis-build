import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, pgDateToIsoDate, runMigrations } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { GrowthService } from "../src/service.ts";
import { InvalidCampaignTransitionError, InvalidExperimentTransitionError } from "../src/state-machine.ts";

/**
 * UA-4 Native Jarvis Growth Core (D-74): ekte Postgres/RLS-
 * integrasjonsbevis for `GrowthService` - kampanje-lifecycle/utgiftsledger/
 * attribusjon/CAC-ROAS/eksperimentregister/tenant-/memory-space-isolasjon
 * mot en EKTE NOSUPERUSER/NOBYPASSRLS-rolle (samme mønster som
 * agreements/support service-rls.test.ts, IKKE en `fakePool()`-mock).
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: GrowthService;

const TENANT_A = "tenant-grw-svc-a";
const TENANT_B = "tenant-grw-svc-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-growth-svc-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_grw_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_grw_svc_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Growth Svc A', 'business'), ('${TENANT_B}', 'Growth Svc B', 'business')`
  );
  await adminPool.query(`INSERT INTO business_companies (company_id, tenant_id, name) VALUES ('co-grw-a', '${TENANT_A}', 'Acme AS')`);
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-grw-owner', 'Owner One')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_grw_svc_test", password: "pw2" });
  service = new GrowthService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

/** Deterministisk lead/opportunity-fixture direkte mot Business Graph - via appPool (RLS-trygg rolle), ikke adminPool. */
async function insertLead(tenantId: string, id: string): Promise<void> {
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(`INSERT INTO business_leads (lead_id, tenant_id, memory_space_id, title) VALUES ($1, $2, 'business', 'Lead')`, [id, tenantId])
  );
}

async function insertOpportunity(tenantId: string, id: string, stage: string, valueOre: number | null): Promise<void> {
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(
      `INSERT INTO business_opportunities (opportunity_id, tenant_id, memory_space_id, title, stage, value_ore) VALUES ($1, $2, 'business', 'Opp', $3, $4)`,
      [id, tenantId, stage, valueOre]
    )
  );
}

describe("A: opprett kampanje", () => {
  it("createCampaign returnerer en gyldig kampanje med default status/valuta", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Test A" });
    expect(campaign.name).toBe("Test A");
    expect(campaign.channel).toBe("google_ads");
    expect(campaign.status).toBe("draft");
    expect(campaign.currency).toBe("NOK");
  });
  it("oppretter et 'campaign_created'-event automatisk", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "meta_ads", name: "Test A2" });
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("campaign_created");
  });
});

describe("B: get/list/search", () => {
  it("getCampaign finner en opprettet kampanje", async () => {
    const created = await service.createCampaign(TENANT_A, "business", { channel: "ga4", name: "Findable" });
    const found = await service.getCampaign(TENANT_A, "business", created.campaign_id);
    expect(found?.campaign_id).toBe(created.campaign_id);
  });
  it("searchCampaigns filtrerer deterministisk paa name_contains og channel", async () => {
    await service.createCampaign(TENANT_A, "business", { channel: "linkedin", name: "Unique-Search-Marker-XYZ" });
    const rows = await service.searchCampaigns(TENANT_A, "business", { name_contains: "Unique-Search-Marker-XYZ" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.name.includes("Unique-Search-Marker-XYZ"))).toBe(true);
    const byChannel = await service.searchCampaigns(TENANT_A, "business", { channel: "linkedin", name_contains: "Unique-Search-Marker-XYZ" });
    expect(byChannel.length).toBe(rows.length);
  });
});

describe("C: deterministisk lifecycle-overgang (state-machine haandheves i service-laget)", () => {
  it("gyldig kjede draft -> active -> paused fungerer og logges, started_at settes automatisk", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Transition" });
    const active = await service.setStatus(TENANT_A, "business", campaign.campaign_id, "active");
    expect(active?.status).toBe("active");
    expect(active?.started_at).not.toBeNull();
    const paused = await service.setStatus(TENANT_A, "business", campaign.campaign_id, "paused");
    expect(paused?.status).toBe("paused");
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events.filter((e) => e.event_type === "status_changed")).toHaveLength(2);
  });
  it("ugyldig overgang (draft -> paused) kaster og endrer INGENTING", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Bad transition" });
    await expect(service.setStatus(TENANT_A, "business", campaign.campaign_id, "paused")).rejects.toThrow(InvalidCampaignTransitionError);
    const unchanged = await service.getCampaign(TENANT_A, "business", campaign.campaign_id);
    expect(unchanged?.status).toBe("draft");
  });
  it("ended_at settes naar status settes til 'ended'", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "End" });
    await service.setStatus(TENANT_A, "business", campaign.campaign_id, "active");
    const ended = await service.setStatus(TENANT_A, "business", campaign.campaign_id, "ended");
    expect(ended?.ended_at).not.toBeNull();
  });
});

describe("D: budsjett", () => {
  it("setBudget oppdaterer budget_amount_ore og logger 'budget_changed'", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Budget" });
    const updated = await service.setBudget(TENANT_A, "business", campaign.campaign_id, 500_000);
    expect(updated?.budget_amount_ore).toBe("500000");
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events.some((e) => e.event_type === "budget_changed")).toBe(true);
  });
});

describe("E: idempotent utgifts-ingestion (write actions are idempotent, auditable, before/after state)", () => {
  it("recordSpendEvent for SAMME (kampanje, dato, kildetype) oppdaterer SAMME rad, oppretter aldri en duplikat", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Spend idempotent" });
    const first = await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, { event_date: "2026-08-01", spend_amount_ore: 10_000 });
    const second = await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, { event_date: "2026-08-01", spend_amount_ore: 25_000 });
    expect(second.spend_event_id).toBe(first.spend_event_id);
    expect(second.spend_amount_ore).toBe("25000");
    const all = await service.listSpendEvents(TENANT_A, "business", campaign.campaign_id);
    // HOST FIX #2 (D-76): `new Date(e.event_date).toISOString()` shifts the
    // calendar date backward on a non-UTC host (pg-types constructs `date`
    // columns via LOCAL `new Date(y, m, d)`, `.toISOString()` converts to
    // UTC) - `pgDateToIsoDate()` is the canonical, timezone-safe reversal.
    expect(all.filter((e) => pgDateToIsoDate(e.event_date) === "2026-08-01")).toHaveLength(1);
  });
  // HOST FIX #2 (D-76): speiler EKSAKT host-scriptets sekvens (identisk
  // retry FØRST, deretter en avvikende korreksjon) mot ekte Postgres/RLS -
  // separerer de to invariantene som D-75 definerte i stedet for å slaa
  // dem sammen i én boolsk sjekk, og beviser urelatert utgift/tenant-
  // isolasjon forblir upåvirket av korreksjonen.
  it("identisk retry (samme beløp) beholder samme rad/beløp UENDRET, deretter en avvikende korreksjon oppdaterer samme rad auditert, uten duplikat", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Retry then correction" });
    const unrelatedCampaign = await service.createCampaign(TENANT_A, "business", { channel: "meta_ads", name: "Unrelated" });
    await service.recordSpendEvent(TENANT_A, "business", unrelatedCampaign.campaign_id, { event_date: "2026-09-01", spend_amount_ore: 7_777 });

    const first = await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, { event_date: "2026-09-01", spend_amount_ore: 10_000 });
    const identicalRetry = await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, { event_date: "2026-09-01", spend_amount_ore: 10_000 });
    expect(identicalRetry.spend_event_id).toBe(first.spend_event_id);
    expect(identicalRetry.spend_amount_ore).toBe("10000");
    const afterRetry = await service.listSpendEvents(TENANT_A, "business", campaign.campaign_id);
    expect(afterRetry.filter((e) => pgDateToIsoDate(e.event_date) === "2026-09-01")).toHaveLength(1);

    const corrected = await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, { event_date: "2026-09-01", spend_amount_ore: 25_000 });
    expect(corrected.spend_event_id).toBe(first.spend_event_id);
    expect(corrected.spend_amount_ore).toBe("25000");
    const afterCorrection = await service.listSpendEvents(TENANT_A, "business", campaign.campaign_id);
    expect(afterCorrection.filter((e) => pgDateToIsoDate(e.event_date) === "2026-09-01")).toHaveLength(1);

    const auditEvents = (await service.listEvents(TENANT_A, "business", campaign.campaign_id)).filter((e) => e.event_type === "spend_recorded");
    expect(auditEvents).toHaveLength(3);
    expect(auditEvents[2]!.metadata["before_spend_amount_ore"]).toBe("10000");
    expect(auditEvents[2]!.metadata["after_spend_amount_ore"]).toBe(25_000);

    const unrelated = await service.listSpendEvents(TENANT_A, "business", unrelatedCampaign.campaign_id);
    expect(unrelated).toHaveLength(1);
    expect(unrelated[0]!.spend_amount_ore).toBe("7777");

    const tenantBEvents = await service.listSpendEvents(TENANT_B, "business", campaign.campaign_id);
    expect(tenantBEvents).toHaveLength(0);
  });
  it("re-synk logger before/after-verdier eksplisitt paa 'spend_recorded'-eventet", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Spend before-after" });
    await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, { event_date: "2026-08-02", spend_amount_ore: 1_000 });
    await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, { event_date: "2026-08-02", spend_amount_ore: 2_000 });
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    const spendEvents = events.filter((e) => e.event_type === "spend_recorded");
    expect(spendEvents).toHaveLength(2);
    expect(spendEvents[1]!.metadata["before_spend_amount_ore"]).toBe("1000");
    expect(spendEvents[1]!.metadata["after_spend_amount_ore"]).toBe(2000);
  });
  it("ulike datoer for samme kampanje gir separate rader (ikke idempotent paa tvers av dager)", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Spend per day" });
    await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, { event_date: "2026-08-03", spend_amount_ore: 1_000 });
    await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, { event_date: "2026-08-04", spend_amount_ore: 1_500 });
    const all = await service.listSpendEvents(TENANT_A, "business", campaign.campaign_id);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
  it("recordSpendEvent mot en ikke-eksisterende kampanje kaster campaign_not_found", async () => {
    await expect(service.recordSpendEvent(TENANT_A, "business", "nonexistent-campaign", { event_date: "2026-08-01", spend_amount_ore: 1 })).rejects.toThrow(
      "campaign_not_found"
    );
  });
});

describe("F: deterministisk attribusjon til eksisterende CRM-entiteter (ALDRI AI-gjettet)", () => {
  it("attributeToCampaign kobler en eksisterende lead til en kampanje", async () => {
    await insertLead(TENANT_A, "lead-grw-f1");
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Attribution lead" });
    const attribution = await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "lead", entity_id: "lead-grw-f1" });
    expect(attribution.entity_type).toBe("lead");
    expect(attribution.entity_id).toBe("lead-grw-f1");
    expect(attribution.attribution_model).toBe("first_touch");
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events.some((e) => e.event_type === "attribution_created")).toBe(true);
  });
  it("samme (entity, kampanje, modell) attribuert to ganger gir samme rad (idempotent), aldri duplikat", async () => {
    await insertLead(TENANT_A, "lead-grw-f2");
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Attribution idempotent" });
    const first = await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "lead", entity_id: "lead-grw-f2" });
    const second = await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "lead", entity_id: "lead-grw-f2" });
    expect(second.attribution_id).toBe(first.attribution_id);
    const all = await service.listAttributions(TENANT_A, "business", campaign.campaign_id);
    expect(all).toHaveLength(1);
  });
  it("attributeToCampaign mot en ikke-eksisterende kampanje kaster campaign_not_found", async () => {
    await insertLead(TENANT_A, "lead-grw-f3");
    await expect(
      service.attributeToCampaign(TENANT_A, "business", "nonexistent-campaign", { entity_type: "lead", entity_id: "lead-grw-f3" })
    ).rejects.toThrow("campaign_not_found");
  });
});

describe("G: CAC/ROAS knyttet til ekte CRM-data (UA-4 akseptansekriterium 1) - ALDRI fabrikkert", () => {
  it("CAC = total utgift / antall vunne opportunities, ROAS = attribuert inntekt / utgift", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "CAC ROAS" });
    await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, { event_date: "2026-08-05", spend_amount_ore: 100_000 });
    await insertOpportunity(TENANT_A, "opp-grw-g1", "won", 500_000);
    await insertOpportunity(TENANT_A, "opp-grw-g2", "proposal", 200_000); // ikke vunnet - skal IKKE telle som inntekt
    await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "opportunity", entity_id: "opp-grw-g1" });
    await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "opportunity", entity_id: "opp-grw-g2" });

    const perf = await service.campaignPerformance(TENANT_A, "business", campaign.campaign_id);
    expect(perf?.total_spend_ore).toBe("100000");
    expect(perf?.attributed_opportunities).toBe(2);
    expect(perf?.won_opportunities).toBe(1);
    expect(perf?.attributed_revenue_ore).toBe("500000"); // KUN den vunne - ekte business_opportunities.value_ore
    expect(perf?.cac_ore).toBe(100_000 / 1);
    expect(perf?.roas).toBe(500_000 / 100_000);
  });
  it("cac_ore er null (ikke 0/gjettet) naar ingen opportunity er vunnet - ratio er udefinert, aldri fabrikkert", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "No conversions" });
    await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, { event_date: "2026-08-06", spend_amount_ore: 50_000 });
    const perf = await service.campaignPerformance(TENANT_A, "business", campaign.campaign_id);
    expect(perf?.cac_ore).toBeNull();
    expect(perf?.roas).toBe(0); // ingen attribuert inntekt (0) / utgift > 0 = 0, IKKE null (nevner utgift er gyldig > 0)
  });
  it("roas er null naar total utgift er 0 (unngaar divisjon paa null)", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Zero spend" });
    const perf = await service.campaignPerformance(TENANT_A, "business", campaign.campaign_id);
    expect(perf?.total_spend_ore).toBe("0");
    expect(perf?.roas).toBeNull();
    expect(perf?.cac_ore).toBeNull();
  });
  it("campaignPerformance for en ikke-eksisterende kampanje returnerer null", async () => {
    const perf = await service.campaignPerformance(TENANT_A, "business", "nonexistent-campaign");
    expect(perf).toBeNull();
  });
});

describe("H: 'Hva skjer med kunde X?' for vekst-domenet (Business OS-integrasjon via attribusjon, ikke direkte selskap-FK)", () => {
  it("listByCompany finner kampanjer koblet til selskap X GJENNOM en attribuert opportunity", async () => {
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query(
        `INSERT INTO business_opportunities (opportunity_id, tenant_id, memory_space_id, company_id, title, stage) VALUES ('opp-grw-h1', $1, 'business', 'co-grw-a', 'Opp for company', 'new')`,
        [TENANT_A]
      )
    );
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Company timeline" });
    await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "opportunity", entity_id: "opp-grw-h1" });
    const rows = await service.listByCompany(TENANT_A, "business", "co-grw-a");
    expect(rows.some((r) => r.campaign_id === campaign.campaign_id)).toBe(true);
  });
  it("en kampanje uten noen attribusjon mot selskapet vises IKKE", async () => {
    const unrelated = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Unrelated to company" });
    const rows = await service.listByCompany(TENANT_A, "business", "co-grw-a");
    expect(rows.some((r) => r.campaign_id === unrelated.campaign_id)).toBe(false);
  });
});

describe("I: eksperimentregister", () => {
  it("createExperiment oppretter et draft-eksperiment, valgfritt knyttet til en kampanje", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Experiment campaign" });
    const experiment = await service.createExperiment(TENANT_A, "business", { name: "Test A/B", hypothesis: "Ny CTA gir høyere CTR", campaign_id: campaign.campaign_id });
    expect(experiment.status).toBe("draft");
    expect(experiment.campaign_id).toBe(campaign.campaign_id);
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events.some((e) => e.event_type === "experiment_created")).toBe(true);
  });
  it("setExperimentStatus haandhever deterministisk lifecycle og lagrer result_summary", async () => {
    const experiment = await service.createExperiment(TENANT_A, "business", { name: "Standalone experiment" });
    await service.setExperimentStatus(TENANT_A, "business", experiment.experiment_id, "running");
    const concluded = await service.setExperimentStatus(TENANT_A, "business", experiment.experiment_id, "concluded", "Ingen signifikant forskjell");
    expect(concluded?.status).toBe("concluded");
    expect(concluded?.result_summary).toBe("Ingen signifikant forskjell");
    expect(concluded?.ended_at).not.toBeNull();
  });
  it("ugyldig eksperiment-overgang (draft -> concluded) kaster og endrer INGENTING", async () => {
    const experiment = await service.createExperiment(TENANT_A, "business", { name: "Bad experiment transition" });
    await expect(service.setExperimentStatus(TENANT_A, "business", experiment.experiment_id, "concluded")).rejects.toThrow(InvalidExperimentTransitionError);
    const unchanged = await service.getExperiment(TENANT_A, "business", experiment.experiment_id);
    expect(unchanged?.status).toBe("draft");
  });
  it("listExperiments filtrerer paa status", async () => {
    const draft = await service.createExperiment(TENANT_A, "business", { name: "List draft" });
    const running = await service.createExperiment(TENANT_A, "business", { name: "List running" });
    await service.setExperimentStatus(TENANT_A, "business", running.experiment_id, "running");
    const draftOnly = await service.listExperiments(TENANT_A, "business", "draft");
    expect(draftOnly.some((e) => e.experiment_id === draft.experiment_id)).toBe(true);
    expect(draftOnly.some((e) => e.experiment_id === running.experiment_id)).toBe(false);
  });
});

describe("J: vekst-tidslinje er separat fra audit_events", () => {
  it("listEvents returnerer kampanje-spesifikke hendelser, ALDRI system-audit-radformat", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Timeline" });
    await service.setBudget(TENANT_A, "business", campaign.campaign_id, 10_000);
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events.some((e) => e.event_type === "campaign_created")).toBe(true);
    expect(events.some((e) => e.event_type === "budget_changed")).toBe(true);
    for (const e of events) expect(e.campaign_id).toBe(campaign.campaign_id);
  });
});

describe("K/L: tenant-/memory-space-isolasjon (RLS)", () => {
  it("K: TENANT_B ser ALDRI TENANT_A sine kampanjer", async () => {
    const campaignA = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Isolation A" });
    const foundFromB = await service.getCampaign(TENANT_B, "business", campaignA.campaign_id);
    expect(foundFromB).toBeNull();
    const listB = await service.listCampaigns(TENANT_B, "business", "all");
    expect(listB.some((c) => c.campaign_id === campaignA.campaign_id)).toBe(false);
  });
  it("L: en kampanje i memory_space 'business' er usynlig fra 'personal'-space-kontekst for samme tenant", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Space isolation" });
    const foundInPersonal = await service.getCampaign(TENANT_A, "personal", campaign.campaign_id);
    expect(foundInPersonal).toBeNull();
  });
});

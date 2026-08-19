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

describe("M (D-82): deterministisk UTM-/klikk-ID-basert auto-attribusjon", () => {
  it("registerCampaignTrackingTag med click_id oppretter en tagg og et tracking_tag_registered-event", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Tracking click_id" });
    const tag = await service.registerCampaignTrackingTag(TENANT_A, "business", campaign.campaign_id, { click_id_param: "gclid", click_id_value: `gclid-${campaign.campaign_id}` });
    expect(tag.tag_type).toBe("click_id");
    expect(tag.click_id_param).toBe("gclid");
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events.some((e) => e.event_type === "tracking_tag_registered")).toBe(true);
  });
  it("registerCampaignTrackingTag med utm-triplett oppretter en 'utm'-tagg", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Tracking utm" });
    const tag = await service.registerCampaignTrackingTag(TENANT_A, "business", campaign.campaign_id, {
      utm_source: "google", utm_medium: "cpc", utm_campaign: `spring-${campaign.campaign_id}`
    });
    expect(tag.tag_type).toBe("utm");
    expect(tag.utm_source).toBe("google");
  });
  it("registrering av SAMME tagg på nytt er idempotent - oppdaterer samme rad, oppretter INGEN duplikat", async () => {
    const campaignFirst = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Idempotent tag 1" });
    const campaignSecond = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Idempotent tag 2" });
    const clickIdValue = `idem-${campaignFirst.campaign_id}`;
    const first = await service.registerCampaignTrackingTag(TENANT_A, "business", campaignFirst.campaign_id, { click_id_param: "fbclid", click_id_value: clickIdValue });
    const second = await service.registerCampaignTrackingTag(TENANT_A, "business", campaignSecond.campaign_id, { click_id_param: "fbclid", click_id_value: clickIdValue });
    expect(second.tag_id).toBe(first.tag_id); // samme rad, aldri en ny
    expect(second.campaign_id).toBe(campaignSecond.campaign_id); // men peker nå til den nye kampanjen (siste registrering vinner - forventet re-tagging-atferd)
    const all = await service.listCampaignTrackingTags(TENANT_A, "business", campaignSecond.campaign_id);
    expect(all).toHaveLength(1);
  });
  it("registerCampaignTrackingTag mot en ikke-eksisterende kampanje kaster campaign_not_found", async () => {
    await expect(
      service.registerCampaignTrackingTag(TENANT_A, "business", "nonexistent-campaign", { click_id_param: "gclid", click_id_value: "x" })
    ).rejects.toThrow("campaign_not_found");
  });
  it("resolveCampaignFromTracking finner riktig kampanje for en EKSAKT click_id-match", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Resolve click_id" });
    const value = `resolve-${campaign.campaign_id}`;
    await service.registerCampaignTrackingTag(TENANT_A, "business", campaign.campaign_id, { click_id_param: "msclkid", click_id_value: value });
    const resolved = await service.resolveCampaignFromTracking(TENANT_A, "business", { click_id_param: "msclkid", click_id_value: value });
    expect(resolved).toBe(campaign.campaign_id);
  });
  it("resolveCampaignFromTracking finner riktig kampanje for en EKSAKT utm-triplett-match", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "meta_ads", name: "Resolve utm" });
    const campaignMarker = campaign.campaign_id;
    await service.registerCampaignTrackingTag(TENANT_A, "business", campaign.campaign_id, { utm_source: "meta", utm_medium: "social", utm_campaign: campaignMarker });
    const resolved = await service.resolveCampaignFromTracking(TENANT_A, "business", { utm_source: "meta", utm_medium: "social", utm_campaign: campaignMarker });
    expect(resolved).toBe(campaign.campaign_id);
  });
  it("resolveCampaignFromTracking returnerer null (ALDRI en gjettet kampanje) ved ingen match, inkl. delvis utm-overlapp", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "No partial match" });
    await service.registerCampaignTrackingTag(TENANT_A, "business", campaign.campaign_id, { utm_source: "google", utm_medium: "cpc", utm_campaign: "exact-only" });
    const noMatch = await service.resolveCampaignFromTracking(TENANT_A, "business", { click_id_param: "gclid", click_id_value: "never-registered" });
    expect(noMatch).toBeNull();
    // Delvis match (samme source/medium, ANNEN campaign) - IKKE en match, aldri en fuzzy fallback.
    const partial = await service.resolveCampaignFromTracking(TENANT_A, "business", { utm_source: "google", utm_medium: "cpc", utm_campaign: "different" });
    expect(partial).toBeNull();
  });
  it("én click_id-verdi kan ALDRI registreres mot to forskjellige kampanjer samtidig (databasen selv håndhever, ikke bare applikasjonskoden)", async () => {
    // Verifiserer at ON CONFLICT-oppdatering FLYTTER taggen (siste vinner) i stedet for å opprette en tvetydig andre rad.
    const campaignA = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Ambiguity A" });
    const campaignB = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Ambiguity B" });
    const sharedValue = `ambiguous-${campaignA.campaign_id}`;
    await service.registerCampaignTrackingTag(TENANT_A, "business", campaignA.campaign_id, { click_id_param: "gclid", click_id_value: sharedValue });
    await service.registerCampaignTrackingTag(TENANT_A, "business", campaignB.campaign_id, { click_id_param: "gclid", click_id_value: sharedValue });
    const resolved = await service.resolveCampaignFromTracking(TENANT_A, "business", { click_id_param: "gclid", click_id_value: sharedValue });
    expect(resolved).toBe(campaignB.campaign_id); // siste registrering vinner - ALDRI to samtidige rader for samme verdi
    const tagsA = await service.listCampaignTrackingTags(TENANT_A, "business", campaignA.campaign_id);
    expect(tagsA).toHaveLength(0); // taggen flyttet VEKK fra A, ikke duplisert
  });
  it("attributeFromTracking løser kampanje deterministisk og kaller den EKSISTERENDE attributeToCampaign uendret", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Attribute from tracking" });
    const value = `attr-${campaign.campaign_id}`;
    await service.registerCampaignTrackingTag(TENANT_A, "business", campaign.campaign_id, { click_id_param: "gclid", click_id_value: value });
    const attribution = await service.attributeFromTracking(TENANT_A, "business", {
      entity_type: "lead", entity_id: `lead-attr-${campaign.campaign_id}`, tracking: { click_id_param: "gclid", click_id_value: value }
    });
    expect(attribution.campaign_id).toBe(campaign.campaign_id);
    expect(attribution.source_pointer).toBe(`tracking:gclid=${value}`);
    const attributions = await service.listAttributions(TENANT_A, "business", campaign.campaign_id);
    expect(attributions.some((a) => a.attribution_id === attribution.attribution_id)).toBe(true);
  });
  it("attributeFromTracking kaster no_matching_campaign_for_tracking (ALDRI en gjettet kampanje) når ingen tagg matcher", async () => {
    await expect(
      service.attributeFromTracking(TENANT_A, "business", {
        entity_type: "lead", entity_id: "lead-no-match", tracking: { click_id_param: "fbclid", click_id_value: "never-registered-anywhere" }
      })
    ).rejects.toThrow("no_matching_campaign_for_tracking");
  });
  it("TENANT_B kan ALDRI resolve/attribuere via en sporingstagg registrert av TENANT_A (RLS)", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Tracking isolation" });
    const value = `iso-${campaign.campaign_id}`;
    await service.registerCampaignTrackingTag(TENANT_A, "business", campaign.campaign_id, { click_id_param: "gclid", click_id_value: value });
    const resolvedFromB = await service.resolveCampaignFromTracking(TENANT_B, "business", { click_id_param: "gclid", click_id_value: value });
    expect(resolvedFromB).toBeNull();
    await expect(
      service.attributeFromTracking(TENANT_B, "business", { entity_type: "lead", entity_id: "lead-iso", tracking: { click_id_param: "gclid", click_id_value: value } })
    ).rejects.toThrow("no_matching_campaign_for_tracking");
  });
});

describe("N (D-83): upsertCampaignFromProvider/findCampaignByExternalId - leverandør-synk-fundamentet", () => {
  it("oppretter en NY kampanje ved første synk og logger campaign_created med source=provider_sync", async () => {
    const campaign = await service.upsertCampaignFromProvider(TENANT_A, "business", { channel: "google_ads", external_campaign_id: "ext-n1", name: "Google Ads N1" });
    expect(campaign.name).toBe("Google Ads N1");
    expect(campaign.channel).toBe("google_ads");
    expect(campaign.external_campaign_id).toBe("ext-n1");
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("campaign_created");
    expect(events[0]!.metadata["source"]).toBe("provider_sync");
  });

  it("er idempotent: samme (channel, external_campaign_id) synket på nytt oppdaterer SAMME rad, oppretter INGEN duplikat", async () => {
    const first = await service.upsertCampaignFromProvider(TENANT_A, "business", { channel: "google_ads", external_campaign_id: "ext-n2", name: "Original navn" });
    const second = await service.upsertCampaignFromProvider(TENANT_A, "business", { channel: "google_ads", external_campaign_id: "ext-n2", name: "Oppdatert navn" });
    expect(second.campaign_id).toBe(first.campaign_id);
    expect(second.name).toBe("Oppdatert navn");
    const all = await service.searchCampaigns(TENANT_A, "business", { name_contains: "navn" });
    expect(all.filter((c) => c.campaign_id === first.campaign_id)).toHaveLength(1);
  });

  it("re-synk UTEN faktisk statusendring logger INGEN nytt event (unngår tidslinje-spam ved daglig synk)", async () => {
    const campaign = await service.upsertCampaignFromProvider(TENANT_A, "business", { channel: "google_ads", external_campaign_id: "ext-n3", name: "Stabil", status: "active" });
    await service.upsertCampaignFromProvider(TENANT_A, "business", { channel: "google_ads", external_campaign_id: "ext-n3", name: "Stabil", status: "active" });
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events).toHaveLength(1); // KUN campaign_created - ingen status_changed for en uendret re-synk
  });

  it("en FAKTISK provider-statusendring logger status_changed, med before/after i metadata", async () => {
    const campaign = await service.upsertCampaignFromProvider(TENANT_A, "business", { channel: "google_ads", external_campaign_id: "ext-n4", name: "Skifter status", status: "draft" });
    await service.upsertCampaignFromProvider(TENANT_A, "business", { channel: "google_ads", external_campaign_id: "ext-n4", name: "Skifter status", status: "paused" });
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events.filter((e) => e.event_type === "status_changed")).toHaveLength(1);
    const statusEvent = events.find((e) => e.event_type === "status_changed")!;
    expect(statusEvent.metadata["from"]).toBe("draft");
    expect(statusEvent.metadata["to"]).toBe("paused");
  });

  it("en provider-status-overgang som den INTERNE FSM-en aldri ville tillatt som en EGEN handling (draft->paused) settes likevel direkte - eksternt fakta, ikke en Jarvis-initiert handling", async () => {
    const campaign = await service.upsertCampaignFromProvider(TENANT_A, "business", { channel: "google_ads", external_campaign_id: "ext-n5", name: "FSM-bypass", status: "draft" });
    expect(campaign.status).toBe("draft");
    const updated = await service.upsertCampaignFromProvider(TENANT_A, "business", { channel: "google_ads", external_campaign_id: "ext-n5", name: "FSM-bypass", status: "paused" });
    expect(updated.status).toBe("paused"); // setStatus() ville kastet InvalidCampaignTransitionError her - upsertCampaignFromProvider gjør det bevisst IKKE
  });

  it("status='active' setter started_at automatisk (samme atferd som setStatus()), KUN ved første gang", async () => {
    const campaign = await service.upsertCampaignFromProvider(TENANT_A, "business", { channel: "google_ads", external_campaign_id: "ext-n6", name: "Aktiv", status: "active" });
    expect(campaign.started_at).not.toBeNull();
  });

  it("findCampaignByExternalId finner en synket kampanje via (channel, external_campaign_id), returnerer null for en ukjent kombinasjon", async () => {
    const campaign = await service.upsertCampaignFromProvider(TENANT_A, "business", { channel: "google_ads", external_campaign_id: "ext-n7", name: "Finn meg" });
    const found = await service.findCampaignByExternalId(TENANT_A, "business", "google_ads", "ext-n7");
    expect(found?.campaign_id).toBe(campaign.campaign_id);
    const notFound = await service.findCampaignByExternalId(TENANT_A, "business", "google_ads", "ext-does-not-exist");
    expect(notFound).toBeNull();
    // Samme external_campaign_id på en ANNEN channel er en ANNEN kampanje, aldri en falsk match.
    const wrongChannel = await service.findCampaignByExternalId(TENANT_A, "business", "meta_ads", "ext-n7");
    expect(wrongChannel).toBeNull();
  });

  it("Q-21-regresjon: upsertCampaignFromProvider/findCampaignByExternalId fungerer UENDRET under en NOSUPERUSER/NOBYPASSRLS-rolle (SAMME rolle alle andre tester i denne filen allerede kjører under - ingen ny grant/rettighetsutvidelse nødvendig)", async () => {
    // Ingen egen rolle-oppsett her med hensikt - `service` er allerede konstruert med `appPool` (jarvis_grw_svc_test, NOSUPERUSER/NOBYPASSRLS satt i beforeAll). At testene over i det hele tatt lykkes ER selve Q-21-beviset for denne sliceen - denne testen gjør det eksplisitt/navngitt for lesbarhet.
    const campaign = await service.upsertCampaignFromProvider(TENANT_A, "business", { channel: "google_ads", external_campaign_id: "ext-n8-q21", name: "Q21" });
    expect(campaign.campaign_id).toBeTruthy();
  });

  it("TENANT_B kan ALDRI finne eller påvirke en kampanje TENANT_A synket (RLS)", async () => {
    const campaign = await service.upsertCampaignFromProvider(TENANT_A, "business", { channel: "google_ads", external_campaign_id: "ext-n9-iso", name: "Isolert" });
    const foundFromB = await service.findCampaignByExternalId(TENANT_B, "business", "google_ads", "ext-n9-iso");
    expect(foundFromB).toBeNull();
    // TENANT_B sin egen upsert med SAMME external_campaign_id oppretter en HELT ANNEN rad (egen tenant_id-partisjon), aldri en kollisjon mot TENANT_A sin.
    const bOwn = await service.upsertCampaignFromProvider(TENANT_B, "business", { channel: "google_ads", external_campaign_id: "ext-n9-iso", name: "TENANT_B sin egen" });
    expect(bOwn.campaign_id).not.toBe(campaign.campaign_id);
  });
});

describe("O (D-85): anomaly -> recommended-action BESLUTNINGS-lag - upsert/list/resolve/supersede/detect", () => {
  it("upsertActionRecommendation oppretter en ny anbefaling med status='proposed' og et 'action_recommendation_created'-event", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Rec upsert" });
    const rec = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "reduce_budget",
      rationale: "Test rationale", evidence: { x: 1 }, detection_key: `test-rec:${campaign.campaign_id}`
    });
    expect(rec.status).toBe("proposed");
    expect(rec.source).toBe("deterministic_rule");
    expect(rec.recommendation_type).toBe("reduce_budget");
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events.some((e) => e.event_type === "action_recommendation_created")).toBe(true);
  });

  it("samme detection_key opprettet på nytt oppdaterer SAMME rad (idempotent), oppretter INGEN duplikat-event", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Rec idempotent" });
    const key = `test-rec-idem:${campaign.campaign_id}`;
    const first = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "investigate",
      rationale: "Første", evidence: { n: 1 }, detection_key: key
    });
    const second = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "investigate",
      rationale: "Oppdatert", evidence: { n: 2 }, detection_key: key
    });
    expect(second.recommendation_id).toBe(first.recommendation_id);
    expect(second.rationale).toBe("Oppdatert");
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events.filter((e) => e.event_type === "action_recommendation_created")).toHaveLength(1);
  });

  it("re-deteksjon av en tidligere 'dismissed' anbefaling gjenåpner den til 'proposed' (resolved_at/resolved_by_person_id nullstilles)", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Rec reopen" });
    const key = `test-rec-reopen:${campaign.campaign_id}`;
    const created = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "investigate",
      rationale: "Første", evidence: {}, detection_key: key
    });
    await service.resolveActionRecommendation(TENANT_A, "business", created.recommendation_id, "dismissed");
    const reopened = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "investigate",
      rationale: "Igjen", evidence: {}, detection_key: key
    });
    expect(reopened.recommendation_id).toBe(created.recommendation_id);
    expect(reopened.status).toBe("proposed");
    expect(reopened.resolved_at).toBeNull();
    expect(reopened.resolved_by_person_id).toBeNull();
  });

  it("re-deteksjon av en fortsatt 'accepted'/'proposed' anbefaling RØRER IKKE status (unngår å prompte eieren på nytt for en allerede erkjent tilstand)", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Rec no-reopen" });
    const key = `test-rec-noreopen:${campaign.campaign_id}`;
    const created = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "investigate",
      rationale: "Første", evidence: {}, detection_key: key
    });
    await service.resolveActionRecommendation(TENANT_A, "business", created.recommendation_id, "accepted", "person-grw-owner");
    const untouched = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "investigate",
      rationale: "Ny deteksjon", evidence: {}, detection_key: key
    });
    expect(untouched.status).toBe("accepted");
    expect(untouched.resolved_by_person_id).toBe("person-grw-owner");
  });

  it("listActionRecommendations filtrerer på campaign_id og status", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Rec list" });
    const other = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Rec list other" });
    const rec = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "reduce_budget",
      rationale: "R1", evidence: {}, detection_key: `test-rec-list:${campaign.campaign_id}`
    });
    await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: other.campaign_id, open_loop_id: null, recommendation_type: "investigate",
      rationale: "R2", evidence: {}, detection_key: `test-rec-list:${other.campaign_id}`
    });
    const forCampaign = await service.listActionRecommendations(TENANT_A, "business", { campaign_id: campaign.campaign_id });
    expect(forCampaign).toHaveLength(1);
    expect(forCampaign[0]!.recommendation_id).toBe(rec.recommendation_id);
    const proposedOnly = await service.listActionRecommendations(TENANT_A, "business", { campaign_id: campaign.campaign_id, status: "proposed" });
    expect(proposedOnly).toHaveLength(1);
    const dismissedOnly = await service.listActionRecommendations(TENANT_A, "business", { campaign_id: campaign.campaign_id, status: "dismissed" });
    expect(dismissedOnly).toHaveLength(0);
  });

  it("resolveActionRecommendation('accepted') setter status/resolved_at/resolved_by_person_id og logger 'action_recommendation_resolved' - REN Jarvis-intern disposisjon, ingen provider-utførelse", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Rec resolve accept" });
    const created = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "reduce_budget",
      rationale: "R", evidence: {}, detection_key: `test-rec-resolve-a:${campaign.campaign_id}`
    });
    const resolved = await service.resolveActionRecommendation(TENANT_A, "business", created.recommendation_id, "accepted", "person-grw-owner");
    expect(resolved?.status).toBe("accepted");
    expect(resolved?.resolved_at).not.toBeNull();
    expect(resolved?.resolved_by_person_id).toBe("person-grw-owner");
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events.some((e) => e.event_type === "action_recommendation_resolved")).toBe(true);
  });

  it("resolveActionRecommendation kaster recommendation_not_proposed ved forsøk på å løse en allerede løst anbefaling", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Rec resolve twice" });
    const created = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "investigate",
      rationale: "R", evidence: {}, detection_key: `test-rec-resolve-twice:${campaign.campaign_id}`
    });
    await service.resolveActionRecommendation(TENANT_A, "business", created.recommendation_id, "dismissed");
    await expect(service.resolveActionRecommendation(TENANT_A, "business", created.recommendation_id, "accepted")).rejects.toThrow(
      "recommendation_not_proposed:dismissed"
    );
  });

  it("resolveActionRecommendation returnerer null for en ikke-eksisterende recommendation_id", async () => {
    const result = await service.resolveActionRecommendation(TENANT_A, "business", "nonexistent-rec", "accepted");
    expect(result).toBeNull();
  });

  it("supersedeStaleActionRecommendations markerer 'proposed'/'accepted' anbefalinger utenfor gjeldende nøkkelsett som 'superseded', rører aldri 'dismissed'/andre prefiks", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Rec supersede" });
    const stale = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "investigate",
      rationale: "Stale", evidence: {}, detection_key: `test-rec-supersede:${campaign.campaign_id}`
    });
    const alreadyDismissed = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "investigate",
      rationale: "Dismissed", evidence: {}, detection_key: `test-rec-supersede-dismissed:${campaign.campaign_id}`
    });
    await service.resolveActionRecommendation(TENANT_A, "business", alreadyDismissed.recommendation_id, "dismissed");
    const otherPrefix = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "investigate",
      rationale: "Annen regel", evidence: {}, detection_key: `unrelated-prefix:${campaign.campaign_id}`
    });

    const supersededCount = await service.supersedeStaleActionRecommendations(TENANT_A, "business", "test-rec-supersede", []);
    expect(supersededCount).toBe(1);

    const staleAfter = await service.listActionRecommendations(TENANT_A, "business", { campaign_id: campaign.campaign_id });
    const staleFound = staleAfter.find((r) => r.recommendation_id === stale.recommendation_id);
    expect(staleFound?.status).toBe("superseded");
    expect(staleFound?.resolved_at).not.toBeNull();
    const dismissedFound = staleAfter.find((r) => r.recommendation_id === alreadyDismissed.recommendation_id);
    expect(dismissedFound?.status).toBe("dismissed"); // urørt - allerede en avsluttet tilstand
    const otherPrefixFound = staleAfter.find((r) => r.recommendation_id === otherPrefix.recommendation_id);
    expect(otherPrefixFound?.status).toBe("proposed"); // urørt - utenfor prefiks-scopet
  });

  it("detectAndRecommendSpendAnomalies genererer 'reduce_budget' for et utgifts-avvik OVER snittet, kobler til søster-open-loopen via detection_key", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Detect over" });
    for (let d = 8; d >= 1; d--) {
      await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, {
        event_date: new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10), spend_amount_ore: 1_000
      });
    }
    await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, {
      event_date: new Date().toISOString().slice(0, 10), spend_amount_ore: 20_000
    });
    await service.setStatus(TENANT_A, "business", campaign.campaign_id, "active");

    const openLoop = await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query(
        `INSERT INTO business_open_loops (open_loop_id, tenant_id, memory_space_id, loop_type, detection_key, reason, campaign_id)
         VALUES ('grw-ol-detect-1', $1, 'business', 'marketing_spend_anomaly', $2, 'Sister loop', $3) RETURNING open_loop_id`,
        [TENANT_A, `marketing_spend_anomaly:${campaign.campaign_id}`, campaign.campaign_id]
      )
    );
    expect(openLoop.rows).toHaveLength(1);

    const result = await service.detectAndRecommendSpendAnomalies(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);

    const recs = await service.listActionRecommendations(TENANT_A, "business", { campaign_id: campaign.campaign_id });
    const rec = recs.find((r) => r.detection_key === `marketing_spend_anomaly:${campaign.campaign_id}`);
    expect(rec?.recommendation_type).toBe("reduce_budget");
    expect(rec?.open_loop_id).toBe("grw-ol-detect-1");
    expect(rec?.source).toBe("deterministic_rule");
  });

  it("detectAndRecommendSpendAnomalies kjørt på nytt (uendret vilkår) oppdaterer SAMME rad ('updated', ikke 'detected')", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Detect updated" });
    for (let d = 8; d >= 1; d--) {
      await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, {
        event_date: new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10), spend_amount_ore: 1_000
      });
    }
    await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, {
      event_date: new Date().toISOString().slice(0, 10), spend_amount_ore: 20_000
    });
    await service.setStatus(TENANT_A, "business", campaign.campaign_id, "active");

    const first = await service.detectAndRecommendSpendAnomalies(TENANT_A, "business");
    expect(first.detected).toBeGreaterThanOrEqual(1);
    const second = await service.detectAndRecommendSpendAnomalies(TENANT_A, "business");
    expect(second.updated).toBeGreaterThanOrEqual(1);
  });

  it("detectAndRecommendSpendAnomalies supersederer en tidligere anbefaling naar avviket ikke lenger detekteres", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Detect resolved" });
    for (let d = 8; d >= 1; d--) {
      await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, {
        event_date: new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10), spend_amount_ore: 1_000
      });
    }
    await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, {
      event_date: new Date().toISOString().slice(0, 10), spend_amount_ore: 20_000
    });
    await service.setStatus(TENANT_A, "business", campaign.campaign_id, "active");
    await service.detectAndRecommendSpendAnomalies(TENANT_A, "business");
    const key = `marketing_spend_anomaly:${campaign.campaign_id}`;
    const before = (await service.listActionRecommendations(TENANT_A, "business", { campaign_id: campaign.campaign_id })).find((r) => r.detection_key === key);
    expect(before?.status).toBe("proposed");

    // Korriger utgiften for i dag tilbake til normalt niva - vilkaaret forsvinner.
    await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, {
      event_date: new Date().toISOString().slice(0, 10), spend_amount_ore: 1_000
    });
    const result = await service.detectAndRecommendSpendAnomalies(TENANT_A, "business");
    expect(result.superseded).toBeGreaterThanOrEqual(1);
    const after = (await service.listActionRecommendations(TENANT_A, "business", { campaign_id: campaign.campaign_id })).find((r) => r.detection_key === key);
    expect(after?.status).toBe("superseded");
  });

  it("TENANT_B kan ALDRI se eller løse en anbefaling opprettet av TENANT_A (RLS)", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Rec isolation" });
    const rec = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "investigate",
      rationale: "Isolert", evidence: {}, detection_key: `test-rec-iso:${campaign.campaign_id}`
    });
    const fromB = await service.listActionRecommendations(TENANT_B, "business", { campaign_id: campaign.campaign_id });
    expect(fromB).toHaveLength(0);
    const resolvedFromB = await service.resolveActionRecommendation(TENANT_B, "business", rec.recommendation_id, "accepted");
    expect(resolvedFromB).toBeNull();
  });
});

describe("P (D-87): provider-nøytral UTFØRELSES-KOMMANDO-modell - generate/cancel/list, INGEN utførelse noensinne", () => {
  async function acceptedReduceBudgetRecommendation(campaignId: string, budgetOre: number, key: string) {
    await service.setBudget(TENANT_A, "business", campaignId, budgetOre);
    const rec = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaignId, open_loop_id: null, recommendation_type: "reduce_budget",
      rationale: "R", evidence: {}, detection_key: key
    });
    return service.resolveActionRecommendation(TENANT_A, "business", rec.recommendation_id, "accepted", "person-grw-owner");
  }

  it("generateExecutionCommand beregner et deterministisk redusert budsjett (default 20%) fra en ALLEREDE godkjent anbefaling, og logger 'execution_command_generated'", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Cmd generate" });
    const accepted = await acceptedReduceBudgetRecommendation(campaign.campaign_id, 100_000, `test-cmd-gen:${campaign.campaign_id}`);
    const command = await service.generateExecutionCommand(TENANT_A, "business", accepted!.recommendation_id, "person-grw-owner");
    expect(command.command_type).toBe("reduce_budget");
    expect(command.current_budget_ore).toBe("100000");
    expect(command.proposed_budget_ore).toBe("80000");
    expect(command.status).toBe("pending_execution");
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events.some((e) => e.event_type === "execution_command_generated")).toBe(true);
  });

  it("generateExecutionCommand aksepterer en eksplisitt reduction_fraction", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Cmd fraction" });
    const accepted = await acceptedReduceBudgetRecommendation(campaign.campaign_id, 100_000, `test-cmd-fraction:${campaign.campaign_id}`);
    const command = await service.generateExecutionCommand(TENANT_A, "business", accepted!.recommendation_id, "person-grw-owner", 0.5);
    expect(command.proposed_budget_ore).toBe("50000");
    expect(command.reduction_fraction).toBe("0.5");
  });

  it("generateExecutionCommand kaster ved ugyldig reduction_fraction (utenfor (0,1))", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Cmd bad fraction" });
    const accepted = await acceptedReduceBudgetRecommendation(campaign.campaign_id, 100_000, `test-cmd-badfrac:${campaign.campaign_id}`);
    await expect(service.generateExecutionCommand(TENANT_A, "business", accepted!.recommendation_id, undefined, 0)).rejects.toThrow(
      "growth_invalid_reduction_fraction"
    );
    await expect(service.generateExecutionCommand(TENANT_A, "business", accepted!.recommendation_id, undefined, 1)).rejects.toThrow(
      "growth_invalid_reduction_fraction"
    );
  });

  it("generateExecutionCommand kaster recommendation_not_accepted for en fortsatt 'proposed' anbefaling", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Cmd not accepted" });
    await service.setBudget(TENANT_A, "business", campaign.campaign_id, 100_000);
    const rec = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "reduce_budget",
      rationale: "R", evidence: {}, detection_key: `test-cmd-notaccepted:${campaign.campaign_id}`
    });
    await expect(service.generateExecutionCommand(TENANT_A, "business", rec.recommendation_id)).rejects.toThrow(
      "recommendation_not_accepted:proposed"
    );
  });

  it("generateExecutionCommand kaster no_command_for_recommendation_type for en akseptert 'investigate'-anbefaling", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Cmd investigate" });
    const rec = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "investigate",
      rationale: "R", evidence: {}, detection_key: `test-cmd-investigate:${campaign.campaign_id}`
    });
    const accepted = await service.resolveActionRecommendation(TENANT_A, "business", rec.recommendation_id, "accepted");
    await expect(service.generateExecutionCommand(TENANT_A, "business", accepted!.recommendation_id)).rejects.toThrow(
      "no_command_for_recommendation_type:investigate"
    );
  });

  it("generateExecutionCommand kaster campaign_has_no_budget_to_reduce naar kampanjen mangler budsjett", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Cmd no budget" });
    const rec = await service.upsertActionRecommendation(TENANT_A, "business", {
      campaign_id: campaign.campaign_id, open_loop_id: null, recommendation_type: "reduce_budget",
      rationale: "R", evidence: {}, detection_key: `test-cmd-nobudget:${campaign.campaign_id}`
    });
    const accepted = await service.resolveActionRecommendation(TENANT_A, "business", rec.recommendation_id, "accepted");
    await expect(service.generateExecutionCommand(TENANT_A, "business", accepted!.recommendation_id)).rejects.toThrow(
      "campaign_has_no_budget_to_reduce"
    );
  });

  it("generateExecutionCommand for SAMME recommendation_id på nytt oppdaterer SAMME rad (idempotent), oppretter INGEN duplikat-event", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Cmd idempotent" });
    const accepted = await acceptedReduceBudgetRecommendation(campaign.campaign_id, 100_000, `test-cmd-idem:${campaign.campaign_id}`);
    const first = await service.generateExecutionCommand(TENANT_A, "business", accepted!.recommendation_id, undefined, 0.2);
    const second = await service.generateExecutionCommand(TENANT_A, "business", accepted!.recommendation_id, undefined, 0.3);
    expect(second.command_id).toBe(first.command_id);
    expect(second.proposed_budget_ore).toBe("70000");
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events.filter((e) => e.event_type === "execution_command_generated")).toHaveLength(1);
  });

  it("cancelExecutionCommand markerer 'cancelled' og logger 'execution_command_cancelled' - kansellering FØR kommandoen (aldri) kunne vaert utført", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Cmd cancel" });
    const accepted = await acceptedReduceBudgetRecommendation(campaign.campaign_id, 100_000, `test-cmd-cancel:${campaign.campaign_id}`);
    const command = await service.generateExecutionCommand(TENANT_A, "business", accepted!.recommendation_id);
    const cancelled = await service.cancelExecutionCommand(TENANT_A, "business", command.command_id, "person-grw-owner", "for høyt risiko akkurat nå");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancelled_at).not.toBeNull();
    expect(cancelled?.cancelled_by_person_id).toBe("person-grw-owner");
    expect(cancelled?.cancellation_reason).toBe("for høyt risiko akkurat nå");
    const events = await service.listEvents(TENANT_A, "business", campaign.campaign_id);
    expect(events.some((e) => e.event_type === "execution_command_cancelled")).toBe(true);
  });

  it("cancelExecutionCommand kaster command_not_pending ved forsøk på å kansellere et allerede kansellert command", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Cmd cancel twice" });
    const accepted = await acceptedReduceBudgetRecommendation(campaign.campaign_id, 100_000, `test-cmd-canceltwice:${campaign.campaign_id}`);
    const command = await service.generateExecutionCommand(TENANT_A, "business", accepted!.recommendation_id);
    await service.cancelExecutionCommand(TENANT_A, "business", command.command_id);
    await expect(service.cancelExecutionCommand(TENANT_A, "business", command.command_id)).rejects.toThrow("command_not_pending:cancelled");
  });

  it("cancelExecutionCommand returnerer null for en ikke-eksisterende command_id", async () => {
    const result = await service.cancelExecutionCommand(TENANT_A, "business", "nonexistent-command");
    expect(result).toBeNull();
  });

  it("listExecutionCommands filtrerer på campaign_id og status", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Cmd list" });
    const other = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Cmd list other" });
    const accepted = await acceptedReduceBudgetRecommendation(campaign.campaign_id, 100_000, `test-cmd-list:${campaign.campaign_id}`);
    const acceptedOther = await acceptedReduceBudgetRecommendation(other.campaign_id, 50_000, `test-cmd-list:${other.campaign_id}`);
    const command = await service.generateExecutionCommand(TENANT_A, "business", accepted!.recommendation_id);
    await service.generateExecutionCommand(TENANT_A, "business", acceptedOther!.recommendation_id);
    const forCampaign = await service.listExecutionCommands(TENANT_A, "business", { campaign_id: campaign.campaign_id });
    expect(forCampaign).toHaveLength(1);
    expect(forCampaign[0]!.command_id).toBe(command.command_id);
    const pendingOnly = await service.listExecutionCommands(TENANT_A, "business", { campaign_id: campaign.campaign_id, status: "pending_execution" });
    expect(pendingOnly).toHaveLength(1);
    const cancelledOnly = await service.listExecutionCommands(TENANT_A, "business", { campaign_id: campaign.campaign_id, status: "cancelled" });
    expect(cancelledOnly).toHaveLength(0);
  });

  it("KRITISK SIKKERHETSINVARIANT: naar den underliggende anbefalingen supersederes (vilkaaret forsvinner), kaskade-kanselleres et 'pending_execution' command AUTOMATISK i SAMME sveip - et command kan ALDRI overleve at sin egen begrunnelse reverseres", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Cmd cascade supersede" });
    for (let d = 8; d >= 1; d--) {
      await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, {
        event_date: new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10), spend_amount_ore: 1_000
      });
    }
    await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, {
      event_date: new Date().toISOString().slice(0, 10), spend_amount_ore: 20_000
    });
    await service.setBudget(TENANT_A, "business", campaign.campaign_id, 500_000);
    await service.setStatus(TENANT_A, "business", campaign.campaign_id, "active");
    await service.detectAndRecommendSpendAnomalies(TENANT_A, "business");
    const detectionKey = `marketing_spend_anomaly:${campaign.campaign_id}`;
    const recBefore = (await service.listActionRecommendations(TENANT_A, "business", { campaign_id: campaign.campaign_id })).find((r) => r.detection_key === detectionKey)!;
    await service.resolveActionRecommendation(TENANT_A, "business", recBefore.recommendation_id, "accepted", "person-grw-owner");
    const command = await service.generateExecutionCommand(TENANT_A, "business", recBefore.recommendation_id);
    expect(command.status).toBe("pending_execution");

    // Korriger utgiften for i dag tilbake til normalt niva - vilkaaret forsvinner, neste sveip supersederer anbefalingen.
    await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, {
      event_date: new Date().toISOString().slice(0, 10), spend_amount_ore: 1_000
    });
    const result = await service.detectAndRecommendSpendAnomalies(TENANT_A, "business");
    expect(result.superseded).toBeGreaterThanOrEqual(1);

    const commandsAfter = await service.listExecutionCommands(TENANT_A, "business", { campaign_id: campaign.campaign_id });
    const commandAfter = commandsAfter.find((c) => c.command_id === command.command_id)!;
    expect(commandAfter.status).toBe("superseded");
  });

  it("TENANT_B kan ALDRI se, generere eller kansellere et command opprettet av TENANT_A (RLS)", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Cmd isolation" });
    const accepted = await acceptedReduceBudgetRecommendation(campaign.campaign_id, 100_000, `test-cmd-iso:${campaign.campaign_id}`);
    const command = await service.generateExecutionCommand(TENANT_A, "business", accepted!.recommendation_id);
    const fromB = await service.listExecutionCommands(TENANT_B, "business", { campaign_id: campaign.campaign_id });
    expect(fromB).toHaveLength(0);
    const cancelledFromB = await service.cancelExecutionCommand(TENANT_B, "business", command.command_id);
    expect(cancelledFromB).toBeNull();
    await expect(service.generateExecutionCommand(TENANT_B, "business", accepted!.recommendation_id)).rejects.toThrow("recommendation_not_found");
  });

  it("STRUKTURELL Finance Integrity-grense: databasens CHECK-constraint gjør 'executed' UMULIG å sette, selv med et direkte UPDATE-forsøk mot kolonnen", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Cmd structural boundary" });
    const accepted = await acceptedReduceBudgetRecommendation(campaign.campaign_id, 100_000, `test-cmd-structural:${campaign.campaign_id}`);
    const command = await service.generateExecutionCommand(TENANT_A, "business", accepted!.recommendation_id);
    await expect(
      withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
        client.query(`UPDATE marketing_campaign_execution_commands SET status = 'executed' WHERE command_id = $1`, [command.command_id])
      )
    ).rejects.toThrow();
  });
});

/** D-88 fixtures: kontakt + møte-aktivitet direkte mot Business Graph, via appPool (RLS-trygg rolle). */
async function insertContact(tenantId: string, id: string): Promise<void> {
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(`INSERT INTO business_contacts (contact_id, tenant_id, memory_space_id, name) VALUES ($1, $2, 'business', 'Kontakt')`, [id, tenantId])
  );
}

async function insertLeadWithContact(tenantId: string, id: string, contactId: string): Promise<void> {
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(
      `INSERT INTO business_leads (lead_id, tenant_id, memory_space_id, contact_id, title) VALUES ($1, $2, 'business', $3, 'Lead')`,
      [id, tenantId, contactId]
    )
  );
}

async function insertOpportunityWithContact(tenantId: string, id: string, contactId: string, stage: string, valueOre: number | null): Promise<void> {
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(
      `INSERT INTO business_opportunities (opportunity_id, tenant_id, memory_space_id, contact_id, title, stage, value_ore) VALUES ($1, $2, 'business', $3, 'Opp', $4, $5)`,
      [id, tenantId, contactId, stage, valueOre]
    )
  );
}

async function insertMeetingActivity(tenantId: string, id: string, contactId: string, occurredAtIso: string): Promise<void> {
  await withMemoryTransaction(appPool, tenantId, ["business"], (client) =>
    client.query(
      `INSERT INTO business_activities (activity_id, tenant_id, memory_space_id, contact_id, activity_type, summary, occurred_at)
       VALUES ($1, $2, 'business', $3, 'meeting', 'Møte', $4)`,
      [id, tenantId, contactId, occurredAtIso]
    )
  );
}

describe("Q (D-88): deterministisk møte-stadium funnel-kobling i campaignPerformance() - ALDRI gjettet", () => {
  it("møte SOM inntreffer ETTER attribusjonstidspunktet telles i attributed_meetings", async () => {
    await insertContact(TENANT_A, "ct-grw-q1");
    await insertLeadWithContact(TENANT_A, "lead-grw-q1", "ct-grw-q1");
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Funnel Q1" });
    await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "lead", entity_id: "lead-grw-q1" });
    await insertMeetingActivity(TENANT_A, "act-grw-q1", "ct-grw-q1", "2030-01-01T10:00:00Z");
    const perf = await service.campaignPerformance(TENANT_A, "business", campaign.campaign_id);
    expect(perf?.attributed_meetings).toBe(1);
  });

  it("møte SOM inntraff FØR attribusjonstidspunktet telles ALDRI - kan umulig være forårsaket av kampanjen (no-guess, fail-closed)", async () => {
    await insertContact(TENANT_A, "ct-grw-q2");
    await insertLeadWithContact(TENANT_A, "lead-grw-q2", "ct-grw-q2");
    await insertMeetingActivity(TENANT_A, "act-grw-q2", "ct-grw-q2", "2020-01-01T10:00:00Z");
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Funnel Q2" });
    await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "lead", entity_id: "lead-grw-q2" });
    const perf = await service.campaignPerformance(TENANT_A, "business", campaign.campaign_id);
    expect(perf?.attributed_meetings).toBe(0);
  });

  it("møte med en kontakt som IKKE er knyttet til noen attribuert lead/opportunity for kampanjen telles ALDRI", async () => {
    await insertContact(TENANT_A, "ct-grw-q3");
    await insertMeetingActivity(TENANT_A, "act-grw-q3", "ct-grw-q3", "2030-01-01T10:00:00Z");
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Funnel Q3 unrelated" });
    const perf = await service.campaignPerformance(TENANT_A, "business", campaign.campaign_id);
    expect(perf?.attributed_meetings).toBe(0);
  });

  it("møte knyttet via en OPPORTUNITY-attribusjon (ikke bare lead) telles også", async () => {
    await insertContact(TENANT_A, "ct-grw-q4");
    await insertOpportunityWithContact(TENANT_A, "opp-grw-q4", "ct-grw-q4", "proposal", 100_000);
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Funnel Q4 opportunity path" });
    await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "opportunity", entity_id: "opp-grw-q4" });
    await insertMeetingActivity(TENANT_A, "act-grw-q4", "ct-grw-q4", "2030-01-01T10:00:00Z");
    const perf = await service.campaignPerformance(TENANT_A, "business", campaign.campaign_id);
    expect(perf?.attributed_meetings).toBe(1);
  });

  it("samme møte nådd via BÅDE en lead- OG en opportunity-attribusjon til SAMME kampanje telles KUN ÉN gang (DISTINCT activity_id på tvers av flere attribusjonsveier)", async () => {
    await insertContact(TENANT_A, "ct-grw-q4b");
    await insertLeadWithContact(TENANT_A, "lead-grw-q4b", "ct-grw-q4b");
    await insertOpportunityWithContact(TENANT_A, "opp-grw-q4b", "ct-grw-q4b", "proposal", 100_000);
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Funnel Q4b dual attribution path" });
    await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "lead", entity_id: "lead-grw-q4b" });
    await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "opportunity", entity_id: "opp-grw-q4b" });
    await insertMeetingActivity(TENANT_A, "act-grw-q4b", "ct-grw-q4b", "2030-01-01T10:00:00Z");
    const perf = await service.campaignPerformance(TENANT_A, "business", campaign.campaign_id);
    expect(perf?.attributed_meetings).toBe(1);
  });

  it("flere møter for samme attribuerte kontakt telles korrekt (DISTINCT activity_id) UTEN å doble attributed_revenue_ore/won_opportunities (rad-fan-out-regresjon)", async () => {
    await insertContact(TENANT_A, "ct-grw-q5");
    await insertOpportunityWithContact(TENANT_A, "opp-grw-q5", "ct-grw-q5", "won", 500_000);
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Funnel Q5 multi-meeting" });
    await service.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, { event_date: "2026-08-01", spend_amount_ore: 50_000 });
    await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "opportunity", entity_id: "opp-grw-q5" });
    await insertMeetingActivity(TENANT_A, "act-grw-q5a", "ct-grw-q5", "2030-01-01T10:00:00Z");
    await insertMeetingActivity(TENANT_A, "act-grw-q5b", "ct-grw-q5", "2030-01-02T10:00:00Z");
    await insertMeetingActivity(TENANT_A, "act-grw-q5c", "ct-grw-q5", "2030-01-03T10:00:00Z");
    const perf = await service.campaignPerformance(TENANT_A, "business", campaign.campaign_id);
    expect(perf?.attributed_meetings).toBe(3);
    expect(perf?.won_opportunities).toBe(1);
    expect(perf?.attributed_revenue_ore).toBe("500000");
    expect(perf?.cac_ore).toBe(50_000 / 1);
  });

  it("en lead/opportunity UTEN contact_id gir 0 attribuerte møter (aldri krasj, aldri gjettet kobling)", async () => {
    await insertLead(TENANT_A, "lead-grw-q6");
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Funnel Q6 no contact" });
    await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "lead", entity_id: "lead-grw-q6" });
    const perf = await service.campaignPerformance(TENANT_A, "business", campaign.campaign_id);
    expect(perf?.attributed_meetings).toBe(0);
  });

  it("en kampanje uten noen attribusjon i det hele tatt gir attributed_meetings=0, ikke null/krasj", async () => {
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Funnel Q7 no attribution" });
    const perf = await service.campaignPerformance(TENANT_A, "business", campaign.campaign_id);
    expect(perf?.attributed_meetings).toBe(0);
  });

  it("TENANT_B sitt møte telles ALDRI mot TENANT_A sin kampanje (tenant-isolasjon)", async () => {
    await insertContact(TENANT_A, "ct-grw-q8a");
    await insertContact(TENANT_B, "ct-grw-q8b");
    await insertLeadWithContact(TENANT_A, "lead-grw-q8", "ct-grw-q8a");
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Funnel Q8 tenant isolation" });
    await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "lead", entity_id: "lead-grw-q8" });
    await insertMeetingActivity(TENANT_B, "act-grw-q8", "ct-grw-q8b", "2030-01-01T10:00:00Z");
    const perf = await service.campaignPerformance(TENANT_A, "business", campaign.campaign_id);
    expect(perf?.attributed_meetings).toBe(0);
  });

  it("gjentatt kall gir samme, stabile resultat (ren lesing, idempotent per definisjon)", async () => {
    await insertContact(TENANT_A, "ct-grw-q9");
    await insertLeadWithContact(TENANT_A, "lead-grw-q9", "ct-grw-q9");
    const campaign = await service.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Funnel Q9 stable repeat" });
    await service.attributeToCampaign(TENANT_A, "business", campaign.campaign_id, { entity_type: "lead", entity_id: "lead-grw-q9" });
    await insertMeetingActivity(TENANT_A, "act-grw-q9", "ct-grw-q9", "2030-01-01T10:00:00Z");
    const first = await service.campaignPerformance(TENANT_A, "business", campaign.campaign_id);
    const second = await service.campaignPerformance(TENANT_A, "business", campaign.campaign_id);
    expect(first?.attributed_meetings).toBe(1);
    expect(second?.attributed_meetings).toBe(first?.attributed_meetings);
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

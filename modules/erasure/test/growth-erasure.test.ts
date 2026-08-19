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
import { BusinessService, OpenLoopService, type BusinessOpenLoop } from "@jarvis/business";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";
// Relativ import (IKKE en ny @jarvis/erasure -> @jarvis/growth
// pakkeavhengighet kun for en testfil) - samme presedens som
// contracts-erasure.test.ts sin import av AgreementsService.
import { GrowthService } from "../../growth/src/service.ts";

/**
 * UA-4 Native Jarvis Growth Core (D-74) Q-20/Q-27: erasure av en kampanje
 * med en LINKET open-loop (`business_open_loops.campaign_id`,
 * 027_growth.sql) - SAMME lærdom/presedens som HOST FIX #1 (D-67) for
 * `ticket_id`/`contract_id`, allerede løst FØRST i selve `plan.ts` denne
 * gangen (ingen separat host-runde nødvendig for dette). Beviser FK-ordren
 * (marketing_attributions/marketing_spend_events/marketing_campaign_events
 * FØR marketing_campaigns, business_open_loops FØR marketing_campaigns) mot
 * en EKTE embedded Postgres via den EKTE `ErasureService.executeErasure()`-APIen.
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let embedding: LocalHashEmbedding;
let sovereignPolicy: PolicyGateway;
let growth: GrowthService;
let openLoops: OpenLoopService;
let business: BusinessService;

const TENANT_A = "tenant-grw-erase-a";

function identityFor(tenantId: string): IdentityContext {
  return {
    person_id: "person-tobias", tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-${tenantId}`, device_id: "dev-grw-erase", channel: "api", auth_strength: "active"
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-grw-erasure-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  // Garantert non-bypass rolle - beviser samtidig at 027-migrasjonens
  // GRANT DELETE faktisk holder for denne EKSAKTE rollekonstruksjonen.
  await adminPool.query("CREATE ROLE jarvis_grw_erasure_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_grw_erasure_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Growth Erasure Test','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-grw-erase-business','${TENANT_A}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_grw_erasure_test", password: "pw2" });
  embedding = new LocalHashEmbedding();
  sovereignPolicy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
  });
  growth = new GrowthService(appPool);
  openLoops = new OpenLoopService(appPool);
  business = new BusinessService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: schema-drevet FK-audit - business_open_loops er DET ENESTE eksterne avhengighetspunktet mot marketing_campaigns", () => {
  it("information_schema viser INGEN andre tabeller med en FK inn mot marketing_campaigns enn business_open_loops (og marketing_*-sine egne)", async () => {
    const { rows } = await adminPool.query(`
      SELECT tc.table_name AS dependent_table, ccu.table_name AS target_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'marketing_campaigns'
    `);
    const known = new Set([
      "business_open_loops", "marketing_spend_events", "marketing_attributions", "marketing_experiments",
      "marketing_campaign_events", "marketing_campaign_tracking_tags"
    ]);
    const unexpected = (rows as Array<{ dependent_table: string }>).filter((r) => !known.has(r.dependent_table));
    expect(unexpected).toHaveLength(0);
    expect((rows as Array<{ dependent_table: string }>).some((r) => r.dependent_table === "business_open_loops")).toBe(true);
  });
});

describe("B/C/D/E: erasure av en kampanje med utgift/attribusjon/eksperiment/LINKET open-loop lykkes, ingen FK-brudd", () => {
  it("executeErasure fjerner kampanje + utgifter + attribusjoner + events + den kampanje-linkede open-loopen", async () => {
    const sentinel = `SentinelGrwErase${randomUUID().replace(/-/g, "")}`;
    const campaign = await growth.createCampaign(TENANT_A, "business", { channel: "google_ads", name: sentinel });
    await growth.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, { event_date: "2026-08-01", spend_amount_ore: 1_000 });
    const experiment = await growth.createExperiment(TENANT_A, "business", { name: "Erasure experiment", campaign_id: campaign.campaign_id });
    // D-82: en registrert sporingstagg må ALDRI overleve en growth-scoped erasure.
    await growth.registerCampaignTrackingTag(TENANT_A, "business", campaign.campaign_id, {
      utm_source: "erasure-test", utm_medium: "email", utm_campaign: sentinel
    });

    // Deterministisk avviks-fixture: 8 dager stabil, siste dag et stort avvik -> marketing_spend_anomaly-loop.
    for (let d = 8; d >= 1; d--) {
      await growth.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, {
        event_date: new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10), spend_amount_ore: 1_000
      });
    }
    await growth.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, {
      event_date: new Date().toISOString().slice(0, 10), spend_amount_ore: 20_000
    });
    await growth.setStatus(TENANT_A, "business", campaign.campaign_id, "active");
    await openLoops.runSweep(TENANT_A, "business");

    const linkedBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "all")).find(
      (l: BusinessOpenLoop) => l.campaign_id === campaign.campaign_id
    );
    expect(linkedBefore).toBeDefined();
    const linkedOpenLoopId = linkedBefore!.open_loop_id;

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-grw-erase-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed"); // Ville rapportert "failed" ved en FK-regresjon.

    // §D: den linkede open-loop-raden er FAKTISK BORTE.
    const linkedGone = await adminPool.query("SELECT 1 FROM business_open_loops WHERE open_loop_id = $1", [linkedOpenLoopId]);
    expect(linkedGone.rowCount).toBe(0);
    const anyLinkedGone = await adminPool.query("SELECT count(*)::int AS n FROM business_open_loops WHERE campaign_id = $1", [campaign.campaign_id]);
    expect((anyLinkedGone.rows[0] as { n: number }).n).toBe(0);

    // §B: selve kampanjen er borte.
    const campaignGone = await growth.getCampaign(TENANT_A, "business", campaign.campaign_id);
    expect(campaignGone).toBeNull();

    // §C: utgifter/eksperiment/events er borte.
    const spendGone = await adminPool.query("SELECT 1 FROM marketing_spend_events WHERE campaign_id = $1", [campaign.campaign_id]);
    expect(spendGone.rowCount).toBe(0);
    const experimentGone = await adminPool.query("SELECT 1 FROM marketing_experiments WHERE experiment_id = $1", [experiment.experiment_id]);
    expect(experimentGone.rowCount).toBe(0);
    const eventsGone = await adminPool.query("SELECT 1 FROM marketing_campaign_events WHERE campaign_id = $1", [campaign.campaign_id]);
    expect(eventsGone.rowCount).toBe(0);
    const trackingTagGone = await adminPool.query("SELECT 1 FROM marketing_campaign_tracking_tags WHERE campaign_id = $1", [campaign.campaign_id]);
    expect(trackingTagGone.rowCount).toBe(0);
  });
});

describe("D (utvidet): ingen dinglende FK-referanse noe sted i tenanten etter erasure", () => {
  it("ingen business_open_loops-rad i tenanten peker til en marketing_campaigns-rad som ikke finnes", async () => {
    const { rows } = await adminPool.query(
      `SELECT count(*)::int AS n FROM business_open_loops bol
       WHERE bol.tenant_id = $1 AND bol.campaign_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM marketing_campaigns c WHERE c.campaign_id = bol.campaign_id)`,
      [TENANT_A]
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});

describe("D-83: en leverandør-synket kampanje (upsertCampaignFromProvider) erases via SAMME eksisterende plan - INGEN ny tabell, INGEN ny erasure-registrering nødvendig", () => {
  it("en kampanje opprettet via upsertCampaignFromProvider (Google Ads-sliceens synk-vei) forsvinner FULLSTENDIG ved en growth-scoped erasure", async () => {
    const sentinel = `SentinelProviderSyncErase${randomUUID().replace(/-/g, "")}`;
    const campaign = await growth.upsertCampaignFromProvider(TENANT_A, "business", { channel: "google_ads", external_campaign_id: `ext-${sentinel}`, name: sentinel, status: "active" });
    expect(campaign.campaign_id).toBeTruthy();

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-grw-erase-provider-sync-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed");

    const gone = await growth.getCampaign(TENANT_A, "business", campaign.campaign_id);
    expect(gone).toBeNull();
    const foundByExternalId = await growth.findCampaignByExternalId(TENANT_A, "business", "google_ads", `ext-${sentinel}`);
    expect(foundByExternalId).toBeNull();
  });
});

describe("E: en erasert kampanje kan ikke gjenoppstaa - en ny kampanje faar en HELT NY campaign_id", () => {
  it("en ny kampanje opprettet etter erasure faar en ny id, aldri en gjenbruk av den slettede", async () => {
    const sentinel = `SentinelNoResurrectGrw${randomUUID().replace(/-/g, "")}`;
    const campaign = await growth.createCampaign(TENANT_A, "business", { channel: "google_ads", name: sentinel });

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const erased = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-grw-erase-resurrect-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(erased.status).toBe("completed");

    const gone = await growth.getCampaign(TENANT_A, "business", campaign.campaign_id);
    expect(gone).toBeNull();

    const fresh = await growth.createCampaign(TENANT_A, "business", { channel: "google_ads", name: sentinel });
    expect(fresh.campaign_id).not.toBe(campaign.campaign_id);
    const freshEvents = await growth.listEvents(TENANT_A, "business", fresh.campaign_id);
    expect(freshEvents).toHaveLength(1); // KUN "campaign_created" - ingen historikk overlevde fra den slettede kampanjen.
  });
});

describe("F/G: urelaterte open-loops og urelatert business-data er UPAAVIRKET av en growth-scoped erasure", () => {
  it("en urelatert (ikke-kampanje-tilknyttet) open-loop og en urelatert followup forblir uendret", async () => {
    const sentinel = `SentinelUnrelatedGrw${randomUUID().replace(/-/g, "")}`;
    const followup = await business.createFollowup(TENANT_A, "business", {
      title: sentinel, due_at: new Date(Date.now() - 3_600_000).toISOString()
    });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const unrelatedBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "all")).find(
      (l: BusinessOpenLoop) => l.followup_id === followup.followup_id
    );
    expect(unrelatedBefore).toBeDefined();
    expect(unrelatedBefore!.campaign_id).toBeNull();

    const campaign = await growth.createCampaign(TENANT_A, "business", { channel: "google_ads", name: `${sentinel}-campaign` });
    for (let d = 8; d >= 1; d--) {
      await growth.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, {
        event_date: new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10), spend_amount_ore: 1_000
      });
    }
    await growth.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, {
      event_date: new Date().toISOString().slice(0, 10), spend_amount_ore: 30_000
    });
    await growth.setStatus(TENANT_A, "business", campaign.campaign_id, "active");
    await openLoops.runSweep(TENANT_A, "business");

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-grw-erase-unrelated-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed");

    // §F: den urelaterte (followup-)loopen finnes FORTSATT, uendret.
    const unrelatedAfter = await openLoops.readOpenLoop(TENANT_A, "business", unrelatedBefore!.open_loop_id);
    expect(unrelatedAfter).not.toBeNull();

    // §G: den urelaterte business_followups-raden er urørt.
    const followupStillThere = await adminPool.query("SELECT 1 FROM business_followups WHERE followup_id = $1", [followup.followup_id]);
    expect(followupStillThere.rowCount).toBe(1);
  });
});

describe("H: idempotens - samme request_id kjørt to ganger paa et growth-scoped erasure gir samme resultat", () => {
  it("andre kjøring er en idempotent replay, ingen dobbel sletting, ingen feil", async () => {
    const campaign = await growth.createCampaign(TENANT_A, "business", { channel: "google_ads", name: "Idempotent grw erasure" });
    await growth.recordSpendEvent(TENANT_A, "business", campaign.campaign_id, { event_date: "2026-08-01", spend_amount_ore: 1_000 });

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const requestId = `req-grw-erase-idem-${randomUUID()}`;
    const scope = { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" } as const;
    const identity = identityFor(TENANT_A);

    const first = await service.executeErasure({ scope, requestId, identity });
    expect(first.status).toBe("completed");
    expect(first.idempotent_replay).toBe(false);

    const second = await service.executeErasure({ scope, requestId, identity });
    expect(second.status).toBe("completed");
    expect(second.idempotent_replay).toBe(true);
    expect(second.record_counts).toEqual(first.record_counts);
  });
});

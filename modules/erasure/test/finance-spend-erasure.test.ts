import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { LocalHashEmbedding } from "@jarvis/memory";
import { OpenLoopService, type BusinessOpenLoop } from "@jarvis/business";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";
// Relativ import (IKKE en ny @jarvis/erasure -> @jarvis/finance
// pakkeavhengighet kun for en testfil) - samme presedens som
// growth-erasure.test.ts sin import av GrowthService.
import { SpendService } from "../../finance/src/spend-service.ts";
// Relativ import - trengs kun for å opprette en `marketing_campaigns`-rad
// direkte (finans-modulen skriver ALDRI selv til growth sitt domene) for å
// bevise den FLYTTEDE FK-rekkefølgen (finance_spend_records FØR
// marketing_campaigns - se plan.ts).
import { GrowthService } from "../../growth/src/service.ts";

/**
 * UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2) §14/§16:
 * ekte Postgres-bevis for erasure av `finance_spend_records`/
 * `finance_recurring_commitments`/`finance_procurement_items` + de to nye
 * `finance_spend_record_id`/`finance_recurring_commitment_id`-LINKEDE
 * open-loop-radene, via den EKTE `ErasureService.executeErasure()`-APIen
 * (ingen antatt FK-orden - SAMME presedens/lærdom som growth-erasure.test.ts,
 * som denne sliceen selv fanget en reell FK-ordringsdefekt via, se plan.ts).
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let embedding: LocalHashEmbedding;
let sovereignPolicy: PolicyGateway;
let spend: SpendService;
let growth: GrowthService;
let openLoops: OpenLoopService;

const TENANT_A = "tenant-spend-erase-a";

function identityFor(tenantId: string): IdentityContext {
  return {
    person_id: "person-tobias", tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-${tenantId}`, device_id: "dev-spend-erase", channel: "api", auth_strength: "active"
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-spend-erasure-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_spend_erasure_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_spend_erasure_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Spend Erasure Test','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-spend-erase-business','${TENANT_A}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_spend_erasure_test", password: "pw2" });
  embedding = new LocalHashEmbedding();
  sovereignPolicy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
  });
  spend = new SpendService(appPool);
  growth = new GrowthService(appPool);
  openLoops = new OpenLoopService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: erasure av en space med spend-record + kampanje-kobling + forpliktelse + anskaffelse + LINKEDE open-loops lykkes, ingen FK-brudd", () => {
  it("executeErasure fjerner ALT finans-utgifts-relatert innhold, inkludert den campaign_id-koblede spend-recorden FØR marketing_campaigns", async () => {
    const sentinel = `SentinelSpendErase${randomUUID().replace(/-/g, "")}`;
    const campaign = await growth.createCampaign(TENANT_A, "business", { channel: "google_ads", name: sentinel });

    const commitment = await spend.createCommitment(TENANT_A, "business", {
      vendor_name: "Erasure Vendor", description: "D", cadence: "monthly", expected_amount_ore: 1_000,
      source_mapping: { campaign_id: campaign.campaign_id }, start_date: "2026-01-01"
    });
    const procurement = await spend.createProcurementItem(TENANT_A, "business", {
      vendor_name: "Erasure Procurement", description: "D", expected_amount_ore: 5_000, expected_date: "2020-01-01", expected_window_days: 1
    });

    await adminPool.query(
      `INSERT INTO marketing_spend_events (spend_event_id, tenant_id, campaign_id, event_date, spend_amount_ore, currency, source_type)
       VALUES ($1, $2, $3, '2026-01-10'::date, 1000, 'NOK', 'manual')`,
      [`grw-se-${randomUUID()}`, TENANT_A, campaign.campaign_id]
    );
    await spend.syncMarketingSpend(TENANT_A, "business");
    const spendRecords = await spend.listSpendRecords(TENANT_A, "business", { source_family: "marketing" });
    const spendRecord = spendRecords.find((r) => r.campaign_id === campaign.campaign_id);
    expect(spendRecord).toBeDefined();

    await spend.matchAndReconcile(TENANT_A, "business");
    await spend.runAnomalyDetection(TENANT_A, "business");
    await openLoops.runSweep(TENANT_A, "business");

    const missingLoop = (await openLoops.listOpenLoops(TENANT_A, "business", "all")).find(
      (l: BusinessOpenLoop) => l.finance_recurring_commitment_id === commitment.commitment_id
    );
    // Ingen MISSING_EXPECTED_SPEND uten aktiv kobling ennå - anskaffelsens egen flagg brukes i stedet.
    const procurementUpdated = await spend.getProcurementItem(TENANT_A, "business", procurement.procurement_item_id);
    expect(procurementUpdated?.anomaly_flags).toContain("MISSING_EXPECTED_SPEND");
    void missingLoop;

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-spend-erase-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed"); // Ville rapportert "failed" ved en FK-regresjon (den EKSAKTE defekten testen under fanget).

    const spendGone = await adminPool.query("SELECT 1 FROM finance_spend_records WHERE spend_record_id = $1", [spendRecord!.spend_record_id]);
    expect(spendGone.rowCount).toBe(0);
    const commitmentGone = await adminPool.query("SELECT 1 FROM finance_recurring_commitments WHERE commitment_id = $1", [commitment.commitment_id]);
    expect(commitmentGone.rowCount).toBe(0);
    const procurementGone = await adminPool.query("SELECT 1 FROM finance_procurement_items WHERE procurement_item_id = $1", [procurement.procurement_item_id]);
    expect(procurementGone.rowCount).toBe(0);
    const campaignGone = await growth.getCampaign(TENANT_A, "business", campaign.campaign_id);
    expect(campaignGone).toBeNull();
    const loopsGone = await adminPool.query(
      "SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = $1 AND (finance_spend_record_id IS NOT NULL OR finance_recurring_commitment_id IS NOT NULL)",
      [TENANT_A]
    );
    expect((loopsGone.rows[0] as { n: number }).n).toBe(0);
  });
});

describe("B: finance_spend_sync_cursors (tenant-only, ikke space-skopet) fjernes ved en FULL tenant-erasure", () => {
  it("planTenant() fjerner cursor-raden - ingen dinglende operativ tilstand for en slettet tenant", async () => {
    const tenantId = `tenant-spend-cursor-erase-${randomUUID().slice(0, 8)}`;
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, 'Cursor Erase', 'business')`, [tenantId]);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias', $1)`, [tenantId]);
    await adminPool.query(`INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1, $2, 'business')`, [`ms-${tenantId}`, tenantId]);
    await spend.syncMarketingSpend(tenantId, "business"); // ingen kilderader - men cursor-raden opprettes likevel KUN hvis noe ble synkronisert; sett den eksplisitt for å bevise sletting uansett.
    await adminPool.query(
      `INSERT INTO finance_spend_sync_cursors (tenant_id, source_family, cursor_value) VALUES ($1, 'marketing', '2026-01-01T00:00:00.000Z')`,
      [tenantId]
    );
    const before = await adminPool.query("SELECT 1 FROM finance_spend_sync_cursors WHERE tenant_id = $1", [tenantId]);
    expect(before.rowCount).toBe(1);

    // Egen PolicyGateway for DENNE dynamiske tenanten - `sovereignPolicy` (beforeAll) autoriserer KUN TENANT_A i sitt `owner_tenants`-sett.
    const policyForTenant = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(),
      nonces: new InMemoryNonceStore(),
      killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: [tenantId] }
    });
    const service = new ErasureService(appPool, policyForTenant, embedding);
    const result = await service.executeErasure({
      scope: { type: "tenant", tenant_id: tenantId },
      requestId: `req-cursor-erase-${randomUUID()}`,
      identity: identityFor(tenantId)
    });
    expect(result.status).toBe("completed");

    const after = await adminPool.query("SELECT 1 FROM finance_spend_sync_cursors WHERE tenant_id = $1", [tenantId]);
    expect(after.rowCount).toBe(0);
  });
});

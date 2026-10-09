import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding } from "@jarvis/memory";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";
// Relative importer (ikke en ny @jarvis/erasure -> @jarvis/finance pakkeavhengighet kun for en testfil) - samme presedens som finance-spend-erasure.test.ts.
import { FinanceService } from "../../finance/src/service.ts";
import { FinanceReconciliationService } from "../../finance/src/reconciliation.ts";

/**
 * WP-F1 (D-462, migrasjon 100): avstemmingsfunn har FK -> payment_intents OG -> finance_reconciliation_runs. Erasure av en space med funn, kjøringer og intensjoner
 * MÅ lykkes uten FK-brudd (funn FØR både kjøringer og intensjoner), og alt avstemmings-innhold er borte etterpå. Den EKTE `ErasureService.executeErasure()`-APIen.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;
const TENANT = "tenant-wpf1-rec-erase";
const OTHER = "tenant-wpf1-rec-erase-other";

const identity = (tenant: string): IdentityContext => ({
  person_id: "person-tobias", tenant_id: tenant, memory_space_id: "business", session_id: `sess-${tenant}`, device_id: "dev-wpf1-erase", channel: "api", auth_strength: "active"
});

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpf1-rec-erase-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpf1_rec_erase LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpf1_rec_erase");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'Rec erase', 'business'), ('${OTHER}', 'Rec erase other', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias', 'Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias', '${TENANT}'), ('person-tobias', '${OTHER}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-wpf1-rec-erase', '${TENANT}', 'business'), ('ms-wpf1-rec-erase-o', '${OTHER}', 'business');
  `);
  appPool = createPool({ ...base, user: "jarvis_wpf1_rec_erase", password: "pw2" });
  policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT, OTHER] }
  });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

async function seed(tenant: string): Promise<string> {
  const finance = new FinanceService(appPool);
  const id = (await finance.createPaymentIntent(tenant, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "Erasure", amount_ore: 10_000, vendor_name: "Lev AS", account_code: "kategori", provider: "stripe"
  } as never)).payment_intent_id;
  await adminPool.query("UPDATE payment_intents SET state = 'provider_acknowledged', provider_ref = 'pi_e', provider_reported_amount_ore = 1, provider_reported_currency = 'NOK' WHERE payment_intent_id = $1", [id]);
  await new FinanceReconciliationService(appPool).reconcileFinance(tenant);
  return id;
}
const count = async (table: string, tenant: string) => ((await adminPool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenant])).rows[0] as { n: number }).n;

describe("erasure av avstemmingsfunn, kjøringer og intensjoner", () => {
  it("memory_space-erasure lykkes (funn FØR kjøringer og intensjoner), sletter alt for scopet og rører ikke en annen tenant", async () => {
    await seed(TENANT);
    await seed(OTHER);
    expect(await count("finance_reconciliation_findings", TENANT)).toBeGreaterThan(0);
    expect(await count("finance_reconciliation_runs", TENANT)).toBeGreaterThan(0);

    const service = new ErasureService(appPool, policy, new LocalHashEmbedding());
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT, memory_space_id: "business" }, requestId: `req-wpf1-rec-erase-${randomUUID()}`, identity: identity(TENANT)
    });
    expect(result.status).toBe("completed"); // ville vært «failed» ved en FK-regresjon

    for (const table of ["finance_reconciliation_findings", "finance_reconciliation_runs", "payment_intents"]) expect(await count(table, TENANT), table).toBe(0);
    expect(await count("finance_reconciliation_findings", OTHER)).toBeGreaterThan(0); // en annen tenant er urørt
    expect(await count("finance_reconciliation_runs", OTHER)).toBeGreaterThan(0);
    expect(await count("payment_intents", OTHER)).toBeGreaterThan(0);
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { firstWaveTools } from "@jarvis/tool-gateway";
import { CardService } from "../src/card-service.ts";

/**
 * WP-FIN2 K10 (D-486): ordren ber om BEVIS for at zod fanger `Number(...)` på pengeparametre i `wallester-tool-transport.ts` (`update_spend_policy`, linje ~78-81) og `spend-transport.ts` (~30-33). Beviset ble
 * ført, og det er DELVIS: spend-verktøyenes skjema er `z.number().int().positive()` (fanget), men Wallester-kortets grenser (`create_card`/`update_spend_policy`) er `z.number()` - fraksjoner, 0, negative tall og Infinity passerer
 * zod. Bunnlinjen er databasen: `bigint`-kolonnene og `CHECK (... > 0)` avviser dem FØR noe sendes til Wallester (fail-closed, men som rå DB-feil). Strammere skjema (`.int().positive()`) er DEFERRED (delt kode i
 * `integrations.ts`; Q-forslag i rapporten). Denne testen låser både funnet og bunnlinjen, så en senere stramming bevisst må endre den.
 */
const SPEND_AMOUNT_FIELD = "expected_amount_ore";
const toolSchema = (toolId: string, action: string) => {
  const tool = firstWaveTools().find((t) => t.tool_id === toolId && t.action === action);
  if (!tool) throw new Error(`tool_not_found:${toolId}.${action}`);
  return tool.input_schema;
};
const BAD_NUMBERS: ReadonlyArray<[string, unknown]> = [["fraksjon", 1.5], ["null", 0], ["negativt", -5], ["streng", "100"], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY]];

describe("zod-skjemaene for pengeparametre (hva som faktisk fanges FØR Number(...) i transporten)", () => {
  const spendBase = { tenant_id: "t", vendor_name: "V", description: "D", cadence: "monthly", start_date: "2026-01-01" };

  it("finance_spend.create_recurring_commitment: expected_amount_ore er .int().positive() - fraksjon/0/negativt/streng/NaN/Infinity avvises", () => {
    const schema = toolSchema("finance_spend", "create_recurring_commitment");
    expect(schema.safeParse({ ...spendBase, [SPEND_AMOUNT_FIELD]: 12_345 }).success).toBe(true);
    for (const [label, value] of BAD_NUMBERS) expect(schema.safeParse({ ...spendBase, [SPEND_AMOUNT_FIELD]: value }).success, label).toBe(false);
  });

  it("finance_wallester.create_card / update_spend_policy: grensene er KUN z.number() - fraksjon, 0, negativt og Infinity PASSERER zod (funnet); streng/NaN avvises", () => {
    const create = toolSchema("finance_wallester", "create_card");
    const update = toolSchema("finance_wallester", "update_spend_policy");
    const createBase = { tenant_id: "t", idempotency_key: "k", name: "n", purpose: "p", card_type: "virtual" };
    const updateBase = { tenant_id: "t", card_id: "c" };
    for (const [label, value] of BAD_NUMBERS) {
      const passes = ["fraksjon", "null", "negativt", "Infinity"].includes(label);
      expect(create.safeParse({ ...createBase, daily_limit_ore: value }).success, `create_card ${label}`).toBe(passes);
      expect(update.safeParse({ ...updateBase, daily_limit_ore: value }).success, `update_spend_policy ${label}`).toBe(passes);
    }
  });
});

describe("bunnlinjen: databasen avviser ugyldige kortgrenser FØR noe sendes til Wallester", () => {
  let stop: (() => Promise<void>) | undefined;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  const TENANT = "tenant-fin2-k10";

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fin2-k10-"));
    const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
    stop = leased.stop;
    await leased.postgres.createDatabase("jarvis_test");
    const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
    adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
    adminPool.on("error", () => undefined);
    await runMigrations(adminPool);
    await adminPool.query("CREATE ROLE jarvis_fin2_k10 LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
    await adminPool.query("GRANT jarvis_app TO jarvis_fin2_k10");
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'K10', 'business')`);
    appPool = createPool({ ...base, user: "jarvis_fin2_k10", password: "pw2" });
  }, 240_000);
  afterAll(async () => { await appPool?.end(); await adminPool?.end(); await stop?.(); }, 120_000);

  it("createCard med fraksjon / 0 / negativ grense avvises (ingen rad igjen); gyldig grense lagres", async () => {
    const cards = new CardService(appPool);
    const make = (key: string, limit: number) => cards.createCard(TENANT, "business", { idempotency_key: key, name: "K", purpose: "P", card_type: "virtual", currency: "EUR", requested_daily_limit_ore: limit });
    for (const [label, value] of [["fraksjon", 1.5], ["null", 0], ["negativt", -5]] as const) {
      await expect(make(`k10-${label}`, value), label).rejects.toThrow();
      const left = await adminPool.query("SELECT 1 FROM provider_cards WHERE tenant_id = $1 AND idempotency_key = $2", [TENANT, `k10-${label}`]);
      expect(left.rowCount, `${label}: ingen kortrad står igjen`).toBe(0);
    }
    const ok = await make("k10-ok", 5_000);
    expect(ok.card_id).toBeTruthy();
  });
});

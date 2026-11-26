import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { FinanceService, IdempotencyKeyConflictError, type PaymentIntent } from "../src/index.ts";

/**
 * WP-FIN2 K4 (D-486, JARVIS-072-resten): barn-idempotens. `createStripeRefund`, `createVippsCapture` og `createVippsRefund` returnerte stille en eksisterende rad for
 * `(tenant, idempotency_key)` uten å sammenligne noe (heller ikke i `ON CONFLICT`-banen), også når nøkkelen tilhørte en annen betaling. Samme regel som `createPaymentIntent`:
 * lik forespørsel = samme rad; ulik intensjon/beløp/valuta/`reason` = `IdempotencyKeyConflictError` som lister FELT, aldri verdier. Mot ekte Postgres, begge baner.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-fin2-childidem";
const APP_ROLE = "jarvis_fin2_childidem";
let svc: FinanceService;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fin2-childidem-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS`);
  await adminPool.query(`GRANT jarvis_app TO ${APP_ROLE}`);
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'FIN2 child idempotency', 'business')`);
  appPool = createPool({ ...base, user: APP_ROLE, password: "pw2" });
  svc = new FinanceService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

async function intentFor(provider: "stripe" | "vipps", kind: "settled" | "authorized", currency = "NOK", amountOre = 100_000): Promise<PaymentIntent> {
  const intent = await svc.createPaymentIntent(TENANT, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "FIN2 barn-idempotens", amount_ore: amountOre, currency, vendor_name: `Kunde ${randomUUID().slice(0, 6)}`, account_code: "kategori", provider
  });
  const state = kind === "settled" ? "settled" : "provider_acknowledged";
  await adminPool.query(
    `UPDATE payment_intents SET state = $2, provider_ref = $3, provider_status = $4, provider_status_updated_at = now() - interval '1 hour'${kind === "settled" ? ", settled_at = now()" : ""} WHERE payment_intent_id = $1`,
    [intent.payment_intent_id, state, provider === "vipps" ? intent.payment_intent_id : `pi_${randomUUID().slice(0, 8)}`, provider === "vipps" ? "AUTHORIZED" : "succeeded"]
  );
  return intent;
}

type Kind = "stripe_refund" | "vipps_capture" | "vipps_refund";
interface Case {
  readonly kind: Kind;
  readonly table: string;
  readonly idColumn: string;
  /** Intensjonen barnet hører til. */
  readonly parent: (currency?: string) => Promise<PaymentIntent>;
  readonly create: (input: { key: string; intentId: string; amountOre: number; reason?: string }) => Promise<{ id: string; amount_ore: number | string; payment_intent_id: string }>;
}

const CASES: readonly Case[] = [
  {
    kind: "stripe_refund", table: "stripe_refunds", idColumn: "refund_id",
    parent: (currency) => intentFor("stripe", "settled", currency),
    create: async (i) => {
      const row = await svc.createStripeRefund(TENANT, "business", { idempotency_key: i.key, payment_intent_id: i.intentId, amount_ore: i.amountOre, ...(i.reason !== undefined ? { reason: i.reason as never } : {}) });
      return { id: row.refund_id, amount_ore: row.amount_ore, payment_intent_id: row.payment_intent_id };
    }
  },
  {
    kind: "vipps_capture", table: "vipps_captures", idColumn: "capture_id",
    parent: (currency) => intentFor("vipps", "authorized", currency),
    create: async (i) => {
      const row = await svc.createVippsCapture(TENANT, "business", { idempotency_key: i.key, payment_intent_id: i.intentId, amount_ore: i.amountOre });
      return { id: row.capture_id, amount_ore: row.amount_ore, payment_intent_id: row.payment_intent_id };
    }
  },
  {
    kind: "vipps_refund", table: "vipps_refunds", idColumn: "refund_id",
    parent: (currency) => intentFor("vipps", "settled", currency),
    create: async (i) => {
      const row = await svc.createVippsRefund(TENANT, "business", { idempotency_key: i.key, payment_intent_id: i.intentId, amount_ore: i.amountOre });
      return { id: row.refund_id, amount_ore: row.amount_ore, payment_intent_id: row.payment_intent_id };
    }
  }
];

const count = async (table: string, key: string) => Number((await adminPool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND idempotency_key = $2`, [TENANT, key])).rows[0]!["n"]);
const conflict = (err: unknown): IdempotencyKeyConflictError => {
  expect(err).toBeInstanceOf(IdempotencyKeyConflictError);
  return err as IdempotencyKeyConflictError;
};

/** Venter til en app-forbindelse faktisk står og venter på en lås (ligger fast i `INSERT` mot unik-indeksen). */
async function waitForAppLockWait(ms = 8_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const { rows } = await adminPool.query("SELECT 1 FROM pg_stat_activity WHERE usename = $1 AND wait_event_type = 'Lock' LIMIT 1", [APP_ROLE]);
    if (rows.length > 0) return;
    if (Date.now() - t0 > ms) throw new Error("app_connection_never_waited_on_lock");
    await new Promise((r) => setTimeout(r, 15));
  }
}

for (const c of CASES) {
  describe(`K4 ${c.kind}: samme nøkkel + lik forespørsel = samme rad; ulik forespørsel = konflikt (felt, aldri verdier)`, () => {
    it("lik forespørsel gjentatt (SELECT-banen): samme rad, ingen duplikat", async () => {
      const parent = await c.parent();
      const key = `fin2-${c.kind}-${randomUUID()}`;
      const first = await c.create({ key, intentId: parent.payment_intent_id, amountOre: 7_777 });
      const second = await c.create({ key, intentId: parent.payment_intent_id, amountOre: 7_777 });
      expect(second.id).toBe(first.id);
      expect(await count(c.table, key)).toBe(1);
    });

    it("ulikt beløp: IdempotencyKeyConflictError med feltet `amount_ore` - ingen beløp i meldingen - og ingen ny rad", async () => {
      const parent = await c.parent();
      const key = `fin2-${c.kind}-${randomUUID()}`;
      const first = await c.create({ key, intentId: parent.payment_intent_id, amountOre: 7_777 });
      const err = conflict(await c.create({ key, intentId: parent.payment_intent_id, amountOre: 3_333 }).catch((e: unknown) => e));
      expect(err.mismatchedFields).toEqual(["amount_ore"]);
      expect(err.message).toBe(`idempotency_key_conflict:${key}:amount_ore`);
      expect(await count(c.table, key)).toBe(1);
      expect(Number((await adminPool.query(`SELECT amount_ore FROM ${c.table} WHERE ${c.idColumn} = $1`, [first.id])).rows[0]!["amount_ore"])).toBe(7_777);
    });

    it("annen intensjon: konflikt på `payment_intent_id` (aldri stille retur av en refusjon/capture som tilhører en annen betaling)", async () => {
      const a = await c.parent();
      const b = await c.parent();
      const key = `fin2-${c.kind}-${randomUUID()}`;
      const first = await c.create({ key, intentId: a.payment_intent_id, amountOre: 5_000 });
      const err = conflict(await c.create({ key, intentId: b.payment_intent_id, amountOre: 5_000 }).catch((e: unknown) => e));
      expect(err.mismatchedFields).toEqual(["payment_intent_id"]);
      expect(err.message).not.toContain(a.payment_intent_id);
      expect(err.message).not.toContain(b.payment_intent_id);
      expect(await count(c.table, key)).toBe(1);
      expect((await adminPool.query(`SELECT payment_intent_id FROM ${c.table} WHERE ${c.idColumn} = $1`, [first.id])).rows[0]!["payment_intent_id"]).toBe(a.payment_intent_id);
    });

    it("annen intensjon i annen valuta: både `payment_intent_id` og `currency` listes", async () => {
      const a = await c.parent("NOK");
      const b = await c.parent("EUR");
      const key = `fin2-${c.kind}-${randomUUID()}`;
      await c.create({ key, intentId: a.payment_intent_id, amountOre: 5_000 });
      const err = conflict(await c.create({ key, intentId: b.payment_intent_id, amountOre: 5_000 }).catch((e: unknown) => e));
      expect(err.mismatchedFields).toEqual(["payment_intent_id", "currency"]);
    });

    it("ON CONFLICT-banen: nøkkelen tas av et samtidig kall (annen intensjon) MENS dette kallet står i INSERT - konflikt, ikke stille retur", async () => {
      const a = await c.parent();
      const b = await c.parent();
      const key = `fin2-${c.kind}-${randomUUID()}`;
      // En åpen, ucommittet transaksjon har nøkkelen (som en samtidig `createX` for intensjon A): vårt kall for B ser ingenting i SELECT, og INSERT blir stående på unik-indeksen.
      const holder = await adminPool.connect();
      try {
        await holder.query("BEGIN");
        const extra = c.kind === "stripe_refund" ? ", reason" : "";
        const extraValue = c.kind === "stripe_refund" ? ", NULL" : "";
        await holder.query(
          `INSERT INTO ${c.table} (${c.idColumn}, tenant_id, memory_space_id, payment_intent_id, idempotency_key, amount_ore, currency${extra}) VALUES ($1, $2, 'business', $3, $4, 5000, $5${extraValue})`,
          [`fin2-held-${randomUUID()}`, TENANT, a.payment_intent_id, key, a.currency]
        );
        const pending = c.create({ key, intentId: b.payment_intent_id, amountOre: 5_000 }).catch((e: unknown) => e);
        await waitForAppLockWait();
        await holder.query("COMMIT");
        const err = conflict(await pending);
        expect(err.mismatchedFields).toEqual(["payment_intent_id"]);
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }
      expect(await count(c.table, key)).toBe(1);
    });

    it("ON CONFLICT-banen med lik forespørsel for samme intensjon (to samtidige kall): ÉN rad, begge får samme id", async () => {
      const parent = await c.parent();
      const key = `fin2-${c.kind}-${randomUUID()}`;
      const results = await Promise.all([1, 2, 3, 4].map(() => c.create({ key, intentId: parent.payment_intent_id, amountOre: 4_000 })));
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(await count(c.table, key)).toBe(1);
    });

    it("to samtidige kall med samme nøkkel men ulikt beløp: nøyaktig ÉN vinner, den andre får konflikt - raden har vinnerens beløp", async () => {
      const parent = await c.parent();
      const key = `fin2-${c.kind}-${randomUUID()}`;
      const settled = await Promise.allSettled([
        c.create({ key, intentId: parent.payment_intent_id, amountOre: 1_111 }),
        c.create({ key, intentId: parent.payment_intent_id, amountOre: 2_222 })
      ]);
      const ok = settled.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<Case["create"]>>> => r.status === "fulfilled");
      const failed = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(conflict(failed[0]!.reason).mismatchedFields).toEqual(["amount_ore"]);
      expect(Number(ok[0]!.value.amount_ore)).toBe(Number((await adminPool.query(`SELECT amount_ore FROM ${c.table} WHERE tenant_id = $1 AND idempotency_key = $2`, [TENANT, key])).rows[0]!["amount_ore"]));
      expect(await count(c.table, key)).toBe(1);
    });
  });
}

describe("K4 stripe_refund: `reason` er en del av identiteten", () => {
  it("ulik `reason` (inkl. satt vs. ikke satt) gir konflikt på `reason`; lik `reason` returnerer samme rad", async () => {
    const parent = await intentFor("stripe", "settled");
    const key = `fin2-reason-${randomUUID()}`;
    const first = await CASES[0]!.create({ key, intentId: parent.payment_intent_id, amountOre: 1_000, reason: "requested_by_customer" });
    expect((await CASES[0]!.create({ key, intentId: parent.payment_intent_id, amountOre: 1_000, reason: "requested_by_customer" })).id).toBe(first.id);
    expect(conflict(await CASES[0]!.create({ key, intentId: parent.payment_intent_id, amountOre: 1_000, reason: "duplicate" }).catch((e: unknown) => e)).mismatchedFields).toEqual(["reason"]);
    expect(conflict(await CASES[0]!.create({ key, intentId: parent.payment_intent_id, amountOre: 1_000 }).catch((e: unknown) => e)).mismatchedFields).toEqual(["reason"]);
    const key2 = `fin2-reason-${randomUUID()}`;
    await CASES[0]!.create({ key: key2, intentId: parent.payment_intent_id, amountOre: 1_000 }); // ingen reason
    expect(conflict(await CASES[0]!.create({ key: key2, intentId: parent.payment_intent_id, amountOre: 1_000, reason: "duplicate" }).catch((e: unknown) => e)).mismatchedFields).toEqual(["reason"]);
  });
});

describe("K4: tenant-isolasjon og forrang", () => {
  it("samme nøkkel i en ANNEN tenant er en annen nøkkel (ingen konflikt, ingen lekkasje)", async () => {
    const other = "tenant-fin2-childidem-b";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${other}', 'FIN2 child idempotency B', 'business') ON CONFLICT DO NOTHING`);
    const key = `fin2-iso-${randomUUID()}`;
    const a = await intentFor("stripe", "settled");
    await CASES[0]!.create({ key, intentId: a.payment_intent_id, amountOre: 1_000 });
    const intentB = await svc.createPaymentIntent(other, "business", { idempotency_key: `idem-${randomUUID()}`, purpose: "B", amount_ore: 100_000, vendor_name: "B", account_code: "kategori", provider: "stripe" });
    await adminPool.query("UPDATE payment_intents SET state = 'settled', provider_ref = 'pi_other', provider_status = 'succeeded', settled_at = now() WHERE payment_intent_id = $1", [intentB.payment_intent_id]);
    const row = await svc.createStripeRefund(other, "business", { idempotency_key: key, payment_intent_id: intentB.payment_intent_id, amount_ore: 2_000 });
    expect(row.tenant_id).toBe(other);
    expect(Number(row.amount_ore)).toBe(2_000);
  });

  it("ugyldig beløp avvises som før (InvalidAmountError), uavhengig av nøkkelen", async () => {
    const parent = await intentFor("stripe", "settled");
    await expect(CASES[0]!.create({ key: `fin2-bad-${randomUUID()}`, intentId: parent.payment_intent_id, amountOre: 0 })).rejects.toThrow(/invalid_amount_ore/);
  });
});

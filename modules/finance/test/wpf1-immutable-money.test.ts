import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { withMemoryTransaction } from "@jarvis/memory";
import { FinanceService, maskReference, recipientDigest } from "../src/index.ts";

/**
 * WP-F1 (D-462): pengekolonnene på intensjon/refusjon/capture er uforanderlige på DATABASENIVÅ (migrasjon 101). Eierens step-up-godkjenning er bundet til intensjonens id
 * og til beløp + valuta + mottaker-digest; bindingen er bare meningsfull hvis raden ikke kan endres mellom forespørsel og godkjenning. Beviser at ingen rolle (appens egen,
 * superbruker) kan endre en beskyttet kolonne, at all legitim skriving fortsatt virker, og at triggerlistene faktisk peker på eksisterende kolonner (ingen stille skrivefeil).
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-wpf1-immut";
let finance: FinanceService;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpf1-immut-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpf1_immut LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpf1_immut");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'WPF1 immut', 'business')`);
  appPool = createPool({ ...base, user: "jarvis_wpf1_immut", password: "pw2" });
  finance = new FinanceService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

const asApp = (text: string, params: unknown[] = []) => withMemoryTransaction(appPool, TENANT, ["business"], (client) => client.query(text, params));

async function makeIntent(over: Record<string, unknown> = {}): Promise<string> {
  return (await finance.createPaymentIntent(TENANT, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "Immutabel", amount_ore: 10_000, vendor_name: `Lev ${randomUUID().slice(0, 6)}`, account_code: "kategori", provider: "stripe", ...over
  } as never)).payment_intent_id;
}

describe("A: betalingsintensjon - beskyttede kolonner kan ikke endres av noen", () => {
  const protectedUpdates: Array<[string, string, unknown[]]> = [
    ["amount_ore", "amount_ore = amount_ore + 1", []],
    ["currency", "currency = 'EUR'", []],
    ["provider", "provider = 'vipps'", []],
    ["purpose", "purpose = 'omskrevet'", []],
    ["vendor_name", "vendor_name = 'Annen AS'", []],
    ["vendor_provider_ref", "vendor_provider_ref = '99999999999'", []], // NULL -> verdi er også blokkert (mottaker kan ikke settes etter at eieren så intensjonen)
    ["account_code", "account_code = 'annen'", []],
    ["counter_account_code", "counter_account_code = '1920'", []],
    ["idempotency_key", "idempotency_key = 'ny-nokkel'", []],
    ["tenant_id", "tenant_id = 'tenant-x'", []],
    ["payment_intent_id", "payment_intent_id = 'fin-pi-ny'", []]
  ];

  for (const [column, setClause] of protectedUpdates) {
    it(`${column}: appens egen rolle OG superbrukeren avvises med check_violation (23514)`, async () => {
      const id = await makeIntent();
      await expect(asApp(`UPDATE payment_intents SET ${setClause} WHERE payment_intent_id = $1`, [id])).rejects.toMatchObject({ code: "23514", message: expect.stringContaining(`finance_money_column_immutable:payment_intents.${column}`) });
      await expect(adminPool.query(`UPDATE payment_intents SET ${setClause} WHERE payment_intent_id = $1`, [id])).rejects.toMatchObject({ code: "23514" });
      const row = (await adminPool.query("SELECT amount_ore, currency, provider FROM payment_intents WHERE payment_intent_id = $1", [id])).rows[0] as Record<string, unknown>;
      expect(row).toEqual({ amount_ore: "10000", currency: "NOK", provider: "stripe" });
    });
  }

  it("all legitim skriving virker fortsatt: tilstand, leverandørfelt, avviksflagg, tidsstempler, og en UPDATE som setter samme verdi igjen", async () => {
    const id = await makeIntent();
    await asApp(`UPDATE payment_intents SET state = 'submitted', submitted_at = now(), first_submit_attempt_at = now(), updated_at = now() WHERE payment_intent_id = $1`, [id]);
    await asApp(`UPDATE payment_intents SET state = 'provider_acknowledged', provider_ref = 'pi_ok', provider_status = 'requires_payment_method', provider_reported_amount_ore = 10000, provider_reported_currency = 'NOK', anomaly_flags = '["RECONCILE_X"]'::jsonb WHERE payment_intent_id = $1`, [id]);
    await asApp(`UPDATE payment_intents SET reconciliation_state = 'matched', amount_ore = amount_ore, currency = currency WHERE payment_intent_id = $1`, [id]);
    const row = (await adminPool.query("SELECT state, provider_ref, reconciliation_state FROM payment_intents WHERE payment_intent_id = $1", [id])).rows[0];
    expect(row).toEqual({ state: "provider_acknowledged", provider_ref: "pi_ok", reconciliation_state: "matched" });
  });

  it("DELETE (sletting/erasure) påvirkes ikke - kun UPDATE av pengekolonner er låst", async () => {
    const id = await makeIntent();
    await adminPool.query("DELETE FROM payment_intent_events WHERE payment_intent_id = $1", [id]);
    await expect(adminPool.query("DELETE FROM payment_intents WHERE payment_intent_id = $1", [id])).resolves.toBeDefined();
  });
});

describe("B: refusjon/capture - beløp, valuta og foreldrebetaling er låst", () => {
  it("stripe_refunds / vipps_captures / vipps_refunds: amount_ore, currency, payment_intent_id, idempotency_key avvises; state og provider_ref virker", async () => {
    const parent = await makeIntent();
    const other = await makeIntent();
    const ins = async (table: string, idCol: string, extraCols = "", extraVals = ""): Promise<string> => {
      const id = `fin-x-${randomUUID()}`;
      await adminPool.query(`INSERT INTO ${table} (${idCol}, tenant_id, payment_intent_id, idempotency_key, state, amount_ore, currency${extraCols}) VALUES ($1, $2, $3, $4, 'draft', 5000, 'NOK'${extraVals})`, [id, TENANT, parent, `k-${randomUUID()}`]);
      return id;
    };
    const cases: Array<[string, string, string]> = [
      ["stripe_refunds", "refund_id", await ins("stripe_refunds", "refund_id")],
      ["vipps_captures", "capture_id", await ins("vipps_captures", "capture_id")],
      ["vipps_refunds", "refund_id", await ins("vipps_refunds", "refund_id")]
    ];
    for (const [table, idCol, id] of cases) {
      for (const setClause of ["amount_ore = 5001", "currency = 'EUR'", `payment_intent_id = '${other}'`, "idempotency_key = 'ny'"]) {
        await expect(asApp(`UPDATE ${table} SET ${setClause} WHERE ${idCol} = $1`, [id]), `${table}: ${setClause}`).rejects.toMatchObject({ code: "23514" });
      }
      await expect(adminPool.query(`UPDATE ${table} SET amount_ore = 1 WHERE ${idCol} = $1`, [id])).rejects.toMatchObject({ code: "23514" }); // også superbruker
      await expect(asApp(`UPDATE ${table} SET state = 'submitted', submitted_at = now(), updated_at = now() WHERE ${idCol} = $1`, [id])).resolves.toBeDefined();
    }
    const sr = cases[0]![2];
    await expect(asApp(`UPDATE stripe_refunds SET reason = 'duplicate' WHERE refund_id = $1`, [sr])).rejects.toMatchObject({ code: "23514" });
    await expect(asApp(`UPDATE stripe_refunds SET provider_ref = 're_1', state = 'provider_acknowledged' WHERE refund_id = $1`, [sr])).resolves.toBeDefined();
  });
});

describe("C: triggerne peker på eksisterende kolonner (ingen stille no-op), og kun tabelleieren kan slå dem av", () => {
  it("hver kolonne i hver trigger finnes i tabellen", async () => {
    const triggers = (await adminPool.query(
      `SELECT c.relname AS tbl, t.tgname AS name, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname LIKE '%\\_money\\_immutable'`
    )).rows as Array<{ tbl: string; name: string; def: string }>;
    expect(triggers.map((t) => t.tbl).sort()).toEqual(["payment_intents", "stripe_refunds", "vipps_captures", "vipps_refunds"]);
    for (const t of triggers) {
      const args = [...t.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
      expect(args.length, t.name).toBeGreaterThanOrEqual(6);
      const cols = (await adminPool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [t.tbl])).rows.map((r) => (r as { column_name: string }).column_name);
      for (const a of args) expect(cols, `${t.tbl}.${a}`).toContain(a);
    }
  });

  it("appens rolle kan ikke slå triggeren av eller droppe den (ikke tabelleier); eieren kan (bevisst DDL) og re-aktivering gjenoppretter låsen", async () => {
    await expect(appPool.query("ALTER TABLE payment_intents DISABLE TRIGGER payment_intents_money_immutable")).rejects.toThrow(/must be owner|permission denied/);
    await expect(appPool.query("DROP TRIGGER payment_intents_money_immutable ON payment_intents")).rejects.toThrow(/must be owner|permission denied/);
    const id = await makeIntent();
    await adminPool.query("ALTER TABLE payment_intents DISABLE TRIGGER payment_intents_money_immutable");
    try {
      await expect(adminPool.query("UPDATE payment_intents SET amount_ore = 7 WHERE payment_intent_id = $1", [id])).resolves.toBeDefined();
    } finally {
      await adminPool.query("ALTER TABLE payment_intents ENABLE TRIGGER payment_intents_money_immutable");
    }
    await expect(adminPool.query("UPDATE payment_intents SET amount_ore = 8 WHERE payment_intent_id = $1", [id])).rejects.toMatchObject({ code: "23514" });
  });
});

describe("E: DELETE-vern (review M-F3) - en rad som har vært hos leverandøren kan ikke slettes og gjenopprettes med nytt beløp", () => {
  /** `payment_intent_events` har FK -> payment_intents (erasure sletter dem først); fixturen gjør det samme som admin slik at det er DELETE-vernet på intensjonen som testes. */
  const clearEvents = (id: string) => adminPool.query("DELETE FROM payment_intent_events WHERE payment_intent_id = $1", [id]);

  const CHILD_TABLES: Array<[string, string]> = [["stripe_refunds", "refund_id"], ["vipps_captures", "capture_id"], ["vipps_refunds", "refund_id"]];

  /** Setter inn en rad i barnetabellen som admin og flytter den til `submitted` som appen (slik tjenesten gjør ved reservasjon). */
  async function sentChild(table: string, idCol: string, parent: string): Promise<string> {
    const id = `fin-x-${randomUUID()}`;
    await adminPool.query(`INSERT INTO ${table} (${idCol}, tenant_id, payment_intent_id, idempotency_key, state, amount_ore, currency) VALUES ($1, $2, $3, $4, 'draft', 5000, 'NOK')`, [id, TENANT, parent, `k-${randomUUID()}`]);
    await asApp(`UPDATE ${table} SET state = 'submitted', submitted_at = now(), first_submit_attempt_at = now() WHERE ${idCol} = $1`, [id]);
    return id;
  }

  it("REVIEWENS ANGREP: DELETE + INSERT av samme refund_id/capture_id med et annet beløp stoppes som app-rolle (23514) - raden og beløpet er uendret", async () => {
    const parent = await makeIntent();
    for (const [table, idCol] of CHILD_TABLES) {
      const id = await sentChild(table, idCol, parent);
      const attack = withMemoryTransaction(appPool, TENANT, ["business"], async (client) => {
        await client.query(`DELETE FROM ${table} WHERE ${idCol} = $1`, [id]);
        await client.query(`INSERT INTO ${table} (${idCol}, tenant_id, payment_intent_id, idempotency_key, state, amount_ore, currency) VALUES ($1, $2, $3, $4, 'draft', 9000, 'NOK')`, [id, TENANT, parent, `k-${randomUUID()}`]);
      });
      await expect(attack, table).rejects.toMatchObject({ code: "23514", message: expect.stringContaining(`finance_money_row_delete_forbidden:${table}`) });
      expect((await adminPool.query(`SELECT amount_ore, state FROM ${table} WHERE ${idCol} = $1`, [id])).rows[0], table).toEqual({ amount_ore: "5000", state: "submitted" });
      await expect(adminPool.query(`DELETE FROM ${table} WHERE ${idCol} = $1`, [id]), `${table} (også superbruker uten erasure-kontekst)`).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("betalingsintensjon: en sendt/under-sending/tidligere forsøkt rad kan ikke slettes av appen, uansett tilstand (submitted, provider_acknowledged, settled, failed, draft med første forsøk)", async () => {
    const cases: Array<[string, string]> = [
      ["submitted", "state = 'submitted', submitted_at = now(), first_submit_attempt_at = now()"],
      ["provider_acknowledged", "state = 'provider_acknowledged', provider_ref = 'pi_1', submitted_at = now()"],
      ["settled", "state = 'settled', provider_ref = 'pi_2', submitted_at = now(), settled_at = now()"],
      ["failed", "state = 'failed', submitted_at = now(), failed_at = now()"],
      // Rullet tilbake til draft etter ukjent utfall: leverandøren KAN ha objektet, og første forsøk er registrert.
      ["draft_etter_forsok", "first_submit_attempt_at = now()"],
      ["draft_med_submitted_at", "submitted_at = now()"],
      ["kansellert_etter_innsending", "state = 'cancelled', submitted_at = now(), cancelled_at = now()"]
    ];
    for (const [name, set] of cases) {
      const id = await makeIntent();
      await asApp(`UPDATE payment_intents SET ${set} WHERE payment_intent_id = $1`, [id]);
      await expect(asApp("DELETE FROM payment_intents WHERE payment_intent_id = $1", [id]), name).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("finance_money_row_delete_forbidden:payment_intents") });
      expect((await adminPool.query("SELECT count(*)::int AS n FROM payment_intents WHERE payment_intent_id = $1", [id])).rows[0], name).toEqual({ n: 1 });
    }
  });

  it("utkast (og kansellerte utkast som aldri nådde leverandøren) kan fortsatt slettes - også av appen", async () => {
    const draft = await makeIntent();
    await clearEvents(draft);
    await expect(asApp("DELETE FROM payment_intents WHERE payment_intent_id = $1", [draft])).resolves.toBeDefined();
    const cancelled = await makeIntent();
    await asApp("UPDATE payment_intents SET state = 'cancelled', cancelled_at = now() WHERE payment_intent_id = $1", [cancelled]);
    await clearEvents(cancelled);
    await expect(asApp("DELETE FROM payment_intents WHERE payment_intent_id = $1", [cancelled])).resolves.toBeDefined();
    const parent = await makeIntent();
    for (const [table, idCol] of CHILD_TABLES) {
      const id = `fin-x-${randomUUID()}`;
      await adminPool.query(`INSERT INTO ${table} (${idCol}, tenant_id, payment_intent_id, idempotency_key, state, amount_ore, currency) VALUES ($1, $2, $3, $4, 'draft', 5000, 'NOK')`, [id, TENANT, parent, `k-${randomUUID()}`]);
      await expect(asApp(`DELETE FROM ${table} WHERE ${idCol} = $1`, [id]), table).resolves.toBeDefined();
    }
  });

  it("erasure-stien virker: transaksjonslokal `jarvis.erasure_in_progress = 'true'` slipper slettingen gjennom - og lekker ikke til neste transaksjon (og kun nøyaktig verdien 'true' teller)", async () => {
    const a = await makeIntent();
    const b = await makeIntent();
    for (const id of [a, b]) {
      await asApp("UPDATE payment_intents SET state = 'provider_acknowledged', provider_ref = 'pi_x', submitted_at = now() WHERE payment_intent_id = $1", [id]);
      await clearEvents(id);
    }
    await expect(withMemoryTransaction(appPool, TENANT, ["business"], async (client) => {
      await client.query("SELECT set_config('jarvis.erasure_in_progress', 'on', true)");
      await client.query("DELETE FROM payment_intents WHERE payment_intent_id = $1", [a]);
    })).rejects.toMatchObject({ code: "23514" }); // annen verdi enn 'true' gir ingen unntak
    await withMemoryTransaction(appPool, TENANT, ["business"], async (client) => {
      await client.query("SELECT set_config('jarvis.erasure_in_progress', 'true', true)");
      await client.query("DELETE FROM payment_intents WHERE payment_intent_id = $1", [a]);
    });
    expect((await adminPool.query("SELECT count(*)::int AS n FROM payment_intents WHERE payment_intent_id = $1", [a])).rows[0]).toEqual({ n: 0 });
    // Nytt vern utenfor transaksjonen: GUC-en var transaksjonslokal.
    await expect(asApp("DELETE FROM payment_intents WHERE payment_intent_id = $1", [b])).rejects.toMatchObject({ code: "23514" });
  });

  it("triggerne finnes på alle fire tabeller, er BEFORE DELETE ROW, og kun tabelleieren kan slå dem av (som for UPDATE-låsen)", async () => {
    const rows = (await adminPool.query(
      `SELECT c.relname AS tbl, t.tgname AS name, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname LIKE '%\\_money\\_no\\_delete' ORDER BY c.relname`
    )).rows as Array<{ tbl: string; name: string; def: string }>;
    expect(rows.map((r) => r.tbl)).toEqual(["payment_intents", "stripe_refunds", "vipps_captures", "vipps_refunds"]);
    for (const r of rows) expect(r.def, r.name).toMatch(/BEFORE DELETE ON public\.\w+ FOR EACH ROW/);
    await expect(appPool.query("ALTER TABLE payment_intents DISABLE TRIGGER payment_intents_money_no_delete")).rejects.toThrow(/must be owner|permission denied/);
    await expect(appPool.query("DROP TRIGGER payment_intents_money_no_delete ON payment_intents")).rejects.toThrow(/must be owner|permission denied/);
  });
});

describe("D: mottaker-digest - SHA-256 over hele referansen (review M-F3): stabil, følsom for ENHVER mottakerendring, og uavhengig av den maskerte visningen", () => {
  const base = { provider: "fiken", vendor_id: null, vendor_name: "  Utleier AS ", vendor_provider_ref: "kontakt-9988776655", account_code: "6300", counter_account_code: "1920" } as const;
  it("samme mottaker gir samme digest (navn og blanke tegn normaliseres); endret provider/navn/konto/motkonto/referanse gir en annen; hele 64-tegns SHA-256 (ingen avkorting)", () => {
    const d = recipientDigest(base);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(recipientDigest({ ...base, vendor_name: "utleier as", vendor_provider_ref: "  kontakt-9988776655 " })).toBe(d);
    for (const changed of [{ provider: "neonomics" }, { vendor_name: "Annen AS" }, { account_code: "6310" }, { counter_account_code: "1930" }, { vendor_id: "fin-vnd-1" }, { vendor_provider_ref: "kontakt-1122334455" }]) {
      expect(recipientDigest({ ...base, ...changed } as never), JSON.stringify(changed)).not.toBe(d);
    }
    // Digesten er en hash - den inneholder aldri referansen i klartekst.
    expect(d).not.toContain("9988776655");
  });

  it("REGRESJON (M-F3): en endret mottakerreferanse med SAMME siste fire tegn og SAMME lengde gir en ANNEN digest (før: samme digest -> bindingen slapp gjennom)", () => {
    const a = { ...base, vendor_provider_ref: "1111111111" };
    const b = { ...base, vendor_provider_ref: "9999991111" };
    expect(maskReference(a.vendor_provider_ref)).toBe(maskReference(b.vendor_provider_ref)); // den menneskelesbare visningen er lik...
    expect(recipientDigest(a)).not.toBe(recipientDigest(b)); // ...men digesten (bindingen) er det ikke
    // Alle posisjoner teller, ikke bare halen: ett tegn endret i midten, samt ulik store/små bokstaver og skilletegn i selve referansen.
    const ref = "NO9386011117947";
    const variants = ["NO9386011117948", "NO9386011117847", "no9386011117947", "NO93-8601-11179-47", "NO9386011117947X", "O9386011117947"];
    const d = recipientDigest({ ...base, vendor_provider_ref: ref });
    for (const v of variants) expect(recipientDigest({ ...base, vendor_provider_ref: v }), v).not.toBe(d);
    // Entydig serialisering: felt som flyttes mellom nabofelt gir ikke samme digest.
    expect(recipientDigest({ ...base, account_code: "6300", counter_account_code: "1920" })).not.toBe(recipientDigest({ ...base, account_code: "63001", counter_account_code: "920" }));
    expect(recipientDigest({ ...base, vendor_name: "a", vendor_provider_ref: "bc" })).not.toBe(recipientDigest({ ...base, vendor_name: "ab", vendor_provider_ref: "c" }));
  });
});

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, firstWaveTools, type ClassDNotification, type ClassDNotifier } from "@jarvis/tool-gateway";
import {
  FinanceService,
  FinanceTransport,
  PossibleDuplicatePaymentError,
  StripeFinanceTransport,
  VippsFinanceTransport,
  type FikenCredentials,
  type PaymentIntent,
  type StripeCredentials,
  type VippsCredentials
} from "../src/index.ts";
import { FikenFake, Gate, StripeFake, VippsFake } from "./wpf1-fakes.ts";

/**
 * WP-F1, uavhengig review (PR #321) - rettelser M-F1, M-F2, M-F3 og F4-F8, mot ekte embedded Postgres og ekte ToolGateway med påslått klasse D-pipeline:
 *
 *  M-F1  Duplikatvakten var et TOCTOU: validatoren leste kandidatene FØR reservasjonen, og reservasjonen kjørte ikke vakten på nytt. To samtidige innsendinger av ULIKE
 *        intensjoner (samme leverandør/beløp/valuta) ga to leverandørkall (bekreftet 20 av 20 par). Nå tar reservasjonstransaksjonen en `pg_advisory_xact_lock` og kjører
 *        kandidatspørringen på nytt - NØYAKTIG ett leverandørkall per par.
 *  M-F2  Leverandørkallet LYKTES, men lagringen av svaret feilet (DB-trigger) -> stille `failed` uten varsel. Nå: `unverified`, umiddelbart «UTFALL UKJENT»-varsel og
 *        `SUBMIT_OUTCOME_UNKNOWN` - for alle fire handlinger. Et kall som feiler FØR leverandøren er fortsatt en vanlig `failed`.
 *  M-F3  Mottaker-digesten var siste fire tegn + lengde: en endret mottakerreferanse med samme slutt og lengde passerte bindingen. Nå SHA-256 over hele referansen
 *        (DELETE-vernet i migrasjon 101 testes i wpf1-immutable-money.test.ts og modules/erasure; her testes bindingen gjennom ekte gateway).
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let poolA: pg.Pool;
let poolB: pg.Pool;
const TENANT = "tenant-wpf1-rev";
const OWNER = "person-wpf1-rev-owner";

const stripeCreds: StripeCredentials = { secretKey: "sk_test_fixture_not_real" };
const vippsCreds: VippsCredentials = { clientId: "c", clientSecret: "s-fixture", subscriptionKey: "k", merchantSerialNumber: "1", environment: "test" };
const fikenCreds: FikenCredentials = { refreshToken: "t-fixture", companySlug: "firma" };

const owner: IdentityContext = {
  person_id: OWNER, tenant_id: TENANT, memory_space_id: "business", session_id: "sess-wpf1-rev", device_id: "dev-pc", channel: "web", auth_strength: "signed"
};

class FakeNotifier implements ClassDNotifier {
  sent: ClassDNotification[] = [];
  ready() { return true; }
  async notify(n: ClassDNotification) { this.sent.push(n); }
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpf1-rev-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpf1_rev LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpf1_rev");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'WPF1 review', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Eier');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${TENANT}');
  `);
  // To SEPARATE pooler = to «prosesser» (hver sin tilkoblingsgruppe mot samme database).
  poolA = createPool({ ...base, user: "jarvis_wpf1_rev", password: "pw2" });
  poolB = createPool({ ...base, user: "jarvis_wpf1_rev", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await poolA?.end();
  await poolB?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

function secrets() {
  const table: Record<string, string | null> = {
    JARVIS_BUSINESS_INTERNAL_TOKEN: "internal-sentinel", JARVIS_STRIPE_SECRET_KEY: "sk_test_fixture_not_real", JARVIS_VIPPS_CLIENT_SECRET: "s-fixture",
    JARVIS_FIKEN_REFRESH_TOKEN: "t-fixture", JARVIS_NEONOMICS_CLIENT_SECRET: null
  };
  return { name: "wpf1-rev-fixture", get: async (ref: string) => (Object.hasOwn(table, ref) ? table[ref] ?? null : null) };
}

interface Wired { stripe: StripeFake; vipps: VippsFake; fiken: FikenFake; finance: FinanceService; gateway: ToolGateway; notifier: FakeNotifier }

/** Én «prosess»: egen ToolGateway (egen rate-limit-teller), eget FinanceService og egen pool; leverandørdoblene kan deles mellom prosesser. */
function wire(opts: { pool?: pg.Pool; stripe?: StripeFake; vipps?: VippsFake; fiken?: FikenFake } = {}): Wired {
  const pool = opts.pool ?? poolA;
  const stripe = opts.stripe ?? new StripeFake();
  const vipps = opts.vipps ?? new VippsFake();
  const fiken = opts.fiken ?? new FikenFake();
  const notifier = new FakeNotifier();
  const finance = new FinanceService(
    pool, () => fiken, { getCredentials: async () => stripeCreds }, () => stripe, () => "whsec-fixture", () => TENANT,
    { getCredentials: async () => vippsCreds }, () => vipps, () => "vipps-fixture", () => TENANT
  );
  const policy = new PolicyGateway({
    devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT] }
  });
  const gateway = new ToolGateway(pool, policy, secrets(), undefined, undefined, {
    classDPipeline: { enforce: true, notifier },
    credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT], internalRefs: new Set(["JARVIS_BUSINESS_INTERNAL_TOKEN"]) }
  });
  for (const tool of firstWaveTools({
    finance: new FinanceTransport(finance, { getCredentials: async () => fikenCreds }),
    finance_stripe: new StripeFinanceTransport(finance),
    finance_vipps: new VippsFinanceTransport(finance)
  })) gateway.register(tool);
  return { stripe, vipps, fiken, finance, gateway, notifier };
}

const key = (prefix: string) => `${prefix}-${randomUUID()}`;
const submitIntent = (w: Wired, id: string, k = key("si"), extra: Record<string, JsonValue> = {}) =>
  w.gateway.execute({ identity: owner, tool_id: "finance", action: "submit_payment_intent", parameters: { tenant_id: TENANT, payment_intent_id: id, ...extra }, idempotency_key: k });
const submitStripeRefund = (w: Wired, id: string, k = key("sr")) =>
  w.gateway.execute({ identity: owner, tool_id: "finance_stripe", action: "submit_refund", parameters: { tenant_id: TENANT, refund_id: id }, idempotency_key: k });
const submitCapture = (w: Wired, id: string, k = key("sc")) =>
  w.gateway.execute({ identity: owner, tool_id: "finance_vipps", action: "submit_capture", parameters: { tenant_id: TENANT, capture_id: id }, idempotency_key: k });
const submitVippsRefund = (w: Wired, id: string, k = key("svr")) =>
  w.gateway.execute({ identity: owner, tool_id: "finance_vipps", action: "submit_refund", parameters: { tenant_id: TENANT, refund_id: id }, idempotency_key: k });

async function makeIntent(w: Wired, provider: "stripe" | "vipps" | "fiken", extra: Record<string, unknown> = {}): Promise<PaymentIntent> {
  const fikenExtra = provider === "fiken" ? { vendor_provider_ref: "kontakt-9988776655", counter_account_code: "1920" } : {};
  return w.finance.createPaymentIntent(TENANT, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "WPF1 review", amount_ore: 10_000, vendor_name: `Kunde ${randomUUID().slice(0, 8)} AS`,
    account_code: provider === "fiken" ? "6540" : "kategori", provider, ...fikenExtra, ...extra
  } as never);
}
const intentRow = async (id: string) => (await adminPool.query("SELECT * FROM payment_intents WHERE payment_intent_id = $1", [id])).rows[0] as Record<string, unknown>;
const ledgerRow = async (k: string) => (await adminPool.query("SELECT * FROM tool_executions WHERE idempotency_key = $1", [k])).rows[0] as Record<string, unknown> | undefined;
const row = async (table: string, idColumn: string, id: string) => (await adminPool.query(`SELECT * FROM ${table} WHERE ${idColumn} = $1`, [id])).rows[0] as Record<string, unknown>;
const waitFor = async (cond: () => boolean, ms = 5_000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("waitFor_timeout"); await new Promise((r) => setTimeout(r, 10)); } };
const reasonOf = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : (r as { reason: string }).reason);

describe("M-F1: duplikatvakten er serialisert inne i reservasjonen (advisory-lås + ny kandidatspørring)", () => {
  it("20 par av ULIKE Stripe-intensjoner (samme leverandør/beløp/valuta) sendt SAMTIDIG via to prosesser gir NØYAKTIG ett leverandørkall per par", async () => {
    const stripe = new StripeFake();
    const pairs = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
      const seed = setupSeed(i);
      const setup = wire({ stripe });
      // Annenhvert par bruker en navnevariant (store/små bokstaver + mellomrom) som duplikatpredikatet (`lower(btrim(...))`) regner som samme leverandør - låsen må gjøre det samme.
      const a = await makeIntent(setup, "stripe", { vendor_name: `Dobbel ${seed} AS`, amount_ore: 12_345 });
      const b = await makeIntent(setup, "stripe", { vendor_name: i % 2 === 0 ? `Dobbel ${seed} AS` : `  dobbel ${seed} as `, amount_ore: 12_345 });
      return { a, b };
    }));

    // To gateway-instanser (egen pool, egen rate-limit-teller) per par; alle 40 kallene starter samtidig.
    const results = await Promise.all(pairs.map(async ({ a, b }) => {
      const p1 = wire({ pool: poolA, stripe });
      const p2 = wire({ pool: poolB, stripe });
      const [ra, rb] = await Promise.all([submitIntent(p1, a.payment_intent_id), submitIntent(p2, b.payment_intent_id)]);
      return { a, b, ra, rb };
    }));

    for (const { a, b, ra, rb } of results) {
      const calls = stripe.createCalls.filter((c) => c.idempotencyKey === `stripe-submit:${a.payment_intent_id}` || c.idempotencyKey === `stripe-submit:${b.payment_intent_id}`);
      expect(calls, `par ${a.payment_intent_id}/${b.payment_intent_id}: leverandørkall`).toHaveLength(1);
      const winner = ra.ok ? a : b;
      const loser = ra.ok ? b : a;
      expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
      const lost = ra.ok ? rb : ra;
      expect(reasonOf(lost)).toMatch(new RegExp(`possible_duplicate_of:${winner.payment_intent_id}$`));
      expect((await intentRow(loser.payment_intent_id))["state"], "taperen forblir et ikke-sendt utkast").toBe("draft");
      expect((await intentRow(winner.payment_intent_id))["state"]).toBe("provider_acknowledged");
    }
    expect(stripe.createCalls).toHaveLength(20);
  }, 120_000);

  it("SEKVENSIELT er oppførselen uendret: den andre avvises i målvalideringen (`preflight_invalid:possible_duplicate_of:<id>`), ett leverandørkall", async () => {
    const w = wire();
    const vendor = `Sekvensiell ${randomUUID().slice(0, 8)} AS`;
    const a = await makeIntent(w, "stripe", { vendor_name: vendor, amount_ore: 777 });
    const b = await makeIntent(w, "stripe", { vendor_name: vendor, amount_ore: 777 });
    expect((await submitIntent(w, a.payment_intent_id)).ok).toBe(true);
    expect(await submitIntent(w, b.payment_intent_id)).toEqual({ ok: false, reason: `preflight_invalid:possible_duplicate_of:${a.payment_intent_id}` });
    expect(w.stripe.createCalls).toHaveLength(1);
    expect((await intentRow(b.payment_intent_id))["state"]).toBe("draft");
  });

  it("bekreftet duplikat (`confirm_possible_duplicate_of`) slipper fortsatt gjennom - sekvensielt OG når begge kvitterer for hverandre samtidig", async () => {
    const stripe = new StripeFake();
    const w1 = wire({ pool: poolA, stripe });
    const w2 = wire({ pool: poolB, stripe });
    const vendor = `Bekreftet ${randomUUID().slice(0, 8)} AS`;
    const a = await makeIntent(w1, "stripe", { vendor_name: vendor, amount_ore: 888 });
    const b = await makeIntent(w1, "stripe", { vendor_name: vendor, amount_ore: 888 });
    expect((await submitIntent(w1, a.payment_intent_id)).ok).toBe(true);
    // Feil kvittering (en annen id) hjelper ikke:
    expect(reasonOf(await submitIntent(w1, b.payment_intent_id, key("x"), { confirm_possible_duplicate_of: ["fin-pi-finnes-ikke"] }))).toBe(`preflight_invalid:possible_duplicate_of:${a.payment_intent_id}`);
    expect((await submitIntent(w1, b.payment_intent_id, key("y"), { confirm_possible_duplicate_of: [a.payment_intent_id] })).ok).toBe(true);
    expect(stripe.createCalls).toHaveLength(2);

    const c = await makeIntent(w1, "stripe", { vendor_name: `${vendor} 2`, amount_ore: 889 });
    const d = await makeIntent(w1, "stripe", { vendor_name: `${vendor} 2`, amount_ore: 889 });
    const [rc, rd] = await Promise.all([
      submitIntent(w1, c.payment_intent_id, key("c"), { confirm_possible_duplicate_of: [d.payment_intent_id] }),
      submitIntent(w2, d.payment_intent_id, key("d"), { confirm_possible_duplicate_of: [c.payment_intent_id] })
    ]);
    expect([rc.ok, rd.ok]).toEqual([true, true]);
    expect(stripe.createCalls).toHaveLength(4);
  });

  it("vakten ligger i SERVICEN (ikke bare i validatoren): en intensjon som sendes mens en annen er i flukt avvises med PossibleDuplicatePaymentError FØR leverandørkall", async () => {
    const stripe = new StripeFake();
    stripe.gate = new Gate();
    const w = wire({ stripe });
    const vendor = `Iflukt ${randomUUID().slice(0, 8)} AS`;
    const a = await makeIntent(w, "stripe", { vendor_name: vendor, amount_ore: 999 });
    const b = await makeIntent(w, "stripe", { vendor_name: vendor, amount_ore: 999 });
    const first = w.finance.submitPaymentIntent(TENANT, "business", a.payment_intent_id, { getCredentials: async () => null }, undefined, { duplicateGuard: { confirmedDuplicateOf: [] } });
    await waitFor(() => stripe.createCalls.length === 1);
    await expect(
      w.finance.submitPaymentIntent(TENANT, "business", b.payment_intent_id, { getCredentials: async () => null }, undefined, { duplicateGuard: { confirmedDuplicateOf: [] } })
    ).rejects.toMatchObject({ name: "PossibleDuplicatePaymentError", message: `possible_duplicate_of:${a.payment_intent_id}` });
    await expect(
      w.finance.submitPaymentIntent(TENANT, "business", b.payment_intent_id, { getCredentials: async () => null }, undefined, { duplicateGuard: { confirmedDuplicateOf: [] } })
    ).rejects.toBeInstanceOf(PossibleDuplicatePaymentError);
    expect(stripe.createCalls).toHaveLength(1);
    stripe.gate.open();
    expect((await first).state).toBe("provider_acknowledged");
    expect((await intentRow(b.payment_intent_id))["state"]).toBe("draft");
  });

  it("låsen er nøkkelen til serialiseringen: en annen transaksjon som holder samme lås blokkerer innsendingen til den commit-er; en annen leverandør/beløp blokkeres ikke", async () => {
    const stripe = new StripeFake();
    const w = wire({ stripe });
    const vendor = `Las ${randomUUID().slice(0, 8)} AS`;
    const a = await makeIntent(w, "stripe", { vendor_name: vendor, amount_ore: 4_242 });
    const other = await makeIntent(w, "stripe", { vendor_name: vendor, amount_ore: 4_243 });
    const holder = await adminPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('finance-duplicate-guard'::text, $1::text, 'stripe'::text, '4242'::text, 'NOK'::text, lower(btrim($2::text)))::text, 0))`,
        [TENANT, `  ${vendor.toUpperCase()}  `]
      );
      let blockedDone = false;
      const blocked = w.finance.submitPaymentIntent(TENANT, "business", a.payment_intent_id, { getCredentials: async () => null }, undefined, { duplicateGuard: { confirmedDuplicateOf: [] } })
        .then((r) => { blockedDone = true; return r; });
      // Annet beløp = annen lås: går rett gjennom mens `a` venter.
      expect((await w.finance.submitPaymentIntent(TENANT, "business", other.payment_intent_id, { getCredentials: async () => null }, undefined, { duplicateGuard: { confirmedDuplicateOf: [] } })).state).toBe("provider_acknowledged");
      await new Promise((r) => setTimeout(r, 400));
      expect(blockedDone, "innsendingen skal vente på advisory-låsen").toBe(false);
      expect(stripe.createCalls.map((c) => c.idempotencyKey)).toEqual([`stripe-submit:${other.payment_intent_id}`]);
      await holder.query("COMMIT");
      expect((await blocked).state).toBe("provider_acknowledged");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });

  it("uten `duplicateGuard` (direkte servicekall utenfor gatewayen) er oppførselen som før - vakten er et gateway-/transportvern, og transporten setter den alltid", async () => {
    const stripe = new StripeFake();
    const w = wire({ stripe });
    const vendor = `Direkte ${randomUUID().slice(0, 8)} AS`;
    const a = await makeIntent(w, "stripe", { vendor_name: vendor, amount_ore: 555 });
    const b = await makeIntent(w, "stripe", { vendor_name: vendor, amount_ore: 555 });
    expect((await w.finance.submitPaymentIntent(TENANT, "business", a.payment_intent_id, { getCredentials: async () => null })).state).toBe("provider_acknowledged");
    expect((await w.finance.submitPaymentIntent(TENANT, "business", b.payment_intent_id, { getCredentials: async () => null })).state).toBe("provider_acknowledged");
    // Gjennom transporten (gatewayen) er den alltid på: samme situasjon avvises.
    const c = await makeIntent(w, "stripe", { vendor_name: vendor, amount_ore: 555 });
    expect(reasonOf(await submitIntent(w, c.payment_intent_id))).toMatch(/possible_duplicate_of:/);
  });
});

let seedCounter = 0;
function setupSeed(i: number): string {
  seedCounter += 1;
  return `${i}-${seedCounter}-${randomUUID().slice(0, 6)}`;
}

/** Test-trigger som feiler en skriving mot en tabell når raden får en bestemt tilstand (simulerer at DB-skrivingen feiler ETTER leverandørkallet). */
async function installFailingTrigger(table: string, whenSql: string): Promise<() => Promise<void>> {
  const name = `wpf1_inject_${table}_${randomUUID().slice(0, 6)}`;
  await adminPool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'wpf1_injected_write_failure' USING ERRCODE = 'P0001'; END $$`);
  await adminPool.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} FOR EACH ROW WHEN (${whenSql}) EXECUTE FUNCTION ${name}()`);
  return async () => {
    await adminPool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await adminPool.query(`DROP FUNCTION IF EXISTS ${name}()`);
  };
}

describe("M-F2: leverandørkallet LYKTES, men lagringen av svaret feilet -> UKJENT utfall (unverified + varsel + flagg), aldri en stille `failed`", () => {
  it("Stripe-intensjon: trigger som kaster ved state='provider_acknowledged' -> unverified, varsel `unknown`, flagg, ett leverandørkall; retry gjenbruker Idempotency-Key", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    const uninstall = await installFailingTrigger("payment_intents", "NEW.state = 'provider_acknowledged'");
    const k = key("mf2s");
    let first;
    try {
      first = await submitIntent(w, intent.payment_intent_id, k);
    } finally {
      await uninstall();
    }
    expect(first.ok).toBe(false);
    expect(reasonOf(first)).toMatch(/^tool_failed:outcome_unknown:provider_call_completed_local_write_failed:/);
    expect(w.stripe.createCalls).toHaveLength(1);
    expect((await ledgerRow(k))!["status"]).toBe("unverified"); // ikke `failed`
    expect(w.notifier.sent).toHaveLength(1);
    expect(w.notifier.sent[0]).toMatchObject({ outcome: "unknown", tool_id: "finance", action: "submit_payment_intent", idempotency_key: k });
    const after = await intentRow(intent.payment_intent_id);
    expect(after["anomaly_flags"]).toContain("SUBMIT_OUTCOME_UNKNOWN");
    expect(after["provider_ref"]).toBeNull();
    expect(after["state"]).toBe("draft"); // Stripe slår sammen kall med samme nøkkel -> trygt å gjenoppta
    const event = (await adminPool.query("SELECT summary, metadata FROM payment_intent_events WHERE payment_intent_id = $1 AND event_type = 'anomaly_flagged' AND metadata->>'cause' = 'local_write'", [intent.payment_intent_id])).rows[0] as { summary: string; metadata: Record<string, unknown> };
    expect(event.summary).toMatch(/leverandøren HAR svart/);
    expect(event.metadata["cause"]).toBe("local_write");

    // Samme nøkkel igjen: lagret utfall, aldri en ny mutasjon.
    expect(await submitIntent(w, intent.payment_intent_id, k)).toEqual({ ok: false, reason: "postcondition_unverified:tool_timeout_outcome_unknown" });
    expect(w.stripe.createCalls).toHaveLength(1);
    // Ny bekreftelse/nøkkel etter at feilen er borte: SAMME Idempotency-Key hos Stripe -> ingen dobbel effekt, flagget fjernes.
    const retry = await submitIntent(w, intent.payment_intent_id);
    expect(retry.ok).toBe(true);
    expect(w.stripe.createCalls).toHaveLength(2);
    expect(w.stripe.createCalls[1]!.idempotencyKey).toBe(w.stripe.createCalls[0]!.idempotencyKey);
    expect(w.stripe.distinctEffects).toBe(1);
    expect((await intentRow(intent.payment_intent_id))["anomaly_flags"]).not.toContain("SUBMIT_OUTCOME_UNKNOWN");
  });

  it("Fiken-postering: samme trigger -> unverified + varsel + flagg; intensjonen STÅR som `submitted` og en retry krever avstemming (aldri en ny postering)", async () => {
    const w = wire();
    const intent = await makeIntent(w, "fiken");
    const uninstall = await installFailingTrigger("payment_intents", "NEW.state = 'provider_acknowledged'");
    const k = key("mf2f");
    let first;
    try {
      first = await submitIntent(w, intent.payment_intent_id, k);
    } finally {
      await uninstall();
    }
    expect(first.ok).toBe(false);
    expect(reasonOf(first)).toMatch(/^tool_failed:outcome_unknown:provider_call_completed_local_write_failed:/);
    expect(w.fiken.calls).toBe(1);
    expect((await ledgerRow(k))!["status"]).toBe("unverified");
    expect(w.notifier.sent.map((n) => n.outcome)).toEqual(["unknown"]);
    const after = await intentRow(intent.payment_intent_id);
    expect(after["anomaly_flags"]).toContain("SUBMIT_OUTCOME_UNKNOWN");
    expect(after["state"]).toBe("submitted");
    expect(after["submitted_at"]).toBeNull(); // lease regnes som utløpt -> umiddelbar «avstem», ikke et misvisende «pågår»
    expect(await submitIntent(w, intent.payment_intent_id)).toEqual({ ok: false, reason: "preflight_invalid:submit_outcome_unknown_reconcile_required" });
    expect(w.fiken.calls).toBe(1);
  });

  it("Stripe-refusjon, Vipps-capture og Vipps-refusjon: samme regel (unverified + varsel + flagg + radene rulles tilbake til draft for sikker gjenopptakelse)", async () => {
    const w = wire();
    const parent = await makeIntent(w, "stripe");
    await adminPool.query("UPDATE payment_intents SET state = 'settled', provider_ref = $2, provider_status = 'succeeded', settled_at = now() WHERE payment_intent_id = $1", [parent.payment_intent_id, `pi_${randomUUID().slice(0, 8)}`]);
    const refund = await w.finance.createStripeRefund(TENANT, "business", { idempotency_key: key("rf"), payment_intent_id: parent.payment_intent_id, amount_ore: 1_000 });
    const vp = await makeIntent(w, "vipps");
    await adminPool.query("UPDATE payment_intents SET state = 'provider_acknowledged', provider_ref = $2, provider_status = 'AUTHORIZED', provider_status_updated_at = now() WHERE payment_intent_id = $1", [vp.payment_intent_id, vp.payment_intent_id]);
    const capture = await w.finance.createVippsCapture(TENANT, "business", { idempotency_key: key("cap"), payment_intent_id: vp.payment_intent_id, amount_ore: 500 });
    const vs = await makeIntent(w, "vipps");
    await adminPool.query("UPDATE payment_intents SET state = 'settled', provider_ref = $2, provider_status = 'AUTHORIZED', provider_status_updated_at = now() WHERE payment_intent_id = $1", [vs.payment_intent_id, vs.payment_intent_id]);
    const vrefund = await w.finance.createVippsRefund(TENANT, "business", { idempotency_key: key("vr"), payment_intent_id: vs.payment_intent_id, amount_ore: 700 });

    const cases: Array<{ name: string; table: string; idColumn: string; id: string; run: (k: string) => ReturnType<typeof submitCapture>; calls: () => number; toolId: string; action: string }> = [
      { name: "stripe-refusjon", table: "stripe_refunds", idColumn: "refund_id", id: refund.refund_id, run: (k) => submitStripeRefund(w, refund.refund_id, k), calls: () => w.stripe.refundCalls.length, toolId: "finance_stripe", action: "submit_refund" },
      { name: "vipps-capture", table: "vipps_captures", idColumn: "capture_id", id: capture.capture_id, run: (k) => submitCapture(w, capture.capture_id, k), calls: () => w.vipps.captureCalls.length, toolId: "finance_vipps", action: "submit_capture" },
      { name: "vipps-refusjon", table: "vipps_refunds", idColumn: "refund_id", id: vrefund.refund_id, run: (k) => submitVippsRefund(w, vrefund.refund_id, k), calls: () => w.vipps.refundCalls.length, toolId: "finance_vipps", action: "submit_refund" }
    ];
    for (const c of cases) {
      const uninstall = await installFailingTrigger(c.table, "NEW.state IN ('provider_acknowledged', 'settled')");
      const k = key("mf2c");
      let r;
      try {
        r = await c.run(k);
      } finally {
        await uninstall();
      }
      expect(r.ok, c.name).toBe(false);
      expect(reasonOf(r), c.name).toMatch(/^tool_failed:outcome_unknown:provider_call_completed_local_write_failed:/);
      expect(c.calls(), c.name).toBe(1);
      expect((await ledgerRow(k))!["status"], c.name).toBe("unverified");
      const flagged = await row(c.table, c.idColumn, c.id);
      expect(flagged["anomaly_flags"], c.name).toContain("SUBMIT_OUTCOME_UNKNOWN");
      expect(flagged["state"], c.name).toBe("draft");
      expect(String(flagged["failure_reason"]), c.name).toMatch(/^outcome_unknown:provider_call_completed|^outcome_unknown:wpf1_injected/);
      const last = w.notifier.sent.at(-1)!;
      expect(last, c.name).toMatchObject({ outcome: "unknown", tool_id: c.toolId, action: c.action, idempotency_key: k });
      // Gjenopptakelse etter at feilen er borte: samme Idempotency-Key hos leverandøren, ferdigstilles og flagget fjernes.
      const again = await c.run(key("mf2c2"));
      expect(again.ok, c.name).toBe(true);
      expect((await row(c.table, c.idColumn, c.id))["anomaly_flags"], c.name).not.toContain("SUBMIT_OUTCOME_UNKNOWN");
    }
    expect(w.stripe.distinctEffects).toBe(1); // refusjonen hos Stripe ble aldri utført to ganger
    expect(w.notifier.sent.filter((n) => n.outcome === "unknown")).toHaveLength(3);
  });

  it("et kall som feiler FØR leverandøren (reservasjonen kan ikke skrives) er fortsatt en ekte `failed`: ingen leverandørkall, ingen UKJENT-varsel, retry tillatt", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    const uninstall = await installFailingTrigger("payment_intents", "NEW.state = 'submitted'");
    const k = key("mf2pre");
    let r;
    try {
      r = await submitIntent(w, intent.payment_intent_id, k);
    } finally {
      await uninstall();
    }
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toMatch(/^tool_failed:wpf1_injected_write_failure/);
    expect(w.stripe.createCalls).toHaveLength(0);
    expect((await ledgerRow(k))!["status"]).toBe("failed");
    expect(w.notifier.sent).toHaveLength(0);
    const after = await intentRow(intent.payment_intent_id);
    expect(after["state"]).toBe("draft");
    expect(after["anomaly_flags"]).not.toContain("SUBMIT_OUTCOME_UNKNOWN");
    // Retry med samme nøkkel re-armer den feilede raden og lykkes nå som feilen er borte.
    expect((await submitIntent(w, intent.payment_intent_id, k)).ok).toBe(true);
    expect(w.stripe.createCalls).toHaveLength(1);
  });

  it("sekundærfeil svelges, den opprinnelige skjules aldri: faller også bokføringen av ukjent utfall, er resultatet likevel `unverified` + varsel (raden forblir reservert)", async () => {
    const w = wire({ fiken: new FikenFake() });
    const intent = await makeIntent(w, "fiken");
    // Triggeren feiler BÅDE ferdigstillingen (provider_acknowledged) og bokføringen av ukjent utfall (flagg-oppdatering som setter submitted_at = NULL).
    const uninstallAck = await installFailingTrigger("payment_intents", "NEW.state = 'provider_acknowledged'");
    const uninstallBook = await installFailingTrigger("payment_intents", "OLD.state = 'submitted' AND NEW.state = 'submitted' AND NEW.submitted_at IS NULL");
    const k = key("mf2sec");
    let r;
    try {
      r = await submitIntent(w, intent.payment_intent_id, k);
    } finally {
      await uninstallAck();
      await uninstallBook();
    }
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toMatch(/^tool_failed:outcome_unknown:provider_call_completed_local_write_failed:/);
    expect((await ledgerRow(k))!["status"]).toBe("unverified");
    expect(w.notifier.sent.map((n) => n.outcome)).toEqual(["unknown"]);
    expect(w.fiken.calls).toBe(1);
    const after = await intentRow(intent.payment_intent_id);
    expect(after["state"]).toBe("submitted"); // fortsatt reservert -> lease/avstemming hindrer en ny postering
    expect(after["provider_ref"]).toBeNull();
  });
});

describe("M-F3: mottakerbindingen gjennom ekte gateway - samme siste fire tegn og samme lengde er IKKE lenger samme mottaker", () => {
  async function boundParams(w: Wired, id: string): Promise<Record<string, JsonValue>> {
    const check = (await w.finance.checkSubmitPaymentIntent(TENANT, "business", id))!;
    return { expected_amount_ore: check.payment_intent.amount_ore, expected_currency: check.payment_intent.currency, expected_recipient: check.payment_intent.recipient_digest! };
  }

  it("uendret mottaker: bundet innsending går gjennom; mottakerreferansen byttet til en med samme siste fire tegn og lengde (1111111111 -> 9999991111) gir bound_recipient_mismatch FØR leverandørkall", async () => {
    const w = wire();
    const intent = await makeIntent(w, "fiken", { vendor_provider_ref: "1111111111" });
    const bound = await boundParams(w, intent.payment_intent_id);
    expect(bound["expected_recipient"]).toMatch(/^[0-9a-f]{64}$/);

    // Angrepet fra reviewen: mottakerreferansen byttes mellom forespørsel og godkjenning. Den maskerte visningen er identisk (…1111 (10)) - digesten er det ikke.
    // (Normalt stoppes selve endringen av UPDATE-/DELETE-triggerne i migrasjon 101; her bypasses de som tabelleier for å bevise at BINDINGEN er et uavhengig andre lag.)
    await adminPool.query("ALTER TABLE payment_intents DISABLE TRIGGER payment_intents_money_immutable");
    try {
      await adminPool.query("UPDATE payment_intents SET vendor_provider_ref = '9999991111' WHERE payment_intent_id = $1", [intent.payment_intent_id]);
    } finally {
      await adminPool.query("ALTER TABLE payment_intents ENABLE TRIGGER payment_intents_money_immutable");
    }
    const after = (await w.finance.checkSubmitPaymentIntent(TENANT, "business", intent.payment_intent_id))!.payment_intent;
    expect(after.vendor_ref_masked).toBe("…1111 (10)"); // samme visning som før endringen
    expect(await submitIntent(w, intent.payment_intent_id, key("m3"), bound)).toEqual({ ok: false, reason: "preflight_invalid:bound_recipient_mismatch" });
    expect(w.fiken.calls).toBe(0);

    // Settes referansen tilbake, går den bundne innsendingen gjennom (bindingen er presis, ikke bare «alt avvises»).
    await adminPool.query("ALTER TABLE payment_intents DISABLE TRIGGER payment_intents_money_immutable");
    try {
      await adminPool.query("UPDATE payment_intents SET vendor_provider_ref = '1111111111' WHERE payment_intent_id = $1", [intent.payment_intent_id]);
    } finally {
      await adminPool.query("ALTER TABLE payment_intents ENABLE TRIGGER payment_intents_money_immutable");
    }
    expect((await submitIntent(w, intent.payment_intent_id, key("m3ok"), bound)).ok).toBe(true);
    expect(w.fiken.calls).toBe(1);
  });
});

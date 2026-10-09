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
import {
  MODEL_SURFACE_ALLOWLIST,
  OWNER_ONLY_NAMESPACES,
  SURFACES,
  SURFACE_TOOL_GRANTS,
  ToolGateway,
  assertManifestInvariants,
  assessClassDPipeline,
  buildToolManifest,
  firstWaveTools,
  type ClassDNotification,
  type ClassDNotifier,
  type ToolTransport
} from "@jarvis/tool-gateway";
import {
  FinanceService,
  FinanceTransport,
  StripeFinanceTransport,
  VippsFinanceTransport,
  type FikenCredentials,
  type PaymentIntent,
  type StripeCredentials,
  type VippsCredentials
} from "../src/index.ts";
import { FikenFake, Gate, StripeFake, VippsFake, timeoutError } from "./wpf1-fakes.ts";

/**
 * WP-F1 (D-462, Q-47 a): KLASSE D-KJEDEN FOR PENGER, ende-til-ende. Ekte `ToolGateway` med påslått klasse D-pipeline (som i produksjon), ekte
 * `FinanceService` og ekte embedded Postgres; leverandørene er testdobler som oppfører seg som de ekte (Stripe/Vipps slår sammen kall med samme
 * Idempotency-Key, Fiken gjør det ikke) slik at testen kan TELLE effekter hos leverandøren. Ingen nettverk.
 *
 * For hver av de fire handlingene (`finance.submit_payment_intent`, `finance_stripe.submit_refund`, `finance_vipps.submit_capture`/`submit_refund`):
 * fersk tilstandslesing + målvalidering, idempotency_key, etterbetingelse (leverandør-ID + tilstandsovergang via readback), umiddelbart varsel,
 * og dobbeltbetalingsvernet: retry med samme nøkkel, to samtidige kall, krasj mellom reservasjon og leverandørkall, leverandør-tidsavbrudd.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-wpf1-chain";
const TENANT_B = "tenant-wpf1-chain-b";
const OWNER = "person-wpf1-owner";
const GUEST = "person-wpf1-guest";

const stripeCreds: StripeCredentials = { secretKey: "sk_test_fixture_not_real" };
const vippsCreds: VippsCredentials = { clientId: "c", clientSecret: "s-fixture", subscriptionKey: "k", merchantSerialNumber: "1", environment: "test" };
const fikenCreds: FikenCredentials = { refreshToken: "t-fixture", companySlug: "firma" };

const owner: IdentityContext = {
  person_id: OWNER, tenant_id: TENANT, memory_space_id: "business", session_id: "sess-wpf1-chain", device_id: "dev-pc", channel: "web", auth_strength: "signed"
};

class FakeNotifier implements ClassDNotifier {
  sent: ClassDNotification[] = [];
  isReady = true;
  ready() { return this.isReady; }
  async notify(n: ClassDNotification) { this.sent.push(n); }
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpf1-chain-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpf1_chain LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpf1_chain");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'WPF1 chain', 'business'), ('${TENANT_B}', 'WPF1 chain B', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Eier'), ('${GUEST}', 'Gjest');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${TENANT}'), ('${GUEST}', '${TENANT}');
  `);
  appPool = createPool({ ...base, user: "jarvis_wpf1_chain", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

/** Hemmeligheter slik gatewayen ser dem: `null` = ikke konfigurert (credential_unavailable). */
function secretsOf(overrides: Record<string, string | null> = {}) {
  const table: Record<string, string | null> = {
    JARVIS_BUSINESS_INTERNAL_TOKEN: "internal-sentinel",
    JARVIS_STRIPE_SECRET_KEY: "sk_test_fixture_not_real",
    JARVIS_VIPPS_CLIENT_SECRET: "s-fixture",
    JARVIS_FIKEN_REFRESH_TOKEN: "t-fixture",
    JARVIS_NEONOMICS_CLIENT_SECRET: null,
    ...overrides
  };
  return { name: "wpf1-fixture", get: async (ref: string) => (Object.hasOwn(table, ref) ? table[ref] ?? null : null) };
}

interface Wired {
  stripe: StripeFake; vipps: VippsFake; fiken: FikenFake;
  finance: FinanceService; gateway: ToolGateway; notifier: FakeNotifier;
}

function wire(opts: {
  stripe?: StripeFake; vipps?: VippsFake; fiken?: FikenFake; secrets?: Record<string, string | null>; notifier?: FakeNotifier;
  timing?: { leaseMs?: number; idempotencyWindowMs?: number }; financeTransport?: (inner: FinanceTransport, finance: FinanceService) => ToolTransport;
} = {}): Wired {
  const stripe = opts.stripe ?? new StripeFake();
  const vipps = opts.vipps ?? new VippsFake();
  const fiken = opts.fiken ?? new FikenFake();
  const notifier = opts.notifier ?? new FakeNotifier();
  const finance = new FinanceService(
    appPool, () => fiken, { getCredentials: async () => stripeCreds }, () => stripe, () => "whsec-fixture", () => TENANT,
    { getCredentials: async () => vippsCreds }, () => vipps, () => "vipps-fixture", () => TENANT,
    undefined, undefined, undefined, undefined, opts.timing ? { submitTiming: opts.timing } : {}
  );
  const policy = new PolicyGateway({
    devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT] }
  });
  const gateway = new ToolGateway(appPool, policy, secretsOf(opts.secrets), undefined, undefined, {
    classDPipeline: { enforce: true, notifier },
    credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT], internalRefs: new Set(["JARVIS_BUSINESS_INTERNAL_TOKEN"]) }
  });
  const inner = new FinanceTransport(finance, { getCredentials: async () => fikenCreds });
  for (const tool of firstWaveTools({
    finance: opts.financeTransport ? opts.financeTransport(inner, finance) : inner,
    finance_stripe: new StripeFinanceTransport(finance),
    finance_vipps: new VippsFinanceTransport(finance)
  })) gateway.register(tool);
  return { stripe, vipps, fiken, finance, gateway, notifier };
}

const key = (prefix: string) => `${prefix}-${randomUUID()}`;
const submitIntent = (w: Wired, id: string, k = key("si"), extra: Record<string, JsonValue> = {}, who: IdentityContext = owner) =>
  w.gateway.execute({ identity: who, tool_id: "finance", action: "submit_payment_intent", parameters: { tenant_id: TENANT, payment_intent_id: id, ...extra }, idempotency_key: k });
const submitStripeRefund = (w: Wired, id: string, k = key("sr"), who: IdentityContext = owner) =>
  w.gateway.execute({ identity: who, tool_id: "finance_stripe", action: "submit_refund", parameters: { tenant_id: TENANT, refund_id: id }, idempotency_key: k });
const submitCapture = (w: Wired, id: string, k = key("sc"), who: IdentityContext = owner) =>
  w.gateway.execute({ identity: who, tool_id: "finance_vipps", action: "submit_capture", parameters: { tenant_id: TENANT, capture_id: id }, idempotency_key: k });
const submitVippsRefund = (w: Wired, id: string, k = key("svr"), who: IdentityContext = owner) =>
  w.gateway.execute({ identity: who, tool_id: "finance_vipps", action: "submit_refund", parameters: { tenant_id: TENANT, refund_id: id }, idempotency_key: k });

async function makeIntent(w: Wired, provider: "stripe" | "vipps" | "fiken", extra: Record<string, unknown> = {}): Promise<PaymentIntent> {
  const fikenExtra = provider === "fiken" ? { vendor_provider_ref: "kontakt-9988776655", counter_account_code: "1920" } : {};
  return w.finance.createPaymentIntent(TENANT, "business", {
    // unikt leverandørnavn per intensjon: ellers ville duplikatvernet (samme leverandør/beløp/valuta/provider siste døgn) riktig nok stoppe hver nye intensjon i denne delte DB-en
    idempotency_key: `idem-${randomUUID()}`, purpose: "WPF1 klasse D", amount_ore: 10_000, vendor_name: `Kunde ${randomUUID().slice(0, 8)} AS`,
    account_code: provider === "fiken" ? "6540" : "kategori", provider, ...fikenExtra, ...extra
  } as never);
}
const intentRow = async (id: string) => (await adminPool.query("SELECT * FROM payment_intents WHERE payment_intent_id = $1", [id])).rows[0] as Record<string, unknown>;
const ledgerRow = async (k: string) => (await adminPool.query("SELECT * FROM tool_executions WHERE idempotency_key = $1", [k])).rows[0] as Record<string, unknown> | undefined;
const row = async (table: string, idColumn: string, id: string) => (await adminPool.query(`SELECT * FROM ${table} WHERE ${idColumn} = $1`, [id])).rows[0] as Record<string, unknown>;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const waitFor = async (cond: () => boolean, ms = 5_000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("waitFor_timeout"); await new Promise((r) => setTimeout(r, 10)); } };

async function settledStripeIntent(w: Wired): Promise<PaymentIntent> {
  const intent = await makeIntent(w, "stripe");
  await adminPool.query("UPDATE payment_intents SET state = 'settled', provider_ref = $2, provider_status = 'succeeded', settled_at = now() WHERE payment_intent_id = $1", [intent.payment_intent_id, `pi_${randomUUID().slice(0, 8)}`]);
  return intent;
}
async function vippsIntentIn(w: Wired, state: "provider_acknowledged" | "settled" = "provider_acknowledged", status = "AUTHORIZED"): Promise<PaymentIntent> {
  const intent = await makeIntent(w, "vipps");
  await adminPool.query("UPDATE payment_intents SET state = $3, provider_ref = $2, provider_status = $4, provider_status_updated_at = now() WHERE payment_intent_id = $1", [intent.payment_intent_id, intent.payment_intent_id, state, status]);
  return intent;
}

describe("A: hver av de fire pengehandlingene gjennomføres med hele kjeden (fersk lesing, validering, etterbetingelse, varsel)", () => {
  it("Stripe-intensjon: ok med leverandør-ID, ledger `succeeded` med før-/etter-tilstand, audit, og umiddelbart varsel med redigert sammendrag", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    const k = key("a1");
    const r = await submitIntent(w, intent.payment_intent_id, k);
    expect(r).toMatchObject({ ok: true, external_id: intent.payment_intent_id, deduplicated: false, notified: true });
    expect(w.stripe.createCalls).toEqual([{ amountOre: 10_000, idempotencyKey: `stripe-submit:${intent.payment_intent_id}` }]);
    const after = await intentRow(intent.payment_intent_id);
    expect(after["state"]).toBe("provider_acknowledged");
    expect(String(after["provider_ref"])).toMatch(/^pi_/);

    const ledger = (await ledgerRow(k))!;
    expect(ledger["status"]).toBe("succeeded");
    expect((ledger["before_state"] as { payment_intent: { state: string } }).payment_intent.state).toBe("draft");
    expect((ledger["after_state"] as { payment_intent: { state: string; provider_ref: string } }).payment_intent).toMatchObject({ state: "provider_acknowledged", provider_ref: after["provider_ref"] });

    expect(w.notifier.sent).toHaveLength(1);
    expect(w.notifier.sent[0]).toMatchObject({
      outcome: "executed", tool_id: "finance", action: "submit_payment_intent", idempotency_key: k, external_id: intent.payment_intent_id, tenant_id: TENANT, person_id: OWNER,
      summary: `betaling 100,00 NOK til ${intent.vendor_name} via stripe (intensjon ${intent.payment_intent_id})`
    });
    expect(w.notifier.sent[0]!.recovery).toMatch(/Stripe/);
    const audit = (await adminPool.query("SELECT type, payload FROM audit_events WHERE tool_id = 'finance' AND action = 'submit_payment_intent' AND payload->>'external_id' = $1 ORDER BY audit_id DESC LIMIT 1", [intent.payment_intent_id])).rows[0] as { type: string; payload: Record<string, unknown> };
    expect(audit.type).toBe("tool.executed");
    expect(audit.payload["credential_ref"]).toBe("JARVIS_STRIPE_SECRET_KEY"); // referanse, aldri verdien
    expect(JSON.stringify(audit.payload)).not.toMatch(/sk_test_fixture/);
    expect(audit.payload["before_state"]).toBeTruthy();
    expect(audit.payload["after_state"]).toBeTruthy();
  });

  it("Vipps-intensjon og Fiken-postering: samme kjede; før-/etter-tilstanden er REDIGERT (leverandørreferansen er maskert)", async () => {
    const w = wire();
    const vipps = await makeIntent(w, "vipps");
    const rv = await submitIntent(w, vipps.payment_intent_id);
    expect(rv).toMatchObject({ ok: true, notified: true });
    expect(w.vipps.createCalls).toHaveLength(1);
    expect(w.notifier.sent[0]!.summary).toBe(`betaling 100,00 NOK til ${vipps.vendor_name} via vipps (intensjon ${vipps.payment_intent_id})`);

    const fiken = await makeIntent(w, "fiken");
    const kf = key("a2f");
    const rf = await submitIntent(w, fiken.payment_intent_id, kf);
    expect(rf).toMatchObject({ ok: true, notified: true });
    expect(w.fiken.calls).toBe(1);
    expect((await intentRow(fiken.payment_intent_id))["provider_ref"]).toBe("4242");
    const ledger = (await ledgerRow(kf))!;
    const stored = JSON.stringify([ledger["before_state"], ledger["after_state"]]);
    expect(stored).toContain("6655"); // de fire siste, kjennbart
    expect(stored).not.toContain("kontakt-9988776655"); // aldri leverandørreferansen i klartekst
    expect(stored).not.toContain("9988776655");
    const audit = (await adminPool.query("SELECT payload FROM audit_events WHERE tool_id = 'finance' AND action = 'submit_payment_intent' AND type = 'tool.executed' AND payload->>'external_id' = $1", [fiken.payment_intent_id])).rows[0] as { payload: unknown };
    expect(JSON.stringify(audit.payload)).not.toContain("9988776655");
    expect(w.notifier.sent.at(-1)!.summary).not.toMatch(/9988776655|1920/);
  });

  it("Stripe-refusjon: refusjon mot oppgjort betaling, leverandør-ID og tilstandsovergang bekreftet via readback", async () => {
    const w = wire();
    const parent = await settledStripeIntent(w);
    const refund = await w.finance.createStripeRefund(TENANT, "business", { idempotency_key: key("rf"), payment_intent_id: parent.payment_intent_id, amount_ore: 4_000 });
    const k = key("a3");
    const r = await submitStripeRefund(w, refund.refund_id, k);
    expect(r).toMatchObject({ ok: true, external_id: refund.refund_id, notified: true });
    expect(w.stripe.refundCalls).toEqual([{ amountOre: 4_000, idempotencyKey: `stripe-refund:${refund.refund_id}` }]);
    const after = await row("stripe_refunds", "refund_id", refund.refund_id);
    expect(after["state"]).toBe("settled");
    expect(String(after["provider_ref"])).toMatch(/^re_/);
    expect((await ledgerRow(k))!["status"]).toBe("succeeded");
    expect(w.notifier.sent[0]).toMatchObject({ outcome: "executed", summary: `refusjon 40,00 NOK via stripe (betaling ${parent.payment_intent_id}, ${parent.vendor_name})` });
  });

  it("Vipps-capture og Vipps-refusjon: samme kjede", async () => {
    const w = wire();
    const authorized = await vippsIntentIn(w);
    const capture = await w.finance.createVippsCapture(TENANT, "business", { idempotency_key: key("cap"), payment_intent_id: authorized.payment_intent_id, amount_ore: 3_000 });
    const rc = await submitCapture(w, capture.capture_id);
    expect(rc).toMatchObject({ ok: true, external_id: capture.capture_id, notified: true });
    expect(w.vipps.captureCalls).toEqual([{ amountOre: 3_000, idempotencyKey: `vipps-capture:${capture.capture_id}` }]);
    expect((await row("vipps_captures", "capture_id", capture.capture_id))["state"]).toBe("settled");
    expect(w.notifier.sent[0]!.summary).toBe(`capture 30,00 NOK via vipps (betaling ${authorized.payment_intent_id}, ${authorized.vendor_name})`);

    const settled = await vippsIntentIn(w, "settled");
    const refund = await w.finance.createVippsRefund(TENANT, "business", { idempotency_key: key("vr"), payment_intent_id: settled.payment_intent_id, amount_ore: 2_000 });
    const rr = await submitVippsRefund(w, refund.refund_id);
    expect(rr).toMatchObject({ ok: true, external_id: refund.refund_id, notified: true });
    expect(w.vipps.refundCalls).toEqual([{ amountOre: 2_000, idempotencyKey: `vipps-refund:${refund.refund_id}` }]);
    expect((await row("vipps_refunds", "refund_id", refund.refund_id))["state"]).toBe("settled");
  });

  it("alle fire definisjonene har hele klasse D-kjeden statisk (ingen DEFERRED) og krever step-up", () => {
    const w = wire();
    for (const [tool_id, action] of [["finance", "submit_payment_intent"], ["finance_stripe", "submit_refund"], ["finance_vipps", "submit_capture"], ["finance_vipps", "submit_refund"]] as const) {
      const def = w.gateway.get(tool_id, action)!;
      expect(assessClassDPipeline(def), `${tool_id}.${action}`).toEqual({ complete: true, missing: [] });
      expect(def.capability_class).toBe("D");
      expect(def.step_up_required).toBe(true);
      expect(def.preflight_validator).toBeTypeOf("function");
      expect(def.postcondition_predicate).toBeTypeOf("function");
      expect(def.notification_summary).toBeTypeOf("function");
      expect(def.rollback_procedure.length).toBeGreaterThan(40);
      expect(def.idempotent_external).toBe(true);
    }
  });
});

describe("B: retry kan ikke dobbeltbetale", () => {
  it("samme idempotency_key to ganger: andre svar er lagret utfall (deduplicated), én leverandørhandling og ett varsel", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    const k = key("b1");
    const first = await submitIntent(w, intent.payment_intent_id, k);
    const second = await submitIntent(w, intent.payment_intent_id, k);
    expect(first).toMatchObject({ ok: true, deduplicated: false });
    expect(second).toMatchObject({ ok: true, deduplicated: true, external_id: intent.payment_intent_id });
    expect(w.stripe.createCalls).toHaveLength(1);
    expect(w.stripe.distinctEffects).toBe(1);
    expect(w.notifier.sent).toHaveLength(1);
  });

  it("NY nøkkel etter gjennomført handling avvises i målvalideringen (aldri en ny leverandørhandling) - for alle fire", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    await submitIntent(w, intent.payment_intent_id);
    expect(await submitIntent(w, intent.payment_intent_id, key("b2"))).toEqual({ ok: false, reason: "preflight_invalid:not_submittable:provider_acknowledged" });

    const parent = await settledStripeIntent(w);
    const refund = await w.finance.createStripeRefund(TENANT, "business", { idempotency_key: key("rf"), payment_intent_id: parent.payment_intent_id, amount_ore: 1_000 });
    expect((await submitStripeRefund(w, refund.refund_id)).ok).toBe(true);
    expect(await submitStripeRefund(w, refund.refund_id, key("b2r"))).toEqual({ ok: false, reason: "preflight_invalid:not_submittable:settled" });

    const vp = await vippsIntentIn(w);
    const capture = await w.finance.createVippsCapture(TENANT, "business", { idempotency_key: key("cap"), payment_intent_id: vp.payment_intent_id, amount_ore: 500 });
    expect((await submitCapture(w, capture.capture_id)).ok).toBe(true);
    expect(await submitCapture(w, capture.capture_id, key("b2c"))).toEqual({ ok: false, reason: "preflight_invalid:not_submittable:settled" });

    const vs = await vippsIntentIn(w, "settled");
    const vrefund = await w.finance.createVippsRefund(TENANT, "business", { idempotency_key: key("vr"), payment_intent_id: vs.payment_intent_id, amount_ore: 700 });
    expect((await submitVippsRefund(w, vrefund.refund_id)).ok).toBe(true);
    expect(await submitVippsRefund(w, vrefund.refund_id, key("b2v"))).toEqual({ ok: false, reason: "preflight_invalid:not_submittable:settled" });

    expect(w.stripe.createCalls).toHaveLength(1);
    expect(w.stripe.refundCalls).toHaveLength(1);
    expect(w.vipps.captureCalls).toHaveLength(1);
    expect(w.vipps.refundCalls).toHaveLength(1);
  });

  it("to SAMTIDIGE kall med SAMME nøkkel: ett går gjennom, det andre ser `execution_in_flight_or_outcome_unknown`; leverandøren kalles én gang", async () => {
    const w = wire();
    w.stripe.gate = new Gate();
    const intent = await makeIntent(w, "stripe");
    const k = key("b3");
    const first = submitIntent(w, intent.payment_intent_id, k);
    await waitFor(() => w.stripe.createCalls.length === 1);
    const second = await submitIntent(w, intent.payment_intent_id, k);
    expect(second).toEqual({ ok: false, reason: "execution_in_flight_or_outcome_unknown" });
    w.stripe.gate.open();
    expect((await first).ok).toBe(true);
    expect(w.stripe.createCalls).toHaveLength(1);
  });

  it("to samtidige kall med FORSKJELLIGE nøkler (mens det første er i flukt): det andre stoppes av reservasjonen - ett leverandørkall", async () => {
    const w = wire();
    w.stripe.gate = new Gate();
    const intent = await makeIntent(w, "stripe");
    const first = submitIntent(w, intent.payment_intent_id, key("b4a"));
    await waitFor(() => w.stripe.createCalls.length === 1);
    const second = await submitIntent(w, intent.payment_intent_id, key("b4b"));
    expect(second).toEqual({ ok: false, reason: "preflight_invalid:submit_in_flight" });
    w.stripe.gate.open();
    expect((await first).ok).toBe(true);
    expect(w.stripe.createCalls).toHaveLength(1);
    expect(w.stripe.distinctEffects).toBe(1);
  });

  it("seks samtidige kall uten pause, ulike nøkler: UANSETT interleaving er det nøyaktig én leverandørhandling (og aldri to «utført»-varsler med ulik effekt)", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    const results = await Promise.all(Array.from({ length: 6 }, () => submitIntent(w, intent.payment_intent_id)));
    expect(w.stripe.createCalls).toHaveLength(1);
    expect(w.stripe.distinctEffects).toBe(1);
    expect(results.some((r) => r.ok)).toBe(true);
    for (const r of results) {
      if (!r.ok) expect(r.reason, r.reason).toMatch(/^(preflight_invalid:(submit_in_flight|not_submittable:provider_acknowledged)|tool_failed:submit_in_flight)/);
    }
    expect((await intentRow(intent.payment_intent_id))["state"]).toBe("provider_acknowledged");
    const submittedEvents = await adminPool.query("SELECT count(*)::int AS n FROM payment_intent_events WHERE payment_intent_id = $1 AND event_type = 'submitted'", [intent.payment_intent_id]);
    expect((submittedEvents.rows[0] as { n: number }).n).toBe(1);
  });

  it("samtidige refusjon-/capture-kall: ett leverandørkall hver (reservasjonen, ikke bare ledgeren, hindrer dobbel effekt)", async () => {
    const w = wire();
    const parent = await settledStripeIntent(w);
    const refund = await w.finance.createStripeRefund(TENANT, "business", { idempotency_key: key("rf"), payment_intent_id: parent.payment_intent_id, amount_ore: 2_000 });
    const vp = await vippsIntentIn(w);
    const capture = await w.finance.createVippsCapture(TENANT, "business", { idempotency_key: key("cap"), payment_intent_id: vp.payment_intent_id, amount_ore: 2_500 });
    const rs = await Promise.all([...Array.from({ length: 4 }, () => submitStripeRefund(w, refund.refund_id)), ...Array.from({ length: 4 }, () => submitCapture(w, capture.capture_id))]);
    expect(w.stripe.refundCalls).toHaveLength(1);
    expect(w.vipps.captureCalls).toHaveLength(1);
    expect(rs.filter((r) => r.ok).length).toBeGreaterThanOrEqual(2);
  });
});

describe("C: krasj mellom reservasjon og leverandørkall", () => {
  it("reservasjon som er ny = pågående (ingen leverandørkall); utløpt lease gjenopptas for Stripe/Vipps med SAMME Idempotency-Key", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    await adminPool.query("UPDATE payment_intents SET state = 'submitted', submitted_at = now(), first_submit_attempt_at = now() WHERE payment_intent_id = $1", [intent.payment_intent_id]);
    expect(await submitIntent(w, intent.payment_intent_id, key("c1"))).toEqual({ ok: false, reason: "preflight_invalid:submit_in_flight" });
    expect(w.stripe.createCalls).toHaveLength(0);
    await adminPool.query("UPDATE payment_intents SET submitted_at = $2, first_submit_attempt_at = $2 WHERE payment_intent_id = $1", [intent.payment_intent_id, minutesAgo(10)]);
    expect((await submitIntent(w, intent.payment_intent_id, key("c1b"))).ok).toBe(true);
    expect(w.stripe.createCalls).toEqual([{ amountOre: 10_000, idempotencyKey: `stripe-submit:${intent.payment_intent_id}` }]);
  });

  it("Fiken (ingen Idempotency-Key hos leverandøren): en krasjet reservasjon gjenopptas ALDRI automatisk - avstemming, null Fiken-kall", async () => {
    const w = wire();
    const intent = await makeIntent(w, "fiken");
    await adminPool.query("UPDATE payment_intents SET state = 'submitted', submitted_at = $2, first_submit_attempt_at = $2 WHERE payment_intent_id = $1", [intent.payment_intent_id, minutesAgo(30)]);
    expect(await submitIntent(w, intent.payment_intent_id, key("c2"))).toEqual({ ok: false, reason: "preflight_invalid:submit_outcome_unknown_reconcile_required" });
    expect(w.fiken.calls).toBe(0);
    expect(w.notifier.sent).toEqual([]);
  });

  it("første forsøk eldre enn leverandørens idempotensvindu (23 t): ingen automatisk gjenopptakelse - kunne opprettet et NYTT objekt", async () => {
    const w = wire();
    const a = await makeIntent(w, "stripe");
    await adminPool.query("UPDATE payment_intents SET state = 'submitted', submitted_at = $2, first_submit_attempt_at = $3 WHERE payment_intent_id = $1", [a.payment_intent_id, minutesAgo(10), minutesAgo(24 * 60)]);
    expect(await submitIntent(w, a.payment_intent_id, key("c3"))).toEqual({ ok: false, reason: "preflight_invalid:submit_outcome_unknown_reconcile_required" });
    const b = await makeIntent(w, "stripe");
    await adminPool.query("UPDATE payment_intents SET first_submit_attempt_at = $2 WHERE payment_intent_id = $1", [b.payment_intent_id, minutesAgo(24 * 60)]);
    expect(await submitIntent(w, b.payment_intent_id, key("c3b"))).toEqual({ ok: false, reason: "preflight_invalid:submit_window_expired_reconcile_required" });
    expect(w.stripe.createCalls).toHaveLength(0);
  });

  it("refusjon/capture med ny reservasjon: pågående; med utløpt vindu: avstemming", async () => {
    const w = wire();
    const parent = await settledStripeIntent(w);
    const refund = await w.finance.createStripeRefund(TENANT, "business", { idempotency_key: key("rf"), payment_intent_id: parent.payment_intent_id, amount_ore: 1_000 });
    await adminPool.query("UPDATE stripe_refunds SET state = 'submitted', submitted_at = now(), first_submit_attempt_at = now() WHERE refund_id = $1", [refund.refund_id]);
    expect(await submitStripeRefund(w, refund.refund_id)).toEqual({ ok: false, reason: "preflight_invalid:submit_in_flight" });
    const vp = await vippsIntentIn(w);
    const capture = await w.finance.createVippsCapture(TENANT, "business", { idempotency_key: key("cap"), payment_intent_id: vp.payment_intent_id, amount_ore: 500 });
    await adminPool.query("UPDATE vipps_captures SET state = 'submitted', submitted_at = $2, first_submit_attempt_at = $3 WHERE capture_id = $1", [capture.capture_id, minutesAgo(10), minutesAgo(24 * 60)]);
    expect(await submitCapture(w, capture.capture_id)).toEqual({ ok: false, reason: "preflight_invalid:submit_outcome_unknown_reconcile_required" });
    expect(w.stripe.refundCalls).toHaveLength(0);
    expect(w.vipps.captureCalls).toHaveLength(0);
  });
});

describe("D: leverandør-tidsavbrudd med ukjent utfall ender i avstemming - aldri en ny betaling", () => {
  it("Stripe-intensjon: `unverified` i ledgeren, varsel `unknown`, ikke retry-bar med samme nøkkel, listet i reconcile(); ny nøkkel gjenbruker leverandørens Idempotency-Key (én effekt)", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    w.stripe.fail = timeoutError;
    const k = key("d1");
    const first = await submitIntent(w, intent.payment_intent_id, k);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.reason).toMatch(/^tool_failed:outcome_unknown:/);
    expect((await ledgerRow(k))!["status"]).toBe("unverified");
    expect(w.notifier.sent).toHaveLength(1);
    expect(w.notifier.sent[0]).toMatchObject({ outcome: "unknown", external_id: null, idempotency_key: k, summary: `betaling 100,00 NOK til ${intent.vendor_name} via stripe (intensjon ${intent.payment_intent_id})` });
    expect(w.notifier.sent[0]!.recovery).toMatch(/UKJENT utfall/);
    const flagged = await intentRow(intent.payment_intent_id);
    expect(flagged["state"]).toBe("draft");
    expect(flagged["anomaly_flags"]).toContain("SUBMIT_OUTCOME_UNKNOWN");

    // avstemmingskøen viser raden, med gjenopprettingsplan og før-tilstand (aldri en automatisk ny mutasjon)
    const queue = await w.gateway.reconcile(TENANT);
    const hit = queue.find((q) => q.idempotency_key === k);
    expect(hit).toMatchObject({ tool_id: "finance", action: "submit_payment_intent", status: "unverified", reason: "postcondition_unverified:tool_timeout_outcome_unknown" });
    expect(hit!.recovery).toMatch(/get_reconciliation_status|Stripe/);
    expect((hit!.before_state as { payment_intent: { payment_intent_id: string } }).payment_intent.payment_intent_id).toBe(intent.payment_intent_id);

    // samme nøkkel igjen: lagret utfall, ingen nytt leverandørkall
    w.stripe.fail = null;
    expect(await submitIntent(w, intent.payment_intent_id, k)).toEqual({ ok: false, reason: "postcondition_unverified:tool_timeout_outcome_unknown" });
    expect(w.stripe.createCalls).toHaveLength(1);

    // eierens eksplisitte nye forsøk (ny nøkkel): SAMME Idempotency-Key hos Stripe -> leverandøren slår sammen -> nøyaktig én effekt
    const again = await submitIntent(w, intent.payment_intent_id, key("d1b"));
    expect(again.ok).toBe(true);
    expect(w.stripe.createCalls).toHaveLength(2);
    expect(new Set(w.stripe.createCalls.map((c) => c.idempotencyKey))).toEqual(new Set([`stripe-submit:${intent.payment_intent_id}`]));
    expect(w.stripe.distinctEffects).toBe(1);
    expect((await intentRow(intent.payment_intent_id))["anomaly_flags"]).not.toContain("SUBMIT_OUTCOME_UNKNOWN");
  });

  it("Fiken-postering (ingen Idempotency-Key): tidsavbrudd gir ukjent utfall og INGEN ny postering - verken med samme eller ny nøkkel", async () => {
    const w = wire();
    const intent = await makeIntent(w, "fiken");
    w.fiken.fail = timeoutError;
    const first = await submitIntent(w, intent.payment_intent_id, key("d2"));
    expect(first.ok).toBe(false);
    expect(w.notifier.sent.map((n) => n.outcome)).toEqual(["unknown"]);
    w.fiken.fail = null;
    expect(await submitIntent(w, intent.payment_intent_id, key("d2b"))).toEqual({ ok: false, reason: "preflight_invalid:submit_outcome_unknown_reconcile_required" });
    expect(w.fiken.calls).toBe(1);
    const after = await intentRow(intent.payment_intent_id);
    expect(after["state"]).toBe("submitted");
    expect(after["provider_ref"]).toBeNull();
    expect(after["anomaly_flags"]).toContain("SUBMIT_OUTCOME_UNKNOWN");
  });

  it("refusjon og capture: tidsavbrudd gir `unverified` + varsel `unknown`; nytt forsøk bruker samme leverandørnøkkel", async () => {
    const w = wire();
    const parent = await settledStripeIntent(w);
    const refund = await w.finance.createStripeRefund(TENANT, "business", { idempotency_key: key("rf"), payment_intent_id: parent.payment_intent_id, amount_ore: 2_500 });
    w.stripe.fail = timeoutError;
    const k = key("d3");
    expect((await submitStripeRefund(w, refund.refund_id, k)).ok).toBe(false);
    expect((await ledgerRow(k))!["status"]).toBe("unverified");
    expect(w.notifier.sent.at(-1)!.outcome).toBe("unknown");
    w.stripe.fail = null;
    expect((await submitStripeRefund(w, refund.refund_id, key("d3b"))).ok).toBe(true);
    expect(new Set(w.stripe.refundCalls.map((c) => c.idempotencyKey))).toEqual(new Set([`stripe-refund:${refund.refund_id}`]));
    expect(w.stripe.distinctEffects).toBe(1);

    const vp = await vippsIntentIn(w);
    const capture = await w.finance.createVippsCapture(TENANT, "business", { idempotency_key: key("cap"), payment_intent_id: vp.payment_intent_id, amount_ore: 1_500 });
    w.vipps.fail = () => Object.assign(new Error("vipps_api_failed_503:hangup"), { httpStatus: 503 });
    const kc = key("d3c");
    expect((await submitCapture(w, capture.capture_id, kc)).ok).toBe(false);
    expect((await ledgerRow(kc))!["status"]).toBe("unverified");
    w.vipps.fail = null;
    expect((await submitCapture(w, capture.capture_id, key("d3d"))).ok).toBe(true);
    expect(new Set(w.vipps.captureCalls.map((c) => c.idempotencyKey))).toEqual(new Set([`vipps-capture:${capture.capture_id}`]));
  });

  it("entydig avvisning (4xx) er `failed`, ikke ukjent: ingen varsel, reservasjonen frigjort, samme nøkkel kan forsøkes igjen når leverandøren er rettet", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    w.stripe.fail = () => Object.assign(new Error("stripe_api_error_400:invalid_request"), { httpStatus: 400 });
    const k = key("d4");
    const first = await submitIntent(w, intent.payment_intent_id, k);
    expect(first).toEqual({ ok: false, reason: "tool_failed:stripe_api_error_400:invalid_request" });
    expect((await ledgerRow(k))!["status"]).toBe("failed");
    expect(w.notifier.sent).toEqual([]);
    expect((await intentRow(intent.payment_intent_id))["state"]).toBe("draft");
    w.stripe.fail = null;
    expect((await submitIntent(w, intent.payment_intent_id, k)).ok).toBe(true);
    expect(w.stripe.distinctEffects).toBe(1);
  });
});

describe("E: finans-kill-switch stopper nye transaksjoner umiddelbart", () => {
  it("aktiv nødbryter: avvist i målvalideringen FØR reservasjon og leverandørkall (null kall, ingen ledger-rad); etter deaktivering går SAMME nøkkel gjennom", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    const parent = await settledStripeIntent(w);
    const refund = await w.finance.createStripeRefund(TENANT, "business", { idempotency_key: key("rf"), payment_intent_id: parent.payment_intent_id, amount_ore: 1_000 });
    const vp = await vippsIntentIn(w);
    const capture = await w.finance.createVippsCapture(TENANT, "business", { idempotency_key: key("cap"), payment_intent_id: vp.payment_intent_id, amount_ore: 500 });
    const vs = await vippsIntentIn(w, "settled");
    const vrefund = await w.finance.createVippsRefund(TENANT, "business", { idempotency_key: key("vr"), payment_intent_id: vs.payment_intent_id, amount_ore: 700 });
    await w.finance.enableKillSwitch(TENANT, OWNER, "wpf1-test");
    const keys = [key("e1a"), key("e1b"), key("e1c"), key("e1d")];
    try {
      expect(await submitIntent(w, intent.payment_intent_id, keys[0])).toEqual({ ok: false, reason: "preflight_invalid:finance_kill_switch_active" });
      expect(await submitStripeRefund(w, refund.refund_id, keys[1])).toEqual({ ok: false, reason: "preflight_invalid:finance_kill_switch_active" });
      expect(await submitCapture(w, capture.capture_id, keys[2])).toEqual({ ok: false, reason: "preflight_invalid:finance_kill_switch_active" });
      expect(await submitVippsRefund(w, vrefund.refund_id, keys[3])).toEqual({ ok: false, reason: "preflight_invalid:finance_kill_switch_active" });
      expect(w.stripe.createCalls).toHaveLength(0);
      expect(w.stripe.refundCalls).toHaveLength(0);
      expect(w.vipps.captureCalls).toHaveLength(0);
      expect(w.vipps.refundCalls).toHaveLength(0);
      for (const k of keys) expect(await ledgerRow(k)).toBeUndefined();
    } finally {
      await w.finance.disableKillSwitch(TENANT, OWNER);
    }
    expect((await submitIntent(w, intent.payment_intent_id, keys[0])).ok).toBe(true);
  });

  it("nødbryteren slås på ETTER målvalideringen men FØR reservasjonen (race): tjenesten blokkerer selv - fortsatt null leverandørkall", async () => {
    let armed = true;
    let fin: FinanceService | undefined;
    const w = wire({
      financeTransport: (inner, finance) => {
        fin = finance;
        return { invoke: async (action, parameters) => {
          const out = await inner.invoke(action, parameters);
          if (action === "check_submit_payment_intent" && armed) { armed = false; await finance.enableKillSwitch(TENANT, OWNER, "race"); }
          return out;
        } };
      }
    });
    const intent = await makeIntent(w, "stripe");
    const k = key("e2");
    try {
      const r = await submitIntent(w, intent.payment_intent_id, k);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/^tool_failed:/);
      expect(w.stripe.createCalls).toHaveLength(0);
      expect((await ledgerRow(k))!["status"]).toBe("failed");
      expect((await intentRow(intent.payment_intent_id))["state"]).toBe("draft");
    } finally {
      await fin!.disableKillSwitch(TENANT, OWNER);
    }
  });
});

describe("F: feil konto/leverandør/beløpsformat/valuta og duplikater fanges deterministisk FØR noe leverandørkall", () => {
  it("ukjent mål, mål i en annen tenant og feil leverandørtype stoppes (credential_ref_unresolved for intensjoner, preflight_target_not_found for refusjon/capture)", async () => {
    const w = wire();
    // en ukjent intensjon har ingen provider å løse credential for -> fail-closed allerede der (aldri en antatt credential)
    expect(await submitIntent(w, "fin-pi-finnes-ikke")).toEqual({ ok: false, reason: "credential_ref_unresolved" });
    // en intensjon i en ANNEN tenant er usynlig (RLS) selv om id-en er kjent
    const other = new FinanceService(appPool, () => new FikenFake());
    const foreign = await other.createPaymentIntent(TENANT_B, "business", { idempotency_key: key("f1"), purpose: "annen tenant", amount_ore: 1_000, vendor_name: "X", account_code: "kategori", provider: "stripe" });
    expect(await submitIntent(w, foreign.payment_intent_id)).toEqual({ ok: false, reason: "credential_ref_unresolved" });
    expect(await submitStripeRefund(w, "fin-rf-finnes-ikke")).toEqual({ ok: false, reason: "preflight_target_not_found" });
    // en Stripe-refusjons-id gitt til Vipps-refusjon er et annet mål
    const parent = await settledStripeIntent(w);
    const refund = await w.finance.createStripeRefund(TENANT, "business", { idempotency_key: key("rf"), payment_intent_id: parent.payment_intent_id, amount_ore: 1_000 });
    expect(await submitVippsRefund(w, refund.refund_id)).toEqual({ ok: false, reason: "preflight_target_not_found" });
    expect(await submitCapture(w, refund.refund_id)).toEqual({ ok: false, reason: "preflight_target_not_found" });
    expect(w.stripe.createCalls).toHaveLength(0);
    expect(w.stripe.refundCalls).toHaveLength(0);
  });

  it("Fiken: annen valuta enn NOK, manglende motkonto og manglende leverandørreferanse avvises med spesifikk årsak", async () => {
    const w = wire();
    const eur = await makeIntent(w, "fiken", { currency: "EUR" });
    expect(await submitIntent(w, eur.payment_intent_id)).toEqual({ ok: false, reason: "preflight_invalid:currency_not_supported_for_provider:fiken" });
    const noCounter = await makeIntent(w, "fiken", { counter_account_code: undefined });
    expect(await submitIntent(w, noCounter.payment_intent_id)).toEqual({ ok: false, reason: "preflight_invalid:missing_counter_account_code" });
    const noVendorRef = await makeIntent(w, "fiken", { vendor_provider_ref: undefined });
    expect(await submitIntent(w, noVendorRef.payment_intent_id)).toEqual({ ok: false, reason: "preflight_invalid:missing_vendor_provider_ref" });
    expect(w.fiken.calls).toBe(0);
  });

  it("leverandør-binding (D-116): tilbakekalt binding stopper innsendingen; gyldig binding slipper gjennom", async () => {
    const w = wire();
    const vendor = await w.finance.createVendor(TENANT, "business", "Leverandør AS", OWNER);
    await w.finance.bindVendorProvider(TENANT, "business", vendor.vendor_id, "fiken", "kontakt-9988776655", OWNER);
    const good = await makeIntent(w, "fiken", { vendor_id: vendor.vendor_id });
    const revoked = await makeIntent(w, "fiken", { vendor_id: vendor.vendor_id });
    expect((await submitIntent(w, good.payment_intent_id)).ok).toBe(true);
    await w.finance.revokeVendorProviderBinding(TENANT, "business", "fiken", "kontakt-9988776655", OWNER);
    expect(await submitIntent(w, revoked.payment_intent_id)).toEqual({ ok: false, reason: "preflight_invalid:vendor_binding_invalid:binding_revoked" });
    expect(w.fiken.calls).toBe(1);
  });

  it("mulig duplikat: samme leverandør/beløp/valuta/provider som en allerede sendt avvises til eieren eksplisitt kvitterer for id-en", async () => {
    const w = wire();
    const a = await makeIntent(w, "stripe", { vendor_name: "Duplikat Leverandør AS", amount_ore: 77_700 });
    const b = await makeIntent(w, "stripe", { vendor_name: "duplikat leverandør as", amount_ore: 77_700 });
    expect((await submitIntent(w, a.payment_intent_id)).ok).toBe(true);
    expect(await submitIntent(w, b.payment_intent_id)).toEqual({ ok: false, reason: `preflight_invalid:possible_duplicate_of:${a.payment_intent_id}` });
    expect(w.stripe.createCalls).toHaveLength(1);
    // feil id i kvitteringen hjelper ikke
    expect((await submitIntent(w, b.payment_intent_id, key("f4"), { confirm_possible_duplicate_of: ["fin-pi-noe-annet"] })).ok).toBe(false);
    // riktig id: eieren har sett den og tar ansvar
    const confirmed = await submitIntent(w, b.payment_intent_id, key("f4b"), { confirm_possible_duplicate_of: [a.payment_intent_id] });
    expect(confirmed.ok).toBe(true);
    expect(w.stripe.createCalls).toHaveLength(2);
  });

  it("refusjon: over opprinnelig beløp, ikke-oppgjort betaling og valutaavvik avvises (tilstand tvunget via SQL for å treffe validatoren, ikke tjenestens egen vokter)", async () => {
    const w = wire();
    const parent = await settledStripeIntent(w);
    const refund = await w.finance.createStripeRefund(TENANT, "business", { idempotency_key: key("rf"), payment_intent_id: parent.payment_intent_id, amount_ore: 4_000 });
    // Pengekolonnene er uforanderlige (migrasjon 101) - fixturen slår triggeren av KUN mens den tvinger fram en tilstand tjenesten selv aldri ville produsert.
    const force = async (sqlText: string) => {
      await adminPool.query("ALTER TABLE stripe_refunds DISABLE TRIGGER stripe_refunds_money_immutable");
      try { await adminPool.query(sqlText, [refund.refund_id]); } finally { await adminPool.query("ALTER TABLE stripe_refunds ENABLE TRIGGER stripe_refunds_money_immutable"); }
    };
    await force("UPDATE stripe_refunds SET amount_ore = 10001 WHERE refund_id = $1");
    expect(await submitStripeRefund(w, refund.refund_id)).toEqual({ ok: false, reason: "preflight_invalid:exceeds_parent_amount" });
    await force("UPDATE stripe_refunds SET amount_ore = 4000, currency = 'EUR' WHERE refund_id = $1");
    expect(await submitStripeRefund(w, refund.refund_id)).toEqual({ ok: false, reason: "preflight_invalid:currency_mismatch_with_parent" });
    await force("UPDATE stripe_refunds SET currency = 'NOK' WHERE refund_id = $1");
    await adminPool.query("UPDATE payment_intents SET state = 'provider_acknowledged' WHERE payment_intent_id = $1", [parent.payment_intent_id]);
    expect(await submitStripeRefund(w, refund.refund_id)).toEqual({ ok: false, reason: "preflight_invalid:parent_not_settled:provider_acknowledged" });
    expect(w.stripe.refundCalls).toHaveLength(0);
  });

  it("Vipps-capture mot en betaling som ikke er autorisert (venter på brukeren / allerede oppgjort) avvises", async () => {
    const w = wire();
    const waiting = await vippsIntentIn(w, "provider_acknowledged", "CREATED");
    const c1 = await w.finance.createVippsCapture(TENANT, "business", { idempotency_key: key("cap"), payment_intent_id: waiting.payment_intent_id, amount_ore: 500 });
    expect(await submitCapture(w, c1.capture_id)).toEqual({ ok: false, reason: "preflight_invalid:parent_not_authorized:CREATED" });
    const done = await vippsIntentIn(w);
    const c2 = await w.finance.createVippsCapture(TENANT, "business", { idempotency_key: key("cap"), payment_intent_id: done.payment_intent_id, amount_ore: 500 });
    await adminPool.query("UPDATE payment_intents SET state = 'settled' WHERE payment_intent_id = $1", [done.payment_intent_id]);
    expect(await submitCapture(w, c2.capture_id)).toEqual({ ok: false, reason: "preflight_invalid:parent_not_capturable:settled" });
    expect(w.vipps.captureCalls).toHaveLength(0);
  });

  it("Neonomics: debitor-konto må finnes, være aktiv og ha aktivt samtykke (den ferske lesingen speiler tjenestens egen kontroll)", async () => {
    const w = wire();
    const neo = await w.finance.createPaymentIntent(TENANT, "business", {
      idempotency_key: key("neo"), purpose: "bankbetaling", amount_ore: 5_000, vendor_name: "Kreditor AS", vendor_provider_ref: "NO9386011117947",
      counter_account_code: "bank-acc-wpf1", account_code: "kategori", provider: "neonomics"
    });
    const noAccount = await w.finance.checkSubmitPaymentIntent(TENANT, "business", neo.payment_intent_id);
    expect(noAccount!.checks.debtor_account).toBe("invalid:account_not_found_or_inactive");
    expect(noAccount!.payment_intent.vendor_ref_masked).toBe("…7947 (15)"); // kreditorens kontonummer er maskert
    expect(JSON.stringify(noAccount)).not.toContain("NO9386011117947");
    await adminPool.query(`INSERT INTO bank_consents (consent_id, tenant_id, bank_id, state, provider_session_id) VALUES ('consent-wpf1', '${TENANT}', 'bank-1', 'authorization_required', NULL)`);
    await adminPool.query(`INSERT INTO bank_accounts (bank_account_id, tenant_id, provider_account_id, consent_id, bank_id) VALUES ('bank-acc-wpf1', '${TENANT}', 'prov-acc-1', 'consent-wpf1', 'bank-1')`);
    expect((await w.finance.checkSubmitPaymentIntent(TENANT, "business", neo.payment_intent_id))!.checks.debtor_account).toBe("invalid:consent_not_active");
    await adminPool.query("UPDATE bank_consents SET state = 'active', provider_session_id = 'sess-1' WHERE consent_id = 'consent-wpf1'");
    expect((await w.finance.checkSubmitPaymentIntent(TENANT, "business", neo.payment_intent_id))!.checks.debtor_account).toBe("valid");
    await adminPool.query("UPDATE bank_accounts SET active = false WHERE bank_account_id = 'bank-acc-wpf1'");
    expect((await w.finance.checkSubmitPaymentIntent(TENANT, "business", neo.payment_intent_id))!.checks.debtor_account).toBe("invalid:account_not_found_or_inactive");
  });

  it("leverandørens ekko som avviker fra det vi ba om (beløp) gir `unverified` og varsel `unverified` - aldri en stille suksess", async () => {
    const stripe = new StripeFake();
    const original = stripe.createPaymentIntent.bind(stripe);
    stripe.createPaymentIntent = async (input) => ({ ...(await original(input)), amount: input.amountOre + 1 });
    const w = wire({ stripe });
    const intent = await makeIntent(w, "stripe");
    const k = key("f8");
    const r = await submitIntent(w, intent.payment_intent_id, k);
    expect(r).toEqual({ ok: false, reason: "postcondition_mismatch" });
    expect((await ledgerRow(k))!["status"]).toBe("unverified");
    expect(w.notifier.sent.map((n) => n.outcome)).toEqual(["unverified"]);
    expect(w.notifier.sent[0]!.external_id).toBe(intent.payment_intent_id);
  });
});

describe("G: credential bestemmes av intensjonens provider (JARVIS-072), ikke statisk Fiken", () => {
  it("Stripe/Vipps-intensjon krever IKKE Fiken-credential", async () => {
    const w = wire({ secrets: { JARVIS_FIKEN_REFRESH_TOKEN: null } });
    const s = await makeIntent(w, "stripe");
    const v = await makeIntent(w, "vipps");
    expect((await submitIntent(w, s.payment_intent_id)).ok).toBe(true);
    expect((await submitIntent(w, v.payment_intent_id)).ok).toBe(true);
  });

  it("manglende credential for AKKURAT intensjonens provider avvises som credential_unavailable - ingen leverandørkall, ingen ledger-rad, ingen tilstandsendring", async () => {
    const w = wire({ secrets: { JARVIS_FIKEN_REFRESH_TOKEN: null, JARVIS_STRIPE_SECRET_KEY: null } });
    const f = await makeIntent(w, "fiken");
    const s = await makeIntent(w, "stripe");
    const kf = key("g2f");
    expect(await submitIntent(w, f.payment_intent_id, kf)).toEqual({ ok: false, reason: "credential_unavailable" });
    expect(await submitIntent(w, s.payment_intent_id)).toEqual({ ok: false, reason: "credential_unavailable" });
    expect(await ledgerRow(kf)).toBeUndefined();
    expect(w.fiken.calls).toBe(0);
    expect(w.stripe.createCalls).toHaveLength(0);
    expect((await intentRow(s.payment_intent_id))["state"]).toBe("draft");
    // Vipps-intensjonen er upåvirket av at Stripe/Fiken mangler
    const v = await makeIntent(w, "vipps");
    expect((await submitIntent(w, v.payment_intent_id)).ok).toBe(true);
  });

  it("ukjent intensjon (kan ikke løse provider) -> credential_ref_unresolved, fail-closed", async () => {
    const w = wire();
    expect(await submitIntent(w, "fin-pi-finnes-ikke")).toEqual({ ok: false, reason: "credential_ref_unresolved" });
  });
});

describe("H: pipeline-portene og eier-isolasjon", () => {
  it("varsleren ikke klar: pengehandlingen er utilgjengelig (fail-closed), ingen leverandørkall", async () => {
    const notifier = new FakeNotifier();
    notifier.isReady = false;
    const w = wire({ notifier });
    const intent = await makeIntent(w, "stripe");
    expect(await submitIntent(w, intent.payment_intent_id)).toEqual({ ok: false, reason: "class_d_notifier_not_ready" });
    expect(w.stripe.createCalls).toHaveLength(0);
  });

  it("idempotency_key er påkrevd", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    const r = await w.gateway.execute({ identity: owner, tool_id: "finance", action: "submit_payment_intent", parameters: { tenant_id: TENANT, payment_intent_id: intent.payment_intent_id } });
    expect(r).toEqual({ ok: false, reason: "class_d_idempotency_key_required" });
    expect(w.stripe.createCalls).toHaveLength(0);
  });

  it("step-up: uten signert enhetsøkt fra eier-kanal er alle fire avvist FØR noe leses - også for eieren selv", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    const parent = await settledStripeIntent(w);
    const refund = await w.finance.createStripeRefund(TENANT, "business", { idempotency_key: key("rf"), payment_intent_id: parent.payment_intent_id, amount_ore: 1_000 });
    const vp = await vippsIntentIn(w);
    const capture = await w.finance.createVippsCapture(TENANT, "business", { idempotency_key: key("cap"), payment_intent_id: vp.payment_intent_id, amount_ore: 500 });
    const vs = await vippsIntentIn(w, "settled");
    const vrefund = await w.finance.createVippsRefund(TENANT, "business", { idempotency_key: key("vr"), payment_intent_id: vs.payment_intent_id, amount_ore: 700 });
    const weak: IdentityContext[] = [
      { ...owner, auth_strength: "active" }, { ...owner, auth_strength: "passive" },
      { ...owner, channel: "telegram" }, { ...owner, channel: "voice" }, { ...owner, channel: "system" }, { ...owner, channel: "watch" }
    ];
    for (const who of weak) {
      const expected = who.auth_strength !== "signed" ? "step_up_required:signed_device_session" : `step_up_required:channel_${who.channel}_not_allowed`;
      expect(await submitIntent(w, intent.payment_intent_id, key("h3"), {}, who), `${who.channel}/${who.auth_strength}`).toEqual({ ok: false, reason: expected });
      expect(await submitStripeRefund(w, refund.refund_id, key("h3"), who)).toEqual({ ok: false, reason: expected });
      expect(await submitCapture(w, capture.capture_id, key("h3"), who)).toEqual({ ok: false, reason: expected });
      expect(await submitVippsRefund(w, vrefund.refund_id, key("h3"), who)).toEqual({ ok: false, reason: expected });
    }
    expect(w.stripe.createCalls).toHaveLength(0);
    expect(w.stripe.refundCalls).toHaveLength(0);
    expect(w.vipps.captureCalls).toHaveLength(0);
    expect(w.vipps.refundCalls).toHaveLength(0);
    for (const state of [(await intentRow(intent.payment_intent_id))["state"], (await row("stripe_refunds", "refund_id", refund.refund_id))["state"], (await row("vipps_captures", "capture_id", capture.capture_id))["state"], (await row("vipps_refunds", "refund_id", vrefund.refund_id))["state"]]) {
      expect(state).toBe("draft");
    }
  });

  it("andre enn eieren (gjest i samme tenant, delegat, annen tenants eier) når aldri leverandørkallet", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    const guest: IdentityContext = { ...owner, person_id: GUEST };
    const delegate: IdentityContext = { ...owner, delegation_id: "deleg-1" };
    expect(await submitIntent(w, intent.payment_intent_id, key("h4"), {}, guest)).toEqual({ ok: false, reason: "credential_not_bound_to_identity" });
    expect(await submitIntent(w, intent.payment_intent_id, key("h4b"), {}, delegate)).toEqual({ ok: false, reason: "credential_not_bound_to_identity" });
    // tenant_id i parametrene må være den autentiserte identitetens
    const r = await w.gateway.execute({ identity: owner, tool_id: "finance", action: "submit_payment_intent", parameters: { tenant_id: TENANT_B, payment_intent_id: intent.payment_intent_id }, idempotency_key: key("h4c") });
    expect(r).toEqual({ ok: false, reason: "scope_mismatch:tenant_id" });
    // ukjente parametre (injeksjon av ekstra felt) avvises av det strenge skjemaet
    const extra = await w.gateway.execute({ identity: owner, tool_id: "finance", action: "submit_payment_intent", parameters: { tenant_id: TENANT, payment_intent_id: intent.payment_intent_id, amount_ore: 1 } as never, idempotency_key: key("h4d") });
    expect(extra).toEqual({ ok: false, reason: "invalid_parameters" });
    expect(w.stripe.createCalls).toHaveLength(0);
  });
});

describe("I: pengehandlingene er IKKE på noen modellflate - kun eierens step-up/bekreftelsesvei", () => {
  const MONEY = ["finance.submit_payment_intent", "finance_stripe.submit_refund", "finance_vipps.submit_capture", "finance_vipps.submit_refund"];
  const CHECKS = ["finance.check_submit_payment_intent", "finance_stripe.check_submit_refund", "finance_vipps.check_submit_capture", "finance_vipps.check_submit_refund"];

  it("manifestet: ingen flate for de åtte nøklene, eier-eksklusive navnerom, klasse D/A, og alle manifest-invarianter består", () => {
    const w = wire();
    const manifest = buildToolManifest(w.gateway.list());
    assertManifestInvariants(manifest, { ignoreUnregisteredGrants: true });
    for (const k of [...MONEY, ...CHECKS]) {
      const entry = manifest.get(k)!;
      expect(entry, k).toBeDefined();
      expect(entry.surfaces, k).toEqual([]);
      expect(OWNER_ONLY_NAMESPACES.has(entry.tool_id), k).toBe(true);
    }
    for (const k of MONEY) expect(manifest.get(k)!.risk, k).toBe("D");
    for (const k of CHECKS) expect(manifest.get(k)!.risk, k).toBe("A");
    for (const k of MONEY) expect(manifest.get(k)!.effect, k).toBe("pay");
  });

  it("verken modellens tillatelsesliste (MODEL_SURFACE_ALLOWLIST) eller noen flatetildeling inneholder dem", () => {
    const all = new Set([...MONEY, ...CHECKS]);
    for (const g of MODEL_SURFACE_ALLOWLIST) expect(all.has(`${g.tool_id}.${g.action}`)).toBe(false);
    for (const surface of SURFACES) {
      for (const g of SURFACE_TOOL_GRANTS[surface]) expect(all.has(`${g.tool_id}.${g.action}`), `${surface}: ${g.tool_id}.${g.action}`).toBe(false);
    }
  });
});

describe("J: bundet forventning (beløp, valuta, mottaker) håndheves av selve pipelinen - også uten ruten", () => {
  const expectation = async (w: Wired, id: string) => {
    const check = (await w.finance.checkSubmitPaymentIntent(TENANT, "business", id))!;
    return { expected_amount_ore: check.payment_intent.amount_ore, expected_currency: check.payment_intent.currency, expected_recipient: check.payment_intent.recipient_digest! };
  };

  it("riktig binding slipper gjennom; feil beløp/valuta/mottaker og ufullstendig binding avvises FØR reservasjon og leverandørkall (ingen ledger-rad)", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    const ok = await expectation(w, intent.payment_intent_id);
    for (const [bad, reason] of [
      [{ ...ok, expected_amount_ore: ok.expected_amount_ore + 1 }, "bound_amount_mismatch"],
      [{ ...ok, expected_currency: "EUR" }, "bound_currency_mismatch"],
      [{ ...ok, expected_recipient: "f".repeat(32) }, "bound_recipient_mismatch"],
      [{ expected_amount_ore: ok.expected_amount_ore }, "bound_incomplete"],
      [{ expected_currency: ok.expected_currency, expected_recipient: ok.expected_recipient }, "bound_incomplete"]
    ] as const) {
      const k = key("bound");
      expect(await submitIntent(w, intent.payment_intent_id, k, bad as unknown as Record<string, JsonValue>), JSON.stringify(bad)).toEqual({ ok: false, reason: `preflight_invalid:${reason}` });
      expect(await ledgerRow(k)).toBeUndefined();
    }
    expect(w.stripe.createCalls).toHaveLength(0);
    expect(await submitIntent(w, intent.payment_intent_id, key("bound-ok"), ok as unknown as Record<string, JsonValue>)).toMatchObject({ ok: true, external_id: intent.payment_intent_id });
    expect(w.stripe.createCalls).toHaveLength(1);
  });

  it("refusjon og capture: samme binding mot barnets beløp/valuta og foreldrebetalingens mottaker", async () => {
    const w = wire();
    const parent = await settledStripeIntent(w);
    const refund = await w.finance.createStripeRefund(TENANT, "business", { idempotency_key: key("rf"), payment_intent_id: parent.payment_intent_id, amount_ore: 4_000 });
    const check = (await w.finance.checkSubmitStripeRefund(TENANT, "business", refund.refund_id))!;
    const bound = { expected_amount_ore: 4_000, expected_currency: "NOK", expected_recipient: check.parent!.recipient_digest! };
    const call = (extra: Record<string, JsonValue>) => w.gateway.execute({ identity: owner, tool_id: "finance_stripe", action: "submit_refund", parameters: { tenant_id: TENANT, refund_id: refund.refund_id, ...extra }, idempotency_key: key("sr") });
    expect(await call({ ...bound, expected_amount_ore: 3_999 })).toEqual({ ok: false, reason: "preflight_invalid:bound_amount_mismatch" });
    expect(await call({ ...bound, expected_recipient: "0".repeat(32) })).toEqual({ ok: false, reason: "preflight_invalid:bound_recipient_mismatch" });
    expect(w.stripe.refundCalls).toHaveLength(0);
    expect(await call(bound)).toMatchObject({ ok: true });
    expect(w.stripe.refundCalls).toHaveLength(1);
  });

  it("skjemaet er strengt: ukjente nøkler og feil format på `expected_*` avvises av parameter-porten før noe leses", async () => {
    const w = wire();
    const intent = await makeIntent(w, "stripe");
    for (const bad of [{ expected_amount_ore: "10000" }, { expected_amount_ore: -1 }, { expected_amount_ore: 1.5 }, { expected_currency: "nok" }, { expected_recipient: "ikke-hex" }, { expected_extra: 1 }]) {
      const r = await submitIntent(w, intent.payment_intent_id, key("schema"), bad as unknown as Record<string, JsonValue>);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(String((r as { reason: string }).reason), JSON.stringify(bad)).not.toMatch(/^preflight_/);
    }
    expect(w.stripe.createCalls).toHaveLength(0);
  });
});

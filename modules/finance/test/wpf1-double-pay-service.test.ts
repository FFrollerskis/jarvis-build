import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import {
  AmbiguousProviderResponseError,
  FinanceService,
  ProviderOutcomeUnknownError,
  SubmitInFlightError,
  classifyProviderFailure,
  classifyReservedSubmit,
  classifyFreshSubmit,
  type FikenCredentials,
  type PaymentIntent,
  type StripeCredentials,
  type VippsCredentials
} from "../src/index.ts";
import { FikenFake, Gate, StripeFake, VippsFake, http, timeoutError } from "./wpf1-fakes.ts";

/**
 * WP-F1 (D-453): DOBBELTBETALINGSVERN mot ekte embedded Postgres. Hver test beviser at en pengehandling aldri gir to leverandørhandlinger:
 *   - to SAMTIDIGE innsendinger (annen gateway-nøkkel, samme objekt) -> kun ÉN leverandørhandling (reservasjon + lease),
 *   - krasj mellom reservasjon og leverandørkall -> gjenopptas bare der leverandøren slår sammen kall (samme Idempotency-Key, innenfor vinduet),
 *   - leverandør-tidsavbrudd med ukjent utfall -> `outcome_unknown:` + flagg, aldri en ny betaling.
 * Alle leverandører er testdobler (ingen nettverk).
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-wpf1-dp";
const NO_FIKEN = { getCredentials: async () => null };
const stripeCreds: StripeCredentials = { secretKey: "sk_test_fixture_not_real" };
const vippsCreds: VippsCredentials = { clientId: "c", clientSecret: "s-fixture", subscriptionKey: "k", merchantSerialNumber: "1", environment: "test" };
const fikenCreds: FikenCredentials = { refreshToken: "t-fixture", companySlug: "firma" };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpf1-dp-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpf1_dp LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpf1_dp");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'WPF1 double-pay', 'business')`);
  appPool = createPool({ ...base, user: "jarvis_wpf1_dp", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

function services(stripe: StripeFake, vipps: VippsFake, fiken: FikenFake = new FikenFake(), timing?: { leaseMs?: number; idempotencyWindowMs?: number }): FinanceService {
  return new FinanceService(
    appPool, () => fiken, { getCredentials: async () => stripeCreds }, () => stripe, () => "whsec-fixture", () => TENANT,
    { getCredentials: async () => vippsCreds }, () => vipps, () => "vipps-fixture", () => TENANT,
    undefined, undefined, undefined, undefined, timing ? { submitTiming: timing } : {}
  );
}

async function makeIntent(service: FinanceService, provider: "stripe" | "vipps" | "fiken", extra: { vendor_provider_ref?: string; counter_account_code?: string } = {}): Promise<PaymentIntent> {
  return service.createPaymentIntent(TENANT, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "WPF1 dobbeltbetaling", amount_ore: 10_000, vendor_name: "Kunde AS",
    account_code: provider === "fiken" ? "6540" : "kategori", provider, ...extra
  });
}
const getIntent = async (service: FinanceService, id: string) => (await service.getPaymentIntent(TENANT, "business", id))!;
const row = async (table: string, idColumn: string, id: string) => (await adminPool.query(`SELECT * FROM ${table} WHERE ${idColumn} = $1`, [id])).rows[0] as Record<string, unknown>;
const waitFor = async (cond: () => boolean, ms = 5_000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("waitFor_timeout"); await new Promise((r) => setTimeout(r, 10)); } };

async function settledStripeIntent(service: FinanceService): Promise<PaymentIntent> {
  const intent = await makeIntent(service, "stripe");
  await adminPool.query("UPDATE payment_intents SET state = 'settled', provider_ref = $2, provider_status = 'succeeded', settled_at = now() WHERE payment_intent_id = $1", [intent.payment_intent_id, `pi_${randomUUID().slice(0, 8)}`]);
  return intent;
}
async function authorizedVippsIntent(service: FinanceService, state: "provider_acknowledged" | "settled" = "provider_acknowledged"): Promise<PaymentIntent> {
  const intent = await makeIntent(service, "vipps");
  await adminPool.query("UPDATE payment_intents SET state = $3, provider_ref = $2, provider_status = 'AUTHORIZED', provider_status_updated_at = now() WHERE payment_intent_id = $1", [intent.payment_intent_id, intent.payment_intent_id, state]);
  return intent;
}

describe("A: rene regler (submit-guard)", () => {
  it("classifyReservedSubmit: lease -> in_flight; utløpt + idempotent + innenfor vinduet -> resume; ellers reconcile_required", () => {
    const t = { leaseMs: 1_000, idempotencyWindowMs: 10_000 };
    expect(classifyReservedSubmit({ submittedAgeMs: 10, firstAttemptAgeMs: 10 }, true, t)).toBe("in_flight");
    expect(classifyReservedSubmit({ submittedAgeMs: 10, firstAttemptAgeMs: 10 }, false, t)).toBe("in_flight");
    expect(classifyReservedSubmit({ submittedAgeMs: 5_000, firstAttemptAgeMs: 5_000 }, true, t)).toBe("resume");
    expect(classifyReservedSubmit({ submittedAgeMs: null, firstAttemptAgeMs: null }, true, t)).toBe("resume");
    expect(classifyReservedSubmit({ submittedAgeMs: 5_000, firstAttemptAgeMs: 10_000 }, true, t)).toBe("reconcile_required");
    expect(classifyReservedSubmit({ submittedAgeMs: 5_000, firstAttemptAgeMs: 5_000 }, false, t)).toBe("reconcile_required");
    expect(classifyReservedSubmit({ submittedAgeMs: null, firstAttemptAgeMs: null }, false, t)).toBe("reconcile_required");
    expect(classifyFreshSubmit({ firstAttemptAgeMs: null }, true, t)).toBe("ok");
    expect(classifyFreshSubmit({ firstAttemptAgeMs: 9_999 }, true, t)).toBe("ok");
    expect(classifyFreshSubmit({ firstAttemptAgeMs: 10_000 }, true, t)).toBe("reconcile_required");
    expect(classifyFreshSubmit({ firstAttemptAgeMs: 99_999 }, false, t)).toBe("ok");
  });

  it("classifyProviderFailure: 4xx (unntatt 408/409) og 429 og feil før sending = not_executed; tidsavbrudd/5xx/408/409/nettverk/uklassifisert = unknown", () => {
    for (const status of [400, 401, 402, 403, 404, 422, 429]) expect(classifyProviderFailure(http(status)), String(status)).toBe("not_executed");
    for (const status of [408, 409, 500, 502, 503, 504]) expect(classifyProviderFailure(http(status)), String(status)).toBe("unknown");
    expect(classifyProviderFailure(timeoutError())).toBe("unknown");
    expect(classifyProviderFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }))).toBe("unknown");
    expect(classifyProviderFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toBe("not_executed");
    expect(classifyProviderFailure(new Error("invalid_amount_ore:abc"))).toBe("not_executed");
    expect(classifyProviderFailure(new Error("network_timeout_simulated"))).toBe("unknown");
    expect(classifyProviderFailure("streng-kastet")).toBe("unknown");
  });
});

describe("B: to samtidige innsendinger gir ÉN leverandørhandling", () => {
  it("Stripe-intensjon: andre kall mens første er i flukt -> SubmitInFlightError, nøyaktig ett leverandørkall, første fullfører", async () => {
    const stripe = new StripeFake();
    stripe.gate = new Gate();
    const service = services(stripe, new VippsFake());
    const intent = await makeIntent(service, "stripe");
    const first = service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, NO_FIKEN);
    await waitFor(() => stripe.createCalls.length === 1);
    expect((await getIntent(service, intent.payment_intent_id)).state).toBe("submitted");
    await expect(service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, NO_FIKEN)).rejects.toBeInstanceOf(SubmitInFlightError);
    stripe.gate.open();
    const done = await first;
    expect(done.state).toBe("provider_acknowledged");
    expect(done.provider_ref).toMatch(/^pi_/);
    expect(stripe.createCalls).toHaveLength(1);
    expect(stripe.distinctEffects).toBe(1);
  });

  it("Stripe-intensjon: ELLEVE samtidige kall uten pause - uansett interleaving ender det med nøyaktig ett leverandørkall og én leverandør-ID", async () => {
    const stripe = new StripeFake();
    const service = services(stripe, new VippsFake());
    const intent = await makeIntent(service, "stripe");
    const results = await Promise.allSettled(Array.from({ length: 11 }, () => service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, NO_FIKEN)));
    expect(stripe.createCalls).toHaveLength(1);
    expect(stripe.distinctEffects).toBe(1);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(SubmitInFlightError);
    }
    const final = await getIntent(service, intent.payment_intent_id);
    expect(final.state).toBe("provider_acknowledged");
    const events = await adminPool.query("SELECT count(*)::int AS n FROM payment_intent_events WHERE payment_intent_id = $1 AND event_type = 'submitted'", [intent.payment_intent_id]);
    expect((events.rows[0] as { n: number }).n).toBe(1);
  });

  it("Vipps-intensjon: samtidig innsending gir ett leverandørkall", async () => {
    const vipps = new VippsFake();
    vipps.gate = new Gate();
    const service = services(new StripeFake(), vipps);
    const intent = await makeIntent(service, "vipps");
    const first = service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, NO_FIKEN);
    await waitFor(() => vipps.createCalls.length === 1);
    await expect(service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, NO_FIKEN)).rejects.toBeInstanceOf(SubmitInFlightError);
    vipps.gate.open();
    expect((await first).state).toBe("provider_acknowledged");
    expect(vipps.createCalls).toHaveLength(1);
  });

  it("Fiken-intensjon (ingen Idempotency-Key hos leverandøren): samtidig innsending gir ÉN postering, aldri to", async () => {
    const fiken = new FikenFake();
    const service = services(new StripeFake(), new VippsFake(), fiken);
    const intent = await makeIntent(service, "fiken", { vendor_provider_ref: "kontakt-1", counter_account_code: "1920" });
    const creds = { getCredentials: async () => fikenCreds };
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, creds)));
    expect(fiken.calls).toBe(1);
    for (const r of results) {
      if (r.status === "rejected") expect([SubmitInFlightError, AmbiguousProviderResponseError].some((c) => r.reason instanceof c)).toBe(true);
    }
    expect((await getIntent(service, intent.payment_intent_id)).provider_ref).toBe("4242");
  });

  it("Stripe-refusjon: samtidige submit gir ett leverandørkall; samme refusjon kan ikke refunderes to ganger", async () => {
    const stripe = new StripeFake();
    stripe.gate = new Gate();
    const service = services(stripe, new VippsFake());
    const intent = await settledStripeIntent(service);
    const refund = await service.createStripeRefund(TENANT, "business", { idempotency_key: `rf-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 4_000 });
    const first = service.submitStripeRefund(TENANT, "business", refund.refund_id);
    await waitFor(() => stripe.refundCalls.length === 1);
    expect((await row("stripe_refunds", "refund_id", refund.refund_id))["state"]).toBe("submitted");
    await expect(service.submitStripeRefund(TENANT, "business", refund.refund_id)).rejects.toBeInstanceOf(SubmitInFlightError);
    stripe.gate.open();
    expect((await first).state).toBe("settled");
    expect(stripe.refundCalls).toHaveLength(1);
    expect((await service.submitStripeRefund(TENANT, "business", refund.refund_id)).state).toBe("settled");
    expect(stripe.refundCalls).toHaveLength(1);
    expect(stripe.distinctEffects).toBe(1);
  });

  it("Vipps-capture: samtidige submit gir ett capture-kall (pengene flyttes én gang)", async () => {
    const vipps = new VippsFake();
    vipps.gate = new Gate();
    const service = services(new StripeFake(), vipps);
    const intent = await authorizedVippsIntent(service);
    const capture = await service.createVippsCapture(TENANT, "business", { idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 3_000 });
    const first = service.submitVippsCapture(TENANT, "business", capture.capture_id);
    await waitFor(() => vipps.captureCalls.length === 1);
    await expect(service.submitVippsCapture(TENANT, "business", capture.capture_id)).rejects.toBeInstanceOf(SubmitInFlightError);
    vipps.gate.open();
    expect((await first).state).toBe("settled");
    expect(vipps.captureCalls).toHaveLength(1);
    expect((await service.submitVippsCapture(TENANT, "business", capture.capture_id)).state).toBe("settled");
    expect(vipps.captureCalls).toHaveLength(1);
  });

  it("Vipps-refusjon: samtidige submit gir ett refusjonskall", async () => {
    const vipps = new VippsFake();
    vipps.gate = new Gate();
    const service = services(new StripeFake(), vipps);
    const intent = await authorizedVippsIntent(service, "settled");
    const refund = await service.createVippsRefund(TENANT, "business", { idempotency_key: `vr-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 2_000 });
    const first = service.submitVippsRefund(TENANT, "business", refund.refund_id);
    await waitFor(() => vipps.refundCalls.length === 1);
    await expect(service.submitVippsRefund(TENANT, "business", refund.refund_id)).rejects.toBeInstanceOf(SubmitInFlightError);
    vipps.gate.open();
    expect((await first).state).toBe("settled");
    expect(vipps.refundCalls).toHaveLength(1);
  });
});

describe("C: krasj mellom reservasjon og leverandørkall", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  it("Stripe: reservasjon yngre enn leasen = pågående -> ingen leverandørkall; etter leasen gjenopptas med SAMME Idempotency-Key og flagget/vinduet er intakt", async () => {
    const stripe = new StripeFake();
    const service = services(stripe, new VippsFake());
    const intent = await makeIntent(service, "stripe");
    await adminPool.query("UPDATE payment_intents SET state = 'submitted', submitted_at = $2, first_submit_attempt_at = $2 WHERE payment_intent_id = $1", [intent.payment_intent_id, new Date().toISOString()]);
    await expect(service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, NO_FIKEN)).rejects.toBeInstanceOf(SubmitInFlightError);
    expect(stripe.createCalls).toHaveLength(0);
    await adminPool.query("UPDATE payment_intents SET submitted_at = $2, first_submit_attempt_at = $2 WHERE payment_intent_id = $1", [intent.payment_intent_id, minutesAgo(10)]);
    const resumed = await service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, NO_FIKEN);
    expect(resumed.state).toBe("provider_acknowledged");
    expect(stripe.createCalls).toEqual([{ amountOre: 10_000, idempotencyKey: `stripe-submit:${intent.payment_intent_id}` }]);
  });

  it("Stripe: FØRSTE forsøk er eldre enn leverandørens idempotensvindu (23 t) -> ingen automatisk gjenopptakelse (kan opprette et NYTT objekt), krever avstemming", async () => {
    const stripe = new StripeFake();
    const service = services(stripe, new VippsFake());
    const intent = await makeIntent(service, "stripe");
    await adminPool.query("UPDATE payment_intents SET state = 'submitted', submitted_at = $2, first_submit_attempt_at = $3 WHERE payment_intent_id = $1", [intent.payment_intent_id, minutesAgo(10), minutesAgo(24 * 60)]);
    await expect(service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, NO_FIKEN)).rejects.toThrow("submit_outcome_unknown_reconcile_required");
    expect(stripe.createCalls).toHaveLength(0);
    // samme regel for en rad som er rullet tilbake til draft etter et ukjent utfall for mer enn 23 t siden
    const intent2 = await makeIntent(service, "stripe");
    await adminPool.query("UPDATE payment_intents SET first_submit_attempt_at = $2 WHERE payment_intent_id = $1", [intent2.payment_intent_id, minutesAgo(24 * 60)]);
    await expect(service.submitPaymentIntent(TENANT, "business", intent2.payment_intent_id, NO_FIKEN)).rejects.toThrow("submit_window_expired_reconcile_required");
    expect(stripe.createCalls).toHaveLength(0);
  });

  it("Fiken: reservasjon uten leverandørsvar gjenopptas ALDRI automatisk (ingen Idempotency-Key) - hverken innenfor eller etter leasen", async () => {
    const fiken = new FikenFake();
    const service = services(new StripeFake(), new VippsFake(), fiken);
    const intent = await makeIntent(service, "fiken", { vendor_provider_ref: "kontakt-1", counter_account_code: "1920" });
    const creds = { getCredentials: async () => fikenCreds };
    await adminPool.query("UPDATE payment_intents SET state = 'submitted', submitted_at = now(), first_submit_attempt_at = now() WHERE payment_intent_id = $1", [intent.payment_intent_id]);
    await expect(service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, creds)).rejects.toBeInstanceOf(SubmitInFlightError);
    await adminPool.query("UPDATE payment_intents SET submitted_at = $2 WHERE payment_intent_id = $1", [intent.payment_intent_id, minutesAgo(30)]);
    await expect(service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, creds)).rejects.toThrow("submit_outcome_unknown_reconcile_required");
    expect(fiken.calls).toBe(0);
  });

  it("kort lease konfigurert: en reservasjon som er eldre enn leasen kan gjenopptas (Stripe) - konfigurasjonen virker", async () => {
    const stripe = new StripeFake();
    const service = services(stripe, new VippsFake(), new FikenFake(), { leaseMs: 50 });
    const intent = await makeIntent(service, "stripe");
    await adminPool.query("UPDATE payment_intents SET state = 'submitted', submitted_at = now(), first_submit_attempt_at = now() WHERE payment_intent_id = $1", [intent.payment_intent_id]);
    await new Promise((r) => setTimeout(r, 120));
    expect((await service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, NO_FIKEN)).state).toBe("provider_acknowledged");
  });

  it("Stripe-refusjon og Vipps-capture/-refusjon: krasj-rader følger samme regler (lease, så gjenopptakelse med samme nøkkel)", async () => {
    const stripe = new StripeFake();
    const vipps = new VippsFake();
    const service = services(stripe, vipps);
    const sIntent = await settledStripeIntent(service);
    const refund = await service.createStripeRefund(TENANT, "business", { idempotency_key: `rf-${randomUUID()}`, payment_intent_id: sIntent.payment_intent_id, amount_ore: 1_000 });
    await adminPool.query("UPDATE stripe_refunds SET state = 'submitted', submitted_at = now(), first_submit_attempt_at = now() WHERE refund_id = $1", [refund.refund_id]);
    await expect(service.submitStripeRefund(TENANT, "business", refund.refund_id)).rejects.toBeInstanceOf(SubmitInFlightError);
    await adminPool.query("UPDATE stripe_refunds SET submitted_at = $2, first_submit_attempt_at = $2 WHERE refund_id = $1", [refund.refund_id, minutesAgo(10)]);
    expect((await service.submitStripeRefund(TENANT, "business", refund.refund_id)).state).toBe("settled");
    expect(stripe.refundCalls.map((c) => c.idempotencyKey)).toEqual([`stripe-refund:${refund.refund_id}`]);

    const vIntent = await authorizedVippsIntent(service);
    const capture = await service.createVippsCapture(TENANT, "business", { idempotency_key: `cap-${randomUUID()}`, payment_intent_id: vIntent.payment_intent_id, amount_ore: 500 });
    await adminPool.query("UPDATE vipps_captures SET state = 'submitted', submitted_at = $2, first_submit_attempt_at = $3 WHERE capture_id = $1", [capture.capture_id, minutesAgo(10), minutesAgo(24 * 60)]);
    await expect(service.submitVippsCapture(TENANT, "business", capture.capture_id)).rejects.toThrow("submit_outcome_unknown_reconcile_required");
    expect(vipps.captureCalls).toHaveLength(0);
  });
});

describe("D: leverandør-tidsavbrudd med ukjent utfall - aldri en ny betaling", () => {
  it("Stripe: tidsavbrudd -> outcome_unknown:, tilbake til draft + flagg + hendelse; retry bruker SAMME nøkkel, gir ÉN effekt, og flagget forsvinner", async () => {
    const stripe = new StripeFake();
    stripe.fail = timeoutError;
    const service = services(stripe, new VippsFake());
    const intent = await makeIntent(service, "stripe");
    const err = await service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, NO_FIKEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderOutcomeUnknownError);
    expect((err as Error).message.startsWith("outcome_unknown:")).toBe(true);
    expect((err as Error).message).not.toMatch(/sk_test|whsec/);
    const mid = await getIntent(service, intent.payment_intent_id);
    expect(mid.state).toBe("draft");
    expect(mid.anomaly_flags).toContain("SUBMIT_OUTCOME_UNKNOWN");
    expect(mid.first_submit_attempt_at).not.toBeNull();
    const events = await adminPool.query("SELECT summary FROM payment_intent_events WHERE payment_intent_id = $1 AND event_type = 'anomaly_flagged'", [intent.payment_intent_id]);
    expect(events.rows.some((r) => /UKJENT/.test((r as { summary: string }).summary))).toBe(true);

    stripe.fail = null;
    const final = await service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, NO_FIKEN);
    expect(final.state).toBe("provider_acknowledged");
    expect(final.anomaly_flags).not.toContain("SUBMIT_OUTCOME_UNKNOWN");
    expect(new Set(stripe.createCalls.map((c) => c.idempotencyKey))).toEqual(new Set([`stripe-submit:${intent.payment_intent_id}`]));
    expect(stripe.distinctEffects).toBe(1);
  });

  it("Fiken: tidsavbrudd -> outcome_unknown:, intensjonen STÅR IGJEN som submitted + flagg; retry gir reconcile_required og aldri en ny postering", async () => {
    const fiken = new FikenFake();
    fiken.fail = timeoutError;
    const service = services(new StripeFake(), new VippsFake(), fiken);
    const intent = await makeIntent(service, "fiken", { vendor_provider_ref: "kontakt-1", counter_account_code: "1920" });
    const creds = { getCredentials: async () => fikenCreds };
    await expect(service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, creds)).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
    const after = await getIntent(service, intent.payment_intent_id);
    expect(after.state).toBe("submitted");
    expect(after.provider_ref).toBeNull();
    expect(after.anomaly_flags).toContain("SUBMIT_OUTCOME_UNKNOWN");
    fiken.fail = null;
    await expect(service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, creds)).rejects.toThrow("submit_outcome_unknown_reconcile_required");
    expect(fiken.calls).toBe(1);
  });

  it("entydig avvisning (4xx): rå feil, tilbake til draft, INGEN flagg og første-forsøk nullstilt - en korrigert retry er trygg", async () => {
    const stripe = new StripeFake();
    stripe.fail = () => http(400, "stripe_api_error_400:invalid_request");
    const service = services(stripe, new VippsFake());
    const intent = await makeIntent(service, "stripe");
    const err = await service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, NO_FIKEN).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ProviderOutcomeUnknownError);
    expect((err as Error).message).toBe("stripe_api_error_400:invalid_request");
    const after = await getIntent(service, intent.payment_intent_id);
    expect(after.state).toBe("draft");
    expect(after.anomaly_flags).not.toContain("SUBMIT_OUTCOME_UNKNOWN");
    expect(after.first_submit_attempt_at).toBeNull();
  });

  it("409 (idempotency_key_in_use) er UKJENT, ikke avvist: flagges og første-forsøk beholdes", async () => {
    const stripe = new StripeFake();
    stripe.fail = () => http(409, "stripe_api_error_409:idempotency_key_in_use");
    const service = services(stripe, new VippsFake());
    const intent = await makeIntent(service, "stripe");
    await expect(service.submitPaymentIntent(TENANT, "business", intent.payment_intent_id, NO_FIKEN)).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
    const after = await getIntent(service, intent.payment_intent_id);
    expect(after.anomaly_flags).toContain("SUBMIT_OUTCOME_UNKNOWN");
    expect(after.first_submit_attempt_at).not.toBeNull();
  });

  it("Stripe-refusjon: tidsavbrudd -> outcome_unknown:, draft + flagg, retry (samme nøkkel) fullfører med ÉN effekt og rydder flagget", async () => {
    const stripe = new StripeFake();
    const service = services(stripe, new VippsFake());
    const intent = await settledStripeIntent(service);
    const refund = await service.createStripeRefund(TENANT, "business", { idempotency_key: `rf-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 2_500 });
    stripe.fail = timeoutError;
    await expect(service.submitStripeRefund(TENANT, "business", refund.refund_id)).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
    const mid = await row("stripe_refunds", "refund_id", refund.refund_id);
    expect(mid["state"]).toBe("draft");
    expect(mid["anomaly_flags"]).toContain("SUBMIT_OUTCOME_UNKNOWN");
    stripe.fail = null;
    const done = await service.submitStripeRefund(TENANT, "business", refund.refund_id);
    expect(done.state).toBe("settled");
    expect(done.anomaly_flags).not.toContain("SUBMIT_OUTCOME_UNKNOWN");
    expect(new Set(stripe.refundCalls.map((c) => c.idempotencyKey))).toEqual(new Set([`stripe-refund:${refund.refund_id}`]));
    expect(stripe.distinctEffects).toBe(1);
  });

  it("Vipps-capture og -refusjon: samme mønster (ukjent utfall -> draft + flagg -> retry med samme nøkkel -> flagget borte)", async () => {
    const vipps = new VippsFake();
    const service = services(new StripeFake(), vipps);
    const intent = await authorizedVippsIntent(service);
    const capture = await service.createVippsCapture(TENANT, "business", { idempotency_key: `cap-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 1_500 });
    vipps.fail = () => http(503, "vipps_api_failed_503:hangup");
    await expect(service.submitVippsCapture(TENANT, "business", capture.capture_id)).rejects.toThrow(/^outcome_unknown:/);
    expect((await row("vipps_captures", "capture_id", capture.capture_id))["anomaly_flags"]).toContain("SUBMIT_OUTCOME_UNKNOWN");
    vipps.fail = null;
    const settled = await service.submitVippsCapture(TENANT, "business", capture.capture_id);
    expect(settled.state).toBe("settled");
    expect(settled.anomaly_flags).not.toContain("SUBMIT_OUTCOME_UNKNOWN");
    expect(new Set(vipps.captureCalls.map((c) => c.idempotencyKey))).toEqual(new Set([`vipps-capture:${capture.capture_id}`]));

    const settledIntent = await authorizedVippsIntent(service, "settled");
    const refund = await service.createVippsRefund(TENANT, "business", { idempotency_key: `vr-${randomUUID()}`, payment_intent_id: settledIntent.payment_intent_id, amount_ore: 700 });
    vipps.fail = () => http(504, "vipps_api_failed_504:gateway_timeout");
    await expect(service.submitVippsRefund(TENANT, "business", refund.refund_id)).rejects.toThrow(/^outcome_unknown:/);
    vipps.fail = null;
    expect((await service.submitVippsRefund(TENANT, "business", refund.refund_id)).state).toBe("settled");
    expect(new Set(vipps.refundCalls.map((c) => c.idempotencyKey))).toEqual(new Set([`vipps-refund:${refund.refund_id}`]));
  });

  it("entydig avvisning av en refusjon (4xx) nullstiller reservasjonen helt: draft uten flagg og uten første-forsøk", async () => {
    const stripe = new StripeFake();
    const service = services(stripe, new VippsFake());
    const intent = await settledStripeIntent(service);
    const refund = await service.createStripeRefund(TENANT, "business", { idempotency_key: `rf-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 900 });
    stripe.fail = () => http(402, "stripe_api_error_402:declined");
    await expect(service.submitStripeRefund(TENANT, "business", refund.refund_id)).rejects.toThrow("stripe_api_error_402:declined");
    const after = await row("stripe_refunds", "refund_id", refund.refund_id);
    expect(after["state"]).toBe("draft");
    expect(after["anomaly_flags"]).toEqual([]);
    expect(after["first_submit_attempt_at"]).toBeNull();
  });

  it("leverandørens ekko av refusjonsbeløp som avviker fra det vi ba om flagges REFUND_AMOUNT_CONFLICT på refusjon og betaling (aldri stille)", async () => {
    const stripe = new StripeFake();
    const original = stripe.createRefund.bind(stripe);
    stripe.createRefund = async (input) => ({ ...(await original(input)), amount: input.amountOre + 1 });
    const service = services(stripe, new VippsFake());
    const intent = await settledStripeIntent(service);
    const refund = await service.createStripeRefund(TENANT, "business", { idempotency_key: `rf-${randomUUID()}`, payment_intent_id: intent.payment_intent_id, amount_ore: 1_100 });
    const done = await service.submitStripeRefund(TENANT, "business", refund.refund_id);
    expect((await row("stripe_refunds", "refund_id", done.refund_id))["anomaly_flags"]).toContain("REFUND_AMOUNT_CONFLICT");
    expect((await getIntent(service, intent.payment_intent_id)).anomaly_flags).toContain("REFUND_AMOUNT_CONFLICT");
  });
});

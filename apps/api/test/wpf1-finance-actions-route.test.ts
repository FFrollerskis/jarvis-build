import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfirmationStore, createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, firstWaveTools, type ClassDNotification, type ClassDNotifier } from "@jarvis/tool-gateway";
import {
  FinanceService,
  FinanceTransport,
  StripeFinanceTransport,
  VippsFinanceTransport,
  type PaymentIntent,
  type StripePaymentWriter,
  type VippsPaymentObject,
  type VippsPaymentWriter
} from "@jarvis/finance";
import { createApiServer, type ApiDeps } from "../src/server.ts";
import { FINANCE_MONEY_ACTIONS, isFinanceMoneyAction, parseFinanceActionRequest } from "../src/finance-actions.ts";

/**
 * WP-F1 (D-453, Q-47 a): EIERENS VEI TIL PENGEHANDLINGENE, ende-til-ende mot den ekte API-serveren, ekte ToolGateway (klasse D-pipeline påslått), ekte ConfirmationStore og
 * ekte FinanceService over embedded Postgres. Leverandørene er testdobler. Beviser at pengehandlingene KUN kan utføres via: eierens step-up -> bundet bekreftelse ->
 * eierens step-up-godkjenning - aldri direkte, aldri fra en svakere økt, aldri av andre enn eieren, og aldri to ganger.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let url = "";
let close: () => Promise<void>;

const TENANT = "tenant-wpf1-api";
const TENANT_B = "tenant-wpf1-api-b";
const OWNER = "person-wpf1-api-owner";
const GUEST = "person-wpf1-api-guest";
const OTHER = "person-wpf1-api-other";

class StripeFake implements StripePaymentWriter {
  createCalls = 0;
  refundCalls = 0;
  async createPaymentIntent(input: { amountOre: number; currency: string; metadata: Record<string, string>; idempotencyKey: string }) {
    this.createCalls += 1;
    return { id: `pi_${randomUUID().slice(0, 8)}`, object: "payment_intent" as const, amount: input.amountOre, currency: input.currency.toLowerCase(), status: "requires_payment_method", metadata: input.metadata };
  }
  async getPaymentIntent(id: string) { return { id, object: "payment_intent" as const, amount: 10_000, currency: "nok", status: "requires_payment_method", metadata: {} }; }
  async createRefund(input: { stripePaymentIntentId: string; amountOre: number; idempotencyKey: string }) {
    this.refundCalls += 1;
    return { id: `re_${randomUUID().slice(0, 8)}`, object: "refund" as const, amount: input.amountOre, currency: "nok", status: "succeeded", payment_intent: input.stripePaymentIntentId, reason: null };
  }
  async getRefund(id: string) { return { id, object: "refund" as const, amount: 1, currency: "nok", status: "succeeded", payment_intent: "x", reason: null }; }
  async getBalance() { return { object: "balance" as const, available: [], pending: [] }; }
}
class VippsFake implements VippsPaymentWriter {
  captureCalls = 0;
  async createPayment(input: { amountOre: number; currency: string; reference: string }): Promise<VippsPaymentObject> { return { reference: input.reference, state: "CREATED", amount: { currency: input.currency, value: input.amountOre } }; }
  async getPayment(reference: string): Promise<VippsPaymentObject> { return { reference, state: "AUTHORIZED", amount: { currency: "NOK", value: 10_000 } }; }
  async capturePayment(input: { reference: string; amountOre: number; currency: string }): Promise<VippsPaymentObject> {
    this.captureCalls += 1;
    return { reference: input.reference, state: "AUTHORIZED", amount: { currency: input.currency, value: input.amountOre } };
  }
  async cancelPayment(reference: string): Promise<VippsPaymentObject> { return { reference, state: "CANCELLED", amount: { currency: "NOK", value: 10_000 } }; }
  async refundPayment(input: { reference: string; amountOre: number; currency: string }): Promise<VippsPaymentObject> { return { reference: input.reference, state: "AUTHORIZED", amount: { currency: input.currency, value: input.amountOre } }; }
  async checkCredentials(): Promise<void> {}
}
class FakeNotifier implements ClassDNotifier {
  sent: ClassDNotification[] = [];
  ready() { return true; }
  async notify(n: ClassDNotification) { this.sent.push(n); }
}

const stripe = new StripeFake();
const vipps = new VippsFake();
const notifier = new FakeNotifier();
let finance: FinanceService;
let gateway: ToolGateway;
const executedActions: string[] = [];

/** token -> grant: signert enhet fra web (eier), svakere økter og andre personer. */
const GRANTS: Record<string, { person_id: string; tenant_id: string; memory_space: string; session_id: string; device_id: string; channel: string; auth_strength: string }> = {
  "owner-signed": { person_id: OWNER, tenant_id: TENANT, memory_space: "business", session_id: "s-own", device_id: "dev-own", channel: "web", auth_strength: "signed" },
  "owner-desktop": { person_id: OWNER, tenant_id: TENANT, memory_space: "business", session_id: "s-own2", device_id: "dev-own", channel: "desktop", auth_strength: "signed" },
  "owner-active": { person_id: OWNER, tenant_id: TENANT, memory_space: "business", session_id: "s-act", device_id: "dev-own", channel: "web", auth_strength: "active" },
  "owner-passive": { person_id: OWNER, tenant_id: TENANT, memory_space: "business", session_id: "s-pas", device_id: "dev-own", channel: "web", auth_strength: "passive" },
  "owner-telegram": { person_id: OWNER, tenant_id: TENANT, memory_space: "business", session_id: "s-tg", device_id: "dev-own", channel: "telegram", auth_strength: "signed" },
  "owner-voice": { person_id: OWNER, tenant_id: TENANT, memory_space: "business", session_id: "s-vo", device_id: "dev-own", channel: "voice", auth_strength: "signed" },
  "guest-signed": { person_id: GUEST, tenant_id: TENANT, memory_space: "business", session_id: "s-gu", device_id: "dev-gu", channel: "web", auth_strength: "signed" },
  "otherowner-signed": { person_id: OTHER, tenant_id: TENANT_B, memory_space: "business", session_id: "s-ot", device_id: "dev-ot", channel: "web", auth_strength: "signed" }
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpf1-api-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpf1_api LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpf1_api");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'WPF1 api', 'business'), ('${TENANT_B}', 'WPF1 api B', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Eier'), ('${GUEST}', 'Gjest'), ('${OTHER}', 'Annen eier');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${TENANT}'), ('${GUEST}', '${TENANT}'), ('${OTHER}', '${TENANT_B}');
  `);
  appPool = createPool({ ...base, user: "jarvis_wpf1_api", password: "pw2" });

  finance = new FinanceService(
    appPool, () => ({ createGeneralJournalEntry: async (i: { description: string; date: string }) => ({ journalEntryId: 1, description: i.description, date: i.date }), listCompanies: async () => [] }),
    { getCredentials: async () => ({ secretKey: "sk_test_fixture_not_real" }) }, () => stripe, () => "whsec-fixture", () => TENANT,
    { getCredentials: async () => ({ clientId: "c", clientSecret: "s-fixture", subscriptionKey: "k", merchantSerialNumber: "1", environment: "test" as const }) }, () => vipps, () => "vipps-fixture", () => TENANT
  );
  const policy = new PolicyGateway({
    devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT] }
  });
  const secrets = { name: "wpf1-fixture", get: async (ref: string) => (ref === "JARVIS_NEONOMICS_CLIENT_SECRET" ? null : `fixture-${ref}`) };
  gateway = new ToolGateway(appPool, policy, secrets, undefined, undefined, {
    classDPipeline: { enforce: true, notifier },
    credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT], internalRefs: new Set(["JARVIS_BUSINESS_INTERNAL_TOKEN"]) }
  });
  for (const tool of firstWaveTools({
    finance: new FinanceTransport(finance, { getCredentials: async () => ({ refreshToken: "t", companySlug: "firma" }) }),
    finance_stripe: new StripeFinanceTransport(finance),
    finance_vipps: new VippsFinanceTransport(finance)
  })) gateway.register(tool);

  // En speiling av gatewayen som husker hvilke handlinger API-et faktisk kjørte (for å bevise at preview/request ALDRI mutterer).
  const spy = {
    get: (t: string, a: string) => gateway.get(t, a),
    execute: (req: Parameters<ToolGateway["execute"]>[0]) => { executedActions.push(`${req.tool_id}.${req.action}`); return gateway.execute(req); }
  };
  const deps = {
    grants: { verify: async (token: string) => (GRANTS[token] ? { ok: true, grant: GRANTS[token] } : { ok: false, reason: "grant_invalid" }) },
    // Samme form som IdentityService.resolveIdentity: en ren, streng IdentityContext (ingen ekstra nøkler som `memory_space`).
    identity: {
      resolveIdentity: async (i: Record<string, string>) => ({
        ok: true,
        identity: { person_id: i["person_id"], tenant_id: i["tenant_id"], memory_space_id: i["memory_space"], session_id: i["session_id"], device_id: i["device_id"], channel: i["channel"], auth_strength: i["auth_strength"] }
      })
    },
    executive: { gateway: spy },
    confirmations: new ConfirmationStore(appPool),
    owner: { tenant_id: TENANT, person_id: OWNER }
  } as unknown as ApiDeps;
  const server = createApiServer(deps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
}, 240_000);

afterAll(async () => {
  await close?.();
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

type Json = Record<string, unknown>;
const post = async (path: string, body: unknown): Promise<{ status: number; body: Json }> => {
  const res = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Json };
};
const fin = (token: string, action: string, parameters: Json) => post("/finance/actions", { grant_token: token, action, parameters });
const decide = (token: string, id: string, decision: "approve" | "reject") => post("/confirmations", { grant_token: token, action: "decide", parameters: { confirmation_id: id, decision } });
const data = (r: { body: Json }) => r.body["data"] as Json;

async function newStripeIntent(over: Record<string, unknown> = {}): Promise<PaymentIntent> {
  return finance.createPaymentIntent(TENANT, "business", {
    idempotency_key: `idem-${randomUUID()}`, purpose: "WPF1 api", amount_ore: 10_000, vendor_name: `Kunde ${randomUUID().slice(0, 8)} AS`, account_code: "kategori", provider: "stripe", ...over
  } as never);
}
const intentState = async (id: string) => ((await adminPool.query("SELECT state FROM payment_intents WHERE payment_intent_id = $1", [id])).rows[0] as { state: string }).state;
const confRow = async (id: string) => (await adminPool.query("SELECT * FROM action_confirmations WHERE confirmation_id = $1", [id])).rows[0] as Record<string, unknown> | undefined;
const confCount = async (toolAction: string) => ((await adminPool.query("SELECT count(*)::int AS n FROM action_confirmations WHERE tool_id || '.' || action = $1", [toolAction])).rows[0] as { n: number }).n;
const submitActions = () => executedActions.filter((a) => /\.submit_(payment_intent|refund|capture)$/.test(a));

describe("A: forespørselens form - streng, fail-closed, FØR grant og step-up", () => {
  it("uten grant 401; ukjent/identitetsfelt i kroppen 400; ukjent action 400", async () => {
    const intent = await newStripeIntent();
    const params = { tool: "finance.submit_payment_intent", payment_intent_id: intent.payment_intent_id };
    expect((await post("/finance/actions", { action: "preview", parameters: params })).status).toBe(401);
    expect((await post("/finance/actions", { grant_token: "owner-signed", action: "preview", parameters: params, extra: 1 })).status).toBe(400);
    const idField = await post("/finance/actions", { grant_token: "owner-signed", action: "preview", parameters: params, tenant_id: TENANT_B });
    expect(idField.status).toBe(400);
    expect(idField.body["error"]).toBe("identity_field_forbidden");
    const execute = await fin("owner-signed", "execute", params);
    expect(execute.status).toBe(400);
    expect(execute.body).toMatchObject({ error: "malformed_request", reason: "action_not_allowed" });
    expect((await fin("owner-signed", "submit", params)).status).toBe(400);
    expect((await fin("ugyldig-grant", "preview", params)).status).toBe(403);
  });

  it("kun de fire pengehandlingene kan velges, med riktig id-parameter og ingen ekstra felt", async () => {
    const id = "fin-pi-abc";
    const bad = async (parameters: Json, reason: string) => {
      const r = await fin("owner-signed", "request", parameters);
      expect(r.status, JSON.stringify(parameters)).toBe(400);
      expect(r.body["reason"], JSON.stringify(parameters)).toBe(reason);
    };
    await bad({}, "tool_required");
    await bad({ tool: 5 }, "tool_required");
    await bad({ tool: "finance.create_payment_intent", payment_intent_id: id }, "tool_not_allowed");
    await bad({ tool: "finance.enable_kill_switch" }, "tool_not_allowed");
    await bad({ tool: "finance_stripe.request_refund", refund_id: id }, "tool_not_allowed");
    await bad({ tool: "docker.redeploy_container", payment_intent_id: id }, "tool_not_allowed");
    await bad({ tool: "finance.submit_payment_intent" }, "payment_intent_id_invalid");
    await bad({ tool: "finance.submit_payment_intent", refund_id: id }, "unknown_parameter:refund_id");
    await bad({ tool: "finance_stripe.submit_refund", payment_intent_id: id }, "unknown_parameter:payment_intent_id");
    await bad({ tool: "finance_vipps.submit_capture", capture_id: id, amount_ore: 1 }, "unknown_parameter:amount_ore");
    await bad({ tool: "finance.submit_payment_intent", payment_intent_id: id, tenant_id: TENANT_B }, "unknown_parameter:tenant_id");
    await bad({ tool: "finance.submit_payment_intent", payment_intent_id: id, idempotency_key: "x" }, "unknown_parameter:idempotency_key");
    for (const evil of ["", " ", "x; DROP TABLE payment_intents", "../etc/passwd", "a".repeat(101), "fin-pi\nabc", "id with space", "-leading-dash", "ï"]) {
      await bad({ tool: "finance.submit_payment_intent", payment_intent_id: evil }, "payment_intent_id_invalid");
    }
    await bad({ tool: "finance.submit_payment_intent", payment_intent_id: 42 }, "payment_intent_id_invalid");
    await bad({ tool: "finance.submit_payment_intent", payment_intent_id: id, confirm_possible_duplicate_of: "fin-pi-x" }, "confirm_possible_duplicate_of_invalid");
    await bad({ tool: "finance.submit_payment_intent", payment_intent_id: id, confirm_possible_duplicate_of: Array.from({ length: 11 }, (_, i) => `fin-pi-${i}`) }, "confirm_possible_duplicate_of_invalid");
    await bad({ tool: "finance.submit_payment_intent", payment_intent_id: id, confirm_possible_duplicate_of: [1] }, "confirm_possible_duplicate_of_invalid");
    // duplikat-kvittering gjelder bare intensjoner
    await bad({ tool: "finance_stripe.submit_refund", refund_id: id, confirm_possible_duplicate_of: ["fin-pi-x"] }, "unknown_parameter:confirm_possible_duplicate_of");
    expect(submitActions()).toEqual([]);
  });

  it("parseFinanceActionRequest og isFinanceMoneyAction: hvitlisten er nøyaktig de fire", () => {
    expect(FINANCE_MONEY_ACTIONS.map((s) => `${s.tool_id}.${s.action}`).sort()).toEqual(["finance.submit_payment_intent", "finance_stripe.submit_refund", "finance_vipps.submit_capture", "finance_vipps.submit_refund"]);
    expect(isFinanceMoneyAction("finance", "submit_payment_intent")).toBe(true);
    expect(isFinanceMoneyAction("finance", "create_payment_intent")).toBe(false);
    expect(isFinanceMoneyAction("finance_wallester", "activate_card")).toBe(false);
    expect(parseFinanceActionRequest({ tool: "finance.submit_payment_intent", payment_intent_id: "fin-pi-1", confirm_possible_duplicate_of: ["fin-pi-2", "fin-pi-2"] })).toMatchObject({ ok: true, request: { targetId: "fin-pi-1", confirmPossibleDuplicateOf: ["fin-pi-2"] } });
    expect(parseFinanceActionRequest({ tool: "__proto__" })).toEqual({ ok: false, reason: "tool_not_allowed" });
    expect(parseFinanceActionRequest({ tool: "constructor.submit_payment_intent" })).toEqual({ ok: false, reason: "tool_not_allowed" });
  });
});

describe("B: step-up og eier-binding i alle trinn - svake økter, andre kanaler og andre personer kommer ikke i nærheten", () => {
  it("preview og request krever signert enhetsøkt fra eier-kanal (web/desktop/api/mobile)", async () => {
    const intent = await newStripeIntent();
    const params = { tool: "finance.submit_payment_intent", payment_intent_id: intent.payment_intent_id };
    for (const [token, reason] of [
      ["owner-active", "step_up_required:signed_device_session"], ["owner-passive", "step_up_required:signed_device_session"],
      ["owner-telegram", "step_up_required:channel_telegram_not_allowed"], ["owner-voice", "step_up_required:channel_voice_not_allowed"]
    ] as const) {
      for (const action of ["preview", "request"]) {
        const r = await fin(token, action, params);
        expect(r.status, `${token}/${action}`).toBe(403);
        expect(r.body).toMatchObject({ error: "step_up_required", reason });
      }
    }
    expect(await confCount("finance.submit_payment_intent")).toBe(0);
    expect(executedActions.filter((a) => a.includes("check_submit"))).toEqual([]); // ikke engang tilstandslesingen kjørte
  });

  it("andre enn eieren (gjest i samme tenant, annen tenants eier) får 403 owner_only - selv med signert enhet", async () => {
    const intent = await newStripeIntent();
    const params = { tool: "finance.submit_payment_intent", payment_intent_id: intent.payment_intent_id };
    for (const token of ["guest-signed", "otherowner-signed"]) {
      for (const action of ["preview", "request"]) {
        const r = await fin(token, action, params);
        expect(r.status, `${token}/${action}`).toBe(403);
        expect(r.body["error"]).toBe("owner_only");
      }
    }
    expect(await confCount("finance.submit_payment_intent")).toBe(0);
  });

  it("uten eier-konfigurasjon (deps.owner) finnes ruten ikke (404) - aldri en åpen flate", async () => {
    const bare = createApiServer({ grants: { verify: async () => ({ ok: false, reason: "x" }) }, executive: { gateway }, confirmations: new ConfirmationStore(appPool) } as unknown as ApiDeps);
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/finance/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_token: "owner-signed", action: "preview", parameters: {} }) });
      expect(res.status).toBe(404);
    } finally {
      bare.closeAllConnections();
      await new Promise<void>((r) => bare.close(() => r()));
    }
  });
});

describe("C: ende-til-ende - preview -> request -> godkjenn (step-up) -> utført, én gang", () => {
  it("Stripe-intensjon: ingenting utføres før eierens step-up-godkjenning; deretter nøyaktig én leverandørhandling", async () => {
    const intent = await newStripeIntent();
    const params = { tool: "finance.submit_payment_intent", payment_intent_id: intent.payment_intent_id };
    const submitsBefore = submitActions().length;
    const createBefore = stripe.createCalls;

    const preview = await fin("owner-signed", "preview", params);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(data(preview)).toMatchObject({ tool: "finance.submit_payment_intent", target_id: intent.payment_intent_id, allowed: true, reason: null, summary: `betaling 100,00 NOK via stripe (intensjon ${intent.payment_intent_id})` });
    expect((data(preview)["state"] as { kind: string }).kind).toBe("payment_intent");

    const req = await fin("owner-desktop", "request", params);
    expect(req.body, JSON.stringify(req.body)).toBeTruthy();
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    const confirmationId = String(data(req)["confirmation_id"]);
    expect(data(req)).toMatchObject({ created: true, tool: "finance.submit_payment_intent", next: "approve_via_confirmations_with_step_up" });
    const stored = (await confRow(confirmationId))!;
    expect(stored["status"]).toBe("pending");
    expect(stored["tool_id"]).toBe("finance");
    expect(stored["action"]).toBe("submit_payment_intent");
    expect(stored["parameters"]).toEqual({ tenant_id: TENANT, payment_intent_id: intent.payment_intent_id }); // tenant fra identiteten, aldri fra klienten
    expect((stored["summary"] as { display: string }).display).toBe(`betaling 100,00 NOK via stripe (intensjon ${intent.payment_intent_id})`);
    expect(stored["taint_reasons"]).toEqual(["owner_finance_action_request"]);
    // INGENTING er utført ennå
    expect(submitActions().length).toBe(submitsBefore);
    expect(stripe.createCalls).toBe(createBefore);
    expect(await intentState(intent.payment_intent_id)).toBe("draft");

    // samme forespørsel igjen: samme ventende bekreftelse (ingen duplikat)
    const again = await fin("owner-signed", "request", params);
    expect(data(again)).toMatchObject({ confirmation_id: confirmationId, created: false });
    expect(await confCount("finance.submit_payment_intent")).toBeGreaterThanOrEqual(1);

    // eierens bekreftelsesliste viser det lesbare sammendraget
    const list = await post("/confirmations", { grant_token: "owner-signed", action: "list", parameters: {} });
    const pending = (list.body["data"] as Array<{ confirmation_id: string; summary: { display?: string } }>).find((c) => c.confirmation_id === confirmationId);
    expect(pending?.summary.display).toContain("100,00 NOK via stripe");

    // godkjenning fra en svakere økt eller feil kanal nektes - og bekreftelsen er fortsatt ventende (ikke brent)
    for (const [token, reason] of [["owner-active", "step_up_required:signed_device_session"], ["owner-passive", "step_up_required:signed_device_session"], ["owner-telegram", "step_up_required:channel_telegram_not_allowed"], ["owner-voice", "step_up_required:channel_voice_not_allowed"]] as const) {
      const denied = await decide(token, confirmationId, "approve");
      expect(denied.status, token).toBe(403);
      expect(denied.body).toMatchObject({ error: "step_up_required", reason });
    }
    expect((await confRow(confirmationId))!["status"]).toBe("pending");
    expect(stripe.createCalls).toBe(createBefore);

    // gjesten kan ikke godkjenne eierens bekreftelse (kun samme person)
    expect((await decide("guest-signed", confirmationId, "approve")).status).toBe(404);
    expect(stripe.createCalls).toBe(createBefore);

    // eierens step-up-godkjenning UTFØRER, gjennom klasse D-pipelinen, med bekreftelses-id som idempotensnøkkel
    const approved = await decide("owner-signed", confirmationId, "approve");
    expect(approved.status).toBe(200);
    expect(data(approved)).toMatchObject({ executed: true, tool: "finance.submit_payment_intent", result: { ok: true, external_id: intent.payment_intent_id } });
    expect(stripe.createCalls).toBe(createBefore + 1);
    expect(await intentState(intent.payment_intent_id)).toBe("provider_acknowledged");
    expect(notifier.sent.at(-1)).toMatchObject({ outcome: "executed", tool_id: "finance", action: "submit_payment_intent", idempotency_key: `confirmation:${confirmationId}`, person_id: OWNER });
    const done = (await confRow(confirmationId))!;
    expect(done["status"]).toBe("consumed");
    expect(done["result"]).toMatchObject({ ok: true });
    const ledger = (await adminPool.query("SELECT status FROM tool_executions WHERE idempotency_key = $1", [`confirmation:${confirmationId}`])).rows[0] as { status: string };
    expect(ledger.status).toBe("succeeded");

    // engangs: samme godkjenning igjen gjør ingenting; en ny forespørsel mot en allerede sendt intensjon avvises med årsak (ingen ny bekreftelse)
    expect((await decide("owner-signed", confirmationId, "approve")).status).toBe(404);
    expect(stripe.createCalls).toBe(createBefore + 1);
    const rerequest = await fin("owner-signed", "request", params);
    expect(rerequest.status).toBe(409);
    expect(rerequest.body).toMatchObject({ error: "not_submittable", reason: "not_submittable:provider_acknowledged" });
    expect(stripe.createCalls).toBe(createBefore + 1);
  });

  it("Stripe-refusjon og Vipps-capture: samme vei, nøyaktig én leverandørhandling hver", async () => {
    const parent = await newStripeIntent();
    await adminPool.query("UPDATE payment_intents SET state = 'settled', provider_ref = 'pi_x1', provider_status = 'succeeded', settled_at = now() WHERE payment_intent_id = $1", [parent.payment_intent_id]);
    const refund = await finance.createStripeRefund(TENANT, "business", { idempotency_key: `rf-${randomUUID()}`, payment_intent_id: parent.payment_intent_id, amount_ore: 2_000 });
    const refundsBefore = stripe.refundCalls;
    const capturesBefore = vipps.captureCalls;
    const req = await fin("owner-signed", "request", { tool: "finance_stripe.submit_refund", refund_id: refund.refund_id });
    expect(req.status).toBe(200);
    expect(data(req)["summary"]).toBe(`refusjon 20,00 NOK via stripe (betaling ${parent.payment_intent_id})`);
    expect(stripe.refundCalls).toBe(refundsBefore);
    const ok = await decide("owner-signed", String(data(req)["confirmation_id"]), "approve");
    expect(ok.status).toBe(200);
    expect(stripe.refundCalls).toBe(refundsBefore + 1);
    expect(((await adminPool.query("SELECT state FROM stripe_refunds WHERE refund_id = $1", [refund.refund_id])).rows[0] as { state: string }).state).toBe("settled");

    const vp = await newStripeIntent({ provider: "vipps" });
    await adminPool.query("UPDATE payment_intents SET state = 'provider_acknowledged', provider_ref = $2, provider_status = 'AUTHORIZED', provider_status_updated_at = now() WHERE payment_intent_id = $1", [vp.payment_intent_id, vp.payment_intent_id]);
    const capture = await finance.createVippsCapture(TENANT, "business", { idempotency_key: `cap-${randomUUID()}`, payment_intent_id: vp.payment_intent_id, amount_ore: 3_000 });
    const creq = await fin("owner-signed", "request", { tool: "finance_vipps.submit_capture", capture_id: capture.capture_id });
    expect(creq.status).toBe(200);
    expect(vipps.captureCalls).toBe(capturesBefore);
    expect((await decide("owner-signed", String(data(creq)["confirmation_id"]), "approve")).status).toBe(200);
    expect(vipps.captureCalls).toBe(capturesBefore + 1);
  });

  it("request avviser med årsak FØR noen bekreftelse opprettes når tilstanden ikke tillater det (mål finnes ikke, ugyldig tilstand, duplikat må kvitteres)", async () => {
    const missing = await fin("owner-signed", "request", { tool: "finance.submit_payment_intent", payment_intent_id: "fin-pi-finnes-ikke" });
    expect(missing.status).toBe(404);
    expect(missing.body["error"]).toBe("target_not_found");

    const a = await newStripeIntent({ vendor_name: "Duplikat Test AS", amount_ore: 55_500 });
    const b = await newStripeIntent({ vendor_name: "duplikat test as", amount_ore: 55_500 });
    const reqA = await fin("owner-signed", "request", { tool: "finance.submit_payment_intent", payment_intent_id: a.payment_intent_id });
    expect((await decide("owner-signed", String(data(reqA)["confirmation_id"]), "approve")).status).toBe(200);
    const before = await confCount("finance.submit_payment_intent");
    const dup = await fin("owner-signed", "request", { tool: "finance.submit_payment_intent", payment_intent_id: b.payment_intent_id });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ error: "not_submittable", reason: `possible_duplicate_of:${a.payment_intent_id}` });
    expect(await confCount("finance.submit_payment_intent")).toBe(before);
    // eieren kvitterer eksplisitt for duplikat-id-en -> bekreftelse kan opprettes, og kvitteringen er en del av det BUNDNE kallet
    const ack = await fin("owner-signed", "request", { tool: "finance.submit_payment_intent", payment_intent_id: b.payment_intent_id, confirm_possible_duplicate_of: [a.payment_intent_id] });
    expect(ack.status).toBe(200);
    expect((await confRow(String(data(ack)["confirmation_id"])))!["parameters"]).toEqual({ tenant_id: TENANT, payment_intent_id: b.payment_intent_id, confirm_possible_duplicate_of: [a.payment_intent_id] });
  });
});

describe("D: avvisning, utløp, nødbryter og tilstand som endrer seg etter forespørselen", () => {
  it("avvisning utfører aldri (og krever ikke step-up); en avvist bekreftelse kan ikke godkjennes etterpå", async () => {
    const intent = await newStripeIntent();
    const before = stripe.createCalls;
    const req = await fin("owner-signed", "request", { tool: "finance.submit_payment_intent", payment_intent_id: intent.payment_intent_id });
    const id = String(data(req)["confirmation_id"]);
    expect((await decide("owner-active", id, "reject")).status).toBe(200); // risikoreduserende: ingen step-up
    expect((await decide("owner-signed", id, "approve")).status).toBe(404);
    expect(stripe.createCalls).toBe(before);
    expect(await intentState(intent.payment_intent_id)).toBe("draft");
    // en ny forespørsel etter avvisning gir en NY ventende bekreftelse (eieren kan ombestemme seg)
    const again = await fin("owner-signed", "request", { tool: "finance.submit_payment_intent", payment_intent_id: intent.payment_intent_id });
    expect(data(again)).toMatchObject({ created: true });
    expect(data(again)["confirmation_id"]).not.toBe(id);
  });

  it("utløpt bekreftelse kan ikke godkjennes", async () => {
    const intent = await newStripeIntent();
    const before = stripe.createCalls;
    const req = await fin("owner-signed", "request", { tool: "finance.submit_payment_intent", payment_intent_id: intent.payment_intent_id });
    const id = String(data(req)["confirmation_id"]);
    await adminPool.query("UPDATE action_confirmations SET expires_at = now() - interval '1 minute' WHERE confirmation_id = $1", [id]);
    expect((await decide("owner-signed", id, "approve")).status).toBe(404);
    expect(stripe.createCalls).toBe(before);
  });

  it("nødbryteren: aktiv ved forespørsel -> 409 uten bekreftelse; slått på ETTER forespørselen -> godkjenning gir avslag fra pipelinen, null leverandørkall", async () => {
    const a = await newStripeIntent();
    const b = await newStripeIntent();
    const reqB = await fin("owner-signed", "request", { tool: "finance.submit_payment_intent", payment_intent_id: b.payment_intent_id });
    const idB = String(data(reqB)["confirmation_id"]);
    await finance.enableKillSwitch(TENANT, OWNER, "wpf1-api-test");
    try {
      const blocked = await fin("owner-signed", "request", { tool: "finance.submit_payment_intent", payment_intent_id: a.payment_intent_id });
      expect(blocked.status).toBe(409);
      expect(blocked.body).toMatchObject({ error: "not_submittable", reason: "finance_kill_switch_active" });
      const callsBefore = stripe.createCalls;
      const approved = await decide("owner-signed", idB, "approve");
      expect(approved.status).toBe(409);
      expect(data(approved)["result"]).toMatchObject({ ok: false, reason: "preflight_invalid:finance_kill_switch_active" });
      expect(stripe.createCalls).toBe(callsBefore);
      expect(await intentState(b.payment_intent_id)).toBe("draft");
    } finally {
      await finance.disableKillSwitch(TENANT, OWNER);
    }
    // bekreftelsen er brukt opp (engangs): eieren må be om en ny etter at nødbryteren er slått av
    expect((await decide("owner-signed", idB, "approve")).status).toBe(404);
    const fresh = await fin("owner-signed", "request", { tool: "finance.submit_payment_intent", payment_intent_id: b.payment_intent_id });
    expect(fresh.status).toBe(200);
    expect((await decide("owner-signed", String(data(fresh)["confirmation_id"]), "approve")).status).toBe(200);
  });

  it("tilstand som endrer seg mellom forespørsel og godkjenning valideres på nytt av pipelinen (aldri den gamle forhåndsvisningen)", async () => {
    const intent = await newStripeIntent();
    const before = stripe.createCalls;
    const req = await fin("owner-signed", "request", { tool: "finance.submit_payment_intent", payment_intent_id: intent.payment_intent_id });
    await adminPool.query("UPDATE payment_intents SET state = 'cancelled', cancelled_at = now() WHERE payment_intent_id = $1", [intent.payment_intent_id]);
    const approved = await decide("owner-signed", String(data(req)["confirmation_id"]), "approve");
    expect(approved.status).toBe(409);
    expect(data(approved)["result"]).toMatchObject({ ok: false, reason: "preflight_invalid:not_submittable:cancelled" });
    expect(stripe.createCalls).toBe(before);
  });

  it("ikke-pengebekreftelser (modellens forslag) trenger fortsatt ikke step-up: kun definisjoner med step_up_required gater godkjenningen", () => {
    expect(gateway.get("finance", "submit_payment_intent")?.step_up_required).toBe(true);
    expect(gateway.get("finance_stripe", "submit_refund")?.step_up_required).toBe(true);
    expect(gateway.get("finance_vipps", "submit_capture")?.step_up_required).toBe(true);
    expect(gateway.get("finance_vipps", "submit_refund")?.step_up_required).toBe(true);
    expect(gateway.get("finance_stripe", "request_refund")?.step_up_required).toBeUndefined();
    expect(gateway.get("finance", "create_payment_intent")?.step_up_required).toBeUndefined();
  });
});

describe("E: kildevakt - rekkefølgen i rutene er låst (step-up FØR lesing/opprettelse/forbruk)", () => {
  const server = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");

  it("/finance/actions: eier-sjekk og step-up kommer FØR tilstandslesing og opprettelse av bekreftelse", () => {
    const start = server.indexOf('url.pathname === "/finance/actions"');
    const end = server.indexOf('url.pathname === "/memory/proposals"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = server.slice(start, end);
    const owner = block.indexOf("finance_actions_require_owner");
    const stepUp = block.indexOf("stepUpDenial(");
    const preview = block.indexOf("previewFinanceAction(");
    const request = block.indexOf("requestPending(");
    expect(owner).toBeGreaterThan(-1);
    expect(stepUp).toBeGreaterThan(owner);
    expect(preview).toBeGreaterThan(stepUp);
    expect(request).toBeGreaterThan(preview);
    // ruten kjører ALDRI selve pengehandlingen
    expect(block).not.toMatch(/gateway\.execute\(/); // ruten kaller aldri gatewayen selv - kun previewFinanceAction (lesing)
    expect(block).not.toMatch(/approveAndTake\(/);
    expect(block).not.toMatch(/checkAndConsume\(/);
  });

  it("/confirmations: step-up for step_up_required-handlinger kommer FØR bekreftelsen forbrukes (approveAndTake)", () => {
    const start = server.indexOf('url.pathname === "/confirmations"');
    const end = server.indexOf('url.pathname === "/finance/actions"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = server.slice(start, end);
    const gate = block.indexOf("step_up_required === true");
    const take = block.indexOf("approveAndTake(");
    expect(gate).toBeGreaterThan(-1);
    expect(take).toBeGreaterThan(gate);
    expect(block.indexOf("stepUpDenial(")).toBeLessThan(take);
  });
});

describe("F: ConfirmationStore.requestPending / peekPending - bundet til kall, person, tenant og enhet; aldri forbruk", () => {
  const call = (id: string) => ({ tool_id: "finance", action: "submit_payment_intent", parameters: { tenant_id: TENANT, payment_intent_id: id } as Record<string, string> });
  const who = (over: Record<string, string> = {}) => ({ tenant_id: TENANT, person_id: OWNER, device_id: "dev-own", session_id: "s-store", ...over });

  it("samme kall + person + enhet gir samme ventende bekreftelse; annen enhet eller person gir en annen (bindingen inkluderer begge)", async () => {
    const store = new ConfirmationStore(appPool);
    const a = await store.requestPending(call("fin-pi-store-1"), who(), ["owner_finance_action_request"], "betaling 1,00 NOK via stripe");
    const b = await store.requestPending(call("fin-pi-store-1"), who(), ["owner_finance_action_request"]);
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, confirmation_id: a.confirmation_id });
    const otherDevice = await store.requestPending(call("fin-pi-store-1"), who({ device_id: "dev-annen" }), []);
    const otherPerson = await store.requestPending(call("fin-pi-store-1"), who({ person_id: GUEST }), []);
    const otherTarget = await store.requestPending(call("fin-pi-store-2"), who(), []);
    expect(new Set([a.confirmation_id, otherDevice.confirmation_id, otherPerson.confirmation_id, otherTarget.confirmation_id]).size).toBe(4);
    const stored = (await confRow(a.confirmation_id))!;
    expect(stored["status"]).toBe("pending");
    expect(stored["binding_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(String(stored["expires_at"])).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(String(stored["expires_at"])).getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 5_000);
  });

  it("display redigeres for hemmeligheter og kuttes - og er ren visning (ikke en del av bindingen)", async () => {
    const store = new ConfirmationStore(appPool);
    const r = await store.requestPending(call("fin-pi-store-3"), who(), [], `betaling med nøkkel sk_live_${"a".repeat(24)} ${"x".repeat(600)}`);
    const summary = (await confRow(r.confirmation_id))!["summary"] as { display: string };
    expect(summary.display).not.toContain("sk_live_");
    expect(summary.display).toContain("[REDACTED");
    expect(summary.display.length).toBeLessThanOrEqual(450);
  });

  it("peekPending: kun samme person og tenant, kun ventende og ikke utløpt - og rører ikke bekreftelsen", async () => {
    const store = new ConfirmationStore(appPool);
    const r = await store.requestPending(call("fin-pi-store-4"), who(), []);
    expect(await store.peekPending({ tenant_id: TENANT, person_id: OWNER }, r.confirmation_id)).toEqual({ tool_id: "finance", action: "submit_payment_intent" });
    expect(await store.peekPending({ tenant_id: TENANT, person_id: GUEST }, r.confirmation_id)).toBeNull();
    expect(await store.peekPending({ tenant_id: TENANT_B, person_id: OWNER }, r.confirmation_id)).toBeNull();
    expect(await store.peekPending({ tenant_id: TENANT, person_id: OWNER }, "conf-finnes-ikke")).toBeNull();
    expect((await confRow(r.confirmation_id))!["status"]).toBe("pending");
    await adminPool.query("UPDATE action_confirmations SET expires_at = now() - interval '1 second' WHERE confirmation_id = $1", [r.confirmation_id]);
    expect(await store.peekPending({ tenant_id: TENANT, person_id: OWNER }, r.confirmation_id)).toBeNull();
    // en utløpt ventende bekreftelse gjenbrukes ikke: ny forespørsel gir en ny
    const again = await store.requestPending(call("fin-pi-store-4"), who(), []);
    expect(again).toMatchObject({ created: true });
    expect(again.confirmation_id).not.toBe(r.confirmation_id);
    // etter at den er tatt (godkjent og forbrukt) er den ikke lenger ventende
    expect(await store.approveAndTake({ tenant_id: TENANT, person_id: OWNER, device_id: "dev-own" }, again.confirmation_id)).not.toBeNull();
    expect(await store.peekPending({ tenant_id: TENANT, person_id: OWNER }, again.confirmation_id)).toBeNull();
  });
});

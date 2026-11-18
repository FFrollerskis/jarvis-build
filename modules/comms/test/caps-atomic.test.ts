import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import { ConversationGraphService } from "@jarvis/conversation-graph";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type SecretProvider } from "@jarvis/tool-gateway";
import {
  CommsStore, CommsTransport, OutboundFunnel, commsToolDefinitions, executeCommsOwnerAction, parseCommsConfig, parseCallParams, parseSendParams, rateCaps, recipientHash,
  type AdapterMap, type FunnelContext, type ParsedOutbound
} from "../src/index.ts";
import { OWNER, TENANT_A, scriptedAdapter, startCommsDb, type CommsDb } from "./support/harness.ts";

/**
 * WP-G1 fiks-runde A-H2: ratetakene er ATOMISKE under samtidighet. Før: policyen leste tellerne i én transaksjon og `beginAttempt` skrev i en annen uten lås - N samtidige sendinger så alle «0 sendt» (reviewer-repro:
 * 4 samtidige til kald mottaker med tak 1 ga 1/3/3/4 leverandørkall; konto-tak 5/t ga 8 sendt; 2 samtidige `start_call` ga 2 anrop). Nå tar `beginAttempt` en transaksjonsbundet lås, teller på nytt og skriver i SAMME transaksjon.
 * Alle testene bruker ekte `Promise.all` mot embedded Postgres (RLS som app-rolle) - ingen sekvensiell etterligning.
 */
let db: CommsDb;
let store: CommsStore;
let funnel: OutboundFunnel;
let gateway: ToolGateway;
let now = new Date("2026-11-17T11:00:00Z"); // 12:00 Oslo
const clock = () => now;
const twilio = scriptedAdapter("twilio");
const slack = scriptedAdapter("slack");
const config = parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "sms,slack,phone", JARVIS_COMMS_CALLS: "on", JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR: "5" });
const ctx: FunnelContext = { tenantId: TENANT_A, space: "business", actor: { person_id: OWNER, session_id: "sess-caps" }, source: "owner_route" };
const owner: IdentityContext = { person_id: OWNER, tenant_id: TENANT_A, memory_space_id: "business", session_id: "sess-caps-gw", device_id: "dev-caps", channel: "api", auth_strength: "signed" };
let n = 0;
const key = (p: string) => `${p}-${++n}-${Math.random().toString(36).slice(2, 8)}`;
const phone = () => `+4790${String(500000 + ++n).padStart(6, "0").slice(-6)}`;
const ownerGate = (identity: IdentityContext): boolean => identity.person_id === OWNER && identity.tenant_id === TENANT_A;
const act = (action: string, parameters: Record<string, JsonValue>, idem?: string) => executeCommsOwnerAction({ gateway, funnel, ownerGate }, owner, { action, parameters, ...(idem ? { idempotency_key: idem } : {}) });
const must = (r: ReturnType<typeof parseSendParams>): ParsedOutbound => { if (!r.ok) throw new Error(r.code); return r.value; };
const sendParsed = (over: Record<string, unknown> = {}): ParsedOutbound => must(parseSendParams({ request_id: key("req"), channel: "sms", account_ref: "+4791000000", recipient: phone(), purpose: "transactional", text: "Hei, timen din er bekreftet.", ...over }));
const journal = async (where: string, values: unknown[]) => (await db.admin.query(`SELECT request_id, status, denial_codes, kind FROM comms_outbound_log WHERE tenant_id = '${TENANT_A}' AND ${where}`, values)).rows as Array<{ request_id: string; status: string; denial_codes: string[]; kind: string }>;

beforeAll(async () => {
  db = await startCommsDb("g1cap");
  store = new CommsStore(db.app, clock);
  const graph = new ConversationGraphService(db.app);
  (twilio as unknown as { call: unknown }).call = async (req: Record<string, unknown>, cred: string) => { twilio.calls.push({ op: "call", request: { ...req }, credential: cred }); return { provider_message_id: `CA-${twilio.calls.length}` }; };
  const adapters: AdapterMap = { twilio, slack };
  funnel = new OutboundFunnel({ store, graph, adapters, config, clock });
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A] } });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === BUSINESS_INTERNAL_CREDENTIAL_REF ? "internal-no-external-credential" : ref.startsWith("JARVIS_") ? "fake-token-for-test" : null) };
  gateway = new ToolGateway(db.app, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async () => undefined } },
    credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT_A], internalRefs: new Set([BUSINESS_INTERNAL_CREDENTIAL_REF]) }
  });
  for (const d of commsToolDefinitions({ transport: new CommsTransport({ funnel, store }), store, rateLimitPerMinute: 1000, calls: true })) gateway.register(d);
  for (const [channel, account_ref, provider] of [["sms", "+4791000000", "twilio"], ["sms", "+4792000000", "twilio"], ["slack", "T0AAAAAAAA", "slack"], ["phone", "+4791000000", "twilio"]] as const) {
    const r = await act("authorize_account", { channel, account_ref, provider }, key("auth"));
    if (!r.ok) throw new Error(`authorize: ${JSON.stringify(r)}`);
  }
}, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);
beforeEach(() => { now = new Date("2026-11-17T11:00:00Z"); twilio.calls.length = 0; slack.calls.length = 0; });

describe("rateCaps: én kilde for policyens tørrkjøring og den atomiske håndhevelsen", () => {
  it("kald/varm mottaker, samtale og handlinger uten mottakertak får riktig grense og kode; kontotaket gjelder alle", () => {
    expect(rateCaps("message", true, config)).toEqual({ recipient: { kind: "message", limit: 1, code: "rate_limit_cold_recipient_day" }, account: { limit: 5, code: "rate_limit_account_hour" } });
    expect(rateCaps("message", false, config).recipient).toEqual({ kind: "message", limit: 3, code: "rate_limit_recipient_day" });
    expect(rateCaps("call", true, config).recipient).toEqual({ kind: "call", limit: 1, code: "rate_limit_calls_per_number_day" });
    for (const kind of ["edit", "delete", "reaction"] as const) expect(rateCaps(kind, true, config)).toEqual({ recipient: null, account: { limit: 5, code: "rate_limit_account_hour" } });
  });
});

describe("A-H2: tak per mottaker holder under samtidighet (ekte Promise.all)", () => {
  it("4 samtidige sendinger (ulike nøkler) til SAMME kalde mottaker (tak 1/døgn) gir NØYAKTIG ett leverandørkall; de tre andre avslås og journalføres som `denied` med takkoden", async () => {
    const recipient = phone();
    const results = await Promise.all(Array.from({ length: 4 }, () => act("send", { channel: "sms", account_ref: "+4791000000", recipient, purpose: "transactional", text: "Hei, timen din er bekreftet." }, key("r"))));
    expect(twilio.calls.filter((c) => c.op === "send")).toHaveLength(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const hash = recipientHash(TENANT_A, "sms", recipient);
    const rows = await journal("recipient_hash = $1 ORDER BY created_at", [hash]);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(1);
    const denied = rows.filter((r) => r.status === "denied");
    expect(denied.length).toBeGreaterThanOrEqual(3);
    for (const d of denied) expect(d.denial_codes).toContain("rate_limit_cold_recipient_day");
  });

  it("20 samtidige direkte funnel.execute til samme mottaker (tak 1) gir ett kall - også uten ToolGateway foran", async () => {
    const recipient = phone();
    const settled = await Promise.allSettled(Array.from({ length: 20 }, () => funnel.execute(ctx, sendParsed({ recipient }), "fake-token-for-test")));
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(twilio.calls.filter((c) => c.op === "send")).toHaveLength(1);
    for (const s of settled) if (s.status === "rejected") expect(String((s.reason as Error).message)).toMatch(/^comms_policy_denied:.*rate_limit_cold_recipient_day/);
  });

  it("samme `request_id` samtidig er en gjenspilling, ikke et tak-avslag: ett kall, og den andre får replay-/dedup-svar (ikke `comms_policy_denied`)", async () => {
    const recipient = phone();
    const parsed = sendParsed({ recipient });
    const settled = await Promise.allSettled([funnel.execute(ctx, parsed, "fake-token-for-test"), funnel.execute(ctx, parsed, "fake-token-for-test")]);
    expect(twilio.calls.filter((c) => c.op === "send")).toHaveLength(1);
    for (const s of settled) if (s.status === "rejected") expect(String((s.reason as Error).message)).not.toMatch(/comms_policy_denied/);
    expect((await journal("request_id = $1", [parsed.request_id])).filter((r) => r.status !== "denied")).toHaveLength(1);
  });

  it("2 samtidige `start_call` til samme nummer (tak 1/døgn) gir NØYAKTIG ett anrop", async () => {
    const recipient = phone();
    const p = { channel: "phone", account_ref: "+4791000000", recipient, purpose: "transactional", text: "Hei, jeg ringer om timen." } as Record<string, JsonValue>;
    const results = await Promise.all([act("start_call", p, key("c")), act("start_call", p, key("c"))]);
    expect(twilio.calls.filter((c) => c.op === "call")).toHaveLength(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const direct = await Promise.allSettled([funnel.execute(ctx, must(parseCallParams({ request_id: key("cd"), channel: "phone", account_ref: "+4791000000", recipient: phone(), purpose: "transactional", text: "Hei, jeg ringer." })), "fake-token-for-test"),
      funnel.execute(ctx, must(parseCallParams({ request_id: key("cd"), channel: "phone", account_ref: "+4791000000", recipient: phone(), purpose: "transactional", text: "Hei, jeg ringer." })), "fake-token-for-test")]);
    expect(direct.every((s) => s.status === "fulfilled")).toBe(true); // ulike numre: begge går (kontotaket er 5/t)
  });
});

describe("A-H2: tak per konto per time holder under samtidighet", () => {
  it("8 samtidige sendinger til ULIKE mottakere fra én konto (tak 5/t) gir NØYAKTIG 5 leverandørkall; resten journalføres som `rate_limit_account_hour`", async () => {
    now = new Date("2026-11-17T12:00:00Z"); // eget vindu: tidligere tester er > 1 t unna
    await Promise.all(Array.from({ length: 8 }, () => act("send", { channel: "sms", account_ref: "+4792000000", recipient: phone(), purpose: "transactional", text: "Hei, timen din er bekreftet." }, key("a"))));
    const calls = twilio.calls.filter((c) => c.op === "send" && (c.request["account_ref"] as string) === "+4792000000");
    expect(calls).toHaveLength(5);
    const rows = await journal("account_ref = '+4792000000' AND created_at >= $1", [new Date("2026-11-17T12:00:00Z")]);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(5);
    const denied = rows.filter((r) => r.status === "denied");
    expect(denied).toHaveLength(3);
    for (const d of denied) expect(d.denial_codes).toContain("rate_limit_account_hour");
  });

  it("forsøk som er `requested`/`outcome_unknown` teller i takene (en utsendelse som henger eller har ukjent utfall frigjør ikke plassen)", async () => {
    now = new Date("2026-11-17T14:00:00Z");
    const recipient = phone();
    const first = sendParsed({ recipient, account_ref: "+4791000000" });
    const hash = recipientHash(TENANT_A, "sms", recipient);
    const entry = (p: ParsedOutbound) => ({
      request_id: p.request_id, kind: "message" as const, channel: "sms" as const, account_ref: "+4791000000", provider: "twilio" as const, recipient_hash: hash, recipient_hint: "+47•••000", purpose: "transactional" as const,
      rule_evaluation: [], denial_codes: [], recipient_proof: { method: "explicit_param" as const, identity_id: null, confidence: null, last_inbound_age_minutes: null }, content_sha256: null, content_length: 5, ai_disclosure_applied: true, source: "tool" as const
    });
    const caps = rateCaps("message", true, config);
    const a = await store.beginAttempt(TENANT_A, "business", entry(first), ctx.actor, 30, caps);
    expect(a.kind).toBe("started"); // status `requested`
    expect((await store.beginAttempt(TENANT_A, "business", entry(sendParsed({ recipient })), ctx.actor, 30, caps)).kind).toBe("cap_exceeded");
    if (a.kind === "started") await store.settleAttempt(TENANT_A, "business", a.log_id, { status: "outcome_unknown" });
    expect((await store.beginAttempt(TENANT_A, "business", entry(sendParsed({ recipient })), ctx.actor, 30, caps)).kind).toBe("cap_exceeded");
    // `failed` frigjør plassen (leverandøren avslo; ingenting ble levert)
    const other = phone();
    const failedOne = await store.beginAttempt(TENANT_A, "business", { ...entry(sendParsed({ recipient: other })), recipient_hash: recipientHash(TENANT_A, "sms", other) }, ctx.actor, 30, caps);
    if (failedOne.kind === "started") await store.settleAttempt(TENANT_A, "business", failedOne.log_id, { status: "failed" });
    expect((await store.beginAttempt(TENANT_A, "business", { ...entry(sendParsed({ recipient: other })), recipient_hash: recipientHash(TENANT_A, "sms", other) }, ctx.actor, 30, caps)).kind).toBe("started");
  });

  it("24 t-vinduet: et forsøk 23 t 59 min gammelt teller fortsatt, et 24 t 1 min gammelt teller ikke", async () => {
    const recipient = phone();
    const hash = recipientHash(TENANT_A, "sms", recipient);
    const base = new Date("2026-11-18T08:00:00Z");
    now = base;
    const caps = rateCaps("message", true, config);
    const mk = (p: ParsedOutbound) => ({
      request_id: p.request_id, kind: "message" as const, channel: "sms" as const, account_ref: "+4791000000", provider: "twilio" as const, recipient_hash: hash, recipient_hint: "+47•••000", purpose: "transactional" as const,
      rule_evaluation: [], denial_codes: [], recipient_proof: { method: "explicit_param" as const, identity_id: null, confidence: null, last_inbound_age_minutes: null }, content_sha256: null, content_length: 5, ai_disclosure_applied: true, source: "tool" as const
    });
    const first = await store.beginAttempt(TENANT_A, "business", mk(sendParsed({ recipient })), ctx.actor, 30, caps);
    expect(first.kind).toBe("started");
    now = new Date(base.getTime() + (24 * 60 - 1) * 60_000);
    expect((await store.beginAttempt(TENANT_A, "business", mk(sendParsed({ recipient })), ctx.actor, 30, caps)).kind).toBe("cap_exceeded");
    now = new Date(base.getTime() + (24 * 60 + 1) * 60_000);
    expect((await store.beginAttempt(TENANT_A, "business", mk(sendParsed({ recipient })), ctx.actor, 30, caps)).kind).toBe("started");
  });
});

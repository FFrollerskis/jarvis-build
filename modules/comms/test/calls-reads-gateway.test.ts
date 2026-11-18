import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import { ConversationGraphService } from "@jarvis/conversation-graph";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type ClassDNotification, type SecretProvider } from "@jarvis/tool-gateway";
import {
  CommsStore, CommsTransport, OutboundFunnel, SlackAdapter, TelnyxSmsAdapter, TwilioSmsAdapter, VendorReads, commsToolDefinitions, executeCommsOwnerAction, parseCommsConfig, type AdapterMap
} from "../src/index.ts";
import { OWNER, TENANT_A, startCommsDb, type CommsDb } from "./support/harness.ts";

/** Et Twilio-lignende meldings-SID bygget ved kjøring (aldri en bokstavelig nøkkel-lignende streng i kildekoden). */
const SM_SID = `SM${"0123456789abcdef".repeat(2)}`;

/**
 * WP-G1 (P1c/P3h): utgående AI-samtale og leverandør-lesing gjennom den EKSAKTE kjeden (ekte ToolGateway med klasse D-pipeline, ekte policy og journal mot embedded Postgres, RLS som app-rolle; kun `fetch` er stubbet).
 * Samtale: AI-opplysningen er første talte innhold, opptak avslås med kode, eget tidsvindu, ratebegrensning per nummer, avmelding, markedsføringsforbud, Telnyx feiler lukket, gjenspilling ringer aldri to ganger.
 * Lesing: kun autoriserte kontoer, riktig leverandør, ubetrodd output - og begge verktøysettene finnes KUN med sitt eget flagg.
 */
let db: CommsDb;
let store: CommsStore;
let now = new Date("2026-11-17T11:00:00Z"); // 12:00 Oslo (vintertid)
const clock = () => now;
let gateway: ToolGateway;
let funnel: OutboundFunnel;
const notifications: ClassDNotification[] = [];
interface Call { url: string; init: RequestInit }
let calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response> = () => new Response("{}", { status: 200 });

const owner: IdentityContext = { person_id: OWNER, tenant_id: TENANT_A, memory_space_id: "business", session_id: "sess-g1-cr", device_id: "dev-g1", channel: "api", auth_strength: "signed" };
const ownerGate = (identity: IdentityContext): boolean => identity.person_id === OWNER && identity.tenant_id === TENANT_A;
const deps = () => ({ gateway, funnel, ownerGate });
let n = 0;
const key = (p: string) => `${p}-${++n}-${Math.random().toString(36).slice(2, 8)}`;
const phone = () => `+4790${String(100000 + ++n).padStart(6, "0").slice(-6)}`;
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const form = (c: Call): URLSearchParams => new URLSearchParams(String(c.init.body));

const TWILIO_PHONE = "+4791000000";
const TELNYX_PHONE = "+4792000000";
const TWILIO_SMS = "+4793000000";
const TELNYX_SMS = "+4794000000";
const SLACK_TEAM = "T0AAAAAAAA";

beforeAll(async () => {
  db = await startCommsDb("g1cr");
  store = new CommsStore(db.app, clock);
  const graph = new ConversationGraphService(db.app);
  const config = parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "phone,sms,slack", JARVIS_COMMS_CALLS: "on", JARVIS_COMMS_VENDOR_READS: "on" });
  const sid = async () => "ACfaketestsid0000000000";
  const adapters: AdapterMap = { twilio: new TwilioSmsAdapter(sid), telnyx: new TelnyxSmsAdapter(), slack: new SlackAdapter() };
  funnel = new OutboundFunnel({ store, graph, adapters, config, clock });
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A] } });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === BUSINESS_INTERNAL_CREDENTIAL_REF ? "internal-no-external-credential" : ref.startsWith("JARVIS_") ? "fake-token-for-test" : null) };
  gateway = new ToolGateway(db.app, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (x) => { notifications.push(x); } } },
    credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT_A], internalRefs: new Set([BUSINESS_INTERNAL_CREDENTIAL_REF]) }
  });
  const reads = new VendorReads({ graphVersion: config.graph_api_version, accountSid: sid });
  for (const d of commsToolDefinitions({ transport: new CommsTransport({ funnel, store, reads }), store, rateLimitPerMinute: 1000, calls: true, vendorReads: true })) gateway.register(d);
  for (const [channel, account_ref, provider] of [
    ["phone", TWILIO_PHONE, "twilio"], ["phone", TELNYX_PHONE, "telnyx"], ["sms", TWILIO_SMS, "twilio"], ["sms", TELNYX_SMS, "telnyx"], ["slack", SLACK_TEAM, "slack"]
  ] as const) {
    const r = await executeCommsOwnerAction(deps(), owner, { action: "authorize_account", parameters: { channel, account_ref, provider }, idempotency_key: key("auth") });
    if (!r.ok) throw new Error(`authorize: ${JSON.stringify(r)}`);
  }
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

beforeEach(() => {
  now = new Date("2026-11-17T11:00:00Z");
  notifications.length = 0;
  calls = [];
  respond = () => jsonRes({ sid: "CAfake0000000000000000000000000001", status: "queued" }, 201);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  });
});
afterEach(() => vi.unstubAllGlobals());

const callParams = (over: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({ channel: "phone", account_ref: TWILIO_PHONE, recipient: phone(), purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei, dette gjelder timen din i morgen.", ...over });
const startCall = (over: Record<string, JsonValue> = {}, idem = key("call")) => executeCommsOwnerAction(deps(), owner, { action: "start_call", parameters: callParams(over), idempotency_key: idem });
const journalOf = async (requestId: string) => (await db.admin.query("SELECT kind, status, denial_codes, content_length, provider_message_id FROM comms_outbound_log WHERE request_id = $1 ORDER BY created_at", [requestId])).rows as
  Array<{ kind: string; status: string; denial_codes: string[]; content_length: number; provider_message_id: string | null }>;
const denied = (r: Awaited<ReturnType<typeof startCall>>): string[] => {
  if (r.ok || r.status !== "denied") throw new Error(`forventet avslag: ${JSON.stringify(r)}`);
  return [...r.denial_codes];
};

describe("A: utgående AI-samtale (Twilio, inline TwiML)", () => {
  it("gyldig samtale: ett Twilio-kall, AI-opplysningen FØRST i manuset, ingen opptaksparameter, journal `call`/`sent` med hash+lengde, eier-varsel uten manus", async () => {
    const idem = key("call-ok");
    const r = await startCall({ text: "Hei, dette gjelder timen din i morgen." }, idem);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.external_id).toBe("CAfake0000000000000000000000000001");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACfaketestsid0000000000/Calls.json");
    const f = form(calls[0]!);
    expect([...f.keys()].sort()).toEqual(["From", "To", "Twiml"]);
    expect(f.get("From")).toBe(TWILIO_PHONE);
    const say = /<Say [^>]*>([\s\S]*)<\/Say>/.exec(f.get("Twiml")!)?.[1];
    expect(say?.startsWith("Sendt av Jarvis (AI-assistent). Hei, dette gjelder")).toBe(true);
    const rows = await journalOf(idem);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "call", status: "sent", provider_message_id: "CAfake0000000000000000000000000001" });
    expect(rows[0]?.content_length).toBeGreaterThan("Hei, dette gjelder timen din i morgen.".length);
    expect(JSON.stringify(rows)).not.toContain("timen din");
    expect(notifications.length).toBeGreaterThan(0);
    expect(JSON.stringify(notifications)).not.toContain("timen din");
  });

  it("AI-opplysningen settes først selv når manuset nevner den senere (aldri etter at motparten har hørt resten)", async () => {
    const r = await startCall({ text: "Hei, timen din er i morgen. Sendt av Jarvis (AI-assistent)." });
    expect(r.ok).toBe(true);
    const say = /<Say [^>]*>([\s\S]*)<\/Say>/.exec(form(calls[0]!).get("Twiml")!)?.[1];
    expect(say?.startsWith("Sendt av Jarvis (AI-assistent). Hei, timen din")).toBe(true);
  });

  it("opptak kan ikke slås på: `recording: true` avslås med kode (ignoreres aldri stille), og ingenting ringes", async () => {
    const r = await startCall({ recording: true });
    expect(denied(r)).toContain("call_recording_not_supported");
    expect(calls).toEqual([]);
  });

  it("eget samtaletidsvindu (09-20 Oslo): utenfor avslås; stille-timer-unntaket «de skrev til oss» gjelder aldri samtaler", async () => {
    now = new Date("2026-11-17T20:30:00Z"); // 21:30 Oslo
    expect(denied(await startCall())).toContain("outside_call_window");
    now = new Date("2026-11-17T06:30:00Z"); // 07:30 Oslo
    expect(denied(await startCall())).toContain("outside_call_window");
    expect(calls).toEqual([]);
  });

  it("maks ett anrop per nummer per døgn (standard): nytt forsøk med NY nøkkel avslås av policyen, ikke av nøkkelen", async () => {
    const recipient = phone();
    expect((await startCall({ recipient })).ok).toBe(true);
    expect(denied(await startCall({ recipient }))).toContain("rate_limit_calls_per_number_day");
    expect(calls).toHaveLength(1);
  });

  it("registrert avmelding på kanalen `phone` stopper samtalen (selv for `agreed`); formål markedsføring feiler lukket; `agreed` krever bevis på forhold", async () => {
    const optedOut = phone();
    const oo = await executeCommsOwnerAction(deps(), owner, { action: "record_opt_out", parameters: { channel: "phone", account_ref: TWILIO_PHONE, recipient: optedOut } });
    expect(oo.ok).toBe(true);
    expect(denied(await startCall({ recipient: optedOut, purpose: "agreed" }))).toContain("recipient_opted_out");
    expect(denied(await startCall({ purpose: "marketing", text: "Tilbud! Svar STOPP for å reservere deg." }))).toEqual(expect.arrayContaining(["marketing_blocked_reservation_register_unverified"]));
    expect(denied(await startCall({ purpose: "agreed" }))).toContain("agreed_requires_relationship_evidence");
    expect(calls).toEqual([]);
  });

  it("alle avslagskoder kommer samtidig (ingen kortslutning) og avslaget journalføres som bevis uten manus", async () => {
    now = new Date("2026-11-17T22:30:00Z");
    const idem = key("call-deny");
    const r = await startCall({ recording: true, purpose: "marketing", text: "Rabatt-tilbud" }, idem);
    const codes = denied(r);
    expect(codes).toEqual(expect.arrayContaining(["outside_call_window", "call_recording_not_supported", "marketing_blocked_reservation_register_unverified"]));
    const rows = await journalOf(idem);
    expect(rows.map((x) => x.status)).toEqual(["denied"]);
    expect(rows[0]?.kind).toBe("call");
    expect(JSON.stringify(rows)).not.toContain("Rabatt");
  });

  it("Telnyx-konto feiler LUKKET (ingen `call`-metode: AI-opplysningen kan ikke garanteres som første talte innhold) - ingenting ringes og ingenting journalføres", async () => {
    const idem = key("call-telnyx");
    const before = ((await db.admin.query("SELECT count(*)::int AS n FROM comms_outbound_log")).rows[0] as { n: number }).n;
    const r = await startCall({ account_ref: TELNYX_PHONE }, idem);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe("failed");
    expect(r.status === "failed" ? r.reason : "").toContain("comms_action_not_supported_by_provider");
    expect(calls).toEqual([]);
    expect(((await db.admin.query("SELECT count(*)::int AS n FROM comms_outbound_log")).rows[0] as { n: number }).n).toBe(before);
  });

  it("gjenspilling med SAMME nøkkel ringer ALDRI to ganger (ledger), og kanal/skjema utenfor `phone`-samtale avvises", async () => {
    const idem = key("call-replay");
    const params = callParams();
    const a = await executeCommsOwnerAction(deps(), owner, { action: "start_call", parameters: params, idempotency_key: idem });
    const b = await executeCommsOwnerAction(deps(), owner, { action: "start_call", parameters: params, idempotency_key: idem });
    expect(a.ok && b.ok).toBe(true);
    expect(b.ok && b.deduplicated).toBe(true);
    expect(calls).toHaveLength(1);
    for (const over of [{ channel: "sms" }, { channel: "slack" }, { extra: true }, { text: "" }, { account_ref: "" }] as Array<Record<string, JsonValue>>) {
      expect(await startCall(over), JSON.stringify(over)).toEqual({ ok: false, status: "rejected", reason: "invalid_parameters" });
    }
    expect(calls).toHaveLength(1);
  });

  it("ukjent utfall (5xx fra leverandøren): journalen står `outcome_unknown` og et nytt forsøk med SAMME nøkkel ringer aldri en gang til", async () => {
    respond = () => new Response("nede", { status: 503 });
    const idem = key("call-unknown");
    const params = callParams();
    const first = await executeCommsOwnerAction(deps(), owner, { action: "start_call", parameters: params, idempotency_key: idem });
    expect(first.ok).toBe(false);
    expect((await journalOf(idem)).map((x) => x.status)).toEqual(["outcome_unknown"]);
    respond = () => jsonRes({ sid: "CAfake0000000000000000000000000009" }, 201);
    const again = await executeCommsOwnerAction(deps(), owner, { action: "start_call", parameters: params, idempotency_key: idem });
    expect(again.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("B: leverandør-lesing (klasse A, ubetrodd output, kun autoriserte kontoer)", () => {
  it("`read_thread` mot en autorisert Slack-konto: Slack-tokenet brukes, resultatet er renset og merket `untrusted`", async () => {
    respond = () => jsonRes({ ok: true, messages: [{ ts: "1700000000.000100", user: "U012AB3CD", text: `hei${String.fromCodePoint(0)}du` }] });
    const r = await executeCommsOwnerAction(deps(), owner, { action: "read_thread", parameters: { channel: "slack", account_ref: SLACK_TEAM, channel_id: "C012AB3CD45", thread_ts: "1700000000.000100" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output_trust).toBe("untrusted");
    expect(r.data).toEqual({ messages: [{ id: "1700000000.000100", author: "U012AB3CD", text: "heidu", ts: "1700000000.000100" }] });
    expect(calls).toHaveLength(1);
    expect((calls[0]?.init.headers as Record<string, string>)["authorization"]).toBe("Bearer fake-token-for-test");
  });

  it("en konto eieren IKKE har autorisert gir fail-closed credential-feil - ingen leverandørkall", async () => {
    const r = await executeCommsOwnerAction(deps(), owner, { action: "read_thread", parameters: { channel: "slack", account_ref: "T0BBBBBBBB", channel_id: "C012AB3CD45", thread_ts: "1700000000.000100" } });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : (r as { reason: string }).reason).toBe("credential_ref_unresolved");
    expect(calls).toEqual([]);
  });

  it("riktig leverandør kreves: `read_message` mot en Telnyx-SMS-konto avvises (aldri en Telnyx-nøkkel mot Twilio-API-et), mot en Twilio-konto virker", async () => {
    const wrong = await executeCommsOwnerAction(deps(), owner, { action: "read_message", parameters: { channel: "sms", account_ref: TELNYX_SMS, message_sid: SM_SID } });
    expect(wrong.ok).toBe(false);
    expect(wrong.ok ? "" : (wrong as { reason: string }).reason).toContain("comms_read_not_supported_by_provider");
    expect(calls).toEqual([]);
    respond = () => jsonRes({ sid: SM_SID, status: "delivered", direction: "outbound-api", error_code: null, date_sent: "Mon, 16 Aug 2026 03:45:01 +0000", body: "Hei" });
    const ok = await executeCommsOwnerAction(deps(), owner, { action: "read_message", parameters: { channel: "sms", account_ref: TWILIO_SMS, message_sid: SM_SID } });
    expect(ok.ok).toBe(true);
    expect(ok.ok ? ok.output_trust : "").toBe("untrusted");
  });

  it("ugyldige id-er og ekstra felt avvises av skjemaet FØR kall (ingen sti-/spørringsinjeksjon)", async () => {
    for (const parameters of [
      { channel: "slack", account_ref: SLACK_TEAM, channel_id: "../admin", thread_ts: "1700000000.000100" },
      { channel: "slack", account_ref: SLACK_TEAM, channel_id: "C012AB3CD45", thread_ts: "1700000000.000100", extra: 1 },
      { channel: "slack", account_ref: SLACK_TEAM, channel_id: "C012AB3CD45", thread_ts: "nå" },
      { channel: "discord", account_ref: SLACK_TEAM, channel_id: "1", message_id: "2" }
    ] as Array<Record<string, JsonValue>>) {
      const r = await executeCommsOwnerAction(deps(), owner, { action: parameters["channel"] === "discord" ? "get_message" : "read_thread", parameters });
      expect(r.ok, JSON.stringify(parameters)).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("verktøyene finnes KUN med sine egne flagg: uten `calls`/`vendorReads` er hverken start_call, evaluate_call eller de fem lesehandlingene registrert", () => {
    const names = (opts: { calls?: boolean; vendorReads?: boolean }) => commsToolDefinitions({ transport: {} as never, store, ...opts }).map((d) => d.action);
    const base = names({});
    expect(base).not.toEqual(expect.arrayContaining(["start_call"]));
    for (const a of ["start_call", "evaluate_call", "read_thread", "list_users", "get_message", "list_templates", "read_message"]) expect(base, a).not.toContain(a);
    expect(names({ calls: true })).toEqual(expect.arrayContaining(["start_call", "evaluate_call"]));
    expect(names({ calls: true })).not.toContain("read_thread");
    expect(names({ vendorReads: true })).toEqual(expect.arrayContaining(["read_thread", "list_users", "get_message", "list_templates", "read_message"]));
    expect(names({ vendorReads: true })).not.toContain("start_call");
    const all = commsToolDefinitions({ transport: {} as never, store, calls: true, vendorReads: true });
    expect(all.find((d) => d.action === "start_call")).toMatchObject({ capability_class: "D", class_d_profile: "outbound_message", owner_only: true });
    for (const a of ["read_thread", "list_users", "get_message", "list_templates", "read_message"]) expect(all.find((d) => d.action === a), a).toMatchObject({ capability_class: "A", output_trust: "untrusted", owner_only: true });
  });
});

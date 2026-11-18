// REVIEWER A (WP-G1, D-463) - REPRO-PAKKE. Plasseres midlertidig som `modules/comms/test/zz-g1-review-a.test.ts` og kjøres som `postgres`:
//   su postgres -s /bin/bash -c 'export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=/opt/node22/bin:$PATH; cd <worktree> && pnpm exec vitest run modules/comms/test/zz-g1-review-a.test.ts --maxWorkers=2'
// Hver test uttrykker ÆNKET ATFERD og er RØD på HEAD 4b2dfce7 (bekrefter funnet); grønn når funnet er rettet. Ikke en del av grenen (slett etter bruk).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import { ConversationGraphService } from "@jarvis/conversation-graph";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, assertManifestInvariants, buildToolManifest, type ClassDNotification, type SecretProvider } from "@jarvis/tool-gateway";
import { CommsStore, CommsTransport, OutboundFunnel, WhatsAppAdapter, commsToolDefinitions, executeCommsOwnerAction, parseCommsConfig, type AdapterMap } from "../src/index.ts";
import { OWNER, TENANT_A, scriptedAdapter, startCommsDb, type CommsDb } from "./support/harness.ts";

let db: CommsDb;
let store: CommsStore;
let now = new Date("2026-11-17T11:00:00Z"); // 12:00 Oslo
const clock = () => now;
const twilio = scriptedAdapter("twilio");
const telnyx = scriptedAdapter("telnyx");
const slack = scriptedAdapter("slack", () => ({ provider_message_id: `17318${Math.floor(Math.random() * 900000 + 100000)}.000100` }));
let gateway: ToolGateway;
let funnel: OutboundFunnel;
const notifications: ClassDNotification[] = [];
const owner: IdentityContext = { person_id: OWNER, tenant_id: TENANT_A, memory_space_id: "business", session_id: "sess-rva", device_id: "dev-rva", channel: "api", auth_strength: "signed" };
let n = 0;
const key = (p: string) => `${p}-${++n}-${Math.random().toString(36).slice(2, 8)}`;
const phone = () => `+4790${String(400000 + ++n).padStart(6, "0").slice(-6)}`;
const ownerGate = (identity: IdentityContext): boolean => identity.person_id === OWNER && identity.tenant_id === TENANT_A;
const deps = () => ({ gateway, funnel, ownerGate });
const act = (action: string, parameters: Record<string, JsonValue>, idem?: string, identity: IdentityContext = owner) => executeCommsOwnerAction(deps(), identity, { action, parameters, ...(idem ? { idempotency_key: idem } : {}) });
const sendP = (over: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({ channel: "sms", account_ref: "+4791000000", recipient: phone(), purpose: "transactional", text: "Hei, timen din er bekreftet.", ...over });
const slackP = (over: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({ channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", purpose: "transactional", text: "Hei", ...over });

beforeAll(async () => {
  db = await startCommsDb("rvapack");
  store = new CommsStore(db.app, clock);
  const graph = new ConversationGraphService(db.app);
  const config = parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "sms,slack,phone", JARVIS_COMMS_CALLS: "on", JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR: "1000" });
  (twilio as unknown as { call: unknown }).call = async (req: Record<string, unknown>, cred: string) => { twilio.calls.push({ op: "call", request: { ...req }, credential: cred }); return { provider_message_id: `CA-${twilio.calls.length}` }; };
  const adapters: AdapterMap = { twilio, telnyx, slack };
  funnel = new OutboundFunnel({ store, graph, adapters, config, clock });
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A] } });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === BUSINESS_INTERNAL_CREDENTIAL_REF ? "internal-no-external-credential" : ref.startsWith("JARVIS_") ? "fake-token-for-test" : null) };
  gateway = new ToolGateway(db.app, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (x) => { notifications.push(x); } } },
    credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT_A], internalRefs: new Set([BUSINESS_INTERNAL_CREDENTIAL_REF]) }
  });
  for (const d of commsToolDefinitions({ transport: new CommsTransport({ funnel, store }), store, rateLimitPerMinute: 1000, calls: true })) gateway.register(d);
  for (const [channel, account_ref, provider] of [["sms", "+4791000000", "twilio"], ["sms", "+4792000000", "telnyx"], ["slack", "T0AAAAAAAA", "slack"], ["phone", "+4791000000", "twilio"]] as const) {
    const r = await act("authorize_account", { channel, account_ref, provider }, key("auth"));
    if (!r.ok) throw new Error(`authorize: ${JSON.stringify(r)}`);
  }
}, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);
beforeEach(() => { now = new Date("2026-11-17T11:00:00Z"); for (const a of [twilio, telnyx, slack]) a.calls.length = 0; notifications.length = 0; });
afterEach(() => vi.unstubAllGlobals());

describe("H1: oppstart med alle flagg (manifest-invariantene)", () => {
  it("commsToolDefinitions med contacts/meetings/calls/vendorReads består assertManifestInvariants (ellers stopper main.ts:1188 API-et)", () => {
    const transport = { invoke: async () => ({}) } as never;
    const defs = commsToolDefinitions({ transport, store: {} as never, calls: true, vendorReads: true, contacts: true, meetings: true });
    expect(() => assertManifestInvariants(buildToolManifest(defs), { ignoreUnregisteredGrants: true })).not.toThrow();
  });
});

describe("H2: ratebegrensning er atomisk under samtidighet", () => {
  it("4 samtidige sendinger (ulike nøkler) til SAMME kalde mottaker (tak 1/døgn) gir høyst ÉN leverandørkall", async () => {
    const recipient = phone();
    await Promise.all(Array.from({ length: 4 }, () => act("send", sendP({ recipient }), key("r"))));
    expect(twilio.calls.filter((c) => c.op === "send")).toHaveLength(1);
  });

  it("2 samtidige `start_call` til samme nummer (tak 1/døgn) gir høyst ÉN samtale", async () => {
    const recipient = phone();
    const p = { channel: "phone", account_ref: "+4791000000", recipient, purpose: "transactional", text: "Hei, jeg ringer om timen." } as Record<string, JsonValue>;
    await Promise.all([act("start_call", p, key("c")), act("start_call", p, key("c"))]);
    expect(twilio.calls.filter((c) => c.op === "call")).toHaveLength(1);
  });
});

describe("M1: WhatsApp lyd mister AI-opplysningen (journalen sier likevel `ai_disclosure_applied`)", () => {
  it("nyttelasten til Meta for en lydmelding bærer opplysningen (eller policyen avslår lyd)", async () => {
    const calls: Array<{ body: string }> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { calls.push({ body: String(init.body) }); return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200, headers: { "content-type": "application/json" } }); });
    await new WhatsAppAdapter("v25.0").send({ account_ref: "109876543210", recipient: "+4790000000", text: "Hei\n\nSendt av Jarvis (AI-assistent).", template: null, media: { kind: "audio", url: "https://cdn.example.com/a.mp3" }, thread_ref: null }, "t");
    expect(calls[0]!.body).toContain("Sendt av Jarvis");
  });
});

describe("M5: samme idempotensnøkkel gjenbrukt til en ANNEN handling/nyttelast gir ikke falsk suksess", () => {
  it("annen mottaker/tekst med samme nøkkel avvises (eller sendes), men svares aldri `ok + deduplicated` uten å sendes", async () => {
    const k = key("same");
    const a = await act("send", sendP({ recipient: "+4790611111", text: "Første" }), k);
    const b = await act("send", sendP({ recipient: "+4790622222", text: "Helt annen melding" }), k);
    expect(a.ok).toBe(true);
    expect(b.ok && b.deduplicated, "falsk suksess: ingenting ble sendt til mottaker 2").toBe(false);
  });

  it("delete_message med nøkkelen til en tidligere send svarer ikke `ok + deduplicated` (meldingen er ikke slettet)", async () => {
    const k = key("kdel");
    const s = await act("send", slackP({ recipient: "C0DDDDDDDD" }), k);
    const del = await act("delete_message", { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0DDDDDDDD", target_message_id: s.ok ? String(s.external_id) : "x" }, k);
    expect(slack.calls.some((c) => c.op === "delete")).toBe(true);
    expect(del.ok && del.deduplicated).toBe(false);
  });
});

describe("M4: feil ETTER at leverandøren har akseptert (journal-settle) er ukjent utfall, ikke `failed`", () => {
  it("journalen blir `outcome_unknown`/ledger `unverified`, og en ny nøkkel til samme kalde mottaker sender ikke på nytt", async () => {
    const orig = store.settleAttempt.bind(store);
    let armed = true;
    (store as unknown as { settleAttempt: unknown }).settleAttempt = async (...args: Parameters<typeof orig>) => {
      if (armed && args[3].status === "sent") { armed = false; throw new Error("db_hiccup_simulated"); }
      return orig(...args);
    };
    try {
      const k = key("s1");
      const recipient = phone();
      await act("send", sendP({ recipient }), k);
      const ledger = (await db.admin.query("SELECT status FROM tool_executions WHERE idempotency_key = $1", [k])).rows[0] as { status: string };
      const journal = (await db.admin.query("SELECT status FROM comms_outbound_log WHERE request_id = $1", [k])).rows[0] as { status: string };
      await act("send", sendP({ recipient }), key("s1b"));
      expect(ledger.status).toBe("unverified");
      expect(journal.status).not.toBe("failed");
      expect(twilio.calls.filter((c) => c.op === "send")).toHaveLength(1);
    } finally { (store as unknown as { settleAttempt: unknown }).settleAttempt = orig; }
  });
});

describe("M6: edit_message har før/etter-evidens og markedsføringssjekk", () => {
  it("ledger før-tilstand er ikke tom (preflight kjører faktisk mot leverandøren)", async () => {
    const s = await act("send", slackP({ recipient: "C0EEEEEEEE" }), key("ee1"));
    const k = key("ee2");
    await act("edit_message", { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0EEEEEEEE", target_message_id: s.ok ? String(s.external_id) : "x", text: "Rettet tekst" }, k);
    const row = (await db.admin.query("SELECT before_state FROM tool_executions WHERE idempotency_key = $1", [k])).rows[0] as { before_state: unknown };
    expect(row.before_state).not.toBeNull();
  });

  it("redigering til reklametekst avslås som ved sending", async () => {
    const s = await act("send", slackP({ recipient: "C0FFFFFFFF" }), key("em1"));
    const e = await act("edit_message", { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0FFFFFFFF", target_message_id: s.ok ? String(s.external_id) : "x", text: "Spesialtilbud: 50% rabatt, kjøp nå! Gratis frakt." }, key("em2"));
    expect(e.ok).toBe(false);
  });
});

describe("M3: avmelding (STOP) gjelder mottakeren, ikke bare én avsender-konto/ett rom", () => {
  it("STOP registrert for konto A stopper også sending fra konto B på samme kanal", async () => {
    const num = phone();
    await act("record_opt_out", { channel: "sms", account_ref: "+4791000000", recipient: num });
    const viaB = await act("send", sendP({ recipient: num, account_ref: "+4792000000" }), key("ob"));
    expect(viaB.ok).toBe(false);
  });

  it("STOP på kanalen `sms` stopper også AI-ringing til samme nummer", async () => {
    const num = phone();
    await act("record_opt_out", { channel: "sms", account_ref: "*", recipient: num });
    const call = await act("start_call", { channel: "phone", account_ref: "+4791000000", recipient: num, purpose: "transactional", text: "Hei, jeg ringer om timen." }, key("oc"));
    expect(call.ok).toBe(false);
  });

  it("STOP med `*` i rom `business` gjelder også fra rom `project`", async () => {
    const projectOwner: IdentityContext = { ...owner, memory_space_id: "project", session_id: "sess-rva-project" };
    await act("authorize_account", { channel: "sms", account_ref: "+4795000000", provider: "twilio" }, key("sp3"), projectOwner);
    const num = phone();
    await act("record_opt_out", { channel: "sms", account_ref: "*", recipient: num });
    const r = await act("send", sendP({ account_ref: "+4795000000", recipient: num }), key("sp4"), projectOwner);
    expect(r.ok).toBe(false);
  });
});

describe("M7: record_opt_out med ugyldig/avvikende account_ref blir ikke en stille no-op", () => {
  it("avmelding med feilskrevet konto avvises eller gjelder likevel", async () => {
    const num = phone();
    const rec = await act("record_opt_out", { channel: "sms", account_ref: "+47 91 00 00 00", recipient: num });
    const send = await act("send", sendP({ recipient: num }), key("md1"));
    expect(rec.ok === false || send.ok === false).toBe(true);
  });
});

describe("L: rom-grind og autorisering på tvers av rom", () => {
  it("en identitet i rommet `health` skriver ingen comms-rader (rom-sjekken gjelder også dry-run/avslagsjournal)", async () => {
    const healthOwner: IdentityContext = { ...owner, memory_space_id: "health", session_id: "sess-rva-health" };
    await act("send", sendP(), key("hs"), healthOwner);
    const rows = ((await db.admin.query("SELECT count(*)::int AS n FROM comms_outbound_log WHERE memory_space_id = 'health'")).rows[0] as { n: number }).n;
    expect(rows).toBe(0);
  });

  it("samme konto autorisert i et annet rom gir en ryddig feilkode (ikke TypeError-tekst)", async () => {
    const personalOwner: IdentityContext = { ...owner, memory_space_id: "personal", session_id: "sess-rva-personal" };
    const r = await act("authorize_account", { channel: "sms", account_ref: "+4791000000", provider: "twilio" }, key("sp2"), personalOwner);
    expect(JSON.stringify(r)).not.toContain("Cannot read properties");
  });
});

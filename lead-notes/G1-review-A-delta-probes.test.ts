// REVIEWER A DELTA-PROBER (WP-G1 d79b0434). Midlertidig fil i worktree, slettes etter bruk. Hver test uttrykker ØNSKET atferd; RØD = funn.
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import {
  CommsWebhookService, TwilioSmsAdapter, WEBHOOK_SECRET_REFS, WhatsAppAdapter, optOutHash, rateCaps, recipientHash, twilioSignatureBase, parseSendParams, type WebhookRequest
} from "../src/index.ts";
import { OWNER, TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

const BASE = "https://hooks.example.com";
const TWILIO_TOKEN = "fake-twilio-auth-token";
const META_SECRET = "fake-meta-app-secret";
let chain: Chain;
let webhooks: CommsWebhookService;
let sid = 0;
let midn = 0;

const secs = () => Math.floor(chain.now().getTime() / 1000);
const twilioReq = (fields: Record<string, string>): WebhookRequest => {
  const params = new Map(Object.entries(fields).map(([k, v]) => [k, [v]] as [string, string[]]));
  const sig = createHmac("sha1", TWILIO_TOKEN).update(twilioSignatureBase(`${BASE}/webhooks/comms/twilio`, params), "utf8").digest("base64");
  return { method: "POST", headers: { "x-twilio-signature": sig }, rawBody: Buffer.from(new URLSearchParams(fields).toString()), pathAndQuery: "/webhooks/comms/twilio", query: new URLSearchParams() };
};
const inboundSms = (from: string, to: string, text: string) => twilioReq({ MessageSid: `SM${String(++sid).padStart(32, "0")}`, From: from, To: to, Body: text, AccountSid: "AC1234567890abcdef" });
const metaReq = (body: object): WebhookRequest => {
  const raw = Buffer.from(JSON.stringify(body));
  return { method: "POST", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", META_SECRET).update(raw).digest("hex")}` }, rawBody: raw, pathAndQuery: "/webhooks/comms/meta", query: new URLSearchParams() };
};
const waMsg = (from: string, text: string) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "4791000000", phone_number_id: "109876543210" }, messages: [{ from, id: `wamid.${++midn}.${Math.random().toString(36).slice(2, 12)}`, timestamp: String(secs()), type: "text", text: { body: text } }] } }] }]
});

const sendP = (over: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({ channel: "sms", account_ref: "+4791000000", recipient: chain.phone(), purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei, timen din er bekreftet.", ...over });
const slackP = (over: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({ channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei", ...over });
const sends = () => chain.twilio.calls.filter((c) => c.op === "send").length + chain.telnyx.calls.filter((c) => c.op === "send").length;
const optActive = async (num: string) => chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", num));

beforeAll(async () => {
  chain = await startChain("rva2", { JARVIS_COMMS_WEBHOOKS: "twilio,meta", JARVIS_COMMS_TENANT_ID: TENANT_A, JARVIS_COMMS_PUBLIC_BASE_URL: BASE, JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR: "1000", JARVIS_COMMS_MEDIA_URL_HOSTS: "cdn.example.com" });
  webhooks = new CommsWebhookService({
    store: chain.store, graph: chain.graph, config: chain.config,
    secrets: { get: async (ref) => (ref === WEBHOOK_SECRET_REFS.twilio ? TWILIO_TOKEN : ref === WEBHOOK_SECRET_REFS.meta ? META_SECRET : null) }, clock: chain.now
  });
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"], ["sms", "+4792000000", "telnyx"], ["phone", "+4791000000", "twilio"], ["whatsapp", "109876543210", "meta_whatsapp"], ["slack", "T0AAAAAAAA", "slack"]]);
  const projectOwner: IdentityContext = { ...chain.owner, memory_space_id: "project", session_id: "sess-rva2-project" };
  await authorizeAll(chain, [["sms", "+4795000000", "twilio"]], projectOwner);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);
beforeEach(() => { for (const a of [chain.twilio, chain.telnyx, chain.slack, chain.whatsapp]) a.calls.length = 0; chain.notifications.length = 0; });
afterEach(() => vi.unstubAllGlobals());

describe("A-H2: samtidighet (gjentatt probe, strengere)", () => {
  it("12 samtidige sendinger til SAMME kalde mottaker i ulike skrivemåter gir ÉN leverandørsending", async () => {
    const n = chain.phone();
    const spaced = `${n.slice(0, 3)} ${n.slice(3, 5)} ${n.slice(5, 7)} ${n.slice(7)}`;
    const zeros = `00${n.slice(1)}`;
    const variants = [n, spaced, zeros, n];
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => chain.act("send", sendP({ recipient: variants[i % variants.length]! }), chain.key("c"))));
    expect(sends()).toBe(1);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it("2 samtidige start_call til samme nummer gir ÉN samtale (også med to ulike skrivemåter)", async () => {
    const n = chain.phone();
    const p = (r: string): Record<string, JsonValue> => ({ channel: "phone", account_ref: "+4791000000", recipient: r, purpose: "transactional", purpose_basis: "recipient_requested_contact", text: "Hei, jeg ringer om timen." });
    const rs = await Promise.all([chain.act("start_call", p(n), chain.key("c")), chain.act("start_call", p(`${n.slice(0, 3)} ${n.slice(3)}`), chain.key("c")), chain.act("start_call", p(n), chain.key("c"))]);
    expect(chain.twilio.calls.filter((c) => c.op === "call")).toHaveLength(1);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it("30 samtidige sendinger via gatewayen til 30 ULIKE mottakere fullfører (ingen dødlås/utarming av pool på 10), alle sendes", async () => {
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: 30 }, () => chain.act("send", sendP(), chain.key("p"))));
    const ms = Date.now() - t0;
    expect(rs.filter((r) => r.ok)).toHaveLength(30);
    expect(sends()).toBe(30);
    expect(ms).toBeLessThan(45_000);
  }, 90_000);

  it("30 samtidige sendinger til SAMME varme mottaker (innkommende siste 7 d, tak 3/døgn) gir NØYAKTIG 3", async () => {
    const n = chain.phone();
    const inb = await webhooks.handle("twilio", inboundSms(n, "+4791000000", "Hei, kan dere ringe meg?"));
    expect(inb.body).toMatchObject({ events: { inserted: 1 } });
    const { purpose_basis: _drop, ...noBasis } = sendP({ recipient: n });
    const rs = await Promise.all(Array.from({ length: 30 }, () => chain.act("send", noBasis as Record<string, JsonValue>, chain.key("w"))));
    expect(sends()).toBe(3);
    expect(rs.filter((r) => r.ok)).toHaveLength(3);
  }, 90_000);

  it("konto-taket (direkte mot lageret, tak 5/t, 14 samtidige forsøk mot ULIKE mottakere) gir nøyaktig 5 `started`", async () => {
    const caps = { recipient: null, account: { limit: 5, code: "rate_limit_account_hour" } } as const;
    const mk = (i: number) => ({
      request_id: `rva2-acct-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`, kind: "message" as const, channel: "sms" as const, account_ref: "+4798111111", provider: "twilio" as const,
      recipient_hash: recipientHash(TENANT_A, "sms", `+479811${String(1000 + i)}`), recipient_hint: "+47•••000", purpose: "transactional" as const, rule_evaluation: [], denial_codes: [],
      recipient_proof: { method: "explicit_param" as const, identity_id: null, confidence: null, last_inbound_age_minutes: null }, content_sha256: null, content_length: 5, ai_disclosure_applied: true, source: "tool" as const
    });
    const rs = await Promise.all(Array.from({ length: 14 }, (_, i) => chain.store.beginAttempt(TENANT_A, "business", mk(i), chain.ctx.actor, 30, caps)));
    expect(rs.filter((r) => r.kind === "started")).toHaveLength(5);
    expect(rs.filter((r) => r.kind === "cap_exceeded")).toHaveLength(9);
  });

  it("(OPEN hos byggeren) taket er per rom: samme kalde mottaker via konto i rom `business` OG konto i rom `project` samtidig", async () => {
    const n = chain.phone();
    const projectOwner: IdentityContext = { ...chain.owner, memory_space_id: "project", session_id: "sess-rva2-project" };
    const [a, b] = await Promise.all([chain.act("send", sendP({ recipient: n }), chain.key("rm")), chain.act("send", sendP({ recipient: n, account_ref: "+4795000000" }), chain.key("rm"), projectOwner)]);
    expect(a.ok || b.ok).toBe(true);
    expect(sends(), "kald mottaker (tak 1/døgn) skal få høyst 1 melding uansett rom").toBe(1);
  });

  it("lås-venting holder ikke på pool-forbindelser etter at en samtidig `beginAttempt` er ferdig: pool er ledig etterpå", async () => {
    const pool = chain.db.app;
    await Promise.all(Array.from({ length: 25 }, () => chain.act("send", sendP(), chain.key("pl"))));
    expect(pool.totalCount - pool.idleCount).toBe(0);
    expect(pool.waitingCount).toBe(0);
  }, 90_000);
});

describe("A-H2 tillegg: dobbeltklikk og ledger-tilstand etter race-avslag", () => {
  it("5 samtidige IDENTISKE forespørsler (samme nøkkel) gir ÉN sending, og de andre er dedup/under-utførelse - aldri to sendinger", async () => {
    const n = chain.phone();
    const k = chain.key("dc");
    const rs = await Promise.all(Array.from({ length: 5 }, () => chain.act("send", sendP({ recipient: n }), k)));
    expect(sends()).toBe(1);
    expect(rs.filter((r) => r.ok && !r.deduplicated)).toHaveLength(1);
  });

  it("4 samtidige til samme kalde mottaker: de avslåtte får ledger `failed` (ikke `reserved`/`unverified`), og nøkkelen kan gjenbrukes etter at taket er fritt", async () => {
    const n = chain.phone();
    const keys = Array.from({ length: 4 }, () => chain.key("lg"));
    const rs = await Promise.all(keys.map((k) => chain.act("send", sendP({ recipient: n }), k)));
    expect(sends()).toBe(1);
    const st = (await chain.db.admin.query("SELECT idempotency_key, status FROM tool_executions WHERE idempotency_key = ANY($1)", [keys])).rows as Array<{ idempotency_key: string; status: string }>;
    const byKey = new Map(st.map((r) => [r.idempotency_key, r.status]));
    for (const [i, k] of keys.entries()) { if (!rs[i]!.ok) expect(byKey.get(k), `ledger for ${k}`).toBe("failed"); }
  });

  it("5 samtidige record_opt_out for samme mottaker gir ÉN aktiv rad", async () => {
    const n = chain.phone();
    await Promise.all(Array.from({ length: 5 }, () => chain.act("record_opt_out", { channel: "sms", recipient: n })));
    const rows = (await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2 AND status = 'active'", [TENANT_A, optOutHash(TENANT_A, "sms", n)])).rows[0] as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe("A-M2: purpose_basis (omgåelsesforsøk)", () => {
  it("reklametekst med `personal_non_commercial`-grunnlag til kald mottaker avslås (ordene teller)", async () => {
    const r = await chain.act("send", sendP({ purpose_basis: "personal_non_commercial", text: "Spesialtilbud: 50% rabatt, kjøp nå! Gratis frakt." }), chain.key("m2a"));
    expect(r.ok).toBe(false);
    expect(sends()).toBe(0);
  });

  it("`agreed` til kald mottaker avslås også med grunnlag; `marketing` avslås også med grunnlag", async () => {
    const a = await chain.act("send", sendP({ purpose: "agreed" }), chain.key("m2b"));
    const m = await chain.act("send", sendP({ purpose: "marketing", text: "Spesialtilbud, svar STOPP for å melde deg av." }), chain.key("m2c"));
    expect(a.ok).toBe(false);
    expect(m.ok).toBe(false);
    expect(sends()).toBe(0);
  });

  it("uten grunnlag til kald mottaker avslås; samme forespørsel med grunnlag sendes; gjenspilling med ANNET grunnlag og samme nøkkel er kollisjon, ikke ny sending", async () => {
    const n = chain.phone();
    const { purpose_basis: _d, ...none } = sendP({ recipient: n });
    const denied = await chain.act("send", none as Record<string, JsonValue>, chain.key("m2d"));
    expect(denied.ok).toBe(false);
    const k = chain.key("m2e");
    const ok1 = await chain.act("send", sendP({ recipient: n }), k);
    expect(ok1.ok).toBe(true);
    const again = await chain.act("send", sendP({ recipient: n }), k);
    expect(again.ok && again.deduplicated).toBe(true);
    const other = await chain.act("send", sendP({ recipient: n, purpose_basis: "consent_obtained_outside_jarvis" }), k);
    expect(other.ok, "annet grunnlag med samme nøkkel skal avvises").toBe(false);
    expect(sends()).toBe(1);
  });

  it("(OPEN hos byggeren) identity_link med lav confidence og vilkårlig match_method gjør en kald mottaker `varm` (ingen purpose_basis kreves)", async () => {
    const n = chain.phone();
    await chain.graph.linkChannelIdentity(TENANT_A, "business", { channel: "sms", channel_identifier: n, confidence: 0.05, match_method: "manual" });
    const { purpose_basis: _d, ...none } = sendP({ recipient: n });
    const r = await chain.act("send", none as Record<string, JsonValue>, chain.key("m2f"));
    expect(r.ok, "lav-confidence lenke bør ikke fjerne grunnlagskravet").toBe(false);
  });

  it("innkommende melding til en ANNEN av våre kontoer gjør ikke mottakeren varm for denne kontoen", async () => {
    const n = chain.phone();
    await webhooks.handle("twilio", inboundSms(n, "+4792000000", "Hei"));
    const { purpose_basis: _d, ...none } = sendP({ recipient: n });
    const r = await chain.act("send", none as Record<string, JsonValue>, chain.key("m2g"));
    expect(r.ok).toBe(false);
  });

  it("innkommende STOP/START gjør ikke mottakeren varm (kun `message` teller)", async () => {
    const n = chain.phone();
    await webhooks.handle("twilio", inboundSms(n, "+4791000000", "STOP"));
    await webhooks.handle("twilio", inboundSms(n, "+4791000000", "START"));
    const { purpose_basis: _d, ...none } = sendP({ recipient: n });
    const r = await chain.act("send", none as Record<string, JsonValue>, chain.key("m2h"));
    expect(r.ok).toBe(false);
  });
});

describe("A-M3/A-M7: STOP-matrisen", () => {
  it("WhatsApp-STOP (Meta) stopper SMS fra begge konti, AI-ringing og WhatsApp til samme nummer", async () => {
    const n = chain.phone();
    const r = await webhooks.handle("meta", metaReq(waMsg(n.replace("+", ""), "stopp")));
    expect(r.body).toMatchObject({ events: { opt_outs: 1 } });
    expect((await chain.act("send", sendP({ recipient: n }), chain.key("s1"))).ok).toBe(false);
    expect((await chain.act("send", sendP({ recipient: n, account_ref: "+4792000000" }), chain.key("s2"))).ok).toBe(false);
    expect((await chain.act("start_call", { channel: "phone", account_ref: "+4791000000", recipient: n, purpose: "transactional", purpose_basis: "recipient_requested_contact", text: "Hei, jeg ringer." }, chain.key("s3"))).ok).toBe(false);
    expect((await chain.act("send", sendP({ channel: "whatsapp", account_ref: "109876543210", recipient: n }), chain.key("s4"))).ok).toBe(false);
    expect(sends() + chain.whatsapp.calls.length + chain.twilio.calls.filter((c) => c.op === "call").length).toBe(0);
  });

  it("formatering: STOP registrert med mellomrom/0047 gjelder også for `+47…`", async () => {
    const n = chain.phone();
    const spaced = `00${n.slice(1)}`;
    expect((await chain.act("record_opt_out", { channel: "sms", recipient: spaced })).ok).toBe(true);
    expect((await chain.act("send", sendP({ recipient: n }), chain.key("s5"))).ok).toBe(false);
  });

  it("eierregistrert STOP som kommer ETTER en stopp-ord-STOP kan likevel ikke løftes av mottakerens START (kontrakten: eierregistrert løftes aldri)", async () => {
    const n = chain.phone();
    await webhooks.handle("twilio", inboundSms(n, "+4791000000", "STOP"));
    const rec = await chain.act("record_opt_out", { channel: "sms", recipient: n });
    expect(rec.ok).toBe(true);
    await webhooks.handle("twilio", inboundSms(n, "+4791000000", "START"));
    expect(await optActive(n), "eierens registrering forsvant stille ved START").toBe(true);
  });

  it("STOP på SMS og så STOP på WhatsApp, så START på WhatsApp: SMS skal fortsatt være stoppet (START gjelder kun samme kanal)", async () => {
    const n = chain.phone();
    await webhooks.handle("twilio", inboundSms(n, "+4791000000", "STOP"));
    await webhooks.handle("meta", metaReq(waMsg(n.replace("+", ""), "stopp")));
    await webhooks.handle("meta", metaReq(waMsg(n.replace("+", ""), "start")));
    const smsAfter = await chain.act("send", sendP({ recipient: n }), chain.key("s6"));
    expect(smsAfter.ok, "SMS-STOP ble løftet av en START på en annen kanal").toBe(false);
  });

  it("omvendt rekkefølge: STOP på WhatsApp, så STOP på SMS, så START på WhatsApp: SMS-STOP skal fortsatt gjelde (START gjelder kun samme kanal)", async () => {
    const n = chain.phone();
    await webhooks.handle("meta", metaReq(waMsg(n.replace("+", ""), "stopp")));
    await webhooks.handle("twilio", inboundSms(n, "+4791000000", "STOP"));
    await webhooks.handle("meta", metaReq(waMsg(n.replace("+", ""), "start")));
    const smsAfter = await chain.act("send", sendP({ recipient: n }), chain.key("s6r"));
    expect(smsAfter.ok, "SMS-STOP ble løftet av en START på WhatsApp").toBe(false);
  });

  it("owner_recorded etter provider_error (21610) absorberes og kan løftes av START på samme kanal", async () => {
    const n = chain.phone();
    const saved = chain.twilio.send;
    chain.twilio.send = async () => { throw new (await import("../src/index.ts")).ProviderRejectedError("twilio", "21610"); };
    try { await chain.act("send", sendP({ recipient: n }), chain.key("pe")); } finally { chain.twilio.send = saved; }
    expect(await optActive(n)).toBe(true);
    expect((await chain.act("record_opt_out", { channel: "sms", recipient: n })).ok).toBe(true);
    await webhooks.handle("twilio", inboundSms(n, "+4791000000", "START"));
    expect(await optActive(n), "eierens registrering ble borte etter START").toBe(true);
  });

  it("START på SAMME kanal etter STOP løfter (kontroll: ikke over-blokkering) og mottakeren kan få melding igjen", async () => {
    const n = chain.phone();
    await webhooks.handle("twilio", inboundSms(n, "+4791000000", "STOP"));
    await webhooks.handle("twilio", inboundSms(n, "+4791000000", "START"));
    const r = await chain.act("send", sendP({ recipient: n }), chain.key("s7"));
    expect(r.ok).toBe(true);
  });

  it("STOP fra en annen tenant påvirker ikke (hash inkluderer tenant)", async () => {
    const n = chain.phone();
    expect(optOutHash("tenant-g1-b", "sms", n)).not.toBe(optOutHash(TENANT_A, "sms", n));
  });
});

describe("A-M4: feil etter akseptert sending", () => {
  it("settle-feil etter akseptert sending gir outcome_unknown (ledger unverified), og leverandør-id-en går IKKE tapt for senere redigering/sletting", async () => {
    const orig = chain.store.settleAttempt.bind(chain.store);
    let armed = true;
    (chain.store as unknown as { settleAttempt: unknown }).settleAttempt = async (...args: Parameters<typeof orig>) => {
      if (armed && args[3].status === "sent") { armed = false; throw new Error("db_hiccup_simulated"); }
      return orig(...args);
    };
    try {
      const k = chain.key("m4");
      const n = chain.phone();
      const r = await chain.act("send", sendP({ recipient: n }), k);
      const ledger = (await chain.db.admin.query("SELECT status FROM tool_executions WHERE idempotency_key = $1", [k])).rows[0] as { status: string };
      const journal = (await chain.db.admin.query("SELECT status, provider_message_id FROM comms_outbound_log WHERE request_id = $1", [k])).rows[0] as { status: string; provider_message_id: string | null };
      expect(r.ok).toBe(false);
      expect(ledger.status).toBe("unverified");
      expect(journal.status).toBe("outcome_unknown");
      expect(sends()).toBe(1);
      expect(journal.provider_message_id, "provider-id er kjent og bør bevares for avstemming").not.toBeNull();
      const again = await chain.act("send", sendP({ recipient: n }), chain.key("m4b"));
      expect(again.ok).toBe(false);
      expect(sends()).toBe(1);
    } finally { (chain.store as unknown as { settleAttempt: unknown }).settleAttempt = orig; }
  });
});

describe("A-M5: forespørselsbundet idempotensnøkkel", () => {
  it("samme nøkkel + annen mottaker/tekst avvises og sender ikke", async () => {
    const k = chain.key("m5a");
    const a = await chain.act("send", sendP({ text: "Første" }), k);
    const b = await chain.act("send", sendP({ text: "Helt annen melding" }), k);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(sends()).toBe(1);
  });

  it("delete_message med nøkkelen til en tidligere send avvises (kollisjon)", async () => {
    const k = chain.key("m5b");
    const s = await chain.act("send", slackP({ recipient: "C0DDDDDDDD" }), k);
    const del = await chain.act("delete_message", { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0DDDDDDDD", target_message_id: s.ok ? String(s.external_id) : "x" }, k);
    expect(del.ok && del.deduplicated).not.toBe(true);
  });

  it("send med en nøkkel som alt er brukt av en IKKE-journalført handling (authorize_account) svarer ikke `ok + deduplicated` uten å sende", async () => {
    const k = chain.key("m5c");
    const auth = await chain.act("authorize_account", { channel: "sms", account_ref: "+4793000000", provider: "twilio" }, k);
    expect(auth.ok).toBe(true);
    const s = await chain.act("send", sendP(), k);
    expect(sends()).toBe(0);
    expect(s.ok && s.deduplicated, "falsk suksess: ingenting ble sendt").not.toBe(true);
  });

  it("record_opt_out med nøkkelen til en tidligere send svarer ikke `ok + deduplicated` uten å registrere STOP", async () => {
    const k = chain.key("m5d");
    const n = chain.phone();
    const s = await chain.act("send", sendP({ recipient: n }), k);
    expect(s.ok).toBe(true);
    const other = chain.phone();
    const r = await chain.act("record_opt_out", { channel: "sms", recipient: other }, k);
    const recorded = await optActive(other);
    expect(recorded || r.ok === false, "STOP ble ikke registrert, men eieren fikk ok").toBe(true);
  });
});

describe("A-M6: edit_message", () => {
  it("preflight er levende (ledger før-tilstand ikke tom), reklametekst i redigering avslås, AI-opplysning legges på, redigering av andres/ukjent melding avslås", async () => {
    const s = await chain.act("send", slackP({ recipient: "C0EEEEEEEE" }), chain.key("m6a"));
    expect(s.ok).toBe(true);
    const target = s.ok ? String(s.external_id) : "x";
    const k = chain.key("m6b");
    const e = await chain.act("edit_message", { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0EEEEEEEE", target_message_id: target, text: "Rettet tekst" }, k);
    expect(e.ok).toBe(true);
    const row = (await chain.db.admin.query("SELECT before_state, after_state FROM tool_executions WHERE idempotency_key = $1", [k])).rows[0] as { before_state: unknown; after_state: unknown };
    expect(row.before_state).not.toBeNull();
    const editCall = chain.slack.calls.filter((c) => c.op === "edit").pop();
    expect(String((editCall?.request as { text?: string } | undefined)?.text)).toContain("Sendt av Jarvis");
    const mk = await chain.act("edit_message", { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0EEEEEEEE", target_message_id: target, text: "Spesialtilbud: 50% rabatt, kjøp nå! Gratis frakt." }, chain.key("m6c"));
    expect(mk.ok).toBe(false);
    const foreign = await chain.act("edit_message", { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0EEEEEEEE", target_message_id: "1700000000.999999", text: "ikke vår" }, chain.key("m6d"));
    expect(foreign.ok).toBe(false);
    const wrongRecipient = await chain.act("edit_message", { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0EEEEEEE2", target_message_id: target, text: "annen mottaker" }, chain.key("m6e"));
    expect(wrongRecipient.ok).toBe(false);
  });
});

describe("A-M1 / L3 / L4: adaptere", () => {
  const okFetch = (calls: Array<{ url: string; body: string }>, ids: string[] = ["wamid.1", "wamid.2"]) => vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: String(init.body) });
    return new Response(JSON.stringify({ messages: [{ id: ids[calls.length - 1] ?? "wamid.x" }] }), { status: 200, headers: { "content-type": "application/json" } });
  });

  it("WhatsApp-lyd: AI-opplysningen sendes som EGEN tekstmelding FØRST, deretter lyden", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    okFetch(calls);
    const r = await new WhatsAppAdapter("v25.0").send({ account_ref: "109876543210", recipient: "+4790000000", text: "Hei\n\nSendt av Jarvis (AI-assistent).", template: null, media: { kind: "audio", url: "https://cdn.example.com/a.mp3" }, thread_ref: null }, "t");
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ type: "text", text: { body: expect.stringContaining("Sendt av Jarvis") } });
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ type: "audio", audio: { link: "https://cdn.example.com/a.mp3" } });
    expect(r.provider_message_id).toBe("wamid.2");
  });

  it("WhatsApp-lyd uten tekst kaster FØR noe sendes (ingen lyd uten opplysning)", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    okFetch(calls);
    await expect(new WhatsAppAdapter("v25.0").send({ account_ref: "109876543210", recipient: "+4790000000", text: null, template: null, media: { kind: "audio", url: "https://cdn.example.com/a.mp3" }, thread_ref: null }, "t")).rejects.toThrow("comms_whatsapp_audio_requires_disclosure_text");
    expect(calls).toHaveLength(0);
  });

  it("WhatsApp-lyd: lyden avvises ETTER at teksten er levert gir outcome_unknown, ikke failed; nettverksfeil på lyden gir også ukjent", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => { n++; return n === 1 ? new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200, headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ error: { code: 131053, message: "media upload error" } }), { status: 400, headers: { "content-type": "application/json" } }); });
    await expect(new WhatsAppAdapter("v25.0").send({ account_ref: "109876543210", recipient: "+4790000000", text: "Hei\n\nSendt av Jarvis (AI-assistent).", template: null, media: { kind: "audio", url: "https://cdn.example.com/a.mp3" }, thread_ref: null }, "t")).rejects.toThrow(/^outcome_unknown:/);
    let m = 0;
    vi.stubGlobal("fetch", async () => { m++; if (m === 1) return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200, headers: { "content-type": "application/json" } }); throw new TypeError("fetch failed"); });
    const err = await new WhatsAppAdapter("v25.0").send({ account_ref: "109876543210", recipient: "+4790000000", text: "Hei\n\nSendt av Jarvis (AI-assistent).", template: null, media: { kind: "audio", url: "https://cdn.example.com/a.mp3" }, thread_ref: null }, "t").catch((e) => e as Error);
    expect(String((err as Error).message), "nettverksfeil på lyden etter levert tekst skal ikke bli en vanlig feil (failed)").toMatch(/^outcome_unknown:/);
  });

  it("ende-til-ende: WhatsApp-lyd via eierkjeden gir adapteren en tekst med AI-opplysningen (innen vindu)", async () => {
    const n = chain.phone();
    await webhooks.handle("meta", metaReq(waMsg(n.replace("+", ""), "Hei, send meg lydmeldingen")));
    const r = await chain.act("send", { channel: "whatsapp", account_ref: "109876543210", recipient: n, purpose: "transactional", media: { kind: "audio", url: "https://cdn.example.com/a.mp3", caption: "Her er beskjeden" } }, chain.key("a1"));
    expect(r.ok).toBe(true);
    const sent = chain.whatsapp.calls.find((c) => c.op === "send");
    expect(String((sent?.request as { text?: string } | undefined)?.text)).toContain("Sendt av Jarvis");
  });

  it("L3: ikke-kanonisk media-URL (store bokstaver i vert, ../, tab, punktum-sti) avslås av policyen; kanonisk godtas", async () => {
    const n = chain.phone();
    await webhooks.handle("meta", metaReq(waMsg(n.replace("+", ""), "Hei")));
    const tab = String.fromCharCode(9);
    for (const url of ["https://CDN.example.com/a.mp3", "https://cdn.example.com/x/../a.mp3", `https://cdn.example.com/a${tab}.mp3`, " https://cdn.example.com/a.mp3", "https://cdn.example.com:443/a.mp3", "https://cdn.example.com/a.mp3#frag "]) {
      const r = await chain.act("send", { channel: "whatsapp", account_ref: "109876543210", recipient: n, purpose: "transactional", media: { kind: "image", url, caption: "Bilde" } }, chain.key("l3"));
      expect(r.ok, url).toBe(false);
      expect(JSON.stringify(r), url).toContain("media_url_invalid");
    }
    expect(chain.whatsapp.calls.filter((c) => c.op === "send")).toHaveLength(0);
    const control = await chain.act("send", { channel: "whatsapp", account_ref: "109876543210", recipient: n, purpose: "transactional", media: { kind: "image", url: "https://cdn.example.com/a.png", caption: "Bilde" } }, chain.key("l3c"));
    expect(control.ok, JSON.stringify(control)).toBe(true);
  });

  it("L4: TwiML har voice-attributt, XML-ugyldige tegn avvises FØR noe sendes, og script-tegn escapes", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { calls.push({ url: String(url), body: String(init.body) }); return new Response(JSON.stringify({ sid: "CA123" }), { status: 201, headers: { "content-type": "application/json" } }); });
    const adapter = new TwilioSmsAdapter(async () => "AC1234567890abcdef");
    await adapter.call({ account_ref: "+4791000000", recipient: "+4790001111", script: "Hei <b>&</b> \"x\"" }, "tok");
    const twiml = new URLSearchParams(calls[0]!.body).get("Twiml") ?? "";
    expect(twiml).toContain("voice=\"");
    expect(twiml).not.toContain("<b>");
    const bad = String.fromCodePoint(0xffff);
    await expect(adapter.call({ account_ref: "+4791000000", recipient: "+4790001111", script: `Hei ${bad}` }, "tok")).rejects.toThrow("comms_twiml_invalid_character");
    await expect(adapter.call({ account_ref: "+4791000000", recipient: "+4790001111", script: `Hei ${String.fromCharCode(0x0b)}` }, "tok")).rejects.toThrow("comms_twiml_invalid_character");
    await expect(adapter.call({ account_ref: "+4791000000", recipient: "+4790001111", script: `Hei ${String.fromCharCode(0xd800)}` }, "tok")).rejects.toThrow("comms_twiml_invalid_character");
    expect(calls).toHaveLength(1);
    await expect(new TwilioSmsAdapter(async () => "AC1234567890abcdef", { callVoice: "Polly.Liv\" onerror=\"x" }).call({ account_ref: "+4791000000", recipient: "+4790001111", script: "Hei" }, "tok")).rejects.toThrow("comms_twilio_call_voice_invalid");
  });

  it("L4: noncharacters i vanlig tekst avslås av policyen (SMS) før adapteren", async () => {
    const r = await chain.act("send", sendP({ text: `Hei ${String.fromCodePoint(0xfdd0)} der` }), chain.key("l4"));
    expect(r.ok).toBe(false);
  });
});

describe("rom og eierflate", () => {
  it("en identitet i rommet `health` skriver ingen comms-rader", async () => {
    const healthOwner: IdentityContext = { ...chain.owner, memory_space_id: "health", session_id: "sess-rva2-health" };
    const r = await chain.act("send", sendP(), chain.key("hs"), healthOwner);
    expect(r.ok).toBe(false);
    const rows = ((await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_outbound_log WHERE memory_space_id = 'health'")).rows[0] as { n: number }).n;
    expect(rows).toBe(0);
  });

  it("autorisering av samme konto i et annet rom gir ryddig feil", async () => {
    const personalOwner: IdentityContext = { ...chain.owner, memory_space_id: "personal", session_id: "sess-rva2-personal" };
    const r = await chain.act("authorize_account", { channel: "sms", account_ref: "+4791000000", provider: "twilio" }, chain.key("sp2"), personalOwner);
    expect(JSON.stringify(r)).not.toContain("Cannot read properties");
    expect(r.ok).toBe(false);
  });

  it("verktøy utenfor eieren (annen person i samme tenant) nektes på alle utgående handlinger", async () => {
    const guest: IdentityContext = { ...chain.owner, person_id: "person-g1-guest", session_id: "sess-rva2-guest" };
    for (const [action, params] of [["send", sendP()], ["record_opt_out", { channel: "sms", recipient: chain.phone() }]] as const) {
      const r = await chain.act(action, params as Record<string, JsonValue>, chain.key("g"), guest);
      expect(r.ok, action).toBe(false);
    }
    expect(OWNER).toBeTruthy();
  });
});

describe("misc", () => {
  it("parseSendParams avviser ukjente felt (strict) og ugyldig basis", () => {
    expect(parseSendParams({ request_id: "req-rva2-0001", channel: "sms", account_ref: "+4791000000", recipient: "+4790000000", purpose: "transactional", text: "Hei", purpose_basis: "x" })).toEqual({ ok: false, code: "invalid_parameters" });
    expect(parseSendParams({ request_id: "req-rva2-0002", channel: "sms", account_ref: "+4791000000", recipient: "+4790000000", purpose: "transactional", text: "Hei", extra: 1 })).toEqual({ ok: false, code: "invalid_parameters" });
  });
  it("rateCaps har ingen mottakertak for redigering/sletting/reaksjon (kun konto)", () => {
    for (const k of ["edit", "delete", "reaction"] as const) expect(rateCaps(k, true, chain.config).recipient).toBeNull();
  });
});

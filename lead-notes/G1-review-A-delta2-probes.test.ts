// REVIEWER A DELTA2 (WP-G1 c0aa2fb8). Midlertidig fil i worktree, slettes etter bruk. Hver test uttrykker ØNSKET atferd; RØD = funn.
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { CommsWebhookService, ProviderRejectedError, WEBHOOK_SECRET_REFS, optOutHash, parseSendParams, scopedIdempotencyKey, twilioSignatureBase, type WebhookRequest } from "../src/index.ts";
import { TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

const BASE = "https://hooks.example.com";
const TWILIO_TOKEN = "fake-twilio-auth-token";
const META_SECRET = "fake-meta-app-secret";
let chain: Chain;
let webhooks: CommsWebhookService;
let sid = 0;
let midn = 0;
let projectOwner: IdentityContext;
let personalOwner: IdentityContext;
let sharedOwner: IdentityContext;

const secs = () => Math.floor(chain.now().getTime() / 1000);
const twilioReq = (fields: Record<string, string>): WebhookRequest => {
  const params = new Map(Object.entries(fields).map(([k, v]) => [k, [v]] as [string, string[]]));
  const sig = createHmac("sha1", TWILIO_TOKEN).update(twilioSignatureBase(`${BASE}/webhooks/comms/twilio`, params), "utf8").digest("base64");
  return { method: "POST", headers: { "x-twilio-signature": sig }, rawBody: Buffer.from(new URLSearchParams(fields).toString()), pathAndQuery: "/webhooks/comms/twilio", query: new URLSearchParams() };
};
const smsIn = (from: string, text: string, to = "+4791000000") => twilioReq({ MessageSid: `SM${String(++sid).padStart(32, "0")}`, From: from, To: to, Body: text, AccountSid: "AC1234567890abcdef" });
const metaReq = (body: object): WebhookRequest => {
  const raw = Buffer.from(JSON.stringify(body));
  return { method: "POST", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", META_SECRET).update(raw).digest("hex")}` }, rawBody: raw, pathAndQuery: "/webhooks/comms/meta", query: new URLSearchParams() };
};
const waIn = (num: string, text: string) => metaReq({
  object: "whatsapp_business_account",
  entry: [{ id: "waba1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "4791000000", phone_number_id: "109876543210" }, messages: [{ from: num.replace("+", ""), id: `wamid.a3.${++midn}.${Math.random().toString(36).slice(2, 12)}`, timestamp: String(secs()), type: "text", text: { body: text } }] } }] }]
});
const sendP = (over: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({ channel: "sms", account_ref: "+4791000000", recipient: chain.phone(), purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei, timen din er bekreftet.", ...over });
const noBasis = (over: Record<string, JsonValue> = {}): Record<string, JsonValue> => { const { purpose_basis: _b, ...rest } = sendP(over); return rest as Record<string, JsonValue>; };
const sends = () => chain.twilio.calls.filter((c) => c.op === "send").length;
const hashOf = (num: string) => optOutHash(TENANT_A, "sms", num);
const optRows = async (num: string) => (await chain.db.admin.query(
  "SELECT channel, account_ref, source, status, memory_space_id FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2 ORDER BY channel, source, status", [TENANT_A, hashOf(num)]
)).rows as Array<{ channel: string; account_ref: string; source: string; status: string; memory_space_id: string }>;
const blocked = (num: string) => chain.store.isOptedOut(TENANT_A, hashOf(num));

beforeAll(async () => {
  chain = await startChain("rva3", { JARVIS_COMMS_WEBHOOKS: "twilio,meta", JARVIS_COMMS_TENANT_ID: TENANT_A, JARVIS_COMMS_PUBLIC_BASE_URL: BASE, JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR: "1000", JARVIS_COMMS_CALLS: "on" }, { rateLimitPerMinute: 1_000_000, lenientToolLimits: true });
  webhooks = new CommsWebhookService({
    store: chain.store, graph: chain.graph, config: chain.config,
    secrets: { get: async (ref) => (ref === WEBHOOK_SECRET_REFS.twilio ? TWILIO_TOKEN : ref === WEBHOOK_SECRET_REFS.meta ? META_SECRET : null) }, clock: chain.now
  });
  projectOwner = { ...chain.owner, memory_space_id: "project", session_id: "sess-a3-project" };
  personalOwner = { ...chain.owner, memory_space_id: "personal", session_id: "sess-a3-personal" };
  sharedOwner = { ...chain.owner, memory_space_id: "shared", session_id: "sess-a3-shared" };
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"], ["sms", "+4792000000", "telnyx"], ["phone", "+4791000000", "twilio"], ["whatsapp", "109876543210", "meta_whatsapp"], ["slack", "T0AAAAAAAA", "slack"]]);
  await authorizeAll(chain, [["sms", "+4795000000", "twilio"], ["phone", "+4795000000", "twilio"]], projectOwner);
  await authorizeAll(chain, [["sms", "+4796100000", "twilio"], ["phone", "+4796100000", "twilio"]], personalOwner);
  await authorizeAll(chain, [["sms", "+4797100000", "twilio"], ["phone", "+4797100000", "twilio"]], sharedOwner);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);
beforeEach(() => { for (const a of [chain.twilio, chain.telnyx, chain.slack, chain.whatsapp]) a.calls.length = 0; });
afterEach(() => vi.unstubAllGlobals());

describe("A-N1: STOP-slots (nye sekvenser)", () => {
  it("flere kontoer: STOP til konto A og konto B (samme kanal) gir én rad; START til konto A løfter (tenant-bredt) - dokumenterer atferden", async () => {
    const n = chain.phone();
    await webhooks.handle("twilio", smsIn(n, "STOP", "+4791000000"));
    await webhooks.handle("twilio", smsIn(n, "STOP", "+4792000000"));
    expect((await optRows(n)).filter((r) => r.status === "active")).toHaveLength(1);
    await webhooks.handle("twilio", smsIn(n, "START", "+4791000000"));
    expect(await blocked(n)).toBe(false);
  });

  it("flere rom: eierregistrert i `project`, stopp-ord (webhook-rommet) og START: kun stopp-ord-raden løftes; eierens rad i `project` består og blokkerer fra ALLE rom", async () => {
    const n = chain.phone();
    expect((await chain.act("record_opt_out", { channel: "sms", recipient: n }, undefined, projectOwner)).ok).toBe(true);
    await webhooks.handle("twilio", smsIn(n, "STOP"));
    await webhooks.handle("twilio", smsIn(n, "START"));
    const rows = await optRows(n);
    expect(rows.filter((r) => r.status === "active").map((r) => `${r.source}@${r.memory_space_id}`)).toEqual(["owner_recorded@project"]);
    expect(await blocked(n)).toBe(true);
    for (const [who, acct] of [[chain.owner, "+4791000000"], [personalOwner, "+4796100000"], [sharedOwner, "+4797100000"], [projectOwner, "+4795000000"]] as const) {
      const r = await chain.act("send", sendP({ recipient: n, account_ref: acct }), chain.key("rm"), who);
      expect(r.ok, `${who.memory_space_id}`).toBe(false);
    }
    expect(sends()).toBe(0);
  });

  it("recipient_request + eier + stopp-ord + provider_error på SAMME kanal: fire rader (en per kilde); START løfter kun de to liftbare", async () => {
    const n = chain.phone();
    await chain.act("record_opt_out", { channel: "sms", recipient: n, source: "recipient_request" });
    await chain.act("record_opt_out", { channel: "sms", recipient: n });
    await webhooks.handle("twilio", smsIn(n, "STOP"));
    const saved = chain.twilio.send;
    chain.twilio.send = async () => { throw new ProviderRejectedError("twilio", "21610"); };
    try {
      const parsed = parseSendParams({ request_id: `${chain.key("pereq")}-xx`, channel: "sms", account_ref: "+4791000000", recipient: n, purpose: "transactional", text: "Hei, timen din er bekreftet.", purpose_basis: "existing_customer_relationship" });
      if (!parsed.ok) throw new Error(parsed.code);
      await chain.funnel.execute(chain.ctx, parsed.value, "t").catch(() => undefined);
    } finally { chain.twilio.send = saved; }
    await webhooks.handle("twilio", smsIn(n, "START"));
    const active = (await optRows(n)).filter((r) => r.status === "active").map((r) => r.source).sort();
    expect(active).toEqual(["owner_recorded", "recipient_request"]);
    expect(await blocked(n)).toBe(true);
  });

  it("formatvarianter: eier registrerer med 0047/mellomrom, stopp-ord kommer fra +47...: samme mottaker, to rader, START løfter kun stopp-ord", async () => {
    const n = chain.phone();
    await chain.act("record_opt_out", { channel: "sms", recipient: `00${n.slice(1)}` });
    await webhooks.handle("twilio", smsIn(n, "Stopp"));
    await webhooks.handle("twilio", smsIn(n, "START"));
    expect((await optRows(n)).filter((r) => r.status === "active").map((r) => r.source)).toEqual(["owner_recorded"]);
  });

  it("START på feil kanal løfter ingenting: STOP sms, START whatsapp => blokkert; START sms => fri. START uten noen avmelding er en no-op", async () => {
    const n = chain.phone();
    await webhooks.handle("twilio", smsIn(n, "STOP"));
    await webhooks.handle("meta", waIn(n, "start"));
    expect(await blocked(n)).toBe(true);
    await webhooks.handle("twilio", smsIn(n, "START"));
    expect(await blocked(n)).toBe(false);
    const m = chain.phone();
    const before = (await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_recipient_opt_outs")).rows[0] as { n: number };
    await webhooks.handle("twilio", smsIn(m, "START"));
    expect(((await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_recipient_opt_outs")).rows[0] as { n: number }).n).toBe(before.n);
  });

  it("samtidige START/STOP/eierregistrering (15 runder): eierens rad består ALLTID (blokkert), og ingen unik-feil (23505) oppstår", async () => {
    let rejected = 0;
    for (let i = 0; i < 15; i++) {
      const n = chain.phone();
      await webhooks.handle("twilio", smsIn(n, "STOP"));
      const rs = await Promise.allSettled([webhooks.handle("twilio", smsIn(n, "START")), chain.act("record_opt_out", { channel: "sms", recipient: n }), webhooks.handle("twilio", smsIn(n, "STOP")), webhooks.handle("meta", waIn(n, "stopp")), webhooks.handle("twilio", smsIn(n, "START"))]);
      rejected += rs.filter((r) => r.status === "rejected").length;
      expect(await blocked(n), `runde ${i}`).toBe(true);
      const active = (await optRows(n)).filter((r) => r.status === "active");
      expect(new Set(active.map((r) => `${r.channel}|${r.source}`)).size, `runde ${i}: duplikater i samme spor`).toBe(active.length);
    }
    expect(rejected).toBe(0);
  }, 120_000);

  it("(informasjon) STOP#2 samtidig med START mot en eksisterende STOP: hvor ofte ender mottakeren FRI? (prosesseringsrekkefølge, ikke tidsstempel)", async () => {
    let free = 0;
    const N = 20;
    for (let i = 0; i < N; i++) {
      const n = chain.phone();
      await webhooks.handle("twilio", smsIn(n, "STOP"));
      await Promise.all([webhooks.handle("twilio", smsIn(n, "START")), webhooks.handle("twilio", smsIn(n, "STOP"))]);
      if (!(await blocked(n))) free++;
    }
    console.log(`INFO STOP#2||START: fri i ${free} av ${N} runder`);
    expect(free).toBeGreaterThanOrEqual(0);
  }, 120_000);
});

describe("A-N2: nøkkelskoping", () => {
  it("SAMME handling, SAMME nøkkel, ULIK nyttelast (ikke-journalført): `record_opt_out(K, A)` så `record_opt_out(K, B)` registrerer B", async () => {
    const k = chain.key("rr");
    const a = chain.phone(); const b = chain.phone();
    expect((await chain.act("record_opt_out", { channel: "sms", recipient: a }, k)).ok).toBe(true);
    const second = await chain.act("record_opt_out", { channel: "sms", recipient: b }, k);
    expect(await blocked(b) || second.ok === false, "B ble ikke registrert, men eieren fikk ok").toBe(true);
  });

  it("SAMME handling, SAMME nøkkel, ULIK konto: `authorize_account(K, X)` så `authorize_account(K, Y)` autoriserer Y", async () => {
    const k = chain.key("aa");
    expect((await chain.act("authorize_account", { channel: "sms", account_ref: "+4793111111", provider: "twilio" }, k)).ok).toBe(true);
    const second = await chain.act("authorize_account", { channel: "sms", account_ref: "+4793222222", provider: "twilio" }, k);
    const y = await chain.store.findActiveAccount(TENANT_A, "business", "sms", "+4793222222");
    expect(y !== null || second.ok === false, "Y ble ikke autorisert, men eieren fikk ok").toBe(true);
  });

  it("lange brukernøkler på IKKE-nøkkelkrevende handlinger (record_opt_out): 160, 200 og 1000 tegn - virker eller avvises tydelig (ingen DB-feil/krasj)", async () => {
    for (const len of [160, 161, 200, 1000]) {
      const r = await chain.act("record_opt_out", { channel: "sms", recipient: chain.phone() }, "z".repeat(len));
      expect(r.ok || (r.ok === false && typeof r.status === "string"), `len ${len}: ${JSON.stringify(r).slice(0, 120)}`).toBe(true);
    }
  });

  it("send med 160 tegn virker, 161-200 avvises `idempotency_key_required` (tydelig regresjon for gamle 161-200-nøkler); ugyldige tegn avvises", async () => {
    expect((await chain.act("send", sendP(), "q".repeat(160))).ok).toBe(true);
    for (const len of [161, 200]) expect(await chain.act("send", sendP(), "q".repeat(len))).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_required" });
    expect(await chain.act("send", sendP(), "has space in key")).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_required" });
  });

  it("nøkkelfunksjonen er injektiv for fast tenant: tilfeldige (handling, nøkkel)-par inkl. nøkler med kolon gir aldri samme skopede streng", () => {
    const actions = ["send", "delete_message", "edit_message", "add_reaction", "start_call", "record_opt_out", "authorize_account", "contacts_create"];
    const seen = new Map<string, string>();
    const alphabet = "abc:._-0";
    const rnd = (n: number) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
    for (let i = 0; i < 20000; i++) {
      const a = actions[Math.floor(Math.random() * actions.length)]!;
      const key = rnd(8 + Math.floor(Math.random() * 12));
      const s = scopedIdempotencyKey(TENANT_A, a, key);
      const id = `${a}|${key}`;
      const prev = seen.get(s);
      if (prev !== undefined) expect(prev).toBe(id);
      seen.set(s, id);
    }
    // nøkler som etterligner skopet form
    const tag = scopedIdempotencyKey(TENANT_A, "send", "x").split(":")[1]!;
    expect(scopedIdempotencyKey(TENANT_A, "send", `delete_message:${tag}:abc`)).not.toBe(scopedIdempotencyKey(TENANT_A, "delete_message", "abc"));
  });

  it("delete/edit/react med samme nøkkel som en tidligere send er uavhengige (ikke kollisjon, ikke dedup)", async () => {
    const k = chain.key("ind");
    const s = await chain.act("send", { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAA9", purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei" }, k);
    expect(s.ok).toBe(true);
    const target = s.ok ? String(s.external_id) : "x";
    const e = await chain.act("edit_message", { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAA9", target_message_id: target, text: "Rettet" }, k);
    expect(e, JSON.stringify(e)).toMatchObject({ ok: true, deduplicated: false });
    expect(chain.slack.calls.filter((c) => c.op === "edit")).toHaveLength(1);
  });
});

describe("A-M2: relasjonsbevis (tilgjengelige veier for å gjøre en kald mottaker varm)", () => {
  const link = async (n: string, method: "contact_sync" | "manual" | "exact_phone_e164" | "owner_configured" | "exact_email", confidence: number, channel: "sms" | "email" | "phone" | "whatsapp" = "sms", identity_id?: string) =>
    chain.graph.linkChannelIdentity(TENANT_A, "business", { channel, channel_identifier: channel === "email" ? n : n, confidence, match_method: method, ...(identity_id !== undefined ? { identity_id } : {}) });
  const cases: Array<[string, "contact_sync" | "manual" | "exact_phone_e164" | "owner_configured", number, boolean]> = [
    ["contact_sync 0,9", "contact_sync", 0.9, false], ["contact_sync 1,0", "contact_sync", 1, false], ["manual 1,0", "manual", 1, false], ["manual 0,05", "manual", 0.05, false],
    ["exact_phone_e164 0,5", "exact_phone_e164", 0.5, false], ["exact_phone_e164 0,89", "exact_phone_e164", 0.89, false], ["exact_phone_e164 0,9", "exact_phone_e164", 0.9, true],
    ["exact_phone_e164 0,95", "exact_phone_e164", 0.95, true], ["owner_configured 0,95", "owner_configured", 0.95, true], ["owner_configured 0,5", "owner_configured", 0.5, false]
  ];
  for (const [label, method, conf, warm] of cases) {
    it(`${label} => ${warm ? "VARM (ingen basis kreves)" : "KALD (basis kreves)"}`, async () => {
      const n = chain.phone();
      await link(n, method, conf);
      const r = await chain.act("send", noBasis({ recipient: n }), chain.key("re"));
      expect(r.ok, JSON.stringify(r).slice(0, 160)).toBe(warm);
    });
  }

  it("e-post-identitet (exact_email 1,0) med telefon lenket som contact_sync: telefonen er fortsatt KALD (ingen kryss-kanal-slutning)", async () => {
    const n = chain.phone();
    const em = await link(`kari${Math.floor(Math.random() * 1e6)}@example.com`, "exact_email", 1, "email");
    await link(n, "contact_sync", 0.9, "sms", em.identity_id);
    const r = await chain.act("send", noBasis({ recipient: n }), chain.key("re2"));
    expect(r.ok).toBe(false);
  });

  it("oppgraderingsforsøk: eksisterende contact_sync-lenke, så exact_phone_e164 1,0 på SAMME (kanal, nummer): metoden beholdes (contact_sync) => fortsatt KALD", async () => {
    const n = chain.phone();
    await link(n, "contact_sync", 0.9);
    await link(n, "exact_phone_e164", 1);
    const r = await chain.act("send", noBasis({ recipient: n }), chain.key("re3"));
    expect(r.ok, "metode ble oppgradert via upsert").toBe(false);
  });

  it("tilbakekalt lenke (status revoked) teller ikke", async () => {
    const n = chain.phone();
    const l = await link(n, "exact_phone_e164", 1);
    await chain.db.admin.query("UPDATE conversation_channel_links SET status = 'revoked' WHERE link_id = $1", [l.link_id]);
    const r = await chain.act("send", noBasis({ recipient: n }), chain.key("re4"));
    expect(r.ok).toBe(false);
  });

  it("to identiteter med samme nummer (konflikt) => ukjent => KALD", async () => {
    const n = chain.phone();
    await link(n, "exact_phone_e164", 1, "sms");
    await chain.db.admin.query("INSERT INTO conversation_identities (identity_id, tenant_id, memory_space_id) VALUES ('conv-id-a3dup', $1, 'business')", [TENANT_A]);
    await chain.db.admin.query("INSERT INTO conversation_channel_links (link_id, tenant_id, memory_space_id, identity_id, channel, channel_identifier, confidence, match_method) VALUES ('conv-link-a3dup', $1, 'business', 'conv-id-a3dup', 'whatsapp', $2, 1, 'exact_phone_e164')", [TENANT_A, n]);
    const r = await chain.act("send", noBasis({ recipient: n }), chain.key("re5"));
    expect(r.ok).toBe(false);
  });

  it("innkommende melding fra nummeret til samme konto (7 d) varmer; 8 døgn gammel gjør kald igjen", async () => {
    const n = chain.phone();
    await webhooks.handle("twilio", smsIn(n, "Hei, kan dere ringe?"));
    expect((await chain.act("send", noBasis({ recipient: n }), chain.key("re6"))).ok).toBe(true);
    const m = chain.phone();
    await webhooks.handle("twilio", smsIn(m, "Hei"));
    const orig = chain.now();
    chain.setNow(new Date(orig.getTime() + 8 * 86_400_000));
    try { expect((await chain.act("send", noBasis({ recipient: m }), chain.key("re7"))).ok).toBe(false); } finally { chain.setNow(orig); }
  });
});

describe("A-H2 rest: tenant-bredt mottakertak og mottakerlås", () => {
  const rooms: Array<[IdentityContext, string]> = [];
  beforeAll(() => { rooms.push([chain.owner, "+4791000000"], [projectOwner, "+4795000000"], [personalOwner, "+4796100000"], [sharedOwner, "+4797100000"]); });

  it("12 samtidige sendinger til SAMME kalde mottaker fra FIRE rom (en konto i hvert) gir ÉN sending", async () => {
    const n = chain.phone();
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => { const [who, acct] = rooms[i % 4]!; return chain.act("send", sendP({ recipient: n, account_ref: acct }), chain.key("cr"), who); }));
    expect(sends()).toBe(1);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it("8 samtidige start_call til samme nummer fra FIRE rom gir ÉN samtale", async () => {
    const n = chain.phone();
    const p = (acct: string): Record<string, JsonValue> => ({ channel: "phone", account_ref: acct, recipient: n, purpose: "transactional", purpose_basis: "recipient_requested_contact", text: "Hei, jeg ringer om timen." });
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => { const [who, acct] = rooms[i % 4]!; return chain.act("start_call", p(acct), chain.key("cc"), who); }));
    expect(chain.twilio.calls.filter((c) => c.op === "call")).toHaveLength(1);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it("blandet last: 10 mottakere x 4 rom x 2 forsøk (80 samtidige) gir NØYAKTIG 10 sendinger, ingen feil/dødlås, og pool er tom etterpå", async () => {
    const ns = Array.from({ length: 10 }, () => chain.phone());
    const t0 = Date.now();
    const rs = await Promise.all(ns.flatMap((n) => rooms.flatMap(([who, acct]) => [0, 1].map(() => chain.act("send", sendP({ recipient: n, account_ref: acct }), chain.key("mx"), who)))));
    const ms = Date.now() - t0;
    expect(rs.filter((r) => r.ok)).toHaveLength(10);
    expect(sends()).toBe(10);
    const reasons = rs.filter((r) => !r.ok).map((r) => (r.status === "denied" ? r.denial_codes.join(",") : r.reason));
    console.log("INFO blandet last: avslagsårsaker", JSON.stringify([...new Set(reasons)]));
    for (const reason of reasons) expect(reason).toMatch(/rate_limit_cold_recipient_day|comms_policy_denied|idempotency/);
    expect(ms).toBeLessThan(60_000);
    const pool = chain.db.app;
    expect(pool.totalCount - pool.idleCount).toBe(0);
  }, 120_000);

  it("kontotaket er fortsatt per konto og blir ikke tenant-bredt: samme konto i 12 samtidige forsøk mot ulike mottakere sendes alle (tak 1000)", async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, () => chain.act("send", sendP(), chain.key("ac"))));
    expect(rs.filter((r) => r.ok)).toHaveLength(12);
  });

  it("gjenspilling på tvers av rom: samme nøkkel + samme handling + samme nyttelast, men fra et ANNET rom (konto kun autorisert i `business`) sender ikke og gir aldri dedup uten effekt", async () => {
    const k = chain.key("rr2");
    const n = chain.phone();
    const first = await chain.act("send", sendP({ recipient: n }), k);
    expect(first.ok).toBe(true);
    const before = sends();
    const other = await chain.act("send", sendP({ recipient: n }), k, projectOwner);
    expect(sends()).toBe(before);
    expect(other.ok && other.deduplicated, JSON.stringify(other).slice(0, 160)).not.toBe(true);
  });
});

describe("A-N3: leverandør-id bevares ved ukjent utfall (nye nøkkelskopede oppslag)", () => {
  it("settle-feil etter akseptert sending: journal outcome_unknown MED provider_message_id; ledger unverified; ny nøkkel sender ikke", async () => {
    const orig = chain.store.settleAttempt.bind(chain.store);
    let armed = true;
    (chain.store as unknown as { settleAttempt: unknown }).settleAttempt = async (...args: Parameters<typeof orig>) => {
      if (armed && args[3].status === "sent") { armed = false; throw new Error("db_hiccup_simulated"); }
      return orig(...args);
    };
    try {
      const k = chain.key("n3");
      const n = chain.phone();
      const r = await chain.act("send", sendP({ recipient: n }), k);
      const sk = scopedIdempotencyKey(TENANT_A, "send", k);
      const ledger = (await chain.db.admin.query("SELECT status FROM tool_executions WHERE idempotency_key = $1", [sk])).rows[0] as { status: string };
      const journal = (await chain.db.admin.query("SELECT status, provider_message_id FROM comms_outbound_log WHERE request_id = $1", [sk])).rows[0] as { status: string; provider_message_id: string | null };
      expect(r.ok).toBe(false);
      expect(ledger.status).toBe("unverified");
      expect(journal.status).toBe("outcome_unknown");
      expect(journal.provider_message_id).not.toBeNull();
      expect((await chain.act("send", sendP({ recipient: n }), chain.key("n3b"))).ok).toBe(false);
      expect(sends()).toBe(1);
    } finally { (chain.store as unknown as { settleAttempt: unknown }).settleAttempt = orig; }
  });

  it("4 samtidige til samme kalde mottaker: de avslåtte får ledger `failed` (skopet nøkkel)", async () => {
    const n = chain.phone();
    const keys = Array.from({ length: 4 }, () => chain.key("lg"));
    const rs = await Promise.all(keys.map((k) => chain.act("send", sendP({ recipient: n }), k)));
    expect(sends()).toBe(1);
    const st = (await chain.db.admin.query("SELECT idempotency_key, status FROM tool_executions WHERE idempotency_key = ANY($1)", [keys.map((k) => scopedIdempotencyKey(TENANT_A, "send", k))])).rows as Array<{ idempotency_key: string; status: string }>;
    const byKey = new Map(st.map((r) => [r.idempotency_key, r.status]));
    for (const [i, k] of keys.entries()) if (!rs[i]!.ok) expect(byKey.get(scopedIdempotencyKey(TENANT_A, "send", k))).toBe("failed");
  });
});

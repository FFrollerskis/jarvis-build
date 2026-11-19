import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BusinessService } from "@jarvis/business";
import { ConversationGraphService } from "@jarvis/conversation-graph";
import { CommsStore, REPLY_SWEEP_MAX_PER_CHANNEL, REPLY_SWEEP_MAX_PER_RUN, REPLY_SWEEP_MAX_UNKNOWN_PER_RUN, ReplySweep, planReplyFollowUps, recipientHash, recipientHint, type JournalEntryInput, type PendingReply } from "../src/index.ts";
import { OWNER, TENANT_A, TENANT_B, startCommsDb, type CommsDb } from "./support/harness.ts";

/**
 * WP-G1 (P3i): ubesvarte meldinger -> åpne oppfølginger. Ren beslutning (`planReplyFollowUps`) og sveipet mot ekte Postgres: kun verifiserte `message`-hendelser, den ELDSTE per avsender, ingen svar fra oss etter hendelsen,
 * fast tittel uten meldingstekst, idempotent (aldri to oppfølginger), terminalt når eieren har lukket den, tenant-isolert. Selve pushen til Telegram er V2-pushen (WP-C4) og testes der.
 */
let db: CommsDb;
let store: CommsStore;
let business: BusinessService;
let graph: ConversationGraphService;
let sweep: ReplySweep;
let now = new Date("2026-11-10T08:00:00Z");
const clock = () => now;
const hoursLater = (h: number) => new Date(new Date("2026-11-10T08:00:00Z").getTime() + h * 3_600_000);
let n = 0;
const sender = (): string => `+4790${String(200000 + ++n).padStart(6, "0").slice(-6)}`;

beforeAll(async () => {
  db = await startCommsDb("g1rs");
  store = new CommsStore(db.app, clock);
  business = new BusinessService(db.app);
  graph = new ConversationGraphService(db.app);
  sweep = new ReplySweep({ pool: db.app, clock, business, afterHours: 24, windowDays: 7 });
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

const inbound = async (tenant: string, from: string, over: { kind?: "message" | "opt_out" | "status"; text?: string; at?: Date; identity?: string | null; channel?: "sms" | "whatsapp" } = {}): Promise<string> => {
  if (over.at) now = over.at;
  const r = await store.recordInbound(tenant, "business", {
    provider: over.channel === "whatsapp" ? "meta" : "twilio", channel: over.channel ?? "sms", account_ref: "+4791000000", event_key: `evt-${++n}-${Math.random().toString(36).slice(2, 8)}`, kind: over.kind ?? "message", sender_hash: recipientHash(tenant, over.channel ?? "sms", from),
    sender_hint: recipientHint(over.channel ?? "sms", from), identity_id: over.identity ?? null, thread_ref: null, content_excerpt: over.text ?? "Hei, kan dere ringe meg?", content_sha256: null, provider_ts: null, ingest_id: `ingest-${n}-abcdefgh`
  }, 30);
  return r.event_id as string;
};
const reply = async (tenant: string, to: string, status: "sent" | "outcome_unknown" | "denied", at: Date): Promise<void> => {
  now = at;
  const entry: JournalEntryInput = {
    request_id: `req-${++n}-${Math.random().toString(36).slice(2, 8)}`, kind: "message", channel: "sms", account_ref: "+4791000000", provider: "twilio", recipient_hash: recipientHash(tenant, "sms", to), recipient_hint: recipientHint("sms", to),
    purpose: "transactional", rule_evaluation: [], denial_codes: status === "denied" ? ["quiet_hours"] : [], recipient_proof: { method: "inbound_thread", identity_id: null, confidence: null, last_inbound_age_minutes: 5 },
    content_sha256: null, content_length: 10, ai_disclosure_applied: true, source: "tool"
  };
  const actor = { person_id: OWNER, session_id: "sess-g1-rs" };
  if (status === "denied") { await store.recordDenied(tenant, "business", entry, actor, 30); return; }
  const begin = await store.beginAttempt(tenant, "business", entry, actor, 30, { recipient: null, account: { limit: 1_000_000, code: "rate_limit_account_hour" } });
  if (begin.kind !== "started") throw new Error("forventet started");
  await store.settleAttempt(tenant, "business", begin.log_id, { status });
};
const followups = async (tenant: string) => (await db.admin.query(`SELECT followup_id, title, reason, due_at, status, idempotency_key FROM business_followups WHERE tenant_id = $1 AND idempotency_key LIKE 'reply-pending:%' ORDER BY due_at`, [tenant])).rows as
  Array<{ followup_id: string; title: string; reason: string; due_at: Date; status: string; idempotency_key: string }>;

describe("A: ren beslutning", () => {
  const row = (id: string, hoursAgo: number, over: Partial<PendingReply> = {}): PendingReply => ({ event_id: id, channel: "sms", account_ref: "+4791000000", sender_hint: "+47•••••123", received_at: new Date(Date.parse("2026-11-10T08:00:00Z") - hoursAgo * 3_600_000).toISOString(), ...over });
  const NOW = new Date("2026-11-10T08:00:00Z");

  it("kun meldinger eldre enn terskelen, eldst først, høyst maxPerRun, ingen duplikater; fast tittel uten innhold; frist = mottatt + terskel", () => {
    const plans = planReplyFollowUps([row("evt-b", 30), row("evt-a", 50), row("evt-new", 2), row("evt-a", 50), row("evt-c", 26, { channel: "whatsapp", sender_hint: null })], { now: NOW, afterHours: 24 });
    expect(plans.map((p) => p.event_id)).toEqual(["evt-a", "evt-b", "evt-c"]);
    expect(plans[0]).toEqual({
      idempotency_key: "reply-pending:evt-a", title: "Svar på melding (SMS) fra +47•••••123", reason: "Ubesvart innkommende melding (verifisert avsender, ingen svar fra oss)",
      due_at: new Date(NOW.getTime() - 26 * 3_600_000).toISOString(), event_id: "evt-a"
    });
    expect(plans[2]?.title).toBe("Svar på melding (WhatsApp) fra ukjent avsender");
    expect(planReplyFollowUps(Array.from({ length: 30 }, (_, i) => row(`evt-${i}`, 30 + i)), { now: NOW, afterHours: 24, maxPerRun: 3 })).toHaveLength(3);
    expect(planReplyFollowUps([row("evt-x", 30, { received_at: "ugyldig dato" })], { now: NOW, afterHours: 24 })).toEqual([]);
    expect(planReplyFollowUps([], { now: NOW, afterHours: 24 })).toEqual([]);
  });
});

describe("A2: rettferdig utvelgelse (B-M2): tak per kanal og for ukjente, kjente først", () => {
  const NOW = new Date("2026-11-10T08:00:00Z");
  const row = (id: string, hoursAgo: number, over: Partial<PendingReply> = {}): PendingReply => ({ event_id: id, channel: "sms", account_ref: "+4791000000", sender_hint: "+47•••••123", received_at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(), identity_id: "id-known", ...over });
  const many = (prefix: string, count: number, over: Partial<PendingReply> = {}) => Array.from({ length: count }, (_, i) => row(`${prefix}-${i}`, 30 + i, over));

  it("én kanal kan ikke ta hele kapasiteten (tak per kanal), og to kanaler fyller opp til taket per sveip", () => {
    expect(planReplyFollowUps(many("sms", 30), { now: NOW, afterHours: 24 })).toHaveLength(REPLY_SWEEP_MAX_PER_CHANNEL);
    const both = planReplyFollowUps([...many("sms", 30), ...many("wa", 30, { channel: "whatsapp" })], { now: NOW, afterHours: 24 });
    expect(both).toHaveLength(REPLY_SWEEP_MAX_PER_RUN);
    expect(both.filter((p) => p.title.includes("(SMS)"))).toHaveLength(REPLY_SWEEP_MAX_PER_CHANNEL);
    expect(both.filter((p) => p.title.includes("(WhatsApp)"))).toHaveLength(REPLY_SWEEP_MAX_PER_CHANNEL);
  });

  it("kjente først: er kapasiteten knapp, tar kjente avsendere plassene foran ukjente selv om de ukjente har ventet lenger", () => {
    const known = [...many("ks", 12, { channel: "sms" }), ...many("kw", 12, { channel: "whatsapp" })];
    const unknown = Array.from({ length: 8 }, (_, i) => row(`u-${i}`, 100 + i, { channel: "slack", identity_id: null }));
    const plans = planReplyFollowUps([...unknown, ...known], { now: NOW, afterHours: 24 });
    expect(plans).toHaveLength(REPLY_SWEEP_MAX_PER_RUN);
    expect(plans.filter((p) => p.event_id.startsWith("u-"))).toHaveLength(0); // alle 20 plasser gikk til kjente (10 per kanal)
    expect(plans.filter((p) => !p.event_id.startsWith("u-"))).toHaveLength(20);
  });

  it("en flom fra UKJENTE avsendere tar høyst et fast antall, og kjente avsendere går alltid foran selv om de er nyere", () => {
    const flood = many("spam", 40, { identity_id: null, channel: "whatsapp" });
    const known = [row("known-new", 25, { channel: "sms" }), row("known-old", 60, { channel: "sms" })];
    const plans = planReplyFollowUps([...flood, ...known], { now: NOW, afterHours: 24 });
    const ids = plans.map((p) => p.event_id);
    expect(ids).toContain("known-new");
    expect(ids).toContain("known-old");
    expect(ids.filter((i) => i.startsWith("spam-"))).toHaveLength(REPLY_SWEEP_MAX_UNKNOWN_PER_RUN);
    expect(plans).toHaveLength(REPLY_SWEEP_MAX_UNKNOWN_PER_RUN + 2);
    // utdata er eldst først
    expect(plans.map((p) => p.due_at)).toEqual([...plans.map((p) => p.due_at)].sort());
    // en rad uten identity_id-felt regnes som ukjent
    const bare: PendingReply = { event_id: "x", channel: "sms", account_ref: "a", sender_hint: null, received_at: new Date(NOW.getTime() - 30 * 3_600_000).toISOString() };
    expect(planReplyFollowUps(Array.from({ length: 12 }, (_, i) => ({ ...bare, event_id: `x${i}` })), { now: NOW, afterHours: 24 })).toHaveLength(REPLY_SWEEP_MAX_UNKNOWN_PER_RUN);
  });
});

describe("B: sveipet mot ekte Postgres (RLS)", () => {
  it("én oppfølging per avsender (den eldste ubesvarte), først etter terskelen, uten meldingstekst, og idempotent ved ny kjøring", async () => {
    const a = sender();
    const first = await inbound(TENANT_A, a, { at: hoursLater(0), text: "HEMMELIG-INNHOLD-123" });
    await inbound(TENANT_A, a, { at: hoursLater(1), text: "Hallo? HEMMELIG-INNHOLD-456" });
    now = hoursLater(2);
    expect(await sweep.run(TENANT_A, "business", OWNER)).toMatchObject({ pending: expect.any(Number), planned: 0, ensured: 0 });
    now = hoursLater(26);
    const r = await sweep.run(TENANT_A, "business", OWNER);
    expect(r.failed).toBe(0);
    const mine = (await followups(TENANT_A)).filter((f) => f.idempotency_key === `reply-pending:${first}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: expect.stringMatching(/^Svar på melding \(SMS\) fra \+47/), status: "open" });
    expect(mine[0]?.due_at.toISOString()).toBe(hoursLater(24).toISOString());
    expect(JSON.stringify(await followups(TENANT_A))).not.toContain("HEMMELIG");
    const before = (await followups(TENANT_A)).length;
    await sweep.run(TENANT_A, "business", OWNER);
    expect((await followups(TENANT_A)).length).toBe(before);
  });

  it("besvarte avsendere gir ingen oppfølging (sendt, ukjent utfall og under sending teller som svar); et AVSLÅTT forsøk og et svar FØR meldingen gjør ikke det; kun `message`-hendelser", async () => {
    const [sent, unknown, denied, earlier, optOut, status] = [sender(), sender(), sender(), sender(), sender(), sender()];
    await reply(TENANT_A, earlier, "sent", hoursLater(100)); // svar FØR den innkommende meldingen under
    const ids = {
      sent: await inbound(TENANT_A, sent, { at: hoursLater(101) }), unknown: await inbound(TENANT_A, unknown, { at: hoursLater(101) }), denied: await inbound(TENANT_A, denied, { at: hoursLater(101) }),
      earlier: await inbound(TENANT_A, earlier, { at: hoursLater(101) }), optOut: await inbound(TENANT_A, optOut, { at: hoursLater(101), kind: "opt_out", text: "STOP" }), status: await inbound(TENANT_A, status, { at: hoursLater(101), kind: "status" })
    };
    await reply(TENANT_A, sent, "sent", hoursLater(102));
    await reply(TENANT_A, unknown, "outcome_unknown", hoursLater(102));
    await reply(TENANT_A, denied, "denied", hoursLater(102));
    now = hoursLater(130);
    await sweep.run(TENANT_A, "business", OWNER);
    const keys = (await followups(TENANT_A)).map((f) => f.idempotency_key);
    expect(keys).toContain(`reply-pending:${ids.denied}`);
    expect(keys).toContain(`reply-pending:${ids.earlier}`);
    for (const id of [ids.sent, ids.unknown, ids.optOut, ids.status]) expect(keys, id).not.toContain(`reply-pending:${id}`);
  });

  it("vinduet: meldinger eldre enn reply_window_days (7 d) tas ikke med; og en lukket oppfølging åpnes aldri på nytt og dupliseres ikke", async () => {
    const old = sender();
    const oldId = await inbound(TENANT_A, old, { at: hoursLater(200) });
    const fresh = sender();
    const freshId = await inbound(TENANT_A, fresh, { at: hoursLater(300) });
    now = hoursLater(200 + 8 * 24); // «old» er da 8 døgn gammel (utenfor vinduet på 7 døgn), «fresh» er 92 timer gammel (innenfor vinduet, eldre enn terskelen på 24 t)
    await sweep.run(TENANT_A, "business", OWNER);
    const keys = (await followups(TENANT_A)).map((f) => f.idempotency_key);
    expect(keys).not.toContain(`reply-pending:${oldId}`);
    expect(keys).toContain(`reply-pending:${freshId}`);
    const mine = (await followups(TENANT_A)).find((f) => f.idempotency_key === `reply-pending:${freshId}`)!;
    await business.completeFollowup(TENANT_A, "business", mine.followup_id);
    await sweep.run(TENANT_A, "business", OWNER);
    const again = (await followups(TENANT_A)).filter((f) => f.idempotency_key === `reply-pending:${freshId}`);
    expect(again).toHaveLength(1);
    expect(again[0]?.status).toBe("completed");
  });

  it("tenant-isolasjon: en annen tenants meldinger sveipes ikke for denne, og oppfølgingen havner kun i den tenanten sveipet kjørte for", async () => {
    const b = sender();
    const idB = await inbound(TENANT_B, b, { at: hoursLater(400) });
    now = hoursLater(430);
    const beforeA = (await followups(TENANT_A)).length;
    await sweep.run(TENANT_A, "business", OWNER);
    expect((await followups(TENANT_B)).map((f) => f.idempotency_key)).not.toContain(`reply-pending:${idB}`);
    expect((await followups(TENANT_A)).map((f) => f.idempotency_key)).not.toContain(`reply-pending:${idB}`);
    expect((await followups(TENANT_A)).length).toBe(beforeA);
  });
});

describe("C: rotasjon uten sult (B-M2) mot ekte Postgres", () => {
  const knownSender = async (tenant: string): Promise<{ number: string; identity: string }> => {
    const number = sender();
    const link = await graph.linkChannelIdentity(tenant, "business", { channel: "sms", channel_identifier: number, confidence: 1, match_method: "exact_phone_e164" });
    return { number, identity: link.identity_id };
  };

  it("26 ubesvarte kjente avsendere: hvert sveip tar de NESTE i køen (aldri de samme eldste igjen), også etter at eieren har lukket de forrige - til alle 26 har nøyaktig én oppfølging", async () => {
    const t0 = hoursLater(1000);
    const senders = [];
    for (let i = 0; i < 26; i += 1) {
      const s = await knownSender(TENANT_B);
      senders.push({ ...s, id: await inbound(TENANT_B, s.number, { at: new Date(t0.getTime() + i * 60_000), identity: s.identity }) });
    }
    now = new Date(t0.getTime() + 48 * 3_600_000);
    const mine = (ids: string[]) => ids.map((id) => `reply-pending:${id}`);
    const allKeys = mine(senders.map((s) => s.id));
    const seen = new Set<string>();
    const runs: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      const r = await sweep.run(TENANT_B, "business", OWNER);
      runs.push(r.ensured);
      const open = (await followups(TENANT_B)).filter((f) => allKeys.includes(f.idempotency_key) && f.status === "open");
      for (const f of open) {
        expect(seen.has(f.idempotency_key), `${f.idempotency_key} fikk oppfølging to ganger`).toBe(false);
        seen.add(f.idempotency_key);
        await business.completeFollowup(TENANT_B, "business", f.followup_id); // eieren lukker den (terminalt)
      }
    }
    expect(runs).toEqual([REPLY_SWEEP_MAX_PER_CHANNEL, REPLY_SWEEP_MAX_PER_CHANNEL, 6, 0, 0, 0]);
    expect(seen.size).toBe(26);
    expect([...seen].sort()).toEqual([...allKeys].sort());
    expect((await followups(TENANT_B)).filter((f) => allKeys.includes(f.idempotency_key))).toHaveLength(26);
  });

  it("en flom av ukjente SMS-avsendere sulter ikke de kjente: kjente får oppfølging i første sveip, ukjente kun opp til taket (resten tas i senere sveip)", async () => {
    const t0 = hoursLater(2000);
    const known = [];
    for (let i = 0; i < 3; i += 1) {
      const s = await knownSender(TENANT_A);
      known.push(await inbound(TENANT_A, s.number, { at: new Date(t0.getTime() + 60 * 60_000 + i * 60_000), identity: s.identity, channel: "sms" })); // NYERE enn spamen
    }
    const spam = [];
    for (let i = 0; i < 20; i += 1) spam.push(await inbound(TENANT_A, sender(), { at: new Date(t0.getTime() + i * 60_000), channel: "whatsapp" }));
    now = new Date(t0.getTime() + 60 * 3_600_000);
    const r = await sweep.run(TENANT_A, "business", OWNER);
    expect(r.failed).toBe(0);
    const keys = (await followups(TENANT_A)).map((f) => f.idempotency_key);
    for (const id of known) expect(keys, id).toContain(`reply-pending:${id}`);
    expect(spam.filter((id) => keys.includes(`reply-pending:${id}`))).toHaveLength(REPLY_SWEEP_MAX_UNKNOWN_PER_RUN);
    // neste sveip tar de neste ukjente (de som alt har oppfølging utelates)
    const r2 = await sweep.run(TENANT_A, "business", OWNER);
    expect(r2.ensured).toBe(REPLY_SWEEP_MAX_UNKNOWN_PER_RUN);
    const keys2 = (await followups(TENANT_A)).map((f) => f.idempotency_key);
    expect(spam.filter((id) => keys2.includes(`reply-pending:${id}`))).toHaveLength(2 * REPLY_SWEEP_MAX_UNKNOWN_PER_RUN);
  });
});

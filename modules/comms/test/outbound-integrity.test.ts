import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderRejectedError, parseSendParams, recipientHash, requestFingerprint, scopedIdempotencyKey } from "../src/index.ts";
import { TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1 fiks-runde A-M4 + A-M5: etter at leverandøren har AKSEPTERT en sending, er en journal-feil et UKJENT utfall (ikke `failed`), og en idempotensnøkkel er bundet til forespørselen (ikke «ok + deduplicated» på en annen
 * mottaker/tekst/handling). Reviewer-repro (S1/K1/K2): journal-settle-feil ga to leverandørkall til samme kalde mottaker; samme nøkkel til en annen mottaker ga `ok+dedup` uten sending; `delete_message` med nøkkelen til en
 * sending ga `ok+dedup` uten at meldingen ble slettet.
 */
let chain: Chain;
const BASIS = { purpose_basis: "existing_customer_relationship" } as const;
const smsP = (recipient: string, over: Record<string, string> = {}) => ({ channel: "sms", account_ref: "+4791000000", recipient, purpose: "transactional", text: "Hei, timen din er bekreftet.", ...BASIS, ...over });
const slackP = (over: Record<string, string> = {}) => ({ channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", purpose: "transactional", text: "Hei", ...BASIS, ...over });
/** A-N2: ledgeren og journalen ser den SKOPEDE nøkkelen (handling + tenant-merke + brukerens nøkkel). */
const sk = (action: string, k: string) => scopedIdempotencyKey(TENANT_A, action, k);
const ledgerStatus = async (k: string, action = "send") => ((await chain.db.admin.query("SELECT status FROM tool_executions WHERE idempotency_key = $1", [sk(action, k)])).rows[0] as { status: string } | undefined)?.status;
const journalStatus = async (k: string, action = "send") => ((await chain.db.admin.query("SELECT status FROM comms_outbound_log WHERE request_id = $1 AND status <> 'denied'", [sk(action, k)])).rows[0] as { status: string } | undefined)?.status;
const sends = () => chain.twilio.calls.filter((c) => c.op === "send");

beforeAll(async () => {
  chain = await startChain("g1oi");
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"], ["phone", "+4791000000", "twilio"], ["slack", "T0AAAAAAAA", "slack"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("A-M4: feil ETTER at leverandøren har akseptert er ukjent utfall - aldri `failed`", () => {
  const withSettleFailure = async (failAll: boolean, body: () => Promise<void>) => {
    const store = chain.store as unknown as { settleAttempt: (...a: Parameters<typeof chain.store.settleAttempt>) => Promise<void> };
    const orig = chain.store.settleAttempt.bind(chain.store);
    let armed = true;
    store.settleAttempt = async (...args) => {
      if (failAll || (armed && args[3].status === "sent")) { armed = false; throw new Error("db_hiccup_simulated"); }
      return orig(...args);
    };
    try { await body(); } finally { store.settleAttempt = orig; }
  };

  it("journal-settle feiler etter akseptert sending: ledger `unverified`, journal `outcome_unknown` (ikke `failed`), eieren varsles om ukjent utfall - og en NY nøkkel til samme kalde mottaker sender ikke på nytt", async () => {
    chain.twilio.calls.length = 0;
    chain.notifications.length = 0;
    await withSettleFailure(false, async () => {
      const k = chain.key("s1");
      const recipient = chain.phone();
      const first = await chain.act("send", smsP(recipient), k);
      expect(first.ok).toBe(false);
      expect(JSON.stringify(first)).toContain("outcome_unknown");
      expect(await ledgerStatus(k)).toBe("unverified");
      expect(await journalStatus(k)).toBe("outcome_unknown");
      // A-N3: leverandøren AKSEPTERTE sendingen, så id-en lagres også ved ukjent utfall (ellers kan den ikke avstemmes mot leverandøren)
      const stored = (await chain.db.admin.query("SELECT provider_message_id FROM comms_outbound_log WHERE request_id = $1 AND status <> 'denied'", [sk("send", k)])).rows[0] as { provider_message_id: string | null };
      expect(stored.provider_message_id).toMatch(/^msg-\d+$/);
      expect(chain.notifications.some((n) => n.action === "send" && n.outcome !== "executed")).toBe(true);
      // gjenspilling med samme nøkkel sender ALDRI en gang til (ledger unverified blokkerer)
      const replay = await chain.act("send", smsP(recipient), k);
      expect(replay.ok).toBe(false);
      // en NY nøkkel til samme kalde mottaker: taket (`outcome_unknown` teller) stopper den
      const again = await chain.act("send", smsP(recipient), chain.key("s1b"));
      expect(again).toMatchObject({ ok: false, status: "denied" });
      expect(again.ok === false && again.status === "denied" ? again.denial_codes : []).toContain("rate_limit_cold_recipient_day");
    });
    expect(sends()).toHaveLength(1);
  });

  it("selv når OGSÅ det andre journalsteget feiler (database nede) blir raden stående åpen (`requested` teller i taket) og ingen ny sending skjer", async () => {
    chain.twilio.calls.length = 0;
    await withSettleFailure(true, async () => {
      const k = chain.key("s2");
      const recipient = chain.phone();
      const first = await chain.act("send", smsP(recipient), k);
      expect(first.ok).toBe(false);
      expect(await ledgerStatus(k)).toBe("unverified");
      expect(await journalStatus(k)).toBe("requested");
      const again = await chain.act("send", smsP(recipient), chain.key("s2b"));
      expect(again).toMatchObject({ ok: false, status: "denied" });
    });
    expect(sends()).toHaveLength(1);
  });

  it("kontroll: en entydig leverandøravvisning (FØR akseptering) er fortsatt en vanlig `failed` - id-en er brent, men plassen i taket frigjøres", async () => {
    chain.twilio.calls.length = 0;
    const saved = chain.twilio.send;
    const recipient = chain.phone();
    const k = chain.key("s3");
    chain.twilio.send = async () => { throw new ProviderRejectedError("twilio", "21211"); };
    try {
      expect((await chain.act("send", smsP(recipient), k)).ok).toBe(false);
    } finally {
      chain.twilio.send = saved;
    }
    expect(await journalStatus(k)).toBe("failed");
    expect(await ledgerStatus(k)).toBe("failed");
    expect((await chain.act("send", smsP(recipient), chain.key("s3b"))).ok).toBe(true);
  });
});

describe("A-M5: idempotensnøkkelen er bundet til forespørselen", () => {
  it("samme nøkkel + samme forespørsel = ekte gjenspilling (`ok + deduplicated`, ett kall); samme nøkkel + ANNEN mottaker/tekst/grunnlag = `idempotency_key_collision` uten sending", async () => {
    chain.twilio.calls.length = 0;
    const k = chain.key("same");
    const r1 = chain.phone();
    const a = await chain.act("send", smsP(r1, { text: "Første" }), k);
    expect(a.ok).toBe(true);
    const replay = await chain.act("send", smsP(r1, { text: "Første" }), k);
    expect(replay).toMatchObject({ ok: true, deduplicated: true });
    for (const variant of [smsP(chain.phone(), { text: "Første" }), smsP(r1, { text: "Helt annen melding" }), { ...smsP(r1, { text: "Første" }), purpose_basis: "order_or_agreement_followup" }]) {
      const b = await chain.act("send", variant, k);
      expect(b, JSON.stringify(variant)).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_collision" });
    }
    expect(sends()).toHaveLength(1);
  });

  it("samme nøkkel til en ANNEN handling er en uavhengig forespørsel (A-N2): `delete_message` og `start_call` med nøkkelen til en sending UTFØRES på ekte (aldri `ok + deduplicated` uten effekt); samme handling med annen forespørsel er fortsatt kollisjon", async () => {
    chain.slack.calls.length = 0;
    const k = chain.key("kdel");
    const sent = await chain.act("send", slackP({ recipient: "C0DDDDDDDD" }), k);
    expect(sent.ok).toBe(true);
    const origDelete = chain.slack.delete!.bind(chain.slack);
    const origExists = chain.slack.messageExists!.bind(chain.slack);
    let gone = false;
    chain.slack.delete = async (req, cred) => { await origDelete(req, cred); gone = true; };
    chain.slack.messageExists = async (req, cred) => (gone ? false : origExists(req, cred));
    try {
      const del = await chain.act("delete_message", { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0DDDDDDDD", target_message_id: sent.ok ? String(sent.external_id) : "x" }, k);
      expect(del, JSON.stringify(del)).toMatchObject({ ok: true, deduplicated: false });
      expect(chain.slack.calls.filter((c) => c.op === "delete")).toHaveLength(1); // meldingen ble faktisk slettet
    } finally {
      chain.slack.delete = origDelete;
      chain.slack.messageExists = origExists;
    }
    chain.twilio.calls.length = 0;
    const call = await chain.act("start_call", { channel: "phone", account_ref: "+4791000000", recipient: chain.phone(), purpose: "transactional", text: "Hei, jeg ringer om timen.", ...BASIS }, k);
    expect(call, JSON.stringify(call)).toMatchObject({ ok: true, deduplicated: false });
    expect(chain.twilio.calls.filter((c) => c.op === "call")).toHaveLength(1);
    // ... mens SAMME handling med en ANNEN forespørsel på samme nøkkel fortsatt er en kollisjon (A-M5)
    const again = await chain.act("send", slackP({ recipient: "C0DDDDDDDD", text: "Noe helt annet" }), k);
    expect(again).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_collision" });
    expect(await ledgerStatus(k, "delete_message")).toBe("succeeded");
    expect(await ledgerStatus(k, "start_call")).toBe("succeeded");
  });

  it("et AVSLÅTT forsøk brenner ikke nøkkelen: samme nøkkel med rettede parametre (grunnlag oppgitt) sendes normalt, og er ingen kollisjon", async () => {
    chain.twilio.calls.length = 0;
    const k = chain.key("den");
    const recipient = chain.phone();
    const { purpose_basis: _omit, ...noBasis } = smsP(recipient);
    void _omit;
    const denied = await chain.act("send", noBasis, k);
    expect(denied).toMatchObject({ ok: false, status: "denied" });
    const fixed = await chain.act("send", smsP(recipient), k);
    expect(fixed.ok).toBe(true);
    expect(sends()).toHaveLength(1);
  });

  it("journal-nivå (forsvar i dybden): funnel.execute med samme request_id men ANNEN mottaker kaster `idempotency_key_collision` (aldri dedup), og samme forespørsel en gang til gir dedup", async () => {
    chain.twilio.calls.length = 0;
    const mk = (recipient: string, id: string) => { const r = parseSendParams({ request_id: id, channel: "sms", account_ref: "+4791000000", recipient, purpose: "transactional", text: "Hei, timen din er bekreftet.", ...BASIS }); if (!r.ok) throw new Error(r.code); return r.value; };
    const id = chain.key("jl");
    const r1 = chain.phone();
    const first = await chain.funnel.execute(chain.ctx, mk(r1, id), "fake-token-for-test");
    expect(first.data["status"]).toBe("sent");
    const dedup = await chain.funnel.execute(chain.ctx, mk(r1, id), "fake-token-for-test");
    expect(dedup.data["deduplicated"]).toBe(true);
    await expect(chain.funnel.execute(chain.ctx, mk(chain.phone(), id), "fake-token-for-test")).rejects.toThrow("idempotency_key_collision");
    expect(sends()).toHaveLength(1);
  });

  it("fingeravtrykket skiller alt eieren kan sette, og er likt for samme forespørsel uavhengig av id", () => {
    const base = { request_id: "req-fp-0001", channel: "sms", account_ref: "+4791000000", recipient: "+4790000001", purpose: "transactional", text: "Hei" };
    const fp = (over: Record<string, unknown>) => { const r = parseSendParams({ ...base, ...over }); if (!r.ok) throw new Error(r.code); return requestFingerprint(r.value.request); };
    expect(fp({})).toBe(fp({ request_id: "req-fp-9999" }));
    for (const over of [{ recipient: "+4790000002" }, { text: "Hei!" }, { purpose: "agreed" }, { account_ref: "+4792000000" }, { purpose_basis: "recipient_requested_contact" }, { purpose_basis_note: "x" }, { thread_ref: "t1" }]) {
      expect(fp(over), JSON.stringify(over)).not.toBe(fp({}));
    }
    expect(recipientHash(TENANT_A, "sms", "+4790000001")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("A-M6: edit_message har levende preflight/før-tilstand og markedsføringssjekk", () => {
  const beforeState = async (k: string) => ((await chain.db.admin.query("SELECT before_state FROM tool_executions WHERE idempotency_key = $1", [sk("edit_message", k)])).rows[0] as { before_state: Record<string, unknown> | null } | undefined)?.before_state ?? null;
  const editP = (target: string, text: string, recipient = "C0EEEEEEEE") => ({ channel: "slack", account_ref: "T0AAAAAAAA", recipient, target_message_id: target, text });

  it("preflighten leser målet ferskt hos leverandøren FØR redigeringen: ledgerens før-tilstand er ikke tom (policy + `exists`), og en vanlig redigering virker", async () => {
    chain.slack.calls.length = 0;
    const sent = await chain.act("send", slackP({ recipient: "C0EEEEEEEE" }), chain.key("ee1"));
    expect(sent.ok).toBe(true);
    const k = chain.key("ee2");
    const edited = await chain.act("edit_message", editP(sent.ok ? String(sent.external_id) : "x", "Rettet tekst"), k);
    expect(edited.ok).toBe(true);
    expect(await beforeState(k)).toMatchObject({ kind: "edit", allowed: true, exists: true });
    expect(chain.slack.calls.map((c) => c.op)).toEqual(["send", "exists", "edit", "exists"]); // fersk lesing FØR redigeringen og readback ETTER
  });

  it("redigering til reklametekst avslås som ved sending (ingenting redigeres, avslaget journalføres og ligger i før-tilstanden); en rolig tekst til samme melding virker fortsatt", async () => {
    chain.slack.calls.length = 0;
    const sent = await chain.act("send", slackP({ recipient: "C0FFFFFFFF" }), chain.key("em1")); // eget mål: kald mottaker tillater kun én sending per døgn
    expect(sent.ok).toBe(true);
    const target = sent.ok ? String(sent.external_id) : "x";
    const k = chain.key("em2");
    const promo = await chain.act("edit_message", editP(target, "Spesialtilbud: 50% rabatt, kjøp nå! Gratis frakt.", "C0FFFFFFFF"), k);
    expect(promo.ok).toBe(false);
    expect(chain.slack.calls.some((c) => c.op === "edit")).toBe(false);
    expect(await beforeState(k)).toMatchObject({ kind: "edit", allowed: false, denial_codes: expect.arrayContaining(["content_looks_like_marketing"]) });
    const denied = (await chain.db.admin.query("SELECT status, denial_codes FROM comms_outbound_log WHERE request_id = $1", [sk("edit_message", k)])).rows;
    expect(denied).toEqual([{ status: "denied", denial_codes: expect.arrayContaining(["content_looks_like_marketing"]) }]);
    const calm = await chain.act("edit_message", editP(target, "Timen din er flyttet til 14:00.", "C0FFFFFFFF"), chain.key("em3"));
    expect(calm, JSON.stringify(calm)).toMatchObject({ ok: true });
  });
});

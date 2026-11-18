import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMMS_CHANNELS, PURPOSE_BASES, evaluateOutboundPolicy, parseCommsConfig, parseCallParams, parseSendParams, recipientHash, type OutboundPolicyState, type OutboundRequest
} from "../src/index.ts";
import { startChain, authorizeAll, type Chain } from "./support/chain.ts";

/**
 * WP-G1 fiks-runde A-M2 (LEDER-AVGJØRELSE): `purpose` velges av kalleren, så «markedsføring feiler lukket» gjaldt kun ærlig merking - en melding merket `transactional` til en KALD mottaker gikk gjennom hvis den ikke traff
 * nøkkelordene (reviewer-repro: «Vi har nye produkter i butikken våre denne uken, ta en titt» -> ALLOWED; AI-samtale med salgstekst -> CALL PLACED). Nå: første kontakt (kald mottaker) krever eierens erklærte formålsgrunnlag
 * (`purpose_basis`, lukket liste + notat) for ALLE formål og også AI-samtale; manglende grunnlag feiler LUKKET; grunnlaget journalføres; reklameord avslår uansett grunnlag.
 */
const NOON = new Date("2026-11-17T11:00:00Z"); // 12:00 Oslo
const config = parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: COMMS_CHANNELS.join(","), JARVIS_COMMS_CALLS: "on" });
const cold = (over: Partial<OutboundPolicyState> = {}): OutboundPolicyState => ({
  account_authorized: true, recipient_opted_out: false, sends_last_24h_to_recipient: 0, calls_last_24h_to_recipient: 0, sends_last_hour_from_account: 0, last_inbound_at: null,
  recipient_identity: null, target: null, marketing: { prior_consent: false, reservation_register: "unverified" }, ...over
});
const warm = cold({ recipient_identity: { identity_id: "id-1", confidence: 1 } });
const sms = (over: Partial<OutboundRequest> = {}): OutboundRequest => ({
  kind: "message", channel: "sms", account_ref: "+4791000000", recipient: "+4790000000", purpose: "transactional", content: { text: "Hei, timen din er bekreftet." }, ...over
});
const call = (over: Partial<OutboundRequest> = {}): OutboundRequest => ({
  kind: "call", channel: "phone", account_ref: "+4791000000", recipient: "+4790000000", purpose: "transactional", content: { text: "Hei, jeg ringer om timen din." }, ...over
});
const ruleOf = (r: ReturnType<typeof evaluateOutboundPolicy>) => r.rules.find((x) => x.rule === "purpose_basis");

describe("A-M2 (policy): kald mottaker krever formålsgrunnlag for ALLE formål - også samtale", () => {
  it("uten grunnlag: `purpose_basis_required` for transactional, agreed og marketing (melding) og for AI-samtale; fail-closed", () => {
    for (const purpose of ["transactional", "agreed", "marketing"] as const) {
      const r = evaluateOutboundPolicy(sms({ purpose }), cold(), config, NOON);
      expect(r.allowed, purpose).toBe(false);
      expect(r.denial_codes, purpose).toContain("purpose_basis_required");
      expect(ruleOf(r)).toMatchObject({ outcome: "deny", code: "purpose_basis_required" });
    }
    const c = evaluateOutboundPolicy(call(), cold(), config, NOON);
    expect(c.allowed).toBe(false);
    expect(c.denial_codes).toContain("purpose_basis_required");
  });

  it("med grunnlag (hver verdi i den lukkede listen): regelen består med grunnlaget som kode, og grunnlag + notat havner i mottakerbeviset som journalføres", () => {
    for (const basis of PURPOSE_BASES) {
      const r = evaluateOutboundPolicy(sms({ purpose_basis: basis, purpose_basis_note: "Ba om tilbud på telefon 12. nov" }), cold(), config, NOON);
      expect(r.allowed, basis).toBe(true);
      expect(ruleOf(r), basis).toEqual({ rule: "purpose_basis", outcome: "pass", code: basis });
      expect(r.recipient_proof).toMatchObject({ method: "explicit_param", purpose_basis: basis, purpose_basis_note: "Ba om tilbud på telefon 12. nov" });
    }
    expect(evaluateOutboundPolicy(call({ purpose_basis: "recipient_requested_contact" }), cold(), config, NOON).allowed).toBe(true);
  });

  it("kjent mottaker (løst identitet) og pågående samtale (innkommende siste 7 dager) trenger ikke grunnlag, men et oppgitt grunnlag journalføres likevel", () => {
    expect(evaluateOutboundPolicy(sms(), warm, config, NOON).allowed).toBe(true);
    expect(ruleOf(evaluateOutboundPolicy(sms(), warm, config, NOON))).toEqual({ rule: "purpose_basis", outcome: "not_applicable" });
    const thread = cold({ last_inbound_at: new Date(NOON.getTime() - 3_600_000).toISOString() });
    expect(evaluateOutboundPolicy(sms(), thread, config, NOON).allowed).toBe(true);
    expect(ruleOf(evaluateOutboundPolicy(sms({ purpose_basis: "order_or_agreement_followup" }), warm, config, NOON))).toMatchObject({ outcome: "pass", code: "order_or_agreement_followup" });
    // en inbound-tråd eldre enn reply_window_days gjør mottakeren kald igjen
    const stale = cold({ last_inbound_at: new Date(NOON.getTime() - 8 * 86_400_000).toISOString() });
    expect(evaluateOutboundPolicy(sms(), stale, config, NOON).denial_codes).toContain("purpose_basis_required");
  });

  it("reklame avslås UANSETT oppgitt grunnlag (ordene teller, ikke etiketten); redigering/sletting/reaksjon berøres ikke", () => {
    for (const basis of PURPOSE_BASES) {
      const r = evaluateOutboundPolicy(sms({ purpose_basis: basis, content: { text: "Spesialtilbud: 50% rabatt, kjøp nå! Gratis frakt." } }), cold(), config, NOON);
      expect(r.allowed, basis).toBe(false);
      expect(r.denial_codes, basis).toContain("content_looks_like_marketing");
      expect(r.denial_codes, basis).not.toContain("purpose_basis_required");
    }
    const slack = { channel: "slack" as const, account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA" };
    for (const kind of ["edit", "delete", "reaction"] as const) {
      const r = evaluateOutboundPolicy({ kind, ...slack, purpose: "transactional", content: kind === "edit" ? { text: "rettet" } : kind === "reaction" ? { reaction: "thumbsup" } : {}, target_message_id: "1.2" }, cold({ target: { own_sent: true, same_account: true } }), config, NOON);
      expect(ruleOf(r), kind).toEqual({ rule: "purpose_basis", outcome: "not_applicable" });
    }
  });

  it("notatet må være kort, uten kontrolltegn/linjeskift/hemmeligheter; en ukjent verdi finnes ikke i den lukkede listen (skjemaet avviser den FØR policyen)", () => {
    for (const note of ["a".repeat(201), `linje1${"\n"}linje2`, `tab${String.fromCodePoint(0)}x`, "   ", `token ghp_${"d".repeat(30)}`]) {
      const r = evaluateOutboundPolicy(sms({ purpose_basis: "existing_customer_relationship", purpose_basis_note: note }), cold(), config, NOON);
      expect(r.denial_codes, JSON.stringify(note).slice(0, 30)).toContain("purpose_basis_note_invalid");
    }
    const base = { request_id: "req-basis-001", channel: "sms", account_ref: "+4791000000", recipient: "+4790000000", purpose: "transactional", text: "Hei" };
    expect(parseSendParams({ ...base, purpose_basis: "legal_advice_by_jarvis" })).toEqual({ ok: false, code: "invalid_parameters" });
    expect(parseSendParams({ ...base, purpose_basis: "existing_customer_relationship", purpose_basis_note: "x".repeat(201) })).toEqual({ ok: false, code: "invalid_parameters" });
    expect(parseSendParams({ ...base, purpose_basis: "existing_customer_relationship" })).toMatchObject({ ok: true });
    expect(parseCallParams({ request_id: "req-basis-002", channel: "phone", account_ref: "+4791000000", recipient: "+4790000000", purpose: "transactional", text: "Hei", purpose_basis: "x" })).toEqual({ ok: false, code: "invalid_parameters" });
  });
});

describe("A-M2 (full kjede): eierruten avslår uten grunnlag, journalfører grunnlaget, og AI-samtale krever det også", () => {
  let chain: Chain;
  beforeAll(async () => {
    chain = await startChain("g1pb");
    await authorizeAll(chain, [["sms", "+4791000000", "twilio"], ["phone", "+4791000000", "twilio"]]);
  }, 240_000);
  afterAll(async () => { await chain?.stop(); }, 120_000);

  const ad = "Hei! Vi har nye produkter i butikken våre denne uken, ta en titt og hør med oss om det er noe du trenger.";

  it("reviewerens repro: salgstekst merket `transactional` til en kald SMS-mottaker sendes IKKE uten grunnlag (avslag journalføres), og med grunnlag journalføres eierens erklæring", async () => {
    const recipient = chain.phone();
    const base = { channel: "sms", account_ref: "+4791000000", recipient, purpose: "transactional", text: ad } as const;
    const denied = await chain.act("send", { ...base }, chain.key("pb1"));
    expect(denied).toMatchObject({ ok: false, status: "denied" });
    expect(denied.ok === false && denied.status === "denied" ? denied.denial_codes : []).toContain("purpose_basis_required");
    expect(chain.twilio.calls.filter((c) => c.op === "send")).toEqual([]);
    const rows = (await chain.db.admin.query("SELECT status, denial_codes FROM comms_outbound_log WHERE tenant_id = 'tenant-g1-a' AND recipient_hash = $1", [recipientHash("tenant-g1-a", "sms", recipient)])).rows;
    expect(rows).toEqual([{ status: "denied", denial_codes: expect.arrayContaining(["purpose_basis_required"]) }]);
    // med eierens erklærte grunnlag (+ notat): sendes, og grunnlaget ligger i journalen, i ledgerens før-tilstand og i eier-varselet - aldri meldingsteksten
    const idem = chain.key("pb2");
    const ok = await chain.act("send", { ...base, purpose_basis: "existing_customer_relationship", purpose_basis_note: "Kunde siden 2023, kjøpte i butikk" }, idem);
    expect(ok.ok).toBe(true);
    expect(chain.twilio.calls.filter((c) => c.op === "send")).toHaveLength(1);
    const journal = (await chain.db.admin.query("SELECT status, recipient_proof FROM comms_outbound_log WHERE request_id = $1", [idem])).rows[0] as { status: string; recipient_proof: Record<string, unknown> };
    expect(journal.status).toBe("sent");
    expect(journal.recipient_proof).toMatchObject({ method: "explicit_param", purpose_basis: "existing_customer_relationship", purpose_basis_note: "Kunde siden 2023, kjøpte i butikk" });
    const ledger = (await chain.db.admin.query("SELECT before_state FROM tool_executions WHERE idempotency_key = $1", [idem])).rows[0] as { before_state: Record<string, unknown> };
    expect(ledger.before_state).toMatchObject({ allowed: true, purpose_basis: "existing_customer_relationship" });
    expect(JSON.stringify(ledger)).not.toContain("Kunde siden 2023"); // notatet er i journalen, ikke i verktøy-ledgeren
    expect(JSON.stringify(ledger)).not.toContain("nye produkter");
    const note = chain.notifications.find((x) => x.action === "send" && x.summary.includes("existing_customer_relationship"));
    expect(note?.summary).toMatch(/\(formål: transactional, grunnlag: existing_customer_relationship\)/);
  });

  it("AI-samtale til en kald mottaker krever grunnlag (salgstekst som `transactional` ringes ikke); med grunnlag ringes den", async () => {
    const recipient = chain.phone();
    const p = { channel: "phone", account_ref: "+4791000000", recipient, purpose: "transactional", text: "Hei, jeg ringer fra butikken om våre nye produkter denne uken." } as const;
    const denied = await chain.act("start_call", { ...p }, chain.key("pc1"));
    expect(denied).toMatchObject({ ok: false, status: "denied" });
    expect(denied.ok === false && denied.status === "denied" ? denied.denial_codes : []).toContain("purpose_basis_required");
    expect(chain.twilio.calls.filter((c) => c.op === "call")).toEqual([]);
    const placed = await chain.act("start_call", { ...p, purpose_basis: "recipient_requested_contact" }, chain.key("pc2"));
    expect(placed.ok).toBe(true);
    expect(chain.twilio.calls.filter((c) => c.op === "call")).toHaveLength(1);
  });

  it("tørrkjøringen (evaluate_send/preview) viser kravet: eieren ser `purpose_basis_required` FØR noe sendes, og `purpose_basis: null` i oppsummeringen", async () => {
    const recipient = chain.phone();
    const x = parseSendParams({ request_id: "preview-0000001", channel: "sms", account_ref: "+4791000000", recipient, purpose: "transactional", text: "Hei, timen din er bekreftet." });
    if (!x.ok) throw new Error("parse");
    expect(chain.funnel.summarize(await chain.funnel.evaluate(chain.ctx, x.value))).toMatchObject({ allowed: false, denial_codes: ["purpose_basis_required"], purpose_basis: null });
    const y = parseSendParams({ request_id: "preview-0000002", channel: "sms", account_ref: "+4791000000", recipient, purpose: "transactional", text: "Hei, timen din er bekreftet.", purpose_basis: "order_or_agreement_followup" });
    if (!y.ok) throw new Error("parse");
    expect(chain.funnel.summarize(await chain.funnel.evaluate(chain.ctx, y.value))).toMatchObject({ allowed: true, purpose_basis: "order_or_agreement_followup" });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import {
  RELATIONSHIP_LINK_METHODS, RELATIONSHIP_MIN_CONFIDENCE, evaluateOutboundPolicy, isRelationshipEvidence, parseCommsConfig, type OutboundPolicyState, type OutboundRequest
} from "../src/index.ts";
import { TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1 fiks-runde 2, A-M2 DELVIS: `resolveRecipientIdentity` ignorerte confidence og match_method - en `manual`-lenke med confidence 0,05 (og en kontakt eierens kontaktbok har, `contact_sync`) gjorde en kald mottaker «varm» og
 * fjernet `purpose_basis`-kravet. LEDER-AVGJØRELSE: relasjonsbevis = innkommende melding fra identifikatoren siste 7 døgn ELLER en eier-konfigurert/eksakt lenke (exact_* eller owner_configured) med confidence >= 0,9.
 */
const NOON = new Date("2026-11-17T11:00:00Z");
const config = () => parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "sms" });
const smsRequest = (over: Partial<OutboundRequest> = {}): OutboundRequest => ({
  kind: "message", channel: "sms", account_ref: "+4791000000", recipient: "+4790000001", purpose: "transactional", content: { text: "Hei, timen din er bekreftet." }, ...over
});
const state = (over: Partial<OutboundPolicyState> = {}): OutboundPolicyState => ({
  account_authorized: true, recipient_opted_out: false, sends_last_24h_to_recipient: 0, calls_last_24h_to_recipient: 0, sends_last_hour_from_account: 0, last_inbound_at: null,
  recipient_identity: null, target: null, marketing: { prior_consent: false, reservation_register: "unverified" }, ...over
});

describe("isRelationshipEvidence: hva teller som bevis på et forhold", () => {
  it("kun eksakte/eier-konfigurerte metoder med confidence >= 0,9 teller; contact_sync, manual, ukjent metode og lav confidence teller ikke", () => {
    expect([...RELATIONSHIP_LINK_METHODS].sort()).toEqual(["exact_email", "exact_handle", "exact_phone_e164", "owner_configured"]);
    expect(RELATIONSHIP_MIN_CONFIDENCE).toBe(0.9);
    const yes: Array<[string, number]> = [["exact_email", 1], ["exact_phone_e164", 0.9], ["exact_handle", 0.95], ["owner_configured", 0.9], ["owner_configured", 1], ["exact_phone_e164", Math.fround(0.9)]];
    const no: Array<[string, number]> = [
      ["owner_configured", 0.89], ["exact_phone_e164", 0.5], ["exact_email", 0.05], ["manual", 1], ["manual", 0.9], ["manual", 0.05], ["contact_sync", 0.9], ["contact_sync", 1], ["name_match", 1], ["", 1], ["exact_phone_e164", Number.NaN]
    ];
    for (const [match_method, confidence] of yes) expect(isRelationshipEvidence({ match_method, confidence }), `${match_method} ${confidence}`).toBe(true);
    for (const [match_method, confidence] of no) expect(isRelationshipEvidence({ match_method, confidence }), `${match_method} ${confidence}`).toBe(false);
  });
});

describe("policy: en løst identitet er bevis KUN når den teller (ren funksjon)", () => {
  it("manual/lav confidence/contact_sync => `explicit_param` (kald): `purpose_basis` kreves og `agreed` avslås; revisjonssporet viser hvorfor", () => {
    for (const identity of [
      { identity_id: "id-1", confidence: 0.05, match_method: "manual" }, { identity_id: "id-1", confidence: 1, match_method: "manual" },
      { identity_id: "id-1", confidence: 0.9, match_method: "contact_sync" }, { identity_id: "id-1", confidence: 0.5, match_method: "exact_phone_e164" }
    ]) {
      const r = evaluateOutboundPolicy(smsRequest(), state({ recipient_identity: identity }), config(), NOON);
      expect(r.recipient_proof.method, JSON.stringify(identity)).toBe("explicit_param");
      expect(r.denial_codes, JSON.stringify(identity)).toContain("purpose_basis_required");
      expect(r.recipient_proof).toMatchObject({ identity_id: "id-1", identity_match_method: identity.match_method });
      const agreed = evaluateOutboundPolicy(smsRequest({ purpose: "agreed" }), state({ recipient_identity: identity }), config(), NOON);
      expect(agreed.denial_codes, JSON.stringify(identity)).toContain("agreed_requires_relationship_evidence");
    }
  });

  it("eksakt/eier-konfigurert lenke med confidence >= 0,9 => `identity_link` (varm): ingen `purpose_basis`, `agreed` tillatt; en innkommende melding siste 7 døgn er fortsatt nok alene", () => {
    for (const identity of [{ identity_id: "id-1", confidence: 1, match_method: "exact_phone_e164" }, { identity_id: "id-1", confidence: 0.9, match_method: "owner_configured" }]) {
      const r = evaluateOutboundPolicy(smsRequest({ purpose: "agreed" }), state({ recipient_identity: identity }), config(), NOON);
      expect(r.allowed, JSON.stringify(r.denial_codes)).toBe(true);
      expect(r.recipient_proof).toMatchObject({ method: "identity_link", identity_match_method: identity.match_method });
    }
    const inbound = evaluateOutboundPolicy(smsRequest(), state({ last_inbound_at: new Date(NOON.getTime() - 3_600_000).toISOString(), recipient_identity: { identity_id: "id-1", confidence: 0.05, match_method: "manual" } }), config(), NOON);
    expect(inbound.recipient_proof.method).toBe("inbound_thread");
    expect(inbound.allowed).toBe(true);
  });
});

describe("hele kjeden mot ekte Conversation Graph (embedded Postgres)", () => {
  let chain: Chain;
  beforeAll(async () => {
    chain = await startChain("g1re", { JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR: "1000" });
    await authorizeAll(chain, [["sms", "+4791000000", "twilio"]]);
  }, 240_000);
  afterAll(async () => { await chain?.stop(); }, 120_000);

  const params = (recipient: string, over: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({ channel: "sms", account_ref: "+4791000000", recipient, purpose: "transactional", text: "Hei, timen din er bekreftet.", ...over });
  const link = (num: string, match_method: string, confidence: number, extra: Record<string, string> = {}) =>
    chain.graph.linkChannelIdentity(TENANT_A, "business", { channel: "sms", channel_identifier: num, confidence, match_method: match_method as never, ...extra });
  const codes = (r: Awaited<ReturnType<Chain["act"]>>): string[] => (!r.ok && r.status === "denied" ? [...r.denial_codes] : []);

  it("en `manual`-lenke med confidence 0,05 fjerner IKKE grunnlagskravet (reviewerens repro)", async () => {
    const n = chain.phone();
    await link(n, "manual", 0.05);
    const before = chain.twilio.calls.filter((c) => c.op === "send").length;
    const r = await chain.act("send", params(n), chain.key("re1"));
    expect(codes(r)).toContain("purpose_basis_required");
    expect(chain.twilio.calls.filter((c) => c.op === "send").length).toBe(before);
  });

  it("`contact_sync`-lenke (en kontakt i eierens egen kontaktbok, confidence 0,9) og `manual` med confidence 1 gjør heller ikke mottakeren varm; `agreed` avslås", async () => {
    const a = chain.phone();
    const b = chain.phone();
    await link(a, "contact_sync", 0.9, { source_type: "google_contacts", external_id: "people/c1" });
    await link(b, "manual", 1);
    for (const n of [a, b]) {
      expect(codes(await chain.act("send", params(n), chain.key("re2")))).toContain("purpose_basis_required");
      expect(codes(await chain.act("send", params(n, { purpose: "agreed" }), chain.key("re2a")))).toContain("agreed_requires_relationship_evidence");
    }
    // med eierens erklærte grunnlag sendes den som enhver kald mottaker
    const ok = await chain.act("send", params(a, { purpose_basis: "recipient_requested_contact" }), chain.key("re2b"));
    expect(ok.ok).toBe(true);
  });

  it("eksakt telefonlenke (confidence >= 0,9) og eier-konfigurert lenke (>= 0,9) er relasjonsbevis: sendes uten grunnlag, og `agreed` er tillatt; owner_configured 0,5 er det ikke", async () => {
    const exact = chain.phone();
    const owner = chain.phone();
    const weak = chain.phone();
    await link(exact, "exact_phone_e164", 0.95);
    await link(owner, "owner_configured", 0.9);
    await link(weak, "owner_configured", 0.5);
    expect((await chain.act("send", params(exact), chain.key("re3"))).ok).toBe(true);
    expect((await chain.act("send", params(owner, { purpose: "agreed" }), chain.key("re4"))).ok).toBe(true);
    expect(codes(await chain.act("send", params(weak), chain.key("re5")))).toContain("purpose_basis_required");
    const proof = (await chain.db.admin.query("SELECT recipient_proof FROM comms_outbound_log WHERE tenant_id = $1 AND status = 'sent' ORDER BY created_at DESC LIMIT 5", [TENANT_A])).rows.map((r) => (r as { recipient_proof: Record<string, unknown> }).recipient_proof);
    expect(proof.some((p) => p["method"] === "identity_link" && p["identity_match_method"] === "exact_phone_e164")).toBe(true);
  });
});

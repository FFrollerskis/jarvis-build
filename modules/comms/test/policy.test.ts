import { describe, expect, it } from "vitest";
import {
  CHANNEL_PROFILES, COMMS_CHANNELS, DEFAULT_AI_DISCLOSURE_TEXT, evaluateOutboundPolicy, isQuietHour, localHour, looksLikeMarketing, normalizeRecipient, parseCommsConfig, recipientHash, textIsSendable,
  type CommsChannel, type OutboundPolicyState, type OutboundRequest
} from "../src/index.ts";

/** En Discord-snowflake bygget ved kjøring (aldri en bokstavelig ID-lignende streng i kildekoden). */
const SNOWFLAKE = "1".repeat(18);

/**
 * WP-G1 (P1b): den deterministiske utgående policyen, regel for regel. REN funksjon: ingen DB, ingen nettverk, injisert klokke. Hver test navngir regelen den beviser, og de som beviser at noe IKKE kan omgås
 * bruker alle felt en kaller (også en modell) faktisk kan styre - det finnes ingen parameter for AI-opplysning, stille timer, opt-out eller mål-konto.
 */
const NOON = new Date("2026-11-17T11:00:00Z"); // 12:00 Europe/Oslo (CET)
const NIGHT = new Date("2026-11-17T22:30:00Z"); // 23:30 Europe/Oslo
const ALL = COMMS_CHANNELS.join(",");
const config = (extra: Record<string, string> = {}) =>
  parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: ALL, JARVIS_COMMS_MEDIA_URL_HOSTS: "cdn.example.com", JARVIS_COMMS_TEMPLATES_WITH_DISCLOSURE: "ai_hello", ...extra });

const state = (over: Partial<OutboundPolicyState> = {}): OutboundPolicyState => ({
  account_authorized: true, recipient_opted_out: false, sends_last_24h_to_recipient: 0, calls_last_24h_to_recipient: 0, sends_last_hour_from_account: 0, last_inbound_at: null,
  recipient_identity: { identity_id: "id-1", confidence: 1 }, target: null, marketing: { prior_consent: false, reservation_register: "unverified" }, ...over
});

const sms = (over: Partial<OutboundRequest> = {}): OutboundRequest => ({
  kind: "message", channel: "sms", account_ref: "+4791000000", recipient: "+4790000000", purpose: "transactional", content: { text: "Hei, møtet er flyttet til 14:00." }, ...over
});

const codes = (r: ReturnType<typeof evaluateOutboundPolicy>) => [...r.denial_codes].sort();

describe("A: grunnregler - kanal, konto, mottaker", () => {
  it("en gyldig SMS fra en autorisert konto til en kjent mottaker er tillatt, og teksten bærer AI-opplysningen", () => {
    const r = evaluateOutboundPolicy(sms(), state(), config(), NOON);
    expect(r.allowed).toBe(true);
    expect(r.final_text).toBe(`Hei, møtet er flyttet til 14:00.\n\n${DEFAULT_AI_DISCLOSURE_TEXT}`);
    expect(r.disclosure_applied).toBe(true);
    expect(r.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.recipient_proof.method).toBe("identity_link");
  });

  it("kanal som ikke er slått på og konto som ikke er autorisert avslås (begge regler vises)", () => {
    const r = evaluateOutboundPolicy(sms(), state({ account_authorized: false }), config({ JARVIS_COMMS_CHANNELS: "slack" }), NOON);
    expect(codes(r)).toEqual(["account_not_authorized", "channel_not_enabled"]);
  });

  it("mottaker valideres per kanal og kan ikke være ikke-normalisert", () => {
    expect(codes(evaluateOutboundPolicy(sms({ recipient: "900 00 000" }), state(), config(), NOON))).toContain("recipient_not_e164");
    expect(codes(evaluateOutboundPolicy(sms({ recipient: "0047 900 00 000" }), state(), config(), NOON))).toContain("recipient_not_normalized");
    expect(codes(evaluateOutboundPolicy(sms({ channel: "slack", account_ref: "T0AAAAAAAA", recipient: "kari" }), state(), config(), NOON))).toContain("recipient_not_a_slack_id");
    expect(normalizeRecipient("whatsapp", "4790000000")).toEqual({ ok: true, value: "+4790000000" });
    expect(normalizeRecipient("sms", "4790000000").ok).toBe(false);
    expect(normalizeRecipient("discord", SNOWFLAKE).ok).toBe(true);
    expect(normalizeRecipient("teams", "chat:19:abc_def@thread.v2").ok).toBe(true);
    expect(normalizeRecipient("teams", "kari@firma.no").ok).toBe(false);
  });

  it("kanalen støtter handlingen: tekstmelding til `phone`, samtale utenfor `phone`, redigering på SMS avslås", () => {
    expect(codes(evaluateOutboundPolicy(sms({ channel: "phone" }), state(), config(), NOON))).toContain("kind_not_supported_by_channel");
    expect(codes(evaluateOutboundPolicy(sms({ kind: "call" }), state(), config(), NOON))).toContain("kind_not_supported_by_channel");
    expect(codes(evaluateOutboundPolicy(sms({ kind: "edit", target_message_id: "x" }), state({ target: { own_sent: true, same_account: true } }), config(), NOON))).toContain("kind_not_supported_by_channel");
  });
});

describe("B: mottakerens egen avmelding (STOP) kan ikke omgås", () => {
  it("en avmeldt mottaker avslås uansett formål, tekst og kanal", () => {
    for (const channel of ["sms", "whatsapp"] as const) {
      for (const purpose of ["transactional", "agreed"] as const) {
        const r = evaluateOutboundPolicy(sms({ channel, account_ref: channel === "sms" ? "+4791000000" : "123456789", purpose }), state({ recipient_opted_out: true, last_inbound_at: NOON.toISOString() }), config(), NOON);
        expect(r.allowed, `${channel}/${purpose}`).toBe(false);
        expect(r.denial_codes).toContain("recipient_opted_out");
      }
    }
  });

  it("redigering til en avmeldt mottaker avslås, men å slette egen melding og reagere berøres ikke av avmeldingen", () => {
    const edit = evaluateOutboundPolicy({ kind: "edit", channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", purpose: "transactional", content: { text: "rettet" }, target_message_id: "1.2" },
      state({ recipient_opted_out: true, target: { own_sent: true, same_account: true } }), config(), NOON);
    expect(edit.denial_codes).toContain("recipient_opted_out");
    const del = evaluateOutboundPolicy({ kind: "delete", channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", purpose: "transactional", content: {}, target_message_id: "1.2" },
      state({ recipient_opted_out: true, target: { own_sent: true, same_account: true } }), config(), NOON);
    expect(del.allowed).toBe(true);
  });
});

describe("C: markedsføring feiler LUKKET (markedsføringsloven § 15 / Reservasjonsregisteret er uverifisert)", () => {
  const marketing = (text: string, over: Partial<OutboundPolicyState> = {}) => evaluateOutboundPolicy(sms({ purpose: "marketing", content: { text } }), state(over), config(), NOON);

  it("uten verifisert registeroppslag avslås markedsføring selv med samtykke", () => {
    const r = marketing("Nytt tilbud! Svar STOPP for å melde deg av.", { marketing: { prior_consent: true, reservation_register: "unverified" } });
    expect(r.denial_codes).toContain("marketing_blocked_reservation_register_unverified");
  });

  it("reservert mottaker, manglende samtykke og manglende avmeldingsinstruks avslås hver for seg", () => {
    expect(marketing("Tilbud! STOPP", { marketing: { prior_consent: true, reservation_register: "reserved" } }).denial_codes).toContain("marketing_recipient_in_reservation_register");
    expect(marketing("Tilbud! STOPP", { marketing: { prior_consent: false, reservation_register: "not_reserved" } }).denial_codes).toContain("marketing_blocked_no_registered_consent");
    expect(marketing("Nytt tilbud for deg", { marketing: { prior_consent: true, reservation_register: "not_reserved" } }).denial_codes).toContain("marketing_missing_opt_out_instruction");
  });

  it("KUN verifisert «ikke reservert» + registrert samtykke + avmeldingsinstruks passerer markedsføringsregelen (øvrige regler gjelder fortsatt)", () => {
    const ok = marketing("Nytt tilbud for deg. Svar STOPP for å melde deg av.", { marketing: { prior_consent: true, reservation_register: "not_reserved" } });
    expect(ok.rules.find((x) => x.rule === "purpose_marketing")?.outcome).toBe("pass");
    // stille timer gjelder fortsatt for markedsføring
    const night = evaluateOutboundPolicy(sms({ purpose: "marketing", content: { text: "Tilbud! Svar STOPP" } }), state({ marketing: { prior_consent: true, reservation_register: "not_reserved" } }), config(), NIGHT);
    expect(night.denial_codes).toContain("quiet_hours");
  });

  it("modellvalgt formål kan ikke omgå: reklametekst merket «transactional» til en kald mottaker avslås, til en fersk samtale ikke", () => {
    const promo = "Vi har et spesialtilbud: 30% rabatt kun denne uken";
    expect(looksLikeMarketing(promo)).toBe(true);
    expect(evaluateOutboundPolicy(sms({ content: { text: promo } }), state(), config(), NOON).denial_codes).toContain("content_looks_like_marketing");
    expect(evaluateOutboundPolicy(sms({ purpose: "agreed", content: { text: promo } }), state(), config(), NOON).denial_codes).toContain("content_looks_like_marketing");
    const inThread = evaluateOutboundPolicy(sms({ content: { text: "Som avtalt gir jeg deg 10% rabatt" } }), state({ last_inbound_at: new Date(NOON.getTime() - 3 * 3_600_000).toISOString() }), config(), NOON);
    expect(inThread.denial_codes).not.toContain("content_looks_like_marketing");
    expect(inThread.recipient_proof.method).toBe("inbound_thread");
  });

  it("«avtalt» krever bevis på et forhold (innkommende tråd eller løst identitet), ikke bare at modellen sier det", () => {
    const cold = evaluateOutboundPolicy(sms({ purpose: "agreed" }), state({ recipient_identity: null }), config(), NOON);
    expect(cold.denial_codes).toContain("agreed_requires_relationship_evidence");
    expect(evaluateOutboundPolicy(sms({ purpose: "agreed" }), state(), config(), NOON).allowed).toBe(true);
    expect(evaluateOutboundPolicy(sms({ purpose: "agreed" }), state({ recipient_identity: null, last_inbound_at: new Date(NOON.getTime() - 86_400_000).toISOString() }), config(), NOON).allowed).toBe(true);
  });
});

describe("D: stille timer", () => {
  it("klokkehjelperne er riktige for Europe/Oslo (vintertid og sommertid) og fail-closed", () => {
    expect(localHour(NOON, "Europe/Oslo")).toBe(12);
    expect(localHour(new Date("2026-07-01T10:00:00Z"), "Europe/Oslo")).toBe(12);
    expect(isQuietHour(23, 22, 8)).toBe(true);
    expect(isQuietHour(7, 22, 8)).toBe(true);
    expect(isQuietHour(8, 22, 8)).toBe(false);
    expect(isQuietHour(12, 5, 5)).toBe(true); // start = slutt: hele døgnet (fail-closed)
    expect(isQuietHour(Number.NaN, 22, 8)).toBe(true);
  });

  it("natt avslås for personlige kanaler, dagtid er OK, en fersk innkommende melding (≤ 2 t) fritar, arbeidskanaler berøres ikke", () => {
    expect(evaluateOutboundPolicy(sms(), state(), config(), NIGHT).denial_codes).toContain("quiet_hours");
    expect(evaluateOutboundPolicy(sms(), state(), config(), NOON).allowed).toBe(true);
    const replying = evaluateOutboundPolicy(sms(), state({ last_inbound_at: new Date(NIGHT.getTime() - 30 * 60_000).toISOString() }), config(), NIGHT);
    expect(replying.denial_codes).not.toContain("quiet_hours");
    const staleThread = evaluateOutboundPolicy(sms(), state({ last_inbound_at: new Date(NIGHT.getTime() - 5 * 3_600_000).toISOString() }), config(), NIGHT);
    expect(staleThread.denial_codes).toContain("quiet_hours");
    const slack = evaluateOutboundPolicy({ kind: "message", channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", purpose: "transactional", content: { text: "hei" } }, state(), config(), NIGHT);
    expect(slack.allowed).toBe(true);
  });

  it("eieren kan slå stille timer av (suveren konfigurasjon), men aldri via en parameter", () => {
    expect(evaluateOutboundPolicy(sms(), state(), config({ JARVIS_COMMS_QUIET_HOURS: "off" }), NIGHT).allowed).toBe(true);
    // ikke-eksakte verdier slår den ikke av
    for (const v of ["OFF", "false", "0", "no", " "]) expect(evaluateOutboundPolicy(sms(), state(), config({ JARVIS_COMMS_QUIET_HOURS: v }), NIGHT).denial_codes, v).toContain("quiet_hours");
  });
});

describe("E: ratebegrensning", () => {
  it("per mottaker per døgn (kald mottaker strengere) og per konto per time", () => {
    expect(evaluateOutboundPolicy(sms(), state({ sends_last_24h_to_recipient: 3 }), config(), NOON).denial_codes).toContain("rate_limit_recipient_day");
    expect(evaluateOutboundPolicy(sms(), state({ sends_last_24h_to_recipient: 2 }), config(), NOON).allowed).toBe(true);
    expect(evaluateOutboundPolicy(sms(), state({ recipient_identity: null, sends_last_24h_to_recipient: 1 }), config(), NOON).denial_codes).toContain("rate_limit_cold_recipient_day");
    expect(evaluateOutboundPolicy(sms(), state({ sends_last_hour_from_account: 30 }), config(), NOON).denial_codes).toContain("rate_limit_account_hour");
    expect(evaluateOutboundPolicy(sms(), state({ sends_last_24h_to_recipient: 5 }), config({ JARVIS_COMMS_MAX_PER_RECIPIENT_DAY: "10" }), NOON).allowed).toBe(true);
  });
});

describe("F: plattformregler - kundeservicevindu og maler", () => {
  const wa = (content: OutboundRequest["content"], over: Partial<OutboundRequest> = {}): OutboundRequest =>
    ({ kind: "message", channel: "whatsapp", account_ref: "109876543210", recipient: "+4790000000", purpose: "transactional", content, ...over });
  const inWindow = new Date(NOON.getTime() - 20 * 3_600_000).toISOString();
  const outsideWindow = new Date(NOON.getTime() - 26 * 3_600_000).toISOString();

  it("WhatsApp-fritekst kun innenfor 24 timer; utenfor kreves en godkjent mal som eieren har attestert inneholder AI-opplysningen", () => {
    expect(evaluateOutboundPolicy(wa({ text: "Hei" }), state({ last_inbound_at: inWindow }), config(), NOON).allowed).toBe(true);
    expect(evaluateOutboundPolicy(wa({ text: "Hei" }), state({ last_inbound_at: outsideWindow }), config(), NOON).denial_codes).toContain("outside_window_use_approved_template");
    expect(evaluateOutboundPolicy(wa({ text: "Hei" }), state(), config(), NOON).denial_codes).toContain("outside_window_use_approved_template");
    const tpl = evaluateOutboundPolicy(wa({ template: { name: "ai_hello", language: "nb", params: ["Kari"] } }), state({ last_inbound_at: outsideWindow }), config(), NOON);
    expect(tpl.allowed).toBe(true);
    expect(tpl.final_text).toBeNull();
    const unattested = evaluateOutboundPolicy(wa({ template: { name: "order_update", language: "nb", params: [] } }), state({ last_inbound_at: outsideWindow }), config(), NOON);
    expect(unattested.denial_codes).toContain("template_without_disclosure_attestation");
  });

  it("Messenger/Instagram har ingen maler og ingen meldingskoder: utenfor vinduet avslås alt", () => {
    for (const channel of ["messenger", "instagram"] as const) {
      const req: OutboundRequest = { kind: "message", channel, account_ref: "109876543210", recipient: "1234567890", purpose: "transactional", content: { text: "hei" } };
      expect(evaluateOutboundPolicy(req, state({ last_inbound_at: outsideWindow }), config(), NOON).denial_codes, channel).toContain("outside_messaging_window");
      expect(evaluateOutboundPolicy(req, state({ last_inbound_at: inWindow }), config(), NOON).allowed, channel).toBe(true);
      expect(evaluateOutboundPolicy({ ...req, content: { template: { name: "ai_hello", language: "nb", params: [] } } }, state({ last_inbound_at: inWindow }), config(), NOON).denial_codes, channel).toContain("templates_not_supported_by_channel");
    }
  });

  it("maler på SMS avslås; ugyldig mal avslås", () => {
    expect(evaluateOutboundPolicy(sms({ content: { template: { name: "ai_hello", language: "nb", params: [] } } }), state(), config(), NOON).denial_codes).toContain("templates_not_supported_by_channel");
    expect(evaluateOutboundPolicy(wa({ template: { name: "Ugyldig Navn!", language: "nb", params: [] } }), state({ last_inbound_at: inWindow }), config(), NOON).denial_codes).toContain("template_invalid");
  });

  it("media: kun https, kun eksakt tillatt vert, bildetekst er påkrevd (AI-opplysningen går i teksten)", () => {
    const media = (url: string, caption?: string) => wa({ media: { kind: "image", url, ...(caption !== undefined ? { caption } : {}) } });
    const ok = evaluateOutboundPolicy(media("https://cdn.example.com/a.png", "Se bildet"), state({ last_inbound_at: inWindow }), config(), NOON);
    expect(ok.allowed).toBe(true);
    expect(ok.final_text).toContain(DEFAULT_AI_DISCLOSURE_TEXT);
    for (const [url, code] of [["https://evil.example.org/a.png", "media_host_not_allowed"], ["http://cdn.example.com/a.png", "media_url_invalid"], ["https://user:pw@cdn.example.com/a.png", "media_url_invalid"],
      ["https://cdn.example.com:8443/a.png", "media_url_invalid"], ["not a url", "media_url_invalid"]] as const) {
      expect(evaluateOutboundPolicy(media(url, "tekst"), state({ last_inbound_at: inWindow }), config(), NOON).denial_codes, url).toContain(code);
    }
    expect(evaluateOutboundPolicy(media("https://cdn.example.com/a.png"), state({ last_inbound_at: inWindow }), config(), NOON).denial_codes).toContain("media_caption_required_for_disclosure");
    expect(evaluateOutboundPolicy(media("https://cdn.example.com/a.png", "x"), state({ last_inbound_at: inWindow }), config({ JARVIS_COMMS_MEDIA_URL_HOSTS: "" }), NOON).denial_codes).toContain("media_host_not_allowed");
  });
});

describe("G: innhold og AI-opplysning kan ikke omgås", () => {
  it("AI-opplysningen er ALLTID med for tillatte meldinger på alle kanaler, lagt til av koden (ikke duplisert hvis den allerede står der)", () => {
    for (const channel of COMMS_CHANNELS.filter((c) => c !== "phone")) {
      const ref = channel === "sms" ? "+4791000000" : channel === "slack" ? "T0AAAAAAAA" : channel === "teams" ? "00000000-0000-0000-0000-000000000000" : channel === "discord" ? "123456789012345678" : "109876543210";
      const recipient = channel === "sms" || channel === "whatsapp" ? "+4790000000" : channel === "slack" ? "C0AAAAAAAA" : channel === "discord" ? "123456789012345678" : channel === "teams" ? "chat:19:abc_def@thread.v2" : "1234567890";
      const r = evaluateOutboundPolicy({ kind: "message", channel, account_ref: ref, recipient, purpose: "transactional", content: { text: "Hei" } }, state({ last_inbound_at: new Date(NOON.getTime() - 3_600_000).toISOString() }), config(), NOON);
      expect(r.allowed, channel).toBe(true);
      expect(r.final_text, channel).toContain(DEFAULT_AI_DISCLOSURE_TEXT);
    }
    const already = evaluateOutboundPolicy(sms({ content: { text: `Hei\n\n${DEFAULT_AI_DISCLOSURE_TEXT}` } }), state(), config(), NOON);
    expect(already.final_text?.split(DEFAULT_AI_DISCLOSURE_TEXT)).toHaveLength(2);
    expect(already.rules.find((x) => x.rule === "ai_disclosure")?.code).toBe("already_present");
  });

  it("eierens egen opplysningstekst brukes (ikke en modellvalgt), og en for lang melding med opplysning avslås i stedet for å kuttes", () => {
    const r = evaluateOutboundPolicy(sms(), state(), config({ JARVIS_COMMS_AI_DISCLOSURE_TEXT: "AI-assistent (Jarvis) på vegne av Tobias" }), NOON);
    expect(r.final_text).toContain("AI-assistent (Jarvis) på vegne av Tobias");
    const long = evaluateOutboundPolicy(sms({ content: { text: "a".repeat(1590) } }), state(), config(), NOON);
    expect(long.denial_codes).toContain("content_too_long_with_disclosure");
    expect(() => parseCommsConfig({ JARVIS_COMMS_AI_DISCLOSURE_TEXT: "ab" })).toThrow();
  });

  it("tom/ambiguøs/ugyldig tekst, kontrolltegn, hemmeligheter og kringkastingsomtaler avslås", () => {
    const deny = (content: OutboundRequest["content"], channel: CommsChannel = "sms") => {
      const base: OutboundRequest = channel === "slack"
        ? { kind: "message", channel, account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", purpose: "transactional", content }
        : sms({ content });
      return codes(evaluateOutboundPolicy(base, state(), config(), NOON));
    };
    expect(deny({})).toContain("content_empty");
    expect(deny({ text: "   " })).toContain("content_empty");
    expect(deny({ text: "a", template: { name: "ai_hello", language: "nb", params: [] } })).toContain("content_ambiguous");
    expect(deny({ text: `hei${String.fromCodePoint(0)}du` })).toContain("content_control_characters");
    expect(deny({ text: `skjult${String.fromCodePoint(0x202e)}tekst` })).toContain("content_control_characters");
    expect(deny({ text: "bruk token ghp_" + "a".repeat(30) })).toContain("content_contains_secret");
    expect(deny({ text: "se <!channel> nå" }, "slack")).toContain("content_slack_broadcast_mention");
    expect(deny({ text: "hei @everyone" })).toContain("content_broadcast_mention");
    expect(textIsSendable("linje 1\nlinje 2\ttab")).toBe(true);
    expect(textIsSendable(`a${String.fromCodePoint(0x2028)}b`)).toBe(false);
  });

  it("policyen er deterministisk og endrer aldri inndata", () => {
    const req = sms();
    const frozen = JSON.stringify(req);
    const a = evaluateOutboundPolicy(req, state(), config(), NOON);
    const b = evaluateOutboundPolicy(req, state(), config(), NOON);
    expect(a).toEqual(b);
    expect(JSON.stringify(req)).toBe(frozen);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe("H: redigering, sletting og reaksjon", () => {
  const slackReq = (kind: "edit" | "delete" | "reaction", over: Partial<OutboundRequest> = {}): OutboundRequest => ({
    kind, channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", purpose: "transactional", content: kind === "edit" ? { text: "rettet" } : kind === "reaction" ? { reaction: "thumbsup" } : {},
    target_message_id: "1731850000.000200", ...over
  });

  it("kun egen sendt melding fra samme konto kan redigeres/slettes", () => {
    for (const kind of ["edit", "delete"] as const) {
      expect(evaluateOutboundPolicy(slackReq(kind), state({ target: { own_sent: true, same_account: true } }), config(), NOON).allowed, kind).toBe(true);
      expect(evaluateOutboundPolicy(slackReq(kind), state({ target: { own_sent: false, same_account: true } }), config(), NOON).denial_codes, kind).toContain("target_not_own_sent_message");
      expect(evaluateOutboundPolicy(slackReq(kind), state({ target: { own_sent: true, same_account: false } }), config(), NOON).denial_codes, kind).toContain("target_not_own_sent_message");
      expect(evaluateOutboundPolicy(slackReq(kind), state({ target: null }), config(), NOON).denial_codes, kind).toContain("target_not_own_sent_message");
      expect(evaluateOutboundPolicy(slackReq(kind, { target_message_id: undefined as never }), state({ target: { own_sent: true, same_account: true } }), config(), NOON).denial_codes, kind).toContain("target_message_id_missing");
    }
  });

  it("en redigert tekst beholder AI-opplysningen; reaksjon trenger mål og gyldig emoji, men ikke AI-opplysning", () => {
    const edit = evaluateOutboundPolicy(slackReq("edit"), state({ target: { own_sent: true, same_account: true } }), config(), NOON);
    expect(edit.final_text).toContain(DEFAULT_AI_DISCLOSURE_TEXT);
    const react = evaluateOutboundPolicy(slackReq("reaction"), state(), config(), NOON);
    expect(react.allowed).toBe(true);
    expect(react.final_text).toBeNull();
    expect(evaluateOutboundPolicy(slackReq("reaction", { content: { reaction: "x".repeat(70) } }), state(), config(), NOON).denial_codes).toContain("reaction_invalid");
    expect(evaluateOutboundPolicy(slackReq("reaction", { channel: "teams", account_ref: "00000000-0000-0000-0000-000000000000", recipient: "chat:19:abc_def@thread.v2" }), state(), config(), NOON).denial_codes).toContain("kind_not_supported_by_channel");
  });
});

describe("I: utgående samtale (regler)", () => {
  const call = (over: Partial<OutboundRequest> = {}): OutboundRequest => ({
    kind: "call", channel: "phone", account_ref: "+4791000000", recipient: "+4790000000", purpose: "transactional", content: { text: "Jeg ringer for å bekrefte timen din i morgen." }, ...over
  });

  it("opplysningen kommer FØRST, tidsvinduet gjelder, ett anrop per nummer per døgn, og opptak bygges ikke", () => {
    const ok = evaluateOutboundPolicy(call(), state(), config(), NOON);
    expect(ok.allowed).toBe(true);
    expect(ok.final_text!.startsWith(DEFAULT_AI_DISCLOSURE_TEXT)).toBe(true);
    expect(evaluateOutboundPolicy(call(), state(), config(), NIGHT).denial_codes).toContain("outside_call_window");
    expect(evaluateOutboundPolicy(call(), state(), config(), new Date("2026-11-17T19:30:00Z")).denial_codes).toContain("outside_call_window"); // 20:30 lokal
    expect(evaluateOutboundPolicy(call(), state({ calls_last_24h_to_recipient: 1 }), config(), NOON).denial_codes).toContain("rate_limit_calls_per_number_day");
    expect(evaluateOutboundPolicy(call({ content: { text: "Hei", recording: true } }), state(), config(), NOON).denial_codes).toContain("call_recording_not_supported");
  });

  it("anropsvinduet kan ikke omgås av en fersk innkommende melding (stille timer kan, anropsvinduet kan ikke), og avmeldt/markedsføring gjelder", () => {
    const recent = state({ last_inbound_at: new Date(NIGHT.getTime() - 60_000).toISOString() });
    expect(evaluateOutboundPolicy(call(), recent, config(), NIGHT).denial_codes).toContain("outside_call_window");
    expect(evaluateOutboundPolicy(call(), state({ recipient_opted_out: true }), config(), NOON).denial_codes).toContain("recipient_opted_out");
    expect(evaluateOutboundPolicy(call({ purpose: "marketing" }), state(), config(), NOON).denial_codes).toContain("marketing_blocked_reservation_register_unverified");
  });
});

describe("J: kanalprofiler og hashing", () => {
  it("hver kanal har en profil, og pseudonymet er tenant- og kanalskopet", () => {
    for (const c of COMMS_CHANNELS) expect(CHANNEL_PROFILES[c].max_text_chars, c).toBeGreaterThan(0);
    const a = recipientHash("tenant-a", "sms", "+4790000000");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(recipientHash("tenant-b", "sms", "+4790000000")).not.toBe(a);
    expect(recipientHash("tenant-a", "whatsapp", "+4790000000")).not.toBe(a);
    expect(recipientHash("tenant-a", "sms", "+4790000000")).toBe(a);
  });

  it("konfigurasjonen er AV som standard og avviser ukjente kanaler/leverandører (skrivefeil stopper oppstarten)", () => {
    const off = parseCommsConfig({});
    expect(off.outbound).toBe(false);
    expect(off.channels.size).toBe(0);
    expect(off.webhooks.size).toBe(0);
    for (const v of ["1", "true", "yes", "ON", "On"]) expect(parseCommsConfig({ JARVIS_COMMS_OUTBOUND: v }).outbound, v).toBe(false);
    expect(() => parseCommsConfig({ JARVIS_COMMS_CHANNELS: "slack,signal" })).toThrow();
    expect(() => parseCommsConfig({ JARVIS_COMMS_WEBHOOKS: "stripe" })).toThrow();
    expect(() => parseCommsConfig({ JARVIS_COMMS_MEMORY_SPACE: "health" })).toThrow();
    expect(() => parseCommsConfig({ JARVIS_COMMS_PUBLIC_BASE_URL: "http://example.com" })).toThrow();
    expect(() => parseCommsConfig({ JARVIS_COMMS_MAX_PER_RECIPIENT_DAY: "0" })).toThrow();
  });
});

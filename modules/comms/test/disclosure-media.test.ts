import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMS_CHANNELS, DEFAULT_AI_DISCLOSURE_TEXT, ProviderRejectedError, TwilioSmsAdapter, WhatsAppAdapter, evaluateOutboundPolicy, isXmlSafe, parseCommsConfig, textIsSendable, type AdapterSend, type OutboundPolicyState,
  type OutboundRequest
} from "../src/index.ts";

/**
 * WP-G1 fiks-runde A-M1 (+ L3 media-URL og L4 TwiML): AI-opplysningen kan ikke forsvinne på veien til mottakeren mens journalen sier `ai_disclosure_applied=true`. WhatsApp-LYD kan ikke ha bildetekst (payload var
 * `{type:audio, audio:{link}}` uten tekst); nå sendes opplysningen som EGEN tekstmelding FØRST. Stemmen settes eksplisitt i TwiML, XML-ugyldige tegn avvises før sending, og validert media-URL er nøyaktig den som sendes.
 */
interface Call { url: string; body: Record<string, unknown> }
let calls: Call[] = [];
const stub = (handler: (call: Call, n: number) => Response): void => {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url: String(url), body: typeof init.body === "string" && init.body.startsWith("{") ? (JSON.parse(init.body) as Record<string, unknown>) : { raw: String(init.body) } };
    calls.push(call);
    return handler(call, calls.length);
  });
};
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

const TARGET = { account_ref: "109876543210", recipient: "+4790000000" };
const TEXT = `Se vedlegget\n\n${DEFAULT_AI_DISCLOSURE_TEXT}`;
const wa = () => new WhatsAppAdapter("v25.0");
const media = (kind: "image" | "document" | "audio" | "video"): AdapterSend => ({ ...TARGET, text: TEXT, template: null, media: { kind, url: "https://cdn.example.com/f.bin" }, thread_ref: null });

describe("A-M1: AI-opplysningen følger med for HVER media-type på WhatsApp", () => {
  it.each(["image", "document", "video"] as const)("%s: ett kall, opplysningen står i bildeteksten", async (kind) => {
    stub(() => jsonRes({ messages: [{ id: "wamid.M1" }] }));
    const r = await wa().send(media(kind), "t");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ type: kind, [kind]: { link: "https://cdn.example.com/f.bin", caption: TEXT } });
    expect(JSON.stringify(calls[0]!.body)).toContain("Sendt av Jarvis");
    expect(r.provider_message_id).toBe("wamid.M1");
  });

  it("audio: opplysningen sendes som EGEN tekstmelding FØRST, deretter lyden (uten bildetekst); id-en som returneres er lydmeldingens", async () => {
    stub((_c, n) => jsonRes({ messages: [{ id: n === 1 ? "wamid.TEXT" : "wamid.AUDIO" }] }));
    const r = await wa().send(media("audio"), "t");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({ type: "text", text: { body: TEXT, preview_url: false } });
    expect(JSON.stringify(calls[0]!.body)).toContain("Sendt av Jarvis");
    expect(calls[1]!.body).toMatchObject({ type: "audio", audio: { link: "https://cdn.example.com/f.bin" } });
    expect(Object.keys((calls[1]!.body["audio"] as Record<string, unknown>))).toEqual(["link"]);
    expect(r.provider_message_id).toBe("wamid.AUDIO");
  });

  it("audio uten tekst (ingen opplysning å sende) avvises FØR noe kall; feiler tekstmeldingen sendes ALDRI lyden", async () => {
    stub(() => jsonRes({ messages: [{ id: "x" }] }));
    await expect(wa().send({ ...media("audio"), text: null }, "t")).rejects.toThrow("comms_whatsapp_audio_requires_disclosure_text");
    expect(calls).toHaveLength(0);
    stub(() => jsonRes({ error: { code: 131047 } }, 400));
    await expect(wa().send(media("audio"), "t")).rejects.toThrow("comms_provider_rejected:whatsapp:131047");
    expect(calls).toHaveLength(1); // kun tekstmeldingen ble forsøkt
    expect(calls[0]!.body["type"]).toBe("text");
  });

  it("audio: lyden avvises ETTER at opplysningen er levert = UKJENT utfall (noe nådde mottakeren), ikke en vanlig `failed`; 2xx uten id på lyden er også ukjent", async () => {
    stub((_c, n) => (n === 1 ? jsonRes({ messages: [{ id: "wamid.TEXT" }] }) : jsonRes({ error: { code: 131053 } }, 400)));
    const err = await wa().send(media("audio"), "t").then(() => null, (e: Error) => e);
    expect(err).not.toBeInstanceOf(ProviderRejectedError);
    expect(err?.message).toBe("outcome_unknown:comms_whatsapp_audio_not_delivered_after_disclosure");
    expect(calls).toHaveLength(2);
    stub((_c, n) => (n === 1 ? jsonRes({ messages: [{ id: "wamid.TEXT" }] }) : jsonRes({ messages: [] })));
    await expect(wa().send(media("audio"), "t")).rejects.toThrow("outcome_unknown:comms_whatsapp_no_message_id");
  });
});

describe("A-M1 (policy): bildetekst med opplysningen er påkrevd for ALLE media-typer inkl. lyd", () => {
  const config = parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: COMMS_CHANNELS.join(","), JARVIS_COMMS_MEDIA_URL_HOSTS: "cdn.example.com" });
  const state: OutboundPolicyState = {
    account_authorized: true, recipient_opted_out: false, sends_last_24h_to_recipient: 0, calls_last_24h_to_recipient: 0, sends_last_hour_from_account: 0,
    last_inbound_at: new Date("2026-11-17T10:00:00Z").toISOString(), recipient_identity: { identity_id: "id-1", confidence: 1 }, target: null, marketing: { prior_consent: false, reservation_register: "unverified" }
  };
  const NOON = new Date("2026-11-17T11:00:00Z");
  const req = (kind: "image" | "document" | "audio" | "video", url = "https://cdn.example.com/f.bin", caption?: string): OutboundRequest => ({
    kind: "message", channel: "whatsapp", account_ref: "109876543210", recipient: "+4790000000", purpose: "transactional", content: { media: { kind, url, ...(caption !== undefined ? { caption } : {}) } }
  });

  it("uten bildetekst avslås hver media-type (opplysningen kan ikke legges til); med bildetekst bærer final_text opplysningen og journalen kan stå inne for den", () => {
    for (const kind of ["image", "document", "audio", "video"] as const) {
      expect(evaluateOutboundPolicy(req(kind), state, config, NOON).denial_codes, kind).toContain("media_caption_required_for_disclosure");
      const ok = evaluateOutboundPolicy(req(kind, "https://cdn.example.com/f.bin", "Se vedlegget"), state, config, NOON);
      expect(ok.allowed, kind).toBe(true);
      expect(ok.disclosure_applied, kind).toBe(true);
      expect(ok.final_text, kind).toBe(`Se vedlegget\n\n${DEFAULT_AI_DISCLOSURE_TEXT}`);
    }
  });

  it("L3: kun den KANONISKE URL-formen godtas - tab/linjeskift/ledende mellomrom, ../-segmenter, store bokstaver i verten og tom sti gir `media_url_invalid` (validert streng = sendt streng)", () => {
    const tab = String.fromCodePoint(9);
    const nl = String.fromCodePoint(10);
    const bad = [` https://cdn.example.com/a.png`, `https://cdn.example.com/a${tab}.png`, `https://cdn.example.com/a${nl}.png`, "https://cdn.example.com/x/../a.png", "https://cdn.example.com/./a.png",
      "https://CDN.example.com/a.png", "https://cdn.example.com", "https://cdn.example.com:443/a.png", "https://cdn.example.com/a b.png"];
    for (const url of bad) expect(evaluateOutboundPolicy(req("image", url, "Se bildet"), state, config, NOON).denial_codes, JSON.stringify(url)).toContain("media_url_invalid");
    for (const url of ["https://cdn.example.com/a.png", "https://cdn.example.com/x/a%20b.png?v=1&w=2", "https://cdn.example.com/"]) {
      expect(evaluateOutboundPolicy(req("image", url, "Se bildet"), state, config, NOON).denial_codes, url).not.toContain("media_url_invalid");
    }
  });
});

describe("L4: TwiML - eksplisitt stemme og XML-ugyldige tegn", () => {
  const sid = async () => "ACfaketestsid0000000000";
  const script = `${DEFAULT_AI_DISCLOSURE_TEXT} Hei, dette gjelder timen din i morgen.`;
  const twiml = (c: Call) => new URLSearchParams(String(c.body["raw"])).get("Twiml")!;

  it("`<Say>` har voice og language (standardstemmen støtter ikke norsk); stemmen kan overstyres og valideres", async () => {
    stub(() => jsonRes({ sid: "CAfake0000000000000000000000000009" }, 201));
    await new TwilioSmsAdapter(sid).call({ account_ref: "+4791000000", recipient: "+4790001111", script }, "t");
    expect(twiml(calls[0]!)).toBe(`<Response><Say voice="Polly.Liv" language="nb-NO">${script}</Say></Response>`);
    await new TwilioSmsAdapter(sid, { callVoice: "Polly.Ida" }).call({ account_ref: "+4791000000", recipient: "+4790001111", script }, "t");
    expect(twiml(calls[1]!)).toContain('<Say voice="Polly.Ida" language="nb-NO">');
    for (const bad of ['Polly.Liv" x="', "", "1abc", "a b"]) {
      await expect(new TwilioSmsAdapter(sid, { callVoice: bad }).call({ account_ref: "+4791000000", recipient: "+4790001111", script }, "t"), JSON.stringify(bad)).rejects.toThrow("comms_twilio_call_voice_invalid");
    }
    expect(calls).toHaveLength(2);
  });

  it("XML-ugyldige tegn (U+FFFE, U+FFFF, kontrolltegn, ensomt surrogat) avvises FØR noe sendes; policyen avviser dem allerede som tekst (noncharacters er ikke sendbare)", async () => {
    const bad = [String.fromCodePoint(0xfffe), String.fromCodePoint(0xffff), String.fromCodePoint(1), String.fromCharCode(0xd800)];
    for (const ch of bad) {
      expect(isXmlSafe(`Hei${ch}`), String(ch.codePointAt(0))).toBe(false);
      stub(() => jsonRes({ sid: "CAx" }, 201));
      await expect(new TwilioSmsAdapter(sid).call({ account_ref: "+4791000000", recipient: "+4790001111", script: `${script}${ch}` }, "t")).rejects.toThrow("comms_twiml_invalid_character");
      expect(calls).toHaveLength(0);
    }
    expect(isXmlSafe(`Hei ${String.fromCodePoint(0xfffd)} æøå 👍\n\t`)).toBe(true);
    for (const cp of [0xfffe, 0xffff, 0xfdd0, 0xfdef, 0x1fffe, 0x10ffff]) expect(textIsSendable(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe(false);
    expect(textIsSendable(`Hei ${String.fromCodePoint(0xfffd)} æøå 👍\n`)).toBe(true);
  });
});

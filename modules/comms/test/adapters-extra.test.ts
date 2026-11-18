import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MetaMessagingAdapter, ProviderRejectedError, TeamsGraphAdapter, TwilioSmsAdapter, VendorReads, xmlEscape, type AdapterSend
} from "../src/index.ts";

/** Et Twilio-lignende meldings-SID bygget ved kjøring (aldri en bokstavelig nøkkel-lignende streng i kildekoden). */
const SM_SID = `SM${"0123456789abcdef".repeat(2)}`;

/**
 * WP-G1 (P1c/P2f/P3h): de nye adapterne og leverandør-lesingen mot en FALSK transport (`fetch` er stubbet; ingen ekte nettkall). Bevist: nøyaktig forespørselsform, ingen injeksjon (TwiML/sti), kun tekst der kanalen bare har tekst,
 * ukjent utfall klassifiseres som `outcome_unknown:`, og lesing minimerer personlige felt og renser ubetrodd tekst.
 */
interface Call { url: string; init: RequestInit }
let calls: Call[] = [];
function stub(handler: (call: Call) => Response | Promise<Response>): void {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call);
  });
}
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bodyJson = (c: Call): Record<string, unknown> => JSON.parse(String(c.init.body)) as Record<string, unknown>;
const hdr = (c: Call): Record<string, string> => c.init.headers as Record<string, string>;
const form = (c: Call): URLSearchParams => new URLSearchParams(String(c.init.body));
const sendReq = (over: Partial<AdapterSend> = {}): AdapterSend => ({ account_ref: "1234567890", recipient: "9876543210", text: "Hei\n\nSendt av Jarvis (AI-assistent).", template: null, media: null, thread_ref: null, ...over });
const errorOf = async (p: Promise<unknown>): Promise<Error> => (await p.then(() => null, (e: Error) => e)) as Error;
const FAKE_TOKEN = "fake-token-for-test";

afterEach(() => vi.unstubAllGlobals());

describe("Messenger og Instagram (Meta Send API)", () => {
  for (const [provider, label] of [["meta_messenger", "messenger"], ["meta_instagram", "instagram"]] as const) {
    it(`${label}: POST /{id}/messages med RESPONSE, side-scopet mottaker, Bearer og KUN tekst`, async () => {
      stub(() => jsonRes({ recipient_id: "9876543210", message_id: "m_abc123" }));
      const r = await new MetaMessagingAdapter(provider, "v25.0").send(sendReq(), FAKE_TOKEN);
      expect(r).toEqual({ provider_message_id: "m_abc123" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://graph.facebook.com/v25.0/1234567890/messages");
      expect(calls[0]?.init.method).toBe("POST");
      expect(hdr(calls[0]!)["authorization"]).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(bodyJson(calls[0]!)).toEqual({ recipient: { id: "9876543210" }, messaging_type: "RESPONSE", message: { text: "Hei\n\nSendt av Jarvis (AI-assistent)." } });
      // aldri meldingskoder/engangsvarsler: ingen `tag`, ingen `MESSAGE_TAG`
      expect(JSON.stringify(bodyJson(calls[0]!))).not.toMatch(/tag|UPDATE|NOTIFICATION/i);
    });

    it(`${label}: mal/media avvises før noe kall; leverandørfeil gir fast kode; 2xx uten meldings-id og 5xx er UKJENT utfall`, async () => {
      stub(() => jsonRes({}));
      const adapter = new MetaMessagingAdapter(provider, "v25.0");
      const media = await errorOf(adapter.send(sendReq({ media: { kind: "image", url: "https://x.example.com/a.png" } }), FAKE_TOKEN));
      expect(media).toBeInstanceOf(ProviderRejectedError);
      expect(media.message).toBe(`comms_provider_rejected:${label}:text_only_channel`);
      expect(calls).toHaveLength(0);
      stub(() => jsonRes({ error: { code: 10, message: "token EAAB-hemmelig lekket her" } }, 400));
      const rejected = await errorOf(adapter.send(sendReq(), FAKE_TOKEN));
      expect(rejected.message).toBe(`comms_provider_rejected:${label}:10`);
      expect(rejected.message).not.toContain("hemmelig");
      stub(() => jsonRes({ recipient_id: "1" }));
      expect((await errorOf(adapter.send(sendReq(), FAKE_TOKEN))).message).toBe(`outcome_unknown:comms_${label}_no_message_id`);
      stub(() => new Response("nede", { status: 503 }));
      expect((await errorOf(adapter.send(sendReq(), FAKE_TOKEN))).message).toMatch(/^outcome_unknown:/);
    });
  }

  it("konto-id i stien kan ikke injisere sti-segmenter", async () => {
    stub(() => jsonRes({ message_id: "m_1" }));
    const err = await errorOf(new MetaMessagingAdapter("meta_messenger", "v25.0").send(sendReq({ account_ref: "../me/accounts" }), FAKE_TOKEN));
    expect(err).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
  });
});

describe("Microsoft Teams (Graph, kun delegert sending)", () => {
  const CHAT = "chat:19:abcdefgh_ijklmnop@thread.v2";
  const CHANNEL = "channel:0f8fad5b-d9cb-469f-a165-70867728950e/19:abcdefgh1234@thread.tacv2";

  it("chat og kanal: riktig sti, ren tekst (contentType text), Bearer fra tokenFor (ikke selve refresh-tokenet)", async () => {
    stub(() => jsonRes({ id: "1700000000001" }, 201));
    const exchanged: string[] = [];
    const adapter = new TeamsGraphAdapter(async (credential) => { exchanged.push(credential); return "fake-access-token"; });
    const a = await adapter.send(sendReq({ recipient: CHAT, account_ref: "0f8fad5b-d9cb-469f-a165-70867728950e" }), "fake-refresh-token");
    expect(a).toEqual({ provider_message_id: "1700000000001" });
    expect(exchanged).toEqual(["fake-refresh-token"]);
    expect(decodeURIComponent(calls[0]!.url)).toBe("https://graph.microsoft.com/v1.0/chats/19:abcdefgh_ijklmnop@thread.v2/messages");
    expect(hdr(calls[0]!)["authorization"]).toBe("Bearer fake-access-token");
    expect(bodyJson(calls[0]!)).toEqual({ body: { contentType: "text", content: "Hei\n\nSendt av Jarvis (AI-assistent)." } });
    await adapter.send(sendReq({ recipient: CHANNEL, account_ref: "0f8fad5b-d9cb-469f-a165-70867728950e" }), "fake-refresh-token");
    expect(decodeURIComponent(calls[1]!.url)).toBe("https://graph.microsoft.com/v1.0/teams/0f8fad5b-d9cb-469f-a165-70867728950e/channels/19:abcdefgh1234@thread.tacv2/messages");
    expect(JSON.stringify(calls.map((c) => c.init.headers))).not.toContain("fake-refresh-token");
  });

  it("tokenutveksling som feiler stopper FØR noe kall (fast kode, ingen lekkasje); ugyldig mål og mal/media avvises", async () => {
    stub(() => jsonRes({ id: "x" }));
    const failing = new TeamsGraphAdapter(async () => { throw new Error("invalid_grant: refresh-token abc-hemmelig"); });
    const err = await errorOf(failing.send(sendReq({ recipient: CHAT }), "fake-refresh-token"));
    expect(err.message).toBe("comms_teams_token_unavailable");
    expect(calls).toHaveLength(0);
    const ok = new TeamsGraphAdapter();
    expect((await errorOf(ok.send(sendReq({ recipient: "user:someone" }), FAKE_TOKEN))).message).toBe("comms_provider_rejected:teams:invalid_target");
    expect((await errorOf(ok.send(sendReq({ recipient: CHAT, text: null, template: { name: "t", language: "nb", params: [] } }), FAKE_TOKEN))).message).toBe("comms_provider_rejected:teams:text_only_channel");
    expect(calls).toHaveLength(0);
  });

  it("feilkode, manglende id og 5xx: fast kode / ukjent utfall", async () => {
    const adapter = new TeamsGraphAdapter();
    stub(() => jsonRes({ error: { code: "Forbidden", message: "tekst som kan sitere klientdata" } }, 403));
    expect((await errorOf(adapter.send(sendReq({ recipient: CHAT }), FAKE_TOKEN))).message).toBe("comms_provider_rejected:teams:forbidden");
    stub(() => jsonRes({}, 201));
    expect((await errorOf(adapter.send(sendReq({ recipient: CHAT }), FAKE_TOKEN))).message).toBe("outcome_unknown:comms_teams_no_message_id");
    stub(() => new Response("nede", { status: 502 }));
    expect((await errorOf(adapter.send(sendReq({ recipient: CHAT }), FAKE_TOKEN))).message).toMatch(/^outcome_unknown:/);
  });
});

describe("Twilio utgående samtale (inline TwiML)", () => {
  const sid = async () => "ACfaketestsid0000000000";
  const script = "Sendt av Jarvis (AI-assistent). Hei, dette gjelder timen din i morgen.";

  it("POST /Calls.json med To/From/Twiml, Basic-auth, ingen Record-parameter og manus med AI-opplysningen først", async () => {
    stub(() => jsonRes({ sid: "CAfake0000000000000000000000000001", status: "queued" }, 201));
    const r = await new TwilioSmsAdapter(sid).call({ account_ref: "+4791000000", recipient: "+4790001111", script }, FAKE_TOKEN);
    expect(r).toEqual({ provider_message_id: "CAfake0000000000000000000000000001" });
    expect(calls[0]?.url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACfaketestsid0000000000/Calls.json");
    expect(hdr(calls[0]!)["authorization"]).toBe(`Basic ${Buffer.from(`ACfaketestsid0000000000:${FAKE_TOKEN}`).toString("base64")}`);
    const f = form(calls[0]!);
    expect([...f.keys()].sort()).toEqual(["From", "To", "Twiml"]);
    expect(f.get("From")).toBe("+4791000000");
    expect(f.get("To")).toBe("+4790001111");
    expect(f.get("Twiml")).toBe(`<Response><Say language="nb-NO">${script}</Say></Response>`);
    const say = /<Say [^>]*>([\s\S]*)<\/Say>/.exec(f.get("Twiml")!)?.[1];
    expect(say?.startsWith("Sendt av Jarvis (AI-assistent).")).toBe(true); // AI-opplysningen er FØRSTE talte innhold
  });

  it("manuset XML-escapes: ingen tekst kan lukke <Say> eller legge til egne TwiML-verb (<Dial>, <Record>, <Redirect>)", async () => {
    stub(() => jsonRes({ sid: "CAfake0000000000000000000000000002" }, 201));
    const evil = `Hei</Say><Record/><Dial>+4799999999</Dial><Redirect>https://evil.example.com</Redirect><Say>& "ja" 'nei'`;
    await new TwilioSmsAdapter(sid).call({ account_ref: "+4791000000", recipient: "+4790001111", script: evil }, FAKE_TOKEN);
    const twiml = form(calls[0]!).get("Twiml")!;
    expect(twiml.startsWith('<Response><Say language="nb-NO">')).toBe(true);
    expect(twiml.endsWith("</Say></Response>")).toBe(true);
    expect(twiml.slice('<Response><Say language="nb-NO">'.length, -"</Say></Response>".length)).not.toMatch(/[<>]/);
    expect((twiml.match(/<\w+/g) ?? []).sort()).toEqual(["<Response", "<Say"]);
    expect(xmlEscape(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });

  it("språk valideres (fast format), manglende konto-SID stopper før kall, leverandøravslag gir fast kode og 5xx/manglende id er UKJENT utfall", async () => {
    stub(() => jsonRes({ sid: "CAx" }, 201));
    expect((await errorOf(new TwilioSmsAdapter(sid, { callLanguage: "nb-NO<x>" }).call({ account_ref: "+4791000000", recipient: "+4790001111", script }, FAKE_TOKEN))).message).toBe("comms_twilio_call_language_invalid");
    expect((await errorOf(new TwilioSmsAdapter(async () => null).call({ account_ref: "+4791000000", recipient: "+4790001111", script }, FAKE_TOKEN))).message).toBe("comms_twilio_account_sid_not_configured");
    expect(calls).toHaveLength(0);
    stub(() => jsonRes({ code: 21217, message: "fritekst" }, 400));
    expect((await errorOf(new TwilioSmsAdapter(sid).call({ account_ref: "+4791000000", recipient: "+4790001111", script }, FAKE_TOKEN))).message).toBe("comms_provider_rejected:twilio:21217");
    stub(() => jsonRes({}, 201));
    expect((await errorOf(new TwilioSmsAdapter(sid).call({ account_ref: "+4791000000", recipient: "+4790001111", script }, FAKE_TOKEN))).message).toBe("outcome_unknown:comms_twilio_no_call_id");
    stub(() => new Response("nede", { status: 500 }));
    expect((await errorOf(new TwilioSmsAdapter(sid).call({ account_ref: "+4791000000", recipient: "+4790001111", script }, FAKE_TOKEN))).message).toMatch(/^outcome_unknown:/);
  });
});

describe("Leverandør-lesing (ubetrodd data, minimerte felt)", () => {
  const reads = new VendorReads({ graphVersion: "v25.0", accountSid: async () => "ACfaketestsid0000000000" });
  const fakeKey = (): string => `ghp_${"c".repeat(30)}`; // bygget ved kjøring - aldri en bokstavelig nøkkel i kildekoden

  it("Slack-tråd: kun id/forfatter/renset tekst; kontrolltegn fjernes, hemmeligheter redigeres, tekst kuttes til 2000 tegn, ugyldige rader droppes", async () => {
    stub(() => jsonRes({
      ok: true, messages: [
        { ts: "1700000000.000100", user: "U012AB3CD", text: `hei${String.fromCodePoint(0)}du ${fakeKey()}` },
        { ts: "1700000000.000200", bot_id: "B012AB3CD", text: "x".repeat(3000), blocks: [{ type: "section" }], files: [{ url_private: "https://files.example.com/a" }] },
        { ts: "ugyldig ts med mellomrom", user: "U1", text: "skal droppes" },
        "ikke-et-objekt"
      ]
    }));
    const out = await reads.slackThread(FAKE_TOKEN, "C012AB3CD45", "1700000000.000100", 20);
    expect(out.map((m) => m.id)).toEqual(["1700000000.000100", "1700000000.000200"]);
    expect(out[0]?.text).toContain("[REDACTED:");
    expect(out[0]?.text).not.toContain(fakeKey());
    expect(out[0]?.text?.startsWith("heidu")).toBe(true);
    expect(Array.from(out[1]!.text!)).toHaveLength(2000);
    expect(out[1]?.author).toBe("B012AB3CD");
    expect(Object.keys(out[0]!).sort()).toEqual(["author", "id", "text", "ts"]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ channel: "C012AB3CD45", ts: "1700000000.000100", limit: 20 });
    expect(calls[0]?.url).toBe("https://slack.com/api/conversations.replies");
  });

  it("Slack-brukere: kun id, handle, bot- og slettet-flagg - aldri navn, e-post, telefon eller profil; neste-side-peker", async () => {
    stub(() => jsonRes({
      ok: true, members: [{ id: "U012AB3CD", name: "ola", real_name: "Ola Nordmann", is_bot: false, deleted: false, profile: { email: "ola@example.com", phone: "+4790000000" } }],
      response_metadata: { next_cursor: "dXNlcjpVMDYxTkZUVDI=" }
    }));
    const out = await reads.slackUsers(FAKE_TOKEN, 50, undefined);
    expect(out).toEqual({ users: [{ id: "U012AB3CD", handle: "ola", is_bot: false, deleted: false }], next_cursor: "dXNlcjpVMDYxTkZUVDI=" });
    expect(JSON.stringify(out)).not.toMatch(/Nordmann|example\.com|\+47/);
  });

  it("Slack-feil (ok:false) gir fast kode, aldri leverandørens fritekst", async () => {
    stub(() => jsonRes({ ok: false, error: "missing_scope", needed: "channels:history", provided: "xoxb-hemmelig" }));
    const err = await errorOf(reads.slackThread(FAKE_TOKEN, "C012AB3CD45", "1700000000.000100", 5));
    expect(err.message).toBe("comms_provider_rejected:slack:missing_scope");
  });

  it("Discord-melding: id/forfatter/renset tekst/tidsstempel; 404 gir null; ellers avslag med fast kode", async () => {
    stub(() => jsonRes({ id: "123456789012345678", content: `Hei ${fakeKey()}`, timestamp: "2026-11-17T10:00:00.000000+00:00", author: { id: "223456789012345678", username: "ola", avatar: "x" }, attachments: [{ url: "https://cdn.example.com/a" }] }));
    const m = await reads.discordMessage(FAKE_TOKEN, "323456789012345678", "123456789012345678");
    expect(m?.id).toBe("123456789012345678");
    expect(m?.author).toBe("223456789012345678");
    expect(m?.text).toContain("[REDACTED:");
    expect(JSON.stringify(m)).not.toMatch(/ola|cdn\.example/);
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/channels/323456789012345678/messages/123456789012345678");
    expect(hdr(calls[0]!)["authorization"]).toBe(`Bot ${FAKE_TOKEN}`);
    stub(() => jsonRes({ code: 10008, message: "Unknown Message" }, 404));
    expect(await reads.discordMessage(FAKE_TOKEN, "323456789012345678", "123456789012345678")).toBeNull();
    stub(() => jsonRes({ code: 50001, message: "Missing Access" }, 403));
    expect((await errorOf(reads.discordMessage(FAKE_TOKEN, "323456789012345678", "123456789012345678"))).message).toBe("comms_provider_rejected:discord:50001");
  });

  it("WhatsApp-maler: kun navn/språk/status/kategori (aldri malinnhold); ugyldige navn droppes; id-er valideres i stien", async () => {
    stub(() => jsonRes({ data: [{ name: "timebekreftelse", language: "nb", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hei {{1}}" }] }, { name: "Ugyldig Navn", language: "nb", status: "APPROVED" }] }));
    const out = await reads.whatsappTemplates(FAKE_TOKEN, "1029384756", 10);
    expect(out).toEqual([{ name: "timebekreftelse", language: "nb", status: "APPROVED", category: "UTILITY" }]);
    expect(calls[0]?.url).toBe("https://graph.facebook.com/v25.0/1029384756/message_templates?fields=name,language,status,category&limit=10");
    stub(() => jsonRes({ error: { code: 190 } }, 401));
    expect((await errorOf(reads.whatsappTemplates(FAKE_TOKEN, "1029384756", 10))).message).toBe("comms_provider_rejected:whatsapp:190");
    expect((await errorOf(reads.whatsappTemplates(FAKE_TOKEN, "../x", 10))).message).toBeTruthy();
  });

  it("Twilio-melding: status/retning/feilkode/tidspunkt + renset tekst; konto-SID mangler = stopp før kall", async () => {
    stub(() => jsonRes({ sid: SM_SID, status: "delivered", direction: "outbound-api", error_code: null, date_sent: "Mon, 16 Aug 2026 03:45:01 +0000", body: `Hei ${fakeKey()}`, to: "+4790001111", from: "+4791000000", price: "-0.05" }));
    const out = await reads.twilioMessage(FAKE_TOKEN, SM_SID);
    expect(out).toMatchObject({ sid: SM_SID, status: "delivered", direction: "outbound-api", error_code: null });
    expect(out.body).toContain("[REDACTED:");
    expect(JSON.stringify(out)).not.toMatch(/\+47|price/);
    expect(calls[0]?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/ACfaketestsid0000000000/Messages/${SM_SID}.json`);
    const noSid = new VendorReads({ graphVersion: "v25.0", accountSid: async () => null });
    calls = [];
    expect((await errorOf(noSid.twilioMessage(FAKE_TOKEN, SM_SID))).message).toBe("comms_twilio_account_sid_not_configured");
    expect(calls).toHaveLength(0);
  });
});

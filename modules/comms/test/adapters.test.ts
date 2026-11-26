import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscordAdapter, ProviderRejectedError, SlackAdapter, TelnyxSmsAdapter, TwilioSmsAdapter, WhatsAppAdapter, providerCall, safeVendorCode, connectorIdsForCredentialRef, PROVIDER_CREDENTIAL_REFS,
  type AdapterSend
} from "../src/index.ts";

/**
 * WP-G1 (P1c): kanal-adapterne mot en FALSK transport (`fetch` er stubbet; ingen ekte nettkall). Bevist: nøyaktig forespørselsform per leverandør, riktig auth-header, og feilklassifiseringen som idempotens/replay hviler på:
 * entydig avslag = vanlig feil; alt som KAN ha nådd leverandøren (5xx, 3xx, nullstilt socket, 2xx uten meldings-id, uleselig svar) = `outcome_unknown:` - aldri en vanlig feil som inviterer til dobbel sending.
 */
interface Call { url: string; init: RequestInit }
let calls: Call[] = [];

function stub(handler: (call: Call) => Response | Promise<Response>): void {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call);
  });
}
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const body = (c: Call): Record<string, unknown> => JSON.parse(String(c.init.body)) as Record<string, unknown>;
const headers = (c: Call): Record<string, string> => c.init.headers as Record<string, string>;
const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
const dns = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) });

const send = (over: Partial<AdapterSend> = {}): AdapterSend => ({ account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", text: "Hei\n\nSendt av Jarvis (AI-assistent).", template: null, media: null, thread_ref: null, ...over });
const expectUnknown = async (p: Promise<unknown>, part: string) => {
  const err = await p.then(() => null, (e: Error) => e);
  expect(err?.message, part).toMatch(/^outcome_unknown:/);
  expect(err?.message).toContain(part);
};

afterEach(() => vi.unstubAllGlobals());

describe("A: feilklassifisering (felles)", () => {
  it("leverandørkoder slipper kun gjennom i et trygt tegnsett - aldri fritekst som kan sitere token", async () => {
    expect(safeVendorCode("channel_not_found")).toBe("channel_not_found");
    expect(safeVendorCode(21610)).toBe("21610");
    expect(safeVendorCode("token xoxb-123 lekket")).toBe("unspecified");
    expect(safeVendorCode(undefined)).toBe("unspecified");
    stub(() => jsonRes({ ok: false, error: "bad token xoxb-1234567890-abcdefghij" }));
    const err = await new SlackAdapter().send(send(), "fake-token-for-test").catch((e: Error) => e);
    expect(err).toBeInstanceOf(ProviderRejectedError);
    expect((err as Error).message).toBe("comms_provider_rejected:slack:unspecified");
  });

  it("mutasjon: 5xx, 3xx, nullstilt socket og tidsavbrudd er UKJENT; DNS-feil og ugyldig URL er «aldri sendt»", async () => {
    stub(() => new Response("nede", { status: 503 }));
    await expectUnknown(providerCall("x", "https://example.com/a", { method: "POST", body: "{}" }, true), "http_503");
    stub(() => new Response(null, { status: 307, headers: { location: "https://example.com/b" } }));
    await expectUnknown(providerCall("x", "https://example.com/a", { method: "POST", body: "{}" }, true), "redirect");
    stub(() => { throw reset; });
    await expectUnknown(providerCall("x", "https://example.com/a", { method: "POST", body: "{}" }, true), "transport_reset");
    stub(() => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); });
    await expectUnknown(providerCall("x", "https://example.com/a", { method: "POST", body: "{}" }, true), "transport_timeout");
    stub(() => { throw dns; });
    await expect(providerCall("x", "https://example.com/a", { method: "POST", body: "{}" }, true)).rejects.toThrow("comms_provider_unreachable:x");
    calls = [];
    await expect(providerCall("x", "https://example.com/../etc", { method: "POST", body: "{}" }, true)).rejects.toThrow("comms_unsafe_request:x");
    expect(calls).toHaveLength(0); // aldri sendt: URL-en avvises FØR fetch
  });

  it("lesing kaster vanlige feil (aldri ukjent utfall), og 429/4xx er et entydig avslag", async () => {
    stub(() => { throw reset; });
    await expect(providerCall("x", "https://example.com/a", {}, false)).rejects.toThrow("comms_provider_unreachable:x");
    stub(() => jsonRes({ ok: false, error: "ratelimited" }, 429));
    const err = await new SlackAdapter().send(send(), "fake-token-for-test").catch((e: Error) => e);
    expect(err).toBeInstanceOf(ProviderRejectedError);
    expect((err as ProviderRejectedError).code).toBe("ratelimited");
  });

  it("credential-referansene er vault-NAVN (ingen verdier) og frys kobles til connector-id-ene", () => {
    for (const ref of Object.values(PROVIDER_CREDENTIAL_REFS)) expect(ref).toMatch(/^JARVIS_[A-Z0-9_]+$/);
    expect(connectorIdsForCredentialRef("JARVIS_SLACK_BOT_TOKEN")).toEqual(["slack"]);
    expect(connectorIdsForCredentialRef("JARVIS_TWILIO_AUTH_TOKEN")).toEqual(["twilio"]);
    expect(connectorIdsForCredentialRef("JARVIS_ANNET")).toEqual([]);
  });
});

describe("B: Slack", () => {
  it("chat.postMessage: Bearer, kanal, tekst, ingen forhåndsvisning av lenker, svar-tråd; meldings-id = ts", async () => {
    stub(() => jsonRes({ ok: true, ts: "1731850000.000200", message: { thread_ts: "1731840000.000100" } }));
    const result = await new SlackAdapter().send(send({ thread_ref: "1731840000.000100" }), "fake-token-for-test");
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(headers(calls[0]!)["authorization"]).toBe("Bearer fake-token-for-test");
    expect(body(calls[0]!)).toMatchObject({ channel: "C0AAAAAAAA", unfurl_links: false, unfurl_media: false, thread_ts: "1731840000.000100" });
    expect(result).toEqual({ provider_message_id: "1731850000.000200", thread_ref: "1731840000.000100" });
  });

  it("WP-G1c g3: {ok:false} med fatal_error/internal_error på en MUTASJON er UKJENT utfall (kan delvis ha lyktes) - aldri et sikkert avslag; alle fem mutasjoner; kun koden i feilen", async () => {
    const slack = new SlackAdapter();
    const target = { account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", target_message_id: "1.2" };
    for (const code of ["fatal_error", "internal_error"]) {
      stub(() => jsonRes({ ok: false, error: code, detail: "xoxb-aldri-i-feilen" }));
      await expectUnknown(slack.send(send(), "t"), `comms_slack_${code}`);
      await expectUnknown(slack.edit({ ...target, text: "rettet" }, "t"), `comms_slack_${code}`);
      await expectUnknown(slack.delete(target, "t"), `comms_slack_${code}`);
      await expectUnknown(slack.react({ ...target, reaction: "thumbsup" }, "t"), `comms_slack_${code}`);
      const err = await slack.send(send(), "t").catch((e: Error) => e);
      expect((err as Error).message).toBe(`outcome_unknown:comms_slack_${code}`);
      expect((err as Error).message).not.toContain("xoxb");
    }
  });

  it("WP-G1c g3: andre {ok:false}-koder er fortsatt entydige avslag (INGEN generell omklassifisering), og en LESING med fatal_error er en vanlig avvisning (ingen effekt å være usikker på)", async () => {
    const slack = new SlackAdapter();
    for (const code of ["channel_not_found", "not_in_channel", "ratelimited", "invalid_auth", "msg_too_long", "is_archived"]) {
      stub(() => jsonRes({ ok: false, error: code }));
      await expect(slack.send(send(), "t"), code).rejects.toThrow(`comms_provider_rejected:slack:${code}`);
    }
    stub(() => jsonRes({ ok: false, error: "fatal_error" }));
    const read = await slack.messageExists({ account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", target_message_id: "1.2" }, "t").catch((e: Error) => e);
    expect((read as Error).message).toBe("comms_provider_rejected:slack:fatal_error");
    expect((read as Error).message.startsWith("outcome_unknown:")).toBe(false);
  });

  it("{ok:false} er et avslag med leverandørkoden; manglende ts og tom kropp er UKJENT", async () => {
    stub(() => jsonRes({ ok: false, error: "channel_not_found" }));
    await expect(new SlackAdapter().send(send(), "t")).rejects.toThrow("comms_provider_rejected:slack:channel_not_found");
    stub(() => jsonRes({ ok: true }));
    await expectUnknown(new SlackAdapter().send(send(), "t"), "no_message_id");
    stub(() => new Response("", { status: 200 }));
    await expectUnknown(new SlackAdapter().send(send(), "t"), "unreadable_response");
    stub(() => new Response("<html>", { status: 200 }));
    await expectUnknown(new SlackAdapter().send(send(), "t"), "unreadable_response");
  });

  it("rediger, slett (allerede borte = OK), reager (allerede reagert = OK), og fersk lesing av målet", async () => {
    const slack = new SlackAdapter();
    stub(() => jsonRes({ ok: true, ts: "1.2" }));
    await slack.edit({ account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", target_message_id: "1.2", text: "rettet" }, "t");
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.update");
    expect(body(calls[0]!)).toMatchObject({ channel: "C0AAAAAAAA", ts: "1.2", text: "rettet" });
    stub(() => jsonRes({ ok: false, error: "message_not_found" }));
    await expect(slack.delete({ account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", target_message_id: "1.2" }, "t")).resolves.toBeUndefined();
    stub(() => jsonRes({ ok: false, error: "already_reacted" }));
    await expect(slack.react({ account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", target_message_id: "1.2", reaction: ":thumbsup:" }, "t")).resolves.toBeUndefined();
    expect(body(calls[0]!)).toMatchObject({ name: "thumbsup", timestamp: "1.2" });
    await expect(slack.react({ account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", target_message_id: "1.2", reaction: "Ugyldig Navn" }, "t")).rejects.toThrow("invalid_reaction_name");
    stub(() => jsonRes({ ok: true, messages: [{ ts: "1.2" }] }));
    expect(await slack.messageExists({ account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", target_message_id: "1.2" }, "t")).toBe(true);
    stub(() => jsonRes({ ok: true, messages: [{ ts: "9.9" }] }));
    expect(await slack.messageExists({ account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", target_message_id: "1.2" }, "t")).toBe(false);
    stub(() => jsonRes({ ok: true, messages: [] }));
    expect(await slack.messageExists({ account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", target_message_id: "1.2" }, "t")).toBe(false);
  });
});

describe("C: Discord", () => {
  it("opprett: Bot-auth, omtale-parsing er ALLTID av, svar via message_reference, id fra svaret", async () => {
    stub(() => jsonRes({ id: "123456789012345999" }, 200));
    const r = await new DiscordAdapter().send(send({ recipient: "123456789012345678", thread_ref: "123456789012345001", text: "hei @everyone" }), "fake-token-for-test");
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/123456789012345678/messages");
    expect(headers(calls[0]!)["authorization"]).toBe("Bot fake-token-for-test");
    expect(body(calls[0]!)).toMatchObject({ allowed_mentions: { parse: [] }, message_reference: { message_id: "123456789012345001" } });
    expect(r.provider_message_id).toBe("123456789012345999");
  });

  it("slett: 404 «Unknown Message» = allerede borte; andre avslag har leverandørkoden; lesing av målet", async () => {
    const d = new DiscordAdapter();
    stub(() => jsonRes({ code: 10008, message: "Unknown Message" }, 404));
    await expect(d.delete({ account_ref: "123456789012345678", recipient: "123456789012345678", target_message_id: "123456789012345001" }, "t")).resolves.toBeUndefined();
    stub(() => jsonRes({ code: 50013, message: "Missing Permissions" }, 403));
    await expect(d.delete({ account_ref: "123456789012345678", recipient: "123456789012345678", target_message_id: "123456789012345001" }, "t")).rejects.toThrow("comms_provider_rejected:discord:50013");
    stub(() => jsonRes({ code: 10008 }, 404));
    expect(await d.messageExists({ account_ref: "g", recipient: "123456789012345678", target_message_id: "123456789012345001" }, "t")).toBe(false);
    stub(() => jsonRes({ id: "123456789012345001" }));
    expect(await d.messageExists({ account_ref: "g", recipient: "123456789012345678", target_message_id: "123456789012345001" }, "t")).toBe(true);
  });

  it("reaksjon URL-koder emojien; stier med .. avvises før noe sendes", async () => {
    stub(() => new Response(null, { status: 204 }));
    await new DiscordAdapter().react({ account_ref: "g", recipient: "123456789012345678", target_message_id: "123456789012345001", reaction: "👍" }, "t");
    expect(calls[0]!.url).toBe(`https://discord.com/api/v10/channels/123456789012345678/messages/123456789012345001/reactions/${encodeURIComponent("👍")}/@me`);
    expect(calls[0]!.init.method).toBe("PUT");
    calls = [];
    await expect(new DiscordAdapter().send(send({ recipient: ".." }), "t")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("D: WhatsApp Business (Meta Cloud API)", () => {
  const wa = () => new WhatsAppAdapter("v25.0");
  const target = { account_ref: "109876543210", recipient: "+4790000000" };

  it("tekst, mal og media: riktig meldingskonvolutt, riktig avsender-id i stien og Bearer", async () => {
    stub(() => jsonRes({ messages: [{ id: "wamid.AAA" }] }));
    const t = await wa().send({ ...target, text: "Hei", template: null, media: null, thread_ref: null }, "fake-token-for-test");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v25.0/109876543210/messages");
    expect(headers(calls[0]!)["authorization"]).toBe("Bearer fake-token-for-test");
    expect(body(calls[0]!)).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "+4790000000", type: "text", text: { body: "Hei", preview_url: false } });
    expect(t.provider_message_id).toBe("wamid.AAA");
    await wa().send({ ...target, text: null, template: { name: "ai_hello", language: "nb", params: ["Kari"] }, media: null, thread_ref: null }, "t");
    expect(body(calls[1]!)).toMatchObject({ type: "template", template: { name: "ai_hello", language: { code: "nb" }, components: [{ type: "body", parameters: [{ type: "text", text: "Kari" }] }] } });
    await wa().send({ ...target, text: "Se bildet", template: null, media: { kind: "image", url: "https://cdn.example.com/a.png" }, thread_ref: null }, "t");
    expect(body(calls[2]!)).toMatchObject({ type: "image", image: { link: "https://cdn.example.com/a.png", caption: "Se bildet" } });
  });

  it("feil: leverandørkode fra error.code, manglende id er UKJENT, og reaksjon bruker reaction-typen", async () => {
    stub(() => jsonRes({ error: { code: 131047, message: "Re-engagement message" } }, 400));
    await expect(wa().send({ ...target, text: "Hei", template: null, media: null, thread_ref: null }, "t")).rejects.toThrow("comms_provider_rejected:whatsapp:131047");
    stub(() => jsonRes({ messages: [] }));
    await expectUnknown(wa().send({ ...target, text: "Hei", template: null, media: null, thread_ref: null }, "t"), "no_message_id");
    stub(() => jsonRes({ messages: [{ id: "wamid.R" }] }));
    await wa().react({ ...target, target_message_id: "wamid.AAA", reaction: "👍" }, "t");
    expect(body(calls[0]!)).toMatchObject({ type: "reaction", reaction: { message_id: "wamid.AAA", emoji: "👍" } });
  });
});

describe("E: SMS - Twilio og Telnyx", () => {
  it("Twilio: Basic-auth med AccountSid:AuthToken, From = den allowlistede kontoen, form-kropp; sid er meldings-id", async () => {
    stub(() => jsonRes({ sid: "SM123" }, 201));
    const r = await new TwilioSmsAdapter(async () => "AC1234567890abcdef").send({ account_ref: "+4791000000", recipient: "+4790000000", text: "Hei", template: null, media: null, thread_ref: null }, "fake-token-for-test");
    expect(calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1234567890abcdef/Messages.json");
    expect(headers(calls[0]!)["authorization"]).toBe(`Basic ${Buffer.from("AC1234567890abcdef:fake-token-for-test").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({ To: "+4790000000", From: "+4791000000", Body: "Hei" });
    expect(r.provider_message_id).toBe("SM123");
  });

  it("Twilio: feil 21610 (avmeldt mottaker) er et avslag med kode 21610; manglende konto-sid er en vanlig feil uten nettkall; manglende sid i svaret er UKJENT", async () => {
    stub(() => jsonRes({ code: 21610, message: "unsubscribed" }, 400));
    const t = new TwilioSmsAdapter(async () => "AC1234567890abcdef");
    const err = await t.send({ account_ref: "+4791000000", recipient: "+4790000000", text: "Hei", template: null, media: null, thread_ref: null }, "t").catch((e: Error) => e);
    expect(err).toBeInstanceOf(ProviderRejectedError);
    expect((err as ProviderRejectedError).code).toBe("21610");
    calls = [];
    await expect(new TwilioSmsAdapter(async () => null).send({ account_ref: "+4791000000", recipient: "+4790000000", text: "Hei", template: null, media: null, thread_ref: null }, "t")).rejects.toThrow("comms_twilio_account_sid_not_configured");
    expect(calls).toHaveLength(0);
    stub(() => jsonRes({}, 201));
    await expectUnknown(t.send({ account_ref: "+4791000000", recipient: "+4790000000", text: "Hei", template: null, media: null, thread_ref: null }, "t"), "no_message_id");
  });

  it("Telnyx: POST /v2/messages med from/to/text og Bearer; errors[0].code ved avslag; manglende id er UKJENT", async () => {
    stub(() => jsonRes({ data: { id: "tx-1" } }, 200));
    const r = await new TelnyxSmsAdapter().send({ account_ref: "+4791000000", recipient: "+4790000000", text: "Hei", template: null, media: null, thread_ref: null }, "fake-key-for-test");
    expect(calls[0]!.url).toBe("https://api.telnyx.com/v2/messages");
    expect(headers(calls[0]!)["authorization"]).toBe("Bearer fake-key-for-test");
    expect(body(calls[0]!)).toEqual({ from: "+4791000000", to: "+4790000000", text: "Hei" });
    expect(r.provider_message_id).toBe("tx-1");
    stub(() => jsonRes({ errors: [{ code: "40300", title: "forbidden" }] }, 403));
    await expect(new TelnyxSmsAdapter().send({ account_ref: "+4791000000", recipient: "+4790000000", text: "Hei", template: null, media: null, thread_ref: null }, "t")).rejects.toThrow("comms_provider_rejected:telnyx:40300");
    stub(() => jsonRes({ data: {} }, 200));
    await expectUnknown(new TelnyxSmsAdapter().send({ account_ref: "+4791000000", recipient: "+4790000000", text: "Hei", template: null, media: null, thread_ref: null }, "t"), "no_message_id");
  });
});

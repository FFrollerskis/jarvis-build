import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-314. WhatsApp Business Cloud API (Meta Graph API). `phone_number_id` er
 * Jarvis sin EGEN avsenderidentitet (SAMME rolle som Telegram sin `chat_id`),
 * injisert som en resolver-closure. `notify` navngitt IDENTISK med
 * Slack/Discord/Telegram sin send-melding-handling.
 */
describe("A: WhatsAppTransport.invoke('get_phone_number_info', ...) - GET /{phone_number_id}, ren lesing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med Bearer-header mot riktig avsendernummer-id", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ display_phone_number: "+15551234567", verified_name: "Jarvis" }) } as unknown as Response;
    });
    const transport = new WhatsAppTransport(async () => "1234567890");
    const result = await transport.invoke("get_phone_number_info", {}, "test-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v20.0/1234567890?fields=display_phone_number,verified_name");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer test-token" });
    expect(result.data).toEqual({ display_phone_number: "+15551234567", verified_name: "Jarvis" });
  });

  it("manglende phone_number_id kaster 'whatsapp_phone_number_id_not_configured' - IKKE et fetch-kall gjøres", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new WhatsAppTransport(async () => null);
    await expect(transport.invoke("get_phone_number_info", {}, "test-token")).rejects.toThrow("whatsapp_phone_number_id_not_configured");
    expect(calls).toHaveLength(0);
  });

  it("en HTTP-feil kaster 'whatsapp_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new WhatsAppTransport(async () => "1234567890");
    await expect(transport.invoke("get_phone_number_info", {}, "bad-token")).rejects.toThrow("whatsapp_error_401");
  });
});

describe("B: WhatsAppTransport.invoke('notify', ...) - POST /{phone_number_id}/messages, D-41 ekte skrivehandling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sender en tekstmelding med riktig meldingskonvolutt", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ messages: [{ id: "wamid.abc123" }] }) } as unknown as Response;
    });
    const transport = new WhatsAppTransport(async () => "1234567890");
    const result = await transport.invoke("notify", { to: "+15559876543", message: "Hei fra Jarvis" }, "test-token");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v20.0/1234567890/messages");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      messaging_product: "whatsapp", to: "+15559876543", type: "text", text: { body: "Hei fra Jarvis" }
    });
    expect(result.external_id).toBe("wamid.abc123");
  });
});

describe("C: en ukjent handling kaster 'whatsapp_unsupported_action_<action>'", () => {
  it("invoke('delete_message', ...) kaster (ikke registrert)", async () => {
    const transport = new WhatsAppTransport(async () => "1234567890");
    await expect(transport.invoke("delete_message", {}, "test-token")).rejects.toThrow("whatsapp_unsupported_action_delete_message");
  });
});

describe("D: firstWaveTools() registrerer whatsapp.get_phone_number_info som klasse A og whatsapp.notify som klasse B", () => {
  it("get_phone_number_info er klasse A (ren lesing), notify er klasse B (ekte skrivehandling, D-41)", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "whatsapp");
    expect(tools.map((t) => t.action).sort()).toEqual(["get_phone_number_info", "notify"]);
    const phoneNumberInfo = tools.find((t) => t.action === "get_phone_number_info")!;
    expect(phoneNumberInfo.capability_class).toBe("A");
    expect(phoneNumberInfo.credential_ref).toBe("JARVIS_WHATSAPP_TOKEN");
    expect(phoneNumberInfo.output_trust).toBe("untrusted");
    expect(phoneNumberInfo.idempotent_external).toBe(true);
    const notify = tools.find((t) => t.action === "notify")!;
    expect(notify.capability_class).toBe("B");
    expect(notify.credential_ref).toBe("JARVIS_WHATSAPP_TOKEN");
    expect(notify.reversible).toBe(true);
    expect(notify.idempotent_external).toBe(false);
  });
});

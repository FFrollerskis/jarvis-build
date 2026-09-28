import { afterEach, describe, expect, it, vi } from "vitest";
import { TelnyxTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-321. Telnyx sitt REST-API v2 - `Authorization: Bearer <api_key>` (ETT
 * enkelt API-nøkkel, IKKE Twilio sin to-delte AccountSid/AuthToken-modell),
 * `from`-nummer injisert via en resolver-closure (SAMME mønster som Twilio
 * sin `fromNumber`, D-295) siden `credential_ref` er singular men Telnyx
 * krever en fast avsenderidentitet for å sende. Strukturelt en ordinær
 * meldingsleverandør-connector (SAMME kategori som Twilio), IKKE en
 * SpeechAdapter - se `TelnyxTransport` sin doc-kommentar i
 * `live-transports.ts` for full D-64-begrunnelse.
 */
describe("A: TelnyxTransport.invoke('notify', ...) - POST /v2/messages, ekte sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTer til /v2/messages med Bearer-header og {from,to,text}-JSON-kropp", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ data: { id: "msg-123abc" } }) } as unknown as Response;
    });
    const transport = new TelnyxTransport(() => Promise.resolve("+15550001111"));
    const result = await transport.invoke("notify", { to: "+15559998888", message: "hei" }, "api-key-xyz");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.telnyx.com/v2/messages");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer api-key-xyz", "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ from: "+15550001111", to: "+15559998888", text: "hei" });
    expect(result.external_id).toBe("msg-123abc");
  });

  it("mangler from-nummer -> kaster 'telnyx_from_number_not_configured' UTEN å kalle fetch", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new TelnyxTransport(() => Promise.resolve(null));
    await expect(transport.invoke("notify", { to: "+1", message: "hei" }, "tok")).rejects.toThrow("telnyx_from_number_not_configured");
    expect(calls).toHaveLength(0);
  });

  it("manglende data.id i svaret -> external_id defaulter til 'sent'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    const transport = new TelnyxTransport(() => Promise.resolve("+1"));
    const result = await transport.invoke("notify", { to: "+1", message: "hei" }, "tok");
    expect(result.external_id).toBe("sent");
  });

  it("en HTTP-feil kaster 'telnyx_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new TelnyxTransport(() => Promise.resolve("+1"));
    await expect(transport.invoke("notify", { to: "+1", message: "hei" }, "bad-key")).rejects.toThrow("telnyx_error_401");
  });
});

describe("B: TelnyxTransport.invoke('get_account_info', ...) - GET /v2/balance, INGEN sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller GET /v2/balance og returnerer data-feltet", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ data: { balance: "10.50", currency: "USD" } }) } as unknown as Response;
    });
    const transport = new TelnyxTransport(() => Promise.resolve("+1"));
    const result = await transport.invoke("get_account_info", {}, "tok");
    expect(calls[0]).toBe("https://api.telnyx.com/v2/balance");
    expect(result.data).toEqual({ balance: "10.50", currency: "USD" });
  });

  it("bruker Bearer-header, ikke Basic (strukturelt ulik Twilio)", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, json: async () => ({ data: {} }) } as unknown as Response;
    });
    const transport = new TelnyxTransport(() => Promise.resolve("+1"));
    await transport.invoke("get_account_info", {}, "my-api-key");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer my-api-key" });
  });
});

describe("C: en ukjent handling kaster 'telnyx_unsupported_action_<action>'", () => {
  it("invoke('read_messages', ...) kaster (BEVISST DEFERRED, ikke bygget denne sliceen)", async () => {
    await expect(new TelnyxTransport(() => Promise.resolve("+1")).invoke("read_messages", {}, "tok")).rejects.toThrow("telnyx_unsupported_action_read_messages");
  });
});

describe("D: firstWaveTools() registrerer begge telnyx.*-handlinger med korrekt risikoklasse", () => {
  it("telnyx.notify er klasse B (reell sideeffekt)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "telnyx" && t.action === "notify");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("B");
    expect(tool!.credential_ref).toBe("JARVIS_TELNYX_API_KEY");
  });

  it("telnyx.get_account_info er klasse A (lesing)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "telnyx" && t.action === "get_account_info");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("A");
  });
});

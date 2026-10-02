import { afterEach, describe, expect, it, vi } from "vitest";
import { TwilioTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-295 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - tredje slice). Twilio sitt offisielle REST API - `Basic`-
 * autentisering (AccountSid:AuthToken, base64), `AccountSid` i URL-stien,
 * `From`-nummer injisert via en resolver-closure (SAMME mønster som
 * Telegram sin `chat_id`, D-247) siden `credential_ref` er singular men
 * Twilio krever tre faste verdier for å sende.
 */
describe("A: TwilioTransport.invoke('notify', ...) - POST /Messages.json, ekte sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTer til /Accounts/{sid}/Messages.json med Basic-header og {To,From,Body}-formkropp", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ sid: "SM123abc" }) } as unknown as Response;
    });
    const transport = new TwilioTransport(
      () => Promise.resolve("AC-test-sid"),
      () => Promise.resolve("+15550001111")
    );
    const result = await transport.invoke("notify", { to: "+15559998888", message: "hei" }, "auth-token-xyz");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC-test-sid/Messages.json");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: `Basic ${Buffer.from("AC-test-sid:auth-token-xyz").toString("base64")}` });
    const params = new URLSearchParams(String(calls[0]!.init?.body));
    expect(params.get("To")).toBe("+15559998888");
    expect(params.get("From")).toBe("+15550001111");
    expect(params.get("Body")).toBe("hei");
    expect(result.external_id).toBe("SM123abc");
  });

  it("mangler From-nummer -> kaster 'twilio_from_number_not_configured' UTEN å kalle fetch", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new TwilioTransport(() => Promise.resolve("AC-x"), () => Promise.resolve(null));
    await expect(transport.invoke("notify", { to: "+15550000001", message: "hei" }, "tok")).rejects.toThrow("twilio_from_number_not_configured");
    expect(calls).toHaveLength(0);
  });

  it("mangler AccountSid -> kaster 'twilio_account_sid_not_configured'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    const transport = new TwilioTransport(() => Promise.resolve(null), () => Promise.resolve("+1"));
    await expect(transport.invoke("notify", { to: "+15550000001", message: "hei" }, "tok")).rejects.toThrow("twilio_account_sid_not_configured");
  });

  it("en HTTP-feil kaster 'twilio_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new TwilioTransport(() => Promise.resolve("AC-x"), () => Promise.resolve("+1"));
    await expect(transport.invoke("notify", { to: "+15550000001", message: "hei" }, "bad-token")).rejects.toThrow("twilio_error_401");
  });
});

describe("B: TwilioTransport.invoke('get_account_info', ...) - GET /Accounts/{sid}.json, INGEN sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller GET /Accounts/{sid}.json og returnerer hele svaret som data", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ sid: "AC-test-sid", status: "active" }) } as unknown as Response;
    });
    const transport = new TwilioTransport(() => Promise.resolve("AC-test-sid"), () => Promise.resolve("+1"));
    const result = await transport.invoke("get_account_info", {}, "tok");
    expect(calls[0]).toBe("https://api.twilio.com/2010-04-01/Accounts/AC-test-sid.json");
    expect(result.data).toMatchObject({ sid: "AC-test-sid", status: "active" });
  });
});

describe("C: TwilioTransport.invoke('read_messages', ...) - GET-lesing, aldri en sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET /Messages.json?PageSize=..., returnerer 'messages'-arrayet", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ messages: [{ sid: "SM1", body: "hei" }] }) } as unknown as Response;
    });
    const transport = new TwilioTransport(() => Promise.resolve("AC-x"), () => Promise.resolve("+1"));
    const result = await transport.invoke("read_messages", { limit: 5 }, "tok");
    expect(calls[0]).toBe("https://api.twilio.com/2010-04-01/Accounts/AC-x/Messages.json?PageSize=5");
    expect(result.data).toEqual([{ sid: "SM1", body: "hei" }]);
  });

  it("uten 'limit' utelater query-parameteret helt", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({ messages: [] }) } as unknown as Response; });
    await new TwilioTransport(() => Promise.resolve("AC-x"), () => Promise.resolve("+1")).invoke("read_messages", {}, "tok");
    expect(calls[0]).toBe("https://api.twilio.com/2010-04-01/Accounts/AC-x/Messages.json");
  });
});

describe("D: en ukjent handling kaster 'twilio_unsupported_action_<action>'", () => {
  it("invoke('delete_message', ...) kaster", async () => {
    await expect(new TwilioTransport(() => Promise.resolve("AC-x"), () => Promise.resolve("+1")).invoke("delete_message", {}, "tok")).rejects.toThrow("twilio_unsupported_action_delete_message");
  });
});

describe("E: firstWaveTools() registrerer alle tre twilio.*-handlinger med korrekt risikoklasse", () => {
  it("twilio.notify er klasse C (betalt SMS, Del 3)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "twilio" && t.action === "notify");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("C");
    expect(tool!.credential_ref).toBe("JARVIS_TWILIO_AUTH_TOKEN");
  });

  it("twilio.get_account_info/read_messages er begge klasse A (lesing)", () => {
    const tools = firstWaveTools();
    for (const action of ["get_account_info", "read_messages"]) {
      const tool = tools.find((t) => t.tool_id === "twilio" && t.action === action);
      expect(tool, `twilio.${action} skal finnes`).toBeDefined();
      expect(tool!.capability_class).toBe("A");
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-292 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - første konkrete slice). Slack Web API - offisielt
 * dokumenterte endepunkter (chat.postMessage/auth.test/conversations.list/
 * conversations.history), `Authorization: Bearer <token>`-header, og
 * Slack sin egen `{ok: boolean, error?: string}`-svarkonvolutt som MÅ
 * sjekkes eksplisitt (200 OK selv ved logisk feil).
 */
describe("A: SlackTransport.invoke('notify', ...) - chat.postMessage, ekte sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTer til chat.postMessage med Bearer-header og {channel, text}-kropp", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true, ts: "1234.5678" }) } as unknown as Response;
    });
    const transport = new SlackTransport();
    const result = await transport.invoke("notify", { channel: "#general", message: "hei" }, "xoxb-test-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer xoxb-test-token" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ channel: "#general", text: "hei" });
    expect(result.external_id).toBe("1234.5678");
  });

  it("Slack sin egen {ok: false, error} i en 200 OK-respons kastes som en feil - response.ok alene er IKKE nok", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ ok: false, error: "channel_not_found" }) }) as unknown as Response);
    const transport = new SlackTransport();
    await expect(transport.invoke("notify", { channel: "#nope", message: "hei" }, "tok")).rejects.toThrow("slack_error_channel_not_found");
  });

  it("en HTTP-feil kaster 'slack_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new SlackTransport();
    await expect(transport.invoke("notify", { channel: "#x", message: "hei" }, "bad-token")).rejects.toThrow("slack_error_401");
  });
});

describe("B: SlackTransport.invoke('get_bot_info', ...) - auth.test, INGEN sideeffekt, trygg tilkoblingstest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller auth.test og returnerer hele svaret som data", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ ok: true, user: "jarvis_bot", user_id: "U123", team: "Acme" }) } as unknown as Response;
    });
    const transport = new SlackTransport();
    const result = await transport.invoke("get_bot_info", {}, "tok");
    expect(calls[0]).toBe("https://slack.com/api/auth.test");
    expect(result.data).toMatchObject({ user: "jarvis_bot", user_id: "U123" });
  });
});

describe("C: SlackTransport.invoke('list_channels'/'read_channel_history', ...) - GET-lesing, aldri en sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("list_channels: GET conversations.list, ingen kropp, returnerer 'channels'-arrayet", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true, channels: [{ id: "C1", name: "general" }] }) } as unknown as Response;
    });
    const transport = new SlackTransport();
    const result = await transport.invoke("list_channels", {}, "tok");
    expect(calls[0]!.url).toBe("https://slack.com/api/conversations.list?");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(result.data).toEqual([{ id: "C1", name: "general" }]);
  });

  it("read_channel_history: GET conversations.history?channel=..., returnerer 'messages'-arrayet", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ ok: true, messages: [{ text: "hei" }] }) } as unknown as Response;
    });
    const transport = new SlackTransport();
    const result = await transport.invoke("read_channel_history", { channel: "C1", limit: 10 }, "tok");
    expect(calls[0]).toBe("https://slack.com/api/conversations.history?channel=C1&limit=10");
    expect(result.data).toEqual([{ text: "hei" }]);
  });

  it("read_channel_history uten 'limit' utelater parameteret helt (ikke en 'undefined'-streng)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ ok: true, messages: [] }) } as unknown as Response;
    });
    await new SlackTransport().invoke("read_channel_history", { channel: "C1" }, "tok");
    expect(calls[0]).toBe("https://slack.com/api/conversations.history?channel=C1");
  });
});

describe("D: en ukjent handling kaster 'slack_unsupported_action_<action>'", () => {
  it("invoke('delete_message', ...) kaster", async () => {
    await expect(new SlackTransport().invoke("delete_message", {}, "tok")).rejects.toThrow("slack_unsupported_action_delete_message");
  });
});

describe("E: firstWaveTools() registrerer alle fire slack.*-handlinger med korrekt risikoklasse", () => {
  it("slack.notify er klasse B (reell sideeffekt)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "slack" && t.action === "notify");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("B");
    expect(tool!.credential_ref).toBe("JARVIS_SLACK_BOT_TOKEN");
  });

  it("slack.get_bot_info/list_channels/read_channel_history er alle klasse A (lesing)", () => {
    const tools = firstWaveTools();
    for (const action of ["get_bot_info", "list_channels", "read_channel_history"]) {
      const tool = tools.find((t) => t.tool_id === "slack" && t.action === action);
      expect(tool, `slack.${action} skal finnes`).toBeDefined();
      expect(tool!.capability_class).toBe("A");
    }
  });
});

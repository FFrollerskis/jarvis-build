import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-294 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - andre slice). Discord sitt offisielle REST API v10 - ULIK
 * Slack: en suksess-respons ER selve ressurs-JSON-en direkte (INGEN
 * `{ok, error}`-konvolutt), og en feil kommer som en EKTE HTTP-feilstatus.
 * `Authorization: Bot <token>`-header på alle kall.
 */
describe("A: DiscordTransport.invoke('notify', ...) - POST /channels/{id}/messages, ekte sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTer til /channels/{channel_id}/messages med Bot-header og {content}-kropp", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ id: "999888777" }) } as unknown as Response;
    });
    const transport = new DiscordTransport();
    const result = await transport.invoke("notify", { channel_id: "111", message: "hei" }, "discord-test-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/111/messages");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bot discord-test-token" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ content: "hei" });
    expect(result.external_id).toBe("999888777");
  });

  it("en HTTP-feil kaster 'discord_error_<status>' - INGEN {ok,error}-konvolutt å sjekke, i motsetning til Slack", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 403 }) as unknown as Response);
    const transport = new DiscordTransport();
    await expect(transport.invoke("notify", { channel_id: "1", message: "hei" }, "bad-token")).rejects.toThrow("discord_error_403");
  });
});

describe("B: DiscordTransport.invoke('get_bot_info', ...) - GET /users/@me, INGEN sideeffekt, trygg tilkoblingstest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller GET /users/@me og returnerer hele svaret som data", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ id: "42", username: "jarvis_bot" }) } as unknown as Response;
    });
    const transport = new DiscordTransport();
    const result = await transport.invoke("get_bot_info", {}, "tok");
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/users/@me");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bot tok" });
    expect(result.data).toMatchObject({ id: "42", username: "jarvis_bot" });
  });
});

describe("C: DiscordTransport.invoke('list_channels'/'read_channel_history', ...) - GET-lesing, aldri en sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("list_channels: GET /guilds/{guild_id}/channels, returnerer hele arrayet", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => [{ id: "C1", name: "general" }] } as unknown as Response;
    });
    const transport = new DiscordTransport();
    const result = await transport.invoke("list_channels", { guild_id: "G1" }, "tok");
    expect(calls[0]).toBe("https://discord.com/api/v10/guilds/G1/channels");
    expect(result.data).toEqual([{ id: "C1", name: "general" }]);
  });

  it("read_channel_history: GET /channels/{channel_id}/messages?limit=..., returnerer arrayet", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => [{ content: "hei" }] } as unknown as Response;
    });
    const transport = new DiscordTransport();
    const result = await transport.invoke("read_channel_history", { channel_id: "C1", limit: 10 }, "tok");
    expect(calls[0]).toBe("https://discord.com/api/v10/channels/C1/messages?limit=10");
    expect(result.data).toEqual([{ content: "hei" }]);
  });

  it("read_channel_history uten 'limit' utelater query-parameteret helt", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => [] } as unknown as Response;
    });
    await new DiscordTransport().invoke("read_channel_history", { channel_id: "C1" }, "tok");
    expect(calls[0]).toBe("https://discord.com/api/v10/channels/C1/messages");
  });
});

describe("D: en ukjent handling kaster 'discord_unsupported_action_<action>'", () => {
  it("invoke('delete_message', ...) kaster", async () => {
    await expect(new DiscordTransport().invoke("delete_message", {}, "tok")).rejects.toThrow("discord_unsupported_action_delete_message");
  });
});

describe("E: firstWaveTools() registrerer alle fire discord.*-handlinger med korrekt risikoklasse", () => {
  it("discord.notify er klasse C (utgående melding, Del 3)", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "discord" && t.action === "notify");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("C");
    expect(tool!.credential_ref).toBe("JARVIS_DISCORD_BOT_TOKEN");
  });

  it("discord.get_bot_info/list_channels/read_channel_history er alle klasse A (lesing)", () => {
    const tools = firstWaveTools();
    for (const action of ["get_bot_info", "list_channels", "read_channel_history"]) {
      const tool = tools.find((t) => t.tool_id === "discord" && t.action === action);
      expect(tool, `discord.${action} skal finnes`).toBeDefined();
      expect(tool!.capability_class).toBe("A");
    }
  });
});

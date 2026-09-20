import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * Task #122 (D-213): `telegram.get_bot_info` - lagt til SPESIFIKT som en
 * trygg `live_test`-kandidat for Telegram (`notify` sender en EKTE melding
 * og kunne derfor aldri vært det). Ren Bot API `getMe` - ingen `chat_id`,
 * ingen sideeffekt.
 */
describe("A: TelegramTransport.invoke('get_bot_info', ...) - Bot API getMe, ingen sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller https://api.telegram.org/bot<token>/getMe (GET, ingen kropp) og returnerer 'result' som data", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ result: { id: 12345, is_bot: true, username: "jarvis_bot" } }) } as unknown as Response;
    });
    const transport = new TelegramTransport("irrelevant-chat-id");
    const result = await transport.invoke("get_bot_info", {}, "test-bot-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bottest-bot-token/getMe");
    expect(calls[0]!.init).toBeUndefined();
    expect(result.data).toEqual({ id: 12345, is_bot: true, username: "jarvis_bot" });
  });

  it("virker UTEN en konfigurert chat_id - get_bot_info spør aldri om chat_id, i motsetning til 'notify'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ result: { id: 1 } }) }) as unknown as Response);
    const transport = new TelegramTransport(undefined);
    await expect(transport.invoke("get_bot_info", {}, "tok")).resolves.toBeDefined();
  });

  it("en HTTP-feil kaster 'telegram_error_<status>', samme feilform som 'notify'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new TelegramTransport("chat-id");
    await expect(transport.invoke("get_bot_info", {}, "bad-token")).rejects.toThrow("telegram_error_401");
  });

  it("'notify' er UENDRET - fortsatt den ENESTE handlingen som faktisk sender en melding", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({ result: { message_id: 42 } }) } as unknown as Response; });
    const transport = new TelegramTransport("chat-id");
    await transport.invoke("notify", { message: "hei" }, "tok");
    expect(calls[0]).toContain("/sendMessage");
  });
});

describe("B: firstWaveTools() registrerer telegram.get_bot_info som klasse A", () => {
  it("tool_id='telegram', action='get_bot_info', capability_class='A'", () => {
    const tools = firstWaveTools();
    const tool = tools.find((t) => t.tool_id === "telegram" && t.action === "get_bot_info");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("A");
    expect(tool!.credential_ref).toBe("JARVIS_TELEGRAM_TOKEN");
  });

  it("telegram.notify forblir UENDRET klasse B (reell sideeffekt)", () => {
    const tools = firstWaveTools();
    const tool = tools.find((t) => t.tool_id === "telegram" && t.action === "notify");
    expect(tool!.capability_class).toBe("B");
  });
});

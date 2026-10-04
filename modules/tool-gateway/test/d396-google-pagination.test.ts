import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailTransport, GoogleCalendarTransport, googleAccessToken, resetGoogleAccessTokenCache } from "@jarvis/tool-gateway";

/**
 * D-396 (JARVIS-047, fase A): Gmail/Calendar følger `nextPageToken` (tidligere stille avkuttet etter første side), melder `truncated`/`skipped`,
 * og Google-access-tokenet caches (én utveksling per ~time i stedet for én per kall).
 */
const originalFetch = global.fetch;
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let urls: string[];
let tokenExchanges: number;
let handler: (url: string) => Response;

beforeEach(() => {
  urls = [];
  tokenExchanges = 0;
  resetGoogleAccessTokenCache();
  process.env["JARVIS_GOOGLE_CLIENT_ID"] = "id";
  process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "secret";
  global.fetch = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      tokenExchanges++;
      return json(200, { access_token: "tok", expires_in: 3600 });
    }
    urls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
});
afterEach(() => { global.fetch = originalFetch; });

const msg = (id: string) => ({ id, threadId: `t-${id}`, internalDate: "1700000000000", payload: { headers: [{ name: "Subject", value: id }], mimeType: "text/plain", body: { data: "" } } });

describe("Gmail list_messages", () => {
  it("følger nextPageToken til max er nådd og melder truncated når det fantes mer", async () => {
    handler = (url) => {
      if (url.includes("/messages?")) {
        return url.includes("pageToken=p2")
          ? json(200, { messages: [{ id: "m3" }, { id: "m4" }], nextPageToken: "p3" })
          : json(200, { messages: [{ id: "m1" }, { id: "m2" }], nextPageToken: "p2" });
      }
      return json(200, msg(url.split("/messages/")[1]!.split("?")[0]!));
    };
    const result = await new GmailTransport("a@b.no").invoke("list_messages", { max: 4 }, "rt");
    const data = result.data as { messages: Array<{ id: string }>; truncated: boolean; skipped: number };
    expect(data.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(data.truncated).toBe(true);
    expect(data.skipped).toBe(0);
  });

  it("truncated=false når postkassen er uttømt, og mislykkede meldingshentinger telles som skipped (ikke stille tapt)", async () => {
    handler = (url) => {
      if (url.includes("/messages?")) return json(200, { messages: [{ id: "ok" }, { id: "bad" }] });
      return url.includes("/messages/bad") ? json(500, {}) : json(200, msg("ok"));
    };
    const data = (await new GmailTransport("a@b.no").invoke("list_messages", { max: 10 }, "rt")).data as { messages: unknown[]; truncated: boolean; skipped: number };
    expect(data.messages).toHaveLength(1);
    expect(data.skipped).toBe(1);
    expect(data.truncated).toBe(false);
  });

  it("max klemmes til et hardt tak (200) - ingen ubegrenset skann", async () => {
    handler = (url) => (url.includes("/messages?") ? json(200, { messages: [] }) : json(200, msg("x")));
    await new GmailTransport("a@b.no").invoke("list_messages", { max: 100000 }, "rt");
    expect(urls[0]).toContain("maxResults=100");
  });
});

describe("Calendar", () => {
  it("list_events følger nextPageToken og melder truncated", async () => {
    const ev = (id: string) => ({ id, summary: id, start: { dateTime: "2026-10-05T10:00:00Z" }, end: { dateTime: "2026-10-05T11:00:00Z" } });
    handler = (url) =>
      url.includes("pageToken=n2") ? json(200, { items: [ev("e3")] }) : json(200, { items: [ev("e1"), ev("e2")], nextPageToken: "n2" });
    const data = (await new GoogleCalendarTransport("a@b.no").invoke("list_events", { from: "2026-10-05T00:00:00Z", to: "2026-10-06T00:00:00Z", max: 10 }, "rt")).data as { events: unknown[]; truncated: boolean };
    expect(data.events).toHaveLength(3);
    expect(data.truncated).toBe(false);

    handler = () => json(200, { items: [ev("e1"), ev("e2")], nextPageToken: "more" });
    const cut = (await new GoogleCalendarTransport("a@b.no").invoke("read_events", { from: "a", to: "b", max: 2 }, "rt")).data as { events: unknown[]; truncated: boolean };
    expect(cut.events).toHaveLength(2);
    expect(cut.truncated).toBe(true);
  });
});

describe("googleAccessToken-cache", () => {
  it("gjenbruker access-tokenet mellom kall og deler en pågående utveksling; feil caches ikke", async () => {
    await Promise.all([googleAccessToken("rt-a"), googleAccessToken("rt-a"), googleAccessToken("rt-a")]);
    await googleAccessToken("rt-a");
    expect(tokenExchanges).toBe(1);
    await googleAccessToken("rt-b");
    expect(tokenExchanges).toBe(2);

    resetGoogleAccessTokenCache();
    global.fetch = vi.fn(async () => json(400, { error: "invalid_grant" })) as unknown as typeof fetch;
    await expect(googleAccessToken("rt-bad")).rejects.toThrow(/google_auth_failed_400/);
    await expect(googleAccessToken("rt-bad")).rejects.toThrow(/google_auth_failed_400/);
  });
});

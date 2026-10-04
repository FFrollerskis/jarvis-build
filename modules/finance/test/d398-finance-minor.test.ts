import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fikenAccessToken, resetFikenAccessTokenCache } from "../src/fiken-transport.ts";
import { osloCalendarDate } from "../src/service.ts";

/** D-398 (JARVIS-097): norsk bokføringsdato (Europe/Oslo) og cachet Fiken access-token. */
describe("osloCalendarDate", () => {
  it("sommertid (UTC+2): 22:30 UTC 4. okt = 5. okt lokalt", () => {
    expect(osloCalendarDate(new Date("2026-10-04T22:30:00Z"))).toBe("2026-10-05");
    expect(osloCalendarDate(new Date("2026-07-01T21:59:00Z"))).toBe("2026-07-01");
    expect(osloCalendarDate(new Date("2026-07-01T22:00:00Z"))).toBe("2026-07-02");
  });
  it("vintertid (UTC+1): 23:30 UTC = neste dag lokalt, 22:30 UTC er fortsatt samme dag", () => {
    expect(osloCalendarDate(new Date("2026-01-15T23:30:00Z"))).toBe("2026-01-16");
    expect(osloCalendarDate(new Date("2026-01-15T22:30:00Z"))).toBe("2026-01-15");
  });
});

describe("fikenAccessToken-cache", () => {
  const originalFetch = global.fetch;
  let exchanges: number;
  beforeEach(() => {
    exchanges = 0;
    resetFikenAccessTokenCache();
    process.env["JARVIS_FIKEN_CLIENT_ID"] = "id";
    process.env["JARVIS_FIKEN_CLIENT_SECRET"] = "secret";
    global.fetch = vi.fn(async () => {
      exchanges++;
      return new Response(JSON.stringify({ access_token: `tok-${exchanges}`, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  });
  afterEach(() => { global.fetch = originalFetch; });

  it("gjenbruker tokenet og deler en pågående utveksling", async () => {
    const [a, b, c] = await Promise.all([fikenAccessToken("rt-1"), fikenAccessToken("rt-1"), fikenAccessToken("rt-1")]);
    expect([a, b, c]).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(await fikenAccessToken("rt-1")).toBe("tok-1");
    expect(exchanges).toBe(1);
    expect(await fikenAccessToken("rt-2")).toBe("tok-2");
  });

  it("feil caches ikke", async () => {
    global.fetch = vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(fikenAccessToken("rt-bad")).rejects.toThrow(/fiken_auth_failed_401/);
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ access_token: "ok", expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
    expect(await fikenAccessToken("rt-bad")).toBe("ok");
  });
});

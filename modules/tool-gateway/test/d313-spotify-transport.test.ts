import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpotifyTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-312. Spotify Web API krever en OAuth2 `refresh_token`-utveksling FØR
 * hvert kall (SAMME mønster som Google-familien sin `googleAccessToken()`)
 * - `client_id`/`client_secret` er DELT app-konfig lest direkte fra env,
 * `credential`-argumentet til `invoke()` er selve refresh-tokenet.
 */
describe("A: SpotifyTransport - OAuth2 refresh_token → access_token-utveksling", () => {
  beforeEach(() => {
    vi.stubEnv("JARVIS_SPOTIFY_CLIENT_ID", "client-id");
    vi.stubEnv("JARVIS_SPOTIFY_CLIENT_SECRET", "client-secret");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("bytter refresh_token mot access_token via Basic-auth mot accounts.spotify.com FØR hvert API-kall", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "https://accounts.spotify.com/api/token") {
        return { ok: true, json: async () => ({ access_token: "access-token" }) } as unknown as Response;
      }
      return { ok: true, status: 204 } as unknown as Response;
    });
    const transport = new SpotifyTransport();
    await transport.invoke("get_currently_playing", {}, "refresh-token");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://accounts.spotify.com/api/token");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: `Basic ${Buffer.from("client-id:client-secret").toString("base64")}` });
    expect(calls[1]!.init?.headers).toMatchObject({ authorization: "Bearer access-token" });
  });

  it("manglende client_id/client_secret kaster 'spotify_oauth_client_not_configured' - IKKE et fetch-kall gjøres", async () => {
    vi.unstubAllEnvs();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new SpotifyTransport();
    await expect(transport.invoke("get_currently_playing", {}, "refresh-token")).rejects.toThrow("spotify_oauth_client_not_configured");
    expect(calls).toHaveLength(0);
  });

  it("en token-endepunkt-feil kaster 'spotify_auth_failed_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 400 }) as unknown as Response);
    const transport = new SpotifyTransport();
    await expect(transport.invoke("get_currently_playing", {}, "bad-refresh-token")).rejects.toThrow("spotify_auth_failed_400");
  });
});

describe("B: SpotifyTransport.invoke('get_currently_playing', ...) - GET /v1/me/player/currently-playing, ren lesing", () => {
  beforeEach(() => {
    vi.stubEnv("JARVIS_SPOTIFY_CLIENT_ID", "client-id");
    vi.stubEnv("JARVIS_SPOTIFY_CLIENT_SECRET", "client-secret");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returnerer nåværende avspilling ved 200", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "https://accounts.spotify.com/api/token") return { ok: true, json: async () => ({ access_token: "access-token" }) } as unknown as Response;
      return { ok: true, json: async () => ({ is_playing: true, item: { name: "Track" } }) } as unknown as Response;
    });
    const transport = new SpotifyTransport();
    const result = await transport.invoke("get_currently_playing", {}, "refresh-token");
    expect(result.data).toEqual({ is_playing: true, item: { name: "Track" } });
  });

  it("returnerer null ved 204 (ingenting spilles av) - IKKE et JSON-parse-forsøk", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "https://accounts.spotify.com/api/token") return { ok: true, json: async () => ({ access_token: "access-token" }) } as unknown as Response;
      return { ok: true, status: 204, json: async () => { throw new Error("skal ikke kalles"); } } as unknown as Response;
    });
    const transport = new SpotifyTransport();
    const result = await transport.invoke("get_currently_playing", {}, "refresh-token");
    expect(result.data).toBeNull();
  });

  it("en HTTP-feil kaster 'spotify_error_<status>'", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "https://accounts.spotify.com/api/token") return { ok: true, json: async () => ({ access_token: "access-token" }) } as unknown as Response;
      return { ok: false, status: 500 } as unknown as Response;
    });
    const transport = new SpotifyTransport();
    await expect(transport.invoke("get_currently_playing", {}, "refresh-token")).rejects.toThrow("spotify_error_500");
  });
});

describe("C: SpotifyTransport.invoke('add_to_queue', ...) - POST /v1/me/player/queue, D-41 ekte skrivehandling", () => {
  beforeEach(() => {
    vi.stubEnv("JARVIS_SPOTIFY_CLIENT_ID", "client-id");
    vi.stubEnv("JARVIS_SPOTIFY_CLIENT_SECRET", "client-secret");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("kaller med URI-encoded uri-query-parameter mot riktig endepunkt", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "https://accounts.spotify.com/api/token") return { ok: true, json: async () => ({ access_token: "access-token" }) } as unknown as Response;
      return { ok: true, status: 204 } as unknown as Response;
    });
    const transport = new SpotifyTransport();
    const result = await transport.invoke("add_to_queue", { uri: "spotify:track:abc123" }, "refresh-token");
    expect(calls[1]!.url).toBe("https://api.spotify.com/v1/me/player/queue?uri=spotify%3Atrack%3Aabc123");
    expect(calls[1]!.init?.method).toBe("POST");
    expect(result.data).toBeNull();
  });
});

describe("D: en ukjent handling kaster 'spotify_unsupported_action_<action>'", () => {
  beforeEach(() => {
    vi.stubEnv("JARVIS_SPOTIFY_CLIENT_ID", "client-id");
    vi.stubEnv("JARVIS_SPOTIFY_CLIENT_SECRET", "client-secret");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("invoke('skip_to_next', ...) kaster (ikke registrert)", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ access_token: "access-token" }) }) as unknown as Response);
    const transport = new SpotifyTransport();
    await expect(transport.invoke("skip_to_next", {}, "refresh-token")).rejects.toThrow("spotify_unsupported_action_skip_to_next");
  });
});

describe("E: firstWaveTools() registrerer spotify.get_currently_playing som klasse A og spotify.add_to_queue som klasse B", () => {
  it("get_currently_playing er klasse A (ren lesing), add_to_queue er klasse B (ekte skrivehandling, D-41)", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "spotify");
    expect(tools.map((t) => t.action).sort()).toEqual(["add_to_queue", "get_currently_playing"]);
    const currentlyPlaying = tools.find((t) => t.action === "get_currently_playing")!;
    expect(currentlyPlaying.capability_class).toBe("A");
    expect(currentlyPlaying.credential_ref).toBe("JARVIS_SPOTIFY_REFRESH_TOKEN");
    expect(currentlyPlaying.output_trust).toBe("untrusted");
    expect(currentlyPlaying.idempotent_external).toBe(true);
    const addToQueue = tools.find((t) => t.action === "add_to_queue")!;
    expect(addToQueue.capability_class).toBe("B");
    expect(addToQueue.credential_ref).toBe("JARVIS_SPOTIFY_REFRESH_TOKEN");
    expect(addToQueue.reversible).toBe(true);
    expect(addToQueue.idempotent_external).toBe(false);
  });
});

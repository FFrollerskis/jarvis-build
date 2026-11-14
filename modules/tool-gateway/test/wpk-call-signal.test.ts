import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortableSleep, adoptCallSignal, composeSignals, currentCallSignal, detachFromCallSignal, raceCallSignal, runWithCallSignal, throwIfAborted
} from "../src/call-signal.ts";
import { jsonRequest } from "../src/control-target-http.ts";
import { AccessTokenCache } from "../src/oauth-refresh.ts";
import { VENDOR_FETCH_TIMEOUT_MS, guardedFetch } from "../src/url-safety.ts";

/**
 * WP-K (D-471, JARVIS-018): kallsignalet (`call-signal.ts`) og alt som bygger på det UTEN gatewayen/databasen - primitivene, `guardedFetch` sin signalrekkefølge, den delte token-utvekslingen
 * og retry-løkkene i den delte HTTP-klienten (mot en EKTE lokal server: forespørselen avbrytes faktisk på socket-nivå). Gateway-nivå per transportfamilie: `wpk-018-gateway-abort.test.ts`.
 */
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const timeoutError = (): Error => new Error("tool_timeout");

describe("A: primitivene", () => {
  it("composeSignals: ingen -> undefined, ett -> samme objekt, flere -> avbrytes av hvilken som helst", () => {
    expect(composeSignals()).toBeUndefined();
    expect(composeSignals(undefined, undefined)).toBeUndefined();
    const a = new AbortController();
    expect(composeSignals(undefined, a.signal)).toBe(a.signal);
    const b = new AbortController();
    const both = composeSignals(a.signal, b.signal)!;
    expect(both.aborted).toBe(false);
    b.abort(timeoutError());
    expect(both.aborted).toBe(true);
    expect((both.reason as Error).message).toBe("tool_timeout");
  });

  it("runWithCallSignal: nøstede kall skygger det ytre, detach fjerner det, adopt aktiverer et eksplisitt signal", () => {
    const outer = new AbortController();
    const inner = new AbortController();
    expect(currentCallSignal()).toBeUndefined();
    runWithCallSignal(outer.signal, () => {
      expect(currentCallSignal()).toBe(outer.signal);
      runWithCallSignal(inner.signal, () => expect(currentCallSignal()).toBe(inner.signal));
      expect(currentCallSignal()).toBe(outer.signal);
      detachFromCallSignal(() => expect(currentCallSignal()).toBeUndefined());
      // `adoptCallSignal` med det som allerede er ambient endrer ingenting; et annet eksplisitt signal blir ambient for varigheten.
      adoptCallSignal(outer.signal, () => expect(currentCallSignal()).toBe(outer.signal));
      adoptCallSignal(inner.signal, () => expect(currentCallSignal()).toBe(inner.signal));
      adoptCallSignal(undefined, () => expect(currentCallSignal()).toBe(outer.signal));
    });
    expect(currentCallSignal()).toBeUndefined();
  });

  it("det ambiente signalet følger async-grenser (await, timere), og nøstede promises arver det", async () => {
    const c = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    await runWithCallSignal(c.signal, async () => {
      await Promise.resolve();
      seen.push(currentCallSignal());
      await new Promise<void>((r) => setTimeout(r, 5));
      seen.push(currentCallSignal());
      await Promise.all([(async () => { await Promise.resolve(); seen.push(currentCallSignal()); })()]);
    });
    expect(seen).toEqual([c.signal, c.signal, c.signal]);
  });

  it("throwIfAborted kaster avbruddsårsaken (Error beholdes; en ikke-Error-årsak gir call_aborted), ellers ingenting", () => {
    const c = new AbortController();
    expect(() => throwIfAborted(c.signal)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
    const reason = timeoutError();
    c.abort(reason);
    expect(() => throwIfAborted(c.signal)).toThrow(reason);
    const d = new AbortController();
    d.abort("streng-årsak");
    expect(() => throwIfAborted(d.signal)).toThrow("call_aborted");
    // ambient
    runWithCallSignal(c.signal, () => expect(() => throwIfAborted()).toThrow("tool_timeout"));
  });

  it("abortableSleep: venter ms, rydder timer og lytter; en avbrutt sleep avviser med årsaken og etterlater INGEN timer", async () => {
    vi.useFakeTimers();
    const done = abortableSleep(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    const c = new AbortController();
    const sleeping = abortableSleep(30_000, c.signal);
    const assertion = expect(sleeping).rejects.toThrow("tool_timeout");
    expect(vi.getTimerCount()).toBe(1);
    c.abort(timeoutError());
    await assertion;
    expect(vi.getTimerCount()).toBe(0);

    // allerede avbrutt: avviser umiddelbart uten å opprette en timer
    await expect(abortableSleep(30_000, c.signal)).rejects.toThrow("tool_timeout");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abortableSleep uten signal er en vanlig sleep; det ambiente signalet brukes når ingen er gitt", async () => {
    vi.useFakeTimers();
    const c = new AbortController();
    const sleeping = runWithCallSignal(c.signal, () => abortableSleep(5_000));
    const assertion = expect(sleeping).rejects.toThrow("tool_timeout");
    c.abort(timeoutError());
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("raceCallSignal: slutter å vente ved avbrudd uten å avbryte selve operasjonen; uten signal returneres løftet uendret", async () => {
    const underlying = new Promise<string>((resolve) => setTimeout(() => resolve("ferdig"), 30));
    expect(raceCallSignal(underlying, undefined)).toBe(underlying);
    const c = new AbortController();
    const waiting = raceCallSignal(underlying, c.signal);
    c.abort(timeoutError());
    await expect(waiting).rejects.toThrow("tool_timeout");
    await expect(underlying).resolves.toBe("ferdig");
    // allerede avbrutt + en operasjon som senere avviser: ingen ubehandlet avvisning
    const failing = new Promise<string>((_, reject) => setTimeout(() => reject(new Error("senere feil")), 10));
    await expect(raceCallSignal(failing, c.signal)).rejects.toThrow("tool_timeout");
    await new Promise((r) => setTimeout(r, 30));
  });
});

describe("B: guardedFetch og signalrekkefølgen", () => {
  function stubFetch(): Array<RequestInit | undefined> {
    const seen: Array<RequestInit | undefined> = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => { seen.push(init); return { ok: true, status: 200 } as Response; });
    return seen;
  }

  it("uten noe signal: standardgrensen på 45 s (uendret)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const seen = stubFetch();
    await guardedFetch("https://api.github.com/user");
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.signal?.aborted).toBe(false);
    expect(timeoutSpy).toHaveBeenCalledWith(VENDOR_FETCH_TIMEOUT_MS);
  });

  it("med ambient kallsignal: forespørselen avbrytes når kallet avbrytes (standardgrensen gjelder fortsatt som tak)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const seen = stubFetch();
    const c = new AbortController();
    await runWithCallSignal(c.signal, () => guardedFetch("https://api.github.com/user"));
    const signal = seen[0]!.signal!;
    expect(signal.aborted).toBe(false);
    expect(timeoutSpy).toHaveBeenCalledWith(VENDOR_FETCH_TIMEOUT_MS);
    c.abort(timeoutError());
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe("tool_timeout");
  });

  it("kallerens EGET signal vinner (identisk objekt) og det ambiente ignoreres - delt tilstand med eget signal dør ikke med et annet kalls frist", async () => {
    const seen = stubFetch();
    const own = AbortSignal.timeout(5_000);
    const ambient = new AbortController();
    await runWithCallSignal(ambient.signal, () => guardedFetch("https://api.github.com/user", { signal: own }));
    expect(seen[0]?.signal).toBe(own);
    ambient.abort(timeoutError());
    expect(own.aborted).toBe(false);
  });

  it("et allerede avbrutt kall sender ALDRI en forespørsel (heller ikke når fetch-implementasjonen ignorerer signalet)", async () => {
    const seen = stubFetch();
    const c = new AbortController();
    c.abort(timeoutError());
    await expect(runWithCallSignal(c.signal, () => guardedFetch("https://api.github.com/user"))).rejects.toThrow("tool_timeout");
    const own = new AbortController();
    own.abort(new Error("eget_avbrudd"));
    await expect(guardedFetch("https://api.github.com/user", { signal: own.signal })).rejects.toThrow("eget_avbrudd");
    expect(seen).toHaveLength(0);
  });

  it("URL-vakten gjelder fortsatt FØRST (ingen forespørsel, uavhengig av signalet)", async () => {
    const seen = stubFetch();
    const c = new AbortController();
    await expect(runWithCallSignal(c.signal, () => guardedFetch("https://api.github.com/../admin"))).rejects.toThrow(/unsafe_vendor_url/);
    expect(seen).toHaveLength(0);
  });
});

describe("C: delt token-utveksling dør ikke med første kallers frist", () => {
  it("én utveksling for samtidige kall; første kallers tidsavbrudd slipper KUN den kalleren fri, og utvekslingen kjører uten kallsignal", async () => {
    let exchanges = 0;
    let exchangeSaw: AbortSignal | undefined | "unset" = "unset";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cache = new AccessTokenCache({
      async exchange() {
        exchanges += 1;
        exchangeSaw = currentCallSignal();
        await gate;
        return { access_token: "fake-access-token-for-test", expires_in: 3600 };
      }
    });
    const first = new AbortController();
    const second = new AbortController();
    const a = runWithCallSignal(first.signal, () => cache.get("rt-1"));
    const b = runWithCallSignal(second.signal, () => cache.get("rt-1"));
    const aRejected = expect(a).rejects.toThrow("tool_timeout");
    first.abort(timeoutError());
    await aRejected;
    release();
    await expect(b).resolves.toBe("fake-access-token-for-test");
    expect(exchanges).toBe(1);
    expect(exchangeSaw).toBeUndefined(); // detached: ikke bundet til første kalls signal
    expect(first.signal.aborted).toBe(true);
    // neste kall bruker cachen (ingen ny utveksling)
    await expect(cache.get("rt-1")).resolves.toBe("fake-access-token-for-test");
    expect(exchanges).toBe(1);
  });

  it("uten kallsignal er oppførselen uendret (samtidige kall deler utvekslingen og feil caches ikke)", async () => {
    let exchanges = 0;
    const cache = new AccessTokenCache({
      async exchange() {
        exchanges += 1;
        if (exchanges === 1) throw new Error("midlertidig");
        return { access_token: "fake-access-token-for-test", expires_in: 3600 };
      }
    });
    await expect(Promise.all([cache.get("rt"), cache.get("rt")])).rejects.toThrow("midlertidig");
    expect(exchanges).toBe(1);
    await expect(cache.get("rt")).resolves.toBe("fake-access-token-for-test");
    expect(exchanges).toBe(2);
  });
});

describe("D: delt HTTP-klient (jsonRequest) mot en EKTE lokal server", () => {
  let server: Server | undefined;
  afterEach(async () => {
    const s = server;
    server = undefined;
    if (!s) return;
    s.closeAllConnections(); // en hengende forespørsel holder ellers close() åpen
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  async function start(handler: (url: string, method: string, closed: () => void) => { status: number; body?: unknown } | "hang"): Promise<{ base: string; requests: string[]; closes: string[] }> {
    const requests: string[] = [];
    const closes: string[] = [];
    server = createServer((req, res) => {
      const key = `${req.method} ${req.url}`;
      requests.push(key);
      res.on("close", () => { if (!res.writableEnded) closes.push(key); });
      const out = handler(req.url ?? "", req.method ?? "GET", () => closes.push(key));
      if (out === "hang") return; // aldri svar: forespørselen henger til klienten avbryter
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body ?? {}));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, requests, closes };
  }

  it("en hengende POST avbrytes på socket-nivå når kallet avbrytes, og sendes aldri på nytt", async () => {
    const { base, requests, closes } = await start(() => "hang");
    const c = new AbortController();
    const call = runWithCallSignal(c.signal, () => jsonRequest({ service: "test", method: "POST", url: `${base}/mutate`, body: { a: 1 }, secrets: [] }));
    const assertion = expect(call).rejects.toThrow("tool_timeout");
    await new Promise((r) => setTimeout(r, 80));
    expect(requests).toEqual(["POST /mutate"]);
    c.abort(timeoutError());
    await assertion;
    await vi.waitFor(() => expect(closes).toEqual(["POST /mutate"]), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 700)); // lenger enn første backoff (500 ms): ingen retry
    expect(requests).toEqual(["POST /mutate"]);
  });

  it("en lesing som får 503 venter med backoff - avbrytes den under ventingen sendes ikke forsøk 2, og timeren er borte", async () => {
    const { base, requests } = await start(() => ({ status: 503, body: { message: "nede" } }));
    const c = new AbortController();
    const call = runWithCallSignal(c.signal, () => jsonRequest({ service: "test", method: "GET", url: `${base}/read`, secrets: [] }));
    const assertion = expect(call).rejects.toThrow("tool_timeout");
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 2000 });
    c.abort(timeoutError()); // under første backoff (500 ms)
    await assertion;
    await new Promise((r) => setTimeout(r, 800));
    expect(requests).toEqual(["GET /read"]);
  });

  it("uten avbrudd gjentas lesingen som før (3 forsøk), og en POST med 503 gjentas aldri", async () => {
    const { base, requests } = await start(() => ({ status: 503, body: { message: "nede" } }));
    const sleeps: number[] = [];
    await expect(jsonRequest({ service: "test", method: "GET", url: `${base}/read`, secrets: [], sleep: async (ms) => { sleeps.push(ms); } })).rejects.toThrow(/test_error_503/);
    expect(requests).toEqual(["GET /read", "GET /read", "GET /read"]);
    expect(sleeps).toHaveLength(2);
    requests.length = 0;
    await expect(jsonRequest({ service: "test", method: "POST", url: `${base}/write`, body: {}, secrets: [], sleep: async () => undefined })).rejects.toThrow(/test_error_503/);
    expect(requests).toEqual(["POST /write"]);
  });

  it("løkken sjekker signalet FØR hvert forsøk, uavhengig av hvilken sleep som er injisert (en sleep som avbryter kallet gir ikke forsøk 2)", async () => {
    const { base, requests } = await start(() => ({ status: 503, body: { message: "nede" } }));
    const c = new AbortController();
    const call = runWithCallSignal(c.signal, () =>
      jsonRequest({ service: "test", method: "GET", url: `${base}/read`, secrets: [], sleep: async () => { c.abort(timeoutError()); } })
    );
    await expect(call).rejects.toThrow("tool_timeout");
    expect(requests).toEqual(["GET /read"]);
  });
});

describe("F: ventetiden mellom forsøk avbrytes og rydder timeren (GitHub, Zapier, GCE, Cloudflare)", () => {
  /** Slipper mikrooppgaver gjennom uten å la fake-timere gå fremover. */
  const flush = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(0); };
  const replyWith = (status: number, headers: Record<string, string> = {}) => async (): Promise<Response> =>
    new Response(JSON.stringify({ message: "svikt" }), { status, headers: { "content-type": "application/json", ...headers } });

  async function sleepIsAborted(fetchImpl: () => Promise<Response>, start: () => Promise<unknown>, expectedFetches = 1): Promise<void> {
    vi.useFakeTimers();
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => { seen.push(u); return fetchImpl(); });
    const controller = new AbortController();
    const pending = runWithCallSignal(controller.signal, start);
    const assertion = expect(pending).rejects.toThrow("tool_timeout");
    await flush();
    expect(seen).toHaveLength(expectedFetches);
    expect(vi.getTimerCount()).toBe(1); // sovende retry-/poll-timer
    controller.abort(timeoutError());
    await assertion;
    expect(vi.getTimerCount()).toBe(0); // timeren er ryddet - ikke en sovende løkke som våkner etter at utfallet er meldt ukjent
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toHaveLength(expectedFetches); // og ingen forsøk 2 etterpå
  }

  it("GitHub: 429 med Retry-After -> sleep -> avbrudd rydder timeren, ingen nytt forsøk", async () => {
    const { GithubTransport } = await import("../src/live-transports.ts");
    await sleepIsAborted(replyWith(429, { "retry-after": "30" }), () => new GithubTransport().invoke("create_issue", { repo: "owner/repo", title: "t" }, "fake-credential-for-test"));
  });

  it("Zapier: 429 -> backoff -> avbrudd rydder timeren, ingen nytt forsøk", async () => {
    const { McpZapierTransport } = await import("../src/mcp-zapier-transport.ts");
    await sleepIsAborted(replyWith(429), () => new McpZapierTransport().invoke("call_tool", { tool_name: "x", arguments: {} }, "https://mcp.zapier.com/api/mcp/s/fake-token-for-test/mcp"));
  });

  it("Cloudflare: 503 på lesing -> standard sleep -> avbrudd rydder timeren, ingen nytt forsøk", async () => {
    const { CloudflareTransport } = await import("../src/cloudflare-transport.ts");
    await sleepIsAborted(replyWith(503), () => new CloudflareTransport({ baseUrl: "http://127.0.0.1:9/client/v4" }).invoke("list_zones", {}, "fake-credential-for-test"));
  });

  it("GCE: poll-løkken sover mellom GET-ene - avbrudd rydder timeren og stopper pollingen", async () => {
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_ID", "fake-client-id-for-test");
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_SECRET", "fake-client-secret-for-test");
    const { GceTransport } = await import("../src/gce-transport.ts");
    const { resetGoogleAccessTokenCache } = await import("../src/live-transports.ts");
    resetGoogleAccessTokenCache();
    const reply = async (): Promise<Response> => new Response(JSON.stringify({ access_token: "fake-access-token-for-test", expires_in: 3600, name: "op-1", status: "RUNNING" }), { status: 200, headers: { "content-type": "application/json" } });
    // fetch 1 = token, 2 = POST reset, 3 = første poll; deretter sover løkken (5 s) og er avbrytbar
    await sleepIsAborted(reply, () => new GceTransport("fake-project", 5_000).invoke("reset_instance", { zone: "europe-west1-b", instance_name: "vm-1" }, "fake-credential-for-test"), 3);
    vi.unstubAllEnvs();
  });
});

describe("E: vakt - ingen transport i tool-gateway/src setter eget signal uten å sette det sammen med kallsignalet", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? files(full) : n.endsWith(".ts") ? [full] : [];
  });
  /** Samme grove strippingen som `d436-guarded-fetch-coverage.test.ts`: kommentarer og streng-/mal-literaler fjernes før token-søket. */
  const stripNonCode = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");

  /** Filer som BEVISST setter et eget `signal:`, med grunn. Alt annet går via guardedFetch uten eget signal (= ambient kallsignal). */
  const OWN_SIGNAL: Record<string, string> = {
    "call-signal.ts": "selve primitivet: AsyncLocalStorage-formen `{ signal }` (ingen forespørsel)",
    "gateway.ts": "Infisical-oppslag/-skriving har egne korte frister (delt innlogging må ikke dø med et annet kalls frist)",
    "github-app-auth.ts": "GitHub App-tokenutstedelse: egen, delt frist per forespørsel (token-cache, ikke del av et verktøykall)",
    "live-transports.ts": "Telegram-pollerens getUpdates (bakgrunnsløkke, ikke et verktøykall)",
    "mcp-zapier-transport.ts": "egen 45 s-frist SAMMENSATT med kallsignalet (composeSignals)",
    "browser-transport.ts": "eget tak SAMMENSATT med kallsignalet (composeSignals)"
  };

  it("hver fil med `signal:` i kode står på den begrunnede listen - en NY transport med eget signal må enten bruke composeSignals eller forklares her", () => {
    const withOwnSignal = files(SRC)
      .filter((f) => /(?<![A-Za-z0-9_$])signal\s*:/.test(stripNonCode(readFileSync(f, "utf8"))))
      .map((f) => f.slice(SRC.length + 1))
      .sort();
    expect(withOwnSignal).toEqual(Object.keys(OWN_SIGNAL).sort());
  });

  it("de to transportene med eget tak setter det sammen med kallsignalet (aldri bare eget signal)", () => {
    for (const name of ["mcp-zapier-transport.ts", "browser-transport.ts"]) {
      const code = stripNonCode(readFileSync(join(SRC, name), "utf8"));
      expect(code, name).toMatch(/composeSignals\(/);
    }
  });

  it("alle retry-/poll-løkker venter avbrytbart: ingen `new Promise(... setTimeout` som sleep i transportfilene", () => {
    const offenders = files(SRC)
      .filter((f) => !/(call-signal|scheduler|github-app-auth|github-rate-limit-controller|gateway)\.ts$/.test(f))
      .filter((f) => /new Promise[^;\n]*setTimeout\(/.test(stripNonCode(readFileSync(f, "utf8"))))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});

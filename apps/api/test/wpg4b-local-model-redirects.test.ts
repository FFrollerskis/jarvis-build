import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { OllamaEmbedding, createEmbeddingProviderFromEnv } from "@jarvis/memory";
import { LocalOpenAiCompatibleAdapter, OllamaAdapter, type ModelRequest } from "@jarvis/provider-adapters";
import { localModelNoRedirect } from "../src/local-model-endpoints.ts";

/**
 * WP-G4b fiks-runde 1, FIX-5 (review B L1): med K4-vakten PAA foelger lokale modellkall ALDRI en omdirigering (`redirect: "error"`). En 307/308 fra en lokal URL (f.eks. http->https paa en omvendt proxy, eller en kapret/feilkonfigurert
 * vert) sender ellers forespoerselskroppen (modellinnhold, inkl. helse/oekonomi) videre til `Location`. Gjelder de tre lokale identitetene (`local_llm`/`gemma_local` via `LocalOpenAiCompatibleAdapter`, `ollama` via `OllamaAdapter`) og minnets
 * Ollama-embedding. Bak en konstruktoeropsjon `noRedirect` som kun settes naar vakten er PAA; AV = ingen `redirect`-noekkel i fetch (main-atferd: foelger som foer). `local_vision` er uendret (alltid `redirect: "error"`, G3).
 */
const body: ModelRequest = { messages: [{ role: "user", content: "HELSE: blodtrykk 160/100" }] } as never;
const embedDim = 1024; // bge-m3

interface Servers { target: Server; hits: Array<{ method: string; body: string }>; redirectUrl: string; stop: () => void }
async function twoServers(status: 301 | 302 | 307 | 308): Promise<Servers> {
  const hits: Servers["hits"] = [];
  const read = (req: IncomingMessage): Promise<string> => new Promise((res) => { let s = ""; req.on("data", (c) => { s += c; }); req.on("end", () => res(s)); });
  const target = createServer(async (req, res) => {
    hits.push({ method: req.method ?? "", body: await read(req) });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], message: { content: "ok" }, done: true, embeddings: [new Array(embedDim).fill(0.1)], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "m" }));
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const targetPort = (target.address() as AddressInfo).port;
  const redirecting = createServer(async (req, res) => { await read(req); res.statusCode = status; res.setHeader("location", `http://127.0.0.1:${targetPort}${req.url}`); res.end(); });
  await new Promise<void>((r) => redirecting.listen(0, "127.0.0.1", r));
  const port = (redirecting.address() as AddressInfo).port;
  return { target, hits, redirectUrl: `http://127.0.0.1:${port}`, stop: () => { redirecting.close(); target.close(); } };
}
let open: Servers[] = [];
afterEach(() => { for (const s of open) s.stop(); open = []; });
const servers = async (status: 301 | 302 | 307 | 308 = 307): Promise<Servers> => { const s = await twoServers(status); open.push(s); return s; };

type Call = (url: string, noRedirect: boolean) => Promise<unknown>;
const CALLS: Array<[string, Call]> = [
  ["local_llm (complete)", (url, noRedirect) => new LocalOpenAiCompatibleAdapter(url, "m", 5000, "local_llm", undefined, noRedirect ? { noRedirect: true } : {}).complete(body)],
  ["gemma_local (complete)", (url, noRedirect) => new LocalOpenAiCompatibleAdapter(url, "m", 5000, "gemma_local", undefined, noRedirect ? { noRedirect: true } : {}).complete(body)],
  ["gemma_local (stream)", (url, noRedirect) => new LocalOpenAiCompatibleAdapter(url, "m", 5000, "gemma_local", undefined, noRedirect ? { noRedirect: true } : {}).stream(body, () => undefined)],
  ["ollama (complete)", (url, noRedirect) => new OllamaAdapter(url, "m", 5000, noRedirect ? { noRedirect: true } : {}).complete(body)],
  ["memory embedding (OllamaEmbedding)", (url, noRedirect) => new OllamaEmbedding(url, "bge-m3", noRedirect ? { noRedirect: true } : {}).embed("HELSE: blodtrykk 160/100")],
  ["memory embedding (createEmbeddingProviderFromEnv)", (url, noRedirect) =>
    createEmbeddingProviderFromEnv({ JARVIS_EMBEDDING_PROVIDER: "ollama", JARVIS_EMBEDDING_MODEL: "bge-m3", JARVIS_EMBEDDING_URL: url }, noRedirect ? { noRedirect: true } : {}).embed("HELSE: blodtrykk 160/100")]
];

describe("vakt PAA (noRedirect): omdirigeringen foelges ALDRI - kallet feiler og maalet faar ingenting", () => {
  for (const status of [301, 302, 307, 308] as const) {
    for (const [name, call] of CALLS) {
      it(`${name}: ${status} til en annen vert -> kallet kaster, maalet far 0 foresporsler`, async () => {
        const s = await servers(status);
        await expect(call(s.redirectUrl, true)).rejects.toThrow();
        expect(s.hits, `${name} ${status}`).toHaveLength(0);
      });
    }
  }
});

describe("vakt AV (ingen opsjon): som main - omdirigeringen foelges", () => {
  for (const [name, call] of CALLS) {
    it(`${name}: 307 foelges (maalet far foresporselen med kropp); 302 foelges (maalet far en foresporsel)`, async () => {
      const s307 = await servers(307);
      await call(s307.redirectUrl, false).catch(() => undefined);
      expect(s307.hits.length, `${name} 307`).toBe(1);
      expect(s307.hits[0]!.body, `${name} 307`).toContain("blodtrykk");
      const s302 = await servers(302);
      await call(s302.redirectUrl, false).catch(() => undefined);
      expect(s302.hits.length, `${name} 302`).toBe(1);
    });
  }

  it("AV = ingen `redirect`-nokkel i fetch-initialiseringen (byte-lik main) for noRedirect: false/utelatt; PAA = `redirect: \"error\"`", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: Record<string, unknown>) => { seen.push({ ...(init ?? {}) }); return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], message: { content: "ok" }, embeddings: [new Array(embedDim).fill(0)], usage: {} }), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
    try {
      for (const [, call] of CALLS) await call("http://127.0.0.1:9", false).catch(() => undefined);
      expect(seen.length).toBeGreaterThanOrEqual(CALLS.length);
      for (const init of seen) expect("redirect" in init).toBe(false);
      seen.length = 0;
      for (const [, call] of CALLS) await call("http://127.0.0.1:9", true).catch(() => undefined);
      for (const init of seen) expect(init["redirect"]).toBe("error");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("den dedikerte visjonsidentiteten er uendret: ALLTID `redirect: \"error\"` (G3), med eller uten opsjonen", async () => {
    const s = await servers(307);
    await expect(new LocalOpenAiCompatibleAdapter(s.redirectUrl, "m", 5000, "local_vision", undefined, { vision: true }).complete(body)).rejects.toThrow();
    expect(s.hits).toHaveLength(0);
  });
});

describe("kobling: `localModelNoRedirect` (kun eksakt `on`) og api/worker gir opsjonen til ALLE lokale kall", () => {
  it("opsjonen = vakten er PAA (kun den eksakte verdien `on`)", () => {
    expect(localModelNoRedirect({ JARVIS_LOCAL_MODEL_URL_GUARD: "on" })).toBe(true);
    for (const v of [undefined, "", "off", "true", "1", "ON", " on", "on "]) expect(localModelNoRedirect({ JARVIS_LOCAL_MODEL_URL_GUARD: v }), String(v)).toBe(false);
    expect(localModelNoRedirect({})).toBe(false);
    expect(localModelNoRedirect({ JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE: "on" })).toBe(false); // tailnet-flagget alene slaar ikke paa vakten
  });

  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const file of ["apps/api/src/main.ts", "apps/api/src/worker-main.ts"]) {
    it(`${file}: local_llm, gemma_local og ollama bygges med noRedirect fra vakten, og embedding-fabrikken faar den`, () => {
      const src = strip(readFileSync(resolve(ROOT, file), "utf8"));
      expect(src).toMatch(/localModelNoRedirect\(process\.env\)/);
      expect(src.match(/noRedirect/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
      // hver av de tre chat-identitetene
      expect(src).toMatch(/new LocalOpenAiCompatibleAdapter\(\s*undefined,\s*undefined,\s*undefined,\s*undefined,\s*undefined,\s*\{[^}]*noRedirect/);
      expect(src).toMatch(/new LocalOpenAiCompatibleAdapter\(\s*process\.env\["JARVIS_GEMMA_LOCAL_URL"\][\s\S]*?"gemma_local",\s*undefined,\s*\{[^}]*noRedirect/);
      expect(src).toMatch(/new OllamaAdapter\(\s*undefined,\s*undefined,\s*undefined,\s*\{[^}]*noRedirect/);
      // ALLE kall til embedding-fabrikken
      const factoryCalls = src.match(/createEmbeddingProviderFromEnv\([^)]*\)/g) ?? [];
      expect(factoryCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of factoryCalls) expect(call, call).toMatch(/noRedirect/);
    });
  }
});

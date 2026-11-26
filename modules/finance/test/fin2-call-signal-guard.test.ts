import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WP-FIN2 K2c (D-486, JARVIS-018-resten) - KILDEVAKT for `modules/finance/src` (samme idé som gruppe E i `modules/tool-gateway/test/wpk-call-signal.test.ts`): ingen finanstransport kan
 * sende en leverandørforespørsel eller vente mellom forsøk uten gatewayens kallsignal. Før WP-FIN2 hadde de fem transportene hver sin `fetch` med kun det egne 20 s-taket (`financeSignal()`) og en
 * uavbrytbar `sleep`, så en retry-løkke kunne gå ut ETTER at gatewayen hadde meldt «utfall ukjent». Vakten låser:
 *   1. ingen rå `fetch(`/`AbortSignal.timeout(`/`financeSignal(` utenfor `http.ts` (ÉN `financeFetch`),
 *   2. EKSAKT antall `financeFetch(`-kallesteder per transportfil (en ny fetch må begrunnes og telles her),
 *   3. hver transport med retry-løkke venter via `financeBackoff(` (abortableSleep) - aldri `new Promise(... setTimeout`,
 *   4. hver `ToolTransport` i finans tar imot 5. argument og bruker `adoptCallSignal(`.
 * Skannerne har NEGATIV KONTROLL (syntetiske kilder med bruddene må fanges), så vakten ikke kan bli stille tom.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const full = join(dir, n);
  return statSync(full).isDirectory() ? files(full) : n.endsWith(".ts") ? [full] : [];
});

/** Kommentarer og streng-/mal-literaler fjernes før token-søket (samme grove stripping som `wpk-call-signal.test.ts`). */
export const stripNonCode = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\n]*/g, " ")
  .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
  .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
  .replace(/'(?:\\.|[^'\\\n])*'/g, "''");

const count = (code: string, re: RegExp): number => (code.match(re) ?? []).length;
export const rawFetchCalls = (code: string): number => count(code, /(?<![A-Za-z0-9_$.])fetch\s*\(/g);
export const ownTimeoutSignals = (code: string): number => count(code, /AbortSignal\s*\.\s*timeout\s*\(/g);
export const financeSignalUses = (code: string): number => count(code, /(?<![A-Za-z0-9_$])financeSignal\s*\(/g);
export const financeFetchCalls = (code: string): number => count(code, /(?<![A-Za-z0-9_$])financeFetch\s*\(/g);
export const backoffCalls = (code: string): number => count(code, /(?<![A-Za-z0-9_$])financeBackoff\s*\(/g);
export const rawSleeps = (code: string): number => count(code, /new Promise[^;\n]*setTimeout\s*\(/g);
export const implementsToolTransport = (code: string): boolean => /\bimplements\s+ToolTransport\b/.test(code);
export const adoptsCallSignal = (code: string): boolean => /(?<![A-Za-z0-9_$])adoptCallSignal\s*\(/.test(code);

/** Transportfilene med retry-løkke og EKSAKT antall `financeFetch(`-kallesteder (token-utveksling + hovedforespørsel). */
const FETCH_SITES: Readonly<Record<string, number>> = {
  "stripe-transport.ts": 1,
  "vipps-transport.ts": 2,
  "neonomics-transport.ts": 2,
  "wallester-transport.ts": 1,
  "fiken-transport.ts": 2
};

describe("K2c: kildevakt - finanstransportene bruker gatewayens kallsignal", () => {
  const sources = files(SRC).map((f) => ({ name: f.slice(SRC.length + 1), code: stripNonCode(readFileSync(f, "utf8")) }));

  it("ingen rå `fetch(` i modules/finance/src (alt går via `financeFetch` i http.ts)", () => {
    const offenders = sources.filter((s) => s.name !== "http.ts" && rawFetchCalls(s.code) > 0).map((s) => s.name);
    expect(offenders).toEqual([]);
    expect(rawFetchCalls(sources.find((s) => s.name === "http.ts")!.code)).toBe(1); // den ENE: inne i `financeFetch`
  });

  it("`AbortSignal.timeout(` og `financeSignal(` finnes kun i http.ts (taket settes sammen med kallsignalet der, aldri alene)", () => {
    expect(sources.filter((s) => s.name !== "http.ts" && ownTimeoutSignals(s.code) > 0).map((s) => s.name)).toEqual([]);
    expect(sources.filter((s) => s.name !== "http.ts" && financeSignalUses(s.code) > 0).map((s) => s.name)).toEqual([]);
    const http = sources.find((s) => s.name === "http.ts")!.code;
    expect(http).toMatch(/composeSignals\s*\(\s*callSignal\s*,\s*AbortSignal\s*\.\s*timeout/);
    expect(http).toMatch(/throwIfAborted\s*\(\s*callSignal\s*\)/);
    expect(http).toMatch(/abortableSleep\s*\(/);
  });

  it("EKSAKT antall `financeFetch(`-kallesteder per transportfil - og ingen andre filer kaller den (en ny leverandør-fetch må begrunnes her)", () => {
    for (const [name, expected] of Object.entries(FETCH_SITES)) {
      expect(financeFetchCalls(sources.find((s) => s.name === name)!.code), name).toBe(expected);
    }
    const others = sources.filter((s) => s.name !== "http.ts" && !(s.name in FETCH_SITES) && financeFetchCalls(s.code) > 0).map((s) => s.name);
    expect(others).toEqual([]);
  });

  it("hver transport med retry-løkke venter avbrytbart (`financeBackoff(`), og ingen fil sover uavbrytbart", () => {
    for (const name of Object.keys(FETCH_SITES)) expect(backoffCalls(sources.find((s) => s.name === name)!.code), name).toBeGreaterThanOrEqual(1);
    expect(sources.filter((s) => rawSleeps(s.code) > 0).map((s) => s.name)).toEqual([]);
  });

  it("hver ToolTransport i finans tar imot kallsignalet som 5. argument (`adoptCallSignal`)", () => {
    const transports = sources.filter((s) => implementsToolTransport(s.code));
    expect(transports.map((s) => s.name).sort()).toEqual([
      "neonomics-tool-transport.ts", "spend-transport.ts", "stripe-tool-transport.ts", "transport.ts", "vipps-tool-transport.ts", "wallester-tool-transport.ts"
    ]);
    for (const t of transports) expect(adoptsCallSignal(t.code), t.name).toBe(true);
  });
});

describe("K2c: negativ kontroll - skannerne fanger bruddene (vakten er ikke stille tom)", () => {
  const code = (src: string) => stripNonCode(src);
  it("rå fetch, eget tidsavbrudd, financeSignal og uavbrytbar sleep fanges; kommentarer/strenger og financeFetch teller ikke", () => {
    expect(rawFetchCalls(code("const r = await fetch(url, { signal: financeSignal() });"))).toBe(1);
    expect(rawFetchCalls(code("const r = await globalThis.fetch(url);"))).toBe(0); // punktum-prefiks er et annet kallested enn global fetch - fanges av vakten mot `globalThis.fetch` under
    expect(rawFetchCalls(code("// fetch(url)\nconst s = 'fetch(url)'; const t = `fetch(${x})`;"))).toBe(0);
    expect(rawFetchCalls(code("await financeFetch(url, init);"))).toBe(0);
    expect(financeFetchCalls(code("await financeFetch(url, init); await financeFetch(u2);"))).toBe(2);
    expect(ownTimeoutSignals(code("signal: AbortSignal.timeout(20_000)"))).toBe(1);
    expect(financeSignalUses(code("signal: financeSignal(),"))).toBe(1);
    expect(rawSleeps(code("function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }"))).toBe(1);
    expect(backoffCalls(code("await financeBackoff(500);"))).toBe(1);
  });

  it("en ToolTransport uten adoptCallSignal fanges; med adoptCallSignal passerer", () => {
    const bad = code("export class X implements ToolTransport { async invoke(a, p) { return {}; } }");
    expect(implementsToolTransport(bad)).toBe(true);
    expect(adoptsCallSignal(bad)).toBe(false);
    const good = code("export class X implements ToolTransport { async invoke(a, p, c, x, signal) { return adoptCallSignal(signal, () => this.d(a, p)); } }");
    expect(adoptsCallSignal(good)).toBe(true);
  });

  it("`globalThis.fetch(` og `window.fetch(`-formene omgår ikke vakten: de fanges av en egen sjekk", () => {
    const viaGlobal = (src: string) => count(code(src), /(?:globalThis|global|self)\s*\.\s*fetch\s*\(/g);
    expect(viaGlobal("await globalThis.fetch(url)")).toBe(1);
    for (const s of sources()) expect(viaGlobal(readFileSync(s, "utf8")), s).toBe(0);
  });

  function sources(): string[] { return files(SRC); }
});

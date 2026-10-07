import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_INVOKE_TIMEOUT_MS, BrowserGatewayTransport } from "../src/browser-transport.ts";
import { InfisicalSecretProvider } from "../src/gateway.ts";
import { McpZapierTransport } from "../src/mcp-zapier-transport.ts";
import { assertSafeVendorUrl } from "../src/url-safety.ts";

/**
 * Q-46 punkt 6 (D-436): ALLE utgående leverandørkall i `modules/tool-gateway/src` går via `guardedFetch` (rå-URL-sjekk + timeout). Tidligere brukte
 * Infisical-gatewayen, Zapier-MCP og browser-gateway rå `fetch` mot konfigurerte base-URL-er. MERK (ærlig): andre moduler (finans-, growth-,
 * self-modification-, embedding- og voice-transporter) har fortsatt rå `fetch` - se D-436 for den DEFERRED listen.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

afterEach(() => vi.restoreAllMocks());

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? tsFiles(full) : n.endsWith(".ts") ? [full] : [];
  });
}

/** Fjerner kommentarer og streng-/mal-literaler (grovt, men nok til å la `fetch` i tekst/doc ikke telle) før token-søket. */
function stripNonCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    // regex-literaler (`/fetch failed|…/i`): fjernes etter en operator/åpner, slik at ordet i et mønster ikke teller som kall
    .replace(/(^|[=(,:;!&|?{}[\n]\s*)\/(?![/*])(?:\\.|\[[^\]\n]*\]|[^/\n\\])+\/[a-z]*/g, "$1//");
}

describe("D-436: ingen rå fetch i tool-gateway/src (kun guardedFetch i url-safety.ts)", () => {
  // `fetch` som selvstendig token: kall (`fetch(`, `fetch (`, `globalThis.fetch(`), videresending (`= fetch`, `?? fetch`) og bare referanser.
  // `guardedFetch` og `xyzFetch` er ikke selvstendige tokens. Egne metoder kalt `fetch` finnes ikke i denne mappen (testen ville avslørt det).
  const RAW_FETCH = /(?<![A-Za-z0-9_$])fetch(?![A-Za-z0-9_$])/;

  it("hver kilde-fil (rekursivt) unntatt url-safety.ts er fri for token `fetch` i kode", () => {
    const offenders = tsFiles(SRC)
      .filter((f) => !f.endsWith("url-safety.ts"))
      .filter((f) => RAW_FETCH.test(stripNonCode(readFileSync(f, "utf8"))))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it("vakten fanger faktisk de vanlige omgåelsene (selvtest av regexen)", () => {
    for (const bad of ["fetch(u)", "fetch (u)", "globalThis.fetch(u)", "const f = fetch;", "impl ?? fetch", "window.fetch(u)"]) {
      expect(RAW_FETCH.test(stripNonCode(bad)), bad).toBe(true);
    }
    for (const ok of ["guardedFetch(u)", "// fetch(u)", "/* fetch(u) */", 'const s = "fetch(u)";', "refetch(u)", "fetchAll(u)"]) {
      expect(RAW_FETCH.test(stripNonCode(ok)), ok).toBe(false);
    }
  });
});

describe("D-436: standardport og utrygge base-URL-er", () => {
  it("standardport (:80 på http, :443 på https) er ikke en farlig normalisering; andre avvik avvises fortsatt", () => {
    expect(assertSafeVendorUrl("http://infisical:80/api")).toBe("http://infisical:80/api");
    expect(assertSafeVendorUrl("https://mcp.zapier.com:443/mcp")).toBe("https://mcp.zapier.com:443/mcp");
    expect(assertSafeVendorUrl("http://infisical:8080/api")).toBe("http://infisical:8080/api");
    expect(() => assertSafeVendorUrl("http://infisical:80/../admin")).toThrow(/dot_segment/);
    expect(() => assertSafeVendorUrl("http://infisical_x:8080/api")).toThrow(/unsafe_vendor_url/);
  });
});

describe("D-436: de tre konfigurerte base-URL-ene avvises når de er utrygge, og sendes ikke", () => {
  it("browser-gateway: dot-segment i base-URL avvises FØR noe sendes", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const t = new BrowserGatewayTransport("x".repeat(40));
    await expect(t.invoke("navigate", { url: "https://example.com" }, "http://browser-gateway:3030/../admin")).rejects.toThrow(/unsafe_vendor_url:dot_segment/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("browser-gateway: ren intern URL sendes med akkurat BROWSER_INVOKE_TIMEOUT_MS (30 s = lengste verktøy-timeout)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
    const t = new BrowserGatewayTransport("x".repeat(40));
    await t.invoke("navigate", { url: "https://example.com" }, "http://browser-gateway:3030");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe("http://browser-gateway:3030/invoke");
    expect(BROWSER_INVOKE_TIMEOUT_MS).toBe(30_000);
    expect(timeoutSpy).toHaveBeenCalledWith(BROWSER_INVOKE_TIMEOUT_MS);
  });

  it("zapier-MCP: en backslash i server-URL avvises med unsafe_vendor_url før noe sendes", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const t = new McpZapierTransport();
    await expect(t.invoke("list_tools", {}, "https://mcp.zapier.com\\evil/mcp")).rejects.toThrow(/unsafe_vendor_url/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("Infisical: utrygg INFISICAL_URL sender ingenting, gir null (fail closed) og logger en tydelig konfig-feil uten verdi", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = new InfisicalSecretProvider("http://infisical:8080/../admin", "id", "secret", "proj", "dev");
    await expect(p.get("JARVIS_X")).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(p.health).toBe("unavailable");
    expect(err.mock.calls.flat().join(" ")).toMatch(/infisical_url_unsafe/);
    expect(err.mock.calls.flat().join(" ")).not.toContain("secret");
    await expect(p.set("JARVIS_X", "v")).rejects.toThrow(/unsafe_vendor_url/);
  });

  it("Infisical: lesing bruker det korte taket (5 s), skriving det lengre (15 s)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/login")) return new Response(JSON.stringify({ accessToken: "t" }), { status: 200 });
      return new Response(JSON.stringify({ secret: { secretValue: "v" } }), { status: 200 });
    });
    const p = new InfisicalSecretProvider("http://infisical:8080", "id", "secret", "proj", "dev");
    await expect(p.get("JARVIS_X")).resolves.toBe("v");
    expect(timeoutSpy.mock.calls.map((c) => c[0])).toContain(5_000);
    timeoutSpy.mockClear();
    await p.set("JARVIS_X", "v2");
    expect(timeoutSpy.mock.calls.map((c) => c[0])).toContain(15_000);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserGatewayTransport } from "../src/browser-transport.ts";
import { McpZapierTransport } from "../src/mcp-zapier-transport.ts";

/**
 * Q-46 punkt 6 (D-436): ALLE utgående leverandørkall i tool-gateway går via `guardedFetch` (rå-URL-sjekk + timeout). Tidligere brukte
 * Infisical-gatewayen, Zapier-MCP og browser-gateway rå `fetch` mot konfigurerte base-URL-er.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

afterEach(() => vi.restoreAllMocks());

describe("D-436: ingen rå fetch i tool-gateway/src (kun guardedFetch i url-safety.ts)", () => {
  it("hver kilde-fil unntatt url-safety.ts er fri for kall til global fetch(", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(SRC).filter((n) => n.endsWith(".ts") && n !== "url-safety.ts")) {
      const code = readFileSync(join(SRC, f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      if (/(^|[^A-Za-z0-9_.])fetch\(/.test(code)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe("D-436: de tre konfigurerte base-URL-ene avvises når de er utrygge, og sendes ikke", () => {
  it("browser-gateway: dot-segment i base-URL avvises FØR noe sendes", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const t = new BrowserGatewayTransport("x".repeat(40));
    await expect(t.invoke("navigate", { url: "https://example.com" }, "http://browser-gateway:3030/../admin")).rejects.toThrow(/unsafe_vendor_url/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("browser-gateway: en ren intern URL sendes med et eksplisitt tak (ikke ubegrenset)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
    const t = new BrowserGatewayTransport("x".repeat(40));
    await t.invoke("navigate", { url: "https://example.com" }, "http://browser-gateway:3030");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe("http://browser-gateway:3030/invoke");
    expect((spy.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("zapier-MCP: en utrygg (backslash) server-URL avvises før noe sendes", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const t = new McpZapierTransport();
    await expect(t.invoke("list_tools", {}, "https://mcp.zapier.com\\evil/mcp")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

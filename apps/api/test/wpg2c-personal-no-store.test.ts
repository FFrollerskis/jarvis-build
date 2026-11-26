import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../src/server.ts";

/**
 * WP-G2c (D-483, JARVIS-113 e/5): ALT under `/personal/` bærer personopplysninger og svares med `Cache-Control: no-store` - også avvisningene (401/400/413/404) fra grant-/kropp-/feilgrenene, ikke bare 200-svarene.
 * Uten `deps.personal` (flagg AV) er svarene byte-identiske med main: ingen ny header, verken på `/personal/*` (404) eller på andre ruter. Ekte server på en loopback-port; ingen database.
 */
describe("`Cache-Control: no-store` på /personal/*", () => {
  const ingest = vi.fn(async () => ({ results: [], counts: {} }));
  const servers: Array<ReturnType<typeof createApiServer>> = [];
  async function start(deps: unknown): Promise<string> {
    const server = createApiServer(deps as never);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  afterAll(async () => { await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))); });

  let on = "";
  let off = "";
  beforeAll(async () => {
    on = await start({ personal: { health: { intake: { ingestBatch: ingest } } } });
    off = await start({});
  });

  const post = (base: string, path: string, body: string, headers: Record<string, string> = { "content-type": "application/json" }) => fetch(`${base}${path}`, { method: "POST", headers, body });

  it("flagg PÅ: 401 (grant mangler), 400 (ugyldig JSON), 413 (for stor kropp) og 404 (ukjent personlig sti, GET) bærer alle `no-store`", async () => {
    const noGrant = await post(on, "/personal/health/ingest", "{}");
    expect(noGrant.status).toBe(401);
    expect(noGrant.headers.get("cache-control")).toBe("no-store");
    expect(noGrant.headers.get("content-type")).toBe("application/json");

    const malformed = await post(on, "/personal/health/ingest", "{ikke json");
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("no-store");

    const tooLarge = await post(on, "/personal/health/ingest", JSON.stringify({ pad: "x".repeat(70 * 1024) }));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.get("cache-control")).toBe("no-store");

    const unknown = await fetch(`${on}/personal/finnes-ikke`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(ingest).not.toHaveBeenCalled(); // ingen av avvisningene nådde tjenesten
  });

  it("flagg PÅ: andre ruter får IKKE headeren (den er begrenset til `/personal/`), heller ikke en sti som bare ligner", async () => {
    for (const path of ["/finnes-ikke", "/personalx/health/ingest", "/personal", "/api/personal/health"]) {
      const res = await fetch(`${on}${path}`);
      expect(res.headers.get("cache-control"), path).toBeNull();
    }
  });

  it("flagg AV (ingen `deps.personal`): `/personal/*` er en vanlig 404 UTEN noen ny header - identisk med main", async () => {
    for (const [method, path] of [["POST", "/personal/health/ingest"], ["GET", "/personal/finnes-ikke"], ["POST", "/personal/actions/mutate"]] as const) {
      const res = await fetch(`${off}${path}`, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
      expect(res.status, path).toBe(404);
      expect(res.headers.get("cache-control"), path).toBeNull();
    }
  });
});

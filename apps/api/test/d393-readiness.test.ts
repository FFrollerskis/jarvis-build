import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer, makeReadiness, type ApiDeps } from "../src/server.ts";

/** D-393 (JARVIS-026): `/health` er ekte beredskap når en readiness-sjekk er koblet inn. */
const servers: Array<ReturnType<typeof createApiServer>> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

async function start(readiness?: ApiDeps["readiness"]): Promise<string> {
  const server = createApiServer(readiness ? ({ readiness } as unknown as ApiDeps) : undefined);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("JARVIS-026: /health speiler avhengighetene", () => {
  it("database nede → /health og /ready svarer 503 med komponentstatus, /live forblir 200", async () => {
    const url = await start(makeReadiness({ database: async () => { throw new Error("connection refused"); } }));
    for (const path of ["/health", "/ready"]) {
      const res = await fetch(`${url}${path}`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string; checks: Record<string, string> };
      expect(body.status).toBe("unavailable");
      expect(body.checks["database"]).toMatch(/^unavailable:/);
    }
    expect((await fetch(`${url}/live`)).status).toBe(200);
  });

  it("database frisk → 200 med checks.database=ok", async () => {
    const url = await start(makeReadiness({ database: async () => ({ rows: [] }) }));
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { checks: Record<string, string> }).checks["database"]).toBe("ok");
  });

  it("uten readiness (ren helse-modus) er /health uendret 200", async () => {
    const url = await start();
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it("makeReadiness: en sonde som henger gir timeout, og svaret gjenbrukes kort (ingen sonde-storm)", async () => {
    let calls = 0;
    let now = 0;
    const check = makeReadiness({ database: () => { calls += 1; return new Promise(() => undefined); } }, { timeoutMs: 20, cacheMs: 1000, now: () => now });
    const first = await check();
    expect(first.ready).toBe(false);
    expect(first.checks["database"]).toContain("timeout");
    await check();
    expect(calls).toBe(1);
    now += 1500;
    await check();
    expect(calls).toBe(2);
  });
});

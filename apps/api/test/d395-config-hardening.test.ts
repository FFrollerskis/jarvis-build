import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "../src/server.ts";
import { isProductionEnv, seedOwner } from "../src/seed.ts";

/**
 * D-395 (JARVIS-092): (1) helse-modus (uten avhengigheter) svarer 503 `not_configured` på HVER API-rute - ikke bare en stale håndskrevet liste (~25
 * nyere ruter ga 404); (2) demo-enheten `dev-web` seedes ikke i produksjon.
 */
let server: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  const s = createApiServer(undefined);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as AddressInfo;
  server = { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); }) };
});
afterAll(async () => {
  await server?.close();
});

describe("helse-modus: 503 not_configured på alle API-ruter", () => {
  it.each([
    ["POST", "/brief"],
    ["POST", "/memory/search"],
    ["POST", "/tasks/submit"],
    ["PUT", "/tasks/abc"],
    ["POST", "/devices/register"],
    ["POST", "/confirmations/execute"]
  ])("%s %s", async (method, path) => {
    const res = await fetch(`${server.url}${path}`, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("not_configured");
  });

  it("en ukjent GET er fortsatt 404 (ikke en API-rute)", async () => {
    expect((await fetch(`${server.url}/finnes-ikke`)).status).toBe(404);
  });

  it("/health svarer fortsatt i helse-modus", async () => {
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });
});

describe("dev-web-demoenheten i produksjon", () => {
  const owner = { tenant_id: "tenant-x", owner_person_id: "person-x", owner_display_name: "X" };
  const run = async (env: string | undefined): Promise<string[]> => {
    const sql: string[] = [];
    const pool = { query: async (text: string) => { sql.push(text); return { rows: [], rowCount: 0 }; } } as unknown as pg.Pool;
    const before = process.env["JARVIS_ENV"];
    if (env === undefined) delete process.env["JARVIS_ENV"]; else process.env["JARVIS_ENV"] = env;
    try {
      await seedOwner(pool, owner);
    } finally {
      if (before === undefined) delete process.env["JARVIS_ENV"]; else process.env["JARVIS_ENV"] = before;
    }
    return sql;
  };

  it("isProductionEnv gjenkjenner production/prod uavhengig av case og mellomrom", () => {
    for (const v of ["production", "PRODUCTION", " prod ", "Prod"]) expect(isProductionEnv(v), v).toBe(true);
    for (const v of [undefined, "", "dev", "staging", "producti"]) expect(isProductionEnv(v), String(v)).toBe(false);
  });

  it("produksjon: dev-web seedes IKKE, men eier, tjeneste- og stemmeenhet gjør det", async () => {
    const sql = (await run("production")).join("\n");
    expect(sql).not.toContain("dev-web");
    expect(sql).toContain("jarvis-core");
    expect(sql).toContain("INSERT INTO people");
  });

  it("dev/uset: dev-web seedes som før (e2e-testene og lokal utvikling er uendret)", async () => {
    expect((await run("dev")).join("\n")).toContain("dev-web");
    expect((await run(undefined)).join("\n")).toContain("dev-web");
  });
});

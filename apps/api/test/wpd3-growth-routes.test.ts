import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "../src/server.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): rutegrensene for skrivehandlingene mot annonse-/analyseplattformene.
 *  - FLAGG AV = main: uten `deps.growthWrites` finnes ingen `/growth/*`-rute (404 - ikke 401/403, som ville røpet at ruten finnes).
 *  - Kildevakt for rekkefølgen i hver rute (grant -> EIER -> step-up -> utførelse; lesing: kun klasse A i skrive-familiens navnerom FØR gatewayen), slik at en fremtidig refaktorering ikke
 *    kan omgå eier-/step-up-portene uten at testen blir rød.
 *  - Kildevakt for `main.ts`: verktøy og ruter registreres KUN bak flaggene (flagg-AV-identitet), og ingenting leses fra parametre.
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVER = readFileSync(join(ROOT, "apps/api/src/server.ts"), "utf8");
const MAIN = readFileSync(join(ROOT, "apps/api/src/main.ts"), "utf8");

function routeBlock(source: string, path: string): string {
  const start = source.indexOf(`url.pathname === "${path}"`);
  if (start < 0) throw new Error(`fant ikke ruten ${path}`);
  const next = source.slice(start + 1).search(/\n {2,4}if \((?:deps\.|req\.method)/);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

describe("A: flagg AV - rutene finnes ikke", () => {
  let server: ReturnType<typeof createApiServer>;
  let base = "";
  beforeAll(async () => {
    server = createApiServer({} as never);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it("alle fire ruter svarer 404 uten growthWrites (ikke 401/403)", async () => {
    for (const path of ["/growth/mutate", "/growth/read", "/growth/writes/list", "/growth/experiments"]) {
      const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "google_ads", action: "pause_campaign", parameters: {}, idempotency_key: "route-probe-0001" }) });
      expect(res.status, path).toBe(404);
    }
  });
});

describe("B: rekkefølgen i rutene er låst (kildevakt)", () => {
  it("/growth/mutate: deps.growthWrites -> grant -> requireOwner -> stepUpDenial -> executeGrowthWrite; kun egne feilkoder vises", () => {
    const block = routeBlock(SERVER, "/growth/mutate");
    const owner = block.indexOf("requireOwner(");
    const stepUp = block.indexOf("stepUpDenial(");
    const exec = block.indexOf("executeGrowthWrite(");
    expect(SERVER).toMatch(/if \(deps\.growthWrites && req\.method === "POST" && url\.pathname === "\/growth\/mutate"\)/);
    expect(block.indexOf("authedRequest(")).toBeGreaterThan(-1);
    expect(owner).toBeGreaterThan(block.indexOf("authedRequest("));
    expect(stepUp).toBeGreaterThan(owner);
    expect(exec).toBeGreaterThan(stepUp);
    expect(block).toContain('source: "owner_route"');
    expect(block).toContain("growth_write_rejected");
  });

  it("/growth/read: kun klasse A i skrive-familiens eget register (op.risk !== \"A\" avvises) FØR gateway.execute; utdata merkes ubetrodd", () => {
    const block = routeBlock(SERVER, "/growth/read");
    expect(block.indexOf("requireOwner(")).toBeGreaterThan(-1);
    const klass = block.indexOf('entry.op.risk !== "A"');
    const execute = block.indexOf("gateway.execute(");
    expect(klass).toBeGreaterThan(-1);
    expect(execute).toBeGreaterThan(klass);
    expect(block).toContain("growth_read_unknown_action");
    expect(block).toContain("output_trust: result.output_trust");
  });

  it("/growth/experiments: eier først, allowlist over de kjente eksperimenthandlingene, step-up for alt som ikke er klasse A, så gateway", () => {
    const block = routeBlock(SERVER, "/growth/experiments");
    expect(SERVER).toMatch(/if \(deps\.growthWrites\?\.experiments && req\.method === "POST" && url\.pathname === "\/growth\/experiments"\)/);
    const owner = block.indexOf("requireOwner(");
    const allow = block.indexOf("GROWTH_EXPERIMENT_TOOL_ACTIONS");
    const klass = block.indexOf('capability_class !== "A"');
    const stepUp = block.indexOf("stepUpDenial(");
    const execute = block.indexOf("gateway.execute(");
    expect(owner).toBeGreaterThan(-1);
    expect(allow).toBeGreaterThan(owner);
    expect(klass).toBeGreaterThan(allow);
    expect(stepUp).toBeGreaterThan(klass);
    expect(execute).toBeGreaterThan(stepUp);
    expect(block).toContain('tool_id: "growth"');
  });

  it("/growth/writes/list: eier først, kun lesing av journalen, status valideres mot kjent mengde", () => {
    const block = routeBlock(SERVER, "/growth/writes/list");
    expect(block.indexOf("requireOwner(")).toBeGreaterThan(-1);
    expect(block).toContain("journal.list(");
    expect(block).not.toContain("gateway.execute(");
    expect(block).toContain('"requested", "applied", "failed", "outcome_unknown"');
  });
});

describe("C: main.ts - flagg-AV-identitet (kildevakt)", () => {
  it("konfig leses fra miljøet via den delte parseren, og både verktøy og ruter er betinget", () => {
    expect(MAIN).toContain("growthWriteConfigFromEnv(process.env)");
    expect(MAIN).toMatch(/const growthWriteEnabled = growthWriteConfig\.platforms\.size > 0;/);
    expect(MAIN).toMatch(/const growthExperimentsEnabled = process\.env\["JARVIS_GROWTH_EXPERIMENTS"\] === "on";/);
    expect(MAIN).toMatch(/\.\.\.\(growthWriteEnabled \? growthWriteToolDefinitions\(growthWriteConfig, growthWriteTransports\) : \[\]\)/);
    expect(MAIN).toMatch(/\.\.\.\(growthExperimentRegistry \? growthExperimentToolDefinitions\(new GrowthExperimentTransport\(growthExperimentRegistry\)\) : \[\]\)/);
    expect(MAIN).toMatch(/\.\.\.\(growthWriteEnabled \|\| growthExperimentsEnabled\s*\?\s*\{\s*growthWrites:/);
  });

  it("nødbryter-proben leser den ekte finanstjenesten (kun `enabled === true` er «på»), og worker-prosessen registrerer aldri skriveverktøyene", () => {
    expect(MAIN).toContain("(await financeService.getKillSwitch(tenantId))?.enabled === true");
    const worker = readFileSync(join(ROOT, "apps/api/src/worker-main.ts"), "utf8");
    expect(worker).not.toContain("growthWriteToolDefinitions");
    expect(worker).not.toContain("growth_googleads");
  });
});

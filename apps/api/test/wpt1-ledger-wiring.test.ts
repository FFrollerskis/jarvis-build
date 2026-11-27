import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs uten typer (delt med ops/security)
import { SERVICE_ENV } from "../../../infra/local/service-env.mjs";

/**
 * WP-T1 K5 (JARVIS-103): kildenivå-vakt for innkoblingen (main.ts kan ikke importeres - samme presedens som de øvrige *-wiring-testene). Låser at ledger-avstemmingen er AV som standard og KUN er koblet inn bak
 * `JARVIS_TOOL_LEDGER_RECONCILE=on`: konfigurasjonen leses strengt ved oppstart, rutene og den daglige jobben finnes kun med flagget, worker-prosessen leser/registrerer ingenting, og flaggene er i api-manifestet (ikke worker).
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const MAIN = read("../src/main.ts");
const SERVER = read("../src/server.ts");
const WORKER = read("../src/worker-main.ts");
const EXAMPLE = read("../../../.env.example");
const FLAGS = ["JARVIS_TOOL_LEDGER_RECONCILE", "JARVIS_TOOL_LEDGER_RESERVED_TTL_MINUTES", "JARVIS_TOOL_LEDGER_UNVERIFIED_TTL_HOURS", "JARVIS_TOOL_LEDGER_RECONCILE_HOUR"];

describe("main.ts: konfigurasjon, rute og jobb", () => {
  it("konfigurasjonen parses strengt ved oppstart (stopper på en ukjent verdi), rett etter runtime-rollevakten og digest-modusvakten", () => {
    const roleGuard = MAIN.indexOf("await assertRuntimeRoleSafe(pool);");
    const digestGuard = MAIN.indexOf("assertRequestDigestModeValid(process.env);");
    const parse = MAIN.indexOf("const toolLedgerConfig = parseLedgerReconcileConfig(process.env);");
    expect(roleGuard).toBeGreaterThan(0);
    expect(digestGuard).toBeGreaterThan(roleGuard);
    expect(parse).toBeGreaterThan(digestGuard);
    expect(parse - digestGuard).toBeLessThan(900);
  });

  it("rute-deps settes KUN når flagget er på (betinget spread, ellers er `toolLedger` helt fraværende), og main.ts bygger ALDRI en egen eier-port for dem (`ownerGate` finnes fortsatt kun én gang)", () => {
    expect(MAIN).toMatch(/\.\.\.\(toolLedgerConfig\.enabled \? \{ toolLedger: \{ pool, gateway: toolGateway \} \} : \{\}\),/);
    expect([...MAIN.matchAll(/toolLedger:/g)]).toHaveLength(1);
    expect(MAIN.match(/\bownerGate\s*:/g)).toHaveLength(1);
    expect(MAIN.match(/ownerPredicate\(/g)).toHaveLength(1);
  });

  it("den daglige jobben er registrert KUN inne i `if (toolLedgerConfig.enabled)`, via failOnSweepFailures med samleren sendt inn, og med eget jobbnavn", () => {
    const block = MAIN.match(/if \(toolLedgerConfig\.enabled\) \{\n\s*new DailyScheduler\(\n\s*pool, "tool-ledger-reconcile", envHour\("JARVIS_TOOL_LEDGER_RECONCILE_HOUR", 5\)\n\s*\)\.start\(\(\) => failOnSweepFailures\("tool-ledger-reconcile", \(failures\) => runLedgerReconcileForAllTenants\(pool, toolLedgerConfig, failures\)\)\);\n\s*\}/);
    expect(block, "jobben skal ligge i en `if (toolLedgerConfig.enabled)`-blokk").not.toBeNull();
    expect([...MAIN.matchAll(/"tool-ledger-reconcile"/g)]).toHaveLength(2); // DailyScheduler-navnet og failOnSweepFailures-navnet er det samme
    expect([...MAIN.matchAll(/runLedgerReconcileForAllTenants\(/g)]).toHaveLength(1);
  });
});

describe("server.ts: kroken", () => {
  it("rutene finnes kun når `deps.toolLedger` er satt, og stien er avgrenset til `/tool-ledger/`", () => {
    expect(SERVER).toMatch(/if \(deps\.toolLedger && url\.pathname\.startsWith\("\/tool-ledger\/"\)\) \{\n\s*const handled = await handleToolLedgerRoute\(req, url\.pathname, \{ \.\.\.deps\.toolLedger, ownerGate: deps\.ownerGate \}, \{/);
    expect(SERVER).toContain("toolLedger?: ToolLedgerApiDeps;");
  });

  it("kroken bruker de samme hjelperne som visjons- og signalrutene (grant, eier-port, json, forespørsels-id)", () => {
    const start = SERVER.indexOf("handleToolLedgerRoute(req, url.pathname");
    const hook = SERVER.slice(start, start + 600);
    expect(hook).toContain("authed: (keys, maxBytes) => authedRequest(req, res, deps, keys, maxBytes)");
    expect(hook).toContain("requireOwner: (identity, subject) => requireOwner(res, deps, identity, subject)");
    expect(hook).toContain("json: (status, body) => json(res, status, body)");
    expect(hook).toContain("requestId: () => requestIdOf(res)");
  });
});

describe("worker og manifest", () => {
  it("worker-prosessen leser ingen av flaggene og registrerer ingen ledger-jobb eller -rute", () => {
    for (const flag of FLAGS) expect(WORKER, flag).not.toContain(flag);
    expect(WORKER).not.toContain("runLedgerReconcileForAllTenants");
    expect(WORKER).not.toContain("parseLedgerReconcileConfig");
  });

  it("alle fire flaggene er videresendt til api (og kun api), og dokumentert i .env.example som AV som standard", () => {
    for (const flag of FLAGS) {
      expect((SERVICE_ENV.api as string[]).includes(flag), `api ${flag}`).toBe(true);
      expect((SERVICE_ENV.worker as string[]).includes(flag), `worker ${flag}`).toBe(false);
      expect(EXAMPLE, flag).toMatch(new RegExp(`^# ${flag}=`, "m"));
    }
    expect(EXAMPLE).toMatch(/^# JARVIS_TOOL_LEDGER_RECONCILE=off$/m);
  });
});

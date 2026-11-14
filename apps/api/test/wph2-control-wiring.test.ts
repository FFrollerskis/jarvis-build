import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, ExecutiveService } from "@jarvis/executive";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { createValueCenter } from "../src/control-center/value.ts";

/**
 * WP-H2: koblingen i `main.ts` er låst av tester (som H0 sin eier-port): `main.ts` kan ikke importeres (den starter en server), så strukturen leses som tekst.
 *  - Drift/Verdi får rapportene via LATE funksjoner mot den ene `ExecutiveService`-instansen (`holder`), uten en parallell tjeneste;
 *  - golden-suite-kjøreren lages KUN med JARVIS_CONTROL_GOLDEN_SUITE=on, og begge flaggstyrte verktøy registreres KUN med sine flagg;
 *  - flaggnavnene kommer fra `CONTROL_FEATURE_FLAGS` (ingen duplikat-streng i main.ts);
 *  - og kjøretidsbeviset: en tjeneste som ikke er bygget ennå gir ærlig UKJENT (aldri en kastet feil eller «i orden»).
 */
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const MAIN = readFileSync(resolve(REPO_ROOT, "apps/api/src/main.ts"), "utf8");
const WORKER = readFileSync(resolve(REPO_ROOT, "apps/api/src/worker-main.ts"), "utf8");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const MAIN_CODE = strip(MAIN);

function blockAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`fant ikke «${marker}» i main.ts`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`ubalansert blokk etter «${marker}»`);
}

describe("kildevakt: main.ts kobler Drift og Verdi til den ene ExecutiveService-instansen", () => {
  const wiring = blockAfter(MAIN_CODE, "registerControlCenters(controlCenters,");

  it("registerControlCenters får late funksjoner for verdirapporten og driftsstatusen, backup-kilden og prosessens starttidspunkt", () => {
    expect(wiring).toMatch(/valueReport:\s*\(tenantId\)\s*=>\s*lateExecutive\(\)\.getValueReport\(tenantId\)/);
    expect(wiring).toMatch(/infraStatus:\s*\(tenantId\)\s*=>\s*lateExecutive\(\)\.getInfraStatus\(tenantId\)/);
    expect(wiring).toMatch(/backupStatus:\s*backupStatusSource/);
    expect(wiring).toMatch(/processStartedAt:\s*\(\)\s*=>\s*processStartedAt/);
  });

  it("den late funksjonen leser ÉN holder som ExecutiveService fyller i konstruktøren - ingen ekstra ExecutiveService, og holderen sendes inn i den ene konstruksjonen", () => {
    expect(MAIN_CODE).toMatch(/const executiveRef: \{ service\?: ExecutiveService \} = \{\};/);
    expect(MAIN_CODE).toMatch(/const lateExecutive = \(\): ExecutiveService => \{\s*if \(executiveRef\.service === undefined\) throw new Error\("executive_service_not_ready"\);\s*return executiveRef\.service;\s*\};/);
    expect(MAIN_CODE.match(/new ExecutiveService\(/g)).toHaveLength(1);
    expect(MAIN_CODE).toMatch(/holder:\s*executiveRef\b/);
  });

  it("Policy-/eier-koblingen er uendret: registeret lages fortsatt kun via fabrikken, og registerControlCenters får samme eier-objekt", () => {
    expect(MAIN_CODE).toMatch(/createControlCenterRegistry\(\{ authority: ownerAuthority \}\)/);
    expect(wiring).toMatch(/authority:\s*ownerAuthority\b/);
    expect(MAIN_CODE).not.toMatch(/new ControlCenterRegistry\(/);
  });
});

describe("kildevakt: de to flaggstyrte funksjonene finnes kun med sine flagg", () => {
  it("golden-suite-kjøreren lages KUN i en betinget (flagget `on`) og har kun verktøyflaten som avhengighet - ingen modell, ingen pool", () => {
    expect(MAIN_CODE.match(/createGoldenSuiteRunner\(/g)).toHaveLength(1);
    expect(MAIN_CODE).toMatch(/const goldenSuiteRunner = flagOn\(process\.env, CONTROL_FEATURE_FLAGS\.goldenSuite\) \? createGoldenSuiteRunner\(\{ surface: \(\) => modelToolSurface \}\) : undefined;/);
  });

  it("kjøreren når kun to steder: Sikkerhet-senteret (via registerControlCenters) og ExecutiveService - begge betinget, aldri ubetinget", () => {
    expect(MAIN_CODE).toMatch(/\.\.\.\(goldenSuiteRunner \? \{ goldenSuite: goldenSuiteRunner \} : \{\}\)/);
    expect(MAIN_CODE.match(/goldenSuite: goldenSuiteRunner \}/g)).toHaveLength(2);
    expect(MAIN_CODE.match(/\bgoldenSuiteRunner\b/g)?.length).toBeLessThanOrEqual(7);
  });

  it("executiveToolDefinitions får flaggene som valg: `run_golden_suite` bare med en kjører, `revoke_autonomy_binding` bare med JARVIS_CONTROL_AUTONOMY_REVOKE=on", () => {
    expect(MAIN_CODE).toMatch(/\{ goldenSuite: goldenSuiteRunner !== undefined, autonomyRevoke: flagOn\(process\.env, CONTROL_FEATURE_FLAGS\.autonomyRevoke\) \}/);
  });

  it("flaggnavnene står ikke som strenger i main.ts (de kommer fra CONTROL_FEATURE_FLAGS), og workeren registrerer ingen av de to handlingene", () => {
    for (const flag of ["JARVIS_CONTROL_GOLDEN_SUITE", "JARVIS_CONTROL_AUTONOMY_REVOKE", "JARVIS_CONTROL_CENTER_OPERATIONS", "JARVIS_CONTROL_CENTER_VALUE", "JARVIS_CONTROL_CENTER_PRIVACY", "JARVIS_CONTROL_CENTER_SECURITY"]) {
      expect(MAIN_CODE, flag).not.toContain(flag);
    }
    expect(WORKER).not.toContain("run_golden_suite");
    expect(WORKER).not.toContain("revoke_autonomy_binding");
    expect(WORKER).not.toContain("goldenSuite");
  });
});

describe("kjøretid: holderen og den late funksjonen", () => {
  const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;

  it("ExecutiveService legger seg selv i holderen i konstruktøren (og en tjeneste uten holder rører ingenting)", () => {
    const holder: { service?: ExecutiveService } = {};
    const svc = new ExecutiveService(fakeGw, { holder });
    expect(holder.service).toBe(svc);
    expect(() => new ExecutiveService(fakeGw)).not.toThrow();
    expect(() => new ExecutiveService(fakeGw, {})).not.toThrow();
  });

  it("FØR tjenesten er bygget gir Verdi-senteret ærlig UKJENT i hver seksjon (aldri en kastet feil, aldri «i orden») - og ETTER bygging leser den tjenestens rapport", async () => {
    const holder: { service?: ExecutiveService } = {};
    const late = (): ExecutiveService => { if (holder.service === undefined) throw new Error("executive_service_not_ready"); return holder.service; };
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => new Date("2026-11-14T10:00:00.000Z") });
    registry.register(createValueCenter({ valueReport: (t) => late().getValueReport(t) }));
    const before = await registry.report("value", owner);
    expect(before?.status).toBe("UNKNOWN");
    for (const s of before?.sections ?? []) expect(s).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(JSON.stringify(before)).toContain("kunne ikke leses");
    expect(JSON.stringify(before)).not.toContain("executive_service_not_ready"); // kun feilkategorien vises, aldri meldingsteksten
    new ExecutiveService(fakeGw, { holder });
    const after = await registry.report("value", owner);
    expect(after?.sections.every((s) => s.measured)).toBe(true);
    expect(after?.status).toBe("UNKNOWN"); // uten verdikilde er målingene ikke målbare - aldri 0, aldri OK
  });
});

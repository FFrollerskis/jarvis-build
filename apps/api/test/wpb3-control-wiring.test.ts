import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WP-B3 (D-475, EV-22): koblingen av Evolusjon-senteret er låst av kildevakter (`main.ts` kan ikke importeres - den starter en server - så strukturen leses som tekst, som `wph2-control-wiring.test.ts`):
 *  - rapportkildene til evolusjonsrapporten er trukket ut til ÉN verdi (`evolutionSourceDeps`) som både rapporten og beredskapen bruker - ingen parallell kobling, og rapporten er uendret;
 *  - `registerControlCenters` får rapporten, beredskapen, oppstartssjekken og eierens tenant (som rapportleverandøren er bundet til);
 *  - senteret er KUN LESING: ingen skriving, ingen nettverk, ingen filsystem, ingen direkte miljølesing, ingen leverandør-SDK, og endringsregisteret leses bare med SELECT og uten tekstkolonnene;
 *  - flaggnavnet kommer fra `CONTROL_CENTER_FLAGS` (ingen duplikat-streng i `main.ts`), og workeren vet ikke om senteret.
 */
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), "utf8");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const MAIN = strip(read("apps/api/src/main.ts"));
const WORKER = strip(read("apps/api/src/worker-main.ts"));
const CENTER_RAW = read("apps/api/src/control-center/evolution.ts");
const CENTER = strip(CENTER_RAW);
const SOURCE = strip(read("apps/api/src/evolution-source.ts"));

function blockAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`fant ikke «${marker}»`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`ubalansert blokk etter «${marker}»`);
}

describe("kildevakt: main.ts kobler Evolusjon-senteret til de eksisterende kildene (ingen parallell kobling)", () => {
  it("kildene til evolusjonsrapporten er ÉN verdi (`evolutionSourceDeps`); rapporten og beredskapen bygges begge av den, og rapporten har samme kilder som før", () => {
    expect(MAIN).toMatch(/const evolutionSourceDeps: EvolutionSourceDeps = \{/);
    expect(MAIN.match(/createEvolutionReportProvider\(/g)).toHaveLength(1);
    expect(MAIN).toMatch(/const evolutionReports = createEvolutionReportProvider\(evolutionSourceDeps\);/);
    expect(MAIN).toMatch(/const evolutionReadiness = createEvolutionReadinessProvider\(evolutionSourceDeps\);/);
    const deps = blockAfter(MAIN, "const evolutionSourceDeps: EvolutionSourceDeps =");
    for (const source of ["radar: evolutionRadar", "resensitize: () => lastResensitize", "pool,", "tenantId: owner.tenant_id", "ev0Status: () => getLastEv0BootStatus()", "slo: sloReports", "connectors: () => listConnectorStatus(toolGateway)", "mesh: () => gateway.meshStatus()", "toolSurface: () => modelToolSurface"]) {
      expect(deps, source).toContain(source);
    }
    // ExecutiveService får fortsatt den samme rapporten (get_evolution_report er uendret)
    expect(MAIN).toMatch(/evolution: \{ report: evolutionReports \}/);
  });

  it("registerControlCenters får rapporten, beredskapen, EV-0-oppstartssjekken og eierens tenant; run-rate-kilden er den som allerede finnes (ingen ny instans)", () => {
    const wiring = blockAfter(MAIN, "registerControlCenters(controlCenters,");
    expect(wiring).toMatch(/evolutionReport:\s*evolutionReports\b/);
    expect(wiring).toMatch(/evolutionReadiness,/);
    expect(wiring).toMatch(/ev0Status:\s*\(\)\s*=>\s*getLastEv0BootStatus\(\)/);
    expect(wiring).toMatch(/evolutionTenantId:\s*owner\.tenant_id/);
    // uendret fra main: to instanser fantes allerede (AI-senteret og `/runrate`-verktøyet); Evolusjon-senteret bruker den samme `runRate` som ble sendt inn til registerControlCenters
    expect(MAIN.match(/new RunRateService\(/g)?.length).toBe(2);
    expect(MAIN.match(/createEvolutionReadinessProvider\(/g)).toHaveLength(1);
  });

  it("flaggnavnet står ikke som streng i main.ts (det kommer fra CONTROL_CENTER_FLAGS), og workeren registrerer ingenting av dette", () => {
    expect(MAIN).not.toContain("JARVIS_CONTROL_CENTER_EVOLUTION");
    for (const needle of ["JARVIS_CONTROL_CENTER_EVOLUTION", "createEvolutionCenter", "createEvolutionReadinessProvider", "get_evolution_center", "evolutionReadiness"]) expect(WORKER, needle).not.toContain(needle);
  });

  it("verktøyet registreres gjennom den ene felles veien (`controlCentersWithTools`) - ingen egen registrering av get_evolution_center i main.ts", () => {
    expect(MAIN).toMatch(/controlCenters: controlCentersWithTools\(process\.env, controlCenters\)/);
    expect(MAIN).not.toContain("get_evolution_center");
  });
});

describe("kildevakt: Evolusjon-senteret er KUN LESING av eksisterende kilder", () => {
  it("ingen skriving (INSERT/UPDATE/DELETE/TRUNCATE/DROP/ALTER), ingen nettverk, ingen filsystem og ingen prosess-/skall-tilgang i composeren", () => {
    expect(CENTER).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\s+(INTO|TABLE|FROM|ON)?\b.*\b(evolution|audit|cost|ledger)/i);
    expect(CENTER).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE)\b/i);
    expect(CENTER).not.toMatch(/\bfetch\s*\(|node:(fs|http|https|net|child_process|dns|tls)|\bprocess\.env\b|\bspawn\(|\bexecSync\(|\bexecFile\(|child_process/);
    expect(CENTER).not.toMatch(/\bwriteAudit\b|\.execute\(|ToolGateway|gateway\.execute/);
  });

  it("importerer kun executive-kontrakten, modellgatewayens BudgetGuard/budsjettgrenser, de rene EV-reglene og delte hjelpere - ingen leverandør-SDK", () => {
    const imports = [...CENTER_RAW.matchAll(/^import[\s\S]*?from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../ev0-boot.ts", "../run-rate.ts", "./shared.ts", "@jarvis/executive", "@jarvis/model-gateway", "@jarvis/self-modification", "pg"].sort());
  });

  it("endringsregisteret leses bare med SELECT og uten tekstkolonnene (subject, paths-innhold, evidence, branch, recorded_by, head_sha)", () => {
    const sqlBlocks = [...CENTER_RAW.matchAll(/`(SELECT[\s\S]*?)`/g)].map((m) => m[1] as string);
    expect(sqlBlocks.length).toBeGreaterThanOrEqual(3);
    for (const sql of sqlBlocks) {
      expect(sql, sql).toMatch(/^SELECT /);
      for (const forbidden of ["subject", "evidence", "branch", "recorded_by", "head_sha", "SELECT *", "t.paths,", " paths "]) {
        if (forbidden === " paths ") continue; // `cardinality(t.paths)` (antall) er tillatt; selve listen leses aldri
        expect(sql, `${forbidden} i ${sql.slice(0, 60)}`).not.toContain(forbidden);
      }
    }
    // stiene telles (`cardinality`), de leses aldri
    expect(CENTER_RAW).toContain("cardinality(t.paths)::int AS path_count");
    expect(CENTER_RAW).not.toMatch(/\bt\.paths\b(?!\))/);
  });

  it("miljøet leses kun via `deps.env` (injisert), og kostnadsgrensene via den ene kilden `budgetConfigFromEnv` - ingen egen tolkning av JARVIS_COST_*", () => {
    expect(CENTER).toMatch(/budgetConfigFromEnv\(\{ \.\.\.deps\.env \}\)/);
    expect(CENTER).not.toMatch(/parseInt\(|Number\.parseInt|envInt\(/);
  });

  it("beredskapsleverandøren i evolution-source.ts er additiv: rapportens egne funksjoner og seksjonsliste er uendret, og leverandøren cacher en feilet vurdering ikke", () => {
    expect(SOURCE).toMatch(/export async function evaluateEvolutionReadiness\(deps: EvolutionSourceDeps\): Promise<ReadinessVerdict\[\]>/);
    expect(SOURCE).toMatch(/export function createEvolutionReadinessProvider\(/);
    expect(SOURCE).toMatch(/verdicts\.catch\(\(\) => \{ if \(cached\?\.verdicts === verdicts\) cached = undefined; \}\);/);
    // seksjonslisten i rapporten har fortsatt nøyaktig de samme tolv seksjonene
    expect(SOURCE.match(/\{ ev: "EV-[^"]+", title: "[^"]+", source: "[^"]+", build: \w+ \}/g)).toHaveLength(12);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-195 (infra-slice): `main.ts`/`worker-main.ts` er top-level side-effekt-
 * skript (kobler til DB og starter en server/lytter idet de importeres) -
 * kan derfor IKKE trygt importeres direkte i en testfil, samme presedens
 * som `drive-runtime-wiring.test.ts`/`db-role-wiring.test.ts`. Denne suiten
 * verifiserer at den allerede-konstruerte `incidentService` faktisk NÅS
 * frem til `runSituationSweepForAllTenants()`-kallet, som en tekst-/
 * regresjonsvakt i stedet.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const mainSource = readSource("../src/main.ts");
const workerSource = readSource("../src/worker-main.ts");

describe("A: main.ts sitt situation-sweep-kall wirer inn incidentService (D-195)", () => {
  it("runSituationSweepForAllTenants(pool, {...}) inneholder 'incidents: incidentService' i SAMME objektliteral som openLoops/engine/gateway", () => {
    const callIdx = mainSource.indexOf("runSituationSweepForAllTenants(pool, {");
    expect(callIdx).toBeGreaterThan(-1);
    const callBlock = mainSource.slice(callIdx, mainSource.indexOf(".then(assertSituationSweepHealthy)", callIdx));
    expect(callBlock).toContain("openLoops: openLoopService");
    expect(callBlock).toContain("incidents: incidentService");
    expect(callBlock).toContain("engine: situationEngine");
    expect(callBlock).toContain("gateway: toolGateway");
  });

  it("incidentService er den SAMME, allerede eksisterende instansen (UA-5/D-104) - ingen ny/parallell IncidentService konstrueres for sveipet", () => {
    expect([...mainSource.matchAll(/new IncidentService\(/g)]).toHaveLength(1);
  });
});

describe("B: worker-main.ts har (bevisst, uendret siden D-194) INGEN DailyScheduler-baserte jobber - situation-sweep bor KUN i main.ts", () => {
  it("worker-main.ts nevner verken runSituationSweepForAllTenants eller DailyScheduler", () => {
    expect(workerSource).not.toMatch(/runSituationSweepForAllTenants/);
    expect(workerSource).not.toMatch(/DailyScheduler/);
  });
});

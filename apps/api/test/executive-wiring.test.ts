import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UA-11 Executive Mode P0 (D-162): komposisjons-rot-regresjonsvakt - SAMME
 * "text-/regresjonsvakt for et side-effekt-skript"-mønster som
 * `drive-runtime-wiring.test.ts` (main.ts/worker-main.ts kobler til DB og
 * starter en server idet de importeres, og kan derfor ikke trygt importeres
 * direkte i en testfil).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const mainSource = readSource("../src/main.ts");
const workerSource = readSource("../src/worker-main.ts");

describe("A: apps/api/src/main.ts komponerer executiveToolDefinitions() INNI SAMME firstWaveTools()-additionalTools-liste som situationsToolDefinitions()", () => {
  it("importerer ExecutiveService/ExecutiveTransport/executiveToolDefinitions fra @jarvis/executive", () => {
    expect(mainSource).toMatch(/import\s*\{[^}]*ExecutiveService[^}]*ExecutiveTransport[^}]*executiveToolDefinitions[^}]*\}\s*from\s*"@jarvis\/executive"/s);
  });
  it("kaller executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(toolGateway, { modelSurface }))) INNI additionalTools - IKKE et separat, parallelt registreringssted", () => {
    const callIdx = mainSource.indexOf("firstWaveTools({");
    expect(callIdx).toBeGreaterThan(-1);
    const callBlock = mainSource.slice(callIdx, mainSource.indexOf("})) toolGateway.register(tool);", callIdx));
    expect(callBlock).toContain("additionalTools: [");
    expect(callBlock).toContain("...situationsToolDefinitions(new SituationsTransport(situationEngine, situationDomainPauses))");
    // Remediering del 1: ExecutiveService får den eksplisitte modellflaten, slik at
    // `check_my_capabilities` aldri påstår at hele registeret er tilgjengelig for modellen.
    expect(callBlock).toContain(
      "...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(toolGateway, { modelSurface: [...MODEL_SURFACE_ALLOWLIST, ...MODEL_SURFACE_QUARANTINE_WRITES] })))"
    );
  });
  it("ExecutiveService konstrueres med DEN SAMME toolGateway-instansen (nøstet gateway.execute(), aldri situationEngine/situationDomainPauses direkte)", () => {
    expect(mainSource).not.toMatch(/new ExecutiveService\(\s*situationEngine/);
    expect(mainSource).toContain("new ExecutiveService(toolGateway, { modelSurface: [...MODEL_SURFACE_ALLOWLIST, ...MODEL_SURFACE_QUARANTINE_WRITES] })");
  });
});

describe("B: apps/api/src/worker-main.ts kobler BEVISST IKKE executive.* - eksplisitt, testet fravær (D-162), ikke et uundersøkt hull", () => {
  it("importerer ikke @jarvis/executive - Executive Mode er en API-/HTTP-flate (samme klasse som situations selv, uendret av denne sliceen)", () => {
    expect(workerSource).not.toContain("@jarvis/executive");
  });
});

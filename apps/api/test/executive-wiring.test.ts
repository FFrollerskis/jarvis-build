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
      "...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(toolGateway, { modelSurface: [...MODEL_SURFACE_ALLOWLIST, ...MODEL_SURFACE_QUARANTINE_WRITES, ...CHAT_READ_TIER, ...CHAT_ACT_TIER],"
    );
    // EV-1 (D-412): selvmodellens lesere kobles inn i SAMME ExecutiveService-instans (ingen parallell tjeneste).
    expect(callBlock).toContain("selfModel: {");
    expect(callBlock).toContain("readers: selfModelReaders");
  });
  it("ExecutiveService konstrueres med DEN SAMME toolGateway-instansen (nøstet gateway.execute(), aldri situationEngine/situationDomainPauses direkte)", () => {
    expect(mainSource).not.toMatch(/new ExecutiveService\(\s*situationEngine/);
    expect(mainSource).toContain("new ExecutiveService(toolGateway, { modelSurface: [...MODEL_SURFACE_ALLOWLIST, ...MODEL_SURFACE_QUARANTINE_WRITES, ...CHAT_READ_TIER, ...CHAT_ACT_TIER],");
    expect(mainSource.match(/new ExecutiveService\(/g)).toHaveLength(1);
  });
});

describe("B: apps/api/src/worker-main.ts kobler KUN executive.get_capability_status (D-433: workeren eier executive-køen) - ikke resten av Executive Mode-flaten (D-162)", () => {
  it("registrerer executive-verktøyene FILTRERT til nøyaktig handlingen bakgrunnsflaten er tildelt; ingen andre executive.*-handlinger i workeren", () => {
    expect(workerSource).toContain("@jarvis/executive");
    expect(workerSource).toMatch(/executiveToolDefinitions\(new ExecutiveTransport\([\s\S]*?\)\)\)\.filter\(\(d\) => d\.action === "get_capability_status"\)/);
    expect(workerSource).not.toContain("situationsToolDefinitions");
    expect(workerSource).not.toContain("governanceToolDefinitions");
    expect(workerSource).not.toContain("ownerControlsToolDefinitions");
  });
});

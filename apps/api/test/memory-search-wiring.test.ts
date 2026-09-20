import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * "Charlie"-minne-verifisering (task #118): komposisjons-rot-regresjonsvakt -
 * SAMME "text-/regresjonsvakt for et side-effekt-skript"-mønster som
 * `executive-wiring.test.ts` (main.ts/worker-main.ts kobler til DB og
 * starter en server idet de importeres, kan derfor ikke trygt importeres
 * direkte i en testfil).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const mainSource = readSource("../src/main.ts");
const workerSource = readSource("../src/worker-main.ts");

describe("A: apps/api/src/main.ts registrerer memory.search i SAMME additionalTools-liste, med DEN SAMME memoryRetriever-instansen ConversationEngine bruker", () => {
  it("importerer MemorySearchTransport/memoryToolDefinitions fra @jarvis/tool-gateway", () => {
    expect(mainSource).toMatch(/import\s*\{[^}]*MemorySearchTransport[^}]*\}\s*from\s*"@jarvis\/tool-gateway"/s);
    expect(mainSource).toMatch(/import\s*\{[^}]*memoryToolDefinitions[^}]*\}\s*from\s*"@jarvis\/tool-gateway"/s);
  });

  it("konstruerer memoryRetriever ÉN gang og gjenbruker DEN i BEGGE additionalTools OG conversationEngine - ikke to separate instanser", () => {
    const constructions = mainSource.match(/new MemoryRetriever\(/g) ?? [];
    expect(constructions).toHaveLength(1);
    expect(mainSource).toContain("new MemorySearchTransport(memoryRetriever)");
    expect(mainSource).toContain("memory: memoryRetriever,");
  });

  it("kaller memoryToolDefinitions(new MemorySearchTransport(memoryRetriever)) INNI additionalTools - IKKE et separat, parallelt registreringssted", () => {
    const callIdx = mainSource.indexOf("firstWaveTools({");
    expect(callIdx).toBeGreaterThan(-1);
    const callBlock = mainSource.slice(callIdx, mainSource.indexOf("})) toolGateway.register(tool);", callIdx));
    expect(callBlock).toContain("additionalTools: [");
    expect(callBlock).toContain("...memoryToolDefinitions(new MemorySearchTransport(memoryRetriever))");
  });
});

describe("B: apps/api/src/worker-main.ts kobler BEVISST IKKE memory.search - samme klasse som situations/executive/governance selv (API-/HTTP-flate)", () => {
  it("importerer ikke MemorySearchTransport", () => {
    expect(workerSource).not.toContain("MemorySearchTransport");
  });
});

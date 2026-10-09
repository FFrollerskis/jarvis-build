import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WP-D1 (UA-2, JARVIS-060): komposisjons-rot-regresjonsvakt for `knowledge.search` - samme tekstvakt-mønster som `memory-search-wiring.test.ts` (main.ts/worker-main.ts kobler til DB og starter en
 * server idet de importeres, og kan derfor ikke importeres i en testfil).
 */
const read = (relativePath: string): string => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
const main = read("../src/main.ts");
const worker = read("../src/worker-main.ts");
const conversation = read("../src/conversation.ts");

describe("A: main.ts kobler kunnskapssøket til chatten", () => {
  it("importerer KnowledgeRetriever fra @jarvis/knowledge og transport/definisjoner fra @jarvis/tool-gateway", () => {
    expect(main).toMatch(/import\s*\{[^}]*KnowledgeRetriever[^}]*\}\s*from\s*"@jarvis\/knowledge"/s);
    expect(main).toMatch(/import\s*\{[^}]*KnowledgeSearchTransport[^}]*\}\s*from\s*"@jarvis\/tool-gateway"/s);
    expect(main).toMatch(/import\s*\{[^}]*knowledgeToolDefinitions[^}]*\}\s*from\s*"@jarvis\/tool-gateway"/s);
  });

  it("konstruerer KnowledgeRetriever ÉN gang, med den delte lokale embedding-leverandøren, og registrerer verktøyet INNI additionalTools (samme register-løkke som alt annet)", () => {
    expect(main.match(/new KnowledgeRetriever\(/g) ?? []).toHaveLength(1);
    expect(main).toContain("new KnowledgeRetriever(pool, memoryEmbedding)");
    const callIdx = main.indexOf("firstWaveTools({");
    const callBlock = main.slice(callIdx, main.indexOf("})) toolGateway.register(tool);", callIdx));
    expect(callBlock).toContain("additionalTools: [");
    expect(callBlock).toContain("...knowledgeToolDefinitions(new KnowledgeSearchTransport(knowledgeRetriever))");
  });
});

describe("B: kunnskapssøket står IKKE på bakgrunnsflaten (minste privilegium) - workeren registrerer ingen kunnskapstransport", () => {
  it("worker-main.ts registrerer ikke knowledge-verktøyet (bakgrunnsjobber får ikke kunnskapssøk i denne leveransen)", () => {
    expect(worker).not.toContain("KnowledgeSearchTransport");
    expect(worker).not.toContain("knowledgeToolDefinitions");
  });
});

describe("C: chatten skjermer kunnskapstreff mot skymodeller og sier fra", () => {
  it("conversation.ts bruker cloudScreenedExecutor for verktøyresultater og har en egen merknad for kunnskapstreff", () => {
    expect(conversation).toContain("cloudScreenedExecutor(");
    expect(conversation).toContain("servedByCloudModel");
    expect(conversation).toContain("chatKnowledgeWithheldNote");
  });
});

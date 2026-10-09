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
    expect(callBlock).toContain("...knowledgeToolDefinitions(new KnowledgeSearchTransport(knowledgeRetriever, knowledgeClaims), { claimWrites: knowledgeClaimWrites })");
  });
});

describe("A2: Q-26 påstandsverifisering - lesing alltid på, SKRIVING av som standard (kun den eksakte verdien «on»)", () => {
  it("main.ts bygger claims-porten ÉN gang fra ClaimVerificationService, med promotering KUN via MemoryWriter (karantenen), og skriving styrt av JARVIS_KNOWLEDGE_CLAIM_WRITES=on", () => {
    expect(main).toMatch(/import\s*\{[^}]*ClaimVerificationService[^}]*createKnowledgeClaimsPort[^}]*\}\s*from\s*"@jarvis\/knowledge"/s);
    expect(main.match(/new ClaimVerificationService\(/g) ?? []).toHaveLength(1);
    expect(main.match(/createKnowledgeClaimsPort\(/g) ?? []).toHaveLength(1);
    expect(main).toContain('const knowledgeClaimWrites = (process.env["JARVIS_KNOWLEDGE_CLAIM_WRITES"] ?? "").trim().toLowerCase() === "on";');
    expect(main).toContain("{ writes: knowledgeClaimWrites, promotion: memoryWriter }");
    // Promotering bruker det vanlige minnet (karantene-veien), aldri en direkte skriving: ingen annen vei til memory_items fra claims-koden.
    expect(main).not.toMatch(/claim[^\n]*INSERT INTO memory_items/i);
    // Claims-porten opprettes ETTER memoryWriter (den brukes som promoteringsvei).
    expect(main.indexOf("const memoryWriter = new MemoryWriter(")).toBeLessThan(main.indexOf("const knowledgeClaims = createKnowledgeClaimsPort("));
  });
});

describe("B: kunnskapssøket står IKKE på bakgrunnsflaten (minste privilegium) - workeren registrerer ingen kunnskapstransport", () => {
  it("worker-main.ts registrerer ikke knowledge-verktøyet (bakgrunnsjobber får ikke kunnskapssøk i denne leveransen)", () => {
    expect(worker).not.toContain("KnowledgeSearchTransport");
    expect(worker).not.toContain("knowledgeToolDefinitions");
  });
});

describe("B2: worker-main.ts kjører de KONFIGURERTE kunnskapskildene - dvale uten konfig, alt-eller-ingenting, tenant fra eieren", () => {
  const block = worker.slice(worker.indexOf("let configuredKnowledgeSources"), worker.indexOf('console.log(JSON.stringify({ msg: "jarvis-worker started"'));

  it("leser JARVIS_KNOWLEDGE_SOURCES/_FS_ROOTS/_ENTITY_LLM og parser dem med den lukkede parseren; en avvist konfig gir INGEN kilder og en høylytt feillogg (uten å velte workeren)", () => {
    expect(block).toContain('process.env["JARVIS_KNOWLEDGE_SOURCES"]');
    expect(block).toContain('process.env["JARVIS_KNOWLEDGE_FS_ROOTS"]');
    expect(block).toContain('process.env["JARVIS_KNOWLEDGE_ENTITY_LLM"]');
    expect(block).toContain("parseKnowledgeSources(");
    expect(block).toContain("parseFilesystemRoots(");
    const catchIdx = block.indexOf("} catch (err) {");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBlock = block.slice(catchIdx, block.indexOf("const knowledgeEntityLlmMode"));
    expect(catchBlock).toContain("configuredKnowledgeSources = [];");
    expect(catchBlock).toContain("console.error(");
    expect(catchBlock).toContain("knowledge_sources_config_rejected");
    expect(catchBlock).not.toContain("process.exit");
    expect(catchBlock).not.toContain("throw ");
  });

  it("tenant kommer fra eier-identiteten (aldri konfigurasjonen), GitHub-låsen og email:inbox-reservasjonen er med, og DB-skrivingene går som app-rolle (samme pool)", () => {
    expect(block).toContain("tenant_id: owner.tenant_id");
    expect(block).toContain("github_repo: configuredGithubRepo()");
    expect(block).toContain("github_unlocked: githubReposUnlocked()");
    expect(block).toContain('reserved: [{ memory_space: "personal", id: "email:inbox" }]');
    expect(block).toContain("pool, embeddings: memoryEmbedding, sources: configuredKnowledgeSources");
    expect(worker.match(/new KnowledgeSyncRunner\(/g) ?? []).toHaveLength(1);
    expect(worker.match(/knowledgeSyncRunner\.start\(\)/g) ?? []).toHaveLength(1);
  });

  it("preflight håndhever allowlisten rett før hver synk (sann rot) og Drive-credentialen; modellpasset er AV som standard (kun når modus != off)", () => {
    expect(block).toContain("verifyFilesystemRoot(source.config.root_path, knowledgeFsRoots)");
    expect(block).toContain("verifyFilesystemRoot(source.config.vault_root, knowledgeFsRoots)");
    expect(block).toContain('"drive_credentials_missing"');
    expect(block).toContain('llmPass: knowledgeEntityLlmMode === "off" ? undefined : new KnowledgeLlmEntityPass(');
    expect(block).toContain("entityIndexer: new KnowledgeEntityIndexer()");
  });

  it("den statiske email:inbox-registryen er uendret og egen (konfigurerte kilder går via en SEPARAT registry)", () => {
    expect(worker.match(/new KnowledgeSourceRegistry\(/g) ?? []).toHaveLength(2);
    expect(worker).toContain("const configuredKnowledgeRegistry = new KnowledgeSourceRegistry(configuredKnowledgeSources.map((source) => source.config));");
  });
});

describe("C: chatten skjermer kunnskapstreff mot skymodeller og sier fra", () => {
  it("conversation.ts bruker cloudScreenedExecutor for verktøyresultater og har en egen merknad for kunnskapstreff", () => {
    expect(conversation).toContain("cloudScreenedExecutor(");
    expect(conversation).toContain("servedByCloudModel");
    expect(conversation).toContain("chatKnowledgeWithheldNote");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-102 (UA-5 Production Real Coding Agent / Tested-Fix Pipeline Wiring v1):
 * `worker-main.ts` er et top-level side-effekt-skript (kobler til ekte
 * Postgres, starter en drain-løkke idet det importeres) - kan IKKE trygt
 * importeres direkte i en testfil, SAMME presedens som
 * `worker-knowledge-ingest-wiring.test.ts`/`drive-runtime-wiring.test.ts`.
 * Denne suiten beviser strukturelt at "coding"-jobbtypen er koblet inn med
 * §5s ABSOLUTTE sikkerhetsregel (ALDRI `ScriptedCodingAgent` i produksjon)
 * og de øvrige D-102-invariantene (ekte credential-arkitektur, delt
 * ToolGateway/D-97-arv, eier-identitet per jobb, hemmelighet-redaksjon).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const source = readSource("../src/worker-main.ts");

describe("worker-main.ts registrerer 'coding' produksjonshandleren korrekt (D-102)", () => {
  it("A: worker.register('coding', ...) kalles på SAMME InProcessWorker-instans som 'executive'/'knowledge-ingest-email'", () => {
    expect(source).toMatch(/worker\.register\(\s*\n?\s*"coding"/);
    expect([...source.matchAll(/new InProcessWorker\(/g)]).toHaveLength(1);
  });

  it("B: ABSOLUTT SIKKERHETSREGEL - ScriptedCodingAgent verken importeres eller instansieres i worker-main.ts (kun test-fixture, aldri produksjonsfallback) - en kommentar som NEVNER navnet for å forklare hvorfor det er utelatt er OK, faktisk bruk er det ikke", () => {
    expect(source).not.toMatch(/new ScriptedCodingAgent\(/);
    expect(source).not.toMatch(/import\s*\{[^}]*\bScriptedCodingAgent\b[^}]*\}\s*from\s*"@jarvis\/tasks"/s);
  });

  it("C: bruker den EKTE, kanoniske ClaudeCodeAgent (D-96/D-100/D-101) - INGEN ny/parallell Claude CLI-adapter", () => {
    expect(source).toMatch(/import\s*\{[^}]*ClaudeCodeAgent[^}]*\}\s*from\s*"@jarvis\/tasks"/s);
    expect(source).toContain("new ClaudeCodeAgent()");
  });

  it("D: agenten instansieres UTEN hardkodet bin-sti - JARVIS_CLAUDE_BIN-oppløsning skjer i ClaudeCodeAgent sin egen, allerede testede konstruktør (ingen Tobias-spesifikk vertssti)", () => {
    expect(source).not.toMatch(/new ClaudeCodeAgent\(["'/]/);
  });

  it("E: bruker EnvSecretProvider (SAMME sekret-arkitektur som resten av appen) for ANTHROPIC_API_KEY - INGEN ny hemmelighet-lagringsmekanisme", () => {
    const callIdx = source.indexOf('worker.register(\n  "coding"');
    expect(callIdx).toBeGreaterThan(-1);
    const callBlock = source.slice(callIdx, source.indexOf("\n);", callIdx) + 3);
    expect(callBlock).toContain("claudeCodeCredential:");
    expect(callBlock).toContain("new EnvSecretProvider()");
  });

  it("F: PR-publisering gjenbruker DEN SAMME toolGateway-instansen (arver D-97 rate-limiting) - INGEN direkte GitHub-HTTP-vei", () => {
    const callIdx = source.indexOf('worker.register(\n  "coding"');
    const callBlock = source.slice(callIdx, source.indexOf("\n);", callIdx) + 3);
    expect(callBlock).toMatch(/github:\s*\{\s*gateway:\s*toolGateway/);
  });

  it("G: identityFor bruker jobbens EGEN owner_person_id/tenant_id (ALDRI en fast worker-identitet) - påkrevd for korrekt SOVEREIGN-autoritetsevaluering", () => {
    const callIdx = source.indexOf('worker.register(\n  "coding"');
    const callBlock = source.slice(callIdx, source.indexOf("\n);", callIdx) + 3);
    expect(callBlock).toContain("task.contract.owner_person_id");
    expect(callBlock).toContain("task.tenant_id");
  });

  it("H: hele handleren pakkes i withSecretRedaction med kjente miljøvariabel-hemmeligheter - forsvar-i-dybden mot enhver lekkasje i last_error", () => {
    expect(source).toMatch(/import\s*\{[^}]*withSecretRedaction[^}]*\}\s*from\s*"@jarvis\/tasks"/s);
    const callIdx = source.indexOf('worker.register(\n  "coding"');
    const callBlock = source.slice(callIdx, source.indexOf("\n);", callIdx) + 3);
    expect(callBlock).toMatch(/withSecretRedaction\(/);
    expect(callBlock).toContain('process.env["ANTHROPIC_API_KEY"]');
  });

  it("I: sandboxen gjenbruker DEN SAMME 'runner'-variabelen som 'executive' (ProcessSandboxRunner/DockerSandboxRunner-valget) - ingen ny/parallell sandbox-arkitektur", () => {
    const callIdx = source.indexOf('worker.register(\n  "coding"');
    const callBlock = source.slice(callIdx, source.indexOf("\n);", callIdx) + 3);
    expect(callBlock).toContain("sandbox: runner");
  });

  it("J: bruker ArtifactStore(pool) - SAMME pool som resten av workeren, ingen ny/parallell tilkobling", () => {
    const callIdx = source.indexOf('worker.register(\n  "coding"');
    const callBlock = source.slice(callIdx, source.indexOf("\n);", callIdx) + 3);
    expect(callBlock).toContain("new ArtifactStore(pool)");
  });

  it("K: createCodingHandler importeres fra @jarvis/tasks - IKKE en duplisert/lokal handler-implementasjon", () => {
    expect(source).toMatch(/import\s*\{[^}]*createCodingHandler[^}]*\}\s*from\s*"@jarvis\/tasks"/s);
  });

  it("L: D-103 Blokker B - gitAuth er konfigurert med SAMME EnvSecretProvider-arkitektur, ATSKILT fra claudeCodeCredential (HELT egen secret-referanse)", () => {
    const callIdx = source.indexOf('worker.register(\n  "coding"');
    const callBlock = source.slice(callIdx, source.indexOf("\n);", callIdx) + 3);
    expect(callBlock).toMatch(/gitAuth:\s*\{\s*secretProvider:\s*new EnvSecretProvider\(\)/);
  });

  it("M: D-103 Blokker B - JARVIS_GITHUB_TOKEN er OGSÅ med i withSecretRedaction sin hemmelighetsliste (forsvar-i-dybden dekker nå BEGGE secrets)", () => {
    const callIdx = source.indexOf('worker.register(\n  "coding"');
    const callBlock = source.slice(callIdx, source.indexOf("\n);", callIdx) + 3);
    expect(callBlock).toContain('process.env["JARVIS_GITHUB_TOKEN"]');
  });
});

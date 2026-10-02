import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-355 (Steg 2 av D-354) koblet `delegate_code_task` inn på ConversationEngine
 * sin verktøyflate. REMEDIERING DEL 1 (JARVIS-002/JARVIS-035) har FRYST den:
 * det nøstede sky-kallet bruker hardkodet PUBLIC-sensitivitet og omgår
 * `paid_models_allowed`/Policy Gateway, og modellflaten er nå et eksplisitt
 * lese-minimumssett. Executorens EGEN logikk er fortsatt bevist isolert i
 * `modules/model-gateway/test/d355-specialist-delegation.test.ts` (modulen er
 * uendret og dormant); denne filen låser at produksjonsbanen IKKE kobler den inn.
 * Gjeninnkobling krever en ny beslutning der delegeringen er policy-/budsjettstyrt.
 */
const source = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
const codeOnly = source
  .split("\n")
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join("\n");

describe("D-355 (frosset av remediering del 1): delegate_code_task er IKKE på ConversationEngine sin verktøyflate", () => {
  it("A: main.ts importerer ikke lenger SPECIALIST_DELEGATION_TOOLS / createSpecialistDelegationExecutor", () => {
    expect(codeOnly).not.toContain("SPECIALIST_DELEGATION_TOOLS");
    expect(codeOnly).not.toContain("createSpecialistDelegationExecutor");
    expect(codeOnly).not.toContain("DELEGATE_CODE_TASK_TOOL_NAME");
  });

  it("B: ConversationEngine sin tools-definisjonsliste er KUN den eksplisitte modellflaten", () => {
    expect(codeOnly).toContain("definitions: modelToolSurface.map((t) => t.def),");
    // D-369: executoren får i tillegg eierens turn-kontekst (femte argument) - flaten (modelToolSurface) er uendret.
    expect(codeOnly).toMatch(/new MeshToolExecutor\(\s*toolGateway, identity, 20_000, modelToolSurface,/);
  });

  it("C: kun ÉN ModelGateway konstrueres i main.ts (ingen egen gateway for delegering)", () => {
    expect(codeOnly.split("new ModelGateway(").length - 1).toBe(1);
  });
});

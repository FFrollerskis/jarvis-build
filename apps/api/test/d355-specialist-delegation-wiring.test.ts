import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-355 (Steg 2 av D-354, Tobias direkte i chat: "... ved større
 * forespørsler kode enringer ... skal den spinne opp agenter ... kommer
 * tilbake til gemma med svaret"): kildeteksts-baserte bevis for selve
 * SAMMENKOBLINGEN i `apps/api/src/main.ts` - samme mønster som
 * `d125-telegram-inbound-wiring.test.ts`. Executorens EGEN logikk er bevist
 * isolert i `modules/model-gateway/test/d355-specialist-delegation.test.ts`;
 * denne filen beviser at produksjonsbanen faktisk KOBLER den inn på
 * samtale-/tale-verktøyflaten, ikke en parallell/glemt vei.
 */
const source = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
const codeOnly = source
  .split("\n")
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join("\n");

describe("D-355: delegate_code_task er koblet inn på ConversationEngine sin verktøyflate", () => {
  it("A: SPECIALIST_DELEGATION_TOOLS importeres fra @jarvis/model-gateway", () => {
    expect(source).toMatch(/import\s*\{[^}]*SPECIALIST_DELEGATION_TOOLS[^}]*\}\s*from\s*"@jarvis\/model-gateway"/s);
  });

  it("B: definitions-listen til ConversationEngine sin tools kombinerer fullMeshTools OG SPECIALIST_DELEGATION_TOOLS", () => {
    expect(codeOnly).toContain("definitions: [...fullMeshTools.map((t) => t.def), ...SPECIALIST_DELEGATION_TOOLS]");
  });

  it("C: executorFor() dispatcher sjekker DELEGATE_CODE_TASK_TOOL_NAME og ruter til createSpecialistDelegationExecutor(gateway)", () => {
    const start = codeOnly.indexOf("executorFor: (identity): ToolExecutor => {");
    expect(start, "forventet en executorFor-dispatcher for ConversationEngine sine tools").toBeGreaterThan(-1);
    const body = codeOnly.slice(start, codeOnly.indexOf("},", start) + 2);
    expect(body).toContain("createSpecialistDelegationExecutor(gateway)");
    expect(body).toContain("call.tool_name === DELEGATE_CODE_TASK_TOOL_NAME");
    expect(body).toContain("new MeshToolExecutor(toolGateway, identity, 20_000, fullMeshTools)");
  });

  it("D: kun ÉTT sted i main.ts bygger ConversationEngine sine tools (ingen parallell/glemt kobling)", () => {
    expect(codeOnly.split("createSpecialistDelegationExecutor(").length - 1).toBe(1);
  });

  it("E: den samme delte gateway-instansen (brukt av resten av main.ts) gjenbrukes for delegeringen - ingen egen ModelGateway konstrueres kun for dette", () => {
    expect(codeOnly.split("new ModelGateway(").length - 1).toBe(1);
  });
});

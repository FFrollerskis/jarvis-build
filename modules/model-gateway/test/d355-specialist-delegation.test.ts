import { describe, expect, it } from "vitest";
import type { ToolCallRequest } from "@jarvis/provider-adapters";
import type { CompleteInput, ModelGateway } from "../src/model-gateway.ts";
import {
  createSpecialistDelegationExecutor,
  DELEGATE_CODE_TASK_TOOL_NAME,
  SPECIALIST_DELEGATION_TOOLS
} from "../src/specialist-delegation.ts";

/**
 * D-355 (Steg 2 av D-354, Tobias direkte i chat: "... ved større forespørsler
 * kode enringer ... skal den spinne opp agenter ... kommer tilbake til gemma
 * med svaret"): beviser `delegate_code_task` sin executor-logikk isolert -
 * ingen ekte Postgres/nettverk, kun en scriptet fake `ModelGateway.complete()`.
 */

const baseCtx = { tenant_id: "tenant-1", session_id: "session-1", idempotency_key: "idem-1" };

function call(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    tool_call_id: "call-1",
    tool_name: DELEGATE_CODE_TASK_TOOL_NAME,
    arguments: { task: "Skriv en TypeScript-funksjon som snur en streng" },
    provider: "gemma_hosted",
    model: "gemma-4-26b-a4b-it",
    ...overrides
  };
}

function fakeGateway(complete: (input: CompleteInput) => Promise<{ text: string; provider: string; model: string }>): ModelGateway {
  return { complete } as unknown as ModelGateway;
}

describe("D-355: SPECIALIST_DELEGATION_TOOLS", () => {
  it("A: eksponerer NØYAKTIG ett verktøy, delegate_code_task, med et required 'task'-felt", () => {
    expect(SPECIALIST_DELEGATION_TOOLS).toHaveLength(1);
    const def = SPECIALIST_DELEGATION_TOOLS[0];
    expect(def?.name).toBe(DELEGATE_CODE_TASK_TOOL_NAME);
    expect((def?.input_schema["required"] as string[])).toContain("task");
  });
});

describe("D-355: createSpecialistDelegationExecutor()", () => {
  it("B: suksess - kaller gateway.complete() med providerPreference=[anthropic,openai,gemini], purpose=CODE, og returnerer svaret som output", async () => {
    let captured: CompleteInput | undefined;
    const gateway = fakeGateway(async (input) => {
      captured = input;
      return { text: "function reverse(s: string) { return [...s].reverse().join(''); }", provider: "anthropic", model: "claude-sonnet-5" };
    });
    const executor = createSpecialistDelegationExecutor(gateway);
    const result = await executor.execute(call(), baseCtx);
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      specialist_provider: "anthropic",
      specialist_model: "claude-sonnet-5",
      answer: "function reverse(s: string) { return [...s].reverse().join(''); }"
    });
    expect(captured?.providerPreference).toEqual(["anthropic", "openai", "gemini"]);
    expect(captured?.purpose).toBe("CODE");
    expect(captured?.sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    expect(captured?.tenant_id).toBe("tenant-1");
    expect(captured?.session_id).toBe("session-1");
    expect(captured?.request.messages).toEqual([
      { role: "user", content: "Skriv en TypeScript-funksjon som snur en streng" }
    ]);
  });

  it("C: ukjent tool_name -> TOOL_NOT_FOUND, gateway.complete() kalles ALDRI (trygt å komponere med MeshToolExecutor)", async () => {
    let completeCalled = false;
    const gateway = fakeGateway(async () => {
      completeCalled = true;
      return { text: "x", provider: "anthropic", model: "claude-sonnet-5" };
    });
    const executor = createSpecialistDelegationExecutor(gateway);
    const result = await executor.execute(call({ tool_name: "some_mesh_tool" }), baseCtx);
    expect(result.success).toBe(false);
    expect(result.error_category).toBe("TOOL_NOT_FOUND");
    expect(completeCalled).toBe(false);
  });

  it("D: tomt/manglende 'task'-argument -> INVALID_ARGUMENTS, gateway.complete() kalles ALDRI", async () => {
    let completeCalled = false;
    const gateway = fakeGateway(async () => {
      completeCalled = true;
      return { text: "x", provider: "anthropic", model: "claude-sonnet-5" };
    });
    const executor = createSpecialistDelegationExecutor(gateway);
    const result = await executor.execute(call({ arguments: { task: "   " } }), baseCtx);
    expect(result.success).toBe(false);
    expect(result.error_category).toMatch(/^INVALID_ARGUMENTS/);
    expect(completeCalled).toBe(false);
  });

  it("E: ALLE tre spesialister utilgjengelig (gateway.complete() kaster) -> ÆRLIG feil tilbake, ALDRI en stille Gemma-fallback her", async () => {
    const gateway = fakeGateway(async () => {
      throw new Error("no_eligible_provider: provider_preference_exhausted: ingen av [anthropic,openai,gemini] er konfigurert/kvalifisert");
    });
    const executor = createSpecialistDelegationExecutor(gateway);
    const result = await executor.execute(call(), baseCtx);
    expect(result.success).toBe(false);
    expect(result.error_category).toMatch(/^SPECIALIST_DELEGATION_FAILED:/);
    expect(result.error_category).toContain("provider_preference_exhausted");
  });

  it("F: execution_id følger idempotency_key fra ctx (samme mønster som MeshToolExecutor/executeToolCall sin caching)", async () => {
    const gateway = fakeGateway(async () => ({ text: "svar", provider: "openai", model: "gpt-5" }));
    const executor = createSpecialistDelegationExecutor(gateway);
    const result = await executor.execute(call(), { ...baseCtx, idempotency_key: "unik-nøkkel-42" });
    expect(result.execution_id).toBe("unik-nøkkel-42");
    expect(result.tool_call_id).toBe("call-1");
  });
});

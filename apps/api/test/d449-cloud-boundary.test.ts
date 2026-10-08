import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { JobContract } from "@jarvis/contracts";
import { MemoryTraceSink, ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import type { ModelProviderAdapter, ModelRequest, ModelResult, ToolCallRequest, ToolResultMessage } from "@jarvis/provider-adapters";
import type { ClaimedTask, JobContext } from "@jarvis/tasks";
import type { MeshToolMapping } from "@jarvis/tool-gateway";
import { executiveHandler } from "../src/executive.ts";

/**
 * D-449 (Q-50, gjennomgang nr. 3, E): handler-testene mocker `completeWithTools`, så skjermen aldri ble kjørt gjennom den ekte verktøyløkka og ned til adapteren. Her brukes den EKTE `ModelGateway` med
 * skriptede leverandør-adaptere: det som skymodellens adapter faktisk MOTTAR i runde 2 (`request.tool_exchanges`) er det eneste som forlater maskinen, og det er det som kontrolleres.
 */
const SECRET = "HEMMELIG-INNHOLD-SOM-ALDRI-SKAL-TIL-SKYEN";
const memoryOutput = [
  { memory_item_id: "ok", kind: "item", subject: "tobias.hobby", content: "Liker å gå på ski", type: "semantic", space: "personal", sensitivity: "normal" },
  { memory_item_id: "spesial", kind: "item", subject: "tobias.noe", content: SECRET, type: "semantic", space: "personal", sensitivity: "special" },
  { memory_item_id: "relasjon", kind: "item", subject: "tobias.noe2", content: SECRET, type: "semantic", space: "personal", via: "relation" }
];

function fakePool(): pg.Pool {
  const client = { query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }), release: () => undefined };
  return { connect: async () => client } as unknown as pg.Pool;
}
const usage = { input_tokens: 1, output_tokens: 1 };
const memoryCall = (provider: string, model: string): ToolCallRequest => ({ tool_call_id: "c1", tool_name: "search_my_memory", arguments: { query: "meg" }, provider, model });

/** Runde 1: ber om minnesøket. Runde 2+: ferdig svar. Husker hver request den mottok. */
function scripted(name: string, model: string): ModelProviderAdapter & { requests: ModelRequest[] } {
  let round = 0;
  const requests: ModelRequest[] = [];
  const next = (req: ModelRequest): ModelResult => {
    requests.push(JSON.parse(JSON.stringify(req)) as ModelRequest);
    round += 1;
    return round === 1
      ? ({ text: "", provider: name, model, tool_calls: [memoryCall(name, model)], usage, latency_ms: 1 } as unknown as ModelResult)
      : ({ text: "Ferdig.", provider: name, model, usage, latency_ms: 1 } as unknown as ModelResult);
  };
  const p = {
    name, model, requests, available: () => true,
    complete: async (req: ModelRequest) => next(req),
    stream: async (req: ModelRequest) => next(req)
  };
  return p as unknown as ModelProviderAdapter & { requests: ModelRequest[] };
}

const TOOLS: MeshToolMapping[] = [
  { def: { name: "search_my_memory", description: "minne", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }, tool_id: "memory", action: "search" } as unknown as MeshToolMapping
];
const executor: ToolExecutor = {
  async execute(c): Promise<ToolResultMessage> {
    return { tool_call_id: c.tool_call_id, tool_name: c.tool_name, execution_id: "e", success: true, output: memoryOutput, at: new Date().toISOString(), source: "memory.search", trust: "internal" };
  }
};
const ctx: JobContext = { attempts: 1, checkpoint: null, saveCheckpoint: async () => undefined, assertNotCancelled: async () => undefined };
const task: ClaimedTask = {
  task_id: "task-boundary-1", tenant_id: "tenant-personal", attempts: 1, checkpoint: null,
  contract: {
    goal: "Hva vet du om meg", owner_person_id: "person-tobias", tenant_id: "tenant-personal", allowed_memory_spaces: ["personal"], allowed_tools: ["memory"],
    input: {
      data: { prompt: "oppsummer hva du vet om hobbyene mine", purpose: "BACKGROUND", sensitivity: "PRIVATE", paid_models_allowed: false, delegated_from_chat: true, tools: true, cloud_tool_turns_allowed: true },
      trust_level: "internal", provenance: "chat:s1"
    }
  } as unknown as JobContract
};
const seenByProvider = (p: { requests: ModelRequest[] }): string => JSON.stringify(p.requests.slice(1).map((r) => r.tool_exchanges ?? []));

let logSpy: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => { logSpy?.mockRestore(); logSpy = undefined; });

describe("D-449: det skymodellens adapter faktisk mottar (ekte ModelGateway + verktøyløkke)", () => {
  it("skyruten: adapteren for Sonnet ser aldri special-/relasjonstreffet i runde 2 - kun det positivt trygge - og jobben får merknaden", async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const cloud = scripted("anthropic", "claude-sonnet-5-5");
    const local = scripted("gemma_local", "llama3.1:8b");
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [cloud, local] });
    const handler = executiveHandler({ gateway, tools: { all: TOOLS, executorFor: () => executor }, toolTurnRoute: { provider: "anthropic", model: "claude-sonnet-5-5" } });
    const result = await handler(task, ctx);
    expect(result["route"]).toBe("cloud");
    expect(result["provider"]).toBe("anthropic");
    expect(cloud.requests.length).toBe(2);
    expect(local.requests.length).toBe(0);
    const received = seenByProvider(cloud);
    expect(received).toContain("Liker å gå på ski");
    expect(received).not.toContain(SECRET);
    expect(received).toContain("withheld_count");
    expect(String(result["text"]).startsWith("(Deler av minnesøket ble holdt tilbake fra skymodellen")).toBe(true);
  });

  it("lokal rute (dagstak nådd): den lokale adapteren får hele resultatet, uskjermet - en lokal modell har lov til å se alt (D-378) - og cloud-adapteren kalles aldri", async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const cloud = scripted("anthropic", "claude-sonnet-5-5");
    const local = scripted("gemma_local", "llama3.1:8b");
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [cloud, local] });
    const handler = executiveHandler({
      gateway, tools: { all: TOOLS, executorFor: () => executor },
      toolTurnRoute: { provider: "anthropic", model: "claude-sonnet-5-5" },
      toolTurnDayCap: { cap_ore: 3000, spentToday: async () => 3000 }
    });
    const result = await handler(task, ctx);
    expect(result["route"]).toBe("local_cap");
    expect(cloud.requests.length).toBe(0);
    expect(local.requests.length).toBe(2);
    expect(seenByProvider(local)).toContain(SECRET);
  });

  it("uten skyflagg i kontrakten: ordinær lokal rute, adapteren for skyen kalles aldri", async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const cloud = scripted("anthropic", "claude-sonnet-5-5");
    const local = scripted("gemma_local", "llama3.1:8b");
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [cloud, local] });
    const handler = executiveHandler({ gateway, tools: { all: TOOLS, executorFor: () => executor }, toolTurnRoute: { provider: "anthropic", model: "claude-sonnet-5-5" } });
    const noFlag = { ...task, contract: { ...task.contract, input: { ...task.contract.input, data: { ...(task.contract.input.data as Record<string, unknown>), cloud_tool_turns_allowed: undefined } } } } as unknown as ClaimedTask;
    await handler(noFlag, ctx);
    expect(cloud.requests.length).toBe(0);
    expect(local.requests.length).toBe(2);
  });
});

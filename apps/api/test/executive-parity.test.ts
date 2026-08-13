import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { JobContract } from "@jarvis/contracts";
import { MemoryTraceSink, ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import { ScriptedAdapter, type ToolCallRequest, type ToolResultMessage } from "@jarvis/provider-adapters";
import type { ClaimedTask, JobContext, SandboxRunner } from "@jarvis/tasks";
import { executiveHandler } from "../src/executive.ts";

/**
 * BO-11.1 §9-§10: api-workeren og worker-containeren registrerer SAMME delte
 * executive-handler (apps/api/src/executive.ts). Testene beviser at begge
 * konfigurasjonene (med/uten sandbox) gir semantisk likt resultat for samme
 * durable jobb - ingen gammel echo-/provider-direkte-handler kan vinne
 * queue-racet igjen.
 */

function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) =>
      typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] },
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

const TOOLS = [
  {
    name: "read_calendar_today",
    description: "Les kalender",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
  }
];

function recordingExecutor(): { executor: ToolExecutor; keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    executor: {
      async execute(call: ToolCallRequest, ctx): Promise<ToolResultMessage> {
        keys.push(ctx.idempotency_key);
        return {
          tool_call_id: call.tool_call_id,
          tool_name: call.tool_name,
          execution_id: ctx.idempotency_key,
          success: true,
          output: { events: ["standup 09:00"] },
          at: new Date().toISOString()
        };
      }
    }
  };
}

function newGateway(): ModelGateway {
  const adapter = new ScriptedAdapter(
    () => "Grønn: standup 09:00",
    (req) => (req.tool_exchanges ? [] : [
      { tool_call_id: "c1", tool_name: "read_calendar_today", arguments: {}, provider: "scripted", model: "scripted-1" }
    ])
  );
  return new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter] });
}

function makeTask(data: Record<string, unknown>): ClaimedTask {
  return {
    task_id: "task-parity-1",
    tenant_id: "tenant-personal",
    contract: { goal: "morgenstatus", input: { data }, allowed_tools: [] } as unknown as JobContract,
    attempts: 1,
    checkpoint: null
  };
}

const ctx: JobContext = {
  attempts: 1,
  checkpoint: null,
  saveCheckpoint: async () => undefined,
  assertNotCancelled: async () => undefined
};

const fakeSandbox: SandboxRunner = {
  name: "fake-sandbox",
  async create() {
    return {
      workdir: "/tmp/fake",
      exec: (cmd: string) => ({ code: 0, stdout: `ran:${cmd}`, stderr: "" }),
      dispose: async () => undefined
    };
  }
};

describe("BO-11.1 §10: executive-handler-paritet api ↔ worker-container", () => {
  it("samme tools-jobb gir semantisk likt resultat i begge konfigurasjoner - samme idempotensnøkkel", async () => {
    const api = recordingExecutor();
    const workerC = recordingExecutor();
    const apiHandler = executiveHandler({ gateway: newGateway(), tools: { definitions: TOOLS, executor: api.executor } });
    const workerHandler = executiveHandler({
      gateway: newGateway(),
      tools: { definitions: TOOLS, executor: workerC.executor },
      sandbox: fakeSandbox
    });
    const task = makeTask({ prompt: "hva skjer i dag?", tools: true, purpose: "BACKGROUND" });
    const apiResult = await apiHandler(task, ctx);
    const workerResult = await workerHandler(task, ctx);
    // Semantisk likt: samme kontraktfelter, samme mesh-oppførsel, samme tool-runder.
    expect(apiResult["text"]).toBe(workerResult["text"]);
    expect(apiResult["tool_rounds"]).toBe(workerResult["tool_rounds"]);
    expect(apiResult["provider"]).toBe(workerResult["provider"]);
    expect(Object.keys(apiResult).sort()).toEqual(Object.keys(workerResult).sort());
    // §19: idempotensnøkkelen er identisk (tenant+task+tool+args) uansett hvem som claimet:
    expect(api.keys).toEqual(workerC.keys);
    expect(api.keys).toHaveLength(1);
  });

  it("prompt-jobb uten tools går via mesh (aldri echo) i begge konfigurasjoner", async () => {
    const apiHandler = executiveHandler({ gateway: newGateway() });
    const workerHandler = executiveHandler({ gateway: newGateway(), sandbox: fakeSandbox });
    const task = makeTask({ prompt: "oppsummer dagen", purpose: "BACKGROUND" });
    const a = await apiHandler(task, ctx);
    const b = await workerHandler(task, ctx);
    expect(a["provider"]).toBe("scripted"); // mesh, ikke echo
    expect(b["provider"]).toBe("scripted");
    expect(a["text"]).toBe(b["text"]);
  });

  it("command-jobb: sandbox der den finnes; uten sandbox kvitteres målet (aldri crash/racefeil)", async () => {
    const apiHandler = executiveHandler({ gateway: newGateway() });
    const workerHandler = executiveHandler({ gateway: newGateway(), sandbox: fakeSandbox });
    const task = makeTask({ command: ["echo", "hei"] });
    const a = await apiHandler(task, ctx);
    const b = await workerHandler(task, ctx);
    expect(a["echo"]).toBe("morgenstatus"); // api: kvittering
    expect(b["stdout"]).toBe("ran:echo"); // worker: sandbox
    expect(b["sandbox"]).toBe("fake-sandbox");
  });

  it("styringsjobb uten prompt/command kvitteres identisk", async () => {
    const a = await executiveHandler({ gateway: newGateway() })(makeTask({}), ctx);
    const b = await executiveHandler({ gateway: newGateway(), sandbox: fakeSandbox })(makeTask({}), ctx);
    expect(a["echo"]).toBe("morgenstatus");
    expect(b["echo"]).toBe("morgenstatus");
  });
});

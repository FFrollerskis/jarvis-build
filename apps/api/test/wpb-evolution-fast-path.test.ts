import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore } from "@jarvis/core";
import { MemoryTraceSink, type ModelGateway } from "@jarvis/model-gateway";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ConversationEngine, type ConversationDeps } from "../src/conversation.ts";

/**
 * WP-B (D-452): «hvordan utvikler du deg» er en hurtigbane-kommando (aldri LLM) som leser evolusjonsportene via Tool Gateway. Uten kilde svarer Jarvis ærlig at den ikke kan lese dem.
 */
const fakePool = (): pg.Pool => ({ connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined }) }) as unknown as pg.Pool;
const identity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };

function engine(extra: Partial<ConversationDeps> = {}): { engine: ConversationEngine; modelCalls: number } {
  const state = { modelCalls: 0 };
  const gateway = {
    complete: async () => { state.modelCalls += 1; return { text: "modell", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m" }; },
    stream: async () => { state.modelCalls += 1; return { text: "modell", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m" }; }
  } as unknown as ModelGateway;
  const e = new ConversationEngine({
    messages: new MessageStore(fakePool()), context: new ContextBuilder(fakePool()), gateway,
    tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(), ...extra
  });
  return { engine: e, get modelCalls() { return state.modelCalls; } } as never;
}

describe("hurtigbane: evolution_report", () => {
  it("«hvordan utvikler du deg» kaller evolusjonsrapporten (ikke modellen) og gir teksten uendret", async () => {
    const seen: IdentityContext[] = [];
    const t = engine({ evolutionReport: { run: async (id) => { seen.push(id); return "Evolusjonsporter (kun observasjon): 3 OK"; } } });
    const result = await t.engine.handle(identity, "hvordan utvikler du deg?");
    expect(result).toMatchObject({ reply: "Evolusjonsporter (kun observasjon): 3 OK", routed: "fast" });
    expect(t.modelCalls).toBe(0);
    expect(seen).toEqual([identity]);
  });

  it("uten kilde, eller når verktøyet svarer null/kaster: ærlig «kan ikke lese» - aldri en påstand om at utviklingen er i orden", async () => {
    for (const extra of [{}, { evolutionReport: { run: async () => null } }, { evolutionReport: { run: async () => { throw new Error("nede"); } } }]) {
      const t = engine(extra);
      const result = await t.engine.handle(identity, "evolusjon");
      expect(result.routed).toBe("fast");
      expect(result.reply).toContain("Jeg kan ikke lese evolusjonsportene akkurat nå");
      expect(result.reply).toContain("vil ikke påstå");
    }
  });
});

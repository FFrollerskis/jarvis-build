import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { ModelProviderAdapter, ModelRequest, ModelResult } from "@jarvis/provider-adapters";
import { InteractivePriorityGate, MemoryTraceSink, ModelGateway } from "../src/index.ts";

/** D-414: «chat først» - bakgrunnsformål venter på chat, aldri omvendt, og aldri for alltid. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}

describe("A: InteractivePriorityGate (ren logikk, fiktiv klokke)", () => {
  it("A1: ingen interaktiv aktivitet -> bakgrunn slipper umiddelbart etter stillhet", async () => {
    const c = fakeClock();
    const g = new InteractivePriorityGate({ maxWaitMs: 90_000, quietMs: 4_000, now: c.now, sleep: c.sleep });
    const r = await g.yieldToInteractive();
    expect(r.reason).toBe("idle");
    expect(r.waited_ms).toBe(0);
  });

  it("A2: aktiv chat -> bakgrunn venter til chatten er ferdig PLUSS stillhetsperioden", async () => {
    const c = fakeClock();
    const g = new InteractivePriorityGate({ maxWaitMs: 90_000, quietMs: 4_000, now: c.now, sleep: c.sleep });
    const leave = g.enterInteractive();
    let released = false;
    const waiting = g.yieldToInteractive().then((r) => { released = true; return r; });
    c.advance(10_000); await Promise.resolve();
    expect(released).toBe(false);
    leave();
    const r = await waiting;
    expect(r.reason).toBe("idle");
    expect(r.waited_ms).toBeGreaterThanOrEqual(4_000);
  });

  it("A3: bakgrunn sultes aldri - etter maxWaitMs fortsetter den (reason timeout)", async () => {
    const c = fakeClock();
    const g = new InteractivePriorityGate({ maxWaitMs: 2_000, quietMs: 1_000, now: c.now, sleep: c.sleep });
    g.enterInteractive(); // aldri ferdig
    const r = await g.yieldToInteractive();
    expect(r.reason).toBe("timeout");
    expect(r.waited_ms).toBeGreaterThanOrEqual(2_000);
    expect(g.stats().timeouts).toBe(1);
  });

  it("A4: maxWaitMs=0 slår låsen av; leave() er idempotent og teller ikke negativt", async () => {
    const c = fakeClock();
    const off = new InteractivePriorityGate({ maxWaitMs: 0, quietMs: 4_000, now: c.now, sleep: c.sleep });
    off.enterInteractive();
    expect((await off.yieldToInteractive()).reason).toBe("disabled");
    const g = new InteractivePriorityGate({ maxWaitMs: 1_000, quietMs: 0, now: c.now, sleep: c.sleep });
    const leave = g.enterInteractive();
    leave(); leave();
    expect(g.stats().active_interactive).toBe(0);
  });
});

function fakePool(): pg.Pool {
  const client = { query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }), release: () => undefined };
  return { connect: async () => client } as unknown as pg.Pool;
}
const REQ: ModelRequest = { messages: [{ role: "user", content: "hei" }] };

describe("B: ModelGateway - rekkefølge mellom chat og bakgrunn", () => {
  it("B1: EXTRACT startet mens en CHAT pågår, kjører ETTER at chatten er ferdig", async () => {
    const events: string[] = [];
    let releaseChat: () => void = () => undefined;
    const chatBlocked = new Promise<void>((r) => { releaseChat = r; });
    const adapter: ModelProviderAdapter = {
      name: "gemma_local", available: () => true,
      async complete(r: ModelRequest): Promise<ModelResult> {
        const tag = String((r.messages[0] as { content: string }).content);
        events.push(`start:${tag}`);
        if (tag === "chat") await chatBlocked;
        events.push(`end:${tag}`);
        return { text: "ok", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m", latency_ms: 1 } as unknown as ModelResult;
      }
    };
    const gateway = new ModelGateway({
      pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter],
      priorityGate: new InteractivePriorityGate({ maxWaitMs: 5_000, quietMs: 0 })
    });
    const chat = gateway.complete({ tenant_id: "t", purpose: "CHAT", providerPreference: ["gemma_local"], request: { messages: [{ role: "user", content: "chat" }] } });
    await new Promise((r) => setTimeout(r, 30));
    const extract = gateway.complete({ tenant_id: "t", purpose: "EXTRACT", providerPreference: ["gemma_local"], request: { messages: [{ role: "user", content: "extract" }] } });
    await new Promise((r) => setTimeout(r, 400));
    expect(events).toEqual(["start:chat"]); // extract venter
    releaseChat();
    await Promise.all([chat, extract]);
    expect(events).toEqual(["start:chat", "end:chat", "start:extract", "end:extract"]);
  });

  it("B2: uten priorityGate er oppførselen uendret (begge starter umiddelbart)", async () => {
    const events: string[] = [];
    const adapter: ModelProviderAdapter = {
      name: "gemma_local", available: () => true,
      async complete(r: ModelRequest): Promise<ModelResult> {
        events.push(String((r.messages[0] as { content: string }).content));
        return { text: "ok", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m", latency_ms: 1 } as unknown as ModelResult;
      }
    };
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter] });
    await Promise.all([
      gateway.complete({ tenant_id: "t", purpose: "EXTRACT", providerPreference: ["gemma_local"], request: { messages: [{ role: "user", content: "a" }] } }),
      gateway.complete({ tenant_id: "t", purpose: "CHAT", providerPreference: ["gemma_local"], request: REQ })
    ]);
    expect(events.sort()).toEqual(["a", "hei"]);
  });

  it("B3: en feilende chat slipper bakgrunnen til likevel (leave i finally)", async () => {
    const adapter: ModelProviderAdapter = {
      name: "gemma_local", available: () => true,
      async complete(r: ModelRequest): Promise<ModelResult> {
        if (String((r.messages[0] as { content: string }).content) === "boom") throw new Error("boom");
        return { text: "ok", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m", latency_ms: 1 } as unknown as ModelResult;
      }
    };
    const gate = new InteractivePriorityGate({ maxWaitMs: 2_000, quietMs: 0 });
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter], priorityGate: gate });
    await gateway.complete({ tenant_id: "t", purpose: "CHAT", providerPreference: ["gemma_local"], request: { messages: [{ role: "user", content: "boom" }] } }).catch(() => undefined);
    expect(gate.stats().active_interactive).toBe(0);
  });
});

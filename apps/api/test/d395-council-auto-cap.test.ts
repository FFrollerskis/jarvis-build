import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore } from "@jarvis/core";
import { CouncilAutoTriggerLimiter, MemoryTraceSink, type AiCouncil, type CompleteInput, type ModelGateway } from "@jarvis/model-gateway";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../src/conversation.ts";

/**
 * D-395 (JARVIS-078): AUTOMATISK råd-trigger har kostnadstak, og uten konfigurert råd faller en automatisk klassifisering gjennom til vanlig samtale
 * (tidligere ble svaret på spørsmålet erstattet av «AI-rådet er ikke konfigurert»). Eksplisitt «bruk AI-rådet» er aldri begrenset.
 */
function fakePool(): pg.Pool {
  const client = { query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined };
  return { connect: async () => client } as unknown as pg.Pool;
}
const identity: IdentityContext = { person_id: "p", tenant_id: "tenant-1", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "active" };
const HIGH_IMPACT = "Skal vi bruke 500 000 kr på dette prosjektet?";

function build(opts: { withCouncil: boolean; limiter?: CouncilAutoTriggerLimiter }): { engine: ConversationEngine; council: { runs: number }; completes: CompleteInput[]; trace: MemoryTraceSink } {
  const pool = fakePool();
  const council = { runs: 0 };
  const completes: CompleteInput[] = [];
  const trace = new MemoryTraceSink();
  const gateway = {
    complete: async (input: CompleteInput) => {
      completes.push(input);
      return { text: "vanlig svar", usage: { input_tokens: 1, output_tokens: 1 }, provider: "scripted", model: "scripted-1" };
    }
  } as unknown as ModelGateway;
  const aiCouncil = {
    run: async () => {
      council.runs += 1;
      return { decision: "Rådet sier ja", consensus_status: "CONSENSUS", supporting_models: [], dissenting_models: [], confidence: 90 };
    }
  } as unknown as AiCouncil;
  const engine = new ConversationEngine({
    messages: new MessageStore(pool),
    context: new ContextBuilder(pool),
    gateway,
    tasks: {} as unknown as TaskService,
    worker: {} as unknown as InProcessWorker,
    trace,
    ...(opts.withCouncil ? { council: aiCouncil } : {}),
    ...(opts.limiter ? { councilAutoLimiter: opts.limiter } : {})
  });
  return { engine, council, completes, trace };
}

describe("CouncilAutoTriggerLimiter", () => {
  it("glidende vindu per tenant: tak nås, andre tenants påvirkes ikke, plass frigjøres når vinduet glir", () => {
    let now = 0;
    const limiter = new CouncilAutoTriggerLimiter(2, 1000, () => now);
    expect(limiter.tryAcquire("a")).toBe(true);
    expect(limiter.tryAcquire("a")).toBe(true);
    expect(limiter.tryAcquire("a")).toBe(false);
    expect(limiter.tryAcquire("b")).toBe(true);
    now = 1500;
    expect(limiter.tryAcquire("a")).toBe(true);
  });
});

describe("ConversationEngine: kostnadstak for automatisk råd-trigger", () => {
  it("automatisk trigger kjører rådet til taket er nådd; deretter faller meldingen gjennom til vanlig samtale med revisjonsspor", async () => {
    const { engine, council, completes, trace } = build({ withCouncil: true, limiter: new CouncilAutoTriggerLimiter(2) });
    const r1 = await engine.handle(identity, HIGH_IMPACT);
    const r2 = await engine.handle(identity, HIGH_IMPACT);
    expect(council.runs).toBe(2);
    expect(r1.reply).toContain("Rådet sier ja");
    expect(completes).toHaveLength(0);
    const r3 = await engine.handle(identity, HIGH_IMPACT);
    expect(council.runs).toBe(2); // ikke et tredje råd
    expect(completes).toHaveLength(1); // vanlig modellkall svarte i stedet
    expect(r3.reply).toContain("vanlig svar");
    expect(r2.routed).toBe("model");
    expect(trace.spans.some((s) => s.kind === "council_suppressed" && s.name === "auto_trigger_rate_limited")).toBe(true);
  });

  it("eksplisitt «bruk AI-rådet» er ALDRI begrenset, selv etter at taket for automatisk trigger er nådd", async () => {
    const { engine, council } = build({ withCouncil: true, limiter: new CouncilAutoTriggerLimiter(1) });
    await engine.handle(identity, HIGH_IMPACT);
    await engine.handle(identity, HIGH_IMPACT); // over taket
    expect(council.runs).toBe(1);
    await engine.handle(identity, "bruk AI-rådet på dette");
    await engine.handle(identity, "bruk AI-rådet på dette også");
    expect(council.runs).toBe(3);
  });
});

describe("ConversationEngine: råd ikke konfigurert", () => {
  it("automatisk klassifisering faller gjennom til vanlig samtale (spørsmålet blir besvart)", async () => {
    const { engine, completes } = build({ withCouncil: false });
    const r = await engine.handle(identity, HIGH_IMPACT);
    expect(completes).toHaveLength(1);
    expect(r.reply).toContain("vanlig svar");
    expect(r.reply).not.toContain("ikke konfigurert");
  });

  it("eksplisitt «bruk AI-rådet» uten råd: ærlig melding og routed = blocked (ingen modell kjørte)", async () => {
    const { engine, completes } = build({ withCouncil: false });
    const r = await engine.handle(identity, "bruk AI-rådet på dette");
    expect(r.reply).toContain("ikke konfigurert");
    expect(r.routed).toBe("blocked");
    expect(completes).toHaveLength(0);
  });
});

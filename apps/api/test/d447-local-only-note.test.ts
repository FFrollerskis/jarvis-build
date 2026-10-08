import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore } from "@jarvis/core";
import { MemoryTraceSink, classifyContentSensitivity, type CompleteInput, type ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../src/conversation.ts";
import { localOnlyNote } from "../src/tool-turn-route.ts";

/**
 * D-447 (NAS-test 2026-10-08): en verktøytur som ellers ville gått til sky, men som sensitivitetsregelen (D-378) tvinger til den lokale modellen,
 * SKAL si det i svaret (ikke på tale) og i loggen (kun kategorier, aldri innhold). Selve regelen er uendret og låses av de eksisterende testene.
 */
const fakePool = (): pg.Pool => ({ connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined }) }) as unknown as pg.Pool;
const identity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };
const LIMITS = { max_tools_per_round: 8, max_schema_tokens: 1500, max_rounds: 4, max_calls_per_round: 4, max_total_calls: 16 };
const def = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {}, additionalProperties: false } });
const route = { provider: "anthropic", model: "claude-sonnet-5-5" };
const LOCAL = ["gemma_local", "gemma_hosted"];
const NOTE = "Svart på den lokale modellen";

function build(opts: {
  tools: string[];
  captured: CompleteInput[];
  route?: { provider: string; model?: string } | null;
  dayCap?: { cap_ore: number; spentToday(t: string): Promise<number> } | null;
}): ConversationEngine {
  const gateway = {
    complete: async () => ({ text: "x", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m" }),
    stream: async () => ({ text: "x", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m" }),
    completeWithTools: async (input: CompleteInput) => {
      opts.captured.push(input);
      return { text: "svar", usage: { input_tokens: 1, output_tokens: 1 }, provider: "x", model: "m" };
    }
  } as unknown as ModelGateway;
  return new ConversationEngine({
    messages: new MessageStore(fakePool()), context: new ContextBuilder(fakePool()), gateway,
    tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
    toolTurnRoute: opts.route === undefined ? route : opts.route,
    ...(opts.dayCap !== undefined ? { toolTurnDayCap: opts.dayCap } : {}),
    tools: {
      definitions: opts.tools.map(def),
      executorFor: () => ({ execute: async () => { throw new Error("ikke brukt"); } }) as unknown as ToolExecutor,
      select: () => ({ definitions: opts.tools.map(def), limits: LIMITS })
    }
  });
}

let logSpy: ReturnType<typeof vi.spyOn> | undefined;
function captureD447(): () => Array<{ msg: string; reasons: string[] }> {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () =>
    (logSpy as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])) as { msg: string; reasons: string[] }; } catch { return { msg: "", reasons: [] }; } })
      .filter((l) => l.msg === "d447_tool_turn_local_sensitivity");
}
afterEach(() => { logSpy?.mockRestore(); logSpy = undefined; });

const FINANCE_ASK = "sjekk saldoen min og kalenderen i morgen";
const NEUTRAL_ASK = "hva er neste punkt i kalenderen min i morgen?";

describe("D-447: lokal-tvang av sensitivitet er synlig", () => {
  it("økonomiord + valgt verktøy → lokal modell (uendret regel), merknad i svar og strøm, logglinje med kategorier men uten innhold", async () => {
    const logs = captureD447();
    const captured: CompleteInput[] = [];
    const tokens: string[] = [];
    const result = await build({ tools: ["calendar__read_events"], captured }).handle(identity, FINANCE_ASK, (t: string) => { tokens.push(t); });
    expect(captured[0]?.providerPreference).toEqual(LOCAL);
    expect(captured[0]?.request.model).toBeUndefined();
    expect(result.reply).toContain("svar");
    expect(result.reply).toContain(NOTE);
    expect(result.reply).toContain("økonomi");
    expect(tokens.join("")).toContain(NOTE);
    const lines = logs();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.reasons).toContain("text:finance");
    expect(JSON.stringify(lines)).not.toContain("saldo");
    expect(JSON.stringify(lines)).not.toContain("kalender");
  });

  it("uten økonomiord → sky som før, ingen merknad og ingen logglinje", async () => {
    const logs = captureD447();
    const captured: CompleteInput[] = [];
    const result = await build({ tools: ["calendar__read_events"], captured }).handle(identity, NEUTRAL_ASK);
    expect(captured[0]?.providerPreference).toEqual(["anthropic"]);
    expect(result.reply).toBe("svar");
    expect(logs()).toEqual([]);
  });

  it("ren prat (kun minne-reserven) med økonomiord → ingen merknad og ingen logglinje (ingen verktøytur å forklare)", async () => {
    const logs = captureD447();
    const captured: CompleteInput[] = [];
    const result = await build({ tools: ["memory__search"], captured }).handle(identity, FINANCE_ASK);
    expect(captured[0]?.providerPreference).toEqual(LOCAL);
    expect(result.reply).toBe("svar");
    expect(logs()).toEqual([]);
  });

  it("tale: samme lokale valg og logglinje, men ingen merknad i det som leses opp", async () => {
    const logs = captureD447();
    const captured: CompleteInput[] = [];
    const tokens: string[] = [];
    const result = await build({ tools: ["calendar__read_events"], captured }).handle({ ...identity, channel: "voice" }, FINANCE_ASK, (t: string) => { tokens.push(t); });
    expect(captured[0]?.providerPreference).toEqual(LOCAL);
    expect(result.reply).toBe("svar");
    expect(tokens.join("")).not.toContain(NOTE);
    expect(logs()).toHaveLength(1);
  });

  it("verktøy-ruten av (null) eller eksplisitt provider fra eier → ingenting gikk tapt, så ingen merknad og ingen logglinje", async () => {
    const logs = captureD447();
    const off: CompleteInput[] = [];
    const offResult = await build({ tools: ["calendar__read_events"], captured: off, route: null }).handle(identity, FINANCE_ASK);
    expect(offResult.reply).toBe("svar");
    const explicit: CompleteInput[] = [];
    const explicitResult = await build({ tools: ["calendar__read_events"], captured: explicit }).handle(identity, FINANCE_ASK, undefined, undefined, "gemma_local");
    expect(explicitResult.reply).toBe("svar");
    expect(logs()).toEqual([]);
  });

  it("dagstaket er uendret: kun dagstak-merknaden, aldri begge, og ingen d447-logglinje for en tur som ikke var sensitiv", async () => {
    const logs = captureD447();
    const captured: CompleteInput[] = [];
    const result = await build({ tools: ["calendar__read_events"], captured, dayCap: { cap_ore: 3000, spentToday: async () => 3000 } }).handle(identity, NEUTRAL_ASK);
    expect(captured[0]?.providerPreference).toEqual(LOCAL);
    expect(result.reply).toContain("Dagstaket for sky på 30 kr er nådd i dag");
    expect(result.reply).not.toContain(NOTE);
    expect(logs()).toEqual([]);
  });

  it("sensitiv tur leser ikke dagstaket (kostnaden spørres kun når turen ellers ville gått til sky)", async () => {
    captureD447();
    let reads = 0;
    const captured: CompleteInput[] = [];
    const result = await build({ tools: ["calendar__read_events"], captured, dayCap: { cap_ore: 3000, spentToday: async () => { reads += 1; return 0; } } }).handle(identity, FINANCE_ASK);
    expect(reads).toBe(0);
    expect(result.reply).toContain(NOTE);
    expect(result.reply).not.toContain("Dagstaket");
  });
});

describe("D-447: localOnlyNote", () => {
  it("nevner kategoriene fra meldingen/historikken, og at det gjelder til emnet er ute av de siste meldingene", () => {
    const note = localOnlyNote(["private_tool_output", "text:finance", "text:health"]);
    expect(note.startsWith("\n\n(")).toBe(true);
    expect(note.endsWith(")")).toBe(true);
    expect(note).toContain("økonomi og helse");
    expect(note).toContain("meldingen eller de siste meldingene");
    expect(note).toContain("Dette varer til emnet ikke lenger er blant de siste meldingene.");
    expect(note).not.toContain("private_tool_output");
  });

  it("minnebaserte årsaker beskrives som kontekst, uten historikk-hintet", () => {
    const note = localOnlyNote(["memory_space:health", "memory_sensitivity:special"]);
    expect(note).toContain("helseminnet og minne merket som særlig sensitivt ble brukt som kontekst");
    expect(note).not.toContain("Dette varer til emnet");
  });

  it("ukjente årsaker gir en generell, ærlig forklaring", () => {
    expect(localOnlyNote(["noe_nytt"])).toContain("innholdet er klassifisert som følsomt");
    expect(localOnlyNote([])).toContain("innholdet er klassifisert som følsomt");
  });

  it("merknaden er selv aldri følsom for klassifiseringen (ellers ville den holdt samtalen låst lokalt videre)", () => {
    const reasonSets = [
      ["text:finance"], ["text:health"], ["text:secret"], ["text:finance", "text:health", "text:secret"],
      ["memory_space:health"], ["memory_sensitivity:special"], ["text:finance", "memory_space:health"], ["ukjent"], []
    ];
    for (const reasons of reasonSets) {
      const note = localOnlyNote(reasons);
      expect(classifyContentSensitivity({ texts: [note] }).sensitivity, note).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    }
  });
});

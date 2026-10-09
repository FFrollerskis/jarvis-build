import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore } from "@jarvis/core";
import { MemoryTraceSink, ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import { ProviderError, type ModelProviderAdapter, type ModelResult, type StreamEvent, type ToolCallRequest, type ToolResultMessage } from "@jarvis/provider-adapters";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../src/conversation.ts";
import { parseChatCandidates } from "../src/chat-candidates.ts";

/**
 * WP-D4 (gjennomgang av PR #315, M2 + L11) mot en EKTE `ModelGateway` og den EKTE samtalemotoren: reservebruk skal alltid være synlig (D-447) - også når reserven tok over etter et TOMT, AVKORTET eller ugyldig svar (ikke bare
 * etter en kastet feil), når primæren ble hoppet over fordi helsen er UNAVAILABLE, og når en skyleverandør betjente en TIDLIGERE runde i en verktøytur (runde 1 sky, siste runde lokal). Gatewayens egen kontrakt
 * (`onAttemptFailed`) er testet i `modules/model-gateway/test/wpd4-attempt-failed.test.ts`.
 */
const MODELS: Record<string, string> = { gemma_local: "gemma-local", local_llm: "local-model", gemma_hosted: "gemma-4-26b-a4b-it", anthropic: "claude-sonnet-5-5", openai: "gpt-5" };

type Step = "ok" | "empty" | "blank" | "truncated" | "tool" | ProviderError["kind"] | { text: string };
const toolCall = (provider: string): ToolCallRequest => ({ tool_call_id: "c1", tool_name: "read_calendar", arguments: {}, provider, model: MODELS[provider] ?? "m" });
function outcome(name: string, step: Step, hasExchanges: boolean): ModelResult {
  const r = (text: string, finish_reason: string): ModelResult => ({ text, usage: { input_tokens: 5, output_tokens: 5 }, provider: name, model: MODELS[name] ?? "m", finish_reason });
  if (typeof step === "object") return r(step.text, "stop");
  if (step === "ok") return r(`svar fra ${name}`, "stop");
  if (step === "empty") return r("", "stop");
  if (step === "blank") return r("  \n", "stop");
  if (step === "truncated") return r("", "length");
  if (step === "tool") return hasExchanges ? r(`ferdig fra ${name}`, "stop") : { ...r("", "tool_calls"), tool_calls: [toolCall(name)] };
  throw new ProviderError(name, step, `${name}_${step}`);
}

function adapter(name: string, steps: Step[], calls: string[]): ModelProviderAdapter {
  let i = 0;
  const next = (): Step => steps[Math.min(i++, steps.length - 1)] as Step;
  return {
    name, model: MODELS[name] ?? "m", available: () => true,
    complete: async (req) => { calls.push(name); return outcome(name, next(), req.tool_exchanges !== undefined); },
    stream: async (req, onEvent: (e: StreamEvent) => void) => {
      calls.push(name);
      const r = outcome(name, next(), req.tool_exchanges !== undefined); // en kastet feil kommer FØR første tegn
      onEvent({ type: "start", provider: name, model: r.model, generation_id: "g" });
      if (r.text.length > 0) onEvent({ type: "text_delta", text: r.text });
      onEvent({ type: "usage", usage: r.usage });
      onEvent({ type: "finish", finish_reason: r.finish_reason ?? "stop" });
      return r;
    }
  };
}

function pool(saved: string[]): pg.Pool {
  const query = async (sql: string, params?: unknown[]) => {
    if (typeof sql === "string" && sql.includes("FROM cost_events")) return { rows: [{ spent: 0 }], rowCount: 1 };
    if (typeof sql === "string" && sql.includes("INSERT INTO messages") && params && params[3] === "assistant") saved.push(String(params[4]));
    return { rows: [], rowCount: 0 };
  };
  return { connect: async () => ({ query, release: () => undefined }), query } as unknown as pg.Pool;
}

const definitions = [{ name: "read_calendar", description: "Les kalenderen", input_schema: { type: "object", properties: {}, additionalProperties: false } }];
const LIMITS = { max_tools_per_round: 4, max_schema_tokens: 1500, max_rounds: 4, max_calls_per_round: 4, max_total_calls: 8 };
const calendarExecutor: ToolExecutor = {
  execute: async (c): Promise<ToolResultMessage> => ({ tool_call_id: c.tool_call_id, tool_name: c.tool_name, execution_id: "e1", success: true, at: new Date().toISOString(), output: { events: [] } })
};

interface World { engine: ConversationEngine; calls: string[]; saved: string[]; tokens: string[]; gateway: ModelGateway }
function world(scripts: Record<string, Step[]>, opts: { candidates?: string; tools?: boolean } = {}): World {
  const calls: string[] = [];
  const saved: string[] = [];
  const p = pool(saved);
  const gateway = new ModelGateway({ pool: p, trace: new MemoryTraceSink(), providers: Object.entries(scripts).map(([name, steps]) => adapter(name, steps, calls)) });
  const engine = new ConversationEngine({
    messages: new MessageStore(p), context: new ContextBuilder(p), gateway,
    tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
    chatCandidates: parseChatCandidates(opts.candidates, undefined),
    ...(opts.tools ? { tools: { definitions, executorFor: () => calendarExecutor, select: () => ({ definitions, limits: LIMITS, tool_ids: ["calendar"] }) } } : {})
  });
  return { engine, calls, saved, tokens: [], gateway };
}

const identity = (channel: IdentityContext["channel"] = "web"): IdentityContext => ({ person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel, auth_strength: "active" });
const PLAIN = "fortell meg en kort vits om katter";
const BUSINESS = "skriv et kort sammendrag av kontrakten med kunden";
let logs: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => { vi.restoreAllMocks(); logs = undefined; });
const quietLogs = () => { logs = vi.spyOn(console, "log").mockImplementation(() => undefined); vi.spyOn(console, "error").mockImplementation(() => undefined); };
const logged = (msg: string) => (logs?.mock.calls ?? []).map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return {}; } }).filter((l) => l["msg"] === msg);
const NOTE = "\n\n(Reservemodell brukt: gemma_local var ikke tilgjengelig, så svaret kom fra skymodellen gemma_hosted.)";

describe("M2: reserven er synlig også etter et ubrukelig svar (reviewerens repro)", () => {
  it("gemma_local svarer TOMT, gemma_hosted «hei fra skyen» → merknaden og wpd4_chat_reserve_used (før rettelsen: ingen av delene)", async () => {
    quietLogs();
    const w = world({ gemma_local: ["empty"], gemma_hosted: [{ text: "hei fra skyen" }] });
    const reply = await w.engine.handle(identity(), PLAIN);
    expect(reply.reply).toBe(`hei fra skyen${NOTE}`);
    expect(w.saved).toEqual([reply.reply]);
    expect(logged("wpd4_chat_reserve_used")).toEqual([{ msg: "wpd4_chat_reserve_used", failed: ["gemma_local"], served: "gemma_hosted", cloud: true }]);
  });

  it.each([
    ["tomt svar", "empty"],
    ["bare blanke tegn", "blank"],
    ["avkortet svar uten tekst (finish_reason=length)", "truncated"],
    ["ugyldig svar fra leverandøren", "invalid_response"],
    ["feil før første tegn (nettverk)", "network"],
    ["feil før første tegn (tidsavbrudd)", "timeout"]
  ] as const)("%s fra primæren: reserven svarer og merknaden vises (ikke-strømmet OG strømmet)", async (_label, step) => {
    for (const streamed of [false, true]) {
      quietLogs();
      const w = world({ gemma_local: [step], gemma_hosted: ["ok"] });
      const reply = await w.engine.handle(identity(), PLAIN, streamed ? (t) => w.tokens.push(t) : undefined);
      expect(reply.reply, `${step} streamed=${streamed}`).toBe(`svar fra gemma_hosted${NOTE}`);
      // Blanke tegn er ikke «synlig output» (D-444) og slippes ut i strømmen før gatewayen avgjør at resultatet er ubrukelig; resten av strømmen er svaret med merknaden.
      if (streamed) expect(w.tokens.join("").trimStart(), step).toBe(reply.reply);
      expect(logged("wpd4_chat_reserve_used"), step).toEqual([{ msg: "wpd4_chat_reserve_used", failed: ["gemma_local"], served: "gemma_hosted", cloud: true }]);
      vi.restoreAllMocks();
    }
  });

  it("BUSINESS_CONFIDENTIAL med JARVIS_CHAT_CANDIDATES=gemma_local,gemma_hosted,anthropic: tomt lokalt svar gir IKKE lenger stille Anthropic - merknaden navngir skymodellen", async () => {
    quietLogs();
    const w = world({ gemma_local: ["empty"], gemma_hosted: ["ok"], anthropic: ["ok"] }, { candidates: "gemma_local,gemma_hosted,anthropic" });
    const reply = await w.engine.handle(identity(), BUSINESS);
    // gemma_hosted (gratis delt sky) er utelukket av sensitiviteten, så Anthropic er neste kvalifiserte medlem.
    expect(w.calls).toEqual(["gemma_local", "anthropic"]);
    expect(reply.reply).toBe("svar fra anthropic\n\n(Reservemodell brukt: gemma_local var ikke tilgjengelig, så svaret kom fra skymodellen anthropic.)");
    expect(logged("wpd4_chat_reserve_used")).toEqual([{ msg: "wpd4_chat_reserve_used", failed: ["gemma_local"], served: "anthropic", cloud: true }]);
  });

  it("friskt primærsvar: ingen merknad og ingen logg (ingen falske alarmer)", async () => {
    quietLogs();
    const w = world({ gemma_local: ["ok"], gemma_hosted: ["ok"] });
    const reply = await w.engine.handle(identity(), PLAIN);
    expect(reply.reply).toBe("svar fra gemma_local");
    expect(logged("wpd4_chat_reserve_used")).toEqual([]);
  });

  it("på tale (voice) vises ingen merknad (TTS leser alt høyt), men loggen har den", async () => {
    quietLogs();
    const w = world({ gemma_local: ["empty"], gemma_hosted: ["ok"] });
    const reply = await w.engine.handle(identity("voice"), PLAIN);
    expect(reply.reply).toBe("svar fra gemma_hosted");
    expect(logged("wpd4_chat_reserve_used")).toHaveLength(1);
  });

  it("L6: alle i kjeden gir tomt svar → siste reserve (vanlig ruting) prøver bare leverandører som IKKE allerede er forsøkt i kjeden", async () => {
    quietLogs();
    const w = world({ gemma_local: ["empty"], gemma_hosted: ["empty"], anthropic: ["ok"] });
    const reply = await w.engine.handle(identity(), PLAIN);
    expect(reply.reply).toBe("svar fra anthropic\n\n(Reservemodell brukt: gemma_local og gemma_hosted var ikke tilgjengelige, så svaret kom fra skymodellen anthropic.)");
    // L6: hver av de to første er forsøkt nøyaktig ÉN gang (tomt svar prøves ikke om), og siste reserve gjentar dem ikke.
    expect(w.calls.filter((c) => c === "gemma_local")).toHaveLength(1);
    expect(w.calls.filter((c) => c === "gemma_hosted")).toHaveLength(1);
  });
});

describe("L6: siste reserve (vanlig ruting) gjentar ikke leverandører som allerede er forsøkt i kjeden", () => {
  it("hver leverandør prøves høyst to ganger (ett forsøk + én retry) gjennom HELE turen - tidligere opptil fire", async () => {
    quietLogs();
    const w = world({ gemma_local: ["network"], gemma_hosted: ["server"], openai: ["network"], anthropic: ["ok"] });
    const reply = await w.engine.handle(identity(), PLAIN);
    expect(reply.reply.startsWith("svar fra anthropic")).toBe(true);
    for (const name of ["gemma_local", "gemma_hosted", "openai", "anthropic"]) expect(w.calls.filter((c) => c === name).length, name).toBeLessThanOrEqual(2);
    expect(w.calls).toEqual(["gemma_local", "gemma_local", "gemma_hosted", "gemma_hosted", "openai", "openai", "anthropic"]);
    expect(reply.reply).toContain("gemma_local, gemma_hosted og openai var ikke tilgjengelige");
  });

  it("er alle kvalifiserte allerede forsøkt, kommer den OPPRINNELIGE feilen tilbake (SECRET_RESTRICTED: aldri sky, og kun de to forsøkene mot den lokale)", async () => {
    quietLogs();
    const w = world({ gemma_local: ["network"], gemma_hosted: ["ok"], anthropic: ["ok"] });
    await expect(w.engine.handle(identity(), "Jeg har diabetes og lurer på blodsukker og insulin")).rejects.toMatchObject({ provider: "gemma_local", kind: "network" });
    expect(w.calls).toEqual(["gemma_local", "gemma_local"]);
  });

  it("utelukkingen gjelder bare omkjøringen: neste tur starter på nytt med hele kjeden (en leverandør som feilet i går er ikke utestengt)", async () => {
    quietLogs();
    const w = world({ gemma_local: ["empty", "ok"], gemma_hosted: ["ok"] });
    const first = await w.engine.handle(identity(), PLAIN);
    expect(first.reply).toBe(`svar fra gemma_hosted${NOTE}`);
    const second = await w.engine.handle(identity(), PLAIN);
    expect(second.reply).toBe("svar fra gemma_local");
  });
});

describe("M2: primæren hoppet over pga. helse er også en reserve", () => {
  it("etter gjentatte utfall (UNAVAILABLE) vises merknaden på HVER tur mens pausen varer - ikke bare den første", async () => {
    quietLogs();
    const w = world({ gemma_local: ["network"], gemma_hosted: ["ok"] });
    await w.engine.handle(identity(), PLAIN);
    await w.engine.handle(identity(), PLAIN); // fire sammenhengende feil ⇒ UNAVAILABLE
    expect(w.gateway.health.state("gemma_local", true)).toBe("UNAVAILABLE");
    w.calls.length = 0;
    const third = await w.engine.handle(identity(), PLAIN);
    expect(w.calls).toEqual(["gemma_hosted"]);
    expect(third.reply).toBe(`svar fra gemma_hosted${NOTE}`);
    const fourth = await w.engine.handle(identity(), PLAIN);
    expect(fourth.reply).toBe(`svar fra gemma_hosted${NOTE}`);
  });
});

describe("L11: flerrunde verktøytur - skyleverandøren som betjente en tidligere runde nevnes", () => {
  it("runde 1 på skyreserven (lokal nede), siste runde på den lokale som kom tilbake: merknaden navngir begge (før rettelsen: ingen merknad, fordi den lokale både feilet og svarte)", async () => {
    quietLogs();
    // gemma_local: nede i runde 1 (to forsøk), frisk i runde 2. anthropic: tar verktøykallet i runde 1.
    const w = world({ gemma_local: ["network", "network", "ok"], anthropic: ["tool"] }, { candidates: "gemma_local,anthropic", tools: true });
    const reply = await w.engine.handle(identity(), "hva står i kalenderen min?");
    expect(reply.reply).toBe(
      "svar fra gemma_local\n\n(Reservemodell brukt: gemma_local var ikke tilgjengelig i en runde, så en del av svaret kom fra skymodellen anthropic.)"
    );
    expect(w.calls).toEqual(["gemma_local", "gemma_local", "anthropic", "gemma_local"]);
    expect(logged("wpd4_chat_reserve_used")).toEqual([{ msg: "wpd4_chat_reserve_used", failed: ["gemma_local"], served: "gemma_local", cloud: false, earlier_cloud: ["anthropic"] }]);
  });

  it("alle runder på skyreserven: den vanlige merknaden (svaret kom fra skymodellen), uendret av L11", async () => {
    quietLogs();
    const w = world({ gemma_local: ["network"], anthropic: ["tool"] }, { candidates: "gemma_local,anthropic", tools: true });
    const reply = await w.engine.handle(identity(), "hva står i kalenderen min?");
    expect(reply.reply).toBe("ferdig fra anthropic\n\n(Reservemodell brukt: gemma_local var ikke tilgjengelig, så svaret kom fra skymodellen anthropic.)");
  });

  it("ingen feil i turen: ingen merknad selv om flere leverandører kunne betjent den (kun reservebruk utløser merknaden)", async () => {
    quietLogs();
    const w = world({ gemma_local: ["tool"], anthropic: ["ok"] }, { candidates: "gemma_local,anthropic", tools: true });
    const reply = await w.engine.handle(identity(), "hva står i kalenderen min?");
    expect(reply.reply).toBe("ferdig fra gemma_local");
    expect(logged("wpd4_chat_reserve_used")).toEqual([]);
  });

  it("på tale vises ingen merknad for flerrunde-reserven, men loggen har den", async () => {
    quietLogs();
    const w = world({ gemma_local: ["network", "network", "ok"], anthropic: ["tool"] }, { candidates: "gemma_local,anthropic", tools: true });
    const reply = await w.engine.handle(identity("voice"), "hva står i kalenderen min?");
    expect(reply.reply).toBe("svar fra gemma_local");
    expect(logged("wpd4_chat_reserve_used")).toHaveLength(1);
  });
});

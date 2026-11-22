import { vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { BudgetExceededError, ClaudeBudgetBlockedError, MemoryTraceSink, NoEligibleProviderError, type AiCouncil, type CompleteInput, type ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import { ProviderError, type ProviderErrorKind, type StreamEvent, type ToolCallRequest, type ToolDefinition, type ToolResultMessage } from "@jarvis/provider-adapters";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { SURFACE_LIMITS, type Surface } from "@jarvis/tool-gateway";
import { ConversationEngine } from "../../src/conversation.ts";

/**
 * WP-N1: felles motorsele for (a) DIFFERENSIALTESTEN «flagg AV == main» og (b) flagg-PÅ-testene.
 *
 * Selen bruker KUN API-er som finnes både på origin/main og i dette treet (konstruktør-valgene til `ConversationEngine`, `messages.save/history`, `context.build`), slik at SAMME fil og SAMME scenarier kan kjøres mot en ren
 * kopi av main (baseline-fixturen, se `wpn1-flag-off-differential.test.ts`) og mot dette treet med flagget AV. Alt er falskt og deterministisk: modeller (gateway), minne, rådet, lagring og verktøyutvalg. Verktøyutvalget er
 * BEVISST en liten, fast velger (ikke produksjonens `selectSurfaceTools`): N1 rører ikke utvalget, og en fast velger gjør baseline uavhengig av senere WP-ers endringer i verktøysettet - det som måles er motorens
 * ruting, historikkbehandling og lagring.
 */
export type Row = { role: "user" | "assistant"; content: string; restricted?: boolean };
export type Meta = { text: string; spaces: string[]; sensitivities: string[] };
export type ChannelName = "web" | "voice";

export type ErrorSpec =
  | { kind: "provider"; provider: string; errKind: ProviderErrorKind; message?: string; partial?: string }
  | { kind: "budget"; level: "needs_approval" | "hard_blocked" }
  | { kind: "no_eligible"; detail: string }
  /** Kun for flagg-PÅ-tester (WP-B4-klassen finnes ikke på main, så ingen baseline-scenarier bruker den). */
  | { kind: "claude_budget" }
  | { kind: "generic"; message: string };

export interface Scenario {
  id: string;
  text: string;
  /** Historikken FØR denne turen (eldst først). `restricted: true` på en rad = et merke fra en tidligere periode med flagget på. */
  prior?: Row[];
  meta?: Meta;
  /** Feil per gateway-kall (0-basert indeks over ALLE kall); null/utelatt = ok. */
  failures?: Array<ErrorSpec | null>;
  /** Verktøyrute til skyen (standard på: anthropic Sonnet). */
  toolRoute?: boolean;
  /** Dagstaket for skyturer er nådd. */
  dayCapReached?: boolean;
  /** Verktøykall «modellen» ber om i første runde (utføres gjennom motorens egen executor). */
  roundCalls?: string[];
  /** Hurtigbanens bakgrunnsjobb: hva transporten sier om skyflagget (standard: følger motorens svar). */
  delegateCloud?: boolean;
  /** Rådet er konfigurert (standard ja). */
  council?: boolean;
  /** Bruk strømming (onToken gitt). */
  streaming?: boolean;
  /** Eksplisitt `provider`-valg (API/tale-enhet). */
  provider?: string;
}

export interface GatewayCall {
  api: "complete" | "stream" | "completeWithTools";
  sensitivity: string | null;
  provider: string | null;
  preference: string[] | null;
  failover: boolean | null;
  mode: string | null;
  paid_models_allowed: boolean | null;
  model: string | null;
  messages: string[];
  has_memory_block: boolean;
  has_tool_catalog: boolean;
  tools: string[] | null;
  local_stickiness: boolean | null;
  /** Bærer noen av meldingene som sendes til modellen andre felt enn role/content (f.eks. et lekket `restricted`-merke)? */
  extra_message_fields: boolean;
}

export interface Observation {
  result: { reply: string; routed: string; cancelled?: boolean; interrupted?: boolean; confirmations?: number; task_id?: string } | { thrown: string };
  gateway: GatewayCall[];
  saved: Array<{ role: string; content: string; argc: number; restricted: boolean }>;
  /** Rekkefølgen av lagring, merking og modellkall (f.eks. `save:user`, `mark`, `gateway`, `save:assistant`). */
  events: string[];
  /** Hele historikken etter turen (som neste tur ville lest den), med merker. */
  rows_after: Row[];
  marks: number;
  tokens: string;
  council: Array<{ sensitivity: string | null; paid_models_allowed: boolean | null }>;
  logs: string[];
  ingest: Array<{ text: string; recent_turns: string[] | null }>;
  delegate: Array<{ prompt: string; cloud_allowed: boolean | null }>;
  tool_results: Array<{ tool: string; success: boolean }>;
}

export const baseIdentity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };
export const identityFor = (channel: ChannelName): IdentityContext => ({ ...baseIdentity, channel });
export const ROUTE = { provider: "anthropic", model: "claude-sonnet-5-5" };
export const STARTED = "Jobben «list åpne PR-er» er startet i bakgrunnen. Jeg gir beskjed her når den er ferdig - du kan fortsette å snakke med meg.";

const def = (name: string): ToolDefinition => ({ name, description: `verktøy ${name}`, input_schema: { type: "object", properties: {} } });
const TOOLS: Record<string, { definition: ToolDefinition; tool_id: string }> = {
  finance_list_balances: { definition: def("finance_neonomics__list_balances"), tool_id: "finance_neonomics" },
  github_list_prs: { definition: def("github__list_pull_requests"), tool_id: "github" },
  email_read_inbox: { definition: def("email__read_inbox"), tool_id: "email" },
  memory_search: { definition: def("search_my_memory"), tool_id: "memory" }
};
const ALL_DEFINITIONS = Object.values(TOOLS).map((t) => t.definition);

/**
 * Fast verktøyvelger (D-381/D-389-formen): finans (låser turen, kun web), GitHub, e-post og minne (kun reserven). En melding uten egne treff arver tjenesten fra eierens tre siste meldinger (som `selectSurfaceTools`).
 * Finans står ikke på talefaten (tale har ikke finansverktøy).
 */
function select(input: { surface: Surface; text: string; recent_owner_messages?: string[] }): { definitions: ToolDefinition[]; limits: (typeof SURFACE_LIMITS)[Surface]; tool_ids: string[]; min_sensitivity?: "SECRET_RESTRICTED" } {
  const limits = SURFACE_LIMITS[input.surface];
  const pick = (probe: string): string[] => {
    const keys: string[] = [];
    if (input.surface !== "voice" && /saldo|bank|konto|lån|betaling|stripe|vipps|regnskap/i.test(probe)) keys.push("finance_list_balances");
    if (/\bPR\b|pull request|github|issue/i.test(probe)) keys.push("github_list_prs");
    if (/e-?post|mail|innboks/i.test(probe)) keys.push("email_read_inbox");
    if (/husk|minne|husker/i.test(probe)) keys.push("memory_search");
    return keys;
  };
  let keys = pick(input.text);
  if (keys.length === 0) keys = pick((input.recent_owner_messages ?? []).slice(-3).join("\n"));
  const definitions = keys.map((k) => TOOLS[k]!.definition);
  const tool_ids = keys.map((k) => TOOLS[k]!.tool_id);
  const locked = keys.includes("finance_list_balances");
  return { definitions, limits, tool_ids, ...(locked ? { min_sensitivity: "SECRET_RESTRICTED" as const } : {}) };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

function buildError(spec: ErrorSpec): Error {
  switch (spec.kind) {
    case "provider": return new ProviderError(spec.provider, spec.errKind, spec.message ?? `feil ${spec.errKind}`);
    case "budget": return new BudgetExceededError(spec.level, 123_00);
    case "no_eligible": return new NoEligibleProviderError(spec.detail);
    case "claude_budget": return new ClaudeBudgetBlockedError("exhausted", "unknown", "important", "claude_budget_closed", null, Date.now() + 3_600_000);
    case "generic": return new Error(spec.message);
  }
}

export interface RunOptions {
  /** `true` = flagget PÅ (motoren får `restrictedContextGuard: true`); `false`/`undefined` = AV (valget utelatt, som `main.ts` gjør). */
  guard?: boolean | "explicit-false";
  /** Hva `markRestricted` svarer (standard `true`). */
  markResult?: boolean;
  /** `markRestricted` kaster. */
  markThrows?: boolean;
}

/** Kjører ÉN tur og returnerer alt som kan observeres utenfra. Samme kode kjøres mot main (baseline) og mot dette treet. */
export async function runScenario(scenario: Scenario, channel: ChannelName, options: RunOptions = {}): Promise<Observation> {
  const store: Array<{ id: string; role: "user" | "assistant"; content: string; restricted: boolean }> = (scenario.prior ?? []).map((m, i) => ({ id: `pre-${i}`, role: m.role, content: m.content, restricted: m.restricted === true }));
  const saved: Observation["saved"] = [];
  const events: string[] = [];
  const gateway: GatewayCall[] = [];
  const councilCalls: Observation["council"] = [];
  const ingest: Observation["ingest"] = [];
  const delegate: Observation["delegate"] = [];
  const toolResults: Observation["tool_results"] = [];
  let marks = 0;
  let nextId = 0;
  const rows = (limit: number) => store.slice(-limit).map((m) => ({ message_id: m.id, role: m.role, content: m.content, created_at: "2026-11-22T08:00:00.000Z", restricted: m.restricted }));

  const messages = {
    save: async (...args: unknown[]) => {
      const [, role, content, extra] = args as [unknown, "user" | "assistant", string, { restricted?: boolean } | undefined];
      const id = `new-${nextId++}`;
      store.push({ id, role, content, restricted: extra?.restricted === true });
      saved.push({ role, content, argc: args.length, restricted: extra?.restricted === true });
      events.push(`save:${role}${extra?.restricted === true ? ":restricted" : ""}`);
      return id;
    },
    markRestricted: async (_identity: unknown, id: string) => {
      marks += 1;
      events.push("mark");
      if (options.markThrows) throw new Error("db nede");
      const row = store.find((m) => m.id === id);
      if (row && options.markResult !== false) row.restricted = true;
      return options.markResult === false ? false : row !== undefined;
    },
    history: async (_identity: unknown, limit = 20) => rows(limit)
  } as unknown as ConstructorParameters<typeof ConversationEngine>[0]["messages"];
  const context = { build: async () => ({ history: rows(20), open_tasks: [] }) } as unknown as ConstructorParameters<typeof ConversationEngine>[0]["context"];

  const executor: ToolExecutor = {
    execute: async (call: ToolCallRequest): Promise<ToolResultMessage> => {
      toolResults.push({ tool: call.tool_name, success: true });
      return { tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "e", success: true, output: [], at: "2026-11-22T08:00:00.000Z", trust: "internal", source: call.tool_name };
    }
  };

  const record = (api: GatewayCall["api"], input: CompleteInput, toolOptions?: { tools?: Array<{ name: string }>; localStickiness?: boolean }): void => {
    gateway.push({
      api,
      sensitivity: input.sensitivity ?? null,
      provider: input.provider ?? null,
      preference: (input.providerPreference as string[] | undefined) ?? null,
      failover: (input as { preferenceFailover?: boolean }).preferenceFailover ?? null,
      mode: (input as { mode?: string }).mode ?? null,
      paid_models_allowed: (input as { paid_models_allowed?: boolean }).paid_models_allowed ?? null,
      model: input.request.model ?? null,
      messages: input.request.messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`),
      has_memory_block: (input.request.system ?? "").includes("MINNEBLOKK"),
      has_tool_catalog: (input.request.system ?? "").includes("Tjenester du kan bruke"),
      tools: toolOptions?.tools ? toolOptions.tools.map((t) => t.name) : null,
      local_stickiness: toolOptions?.localStickiness ?? null,
      extra_message_fields: input.request.messages.some((m) => Object.keys(m).some((k) => k !== "role" && k !== "content"))
    });
    events.push("gateway");
  };
  const serve = async (api: GatewayCall["api"], input: CompleteInput, onEvent?: (e: StreamEvent) => void, toolOptions?: { executor?: ToolExecutor; tools?: Array<{ name: string }>; localStickiness?: boolean }) => {
    const index = gateway.length;
    record(api, input, toolOptions);
    const failure = scenario.failures?.[index];
    if (failure) {
      if (failure.kind === "provider" && failure.partial) onEvent?.({ type: "text_delta", text: failure.partial });
      throw buildError(failure);
    }
    const provider = (input.providerPreference as string[] | undefined)?.[0] ?? input.provider ?? "gemma_local";
    if (api === "completeWithTools" && index === 0) {
      for (const name of scenario.roundCalls ?? []) {
        await toolOptions?.executor?.execute({ tool_call_id: `c-${name}`, tool_name: name, arguments: {}, provider, model: "m" }, { tenant_id: "t1", idempotency_key: `k-${name}` });
      }
    }
    return { text: `svar ${index}`, usage: { input_tokens: 1, output_tokens: 1 }, provider, model: "m" };
  };
  const gatewayFake = {
    complete: (input: CompleteInput) => serve("complete", input),
    stream: (input: CompleteInput, onEvent?: (e: StreamEvent) => void) => serve("stream", input, onEvent),
    completeWithTools: (input: CompleteInput, toolOptions?: { executor?: ToolExecutor; tools?: Array<{ name: string }>; localStickiness?: boolean; onEvent?: (e: StreamEvent) => void }) => serve("completeWithTools", input, toolOptions?.onEvent, toolOptions)
  } as unknown as ModelGateway;

  const council = scenario.council === false ? undefined : ({
    run: async (input: { sensitivity?: string; paid_models_allowed?: boolean }) => {
      councilCalls.push({ sensitivity: input.sensitivity ?? null, paid_models_allowed: input.paid_models_allowed ?? null });
      return {
        council_id: "council-n1", decision: "Rådets vurdering", consensus_status: "CONSENSUS", supporting_models: ["anthropic"], dissenting_models: [], key_evidence: [], key_disagreements: [], risk_summary: "", confidence: 80,
        recommended_action: "", provenance: { council_id: "council-n1", full_council: false, requested_members: [], unavailable_members: [], round1: [], round2: [], round3: [], synthesis_provider: "anthropic" }
      };
    }
  } as unknown as AiCouncil);

  const memory = {
    contextFor: async () => scenario.meta?.text ?? "",
    contextWithMeta: async () => scenario.meta ?? { text: "", spaces: [], sensitivities: [] },
    ingest: async (_identity: unknown, text: string, opts?: { recent_turns?: Array<{ role: string; content: string }> }) => {
      ingest.push({ text, recent_turns: opts?.recent_turns ? opts.recent_turns.map((t) => `${t.role}: ${t.content}`) : null });
    }
  };

  const logs: string[] = [];
  const spyLog = vi.spyOn(console, "log").mockImplementation((line?: unknown) => { pushLog(logs, line); });
  const spyErr = vi.spyOn(console, "error").mockImplementation((line?: unknown) => { pushLog(logs, line); });
  const guardOptions = options.guard === true ? { restrictedContextGuard: true } : options.guard === "explicit-false" ? { restrictedContextGuard: false } : {};
  const engine = new ConversationEngine({
    messages, context, gateway: gatewayFake,
    tasks: {
      create: async (_i: unknown, goal: string) => ({ ok: true, value: { task_id: `task-${goal.length}` } }),
      get: async (_i: unknown, id: string) => ({ ok: true, value: { task_id: id, status: "running" } }),
      cancel: async () => ({ ok: true, value: { cancelled: true, outcome: "cancelled" } })
    } as unknown as TaskService,
    worker: {} as unknown as InProcessWorker,
    trace: new MemoryTraceSink(),
    toolTurnRoute: scenario.toolRoute === false ? null : ROUTE,
    ...(scenario.dayCapReached ? { toolTurnDayCap: { cap_ore: 3000, spentToday: async () => 3000 } } : {}),
    ...(council ? { council } : {}),
    memory,
    selfDiagnosis: { run: async () => "Selvdiagnose: ingen funn." },
    sloReport: { run: async () => "Tjenestemål: ok." },
    evolutionReport: { run: async () => "Evolusjon: observasjonsmodus." },
    costReport: { run: async () => "Kostnad siste 7 dager: 12 kr." },
    valueReport: { run: async () => "Bruk: 14 samtaler." },
    delegateBackground: {
      run: async (_identity: unknown, prompt: string, opts?: { cloudAllowed: boolean }) => {
        delegate.push({ prompt, cloud_allowed: opts?.cloudAllowed ?? null });
        return { started: true, reply: STARTED, cloud: scenario.delegateCloud ?? opts?.cloudAllowed === true };
      }
    },
    tools: {
      definitions: ALL_DEFINITIONS,
      executorFor: () => executor,
      catalog: () => "katalog",
      select
    },
    ...guardOptions
  } as unknown as ConstructorParameters<typeof ConversationEngine>[0]);

  let tokens = "";
  let result: Observation["result"];
  try {
    const reply = await engine.handle(identityFor(channel), scenario.text, scenario.streaming ? (t: string) => { tokens += t; } : undefined, undefined, scenario.provider);
    result = {
      reply: reply.reply, routed: reply.routed,
      ...(reply.cancelled ? { cancelled: true } : {}), ...(reply.interrupted ? { interrupted: true } : {}),
      ...(reply.confirmations ? { confirmations: reply.confirmations.length } : {}), ...(reply.task_id ? { task_id: reply.task_id } : {})
    };
  } catch (err) {
    result = { thrown: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  } finally {
    await flush();
    spyLog.mockRestore();
    spyErr.mockRestore();
  }
  const rowsAfter: Row[] = store.map((m) => ({ role: m.role, content: m.content, ...(m.restricted ? { restricted: true } : {}) }));
  return { result, gateway, saved, events, rows_after: rowsAfter, marks, tokens, council: councilCalls, logs, ingest, delegate, tool_results: toolResults };
}

function pushLog(logs: string[], line: unknown): void {
  if (typeof line !== "string") return;
  try {
    const parsed = JSON.parse(line) as { msg?: unknown };
    if (typeof parsed.msg === "string") logs.push(parsed.msg);
  } catch {
    /* ikke-JSON: ignorert */
  }
}

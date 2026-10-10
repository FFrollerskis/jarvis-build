import { vi } from "vitest";
import type { ContextBuilder, MessageStore } from "@jarvis/core";
import type { IdentityContext } from "@jarvis/contracts";
import { MemoryTraceSink, type CompleteInput, type ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import type { ToolCallRequest, ToolResultMessage } from "@jarvis/provider-adapters";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  KnowledgeSearchTransport, MemorySearchTransport, firstWaveTools, homeAssistantTools, knowledgeToolDefinitions, memoryToolDefinitions, resolveModelToolSurface, selectSurfaceTools,
  type MeshToolMapping, type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, cloudToolTurnsAllowed, tasksDelegateToolDefinitions } from "../../src/chat-jobs.ts";
import { RunRateTransport, runRateToolDefinitions } from "../../src/run-rate.ts";
import { ConversationEngine } from "../../src/conversation.ts";

/**
 * D-449 (Q-50, gjennomgang nr. 4): felles testoppsett for hurtigbanen «… i bakgrunnen» mot chatten.
 *
 * `PRODUCTION_SURFACE` er chat-flatens verktøy slik `main.ts` bygger dem (`resolveModelToolSurface` over de samme verktøydefinisjonene med chattens lese-, handle- og delegeringsnivå) -
 * ikke et håndplukket utsnitt (gjennomgang nr. 4: paritetstabellen kjørte tidligere over 13 oppfunne verktøy). Transportene er tomme skall: kun definisjonene (navn, tjeneste, handling) brukes av utvalget.
 * `delegateBackground` oppfører seg som main.ts + `TasksDelegateTransport`: jobben får skyflagget bare når motoren sa ja OG transportens egen kontroll av jobbteksten (`cloudToolTurnsAllowed`,
 * den ekte funksjonen) også sier ja.
 */
function productionDefinitions(): ToolDefinition[] {
  const gateway = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(gateway))),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, gateway)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never)),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never))
    ]
  });
}
const definitions = productionDefinitions();
export const PRODUCTION_SURFACE: MeshToolMapping[] = resolveModelToolSurface({ list: () => definitions } as unknown as ToolGateway, {
  includeChatReadTier: true, includeChatActTier: true, includeChatDelegateTier: true
});

export type Row = { role: "user" | "assistant"; content: string };
export type Meta = { text: string; spaces: string[]; sensitivities: string[] };
/** Et minnetreff som bare finnes når spørringen inneholder ett av ordene (som ekte minnesøk: avhenger av teksten). */
export type MemItem = { terms: string[]; space: string; sensitivity: string };

export const route = { provider: "anthropic", model: "claude-sonnet-5-5" };
export const STARTED = "Jobben «list åpne PR-er» er startet i bakgrunnen. Jeg gir beskjed her når den er ferdig - du kan fortsette å snakke med meg.";

export const baseIdentity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };

/** Tittelen `main.ts` lager av promptens første linje. */
export const jobTitle = (prompt: string): string => (prompt.split("\n")[0] ?? prompt).replace(/\s+/g, " ").trim().slice(0, 70).padEnd(3, ".");

export interface FastPathRun {
  prompt: string;
  options: { cloudAllowed: boolean } | undefined;
  /** Om jobben FAKTISK fikk skyflagget (motoren sa ja OG transporten sa ja). */
  cloud: boolean;
}

export interface BuildOptions {
  prior?: Row[];
  meta?: Meta;
  /** Query-avhengig minne (heller enn en fast `meta`). */
  mem?: MemItem[] | null;
  metaThrows?: boolean;
  historyThrows?: boolean;
  withDelegate?: boolean;
  runResult?: { started: boolean; reply: string; cloud: boolean } | null;
  /** En assistentrad som lagres RETT ETTER eierens melding (en leveringsmelding fra en ferdig bakgrunnsjobb som kommer inn før historikken leses). */
  afterUserSave?: string;
  /** Q-51 D / #228: verktøykall «modellen» ber om i første runde; utføres gjennom motorens EGEN executor (som i ekte `completeWithTools`) og resultatene samles i `outputs`. */
  roundCalls?: ToolCallRequest[];
  /** Verktøyutføreren motoren gir gatewayen (standard: kaster - ikke brukt). */
  executor?: ToolExecutor;
  /** Det første `completeWithTools`-kallet feiler med denne (resten lykkes) - for å teste fallback til den lokale reserveruten. */
  failFirstWith?: Error;
  /** Dagstak for skyturer (D-432); udefinert = ingen. */
  dayCap?: { cap_ore: number; spentToday(tenantId: string): Promise<number> };
  /** Chattens verktøyrute (standard: Sonnet 5.5); `null` = av. */
  toolTurnRoute?: { provider: string; model: string } | null;
}

export interface Built {
  engine: ConversationEngine;
  runs: FastPathRun[];
  captured: CompleteInput[];
  store: Row[];
  memCalls: Array<{ text: string; options: unknown }>;
  /** Resultatene motorens executor ga tilbake for `roundCalls` (etter eventuell skjerming). */
  outputs: ToolResultMessage[];
  /** Valgene motoren ga hvert `completeWithTools`-kall (kun de som er relevante for rutingen). */
  toolOptionsSeen: Array<{ localStickiness: boolean | undefined }>;
  /** Navnene på verktøyene hvert `completeWithTools`-kall fikk (utvalget for akkurat den turen/varianten). */
  toolNamesSeen: string[][];
  /** Kall til gatewayens vanlige `complete`/`stream` (uten verktøyløkke), f.eks. D-380-fallbacken «svar uten verktøy». */
  plainCalls: CompleteInput[];
  /** Kall til `memory.ingest` (D-283/D-386): eierens ord og de siste turene før (som data). */
  ingestCalls: Array<{ text: string; recent_turns: Array<{ role: string; content: string }> | undefined }>;
}

export function buildEngine(opts: BuildOptions): Built {
  const runs: FastPathRun[] = [];
  const captured: CompleteInput[] = [];
  const outputs: ToolResultMessage[] = [];
  const toolOptionsSeen: Built["toolOptionsSeen"] = [];
  const ingestCalls: Built["ingestCalls"] = [];
  const plainCalls: CompleteInput[] = [];
  const toolNamesSeen: string[][] = [];
  const memCalls: Array<{ text: string; options: unknown }> = [];
  const store: Row[] = [...(opts.prior ?? [])];
  const rows = (limit: number) => store.slice(-limit).map((m, i) => ({ message_id: `m${i}`, role: m.role, content: m.content, created_at: new Date().toISOString() }));
  const messages = {
    save: async (_id: IdentityContext, role: "user" | "assistant", content: string) => {
      store.push({ role, content });
      if (opts.afterUserSave !== undefined && role === "user") store.push({ role: "assistant", content: opts.afterUserSave });
    },
    history: async (_id: IdentityContext, limit = 20) => { if (opts.historyThrows) throw new Error("db nede"); return rows(limit); }
  } as unknown as MessageStore;
  const context = { build: async () => ({ history: rows(20), open_tasks: [] }) } as unknown as ContextBuilder;
  const gateway = {
    complete: async (input: CompleteInput) => {
      plainCalls.push(JSON.parse(JSON.stringify(input)) as CompleteInput);
      return { text: "svar", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m" };
    },
    stream: async (input: CompleteInput) => {
      plainCalls.push(JSON.parse(JSON.stringify(input)) as CompleteInput);
      return { text: "svar", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m" };
    },
    completeWithTools: async (input: CompleteInput, toolOptions?: { executor?: ToolExecutor; localStickiness?: boolean; tools?: Array<{ name: string }> }) => {
      captured.push(JSON.parse(JSON.stringify(input)) as CompleteInput);
      toolOptionsSeen.push({ localStickiness: toolOptions?.localStickiness });
      toolNamesSeen.push((toolOptions?.tools ?? []).map((t) => t.name));
      if (opts.failFirstWith && captured.length === 1) throw opts.failFirstWith;
      for (const call of opts.roundCalls ?? []) {
        if (toolOptions?.executor) outputs.push(await toolOptions.executor.execute(call, { tenant_id: "t1", idempotency_key: `k-${call.tool_call_id}` }));
      }
      return { text: "svar", usage: { input_tokens: 1, output_tokens: 1 }, provider: "x", model: "m" };
    }
  } as unknown as ModelGateway;
  const memory = opts.mem === null ? undefined : {
    ingest: async (_id: IdentityContext, text: string, options?: { recent_turns?: Array<{ role: string; content: string }> }) => {
      ingestCalls.push({ text, recent_turns: options?.recent_turns });
    },
    contextFor: async (_id: IdentityContext, text: string) => (opts.meta ?? { text: "" }).text || (opts.mem ? lookup(opts.mem, text).text : ""),
    contextWithMeta: async (_id: IdentityContext, text: string, options?: unknown) => {
      memCalls.push({ text, options });
      if (opts.metaThrows) throw new Error("minne nede");
      if (opts.meta) return opts.meta;
      return opts.mem ? lookup(opts.mem, text) : { text: "", spaces: [], sensitivities: [] };
    }
  };
  const engine = new ConversationEngine({
    messages, context, gateway,
    tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
    toolTurnRoute: opts.toolTurnRoute === undefined ? route : opts.toolTurnRoute,
    ...(opts.dayCap ? { toolTurnDayCap: opts.dayCap } : {}),
    ...(memory ? { memory } : {}),
    tools: {
      definitions: PRODUCTION_SURFACE.map((m) => m.def) as never,
      executorFor: () => opts.executor ?? ({ execute: async () => { throw new Error("ikke brukt"); } }) as unknown as ToolExecutor,
      catalog: () => "katalog",
      select: ({ surface, text, recent_owner_messages }) => {
        const sel = selectSurfaceTools(surface, text, PRODUCTION_SURFACE, { recent_owner_messages: recent_owner_messages ?? [] });
        return { definitions: sel.selected.map((m) => m.def) as never, limits: sel.limits, tool_ids: sel.selected.map((m) => m.tool_id), ...(sel.min_sensitivity ? { min_sensitivity: sel.min_sensitivity } : {}) };
      }
    },
    ...(opts.withDelegate === false ? {} : {
      delegateBackground: {
        run: async (identity: IdentityContext, prompt: string, options?: { cloudAllowed: boolean }) => {
          // Som `TasksDelegateTransport`: kontrollerer selve jobbteksten uansett hva motoren sa, og rapporterer om jobben FAKTISK fikk skyflagget.
          const cloud = options?.cloudAllowed === true &&
            cloudToolTurnsAllowed({ title: jobTitle(prompt), prompt, memorySpaces: [identity.memory_space_id], servingModel: undefined, contentOrigin: "owner_direct" });
          runs.push({ prompt, options, cloud });
          return opts.runResult === undefined ? { started: true, reply: STARTED, cloud } : opts.runResult;
        }
      }
    })
  });
  return { engine, runs, captured, plainCalls, store, memCalls, outputs, toolOptionsSeen, toolNamesSeen, ingestCalls };
}

function lookup(items: MemItem[], text: string): Meta {
  const q = text.toLowerCase();
  const hits = items.filter((m) => m.terms.some((t) => q.includes(t)));
  if (hits.length === 0) return { text: "", spaces: [], sensitivities: [] };
  return { text: hits.map((h, i) => `- [minne ${i}] ${h.terms.join(" ")}`).join("\n"), spaces: [...new Set(hits.map((h) => h.space))], sensitivities: [...new Set(hits.map((h) => h.sensitivity))] };
}

/** Stillegger `console.log`/`console.error` (strukturerte loggliner) og gir tilbake en henter for loggede linjer med gitt `msg`. */
export function captureLogs(): { lines: (msg: string) => Array<{ msg: string; reasons?: string[] }>; restore: () => void } {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return {
    lines: (msg) =>
      log.mock.calls
        .map((c) => { try { return JSON.parse(String(c[0])) as { msg: string; reasons?: string[] }; } catch { return { msg: "" }; } })
        .filter((l) => l.msg === msg),
    restore: () => { log.mockRestore(); err.mockRestore(); }
  };
}

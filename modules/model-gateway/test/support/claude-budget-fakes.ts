import type pg from "pg";
import type { ModelProviderAdapter, ModelRequest, ModelResult, StreamHandler } from "@jarvis/provider-adapters";
import { ClaudeBudgetEnforcer, MemoryTraceSink, ModelGateway, claudeBudgetConfigFromEnv, type CompleteInput } from "../../src/index.ts";

/**
 * WP-B4 (D-476): delte test-fakes for Claude-kreditten - en fake pool som modellerer tenant (RLS via set_config), forbruksbokføring og revisjonsrader, scriptede leverandør-adaptere, og en `build()` som setter
 * sammen en ekte `ModelGateway` (+ `ClaudeBudgetEnforcer` med injisert klokke). Perioden er 15. nov → 15. des 2026 (30 døgn); klokka står midt i perioden (etter 15 av 30 døgn, dag 16): kurven er 47 250 øre, 1,3 × kurven 61 425,
 * tempobudsjettet 89 250, budsjettet 105 000.
 */
export const DAY = 86_400_000;
export const START = Date.UTC(2026, 10, 14, 23, 0, 0);
export const MID = START + 15 * DAY;
export const SPENT = { on_pace: 40_000, ahead: 55_000, tight: 70_000, reserve: 95_000, exhausted: 105_000 } as const;
export const HAIKU = "claude-haiku-4-5-20251001";

export interface AuditRow {
  tenant_id: string; person_id: string; session_id: string | null; type: string; decision: string | null; reason: string | null; tool_id: string | null; action: string | null;
  task_id: string | null; trace_id: string | null; payload: Record<string, unknown>;
}

export class FakeDb {
  readonly spend = new Map<string, number>();
  readonly audit: AuditRow[] = [];
  readonly statements: string[] = [];
  readonly costRows: Array<{ tenant_id: string; provider: string; model: string; amount_ore: number; purpose: string | null }> = [];
  /** Mislykkede forsøk (`model:failed:<kind>`): 0 øre som før, eller et anslag når Claude-kreditten er på (L2). */
  readonly failedRows: Array<{ tenant_id: string; provider: string; kind: string; amount_ore: number }> = [];
  spendReadError: Error | null = null;
  /** Lesingen av forbruket blir aldri besvart (databasen henger). */
  spendReadHangs = false;
  spendReadRow: Record<string, unknown> | null = null;
  spendReads = 0;
  guardSpentOre = 0;
  failAuditWrites = false;

  pool(): pg.Pool {
    return {
      connect: async () => {
        let tenant = "";
        return {
          query: async (sql: string, params: unknown[] = []) => {
            const text = sql.trim();
            if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) { this.statements.push(text.split(/\s/)[0]!.toUpperCase()); return { rows: [] }; }
            if (text.includes("set_config")) { tenant = String(params[0]); this.statements.push("SET_TENANT"); return { rows: [] }; }
            if (text.includes("FROM cost_events") && text.includes("provider = $4")) {
              this.spendReads += 1;
              this.statements.push("READ_CLAUDE_SPEND");
              if (this.spendReadHangs) await new Promise<never>(() => undefined);
              if (this.spendReadError !== null) throw this.spendReadError;
              if (this.spendReadRow !== null) return { rows: [this.spendReadRow] };
              const v = this.spend.get(tenant) ?? 0;
              return { rows: [{ window_ore: v, trailing_ore: v }] };
            }
            if (text.includes("FROM cost_events")) { this.statements.push("READ_BUDGET_GUARD"); return { rows: [{ spent: this.guardSpentOre }] }; }
            if (text.includes("INSERT INTO cost_events")) {
              if (/\$4, 0,/.test(text)) { this.statements.push("INSERT_COST_FAILED"); this.failedRows.push({ tenant_id: String(params[0]), provider: String(params[4]), kind: String(params[3]), amount_ore: 0 }); return { rows: [] }; }
              if (/\$4, \$9,/.test(text)) {
                // WP-B4 (L2): avbrutt/feilet kall bokført med et ANSLAG (øre) i stedet for 0
                this.statements.push("INSERT_COST_FAILED_ESTIMATED");
                const amount = Number(params[8]);
                const failed = { tenant_id: String(params[0]), provider: String(params[4]), kind: String(params[3]), amount_ore: amount };
                this.failedRows.push(failed);
                if (failed.provider === "anthropic") this.spend.set(failed.tenant_id, (this.spend.get(failed.tenant_id) ?? 0) + amount);
                return { rows: [] };
              }
              this.statements.push("INSERT_COST");
              const row = { tenant_id: String(params[0]), provider: String(params[5]), model: String(params[6]), amount_ore: Number(params[4]), purpose: params[9] === null ? null : String(params[9]) };
              this.costRows.push(row);
              if (row.provider === "anthropic") this.spend.set(row.tenant_id, (this.spend.get(row.tenant_id) ?? 0) + row.amount_ore); // bokføringen mater neste beslutning
              return { rows: [] };
            }
            if (text.includes("INSERT INTO audit_events")) {
              this.statements.push("INSERT_AUDIT");
              if (this.failAuditWrites) throw new Error("audit_down");
              this.audit.push({
                tenant_id: String(params[0]), person_id: String(params[1]), session_id: params[2] === null ? null : String(params[2]), type: String(params[4]), decision: params[5] === null ? null : String(params[5]),
                reason: params[6] === null ? null : String(params[6]), tool_id: params[7] === null ? null : String(params[7]), action: params[8] === null ? null : String(params[8]),
                task_id: params[11] === null ? null : String(params[11]), trace_id: params[12] === null ? null : String(params[12]), payload: JSON.parse(String(params[10])) as Record<string, unknown>
              });
              return { rows: [] };
            }
            this.statements.push("OTHER");
            return { rows: [] };
          },
          release: () => undefined
        };
      }
    } as unknown as pg.Pool;
  }
}

export interface AdapterOptions {
  usage?: { input_tokens: number; output_tokens: number };
  fail?: Error;
  hold?: () => Promise<void>;
  withStream?: boolean;
  script?: (request: ModelRequest, call: number) => Partial<ModelResult>;
  /** Full kontroll over strømmen (delvis tekst, avbrudd, feil midt i): erstatter standardstrømmen. */
  streamScript?: (request: ModelRequest, onEvent: StreamHandler, signal: AbortSignal | undefined) => Promise<ModelResult>;
}
export type FakeAdapter = ModelProviderAdapter & { calls: ModelRequest[]; streamCalls: ModelRequest[] };

export function adapter(name: string, model: string, options: AdapterOptions = {}): FakeAdapter {
  const calls: ModelRequest[] = [];
  const streamCalls: ModelRequest[] = [];
  const result = (request: ModelRequest, call: number): ModelResult => ({
    text: `svar fra ${name}`, usage: options.usage ?? { input_tokens: 100, output_tokens: 50 }, provider: name, model: request.model ?? model, finish_reason: "stop", ...(options.script?.(request, call) ?? {})
  });
  const base: ModelProviderAdapter & { calls: ModelRequest[]; streamCalls: ModelRequest[] } = {
    name, model, calls, streamCalls, available: () => true,
    complete: async (request) => {
      calls.push(request);
      await options.hold?.();
      if (options.fail !== undefined) throw options.fail;
      return result(request, calls.length);
    }
  };
  if (options.streamScript !== undefined) {
    const script = options.streamScript;
    base.stream = async (request: ModelRequest, onEvent: StreamHandler, signal?: AbortSignal) => {
      streamCalls.push(request);
      return script(request, onEvent, signal);
    };
  } else if (options.withStream === true) {
    base.stream = async (request: ModelRequest, onEvent: StreamHandler) => {
      streamCalls.push(request);
      await options.hold?.();
      if (options.fail !== undefined) throw options.fail;
      const r = result(request, streamCalls.length);
      onEvent({ type: "text_delta", text: r.text });
      onEvent({ type: "usage", usage: r.usage });
      onEvent({ type: "finish", finish_reason: "stop" });
      return r;
    };
  }
  return base;
}

export interface BuildOptions {
  flag?: boolean;
  env?: Record<string, string>;
  providers?: Array<"anthropic" | "gemma_local" | "openai">;
  anthropic?: AdapterOptions;
  local?: AdapterOptions;
  /** En betalt skyleverandør som IKKE er Anthropic (`openai`/gpt-5) - kun med når den står i `providers`. */
  openai?: AdapterOptions;
  /** Levetid (ms) for bufferen av forbruket i enforceren; utelatt = enforcerens standard. */
  spendCacheTtlMs?: number;
  now?: number;
  /** Frist for lesingen av forbruket (ms); standard i enforceren er 3 s. */
  spendTimeoutMs?: number;
}

export function build(opts: BuildOptions = {}) {
  const db = new FakeDb();
  const trace = new MemoryTraceSink();
  const clock = { now: opts.now ?? MID };
  const config = claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "100", ...opts.env });
  if (config === null) throw new Error("test-oppsett: budsjettet må være på");
  const enforcer = opts.flag === false ? undefined : new ClaudeBudgetEnforcer({
    config, pool: db.pool(), trace, actor_person_id: "owner-1", now: () => clock.now, ...(opts.spendTimeoutMs !== undefined ? { spend_timeout_ms: opts.spendTimeoutMs } : {}),
    ...(opts.spendCacheTtlMs !== undefined ? { spend_cache_ttl_ms: opts.spendCacheTtlMs } : {})
  });
  const anthropic = adapter("anthropic", "claude-sonnet-5-5", { withStream: true, ...opts.anthropic });
  const local = adapter("gemma_local", "gemma-local", { ...opts.local });
  const openai = adapter("openai", "gpt-5", { withStream: true, ...opts.openai });
  const names = opts.providers ?? ["anthropic", "gemma_local"];
  const providers = [...(names.includes("anthropic") ? [anthropic] : []), ...(names.includes("gemma_local") ? [local] : []), ...(names.includes("openai") ? [openai] : [])];
  const gateway = new ModelGateway({ pool: db.pool(), trace, providers, ...(enforcer !== undefined ? { claudeBudget: enforcer } : {}) });
  const budgetSpans = (): MemoryTraceSink["spans"] => trace.spans.filter((s) => s.kind === "budget");
  return { gateway, db, trace, clock, enforcer, anthropic, local, openai, config, budgetSpans };
}

export const REQ: ModelRequest = { messages: [{ role: "user", content: "hei" }], max_tokens: 200 };
/** Eierens egen chat-tur (økt, ingen jobb) = ESSENSIELL. `mode: QUALITY` rangerer Anthropic først, lokal som reserve. */
export const ownerTurn = (extra: Partial<CompleteInput> = {}): CompleteInput => ({ tenant_id: "t1", session_id: "s1", purpose: "CHAT", mode: "QUALITY", request: REQ, ...extra });
/** Bakgrunnsarbeid (jobb-id, minneuttrekk) = BAKGRUNN. */
export const background = (extra: Partial<CompleteInput> = {}): CompleteInput => ({ tenant_id: "t1", task_id: "job-1", purpose: "EXTRACT", mode: "QUALITY", request: REQ, ...extra });
/** En jobb eieren bestilte (delegert fra chat, kontrakten merker den BACKGROUND) = VIKTIG via opphavs-hint. */
export const ownerTask = (extra: Partial<CompleteInput> = {}): CompleteInput => ({ tenant_id: "t1", task_id: "job-2", purpose: "BACKGROUND", budget_origin: "owner_task", mode: "QUALITY", request: REQ, ...extra });

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import type { ModelPurpose, RouterMode } from "@jarvis/contracts";
import { createHash } from "node:crypto";
import {
  ProviderError,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type StreamHandler,
  type ToolCallRequest,
  type ToolDefinition,
  type ToolExchange,
  type ToolResultMessage
} from "@jarvis/provider-adapters";
import { BudgetGuard, type BudgetConfig, DEFAULT_BUDGET } from "./budget-guard.ts";
import { CapabilityRegistry, type ModelCapability } from "./capability-registry.ts";
import { ProviderHealthTracker, type ProviderHealthState } from "./provider-health.ts";
import { AiRouter, type RoutePlan } from "./router.ts";
import { costOre as computeCostOre, DEFAULT_PRICING, type PricingTable } from "./pricing.ts";
import type { TraceSink } from "./trace.ts";

/** Tydelig, maskinlesbar feil når budsjettet stopper kall (akseptanse 5). */
export class BudgetExceededError extends Error {
  constructor(
    readonly level: "needs_approval" | "hard_blocked",
    readonly spent_ore: number
  ) {
    super(
      level === "hard_blocked"
        ? `Månedsbudsjettet (hardgrense) er brukt opp (${(spent_ore / 100).toFixed(0)} kr). Nye modellkall nektes til grensen heves med signert overstyring.`
        : `Månedsforbruket (${(spent_ore / 100).toFixed(0)} kr) krever aktiv godkjenning før flere modellkall.`
    );
    this.name = "BudgetExceededError";
  }
}

export interface CompleteInput {
  tenant_id: string;
  session_id?: string;
  task_id?: string;
  request: ModelRequest;
  onToken?: (token: string) => void;
  /** UA-1: purpose-taksonomi for routing/kost/metrikk. */
  purpose?: ModelPurpose;
  /** UA-1: eksplisitt routing-mode; default AUTO. */
  mode?: RouterMode;
  /** UA-1 owner-override (§10): eksakt provider - ingen stille fallback. */
  provider?: string;
  required_capabilities?: ModelCapability[];
  /** UA-1 critic (§18): eksplisitt opt-in; aldri default. */
  critic?: boolean;
}

export interface GatewayOptions {
  pool: pg.Pool;
  /** Registrerte adaptere; router velger blant de som er konfigurert. */
  providers: ModelProviderAdapter[];
  trace: TraceSink;
  budget?: BudgetConfig;
  registry?: CapabilityRegistry;
  pricing?: PricingTable;
  /** Bakoverkompatibel enkel rate-tabell (øre/1k) - overstyrer pricing hvis satt. */
  rates?: Record<string, { input_per_1k_ore: number; output_per_1k_ore: number }>;
  /** Enkel rate limit: maks kall per minutt per tenant. */
  maxCallsPerMinute?: number;
}

/**
 * UA-1 P1A: trusted executor-grensesnitt. Gateway/modell har ALDRI direkte
 * verktøytilgang - all utførelse går via denne broen til Tool Gateway,
 * som håndhever Policy/Execution Authority/D-pipeline som før (§17).
 */
export interface ToolExecutor {
  execute(
    call: ToolCallRequest,
    ctx: { tenant_id: string; session_id?: string; task_id?: string; idempotency_key: string }
  ): Promise<ToolResultMessage>;
}

export interface ToolLoopOptions {
  tools: ToolDefinition[];
  executor: ToolExecutor;
  /** Streaming-events for hver runde (valgfritt). */
  onEvent?: StreamHandler;
  signal?: AbortSignal;
  /** Maks modellrunder (default 4) - aldri uendelig tool-loop. */
  maxRounds?: number;
}

/** Minimal, deterministisk JSON-Schema-validering (§25): required + ukjente felter. */
export function validateToolArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  const required = (schema["required"] as string[] | undefined) ?? [];
  for (const field of required) {
    if (!(field in args)) {
      return `missing_required:${field}`;
    }
  }
  if (schema["additionalProperties"] === false) {
    const allowed = new Set(Object.keys((schema["properties"] as Record<string, unknown> | undefined) ?? {}));
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) {
        return `unknown_field:${key}`;
      }
    }
  }
  return null;
}

export interface MeshProviderStatus {
  provider: string;
  model: string;
  state: ProviderHealthState;
  success: number;
  failures: number;
  avg_latency_ms?: number;
}

export interface MeshStatus {
  providers: MeshProviderStatus[];
  router: "HEALTHY";
  /** VERIFIED = cross-provider fallback har faktisk skjedd i denne runtime (§25). */
  fallback: "VERIFIED" | "READY" | "LOGIC_ONLY";
  critic: "VERIFIED" | "READY_SELECTIVE";
}

const CRITIC_SYSTEM =
  "Du er en kritisk kvalitetssjekker. Vurder svaret mot oppgaven: pek på faktiske feil, hull eller risiko. Svar kompakt: CONFIDENCE: <0-100> etterfulgt av punktliste med funn (eller 'ingen funn').";

/**
 * Model Gateway (CANONICAL_SPEC §7 + UA-1 AI Mesh): eneste vei til modell-
 * leverandører. Budsjett håndheves FØR kallet; router velger provider
 * deterministisk (registry+health); fallback er klassifisert, aldri blind;
 * kostnad/latency/purpose skrives til cost_events; alt spores i trace-sinken.
 */
export class ModelGateway {
  private readonly guard: BudgetGuard;
  private readonly callTimestamps = new Map<string, number[]>();
  private readonly registry: CapabilityRegistry;
  private readonly pricing: PricingTable;
  readonly health = new ProviderHealthTracker();
  private readonly router: AiRouter;
  private readonly byName = new Map<string, ModelProviderAdapter>();
  /** Runtime-evidens for /status (§25): satt først når hendelsen faktisk har skjedd. */
  private crossProviderFallbackSeen = false;
  private criticRunSeen = false;

  constructor(private readonly opts: GatewayOptions) {
    this.guard = new BudgetGuard(opts.pool, opts.budget ?? DEFAULT_BUDGET);
    this.registry = opts.registry ?? new CapabilityRegistry();
    this.pricing = opts.pricing ?? DEFAULT_PRICING;
    this.router = new AiRouter(this.registry, this.health);
    for (const p of opts.providers) {
      this.byName.set(p.name, p);
    }
  }

  private providerRuntimes(): Map<string, { configured: boolean; model: string }> {
    const map = new Map<string, { configured: boolean; model: string }>();
    for (const p of this.opts.providers) {
      map.set(p.name, { configured: p.available(), model: p.model ?? "ukjent" });
    }
    return map;
  }

  async complete(input: CompleteInput): Promise<ModelResult> {
    const started = Date.now();
    const traceId = `trace-${randomUUID()}`;

    this.enforceRateLimit(input.tenant_id);

    const budget = await this.guard.evaluate(input.tenant_id);
    if (budget.level === "hard_blocked" || budget.level === "needs_approval") {
      await this.opts.trace.record({
        trace_id: traceId,
        kind: "budget",
        name: `budget_${budget.level}`,
        tenant_id: input.tenant_id,
        ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
        ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
        at: new Date().toISOString(),
        duration_ms: Date.now() - started,
        metadata: { spent_ore: budget.spent_ore }
      });
      throw new BudgetExceededError(budget.level, budget.spent_ore);
    }

    const plan = this.router.plan(
      {
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.required_capabilities !== undefined
          ? { required_capabilities: input.required_capabilities }
          : {}),
        needs_structured: Boolean(input.request.structured_schema)
      },
      this.providerRuntimes()
    );

    const result = await this.executePlan(input, plan, traceId, started, budget.level, false);

    if (input.critic || plan.mode === "CRITIC") {
      await this.runCritic(input, result, traceId);
    }
    return result;
  }

  /**
   * Deterministisk fallback (§12): klassifiserte feil, aldri blind retry-spam.
   * Streaming (§10-§11): fallback KUN før første output; etter output-start er
   * policyen konservativ - stream markeres interrupted, aldri skjult provider-bytte.
   */
  private async executePlan(
    input: CompleteInput,
    plan: RoutePlan,
    traceId: string,
    started: number,
    budgetLevel: string,
    isCritic: boolean,
    requestOverride?: ModelRequest,
    streamOpts?: { onEvent: StreamHandler; signal?: AbortSignal }
  ): Promise<ModelResult> {
    const request = requestOverride ?? input.request;
    const failedProviders: string[] = [];
    let lastError: Error | null = null;

    for (const candidate of plan.candidates) {
      const adapter = this.byName.get(candidate.provider);
      if (!adapter || !adapter.available()) {
        continue;
      }
      if (failedProviders.length > 0 && streamOpts) {
        streamOpts.onEvent({
          type: "fallback",
          from: failedProviders[failedProviders.length - 1] as string,
          to: adapter.name,
          reason: (lastError as ProviderError | null)?.kind ?? "unknown"
        });
      }
      const maxTries = 2; // 1 + maks én retry for transient/invalid_response på samme provider
      for (let attempt = 1; attempt <= maxTries; attempt++) {
        const attemptStart = Date.now();
        let outputStarted = false;
        try {
          let result: ModelResult;
          if (streamOpts) {
            const guardedOnEvent: StreamHandler = (event) => {
              if (event.type === "text_delta" || event.type === "tool_call_start") {
                outputStarted = true;
              }
              streamOpts.onEvent(event);
            };
            if (adapter.stream) {
              result = await adapter.stream(request, guardedOnEvent, streamOpts.signal);
            } else {
              // Adapter uten native streaming: normalisert enkelt-delta (capability-routing
              // skal normalt hindre dette; brukes kun når streaming ikke er påkrevd cap).
              result = await adapter.complete(request, (token) => guardedOnEvent({ type: "text_delta", text: token }));
              streamOpts.onEvent({ type: "usage", usage: result.usage });
              streamOpts.onEvent({ type: "finish", finish_reason: result.finish_reason ?? "stop" });
            }
          } else {
            result = await adapter.complete(request, isCritic ? undefined : input.onToken);
          }
          const latency = result.latency_ms ?? Date.now() - attemptStart;
          this.health.recordSuccess(adapter.name, latency);
          if (failedProviders.some((p) => p !== adapter.name)) {
            this.crossProviderFallbackSeen = true;
          }
          result.metadata = {
            ...result.metadata,
            router: {
              mode: plan.mode,
              reason: plan.reason,
              ...(failedProviders.length > 0 ? { fallback_from: failedProviders } : {})
            }
          };
          const cost =
            this.legacyCostOverride(result) ??
            computeCostOre(this.pricing, result.provider, result.model, result.usage);
          await this.recordCost(input, result, cost, {
            success: true,
            fallback: failedProviders.length > 0,
            critic: isCritic,
            latency_ms: latency,
            // BO-11.1 §4: streaming-/tool-metrics SQL-spørrbare (migrasjon 016).
            stream: Boolean(streamOpts),
            ...(result.ttft_ms !== undefined ? { ttft_ms: result.ttft_ms } : {}),
            tool_calls: result.tool_calls?.length ?? 0
          });
          await this.opts.trace.record({
            trace_id: traceId,
            kind: "model_call",
            name: `${isCritic ? "critic:" : ""}${adapter.name}:${result.model}`,
            tenant_id: input.tenant_id,
            ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
            ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
            at: new Date().toISOString(),
            duration_ms: Date.now() - started,
            cost_ore: cost,
            metadata: {
              usage: { ...result.usage },
              budget_level: budgetLevel,
              router_mode: plan.mode,
              routing_reason: plan.reason,
              ...(input.purpose ? { purpose: input.purpose } : {}),
              ...(failedProviders.length > 0 ? { fallback_from: failedProviders } : {}),
              latency_ms: latency,
              ...(result.ttft_ms !== undefined ? { ttft_ms: result.ttft_ms } : {}),
              ...(result.tool_calls?.length ? { tool_calls_requested: result.tool_calls.length } : {}),
              critic: isCritic
            }
          });
          return result;
        } catch (err) {
          const pe =
            err instanceof ProviderError
              ? err
              : new ProviderError(adapter.name, "server", (err as Error).message);
          lastError = pe;
          // Bruker-cancellation er ikke provider-feil (§35): ingen health-straff, ingen fallback.
          if (pe.kind === "cancelled") {
            await this.recordFailedAttempt(input, adapter.name, pe, isCritic);
            throw pe;
          }
          this.health.recordFailure(adapter.name, pe.kind, pe.message);
          await this.recordFailedAttempt(input, adapter.name, pe, isCritic);
          // §11: etter output-start byttes ALDRI provider stille i samme stream.
          if (streamOpts && outputStarted) {
            streamOpts.onEvent({ type: "error", category: "stream_interrupted", message: pe.message.slice(0, 120) });
            throw new ProviderError(adapter.name, "stream_interrupted", pe.message);
          }
          // auth/bad_request/not_configured: aldri retry-spam på samme provider (§12).
          if (!(pe.retryableSameProvider && attempt < maxTries)) {
            break;
          }
        }
      }
      failedProviders.push(candidate.provider);
    }
    throw lastError ?? new ProviderError("router", "not_configured", "no_provider_available");
  }

  /**
   * UA-1 P1A: normalisert streaming (§3-§10). Fallback kun før første output;
   * cancel via signal gir ren avslutning uten zombie-generation (§9/§28).
   */
  async stream(input: CompleteInput, onEvent: StreamHandler, signal?: AbortSignal): Promise<ModelResult> {
    const started = Date.now();
    const traceId = `trace-${randomUUID()}`;
    this.enforceRateLimit(input.tenant_id);
    const budget = await this.guard.evaluate(input.tenant_id);
    if (budget.level === "hard_blocked" || budget.level === "needs_approval") {
      throw new BudgetExceededError(budget.level, budget.spent_ore);
    }
    const plan = this.router.plan(
      {
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        required_capabilities: [...(input.required_capabilities ?? []), "streaming"],
        needs_structured: Boolean(input.request.structured_schema)
      },
      this.providerRuntimes()
    );
    return this.executePlan(input, plan, traceId, started, budget.level, false, undefined, { onEvent, ...(signal ? { signal } : {}) });
  }

  /**
   * UA-1 P1A tool-løkke (§16, §19-§26): modell ber om verktøy → trusted executor
   * (Tool Gateway/Authority) → normalisert resultat → modellen fortsetter. Runder er
   * provider-nøytrale (tool_exchanges), så fallback etter utført verktøy fortsetter
   * med persistert resultat - aldri dobbel utførelse (§21).
   */
  async completeWithTools(input: CompleteInput, opts: ToolLoopOptions): Promise<ModelResult> {
    const maxRounds = opts.maxRounds ?? 4;
    const known = new Map(opts.tools.map((t) => [t.name, t]));
    const executed = new Map<string, ToolResultMessage>(); // idempotency: samme kall → samme resultat
    const exchanges: ToolExchange[] = [];
    let repairUsed = false;
    let forceFinal = false;
    let result: ModelResult | null = null;

    for (let round = 1; round <= maxRounds; round++) {
      // Siste runde / loop-vern: uten tools MÅ modellen syntetisere tekstsvar av
      // resultatene den alt har - aldri tom respons pga. runde-taket.
      const withTools = !forceFinal && round < maxRounds;
      const request: ModelRequest = {
        ...input.request,
        ...(withTools ? { tools: opts.tools } : {}),
        ...(exchanges.length > 0 ? { tool_exchanges: exchanges } : {})
      };
      const roundInput: CompleteInput = {
        ...input,
        required_capabilities: [...(input.required_capabilities ?? []), "tool_calling"],
        request
      };
      result = opts.onEvent
        ? await this.stream(roundInput, opts.onEvent, opts.signal)
        : await this.complete(roundInput);
      const calls = result.tool_calls ?? [];
      if (calls.length === 0) {
        break;
      }
      const sizeBefore = executed.size;
      const results: ToolResultMessage[] = [];
      for (const call of calls) {
        results.push(await this.executeToolCall(call, input, known, executed, () => {
          if (repairUsed) {
            return false;
          }
          repairUsed = true;
          return true;
        }, opts.executor));
      }
      exchanges.push({ calls, results });
      // Kun cache-treff i runden = modellen looper på samme kall → tving syntese (§19).
      if (executed.size === sizeBefore && results.every((r) => r.success)) {
        forceFinal = true;
      }
    }
    if (!result) {
      throw new ProviderError("router", "not_configured", "no_provider_available");
    }
    result.metadata = { ...result.metadata, tool_rounds: exchanges.length };
    return result;
  }

  /** Ett verktøykall: ukjent tool → DENY uten utførelse (§26); schema-feil → normalisert feil (§25). */
  private async executeToolCall(
    call: ToolCallRequest,
    input: CompleteInput,
    known: Map<string, ToolDefinition>,
    executed: Map<string, ToolResultMessage>,
    allowRepair: () => boolean,
    executor: ToolExecutor
  ): Promise<ToolResultMessage> {
    const at = new Date().toISOString();
    const def = known.get(call.tool_name);
    if (!def) {
      return {
        tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "none",
        success: false, output: null, error_category: "TOOL_NOT_FOUND", at
      };
    }
    const validationError = validateToolArgs(def.input_schema, call.arguments);
    if (validationError) {
      // Modellen får normalisert feil og kan reparere ÉN gang (§25); aldri delvis utførelse.
      allowRepair();
      return {
        tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "none",
        success: false, output: null, error_category: `INVALID_ARGUMENTS:${validationError}`, at
      };
    }
    const idempotencyKey = createHash("sha256")
      .update(`${input.tenant_id}:${input.task_id ?? input.session_id ?? "adhoc"}:${call.tool_name}:${JSON.stringify(call.arguments, Object.keys(call.arguments).sort())}`)
      .digest("hex")
      .slice(0, 32);
    const cached = executed.get(idempotencyKey);
    if (cached) {
      // Retry/fallback/reconnect: samme utførelse returneres - aldri dobbel side-effekt (§19).
      return { ...cached, tool_call_id: call.tool_call_id };
    }
    const result = await executor.execute(call, {
      tenant_id: input.tenant_id,
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
      idempotency_key: idempotencyKey
    });
    executed.set(idempotencyKey, result);
    return result;
  }

  /** Critic (§18-§19): separat modellkjøring, egen kostrad, aldri koblet til D-godkjenning. */
  private async runCritic(input: CompleteInput, primary: ModelResult, traceId: string): Promise<void> {
    try {
      const runtimes = this.providerRuntimes();
      // Foretrekk annen provider enn primær for uavhengig blikk; ellers samme.
      const others = new Map([...runtimes].filter(([name, rt]) => rt.configured && name !== primary.provider));
      const pool = others.size > 0 ? others : runtimes;
      const criticPlan = this.router.plan({ mode: "QUALITY", purpose: "CRITIQUE" }, pool);
      const lastUser = [...input.request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      // §30: critic er review-rolle - får ALDRI tools, kan aldri utføre side-effekter.
      const criticRequest: ModelRequest = {
        system: CRITIC_SYSTEM,
        messages: [
          {
            role: "user",
            content: `OPPGAVE:\n${lastUser.slice(0, 4000)}\n\nSVAR SOM SKAL VURDERES:\n${primary.text.slice(0, 6000)}`
          }
        ],
        max_tokens: 512
      };
      const criticResult = await this.executePlan(
        input,
        criticPlan,
        traceId,
        Date.now(),
        "ok",
        true,
        criticRequest
      );
      this.criticRunSeen = true;
      primary.metadata = {
        ...primary.metadata,
        critic: {
          provider: criticResult.provider,
          model: criticResult.model,
          critique: criticResult.text
        }
      };
    } catch (err) {
      // Critic er kvalitetsforsterkning - feil her skal aldri velte primærsvaret.
      primary.metadata = { ...primary.metadata, critic_error: (err as Error).message.slice(0, 120) };
    }
  }

  /** Kompakt mesh-status for /status og /ai (§37-§38). Ingen secrets. */
  meshStatus(): MeshStatus {
    const runtimes = this.providerRuntimes();
    const snapshot = this.health.snapshot(new Map([...runtimes].map(([k, v]) => [k, v.configured])));
    return {
      providers: [...runtimes].map(([name, rt]) => {
        const s = snapshot[name] as NonNullable<(typeof snapshot)[string]>;
        return {
          provider: name,
          model: rt.model,
          state: s.state,
          success: s.success,
          failures: s.failures,
          ...(s.avg_latency_ms !== undefined ? { avg_latency_ms: s.avg_latency_ms } : {})
        };
      }),
      router: "HEALTHY",
      fallback: this.crossProviderFallbackSeen
        ? "VERIFIED"
        : [...runtimes].filter(([name, r]) => r.configured && name !== "scripted").length >= 2
          ? "READY"
          : "LOGIC_ONLY",
      critic: this.criticRunSeen ? "VERIFIED" : "READY_SELECTIVE"
    };
  }

  private async recordCost(
    input: CompleteInput,
    result: ModelResult,
    costOre: number,
    flags: {
      success: boolean;
      fallback: boolean;
      critic: boolean;
      latency_ms: number;
      /** BO-11.1 §4: kun satt for streaming-executions (migrasjon 016). */
      stream?: boolean;
      ttft_ms?: number;
      tool_calls?: number;
    }
  ): Promise<void> {
    await withTenantTransaction(this.opts.pool, input.tenant_id, (client) =>
      client.query(
        `INSERT INTO cost_events (tenant_id, task_id, session_id, kind, amount_ore, provider, model,
                                  input_tokens, output_tokens, purpose, success, fallback, critic, latency_ms,
                                  ttft_ms, stream, tool_calls)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          input.tenant_id,
          input.task_id ?? null,
          input.session_id ?? null,
          `model:${result.provider}`,
          costOre,
          result.provider,
          result.model,
          result.usage.input_tokens,
          result.usage.output_tokens,
          input.purpose ?? null,
          flags.success,
          flags.fallback,
          flags.critic,
          flags.latency_ms,
          flags.ttft_ms ?? null,
          flags.stream ?? false,
          flags.tool_calls ?? 0
        ]
      )
    );
  }

  /** Bakoverkompatibilitet: eksplisitt rates-opsjon (eldre tester/konfig) vinner over pricing-tabellen. */
  private legacyCostOverride(result: ModelResult): number | undefined {
    const rate = this.opts.rates?.[result.provider];
    if (!rate) {
      return undefined;
    }
    return Math.ceil(
      (result.usage.input_tokens / 1000) * rate.input_per_1k_ore +
        (result.usage.output_tokens / 1000) * rate.output_per_1k_ore
    );
  }

  private async recordFailedAttempt(
    input: CompleteInput,
    provider: string,
    err: ProviderError,
    critic: boolean
  ): Promise<void> {
    try {
      await withTenantTransaction(this.opts.pool, input.tenant_id, (client) =>
        client.query(
          `INSERT INTO cost_events (tenant_id, task_id, session_id, kind, amount_ore, provider, model,
                                    input_tokens, output_tokens, purpose, success, fallback, critic, latency_ms)
           VALUES ($1, $2, $3, $4, 0, $5, $6, 0, 0, $7, false, false, $8, NULL)`,
          [
            input.tenant_id,
            input.task_id ?? null,
            input.session_id ?? null,
            `model:failed:${err.kind}`,
            provider,
            "(failed)",
            input.purpose ?? null,
            critic
          ]
        )
      );
    } catch {
      // Kostlogging av feilforsøk skal aldri stoppe fallback-kjeden.
    }
  }

  private enforceRateLimit(tenantId: string): void {
    const limit = this.opts.maxCallsPerMinute ?? 60;
    const now = Date.now();
    const stamps = (this.callTimestamps.get(tenantId) ?? []).filter((t) => now - t < 60_000);
    if (stamps.length >= limit) {
      throw new Error("rate_limited: for mange modellkall per minutt");
    }
    stamps.push(now);
    this.callTimestamps.set(tenantId, stamps);
  }
}

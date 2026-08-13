import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import type { ModelPurpose, RouterMode } from "@jarvis/contracts";
import {
  ProviderError,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult
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
  fallback: "READY";
  critic: "READY_SELECTIVE";
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

  /** Deterministisk fallback (§12): klassifiserte feil, aldri blind retry-spam. */
  private async executePlan(
    input: CompleteInput,
    plan: RoutePlan,
    traceId: string,
    started: number,
    budgetLevel: string,
    isCritic: boolean,
    requestOverride?: ModelRequest
  ): Promise<ModelResult> {
    const request = requestOverride ?? input.request;
    const failedProviders: string[] = [];
    let lastError: Error | null = null;

    for (const candidate of plan.candidates) {
      const adapter = this.byName.get(candidate.provider);
      if (!adapter || !adapter.available()) {
        continue;
      }
      const maxTries = 2; // 1 + maks én retry for transient/invalid_response på samme provider
      for (let attempt = 1; attempt <= maxTries; attempt++) {
        const attemptStart = Date.now();
        try {
          const result = await adapter.complete(request, isCritic ? undefined : input.onToken);
          const latency = result.latency_ms ?? Date.now() - attemptStart;
          this.health.recordSuccess(adapter.name, latency);
          const cost =
            this.legacyCostOverride(result) ??
            computeCostOre(this.pricing, result.provider, result.model, result.usage);
          await this.recordCost(input, result, cost, {
            success: true,
            fallback: failedProviders.length > 0,
            critic: isCritic,
            latency_ms: latency
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
          this.health.recordFailure(adapter.name, pe.kind, pe.message);
          await this.recordFailedAttempt(input, adapter.name, pe, isCritic);
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

  /** Critic (§18-§19): separat modellkjøring, egen kostrad, aldri koblet til D-godkjenning. */
  private async runCritic(input: CompleteInput, primary: ModelResult, traceId: string): Promise<void> {
    try {
      const runtimes = this.providerRuntimes();
      // Foretrekk annen provider enn primær for uavhengig blikk; ellers samme.
      const others = new Map([...runtimes].filter(([name, rt]) => rt.configured && name !== primary.provider));
      const pool = others.size > 0 ? others : runtimes;
      const criticPlan = this.router.plan({ mode: "QUALITY", purpose: "CRITIQUE" }, pool);
      const lastUser = [...input.request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
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
      fallback: "READY",
      critic: "READY_SELECTIVE"
    };
  }

  private async recordCost(
    input: CompleteInput,
    result: ModelResult,
    costOre: number,
    flags: { success: boolean; fallback: boolean; critic: boolean; latency_ms: number }
  ): Promise<void> {
    await withTenantTransaction(this.opts.pool, input.tenant_id, (client) =>
      client.query(
        `INSERT INTO cost_events (tenant_id, task_id, session_id, kind, amount_ore, provider, model,
                                  input_tokens, output_tokens, purpose, success, fallback, critic, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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
          flags.latency_ms
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

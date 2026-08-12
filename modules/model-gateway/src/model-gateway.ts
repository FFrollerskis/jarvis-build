import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import type { ModelProviderAdapter, ModelRequest, ModelResult } from "@jarvis/provider-adapters";
import { BudgetGuard, type BudgetConfig, DEFAULT_BUDGET } from "./budget-guard.ts";
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
}

export interface GatewayOptions {
  pool: pg.Pool;
  /** Prioritert rekkefølge; første tilgjengelige forsøkes, feil gir fallback til neste. */
  providers: ModelProviderAdapter[];
  trace: TraceSink;
  budget?: BudgetConfig;
  /** Øre per 1000 tokens (inn/ut) per provider - kontrolleres mot reelle priser ved bruk. */
  rates?: Record<string, { input_per_1k_ore: number; output_per_1k_ore: number }>;
  /** Enkel rate limit: maks kall per minutt per tenant. */
  maxCallsPerMinute?: number;
}

const DEFAULT_RATES = { input_per_1k_ore: 30, output_per_1k_ore: 150 };

/**
 * Model Gateway (CANONICAL_SPEC §7): eneste vei til modell-leverandører.
 * Budsjett håndheves FØR kallet; kostnad skrives til cost_events knyttet til
 * session_id/task_id ETTER kallet; alt spores i trace-sinken.
 */
export class ModelGateway {
  private readonly guard: BudgetGuard;
  private readonly callTimestamps = new Map<string, number[]>();

  constructor(private readonly opts: GatewayOptions) {
    this.guard = new BudgetGuard(opts.pool, opts.budget ?? DEFAULT_BUDGET);
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

    let lastError: Error | null = null;
    for (const provider of this.opts.providers) {
      if (!provider.available()) {
        continue;
      }
      try {
        const result = await provider.complete(input.request, input.onToken);
        const costOre = this.costOre(provider.name, result);
        await this.recordCost(input, provider.name, costOre);
        await this.opts.trace.record({
          trace_id: traceId,
          kind: "model_call",
          name: `${provider.name}:${result.model}`,
          tenant_id: input.tenant_id,
          ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
          ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
          at: new Date().toISOString(),
          duration_ms: Date.now() - started,
          cost_ore: costOre,
          metadata: { usage: result.usage, budget_level: budget.level }
        });
        return result;
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw lastError ?? new Error("no_provider_available");
  }

  private costOre(provider: string, result: ModelResult): number {
    const rate = this.opts.rates?.[provider] ?? DEFAULT_RATES;
    return Math.ceil(
      (result.usage.input_tokens / 1000) * rate.input_per_1k_ore +
        (result.usage.output_tokens / 1000) * rate.output_per_1k_ore
    );
  }

  private async recordCost(input: CompleteInput, provider: string, costOre: number): Promise<void> {
    await withTenantTransaction(this.opts.pool, input.tenant_id, (client) =>
      client.query(
        `INSERT INTO cost_events (tenant_id, task_id, session_id, kind, amount_ore)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.tenant_id, input.task_id ?? null, input.session_id ?? null, `model:${provider}`, costOre]
      )
    );
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

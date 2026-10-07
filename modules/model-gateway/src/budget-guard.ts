import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import { envInt } from "@jarvis/contracts";

/**
 * Håndhevede kostnadsgrenser (CANONICAL_SPEC §7, masterplan §7.2) - i kode,
 * ikke dashboard. Startgrenser: varsel 1 000 kr, aktiv godkjenning 2 000 kr,
 * hardgrense 3 000 kr per måned. Beløp i øre. Revideres etter 30 dager.
 */
export interface BudgetConfig {
  warn_ore: number;
  approval_ore: number;
  hard_limit_ore: number;
  /** Eksplisitt godkjenning fra Tobias for å fortsette over approval-grensen. */
  spend_approved: boolean;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  warn_ore: 100_000,
  approval_ore: 200_000,
  hard_limit_ore: 300_000,
  spend_approved: false
};

/**
 * D-395 (JARVIS-039): ÉN kilde til budsjettgrensene for api OG worker. Tidligere hadde api grensene hardkodet (og `JARVIS_BUDGET_APPROVED` lest kun der),
 * mens workeren brukte `DEFAULT_BUDGET` med `spend_approved=false` - så en godkjenning eieren ga gjaldt ikke workeren, og watchdogens hardgrense
 * (`JARVIS_COST_HARD_LIMIT_ORE`) var en ANNEN verdi enn guardens - en høyere grense slapp aldri gjennom begge. Nå leses alle fra miljøet:
 * `JARVIS_COST_WARN_ORE` (100 000), `JARVIS_COST_APPROVAL_ORE` (200 000), `JARVIS_COST_HARD_LIMIT_ORE` (300 000), `JARVIS_BUDGET_APPROVED` (false).
 * Rekkefølgen varsel <= godkjenning <= hardgrense håndheves ved oppstart (ugyldig = feil, aldri en stille rar grense).
 */
export function budgetConfigFromEnv(env: Record<string, string | undefined> = process.env): BudgetConfig {
  const bounds = { min: 1, max: 100_000_000 };
  const warn_ore = envInt("JARVIS_COST_WARN_ORE", DEFAULT_BUDGET.warn_ore, bounds, env);
  const approval_ore = envInt("JARVIS_COST_APPROVAL_ORE", DEFAULT_BUDGET.approval_ore, bounds, env);
  const hard_limit_ore = envInt("JARVIS_COST_HARD_LIMIT_ORE", DEFAULT_BUDGET.hard_limit_ore, bounds, env);
  if (!(warn_ore <= approval_ore && approval_ore <= hard_limit_ore)) {
    throw new Error(`ugyldig budsjett: krever JARVIS_COST_WARN_ORE (${warn_ore}) <= JARVIS_COST_APPROVAL_ORE (${approval_ore}) <= JARVIS_COST_HARD_LIMIT_ORE (${hard_limit_ore})`);
  }
  return { warn_ore, approval_ore, hard_limit_ore, spend_approved: env["JARVIS_BUDGET_APPROVED"]?.trim().toLowerCase() === "true" };
}

export type BudgetLevel = "ok" | "warn" | "needs_approval" | "hard_blocked";

/**
 * D-432: samlet modellkostnad (øre) for tenanten i inneværende døgn (norsk tid, Europe/Oslo). Brukes til dagstaket for verktøyturer til sky
 * (`JARVIS_TOOL_TURN_DAILY_CAP_ORE`). Teller ALLE rader i `cost_events` i dag; lokal og gratis kjøring bokføres med 0 øre.
 */
export async function dailySpentOre(pool: pg.Pool, tenantId: string): Promise<number> {
  const result = await withTenantTransaction(pool, tenantId, (client) =>
    client.query(
      `SELECT coalesce(sum(amount_ore), 0)::int AS spent FROM cost_events
       WHERE at >= (date_trunc('day', now() AT TIME ZONE 'Europe/Oslo') AT TIME ZONE 'Europe/Oslo')`
    )
  );
  return (result.rows[0] as { spent: number }).spent;
}

export class BudgetGuard {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: BudgetConfig = DEFAULT_BUDGET
  ) {}

  /** Sum av alle kostnader (API + sky) for tenanten i inneværende måned. */
  async monthlySpentOre(tenantId: string): Promise<number> {
    const result = await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `SELECT coalesce(sum(amount_ore), 0)::int AS spent FROM cost_events
         WHERE at >= date_trunc('month', now())`
      )
    );
    return (result.rows[0] as { spent: number }).spent;
  }

  async evaluate(tenantId: string): Promise<{ level: BudgetLevel; spent_ore: number }> {
    const spent = await this.monthlySpentOre(tenantId);
    if (spent >= this.config.hard_limit_ore) {
      return { level: "hard_blocked", spent_ore: spent };
    }
    if (spent >= this.config.approval_ore && !this.config.spend_approved) {
      return { level: "needs_approval", spent_ore: spent };
    }
    if (spent >= this.config.warn_ore) {
      return { level: "warn", spent_ore: spent };
    }
    return { level: "ok", spent_ore: spent };
  }
}

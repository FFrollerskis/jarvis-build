import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";

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

export type BudgetLevel = "ok" | "warn" | "needs_approval" | "hard_blocked";

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

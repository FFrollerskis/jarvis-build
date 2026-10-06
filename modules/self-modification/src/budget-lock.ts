import type { BudgetCaps, Constitution } from "./constitution.ts";
import type { LedgerDecision } from "./change-ledger.ts";

/**
 * EV-0 (D-409): budsjettlåser. Grensene kommer fra den SIGNERTE konstitusjonen (`constitution.budget`) - Evolution kan aldri heve dem.
 * Forbruk telles fra det append-only endringsregisteret (D-408), så en låst grense ikke kan «nullstilles» ved å slette rader.
 *
 * Fail-closed: kan forbruket ikke leses (databasefeil) er svaret «ikke tillatt». Dager er UTC-døgn, måneder er UTC-kalendermåneder.
 */

export type BudgetKind = "auto_merge" | "deploy" | "owner_proposal" | "spend";

export type BudgetVerdict =
  | { allowed: true; kind: BudgetKind; used: number; limit: number; remaining: number }
  | { allowed: false; kind: BudgetKind; reason: "budget_exhausted" | "budget_check_failed"; used: number; limit: number };

/** Det budsjettlåsen trenger av registeret (strukturelt - `ChangeLedger` oppfyller det). */
export interface LedgerCounter {
  countSince(sinceIso: string, decisions: readonly LedgerDecision[], classes: readonly string[]): Promise<number>;
}

export function startOfUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export class BudgetLock {
  constructor(
    private readonly caps: Readonly<BudgetCaps>,
    private readonly ledger: LedgerCounter,
    private readonly clock: () => Date = () => new Date()
  ) {}

  static fromConstitution(constitution: Pick<Constitution, "budget">, ledger: LedgerCounter, clock?: () => Date): BudgetLock {
    return new BudgetLock(constitution.budget, ledger, clock);
  }

  private async verdict(kind: BudgetKind, limit: number, count: () => Promise<number>): Promise<BudgetVerdict> {
    let used: number;
    try {
      used = await count();
    } catch {
      return { allowed: false, kind, reason: "budget_check_failed", used: 0, limit };
    }
    return used >= limit
      ? { allowed: false, kind, reason: "budget_exhausted", used, limit }
      : { allowed: true, kind, used, limit, remaining: limit - used };
  }

  /** Kan Evolution gjøre en ny AUTOMATISK (E0/E1) merge nå? Eier-godkjente E2-merger teller ikke her. */
  checkAutoMerge(): Promise<BudgetVerdict> {
    const since = startOfUtcDay(this.clock());
    return this.verdict("auto_merge", this.caps.max_auto_merges_per_day, () => this.ledger.countSince(since, ["merged"], ["E0", "E1"]));
  }

  checkDeploy(): Promise<BudgetVerdict> {
    const since = startOfUtcDay(this.clock());
    return this.verdict("deploy", this.caps.max_deploys_per_day, () => this.ledger.countSince(since, ["deployed"], ["E0", "E1", "E2"]));
  }

  /** Kan det sendes et nytt E2-forslag til eieren i dag? (Eierens tid er et budsjett.) */
  checkOwnerProposal(): Promise<BudgetVerdict> {
    const since = startOfUtcDay(this.clock());
    return this.verdict("owner_proposal", this.caps.max_owner_proposals_per_day, () => this.ledger.countSince(since, ["proposed"], ["E2"]));
  }

  /**
   * Kan Evolution bruke `requestedOre` til? `spentOreThisMonth` MÅ komme fra målt kost (cost_events), aldri fra Evolution selv.
   * Ugyldige tall (negative, NaN) avvises som `budget_check_failed`.
   */
  checkSpend(spentOreThisMonth: number, requestedOre: number): BudgetVerdict {
    const limit = this.caps.max_evolution_cost_ore_per_month;
    if (![spentOreThisMonth, requestedOre].every((n) => Number.isFinite(n) && n >= 0)) {
      return { allowed: false, kind: "spend", reason: "budget_check_failed", used: 0, limit };
    }
    const after = spentOreThisMonth + requestedOre;
    return after > limit
      ? { allowed: false, kind: "spend", reason: "budget_exhausted", used: spentOreThisMonth, limit }
      : { allowed: true, kind: "spend", used: spentOreThisMonth, limit, remaining: limit - after };
  }
}

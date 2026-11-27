import { CATEGORY_CAP_KEYS, EVOLUTION_COST_CATEGORIES, type BudgetCaps, type Constitution, type EvolutionCostCategory } from "./constitution.ts";
import type { LedgerDecision } from "./change-ledger.ts";

/**
 * EV-0 (D-409, utvidet i WP-EV0): budsjettlåser. Grensene kommer fra den SIGNERTE konstitusjonen (`constitution.budget`) - Evolution kan aldri heve dem.
 * Forbruk telles fra append-only registre (endringsregisteret D-408 for merger/deploys/forslag). Kostnad pr. kategori og eierens tid leses via `UsageCounter`: den
 * KONKRETE, varige implementasjonen (forbruksregister i databasen) er DEFERRED til WP-EV0b (krever klasse-sti i MC8a-linten, `search_path`-herding og at `at` settes
 * av databasen); til da finnes ingen kilde, og kategori-/eier-tid-sjekkene gir «ikke tillatt» uten `usage` (fail-closed).
 *
 * FAIL-CLOSED (WP-EV0): alt som ikke kan måles trygt er «ikke tillatt» (`budget_check_failed`): databasefeil, ugyldig klokke, manglende forbruksregister, ugyldige tak
 * (negative/NaN/brøk) og ugyldige tellerverdier (NaN, negative, brøk, uendelig, ikke-tall). Aldri en stille «ubegrenset». Dager er UTC-døgn, timer er hele UTC-timer,
 * uker er ISO-uker (mandag 00:00 UTC) og måneder er UTC-kalendermåneder.
 */

/** Hva forbruksteller måler: `spend` = kostnad i ØRE pr. kategori, `owner_time` = eierens tid i MINUTTER. */
export type UsageKind = "spend" | "owner_time";

/**
 * Det budsjettlåsen trenger av et forbrukskilde (strukturelt, som `LedgerCounter`). Kontrakt: summene er HELE, ikke-negative tall; en kilde som ikke kan måle trygt skal KASTE
 * (ikke returnere 0). Den varige implementasjonen er DEFERRED (WP-EV0b); testene bruker fiktive tellere.
 */
export interface UsageCounter {
  /** Sum av beløpet (øre for `spend`, minutter for `owner_time`) siden `sinceIso`; `categories: null` = alle kategorier. */
  sumSince(kind: UsageKind, categories: readonly string[] | null, sinceIso: string): Promise<number>;
  /** Sum av beløpet for én endring (eier-minutter pr. autonom endring). */
  sumForChange(kind: UsageKind, changeId: string): Promise<number>;
}

export type BudgetKind = "auto_merge" | "deploy" | "deploy_hour" | "owner_proposal" | "spend" | "category_spend" | "owner_time";

/** `scope` sier hvilken grense som ble målt/stoppet (f.eks. `category:radar`, `total`, `week`, `change`). */
export type BudgetVerdict =
  | { allowed: true; kind: BudgetKind; used: number; limit: number; remaining: number; scope?: string }
  | { allowed: false; kind: BudgetKind; reason: "budget_exhausted" | "budget_check_failed"; used: number; limit: number; scope?: string };

/** Det budsjettlåsen trenger av endringsregisteret (strukturelt - `ChangeLedger` oppfyller det). */
export interface LedgerCounter {
  countSince(sinceIso: string, decisions: readonly LedgerDecision[], classes: readonly string[]): Promise<number>;
}

export function startOfUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export function startOfUtcHour(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours())).toISOString();
}

export function startOfUtcMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Mandag 00:00 UTC i uken `now` ligger i (ISO-uke). */
export function startOfUtcIsoWeek(now: Date): string {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday)).toISOString();
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
const isLimit = isCount;
/** Beløp/minutter som skal brukes: ikke-negativt heltall (øre og minutter er udelelige). */
const isAmount = isCount;

const DEPLOY_CLASSES = ["E0", "E1", "E2"] as const;

export class BudgetLock {
  constructor(
    private readonly caps: Readonly<BudgetCaps>,
    private readonly ledger: LedgerCounter,
    private readonly clock: () => Date = () => new Date(),
    private readonly usage?: UsageCounter
  ) {}

  static fromConstitution(constitution: Pick<Constitution, "budget">, ledger: LedgerCounter, clock?: () => Date, usage?: UsageCounter): BudgetLock {
    return new BudgetLock(constitution.budget, ledger, clock, usage);
  }

  private fail(kind: BudgetKind, limit: number, scope?: string): BudgetVerdict {
    return { allowed: false, kind, reason: "budget_check_failed", used: 0, limit: Number.isFinite(limit) ? limit : 0, ...(scope !== undefined ? { scope } : {}) };
  }

  /** Er det plass til én til i dette vinduet? Teller rader i endringsregisteret siden vindusstart. */
  private async countVerdict(
    kind: BudgetKind, limit: number, since: () => string, decisions: readonly LedgerDecision[], classes: readonly string[]
  ): Promise<BudgetVerdict> {
    if (!isLimit(limit)) return this.fail(kind, limit);
    let used: unknown;
    try {
      used = await this.ledger.countSince(since(), decisions, classes);
    } catch {
      return this.fail(kind, limit);
    }
    if (!isCount(used)) return this.fail(kind, limit);
    return used >= limit
      ? { allowed: false, kind, reason: "budget_exhausted", used, limit }
      : { allowed: true, kind, used, limit, remaining: limit - used };
  }

  /** Kan Evolution gjøre en ny AUTOMATISK (E0/E1) merge nå? Eier-godkjente E2-merger teller ikke her. */
  checkAutoMerge(): Promise<BudgetVerdict> {
    return this.countVerdict("auto_merge", this.caps.max_auto_merges_per_day, () => startOfUtcDay(this.clock()), ["merged"], ["E0", "E1"]);
  }

  /** Deploys pr. hel UTC-time (HF2 kap. 15: deploybudsjett pr. time OG døgn). */
  checkDeployHour(): Promise<BudgetVerdict> {
    return this.countVerdict("deploy_hour", this.caps.max_deploys_per_hour, () => startOfUtcHour(this.clock()), ["deployed"], DEPLOY_CLASSES);
  }

  /** Deploys: BEGGE vinduer må ha rom - døgnet først (`kind: deploy`), så timen (`kind: deploy_hour`). Allowed gir det minste gjenstående. */
  async checkDeploy(): Promise<BudgetVerdict> {
    const day = await this.countVerdict("deploy", this.caps.max_deploys_per_day, () => startOfUtcDay(this.clock()), ["deployed"], DEPLOY_CLASSES);
    if (!day.allowed) return day;
    const hour = await this.checkDeployHour();
    if (!hour.allowed) return hour;
    return { ...day, remaining: Math.min(day.remaining, hour.remaining) };
  }

  /** Kan det sendes et nytt E2-forslag til eieren i dag? (Eierens tid er et budsjett.) */
  checkOwnerProposal(): Promise<BudgetVerdict> {
    return this.countVerdict("owner_proposal", this.caps.max_owner_proposals_per_day, () => startOfUtcDay(this.clock()), ["proposed"], ["E2"]);
  }

  /**
   * Kan Evolution bruke `requestedOre` til? `spentOreThisMonth` MÅ komme fra målt kost (cost_events), aldri fra Evolution selv.
   * Ugyldige tall (negative, NaN) avvises som `budget_check_failed`. Kun TOTALEN; bruk `checkCategorySpend` for kategori-takene.
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

  /**
   * WP-EV0: kan `category` bruke `requestedOre` til denne kalendermåneden? Både kategoritaket OG totaltaket (summen av ALLE kategorier) må ha rom; kategori sjekkes
   * først. Forbruket leses fra forbruksregisteret (`usage`) - uten det kan ingenting sjekkes (avvist).
   */
  async checkCategorySpend(category: EvolutionCostCategory, requestedOre: number): Promise<BudgetVerdict> {
    const totalLimit = this.caps.max_evolution_cost_ore_per_month;
    const scope = `category:${String(category)}`;
    if (!(EVOLUTION_COST_CATEGORIES as readonly string[]).includes(category) || !isAmount(requestedOre) || this.usage === undefined) return this.fail("category_spend", totalLimit, scope);
    const catLimit = this.caps[CATEGORY_CAP_KEYS[category]];
    if (!isLimit(catLimit) || !isLimit(totalLimit)) return this.fail("category_spend", totalLimit, scope);
    let usedCat: unknown;
    let usedTotal: unknown;
    try {
      const since = startOfUtcMonth(this.clock());
      usedCat = await this.usage.sumSince("spend", [category], since);
      usedTotal = await this.usage.sumSince("spend", null, since);
    } catch {
      return this.fail("category_spend", totalLimit, scope);
    }
    // Totalen kan aldri være mindre enn én kategori: et register som sier det er ødelagt - aldri «tillatt».
    if (!isCount(usedCat) || !isCount(usedTotal) || usedCat > usedTotal) return this.fail("category_spend", totalLimit, scope);
    if (usedCat + requestedOre > catLimit) return { allowed: false, kind: "category_spend", reason: "budget_exhausted", used: usedCat, limit: catLimit, scope };
    if (usedTotal + requestedOre > totalLimit) return { allowed: false, kind: "category_spend", reason: "budget_exhausted", used: usedTotal, limit: totalLimit, scope: "total" };
    const catRemaining = catLimit - usedCat - requestedOre;
    const totalRemaining = totalLimit - usedTotal - requestedOre;
    return catRemaining <= totalRemaining
      ? { allowed: true, kind: "category_spend", used: usedCat, limit: catLimit, remaining: catRemaining, scope }
      : { allowed: true, kind: "category_spend", used: usedTotal, limit: totalLimit, remaining: totalRemaining, scope: "total" };
  }

  /**
   * WP-EV0: kan `requestedMinutes` av eierens tid brukes? Uke-budsjettet (ISO-uke) sjekkes alltid; med `changeId` også taket pr. autonom endring (summert over
   * endringens levetid). Uken sjekkes først. Forbruket leses fra forbruksregisteret (`usage`).
   */
  async checkOwnerTime(requestedMinutes: number, changeId?: string): Promise<BudgetVerdict> {
    const weekLimit = this.caps.owner_time_budget_minutes_per_week;
    const changeLimit = this.caps.max_owner_minutes_per_autonomous_change;
    if (!isAmount(requestedMinutes) || !isLimit(weekLimit) || !isLimit(changeLimit) || this.usage === undefined) return this.fail("owner_time", weekLimit, "week");
    if (changeId !== undefined && (typeof changeId !== "string" || changeId.trim() === "")) return this.fail("owner_time", weekLimit, "week");
    let usedWeek: unknown;
    let usedChange: unknown = null;
    try {
      usedWeek = await this.usage.sumSince("owner_time", null, startOfUtcIsoWeek(this.clock()));
      if (changeId !== undefined) usedChange = await this.usage.sumForChange("owner_time", changeId);
    } catch {
      return this.fail("owner_time", weekLimit, "week");
    }
    if (!isCount(usedWeek) || (changeId !== undefined && !isCount(usedChange))) return this.fail("owner_time", weekLimit, "week");
    if (usedWeek + requestedMinutes > weekLimit) return { allowed: false, kind: "owner_time", reason: "budget_exhausted", used: usedWeek, limit: weekLimit, scope: "week" };
    const weekRemaining = weekLimit - usedWeek - requestedMinutes;
    if (changeId === undefined) return { allowed: true, kind: "owner_time", used: usedWeek, limit: weekLimit, remaining: weekRemaining, scope: "week" };
    const usedForChange = usedChange as number;
    if (usedForChange + requestedMinutes > changeLimit) return { allowed: false, kind: "owner_time", reason: "budget_exhausted", used: usedForChange, limit: changeLimit, scope: "change" };
    const changeRemaining = changeLimit - usedForChange - requestedMinutes;
    return changeRemaining <= weekRemaining
      ? { allowed: true, kind: "owner_time", used: usedForChange, limit: changeLimit, remaining: changeRemaining, scope: "change" }
      : { allowed: true, kind: "owner_time", used: usedWeek, limit: weekLimit, remaining: weekRemaining, scope: "week" };
  }
}

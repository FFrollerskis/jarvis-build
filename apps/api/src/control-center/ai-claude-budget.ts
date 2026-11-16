// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import { controlItem, type ControlItem, type ControlStatus } from "@jarvis/executive";
import {
  TIER_LABEL_NO, BUDGET_TIERS, budgetWindow, describeStateNo, formatDateNo, formatUsdNo, readClaudeBudgetState,
  type ClaudeBudgetConfig, type PacingLevel
} from "@jarvis/model-gateway";
import { readClaudeDecisionCounts, readClaudeUsage } from "../claude-budget-surfaces.ts";
import { settle, type ControlCenterPool } from "./shared.ts";

/**
 * WP-B4 (D-476): «Kost»-seksjonen i AI-senteret får tre elementer for Claude-kreditten - KUN når `JARVIS_CLAUDE_BUDGET_USD` er satt, og KUN for lokal modell og selve siden. En skymodell får dem aldri
 * (`ControlCenterBuildContext.restrictFinance`, H2-mekanismen): AI-kostnad i øre er finansdata etter strengeste regel inntil Q-64 er besvart, og de nye tallene skal ikke utvide det AI-senteret allerede viser en skymodell (PARTIAL,
 * uendret fra main). Utelatelsen skjer FØR elementene bygges (ingen «ukjent»-plassholder som røper at noe er holdt tilbake).
 *
 *  1. `claude_budget`           - kreditten: brukt (USD og kr), nivå, kurve, dagsrom, prognose, hva som skjer på dette nivået
 *  2. `claude_budget_use`       - forbruk siste 7/30 døgn per tier og formål (tier er utledet - se `readClaudeUsage`)
 *  3. `claude_budget_decisions` - antall nedgraderte/utsatte/avviste kall (revisjonsradene `claude_budget.decision`)
 *
 * En kilde som ikke kan leses gir UKJENT for det elementet, aldri «i orden».
 */

const POLICY_NO: Readonly<Record<PacingLevel, (config: ClaudeBudgetConfig, endMs: number) => string>> = {
  on_pace: () => "Alt er tillatt på Claude.",
  ahead: () => "Bakgrunnsarbeid går på en billigere Claude-modell; dine egne turer og bestilte jobber er uendret.",
  tight: () => "Kun dine egne turer og bestilte jobber bruker Claude; bakgrunnsarbeid går lokalt eller utsettes.",
  exhausted: (config, endMs) => (config.hard_stop
    ? `HARD STOPP: Anthropic er stengt til kreditten fornyes ${formatDateNo(endMs)}; alt går til lokal modell (eller et tydelig svar når ingen lokal modell kan svare).`
    : "Hardstoppen er AV: dine egne turer og bestilte jobber fortsetter på Claude (kun varsling), bakgrunnsarbeid går lokalt.")
};

const usd = (ore: number, config: ClaudeBudgetConfig): string => `${formatUsdNo(ore, config.nok_per_usd)} USD`;

/**
 * `controlItem` kutter detaljteksten ved 400 tegn (og beholder kun de første 24 faktaene). Listeelementer legges derfor til kun så lenge HELE teksten, inkludert den faste avslutningen med forbeholdet, ryker innenfor -
 * forbeholdet («anslag, ikke Anthropics faktura») skal aldri være det som kuttes bort.
 */
const MAX_DETAIL_CHARS = 400;
export function fitDetail(head: string, entries: readonly string[], tail: string): string {
  let kept: string[] = [];
  for (const entry of entries) {
    const next = [...kept, entry];
    if ((head + next.join(", ") + tail).length > MAX_DETAIL_CHARS) break;
    kept = next;
  }
  return head + kept.join(", ") + tail;
}

function unknownItem(id: string, label: string, category: string): ControlItem {
  return controlItem({ id, label, status: "UNKNOWN", detail_no: `Kunne ikke måles (${category}).` });
}

export async function claudeBudgetItems(args: { pool: ControlCenterPool; config: ClaudeBudgetConfig; tenantId: string; nowMs: number }): Promise<ControlItem[]> {
  const { config, tenantId, nowMs } = args;
  const pool = args.pool as pg.Pool;
  const label = `Claude-kreditten (${config.budget_usd.toFixed(0)} USD per periode, fornyes den ${config.reset_day}.)`;
  const [statusR, usageR] = await Promise.all([
    settle(() => readClaudeBudgetState(pool, tenantId, config, nowMs)),
    settle(() => readClaudeUsage(pool, tenantId, config, nowMs))
  ]);
  const window = statusR.ok ? statusR.value.window : budgetWindow(nowMs, config.reset_day);
  const decisionsR = await settle(() => readClaudeDecisionCounts(pool, tenantId, window.start_ms, window.end_ms, nowMs));
  const items: ControlItem[] = [];

  // --- 1. kreditten
  if (statusR.ok) {
    const { state } = statusR.value;
    const status: ControlStatus = state.level === "on_pace" ? "OK" : state.level === "exhausted" && config.hard_stop ? "FAIL" : "WARN";
    // Faktaene står i prioritert rekkefølge (maks 24 beholdes): utledbare tall (`remaining_ore`, `room_to_curve_ore`) og nivåets norske navn utelates; kursen og forbeholdet står i `basis_no`.
    items.push(controlItem({
      id: "claude_budget", label, status,
      detail_no: `${describeStateNo(state, config)} ${POLICY_NO[state.level](config, state.window.end_ms)}`,
      facts: {
        level: state.level, hard_stop: config.hard_stop, reset_day: config.reset_day, period_start: state.window.start_date, period_end: state.window.end_date,
        day_of_period: state.window.day_of_window, days_in_period: state.window.days_total, days_left: Math.round(state.window.days_left * 100) / 100,
        budget_usd: config.budget_usd, budget_ore: state.budget_ore, spent_ore: state.spent_ore, spent_usd: Math.round((state.spent_ore / (config.nok_per_usd * 100)) * 100) / 100,
        spent_kr: Math.round(state.spent_ore / 100), spent_pct: Math.round(state.spent_pct * 100) / 100, curve_ore: state.curve_ore,
        pace_ratio: state.pace_ratio === null ? null : Math.round(state.pace_ratio * 100) / 100, pacing_budget_ore: state.pacing_budget_ore, reserve_ore: state.reserve_ore, in_reserve: state.in_reserve,
        daily_room_ore: state.daily_room_ore, forecast_end_ore: state.forecast_end_ore, forecast_pct: state.forecast_pct === null ? null : Math.round(state.forecast_pct * 10) / 10,
        basis_no: `Kurs ca. ${config.nok_per_usd.toFixed(1).replace(".", ",")} kr per USD (prislisten, ikke sanntid). Forbruket er et anslag fra tokenregnskapet (cost_events), ikke Anthropics faktura. Kurven er tillatt forbruk til nå; reserven er forbeholdt essensielle behov.`
      }
    }));
  } else {
    items.push(unknownItem("claude_budget", label, statusR.category));
  }

  // --- 2. forbruk per tier og formål
  if (usageR.ok) {
    const rows = usageR.value;
    if (rows.length === 0) {
      items.push(controlItem({ id: "claude_budget_use", label: "Claude-forbruk siste 7 og 30 døgn", status: "OK", detail_no: "Ingen Claude-kall siste 30 døgn.", facts: { ore_7d: 0, ore_30d: 0 } }));
    } else {
      const sum = (pick: (r: (typeof rows)[number]) => number, tier?: string): number => rows.filter((r) => tier === undefined || r.tier === tier).reduce((a, r) => a + pick(r), 0);
      const tierText = BUDGET_TIERS.map((tier) => `${TIER_LABEL_NO[tier]} ${usd(sum((r) => r.ore_7d, tier), config)} / ${usd(sum((r) => r.ore_30d, tier), config)}`).join(" · ");
      const byPurpose = new Map<string, { ore_7d: number; ore_30d: number }>();
      for (const r of rows) {
        const prev = byPurpose.get(r.purpose) ?? { ore_7d: 0, ore_30d: 0 };
        byPurpose.set(r.purpose, { ore_7d: prev.ore_7d + r.ore_7d, ore_30d: prev.ore_30d + r.ore_30d });
      }
      const topPurposes = [...byPurpose].sort((a, b) => b[1].ore_30d - a[1].ore_30d).slice(0, 6);
      const facts: Record<string, string | number | boolean | null> = { ore_7d: sum((r) => r.ore_7d), ore_30d: sum((r) => r.ore_30d), calls_7d: sum((r) => r.calls_7d), calls_30d: sum((r) => r.calls_30d) };
      for (const tier of BUDGET_TIERS) {
        facts[`tier_${tier}_ore_7d`] = sum((r) => r.ore_7d, tier);
        facts[`tier_${tier}_ore_30d`] = sum((r) => r.ore_30d, tier);
      }
      for (const [purpose, v] of topPurposes) { facts[`purpose_${purpose}_ore_7d`] = v.ore_7d; facts[`purpose_${purpose}_ore_30d`] = v.ore_30d; }
      items.push(controlItem({
        id: "claude_budget_use", label: "Claude-forbruk siste 7 og 30 døgn", status: "OK",
        detail_no: fitDetail(`Siste 7 d / 30 d per tier: ${tierText}. Per formål (30 d): `, topPurposes.map(([p, v]) => `${p} ${usd(v.ore_30d, config)}`), ". Anslag fra tokenregnskapet (ikke Anthropics faktura); tier er utledet fra formål og jobb-id."),
        facts
      }));
    }
  } else {
    items.push(unknownItem("claude_budget_use", "Claude-forbruk siste 7 og 30 døgn", usageR.category));
  }

  // --- 3. beslutninger som gjorde noe
  if (decisionsR.ok) {
    const c = decisionsR.value;
    const line = (key: "downgrade" | "defer" | "deny", which: "period" | "d7"): number => c.by_decision[key][which];
    items.push(controlItem({
      id: "claude_budget_decisions", label: "Kall styrt bort fra Claude", status: "OK",
      detail_no: `I perioden: ${line("downgrade", "period")} nedgradert til billigere modell, ${line("defer", "period")} utsatt/lokalt, ${line("deny", "period")} stengt av hard stopp. Siste 7 d: ${line("downgrade", "d7")} / ${line("defer", "d7")} / ${line("deny", "d7")}. Kun beslutninger som gjorde noe telles (en vanlig «tillat» er kun i sporet).`,
      facts: {
        downgraded_period: line("downgrade", "period"), deferred_period: line("defer", "period"), denied_period: line("deny", "period"),
        downgraded_7d: line("downgrade", "d7"), deferred_7d: line("defer", "d7"), denied_7d: line("deny", "d7"),
        essential_period: c.by_tier.essential.period, important_period: c.by_tier.important.period, background_period: c.by_tier.background.period
      }
    }));
  } else {
    items.push(unknownItem("claude_budget_decisions", "Kall styrt bort fra Claude", decisionsR.category));
  }
  return items;
}

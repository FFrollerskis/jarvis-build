// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { withTenantTransaction, writeAudit } from "@jarvis/core";
import {
  CLAUDE_BUDGET_PROVIDER, deriveBudgetOrigin, describeStateNo, dueAlertKeys, formatDateNo, readClaudeBudgetState, tierFor,
  type BudgetTier, type ClaudeBudgetConfig, type ClaudeBudgetStatus, type PacingLevel, type PacingState
} from "@jarvis/model-gateway";
import type { BriefItem, BriefSource } from "@jarvis/tool-gateway";
import type { Alert, AlertSink, Severity } from "@jarvis/watchdog";

/**
 * WP-B4 (D-476): FLATENE for Claude-kreditten utenfor gatewayen - lesere (kontrollsenter), én linje i daglig brief og Telegram-varsel (én gang per terskel per kredittperiode). Alt her er bak
 * `JARVIS_CLAUDE_BUDGET_USD` (uten flagget lages ingen av dem), og alt leser samme kilde som håndhevelsen (`readClaudeBudgetState`: Anthropic-rader i `cost_events`, tenant-RLS) - ingen parallell telling.
 *
 * AI-KOSTNAD I ØRE er finansdata etter strengeste regel inntil Q-64 er besvart: brief og Telegram går til EIEREN (aldri en modell), og kontrollsenteret bygger tallene kun for lokal modell/siden
 * (`ControlCenterBuildContext.restrictFinance`, se `control-center/ai-claude-budget.ts`) - aldri for en skymodell.
 */

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------------
// Lesere (kun SELECT, tenant-RLS; kun aggregater og kategorier)
// ---------------------------------------------------------------------------------------------------------------------

export interface ClaudeUsageRow {
  purpose: string;
  tier: BudgetTier;
  calls_7d: number;
  ore_7d: number;
  calls_30d: number;
  ore_30d: number;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Anthropic-forbruk siste 7 og 30 døgn per formål og tier. TIER er utledet (formål + om raden har jobb-id/økt-id, samme regel som håndhevelsen) - kall med et eksplisitt opphavs-hint (delegerte jobber, AI-råd)
 * kan i virkeligheten ha hatt en annen tier enn raden viser, siden hintet ikke lagres i `cost_events`. Formålsfordelingen er eksakt; tier-fordelingen er en tilnærming (sies i visningen).
 */
export async function readClaudeUsage(pool: pg.Pool, tenantId: string, config: ClaudeBudgetConfig, nowMs: number): Promise<ClaudeUsageRow[]> {
  const result = await withTenantTransaction(pool, tenantId, (client) =>
    client.query(
      `SELECT purpose, (task_id IS NOT NULL) AS has_task, (session_id IS NOT NULL) AS has_session,
              (count(*) FILTER (WHERE success AND NOT critic AND at >= $2))::int AS calls_7d,
              coalesce(sum(amount_ore) FILTER (WHERE at >= $2), 0)::float8 AS ore_7d,
              (count(*) FILTER (WHERE success AND NOT critic))::int AS calls_30d,
              coalesce(sum(amount_ore), 0)::float8 AS ore_30d
         FROM cost_events
        WHERE provider = $3 AND at >= $1
        GROUP BY purpose, (task_id IS NOT NULL), (session_id IS NOT NULL)`,
      [new Date(nowMs - 30 * MS_PER_DAY), new Date(nowMs - 7 * MS_PER_DAY), CLAUDE_BUDGET_PROVIDER]
    )
  );
  const merged = new Map<string, ClaudeUsageRow>();
  for (const r of result.rows as Array<Record<string, unknown>>) {
    const purpose = typeof r["purpose"] === "string" && r["purpose"] !== "" ? r["purpose"] : "UNSPECIFIED";
    const origin = deriveBudgetOrigin({ ...(r["has_task"] === true ? { task_id: "x" } : {}), ...(r["has_session"] === true ? { session_id: "x" } : {}) });
    const tier = tierFor(config.tiers, origin, purpose);
    const key = `${purpose}\u0000${tier}`;
    const prev = merged.get(key) ?? { purpose, tier, calls_7d: 0, ore_7d: 0, calls_30d: 0, ore_30d: 0 };
    merged.set(key, {
      purpose, tier, calls_7d: prev.calls_7d + num(r["calls_7d"]), ore_7d: prev.ore_7d + num(r["ore_7d"]), calls_30d: prev.calls_30d + num(r["calls_30d"]), ore_30d: prev.ore_30d + num(r["ore_30d"])
    });
  }
  return [...merged.values()].sort((a, b) => b.ore_30d - a.ore_30d || a.purpose.localeCompare(b.purpose));
}

export interface ClaudeDecisionCounts {
  /** `decision` (downgrade/defer/deny) → antall i kredittperioden og siste 7 døgn. */
  by_decision: Record<"downgrade" | "defer" | "deny", { period: number; d7: number }>;
  /** Per tier (kun beslutninger som gjorde noe). */
  by_tier: Record<BudgetTier, { period: number; d7: number }>;
}

/** Antall nedgraderte, utsatte og avviste kall: revisjonsradene `claude_budget.decision` (kun beslutninger som gjorde noe skrives, se enforceren). */
export async function readClaudeDecisionCounts(pool: pg.Pool, tenantId: string, windowStartMs: number, windowEndMs: number, nowMs: number): Promise<ClaudeDecisionCounts> {
  const d7 = nowMs - 7 * MS_PER_DAY;
  const result = await withTenantTransaction(pool, tenantId, (client) =>
    client.query(
      `SELECT decision, payload->>'tier' AS tier,
              (count(*) FILTER (WHERE at >= $1 AND at < $2))::int AS n_period,
              (count(*) FILTER (WHERE at >= $3))::int AS n_7d
         FROM audit_events
        WHERE type = 'claude_budget.decision' AND decision IN ('downgrade', 'defer', 'deny') AND at >= LEAST($1::timestamptz, $3::timestamptz)
        GROUP BY decision, payload->>'tier'`,
      [new Date(windowStartMs), new Date(windowEndMs), new Date(d7)]
    )
  );
  const out: ClaudeDecisionCounts = {
    by_decision: { downgrade: { period: 0, d7: 0 }, defer: { period: 0, d7: 0 }, deny: { period: 0, d7: 0 } },
    by_tier: { essential: { period: 0, d7: 0 }, important: { period: 0, d7: 0 }, background: { period: 0, d7: 0 } }
  };
  for (const r of result.rows as Array<Record<string, unknown>>) {
    const decision = r["decision"];
    const tier = r["tier"];
    const period = num(r["n_period"]);
    const last7 = num(r["n_7d"]);
    // kun beslutninger som GJORDE noe telles - også per tier (en rad med en annen beslutning, som `allow`, kommer aldri fra SQL-en, men teller aldri uansett)
    if (decision !== "downgrade" && decision !== "defer" && decision !== "deny") continue;
    out.by_decision[decision].period += period;
    out.by_decision[decision].d7 += last7;
    if (tier === "essential" || tier === "important" || tier === "background") {
      out.by_tier[tier].period += period;
      out.by_tier[tier].d7 += last7;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Daglig brief: én linje
// ---------------------------------------------------------------------------------------------------------------------

const BRIEF_BY_LEVEL: Readonly<Record<PacingLevel, { score: number; why: string; action?: string }>> = {
  // `fyi` er score < 40 og `needs_attention` score ≥ 70 (DailyBrief.render viser kun disse seksjonene): linjen er alltid med.
  on_pace: { score: 30, why: "Claude-kreditten ligger på tempo" },
  ahead: { score: 35, why: "forbruket ligger foran kurven - bakgrunnsarbeid går på en billigere modell" },
  tight: { score: 75, why: "stramt - bakgrunnsarbeid går lokalt eller utsettes, kun det viktigste bruker Claude", action: "se AI-senteret (Kost)" },
  exhausted: { score: 88, why: "kreditten er brukt opp - Anthropic er stengt til fornyelsen og alt går til lokal modell", action: "se AI-senteret (Kost)" }
};

/** Oppbrukt med hardstoppen AV (eierens override): Anthropic er IKKE stengt - briefen skal ikke påstå det. */
const BRIEF_EXHAUSTED_HARD_STOP_OFF = {
  score: 88, why: "kreditten er brukt opp og hardstoppen er av - egne turer og bestilte jobber fortsetter på Claude (det kan koste penger), bakgrunn går lokalt", action: "se AI-senteret (Kost)"
} as const;

/**
 * Daglig brief: ÉN linje om Claude-kreditten (kilde `claude-budget`). `ref` er dagens dato, så linjen er ny hver dag (briefens «ikke gjenta det som er presentert før» gjelder `source:ref`). Kan kreditten ikke leses,
 * kaster kilden - briefen degraderer da pent (samme som alle kilder) og viser «Connector utilgjengelig: claude-budget», aldri «i orden». Briefen leveres til eieren (Telegram), ikke til en modell.
 */
export function claudeBudgetBriefSource(opts: { pool: pg.Pool; config: ClaudeBudgetConfig; now?: () => number }): BriefSource {
  const now = opts.now ?? Date.now;
  return {
    name: "claude-budget",
    async collect(identity: IdentityContext): Promise<BriefItem[]> {
      const nowMs = now();
      const { state } = await readClaudeBudgetState(opts.pool, identity.tenant_id, opts.config, nowMs);
      const level = state.level === "exhausted" && !opts.config.hard_stop ? BRIEF_EXHAUSTED_HARD_STOP_OFF : BRIEF_BY_LEVEL[state.level];
      const today = new Date(nowMs).toLocaleDateString("sv-SE", { timeZone: "Europe/Oslo" });
      return [{
        source: "claude-budget", ref: today, title: describeStateNo(state, opts.config), at: new Date(nowMs).toISOString(), score: level.score,
        why: level.why, ...(level.action !== undefined ? { action: level.action } : {})
      }];
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Telegram-varsel: én gang per terskel per kredittperiode
// ---------------------------------------------------------------------------------------------------------------------

export const CLAUDE_BUDGET_ALERT_INTERVAL_MS = 5 * 60_000;
const ALERT_RUNBOOK = "docs/runbooks/WPB4_CLAUDE_BUDGET_PACING.md";

export interface ClaudeBudgetAlertMessage {
  severity: Severity;
  message: string;
}

/** Tekst og alvorlighet for et varsel. Beløp er med (varselet går til eieren via Telegram, aldri til en modell). `fresh` = nøklene som ikke er varslet ennå; høyeste prosentterskel bestemmer tonen. */
export function claudeBudgetAlertMessage(state: PacingState, config: Pick<ClaudeBudgetConfig, "nok_per_usd" | "budget_usd" | "hard_stop" | "tight_ratio">, fresh: readonly string[]): ClaudeBudgetAlertMessage {
  const top = fresh.filter((k) => k.startsWith("pct:")).map((k) => Number(k.slice(4))).filter(Number.isFinite).sort((a, b) => a - b).pop();
  const pace = fresh.includes("pace");
  const parts: string[] = [];
  let severity: Severity = "info";
  if (top !== undefined) {
    if (top >= 100) {
      severity = "critical";
      parts.push(config.hard_stop
        ? `Claude-kreditten er brukt opp (${top} %). HARD STOPP: Anthropic er stengt til fornyelsen ${formatDateNo(state.window.end_ms)}, og alt går til lokal modell.`
        : `Claude-kreditten er over ${top} %. Hardstoppen er AV (JARVIS_CLAUDE_BUDGET_HARD_STOP=off): dine egne turer og bestilte jobber fortsetter på Claude, bakgrunn går lokalt, og dette er kun et varsel.`);
    } else {
      severity = top >= 75 ? "warning" : "info";
      parts.push(`Claude-kreditten har nådd ${top} % (fornyes ${formatDateNo(state.window.end_ms)}).`);
    }
  }
  if (pace) {
    if (severity === "info") severity = "warning";
    parts.push(`Tempoet er ${(state.pace_ratio ?? 0).toFixed(1).replace(".", ",")} ganger kurven (over ${String(config.tight_ratio).replace(".", ",")}): bakgrunnsarbeid utsettes eller går lokalt til tempoet er tilbake.`);
  }
  parts.push(describeStateNo(state, config));
  return { severity, message: parts.join(" ") };
}

export interface ClaudeBudgetAlerterOptions {
  pool: pg.Pool;
  config: ClaudeBudgetConfig;
  /** Eierens tenant (varslene er til eieren; ekstra tenanter varsles ikke). */
  tenantId: string;
  /** Revisjonsmarkørene skrives under eierens sovereign-autoritet (som vakthunden, D-181). */
  ownerPersonId: string;
  /** Den EKSISTERENDE varslingsveien: vakthundens nød-sink (Telegram, kjører også under kill switch). */
  sink: AlertSink;
  now?: () => number;
}

/**
 * Varsler eieren ÉN gang per terskel per kredittperiode (50/75/90/100 % og når tempoet er over `tight_ratio` × kurven). Idempotensen er en revisjonsrad `claude_budget.alert` per (periode, terskel) i den varige
 * `audit_events`: den overlever omstart og rydding (revisjon slettes aldri), og skrives ETTER at varselet er levert - leveringsfeil gir et nytt forsøk i neste runde (aldri et tapt varsel), og en feil i selve markøren
 * kan i verste fall gi ett duplikat. Flere terskler som passeres mellom to runder gir ÉN melding (den høyeste) og markeres alle. Ukjent forbruk (lesefeil) varsler ikke - kontrollsenteret og briefen sier «ukjent».
 */
export class ClaudeBudgetAlerter {
  private readonly now: () => number;

  constructor(private readonly opts: ClaudeBudgetAlerterOptions) {
    this.now = opts.now ?? Date.now;
  }

  private async sentKeys(windowStart: string): Promise<Set<string>> {
    const result = await withTenantTransaction(this.opts.pool, this.opts.tenantId, (client) =>
      client.query(`SELECT payload->>'key' AS key FROM audit_events WHERE type = 'claude_budget.alert' AND payload->>'window_start' = $1`, [windowStart])
    );
    return new Set((result.rows as Array<{ key: unknown }>).map((r) => String(r.key)));
  }

  /** Én runde. Kaster aldri (logger kategori), og returnerer hva som ble sendt. */
  async tick(): Promise<{ sent: string[] }> {
    const { pool, config, tenantId, ownerPersonId, sink } = this.opts;
    let status: ClaudeBudgetStatus;
    try {
      status = await readClaudeBudgetState(pool, tenantId, config, this.now());
    } catch (err) {
      console.error(JSON.stringify({ msg: "claude_budget_alert_unreadable", error: err instanceof Error ? err.name : "unknown" }));
      return { sent: [] };
    }
    const due = dueAlertKeys(status.state, config);
    if (due.length === 0) return { sent: [] };
    let already: Set<string>;
    try {
      already = await this.sentKeys(status.window.start_date);
    } catch (err) {
      console.error(JSON.stringify({ msg: "claude_budget_alert_markers_unreadable", error: err instanceof Error ? err.name : "unknown" }));
      return { sent: [] }; // uten markørene vet vi ikke hva som er varslet - heller ingen melding enn en gjentatt
    }
    const fresh = due.filter((key) => !already.has(key));
    if (fresh.length === 0) return { sent: [] };
    const { severity, message } = claudeBudgetAlertMessage(status.state, config, fresh);
    const alert: Alert = { check: "claude_budget", severity, message, runbook: ALERT_RUNBOOK, at: new Date(this.now()).toISOString() };
    try {
      await sink.send(alert);
    } catch (err) {
      console.error(JSON.stringify({ msg: "claude_budget_alert_delivery_failed", error: err instanceof Error ? err.name : "unknown" }));
      return { sent: [] }; // ingen markør: neste runde prøver igjen
    }
    try {
      await withTenantTransaction(pool, tenantId, async (client) => {
        for (const key of fresh) {
          await writeAudit(client, { tenant_id: tenantId, person_id: ownerPersonId }, {
            type: "claude_budget.alert", decision: "sent", reason: key, tool_id: "claude_budget", action: "alert",
            payload: { key, window_start: status.window.start_date, window_end: status.window.end_date, spent_pct: Math.round(status.state.spent_pct * 100) / 100, level: status.state.level, severity }
          });
        }
      });
    } catch (err) {
      console.error(JSON.stringify({ msg: "claude_budget_alert_marker_failed", error: err instanceof Error ? err.name : "unknown" }));
    }
    return { sent: fresh };
  }
}

/** Starter varslingsrunden (hvert 5. minutt, og én gang straks). Kan ikke velte workeren: `tick()` kaster aldri, og timeren holder ikke prosessen i live. */
export function startClaudeBudgetAlerts(alerter: ClaudeBudgetAlerter, intervalMs: number = CLAUDE_BUDGET_ALERT_INTERVAL_MS): NodeJS.Timeout {
  const run = (): void => void alerter.tick().catch((err: unknown) => console.error(JSON.stringify({ msg: "claude_budget_alert_tick_error", error: err instanceof Error ? err.name : "unknown" })));
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}

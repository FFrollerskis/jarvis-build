import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { applyAssistToCandidate, assistInputDigest, type AssistInput, type AssistOutcome, type SignalAssist } from "./assist.ts";
import { ALL_DOMAINS, type DomainPauseRegistry } from "./domain-pause.ts";
import { bridgeObservation, deriveEventType, type SignalObservation } from "./signal-bridges.ts";
import { assertMinimalFacts, resolveRuleThreshold, ruleByKey, type BridgeContext, type BridgeResult, type SignalFacts } from "./signal-types.ts";
import { SituationDetectionKeyConflictError, type SituationEngine } from "./service.ts";
import type { SituationSubscription } from "./subscriptions.ts";
import type { Situation } from "./types.ts";

/**
 * WP-G4 (D-466), UA-10 P1a: INNTAKSBUSSEN - det ene stedet alle hendelseskilder går gjennom for å mate motoren. Én observasjon følger ALLTID samme rekkefølge:
 *
 *   1. hendelsestype (lukket sett)    -> ingen regel = ingen signal
 *   2. abonnement (eierens register)  -> ingen aktivt abonnement = forkastet (fail-closed), aldri et stille standardvalg
 *   3. bro (ren, terskler tunet innenfor harde grenser) -> under terskel/utenfor filter = ingen signal
 *   4. PAUSE (domene og hele motoren, både prosess-cache og varig database) -> pauset = ikke innlest (ikke bufret; tilstandsbaserte kilder gjenoppdages ved neste tikk, hendelsesbaserte innenfor oppslagsvinduet)
 *   5. (valgfritt) modellassistert vurdering - kun et løft `low` -> `normal`, aldri ACT (assist.ts)
 *   6. `SituationEngine.evaluateCandidate()` - dedupe, undertrykking, stille timer og tilstandsmaskin er MOTORENS (gjenbrukt uendret)
 *   7. signallogg (idempotent på kilde + `source_ref`) - UNNTATT et signal motoren HOLDER tilbake (stille timer, B-HIGH-1): det logges IKKE (se `heldByQuietHours`), så neste tikk evaluerer det på nytt og varselet
 *      går ut når stille timer er over. Loggen betyr «ferdig behandlet», aldri «sett mens vi ikke kunne varsle».
 *
 * «Ingen duplikat-spam»: samme hendelse får samme `detection_key` uansett kilde (incident via sveip og buss, åpning via Home Assistant og kamerasensor) og motorens `UNIQUE (tenant, space, detection_key)` + resuppress
 * gjør at det aldri blir mer enn én situasjon og ett varsel. Loggen hindrer i tillegg at en uendret tilstand evalueres på nytt hvert tikk (maks én evaluering per episode og nivå).
 *
 * Bussen har INGEN eksterne effekter (ingen verktøykall, ingen varsler): den skriver kun situasjonstilstand og logg. Leveranse (INFORM/SUGGEST) og ACT er fortsatt `deliverPendingInformNotifications()`/`autoActPending()`,
 * som begge sjekker pausen og eier-bindingen selv. Tenant/space er eksplisitte argumenter (RLS), og en observasjon kan aldri velge dem selv.
 */
export type IgnoredReason = "no_rule" | "no_subscription" | "no_signal" | "paused" | "duplicate";

export type PublishResult =
  | { status: "ignored"; reason: IgnoredReason }
  | { status: "evaluated"; situation: Situation; created: boolean; newly_actionable: boolean; uplifted: boolean; held: boolean }
  | { status: "failed"; code: string };

/**
 * B-HIGH-1: et signal er HOLDT når motoren har lagret situasjonen på `remember` uten å varsle fordi stille timer gjelder (ikke fordi prioriteten er `low`, og aldri når det faktisk ble varslet). Et holdt signal
 * logges ikke - det skal evalueres på nytt hvert tikk til stille timer er over (`evaluateCandidate` gir da `newly_actionable` og leveransen varsler). Uten dette ble `duplicate` et evig svar og varselet aldri sendt.
 */
export function heldByQuietHours(evaluated: { newly_actionable: boolean; situation: { stage: string } }, priority: string): boolean {
  return !evaluated.newly_actionable && evaluated.situation.stage === "remember" && priority !== "low";
}

export interface SignalBatchResult {
  received: number;
  ignored: Record<IgnoredReason, number>;
  evaluated: number;
  created: number;
  newly_actionable: number;
  /** Evaluert, men ikke logget fordi stille timer holder varselet tilbake (re-evalueres neste tikk). */
  held: number;
  failed: number;
  assist: { assessed: number; rejected: number; unavailable: number; uplifted: number; cached: number; skipped_cap: number };
  /** Korte koder (aldri innhold) for feil per observasjon. */
  errors: string[];
}

export const emptyBatchResult = (): SignalBatchResult => ({
  received: 0,
  ignored: { no_rule: 0, no_subscription: 0, no_signal: 0, paused: 0, duplicate: 0 },
  evaluated: 0, created: 0, newly_actionable: 0, held: 0, failed: 0,
  assist: { assessed: 0, rejected: 0, unavailable: 0, uplifted: 0, cached: 0, skipped_cap: 0 },
  errors: []
});

export function mergeBatchResults(into: SignalBatchResult, add: SignalBatchResult): void {
  into.received += add.received;
  for (const key of Object.keys(into.ignored) as IgnoredReason[]) into.ignored[key] += add.ignored[key];
  into.evaluated += add.evaluated;
  into.created += add.created;
  into.newly_actionable += add.newly_actionable;
  into.held += add.held;
  into.failed += add.failed;
  for (const key of Object.keys(into.assist) as Array<keyof SignalBatchResult["assist"]>) into.assist[key] += add.assist[key];
  into.errors.push(...add.errors.slice(0, Math.max(0, 20 - into.errors.length)));
}

/** Leser tunede terskler per (tenant, space). Rene verdier - klemmes mot harde grenser av `resolveRuleThreshold` uansett kilde. */
export interface RuleThresholdSource {
  thresholds(tenantId: string, memorySpace: MemorySpace): Promise<ReadonlyMap<string, number>>;
}

export interface SignalBusDeps {
  pool: pg.Pool;
  engine: SituationEngine;
  domainPauses: Pick<DomainPauseRegistry, "isPaused">;
  /** Aktive abonnementer for (tenant, space). Injiseres som funksjon så bussen ikke avhenger av registerets implementasjon. */
  subscriptions: (tenantId: string, memorySpace: MemorySpace) => Promise<readonly SituationSubscription[]>;
  tuning?: RuleThresholdSource;
  assist?: SignalAssist | null;
  now?: () => number;
}

export interface PublishContext {
  task_id?: string;
  session_id?: string;
  /** Maks antall modellkall i denne batchen (kostnad/tid). Resten får kun den deterministiske regelen. */
  assistBudget?: { remaining: number };
}

const codeOf = (err: unknown): string => {
  const pgCode = (err as { code?: unknown } | null)?.code;
  if (typeof pgCode === "string" && /^[0-9A-Z]{5}$/.test(pgCode)) return `db_${pgCode.toLowerCase()}`;
  return err instanceof Error && /^[A-Za-z0-9_]{3,60}$/.test(err.name) ? err.name : "signal_error";
};

export class SituationSignalBus {
  constructor(private readonly deps: SignalBusDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Pauset akkurat nå? Prosess-cachen (rask) OG den varige databasen (autoritativ - samme tabell `actOn()` og leveransen leser). */
  private async isPaused(tenantId: string, memorySpace: MemorySpace, domain: string): Promise<boolean> {
    if (this.deps.domainPauses.isPaused(domain)) return true;
    const rows = await withMemoryTransaction(this.deps.pool, tenantId, [memorySpace], async (client) => {
      const { rows: found } = await client.query(`SELECT domain FROM situation_domain_pauses WHERE domain = ANY($1::text[])`, [[domain, ALL_DOMAINS]]);
      return found;
    });
    return rows.length > 0;
  }

  private async alreadyLogged(tenantId: string, memorySpace: MemorySpace, source: string, sourceRef: string): Promise<boolean> {
    return withMemoryTransaction(this.deps.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM situation_signal_log WHERE tenant_id = $1 AND memory_space_id = $2 AND source = $3 AND source_ref = $4`,
        [tenantId, memorySpace, source, sourceRef]
      );
      return rows.length > 0;
    });
  }

  private async cachedAssessment(tenantId: string, memorySpace: MemorySpace, situationId: string, digest: string): Promise<AssistOutcome | null> {
    return withMemoryTransaction(this.deps.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT status, category, priority_hint, explanation, provider, model FROM situation_assessments
         WHERE tenant_id = $1 AND memory_space_id = $2 AND situation_id = $3 AND input_digest = $4`,
        [tenantId, memorySpace, situationId, digest]
      );
      const row = rows[0] as { status: string; category: string | null; priority_hint: string | null; explanation: string | null; provider: string | null; model: string | null } | undefined;
      if (row === undefined) return null;
      if (row.status !== "applied") return { status: "rejected", reason: "cached_rejected" };
      return {
        status: "assessed",
        assessment: {
          category: row.category as never, priority_hint: row.priority_hint as never, explanation: row.explanation ?? "", provider: row.provider ?? "unknown", model: row.model ?? "unknown"
        }
      };
    });
  }

  private async persist(
    tenantId: string, memorySpace: MemorySpace, bridge: BridgeResult, facts: SignalFacts, situation: Situation, created: boolean, newlyActionable: boolean,
    subscriptionId: string, ctx: PublishContext, assessed: { digest: string; outcome: AssistOutcome } | null, held: boolean
  ): Promise<void> {
    await withMemoryTransaction(this.deps.pool, tenantId, [memorySpace], async (client) => {
      // B-HIGH-1: et holdt signal (stille timer) logges IKKE - ellers ville neste tikk svare `duplicate` og varselet aldri gå ut. Vurderingen (modellkallet) lagres likevel, så den ikke gjentas hvert tikk.
      if (!held) await client.query(
        `INSERT INTO situation_signal_log
           (signal_id, tenant_id, memory_space_id, source, event_type, domain, source_ref, detection_key, situation_id, subscription_id,
            occurred_at, outcome, stage_after, priority, notified, facts, task_id, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18)
         ON CONFLICT (tenant_id, memory_space_id, source, source_ref) DO NOTHING`,
        [
          `sig-${randomUUID()}`, tenantId, memorySpace, bridge.source, bridge.event_type, bridge.candidate.domain, bridge.source_ref, bridge.candidate.detection_key,
          situation.situation_id, subscriptionId, bridge.occurred_at, created ? "created" : "updated", situation.stage, situation.priority, newlyActionable,
          JSON.stringify(facts), ctx.task_id ?? null, ctx.session_id ?? null
        ]
      );
      if (assessed !== null && (assessed.outcome.status === "assessed" || assessed.outcome.status === "rejected")) {
        const a = assessed.outcome.status === "assessed" ? assessed.outcome.assessment : null;
        await client.query(
          `INSERT INTO situation_assessments
             (assessment_id, tenant_id, memory_space_id, situation_id, input_digest, status, category, priority_hint, explanation, provider, model, task_id, session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (tenant_id, memory_space_id, situation_id, input_digest) DO NOTHING`,
          [
            `asm-${randomUUID()}`, tenantId, memorySpace, situation.situation_id, assessed.digest, a === null ? "rejected" : "applied",
            a?.category ?? null, a?.priority_hint ?? null, a?.explanation ?? null,
            a?.provider ?? (assessed.outcome.status === "rejected" ? assessed.outcome.provider ?? null : null),
            a?.model ?? (assessed.outcome.status === "rejected" ? assessed.outcome.model ?? null : null), ctx.task_id ?? null, ctx.session_id ?? null
          ]
        );
      }
    });
  }

  /** Én observasjon gjennom hele rekkefølgen (se klassens filhode). Kaster aldri: feil blir `failed` med en kort kode. */
  async publish(
    tenantId: string, memorySpace: MemorySpace, observation: SignalObservation, subs: readonly SituationSubscription[], thresholds: ReadonlyMap<string, number>, ctx: PublishContext = {},
    stats: SignalBatchResult = emptyBatchResult()
  ): Promise<PublishResult> {
    try {
      const eventType = deriveEventType(observation);
      if (eventType === null) return { status: "ignored", reason: "no_rule" };
      const candidates = subs.filter((s) => s.enabled && s.source === observation.source && s.event_type === eventType);
      if (candidates.length === 0) return { status: "ignored", reason: "no_subscription" };

      const bridgeCtx: BridgeContext = { nowMs: this.now(), threshold: (rule) => resolveRuleThreshold(rule, thresholds.get(rule.rule_key)) };
      let chosen: { sub: SituationSubscription; bridge: BridgeResult } | null = null;
      for (const sub of candidates) {
        const bridge = bridgeObservation(observation, sub.filter, bridgeCtx);
        if (bridge !== null) { chosen = { sub, bridge }; break; }
      }
      if (chosen === null) return { status: "ignored", reason: "no_signal" };
      const { sub, bridge } = chosen;
      const rule = ruleByKey(bridge.rule_key);
      if (rule === undefined) return { status: "ignored", reason: "no_rule" };

      // Pause FØR alt som skriver (også før logg-oppslaget): et pauset domene leses ikke inn, og signalet regnes ikke som sett (det gjenoppdages etter at pausen er opphevet).
      if (await this.isPaused(tenantId, memorySpace, bridge.candidate.domain)) return { status: "ignored", reason: "paused" };
      if (await this.alreadyLogged(tenantId, memorySpace, bridge.source, bridge.source_ref)) return { status: "ignored", reason: "duplicate" };

      // Modellassistert vurdering (valgfri): kun regler som er berettiget, og kun som et løft low -> normal (assist.ts). Hvert kall bundet til et tak per batch og til en digest (samme input = ett kall).
      let candidate = bridge.candidate;
      let facts: SignalFacts = bridge.facts;
      let assessed: { digest: string; outcome: AssistOutcome } | null = null;
      let uplifted = false;
      if (this.deps.assist && rule.assist) {
        const input: AssistInput = {
          tenant_id: tenantId, memory_space: memorySpace, rule_key: bridge.rule_key, domain: candidate.domain, priority: candidate.priority, facts: bridge.facts, detection_key: candidate.detection_key
        };
        const digest = assistInputDigest(input);
        const existing = await this.deps.engine.findByDetectionKey(tenantId, memorySpace, candidate.detection_key);
        let outcome: AssistOutcome | null = existing === null ? null : await this.cachedAssessment(tenantId, memorySpace, existing.situation_id, digest);
        if (outcome !== null) {
          stats.assist.cached += 1;
        } else if (ctx.assistBudget !== undefined && ctx.assistBudget.remaining <= 0) {
          stats.assist.skipped_cap += 1;
        } else {
          if (ctx.assistBudget !== undefined) ctx.assistBudget.remaining -= 1;
          outcome = await this.deps.assist.assess(input);
          if (outcome.status === "assessed") stats.assist.assessed += 1;
          else if (outcome.status === "rejected") stats.assist.rejected += 1;
          else stats.assist.unavailable += 1;
          assessed = { digest, outcome };
        }
        if (outcome !== null) {
          const applied = applyAssistToCandidate(candidate, outcome);
          candidate = applied.candidate;
          uplifted = applied.uplifted;
          if (uplifted) {
            stats.assist.uplifted += 1;
            facts = { ...facts, assist_uplift: true };
          }
        }
      }
      assertMinimalFacts(facts);

      const before = await this.deps.engine.findByDetectionKey(tenantId, memorySpace, candidate.detection_key);
      const evaluated = await this.deps.engine.evaluateCandidate(
        tenantId, memorySpace, bridge.urgent ? { ...candidate, urgent: true } : candidate, this.now()
      );
      const created = before === null;
      const held = heldByQuietHours(evaluated, candidate.priority);
      await this.persist(tenantId, memorySpace, bridge, facts, evaluated.situation, created, evaluated.newly_actionable, sub.subscription_id, ctx, assessed, held);
      return { status: "evaluated", situation: evaluated.situation, created, newly_actionable: evaluated.newly_actionable, uplifted, held };
    } catch (err) {
      if (err instanceof SituationDetectionKeyConflictError) return { status: "failed", code: "identity_conflict" };
      return { status: "failed", code: codeOf(err) };
    }
  }

  /** En batch for ÉN (tenant, space): abonnementer og tunede terskler leses ÉN gang. */
  async publishBatch(tenantId: string, memorySpace: MemorySpace, observations: readonly SignalObservation[], ctx: PublishContext = {}): Promise<SignalBatchResult> {
    const result = emptyBatchResult();
    if (observations.length === 0) return result;
    let subs: readonly SituationSubscription[];
    let thresholds: ReadonlyMap<string, number>;
    try {
      subs = await this.deps.subscriptions(tenantId, memorySpace);
      thresholds = this.deps.tuning ? await this.deps.tuning.thresholds(tenantId, memorySpace) : new Map();
    } catch (err) {
      result.received = observations.length;
      result.failed = observations.length;
      result.errors.push(`setup:${codeOf(err)}`);
      return result;
    }
    for (const observation of observations) {
      result.received += 1;
      const out = await this.publish(tenantId, memorySpace, observation, subs, thresholds, ctx, result);
      if (out.status === "ignored") result.ignored[out.reason] += 1;
      else if (out.status === "failed") {
        result.failed += 1;
        if (result.errors.length < 20) result.errors.push(`${observation.source}:${out.code}`);
      } else {
        result.evaluated += 1;
        if (out.created) result.created += 1;
        if (out.newly_actionable) result.newly_actionable += 1;
        if (out.held) result.held += 1;
      }
    }
    return result;
  }
}

import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { HealthObservation } from "./health-bridge.ts";
import type { HomeObservation } from "./home-bridge.ts";
import { emptyBatchResult, mergeBatchResults, type SituationSignalBus, type SignalBatchResult } from "./signal-bus.ts";
import type { IncidentObservation, SignalObservation } from "./signal-bridges.ts";
import { SignalLogService } from "./signal-log.ts";
import { HEALTH_SIGNAL_METRICS, type HealthSignalMetric, type HomeFilter, type SignalSource } from "./signal-types.ts";
import type { SituationEngine } from "./service.ts";
import type { SituationSubscription } from "./subscriptions.ts";
import type { VisionObservation } from "./vision-bridge.ts";
import { parseFilter } from "./signal-bridges.ts";

/**
 * WP-G4 (D-466), UA-10 P1a: «sanntids»-løperen. Et kort, fast tikk (standard 60 s) leser MINIMERTE observasjoner fra kildeportene for hvert (tenant, space) som har aktive abonnementer, sender dem gjennom
 * inntaksbussen, og kjører deretter motorens EKSISTERENDE leverings- og auto-ACT-steg for det samme (tenant, space). Ingen ny sti inn i motoren, ingen ny leverandør.
 *
 * KILDEPORTER (`SignalSourceReaders`) er strukturelle funksjoner som `apps/api` implementerer mot de eksisterende tjenestene (HA-connectoren via ToolGateway, `VisionService`, `HealthService`, `IncidentService`). Hver leser
 * får KUN det eierens abonnement ber om (entitetslisten, personen, metrikkene) og leverer KUN minimerte observasjoner. En kilde uten leser eller uten aktivt abonnement berøres ikke (ingen kall, ingen lesing).
 *
 * Eier-kontroller: `guard.blocked()` (kill switch m.fl.) sjekkes FØR første lesing og før hvert (tenant, space); en kastet feil tolkes som «stanset» (fail-closed). Pause (domene/hel motor) håndteres i bussen per observasjon
 * og av leveringen/auto-ACT. Én kilde eller ett (tenant, space) som feiler velter aldri resten (telles og logges med kode, aldri innhold). Aldri to tikk samtidig; `tick()` kaster aldri.
 *
 * Frekvens: `cadence` er «hvert N-te tikk» per kilde (standard: hjem/kamera/hendelser hvert tikk, helse hvert 15. - baselines endrer seg langsomt og lesingen aggregerer over uker). `now` og tikk-teller er injiserbare.
 * Daglig opprydding av signalloggen kjøres av løperen (høyst én gang per 24 timer per prosess og (tenant, space)).
 */
export interface SourceReadContext {
  tenant_id: string;
  memory_space: MemorySpace;
  now: number;
}

export interface SignalSourceReaders {
  home?: (ctx: SourceReadContext, entities: HomeFilter["entities"]) => Promise<HomeObservation[]>;
  /** `sinceMs`: oppslagsvinduet for hendelser (idempotensen ligger i loggen, så et overlapp er trygt). */
  vision?: (ctx: SourceReadContext, sinceMs: number) => Promise<VisionObservation[]>;
  health?: (ctx: SourceReadContext, personId: string, metrics: readonly HealthSignalMetric[]) => Promise<HealthObservation[]>;
  incident?: (ctx: SourceReadContext) => Promise<IncidentObservation[]>;
}

export interface SignalRunnerGuard {
  blocked(): Promise<string | null>;
}

export interface SignalTarget {
  tenant_id: string;
  memory_space: MemorySpace;
}

export const DEFAULT_SIGNAL_CADENCE: Readonly<Partial<Record<SignalSource, number>>> = { home_assistant: 1, vision: 1, incident: 1, health: 15 };
/** Hendelsesbaserte kilder leses med dette vinduet (3 x tikk, minst 10 min): overlapp mellom tikk er trygt fordi loggen er idempotent. */
export const MIN_VISION_LOOKBACK_MS = 10 * 60_000;
export const MAX_ASSIST_CALLS_PER_TICK = 5;
const DAY_MS = 86_400_000;

export interface SignalRunnerDeps {
  pool: pg.Pool;
  bus: SituationSignalBus;
  engine: SituationEngine;
  gateway: ToolGateway;
  readers: SignalSourceReaders;
  /** Aktive abonnementer for (tenant, space) - kun disse styrer hva som leses. */
  subscriptions: (tenantId: string, memorySpace: MemorySpace) => Promise<readonly SituationSubscription[]>;
  /** Hvilke (tenant, space) løperen betjener (i drift: kun eierens tenant og de rommene kildene bor i). */
  targets: readonly SignalTarget[];
  identityFor: (tenantId: string, memorySpace: MemorySpace) => IdentityContext;
  guard: SignalRunnerGuard;
  intervalMs: number;
  logRetentionDays?: number;
  cadence?: Readonly<Partial<Record<SignalSource, number>>>;
  now?: () => number;
}

export interface SignalTickResult {
  status: "ok" | "blocked";
  reason?: string;
  tick: number;
  spaces: number;
  bus: SignalBatchResult;
  sources_read: number;
  source_failures: number;
  delivered: number;
  auto_act_attempted: number;
  errors: string[];
}

const codeOf = (err: unknown): string => {
  const message = (err as Error | null)?.message;
  return typeof message === "string" && /^[a-z0-9_:.-]{3,60}$/i.test(message) ? message : err instanceof Error && /^[A-Za-z0-9_]{3,60}$/.test(err.name) ? err.name : "signal_runner_error";
};

export class SituationSignalRunner {
  private running = false;
  private tickCount = 0;
  private readonly lastPurge = new Map<string, number>();
  private last: SignalTickResult | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SignalRunnerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async blockedReason(): Promise<string | null> {
    try {
      return await this.deps.guard.blocked();
    } catch {
      return "guard_error"; // fail-closed
    }
  }

  /** Observasjoner for ÉN kilde ut fra abonnementene (hver leser får kun det eierens abonnement ber om). */
  private async read(source: SignalSource, subs: readonly SituationSubscription[], ctx: SourceReadContext): Promise<SignalObservation[] | null> {
    const readers = this.deps.readers;
    switch (source) {
      case "home_assistant": {
        if (!readers.home) return null;
        const byKey = new Map<string, HomeFilter["entities"][number]>();
        for (const sub of subs) {
          const f = parseFilter("home_assistant", sub.filter) as HomeFilter | null;
          if (f !== null) for (const e of f.entities) byKey.set(`${e.entity_id}|${e.role}`, e);
        }
        const entities = [...byKey.values()].slice(0, 50);
        return entities.length === 0 ? [] : readers.home(ctx, entities);
      }
      case "vision": {
        if (!readers.vision) return null;
        return readers.vision(ctx, ctx.now - Math.max(MIN_VISION_LOOKBACK_MS, 3 * this.deps.intervalMs));
      }
      case "health": {
        if (!readers.health) return null;
        const out: HealthObservation[] = [];
        const persons = new Map<string, Set<HealthSignalMetric>>();
        for (const sub of subs) {
          const f = parseFilter("health", sub.filter) as { person_id: string } | null;
          if (f === null) continue;
          const metric: HealthSignalMetric | null = sub.event_type === "resting_heart_rate_deviation" ? "resting_heart_rate" : sub.event_type === "sleep_duration_deviation" ? "sleep_duration_minutes" : sub.event_type === "activity_deviation" ? "steps" : null;
          if (metric === null || !(HEALTH_SIGNAL_METRICS as readonly string[]).includes(metric)) continue;
          persons.set(f.person_id, (persons.get(f.person_id) ?? new Set()).add(metric));
        }
        for (const [personId, metrics] of persons) out.push(...(await readers.health(ctx, personId, [...metrics])));
        return out;
      }
      case "incident":
        return readers.incident ? readers.incident(ctx) : null;
      default:
        return null;
    }
  }

  async tick(): Promise<SignalTickResult> {
    const result: SignalTickResult = { status: "ok", tick: 0, spaces: 0, bus: emptyBatchResult(), sources_read: 0, source_failures: 0, delivered: 0, auto_act_attempted: 0, errors: [] };
    if (this.running) {
      result.status = "blocked";
      result.reason = "tick_in_progress";
      return result;
    }
    this.running = true;
    try {
      this.tickCount += 1;
      result.tick = this.tickCount;
      const first = await this.blockedReason();
      if (first !== null) {
        result.status = "blocked";
        result.reason = first;
        this.last = result;
        return result;
      }
      const cadence = { ...DEFAULT_SIGNAL_CADENCE, ...(this.deps.cadence ?? {}) };
      for (const target of this.deps.targets) {
        const stop = await this.blockedReason();
        if (stop !== null) {
          result.status = "blocked";
          result.reason = stop;
          break;
        }
        const { tenant_id: tenantId, memory_space: space } = target;
        try {
          const subs = await this.deps.subscriptions(tenantId, space);
          if (subs.length === 0) continue;
          result.spaces += 1;
          const ctx: SourceReadContext = { tenant_id: tenantId, memory_space: space, now: this.now() };
          const bySource = new Map<SignalSource, SituationSubscription[]>();
          for (const sub of subs) bySource.set(sub.source, [...(bySource.get(sub.source) ?? []), sub]);
          const assistBudget = { remaining: MAX_ASSIST_CALLS_PER_TICK };
          for (const [source, sourceSubs] of bySource) {
            const every = Math.max(1, cadence[source] ?? 1);
            if (this.tickCount % every !== 0 && this.tickCount !== 1) continue;
            let observations: SignalObservation[];
            try {
              const read = await this.read(source, sourceSubs, ctx);
              // Ingen leser for kilden (flagg av / ikke koblet): ingenting leses og ingenting telles.
              if (read === null) continue;
              observations = read;
              result.sources_read += 1;
            } catch (err) {
              result.source_failures += 1;
              if (result.errors.length < 20) result.errors.push(`${source}:${codeOf(err)}`);
              console.error(JSON.stringify({ msg: "situation_signal_source_failed", tenant_id: tenantId, memory_space_id: space, source, code: codeOf(err) }));
              continue;
            }
            mergeBatchResults(result.bus, await this.deps.bus.publishBatch(tenantId, space, observations, { task_id: `situation-signals:${source}`, session_id: "situation-signal-runner", assistBudget }));
          }
          const identity = this.deps.identityFor(tenantId, space);
          try {
            const delivery = await this.deps.engine.deliverPendingInformNotifications(tenantId, space, this.deps.gateway, identity);
            result.delivered += delivery.delivered + delivery.reconciled_from_evidence;
          } catch (err) {
            if (result.errors.length < 20) result.errors.push(`deliver:${codeOf(err)}`);
          }
          try {
            const act = await this.deps.engine.autoActPending(tenantId, space, this.deps.gateway, identity);
            result.auto_act_attempted += act.attempted;
          } catch (err) {
            if (result.errors.length < 20) result.errors.push(`auto_act:${codeOf(err)}`);
          }
          await this.maybePurge(tenantId, space);
        } catch (err) {
          result.source_failures += 1;
          if (result.errors.length < 20) result.errors.push(`target:${codeOf(err)}`);
          console.error(JSON.stringify({ msg: "situation_signal_target_failed", tenant_id: tenantId, memory_space_id: space, code: codeOf(err) }));
        }
      }
      this.last = result;
      return result;
    } finally {
      this.running = false;
    }
  }

  private async maybePurge(tenantId: string, space: MemorySpace): Promise<void> {
    const key = `${tenantId}|${space}`;
    const nowMs = this.now();
    if (nowMs - (this.lastPurge.get(key) ?? 0) < DAY_MS) return;
    this.lastPurge.set(key, nowMs);
    try {
      await new SignalLogService(this.deps.pool).purge(tenantId, space, this.deps.logRetentionDays, nowMs);
    } catch (err) {
      console.error(JSON.stringify({ msg: "situation_signal_purge_failed", tenant_id: tenantId, memory_space_id: space, code: codeOf(err) }));
    }
  }

  status(): { running: boolean; tick: number; last: SignalTickResult | null } {
    return { running: this.running, tick: this.tickCount, last: this.last };
  }

  /** Starter et periodisk tikk (aldri overlappende; `unref` så det ikke holder prosessen i live). Første tikk etter ett intervall (aldri i oppstartsstien). */
  start(): void {
    if (this.timer !== null) return;
    const timer = setInterval(() => void this.tick().catch(() => undefined), Math.max(15_000, this.deps.intervalMs));
    timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { HealthObservation } from "./health-bridge.ts";
import type { HomeObservation } from "./home-bridge.ts";
import { ALL_DOMAINS } from "./domain-pause.ts";
import { emptyBatchResult, mergeBatchResults, type PendingAssistEntry, type SituationSignalBus, type SignalBatchResult } from "./signal-bus.ts";
import type { IncidentObservation, SignalObservation } from "./signal-bridges.ts";
import { SignalLogService } from "./signal-log.ts";
import { retireSignalSituations } from "./signal-retention.ts";
import { HEALTH_SIGNAL_METRICS, type HealthSignalMetric, type HomeFilter, type SignalSource } from "./signal-types.ts";
import { DEFAULT_AUTO_ACT_MAX_AGE_MS, type SituationEngine } from "./service.ts";
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
 * Daglig opprydding av signalloggen og signalsituasjonene kjøres av løperen (høyst én gang per 24 timer per prosess og (tenant, space); en feilet opprydding prøves igjen etter en time og er synlig i tikkresultatet: `retention_failures`/`errors`).
 * Oppryddingen dekker også rom uten påslått kilde (`retentionTargets`), så lenge løperen finnes (hovedbryteren på).
 *
 * FIKS-RUNDE (A-MEDIUM-2/3): (1) DETERMINISTISK FØRST: i fase 1 evalueres og leveres alt uten ett eneste modellkall (en vannlekkasje venter aldri på en modell); modellvurderingen (valgfri) kjøres i fase 2, ETTER at alle mål er evaluert og levert,
 * med tak per (tenant, rom) og ETT felles tidsbudsjett per tikk (`assistBudgetMs`, vegg-tid; et kall som ikke er ferdig avbrytes og regnes som `unavailable`). Et løft leveres umiddelbart etterpå. (2) PAUSE: en kilde der ALLE abonnementsdomener
 * er pauset (eller hele motoren) LESES IKKE (helsedata leses ikke mens helse er pauset); bussen sjekker pausen per observasjon uansett (en delvis pause og en pause satt midt i et tikk er fortsatt trygt).
 */
export interface SourceReadContext {
  tenant_id: string;
  memory_space: MemorySpace;
  now: number;
  /** Kilden legger korte advarselskoder (aldri innhold) her - f.eks. `home_entities_unknown:2` (en skrivefeil i en entitets-id) eller `home_entities_truncated:60`. Løperen viser dem i tikkresultatet. */
  warnings?: string[];
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
/** Maks entiteter per Home Assistant-lesing (samme tak som den samlede lese-handlingen). Flere abonnerte entiteter gir en synlig advarsel (`home_entities_truncated`). */
export const MAX_HOME_ENTITIES = 50;
/** Samlet vegg-tidsbudsjett for ALLE modellvurderinger i ett tikk (fase 2). Kall som ikke er ferdige da avbrytes; deterministisk evaluering og levering er allerede ferdig. */
export const DEFAULT_ASSIST_TICK_BUDGET_MS = 20_000;
const DAY_MS = 86_400_000;
/** En vellykket daglig opprydding venter et døgn; en FEILET prøves igjen etter denne tiden (ikke først neste døgn, og ikke hvert tikk). */
export const PURGE_RETRY_AFTER_FAILURE_MS = 60 * 60_000;

export interface SignalRunnerDeps {
  pool: pg.Pool;
  bus: SituationSignalBus;
  engine: SituationEngine;
  gateway: ToolGateway;
  readers: SignalSourceReaders;
  /** Aktive abonnementer for (tenant, space) - kun disse styrer hva som leses. */
  subscriptions: (tenantId: string, memorySpace: MemorySpace) => Promise<readonly SituationSubscription[]>;
  /** Hvilke (tenant, space) løperen betjener (i drift: kun eierens tenant og de rommene PÅSLÅTTE kilder bor i). */
  targets: readonly SignalTarget[];
  /**
   * D-LOW-3 (delta-review B): (tenant, space) som får den daglige oppryddingen UAVHENGIG av om noen kilde er på. Uten denne ryddes kun rommene til påslåtte kilder, så en avslått kilde lot gamle signalrader stå utover kildens oppbevaring.
   * I drift: eierens tenant i alle rom en kilde kan bo i (`SOURCE_SPACES`), så lenge hovedbryteren er på. Ingen lesing, ingen levering - kun opprydding, og kun når kill switch ikke er aktiv.
   */
  retentionTargets?: readonly SignalTarget[];
  identityFor: (tenantId: string, memorySpace: MemorySpace) => IdentityContext;
  guard: SignalRunnerGuard;
  intervalMs: number;
  logRetentionDays?: number;
  cadence?: Readonly<Partial<Record<SignalSource, number>>>;
  /** Samlet tidsbudsjett (ms, vegg-tid) for modellvurderinger per tikk (se `DEFAULT_ASSIST_TICK_BUDGET_MS`). */
  assistBudgetMs?: number;
  /** Ferskhetsvindu for auto-ACT (ms). Standard `max(1 time, 3 x tikkintervall)` - et gammelt forslag utføres aldri (A-MEDIUM-4). */
  autoActMaxAgeMs?: number;
  /** Åpne, uclaimede signalsituasjoner som ikke er sett så lenge løses av den daglige oppryddingen (standard 48 t). */
  resolveAfterHours?: number;
  /** Kildenes EGEN oppbevaring (G2 helse, G3 kamera): en signalsituasjon overlever aldri kildedataene. Injiseres fra `apps/api` (modulene importerer ikke hverandre); en feil eller `null` = standard. */
  sourceRetention?: {
    healthDays?: (tenantId: string) => Promise<number | null>;
    visionDays?: (tenantId: string, memorySpace: MemorySpace) => Promise<number | null>;
  };
  now?: () => number;
}

export interface SignalTickResult {
  status: "ok" | "blocked";
  reason?: string;
  tick: number;
  spaces: number;
  bus: SignalBatchResult;
  sources_read: number;
  /** Kilder som ikke ble lest fordi alle abonnementsdomenene (eller hele motoren) er pauset. */
  sources_skipped_paused: number;
  source_failures: number;
  /** Daglige oppryddinger (signallogg, signalsituasjoner) som feilet i dette tikket. Telles og vises i `errors` (`purge:<kode>`/`retention:<kode>`, aldri innhold); oppryddingen prøves igjen etter en time. */
  retention_failures: number;
  /** Ikke-fatale kildeadvarsler (korte koder, maks 20): ukjent/feilende entitet, avkortet entitetsliste. En kildefeil er `errors`; en advarsel er at noe stille ikke virker. */
  warnings: string[];
  delivered: number;
  auto_act_attempted: number;
  errors: string[];
}

const codeOf = (err: unknown): string => {
  const message = (err as Error | null)?.message;
  if (typeof message === "string" && /^[a-z0-9_:.-]{3,60}$/i.test(message)) return message;
  // Databasefeil: SQLSTATE-koden (f.eks. `pg_23503`) er en kort kode uten innhold og sier mer enn feilklassens navn («error»).
  const sqlState = (err as { code?: unknown } | null)?.code;
  if (typeof sqlState === "string" && /^[0-9A-Z]{5}$/.test(sqlState)) return `pg_${sqlState}`;
  return err instanceof Error && /^[A-Za-z0-9_]{3,60}$/.test(err.name) ? err.name : "signal_runner_error";
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
        const entities = [...byKey.values()].slice(0, MAX_HOME_ENTITIES);
        // B-LOW-6: tidligere kuttet løperen STILLE til 50 entiteter; nå en synlig advarsel (de resterende leses ikke).
        if (byKey.size > MAX_HOME_ENTITIES) ctx.warnings?.push(`home_entities_truncated:${byKey.size}`);
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
    const result: SignalTickResult = { status: "ok", tick: 0, spaces: 0, bus: emptyBatchResult(), sources_read: 0, sources_skipped_paused: 0, source_failures: 0, retention_failures: 0, warnings: [], delivered: 0, auto_act_attempted: 0, errors: [] };
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
      // A-MEDIUM-2: signaler som er evaluert deterministisk (fase 1) og venter på modellvurdering (fase 2), samlet per (tenant, rom).
      const pendingAssists: Array<{ tenantId: string; space: MemorySpace; entries: PendingAssistEntry[] }> = [];
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
          if (subs.length === 0) {
            // Ingen påslåtte abonnementer: ingen lesing og ingen levering (eieren har slått alt av), men oppryddingen kjøres uavhengig (en 90 dager gammel loggrad skal ikke bli stående).
            await this.maybePurge(tenantId, space, result);
            continue;
          }
          result.spaces += 1;
          const ctx: SourceReadContext = { tenant_id: tenantId, memory_space: space, now: this.now(), warnings: [] };
          // Kildeadvarsler (B-LOW-6): flyttes til tikkresultatet etter hver lesing (kilde-prefiks, uten duplikater, maks 20).
          const drainWarnings = (source: string): void => {
            for (const w of (ctx.warnings ?? []).splice(0)) {
              const entry = `${source}:${w}`;
              if (result.warnings.length < 20 && !result.warnings.includes(entry)) result.warnings.push(entry);
            }
          };
          const bySource = new Map<SignalSource, SituationSubscription[]>();
          for (const sub of subs) bySource.set(sub.source, [...(bySource.get(sub.source) ?? []), sub]);
          const pending: PendingAssistEntry[] = [];
          // A-MEDIUM-3: pausene leses ÉN gang per mål (cache + varig); en kilde der ALLE abonnementsdomener er pauset (eller hele motoren) leses ikke.
          const paused = await this.deps.bus.pausedDomains(tenantId, space);
          for (const [source, sourceSubs] of bySource) {
            const every = Math.max(1, cadence[source] ?? 1);
            if (this.tickCount % every !== 0 && this.tickCount !== 1) continue;
            if (paused.has(ALL_DOMAINS) || sourceSubs.every((s) => paused.has(s.domain))) {
              result.sources_skipped_paused += 1;
              continue;
            }
            let observations: SignalObservation[];
            try {
              const read = await this.read(source, sourceSubs, ctx);
              drainWarnings(source);
              // Ingen leser for kilden (flagg av / ikke koblet): ingenting leses og ingenting telles.
              if (read === null) continue;
              observations = read;
              result.sources_read += 1;
            } catch (err) {
              drainWarnings(source);
              result.source_failures += 1;
              if (result.errors.length < 20) result.errors.push(`${source}:${codeOf(err)}`);
              console.error(JSON.stringify({ msg: "situation_signal_source_failed", tenant_id: tenantId, memory_space_id: space, source, code: codeOf(err) }));
              continue;
            }
            mergeBatchResults(result.bus, await this.deps.bus.publishBatch(tenantId, space, observations, { task_id: `situation-signals:${source}`, session_id: "situation-signal-runner", assistPhase: "deterministic", pendingAssist: pending }));
          }
          if (pending.length > 0) pendingAssists.push({ tenantId, space, entries: pending });
          const identity = this.deps.identityFor(tenantId, space);
          try {
            const delivery = await this.deps.engine.deliverPendingInformNotifications(tenantId, space, this.deps.gateway, identity);
            result.delivered += delivery.delivered + delivery.reconciled_from_evidence;
          } catch (err) {
            if (result.errors.length < 20) result.errors.push(`deliver:${codeOf(err)}`);
          }
          try {
            const act = await this.deps.engine.autoActPending(tenantId, space, this.deps.gateway, identity, { maxAgeMs: this.deps.autoActMaxAgeMs ?? Math.max(DEFAULT_AUTO_ACT_MAX_AGE_MS, 3 * this.deps.intervalMs) });
            result.auto_act_attempted += act.attempted;
          } catch (err) {
            if (result.errors.length < 20) result.errors.push(`auto_act:${codeOf(err)}`);
          }
          await this.maybePurge(tenantId, space, result);
        } catch (err) {
          result.source_failures += 1;
          if (result.errors.length < 20) result.errors.push(`target:${codeOf(err)}`);
          console.error(JSON.stringify({ msg: "situation_signal_target_failed", tenant_id: tenantId, memory_space_id: space, code: codeOf(err) }));
        }
      }
      // D-LOW-3 (delta-review B): opprydding for rom uten påslått kilde (oppryddingen har sin egen døgnvakt per (tenant, rom), så et rom som allerede er ryddet i dette tikket berøres ikke på nytt).
      if (result.status === "ok") {
        for (const target of this.deps.retentionTargets ?? []) {
          const stop = await this.blockedReason();
          if (stop !== null) {
            result.status = "blocked";
            result.reason = stop;
            break;
          }
          await this.maybePurge(target.tenant_id, target.memory_space, result);
        }
      }
      // Fase 2 (A-MEDIUM-2): modellvurdering ETTER at alt deterministisk er evaluert og levert for alle mål.
      if (pendingAssists.length > 0 && result.status === "ok") {
        const stop = await this.blockedReason();
        if (stop !== null) {
          result.status = "blocked";
          result.reason = stop;
        } else {
          await this.runAssistPhase(pendingAssists, result);
        }
      }
      this.last = result;
      return result;
    } finally {
      this.running = false;
    }
  }

  /** Fase 2: tak per (tenant, rom) og ETT felles vegg-tidsbudsjett per tikk. Et løft (nytt varsel) leveres umiddelbart etterpå. Feil telles med kode og stopper aldri resten. */
  private async runAssistPhase(work: ReadonlyArray<{ tenantId: string; space: MemorySpace; entries: PendingAssistEntry[] }>, result: SignalTickResult): Promise<void> {
    const deadline = Date.now() + Math.max(1, this.deps.assistBudgetMs ?? DEFAULT_ASSIST_TICK_BUDGET_MS);
    for (const { tenantId, space, entries } of work) {
      try {
        const out = await this.deps.bus.publishPendingAssists(tenantId, space, entries, { session_id: "situation-signal-runner", assistBudget: { remaining: MAX_ASSIST_CALLS_PER_TICK }, assistDeadlineAt: deadline });
        mergeBatchResults(result.bus, out);
        if (out.newly_actionable > 0) {
          const delivery = await this.deps.engine.deliverPendingInformNotifications(tenantId, space, this.deps.gateway, this.deps.identityFor(tenantId, space));
          result.delivered += delivery.delivered + delivery.reconciled_from_evidence;
        }
      } catch (err) {
        result.source_failures += 1;
        if (result.errors.length < 20) result.errors.push(`assist:${codeOf(err)}`);
        console.error(JSON.stringify({ msg: "situation_signal_assist_failed", tenant_id: tenantId, memory_space_id: space, code: codeOf(err) }));
      }
    }
  }

  /**
   * Daglig opprydding for ett (tenant, rom): signalloggen og signalsituasjonene. Feil er ALDRI stille (D-MEDIUM-1, delta-review B): hver feil telles i `result.retention_failures`, vises som `purge:<kode>`/`retention:<kode>` i `result.errors`
   * og logges med kode (aldri innhold); en feil i det ene rommet stopper aldri de andre (hvert rom har sin egen try/catch), og et feilet rom prøves igjen etter en time i stedet for først neste døgn.
   */
  private async maybePurge(tenantId: string, space: MemorySpace, result: SignalTickResult): Promise<void> {
    const key = `${tenantId}|${space}`;
    const nowMs = this.now();
    if (nowMs - (this.lastPurge.get(key) ?? 0) < DAY_MS) return;
    let failed = false;
    const fail = (stage: "purge" | "retention", msg: string, err: unknown): void => {
      failed = true;
      result.retention_failures += 1;
      if (result.errors.length < 20) result.errors.push(`${stage}:${codeOf(err)}`);
      const cause = (err as { cause?: unknown } | null)?.cause;
      console.error(JSON.stringify({ msg, tenant_id: tenantId, memory_space_id: space, code: codeOf(err), ...(cause !== undefined ? { cause: codeOf(cause) } : {}) }));
    };
    try {
      await new SignalLogService(this.deps.pool).purge(tenantId, space, this.deps.logRetentionDays, nowMs);
    } catch (err) {
      fail("purge", "situation_signal_purge_failed", err);
    }
    // A-MEDIUM-4/B-MEDIUM-3: signalsituasjonene (kamera/helse/hjem) får samme oppryddingsrytme: gamle åpne løses, og alt eldre enn kildedataenes oppbevaring slettes (kaskade til logg, vurderinger og tilbakemeldinger).
    try {
      const source = this.deps.sourceRetention;
      const safe = async (fn: (() => Promise<number | null>) | undefined): Promise<number | null> => {
        if (fn === undefined) return null;
        try {
          return await fn();
        } catch {
          return null;
        }
      };
      const healthDays = await safe(source?.healthDays ? () => source.healthDays!(tenantId) : undefined);
      const visionDays = await safe(source?.visionDays ? () => source.visionDays!(tenantId, space) : undefined);
      await retireSignalSituations(this.deps.pool, tenantId, space, {
        nowMs, healthDays, visionDays,
        ...(this.deps.logRetentionDays !== undefined ? { retentionDays: this.deps.logRetentionDays } : {}),
        ...(this.deps.resolveAfterHours !== undefined ? { resolveAfterHours: this.deps.resolveAfterHours } : {})
      });
    } catch (err) {
      fail("retention", "situation_signal_retention_failed", err);
    }
    // Vellykket: neste forsøk om et døgn. Feilet: om en time (feilen er synlig i tikkresultatet, og en forbigående feil venter ikke et helt døgn).
    this.lastPurge.set(key, failed ? nowMs - DAY_MS + PURGE_RETRY_AFTER_FAILURE_MS : nowMs);
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

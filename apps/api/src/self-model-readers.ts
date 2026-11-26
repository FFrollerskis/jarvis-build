import { statfs } from "node:fs/promises";
import os from "node:os";
import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import type { Observation, ObservationReader } from "@jarvis/executive";
import { describeSchedulerProblem, readSchedulerHealth } from "@jarvis/tool-gateway";
import { observeBackupStatus, type BackupStatusRead } from "./backup-status.ts";
import { readWatchdogObservation, type WatchdogRunSource } from "./watchdog-status.ts";

/**
 * EV-1 (D-412): leserne selvmodellen komponerer selvdiagnosen av. Hver leser er smal og injisert, leser KUN sin egen kilde, og svarer med
 * `status`/`source`/`observed_at`. Det som ikke kan måles herfra (GPU/CPU på PC-en, backup uten en montert statusfil, og vakthunden uten at incident-produsentene registrerer dens tikk) er bevisst UNKNOWN - aldri gjettet.
 */
export interface SelfModelReaderDeps {
  pool: Pick<pg.Pool, "query"> & Partial<Pick<pg.Pool, "connect">>;
  tenantId: string;
  /** `ModelGateway.meshStatus()` (kun strukturen vi trenger). */
  meshStatus: () => { providers: Array<{ provider: string; state: string; failures: number; success: number; avg_latency_ms?: number; paused?: boolean }> };
  /** `OwnerControls.getControlState()` (kill switch, frosne connectorer, tilbakekalte credentials). */
  controlState: () => Promise<{ kill_switch: { active: boolean }; frozen_connectors: ReadonlyArray<unknown>; revoked_credentials: ReadonlyArray<unknown> }>;
  /** `listConnectorStatus(gateway)`: kun feltene vi trenger. */
  connectorStatus: () => Promise<Array<{ id: string; configured: boolean; health: { state: string } | null }>>;
  /** Siste oppstartsresultat for konstitusjon/endringsregister (EV-0), eller null før første sjekk. */
  ev0Status?: () => {
    constitution: { status: string; code?: string; version?: number };
    ledger: { status: string; count?: number; broken_seq?: string | null; error?: string };
  } | null;
  /** Bygg-sha (fra miljøet) og versjon. */
  build?: () => { sha: string | null; version: string };
  /**
   * WP-C2: backup-status fra den skrivebeskyttede statusfilen `ops/backup/schedule.mjs` skriver (`backupStatusSourceFromEnv`). Uten denne finnes ingen
   * `backup`-leser, og området er UKJENT i selvdiagnosen.
   */
  backupStatus?: (() => Promise<BackupStatusRead>) | undefined;
  /**
   * WP-OPS2a K1: vakthundens siste registrerte tikk (`incident_producer_runs`, producer `watchdog`) + produsent-intervallet grensen regnes av (`watchdogRunSource`). Sendes KUN når incident-produsentene er på; uten den svarer `watchdog`-leseren
   * UKJENT med årsaken «incident-produsentene er AV» (vakthundens tikk registreres da ikke varig).
   */
  watchdogRuns?: WatchdogRunSource | undefined;
  now?: () => Date;
  /** Terskler (kan overstyres i tester). */
  limits?: { diskFreeWarnBytes?: number; memFreeWarnRatio?: number; toolErrorWarnRatio?: number; toolErrorMinSample?: number };
}

const iso = (d: Date) => d.toISOString();

export function buildSelfModelReaders(deps: SelfModelReaderDeps): Record<string, ObservationReader> {
  const now = deps.now ?? (() => new Date());
  const lim = {
    diskFreeWarnBytes: deps.limits?.diskFreeWarnBytes ?? 5 * 1024 ** 3,
    memFreeWarnRatio: deps.limits?.memFreeWarnRatio ?? 0.08,
    toolErrorWarnRatio: deps.limits?.toolErrorWarnRatio ?? 0.25,
    toolErrorMinSample: deps.limits?.toolErrorMinSample ?? 8
  };
  const tenantQuery = <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
    withTenantTransaction(deps.pool as pg.Pool, deps.tenantId, async (client) => (await client.query(sql)).rows as T[]);

  const readers: Record<string, ObservationReader> = {
    async database(): Promise<Observation> {
      const t0 = Date.now();
      await deps.pool.query("SELECT 1");
      const ms = Date.now() - t0;
      return { status: ms > 2000 ? "DEGRADED" : "OK", source: "postgres SELECT 1", observed_at: iso(now()), detail: ms > 2000 ? `Databasen svarer tregt (${ms} ms).` : "Databasen svarer.", data: { latency_ms: ms } };
    },

    async providers(): Promise<Observation[]> {
      const at = iso(now());
      const providers = deps.meshStatus().providers.filter((p) => p.provider !== "scripted");
      return providers.map((p): Observation => {
        const base = { source: `ModelGateway.meshStatus:${p.provider}`, observed_at: at, data: { state: p.state, success: p.success, failures: p.failures, ...(p.avg_latency_ms !== undefined ? { avg_latency_ms: p.avg_latency_ms } : {}) } };
        // WP-H0 (JARVIS-087): eierens pause/tilbakekall er et bevisst valg, ikke en feil - men leverandøren er ikke brukbar, så den vises som svekket (aldri «nåbar»).
        if (p.paused === true) return { ...base, status: "DEGRADED", detail: `Modellen ${p.provider} er pauset av deg (eier-valg) og brukes ikke i ruting.` };
        if (p.state === "UNAVAILABLE") return { ...base, status: "DOWN", detail: `Modellen ${p.provider} er utilgjengelig (${p.failures} feil på rad/totalt).` };
        if (p.state === "DEGRADED" || p.state === "RATE_LIMITED") return { ...base, status: "DEGRADED", detail: `Modellen ${p.provider} er ${p.state === "RATE_LIMITED" ? "rate-begrenset" : "svekket"}.` };
        if (p.state === "NOT_CONFIGURED") return { ...base, status: "OK", detail: `Modellen ${p.provider} er ikke konfigurert (bevisst).` };
        return { ...base, status: "OK", detail: `Modellen ${p.provider} er nåbar (${p.state}).` };
      });
    },

    async controls(): Promise<Observation> {
      const s = await deps.controlState();
      const at = iso(now());
      const data = { kill_switch: s.kill_switch.active, frozen_connectors: s.frozen_connectors.length, revoked_credentials: s.revoked_credentials.length };
      if (s.kill_switch.active) return { status: "DOWN", source: "OwnerControls.getControlState", observed_at: at, detail: "Kill switch er PÅ: alt er stoppet av eieren.", data };
      if (s.frozen_connectors.length > 0 || s.revoked_credentials.length > 0) {
        return { status: "DEGRADED", source: "OwnerControls.getControlState", observed_at: at, detail: `${s.frozen_connectors.length} frosne tilkoblinger og ${s.revoked_credentials.length} tilbakekalte credentials (eier-valg).`, data };
      }
      return { status: "OK", source: "OwnerControls.getControlState", observed_at: at, detail: "Ingen kill switch, frysing eller tilbakekalling.", data };
    },

    async connectors(): Promise<Observation> {
      const list = await deps.connectorStatus();
      const at = iso(now());
      const configured = list.filter((c) => c.configured);
      const failing = configured.filter((c) => c.health !== null && c.health.state !== "healthy");
      const neverCalled = configured.filter((c) => c.health === null).length;
      const data = { known: list.length, configured: configured.length, failing: failing.length, never_called: neverCalled };
      if (failing.length > 0) {
        const names = failing.map((c) => `${c.id} (${c.health?.state})`).slice(0, 5).join(", ");
        return { status: "DEGRADED", source: "ToolGateway.health", observed_at: at, detail: `${failing.length} av ${configured.length} konfigurerte tilkoblinger er ikke friske sist de ble brukt: ${names}.`, data };
      }
      return { status: "OK", source: "ToolGateway.health", observed_at: at, detail: `${configured.length} konfigurerte tilkoblinger; ${neverCalled} er aldri kalt siden oppstart (helse ukjent for dem).`, data };
    },

    async tasks(): Promise<Observation> {
      const rows = await tenantQuery<{ stuck: number; running: number; failed_1h: number }>(
        `SELECT count(*) FILTER (WHERE status = 'running' AND lease_expires_at < now())::int AS stuck,
                count(*) FILTER (WHERE status = 'running')::int AS running,
                count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '1 hour')::int AS failed_1h
           FROM tasks`
      );
      const r = rows[0] ?? { stuck: 0, running: 0, failed_1h: 0 };
      const at = iso(now());
      const data = { running: r.running, stuck: r.stuck, failed_last_hour: r.failed_1h };
      if (r.stuck > 0) return { status: "DEGRADED", source: "tasks (lease)", observed_at: at, detail: `${r.stuck} jobber har utløpt lease (står fast).`, data };
      return { status: "OK", source: "tasks (lease)", observed_at: at, detail: `${r.running} kjører, ingen står fast.`, data };
    },

    /**
     * D-443: daglige bakgrunnsjobber (`DailyScheduler` -> `scheduler_state`, global tabell uten tenant-RLS - derfor poolen direkte). DOWN når dagens (eller
     * gårsdagens) arbeid er TAPT (ga opp / ikke fullført), DEGRADED når et nytt forsøk er planlagt eller en claim henger. Ingen rader = UNKNOWN, aldri «frisk».
     */
    async scheduled_jobs(): Promise<Observation> {
      const at = iso(now());
      const health = await readSchedulerHealth(deps.pool);
      const count = (kind: string) => health.problems.filter((p) => p.kind === kind).length;
      const lostCritical = health.problems.some((p) => (p.kind === "gave_up" || p.kind === "lost_previous_day") && !p.best_effort);
      const data = {
        jobs_seen: health.jobs_seen, completed: health.completed,
        gave_up: count("gave_up"), lost_previous_day: count("lost_previous_day"), retry_pending: count("retry_pending"), stalled: count("stalled"),
        best_effort: health.problems.filter((p) => p.best_effort).length
      };
      if (health.jobs_seen === 0) {
        return { status: "UNKNOWN", source: "scheduler_state", observed_at: null, detail: "Ingen daglige jobber har kjørt i dag eller i går (nylig oppstart?) - ingen måling." };
      }
      if (health.problems.length === 0) {
        return { status: "OK", source: "scheduler_state", observed_at: at, detail: `${health.completed} av ${health.jobs_seen} daglige jobber er fullført, ingen feil.`, data };
      }
      const shown = health.problems.slice(0, 4).map(describeSchedulerProblem).join("; ");
      const more = health.problems.length > 4 ? ` (+${health.problems.length - 4} til)` : "";
      // D-445: kun tap i KRITISKE jobber er DOWN; jobber som avhenger av eierens PC (BEST_EFFORT_JOBS) gir DEGRADED selv om de ga opp.
      return { status: lostCritical ? "DOWN" : "DEGRADED", source: "scheduler_state", observed_at: at, detail: `${health.problems.length} daglige jobber har problemer: ${shown}${more}.`, data };
    },

    async errors(): Promise<Observation> {
      const rows = await tenantQuery<{ total: number; failed: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'failed')::int AS failed
           FROM tool_executions WHERE executed_at > now() - interval '1 hour'`
      );
      const r = rows[0] ?? { total: 0, failed: 0 };
      const at = iso(now());
      const data = { total: r.total, failed: r.failed };
      if (r.total < lim.toolErrorMinSample) return { status: "OK", source: "tool_executions (1 t)", observed_at: at, detail: `Få verktøykall siste time (${r.total}) - ingen feilrate å vurdere.`, data };
      const ratio = r.failed / r.total;
      return ratio >= lim.toolErrorWarnRatio
        ? { status: "DEGRADED", source: "tool_executions (1 t)", observed_at: at, detail: `${r.failed} av ${r.total} verktøykall feilet siste time (${Math.round(ratio * 100)} %).`, data }
        : { status: "OK", source: "tool_executions (1 t)", observed_at: at, detail: `${r.failed} av ${r.total} verktøykall feilet siste time.`, data };
    },

    async process(): Promise<Observation> {
      const at = iso(now());
      const total = os.totalmem();
      const free = os.freemem();
      let diskFree: number | null = null;
      try {
        const s = await statfs("/");
        diskFree = Number(s.bavail) * Number(s.bsize);
      } catch {
        diskFree = null;
      }
      const data = { uptime_s: Math.round(process.uptime()), load_1m: Math.round(os.loadavg()[0]! * 100) / 100, mem_free_ratio: Math.round((free / total) * 1000) / 1000, disk_free_gb: diskFree === null ? null : Math.round((diskFree / 1024 ** 3) * 10) / 10, node: process.version };
      if (diskFree !== null && diskFree < lim.diskFreeWarnBytes) return { status: "DEGRADED", source: "os/statfs (API-prosessen)", observed_at: at, detail: `Lite diskplass (${data.disk_free_gb} GB).`, data };
      if (free / total < lim.memFreeWarnRatio) return { status: "DEGRADED", source: "os/statfs (API-prosessen)", observed_at: at, detail: `Lite ledig minne (${Math.round((free / total) * 100)} %).`, data };
      return { status: "OK", source: "os/statfs (API-prosessen)", observed_at: at, detail: diskFree === null ? "Minne og last OK; diskplass kunne ikke leses." : "Minne, disk og last OK (kun der API-prosessen kjører).", data };
    },

    async constitution(): Promise<Observation> {
      const s = deps.ev0Status?.();
      const at = iso(now());
      if (!s) return { status: "UNKNOWN", source: "ev0 oppstartssjekk", observed_at: null, detail: "Safety Constitution er ikke sjekket ennå (oppstartssjekken har ikke kjørt)." };
      return s.constitution.status === "verified"
        ? { status: "OK", source: "ev0 oppstartssjekk", observed_at: at, detail: `Safety Constitution er verifisert (versjon ${s.constitution.version ?? "?"}).` }
        : { status: "DEGRADED", source: "ev0 oppstartssjekk", observed_at: at, detail: `Safety Constitution er IKKE verifisert (${s.constitution.code ?? "ukjent årsak"}) - selvendring er uansett frosset.`, data: { code: s.constitution.code ?? null } };
    },

    async ledger(): Promise<Observation> {
      const s = deps.ev0Status?.();
      const at = iso(now());
      if (!s) return { status: "UNKNOWN", source: "ev0 oppstartssjekk", observed_at: null, detail: "Endringsregisteret er ikke sjekket ennå." };
      if (s.ledger.status === "ok") return { status: "OK", source: "evolution_change_ledger", observed_at: at, detail: `Endringsregisterets hash-kjede er hel (${s.ledger.count ?? 0} rader).` };
      if (s.ledger.status === "broken") return { status: "DOWN", source: "evolution_change_ledger", observed_at: at, detail: `Endringsregisterets hash-kjede er ØDELAGT fra rad ${s.ledger.broken_seq ?? "?"}.` };
      return { status: "UNKNOWN", source: "evolution_change_ledger", observed_at: null, detail: `Endringsregisteret kunne ikke leses (${s.ledger.error ?? "ukjent"}) - migrasjon 075 kan mangle.` };
    },

    async build(): Promise<Observation> {
      const b = deps.build?.() ?? { sha: null, version: "ukjent" };
      const at = iso(now());
      return b.sha
        ? { status: "OK", source: "JARVIS_BUILD_SHA", observed_at: at, detail: `Bygg ${b.sha.slice(0, 7)}, versjon ${b.version}.`, data: { sha: b.sha, version: b.version } }
        : { status: "UNKNOWN", source: "JARVIS_BUILD_SHA", observed_at: null, detail: "Jeg vet ikke hvilken commit jeg er bygget fra (bygg-sha er ikke satt i miljøet)." };
    },

    // WP-OPS2a K1: vakthunden kjører i worker; det ENE varige sporet er raden `incident_producer_runs`/`watchdog` (kun når produsentene er på). Se `watchdog-status.ts`: UKJENT uten rad, ved lesefeil og ved klokkeavvik; aldri OK på en gjetning.
    async watchdog(): Promise<Observation> {
      return readWatchdogObservation(deps.watchdogRuns, now());
    }
  };
  // WP-C2: `backup` leses kun når en statusfil er montert; ellers har området BEVISST ingen leser og vises som UKJENT.
  const readBackup = deps.backupStatus;
  if (readBackup !== undefined) readers["backup"] = async (): Promise<Observation> => observeBackupStatus(await readBackup(), now());
  return readers;
}

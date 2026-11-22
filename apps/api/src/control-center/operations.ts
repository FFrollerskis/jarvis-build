// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import {
  controlItem, controlSection, unknownControlSection,
  type ControlCenterBuildContext, type ControlCenterDefinition, type ControlCenterParts, type ControlItem, type ControlSection, type ControlStatus, type InfraStatusReport
} from "@jarvis/executive";
import { observeBackupStatus, type BackupStatusRead, type BackupStatusSnapshot } from "../backup-status.ts";
import { JOB_WINDOW_DAYS, jobState, type JobRow } from "./integration.ts";
import {
  DAY_MS, NON_HEALTH_SPACES, bySeverityThenLabel, countsNo, globalRows, isFinanceJobName, relativeNo, safeCategory, settle, tenantRead, tenantSpaceRead, toInt, toIso,
  type ControlCenterPool, type Settled
} from "./shared.ts";

/**
 * WP-H2 (UA-11 Admin Control Center, masterplan v4.0 kap. 21) - OPERATIONS CENTER: helse, hendelser, runbooks, backup, restore-øvelser, oppetid og kapasitet.
 *
 * Kun LESING av EKSISTERENDE kilder - ingen nye eksterne kall, ingen skriving:
 *  - hendelser, skymål og produsenter: `ExecutiveService.getInfraStatus` (WP-E1; modules/incidents under RLS) - injisert som en funksjon, så senteret aldri bygger en egen kobling;
 *  - backup og restore-øvelser: `backup-status.json` via `apps/api/src/backup-status.ts` (WP-C2; ubetrodd fil, lukket skjema, kun KODER og tall);
 *  - runbooks: `operations_runbooks` (migrasjon 048; kun antall per kategori - tittel og innhold leses ALDRI);
 *  - planlagte jobber: `scheduler_state` (global driftstabell; kun jobbnavn og tidspunkt);
 *  - oppetid og kapasitet: prosessens starttidspunkt (injisert), `pg_postmaster_start_time()`, databasestørrelse og tilkoblinger fra systemkatalogen, jobbkøen (`tasks`).
 *
 * ÆRLIGHET: det som ikke kan måles står som `ikke målt` og er aldri «i orden». Spesielt: det finnes INGEN ekstern oppetidsovervåking (oppetid-prosent er ikke målt - kun prosess-/databasestart), API-containeren
 * kan ikke se vertens diskplass (ikke målt), og vakthunden kjører i worker-prosessen uten delt lagring (dens egne sjekker måles ikke herfra - kun via hendelsesprodusenten «watchdog»).
 * DEFERRED: handlinger (kjør backup, restart tjeneste, rydd artefakter) finnes kun som V5-forslag (`host_runbook`) som utføres på verten - ingen knapper her.
 */

/** Et åpent hendelse som har stått så lenge uten å bli løst er en advarsel i seg selv. */
export const INCIDENT_STALE_MS = 7 * DAY_MS;
/** Andel brukte databasetilkoblinger som gir advarsel / feil. */
export const CONNECTIONS_WARN_RATIO = 0.8;
export const CONNECTIONS_FAIL_RATIO = 0.95;
const JOB_LIST_LIMIT = 80;

// ---------------------------------------------------------------------------------------------------------------------
// Lesere (ekte SQL - bevist som app-rolle i wph2-operations-center-db.test.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface RunbookRead {
  by_category: Array<{ category: string; active: number; inactive: number; last_updated_at: string | null }>;
  health_space_count: number;
}

/** Kun antall per kategori/aktiv - `title` og `content` leses aldri. `health` er isolert og leses som ett antall i en EGEN lesing. */
export async function readRunbooks(pool: ControlCenterPool, tenantId: string): Promise<RunbookRead> {
  const main = await tenantSpaceRead(pool, tenantId, NON_HEALTH_SPACES, (query) => query(
    `SELECT category, (count(*) FILTER (WHERE is_active))::int AS active, (count(*) FILTER (WHERE NOT is_active))::int AS inactive, max(updated_at) AS last_updated_at
       FROM operations_runbooks WHERE tenant_id = $1 GROUP BY category ORDER BY category`, [tenantId]
  ));
  const health = await tenantSpaceRead(pool, tenantId, ["health"], (query) => query(`SELECT (count(*))::int AS n FROM operations_runbooks WHERE tenant_id = $1`, [tenantId]));
  return {
    by_category: main.map((r) => ({ category: safeCategory(r["category"]), active: toInt(r["active"]), inactive: toInt(r["inactive"]), last_updated_at: toIso(r["last_updated_at"]) })),
    health_space_count: toInt(health[0]?.["n"])
  };
}

/** Alle daglige jobber som har kjørt siste `JOB_WINDOW_DAYS` døgn (jobbnavn og tidspunkt - aldri tenantdata). Jobber som aldri har kjørt finnes ikke i tabellen og kan derfor ikke listes. */
export async function readAllJobs(pool: ControlCenterPool): Promise<JobRow[]> {
  const rows = await globalRows(pool,
    `SELECT job_name,
            max(completed_at) AS last_completed_at,
            (array_agg(completed_at IS NULL ORDER BY run_date DESC))[1] AS last_open,
            (array_agg(last_error IS NOT NULL ORDER BY run_date DESC))[1] AS last_had_error,
            (array_agg(attempts ORDER BY run_date DESC))[1] AS last_attempts
       FROM scheduler_state
      WHERE run_date >= current_date - ${JOB_WINDOW_DAYS}
      GROUP BY job_name ORDER BY job_name LIMIT ${JOB_LIST_LIMIT}`
  );
  return rows.map((r) => ({
    job_name: safeCategory(r["job_name"]),
    last_completed_at: toIso(r["last_completed_at"]),
    last_open: r["last_open"] === null || r["last_open"] === undefined ? null : Boolean(r["last_open"]),
    last_had_error: r["last_had_error"] === null || r["last_had_error"] === undefined ? null : Boolean(r["last_had_error"]),
    last_attempts: r["last_attempts"] === null || r["last_attempts"] === undefined ? null : toInt(r["last_attempts"])
  }));
}

export interface DatabaseCapacityRead { db_bytes: number; connections: number; max_connections: number; postmaster_started_at: string | null }

/** Systemkatalogen (ingen tabelldata): databasestørrelse, antall tilkoblinger (alle roller) mot `max_connections`, og når Postgres startet. */
export async function readDatabaseCapacity(pool: ControlCenterPool): Promise<DatabaseCapacityRead> {
  const rows = await globalRows(pool,
    `SELECT pg_database_size(current_database())::text AS db_bytes,
            (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS connections,
            current_setting('max_connections')::int AS max_connections,
            pg_postmaster_start_time() AS started_at`
  );
  const r = rows[0] ?? {};
  return { db_bytes: toInt(r["db_bytes"]), connections: toInt(r["connections"]), max_connections: toInt(r["max_connections"]), postmaster_started_at: toIso(r["started_at"]) };
}

export interface QueueCapacityRead { ready: number; running: number; queued: number }

export async function readQueueCapacity(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<QueueCapacityRead> {
  const rows = await tenantRead(pool, tenantId, (query) => query(
    `SELECT (count(*) FILTER (WHERE status = 'created' AND (not_before IS NULL OR not_before <= $2)))::int AS ready,
            (count(*) FILTER (WHERE status = 'running'))::int AS running,
            (count(*) FILTER (WHERE status = 'created'))::int AS queued
       FROM tasks WHERE tenant_id = $1`, [tenantId, new Date(nowMs)]
  ));
  const r = rows[0] ?? {};
  return { ready: toInt(r["ready"]), running: toInt(r["running"]), queued: toInt(r["queued"]) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Rene hjelpere
// ---------------------------------------------------------------------------------------------------------------------

const TARGET_STATUS: Readonly<Record<string, ControlStatus>> = { ok: "OK", degraded: "WARN", down: "FAIL", dormant: "OK", unknown: "UNKNOWN" };
const TARGET_STATE_NO: Readonly<Record<string, string>> = { ok: "i orden", degraded: "degradert", down: "NEDE", dormant: "sovende (ikke koblet inn)", unknown: "ikke målt" };
const SEVERITY_NO: Readonly<Record<string, string>> = { critical: "kritisk", high: "høy", normal: "vanlig", low: "lav" };
const SEVERITY_STATUS: Readonly<Record<string, ControlStatus>> = { critical: "FAIL", high: "WARN", normal: "WARN", low: "OK" };
const PRODUCER_STATUS: Readonly<Record<string, ControlStatus>> = { ok: "OK", failed: "WARN", stale: "WARN", skipped: "UNKNOWN", never_ran: "UNKNOWN", disabled: "UNKNOWN" };
const PRODUCER_STATE_NO: Readonly<Record<string, string>> = {
  ok: "kjører", failed: "feilet siste kjøring", stale: "har ikke kjørt på en stund", skipped: "hoppet over siste tikk", never_ran: "har aldri kjørt", disabled: "AV (automatisk oppdagelse er slått av)"
};
const RUNBOOK_CATEGORY_NO: Readonly<Record<string, string>> = {
  general: "generelle", vendor_escalation: "leverandøreskalering", incident_response: "hendelseshåndtering", onboarding: "onboarding", offboarding: "offboarding", maintenance: "vedlikehold"
};
const OBSERVATION_STATUS: Readonly<Record<string, ControlStatus>> = { OK: "OK", DEGRADED: "WARN", DOWN: "FAIL", UNKNOWN: "UNKNOWN" };

const bytesNo = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1).replace(".", ",")} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} MB` : `${Math.round(n / 1e3)} kB`);
const durationNo = (seconds: number): string => {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)} t`;
  return `${Math.round(hours / 24)} d`;
};

// ---------------------------------------------------------------------------------------------------------------------
// Senteret
// ---------------------------------------------------------------------------------------------------------------------

export interface OperationsCenterDeps {
  pool: ControlCenterPool;
  /** `ExecutiveService.getInfraStatus` (lat - tjenesten bygges etter sentrene). Kaster aldri for en enkeltkilde; kaster tjenesten likevel, blir hele hendelses-/mål-/produsentdelen ukjent. */
  infraStatus: (tenantId: string) => Promise<InfraStatusReport>;
  /** `backupStatusSourceFromEnv()` - `undefined` når `JARVIS_BACKUP_STATUS_FILE` ikke er satt (da er backup og restore-øvelser UKJENT, aldri «i orden»). */
  backupStatus?: () => Promise<BackupStatusRead>;
  /** Når API-prosessen startet. Uten den er prosess-oppetid ukjent. */
  processStartedAt?: () => Date;
  /** Taket for samtidige bakgrunnsjobber (samme som AI-/Agent-sentrene). Uten det er kø-kapasiteten kun et antall. */
  maxActiveJobs?: number;
}

export function createOperationsCenter(deps: OperationsCenterDeps): ControlCenterDefinition {
  return {
    id: "operations",
    title_no: "Drift",
    description_no: "Hendelser, skymål og produsenter, runbooks, backup, restore-øvelser, planlagte jobber, oppetid og kapasitet - kun lesing, med det som ikke kan måles sagt rett ut",
    async build(ctx: ControlCenterBuildContext): Promise<ControlCenterParts> {
      const nowMs = ctx.now.getTime();
      const nowIso = ctx.now.toISOString();
      const tenantId = ctx.identity.tenant_id;
      const rel = (iso: string | null | undefined): string => relativeNo(iso, nowMs);
      const failed = (r: Settled<unknown>): string => (r.ok ? "" : ` (${r.category})`);

      const [infraR, backupR, runbooksR, jobsR, dbR, queueR] = await Promise.all([
        settle(() => deps.infraStatus(tenantId)),
        deps.backupStatus ? settle(() => deps.backupStatus!()) : Promise.resolve(null),
        settle(() => readRunbooks(deps.pool, tenantId)),
        settle(() => readAllJobs(deps.pool)),
        settle(() => readDatabaseCapacity(deps.pool)),
        settle(() => readQueueCapacity(deps.pool, tenantId, nowMs))
      ]);

      const sections: ControlSection[] = [];

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 1. Åpne hendelser (titler og bevistekst vises aldri)
      // -------------------------------------------------------------------------------------------------------------------------------------------
      const infra = infraR.ok ? infraR.value : null;
      if (infra !== null && infra.incidents !== null) {
        const inc = infra.incidents;
        const items: ControlItem[] = [];
        const bySeverity = new Map<string, number>();
        let verified = 0;
        let observed = 0;
        let claimed = 0;
        let oldestMs: number | null = null;
        for (const i of inc.active) {
          bySeverity.set(i.severity, (bySeverity.get(i.severity) ?? 0) + 1);
          verified += i.evidence.verified;
          observed += i.evidence.observed;
          claimed += i.evidence.claimed;
          const opened = Date.parse(i.opened_at);
          if (!Number.isNaN(opened) && (oldestMs === null || opened < oldestMs)) oldestMs = opened;
        }
        const critical = bySeverity.get("critical") ?? 0;
        const stale = oldestMs !== null && nowMs - oldestMs > INCIDENT_STALE_MS;
        items.push(controlItem({
          id: "open_total", label: "Åpne hendelser", status: inc.active_total === 0 ? (infra.auto_detection ? "OK" : "WARN") : critical > 0 ? "FAIL" : "WARN",
          detail_no: inc.active_total === 0
            ? (infra.auto_detection ? "Ingen åpne hendelser." : "Ingen åpne hendelser er REGISTRERT - men automatisk oppdagelse er AV, så det betyr kun at ingen er lagt inn manuelt.")
            : `${inc.active_total} åpne hendelser${inc.truncated ? ` (de ${inc.active.length} nyeste vises i fordelingen under)` : ""}${stale ? "; den eldste har stått åpen i over 7 døgn" : ""}.`,
          observed_at: oldestMs === null ? null : new Date(oldestMs).toISOString(),
          facts: { open_total: inc.active_total, listed: inc.active.length, truncated: inc.truncated, resolved_last_7d: inc.resolved_last_7d, auto_detection: infra.auto_detection }
        }));
        for (const sev of ["critical", "high", "normal", "low"]) {
          const n = bySeverity.get(sev) ?? 0;
          if (n === 0) continue;
          items.push(controlItem({ id: `severity:${sev}`, label: `Alvorlighet ${SEVERITY_NO[sev]}`, status: SEVERITY_STATUS[sev] ?? "WARN", detail_no: `${n} åpne hendelser med alvorlighet ${SEVERITY_NO[sev]}.`, facts: { severity: sev, count: n } }));
        }
        for (const [phase, n] of Object.entries(inc.by_phase).sort(([a], [b]) => a.localeCompare(b))) {
          if (n <= 0) continue;
          items.push(controlItem({ id: `phase:${safeCategory(phase)}`, label: `Fase: ${safeCategory(phase)}`, status: "OK", detail_no: `${n} hendelser i fasen.`, facts: { phase: safeCategory(phase), count: n } }));
        }
        items.push(controlItem({
          id: "evidence", label: "Bevisgrad (bekreftet / observert / påstått)", status: "OK",
          detail_no: `${verified} bekreftet, ${observed} observert (ikke bekreftet), ${claimed} påstått (ikke bevist) blant de viste hendelsene. Hendelsestitler og bevistekst vises aldri her.`,
          facts: { verified, observed, claimed }
        }));
        items.push(controlItem({
          id: "resolved_7d", label: "Løst siste 7 døgn", status: "OK", detail_no: `${inc.resolved_last_7d} hendelser er løst siste 7 døgn.`, facts: { resolved: inc.resolved_last_7d }
        }));
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "incidents", title_no: "Åpne hendelser", observed_at: nowIso, items,
          source: "ExecutiveService.getInfraStatus → incidents (modules/incidents, tenant-RLS; kun antall, fase, alvorlighet og bevisgrad - aldri titler eller bevistekst)",
          summary_no: `${inc.active_total} åpne hendelser (${critical} kritiske)${infra.auto_detection ? "" : "; automatisk oppdagelse er AV"}. ${countsNo(items)}.`
        }));
      } else {
        sections.push(unknownControlSection("incidents", "Åpne hendelser", "ExecutiveService.getInfraStatus → incidents (modules/incidents, tenant-RLS)",
          infra === null ? `kunne ikke leses${failed(infraR)}` : "hendelseskilden kunne ikke leses (ikke målt - «ingen hendelser» kan ikke sies)"));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 2. Skymål og tjenester
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (infra !== null) {
        const items: ControlItem[] = infra.targets.map((t) => {
          const base = TARGET_STATUS[t.state] ?? "UNKNOWN";
          const badChange = t.last_change !== null && (t.last_change.outcome === "FAILED" || t.last_change.outcome === "PARTIAL");
          const status: ControlStatus = base === "OK" && badChange ? "WARN" : base;
          return controlItem({
            id: `target:${safeCategory(t.id)}`, label: t.label, status, observed_at: t.health?.at ?? null,
            detail_no: `${TARGET_STATE_NO[t.state] ?? "ikke målt"}${t.health ? `, helse målt ${rel(t.health.at)}` : ", ingen helsemåling"}${t.last_change ? `; siste journalførte endring ${rel(t.last_change.at)} (${t.last_change.outcome === "SUCCESS" ? "vellykket" : t.last_change.outcome === "FAILED" ? "FEILET" : t.last_change.outcome === "PARTIAL" ? "delvis" : "utfall ukjent"})` : "; ingen journalført endring"}.`,
            facts: {
              state: t.state, registered: t.registered, configured: t.configured, health_state: t.health?.state ?? null, health_at: t.health?.at ?? null,
              last_change_at: t.last_change?.at ?? null, last_change_outcome: t.last_change?.outcome ?? null
            }
          });
        });
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "targets", title_no: "Skymål og tjenester", observed_at: nowIso, items,
          source: "ExecutiveService.getInfraStatus → targets (ToolGateway.health i API-prosessen + infra_executions; kun tilstand og tidspunkt)",
          summary_no: `${items.length} kontrollerte mål: ${countsNo(items)}. Helse gjelder API-prosessen (workeren har sin egen).`
        }));
      } else {
        sections.push(unknownControlSection("targets", "Skymål og tjenester", "ExecutiveService.getInfraStatus → targets", `kunne ikke leses${failed(infraR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 3. Hendelsesprodusenter og vakthund
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (infra !== null) {
        const items: ControlItem[] = infra.producers.map((p) => controlItem({
          id: `producer:${safeCategory(p.producer)}`, label: `Produsent ${safeCategory(p.producer)}`, status: PRODUCER_STATUS[p.state] ?? "UNKNOWN", observed_at: p.last_started_at,
          detail_no: `${PRODUCER_STATE_NO[p.state] ?? "ukjent tilstand"}${p.last_started_at ? `; sist startet ${rel(p.last_started_at)}` : ""}${p.consecutive_failures > 0 ? `; ${p.consecutive_failures} feil på rad` : ""}.`,
          facts: { state: p.state, last_started_at: p.last_started_at, age_s: p.age_s, consecutive_failures: p.consecutive_failures, opened: p.opened, resolved: p.resolved }
        }));
        items.push(controlItem({
          id: "watchdog_direct", label: "Vakthundens egne sjekker", status: "UNKNOWN",
          detail_no: "IKKE målt herfra: vakthunden kjører i worker-prosessen uten delt lagring med API-et. Det som sees er hendelsene den åpner via produsenten «watchdog» (hvis den er med i listen over).",
          facts: { measured: false }
        }));
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "producers", title_no: "Hendelsesprodusenter og vakthund", observed_at: nowIso, items,
          source: "ExecutiveService.getInfraStatus → producers (incident_producer_runs; feiltekst vises aldri) + Limitation Registry (vakthund i worker)",
          summary_no: `${infra.producers.length} produsenter. ${infra.auto_detection ? "Automatisk oppdagelse er PÅ." : "Automatisk oppdagelse er AV: hendelser oppdages ikke av systemet selv."} ${countsNo(items)}.`
        }));
      } else {
        sections.push(unknownControlSection("producers", "Hendelsesprodusenter og vakthund", "ExecutiveService.getInfraStatus → producers", `kunne ikke leses${failed(infraR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 4. Backup  og 5. Restore-øvelser (samme kilde: backup-status.json)
      // -------------------------------------------------------------------------------------------------------------------------------------------
      const backupSource = "backup-status.json (ops/backup/schedule.mjs; montert skrivebeskyttet; ubetrodd fil, lukket skjema - kun koder, tall og tidspunkt)";
      let snapshot: BackupStatusSnapshot | null = null;
      if (backupR === null) {
        const why = "JARVIS_BACKUP_STATUS_FILE er ikke satt - API-containeren har ikke backup-statusfilen, så backup og restore-øvelser er IKKE målt (aldri «i orden»)";
        sections.push(unknownControlSection("backups", "Backup", backupSource, why));
        sections.push(unknownControlSection("restore_drills", "Restore-øvelser", backupSource, why));
      } else if (!backupR.ok) {
        sections.push(unknownControlSection("backups", "Backup", backupSource, `kunne ikke leses${failed(backupR)}`));
        sections.push(unknownControlSection("restore_drills", "Restore-øvelser", backupSource, `kunne ikke leses${failed(backupR)}`));
      } else {
        const obs = observeBackupStatus(backupR.value, ctx.now);
        if (backupR.value.kind === "ok") snapshot = backupR.value.snapshot;
        if (snapshot === null) {
          sections.push(unknownControlSection("backups", "Backup", backupSource, obs.detail));
          sections.push(unknownControlSection("restore_drills", "Restore-øvelser", backupSource, obs.detail));
        } else {
          const s = snapshot;
          const items: ControlItem[] = [];
          items.push(controlItem({
            id: "overall", label: "Samlet backup-vurdering", status: OBSERVATION_STATUS[obs.status] ?? "UNKNOWN", observed_at: obs.observed_at,
            detail_no: obs.detail,
            facts: { backup_age_hours: typeof obs.data?.["backup_age_hours"] === "number" ? obs.data["backup_age_hours"] : null, status_age_hours: typeof obs.data?.["status_age_hours"] === "number" ? obs.data["status_age_hours"] : null }
          }));
          items.push(controlItem({
            id: "backup_set", label: "Siste backup-sett", status: s.backup.state === "ok" ? "OK" : s.backup.state === "failing" ? "WARN" : "UNKNOWN", observed_at: s.backup.last_set_at,
            detail_no: s.backup.last_set_at ? `Siste sett ${rel(s.backup.last_set_at)} (${s.backup.size_bytes === null ? "ukjent størrelse" : bytesNo(s.backup.size_bytes)}); ${s.backup.sets_on_disk} sett på disk; intervall ${s.backup.interval_hours} t${s.backup.consecutive_failures > 0 ? `; ${s.backup.consecutive_failures} mislykkede forsøk på rad` : ""}.` : "Ingen komplett backup-sett er registrert.",
            facts: { state: s.backup.state, last_set_at: s.backup.last_set_at, size_bytes: s.backup.size_bytes, sets_on_disk: s.backup.sets_on_disk, interval_hours: s.backup.interval_hours, next_due_at: s.backup.next_due_at, consecutive_failures: s.backup.consecutive_failures, last_error_code: s.backup.last_error_code }
          }));
          items.push(controlItem({
            id: "offsite", label: "Off-site-kopi", status: s.offsite.state === "ok" ? "OK" : s.offsite.state === "failed" || s.offsite.state === "not_configured" ? "WARN" : "UNKNOWN", observed_at: s.offsite.last_success_at,
            detail_no: s.offsite.state === "not_configured" ? "INGEN off-site-kopi er satt opp (kun lokal backup)." : s.offsite.state === "pending" ? "Off-site er satt opp, men ingen kopi er bekreftet ennå." : s.offsite.state === "failed" ? `Off-site-kopi feilet (${s.offsite.consecutive_failures} på rad).` : `Siste vellykkede off-site-kopi ${rel(s.offsite.last_success_at)}${s.offsite.verification === "size_only" ? " (kun størrelse verifisert)" : ""}.`,
            facts: { state: s.offsite.state, adapter: s.offsite.adapter, last_success_at: s.offsite.last_success_at, last_verified_at: s.offsite.last_verified_at, verification: s.offsite.verification, consecutive_failures: s.offsite.consecutive_failures, last_error_code: s.offsite.last_error_code }
          }));
          items.push(controlItem({
            id: "heartbeat", label: "Ekstern heartbeat (dead-man's switch)", status: !s.heartbeat.configured ? "UNKNOWN" : s.heartbeat.last_ping_ok === false ? "WARN" : s.heartbeat.last_ping_ok === true ? "OK" : "UNKNOWN", observed_at: s.heartbeat.last_ping_at,
            detail_no: !s.heartbeat.configured ? "Ekstern heartbeat er ikke satt opp - stillhet fra backup-skriptet varsles ikke utenfra." : s.heartbeat.last_ping_ok === false ? "Siste heartbeat feilet." : s.heartbeat.last_ping_ok === true ? `Siste heartbeat OK ${rel(s.heartbeat.last_ping_at)}.` : "Ingen heartbeat er sendt ennå.",
            facts: { configured: s.heartbeat.configured, last_ping_at: s.heartbeat.last_ping_at, last_ping_ok: s.heartbeat.last_ping_ok, last_ping_kind: s.heartbeat.last_ping_kind }
          }));
          items.sort(bySeverityThenLabel);
          sections.push(controlSection({
            id: "backups", title_no: "Backup", observed_at: obs.observed_at ?? nowIso, items, source: backupSource,
            summary_no: `Backup: ${obs.status === "OK" ? "i orden" : obs.status === "DEGRADED" ? "advarsel" : obs.status === "DOWN" ? "NEDE" : "ikke målt"} (${s.backup.sets_on_disk} sett på disk). ${countsNo(items)}.`
          }));

          const v = s.restore_verify;
          const ageDays = v.last_success_at === null ? null : (nowMs - Date.parse(v.last_success_at)) / DAY_MS;
          const overdue = ageDays !== null && ageDays > 2 * v.interval_days;
          const drillStatus: ControlStatus = v.state === "failed" ? "WARN" : v.state === "ok" ? (overdue ? "WARN" : "OK") : "UNKNOWN";
          const drillItems: ControlItem[] = [
            controlItem({
              id: "restore_verify", label: "Siste restore-verifisering", status: drillStatus, observed_at: v.last_success_at ?? v.last_attempt_at,
              detail_no: v.state === "ok"
                ? `Siste vellykkede restore-verifisering ${rel(v.last_success_at)} (${v.tables ?? "?"} tabeller, ${v.rows ?? "?"} rader${v.duration_s === null ? "" : `, ${durationNo(v.duration_s)}`}; kilde ${v.source ?? "ukjent"}${v.reported_by === "external_verifier" ? ", meldt av ekstern verifiserer" : ""})${overdue ? ` - eldre enn 2 × intervallet (${v.interval_days} d): backupen er ikke nylig bevist gjenopprettbar` : ""}.`
                : v.state === "failed" ? `Siste restore-verifisering FEILET (${v.consecutive_failures} på rad) - backupen er ikke bevist gjenopprettbar.`
                  : v.state === "never_run" ? "Restore er aldri verifisert - en backup som aldri er gjenopprettet er ikke bevist." : "Restore-verifisering er ikke satt opp - backupen er ikke bevist gjenopprettbar.",
              facts: { state: v.state, last_success_at: v.last_success_at, last_attempt_at: v.last_attempt_at, interval_days: v.interval_days, tables: v.tables, rows: v.rows, duration_s: v.duration_s, fetch_duration_s: v.fetch_duration_s, source: v.source, reported_by: v.reported_by, consecutive_failures: v.consecutive_failures, last_error_code: v.last_error_code }
            })
          ];
          sections.push(controlSection({
            id: "restore_drills", title_no: "Restore-øvelser", observed_at: obs.observed_at ?? nowIso, items: drillItems, source: backupSource,
            summary_no: `Restore-verifisering: ${v.state === "ok" ? "vellykket" : v.state === "failed" ? "FEILET" : v.state === "never_run" ? "aldri kjørt" : "ikke satt opp"}${v.last_success_at ? `, sist ${rel(v.last_success_at)}` : ""}. Å kjøre en øvelse skjer på verten (ops/backup), ikke herfra (DEFERRED).`
          }));
        }
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 6. Runbooks (operations_runbooks: kun antall)
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (runbooksR.ok) {
        const v = runbooksR.value;
        const items: ControlItem[] = v.by_category.map((c) => controlItem({
          id: `category:${c.category}`, label: `Runbooks: ${RUNBOOK_CATEGORY_NO[c.category] ?? c.category}`, status: "OK", observed_at: c.last_updated_at,
          detail_no: `${c.active} aktive og ${c.inactive} inaktive; sist endret ${rel(c.last_updated_at)}. Tittel og innhold vises aldri.`,
          facts: { category: c.category, active: c.active, inactive: c.inactive, last_updated_at: c.last_updated_at }
        }));
        const incidentActive = v.by_category.find((c) => c.category === "incident_response")?.active ?? 0;
        items.push(controlItem({
          id: "incident_response_coverage", label: "Runbook for hendelseshåndtering", status: incidentActive > 0 ? "OK" : "WARN",
          detail_no: incidentActive > 0 ? `${incidentActive} aktive runbooks for hendelseshåndtering finnes.` : "Ingen AKTIV runbook for hendelseshåndtering er registrert - en hendelse har ingen skriftlig prosedyre å følge.",
          facts: { active: incidentActive }
        }));
        if (v.health_space_count > 0) {
          items.push(controlItem({ id: "health_space", label: "Runbooks i health-rommet", status: "OK", detail_no: `${v.health_space_count} (isolert rom: kun antall, aldri listet).`, facts: { count: v.health_space_count } }));
        }
        items.sort(bySeverityThenLabel);
        const active = v.by_category.reduce((a, c) => a + c.active, 0);
        sections.push(controlSection({
          id: "runbooks", title_no: "Runbooks", observed_at: nowIso, items,
          source: "operations_runbooks (migrasjon 048; tenant + minnerom-RLS; kun antall per kategori - tittel og innhold leses aldri)",
          summary_no: `${active} aktive runbooks. Kjøring av en runbook spores ikke (ikke målt); V5 foreslår driftshandlinger som utføres på verten.`
        }));
      } else {
        sections.push(unknownControlSection("runbooks", "Runbooks", "operations_runbooks (tenant + minnerom-RLS)", `kunne ikke leses${failed(runbooksR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 7. Planlagte jobber
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (jobsR.ok) {
        // Gjennomgang M2 (H2): går rapporten til en SKYmodell (`restrictFinance`), utelates finansdomenets daglige jobber (navn og tilstand er finansavledet) - FØR seksjonen bygges, så tellinger og sammendrag ikke bærer dem.
        const rows = ctx.restrictFinance === true ? jobsR.value.filter((row) => !isFinanceJobName(row.job_name)) : jobsR.value;
        const items: ControlItem[] = rows.map((row) => {
          const st = jobState(row, nowMs);
          return controlItem({
            id: `job:${row.job_name}`, label: row.job_name, status: st.status, observed_at: st.last_completed_at,
            detail_no: st.detail_no, facts: { last_completed_at: st.last_completed_at, lag_hours: st.lag_hours, last_open: row.last_open, last_had_error: row.last_had_error, last_attempts: row.last_attempts }
          });
        });
        items.sort(bySeverityThenLabel);
        if (items.length === 0) {
          sections.push(unknownControlSection("jobs", "Planlagte jobber", "scheduler_state (DailyScheduler, siste 14 døgn)", "ingen kjøringer registrert siste 14 døgn - planleggeren har ingen beviselig aktivitet (ikke målt)"));
        } else {
          sections.push(controlSection({
            id: "jobs", title_no: "Planlagte jobber", observed_at: nowIso, items,
            source: "scheduler_state (DailyScheduler, global driftstabell, siste 14 døgn; kun jobbnavn og tidspunkt). Jobber som aldri har kjørt finnes ikke i tabellen og kan ikke listes",
            summary_no: `${items.length} daglige jobber har kjørt siste 14 døgn. ${countsNo(items)}.`
          }));
        }
      } else {
        sections.push(unknownControlSection("jobs", "Planlagte jobber", "scheduler_state (DailyScheduler)", `kunne ikke leses${failed(jobsR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 8. Oppetid
      // -------------------------------------------------------------------------------------------------------------------------------------------
      {
        const items: ControlItem[] = [];
        const started = deps.processStartedAt?.() ?? null;
        items.push(started === null
          ? controlItem({ id: "api_process", label: "API-prosessen", status: "UNKNOWN", detail_no: "Starttidspunktet er ikke koblet inn - prosess-oppetid er IKKE målt.", facts: { measured: false } })
          : controlItem({
            id: "api_process", label: "API-prosessen", status: "OK", observed_at: started.toISOString(),
            detail_no: `API-prosessen startet ${rel(started.toISOString())} (oppe i ${durationNo(Math.max(0, (nowMs - started.getTime()) / 1000))}).`,
            facts: { started_at: started.toISOString(), uptime_s: Math.max(0, Math.round((nowMs - started.getTime()) / 1000)) }
          }));
        if (dbR.ok && dbR.value.postmaster_started_at !== null) {
          const up = Math.max(0, (nowMs - Date.parse(dbR.value.postmaster_started_at)) / 1000);
          items.push(controlItem({
            id: "database", label: "Databasen (Postgres)", status: "OK", observed_at: dbR.value.postmaster_started_at,
            detail_no: `Postgres startet ${rel(dbR.value.postmaster_started_at)} (oppe i ${durationNo(up)}).`, facts: { started_at: dbR.value.postmaster_started_at, uptime_s: Math.round(up) }
          }));
        } else {
          items.push(controlItem({ id: "database", label: "Databasen (Postgres)", status: "UNKNOWN", detail_no: `Starttidspunktet kunne ikke leses${failed(dbR)}.`, facts: { measured: false } }));
        }
        items.push(controlItem({
          id: "availability", label: "Tilgjengelighet over tid (prosent)", status: "UNKNOWN",
          detail_no: "IKKE målt: ingen ekstern oppetidsovervåking er koblet inn. Kun prosess- og databasestart vises; en ekstern heartbeat (se Backup) varsler kun om stillhet fra backup-skriptet.",
          facts: { measured: false }
        }));
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "uptime", title_no: "Oppetid", observed_at: nowIso, items,
          source: "prosessens starttidspunkt (injisert) + pg_postmaster_start_time() (systemkatalogen)",
          summary_no: `Oppetid-prosent er ikke målt (ingen ekstern overvåking). ${countsNo(items)}.`
        }));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 9. Kapasitet
      // -------------------------------------------------------------------------------------------------------------------------------------------
      {
        const items: ControlItem[] = [];
        if (dbR.ok) {
          const d = dbR.value;
          const ratio = d.max_connections > 0 ? d.connections / d.max_connections : null;
          items.push(controlItem({
            id: "database_size", label: "Databasestørrelse", status: "OK", detail_no: `${bytesNo(d.db_bytes)}. Ingen kapasitetsterskel er satt for databasestørrelsen (kun tall).`, facts: { db_bytes: d.db_bytes }
          }));
          items.push(controlItem({
            id: "connections", label: "Databasetilkoblinger", status: ratio === null ? "UNKNOWN" : ratio >= CONNECTIONS_FAIL_RATIO ? "FAIL" : ratio >= CONNECTIONS_WARN_RATIO ? "WARN" : "OK",
            detail_no: ratio === null ? "Maks antall tilkoblinger er ukjent." : `${d.connections} av ${d.max_connections} tilkoblinger er i bruk (${Math.round(ratio * 100)} %). Advarsel fra ${Math.round(CONNECTIONS_WARN_RATIO * 100)} %, feil fra ${Math.round(CONNECTIONS_FAIL_RATIO * 100)} %.`,
            facts: { connections: d.connections, max_connections: d.max_connections }
          }));
        } else {
          items.push(controlItem({ id: "database_size", label: "Databasestørrelse", status: "UNKNOWN", detail_no: `Kunne ikke leses${failed(dbR)}.`, facts: { measured: false } }));
          items.push(controlItem({ id: "connections", label: "Databasetilkoblinger", status: "UNKNOWN", detail_no: `Kunne ikke leses${failed(dbR)}.`, facts: { measured: false } }));
        }
        if (queueR.ok) {
          const q = queueR.value;
          const cap = deps.maxActiveJobs;
          const atCap = cap !== undefined && q.running >= cap;
          items.push(controlItem({
            id: "job_queue", label: "Jobbkø og samtidighet", status: atCap ? "WARN" : "OK",
            detail_no: `${q.running} kjørende${cap !== undefined ? ` av høyst ${cap}` : ""}, ${q.ready} klare i kø (${q.queued} ikke startet totalt).${atCap ? " Taket for samtidige jobber er nådd - nye jobber venter." : ""}`,
            facts: { running: q.running, ready: q.ready, queued: q.queued, max_active_jobs: cap ?? null }
          }));
        } else {
          items.push(controlItem({ id: "job_queue", label: "Jobbkø og samtidighet", status: "UNKNOWN", detail_no: `Kunne ikke leses${failed(queueR)}.`, facts: { measured: false } }));
        }
        if (snapshot !== null && snapshot.backup.size_bytes !== null) {
          items.push(controlItem({
            id: "backup_footprint", label: "Backup-fotavtrykk", status: "OK",
            detail_no: `Siste sett er ${bytesNo(snapshot.backup.size_bytes)}; ${snapshot.backup.sets_on_disk} sett ligger på backup-disken.`, facts: { last_set_bytes: snapshot.backup.size_bytes, sets_on_disk: snapshot.backup.sets_on_disk }
          }));
        }
        items.push(controlItem({
          id: "disk_free", label: "Ledig diskplass (NAS)", status: "UNKNOWN",
          detail_no: "IKKE målt: API-containeren har ikke tilgang til vertens volumer. Kontroller diskplassen på NAS-en (backup-disken og database-volumet) selv.", facts: { measured: false }
        }));
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "capacity", title_no: "Kapasitet", observed_at: nowIso, items,
          source: "pg_database_size / pg_stat_activity / max_connections (systemkatalogen) + tasks (tenant-RLS) + backup-status.json. Diskplass på verten er ikke målbar herfra",
          summary_no: `${countsNo(items)}. Ledig diskplass på NAS-en er ikke målt.`
        }));
      }

      return { sections, actions: [] };
    }
  };
}

// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import {
  controlItem, controlSection, unknownControlSection,
  type ControlAction, type ControlCenterBuildContext, type ControlCenterDefinition, type ControlCenterParts, type ControlItem, type ControlSection, type ControlStatus
} from "@jarvis/executive";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { QUEUED_STALE_MS, activeTaskRows, profileNo, readActiveTasks } from "./agents.ts";
import { DAY_MS, HOUR_MS, bySeverityThenLabel, countsNo, mergeBy, relativeNo, safeCategory, settle, tenantRead, toInt, toIso, type ControlCenterPool, type Settled } from "./shared.ts";

/**
 * WP-H1 (UA-11 Admin Control Center, masterplan v4.0 kap. 21) - AGENT CENTER: workere, jobber, leaser, artefakter, forsøk på nytt, avbrytelser og nettverksomfang - og dekningen av ALLE kjørende
 * agenter og jobber (JARVIS-087 del 2: AI Center viste kun de 50 første; dette senteret viser opptil 200 og sier ifra om resten).
 *
 * Kun LESING av `tasks`, `artifacts` og `audit_events` (tenant-RLS) - ingen nye eksterne kall, ingen skriving, ingen kall til jobb-runneren på verten. Radene bruker den DELTE leseren/radbyggeren i
 * `agents.ts` (`readActiveTasks`/`activeTaskRows`) slik at AI Center og Agent Center aldri viser samme jobb med to ulike knapper. Den ENESTE handlingen er den eksisterende avbryt-handlingen
 * (`executive.cancel_task` på `/executive/mutate`, eier-kun, klasse B, ingen step-up - en stopp-handling).
 *
 * INNHOLDSVERN: `tasks.goal` (jobbtittelen), `result`, `checkpoint`, `last_error`-TEKSTEN, artefaktnavn/-innhold og nettverksmålene (vertsnavn) leses ALDRI - kun status, antall, tidsstempler, forsøk,
 * lease, agentprofil, antall nettverksmål, artefaktart og bytemengde. En jobb kan være skrevet av en modell som har lest ubetrodd innhold; tittelen står i chatten (`/chat/jobs`).
 *
 * ÆRLIGHET OM WORKERE: det finnes INGEN worker-hjerteslag. En worker er «bevist i live» kun av en nylig claim (siste 24 t) eller en kjørende jobb med fornyet lease; uten aktivitet er worker-helse
 * `ikke målt` (en ledig worker kan ikke skilles fra en stoppet). Jobb-runneren på verten (WP-C1) kalles ikke herfra: dens tilstand utledes kun av kodejobbenes utfall (`host_job_runner_error:`-feil).
 * DEFERRED: faktisk nettverksisolasjon (container/egress-proxy) måles av `ops/job-runner/acceptance.sh` på verten, ikke herfra.
 */

/** Maks antall aktive jobber som vises som rader (resten telles og sies ifra om). */
export const AGENT_CENTER_MAX_ACTIVE_ROWS = 200;
/** Claim siste så lenge regnes som bevis på at en worker lever. */
export const WORKER_EVIDENCE_WINDOW_MS = 24 * HOUR_MS;
/** Feilprefiksene jobb-runner-klienten bruker (`host_job_runner_error:<kategori>`, `job_container_runner_not_configured:...`) - kun prefikset leses, aldri resten av teksten. */
export const RUNNER_ERROR_PREFIX_SQL = "^(host_job_runner_error|job_container_runner_not_configured)";
const WORKER_LIST_LIMIT = 20;

/**
 * Gjennomgang M3: artefaktmengden måles i BYTE med `octet_length(content)`, ikke tegn med `length(content)`. `length` på en stor, TOAST-lagret tekst må hente og dekomprimere HELE innholdet for hver rad (målt av
 * reviewer: 60 x 4 MB = 0,82-0,89 s og 31 500 buffere per kall, lineært i datamengden, gjentatt ved hver sideoppfriskning mens registerets tidsavbrudd ikke avbryter spørringen); `octet_length` leser lengden fra
 * TOAST-pekeren uten å røre innholdet (0,07 ms, noen få buffere). Navnene er eksportert så plan-/bufferveggen i `wph1-agent-center-db.test.ts` kjører NØYAKTIG disse spørringene.
 */
export const ARTIFACT_TOTALS_SQL = `SELECT (count(*))::int AS total, (coalesce(sum(octet_length(content)), 0))::text AS bytes FROM artifacts WHERE tenant_id = $1`;
export const ARTIFACT_KINDS_SQL = `SELECT kind, (count(*))::int AS n, (coalesce(sum(octet_length(content)), 0))::text AS bytes, max(created_at) AS last_at FROM artifacts WHERE tenant_id = $1 AND created_at >= $2 GROUP BY kind ORDER BY kind LIMIT 30`;

/** «1,5 MiB»-aktig visning av en bytemengde (norsk desimalkomma). */
export function bytesNo(n: number): string {
  const fmt = (v: number, unit: string): string => `${v.toFixed(1).replace(".", ",")} ${unit}`;
  if (n < 1024) return `${n} byte`;
  if (n < 1024 ** 2) return fmt(n / 1024, "KiB");
  if (n < 1024 ** 3) return fmt(n / 1024 ** 2, "MiB");
  return fmt(n / 1024 ** 3, "GiB");
}

export interface AgentAggregates {
  queue: { queued: number; ready: number; in_backoff: number; oldest_ready_at: string | null; paused: number };
  running: number;
  leases: { renewed_ok: number; expired: number };
  last_claim_any_at: string | null;
  retries: { retrying: number; failed_7d: number; abandoned_7d: number; exhausted_7d: number };
  cancellations: { stop_pending: number; cancelled_24h: number; audit_7d: number; last_audit_at: string | null };
  network: { jobs_with_network: number; targets: number };
  runner: { coding_7d: number; coding_completed_7d: number; errors_7d: number; last_error_at: string | null };
  by_profile: Array<{ profile: string; status: string; n: number }>;
  workers: Array<{ worker_id: string; running: number; expired: number; last_claim_at: string | null; soonest_lease_at: string | null }>;
  artifacts: { total: number; bytes: number; recent_by_kind: Array<{ kind: string; n: number; bytes: number; last_at: string | null }> };
}

const laterIso = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : Date.parse(a) >= Date.parse(b) ? a : b);
const earlierIso = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : Date.parse(a) <= Date.parse(b) ? a : b);

/** Alle tellerne i én tenant-skopet lesing (RLS). Aggregater - aldri en rad med innhold. */
export async function readAgentAggregates(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<AgentAggregates> {
  const now = new Date(nowMs);
  const d7 = new Date(nowMs - 7 * DAY_MS);
  const d1 = new Date(nowMs - DAY_MS);
  return tenantRead(pool, tenantId, async (query) => {
    const t = (await query(
      `SELECT
         (count(*) FILTER (WHERE status = 'created'))::int AS queued,
         (count(*) FILTER (WHERE status = 'created' AND (not_before IS NULL OR not_before <= $2)))::int AS ready,
         (count(*) FILTER (WHERE status = 'created' AND not_before > $2))::int AS in_backoff,
         min(created_at) FILTER (WHERE status = 'created' AND (not_before IS NULL OR not_before <= $2)) AS oldest_ready_at,
         (count(*) FILTER (WHERE status = 'paused'))::int AS paused,
         (count(*) FILTER (WHERE status = 'running'))::int AS running,
         (count(*) FILTER (WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at >= $2))::int AS renewed_ok,
         (count(*) FILTER (WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < $2)))::int AS lease_expired,
         max(claimed_at) AS last_claim_any_at,
         (count(*) FILTER (WHERE status IN ('created', 'running') AND attempts > 1))::int AS retrying,
         (count(*) FILTER (WHERE status = 'failed' AND coalesce(finished_at, created_at) >= $3))::int AS failed_7d,
         (count(*) FILTER (WHERE status = 'failed' AND coalesce(finished_at, created_at) >= $3 AND last_error LIKE 'lease_expired_claims_exhausted:%'))::int AS abandoned_7d,
         (count(*) FILTER (WHERE status = 'failed' AND coalesce(finished_at, created_at) >= $3
            AND attempts >= (CASE WHEN contract->'retry_policy'->>'max_attempts' ~ '^[0-9]{1,4}$' THEN (contract->'retry_policy'->>'max_attempts')::int ELSE 1 END)))::int AS exhausted_7d,
         (count(*) FILTER (WHERE status = 'running' AND cancel_requested))::int AS stop_pending,
         (count(*) FILTER (WHERE status = 'cancelled' AND coalesce(finished_at, created_at) >= $4))::int AS cancelled_24h,
         (count(*) FILTER (WHERE status IN ('created', 'running', 'paused')
            AND (CASE WHEN jsonb_typeof(contract->'allowed_network_targets') = 'array' THEN jsonb_array_length(contract->'allowed_network_targets') ELSE 0 END) > 0))::int AS jobs_with_network,
         (coalesce(sum(CASE WHEN status IN ('created', 'running', 'paused') AND jsonb_typeof(contract->'allowed_network_targets') = 'array' THEN jsonb_array_length(contract->'allowed_network_targets') ELSE 0 END), 0))::int AS network_targets,
         (count(*) FILTER (WHERE contract->>'agent_profile' = 'coding' AND created_at >= $3))::int AS coding_7d,
         (count(*) FILTER (WHERE contract->>'agent_profile' = 'coding' AND created_at >= $3 AND status = 'completed'))::int AS coding_completed_7d,
         (count(*) FILTER (WHERE created_at >= $3 AND last_error ~ '${RUNNER_ERROR_PREFIX_SQL}'))::int AS runner_errors_7d,
         max(coalesce(finished_at, created_at)) FILTER (WHERE created_at >= $3 AND last_error ~ '${RUNNER_ERROR_PREFIX_SQL}') AS last_runner_error_at
       FROM tasks WHERE tenant_id = $1`,
      [tenantId, now, d7, d1]
    ))[0] ?? {};
    const profiles = await query(
      `SELECT coalesce(contract->>'agent_profile', 'ukjent') AS profile, status, (count(*))::int AS n FROM tasks
        WHERE tenant_id = $1 AND status IN ('created', 'running', 'paused') GROUP BY 1, 2 ORDER BY 1, 2`, [tenantId]
    );
    const workers = await query(
      `SELECT worker_id, (count(*))::int AS running, (count(*) FILTER (WHERE lease_expires_at IS NULL OR lease_expires_at < $2))::int AS expired,
              max(claimed_at) AS last_claim_at, min(lease_expires_at) AS soonest_lease_at
         FROM tasks WHERE tenant_id = $1 AND status = 'running' GROUP BY worker_id ORDER BY worker_id LIMIT ${WORKER_LIST_LIMIT}`, [tenantId, now]
    );
    const artifactTotals = (await query(ARTIFACT_TOTALS_SQL, [tenantId]))[0] ?? {};
    const artifactKinds = await query(ARTIFACT_KINDS_SQL, [tenantId, d7]);
    const audit = (await query(`SELECT (count(*))::int AS n, max(at) AS last_at FROM audit_events WHERE tenant_id = $1 AND type = 'task.cancelled' AND at >= $2`, [tenantId, d7]))[0] ?? {};
    return {
      queue: { queued: toInt(t["queued"]), ready: toInt(t["ready"]), in_backoff: toInt(t["in_backoff"]), oldest_ready_at: toIso(t["oldest_ready_at"]), paused: toInt(t["paused"]) },
      running: toInt(t["running"]),
      leases: { renewed_ok: toInt(t["renewed_ok"]), expired: toInt(t["lease_expired"]) },
      last_claim_any_at: toIso(t["last_claim_any_at"]),
      retries: { retrying: toInt(t["retrying"]), failed_7d: toInt(t["failed_7d"]), abandoned_7d: toInt(t["abandoned_7d"]), exhausted_7d: toInt(t["exhausted_7d"]) },
      cancellations: { stop_pending: toInt(t["stop_pending"]), cancelled_24h: toInt(t["cancelled_24h"]), audit_7d: toInt(audit["n"]), last_audit_at: toIso(audit["last_at"]) },
      network: { jobs_with_network: toInt(t["jobs_with_network"]), targets: toInt(t["network_targets"]) },
      runner: { coding_7d: toInt(t["coding_7d"]), coding_completed_7d: toInt(t["coding_completed_7d"]), errors_7d: toInt(t["runner_errors_7d"]), last_error_at: toIso(t["last_runner_error_at"]) },
      by_profile: mergeBy(
        profiles.map((r) => ({ profile: safeCategory(r["profile"]), status: safeCategory(r["status"]), n: toInt(r["n"]) })),
        (p) => `${p.profile}\u0000${p.status}`, (a, b) => ({ ...a, n: a.n + b.n })
      ),
      workers: mergeBy(
        workers.map((r) => ({ worker_id: safeCategory(r["worker_id"]), running: toInt(r["running"]), expired: toInt(r["expired"]), last_claim_at: toIso(r["last_claim_at"]), soonest_lease_at: toIso(r["soonest_lease_at"]) })),
        (w) => w.worker_id,
        (a, b) => ({ worker_id: a.worker_id, running: a.running + b.running, expired: a.expired + b.expired, last_claim_at: laterIso(a.last_claim_at, b.last_claim_at), soonest_lease_at: earlierIso(a.soonest_lease_at, b.soonest_lease_at) })
      ),
      artifacts: {
        total: toInt(artifactTotals["total"]), bytes: toInt(artifactTotals["bytes"]),
        recent_by_kind: mergeBy(
          artifactKinds.map((r) => ({ kind: safeCategory(r["kind"]), n: toInt(r["n"]), bytes: toInt(r["bytes"]), last_at: toIso(r["last_at"]) })),
          (k) => k.kind, (a, b) => ({ kind: a.kind, n: a.n + b.n, bytes: a.bytes + b.bytes, last_at: laterIso(a.last_at, b.last_at) })
        )
      }
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Senteret
// ---------------------------------------------------------------------------------------------------------------------

export interface AgentCenterDeps {
  pool: ControlCenterPool;
  /** Risikoklassen til avbryt-handlingen leses fra verktøydefinisjonen (aldri en kopi). */
  toolGateway: Pick<ToolGateway, "get">;
}

export function createAgentCenter(deps: AgentCenterDeps): ControlCenterDefinition {
  return {
    id: "agent",
    title_no: "Agenter",
    description_no: "Alle kjørende og ventende agenter/jobber, workere, leaser, forsøk på nytt, avbrytelser, artefakter og nettverksomfang - med avbryt-knapp (den eksisterende)",
    async build(ctx: ControlCenterBuildContext): Promise<ControlCenterParts> {
      const nowMs = ctx.now.getTime();
      const nowIso = ctx.now.toISOString();
      const tenantId = ctx.identity.tenant_id;
      const rel = (iso: string | null | undefined): string => relativeNo(iso, nowMs);
      const failed = (r: Settled<unknown>): string => (r.ok ? "" : ` (${r.category})`);

      const [aggR, rowsR] = await Promise.all([
        settle(() => readAgentAggregates(deps.pool, tenantId, nowMs)),
        settle(() => readActiveTasks(deps.pool, tenantId, AGENT_CENTER_MAX_ACTIVE_ROWS))
      ]);

      const sections: ControlSection[] = [];
      const actions: ControlAction[] = [];

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 1. Workere og kø
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (aggR.ok) {
        const v = aggR.value;
        const items: ControlItem[] = [];
        const oldestMs = v.queue.oldest_ready_at ? Date.parse(v.queue.oldest_ready_at) : null;
        const stale = oldestMs !== null && nowMs - oldestMs > QUEUED_STALE_MS;
        items.push(controlItem({
          id: "queue", label: "Jobbkø", status: stale ? "WARN" : "OK", observed_at: v.queue.oldest_ready_at,
          detail_no: `${v.queue.queued} ikke startet (${v.queue.ready} klare, ${v.queue.in_backoff} i ventetid etter feil), ${v.queue.paused} pauset.${stale ? ` Den eldste klare jobben har stått i kø siden ${rel(v.queue.oldest_ready_at)} uten å bli tatt av en worker - ingen worker henter jobber.` : ""}`,
          facts: { queued: v.queue.queued, ready: v.queue.ready, in_backoff: v.queue.in_backoff, paused: v.queue.paused, oldest_ready_at: v.queue.oldest_ready_at }
        }));
        for (const w of v.workers) {
          items.push(controlItem({
            id: `worker:${w.worker_id}`, label: `Worker ${w.worker_id}`, status: w.expired > 0 ? "WARN" : "OK", observed_at: w.last_claim_at,
            detail_no: `${w.running} kjørende jobb(er)${w.expired > 0 ? `, ${w.expired} med utløpt lease (workeren er trolig borte; jobben tas over av en annen worker eller gis opp)` : `; leasen fornyes ${w.soonest_lease_at ? "løpende" : "(ukjent)"}`}.`,
            facts: { worker_id: w.worker_id, running: w.running, expired_leases: w.expired, last_claim_at: w.last_claim_at, soonest_lease_at: w.soonest_lease_at }
          }));
        }
        const evidenceAge = v.last_claim_any_at ? nowMs - Date.parse(v.last_claim_any_at) : null;
        const alive = evidenceAge !== null && evidenceAge <= WORKER_EVIDENCE_WINDOW_MS;
        items.push(controlItem({
          id: "worker_evidence", label: "Bevis på at en worker lever", status: alive ? "OK" : "UNKNOWN", observed_at: v.last_claim_any_at,
          detail_no: alive
            ? `En jobb ble sist hentet av en worker ${rel(v.last_claim_any_at)}.`
            : v.last_claim_any_at
              ? `Siste claim var ${rel(v.last_claim_any_at)} - uten nylig aktivitet kan en ledig worker ikke skilles fra en stoppet (det finnes ikke worker-hjerteslag), så worker-helse er IKKE målt.`
              : "Ingen jobb er noen gang hentet av en worker - worker-helse er IKKE målt (det finnes ikke worker-hjerteslag).",
          facts: { last_claim_at: v.last_claim_any_at, window_hours: WORKER_EVIDENCE_WINDOW_MS / HOUR_MS }
        }));
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "workers", title_no: "Workere og kø", observed_at: nowIso, items,
          source: "tasks (status, worker_id, claimed_at, lease_expires_at, not_before; tenant-RLS) - det finnes ingen worker-hjerteslag, liv bevises kun av aktivitet",
          summary_no: `${v.running} kjørende, ${v.queue.queued} i kø, ${v.queue.paused} pauset; ${v.workers.length} worker(e) har kjørende jobber. ${countsNo(items)}.`
        }));
      } else {
        sections.push(unknownControlSection("workers", "Workere og kø", "tasks (tenant-RLS)", `kunne ikke leses${failed(aggR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 2. Jobber (ALLE agentprofiler) med avbryt
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (rowsR.ok) {
        const built = activeTaskRows(rowsR.value, nowMs, deps.toolGateway, "jobs");
        actions.push(...built.actions);
        const total = aggR.ok ? aggR.value.running + aggR.value.queue.queued + aggR.value.queue.paused : null;
        const hidden = total !== null ? Math.max(0, total - rowsR.value.length) : 0;
        const items = [...built.items];
        const profileLine = aggR.ok
          ? Object.entries(aggR.value.by_profile.reduce<Record<string, number>>((acc, p) => { acc[p.profile] = (acc[p.profile] ?? 0) + p.n; return acc; }, {})).map(([p, n]) => `${profileNo(p)} ${n}`).join(", ")
          : "";
        sections.push(controlSection({
          id: "jobs", title_no: "Kjørende, ventende og pauset jobber", observed_at: nowIso, items,
          source: "tasks (status created/running/paused, alle agentprofiler; tenant-RLS; tittel, resultat og feiltekst leses aldri)",
          summary_no: rowsR.value.length === 0
            ? "Ingen aktive agenter eller jobber akkurat nå."
            : `${rowsR.value.length} aktive jobber vises${hidden > 0 ? ` (${hidden} flere finnes og vises ikke - grensen er ${AGENT_CENTER_MAX_ACTIVE_ROWS})` : ""}${profileLine ? ` - ${profileLine}` : ""}. ${countsNo(items)}. Avbryt bruker den eksisterende avbryt-ruten (kun eieren; sideeffekter rulles ikke tilbake).`
        }));
      } else {
        sections.push(unknownControlSection("jobs", "Kjørende, ventende og pauset jobber", "tasks (tenant-RLS)", `kunne ikke leses${failed(rowsR)}`));
      }

      if (aggR.ok) {
        const v = aggR.value;

        // -----------------------------------------------------------------------------------------------------------------------------------------
        // 3. Leaser
        // -----------------------------------------------------------------------------------------------------------------------------------------
        const leaseItems: ControlItem[] = [
          controlItem({
            id: "leases_ok", label: "Fornyede leaser", status: "OK", detail_no: `${v.leases.renewed_ok} av ${v.running} kjørende jobber har en gyldig lease (workeren fornyer den løpende).`, facts: { renewed: v.leases.renewed_ok, running: v.running }
          }),
          controlItem({
            id: "leases_expired", label: "Utløpte leaser", status: v.leases.expired > 0 ? "WARN" : "OK",
            detail_no: v.leases.expired > 0
              ? `${v.leases.expired} kjørende jobb(er) har utløpt lease: workeren er borte. En annen worker tar den over; gis den opp etter for mange krasj (giftpille-vernet) står den som feilet.`
              : "Ingen kjørende jobber har utløpt lease.",
            facts: { expired: v.leases.expired }
          })
        ];
        sections.push(controlSection({
          id: "leases", title_no: "Leaser", observed_at: nowIso, items: leaseItems, source: "tasks.lease_expires_at (running; tenant-RLS)",
          summary_no: `${v.leases.renewed_ok} fornyede og ${v.leases.expired} utløpte leaser blant ${v.running} kjørende jobber.`
        }));

        // -----------------------------------------------------------------------------------------------------------------------------------------
        // 4. Forsøk på nytt og feilede jobber
        // -----------------------------------------------------------------------------------------------------------------------------------------
        const retryItems: ControlItem[] = [
          controlItem({
            id: "retrying", label: "Jobber på nytt forsøk", status: "OK", detail_no: `${v.retries.retrying} aktive jobber er på forsøk nummer to eller mer (${v.queue.in_backoff} venter på ventetiden etter en feil).`,
            facts: { retrying: v.retries.retrying, in_backoff: v.queue.in_backoff }
          }),
          controlItem({
            id: "failed_7d", label: "Feilede jobber siste 7 døgn", status: v.retries.failed_7d > 0 ? "WARN" : "OK",
            detail_no: v.retries.failed_7d > 0
              ? `${v.retries.failed_7d} jobber feilet siste 7 døgn (${v.retries.exhausted_7d} brukte opp alle forsøk, ${v.retries.abandoned_7d} ble gitt opp etter utløpt lease/krasj - ikke startet på nytt for å unngå krasjløkke).`
              : "Ingen feilede jobber siste 7 døgn.",
            facts: { failed: v.retries.failed_7d, retries_exhausted: v.retries.exhausted_7d, abandoned_after_lease_expiry: v.retries.abandoned_7d }
          })
        ];
        sections.push(controlSection({
          id: "retries", title_no: "Forsøk på nytt og feilede jobber", observed_at: nowIso, items: retryItems, source: "tasks (attempts, status, not_before, kontraktens retry_policy; feiltekst leses aldri; tenant-RLS)",
          summary_no: `${v.retries.retrying} på nytt forsøk, ${v.retries.failed_7d} feilet siste 7 døgn.`
        }));

        // -----------------------------------------------------------------------------------------------------------------------------------------
        // 5. Avbrytelser
        // -----------------------------------------------------------------------------------------------------------------------------------------
        const cancelItems: ControlItem[] = [
          controlItem({
            id: "stop_pending", label: "Avbrudd forespurt, jobben kjører fortsatt", status: v.cancellations.stop_pending > 0 ? "WARN" : "OK",
            detail_no: v.cancellations.stop_pending > 0 ? `${v.cancellations.stop_pending} kjørende jobb(er) har fått avbrudd forespurt og stopper ved neste trygge punkt (eller gis opp ved lease-utløp).` : "Ingen kjørende jobber venter på å stoppe.",
            facts: { pending: v.cancellations.stop_pending }
          }),
          controlItem({
            id: "cancelled", label: "Avbrutte jobber siste døgn og revisjon siste 7 døgn", status: "OK", observed_at: v.cancellations.last_audit_at,
            detail_no: `${v.cancellations.cancelled_24h} jobber avbrutt siste døgn; ${v.cancellations.audit_7d} avbrudd i revisjonssporet siste 7 døgn${v.cancellations.last_audit_at ? `, sist ${rel(v.cancellations.last_audit_at)}` : ""}.`,
            facts: { cancelled_24h: v.cancellations.cancelled_24h, audit_events_7d: v.cancellations.audit_7d, last_audit_at: v.cancellations.last_audit_at }
          })
        ];
        sections.push(controlSection({
          id: "cancellations", title_no: "Avbrytelser", observed_at: nowIso, items: cancelItems, source: "tasks (cancel_requested, status cancelled) + audit_events (type task.cancelled; tenant-RLS)",
          summary_no: `${v.cancellations.stop_pending} venter på å stoppe, ${v.cancellations.cancelled_24h} avbrutt siste døgn.`
        }));

        // -----------------------------------------------------------------------------------------------------------------------------------------
        // 6. Artefakter
        // -----------------------------------------------------------------------------------------------------------------------------------------
        const artifactItems: ControlItem[] = v.artifacts.recent_by_kind.map((k) => controlItem({
          id: `kind:${k.kind}`, label: `Artefakter siste 7 døgn: ${k.kind}`, status: "OK", observed_at: k.last_at,
          detail_no: `${k.n} artefakter, ${bytesNo(k.bytes)} totalt; sist ${rel(k.last_at)}. Navn og innhold vises aldri.`, facts: { kind: k.kind, count: k.n, bytes: k.bytes, last_at: k.last_at }
        }));
        artifactItems.push(controlItem({
          id: "artifacts_total", label: "Alle artefakter", status: "OK", detail_no: `${v.artifacts.total} artefakter lagret (${bytesNo(v.artifacts.bytes)}).`, facts: { total: v.artifacts.total, bytes: v.artifacts.bytes }
        }));
        sections.push(controlSection({
          id: "artifacts", title_no: "Artefakter", observed_at: nowIso, items: artifactItems, source: "artifacts (art, antall, byte; navn og innhold leses aldri; tenant-RLS)",
          summary_no: `${v.artifacts.total} artefakter totalt; ${v.artifacts.recent_by_kind.reduce((a, k) => a + k.n, 0)} siste 7 døgn.`
        }));

        // -----------------------------------------------------------------------------------------------------------------------------------------
        // 7. Nettverksomfang og kodejobb-runner
        // -----------------------------------------------------------------------------------------------------------------------------------------
        const runnerStatus: ControlStatus = v.runner.errors_7d > 0 ? "WARN" : v.runner.coding_7d === 0 ? "UNKNOWN" : "OK";
        const networkItems: ControlItem[] = [
          controlItem({
            id: "network_scopes", label: "Nettverksmål i aktive jobber", status: "OK",
            detail_no: `${v.network.jobs_with_network} aktive jobber har nettverksmål (${v.network.targets} mål totalt). Vertsnavnene vises ikke; hver jobb er begrenset til sin egen allowlist i den signerte kontrakten.`,
            facts: { jobs_with_network: v.network.jobs_with_network, targets: v.network.targets }
          }),
          controlItem({
            id: "code_runner", label: "Kodejobb-runner (utledet av kodejobbenes utfall)", status: runnerStatus,
            detail_no: v.runner.errors_7d > 0
              ? `${v.runner.errors_7d} jobber feilet siste 7 døgn med en runner-feil (runneren på verten er nede, ikke konfigurert eller utilgjengelig for workeren); siste ${rel(v.runner.last_error_at)}. Kodejobber feiler da lukket.`
              : v.runner.coding_7d === 0
                ? "Ingen kodejobber siste 7 døgn - runnerens tilstand er IKKE målt herfra (verten eier den; helsen bevises av ops/job-runner/acceptance.sh)."
                : `${v.runner.coding_completed_7d} av ${v.runner.coding_7d} kodejobber siste 7 døgn ble fullført, ingen runner-feil.`,
            observed_at: v.runner.last_error_at, facts: { coding_jobs_7d: v.runner.coding_7d, coding_completed_7d: v.runner.coding_completed_7d, runner_errors_7d: v.runner.errors_7d, last_runner_error_at: v.runner.last_error_at }
          })
        ];
        networkItems.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "network", title_no: "Nettverksomfang og kodejobb-runner", observed_at: nowIso, items: networkItems,
          source: "tasks.contract.allowed_network_targets (kun antall) + kodejobbers utfall (tasks; kun feilprefikset leses). Nettverksisolasjonen i seg selv måles ikke herfra (DEFERRED: ops/job-runner/acceptance.sh på verten)",
          summary_no: `${v.network.jobs_with_network} aktive jobber med nettverksmål. Kodejobb-runner: ${runnerStatus === "OK" ? "ingen feil" : runnerStatus === "WARN" ? "runner-feil siste 7 døgn" : "ikke målt"}.`
        }));
      } else {
        for (const [id, title] of [["leases", "Leaser"], ["retries", "Forsøk på nytt og feilede jobber"], ["cancellations", "Avbrytelser"], ["artifacts", "Artefakter"], ["network", "Nettverksomfang og kodejobb-runner"]] as const) {
          sections.push(unknownControlSection(id, title, "tasks + artifacts + audit_events (tenant-RLS)", `kunne ikke leses${failed(aggR)}`));
        }
      }

      return { sections, actions };
    }
  };
}


// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { controlAction, controlItem, type ControlAction, type ControlItem, type ControlStatus } from "@jarvis/executive";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { actionRequiresStepUp } from "../step-up.ts";
import { HOUR_MS, bySeverityThenLabel, relativeNo, riskOf, tenantRead, toIso, untilNo, type ControlCenterPool } from "./shared.ts";

/**
 * WP-H0 (UA-11 / JARVIS-087): KJØRENDE AGENTER OG JOBBER fra `tasks`, med avbryt-handling. Gjenbrukbar av alle sentre som viser agenter (AI Center nå; Agent Center bygger videre på samme leser og handling):
 * ÉN leser, ÉN radbygger og ÉN avbryt-handling, så to sentre aldri viser samme jobb med to ulike knapper.
 *
 * INNHOLDSVERN: `tasks.goal` (jobbtittelen) og `result` leses ALDRI. Tittelen er skrevet av eieren eller formulert av en modell som kan ha lest ubetrodd innhold (e-post, web) - i en rapport som også
 * kan nå chat-modellen (`executive.get_control_center`) ville den vært en injeksjonsvei. Radene viser kun agentprofil (kategori), status, forsøk, tidspunkt og lease; eieren finner tittelen i chatten
 * (`/chat/jobs`). `last_error` leses kun som «finnes» (ikke teksten).
 *
 * AVBRYT-HANDLINGEN er `executive.cancel_task` (`/executive/mutate`): et gjennomslag til den EKSISTERENDE kanselleringsveien (`TaskService.cancel`), eier-kun, klasse B, uten step-up (en stopp-handling).
 * Den tilbys kun for jobber som kan avbrytes (ikke startet eller kjørende, og ikke allerede bedt om å stoppe); pauset jobb kan ikke avbrytes herfra (`requestCancel` håndterer kun created/running).
 */

/** En kjørende jobb som ikke har fornyet leasen på så lang tid er sannsynligvis forlatt (worker borte). */
export const LONG_RUNNING_MS = 2 * HOUR_MS;
/** En ikke startet jobb som har stått i kø så lenge uten å bli tatt av en worker. */
export const QUEUED_STALE_MS = 15 * 60_000;
const MAX_ACTIVE_ROWS = 50;

export interface ActiveTaskRow {
  task_id: string;
  status: "created" | "running" | "paused";
  agent_profile: string;
  attempts: number;
  max_attempts: number | null;
  delegated: boolean;
  cancel_requested: boolean;
  has_error: boolean;
  created_at: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  worker_id: string | null;
  network_targets: number;
}

export interface TaskCounts {
  created: number;
  running: number;
  paused: number;
  /** Siste 24 timer (opprettet i vinduet). */
  completed_24h: number;
  failed_24h: number;
  cancelled_24h: number;
}

export async function readActiveTasks(pool: ControlCenterPool, tenantId: string): Promise<ActiveTaskRow[]> {
  const rows = await tenantRead(pool, tenantId, (query) => query(
    `SELECT task_id, status, attempts, created_at, claimed_at, lease_expires_at, worker_id, cancel_requested, (last_error IS NOT NULL) AS has_error,
            coalesce(contract->>'agent_profile', 'ukjent') AS agent_profile,
            CASE WHEN contract->'retry_policy'->>'max_attempts' ~ '^[0-9]{1,4}$' THEN (contract->'retry_policy'->>'max_attempts')::int END AS max_attempts,
            (contract->'input'->'data'->>'delegated_from_chat') = 'true' AS delegated,
            CASE WHEN jsonb_typeof(contract->'allowed_network_targets') = 'array' THEN jsonb_array_length(contract->'allowed_network_targets') ELSE 0 END AS network_targets
       FROM tasks
      WHERE tenant_id = $1 AND status IN ('created', 'running', 'paused')
      ORDER BY (status = 'running') DESC, created_at
      LIMIT ${MAX_ACTIVE_ROWS}`,
    [tenantId]
  ));
  return rows.map((r) => ({
    task_id: String(r["task_id"]),
    status: String(r["status"]) as ActiveTaskRow["status"],
    agent_profile: String(r["agent_profile"]),
    attempts: Number(r["attempts"] ?? 0),
    max_attempts: r["max_attempts"] === null || r["max_attempts"] === undefined ? null : Number(r["max_attempts"]),
    delegated: r["delegated"] === true,
    cancel_requested: r["cancel_requested"] === true,
    has_error: r["has_error"] === true,
    created_at: toIso(r["created_at"]),
    claimed_at: toIso(r["claimed_at"]),
    lease_expires_at: toIso(r["lease_expires_at"]),
    worker_id: r["worker_id"] === null || r["worker_id"] === undefined ? null : String(r["worker_id"]),
    network_targets: Number(r["network_targets"] ?? 0)
  }));
}

export async function readTaskCounts(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<TaskCounts> {
  const rows = await tenantRead(pool, tenantId, (query) => query(
    `SELECT status, (count(*))::int AS n FROM tasks
      WHERE tenant_id = $1 AND (status IN ('created', 'running', 'paused') OR created_at >= $2)
      GROUP BY status`,
    [tenantId, new Date(nowMs - 24 * HOUR_MS)]
  ));
  const n = (status: string): number => Number(rows.find((r) => String(r["status"]) === status)?.["n"] ?? 0);
  return { created: n("created"), running: n("running"), paused: n("paused"), completed_24h: n("completed"), failed_24h: n("failed"), cancelled_24h: n("cancelled") };
}

const PROFILE_NO: Readonly<Record<string, string>> = { executive: "Assistentjobb", coding: "Kodejobb", research: "Researchjobb", verifier: "Verifiseringsjobb" };

export function profileNo(profile: string): string {
  return PROFILE_NO[profile] ?? `Jobb (${profile})`;
}

/** Korte, lesbare id-er til etikettene (hele id-en står i `facts`). */
const shortId = (taskId: string): string => (taskId.length <= 14 ? taskId : `${taskId.slice(0, 13)}…`);

export interface AgentRowsResult {
  items: ControlItem[];
  actions: ControlAction[];
}

/**
 * Radene + avbryt-handlingene for de aktive jobbene (ren funksjon). `sectionId` er seksjonen radene havner i (handlingene forankres dit).
 * Status: WARN når noe tyder på at jobben ikke er frisk (lease utløpt, kjørt lenge, står i kø uten å bli tatt, avbrudd forespurt, har hatt feil); ellers OK.
 */
export function activeTaskRows(rows: readonly ActiveTaskRow[], nowMs: number, toolGateway: Pick<ToolGateway, "get">, sectionId: string): AgentRowsResult {
  const items: ControlItem[] = [];
  const actions: ControlAction[] = [];
  for (const t of rows) {
    const leaseMs = t.lease_expires_at !== null ? Date.parse(t.lease_expires_at) : null;
    const startedMs = t.claimed_at !== null ? Date.parse(t.claimed_at) : null;
    const createdMs = t.created_at !== null ? Date.parse(t.created_at) : null;
    const leaseExpired = t.status === "running" && leaseMs !== null && leaseMs < nowMs;
    const runningLong = t.status === "running" && startedMs !== null && nowMs - startedMs > LONG_RUNNING_MS;
    const queuedStale = t.status === "created" && createdMs !== null && nowMs - createdMs > QUEUED_STALE_MS;
    const stopPending = t.status === "running" && t.cancel_requested;
    const problems: string[] = [];
    if (leaseExpired) problems.push(`leasen utløp ${relativeNo(t.lease_expires_at, nowMs)} (worker borte?)`);
    if (runningLong) problems.push(`har kjørt siden ${relativeNo(t.claimed_at, nowMs)}`);
    if (queuedStale) problems.push(`har stått i kø siden ${relativeNo(t.created_at, nowMs)} uten å bli tatt av en worker`);
    if (stopPending) problems.push("avbrudd er forespurt - stopper ved neste trygge punkt");
    if (t.has_error) problems.push("har hatt en feil (forsøk på nytt)");
    const status: ControlStatus = problems.length > 0 ? "WARN" : "OK";
    const state =
      t.status === "running" ? `kjører siden ${relativeNo(t.claimed_at, nowMs)}${leaseMs !== null && !leaseExpired ? `, leasen fornyes ${untilNo(t.lease_expires_at, nowMs)}` : ""}`
      : t.status === "created" ? `venter i kø siden ${relativeNo(t.created_at, nowMs)}`
      : "pauset (kan ikke avbrytes herfra)";
    items.push(controlItem({
      id: t.task_id,
      label: `${profileNo(t.agent_profile)} · ${shortId(t.task_id)}${t.delegated ? " (fra chat)" : ""}`,
      status,
      observed_at: t.claimed_at ?? t.created_at,
      detail_no: [state, `forsøk ${t.attempts}${t.max_attempts !== null ? ` av ${t.max_attempts}` : ""}`, ...problems].join(" · "),
      facts: {
        task_id: t.task_id, agent_profile: t.agent_profile, status: t.status, attempts: t.attempts, max_attempts: t.max_attempts, delegated_from_chat: t.delegated,
        cancel_requested: t.cancel_requested, has_error: t.has_error, created_at: t.created_at, started_at: t.claimed_at, lease_expires_at: t.lease_expires_at,
        worker: t.worker_id, network_targets: t.network_targets
      }
    }));
    if ((t.status === "created" || t.status === "running") && !t.cancel_requested) {
      actions.push(controlAction({
        // Gjennomgang av PR #316 (L-2): bekreftelsesdialogen viser KUN etikett og beskrivelse - uten jobb-id visste eieren ikke hvilken av flere jobber hun avbrøt. Den korte id-en står i begge (hele id-en står på raden).
        id: `agent.cancel:${t.task_id}`, label: `Avbryt ${profileNo(t.agent_profile).toLowerCase()} ${shortId(t.task_id)}`, endpoint: "/executive/mutate",
        body: { action: "cancel_task", parameters: { task_id: t.task_id } },
        risk_class: riskOf(toolGateway, "executive", "cancel_task"), requires_step_up: actionRequiresStepUp("cancel_task"), reversible: false,
        description_no: t.status === "created"
          ? `Avbryter ${profileNo(t.agent_profile).toLowerCase()} «${shortId(t.task_id)}» umiddelbart - den er ikke startet.`
          : `Ber den kjørende ${profileNo(t.agent_profile).toLowerCase()} «${shortId(t.task_id)}» stoppe ved neste trygge punkt. Sideeffekter den allerede har utført (verktøykall, kodeendringer) rulles IKKE tilbake.`,
        rollback_no: "Kan ikke angres: en avbrutt jobb kan ikke gjenopptas. Send den inn på nytt om du vil kjøre den igjen.",
        section_id: sectionId, item_id: t.task_id
      }));
    }
  }
  items.sort(bySeverityThenLabel);
  return { items, actions };
}

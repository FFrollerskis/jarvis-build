/**
 * WP-C4, V5 Autonomous Operations (masterplan v4.0 kap. 9: «Jarvis utfører endringer og dokumenterer before/after/recovery uten at eieren må være operatør») - SOVENDE og BAK BEKREFTELSE.
 *
 * REN logikk som oversetter driftsfunn (brutt SLO, watchdog, backup-alder, connector-helse, kø-stau, diskplass) til FORESLÅTTE, trygge handlinger med risikoklasse A-D per handling. Den kan KUN produsere et forslag:
 * ingen funksjon her utfører, sender eller skriver noe (`executes` er `false` i typen og i hver rad), modulen importerer ingen tjeneste/transport/gateway, og hvert forslag peker på den EKSISTERENDE veien en godkjent
 * handling går - eierens bundne bekreftelse (`ConfirmationStore`/`/confirmations`) for klasse A-C, signert godkjenning (step-up) for klasse D. Standard AV (`JARVIS_V5_PROPOSALS_ENABLED`).
 *
 * Begrunnelsene bruker KUN tall og kategorier fra målingene (aldri fritekst fra en kilde). Et funn uten måling (ukjent) gir aldri et forslag - ukjent er ikke det samme som galt - men står i `skipped_no`.
 * Status: BUILT_UNWIRED - det finnes ingen avsender som leverer forslagene (bekreftelsene utløper etter 5 min, så en periodisk levering krever en egen beslutning om en lengre forslagskø).
 */
import type { OpsProposal, OpsProposalReport, OpsRisk } from "./types.ts";

export interface OpsSignals {
  enabled: boolean;
  /** SLO-resultater (kun id og status). null = SLO-rapporten var utilgjengelig. */
  slo: ReadonlyArray<{ id: string; status: string }> | null;
  /** Selvdiagnosens observasjoner per område (`backup`, `watchdog`, `scheduled_jobs`, `tasks`, `process`). null = selvdiagnosen var utilgjengelig. */
  observations: Readonly<Record<string, { status: string; data?: Readonly<Record<string, string | number | boolean | null>> }>> | null;
  /** Connector-status (`listConnectorStatus`). null = utilgjengelig. */
  connectors: ReadonlyArray<{ id: string; configured: boolean; test_method: string; health: { state: string } | null }> | null;
  /** Jobber som har ventet over 15 min i kø. null = ikke målt. */
  tasks_waiting_over_15m: number | null;
}

type Service = "api" | "worker";

/** Hvilken tjeneste et brutt tjenestemål hører til (SLO-katalogen i `slo/definitions.ts`). Ukjent id gir ingen forslag. */
const SLO_SERVICE: Readonly<Record<string, Service>> = {
  chat_success: "api", chat_ttft_p95: "api", chat_latency_p95: "api", background_success: "api", tools_success: "api", jobs_success: "worker"
};

/** Terskler. Konservative: hellere ingen forslag enn støy. Kø-stau = minst så mange jobber har ventet over 15 min. */
export const OPS_THRESHOLDS = { queue_backlog_min_jobs: 5, low_disk_gb: 10, max_connector_proposals: 5, max_proposals: 8 } as const;

const RISK_ORDER: Record<OpsRisk, number> = { A: 0, B: 1, C: 2, D: 3 };
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const BAD = new Set(["DEGRADED", "DOWN"]);
const COMPOSE = "docker compose --env-file .env -f infra/local/docker-compose.yml";

interface RestartTrigger { area: string; status: string; why: string }

function restartProposal(service: Service, triggers: readonly RestartTrigger[]): OpsProposal {
  const first = triggers[0] as RestartTrigger;
  return {
    id: `restart_service:${service}`,
    action_id: "restart_service",
    title_no: `Start ${service === "api" ? "API-tjenesten" : "worker-tjenesten"} på nytt`,
    rationale_no: `${triggers.map((t) => t.why).join("; ")}. Omstart er ett steg å prøve, ikke en garanti for at feilen forsvinner.`,
    trigger: { area: first.area, status: first.status },
    risk_class: "D",
    requires: "step_up",
    execution_path: "host_runbook",
    proposed_calls: [],
    how_no: `På verten: ${COMPOSE} restart ${service}. ${service === "api" ? "API-prosessen kan ikke starte seg selv på nytt via verktøyene, så dette gjøres på verten." : "Kan også gå via docker.stop_container og docker.start_container (klasse D) hvis containeren står i JARVIS_DOCKER_MUTATION_TARGETS."}`,
    rollback_no: service === "worker" ? "Jobber med utløpt lease hentes automatisk igjen av en frisk worker (lease-reclaim)." : "Tjenesten starter med samme konfig; økter og jobber ligger i databasen.",
    executes: false
  };
}

/**
 * Oversetter driftsfunn til forslag. Deterministisk: samme inndata gir samme forslag i samme rekkefølge (lav risiko først). `enabled=false` gir ingen forslag. Ingenting utføres.
 */
export function proposeOpsActions(signals: OpsSignals): OpsProposalReport {
  if (!signals.enabled) {
    return { enabled: false, proposals: [], skipped_no: ["forslag er av (JARVIS_V5_PROPOSALS_ENABLED er ikke true)"] };
  }
  const skipped: string[] = [];
  const proposals: OpsProposal[] = [];
  const restart: Record<Service, RestartTrigger[]> = { api: [], worker: [] };

  // 1. Tjenestemål (SLO): brutt mål -> vurder omstart av tjenesten målet hører til.
  if (signals.slo === null) skipped.push("tjenestemål (SLO) kunne ikke leses");
  else {
    for (const s of signals.slo) {
      if (s.status !== "BREACH") continue;
      const service = Object.hasOwn(SLO_SERVICE, s.id) ? SLO_SERVICE[s.id] : undefined; // L1: kun egne felt (`constructor`/`__proto__` er ikke en tjeneste). Inline: denne filen importerer bare typer (statisk vakt).
      if (service === undefined) skipped.push("et brutt tjenestemål har ukjent tjeneste (ingen regel)");
      else restart[service].push({ area: "slo", status: "BREACH", why: `tjenestemålet ${s.id} er brutt` });
    }
  }

  const obs = signals.observations;
  if (obs === null) skipped.push("selvdiagnosen kunne ikke leses (watchdog, backup, jobber og diskplass er ikke vurdert)");
  else {
    // 2. Watchdog (kjører i worker-prosessen): svekket/nede -> omstart av worker.
    const watchdog = obs["watchdog"];
    if (watchdog === undefined || watchdog.status === "UNKNOWN") skipped.push("watchdog er ikke målt (ingen leser)");
    else if (BAD.has(watchdog.status)) restart.worker.push({ area: "watchdog", status: watchdog.status, why: `watchdog melder ${watchdog.status === "DOWN" ? "nede" : "svekket"}` });

    // 3. Daglige jobber (scheduleren bor i API-prosessen): tapt kritisk arbeid (DOWN) -> omstart av API.
    const scheduled = obs["scheduled_jobs"];
    if (scheduled?.status === "DOWN") restart.api.push({ area: "scheduled_jobs", status: "DOWN", why: "daglige jobber har gitt opp eller mistet arbeid" });

    // 4. Jobber som står fast (utløpt lease) -> worker.
    const tasks = obs["tasks"];
    const stuck = typeof tasks?.data?.["stuck"] === "number" ? tasks.data["stuck"] : 0;
    if (tasks !== undefined && BAD.has(tasks.status) && stuck > 0) restart.worker.push({ area: "tasks", status: tasks.status, why: `${stuck} jobber har utløpt lease` });

    // 5. Backup-alder: eldre enn grensen (leseren melder DEGRADED/DOWN) -> ta backup.
    const backup = obs["backup"];
    if (backup === undefined || backup.status === "UNKNOWN") skipped.push("backup er ikke målt (ingen leser) - ingen forslag om å ta backup");
    else if (BAD.has(backup.status)) {
      proposals.push({
        id: "run_backup:nas", action_id: "run_backup", title_no: "Ta en ny kryptert backup", rationale_no: `backup-målingen melder ${backup.status === "DOWN" ? "nede" : "for gammel eller svekket"}`,
        trigger: { area: "backup", status: backup.status }, risk_class: "C", requires: "owner_confirmation", execution_path: "host_runbook", proposed_calls: [],
        how_no: "På NAS-en: ops/backup/nas-backup.sh <backupmappe> (docs/remediation/BACKUP_RESTORE_RUNBOOK.md §1). Skriptet rydder også komplette sett eldre enn 30 dager (det nyeste beholdes alltid).",
        rollback_no: "Backupsett er kun tillegg; opprydding beholder alltid det nyeste. Ingen endring i selve Jarvis.", executes: false
      });
    }

    // 6. Lite diskplass -> rydd gamle artefakter (kun innen eksplisitte alders-/prefiksregler, og først etter bekreftelse - regel 8).
    const processObs = obs["process"];
    const disk = processObs?.data?.["disk_free_gb"];
    if (processObs !== undefined && BAD.has(processObs.status) && typeof disk === "number" && disk < OPS_THRESHOLDS.low_disk_gb) {
      proposals.push({
        id: "cleanup_artifacts:host", action_id: "cleanup_artifacts", title_no: "Rydd gamle artefakter for å frigjøre diskplass", rationale_no: `ledig diskplass er ${disk} GB (grense ${OPS_THRESHOLDS.low_disk_gb} GB)`,
        trigger: { area: "process", status: processObs.status }, risk_class: "C", requires: "owner_confirmation", execution_path: "host_runbook", proposed_calls: [],
        how_no: "Kun etter din bekreftelse og kun innen eksplisitte alders-/prefiksregler (for eksempel backupsett eldre enn 30 dager, gamle jobbarbeidsmapper). Ingenting slettes ut fra et filnavn modellen har funnet på.",
        rollback_no: "Sletting kan ikke angres - derfor krever den bekreftelse; backupsettene er kopier, jobbarbeidsmapper kan gjenskapes ved ny jobb.", executes: false
      });
    }
  }

  // 7. Kø-stau: mange jobber har ventet lenge -> worker.
  if (signals.tasks_waiting_over_15m === null) skipped.push("kø-stau er ikke målt");
  else if (signals.tasks_waiting_over_15m >= OPS_THRESHOLDS.queue_backlog_min_jobs) {
    restart.worker.push({ area: "tasks", status: "BACKLOG", why: `${signals.tasks_waiting_over_15m} jobber har ventet over 15 min i kø` });
  }

  // 8. Connector-helse: konfigurert og live-testbar, men siste kjente helse er ikke frisk -> kjør tilkoblingstesten på nytt (klasse A, ren lesing).
  if (signals.connectors === null) skipped.push("connector-status kunne ikke leses");
  else {
    const failing = signals.connectors
      .filter((c) => c.configured && c.test_method === "live" && c.health !== null && c.health.state !== "healthy" && c.health.state !== "ok")
      .sort((a, b) => a.id.localeCompare(b.id));
    const usable = failing.filter((c) => SAFE_ID.test(c.id));
    if (usable.length < failing.length) skipped.push("en connector hadde en ugyldig id og er ikke foreslått testet");
    for (const c of usable.slice(0, OPS_THRESHOLDS.max_connector_proposals)) {
      proposals.push({
        id: `rerun_connector_test:${c.id}`, action_id: "rerun_connector_test", title_no: `Kjør tilkoblingstesten for ${c.id} på nytt`, rationale_no: `siste kjente helse for ${c.id} er ${c.health?.state ?? "ukjent"}`,
        trigger: { area: "connectors", status: "DEGRADED" }, risk_class: "A", requires: "owner_confirmation", execution_path: "tool_gateway",
        proposed_calls: [{ tool_id: "owner_controls", action: "test_connector", parameters: { connector_id: c.id } }],
        how_no: `Dashbordet: Integrasjoner, «Test tilkobling» for ${c.id} (owner_controls.test_connector, klasse A - en ren lesing).`,
        rollback_no: "Ingen endring å angre (kun lesing).", executes: false
      });
    }
    if (usable.length > OPS_THRESHOLDS.max_connector_proposals) skipped.push(`${usable.length - OPS_THRESHOLDS.max_connector_proposals} flere connectorer med svak helse er ikke listet (maks ${OPS_THRESHOLDS.max_connector_proposals})`);
  }

  for (const service of ["api", "worker"] as const) {
    if (restart[service].length > 0) proposals.push(restartProposal(service, restart[service]));
  }
  proposals.sort((a, b) => RISK_ORDER[a.risk_class] - RISK_ORDER[b.risk_class] || a.id.localeCompare(b.id));
  if (proposals.length > OPS_THRESHOLDS.max_proposals) {
    skipped.push(`${proposals.length - OPS_THRESHOLDS.max_proposals} forslag til er ikke listet (maks ${OPS_THRESHOLDS.max_proposals})`);
    proposals.length = OPS_THRESHOLDS.max_proposals;
  }
  return { enabled: true, proposals, skipped_no: [...new Set(skipped)] };
}

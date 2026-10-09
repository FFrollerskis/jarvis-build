import type pg from "pg";
import type { IdentityContext, JobContract, MemorySpace } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import { GitPolicyError, assertTestCommand, type TaskService } from "@jarvis/tasks";
import type { IncidentService } from "./service.ts";
import type { Incident } from "./types.ts";

export interface ProposeRepairTaskInput {
  repo_url: string;
  goal: string;
  /** WP-E1 (JARVIS-068): PÅKREVD og validert mot den kjente testløper-allowlisten FØR noe sendes inn. Tidligere ble `?? []` til Jarvis' interne standard (`node -e process.exit(0)`) - en vakuøs
   * «test» som alltid består, så en reparasjon kunne meldes `tests: passed` uten at noen test var kjørt. Den uavhengige testporten er hele poenget med reparasjonsflyten. */
  test_command: string[];
  /** Krever `allowed_tools: ["github"]` for at D-95 PR-publisering skal skje - uten den fullføres jobben likevel (skipped_not_allowed, D-95-presedens uendret). */
  publishPr?: boolean;
  model_budget_ore?: number;
}

export type ProposeRepairTaskResult =
  | { ok: true; task_id: string }
  | { ok: false; reason: string };

/** Statuser der det gir mening å foreslå (et nytt forsøk på) en reparasjon. `repair_proposed` tillates for nytt forsøk etter en feilet jobb; en løst/lukket hendelse eller et pågående tiltak avvises. */
const REPAIRABLE: ReadonlySet<Incident["status"]> = new Set(["open", "diagnosing", "repair_proposed"]);

/**
 * D-104 Part C: hendelse -> DEN EKSISTERENDE, allerede live-verifiserte
 * D-102/D-103 testet-fiks-pipelinen (`TaskService.submit()` ->
 * `createCodingHandler` -> ekte `ClaudeCodeAgent` -> uavhengig testport ->
 * commit -> autentisert push -> valgfri PR). Denne funksjonen GJØR ALDRI
 * selve kodeendringen/testkjøringen/pushen - den bygger KUN en
 * standard-`JobContract` (agent_profile: "coding", UENDRET kontrakt-skjema)
 * og sender den inn via DEN SAMME `TaskService`-instansen produksjons-APIet
 * allerede bruker (`POST /tasks/submit`, D-102). `input.data.incident_id`
 * er den ENESTE nye kontrakt-dataen - lar `createCodingHandler` (helt
 * uendret) sitt eksisterende `input.data`-felt bære lenken tilbake til
 * hendelsen, verifisert av `incident_repair_tasks`-lenkeraden under.
 *
 * INGEN auto-merge (uendret D-95/D-102-regel - PR-en publiseres, aldri
 * merget). Hendelsen flyttes til `repair_proposed` KUN ved en vellykket
 * innsending - en avvist jobb (policy/kontrakt-feil) endrer ALDRI
 * hendelsens status.
 *
 * WP-E1 (JARVIS-068) - gjort sikker FØR noe betales for:
 *  - `test_command` er påkrevd og valideres (kjent testløper) FØR innsending - aldri en vakuøs standardtest.
 *  - Hendelsen må være i en reparerbar status (ikke løst/lukket/avbøting pågår), og det kan ikke finnes en uferdig reparasjonsjobb fra før (dobbeltklikk/retry ga to betalte agentkjøringer).
 *  - Statusovergangen går gjennom `transition()` (aktør `repair`, årsak + peker på jobben) i stedet for en anonym statusskriving.
 */
export async function proposeRepairTask(
  deps: { taskService: TaskService; pool: pg.Pool; incidents: IncidentService },
  identity: IdentityContext,
  memorySpace: MemorySpace,
  incident: Incident,
  input: ProposeRepairTaskInput
): Promise<ProposeRepairTaskResult> {
  let testCommand: string[];
  try {
    testCommand = assertTestCommand(input.test_command);
  } catch (err) {
    return { ok: false, reason: err instanceof GitPolicyError ? `repair_${err.reason}` : "repair_test_command_invalid" };
  }
  if (!REPAIRABLE.has(incident.status)) return { ok: false, reason: "repair_incident_not_repairable" };

  const unfinished = await withTenantTransaction(deps.pool, incident.tenant_id, (client) =>
    client.query(
      `SELECT 1 FROM incident_repair_tasks r JOIN tasks t ON t.tenant_id = r.tenant_id AND t.task_id = r.task_id
        WHERE r.tenant_id = $1 AND r.incident_id = $2 AND t.status IN ('created', 'running', 'paused') LIMIT 1`,
      [incident.tenant_id, incident.incident_id]
    )
  );
  if (unfinished.rowCount) return { ok: false, reason: "repair_already_in_progress" };

  const task_id = `inc-repair-${incident.incident_id}-${Date.now().toString(36)}`;
  const contract: JobContract = {
    task_id,
    // Arkitekt-review (P1): jobbens eier er ALLTID den verifiserte innsenderen (TaskService.submit krever det), aldri en verdi fra incident-raden.
    owner_person_id: identity.person_id,
    tenant_id: incident.tenant_id,
    goal: input.goal,
    acceptance_criteria: ["tester bestaar", "endring committet og pushet"],
    input: {
      data: { repo_url: input.repo_url, test_command: testCommand, incident_id: incident.incident_id },
      trust_level: "internal",
      provenance: "incident-repair-orchestration"
    },
    allowed_tools: input.publishPr ? ["github"] : [],
    allowed_memory_spaces: [memorySpace],
    allowed_network_targets: [],
    agent_profile: "coding",
    model_budget_ore: input.model_budget_ore ?? 20_000,
    retry_policy: { max_attempts: 1, backoff_seconds: 0 },
    max_steps: 5
  };

  const result = await deps.taskService.submit(identity, contract);
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }

  await withTenantTransaction(deps.pool, incident.tenant_id, (client) =>
    client.query(
      `INSERT INTO incident_repair_tasks (incident_id, task_id, tenant_id) VALUES ($1, $2, $3)`,
      [incident.incident_id, task_id, incident.tenant_id]
    )
  );
  if (incident.status === "open" || incident.status === "diagnosing") {
    await deps.incidents.transition(
      incident.tenant_id, memorySpace, incident.incident_id, "repair_proposed", { kind: "repair" },
      { reason: "reparasjonsjobb (testet-fiks-pipelinen) sendt inn", evidence_ref: task_id }
    );
  }

  return { ok: true, task_id };
}

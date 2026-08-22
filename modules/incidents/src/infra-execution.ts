import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import type { DockerMutationAction, ToolGateway } from "@jarvis/tool-gateway";
import { computeStateDiff } from "./diff.ts";
import type { InfraExecution, InfraOperationalOutcome } from "./types.ts";

export interface ExecuteInfraMutationInput {
  tenant_id: string;
  person_id?: string;
  device_id?: string;
  incident_id?: string;
  target: string;
  /** D-105 host-fix (D-41-korreksjon): hvilken docker-mutasjon som utføres - IKKE lenger hardkodet til redeploy_container. Mål-autorisasjon (sentinel vs. eier-konfigurert produksjon) håndheves av ToolGateway selv (parameterAuthorizer), IKKE her. */
  action: DockerMutationAction;
  /** KUN krevd for `redeploy_container`. */
  target_image?: string;
  idempotency_key: string;
}

async function readToolExecutionState(
  pool: pg.Pool,
  tenantId: string,
  idempotencyKey: string
): Promise<{ before: JsonValue | null; after: JsonValue | null }> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT before_state, after_state FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey]
    );
    const row = rows[0] as { before_state: JsonValue | null; after_state: JsonValue | null } | undefined;
    return { before: row?.before_state ?? null, after: row?.after_state ?? null };
  });
}

function asRunning(state: JsonValue | null): boolean | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const status = (state as Record<string, unknown>)["status"];
  return typeof status === "string" ? status === "running" : null;
}

/**
 * D-105 host-fix Del 8: fire-state operasjonelt utfall - PER handlingstype,
 * ALDRI fabrikkert SUCCESS. `redeploy_container`: riktig image OG running.
 * `stop_container`: IKKE running etterpå. `start_container`: running etterpå.
 * Et kall som teknisk lykkes (`executeOk=true`) men lander på feil tilstand
 * er EKSPLISITT PARTIAL - aldri SUCCESS bare fordi det underliggende kallet
 * returnerte ok.
 */
function determineOutcome(
  action: DockerMutationAction,
  executeOk: boolean,
  after: JsonValue | null,
  targetImage: string | undefined
): InfraOperationalOutcome {
  if (!executeOk) return "FAILED";
  if (!after || typeof after !== "object" || Array.isArray(after)) return "UNKNOWN";
  const state = after as Record<string, unknown>;
  if (action === "redeploy_container") {
    return state["image"] === targetImage && state["status"] === "running" ? "SUCCESS" : "PARTIAL";
  }
  if (action === "stop_container") {
    return state["status"] !== "running" ? "SUCCESS" : "PARTIAL";
  }
  // start_container
  return state["status"] === "running" ? "SUCCESS" : "PARTIAL";
}

/**
 * D-105 host-fix Del 9: recovery-planen for `stop_container`/`start_container`
 * er UTELUKKENDE en funksjon av `before.status` (den observerte FØR-
 * tilstanden) - ALDRI av hvilken handling som faktisk ble utført. Var
 * containeren running FØR -> recovery er start_container (uansett om
 * mutasjonen selv var stop ELLER start). Var den IKKE running FØR -> recovery
 * er stop_container. Byggeordrens §9-eksempel: "before running=true -> mutation
 * stop -> recovery -> start" / "before running=false -> mutation start ->
 * recovery -> stop".
 */
function buildRecoveryPlan(action: DockerMutationAction, before: JsonValue | null, target: string): string {
  if (action === "redeploy_container") {
    if (before && typeof before === "object" && !Array.isArray(before) && typeof (before as Record<string, unknown>)["image"] === "string") {
      const priorImage = (before as Record<string, unknown>)["image"] as string;
      return `docker.redeploy_container(name=${target}, image=${priorImage})`;
    }
    return "ingen tidligere tilstand fanget (første deploy) - recovery ikke mulig, dokumentert begrensning";
  }
  const wasRunning = asRunning(before);
  if (wasRunning === null) {
    return "ingen tidligere tilstand fanget - recovery ikke mulig, dokumentert begrensning";
  }
  return wasRunning ? `docker.start_container(name=${target})` : `docker.stop_container(name=${target})`;
}

/**
 * D-105 Part H/J (host-fix, D-41-korreksjon): kritisk infra-mutasjon MED
 * sammenhengende journal. Selve mutasjonen går UTELUKKENDE gjennom
 * `ToolGateway.execute()` - INGEN direkte transport-kall (samme prinsipp
 * som D-104s `attemptRecovery`) - dette er OGSÅ hvordan mål-autorisasjon
 * (sentinel vs. eier-konfigurert produksjon, se docker-target-policy.ts)
 * håndheves: `gateway.execute()` selv nekter et ikke-autorisert mål FØR
 * transporten nås, denne funksjonen dupliserer INGEN egen sjekk. Before/after
 * kommer fra DEN EKSISTERENDE `tool_executions`-D-pipelinen (preflight_action:
 * "inspect_container", uendret mekanisme) - denne funksjonen leser KUN det
 * resultatet og beriker det med kontekst (aktør/enhet/risikoklasse/recovery-
 * plan/diff) i EN sammenhengende, append-only `infra_executions`-rad.
 */
export async function executeInfraMutation(
  deps: { pool: pg.Pool; gateway: ToolGateway },
  identity: IdentityContext,
  input: ExecuteInfraMutationInput
): Promise<InfraExecution> {
  if (input.action === "redeploy_container" && typeof input.target_image !== "string") {
    throw new Error("infra_mutation_missing_target_image");
  }
  const parameters: Record<string, JsonValue> =
    input.action === "redeploy_container"
      ? { name: input.target, image: input.target_image as string }
      : { name: input.target };

  const result = await deps.gateway.execute({
    identity,
    tool_id: "docker",
    action: input.action,
    parameters,
    idempotency_key: input.idempotency_key
  });

  const { before, after } = result.ok
    ? await readToolExecutionState(deps.pool, input.tenant_id, input.idempotency_key)
    : { before: null, after: null };
  const state_diff = computeStateDiff(before, after);
  const verification_outcome = determineOutcome(input.action, result.ok, after, input.target_image);
  const recovery_plan = buildRecoveryPlan(input.action, before, input.target);
  const provider_receipt: JsonValue = result.ok
    ? ({ external_id: result.external_id ?? null } as unknown as JsonValue)
    : ({ reason: (result as { reason: string }).reason } as unknown as JsonValue);
  const requested_operation =
    input.action === "redeploy_container"
      ? `docker.redeploy_container:${input.target}->${input.target_image}`
      : `docker.${input.action}:${input.target}`;
  const requested_state: JsonValue =
    input.action === "redeploy_container"
      ? ({ name: input.target, image: input.target_image } as unknown as JsonValue)
      : ({ name: input.target } as unknown as JsonValue);

  return withTenantTransaction(deps.pool, input.tenant_id, async (client) => {
    const execution_id = `inf-exec-${randomUUID()}`;
    const { rows } = await client.query(
      `INSERT INTO infra_executions
         (execution_id, tenant_id, person_id, device_id, target, provider, tool_id, action, risk_class, authority_mode,
          incident_id, idempotency_key, requested_operation, requested_state, before_state, recovery_plan,
          provider_receipt, after_state, state_diff, verification_outcome, recovery_available)
       VALUES ($1,$2,$3,$4,$5,'docker','docker',$6,'D',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        execution_id, input.tenant_id, input.person_id ?? null, input.device_id ?? null, input.target,
        input.action,
        // D-105: myndighetsmodus (SOVEREIGN/SCOPED) avgjøres INNE i policy.authorize()
        // (kalt av gateway.execute() over) - ToolResult eksponerer ikke
        // beslutningsobjektet tilbake hit. Feltet forblir bevisst NULL fremfor
        // å gjette/duplisere policy-intern tilstand - IKKE en skjult
        // reimplementasjon av autoritetsoppløsning.
        null,
        input.incident_id ?? null, input.idempotency_key, requested_operation,
        JSON.stringify(requested_state), before === null ? null : JSON.stringify(before),
        recovery_plan, JSON.stringify(provider_receipt), after === null ? null : JSON.stringify(after),
        state_diff === null ? null : JSON.stringify(state_diff), verification_outcome, before !== null
      ]
    );
    return rows[0] as InfraExecution;
  });
}

export async function getInfraExecution(pool: pg.Pool, tenantId: string, executionId: string): Promise<InfraExecution | null> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const { rows } = await client.query(`SELECT * FROM infra_executions WHERE tenant_id = $1 AND execution_id = $2`, [tenantId, executionId]);
    return (rows[0] as InfraExecution) ?? null;
  });
}

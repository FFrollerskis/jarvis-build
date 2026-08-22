import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { computeStateDiff } from "./diff.ts";
import type { InfraExecution, InfraOperationalOutcome } from "./types.ts";

export interface ExecuteInfraMutationInput {
  tenant_id: string;
  person_id?: string;
  device_id?: string;
  incident_id?: string;
  /** Container-navn - MÅ matche `jarvis-sentinel-*` (håndhevet STRUKTURELT i docker-transport.ts, ikke bare her). */
  target: string;
  target_image: string;
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

function determineOutcome(executeOk: boolean, after: JsonValue | null, targetImage: string): InfraOperationalOutcome {
  if (!executeOk) return "FAILED";
  if (!after || typeof after !== "object" || Array.isArray(after)) return "UNKNOWN";
  const state = after as Record<string, unknown>;
  if (state["image"] === targetImage && state["status"] === "running") return "SUCCESS";
  return "PARTIAL";
}

function buildRecoveryPlan(before: JsonValue | null, target: string): string {
  if (before && typeof before === "object" && !Array.isArray(before) && typeof (before as Record<string, unknown>)["image"] === "string") {
    const priorImage = (before as Record<string, unknown>)["image"] as string;
    return `docker.redeploy_container(name=${target}, image=${priorImage})`;
  }
  return "ingen tidligere tilstand fanget (første deploy) - recovery ikke mulig, dokumentert begrensning";
}

/**
 * D-105 Part H/J: kritisk infra-mutasjon MED sammenhengende journal. Selve
 * mutasjonen går UTELUKKENDE gjennom `ToolGateway.execute()` - INGEN direkte
 * transport-kall (samme prinsipp som D-104s `attemptRecovery`). Before/after
 * kommer fra DEN EKSISTERENDE `tool_executions`-D-pipelinen (preflight_
 * action: "inspect_container", uendret mekanisme) - denne funksjonen leser
 * KUN det resultatet og beriker det med kontekst (aktør/enhet/risikoklasse/
 * recovery-plan/diff) i EN sammenhengende, append-only `infra_executions`-
 * rad (byggeordrens §H: "must not require reconstructing... from loosely-
 * related free-form JSON audit messages").
 */
export async function executeInfraMutation(
  deps: { pool: pg.Pool; gateway: ToolGateway },
  identity: IdentityContext,
  input: ExecuteInfraMutationInput
): Promise<InfraExecution> {
  const result = await deps.gateway.execute({
    identity,
    tool_id: "docker",
    action: "redeploy_container",
    parameters: { name: input.target, image: input.target_image },
    idempotency_key: input.idempotency_key
  });

  const { before, after } = result.ok
    ? await readToolExecutionState(deps.pool, input.tenant_id, input.idempotency_key)
    : { before: null, after: null };
  const state_diff = computeStateDiff(before, after);
  const verification_outcome = determineOutcome(result.ok, after, input.target_image);
  const recovery_plan = buildRecoveryPlan(before, input.target);
  const provider_receipt: JsonValue = result.ok
    ? ({ external_id: result.external_id ?? null } as unknown as JsonValue)
    : ({ reason: (result as { reason: string }).reason } as unknown as JsonValue);

  return withTenantTransaction(deps.pool, input.tenant_id, async (client) => {
    const execution_id = `inf-exec-${randomUUID()}`;
    const { rows } = await client.query(
      `INSERT INTO infra_executions
         (execution_id, tenant_id, person_id, device_id, target, provider, tool_id, action, risk_class, authority_mode,
          incident_id, idempotency_key, requested_operation, requested_state, before_state, recovery_plan,
          provider_receipt, after_state, state_diff, verification_outcome, recovery_available)
       VALUES ($1,$2,$3,$4,$5,'docker','docker','redeploy_container','D',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        execution_id, input.tenant_id, input.person_id ?? null, input.device_id ?? null, input.target,
        // D-105: myndighetsmodus (SOVEREIGN/SCOPED) avgjøres INNE i policy.authorize()
        // (kalt av gateway.execute() over) - ToolResult eksponerer ikke
        // beslutningsobjektet tilbake hit. Feltet forblir bevisst NULL fremfor
        // å gjette/duplisere policy-intern tilstand - IKKE en skjult
        // reimplementasjon av autoritetsoppløsning.
        null,
        input.incident_id ?? null, input.idempotency_key, `docker.redeploy_container:${input.target}->${input.target_image}`,
        JSON.stringify({ name: input.target, image: input.target_image }), before === null ? null : JSON.stringify(before),
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

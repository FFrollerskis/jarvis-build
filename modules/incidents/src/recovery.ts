import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { CLOUDFLARE_RECOVERY_STRATEGIES } from "./cloudflare-recovery.ts";
import { findExecutionByKey, getInfraExecution } from "./infra-execution.ts";
import type { InfraExecution, InfraRecoveryAction, RecoveryStatus } from "./types.ts";

export interface AttemptRecoveryInput {
  tenant_id: string;
  tool_id: string;
  action: string;
  /** Idempotency-nøkkelen den OPPRINNELIGE mutasjonen ble utført med (samme (tenant_id, idempotency_key) som en `tool_executions`-rad). */
  idempotency_key: string;
  /** Den OPPRINNELIGE handlingens parametre (f.eks. `repo`) - `tool_executions` lagrer KUN before/after-tilstand, ikke selve kall-parametrene, så disse må gis eksplisitt av kalleren. */
  parameters: Record<string, JsonValue>;
  incident_id?: string;
  /** D-105: peker TILBAKE til `infra_executions`-raden denne recoveryen gjenoppretter (byggeordrens §K: "recovery references original execution") - valgfritt (D-104-æra github-recovery har ingen slik rad). */
  execution_id?: string;
}

interface RecoveryStrategyContext {
  gateway: ToolGateway;
  identity: IdentityContext;
  beforeState: JsonValue | null;
  parameters: Record<string, JsonValue>;
  idempotencyKey: string;
  /**
   * WP-E1 (JARVIS-068/TSK-033): den journalførte eksekusjonen (`infra_executions`) for nøkkelen, hvis den finnes. Strategier som bærer mål-identitet
   * (Docker-navn, Cloudflare-sone/post/regel) skal hente målet HERFRA, ikke fra kallerens parametre - og `attemptRecovery()` avviser en recovery der
   * kallerens verktøy/handling/mål ikke samsvarer med den journalførte eksekusjonen (`recovery_target_mismatch`).
   */
  execution: InfraExecution | null;
}

interface RecoveryOutcome {
  status: RecoveryStatus;
  result: Record<string, unknown>;
}

/**
 * D-105 host-fix (D-41-korreksjon): running-state-recovery for BÅDE
 * `docker:stop_container` OG `docker:start_container` - SAMME funksjon,
 * fordi gjenopprettingsmålet UTELUKKENDE avhenger av `beforeState.status`
 * (den observerte tilstanden FØR mutasjonen), ALDRI av hvilken av de to
 * handlingene som faktisk ble utført (byggeordrens §9: "before running=true
 * -> mutation stop -> recovery -> start" / "before running=false -> mutation
 * start -> recovery -> stop"). Mål-autorisasjon håndheves av `ToolGateway.
 * execute()` selv (parameterAuthorizer) for BÅDE gjenopprettings-kallet OG
 * reinspeksjonen - INGEN direkte transport-bypass, INGEN egen sjekk her.
 * Reinspiserer ETTER for å VERIFISERE (ikke bare stole på at kallet
 * returnerte ok) - et teknisk vellykket kall som lander i feil kjøretilstand
 * er EKSPLISITT PARTIAL, aldri fabrikkert SUCCESS.
 */
const dockerRunningStateRecovery = async (ctx: RecoveryStrategyContext): Promise<RecoveryOutcome> => {
  const before = ctx.beforeState as { status?: unknown } | null;
  if (!before || typeof before.status !== "string") {
    return { status: "UNKNOWN", result: { reason: "no_before_state_captured" } };
  }
  const name = ctx.parameters["name"];
  if (typeof name !== "string") {
    return { status: "UNKNOWN", result: { reason: "missing_name_parameter" } };
  }
  const wasRunning = before.status === "running";
  const recoveryAction = wasRunning ? "start_container" : "stop_container";
  const restore = await ctx.gateway.execute({
    identity: ctx.identity, tool_id: "docker", action: recoveryAction,
    parameters: { name }, idempotency_key: `recovery:${ctx.idempotencyKey}`
  });
  if (!restore.ok) {
    return { status: "FAILED", result: { reason: restore.reason } };
  }
  const reinspected = await ctx.gateway.execute({
    identity: ctx.identity, tool_id: "docker", action: "inspect_container", parameters: { name }
  });
  if (!reinspected.ok || !reinspected.data) {
    return { status: "UNKNOWN", result: { reason: "post_recovery_verification_failed", external_id: restore.external_id ?? null } };
  }
  const resulting = reinspected.data as unknown as { status?: unknown };
  const nowRunning = resulting.status === "running";
  if (nowRunning === wasRunning) {
    return { status: "SUCCESS", result: { external_id: restore.external_id ?? null, verified_state: reinspected.data } };
  }
  return { status: "PARTIAL", result: { external_id: restore.external_id ?? null, verified_state: reinspected.data, expected_running: wasRunning } };
};

/**
 * D-104 Part D: liten, EKSPLISITT strategiregistrering - KUN registrerte
 * `tool_id:action`-kombinasjoner har en reell recovery-vei. Et ukjent kall
 * returnerer `UNKNOWN` (ALDRI fabrikkert `SUCCESS`) - se `attemptRecovery()`.
 * `github.delete_branch` er den ENESTE representative, EKTE, testede
 * recovery-casen denne sliceen (D-104-audit fant INGEN annen provider med
 * en genuin, allerede-eksisterende rollback-kapabilitet - se `preflight_
 * action: "get_branch"` i `integrations.ts`, som fanger `{name, sha}` FØR
 * sletting - AKKURAT det denne strategien trenger).
 */
const RECOVERY_STRATEGIES: Readonly<Record<string, (ctx: RecoveryStrategyContext) => Promise<RecoveryOutcome>>> = {
  "github:delete_branch": async (ctx) => {
    const before = ctx.beforeState as { name?: unknown; sha?: unknown } | null;
    if (!before || typeof before.name !== "string" || typeof before.sha !== "string") {
      return { status: "UNKNOWN", result: { reason: "no_before_state_captured" } };
    }
    const repo = ctx.parameters["repo"];
    if (typeof repo !== "string") {
      return { status: "UNKNOWN", result: { reason: "missing_repo_parameter" } };
    }
    const restore = await ctx.gateway.execute({
      identity: ctx.identity,
      tool_id: "github",
      action: "create_branch",
      parameters: { repo, branch: before.name, from_sha: before.sha },
      idempotency_key: `recovery:${ctx.idempotencyKey}`
    });
    if (restore.ok) {
      return { status: "SUCCESS", result: { external_id: restore.external_id ?? null, data: restore.data ?? null } };
    }
    return { status: "FAILED", result: { reason: restore.reason } };
  },
  /**
   * D-105 (UA-5 kriterium 3): docker-redeploy-recovery. `beforeState` er
   * `infra_executions.before_state` (fanget FØR den opprinnelige mutasjonen,
   * via preflight_action: "inspect_container") - IKKE `after_state`. Etter
   * mutasjonskallet REQUERIES tilstanden på nytt (`docker.inspect_container`,
   * klasse A) og sammenlignes MOT den opprinnelige `before.image` - byggeordrens
   * §K: "Do not define rollback as successful merely because the provider
   * call returned HTTP 200. Verify resulting state." Et kall som selv
   * returnerer ok=true men der re-inspeksjonen viser feil image/ikke-kjørende
   * status blir EKSPLISITT PARTIAL, ALDRI fabrikkert SUCCESS.
   */
  "docker:redeploy_container": async (ctx) => {
    const before = ctx.beforeState as { image?: unknown } | null;
    if (!before || typeof before.image !== "string") {
      return { status: "UNKNOWN", result: { reason: "no_before_state_captured" } };
    }
    const name = ctx.parameters["name"];
    if (typeof name !== "string") {
      return { status: "UNKNOWN", result: { reason: "missing_name_parameter" } };
    }
    const restore = await ctx.gateway.execute({
      identity: ctx.identity, tool_id: "docker", action: "redeploy_container",
      parameters: { name, image: before.image }, idempotency_key: `recovery:${ctx.idempotencyKey}`
    });
    if (!restore.ok) {
      return { status: "FAILED", result: { reason: restore.reason } };
    }
    const reinspected = await ctx.gateway.execute({
      identity: ctx.identity, tool_id: "docker", action: "inspect_container", parameters: { name }
    });
    if (!reinspected.ok || !reinspected.data) {
      return { status: "UNKNOWN", result: { reason: "post_recovery_verification_failed", external_id: restore.external_id ?? null } };
    }
    const resulting = reinspected.data as unknown as { image?: unknown; status?: unknown };
    if (resulting.image === before.image && resulting.status === "running") {
      return { status: "SUCCESS", result: { external_id: restore.external_id ?? null, verified_state: reinspected.data } };
    }
    return { status: "PARTIAL", result: { external_id: restore.external_id ?? null, verified_state: reinspected.data, expected_image: before.image } };
  },
  "docker:stop_container": dockerRunningStateRecovery,
  "docker:start_container": dockerRunningStateRecovery,
  // WP-E1: Cloudflare (DNS/WAF/sone-innstillinger) - se cloudflare-recovery.ts. Kompensasjonen leser målet fra den journalførte eksekusjonen og sjekker drift.
  ...CLOUDFLARE_RECOVERY_STRATEGIES
};

export function supportedRecoveryStrategies(): readonly string[] {
  return Object.keys(RECOVERY_STRATEGIES);
}

/**
 * Leser `before_state` fra DEN EKSISTERENDE `tool_executions`-raden (D-pipeline,
 * uendret) - INGEN egen before/after-lagringsmekanisme oppfunnet her.
 */
async function readBeforeState(pool: pg.Pool, tenantId: string, idempotencyKey: string): Promise<JsonValue | null> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT before_state FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey]
    );
    const row = rows[0] as { before_state: JsonValue | null } | undefined;
    return row?.before_state ?? null;
  });
}

/**
 * D-104 Part D: recovery-FORSØKET utføres UTELUKKENDE via `ToolGateway.
 * execute()` (ALDRI et direkte transport-kall) - dette er BEVISST, ikke en
 * stilistisk detalj: det er den ENESTE måten `InfraExecutionGate`/
 * `OwnerControls.isFrozen()`/policy/audit/rate-limit gjelder UNIFORMT også
 * for recovery-handlinger, samme vei som enhver annen mutasjon (§9/§13 i
 * byggeordren: "no silent bypass through direct adapter invocation").
 * Resultatet persisteres ALLTID (SUCCESS/PARTIAL/FAILED/UNKNOWN) - ALDRI
 * stille droppet, ALDRI en fabrikkert SUCCESS for et ukjent/mislykket forsøk.
 */
export async function attemptRecovery(
  deps: { pool: pg.Pool; gateway: ToolGateway },
  identity: IdentityContext,
  input: AttemptRecoveryInput
): Promise<InfraRecoveryAction> {
  const beforeState = await readBeforeState(deps.pool, input.tenant_id, input.idempotency_key);
  const strategyKey = `${input.tool_id}:${input.action}`;
  const strategy = RECOVERY_STRATEGIES[strategyKey];
  // WP-E1 (JARVIS-068/TSK-033): recovery bindes til den JOURNALFØRTE eksekusjonen. Kallerens verktøy/handling/mål/eksekusjons-id MÅ samsvare med den, ellers
  // utføres INGENTING (en kaller kunne ellers gjenopprette container X med container Y sin før-tilstand). Finnes det ingen journalrad for nøkkelen,
  // fungerer de eldre strategiene (github.delete_branch) som før, men Docker og Cloudflare krever journalen.
  const execution = await findExecutionByKey(deps.pool, input.tenant_id, input.idempotency_key);
  const mismatch = execution !== null && (
    execution.tool_id !== input.tool_id || execution.action !== input.action ||
    (input.execution_id !== undefined && input.execution_id !== execution.execution_id) ||
    (input.tool_id === "docker" && input.parameters["name"] !== execution.target)
  );

  let outcome: RecoveryOutcome;
  if (mismatch) {
    outcome = { status: "FAILED", result: { reason: "recovery_target_mismatch", strategy_key: strategyKey } };
  } else if (!strategy) {
    outcome = { status: "UNKNOWN", result: { reason: "no_recovery_strategy_registered", strategy_key: strategyKey } };
  } else if (execution === null && (input.tool_id === "docker" || input.tool_id === "cloudflare")) {
    outcome = { status: "UNKNOWN", result: { reason: "execution_journal_missing", strategy_key: strategyKey } };
  } else {
    outcome = await strategy({
      gateway: deps.gateway, identity, beforeState, execution,
      parameters: input.parameters, idempotencyKey: input.idempotency_key
    });
  }

  // Lenken peker på den JOURNALFØRTE eksekusjonen (aldri en kaller-oppgitt id som ikke finnes - FK-brudd ville gjort et avslått forsøk til en 500).
  const linkedExecutionId = execution?.execution_id ?? (input.execution_id ? (await getInfraExecution(deps.pool, input.tenant_id, input.execution_id))?.execution_id ?? null : null);
  return withTenantTransaction(deps.pool, input.tenant_id, async (client) => {
    const recovery_id = `inf-rec-${randomUUID()}`;
    const { rows } = await client.query(
      `INSERT INTO infra_recovery_actions
         (recovery_id, tenant_id, tool_id, action, idempotency_key, incident_id, recovery_strategy, status, recovery_result, recovery_of_execution_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        recovery_id, input.tenant_id, input.tool_id, input.action, input.idempotency_key,
        input.incident_id ?? null, strategyKey, outcome.status, JSON.stringify(outcome.result), linkedExecutionId
      ]
    );
    return rows[0] as InfraRecoveryAction;
  });
}

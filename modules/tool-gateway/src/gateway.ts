import type pg from "pg";
import { z } from "zod";
import type { CapabilityClass, IdentityContext, JobContract, JsonValue, TrustLevel } from "@jarvis/contracts";
import { withTenantTransaction, writeAudit } from "@jarvis/core";
import type { PolicyGateway } from "@jarvis/policy";

/** Secrets bak adapter (D-16): env/SOPS nå; Infisical/OpenBao (Q-05, krever Docker) senere. */
export interface SecretProvider {
  readonly name: string;
  /** Returnerer credential eller null. Verdien går ALDRI i logg/trace/modellkontekst. */
  get(ref: string): Promise<string | null>;
}
export class EnvSecretProvider implements SecretProvider {
  readonly name = "env-sops";
  async get(ref: string): Promise<string | null> {
    return process.env[ref] ?? null;
  }
}
export class InfisicalSecretProvider implements SecretProvider {
  readonly name = "infisical";
  async get(): Promise<string | null> {
    throw new Error("vault_unverified: Infisical krever Docker-miljø (Q-05/D-16)");
  }
}

/** Transport per integrasjon: ekte HTTP i drift, kontrollert fake i test. */
export interface ToolTransport {
  invoke(action: string, parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }>;
}

/** Maskinlesbar verktøydefinisjon (INTEGRATIONS.md §2). */
export interface ToolDefinition {
  tool_id: string;
  action: string;
  description: string;
  input_schema: z.ZodType<Record<string, JsonValue>>;
  capability_class: CapabilityClass;
  scopes: string[];
  reversible: boolean;
  rollback_procedure: string;
  idempotent_external: boolean;
  timeout_ms: number;
  rate_limit_per_minute: number;
  credential_ref: string;
  output_trust: TrustLevel;
  transport: ToolTransport;
}

export type ToolResult =
  | { ok: true; external_id?: string; data?: JsonValue; output_trust: TrustLevel; deduplicated: boolean }
  | { ok: false; reason: string };

/**
 * Tool Gateway: eneste vei til eksterne systemer.
 * Pipeline: IdentityContext → (jobbmandat) → Policy Gateway → rate limit →
 * idempotensdedupe → adapter → audit (credential-ref + ekstern ID, aldri selve
 * secreten) → output klassifisert som untrusted der kilden er ekstern.
 */
export class ToolGateway {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly callTimes = new Map<string, number[]>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly policy: PolicyGateway,
    private readonly secrets: SecretProvider
  ) {}

  register(definition: ToolDefinition): void {
    this.tools.set(`${definition.tool_id}:${definition.action}`, definition);
  }

  get(toolId: string, action: string): ToolDefinition | undefined {
    return this.tools.get(`${toolId}:${action}`);
  }

  async execute(request: {
    identity: IdentityContext;
    tool_id: string;
    action: string;
    parameters: Record<string, JsonValue>;
    idempotency_key?: string;
    approval?: unknown;
    /** Delegert jobb: verktøyet MÅ stå i kontraktens allowed_tools. */
    jobContract?: JobContract;
  }): Promise<ToolResult> {
    const definition = this.get(request.tool_id, request.action);
    if (!definition) {
      return this.deny(request, "unknown_tool");
    }
    if (request.jobContract && !request.jobContract.allowed_tools.includes(request.tool_id)) {
      return this.deny(request, "tool_not_in_job_contract");
    }
    const input = definition.input_schema.safeParse(request.parameters);
    if (!input.success) {
      return this.deny(request, "invalid_parameters");
    }
    const decision = await this.policy.authorize({
      identity: request.identity,
      toolCall: {
        tool_id: request.tool_id,
        action: request.action,
        capability_class: definition.capability_class,
        parameters: request.parameters
      },
      ...(request.approval !== undefined ? { approval: request.approval } : {})
    });
    if (decision.decision !== "ALLOW") {
      return this.deny(request, decision.reason);
    }
    if (!this.withinRateLimit(definition, request.identity.tenant_id)) {
      return this.deny(request, "rate_limited");
    }
    const credential = await this.secrets.get(definition.credential_ref);
    if (!credential) {
      return this.deny(request, "credential_unavailable");
    }

    return withTenantTransaction(this.pool, request.identity.tenant_id, async (client) => {
      if (request.idempotency_key) {
        const prior = await client.query(
          "SELECT external_id, status FROM tool_executions WHERE idempotency_key = $1",
          [request.idempotency_key]
        );
        const row = prior.rows[0] as { external_id: string | null; status: string } | undefined;
        if (row?.status === "succeeded") {
          await writeAudit(client, request.identity, {
            type: "tool.deduplicated", tool_id: request.tool_id, action: request.action,
            payload: { external_id: row.external_id }
          });
          return {
            ok: true,
            ...(row.external_id !== null ? { external_id: row.external_id } : {}),
            output_trust: definition.output_trust,
            deduplicated: true
          } as const;
        }
      }
      let external: { external_id?: string; data?: JsonValue };
      try {
        external = await withTimeout(
          definition.transport.invoke(request.action, request.parameters, credential),
          definition.timeout_ms
        );
      } catch (err) {
        // Kontrollert feil: revoked credential/timeout/providerfeil åpner ingenting.
        await writeAudit(client, request.identity, {
          type: "tool.failed", decision: "DENY", reason: (err as Error).message.slice(0, 120),
          tool_id: request.tool_id, action: request.action,
          capability_class: definition.capability_class,
          payload: { credential_ref: definition.credential_ref }
        });
        return { ok: false, reason: `tool_failed:${(err as Error).message.slice(0, 80)}` } as const;
      }
      if (request.idempotency_key) {
        await client.query(
          `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, external_id, status)
           VALUES ($1, $2, $3, $4, $5, 'succeeded') ON CONFLICT DO NOTHING`,
          [request.identity.tenant_id, request.idempotency_key, request.tool_id, request.action, external.external_id ?? null]
        );
      }
      await writeAudit(client, request.identity, {
        type: "tool.executed", decision: "ALLOW",
        tool_id: request.tool_id, action: request.action,
        capability_class: definition.capability_class,
        payload: {
          credential_ref: definition.credential_ref, // referanse - aldri verdien
          external_id: external.external_id ?? null,
          scopes: definition.scopes,
          rollback: definition.rollback_procedure
        }
      });
      return {
        ok: true,
        ...(external.external_id !== undefined ? { external_id: external.external_id } : {}),
        ...(external.data !== undefined ? { data: external.data } : {}),
        output_trust: definition.output_trust,
        deduplicated: false
      } as const;
    });
  }

  private async deny(
    request: { identity: IdentityContext; tool_id: string; action: string },
    reason: string
  ): Promise<ToolResult> {
    await withTenantTransaction(this.pool, request.identity.tenant_id, (client) =>
      writeAudit(client, request.identity, {
        type: "tool.denied", decision: "DENY", reason,
        tool_id: request.tool_id, action: request.action
      })
    ).catch(() => undefined);
    return { ok: false, reason };
  }

  private withinRateLimit(definition: ToolDefinition, tenantId: string): boolean {
    const key = `${definition.tool_id}:${definition.action}:${tenantId}`;
    const now = Date.now();
    const times = (this.callTimes.get(key) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= definition.rate_limit_per_minute) {
      return false;
    }
    times.push(now);
    this.callTimes.set(key, times);
    return true;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("tool_timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

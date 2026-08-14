import type pg from "pg";
import { z } from "zod";
import type { CapabilityClass, IdentityContext, JobContract, JsonValue, TrustLevel } from "@jarvis/contracts";
import { withTenantTransaction, writeAudit } from "@jarvis/core";
import type { OwnerControls, PolicyGateway } from "@jarvis/policy";

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
/**
 * Infisical-secret-provider (D-35): maskinidentitet (universal auth) → hent
 * secret via API. Rå verdi returneres KUN til transport-laget; aldri logget,
 * aldri til modell/Langfuse. Helse eksponeres for /status.
 */
export class InfisicalSecretProvider implements SecretProvider {
  readonly name = "infisical";
  private token: string | null = null;
  health: "healthy" | "unavailable" | "unconfigured" = "unconfigured";

  constructor(
    private readonly baseUrl = process.env["INFISICAL_URL"],
    private readonly clientId = process.env["INFISICAL_CLIENT_ID"],
    private readonly clientSecret = process.env["INFISICAL_CLIENT_SECRET"],
    private readonly projectId = process.env["INFISICAL_PROJECT_ID"],
    private readonly env = process.env["INFISICAL_ENV"] ?? "dev"
  ) {}

  available(): boolean {
    return Boolean(this.baseUrl && this.clientId && this.clientSecret && this.projectId);
  }

  private async login(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/v1/auth/universal-auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret })
    });
    if (!response.ok) throw new Error(`infisical_login_${response.status}`);
    return ((await response.json()) as { accessToken: string }).accessToken;
  }

  async get(ref: string): Promise<string | null> {
    if (!this.available()) {
      this.health = "unconfigured";
      return null;
    }
    try {
      this.token ??= await this.login();
      const url = `${this.baseUrl}/api/v3/secrets/raw/${encodeURIComponent(ref)}?workspaceId=${this.projectId}&environment=${this.env}`;
      const response = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
      if (response.status === 401) { this.token = null; throw new Error("infisical_auth_expired"); }
      if (response.status === 404) { this.health = "healthy"; return null; }
      if (!response.ok) throw new Error(`infisical_${response.status}`);
      this.health = "healthy";
      return ((await response.json()) as { secret: { secretValue: string } }).secret.secretValue;
    } catch {
      this.health = "unavailable";
      return null; // fail-closed her; FallbackSecretProvider håndterer rollback
    }
  }
}

/**
 * Staged migration (D-35): prøv primær (vault) først, fall tilbake til .env
 * hvis vault mangler verdien eller er nede. Gir trygg rollback i overgangen.
 */
export class FallbackSecretProvider implements SecretProvider {
  readonly name = "fallback";
  constructor(
    private readonly primary: SecretProvider,
    private readonly fallback: SecretProvider
  ) {}
  async get(ref: string): Promise<string | null> {
    return (await this.primary.get(ref)) ?? this.fallback.get(ref);
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
  /** v4.0 D-pipeline: handling som leser nå-tilstand for preflight + readback (før/etter-evidens). */
  preflight_action?: string;
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
  /** BO-03: connector-health per tool_id (healthy/degraded/auth_failed/rate_limited/unavailable). */
  readonly health = new Map<string, { state: string; at: string; detail?: string }>();
  private setHealth(toolId: string, state: string, detail?: string): void {
    this.health.set(toolId, { state, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
  }
  private readonly callTimes = new Map<string, number[]>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly policy: PolicyGateway,
    private readonly secrets: SecretProvider,
    private readonly controls?: OwnerControls
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
    if (this.controls?.isFrozen(request.tool_id)) {
      return this.deny(request, "connector_frozen");
    }
    if (this.controls?.isRevoked(definition.credential_ref)) {
      return this.deny(request, "credential_revoked");
    }
    const credential = await this.secrets.get(definition.credential_ref);
    if (!credential) {
      return this.deny(request, "credential_unavailable");
    }

    // v4.0 D-pipeline: for høyrisiko (C/D) med definert preflight leses
    // nå-tilstanden FØR handlingen (deterministisk preflight + recovery-
    // grunnlag) og PÅ NYTT etterpå (readback/before-after-evidens).
    // Preflight-feil på klasse D er fail-closed.
    let beforeState: JsonValue | null = null;
    const needsEvidence = (definition.capability_class === "C" || definition.capability_class === "D") && definition.preflight_action;
    if (needsEvidence) {
      try {
        const pre = await definition.transport.invoke(definition.preflight_action!, request.parameters, credential);
        beforeState = pre.data ?? null;
      } catch (err) {
        if (definition.capability_class === "D") {
          return this.deny(request, `preflight_failed:${(err as Error).message.slice(0, 60)}`);
        }
      }
    }

    // Q-18 (D-30 host-akseptanse): tool_executions-dedupe finnes for å hindre
    // dobbel SIDE-EFFEKT på C/D-mutasjoner (§21/§19 i BO-11) - A-klasse READs
    // har ingen side-effekt å beskytte mot duplisering, og data kan ha endret
    // seg mellom to spørringer (f.eks. to "hva står på kalenderen"-spørsmål i
    // samme langtlevende voice-session). Dedupe på database-/session-nivå
    // gjelder derfor KUN C/D. Beskyttelse mot at MODELLEN utfører samme
    // semantiske kall flere ganger i ÉN modellrunde/samtaletur er uendret og
    // håndheves separat (in-memory `executed`-cache i
    // ModelGateway.completeWithTools, modules/model-gateway/src/model-gateway.ts).
    const dedupeApplies = definition.capability_class !== "A";
    return withTenantTransaction(this.pool, request.identity.tenant_id, async (client) => {
      if (dedupeApplies && request.idempotency_key) {
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
        const message = (err as Error).message;
        this.setHealth(request.tool_id,
          /401|403|auth/.test(message) ? "auth_failed" : /429|rate/.test(message) ? "rate_limited" : "unavailable",
          message.slice(0, 60));
        // Kontrollert feil: revoked credential/timeout/providerfeil åpner ingenting.
        await writeAudit(client, request.identity, {
          type: "tool.failed", decision: "DENY", reason: (err as Error).message.slice(0, 120),
          tool_id: request.tool_id, action: request.action,
          capability_class: definition.capability_class,
          payload: { credential_ref: definition.credential_ref }
        });
        return { ok: false, reason: `tool_failed:${(err as Error).message.slice(0, 80)}` } as const;
      }
      let afterState: JsonValue | null = null;
      if (needsEvidence) {
        try {
          const post = await definition.transport.invoke(definition.preflight_action!, request.parameters, credential);
          afterState = post.data ?? null;
        } catch {
          afterState = null; // readback-feil skjuler aldri at handlingen skjedde - audit under
        }
      }
      if (dedupeApplies && request.idempotency_key) {
        await client.query(
          `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, external_id, status, before_state, after_state)
           VALUES ($1, $2, $3, $4, $5, 'succeeded', $6, $7) ON CONFLICT DO NOTHING`,
          [request.identity.tenant_id, request.idempotency_key, request.tool_id, request.action,
           external.external_id ?? null, JSON.stringify(beforeState), JSON.stringify(afterState)]
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
          rollback: definition.rollback_procedure,
          ...(needsEvidence ? { before_state: beforeState, after_state: afterState, recovery: { snapshot: beforeState, procedure: definition.rollback_procedure } } : {})
        }
      });
      this.setHealth(request.tool_id, "healthy");
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

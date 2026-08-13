import {
  IdentityContextSchema,
  ToolCallSchema,
  type IdentityContext,
  type ToolCall
} from "@jarvis/contracts";
import { verifyApproval } from "./approval-verifier.ts";
import { resolveAuthorityMode, type AuthorityConfig, type OwnerControls } from "./authority.ts";
import type { DeviceRegistry } from "./device-registry.ts";
import { KillSwitch } from "./kill-switch.ts";
import type { NonceStore } from "./nonce-store.ts";

export type Decision = "ALLOW" | "DENY";

export interface AuthorizationResult {
  decision: Decision;
  /** Maskinlesbar årsak - logges alltid til audit. */
  reason: string;
}

export interface AuthorizationRequest {
  identity: IdentityContext;
  toolCall: ToolCall;
  /** Kreves for klasse D. Ignoreres ikke for andre klasser hvis oppgitt, men er ikke påkrevd. */
  approval?: unknown;
}

/** Audit-hendelse fra Policy Gateway. Append-only sink; ekstern lagring fra fase 2. */
export interface PolicyAuditEvent {
  at: string;
  decision: Decision;
  reason: string;
  person_id: string;
  tenant_id: string;
  session_id: string;
  tool_id: string;
  action: string;
  capability_class: string;
}

export interface PolicyGatewayOptions {
  devices: DeviceRegistry;
  nonces: NonceStore;
  killSwitch: KillSwitch;
  /** Mandater for klasse C i fase 1: liste av "tool_id:action" som er eksplisitt tillatt. */
  mandates?: ReadonlySet<string>;
  /** v4.0: sovereign owner-modus. Uten config gjelder legacy-reglene uendret. */
  authority?: AuthorityConfig;
  /** v4.0: owner-kontroller (freeze/revoke) håndhevet i execution path. */
  controls?: OwnerControls;
  auditSink?: (event: PolicyAuditEvent) => void;
  clock?: () => Date;
}

/**
 * Deterministisk Policy Gateway (SECURITY_MODEL §4) - fase 1-skjelett.
 * ALLE verktøykall skal gjennom authorize(); rask bane hopper over LLM,
 * aldri over policyen. Ingen LLM brukes i sikkerhetsavgjørelser.
 */
export class PolicyGateway {
  private readonly devices: DeviceRegistry;
  private readonly nonces: NonceStore;
  private readonly killSwitch: KillSwitch;
  private readonly mandates: ReadonlySet<string>;
  private readonly auditSink: (event: PolicyAuditEvent) => void;
  private readonly clock: () => Date;
  readonly auditLog: PolicyAuditEvent[] = [];
  private readonly opts: PolicyGatewayOptions;

  constructor(options: PolicyGatewayOptions) {
    this.opts = options;
    this.devices = options.devices;
    this.nonces = options.nonces;
    this.killSwitch = options.killSwitch;
    this.mandates = options.mandates ?? new Set();
    this.clock = options.clock ?? (() => new Date());
    this.auditSink = options.auditSink ?? ((event) => this.auditLog.push(event));
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationResult> {
    // Kontraktvalidering først: ugyldig input er alltid DENY, aldri unntak videre opp.
    const identity = IdentityContextSchema.safeParse(request.identity);
    if (!identity.success) {
      return this.finish(request, "DENY", "invalid_identity_context");
    }
    const toolCall = ToolCallSchema.safeParse(request.toolCall);
    if (!toolCall.success) {
      return this.finish(request, "DENY", "invalid_tool_call");
    }

    if (this.killSwitch.isActive()) {
      return this.finish(request, "DENY", "kill_switch_active");
    }
    if (this.opts?.controls?.isFrozen(toolCall.data.tool_id)) {
      return this.finish(request, "DENY", "connector_frozen");
    }
    // v4.0: A-D er risikoklasser. SOVEREIGN owner-modus gir autonom utførelse;
    // sikkerheten leveres av D-pipelinen (preflight/readback/evidens/recovery)
    // i Tool Gateway + owner-kontrollene over - ikke av approval-friksjon.
    const mode = resolveAuthorityMode(this.opts?.authority, identity.data);

    switch (toolCall.data.capability_class) {
      case "A":
        return this.finish(request, "ALLOW", "class_a_read");
      case "B": {
        if (identity.data.auth_strength === "passive" && mode !== "SOVEREIGN") {
          return this.finish(request, "DENY", "class_b_requires_active_auth");
        }
        return this.finish(request, "ALLOW", "class_b_reversible_internal");
      }
      case "C": {
        if (mode === "SOVEREIGN") {
          return this.finish(request, "ALLOW", "class_c_sovereign_authority");
        }
        const mandateKey = `${toolCall.data.tool_id}:${toolCall.data.action}`;
        if (!this.mandates.has(mandateKey)) {
          return this.finish(request, "DENY", "class_c_no_mandate");
        }
        return this.finish(request, "ALLOW", "class_c_within_mandate");
      }
      case "D": {
        if (mode === "SOVEREIGN" && request.approval === undefined) {
          return this.finish(request, "ALLOW", "class_d_sovereign_authority");
        }
        // Approval-systemet beholdes: brukes for scoped tenants/delegater, og
        // valgfritt for owner når en approval faktisk sendes med.
        return this.authorizeClassD(request, toolCall.data);
      }
    }
  }

  private async authorizeClassD(
    request: AuthorizationRequest,
    toolCall: ToolCall
  ): Promise<AuthorizationResult> {
    if (request.approval === undefined) {
      return this.finish(request, "DENY", "class_d_missing_approval");
    }
    const check = verifyApproval(
      request.approval,
      { action: toolCall.action, parameters: toolCall.parameters },
      this.devices,
      this.clock()
    );
    if (!check.valid) {
      return this.finish(request, "DENY", `class_d_${check.reason}`);
    }
    // Alle kontroller OK - forbruk engangs-ID-en som aller siste steg (replay-vern).
    // Feil i lageret er DENY (fail-closed): usikkerhet gir aldri ALLOW.
    const approval = request.approval as {
      nonce: string;
      action: string;
      parameters: Record<string, never>;
      approving_device_id: string;
      expires_at: string;
    };
    let firstUse: boolean;
    try {
      firstUse = await this.nonces.consume({
        nonce: approval.nonce,
        tenant_id: request.identity.tenant_id,
        action: approval.action,
        parameters: approval.parameters,
        approving_device_id: approval.approving_device_id,
        expires_at: approval.expires_at
      });
    } catch {
      return this.finish(request, "DENY", "class_d_nonce_store_error");
    }
    if (!firstUse) {
      return this.finish(request, "DENY", "class_d_nonce_already_used");
    }
    return this.finish(request, "ALLOW", "class_d_valid_signed_approval");
  }

  private finish(request: AuthorizationRequest, decision: Decision, reason: string): AuthorizationResult {
    this.auditSink({
      at: this.clock().toISOString(),
      decision,
      reason,
      person_id: request.identity?.person_id ?? "unknown",
      tenant_id: request.identity?.tenant_id ?? "unknown",
      session_id: request.identity?.session_id ?? "unknown",
      tool_id: request.toolCall?.tool_id ?? "unknown",
      action: request.toolCall?.action ?? "unknown",
      capability_class: request.toolCall?.capability_class ?? "unknown"
    });
    return { decision, reason };
  }
}

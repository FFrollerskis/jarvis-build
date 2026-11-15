import type { ActionSpec, ConnectorManifest } from "../src/manifest.ts";

/**
 * Testfixtur: en FIKTIV leverandør («Acme Tasks») - ingen ekte leverandør, ingen ekte verdier. Brukes av manifest-, derivasjons-, vakt- og kontraktstestene.
 * Fem handlinger som dekker hele spennet: lesing (A), intern skriving (B), utsending (C), sletting (C) og en klasse D-innstilling.
 */
export const ACME_KEYS = {
  list: "acme.list_tasks",
  create: "acme.create_task",
  notify: "acme.notify_owner",
  remove: "acme.delete_task",
  setting: "acme.update_setting"
} as const;

function action(partial: Pick<ActionSpec, "key" | "kind" | "effect"> & { authority: ActionSpec["authority"]; reversibility: ActionSpec["reversibility"]; idempotency: ActionSpec["idempotency"]; trust: ActionSpec["trust"] }): ActionSpec {
  return { ...partial, limits: { rate_limit_per_minute: 30 }, operations: { timeout_ms: 10_000 }, data: { input_required: [], identity_fields: [] } };
}

export function acmeActions(): ActionSpec[] {
  return [
    action({
      key: ACME_KEYS.list, kind: "read", effect: "read",
      authority: { risk_class: "A", step_up_required: false, owner_only: false },
      reversibility: { reversible: true, rollback_method: "none", rollback_procedure: "ingen (lesing)", compensating_action: null, destructive: false, evidence: { before_state: false, postcondition: "none" } },
      idempotency: { requirement: "none", provider_idempotent: true }, trust: { output: "untrusted" }
    }),
    action({
      key: ACME_KEYS.create, kind: "write", effect: "write",
      authority: { risk_class: "B", step_up_required: false, owner_only: false },
      reversibility: { reversible: true, rollback_method: "compensating_action", rollback_procedure: "slett oppgaven (acme.delete_task)", compensating_action: "acme.delete_task på external_id fra svaret", destructive: false, evidence: { before_state: false, postcondition: "readback" } },
      idempotency: { requirement: "recommended", provider_idempotent: false }, trust: { output: "internal" }
    }),
    action({
      key: ACME_KEYS.notify, kind: "action", effect: "send",
      authority: { risk_class: "C", step_up_required: false, owner_only: true },
      reversibility: { reversible: false, rollback_method: "none", rollback_procedure: "ingen: en sendt melding kan ikke trekkes tilbake", compensating_action: null, destructive: true, evidence: { before_state: false, postcondition: "provider_id" } },
      idempotency: { requirement: "required", provider_idempotent: false }, trust: { output: "internal" }
    }),
    action({
      key: ACME_KEYS.remove, kind: "write", effect: "delete",
      authority: { risk_class: "C", step_up_required: false, owner_only: false },
      reversibility: { reversible: true, rollback_method: "restore_from_snapshot", rollback_procedure: "gjenskap oppgaven fra before_state i journalen", compensating_action: null, destructive: true, evidence: { before_state: true, postcondition: "readback" } },
      idempotency: { requirement: "recommended", provider_idempotent: true }, trust: { output: "internal" }
    }),
    action({
      key: ACME_KEYS.setting, kind: "write", effect: "write",
      authority: { risk_class: "D", step_up_required: true, owner_only: true },
      reversibility: { reversible: true, rollback_method: "provider_revert", rollback_procedure: "sett tilbake innstillingen fra før-tilstanden", compensating_action: null, destructive: false, evidence: { before_state: true, postcondition: "readback" }, class_d_chain: { status: "complete", missing: [] } },
      idempotency: { requirement: "required", provider_idempotent: true }, trust: { output: "internal" }
    })
  ];
}

/** Et gyldig FULLT manifest. Hver test kopierer det (`structuredClone`) og endrer nøyaktig ett felt. */
export function validFullManifest(): ConnectorManifest {
  const actions = acmeActions();
  return {
    schema_version: "1",
    completeness: "full",
    source: "authored",
    identity: {
      id: "acme_tasks", name: "Acme Tasks", vendor: "Acme Corp (fiktiv)",
      version: { manifest: "1.0.0", provider_api: "Acme REST v1" },
      owner: { kind: "tenant_owner", ref: "owner" },
      environment: { deployment: "production", sandbox: { available: true, description: "eget testprosjekt hos leverandøren" } }
    },
    auth: {
      type: "api_key",
      scopes: {
        declared_by_actions: ["acme.read", "acme.write"],
        provider: [{ scope: "tasks:read", needed_for: [ACME_KEYS.list] }, { scope: "tasks:write", needed_for: [ACME_KEYS.create, ACME_KEYS.remove, ACME_KEYS.setting, ACME_KEYS.notify] }]
      },
      rotation: { credential_kind: "api_key", method: "manual", interval_days: 90, note: "eieren roterer nøkkelen hos leverandøren og limer den inn i dashbordet" }
    },
    capabilities: {
      read: { status: "implemented" },
      write: { status: "implemented" },
      actions: { status: "implemented" },
      webhooks: { status: "deferred", items: [], note: "leverandøren tilbyr webhooks; ikke bygget" },
      sync: { status: "not_implemented", items: [] },
      search: { status: "not_implemented", items: [] }
    },
    authority: {
      owner: { mode: "sovereign", credential_binding: "owner_bound" },
      delegated: { mode: "approval_required" },
      tenant: { binding: "owner_tenants" },
      approval_policy: { step_up_actions: [ACME_KEYS.setting], delegated_class_cd: "signed_approval_required" }
    },
    reversibility: { snapshot_support: "before_state_in_ledger" },
    idempotency: {
      dedupe_key: "jarvis_idempotency_key",
      retry_semantics: { on_timeout: "reconcile_before_retry", on_rate_limit: "retry_after", on_server_error: "reconcile_before_retry" },
      exactly_once_target: "exactly_once"
    },
    limits: { rate_limits: "leverandøren begrenser til 100 kall/min per nøkkel", quotas: "ingen kjente kvoter" },
    trust: { output: { class: "untrusted" }, injection_exposure: { level: "possible", note: "oppgavetitler og beskrivelser er skrevet av tredjeparter" }, sanitization: { methods: ["output_trust=untrusted på lesehandlinger", "central hemmelighetsskanner på feiltekst"] } },
    data: {
      schemas: { input: "zod input_schema i ToolDefinition", output: "hvitlistet per ressurs" },
      provenance: { origin: "provider", tagging: "external_id + tool.executed-revisjon (person/tenant/task_id)" },
      freshness: { model: "live_read" },
      retention: { stored_by_jarvis: ["audit_metadata", "before_after_ledger"] },
      delete_semantics: { provider_side: "supported", jarvis_side: "revisjon beholdes etter retensjonsregelen; ingen kopi av innholdet" }
    },
    operations: {
      health_check: { method: "live_probe", action_key: ACME_KEYS.list, cadence: "daglig helsesveip" },
      timeout: { max_ms: 10_000 },
      circuit_breaker: { status: "partial", mechanism: "manuell pause (frys) via eierkontrollene; ingen automatisk bryter" },
      metrics: { sources: ["ToolGateway.health", "audit_events tool.executed/tool.failed"] },
      runbook: { path: "docs/runbooks/WPI_CONNECTOR_SDK.md" },
      maintenance_owner: { role: "owner", ledger: "connector_maintenance_log" }
    },
    secrets: { refs: [{ ref: "ACME_API_TOKEN", required: true, purpose: "API-nøkkel mot Acme" }], model_visibility: "never" },
    tests: {
      fake_adapter: { status: "present", paths: ["modules/connector-sdk/test/fixtures.ts"] },
      contract: { status: "present", paths: ["modules/connector-sdk/test/manifest-schema.test.ts"] },
      live_smoke: { status: "not_run", paths: [], note: "krever sandbox-prosjekt hos leverandøren" },
      authority: { status: "partial", paths: [] },
      recovery: { status: "partial", paths: [] },
      security: { status: "partial", paths: [] }
    },
    d41_audit: {
      classification: "PARTIAL",
      read: { provider_offers: "yes", implemented: "full", action_keys: [ACME_KEYS.list] },
      write: { provider_offers: "yes", implemented: "full", action_keys: [ACME_KEYS.create, ACME_KEYS.setting, ACME_KEYS.notify] },
      delete: { provider_offers: "yes", implemented: "full", action_keys: [ACME_KEYS.remove] },
      access_control: { provider_offers: "yes", implemented: "none", action_keys: [], note: "deling/medlemmer er ikke bygget" },
      scopes_verified_against_docs: true,
      unverified_scopes: [],
      verified_on: "2026-11-14",
      docs_reference: ["Acme API-referanse (fiktiv): tasks, settings"],
      gaps: [{ capability: "tilgangsstyring (medlemmer/deling)", status: "DEFERRED", reason: "krever egen eierbeslutning" }]
    },
    core_boundary: { system_of_record: "EXTERNAL_CANONICAL", basis: "audited", external_role: "kilde og utførelsesleverandør for oppgaver", core_dependency_decision_required: false },
    actions
  };
}

/** Et gyldig SKELETON (som `derive.ts` ville produsert): alt som ikke kan avledes er en `Unknown`-markør. */
export function validSkeletonManifest(): ConnectorManifest {
  const full = structuredClone(validFullManifest());
  const u = (reason: string) => ({ unknown: true as const, reason });
  return {
    ...full,
    completeness: "skeleton",
    source: "derived_from_registry",
    identity: { ...full.identity, vendor: u("ikke avledbart"), version: { manifest: "0.0.0-derived", provider_api: u("ikke avledbart") }, environment: u("ikke avledbart") },
    auth: { scopes: { declared_by_actions: full.auth.scopes.declared_by_actions, provider: u("ikke avledbart") }, type: u("ikke avledbart"), rotation: u("ikke avledbart") },
    capabilities: { ...full.capabilities, webhooks: u("ikke avledbart"), sync: u("ikke avledbart") },
    authority: { owner: u("ikke avledbart"), delegated: u("ikke avledbart"), tenant: u("ikke avledbart") },
    reversibility: { snapshot_support: u("ikke avledbart") },
    idempotency: { dedupe_key: "jarvis_idempotency_key", retry_semantics: u("ikke avledbart"), exactly_once_target: u("ikke avledbart") },
    limits: { rate_limits: u("ikke avledbart"), quotas: u("ikke avledbart") },
    trust: { output: full.trust.output, injection_exposure: { level: "possible" }, sanitization: u("ikke avledbart") },
    data: { schemas: u("ikke avledbart"), provenance: u("ikke avledbart"), freshness: u("ikke avledbart"), retention: u("ikke avledbart"), delete_semantics: u("ikke avledbart") },
    operations: { health_check: full.operations.health_check, timeout: full.operations.timeout, circuit_breaker: u("ikke avledbart"), metrics: u("ikke avledbart"), runbook: u("ikke avledbart"), maintenance_owner: u("ikke avledbart") },
    tests: { fake_adapter: u("ikke avledbart"), contract: u("ikke avledbart"), live_smoke: u("ikke avledbart"), authority: u("ikke avledbart"), recovery: u("ikke avledbart"), security: u("ikke avledbart") },
    d41_audit: u("D-41-revisjonen er en leverandørvurdering"),
    core_boundary: { system_of_record: "EXTERNAL_CANONICAL", basis: "derived_default", external_role: u("ikke avledbart"), core_dependency_decision_required: false },
    actions: full.actions.map((a) => ({ ...a, reversibility: { ...a.reversibility, rollback_method: u("ikke avledbart"), compensating_action: u("ikke avledbart") } }))
  };
}

/**
 * Hemmelighetsformede strengene bygges ved KJØRING (aldri som bokstaver i kilden), så gitleaks aldri ser en nøkkelform i repoet (CLAUDE.md regel 1 / fellesbrief §2.2).
 * Verdiene er rene fyllstoff-tegn og tilhører ingen ekte konto.
 */
export const fakeSecretShapes = {
  githubToken: () => `ghp_${"a1".repeat(18)}`,
  bearer: () => `Bearer ${"x9".repeat(12)}`,
  awsKey: () => `AKIA${"B7".repeat(8)}`,
  stripeKey: () => `sk_live_${"c3".repeat(12)}`,
  url: () => `postgres://admin:${"pw0".repeat(4)}@db.example.test/app`
};

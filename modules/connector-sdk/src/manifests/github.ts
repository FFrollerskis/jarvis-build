import { mutationAction, readAction, maxTimeoutMs, strictestTrust } from "../builders.ts";
import type { ConnectorManifest } from "../manifest.ts";

/**
 * WP-I (D-472): FULLT, håndskrevet referansemanifest for GitHub (`CONNECTOR_REGISTRY` id `github`). Kilder (alle i repoet): `docs/runbooks/GITHUB_APP.md` (rettighetsmatrisen, verifisert mot
 * GitHubs åpne docs-repo 2026-10-09), `modules/tool-gateway/src/github-rate-limit-controller.ts` (D-97), D-94 (23-handlings D-41-matrisen), D-450/Q-50 B (repo-lås), `docs/ARCHITECTURE.md` §11.9
 * (D-64-revisjonen: GitHub = adapter, EXTERNAL_CANONICAL). Alt som kan avledes av registeret SJEKKES mot det (`checkManifestAgainstDerived`); resten er narrativ som gjennomgås av et menneske.
 *
 * STATUS: BUILT_UNWIRED. Manifestet beskriver connectoren; det styrer ingenting i kjøretiden. Ingenting er kjørt mot ekte GitHub (live smoke `BLOCKED_EXTERNAL`: krever eierens credential).
 */
const R = { rate30: 30, rate60: 60, t: 10_000 } as const;

const actions = [
  readAction("github.get_branch", { rate: R.rate60, timeout: R.t, required: ["branch"] }),
  readAction("github.get_commit", { rate: R.rate30, timeout: R.t, required: ["ref"] }),
  readAction("github.get_pull_request", { rate: R.rate60, timeout: R.t, required: ["pr_number"] }),
  readAction("github.get_workflow_run", { rate: R.rate60, timeout: R.t, required: ["repo", "run_id"] }),
  readAction("github.list_branches", { rate: R.rate30, timeout: R.t }),
  readAction("github.list_pull_requests", { rate: R.rate30, timeout: R.t }),
  readAction("github.list_workflow_jobs", { rate: R.rate60, timeout: R.t, required: ["run_id"] }),
  readAction("github.list_workflow_runs", { rate: R.rate30, timeout: R.t }),
  readAction("github.read_issues", { rate: R.rate30, timeout: R.t, required: ["repo"] }),
  readAction("github.read_repo_meta", { rate: R.rate30, timeout: R.t }),

  mutationAction("github.cancel_workflow_run", {
    effect: "send", risk: "C", rate: 10, timeout: 15_000, idempotency: "required", provider_idempotent: false, reversible: true,
    rollback_method: "compensating_action", rollback_procedure: "github.rerun_workflow_run", compensating_action: "github.rerun_workflow_run på samme kjøring",
    before_state: false, postcondition: "none", required: ["repo", "run_id"]
  }),
  mutationAction("github.comment_on_issue", {
    effect: "send", risk: "C", rate: 20, timeout: 10_000, idempotency: "required", provider_idempotent: false, reversible: true,
    rollback_method: "manual", rollback_procedure: "ingen automatisk sletting av kommentaren bygget - manuell oppfølging",
    before_state: false, postcondition: "none", required: ["body", "issue_number", "repo"]
  }),
  mutationAction("github.create_branch", {
    effect: "write", risk: "B", rate: 20, timeout: 10_000, idempotency: "recommended", provider_idempotent: true, reversible: true,
    rollback_method: "compensating_action", rollback_procedure: "github.delete_branch", compensating_action: "github.delete_branch på den opprettede branchen",
    before_state: false, postcondition: "none", required: ["branch", "from_sha", "repo"]
  }),
  mutationAction("github.create_issue", {
    effect: "write", risk: "B", rate: 15, timeout: 10_000, idempotency: "recommended", provider_idempotent: false, reversible: true,
    rollback_method: "compensating_action", rollback_procedure: "github.update_issue med state=closed", compensating_action: "github.update_issue med state=closed",
    before_state: false, postcondition: "none", required: ["repo", "title"]
  }),
  mutationAction("github.create_pr", {
    effect: "write", risk: "C", rate: 10, timeout: 15_000, idempotency: "recommended", provider_idempotent: true, reversible: true,
    rollback_method: "compensating_action", rollback_procedure: "lukk PR (github.update_pr med state=closed)", compensating_action: "github.update_pr med state=closed",
    before_state: false, postcondition: "none", required: ["branch", "repo", "title"]
  }),
  mutationAction("github.delete_branch", {
    effect: "delete", risk: "D", rate: 10, timeout: 10_000, idempotency: "required", provider_idempotent: false, reversible: true,
    rollback_method: "compensating_action", rollback_procedure: "gjenopprett branchen fra sha-en get_branch (preflight) fanget FØR sletting, via github.create_branch",
    compensating_action: "github.create_branch fra sha-en lagret i before_state", before_state: true, postcondition: "readback", required: ["branch", "repo"]
  }),
  mutationAction("github.dispatch_workflow", {
    effect: "send", risk: "C", rate: 10, timeout: 15_000, idempotency: "required", provider_idempotent: false, reversible: true,
    rollback_method: "compensating_action", rollback_procedure: "github.cancel_workflow_run på den utløste kjøringen", compensating_action: "github.cancel_workflow_run på den utløste kjøringen",
    before_state: false, postcondition: "none", required: ["ref", "repo", "workflow_id"]
  }),
  mutationAction("github.merge_pr", {
    effect: "control", risk: "D", rate: 5, timeout: 15_000, idempotency: "required", provider_idempotent: false, reversible: false,
    rollback_method: "manual", rollback_procedure: "IKKE en ekte 'unmerge' - opprett en revert-PR (github.create_pr fra en revert-commit) og merge den, ELLER github.update_pr for å dokumentere avviket. Ikke reverserbar - derfor klasse D.",
    compensating_action: "revert-PR (github.create_pr fra en revert-commit) som merges - manuelt, aldri en stille reversering",
    before_state: true, postcondition: "readback", required: ["pr_number", "repo"]
  }),
  mutationAction("github.request_reviewers", {
    effect: "write", risk: "B", rate: 20, timeout: 10_000, idempotency: "recommended", provider_idempotent: true, reversible: true,
    rollback_method: "manual", rollback_procedure: "fjern forespørselen manuelt via GitHub (ingen egen remove-handling bygget denne sliceen)",
    before_state: false, postcondition: "none", required: ["pr_number", "repo", "reviewers"]
  }),
  mutationAction("github.rerun_workflow_run", {
    effect: "send", risk: "C", rate: 10, timeout: 15_000, idempotency: "required", provider_idempotent: false, reversible: true,
    rollback_method: "compensating_action", rollback_procedure: "github.cancel_workflow_run", compensating_action: "github.cancel_workflow_run på den nye kjøringen",
    before_state: false, postcondition: "none", required: ["repo", "run_id"]
  }),
  mutationAction("github.set_labels", {
    effect: "write", risk: "B", rate: 30, timeout: 10_000, idempotency: "recommended", provider_idempotent: true, reversible: true,
    rollback_method: "compensating_action", rollback_procedure: "sett tilbake til forrige label-sett via et nytt set_labels-kall", compensating_action: "set_labels med forrige label-sett",
    before_state: false, postcondition: "none", required: ["issue_number", "labels", "repo"]
  }),
  mutationAction("github.update_issue", {
    effect: "write", risk: "B", rate: 20, timeout: 10_000, idempotency: "recommended", provider_idempotent: true, reversible: true,
    rollback_method: "compensating_action", rollback_procedure: "sett feltene tilbake til forrige verdi via et nytt update_issue-kall", compensating_action: "update_issue med forrige verdier",
    before_state: false, postcondition: "none", required: ["issue_number", "repo"]
  }),
  mutationAction("github.update_pr", {
    effect: "write", risk: "B", rate: 20, timeout: 10_000, idempotency: "recommended", provider_idempotent: true, reversible: true,
    rollback_method: "compensating_action", rollback_procedure: "sett feltene tilbake til forrige verdi via et nytt update_pr-kall", compensating_action: "update_pr med forrige verdier",
    before_state: false, postcondition: "none", required: ["pr_number", "repo"]
  })
];

const READS = actions.filter((a) => a.kind === "read").map((a) => a.key);

export const GITHUB_MANIFEST: ConnectorManifest = {
  schema_version: "1",
  completeness: "full",
  source: "authored",
  identity: {
    id: "github", name: "GitHub", vendor: "GitHub",
    version: { manifest: "1.0.0", provider_api: "GitHub REST API, X-GitHub-Api-Version 2022-11-28" },
    owner: { kind: "tenant_owner", ref: "owner" },
    environment: {
      deployment: "production",
      sandbox: { available: true, description: "kjøre-unik test-branch og test-issue i eierens eget repo (ua5-github-live.ts); aldri main/master/production (GITHUB_PROTECTED_BRANCHES); merge_pr og dispatch_workflow forsøkes bevisst ikke i live-test" }
    }
  },
  auth: {
    type: "api_key",
    alternatives: ["app_installation"],
    scopes: {
      declared_by_actions: ["actions:write", "repo:merge", "repo:read", "repo:write", "repo:write-pr"],
      provider: [
        { scope: "Metadata (read-only, gis alltid)", needed_for: ["github.read_repo_meta"] },
        { scope: "Contents (read and write)", needed_for: ["github.list_branches", "github.get_branch", "github.get_commit", "github.create_branch", "github.delete_branch", "github.merge_pr"] },
        { scope: "Pull requests (read and write)", needed_for: ["github.list_pull_requests", "github.get_pull_request", "github.create_pr", "github.update_pr", "github.request_reviewers"] },
        { scope: "Issues (read and write)", needed_for: ["github.read_issues", "github.create_issue", "github.update_issue", "github.set_labels", "github.comment_on_issue"] },
        { scope: "Actions (read and write)", needed_for: ["github.list_workflow_runs", "github.get_workflow_run", "github.list_workflow_jobs", "github.rerun_workflow_run", "github.cancel_workflow_run", "github.dispatch_workflow"] }
      ]
    },
    rotation: {
      credential_kind: "api_key", method: "manual",
      note: "PAT roteres av eieren. GitHub App-installasjonstoken (WP-C3) er kortlevd (1 time), repo-scopet og fornyes automatisk 5 min før utløp; selve privatnøkkelen roteres manuelt. Utløpsdato er ikke overvåket (EV-17 måler ikke utløp)."
    }
  },
  capabilities: {
    read: { status: "implemented" },
    write: { status: "implemented" },
    actions: { status: "implemented" },
    webhooks: { status: "deferred", items: [], note: "GitHub App-oppsettet har webhooks AV; innkommende hendelser er ikke bygget (D-41-gap)" },
    sync: { status: "not_implemented", items: [], note: "ingen daglig synk-jobb mot GitHub-handlingene; kunnskapskilden for GitHub (WP-D1) er en separat, sovende leser" },
    search: { status: "not_implemented", items: [], note: "ingen søke-handling bygget; leverandørens søke-API er ikke vurdert i denne revisjonen" }
  },
  authority: {
    owner: {
      mode: "sovereign", credential_binding: "owner_bound",
      note: "leverandør-credentialen er bundet til den autentiserte eieren (CredentialBinding, D-377). Kjent gap (CLOSURE_MATRIX UA-5): de eldre klasse D-handlingene merge_pr og delete_branch har ikke step_up_required."
    },
    delegated: { mode: "denied", note: "en delegert/ikke-eier identitet får credential_not_bound_to_identity; ingen egen godkjenningsvei for delegater er bygget" },
    tenant: { binding: "owner_tenants", note: "ingen tenant-parametre i skjemaene; repo-skopet av JARVIS_GITHUB_REPO (Q-50 B: modell-/jobbstyrte lesinger er låst til repoet, eieren kan slå låsen av)" }
  },
  reversibility: { snapshot_support: "before_state_in_ledger" },
  idempotency: {
    dedupe_key: "jarvis_idempotency_key",
    retry_semantics: {
      on_timeout: "reconcile_before_retry", on_rate_limit: "retry_after", on_server_error: "reconcile_before_retry",
      note: "KJENT GAP (PARTIAL): transporten gjentar aldri en mutasjon ved 5xx (D-392), men melder heller ikke outcome_unknown (kun gateway-tidsavbrudd gir ukjent utfall); for handlinger uten leverandør-idempotens (create_issue, comment_on_issue, rerun/cancel/dispatch) kan en kaller som prøver på nytt etter kastet leverandørfeil i teorien dobbeltutføre"
    },
    exactly_once_target: "at_most_once"
  },
  limits: {
    rate_limits: "GitHub primær rate limit (PAT per bruker; installasjonstoken minimum 5000/time, opptil 12500/time) og sekundær throttling; Jarvis' rate-limit-kontroller (D-97) og per-handling-grenser på 5-60 kall/min",
    quotas: "ingen kjente kvoter utover rate limit"
  },
  trust: {
    output: { class: strictestTrust(actions) },
    injection_exposure: { level: "high", note: "issue-, PR-, commit- og kjøringstekst er skrevet av tredjeparter og leses av modellen via lese-handlingene" },
    sanitization: { methods: ["output_trust=untrusted på alle lese-handlinger (ingestion-sonen: data, aldri instruks)", "sentral hemmelighetsskanner på feiltekst", "repo-lås for modell-/jobbstyrte lesinger (github-repo-lock.ts)"] }
  },
  data: {
    schemas: { input: "zod input_schema i ToolDefinition (påkrevde parametre i actions[].data)", output: "GitHub-JSON slik GithubTransport returnerer det; behandles som ubetrodd data" },
    provenance: { origin: "provider", tagging: "ekstern id fra GitHub + tool.executed/tool.failed-revisjon merket person/tenant/task_id (CLAUDE.md regel 4)" },
    freshness: { model: "live_read", note: "ingen lokal kopi; hvert kall går mot GitHub" },
    retention: { stored_by_jarvis: ["audit_metadata", "before_after_ledger"], note: "ingen kopi av repo-innhold; før-/etter-tilstand for klasse C/D med preflight ligger i tool_executions" },
    delete_semantics: { provider_side: "supported", jarvis_side: "delete_branch er eneste slette-handling; revisjonssporet beholdes etter retensjonsregelen og inneholder ingen kopi av innholdet" }
  },
  operations: {
    health_check: { method: "live_probe", action_key: "github.read_issues", cadence: "daglig helsesveip (ConnectorHealthSweep)" },
    timeout: { max_ms: maxTimeoutMs(actions) },
    circuit_breaker: { status: "partial", mechanism: "rate-limit-kontrolleren (D-97) stanser kall ved primær/sekundær throttling og styrer retry-tidspunkt; ingen generell feilrate-bryter; manuell pause via eierens frys av connectoren" },
    metrics: { sources: ["ToolGateway.health (i minnet)", "audit_events tool.executed og tool.failed", "connector_maintenance_log"] },
    runbook: { path: "docs/runbooks/GITHUB_APP.md" },
    maintenance_owner: { role: "owner", ledger: "connector_maintenance_log" }
  },
  secrets: {
    refs: [
      { ref: "JARVIS_GITHUB_TOKEN", required: true, purpose: "PAT, eller GitHub App-installasjonstoken (kortlevd, repo-scopet) levert under samme referanse" },
      { ref: "JARVIS_GITHUB_APP_PRIVATE_KEY", required: false, purpose: "GitHub App-privatnøkkel; ligger kun i vaulten, aldri som miljøvariabel" }
    ],
    model_visibility: "never"
  },
  tests: {
    fake_adapter: { status: "present", paths: ["modules/connector-sdk/test/references/github.fake.ts"] },
    contract: { status: "present", paths: ["modules/connector-sdk/test/references/reference-connectors.contract.test.ts", "modules/tool-gateway/test/github-developer-control-plane.test.ts"] },
    live_smoke: { status: "blocked_external", paths: ["modules/tool-gateway/scripts/ua5-github-live.ts"], note: "krever eierens JARVIS_GITHUB_TOKEN; ikke kjørt (Q-31)" },
    authority: { status: "present", paths: ["modules/tool-gateway/test/q50b-github-repo-lock.test.ts", "modules/tool-gateway/test/wpc3-github-app-gateway.test.ts"] },
    recovery: { status: "partial", paths: ["modules/tool-gateway/test/part3-class-d-pipeline.test.ts"], note: "klasse D-kjeden (delete_branch, merge_pr) er testet; rollback for klasse B/C er dokumentert, ikke automatisk utført" },
    security: { status: "present", paths: ["modules/tool-gateway/test/github-rate-limit-controller.test.ts", "modules/tool-gateway/test/wpc3-review1-hardening.test.ts"] }
  },
  d41_audit: {
    classification: "PARTIAL",
    read: { provider_offers: "yes", implemented: "partial", action_keys: READS, note: "branches, commits, PR-er, issues, workflow-kjøringer og repo-metadata; øvrige lese-flater (releases, varsler, Pages/Packages/Projects/Discussions) er ikke bygget" },
    write: {
      provider_offers: "yes", implemented: "partial",
      action_keys: ["github.create_branch", "github.create_issue", "github.create_pr", "github.update_issue", "github.update_pr", "github.set_labels", "github.request_reviewers", "github.comment_on_issue", "github.rerun_workflow_run", "github.cancel_workflow_run", "github.dispatch_workflow", "github.merge_pr"],
      note: "branch/PR/issue/workflow-livssyklus; ingen direkte fil-API (filendringer går via git i kodejobber)"
    },
    delete: { provider_offers: "yes", implemented: "partial", action_keys: ["github.delete_branch"], note: "kun branches; sletting av releases, kommentarer m.fl. er ikke bygget" },
    access_control: { provider_offers: "yes", implemented: "none", action_keys: [], note: "branch protection/rulesets/collaborators/deploy keys (Administration) er ikke bygget" },
    scopes_verified_against_docs: true,
    unverified_scopes: [],
    verified_on: "2026-10-09",
    docs_reference: ["GitHub-dokumentasjon (github/docs, åpent repo): server-to-server-permissions for REST API 2022-11-28, Choosing permissions for a GitHub App, Rate limits for the REST API - se docs/runbooks/GITHUB_APP.md, avsnittet Kilder"],
    gaps: [
      { capability: "releases", status: "DEFERRED", reason: "krever Contents; ikke bygget" },
      { capability: "branch protection, rulesets, collaborators, deploy keys (Administration)", status: "DEFERRED", reason: "tilgangsstyring skriv; ikke bygget" },
      { capability: "webhooks (innkommende hendelser)", status: "DEFERRED", reason: "App-oppsettet har webhooks av; ikke bygget" },
      { capability: "miljøer, secrets og variables", status: "DEFERRED", reason: "ikke bygget" },
      { capability: "Dependabot- og code-scanning-varsler", status: "DEFERRED", reason: "ikke bygget" },
      { capability: "Pages, Packages, Projects, Discussions", status: "DEFERRED", reason: "ikke bygget" },
      { capability: "direkte fil-API (PUT contents)", status: "DEFERRED", reason: "filendringer går via git i kodejobber" },
      { capability: "GitHub Enterprise Server", status: "DEFERRED", reason: "kun https://api.github.com støttes" },
      { capability: "step-up for klasse D (merge_pr, delete_branch)", status: "PARTIAL", reason: "eldre klasse D-handlinger mangler step_up_required (CLOSURE_MATRIX UA-5)" }
    ]
  },
  core_boundary: {
    system_of_record: "EXTERNAL_CANONICAL", basis: "audited",
    external_role: "kilde og utførelsesleverandør for kode, PR-er, issues og CI (Git-hosting er intrinsic ekstern, ARCHITECTURE.md §11.9)",
    core_dependency_decision_required: false
  },
  actions
};

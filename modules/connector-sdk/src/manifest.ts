import { z } from "zod";
import { CapabilityClassSchema, TrustLevelSchema } from "@jarvis/contracts";
import { containsSecret } from "@jarvis/core";

/**
 * WP-I (D-472) - CONNECTOR SDK: `ConnectorManifest` (masterplan Sovereign Autonomy v4.0 kap. 10 «Connector Factory og maintenance model», tabellen «Manifest-felt Krav»).
 *
 * Manifestet BESKRIVER en connector; det er aldri kjøretidens sannhetskilde. `CONNECTOR_REGISTRY` (`modules/tool-gateway/src/connector-registry.ts`) og de registrerte
 * `ToolDefinition`-ene forblir sannheten, og manifestene sjekkes MOT dem (se `derive.ts`/`guard.ts`: en test feiler når de driver fra hverandre). Ingenting her kaller, skriver eller
 * sender noe - dette er en ren beskrivelses-, validerings- og testmodul (DORMANT/BUILT_UNWIRED: ingen kjøretidseffekt, ingen flagg å slå av).
 *
 * To fullstendighetsnivåer (`completeness`):
 *  - `skeleton`: avledet fra registeret/verktøymanifestet. Det som IKKE kan avledes står som en eksplisitt `Unknown`-markør (`{ unknown: true, reason }`) - aldri en oppfunnet verdi.
 *  - `full`: håndskrevet og gjennomgått. INGEN `Unknown`-markør tillatt, og en rekke semantiske regler (klasse D-kjeden, idempotens, D-41-revisjon, D-64-grense) håndheves.
 *
 * FELTENE følger kap. 10 ordrett (`SECTION_10_FIELDS` under, låst av en test): identity, auth, capabilities, authority, reversibility, idempotency, limits, trust, data, operations,
 * secrets, tests. Per-handling-fakta (risikoklasse, rollback, idempotens, tillit, grenser, tidsavbrudd) ligger i `actions[]` under fasetter oppkalt etter seksjonen de hører til.
 * I tillegg to obligatoriske tillegg fra CLAUDE.md: `d41_audit` (regel 11, D-41: leverandørens faktiske kapabilitet, scopes verifisert mot dokumentasjon, DEFERRED/PARTIAL-gap)
 * og `core_boundary.system_of_record` (regel 12, D-64: JARVIS_CANONICAL | EXTERNAL_CANONICAL | HYBRID_WITH_CLEAR_AUTHORITY).
 *
 * HEMMELIGHETER (kap. 10 «secrets»): kun hvelvreferanser (`^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$`), aldri verdier; `model_visibility` er bokstavelig `never` (Appendiks C: rå secret til modell, aldri).
 */

export const MANIFEST_SCHEMA_VERSION = "1" as const;

export const COMPLETENESS_LEVELS = ["skeleton", "full"] as const;
export type Completeness = (typeof COMPLETENESS_LEVELS)[number];

/** Speiler `Effect` i `tool-manifest.ts` (låst av en drift-test i derive.test.ts). */
export const ACTION_EFFECTS = ["read", "write", "send", "pay", "delete", "control"] as const;
export type ActionEffect = (typeof ACTION_EFFECTS)[number];

/** Handlingens kapabilitets-bøtte i kap. 10 (`capabilities`): read | write (inkl. slette) | actions (send/betal/styr). */
export const ACTION_KINDS = ["read", "write", "action"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const AUTH_TYPES = ["oauth2", "api_key", "service_account", "mtls", "device_token", "app_installation", "none"] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

/** EV-17 (`evolution/credentials.ts` `CredentialKind`) - slik at manifestet og credential-vurderingen snakker om det samme. */
export const CREDENTIAL_KINDS = ["short_lived_token", "oauth", "api_key", "root"] as const;
export const ROTATION_METHODS = ["manual", "automatic", "short_lived", "not_applicable"] as const;

export const CAPABILITY_STATUSES = ["implemented", "partial", "deferred", "provider_limited", "not_implemented"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const ROLLBACK_METHODS = ["none", "provider_revert", "compensating_action", "restore_from_snapshot", "manual"] as const;
export type RollbackMethod = (typeof ROLLBACK_METHODS)[number];

export const IDEMPOTENCY_REQUIREMENTS = ["none", "recommended", "required"] as const;
export type IdempotencyRequirement = (typeof IDEMPOTENCY_REQUIREMENTS)[number];

export const POSTCONDITIONS = ["readback", "provider_id", "none"] as const;
export type Postcondition = (typeof POSTCONDITIONS)[number];

/** D-64 (CLAUDE.md regel 12): hvem eier den kanoniske tilstanden. */
export const SYSTEMS_OF_RECORD = ["JARVIS_CANONICAL", "EXTERNAL_CANONICAL", "HYBRID_WITH_CLEAR_AUTHORITY"] as const;
export type SystemOfRecord = (typeof SYSTEMS_OF_RECORD)[number];

/** D-41-revisjonens klassifisering (D-41-raden i DECISIONS_AND_ASSUMPTIONS.md). */
export const D41_CLASSIFICATIONS = ["FULL", "PARTIAL", "READ_ONLY", "PROVIDER_LIMITED"] as const;
/** De fem eneste lovlige grunnene til read-only (CLAUDE.md regel 11 / D-41 (1)-(5)). */
export const READ_ONLY_REASONS = ["provider_offers_nothing", "scope_missing", "law_or_platform", "owner_configured_restricted", "isolation_breach"] as const;
export const GAP_STATUSES = ["DEFERRED", "PARTIAL"] as const;

export const CLASS_D_CHAIN_STATUSES = ["complete", "deferred", "exempt"] as const;

export const TEST_STATUSES = ["present", "partial", "missing", "deferred", "blocked_external", "not_run"] as const;

/**
 * Laveste risikoklasse en effekt kan ha - speiler `MIN_RISK_BY_EFFECT` i `tool-manifest.ts` (JARVIS-015: send/pay/delete/control er aldri «uskyldig» B/A).
 * Låst av en drift-test mot verktøymanifestet. En handling kan bare gå under minimum med en BEGRUNNET `authority.risk_exception`.
 */
export const MIN_RISK_FOR_EFFECT: Readonly<Record<ActionEffect, "A" | "B" | "C" | "D">> = {
  read: "A", write: "B", send: "C", pay: "C", delete: "C", control: "C"
};
export const RISK_ORDER: Readonly<Record<"A" | "B" | "C" | "D", number>> = { A: 0, B: 1, C: 2, D: 3 };

/** Effekt -> kap. 10-bøtte: read -> read; write|delete -> write; send|pay|control -> action. */
export function kindOfEffect(effect: ActionEffect): ActionKind {
  if (effect === "read") return "read";
  if (effect === "write" || effect === "delete") return "write";
  return "action";
}

// ---------------------------------------------------------------------------------------------------------------------
// «Ukjent» - den ærlige markøren et skeleton bruker der et felt ikke kan avledes
// ---------------------------------------------------------------------------------------------------------------------

export const UnknownSchema = z.object({ unknown: z.literal(true), reason: z.string().min(1).max(240) }).strict();
export type Unknown = z.infer<typeof UnknownSchema>;

export function unknownField(reason: string): Unknown {
  return { unknown: true, reason };
}

export function isUnknown(value: unknown): value is Unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as { unknown?: unknown }).unknown === true;
}

const maybe = <T extends z.ZodTypeAny>(schema: T) => z.union([schema, UnknownSchema]);

// ---------------------------------------------------------------------------------------------------------------------
// Primitiver
// ---------------------------------------------------------------------------------------------------------------------

const text = (max: number) => z.string().min(1).max(max);
/** Connector-id: snake_case (2-41 tegn) uten ledende, avsluttende eller doble understreker - slik at `JARVIS_<ID>_TOKEN` alltid er en gyldig hvelvreferanse. Samme form som scaffold-generatorens `ID_PATTERN` (låst av en test). */
const CONNECTOR_ID = /^(?=.{2,41}$)[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const ACTION_KEY = /^[a-z][a-z0-9_-]{0,40}\.[a-z][a-z0-9_]{0,60}$/;
/** Hvelvreferanse: STORE BOKSTAVER med minst ett understrek (JARVIS_GITHUB_TOKEN). En verdi (ghp_..., AKIA...) har aldri denne formen. */
const VAULT_REF = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
/** Repo-relativ sti uten rot, uten `..`. Eksistens sjekkes av CI-vakten (guard.ts), ikke av skjemaet (rent). */
const REPO_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]{1,200}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROLE = /^[a-z][a-z0-9_.-]{1,60}$/;

/**
 * Review M2: regexen over godtar hemmelighetsformede navn (`ghp_<24 tegn>.read`, `sk_live_...`, `xoxb-...`, `sk-ant-...`), og handlingsnøkler gjentas i meldinger (duplikat, kind/effekt, gap, drift, kittets
 * subjects). Derfor er en identifikator som ser ut som en hemmelighet (den sentrale skanneren, `containsSecret`) ugyldig allerede i skjemaet: da kan ingen gyldig manifest bære en hemmelighet inn i en melding.
 */
const notSecretShaped = (value: string): boolean => !containsSecret(value);
const SECRET_SHAPED_ID = { message: "identifier looks like a secret", params: { manifest_code: "secret_shaped_identifier" } } as const;

const ActionKeySchema = z.string().max(120).regex(ACTION_KEY).refine(notSecretShaped, SECRET_SHAPED_ID);
const ActionKeyListSchema = z.array(ActionKeySchema).max(150);

// ---------------------------------------------------------------------------------------------------------------------
// Seksjonene (kap. 10, tabellen «Manifest-felt Krav»)
// ---------------------------------------------------------------------------------------------------------------------

const IdentitySchema = z.object({
  /** Registerets stabile id (`CONNECTOR_REGISTRY[].id`) - nøkkelen manifestet sjekkes mot. */
  id: z.string().regex(CONNECTOR_ID).refine(notSecretShaped, SECRET_SHAPED_ID),
  name: text(80),
  vendor: maybe(text(80)),
  /** `manifest` = manifestdokumentets egen semver; `provider_api` = leverandørens API-versjon koden faktisk kaller (ikke leverandørens nyeste). */
  version: z.object({ manifest: z.string().regex(SEMVER), provider_api: maybe(text(120)) }).strict(),
  /** `tenant_owner` = eier-tilkoblet integrasjon (D-41); `jarvis_core` = Jarvis eier tilstanden (JARVIS_CANONICAL-navnerom). `ref` er en ROLLE («owner»), aldri et personnavn. */
  owner: z.object({ kind: z.enum(["tenant_owner", "jarvis_core"]), ref: z.string().regex(ROLE) }).strict(),
  environment: maybe(z.object({
    deployment: z.enum(["production", "sandbox", "local"]),
    /** D-41 (j): en trygg test-sandbox (test-/akseptanseløp begrenses til den; sier ingenting om produksjonens tilgangsnivå). */
    sandbox: z.object({ available: z.boolean(), description: text(300) }).strict()
  }).strict())
}).strict();

const AuthSchema = z.object({
  /** Primær autentiseringsmetode. */
  type: maybe(z.enum(AUTH_TYPES)),
  alternatives: z.array(z.enum(AUTH_TYPES)).max(6).optional(),
  scopes: z.object({
    /** Jarvis' EGNE scope-etiketter handlingene deklarerer (`ToolDefinition.scopes`, f.eks. `repo:write-pr`) - IKKE leverandørens OAuth-/token-tillatelser. */
    declared_by_actions: z.array(text(80)).max(100),
    /** Leverandørens faktiske tillatelser for full nyttig tilgang. Skal verifiseres mot offisiell dokumentasjon (se `d41_audit.scopes_verified_against_docs`), aldri gjettes. */
    provider: maybe(z.array(z.object({ scope: text(120), needed_for: ActionKeyListSchema }).strict()).max(60))
  }).strict(),
  rotation: maybe(z.object({
    credential_kind: z.enum(CREDENTIAL_KINDS),
    method: z.enum(ROTATION_METHODS),
    interval_days: z.number().int().positive().max(3650).optional(),
    note: text(300).optional()
  }).strict())
}).strict();

const CapabilityDeclSchema = z.object({ status: z.enum(CAPABILITY_STATUSES), note: text(400).optional() }).strict();
const ItemCapabilityDeclSchema = z.object({ status: z.enum(CAPABILITY_STATUSES), items: z.array(text(120)).max(150), note: text(400).optional() }).strict();

const CapabilitiesSchema = z.object({
  /** read/write/actions: `status` må stemme med handlingene i `actions[]` (en handlings bøtte følger av effekten, `kindOfEffect`). */
  read: CapabilityDeclSchema,
  write: CapabilityDeclSchema,
  actions: CapabilityDeclSchema,
  /** Innkommende hendelser: `items` = hendelsesnavn/endepunkter. */
  webhooks: maybe(ItemCapabilityDeclSchema),
  /** Periodisk synk: `items` = jobbnavn. */
  sync: maybe(ItemCapabilityDeclSchema),
  /** Søk: `items` = handlingsnøkler (delmengde av lese-handlingene). */
  search: maybe(ItemCapabilityDeclSchema)
}).strict();

const AuthoritySchema = z.object({
  owner: maybe(z.object({
    mode: z.enum(["sovereign", "restricted_by_owner"]),
    /** `owner_bound`: leverandør-credentialen er bundet til den autentiserte eieren i eierens tenant(er) (CredentialBinding, D-377). */
    credential_binding: z.enum(["owner_bound", "internal"]),
    note: text(400).optional()
  }).strict()),
  delegated: maybe(z.object({ mode: z.enum(["denied", "approval_required", "same_as_owner"]), note: text(400).optional() }).strict()),
  tenant: maybe(z.object({ binding: z.enum(["owner_tenants", "per_tenant_credential", "global_single_tenant"]), note: text(400).optional() }).strict()),
  /** Valgfri (kap. 10: «optional approval policy»). */
  approval_policy: z.object({
    step_up_actions: ActionKeyListSchema,
    delegated_class_cd: z.enum(["signed_approval_required", "denied", "not_applicable"]),
    note: text(400).optional()
  }).strict().optional()
}).strict();

const ReversibilitySchema = z.object({
  /** Hva som finnes av gjenopprettingsgrunnlag for handlingene: ingenting, før-tilstand i journalen (`tool_executions.before_state`), eller en leverandør-snapshot. */
  snapshot_support: maybe(z.enum(["none", "before_state_in_ledger", "provider_snapshot"]))
}).strict();

const IdempotencySchema = z.object({
  dedupe_key: maybe(z.enum(["none", "jarvis_idempotency_key", "provider_idempotency_key", "natural_key"])),
  retry_semantics: maybe(z.object({
    on_timeout: z.enum(["safe_retry", "reconcile_before_retry", "never_retry"]),
    on_rate_limit: z.enum(["retry_after", "never_retry"]),
    on_server_error: z.enum(["safe_retry", "reconcile_before_retry", "never_retry"]),
    note: text(400).optional()
  }).strict()),
  exactly_once_target: maybe(z.enum(["exactly_once", "at_most_once", "at_least_once_idempotent", "not_applicable"]))
}).strict();

const LimitsSchema = z.object({
  rate_limits: maybe(text(400)),
  quotas: maybe(text(400)),
  /** Valgfri (kap. 10: «owner caps optional»). */
  owner_caps: text(300).optional()
}).strict();

const TrustSchema = z.object({
  /** Connectorens strengeste utdata-klasse (untrusted > internal > trusted) - per handling i `actions[].trust`. */
  output: z.object({ class: TrustLevelSchema }).strict(),
  injection_exposure: maybe(z.object({ level: z.enum(["none", "possible", "high"]), note: text(400).optional() }).strict()),
  sanitization: maybe(z.object({ methods: z.array(text(160)).min(1).max(10) }).strict())
}).strict();

const DataSchema = z.object({
  schemas: maybe(z.object({ input: text(300), output: text(300) }).strict()),
  provenance: maybe(z.object({ origin: z.enum(["provider", "jarvis", "mixed"]), tagging: text(300) }).strict()),
  freshness: maybe(z.object({ model: z.enum(["live_read", "synced", "cached", "event_driven"]), max_age_seconds: z.number().int().positive().optional(), note: text(300).optional() }).strict()),
  retention: maybe(z.object({ stored_by_jarvis: z.array(z.enum(["nothing", "audit_metadata", "before_after_ledger", "synced_copy"])).min(1).max(4), note: text(300).optional() }).strict()),
  delete_semantics: maybe(z.object({ provider_side: z.enum(["supported", "not_offered", "deferred", "not_applicable"]), jarvis_side: text(300) }).strict())
}).strict();

const OperationsSchema = z.object({
  health_check: maybe(z.object({ method: z.enum(["live_probe", "presence_only", "none"]), action_key: ActionKeySchema.nullable(), cadence: text(80).optional() }).strict()),
  /** Høyeste per-handling-tidsavbrudd (per handling i `actions[].operations.timeout_ms`). */
  timeout: maybe(z.object({ max_ms: z.number().int().positive() }).strict()),
  circuit_breaker: maybe(z.object({ status: z.enum(["implemented", "partial", "deferred", "not_applicable"]), mechanism: text(400) }).strict()),
  metrics: maybe(z.object({ sources: z.array(text(160)).min(1).max(10) }).strict()),
  /** Repo-relativ sti til runbooken (CI-vakten krever at den finnes for `full`). */
  runbook: maybe(z.object({ path: z.string().regex(REPO_PATH) }).strict()),
  maintenance_owner: maybe(z.object({ role: z.string().regex(ROLE), ledger: z.literal("connector_maintenance_log").optional() }).strict()),
  /** Penge-berørende handlinger (Appendiks B nivå A: «Finance reconciliation»). */
  reconciliation: z.object({ required: z.boolean(), method: text(300) }).strict().optional()
}).strict();

const SecretsSchema = z.object({
  /** KUN referanser (hvelv-/miljønøkler) - aldri verdier. */
  refs: z.array(z.object({ ref: z.string().max(80).regex(VAULT_REF), required: z.boolean(), purpose: maybe(text(200)) }).strict()).max(30),
  /** Appendiks C (systeminvariant): rå secret eksponeres aldri for modellen. */
  model_visibility: z.literal("never")
}).strict();

const TestEvidenceSchema = z.object({
  status: z.enum(TEST_STATUSES),
  /** Repo-relative stier (CI-vakten krever at de finnes for `full`). */
  paths: z.array(z.string().regex(REPO_PATH)).max(20),
  note: text(300).optional()
}).strict();

const TestsSchema = z.object({
  fake_adapter: maybe(TestEvidenceSchema),
  contract: maybe(TestEvidenceSchema),
  live_smoke: maybe(TestEvidenceSchema),
  authority: maybe(TestEvidenceSchema),
  recovery: maybe(TestEvidenceSchema),
  security: maybe(TestEvidenceSchema)
}).strict();

const CapabilityAuditSchema = z.object({
  provider_offers: z.enum(["yes", "no", "unknown"]),
  implemented: z.enum(["full", "partial", "none", "not_applicable"]),
  action_keys: ActionKeyListSchema,
  note: text(400).optional()
}).strict();

/** D-41-kapabilitetsrevisjonen (CLAUDE.md regel 11): lese/skrive/slette/tilgangsstyring, scopes verifisert mot dokumentasjon, gap merket DEFERRED/PARTIAL. */
const D41AuditSchema = z.object({
  classification: z.enum(D41_CLASSIFICATIONS),
  /** Påkrevd når `classification` er READ_ONLY: hvilken av D-41s fem unntak som gjelder. */
  read_only_reason: z.enum(READ_ONLY_REASONS).optional(),
  read: CapabilityAuditSchema,
  write: CapabilityAuditSchema,
  delete: CapabilityAuditSchema,
  access_control: CapabilityAuditSchema,
  /** `true` KUN når ALLE nødvendige scopes er lest mot leverandørens offisielle dokumentasjon (aldri gjettet). Ellers `false` og `unverified_scopes` lister resten. */
  scopes_verified_against_docs: z.boolean(),
  unverified_scopes: z.array(text(160)).max(40),
  verified_on: z.string().regex(DATE).optional(),
  docs_reference: z.array(text(300)).max(20),
  /** Alt leverandøren tilbyr som IKKE er bygget: aldri stille utelatt. */
  gaps: z.array(z.object({ capability: text(240), status: z.enum(GAP_STATUSES), reason: text(500) }).strict()).max(40)
}).strict();

/** Beslutnings-id i beslutningsloggen (`docs/DECISIONS_AND_ASSUMPTIONS.md`): `D-109`. */
const DECISION_ID = /^D-\d{1,4}$/;
export const BOUNDARY_BASES = ["unassessed", "audited"] as const;

/**
 * D-64 (CLAUDE.md regel 12): Core-vs-Adapter-grensen. `system_of_record` og `core_dependency_decision_required` er SVARENE på porten - de skal aldri forhåndssvares av en standard (review M3: alle 58 skeletons
 * hevdet EXTERNAL_CANONICAL/false, mot beslutningsloggen som har HYBRID_WITH_CLEAR_AUTHORITY for fiken/vipps/neonomics/wallester/stripe). Derfor kan begge være `Unknown`-markører.
 *  - `basis: unassessed` = porten er ikke kjørt/revidert i manifestet: begge felt SKAL være `Unknown` (en uavhengig påstand uten revisjon er forbudt).
 *  - `basis: audited` = porten er kjørt: begge felt er kjent og `decision_refs` peker på beslutningen som loggførte den (D-id i beslutningsloggen; CI-vakten sjekker at den finnes).
 */
const CoreBoundarySchema = z.object({
  system_of_record: maybe(z.enum(SYSTEMS_OF_RECORD)),
  basis: z.enum(BOUNDARY_BASES),
  /** Beslutningen/beslutningene som loggførte D-64-porten for denne connectoren (påkrevd for `audited`). */
  decision_refs: z.array(z.string().regex(DECISION_ID)).max(8).optional(),
  external_role: maybe(text(300)),
  /** Påkrevd for HYBRID_WITH_CLEAR_AUTHORITY: hvem som har autoriteten over hva (ingen tvetydig dobbel-eierskap). */
  authority_split: text(500).optional(),
  /** `true` = leverandøren ville blitt en CORE DEPENDENCY: STOPP og meld `CORE_DEPENDENCY_DECISION_REQUIRED=true` til Tobias. Blokkerer et fullt manifest. `Unknown` til porten er kjørt. */
  core_dependency_decision_required: maybe(z.boolean())
}).strict();

// ---------------------------------------------------------------------------------------------------------------------
// Handlinger (én rad per `tool_id.action`, fasetter oppkalt etter kap. 10-seksjonene)
// ---------------------------------------------------------------------------------------------------------------------

const ActionSpecSchema = z.object({
  /** `tool_id.action` - samme nøkkel som verktøymanifestet og `ToolGateway`. */
  key: ActionKeySchema,
  kind: z.enum(ACTION_KINDS),
  effect: z.enum(ACTION_EFFECTS),
  authority: z.object({
    risk_class: CapabilityClassSchema,
    /** Kun en enhetssignert økt kan utføre handlingen (`ToolDefinition.step_up_required`). */
    step_up_required: z.boolean(),
    /** Kun den autentiserte eieren (`ToolDefinition.owner_only`). */
    owner_only: z.boolean(),
    /** Begrunnelse når risikoklassen er LAVERE enn minimum for effekten (speiler `MIN_RISK_EXCEPTIONS`). */
    risk_exception: text(300).optional()
  }).strict(),
  reversibility: z.object({
    reversible: z.boolean(),
    rollback_method: maybe(z.enum(ROLLBACK_METHODS)),
    /** Fritekst fra definisjonen (`ToolDefinition.rollback_procedure`) - klasse D krever en gjenopprettingsplan (også «ingen reversering»). */
    rollback_procedure: text(1000),
    compensating_action: z.union([text(300), z.null(), UnknownSchema]),
    destructive: z.boolean(),
    evidence: z.object({
      /** Fersk tilstandslesing FØR handlingen (`preflight_action`). */
      before_state: z.boolean(),
      /** `readback` = tilstanden leses på nytt og sammenlignes; `provider_id` = leverandørens bekreftede id (utgående melding); `none` = ingen etterbetingelse. */
      postcondition: z.enum(POSTCONDITIONS)
    }).strict(),
    /**
     * KUN klasse D: hvor langt klasse D-kjeden (`assessClassDPipeline`) er bygget. `complete` = hele kjeden; `deferred` = kjeden mangler deler (`missing`) og handlingen er UTILGJENGELIG under håndhevelse
     * (fail-closed, eksplisitt DEFERRED-liste i `part3-class-d-pipeline.test.ts`); `exempt` = bevisst unntatt (nødbrytere). En ufullstendig D-handling er ærlig merket, aldri stille utelatt.
     */
    class_d_chain: z.object({
      status: z.enum(CLASS_D_CHAIN_STATUSES),
      missing: z.array(text(60)).max(10),
      /** Påkrevd for `exempt` (review LOW): HVORFOR handlingen er unntatt kjedekravene - uten begrunnelse er et unntak bare en stille omgåelse. */
      justification: text(300).optional()
    }).strict().optional()
  }).strict(),
  idempotency: z.object({
    requirement: z.enum(IDEMPOTENCY_REQUIREMENTS),
    /** Leverandøren er selv idempotent for denne handlingen (`ToolDefinition.idempotent_external`). */
    provider_idempotent: z.boolean()
  }).strict(),
  trust: z.object({ output: TrustLevelSchema }).strict(),
  limits: z.object({ rate_limit_per_minute: z.number().int().positive() }).strict(),
  operations: z.object({ timeout_ms: z.number().int().positive() }).strict(),
  data: z.object({
    /** Påkrevde parametre fra inndataskjemaet (deterministisk parametervalidering, Appendiks B nivå A). */
    input_required: maybe(z.array(text(80)).max(60)),
    /** Identitetsfelt (tenant/person/space) i skjemaet - aldri modellstyrt. */
    identity_fields: z.array(text(40)).max(10)
  }).strict()
}).strict();

export type ActionSpec = z.infer<typeof ActionSpecSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Manifestet
// ---------------------------------------------------------------------------------------------------------------------

export const ConnectorManifestSchema = z.object({
  schema_version: z.literal(MANIFEST_SCHEMA_VERSION),
  completeness: z.enum(COMPLETENESS_LEVELS),
  /** `derived_from_registry` = generert av `derive.ts` (aldri redigert for hånd); `authored` = håndskrevet og gjennomgått. */
  source: z.enum(["derived_from_registry", "authored"]),
  identity: IdentitySchema,
  auth: AuthSchema,
  capabilities: CapabilitiesSchema,
  authority: AuthoritySchema,
  reversibility: ReversibilitySchema,
  idempotency: IdempotencySchema,
  limits: LimitsSchema,
  trust: TrustSchema,
  data: DataSchema,
  operations: OperationsSchema,
  secrets: SecretsSchema,
  tests: TestsSchema,
  d41_audit: maybe(D41AuditSchema),
  core_boundary: CoreBoundarySchema,
  actions: z.array(ActionSpecSchema).max(150)
}).strict();

export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;

/**
 * Kap. 10 «Manifest-felt Krav», ordrett: hvilke felt hver seksjon SKAL ha. `connector` = felt på seksjonsobjektet; `per_action` = felt i `actions[].<seksjon>`.
 * En test låser at skjemaet faktisk har hvert felt (og at ingen kap. 10-seksjon mangler), så skjemaet ikke driver fra masterplanen.
 */
export const SECTION_10_FIELDS: Readonly<Record<string, { connector: readonly string[]; per_action: readonly string[] }>> = {
  identity: { connector: ["name", "vendor", "version", "owner", "environment"], per_action: [] },
  auth: { connector: ["type", "scopes", "rotation"], per_action: [] },
  capabilities: { connector: ["read", "write", "actions", "webhooks", "sync", "search"], per_action: [] },
  authority: { connector: ["owner", "delegated", "tenant", "approval_policy"], per_action: ["risk_class"] },
  reversibility: { connector: ["snapshot_support"], per_action: ["rollback_method", "compensating_action", "destructive"] },
  idempotency: { connector: ["dedupe_key", "retry_semantics", "exactly_once_target"], per_action: ["requirement"] },
  limits: { connector: ["rate_limits", "quotas", "owner_caps"], per_action: ["rate_limit_per_minute"] },
  trust: { connector: ["output", "injection_exposure", "sanitization"], per_action: ["output"] },
  data: { connector: ["schemas", "provenance", "freshness", "retention", "delete_semantics"], per_action: [] },
  operations: { connector: ["health_check", "timeout", "circuit_breaker", "metrics", "runbook", "maintenance_owner"], per_action: ["timeout_ms"] },
  secrets: { connector: ["refs", "model_visibility"], per_action: [] },
  tests: { connector: ["fake_adapter", "contract", "live_smoke", "authority", "recovery", "security"], per_action: [] }
};

/** Ekstra seksjoner utover kap. 10 (CLAUDE.md regel 11 og 12) - også låst av testen. */
export const EXTRA_SECTIONS = ["d41_audit", "core_boundary"] as const;

/** Skjema-interne byggesteiner for andre filer i pakken (testene låser feltene via disse). */
export const MANIFEST_SECTION_SCHEMAS = {
  identity: IdentitySchema, auth: AuthSchema, capabilities: CapabilitiesSchema, authority: AuthoritySchema, reversibility: ReversibilitySchema,
  idempotency: IdempotencySchema, limits: LimitsSchema, trust: TrustSchema, data: DataSchema, operations: OperationsSchema, secrets: SecretsSchema, tests: TestsSchema,
  core_boundary: CoreBoundarySchema, d41_audit: D41AuditSchema, action: ActionSpecSchema
} as const;

/**
 * Vis en identifikator (handlingsnøkkel, connector-id) i en melding: en hemmelighetsformet verdi vises aldri, kun `<redacted>`. Brukes av ALLE meldingsveier (validator, drift, vakt, kittets subjects) slik at
 * heller ikke et uvalidert, typet manifest kan få en hemmelighet gjentatt i utdata.
 */
export function safeIdentifier(value: unknown): string {
  if (typeof value !== "string") return "<invalid>";
  return value.length <= 120 && !containsSecret(value) ? value : "<redacted>";
}

/** Vis en skalarverdi fra et (muligens uvalidert) manifest i en melding: tall/boolske som de er, korte rene ord (enum-verdier) som de er, alt annet `<redacted>`. */
export function safeScalar(value: unknown): string {
  if (typeof value === "boolean" || typeof value === "number" || value === undefined) return String(value);
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(value) && !containsSecret(value) ? value : "<redacted>";
}

export const VAULT_REF_PATTERN = VAULT_REF;
export const ACTION_KEY_PATTERN = ACTION_KEY;
export const CONNECTOR_ID_PATTERN = CONNECTOR_ID;
export const DECISION_ID_PATTERN = DECISION_ID;

import type { z } from "zod";
import {
  CONNECTOR_REGISTRY, MIN_RISK_EXCEPTIONS, assessClassDPipeline, buildToolManifest, isClassDExempt,
  type ConnectorDefinition, type ToolDefinition, type ToolManifestEntry
} from "@jarvis/tool-gateway";
import {
  MIN_RISK_FOR_EFFECT, RISK_ORDER, kindOfEffect, unknownField,
  type ActionSpec, type ConnectorManifest, type Unknown
} from "./manifest.ts";

/**
 * WP-I (D-472): AVLEDNING av et `skeleton`-manifest per connector i `CONNECTOR_REGISTRY` fra registeret + de registrerte `ToolDefinition`-ene + verktøymanifestet (`buildToolManifest`).
 * Registeret forblir kjøretidens sannhetskilde; dette er en ren funksjon som BESKRIVER det (ingen nettverk, ingen DB, ingen skriving).
 *
 * ÆRLIGHET: bare det som kan leses ut av registeret/definisjonene avledes. Alt annet (leverandørnavn, auth-type, leverandør-scopes, rotasjon, D-41-revisjon, retensjon, runbook, tester ...) står
 * som en eksplisitt `Unknown`-markør med årsak - aldri en oppfunnet verdi. Det er arbeidslisten for å oppgradere en connector til `full` (`collectUnknownPaths`).
 *
 * Handling -> connector-kobling speiler `connectorViews()` i `apps/api/src/control-center/integration.ts` (Integrasjonssenteret): en handling tilhører en connector når handlingens
 * `credential_ref` står blant connectorens `credential_refs`, og verktøyet ikke er live-test-verktøyet til en ANNEN connector; live-testhandlingen er alltid med. En drift-test i apps/api
 * låser at de to implementasjonene gir samme handlingsmengde for hele registeret.
 */

/** Jarvis-interne credential-referanser (ingen leverandør-secret): speiler `BUSINESS_INTERNAL_CREDENTIAL_REF` i @jarvis/business (låst av en test i apps/api). */
export const DEFAULT_INTERNAL_CREDENTIAL_REFS: ReadonlySet<string> = new Set(["JARVIS_BUSINESS_INTERNAL_TOKEN"]);

export interface DeriveInput {
  /** Standard: `CONNECTOR_REGISTRY`. Injiserbar for tester. */
  registry?: readonly ConnectorDefinition[];
  /** ALLE registrerte verktøydefinisjoner som kan tilhøre en connector (produksjonssettet: `firstWaveTools` + Home Assistant + `cloudControlToolDefinitions`). */
  definitions: readonly ToolDefinition[];
  /** Valgfri: API-versjon per connector-id (Integrasjonssenterets `CONNECTOR_API_FACTS`). Utelatt = «ukjent», aldri «ingen». */
  apiFacts?: Readonly<Record<string, { readonly api_version: string }>>;
  /** Valgfri og AUTORITATIV når oppgitt: daglige synk-jobber per connector (Integrasjonssenterets `CONNECTOR_SYNC_JOBS`). Fravær av en connector i kartet betyr «ingen synk-jobb». */
  syncJobs?: Readonly<Record<string, readonly string[]>>;
}

export const DERIVED_MANIFEST_VERSION = "0.0.0-derived";

const U = {
  generic: "ikke avledbart fra connector-registeret og verktøydefinisjonene",
  vendor: "leverandørnavn er ikke et felt i registeret",
  apiVersion: "koden oppgir ikke API-versjon for denne connectoren (ukjent, ikke «ingen»)",
  vendorFact: "leverandørfakta (krever offisiell dokumentasjon)",
  runtimeFact: "kjøretidsfakta som ikke ligger i registeret",
  boundary: "D-64-porten er ikke kjørt i manifestet: system_of_record er en beslutning (sjekk beslutningsloggen), ikke avledbar fra registeret",
  coreDependency: "CORE_DEPENDENCY_DECISION_REQUIRED er svaret på D-64-porten og forhåndssvares aldri av en standard - ukjent til porten er kjørt"
} as const;

const u = (reason: string): Unknown => unknownField(reason);

// ---------------------------------------------------------------------------------------------------------------------
// Handling -> connector
// ---------------------------------------------------------------------------------------------------------------------

/** Handlingene hver connector eier (samme regel som `connectorViews()`): nøkkel = connector-id. */
export function claimedDefinitions(registry: readonly ConnectorDefinition[], definitions: readonly ToolDefinition[]): Map<string, ToolDefinition[]> {
  const liveOwner = new Map<string, string>();
  for (const c of registry) if (c.live_test && !liveOwner.has(c.live_test.tool_id)) liveOwner.set(c.live_test.tool_id, c.id);
  const out = new Map<string, ToolDefinition[]>();
  for (const c of registry) {
    const claimed = definitions.filter((d) =>
      (c.credential_refs.includes(d.credential_ref) && (liveOwner.get(d.tool_id) ?? c.id) === c.id) ||
      (c.live_test !== undefined && d.tool_id === c.live_test.tool_id && d.action === c.live_test.action)
    );
    out.set(c.id, claimed.sort((a, b) => `${a.tool_id}.${a.action}`.localeCompare(`${b.tool_id}.${b.action}`)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Handlinger
// ---------------------------------------------------------------------------------------------------------------------

const MAX_ROLLBACK_TEXT = 1000;

/** Påkrevde parametre fra zod-skjemaet (objektform), ellers ukjent. */
export function requiredInputOf(def: ToolDefinition): string[] | null {
  const shape = (def.input_schema as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape;
  if (!shape || typeof shape !== "object") return null;
  return Object.entries(shape).filter(([, s]) => !s.isOptional()).map(([k]) => k).sort();
}

/** Klasse D-kjedens tilstand fra den EKSISTERENDE statiske vurderingen (`assessClassDPipeline`/`isClassDExempt`) - ingen egen tolkning. */
function classDChain(def: ToolDefinition): { status: "complete" | "deferred" | "exempt"; missing: string[]; justification?: string } {
  if (isClassDExempt(def)) return { status: "exempt", missing: [], justification: "sikkerhetsbryter: unntatt kjedekravene (CLASS_D_EXEMPT_ACTIONS i class-d-pipeline.ts) slik at den virker også når alt annet er nede" };
  const assessment = assessClassDPipeline(def);
  return { status: assessment.complete ? "complete" : "deferred", missing: [...assessment.missing] };
}

export function deriveAction(def: ToolDefinition, entry: ToolManifestEntry): ActionSpec {
  const effect = entry.effect;
  const rollbackText = def.rollback_procedure.trim();
  const required = requiredInputOf(def);
  const belowMin = RISK_ORDER[def.capability_class] < RISK_ORDER[MIN_RISK_FOR_EFFECT[effect]];
  const exception = MIN_RISK_EXCEPTIONS[entry.key];
  const readback = def.postcondition_predicate !== undefined || def.postcondition_target_absent === true;
  return {
    key: entry.key,
    kind: kindOfEffect(effect),
    effect,
    authority: {
      risk_class: def.capability_class,
      step_up_required: def.step_up_required === true,
      owner_only: def.owner_only === true,
      ...(belowMin && exception !== undefined ? { risk_exception: exception.slice(0, 300) } : {})
    },
    reversibility: {
      reversible: def.reversible,
      rollback_method: u("rollback-metoden er ikke en kategori i definisjonen (kun fritekst i rollback_procedure)"),
      rollback_procedure: rollbackText.length === 0 ? "(ikke oppgitt i verktøydefinisjonen)" : rollbackText.length > MAX_ROLLBACK_TEXT ? `${rollbackText.slice(0, MAX_ROLLBACK_TEXT - 1)}…` : rollbackText,
      compensating_action: u("kompenserende handling er ikke et eget felt i definisjonen"),
      destructive: effect === "delete" || (effect !== "read" && !def.reversible),
      evidence: { before_state: def.preflight_action !== undefined, postcondition: readback ? "readback" : def.class_d_profile === "outbound_message" ? "provider_id" : "none" },
      ...(def.capability_class === "D" ? { class_d_chain: classDChain(def) } : {})
    },
    idempotency: { requirement: entry.idempotency, provider_idempotent: def.idempotent_external },
    trust: { output: def.output_trust },
    limits: { rate_limit_per_minute: def.rate_limit_per_minute },
    operations: { timeout_ms: def.timeout_ms },
    data: { input_required: required === null ? u("inndataskjemaet er ikke en objektform") : required, identity_fields: [...entry.scope_fields] }
  };
}

const TRUST_ORDER = { trusted: 0, internal: 1, untrusted: 2 } as const;
const SEARCH_NAME = /(^|_)(search|find|query|lookup)(_|$)/;

// ---------------------------------------------------------------------------------------------------------------------
// Manifest per connector
// ---------------------------------------------------------------------------------------------------------------------

export function deriveSkeletonManifest(
  def: ConnectorDefinition, claimed: readonly ToolDefinition[], toolManifest: ReadonlyMap<string, ToolManifestEntry>, input: Pick<DeriveInput, "apiFacts" | "syncJobs">
): ConnectorManifest {
  const actions = claimed.map((d) => deriveAction(d, toolManifest.get(`${d.tool_id}.${d.action}`)!));
  const entries = claimed.map((d) => toolManifest.get(`${d.tool_id}.${d.action}`)!);
  const built = def.category !== "backlog" && def.category !== "backlog_d64_gate";
  const has = (kind: "read" | "write" | "action") => actions.some((a) => a.kind === kind);
  const writeCapable = actions.some((a) => a.effect !== "read");
  const scopes = [...new Set(claimed.flatMap((d) => d.scopes))].sort();
  const searchItems = actions.filter((a) => a.kind === "read" && SEARCH_NAME.test(a.key.slice(a.key.indexOf(".") + 1))).map((a) => a.key);
  const trustClass = actions.length === 0 ? "untrusted" as const : actions.map((a) => a.trust.output).reduce((acc, t) => (TRUST_ORDER[t] > TRUST_ORDER[acc] ? t : acc), "trusted" as ActionSpec["trust"]["output"]);
  const apiVersion = input.apiFacts?.[def.id]?.api_version;
  const sync = input.syncJobs === undefined ? u(U.runtimeFact) : (input.syncJobs[def.id] ?? []).length > 0
    ? { status: "implemented" as const, items: [...(input.syncJobs[def.id] ?? [])], note: "avledet fra daglige synk-jobber (CONNECTOR_SYNC_JOBS)" }
    : { status: "not_implemented" as const, items: [] as string[], note: "ingen daglig synk-jobb leser fra denne connectoren (CONNECTOR_SYNC_JOBS)" };
  const cap = (n: boolean) => ({ status: n ? "implemented" as const : "not_implemented" as const });

  return {
    schema_version: "1",
    completeness: "skeleton",
    source: "derived_from_registry",
    identity: {
      id: def.id,
      name: def.display_name,
      vendor: u(U.vendor),
      version: { manifest: DERIVED_MANIFEST_VERSION, provider_api: apiVersion !== undefined ? apiVersion : u(U.apiVersion) },
      owner: { kind: entries.length > 0 && entries.every((e) => e.owner === "jarvis_core") ? "jarvis_core" : "tenant_owner", ref: "owner" },
      environment: u(U.generic)
    },
    auth: {
      type: u(U.vendorFact),
      scopes: { declared_by_actions: scopes, provider: u(U.vendorFact) },
      rotation: u(U.vendorFact)
    },
    capabilities: {
      read: cap(has("read")),
      write: cap(has("write")),
      actions: cap(has("action")),
      webhooks: u(U.generic),
      sync,
      search: { status: searchItems.length > 0 ? "implemented" : "not_implemented", items: searchItems, note: "avledet av handlingsnavn (search/find/query/lookup)" }
    },
    authority: { owner: u(U.generic), delegated: u(U.generic), tenant: u(U.generic) },
    reversibility: { snapshot_support: u(U.generic) },
    idempotency: writeCapable
      ? { dedupe_key: "jarvis_idempotency_key", retry_semantics: u(U.generic), exactly_once_target: u(U.generic) }
      : { dedupe_key: "none", retry_semantics: { on_timeout: "safe_retry", on_rate_limit: "retry_after", on_server_error: "safe_retry" }, exactly_once_target: "not_applicable" },
    limits: { rate_limits: u(U.vendorFact), quotas: u(U.vendorFact) },
    trust: {
      output: { class: trustClass },
      injection_exposure: actions.length === 0
        ? u("ingen handlinger å vurdere")
        : actions.some((a) => a.trust.output === "untrusted")
          ? { level: "possible", note: "avledet: minst én handling returnerer ubetrodd innhold" }
          : { level: "none", note: "avledet: ingen handling returnerer ubetrodd innhold" },
      sanitization: u(U.generic)
    },
    data: { schemas: u(U.generic), provenance: u(U.generic), freshness: u(U.generic), retention: u(U.generic), delete_semantics: u(U.generic) },
    operations: {
      health_check: !built
        ? u("ikke bygget (backlog)")
        : def.live_test !== undefined
          ? { method: "live_probe", action_key: `${def.live_test.tool_id}.${def.live_test.action}`, cadence: "daglig helsesveip (ConnectorHealthSweep)" }
          : { method: "presence_only", action_key: null },
      timeout: actions.length === 0 ? u("ingen handlinger") : { max_ms: Math.max(...actions.map((a) => a.operations.timeout_ms)) },
      circuit_breaker: u(U.runtimeFact),
      metrics: u(U.runtimeFact),
      runbook: u(U.generic),
      maintenance_owner: u(U.runtimeFact)
    },
    secrets: {
      refs: [
        ...def.credential_refs.map((ref) => ({ ref, required: true, purpose: u("formål er ikke oppgitt i registeret") })),
        ...(def.optional_credential_refs ?? []).map((ref) => ({ ref, required: false, purpose: u("formål er ikke oppgitt i registeret") }))
      ],
      model_visibility: "never"
    },
    tests: { fake_adapter: u(U.generic), contract: u(U.generic), live_smoke: u(U.generic), authority: u(U.generic), recovery: u(U.generic), security: u(U.generic) },
    d41_audit: u("D-41-revisjonen er en leverandørvurdering mot offisiell dokumentasjon og kan ikke avledes"),
    // D-64 (review M3): svarene på Core-vs-Adapter-porten kan IKKE avledes fra registeret - en registeroppføring er ikke et svar. Skeletonet påstår derfor verken EXTERNAL_CANONICAL eller
    // «ingen kjerneavhengighet» (beslutningsloggen har HYBRID_WITH_CLEAR_AUTHORITY for fiken/stripe/vipps/neonomics/wallester); begge står som ukjent til porten er kjørt og loggført.
    core_boundary: {
      system_of_record: u(U.boundary),
      basis: "unassessed",
      external_role: u("D-64-rollen (kilde/sluk/utførelsesleverandør) er ikke revidert for denne connectoren i manifestet"),
      core_dependency_decision_required: u(U.coreDependency)
    },
    actions
  };
}

/** Skeleton-manifest for HVER connector i registeret (sortert som registeret). */
export function deriveSkeletonManifests(input: DeriveInput): ConnectorManifest[] {
  const registry = input.registry ?? CONNECTOR_REGISTRY;
  const toolManifest = buildToolManifest(input.definitions);
  const claimed = claimedDefinitions(registry, input.definitions);
  return registry.map((def) => deriveSkeletonManifest(def, claimed.get(def.id) ?? [], toolManifest, input));
}

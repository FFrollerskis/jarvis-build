import { z } from "zod";
import { containsSecret } from "@jarvis/core";
import {
  ConnectorManifestSchema, MIN_RISK_FOR_EFFECT, RISK_ORDER, isUnknown, kindOfEffect,
  type ActionSpec, type Completeness, type ConnectorManifest
} from "./manifest.ts";

/**
 * WP-I (D-472): validator for `ConnectorManifest`. Returnerer PRESISE og REDAKSJONSSIKRE feil: hver feil har `path` (felt-sti, kun skjema-definerte nøkler og array-indekser),
 * en stabil `code` og en `message` som BARE bruker skjemaets egne ord (forventet type/tillatte verdier/grenser) og handlingsnøkler (regex-begrenset, kan ikke bære en hemmelighet).
 * ALDRI den innsendte verdien: zod sin standardtekst («received 'xyz'») siteres ikke, og ukjente nøkkelnavn som ser ut som hemmeligheter vises som `<redacted>`.
 * En hemmelighetsskanning (`scanForSecrets` fra @jarvis/core - ÉN sentral skanner, ingen egne mønstre) går over HVER tekstverdi og HVERT nøkkelnavn i inndata FØR skjemaet kjøres.
 *
 * Etter skjemaet kjører semantiske regler som speiler eksisterende kjøretidsregler (verktøymanifestets invarianter, klasse D-kjeden, idempotens, D-41, D-64) - se `semanticIssues`.
 */

export interface ManifestIssue {
  path: string;
  code: string;
  message: string;
}

export interface ManifestValidation {
  ok: boolean;
  issues: ManifestIssue[];
  /** Kun satt når `ok`. */
  manifest: ConnectorManifest | null;
  /** Deklarert fullstendighet (hvis lesbar), også når valideringen feiler. */
  completeness: Completeness | null;
  /** Stier til `Unknown`-markørene (det ærlige «ikke avledbart»-registeret). Tom for et fullt manifest. */
  unknown_paths: string[];
}

export interface ValidateOptions {
  /** Krev `completeness: "full"` (akseptanse-/referansebruk). */
  require_full?: boolean;
}

export class ConnectorManifestError extends Error {
  constructor(readonly issues: readonly ManifestIssue[]) {
    // Kun sti og kode (aldri verdier) i meldingen.
    super(`connector_manifest_invalid: ${issues.length} feil: ${issues.slice(0, 8).map((i) => `${i.path || "<root>"}:${i.code}`).join("; ")}${issues.length > 8 ? "; ..." : ""}`);
    this.name = "ConnectorManifestError";
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Stier og hemmelighetsskanning
// ---------------------------------------------------------------------------------------------------------------------

type PathPart = string | number;

export function pathToString(path: readonly PathPart[]): string {
  let out = "";
  for (const part of path) out += typeof part === "number" ? `[${part}]` : out === "" ? part : `.${part}`;
  return out;
}

/** Nøkkelnavn fra INNDATA vises kun når de er rene identifikatorer uten hemmelighetsform; ellers `<redacted>`. */
function safeKey(key: string): string {
  return key.length <= 40 && /^[A-Za-z0-9_.-]+$/.test(key) && !containsSecret(key) ? key : "<redacted>";
}

const SCAN_MAX_NODES = 20_000;
const SCAN_MAX_DEPTH = 24;

/** Stier (med redigerte nøkkelnavn) til tekstverdier/nøkler som ligner hemmeligheter. Overskrides skannebudsjettet, feiler vi LUKKET (`scan_budget_exceeded`). */
function findSecretShapes(input: unknown): { paths: string[]; budgetExceeded: boolean } {
  const paths: string[] = [];
  let nodes = 0;
  let budgetExceeded = false;
  const walk = (value: unknown, path: PathPart[], depth: number): void => {
    if (budgetExceeded) return;
    if (++nodes > SCAN_MAX_NODES || depth > SCAN_MAX_DEPTH) { budgetExceeded = true; return; }
    if (typeof value === "string") {
      if (containsSecret(value)) paths.push(pathToString(path));
      return;
    }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, [...path, i], depth + 1)); return; }
    if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) {
        const shown = safeKey(k);
        if (shown === "<redacted>" && containsSecret(k)) paths.push(pathToString([...path, "<redacted-key>"]));
        walk(v, [...path, shown], depth + 1);
      }
    }
  };
  walk(input, [], 0);
  return { paths, budgetExceeded };
}

// ---------------------------------------------------------------------------------------------------------------------
// zod -> redaksjonssikre feil
// ---------------------------------------------------------------------------------------------------------------------

function formatZodIssue(issue: z.ZodIssue, out: ManifestIssue[]): void {
  const path = pathToString(issue.path);
  switch (issue.code) {
    case "invalid_union": {
      // Velg grenen som kom lengst (dypeste feilsti), så færrest feil. Union-grener er skjemaet selv (`maybe(...)`), så meldingene under er fortsatt skjema-ord.
      let best: z.ZodError | undefined;
      let bestDepth = -1;
      let bestCount = Number.POSITIVE_INFINITY;
      for (const branch of issue.unionErrors) {
        const depth = Math.max(0, ...branch.issues.map((i) => i.path.length));
        if (depth > bestDepth || (depth === bestDepth && branch.issues.length < bestCount)) { best = branch; bestDepth = depth; bestCount = branch.issues.length; }
      }
      if (best) for (const sub of best.issues) formatZodIssue(sub, out);
      else out.push({ path, code: "invalid_value", message: "value does not match any allowed shape" });
      return;
    }
    case "invalid_type":
      if (issue.received === "undefined") out.push({ path, code: "required", message: "field is required" });
      else out.push({ path, code: "invalid_type", message: `expected ${issue.expected}, got ${issue.received}` });
      return;
    case "invalid_literal":
      out.push({ path, code: "invalid_literal", message: "must equal the required constant" });
      return;
    case "invalid_enum_value":
      out.push({ path, code: "invalid_enum", message: `must be one of: ${issue.options.map((o) => String(o)).join(", ")}` });
      return;
    case "unrecognized_keys":
      out.push({ path, code: "unrecognized_key", message: `unrecognized field(s): ${issue.keys.map(safeKey).join(", ")}` });
      return;
    case "invalid_string":
      out.push({ path, code: "invalid_format", message: "string does not match the required format" });
      return;
    case "too_small":
      out.push({ path, code: "too_small", message: `too small (minimum ${String(issue.minimum)})` });
      return;
    case "too_big":
      out.push({ path, code: "too_big", message: `too large (maximum ${String(issue.maximum)})` });
      return;
    default:
      out.push({ path, code: "invalid_value", message: "value is not valid" });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Ukjent-markører
// ---------------------------------------------------------------------------------------------------------------------

/** Stier til alle `Unknown`-markører i et (allerede skjema-gyldig) manifest. */
export function collectUnknownPaths(manifest: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown, path: PathPart[]): void => {
    if (isUnknown(value)) { out.push(pathToString(path)); return; }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, [...path, i])); return; }
    if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
  };
  walk(manifest, []);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Semantiske regler
// ---------------------------------------------------------------------------------------------------------------------

const TRUST_ORDER = { trusted: 0, internal: 1, untrusted: 2 } as const;

/** Er handlingen skrivekapabel (alt annet enn ren lesing)? */
export function isWriteCapable(action: Pick<ActionSpec, "effect">): boolean {
  return action.effect !== "read";
}

function actionIssues(a: ActionSpec, i: number, out: ManifestIssue[]): void {
  const at = (field: string) => `actions[${i}].${field}`;
  const add = (field: string, code: string, message: string) => out.push({ path: at(field), code, message: `${a.key}: ${message}` });
  if (a.kind !== kindOfEffect(a.effect)) add("kind", "kind_effect_mismatch", `effekten «${a.effect}» hører til kap. 10-bøtten «${kindOfEffect(a.effect)}», ikke «${a.kind}»`);
  const min = MIN_RISK_FOR_EFFECT[a.effect];
  if (RISK_ORDER[a.authority.risk_class] < RISK_ORDER[min] && a.authority.risk_exception === undefined) {
    add("authority.risk_class", "risk_below_effect_minimum", `effekt «${a.effect}» krever minst klasse ${min} (er ${a.authority.risk_class}); lavere krever en begrunnet risk_exception`);
  }
  const req = a.idempotency.requirement;
  if (a.effect === "read") {
    if (req !== "none") add("idempotency.requirement", "read_with_idempotency_requirement", "lesing har ingen bivirkning å dedupe (krav skal være «none»)");
    if (a.reversibility.destructive) add("reversibility.destructive", "read_action_destructive", "en lese-handling kan ikke være destruktiv");
  } else {
    if (req === "none") add("idempotency.requirement", "write_without_idempotency_requirement", "skrive-/utførende handling må ha idempotenskrav (recommended eller required)");
    if ((a.authority.risk_class === "D" || a.effect === "pay" || a.effect === "send") && req !== "required") {
      add("idempotency.requirement", "idempotency_requirement_too_weak", "klasse D, betaling og utsending krever idempotensnøkkel (required)");
    }
  }
  if (a.effect === "delete" && !a.reversibility.destructive) add("reversibility.destructive", "delete_not_destructive", "sletting er alltid destruktiv");
  if (a.effect !== "read" && !a.reversibility.reversible && !a.reversibility.destructive) add("reversibility.destructive", "irreversible_not_destructive", "en handling som ikke kan reverseres er destruktiv");
  const method = a.reversibility.rollback_method;
  if (!isUnknown(method)) {
    if (a.effect !== "read" && a.reversibility.reversible && method === "none") add("reversibility.rollback_method", "reversible_without_rollback_method", "reversibel handling må oppgi en rollback-metode");
    if (!a.reversibility.reversible && method !== "none" && method !== "manual") add("reversibility.rollback_method", "irreversible_with_automatic_rollback", "ikke-reversibel handling kan bare ha rollback «none» eller «manual»");
    if (method === "compensating_action") {
      const c = a.reversibility.compensating_action;
      if (c === null || isUnknown(c)) add("reversibility.compensating_action", "compensating_action_missing", "rollback via kompenserende handling krever at handlingen er beskrevet");
    }
  }
  // Klasse D-kjeden (speiler `assessClassDPipeline` i class-d-pipeline.ts): gjenopprettingsplan (rollback_procedure er alltid utfylt), fersk tilstandslesing + etterbetingelse, idempotensnøkkel.
  if (a.authority.risk_class === "D") {
    if (a.reversibility.evidence.postcondition === "none") add("reversibility.evidence.postcondition", "class_d_missing_postcondition", "klasse D krever etterbetingelse (readback eller leverandørens bekreftede id)");
    if (a.reversibility.evidence.postcondition !== "provider_id" && !a.reversibility.evidence.before_state) add("reversibility.evidence.before_state", "class_d_missing_before_state", "klasse D krever fersk tilstandslesing før handlingen (før-tilstand = recovery-grunnlag)");
  }
}

function capabilityIssues(m: ConnectorManifest, out: ManifestIssue[]): void {
  const count = { read: 0, write: 0, action: 0 };
  for (const a of m.actions) count[a.kind] += 1;
  const rows: Array<["read" | "write" | "actions", number]> = [["read", count.read], ["write", count.write], ["actions", count.action]];
  for (const [name, n] of rows) {
    const status = m.capabilities[name].status;
    if ((status === "implemented" || status === "partial") && n === 0) out.push({ path: `capabilities.${name}.status`, code: "capability_without_actions", message: `«${name}» er ${status} men connectoren har ingen ${name}-handlinger` });
    if ((status === "not_implemented" || status === "deferred" || status === "provider_limited") && n > 0) out.push({ path: `capabilities.${name}.status`, code: "capability_declared_missing_but_has_actions", message: `«${name}» er ${status} men connectoren har ${n} ${name}-handling(er)` });
  }
  const readKeys = new Set(m.actions.filter((a) => a.kind === "read").map((a) => a.key));
  for (const name of ["webhooks", "sync", "search"] as const) {
    const cap = m.capabilities[name];
    if (isUnknown(cap)) continue;
    if ((cap.status === "implemented" || cap.status === "partial") && cap.items.length === 0) out.push({ path: `capabilities.${name}.items`, code: "capability_without_items", message: `«${name}» er ${cap.status} men har ingen elementer` });
    if ((cap.status === "not_implemented" || cap.status === "deferred" || cap.status === "provider_limited") && cap.items.length > 0) out.push({ path: `capabilities.${name}.items`, code: "capability_declared_missing_but_has_items", message: `«${name}» er ${cap.status} men har elementer` });
    if (name === "search") cap.items.forEach((k, idx) => { if (!readKeys.has(k)) out.push({ path: `capabilities.search.items[${idx}]`, code: "search_item_not_a_read_action", message: "søkeelementer må være lese-handlinger i actions[]" }); });
  }
}

function d41Issues(m: ConnectorManifest, out: ManifestIssue[]): void {
  const d = m.d41_audit;
  if (isUnknown(d)) return;
  const byKey = new Map(m.actions.map((a) => [a.key, a]));
  const caps = { read: d.read, write: d.write, delete: d.delete, access_control: d.access_control } as const;
  for (const [name, cap] of Object.entries(caps)) {
    cap.action_keys.forEach((k, idx) => { if (!byKey.has(k)) out.push({ path: `d41_audit.${name}.action_keys[${idx}]`, code: "unknown_action_key", message: "handlingsnøkkelen finnes ikke i actions[]" }); });
    if ((cap.implemented === "full" || cap.implemented === "partial") && cap.action_keys.length === 0) out.push({ path: `d41_audit.${name}`, code: "d41_cap_without_actions", message: `«${name}» er ${cap.implemented} men har ingen handlingsnøkler` });
    if (cap.implemented === "none" && cap.action_keys.length > 0) out.push({ path: `d41_audit.${name}`, code: "d41_cap_none_with_actions", message: `«${name}» er «none» men har handlingsnøkler` });
  }
  d.read.action_keys.forEach((k, idx) => { if (byKey.get(k) && byKey.get(k)!.effect !== "read") out.push({ path: `d41_audit.read.action_keys[${idx}]`, code: "d41_read_key_not_read", message: "lese-kapabiliteten kan bare peke på lese-handlinger" }); });
  d.delete.action_keys.forEach((k, idx) => { if (byKey.get(k) && byKey.get(k)!.effect !== "delete") out.push({ path: `d41_audit.delete.action_keys[${idx}]`, code: "d41_delete_key_not_delete", message: "slette-kapabiliteten kan bare peke på slette-handlinger" }); });
  d.write.action_keys.forEach((k, idx) => { const e = byKey.get(k)?.effect; if (e === "read" || e === "delete") out.push({ path: `d41_audit.write.action_keys[${idx}]`, code: "d41_write_key_not_write", message: "skrive-kapabiliteten kan ikke peke på lese- eller slette-handlinger (slette har egen kapabilitet)" }); });

  const anyWrite = m.actions.some(isWriteCapable);
  if (d.classification === "FULL") {
    if (d.gaps.length > 0) out.push({ path: "d41_audit.gaps", code: "d41_full_with_gaps", message: "FULL kan ikke ha åpne DEFERRED/PARTIAL-gap (bruk PARTIAL)" });
    for (const [name, cap] of Object.entries(caps)) if (cap.implemented === "partial" || (cap.provider_offers === "yes" && cap.implemented === "none")) out.push({ path: `d41_audit.${name}`, code: "d41_full_with_incomplete_capability", message: `FULL, men «${name}» er ikke fullt implementert selv om leverandøren tilbyr den` });
    if (!d.scopes_verified_against_docs) out.push({ path: "d41_audit.scopes_verified_against_docs", code: "d41_full_unverified_scopes", message: "FULL krever scopes verifisert mot offisiell dokumentasjon" });
  }
  if (d.classification === "PARTIAL" && d.gaps.length === 0) out.push({ path: "d41_audit.gaps", code: "d41_partial_without_gaps", message: "PARTIAL krever minst ett navngitt gap (DEFERRED/PARTIAL)" });
  if (d.classification === "READ_ONLY") {
    if (d.read_only_reason === undefined) out.push({ path: "d41_audit.read_only_reason", code: "d41_read_only_without_reason", message: "READ_ONLY er kun lovlig med en av D-41s fem grunner (read_only_reason)" });
    if (anyWrite) out.push({ path: "d41_audit.classification", code: "d41_read_only_but_write_actions", message: "READ_ONLY, men connectoren har skrive-/utførende handlinger" });
    if (d.read_only_reason === "provider_offers_nothing") {
      for (const name of ["write", "delete", "access_control"] as const) if (caps[name].provider_offers !== "no") out.push({ path: `d41_audit.${name}.provider_offers`, code: "d41_read_only_but_provider_offers", message: "grunnen «provider_offers_nothing» krever at leverandøren ikke tilbyr skriving/sletting/tilgangsstyring" });
    }
  }
  if (d.classification !== "READ_ONLY" && d.read_only_reason !== undefined) out.push({ path: "d41_audit.read_only_reason", code: "d41_reason_without_read_only", message: "read_only_reason hører bare til READ_ONLY" });
  if (d.classification === "PROVIDER_LIMITED" && !Object.values(caps).some((c) => c.provider_offers === "no")) out.push({ path: "d41_audit.classification", code: "d41_provider_limited_without_limit", message: "PROVIDER_LIMITED krever at leverandøren faktisk ikke tilbyr minst én kapabilitet" });
  if (d.scopes_verified_against_docs) {
    if (d.unverified_scopes.length > 0) out.push({ path: "d41_audit.unverified_scopes", code: "d41_verified_with_unverified_scopes", message: "scopes er markert verifisert, men unverified_scopes er ikke tom" });
    if (d.verified_on === undefined) out.push({ path: "d41_audit.verified_on", code: "d41_verified_without_date", message: "verifisering mot dokumentasjon krever dato (verified_on)" });
    if (d.docs_reference.length === 0) out.push({ path: "d41_audit.docs_reference", code: "d41_verified_without_reference", message: "verifisering mot dokumentasjon krever referanse til dokumentasjonen (docs_reference)" });
  }
}

function semanticIssues(m: ConnectorManifest): ManifestIssue[] {
  const out: ManifestIssue[] = [];
  const seen = new Set<string>();
  m.actions.forEach((a, i) => {
    if (seen.has(a.key)) out.push({ path: `actions[${i}].key`, code: "duplicate_action_key", message: `${a.key}: duplisert handlingsnøkkel` });
    seen.add(a.key);
    actionIssues(a, i, out);
  });
  capabilityIssues(m, out);
  d41Issues(m, out);

  const writeCapable = m.actions.some(isWriteCapable);
  const dedupe = m.idempotency.dedupe_key;
  if (writeCapable && (isUnknown(dedupe) || dedupe === "none")) out.push({ path: "idempotency.dedupe_key", code: "write_capable_without_idempotency", message: "connectoren har skrive-/utførende handlinger men oppgir ingen dedupe-nøkkel (idempotensinfo mangler)" });
  const stepUp = m.actions.filter((a) => a.authority.step_up_required).map((a) => a.key).sort();
  if (m.authority.approval_policy) {
    const declared = [...m.authority.approval_policy.step_up_actions].sort();
    if (declared.length !== stepUp.length || declared.some((k, i) => k !== stepUp[i])) out.push({ path: "authority.approval_policy.step_up_actions", code: "step_up_actions_mismatch", message: "step_up_actions må være nøyaktig handlingene med step_up_required" });
  }
  if (!isUnknown(m.auth.scopes.provider)) m.auth.scopes.provider.forEach((s, i) => s.needed_for.forEach((k, j) => { if (!seen.has(k)) out.push({ path: `auth.scopes.provider[${i}].needed_for[${j}]`, code: "unknown_action_key", message: "handlingsnøkkelen finnes ikke i actions[]" }); }));
  const timeout = m.operations.timeout;
  if (!isUnknown(timeout) && m.actions.length > 0 && timeout.max_ms !== Math.max(...m.actions.map((a) => a.operations.timeout_ms))) out.push({ path: "operations.timeout.max_ms", code: "timeout_max_mismatch", message: "max_ms må være høyeste per-handling-tidsavbrudd" });
  const hc = m.operations.health_check;
  if (!isUnknown(hc) && hc.action_key !== null && !seen.has(hc.action_key)) out.push({ path: "operations.health_check.action_key", code: "health_check_unknown_action", message: "helsesjekk-handlingen finnes ikke i actions[]" });
  if (!isUnknown(hc) && hc.method === "live_probe" && hc.action_key === null) out.push({ path: "operations.health_check.action_key", code: "live_probe_without_action", message: "live_probe krever en handlingsnøkkel" });
  if (m.actions.length > 0) {
    const strictest = m.actions.map((a) => a.trust.output).reduce((acc, t) => (TRUST_ORDER[t] > TRUST_ORDER[acc] ? t : acc), "trusted" as ActionSpec["trust"]["output"]);
    if (m.trust.output.class !== strictest) out.push({ path: "trust.output.class", code: "trust_class_mismatch", message: `connectorens utdata-klasse må være den strengeste per handling (${strictest})` });
    const inj = m.trust.injection_exposure;
    if (!isUnknown(inj) && inj.level === "none" && m.actions.some((a) => a.trust.output === "untrusted")) out.push({ path: "trust.injection_exposure.level", code: "injection_exposure_understated", message: "handlinger returnerer ubetrodd innhold, så eksponering kan ikke være «none»" });
  }
  const refs = new Set<string>();
  m.secrets.refs.forEach((r, i) => {
    if (refs.has(r.ref)) out.push({ path: `secrets.refs[${i}].ref`, code: "duplicate_secret_ref", message: "duplisert hvelvreferanse" });
    refs.add(r.ref);
  });
  if (m.secrets.refs.length === 0) out.push({ path: "secrets.refs", code: "no_secret_refs", message: "en connector må oppgi minst én hvelvreferanse (credential)" });
  if (m.core_boundary.system_of_record === "HYBRID_WITH_CLEAR_AUTHORITY" && m.core_boundary.authority_split === undefined) out.push({ path: "core_boundary.authority_split", code: "hybrid_requires_authority_split", message: "HYBRID_WITH_CLEAR_AUTHORITY krever authority_split (hvem har autoriteten over hva)" });
  return out;
}

function fullOnlyIssues(m: ConnectorManifest, unknownPaths: readonly string[]): ManifestIssue[] {
  const out: ManifestIssue[] = [];
  if (m.source !== "authored") out.push({ path: "source", code: "full_must_be_authored", message: "et fullt manifest er håndskrevet og gjennomgått (source: authored), aldri generert" });
  for (const p of unknownPaths) out.push({ path: p, code: "full_manifest_has_unknown", message: "et fullt manifest kan ikke inneholde «ukjent»-markører" });
  if (m.core_boundary.basis !== "audited") out.push({ path: "core_boundary.basis", code: "full_requires_audited_boundary", message: "et fullt manifest krever at Core-vs-Adapter-porten (D-64) er kjørt (basis: audited)" });
  if (m.core_boundary.core_dependency_decision_required) out.push({ path: "core_boundary.core_dependency_decision_required", code: "core_dependency_decision_required", message: "CORE_DEPENDENCY_DECISION_REQUIRED=true: leverandøren ville blitt en kjerneavhengighet - STOPP og avklar med eieren før manifestet kan godtas" });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Offentlig API
// ---------------------------------------------------------------------------------------------------------------------

export function validateConnectorManifest(input: unknown, options: ValidateOptions = {}): ManifestValidation {
  const issues: ManifestIssue[] = [];
  const scan = findSecretShapes(input);
  for (const p of scan.paths) issues.push({ path: p, code: "secret_shape_detected", message: "verdien ligner en hemmelighet (manifestet skal kun inneholde hvelvreferanser, aldri verdier)" });
  if (scan.budgetExceeded) issues.push({ path: "", code: "scan_budget_exceeded", message: "manifestet er for stort/dypt til å hemmelighetsskannes (feiler lukket)" });

  const declared = (typeof input === "object" && input !== null ? (input as { completeness?: unknown }).completeness : undefined);
  const completeness: Completeness | null = declared === "skeleton" || declared === "full" ? declared : null;

  const parsed = ConnectorManifestSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) formatZodIssue(issue, issues);
    return { ok: false, issues, manifest: null, completeness, unknown_paths: [] };
  }
  const manifest = parsed.data;
  const unknown_paths = collectUnknownPaths(manifest);
  issues.push(...semanticIssues(manifest));
  if (manifest.completeness === "full") issues.push(...fullOnlyIssues(manifest, unknown_paths));
  if (options.require_full === true && manifest.completeness !== "full") issues.push({ path: "completeness", code: "completeness_not_full", message: "fullt manifest kreves, men dette er et skeleton" });
  return { ok: issues.length === 0, issues, manifest: issues.length === 0 ? manifest : null, completeness: manifest.completeness, unknown_paths };
}

/** Kaster `ConnectorManifestError` (kun sti + kode i meldingen) ved ugyldig manifest. */
export function assertConnectorManifest(input: unknown, options: ValidateOptions = {}): ConnectorManifest {
  const result = validateConnectorManifest(input, options);
  if (!result.ok || result.manifest === null) throw new ConnectorManifestError(result.issues);
  return result.manifest;
}

import { describe, expect, it } from "vitest";
import {
  ACTION_EFFECTS, ACTION_KEY_PATTERN, CONNECTOR_ID_PATTERN, EXTRA_SECTIONS, MANIFEST_SECTION_SCHEMAS, MIN_RISK_FOR_EFFECT, SECTION_10_FIELDS, ConnectorManifestSchema, ConnectorManifestError,
  assertConnectorManifest, collectUnknownPaths, isUnknown, kindOfEffect, safeIdentifier, safeScalar, validateConnectorManifest, type ConnectorManifest, type ManifestIssue
} from "../src/index.ts";
import { ACME_KEYS, fakeSecretShapes, secretShapedActionKeys, secretShapedConnectorId, validFullManifest, validSkeletonManifest } from "./fixtures.ts";

const codes = (issues: readonly ManifestIssue[]) => issues.map((i) => i.code);
const has = (issues: readonly ManifestIssue[], code: string, path?: string) => issues.some((i) => i.code === code && (path === undefined || i.path === path));
type Mutate = (m: ConnectorManifest) => void;
const loose = (m: ConnectorManifest) => m as unknown as Record<string, unknown>;

describe("kap. 10-feltene: skjemaet har nøyaktig det masterplanen krever (ordrett)", () => {
  it("hver kap. 10-seksjon finnes på toppnivå, pluss meta, handlinger og de to CLAUDE.md-tilleggene (d41_audit, core_boundary) - og ingenting annet", () => {
    const top = Object.keys(ConnectorManifestSchema.shape).sort();
    const expected = [...Object.keys(SECTION_10_FIELDS), ...EXTRA_SECTIONS, "schema_version", "completeness", "source", "actions"].sort();
    expect(top).toEqual(expected);
  });

  it("hver seksjon har alle kap. 10-feltene (connector-nivå) og handlings-fasetten har per-handling-feltene (risikoklasse, rollback, idempotens, ...)", () => {
    const sections = MANIFEST_SECTION_SCHEMAS as unknown as Record<string, { shape: Record<string, unknown> }>;
    const action = MANIFEST_SECTION_SCHEMAS.action.shape as unknown as Record<string, { shape?: Record<string, unknown> }>;
    for (const [name, fields] of Object.entries(SECTION_10_FIELDS)) {
      const shape = sections[name]!.shape;
      for (const f of fields.connector) expect(Object.keys(shape), `${name}.${f}`).toContain(f);
      for (const f of fields.per_action) expect(Object.keys(action[name]!.shape ?? {}), `actions[].${name}.${f}`).toContain(f);
    }
  });

  it("kap. 10-feltlisten er ordrett fra masterplanen (identity/auth/capabilities/authority/reversibility/idempotency/limits/trust/data/operations/secrets/tests)", () => {
    expect(Object.keys(SECTION_10_FIELDS)).toEqual(["identity", "auth", "capabilities", "authority", "reversibility", "idempotency", "limits", "trust", "data", "operations", "secrets", "tests"]);
    expect(SECTION_10_FIELDS["identity"]!.connector).toEqual(["name", "vendor", "version", "owner", "environment"]);
    expect(SECTION_10_FIELDS["capabilities"]!.connector).toEqual(["read", "write", "actions", "webhooks", "sync", "search"]);
    expect(SECTION_10_FIELDS["operations"]!.connector).toEqual(["health_check", "timeout", "circuit_breaker", "metrics", "runbook", "maintenance_owner"]);
    expect(SECTION_10_FIELDS["tests"]!.connector).toEqual(["fake_adapter", "contract", "live_smoke", "authority", "recovery", "security"]);
  });

  it("D-64: system_of_record har nøyaktig de tre lovlige verdiene; D-41: kapabilitetsrevisjonen har lese/skrive/slette/tilgangsstyring og gap merket DEFERRED/PARTIAL", () => {
    // system_of_record er «maybe(enum)»: en union av de tre lovlige verdiene og Unknown-markøren (svaret på D-64-porten kan være ukjent til porten er kjørt).
    const sor = (MANIFEST_SECTION_SCHEMAS.core_boundary.shape.system_of_record as unknown as { options: Array<{ options?: string[] }> }).options[0]!.options;
    expect(sor).toEqual(["JARVIS_CANONICAL", "EXTERNAL_CANONICAL", "HYBRID_WITH_CLEAR_AUTHORITY"]);
    const d41 = Object.keys(MANIFEST_SECTION_SCHEMAS.d41_audit.shape);
    for (const f of ["read", "write", "delete", "access_control", "scopes_verified_against_docs", "gaps", "classification"]) expect(d41).toContain(f);
    const gap = (MANIFEST_SECTION_SCHEMAS.d41_audit.shape.gaps as unknown as { element: { shape: { status: { options: string[] } } } }).element.shape.status.options;
    expect(gap).toEqual(["DEFERRED", "PARTIAL"]);
  });

  it("effekt -> kap. 10-bøtte: read -> read; write/delete -> write; send/pay/control -> action", () => {
    expect(ACTION_EFFECTS.map(kindOfEffect)).toEqual(["read", "write", "action", "action", "write", "action"]);
    expect(MIN_RISK_FOR_EFFECT).toEqual({ read: "A", write: "B", send: "C", pay: "C", delete: "C", control: "C" });
  });
});

describe("gyldige manifester", () => {
  it("et fullt manifest er gyldig og har ingen ukjent-markører", () => {
    const r = validateConnectorManifest(validFullManifest(), { require_full: true });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.completeness).toBe("full");
    expect(r.unknown_paths).toEqual([]);
    expect(r.manifest?.identity.id).toBe("acme_tasks");
  });

  it("et skeleton er gyldig, og ukjent-markørene listes ærlig med sti (aldri oppfunnede verdier)", () => {
    const r = validateConnectorManifest(validSkeletonManifest());
    expect(r.issues).toEqual([]);
    expect(r.completeness).toBe("skeleton");
    expect(r.unknown_paths).toContain("identity.vendor");
    expect(r.unknown_paths).toContain("auth.type");
    expect(r.unknown_paths).toContain("d41_audit");
    expect(r.unknown_paths).toContain("actions[0].reversibility.rollback_method");
    expect(r.unknown_paths).toEqual(collectUnknownPaths(r.manifest));
  });

  it("require_full avviser et skeleton", () => {
    const r = validateConnectorManifest(validSkeletonManifest(), { require_full: true });
    expect(has(r.issues, "completeness_not_full", "completeness")).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("manifestet overlever JSON-rundtur (kan lagres som data og leses tilbake)", () => {
    const m = validFullManifest();
    expect(validateConnectorManifest(JSON.parse(JSON.stringify(m)) as unknown).ok).toBe(true);
  });

  it("isUnknown kjenner bare den eksakte markøren", () => {
    expect(isUnknown({ unknown: true, reason: "x" })).toBe(true);
    expect(isUnknown({ unknown: false, reason: "x" })).toBe(false);
    expect(isUnknown(null)).toBe(false);
    expect(isUnknown([{ unknown: true }])).toBe(false);
  });
});

describe("skjemafeil er presise (sti + kode + skjema-ord)", () => {
  it("ukjent felt på toppnivå, i en seksjon og i en handling avvises (strict)", () => {
    const m = validFullManifest();
    loose(m)["extra"] = 1;
    (m.identity as unknown as Record<string, unknown>)["nickname"] = "x";
    (m.actions[0] as unknown as Record<string, unknown>)["hidden"] = true;
    const r = validateConnectorManifest(m);
    expect(has(r.issues, "unrecognized_key", "")).toBe(true);
    expect(has(r.issues, "unrecognized_key", "identity")).toBe(true);
    expect(has(r.issues, "unrecognized_key", "actions[0]")).toBe(true);
  });

  it("manglende seksjon, feil enum, feil bokstav og feil format gir egne koder med riktig sti", () => {
    const m = validFullManifest();
    delete loose(m)["secrets"];
    m.actions[0]!.authority.risk_class = "E" as never;
    (m.secrets as unknown) = undefined;
    m.identity.id = "Bad Id!";
    const r = validateConnectorManifest(m);
    expect(has(r.issues, "required", "secrets")).toBe(true);
    expect(has(r.issues, "invalid_enum", "actions[0].authority.risk_class")).toBe(true);
    expect(has(r.issues, "invalid_format", "identity.id")).toBe(true);
    expect(r.issues.find((i) => i.code === "invalid_enum")?.message).toBe("must be one of: A, B, C, D");
  });

  it("model_visibility må være bokstavelig «never»", () => {
    const m = validFullManifest();
    (m.secrets as unknown as Record<string, unknown>)["model_visibility"] = "on_request";
    expect(has(validateConnectorManifest(m).issues, "invalid_literal", "secrets.model_visibility")).toBe(true);
  });

  it("en ukjent-markør med feil form i en maybe-slot rapporteres med skjemaets egne ord (ikke union-støy)", () => {
    const sk = validSkeletonManifest();
    (sk.identity as unknown as Record<string, unknown>)["vendor"] = { unknown: true };
    const r = validateConnectorManifest(sk);
    expect(has(r.issues, "required", "identity.vendor.reason")).toBe(true);
    expect(r.issues.length).toBeLessThanOrEqual(2);
  });

  it("ikke-objekt som inndata (null, streng, array, tall) gir feil uten å kræsje", () => {
    for (const bad of [null, undefined, "tekst", [], 42]) {
      const r = validateConnectorManifest(bad);
      expect(r.ok).toBe(false);
      expect(r.manifest).toBeNull();
      expect(r.issues.length).toBeGreaterThan(0);
    }
  });

  it("__proto__ som nøkkel behandles som ukjent felt, aldri som prototype-forurensning", () => {
    const polluted = JSON.parse(`{"__proto__": {"admin": true}}`) as unknown;
    const r = validateConnectorManifest(polluted);
    expect(r.ok).toBe(false);
    expect(({} as Record<string, unknown>)["admin"]).toBeUndefined();
  });

  it("for dypt/stort inndata feiler lukket (scan_budget_exceeded) i stedet for å skanne ubegrenset", () => {
    let deep: Record<string, unknown> = { v: "x" };
    for (let i = 0; i < 40; i++) deep = { n: deep };
    expect(has(validateConnectorManifest(deep).issues, "scan_budget_exceeded")).toBe(true);
  });

  it("duplisert handlingsnøkkel", () => {
    const m = validFullManifest();
    m.actions.push(structuredClone(m.actions[0]!));
    expect(has(validateConnectorManifest(m).issues, "duplicate_action_key", "actions[5].key")).toBe(true);
  });
});

describe("semantiske regler (speiler verktøymanifestet, klasse D-kjeden, idempotens, D-41 og D-64)", () => {
  const act = (m: ConnectorManifest, key: string) => m.actions.find((a) => a.key === key)!;
  const cases: Array<[string, Mutate, string, string?]> = [
    ["kind må stemme med effekt", (m) => { act(m, ACME_KEYS.create).kind = "read"; }, "kind_effect_mismatch"],
    ["skriving på klasse A uten begrunnet unntak", (m) => { act(m, ACME_KEYS.create).authority.risk_class = "A"; }, "risk_below_effect_minimum"],
    ["utsending på klasse B", (m) => { act(m, ACME_KEYS.notify).authority.risk_class = "B"; }, "risk_below_effect_minimum"],
    ["lavere klasse tillates med begrunnet risk_exception", (m) => { act(m, ACME_KEYS.notify).authority.risk_class = "B"; act(m, ACME_KEYS.notify).authority.risk_exception = "eierens egen kanal"; }, "__ok__"],
    ["lesing med idempotenskrav", (m) => { act(m, ACME_KEYS.list).idempotency.requirement = "recommended"; }, "read_with_idempotency_requirement"],
    ["skriving uten idempotenskrav", (m) => { act(m, ACME_KEYS.create).idempotency.requirement = "none"; }, "write_without_idempotency_requirement"],
    ["klasse D uten required", (m) => { act(m, ACME_KEYS.setting).idempotency.requirement = "recommended"; }, "idempotency_requirement_too_weak"],
    ["utsending uten required", (m) => { act(m, ACME_KEYS.notify).idempotency.requirement = "recommended"; }, "idempotency_requirement_too_weak"],
    ["sletting som ikke er destruktiv", (m) => { act(m, ACME_KEYS.remove).reversibility.destructive = false; }, "delete_not_destructive"],
    ["ikke-reversibel skriving som ikke er destruktiv", (m) => { act(m, ACME_KEYS.notify).reversibility.destructive = false; }, "irreversible_not_destructive"],
    ["lesehandling merket destruktiv", (m) => { act(m, ACME_KEYS.list).reversibility.destructive = true; }, "read_action_destructive"],
    ["reversibel skriving uten rollback-metode", (m) => { act(m, ACME_KEYS.create).reversibility.rollback_method = "none"; }, "reversible_without_rollback_method"],
    ["irreversibel med automatisk rollback", (m) => { act(m, ACME_KEYS.notify).reversibility.rollback_method = "provider_revert"; }, "irreversible_with_automatic_rollback"],
    ["kompenserende handling uten beskrivelse", (m) => { act(m, ACME_KEYS.create).reversibility.compensating_action = null; }, "compensating_action_missing"],
    ["klasse D uten etterbetingelse", (m) => { act(m, ACME_KEYS.setting).reversibility.evidence.postcondition = "none"; }, "class_d_missing_postcondition"],
    ["klasse D uten fersk tilstandslesing", (m) => { act(m, ACME_KEYS.setting).reversibility.evidence.before_state = false; }, "class_d_missing_before_state"],
    ["klasse D uten oppgitt kjedetilstand", (m) => { delete act(m, ACME_KEYS.setting).reversibility.class_d_chain; }, "class_d_chain_missing"],
    ["deferred klasse D-kjede uten navngitte manglende ledd", (m) => { act(m, ACME_KEYS.setting).reversibility.class_d_chain = { status: "deferred", missing: [] }; }, "class_d_chain_deferred_without_reason"],
    ["komplett klasse D-kjede med manglende ledd", (m) => { act(m, ACME_KEYS.setting).reversibility.class_d_chain = { status: "complete", missing: ["postcondition"] }; }, "class_d_chain_complete_with_missing"],
    ["klasse D-kjede på en handling som ikke er klasse D", (m) => { act(m, ACME_KEYS.create).reversibility.class_d_chain = { status: "complete", missing: [] }; }, "class_d_chain_on_non_d"],
    ["en ufullstendig klasse D-handling er lovlig når den er ærlig merket deferred (utilgjengelig under håndhevelse)", (m) => { const a = act(m, ACME_KEYS.setting); a.reversibility.evidence = { before_state: false, postcondition: "none" }; a.reversibility.class_d_chain = { status: "deferred", missing: ["fresh_state_read", "postcondition"] }; }, "__ok__"],
    ["klasse D «exempt» uten begrunnelse er en stille omgåelse", (m) => { act(m, ACME_KEYS.setting).reversibility.class_d_chain = { status: "exempt", missing: [] }; }, "class_d_chain_exempt_without_justification"],
    ["klasse D «exempt» med tom begrunnelse", (m) => { act(m, ACME_KEYS.setting).reversibility.class_d_chain = { status: "exempt", missing: [], justification: "   " }; }, "class_d_chain_exempt_without_justification"],
    ["klasse D «exempt» MED begrunnelse er lovlig (nødbryter)", (m) => { act(m, ACME_KEYS.setting).reversibility.class_d_chain = { status: "exempt", missing: [], justification: "nødbryter: må virke også når alt annet er nede" }; }, "__ok__"],
    ["begrunnelse på en kjede som ikke er «exempt»", (m) => { act(m, ACME_KEYS.setting).reversibility.class_d_chain = { status: "complete", missing: [], justification: "unødvendig" }; }, "class_d_chain_justification_without_exempt"],
    ["klasse D med leverandør-id som etterbetingelse trenger ikke før-tilstand (utgående melding)", (m) => { const a = act(m, ACME_KEYS.setting); a.reversibility.evidence = { before_state: false, postcondition: "provider_id" }; }, "__ok__"],
    ["lese-kapabilitet erklært implementert uten lese-handlinger", (m) => { m.actions = m.actions.filter((a) => a.kind !== "read"); }, "capability_without_actions", "capabilities.read.status"],
    ["skrive-kapabilitet «ikke implementert» men handlinger finnes", (m) => { m.capabilities.write = { status: "not_implemented" }; }, "capability_declared_missing_but_has_actions", "capabilities.write.status"],
    ["søkeelement som ikke er en lese-handling", (m) => { m.capabilities.search = { status: "implemented", items: [ACME_KEYS.create] }; }, "search_item_not_a_read_action"],
    ["webhooks implementert uten elementer", (m) => { m.capabilities.webhooks = { status: "implemented", items: [] }; }, "capability_without_items"],
    ["skrivekapabel connector uten dedupe-nøkkel", (m) => { m.idempotency.dedupe_key = "none"; }, "write_capable_without_idempotency", "idempotency.dedupe_key"],
    ["skrivekapabel connector med ukjent dedupe-nøkkel", (m) => { m.idempotency.dedupe_key = { unknown: true, reason: "x" }; }, "write_capable_without_idempotency"],
    ["safe_retry etter tidsavbrudd med skrivehandlinger som ikke er leverandør-idempotente (dobbeltutføring)", (m) => { m.idempotency.retry_semantics = { on_timeout: "safe_retry", on_rate_limit: "retry_after", on_server_error: "reconcile_before_retry" }; m.idempotency.exactly_once_target = "exactly_once"; }, "unsafe_retry_with_non_idempotent_writes", "idempotency.retry_semantics.on_timeout"],
    ["safe_retry ved 5xx med skrivehandlinger som ikke er leverandør-idempotente", (m) => { m.idempotency.retry_semantics = { on_timeout: "reconcile_before_retry", on_rate_limit: "retry_after", on_server_error: "safe_retry" }; }, "unsafe_retry_with_non_idempotent_writes", "idempotency.retry_semantics.on_server_error"],
    ["safe_retry er lovlig når ALLE skrivehandlinger er leverandør-idempotente", (m) => { for (const a of m.actions) a.idempotency.provider_idempotent = true; m.idempotency.retry_semantics = { on_timeout: "safe_retry", on_rate_limit: "retry_after", on_server_error: "safe_retry" }; }, "__ok__"],
    ["step-up-liste som ikke stemmer med handlingene", (m) => { m.authority.approval_policy = { step_up_actions: [ACME_KEYS.create], delegated_class_cd: "denied" }; }, "step_up_actions_mismatch"],
    ["leverandør-scope peker på ukjent handling", (m) => { m.auth.scopes.provider = [{ scope: "x:read", needed_for: ["acme.nope"] }]; }, "unknown_action_key"],
    ["timeout.max_ms stemmer ikke", (m) => { m.operations.timeout = { max_ms: 5 }; }, "timeout_max_mismatch"],
    ["helsesjekk peker på ukjent handling", (m) => { m.operations.health_check = { method: "live_probe", action_key: "acme.nope" }; }, "health_check_unknown_action"],
    ["live_probe uten handling", (m) => { m.operations.health_check = { method: "live_probe", action_key: null }; }, "live_probe_without_action"],
    ["utdata-klasse svakere enn strengeste handling", (m) => { m.trust.output = { class: "internal" }; }, "trust_class_mismatch"],
    ["injeksjonseksponering «none» med ubetrodd utdata", (m) => { m.trust.injection_exposure = { level: "none" }; }, "injection_exposure_understated"],
    ["duplisert hvelvreferanse", (m) => { m.secrets.refs.push({ ref: "ACME_API_TOKEN", required: false, purpose: "x" }); }, "duplicate_secret_ref"],
    ["ingen hvelvreferanser", (m) => { m.secrets.refs = []; }, "no_secret_refs"],
    ["HYBRID uten authority_split", (m) => { m.core_boundary = { system_of_record: "HYBRID_WITH_CLEAR_AUTHORITY", basis: "audited", external_role: "utførelsesleverandør", core_dependency_decision_required: false }; }, "hybrid_requires_authority_split"],
    ["HYBRID med authority_split er gyldig", (m) => { m.core_boundary = { system_of_record: "HYBRID_WITH_CLEAR_AUTHORITY", basis: "audited", decision_refs: ["D-109"], external_role: "utførelsesleverandør", authority_split: "Jarvis eier intensjonene; leverandøren eier betalingstilstanden", core_dependency_decision_required: false }; }, "__ok__"],
    ["kjerneavhengighet må avklares før et fullt manifest godtas", (m) => { m.core_boundary.core_dependency_decision_required = true; }, "core_dependency_decision_required"],
    ["fullt manifest med bare «unassessed»-grense", (m) => { m.core_boundary.basis = "unassessed"; }, "full_requires_audited_boundary"],
    ["unassessed grense som likevel påstår system_of_record (porten er ikke kjørt)", (m) => { m.core_boundary.basis = "unassessed"; delete m.core_boundary.decision_refs; }, "unassessed_boundary_asserts", "core_boundary.system_of_record"],
    ["unassessed grense som likevel svarer på CORE_DEPENDENCY_DECISION_REQUIRED", (m) => { m.core_boundary.basis = "unassessed"; delete m.core_boundary.decision_refs; }, "unassessed_boundary_asserts", "core_boundary.core_dependency_decision_required"],
    ["decision_refs uten revisjon (basis unassessed)", (m) => { m.core_boundary = { system_of_record: { unknown: true, reason: "ikke kjørt" }, basis: "unassessed", decision_refs: ["D-109"], external_role: { unknown: true, reason: "ikke kjørt" }, core_dependency_decision_required: { unknown: true, reason: "ikke kjørt" } }; }, "decision_refs_without_audit"],
    ["revidert grense uten beslutnings-id (basis audited krever decision_refs)", (m) => { delete m.core_boundary.decision_refs; }, "audited_boundary_without_decision", "core_boundary.decision_refs"],
    ["revidert grense med tom decision_refs", (m) => { m.core_boundary.decision_refs = []; }, "audited_boundary_without_decision"],
    ["revidert grense med ukjent system_of_record", (m) => { m.core_boundary.system_of_record = { unknown: true, reason: "ikke besluttet" }; }, "audited_boundary_has_unknown", "core_boundary.system_of_record"],
    ["revidert grense uten svar på CORE_DEPENDENCY_DECISION_REQUIRED", (m) => { m.core_boundary.core_dependency_decision_required = { unknown: true, reason: "ikke besluttet" }; }, "audited_boundary_has_unknown", "core_boundary.core_dependency_decision_required"],
    ["beslutnings-id med feil form", (m) => { m.core_boundary.decision_refs = ["109"]; }, "invalid_format", "core_boundary.decision_refs[0]"],
    ["fullt manifest med ukjent system_of_record", (m) => { m.core_boundary.system_of_record = { unknown: true, reason: "ikke besluttet" }; }, "full_manifest_has_unknown", "core_boundary.system_of_record"],
    ["fullt manifest må være håndskrevet", (m) => { m.source = "derived_from_registry"; }, "full_must_be_authored"],
    ["fullt manifest med ukjent-markør", (m) => { m.identity.vendor = { unknown: true, reason: "mangler" }; }, "full_manifest_has_unknown", "identity.vendor"]
  ];
  it.each(cases)("%s", (_name, mutate, code, path) => {
    const m = validFullManifest();
    mutate(m);
    const r = validateConnectorManifest(m);
    if (code === "__ok__") { expect(r.issues).toEqual([]); return; }
    expect(has(r.issues, code, path), `${code} i ${JSON.stringify(codes(r.issues))}`).toBe(true);
    expect(r.ok).toBe(false);
  });
});

describe("D-41-revisjonen (CLAUDE.md regel 11)", () => {
  const audit = (m: ConnectorManifest) => m.d41_audit as Exclude<ConnectorManifest["d41_audit"], { unknown: true; reason: string }>;
  const cases: Array<[string, Mutate, string]> = [
    ["FULL med åpne gap", (m) => { audit(m).classification = "FULL"; }, "d41_full_with_gaps"],
    ["FULL der leverandøren tilbyr tilgangsstyring som ikke er bygget", (m) => { audit(m).classification = "FULL"; audit(m).gaps = []; }, "d41_full_with_incomplete_capability"],
    ["FULL med uverifiserte scopes", (m) => { const a = audit(m); a.classification = "FULL"; a.gaps = []; a.access_control = { provider_offers: "no", implemented: "none", action_keys: [] }; a.scopes_verified_against_docs = false; a.unverified_scopes = ["x"]; }, "d41_full_unverified_scopes"],
    ["PARTIAL uten gap", (m) => { audit(m).gaps = []; }, "d41_partial_without_gaps"],
    ["READ_ONLY uten grunn", (m) => { audit(m).classification = "READ_ONLY"; }, "d41_read_only_without_reason"],
    ["READ_ONLY men connectoren har skrivehandlinger", (m) => { audit(m).classification = "READ_ONLY"; audit(m).read_only_reason = "scope_missing"; }, "d41_read_only_but_write_actions"],
    ["read_only_reason uten READ_ONLY", (m) => { audit(m).read_only_reason = "scope_missing"; }, "d41_reason_without_read_only"],
    ["PROVIDER_LIMITED uten faktisk begrensning", (m) => { audit(m).classification = "PROVIDER_LIMITED"; }, "d41_provider_limited_without_limit"],
    ["verifiserte scopes med uverifiserte igjen", (m) => { audit(m).unverified_scopes = ["x"]; }, "d41_verified_with_unverified_scopes"],
    ["verifisering uten dato", (m) => { delete audit(m).verified_on; }, "d41_verified_without_date"],
    ["verifisering uten dokumentasjonsreferanse", (m) => { audit(m).docs_reference = []; }, "d41_verified_without_reference"],
    ["FULL med en ikke-vurdert kapabilitet (provider_offers unknown)", (m) => { const a = audit(m); a.classification = "FULL"; a.gaps = []; a.access_control = { provider_offers: "unknown", implemented: "none", action_keys: [] }; }, "d41_full_with_unassessed_capability"],
    ["lese-kapabilitet som peker på en skrivehandling", (m) => { audit(m).read.action_keys = [ACME_KEYS.create]; }, "d41_read_key_not_read"],
    ["slette-kapabilitet som peker på en ikke-slette-handling", (m) => { audit(m).delete.action_keys = [ACME_KEYS.create]; }, "d41_delete_key_not_delete"],
    ["skrive-kapabilitet som peker på en slettehandling", (m) => { audit(m).write.action_keys = [ACME_KEYS.remove]; }, "d41_write_key_not_write"],
    ["kapabilitet «none» med handlingsnøkler", (m) => { audit(m).access_control = { provider_offers: "yes", implemented: "none", action_keys: [ACME_KEYS.create] }; }, "d41_cap_none_with_actions"],
    ["implementert kapabilitet uten handlingsnøkler", (m) => { audit(m).read = { provider_offers: "yes", implemented: "full", action_keys: [] }; }, "d41_cap_without_actions"],
    ["revisjon peker på ukjent handling", (m) => { audit(m).read.action_keys = ["acme.nope"]; }, "unknown_action_key"],
    ["skrivehandling som ikke står under noen revidert kapabilitet (stille utelatt)", (m) => { audit(m).write.action_keys = [ACME_KEYS.create, ACME_KEYS.setting]; }, "d41_action_not_audited"],
    ["slettehandling som ikke står under noen revidert kapabilitet (stille utelatt)", (m) => { audit(m).delete = { provider_offers: "yes", implemented: "none", action_keys: [] }; }, "d41_action_not_audited"]
  ];
  it.each(cases)("%s", (_name, mutate, code) => {
    const m = validFullManifest();
    mutate(m);
    expect(has(validateConnectorManifest(m).issues, code), codes(validateConnectorManifest(m).issues).join(",")).toBe(true);
  });

  describe("slettesemantikken (data.delete_semantics) motsier ikke D-41-revisjonen av sletting (review LOW: Stripe sa «not_offered» mens revisjonen sa «unknown»)", () => {
    /** Et manifest uten slettehandling, så ingen annen regel forstyrrer: bare `provider_side` og `provider_offers` varierer. */
    const make = (providerSide: "supported" | "not_offered" | "deferred" | "not_applicable", offers: "yes" | "no" | "unknown"): ConnectorManifest => {
      const m = validFullManifest();
      m.actions = m.actions.filter((a) => a.key !== ACME_KEYS.remove);
      (m.auth.scopes.provider as Array<{ needed_for: string[] }>).forEach((p) => { p.needed_for = p.needed_for.filter((k) => k !== ACME_KEYS.remove); });
      audit(m).delete = { provider_offers: offers, implemented: "none", action_keys: [] };
      m.data.delete_semantics = { provider_side: providerSide, jarvis_side: "revisjon beholdes etter retensjonsregelen" };
      return m;
    };
    const rows: Array<["supported" | "not_offered" | "deferred" | "not_applicable", "yes" | "no" | "unknown", boolean]> = [
      ["supported", "yes", false], ["supported", "no", true], ["supported", "unknown", false],
      ["not_offered", "no", false], ["not_offered", "yes", true], ["not_offered", "unknown", true],
      ["deferred", "yes", false], ["deferred", "unknown", false], ["deferred", "no", false],
      ["not_applicable", "no", false], ["not_applicable", "unknown", false]
    ];
    it.each(rows)("provider_side %s + provider_offers %s => konflikt: %s", (side, offers, conflict) => {
      const r = validateConnectorManifest(make(side, offers));
      expect(has(r.issues, "delete_semantics_conflict"), JSON.stringify(codes(r.issues))).toBe(conflict);
      if (!conflict) expect(r.issues, JSON.stringify(codes(r.issues))).toEqual([]);
    });
  });

  it("en handling revidert under tilgangsstyring regnes som revidert (ikke stille utelatt), og den umutterte fixturen har full revisjonsdekning", () => {
    const m = validFullManifest();
    expect(has(validateConnectorManifest(m).issues, "d41_action_not_audited")).toBe(false);
    audit(m).write.action_keys = [ACME_KEYS.create, ACME_KEYS.setting];
    audit(m).access_control = { provider_offers: "yes", implemented: "partial", action_keys: [ACME_KEYS.notify] };
    expect(has(validateConnectorManifest(m).issues, "d41_action_not_audited")).toBe(false);
  });

  it("READ_ONLY er lovlig for en ren lese-connector med en av de fem grunnene (leverandøren tilbyr ingenting mer)", () => {
    const m = validFullManifest();
    m.actions = m.actions.filter((a) => a.effect === "read");
    m.capabilities.write = { status: "provider_limited" };
    m.capabilities.actions = { status: "provider_limited" };
    m.capabilities.webhooks = { status: "not_implemented", items: [] };
    m.idempotency = { dedupe_key: "none", retry_semantics: { on_timeout: "safe_retry", on_rate_limit: "retry_after", on_server_error: "safe_retry" }, exactly_once_target: "not_applicable" };
    delete (m.authority as Record<string, unknown>)["approval_policy"];
    m.auth.scopes.provider = [{ scope: "tasks:read", needed_for: [ACME_KEYS.list] }];
    m.data.delete_semantics = { provider_side: "not_offered", jarvis_side: "revisjon beholdes; leverandøren tilbyr ikke sletting" };
    m.d41_audit = {
      classification: "READ_ONLY", read_only_reason: "provider_offers_nothing",
      read: { provider_offers: "yes", implemented: "full", action_keys: [ACME_KEYS.list] },
      write: { provider_offers: "no", implemented: "none", action_keys: [] },
      delete: { provider_offers: "no", implemented: "none", action_keys: [] },
      access_control: { provider_offers: "no", implemented: "none", action_keys: [] },
      scopes_verified_against_docs: true, unverified_scopes: [], verified_on: "2026-11-14", docs_reference: ["Acme API-referanse (fiktiv)"], gaps: []
    };
    const r = validateConnectorManifest(m);
    expect(r.issues).toEqual([]);
    // ...men «provider_offers_nothing» med en skrive-kapabilitet leverandøren faktisk tilbyr er ikke lovlig.
    if (!isUnknown(m.d41_audit)) m.d41_audit.write.provider_offers = "yes";
    expect(has(validateConnectorManifest(m).issues, "d41_read_only_but_provider_offers")).toBe(true);
  });
});

describe("hemmeligheter: kun hvelvreferanser, og feilene gjentar aldri verdien (redaksjonssikre)", () => {
  const shapes = Object.entries(fakeSecretShapes).map(([name, make]) => [name, make()] as const);

  it("hvelvreferanse har formen STORE_BOKSTAVER_MED_UNDERSTREK; verdier avvises som format OG som hemmelighetsform", () => {
    for (const [name, value] of shapes) {
      const m = validFullManifest();
      m.secrets.refs[0]!.ref = value;
      const r = validateConnectorManifest(m);
      expect(has(r.issues, "invalid_format", "secrets.refs[0].ref"), name).toBe(true);
      expect(has(r.issues, "secret_shape_detected", "secrets.refs[0].ref"), name).toBe(true);
    }
  });

  it("en hemmelighetsformet verdi i fritekst (notat, ukjent-markørens grunn, dokumentreferanse) feiler med sti, uten å sitere verdien", () => {
    const where: Array<[string, (m: ConnectorManifest, v: string) => void]> = [
      ["d41_audit.gaps[0].reason", (m, v) => { (m.d41_audit as { gaps: Array<{ reason: string }> }).gaps[0]!.reason = `bruk ${v} for tilgang`; }],
      ["limits.rate_limits", (m, v) => { m.limits.rate_limits = v; }],
      ["auth.rotation.note", (m, v) => { (m.auth.rotation as { note?: string }).note = v; }],
      ["d41_audit.docs_reference[0]", (m, v) => { (m.d41_audit as { docs_reference: string[] }).docs_reference[0] = v; }]
    ];
    for (const [path, set] of where) {
      for (const [name, value] of shapes) {
        const m = validFullManifest();
        set(m, value);
        const r = validateConnectorManifest(m);
        expect(has(r.issues, "secret_shape_detected", path), `${path}/${name}`).toBe(true);
        expect(r.ok).toBe(false);
        const blob = JSON.stringify(r.issues);
        expect(blob.includes(value), `${path}/${name} lekket verdien`).toBe(false);
      }
    }
    const sk = validSkeletonManifest();
    (sk.identity.vendor as { reason: string }).reason = `x ${fakeSecretShapes.githubToken()}`;
    expect(has(validateConnectorManifest(sk).issues, "secret_shape_detected", "identity.vendor.reason")).toBe(true);
  });

  it("hemmelighetsformede NØKKELNAVN vises som <redacted>, aldri sitert", () => {
    const m = validFullManifest();
    const key = fakeSecretShapes.githubToken();
    (m.identity as unknown as Record<string, unknown>)[key] = "x";
    const r = validateConnectorManifest(m);
    expect(has(r.issues, "unrecognized_key", "identity")).toBe(true);
    expect(r.issues.some((i) => i.path.includes("<redacted-key>"))).toBe(true);
    expect(JSON.stringify(r.issues).includes(key)).toBe(false);
  });

  it("verdien siteres aldri heller når den står i en ENUM-, LITERAL- eller TYPE-posisjon (zod sin standardtekst ville gjort det)", () => {
    const value = fakeSecretShapes.githubToken();
    const places: Array<[string, Mutate]> = [
      ["enum", (m) => { m.actions[0]!.authority.risk_class = value as never; }],
      ["literal", (m) => { (m.secrets as unknown as Record<string, unknown>)["model_visibility"] = value; }],
      ["type", (m) => { (m.identity as unknown as Record<string, unknown>)["name"] = { v: value }; }],
      ["format", (m) => { m.identity.id = value; }],
      ["schema_version", (m) => { loose(m)["schema_version"] = value; }]
    ];
    for (const [place, mutate] of places) {
      const m = validFullManifest();
      mutate(m);
      const r = validateConnectorManifest(m);
      expect(r.ok, place).toBe(false);
      expect(JSON.stringify(r.issues).includes(value), place).toBe(false);
      expect(JSON.stringify(r).includes(value), `${place} (hele resultatet)`).toBe(false);
    }
  });

  it("assertConnectorManifest kaster ConnectorManifestError med kun sti og kode i meldingen", () => {
    const m = validFullManifest();
    m.secrets.refs[0]!.ref = fakeSecretShapes.stripeKey();
    let caught: unknown;
    try { assertConnectorManifest(m); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ConnectorManifestError);
    const err = caught as ConnectorManifestError;
    expect(err.message).toContain("secrets.refs[0].ref:invalid_format");
    expect(err.message.includes(fakeSecretShapes.stripeKey())).toBe(false);
    expect(err.issues.length).toBeGreaterThan(0);
    expect(assertConnectorManifest(validFullManifest()).identity.id).toBe("acme_tasks");
  });

  it("vanlig prosa med ord som «token» og «key» uten verdi er ikke en hemmelighet (ingen falske positive på manifest-tekst)", () => {
    const m = validFullManifest();
    m.auth.rotation = { credential_kind: "api_key", method: "manual", note: "eieren fornyer API-nøkkelen i dashbordet; token utløper aldri automatisk" };
    m.limits.quotas = "ingen kjente kvoter; ved auth-feil: be eieren legge inn nøkkelen på nytt";
    expect(validateConnectorManifest(m).issues).toEqual([]);
  });
});

describe("review M2: hemmelighetsformede IDENTIFIKATORER (handlingsnøkler, connector-id) ekkoes aldri av noen meldingsvei", () => {
  const keys = secretShapedActionKeys();
  const leaks = (value: string, ...things: unknown[]): boolean => things.some((t) => JSON.stringify(t).includes(value) || String(t).includes(value));

  it("regexen alene godtar nøklene (derfor trengs skjema-vernet), men skjemaet avviser dem som secret_shaped_identifier", () => {
    expect(keys.length).toBe(4);
    for (const key of keys) {
      expect(ACTION_KEY_PATTERN.test(key), "regexen godtar nøkkelen").toBe(true);
      const m = validFullManifest();
      m.actions[0]!.key = key;
      const r = validateConnectorManifest(m);
      expect(has(r.issues, "secret_shaped_identifier", "actions[0].key"), key.slice(0, 6)).toBe(true);
      expect(has(r.issues, "secret_shape_detected", "actions[0].key"), key.slice(0, 6)).toBe(true);
      expect(r.ok).toBe(false);
      expect(leaks(key, r), "hele resultatet").toBe(false);
    }
  });

  it("duplikat og kind/effekt-mismatch med hemmelighetsformet nøkkel: verken melding, sti, kode eller resultat inneholder verdien (repro fra review M2)", () => {
    for (const key of keys) {
      const dup = validFullManifest();
      dup.actions[0]!.key = key;
      dup.actions.push(structuredClone(dup.actions[0]!));
      const kind = validFullManifest();
      kind.actions[0]!.key = key;
      kind.actions[0]!.kind = "write";
      for (const m of [dup, kind]) {
        const r = validateConnectorManifest(m);
        expect(r.ok).toBe(false);
        expect(leaks(key, r, r.issues, r.issues.map((i) => i.message), r.issues.map((i) => i.path)), key.slice(0, 6)).toBe(false);
      }
    }
  });

  it("samme i ALLE lister som bærer handlingsnøkler: d41-revisjonen, step-up-listen, leverandør-scopes og helsesjekken", () => {
    const key = keys[0]!;
    const places: Array<[string, string, Mutate]> = [
      ["d41_audit.read.action_keys[0]", "secret_shaped_identifier", (m) => { (m.d41_audit as { read: { action_keys: string[] } }).read.action_keys[0] = key; }],
      ["authority.approval_policy.step_up_actions[0]", "secret_shaped_identifier", (m) => { m.authority.approval_policy!.step_up_actions[0] = key; }],
      ["auth.scopes.provider[0].needed_for[0]", "secret_shaped_identifier", (m) => { (m.auth.scopes.provider as Array<{ needed_for: string[] }>)[0]!.needed_for[0] = key; }],
      ["operations.health_check.action_key", "secret_shaped_identifier", (m) => { (m.operations.health_check as { action_key: string | null }).action_key = key; }]
    ];
    for (const [path, code, mutate] of places) {
      const m = validFullManifest();
      mutate(m);
      const r = validateConnectorManifest(m);
      expect(has(r.issues, code, path), `${path}: ${JSON.stringify(codes(r.issues))}`).toBe(true);
      expect(leaks(key, r), path).toBe(false);
    }
  });

  it("assertConnectorManifest: ConnectorManifestError (message, issues, stack, enumererbare felt) inneholder aldri verdien", () => {
    for (const key of keys) {
      const m = validFullManifest();
      m.actions[0]!.key = key;
      m.actions.push(structuredClone(m.actions[0]!));
      let caught: unknown;
      try { assertConnectorManifest(m); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(ConnectorManifestError);
      const err = caught as ConnectorManifestError;
      expect(err.issues.length).toBeGreaterThan(0);
      expect(leaks(key, err.message, err.issues, err.stack ?? "", Object.keys(err), { ...err }), key.slice(0, 6)).toBe(false);
    }
  });

  it("de semantiske reglene (den eneste fasen som gjentar identifikatorer) kjøres IKKE når skanneren fant en hemmelighetsform - og kommer tilbake når den er rettet", () => {
    const m = validFullManifest();
    m.actions.find((a) => a.key === ACME_KEYS.create)!.kind = "read";
    m.limits.quotas = `bruk ${fakeSecretShapes.githubToken()} her`;
    const blocked = validateConnectorManifest(m);
    expect(has(blocked.issues, "secret_shape_detected", "limits.quotas")).toBe(true);
    expect(has(blocked.issues, "kind_effect_mismatch")).toBe(false);
    m.limits.quotas = "ingen kjente kvoter";
    expect(has(validateConnectorManifest(m).issues, "kind_effect_mismatch")).toBe(true);
  });

  it("en connector-id med hemmelighetsform avvises og ekkoes ikke", () => {
    const id = secretShapedConnectorId();
    expect(CONNECTOR_ID_PATTERN.test(id)).toBe(true);
    const m = validFullManifest();
    m.identity.id = id;
    const r = validateConnectorManifest(m);
    expect(has(r.issues, "secret_shaped_identifier", "identity.id")).toBe(true);
    expect(leaks(id, r)).toBe(false);
  });

  it("safeIdentifier/safeScalar: rene navn og enkle verdier vises, hemmelighetsformer og ukjente former vises aldri", () => {
    expect(safeIdentifier("github.merge_pr")).toBe("github.merge_pr");
    expect(safeIdentifier(keys[0]!)).toBe("<redacted>");
    expect(safeIdentifier("x".repeat(121))).toBe("<redacted>");
    expect(safeIdentifier(42)).toBe("<invalid>");
    expect(safeScalar("D")).toBe("D");
    expect(safeScalar(true)).toBe("true");
    expect(safeScalar(12)).toBe("12");
    expect(safeScalar(undefined)).toBe("undefined");
    expect(safeScalar(keys[1]!)).toBe("<redacted>");
    expect(safeScalar({ a: 1 })).toBe("<redacted>");
    expect(safeScalar("med mellomrom")).toBe("<redacted>");
  });
});

describe("review N5: hemmelighetsmeldingen sier HVILKEN funn-type den sentrale skanneren fant (aldri teksten som traff)", () => {
  const secretIssues = (set: (m: ConnectorManifest) => void): ManifestIssue[] => {
    const m = validFullManifest();
    set(m);
    return validateConnectorManifest(m).issues.filter((i) => i.code === "secret_shape_detected");
  };
  /** NAVN=verdi bygges ved kjøring av fragmenter (aldri som bokstav i kilden). */
  const namedSecret = (): string => `${["API", "KEY"].join("_")}=${"x7".repeat(8)}`;

  it("hver kjent hemmelighetsform gir sin funn-type i både `finding_kinds` og meldingen, og verdien (eller et prefiks av den) ekkoes aldri", () => {
    const expected: Array<[string, string, string]> = [
      ["github-token", fakeSecretShapes.githubToken(), "github_token"], ["bearer", fakeSecretShapes.bearer(), "bearer_token"], ["aws", fakeSecretShapes.awsKey(), "aws_access_key"],
      ["stripe", fakeSecretShapes.stripeKey(), "stripe_key"], ["url med passord", fakeSecretShapes.url(), "url_credentials"], ["NAVN=verdi", namedSecret(), "named_secret"]
    ];
    for (const [label, value, kind] of expected) {
      const issues = secretIssues((m) => { m.limits.quotas = `bruk ${value} her`; });
      expect(issues.length, label).toBe(1);
      expect(issues[0]!.path, label).toBe("limits.quotas");
      expect(issues[0]!.finding_kinds, label).toEqual([kind]);
      expect(issues[0]!.message, label).toContain(`skannerfunn: ${kind}`);
      const blob = JSON.stringify(issues);
      for (const leak of [value, value.slice(0, 8), value.slice(-8)]) expect(blob.includes(leak), `${label}: ${leak}`).toBe(false);
    }
  });

  it("et hemmelighetsformet NØKKELNAVN får også funn-type (på stien <redacted-key>) uten å sitere nøkkelen", () => {
    const key = fakeSecretShapes.githubToken();
    const issues = secretIssues((m) => { (m.limits as unknown as Record<string, unknown>)[key] = "x"; });
    const hit = issues.find((i) => i.path === "limits.<redacted-key>");
    expect(hit?.finding_kinds).toEqual(["github_token"]);
    expect(JSON.stringify(issues).includes(key.slice(0, 8))).toBe(false);
  });

  it("flere funn i samme tekst gir alle typene (unike, i funnrekkefølge) - og meldingen peker til runbook §2 for falske positive", () => {
    const issues = secretIssues((m) => { m.limits.quotas = `${fakeSecretShapes.githubToken()} og ${namedSecret()}`; });
    expect(issues[0]!.finding_kinds).toEqual(["github_token", "named_secret"]);
    expect(issues[0]!.message).toContain("runbook §2");
  });

  it("DOKUMENTERT falsk positiv (runbook §2): vanlig prosa av formen «ord: verdi» treffer `named_secret`; den anbefalte omskrivingen gjør det ikke", () => {
    // Skannerens `named_secret` (modules/core/src/services/secret-scan.ts) treffer et nøkkelord (TOKEN/SECRET/PASSWORD/API_KEY/CREDENTIAL/AUTH - også inni et ord, som «authority») rett før `:`/`=` og en verdi på minst 6 tegn.
    // Skannerens egen presisjon er IKKE endret av WP-I. Endres skanneren slik at disse ikke lenger treffer, rettes runbook §2 (og denne testen) - det er hele poenget med å låse dokumentasjonen her.
    const flagged = ["credential: bundet til eieren", "authority: sovereign", "secret: ligger kun i vaulten", "credential_binding: owner_bound"];
    const reworded = ["Credentialen er bundet til eieren", "sovereign authority (eieren)", "Hemmeligheten ligger kun i vaulten", "credential binding: owner_bound"];
    for (const phrase of flagged) {
      const issues = secretIssues((m) => { m.limits.quotas = phrase; });
      expect(issues.map((i) => i.finding_kinds), phrase).toEqual([["named_secret"]]);
      expect(JSON.stringify(issues).includes(phrase), `${phrase}: meldingen skal ikke sitere teksten`).toBe(false);
    }
    for (const phrase of reworded) expect(secretIssues((m) => { m.limits.quotas = phrase; }), phrase).toEqual([]);
  });
});

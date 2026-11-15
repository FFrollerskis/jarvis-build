import { CONNECTOR_REGISTRY, type ConnectorDefinition } from "@jarvis/tool-gateway";
import { buildManifestCatalogue, type Catalogue, type CatalogueInput } from "./catalogue.ts";
import { deriveSkeletonManifests } from "./derive.ts";
import { isUnknown, safeIdentifier, type ConnectorManifest } from "./manifest.ts";
import { validateConnectorManifest, type ManifestIssue } from "./validate.ts";

/**
 * WP-I (D-472): CI-VAKT for connector-manifester. Ren funksjon (filsystemet injiseres), brukt av `guard.test.ts` som en CI-port: en connector kan ikke legges til, endres eller beskrives uten at manifestet følger med.
 *
 * Reglene (kap. 10 + CLAUDE.md regel 11/12 + Appendiks B):
 *  - hver registeroppføring har et manifest (et avledet skeleton er nok) med eier, tillitsklasse og risikoklasse per handling;
 *  - alle manifester er gyldige (skjema + semantiske regler), og et håndskrevet manifest er `full`;
 *  - hvert fullt manifest har en runbook-sti som FINNES, og hver teststi det oppgir finnes;
 *  - ingen manifest refererer en hemmelighets VERDI (kun hvelvreferanser);
 *  - en skrivekapabel connector uten idempotensinfo feiler;
 *  - et håndskrevet manifest har ingen drift mot registeret, er ikke foreldreløst og ikke dobbelt.
 * Vakten svekker aldri en regel stille: en regel som ikke kan evalueres (ugyldig inndata) er et brudd, ikke en hopp-over.
 */

export const GUARD_RULES = [
  "registry_connector_without_manifest", "manifest_invalid", "missing_owner", "missing_trust_class", "action_without_risk_class", "authored_manifest_not_full",
  "runbook_not_declared", "runbook_file_missing", "test_evidence_without_path", "test_file_missing", "secret_value_in_manifest", "write_capable_without_idempotency",
  "manifest_drift", "orphan_manifest", "duplicate_manifest"
] as const;
export type GuardRule = (typeof GUARD_RULES)[number];

export interface GuardViolation {
  rule: GuardRule;
  connector_id: string | null;
  path: string;
  message: string;
}

export interface GuardInput extends Omit<CatalogueInput, "authored"> {
  /** Håndskrevne manifester SLIK DE ER SKREVET (ikke nødvendigvis gyldige - vakten må kunne si hvorfor). */
  authored: readonly unknown[];
  /** Finnes denne repo-relative stien? (Injisert: vakten selv rører ikke filsystemet.) */
  fileExists: (repoRelativePath: string) => boolean;
}

export interface GuardReport {
  ok: boolean;
  violations: GuardViolation[];
  coverage: {
    registry_total: number;
    built: number;
    backlog: number;
    model_provider: number;
    full: string[];
    skeleton: number;
    /** Ukjent-markører per skeleton: arbeidslisten for å oppgradere en connector til `full`. */
    unknown_fields_by_connector: Record<string, number>;
  };
}

const WRITE_IDEMPOTENCY_CODES = new Set(["write_capable_without_idempotency", "write_without_idempotency_requirement", "idempotency_requirement_too_weak"]);

function at(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Connector-id fra et RÅTT (uvalidert) manifest. Aldri en hemmelighetsformet verdi i vaktens utdata (review M2): `null` når id mangler, `<redacted>` når den ligner en hemmelighet. */
function idOf(raw: unknown): string | null {
  const id = at(raw, "identity", "id");
  return typeof id === "string" ? safeIdentifier(id) : null;
}

/** Eier, tillitsklasse og risikoklasse per handling - sjekket på det RÅ manifestet, så et manglende felt får et eget, navngitt brudd. */
function requiredFieldViolations(raw: unknown, out: GuardViolation[]): void {
  const id = idOf(raw);
  const owner = at(raw, "identity", "owner");
  if (typeof owner !== "object" || owner === null || typeof (owner as { kind?: unknown }).kind !== "string" || typeof (owner as { ref?: unknown }).ref !== "string") {
    out.push({ rule: "missing_owner", connector_id: id, path: "identity.owner", message: "manifestet har ingen eier (kind + ref)" });
  }
  const trust = at(raw, "trust", "output", "class");
  if (trust !== "trusted" && trust !== "internal" && trust !== "untrusted") out.push({ rule: "missing_trust_class", connector_id: id, path: "trust.output.class", message: "manifestet har ingen gyldig tillitsklasse (trusted/internal/untrusted)" });
  const actions = at(raw, "actions");
  if (Array.isArray(actions)) {
    actions.forEach((a, i) => {
      const risk = at(a, "authority", "risk_class");
      if (risk !== "A" && risk !== "B" && risk !== "C" && risk !== "D") out.push({ rule: "action_without_risk_class", connector_id: id, path: `actions[${i}].authority.risk_class`, message: "handlingen har ingen risikoklasse A-D" });
    });
  } else out.push({ rule: "action_without_risk_class", connector_id: id, path: "actions", message: "manifestet har ingen handlingsliste" });
}

function issueViolations(id: string | null, issues: readonly ManifestIssue[], out: GuardViolation[]): void {
  for (const i of issues) {
    const secret = i.code === "secret_shape_detected" || (i.code === "invalid_format" && /^secrets\.refs\[\d+\]\.ref$/.test(i.path));
    if (secret) out.push({ rule: "secret_value_in_manifest", connector_id: id, path: i.path, message: "manifestet inneholder noe som ikke er en hvelvreferanse (en verdi?) - kun referanser er lov" });
    else if (WRITE_IDEMPOTENCY_CODES.has(i.code)) out.push({ rule: "write_capable_without_idempotency", connector_id: id, path: i.path, message: i.message });
    else out.push({ rule: "manifest_invalid", connector_id: id, path: i.path, message: `${i.code}: ${i.message}` });
  }
}

/** Runbook- og testbevis-stier i et FULLT manifest må finnes (vakten leser aldri filene, bare eksistens). */
function evidenceViolations(m: ConnectorManifest, fileExists: (p: string) => boolean, out: GuardViolation[]): void {
  const id = m.identity.id;
  const rb = m.operations.runbook;
  if (isUnknown(rb)) out.push({ rule: "runbook_not_declared", connector_id: id, path: "operations.runbook", message: "et fullt manifest må oppgi en runbook" });
  else if (!fileExists(rb.path)) out.push({ rule: "runbook_file_missing", connector_id: id, path: "operations.runbook.path", message: `runbooken finnes ikke: ${rb.path}` });
  for (const [name, t] of Object.entries(m.tests)) {
    if (isUnknown(t)) continue;
    if (t.status === "present" && t.paths.length === 0) out.push({ rule: "test_evidence_without_path", connector_id: id, path: `tests.${name}`, message: "«present» krever minst én teststi" });
    t.paths.forEach((p, i) => { if (!fileExists(p)) out.push({ rule: "test_file_missing", connector_id: id, path: `tests.${name}.paths[${i}]`, message: `testfilen finnes ikke: ${p}` }); });
  }
}

/** Revisjonen over en ferdig bygd katalog. Ren; brukes av `runManifestGuard` og direkte av mutasjonstestene. */
export function auditManifestCatalogue(args: { catalogue: Catalogue; registry: readonly ConnectorDefinition[]; authored: readonly unknown[]; fileExists: (p: string) => boolean }): GuardViolation[] {
  const out: GuardViolation[] = [];
  const have = new Set(args.catalogue.entries.map((e) => e.connector_id));
  for (const c of args.registry) if (!have.has(c.id)) out.push({ rule: "registry_connector_without_manifest", connector_id: c.id, path: "", message: "registeroppføringen har ikke noe manifest (heller ikke et avledet skeleton)" });

  // Håndskrevne manifester: rå sjekk først (eier/tillit/risiko), så skjema + semantikk.
  for (const raw of args.authored) {
    const id = idOf(raw);
    requiredFieldViolations(raw, out);
    const v = validateConnectorManifest(raw);
    issueViolations(id, v.issues, out);
    if (v.manifest !== null) {
      if (v.manifest.completeness !== "full") out.push({ rule: "authored_manifest_not_full", connector_id: id, path: "completeness", message: "et håndskrevet manifest må være «full» (et håndskrevet skeleton ville skjult drift mot det avledede)" });
      else evidenceViolations(v.manifest, args.fileExists, out);
    }
  }
  // Alle manifestene i katalogen (inkl. avledede skeletons): gyldige, med eier/tillit/risiko, og uten drift.
  for (const e of args.catalogue.entries) {
    if (e.level === "skeleton") {
      requiredFieldViolations(e.manifest, out);
      issueViolations(e.connector_id, validateConnectorManifest(e.manifest).issues, out);
    }
    for (const d of e.drift) out.push({ rule: "manifest_drift", connector_id: e.connector_id, path: d.path, message: `${d.code}: ${d.message}` });
  }
  for (const id of args.catalogue.orphans) out.push({ rule: "orphan_manifest", connector_id: id, path: "identity.id", message: "manifestet peker på en connector som ikke finnes i registeret" });
  for (const id of args.catalogue.duplicates) out.push({ rule: "duplicate_manifest", connector_id: id, path: "identity.id", message: "mer enn ett håndskrevet manifest for samme connector" });
  return out;
}

/** Kjør hele vakten: bygger katalogen fra registeret + definisjonene + de håndskrevne manifestene, og reviderer den. */
export function runManifestGuard(input: GuardInput): GuardReport {
  const registry = input.registry ?? CONNECTOR_REGISTRY;
  const validAuthored = input.authored.map((raw) => validateConnectorManifest(raw).manifest).filter((m): m is ConnectorManifest => m !== null);
  const catalogue = buildManifestCatalogue({ ...input, registry, authored: validAuthored });
  const violations = auditManifestCatalogue({ catalogue, registry, authored: input.authored, fileExists: input.fileExists });
  const skeletons = deriveSkeletonManifests({ ...input, registry });
  const unknown_fields_by_connector: Record<string, number> = {};
  for (const s of skeletons) unknown_fields_by_connector[s.identity.id] = validateConnectorManifest(s).unknown_paths.length;
  return {
    ok: violations.length === 0,
    violations,
    coverage: {
      registry_total: registry.length,
      built: registry.filter((c) => c.category !== "backlog" && c.category !== "backlog_d64_gate" && c.category !== "model_provider").length,
      backlog: registry.filter((c) => c.category === "backlog" || c.category === "backlog_d64_gate").length,
      model_provider: registry.filter((c) => c.category === "model_provider").length,
      full: catalogue.entries.filter((e) => e.level === "full").map((e) => e.connector_id),
      skeleton: catalogue.entries.filter((e) => e.level === "skeleton").length,
      unknown_fields_by_connector
    }
  };
}

/** Manifestfiler (basenavn uten `.ts`, uten `index`) som ikke svarer til noe registrert håndskrevet manifest: en glemt registrering i `FULL_MANIFESTS`. */
export function unregisteredManifestFiles(fileNames: readonly string[], authoredIds: readonly string[]): string[] {
  const ids = new Set(authoredIds);
  return fileNames.filter((f) => f.endsWith(".ts") && f !== "index.ts").map((f) => f.slice(0, -3)).filter((base) => !ids.has(base));
}

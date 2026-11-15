import { CONNECTOR_REGISTRY, type ConnectorDefinition } from "@jarvis/tool-gateway";
import { buildManifestCatalogue, type Catalogue, type CatalogueInput } from "./catalogue.ts";
import { SKELETON_BASELINE } from "./manifests/index.ts";
import { DECISION_ID_PATTERN, isUnknown, safeIdentifier, type ConnectorManifest } from "./manifest.ts";
import { validateConnectorManifest, type ManifestIssue } from "./validate.ts";

/**
 * WP-I (D-472): CI-VAKT for connector-manifester. Ren funksjon (filsystemet og beslutningsloggen injiseres), brukt av `guard.test.ts` som en CI-port.
 *
 * ÆRLIG OM HVA DEN GARANTERER (review M5): et skeleton avledes AUTOMATISK for hver registeroppføring (`derive.ts`), så en registeroppføring uten manifest kan ikke oppstå - vakten kan derfor ikke kreve at et manifest
 * «følger med» i den forstand. Det den kan kreve er at en NY BYGD connector ikke slipper stille inn med bare et skeleton: den må ha et FULLT manifest eller en bevisst oppføring i `SKELETON_BASELINE`
 * (`built_connector_unreviewed`). Baselinen er ment å krympe, men det er en KONVENSJON, ikke noe vakten håndhever: `skeleton_baseline_stale` sjekker at hver oppføring fortsatt er en bygd registeroppføring uten fullt
 * manifest (en id som ikke finnes, en backlog-oppføring eller en connector som nå har fullt manifest), men IKKE at listen aldri VOKSER. Å legge en id til er den dokumenterte, synlige utveien (én linje i PR-diffen,
 * med begrunnelse i PR-en), og en ny connector kan også registreres som `backlog` for å slippe unna. En frosset legacy-liste (en committet kopi av de nåværende id-ene som bare kan fjernes fra) er DEFERRED (runbook §11).
 *
 * Reglene (kap. 10 + CLAUDE.md regel 11/12 + Appendiks B):
 *  - hver bygd registeroppføring har et fullt manifest eller står i den committede skeleton-baselinen; alle manifester (også avledede skeletons) er gyldige med eier, tillitsklasse og risikoklasse per handling;
 *  - et håndskrevet manifest er `full`, og hvert fullt manifest har en runbook som er deklarert og FINNES, teststier som finnes, og beslutningene (`decision_refs`) som loggførte D-64-porten finnes i beslutningsloggen;
 *  - ingen manifest refererer en hemmelighets VERDI (kun hvelvreferanser);
 *  - en skrivekapabel connector uten idempotensinfo feiler;
 *  - et håndskrevet manifest har ingen drift mot registeret (handlingsmengde og alle avledbare fakta), er ikke foreldreløst og ikke dobbelt.
 * Grense: «finnes» betyr at filen/beslutningen eksisterer - vakten leser ikke innholdet i runbook eller tester (en tom fil teller; se runbook §11, DEFERRED).
 * Vakten svekker aldri en regel stille: en regel som ikke kan evalueres (ugyldig inndata) er et brudd, ikke en hopp-over.
 */

export const GUARD_RULES = [
  "registry_connector_without_manifest", "manifest_invalid", "missing_owner", "missing_trust_class", "action_without_risk_class", "authored_manifest_not_full",
  "runbook_not_declared", "runbook_file_missing", "test_evidence_without_path", "test_file_missing", "secret_value_in_manifest", "write_capable_without_idempotency",
  "manifest_drift", "orphan_manifest", "duplicate_manifest",
  // Review M5/M3: den meningsfulle registerregelen (skeleton-baselinen) og beslutningsreferansen.
  "built_connector_unreviewed", "skeleton_baseline_stale", "decision_ref_missing"
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
  /** Finnes beslutningen (`D-109`) i beslutningsloggen? (Injisert, som `fileExists`; påkrevd fordi en regel som ikke kan evalueres ikke skal hoppes over.) */
  decisionExists: (decisionId: string) => boolean;
  /** Den committede skeleton-baselinen (standard: `SKELETON_BASELINE`). Kun testene overstyrer den. */
  skeleton_baseline?: readonly string[];
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
    /** Ukjent-markører per SKELETON (kun connectorer uten fullt manifest): arbeidslisten for å oppgradere en connector til `full`. */
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
    // Review N5: funn-typen (fast ordforråd fra den sentrale skanneren, aldri teksten som traff) står i bruddet, så en falsk positiv på vanlig prosa kan rettes uten å gjette hvilket mønster som slo til.
    if (secret) out.push({ rule: "secret_value_in_manifest", connector_id: id, path: i.path, message: `manifestet inneholder noe som ikke er en hvelvreferanse (en verdi?) - kun referanser er lov${i.finding_kinds !== undefined && i.finding_kinds.length > 0 ? ` (skannerfunn: ${i.finding_kinds.join(", ")})` : ""}` });
    else if (WRITE_IDEMPOTENCY_CODES.has(i.code)) out.push({ rule: "write_capable_without_idempotency", connector_id: id, path: i.path, message: i.message });
    // Review M5: et FULLT manifest med ukjent runbook gir validatorens `full_manifest_has_unknown` ved operations.runbook - vakten navngir det som sitt eget brudd (ellers var regelen uoppnåelig: evidensfasen kjører bare på gyldige manifester).
    else if (i.code === "full_manifest_has_unknown" && i.path === "operations.runbook") out.push({ rule: "runbook_not_declared", connector_id: id, path: i.path, message: "et fullt manifest må oppgi en runbook" });
    else out.push({ rule: "manifest_invalid", connector_id: id, path: i.path, message: `${i.code}: ${i.message}` });
  }
}

/** Runbook- og testbevis-stier i et FULLT manifest må finnes, og beslutningene som loggførte D-64-porten likeså (vakten leser aldri innholdet, bare eksistens). */
function evidenceViolations(m: ConnectorManifest, fileExists: (p: string) => boolean, decisionExists: (id: string) => boolean, out: GuardViolation[]): void {
  const id = m.identity.id;
  for (const ref of m.core_boundary.decision_refs ?? []) {
    if (!decisionExists(ref)) out.push({ rule: "decision_ref_missing", connector_id: id, path: "core_boundary.decision_refs", message: `beslutningen ${ref} finnes ikke i beslutningsloggen (DECISIONS_AND_ASSUMPTIONS.md)` });
  }
  const rb = m.operations.runbook;
  if (isUnknown(rb)) out.push({ rule: "runbook_not_declared", connector_id: id, path: "operations.runbook", message: "et fullt manifest må oppgi en runbook" });
  else if (!fileExists(rb.path)) out.push({ rule: "runbook_file_missing", connector_id: id, path: "operations.runbook.path", message: `runbooken finnes ikke: ${rb.path}` });
  for (const [name, t] of Object.entries(m.tests)) {
    if (isUnknown(t)) continue;
    if (t.status === "present" && t.paths.length === 0) out.push({ rule: "test_evidence_without_path", connector_id: id, path: `tests.${name}`, message: "«present» krever minst én teststi" });
    t.paths.forEach((p, i) => { if (!fileExists(p)) out.push({ rule: "test_file_missing", connector_id: id, path: `tests.${name}.paths[${i}]`, message: `testfilen finnes ikke: ${p}` }); });
  }
}

/**
 * Bygd = registerkategori som ikke er backlog. Merk: dette er IKKE det samme som `coverage.built` (rapporten), som i tillegg utelater `model_provider`: modellleverandørene (anthropic, openai, gemini) regnes som bygde her og
 * står i baselinen. At de to tallene i dag begge er 48 er tilfeldig (51 bygde inkl. modellleverandører minus 3 fulle manifester = baselinen; 58 minus 7 backlog minus 3 modellleverandører = `coverage.built`).
 */
const isBuilt = (c: ConnectorDefinition): boolean => c.category !== "backlog" && c.category !== "backlog_d64_gate";

/** Revisjonen over en ferdig bygd katalog. Ren; brukes av `runManifestGuard` og direkte av mutasjonstestene. */
export function auditManifestCatalogue(args: {
  catalogue: Catalogue; registry: readonly ConnectorDefinition[]; authored: readonly unknown[]; fileExists: (p: string) => boolean; decisionExists: (id: string) => boolean; skeleton_baseline?: readonly string[];
}): GuardViolation[] {
  const out: GuardViolation[] = [];
  const have = new Set(args.catalogue.entries.map((e) => e.connector_id));
  // Defensivt: katalogen skal ha en oppføring for hver registeroppføring (den bygges av `buildManifestCatalogue`, som alltid avleder et skeleton). Feiler katalogen, er det en feil i vakten selv.
  for (const c of args.registry) if (!have.has(c.id)) out.push({ rule: "registry_connector_without_manifest", connector_id: c.id, path: "", message: "registeroppføringen har ikke noe manifest (heller ikke et avledet skeleton)" });

  // Skeleton-baselinen (review M5): en NY bygd connector må ha et fullt manifest eller en bevisst baseline-oppføring; baselinen kan bare krympe.
  const baseline = new Set(args.skeleton_baseline ?? SKELETON_BASELINE);
  const levelOf = new Map(args.catalogue.entries.map((e) => [e.connector_id, e.level] as const));
  const registryById = new Map(args.registry.map((c) => [c.id, c] as const));
  // En connector med et håndskrevet manifest (også et ugyldig, som da meldes under `manifest_invalid` osv.) er ikke «uten manifest»: da har den et gjennomgått utkast som bare må rettes.
  const authoredIds = new Set(args.authored.map((raw) => at(raw, "identity", "id")).filter((id): id is string => typeof id === "string"));
  for (const c of args.registry) {
    if (isBuilt(c) && levelOf.get(c.id) !== "full" && !authoredIds.has(c.id) && !baseline.has(c.id)) out.push({ rule: "built_connector_unreviewed", connector_id: c.id, path: "", message: "bygd connector uten fullt manifest og uten oppføring i SKELETON_BASELINE: lag et fullt manifest (anbefalt; legg det i FULL_MANIFESTS), eller legg id-en bevisst til i SKELETON_BASELINE (src/manifests/index.ts) med begrunnelse i PR-en" });
  }
  for (const id of [...baseline].sort()) {
    const c = registryById.get(id);
    if (c === undefined) out.push({ rule: "skeleton_baseline_stale", connector_id: safeIdentifier(id), path: "", message: "SKELETON_BASELINE har en id som ikke finnes i registeret: fjern den" });
    else if (!isBuilt(c)) out.push({ rule: "skeleton_baseline_stale", connector_id: id, path: "", message: "SKELETON_BASELINE har en backlog-oppføring (ikke bygget trenger ingen baseline-oppføring): fjern den" });
    else if (levelOf.get(id) === "full") out.push({ rule: "skeleton_baseline_stale", connector_id: id, path: "", message: "connectoren har nå et fullt manifest: fjern den fra SKELETON_BASELINE (baselinen skal bare krympe - konvensjon, jf. kommentaren øverst)" });
  }

  // Håndskrevne manifester: rå sjekk først (eier/tillit/risiko), så skjema + semantikk.
  for (const raw of args.authored) {
    const id = idOf(raw);
    requiredFieldViolations(raw, out);
    const v = validateConnectorManifest(raw);
    issueViolations(id, v.issues, out);
    if (v.manifest !== null) {
      if (v.manifest.completeness !== "full") out.push({ rule: "authored_manifest_not_full", connector_id: id, path: "completeness", message: "et håndskrevet manifest må være «full» (et håndskrevet skeleton ville skjult drift mot det avledede)" });
      else evidenceViolations(v.manifest, args.fileExists, args.decisionExists, out);
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
  const violations = auditManifestCatalogue({ catalogue, registry, authored: input.authored, fileExists: input.fileExists, decisionExists: input.decisionExists, ...(input.skeleton_baseline !== undefined ? { skeleton_baseline: input.skeleton_baseline } : {}) });
  // Arbeidslisten gjelder KUN connectorer som fortsatt er skeletons: en connector med fullt manifest har ingen ukjent-markører å lukke (review: den ble før telt fra det avledede skeletonet også).
  const unknown_fields_by_connector: Record<string, number> = {};
  for (const e of catalogue.entries) if (e.level === "skeleton") unknown_fields_by_connector[e.connector_id] = validateConnectorManifest(e.manifest).unknown_paths.length;
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

/**
 * Finnes beslutningen `id` (`D-109`) som en RAD i beslutningsloggen (`| D-109 | ...` først på en linje)? ÉN implementasjon: brukt av både CI-porten (`guard.test.ts`) og rapporten (`scripts/report.ts`), som begge injiserer
 * `decisionExists` i vakten (den rører aldri filsystemet selv). Id-en valideres mot `DECISION_ID_PATTERN` FØR den settes inn i et regulært uttrykk: en ugyldig id (også en med mønsterstegn) finnes aldri.
 */
export function decisionLogHasRow(log: string, id: string): boolean {
  return DECISION_ID_PATTERN.test(id) && new RegExp(`^\\| ${id} \\|`, "m").test(log);
}

/** Manifestfiler (basenavn uten `.ts`, uten `index`) som ikke svarer til noe registrert håndskrevet manifest: en glemt registrering i `FULL_MANIFESTS`. */
export function unregisteredManifestFiles(fileNames: readonly string[], authoredIds: readonly string[]): string[] {
  const ids = new Set(authoredIds);
  return fileNames.filter((f) => f.endsWith(".ts") && f !== "index.ts").map((f) => f.slice(0, -3)).filter((base) => !ids.has(base));
}

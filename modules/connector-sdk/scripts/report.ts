// WP-I (D-472): ARBEIDSLISTE-RAPPORT for Connector SDK (runbook §10, steg 2 og 3). Ren lesing: ingen nettverk, ingen skriving, ingen secrets. Kjøres av en person (eier/arkitekt) eller CI - aldri av Jarvis selv.
//
//   node --experimental-transform-types modules/connector-sdk/scripts/report.ts guard [--json]
//        CI-vakten over hele registeret: ok/brudd, dekning (fulle manifester / skeletons / baseline) og arbeidslisten (ukjent-markører per connector).
//   node --experimental-transform-types modules/connector-sdk/scripts/report.ts contract <connector_id> [--json]
//        kontraktstest-kittet mot connectorens FAKE (adapter_kind fake_from_manifest) og akseptanse-gapene (Appendiks B). Manifest: FULL_MANIFESTS eller src/manifests/<id>.ts (export <ID>_MANIFEST);
//        fake: test/references/<id>.fake.ts eller test/connectors/<id>.fake.ts (export create<Id>Fake).
//
// Avslutter 0 = ok, 1 = vakten/kittet har brudd, 2 = ugyldig bruk. Gap og «ikke bevist» er arbeidslisten, ikke feil: de gir kode 0. Alt kittet skriver er redigert (ingen hemmelighetsformer).
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FULL_MANIFESTS, SKELETON_BASELINE, decisionLogHasRow, productionConnectorDefinitions, runManifestGuard, safeIdentifier, validateConnectorManifest, type ConnectorManifest } from "../src/index.ts";
import { errorLabel, runConnectorContract, type ContractAdapter } from "../src/testing.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const ROOT = resolve(PKG, "..", "..");
const ID = /^[a-z][a-z0-9_]{1,40}$/;

const pascal = (id: string): string => id.split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
/**
 * Bevisstrengheten (en eneste implementasjon, brukt av både denne rapporten og CI-porten i `guard.test.ts`): en repo-relativ sti teller som runbook-/testbevis kun hvis den er en VANLIG FIL (ikke en symlenke, ikke en katalog)
 * med innhold som ikke bare er blanke/usynlige tegn. Vakten selv leser aldri innholdet utover dette; uten det var en tom plassholderfil, en fil med ett linjeskift (`touch`/`echo > fil`), en katalog eller en symlenke (som kan peke
 * hvor som helst, også ut av repoet) nok. `lstat`, ikke `stat`: `stat` følger en symlenke og ga `isFile()` for målet. Stiene er allerede låst av skjemaet (`REPO_PATH`: ingen `..`, ingen absolutt sti), så `root` kan ikke forlates.
 * Innholdskrav utover «noe synlig står der» (en `.md`/`.test.ts`-form, at runbooken nevner connector-id, at teststien inneholder en test) er `DEFERRED` (runbook §11).
 */
export const evidenceFileExists = (root: string) => (repoRelativePath: string): boolean => {
  try {
    const abs = join(root, repoRelativePath);
    const st = lstatSync(abs);
    if (!st.isFile() || st.size === 0) return false;
    // En fil på over 1 MiB er ingen plassholder; mindre filer må ha minst ett tegn som verken er blankt eller et kontroll-/formattegn (nullbredde, BOM ...).
    return st.size > 1_048_576 || /[^\s\p{C}]/u.test(readFileSync(abs, "utf8"));
  } catch {
    return false;
  }
};
const decisionLog = (): string => readFileSync(join(ROOT, "docs", "DECISIONS_AND_ASSUMPTIONS.md"), "utf8");

export interface Io {
  log: (line: string) => void;
  err: (line: string) => void;
}

function guardReport(json: boolean, io: Io): number {
  const log = decisionLog();
  const report = runManifestGuard({
    definitions: productionConnectorDefinitions(), authored: FULL_MANIFESTS,
    fileExists: evidenceFileExists(ROOT), decisionExists: (id) => decisionLogHasRow(log, id)
  });
  const work = Object.entries(report.coverage.unknown_fields_by_connector).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (json) {
    io.log(JSON.stringify({ ok: report.ok, violations: report.violations, coverage: { ...report.coverage, skeleton_baseline: SKELETON_BASELINE.length } }, null, 2));
    return report.ok ? 0 : 1;
  }
  const c = report.coverage;
  io.log(`CI-vakt: ${report.ok ? "OK" : "BRUDD"} (${report.violations.length} brudd)`);
  io.log(`Dekning: ${c.registry_total} registeroppføringer (${c.built} bygd, ${c.backlog} backlog, ${c.model_provider} modellleverandør); fulle manifester: ${c.full.join(", ") || "ingen"}; skeletons: ${c.skeleton}; skeleton-baseline (bygde uten fullt manifest): ${SKELETON_BASELINE.length}`);
  for (const v of report.violations) io.log(`  BRUDD ${v.rule} ${v.connector_id ?? "-"} ${v.path}: ${v.message}`);
  io.log("Arbeidsliste (ukjent-markører per skeleton, flest først - neste kandidater til fullt manifest er de bygde med skriving):");
  for (const [id, n] of work.slice(0, 15)) io.log(`  ${String(n).padStart(3)}  ${id}${SKELETON_BASELINE.includes(id) ? "  (i baselinen)" : ""}`);
  if (work.length > 15) io.log(`  ... og ${work.length - 15} til (bruk --json for hele listen)`);
  return report.ok ? 0 : 1;
}

async function loadManifest(id: string): Promise<ConnectorManifest | null> {
  const full = FULL_MANIFESTS.find((m) => m.identity.id === id);
  if (full !== undefined) return full;
  const file = join(PKG, "src", "manifests", `${id}.ts`);
  if (!existsSync(file)) return null;
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const candidate = mod[`${id.toUpperCase()}_MANIFEST`];
  return candidate !== undefined && validateConnectorManifest(candidate).manifest !== null ? (candidate as ConnectorManifest) : null;
}

async function loadFake(id: string): Promise<ContractAdapter | null> {
  for (const dir of ["references", "connectors"]) {
    const file = join(PKG, "test", dir, `${id}.fake.ts`);
    if (!existsSync(file)) continue;
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const factory = mod[`create${pascal(id)}Fake`];
    if (typeof factory === "function") return (factory as () => ContractAdapter)();
  }
  return null;
}

async function contractReport(id: string, json: boolean, io: Io): Promise<number> {
  if (!ID.test(id)) { io.err("FEIL: connector-id må være snake_case (a-z, 0-9, _)"); return 2; }
  // Review N4: et argument som har id-formen kan likevel være et helt token (`ghp_...` er snake_case) - det vises aldri uredigert (`safeIdentifier`: `<redacted>` for det som ligner en hemmelighet).
  const shown = safeIdentifier(id);
  const manifest = await loadManifest(id);
  if (manifest === null) { io.err(`FEIL: fant ikke et gyldig manifest for «${shown}» (FULL_MANIFESTS eller src/manifests/${shown}.ts med export ${shown.toUpperCase()}_MANIFEST)`); return 2; }
  const adapter = await loadFake(id);
  if (adapter === null) { io.err(`FEIL: fant ikke en fake-adapter for «${shown}» (test/references/${shown}.fake.ts eller test/connectors/${shown}.fake.ts med export create${pascal(shown)}Fake)`); return 2; }
  const r = await runConnectorContract(manifest, adapter);
  if (json) { io.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  io.log(`Kontraktstest-kit for ${r.connector_id}: ${r.ok ? "OK" : "BRUDD"} - ${r.passed} bestått, ${r.failed} feilet, ${r.skipped} hoppet over (adapter_kind: ${r.adapter_kind})`);
  if (r.adapter_kind === "fake_from_manifest") io.log("MERK: beviset er MODELLERT mot en fake bygget fra manifestet - ikke mot en ekte transport (bro DEFERRED) og ikke mot en ekte leverandør (live smoke BLOCKED_EXTERNAL). Ingenting er VERIFIED.");
  for (const c of r.checks.filter((x) => x.status !== "pass")) io.log(`  ${c.status.toUpperCase().padEnd(4)} ${c.id}${c.detail !== undefined ? ` - ${c.detail}` : ""}${c.subjects !== undefined ? `: ${c.subjects.join("; ")}` : ""}`);
  const a = r.acceptance;
  io.log(`Akseptanse (Appendiks B nivå ${a.required_level}): dom ${a.verdict}; ${Object.entries(a.summary).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  for (const item of a.items.filter((i) => i.status === "gap" || i.status === "not_proven")) io.log(`  ${item.status.toUpperCase().padEnd(10)} ${item.id}: ${item.evidence}`);
  return r.ok ? 0 : 1;
}

const USAGE = "Bruk: node --experimental-transform-types modules/connector-sdk/scripts/report.ts guard [--json]\n       node --experimental-transform-types modules/connector-sdk/scripts/report.ts contract <connector_id> [--json]";

export async function main(argv: readonly string[], io: Io = { log: (s) => console.log(s), err: (s) => console.error(s) }): Promise<number> {
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  try {
    if (args[0] === "guard" && args.length === 1) return guardReport(json, io);
    if (args[0] === "contract" && args.length === 2) return await contractReport(args[1]!, json, io);
  } catch (e) {
    // Review N4: aldri råtekst fra unntaket (en fake-fabrikk, en manifestfil eller en sti kan sitere en verdi) - kun navn/kode, gjennom den sentrale redigeringen.
    io.err(`UVENTET FEIL: ${errorLabel(e)}`);
    return 1;
  }
  io.err(USAGE);
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await main(process.argv.slice(2)));
}

// Kjøres direkte med Nodes type-stripping: `node --experimental-transform-types ops/evolution/dependency-check.ts --base origin/main`
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateDependencyChange, type DependencyVerdict } from "../../modules/self-modification/src/evolution/supply-chain.ts";

/**
 * WP-B (D-452), EV-7: avhengighetsporten som skript. ENHVER avhengighetsendring er klasse E2 (eier-godkjenning); mistenkelige endringer flagges. Skriptet sammenligner alle `package.json`-filer mellom to
 * git-referanser (standard: `origin/main` mot arbeidstreet) og skriver én rapport. Felt som leses: `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `bundledDependencies`,
 * `overrides`, `resolutions` og `pnpm.{overrides,patchedDependencies,packageExtensions,onlyBuiltDependencies,neverBuiltDependencies,ignoredBuiltDependencies}` samt install-skript.
 *
 * KJØRES AV EN PERSON; IKKE KOBLET TIL CI. (Å koble det til CI krever endring av `.github/workflows`, en beskyttet sti som krever eierens aksept - det er ikke gjort, og ingen test eller dokumentasjon
 * skal påstå det.) Aldri av Jarvis selv.
 *
 * EXIT-KONTRAKT:
 *   0 = ingen funn: ingen avhengighetsendring, eller kun ordinære registerendringer (klasse E2 - rapporten sier det, eieren godkjenner i PR-en).
 *   1 = funn som krever eierens eksplisitte oppmerksomhet: typosquat/lookalike (AVVIST), ikke-registerkilde (git/URL/file/link/`bruker/repo`), endret install-skript, endret override/resolution/patch
 *       eller alias til en annen pakke.
 *   2 = bruksfeil eller skriptet kan ikke kjøre (ukjent flagg, ugyldig referanse, ikke et git-repo, ugyldig package.json). ALDRI 0 ved slik svikt.
 *
 * Ærlig om hva som IKKE dekkes (DEFERRED/PARTIAL): lockfil (`pnpm-lock.yaml`), `pnpm-workspace.yaml` (kataloger/overrides) og `.npmrc` (register-oppsett) leses ikke - en endring KUN der oppdages ikke
 * (rapporten sier det). SBOM, CodeQL, attestering og malware-/registerdata for nye pakker er DEFERRED (CI/plattform).
 */
export interface FileChange {
  path: string;
  verdict: DependencyVerdict;
}

export interface DependencyCheckResult {
  changed: FileChange[];
  /** true når ingen endring er avvist (typosquat/lookalike). */
  ok: boolean;
  /** Høyeste klasse: E2 så snart noen avhengighet er endret, ellers E0. */
  change_class: "E0" | "E2";
  rejected: string[];
  /** Filer med funn eieren må se på (ikke-registerkilde, install-skript, override/resolution/patch, alias) - inkluderer ikke de avviste. */
  owner_review: string[];
  /** Kommandolinjens exit-kode for dette resultatet: 1 ved avvisning eller funn, ellers 0. */
  exit_code: 0 | 1;
}

const EMPTY = { name: "(ny)", dependencies: {}, devDependencies: {} };

/** Ren sammenligning av to kart `sti → package.json-innhold` (manglende fil = tom pakke). Kaster med filens sti hvis en package.json har ugyldig form. */
export function checkDependencyChanges(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): DependencyCheckResult {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed: FileChange[] = [];
  const rejected: string[] = [];
  const owner_review: string[] = [];
  for (const path of paths) {
    let verdict: DependencyVerdict;
    try {
      verdict = evaluateDependencyChange(before[path] ?? EMPTY, after[path] ?? EMPTY);
    } catch (err) {
      throw new Error(`${JSON.stringify(path)}: ugyldig package.json (${(err as Error).name})`);
    }
    if (!verdict.changed) continue;
    changed.push({ path, verdict });
    if (!verdict.proceed_to_owner) rejected.push(path);
    else if (verdict.needs_owner_review) owner_review.push(path);
  }
  return { changed, ok: rejected.length === 0, change_class: changed.length > 0 ? "E2" : "E0", rejected, owner_review, exit_code: rejected.length > 0 || owner_review.length > 0 ? 1 : 0 };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Alle `package.json` ved en git-referanse (eller i arbeidstreet). NUL-separert (`-z`) og uten git sin C-sitering av stinavn (`core.quotePath=false`): uten dette ble en sti med ikke-ASCII-tegn
 * (`modules/ü/package.json`) levert som `"modules/\303\274/package.json"` - sitert, aldri funnet av filteret - og en typosquat der ga «Ingen avhengighetsendringer» (M3 a). Mellomrom, anførselstegn
 * og linjeskift i stinavn er også trygge, siden ingenting splittes på linjeskift.
 */
export function packageFilesAt(ref: string | "WORKTREE", cwd: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const list = ref === "WORKTREE"
    ? git(["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*package.json"], cwd)
    : git(["-c", "core.quotePath=false", "ls-tree", "-r", "-z", "--name-only", ref], cwd);
  for (const path of list.split("\0").filter((p) => p !== "" && /(^|\/)package\.json$/.test(p) && !p.includes("node_modules/"))) {
    try {
      out[path] = JSON.parse(ref === "WORKTREE" ? readFileSync(`${cwd}/${path}`, "utf8") : git(["-c", "core.quotePath=false", "show", `${ref}:${path}`], cwd));
    } catch {
      // Slettet i arbeidstreet eller ugyldig JSON: behandles som fraværende (ugyldig JSON fanges av CI-bygget).
    }
  }
  return out;
}

export function renderDependencyCheckNo(r: DependencyCheckResult): string {
  if (r.changed.length === 0) return "Ingen avhengighetsendringer.";
  const lines = [`Avhengighetsendringer i ${r.changed.length} fil(er) - klasse ${r.change_class} (eier-godkjenning kreves for hver):`];
  for (const c of r.changed) {
    const v = c.verdict;
    lines.push(`- ${c.path}: +${v.added.length} -${v.removed.length} endret ${v.version_changed.length}${v.flags.length > 0 ? ` | flagg: ${v.flags.join(", ")}` : ""}${v.proceed_to_owner ? "" : " | AVVIST"}`);
  }
  if (r.rejected.length > 0) lines.push(`AVVIST (typosquat-mistanke): ${r.rejected.join(", ")}`);
  if (r.owner_review.length > 0) lines.push(`KREVER EIERENS OPPMERKSOMHET (ikke-registerkilde, install-skript, override/resolution/patch eller alias): ${r.owner_review.join(", ")}`);
  lines.push("Ikke analysert av dette skriptet: pnpm-lock.yaml, pnpm-workspace.yaml og .npmrc - se dem i diffen.");
  return lines.join("\n");
}

const USAGE = [
  "Bruk: node --experimental-transform-types ops/evolution/dependency-check.ts [--base <ref>] [--head <ref>|WORKTREE] [--cwd <mappe>] [--json]",
  "Exit: 0 = ingen funn, 1 = funn (typosquat/lookalike, ikke-registerkilde, endret install-skript, override/resolution eller alias), 2 = bruksfeil/kan ikke kjøre.",
  "Kjøres av en person; ikke koblet til CI."
].join("\n");

class UsageError extends Error {}

/** En git-referanse kan ikke starte med `-` (flagginjeksjon) eller inneholde mellomrom/kontrolltegn. */
const SAFE_REF = /^[A-Za-z0-9_@~^{}./+-]+$/;

function parseArgs(argv: string[]): { cwd: string; base: string; head: string; json: boolean; help: boolean } {
  const opts = { cwd: process.cwd(), base: "origin/main", head: "WORKTREE", json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag === "--json") opts.json = true;
    else if (flag === "--help" || flag === "-h") opts.help = true;
    else if (flag === "--cwd" || flag === "--base" || flag === "--head") {
      const value = argv[++i];
      if (value === undefined || value === "") throw new UsageError(`${flag} mangler verdi`);
      if (flag === "--cwd") opts.cwd = value;
      else if (flag === "--base") opts.base = value;
      else opts.head = value;
    } else throw new UsageError(`ukjent argument: ${JSON.stringify(flag)}`);
  }
  for (const [name, ref] of [["--base", opts.base], ["--head", opts.head]] as const) {
    if (name === "--head" && ref === "WORKTREE") continue;
    if (!SAFE_REF.test(ref) || ref.startsWith("-") || ref === "WORKTREE") throw new UsageError(`ugyldig git-referanse for ${name}: ${JSON.stringify(ref)}`);
  }
  return opts;
}

/** Kjører skriptet og returnerer exit-koden. Aldri 0 ved svikt: alt som ikke er et resultat (feil argument, ikke et git-repo, ugyldig package.json) er 2. */
export function run(argv: string[]): number {
  try {
    const opts = parseArgs(argv);
    if (opts.help) { console.log(USAGE); return 0; }
    const result = checkDependencyChanges(packageFilesAt(opts.base, opts.cwd), packageFilesAt(opts.head === "WORKTREE" ? "WORKTREE" : opts.head, opts.cwd));
    console.log(renderDependencyCheckNo(result));
    if (opts.json) console.log(JSON.stringify(result));
    return result.exit_code;
  } catch (err) {
    const usage = err instanceof UsageError;
    const detail = err instanceof Error ? (err as Error & { stderr?: string }).stderr?.toString().split("\n")[0] || err.message.split("\n")[0] : String(err);
    console.error(`dependency-check: ${usage ? "bruksfeil" : "kunne ikke kjøre"}: ${detail}`);
    if (usage) console.error(USAGE);
    return 2;
  }
}

/**
 * Kjøres filen direkte? Sammenligner den RESOLVERTE stien til `process.argv[1]` med modulens egen sti. Den gamle vakten (`import.meta.url === pathToFileURL(argv[1]).href`) feilet stille ved kjøring via
 * symlink (argv[1] er symlinken, import.meta.url er målet): skriptet gjorde ingenting og ga exit 0 (M3 e).
 */
export function isDirectRun(entry: string | undefined = process.argv[1], self: string = fileURLToPath(import.meta.url)): boolean {
  if (!entry) return false;
  const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
  return real(entry) === real(self);
}

if (isDirectRun()) process.exit(run(process.argv.slice(2)));

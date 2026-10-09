// Kjøres direkte med Nodes type-stripping: `node --experimental-transform-types ops/evolution/dependency-check.ts --base origin/main`
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { evaluateDependencyChange, type DependencyVerdict } from "../../modules/self-modification/src/evolution/supply-chain.ts";

/**
 * WP-B (D-452), EV-7: avhengighetsporten som skript. ENHVER avhengighetsendring er klasse E2 (eier-godkjenning); mistenkelige endringer (typosquat-mistanke, pakker fra git/url, endrede install-skript) flagges, og
 * typosquat-mistanke avviser forslaget (exit 1). Skriptet sammenligner alle `package.json`-filer mellom to git-referanser (standard: `origin/main` mot arbeidstreet) og skriver én rapport.
 *
 * Ærlig: dette er ENKELT-FIL-porten fra `evaluateDependencyChange`. SBOM, CodeQL, attestering og malware-/registerdata for nye pakker er DEFERRED (CI/plattform). Skriptet kjøres på forespørsel;
 * det er IKKE koblet til CI (endring av `.github/workflows` er en beskyttet sti som krever eierens aksept).
 */
export interface FileChange {
  path: string;
  verdict: DependencyVerdict;
}

export interface DependencyCheckResult {
  changed: FileChange[];
  /** true når ingen endring er avvist. */
  ok: boolean;
  /** Høyeste klasse: E2 så snart noen avhengighet er endret, ellers E0. */
  change_class: "E0" | "E2";
  rejected: string[];
}

const EMPTY = { name: "(ny)", dependencies: {}, devDependencies: {} };

/** Ren sammenligning av to kart `sti → package.json-innhold` (manglende fil = tom pakke). */
export function checkDependencyChanges(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): DependencyCheckResult {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed: FileChange[] = [];
  const rejected: string[] = [];
  for (const path of paths) {
    const verdict = evaluateDependencyChange(before[path] ?? EMPTY, after[path] ?? EMPTY);
    if (!verdict.changed) continue;
    changed.push({ path, verdict });
    if (!verdict.proceed_to_owner) rejected.push(path);
  }
  return { changed, ok: rejected.length === 0, change_class: changed.length > 0 ? "E2" : "E0", rejected };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function packageFilesAt(ref: string | "WORKTREE", cwd: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const list = ref === "WORKTREE" ? git(["ls-files", "--cached", "--others", "--exclude-standard", "--", "*package.json"], cwd) : git(["ls-tree", "-r", "--name-only", ref], cwd);
  for (const path of list.split("\n").filter((p) => /(^|\/)package\.json$/.test(p) && !p.includes("node_modules/"))) {
    try {
      out[path] = JSON.parse(ref === "WORKTREE" ? readFileSync(`${cwd}/${path}`, "utf8") : git(["show", `${ref}:${path}`], cwd));
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
  return lines.join("\n");
}

function main(argv: string[]): number {
  const arg = (name: string, fallback: string): string => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : fallback;
  };
  const cwd = arg("--cwd", process.cwd());
  const base = arg("--base", "origin/main");
  const head = arg("--head", "WORKTREE");
  const result = checkDependencyChanges(packageFilesAt(base, cwd), packageFilesAt(head === "WORKTREE" ? "WORKTREE" : head, cwd));
  console.log(renderDependencyCheckNo(result));
  if (argv.includes("--json")) console.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));

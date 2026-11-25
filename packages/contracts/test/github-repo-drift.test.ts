import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CANONICAL_GITHUB_REPO, LEGACY_GITHUB_REPOS, githubRepoAliasKey } from "../src/index.ts";

/**
 * WP-A1 (D-478/D-479, JARVIS-117): kontobyttet gjorde `tsworkflow/jarvisbuild` til et frosset, skrivebeskyttet repo. Kildekoden skal ikke lenger hardkode det gamle repoet som standard eller som mål (det var slik
 * `daily-brief.ts` og seks standardverdier ble liggende igjen på det gamle repoet). Denne vakten skanner ALLE filer utenom docs/tester/avhengigheter/binærfiler (også `.ps1`, `.html`, `.tsx`, `.cjs`, `*.example`, Dockerfile, `.github`,
 * rotfiler) etter det gamle EIERNAVNET i repo-form: `tsworkflow/` (slug eller URL) og eiernavnet ALENE, også uten anførselstegn (objektformen `repoOwner`/`trustedAuthor`, YAML, sh og ps1). `post@tsworkflow.com` og `com.tsworkflow.*` er ikke repo-referanser og treffes ikke.
 * Nye steder skal bruke `CANONICAL_GITHUB_REPO` (eller `configuredGithubRepoFromEnv`/`configuredGithubRepo()`).
 */
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SKIP_DIRS = new Set(["node_modules", ".git", "docs", "test", "tests", "dist", "build", "coverage", ".turbo", ".claude"]);
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|gz|tgz|tar|bin|mp3|mp4|wasm|sqlite|db)$/i;
const MAX_BYTES = 2_000_000;

/**
 * Bevisst tillatte forekomster (sti fra repo-roten med `/`) med begrunnelse. Legg ALDRI til en sti her uten å forklare hvorfor det gamle eiernavnet må stå der.
 * `only`: filen får kun nevne disse gamle repoene (alias-nøkler) - en NY forekomst (et annet repo under den gamle kontoen, f.eks. `tsworkflow/annet`, eller eiernavnet alene) feiler selv i en tillatt fil.
 * Uten `only`: hele filen er tillatt (eksempel-konfig og dokumentasjon av kontobyttet).
 */
const ALLOWED: Readonly<Record<string, { reason: string; only?: readonly string[] }>> = {
  "packages/contracts/src/github-repo.ts": { reason: "definerer LEGACY_GITHUB_REPOS (tidligere produksjonsrepoer)", only: LEGACY_GITHUB_REPOS.map(githubRepoAliasKey) },
  "ops/job-runner/acceptance.sh": { reason: "nektelisten for produksjonsrepoer i akseptansen (PRODUCTION_REPOS; holdt i takt med kontrakten av ops/job-runner/test/acceptance-script.test.mjs)", only: LEGACY_GITHUB_REPOS.map(githubRepoAliasKey) },
  "CLAUDE.md": { reason: "dokumenterer kontobyttet og at det gamle repoet er frosset (D-478)" },
  "infra/job-runner/job-runner.example.json": { reason: "eksempel-konfig: sandbox-repo under den gamle kontoen; eieren setter inn et nytt sandbox-repo (Q-77 pkt 4, runbook GITHUB_ACCOUNT_MOVE.md)" },
  "ops/claude-worker/config.example.json": { reason: "arkitekt-løkken er ikke flyttet; `repoOwner`/`trustedAuthor` er en tillitsgrense som krever eierens beslutning (Q-77 pkt 1c)" },
  "ops/claude-worker/supervisor.config.example.json": { reason: "samme som config.example.json (Q-77 pkt 1c)" }
};

/** Ignorerte, lokale filer som aldri skal skannes (ikke sporet i git): eierens egen `.env` (kan stå på det gamle repoet inntil den er byttet) og evidensfiler fra akseptanse. Brukes bare av fallbacken uten git. */
function isLocalOnlyFile(rel: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  return (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) || rel.startsWith("ops/acceptance/out/");
}

function scannable(path: string): boolean {
  if (BINARY.test(path)) return false;
  try {
    return statSync(path).isFile() && statSync(path).size <= MAX_BYTES;
  } catch {
    return false; // sporet, men slettet i arbeidstreet
  }
}

function inSkippedDir(rel: string): boolean {
  return rel.split("/").slice(0, -1).some((segment) => SKIP_DIRS.has(segment));
}

/** Filene vakten skanner: sporede og ikke-ignorerte filer (`git ls-files`), så resultatet ikke avhenger av lokale, git-ignorerte filer (`.env`, `ops/acceptance/out`). Uten git (f.eks. et uttrukket arkiv): katalogvandring uten de lokale filene. */
function listScannableFiles(): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const rels = out.split("\0").filter((p) => p.length > 0 && !inSkippedDir(p));
    if (rels.length > 0) return rels.map((p) => join(ROOT, p)).filter(scannable);
  } catch {
    // ingen git: fall til katalogvandringen under
  }
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile() && !isLocalOnlyFile(relative(ROOT, path).split(sep).join("/"))) found.push(path);
    }
  };
  walk(ROOT);
  return found.filter(scannable);
}

/**
 * Treff for det gamle eiernavnet i repo-form: `tsworkflow/` (slug eller URL) og eiernavnet ALENE (`repoOwner: tsworkflow`, `--owner tsworkflow`, `"tsworkflow"`, `github.com/tsworkflow`), også uten anførselstegn (reviewer B delta: YAML, sh og ps1).
 * `post@tsworkflow.com` (e-postdomene) og `com.tsworkflow.*` (bundle-id) er ikke repo-referanser og treffes ikke. Eksportert som funksjon så selve mønsteret kan testes.
 */
export function legacyOwnerHits(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  if (lower.includes("tsworkflow/")) hits.push("tsworkflow/");
  if (/(?<![\w.@-])tsworkflow(?![\w.-]|\/)/.test(lower)) hits.push("tsworkflow (alene)");
  return hits;
}

/** Alle repo-slugger under den gamle kontoen (`tsworkflow/<navn>`) i teksten, som alias-nøkler (små bokstaver, uten `.git`, `/` og etterfølgende skilletegn). */
export function legacyOwnerSlugs(text: string): string[] {
  return [...text.matchAll(/tsworkflow\/[A-Za-z0-9._-]+/gi)].map((m) => githubRepoAliasKey(m[0].replace(/[._-]+$/, "")));
}

describe("WP-A1: ingen hardkodet gammel repo-eier i kjørbar kode og konfig", () => {
  const files = listScannableFiles();
  const rel = (f: string): string => relative(ROOT, f).split(sep).join("/");

  it("mønsteret treffer repo-former og ikke e-post eller bundle-id", () => {
    expect(legacyOwnerHits("repo: tsworkflow/jarvisbuild")).toEqual(["tsworkflow/"]);
    expect(legacyOwnerHits("https://github.com/TSWorkflow/x")).toEqual(["tsworkflow/"]);
    expect(legacyOwnerHits('{"repoOwner": "tsworkflow"}')).toEqual(["tsworkflow (alene)"]);
    expect(legacyOwnerHits("repoOwner: 'TSWorkflow'")).toEqual(["tsworkflow (alene)"]);
    // uten anførselstegn (YAML, sh, ps1) og som URL-sti
    expect(legacyOwnerHits("repoOwner: tsworkflow")).toEqual(["tsworkflow (alene)"]);
    expect(legacyOwnerHits("gh api --owner tsworkflow")).toEqual(["tsworkflow (alene)"]);
    expect(legacyOwnerHits("$owner = 'tsworkflow'")).toEqual(["tsworkflow (alene)"]);
    expect(legacyOwnerHits("https://github.com/tsworkflow")).toEqual(["tsworkflow (alene)"]);
    expect(legacyOwnerHits("owner=tsworkflow\n")).toEqual(["tsworkflow (alene)"]);
    expect(legacyOwnerHits("tsworkflow/jarvisbuild")).toEqual(["tsworkflow/"]);
    expect(legacyOwnerHits("post@tsworkflow.com")).toEqual([]);
    expect(legacyOwnerHits("com.tsworkflow.jarvis.ios")).toEqual([]);
    expect(legacyOwnerHits(`${CANONICAL_GITHUB_REPO} og FFrollerskis`)).toEqual([]);
    expect(legacyOwnerSlugs("repo: tsworkflow/jarvisbuild, og TSWorkflow/JarvisBuild.git. Se tsworkflow/annet-repo.")).toEqual(["tsworkflow/jarvisbuild", "tsworkflow/jarvisbuild", "tsworkflow/annet-repo"]);
    expect(legacyOwnerSlugs("post@tsworkflow.com")).toEqual([]);
  });

  it("vakten ser faktisk filer (ikke vakuum), også utenfor kildemappene, og kjenner de bevisste forekomstene", () => {
    expect(files.length).toBeGreaterThan(500);
    const relative = files.map(rel);
    for (const allowed of Object.keys(ALLOWED)) expect(relative, allowed).toContain(allowed);
    expect(relative.some((p) => p.startsWith(".github/")), ".github skannes").toBe(true);
    expect(relative.some((p) => !p.includes("/")), "rotfiler skannes").toBe(true);
    expect(relative.some((p) => p.endsWith(".ps1")), ".ps1 skannes").toBe(true);
    expect(relative.some((p) => p.startsWith("docs/")), "docs er historikk og skannes ikke").toBe(false);
    // Hermetisk: lokale, git-ignorerte filer påvirker ikke vakten (en `.env` på det gamle repoet, evidensfiler fra akseptanse).
    expect(relative, "eierens egen .env skannes ikke").not.toContain(".env");
    expect(relative.some((p) => p.startsWith("ops/acceptance/out/")), "evidensfiler fra akseptanse skannes ikke").toBe(false);
    expect(isLocalOnlyFile(".env") && isLocalOnlyFile(".env.local") && isLocalOnlyFile("ops/acceptance/out/x.md") && !isLocalOnlyFile(".env.example") && !isLocalOnlyFile("ops/job-runner/acceptance.sh")).toBe(true);
  });

  it("det gamle eiernavnet i repo-form står kun i tillatelseslisten, og tillatte filer nevner bare de gamle repoene de er tillatt for (ingen NY forekomst skjuler seg i en tillatt fil)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const path = rel(f);
      const text = readFileSync(f, "utf8");
      const allowed = ALLOWED[path];
      if (allowed === undefined) {
        const hits = legacyOwnerHits(text);
        if (hits.length > 0) offenders.push(`${path}: ${hits.join(", ")}`);
      } else if (allowed.only !== undefined) {
        if (legacyOwnerHits(text).includes("tsworkflow (alene)")) offenders.push(`${path}: eiernavnet alene (uten /repo) er ikke tillatt her`);
        for (const slug of legacyOwnerSlugs(text)) if (!allowed.only.includes(slug)) offenders.push(`${path}: ${slug} er ikke blant de tillatte (${allowed.only.join(", ")})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("de tillatte filene bruker fortsatt det gamle navnet (en tillatelse skal fjernes når filen er ryddet)", () => {
    for (const path of Object.keys(ALLOWED)) {
      expect(legacyOwnerHits(readFileSync(join(ROOT, path), "utf8")).length, path).toBeGreaterThan(0);
    }
  });

  it("alle LEGACY_GITHUB_REPOS er i repo-form (så mønsteret over dekker dem)", () => {
    for (const legacy of LEGACY_GITHUB_REPOS) expect(legacyOwnerHits(legacy).length, legacy).toBeGreaterThan(0);
  });

  it("det kanoniske repoet er ikke hardkodet i kildekoden til tool-gateway/self-modification (de bruker konstanten eller konfigurasjonen)", () => {
    const own = ["modules/tool-gateway/src", "modules/self-modification/src"];
    const offenders = files.map(rel).filter((p) => own.some((o) => p.startsWith(`${o}/`))).filter((p) => readFileSync(join(ROOT, p), "utf8").toLowerCase().includes(CANONICAL_GITHUB_REPO.toLowerCase()));
    expect(offenders).toEqual([]);
  });
});

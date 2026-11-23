import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CANONICAL_GITHUB_REPO, LEGACY_GITHUB_REPOS, githubRepoAliasKey } from "../src/index.ts";

/**
 * WP-A1 (D-478/D-479, JARVIS-117): kontobyttet gjorde `tsworkflow/jarvisbuild` til et frosset, skrivebeskyttet repo. Kildekoden skal ikke lenger hardkode det gamle repoet som standard eller som mål (det var slik
 * `daily-brief.ts` og seks standardverdier ble liggende igjen på det gamle repoet). Denne vakten skanner ALLE filer utenom docs/tester/avhengigheter/binærfiler (også `.ps1`, `.html`, `.tsx`, `.cjs`, `*.example`, Dockerfile, `.github`,
 * rotfiler) etter det gamle EIERNAVNET i repo-form: `tsworkflow/` (slug eller URL) og det siterte tokenet `"tsworkflow"` (objektformen `repoOwner`/`trustedAuthor`). `post@tsworkflow.com` og `com.tsworkflow.*` er ikke repo-referanser og treffes ikke.
 * Nye steder skal bruke `CANONICAL_GITHUB_REPO` (eller `configuredGithubRepoFromEnv`/`configuredGithubRepo()`).
 */
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SKIP_DIRS = new Set(["node_modules", ".git", "docs", "test", "tests", "dist", "build", "coverage", ".turbo", ".claude"]);
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|gz|tgz|tar|bin|mp3|mp4|wasm|sqlite|db)$/i;
const MAX_BYTES = 2_000_000;

/**
 * Bevisst tillatte forekomster (sti fra repo-roten med `/`) med begrunnelse. Legg ALDRI til en sti her uten å forklare hvorfor det gamle eiernavnet må stå der.
 * `only`: filen får kun nevne disse gamle repoene (alias-nøkler) - en NY forekomst (et annet repo under den gamle kontoen, f.eks. `tsworkflow/annet`, eller det siterte tokenet `"tsworkflow"`) feiler selv i en tillatt fil.
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

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile() && !BINARY.test(entry.name)) {
      const path = join(dir, entry.name);
      if (statSync(path).size <= MAX_BYTES) out.push(path);
    }
  }
}

/** Treff for det gamle eiernavnet i repo-form: `tsworkflow/` eller det siterte tokenet `"tsworkflow"`/`'tsworkflow'`. Eksportert som funksjon så selve mønsteret kan testes. */
export function legacyOwnerHits(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  if (lower.includes("tsworkflow/")) hits.push("tsworkflow/");
  if (/["']tsworkflow["']/.test(lower)) hits.push('"tsworkflow"');
  return hits;
}

/** Alle repo-slugger under den gamle kontoen (`tsworkflow/<navn>`) i teksten, som alias-nøkler (små bokstaver, uten `.git`, `/` og etterfølgende skilletegn). */
export function legacyOwnerSlugs(text: string): string[] {
  return [...text.matchAll(/tsworkflow\/[A-Za-z0-9._-]+/gi)].map((m) => githubRepoAliasKey(m[0].replace(/[._-]+$/, "")));
}

describe("WP-A1: ingen hardkodet gammel repo-eier i kjørbar kode og konfig", () => {
  const files: string[] = [];
  walk(ROOT, files);
  const rel = (f: string): string => relative(ROOT, f).split(sep).join("/");

  it("mønsteret treffer repo-former og ikke e-post eller bundle-id", () => {
    expect(legacyOwnerHits("repo: tsworkflow/jarvisbuild")).toEqual(["tsworkflow/"]);
    expect(legacyOwnerHits("https://github.com/TSWorkflow/x")).toEqual(["tsworkflow/"]);
    expect(legacyOwnerHits('{"repoOwner": "tsworkflow"}')).toEqual(['"tsworkflow"']);
    expect(legacyOwnerHits("repoOwner: 'TSWorkflow'")).toEqual(['"tsworkflow"']);
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
        if (legacyOwnerHits(text).includes('"tsworkflow"')) offenders.push(`${path}: siterte tokenet "tsworkflow" er ikke tillatt her`);
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

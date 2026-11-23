import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CANONICAL_GITHUB_REPO, LEGACY_GITHUB_REPOS } from "../src/index.ts";

/**
 * WP-A1 (D-478/D-479, JARVIS-117): kontobyttet gjorde `tsworkflow/jarvisbuild` til et frosset, skrivebeskyttet repo. Kildekoden skal ikke lenger hardkode det som standard eller som
 * mål (det var slik `daily-brief.ts` og seks standardverdier ble liggende igjen på det gamle repoet). Denne vakten skanner KJØRBAR kode og konfig (ikke tester, ikke docs, som er historikk)
 * og feiler hvis et gammelt repo-navn dukker opp utenfor den bevisste tillatelseslisten. Nye steder skal bruke `CANONICAL_GITHUB_REPO` (eller `configuredGithubRepo()` i tool-gateway).
 */
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCAN_DIRS = ["apps", "modules", "packages", "ops", "infra"];
const SKIP_DIRS = new Set(["node_modules", "test", "tests", "dist", "build", "coverage", ".git", ".turbo"]);
const EXTENSIONS = [".ts", ".mts", ".mjs", ".js", ".sh", ".json", ".service", ".yml", ".yaml", ".swift", ".sql"];

/** Bevisst tillatte forekomster (sti fra repo-roten med `/`) med begrunnelse. Legg ALDRI til en sti her uten å forklare hvorfor et frosset repo-navn må stå der. */
const ALLOWED: Readonly<Record<string, string>> = {
  "packages/contracts/src/github-repo.ts": "definerer LEGACY_GITHUB_REPOS (tidligere produksjonsrepoer)",
  "ops/job-runner/acceptance.sh": "nektelisten for produksjonsrepoer i akseptansen (holdt i takt med kontrakten av ops/job-runner/test/acceptance-script.test.mjs)"
};

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile() && EXTENSIONS.some((e) => entry.name.endsWith(e))) {
      out.push(join(dir, entry.name));
    }
  }
}

describe("WP-A1: ingen hardkodet gammel repo-slug i kjørbar kode og konfig", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
  files.push(join(ROOT, ".env.example"));
  const rel = (f: string): string => relative(ROOT, f).split(sep).join("/");

  it("vakten ser faktisk filer (ikke vakuum) og kjenner de bevisste forekomstene", () => {
    expect(files.length).toBeGreaterThan(300);
    for (const allowed of Object.keys(ALLOWED)) expect(files.map(rel), allowed).toContain(allowed);
  });

  it("det gamle repoet står kun i tillatelseslisten", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const path = rel(f);
      if (ALLOWED[path] !== undefined) continue;
      const text = readFileSync(f, "utf8").toLowerCase();
      for (const legacy of LEGACY_GITHUB_REPOS) if (text.includes(legacy.toLowerCase())) offenders.push(`${path}: ${legacy}`);
    }
    expect(offenders).toEqual([]);
  });

  it("de tillatte filene bruker fortsatt de gamle navnene (en forelder tillatelse skal fjernes når filen er ryddet)", () => {
    for (const path of Object.keys(ALLOWED)) {
      const text = readFileSync(join(ROOT, path), "utf8").toLowerCase();
      expect(LEGACY_GITHUB_REPOS.some((l) => text.includes(l.toLowerCase())), path).toBe(true);
    }
  });

  it("det kanoniske repoet er ikke hardkodet utenfor kontrakten i kildekoden til tool-gateway/self-modification (de bruker konstanten eller konfigurasjonen)", () => {
    const own = ["modules/tool-gateway/src", "modules/self-modification/src"];
    const offenders = files.map(rel).filter((p) => own.some((o) => p.startsWith(`${o}/`))).filter((p) => readFileSync(join(ROOT, p), "utf8").toLowerCase().includes(CANONICAL_GITHUB_REPO.toLowerCase()));
    expect(offenders).toEqual([]);
  });
});

import { PRODUCTION_GITHUB_REPO_NAMES, githubRepoAliasKey } from "@jarvis/contracts";
import { configuredGithubRepo } from "./github-repo-lock.ts";

/**
 * D-479 (WP-A1, JARVIS-117 c) / D-41: live- og akseptanse-SKRIPT som SKRIVER (test-branch, issue, kommentar) må aldri peke på et produksjonsrepo: test-/akseptanseløp begrenses til sandbox-ressurser (blast radius).
 * ÉN felles definisjon av «produksjon» for operatør-skriptene (`github-app-live.ts --sandbox-repo`, `ua5-github-live.ts`): de faste produksjonsnavnene (`PRODUCTION_GITHUB_REPO_NAMES`: det kanoniske repoet,
 * forkets tidligere navn og det gamle frosne repoet), repoet connectoren er konfigurert mot (`JARVIS_GITHUB_REPO`, ellers standarden) og eventuelle ekstra produksjonsrepoer kalleren kjenner (f.eks. allowlisten
 * `JARVIS_GIT_ALLOWED_REPOS`). Sammenligningen går via `githubRepoAliasKey`: små bokstaver, uten blanke, uten `.git` og `/` på slutten, så et alias (`eier/repo.git`) ikke omgår vernet. Ingen overstyring finnes med vilje.
 * (`ops/job-runner/acceptance.sh` har samme regler i bash; en test holder listene i takt.)
 */
export function productionGithubRepoKeys(env: Readonly<Record<string, string | undefined>> = process.env, extra: readonly string[] = []): Set<string> {
  return new Set([...PRODUCTION_GITHUB_REPO_NAMES, configuredGithubRepo(env), ...extra].map(githubRepoAliasKey).filter((key) => key.length > 0));
}

export function isProductionGithubRepo(slug: string, env: Readonly<Record<string, string | undefined>> = process.env, extra: readonly string[] = []): boolean {
  const key = githubRepoAliasKey(slug);
  return key.length > 0 && productionGithubRepoKeys(env, extra).has(key);
}

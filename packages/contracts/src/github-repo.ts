/**
 * D-478 / D-479 (WP-A1): ÉN kilde for Jarvis' kanoniske GitHub-repo.
 *
 * Eieren byttet GitHub-konto 2026-11-22 (D-478): `tsworkflow/jarvisbuild` er frosset og kan ikke lenger skrives til, og koden bor nå i
 * `FFrollerskis/jarvis-build`. Standardverdien her brukes KUN når `JARVIS_GITHUB_REPO` ikke er satt (eller er tom/ugyldig); eierens egen
 * innstilling på NAS-en vinner alltid. Standardverdien gir ingen tilgang til noe: GitHub-kall trenger fortsatt en credential som er
 * utstedt for repoet (JARVIS-117, Q-77 pkt 4 - bare eieren kan utstede den).
 *
 * Standarden gjelder GitHub-VERKTØYENE (repolåsen Q-50 B, oppløsning av repo-navn, connector-test, daglig oppsummering, mesh-verktøyet) og selvmodifikasjon.
 * Kodejobber (`JARVIS_GIT_ALLOWED_REPOS`, `modules/tasks/src/git-policy.ts`) og GitHub App-modus har BEVISST INGEN standard: de krever eksplisitt
 * `JARVIS_GITHUB_REPO` eller `JARVIS_GIT_ALLOWED_REPOS` og feiler lukket uten (de skriver branches; blast radius).
 *
 * `LEGACY_GITHUB_REPOS` er tidligere produksjonsrepoer. De skal ikke lenger være standard, men vern som nekter «produksjonsrepoet»
 * (f.eks. akseptansescriptet `ops/job-runner/acceptance.sh` og `modules/tool-gateway/scripts/github-app-live.ts`) må fortsatt kjenne dem igjen: en
 * akseptanse skal aldri pushe en ekte branch til et produksjonsrepo, verken det nåværende eller det gamle.
 */
export const CANONICAL_GITHUB_REPO = "FFrollerskis/jarvis-build";

export const LEGACY_GITHUB_REPOS: readonly string[] = ["tsworkflow/jarvisbuild"];

const GITHUB_REPO_SLUG = /^[^/\s]+\/[^/\s]+$/;

/**
 * ÉN definisjon av et gyldig `JARVIS_GITHUB_REPO` (`eier/navn`, trimmet): alt annet (tom, kun blanke, URL, `a/b/c`, mellomrom i navnet, ikke-streng) gir `null`.
 * Låsen, oppløsningen av repo-navn, connector-testen, mesh-verktøyet, daglig oppsummering, selvmodifikasjon og operatør-scriptene bruker alle denne, så de aldri peker ulike steder.
 */
export function parseGithubRepoSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return GITHUB_REPO_SLUG.test(trimmed) ? trimmed : null;
}

/** Eierens konfigurerte repo (`JARVIS_GITHUB_REPO` i `env`) eller standarden. Tom eller ugyldig verdi gir standarden (compose setter variabelen tom som standard). */
export function configuredGithubRepoFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  return parseGithubRepoSlug(env["JARVIS_GITHUB_REPO"]) ?? CANONICAL_GITHUB_REPO;
}

/**
 * Sammenligningsnøkkel for et repo-navn i VERN som nekter produksjonsrepoer: små bokstaver, uten ledende/etterfølgende blanke, uten `/` på slutten og uten `.git`-suffiks.
 * GitHub behandler `eier/repo`, `eier/repo/` og `eier/repo.git` som samme repo i git-URL-er, så et alias skal ikke omgå vernet. (Samme normalisering står i `ops/job-runner/acceptance.sh`.)
 */
export function githubRepoAliasKey(slug: string): string {
  let key = slug.trim().toLowerCase();
  for (;;) {
    const next = key.endsWith("/") ? key.slice(0, -1) : key.endsWith(".git") ? key.slice(0, -4) : key;
    if (next === key) return key;
    key = next;
  }
}

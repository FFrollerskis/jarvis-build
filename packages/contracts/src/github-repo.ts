/**
 * D-478 / D-479 (WP-A1): ÉN kilde for Jarvis' kanoniske GitHub-repo.
 *
 * Eieren byttet GitHub-konto 2026-11-22 (D-478): `tsworkflow/jarvisbuild` er frosset og kan ikke lenger skrives til, og koden bor nå i
 * `FFrollerskis/jarvis-build`. Standardverdien her brukes KUN når `JARVIS_GITHUB_REPO` ikke er satt (eller er ugyldig); eierens egen
 * innstilling på NAS-en vinner alltid. Standardverdien gir ingen tilgang til noe: GitHub-kall trenger fortsatt en credential som er
 * utstedt for repoet (JARVIS-117, Q-77 pkt 4 - bare eieren kan utstede den).
 *
 * `LEGACY_GITHUB_REPOS` er tidligere produksjonsrepoer. De skal ikke lenger være standard, men vern som nekter «produksjonsrepoet»
 * (f.eks. akseptansescriptet `ops/job-runner/acceptance.sh`) må fortsatt kjenne dem igjen: en akseptanse skal aldri pushe en ekte branch
 * til et produksjonsrepo, verken det nåværende eller det gamle.
 */
export const CANONICAL_GITHUB_REPO = "FFrollerskis/jarvis-build";

export const LEGACY_GITHUB_REPOS: readonly string[] = ["tsworkflow/jarvisbuild"];

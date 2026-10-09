/**
 * WP-C3 (Q-45 b / D-35 / D-450): kilde til KORTLEVDE, REPO-SCOPEDE git-credentials.
 *
 * Definert som en ren kontrakt i `@jarvis/contracts` slik at BÅDE leverandørsiden (`@jarvis/tool-gateway`: GitHub App-autentisering,
 * `GitHubAuth.gitCredentialSource()`) og forbrukersiden (`@jarvis/tasks`: vertsside job-runner for kodejobber, WP-C1) kan bruke samme
 * type uten at noen av pakkene importerer den andre (ingen sirkulær avhengighet). Strukturell typing gjør at en forbruker som ennå ikke
 * importerer kontrakten kan duck-typere `{ tokenFor(repoSlug: string): Promise<string> }` - signaturen er bevisst så smal.
 *
 * Kontrakt:
 *  - `repoSlug` er `owner/repo` (GitHub er case-insensitivt). Implementasjonen validerer slugen selv og avviser alt annet.
 *  - Returverdien er en HEMMELIGHET: brukes som HTTP-passord (`x-access-token:<token>`) for `git clone`/`git push` mot
 *    `https://github.com/<repoSlug>`. Den skal aldri logges, aldri lagres på disk i klartekst og aldri gis til modellen eller til
 *    agentkode i jobb-sandboxen (kun til selve git-underprosessen, via credential-helperens eget miljø - se `modules/tasks/src/git-auth.ts`).
 *  - Verdien er KORTLEVD (installasjonstoken: 1 time). Kall `tokenFor` rett før hver git-nettverksoperasjon i stedet for å holde på den.
 *  - Implementasjonen (`GitHubAuth.gitCredentialSource`) utsteder med MINSTE rettighet for git over HTTPS (kun Contents: write, aldri Workflows/Issues/PR) og kun for dette ene repoet;
 *    det er IKKE connectorens standard-scope-token. Forbrukere skal ikke anta noe bredere (PR-opprettelse går via ToolGateway, ikke via git-tokenet).
 *  - Feil kastes (aldri tom streng/null/undefined): en jobb som ikke kan få credential skal feile FØR clone forsøkes
 *    (`git_auth_unavailable`), aldri falle stille tilbake til uautentisert git eller et bredere token.
 */
export interface GitCredentialSource {
  tokenFor(repoSlug: string): Promise<string>;
}

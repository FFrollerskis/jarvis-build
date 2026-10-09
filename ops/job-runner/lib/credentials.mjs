import { RunnerError } from "./errors.mjs";
import { readSecretFile } from "./fsutil.mjs";

/**
 * WP-C1: git-credential-kilde INNE I runner-tjenesten. Credentialen forlater aldri denne prosessen unntatt som env på
 * ETT git-kall (`JARVIS_GIT_CREDENTIAL_TOKEN`) lest av `credential-helper.mjs`; den går ALDRI inn i jobb-containeren,
 * arbeidsmappen, `.git/config`, argv eller loggen.
 *
 * Grensesnittet er bevisst enkelt (`tokenFor(repoSlug) -> Promise<string>`) slik at en kortlevd GitHub App-installasjons-
 * token-kilde (WP-C3) kan byttes inn uten å røre resten. Denne filen bygger IKKE App-auth. Typedefen er STRUKTURELT lik
 * `GitCredentialSource` i packages/contracts/src/git-credential.ts (WP-C3, egen branch): ikke importert herfra, men like, slik at de kan
 * dedupliseres ved merge. Runneren kaller `tokenFor` ved HVER klone og HVER publish (ingen mellomlagring), validerer svaret med
 * `assertWellFormedToken`, og ruller alle andre feil enn RunnerError om til `git_credential_unavailable` uten å gjengi feilmeldingen.
 *
 * To veier til et token, valgt PER REPO av vertsadmins konfig (`runner.git_credentials[repo].source`), aldri av klienten:
 *  - `file` (standard): `GitCredentialSource` på verten (PAT i en fil som kun runneren kan lese). Et token i forespørselen nektes.
 *  - `request`: worker henter et kortlevd, repo-scopet installasjonstoken (WP-C3) og sender det i `POST /v1/jobs` (klone) og `POST /v1/jobs/:id/publish`
 *    (push) som `git_token`. Det er bearer-autentisert over Unix-socketen, gyldig for ÉN operasjon (aldri mellomlagret, aldri lagret i jobben), kontrollert
 *    av `assertRequestToken`, holdt i det tellende hemmelighetsregisteret mens det er i bruk, og leveres som før kun som env til ETT git-kall. Det går
 *    ALDRI inn i jobb-containeren, arbeidsmappen, `.git/config`, argv, loggen eller svaret. Mangler det, eller er det sendt for et `file`-repo: avvist.
 *
 * @typedef {{ tokenFor(repoSlug: string): Promise<string> }} GitCredentialSource
 */

/**
 * Gyldig git-token: PAT (`ghp_...`, `github_pat_...`) OG installasjonstokens (`ghs_<APPID>_<JWT>`), som kan bli lange uten dokumentert maks.
 * Lengdetaket er derfor romslig (8192), men tegnsettet er SMALT: ingen mellomrom, kontrolltegn, `:`, `@`, `/` eller anførselstegn. Det hindrer at
 * en feilaktig eller kompromittert kilde kan endre meningen til credential-protokollen (linjeskift!), env-overføringen eller en URL.
 */
export const TOKEN_FORMAT = /^[A-Za-z0-9_.-]{8,8192}$/;
export const MAX_TOKEN_CHARS = 8192;

/**
 * Kontrollerer et token fra HVILKEN SOM HELST kilde (fil, eller en injisert kilde som WP-C3 sin GitHub App) før det brukes.
 * @param {unknown} value
 * @returns {string}
 */
export function assertWellFormedToken(value) {
  if (typeof value !== "string" || !TOKEN_FORMAT.test(value)) throw new RunnerError("git_credential_unavailable", 502, "token_format_invalid");
  return value;
}

/**
 * Et token i en FORESPØRSEL (`source: request`) kommer fra worker og er dermed mindre betrodd enn en root-eid fil. Det må derfor være
 * (1) velformet som over og (2) se ut som en GitHub-credential: installasjonstoken `ghs_`, klassisk PAT `ghp_` eller fine-grained PAT `github_pat_`,
 * minst 20 tegn. Det er forsvar i dybden mot at worker ved en feil sender en ANNEN hemmelighet (Anthropic-nøkkel, bearer-token, vault-verdi) som
 * runneren ellers ville sendt som passord til github.com. Feilen gjengir aldri verdien.
 */
export const REQUEST_TOKEN_FORMAT = /^(?:ghs_|ghp_|github_pat_)[A-Za-z0-9_.-]{8,8192}$/;
export const MIN_REQUEST_TOKEN_CHARS = 20;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function assertRequestToken(value) {
  if (typeof value !== "string") throw new RunnerError("git_token_invalid", 400, "not_a_string");
  if (value.length < MIN_REQUEST_TOKEN_CHARS) throw new RunnerError("git_token_invalid", 400, "too_short");
  if (value.length > MAX_TOKEN_CHARS) throw new RunnerError("git_token_invalid", 400, "too_long");
  if (!TOKEN_FORMAT.test(value) || !REQUEST_TOKEN_FORMAT.test(value)) throw new RunnerError("git_token_invalid", 400, "format");
  return value;
}

/** Hvor lenge runneren venter på at en kilde svarer før jobben feiler lukket (en hengende kilde skal aldri holde en jobbplass). */
export const TOKEN_SOURCE_TIMEOUT_MS = 30_000;

/** Flyktig per-kall-kanal (env på ETT git-kall) som `credential-helper.mjs` leser. Samme interne navn som git-auth.ts (worker-siden). */
export const GIT_CREDENTIAL_TOKEN_ENV = "JARVIS_GIT_CREDENTIAL_TOKEN";

/**
 * Fil-basert PAT-kilde (Q-45b-fallback): én fine-grained PAT per repo (begrenset til ETT repo hos GitHub), i en fil eid av
 * root/tjenestebrukeren uten tilgang for andre. Filen leses ved HVER bruk (rotasjon krever ikke omstart).
 *
 * @implements {GitCredentialSource}
 */
export class FileGitCredentialSource {
  /**
   * @param {{
   *   files: Readonly<Record<string, { tokenFile?: string }>>,
   *   readSecret?: (path: string, options: { label: string }) => Promise<string>
   * }} options
   */
  constructor(options) {
    this.files = options.files;
    this.readSecret = options.readSecret ?? ((path, opts) => readSecretFile(path, opts));
  }

  /** @param {string} repoSlug */
  async tokenFor(repoSlug) {
    const entry = Object.prototype.hasOwnProperty.call(this.files, repoSlug) ? this.files[repoSlug] : undefined;
    // Et repo med `source: request` har ingen fil: filkilden skal aldri kunne levere noe for det (token kommer da kun fra forespørselen).
    if (!entry || typeof entry.tokenFile !== "string") throw new RunnerError("git_credential_unavailable", 403, "repo_not_configured");
    let value;
    try {
      value = await this.readSecret(entry.tokenFile, { label: "git_token_file" });
    } catch (error) {
      throw new RunnerError("git_credential_unavailable", 502, error instanceof Error ? error.message.slice(0, 80) : "unreadable");
    }
    return assertWellFormedToken(value);
  }
}

const SAFE_BIN_PATH = /^\/[A-Za-z0-9._/@+-]+$/;
const SAFE_HOST = /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;
const SAFE_REPO_PATH = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * `-c`-argv som (1) nullstiller enhver ambient credential.helper-kjede for akkurat dette kallet og (2) registrerer
 * runnerens EGEN helper med scopet innebakt. Alle deler valideres mot et smalt tegnsett FØR de settes inn i
 * shell-snippeten git evaluerer (`!'<node>' '<skript>' '<protocol>' '<host>' '<owner/repo>'`) - ingen anførselstegn eller
 * metategn kan nå shellen.
 *
 * @param {{ nodePath: string, helperScript: string, scope: { protocol: "https" | "http", host: string, path: string } }} options
 * @returns {string[]}
 */
export function credentialHelperArgs(options) {
  const { nodePath, helperScript, scope } = options;
  if (!SAFE_BIN_PATH.test(nodePath) || !SAFE_BIN_PATH.test(helperScript)) throw new RunnerError("credential_helper_path_unsafe", 500);
  if ((scope.protocol !== "https" && scope.protocol !== "http") || !SAFE_HOST.test(scope.host) || !SAFE_REPO_PATH.test(scope.path)) {
    throw new RunnerError("credential_scope_invalid", 500);
  }
  const snippet = `!'${nodePath}' '${helperScript}' '${scope.protocol}' '${scope.host}' '${scope.path}'`;
  return ["-c", "credential.helper=", "-c", `credential.helper=${snippet}`, "-c", "credential.useHttpPath=true"];
}

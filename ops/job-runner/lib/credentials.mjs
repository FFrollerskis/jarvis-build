import { RunnerError } from "./errors.mjs";
import { readSecretFile } from "./fsutil.mjs";

/**
 * WP-C1: git-credential-kilde INNE I runner-tjenesten. Credentialen forlater aldri denne prosessen unntatt som env på
 * ETT git-kall (`JARVIS_GIT_CREDENTIAL_TOKEN`) lest av `credential-helper.mjs`; den går ALDRI inn i jobb-containeren,
 * arbeidsmappen, `.git/config`, argv eller loggen.
 *
 * Grensesnittet er bevisst enkelt (`tokenFor(repoSlug) -> Promise<string>`) slik at en kortlevd GitHub App-installasjons-
 * token-kilde (WP-C3) kan byttes inn uten å røre resten. Denne filen bygger IKKE App-auth.
 *
 * @typedef {{ tokenFor(repoSlug: string): Promise<string> }} GitCredentialSource
 */

const TOKEN_FORMAT = /^[A-Za-z0-9_.-]{8,512}$/;

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
   *   files: Readonly<Record<string, { tokenFile: string }>>,
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
    if (!entry) throw new RunnerError("git_credential_unavailable", 403, "repo_not_configured");
    let value;
    try {
      value = await this.readSecret(entry.tokenFile, { label: "git_token_file" });
    } catch (error) {
      throw new RunnerError("git_credential_unavailable", 502, error instanceof Error ? error.message.slice(0, 80) : "unreadable");
    }
    if (!TOKEN_FORMAT.test(value)) throw new RunnerError("git_credential_unavailable", 502, "token_format_invalid");
    return value;
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

import { readFile } from "node:fs/promises";
import http from "node:http";
import { parseGitHubRepoUrl } from "./git-policy.ts";
import { isHostRunnerEnvNameAllowed } from "./job-container-spec.mjs";
import type {
  ExecResult, HostGitCheckoutRequest, HostGitCheckoutResult, HostGitPublishRequest, HostGitPublishResult, Sandbox, SandboxMeta, SandboxRunner
} from "./sandbox.ts";

/**
 * WP-C1 (D-32 / Q-45a / Q-46 punkt 5): worker-side klient mot den VERTSSIDE job-runneren (`ops/job-runner/`). Worker har ingen
 * Docker-socket og kjører aldri kode selv; denne klienten snakker HTTP over et Unix-domene-socket (montert fra verten) med et
 * bearer-token LEST FRA FIL (aldri en env-verdi i klartekst).
 *
 * Det som gjør denne veien trygg (og som `coding.ts` bygger på via `hostGit: true`):
 *  - git-credentialen finnes IKKE her som standard. Klone og push skjer på verten med runnerens egen credential (PAT i en fil bare runneren kan lese);
 *    worker henter da aldri et git-token, sender aldri credential-env, og jobb-containeren ser aldri noe.
 *  - UNNTAK, kun når vertsadmin har satt repoet til `source: request` i den root-eide runner-konfigen OG denne klienten er gitt en `gitCredentialSource`
 *    (WP-C3: GitHub App): klienten henter et KORTLEVD, REPO-SCOPET token rett før klonen og et FERSKT rett før pushen og sender det som `git_token` i
 *    jobbforespørselen over det bearer-autentiserte Unix-socketet. Tokenet formkontrolleres her først (en feilsendt annen hemmelighet forlater aldri
 *    worker), mellomlagres ikke, ligger aldri i jobb-env, går aldri inn i jobb-containeren (runneren leverer det kun som env til ett git-kall) og
 *    gjengis aldri i feil eller logg. Uten kilde sendes aldri noe token. Feil kilde/feil konfig hos runneren lukker jobben (ingen stille fallback).
 *  - API-et er smalt: repo (slug), env, argv, branch (+ det valgfrie git-tokenet). Klienten kan ikke sende docker-flagg, mounts, image, nettverk eller stier.
 *  - Alle feil lukkes: ugyldig konfig/utilgjengelig runner/avvist token gir en jobbfeil med stabil kode, aldri en stille fallback.
 *
 * Jobben opprettes først ved `gitCheckout` (runneren trenger repoet for å klone); `exec` før det kaster.
 *
 * Tilgang til socketen er en filsystem-rettighet, ikke et hemmelig token alene: socketen er 0660 med gruppen `jarvis-job-clients`, og
 * worker-containeren får KUN den gruppen via `group_add` (numerisk gid i `JARVIS_JOB_RUNNER_GID`, brukt av den valgfrie
 * override-filen infra/job-runner/docker-compose.job-runner.yml). Tokenfilen er et andre, uavhengig lag.
 */

const SOCKET_PATH = /^\/[A-Za-z0-9._/-]{1,100}$/;
const FILE_PATH = /^\/[A-Za-z0-9._/@+-]{1,198}$/;
const TOKEN_FORMAT = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const LABEL = /^[A-Za-z0-9._:-]{1,100}$/;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/**
 * Et git-token som skal sendes til runneren: GitHub-credential (installasjonstoken `ghs_`, klassisk PAT `ghp_`, fine-grained PAT `github_pat_`), 20-8192 tegn,
 * smalt tegnsett. SAMME regel som runneren håndhever (`ops/job-runner/lib/credentials.mjs`): feiler den her, forlater verdien aldri worker.
 */
const GIT_TOKEN_FORMAT = /^(?:ghs_|ghp_|github_pat_)[A-Za-z0-9_.-]{8,8192}$/;
const GIT_TOKEN_MIN_CHARS = 20;
const GIT_TOKEN_MAX_CHARS = 8192;
const DEFAULT_CREDENTIAL_TIMEOUT_MS = 30_000;
/** Feilkoder fra en kilde som er trygge å vise (kun konstant-lignende koder, aldri fritekst som kan inneholde en hemmelighet). */
const SAFE_SOURCE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,59}$/;

/**
 * Kilde til KORTLEVDE, REPO-SCOPEDE git-credentials. STRUKTURELT identisk med `GitCredentialSource` i `@jarvis/contracts` (WP-C3, egen branch,
 * `GitHubAuth.gitCredentialSource()`): ikke importert herfra slik at denne filen ikke avhenger av en annen gren, men en WP-C3-kilde kan sendes inn
 * direkte. `repoSlug` er `owner/repo`; returverdien er en HEMMELIGHET som kun brukes som HTTP-passord for git mot nøyaktig det repoet.
 */
export interface HostGitCredentialSource {
  tokenFor(repoSlug: string): Promise<string>;
}

/**
 * WP-C1 review B-M2: pakker en kilde til kortlevde git-tokens (`source: request`) med eierens per-credential-tilbakekalling (`owner_controls.revoke_credential`, WP-C3 F3).
 * `isRevoked` kalles FØR kilden: er credentialen tilbakekalt, eller sjekken selv feiler, utstedes ikke noe token (fail-closed, `git_credential_unavailable:GIT_AUTH_REVOKED` /
 * `...:GIT_AUTH_REVOCATION_CHECK_FAILED` - kun stabile koder, aldri en melding fra kilden). Kodejobben har allerede en sjekk før klone og publish (`coding.ts`); denne vakten
 * gjør at kilden aldri kan nås uten sjekken uansett hvem som kaller runneren. Brukes ved kobling i worker-main (kapittel 15 i runbooken):
 * `resolveJobSandboxRunner(env, { gitCredentialSource: guardGitCredentialSource(githubAuth.gitCredentialSource(...), () => ownerControls.isRevokedDurable("JARVIS_GITHUB_TOKEN")) })`.
 */
export function guardGitCredentialSource(source: HostGitCredentialSource, isRevoked: () => Promise<boolean>): HostGitCredentialSource {
  const coded = (code: string): Error => Object.assign(new Error(code.toLowerCase()), { code });
  return {
    async tokenFor(repoSlug: string): Promise<string> {
      let revoked: boolean;
      try {
        revoked = await isRevoked();
      } catch {
        throw coded("GIT_AUTH_REVOCATION_CHECK_FAILED");
      }
      if (revoked) throw coded("GIT_AUTH_REVOKED");
      return source.tokenFor(repoSlug);
    }
  };
}

export class HostJobRunnerConfigError extends Error {
  constructor(readonly reason: string) {
    super(`host_job_runner_config_invalid:${reason}`);
    this.name = "HostJobRunnerConfigError";
  }
}

/** En feil fra runneren (stabil kode + kort, renset detalj) eller transporten. Meldingen inneholder aldri token. */
export class HostJobRunnerError extends Error {
  constructor(readonly code: string, readonly status: number, detail?: string) {
    super(`host_job_runner_error:${code}${detail ? `:${detail}` : ""}`);
    this.name = "HostJobRunnerError";
  }
}

export interface HostJobRunnerOptions {
  /** Absolutt sti til runnerens Unix-socket (monteres fra verten som en KATALOG, slik at omstart av runneren ikke gjør mounten ugyldig). */
  socketPath: string;
  /** Absolutt sti til filen med bearer-tokenet. Leses ved HVER forespørsel (rotasjon krever ikke omstart av worker). */
  tokenFile: string;
  /** Injiserbar token-kilde (tester). */
  readToken?: () => Promise<string>;
  /** Slingringsmonn utover jobbens egen tidsgrense før klienten gir opp en forespørsel. */
  requestSlackMs?: number;
  /**
   * Valgfri kilde til kortlevde, repo-scopede git-tokens (WP-C3). Når den er satt sender klienten et FERSKT token i hver klone- og publish-forespørsel
   * (`git_token`), og runneren godtar det kun for repoer vertsadmin har satt til `source: request`; for øvrige repoer avviser runneren forespørselen
   * (`git_token_not_accepted`, jobben feiler lukket). Utelatt = aldri noe token i forespørselene (PAT-fil hos runneren, som før).
   */
  gitCredentialSource?: HostGitCredentialSource;
  /** Maks ventetid på kilden før jobben feiler lukket (standard 30 s). En hengende kilde skal aldri holde en jobb. */
  credentialTimeoutMs?: number;
}

interface RunnerResponse {
  status: number;
  json: Record<string, unknown>;
}

export class HostJobSandboxRunner implements SandboxRunner {
  readonly name = "host-job-runner";
  readonly hostGit = true;
  private readonly slackMs: number;
  private readonly credentialTimeoutMs: number;

  constructor(private readonly options: HostJobRunnerOptions) {
    if (typeof options.socketPath !== "string" || !SOCKET_PATH.test(options.socketPath) || options.socketPath.includes("..") || options.socketPath.includes("//")) {
      throw new HostJobRunnerConfigError("socket_path_invalid");
    }
    if (options.readToken === undefined && (typeof options.tokenFile !== "string" || !FILE_PATH.test(options.tokenFile) || options.tokenFile.includes("..") || options.tokenFile.includes("//"))) {
      throw new HostJobRunnerConfigError("token_file_invalid");
    }
    if (options.gitCredentialSource !== undefined && typeof options.gitCredentialSource.tokenFor !== "function") {
      throw new HostJobRunnerConfigError("git_credential_source_invalid");
    }
    this.slackMs = options.requestSlackMs ?? 30_000;
    this.credentialTimeoutMs = options.credentialTimeoutMs ?? DEFAULT_CREDENTIAL_TIMEOUT_MS;
  }

  /**
   * Henter et FERSKT git-token for `slug` rett før ÉN git-operasjon (klone eller push) - aldri mellomlagret her, slik at et kortlevd installasjonstoken
   * alltid har full levetid igjen. Fail-closed: en kilde som kaster, henger, eller svarer med noe annet enn et velformet GitHub-token gir
   * `git_credential_unavailable` UTEN å gjengi kildens feilmelding (kan inneholde hemmeligheter) og uten at noe sendes til runneren.
   * Returnerer `undefined` når ingen kilde er satt (da sendes aldri noe token).
   */
  private async gitToken(slug: string): Promise<string | undefined> {
    const source = this.options.gitCredentialSource;
    if (source === undefined) return undefined;
    const pending: Promise<unknown> = Promise.resolve().then(() => source.tokenFor(slug));
    pending.catch(() => undefined); // en kilde som feiler ETTER tidsgrensen skal aldri bli en ubehandlet rejection
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HostJobRunnerError("git_credential_unavailable", 0, "source_timeout")), this.credentialTimeoutMs);
    });
    let value: unknown;
    try {
      value = await Promise.race([pending, timeout]);
    } catch (error) {
      if (error instanceof HostJobRunnerError) throw error;
      const code = (error as { code?: unknown } | null)?.code;
      throw new HostJobRunnerError("git_credential_unavailable", 0, typeof code === "string" && SAFE_SOURCE_ERROR_CODE.test(code) ? code : "source_failed");
    } finally {
      clearTimeout(timer);
    }
    if (typeof value !== "string" || value.length < GIT_TOKEN_MIN_CHARS || value.length > GIT_TOKEN_MAX_CHARS || !GIT_TOKEN_FORMAT.test(value)) {
      throw new HostJobRunnerError("git_credential_unavailable", 0, "token_format_invalid");
    }
    return value;
  }

  private async token(): Promise<string> {
    let raw: string;
    try {
      raw = this.options.readToken ? await this.options.readToken() : await readFile(this.options.tokenFile, "utf8");
    } catch {
      throw new HostJobRunnerError("token_unavailable", 0);
    }
    const token = raw.replace(/\s+$/u, "");
    if (!TOKEN_FORMAT.test(token)) throw new HostJobRunnerError("token_invalid", 0);
    return token;
  }

  /** Ett HTTP-kall over Unix-socket. Kaster `HostJobRunnerError` ved transportfeil; HTTP-feilstatus returneres til kalleren. */
  private async request(method: "POST" | "DELETE", path: string, body: unknown, timeoutMs: number): Promise<RunnerResponse> {
    const token = await this.token();
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<RunnerResponse>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.options.socketPath,
          method,
          path,
          timeout: timeoutMs,
          headers: {
            authorization: `Bearer ${token}`,
            ...(payload !== undefined ? { "content-type": "application/json", "content-length": String(payload.length) } : {})
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy(new Error("response_too_large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", (err) => reject(new HostJobRunnerError("response_failed", 0, (err as Error).message.slice(0, 60))));
          res.on("end", () => {
            let json: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
              if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
            } catch {
              reject(new HostJobRunnerError("response_not_json", res.statusCode ?? 0));
              return;
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
        reject(new HostJobRunnerError("unreachable", 0, String(code).slice(0, 40)));
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /** HTTP-feil fra runneren -> typet feil. `secret` (git-tokenet i forespørselen) fjernes fra kode og detalj hvis runneren mot formodning skulle ekko det. */
  private static fail(res: RunnerResponse, secret?: string): never {
    if (res.status === 401) throw new HostJobRunnerError("unauthorized", 401);
    const scrub = (text: string): string => (secret !== undefined && secret.length > 0 ? text.split(secret).join("[REDACTED]") : text);
    const code = typeof res.json["error"] === "string" ? scrub(res.json["error"]) : "unexpected_response";
    const detail = typeof res.json["detail"] === "string" ? scrub(res.json["detail"]) : undefined;
    throw new HostJobRunnerError(code, res.status, detail);
  }

  async create(jobEnv: Record<string, string> = {}, meta?: SandboxMeta): Promise<Sandbox> {
    for (const name of Object.keys(jobEnv)) {
      // Samme regler som runneren håndhever - avvist FØR noe sendes (en jobb-env med git-credential/vault-nøkkel når aldri socketen).
      if (!isHostRunnerEnvNameAllowed(name)) throw new Error(`job_env_forbidden:${name}`);
    }
    const call = (method: "POST" | "DELETE", path: string, body: unknown, timeoutMs: number): Promise<RunnerResponse> => this.request(method, path, body, timeoutMs);
    const tokenFor = (slug: string): Promise<string | undefined> => this.gitToken(slug);
    const slackMs = this.slackMs;
    let jobId: string | undefined;
    let repoSlug: string | undefined;
    let dead = false;

    const sandbox: Sandbox = {
      // Stien INNE I containeren (informativ - worker har ingen vertssti å bruke).
      workdir: "/work",

      async gitCheckout(request: HostGitCheckoutRequest): Promise<HostGitCheckoutResult> {
        if (jobId !== undefined) throw new Error("host_job_already_checked_out");
        const ref = parseGitHubRepoUrl(request.repoUrl); // kaster GitPolicyError ved alt annet enn eksakt https://github.com/<owner>/<repo>
        // Fersk, repo-scopet token rett FØR klonen (kun når en kilde er satt). Samme verdi i jobb-env ville havnet i containeren: stoppes her.
        const gitToken = await tokenFor(ref.slug);
        if (gitToken !== undefined && Object.values(jobEnv).some((value) => typeof value === "string" && value.includes(gitToken))) {
          throw new HostJobRunnerError("git_token_in_env", 0);
        }
        const body = {
          repo: ref.slug,
          env: jobEnv,
          ...(request.baseBranch !== undefined ? { base_branch: request.baseBranch } : {}),
          ...(meta?.task_id !== undefined && LABEL.test(meta.task_id) ? { task_id: meta.task_id } : {}),
          ...(meta?.tenant_id !== undefined && LABEL.test(meta.tenant_id) ? { tenant_id: meta.tenant_id } : {}),
          ...(gitToken !== undefined ? { git_token: gitToken } : {})
        };
        const res = await call("POST", "/v1/jobs", body, 600_000);
        if (res.status !== 201) HostJobSandboxRunner.fail(res, gitToken);
        const id = res.json["job_id"];
        const headSha = res.json["head_sha"];
        const baseBranch = res.json["base_branch"];
        if (typeof id !== "string" || typeof headSha !== "string" || typeof baseBranch !== "string") throw new HostJobRunnerError("malformed_response", res.status);
        jobId = id;
        repoSlug = ref.slug;
        return { headSha, baseBranch };
      },

      async exec(command: string, args: string[], timeoutMs = 60_000, extraEnv?: Record<string, string>): Promise<ExecResult> {
        if (dead) return { code: 1, stdout: "", stderr: "job_container_terminated" };
        if (jobId === undefined) throw new Error("host_job_not_checked_out");
        for (const name of Object.keys(extraEnv ?? {})) {
          if (!isHostRunnerEnvNameAllowed(name)) return { code: 1, stdout: "", stderr: `job_env_forbidden:${name}` };
        }
        const timeout = Math.max(1_000, Math.floor(timeoutMs));
        const res = await call(
          "POST", `/v1/jobs/${jobId}/exec`,
          { argv: [command, ...args], timeout_ms: timeout, ...(extraEnv && Object.keys(extraEnv).length > 0 ? { env: extraEnv } : {}) },
          timeout + slackMs
        );
        if (res.status === 409 && res.json["error"] === "job_terminated") {
          dead = true;
          return { code: 1, stdout: "", stderr: "job_container_terminated" };
        }
        if (res.status === 404 && res.json["error"] === "job_not_found") {
          dead = true;
          return { code: 1, stdout: "", stderr: "job_expired" };
        }
        if (res.status !== 200) HostJobSandboxRunner.fail(res);
        const code = res.json["code"];
        const stdout = res.json["stdout"];
        const stderr = res.json["stderr"];
        if (typeof code !== "number" || typeof stdout !== "string" || typeof stderr !== "string") throw new HostJobRunnerError("malformed_response", res.status);
        if (res.json["timed_out"] === true) dead = true; // runneren dreper HELE containeren ved tidsavbrudd (som DockerJobSandboxRunner)
        return { code, stdout, stderr };
      },

      async gitPublish(request: HostGitPublishRequest): Promise<HostGitPublishResult> {
        if (jobId === undefined || repoSlug === undefined) throw new Error("host_job_not_checked_out");
        // Et NYTT token rett før pushen: tokenet fra klonen er ikke gjenbrukt (kortlevd, aldri mellomlagret).
        const gitToken = await tokenFor(repoSlug);
        const res = await call("POST", `/v1/jobs/${jobId}/publish`, { branch: request.branch, ...(gitToken !== undefined ? { git_token: gitToken } : {}) }, 600_000);
        if (res.status !== 200) HostJobSandboxRunner.fail(res, gitToken);
        const j = res.json;
        if (typeof j["branch"] !== "string" || typeof j["commit_sha"] !== "string" || typeof j["base_sha"] !== "string" || typeof j["commits"] !== "number" || typeof j["files_changed"] !== "number") {
          throw new HostJobRunnerError("malformed_response", res.status);
        }
        return { branch: j["branch"], commitSha: j["commit_sha"], baseSha: j["base_sha"], commits: j["commits"], filesChanged: j["files_changed"] };
      },

      async dispose(): Promise<void> {
        const id = jobId;
        dead = true;
        jobId = undefined;
        if (id === undefined) return;
        try {
          await call("DELETE", `/v1/jobs/${id}`, undefined, 60_000);
        } catch {
          // best effort: runnerens TTL-rydder fjerner jobben uansett (D-32 port 11/12)
        }
      }
    };
    return sandbox;
  }
}

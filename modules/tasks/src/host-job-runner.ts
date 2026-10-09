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
 *  - git-credentialen finnes IKKE her. Klone og push skjer på verten med runnerens egen credential; worker henter aldri et
 *    git-token, sender aldri credential-env, og jobb-containeren ser aldri noe.
 *  - API-et er smalt: repo (slug), env, argv, branch. Klienten kan ikke sende docker-flagg, mounts, image, nettverk eller stier.
 *  - Alle feil lukkes: ugyldig konfig/utilgjengelig runner/avvist token gir en jobbfeil med stabil kode, aldri en stille fallback.
 *
 * Jobben opprettes først ved `gitCheckout` (runneren trenger repoet for å klone); `exec` før det kaster.
 */

const SOCKET_PATH = /^\/[A-Za-z0-9._/-]{1,100}$/;
const FILE_PATH = /^\/[A-Za-z0-9._/@+-]{1,198}$/;
const TOKEN_FORMAT = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const LABEL = /^[A-Za-z0-9._:-]{1,100}$/;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

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
}

interface RunnerResponse {
  status: number;
  json: Record<string, unknown>;
}

export class HostJobSandboxRunner implements SandboxRunner {
  readonly name = "host-job-runner";
  readonly hostGit = true;
  private readonly slackMs: number;

  constructor(private readonly options: HostJobRunnerOptions) {
    if (typeof options.socketPath !== "string" || !SOCKET_PATH.test(options.socketPath) || options.socketPath.includes("..") || options.socketPath.includes("//")) {
      throw new HostJobRunnerConfigError("socket_path_invalid");
    }
    if (options.readToken === undefined && (typeof options.tokenFile !== "string" || !FILE_PATH.test(options.tokenFile) || options.tokenFile.includes("..") || options.tokenFile.includes("//"))) {
      throw new HostJobRunnerConfigError("token_file_invalid");
    }
    this.slackMs = options.requestSlackMs ?? 30_000;
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

  /** HTTP-feil fra runneren -> typet feil. */
  private static fail(res: RunnerResponse): never {
    if (res.status === 401) throw new HostJobRunnerError("unauthorized", 401);
    const code = typeof res.json["error"] === "string" ? res.json["error"] : "unexpected_response";
    const detail = typeof res.json["detail"] === "string" ? res.json["detail"] : undefined;
    throw new HostJobRunnerError(code, res.status, detail);
  }

  async create(jobEnv: Record<string, string> = {}, meta?: SandboxMeta): Promise<Sandbox> {
    for (const name of Object.keys(jobEnv)) {
      // Samme regler som runneren håndhever - avvist FØR noe sendes (en jobb-env med git-credential/vault-nøkkel når aldri socketen).
      if (!isHostRunnerEnvNameAllowed(name)) throw new Error(`job_env_forbidden:${name}`);
    }
    const call = (method: "POST" | "DELETE", path: string, body: unknown, timeoutMs: number): Promise<RunnerResponse> => this.request(method, path, body, timeoutMs);
    const slackMs = this.slackMs;
    let jobId: string | undefined;
    let dead = false;

    const sandbox: Sandbox = {
      // Stien INNE I containeren (informativ - worker har ingen vertssti å bruke).
      workdir: "/work",

      async gitCheckout(request: HostGitCheckoutRequest): Promise<HostGitCheckoutResult> {
        if (jobId !== undefined) throw new Error("host_job_already_checked_out");
        const ref = parseGitHubRepoUrl(request.repoUrl); // kaster GitPolicyError ved alt annet enn eksakt https://github.com/<owner>/<repo>
        const body = {
          repo: ref.slug,
          env: jobEnv,
          ...(request.baseBranch !== undefined ? { base_branch: request.baseBranch } : {}),
          ...(meta?.task_id !== undefined && LABEL.test(meta.task_id) ? { task_id: meta.task_id } : {}),
          ...(meta?.tenant_id !== undefined && LABEL.test(meta.tenant_id) ? { tenant_id: meta.tenant_id } : {})
        };
        const res = await call("POST", "/v1/jobs", body, 600_000);
        if (res.status !== 201) HostJobSandboxRunner.fail(res);
        const id = res.json["job_id"];
        const headSha = res.json["head_sha"];
        const baseBranch = res.json["base_branch"];
        if (typeof id !== "string" || typeof headSha !== "string" || typeof baseBranch !== "string") throw new HostJobRunnerError("malformed_response", res.status);
        jobId = id;
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
        if (jobId === undefined) throw new Error("host_job_not_checked_out");
        const res = await call("POST", `/v1/jobs/${jobId}/publish`, { branch: request.branch }, 600_000);
        if (res.status !== 200) HostJobSandboxRunner.fail(res);
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

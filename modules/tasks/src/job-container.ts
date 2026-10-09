import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENV_NAME, FORBIDDEN_ENV, JobContainerConfigError, buildJobContainerCreateArgs, validateJobContainerPolicy, type JobContainerPolicy
} from "./job-container-spec.mjs";
import { HostJobRunnerConfigError, HostJobSandboxRunner } from "./host-job-runner.ts";
import { execProcess } from "./process-exec.ts";
import type { ExecResult, Sandbox, SandboxRunner } from "./sandbox.ts";

// WP-C1: flaggene (policy-validering + `docker create`-argv) bor i EN delt .mjs-fil, slik at worker-siden og den vertsside runneren
// (`ops/job-runner/`) aldri kan drive fra hverandre. Re-eksporteres uendret herfra (samme funksjonsobjekter).
export { JobContainerConfigError, buildJobContainerCreateArgs, validateJobContainerPolicy };
export type { JobContainerPolicy };

/**
 * Remediering del 2 (JARVIS-010): eksplisitt PER-JOBB CONTAINERGRENSESNITT for kodejobber.
 *
 * Tidligere kjørte `coding`-jobber i `ProcessSandboxRunner` - en `spawnSync` INNE i worker-containeren
 * (root, hele `.env`, DB-nettverk). Det er ingen grense. Denne filen definerer den ENESTE godkjente
 * veien: en egen, kortlevd container per jobb med
 *   - ikke-root bruker, read-only rootfs, `tmpfs` for /tmp og hjem, kun `/work` som skrivbar monteringsflate,
 *   - alle capabilities droppet, `no-new-privileges`, ressursgrenser (minne/CPU/PID),
 *   - nettverk KUN via et eksplisitt jobb-nettverk som bare når en allowlistet egress-proxy (ingen
 *     direkte rute til DB/vault/compose-nettverket),
 *   - INGEN arvede secrets: env er en eksplisitt liste; verdier sendes aldri i argv; vault-/DB-nøkler nektes,
 *   - kill av HELE prosessgruppen (container-PID-namespace) ved timeout og ved dispose.
 *
 * Finnes ikke en gyldig runner (`JARVIS_JOB_RUNNER=host|container` + gyldig konfig), er den ENESTE tilgjengelige
 * implementasjonen `FailClosedSandboxRunner`: jobben feiler med `job_container_runner_not_configured` -
 * den faller ALDRI tilbake til prosess-sandbox. Worker-containeren har ikke Docker-socket; veien som er bygget for dette er den
 * tilsynte vertstjenesten `ops/job-runner/` (WP-C1, `JARVIS_JOB_RUNNER=host`, se host-job-runner.ts og docs/runbooks/JOB_RUNNER.md).
 * `container`-modusen under krever docker i SAMME prosess og er ikke anbefalt.
 */

export interface DockerExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
/** D-394: kan være asynkron (produksjon) eller synkron (testdobler). */
export type DockerExec = (bin: string, args: string[], options: { env?: Record<string, string>; timeoutMs?: number }) => DockerExecResult | Promise<DockerExecResult>;

const defaultExec: DockerExec = async (bin, args, options) => {
  const r = await execProcess(bin, args, {
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
};

/**
 * Per-jobb container-runner. Implementerer det eksisterende `SandboxRunner`-grensesnittet slik at
 * `createCodingHandler` er uendret, men BARE med en container som oppfyller `JobContainerPolicy`.
 */
export class DockerJobSandboxRunner implements SandboxRunner {
  readonly name = "docker-job-container";

  constructor(
    private readonly policy: JobContainerPolicy,
    private readonly exec: DockerExec = defaultExec,
    private readonly hostEnv: Record<string, string | undefined> = process.env
  ) {
    validateJobContainerPolicy(policy);
  }

  async create(jobEnv: Record<string, string> = {}): Promise<Sandbox> {
    const bin = this.policy.dockerBin ?? "docker";
    const envNames = Object.keys(jobEnv);
    const workdir = await mkdtemp(join(tmpdir(), "jarvis-job-"));
    const containerName = `jarvis-job-${randomUUID()}`;
    const createArgs = buildJobContainerCreateArgs(this.policy, { containerName, workdir, envNames });
    // Verdiene leveres til `docker`-prosessens EGEN env og videresendes med `-e NAVN` - de står aldri i argv.
    const baseEnv: Record<string, string> = { PATH: this.hostEnv["PATH"] ?? "" };
    const createEnv = { ...baseEnv, ...jobEnv };
    const created = await this.exec(bin, createArgs, { env: createEnv, timeoutMs: 30_000 });
    if (created.status !== 0) {
      await rm(workdir, { recursive: true, force: true });
      throw new Error("job_container_create_failed");
    }
    const started = await this.exec(bin, ["start", containerName], { env: baseEnv, timeoutMs: 30_000 });
    if (started.status !== 0) {
      await this.exec(bin, ["rm", "-f", containerName], { env: baseEnv, timeoutMs: 30_000 });
      await rm(workdir, { recursive: true, force: true });
      throw new Error("job_container_start_failed");
    }
    let dead = false;
    const kill = async (): Promise<void> => {
      dead = true;
      // `rm -f` dreper HELE container-prosessgruppen (PID-namespace) - ikke bare `docker exec`-klienten.
      await this.exec(bin, ["rm", "-f", containerName], { env: baseEnv, timeoutMs: 30_000 });
    };
    return {
      workdir,
      exec: async (command: string, args: string[], timeoutMs = 60_000, extraEnv?: Record<string, string>): Promise<ExecResult> => {
        if (dead) {
          return { code: 1, stdout: "", stderr: "job_container_terminated" };
        }
        const extraNames = Object.keys(extraEnv ?? {});
        for (const name of extraNames) {
          if (!ENV_NAME.test(name) || FORBIDDEN_ENV.test(name)) {
            return { code: 1, stdout: "", stderr: `job_env_forbidden:${name}` };
          }
        }
        const execArgs = ["exec", "--workdir", "/work", ...extraNames.flatMap((n) => ["-e", n]), containerName, command, ...args];
        const result = await this.exec(bin, execArgs, { env: { ...baseEnv, ...(extraEnv ?? {}) }, timeoutMs });
        if (result.timedOut) {
          await kill();
          return { code: 124, stdout: result.stdout, stderr: `${result.stderr}\njob_exec_timeout` };
        }
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      },
      dispose: async (): Promise<void> => {
        if (!dead) await kill();
        await rm(workdir, { recursive: true, force: true });
      }
    };
  }
}

/** Den eneste tilgjengelige «runneren» når ingen gyldig container-runner er konfigurert: ALLE jobber feiler. */
export class FailClosedSandboxRunner implements SandboxRunner {
  readonly name = "fail-closed";
  constructor(readonly reason: string) {}

  async create(): Promise<Sandbox> {
    throw new Error(`job_container_runner_not_configured:${this.reason}`);
  }
}

/**
 * Velger kodejobb-runner fra miljøet. To godkjente veier, alt annet - inkludert det gamle `JARVIS_SANDBOX=process|docker` - gir
 * `FailClosedSandboxRunner`. Aldri en stille nedgradering.
 *
 *  - `JARVIS_JOB_RUNNER=host` (ANBEFALT, WP-C1): worker snakker med den vertsside runner-tjenesten (`ops/job-runner/`) over et Unix-socket
 *    (`JARVIS_JOB_RUNNER_SOCKET`) med bearer-token fra fil (`JARVIS_JOB_RUNNER_TOKEN_FILE`). Worker trenger INGEN Docker-socket, og
 *    git-credentialen forlater aldri vertstjenesten. Image/nettverk/proxy/grenser bestemmes av vertsadmins konfigfil - ikke av worker-env.
 *  - `JARVIS_JOB_RUNNER=container`: `DockerJobSandboxRunner` kjører `docker` i SAMME prosess og krever derfor en docker-klient + socket
 *    i worker-containeren (som bevisst ikke finnes). Beholdt uendret for tilfeller der worker kjøres direkte på en vert; IKKE anbefalt.
 *    Krever digest-pinnet `JARVIS_JOB_IMAGE`, `JARVIS_JOB_NETWORK` og `JARVIS_JOB_EGRESS_PROXY`.
 */
export function resolveJobSandboxRunner(env: Record<string, string | undefined> = process.env): SandboxRunner {
  const mode = env["JARVIS_JOB_RUNNER"];
  if (mode === "host") {
    try {
      return new HostJobSandboxRunner({
        socketPath: env["JARVIS_JOB_RUNNER_SOCKET"] ?? "",
        tokenFile: env["JARVIS_JOB_RUNNER_TOKEN_FILE"] ?? ""
      });
    } catch (err) {
      return new FailClosedSandboxRunner(err instanceof HostJobRunnerConfigError ? err.reason : "invalid_configuration");
    }
  }
  if (mode !== "container") {
    return new FailClosedSandboxRunner("JARVIS_JOB_RUNNER_not_container_or_host");
  }
  const policy: JobContainerPolicy = {
    image: env["JARVIS_JOB_IMAGE"] ?? "",
    network: env["JARVIS_JOB_NETWORK"] ?? "",
    egressProxyUrl: env["JARVIS_JOB_EGRESS_PROXY"] ?? "",
    ...(env["JARVIS_DOCKER_BIN"] ? { dockerBin: env["JARVIS_DOCKER_BIN"] } : {})
  };
  try {
    return new DockerJobSandboxRunner(policy);
  } catch (err) {
    return new FailClosedSandboxRunner(err instanceof JobContainerConfigError ? err.reason : "invalid_configuration");
  }
}

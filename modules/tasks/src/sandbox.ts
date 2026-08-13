import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Sandbox bak adapter (SECURITY_MODEL §5). Én sandbox per jobb: kastbar
 * arbeidskatalog og REN prosess-env (ingen arv av Jarvis-prosessens secrets;
 * kun eksplisitte jobbvariabler + PATH). Nettverksallowlist håndheves i
 * verktøylaget via jobbkontrakten; OS-/containernivå kommer med Docker.
 */
export interface SandboxRunner {
  readonly name: string;
  create(jobEnv?: Record<string, string>): Promise<Sandbox>;
}

export interface Sandbox {
  readonly workdir: string;
  exec(command: string, args: string[], timeoutMs?: number): ExecResult;
  dispose(): Promise<void>;
}

export class ProcessSandboxRunner implements SandboxRunner {
  readonly name = "process-sandbox";

  async create(jobEnv: Record<string, string> = {}): Promise<Sandbox> {
    const workdir = await mkdtemp(join(tmpdir(), "jarvis-job-"));
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "",
      // git trenger en identitet i sandboxen; aldri brukerens globale config:
      GIT_AUTHOR_NAME: "jarvis-worker",
      GIT_AUTHOR_EMAIL: "worker@jarvis.local",
      GIT_COMMITTER_NAME: "jarvis-worker",
      GIT_COMMITTER_EMAIL: "worker@jarvis.local",
      ...jobEnv
    };
    return {
      workdir,
      exec(command: string, args: string[], timeoutMs = 60_000): ExecResult {
        const result = spawnSync(command, args, {
          cwd: workdir,
          env, // ren env - ingen arvede secrets
          timeout: timeoutMs,
          encoding: "utf8",
          shell: false
        });
        return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      },
      async dispose(): Promise<void> {
        await rm(workdir, { recursive: true, force: true });
      }
    };
  }
}

/**
 * Docker-sandbox (D-32): kastbar container per exec med delt jobb-workspace.
 * Default-sikkerhet: non-root (node), --network none, minne-/PID-grenser,
 * ephemeral workspace (host-tmpdir montert KUN på /work), ingen Docker-socket,
 * ingen arvede Jarvis-secrets (env sendes aldri inn). Nettverk/secrets krever
 * eksplisitt konfig - default åpnes ikke.
 */
export class DockerSandboxRunner implements SandboxRunner {
  readonly name = "docker-sandbox";
  constructor(
    private readonly image = process.env["JARVIS_SANDBOX_IMAGE"] ?? "node:22-alpine",
    private readonly dockerBin = process.env["JARVIS_DOCKER_BIN"] ?? "docker"
  ) {}

  async create(_jobEnv: Record<string, string> = {}): Promise<Sandbox> {
    const workdir = await mkdtemp(join(tmpdir(), "jarvis-dockerjob-"));
    const { image, dockerBin } = this;
    return {
      workdir,
      exec(command: string, args: string[], timeoutMs = 60_000): ExecResult {
        const result = spawnSync(dockerBin, [
          "run", "--rm",
          "--network", "none",
          "--memory", "256m",
          "--pids-limit", "128",
          "-u", "node",
          "-v", `${workdir}:/work`,
          "-w", "/work",
          image, command, ...args
        ], { timeout: timeoutMs, encoding: "utf8", shell: false });
        return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      },
      async dispose(): Promise<void> {
        await rm(workdir, { recursive: true, force: true });
      }
    };
  }
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execProcess } from "./process-exec.ts";

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
  /**
   * WP-C1 (D-32 / Q-45a): `true` når runneren selv eier git-transporten på VERTSSIDEN (`gitCheckout`/`gitPublish` på `Sandbox`).
   * `createCodingHandler` henter da ALDRI noe git-token og sender aldri credential-env til sandboxen: credentialen bor kun hos
   * runner-tjenesten (`ops/job-runner/`) og går aldri inn i worker-prosessen eller jobb-containeren. Utelatt/false = uendret flyt.
   */
  readonly hostGit?: boolean;
  create(jobEnv?: Record<string, string>, meta?: SandboxMeta): Promise<Sandbox>;
}

/** WP-C1: sporbarhetsmerking (CLAUDE.md regel 4: alle handlinger merkes) som en vertsside runner setter på containeren og i loggen. Øvrige runnere ignorerer den. */
export interface SandboxMeta {
  task_id?: string;
  tenant_id?: string;
}

/** WP-C1: be den vertsside runneren om en fersk, credential-fri arbeidskopi (klonet på verten, montert som `/work` i containeren). */
export interface HostGitCheckoutRequest {
  /** Kanonisk `https://github.com/<owner>/<repo>.git`; allerede validert mot repo-allowlisten av `coding.ts`. Runneren validerer på nytt mot SIN egen allowlist. */
  repoUrl: string;
  baseBranch?: string;
}
export interface HostGitCheckoutResult {
  /** Commit-SHA arbeidskopien startet på (basen `publish` måler mot). */
  headSha: string;
  baseBranch: string;
}
/** WP-C1: be runneren publisere jobb-branchen (verifisert git-bundle -> ferskt bare-repo -> push med runnerens egen credential). */
export interface HostGitPublishRequest {
  branch: string;
}
export interface HostGitPublishResult {
  branch: string;
  /** SHA runneren faktisk verifiserte og pushet (autoritativ - ikke det agenten påstår). */
  commitSha: string;
  baseSha: string;
  commits: number;
  filesChanged: number;
}

export interface Sandbox {
  readonly workdir: string;
  /**
   * D-103 (Blokker B): valgfri `extraEnv` slås KUN sammen inn i DETTE ene
   * kallets prosess-env, ALDRI inn i sandboxens vedvarende `jobEnv` - lar
   * `coding.ts` gi `git clone`/`git push` en eksplisitt, kortlevd
   * transport-credential UTEN at den noensinne blir synlig for
   * `ClaudeCodeAgent`s egen `exec()`-kall (som fortsatt kun bruker
   * basis-`env`en fra `create()`).
   */
  /** D-394: kan være asynkron (kjører barneprosessen uten å blokkere event-loopen); synkrone testdobler støttes fortsatt. */
  exec(command: string, args: string[], timeoutMs?: number, extraEnv?: Record<string, string>): ExecResult | Promise<ExecResult>;
  dispose(): Promise<void>;
  /** WP-C1: KUN på runnere med `hostGit: true`. Klone skjer på verten (aldri i sandboxen), uten at noen credential når worker eller container. */
  gitCheckout?(request: HostGitCheckoutRequest): Promise<HostGitCheckoutResult>;
  /** WP-C1: KUN på runnere med `hostGit: true`. Se `HostGitPublishRequest`. */
  gitPublish?(request: HostGitPublishRequest): Promise<HostGitPublishResult>;
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
      async exec(command: string, args: string[], timeoutMs = 60_000, extraEnv?: Record<string, string>): Promise<ExecResult> {
        const result = await execProcess(command, args, {
          cwd: workdir,
          env: extraEnv ? { ...env, ...extraEnv } : env, // ren env - ingen arvede secrets
          timeoutMs
        });
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
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
      // D-103 HOST-FIX v2: `extraEnv` (Blokker B git-auth) kobles nå INN her -
      // en tidligere audit fant at denne var stille IKKE koblet inn, som
      // ville gjort autentiserte kodejobber URØKKELIG (ikke bare "usikre",
      // men FUNKSJONELT ute av stand til å autentisere) under
      // `JARVIS_SANDBOX=docker` (eksplisitt opt-in, IKKE produksjonsdefault -
      // `ProcessSandboxRunner` er fortsatt default). For hver `extraEnv`-
      // nøkkel legges `-e <NAVN>` (BARE navn, ALDRI `-e NAVN=VERDI`) til
      // `docker run`-argv - `docker`-CLI-en videresender da verdien fra SIN
      // EGEN prosess-env (satt eksplisitt under via `spawnSync`s `env`-
      // opsjon) inn i containeren. Verdien vises DERFOR ALDRI i selve
      // `docker run`-kommandolinjen/argv/prosesslisten (kun navnet gjør) -
      // samme "aldri i argv"-invariant som `ProcessSandboxRunner` allerede
      // overholder.
      async exec(command: string, args: string[], timeoutMs = 60_000, extraEnv?: Record<string, string>): Promise<ExecResult> {
        const envArgs = extraEnv ? Object.keys(extraEnv).flatMap((key) => ["-e", key]) : [];
        const result = await execProcess(dockerBin, [
          "run", "--rm",
          "--network", "none",
          "--memory", "256m",
          "--pids-limit", "128",
          "-u", "node",
          "-v", `${workdir}:/work`,
          "-w", "/work",
          ...envArgs,
          image, command, ...args
        ], {
          timeoutMs,
          // `docker`-CLI-prosessen selv trenger disse i SIN egen env for at
          // bare `-e <NAVN>`-formen (over) skal ha noe å videresende - dette
          // ER selve mekanismen (dokumentert `docker run --help`-oppførsel),
          // ikke en tilfeldig utvidelse. Fanger opp `process.env` som base
          // (docker selv trenger PATH osv. for å kjøre) + `extraEnv` over.
          env: extraEnv ? { ...process.env, ...extraEnv } : process.env
        });
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      },
      async dispose(): Promise<void> {
        await rm(workdir, { recursive: true, force: true });
      }
    };
  }
}

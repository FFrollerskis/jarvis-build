import { RunnerError } from "./errors.mjs";
import { scrubPaths } from "./log.mjs";
import { runProcess } from "./process.mjs";

/**
 * WP-C1: ALLE docker-kall går gjennom en injiserbar `DockerExec` (argv-liste -> `execFile`-lignende `spawn` uten shell).
 * Tester injiserer en fake; produksjon bruker `createDockerExec`. Ingen streng bygget av klientdata når noen gang en shell.
 *
 * @typedef {import("./process.mjs").ProcessResult} ProcessResult
 * @typedef {(args: string[], options?: {
 *   env?: Record<string, string>, timeoutMs?: number, maxOutputBytes?: number, cancel?: import("./errors.mjs").CancelToken
 * }) => Promise<ProcessResult>} DockerExec
 */

/**
 * @param {{ dockerBin: string, baseEnv: Record<string, string>, run?: typeof runProcess }} options
 * @returns {DockerExec}
 */
export function createDockerExec(options) {
  const run = options.run ?? runProcess;
  return (args, opts = {}) =>
    run(options.dockerBin, args, {
      // docker-CLI-en trenger kun PATH/HOME/DOCKER_*; verdier for `-e NAVN` videresendes fra DENNE prosessens env (aldri i argv).
      env: { ...options.baseEnv, ...(opts.env ?? {}) },
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxOutputBytes: opts.maxOutputBytes ?? 1024 * 1024,
      ...(opts.cancel ? { cancel: opts.cancel } : {})
    });
}

const CONTAINER_NAME = /^jarvis-job-[a-f0-9-]{36}$/;

/** Tynn, typet fasade over `docker` for akkurat de kallene runneren trenger - ingenting annet kan utføres. */
export class DockerClient {
  /** @param {{ exec: DockerExec, registry: import("./log.mjs").SecretRegistry, scrub?: ReadonlyArray<readonly [string, string]> }} options */
  constructor(options) {
    this.exec = options.exec;
    this.registry = options.registry;
    /** Interne stier som aldri skal stå i en feildetalj til klienten (f.eks. bind-mount-kilden i en docker-feilmelding). */
    this.scrub = options.scrub ?? [];
  }

  /** @param {ProcessResult} r */
  detail(r) {
    return scrubPaths(this.registry.redact(`${r.stderr.toString("utf8")} ${r.stdout.toString("utf8")}`.replace(/\s+/g, " ").trim()), this.scrub).slice(0, 200);
  }

  /** Daemon nåbar? Returnerer server-versjon. */
  async version() {
    const r = await this.exec(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
    if (r.status !== 0 || r.spawnError !== undefined) throw new RunnerError("docker_unavailable", 503, this.detail(r));
    return r.stdout.toString("utf8").trim();
  }

  /**
   * Jobbnettverket MÅ være `--internal` (ellers har containeren direkte rute ut og proxyen er bare en anbefaling).
   * Sjekkes ved oppstart og FØR hver jobb: en omkonfigurert nettverk gir lukket feil, aldri en jobb med åpent nett.
   * @param {string} name
   */
  async assertNetworkInternal(name) {
    const r = await this.exec(["network", "inspect", "--format", "{{.Internal}} {{.Driver}}", name], { timeoutMs: 15_000 });
    if (r.status !== 0) throw new RunnerError("job_network_missing", 503, this.detail(r));
    if (r.stdout.toString("utf8").trim() !== "true bridge") throw new RunnerError("job_network_not_internal", 503);
  }

  /**
   * @param {string[]} createArgs argv fra delt `buildJobContainerCreateArgs` (første element er `create`)
   * @param {Record<string, string>} env verdier for `-e NAVN` (leveres i docker-prosessens env)
   * @param {import("./errors.mjs").CancelToken} [cancel]
   */
  async create(createArgs, env, cancel) {
    const r = await this.exec(createArgs, { env, timeoutMs: 60_000, ...(cancel ? { cancel } : {}) });
    if (r.cancelled) throw new RunnerError("job_cancelled", 409);
    if (r.status !== 0) throw new RunnerError("container_create_failed", 502, this.detail(r));
  }

  /** @param {string} name @param {import("./errors.mjs").CancelToken} [cancel] */
  async start(name, cancel) {
    this.assertName(name);
    const r = await this.exec(["start", name], { timeoutMs: 60_000, ...(cancel ? { cancel } : {}) });
    if (r.cancelled) throw new RunnerError("job_cancelled", 409);
    if (r.status !== 0) throw new RunnerError("container_start_failed", 502, this.detail(r));
  }

  /**
   * `docker exec` i /work. Verdier for per-kall env ligger i docker-prosessens env; `-e NAVN` i argv har kun navn.
   * @param {string} name
   * @param {{ argv: string[], env: Record<string, string>, timeoutMs: number, maxOutputBytes: number, cancel?: import("./errors.mjs").CancelToken }} p
   */
  async execIn(name, p) {
    this.assertName(name);
    const envNames = Object.keys(p.env);
    const args = ["exec", "--workdir", "/work", ...envNames.flatMap((n) => ["-e", n]), name, ...p.argv];
    return this.exec(args, { env: p.env, timeoutMs: p.timeoutMs, maxOutputBytes: p.maxOutputBytes, ...(p.cancel ? { cancel: p.cancel } : {}) });
  }

  /**
   * `rm -f -v`: SIGKILL til HELE container-prosessgruppen (PID-namespace), ikke bare `docker exec`-klienten.
   * «No such container» regnes som suksess (idempotent opprydding).
   * @param {string} name
   * @returns {Promise<boolean>} true hvis containeren er borte
   */
  async remove(name) {
    this.assertName(name);
    const r = await this.exec(["rm", "-f", "-v", name], { timeoutMs: 60_000 });
    if (r.status === 0) return true;
    return /no such container/i.test(`${r.stderr.toString("utf8")}${r.stdout.toString("utf8")}`);
  }

  /** Alle containere merket `jarvis.role=job` (også stoppede) - til oppstartsavstemming. */
  async listJobContainers() {
    const r = await this.exec(["ps", "-a", "--no-trunc", "--filter", "label=jarvis.role=job", "--format", "{{.Names}}"], { timeoutMs: 30_000 });
    if (r.status !== 0) throw new RunnerError("docker_unavailable", 503, this.detail(r));
    // En avkortet liste er ikke «alle containere»: avstemmingen ville oversett jobb-containere. Feil lukket (samme prinsipp som `mustGit` i git.mjs, A-F2).
    if (r.truncated) throw new RunnerError("docker_output_truncated", 503);
    return r.stdout.toString("utf8").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  }

  /** Kun navn vi selv har laget kan sendes til `docker` (hindrer flagg-/argv-injeksjon via containernavn). */
  assertName(name) {
    if (!CONTAINER_NAME.test(name)) throw new RunnerError("container_name_invalid", 500);
  }
}

export { CONTAINER_NAME };

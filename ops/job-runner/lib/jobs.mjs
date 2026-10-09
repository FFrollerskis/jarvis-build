import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { assertWellFormedToken, TOKEN_SOURCE_TIMEOUT_MS } from "./credentials.mjs";
import { CancelToken, ConfigError, RunnerError } from "./errors.mjs";
import { ensurePrivateDir, forceRemoveTree } from "./fsutil.mjs";
import { UUID_V4 } from "./schemas.mjs";
import { buildJobContainerCreateArgs } from "./spec.mjs";

/**
 * WP-C1: jobbens livssyklus. En jobb = (runner-eid katalog, én container). Tilstand holdes KUN i minnet: etter krasj/omstart finnes
 * ingen jobb å gjenoppta, og oppstartsavstemmingen (D-32 port 12) fjerner alt en forrige kjøring etterlot seg.
 *
 *   <base_dir>/<uuid>/            0700, runner-eid
 *       work/                     bind-montert som /work i containeren (EN SKRIVBAR flate agenten har)
 *       private/                  ALDRI montert: base.git (credential-hentet), verify.git, out.bundle
 *
 * Invarianter:
 *  - ingen sti eller flagg kommer fra klienten (jobb-id er serverutstedt; alt docker-argv bygges av den delte `buildJobContainerCreateArgs`),
 *  - maks samtidige jobber reserveres SYNKRONT før første `await` (ingen kappløp om siste plass),
 *  - DELETE dreper containeren umiddelbart (også midt i en `exec`), deretter fjernes katalogen uten å følge symlenker,
 *  - klient som forsvinner midt i opprettelse/exec/publish avbryter og rydder (ingen foreldreløse jobber),
 *  - rydding som feiler holder jobben (og plassen) til neste sweep - aldri en stille lekkasje.
 */

/** @typedef {"creating" | "ready" | "terminated" | "closing" | "cleanup_pending"} JobState */

export class JobManager {
  /**
   * @param {{
   *   config: ReturnType<typeof import("./config.mjs").validateConfig>["runner"],
   *   docker: import("./docker.mjs").DockerClient,
   *   git: import("./git.mjs").HostGit,
   *   credentials: import("./credentials.mjs").GitCredentialSource,
   *   logger: ReturnType<typeof import("./log.mjs").createLogger>,
   *   now?: () => number,
   *   randomId?: () => string,
   *   tokenTimeoutMs?: number
   * }} options
   */
  constructor(options) {
    if (!options.config) throw new ConfigError("runner_config_missing");
    this.config = options.config;
    this.docker = options.docker;
    this.git = options.git;
    this.credentials = options.credentials;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.randomId = options.randomId ?? randomUUID;
    this.tokenTimeoutMs = options.tokenTimeoutMs ?? TOKEN_SOURCE_TIMEOUT_MS;
    /** @type {Map<string, any>} */
    this.jobs = new Map();
    this.shuttingDown = false;
  }

  get activeJobs() {
    return this.jobs.size;
  }

  /**
   * Henter et git-token fra kilden FOR ÉN operasjon (klone eller push) - aldri mellomlagret, slik at kortlevde installasjonstokens (WP-C3) alltid er
   * ferske. Grensen mot kilden er fail-closed: en kilde som kaster noe annet enn RunnerError (nettverksfeil, bug, kompromittert), henger lenger enn
   * tidsgrensen, eller returnerer noe annet enn et velformet token gir `git_credential_unavailable` - uten å gjengi kildens feilmelding (kan inneholde
   * hemmeligheter) og uten at tokenet noen gang når git/loggen.
   * @param {string} slug
   * @returns {Promise<string>}
   */
  async obtainToken(slug) {
    /** @type {Promise<string>} */
    const pending = Promise.resolve().then(() => this.credentials.tokenFor(slug));
    pending.catch(() => undefined); // en kilde som feiler ETTER tidsgrensen skal aldri bli en ubehandlet rejection
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new RunnerError("git_credential_unavailable", 504, "source_timeout")), this.tokenTimeoutMs);
    });
    try {
      return assertWellFormedToken(await Promise.race([pending, timeout]));
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      this.logger.warn("git_credential_source_failed", { repo: slug, error_name: error instanceof Error ? error.name : "unknown" });
      throw new RunnerError("git_credential_unavailable", 502, "source_failed");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Oppstart: runner-eide kataloger (0700) + avstemming av alt en forrige kjøring etterlot. */
  async prepare() {
    const base = this.config.baseDir;
    await ensurePrivateDir(base);
    await ensurePrivateDir(join(base, ".runner"));
    await ensurePrivateDir(join(base, ".runner", "home"));
    await ensurePrivateDir(join(base, ".runner", "template"));
  }

  /**
   * D-32 port 12: fjern ALLE containere merket `jarvis.role=job` og ALLE jobbkataloger (UUID-navn) fra en krasjet/avsluttet kjøring.
   * Ukjente oppføringer i base_dir røres ikke (kun UUID-formede navn slettes) - vi sletter aldri noe vi ikke selv har laget.
   */
  async reconcile() {
    const names = await this.docker.listJobContainers();
    let containers = 0;
    for (const name of names) {
      if (!/^jarvis-job-[a-f0-9-]{36}$/.test(name)) {
        this.logger.warn("reconcile_foreign_container_ignored", { reason: "name_does_not_match" });
        continue;
      }
      if (await this.docker.remove(name)) containers += 1;
      else this.logger.error("reconcile_container_remove_failed", { container: name });
    }
    let dirs = 0;
    for (const entry of await readdir(this.config.baseDir)) {
      if (entry === ".runner") continue;
      if (!UUID_V4.test(entry)) {
        this.logger.warn("reconcile_unknown_entry_ignored", { entry: entry.slice(0, 60) });
        continue;
      }
      try {
        await forceRemoveTree(join(this.config.baseDir, entry));
        dirs += 1;
      } catch (error) {
        this.logger.error("reconcile_dir_remove_failed", { entry, reason: error instanceof Error ? error.message : "unknown" });
      }
    }
    this.logger.info("reconcile_done", { containers_removed: containers, dirs_removed: dirs });
    return { containers, dirs };
  }

  /**
   * @param {{ repo: string, baseBranch?: string, env: Record<string, string>, taskId?: string, tenantId?: string }} req
   * @param {CancelToken} [clientGone] avbrytes når klienten kobler fra før svaret er sendt
   */
  async create(req, clientGone) {
    if (this.shuttingDown) throw new RunnerError("shutting_down", 503);
    // Plass reserveres SYNKRONT (før første await): to samtidige POST kan aldri begge ta siste plass.
    if (this.jobs.size >= this.config.maxConcurrentJobs) throw new RunnerError("too_many_jobs", 429);
    const id = this.randomId();
    const dir = join(this.config.baseDir, id);
    const job = {
      id, dir, workDir: join(dir, "work"), privateDir: join(dir, "private"), baseGitDir: join(dir, "private", "base.git"),
      verifyDir: join(dir, "private", "verify.git"), containerName: `jarvis-job-${id}`,
      slug: req.repo, baseBranch: "", baseSha: "", taskId: req.taskId, tenantId: req.tenantId,
      createdAtMs: this.now(), expiresAtMs: this.now() + this.config.maxJobLifetimeS * 1000,
      /** @type {JobState} */ state: "creating",
      /** @type {null | "exec" | "publish"} */ busy: null,
      cancel: new CancelToken(),
      /** @type {Promise<unknown> | null} */ inflight: null,
      secretValues: Object.values(req.env)
    };
    this.jobs.set(id, job);
    for (const value of job.secretValues) this.logger.registry.add(value);
    const unsubscribe = clientGone ? clientGone.onCancel(() => job.cancel.cancel()) : () => undefined;
    try {
      await this.docker.assertNetworkInternal(this.config.policy.network);
      await mkdir(job.dir, { mode: 0o700 });
      await mkdir(job.privateDir, { mode: 0o700 });
      const token = await this.obtainToken(req.repo);
      const fetched = await this.git.fetchBase({
        slug: req.repo, ...(req.baseBranch !== undefined ? { baseBranch: req.baseBranch } : {}), depth: this.config.cloneDepth,
        baseGitDir: job.baseGitDir, token, timeoutMs: this.config.cloneTimeoutMs, cancel: job.cancel
      });
      job.baseBranch = fetched.branch;
      job.baseSha = fetched.baseSha;
      await this.git.createWorkCheckout({
        baseGitDir: job.baseGitDir, workDir: job.workDir, branch: fetched.branch, cwd: job.privateDir,
        timeoutMs: this.config.cloneTimeoutMs, cancel: job.cancel
      });
      if (job.cancel.cancelled) throw new RunnerError("job_cancelled", 409);

      const identity = this.config.gitIdentity;
      const createArgs = buildJobContainerCreateArgs(this.config.policy, {
        containerName: job.containerName, workdir: job.workDir, envNames: Object.keys(req.env),
        fixedEnv: {
          GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
          GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email
        },
        ...(req.taskId !== undefined ? { taskId: req.taskId } : {})
      });
      await this.docker.create(createArgs, req.env, job.cancel);
      await this.docker.start(job.containerName, job.cancel);
      if (job.cancel.cancelled) throw new RunnerError("job_cancelled", 409);
      job.state = "ready";
      job.expiresAtMs = this.now() + this.config.maxJobLifetimeS * 1000;
      this.logger.info("job_created", { job_id: id, repo: req.repo, base_branch: fetched.branch, task_id: req.taskId, tenant_id: req.tenantId, var_count: Object.keys(req.env).length });
      return {
        job_id: id, workdir: "/work", head_sha: job.baseSha, base_branch: job.baseBranch,
        expires_at: new Date(job.expiresAtMs).toISOString()
      };
    } catch (error) {
      this.logger.warn("job_create_failed", { job_id: id, reason: error instanceof RunnerError ? error.code : "internal_error" });
      await this.destroy(job, "create_failed");
      throw error;
    } finally {
      unsubscribe();
    }
  }

  /** @param {string} id */
  require(id) {
    const job = this.jobs.get(id);
    if (!job) throw new RunnerError("job_not_found", 404);
    return job;
  }

  /**
   * @param {string} id
   * @param {{ argv: string[], timeoutMs: number, env: Record<string, string> }} req
   * @param {CancelToken} [clientGone]
   */
  async exec(id, req, clientGone) {
    const job = this.require(id);
    this.assertUsable(job);
    for (const value of Object.values(req.env)) {
      this.logger.registry.add(value);
      job.secretValues.push(value);
    }
    return this.runExclusive(job, "exec", clientGone, async () => {
      const result = await this.docker.execIn(job.containerName, {
        argv: req.argv, env: req.env, timeoutMs: req.timeoutMs, maxOutputBytes: this.config.maxOutputBytes, cancel: job.cancel
      });
      if (result.cancelled && (job.state === "closing" || job.cancel.cancelled)) throw new RunnerError("job_cancelled", 409);
      const redact = (/** @type {Buffer} */ buf) => this.logger.registry.redact(buf.toString("utf8"));
      let stderr = redact(result.stderr);
      if (result.truncated) stderr = `${stderr}\n[output_truncated]`;
      if (result.timedOut) {
        // `docker exec`-klienten er drept, men prosessene i containeren lever: drep HELE containeren (som eksisterende DockerJobSandboxRunner).
        await this.killContainer(job);
        return { code: 124, stdout: redact(result.stdout), stderr: `${stderr}\njob_exec_timeout`, truncated: result.truncated, timed_out: true };
      }
      return { code: result.status ?? 137, stdout: redact(result.stdout), stderr, truncated: result.truncated, timed_out: false };
    });
  }

  /**
   * Publiser jobb-branchen: bundle LAGET I containeren (uten credential) -> verifisert på verten -> push med runnerens credential.
   * @param {string} id
   * @param {{ branch: string }} req
   * @param {CancelToken} [clientGone]
   */
  async publish(id, req, clientGone) {
    const job = this.require(id);
    this.assertUsable(job);
    return this.runExclusive(job, "publish", clientGone, async () => {
      const limits = this.config.publish;
      const created = await this.docker.execIn(job.containerName, {
        argv: [
          "git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "core.fsmonitor=false",
          "bundle", "create", "-", `${job.baseSha}..HEAD`
        ],
        env: {}, timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxBundleBytes + 1, cancel: job.cancel
      });
      if (created.cancelled) throw new RunnerError("job_cancelled", 409);
      if (created.timedOut) {
        await this.killContainer(job);
        throw new RunnerError("bundle_timeout", 504);
      }
      if (created.truncated || created.stdout.length > limits.maxBundleBytes) throw new RunnerError("bundle_too_large", 422, `max=${limits.maxBundleBytes}`);
      if (created.status !== 0) {
        const stderr = created.stderr.toString("utf8");
        if (/empty bundle/i.test(stderr)) throw new RunnerError("no_changes", 422, "no_commits_beyond_the_base");
        throw new RunnerError("bundle_create_failed", 422, this.logger.registry.redact(stderr.replace(/\s+/g, " ").trim()).slice(0, 160));
      }
      const token = await this.obtainToken(job.slug);
      try {
        const out = await this.git.verifyAndPush({
          bundle: created.stdout, baseSha: job.baseSha, baseGitDir: job.baseGitDir, verifyDir: job.verifyDir, privateDir: job.privateDir,
          slug: job.slug, branch: req.branch,
          limits: { maxCommits: limits.maxCommits, maxFiles: limits.maxFiles, denyPaths: limits.denyPaths },
          timeoutMs: limits.timeoutMs, token, cancel: job.cancel
        });
        this.logger.info("job_published", { job_id: job.id, repo: job.slug, branch: req.branch, commits: out.commits, files_changed: out.filesChanged, task_id: job.taskId });
        return { branch: req.branch, commit_sha: out.commitSha, base_sha: out.baseSha, commits: out.commits, files_changed: out.filesChanged };
      } finally {
        await forceRemoveTree(job.verifyDir).catch(() => undefined);
        await forceRemoveTree(join(job.privateDir, "out.bundle")).catch(() => undefined);
      }
    });
  }

  /**
   * Idempotent: ukjent/allerede fjernet jobb gir `{ deleted: false, state: "gone" }` (ingen feil - klienten kan trygt kalle to ganger).
   * @param {string} id
   */
  async delete(id) {
    const job = this.jobs.get(id);
    if (!job) return { deleted: false, state: "gone" };
    await this.destroy(job, "deleted");
    // Rydding som feilet (f.eks. docker henger) holder jobben som `cleanup_pending` til neste sweep - si det som det er.
    if (this.jobs.has(id)) return { deleted: false, state: "cleanup_pending" };
    return { deleted: true, state: "gone" };
  }

  /** Fjerner jobber som har passert maks levetid, og forsøker igjen på rydding som feilet. */
  async sweep() {
    const now = this.now();
    for (const job of [...this.jobs.values()]) {
      if (job.state === "closing" || job.state === "creating") continue;
      if (job.state === "cleanup_pending" || now >= job.expiresAtMs) await this.destroy(job, job.state === "cleanup_pending" ? "cleanup_retry" : "expired");
    }
  }

  /** Stopp nye jobber og fjern alle eksisterende (containere + kataloger). */
  async shutdown() {
    this.shuttingDown = true;
    for (const job of [...this.jobs.values()]) await this.destroy(job, "shutdown");
  }

  /** @param {any} job */
  assertUsable(job) {
    if (this.shuttingDown) throw new RunnerError("shutting_down", 503);
    if (job.state === "terminated") throw new RunnerError("job_terminated", 409);
    if (job.state !== "ready") throw new RunnerError("job_not_ready", 409, job.state);
    if (job.busy !== null) throw new RunnerError("job_busy", 409, job.busy);
  }

  /**
   * Kjører `fn` som jobbens eneste pågående operasjon. Klient som kobler fra midt i operasjonen avbryter den OG dreper containeren
   * (ingen kjører lenger og ingen kan hente resultatet - den foreldreløse containeren ville ellers leve til TTL).
   * @param {any} job @param {"exec" | "publish"} kind @param {CancelToken | undefined} clientGone @param {() => Promise<any>} fn
   */
  async runExclusive(job, kind, clientGone, fn) {
    job.busy = kind;
    const unsubscribe = clientGone
      ? clientGone.onCancel(() => {
          this.logger.warn("client_gone_during_operation", { job_id: job.id, operation: kind });
          job.cancel.cancel();
          void this.killContainer(job);
        })
      : () => undefined;
    const run = fn();
    job.inflight = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      unsubscribe();
      job.busy = null;
      job.inflight = null;
    }
  }

  /** @param {any} job */
  async killContainer(job) {
    if (job.state === "ready" || job.state === "creating") job.state = "terminated";
    const gone = await this.docker.remove(job.containerName).catch(() => false);
    if (!gone) this.logger.error("container_remove_failed", { job_id: job.id });
    return gone;
  }

  /**
   * Fjerner jobben: kansellér pågående prosesser, drep containeren, vent (begrenset) på pågående operasjon, fjern katalogen.
   * Feiler noe, blir jobben stående som `cleanup_pending` (holder plassen) og forsøkes igjen av `sweep()`.
   * @param {any} job @param {string} reason
   */
  async destroy(job, reason) {
    if (job.destroying) return job.destroying;
    job.destroying = (async () => {
      job.state = "closing";
      job.cancel.cancel();
      const gone = await this.docker.remove(job.containerName).catch(() => false);
      if (job.inflight) {
        await Promise.race([job.inflight, new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
      }
      let removed = false;
      if (gone) {
        try {
          await forceRemoveTree(job.dir);
          removed = true;
        } catch (error) {
          this.logger.error("job_dir_remove_failed", { job_id: job.id, reason: error instanceof Error ? error.message : "unknown" });
        }
      } else {
        this.logger.error("job_container_remove_failed", { job_id: job.id });
      }
      if (removed) {
        this.jobs.delete(job.id);
        for (const value of job.secretValues) this.logger.registry.remove(value);
        this.logger.info("job_removed", { job_id: job.id, reason });
      } else {
        job.state = "cleanup_pending";
      }
    })().finally(() => {
      job.destroying = null;
    });
    return job.destroying;
  }
}

/** Nyttefunksjon for tester/diagnostikk: finnes katalogen fortsatt (uten å følge symlenker)? */
export async function dirExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

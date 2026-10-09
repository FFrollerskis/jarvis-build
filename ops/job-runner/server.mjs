#!/usr/bin/env node
import { chmod, chown, lstat, readFile, unlink } from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BearerToken, createApiServer } from "./lib/api.mjs";
import { loadConfigFile } from "./lib/config.mjs";
import { FileGitCredentialSource } from "./lib/credentials.mjs";
import { createDockerExec, DockerClient } from "./lib/docker.mjs";
import { ConfigError } from "./lib/errors.mjs";
import { readSecretFile } from "./lib/fsutil.mjs";
import { HostGit } from "./lib/git.mjs";
import { JobManager } from "./lib/jobs.mjs";
import { createLogger, SecretRegistry } from "./lib/log.mjs";

/**
 * WP-C1 (D-32 / Q-45a / Q-46 punkt 5): vertsside job-runner for kodejobber. Kjører PÅ VERTEN under tilsyn (systemd), aldri i en
 * container og aldri med Docker-socket i worker-containeren. Lytter KUN på et Unix-domene-socket (modus 0660, aldri TCP).
 *
 * Tillitsgrenser:
 *   worker  --(socket + bearer)-->  DENNE tjenesten  --(docker, argv uten shell)-->  jobb-container (ubetrodd agent)
 *   - policyen (image, nettverk, grenser, repoer, branch-prefiks) kommer fra vertsadmins konfigfil og kan IKKE overstyres via API-et,
 *   - git-credentialen bor KUN her og går aldri til worker eller container,
 *   - git kjøres aldri mot en katalog agenten kontrollerer (publish = bundle laget i containeren, verifisert i et ferskt bare-repo).
 *
 * `createRunnerService` tar testoverstyringer (`testOverrides`) som IKKE kan settes fra konfigfilen: remote (file://, lokal HTTP),
 * hopp over uid-sjekk, ikke-root-eide hemmelighetsfiler. Produksjonsstien (`main`) sender aldri noen av dem.
 */

const VERSION = "1.0.0";

/** Leser gruppe-id fra `/etc/group` (Node har ingen getgrnam). Tall brukes som de er. */
async function resolveGroupId(group) {
  if (/^[0-9]+$/.test(group)) return Number(group);
  const text = await readFile("/etc/group", "utf8");
  for (const line of text.split("\n")) {
    const [name, , gid] = line.split(":");
    if (name === group && /^[0-9]+$/.test(gid ?? "")) return Number(gid);
  }
  throw new ConfigError("socket_group_unknown", group);
}

/** Fjerner et gammelt socket HVIS ingen lytter på det; nekter å starte hvis en annen instans kjører eller stien er noe annet enn et socket. */
async function prepareSocketPath(path) {
  let st;
  try {
    st = await lstat(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return;
    throw error;
  }
  if (!st.isSocket()) throw new ConfigError("socket_path_occupied_by_non_socket");
  const alive = await new Promise((resolveAlive) => {
    const client = net.connect(path);
    client.once("connect", () => { client.destroy(); resolveAlive(true); });
    client.once("error", () => resolveAlive(false));
  });
  if (alive) throw new ConfigError("another_instance_is_listening");
  await unlink(path);
}

/**
 * @param {{
 *   config: NonNullable<Awaited<ReturnType<typeof loadConfigFile>>["runner"]>,
 *   logger?: ReturnType<typeof createLogger>,
 *   dockerExec?: import("./lib/docker.mjs").DockerExec,
 *   credentials?: import("./lib/credentials.mjs").GitCredentialSource,
 *   testOverrides?: {
 *     remote?: { protocol: "https" | "http", host: string, urlFor?: (slug: string) => string },
 *     allowFile?: boolean, skipUidCheck?: boolean, allowAnyOwner?: boolean,
 *     now?: () => number, randomId?: () => string, authFailureDelayMs?: number
 *   }
 * }} options
 */
export async function createRunnerService(options) {
  const { config } = options;
  const t = options.testOverrides ?? {};
  const registry = options.logger?.registry ?? new SecretRegistry();
  const logger = options.logger ?? createLogger({ registry });
  const homeDir = join(config.baseDir, ".runner", "home");
  const templateDir = join(config.baseDir, ".runner", "template");

  const dockerExec = options.dockerExec ?? createDockerExec({
    dockerBin: config.dockerBin,
    baseEnv: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: homeDir, DOCKER_CONFIG: homeDir, ...(config.dockerHost ? { DOCKER_HOST: config.dockerHost } : {}) }
  });
  const docker = new DockerClient({ exec: dockerExec, registry });
  const secretOptions = (/** @type {{ label?: string }} */ o) => ({ ...o, ...(t.allowAnyOwner === true ? { skipOwnerCheck: true } : {}) });
  const credentials = options.credentials ?? new FileGitCredentialSource({
    files: config.gitCredentials,
    readSecret: (path, o) => readSecretFile(path, secretOptions(o))
  });
  const git = new HostGit({
    gitBin: config.gitBin,
    nodePath: process.execPath,
    helperScript: fileURLToPath(new URL("./credential-helper.mjs", import.meta.url)),
    homeDir, templateDir,
    remote: t.remote ?? { protocol: "https", host: "github.com" },
    allowFile: t.allowFile === true,
    registry
  });
  const manager = new JobManager({
    config, docker, git, credentials, logger,
    ...(t.now ? { now: t.now } : {}), ...(t.randomId ? { randomId: t.randomId } : {})
  });

  /** @type {BearerToken | undefined} */
  let bearer;
  const loadToken = async () => {
    const token = await readSecretFile(config.tokenFile, secretOptions({ label: "token_file" }));
    registry.add(token);
    if (bearer) bearer.setToken(token);
    else bearer = new BearerToken(token);
  };

  /** @type {import("node:http").Server | undefined} */
  let server;
  /** @type {NodeJS.Timeout | undefined} */
  let sweeper;

  return {
    manager, logger, registry,
    get server() { return server; },

    /** Oppstartssjekker (fail-closed) + avstemming + lytt på socket. Kaster ConfigError/RunnerError hvis noe er galt: tjenesten starter ikke. */
    async start() {
      if (t.skipUidCheck !== true) {
        const [uid, gid] = config.policy.user.split(":").map(Number);
        if (process.getuid?.() !== uid || process.getgid?.() !== gid) {
          // Containeren kjører som policy.user og skriver i /work; runneren må kunne rydde filene (samme uid) uten root.
          throw new ConfigError("container_user_must_equal_service_uid", `${config.policy.user} vs ${process.getuid?.()}:${process.getgid?.()}`);
        }
      }
      const dockerVersion = await docker.version();
      const gitVersion = await git.assertVersion();
      await manager.prepare();
      await docker.assertNetworkInternal(config.policy.network);
      await loadToken();
      await manager.reconcile();

      await prepareSocketPath(config.socketPath);
      server = createApiServer({
        manager, bearer: /** @type {BearerToken} */ (bearer), logger,
        limits: {
          maxBodyBytes: config.maxBodyBytes, defaultExecTimeoutMs: config.defaultExecTimeoutMs, maxExecTimeoutMs: config.maxExecTimeoutMs,
          allowedRepos: config.allowedRepos, branchPrefix: config.branchPrefix
        },
        ...(t.authFailureDelayMs !== undefined ? { authFailureDelayMs: t.authFailureDelayMs } : {})
      });
      const previousUmask = process.umask(0o117); // socket opprettes 0660 fra første øyeblikk
      try {
        await new Promise((resolveListen, rejectListen) => {
          /** @type {import("node:http").Server} */ (server).once("error", rejectListen);
          /** @type {import("node:http").Server} */ (server).listen(config.socketPath, () => resolveListen(undefined));
        });
      } finally {
        process.umask(previousUmask);
      }
      await chmod(config.socketPath, 0o660);
      if (config.socketGroup !== undefined) await chown(config.socketPath, process.getuid?.() ?? 0, await resolveGroupId(config.socketGroup));
      sweeper = setInterval(() => void manager.sweep().catch((error) => logger.error("sweep_failed", { reason: error instanceof Error ? error.message : "unknown" })), config.sweepIntervalS * 1000);
      sweeper.unref();
      logger.info("runner_started", { version: VERSION, docker: dockerVersion, git: gitVersion, max_jobs: config.maxConcurrentJobs, repos: config.allowedRepos.length });
    },

    /** Roter token uten omstart (SIGHUP). */
    async reloadToken() {
      await loadToken();
      logger.info("token_reloaded", {});
    },

    async stop() {
      if (sweeper) clearInterval(sweeper);
      const s = server;
      server = undefined;
      if (s) {
        s.closeAllConnections?.();
        await new Promise((resolveClose) => s.close(() => resolveClose(undefined)));
      }
      await manager.shutdown();
      await unlink(config.socketPath).catch(() => undefined);
      logger.info("runner_stopped", {});
    }
  };
}

async function main() {
  const configPath = process.env["JARVIS_JOB_RUNNER_CONFIG"] ?? "/etc/jarvis/job-runner.json";
  const loaded = await loadConfigFile(configPath, { require: ["runner"] });
  const service = await createRunnerService({ config: /** @type {NonNullable<typeof loaded.runner>} */ (loaded.runner) });
  await service.start();
  let stopping = false;
  const shutdown = (/** @type {string} */ signal) => {
    if (stopping) return;
    stopping = true;
    service.logger.info("shutdown_requested", { signal });
    service.stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => void service.reloadToken().catch((error) => service.logger.error("token_reload_failed", { reason: error instanceof Error ? error.message : "unknown" })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Aldri stacktrace/innhold fra konfig: kun stabil kode. systemd viser dette i journalen og restarter (Restart=on-failure).
    console.error(JSON.stringify({ level: "error", component: "job-runner", event: "fatal", code: error?.code ?? "fatal", detail: String(error?.message ?? "").slice(0, 200) }));
    process.exit(1);
  });
}

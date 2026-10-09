import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../../lib/config.mjs";
import { createLogger, SecretRegistry } from "../../lib/log.mjs";
import { createRunnerService } from "../../server.mjs";
import { createFakeDocker } from "./fake-docker.mjs";

/**
 * Felles testrigg for vertstjenesten: ekte HTTP over Unix-socket, ekte `git` mot lokale bare-repoer (file://-remote, KUN via
 * `testOverrides`, som konfigfilen ikke kan sette), og en fake `docker`. Ingenting her berører nettverk eller ekte Docker.
 */

export const RUNNER_TOKEN = "runner-test-token-0123456789abcdefABCDEF";
export const GIT_TOKEN = "ghp_RunnerGitTokenNeverReal0123456789";
export const IMAGE_ID = `sha256:${"a".repeat(64)}`;

/** Ren git med tom config; kaster ved feil. */
export function gitSync(cwd, args, extraEnv = {}) {
  const r = spawnSync("git", args, {
    cwd, encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "seed", GIT_AUTHOR_EMAIL: "seed@test", GIT_COMMITTER_NAME: "seed", GIT_COMMITTER_EMAIL: "seed@test", ...extraEnv
    }
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} feilet: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Oppretter et bare «origin»-repo med N commits på `main`.
 * @param {string} dir tom katalog som skal bli det bare repoet
 * @param {{ commits?: number, files?: Record<string, string> }} [options]
 */
export async function createBareOrigin(dir, options = {}) {
  await mkdir(dir, { recursive: true });
  gitSync(dir, ["init", "--bare", "--quiet", "--initial-branch=main", "."]);
  const seed = await mkdtemp(join(tmpdir(), "jr-seed-"));
  gitSync(seed, ["init", "--quiet", "--initial-branch=main", "."]);
  const commits = options.commits ?? 3;
  for (let i = 1; i <= commits; i += 1) {
    const files = i === 1 ? { "README.md": "# seed\n", ...(options.files ?? {}) } : { [`f${i}.txt`]: `v${i}\n` };
    for (const [name, content] of Object.entries(files)) {
      await mkdir(join(seed, name, ".."), { recursive: true });
      await writeFile(join(seed, name), content);
    }
    gitSync(seed, ["add", "-A"]);
    gitSync(seed, ["commit", "--quiet", "-m", `c${i}`]);
  }
  gitSync(seed, ["push", "--quiet", dir, "main"]);
  return { dir, head: gitSync(dir, ["rev-parse", "main"]) };
}

/** @param {string} socketPath @param {{ method?: string, path?: string, token?: string | null, body?: unknown, rawBody?: string | Buffer, headers?: Record<string, string> }} req */
export function apiRequest(socketPath, req = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(req.headers ?? {}) };
    let payload;
    if (req.rawBody !== undefined) payload = Buffer.from(req.rawBody);
    else if (req.body !== undefined) payload = Buffer.from(JSON.stringify(req.body));
    if (req.token !== null && req.token !== undefined) headers["authorization"] = `Bearer ${req.token}`;
    if (payload !== undefined) {
      headers["content-length"] = String(payload.length);
      if (!("content-type" in headers)) headers["content-type"] = "application/json";
    }
    const request = http.request({ socketPath, method: req.method ?? "GET", path: req.path ?? "/v1/health", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

/**
 * @param {{
 *   runner?: Record<string, unknown>,
 *   remote?: { protocol: "https" | "http", host: string, urlFor?: (slug: string) => string },
 *   slugs?: string[],
 *   origins?: Record<string, { commits?: number, files?: Record<string, string> }>,
 *   now?: () => number,
 *   beforeStart?: (ctx: { root: string, baseDir: string, fake: ReturnType<typeof createFakeDocker> }) => Promise<void> | void,
 *   autoStart?: boolean
 * }} [options]
 */
export async function createHarness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "jr-"));
  const baseDir = join(root, "jobs");
  const socketPath = join(root, "runner.sock");
  const tokenFile = join(root, "token");
  await writeFile(tokenFile, `${RUNNER_TOKEN}\n`, { mode: 0o600 });
  const slugs = options.slugs ?? ["owner/repo"];
  /** @type {Record<string, { token_file: string }>} */
  const gitCredentials = {};
  /** @type {Record<string, { dir: string, head: string }>} */
  const origins = {};
  for (const slug of slugs) {
    const file = join(root, `git-token-${slug.replace("/", "__")}`);
    await writeFile(file, `${GIT_TOKEN}\n`, { mode: 0o600 });
    gitCredentials[slug] = { token_file: file };
    if (options.remote === undefined) {
      origins[slug] = await createBareOrigin(join(root, "remotes", `${slug.replace("/", "__")}.git`), options.origins?.[slug] ?? {});
    }
  }
  const validated = validateConfig({
    version: 1,
    runner: {
      socket_path: socketPath, token_file: tokenFile, base_dir: baseDir, image: IMAGE_ID, network: "jarvis-jobs",
      egress_proxy_url: "http://172.30.77.1:3128", allowed_repos: slugs, git_credentials: gitCredentials,
      sweep_interval_s: 600, ...(options.runner ?? {})
    }
  }, { require: ["runner"] });
  const fake = createFakeDocker();
  const remote = options.remote === undefined
    ? { protocol: /** @type {"https"} */ ("https"), host: "github.com", urlFor: (/** @type {string} */ slug) => `file://${join(root, "remotes", `${slug.replace("/", "__")}.git`)}` }
    : options.remote;
  /** @type {string[]} */
  const logLines = [];
  const registry = new SecretRegistry();
  const logger = createLogger({ registry, write: (line) => logLines.push(line) });
  const service = await createRunnerService({
    config: /** @type {NonNullable<typeof validated.runner>} */ (validated.runner),
    dockerExec: fake.exec,
    logger,
    testOverrides: {
      remote,
      allowFile: options.remote === undefined, skipUidCheck: true, allowAnyOwner: true, authFailureDelayMs: 0,
      ...(options.now ? { now: options.now } : {})
    }
  });
  if (options.beforeStart) await options.beforeStart({ root, baseDir, fake });
  if (options.autoStart !== false) await service.start();
  const api = (/** @type {Parameters<typeof apiRequest>[1]} */ req) => apiRequest(socketPath, { token: RUNNER_TOKEN, ...req });
  const createJob = async (body = {}) => {
    const r = await api({ method: "POST", path: "/v1/jobs", body: { repo: slugs[0], ...body } });
    if (r.status !== 201) throw new Error(`create feilet: ${r.status} ${r.text}`);
    return /** @type {{ job_id: string, workdir: string, head_sha: string, base_branch: string, expires_at: string }} */ (r.json);
  };
  const exec = (/** @type {string} */ id, /** @type {string[]} */ argv, /** @type {Record<string, unknown>} */ extra = {}) =>
    api({ method: "POST", path: `/v1/jobs/${id}/exec`, body: { argv, ...extra } });
  return {
    root, baseDir, socketPath, tokenFile, config: validated.runner, fake, service, origins, logLines, registry, api, createJob, exec,
    token: RUNNER_TOKEN, gitToken: GIT_TOKEN,
    async close() {
      await service.stop().catch(() => undefined);
    }
  };
}

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { validateConfig } from "../../lib/config.mjs";
import { createLogger, SecretRegistry } from "../../lib/log.mjs";
import { createRunnerService } from "../../server.mjs";
import { createFakeDocker } from "./fake-docker.mjs";
import { makeTempDir, removeTemp } from "./tmp.mjs";

/**
 * Felles testrigg for vertstjenesten: ekte HTTP over Unix-socket, ekte `git` mot lokale bare-repoer (file://-remote, KUN via
 * `testOverrides`, som konfigfilen ikke kan sette), og en fake `docker`. Ingenting her berører nettverk eller ekte Docker.
 */

export const RUNNER_TOKEN = "runner-test-token-0123456789abcdefABCDEF";
export const GIT_TOKEN = "ghp_RunnerGitTokenNeverReal0123456789";
export const IMAGE_ID = `sha256:${"a".repeat(64)}`;

/**
 * Syntetisk installasjonstoken-lignende verdi (INGEN ekte hemmelighet): `ghs_<APPID>_<header>.<nyttelast>.<signatur>`, nøyaktig `length` tegn.
 * Bygges ved kjøring (ingen lange litteraler i kildekoden). `seed` gir ulike verdier.
 * @param {number} [length]
 * @param {number} [seed]
 */
export function syntheticInstallationToken(length = 900, seed = 0) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const filler = (/** @type {number} */ n, /** @type {number} */ salt) => Array.from({ length: n }, (_, i) => alphabet[(i * 7 + salt + seed) % alphabet.length]).join("");
  const head = `ghs_${1234567 + seed}_${filler(36, 3)}.`;
  const payloadLength = Math.floor((length - head.length - 1) / 2);
  const signatureLength = length - head.length - payloadLength - 1;
  return `${head}${filler(payloadLength, 11)}.${filler(signatureLength, 29)}`;
}

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
  const seed = await makeTempDir("jr-seed-");
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
  await removeTemp(seed); // A-F9: seed-klonen trengs ikke etter pushen
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
 *   requestTokenSlugs?: string[],
 *   origins?: Record<string, { commits?: number, files?: Record<string, string> }>,
 *   now?: () => number,
 *   credentials?: import("../../lib/credentials.mjs").GitCredentialSource,
 *   dockerExec?: import("../../lib/docker.mjs").DockerExec,
 *   tokenTimeoutMs?: number,
 *   testOverrides?: Record<string, unknown>,
 *   beforeStart?: (ctx: { root: string, baseDir: string, fake: ReturnType<typeof createFakeDocker> }) => Promise<void> | void,
 *   autoStart?: boolean
 * }} [options]
 */
export async function createHarness(options = {}) {
  const root = await makeTempDir("jr-");
  const baseDir = join(root, "jobs");
  const socketPath = join(root, "runner.sock");
  const tokenFile = join(root, "token");
  await writeFile(tokenFile, `${RUNNER_TOKEN}\n`, { mode: 0o600 });
  const slugs = options.slugs ?? ["owner/repo"];
  /** @type {Record<string, { token_file: string } | { source: "request" }>} */
  const gitCredentials = {};
  /** @type {Record<string, { dir: string, head: string }>} */
  const origins = {};
  for (const slug of slugs) {
    if (options.requestTokenSlugs?.includes(slug)) {
      // `source: request`: ingen fil. Tokenet kommer i HVER klone-/publish-forespørsel fra worker (WP-C3).
      gitCredentials[slug] = { source: "request" };
    } else {
      const file = join(root, `git-token-${slug.replace("/", "__")}`);
      await writeFile(file, `${GIT_TOKEN}\n`, { mode: 0o600 });
      gitCredentials[slug] = { token_file: file };
    }
    if (options.remote === undefined) {
      origins[slug] = await createBareOrigin(join(root, "remotes", `${slug.replace("/", "__")}.git`), options.origins?.[slug] ?? {});
    }
  }
  const validated = validateConfig({
    version: 1,
    runner: {
      socket_path: socketPath, token_file: tokenFile, base_dir: baseDir, image: IMAGE_ID, network: "jarvis-jobs",
      egress_proxy_url: "http://172.30.77.1:3128", allowed_repos: slugs, git_credentials: gitCredentials,
      sweep_interval_s: 600,
      // Testene bruker noen ekstra, ufarlige navn; standarden i produksjon er KUN ANTHROPIC_API_KEY (testet eksplisitt i config.test.mjs og adversarial.test.mjs).
      env_allow: ["ANTHROPIC_API_KEY", "PER_CALL_SECRET", "CALL_VAR", "EXTRA_VAR", "MY_SETTING", "SOMETHING", "A", "CI", "TZ", "FOO"],
      ...(options.runner ?? {})
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
    dockerExec: options.dockerExec ?? fake.exec,
    logger,
    ...(options.credentials ? { credentials: options.credentials } : {}),
    testOverrides: {
      remote,
      allowFile: options.remote === undefined, skipUidCheck: true, allowAnyOwner: true, authFailureDelayMs: 0,
      ...(options.now ? { now: options.now } : {}),
      ...(options.tokenTimeoutMs ? { tokenTimeoutMs: options.tokenTimeoutMs } : {}),
      ...(options.testOverrides ?? {})
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
    /** Stopper tjenesten og rydder ALT testen laget (A-F9): jobbkataloger (også uryddelige trær), remote-repoer og fake-docker-hjemmet. */
    async close() {
      await service.stop().catch(() => undefined);
      fake.dispose();
      await removeTemp(root);
    }
  };
}

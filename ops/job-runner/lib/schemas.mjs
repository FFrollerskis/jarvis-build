import { RunnerError } from "./errors.mjs";
import { isHostRunnerEnvNameAllowed } from "./spec.mjs";

/**
 * WP-C1: STRENGE forespørselsskjema. Prinsipper (injeksjonsklasser vi eksplisitt stenger):
 *  - ukjente felt avvises (ikke ignoreres): et nytt/skjult felt kan aldri bli en bakdør,
 *  - API-et tar ALDRI imot docker-flagg, mounts, image, nettverk eller sti - kun repo-slug, branch, env og argv,
 *  - alle strenger har tegnsett og lengdegrenser; NUL og kontrolltegn avvises der de ikke har noe å gjøre,
 *  - jobb-id er serverutstedt UUID; klienten sender aldri en sti.
 */

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BASE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const LABEL = /^[A-Za-z0-9._:-]{1,100}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** @param {unknown} value @param {string[]} allowed @param {string[]} required */
function strictObject(value, allowed, required) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new RunnerError("invalid_request", 400, "body_must_be_a_json_object");
  }
  const obj = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new RunnerError("unknown_field", 400, key.slice(0, 40).replace(CONTROL, "?"));
  }
  for (const key of required) {
    if (!(key in obj)) throw new RunnerError("invalid_request", 400, `missing_${key}`);
  }
  return obj;
}

/** @param {unknown} value @param {string} field @param {number} maxEntries @param {number} maxValueBytes */
function parseEnv(value, field, maxEntries, maxValueBytes) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new RunnerError("invalid_request", 400, `${field}_must_be_an_object`);
  }
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (value));
  if (entries.length > maxEntries) throw new RunnerError("invalid_request", 400, `${field}_too_many_entries`);
  /** @type {Record<string, string>} */
  const out = Object.create(null);
  for (const [name, val] of entries) {
    if (!isHostRunnerEnvNameAllowed(name)) throw new RunnerError("env_name_forbidden", 400, name.slice(0, 60).replace(CONTROL, "?"));
    if (typeof val !== "string" || val.length > maxValueBytes || val.includes("\u0000")) {
      throw new RunnerError("invalid_request", 400, `${field}_value_invalid`);
    }
    out[name] = val;
  }
  return out;
}

/** @param {unknown} body @param {{ allowedRepos: readonly string[] }} policy */
export function parseCreateJob(body, policy) {
  const b = strictObject(body, ["repo", "base_branch", "env", "task_id", "tenant_id"], ["repo"]);
  const repoRaw = b["repo"];
  if (typeof repoRaw !== "string" || !SLUG.test(repoRaw) || repoRaw.endsWith(".") || repoRaw.split("/")[1]?.startsWith("-") || repoRaw.endsWith("/.") || repoRaw.endsWith("/..")) {
    throw new RunnerError("invalid_request", 400, "repo_must_be_owner_slash_repo");
  }
  const repo = repoRaw.toLowerCase();
  const repoName = repo.split("/")[1];
  if (repoName === "." || repoName === ".." || repoName === undefined) throw new RunnerError("invalid_request", 400, "repo_must_be_owner_slash_repo");
  if (!policy.allowedRepos.includes(repo)) throw new RunnerError("repo_not_allowed", 403);

  let baseBranch;
  if (b["base_branch"] !== undefined) {
    const bb = b["base_branch"];
    if (typeof bb !== "string" || !BASE_BRANCH.test(bb) || bb.includes("..") || bb.includes("//") || bb.endsWith("/") || bb.endsWith(".lock") || bb.endsWith(".") || bb.includes("@{")) {
      throw new RunnerError("invalid_request", 400, "base_branch_invalid");
    }
    baseBranch = bb;
  }
  for (const key of /** @type {const} */ (["task_id", "tenant_id"])) {
    const v = b[key];
    if (v !== undefined && (typeof v !== "string" || !LABEL.test(v))) throw new RunnerError("invalid_request", 400, `${key}_invalid`);
  }
  return {
    repo,
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    env: parseEnv(b["env"], "env", 32, 8192),
    ...(typeof b["task_id"] === "string" ? { taskId: b["task_id"] } : {}),
    ...(typeof b["tenant_id"] === "string" ? { tenantId: b["tenant_id"] } : {})
  };
}

/** @param {unknown} body @param {{ defaultExecTimeoutMs: number, maxExecTimeoutMs: number }} limits */
export function parseExec(body, limits) {
  const b = strictObject(body, ["argv", "timeout_ms", "env"], ["argv"]);
  const argv = b["argv"];
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64) throw new RunnerError("invalid_request", 400, "argv_must_have_1_to_64_entries");
  let total = 0;
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== "string" || arg.length > 8192 || arg.includes("\u0000")) throw new RunnerError("invalid_request", 400, "argv_entry_invalid");
    if (i === 0 && (arg.length === 0 || arg.length > 256 || arg.startsWith("-") || CONTROL.test(arg))) {
      throw new RunnerError("invalid_request", 400, "argv0_invalid");
    }
    total += Buffer.byteLength(arg);
    out.push(arg);
  }
  if (total > 65_536) throw new RunnerError("invalid_request", 400, "argv_too_large");
  let timeoutMs = limits.defaultExecTimeoutMs;
  if (b["timeout_ms"] !== undefined) {
    const t = b["timeout_ms"];
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1_000 || t > limits.maxExecTimeoutMs) throw new RunnerError("invalid_request", 400, "timeout_ms_out_of_range");
    timeoutMs = t;
  }
  return { argv: out, timeoutMs, env: parseEnv(b["env"], "env", 16, 8192) };
}

/** @param {unknown} body @param {{ branchPrefix: string }} policy */
export function parsePublish(body, policy) {
  const b = strictObject(body, ["branch"], ["branch"]);
  return { branch: assertJobBranch(b["branch"], policy.branchPrefix) };
}

/**
 * Jobb-branch: `<prefiks><id>` med trygt tegnsett (ingen `..`, `//`, `.lock`, ledende `-`, ingen ekstra `/`). Speiler
 * `assertJobBranch` i modules/tasks/src/git-policy.ts (som låser `jarvis/`), men prefikset er VERTSADMINS policy.
 * Prefikset ender alltid på `/`, så `main`/`master`/`production` er strukturelt umulige.
 *
 * @param {unknown} branch
 * @param {string} prefix
 */
export function assertJobBranch(branch, prefix) {
  if (typeof branch !== "string" || !branch.startsWith(prefix)) throw new RunnerError("branch_invalid", 400);
  const rest = branch.slice(prefix.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(rest) || branch.includes("..") || branch.endsWith(".lock") || branch.endsWith(".")) {
    throw new RunnerError("branch_invalid", 400);
  }
  return branch;
}

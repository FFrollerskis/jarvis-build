/**
 * Configuration loading for the worker and the supervisor.
 *
 * Config lives on the host (outside this repository) and may contain host paths.
 * It never contains credentials: all GitHub access goes through the `gh` CLI,
 * which manages its own stored auth. Nothing here reads or prints a token.
 *
 * D126 review blocker 7 (fail closed):
 *   - `claudeArgs` no longer falls back to `--dangerously-skip-permissions`.
 *     A permissive default silently undid the host's hardened permission setup
 *     every time the field was absent. The field is now REQUIRED and explicit,
 *     and a permission-bypass flag must additionally be acknowledged in the same
 *     file, so it can only ever be a deliberate, reviewable host decision.
 *   - every numeric setting is bounds-checked and must be finite. `Number(x)`
 *     previously turned a typo into NaN, which made timeouts and budgets behave
 *     as "never" or "always".
 *   - every path the worker writes to must be OUTSIDE the repository, asserted
 *     here rather than assumed, so scratch/state/logs can never re-dirty the
 *     worktree that the dirty guard protects.
 *   - the supervisor's `host` must equal this machine's actual hostname, not
 *     merely match whatever a control comment claims.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute, resolve, relative } from "node:path";
import { hostname as osHostname } from "node:os";

export const WORKER_VERSION = "2.1.0";

const REQUIRED_WORKER = ["repoOwner", "repoName", "controlIssue", "trustedAuthor", "repoPath", "claudeArgs"];
const REQUIRED_SUPERVISOR = ["repoOwner", "repoName", "controlIssue", "trustedAuthor", "workerTaskName", "host"];

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
export const TASK_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Flags that hand a child process a blanket permission bypass. Never defaulted,
 * never added implicitly, and only accepted with an explicit acknowledgement in
 * the same config file.
 */
export const PERMISSION_BYPASS_ARGS = Object.freeze([
  "--dangerously-skip-permissions",
  "--dangerously-allow-browser",
  "--no-permissions"
]);

function resolveUnder(root, value, fallback) {
  const v = value ?? fallback;
  return isAbsolute(v) ? v : join(root, v);
}

/** True when `child` is the same path as, or lives under, `parent`. */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function requireBoundedNumber(raw, key, { min, max, fallback }) {
  const value = raw[key] === undefined || raw[key] === null ? fallback : Number(raw[key]);
  if (!Number.isFinite(value)) {
    throw new Error(`config field ${key} must be a finite number (got ${JSON.stringify(raw[key])})`);
  }
  if (value < min || value > max) {
    throw new Error(`config field ${key} must be between ${min} and ${max} (got ${value})`);
  }
  return value;
}

function requireInteger(raw, key, { min, max }) {
  const value = Number(raw[key]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`config field ${key} must be an integer between ${min} and ${max} (got ${JSON.stringify(raw[key])})`);
  }
  return value;
}

function requirePattern(raw, key, pattern, description) {
  const value = raw[key];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`config field ${key} must be ${description} (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * Validate the argv handed to the Claude CLI.
 *
 * Explicit only. A permission-bypass flag is accepted ONLY when the same config
 * carries `acknowledgeDangerousClaudeArgs: true` - so the hardened host setup is
 * preserved by default and a bypass is always a recorded, reviewable choice.
 */
function hasControlChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function validateClaudeArgs(args, { acknowledgeDangerous = false } = {}) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error(
      "config field claudeArgs is required and must be a non-empty array of strings. " +
      "There is deliberately no default: an implicit default previously injected " +
      "--dangerously-skip-permissions and silently bypassed the host's permission setup."
    );
  }
  for (const arg of args) {
    if (typeof arg !== "string" || arg.length === 0) {
      throw new Error(`config field claudeArgs must contain only non-empty strings (got ${JSON.stringify(arg)})`);
    }
    if (hasControlChar(arg)) {
      throw new Error("config field claudeArgs must not contain control characters");
    }
  }
  const bypass = args.filter((a) => PERMISSION_BYPASS_ARGS.includes(a));
  if (bypass.length > 0 && acknowledgeDangerous !== true) {
    throw new Error(
      `claudeArgs contains a permission-bypass flag (${bypass.join(", ")}). ` +
      "Refusing to run with an unacknowledged bypass. If this host genuinely requires it, " +
      'set "acknowledgeDangerousClaudeArgs": true in the same config file so the decision is explicit and reviewable.'
    );
  }
  return { args: [...args], bypass };
}

/**
 * Assert that nothing the worker writes to can land inside the repository.
 * Returns the list of checked entries so a caller can report them.
 */
export function assertOutsideRepo(repoPath, entries) {
  const offending = [];
  for (const [key, value] of Object.entries(entries)) {
    if (!value) continue;
    if (isInside(repoPath, value)) offending.push(`${key}=${value}`);
  }
  if (offending.length > 0) {
    throw new Error(
      `these worker paths would write INSIDE the repository at ${repoPath}: ${offending.join(", ")}. ` +
      "Runtime state, scratch, logs and locks must live outside the repo, or the dirty guard can never stay clean."
    );
  }
  return true;
}

export function loadWorkerConfig(configPath, root) {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}. Copy config.example.json to config.json and edit it first.`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.json must contain a JSON object");
  }
  for (const key of REQUIRED_WORKER) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === "") {
      throw new Error(`config.json is missing required field: ${key}`);
    }
  }

  const repoOwner = requirePattern(raw, "repoOwner", OWNER_PATTERN, "a GitHub owner login");
  const repoName = requirePattern(raw, "repoName", REPO_PATTERN, "a GitHub repository name");
  const trustedAuthor = requirePattern(raw, "trustedAuthor", OWNER_PATTERN, "a GitHub login");
  const controlIssue = requireInteger(raw, "controlIssue", { min: 1, max: 10_000_000 });

  if (typeof raw.repoPath !== "string" || !isAbsolute(raw.repoPath)) {
    throw new Error(`config field repoPath must be an absolute path (got ${JSON.stringify(raw.repoPath)})`);
  }
  const repoPath = resolve(raw.repoPath);

  const { args: claudeArgs, bypass } = validateClaudeArgs(raw.claudeArgs, {
    acknowledgeDangerous: raw.acknowledgeDangerousClaudeArgs === true
  });

  const promptDelivery = raw.promptDelivery ?? "stdin";
  if (!["stdin", "argv"].includes(promptDelivery)) {
    throw new Error(`config field promptDelivery must be "stdin" or "argv" (got ${JSON.stringify(promptDelivery)})`);
  }

  const logDir = resolveUnder(root, raw.logDir, "logs");
  const scratchRoot = resolveUnder(root, raw.scratchRoot, "tmp");

  const cfg = {
    repoOwner,
    repoName,
    controlIssue,
    trustedAuthor,
    repoPath,

    claudeCommand: typeof raw.claudeCommand === "string" && raw.claudeCommand ? raw.claudeCommand : "claude",
    claudeArgs,
    claudeArgsAcknowledgedBypass: bypass,
    claudeTimeoutMinutes: requireBoundedNumber(raw, "claudeTimeoutMinutes", { min: 1, max: 600, fallback: 55 }),
    promptDelivery,

    logDir,
    healthFile: resolveUnder(root, raw.healthFile, join(logDir, "health.jsonl")),
    stateFile: resolveUnder(root, raw.stateFile, "state.json"),
    stateBackupFile: resolveUnder(root, raw.stateBackupFile, "state.json.bak"),
    lockFile: resolveUnder(root, raw.lockFile, ".worker.lock"),
    disabledFlagFile: resolveUnder(root, raw.disabledFlagFile, "disabled.flag"),
    // Status dedup lives in its own append-only journal so it never needs the
    // exclusive task-state lock (D126 blocker 2).
    postedStatusFile: resolveUnder(root, raw.postedStatusFile, join(logDir, "posted-status.jsonl")),

    scratchRoot,
    quarantineRoot: resolveUnder(root, raw.quarantineRoot, join(scratchRoot, "quarantine")),
    manifestFile: resolveUnder(root, raw.manifestFile, join(logDir, "quarantine-manifest.jsonl")),

    heartbeatSeconds: requireBoundedNumber(raw, "heartbeatSeconds", { min: 5, max: 3600, fallback: 60 }),
    heartbeatTimeoutMinutes: requireBoundedNumber(raw, "heartbeatTimeoutMinutes", { min: 1, max: 1440, fallback: 15 }),
    maxAttempts: requireBoundedNumber(raw, "maxAttempts", { min: 1, max: 50, fallback: 4 }),
    backoffBaseMinutes: requireBoundedNumber(raw, "backoffBaseMinutes", { min: 1, max: 1440, fallback: 10 }),
    backoffMaxHours: requireBoundedNumber(raw, "backoffMaxHours", { min: 1, max: 168, fallback: 6 }),
    statusRepeatHours: requireBoundedNumber(raw, "statusRepeatHours", { min: 0, max: 168, fallback: 6 }),
    malformedLockGraceSeconds: requireBoundedNumber(raw, "malformedLockGraceSeconds", { min: 5, max: 3600, fallback: 60 }),

    workerTaskName: raw.workerTaskName ?? "JarvisClaudeWorker"
  };

  if (!TASK_NAME_PATTERN.test(cfg.workerTaskName)) {
    throw new Error(`config field workerTaskName must match ${TASK_NAME_PATTERN} (got ${JSON.stringify(cfg.workerTaskName)})`);
  }
  if (cfg.heartbeatSeconds * 1000 >= cfg.heartbeatTimeoutMinutes * 60_000) {
    throw new Error(
      `heartbeatSeconds (${cfg.heartbeatSeconds}s) must be well below heartbeatTimeoutMinutes ` +
      `(${cfg.heartbeatTimeoutMinutes}min), or a healthy owner would classify itself as stale.`
    );
  }

  assertOutsideRepo(repoPath, {
    logDir: cfg.logDir,
    healthFile: cfg.healthFile,
    stateFile: cfg.stateFile,
    stateBackupFile: cfg.stateBackupFile,
    lockFile: cfg.lockFile,
    disabledFlagFile: cfg.disabledFlagFile,
    postedStatusFile: cfg.postedStatusFile,
    scratchRoot: cfg.scratchRoot,
    quarantineRoot: cfg.quarantineRoot,
    manifestFile: cfg.manifestFile
  });

  return cfg;
}

export function loadSupervisorConfig(configPath, root, { hostname = osHostname } = {}) {
  if (!existsSync(configPath)) {
    throw new Error(`Supervisor config not found: ${configPath}. Copy supervisor.config.example.json and edit it.`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`supervisor.config.json is not valid JSON: ${err.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("supervisor.config.json must contain a JSON object");
  }
  for (const key of REQUIRED_SUPERVISOR) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === "") {
      throw new Error(`supervisor.config.json is missing required field: ${key}`);
    }
  }

  const repoOwner = requirePattern(raw, "repoOwner", OWNER_PATTERN, "a GitHub owner login");
  const repoName = requirePattern(raw, "repoName", REPO_PATTERN, "a GitHub repository name");
  const trustedAuthor = requirePattern(raw, "trustedAuthor", OWNER_PATTERN, "a GitHub login");
  const controlIssue = requireInteger(raw, "controlIssue", { min: 1, max: 10_000_000 });
  const workerTaskName = requirePattern(raw, "workerTaskName", TASK_NAME_PATTERN, "a scheduled task name");
  const supervisorTaskName = raw.supervisorTaskName ?? "JarvisWorkerSupervisor";
  if (!TASK_NAME_PATTERN.test(supervisorTaskName)) {
    throw new Error(`config field supervisorTaskName must match ${TASK_NAME_PATTERN}`);
  }

  // ACTUAL host binding: a command that names this host must also be executing
  // ON this host. Config-to-comment equality alone proves nothing.
  const actualHost = hostname();
  if (typeof raw.host !== "string" || raw.host !== actualHost) {
    throw new Error(
      `supervisor.config.json binds host=${JSON.stringify(raw.host)} but this machine is ${JSON.stringify(actualHost)}. ` +
      "Refusing to run: a supervisor must only ever act on the host it is bound to."
    );
  }

  const logDir = resolveUnder(root, raw.logDir, "supervisor-logs");
  return {
    repoOwner,
    repoName,
    controlIssue,
    trustedAuthor,
    workerTaskName,
    supervisorTaskName,
    host: actualHost,

    // The supervisor observes the worker's own health journal and lock; it never
    // reads or writes the worker's task state.
    workerRoot: raw.workerRoot ?? root,
    workerHealthFile: resolveUnder(root, raw.workerHealthFile, join("logs", "health.jsonl")),
    workerLockFile: resolveUnder(root, raw.workerLockFile, ".worker.lock"),

    logDir,
    healthFile: resolveUnder(root, raw.supervisorHealthFile, join(logDir, "supervisor-health.jsonl")),
    stateFile: resolveUnder(root, raw.supervisorStateFile, "supervisor-state.json"),
    stateBackupFile: resolveUnder(root, raw.supervisorStateBackupFile, "supervisor-state.json.bak"),
    lockFile: resolveUnder(root, raw.supervisorLockFile, ".supervisor.lock"),
    disabledFlagFile: resolveUnder(root, raw.supervisorDisabledFlagFile, "supervisor-disabled.flag"),
    scratchRoot: resolveUnder(root, raw.scratchRoot, logDir),

    // A worker that has not polled the queue for this long, while the scheduled
    // task is supposedly enabled, is treated as a dead queue consumer.
    deadWorkerMinutes: requireBoundedNumber(raw, "deadWorkerMinutes", { min: 5, max: 1440, fallback: 30 }),
    restartBudgetPerDay: requireBoundedNumber(raw, "restartBudgetPerDay", { min: 1, max: 100, fallback: 4 }),
    backoffBaseMinutes: requireBoundedNumber(raw, "backoffBaseMinutes", { min: 1, max: 1440, fallback: 10 }),
    maxAttempts: requireBoundedNumber(raw, "maxAttempts", { min: 1, max: 50, fallback: 4 }),
    statusRepeatHours: requireBoundedNumber(raw, "statusRepeatHours", { min: 0, max: 168, fallback: 6 })
  };
}

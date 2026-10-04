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

// The accepted prompt-delivery modes are defined next to the gate that enforces
// them, so configuration and direct module calls can never drift apart.
import {
  PROMPT_DELIVERY_STDIN,
  SUPPORTED_PROMPT_DELIVERY,
  unsupportedPromptDeliveryReason
} from "./dispatch.mjs";

// D-166: the cross-worker admission root is derived next to the module that
// enforces it, so configuration and enforcement can never disagree about where
// two contending workers are supposed to meet.
import { admissionRootFor as defaultAdmissionRoot } from "./task-admission.mjs";

// D-158: the authorized-merge transition verifier no longer compares two API
// diff projections (D-157, which refused a valid merge of non-overlapping hunks
// in one file). It recomputes the merge of the two authorized commits with git
// and requires the recorded merge commit to be exactly that tree. That changes
// which merges a completion gate accepts, which reasons it can emit, and - for
// the first time in this gate - makes it run git locally, so a deployed worker's
// version must distinguish it.
//
// The REVIEW-FIX on the same PR (architect review 5216915623 on PR #84) is part
// of this same unreleased version rather than a further bump: 2.3.0 has never
// been deployed anywhere, so there is no deployment that could be distinguished
// FROM it, and inventing 2.4.0 for a draft correction would record a version
// that never ran. What 2.3.0 means is therefore the corrected behaviour: the
// merge is recomputed under a git configuration the worker isolates and
// validates, and content that requests a non-built-in merge driver fails closed.
//
// D-166 stays on 2.3.0 for exactly the same reason, and it is worth being explicit
// about it rather than letting the number drift silently: cross-worker task
// admission changes the worker's behaviour materially, but 2.3.0 has still never
// been deployed anywhere, so there is no running deployment that a 2.4.0 could be
// distinguished FROM. Inventing one would record a version that never ran. What
// 2.3.0 means is therefore the behaviour described here PLUS D-166: exactly one
// worker owns a TASK_ID across concurrent deployments, crashes and reboots. The
// number gets bumped by the first change made AFTER something ships.
export const WORKER_VERSION = "2.3.0";

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

/**
 * D-146: validate this host's optional post-merge evidence policy.
 *
 * Shape: `{ requiredChecks?: string[], extraChecksPolicy?: string, profile?: string }`.
 *
 * Only the SHAPE is checked here; whether the values are meaningful (a known
 * extra-checks policy, a known profile, a non-empty required set) is decided by
 * `resolvePostMergeEvidencePolicy` at gate time, where the trusted ARCHITECT_TASK
 * may still override them. Splitting it that way keeps exactly one place that
 * decides policy and exactly one place that decides whether JSON is well-formed.
 */
export function validatePostMergeEvidence(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config field postMergeEvidence must be a JSON object when present");
  }
  const out = {};
  if (raw.requiredChecks !== undefined) {
    if (!Array.isArray(raw.requiredChecks) || raw.requiredChecks.some((c) => typeof c !== "string")) {
      throw new Error("config field postMergeEvidence.requiredChecks must be an array of strings");
    }
    // An explicitly empty array is KEPT, not discarded: it is a deliberate
    // statement that this host declares no required checks, and the gate refuses
    // such a task rather than falling back to the repository default.
    out.requiredChecks = raw.requiredChecks.map((c) => c.trim());
  }
  for (const key of ["extraChecksPolicy", "profile"]) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string") {
      throw new Error(`config field postMergeEvidence.${key} must be a string`);
    }
    out[key] = raw[key];
  }
  return out;
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

  // D126 addendum item 4: `argv` is no longer an accepted mode. It handed the
  // complete task to the child on its command line at process-creation time, so
  // the child could begin executing before the durable-handoff gate had run.
  // `stdin` is the only mode where withholding the write genuinely withholds the
  // task. The same rejection is enforced inside `runClaude` for direct calls.
  const promptDelivery = raw.promptDelivery ?? PROMPT_DELIVERY_STDIN;
  if (!SUPPORTED_PROMPT_DELIVERY.includes(promptDelivery)) {
    throw new Error(`config field promptDelivery: ${unsupportedPromptDeliveryReason(promptDelivery)}`);
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
    // D-398 (JARVIS-099): taket er 110 min - den planlagte Windows-oppgaven (`install-task.ps1`, `-ExecutionTimeLimit 2 h`) dreper hele kjøringen ved 120 min, så en
    // lengre claude-timeout (tidligere opptil 600) kunne aldri nås og ville avsluttet jobben midt i en merge-overgang.
    claudeTimeoutMinutes: requireBoundedNumber(raw, "claudeTimeoutMinutes", { min: 1, max: 110, fallback: 55 }),
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

    // D-133: the root under which every task's ISOLATED linked git worktree
    // lives. It is asserted to be outside the repository for the same reason as
    // every other writable path - a task's uncommitted work must never be able
    // to appear in the primary checkout the dirty guard protects.
    //
    // The default is a SIBLING of `scratchRoot`, which is deliberate on both
    // counts:
    //
    //   - not `root`-relative, because `root` is the worker's own directory and
    //     on this host that lives inside the repository; a `root`-relative
    //     default would make `assertOutsideRepo` throw on every existing host
    //     config that had simply never heard of this field. A sibling of
    //     scratchRoot inherits its outside-the-repo guarantee (a directory's
    //     parent always contains it, so the parent of an outside path is also
    //     outside), and the assertion below still verifies it rather than
    //     trusting the reasoning.
    //   - not UNDER `scratchRoot`, because scratchRoot is handed to the child as
    //     TEMP/TMP/TMPDIR. A git worktree holding real uncommitted work has no
    //     business living somewhere a temp sweeper is entitled to delete.
    worktreeRoot: resolveUnder(root, raw.worktreeRoot, resolve(scratchRoot, "..", "worktrees")),

    // D-166: the SHARED root under which cross-worker task admission leases live.
    //
    // Deliberately NOT derived from `root`, `scratchRoot` or `worktreeRoot`. Every
    // one of those is a property of ONE deployment, and a lease that lives under a
    // deployment's own directory cannot serialise that deployment against another
    // one - which is exactly how two workers came to own D-165 at the same time.
    // Mutual exclusion only exists where two processes contend for ONE path, so the
    // default is derived from the control-plane identity the contenders necessarily
    // share (owner/repo/control issue) under a host location outside every checkout;
    // see `admissionRootFor`. A host may set `admissionRoot` explicitly, and two
    // workers that are meant to contend must then be given the SAME value.
    admissionRoot: typeof raw.admissionRoot === "string" && raw.admissionRoot !== ""
      ? resolve(raw.admissionRoot)
      : defaultAdmissionRoot({ repoOwner, repoName, controlIssue }),

    heartbeatSeconds: requireBoundedNumber(raw, "heartbeatSeconds", { min: 5, max: 3600, fallback: 60 }),
    heartbeatTimeoutMinutes: requireBoundedNumber(raw, "heartbeatTimeoutMinutes", { min: 1, max: 1440, fallback: 15 }),
    maxAttempts: requireBoundedNumber(raw, "maxAttempts", { min: 1, max: 50, fallback: 4 }),
    backoffBaseMinutes: requireBoundedNumber(raw, "backoffBaseMinutes", { min: 1, max: 1440, fallback: 10 }),
    backoffMaxHours: requireBoundedNumber(raw, "backoffMaxHours", { min: 1, max: 168, fallback: 6 }),
    statusRepeatHours: requireBoundedNumber(raw, "statusRepeatHours", { min: 0, max: 168, fallback: 6 }),
    malformedLockGraceSeconds: requireBoundedNumber(raw, "malformedLockGraceSeconds", { min: 5, max: 3600, fallback: 60 }),

    // D-146: this host's own post-merge evidence policy. Optional, and ABSENT is
    // not permissive - `resolvePostMergeEvidencePolicy` falls through to the
    // repository's real required CI jobs, and an explicitly EMPTY required set
    // fails the gate closed rather than accepting whatever check happens to be
    // green. Validated here rather than at gate time so a typo is a startup
    // error, not a surprise in the middle of a merge closeout.
    postMergeEvidence: validatePostMergeEvidence(raw.postMergeEvidence),

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
    manifestFile: cfg.manifestFile,
    worktreeRoot: cfg.worktreeRoot,
    admissionRoot: cfg.admissionRoot
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

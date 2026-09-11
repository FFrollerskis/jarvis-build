/**
 * Isolated per-task git worktrees and durable task-ownership claims (D-133).
 *
 * ------------------------------------------------------------------------
 * PR #80 REVIEW BLOCKER 2 - COMMIT SHAs ARE NOT A PROVENANCE MODEL.
 * ------------------------------------------------------------------------
 *
 * D132 taught the worker to remember `head_before` / `head_after` / every head a
 * task had been observed at, and to hand that to a resumed child. That closed
 * the COMMITTED half of the problem and left the other half wide open:
 *
 *   A dispatch that exits - or crashes - without a trusted report, having made
 *   LEGITIMATE UNCOMMITTED changes, leaves those changes as anonymous dirt in
 *   the shared checkout. Nothing records that they belong to a task. On the next
 *   run the strict dirty guard sees files it cannot attribute, blocks, and is
 *   completely right to do so - so the work is stranded, and the ONLY ways out
 *   are the two the architect forbids: claim arbitrary dirty files as task-owned
 *   (which would let real user work be overwritten), or stash/reset them away.
 *
 * That is not a bug in the guard. It is a missing structure: THERE WAS NO PLACE
 * FOR A TASK'S UNCOMMITTED WORK TO LIVE THAT WAS NOT ALSO THE USER'S WORKSPACE.
 *
 * The repair is isolation plus a claim, and the claim is written BEFORE the
 * mutation that it covers:
 *
 *   ISOLATION   every task gets its own linked git worktree, keyed by TASK_ID,
 *               OUTSIDE the primary checkout. The user's worktree is never
 *               written to by a task, so it cannot become dirty on a task's
 *               behalf, and task A's uncommitted state lives somewhere task B
 *               never looks. Two tasks can therefore be dirty at once without
 *               either blocking the other.
 *
 *   CLAIM       a durable JSON record - written and fsynced BEFORE `git worktree
 *               add` runs, and re-verified before the worktree is ever reused -
 *               binding the directory to the EXACT task id, the exact trusted
 *               control comment, the exact repository, the baseline commit, the
 *               branch/worktree path and the attempt identity.
 *
 * The direction of the binding is what makes it honest. Ownership is asserted
 * FORWARD, before anything is touched, and only ever CHECKED afterwards. It is
 * never inferred backwards from whatever dirt happens to be present - that
 * inference is precisely the unsafe move, because the evidence it would rely on
 * (a modified file) is equally consistent with the user's own work.
 *
 * Consequences, all of which are asserted by tests:
 *
 *   - dirty state inside a directory covered by a VALID claim for THIS task is
 *     task-owned by construction: the worktree was created empty at a known
 *     baseline and no other actor has ever been pointed at it;
 *   - dirty state anywhere else - the primary checkout, an unclaimed directory,
 *     a directory whose claim names a different task/repo/comment - is UNKNOWN
 *     and stays fail-closed. It is reported, never adopted, never modified;
 *   - a crash between "claim written" and "worktree created" is reconcilable,
 *     because the claim carries its own lifecycle state and the two steps are
 *     staged intent -> effect, not a single unverifiable leap;
 *   - cleanup happens only after a terminal, SUCCESSFUL reconciliation, only
 *     when the worktree is clean, and only through `git worktree remove` WITHOUT
 *     `--force`, so git itself refuses to destroy uncommitted work. The claim
 *     file is never deleted - it is marked released, so the evidence survives.
 *
 * Nothing here ever runs `git stash`, `git reset`, `git clean` or `git checkout
 * --`, and nothing deletes a file it did not create.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { isValidTaskId, writeFileDurable } from "./state.mjs";
import { atPath, gitStatusLines, gitHead, gitCurrentBranch, gitWorktreeList, gitWorktreeAdd, gitWorktreeRemove } from "./git.mjs";

export const CLAIM_SCHEMA_VERSION = 1;

/**
 * Claim lifecycle. `CREATING` is the staged INTENT: it exists on disk before the
 * worktree does, so a crash in the middle is a reconcilable state rather than an
 * orphan directory nobody can attribute.
 */
export const CLAIM_STATE = Object.freeze({
  CREATING: "creating",
  READY: "ready",
  RELEASED: "released"
});

/** What the worker found when it looked for a task's isolated context. */
export const WORKTREE_STATE = Object.freeze({
  /** No claim and no directory: a first attempt. Safe to create. */
  ABSENT: "absent",
  /** Valid claim for THIS task and a registered worktree. Safe to resume. */
  OWNED: "owned",
  /** A claim exists in state CREATING; the effect must be reconciled first. */
  INCOMPLETE: "incomplete_creation",
  /** A directory or claim exists that this task does NOT own. Fail closed. */
  FOREIGN: "foreign",
  /** Something is present but cannot be proven either way. Fail closed. */
  UNPROVEN: "unproven"
});

/** Where claims live: a sibling of the worktrees, never inside one. */
export function claimsDir(worktreeRoot) {
  return join(worktreeRoot, ".claims");
}

/**
 * The isolated worktree path for a task.
 *
 * `isValidTaskId` is enforced here rather than assumed, because the id becomes a
 * single path component. The same validation already guards the scratch dir; a
 * second call site is cheap and means no caller can reach the filesystem with an
 * unvalidated id.
 */
export function taskWorktreePath(worktreeRoot, taskId) {
  if (!isValidTaskId(taskId)) {
    throw new Error(`refusing to derive a worktree path from an unsafe TASK_ID: ${String(taskId).slice(0, 64)}`);
  }
  return join(worktreeRoot, taskId);
}

export function claimFilePath(worktreeRoot, taskId) {
  if (!isValidTaskId(taskId)) {
    throw new Error(`refusing to derive a claim path from an unsafe TASK_ID: ${String(taskId).slice(0, 64)}`);
  }
  return join(claimsDir(worktreeRoot), `${taskId}.json`);
}

/**
 * The identity a claim is bound to, derived from the TRUSTED task comment and
 * the configured repository - never from anything found on disk.
 *
 * This object is the whole reason ownership cannot be back-inferred: it is
 * computed from the control-plane truth for this dispatch, and the claim on disk
 * either matches it exactly or the directory is not ours.
 */
export function expectationFor({ cfg, taskId, comment, worktreeRoot }) {
  return {
    task_id: taskId,
    repo: `${cfg.repoOwner}/${cfg.repoName}`,
    repo_path: resolve(cfg.repoPath),
    control_issue: cfg.controlIssue,
    task_comment_id: comment?.id ?? null,
    worktree_path: resolve(taskWorktreePath(worktreeRoot, taskId))
  };
}

/** Build the durable claim document. `attemptId` is unique per dispatch attempt. */
export function buildClaim({
  expectation,
  baselineSha,
  baselineBranch,
  attempt,
  attemptId,
  workerVersion,
  taskCommentCreatedAt = null,
  taskCommentAuthor = null,
  now = () => new Date(),
  host = hostname,
  pid = process.pid
}) {
  const ts = now().toISOString();
  return {
    claim_schema_version: CLAIM_SCHEMA_VERSION,
    state: CLAIM_STATE.CREATING,

    // --- identity the claim is bound to (all exact, all from trusted input) ---
    task_id: expectation.task_id,
    repo: expectation.repo,
    repo_path: expectation.repo_path,
    control_issue: expectation.control_issue,
    task_comment_id: expectation.task_comment_id,
    task_comment_created_at: taskCommentCreatedAt,
    task_comment_author: taskCommentAuthor,
    worktree_path: expectation.worktree_path,

    // --- the baseline this task's work is measured against ---
    baseline_sha: baselineSha,
    baseline_branch: baselineBranch,

    // --- attempt identity, so two attempts are distinguishable in evidence ---
    first_attempt: attempt,
    first_attempt_id: attemptId,
    latest_attempt: attempt,
    latest_attempt_id: attemptId,
    attempts: [{ attempt, attempt_id: attemptId, started_at: ts, pid, host: host() }],

    created_at: ts,
    updated_at: ts,
    released_at: null,
    released_reason: null,
    worker_version: workerVersion ?? null,
    created_by_pid: pid,
    created_by_host: host()
  };
}

/** Read a claim. A missing file and an unreadable one are DIFFERENT answers. */
export function readClaim(file, { read = (p) => readFileSync(p, "utf8"), exists = existsSync } = {}) {
  if (!exists(file)) return { ok: false, missing: true, reason: "claim_missing" };
  let text;
  try {
    text = read(file);
  } catch (err) {
    return { ok: false, missing: false, reason: `claim_unreadable: ${err.code ?? err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, missing: false, reason: `claim_unparseable: ${err.message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, missing: false, reason: "claim_not_an_object" };
  }
  if (Number(parsed.claim_schema_version) !== CLAIM_SCHEMA_VERSION) {
    return { ok: false, missing: false, reason: `claim_schema_version_unsupported (${parsed.claim_schema_version})` };
  }
  if (!Object.values(CLAIM_STATE).includes(parsed.state)) {
    return { ok: false, missing: false, reason: `claim_state_unknown (${String(parsed.state).slice(0, 32)})` };
  }
  return { ok: true, claim: parsed };
}

export function writeClaim(file, claim) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileDurable(file, JSON.stringify(claim, null, 2));
  return claim;
}

/**
 * Does this claim bind this exact directory to this exact task?
 *
 * Every comparison is full string equality. There is deliberately no
 * normalisation, no prefix matching and no "close enough" - a claim that does
 * not match EXACTLY describes something else, and something else is never ours.
 */
export function verifyClaim(claim, expectation) {
  const mismatches = [];
  const check = (key, actual, wanted) => {
    if (actual !== wanted) mismatches.push(`${key}: claim=${JSON.stringify(actual)} expected=${JSON.stringify(wanted)}`);
  };
  check("task_id", claim?.task_id, expectation.task_id);
  check("repo", claim?.repo, expectation.repo);
  check("repo_path", claim?.repo_path, expectation.repo_path);
  check("control_issue", Number(claim?.control_issue), Number(expectation.control_issue));
  check("worktree_path", claim?.worktree_path, expectation.worktree_path);
  // The trusted comment that authorised the work. A re-used TASK_ID pointing at
  // a different comment is a different order and must not inherit the context.
  check("task_comment_id", claim?.task_comment_id ?? null, expectation.task_comment_id ?? null);
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Is the directory empty (or absent)? Used only to decide whether an
 * unclaimed path is safe to create a worktree in - never to decide ownership.
 */
function directoryIsEmpty(path, { exists = existsSync, list = readdirSync } = {}) {
  if (!exists(path)) return true;
  try {
    return list(path).length === 0;
  } catch {
    return false;
  }
}

/**
 * Classify a task's isolated context WITHOUT touching anything.
 *
 * Pure apart from the injected probes, so every branch is unit-testable and the
 * fail-closed cases can be asserted directly rather than inferred from a log.
 */
export function classifyTaskWorktree({
  expectation,
  claimRead,
  dirExists,
  dirEmpty,
  registeredPaths
}) {
  const path = expectation.worktree_path;
  const registered = registeredPaths === null
    ? null
    : registeredPaths.some((p) => resolve(p) === path);

  if (!claimRead.ok && claimRead.missing) {
    // No claim at all. Only an absent-or-empty, unregistered directory is safe.
    if (!dirExists || dirEmpty) {
      if (registered === true) {
        return {
          state: WORKTREE_STATE.UNPROVEN,
          reason: "git has a worktree registered at this path but no claim covers it"
        };
      }
      return { state: WORKTREE_STATE.ABSENT, reason: "no claim and no content at the task worktree path" };
    }
    return {
      state: WORKTREE_STATE.FOREIGN,
      reason: "the task worktree path already contains files but NO claim attributes them to this task"
    };
  }

  if (!claimRead.ok) {
    // A claim exists and is unusable. It is evidence; it is never overwritten.
    return { state: WORKTREE_STATE.UNPROVEN, reason: claimRead.reason };
  }

  const claim = claimRead.claim;
  const verdict = verifyClaim(claim, expectation);
  if (!verdict.ok) {
    return {
      state: WORKTREE_STATE.FOREIGN,
      reason: `a claim exists at this path but it does not belong to this task (${verdict.mismatches.join("; ")})`,
      claim
    };
  }

  if (claim.state === CLAIM_STATE.CREATING) {
    return { state: WORKTREE_STATE.INCOMPLETE, reason: "claim is staged as CREATING; the worktree effect must be reconciled", claim };
  }

  if (claim.state === CLAIM_STATE.RELEASED) {
    // Released and then re-needed: the directory must genuinely be gone before
    // a new context is created, otherwise we would be reusing stale content
    // under a claim that says the task was finished with.
    if (!dirExists || dirEmpty) {
      return { state: WORKTREE_STATE.ABSENT, reason: "previous context for this task was released and removed", claim };
    }
    return {
      state: WORKTREE_STATE.UNPROVEN,
      reason: "the claim says this context was RELEASED, but the directory still has content",
      claim
    };
  }

  // READY.
  if (!dirExists || dirEmpty) {
    return {
      state: WORKTREE_STATE.UNPROVEN,
      reason: "a READY claim exists for this task but its worktree directory is missing or empty; "
        + "task-owned work may have been removed outside the worker",
      claim
    };
  }
  if (registered === false) {
    return {
      state: WORKTREE_STATE.UNPROVEN,
      reason: "a READY claim and a directory exist, but git does not have a worktree registered at that path",
      claim
    };
  }
  return { state: WORKTREE_STATE.OWNED, reason: "valid claim for this exact task and a registered worktree", claim };
}

/** ---------------- effects ---------------- */

/**
 * Establish (or re-establish) the isolated context for a task.
 *
 * Returns `{ ok, state, path, claim, created, resumed, dirty, head, branch }`
 * or `{ ok: false, state, reason }`. A `false` here is ALWAYS a fail-closed
 * refusal: nothing has been created, moved, deleted or overwritten.
 *
 * Call order matters and is the point of the whole module:
 *   1. classify, without touching anything;
 *   2. persist the CLAIM (the intent) durably;
 *   3. create the worktree (the effect);
 *   4. promote the claim to READY (the result).
 */
export function establishTaskWorktree({
  cfg,
  taskId,
  comment,
  worktreeRoot,
  baselineSha,
  baselineBranch,
  attempt,
  attemptId = randomUUID(),
  workerVersion = null,
  runner = undefined,
  now = () => new Date()
}) {
  const expectation = expectationFor({ cfg, taskId, comment, worktreeRoot });
  const path = expectation.worktree_path;
  const claimFile = claimFilePath(worktreeRoot, taskId);

  const listed = gitWorktreeList(cfg, runner);
  if (!listed.ok) {
    // An unanswerable `worktree list` is UNKNOWN, never "nothing is registered".
    return {
      ok: false,
      state: WORKTREE_STATE.UNPROVEN,
      path,
      reason: `git could not list linked worktrees (${listed.error}); refusing to act on an unknown worktree topology`
    };
  }

  const claimRead = readClaim(claimFile);
  const verdict = classifyTaskWorktree({
    expectation,
    claimRead,
    dirExists: existsSync(path),
    dirEmpty: directoryIsEmpty(path),
    registeredPaths: listed.items.map((w) => w.path)
  });

  if (verdict.state === WORKTREE_STATE.FOREIGN || verdict.state === WORKTREE_STATE.UNPROVEN) {
    return { ok: false, state: verdict.state, path, claimFile, reason: verdict.reason, claim: verdict.claim ?? null };
  }

  let claim = verdict.claim ?? null;
  let created = false;

  if (verdict.state === WORKTREE_STATE.ABSENT) {
    // --- 2. INTENT, durable, before any effect -----------------------------
    claim = buildClaim({
      expectation,
      baselineSha,
      baselineBranch,
      attempt,
      attemptId,
      workerVersion,
      taskCommentCreatedAt: comment?.created_at ?? null,
      taskCommentAuthor: comment?.user?.login ?? null,
      now
    });
    writeClaim(claimFile, claim);
  }

  if (verdict.state === WORKTREE_STATE.ABSENT || verdict.state === WORKTREE_STATE.INCOMPLETE) {
    const registeredNow = listed.items.some((w) => resolve(w.path) === path);
    if (!registeredNow) {
      mkdirSync(worktreeRoot, { recursive: true });
      // --- 3. EFFECT ------------------------------------------------------
      const add = gitWorktreeAdd(cfg, { path, commitish: claim.baseline_sha }, runner);
      if (!add.ok) {
        // The claim stays on disk in CREATING. It is the record that lets the
        // next run tell "we tried and failed" apart from "nothing ever
        // happened", and it is never silently cleaned up.
        return {
          ok: false,
          state: WORKTREE_STATE.INCOMPLETE,
          path,
          claimFile,
          claim,
          reason: `git worktree add failed (${add.error})`
        };
      }
      created = true;
    }
    // --- 4. RESULT --------------------------------------------------------
    claim = { ...claim, state: CLAIM_STATE.READY, updated_at: now().toISOString() };
    writeClaim(claimFile, claim);
  }

  // A resumed context records the new attempt, so the evidence names every
  // attempt that has ever run inside this directory.
  const resumed = !created;
  if (resumed) {
    const attempts = [...(claim.attempts ?? [])];
    if (!attempts.some((a) => a.attempt_id === attemptId)) {
      attempts.push({ attempt, attempt_id: attemptId, started_at: now().toISOString(), pid: process.pid, host: hostname() });
    }
    claim = {
      ...claim,
      state: CLAIM_STATE.READY,
      latest_attempt: attempt,
      latest_attempt_id: attemptId,
      attempts,
      updated_at: now().toISOString()
    };
    writeClaim(claimFile, claim);
  }

  const wtCfg = atPath(cfg, path);
  const status = gitStatusLines(wtCfg, runner);
  const head = gitHead(wtCfg, runner);
  const branch = gitCurrentBranch(wtCfg, runner);

  if (!status.ok) {
    // We own the directory, but we cannot see its state. Dispatching into a
    // context we cannot describe is exactly the blind move this module exists
    // to prevent.
    return {
      ok: false,
      state: WORKTREE_STATE.UNPROVEN,
      path,
      claimFile,
      claim,
      reason: `git status could not be answered inside the task worktree (${status.error})`
    };
  }

  return {
    ok: true,
    state: created ? WORKTREE_STATE.ABSENT : WORKTREE_STATE.OWNED,
    path,
    claimFile,
    claim,
    created,
    resumed,
    // Dirty lines INSIDE a claimed worktree are task-owned by construction.
    dirty: status.lines,
    head: head.ok ? head.value : null,
    branch: branch.ok ? branch.value : null
  };
}

/**
 * Release a task's isolated context - conservatively.
 *
 * Refuses, and says why, when anything at all is uncertain:
 *   - the task is not terminal, or not terminal SUCCESSFULLY;
 *   - the worktree still has uncommitted changes (git also refuses, because the
 *     removal is deliberately not forced);
 *   - the worktree status cannot be read.
 *
 * The claim file is never deleted. It is marked RELEASED, so the record of what
 * ran where, from which baseline and under which attempt id, survives the
 * directory it describes.
 */
export function releaseTaskWorktree({
  cfg,
  taskId,
  worktreeRoot,
  successful,
  runner = undefined,
  now = () => new Date()
}) {
  const claimFile = claimFilePath(worktreeRoot, taskId);
  const path = taskWorktreePath(worktreeRoot, taskId);

  const claimRead = readClaim(claimFile);
  if (!claimRead.ok) {
    return { released: false, retained: false, reason: claimRead.missing ? "no_claim_for_task" : claimRead.reason };
  }
  if (claimRead.claim.state === CLAIM_STATE.RELEASED) {
    return { released: false, retained: false, reason: "already_released" };
  }
  if (successful !== true) {
    return { released: false, retained: true, reason: "task_did_not_complete_successfully" };
  }
  if (!existsSync(path)) {
    const claim = { ...claimRead.claim, state: CLAIM_STATE.RELEASED, released_at: now().toISOString(), released_reason: "directory_already_absent" };
    writeClaim(claimFile, claim);
    return { released: true, retained: false, reason: "directory_already_absent" };
  }

  const status = gitStatusLines(atPath(cfg, path), runner);
  if (!status.ok) {
    return { released: false, retained: true, reason: `worktree_status_unreadable (${status.error})` };
  }
  if (status.lines.length > 0) {
    return {
      released: false,
      retained: true,
      reason: `worktree_has_uncommitted_changes (${status.lines.length})`,
      dirty: status.lines
    };
  }

  const removed = gitWorktreeRemove(cfg, path, runner);
  if (!removed.ok) {
    return { released: false, retained: true, reason: `git_worktree_remove_failed (${removed.error})` };
  }

  const claim = {
    ...claimRead.claim,
    state: CLAIM_STATE.RELEASED,
    released_at: now().toISOString(),
    released_reason: "terminal_successful_reconciliation_and_clean_worktree"
  };
  writeClaim(claimFile, claim);
  return { released: true, retained: false, reason: "terminal_successful_reconciliation_and_clean_worktree" };
}

/**
 * A short, human-readable description of a refusal, for the status comment.
 * Says exactly what was found and states plainly that nothing was touched.
 */
export function describeRefusal({ taskId, path, state, reason, claim }) {
  return [
    `The isolated worktree for ${taskId} could not be established.`,
    `PATH   ${path}`,
    `STATE  ${state}`,
    `REASON ${reason}`,
    claim ? `CLAIM  task_id=${claim.task_id} repo=${claim.repo} comment=${claim.task_comment_id} state=${claim.state}` : "CLAIM  none",
    "",
    "NOTHING was stashed, reset, cleaned, deleted, moved or overwritten, and the primary",
    "checkout was not touched. Unattributed content is never adopted as task-owned."
  ].join("\n");
}

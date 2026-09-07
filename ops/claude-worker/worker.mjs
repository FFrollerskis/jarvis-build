#!/usr/bin/env node
/**
 * Jarvis Architect <-> Claude worker (v2.1, self-recovering).
 *
 * Polls the GitHub control issue for trusted ARCHITECT_TASK comments and
 * dispatches at most ONE per invocation to a non-interactive Claude Code
 * session. Claude itself posts CLAUDE_ACK / CLAUDE_REPORT, does the git work
 * and performs merges when a task explicitly authorises one; this script only
 * detects, validates trust, quarantines legacy scratch, dispatches, and then
 * records the outcome HONESTLY.
 *
 * Requirements A-F are unchanged (see README.md and D-126).
 *
 * What the D126 independent review changed in this file:
 *
 *   BLOCKER 1 - the run used to be: load state -> pick candidate -> acquire lock
 *   -> reconcile. A task left IN_PROGRESS by a crashed parent is not eligible,
 *   so it was never picked, so the lock was never taken for it, so reconciliation
 *   never ran: a permanent stall. The order is now
 *       acquire lock -> load state -> RECOVER abandoned tasks -> pick candidate,
 *   and the child's identity is persisted at spawn rather than after the run.
 *
 *   BLOCKER 2 - state was loaded before the lock and written on the no-candidate
 *   and lock-denied paths with no lock at all. Every state write now happens
 *   under verified ownership (`persistState`), state is re-read AFTER the lock,
 *   and status dedup moved to its own append-only journal so it never needs the
 *   exclusive lock.
 *
 *   BLOCKER 6 - reconciliation now uses exact recorded associations and treats a
 *   failed GitHub lookup as UNKNOWN, never as "no PR exists".
 *
 *   BLOCKER 7 - git failures are explicit, the TASK_ID is validated before it is
 *   used as a path component, and the remote is checked against the configured
 *   repository.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WORKER_VERSION, loadWorkerConfig } from "./lib/config.mjs";
import { HEALTH_EVENTS, emitHealth, readHealth, summarizeHealth, sanitize } from "./lib/health.mjs";
import {
  TASK_STATUS,
  loadState,
  saveStateAtomic,
  upsertTask,
  getTask,
  isEligibleNow,
  isTerminal,
  isValidTaskId,
  findAbandonedTasks
} from "./lib/state.mjs";
import { acquireLock, heartbeat, releaseLock, readLock, holdsLock } from "./lib/lock.mjs";
import { matchProcessIdentity, listDescendants, isProcessAlive } from "./lib/procid.mjs";
import { recoverScratch } from "./lib/quarantine.mjs";
import { collectTrustedTasks } from "./lib/trust.mjs";
import {
  assessCompletion,
  reconcilePriorAttempt,
  mergeObservedAssociations,
  computeBackoff,
  shouldPostStatus,
  statusKey
} from "./lib/reconcile.mjs";
import { RECOVERY, planTaskRecovery, childLifetimeBudgetMs, describeProtectedChild } from "./lib/recovery.mjs";
import { runClaude, OUTCOME } from "./lib/dispatch.mjs";
import { collectRepoFacts, gitStatusLines, gitHead, gitCurrentBranch, remoteMatchesRepo } from "./lib/git.mjs";
import { readPostedStatus, recordPostedStatus } from "./lib/statusjournal.mjs";
import { verifyAuth, fetchIssueComments, postComment, listRemoteBranches, listPulls } from "./lib/github.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.JARVIS_WORKER_CONFIG || join(HERE, "config.json");

/** Exit codes: 0 ONLY when the run is genuinely healthy. */
export const EXIT = Object.freeze({
  OK: 0,
  BLOCKED: 3,
  TRANSIENT: 4,
  FATAL: 1
});

/**
 * TEST-ONLY fault injection.
 *
 * The D126 final review requires fault-injection tests "through the actual
 * worker entrypoint" for a state-write failure and a lost lock during
 * `onSpawn`. Those are preconditions failing INSIDE a live dispatch; there is no
 * way to provoke them from outside the process without racing the spawn, and a
 * racy test proves nothing. This follows the convention `acquireLock` already
 * established with `hooks.afterClassify` - "exists so tests can stall a process
 * at EXACTLY the point v2 was unsafe... never set in production".
 *
 * Only the PRECONDITION is faked. Everything the fault then triggers - the
 * abort, the identity re-check, the recorded outcome, the exit code and the
 * later recovery - is the real code path, unmodified.
 *
 * It is armed exclusively by JARVIS_WORKER_FAULT and announced loudly in both
 * the log and the health journal whenever it is set, so it can never be
 * silently active on the host.
 */
const ARMED_FAULT = process.env.JARVIS_WORKER_FAULT || null;

function faultArmed(name) {
  return ARMED_FAULT !== null && ARMED_FAULT === name;
}

function log(cfg, line) {
  const stamped = `[${new Date().toISOString()}] ${sanitize(line)}`;
  console.log(stamped);
  try {
    mkdirSync(cfg.logDir, { recursive: true });
    appendFileSync(join(cfg.logDir, `worker-${new Date().toISOString().slice(0, 10)}.log`), stamped + "\n", "utf8");
  } catch {
    // A logging failure must not crash the worker, but it also never turns a
    // blocked run into a healthy one - the exit code carries that truth.
  }
}

/**
 * Every state write goes through here.
 *
 * Blocker 2: a worker that has lost the lock (reclaimed as stale, or the file
 * replaced under it) must never write the task history. Losing ownership is a
 * hard stop, not a warning.
 */
function persistState(cfg, state, token) {
  if (!holdsLock(cfg.lockFile, token)) {
    throw new Error(
      "refusing to write worker state: this process no longer owns the worker lock. "
      + "Another instance may have reclaimed it; the in-memory state is not authoritative any more."
    );
  }
  return saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile, { schema: "worker" });
}

/**
 * Post a deduplicated status to the control queue.
 * Requirement D: repeated failure must stay VISIBLE without spamming.
 * Dedup state lives in an append-only journal, so this works with or without
 * the exclusive lock.
 */
function reportStatus(cfg, { taskId, phase, reason, detail, nextAction }) {
  const key = statusKey({ taskId, phase, reason });
  const posted = readPostedStatus(cfg.postedStatusFile);
  const decision = shouldPostStatus(posted, key, Date.now(), cfg.statusRepeatHours * 3_600_000);
  if (!decision.post) {
    log(cfg, `Status suppressed (${decision.reason}): ${phase}/${reason}`);
    return { posted: false, reason: decision.reason };
  }
  const body = [
    "CLAUDE_WORKER_STATUS",
    `TASK_ID=${taskId ?? "none"}`,
    `WORKER_VERSION=${WORKER_VERSION}`,
    `PHASE=${phase}`,
    `REASON=${reason}`,
    "STATUS=BLOCKED",
    "",
    detail ? detail : "",
    "",
    `NEXT_RECOVERABLE_ACTION: ${nextAction}`,
    "",
    "Posted automatically by the local worker. This is a status notice, not a CLAUDE_REPORT,",
    "and it does not authorise or request any merge."
  ].join("\n");

  const res = postComment(cfg, body, cfg.scratchRoot);
  if (res.ok) {
    recordPostedStatus(cfg.postedStatusFile, key);
    log(cfg, `Posted status comment ${res.commentId} for ${phase}/${reason}`);
  } else {
    log(cfg, `Failed to post status comment: ${res.error}`);
  }
  return { posted: res.ok, ...res };
}

/** ---------------- run ---------------- */

async function cmdRun(cfg, { dryRun }) {
  emitHealth(cfg.healthFile, HEALTH_EVENTS.WORKER_STARTED, {
    worker_version: WORKER_VERSION, pid: process.pid, armed_fault: ARMED_FAULT
  });
  if (ARMED_FAULT) {
    // Never silent. If this ever appears in a host log, the run is a test run.
    log(cfg, `WARNING: JARVIS_WORKER_FAULT=${ARMED_FAULT} is armed. This is a TEST-ONLY fault injection `
      + "and must never be set on the host. The run will deliberately fail a precondition.");
  }

  if (existsSync(cfg.disabledFlagFile) && !dryRun) {
    log(cfg, "Worker is disabled (disabled.flag present) - exiting cleanly.");
    return EXIT.OK;
  }

  if (dryRun) {
    // Strictly read-only: no lock is taken and NOTHING is written, so a dry run
    // can never disturb a live owner or the task history.
    return cmdDryRun(cfg);
  }

  // --- ownership FIRST: nothing is read as authoritative and nothing is written
  //     before this process provably owns the critical section (blocker 2).
  const lock = acquireLock(cfg.lockFile, {
    phase: "startup",
    heartbeatTimeoutMs: cfg.heartbeatTimeoutMinutes * 60_000,
    malformedGraceMs: cfg.malformedLockGraceSeconds * 1000
  });

  if (!lock.acquired) {
    if (lock.needs_attention) {
      log(cfg, `Lock owner ${lock.owner?.pid} is alive but has not heartbeated: ${lock.verdict.reason}`);
      reportStatus(cfg, {
        taskId: lock.owner?.task_id ?? null,
        phase: "lock",
        reason: "owner_alive_but_not_heartbeating",
        detail: `Lock owner pid=${lock.owner?.pid} phase=${lock.owner?.phase} last heartbeat=${lock.owner?.heartbeat_at}. It was NOT terminated: an alive owner may still be doing real work.`,
        nextAction: "Inspect the process by hand. If it is genuinely hung, stop that pid, then the next scheduled run reclaims the lock automatically."
      });
      emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { reason: "lock_owner_not_heartbeating" });
      return EXIT.BLOCKED;
    }
    if (lock.verdict?.state === "unproven_identity") {
      log(cfg, `Lock owner identity could not be confirmed (${lock.verdict.reason}) - refusing to reclaim it.`);
      emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { reason: "lock_owner_identity_unproven" });
      return EXIT.TRANSIENT;
    }
    log(cfg, `Another worker instance is active (${lock.verdict?.reason}) - exiting cleanly without starting a second process.`);
    return EXIT.OK;
  }

  try {
    return await runOwned(cfg, lock.token);
  } finally {
    releaseLock(cfg.lockFile, lock.token);
  }
}

/** Everything below here runs under verified exclusive ownership. */
async function runOwned(cfg, token) {
  // --- state is read AFTER the lock, never before (blocker 2) ---
  const loaded = loadState(cfg.stateFile, cfg.stateBackupFile, { schema: "worker" });
  if (!loaded.state) {
    // Requirement B: NEVER silently reset. A lost history means lost replay
    // protection, which is far more dangerous than refusing to run.
    log(cfg, `FATAL: state file and backup are both unusable (primary=${loaded.primary_error}, backup=${loaded.backup_error}).`);
    log(cfg, "Refusing to run rather than discard processed-task history. Inspect state.json / state.json.bak by hand.");
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { reason: "state_unreadable" });
    reportStatus(cfg, {
      taskId: null,
      phase: "state",
      reason: "state_and_backup_unusable",
      detail: `primary: ${loaded.primary_error}\nbackup: ${loaded.backup_error}\n\nNothing was reset and no history was discarded.`,
      nextAction: "Inspect state.json and state.json.bak on the host. Restore a good copy, or deliberately initialise a fresh one; the worker will not invent an empty history."
    });
    return EXIT.BLOCKED;
  }
  const state = loaded.state;
  state.worker_version = WORKER_VERSION;
  if (loaded.first_run) {
    log(cfg, "First run: no state file has ever existed on this host. Starting with an empty, explicitly initialised history.");
  }
  if (loaded.recovered_from_backup) {
    log(cfg, `WARNING: primary state was unusable; recovered from backup (${loaded.primary_error}). History preserved, and the backup is NOT overwritten until the primary is valid again.`);
  }

  const auth = verifyAuth();
  if (!auth.ok) {
    // Transient by nature - do NOT consume a task attempt, and do NOT exit 0.
    log(cfg, `GitHub auth unavailable (gh auth status failed): ${auth.error}`);
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { reason: "github_auth_unavailable" });
    return EXIT.TRANSIENT;
  }

  let comments;
  try {
    comments = fetchIssueComments(cfg);
  } catch (err) {
    log(cfg, `Failed to fetch control issue comments: ${sanitize(err.message)}`);
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { reason: "control_issue_unreachable" });
    return EXIT.TRANSIENT;
  }
  emitHealth(cfg.healthFile, HEALTH_EVENTS.QUEUE_POLLED, { comment_count: comments.length });

  // --- BLOCKER 1: recover anything a crashed parent left behind, before any
  //     candidate is chosen and before eligibility is even considered. ---
  const recovery = recoverAbandonedTasks(cfg, state, token, comments);
  if (recovery.stop) return recovery.exit;

  const tasks = collectTrustedTasks(comments, { trustedAuthor: cfg.trustedAuthor });
  const nowMs = Date.now();

  // Requirement E: only already-authorised tasks. Nothing is invented here.
  const candidate = tasks.find((t) => {
    if (!isValidTaskId(t.taskId)) return false;
    return isEligibleNow(getTask(state, t.taskId), nowMs);
  });

  const unsafeIds = tasks.filter((t) => !isValidTaskId(t.taskId)).map((t) => t.taskId);
  if (unsafeIds.length > 0) {
    log(cfg, `Ignoring ${unsafeIds.length} trusted task(s) with an unsafe TASK_ID (it is used as a directory name): ${unsafeIds.map((i) => String(i).slice(0, 48)).join(", ")}`);
  }

  if (!candidate) {
    const waiting = tasks.filter((t) => {
      const rec = getTask(state, t.taskId);
      return rec && !isTerminal(rec) && !isEligibleNow(rec, nowMs);
    });
    if (waiting.length > 0) {
      log(cfg, `No task eligible right now; ${waiting.length} in backoff (next: ${waiting[0].taskId} at ${getTask(state, waiting[0].taskId)?.next_eligible_at}).`);
    } else {
      log(cfg, "No new trusted ARCHITECT_TASK found. Exiting cleanly.");
    }
    state.last_run_at = new Date().toISOString();
    persistState(cfg, state, token);
    return recovery.exit ?? EXIT.OK;
  }

  log(cfg, `Next trusted task: TASK_ID=${candidate.taskId} (comment ${candidate.comment.id}, posted ${candidate.comment.created_at}, ${candidate.updates.length} scope update(s))`);
  heartbeat(cfg.lockFile, { token, phase: "preflight", taskId: candidate.taskId });

  return await runTask(cfg, state, token, candidate, comments);
}

/**
 * BLOCKER 1: convert every task a crashed/rebooted parent left IN_PROGRESS back
 * into a decided state, under ownership, protecting a live child.
 *
 * Also reconciles the report for non-terminal tasks that are merely in backoff -
 * "reconcile report regardless of next-attempt eligibility".
 */
function recoverAbandonedTasks(cfg, state, token, comments) {
  const abandoned = findAbandonedTasks(state);
  if (abandoned.length === 0) return { stop: false, exit: null };

  const lifetimeBudgetMs = childLifetimeBudgetMs({ claudeTimeoutMinutes: cfg.claudeTimeoutMinutes });
  const branchLookup = listRemoteBranches(cfg);
  const pullLookup = listPulls(cfg);
  let mutated = false;

  for (const task of abandoned) {
    const taskId = task.task_id;
    log(cfg, `Recovering abandoned IN_PROGRESS task ${taskId} (attempts=${task.attempts ?? 0}, last dispatch ${task.last_dispatch_at ?? "unknown"}).`);

    const rec = reconcilePriorAttempt({
      taskId,
      comments,
      trustedAuthor: cfg.trustedAuthor,
      priorTask: task,
      branchLookup,
      pullLookup,
      sinceIso: task.first_dispatch_at ?? null
    });

    const identityVerdict = task.child_identity ? matchProcessIdentity(task.child_identity) : null;
    const plan = planTaskRecovery({
      task,
      nowMs: Date.now(),
      completion: rec.completion,
      identityVerdict,
      lifetimeBudgetMs,
      duplicateRiskUnknown: rec.duplicateRiskUnknown
    });

    if (plan.action === RECOVERY.PROTECT_LIVE_CHILD) {
      const descendants = task.child_identity?.pid ? listDescendants(task.child_identity.pid) : [];
      log(cfg, `PROTECTED: ${plan.reason}`);
      emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, {
        task_id: taskId,
        reason: "live_orphan_child_protected",
        child_pid: task.child_identity?.pid ?? null,
        descendants: descendants.length
      });
      reportStatus(cfg, {
        taskId,
        phase: "recovery",
        reason: "previous_claude_child_still_running",
        detail: describeProtectedChild({ task, identityVerdict, descendants }),
        nextAction: "Wait for that process to finish, or stop that specific pid by hand. The next scheduled run then resumes this task automatically."
      });
      // Leave the task IN_PROGRESS: the live child still owns it.
      if (mutated) {
        state.last_run_at = new Date().toISOString();
        persistState(cfg, state, token);
      }
      return { stop: true, exit: EXIT.BLOCKED };
    }

    const observed = mergeObservedAssociations(task, {
      branch: rec.existingBranch,
      prNumber: rec.existingPr?.number ?? rec.prNumberKnownButUnverified
    });

    if (plan.action === RECOVERY.COMPLETE_FROM_REPORT) {
      log(cfg, `Reconciled ${taskId} WITHOUT re-dispatching: ${plan.reason}`);
      upsertTask(state, taskId, {
        ...observed,
        status: TASK_STATUS.COMPLETED,
        completed_at: new Date().toISOString(),
        report_comment_id: rec.completion.reportCommentId,
        report_status: rec.completion.status,
        successful: rec.completion.successful,
        reconciled_without_redispatch: true,
        recovered_from_crash: true,
        child_identity: null,
        last_child_pid: null
      });
      emitHealth(cfg.healthFile, HEALTH_EVENTS.COMPLETION_CONFIRMED, {
        task_id: taskId, report_comment_id: rec.completion.reportCommentId, via: "crash_recovery"
      });
      mutated = true;
      continue;
    }

    if (plan.action === RECOVERY.DEFER_UNKNOWN) {
      log(cfg, `DEFERRED ${taskId}: ${plan.reason} (${rec.lookupFailures.join("; ")})`);
      upsertTask(state, taskId, {
        ...observed,
        status: TASK_STATUS.FAILED_RETRYABLE,
        last_failure_reason: `abandoned_in_progress_but_duplicate_risk_unknown (${rec.lookupFailures.join("; ")})`,
        next_eligible_at: new Date(Date.now() + cfg.backoffBaseMinutes * 60_000).toISOString(),
        recovered_from_crash: true,
        child_identity: null,
        last_child_pid: null
      });
      emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { task_id: taskId, reason: "duplicate_risk_unknown", retryable: true });
      mutated = true;
      continue;
    }

    // RETRY: return it to the normal path, eligible immediately. The attempt
    // count is NOT reset - a crash loop still runs out of budget.
    log(cfg, `Recovered ${taskId} for retry: ${plan.reason}`);
    upsertTask(state, taskId, {
      ...observed,
      status: TASK_STATUS.FAILED_RETRYABLE,
      last_failure_reason: task.last_failure_reason ?? "abandoned_in_progress_after_parent_crash",
      next_eligible_at: null,
      recovered_from_crash: true,
      child_identity: null,
      last_child_pid: null
    });
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, {
      task_id: taskId, reason: "recovered_abandoned_in_progress", retryable: true
    });
    mutated = true;
  }

  if (mutated) {
    state.last_run_at = new Date().toISOString();
    persistState(cfg, state, token);
  }
  return { stop: false, exit: null };
}

async function runTask(cfg, state, token, candidate, comments) {
  const taskId = candidate.taskId;
  const prior = getTask(state, taskId);

  // --- reconcile prior side effects so a retry resumes rather than duplicates ---
  let resume = null;
  if (prior && (prior.attempts ?? 0) > 0) {
    const rec = reconcilePriorAttempt({
      taskId,
      comments,
      trustedAuthor: cfg.trustedAuthor,
      priorTask: prior,
      branchLookup: listRemoteBranches(cfg),
      pullLookup: listPulls(cfg),
      sinceIso: prior.first_dispatch_at ?? null
    });

    if (rec.completion.complete) {
      // Crash-after-report case: the work IS done; close it out, do not re-run.
      log(cfg, `Reconciled: a matching trusted report already exists (comment ${rec.completion.reportCommentId}, STATUS=${rec.completion.status}). Marking complete without re-dispatching.`);
      upsertTask(state, taskId, {
        ...mergeObservedAssociations(prior, { branch: rec.existingBranch, prNumber: rec.existingPr?.number }),
        status: TASK_STATUS.COMPLETED,
        completed_at: new Date().toISOString(),
        report_comment_id: rec.completion.reportCommentId,
        report_status: rec.completion.status,
        successful: rec.completion.successful,
        reconciled_without_redispatch: true
      });
      state.last_run_at = new Date().toISOString();
      persistState(cfg, state, token);
      emitHealth(cfg.healthFile, HEALTH_EVENTS.COMPLETION_CONFIRMED, {
        task_id: taskId, report_comment_id: rec.completion.reportCommentId, via: "reconciliation"
      });
      return EXIT.OK;
    }

    if (rec.duplicateRiskUnknown) {
      log(cfg, `Refusing to retry ${taskId}: ${rec.lookupFailures.join("; ")}. A failed lookup is not proof that no branch/PR exists.`);
      upsertTask(state, taskId, {
        status: TASK_STATUS.FAILED_RETRYABLE,
        last_failure_reason: `duplicate_risk_unknown (${rec.lookupFailures.join("; ")})`,
        next_eligible_at: new Date(Date.now() + cfg.backoffBaseMinutes * 60_000).toISOString()
      });
      state.last_run_at = new Date().toISOString();
      persistState(cfg, state, token);
      emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { task_id: taskId, reason: "duplicate_risk_unknown", retryable: true });
      return EXIT.TRANSIENT;
    }

    resume = {
      attempts: prior.attempts,
      lastFailureReason: prior.last_failure_reason,
      existingBranch: rec.existingBranch,
      branchVerified: rec.branchVerified,
      existingPr: rec.existingPr,
      prNumberKnownButUnverified: rec.prNumberKnownButUnverified,
      alreadyMerged: rec.alreadyMerged,
      duplicateRiskUnknown: rec.duplicateRiskUnknown
    };
    upsertTask(state, taskId, mergeObservedAssociations(prior, {
      branch: rec.existingBranch,
      prNumber: rec.existingPr?.number ?? rec.prNumberKnownButUnverified
    }));
    log(cfg, `Resuming TASK_ID=${taskId} (attempt ${prior.attempts + 1}); existing branch=${rec.existingBranch ?? "none"} (verified=${rec.branchVerified}), PR=${rec.existingPr?.number ?? "none"}, alreadyMerged=${rec.alreadyMerged}`);
  }

  // --- scratch quarantine, BEFORE the dirty guard (requirement A) ---
  heartbeat(cfg.lockFile, { token, phase: "quarantine", taskId });
  const preStatus = gitStatusLines(cfg);
  if (!preStatus.ok) {
    return blockOnGitFailure(cfg, state, token, taskId, [preStatus.error]);
  }

  const quarantine = recoverScratch({
    repoPath: cfg.repoPath,
    statusLines: preStatus.lines,
    quarantineRoot: cfg.quarantineRoot,
    knownTaskIds: Object.keys(state.tasks),
    manifestFile: cfg.manifestFile
  });
  for (const r of quarantine.recovered) {
    log(cfg, `SCRATCH_RECOVERED=${r.source_rel} -> ${r.dest} (sha256=${r.sha256.slice(0, 16)}..., ${r.size_bytes}b)`);
  }
  emitHealth(cfg.healthFile, HEALTH_EVENTS.QUARANTINE, {
    task_id: taskId,
    recovered: quarantine.recovered.map((r) => ({ name: r.source_rel, sha256: r.sha256 })),
    left: quarantine.left
  });

  // --- preflight: every git fact must be ANSWERED, not assumed (blocker 7) ---
  const facts = collectRepoFacts(cfg);
  if (!facts.ok) {
    return blockOnGitFailure(cfg, state, token, taskId, facts.failures);
  }
  if (!remoteMatchesRepo(facts.remoteUrl, cfg)) {
    log(cfg, `BLOCKED: origin is ${facts.remoteUrl}, which is not ${cfg.repoOwner}/${cfg.repoName}.`);
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { task_id: taskId, reason: "remote_mismatch" });
    reportStatus(cfg, {
      taskId,
      phase: "preflight",
      reason: "origin_remote_does_not_match_configured_repository",
      detail: `origin = ${facts.remoteUrl}\nconfigured = ${cfg.repoOwner}/${cfg.repoName}\n\nNothing was changed, fetched or pushed.`,
      nextAction: "Point the checkout at the configured repository, or correct repoOwner/repoName in config.json. The worker will not act on an unexpected remote."
    });
    state.last_run_at = new Date().toISOString();
    persistState(cfg, state, token);
    return EXIT.BLOCKED;
  }

  // --- dirty guard: never bypassed, never widened ---
  if (facts.statusLines.length > 0) {
    const detail = [
      "Files still present after known-scratch quarantine (NOTHING was deleted, reset, stashed or ignored):",
      ...facts.statusLines.map((l) => `  ${l}`),
      "",
      "Reasons they were left alone:",
      ...quarantine.left.map((l) => `  ${l.name}: ${l.reason}`)
    ].join("\n");
    log(cfg, `BLOCKED: worktree at ${cfg.repoPath} still has ${facts.statusLines.length} entry/entries after quarantine.`);
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { task_id: taskId, reason: "worktree_dirty_unknown", entries: facts.statusLines.length });
    reportStatus(cfg, {
      taskId,
      phase: "preflight",
      reason: "worktree_dirty_unknown_files",
      detail,
      nextAction: "Inspect the listed paths. Commit, move or delete them deliberately; the worker will not touch unknown or tracked files. The next scheduled run then dispatches this same task automatically."
    });
    state.last_run_at = new Date().toISOString();
    persistState(cfg, state, token);
    return EXIT.BLOCKED; // task stays non-terminal and eligible - NOT processed
  }
  emitHealth(cfg.healthFile, HEALTH_EVENTS.PREFLIGHT, { task_id: taskId, worktree: "clean", head: facts.head, branch: facts.branch });

  // --- mark in progress and dispatch ---
  // TASK_ID has already been validated as a single safe path component.
  const scratchDir = join(cfg.scratchRoot, taskId);
  mkdirSync(scratchDir, { recursive: true });

  const attempts = (prior?.attempts ?? 0) + 1;
  const dispatchStartedAt = new Date().toISOString();
  upsertTask(state, taskId, {
    status: TASK_STATUS.IN_PROGRESS,
    attempts,
    first_dispatch_at: prior?.first_dispatch_at ?? dispatchStartedAt,
    last_dispatch_at: dispatchStartedAt,
    comment_id: candidate.comment.id,
    branch_before: facts.branch,
    head_before: facts.head,
    child_identity: null
  });
  persistState(cfg, state, token);

  log(cfg, `Dispatching TASK_ID=${taskId} attempt ${attempts} (branch=${facts.branch}, head=${facts.head})...`);
  emitHealth(cfg.healthFile, HEALTH_EVENTS.DISPATCH_STARTED, { task_id: taskId, attempt: attempts, head: facts.head });

  const result = await runClaude(cfg, { ...candidate, resume, scratchDir }, {
    heartbeatMs: cfg.heartbeatSeconds * 1000,
    // BLOCKER 1: the child's identity is durable BEFORE we wait on it, so a
    // parent crash right here still leaves a record that protects the child.
    // FINDING 1: this is a HANDOFF GATE, not bookkeeping. It must either make
    // the child's identity durable or THROW. Swallowing the failure here is
    // what let a live Claude run with `child_identity: null` on disk, which a
    // later recovery could not distinguish from a pre-spawn crash. On a throw,
    // runClaude aborts the child it just created and reports HANDOFF_FAILED.
    onSpawn: (identity) => {
      if (faultArmed("spawn_state_write")) {
        throw new Error("durable write failed (injected fault: spawn_state_write)");
      }
      upsertTask(state, taskId, {
        child_identity: identity,
        last_child_pid: identity?.pid ?? null,
        child_started_at: identity?.observed_at ?? null
      });
      persistState(cfg, state, token);
      // The lock heartbeat carries the same identity, so the ledger and the
      // task state agree about what is running. It returns false rather than
      // throwing when ownership is gone, so an explicit check is required: a
      // child we cannot cover with a held lock is not a tracked child.
      const beatOk = !faultArmed("spawn_lost_lock")
        && heartbeat(cfg.lockFile, { token, phase: "dispatch", taskId, childPid: identity?.pid ?? null, childIdentity: identity });
      if (!beatOk) {
        throw new Error(
          "the worker lock could not be heartbeated with the child's identity at spawn; "
          + "ownership has been lost, so this child cannot be tracked and must not be left running."
        );
      }
      emitHealth(cfg.healthFile, HEALTH_EVENTS.DISPATCH_STARTED, {
        task_id: taskId, attempt: attempts, child_pid: identity?.pid ?? null, child_start_time: identity?.start_time ?? null
      });
    },
    onHeartbeat: (childPid, identity) => {
      heartbeat(cfg.lockFile, { token, phase: "dispatch", taskId, childPid, childIdentity: identity });
      emitHealth(cfg.healthFile, HEALTH_EVENTS.HEARTBEAT, { task_id: taskId, child_pid: childPid });
    }
  });

  emitHealth(cfg.healthFile, HEALTH_EVENTS.DISPATCH_EXITED, {
    task_id: taskId, outcome: result.outcome, code: result.code ?? null, child_pid: result.childPid ?? null
  });

  // --- FINDING 1: a failed durable handoff is never a completion -------------
  // The child was created and then aborted because we could not record it. We
  // must not fall through into the completion assessment: exit codes and
  // reports from a task we never actually delegated say nothing. Every write
  // below is best effort ON PURPOSE - the handoff failed precisely because
  // durable state or lock ownership was unavailable, and the process must still
  // terminate with a truthful non-zero code even when it cannot write anything.
  if (result.outcome === OUTCOME.HANDOFF_FAILED) {
    const handoff = result.handoff ?? {};
    const untracked = handoff.untracked_child_live !== false;
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, {
      task_id: taskId,
      reason: "child_identity_handoff_failed",
      child_pid: result.childPid ?? null,
      child_terminated: handoff.child_terminated ?? false,
      untracked_child_live: untracked,
      identity_state: handoff.identity_state ?? null
    });
    log(cfg, `HANDOFF FAILED for TASK_ID=${taskId}: ${result.error}. `
      + `Child pid ${result.childPid ?? "n/a"} aborted; terminated=${handoff.child_terminated ?? false} `
      + `(identity ${handoff.identity_state ?? "unknown"}).`);

    // If the child is PROVEN gone, the attempt simply did not happen and is
    // safely retryable. If we could not prove it, a retry might start a second
    // Claude on top of a live one, so the task is parked as BLOCKED instead.
    //
    // A retryable handoff failure still consumes the ordinary attempt budget: a
    // precondition that keeps failing is a real problem that must surface as
    // BLOCKED, not spin forever because "the attempt did not really happen".
    const handoffBackoff = computeBackoff(attempts, {
      maxAttempts: cfg.maxAttempts,
      baseMs: cfg.backoffBaseMinutes * 60_000,
      maxMs: cfg.backoffMaxHours * 3_600_000
    });
    const parkAsBlocked = untracked || handoffBackoff.exhausted;
    const failureReason = untracked
      ? `handoff_failed_untracked_child_may_be_live (${result.error})`
      : `handoff_failed_child_aborted (${result.error})`
        + (handoffBackoff.exhausted ? ` [retry budget exhausted after ${attempts}/${cfg.maxAttempts} attempts]` : "");
    const handoffPatch = {
      last_outcome: result.outcome,
      last_child_pid: result.childPid ?? null,
      last_dispatch_finished_at: new Date().toISOString(),
      last_failure_reason: failureReason,
      // The identity is KEPT when we could not prove the child is gone: it is
      // the only thing a later recovery can use to find and protect that
      // orphan. It is cleared only when termination was actually verified.
      child_identity: untracked ? (result.childIdentity ?? null) : null,
      handoff_failed_at: new Date().toISOString(),
      handoff_child_terminated: handoff.child_terminated ?? false,
      handoff_identity_state: handoff.identity_state ?? null
    };
    let persisted = false;
    try {
      upsertTask(state, taskId, parkAsBlocked
        ? { ...handoffPatch, status: TASK_STATUS.BLOCKED, blocked_at: new Date().toISOString() }
        : { ...handoffPatch, status: TASK_STATUS.FAILED_RETRYABLE, next_eligible_at: new Date(Date.now() + handoffBackoff.delayMs).toISOString() });
      state.last_run_at = new Date().toISOString();
      persistState(cfg, state, token);
      persisted = true;
    } catch (err) {
      log(cfg, `Could not record the failed handoff in worker state either: ${sanitize(err.message)}. `
        + "The exit code below is the only truthful signal this run can emit.");
    }
    try {
      reportStatus(cfg, {
        taskId,
        phase: "dispatch",
        reason: untracked
          ? "handoff_failed_untracked_child"
          : (handoffBackoff.exhausted ? "handoff_failed_retry_budget_exhausted" : "handoff_failed_child_aborted"),
        detail: [
          `The Claude child was created (pid ${result.childPid ?? "unknown"}) but its identity could not be recorded durably: ${result.error}`,
          `Abort was attempted and the EXACT captured identity (pid + start time + host) was re-checked: `
            + `terminated=${handoff.child_terminated ?? false}, identity=${handoff.identity_state ?? "unknown"}.`,
          untracked
            ? "Termination could NOT be proven, so this task is BLOCKED rather than retried: a retry could start a second Claude on top of a live one."
            : (handoffBackoff.exhausted
              ? `The child is proven gone, but the handoff has now failed ${attempts}/${cfg.maxAttempts} times. `
                + "A precondition that keeps failing is a real problem, so the task is parked as BLOCKED instead of spinning."
              : "The child is proven gone, so nothing is running untracked and the task stays retryable."),
          persisted ? "The outcome was recorded in worker state." : "Worker state could NOT be written; only this status and the exit code record the outcome."
        ].join("\n"),
        nextAction: untracked
          ? "Inspect the recorded child_identity, confirm whether that exact process is still running, then issue a FRESH TASK_ID. The worker will not replay a blocked task on its own."
          : (handoffBackoff.exhausted
            ? "Find out why the durable state write or the lock heartbeat keeps failing (disk, permissions, a competing instance), then issue a FRESH TASK_ID."
            : "No action required; the next scheduled run retries this task after the backoff.")
      });
    } catch (err) {
      log(cfg, `Could not post the handoff status: ${sanitize(err.message)}`);
    }
    return parkAsBlocked ? EXIT.BLOCKED : EXIT.TRANSIENT;
  }
  log(cfg, `Claude dispatch finished: outcome=${result.outcome} code=${result.code ?? "n/a"} signal=${result.signal ?? "none"}`);
  if (result.stderrTail) log(cfg, `stderr (last 2000 chars): ${result.stderrTail.slice(-2000)}`);
  if (result.error) log(cfg, `spawn error: ${result.error}`);

  // --- completion requires EVIDENCE, never exit code alone (requirement B) ---
  heartbeat(cfg.lockFile, { token, phase: "verify", taskId });
  let postComments = [];
  try {
    postComments = fetchIssueComments(cfg);
  } catch (err) {
    log(cfg, `Could not re-read control issue to verify completion: ${sanitize(err.message)}`);
  }
  const completion = assessCompletion({
    taskId,
    comments: postComments,
    trustedAuthor: cfg.trustedAuthor,
    sinceIso: dispatchStartedAt
  });

  const headAfter = gitHead(cfg);
  const branchAfter = gitCurrentBranch(cfg);
  const checkpoint = {
    last_outcome: result.outcome,
    last_exit_code: result.code ?? null,
    last_child_pid: result.childPid ?? null,
    last_dispatch_finished_at: new Date().toISOString(),
    branch_before: facts.branch,
    head_before: facts.head,
    head_after: headAfter.ok ? headAfter.value : null,
    head_after_error: headAfter.ok ? null : headAfter.error,
    branch_after: branchAfter.ok ? branchAfter.value : null,
    branch_after_error: branchAfter.ok ? null : branchAfter.error
  };

  // The branch this attempt actually ended on is an EXACT association: record it
  // so a later reconciliation never has to guess (blocker 6).
  const observed = mergeObservedAssociations(getTask(state, taskId), { branch: checkpoint.branch_after });

  if (completion.complete) {
    upsertTask(state, taskId, {
      ...checkpoint,
      ...observed,
      status: TASK_STATUS.COMPLETED,
      completed_at: new Date().toISOString(),
      report_comment_id: completion.reportCommentId,
      report_status: completion.status,
      successful: completion.successful,
      child_identity: null,
      last_child_pid: null
    });
    state.last_run_at = new Date().toISOString();
    persistState(cfg, state, token);
    emitHealth(cfg.healthFile, HEALTH_EVENTS.COMPLETION_CONFIRMED, {
      task_id: taskId, report_comment_id: completion.reportCommentId, report_status: completion.status
    });
    log(cfg, `TASK_ID=${taskId} COMPLETE - matching trusted report ${completion.reportCommentId} (STATUS=${completion.status}).`);
    return EXIT.OK;
  }

  // Not complete: exit 0 without a matching report is explicitly NOT success.
  const failureReason = result.outcome === OUTCOME.COMPLETED_EXIT_0
    ? `exit_0_without_matching_report (${completion.reason})`
    : `${result.outcome} (${completion.reason})`;

  const backoff = computeBackoff(attempts, {
    maxAttempts: cfg.maxAttempts,
    baseMs: cfg.backoffBaseMinutes * 60_000,
    maxMs: cfg.backoffMaxHours * 3_600_000
  });

  if (backoff.exhausted) {
    upsertTask(state, taskId, {
      ...checkpoint,
      ...observed,
      status: TASK_STATUS.BLOCKED,
      last_failure_reason: failureReason,
      blocked_at: new Date().toISOString(),
      child_identity: null
    });
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { task_id: taskId, reason: "retry_budget_exhausted", attempts });
    state.last_run_at = new Date().toISOString();
    persistState(cfg, state, token);
    reportStatus(cfg, {
      taskId,
      phase: "dispatch",
      reason: "retry_budget_exhausted",
      detail: [
        `Attempts: ${attempts}/${cfg.maxAttempts}. Last outcome: ${result.outcome}.`,
        `Completion check: ${completion.reason}.`,
        checkpoint.head_after === checkpoint.head_before
          ? "Repository HEAD did not move during the last attempt."
          : `Repository HEAD moved ${checkpoint.head_before} -> ${checkpoint.head_after} on branch ${checkpoint.branch_after}.`,
        "The task is NOT marked processed and NOT silently dropped; it is parked as BLOCKED."
      ].join("\n"),
      nextAction: "Inspect logs/worker-*.log and the branch state, then issue a FRESH TASK_ID for a repair attempt. This worker will not replay a blocked task on its own."
    });
    log(cfg, `TASK_ID=${taskId} BLOCKED after ${attempts} attempts: ${failureReason}`);
    return EXIT.BLOCKED;
  }

  const nextEligible = new Date(Date.now() + backoff.delayMs).toISOString();
  upsertTask(state, taskId, {
    ...checkpoint,
    ...observed,
    status: TASK_STATUS.FAILED_RETRYABLE,
    last_failure_reason: failureReason,
    next_eligible_at: nextEligible,
    child_identity: null
  });
  state.last_run_at = new Date().toISOString();
  persistState(cfg, state, token);
  log(cfg, `TASK_ID=${taskId} NOT complete (${failureReason}). Retryable; next eligible at ${nextEligible} (attempt ${attempts}/${cfg.maxAttempts}).`);
  emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { task_id: taskId, reason: failureReason, retryable: true, next_eligible_at: nextEligible });
  return EXIT.TRANSIENT;
}

function blockOnGitFailure(cfg, state, token, taskId, failures) {
  log(cfg, `BLOCKED: git could not answer the preflight questions: ${failures.join("; ")}`);
  emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { task_id: taskId, reason: "git_preflight_failed" });
  reportStatus(cfg, {
    taskId,
    phase: "preflight",
    reason: "git_preflight_failed",
    detail: [
      "git could not be queried, so the state of the worktree is UNKNOWN.",
      "An unanswerable git query is never treated as a clean worktree.",
      "",
      ...failures.map((f) => `  ${f}`)
    ].join("\n"),
    nextAction: "Check that git is installed and on PATH for the scheduled task's account, and that the configured repoPath is a valid git repository. Nothing was dispatched."
  });
  state.last_run_at = new Date().toISOString();
  persistState(cfg, state, token);
  return EXIT.BLOCKED;
}

/** ---------------- other subcommands ---------------- */

/** Read-only preview. Takes no lock and writes nothing at all. */
function cmdDryRun(cfg) {
  const loaded = loadState(cfg.stateFile, cfg.stateBackupFile, { schema: "worker" });
  if (!loaded.state) {
    console.log(`Dry run: state is unusable (primary=${loaded.primary_error}, backup=${loaded.backup_error}). A real run would refuse to start.`);
    return EXIT.BLOCKED;
  }
  const auth = verifyAuth();
  if (!auth.ok) {
    console.log(`Dry run: GitHub auth unavailable (${auth.error}). A real run would exit TRANSIENT.`);
    return EXIT.TRANSIENT;
  }
  let comments = [];
  try {
    comments = fetchIssueComments(cfg);
  } catch (err) {
    console.log(`Dry run: control issue unreachable (${sanitize(err.message)}). A real run would exit TRANSIENT.`);
    return EXIT.TRANSIENT;
  }
  const abandoned = findAbandonedTasks(loaded.state);
  const tasks = collectTrustedTasks(comments, { trustedAuthor: cfg.trustedAuthor });
  const nowMs = Date.now();
  const candidate = tasks.find((t) => isValidTaskId(t.taskId) && isEligibleNow(getTask(loaded.state, t.taskId), nowMs));
  const status = gitStatusLines(cfg);
  console.log(JSON.stringify({
    dry_run: true,
    wrote_anything: false,
    took_lock: false,
    state_source: loaded.source,
    first_run: loaded.first_run,
    abandoned_in_progress: abandoned.map((t) => ({ task_id: t.task_id, child_pid: t.child_identity?.pid ?? null })),
    next_candidate: candidate?.taskId ?? null,
    worktree_query_ok: status.ok,
    worktree_dirty_entries: status.ok ? status.lines : null,
    worktree_query_error: status.ok ? null : status.error
  }, null, 2));
  return EXIT.OK;
}

function cmdStatus(cfg) {
  const loaded = loadState(cfg.stateFile, cfg.stateBackupFile, { schema: "worker" });
  const state = loaded.state;
  const auth = verifyAuth();
  const lock = readLock(cfg.lockFile);
  const status = gitStatusLines(cfg);
  const tasks = state ? Object.values(state.tasks) : [];
  console.log(JSON.stringify({
    worker_version: WORKER_VERSION,
    state_readable: Boolean(state),
    state_source: loaded.source,
    state_first_run: Boolean(loaded.first_run),
    state_primary_error: loaded.primary_error ?? null,
    enabled: !existsSync(cfg.disabledFlagFile),
    lock: lock && !lock.malformed
      ? {
        pid: lock.pid,
        host: lock.host ?? null,
        phase: lock.phase,
        task_id: lock.task_id,
        heartbeat_at: lock.heartbeat_at,
        alive: isProcessAlive(lock.pid)
      }
      : (lock ? { malformed: true } : null),
    last_run_at: state?.last_run_at ?? null,
    counts: {
      completed: tasks.filter((t) => t.status === TASK_STATUS.COMPLETED).length,
      blocked: tasks.filter((t) => t.status === TASK_STATUS.BLOCKED).length,
      retryable: tasks.filter((t) => t.status === TASK_STATUS.FAILED_RETRYABLE).length,
      in_progress: tasks.filter((t) => t.status === TASK_STATUS.IN_PROGRESS).length
    },
    unfinished: tasks.filter((t) => !isTerminal(t)).map((t) => ({
      task_id: t.task_id,
      status: t.status,
      attempts: t.attempts,
      next_eligible_at: t.next_eligible_at ?? null,
      last_failure_reason: t.last_failure_reason ?? null,
      child_pid: t.child_identity?.pid ?? null,
      observed_branches: t.observed_branches ?? [],
      observed_pr_numbers: t.observed_pr_numbers ?? []
    })),
    github_reachable: auth.ok,
    repo_path: cfg.repoPath,
    // An unanswerable git query is reported as unknown, never as clean.
    repo_query_ok: status.ok,
    repo_clean: status.ok ? status.lines.length === 0 : null,
    repo_dirty_entries: status.ok ? status.lines : null,
    repo_query_error: status.ok ? null : status.error
  }, null, 2));
  return EXIT.OK;
}

/** Requirement F: report what is actually PROVEN, stage by stage. */
function cmdHealth(cfg) {
  const summary = summarizeHealth(readHealth(cfg.healthFile));
  console.log(JSON.stringify({ worker_version: WORKER_VERSION, ...summary }, null, 2));
  return EXIT.OK;
}

function cmdEnable(cfg) {
  try { unlinkSync(cfg.disabledFlagFile); } catch { /* already enabled */ }
  console.log("Worker enabled.");
  return EXIT.OK;
}

function cmdDisable(cfg) {
  writeFileSync(cfg.disabledFlagFile, `disabled at ${new Date().toISOString()}\n`);
  console.log("Worker disabled (scheduled runs will no-op until re-enabled).");
  return EXIT.OK;
}

/** ---------------- entrypoint ---------------- */

async function main() {
  const cfg = loadWorkerConfig(CONFIG_PATH, HERE);
  const args = process.argv.slice(2);
  const sub = args[0] && !args[0].startsWith("--") ? args[0] : "run";
  const dryRun = args.includes("--dry-run");

  switch (sub) {
    case "status": return cmdStatus(cfg);
    case "health": return cmdHealth(cfg);
    case "enable": return cmdEnable(cfg);
    case "disable": return cmdDisable(cfg);
    case "run":
    default:
      return cmdRun(cfg, { dryRun });
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main()
    .then((code) => { process.exitCode = code ?? EXIT.OK; })
    .catch((err) => {
      console.error(`[${new Date().toISOString()}] FATAL: ${sanitize(err.message)}`);
      process.exitCode = EXIT.FATAL;
    });
}

export { main, cmdRun, runOwned, recoverAbandonedTasks };

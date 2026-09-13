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
import { randomUUID } from "node:crypto";

import { WORKER_VERSION, loadWorkerConfig } from "./lib/config.mjs";
import { HEALTH_EVENTS, emitHealth, readHealth, summarizeHealth, sanitize } from "./lib/health.mjs";
import {
  TASK_STATUS,
  loadState,
  saveStateAtomic,
  upsertTask,
  getTask,
  isTerminal,
  isValidTaskId,
  findAbandonedTasks,
  findUnreconciledTasks
} from "./lib/state.mjs";
import { selectNextTask, INELIGIBLE } from "./lib/queue.mjs";
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
  statusKey,
  TERMINAL_REPORT_STATUSES,
  NON_TERMINAL_STATUSES
} from "./lib/reconcile.mjs";
import { RECOVERY, planTaskRecovery, childLifetimeBudgetMs, describeProtectedChild } from "./lib/recovery.mjs";
import { runClaude, OUTCOME } from "./lib/dispatch.mjs";
import { collectRepoFacts, gitStatusLines, gitHead, gitCurrentBranch, remoteMatchesRepo, atPath } from "./lib/git.mjs";
import {
  establishTaskWorktree,
  releaseTaskWorktree,
  describeRefusal,
  taskWorktreePath,
  claimFilePath,
  readClaim
} from "./lib/worktree.mjs";
import {
  collectCommitProvenance,
  deriveReconciliationProvenance,
  reconciliationProvenanceForGate,
  provenanceForResume,
  evaluateCompletionGate,
  describeCompletionGate,
  COMMIT_PROVENANCE
} from "./lib/provenance.mjs";
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
 * `onSpawn`; review F extends that to the two heartbeat callback sites, which
 * behave differently on purpose:
 *
 *   spawn_state_write            - the durable identity write fails
 *   spawn_lost_lock              - the lock is gone when the identity is recorded
 *   first_heartbeat_throw        - the FIRST beat (second half of the gate) throws
 *   first_heartbeat_lost_lock    - the FIRST beat reports lost ownership
 *   periodic_heartbeat_throw     - a LATER beat throws, mid-run
 *   periodic_heartbeat_lost_lock - a LATER beat reports lost ownership, mid-run
 *
 * Those are preconditions failing INSIDE a live dispatch; there is no
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

/**
 * D-133: conservative cleanup of a task's isolated worktree.
 *
 * Called ONLY from a terminal reconciliation, and even then it does nothing
 * unless the task completed SUCCESSFULLY and its worktree is clean -
 * `releaseTaskWorktree` re-checks both, and the underlying `git worktree remove`
 * is deliberately unforced so git refuses on its own if either guard were wrong.
 *
 * Retention is the default and is never silent: the reason is logged, so a
 * directory kept because work is still uncommitted is visible rather than
 * mysterious. The claim file is never deleted, so the evidence of what ran there
 * outlives the directory.
 */
function releaseWorktreeIfSettled(cfg, taskId, successful) {
  let outcome;
  try {
    outcome = releaseTaskWorktree({ cfg, taskId, worktreeRoot: cfg.worktreeRoot, successful });
  } catch (err) {
    log(cfg, `Could not evaluate worktree release for ${taskId}: ${sanitize(err.message)}. Nothing was removed.`);
    return { released: false, retained: true, reason: "release_evaluation_failed" };
  }
  if (outcome.released) {
    log(cfg, `Released the isolated worktree for ${taskId} (${outcome.reason}). Its claim file is kept as evidence.`);
  } else if (outcome.retained) {
    log(cfg, `RETAINED the isolated worktree for ${taskId}: ${outcome.reason}. `
      + "Nothing was deleted - ownership or completion is not certain enough to clean up.");
  }
  return outcome;
}

/**
 * D-135: the completion gate, applied at EVERY place a task can be closed out.
 *
 * There are four of them, and that is the reason this is a helper rather than an
 * `if` in the dispatch path: `reconcileReportedTasks`, the crash-recovery
 * `COMPLETE_FROM_REPORT` branch, the pre-dispatch reconciliation in `runTask`
 * and the post-dispatch completion check all read the SAME trusted report and
 * all reach the same three effects (mark completed+successful, emit
 * completion-confirmed, release the worktree). A gate installed in one of them
 * would simply be walked around by the next run through another.
 *
 * D-136: the three NON-DISPATCH paths no longer inherit the verdict from the
 * previous attempt's record. That record is exactly what a crash in the ordinary
 * window does not leave behind - the worker persists IN_PROGRESS, the child
 * identity and the durable claim BEFORE spawning, and writes `commit_provenance`
 * only at the post-dispatch checkpoint AFTER the child exits - so a parent that
 * died between those two points left `null`, which D-135 passed.
 *
 * They now DERIVE the current verdict instead: durable claim -> exact isolated
 * worktree -> recorded attempt ids and baseline -> the worktree's HEAD right now
 * -> the full baseline..current range, classified by the same bounded fail-closed
 * rules the dispatch path uses. Anything missing, unreadable, drifted, diverged,
 * partial, unattributed or too large to examine comes back UNKNOWN/unverified.
 *
 * The derivation is skipped - and only skipped - for a report that is not a
 * SUCCESS claim, because the gate passes those without consulting provenance at
 * all and running git for them would be pure noise.
 *
 * Returns `{ gate, provenance }`. The caller must branch on `gate.held`.
 */
function completionGateFor(cfg, task, completion) {
  if (completion?.complete !== true || completion?.successful !== true) {
    return { gate: evaluateCompletionGate({ completion, provenance: null }), provenance: null };
  }
  const taskId = task?.task_id;
  let derived;
  try {
    derived = deriveReconciliationProvenance({ cfg, taskId, task, worktreeRoot: cfg.worktreeRoot });
  } catch (err) {
    // A derivation that THREW answered nothing. It is UNKNOWN, never "clean" -
    // and it is reported with the same shape as any other refusal so the gate
    // and the status comment do not need a special case for it.
    log(cfg, `Could not derive current commit provenance for ${taskId}: ${sanitize(err.message)}. `
      + "Treating it as UNVERIFIED.");
    derived = {
      state: "derivation_threw",
      provenance: {
        verdict: COMMIT_PROVENANCE.UNKNOWN,
        verified: false,
        derived_for_reconciliation: true,
        derivation_state: "derivation_threw",
        attributed_commits: [],
        unattributed_commits: [],
        unattributed_count: 0,
        checked_at: new Date().toISOString(),
        reason: `deriving current commit provenance threw: ${sanitize(err.message)}`
      }
    };
  }
  // A fresh look must never ERASE an earlier finding: a range a previous attempt
  // classified `unattributed` can look `unchanged` now simply because the ref was
  // moved back. Evidence may only ever downgrade, so the gate sees the WORSE of
  // the recorded verdict and the derived one.
  const provenance = reconciliationProvenanceForGate({
    stored: task?.commit_provenance ?? null,
    derived: derived.provenance
  });
  log(cfg, `RECONCILIATION_PROVENANCE for ${taskId}: derivation=${derived.state} `
    + `verdict=${provenance.verdict} verified=${provenance.verified}`
    + `${provenance.downgraded_by_recorded_verdict ? " (downgraded by the recorded verdict)" : ""} `
    + `(${provenance.reason})`);
  return { gate: evaluateCompletionGate({ completion, provenance }), provenance };
}

/**
 * Park a task whose successful-completion claim the gate refused.
 *
 * BLOCKED, not FAILED_RETRYABLE: the claim is that the work is DONE, so retrying
 * would re-run a task whose output already exists and would put a second child
 * on top of commits nobody has explained yet. BLOCKED is the state this worker
 * never replays on its own, which is exactly the "explicit reconciliation"
 * semantics required here.
 *
 * Nothing is released, nothing is removed, nothing is reverted. `successful` is
 * recorded as an explicit `false` rather than left absent, because the queue's
 * supersession rule demands a POSITIVE `true` and an absent field must never be
 * able to drift into meaning success.
 */
function parkHeldCompletion(cfg, state, token, taskId, { gate, completion, extra = {} }) {
  const worktreePath = (() => {
    try { return taskWorktreePath(cfg.worktreeRoot, taskId); } catch { return null; }
  })();

  log(cfg, `COMPLETION GATE HELD for ${taskId}: a trusted report claims success (comment `
    + `${gate.report_comment_id ?? "unknown"}, STATUS=${gate.report_status ?? "unknown"}), but commit `
    + `provenance is ${gate.provenance_verdict ?? "unknown"} (verified=false). The task is parked as `
    + "BLOCKED - NOT completed, NOT successful - and its worktree is RETAINED untouched.");
  for (const sha of gate.unattributed_commits ?? []) {
    log(cfg, `  UNEXPLAINED_COMMIT ${sha} (preserved, never adopted, never reverted)`);
  }

  upsertTask(state, taskId, {
    ...extra,
    status: TASK_STATUS.BLOCKED,
    // Explicitly false, and explicitly NOT `completed_at`: this task did not
    // complete, whatever the report says.
    successful: false,
    completion_gate: gate,
    report_comment_id: completion?.reportCommentId ?? null,
    report_status: completion?.status ?? null,
    report_status_canonical: completion?.canonicalStatus ?? null,
    last_failure_reason: `completion_gate_held (${gate.reason}: ${gate.provenance_verdict ?? "unknown"})`,
    blocked_at: new Date().toISOString(),
    child_identity: null,
    last_child_pid: null
  });
  state.last_run_at = new Date().toISOString();
  persistState(cfg, state, token);

  // Deliberately BLOCKED and NOT completion_confirmed: the health journal must
  // not show completed work that the worker itself refused to accept.
  emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, {
    task_id: taskId,
    reason: "completion_gate_held",
    gate_reason: gate.reason,
    verdict: gate.provenance_verdict,
    report_comment_id: gate.report_comment_id,
    report_status: gate.report_status,
    unattributed: gate.unattributed_commits ?? [],
    unattributed_count: gate.unattributed_count ?? 0,
    // Not retryable: a repeat dispatch is precisely what must not happen on top
    // of commits nobody has accounted for.
    retryable: false
  });

  reportStatus(cfg, {
    taskId,
    phase: "verify",
    // D-136: the gate's own reason is part of the dedup key. "the worker looked
    // and could not account for the range" and "no verdict existed at all" are
    // different findings, and one must never suppress the other's notice.
    reason: `completion_gate_held_${gate.reason}`,
    detail: describeCompletionGate({ taskId, gate, worktreePath }),
    nextAction: "Inspect the retained worktree and the unexplained commits listed above against the PR diff and CI. "
      + "Then reconcile explicitly: issue a FRESH TASK_ID to carry the work forward, or decide deliberately that it "
      + "is not wanted. This worker will not replay a blocked task, will not release the worktree, and will not let "
      + "this record retire any older task."
  });
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

  const unsafeIds = tasks.filter((t) => !isValidTaskId(t.taskId)).map((t) => t.taskId);
  if (unsafeIds.length > 0) {
    log(cfg, `Ignoring ${unsafeIds.length} trusted task(s) with an unsafe TASK_ID (it is used as a directory name): ${unsafeIds.map((i) => String(i).slice(0, 48)).join(", ")}`);
  }

  // --- D132: RETIRE FINISHED WORK BEFORE CHOOSING ANYTHING -----------------
  //
  // Every non-terminal task that has been dispatched at least once is checked
  // against the FRESH control-issue comments for a trusted terminal report -
  // regardless of whether its backoff has elapsed and regardless of whether it
  // would have been this run's candidate.
  //
  // This is the structural half of the D-131 repair. Previously a report was
  // only ever reconciled for the ONE task that happened to be selected, so a
  // finished task sitting in backoff kept its stale `failed_retryable` record
  // and returned to the front of the queue later. `findUnreconciledTasks` has
  // existed in state.mjs since D126 and was never called; it is now the basis of
  // this pass.
  const preReconciliation = reconcileReportedTasks(cfg, state, token, comments);

  // D-136: EVERY gate held this run, wherever it fired. D-135 only carried the
  // pre-selection pass into the exit code, so a hold raised during crash
  // recovery - which is the path the D-136 window actually lands on - still
  // exited 0 and told the supervisor the run had settled normally.
  const gateHeld = [...recovery.gateHeld, ...preReconciliation.gateHeld];

  // Requirement E: only already-authorised tasks. Nothing is invented here.
  const selection = selectNextTask({ tasks, state, comments, trustedAuthor: cfg.trustedAuthor, nowMs });

  // Persist the retirements the selection identified, so they survive a restart
  // and can never be re-decided differently by a later run.
  const retired = retireIneligibleTasks(cfg, state, token, selection);

  const candidate = selection.candidate;

  if (!candidate) {
    if (selection.waitingTaskIds.length > 0) {
      const first = selection.waitingTaskIds[0];
      log(cfg, `No task eligible right now; ${selection.waitingTaskIds.length} in backoff (next: ${first} at ${getTask(state, first)?.next_eligible_at}).`);
    } else {
      log(cfg, "No new trusted ARCHITECT_TASK found. Exiting cleanly.");
    }
    state.last_run_at = new Date().toISOString();
    persistState(cfg, state, token);
    // D-135: a run that parked a task fail-closed is NOT a healthy run. Exit 0
    // here would tell the supervisor - and the operator reading a task-scheduler
    // result code - that everything settled normally, when in fact work is
    // sitting in a retained worktree waiting for a human.
    if (gateHeld.length > 0) return EXIT.BLOCKED;
    return recovery.exit ?? (retired.blocked ? EXIT.BLOCKED : EXIT.OK);
  }

  log(cfg, `Next trusted task: TASK_ID=${candidate.taskId} (comment ${candidate.comment.id}, `
    + `posted ${candidate.comment.created_at}, ${candidate.updates.length} scope update(s), `
    + `tier=${selection.candidateTier === 0 ? "fresh" : "retry"}).`);
  heartbeat(cfg.lockFile, { token, phase: "preflight", taskId: candidate.taskId });

  const dispatchExit = await runTask(cfg, state, token, candidate, comments);
  // D-136: a successful dispatch of a DIFFERENT task does not make this run
  // healthy either. A held gate means work is parked in a retained worktree
  // waiting for a human, and that has to survive into the exit code whatever
  // else the run went on to do. Only an otherwise-clean run is downgraded -
  // a worse code from the dispatch itself is never softened.
  return dispatchExit === EXIT.OK && gateHeld.length > 0 ? EXIT.BLOCKED : dispatchExit;
}

/**
 * D132: close out every already-dispatched, non-terminal task that now has a
 * trusted terminal CLAUDE_REPORT.
 *
 * Runs under ownership, against comments fetched THIS run, before any candidate
 * is chosen. A task retired here is terminal, so no restart, no elapsed backoff
 * and no stale retry bookkeeping can bring it back.
 */
function reconcileReportedTasks(cfg, state, token, comments) {
  const unreconciled = findUnreconciledTasks(state);
  if (unreconciled.length === 0) return { reconciled: [], gateHeld: [] };

  const reconciled = [];
  const gateHeld = [];
  for (const task of unreconciled) {
    // IN_PROGRESS belongs to the recovery pass, which has already run and which
    // owns the live-child protection decision.
    if (task.status === TASK_STATUS.IN_PROGRESS) continue;

    const completion = assessCompletion({
      taskId: task.task_id,
      comments,
      trustedAuthor: cfg.trustedAuthor,
      sinceIso: task.first_dispatch_at ?? null
    });
    if (!completion.complete) continue;

    // D-135/D-136: a SUCCESSFUL claim standing on an unverified commit range is
    // parked, not retired as completed. The verdict is DERIVED from the task's
    // durable claim and the current state of its own worktree, not inherited
    // from a record a crashed parent may never have written.
    const { gate, provenance } = completionGateFor(cfg, task, completion);
    if (gate.held) {
      parkHeldCompletion(cfg, state, token, task.task_id, {
        gate,
        completion,
        extra: { reconciled_without_redispatch: true, reconciliation_provenance: provenance }
      });
      // Counted as reconciled: it IS retired from the dispatch queue (BLOCKED is
      // terminal). It is simply not retired as a SUCCESS - and the run itself
      // must not exit 0 on the back of it, which is what `gateHeld` carries.
      reconciled.push(task.task_id);
      gateHeld.push(task.task_id);
      continue;
    }

    log(cfg, `Retiring ${task.task_id} from its trusted terminal report `
      + `(comment ${completion.reportCommentId}, STATUS=${completion.status} -> ${completion.canonicalStatus}) `
      + "without re-dispatching.");
    upsertTask(state, task.task_id, {
      status: TASK_STATUS.COMPLETED,
      completed_at: new Date().toISOString(),
      report_comment_id: completion.reportCommentId,
      report_status: completion.status,
      report_status_canonical: completion.canonicalStatus,
      successful: completion.successful,
      reconciled_without_redispatch: true,
      // Recorded on the PASS path too, so the record always states positively
      // what the acceptance rested on rather than leaving it to be inferred.
      completion_gate: gate,
      reconciliation_provenance: provenance
    });
    emitHealth(cfg.healthFile, HEALTH_EVENTS.COMPLETION_CONFIRMED, {
      task_id: task.task_id,
      report_comment_id: completion.reportCommentId,
      report_status: completion.status,
      successful: completion.successful,
      via: "pre_selection_reconciliation"
    });
    releaseWorktreeIfSettled(cfg, task.task_id, completion.successful);
    reconciled.push(task.task_id);
  }

  if (reconciled.length > 0) {
    state.last_run_at = new Date().toISOString();
    persistState(cfg, state, token);
  }
  return { reconciled, gateHeld };
}

/**
 * D132: persist the retirements `selectNextTask` identified.
 *
 * Two kinds, both durable and both TERMINAL:
 *
 *   SUPERSEDED  a strictly newer trusted ARCHITECT_TASK has already completed.
 *               Nothing is silently dropped - `superseded_by` is recorded and a
 *               status notice is posted, so the architect can re-issue a FRESH
 *               TASK_ID if the old order is still wanted.
 *
 *   UNRECOGNISED REPORT STATUS
 *               a trusted report exists for the task but its STATUS is a
 *               spelling this worker does not know. Retrying on that basis is
 *               the exact D-131 loop, so the task is parked as BLOCKED and the
 *               vocabulary mismatch is reported rather than absorbed.
 */
function retireIneligibleTasks(cfg, state, token, selection) {
  let mutated = false;
  let blocked = false;

  for (const decision of selection.decisions) {
    const record = getTask(state, decision.taskId);
    if (!record || isTerminal(record)) continue;

    if (decision.reason === INELIGIBLE.SUPERSEDED) {
      // PR #80 review blocker 3: the BASIS is recorded, not just the id. A
      // retirement that cannot be traced back to positive successful completion
      // or to an exact trusted declaration is not auditable, and this is the
      // only place a task is silently taken out of the queue forever.
      log(cfg, `SUPERSEDED ${decision.taskId}: ${decision.supersessionDetail} `
        + `(basis=${decision.supersessionBasis}). Replaying this older order would apply a stale `
        + "instruction to changed state.");
      upsertTask(state, decision.taskId, {
        status: TASK_STATUS.SUPERSEDED,
        superseded_at: new Date().toISOString(),
        superseded_by: decision.supersededBy,
        superseded_basis: decision.supersessionBasis,
        superseded_declared_by_comment_id: decision.supersessionDeclaredByCommentId ?? null,
        last_failure_reason: `${decision.supersessionBasis} (${decision.supersededBy})`,
        child_identity: null
      });
      emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, {
        task_id: decision.taskId,
        reason: "superseded_by_newer_completed_task",
        superseded_by: decision.supersededBy,
        basis: decision.supersessionBasis
      });
      reportStatus(cfg, {
        taskId: decision.taskId,
        phase: "queue",
        reason: "superseded_by_newer_completed_task",
        detail: [
          `This task was issued at ${decision.createdAt ?? "an unknown time"} and had ${decision.attempts} attempt(s).`,
          `BASIS: ${decision.supersessionBasis}`,
          `EVIDENCE: ${decision.supersessionDetail}`,
          decision.supersessionDeclaredByCommentId !== null
            ? `DECLARED BY: trusted control-issue comment ${decision.supersessionDeclaredByCommentId}`
            : "DECLARED BY: nothing - retirement follows from the newer task's SUCCESSFUL completion.",
          "",
          "A newer task that ended BLOCKED, FAILED or with an unreadable status never retires an older",
          "one: it did not move the repository on, so the older order is not stale.",
          "",
          "NOTHING was reset, reverted or deleted. No repository action was taken for this task."
        ].join("\n"),
        nextAction: "If this older order is still wanted against CURRENT repository truth, issue a FRESH TASK_ID for it. The worker will not replay a superseded task on its own."
      });
      mutated = true;
      continue;
    }

    if (decision.reason === INELIGIBLE.UNRECOGNISED_REPORT_STATUS) {
      const raw = decision.completion?.status ?? "unknown";
      log(cfg, `BLOCKED ${decision.taskId}: a trusted report exists (comment ${decision.completion?.reportCommentId}) `
        + `but STATUS=${String(raw).slice(0, 48)} is not a spelling this worker recognises. `
        + "Refusing to retry on an unreadable status.");
      upsertTask(state, decision.taskId, {
        status: TASK_STATUS.BLOCKED,
        blocked_at: new Date().toISOString(),
        report_comment_id: decision.completion?.reportCommentId ?? null,
        report_status: raw,
        last_failure_reason: `report_status_unrecognised (${String(raw).slice(0, 48)})`,
        child_identity: null
      });
      emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, {
        task_id: decision.taskId, reason: "report_status_unrecognised", report_status: String(raw).slice(0, 48)
      });
      reportStatus(cfg, {
        taskId: decision.taskId,
        phase: "queue",
        reason: "report_status_unrecognised",
        detail: [
          `A TRUSTED CLAUDE_REPORT for this task exists (comment ${decision.completion?.reportCommentId ?? "unknown"}),`,
          `but its STATUS value is ${JSON.stringify(String(raw).slice(0, 64))}, which this worker's canonical`,
          "vocabulary does not contain - so it can be read neither as completion nor as progress.",
          "",
          "The task is parked as BLOCKED rather than retried. Retrying on an unreadable status is exactly",
          "how a finished task gets dispatched again (D-131).",
          "",
          "Terminal spellings: " + TERMINAL_REPORT_STATUSES.join(", "),
          "Non-terminal spellings: " + NON_TERMINAL_STATUSES.join(", ")
        ].join("\n"),
        nextAction: "Confirm from the report whether the task actually finished. If it did, no action is needed beyond using a canonical STATUS next time; if it did not, issue a FRESH TASK_ID."
      });
      mutated = true;
      blocked = true;
    }
  }

  if (mutated) {
    state.last_run_at = new Date().toISOString();
    persistState(cfg, state, token);
  }
  return { mutated, blocked };
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
  if (abandoned.length === 0) return { stop: false, exit: null, gateHeld: [] };

  const lifetimeBudgetMs = childLifetimeBudgetMs({ claudeTimeoutMinutes: cfg.claudeTimeoutMinutes });
  const branchLookup = listRemoteBranches(cfg);
  const pullLookup = listPulls(cfg);
  const gateHeld = [];
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
      return { stop: true, exit: EXIT.BLOCKED, gateHeld };
    }

    const observed = mergeObservedAssociations(task, {
      branch: rec.existingBranch,
      prNumber: rec.existingPr?.number ?? rec.prNumberKnownButUnverified
    });

    if (plan.action === RECOVERY.COMPLETE_FROM_REPORT) {
      // D-135/D-136: the gate applies to crash recovery too, and THIS is the
      // path the D-136 kill window lands on. A parent that died after its child
      // posted `STATUS=COMPLETE` but before the post-dispatch provenance
      // checkpoint leaves NO recorded verdict, so the verdict is derived here
      // from the durable claim and the worktree's actual current HEAD. It must
      // not be able to launder an unaccounted-for commit range into a successful
      // completion on the next run.
      const { gate, provenance } = completionGateFor(cfg, task, rec.completion);
      if (gate.held) {
        parkHeldCompletion(cfg, state, token, taskId, {
          gate,
          completion: rec.completion,
          extra: {
            ...observed,
            reconciled_without_redispatch: true,
            recovered_from_crash: true,
            reconciliation_provenance: provenance
          }
        });
        gateHeld.push(taskId);
        mutated = true;
        continue;
      }
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
        completion_gate: gate,
        reconciliation_provenance: provenance,
        child_identity: null,
        last_child_pid: null
      });
      emitHealth(cfg.healthFile, HEALTH_EVENTS.COMPLETION_CONFIRMED, {
        task_id: taskId, report_comment_id: rec.completion.reportCommentId, via: "crash_recovery"
      });
      releaseWorktreeIfSettled(cfg, taskId, rec.completion.successful);
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
  return { stop: false, exit: null, gateHeld };
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
      // D-135/D-136: "the work IS done" is the CLAIM, and this is the last place
      // it can be accepted without the verdict being consulted. Gate it here too,
      // on a FRESHLY DERIVED verdict rather than on whatever the previous attempt
      // did or did not manage to record before it died.
      const { gate, provenance } = completionGateFor(cfg, prior, rec.completion);
      if (gate.held) {
        parkHeldCompletion(cfg, state, token, taskId, {
          gate,
          completion: rec.completion,
          extra: {
            ...mergeObservedAssociations(prior, { branch: rec.existingBranch, prNumber: rec.existingPr?.number }),
            reconciled_without_redispatch: true,
            reconciliation_provenance: provenance
          }
        });
        return EXIT.BLOCKED;
      }
      // Crash-after-report case: the work IS done; close it out, do not re-run.
      log(cfg, `Reconciled: a matching trusted report already exists (comment ${rec.completion.reportCommentId}, STATUS=${rec.completion.status}). Marking complete without re-dispatching.`);
      upsertTask(state, taskId, {
        ...mergeObservedAssociations(prior, { branch: rec.existingBranch, prNumber: rec.existingPr?.number }),
        status: TASK_STATUS.COMPLETED,
        completed_at: new Date().toISOString(),
        report_comment_id: rec.completion.reportCommentId,
        report_status: rec.completion.status,
        successful: rec.completion.successful,
        reconciled_without_redispatch: true,
        completion_gate: gate,
        reconciliation_provenance: provenance
      });
      state.last_run_at = new Date().toISOString();
      persistState(cfg, state, token);
      emitHealth(cfg.healthFile, HEALTH_EVENTS.COMPLETION_CONFIRMED, {
        task_id: taskId, report_comment_id: rec.completion.reportCommentId, via: "reconciliation"
      });
      releaseWorktreeIfSettled(cfg, taskId, rec.completion.successful);
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
      duplicateRiskUnknown: rec.duplicateRiskUnknown,
      // D-134: the commit-authorship verdict is NOT built here. `head_before` /
      // `head_after` / `observed_heads` are observations, and turning them into
      // an authorship claim is the exact defect this round removes. The verdict
      // recorded at the END of the previous attempt is re-checked against the
      // worktree's CURRENT head once the isolated context is established, below.
      provenance: null,
      observedHeads: prior.observed_heads ?? []
    };
    upsertTask(state, taskId, mergeObservedAssociations(prior, {
      branch: rec.existingBranch,
      prNumber: rec.existingPr?.number ?? rec.prNumberKnownButUnverified,
      head: prior.head_after ?? null
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

  // --- D-133: ESTABLISH THE TASK'S ISOLATED CONTEXT, BEFORE ANY MUTATION ----
  //
  // The dirty guard above protects the USER's checkout and is unchanged. This
  // step gives the task somewhere of its own to be dirty in, with a durable
  // ownership claim written before the worktree it covers exists.
  //
  // Every refusal here is FAIL-CLOSED: the task stays non-terminal and eligible,
  // nothing is stashed, reset, cleaned, deleted or adopted, and the exact reason
  // - including the precise path and what was found there - is reported.
  const attempts = (prior?.attempts ?? 0) + 1;
  const attemptId = randomUUID();
  heartbeat(cfg.lockFile, { token, phase: "worktree", taskId });
  const workspace = establishTaskWorktree({
    cfg,
    taskId,
    comment: candidate.comment,
    worktreeRoot: cfg.worktreeRoot,
    baselineSha: facts.head,
    baselineBranch: facts.branch,
    attempt: attempts,
    attemptId,
    workerVersion: WORKER_VERSION
  });

  if (!workspace.ok) {
    log(cfg, `BLOCKED: could not establish the isolated worktree for ${taskId} (${workspace.state}): ${workspace.reason}`);
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, {
      task_id: taskId, reason: "task_worktree_unavailable", worktree_state: workspace.state
    });
    reportStatus(cfg, {
      taskId,
      phase: "worktree",
      reason: `task_worktree_${workspace.state}`,
      detail: describeRefusal({ taskId, path: workspace.path, state: workspace.state, reason: workspace.reason, claim: workspace.claim }),
      nextAction: "Inspect the listed path by hand. If it holds work you want, move or commit it deliberately; "
        + "if it is genuinely yours to discard, remove it yourself. The worker will never adopt or destroy "
        + "content it cannot attribute. The next scheduled run then dispatches this same task automatically."
    });
    state.last_run_at = new Date().toISOString();
    persistState(cfg, state, token);
    return EXIT.BLOCKED; // task stays non-terminal and eligible - NOT processed
  }

  log(cfg, `Task worktree ${workspace.created ? "CREATED" : "RESUMED"} at ${workspace.path} `
    + `(baseline=${facts.head}, head=${workspace.head ?? "unknown"}, branch=${workspace.branch ?? "unknown"}, `
    + `task-owned uncommitted entries=${workspace.dirty.length}).`);
  if (workspace.dirty.length > 0) {
    for (const line of workspace.dirty) log(cfg, `  TASK_OWNED_DIRTY ${line}`);
  }
  emitHealth(cfg.healthFile, HEALTH_EVENTS.PREFLIGHT, {
    task_id: taskId,
    worktree: workspace.created ? "created" : "resumed",
    worktree_path: workspace.path,
    task_owned_dirty_entries: workspace.dirty.length,
    head: workspace.head,
    branch: workspace.branch
  });

  // --- D-134: RE-CHECK the recorded commit verdict against the CURRENT head ---
  //
  // The verdict stored at the end of the previous attempt was true when it was
  // computed. Since then the worktree has sat on disk with nobody watching it,
  // so a stored "verified" answer is only still usable if HEAD has not moved in
  // the meantime. Drift can only ever DOWNGRADE the record; nothing here can
  // promote an unproven range into a proven one.
  if (resume) {
    resume.provenance = provenanceForResume({
      record: prior?.commit_provenance ?? null,
      headNow: workspace.head,
      headBefore: prior?.head_before ?? null,
      headAfter: prior?.head_after ?? null
    });
    if (resume.provenance && resume.provenance.verdict !== COMMIT_PROVENANCE.UNCHANGED) {
      log(cfg, `COMMIT_PROVENANCE for ${taskId}: verdict=${resume.provenance.verdict} `
        + `verified=${resume.provenance.verified} (${resume.provenance.reason})`);
    }
  }

  // --- mark in progress and dispatch ---
  // TASK_ID has already been validated as a single safe path component.
  const scratchDir = join(cfg.scratchRoot, taskId);
  mkdirSync(scratchDir, { recursive: true });

  const dispatchStartedAt = new Date().toISOString();
  upsertTask(state, taskId, {
    status: TASK_STATUS.IN_PROGRESS,
    attempts,
    attempt_id: attemptId,
    first_dispatch_at: prior?.first_dispatch_at ?? dispatchStartedAt,
    last_dispatch_at: dispatchStartedAt,
    comment_id: candidate.comment.id,
    // D-133: `branch_before` / `head_before` describe the TASK'S OWN context,
    // not the user's checkout. Recording the primary checkout's head here would
    // make a resumed child compare its work against a tree it never touched.
    branch_before: workspace.branch,
    head_before: workspace.head,
    primary_branch_at_dispatch: facts.branch,
    primary_head_at_dispatch: facts.head,
    worktree_path: workspace.path,
    worktree_claim_file: workspace.claimFile,
    worktree_baseline_sha: workspace.claim?.baseline_sha ?? facts.head,
    worktree_task_owned_dirty: workspace.dirty,
    child_identity: null
  });
  persistState(cfg, state, token);

  log(cfg, `Dispatching TASK_ID=${taskId} attempt ${attempts} in ${workspace.path} `
    + `(branch=${workspace.branch}, head=${workspace.head})...`);
  emitHealth(cfg.healthFile, HEALTH_EVENTS.DISPATCH_STARTED, { task_id: taskId, attempt: attempts, head: workspace.head });

  let beatCount = 0;
  const result = await runClaude(cfg, {
    ...candidate,
    resume,
    scratchDir,
    workspace: {
      path: workspace.path,
      baselineSha: workspace.claim?.baseline_sha ?? facts.head,
      baselineBranch: workspace.claim?.baseline_branch ?? facts.branch,
      dirty: workspace.dirty,
      // D-134: the identity the child must stamp onto every commit it makes.
      // Without it there is no positive evidence, and the next resume has no
      // way to tell this attempt's commits from anyone else's.
      taskId,
      attemptId
    }
  }, {
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
    // REVIEW F, finding 3: this callback used to DISCARD the boolean.
    // `lock.heartbeat` reports lost ownership by returning false rather than by
    // throwing (see the explicit check in `onSpawn` above), so ignoring it made
    // ownership loss mid-dispatch completely invisible: the run kept beating
    // into a lock another instance had already reclaimed and still reported a
    // healthy dispatch. The result is now returned to `runClaude`, which treats
    // a strict `false` as a failure - fatal for the FIRST beat (the child is
    // aborted before the task is delivered) and recorded but non-fatal for
    // later beats, because a child doing legitimate authorized work must not be
    // killed over our bookkeeping.
    onHeartbeat: (childPid, identity) => {
      // The first call is the second half of the handoff gate; every later one
      // is a periodic renewal. The two have deliberately different consequences,
      // so the injected faults address them separately.
      beatCount += 1;
      const first = beatCount === 1;
      if (faultArmed(first ? "first_heartbeat_throw" : "periodic_heartbeat_throw")) {
        throw new Error(`durable write failed (injected fault: ${first ? "first" : "periodic"}_heartbeat_throw)`);
      }
      const beatOk = !faultArmed(first ? "first_heartbeat_lost_lock" : "periodic_heartbeat_lost_lock")
        && heartbeat(cfg.lockFile, { token, phase: "dispatch", taskId, childPid, childIdentity: identity });
      emitHealth(cfg.healthFile, HEALTH_EVENTS.HEARTBEAT, {
        task_id: taskId, child_pid: childPid, lock_ownership: beatOk ? "held" : "lost"
      });
      return beatOk;
    }
  });

  emitHealth(cfg.healthFile, HEALTH_EVENTS.DISPATCH_EXITED, {
    task_id: taskId, outcome: result.outcome, code: result.code ?? null, child_pid: result.childPid ?? null
  });

  // --- ADDENDUM ITEM 4: an unsupported delivery mode never creates a child ---
  // `loadWorkerConfig` already rejects anything but stdin, so reaching this is
  // a programming error rather than an operator mistake. It is still handled
  // explicitly: nothing was spawned, so there is no child to abort and no
  // outcome to assess, and the run must park truthfully instead of falling
  // through into a completion check for a task that was never delegated.
  if (result.outcome === OUTCOME.UNSUPPORTED_PROMPT_DELIVERY) {
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, {
      task_id: taskId, reason: "unsupported_prompt_delivery", child_pid: null
    });
    log(cfg, `BLOCKED for TASK_ID=${taskId}: ${result.error} No child process was created.`);
    upsertTask(state, taskId, {
      status: TASK_STATUS.BLOCKED,
      last_outcome: result.outcome,
      last_dispatch_finished_at: new Date().toISOString(),
      last_failure_reason: `unsupported_prompt_delivery (${result.error})`,
      blocked_at: new Date().toISOString(),
      child_identity: null,
      last_child_pid: null
    });
    state.last_run_at = new Date().toISOString();
    persistState(cfg, state, token);
    reportStatus(cfg, {
      taskId,
      phase: "dispatch",
      reason: "unsupported_prompt_delivery",
      detail: [result.error, "Nothing was spawned and the task was not delivered to any process."]
    });
    return EXIT.BLOCKED;
  }

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

  // --- REVIEW F: a dispatch whose heartbeats never recovered is NOT healthy ---
  //
  // The periodic heartbeat is what keeps this worker's claim on the lock alive.
  // If it threw and never recovered, or if it reported LOST OWNERSHIP, then for
  // some part of the run another instance may have believed the lock was free.
  // The child was deliberately left alone - it was doing authorized work and
  // killing it is never the answer here - but its exit code proves nothing about
  // OUR bookkeeping, and this run's in-memory state is no longer authoritative.
  //
  // So the run fails closed: it is parked as BLOCKED, which the worker never
  // replays on its own, rather than assessed for completion. That is the whole
  // point - a duplicate dispatch on top of a live or just-finished child is
  // exactly what a stale lock invites.
  const beatHealth = result.heartbeat ?? null;
  if (beatHealth?.unrecovered) {
    const lostOwnership = beatHealth.ownership_lost === true;
    const reason = lostOwnership ? "lock_ownership_lost_during_dispatch" : "heartbeat_unrecovered_during_dispatch";
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, {
      task_id: taskId,
      reason,
      child_pid: result.childPid ?? null,
      outcome: result.outcome,
      heartbeat_failures: beatHealth.failures,
      heartbeat_ownership_lost: lostOwnership
    });
    log(cfg, `BLOCKED for TASK_ID=${taskId}: ${reason}. Dispatch outcome was ${result.outcome}, but `
      + `${beatHealth.failures} heartbeat(s) failed and the last one did not recover `
      + `(ownership_lost=${lostOwnership}). The child was NOT killed; completion is NOT claimed.`);
    let persisted = false;
    try {
      upsertTask(state, taskId, {
        status: TASK_STATUS.BLOCKED,
        last_outcome: result.outcome,
        last_exit_code: result.code ?? null,
        last_child_pid: result.childPid ?? null,
        last_dispatch_finished_at: new Date().toISOString(),
        last_failure_reason: `${reason} (${beatHealth.last_error ?? "no detail"})`,
        blocked_at: new Date().toISOString(),
        heartbeat_failures: beatHealth.failures,
        heartbeat_ownership_lost: lostOwnership,
        // The exact identity is kept: it is what an operator needs to check
        // whether that specific process is still around.
        child_identity: result.childIdentity ?? null
      });
      state.last_run_at = new Date().toISOString();
      persistState(cfg, state, token);
      persisted = true;
    } catch (err) {
      // Expected when ownership really is gone - `persistState` refuses to write
      // state this process no longer owns. The exit code stays truthful.
      log(cfg, `Could not record the degraded dispatch in worker state: ${sanitize(err.message)}`);
    }
    try {
      reportStatus(cfg, {
        taskId,
        phase: "dispatch",
        reason,
        detail: [
          `The dispatch finished with outcome=${result.outcome}, but the worker lock heartbeat failed `
            + `${beatHealth.failures} time(s) during the run and had NOT recovered when it settled.`,
          lostOwnership
            ? "The lock heartbeat reported LOST OWNERSHIP: another instance may have reclaimed the lock while this child was running."
            : `Last heartbeat error: ${beatHealth.last_error ?? "unknown"}.`,
          `Child pid ${result.childPid ?? "unknown"} was NOT terminated - it was doing authorized work, and this is a bookkeeping failure, not a reason to kill it.`,
          "Completion was NOT assessed and NOT claimed. The task is parked as BLOCKED so no run replays it on top of that work.",
          persisted ? "The outcome was recorded in worker state." : "Worker state could NOT be written; only this status and the exit code record the outcome."
        ].join("\n"),
        nextAction: "Confirm no second worker instance is running and that the lock file is writable, verify the recorded child_identity and the control issue for a posted report, then issue a FRESH TASK_ID. The worker will not replay a blocked task on its own."
      });
    } catch (err) {
      log(cfg, `Could not post the degraded-heartbeat status: ${sanitize(err.message)}`);
    }
    return EXIT.BLOCKED;
  }

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

  // D-133: every "after" fact is read from the TASK'S OWN worktree. Reading the
  // primary checkout here would record the user's HEAD as this task's result and
  // make the provenance handed to a resumed child actively misleading.
  const wtCfg = atPath(cfg, workspace.path);
  const headAfter = gitHead(wtCfg);
  const branchAfter = gitCurrentBranch(wtCfg);
  const dirtyAfter = gitStatusLines(wtCfg);

  // --- D-134: ANSWER THE AUTHORSHIP QUESTION, DO NOT ASSUME IT ---------------
  //
  // `head_before` and `head_after` are two reads of a ref taken at two moments.
  // They establish THAT it moved, never WHO moved it, and the worker is the only
  // actor in a position to look for real evidence while the range is still
  // small: the commits in it either carry this task's own attempt trailers or
  // they do not. The verdict is computed once, here, and stored - so a later
  // resume reads a recorded answer instead of re-deriving one from an inference.
  //
  // Every attempt id the CLAIM has ever recorded is accepted, not just this
  // attempt's: a commit made by an earlier attempt of the SAME task is still
  // this task's work. Nothing outside the claim can widen that set.
  const claimedAttemptIds = (workspace.claim?.attempts ?? [])
    .map((a) => a?.attempt_id)
    .filter((a) => typeof a === "string" && a.length > 0);
  const commitProvenance = collectCommitProvenance(wtCfg, {
    taskId,
    attemptIds: claimedAttemptIds.includes(attemptId) ? claimedAttemptIds : [...claimedAttemptIds, attemptId],
    headBefore: workspace.head,
    headAfter: headAfter.ok ? headAfter.value : null
  });
  if (commitProvenance.verdict !== COMMIT_PROVENANCE.UNCHANGED) {
    log(cfg, `COMMIT_PROVENANCE for ${taskId} attempt ${attempts}: verdict=${commitProvenance.verdict} `
      + `verified=${commitProvenance.verified} (${commitProvenance.reason})`);
    for (const c of commitProvenance.unattributed_commits) {
      log(cfg, `  UNATTRIBUTED_COMMIT ${c.sha} ${c.subject} [${c.reason}]`);
    }
  }
  if (!commitProvenance.verified) {
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, {
      task_id: taskId,
      reason: "commit_provenance_unverified",
      verdict: commitProvenance.verdict,
      // The FINDING, emitted so an unexplained commit is VISIBLE in the health
      // journal rather than only inside a prompt nobody reads later. What it
      // COSTS the task is decided below, not here: D-135 added the completion
      // gate, so an unverified verdict is a hard stop when the task also claims
      // successful completion, and is merely recorded otherwise. `retryable` is
      // therefore deliberately absent - this event no longer knows the answer,
      // and a `completion_gate_held` event carries it when the gate fires.
      unattributed: commitProvenance.unattributed_commits.map((c) => c.sha),
      unattributed_count: commitProvenance.unattributed_count ?? commitProvenance.unattributed_commits.length
    });
  }

  const checkpoint = {
    last_outcome: result.outcome,
    last_exit_code: result.code ?? null,
    last_child_pid: result.childPid ?? null,
    last_dispatch_finished_at: new Date().toISOString(),
    branch_before: workspace.branch,
    head_before: workspace.head,
    head_after: headAfter.ok ? headAfter.value : null,
    head_after_error: headAfter.ok ? null : headAfter.error,
    branch_after: branchAfter.ok ? branchAfter.value : null,
    branch_after_error: branchAfter.ok ? null : branchAfter.error,
    // D-134: the VERDICT, not the raw observation. `head_before`/`head_after`
    // above remain exactly what they always were - observations - and are never
    // read as authorship anywhere.
    commit_provenance: commitProvenance,
    // The task-owned uncommitted state this attempt LEFT BEHIND. This is the
    // record that turns "exited without a report having changed files" from a
    // stranded, unattributable mess into a resumable task context.
    worktree_path: workspace.path,
    worktree_task_owned_dirty: dirtyAfter.ok ? dirtyAfter.lines : null,
    worktree_dirty_query_error: dirtyAfter.ok ? null : dirtyAfter.error
  };
  if (dirtyAfter.ok && dirtyAfter.lines.length > 0) {
    log(cfg, `TASK_ID=${taskId} left ${dirtyAfter.lines.length} task-owned uncommitted entry/entries in its own `
      + `worktree (${workspace.path}). They are recorded as task-owned and will be resumed, not discarded.`);
  }

  // The branch this attempt actually ended on is an EXACT association: record it
  // so a later reconciliation never has to guess (blocker 6). The head is
  // recorded alongside it as a SIGHTING - "this commit existed here when the
  // worker looked" - and D-134 removed the step that used to read that log as
  // proof of what the task had authored.
  const observed = mergeObservedAssociations(getTask(state, taskId), {
    branch: checkpoint.branch_after,
    head: checkpoint.head_after
  });

  // --- D-135: THE COMPLETION GATE ------------------------------------------
  //
  // This is the path the PR #80 review found fail-open, and the adversarial case
  // is concrete: an unrelated writer advances the claimed worktree's HEAD while
  // the child runs, the child posts a perfectly genuine, perfectly trusted
  // `STATUS=COMPLETE`, and `completion.complete` is true. D-134 already knew the
  // range was unattributed - it had just computed and logged exactly that - and
  // the branch below went on to mark the task completed AND successful, emit
  // COMPLETION_CONFIRMED, and release the worktree holding the unexplained
  // commit. The verdict was evidence nobody was allowed to act on.
  //
  // The gate is evaluated on the FRESH verdict computed a few lines above, from
  // this task's own worktree, using attempt ids that existed only for this task.
  const completionGate = evaluateCompletionGate({ completion, provenance: commitProvenance });
  if (completionGate.held) {
    parkHeldCompletion(cfg, state, token, taskId, {
      gate: completionGate,
      completion,
      // The full checkpoint is kept: head_before/head_after, the provenance
      // verdict, the task-owned dirty lines and the worktree path are exactly
      // what a human reconciling this needs, and none of it is a claim of
      // ownership - they are observations plus one honest verdict.
      extra: { ...checkpoint, ...observed }
    });
    return EXIT.BLOCKED;
  }

  if (completion.complete) {
    upsertTask(state, taskId, {
      ...checkpoint,
      ...observed,
      status: TASK_STATUS.COMPLETED,
      // Recorded even when it passes, so the record always states positively WHY
      // the claim was accepted rather than leaving that to be inferred.
      completion_gate: completionGate,
      completed_at: new Date().toISOString(),
      report_comment_id: completion.reportCommentId,
      report_status: completion.status,
      report_status_canonical: completion.canonicalStatus,
      successful: completion.successful,
      child_identity: null,
      last_child_pid: null
    });
    state.last_run_at = new Date().toISOString();
    persistState(cfg, state, token);
    emitHealth(cfg.healthFile, HEALTH_EVENTS.COMPLETION_CONFIRMED, {
      task_id: taskId, report_comment_id: completion.reportCommentId, report_status: completion.status,
      successful: completion.successful
    });
    log(cfg, `TASK_ID=${taskId} COMPLETE - matching trusted report ${completion.reportCommentId} (STATUS=${completion.status}).`);
    releaseWorktreeIfSettled(cfg, taskId, completion.successful);
    return EXIT.OK;
  }

  // --- D132: AN UNREADABLE STATUS IS NEVER A REASON TO RETRY ----------------
  //
  // The child posted a TRUSTED report for this exact task, but its STATUS is a
  // spelling the canonical vocabulary does not contain, so it can be read
  // neither as completion nor as progress. Retrying here is the precise
  // mechanism of the D-131 loop: `STATUS=COMPLETE` fell outside the vocabulary,
  // was recorded as `report_status_not_terminal (COMPLETE)`, and the finished
  // task was dispatched again and again.
  //
  // Fail closed: park it as BLOCKED - which the worker never replays on its own
  // - and make the vocabulary mismatch visible instead of absorbing it.
  if (completion.reportCommentId !== null && completion.statusRecognised === false) {
    log(cfg, `BLOCKED for TASK_ID=${taskId}: a trusted report (comment ${completion.reportCommentId}) exists but `
      + `STATUS=${String(completion.status).slice(0, 48)} is not recognised. NOT retrying on an unreadable status.`);
    upsertTask(state, taskId, {
      ...checkpoint,
      ...observed,
      status: TASK_STATUS.BLOCKED,
      report_comment_id: completion.reportCommentId,
      report_status: completion.status,
      last_failure_reason: `report_status_unrecognised (${String(completion.status).slice(0, 48)})`,
      blocked_at: new Date().toISOString(),
      child_identity: null
    });
    state.last_run_at = new Date().toISOString();
    persistState(cfg, state, token);
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, {
      task_id: taskId, reason: "report_status_unrecognised", report_status: String(completion.status).slice(0, 48)
    });
    reportStatus(cfg, {
      taskId,
      phase: "verify",
      reason: "report_status_unrecognised",
      detail: [
        `The dispatch finished (outcome=${result.outcome}) and a TRUSTED CLAUDE_REPORT for this exact TASK_ID`,
        `was posted (comment ${completion.reportCommentId}), but its STATUS value is`,
        `${JSON.stringify(String(completion.status).slice(0, 64))}, which is not in this worker's canonical vocabulary.`,
        "",
        "It is therefore readable neither as completion nor as progress, and the task is parked as BLOCKED",
        "rather than retried - retrying on an unreadable status is how a finished task gets run again.",
        "",
        "Terminal spellings: " + TERMINAL_REPORT_STATUSES.join(", "),
        "Non-terminal spellings: " + NON_TERMINAL_STATUSES.join(", ")
      ].join("\n"),
      nextAction: "Read the report and confirm whether the work finished. If it did, use a canonical STATUS next time; if it did not, issue a FRESH TASK_ID."
    });
    return EXIT.BLOCKED;
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
          ? "The task worktree's HEAD did not move during the last attempt."
          : `The task worktree's HEAD moved ${checkpoint.head_before} -> ${checkpoint.head_after} on branch `
            + `${checkpoint.branch_after}. That is an OBSERVATION, not a statement about who committed: `
            + `commit-authorship verdict = ${commitProvenance.verdict} (verified=${commitProvenance.verified}).`,
        commitProvenance.verified
          ? ""
          : `Unexplained commits (preserved, never adopted, never reverted): `
            + `${commitProvenance.unattributed_commits.map((c) => c.sha.slice(0, 12)).join(", ") || "none listed"}.`,
        "The task is NOT marked processed and NOT silently dropped; it is parked as BLOCKED."
      ].filter((l) => l !== "").join("\n"),
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

/**
 * Read-only description of a task's isolated context, for `status` and the dry
 * run. Takes no lock and mutates nothing; an unanswerable git query is reported
 * as unknown, never as clean.
 */
function describeTaskWorktree(cfg, taskId) {
  let path;
  let claimFile;
  try {
    path = taskWorktreePath(cfg.worktreeRoot, taskId);
    claimFile = claimFilePath(cfg.worktreeRoot, taskId);
  } catch (err) {
    return { path: null, claim_state: null, error: sanitize(err.message) };
  }
  const claimRead = readClaim(claimFile);
  const exists = existsSync(path);
  const status = exists ? gitStatusLines(atPath(cfg, path)) : { ok: true, lines: [] };
  return {
    path,
    exists,
    claim_state: claimRead.ok ? claimRead.claim.state : null,
    claim_problem: claimRead.ok ? null : claimRead.reason,
    baseline_sha: claimRead.ok ? claimRead.claim.baseline_sha : null,
    task_comment_id: claimRead.ok ? claimRead.claim.task_comment_id : null,
    latest_attempt_id: claimRead.ok ? claimRead.claim.latest_attempt_id : null,
    status_query_ok: status.ok,
    task_owned_dirty_entries: status.ok ? status.lines : null,
    status_query_error: status.ok ? null : status.error
  };
}

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
  // D132: the dry run must preview the SAME decision the real run would make,
  // including tiering and supersession - otherwise it cannot be used to verify
  // queue behaviour on the host, which is exactly what was needed here.
  const selection = selectNextTask({
    tasks, state: loaded.state, comments, trustedAuthor: cfg.trustedAuthor, nowMs
  });
  const status = gitStatusLines(cfg);
  console.log(JSON.stringify({
    dry_run: true,
    wrote_anything: false,
    took_lock: false,
    state_source: loaded.source,
    first_run: loaded.first_run,
    abandoned_in_progress: abandoned.map((t) => ({ task_id: t.task_id, child_pid: t.child_identity?.pid ?? null })),
    next_candidate: selection.candidate?.taskId ?? null,
    next_candidate_tier: selection.candidateTier === 0 ? "fresh" : (selection.candidateTier === 1 ? "retry" : null),
    would_retire_superseded: selection.supersededTaskIds,
    would_retire_from_report: selection.completedByReportTaskIds,
    unrecognised_report_status: selection.unrecognisedStatusTaskIds,
    waiting_for_backoff: selection.waitingTaskIds,
    queue_decisions: selection.decisions.map((d) => ({
      task_id: d.taskId,
      eligible: d.eligible,
      reason: d.reason,
      tier: d.tier,
      attempts: d.attempts,
      // PR #80 blocker 3: the dry run must show WHY a retirement would happen,
      // or the host cannot verify that an unsuccessful newer task is no longer
      // silently invalidating older work.
      superseded_by: d.supersededBy ?? null,
      supersession_basis: d.supersessionBasis ?? null
    })),
    newest_successful_task: selection.newestSuccessfulTaskId,
    // The USER's checkout. A task's own dirt never appears here by construction.
    primary_worktree_query_ok: status.ok,
    primary_worktree_dirty_entries: status.ok ? status.lines : null,
    primary_worktree_query_error: status.ok ? null : status.error,
    // D-133: each known task's own isolated context, including the uncommitted
    // work it owns. This is what makes "task-owned, not stranded" inspectable.
    task_worktrees: Object.keys(loaded.state.tasks ?? {}).map((id) => ({
      task_id: id, ...describeTaskWorktree(cfg, id)
    })),
    // Retained under the pre-D133 names so existing host tooling still parses.
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
      observed_pr_numbers: t.observed_pr_numbers ?? [],
      // D-133: the task's own isolated context, so an operator can see WHERE a
      // task's uncommitted work lives without guessing - and see that it is
      // attributed rather than anonymous.
      worktree: describeTaskWorktree(cfg, t.task_id)
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

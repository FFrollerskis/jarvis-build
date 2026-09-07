#!/usr/bin/env node
/**
 * Jarvis Architect <-> Claude worker (v2, self-recovering).
 *
 * Polls the GitHub control issue for trusted ARCHITECT_TASK comments and
 * dispatches at most ONE per invocation to a non-interactive Claude Code
 * session. Claude itself posts CLAUDE_ACK / CLAUDE_REPORT, does the git work
 * and performs merges when a task explicitly authorises one; this script only
 * detects, validates trust, quarantines legacy scratch, dispatches, and then
 * records the outcome HONESTLY.
 *
 * What changed in v2 (see ops/claude-worker/README.md and D-126):
 *   A. legacy in-repo scratch is quarantined outside the repo before the dirty
 *      guard, with provenance checks - no more permanent "dirty worktree" stall;
 *   B. timeout / non-zero / spawn error / missing report never mark a task
 *      processed, and completion requires a matching trusted CLAUDE_REPORT;
 *   C. the single-worker lock spans preflight..state-write and uses process
 *      identity + heartbeat instead of a pid and an age budget;
 *   D. bounded retries with backoff, and a deduplicated control-queue status on
 *      repeated failure - never a silent exit 0 while blocked;
 *   E. only the already-authorised task is ever resumed;
 *   F. distinct health events, so "the scheduler ran" is never mistaken for
 *      "the work completed".
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { WORKER_VERSION, loadWorkerConfig } from "./lib/config.mjs";
import { HEALTH_EVENTS, emitHealth, readHealth, summarizeHealth, sanitize } from "./lib/health.mjs";
import { TASK_STATUS, loadState, saveStateAtomic, upsertTask, getTask, isEligibleNow, isTerminal } from "./lib/state.mjs";
import { acquireLock, heartbeat, releaseLock, readLock, isProcessAlive } from "./lib/lock.mjs";
import { recoverScratch } from "./lib/quarantine.mjs";
import { collectTrustedTasks } from "./lib/trust.mjs";
import { assessCompletion, reconcilePriorAttempt, computeBackoff, shouldPostStatus, statusKey } from "./lib/reconcile.mjs";
import { runClaude, OUTCOME } from "./lib/dispatch.mjs";
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

function git(cfg, args) {
  return spawnSync("git", args, { cwd: cfg.repoPath, encoding: "utf8" });
}

function gitStatusLines(cfg) {
  const out = git(cfg, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout ?? "";
  return out.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

/**
 * Post a deduplicated status to the control queue and record that we did.
 * Requirement D: repeated failure must stay VISIBLE without spamming.
 */
function reportStatus(cfg, state, { taskId, phase, reason, detail, nextAction }) {
  const key = statusKey({ taskId, phase, reason });
  const decision = shouldPostStatus(state.posted_status_keys, key, Date.now(), cfg.statusRepeatHours * 3_600_000);
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
    state.posted_status_keys[key] = new Date().toISOString();
    log(cfg, `Posted status comment ${res.commentId} for ${phase}/${reason}`);
  } else {
    log(cfg, `Failed to post status comment: ${res.error}`);
  }
  return { posted: res.ok, ...res };
}

/** ---------------- run ---------------- */

async function cmdRun(cfg, { dryRun }) {
  emitHealth(cfg.healthFile, HEALTH_EVENTS.WORKER_STARTED, { worker_version: WORKER_VERSION, pid: process.pid });

  if (existsSync(cfg.disabledFlagFile) && !dryRun) {
    log(cfg, "Worker is disabled (disabled.flag present) - exiting cleanly.");
    return EXIT.OK;
  }

  // --- state, loaded before anything mutates ---
  const loaded = loadState(cfg.stateFile, cfg.stateBackupFile);
  if (!loaded.state) {
    // Requirement B: NEVER silently reset. A lost history means lost replay
    // protection, which is far more dangerous than refusing to run.
    log(cfg, `FATAL: state file and backup are both unreadable (primary=${loaded.primary_error}, backup=${loaded.backup_error}).`);
    log(cfg, "Refusing to run rather than discard processed-task history. Inspect state.json / state.json.bak by hand.");
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { reason: "state_unreadable" });
    return EXIT.BLOCKED;
  }
  const state = loaded.state;
  state.worker_version = WORKER_VERSION;
  if (loaded.recovered_from_backup) {
    log(cfg, `WARNING: primary state was corrupt; recovered from backup (${loaded.primary_error}). History preserved.`);
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

  const tasks = collectTrustedTasks(comments, { trustedAuthor: cfg.trustedAuthor });
  const nowMs = Date.now();

  // Requirement E: only already-authorised tasks. Nothing is invented here.
  const candidate = tasks.find((t) => {
    const rec = getTask(state, t.taskId);
    return isEligibleNow(rec, nowMs);
  });

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
    if (!dryRun) {
      state.last_run_at = new Date().toISOString();
      saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
    }
    return EXIT.OK;
  }

  log(cfg, `Next trusted task: TASK_ID=${candidate.taskId} (comment ${candidate.comment.id}, posted ${candidate.comment.created_at}, ${candidate.updates.length} scope update(s))`);
  if (dryRun) {
    log(cfg, "Dry run: would dispatch this task now. No mutation performed.");
    return EXIT.OK;
  }

  // --- lock covers preflight, quarantine, dispatch AND every state write ---
  const lock = acquireLock(cfg.lockFile, {
    taskId: candidate.taskId,
    phase: "preflight",
    heartbeatTimeoutMs: cfg.heartbeatTimeoutMinutes * 60_000
  });
  if (!lock.acquired) {
    if (lock.needs_attention) {
      log(cfg, `Lock owner ${lock.owner?.pid} is alive but has not heartbeated: ${lock.verdict.reason}`);
      reportStatus(cfg, state, {
        taskId: candidate.taskId,
        phase: "lock",
        reason: "owner_alive_but_not_heartbeating",
        detail: `Lock owner pid=${lock.owner?.pid} phase=${lock.owner?.phase} last heartbeat=${lock.owner?.heartbeat_at}. It was NOT terminated: an alive owner may still be doing real work.`,
        nextAction: "Inspect the process by hand. If it is genuinely hung, stop that pid, then the next scheduled run reclaims the lock automatically."
      });
      saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
      return EXIT.BLOCKED;
    }
    log(cfg, `Another worker instance is active (${lock.verdict.reason}) - exiting cleanly without starting a second process.`);
    return EXIT.OK;
  }

  try {
    return await runLocked(cfg, state, candidate, comments);
  } finally {
    releaseLock(cfg.lockFile);
  }
}

async function runLocked(cfg, state, candidate, comments) {
  const taskId = candidate.taskId;
  const prior = getTask(state, taskId);

  // --- orphan-child accounting BEFORE any retry (requirement C) ---
  if (prior?.last_child_pid && isProcessAlive(prior.last_child_pid)) {
    log(cfg, `Previous Claude child pid=${prior.last_child_pid} is STILL ALIVE - refusing to start an overlapping Claude process.`);
    reportStatus(cfg, state, {
      taskId,
      phase: "orphan_check",
      reason: "previous_claude_child_still_running",
      detail: `A Claude child from an earlier attempt (pid=${prior.last_child_pid}) is still alive. Starting a second one would risk duplicate commits/PRs.`,
      nextAction: "Wait for that process to finish, or stop that specific pid by hand. The next scheduled run then resumes this task."
    });
    saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
    return EXIT.BLOCKED;
  }

  // --- reconcile prior side effects so a retry resumes rather than duplicates ---
  let resume = null;
  if (prior && prior.attempts > 0) {
    const rec = reconcilePriorAttempt({
      taskId,
      comments,
      trustedAuthor: cfg.trustedAuthor,
      branches: listRemoteBranches(cfg),
      pulls: listPulls(cfg),
      sinceIso: prior.first_dispatch_at ?? null
    });
    if (rec.completion.complete) {
      // Crash-after-report case: the work IS done; close it out, do not re-run.
      log(cfg, `Reconciled: a matching trusted report already exists (comment ${rec.completion.reportCommentId}, STATUS=${rec.completion.status}). Marking complete without re-dispatching.`);
      upsertTask(state, taskId, {
        status: TASK_STATUS.COMPLETED,
        completed_at: new Date().toISOString(),
        report_comment_id: rec.completion.reportCommentId,
        report_status: rec.completion.status,
        successful: rec.completion.successful,
        reconciled_without_redispatch: true
      });
      state.last_run_at = new Date().toISOString();
      saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
      emitHealth(cfg.healthFile, HEALTH_EVENTS.COMPLETION_CONFIRMED, {
        task_id: taskId, report_comment_id: rec.completion.reportCommentId, via: "reconciliation"
      });
      return EXIT.OK;
    }
    resume = {
      attempts: prior.attempts,
      lastFailureReason: prior.last_failure_reason,
      existingBranch: rec.existingBranch,
      existingPr: rec.existingPr,
      alreadyMerged: rec.alreadyMerged
    };
    log(cfg, `Resuming TASK_ID=${taskId} (attempt ${prior.attempts + 1}); existing branch=${rec.existingBranch ?? "none"}, PR=${rec.existingPr?.number ?? "none"}, alreadyMerged=${rec.alreadyMerged}`);
  }

  // --- scratch quarantine, BEFORE the dirty guard (requirement A) ---
  heartbeat(cfg.lockFile, { phase: "quarantine", taskId });
  const knownTaskIds = Object.keys(state.tasks);
  const quarantine = recoverScratch({
    repoPath: cfg.repoPath,
    statusLines: gitStatusLines(cfg),
    quarantineRoot: cfg.quarantineRoot,
    knownTaskIds,
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

  // --- dirty guard: never bypassed, never widened ---
  const remaining = gitStatusLines(cfg);
  if (remaining.length > 0) {
    const detail = [
      "Files still present after known-scratch quarantine (NOTHING was deleted, reset, stashed or ignored):",
      ...remaining.map((l) => `  ${l}`),
      "",
      "Reasons they were left alone:",
      ...quarantine.left.map((l) => `  ${l.name}: ${l.reason}`)
    ].join("\n");
    log(cfg, `BLOCKED: worktree at ${cfg.repoPath} still has ${remaining.length} entry/entries after quarantine.`);
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { task_id: taskId, reason: "worktree_dirty_unknown", entries: remaining.length });
    reportStatus(cfg, state, {
      taskId,
      phase: "preflight",
      reason: "worktree_dirty_unknown_files",
      detail,
      nextAction: "Inspect the listed paths. Commit, move or delete them deliberately; the worker will not touch unknown or tracked files. The next scheduled run then dispatches this same task automatically."
    });
    state.last_run_at = new Date().toISOString();
    saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
    return EXIT.BLOCKED; // task stays non-terminal and eligible - NOT processed
  }
  emitHealth(cfg.healthFile, HEALTH_EVENTS.PREFLIGHT, { task_id: taskId, worktree: "clean" });

  // --- mark in progress and dispatch ---
  const scratchDir = join(cfg.scratchRoot, taskId);
  mkdirSync(scratchDir, { recursive: true });

  const attempts = (prior?.attempts ?? 0) + 1;
  const dispatchStartedAt = new Date().toISOString();
  upsertTask(state, taskId, {
    status: TASK_STATUS.IN_PROGRESS,
    attempts,
    first_dispatch_at: prior?.first_dispatch_at ?? dispatchStartedAt,
    last_dispatch_at: dispatchStartedAt,
    comment_id: candidate.comment.id
  });
  saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);

  const branchBefore = git(cfg, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout?.trim();
  const headBefore = git(cfg, ["rev-parse", "HEAD"]).stdout?.trim();
  log(cfg, `Dispatching TASK_ID=${taskId} attempt ${attempts} (branch=${branchBefore}, head=${headBefore})...`);
  emitHealth(cfg.healthFile, HEALTH_EVENTS.DISPATCH_STARTED, { task_id: taskId, attempt: attempts, head: headBefore });

  const result = await runClaude(cfg, { ...candidate, resume, scratchDir }, {
    heartbeatMs: cfg.heartbeatSeconds * 1000,
    onHeartbeat: (childPid) => {
      heartbeat(cfg.lockFile, { phase: "dispatch", taskId, childPid });
      emitHealth(cfg.healthFile, HEALTH_EVENTS.HEARTBEAT, { task_id: taskId, child_pid: childPid });
    }
  });

  emitHealth(cfg.healthFile, HEALTH_EVENTS.DISPATCH_EXITED, {
    task_id: taskId, outcome: result.outcome, code: result.code ?? null, child_pid: result.childPid ?? null
  });
  log(cfg, `Claude dispatch finished: outcome=${result.outcome} code=${result.code ?? "n/a"} signal=${result.signal ?? "none"}`);
  if (result.stderrTail) log(cfg, `stderr (last 2000 chars): ${result.stderrTail.slice(-2000)}`);
  if (result.error) log(cfg, `spawn error: ${result.error}`);

  // --- completion requires EVIDENCE, never exit code alone (requirement B) ---
  heartbeat(cfg.lockFile, { phase: "verify", taskId });
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

  const checkpoint = {
    last_outcome: result.outcome,
    last_exit_code: result.code ?? null,
    last_child_pid: result.childPid ?? null,
    last_dispatch_finished_at: new Date().toISOString(),
    branch_before: branchBefore,
    head_before: headBefore,
    head_after: git(cfg, ["rev-parse", "HEAD"]).stdout?.trim(),
    branch_after: git(cfg, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout?.trim()
  };

  if (completion.complete) {
    upsertTask(state, taskId, {
      ...checkpoint,
      status: TASK_STATUS.COMPLETED,
      completed_at: new Date().toISOString(),
      report_comment_id: completion.reportCommentId,
      report_status: completion.status,
      successful: completion.successful,
      last_child_pid: null
    });
    state.last_run_at = new Date().toISOString();
    saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
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
      status: TASK_STATUS.BLOCKED,
      last_failure_reason: failureReason,
      blocked_at: new Date().toISOString()
    });
    emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { task_id: taskId, reason: "retry_budget_exhausted", attempts });
    reportStatus(cfg, state, {
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
    state.last_run_at = new Date().toISOString();
    saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
    log(cfg, `TASK_ID=${taskId} BLOCKED after ${attempts} attempts: ${failureReason}`);
    return EXIT.BLOCKED;
  }

  const nextEligible = new Date(Date.now() + backoff.delayMs).toISOString();
  upsertTask(state, taskId, {
    ...checkpoint,
    status: TASK_STATUS.FAILED_RETRYABLE,
    last_failure_reason: failureReason,
    next_eligible_at: nextEligible
  });
  state.last_run_at = new Date().toISOString();
  saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
  log(cfg, `TASK_ID=${taskId} NOT complete (${failureReason}). Retryable; next eligible at ${nextEligible} (attempt ${attempts}/${cfg.maxAttempts}).`);
  emitHealth(cfg.healthFile, HEALTH_EVENTS.BLOCKED, { task_id: taskId, reason: failureReason, retryable: true, next_eligible_at: nextEligible });
  return EXIT.TRANSIENT;
}

/** ---------------- other subcommands ---------------- */

function cmdStatus(cfg) {
  const loaded = loadState(cfg.stateFile, cfg.stateBackupFile);
  const state = loaded.state;
  const auth = verifyAuth();
  const lock = readLock(cfg.lockFile);
  const dirty = gitStatusLines(cfg);
  const tasks = state ? Object.values(state.tasks) : [];
  console.log(JSON.stringify({
    worker_version: WORKER_VERSION,
    state_readable: Boolean(state),
    state_source: loaded.source,
    enabled: !existsSync(cfg.disabledFlagFile),
    lock: lock ? { pid: lock.pid, phase: lock.phase, task_id: lock.task_id, heartbeat_at: lock.heartbeat_at, alive: isProcessAlive(lock.pid) } : null,
    last_run_at: state?.last_run_at ?? null,
    counts: {
      completed: tasks.filter((t) => t.status === TASK_STATUS.COMPLETED).length,
      blocked: tasks.filter((t) => t.status === TASK_STATUS.BLOCKED).length,
      retryable: tasks.filter((t) => t.status === TASK_STATUS.FAILED_RETRYABLE).length,
      in_progress: tasks.filter((t) => t.status === TASK_STATUS.IN_PROGRESS).length
    },
    unfinished: tasks.filter((t) => !isTerminal(t)).map((t) => ({
      task_id: t.task_id, status: t.status, attempts: t.attempts, next_eligible_at: t.next_eligible_at ?? null, last_failure_reason: t.last_failure_reason ?? null
    })),
    github_reachable: auth.ok,
    repo_path: cfg.repoPath,
    repo_clean: dirty.length === 0,
    repo_dirty_entries: dirty
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

main()
  .then((code) => { process.exitCode = code ?? EXIT.OK; })
  .catch((err) => {
    console.error(`[${new Date().toISOString()}] FATAL: ${sanitize(err.message)}`);
    process.exitCode = EXIT.FATAL;
  });

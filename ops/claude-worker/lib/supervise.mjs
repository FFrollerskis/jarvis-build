/**
 * Supervisor decision logic (pure, fully unit-testable).
 *
 * The supervisor answers exactly one question - "is the worker a dead queue
 * consumer, and may I start it?" - and it answers it from evidence, not from a
 * Windows task exit code.
 *
 * Hard rules encoded here:
 *   - A live Claude child or a heartbeating lock is HEALTHY LONG WORK, never a
 *     dead worker, however long it has been running.
 *   - A restart is GRACEFUL/DEFERRED whenever legitimate work is active. Forced
 *     termination is never performed by the supervisor at all.
 *   - Restarts are budgeted per day and backed off, so a permanently broken
 *     worker cannot become a restart loop.
 */

import { classifyLock } from "./lock.mjs";
import { summarizeHealth } from "./health.mjs";

export const WORKER_VERDICT = Object.freeze({
  HEALTHY: "healthy",
  BUSY: "busy",
  DEAD: "dead",
  DISABLED: "disabled",
  UNKNOWN: "unknown"
});

/**
 * Classify the worker from independent evidence:
 *   lock state (process identity + heartbeat) + health journal + task state.
 */
export function assessWorker({
  healthEvents,
  lockInfo,
  scheduledTask,
  workerDisabled,
  nowMs,
  deadWorkerMs,
  lockOpts = {}
}) {
  const health = summarizeHealth(healthEvents ?? []);

  if (workerDisabled) {
    return { verdict: WORKER_VERDICT.DISABLED, reason: "worker disabled.flag is present", health };
  }

  if (lockInfo && !lockInfo.malformed) {
    const lockVerdict = classifyLock(lockInfo, { nowMs, ...lockOpts });
    if (lockVerdict.state === "active") {
      // Real work in flight. This is the case that must NEVER be restarted.
      return {
        verdict: WORKER_VERDICT.BUSY,
        reason: `worker lock is active: ${lockVerdict.reason}`,
        health,
        lockVerdict
      };
    }
    if (lockVerdict.state === "stale_no_heartbeat") {
      return {
        verdict: WORKER_VERDICT.UNKNOWN,
        reason: `lock owner alive but not heartbeating: ${lockVerdict.reason}`,
        health,
        lockVerdict
      };
    }
    // stale_dead / stale_reused_pid / foreign_host / malformed fall through:
    // the lock tells us nothing about liveness, so judge by the health journal.
  }

  if (!scheduledTask?.exists) {
    return { verdict: WORKER_VERDICT.UNKNOWN, reason: "scheduled task is not registered", health };
  }
  if (scheduledTask.state === "Disabled") {
    return { verdict: WORKER_VERDICT.DISABLED, reason: "scheduled task is Disabled", health };
  }

  // The decisive evidence is the QUEUE POLL, not the Windows task state:
  // a task can sit at Ready/LastTaskResult=0 forever while the worker crashes
  // before it ever reaches the control issue.
  const lastPoll = health.last_queue_poll ? Date.parse(health.last_queue_poll) : null;
  if (lastPoll === null) {
    return { verdict: WORKER_VERDICT.DEAD, reason: "worker has never recorded a queue poll", health };
  }
  const age = nowMs - lastPoll;
  if (age > deadWorkerMs) {
    return {
      verdict: WORKER_VERDICT.DEAD,
      reason: `last queue poll ${health.last_queue_poll} is ${Math.round(age / 60000)} min old (budget ${Math.round(deadWorkerMs / 60000)} min)`,
      health
    };
  }
  return { verdict: WORKER_VERDICT.HEALTHY, reason: `queue polled ${Math.round(age / 60000)} min ago`, health };
}

/** Restarts consumed in the trailing 24h window. */
export function restartsInWindow(journal, nowMs, windowMs = 24 * 3_600_000) {
  return (journal ?? []).filter(
    (e) => e && e.action === "restart_started" && Number.isFinite(Date.parse(e.ts)) && nowMs - Date.parse(e.ts) <= windowMs
  ).length;
}

/**
 * Decide what to do about an autonomously detected problem (no operator command).
 *
 * Returns `{ action, reason }` where action is one of:
 *   none | restart | defer | report_blocked
 */
export function planAutonomousAction({ assessment, journal, nowMs, budgetPerDay, backoffMs, lastRestartAt }) {
  if (assessment.verdict === WORKER_VERDICT.HEALTHY) return { action: "none", reason: assessment.reason };
  if (assessment.verdict === WORKER_VERDICT.BUSY) {
    return { action: "none", reason: "worker is busy with legitimate work; nothing to recover" };
  }
  if (assessment.verdict === WORKER_VERDICT.DISABLED) {
    return { action: "none", reason: "worker is intentionally disabled; not overriding an operator decision" };
  }
  if (assessment.verdict === WORKER_VERDICT.UNKNOWN) {
    // Never force-recover something we cannot prove is dead.
    return { action: "report_blocked", reason: `cannot prove the worker is dead: ${assessment.reason}` };
  }

  // verdict === DEAD
  const used = restartsInWindow(journal, nowMs);
  if (used >= budgetPerDay) {
    return { action: "report_blocked", reason: `restart budget exhausted (${used}/${budgetPerDay} in 24h): ${assessment.reason}` };
  }
  if (lastRestartAt) {
    const since = nowMs - Date.parse(lastRestartAt);
    if (Number.isFinite(since) && since < backoffMs) {
      return { action: "defer", reason: `backoff active: ${Math.round((backoffMs - since) / 60000)} min remaining` };
    }
  }
  return { action: "restart", reason: assessment.reason };
}

/**
 * Decide what to do about an authorised RESTART_WORKER command.
 * Graceful by default: active work defers the restart rather than interrupting it.
 */
export function planCommandedRestart({ assessment }) {
  if (assessment.verdict === WORKER_VERDICT.BUSY) {
    return {
      action: "defer",
      reason: "legitimate work is active; restart deferred rather than interrupting it. No process was terminated."
    };
  }
  if (assessment.verdict === WORKER_VERDICT.UNKNOWN) {
    return {
      action: "defer",
      reason: `worker liveness could not be proven (${assessment.reason}); refusing to force a restart. No process was terminated.`
    };
  }
  if (assessment.verdict === WORKER_VERDICT.DISABLED) {
    return { action: "report_blocked", reason: "worker is disabled; a restart would not produce a running worker" };
  }
  return { action: "restart", reason: `worker is ${assessment.verdict}; safe to start the scheduled task` };
}

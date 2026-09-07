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
 *
 * D126 review blocker 5, fixed here:
 *   - a COMMANDED restart used to bypass the daily budget and the backoff
 *     entirely; only the autonomous path applied them. One operator with a
 *     script - or one replayed comment stream - could therefore restart the
 *     worker without limit. `planCommandedRestart` now takes the same budget and
 *     backoff as `planAutonomousAction`.
 *   - a crash between "intent recorded" and "start confirmed" had no
 *     reconciliation at all. `planIntentReconciliation` decides from actual host
 *     evidence (did the worker's scheduler fire after the intent?) whether the
 *     effect happened, must be retried, or is genuinely still uncertain.
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
    if (lockVerdict.state === "stale_no_heartbeat" || lockVerdict.state === "unproven_identity") {
      return {
        verdict: WORKER_VERDICT.UNKNOWN,
        reason: `worker lock owner cannot be cleared: ${lockVerdict.reason}`,
        health,
        lockVerdict
      };
    }
    // stale_dead / stale_reused_pid / foreign_host / malformed fall through:
    // the lock tells us nothing about liveness, so judge by the health journal.
  }

  if (scheduledTask?.query_failed) {
    // "I could not ask" is never "the task is not registered".
    return {
      verdict: WORKER_VERDICT.UNKNOWN,
      reason: `the scheduled task could not be queried: ${scheduledTask.error ?? "unknown error"}`,
      health
    };
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

/**
 * Restarts consumed in the trailing 24h window.
 *
 * Counted per distinct INTENT, so re-driving one interrupted intent to
 * completion is one restart, not two.
 */
export function restartsInWindow(journal, nowMs, windowMs = 24 * 3_600_000) {
  const intents = new Set();
  let unattributed = 0;
  for (const e of journal ?? []) {
    if (!e || e.action !== "restart_started") continue;
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts) || nowMs - ts > windowMs) continue;
    if (e.intent_id) intents.add(e.intent_id);
    else unattributed += 1;
  }
  return intents.size + unattributed;
}

function budgetGate({ journal, nowMs, budgetPerDay, backoffMs, lastRestartAt, describe }) {
  const used = restartsInWindow(journal, nowMs);
  if (used >= budgetPerDay) {
    return { action: "report_blocked", reason: `restart budget exhausted (${used}/${budgetPerDay} in 24h): ${describe}` };
  }
  if (lastRestartAt) {
    const since = nowMs - Date.parse(lastRestartAt);
    if (Number.isFinite(since) && since < backoffMs) {
      return { action: "defer", reason: `backoff active: ${Math.round((backoffMs - since) / 60000)} min remaining` };
    }
  }
  return null;
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
  const gated = budgetGate({ journal, nowMs, budgetPerDay, backoffMs, lastRestartAt, describe: assessment.reason });
  if (gated) return gated;
  return { action: "restart", reason: assessment.reason };
}

/**
 * Decide what to do about an authorised RESTART_WORKER command.
 *
 * Graceful by default: active work defers the restart rather than interrupting
 * it. The daily budget and the backoff apply here EXACTLY as they do to the
 * autonomous path - a commanded restart is not a bypass.
 */
export function planCommandedRestart({ assessment, journal = [], nowMs = Date.now(), budgetPerDay, backoffMs, lastRestartAt = null }) {
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
  if (budgetPerDay !== undefined) {
    const gated = budgetGate({
      journal,
      nowMs,
      budgetPerDay,
      backoffMs: backoffMs ?? 0,
      lastRestartAt,
      describe: `commanded restart while worker is ${assessment.verdict}`
    });
    if (gated) return gated;
  }
  return { action: "restart", reason: `worker is ${assessment.verdict}; safe to start the scheduled task` };
}

/** ---------------- durable intent reconciliation ---------------- */

export const INTENT_STAGE = Object.freeze({
  INTENT: "intent",                   // recorded, effect NOT yet attempted
  EFFECT_ATTEMPTED: "effect_attempted", // Start-ScheduledTask was invoked, outcome unknown
  RESULT_RECORDED: "result_recorded"    // outcome known and durable
});

/**
 * Reconcile an intent left behind by a crash, using ACTUAL host evidence.
 *
 * The evidence is the worker's own health journal: if the worker's scheduler
 * fired (or the queue was polled) at or after the moment the intent was
 * recorded, the intended effect demonstrably occurred - regardless of whether we
 * lived long enough to write that down.
 *
 * Deliberately NOT used as evidence: `LastRunTime` of a task that repeats every
 * five minutes, because it advances on its own and would "prove" a restart that
 * never happened.
 *
 * Returns `{ action, reason }`:
 *   clear         - nothing left to do
 *   post_receipt  - the effect is settled; only the receipt is missing
 *   confirm       - host evidence shows the effect happened; record and receipt it
 *   retry_effect  - the effect provably did not happen; re-drive the SAME intent
 *   uncertain     - not yet decidable; report and wait rather than guess
 */
export function planIntentReconciliation({ intent, nowMs, workerHealth, evidenceWindowMs = 20 * 60_000 }) {
  if (!intent) return { action: "clear", reason: "no pending intent" };

  if (intent.stage === INTENT_STAGE.RESULT_RECORDED) {
    return intent.receipt_posted
      ? { action: "clear", reason: "intent fully settled" }
      : { action: "post_receipt", reason: "result is durable; only the receipt is missing" };
  }

  const intentMs = Date.parse(intent.created_at ?? "");
  if (!Number.isFinite(intentMs)) {
    return { action: "uncertain", reason: "pending intent has no usable timestamp" };
  }

  const invoked = Date.parse(workerHealth?.last_scheduler_invocation ?? "");
  const polled = Date.parse(workerHealth?.last_queue_poll ?? "");
  const evidenceMs = Math.max(
    Number.isFinite(invoked) ? invoked : Number.NEGATIVE_INFINITY,
    Number.isFinite(polled) ? polled : Number.NEGATIVE_INFINITY
  );
  if (Number.isFinite(evidenceMs) && evidenceMs >= intentMs) {
    return {
      action: "confirm",
      reason: `the worker recorded activity at ${new Date(evidenceMs).toISOString()}, at or after the intent - the restart took effect`
    };
  }

  if (intent.stage === INTENT_STAGE.INTENT) {
    return {
      action: "retry_effect",
      reason: "the intent was recorded but the start was never attempted; no effect has occurred, so re-driving it repeats nothing"
    };
  }

  if (nowMs - intentMs > evidenceWindowMs) {
    return {
      action: "retry_effect",
      reason: `the start was attempted ${Math.round((nowMs - intentMs) / 60000)} min ago and the worker still shows no activity, so the effect did not take`
    };
  }

  return {
    action: "uncertain",
    reason: "the start was attempted but its effect is not yet observable; waiting rather than repeating it"
  };
}

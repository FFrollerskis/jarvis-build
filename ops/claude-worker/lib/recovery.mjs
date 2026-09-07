/**
 * Crash / reboot recovery for tasks left IN_PROGRESS (D126 review blocker 1).
 *
 * The permanent stall, precisely:
 *   - `isEligibleNow` returns false for IN_PROGRESS ("the lock owner decides"),
 *   - but the worker chose its candidate BEFORE acquiring the lock, so the code
 *     that was supposed to decide (`runLocked`, reconciliation) was never
 *     reached at all once the only candidate was IN_PROGRESS,
 *   - and `last_child_pid` was written only AFTER `runClaude` returned, so
 *     during the entire dispatch the child existed only inside the lock file -
 *     which is exactly what a dead-parent reclaim deletes.
 * Result: one crash or reboot mid-dispatch and that TASK_ID could never run
 * again (architect reproduction: CRASHED_IN_PROGRESS_ELIGIBLE=false).
 *
 * This module holds the pure decision. The worker runs it UNDER the ownership
 * lock, before it picks any candidate, and it:
 *   - protects a still-live child (identity-verified, never pid-only),
 *   - reconciles a trusted report first, so crash-after-report closes out
 *     instead of re-running,
 *   - refuses to re-dispatch while duplicate risk is unknown,
 *   - and otherwise returns the task to the normal retry path.
 */

import { IDENTITY } from "./procid.mjs";

export const RECOVERY = Object.freeze({
  PROTECT_LIVE_CHILD: "protect_live_child",
  COMPLETE_FROM_REPORT: "complete_from_report",
  DEFER_UNKNOWN: "defer_unknown",
  RETRY: "retry"
});

/**
 * How long after its recorded start a child may still plausibly be OUR child.
 * Used only when the child's identity cannot be proven either way; it bounds
 * the protection so an unprovable pid can never block the loop forever.
 */
export function childLifetimeBudgetMs({ claudeTimeoutMinutes, graceMinutes = 10 }) {
  return (Number(claudeTimeoutMinutes) + Number(graceMinutes)) * 60_000;
}

/**
 * Decide what to do with one abandoned IN_PROGRESS task.
 *
 * `identityVerdict` comes from `matchProcessIdentity` against the identity the
 * dispatching parent persisted at spawn. It is never a bare pid check.
 */
export function planTaskRecovery({
  task,
  nowMs,
  completion,
  identityVerdict,
  lifetimeBudgetMs,
  duplicateRiskUnknown = false
}) {
  const recordedIdentity = task?.child_identity ?? null;

  // 1. A live child is sacred. Never start a second Claude over the top of one.
  if (recordedIdentity && identityVerdict) {
    if (identityVerdict.state === IDENTITY.MATCH) {
      return {
        action: RECOVERY.PROTECT_LIVE_CHILD,
        reason: `a Claude child from an earlier attempt is verifiably still running (${identityVerdict.reason})`,
        identityVerdict
      };
    }
    if (identityVerdict.state === IDENTITY.UNPROVEN) {
      const startedMs = Date.parse(recordedIdentity.observed_at ?? task.last_dispatch_at ?? "");
      const withinBudget = Number.isFinite(startedMs) && (nowMs - startedMs) < lifetimeBudgetMs;
      if (withinBudget) {
        return {
          action: RECOVERY.PROTECT_LIVE_CHILD,
          reason:
            `a process with the recorded child pid is alive but its identity cannot be confirmed `
            + `(${identityVerdict.reason}); still inside the child's own lifetime budget, so it is protected`,
          identityVerdict,
          bounded: true
        };
      }
      // Past the budget the recorded pid CANNOT still be our child, so this is
      // pid reuse. Blocking here forever is the failure mode the review calls
      // out explicitly, so we deliberately continue.
    }
    // GONE / REUSED / FOREIGN_HOST / expired-UNPROVEN all mean: not our child.
  }

  // 2. Reconcile the report BEFORE anything else about eligibility.
  if (completion?.complete) {
    return {
      action: RECOVERY.COMPLETE_FROM_REPORT,
      reason: `a matching trusted report already exists (comment ${completion.reportCommentId}, STATUS=${completion.status})`,
      completion
    };
  }

  // 3. Never re-dispatch while we cannot see whether side effects exist.
  if (duplicateRiskUnknown) {
    return {
      action: RECOVERY.DEFER_UNKNOWN,
      reason: "branch/PR lookup failed, so the absence of an existing branch, PR or merge is NOT proven"
    };
  }

  return {
    action: RECOVERY.RETRY,
    reason: "no live child, no matching report, and existing side effects are known - safe to resume"
  };
}

/**
 * Human-readable summary of a protected orphan, including its descendants, so
 * the status comment tells the operator exactly what is still running and what
 * to do about it.
 */
export function describeProtectedChild({ task, identityVerdict, descendants = [] }) {
  const identity = task?.child_identity ?? {};
  const lines = [
    `TASK_ID=${task?.task_id}`,
    `CHILD_PID=${identity.pid ?? "unknown"}`,
    `CHILD_HOST=${identity.host ?? "unknown"}`,
    `CHILD_START_TIME=${identity.start_time ?? "not recorded"}`,
    `CHILD_OBSERVED_AT=${identity.observed_at ?? "unknown"}`,
    `IDENTITY_VERDICT=${identityVerdict?.state ?? "unknown"} (${identityVerdict?.reason ?? "no reason"})`,
    `DESCENDANT_PIDS=${descendants.length > 0 ? descendants.join(", ") : "none observed"}`,
    "",
    "Nothing was terminated. Starting a second Claude for the same task would risk duplicate",
    "commits, branches, PRs or merges, so this run stops instead."
  ];
  return lines.join("\n");
}

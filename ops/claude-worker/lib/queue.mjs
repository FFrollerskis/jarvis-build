/**
 * Deterministic queue selection, eligibility and supersession (D132).
 *
 * ------------------------------------------------------------------------
 * D132 ROOT CAUSE 2 - AN OLDER TASK COULD PREEMPT A NEWER ONE FOREVER.
 * ------------------------------------------------------------------------
 *
 * The worker used to choose its candidate like this:
 *
 *     const tasks = collectTrustedTasks(comments, ...);   // OLDEST FIRST
 *     const candidate = tasks.find((t) => isEligibleNow(getTask(state, t.taskId), nowMs));
 *
 * `collectTrustedTasks` sorts oldest-first, and `find` returns the first match.
 * So the OLDEST eligible task always won - and "eligible" meant nothing more
 * than "not terminal, and its backoff clock has elapsed". Two consequences, both
 * of which actually happened:
 *
 *  1. A retry of an OLD task outranked a brand-new, never-dispatched
 *     ARCHITECT_TASK. Recorded on the host, from `state.json`:
 *
 *       D131-PR79-STASH-RECOVERY-20260911-A   first dispatch 04:18:05Z
 *                                             RE-dispatched  05:38:07Z
 *       D131-PR79-MERGE-F12FF3B-20260911-B    first dispatch 05:23:05Z
 *
 *     At 05:38 the newer merge task existed and had already done its work; the
 *     worker went back and ran the older recovery task anyway, purely because
 *     its backoff had elapsed and it sorted first.
 *
 *  2. Once an old task's bookkeeping was stale (see the `COMPLETE` vs
 *     `COMPLETED` vocabulary defect in reconcile.mjs), NOTHING ever retired it.
 *     It stayed `failed_retryable` and kept coming back to the front of the
 *     queue on every run until its attempt budget ran out.
 *
 * The repair has three parts, all pure and all tested:
 *
 *   TIERING      A never-dispatched task always outranks a RETRY. A newer valid
 *                unprocessed ARCHITECT_TASK can therefore never be preempted by
 *                an older task whose retry bookkeeping happens to be stale.
 *
 *   SUPERSESSION A non-terminal task that is STRICTLY OLDER than a task which
 *                has already COMPLETED is retired, not retried. The architect
 *                issues orders sequentially against a moving repository; an old
 *                order re-executed after a newer one finished is a stale action
 *                against state that has since changed.
 *
 *   FRESH TRUTH  Completion is decided from the FRESH control-issue comments
 *                fetched this run, never from worker bookkeeping alone. A
 *                trusted terminal CLAUDE_REPORT retires its task even if the
 *                state file still says `failed_retryable`. Stale local state can
 *                no longer resurrect finished work.
 *
 * Ordering is total and deterministic - tier, then time, then comment id - so
 * the same queue always produces the same choice, and a test can assert it.
 */

import { assessCompletion } from "./reconcile.mjs";
import { TASK_STATUS, getTask, isTerminal, isValidTaskId } from "./state.mjs";

/** Why a task was not chosen. Ordered from "never again" to "not right now". */
export const INELIGIBLE = Object.freeze({
  UNSAFE_TASK_ID: "unsafe_task_id",
  TERMINAL_STATE: "terminal_state",
  TERMINAL_REPORT: "terminal_report_exists",
  UNRECOGNISED_REPORT_STATUS: "report_status_unrecognised",
  SUPERSEDED: "superseded_by_newer_completed_task",
  IN_PROGRESS: "in_progress_owned_by_recovery",
  BACKOFF: "waiting_for_backoff"
});

/** Dispatch tiers. Lower sorts first. */
export const TIER = Object.freeze({
  FRESH: 0,
  RETRY: 1
});

function createdMs(entry) {
  const t = Date.parse(entry?.comment?.created_at ?? "");
  return Number.isFinite(t) ? t : 0;
}

function commentId(entry) {
  const n = Number(entry?.comment?.id);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Is this task finished according to the FRESH control issue?
 *
 * Deliberately independent of worker bookkeeping: this is the check that makes a
 * terminal CLAUDE_REPORT authoritative over a stale `failed_retryable` record.
 *
 * `sinceIso` is scoped to the task's own first dispatch when we know it, so an
 * old report for a re-issued id still cannot be mistaken for fresh evidence.
 */
export function reportVerdictFor(entry, { state, comments, trustedAuthor }) {
  const record = getTask(state, entry.taskId);
  return assessCompletion({
    taskId: entry.taskId,
    comments,
    trustedAuthor,
    sinceIso: record?.first_dispatch_at ?? null
  });
}

/**
 * Classify every trusted task and pick the one to dispatch.
 *
 * Returns `{ candidate, decisions, supersededTaskIds, completedByReportTaskIds,
 * unrecognisedStatusTaskIds }`. `candidate` is the full trusted-task entry, or
 * `null` when nothing is dispatchable.
 *
 * The caller is expected to PERSIST the retirements this function identifies
 * (`supersededTaskIds`, `completedByReportTaskIds`) before acting on
 * `candidate`, so the decision survives a restart.
 */
export function selectNextTask({ tasks, state, comments, trustedAuthor, nowMs }) {
  const entries = (tasks ?? []).map((entry) => {
    const record = getTask(state, entry.taskId);
    return {
      entry,
      taskId: entry.taskId,
      record,
      createdMs: createdMs(entry),
      commentId: commentId(entry),
      completion: null,
      tier: (record?.attempts ?? 0) > 0 ? TIER.RETRY : TIER.FRESH
    };
  });

  // --- pass 1: fresh-truth completion, per task -----------------------------
  // Done for EVERY task, not just the one we are about to pick, because
  // supersession in pass 2 has to know which tasks are genuinely finished.
  for (const e of entries) {
    if (!isValidTaskId(e.taskId)) continue;
    e.completion = reportVerdictFor(e.entry, { state, comments, trustedAuthor });
  }

  /**
   * A task counts as COMPLETE for supersession purposes when either the worker
   * already recorded it completed, or a trusted terminal report exists for it
   * right now. Both are positive evidence that the architect's newer order was
   * actually carried out.
   */
  const isComplete = (e) =>
    e.record?.status === TASK_STATUS.COMPLETED || e.completion?.complete === true;

  // The newest task that has genuinely completed. Anything strictly older than
  // this is a stale order.
  let newestCompletedMs = null;
  let newestCompletedId = null;
  for (const e of entries) {
    if (!isComplete(e)) continue;
    if (newestCompletedMs === null || e.createdMs > newestCompletedMs) {
      newestCompletedMs = e.createdMs;
      newestCompletedId = e.taskId;
    }
  }

  // --- pass 2: eligibility --------------------------------------------------
  const decisions = [];
  const dispatchable = [];

  for (const e of entries) {
    const push = (eligible, reason) => {
      decisions.push({
        taskId: e.taskId,
        eligible,
        reason,
        tier: e.tier,
        attempts: e.record?.attempts ?? 0,
        createdAt: e.entry?.comment?.created_at ?? null,
        completion: e.completion,
        supersededBy: reason === INELIGIBLE.SUPERSEDED ? newestCompletedId : null
      });
    };

    if (!isValidTaskId(e.taskId)) { push(false, INELIGIBLE.UNSAFE_TASK_ID); continue; }

    // Worker state already retired it (completed / blocked / superseded).
    // Nothing - no restart, no elapsed backoff - brings it back.
    if (isTerminal(e.record)) { push(false, INELIGIBLE.TERMINAL_STATE); continue; }

    // FRESH TRUTH beats stale bookkeeping: a trusted terminal report retires the
    // task even while the state file still calls it retryable. This single check
    // is what makes the `COMPLETE`-vocabulary class of failure non-recurring even
    // if some future spelling slips through again.
    if (e.completion?.complete) { push(false, INELIGIBLE.TERMINAL_REPORT); continue; }

    // A trusted report exists but its STATUS is a spelling we do not know. Retry
    // is NOT the safe default here - it is the D-131 loop. Fail closed and let
    // the caller surface the vocabulary mismatch.
    if (e.completion && e.completion.reportCommentId !== null && e.completion.statusRecognised === false) {
      push(false, INELIGIBLE.UNRECOGNISED_REPORT_STATUS);
      continue;
    }

    // The architect has moved on: a strictly newer order already completed.
    if (newestCompletedMs !== null && e.createdMs < newestCompletedMs) {
      push(false, INELIGIBLE.SUPERSEDED);
      continue;
    }

    // The recovery pass owns IN_PROGRESS; it is never dispatched from here.
    if (e.record?.status === TASK_STATUS.IN_PROGRESS) { push(false, INELIGIBLE.IN_PROGRESS); continue; }

    if (e.record?.next_eligible_at) {
      const at = Date.parse(e.record.next_eligible_at);
      if (Number.isFinite(at) && nowMs < at) { push(false, INELIGIBLE.BACKOFF); continue; }
    }

    push(true, null);
    dispatchable.push(e);
  }

  // --- pass 3: total, deterministic ordering --------------------------------
  //
  // FRESH before RETRY is the invariant the architect asked for: a newer valid
  // unprocessed ARCHITECT_TASK can never be preempted by an older task whose
  // retry bookkeeping is stale.
  //
  // Within FRESH: oldest first, so a deliberately queued sequence of new orders
  // is executed in the order the architect wrote it.
  //
  // Within RETRY: newest first. If several old tasks are all retryable, the most
  // recent one is the closest to current repository truth.
  //
  // Comment id is the final tie-break, so the ordering is total even for two
  // comments with identical timestamps.
  dispatchable.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.createdMs !== b.createdMs) {
      return a.tier === TIER.FRESH ? a.createdMs - b.createdMs : b.createdMs - a.createdMs;
    }
    return a.tier === TIER.FRESH ? a.commentId - b.commentId : b.commentId - a.commentId;
  });

  const chosen = dispatchable[0] ?? null;

  return {
    candidate: chosen?.entry ?? null,
    candidateTier: chosen?.tier ?? null,
    decisions,
    supersededBy: newestCompletedId,
    supersededTaskIds: decisions.filter((d) => d.reason === INELIGIBLE.SUPERSEDED).map((d) => d.taskId),
    completedByReportTaskIds: decisions
      .filter((d) => d.reason === INELIGIBLE.TERMINAL_REPORT)
      .map((d) => d.taskId),
    unrecognisedStatusTaskIds: decisions
      .filter((d) => d.reason === INELIGIBLE.UNRECOGNISED_REPORT_STATUS)
      .map((d) => d.taskId),
    waitingTaskIds: decisions.filter((d) => d.reason === INELIGIBLE.BACKOFF).map((d) => d.taskId)
  };
}

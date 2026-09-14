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

import { completionGateHeld } from "./provenance.mjs";
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

/**
 * D-139: THE EXPECTED HEAD AN ORDER WAS WRITTEN AGAINST.
 *
 * An ARCHITECT_TASK states `EXPECTED_HEAD_SHA=<sha>`, and its own pre-flight
 * refuses to mutate anything unless the repository is still at exactly that
 * commit. A task whose declared head no longer matches reality is therefore, by
 * the architect's own construction, an order that can no longer be carried out
 * as written. It is STALE.
 *
 * The observed danger was concrete. A never-dispatched task from 16:29Z naming
 * head `4df1472` sorted AHEAD of the architect's current order from 23:33Z
 * naming the head the repository was actually on - purely because both were
 * "fresh", and fresh tasks sort oldest-first. The stale order would have been
 * dispatched, failed its own pre-flight, and consumed an attempt, while the
 * live order waited behind it.
 *
 * The rule is GENERAL and keyed on declared-vs-observed head, never on any
 * particular TASK_ID: a stale order may not PREEMPT a current one. It is not an
 * outright refusal - a stale task still sorts last and can still run when
 * nothing current exists, so a head that moves while the queue is being drained
 * cannot strand the queue.
 */
export const HEAD_TIER = Object.freeze({
  /** Declares the head we actually observe. The clearest possible live order. */
  CURRENT: 0,
  /** Declares no head, or we could not observe one. Makes no claim either way. */
  UNDECLARED: 1,
  /** Declares a head that is NOT the one we observe. Stale by construction. */
  STALE: 2
});

/** The field an ARCHITECT_TASK uses to bind an order to one exact commit. */
export const EXPECTED_HEAD_FIELD = "EXPECTED_HEAD_SHA";

const EXPECTED_HEAD_LINE = new RegExp("^" + EXPECTED_HEAD_FIELD + "=([0-9a-fA-F]{7,40})\\s*$");

/**
 * The exact head this trusted task was written against, or `null`.
 *
 * Read only from the trusted ARCHITECT_TASK comment and its trusted scope
 * updates - the same source `declaredSupersedes` uses. A PR body, a CI log or
 * an untrusted comment can never move a task between head tiers.
 */
export function declaredExpectedHead(entry) {
  const bodies = [entry?.comment?.body, ...(entry?.updates ?? []).map((u) => u?.body)];
  let found = null;
  for (const body of bodies) {
    for (const line of String(body ?? "").split(/\r?\n/)) {
      const m = line.match(EXPECTED_HEAD_LINE);
      // The LAST declaration wins: a trusted scope update that re-points the
      // order at a new head is the architect correcting themselves, not a
      // second, competing order.
      if (m) found = String(m[1]).toLowerCase();
    }
  }
  return found;
}

/**
 * Compare a declared head against the observed one.
 *
 * Prefix-tolerant in the only direction that is safe: an abbreviated
 * declaration matches a full observed sha it is a prefix of. An observed head
 * we could NOT read is never a mismatch - calling an order stale on the
 * strength of a question we failed to answer would be the same fail-open move
 * D-134 removed elsewhere.
 */
export function headTierFor(declaredHead, observedHead) {
  if (!declaredHead) return HEAD_TIER.UNDECLARED;
  const observed = typeof observedHead === "string" ? observedHead.toLowerCase() : null;
  if (!observed) return HEAD_TIER.UNDECLARED;
  const shorter = Math.min(declaredHead.length, observed.length);
  return declaredHead.slice(0, shorter) === observed.slice(0, shorter) ? HEAD_TIER.CURRENT : HEAD_TIER.STALE;
}

/**
 * PR #80 REVIEW BLOCKER 3 - AN UNSUCCESSFUL TERMINAL REPORT SUPERSEDED REAL WORK.
 *
 * Supersession is a RETIREMENT: the older task becomes TERMINAL and is never
 * dispatched again by any run. The only thing that may justify it is positive
 * evidence that the architect's newer order actually carried, because that is
 * the whole argument - "the repository has moved on, so the older instruction is
 * stale". The first implementation asked a much weaker question:
 *
 *     const isComplete = (e) =>
 *       e.record?.status === TASK_STATUS.COMPLETED || e.completion?.complete === true;
 *
 * Both halves are wrong for this purpose:
 *
 *  - `completion.complete` is true for EVERY terminal report, including
 *    `STATUS=BLOCKED` and `STATUS=FAILED`. `assessCompletion` already computes
 *    `successful` and it was simply not consulted. A newer task that reported
 *    "I am blocked, I changed nothing" therefore permanently retired an older,
 *    still-valid retry - the newer task did NOT move the repository on, so the
 *    older order was not stale at all.
 *
 *  - the worker records an unsuccessful terminal report as
 *    `status: COMPLETED, successful: false` (see `reconcileReportedTasks` and
 *    the completion path in worker.mjs). So the local-record half re-admitted
 *    exactly the same failure through the state file, one run later, even after
 *    the fresh-truth half had been fixed.
 *
 * The rule is now POSITIVE and explicit. An older task may be retired only when
 * one of these is true:
 *
 *   SUCCESSFUL_COMPLETION   a strictly newer task has a terminal outcome that is
 *                           canonically SUCCESSFUL - from a fresh trusted report
 *                           (`successful === true`) or from a local record that
 *                           positively states `successful === true`. Anything
 *                           less - blocked, failed, unknown vocabulary, a legacy
 *                           record that never recorded success - supersedes
 *                           NOTHING and leaves the older task exactly as it was.
 *
 *   EXPLICIT_DECLARATION    a strictly newer TRUSTED ARCHITECT_TASK states
 *                           `SUPERSEDES=<exact TASK_ID>`. This is the architect
 *                           saying so directly, which is authority in its own
 *                           right and does not need the new task to have run.
 *                           It is exact (full string equality against a task the
 *                           worker actually knows), directional (an older
 *                           declaration can never retire a newer task), and
 *                           auditable (the declaring comment id is carried into
 *                           the decision and into worker state).
 *
 * Fail-closed direction: when in doubt the older task is NOT retired. The cost
 * of not retiring is one status notice and a task that stays visible; the cost
 * of retiring wrongly is silently discarded work.
 */
export const SUPERSESSION_BASIS = Object.freeze({
  SUCCESSFUL_COMPLETION: "newer_task_completed_successfully",
  EXPLICIT_DECLARATION: "explicit_trusted_supersedes_declaration"
});

/** The field a trusted ARCHITECT_TASK uses to retire an older order explicitly. */
export const SUPERSEDES_FIELD = "SUPERSEDES";

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
 * Every TASK_ID this trusted task explicitly declares it supersedes.
 *
 * Read from the ARCHITECT_TASK comment and from its additive scope updates -
 * both of which `collectTrustedTasks` has already validated as authored by the
 * trusted login on the control issue. Nothing else is consulted: a PR body, a CI
 * log or an untrusted comment can never declare a supersession.
 *
 * Every declared id must itself be a syntactically valid TASK_ID, so a malformed
 * or path-shaped value is dropped rather than matched loosely.
 */
export function declaredSupersedes(entry) {
  const bodies = [entry?.comment?.body, ...(entry?.updates ?? []).map((u) => u?.body)];
  const ids = [];
  for (const body of bodies) {
    for (const line of String(body ?? "").split(/\r?\n/)) {
      const m = line.match(new RegExp(`^${SUPERSEDES_FIELD}=(.*)$`));
      if (!m) continue;
      for (const raw of m[1].split(/[,\s]+/)) {
        const id = raw.trim();
        if (id && isValidTaskId(id) && !ids.includes(id)) ids.push(id);
      }
    }
  }
  return ids;
}

/** Total, deterministic "a was issued before b": time first, comment id as tie-break. */
function strictlyOlder(a, b) {
  if (a.createdMs !== b.createdMs) return a.createdMs < b.createdMs;
  return a.commentId < b.commentId;
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
export function selectNextTask({ tasks, state, comments, trustedAuthor, nowMs, observedHead = null }) {
  const entries = (tasks ?? []).map((entry) => {
    const record = getTask(state, entry.taskId);
    const expectedHead = declaredExpectedHead(entry);
    return {
      entry,
      taskId: entry.taskId,
      record,
      createdMs: createdMs(entry),
      commentId: commentId(entry),
      completion: null,
      tier: (record?.attempts ?? 0) > 0 ? TIER.RETRY : TIER.FRESH,
      expectedHead,
      headTier: headTierFor(expectedHead, observedHead)
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
   * Did this task end in POSITIVE SUCCESS?
   *
   * Fresh truth wins and is answered on its own terms: when a trusted terminal
   * report exists, `successful` is the canonical verdict for it and the local
   * record is not consulted at all - otherwise a stale `completed` row could
   * re-admit a report the vocabulary has since classified as BLOCKED/FAILED.
   *
   * Only when there is no fresh terminal report do we fall back to the record,
   * and then `successful` must be POSITIVELY true. `undefined` is not success:
   * a legacy v1-migrated row, or any row written before this field existed,
   * never proves the newer order carried.
   */
  const isSuccessfullyComplete = (e) => {
    // D-135: THE DURABLE COMPLETION GATE OUTRANKS FRESH TRUTH - and only here.
    //
    // Fresh truth normally wins on purpose (see FRESH TRUTH above), but the fresh
    // truth in question IS the `STATUS=COMPLETE` report, and the gate exists
    // precisely because that report's success claim could not be substantiated:
    // the commits the attempt left behind are not provably this task's own. So
    // the check below is not "stale bookkeeping beating a report" - it is a
    // recorded, positive finding that the report's SUCCESS claim is unproven.
    //
    // Note the asymmetry, which is the whole safety argument: a held gate can
    // only ever make a task count as LESS successful, never more. It can
    // therefore only ever PREVENT a retirement, and the failure it prevents
    // (older, still-valid work silently discarded on the strength of an
    // unverified commit range) is strictly worse than the one it costs (one
    // extra status notice and a task that stays visible).
    if (completionGateHeld(e.record)) return false;
    if (e.completion?.complete === true) return e.completion.successful === true;
    if (e.record?.status === TASK_STATUS.COMPLETED) return e.record.successful === true;
    return false;
  };

  // The newest task that genuinely SUCCEEDED. Anything strictly older than that
  // is a stale order - and nothing else implies staleness.
  let newestSuccessful = null;
  for (const e of entries) {
    if (!isValidTaskId(e.taskId)) continue;
    if (!isSuccessfullyComplete(e)) continue;
    if (newestSuccessful === null || strictlyOlder(newestSuccessful, e)) newestSuccessful = e;
  }

  // Explicit, trusted, exact retirements: `SUPERSEDES=<TASK_ID>` on a strictly
  // newer trusted ARCHITECT_TASK. Directional by construction - an older
  // declaration can never retire a task issued after it.
  const explicitSupersessions = new Map();
  for (const e of entries) {
    if (!isValidTaskId(e.taskId)) continue;
    // D-135: a task whose completion gate is HELD retires nothing, on ANY basis.
    //
    // This is deliberately stricter than D-133's explicit-declaration rule, which
    // holds that `SUPERSEDES=` is the architect's own authority and does not need
    // the declaring task to have run. That argument is sound for a task that is
    // merely unfinished. It is not sound for THIS state, which is narrower and
    // worse: the declaring task claimed success, and the worker found commits in
    // its worktree that it cannot account for. Until a human has established what
    // those commits are, the declaring task is not a safe basis for retiring
    // anything - so the order is preserved unexecuted rather than acted on
    // halfway. Re-issuing the retirement after reconciliation is one comment; the
    // work discarded by getting this wrong is not recoverable that cheaply.
    if (completionGateHeld(e.record)) continue;
    for (const targetId of declaredSupersedes(e.entry)) {
      if (targetId === e.taskId) continue; // a task never retires itself
      const victim = entries.find((x) => x.taskId === targetId);
      if (!victim) continue;               // only tasks this worker actually knows
      if (!strictlyOlder(victim, e)) continue;
      if (explicitSupersessions.has(targetId)) continue; // first (oldest) declaration wins
      explicitSupersessions.set(targetId, {
        by: e.taskId,
        commentId: e.commentId,
        createdAt: e.entry?.comment?.created_at ?? null
      });
    }
  }

  /**
   * Should this task be retired as superseded, and on exactly what evidence?
   * Returns `null` when it must NOT be retired - which is the default.
   */
  const supersessionFor = (e) => {
    const explicit = explicitSupersessions.get(e.taskId);
    if (explicit) {
      return {
        basis: SUPERSESSION_BASIS.EXPLICIT_DECLARATION,
        by: explicit.by,
        declaredByCommentId: explicit.commentId,
        detail: `trusted ARCHITECT_TASK ${explicit.by} (comment ${explicit.commentId}) declares `
          + `${SUPERSEDES_FIELD}=${e.taskId}`
      };
    }
    if (newestSuccessful && strictlyOlder(e, newestSuccessful)) {
      return {
        basis: SUPERSESSION_BASIS.SUCCESSFUL_COMPLETION,
        by: newestSuccessful.taskId,
        declaredByCommentId: null,
        detail: `${newestSuccessful.taskId} completed SUCCESSFULLY `
          + `(${newestSuccessful.completion?.canonicalStatus ?? newestSuccessful.record?.report_status_canonical ?? "recorded successful"})`
      };
    }
    return null;
  };

  // --- pass 2: eligibility --------------------------------------------------
  const decisions = [];
  const dispatchable = [];

  for (const e of entries) {
    const supersession = isValidTaskId(e.taskId) ? supersessionFor(e) : null;

    const push = (eligible, reason) => {
      decisions.push({
        taskId: e.taskId,
        eligible,
        reason,
        tier: e.tier,
        // D-139: surfaced on every decision so a dry run shows WHY a stale
        // order lost, instead of leaving it to be inferred from the ordering.
        headTier: e.headTier,
        expectedHead: e.expectedHead,
        headMatchesObserved: e.headTier === HEAD_TIER.CURRENT,
        attempts: e.record?.attempts ?? 0,
        createdAt: e.entry?.comment?.created_at ?? null,
        completion: e.completion,
        supersededBy: reason === INELIGIBLE.SUPERSEDED ? supersession.by : null,
        supersessionBasis: reason === INELIGIBLE.SUPERSEDED ? supersession.basis : null,
        supersessionDetail: reason === INELIGIBLE.SUPERSEDED ? supersession.detail : null,
        supersessionDeclaredByCommentId:
          reason === INELIGIBLE.SUPERSEDED ? supersession.declaredByCommentId : null
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

    // The architect has moved on: a strictly newer order either SUCCEEDED, or
    // explicitly declared this one retired. A newer BLOCKED/FAILED/unknown task
    // reaches neither condition and leaves this task untouched.
    if (supersession) {
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
  // D-139: HEAD TIER OUTRANKS EVERYTHING ELSE.
  //
  // An order written against a head the repository has since left cannot be
  // carried out as written - its own pre-flight would refuse. So it may never
  // be chosen ahead of an order that names the head we are actually on. This
  // sorts before tier deliberately: a STALE fresh task must lose to a CURRENT
  // retry, because the retry is at least still executable.
  dispatchable.sort((a, b) => {
    if (a.headTier !== b.headTier) return a.headTier - b.headTier;
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
    candidateHeadTier: chosen?.headTier ?? null,
    candidateExpectedHead: chosen?.expectedHead ?? null,
    observedHead: observedHead ?? null,
    decisions,
    // The newest task that positively SUCCEEDED, or null. Kept as a summary for
    // logging and the dry run; the per-decision `supersededBy` is authoritative,
    // because an explicit declaration can retire a task no successful run covers.
    supersededBy: newestSuccessful?.taskId ?? null,
    newestSuccessfulTaskId: newestSuccessful?.taskId ?? null,
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

/**
 * THE ATOMIC AUTHORITY SNAPSHOT (D-151).
 *
 * ------------------------------------------------------------------------
 * WHAT D-150 LEFT OPEN
 * ------------------------------------------------------------------------
 *
 * D-150 built the right rule and put it in the right module:
 *
 *     A TASK EXECUTES EXACTLY ONE IMMUTABLE, COMPLETELY-READ, UNIQUELY
 *     IDENTIFIED ORDER, OR IT EXECUTES NOTHING.
 *
 * `selectAdmissibleOrder` implements it, and nothing here weakens it. But the
 * worker only ever ASKED it once, LATE, and for ONE task - the task the queue had
 * already chosen. Everything the cycle did before that point still ran on an
 * unproven read and on an authority that had been decided a second, weaker way:
 *
 *  1. AN INCOMPLETE READ WAS STILL ONLY A WARNING AT THE TOP OF THE RUN.
 *     `runOwned` logged "the control issue read is INCOMPLETE" and carried
 *     straight on into crash recovery, report reconciliation, queue selection and
 *     retirement - each of which writes durable, terminal state. A dropped page
 *     therefore could not stop a task being SUPERSEDED, COMPLETED or BLOCKED; it
 *     could only stop the very last step, dispatch.
 *
 *  2. AUTHORITY WAS DECIDED TWICE, AND THE EARLY DECIDER WAS THE WEAK ONE.
 *     `collectTrustedTasks` computed its own `uniqueAuthority` from a count and
 *     picked a representative comment by ARRAY POSITION. That representative is
 *     what the queue read `created_at` and `id` from when it ranked orders, and
 *     that boolean knew nothing about the read's completeness, about the edit
 *     check, about the comment id or about `created_at`.
 *
 *  3. SEMANTIC FIELDS FROM AN INADMISSIBLE ORDER STILL MOVED STATE. Gating on
 *     `uniqueAuthority` alone let a UNIQUE but EDITED order declare `SUPERSEDES=`
 *     and permanently retire a victim, and let an order with no parseable
 *     `created_at` or no usable comment id score `0`/`0` in the queue's
 *     comparators, sort to the FRONT of the fresh tier, and preempt a live order
 *     with its `EXPECTED_HEAD_SHA`. All three were refused at admission - after
 *     the retirement had already been persisted.
 *
 * ------------------------------------------------------------------------
 * THE RULE
 * ------------------------------------------------------------------------
 *
 *     A WORKER CYCLE DECIDES FROM ONE COMPLETE, IMMUTABLE SNAPSHOT, OR IT
 *     DECIDES NOTHING.
 *
 * Two properties, and the second depends on the first:
 *
 *   COMPLETE   The snapshot is captured ONCE, immediately after the auth and read
 *              evidence, and it is USABLE only when the read provably succeeded
 *              AND provably covered the whole issue. An unproven read is not a
 *              small read: the page that went missing is exactly where the second
 *              same-id order, the newer report or the retirement that changes
 *              every verdict below would be sitting. So it decides nothing at
 *              all - not recovery, not reconciliation, not retirement, not
 *              selection, not dispatch.
 *
 *   CLASSIFIED ONCE  Every task id the snapshot contains is classified by the
 *              ONE existing classifier (`selectAdmissibleOrder`), here, together,
 *              against the same frozen comment set. The verdict then TRAVELS:
 *              queue selection, retirement and dispatch all read the verdict that
 *              was computed here rather than re-deriving one. There is no second
 *              parser, no count-derived boolean and no array-position
 *              representative left for anything to consult.
 *
 * WHAT AN ENTRY DELIBERATELY DOES NOT CARRY. An INADMISSIBLE entry has
 * `order === null` and `comment === null`. Not "the first candidate", not "the
 * newest candidate" - nothing. Every downstream reader of an order's semantics
 * (`EXPECTED_HEAD_SHA`, `SUPERSEDES`, the executable body, the ordering key the
 * queue ranks and proves direction with) therefore reads `null` and fails closed
 * by construction rather than by remembering to check a flag. The candidate
 * comment IDS are still carried, because a refusal a human cannot go and look at
 * is not an auditable refusal - but ids are not semantics.
 *
 * Every function here is PURE: already-fetched comment objects in, a verdict out.
 * No file, no network, no repository, no clock beyond what the caller supplies.
 */

import { collectTrustedTasks } from "./trust.mjs";
import {
  ORDER_AUTHORITY,
  describeOrderAuthority,
  selectAdmissibleOrder
} from "./order-authority.mjs";

/** One name per distinct finding about THE READ. Every one of them FAILS CLOSED. */
export const AUTHORITY_SNAPSHOT = Object.freeze({
  /** A complete, proven read. The only state in which this cycle may decide. */
  USABLE: "the_control_comment_snapshot_was_proven_complete_and_may_decide_this_cycle",

  /** The read threw or reported failure. This cycle holds no evidence at all. */
  READ_FAILED: "the_control_issue_read_failed_so_this_cycle_holds_no_authority_snapshot",
  /**
   * The read returned data and was NOT proven to cover the whole issue - a
   * dropped or truncated `--paginate` fragment. Deliberately distinct from a
   * failure: the data in hand may look perfectly good, and that is precisely the
   * danger. The order that would change the verdict is on the page we lost.
   */
  READ_INCOMPLETE: "at_least_one_paginated_fragment_of_the_control_issue_could_not_be_read",
  /**
   * The caller supplied comments without ever establishing how good its read was
   * - historically a bare array. Not the same finding as INCOMPLETE ("we know it
   * was short") and emphatically not the same as USABLE. Nobody looked.
   */
  READ_UNPROVEN: "the_caller_supplied_control_comments_without_proving_the_read_was_complete"
});

/** The frozen, empty snapshot a refusal hands back. It decides nothing. */
function refusedSnapshot(reason, detail) {
  return Object.freeze({
    ok: false,
    reason,
    detail,
    // TRANSIENT by nature: every finding here is about THIS READ, never about an
    // order. Making a dropped page terminal for a task would hand a denial of
    // service to anyone who can make one request fail.
    retryable: true,
    readOk: reason !== AUTHORITY_SNAPSHOT.READ_FAILED,
    complete: false,
    comments: Object.freeze([]),
    commentCount: 0,
    entries: Object.freeze([]),
    taskIds: Object.freeze([]),
    admissibleTaskIds: Object.freeze([]),
    inadmissibleTaskIds: Object.freeze([]),
    entryFor: () => null,
    authorityFor: () => null
  });
}

/**
 * CAPTURE THE CYCLE'S ONE AUTHORITY SNAPSHOT.
 *
 * `control` is `fetchIssueCommentsDetailed`'s `{ ok, items, complete, error }`,
 * or - historically, and still accepted so that no caller can pass one by
 * accident and get away with it - a bare array. A bare array is READ_UNPROVEN:
 * accepted as input, never accepted as evidence.
 *
 * Returns a frozen snapshot. `ok: false` means this cycle decides NOTHING, and
 * the caller must return a nonzero transient result without touching any task,
 * claim, worktree, repository or remote.
 */
export function captureAuthoritySnapshot({ control, trustedAuthor, capturedAt = new Date().toISOString() }) {
  // --- 1. the read, asked BEFORE a single comment is looked at ---------------
  if (Array.isArray(control)) {
    return refusedSnapshot(AUTHORITY_SNAPSHOT.READ_UNPROVEN,
      `the control comments were supplied as a bare array of ${control.length} item(s) with no completeness `
      + "evidence; a read nobody vouched for cannot establish that an order is unique, that a report is absent, "
      + "or that a retirement is safe");
  }
  if (!control || typeof control !== "object") {
    return refusedSnapshot(AUTHORITY_SNAPSHOT.READ_UNPROVEN,
      `no control-comment read result was supplied (${JSON.stringify(control ?? null)})`);
  }
  if (control.ok === false) {
    return refusedSnapshot(AUTHORITY_SNAPSHOT.READ_FAILED,
      `the control-issue comment read failed (${control.error ?? "no error reported"}), so this cycle holds no `
      + "evidence at all about which orders, reports or retirements exist");
  }
  const items = Array.isArray(control.items)
    ? control.items
    : (Array.isArray(control.comments) ? control.comments : null);
  if (items === null) {
    return refusedSnapshot(AUTHORITY_SNAPSHOT.READ_UNPROVEN,
      "the control-comment read result carries no readable comment array");
  }
  if (control.complete !== true) {
    return refusedSnapshot(
      control.complete === false ? AUTHORITY_SNAPSHOT.READ_INCOMPLETE : AUTHORITY_SNAPSHOT.READ_UNPROVEN,
      control.complete === false
        ? `${control.dropped_fragments ?? "one or more"} paginated fragment(s) of the control issue could not be `
          + `read (${control.error ?? "no error reported"}). The ${items.length} comment(s) that did come back may `
          + "look complete and self-consistent, which is exactly why they may not decide anything: a second "
          + "same-id order, a newer report or a retirement would be on the page that was lost."
        : "the read never established that it covered the whole control issue, and an unproven read cannot "
          + "establish uniqueness, absence or safety");
  }

  // --- 2. one classification pass, over the whole frozen set ----------------
  //
  // `collectTrustedTasks` GROUPS. It does not decide, it does not rank and - since
  // this change - it does not publish a representative order. The decision below
  // is `selectAdmissibleOrder`'s, asked once per task id against this one
  // snapshot, so that every later reader is reading the same verdict rather than
  // computing its own.
  const comments = Object.freeze([...items]);
  const grouped = collectTrustedTasks(comments, { trustedAuthor });

  const entries = grouped.map((group) => {
    const authority = selectAdmissibleOrder({
      comments,
      commentsOk: true,
      commentsComplete: true,
      trustedAuthor,
      taskId: group.taskId
    });
    const admissible = authority.ok === true && authority.reason === ORDER_AUTHORITY.ADMISSIBLE;
    return Object.freeze({
      taskId: group.taskId,
      authority,
      admissible,
      /**
       * THE ONE PROVEN ORDER, or `null`. Read by everything executable.
       *
       * `comment` is the same value under the name the queue and the dispatcher
       * already use, so that an INADMISSIBLE entry hands them `null` rather than
       * a plausible-looking representative they would have to remember to reject.
       */
      order: admissible ? authority.comment : null,
      comment: admissible ? authority.comment : null,
      orderCommentId: admissible ? authority.commentId : null,
      orderCreatedAt: admissible ? authority.createdAt : null,
      /** Ids only - enough for a human to go and look, never enough to execute. */
      candidateCommentIds: Object.freeze([...(authority.candidateIds ?? [])]),
      distinctOrderCount: authority.distinctCount ?? group.distinctOrderCount ?? 0
    });
  });

  const byId = new Map(entries.map((e) => [e.taskId, e]));

  return Object.freeze({
    ok: true,
    reason: AUTHORITY_SNAPSHOT.USABLE,
    detail: null,
    retryable: false,
    readOk: true,
    complete: true,
    captured_at: capturedAt,
    comments,
    commentCount: comments.length,
    entries: Object.freeze(entries),
    taskIds: Object.freeze(entries.map((e) => e.taskId)),
    admissibleTaskIds: Object.freeze(entries.filter((e) => e.admissible).map((e) => e.taskId)),
    inadmissibleTaskIds: Object.freeze(entries.filter((e) => !e.admissible).map((e) => e.taskId)),
    entryFor: (taskId) => byId.get(taskId) ?? null,
    authorityFor: (taskId) => byId.get(taskId)?.authority ?? null
  });
}

/**
 * The snapshot's own evidence, for a record, a log line or a status comment.
 *
 * Counts, ids, reasons and digest-free metadata only: safe to post anywhere.
 */
export function authoritySnapshotEvidence(snapshot) {
  return {
    snapshot_usable: snapshot?.ok === true,
    snapshot_reason: snapshot?.reason ?? null,
    snapshot_detail: snapshot?.detail ?? null,
    control_read_ok: snapshot?.readOk === true,
    control_comments_complete: snapshot?.complete === true,
    control_comment_count: snapshot?.commentCount ?? 0,
    trusted_task_ids: [...(snapshot?.taskIds ?? [])],
    admissible_task_ids: [...(snapshot?.admissibleTaskIds ?? [])],
    inadmissible_task_ids: [...(snapshot?.inadmissibleTaskIds ?? [])]
  };
}

/** One JSON-friendly verdict per task id, for the dry run and for status output. */
export function authorityVerdicts(snapshot) {
  return (snapshot?.entries ?? []).map((e) => ({
    task_id: e.taskId,
    admissible: e.admissible,
    reason: e.authority?.reason ?? null,
    detail: e.authority?.detail ?? null,
    retryable: e.admissible ? false : (e.authority?.retryable === true),
    distinct_order_count: e.distinctOrderCount,
    candidate_comment_ids: [...e.candidateCommentIds],
    order_comment_id: e.orderCommentId,
    order_created_at: e.orderCreatedAt
  }));
}

/** Human-readable lines for a log or a status comment. */
export function describeAuthoritySnapshot(snapshot, { limit = 12 } = {}) {
  if (!snapshot) return [];
  const lines = [
    `CONTROL AUTHORITY SNAPSHOT: ${snapshot.ok ? "USABLE" : "REFUSED"} (${snapshot.reason})`,
    `  read ok: ${snapshot.readOk === true}, proven complete: ${snapshot.complete === true}, `
      + `comments: ${snapshot.commentCount ?? 0}`
  ];
  if (snapshot.detail) lines.push(`  ${snapshot.detail}`);
  if (!snapshot.ok) {
    lines.push("  nothing was decided from it: no recovery, no reconciliation, no retirement, no selection, "
      + "no prompt, no child.");
    return lines;
  }
  lines.push(`  trusted task ids: ${snapshot.taskIds.length} `
    + `(${snapshot.admissibleTaskIds.length} admissible, ${snapshot.inadmissibleTaskIds.length} refused)`);
  for (const entry of snapshot.entries.slice(0, limit)) {
    for (const line of describeOrderAuthority(entry.authority, { taskId: entry.taskId })) lines.push(`  ${line}`);
  }
  if (snapshot.entries.length > limit) {
    lines.push(`  ... and ${snapshot.entries.length - limit} more task id(s)`);
  }
  return lines;
}

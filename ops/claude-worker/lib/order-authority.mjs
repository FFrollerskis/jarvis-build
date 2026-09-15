/**
 * ADMISSION-TIME ORDER AUTHORITY (D-150).
 *
 * ------------------------------------------------------------------------
 * WHAT D-149 LEFT OPEN
 * ------------------------------------------------------------------------
 *
 * D-149 made an ADMITTED task's authority immutable: the worker writes down which
 * comment ordered the task and exactly what it said, before it dispatches, and
 * every later completion path reads the binding rather than re-reading mutable
 * text. That is the right invariant, and nothing here weakens it.
 *
 * But it only ever constrained what happens AFTER admission. The act of admission
 * itself - choosing which comment becomes the binding, and which bytes get sent to
 * Claude - was still decided the old way, and three seams survived:
 *
 *  1. AN INCOMPLETE READ STILL ADMITTED. `control.complete === false` produced a
 *     log line, and the run went on to bind, create a worktree and dispatch. So an
 *     order that was in fact accompanied by a second, contradicting same-id order
 *     on a page `--paginate` dropped was admitted as though it were unique. The
 *     completeness verdict existed; nothing required it before the decision that
 *     matters most.
 *
 *  2. ADMISSION PICKED BY ARRAY ORDER. `collectTrustedTasks` made the FIRST
 *     same-id comment the task's `comment` and filed the rest as `updates`.
 *     D-148's count-based `selectCanonicalArchitectTask` - which refuses rather
 *     than choosing - was not consulted at admission at all. A forged duplicate
 *     was therefore refused at COMPLETION time but silently accepted at DISPATCH
 *     time, and dispatch is where the child actually gets its instructions.
 *
 *  3. UNBOUND BODIES WERE EXECUTABLE. `buildPrompt` appended every `updates[]`
 *     body to the prompt as an "additive scope update". The durable binding covers
 *     the canonical comment and nothing else, so those bytes were executable
 *     authority that no binding covered, that no review had to have seen, and that
 *     a retry would pick up if they appeared after admission.
 *
 * ------------------------------------------------------------------------
 * THE RULE
 * ------------------------------------------------------------------------
 *
 *     A TASK EXECUTES EXACTLY ONE IMMUTABLE, COMPLETELY-READ, UNIQUELY
 *     IDENTIFIED ORDER, OR IT EXECUTES NOTHING.
 *
 * Four questions, asked in this order, every one of them fail-closed:
 *
 *   1. WAS THE READ COMPLETE? Not "did we get something back" - was every page
 *      read and parsed. An unproven read cannot establish uniqueness, because the
 *      thing that would break uniqueness is precisely what a lost page hides.
 *   2. IS THE AUTHORITY UNIQUE? Exactly one distinct trusted ARCHITECT_TASK for
 *      this TASK_ID. Zero, two, two-wearing-one-id, or an edited one is not an
 *      order to execute. Nothing is CHOSEN; the set's size decides.
 *   3. IS IT DETERMINISTICALLY IDENTIFIED AND ORDERED? GitHub's own comment id,
 *      and a parseable `created_at`. Both are what the binding compares against
 *      later, and what the queue orders by; an order carrying neither cannot be
 *      proven to be the same order twice.
 *   4. IS THERE A BODY TO EXECUTE? A comment with no readable body is not an
 *      instruction.
 *
 * SAME-ID TASK_UPDATE SEMANTICS ARE GONE. A second same-id comment is not an
 * additive scope update - it is a second order, and one task id has exactly one
 * order. Changed or consolidated scope is issued as a FRESH TASK_ID carrying an
 * explicit `SUPERSEDES=<old id>`, which is already the queue's supported,
 * directional, auditable retirement path. This is deliberately NOT a
 * compatibility shim: a legacy ambiguous record holds and requires a fresh id,
 * because a shim that "still executes the old shape when it looks safe" is the
 * same forward-scan-for-a-usable-order this module exists to remove.
 *
 * WHY THE DoS IS THE RIGHT COST. Anyone who can post a same-id duplicate can
 * therefore stop a task from ever dispatching. That is real, and it is still the
 * correct trade: the worker cannot distinguish an architect's scope update from a
 * child's forgery - same login, same shape - and refusing is recoverable with one
 * fresh TASK_ID, while accepting is not recoverable at all.
 *
 * Every function here is PURE: already-fetched comment objects in, a verdict out.
 * No file, no network, no repository.
 */

import { validateTrustedTask } from "./trust.mjs";
import {
  collapseIdenticalOrderRepeats,
  normalizeCommentId,
  normalizeCreatedAt,
  orderByIssueSequence
} from "./order-binding.mjs";

// Re-exported so callers reasoning about ORDER AUTHORITY have one import to
// reach for. The definitions live in the leaf module (`order-binding.mjs`) so
// that `trust.mjs` can use them without importing this file, which imports
// `trust.mjs`.
export { collapseIdenticalOrderRepeats, commentIdentity, orderByIssueSequence } from "./order-binding.mjs";

/** One name per distinct finding. Every one of them FAILS CLOSED. */
export const ORDER_AUTHORITY = Object.freeze({
  /** Exactly one trusted, unedited, fully identified order. The only pass. */
  ADMISSIBLE: "exactly_one_trusted_unedited_architect_order_identifies_this_task",

  /* --- the read, before anything is counted --- */
  /** The control-issue read failed outright. Nothing may be admitted from it. */
  READ_FAILED: "the_control_issue_read_failed_so_no_order_may_be_admitted_from_it",
  /**
   * The read returned data but was not PROVEN complete - a dropped or truncated
   * paginated fragment, or a caller that never established completeness. Distinct
   * from a failure on purpose: the order may well be sitting in `items`, and it
   * still may not be admitted, because the page we lost is exactly where a second
   * same-id order would be hiding.
   */
  READ_INCOMPLETE: "the_control_comment_collection_was_not_proven_complete_so_uniqueness_cannot_be_established",

  /* --- the set --- */
  /** No trusted ARCHITECT_TASK for this id. Only ever honest BEFORE admission. */
  NO_ORDER: "no_trusted_architect_task_comment_declares_this_task_id",
  /** Two or more distinct trusted orders for one id. Refused, never resolved. */
  AMBIGUOUS: "more_than_one_distinct_trusted_architect_task_comment_declares_this_task_id",
  /** Created and last-updated differ: the reviewed text is not the executed text. */
  EDITED: "the_trusted_architect_task_comment_was_edited_after_it_was_posted",

  /* --- the one candidate's own metadata --- */
  /** No usable GitHub comment id, so the order cannot be identified across runs. */
  NO_COMMENT_IDENTITY: "the_trusted_architect_task_comment_carries_no_usable_github_comment_id",
  /** No parseable `created_at`, so the order carries no deterministic ordering. */
  NO_ORDERING_METADATA: "the_trusted_architect_task_comment_carries_no_parseable_created_at_ordering_metadata",
  /** Nothing to execute. */
  NO_BODY: "the_trusted_architect_task_comment_carries_no_readable_body_to_execute"
});

/** Every trusted ARCHITECT_TASK declaring EXACTLY this task id. */
export function trustedOrdersFor(comments, { trustedAuthor, taskId }) {
  const found = [];
  for (const comment of Array.isArray(comments) ? comments : []) {
    const trusted = validateTrustedTask(comment, { trustedAuthor });
    // EXACT id equality. A trusted order for a neighbouring task is not this
    // task's order, however similar the id looks.
    if (!trusted.ok || trusted.taskId !== taskId) continue;
    found.push(comment);
  }
  return found;
}

/**
 * THE ADMISSION GATE.
 *
 * `{ ok, reason, detail, comment, commentId, createdAt, candidateIds,
 * distinctCount, retryable }`.
 *
 * `retryable` is the one thing the caller cannot derive for itself and must not
 * guess:
 *
 *   true   the finding is about THIS READ (failed, incomplete). Nothing about the
 *          order is known to be wrong, so the task stays non-terminal and fully
 *          eligible. Making a flaky page permanently kill a task would hand a
 *          denial of service to the network.
 *   false  the finding is about the ORDER (absent, ambiguous, edited, unidentified,
 *          unordered, empty). A retry asks the identical question and gets the
 *          identical answer; the recovery is a human and a FRESH TASK_ID.
 */
export function selectAdmissibleOrder({
  comments,
  commentsOk = null,
  commentsComplete = null,
  trustedAuthor,
  taskId
}) {
  const refuse = (reason, detail, { retryable = false, candidateIds = [], distinctCount = 0 } = {}) => ({
    ok: false,
    reason,
    detail,
    comment: null,
    commentId: null,
    createdAt: null,
    candidateIds,
    distinctCount,
    retryable
  });

  if (typeof taskId !== "string" || taskId.trim() === "") {
    return refuse(ORDER_AUTHORITY.NO_ORDER,
      `no task id to admit an order for (${JSON.stringify(taskId ?? null)})`);
  }

  // --- 1. the read ----------------------------------------------------------
  //
  // Asked BEFORE a single candidate is counted, and asked of the READ rather than
  // of the result. A collection we cannot vouch for can neither prove that the
  // order is unique nor prove that it is present, and both of those are load
  // bearing below.
  if (commentsOk === false) {
    return refuse(ORDER_AUTHORITY.READ_FAILED,
      "the control-issue comment read failed, so this run holds no evidence at all about which orders exist",
      { retryable: true });
  }
  if (commentsComplete !== true) {
    return refuse(ORDER_AUTHORITY.READ_INCOMPLETE,
      commentsComplete === false
        ? "at least one paginated fragment of the control issue could not be read, so a second same-id order "
          + "could be sitting on the page that was lost"
        : "the caller never established that the control comment collection was read completely, and an "
          + "unproven read cannot establish that an order is unique",
      { retryable: true });
  }

  // --- 2. the set -----------------------------------------------------------
  const candidates = trustedOrdersFor(comments, { trustedAuthor, taskId });
  const distinct = collapseIdenticalOrderRepeats(candidates).sort(orderByIssueSequence);
  // GitHub's own ids, exactly as they came back: what a human can paste into a URL.
  const ids = distinct.map((c) => c?.id ?? null);

  if (distinct.length === 0) {
    return refuse(ORDER_AUTHORITY.NO_ORDER,
      `no trusted ARCHITECT_TASK among ${Array.isArray(comments) ? comments.length : 0} control comment(s) `
      + `declares TASK_ID=${JSON.stringify(taskId)}`,
      { candidateIds: ids, distinctCount: 0 });
  }
  if (distinct.length > 1) {
    return refuse(ORDER_AUTHORITY.AMBIGUOUS,
      `${distinct.length} distinct trusted ARCHITECT_TASK comments declare TASK_ID=${JSON.stringify(taskId)} `
      + `(ids ${ids.map((i) => JSON.stringify(i)).join(", ")}). One task id has exactly one order, so a second `
      + "one makes the authority undecidable rather than updated - and a same-id TASK_UPDATE is a second order, "
      + "not an amendment. Reissue the consolidated scope under a FRESH TASK_ID with an explicit SUPERSEDES.",
      { candidateIds: ids, distinctCount: distinct.length });
  }

  const comment = distinct[0];
  const evidence = { candidateIds: ids, distinctCount: 1 };

  // --- 3. deterministic identity and ordering -------------------------------
  const commentId = normalizeCommentId(comment?.id);
  if (commentId === null) {
    return refuse(ORDER_AUTHORITY.NO_COMMENT_IDENTITY,
      `the sole trusted order for ${JSON.stringify(taskId)} carries id ${JSON.stringify(comment?.id ?? null)}, `
      + "which cannot identify it across runs - and an order that cannot be re-identified cannot be bound",
      evidence);
  }
  const createdAt = normalizeCreatedAt(comment?.created_at);
  if (createdAt === null) {
    // Ordering metadata is not decoration. It is half of what the durable binding
    // compares on a resume (D-149's CREATED_AT_MISMATCH is the only thing that
    // catches a same-id, same-body repost), and it is what the queue sorts by.
    return refuse(ORDER_AUTHORITY.NO_ORDERING_METADATA,
      `trusted order comment ${JSON.stringify(commentId)} reports `
      + `created_at=${JSON.stringify(comment?.created_at ?? null)}, which is not a parseable timestamp`,
      evidence);
  }
  // The edit check is deliberately identical to the supervisor-command rule and
  // to D-148's: an edit is PROVEN only when both timestamps are present and
  // differ. An API projection or a fixture that omits `updated_at` is not
  // evidence of tampering, and inventing a refusal from a claim nobody made is
  // the opposite failure - but still a failure.
  const updatedAt = String(comment?.updated_at ?? "").trim() || null;
  if (updatedAt !== null && updatedAt !== String(comment?.created_at ?? "").trim()) {
    return refuse(ORDER_AUTHORITY.EDITED,
      `comment ${JSON.stringify(commentId)} was created at ${createdAt} and last updated at ${updatedAt}; `
      + "the order that was independently reviewed and the order about to be executed can no longer be proven "
      + "to be the same text",
      evidence);
  }
  if (typeof comment?.body !== "string" || comment.body.trim() === "") {
    return refuse(ORDER_AUTHORITY.NO_BODY,
      `comment ${JSON.stringify(commentId)} carries no readable body, so there is nothing to execute`,
      evidence);
  }

  return {
    ok: true,
    reason: ORDER_AUTHORITY.ADMISSIBLE,
    detail: null,
    comment,
    commentId,
    createdAt,
    candidateIds: ids,
    distinctCount: 1,
    retryable: false
  };
}

/** Human-readable lines for a status comment or a log. */
export function describeOrderAuthority(selection, { taskId = null } = {}) {
  if (!selection) return [];
  return [
    `ARCHITECT ORDER AUTHORITY: ${selection.ok ? "ADMISSIBLE" : "REFUSED"} (${selection.reason})`,
    `  task: ${taskId ?? "unknown"}`,
    `  distinct trusted orders seen for this id: ${selection.distinctCount}`
      + (selection.candidateIds?.length
        ? ` (ids ${selection.candidateIds.map((i) => JSON.stringify(i)).join(", ")})`
        : ""),
    selection.ok
      ? `  admitted: comment ${selection.commentId} created ${selection.createdAt}`
      : `  admitted: nothing${selection.retryable ? " (this read is at fault, so the task stays eligible)" : ""}`,
    selection.detail ? `  ${selection.detail}` : ""
  ].filter((l) => l !== "");
}

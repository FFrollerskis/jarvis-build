/**
 * D-151 test fixture: build queue entries THE WAY THE WORKER DOES.
 *
 * Before D-151 the queue tests hand-assembled entries - `{ taskId, comment,
 * uniqueAuthority: true }` - which meant they were asserting against a shape
 * nothing in production produced. Worse, `uniqueAuthority: true` is exactly the
 * count-derived boolean D-151 removes, so a hand-built entry could assert a
 * behaviour the real classifier would never have permitted.
 *
 * Everything here therefore runs the REAL `captureAuthoritySnapshot` over a real
 * comment set. A test that wants an INADMISSIBLE entry constructs a comment the
 * real classifier refuses (an edit, a missing id, an unparseable `created_at`, a
 * duplicate) rather than setting a flag.
 */

import { captureAuthoritySnapshot } from "../../lib/authority-snapshot.mjs";

export const TRUSTED_AUTHOR = "tsworkflow";

/** A snapshot over an explicit comment set, complete unless told otherwise. */
export function snapshotOf(comments, { trustedAuthor = TRUSTED_AUTHOR, ok = true, complete = true } = {}) {
  return captureAuthoritySnapshot({
    control: { ok, complete, items: comments, error: complete ? null : "one fragment could not be parsed" },
    trustedAuthor
  });
}

/** Every classified entry for a comment set, in snapshot order. */
export function entriesOf(comments, options = {}) {
  return snapshotOf(comments, options).entries;
}

/** The classified entry for ONE task id, or `null`. */
export function entryOf(comments, taskId, options = {}) {
  return snapshotOf(comments, options).entryFor(taskId) ?? null;
}

/** A minimal, well-formed, trusted ARCHITECT_TASK comment. */
export function orderComment({
  taskId,
  id,
  createdAt,
  updatedAt = undefined,
  body = null,
  extra = "",
  trustedAuthor = TRUSTED_AUTHOR
}) {
  const comment = {
    id,
    created_at: createdAt,
    user: { login: trustedAuthor },
    author_association: "OWNER",
    body: body ?? `ARCHITECT_TASK\nTASK_ID=${taskId}${extra ? `\n${extra}` : ""}`
  };
  if (updatedAt !== undefined) comment.updated_at = updatedAt;
  return comment;
}

/**
 * ONE admissible entry built from ONE comment.
 *
 * Deliberately goes through the classifier rather than fabricating a verdict, so
 * a test entry can never claim an admissibility the production gate would refuse.
 */
export function admissibleEntry({ taskId, id, createdAt, extra = "", body = null }) {
  const comment = orderComment({ taskId, id, createdAt, extra, body });
  const entry = entryOf([comment], taskId);
  if (!entry?.admissible) {
    throw new Error(`fixture error: ${taskId} was expected to be admissible but was `
      + `${entry?.authority?.reason ?? "not classified at all"}`);
  }
  return entry;
}

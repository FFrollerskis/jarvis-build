/**
 * DURABLE ARCHITECT-ORDER BINDING (D-149).
 *
 * ------------------------------------------------------------------------
 * THE DOWNGRADE THIS MODULE CLOSES
 * ------------------------------------------------------------------------
 *
 * D-148 made merge authority IMMUTABLE for an order that is PRESENT. It selects
 * the one trusted ARCHITECT_TASK for a TASK_ID by counting the candidate set, and
 * refuses when the count is not exactly one. That is correct, and nothing here
 * weakens it.
 *
 * But it still answered the question "which order authorized this task?" by
 * re-reading MUTABLE TEXT at completion time - the control issue as it exists
 * NOW, many hours and several worker runs after the task was admitted. And it
 * mapped the empty case straight onto the ordinary path:
 *
 *     |candidates| == 0  ->  NO_TRUSTED_TASK  ->  claim = NONE  ->  not a merge
 *                                                  task -> no transition proof,
 *                                                  no required CI, no bound
 *                                                  closeout report required.
 *
 * So the ENTIRE D-147 requirement - that a merge-authorized task must prove its
 * remote transition whatever its commit range says - could be removed by removing
 * the order. Every one of these produces `|candidates| == 0`:
 *
 *   - the trusted comment is DELETED after the task was admitted and dispatched;
 *   - it is REPLACED by an order carrying a different TASK_ID;
 *   - `--paginate` drops or truncates the page it was on (`parsePaginatedJson`
 *     silently returns `[]` for a fragment it cannot parse);
 *   - the control-issue read FAILS and the caller passes the empty array it was
 *     left holding, which is exactly what `postComments = []` did on a throw;
 *   - worker state is migrated from a build that never recorded which comment the
 *     authority was.
 *
 * The actor able to do the first two is the same actor D-148 was written against:
 * the dispatched child runs `gh` under the repo owner's credentials, so it can
 * delete and re-post control comments as easily as it posts its own report. And
 * unlike a forged duplicate - which D-148 turns into a REFUSAL - a deletion turned
 * the task into an ORDINARY one, which is the cheap, passing path.
 *
 * ------------------------------------------------------------------------
 * ABSENCE OF EVIDENCE, ONE MORE TIME
 * ------------------------------------------------------------------------
 *
 * This is the same class of defect as D-136's null-provenance bypass and D-134's
 * `head_before != head_after`: a question that was never answered being recorded
 * as a favourable answer. Stated as an invariant:
 *
 *     A TASK THE WORKER IS COMPLETION-GATING NECESSARILY HAS AN ORIGINAL ORDER.
 *     It was admitted from one. "I cannot find it now" is a statement about the
 *     WORKER'S READ, never about the ORDER - so it can only ever be UNDECIDABLE.
 *
 * Only PRE-ADMISSION DISCOVERY may read "no matching order" as genuine absence,
 * because at that point there is nothing yet claiming otherwise. That asymmetry
 * is the whole design, and it is why the binding is written at ADMISSION rather
 * than derived later: after admission there is a durable, worker-authored record
 * saying an order existed, what its id was, and exactly what it said.
 *
 * ------------------------------------------------------------------------
 * WHAT IS BOUND, AND WHY EACH PART
 * ------------------------------------------------------------------------
 *
 *   comment_id    GitHub's own id for the canonical ARCHITECT_TASK. Never
 *                 anything the body says about itself. This is what makes
 *                 "a different order appeared" detectable at all.
 *   created_at    the creation timestamp AS IT WAS AT ADMISSION, when the API
 *                 supplied a usable one. A later run seeing a different
 *                 `created_at` for the same id is looking at rewritten history.
 *   body_sha256   a deterministic digest of the EXACT body bytes the trust,
 *                 queue and authorization decisions were made on. One byte
 *                 different - a flag flipped from false to true, a PR number
 *                 changed, a base sha swapped - and the digest does not match.
 *   body_bytes    the byte length, recorded alongside the digest purely so a
 *                 human reconciling a mismatch can see at a glance whether the
 *                 order grew, shrank or was rewritten in place.
 *
 * The digest is over BYTES, not over a parsed projection, because a projection
 * only covers the fields the parser happens to read today. A future field that
 * changes the order's meaning is covered by the digest the moment it is written,
 * with no change here.
 *
 * NOTHING SENSITIVE IS RECORDED. The digest is one-way and the body is not
 * stored, so a binding can be logged, posted in a status comment and read by
 * anyone without leaking the order's content.
 *
 * ------------------------------------------------------------------------
 * IMMUTABILITY
 * ------------------------------------------------------------------------
 *
 * `bindOrderOnce` is the ONLY way a binding is ever produced, and it will not
 * overwrite one. A resume, a retry, a reconciliation or a migration may READ the
 * binding; none of them may replace it or recompute it from text that is now
 * years - or one adversarial `gh api -X PATCH` - removed from the order that was
 * actually reviewed. An attempt to rebind a bound task to a different order is
 * `IMMUTABLE_CONFLICT`, a named refusal, not a silent update.
 *
 * Every function here is PURE: it takes already-fetched comment objects and
 * already-loaded state, and touches no file, no network and no repository.
 */

import { createHash } from "node:crypto";

/** Bump only for a change that makes an OLD binding unreadable by a NEW build. */
export const ORDER_BINDING_VERSION = 1;

/**
 * Domain separator. Without it, a digest computed here could in principle be
 * compared against one computed elsewhere over the same bytes for a different
 * purpose; with it, this digest means exactly one thing.
 */
const DIGEST_DOMAIN = "jarvis/architect-order-binding/v1\n";

/** One name per distinct finding. Every one of them FAILS CLOSED. */
export const ORDER_BINDING = Object.freeze({
  /** The observed order matches the binding exactly. The only pass. */
  BOUND: "the_current_trusted_order_matches_the_durable_binding_exactly",

  /* --- the binding itself --- */
  /**
   * An admitted task has NO durable binding. Either it was admitted by a build
   * from before D-149, or the record was written by something that skipped
   * admission. It is recoverable (reissue under a FRESH TASK_ID, which binds on
   * admission) and it is NEVER inferred to mean "there was no order".
   */
  BINDING_MISSING: "no_durable_architect_order_binding_exists_for_this_admitted_task",
  /** A binding exists but is not a readable binding document. */
  BINDING_INVALID: "the_stored_architect_order_binding_is_structurally_invalid",
  /** The binding belongs to a different TASK_ID than the one being decided. */
  BINDING_TASK_ID_MISMATCH: "the_stored_architect_order_binding_names_a_different_task_id",
  /** A binding written by a newer build this one cannot read. */
  BINDING_VERSION_UNSUPPORTED: "the_stored_architect_order_binding_was_written_by_an_unsupported_version",

  /* --- binding time --- */
  /** The comment offered for binding carries no usable id or body. */
  UNBINDABLE_COMMENT: "the_trusted_order_comment_carries_no_usable_identity_or_body_to_bind",
  /**
   * A bound task was offered a DIFFERENT order to bind to. The binding is
   * immutable, so this is refused rather than applied - and refused loudly,
   * because it is the exact shape a replaced order has.
   */
  IMMUTABLE_CONFLICT: "the_task_is_already_bound_to_a_different_architect_order_and_a_binding_is_immutable",

  /* --- verification time --- */
  /**
   * The comment collection could not be proven complete: a read failure, a
   * fragment that would not parse, or a caller that never established either.
   * DISTINCT from a proven empty set on purpose - "I could not look" and "I
   * looked and there is nothing" are different facts and only one of them is
   * ever about the order.
   */
  COLLECTION_INCOMPLETE: "the_control_comment_collection_could_not_be_proven_complete_so_absence_proves_nothing",
  /**
   * Zero trusted orders for a task that DEMONSTRABLY had one. Deleted, replaced
   * under another id, or simply not in the page we got back.
   */
  ORDER_ABSENT: "the_bound_original_architect_order_is_no_longer_present_in_the_control_comments",
  /** An order for this task id exists, but it is not the bound one. */
  COMMENT_ID_MISMATCH: "the_trusted_order_present_now_is_a_different_comment_than_the_bound_original",
  /** Same comment id, different bytes: the order was edited or rewritten. */
  BODY_DIGEST_MISMATCH: "the_bound_architect_order_body_has_changed_since_the_task_was_admitted",
  /** Same comment id, different creation time: rewritten history. */
  CREATED_AT_MISMATCH: "the_bound_architect_order_creation_timestamp_has_changed_since_the_task_was_admitted"
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A comment's GitHub id, normalised to a string for comparison.
 *
 * Numbers and strings both appear in practice (`gh api` yields numbers, some
 * fixtures and projections yield strings), and `123 !== "123"` would be a false
 * mismatch. Normalising to a string is lossless for both.
 */
export function normalizeCommentId(id) {
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  if (typeof id === "string" && id.trim() !== "") return id.trim();
  return null;
}

/**
 * D-150: a comment's own identity, or `null` when it carries none we can compare.
 *
 * The `n:` / `s:` prefix keeps a numeric id and a string id distinguishable as
 * ORIGINS. This value is an internal dedupe key only - never what a record
 * carries, and never what a human is asked to go and look at.
 *
 * It lives HERE, in the leaf module, rather than next to the rules that use it,
 * so that `trust.mjs`, `order-authority.mjs` and `merge-transition.mjs` can all
 * count identical comments the same way without importing each other.
 */
export function commentIdentity(comment) {
  const id = comment?.id;
  if (typeof id === "number" && Number.isFinite(id)) return `n:${id}`;
  if (typeof id === "string" && id.trim() !== "") return `s:${id.trim()}`;
  return null;
}

/**
 * D-150: collapse provably-identical repeats of ONE comment, and nothing else.
 *
 * Overlapping `--paginate` pages return the same comment twice - identical id,
 * identical body, identical `created_at` - and calling that a duplicate authority
 * would be a false refusal that a page boundary alone could trigger.
 *
 * A shared id with ANY differing content is NOT collapsed. Two orders wearing one
 * id is strictly more suspicious than two orders with two ids, not less.
 *
 * Order-insensitive: the result's SIZE is identical however the input was
 * enumerated, which is the property every decision built on this depends on.
 */
export function collapseIdenticalOrderRepeats(comments) {
  const distinct = [];
  for (const comment of Array.isArray(comments) ? comments : []) {
    const id = commentIdentity(comment);
    const same = id === null
      ? undefined
      : distinct.find((d) => commentIdentity(d) === id
        && String(d.body ?? "") === String(comment.body ?? "")
        && String(d.created_at ?? "") === String(comment.created_at ?? ""));
    if (!same) distinct.push(comment);
  }
  return distinct;
}

/**
 * D-150: a total, deterministic order over comments - creation time, then id.
 *
 * Used ONLY to pick a stable REPRESENTATIVE for queue ordering and for refusal
 * messages. It never picks an AUTHORITY: when more than one distinct order
 * exists the admission gate refuses, and the representative is nothing more than
 * the thing that refusal is reported against.
 */
export function orderByIssueSequence(a, b) {
  const ta = Date.parse(a?.created_at ?? "");
  const tb = Date.parse(b?.created_at ?? "");
  const va = Number.isFinite(ta) ? ta : 0;
  const vb = Number.isFinite(tb) ? tb : 0;
  if (va !== vb) return va - vb;
  const ia = String(normalizeCommentId(a?.id) ?? "");
  const ib = String(normalizeCommentId(b?.id) ?? "");
  return ia < ib ? -1 : (ia > ib ? 1 : 0);
}

/** An ISO timestamp we can actually compare, or `null`. Never a guess. */
export function normalizeCreatedAt(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return null;
  return Number.isFinite(Date.parse(text)) ? text : null;
}

/**
 * The deterministic digest of one order body.
 *
 * Over the EXACT UTF-8 bytes, with no trimming, no newline normalisation and no
 * case folding: every one of those would make two materially different orders
 * digest identically, which is precisely what must not happen. A body that is not
 * a string at all yields `null` - there is nothing to bind to.
 */
export function orderBodyDigest(body) {
  if (typeof body !== "string") return null;
  const bytes = Buffer.from(body, "utf8");
  const hash = createHash("sha256");
  hash.update(DIGEST_DOMAIN, "utf8");
  hash.update(bytes);
  return { sha256: hash.digest("hex"), bytes: bytes.length };
}

/**
 * A short, log-safe identifier for a digest.
 *
 * Used in status comments and logs where the full 64 hex characters are noise.
 * It is an IDENTIFIER, never the comparison: every equality check in this module
 * uses the full digest.
 */
export function digestLabel(sha256) {
  return typeof sha256 === "string" && sha256.length >= 12 ? `sha256:${sha256.slice(0, 12)}` : "sha256:unknown";
}

/**
 * Build the binding document for one trusted ARCHITECT_TASK comment.
 *
 * The caller must already have established that this comment IS the canonical
 * trusted order for `taskId` - that is `selectCanonicalArchitectTask`'s job, and
 * duplicating its rules here would be a second place for them to drift.
 */
export function buildOrderBinding({ comment, taskId, boundAt = new Date().toISOString() }) {
  const refuse = (reason, detail) => ({ ok: false, reason, detail, binding: null });

  if (typeof taskId !== "string" || taskId.trim() === "") {
    return refuse(ORDER_BINDING.BINDING_TASK_ID_MISMATCH, `no task id to bind (${JSON.stringify(taskId ?? null)})`);
  }
  const commentId = normalizeCommentId(comment?.id);
  if (commentId === null) {
    return refuse(ORDER_BINDING.UNBINDABLE_COMMENT,
      `the order comment carries no usable id (${JSON.stringify(comment?.id ?? null)})`);
  }
  const digest = orderBodyDigest(comment?.body);
  if (digest === null) {
    return refuse(ORDER_BINDING.UNBINDABLE_COMMENT,
      `the order comment ${JSON.stringify(commentId)} carries no readable body to digest`);
  }

  return {
    ok: true,
    reason: null,
    detail: null,
    binding: {
      binding_version: ORDER_BINDING_VERSION,
      task_id: taskId,
      comment_id: commentId,
      // `null` when the API gave us nothing usable. Recorded as an explicit null
      // rather than omitted, so a later read can tell "never bound" apart from
      // "bound and then lost".
      created_at: normalizeCreatedAt(comment?.created_at),
      body_sha256: digest.sha256,
      body_bytes: digest.bytes,
      bound_at: typeof boundAt === "string" ? boundAt : new Date().toISOString()
    }
  };
}

/**
 * Is this a binding document this build can act on?
 *
 * Structural only - it says nothing about whether the order still exists. A
 * binding that fails here is UNUSABLE, and an unusable binding is treated exactly
 * like a missing one: fail closed, never fall back to re-deriving it.
 */
export function validateOrderBinding(binding, { taskId = null } = {}) {
  const refuse = (reason, detail) => ({ ok: false, reason, detail });

  if (binding === null || binding === undefined) {
    return refuse(ORDER_BINDING.BINDING_MISSING, "no binding is recorded on the task");
  }
  if (!isPlainObject(binding)) {
    return refuse(ORDER_BINDING.BINDING_INVALID, `the binding is a ${Array.isArray(binding) ? "array" : typeof binding}`);
  }
  const version = Number(binding.binding_version);
  if (!Number.isInteger(version) || version < 1) {
    return refuse(ORDER_BINDING.BINDING_INVALID,
      `binding_version=${JSON.stringify(binding.binding_version ?? null)} is not a positive integer`);
  }
  if (version > ORDER_BINDING_VERSION) {
    // Never "best effort" across a version we do not understand: a field this
    // build ignores could be the one carrying the authority.
    return refuse(ORDER_BINDING.BINDING_VERSION_UNSUPPORTED,
      `the binding declares version ${version}; this worker understands up to ${ORDER_BINDING_VERSION}`);
  }
  if (typeof binding.task_id !== "string" || binding.task_id.trim() === "") {
    return refuse(ORDER_BINDING.BINDING_INVALID, "the binding carries no task_id");
  }
  if (taskId !== null && binding.task_id !== taskId) {
    return refuse(ORDER_BINDING.BINDING_TASK_ID_MISMATCH,
      `the binding names task ${JSON.stringify(binding.task_id)}, not ${JSON.stringify(taskId)}`);
  }
  if (normalizeCommentId(binding.comment_id) === null) {
    return refuse(ORDER_BINDING.BINDING_INVALID,
      `the binding carries no usable comment_id (${JSON.stringify(binding.comment_id ?? null)})`);
  }
  if (typeof binding.body_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(binding.body_sha256)) {
    return refuse(ORDER_BINDING.BINDING_INVALID,
      `the binding carries no usable body digest (${JSON.stringify(binding.body_sha256 ?? null)})`);
  }
  if (binding.created_at !== null && binding.created_at !== undefined
      && normalizeCreatedAt(binding.created_at) === null) {
    return refuse(ORDER_BINDING.BINDING_INVALID,
      `the binding carries an unparseable created_at (${JSON.stringify(binding.created_at)})`);
  }
  return { ok: true, reason: null, detail: null };
}

/**
 * BIND ONCE, NEVER AGAIN.
 *
 * Three outcomes, and only the first two are successes:
 *
 *   created  no usable binding existed -> the new one is returned to be persisted
 *   reused   a valid binding already exists and the offered order MATCHES it ->
 *            the EXISTING document is returned unchanged. Not a re-derived copy:
 *            the stored bytes, including `bound_at`, are what survives.
 *   refused  a valid binding exists and the offered order does NOT match it, or
 *            the stored binding is unusable, or the offered comment is unbindable
 *
 * The `refused` case deliberately does NOT repair anything. A task whose stored
 * binding is corrupt cannot be re-bound from current text - that is the exact
 * "recompute authority from whatever is there now" move this module exists to
 * remove. The recovery is a human reconciling it and a FRESH TASK_ID.
 */
export function bindOrderOnce({
  existing = null,
  comment,
  taskId,
  boundAt = new Date().toISOString(),
  alreadyAdmitted = false
}) {
  const hasExisting = existing !== null && existing !== undefined;

  // THE ONE THING THE BINDING VALUE CANNOT TELL US.
  //
  // `existing === null` means two completely different things, and only the
  // caller knows which: "this task has never been admitted, so bind it now" and
  // "this task WAS admitted, by a build that recorded no binding". The first must
  // create; the second must refuse, because creating would adopt whatever order
  // is on the issue TODAY as the original - which is the whole attack. So the
  // caller states which case it is in, and `alreadyAdmitted` defaults to the
  // permissive value only because the fail-closed one belongs to the caller that
  // actually knows (`runTask`, from the record's own attempt count).
  if (!hasExisting && alreadyAdmitted) {
    return {
      ok: false,
      created: false,
      reused: false,
      binding: null,
      reason: ORDER_BINDING.BINDING_MISSING,
      detail: `task ${JSON.stringify(taskId)} has already been dispatched at least once but carries no durable `
        + "order binding; it was admitted by a build from before D-149, and a binding will NOT be synthesised "
        + "for it from the order that is on the control issue now"
    };
  }

  if (hasExisting) {
    const valid = validateOrderBinding(existing, { taskId });
    if (!valid.ok) {
      return { ok: false, created: false, reused: false, binding: null, reason: valid.reason, detail: valid.detail };
    }
    // The binding stands. The only question is whether the order in front of us
    // IS it - and if it is not, nothing is written.
    const check = verifyOrderAgainstBinding({ binding: existing, comment, taskId });
    if (!check.ok) {
      return {
        ok: false,
        created: false,
        reused: false,
        binding: existing,
        reason: check.reason === ORDER_BINDING.ORDER_ABSENT ? ORDER_BINDING.IMMUTABLE_CONFLICT : check.reason,
        detail: check.detail
      };
    }
    return { ok: true, created: false, reused: true, binding: existing, reason: ORDER_BINDING.BOUND, detail: null };
  }

  const built = buildOrderBinding({ comment, taskId, boundAt });
  if (!built.ok) {
    return { ok: false, created: false, reused: false, binding: null, reason: built.reason, detail: built.detail };
  }
  return { ok: true, created: true, reused: false, binding: built.binding, reason: ORDER_BINDING.BOUND, detail: null };
}

/**
 * Does this comment prove it is the bound original order?
 *
 * Exact equality on all three bound facts. `comment` being absent is
 * `ORDER_ABSENT` rather than a generic failure, because "the order is gone" is a
 * materially different finding from "the order is here and says something else",
 * and the human reconciling them does different things about each.
 */
export function verifyOrderAgainstBinding({ binding, comment, taskId = null }) {
  const observedId = normalizeCommentId(comment?.id);
  const refuse = (reason, detail) => ({
    ok: false,
    reason,
    detail,
    expected_comment_id: normalizeCommentId(binding?.comment_id),
    expected_body_sha256: typeof binding?.body_sha256 === "string" ? binding.body_sha256 : null,
    observed_comment_id: observedId,
    observed_body_sha256: null
  });

  const valid = validateOrderBinding(binding, { taskId });
  if (!valid.ok) return refuse(valid.reason, valid.detail);

  if (comment === null || comment === undefined) {
    return refuse(ORDER_BINDING.ORDER_ABSENT,
      `no trusted order is present now; the task was admitted bound to comment `
      + `${JSON.stringify(normalizeCommentId(binding.comment_id))}`);
  }
  const expectedId = normalizeCommentId(binding.comment_id);
  if (observedId === null || observedId !== expectedId) {
    return refuse(ORDER_BINDING.COMMENT_ID_MISMATCH,
      `the trusted order present now is comment ${JSON.stringify(observedId)}; this task is bound to `
      + `${JSON.stringify(expectedId)}`);
  }

  const digest = orderBodyDigest(comment?.body);
  if (digest === null) {
    return refuse(ORDER_BINDING.BODY_DIGEST_MISMATCH,
      `comment ${JSON.stringify(observedId)} carries no readable body, so it cannot be shown to be the bound order`);
  }
  if (digest.sha256 !== binding.body_sha256) {
    return {
      ok: false,
      reason: ORDER_BINDING.BODY_DIGEST_MISMATCH,
      // The digests and the byte counts, never the bodies. A reader gets enough
      // to see THAT it changed and roughly how, and nothing they did not already
      // have the right to read.
      detail: `comment ${JSON.stringify(observedId)} now digests to ${digestLabel(digest.sha256)} `
        + `(${digest.bytes} bytes); the task was admitted bound to ${digestLabel(binding.body_sha256)} `
        + `(${Number.isFinite(binding.body_bytes) ? binding.body_bytes : "unknown"} bytes)`,
      expected_comment_id: expectedId,
      expected_body_sha256: binding.body_sha256,
      observed_comment_id: observedId,
      observed_body_sha256: digest.sha256
    };
  }

  // Creation metadata is checked only when it was actually bound. A binding made
  // from an API projection that omitted `created_at` never recorded a claim about
  // it, and inventing a mismatch against a claim nobody made would be a false
  // refusal - the opposite failure, but still a failure.
  const boundCreatedAt = normalizeCreatedAt(binding.created_at);
  if (boundCreatedAt !== null) {
    const observedCreatedAt = normalizeCreatedAt(comment?.created_at);
    if (observedCreatedAt !== boundCreatedAt) {
      return {
        ok: false,
        reason: ORDER_BINDING.CREATED_AT_MISMATCH,
        detail: `comment ${JSON.stringify(observedId)} now reports created_at=${JSON.stringify(observedCreatedAt)}; `
          + `the task was admitted bound to ${JSON.stringify(boundCreatedAt)}`,
        expected_comment_id: expectedId,
        expected_body_sha256: binding.body_sha256,
        observed_comment_id: observedId,
        observed_body_sha256: digest.sha256
      };
    }
  }

  return {
    ok: true,
    reason: ORDER_BINDING.BOUND,
    detail: null,
    expected_comment_id: expectedId,
    expected_body_sha256: binding.body_sha256,
    observed_comment_id: observedId,
    observed_body_sha256: digest.sha256
  };
}

/**
 * The binding half of the gate evidence, for records, logs and status comments.
 *
 * Carries the EXPECTED identity, the OBSERVED candidate ids and the precise
 * reason - and no body content, because the digest is the whole point.
 */
export function orderBindingEvidence({ binding = null, verification = null, observedCommentIds = [], collectionComplete = null } = {}) {
  return {
    order_binding_present: isPlainObject(binding),
    order_binding_version: Number.isInteger(binding?.binding_version) ? binding.binding_version : null,
    expected_order_comment_id: normalizeCommentId(binding?.comment_id),
    expected_order_created_at: normalizeCreatedAt(binding?.created_at),
    expected_order_body_digest: typeof binding?.body_sha256 === "string" ? digestLabel(binding.body_sha256) : null,
    expected_order_body_bytes: Number.isFinite(binding?.body_bytes) ? binding.body_bytes : null,
    order_bound_at: typeof binding?.bound_at === "string" ? binding.bound_at : null,
    observed_order_comment_ids: (Array.isArray(observedCommentIds) ? observedCommentIds : [])
      .map((id) => normalizeCommentId(id))
      .filter((id) => id !== null),
    observed_order_body_digest: typeof verification?.observed_body_sha256 === "string"
      ? digestLabel(verification.observed_body_sha256)
      : null,
    order_binding_verified: verification?.ok === true,
    order_binding_reason: verification?.reason ?? null,
    order_binding_detail: verification?.detail ?? null,
    // Tri-state ON PURPOSE. `null` means nobody established it, which is not the
    // same as `false` ("we know it was incomplete") and emphatically not `true`.
    control_comments_complete: collectionComplete === true ? true : (collectionComplete === false ? false : null)
  };
}

/** Human-readable lines for a status comment or a log. */
export function describeOrderBinding(evidence) {
  if (!evidence) return [];
  return [
    `ARCHITECT ORDER BINDING: ${evidence.order_binding_verified ? "VERIFIED" : "NOT VERIFIED"} `
      + `(${evidence.order_binding_reason ?? "not evaluated"})`,
    `  bound original: comment ${evidence.expected_order_comment_id ?? "none"} `
      + `created ${evidence.expected_order_created_at ?? "unknown"}, body ${evidence.expected_order_body_digest ?? "unknown"} `
      + `(${evidence.expected_order_body_bytes ?? "unknown"} bytes), bound at ${evidence.order_bound_at ?? "unknown"}`,
    `  observed now: ${evidence.observed_order_comment_ids?.length
      ? evidence.observed_order_comment_ids.join(", ")
      : "no trusted order for this task id"}`
      + (evidence.observed_order_body_digest ? `, body ${evidence.observed_order_body_digest}` : ""),
    `  control comment collection complete: ${evidence.control_comments_complete === null
      ? "NOT ESTABLISHED"
      : String(evidence.control_comments_complete)}`,
    evidence.order_binding_detail ? `  ${evidence.order_binding_detail}` : ""
  ].filter((l) => l !== "");
}

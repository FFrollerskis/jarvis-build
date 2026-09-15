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

import { ORDER_AUTHORITY } from "./order-authority.mjs";
import { digestLabel, normalizeCommentId, normalizeCreatedAt, orderBodyDigest } from "./order-binding.mjs";
import { completionGateHeld } from "./provenance.mjs";
import { assessCompletion } from "./reconcile.mjs";
import { TASK_STATUS, getTask, isTerminal, isValidTaskId } from "./state.mjs";

/** Why a task was not chosen. Ordered from "never again" to "not right now". */
export const INELIGIBLE = Object.freeze({
  UNSAFE_TASK_ID: "unsafe_task_id",
  /**
   * D-151: the task's order did not pass the ONE authority classifier, so this
   * task has no executable instruction, no ranking position and no voice in any
   * other task's fate. Ordered here - above TERMINAL_STATE - because it is a
   * finding about the ORDER rather than about the record, and because it must be
   * reported even for a task the worker has never seen before.
   */
  INADMISSIBLE_AUTHORITY: "architect_order_authority_inadmissible",
  TERMINAL_STATE: "terminal_state",
  TERMINAL_REPORT: "terminal_report_exists",
  UNRECOGNISED_REPORT_STATUS: "report_status_unrecognised",
  SUPERSEDED: "superseded_by_newer_completed_task",
  IN_PROGRESS: "in_progress_owned_by_recovery",
  BACKOFF: "waiting_for_backoff"
});

/**
 * D-151: WHY A PROPOSED SUPERSESSION WAS NOT CARRIED OUT.
 *
 * Supersession is the only decision in the worker that permanently discards work
 * nobody has looked at, so every refusal gets its own name and every refusal is
 * previewable without mutating anything.
 */
export const SUPERSESSION_REFUSED = Object.freeze({
  /** The cycle's control read was not proven complete. Nothing may be retired. */
  SNAPSHOT_INCOMPLETE: "the_control_snapshot_was_not_proven_complete_so_no_retirement_may_be_decided",
  /** The declaring task's own order did not pass the authority classifier. */
  DECLARER_INADMISSIBLE: "the_declaring_task_has_no_admissible_architect_order_so_it_declares_nothing",
  /** The victim's own order did not pass, so its position cannot be proven. */
  VICTIM_INADMISSIBLE: "the_named_task_has_no_admissible_architect_order_to_prove_its_position_against",
  /** Either side carries no provable issue position, so direction is unknown. */
  DIRECTION_UNPROVABLE: "the_issue_order_of_the_declaring_and_named_tasks_cannot_be_proven",
  /** The declaration points backwards: an older order may never retire a newer. */
  NOT_STRICTLY_NEWER: "the_declaring_order_is_not_strictly_newer_than_the_task_it_names",
  /** The named task is not one this worker knows from the snapshot. */
  VICTIM_UNKNOWN: "no_task_in_this_snapshot_carries_the_declared_task_id",
  /** A task may not retire itself. */
  SELF_DECLARED: "a_task_cannot_declare_itself_superseded",
  /** The declaring task's completion gate is held (D-135). It retires nothing. */
  DECLARER_GATE_HELD: "the_declaring_tasks_completion_gate_is_held_so_it_is_not_a_safe_basis_for_retiring_anything"
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
 * D-151: THE ONE ADMISSIBLE ORDER OF AN ENTRY, OR `null`.
 *
 * This is the single place anything in the queue is allowed to reach a body, an
 * id or a timestamp from, and it answers from the verdict the atomic snapshot
 * already computed (`captureAuthoritySnapshot` -> `selectAdmissibleOrder`). It
 * does NOT re-classify: a second classifier is a second set of rules to drift,
 * and drift between them is exactly how an order refused at admission still
 * managed to retire a victim.
 *
 * Fail-closed on an entry that carries no verdict at all. An entry built by hand,
 * migrated from an older shape, or assembled by a caller that skipped the
 * snapshot has not been classified, and "not classified" is never "admissible".
 */
export function admissibleOrderOf(entry) {
  if (entry?.authority?.ok !== true) return null;
  if (entry.authority.reason !== ORDER_AUTHORITY.ADMISSIBLE) return null;
  return entry.authority.comment ?? entry.order ?? entry.comment ?? null;
}

/**
 * D-151: an entry's PROVEN position in the control issue, or `null`.
 *
 * Both halves come from the admitted order and from nowhere else, and both must
 * be present: a parseable `created_at` and a usable GitHub comment id. An order
 * missing either used to score `0` in the comparators below, which sorted it to
 * the FRONT of its tier and made it "strictly older" than every real order - so
 * an order the admission gate would have refused could preempt a live one with
 * its `EXPECTED_HEAD_SHA`, and could sit at the head of the queue indefinitely.
 *
 * `null` here is total: an entry with no provable position is never ranked, never
 * strictly older than anything and never strictly newer than anything.
 */
export function issuePositionOf(entry) {
  const order = admissibleOrderOf(entry);
  if (!order) return null;
  const createdAt = normalizeCreatedAt(order.created_at);
  const commentId = normalizeCommentId(order.id);
  if (createdAt === null || commentId === null) return null;
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) return null;
  // Numeric where GitHub gives a number, so the tie-break stays a real ordering;
  // the string form is kept for evidence, never for arithmetic.
  const numericId = Number(commentId);
  return { ms, commentId, sortId: Number.isFinite(numericId) ? numericId : commentId };
}

/**
 * The exact head this trusted task was written against, or `null`.
 *
 * D-150: read from the task's ONE order and from nothing else.
 *
 * This used to fold same-id "scope update" bodies in with LAST-WINS semantics,
 * which meant a second same-id comment could re-point `EXPECTED_HEAD_SHA` at a
 * different commit and move the task between head tiers. That was the residual
 * finding D-149 reported and did not close. It is closed by removing same-id
 * update semantics entirely rather than by ranking the updates more carefully:
 * any rule that CHOOSES between same-id bodies hands the choice to whoever can
 * post one.
 *
 * D-151: the gate is now the FULL authority verdict, not a count-derived
 * `uniqueAuthority` boolean. A unique but EDITED order, a unique order with no
 * usable comment id and a unique order with no parseable `created_at` are all
 * inadmissible, and all three used to declare a head from here regardless.
 *
 * An inadmissible entry declares NOTHING. That is the fail-safe direction - an
 * undeclared head is `UNDECLARED`, which merely stops the order preempting a
 * current one; it never promotes anything.
 */
export function declaredExpectedHead(entry) {
  const order = admissibleOrderOf(entry);
  if (!order) return null;
  let found = null;
  for (const line of String(order.body ?? "").split(/\r?\n/)) {
    const m = line.match(EXPECTED_HEAD_LINE);
    // The LAST declaration within the ONE order wins - a body that states the
    // field twice is the architect's own text, not a second authority.
    if (m) found = String(m[1]).toLowerCase();
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

/**
 * Every TASK_ID this trusted task explicitly declares it supersedes.
 *
 * Read from the task's ONE ADMITTED ARCHITECT_TASK comment and from nothing else:
 * not a PR body, not a CI log, not an untrusted comment, not a second same-id
 * comment (D-150), and not an order the authority classifier refused (D-151).
 *
 * Supersession RETIRES a task permanently. Letting anything less than a proven
 * order contribute to it meant a forged duplicate could retire a different,
 * unrelated order outright, and - until D-151 - a UNIQUE BUT EDITED order could
 * too: `uniqueAuthority` was a count, and a count cannot see an edit. An
 * inadmissible entry therefore declares NOTHING. Both directions of that are
 * fail-safe: a forgery cannot manufacture a retirement, and a forgery that
 * suppresses a genuine declaration only leaves the older task visible.
 *
 * Every declared id must itself be a syntactically valid TASK_ID, so a malformed
 * or path-shaped value is dropped rather than matched loosely.
 */
export function declaredSupersedes(entry) {
  const order = admissibleOrderOf(entry);
  if (!order) return [];
  const ids = [];
  for (const line of String(order.body ?? "").split(/\r?\n/)) {
    const m = line.match(new RegExp(`^${SUPERSEDES_FIELD}=(.*)$`));
    if (!m) continue;
    for (const raw of m[1].split(/[,\s]+/)) {
      const id = raw.trim();
      if (id && isValidTaskId(id) && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * Total, deterministic "a was issued strictly before b" - time first, comment id
 * as the tie-break - and `false` whenever either position is UNPROVEN.
 *
 * D-151: the unproven case used to be silently coerced to `0`, which made an
 * order with no parseable `created_at` older than everything ever issued. Since
 * "strictly older" is the whole directional argument for retiring a task, that
 * coercion was a retirement waiting to be handed to whoever posted the malformed
 * order. There is no safe default for a question nobody answered, so the answer
 * is: we do not know, and we retire nothing.
 */
function strictlyOlder(a, b) {
  const pa = a?.position ?? null;
  const pb = b?.position ?? null;
  if (pa === null || pb === null) return false;
  if (pa.ms !== pb.ms) return pa.ms < pb.ms;
  if (typeof pa.sortId === "number" && typeof pb.sortId === "number") return pa.sortId < pb.sortId;
  return String(pa.commentId) < String(pb.commentId);
}

/**
 * D-151: the auditable evidence tying ONE retirement to ONE declaring order.
 *
 * The comment ID says which comment a human should go and read; the body digest
 * says which exact BYTES said it. Without the digest, a retirement recorded
 * against comment 12345 proves nothing once comment 12345 has been edited - and
 * the actor able to edit a control comment is the same login the worker trusts.
 * Digest only, never body text, so the record stays safe to post anywhere.
 */
function declarationEvidence(e) {
  // `e` is the queue's internal wrapper, whose `order` is already the resolved
  // admissible order (`null` when the classifier refused it). Resolving it a
  // second time from the wrapper would silently yield `null` for every
  // declaration, because the wrapper is not the classified entry.
  const order = e?.order ?? null;
  const digest = order ? orderBodyDigest(order.body) : null;
  return {
    task_id: e.taskId,
    comment_id: order ? normalizeCommentId(order.id) : null,
    created_at: order ? normalizeCreatedAt(order.created_at) : null,
    body_sha256: digest?.sha256 ?? null,
    body_bytes: digest?.bytes ?? null,
    /** GitHub's id exactly as it came back, for the pre-D151 summary field. */
    raw_comment_id: order?.id ?? null
  };
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
export function selectNextTask({
  tasks,
  state,
  comments,
  trustedAuthor,
  nowMs,
  observedHead = null,
  /**
   * D-151: did the cycle's control read provably cover the WHOLE issue?
   *
   * Tri-state, and only `true` unlocks supersession. `null` - the default - means
   * the caller never established it, which is not a smaller claim than `false`;
   * it is the same claim with nobody willing to make it. A retirement decided
   * from a partial read is a retirement decided without having seen the page the
   * contradicting order was on.
   */
  snapshotComplete = null
}) {
  const entries = (tasks ?? []).map((entry) => {
    const record = getTask(state, entry.taskId);
    const expectedHead = declaredExpectedHead(entry);
    return {
      entry,
      taskId: entry.taskId,
      record,
      // D-151: the ONE admitted order, or null. Nothing below reaches past this.
      order: admissibleOrderOf(entry),
      admissible: admissibleOrderOf(entry) !== null,
      authorityReason: entry?.authority?.reason ?? null,
      position: issuePositionOf(entry),
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
  //
  // D-151: only an ADMISSIBLE entry can be this. The basis rests on the newer
  // task's report, but the STALENESS argument rests on the newer task being
  // provably newer, and that is a fact about its ORDER. A task whose order the
  // authority classifier refused has no provable position, so it cannot show that
  // anything is older than it.
  let newestSuccessful = null;
  for (const e of entries) {
    if (!isValidTaskId(e.taskId)) continue;
    if (!e.admissible || e.position === null) continue;
    if (!isSuccessfullyComplete(e)) continue;
    if (newestSuccessful === null || strictlyOlder(newestSuccessful, e)) newestSuccessful = e;
  }

  /**
   * D-151: EXPLICIT SUPERSESSION, EVALUATED AS A DURABLE DESTRUCTIVE DECISION.
   *
   * `SUPERSEDES=<TASK_ID>` permanently retires work nobody has reviewed. Three
   * things changed here, and each closes a way that could happen without proof:
   *
   *   THE SNAPSHOT MUST BE COMPLETE. A retirement decided from a read that lost a
   *   page was decided without having seen the page. `snapshotComplete !== true`
   *   refuses every proposal, with a reason, and mutates nothing.
   *
   *   THE DECLARING ORDER MUST BE ADMISSIBLE. The old gate was `uniqueAuthority`,
   *   a count. A count cannot see an EDIT, cannot see a missing comment id and
   *   cannot see an unparseable `created_at` - so a unique, edited order still
   *   declared, and an order with no ordering metadata scored `0` and was
   *   "strictly newer" than nothing but "strictly older" than everything.
   *
   *   NOTHING IS PICKED. The old code kept the FIRST declaration for a victim and
   *   dropped the rest (`// first (oldest) declaration wins`). Choosing between
   *   competing authorities is exactly the move D-150 removed at admission, and
   *   the persisted evidence was one comment id with no digest, so the retirement
   *   could not be tied to the bytes that ordered it. EVERY admissible declaration
   *   is now recorded, each with its comment id AND its body digest.
   *
   * Every refusal is kept, not discarded, so a dry run can show an operator that
   * a proposed retirement would NOT happen - and why - without mutating anything.
   */
  const supersessionProposals = [];
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
    const gateHeldHere = completionGateHeld(e.record);

    // Read through `declaredSupersedes`, which refuses an inadmissible order
    // outright - so an inadmissible declarer yields an empty list and cannot even
    // put a PROPOSAL on the record. That is deliberate: parsing `SUPERSEDES=` out
    // of an unproven body to say "and we refused it" would still be reading a
    // semantic field from an order the classifier rejected. The operator sees the
    // task's own INADMISSIBLE_AUTHORITY verdict instead, which is the real
    // finding.
    for (const targetId of declaredSupersedes(e.entry)) {
      const victim = entries.find((x) => x.taskId === targetId) ?? null;
      const refuse = (reason) => {
        supersessionProposals.push({
          victimTaskId: targetId,
          declaredByTaskId: e.taskId,
          accepted: false,
          refusedReason: reason,
          declaration: declarationEvidence(e)
        });
      };

      if (snapshotComplete !== true) { refuse(SUPERSESSION_REFUSED.SNAPSHOT_INCOMPLETE); continue; }
      if (!e.admissible) { refuse(SUPERSESSION_REFUSED.DECLARER_INADMISSIBLE); continue; }
      if (gateHeldHere) { refuse(SUPERSESSION_REFUSED.DECLARER_GATE_HELD); continue; }
      if (targetId === e.taskId) { refuse(SUPERSESSION_REFUSED.SELF_DECLARED); continue; }
      // Only tasks this worker actually knows from THIS snapshot.
      if (!victim) { refuse(SUPERSESSION_REFUSED.VICTIM_UNKNOWN); continue; }
      if (!victim.admissible) { refuse(SUPERSESSION_REFUSED.VICTIM_INADMISSIBLE); continue; }
      if (victim.position === null || e.position === null) {
        refuse(SUPERSESSION_REFUSED.DIRECTION_UNPROVABLE);
        continue;
      }
      if (!strictlyOlder(victim, e)) { refuse(SUPERSESSION_REFUSED.NOT_STRICTLY_NEWER); continue; }

      const declaration = declarationEvidence(e);
      supersessionProposals.push({
        victimTaskId: targetId,
        declaredByTaskId: e.taskId,
        accepted: true,
        refusedReason: null,
        declaration
      });
      // EVERY accepted declaration is kept. Two admissible orders that both name
      // the same victim AGREE, so there is no ambiguity to resolve - but the
      // record must say that both said it, rather than silently keeping one.
      if (!explicitSupersessions.has(targetId)) explicitSupersessions.set(targetId, []);
      explicitSupersessions.get(targetId).push(declaration);
    }
  }

  /**
   * Should this task be retired as superseded, and on exactly what evidence?
   * Returns `null` when it must NOT be retired - which is the default.
   */
  const supersessionFor = (e) => {
    const declarations = explicitSupersessions.get(e.taskId) ?? null;
    if (declarations && declarations.length > 0) {
      const names = declarations
        .map((d) => `${d.task_id} (comment ${d.comment_id}, body ${digestLabel(d.body_sha256)})`)
        .join("; ");
      return {
        basis: SUPERSESSION_BASIS.EXPLICIT_DECLARATION,
        // Deterministic and complete: every declaring task, in the order they
        // were evaluated, never one of them standing in for the rest.
        by: declarations.map((d) => d.task_id).join(", "),
        declarations,
        // Retained exactly as PR#80 defined it - GitHub's own id, unnormalised -
        // so existing records and tooling keep reading the same value. It is a
        // SUMMARY: `declarations` below is the authoritative, complete evidence,
        // and this collapses to null rather than picking when several orders
        // agree on the same retirement.
        declaredByCommentId: declarations.length === 1 ? declarations[0].raw_comment_id : null,
        detail: `trusted ARCHITECT_TASK ${names} declares ${SUPERSEDES_FIELD}=${e.taskId}`
      };
    }
    // D-151: the successful-completion basis needs the same complete snapshot.
    // "Nothing newer has succeeded" is an ABSENCE claim about reports, and a read
    // that lost a page cannot make one. The direction itself is already proven by
    // `strictlyOlder`, which now refuses an unproven position outright.
    if (snapshotComplete === true && newestSuccessful && strictlyOlder(e, newestSuccessful)) {
      return {
        basis: SUPERSESSION_BASIS.SUCCESSFUL_COMPLETION,
        by: newestSuccessful.taskId,
        declarations: [],
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
        // D-151: from the ADMITTED order only. It used to come from the
        // array-position representative, which meant a decision about a task
        // could quote a timestamp from a comment that was never its authority.
        createdAt: e.order?.created_at ?? null,
        // D-151: the authority verdict travels onto every decision, so a dry run
        // and a status comment can both show WHY a task was left out without
        // re-deriving anything.
        admissible: e.admissible,
        authorityReason: e.authorityReason,
        authorityDetail: e.entry?.authority?.detail ?? null,
        authorityRetryable: e.entry?.authority?.retryable === true,
        distinctOrderCount: e.entry?.distinctOrderCount ?? null,
        candidateCommentIds: [...(e.entry?.candidateCommentIds ?? e.entry?.authority?.candidateIds ?? [])],
        completion: e.completion,
        supersededBy: reason === INELIGIBLE.SUPERSEDED ? supersession.by : null,
        supersessionBasis: reason === INELIGIBLE.SUPERSEDED ? supersession.basis : null,
        supersessionDetail: reason === INELIGIBLE.SUPERSEDED ? supersession.detail : null,
        supersessionDeclaredByCommentId:
          reason === INELIGIBLE.SUPERSEDED ? supersession.declaredByCommentId : null,
        // D-151: the FULL evidence - one entry per admissible declaring order,
        // each with its comment id and the digest of the exact bytes that
        // ordered the retirement. Empty for the successful-completion basis,
        // which is declared by nothing.
        supersessionDeclarations: reason === INELIGIBLE.SUPERSEDED ? (supersession.declarations ?? []) : []
      });
    };

    if (!isValidTaskId(e.taskId)) { push(false, INELIGIBLE.UNSAFE_TASK_ID); continue; }

    // Worker state already retired it (completed / blocked / superseded).
    // Nothing - no restart, no elapsed backoff - brings it back. Asked before the
    // authority check purely so an ALREADY-retired task keeps reporting the
    // reason it was retired for, rather than being re-diagnosed every run.
    if (isTerminal(e.record)) { push(false, INELIGIBLE.TERMINAL_STATE); continue; }

    // D-151: NO ADMISSIBLE ORDER, NO PLACE IN THIS QUEUE.
    //
    // An inadmissible order contributes no `EXPECTED_HEAD_SHA`, so it cannot
    // change a head tier; it is never pushed to `dispatchable`, so it can neither
    // preempt an admissible order nor hold the head of the queue; and nothing
    // reaches its body, so it cannot be executed. The caller reports and retires
    // it on this reason.
    if (!e.admissible) { push(false, INELIGIBLE.INADMISSIBLE_AUTHORITY); continue; }

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
  //
  // D-151: every entry reaching this sort is ADMISSIBLE, so `position` is never
  // null here and both comparands come from the one order each task was admitted
  // under. Nothing sorts from an array-position representative any more, and an
  // order the classifier refused is not in this list to be compared at all.
  dispatchable.sort((a, b) => {
    if (a.headTier !== b.headTier) return a.headTier - b.headTier;
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.position.ms !== b.position.ms) {
      return a.tier === TIER.FRESH ? a.position.ms - b.position.ms : b.position.ms - a.position.ms;
    }
    const older = strictlyOlder(a, b) ? -1 : (strictlyOlder(b, a) ? 1 : 0);
    return a.tier === TIER.FRESH ? older : -older;
  });

  const chosen = dispatchable[0] ?? null;

  return {
    candidate: chosen?.entry ?? null,
    candidateTier: chosen?.tier ?? null,
    candidateHeadTier: chosen?.headTier ?? null,
    candidateExpectedHead: chosen?.expectedHead ?? null,
    // D-151: the verdict the candidate was chosen UNDER, carried out of the queue
    // so the dispatcher re-checks the SAME classification rather than performing a
    // second, independent one. A candidate can only ever be an admissible entry.
    candidateAuthority: chosen?.entry?.authority ?? null,
    observedHead: observedHead ?? null,
    // D-151: was this selection made from a snapshot proven to cover the whole
    // control issue? Carried explicitly because a caller that did not establish
    // it must not be able to read a retirement out of this result by accident.
    snapshotComplete: snapshotComplete === true,
    decisions,
    /**
     * D-151: EVERY proposed explicit supersession seen this cycle - accepted and
     * refused alike, each with the declaring comment id and body digest.
     *
     * A dry run prints this to show an operator that a proposed retirement would
     * NOT be carried out, and why, without mutating anything. `accepted: true`
     * entries are the audit trail for the ones that were.
     */
    supersessionProposals,
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
    /** D-151: task ids whose order did not pass the one authority classifier. */
    inadmissibleAuthorityTaskIds: decisions
      .filter((d) => d.reason === INELIGIBLE.INADMISSIBLE_AUTHORITY)
      .map((d) => d.taskId),
    waitingTaskIds: decisions.filter((d) => d.reason === INELIGIBLE.BACKOFF).map((d) => d.taskId)
  };
}

/**
 * AUTHORIZED MERGE-TRANSITION EVIDENCE (D-145).
 *
 * ------------------------------------------------------------------------
 * THE CONTROL-PLANE FALSE NEGATIVE THIS MODULE CLOSES
 * ------------------------------------------------------------------------
 *
 * D-134/D-136 established the right rule for ordinary implementation work: a
 * commit is this task's own ONLY when it carries the task's own attempt
 * trailers. `head_before != head_after` is an observation, never authorship.
 * That rule is correct, it is load-bearing, and NOTHING here weakens it.
 *
 * But D-144 was not an implementation task. It was a guarded PR merge, and its
 * entire deliverable was a state transition that GITHUB performs:
 *
 *     PR #80 head 78202147 + base c67a7ba7  ->  merge commit 0c803bf1
 *
 * GitHub generated and signed that merge commit. Claude never authored it, so
 * it could not possibly carry a `Jarvis-Attempt-Id` trailer. The child then did
 * exactly what the task told it to - fast-forwarded its local checkout onto the
 * merge SHA - and the worktree's HEAD advanced by exactly that one commit.
 *
 * The generic provenance verdict therefore came back `unattributed`, the
 * completion gate held, and a task that had succeeded completely, with three
 * green post-merge CI jobs and an independently re-verified remote truth, was
 * parked as BLOCKED. That is a FALSE NEGATIVE: the worker demanded proof of a
 * thing that was never true (Claude authored the merge commit) instead of proof
 * of the thing that actually mattered (the authorized transition happened, and
 * happened exactly as authorized).
 *
 * ------------------------------------------------------------------------
 * WHAT IS PROVEN INSTEAD, AND WHY IT IS NOT WEAKER
 * ------------------------------------------------------------------------
 *
 * Commit-authorship evidence answers: "did THIS task write this commit?"
 * Transition evidence answers a different question, and answers it from truth
 * the child cannot forge or influence:
 *
 *     Does the remote now hold EXACTLY the merge the trusted architect
 *     authorized, and nothing else?
 *
 * Every input is either control-plane truth (the trusted ARCHITECT_TASK comment
 * posted by the repo owner) or fresh remote truth read back from GitHub. None of
 * it comes from the child's own report, and none of it is an inference from an
 * observed ref movement:
 *
 *   1. the trusted ARCHITECT_TASK comment for THIS EXACT task id, carrying
 *      `ARCHITECT_MERGE_APPROVED=true`, `MERGE_AUTHORIZED=true`, the exact
 *      `PR_NUMBER`, `EXPECTED_BASE_SHA` and `EXPECTED_HEAD_SHA`;
 *   2. the remote PR: `merged=true`, and its head is the approved head;
 *   3. the merge commit itself: EXACTLY TWO parents, parent 1 == the approved
 *      base, parent 2 == the approved head, in that order. A squash produces one
 *      parent and a rebase produces none of this shape, so the structure alone
 *      refutes both without trusting any field that claims "method=merge";
 *   4. D-158: the merge commit's TREE IS THE TREE that merging the approved base
 *      and the approved head produces - so this merge commit is THE merge of the
 *      two commits that were authorized, and carries nothing besides.
 *
 *      This input has now been wrong twice, in the same way, and the third
 *      version is shaped to stop that repeating:
 *
 *        D-145 required `merge tree === approved head tree`. True only when the
 *        head already contains every commit on its base; it held D-156 (PR #82,
 *        17 commits behind) on a merge that was exactly the authorized one.
 *
 *        D-157 required the API projections `parent1...merge` and
 *        `base...head` to be equal field for field. True only when base and head
 *        touch different FILES; for different NON-OVERLAPPING HUNKS OF ONE FILE
 *        the correct merge blob holds both sides, so a valid merge was refused
 *        as `DELTA_CONTENT_MISMATCH`.
 *
 *      Each asserted a RESEMBLANCE to something else, and each was written from
 *      the one topology its fixtures happened to have. D-158 instead RECOMPUTES
 *      the merge from the two immutable authorized objects and requires the
 *      recorded merge to be it. That is the same statement in every topology,
 *      and a tree id covers every path, mode, symlink and byte - including the
 *      base-only content neither predecessor looked at at all. See
 *      `merge-tree-proof.mjs` for the invariant and `merge-tree.mjs` for how it
 *      is computed without touching any working tree.
 *   5. fresh post-merge check runs on the merge commit: every REQUIRED check
 *      named by trusted policy present exactly once, finished, and `success`.
 *
 * D-146 added a sixth input and tightened the fifth. See `postmerge-evidence.mjs`
 * for both in full; in short:
 *
 *   5'. "some green check exists" is no longer an answer. The required set comes
 *       from trusted policy (this task's own ARCHITECT_TASK, else the worker's
 *       config, else the repository's actual CI jobs), each required name must
 *       appear EXACTLY ONCE with `status=completed` and `conclusion=success`, and
 *       missing / duplicate / unfinished / neutral / skipped / cancelled / failed
 *       all fail closed. A check outside the required set can never stand in for
 *       one inside it.
 *   6.  the EXACT trusted terminal report that completion assessment selected is
 *       carried in and BOUND: its TASK_ID, PR, base/head, MERGE_SHA, parents and
 *       CI claims are checked against the verified truth above, and its
 *       LOCAL_HEAD / ORIGIN_MAIN / WORKTREE_CLEAN fields supply the one thing the
 *       worker cannot re-observe - whether the child actually synced and left
 *       nothing behind. Those three, and only those three, rest on a claim; they
 *       are tagged as such in the record rather than quietly counted as proof.
 *
 * ------------------------------------------------------------------------
 * THE NARROWING THAT KEEPS THIS FROM BECOMING A BYPASS
 * ------------------------------------------------------------------------
 *
 * Verified transition evidence does NOT mean "accept this task's commit range".
 * It excuses EXACTLY ONE commit, and only if that commit IS the verified merge
 * commit. `mergeTransitionExcusesProvenance` requires the set of unattributed
 * shas to be precisely `{ merge sha }` - so:
 *
 *   - a foreign commit alongside the merge commit still holds the gate;
 *   - a range the worker could not read in full (`range_truncated`) still holds;
 *   - an unattributed detail list the record had to cap (`details_truncated`)
 *     still holds, because a sha we never saw cannot be checked against the
 *     merge sha;
 *   - `diverged`, `drifted_after_attempt` and `unknown` still hold, because none
 *     of them is a classified range at all;
 *   - `null` provenance still holds (D-136), because without a classified range
 *     there is no evidence that the merge commit is the ONLY thing unexplained.
 *
 * And the worktree-cleanliness half of the gate (D-139 B) is untouched: a merge
 * task that left uncommitted state behind is still refused.
 *
 * ------------------------------------------------------------------------
 * D-147: THE EXCUSE IS NOT THE ONLY REASON TO RUN THIS
 * ------------------------------------------------------------------------
 *
 * Everything above describes what a verified transition may EXCUSE. D-146 shipped
 * with that as the only reason the verification ever ran, which left the opposite
 * direction open: a merge-authorized task whose commit range happened to verify
 * generically never reached any of it. `classifyMergeAuthorization` below decides
 * "is this a merge task?" from the trusted order ALONE, before provenance is
 * consulted at all, precisely so that question can no longer be skipped. See its
 * own comment for the bypass and the counterexample.
 *
 * ------------------------------------------------------------------------
 * D-148: WHICH ORDER IS "THE" ORDER
 * ------------------------------------------------------------------------
 *
 * D-147 asked the right question of the wrong input. It read the authorization
 * out of "this task's own trusted orders" - PLURAL - by scanning the comment array
 * and taking the first one that parsed. That is a FORWARD SCAN FOR A PASSING
 * CANDIDATE, and it made merge authority mutable by anyone who could post to the
 * control issue as the trusted login. The child is exactly such an actor: it runs
 * `gh` under the repo owner's credentials, because that is how it posts its own
 * CLAUDE_ACK and CLAUDE_REPORT.
 *
 * So a child dispatched for an ORDINARY task could post a second ARCHITECT_TASK
 * carrying its own TASK_ID and `ARCHITECT_MERGE_APPROVED=true`/`MERGE_AUTHORIZED=
 * true`, and the scan would find it, classify the task as merge-authorized, and -
 * with a real merge on the remote - accept the child's own order as the authority
 * that retired it. The worker's author check is not a role boundary, because the
 * child and the architect are the SAME GitHub login. Nothing downstream could
 * repair that: every later gate faithfully verifies whatever the selected order
 * says.
 *
 * `selectCanonicalArchitectTask` replaces the scan with a COUNT:
 *
 *     exactly one trusted ARCHITECT_TASK for this exact TASK_ID  -> that is the
 *                                                                   authority
 *     two or more                                                -> AMBIGUOUS,
 *                                                                   refuse
 *     none                                                       -> no order
 *
 * A count cannot be influenced by array order, by pagination page boundaries or by
 * which candidate happens to parse: it is a property of the SET. There is no
 * "first", no "best" and no "latest" for a later comment to become. A duplicate
 * cannot grant authority, cannot repair a broken order, cannot widen a narrow one
 * and cannot replace a refusal - it can only make the whole question undecidable,
 * which fails closed.
 *
 * That last point is the deliberate trade. An ambiguous authority is refused even
 * when the ORIGINAL order was an ordinary non-merge one, because the worker cannot
 * tell "the architect posted a scope update" apart from "the child forged an
 * order" - both are the same login, and both are the same shape. Fail closed is
 * the only honest answer, and the remedy is the one this worker already documents
 * everywhere else: issue a FRESH TASK_ID.
 *
 * Everything in this module is PURE except the three thin remote reads its
 * caller performs. Every branch fails CLOSED with its own named reason, and no
 * branch can reach the filesystem, the repository, or a destructive action.
 */

import { extractField, validateTrustedTask } from "./trust.mjs";
import {
  ORDER_BINDING,
  collapseIdenticalOrderRepeats,
  normalizeCommentId,
  orderBindingEvidence,
  validateOrderBinding,
  verifyOrderAgainstBinding
} from "./order-binding.mjs";
import {
  POST_MERGE_EVIDENCE,
  classifyPostMergeChecks,
  resolvePostMergeEvidencePolicy,
  verifyCloseoutReport
} from "./postmerge-evidence.mjs";
import { MERGE_TREE_PROOF, describeMergeTreeProof, verifyMergeTreeProof } from "./merge-tree-proof.mjs";

export {
  MERGE_TREE_PROOF,
  describeMergeTreeProof,
  verifyMergeTreeProof
} from "./merge-tree-proof.mjs";

export {
  ORDER_BINDING,
  ORDER_BINDING_VERSION,
  bindOrderOnce,
  buildOrderBinding,
  describeOrderBinding,
  digestLabel,
  orderBindingEvidence,
  orderBodyDigest,
  validateOrderBinding,
  verifyOrderAgainstBinding
} from "./order-binding.mjs";

export {
  POST_MERGE_EVIDENCE,
  EXTRA_CHECK_POLICY,
  DEFAULT_REQUIRED_POST_MERGE_CHECKS,
  DEFAULT_CLOSEOUT_PROFILE,
  CLOSEOUT_PROFILES,
  classifyPostMergeChecks,
  resolvePostMergeEvidencePolicy,
  verifyCloseoutReport,
  reportFieldForCheck,
  readAllFields
} from "./postmerge-evidence.mjs";

/**
 * Every outcome this module can produce. One name per distinct finding.
 *
 * D-146: the post-merge evidence findings are defined in `postmerge-evidence.mjs`
 * and spread in here, so callers, logs and recorded verdicts keep ONE reason
 * namespace regardless of which half of the proof refused.
 */
export const MERGE_TRANSITION = Object.freeze({
  ...POST_MERGE_EVIDENCE,
  /**
   * D-158: the merge-tree-proof findings, in the SAME reason namespace. They
   * replace D-145's `TREE_MISMATCH` and D-157's `MERGE_DELTA` set, neither of
   * which is kept alongside them - see the module header for why each was wrong
   * for a topology its own fixtures did not contain.
   */
  ...MERGE_TREE_PROOF,
  /**
   * D-149: the durable-order-binding findings, folded into the SAME reason
   * namespace as everything else this module can refuse with, so a record, a log
   * line and a status comment never have to know which half produced a reason.
   */
  ...ORDER_BINDING,

  /** The authorized transition is proven from control-plane + fresh remote truth. */
  VERIFIED: "authorized_merge_transition_verified",

  /* --- authorization (trusted ARCHITECT_TASK comment only) --- */
  /** No trusted ARCHITECT_TASK for this exact task id was available at all. */
  NO_TRUSTED_TASK: "no_trusted_architect_task_comment_binds_this_task",
  /**
   * D-148: MORE THAN ONE trusted ARCHITECT_TASK claims this exact TASK_ID, so
   * there is no single immutable original authority to read.
   *
   * This is never resolved by picking one. Picking is what made authority mutable:
   * whichever rule chose ("first that parses", "latest", "the one with the flags")
   * would hand a later poster - including the dispatched child, which shares the
   * trusted GitHub login - a way to decide what this task was authorized to do.
   */
  AMBIGUOUS_AUTHORITY:
    "more_than_one_trusted_architect_task_claims_this_exact_task_id_so_the_original_authority_is_ambiguous",
  /**
   * D-148: the single trusted ARCHITECT_TASK for this task was EDITED after it was
   * posted. Immutable authority means the order that was independently reviewed is
   * the order that is executed; an edited comment cannot prove that, and editing
   * is available to exactly the same actor a forged duplicate is.
   *
   * Conservative by construction: this fires only when the comment carries BOTH
   * `created_at` and `updated_at` and they differ - the same rule
   * `validateControlCommand` already applies to supervisor commands.
   */
  AUTHORITY_COMMENT_EDITED:
    "the_trusted_architect_task_for_this_task_was_edited_after_it_was_posted_so_its_authority_is_not_immutable",
  /** The trusted task exists but does not authorize a merge. */
  NOT_MERGE_AUTHORIZED: "the_trusted_architect_task_does_not_authorize_a_merge",
  /**
   * D-147: the trusted task declares exactly ONE half of a merge authorization.
   *
   * `ARCHITECT_MERGE_APPROVED` and `MERGE_AUTHORIZED` are two separate statements
   * and D-120 requires both, so one alone has never been an authorization. What
   * changes here is what one alone MEANS: it used to be indistinguishable from
   * "this is an ordinary implementation task", which routed it down the cheap
   * non-merge path where a verified commit range retired it with no transition
   * proof at all. A half-declared merge is a CLAIMED merge with a broken order,
   * and a broken order is refused rather than silently downgraded to no order.
   */
  MERGE_AUTHORIZATION_PARTIAL: "the_trusted_architect_task_declares_only_one_half_of_a_merge_authorization",
  /** Merge-authorized, but without an exact PR number / base / head to check. */
  AUTHORIZATION_INCOMPLETE: "the_trusted_architect_task_does_not_declare_an_exact_pr_number_base_and_head",
  /** D-147: verifying the transition threw. A verification that threw verified nothing. */
  VERIFICATION_THREW: "merge_transition_verification_threw",
  /** The task explicitly declares a merge method other than a normal merge. */
  MERGE_METHOD_NOT_MERGE: "the_trusted_architect_task_declares_a_merge_method_that_is_not_a_normal_two_parent_merge",
  /** The task names a repository other than the one this worker serves. */
  REPO_MISMATCH: "the_trusted_architect_task_names_a_different_repository",

  /* --- the terminal report --- */
  /** The report is not a trusted, terminal, SUCCESSFUL completion for this task. */
  REPORT_NOT_SUCCESSFUL: "the_terminal_report_is_not_a_successful_completion_for_this_task",

  /* --- fresh remote truth --- */
  /** The PR could not be read. Unreadable is never "merged". */
  PULL_UNREADABLE: "the_authorized_pull_request_could_not_be_read_from_the_remote",
  /** The PR that came back is not the authorized one. */
  PULL_NUMBER_MISMATCH: "the_remote_pull_request_is_not_the_authorized_pull_request",
  /** The remote says the PR is not merged. */
  NOT_MERGED: "the_authorized_pull_request_is_not_merged_on_the_remote",
  /** Merged, but the remote records no merge commit sha. */
  MERGE_SHA_MISSING: "the_remote_records_no_merge_commit_sha_for_the_merged_pull_request",
  /** The PR's head is not the head the architect approved. */
  PULL_HEAD_MISMATCH: "the_remote_pull_request_head_is_not_the_approved_head",
  /** The merge commit could not be read. */
  MERGE_COMMIT_UNREADABLE: "the_merge_commit_could_not_be_read_from_the_remote",
  /** The commit we read is not the merge commit the PR names. */
  MERGE_COMMIT_IDENTITY_MISMATCH: "the_commit_read_back_is_not_the_merge_commit_the_pull_request_names",
  /** Not exactly two parents: a squash, a rebase, or something stranger. */
  NOT_A_TWO_PARENT_MERGE: "the_merge_commit_does_not_have_exactly_two_parents_so_it_is_not_a_normal_merge",
  /** First parent is not the approved base. */
  FIRST_PARENT_MISMATCH: "the_merge_commit_first_parent_is_not_the_approved_base_commit",
  /** Second parent is not the approved head. */
  SECOND_PARENT_MISMATCH: "the_merge_commit_second_parent_is_not_the_approved_head_commit",
  /** The approved head commit could not be read, so it is not a known remote commit. */
  HEAD_COMMIT_UNREADABLE: "the_approved_head_commit_could_not_be_read_from_the_remote",
  /*
   * D-145's `TREE_MISMATCH` AND D-157's `MERGE_DELTA` FINDINGS USED TO LIVE HERE,
   * AND BOTH ARE GONE ON PURPOSE.
   *
   * `TREE_MISMATCH` asserted `merge tree === approved head tree`, which holds
   * only when the head already contains every commit on its base. The
   * `DELTA_*` findings asserted that two API diff projections were equal field
   * for field, which holds only when base and head touch different FILES - for
   * different non-overlapping hunks of ONE file the merge blob correctly carries
   * both sides, and a valid merge was refused as `DELTA_CONTENT_MISMATCH`.
   *
   * Neither is retained as a dead constant: nothing may emit either again, and
   * the property both were reaching for is now proven by the `MERGE_TREE_PROOF`
   * findings spread in above - by recomputing the merge instead of asserting a
   * resemblance, which is the same statement in every topology.
   */

  /* --- post-merge gates -----------------------------------------------------
   *
   * D-146: the check-run findings now live in `POST_MERGE_EVIDENCE` (spread in
   * above) because they are about REQUIRED CHECK IDENTITY, not about the merge's
   * structure. `CHECKS_UNREADABLE` and `CHECKS_MISSING` keep their D-145 string
   * values. The two blanket findings D-145 had - "at least one check run has not
   * finished" and "at least one finished check run did not succeed" - are gone
   * on purpose: they could only ever describe whatever runs happened to exist,
   * which is precisely the fail-open the PR #81 review found. They are replaced
   * by `CHECKS_REQUIRED_UNFINISHED` and `CHECKS_REQUIRED_NOT_SUCCESS`, which name
   * the required check that failed.
   */
});

/**
 * Why a verified transition did NOT excuse a provenance verdict.
 *
 * These are the narrowing rules, and they are named separately from the
 * transition reasons above because they are a different finding: the transition
 * itself may be perfectly proven while the commit range still contains something
 * the transition does not account for.
 */
export const TRANSITION_EXCUSE = Object.freeze({
  /** The set of unexplained commits is exactly the verified merge commit. */
  EXCUSED: "the_only_unexplained_commit_is_the_verified_authorized_merge_commit",
  /** The transition itself is not verified, so it excuses nothing. */
  TRANSITION_NOT_VERIFIED: "the_authorized_merge_transition_is_not_verified",
  /** No classified range exists, so "only the merge commit" cannot be established. */
  NO_PROVENANCE_RECORD: "no_classified_commit_range_exists_to_compare_against_the_merge_commit",
  /** The verdict is not a classified range (diverged / drifted / unknown). */
  VERDICT_NOT_A_CLASSIFIED_RANGE: "the_commit_provenance_verdict_is_not_a_classified_range",
  /** The range or the detail list was capped, so some sha was never seen. */
  EVIDENCE_INCOMPLETE: "the_commit_range_or_its_unexplained_detail_list_was_truncated_so_some_commit_was_never_seen",
  /** More than one commit is unexplained: the merge cannot account for the rest. */
  MORE_THAN_THE_MERGE_COMMIT: "the_range_contains_unexplained_commits_other_than_the_authorized_merge_commit"
});

/** Verdicts that represent a RANGE THAT WAS ACTUALLY READ AND CLASSIFIED. */
const CLASSIFIED_VERDICTS = Object.freeze(["unattributed", "partially_attributed"]);

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

function fullSha(value) {
  return typeof value === "string" && FULL_SHA_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
}

function sameSha(a, b) {
  const x = fullSha(a);
  const y = fullSha(b);
  return x !== null && y !== null && x === y;
}

/** `true` only for the literal string `true`. Anything else is not authorization. */
function declaredTrue(body, key) {
  return String(extractField(body, key) ?? "").trim().toLowerCase() === "true";
}

/**
 * Read the merge authorization out of ONE trusted ARCHITECT_TASK comment.
 *
 * The comment is re-validated here rather than taken on trust from the caller:
 * author, header line and TASK_ID are checked again, and the TASK_ID must equal
 * the task being gated EXACTLY. A merge authorization for a different task is
 * not an authorization for this one, however trusted its author.
 *
 * D-146: the POST-MERGE EVIDENCE POLICY is resolved here too, from this same
 * trusted body (falling back to the worker's own config and then the repository
 * default). Resolving it at authorization-read time is deliberate: the policy that
 * decides which checks are required and which closeout fields must be bound can
 * then only ever come from a comment that has already passed the author, header
 * and TASK_ID checks above. There is no later seam where PR text could reach it.
 *
 * Returns `{ ok, reason, ... }`. `ok: false` is always a named refusal.
 */
export function readMergeAuthorization(comment, {
  trustedAuthor,
  taskId,
  repoOwner = null,
  repoName = null,
  workerPolicy = null
}) {
  // D-147: `mergeClaimed` travels on EVERY refusal. It is what lets a caller tell
  // "this task never asked for a merge" apart from "this task asked for a merge
  // and its order is broken" without re-parsing the body - and those two must
  // never again collapse into the same cheap non-merge path.
  const refuse = (reason, detail = null, extra = {}) => ({ ok: false, reason, detail, mergeClaimed: false, ...extra });

  const trusted = validateTrustedTask(comment, { trustedAuthor });
  if (!trusted.ok) return refuse(MERGE_TRANSITION.NO_TRUSTED_TASK, trusted.reason);
  if (!taskId || trusted.taskId !== taskId) {
    return refuse(MERGE_TRANSITION.NO_TRUSTED_TASK,
      `the trusted task declares TASK_ID=${JSON.stringify(trusted.taskId)}, not ${JSON.stringify(taskId ?? null)}`);
  }

  const body = String(comment.body ?? "");

  // BOTH flags, both literally `true`. They are two separate statements - "an
  // independent architect review passed" and "this worker may merge" - and D-120
  // requires both. One alone is not an authorization.
  const approved = declaredTrue(body, "ARCHITECT_MERGE_APPROVED");
  const authorized = declaredTrue(body, "MERGE_AUTHORIZED");
  if (!approved || !authorized) {
    // NEITHER flag: an ordinary implementation order. It claims no merge, so it
    // is not a merge task and nothing further is required of it.
    if (!approved && !authorized) {
      return refuse(MERGE_TRANSITION.NOT_MERGE_AUTHORIZED,
        `ARCHITECT_MERGE_APPROVED=${approved}, MERGE_AUTHORIZED=${authorized}`);
    }
    // EXACTLY ONE flag: a merge IS claimed, and the order that claims it is
    // incomplete. Fail closed, and say so as a merge finding.
    return refuse(MERGE_TRANSITION.MERGE_AUTHORIZATION_PARTIAL,
      `ARCHITECT_MERGE_APPROVED=${approved}, MERGE_AUTHORIZED=${authorized}; D-120 requires both, and a half-declared `
      + "merge authorization is a broken order rather than an ordinary non-merge task",
      { mergeClaimed: true });
  }

  // Past this point a merge is unambiguously CLAIMED: both flags are literally
  // `true`. Every refusal below is therefore a BROKEN AUTHORIZATION, never a
  // "this was not a merge task after all".
  const refuseClaimed = (reason, detail = null) => refuse(reason, detail, { mergeClaimed: true });

  // The repository, when the task names one, must be the one this worker serves.
  const repo = extractField(body, "REPO");
  if (repo && repoOwner && repoName && repo.trim().toLowerCase() !== `${repoOwner}/${repoName}`.toLowerCase()) {
    return refuseClaimed(MERGE_TRANSITION.REPO_MISMATCH, `the task names REPO=${repo.trim()}`);
  }

  // An EXPLICIT method field, when present, must say `merge`. When absent, the
  // two-parent structural check below is what proves the method - and that check
  // is strictly stronger than any field, because a field is only a claim.
  const method = extractField(body, "MERGE_METHOD");
  if (method !== null && method.trim().toLowerCase() !== "merge") {
    return refuseClaimed(MERGE_TRANSITION.MERGE_METHOD_NOT_MERGE, `MERGE_METHOD=${method.trim()}`);
  }

  const prRaw = extractField(body, "PR_NUMBER");
  const prNumber = /^\d+$/.test(String(prRaw ?? "").trim()) ? Number(String(prRaw).trim()) : null;
  const expectedBase = fullSha(extractField(body, "EXPECTED_BASE_SHA"));
  const expectedHead = fullSha(extractField(body, "EXPECTED_HEAD_SHA"));
  if (prNumber === null || prNumber <= 0 || !expectedBase || !expectedHead) {
    return refuseClaimed(MERGE_TRANSITION.AUTHORIZATION_INCOMPLETE,
      `PR_NUMBER=${JSON.stringify(prRaw ?? null)}, EXPECTED_BASE_SHA=${JSON.stringify(expectedBase)}, `
      + `EXPECTED_HEAD_SHA=${JSON.stringify(expectedHead)}`);
  }
  // A merge of a commit onto itself is not a state transition; refusing it here
  // keeps every later comparison unambiguous.
  if (expectedBase === expectedHead) {
    return refuseClaimed(MERGE_TRANSITION.AUTHORIZATION_INCOMPLETE,
      "EXPECTED_BASE_SHA and EXPECTED_HEAD_SHA are the same commit");
  }

  // D-146: an authorized merge task that cannot produce a decidable post-merge
  // evidence policy is refused HERE, before a single remote call. "Not enough
  // policy to decide" is a decision, and the decision is no.
  const policy = resolvePostMergeEvidencePolicy({ declared: body, workerPolicy });
  if (!policy.ok) {
    return refuseClaimed(policy.reason, policy.detail);
  }

  return {
    ok: true,
    reason: null,
    mergeClaimed: true,
    taskId: trusted.taskId,
    commentId: comment.id ?? null,
    prNumber,
    expectedBase,
    expectedHead,
    mergeMethod: method === null ? null : method.trim().toLowerCase(),
    repo: repo ? repo.trim() : null,
    taskType: extractField(body, "TASK_TYPE"),
    policy
  };
}

/**
 * D-148: THE ONE ORIGINAL ORDER FOR ONE TASK ID, OR NOTHING.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS A COUNT AND NOT A CHOICE
 * ------------------------------------------------------------------------
 *
 * Every rule that CHOOSES among same-id orders hands the choice to whoever can
 * post one. "First that parses" (what D-147 did) is the worst of them - it is a
 * forward scan for a passing candidate, so a later well-formed order beats an
 * earlier refusal and authority grows over time. "Latest wins" is worse still.
 * Even "earliest by created_at" only holds while `created_at` is present, valid,
 * unique and honest, and it still has to answer what to do when it is not.
 *
 * So nothing is chosen. The candidate SET is built by filtering, and the decision
 * is made on its SIZE:
 *
 *   |candidates| == 0   no trusted order binds this task
 *   |candidates| == 1   that comment IS the authority, and cannot be anything else
 *   |candidates| >= 2   AMBIGUOUS. Refused, with both ids named.
 *
 * ARRAY ORDER CANNOT REACH ANY OF THIS. There is no `find`, no `[0]`, no sort and
 * no early return over `comments`: the filter visits every element, and a set's
 * size is the same however the set was enumerated. Reordered pagination, a page
 * boundary landing in a different place, or a caller that reverses the list all
 * produce the identical verdict - which is the property the adversarial suite
 * asserts by running every case in both directions.
 *
 * The one thing that IS collapsed is a comment appearing twice as the SAME
 * comment: identical id, identical body, identical `created_at`. Overlapping
 * `--paginate` pages produce exactly that, and calling it a duplicate authority
 * would be a false refusal. A shared id with ANY differing content is NOT
 * collapsed - it is two orders wearing one id, which is strictly more suspicious
 * than two orders with two ids, and it refuses.
 *
 * Pure. It reads already-fetched comment objects, calls `validateTrustedTask`,
 * and touches nothing else.
 */
export function selectCanonicalArchitectTask(comments, { trustedAuthor, taskId }) {
  const list = Array.isArray(comments) ? comments : [];
  const refuse = (reason, detail, extra = {}) => ({
    ok: false,
    reason,
    detail,
    comment: null,
    commentId: null,
    createdAt: null,
    candidateCount: 0,
    candidateIds: [],
    duplicateIds: [],
    undecidable: false,
    ...extra
  });

  if (typeof taskId !== "string" || taskId.trim() === "") {
    return refuse(MERGE_TRANSITION.NO_TRUSTED_TASK, `no task id to bind an order to (${JSON.stringify(taskId ?? null)})`);
  }

  // EXACT id equality only. A trusted order for a neighbouring task is not this
  // task's order, however similar the id looks.
  const candidates = [];
  for (const comment of list) {
    const trusted = validateTrustedTask(comment, { trustedAuthor });
    if (!trusted.ok || trusted.taskId !== taskId) continue;
    candidates.push(comment);
  }

  // Collapse only provably-identical repeats of ONE comment (see above).
  //
  // D-150: the collapse itself lives in the leaf module `order-binding.mjs`, so
  // the rule the ADMISSION gate counts with and the rule this COMPLETION gate
  // counts with are ONE implementation and cannot drift apart into two different
  // answers to "is this authority unique?".
  const distinct = collapseIdenticalOrderRepeats(candidates);

  // GitHub's own ids, exactly as they came back. The prefixed identity the
  // collapse uses is an internal dedupe key only - what a record carries, and
  // what a human is asked to go and look at, must be the id they can paste into
  // a URL.
  const ids = distinct.map((c) => c?.id ?? null);
  if (distinct.length === 0) {
    return refuse(MERGE_TRANSITION.NO_TRUSTED_TASK,
      `no trusted ARCHITECT_TASK among ${list.length} control comment(s) declares TASK_ID=${JSON.stringify(taskId)}`);
  }
  if (distinct.length > 1) {
    // Named as an ORDER problem, and never resolved by preferring one of them.
    return refuse(MERGE_TRANSITION.AMBIGUOUS_AUTHORITY,
      `${distinct.length} distinct trusted ARCHITECT_TASK comments declare TASK_ID=${JSON.stringify(taskId)} `
      + `(ids ${ids.map((i) => JSON.stringify(i)).join(", ")}); one task id has exactly one original authority, so a `
      + "second order makes it undecidable rather than updated - reissue the work under a FRESH TASK_ID",
      { candidateCount: distinct.length, candidateIds: ids, duplicateIds: ids, undecidable: true });
  }

  const canonical = distinct[0];
  const createdAt = String(canonical.created_at ?? "").trim() || null;
  const updatedAt = String(canonical.updated_at ?? "").trim() || null;
  // Conservative, and identical to the supervisor-command rule: an edit is only
  // PROVEN when both timestamps are present and differ. A fixture or an API
  // projection that omits `updated_at` is not evidence of tampering.
  if (createdAt && updatedAt && createdAt !== updatedAt) {
    return refuse(MERGE_TRANSITION.AUTHORITY_COMMENT_EDITED,
      `comment ${JSON.stringify(ids[0])} was created at ${createdAt} and last updated at ${updatedAt}; the order `
      + "that was independently reviewed and the order being executed can no longer be proven to be the same text",
      { candidateCount: 1, candidateIds: ids, undecidable: true });
  }

  return {
    ok: true,
    reason: null,
    detail: null,
    comment: canonical,
    commentId: ids[0],
    createdAt,
    candidateCount: 1,
    candidateIds: ids,
    duplicateIds: [],
    undecidable: false
  };
}

/** The selection evidence carried on every classification, pass or refusal. */
function selectionEvidence(selection) {
  return {
    canonical_comment_id: selection.ok ? selection.commentId : null,
    canonical_created_at: selection.ok ? selection.createdAt : null,
    candidate_count: selection.candidateCount,
    candidate_comment_ids: selection.candidateIds,
    duplicate_comment_ids: selection.duplicateIds
  };
}

/**
 * The merge authorization for one task, read from its ONE canonical order.
 *
 * D-148: this no longer searches. It selects the single original order (above)
 * and reads that one comment. A `TASK_UPDATE`, a second same-id ARCHITECT_TASK, a
 * CLAUDE_ACK/REPORT, a worker status notice, PR text or review prose can therefore
 * never contribute a field, repair a broken order or grant an authorization the
 * original did not carry - there is no code path along which any of them is read.
 */
export function findMergeAuthorization(comments, {
  trustedAuthor,
  taskId,
  repoOwner = null,
  repoName = null,
  workerPolicy = null
}) {
  const selection = selectCanonicalArchitectTask(comments, { trustedAuthor, taskId });
  if (!selection.ok) {
    return {
      ok: false,
      reason: selection.reason,
      detail: selection.detail,
      // Unknown, not false: with no readable single order we cannot say whether a
      // merge was claimed, and `false` here would read as "ordinary task".
      mergeClaimed: selection.undecidable ? null : false,
      selection
    };
  }
  const read = readMergeAuthorization(selection.comment, { trustedAuthor, taskId, repoOwner, repoName, workerPolicy });
  return { ...read, selection };
}

/**
 * D-147: WHAT KIND OF TASK IS THIS, decided WITHOUT looking at commit provenance.
 *
 * ------------------------------------------------------------------------
 * THE INTEGRATION BYPASS THIS CLOSES
 * ------------------------------------------------------------------------
 *
 * D-145 and D-146 built a complete proof of an authorized merge and then wired it
 * in as a FALLBACK: the worker asked for it only when the generic commit-range
 * question had already come back unproven. The reasoning was that the transition
 * is "an alternative answer to the authorship question, never an additional
 * requirement on a task that already answered it".
 *
 * That reasoning is wrong for merge tasks, and the counterexample is trivial to
 * construct. Take the SAME trusted merge order, and a child that correctly
 * trailers one ordinary commit - or simply never moves HEAD at all. The range is
 * now `task_attributed` or `unchanged`: PROVEN. The worker's fallback condition is
 * false, so `verifyMergeTransition` is never called, no PR is read, no required
 * check is inspected, no closeout report is bound, and the task retires
 * successfully as `commit_provenance_verified` - having proven only that Claude
 * wrote its own commits, which was never what the task was FOR.
 *
 * Commit provenance answers "did this task write these commits?". A merge task's
 * deliverable is a STATE TRANSITION ON THE REMOTE. Proving the first has never
 * been, and can never be, evidence for the second, so it must never be allowed to
 * substitute for it. Whether a task is merge-authorized is a property of its own
 * trusted order and of nothing else - so it is decided here, from that order
 * alone, before any provenance verdict is consulted.
 *
 * ------------------------------------------------------------------------
 * THREE ANSWERS, AND WHY THE MIDDLE ONE EXISTS
 * ------------------------------------------------------------------------
 *
 *   NONE         this task's own trusted order claims no merge. The ordinary,
 *                overwhelmingly common case. Nothing extra is required of it and
 *                NOT ONE remote call is made for it - the cheap path is unchanged.
 *   AUTHORIZED   the order authorizes a merge AND is fully decidable: both flags,
 *                an exact PR/base/head, a known merge method, this repository, and
 *                a post-merge evidence policy that resolves. Fresh transition
 *                verification is MANDATORY for it, whatever provenance says.
 *   UNDECIDABLE  a merge is CLAIMED and the claim cannot be decided - half the
 *                flags, a missing base/head, an unknown method, another repo, an
 *                empty required-check set. Before D-147 several of these were
 *                indistinguishable from NONE and fell into the cheap path; they
 *                are now a named fail-closed outcome in their own right.
 *
 * D-148 adds a second way into UNDECIDABLE, and it is decided BEFORE any body is
 * parsed: the AUTHORITY itself may be broken. Two or more trusted ARCHITECT_TASK
 * comments for one TASK_ID, or a single one that was edited after posting, leave
 * no immutable original to read. Those are undecidable no matter what the bodies
 * say - including when one of them would have parsed perfectly, which is precisely
 * the case a forged duplicate produces.
 *
 * Note what that costs and why it is the right price: an ORDINARY task also
 * becomes undecidable if a second same-id order appears. The worker cannot
 * distinguish an architect's scope update from a child's forgery, because they are
 * the same login posting the same shape. Refusing is recoverable (reissue under a
 * fresh TASK_ID); accepting is not.
 *
 * Pure: it reads comments already fetched for this run and touches nothing else.
 */
export const MERGE_AUTHORIZATION = Object.freeze({
  /** This task's own trusted order claims no merge at all. */
  NONE: "no_trusted_architect_task_for_this_task_claims_a_merge_authorization",
  /** A merge is authorized and the authorization is fully decidable. */
  AUTHORIZED: "the_trusted_architect_task_authorizes_a_merge",
  /** A merge is claimed but the claim cannot be decided. Fail closed. */
  UNDECIDABLE: "the_trusted_architect_task_claims_a_merge_authorization_that_cannot_be_decided"
});

export function classifyMergeAuthorization(comments, {
  trustedAuthor,
  taskId,
  repoOwner = null,
  repoName = null,
  workerPolicy = null
}) {
  const opts = { trustedAuthor, taskId, repoOwner, repoName, workerPolicy };

  // D-148: the ONE original order, or a named refusal. Nothing below ever looks
  // at another comment, so no later comment can influence any answer here.
  const selection = selectCanonicalArchitectTask(comments, { trustedAuthor, taskId });
  const evidence = selectionEvidence(selection);

  if (!selection.ok) {
    const authorization = {
      ok: false,
      reason: selection.reason,
      detail: selection.detail,
      mergeClaimed: selection.undecidable ? null : false,
      selection
    };
    // AMBIGUOUS or EDITED: the authority itself is broken. That is UNDECIDABLE and
    // never NONE - reading an unreadable authority as "not a merge task" is the
    // exact downgrade D-147 removed for half-declared flags, and it would be a far
    // larger hole here, because a forged duplicate could then retire a real task.
    if (selection.undecidable) {
      return {
        claim: MERGE_AUTHORIZATION.UNDECIDABLE,
        claimed: true,
        decidable: false,
        reason: selection.reason,
        detail: selection.detail,
        authorization,
        selection: evidence
      };
    }
    // No order at all for this id. Genuinely not a merge task.
    return {
      claim: MERGE_AUTHORIZATION.NONE,
      claimed: false,
      decidable: true,
      reason: MERGE_AUTHORIZATION.NONE,
      detail: selection.detail,
      authorization,
      selection: evidence
    };
  }

  const read = readMergeAuthorization(selection.comment, opts);
  if (read.ok) {
    return {
      claim: MERGE_AUTHORIZATION.AUTHORIZED,
      claimed: true,
      decidable: true,
      reason: MERGE_AUTHORIZATION.AUTHORIZED,
      detail: `PR #${read.prNumber}, ${read.expectedBase} -> ${read.expectedHead}, `
        + `authorized by trusted comment ${JSON.stringify(selection.commentId)}`,
      authorization: { ...read, selection },
      selection: evidence
    };
  }
  // The canonical order refused. Whether that is "no merge claimed" or "a merge
  // claimed with a broken order" is decided by THIS comment and by nothing else -
  // a second, well-formed order elsewhere on the issue cannot rescue it.
  if (read.mergeClaimed === true) {
    return {
      claim: MERGE_AUTHORIZATION.UNDECIDABLE,
      claimed: true,
      decidable: false,
      reason: read.reason,
      detail: read.detail ?? null,
      authorization: { ...read, selection },
      selection: evidence
    };
  }
  return {
    claim: MERGE_AUTHORIZATION.NONE,
    claimed: false,
    decidable: true,
    reason: MERGE_AUTHORIZATION.NONE,
    detail: read.detail ?? null,
    authorization: { ...read, selection },
    selection: evidence
  };
}

/**
 * D-149: THE SAME CLASSIFICATION, FOR A TASK THAT HAS ALREADY BEEN ADMITTED.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE ENTRY POINT AND NOT A FLAG
 * ------------------------------------------------------------------------
 *
 * `classifyMergeAuthorization` above is the PRE-ADMISSION primitive: given a set
 * of comments and a task id, what does the one canonical order say? At that point
 * "no order for this id" is a perfectly honest answer - nothing yet asserts that
 * an order ever existed, so there is nothing to contradict.
 *
 * A task the worker is COMPLETION-GATING is in a different position entirely. It
 * was admitted from an order. The worker wrote down which one, when, and exactly
 * what it said, BEFORE it dispatched anything. So for that task, "I cannot find
 * the order now" is never a fact about the order - it is a fact about this read.
 * Mapping it onto `NONE` is what let a deletion downgrade a merge-authorized task
 * to ordinary work and skip D-147's mandatory transition, CI and report proof.
 *
 * Making it a boolean flag on the existing function was the obvious alternative
 * and it is the wrong shape: the safe value would have to be the non-default one,
 * so every future caller that forgot it would fail OPEN, silently, on the exact
 * path that matters. A caller here must name the bound entry point to get a
 * classification at all, and this entry point cannot produce `NONE` for a
 * mismatch by construction.
 *
 * ------------------------------------------------------------------------
 * THE ORDER OF THE CHECKS
 * ------------------------------------------------------------------------
 *
 *   1. THE BINDING. Missing, unreadable, foreign or from an unsupported version
 *      -> UNDECIDABLE. Never repaired from current text: recomputing the
 *      authority from whatever is on the issue right now is the defect.
 *   2. THE READ. A comment collection not PROVEN complete -> UNDECIDABLE, before
 *      a single candidate is counted. A set we cannot vouch for can neither
 *      confirm nor refute the order's presence, and a partial page is exactly
 *      how the order disappears without anything failing.
 *   3. THE SET. `selectCanonicalArchitectTask`'s D-148 count, unchanged.
 *      Duplicates and edits stay AMBIGUOUS_AUTHORITY / AUTHORITY_COMMENT_EDITED.
 *      The one case that changes meaning is ZERO: for a bound task that is
 *      `ORDER_ABSENT`, not `NO_TRUSTED_TASK` -> UNDECIDABLE, not NONE.
 *   4. THE IDENTITY. The single candidate must BE the bound order: same comment
 *      id, same body digest, same creation metadata where it was bound.
 *   5. ONLY THEN the body is read, by exactly the D-147/D-148 rules. A bound
 *      false/false order is still ordinary non-merge; a bound true/true one still
 *      owes the full transition proof. Nothing about authorization SEMANTICS
 *      changes here - only which bytes are allowed to supply them.
 *
 * Pure. Same inputs as the unbound form plus the durable binding and the read's
 * own completeness verdict; it touches nothing else.
 */
export function classifyBoundMergeAuthorization({
  comments,
  commentsComplete,
  binding,
  trustedAuthor,
  taskId,
  repoOwner = null,
  repoName = null,
  workerPolicy = null
}) {
  const list = Array.isArray(comments) ? comments : [];
  const bindingDoc = binding ?? null;

  /** Every trusted candidate id we can actually see, for the evidence record. */
  const observedIds = () => {
    const ids = [];
    for (const comment of list) {
      const trusted = validateTrustedTask(comment, { trustedAuthor });
      if (!trusted.ok || trusted.taskId !== taskId) continue;
      const id = normalizeCommentId(comment?.id);
      if (id !== null && !ids.includes(id)) ids.push(id);
    }
    return ids;
  };

  const undecidable = (reason, detail, { verification = null, selection = null } = {}) => ({
    claim: MERGE_AUTHORIZATION.UNDECIDABLE,
    claimed: true,
    decidable: false,
    reason,
    detail,
    authorization: { ok: false, reason, detail, mergeClaimed: null, selection },
    selection: selection ? selectionEvidence(selection) : selectionEvidence({
      ok: false, commentId: null, createdAt: null, candidateCount: 0, candidateIds: [], duplicateIds: []
    }),
    binding: orderBindingEvidence({
      binding: bindingDoc,
      verification,
      observedCommentIds: observedIds(),
      collectionComplete: commentsComplete
    })
  });

  // --- 1. the binding -------------------------------------------------------
  const bindingValid = validateOrderBinding(bindingDoc, { taskId });
  if (!bindingValid.ok) {
    // A known task with no usable binding is a RECOVERABLE hold with an explicit
    // reason - the legacy-migration case included. It is emphatically not
    // "this task never had an order", which is the inference D-149 removes.
    return undecidable(bindingValid.reason, bindingValid.detail, {
      verification: { ok: false, reason: bindingValid.reason, detail: bindingValid.detail }
    });
  }

  // --- 2. the read ----------------------------------------------------------
  if (commentsComplete !== true) {
    const detail = commentsComplete === false
      ? "the control comment collection is known to be incomplete (a failed read or an unparseable page), so the "
        + "absence of the bound order proves nothing about the order"
      : "the caller did not establish that the control comment collection was read completely, and an unproven "
        + "read can neither confirm nor refute the bound order";
    return undecidable(ORDER_BINDING.COLLECTION_INCOMPLETE, detail, {
      verification: { ok: false, reason: ORDER_BINDING.COLLECTION_INCOMPLETE, detail }
    });
  }

  // --- 3. the set (D-148, unchanged except for what ZERO means) -------------
  const selection = selectCanonicalArchitectTask(list, { trustedAuthor, taskId });
  if (!selection.ok) {
    if (selection.reason === MERGE_TRANSITION.NO_TRUSTED_TASK) {
      const verification = verifyOrderAgainstBinding({ binding: bindingDoc, comment: null, taskId });
      return undecidable(ORDER_BINDING.ORDER_ABSENT,
        `${selection.detail}; this task was ADMITTED from a trusted order and is durably bound to comment `
        + `${JSON.stringify(normalizeCommentId(bindingDoc.comment_id))}, so its disappearance is a finding about `
        + "this read - or about the order having been deleted or replaced - and never a statement that no order "
        + "ever existed",
        { verification, selection });
    }
    // AMBIGUOUS_AUTHORITY / AUTHORITY_COMMENT_EDITED: D-148's verdicts stand.
    return undecidable(selection.reason, selection.detail, {
      verification: { ok: false, reason: selection.reason, detail: selection.detail },
      selection
    });
  }

  // --- 4. the identity ------------------------------------------------------
  const verification = verifyOrderAgainstBinding({ binding: bindingDoc, comment: selection.comment, taskId });
  if (!verification.ok) {
    return undecidable(verification.reason, verification.detail, { verification, selection });
  }

  // --- 5. the body, by the unchanged D-147/D-148 rules ----------------------
  const bindingEvidence = orderBindingEvidence({
    binding: bindingDoc,
    verification,
    observedCommentIds: observedIds(),
    collectionComplete: commentsComplete
  });
  const classified = classifyMergeAuthorization(list, {
    trustedAuthor, taskId, repoOwner, repoName, workerPolicy
  });
  return { ...classified, binding: bindingEvidence };
}

/**
 * THE VERIFIER. Pure: every input is already-fetched data, every branch is a
 * named refusal, and nothing here can touch the repository or the network.
 *
 *   authorization  `readMergeAuthorization` / `findMergeAuthorization` result
 *   completion     an `assessCompletion` result for this exact task
 *   pull           `{ ok, item: { number, merged, mergeCommitSha, headSha, ... } }`
 *   mergeCommit    `{ ok, item: { sha, parents: [...], treeSha } }`
 *   headCommit     `{ ok, item: { sha, treeSha } }` for the APPROVED head
 *   checks         `{ ok, runs: [{ name, status, conclusion }] }` on the merge sha
 *   mergeTreeProof D-158: the record from `computeMergeTree` - the tree that
 *                  merging the authorized base and head produces, and the merge
 *                  commit's own tree and parents read from the real objects.
 *                  See `merge-tree-proof.mjs`.
 */
export function verifyMergeTransition({
  authorization,
  completion,
  pull,
  mergeCommit,
  headCommit,
  checks,
  mergeTreeProof,
  now = () => new Date()
}) {
  const auth = authorization && typeof authorization === "object" ? authorization : null;
  const base = {
    verified: false,
    checked_at: now().toISOString(),
    task_comment_id: auth?.commentId ?? null,
    pr_number: auth?.prNumber ?? null,
    expected_base_sha: auth?.expectedBase ?? null,
    expected_head_sha: auth?.expectedHead ?? null,
    merge_commit_sha: null,
    merge_parents: [],
    // D-158: the merge commit's tree is now GATED again - but against the tree a
    // merge of the authorized base and head produces, not against the head's
    // tree. `head_tree_sha` stays EVIDENCE ONLY: it differs from the merge tree
    // for every correct merge of a branch that did not already contain its base.
    merge_tree_sha: null,
    head_tree_sha: null,
    // D-158: the recomputed-merge proof that replaced D-157's delta comparison.
    expected_merge_tree_sha: null,
    merge_tree_proof: null,
    report_comment_id: completion?.reportCommentId ?? null,
    report_status: completion?.status ?? null,
    check_runs: [],
    // D-146: the policy this verification was decided under, and which half of
    // the evidence rests on a bound claim rather than a re-observation. Recorded
    // on EVERY outcome, pass or refusal, so a record never has to be re-derived
    // to find out what it actually required.
    required_checks: auth?.policy?.requiredChecks ?? [],
    extra_checks_policy: auth?.policy?.extraChecksPolicy ?? null,
    evidence_profile: auth?.policy?.profile ?? null,
    policy_sources: auth?.policy?.sources ?? null,
    report_checked_fields: [],
    report_local_evidence_fields: [],
    detail: null
  };
  const refuse = (reason, detail = null, extra = {}) => ({ ...base, ...extra, reason, detail });

  // --- 1. authorization, from the trusted control comment only --------------
  if (!auth || auth.ok !== true) {
    return refuse(auth?.reason ?? MERGE_TRANSITION.NO_TRUSTED_TASK, auth?.detail ?? null);
  }

  // --- 2. the terminal report exists and claims success ---------------------
  //
  // The CHEAP half of the report gate. It establishes only that a trusted
  // terminal success claim was made at all - a claim that says BLOCKED or FAILED,
  // or that was never made, must not be accepted. The claim's CONTENT is bound
  // in step 7, after the remote truth it has to agree with has been established.
  if (completion?.complete !== true || completion?.successful !== true) {
    return refuse(MERGE_TRANSITION.REPORT_NOT_SUCCESSFUL,
      `complete=${completion?.complete ?? null}, successful=${completion?.successful ?? null}, `
      + `status=${JSON.stringify(completion?.status ?? null)}`);
  }

  // --- 3. the remote pull request ------------------------------------------
  if (!pull || pull.ok !== true || !pull.item) {
    return refuse(MERGE_TRANSITION.PULL_UNREADABLE, pull?.error ?? "not queried");
  }
  const pr = pull.item;
  if (Number(pr.number) !== auth.prNumber) {
    return refuse(MERGE_TRANSITION.PULL_NUMBER_MISMATCH,
      `the remote returned PR #${pr.number}, the authorization names #${auth.prNumber}`);
  }
  if (pr.merged !== true) {
    return refuse(MERGE_TRANSITION.NOT_MERGED, `the remote reports merged=${JSON.stringify(pr.merged ?? null)}`);
  }
  const mergeSha = fullSha(pr.mergeCommitSha);
  if (!mergeSha) {
    return refuse(MERGE_TRANSITION.MERGE_SHA_MISSING,
      `merge_commit_sha=${JSON.stringify(pr.mergeCommitSha ?? null)}`);
  }
  // The PR's head must be the head the architect approved. A PR that moved and
  // then merged did not merge the reviewed code.
  if (!sameSha(pr.headSha, auth.expectedHead)) {
    return refuse(MERGE_TRANSITION.PULL_HEAD_MISMATCH,
      `the remote PR head is ${JSON.stringify(pr.headSha ?? null)}, the authorization approved ${auth.expectedHead}`,
      { merge_commit_sha: mergeSha });
  }

  // --- 4. the merge commit's own structure ---------------------------------
  if (!mergeCommit || mergeCommit.ok !== true || !mergeCommit.item) {
    return refuse(MERGE_TRANSITION.MERGE_COMMIT_UNREADABLE, mergeCommit?.error ?? "not queried",
      { merge_commit_sha: mergeSha });
  }
  const mc = mergeCommit.item;
  if (!sameSha(mc.sha, mergeSha)) {
    return refuse(MERGE_TRANSITION.MERGE_COMMIT_IDENTITY_MISMATCH,
      `read back ${JSON.stringify(mc.sha ?? null)}, the PR names ${mergeSha}`, { merge_commit_sha: mergeSha });
  }
  const parents = (Array.isArray(mc.parents) ? mc.parents : []).map((p) => fullSha(p));
  const withParents = { merge_commit_sha: mergeSha, merge_parents: parents };

  // EXACTLY two. A squash merge produces one parent and a rebase merge produces
  // a linear chain of one-parent commits, so this single check refutes both -
  // structurally, without trusting anything that merely SAYS which method ran.
  if (parents.length !== 2 || parents.some((p) => p === null)) {
    return refuse(MERGE_TRANSITION.NOT_A_TWO_PARENT_MERGE,
      `the merge commit has ${parents.length} usable parent(s): ${JSON.stringify(mc.parents ?? null)} - a squash or `
      + "rebase merge produces exactly this shape and is never a normal merge", withParents);
  }
  if (parents[0] !== auth.expectedBase) {
    return refuse(MERGE_TRANSITION.FIRST_PARENT_MISMATCH,
      `parent 1 is ${parents[0]}, the authorized base is ${auth.expectedBase}`, withParents);
  }
  if (parents[1] !== auth.expectedHead) {
    return refuse(MERGE_TRANSITION.SECOND_PARENT_MISMATCH,
      `parent 2 is ${parents[1]}, the authorized head is ${auth.expectedHead}`, withParents);
  }

  // --- 5. THE MERGE ITSELF: recomputed, not merely resembled -----------------
  //
  // D-158 replaces D-157's projection comparison here, which had replaced D-145's
  // `merge tree === approved head tree`. Both predecessors asserted a resemblance
  // that was only true for the topology their fixtures had; this recomputes the
  // merge of the two authorized objects and requires the recorded merge to BE it.
  //
  // The approved head commit is still read, because it must be a real commit on
  // this remote and its identity must be the one the order names - but its TREE
  // is evidence in the record rather than a gate: it differs from the merge tree
  // for every correct merge of a branch that did not already contain its base.
  if (!headCommit || headCommit.ok !== true || !headCommit.item) {
    return refuse(MERGE_TRANSITION.HEAD_COMMIT_UNREADABLE, headCommit?.error ?? "not queried", withParents);
  }
  const mergeTree = String(mc.treeSha ?? "").trim().toLowerCase();
  const headTree = String(headCommit.item.treeSha ?? "").trim().toLowerCase();
  const withTrees = { ...withParents, merge_tree_sha: mergeTree || null, head_tree_sha: headTree || null };
  if (!sameSha(headCommit.item.sha, auth.expectedHead)) {
    return refuse(MERGE_TRANSITION.HEAD_COMMIT_UNREADABLE,
      `read back commit ${JSON.stringify(headCommit.item.sha ?? null)}, expected the approved head `
      + auth.expectedHead, withTrees);
  }

  // The API's own tree and parents for this commit are handed in as a CROSS-CHECK
  // against the real object, not as a substitute for it: the proof requires them
  // to agree, so a projection that has drifted from the object it describes is a
  // named refusal rather than the thing the gate quietly believed.
  const treeVerdict = verifyMergeTreeProof({
    computation: mergeTreeProof,
    mergeSha,
    expectedBase: auth.expectedBase,
    expectedHead: auth.expectedHead,
    projectedTree: mergeTree || null,
    projectedParents: parents
  });
  const withProof = {
    ...withTrees,
    expected_merge_tree_sha: treeVerdict.evidence?.expected_tree ?? null,
    merge_tree_proof: treeVerdict.evidence ?? null
  };
  if (!treeVerdict.ok) {
    return refuse(treeVerdict.reason, treeVerdict.detail, withProof);
  }

  // --- 6. the REQUIRED post-merge checks, by name --------------------------
  //
  // D-146: not "are the checks that exist green?" but "is every check trusted
  // policy REQUIRES present exactly once, finished, and success?". The two
  // questions differ exactly when a required check is absent, which is the case
  // the PR #81 review found passing.
  const checkVerdict = classifyPostMergeChecks(checks, auth.policy);
  const withChecks = { ...withProof, check_runs: checkVerdict.runs };
  if (!checkVerdict.ok) {
    return refuse(checkVerdict.reason, checkVerdict.detail, withChecks);
  }

  // --- 7. the BOUND terminal report ----------------------------------------
  //
  // Everything the report claims about the REMOTE is cross-checked against what
  // steps 3-6 just read from the remote; the report proves none of it on its own.
  // What the report DOES supply, and nothing else can, is the local half:
  // LOCAL_HEAD, ORIGIN_MAIN and WORKTREE_CLEAN. The child has exited by now and
  // its local state is gone, so those three rest on a bound claim - bound to this
  // exact comment, this exact task and this exact merge sha, and surfaced as
  // `report_local_evidence_fields` rather than folded in silently.
  const reportVerdict = verifyCloseoutReport({
    completion,
    policy: auth.policy,
    bindings: {
      taskId: auth.taskId,
      prNumber: auth.prNumber,
      expectedBase: auth.expectedBase,
      expectedHead: auth.expectedHead,
      mergeSha,
      parent1: parents[0],
      parent2: parents[1]
    },
    checkVerdict
  });
  const withReport = {
    ...withChecks,
    report_checked_fields: reportVerdict.checked_fields,
    report_local_evidence_fields: reportVerdict.local_evidence_fields
  };
  if (!reportVerdict.ok) {
    return refuse(reportVerdict.reason, reportVerdict.detail, withReport);
  }

  return {
    ...base,
    ...withReport,
    verified: true,
    reason: MERGE_TRANSITION.VERIFIED,
    detail: `PR #${auth.prNumber} is merged as ${mergeSha} with exactly two parents `
      + `(${parents[0]}, ${parents[1]}) matching the authorized base and head, its tree ${mergeTree} is exactly the `
      + `tree ${treeVerdict.evidence.expected_tree} that merging those two authorized commits produces (head tree `
      + `${headTree} - equal to the merge tree only when the head already contained its base, and not required to `
      + `be), the ${checkVerdict.required.length} REQUIRED post-merge check(s) `
      + `(${checkVerdict.required.join(", ")}) are each present exactly once on the merge commit and concluded `
      + `success, and trusted report ${reportVerdict.report_comment_id} is bound to this exact task, PR and merge `
      + `sha across ${reportVerdict.checked_fields.length} required field(s) - of which `
      + `${reportVerdict.local_evidence_fields.join(", ")} are the LOCAL half, provable only by the report`
  };
}

/**
 * THE NARROW BRIDGE. Does verified transition evidence account for EXACTLY the
 * commits this task's provenance verdict could not explain?
 *
 * This is the only place transition evidence is ever allowed to touch a
 * provenance verdict, and it is deliberately the strictest function in the
 * module: it does not say "the transition is fine, therefore the range is fine".
 * It says "the one thing the range could not explain IS the merge commit the
 * transition proved, and there is nothing else".
 *
 * Returns `{ excused, reason, detail, merge_commit_sha, excused_commits }`.
 */
export function mergeTransitionExcusesProvenance({ transition, provenance }) {
  const t = transition && typeof transition === "object" ? transition : null;
  const prov = provenance && typeof provenance === "object" ? provenance : null;
  const mergeSha = fullSha(t?.merge_commit_sha);
  const no = (reason, detail = null) => ({
    excused: false, reason, detail, merge_commit_sha: mergeSha, excused_commits: []
  });

  if (!t || t.verified !== true || !mergeSha) {
    return no(TRANSITION_EXCUSE.TRANSITION_NOT_VERIFIED, t?.reason ?? "no transition evidence");
  }
  // D-136 stands: absence of a classified range is absence of evidence. Without
  // one we cannot establish that the merge commit is the ONLY unexplained thing,
  // which is the entire basis on which this path accepts anything.
  if (!prov) return no(TRANSITION_EXCUSE.NO_PROVENANCE_RECORD);

  if (!CLASSIFIED_VERDICTS.includes(prov.verdict)) {
    return no(TRANSITION_EXCUSE.VERDICT_NOT_A_CLASSIFIED_RANGE,
      `verdict=${JSON.stringify(prov.verdict ?? null)} - only a range that was actually read and classified can be `
      + "compared against the merge commit");
  }
  // A capped range or a capped detail list means at least one sha was never
  // seen, and a sha we never saw cannot be checked against the merge sha.
  if (prov.range_truncated === true || prov.details_truncated === true || prov.error) {
    return no(TRANSITION_EXCUSE.EVIDENCE_INCOMPLETE,
      `range_truncated=${prov.range_truncated === true}, details_truncated=${prov.details_truncated === true}, `
      + `error=${JSON.stringify(prov.error ?? null)}`);
  }
  // An earlier attempt's finding that travelled into this record keeps it
  // unexplained: `reconciliationProvenanceForGate` carries forward commits that
  // are no longer reachable, and those are exactly the ones a later look is
  // blind to.
  if (prov.downgraded_by_recorded_verdict === true) {
    return no(TRANSITION_EXCUSE.MORE_THAN_THE_MERGE_COMMIT,
      `this record was downgraded by an earlier recorded verdict (${JSON.stringify(prov.recorded_verdict ?? null)}), `
      + "and a later look never unmakes an earlier finding");
  }

  const details = Array.isArray(prov.unattributed_commits) ? prov.unattributed_commits : [];
  const count = Number.isFinite(prov.unattributed_count) ? prov.unattributed_count : details.length;
  // The COUNT is the decision surface everywhere else in the provenance module,
  // and it is here too: a count that exceeds the detail list means commits we
  // cannot name, which is never excusable.
  if (count !== details.length) {
    return no(TRANSITION_EXCUSE.EVIDENCE_INCOMPLETE,
      `${count} unexplained commit(s) were counted but only ${details.length} can be named`);
  }
  if (count !== 1) {
    return no(TRANSITION_EXCUSE.MORE_THAN_THE_MERGE_COMMIT,
      `${count} unexplained commit(s); an authorized merge accounts for exactly one - the merge commit itself`);
  }
  const only = fullSha(details[0]?.sha);
  if (only === null || only !== mergeSha) {
    return no(TRANSITION_EXCUSE.MORE_THAN_THE_MERGE_COMMIT,
      `the unexplained commit is ${JSON.stringify(details[0]?.sha ?? null)}, which is not the verified merge commit `
      + mergeSha);
  }

  return {
    excused: true,
    reason: TRANSITION_EXCUSE.EXCUSED,
    detail: `the single commit this task's range could not attribute is ${mergeSha}, which is exactly the merge `
      + `commit GitHub generated for the authorized merge of PR #${t.pr_number}; Claude never authored it, so it `
      + "could not carry this task's attempt trailers, and the transition is proven independently instead",
    merge_commit_sha: mergeSha,
    excused_commits: [mergeSha]
  };
}

/** Human-readable lines for a status comment or log. */
export function describeMergeTransition(transition, excuse = null) {
  if (!transition) return [];
  const lines = [
    `AUTHORIZED MERGE TRANSITION: ${transition.verified ? "VERIFIED" : "NOT VERIFIED"} (${transition.reason})`,
    `  PR #${transition.pr_number ?? "unknown"}, authorized by trusted task comment `
      + `${transition.task_comment_id ?? "unknown"}`,
    `  authorized base -> head: ${transition.expected_base_sha ?? "unknown"} -> ${transition.expected_head_sha ?? "unknown"}`,
    `  merge commit: ${transition.merge_commit_sha ?? "none"}`
      + (transition.merge_parents?.length ? ` parents [${transition.merge_parents.join(", ")}]` : ""),
    // D-158: the HEAD tree is EVIDENCE, not a gate. Labelled so, because a reader
    // who remembers D-145's rule must not read a difference here as a finding.
    `  head tree (evidence only): ${transition.head_tree_sha ?? "unknown"}`
      + (transition.merge_tree_sha && transition.head_tree_sha
        && transition.merge_tree_sha !== transition.head_tree_sha
        ? " - differs from the merge tree, which is normal when the head did not already contain its base"
        : ""),
    ...describeMergeTreeProof(transition.merge_tree_proof),
    `  REQUIRED checks (${transition.policy_sources?.requiredChecks ?? "unresolved"}): `
      + `${transition.required_checks?.length ? transition.required_checks.join(", ") : "none declared"}`
      + `; extras: ${transition.extra_checks_policy ?? "unresolved"}`,
    transition.check_runs?.length
      ? `  post-merge checks: ${transition.check_runs.map((r) => `${r.name}=${r.conclusion ?? r.status}`).join(", ")}`
      : "  post-merge checks: none read",
    `  bound closeout report ${transition.report_comment_id ?? "none"} `
      + `(profile ${transition.evidence_profile ?? "unresolved"}): `
      + `${transition.report_checked_fields?.length ?? 0} field(s) verified`,
    // Named explicitly, every time. A reader must never have to work out for
    // themselves which part of this proof is a claim rather than an observation.
    transition.report_local_evidence_fields?.length
      ? `  LOCAL-ONLY evidence (provable only by the trusted report, not re-observable): `
        + transition.report_local_evidence_fields.join(", ")
      : "  LOCAL-ONLY evidence: none established",
    transition.detail ? `  ${transition.detail}` : ""
  ];
  if (excuse) {
    lines.push(`  EXCUSES THE COMMIT RANGE: ${excuse.excused ? "yes" : "no"} (${excuse.reason})`);
    if (excuse.detail) lines.push(`  ${excuse.detail}`);
  }
  return lines.filter((l) => l !== "");
}

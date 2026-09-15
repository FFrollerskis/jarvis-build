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
 *   4. the merge commit's TREE equals the approved head's tree - so the merge
 *      introduced no content that was never reviewed;
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
 * Everything in this module is PURE except the three thin remote reads its
 * caller performs. Every branch fails CLOSED with its own named reason, and no
 * branch can reach the filesystem, the repository, or a destructive action.
 */

import { extractField, validateTrustedTask } from "./trust.mjs";
import {
  POST_MERGE_EVIDENCE,
  classifyPostMergeChecks,
  resolvePostMergeEvidencePolicy,
  verifyCloseoutReport
} from "./postmerge-evidence.mjs";

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

  /** The authorized transition is proven from control-plane + fresh remote truth. */
  VERIFIED: "authorized_merge_transition_verified",

  /* --- authorization (trusted ARCHITECT_TASK comment only) --- */
  /** No trusted ARCHITECT_TASK for this exact task id was available at all. */
  NO_TRUSTED_TASK: "no_trusted_architect_task_comment_binds_this_task",
  /** The trusted task exists but does not authorize a merge. */
  NOT_MERGE_AUTHORIZED: "the_trusted_architect_task_does_not_authorize_a_merge",
  /** Merge-authorized, but without an exact PR number / base / head to check. */
  AUTHORIZATION_INCOMPLETE: "the_trusted_architect_task_does_not_declare_an_exact_pr_number_base_and_head",
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
  /** The approved head commit could not be read, so its tree is unknown. */
  HEAD_COMMIT_UNREADABLE: "the_approved_head_commit_could_not_be_read_from_the_remote",
  /** The merge tree differs from the approved head tree: unreviewed content. */
  TREE_MISMATCH: "the_merge_commit_tree_is_not_the_approved_head_tree_so_the_merge_introduced_unreviewed_content",

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
  const refuse = (reason, detail = null) => ({ ok: false, reason, detail });

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
    return refuse(MERGE_TRANSITION.NOT_MERGE_AUTHORIZED,
      `ARCHITECT_MERGE_APPROVED=${approved}, MERGE_AUTHORIZED=${authorized}`);
  }

  // The repository, when the task names one, must be the one this worker serves.
  const repo = extractField(body, "REPO");
  if (repo && repoOwner && repoName && repo.trim().toLowerCase() !== `${repoOwner}/${repoName}`.toLowerCase()) {
    return refuse(MERGE_TRANSITION.REPO_MISMATCH, `the task names REPO=${repo.trim()}`);
  }

  // An EXPLICIT method field, when present, must say `merge`. When absent, the
  // two-parent structural check below is what proves the method - and that check
  // is strictly stronger than any field, because a field is only a claim.
  const method = extractField(body, "MERGE_METHOD");
  if (method !== null && method.trim().toLowerCase() !== "merge") {
    return refuse(MERGE_TRANSITION.MERGE_METHOD_NOT_MERGE, `MERGE_METHOD=${method.trim()}`);
  }

  const prRaw = extractField(body, "PR_NUMBER");
  const prNumber = /^\d+$/.test(String(prRaw ?? "").trim()) ? Number(String(prRaw).trim()) : null;
  const expectedBase = fullSha(extractField(body, "EXPECTED_BASE_SHA"));
  const expectedHead = fullSha(extractField(body, "EXPECTED_HEAD_SHA"));
  if (prNumber === null || prNumber <= 0 || !expectedBase || !expectedHead) {
    return refuse(MERGE_TRANSITION.AUTHORIZATION_INCOMPLETE,
      `PR_NUMBER=${JSON.stringify(prRaw ?? null)}, EXPECTED_BASE_SHA=${JSON.stringify(expectedBase)}, `
      + `EXPECTED_HEAD_SHA=${JSON.stringify(expectedHead)}`);
  }
  // A merge of a commit onto itself is not a state transition; refusing it here
  // keeps every later comparison unambiguous.
  if (expectedBase === expectedHead) {
    return refuse(MERGE_TRANSITION.AUTHORIZATION_INCOMPLETE,
      "EXPECTED_BASE_SHA and EXPECTED_HEAD_SHA are the same commit");
  }

  // D-146: an authorized merge task that cannot produce a decidable post-merge
  // evidence policy is refused HERE, before a single remote call. "Not enough
  // policy to decide" is a decision, and the decision is no.
  const policy = resolvePostMergeEvidencePolicy({ declared: body, workerPolicy });
  if (!policy.ok) {
    return refuse(policy.reason, policy.detail);
  }

  return {
    ok: true,
    reason: null,
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
 * Find the merge authorization for one task among this run's control comments.
 *
 * Deliberately takes the FIRST trusted ARCHITECT_TASK for the id - the original
 * order - and never merges later comments into it. A `TASK_UPDATE` cannot grant
 * a merge authorization the original order did not carry.
 */
export function findMergeAuthorization(comments, {
  trustedAuthor,
  taskId,
  repoOwner = null,
  repoName = null,
  workerPolicy = null
}) {
  const list = Array.isArray(comments) ? comments : [];
  let lastRefusal = { ok: false, reason: MERGE_TRANSITION.NO_TRUSTED_TASK, detail: "no comment matched" };
  for (const comment of list) {
    const read = readMergeAuthorization(comment, { trustedAuthor, taskId, repoOwner, repoName, workerPolicy });
    if (read.ok) return read;
    // A comment that is not this task's order at all is not interesting; a
    // comment that IS this task's order but fails a rule is the real finding.
    if (read.reason !== MERGE_TRANSITION.NO_TRUSTED_TASK) lastRefusal = read;
  }
  return lastRefusal;
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
 */
export function verifyMergeTransition({
  authorization,
  completion,
  pull,
  mergeCommit,
  headCommit,
  checks,
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
    merge_tree_sha: null,
    head_tree_sha: null,
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

  // --- 5. the tree: no content the review never saw ------------------------
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
  if (!mergeTree || !headTree || mergeTree !== headTree) {
    return refuse(MERGE_TRANSITION.TREE_MISMATCH,
      `the merge commit tree is ${JSON.stringify(mergeTree || null)} and the approved head tree is `
      + `${JSON.stringify(headTree || null)}; a normal merge of an up-to-date branch reproduces the head tree `
      + "exactly, so a difference is content that was never reviewed", withTrees);
  }

  // --- 6. the REQUIRED post-merge checks, by name --------------------------
  //
  // D-146: not "are the checks that exist green?" but "is every check trusted
  // policy REQUIRES present exactly once, finished, and success?". The two
  // questions differ exactly when a required check is absent, which is the case
  // the PR #81 review found passing.
  const checkVerdict = classifyPostMergeChecks(checks, auth.policy);
  const withChecks = { ...withTrees, check_runs: checkVerdict.runs };
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
      + `(${parents[0]}, ${parents[1]}) matching the authorized base and head, its tree equals the approved head `
      + `tree ${headTree}, the ${checkVerdict.required.length} REQUIRED post-merge check(s) `
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
    `  trees: merge=${transition.merge_tree_sha ?? "unknown"} head=${transition.head_tree_sha ?? "unknown"}`,
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

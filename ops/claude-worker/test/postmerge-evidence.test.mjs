/**
 * D-146: REQUIRED POST-MERGE EVIDENCE - the adversarial suite.
 *
 * The independent exact-head review of PR #81 found two fail-open gaps in the
 * post-merge half of the D-145 proof, and both of them had the same shape: the
 * verifier accepted the ABSENCE of evidence as evidence.
 *
 *   - a merge commit with one unrelated green check passed while `build-test`
 *     had never run at all;
 *   - a terminal report that made no local-sync claim whatsoever passed, because
 *     only its STATUS was ever read.
 *
 * Every test below is built on D-144's REAL historical data - the real task id,
 * the real comment ids, the real shas from issue #68 and the repository - and
 * changes exactly one fact. The positive case is the last line of defence: it
 * must retire, and it must stop retiring the moment any single piece of the
 * required evidence is removed, duplicated, contradicted or unbound.
 */

import { describe, it, expect } from "vitest";

import {
  POST_MERGE_EVIDENCE,
  EXTRA_CHECK_POLICY,
  DEFAULT_REQUIRED_POST_MERGE_CHECKS,
  classifyPostMergeChecks,
  readAllFields,
  reportFieldForCheck,
  resolvePostMergeEvidencePolicy,
  verifyCloseoutReport
} from "../lib/postmerge-evidence.mjs";
import { MERGE_TRANSITION, findMergeAuthorization, verifyMergeTransition } from "../lib/merge-transition.mjs";
import { assessCompletion } from "../lib/reconcile.mjs";

const TRUSTED = "tsworkflow";
const TASK_ID = "D144-PR80-MERGE-CLOSEOUT-20260915-A";
const OTHER_TASK = "D143-HOST-RECOVERY-20260914-A";
const BASE = "c67a7ba792b8d655a26379655ffec31b353b7101";
const HEAD = "78202147ad32d694659f7138fd2784ef62f5f763";
const MERGE = "0c803bf1c1724413dc8e8071a7aabe7fd52562e4";
const TREE = "484facfcb7882fed7c0818172bacaaa43b71b9bb";
const OTHER = "1111111111111111111111111111111111111111";

const REPORT_ID = 5672081061;

/** ---------------- the D-144 fixture ---------------- */

function taskComment(extraFields = {}) {
  const fields = {
    TASK_ID,
    TASK_TYPE: "GUARDED_MERGE_AND_POSTMERGE_CLOSEOUT",
    REPO: "tsworkflow/jarvisbuild",
    PR_NUMBER: "80",
    EXPECTED_BASE_SHA: BASE,
    EXPECTED_HEAD_SHA: HEAD,
    ARCHITECT_MERGE_APPROVED: "true",
    MERGE_AUTHORIZED: "true",
    SELF_APPROVAL: "false",
    ...extraFields
  };
  return {
    id: 5671900015,
    created_at: "2026-09-14T22:52:00Z",
    updated_at: "2026-09-14T22:52:00Z",
    author_association: "OWNER",
    user: { login: TRUSTED },
    body: ["ARCHITECT_TASK",
      ...Object.entries(fields).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`),
      "", "Perform the routine, guarded closeout merge for PR #80."].join("\n")
  };
}

/**
 * D-144's real closeout report. `overrides` replaces a field; `null` DELETES it;
 * an array emits the field more than once, which is how the duplicate and
 * contradictory cases are produced without hand-writing a whole body each time.
 */
function reportBody(overrides = {}, { taskId = TASK_ID } = {}) {
  const fields = {
    TASK_ID: taskId,
    STATUS: "COMPLETE",
    REPO: "tsworkflow/jarvisbuild",
    PR_NUMBER: "80",
    EXPECTED_HEAD_SHA: HEAD,
    EXPECTED_BASE_SHA: BASE,
    MERGED: "true",
    MERGE_SHA: MERGE,
    PARENT_1: BASE,
    PARENT_2: HEAD,
    TWO_PARENT_MERGE_VERIFIED: "true",
    POST_MERGE_CI_RUN: "34906721592",
    POST_MERGE_BUILD_TEST: "success",
    POST_MERGE_WINDOWS_GIT_AUTH: "success",
    POST_MERGE_GITLEAKS: "success",
    LOCAL_HEAD: MERGE,
    ORIGIN_MAIN: MERGE,
    WORKTREE_CLEAN: "true",
    HOST_REDEPLOYED: "false",
    SELF_APPROVAL: "false",
    HARD_EXTERNAL_BLOCKER: "false",
    ...overrides
  };
  const lines = ["CLAUDE_REPORT"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) continue;
    for (const one of Array.isArray(value) ? value : [value]) lines.push(`${key}=${one}`);
  }
  lines.push("", "Routine guarded closeout merge executed.");
  return lines.join("\n");
}

const completion = (over = {}) => ({
  complete: true,
  successful: true,
  status: "COMPLETE",
  canonicalStatus: "COMPLETE",
  statusRecognised: true,
  reportCommentId: REPORT_ID,
  reportBody: reportBody(),
  ...over
});

const GREEN = [
  { name: "build-test", status: "completed", conclusion: "success" },
  { name: "windows-git-auth", status: "completed", conclusion: "success" },
  { name: "gitleaks", status: "completed", conclusion: "success" }
];

const checks = (runs = GREEN) => ({ ok: true, runs, error: null });
const pull = (over = {}) => ({
  ok: true,
  item: { number: 80, merged: true, mergeCommitSha: MERGE, headSha: HEAD, baseSha: BASE, state: "closed", ...over },
  error: null
});
const mergeCommit = (over = {}) => ({
  ok: true, item: { sha: MERGE, treeSha: TREE, parents: [BASE, HEAD], ...over }, error: null
});
const headCommit = () => ({ ok: true, item: { sha: HEAD, treeSha: TREE, parents: [BASE] }, error: null });

/**
 * D-158: the merge proof this gate now also requires.
 *
 * This file is about REQUIRED CHECK IDENTITY and the bound closeout report, so
 * the proof here is a constant, passing fixture: it must not be the reason any
 * case in this file passes or fails.
 */
const mergeTreeProof = () => ({
  attempted: true,
  ok: true,
  stage: "complete",
  error: null,
  store_path: `C:/worker/tmp/${TASK_ID}/merge-proof.git`,
  // D-159: and whose directory it ran in. See `merge-tree-proof.test.mjs` for
  // the cases that drive a foreign, unmarked or unstated owner.
  store_owned: true,
  store_owner_task_id: TASK_ID,
  fetched: false,
  fetch_error: null,
  missing_objects: [],
  // D-158 REVIEW-FIX: the conditions the merge was computed under are part of a
  // complete record; see `merge-tree-proof.test.mjs` for the cases that drive
  // each of them failing.
  config_isolated: true,
  foreign_config: [],
  custom_merge_drivers: [],
  attribute_files_scanned: 0,
  resolved_base: BASE,
  resolved_head: HEAD,
  resolved_merge: MERGE,
  expected_tree: TREE,
  conflicted: false,
  conflict_detail: null,
  merge_commit_tree: TREE,
  merge_commit_parents: [BASE, HEAD]
});

/** The whole gate, end to end, with exactly one fact changed. */
function verify(over = {}) {
  return verifyMergeTransition({
    authorization: over.authorization ?? findMergeAuthorization([over.comment ?? taskComment()], {
      trustedAuthor: TRUSTED, taskId: TASK_ID, repoOwner: "tsworkflow", repoName: "jarvisbuild",
      workerPolicy: over.workerPolicy ?? null
    }),
    completion: over.completion ?? completion(),
    pull: over.pull ?? pull(),
    mergeCommit: over.mergeCommit ?? mergeCommit(),
    headCommit: over.headCommit ?? headCommit(),
    checks: over.checks ?? checks(),
    mergeTreeProof: "mergeTreeProof" in over ? over.mergeTreeProof : mergeTreeProof()
  });
}

/* ==========================================================================
 * THE POSITIVE CASE
 * ========================================================================== */

describe("D-146: the D-144 fixture still retires - but now on REQUIRED evidence", () => {
  it("verifies, and records exactly what it required and what rests on a claim", () => {
    const t = verify();
    expect(t.verified).toBe(true);
    expect(t.reason).toBe(MERGE_TRANSITION.VERIFIED);
    expect(t.required_checks).toEqual(["build-test", "windows-git-auth", "gitleaks"]);
    expect(t.extra_checks_policy).toBe(EXTRA_CHECK_POLICY.MUST_NOT_FAIL);
    expect(t.evidence_profile).toBe("merge_closeout_v1");
    expect(t.report_comment_id).toBe(REPORT_ID);
    // The honesty requirement: the record names the fields that are a bound
    // CLAIM rather than a re-observation, and names ONLY those.
    expect(t.report_local_evidence_fields).toEqual(["LOCAL_HEAD", "ORIGIN_MAIN", "WORKTREE_CLEAN"]);
    expect(t.detail).toContain("LOCAL half");
  });

  it("the real merge commit's shape is what the exactly-once rule is calibrated to", () => {
    // GitHub's merge commit on `main` is built by ONE push-event workflow run, so
    // each required check appears exactly once - which is why "exactly once" is a
    // rule about post-merge reality and not an arbitrary tightening. (A PR HEAD
    // carries two of each, from the push and pull_request runs; this gate never
    // looks at a PR head.)
    expect(classifyPostMergeChecks(checks(), resolvePostMergeEvidencePolicy({})).ok).toBe(true);
  });
});

/* ==========================================================================
 * GAP 1 - REQUIRED CHECK IDENTITY, NOT "ANY GREEN CHECK"
 * ========================================================================== */

describe("D-146 gap 1: a green check is not a required check", () => {
  it("ONLY an unrelated green check: the exact fail-open the review found", () => {
    // Under D-145 this passed: one completed, successful check run existed, so
    // `classifyPostMergeChecks` said green. `build-test` had never run.
    const t = verify({ checks: checks([{ name: "some-other-job", status: "completed", conclusion: "success" }]) });
    expect(t.verified).toBe(false);
    expect(t.reason).toBe(MERGE_TRANSITION.CHECKS_REQUIRED_MISSING);
    expect(t.detail).toContain("build-test");
    expect(t.detail).toContain("never substitutes");
  });

  it("one required check missing while the others are green", () => {
    for (const missing of DEFAULT_REQUIRED_POST_MERGE_CHECKS) {
      const t = verify({ checks: checks(GREEN.filter((r) => r.name !== missing)) });
      expect(t.verified).toBe(false);
      expect(t.reason).toBe(MERGE_TRANSITION.CHECKS_REQUIRED_MISSING);
      expect(t.detail).toContain(missing);
    }
  });

  it("a DUPLICATE required name is ambiguous, and ambiguity is not a pass", () => {
    // Both copies are green. It is still refused: "which run is the required
    // check?" has no answer, and an unanswerable question is not answered yes.
    const t = verify({ checks: checks([...GREEN, { name: "build-test", status: "completed", conclusion: "success" }]) });
    expect(t.verified).toBe(false);
    expect(t.reason).toBe(MERGE_TRANSITION.CHECKS_REQUIRED_AMBIGUOUS);
    expect(t.detail).toContain("build-test");
  });

  it("a duplicate where one copy FAILED is refused too, not resolved in favour of the green one", () => {
    const t = verify({ checks: checks([...GREEN, { name: "gitleaks", status: "completed", conclusion: "failure" }]) });
    expect(t.verified).toBe(false);
    expect(t.reason).toBe(MERGE_TRANSITION.CHECKS_REQUIRED_AMBIGUOUS);
  });

  it("a required check that is neutral, skipped or cancelled is NOT success", () => {
    for (const conclusion of ["neutral", "skipped", "cancelled", "timed_out", "action_required", "stale", null]) {
      const t = verify({
        checks: checks(GREEN.map((r) => (r.name === "windows-git-auth" ? { ...r, conclusion } : r)))
      });
      expect(t.verified).toBe(false);
      expect(t.reason).toBe(MERGE_TRANSITION.CHECKS_REQUIRED_NOT_SUCCESS);
    }
  });

  it("a required check that has not finished is not green", () => {
    for (const status of ["in_progress", "queued", "pending", "waiting", ""]) {
      const t = verify({
        checks: checks(GREEN.map((r) => (r.name === "gitleaks" ? { ...r, status, conclusion: null } : r)))
      });
      expect(t.verified).toBe(false);
      expect(t.reason).toBe(MERGE_TRANSITION.CHECKS_REQUIRED_UNFINISHED);
    }
  });

  it("unreadable and empty check answers are still never green", () => {
    expect(verify({ checks: { ok: false, runs: [], error: "HTTP 403" } }).reason)
      .toBe(MERGE_TRANSITION.CHECKS_UNREADABLE);
    expect(verify({ checks: checks([]) }).reason).toBe(MERGE_TRANSITION.CHECKS_MISSING);
  });

  describe("the policy for checks OUTSIDE the required set is explicit and tested", () => {
    const extra = (conclusion) => checks([...GREEN, { name: "extra-job", status: "completed", conclusion }]);

    it("must_not_fail (the default): a passing extra is fine, a FAILED extra is not", () => {
      expect(verify({ checks: extra("success") }).verified).toBe(true);
      expect(verify({ checks: extra("neutral") }).verified).toBe(true);
      expect(verify({ checks: extra("skipped") }).verified).toBe(true);
      for (const bad of ["failure", "timed_out", "action_required", "cancelled", "stale"]) {
        const t = verify({ checks: extra(bad) });
        expect(t.verified).toBe(false);
        expect(t.reason).toBe(MERGE_TRANSITION.CHECKS_EXTRA_FAILED);
      }
    });

    it("must_not_fail tolerates an UNFINISHED extra: it is not a failure of anything required", () => {
      expect(verify({
        checks: checks([...GREEN, { name: "extra-job", status: "in_progress", conclusion: null }])
      }).verified).toBe(true);
    });

    it("ignore: extras are not consulted at all", () => {
      const comment = taskComment({ EXTRA_POST_MERGE_CHECKS: "ignore" });
      expect(verify({ comment, checks: extra("failure") }).verified).toBe(true);
    });

    it("forbid: no check outside the required set may exist", () => {
      const comment = taskComment({ EXTRA_POST_MERGE_CHECKS: "forbid" });
      expect(verify({ comment, checks: checks() }).verified).toBe(true);
      const t = verify({ comment, checks: extra("success") });
      expect(t.verified).toBe(false);
      expect(t.reason).toBe(MERGE_TRANSITION.CHECKS_EXTRA_FORBIDDEN);
    });

    it("NO extra-check policy can rescue a missing required check", () => {
      for (const policy of ["ignore", "must_not_fail", "forbid"]) {
        const t = verify({
          comment: taskComment({ EXTRA_POST_MERGE_CHECKS: policy }),
          checks: checks([{ name: "extra-job", status: "completed", conclusion: "success" }])
        });
        expect(t.verified).toBe(false);
        expect(t.reason).toBe(MERGE_TRANSITION.CHECKS_REQUIRED_MISSING);
      }
    });
  });
});

/* ==========================================================================
 * GAP 2 - THE BOUND CLOSEOUT REPORT
 * ========================================================================== */

describe("D-146 gap 2: the terminal report is BOUND, not merely counted", () => {
  it("a report with no body at all cannot be bound, and is refused", () => {
    // The D-145 shape exactly: a completion assessment that carried only a
    // verdict. There is nothing to bind, so there is nothing to accept.
    const t = verify({ completion: completion({ reportBody: undefined }) });
    expect(t.verified).toBe(false);
    expect(t.reason).toBe(MERGE_TRANSITION.REPORT_BODY_UNAVAILABLE);
  });

  it("a body that is not a CLAUDE_REPORT is refused", () => {
    const t = verify({ completion: completion({ reportBody: "ARCHITECT_TASK\nTASK_ID=" + TASK_ID }) });
    expect(t.verified).toBe(false);
    expect(t.reason).toBe(MERGE_TRANSITION.REPORT_NOT_A_CLAUDE_REPORT);
  });

  it("a body with no comment id behind it cannot name its own source", () => {
    const t = verify({ completion: completion({ reportCommentId: null }) });
    expect(t.verified).toBe(false);
    expect(t.reason).toBe(MERGE_TRANSITION.REPORT_NOT_IDENTIFIED);
  });

  describe("the LOCAL half - the only thing the report is allowed to prove alone", () => {
    it("omitting the local-sync evidence entirely is refused", () => {
      for (const field of ["LOCAL_HEAD", "ORIGIN_MAIN", "WORKTREE_CLEAN"]) {
        const t = verify({ completion: completion({ reportBody: reportBody({ [field]: null }) }) });
        expect(t.verified).toBe(false);
        expect(t.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_MISSING);
        expect(t.detail).toContain(field);
      }
    });

    it("LOCAL_HEAD pointing anywhere but the verified merge sha is refused", () => {
      for (const wrong of [HEAD, BASE, OTHER]) {
        const t = verify({ completion: completion({ reportBody: reportBody({ LOCAL_HEAD: wrong }) }) });
        expect(t.verified).toBe(false);
        expect(t.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_MISMATCH);
        expect(t.detail).toContain("LOCAL_HEAD");
      }
    });

    it("ORIGIN_MAIN still on the old base - the merge never reached the branch", () => {
      const t = verify({ completion: completion({ reportBody: reportBody({ ORIGIN_MAIN: BASE }) }) });
      expect(t.verified).toBe(false);
      expect(t.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_MISMATCH);
      expect(t.detail).toContain("ORIGIN_MAIN");
    });

    it("a DIRTY report is refused however green the remote is", () => {
      const t = verify({ completion: completion({ reportBody: reportBody({ WORKTREE_CLEAN: "false" }) }) });
      expect(t.verified).toBe(false);
      expect(t.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_MISMATCH);
      expect(t.detail).toContain("WORKTREE_CLEAN");
    });

    it("an EMPTY or evasive WORKTREE_CLEAN is not `true`", () => {
      for (const value of ["", "yes", "TRUE-ish", "1", "probably"]) {
        const t = verify({ completion: completion({ reportBody: reportBody({ WORKTREE_CLEAN: value }) }) });
        expect(t.verified).toBe(false);
      }
      // ...but the literal spelling, in any case, is accepted.
      expect(verify({ completion: completion({ reportBody: reportBody({ WORKTREE_CLEAN: "TRUE" }) }) }).verified)
        .toBe(true);
    });
  });

  describe("binding: the report must be THIS task's, about THIS merge", () => {
    it("a report borrowed from ANOTHER TASK is refused", () => {
      const t = verify({ completion: completion({ reportBody: reportBody({}, { taskId: OTHER_TASK }) }) });
      expect(t.verified).toBe(false);
      expect(t.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_MISMATCH);
      expect(t.detail).toContain("TASK_ID");
    });

    it("a report naming a DIFFERENT PR is refused", () => {
      const t = verify({ completion: completion({ reportBody: reportBody({ PR_NUMBER: "81" }) }) });
      expect(t.verified).toBe(false);
      expect(t.detail).toContain("PR_NUMBER");
    });

    it("a report whose MERGE_SHA is not the fresh remote merge sha is refused", () => {
      const t = verify({ completion: completion({ reportBody: reportBody({ MERGE_SHA: OTHER }) }) });
      expect(t.verified).toBe(false);
      expect(t.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_MISMATCH);
      expect(t.detail).toContain("MERGE_SHA");
    });

    it("a report claiming the wrong PARENTS is refused even though the REMOTE parents are right", () => {
      // The remote parents are verified separately and are correct. The report
      // disagreeing with them means the report is not about this merge.
      for (const [field, wrong] of [["PARENT_1", OTHER], ["PARENT_2", OTHER]]) {
        const t = verify({ completion: completion({ reportBody: reportBody({ [field]: wrong }) }) });
        expect(t.verified).toBe(false);
        expect(t.detail).toContain(field);
      }
    });

    it("a report bound to a different approved base/head is refused", () => {
      for (const field of ["EXPECTED_BASE_SHA", "EXPECTED_HEAD_SHA"]) {
        const t = verify({ completion: completion({ reportBody: reportBody({ [field]: OTHER }) }) });
        expect(t.verified).toBe(false);
        expect(t.detail).toContain(field);
      }
    });

    it("MERGED / TWO_PARENT_MERGE_VERIFIED must be literally true", () => {
      for (const field of ["MERGED", "TWO_PARENT_MERGE_VERIFIED"]) {
        expect(verify({ completion: completion({ reportBody: reportBody({ [field]: "false" }) }) }).verified)
          .toBe(false);
        expect(verify({ completion: completion({ reportBody: reportBody({ [field]: null }) }) }).verified)
          .toBe(false);
      }
    });

    it("SELF_APPROVAL=true and HARD_EXTERNAL_BLOCKER=true are refused", () => {
      expect(verify({ completion: completion({ reportBody: reportBody({ SELF_APPROVAL: "true" }) }) }).verified)
        .toBe(false);
      expect(verify({
        completion: completion({ reportBody: reportBody({ HARD_EXTERNAL_BLOCKER: "true" }) })
      }).verified).toBe(false);
    });

    it("POST_MERGE_CI_RUN must actually be there", () => {
      expect(verify({ completion: completion({ reportBody: reportBody({ POST_MERGE_CI_RUN: null }) }) }).reason)
        .toBe(MERGE_TRANSITION.REPORT_FIELD_MISSING);
      expect(verify({ completion: completion({ reportBody: reportBody({ POST_MERGE_CI_RUN: "" }) }) }).reason)
        .toBe(MERGE_TRANSITION.REPORT_FIELD_MISSING);
    });
  });

  describe("duplicate and contradictory fields", () => {
    it("CONTRADICTORY duplicates are refused - neither value wins", () => {
      const t = verify({
        completion: completion({ reportBody: reportBody({ WORKTREE_CLEAN: ["false", "true"] }) })
      });
      expect(t.verified).toBe(false);
      expect(t.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_DUPLICATE);
      expect(t.detail).toContain("WORKTREE_CLEAN");
    });

    it("the reverse order is refused identically: no first-wins, no last-wins", () => {
      const t = verify({
        completion: completion({ reportBody: reportBody({ WORKTREE_CLEAN: ["true", "false"] }) })
      });
      expect(t.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_DUPLICATE);
    });

    it("an AGREEING duplicate is refused too: ambiguity, not disagreement, is the finding", () => {
      const t = verify({ completion: completion({ reportBody: reportBody({ MERGE_SHA: [MERGE, MERGE] }) }) });
      expect(t.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_DUPLICATE);
    });

    it("a field appended LATE in the prose cannot override the header block", () => {
      const body = reportBody() + "\n\nLater notes:\nWORKTREE_CLEAN=false\n";
      const t = verify({ completion: completion({ reportBody: body }) });
      expect(t.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_DUPLICATE);
    });
  });

  describe("the report vs the fresh remote: disagreement fails closed", () => {
    it("the report claims a required check FAILED while the remote says success", () => {
      const t = verify({ completion: completion({ reportBody: reportBody({ POST_MERGE_BUILD_TEST: "failure" }) }) });
      expect(t.verified).toBe(false);
      expect(t.reason).toBe(MERGE_TRANSITION.REPORT_CI_CONTRADICTS_REMOTE);
      expect(t.detail).toContain("build-test");
    });

    it("the report omits a required check's result entirely", () => {
      const t = verify({ completion: completion({ reportBody: reportBody({ POST_MERGE_GITLEAKS: null }) }) });
      expect(t.verified).toBe(false);
      expect(t.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_MISSING);
      expect(t.detail).toContain("POST_MERGE_GITLEAKS");
    });

    it("the remote being RED beats a report claiming green - and is reported as the CHECK failure", () => {
      // Ordering matters: the remote is the authority on CI, so the refusal names
      // the failed required check rather than blaming the report for disagreeing.
      const t = verify({
        checks: checks(GREEN.map((r) => (r.name === "build-test" ? { ...r, conclusion: "failure" } : r)))
      });
      expect(t.reason).toBe(MERGE_TRANSITION.CHECKS_REQUIRED_NOT_SUCCESS);
    });

    it("a required check declared by the task requires its OWN report field", () => {
      const comment = taskComment({ REQUIRED_POST_MERGE_CHECKS: "build-test,e2e smoke" });
      const runs = [
        { name: "build-test", status: "completed", conclusion: "success" },
        { name: "e2e smoke", status: "completed", conclusion: "success" }
      ];
      // The report says nothing about `e2e smoke`, so it cannot be cross-checked.
      const missing = verify({ comment, checks: checks(runs) });
      expect(missing.verified).toBe(false);
      expect(missing.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_MISSING);
      expect(missing.detail).toContain("POST_MERGE_E2E_SMOKE");

      const ok = verify({
        comment,
        checks: checks(runs),
        completion: completion({ reportBody: reportBody({ POST_MERGE_E2E_SMOKE: "success" }) })
      });
      expect(ok.verified).toBe(true);
    });
  });
});

/* ==========================================================================
 * THE SCHEMA, AND FAILING CLOSED WHEN POLICY IS TOO THIN
 * ========================================================================== */

describe("D-146 schema: future trusted merge tasks can declare their own policy", () => {
  it("resolution order is task -> worker config -> repository default, and it is recorded", () => {
    expect(resolvePostMergeEvidencePolicy({}).sources.requiredChecks).toBe("repository_default");
    expect(resolvePostMergeEvidencePolicy({}).requiredChecks).toEqual([...DEFAULT_REQUIRED_POST_MERGE_CHECKS]);

    const fromConfig = resolvePostMergeEvidencePolicy({ workerPolicy: { requiredChecks: ["only-this"] } });
    expect(fromConfig.requiredChecks).toEqual(["only-this"]);
    expect(fromConfig.sources.requiredChecks).toBe("worker_config");

    const fromTask = resolvePostMergeEvidencePolicy({
      declared: "REQUIRED_POST_MERGE_CHECKS=a,b",
      workerPolicy: { requiredChecks: ["only-this"] }
    });
    expect(fromTask.requiredChecks).toEqual(["a", "b"]);
    expect(fromTask.sources.requiredChecks).toBe("trusted_architect_task");
  });

  it("a task declaring an EMPTY required set fails CLOSED - it is not a bypass", () => {
    const p = resolvePostMergeEvidencePolicy({ declared: "REQUIRED_POST_MERGE_CHECKS=" });
    expect(p.ok).toBe(false);
    expect(p.reason).toBe(POST_MERGE_EVIDENCE.POLICY_NO_REQUIRED_CHECKS);

    // ...and it stops the whole authorization, before any remote call is made.
    const t = verify({ comment: taskComment({ REQUIRED_POST_MERGE_CHECKS: "" }) });
    expect(t.verified).toBe(false);
    expect(t.reason).toBe(MERGE_TRANSITION.POLICY_NO_REQUIRED_CHECKS);
  });

  it("a worker config declaring an empty required set fails closed too", () => {
    const t = verify({ workerPolicy: { requiredChecks: [] } });
    expect(t.verified).toBe(false);
    expect(t.reason).toBe(MERGE_TRANSITION.POLICY_NO_REQUIRED_CHECKS);
  });

  it("a duplicated required check name in the DECLARATION is refused", () => {
    const p = resolvePostMergeEvidencePolicy({ declared: "REQUIRED_POST_MERGE_CHECKS=a,b,a" });
    expect(p.ok).toBe(false);
    expect(p.reason).toBe(POST_MERGE_EVIDENCE.POLICY_DUPLICATE_REQUIRED_CHECK);
  });

  it("two check names collapsing onto the SAME report field is refused", () => {
    // `a-b` and `a_b` both map to POST_MERGE_A_B; one of them would be silently
    // unverifiable in the report, so neither is accepted.
    const p = resolvePostMergeEvidencePolicy({ declared: "REQUIRED_POST_MERGE_CHECKS=a-b,a_b" });
    expect(p.ok).toBe(false);
    expect(p.reason).toBe(POST_MERGE_EVIDENCE.POLICY_DUPLICATE_REQUIRED_CHECK);
  });

  it("a policy key declared TWICE in the trusted order is ambiguous and refused", () => {
    const p = resolvePostMergeEvidencePolicy({
      declared: "REQUIRED_POST_MERGE_CHECKS=a\nREQUIRED_POST_MERGE_CHECKS=b"
    });
    expect(p.ok).toBe(false);
  });

  it("an unknown extra-checks policy or profile is refused, never defaulted", () => {
    expect(resolvePostMergeEvidencePolicy({ declared: "EXTRA_POST_MERGE_CHECKS=whatever" }).reason)
      .toBe(POST_MERGE_EVIDENCE.POLICY_EXTRA_CHECKS_UNKNOWN);
    expect(resolvePostMergeEvidencePolicy({ declared: "POST_MERGE_EVIDENCE_PROFILE=none" }).reason)
      .toBe(POST_MERGE_EVIDENCE.POLICY_PROFILE_UNKNOWN);
    // There is deliberately no "none" profile: a switch that turns the report
    // gate off would reopen exactly the gap this change closes.
    expect(resolvePostMergeEvidencePolicy({ declared: "POST_MERGE_EVIDENCE_PROFILE=off" }).ok).toBe(false);
  });

  it("REQUIRED_CLOSEOUT_FIELDS adds fields, and a malformed entry is refused", () => {
    const ok = resolvePostMergeEvidencePolicy({ declared: "REQUIRED_CLOSEOUT_FIELDS=HOST_REDEPLOYED:literal_false" });
    expect(ok.ok).toBe(true);
    expect(ok.closeoutFields.some((f) => f.key === "HOST_REDEPLOYED")).toBe(true);

    for (const bad of [
      "REQUIRED_CLOSEOUT_FIELDS=NOPE",
      "REQUIRED_CLOSEOUT_FIELDS=NOPE:invented_rule",
      "REQUIRED_CLOSEOUT_FIELDS=NOPE:equals_sha",
      "REQUIRED_CLOSEOUT_FIELDS=NOPE:equals_sha:notABinding",
      "REQUIRED_CLOSEOUT_FIELDS=NOPE:literal_true:mergeSha",
      "REQUIRED_CLOSEOUT_FIELDS=NOPE:equals_remote_check_conclusion"
    ]) {
      const p = resolvePostMergeEvidencePolicy({ declared: bad });
      expect(p.ok).toBe(false);
      expect(p.reason).toBe(POST_MERGE_EVIDENCE.POLICY_CLOSEOUT_FIELD_MALFORMED);
    }
  });

  it("a declared extra field is actually ENFORCED end to end", () => {
    const comment = taskComment({ REQUIRED_CLOSEOUT_FIELDS: "HOST_REDEPLOYED:literal_false" });
    expect(verify({ comment }).verified).toBe(true);
    const t = verify({ comment, completion: completion({ reportBody: reportBody({ HOST_REDEPLOYED: "true" }) }) });
    expect(t.verified).toBe(false);
    expect(t.detail).toContain("HOST_REDEPLOYED");
  });

  it("a declared field may not WEAKEN one the profile already requires", () => {
    // `WORKTREE_CLEAN:present` would be satisfied by `false`. The profile's
    // stricter `literal_true` must survive the declaration.
    const comment = taskComment({ REQUIRED_CLOSEOUT_FIELDS: "WORKTREE_CLEAN:present" });
    const t = verify({ comment, completion: completion({ reportBody: reportBody({ WORKTREE_CLEAN: "false" }) }) });
    expect(t.verified).toBe(false);
    expect(t.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_MISMATCH);
  });

  it("the check-name to report-field mapping is deterministic and general", () => {
    expect(reportFieldForCheck("build-test")).toBe("POST_MERGE_BUILD_TEST");
    expect(reportFieldForCheck("windows-git-auth")).toBe("POST_MERGE_WINDOWS_GIT_AUTH");
    expect(reportFieldForCheck("gitleaks")).toBe("POST_MERGE_GITLEAKS");
    expect(reportFieldForCheck("CodeQL / analyze (js)")).toBe("POST_MERGE_CODEQL_ANALYZE_JS");
    expect(reportFieldForCheck("   ")).toBeNull();
  });
});

/* ==========================================================================
 * THE FIELD READER ITSELF
 * ========================================================================== */

describe("D-146: readAllFields keeps every occurrence and cannot be fooled by prose", () => {
  it("returns ALL occurrences, not the first and not the last", () => {
    const fields = readAllFields("A=1\nB=2\nA=3");
    expect(fields.get("A")).toEqual(["1", "3"]);
    expect(fields.get("B")).toEqual(["2"]);
  });

  it("an indented, quoted or fenced line is not a field", () => {
    const fields = readAllFields([
      "WORKTREE_CLEAN=true",
      "  WORKTREE_CLEAN=false",
      "`WORKTREE_CLEAN=false`",
      "> WORKTREE_CLEAN=false",
      "see WORKTREE_CLEAN=false above"
    ].join("\n"));
    expect(fields.get("WORKTREE_CLEAN")).toEqual(["true"]);
  });

  it("the real D-144 report's prose tail does not manufacture a duplicate", () => {
    // The real report quotes `MERGE_SHA=...` inside backticks and prints two
    // `parent <sha>` lines in a fenced block. Neither may register as a field.
    const body = reportBody() + [
      "",
      "## Merge",
      "",
      "`MERGE_SHA=0c803bf1c1724413dc8e8071a7aabe7fd52562e4`, merged by `tsworkflow`.",
      "",
      "```",
      `parent ${BASE}   <- previous main / EXPECTED_BASE_SHA`,
      `parent ${HEAD}   <- EXPECTED_HEAD_SHA`,
      "```"
    ].join("\n");
    expect(readAllFields(body).get("MERGE_SHA")).toEqual([MERGE]);
    expect(verify({ completion: completion({ reportBody: body }) }).verified).toBe(true);
  });
});

/* ==========================================================================
 * THE CARRIER: assessCompletion binds body TO comment id
 * ========================================================================== */

describe("D-146: the report body and its comment id travel together, always", () => {
  const reportComment = (over = {}) => ({
    id: REPORT_ID,
    created_at: "2026-09-14T23:10:00Z",
    updated_at: "2026-09-14T23:10:00Z",
    author_association: "OWNER",
    user: { login: TRUSTED },
    body: reportBody(),
    ...over
  });

  it("a successful assessment carries the EXACT body of the comment it names", () => {
    const res = assessCompletion({ taskId: TASK_ID, comments: [reportComment()], trustedAuthor: TRUSTED });
    expect(res.complete).toBe(true);
    expect(res.reportCommentId).toBe(REPORT_ID);
    expect(res.reportBody).toBe(reportBody());
  });

  it("a report for ANOTHER task is never selected, so its body can never be borrowed", () => {
    const foreign = reportComment({ id: 999, body: reportBody({}, { taskId: OTHER_TASK }) });
    const res = assessCompletion({ taskId: TASK_ID, comments: [foreign], trustedAuthor: TRUSTED });
    expect(res.complete).toBe(false);
    expect(res.reportBody).toBeNull();
  });

  it("an UNTRUSTED author's report is never selected", () => {
    const res = assessCompletion({
      taskId: TASK_ID,
      comments: [reportComment({ user: { login: "someone-else" } })],
      trustedAuthor: TRUSTED
    });
    expect(res.complete).toBe(false);
    expect(res.reportBody).toBeNull();
  });

  it("end to end: the carried body is what the gate binds", () => {
    const res = assessCompletion({ taskId: TASK_ID, comments: [reportComment()], trustedAuthor: TRUSTED });
    expect(verify({ completion: res }).verified).toBe(true);

    const dirty = assessCompletion({
      taskId: TASK_ID,
      comments: [reportComment({ body: reportBody({ WORKTREE_CLEAN: "false" }) })],
      trustedAuthor: TRUSTED
    });
    expect(dirty.complete).toBe(true);        // the CLAIM is still terminal+successful
    expect(verify({ completion: dirty }).verified).toBe(false);  // ...and still refused
  });
});

/* ==========================================================================
 * verifyCloseoutReport IN ISOLATION
 * ========================================================================== */

describe("D-146: verifyCloseoutReport refuses without a policy, and never half-passes", () => {
  const bindings = {
    taskId: TASK_ID, prNumber: 80, expectedBase: BASE, expectedHead: HEAD,
    mergeSha: MERGE, parent1: BASE, parent2: HEAD
  };
  const policy = resolvePostMergeEvidencePolicy({});
  const checkVerdict = classifyPostMergeChecks(checks(), policy);

  it("passes on the real fixture and names the local-only fields", () => {
    const v = verifyCloseoutReport({ completion: completion(), policy, bindings, checkVerdict });
    expect(v.ok).toBe(true);
    expect(v.local_evidence_fields).toEqual(["LOCAL_HEAD", "ORIGIN_MAIN", "WORKTREE_CLEAN"]);
    expect(v.checked_fields).toContain("MERGE_SHA");
    expect(v.checked_fields).toContain("POST_MERGE_BUILD_TEST");
  });

  it("refuses when no policy was resolved at all", () => {
    const v = verifyCloseoutReport({ completion: completion(), policy: null, bindings, checkVerdict });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(POST_MERGE_EVIDENCE.POLICY_NO_REQUIRED_CHECKS);
  });

  it("a binding the caller failed to supply is a MISMATCH, never a skipped field", () => {
    const v = verifyCloseoutReport({
      completion: completion(), policy, bindings: { ...bindings, mergeSha: null }, checkVerdict
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(POST_MERGE_EVIDENCE.REPORT_FIELD_MISMATCH);
  });

  it("a STATUS that is terminal but NOT successful is refused", () => {
    for (const status of ["BLOCKED", "FAILED", "IN_PROGRESS", "WEIRD_SPELLING"]) {
      const v = verifyCloseoutReport({
        completion: completion({ reportBody: reportBody({ STATUS: status }) }), policy, bindings, checkVerdict
      });
      expect(v.ok).toBe(false);
      expect(v.reason).toBe(POST_MERGE_EVIDENCE.REPORT_FIELD_MISMATCH);
    }
  });
});

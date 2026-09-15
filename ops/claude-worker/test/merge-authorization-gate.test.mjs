/**
 * D-147: THE MERGE AUTHORIZATION IS CLASSIFIED INDEPENDENTLY OF PROVENANCE.
 *
 * ------------------------------------------------------------------------
 * THE BYPASS THESE RULES CLOSE
 * ------------------------------------------------------------------------
 *
 * D-145 and D-146 built a complete proof of an authorized merge - exact PR, exact
 * two-parent structure, tree equality, required check identity, a bound closeout
 * report - and then reached it only as a FALLBACK, when the generic commit-range
 * question had already come back unproven.
 *
 * So the whole proof was skippable, and skipping it took no attack at all. Give
 * the SAME trusted merge order a child that correctly trailers one ordinary commit
 * - or one that never moves HEAD - and the range is `task_attributed` or
 * `unchanged`. Proven. The fallback condition is false, nothing is read from the
 * remote, and the task retires as `commit_provenance_verified` having established
 * only that Claude wrote its own commits. That was never what a merge task was
 * for: its deliverable is a state transition on the REMOTE, which Claude does not
 * author and cannot trailer, so commit authorship is not evidence about it at all.
 *
 * These tests fix the two halves of the repair as rules:
 *
 *   1. `classifyMergeAuthorization` decides "is this a merge task?" from this
 *      task's own trusted order and NOTHING else - no provenance verdict is an
 *      input, and there is no code path by which one could be.
 *   2. `evaluateCompletionGate` makes the transition MANDATORY for a
 *      merge-authorized task, and `PASSED_PROVENANCE_VERIFIED` unreachable for it.
 *
 * The process-level wiring - that the real worker actually reaches these rules
 * through every completion path - is `worker-merge-gate.test.mjs`. A rule nothing
 * calls is not a gate, and a gate with no rule behind it is not a proof.
 */

import { describe, it, expect } from "vitest";

import {
  MERGE_AUTHORIZATION,
  MERGE_TRANSITION,
  TRANSITION_EXCUSE,
  classifyMergeAuthorization
} from "../lib/merge-transition.mjs";
import {
  COMMIT_PROVENANCE,
  COMPLETION_GATE,
  describeCompletionGate,
  evaluateCompletionGate
} from "../lib/provenance.mjs";

const TRUSTED = "tsworkflow";
const TASK_ID = "D147-PR81-MERGE-GATE-NO-PROVENANCE-BYPASS-20260915-A";
const BASE = "0c803bf1c1724413dc8e8071a7aabe7fd52562e4";
const HEAD = "b613ff18af7e7d3d65c3641ab47f91750f9e6e79";
const MERGE = "2222222222222222222222222222222222222222";

const OPTS = Object.freeze({
  trustedAuthor: TRUSTED,
  taskId: TASK_ID,
  repoOwner: "tsworkflow",
  repoName: "jarvisbuild"
});

/** A trusted, owner-posted ARCHITECT_TASK for THIS task id. */
function order(fields = {}, { author = TRUSTED, header = "ARCHITECT_TASK", taskId = TASK_ID } = {}) {
  const all = {
    TASK_ID: taskId,
    REPO: "tsworkflow/jarvisbuild",
    PR_NUMBER: "81",
    EXPECTED_BASE_SHA: BASE,
    EXPECTED_HEAD_SHA: HEAD,
    ARCHITECT_MERGE_APPROVED: "true",
    MERGE_AUTHORIZED: "true",
    ...fields
  };
  return {
    id: 5673481484,
    created_at: "2026-09-15T01:54:17Z",
    updated_at: "2026-09-15T01:54:17Z",
    author_association: "OWNER",
    user: { login: author },
    body: [header, ...Object.entries(all).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`)].join("\n")
  };
}

/* ==========================================================================
 * 1. CLASSIFICATION: three answers, and none of them looks at a commit range
 * ========================================================================== */

describe("D-147: classifyMergeAuthorization decides merge-ness from the trusted order alone", () => {
  it("AUTHORIZED for a complete, well-formed merge order", () => {
    const c = classifyMergeAuthorization([order()], OPTS);
    expect(c.claim).toBe(MERGE_AUTHORIZATION.AUTHORIZED);
    expect(c.claimed).toBe(true);
    expect(c.decidable).toBe(true);
    expect(c.authorization.ok).toBe(true);
    expect(c.authorization.prNumber).toBe(81);
    expect(c.authorization.expectedBase).toBe(BASE);
    expect(c.authorization.expectedHead).toBe(HEAD);
  });

  it("NONE for an ordinary implementation order - the cheap path is unchanged", () => {
    // This task's OWN order, in fact: ARCHITECT_MERGE_APPROVED=false and
    // MERGE_AUTHORIZED=false. Nothing extra may ever be required of it.
    const c = classifyMergeAuthorization(
      [order({ ARCHITECT_MERGE_APPROVED: "false", MERGE_AUTHORIZED: "false" })], OPTS);
    expect(c.claim).toBe(MERGE_AUTHORIZATION.NONE);
    expect(c.claimed).toBe(false);
    expect(c.decidable).toBe(true);
  });

  it("NONE when no trusted order for this task exists at all", () => {
    expect(classifyMergeAuthorization([], OPTS).claim).toBe(MERGE_AUTHORIZATION.NONE);
    expect(classifyMergeAuthorization([order({}, { taskId: "SOME-OTHER-TASK" })], OPTS).claim)
      .toBe(MERGE_AUTHORIZATION.NONE);
  });

  it("NONE for an untrusted author, however perfect the merge order looks", () => {
    // An attacker-posted, fully-formed merge authorization must not even register
    // as a CLAIM - registering it would let anyone force a task to fail closed.
    const c = classifyMergeAuthorization([order({}, { author: "someone-else" })], OPTS);
    expect(c.claim).toBe(MERGE_AUTHORIZATION.NONE);
    expect(c.claimed).toBe(false);
  });

  it("NONE for a body that is not an ARCHITECT_TASK header", () => {
    expect(classifyMergeAuthorization([order({}, { header: "CLAUDE_REPORT" })], OPTS).claim)
      .toBe(MERGE_AUTHORIZATION.NONE);
  });

  for (const [approved, authorized] of [["true", "false"], ["false", "true"], ["true", null], [null, "true"]]) {
    it(`UNDECIDABLE for half a merge authorization (approved=${approved}, authorized=${authorized})`, () => {
      // The subtlest case in the file. Before D-147 this produced the same
      // finding as "no merge claimed", so it took the cheap path and a verified
      // commit range retired it with no transition proof whatsoever.
      const c = classifyMergeAuthorization(
        [order({ ARCHITECT_MERGE_APPROVED: approved, MERGE_AUTHORIZED: authorized })], OPTS);
      expect(c.claim).toBe(MERGE_AUTHORIZATION.UNDECIDABLE);
      expect(c.claimed).toBe(true);
      expect(c.decidable).toBe(false);
      expect(c.reason).toBe(MERGE_TRANSITION.MERGE_AUTHORIZATION_PARTIAL);
    });
  }

  for (const missing of ["PR_NUMBER", "EXPECTED_BASE_SHA", "EXPECTED_HEAD_SHA"]) {
    it(`UNDECIDABLE for a merge order with no ${missing}`, () => {
      const c = classifyMergeAuthorization([order({ [missing]: null })], OPTS);
      expect(c.claim).toBe(MERGE_AUTHORIZATION.UNDECIDABLE);
      expect(c.reason).toBe(MERGE_TRANSITION.AUTHORIZATION_INCOMPLETE);
    });
  }

  it("UNDECIDABLE for a merge order whose required-check set resolves to nothing", () => {
    const c = classifyMergeAuthorization([order({ REQUIRED_POST_MERGE_CHECKS: "" })], OPTS);
    expect(c.claim).toBe(MERGE_AUTHORIZATION.UNDECIDABLE);
    expect(c.reason).toBe(MERGE_TRANSITION.POLICY_NO_REQUIRED_CHECKS);
  });

  it("UNDECIDABLE for a merge order naming a method that is not a normal merge", () => {
    const c = classifyMergeAuthorization([order({ MERGE_METHOD: "squash" })], OPTS);
    expect(c.claim).toBe(MERGE_AUTHORIZATION.UNDECIDABLE);
    expect(c.reason).toBe(MERGE_TRANSITION.MERGE_METHOD_NOT_MERGE);
  });

  it("UNDECIDABLE for a merge order naming a different repository", () => {
    const c = classifyMergeAuthorization([order({ REPO: "someone/else" })], OPTS);
    expect(c.claim).toBe(MERGE_AUTHORIZATION.UNDECIDABLE);
    expect(c.reason).toBe(MERGE_TRANSITION.REPO_MISMATCH);
  });

  it("a well-formed authorization wins over a broken comment for the same task", () => {
    // Order independence in the SAFE direction only: a usable authorization is
    // used, and a broken one alongside it does not veto it. The reverse - a
    // broken order silently downgrading to "not a merge task" - is what D-147
    // forbids, and every UNDECIDABLE case above asserts it.
    const broken = order({ EXPECTED_HEAD_SHA: null });
    expect(classifyMergeAuthorization([broken, order()], OPTS).claim).toBe(MERGE_AUTHORIZATION.AUTHORIZED);
    expect(classifyMergeAuthorization([order(), broken], OPTS).claim).toBe(MERGE_AUTHORIZATION.AUTHORIZED);
  });
});

/* ==========================================================================
 * 2. THE GATE: the transition is a REQUIREMENT, not a fallback
 * ========================================================================== */

describe("D-147: a merge-authorized task can never retire on commit provenance alone", () => {
  const completion = Object.freeze({
    complete: true, successful: true, status: "COMPLETE", canonicalStatus: "COMPLETE", reportCommentId: 900001
  });
  const clean = Object.freeze({ verdict: "clean", path: "C:/w/task", entry_count: 0, entries: [], error: null });

  /** A range that really was read and really does verify. Nothing here is faked. */
  const verifiedProvenance = Object.freeze({
    verdict: COMMIT_PROVENANCE.ATTRIBUTED,
    verified: true,
    attributed_count: 1,
    unattributed_count: 0,
    unattributed_commits: [],
    reason: "every commit in the range carries this task's own attempt trailers"
  });

  const unverifiedProvenance = Object.freeze({
    verdict: COMMIT_PROVENANCE.UNATTRIBUTED,
    verified: false,
    attributed_count: 0,
    unattributed_count: 1,
    unattributed_commits: [{ sha: MERGE }],
    reason: "nothing in the range is bound to this task"
  });

  const authorized = Object.freeze({ claim: MERGE_AUTHORIZATION.AUTHORIZED, claimed: true, decidable: true });
  const undecidable = Object.freeze({
    claim: MERGE_AUTHORIZATION.UNDECIDABLE,
    claimed: true,
    decidable: false,
    reason: MERGE_TRANSITION.MERGE_AUTHORIZATION_PARTIAL
  });
  const notAMerge = Object.freeze({ claim: MERGE_AUTHORIZATION.NONE, claimed: false, decidable: true });

  const verifiedTransition = Object.freeze({
    verified: true, reason: MERGE_TRANSITION.VERIFIED, pr_number: 81, merge_commit_sha: MERGE
  });
  const excused = Object.freeze({
    excused: true, reason: TRANSITION_EXCUSE.EXCUSED, merge_commit_sha: MERGE, excused_commits: [MERGE]
  });

  it("THE BYPASS: verified provenance + no transition proof is HELD", () => {
    // Exactly the shape D-145/D-146 accepted: a merge-authorized task whose child
    // trailered its own commits perfectly and proved nothing about the remote.
    const gate = evaluateCompletionGate({
      completion,
      provenance: verifiedProvenance,
      worktree: clean,
      mergeAuthorization: authorized,
      mergeTransition: { verified: false, reason: MERGE_TRANSITION.NOT_MERGED },
      transitionExcuse: null
    });
    expect(gate.held).toBe(true);
    expect(gate.passed).toBe(false);
    expect(gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_TRANSITION_UNVERIFIED);
    // ...and the record says plainly that the range DID verify, so nobody reading
    // it later mistakes this for a provenance failure.
    expect(gate.provenance_verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(gate.merge_authorization_claim).toBe(MERGE_AUTHORIZATION.AUTHORIZED);
  });

  it("verified provenance + a transition that was never even attempted is HELD", () => {
    const gate = evaluateCompletionGate({
      completion, provenance: verifiedProvenance, worktree: clean, mergeAuthorization: authorized
    });
    expect(gate.held).toBe(true);
    expect(gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_TRANSITION_UNVERIFIED);
  });

  it("verified provenance + a VERIFIED transition passes - and names the transition", () => {
    const gate = evaluateCompletionGate({
      completion,
      provenance: verifiedProvenance,
      worktree: clean,
      mergeAuthorization: authorized,
      mergeTransition: verifiedTransition,
      transitionExcuse: null
    });
    expect(gate.held).toBe(false);
    // The invariant: PASSED_PROVENANCE_VERIFIED is unreachable for a merge task,
    // because it would name a proof that was not the one required.
    expect(gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
    expect(gate.reason).not.toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
  });

  it("an UNDECIDABLE merge claim is held even with a perfect range and a clean worktree", () => {
    const gate = evaluateCompletionGate({
      completion,
      provenance: verifiedProvenance,
      worktree: clean,
      mergeAuthorization: undecidable,
      mergeTransition: { verified: false, reason: MERGE_TRANSITION.MERGE_AUTHORIZATION_PARTIAL }
    });
    expect(gate.held).toBe(true);
    expect(gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
    expect(gate.merge_authorization_decidable).toBe(false);
  });

  it("an UNDECIDABLE merge claim is held even when a transition somehow verified", () => {
    // Defence in depth: the undecidable branch is evaluated FIRST, so no
    // downstream evidence can talk the gate out of an unreadable order.
    const gate = evaluateCompletionGate({
      completion,
      provenance: verifiedProvenance,
      worktree: clean,
      mergeAuthorization: undecidable,
      mergeTransition: verifiedTransition,
      transitionExcuse: excused
    });
    expect(gate.held).toBe(true);
    expect(gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
  });

  it("the D-145 narrow excuse is untouched: unverified range + verified transition still passes", () => {
    const gate = evaluateCompletionGate({
      completion,
      provenance: unverifiedProvenance,
      worktree: clean,
      mergeAuthorization: authorized,
      mergeTransition: verifiedTransition,
      transitionExcuse: excused
    });
    expect(gate.held).toBe(false);
    expect(gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
    expect(gate.transition_excused_commits).toEqual([MERGE]);
  });

  it("the D-145 narrowing is untouched: a verified transition that excuses NOTHING still holds", () => {
    const gate = evaluateCompletionGate({
      completion,
      provenance: unverifiedProvenance,
      worktree: clean,
      mergeAuthorization: authorized,
      mergeTransition: verifiedTransition,
      transitionExcuse: { excused: false, reason: TRANSITION_EXCUSE.MORE_THAN_THE_MERGE_COMMIT, excused_commits: [] }
    });
    expect(gate.held).toBe(true);
    expect(gate.reason).toBe(COMPLETION_GATE.HELD_PROVENANCE_UNVERIFIED);
  });

  it("D-139 B is untouched: a merge task with a dirty worktree is still held", () => {
    const gate = evaluateCompletionGate({
      completion,
      provenance: verifiedProvenance,
      worktree: { verdict: "dirty", path: "C:/w/task", entry_count: 1, entries: ["?? leftover.tmp"], error: null },
      mergeAuthorization: authorized,
      mergeTransition: verifiedTransition
    });
    expect(gate.held).toBe(true);
    expect(gate.reason).toBe(COMPLETION_GATE.HELD_WORKTREE_DIRTY);
  });

  it("THE ORDINARY PATH IS UNCHANGED: a non-merge task still passes on its range alone", () => {
    // The control that gives every assertion above its meaning. Without it they
    // would all be satisfied by a gate that simply refuses everything.
    for (const ma of [notAMerge, null]) {
      const gate = evaluateCompletionGate({
        completion, provenance: verifiedProvenance, worktree: clean, mergeAuthorization: ma
      });
      expect(gate.held).toBe(false);
      expect(gate.reason).toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
      expect(gate.merge_authorization_claimed).toBe(false);
    }
  });

  it("a non-success claim is still passed without any merge evidence being consulted", () => {
    const gate = evaluateCompletionGate({
      completion: { complete: true, successful: false, status: "BLOCKED", reportCommentId: 900002 },
      provenance: null,
      mergeAuthorization: undecidable
    });
    expect(gate.held).toBe(false);
    expect(gate.reason).toBe(COMPLETION_GATE.PASSED_NOT_A_SUCCESS_CLAIM);
  });

  it("D-136 is untouched: a merge task with NO provenance record at all is still held", () => {
    const gate = evaluateCompletionGate({
      completion,
      provenance: null,
      worktree: clean,
      mergeAuthorization: authorized,
      mergeTransition: verifiedTransition,
      transitionExcuse: excused
    });
    expect(gate.held).toBe(true);
    expect(gate.reason).toBe(COMPLETION_GATE.HELD_NO_PROVENANCE_RECORD);
  });

  /* ------------------------------------------------------------------------
   * The human-facing half. Two hold reasons now fire with a fully VERIFIED
   * commit range behind them, so the message a person reconciling this reads
   * first must not open by claiming the commits are unaccounted for. A gate that
   * refuses correctly and then explains itself falsely has failed at its job.
   * ---------------------------------------------------------------------- */
  describe("the refusal says what actually failed", () => {
    const describe_ = (gate) => describeCompletionGate({ taskId: TASK_ID, gate, worktreePath: "C:/w/task" });

    it("an unverified merge transition is not reported as a provenance failure", () => {
      const gate = evaluateCompletionGate({
        completion,
        provenance: verifiedProvenance,
        worktree: clean,
        mergeAuthorization: authorized,
        mergeTransition: { verified: false, reason: MERGE_TRANSITION.NOT_MERGED }
      });
      const text = describe_(gate);
      expect(gate.provenance_verified).toBe(true);
      expect(text).toContain("MERGE-AUTHORIZED");
      expect(text).toContain("authorized merge transition");
      expect(text).toContain(`COMMIT PROVENANCE VERDICT: ${COMMIT_PROVENANCE.ATTRIBUTED} (verified=true)`);
      expect(text).not.toContain("cannot prove that the commits produced");
    });

    it("an undecidable merge order is reported as a broken order", () => {
      const gate = evaluateCompletionGate({
        completion, provenance: verifiedProvenance, worktree: clean, mergeAuthorization: undecidable
      });
      const text = describe_(gate);
      expect(text).toContain("cannot be decided");
      expect(text).toContain(MERGE_TRANSITION.MERGE_AUTHORIZATION_PARTIAL);
      expect(text).not.toContain("cannot prove that the commits produced");
    });

    it("an ordinary provenance failure still reads exactly as it always did", () => {
      const gate = evaluateCompletionGate({
        completion, provenance: unverifiedProvenance, worktree: clean, mergeAuthorization: notAMerge
      });
      const text = describe_(gate);
      expect(gate.provenance_verified).toBe(false);
      expect(text).toContain("cannot prove that the commits produced during the attempt are this task's own work");
      expect(text).toContain(`COMMIT PROVENANCE VERDICT: ${COMMIT_PROVENANCE.UNATTRIBUTED} (verified=false)`);
      // ...and it does not invent a merge authorization nobody claimed.
      expect(text).not.toContain("MERGE AUTHORIZATION:");
    });
  });
});

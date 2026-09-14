/**
 * D-134 unit tests: commit-authorship evidence.
 *
 * The property under test is a negative one, and negatives are easy to pass by
 * accident, so each case pins BOTH halves: the verdict, and the sentence the
 * child is actually told. A module that classified perfectly but still rendered
 * "this is your own work" would be exactly as dangerous as the defect it
 * replaces, and a verdict assertion alone would not catch it.
 */

import { describe, it, expect } from "vitest";

import {
  COMMIT_PROVENANCE,
  COMPLETION_GATE,
  MAX_EXAMINED_COMMITS,
  WORKTREE_CLEANLINESS,
  TRAILER_TASK,
  TRAILER_ATTEMPT,
  classifyCommitRange,
  collectCommitProvenance,
  commitIsAttributed,
  commitTrailerLines,
  completionGateHeld,
  describeCommitEvidenceRequirement,
  describeCommitProvenance,
  describeCompletionGate,
  evaluateCompletionGate,
  isVerifiedVerdict,
  mergeWorktreeCleanliness,
  parseCommitEvidence,
  provenanceForResume
} from "../lib/provenance.mjs";

const TASK = "D134-PR80-PROVENANCE-CLOSEOUT-20260912-A";
const ATTEMPT = "3f2a1b7c-9d4e-4a10-8b55-0c1d2e3f4a5b";
const OTHER_ATTEMPT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BEFORE = "1111111111111111111111111111111111111111";
const AFTER = "2222222222222222222222222222222222222222";

function commit(sha, message, extra = {}) {
  return {
    sha,
    message,
    committed_at: "2026-09-12T10:00:00+00:00",
    author_name: "fake",
    author_email: "fake@example.invalid",
    ...extra
  };
}

/** A commit message a well-behaved child produces. */
function stamped(subject, { taskId = TASK, attemptId = ATTEMPT } = {}) {
  return `${subject}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`
    + `${commitTrailerLines({ taskId, attemptId }).join("\n")}\n`;
}

describe("parseCommitEvidence", () => {
  it("reads both trailers from a normal commit message", () => {
    const { taskIds, attemptIds } = parseCommitEvidence(stamped("feat: thing"));
    expect(taskIds).toEqual([TASK]);
    expect(attemptIds).toEqual([ATTEMPT]);
  });

  it("is case-insensitive on the key and tolerant of surrounding whitespace", () => {
    const { taskIds, attemptIds } = parseCommitEvidence(
      `x\n\n  jarvis-task-id:   ${TASK}  \n\tJARVIS-ATTEMPT-ID: ${ATTEMPT}\t\n`
    );
    expect(taskIds).toEqual([TASK]);
    expect(attemptIds).toEqual([ATTEMPT]);
  });

  it("survives CRLF line endings", () => {
    const { taskIds, attemptIds } = parseCommitEvidence(stamped("feat: thing").replace(/\n/g, "\r\n"));
    expect(taskIds).toEqual([TASK]);
    expect(attemptIds).toEqual([ATTEMPT]);
  });

  it("does not treat prose that merely MENTIONS the ids as a trailer", () => {
    const { taskIds, attemptIds } = parseCommitEvidence(
      `fix: work on ${TASK}\n\nsee ${TRAILER_TASK}: ${TASK} in the notes\nattempt was ${ATTEMPT}\n`
    );
    expect(taskIds).toEqual([]);
    expect(attemptIds).toEqual([]);
  });

  it("returns nothing for an empty or missing message", () => {
    expect(parseCommitEvidence(undefined)).toEqual({ taskIds: [], attemptIds: [] });
    expect(parseCommitEvidence("")).toEqual({ taskIds: [], attemptIds: [] });
  });
});

describe("commitIsAttributed - BOTH halves are required", () => {
  it("accepts a commit carrying the exact task AND a known attempt id", () => {
    const v = commitIsAttributed(commit(AFTER, stamped("feat: x")), { taskId: TASK, attemptIds: [ATTEMPT] });
    expect(v).toMatchObject({ attributed: true, attemptId: ATTEMPT });
  });

  it("rejects the task trailer alone - it is public, so it is guessable", () => {
    const msg = `feat: x\n\n${TRAILER_TASK}: ${TASK}\n`;
    expect(commitIsAttributed(commit(AFTER, msg), { taskId: TASK, attemptIds: [ATTEMPT] }))
      .toMatchObject({ attributed: false, reason: "no_matching_attempt_trailer" });
  });

  it("rejects the attempt trailer alone - it does not say which task it belonged to", () => {
    const msg = `feat: x\n\n${TRAILER_ATTEMPT}: ${ATTEMPT}\n`;
    expect(commitIsAttributed(commit(AFTER, msg), { taskId: TASK, attemptIds: [ATTEMPT] }))
      .toMatchObject({ attributed: false, reason: "no_matching_task_trailer" });
  });

  it("rejects an attempt id this task never issued", () => {
    const msg = stamped("feat: x", { attemptId: OTHER_ATTEMPT });
    expect(commitIsAttributed(commit(AFTER, msg), { taskId: TASK, attemptIds: [ATTEMPT] }))
      .toMatchObject({ attributed: false, reason: "no_matching_attempt_trailer" });
  });

  it("rejects a trailer naming a DIFFERENT task, even with a valid attempt id", () => {
    const msg = stamped("feat: x", { taskId: "SOME-OTHER-TASK" });
    expect(commitIsAttributed(commit(AFTER, msg), { taskId: TASK, attemptIds: [ATTEMPT] }))
      .toMatchObject({ attributed: false, reason: "no_matching_task_trailer" });
  });

  it("accepts an EARLIER attempt of the same task, because that is still this task's work", () => {
    const msg = stamped("feat: x", { attemptId: OTHER_ATTEMPT });
    expect(commitIsAttributed(commit(AFTER, msg), { taskId: TASK, attemptIds: [OTHER_ATTEMPT, ATTEMPT] }))
      .toMatchObject({ attributed: true, attemptId: OTHER_ATTEMPT });
  });

  it("cannot attribute anything when no attempt id is known at all", () => {
    expect(commitIsAttributed(commit(AFTER, stamped("feat: x")), { taskId: TASK, attemptIds: [] }))
      .toMatchObject({ attributed: false, reason: "no_known_attempt_id" });
  });
});

describe("classifyCommitRange", () => {
  const base = { taskId: TASK, attemptIds: [ATTEMPT] };

  it("an unmoved head is UNCHANGED and verified, with no git question asked", () => {
    const v = classifyCommitRange({ ...base, headBefore: BEFORE, headAfter: BEFORE });
    expect(v.verdict).toBe(COMMIT_PROVENANCE.UNCHANGED);
    expect(v.verified).toBe(true);
  });

  it("a fully stamped range is ATTRIBUTED and verified", () => {
    const v = classifyCommitRange({
      ...base,
      headBefore: BEFORE,
      headAfter: AFTER,
      range: { ok: true, isAncestor: true, commits: [commit("a1", stamped("one")), commit(AFTER, stamped("two"))] }
    });
    expect(v.verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(v.verified).toBe(true);
    expect(v.attributed_commits.map((c) => c.sha)).toEqual(["a1", AFTER]);
    expect(v.unattributed_commits).toEqual([]);
  });

  it("a range with NO evidence is UNATTRIBUTED and NOT verified", () => {
    const v = classifyCommitRange({
      ...base,
      headBefore: BEFORE,
      headAfter: AFTER,
      range: { ok: true, isAncestor: true, commits: [commit(AFTER, "unrelated maintenance commit\n")] }
    });
    expect(v.verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(v.verified).toBe(false);
    expect(v.unattributed_commits).toHaveLength(1);
  });

  it("ONE foreign commit among the task's own makes the whole range unverified", () => {
    const v = classifyCommitRange({
      ...base,
      headBefore: BEFORE,
      headAfter: AFTER,
      range: {
        ok: true,
        isAncestor: true,
        commits: [commit("a1", stamped("mine")), commit(AFTER, "someone else's commit\n")]
      }
    });
    expect(v.verdict).toBe(COMMIT_PROVENANCE.PARTIAL);
    expect(v.verified).toBe(false);
    expect(v.attributed_commits).toHaveLength(1);
    expect(v.unattributed_commits).toHaveLength(1);
  });

  it("a rewound ref is DIVERGED, which is stronger than merely unattributed", () => {
    const v = classifyCommitRange({
      ...base, headBefore: BEFORE, headAfter: AFTER,
      range: { ok: true, isAncestor: false, commits: [] }
    });
    expect(v.verdict).toBe(COMMIT_PROVENANCE.DIVERGED);
    expect(v.verified).toBe(false);
  });

  it("an unanswerable git query is UNKNOWN - never 'nothing happened'", () => {
    const v = classifyCommitRange({
      ...base, headBefore: BEFORE, headAfter: AFTER,
      range: { ok: false, error: "git_exit_128: not a git repository" }
    });
    expect(v.verdict).toBe(COMMIT_PROVENANCE.UNKNOWN);
    expect(v.verified).toBe(false);
    expect(v.reason).toContain("not a git repository");
  });

  it("undeterminable ancestry is UNKNOWN, not a silent pass", () => {
    const v = classifyCommitRange({
      ...base, headBefore: BEFORE, headAfter: AFTER,
      range: { ok: true, isAncestor: null, commits: [] }
    });
    expect(v.verdict).toBe(COMMIT_PROVENANCE.UNKNOWN);
    expect(v.verified).toBe(false);
  });

  it("heads that differ over an EMPTY range is UNKNOWN - it is not explicable", () => {
    const v = classifyCommitRange({
      ...base, headBefore: BEFORE, headAfter: AFTER,
      range: { ok: true, isAncestor: true, commits: [] }
    });
    expect(v.verdict).toBe(COMMIT_PROVENANCE.UNKNOWN);
    expect(v.verified).toBe(false);
  });

  it("an unusable head is UNKNOWN", () => {
    for (const [b, a] of [[null, AFTER], [BEFORE, null], ["not-a-sha", AFTER], [undefined, undefined]]) {
      const v = classifyCommitRange({ ...base, headBefore: b, headAfter: a });
      expect(v.verdict).toBe(COMMIT_PROVENANCE.UNKNOWN);
      expect(v.verified).toBe(false);
    }
  });

  it("only UNCHANGED and ATTRIBUTED are ever verified", () => {
    expect(isVerifiedVerdict(COMMIT_PROVENANCE.UNCHANGED)).toBe(true);
    expect(isVerifiedVerdict(COMMIT_PROVENANCE.ATTRIBUTED)).toBe(true);
    for (const v of [COMMIT_PROVENANCE.PARTIAL, COMMIT_PROVENANCE.UNATTRIBUTED,
      COMMIT_PROVENANCE.DIVERGED, COMMIT_PROVENANCE.DRIFTED, COMMIT_PROVENANCE.UNKNOWN]) {
      expect(isVerifiedVerdict(v)).toBe(false);
    }
  });
});

describe("collectCommitProvenance - which git questions are actually asked", () => {
  const cfg = { repoPath: "C:/nowhere" };

  function recordingRunner(answers) {
    const calls = [];
    const runner = (_cmd, args) => {
      calls.push(args.join(" "));
      const key = args.find((a) => a === "--is-ancestor") ? "is-ancestor" : args[0];
      const answer = answers[key];
      if (!answer) return { status: 128, stdout: "", stderr: "unexpected" };
      return { status: answer.status ?? 0, stdout: answer.stdout ?? "", stderr: "" };
    };
    return { runner, calls };
  }

  it("asks git NOTHING when the head did not move", () => {
    const { runner, calls } = recordingRunner({});
    const v = collectCommitProvenance(cfg, { taskId: TASK, attemptIds: [ATTEMPT], headBefore: BEFORE, headAfter: BEFORE }, runner);
    expect(calls).toEqual([]);
    expect(v.verdict).toBe(COMMIT_PROVENANCE.UNCHANGED);
  });

  it("asks ancestry FIRST and does not read the log when the ref was rewound", () => {
    const { runner, calls } = recordingRunner({ "is-ancestor": { status: 1 } });
    const v = collectCommitProvenance(cfg, { taskId: TASK, attemptIds: [ATTEMPT], headBefore: BEFORE, headAfter: AFTER }, runner);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("merge-base --is-ancestor");
    expect(v.verdict).toBe(COMMIT_PROVENANCE.DIVERGED);
  });

  it("parses a real `git log` record stream and attributes it", () => {
    const FLD = "\u001f";
    const REC = "\u001e";
    const body = stamped("feat: the task's work");
    const { runner } = recordingRunner({
      "is-ancestor": { status: 0 },
      log: { stdout: `${AFTER}${FLD}2026-09-12T10:00:00+00:00${FLD}fake${FLD}f@x.invalid${FLD}${body}${REC}\n` }
    });
    const v = collectCommitProvenance(cfg, { taskId: TASK, attemptIds: [ATTEMPT], headBefore: BEFORE, headAfter: AFTER }, runner);
    expect(v.verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(v.attributed_commits[0]).toMatchObject({ sha: AFTER, subject: "feat: the task's work" });
  });

  it("a failing `git log` is UNKNOWN, even though ancestry succeeded", () => {
    const { runner } = recordingRunner({ "is-ancestor": { status: 0 }, log: { status: 128 } });
    const v = collectCommitProvenance(cfg, { taskId: TASK, attemptIds: [ATTEMPT], headBefore: BEFORE, headAfter: AFTER }, runner);
    expect(v.verdict).toBe(COMMIT_PROVENANCE.UNKNOWN);
    expect(v.verified).toBe(false);
  });
});

describe("provenanceForResume - a stored verdict is only as good as the head it was computed at", () => {
  const verified = {
    verdict: COMMIT_PROVENANCE.ATTRIBUTED,
    verified: true,
    head_before: BEFORE,
    head_after: AFTER,
    attributed_commits: [{ sha: AFTER, subject: "feat: mine" }],
    unattributed_commits: [],
    reason: "every commit in the range carries this task's own attempt evidence (1)"
  };

  it("keeps a verified verdict when the head has not moved since", () => {
    const p = provenanceForResume({ record: verified, headNow: AFTER });
    expect(p.verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(p.verified).toBe(true);
    expect(p.drifted).toBe(false);
  });

  it("DOWNGRADES a verified verdict when the head moved while no attempt was running", () => {
    const p = provenanceForResume({ record: verified, headNow: "3333333333333333333333333333333333333333" });
    expect(p.verdict).toBe(COMMIT_PROVENANCE.DRIFTED);
    expect(p.verified).toBe(false);
    expect(p.reason).toContain("while no attempt was running");
  });

  it("DOWNGRADES a verified verdict when the current head cannot be read at all", () => {
    const p = provenanceForResume({ record: verified, headNow: null });
    expect(p.verdict).toBe(COMMIT_PROVENANCE.UNKNOWN);
    expect(p.verified).toBe(false);
  });

  it("never PROMOTES: an unverified record stays unverified however the head sits", () => {
    const record = { ...verified, verdict: COMMIT_PROVENANCE.UNATTRIBUTED, verified: false, attributed_commits: [] };
    expect(provenanceForResume({ record, headNow: AFTER }).verified).toBe(false);
    expect(provenanceForResume({ record, headNow: "3".repeat(40) }).verified).toBe(false);
    expect(provenanceForResume({ record, headNow: null }).verified).toBe(false);
  });

  it("falls back to UNVERIFIED when only raw head observations exist", () => {
    const p = provenanceForResume({ record: null, headNow: AFTER, headBefore: BEFORE, headAfter: AFTER });
    expect(p.verdict).toBe(COMMIT_PROVENANCE.UNKNOWN);
    expect(p.verified).toBe(false);
    expect(p.reason).toContain("no commit-authorship evidence was recorded");
  });

  it("returns nothing at all when there is nothing to say", () => {
    expect(provenanceForResume({ record: null, headNow: AFTER })).toBeNull();
  });
});

describe("describeCommitProvenance - what the child is actually told", () => {
  const unverifiedVerdicts = [
    COMMIT_PROVENANCE.UNATTRIBUTED,
    COMMIT_PROVENANCE.PARTIAL,
    COMMIT_PROVENANCE.DIVERGED,
    COMMIT_PROVENANCE.DRIFTED,
    COMMIT_PROVENANCE.UNKNOWN
  ];

  for (const verdict of unverifiedVerdicts) {
    it(`${verdict}: never claims ownership, and forbids destructive reconciliation`, () => {
      const text = describeCommitProvenance({
        verdict,
        verified: false,
        head_before: BEFORE,
        head_after: AFTER,
        attributed_commits: [],
        unattributed_commits: [{ sha: AFTER, subject: "unrelated maintenance commit" }],
        reason: "test"
      }).join("\n");

      expect(text).toContain("COMMIT PROVENANCE: UNVERIFIED");
      expect(text).not.toMatch(/THIS TASK'S OWN WORK/);
      expect(text).not.toMatch(/Treat them as yours/);
      // Preserved: no destructive instruction is offered, in any form.
      expect(text).toMatch(/Never stash, reset, revert, clean, checkout over, force-push, rebase or/);
      // And not adopted either.
      expect(text).toContain("Do NOT adopt them as this task's output");
      expect(text).toContain(AFTER);
    });
  }

  it("ATTRIBUTED: states ownership and still forbids rewriting the commits", () => {
    const text = describeCommitProvenance({
      verdict: COMMIT_PROVENANCE.ATTRIBUTED,
      verified: true,
      head_before: BEFORE,
      head_after: AFTER,
      attributed_commits: [{ sha: AFTER, subject: "feat: mine" }],
      unattributed_commits: [],
      reason: "ok"
    }).join("\n");

    expect(text).toContain("VERIFIED AS THIS TASK'S OWN WORK");
    expect(text).toContain(AFTER);
    expect(text).toMatch(/Never stash, reset, force-push, revert or/);
    expect(text).not.toContain("UNVERIFIED");
  });

  it("UNCHANGED: says so plainly and raises no authorship question", () => {
    const text = describeCommitProvenance({
      verdict: COMMIT_PROVENANCE.UNCHANGED, verified: true, head_before: BEFORE, head_after: BEFORE,
      attributed_commits: [], unattributed_commits: [], reason: "head_did_not_move"
    }).join("\n");
    expect(text).toContain("HEAD did not move");
    expect(text).not.toContain("UNVERIFIED");
    expect(text).not.toContain("OWN WORK");
  });

  it("renders nothing when there is no record", () => {
    expect(describeCommitProvenance(null)).toEqual([]);
  });
});

describe("describeCommitEvidenceRequirement", () => {
  it("states the exact trailers and the consequence of omitting them", () => {
    const text = describeCommitEvidenceRequirement({ taskId: TASK, attemptId: ATTEMPT }).join("\n");
    expect(text).toContain(`${TRAILER_TASK}: ${TASK}`);
    expect(text).toContain(`${TRAILER_ATTEMPT}: ${ATTEMPT}`);
    expect(text).toContain("strands it");
  });

  it("says nothing rather than something half-true when an id is missing", () => {
    expect(describeCommitEvidenceRequirement({ taskId: TASK, attemptId: null })).toEqual([]);
    expect(describeCommitEvidenceRequirement({ taskId: null, attemptId: ATTEMPT })).toEqual([]);
  });
});

/* ==========================================================================
 * D-135 (1): THE >50-COMMIT FALSE-VERIFICATION EDGE
 * ==========================================================================
 *
 * The defect, exactly as it stood:
 *
 *     for (const commit of commits.slice(0, MAX_RECORDED_COMMITS)) { ... }
 *
 * One loop bounded both the RECORD and the DECISION. A 51-commit range whose
 * first 50 commits carried this task's trailers and whose 51st was a foreign
 * commit came out `task_attributed`, `verified: true` - a positive claim of
 * ownership over a commit that was never read.
 *
 * Every case below puts the ONLY foreign commit past the detail limit, which is
 * the position the old code could not see, and pins the exact boundary: 50 is
 * the last size the old code got right, 51 is the first it got wrong.
 */
describe("D-135: the decision covers EVERY commit, the record is merely bounded", () => {
  const base = { taskId: TASK, attemptIds: [ATTEMPT] };

  /** `n` commits, all properly stamped, oldest first - exactly as git returns them. */
  function mineRange(n, { from = 0 } = {}) {
    return Array.from({ length: n }, (_, i) =>
      commit(String(from + i + 1).padStart(40, "0"), stamped(`feat: mine ${from + i + 1}`)));
  }

  /** One commit by an unrelated writer: no trailers at all. */
  function foreign(sha = "f".repeat(40)) {
    return commit(sha, "unrelated maintenance commit\n");
  }

  const ok = (commits) => ({ ok: true, isAncestor: true, commits, truncated: false });

  it("EXACTLY 50 genuine commits are verified, and all 50 details are kept", () => {
    const v = classifyCommitRange({ ...base, headBefore: BEFORE, headAfter: AFTER, range: ok(mineRange(50)) });

    expect(v.verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(v.verified).toBe(true);
    expect(v.commit_count).toBe(50);
    expect(v.examined_commit_count).toBe(50);
    expect(v.attributed_count).toBe(50);
    expect(v.attributed_commits).toHaveLength(50);
    expect(v.details_truncated).toBe(false);
  });

  it("51 commits, the ONLY foreign one LAST - the exact case that used to verify - is PARTIAL", () => {
    const intruder = foreign();
    const range = [...mineRange(50), intruder];
    expect(range).toHaveLength(51);

    const v = classifyCommitRange({ ...base, headBefore: BEFORE, headAfter: AFTER, range: ok(range) });

    // The whole point: never verified, never `task_attributed`.
    expect(v.verdict).toBe(COMMIT_PROVENANCE.PARTIAL);
    expect(v.verified).toBe(false);
    expect(isVerifiedVerdict(v.verdict)).toBe(false);

    // The decision counted all 51; the detail list is capped at 50 and says so.
    expect(v.commit_count).toBe(51);
    expect(v.examined_commit_count).toBe(51);
    expect(v.attributed_count).toBe(50);
    expect(v.unattributed_count).toBe(1);
    expect(v.attributed_commits).toHaveLength(50);

    // And the commit that decided it is NAMED, not merely counted - the operator
    // has to be able to go and look at it.
    expect(v.unattributed_commits.map((c) => c.sha)).toEqual([intruder.sha]);
  });

  it("a foreign commit at position 500 of 500 is still found", () => {
    const intruder = foreign("e".repeat(40));
    const v = classifyCommitRange({
      ...base, headBefore: BEFORE, headAfter: AFTER, range: ok([...mineRange(499), intruder])
    });

    expect(v.verdict).toBe(COMMIT_PROVENANCE.PARTIAL);
    expect(v.verified).toBe(false);
    expect(v.attributed_count).toBe(499);
    expect(v.unattributed_count).toBe(1);
    // Storage stayed bounded while the decision did not.
    expect(v.attributed_commits).toHaveLength(50);
    expect(v.details_truncated).toBe(true);
    expect(v.unattributed_commits.map((c) => c.sha)).toEqual([intruder.sha]);
  });

  it("51 UNSTAMPED commits are UNATTRIBUTED, counted in full, listed in part", () => {
    const range = Array.from({ length: 51 }, (_, i) => foreign(String(i + 1).padStart(40, "a")));
    const v = classifyCommitRange({ ...base, headBefore: BEFORE, headAfter: AFTER, range: ok(range) });

    expect(v.verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(v.verified).toBe(false);
    expect(v.unattributed_count).toBe(51);
    expect(v.unattributed_commits).toHaveLength(50);
    expect(v.details_truncated).toBe(true);
    expect(v.reason).toContain("51 unexplained");
  });

  it("a range the worker REFUSED TO READ IN FULL is UNKNOWN, never attributed", () => {
    // Every commit git handed back is genuine and stamped. That is precisely the
    // trap: the prefix looks perfect, and the commits behind it were never read.
    const v = classifyCommitRange({
      ...base,
      headBefore: BEFORE,
      headAfter: AFTER,
      range: { ok: true, isAncestor: true, commits: mineRange(50), truncated: true }
    });

    expect(v.verdict).toBe(COMMIT_PROVENANCE.UNKNOWN);
    expect(v.verified).toBe(false);
    expect(v.range_truncated).toBe(true);
    expect(v.commit_count).toBeNull();
    expect(v.reason).toContain("never read");
    // Nothing from the prefix is presented as proven.
    expect(v.attributed_commits).toEqual([]);
  });

  it("the prompt states the FULL count, so a capped list is never read as the whole range", () => {
    const v = classifyCommitRange({
      ...base, headBefore: BEFORE, headAfter: AFTER,
      range: ok([...mineRange(499), foreign("e".repeat(40))])
    });
    const text = describeCommitProvenance({ ...v, head_now: AFTER, drifted: false }).join("\n");

    expect(text).toContain("COMMIT PROVENANCE: UNVERIFIED");
    expect(text).toContain("50 of 499 shown");
    expect(text).toContain("the verdict covers ALL 499");
  });

  it("collectCommitProvenance asks git for a BOUNDED log and fails closed when it overflows", () => {
    const FLD = "\u001f";
    const REC = "\u001e";
    const cfg = { repoPath: "C:/nowhere" };
    const calls = [];
    // git returns limit+1 records, which is the overflow proof.
    const stream = Array.from({ length: MAX_EXAMINED_COMMITS + 1 }, (_, i) =>
      `${String(i + 1).padStart(40, "0")}${FLD}2026-09-12T10:00:00+00:00${FLD}fake${FLD}f@x.invalid`
      + `${FLD}${stamped(`feat: mine ${i + 1}`)}${REC}\n`).join("");

    const runner = (_cmd, args) => {
      calls.push(args.join(" "));
      if (args.includes("--is-ancestor")) return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: stream, stderr: "" };
    };

    const v = collectCommitProvenance(cfg, { taskId: TASK, attemptIds: [ATTEMPT], headBefore: BEFORE, headAfter: AFTER }, runner);

    // The bound is asked for as limit+1 on purpose: the extra record is evidence.
    expect(calls.some((c) => c.includes(`-n ${MAX_EXAMINED_COMMITS + 1}`))).toBe(true);
    expect(v.verdict).toBe(COMMIT_PROVENANCE.UNKNOWN);
    expect(v.verified).toBe(false);
    expect(v.range_truncated).toBe(true);
  });
});

/* ==========================================================================
 * D-135 (2): THE COMPLETION GATE
 * ========================================================================== */
describe("D-135: evaluateCompletionGate", () => {
  const successfulReport = {
    complete: true, successful: true, status: "COMPLETE", canonicalStatus: "COMPLETE", reportCommentId: 4242
  };
  const blockedReport = {
    complete: true, successful: false, status: "BLOCKED", canonicalStatus: "BLOCKED", reportCommentId: 4243
  };
  const verifiedProvenance = {
    verdict: COMMIT_PROVENANCE.ATTRIBUTED, verified: true, head_before: BEFORE, head_after: AFTER,
    attributed_commits: [{ sha: AFTER }], unattributed_commits: [], unattributed_count: 0
  };

  const unverified = (verdict, extra = {}) => ({
    verdict,
    verified: false,
    head_before: BEFORE,
    head_after: AFTER,
    attributed_commits: [],
    unattributed_commits: [{ sha: AFTER, subject: "unrelated maintenance commit" }],
    unattributed_count: 1,
    reason: `recorded reason for ${verdict}`,
    ...extra
  });

  // D-139 B: en verifisert provenance er ikke lenger halve beviset - den er
  // halve beviset. Den andre halvparten er en fersk, ren task-worktree.
  const cleanWorktree = { verdict: WORKTREE_CLEANLINESS.CLEAN, path: "/wt", entry_count: 0, entries: [], error: null, queried: true };
  const dirtyWorktree = (entries) => ({
    verdict: WORKTREE_CLEANLINESS.DIRTY,
    path: "/wt",
    entry_count: entries.length,
    entries,
    error: null,
    queried: true
  });
  const unknownWorktree = (error) => ({
    verdict: WORKTREE_CLEANLINESS.UNKNOWN,
    path: "/wt",
    entry_count: 0,
    entries: [],
    error,
    queried: true
  });

  it("passes a successful report standing on a VERIFIED range AND a clean worktree", () => {
    const gate = evaluateCompletionGate({ completion: successfulReport, provenance: verifiedProvenance, worktree: cleanWorktree });
    expect(gate.held).toBe(false);
    expect(gate.passed).toBe(true);
    expect(gate.reason).toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
  });

  it("passes an unmoved HEAD - there was never an authorship question", () => {
    const gate = evaluateCompletionGate({
      completion: successfulReport,
      provenance: { verdict: COMMIT_PROVENANCE.UNCHANGED, verified: true, head_before: BEFORE, head_after: BEFORE },
      worktree: cleanWorktree
    });
    expect(gate.held).toBe(false);
    expect(gate.reason).toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
  });

  describe("D-139 B: en ren worktree er den ANDRE halvparten av beviset", () => {
    it("HOLDER naar ingen har sett paa worktreen i det hele tatt", () => {
      const gate = evaluateCompletionGate({ completion: successfulReport, provenance: verifiedProvenance, worktree: null });
      expect(gate.held).toBe(true);
      expect(gate.passed).toBe(false);
      expect(gate.reason).toBe(COMPLETION_GATE.HELD_NO_WORKTREE_EVIDENCE);
    });

    for (const entry of [" M src/a.ts", "A  src/b.ts", " D src/c.ts", "UU src/d.ts", "?? src/e.ts", "R  a -> b"]) {
      it(`HOLDER paa en porcelain-linje av enhver art: ${JSON.stringify(entry)}`, () => {
        const gate = evaluateCompletionGate({
          completion: successfulReport,
          provenance: verifiedProvenance,
          worktree: dirtyWorktree([entry])
        });
        expect(gate.held).toBe(true);
        expect(gate.reason).toBe(COMPLETION_GATE.HELD_WORKTREE_DIRTY);
        expect(gate.worktree_entry_count).toBe(1);
        expect(gate.worktree_entries).toEqual([entry]);
      });
    }

    it("HOLDER naar statusen ikke kunne leses - ukjent er aldri rent", () => {
      const gate = evaluateCompletionGate({
        completion: successfulReport,
        provenance: verifiedProvenance,
        worktree: unknownWorktree("git status failed: ENOENT")
      });
      expect(gate.held).toBe(true);
      expect(gate.reason).toBe(COMPLETION_GATE.HELD_WORKTREE_UNKNOWN);
      expect(gate.worktree_error).toContain("ENOENT");
    });

    it("HOLDER paa et ukjent/fremmed verdikt, aldri som en stille pass", () => {
      const gate = evaluateCompletionGate({
        completion: successfulReport,
        provenance: verifiedProvenance,
        worktree: { verdict: "noe-helt-annet", entry_count: 0, entries: [] }
      });
      expect(gate.held).toBe(true);
      expect(gate.reason).toBe(COMPLETION_GATE.HELD_WORKTREE_UNKNOWN);
    });

    it("provenance-halvparten avgjoer FOERST - en dirty worktree skjuler ikke en uverifisert range", () => {
      const gate = evaluateCompletionGate({
        completion: successfulReport,
        provenance: unverified(COMMIT_PROVENANCE.UNATTRIBUTED),
        worktree: dirtyWorktree([" M x"])
      });
      expect(gate.held).toBe(true);
      expect(gate.reason).toBe(COMPLETION_GATE.HELD_PROVENANCE_UNVERIFIED);
    });

    it("en IKKE-suksess-rapport gates fortsatt ikke paa worktreen", () => {
      const gate = evaluateCompletionGate({
        completion: { complete: true, successful: false, status: "BLOCKED" },
        provenance: null,
        worktree: dirtyWorktree([" M x"])
      });
      expect(gate.held).toBe(false);
      expect(gate.reason).toBe(COMPLETION_GATE.PASSED_NOT_A_SUCCESS_CLAIM);
    });
  });

  describe("D-139 B: lagret renhet kan bare NEDGRADERE fersk, aldri oppgradere", () => {
    it("lagret CLEAN oppgraderer ikke en fersk DIRTY", () => {
      const merged = mergeWorktreeCleanliness(cleanWorktree, dirtyWorktree([" M x"]));
      expect(merged.verdict).toBe(WORKTREE_CLEANLINESS.DIRTY);
    });

    it("lagret CLEAN oppgraderer ikke en fersk UNKNOWN", () => {
      const merged = mergeWorktreeCleanliness(cleanWorktree, unknownWorktree("uleselig"));
      expect(merged.verdict).toBe(WORKTREE_CLEANLINESS.UNKNOWN);
    });

    it("lagret DIRTY nedgraderer en fersk CLEAN - funnet staar til noen forklarer det", () => {
      const merged = mergeWorktreeCleanliness(dirtyWorktree([" M x"]), cleanWorktree);
      expect(merged.verdict).toBe(WORKTREE_CLEANLINESS.DIRTY);
    });

    it("lagret UNKNOWN nedgraderer en fersk CLEAN", () => {
      const merged = mergeWorktreeCleanliness(unknownWorktree("uleselig"), cleanWorktree);
      expect(merged.verdict).toBe(WORKTREE_CLEANLINESS.UNKNOWN);
    });

    it("uten lagret verdikt gjelder det ferske; uten ferskt gjelder det lagrede", () => {
      expect(mergeWorktreeCleanliness(null, cleanWorktree).verdict).toBe(WORKTREE_CLEANLINESS.CLEAN);
      expect(mergeWorktreeCleanliness(dirtyWorktree([" M x"]), null).verdict).toBe(WORKTREE_CLEANLINESS.DIRTY);
      expect(mergeWorktreeCleanliness(null, null)).toBe(null);
    });
  });

  // The enumerated list from the architect's order, each one asserted on its own.
  for (const verdict of [
    COMMIT_PROVENANCE.UNATTRIBUTED,
    COMMIT_PROVENANCE.PARTIAL,
    COMMIT_PROVENANCE.DIVERGED,
    COMMIT_PROVENANCE.DRIFTED,
    COMMIT_PROVENANCE.UNKNOWN
  ]) {
    it(`HOLDS a successful report when provenance is ${verdict}`, () => {
      const gate = evaluateCompletionGate({ completion: successfulReport, provenance: unverified(verdict) });
      expect(gate.held).toBe(true);
      expect(gate.passed).toBe(false);
      expect(gate.reason).toBe(COMPLETION_GATE.HELD_PROVENANCE_UNVERIFIED);
      expect(gate.provenance_verdict).toBe(verdict);
      // The evidence a human needs travels with the gate, not just the answer.
      expect(gate.unattributed_commits).toEqual([AFTER]);
      expect(gate.report_comment_id).toBe(4242);
    });
  }

  it("does NOT gate an unsuccessful terminal report - it claims nothing that could be false", () => {
    const gate = evaluateCompletionGate({
      completion: blockedReport, provenance: unverified(COMMIT_PROVENANCE.UNATTRIBUTED)
    });
    expect(gate.held).toBe(false);
    expect(gate.reason).toBe(COMPLETION_GATE.PASSED_NOT_A_SUCCESS_CLAIM);
  });

  it("does NOT gate a non-terminal report", () => {
    const gate = evaluateCompletionGate({
      completion: { complete: false, successful: false, status: "IN_PROGRESS", reportCommentId: 7 },
      provenance: unverified(COMMIT_PROVENANCE.PARTIAL)
    });
    expect(gate.held).toBe(false);
    expect(gate.reason).toBe(COMPLETION_GATE.PASSED_NOT_A_SUCCESS_CLAIM);
  });

  /**
   * D-136. This assertion used to be the exact opposite, and the opposite was
   * the last fail-open path in the gate.
   *
   * D-135 argued that a missing record meant "no attempt of this worker version
   * produced one" and let it pass. It does not mean that. It means NOBODY
   * LOOKED - and it is reachable on the CURRENT worker, not just from pre-D-134
   * rows: the durable claim, the child identity and IN_PROGRESS are written
   * before the child is spawned, while `commit_provenance` is written only at
   * the post-dispatch checkpoint after it exits. A parent killed in between
   * leaves precisely this shape, with a trusted STATUS=COMPLETE already posted.
   */
  it("a record with NO provenance at all HOLDS - absence of evidence is not evidence", () => {
    const gate = evaluateCompletionGate({ completion: successfulReport, provenance: null });
    expect(gate.held).toBe(true);
    expect(gate.passed).toBe(false);
    expect(gate.reason).toBe(COMPLETION_GATE.HELD_NO_PROVENANCE_RECORD);
    // Nothing is invented to fill the gap: the evidence fields stay empty.
    expect(gate.provenance_verdict).toBeNull();
    expect(gate.unattributed_commits).toEqual([]);
    // The report itself is still described truthfully.
    expect(gate.report_comment_id).toBe(4242);
    expect(gate.report_status).toBe("COMPLETE");
  });

  it("an UNSUCCESSFUL report with no provenance is still not gated", () => {
    // The no-record hold must not resurrect finished-and-abandoned tasks: a
    // BLOCKED/FAILED report claims nothing that provenance could contradict.
    const gate = evaluateCompletionGate({ completion: blockedReport, provenance: null });
    expect(gate.held).toBe(false);
    expect(gate.reason).toBe(COMPLETION_GATE.PASSED_NOT_A_SUCCESS_CLAIM);
  });

  it("the two held reasons are distinguishable, and the notice says which one fired", () => {
    const noRecord = evaluateCompletionGate({ completion: successfulReport, provenance: null });
    const unverifiedRange = evaluateCompletionGate({
      completion: successfulReport, provenance: unverified(COMMIT_PROVENANCE.UNATTRIBUTED)
    });
    expect(noRecord.reason).not.toBe(unverifiedRange.reason);
    expect(describeCompletionGate({ taskId: TASK, gate: noRecord }))
      .toContain(COMPLETION_GATE.HELD_NO_PROVENANCE_RECORD);
    expect(describeCompletionGate({ taskId: TASK, gate: unverifiedRange }))
      .toContain(COMPLETION_GATE.HELD_PROVENANCE_UNVERIFIED);
  });

  it("a verified-looking VERDICT with `verified` downgraded still holds - both halves are required", () => {
    // This is exactly the shape `provenanceForResume` produces when it cannot
    // re-confirm a stored verdict: the verdict string survives, `verified` does
    // not. Reading the string alone would re-open the hole.
    const gate = evaluateCompletionGate({
      completion: successfulReport,
      provenance: { ...verifiedProvenance, verified: false }
    });
    expect(gate.held).toBe(true);
  });

  it("an unknown verdict from a future record shape holds rather than passing", () => {
    const gate = evaluateCompletionGate({
      completion: successfulReport,
      provenance: { verdict: "something_this_build_has_never_heard_of", verified: true }
    });
    expect(gate.held).toBe(true);
  });
});

describe("D-135: completionGateHeld reads only a POSITIVE durable hold", () => {
  it("is true only for an explicit held:true", () => {
    expect(completionGateHeld({ completion_gate: { held: true } })).toBe(true);
  });

  it("is false for a passed gate, a missing gate, a legacy row and a malformed value", () => {
    expect(completionGateHeld({ completion_gate: { held: false } })).toBe(false);
    expect(completionGateHeld({ status: "completed", successful: true })).toBe(false);
    expect(completionGateHeld({})).toBe(false);
    expect(completionGateHeld(null)).toBe(false);
    expect(completionGateHeld({ completion_gate: "held" })).toBe(false);
    expect(completionGateHeld({ completion_gate: { held: "true" } })).toBe(false);
  });
});

describe("D-135: describeCompletionGate tells the operator what was NOT done", () => {
  const gate = {
    held: true,
    reason: COMPLETION_GATE.HELD_PROVENANCE_UNVERIFIED,
    provenance_verdict: COMMIT_PROVENANCE.UNATTRIBUTED,
    provenance_reason: "no commit in the range carries this task's attempt evidence (1 unexplained)",
    head_before: BEFORE,
    head_after: AFTER,
    head_now: AFTER,
    unattributed_count: 1,
    unattributed_commits: [AFTER],
    report_comment_id: 4242,
    report_status: "COMPLETE"
  };

  it("names the claim, the verdict and the unexplained commit", () => {
    const text = describeCompletionGate({ taskId: TASK, gate, worktreePath: "C:/wt/task" });
    expect(text).toContain("claims SUCCESSFUL completion");
    expect(text).toContain(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(text).toContain(AFTER.slice(0, 12));
    expect(text).toContain("C:/wt/task");
  });

  it("states every refusal explicitly, and offers no destructive remedy", () => {
    const text = describeCompletionGate({ taskId: TASK, gate });
    expect(text).toContain("NOT completed");
    expect(text).toContain("did NOT emit a completion-confirmed event");
    expect(text).toContain("did NOT release or remove");
    expect(text).toContain("did NOT let this record retire (supersede) any older task");
    for (const forbidden of [/\bgit stash\b/, /\bgit reset\b/, /\bgit revert\b/, /\bgit clean\b/, /--force\b/]) {
      expect(text).not.toMatch(forbidden);
    }
  });
});

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
  TRAILER_TASK,
  TRAILER_ATTEMPT,
  classifyCommitRange,
  collectCommitProvenance,
  commitIsAttributed,
  commitTrailerLines,
  describeCommitEvidenceRequirement,
  describeCommitProvenance,
  isVerifiedVerdict,
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

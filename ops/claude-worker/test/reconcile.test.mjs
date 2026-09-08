import { describe, it, expect } from "vitest";

import {
  assessCompletion,
  findTrustedReport,
  reconcilePriorAttempt,
  extractAssociations,
  mergeObservedAssociations,
  computeBackoff,
  shouldPostStatus,
  statusKey,
  TERMINAL_REPORT_STATUSES
} from "../lib/reconcile.mjs";

const TRUSTED = "tsworkflow";

function comment(id, body, { login = TRUSTED, created_at = "2026-09-06T12:00:00Z" } = {}) {
  return { id, body, user: { login }, created_at };
}

describe("completion requires task-specific trusted evidence", () => {
  const taskId = "D126-X";

  it("exit code alone is never completion: no report means not complete", () => {
    const res = assessCompletion({ taskId, comments: [], trustedAuthor: TRUSTED });
    expect(res.complete).toBe(false);
    expect(res.reason).toBe("no_matching_trusted_report");
  });

  it("a report from an untrusted author is ignored", () => {
    const comments = [comment(1, `CLAUDE_REPORT\nTASK_ID=${taskId}\nSTATUS=COMPLETED`, { login: "someone-else" })];
    expect(assessCompletion({ taskId, comments, trustedAuthor: TRUSTED }).complete).toBe(false);
  });

  it("a report for a DIFFERENT task id is ignored", () => {
    const comments = [comment(1, "CLAUDE_REPORT\nTASK_ID=OTHER\nSTATUS=COMPLETED")];
    expect(assessCompletion({ taskId, comments, trustedAuthor: TRUSTED }).complete).toBe(false);
  });

  it("a non-terminal STATUS is progress, not completion", () => {
    const comments = [comment(1, `CLAUDE_REPORT\nTASK_ID=${taskId}\nSTATUS=IN_PROGRESS`)];
    const res = assessCompletion({ taskId, comments, trustedAuthor: TRUSTED });
    expect(res.complete).toBe(false);
    expect(res.reason).toMatch(/not_terminal/);
  });

  it("BLOCKED and FAILED close the task but are NOT success", () => {
    for (const status of ["BLOCKED", "FAILED"]) {
      const comments = [comment(1, `CLAUDE_REPORT\nTASK_ID=${taskId}\nSTATUS=${status}`)];
      const res = assessCompletion({ taskId, comments, trustedAuthor: TRUSTED });
      expect(res.complete).toBe(true);
      expect(res.successful).toBe(false);
    }
  });

  it("every terminal status is accepted as closing", () => {
    for (const status of TERMINAL_REPORT_STATUSES) {
      const comments = [comment(1, `CLAUDE_REPORT\nTASK_ID=${taskId}\nSTATUS=${status}`)];
      expect(assessCompletion({ taskId, comments, trustedAuthor: TRUSTED }).complete).toBe(true);
    }
  });

  it("an OLD report for a re-issued id is not fresh evidence", () => {
    const comments = [comment(1, `CLAUDE_REPORT\nTASK_ID=${taskId}\nSTATUS=COMPLETED`, { created_at: "2026-09-01T00:00:00Z" })];
    const res = findTrustedReport(comments, { taskId, trustedAuthor: TRUSTED, sinceIso: "2026-09-06T00:00:00Z" });
    expect(res).toBeNull();
  });
});

/**
 * D126 review blocker 6, architect reproduction:
 *   KNOWN_D125_BRANCH=null KNOWN_PR=null
 * "whole TASK_ID slug is NOT present in actual branches. Locally reproduced
 *  D125-UA7-TELEGRAM-INBOUND-OWNER-20260906T0627Z vs
 *  claude/d125-ua7-telegram-inbound-owner => existingBranch=null and PR=null
 *  despite PR #74 being provided."
 */
describe("blocker 6: exact associations, no fuzzy slug matching", () => {
  const taskId = "D125-UA7-TELEGRAM-INBOUND-OWNER-20260906T0627Z";
  const realBranch = "claude/d125-ua7-telegram-inbound-owner";

  const branches = { ok: true, items: ["main", realBranch, "claude/unrelated"] };
  const pulls = { ok: true, items: [{ number: 74, headRefName: realBranch, state: "closed", mergedAt: "2026-09-06T20:00:00Z" }] };

  it("finds the branch and the PR from the ACK's own BRANCH= field (the exact repro case)", () => {
    const comments = [
      comment(500, `CLAUDE_ACK\nTASK_ID=${taskId}\nBRANCH=${realBranch}\nPR_NUMBER=74`)
    ];
    const rec = reconcilePriorAttempt({
      taskId,
      comments,
      trustedAuthor: TRUSTED,
      branchLookup: branches,
      pullLookup: pulls
    });
    expect(rec.existingBranch).toBe(realBranch);
    expect(rec.branchVerified).toBe(true);
    expect(rec.existingPr).toMatchObject({ number: 74, merged: true });
    expect(rec.alreadyMerged).toBe(true);
    expect(rec.duplicateRiskUnknown).toBe(false);
  });

  it("finds them from the worker's own recorded branch_after when no comment exists", () => {
    const rec = reconcilePriorAttempt({
      taskId,
      comments: [],
      trustedAuthor: TRUSTED,
      priorTask: { task_id: taskId, branch_after: realBranch },
      branchLookup: branches,
      pullLookup: pulls
    });
    expect(rec.existingBranch).toBe(realBranch);
    expect(rec.existingPr.number).toBe(74);
  });

  it("finds a PR whose body carries the exact full TASK_ID", () => {
    const rec = reconcilePriorAttempt({
      taskId,
      comments: [],
      trustedAuthor: TRUSTED,
      branchLookup: branches,
      pullLookup: { ok: true, items: [{ number: 74, headRefName: realBranch, state: "open", body: `Implements ${taskId}.` }] }
    });
    expect(rec.existingPr.number).toBe(74);
  });

  it("does NOT match an unrelated branch that merely shares a prefix", () => {
    const assoc = extractAssociations({
      taskId,
      comments: [comment(1, `CLAUDE_ACK\nTASK_ID=OTHER-TASK\nBRANCH=claude/d125-something-else`)],
      trustedAuthor: TRUSTED
    });
    expect(assoc.branches).toEqual([]);
  });

  it("never treats main/HEAD as a task branch", () => {
    const assoc = extractAssociations({
      taskId,
      comments: [],
      trustedAuthor: TRUSTED,
      priorTask: { branch_after: "main" }
    });
    expect(assoc.branches).toEqual([]);
  });

  it("ignores a BRANCH= claimed by an untrusted author", () => {
    const assoc = extractAssociations({
      taskId,
      comments: [comment(1, `CLAUDE_ACK\nTASK_ID=${taskId}\nBRANCH=attacker/branch`, { login: "not-the-owner" })],
      trustedAuthor: TRUSTED
    });
    expect(assoc.branches).toEqual([]);
  });
});

/**
 * "GitHub/read failures currently become empty arrays; never interpret failed
 *  lookup as proof no PR exists."
 */
describe("blocker 6: a failed lookup is UNKNOWN, never proof of absence", () => {
  const taskId = "D126-Y";

  it("marks duplicate risk unknown when the branch lookup failed", () => {
    const rec = reconcilePriorAttempt({
      taskId,
      comments: [],
      trustedAuthor: TRUSTED,
      branchLookup: { ok: false, items: [], error: "HTTP 403 rate limit" },
      pullLookup: { ok: true, items: [] }
    });
    expect(rec.duplicateRiskUnknown).toBe(true);
    expect(rec.lookupFailed).toBe(true);
    expect(rec.lookupFailures.join(" ")).toMatch(/403/);
  });

  it("marks duplicate risk unknown when the PR lookup failed", () => {
    const rec = reconcilePriorAttempt({
      taskId,
      comments: [],
      trustedAuthor: TRUSTED,
      branchLookup: { ok: true, items: [] },
      pullLookup: { ok: false, items: [], error: "network unreachable" }
    });
    expect(rec.duplicateRiskUnknown).toBe(true);
  });

  it("still surfaces a known association as unverified rather than as absent", () => {
    const rec = reconcilePriorAttempt({
      taskId,
      comments: [comment(9, `CLAUDE_ACK\nTASK_ID=${taskId}\nBRANCH=claude/y\nPR_NUMBER=99`)],
      trustedAuthor: TRUSTED,
      branchLookup: { ok: false, items: [], error: "down" },
      pullLookup: { ok: false, items: [], error: "down" }
    });
    expect(rec.existingBranch).toBe("claude/y");
    expect(rec.branchVerified).toBe(false);
    expect(rec.existingPr).toBeNull();
    expect(rec.prNumberKnownButUnverified).toBe(99);
  });

  it("reports duplicate risk as KNOWN when both lookups succeeded and found nothing", () => {
    const rec = reconcilePriorAttempt({
      taskId,
      comments: [],
      trustedAuthor: TRUSTED,
      branchLookup: { ok: true, items: ["main"] },
      pullLookup: { ok: true, items: [] }
    });
    expect(rec.duplicateRiskUnknown).toBe(false);
    expect(rec.existingBranch).toBeNull();
  });
});

describe("observed associations accumulate and never regress", () => {
  it("merges a new branch without dropping earlier ones", () => {
    let task = { task_id: "T" };
    task = { ...task, ...mergeObservedAssociations(task, { branch: "claude/a" }) };
    task = { ...task, ...mergeObservedAssociations(task, { branch: "claude/b", prNumber: 12 }) };
    task = { ...task, ...mergeObservedAssociations(task, { branch: "claude/a", prNumber: 12 }) };
    expect(task.observed_branches).toEqual(["claude/a", "claude/b"]);
    expect(task.observed_pr_numbers).toEqual([12]);
  });

  it("ignores non-branches and invalid PR numbers", () => {
    const merged = mergeObservedAssociations({}, { branch: "HEAD", prNumber: "not-a-number" });
    expect(merged.observed_branches).toEqual([]);
    expect(merged.observed_pr_numbers).toEqual([]);
  });
});

describe("bounded backoff", () => {
  it("grows exponentially and is capped", () => {
    const cfg = { maxAttempts: 6, baseMs: 10 * 60_000, maxMs: 60 * 60_000 };
    expect(computeBackoff(1, cfg).delayMs).toBe(10 * 60_000);
    expect(computeBackoff(2, cfg).delayMs).toBe(20 * 60_000);
    expect(computeBackoff(3, cfg).delayMs).toBe(40 * 60_000);
    expect(computeBackoff(4, cfg).delayMs).toBe(60 * 60_000);
  });

  it("exhausts at the attempt ceiling instead of retrying forever", () => {
    const cfg = { maxAttempts: 3, baseMs: 1000, maxMs: 10_000 };
    expect(computeBackoff(2, cfg).exhausted).toBe(false);
    expect(computeBackoff(3, cfg).exhausted).toBe(true);
    expect(computeBackoff(9, cfg).exhausted).toBe(true);
  });
});

describe("status dedup stays visible without spamming", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");

  it("posts a new key immediately", () => {
    expect(shouldPostStatus({}, "k", now).post).toBe(true);
  });

  it("suppresses the same key inside the window", () => {
    const keys = { k: new Date(now - 60_000).toISOString() };
    expect(shouldPostStatus(keys, "k", now, 6 * 3_600_000).post).toBe(false);
  });

  it("re-posts once the window has elapsed", () => {
    const keys = { k: new Date(now - 7 * 3_600_000).toISOString() };
    expect(shouldPostStatus(keys, "k", now, 6 * 3_600_000).post).toBe(true);
  });

  it("posts immediately when the REASON changes", () => {
    const keys = { [statusKey({ taskId: "T", phase: "p", reason: "a" })]: new Date(now).toISOString() };
    expect(shouldPostStatus(keys, statusKey({ taskId: "T", phase: "p", reason: "b" }), now).post).toBe(true);
  });
});

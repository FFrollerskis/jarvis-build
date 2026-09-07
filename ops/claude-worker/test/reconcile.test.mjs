/**
 * Requirement B/D acceptance tests: exit code 0 is not completion, a crash after
 * the report/PR must not duplicate effects, and backoff exhaustion must produce
 * a visible, deduplicated status.
 */

import { describe, it, expect } from "vitest";
import {
  assessCompletion, findTrustedReport, reconcilePriorAttempt,
  computeBackoff, shouldPostStatus, statusKey, slugForTask, DEFAULT_BACKOFF
} from "../lib/reconcile.mjs";

const TRUSTED = "tsworkflow";
const TASK = "WORKER-SELF-RECOVERY-20260907";
const DISPATCH_AT = "2026-09-07T01:09:30.000Z";

function comment(overrides = {}) {
  return {
    id: 1,
    user: { login: TRUSTED },
    created_at: "2026-09-07T01:40:00.000Z",
    body: `CLAUDE_REPORT\nTASK_ID=${TASK}\nSTATUS=COMPLETED\n`,
    ...overrides
  };
}

describe("acceptance: exit 0 without a matching report is NOT completion", () => {
  it("refuses to complete when no report exists at all", () => {
    const r = assessCompletion({ taskId: TASK, comments: [], trustedAuthor: TRUSTED, sinceIso: DISPATCH_AT });
    expect(r.complete).toBe(false);
    expect(r.reason).toBe("no_matching_trusted_report");
  });

  it("refuses a report for a DIFFERENT task id", () => {
    const other = comment({ body: "CLAUDE_REPORT\nTASK_ID=SOME-OTHER-TASK\nSTATUS=COMPLETED\n" });
    const r = assessCompletion({ taskId: TASK, comments: [other], trustedAuthor: TRUSTED, sinceIso: DISPATCH_AT });
    expect(r.complete).toBe(false);
  });

  it("refuses a report by an untrusted author", () => {
    const impostor = comment({ user: { login: "someone-else" } });
    const r = assessCompletion({ taskId: TASK, comments: [impostor], trustedAuthor: TRUSTED, sinceIso: DISPATCH_AT });
    expect(r.complete).toBe(false);
  });

  it("refuses a STALE report posted before this dispatch started", () => {
    const stale = comment({ created_at: "2026-09-05T10:00:00.000Z" });
    const r = assessCompletion({ taskId: TASK, comments: [stale], trustedAuthor: TRUSTED, sinceIso: DISPATCH_AT });
    expect(r.complete).toBe(false);
  });

  it("refuses an in-progress report as completion", () => {
    const partial = comment({ body: `CLAUDE_REPORT\nTASK_ID=${TASK}\nSTATUS=IN_PROGRESS\n` });
    const r = assessCompletion({ taskId: TASK, comments: [partial], trustedAuthor: TRUSTED, sinceIso: DISPATCH_AT });
    expect(r.complete).toBe(false);
    expect(r.reason).toMatch(/not_terminal/);
  });

  it("accepts a matching trusted report with a terminal status", () => {
    const r = assessCompletion({ taskId: TASK, comments: [comment()], trustedAuthor: TRUSTED, sinceIso: DISPATCH_AT });
    expect(r).toMatchObject({ complete: true, successful: true, status: "COMPLETED", reportCommentId: 1 });
  });

  it("closes a BLOCKED report as complete but explicitly NOT successful", () => {
    const blocked = comment({ body: `CLAUDE_REPORT\nTASK_ID=${TASK}\nSTATUS=BLOCKED\n` });
    const r = assessCompletion({ taskId: TASK, comments: [blocked], trustedAuthor: TRUSTED, sinceIso: DISPATCH_AT });
    expect(r.complete).toBe(true);
    expect(r.successful).toBe(false);
  });

  it("picks the newest matching report when several exist", () => {
    const older = comment({ id: 1, created_at: "2026-09-07T01:20:00.000Z" });
    const newer = comment({ id: 2, created_at: "2026-09-07T01:50:00.000Z" });
    const found = findTrustedReport([older, newer], { taskId: TASK, trustedAuthor: TRUSTED, sinceIso: DISPATCH_AT });
    expect(found.id).toBe(2);
  });
});

describe("acceptance: crash after report/PR/merge reconciles without duplicate effects", () => {
  const branches = ["main", "claude/worker-self-recovery-20260907"];
  const pulls = [{ number: 75, headRefName: "claude/worker-self-recovery-20260907", state: "closed", mergedAt: "2026-09-07T02:00:00Z" }];

  it("finds the existing report, branch and merged PR so a retry does not repeat them", () => {
    const rec = reconcilePriorAttempt({
      taskId: TASK, comments: [comment()], trustedAuthor: TRUSTED, branches, pulls, sinceIso: DISPATCH_AT
    });
    expect(rec.completion.complete).toBe(true);      // -> worker closes out, no re-dispatch
    expect(rec.existingBranch).toBe("claude/worker-self-recovery-20260907");
    expect(rec.existingPr).toMatchObject({ number: 75, merged: true });
    expect(rec.alreadyMerged).toBe(true);
  });

  it("surfaces an existing branch/PR even when the report is missing, so a retry RESUMES", () => {
    const rec = reconcilePriorAttempt({
      taskId: TASK, comments: [], trustedAuthor: TRUSTED, branches,
      pulls: [{ number: 75, headRefName: "claude/worker-self-recovery-20260907", state: "open", mergedAt: null }],
      sinceIso: DISPATCH_AT
    });
    expect(rec.completion.complete).toBe(false);     // still needs work...
    expect(rec.existingBranch).toBe("claude/worker-self-recovery-20260907"); // ...but reuses these
    expect(rec.existingPr).toMatchObject({ number: 75, merged: false });
    expect(rec.alreadyMerged).toBe(false);
  });

  it("reports no prior side effects for a first attempt", () => {
    const rec = reconcilePriorAttempt({
      taskId: TASK, comments: [], trustedAuthor: TRUSTED, branches: ["main"], pulls: [], sinceIso: null
    });
    expect(rec.existingBranch).toBeNull();
    expect(rec.existingPr).toBeNull();
    expect(rec.alreadyMerged).toBe(false);
  });

  it("derives a stable branch slug from a task id", () => {
    expect(slugForTask("WORKER-SELF-RECOVERY-20260907")).toBe("worker-self-recovery-20260907");
    expect(slugForTask("D125-POSTMERGE-LOCAL-CLOSEOUT-20260906T1924Z")).toBe("d125-postmerge-local-closeout-20260906t1924z");
  });
});

describe("acceptance: bounded backoff, no tight retry loop", () => {
  it("grows exponentially and then stops at the attempt ceiling", () => {
    const cfg = { maxAttempts: 4, baseMs: 600_000, maxMs: 21_600_000 };
    expect(computeBackoff(1, cfg)).toMatchObject({ exhausted: false, delayMs: 600_000 });
    expect(computeBackoff(2, cfg)).toMatchObject({ exhausted: false, delayMs: 1_200_000 });
    expect(computeBackoff(3, cfg)).toMatchObject({ exhausted: false, delayMs: 2_400_000 });
    expect(computeBackoff(4, cfg)).toMatchObject({ exhausted: true, delayMs: null });
    expect(computeBackoff(9, cfg).exhausted).toBe(true);
  });

  it("caps the delay so a task cannot be parked for an absurd time", () => {
    const cfg = { maxAttempts: 20, baseMs: 600_000, maxMs: 3_600_000 };
    expect(computeBackoff(10, cfg).delayMs).toBe(3_600_000);
  });

  it("has sane defaults", () => {
    expect(DEFAULT_BACKOFF.maxAttempts).toBeGreaterThan(1);
    expect(computeBackoff(1).delayMs).toBeGreaterThan(0);
  });
});

describe("acceptance: repeated failure is visible but deduplicated", () => {
  const KEY = statusKey({ taskId: TASK, phase: "preflight", reason: "worktree_dirty_unknown_files" });

  it("posts a brand-new status immediately", () => {
    expect(shouldPostStatus({}, KEY, Date.now()).post).toBe(true);
  });

  it("suppresses the identical status inside the repeat window", () => {
    const posted = { [KEY]: new Date(Date.now() - 60_000).toISOString() };
    expect(shouldPostStatus(posted, KEY, Date.now()).post).toBe(false);
  });

  it("re-posts the same status once the window elapses, so it never goes silent", () => {
    const posted = { [KEY]: new Date(Date.now() - 7 * 3_600_000).toISOString() };
    expect(shouldPostStatus(posted, KEY, Date.now(), 6 * 3_600_000).post).toBe(true);
  });

  it("posts immediately when the REASON changes, even inside the window", () => {
    const posted = { [KEY]: new Date(Date.now() - 60_000).toISOString() };
    const differentKey = statusKey({ taskId: TASK, phase: "dispatch", reason: "retry_budget_exhausted" });
    expect(shouldPostStatus(posted, differentKey, Date.now()).post).toBe(true);
  });

  it("recovers from an unparseable timestamp by posting rather than staying quiet", () => {
    expect(shouldPostStatus({ [KEY]: "not-a-date" }, KEY, Date.now()).post).toBe(true);
  });
});

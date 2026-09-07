import { describe, it, expect } from "vitest";

import { RECOVERY, planTaskRecovery, childLifetimeBudgetMs, describeProtectedChild } from "../lib/recovery.mjs";
import { IDENTITY, matchProcessIdentity, listDescendants, captureIdentity, parsePidList } from "../lib/procid.mjs";

const NOW = Date.parse("2026-09-07T02:00:00.000Z");
const BUDGET = childLifetimeBudgetMs({ claudeTimeoutMinutes: 55 });

const notComplete = { complete: false, reason: "no_matching_trusted_report" };
const complete = { complete: true, reportCommentId: 123, status: "COMPLETED", successful: true };

function crashedTask(overrides = {}) {
  return {
    task_id: "D126-CRASHED",
    status: "in_progress",
    attempts: 1,
    last_dispatch_at: new Date(NOW - 5 * 60_000).toISOString(),
    child_identity: {
      pid: 4242,
      host: "JARVIS-PC",
      start_time: "2026-09-07T01:55:00.0000000Z",
      observed_at: new Date(NOW - 5 * 60_000).toISOString()
    },
    ...overrides
  };
}

/**
 * D126 review blocker 1: "P1 permanent crash stall ... Recover abandoned tasks
 * under ownership lock, reconcile report first, persist child identity at spawn,
 * protect live orphan ... Do not use PID-only orphan checks."
 */
describe("blocker 1: a verifiably live child is protected", () => {
  it("protects a child whose identity MATCHES", () => {
    const plan = planTaskRecovery({
      task: crashedTask(),
      nowMs: NOW,
      completion: notComplete,
      identityVerdict: { state: IDENTITY.MATCH, reason: "pid 4242 is the same process" },
      lifetimeBudgetMs: BUDGET
    });
    expect(plan.action).toBe(RECOVERY.PROTECT_LIVE_CHILD);
  });

  it("does NOT protect a pid that has been reused", () => {
    const plan = planTaskRecovery({
      task: crashedTask(),
      nowMs: NOW,
      completion: notComplete,
      identityVerdict: { state: IDENTITY.REUSED, reason: "pid 4242 was reused" },
      lifetimeBudgetMs: BUDGET
    });
    expect(plan.action).toBe(RECOVERY.RETRY);
  });

  it("does NOT protect a child that is gone", () => {
    const plan = planTaskRecovery({
      task: crashedTask(),
      nowMs: NOW,
      completion: notComplete,
      identityVerdict: { state: IDENTITY.GONE, reason: "pid 4242 no longer exists" },
      lifetimeBudgetMs: BUDGET
    });
    expect(plan.action).toBe(RECOVERY.RETRY);
  });

  it("protects an UNPROVEN identity only inside the child's own lifetime budget", () => {
    const inside = planTaskRecovery({
      task: crashedTask(),
      nowMs: NOW,
      completion: notComplete,
      identityVerdict: { state: IDENTITY.UNPROVEN, reason: "start time unreadable" },
      lifetimeBudgetMs: BUDGET
    });
    expect(inside.action).toBe(RECOVERY.PROTECT_LIVE_CHILD);
    expect(inside.bounded).toBe(true);
  });

  it("NEVER blocks forever on an unprovable pid - pid reuse must not stall the loop", () => {
    const task = crashedTask({
      child_identity: {
        pid: 4242,
        host: "JARVIS-PC",
        start_time: "2026-09-07T01:55:00.0000000Z",
        observed_at: new Date(NOW - BUDGET - 60 * 60_000).toISOString()
      }
    });
    const plan = planTaskRecovery({
      task,
      nowMs: NOW,
      completion: notComplete,
      identityVerdict: { state: IDENTITY.UNPROVEN, reason: "start time unreadable" },
      lifetimeBudgetMs: BUDGET
    });
    expect(plan.action).toBe(RECOVERY.RETRY);
  });

  it("a task with no recorded child identity is simply retried, never blocked", () => {
    const plan = planTaskRecovery({
      task: crashedTask({ child_identity: null }),
      nowMs: NOW,
      completion: notComplete,
      identityVerdict: null,
      lifetimeBudgetMs: BUDGET
    });
    expect(plan.action).toBe(RECOVERY.RETRY);
  });
});

describe("blocker 1: the report is reconciled before anything is re-run", () => {
  it("closes the task out when a matching trusted report already exists", () => {
    const plan = planTaskRecovery({
      task: crashedTask(),
      nowMs: NOW,
      completion: complete,
      identityVerdict: { state: IDENTITY.GONE, reason: "gone" },
      lifetimeBudgetMs: BUDGET
    });
    expect(plan.action).toBe(RECOVERY.COMPLETE_FROM_REPORT);
    expect(plan.completion.reportCommentId).toBe(123);
  });

  it("a live child still wins over a report: nothing is decided under a running process", () => {
    const plan = planTaskRecovery({
      task: crashedTask(),
      nowMs: NOW,
      completion: complete,
      identityVerdict: { state: IDENTITY.MATCH, reason: "alive" },
      lifetimeBudgetMs: BUDGET
    });
    expect(plan.action).toBe(RECOVERY.PROTECT_LIVE_CHILD);
  });
});

describe("blocker 1 + 6: never re-dispatch while duplicate risk is unknown", () => {
  it("defers when the branch/PR lookup failed", () => {
    const plan = planTaskRecovery({
      task: crashedTask(),
      nowMs: NOW,
      completion: notComplete,
      identityVerdict: { state: IDENTITY.GONE, reason: "gone" },
      lifetimeBudgetMs: BUDGET,
      duplicateRiskUnknown: true
    });
    expect(plan.action).toBe(RECOVERY.DEFER_UNKNOWN);
  });

  it("but a completed report still closes it out even when the lookup failed", () => {
    const plan = planTaskRecovery({
      task: crashedTask(),
      nowMs: NOW,
      completion: complete,
      identityVerdict: { state: IDENTITY.GONE, reason: "gone" },
      lifetimeBudgetMs: BUDGET,
      duplicateRiskUnknown: true
    });
    expect(plan.action).toBe(RECOVERY.COMPLETE_FROM_REPORT);
  });
});

describe("process identity is never a bare pid", () => {
  it("MATCH requires pid AND start time", () => {
    const identity = { pid: 10, host: "H", start_time: "S" };
    expect(matchProcessIdentity(identity, { host: "H", alive: () => true, startTime: () => "S" }).state).toBe(IDENTITY.MATCH);
    expect(matchProcessIdentity(identity, { host: "H", alive: () => true, startTime: () => "OTHER" }).state).toBe(IDENTITY.REUSED);
    expect(matchProcessIdentity(identity, { host: "H", alive: () => true, startTime: () => null }).state).toBe(IDENTITY.UNPROVEN);
    expect(matchProcessIdentity(identity, { host: "H", alive: () => false }).state).toBe(IDENTITY.GONE);
  });

  it("an identity with no recorded start time is UNPROVEN, never MATCH", () => {
    const identity = { pid: 10, host: "H", start_time: null };
    expect(matchProcessIdentity(identity, { host: "H", alive: () => true, startTime: () => "S" }).state).toBe(IDENTITY.UNPROVEN);
  });

  it("an identity from another host is never acted on here", () => {
    const identity = { pid: 10, host: "ELSEWHERE", start_time: "S" };
    expect(matchProcessIdentity(identity, { host: "H", alive: () => true }).state).toBe(IDENTITY.FOREIGN_HOST);
  });

  it("captures a real identity for this very process", () => {
    const identity = captureIdentity(process.pid);
    expect(identity.pid).toBe(process.pid);
    expect(typeof identity.host).toBe("string");
    expect(typeof identity.observed_at).toBe("string");
  });
});

describe("descendants are accounted for, bounded, and cycle-safe", () => {
  it("walks a tree", () => {
    const tree = { 1: [2, 3], 2: [4], 3: [], 4: [] };
    expect(listDescendants(1, { children: (pid) => tree[pid] ?? [] }).sort()).toEqual([2, 3, 4]);
  });

  it("cannot spin on a cycle", () => {
    const tree = { 1: [2], 2: [1, 3], 3: [2] };
    expect(listDescendants(1, { children: (pid) => tree[pid] ?? [] }).sort()).toEqual([2, 3]);
  });

  it("is bounded", () => {
    const children = (pid) => [pid * 2, pid * 2 + 1];
    expect(listDescendants(1, { children, maxNodes: 10 }).length).toBeLessThanOrEqual(11);
  });

  it("parses a pid list defensively", () => {
    expect(parsePidList("12\r\n0\n-3\nnot-a-pid\n44\n")).toEqual([12, 44]);
  });
});

describe("the protected-orphan report tells the operator what is running", () => {
  it("names the pid, the identity verdict and the descendants, and states nothing was killed", () => {
    const text = describeProtectedChild({
      task: crashedTask(),
      identityVerdict: { state: IDENTITY.MATCH, reason: "same process" },
      descendants: [11, 12]
    });
    expect(text).toMatch(/CHILD_PID=4242/);
    expect(text).toMatch(/CHILD_START_TIME=2026-09-07T01:55/);
    expect(text).toMatch(/DESCENDANT_PIDS=11, 12/);
    expect(text).toMatch(/Nothing was terminated/);
  });
});

describe("the child lifetime budget follows the configured timeout", () => {
  it("is the claude timeout plus a grace", () => {
    expect(childLifetimeBudgetMs({ claudeTimeoutMinutes: 55 })).toBe(65 * 60_000);
    expect(childLifetimeBudgetMs({ claudeTimeoutMinutes: 10, graceMinutes: 5 })).toBe(15 * 60_000);
  });
});

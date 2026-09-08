/**
 * Supervisor acceptance tests (scope update).
 *
 * The central safety property: a live, long-running Claude job is HEALTHY WORK
 * and must never be restarted, while a worker that has genuinely stopped
 * consuming the queue must be recovered without any manual PowerShell.
 */

import { describe, it, expect } from "vitest";
import { assessWorker, planAutonomousAction, planCommandedRestart, restartsInWindow, WORKER_VERDICT } from "../lib/supervise.mjs";
import { HEALTH_EVENTS } from "../lib/health.mjs";
import { assertSafeTaskName } from "../lib/wintask.mjs";

const NOW = Date.parse("2026-09-07T03:00:00.000Z");
const HOST = "TOBIAS-PC";
const DEAD_MS = 30 * 60_000;

const readyTask = { exists: true, state: "Ready", lastTaskResult: 0 };
const aliveAlways = () => true;
const deadAlways = () => false;

function pollEvent(iso) {
  return { ts: iso, event: HEALTH_EVENTS.QUEUE_POLLED, comment_count: 12 };
}

describe("acceptance: a live long-running job is preserved, never restarted", () => {
  it("classifies an actively heartbeating worker as BUSY", () => {
    const lockInfo = {
      pid: 932, host: HOST,
      started_at: "2026-09-07T02:10:00.000Z",   // 50 minutes of legitimate work
      heartbeat_at: "2026-09-07T02:59:30.000Z", // beating 30s ago
      phase: "dispatch", child_pid: 4242
    };
    const a = assessWorker({
      healthEvents: [pollEvent("2026-09-07T02:10:00.000Z")],
      lockInfo, scheduledTask: readyTask, workerDisabled: false,
      nowMs: NOW, deadWorkerMs: DEAD_MS,
      lockOpts: { host: HOST, alive: aliveAlways, startTime: () => null }
    });
    expect(a.verdict).toBe(WORKER_VERDICT.BUSY);

    // Neither autonomous recovery nor an explicit command may interrupt it.
    expect(planAutonomousAction({ assessment: a, journal: [], nowMs: NOW, budgetPerDay: 4, backoffMs: 0, lastRestartAt: null }).action).toBe("none");
    const commanded = planCommandedRestart({ assessment: a });
    expect(commanded.action).toBe("defer");
    expect(commanded.reason).toMatch(/No process was terminated/);
  });

  it("does not treat a stale queue poll as death while the lock is active", () => {
    // The poll is old precisely BECAUSE a long dispatch is in flight.
    const a = assessWorker({
      healthEvents: [pollEvent("2026-09-07T01:00:00.000Z")], // 2 hours old
      lockInfo: { pid: 932, host: HOST, started_at: "2026-09-07T01:00:00.000Z", heartbeat_at: "2026-09-07T02:59:50.000Z", phase: "dispatch" },
      scheduledTask: readyTask, workerDisabled: false, nowMs: NOW, deadWorkerMs: DEAD_MS,
      lockOpts: { host: HOST, alive: aliveAlways, startTime: () => null }
    });
    expect(a.verdict).toBe(WORKER_VERDICT.BUSY);
  });
});

describe("acceptance: a demonstrably dead worker is recovered", () => {
  it("classifies a silent queue with no lock as DEAD and plans a restart", () => {
    const a = assessWorker({
      healthEvents: [pollEvent("2026-09-07T01:00:00.000Z")], // 2h > 30min budget
      lockInfo: null, scheduledTask: readyTask, workerDisabled: false,
      nowMs: NOW, deadWorkerMs: DEAD_MS
    });
    expect(a.verdict).toBe(WORKER_VERDICT.DEAD);

    const plan = planAutonomousAction({ assessment: a, journal: [], nowMs: NOW, budgetPerDay: 4, backoffMs: 10 * 60_000, lastRestartAt: null });
    expect(plan.action).toBe("restart");
  });

  it("treats a dead lock owner as no obstacle to recovery", () => {
    const a = assessWorker({
      healthEvents: [pollEvent("2026-09-07T01:00:00.000Z")],
      lockInfo: { pid: 4242, host: HOST, started_at: "2026-09-07T01:00:00.000Z", heartbeat_at: "2026-09-07T01:00:00.000Z" },
      scheduledTask: readyTask, workerDisabled: false, nowMs: NOW, deadWorkerMs: DEAD_MS,
      lockOpts: { host: HOST, alive: deadAlways }
    });
    expect(a.verdict).toBe(WORKER_VERDICT.DEAD);
  });

  it("distinguishes a Ready/exit-0 Windows task from a healthy queue", () => {
    // The exact false-signal the architect called out: the scheduler looks fine.
    const a = assessWorker({
      healthEvents: [], // ...but the queue was NEVER polled
      lockInfo: null, scheduledTask: { exists: true, state: "Ready", lastTaskResult: 0 },
      workerDisabled: false, nowMs: NOW, deadWorkerMs: DEAD_MS
    });
    expect(a.verdict).toBe(WORKER_VERDICT.DEAD);
    expect(a.reason).toMatch(/never recorded a queue poll/);
    expect(a.health.scheduler_is_firing).toBe(false);
    expect(a.health.work_is_being_completed).toBe(false);
  });

  it("recovers a recently-polling worker as HEALTHY and does nothing", () => {
    const a = assessWorker({
      healthEvents: [pollEvent("2026-09-07T02:57:00.000Z")],
      lockInfo: null, scheduledTask: readyTask, workerDisabled: false, nowMs: NOW, deadWorkerMs: DEAD_MS
    });
    expect(a.verdict).toBe(WORKER_VERDICT.HEALTHY);
    expect(planAutonomousAction({ assessment: a, journal: [], nowMs: NOW, budgetPerDay: 4, backoffMs: 0, lastRestartAt: null }).action).toBe("none");
  });
});

describe("acceptance: never force-recover what cannot be proven dead", () => {
  it("reports blocked instead of restarting when liveness is unknown", () => {
    const a = assessWorker({
      healthEvents: [pollEvent("2026-09-07T01:00:00.000Z")],
      lockInfo: { pid: 932, host: HOST, started_at: "2026-09-07T00:00:00.000Z", heartbeat_at: "2026-09-07T00:05:00.000Z" },
      scheduledTask: readyTask, workerDisabled: false, nowMs: NOW, deadWorkerMs: DEAD_MS,
      lockOpts: { host: HOST, alive: aliveAlways, startTime: () => null } // alive but silent
    });
    expect(a.verdict).toBe(WORKER_VERDICT.UNKNOWN);
    expect(planAutonomousAction({ assessment: a, journal: [], nowMs: NOW, budgetPerDay: 4, backoffMs: 0, lastRestartAt: null }).action).toBe("report_blocked");
    expect(planCommandedRestart({ assessment: a }).action).toBe("defer");
  });

  it("does not override an operator who deliberately disabled the worker", () => {
    const a = assessWorker({
      healthEvents: [], lockInfo: null, scheduledTask: readyTask, workerDisabled: true, nowMs: NOW, deadWorkerMs: DEAD_MS
    });
    expect(a.verdict).toBe(WORKER_VERDICT.DISABLED);
    expect(planAutonomousAction({ assessment: a, journal: [], nowMs: NOW, budgetPerDay: 4, backoffMs: 0, lastRestartAt: null }).action).toBe("none");
    expect(planCommandedRestart({ assessment: a }).action).toBe("report_blocked");
  });

  it("reports rather than restarts when the task is not registered at all", () => {
    const a = assessWorker({
      healthEvents: [], lockInfo: null, scheduledTask: { exists: false }, workerDisabled: false, nowMs: NOW, deadWorkerMs: DEAD_MS
    });
    expect(a.verdict).toBe(WORKER_VERDICT.UNKNOWN);
  });
});

describe("acceptance: bounded restarts, backoff, and no repeated completed actions", () => {
  const deadAssessment = {
    verdict: WORKER_VERDICT.DEAD,
    reason: "last queue poll is 120 min old",
    health: {}
  };

  it("stops restarting once the daily budget is spent", () => {
    const journal = Array.from({ length: 4 }, (_, i) => ({
      ts: new Date(NOW - (i + 1) * 3_600_000).toISOString(), action: "restart_started"
    }));
    expect(restartsInWindow(journal, NOW)).toBe(4);
    const plan = planAutonomousAction({ assessment: deadAssessment, journal, nowMs: NOW, budgetPerDay: 4, backoffMs: 0, lastRestartAt: null });
    expect(plan.action).toBe("report_blocked");
    expect(plan.reason).toMatch(/budget exhausted/);
  });

  it("ignores restarts that fall outside the 24h window", () => {
    const old = [{ ts: new Date(NOW - 30 * 3_600_000).toISOString(), action: "restart_started" }];
    expect(restartsInWindow(old, NOW)).toBe(0);
  });

  it("defers while the backoff window is still open, instead of looping", () => {
    const plan = planAutonomousAction({
      assessment: deadAssessment, journal: [], nowMs: NOW,
      budgetPerDay: 4, backoffMs: 10 * 60_000,
      lastRestartAt: new Date(NOW - 2 * 60_000).toISOString()
    });
    expect(plan.action).toBe("defer");
  });

  it("restarts again once the backoff window has elapsed", () => {
    const plan = planAutonomousAction({
      assessment: deadAssessment, journal: [], nowMs: NOW,
      budgetPerDay: 4, backoffMs: 10 * 60_000,
      lastRestartAt: new Date(NOW - 20 * 60_000).toISOString()
    });
    expect(plan.action).toBe("restart");
  });
});

describe("the supervisor can only ever name its own configured task", () => {
  it("accepts a plain task name", () => {
    expect(assertSafeTaskName("JarvisClaudeWorker")).toBe("JarvisClaudeWorker");
  });

  it("rejects anything that could carry an injection", () => {
    for (const bad of ["Jarvis'; Remove-Item C:\\ -Recurse", "a b", "", "../evil", "task$(whoami)", null, "x".repeat(65)]) {
      expect(() => assertSafeTaskName(bad)).toThrow();
    }
  });
});

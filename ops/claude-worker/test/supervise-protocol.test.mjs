import { describe, it, expect } from "vitest";

import {
  planCommandedRestart,
  planAutonomousAction,
  planIntentReconciliation,
  restartsInWindow,
  INTENT_STAGE,
  WORKER_VERDICT,
  assessWorker
} from "../lib/supervise.mjs";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const HOUR = 3_600_000;

function journalWith(entries) {
  return entries.map((e) => ({ action: "restart_started", ...e }));
}

/**
 * D126 review blocker 5:
 * "commanded restarts bypass the daily budget/backoff (only autonomous path
 *  applies them)."
 */
describe("blocker 5: a commanded restart is NOT a budget bypass", () => {
  const healthy = { verdict: WORKER_VERDICT.HEALTHY, reason: "queue polled 1 min ago" };

  it("refuses a commanded restart once the daily budget is spent", () => {
    const journal = journalWith([
      { ts: new Date(NOW - HOUR).toISOString(), intent_id: "i1" },
      { ts: new Date(NOW - 2 * HOUR).toISOString(), intent_id: "i2" }
    ]);
    const plan = planCommandedRestart({
      assessment: healthy,
      journal,
      nowMs: NOW,
      budgetPerDay: 2,
      backoffMs: 0,
      lastRestartAt: null
    });
    expect(plan.action).toBe("report_blocked");
    expect(plan.reason).toMatch(/budget exhausted \(2\/2/);
  });

  it("defers a commanded restart while the backoff window is open", () => {
    const plan = planCommandedRestart({
      assessment: healthy,
      journal: [],
      nowMs: NOW,
      budgetPerDay: 4,
      backoffMs: 10 * 60_000,
      lastRestartAt: new Date(NOW - 60_000).toISOString()
    });
    expect(plan.action).toBe("defer");
    expect(plan.reason).toMatch(/backoff active/);
  });

  it("allows it once budget and backoff both permit", () => {
    const plan = planCommandedRestart({
      assessment: healthy,
      journal: [],
      nowMs: NOW,
      budgetPerDay: 4,
      backoffMs: 10 * 60_000,
      lastRestartAt: new Date(NOW - 30 * 60_000).toISOString()
    });
    expect(plan.action).toBe("restart");
  });

  it("still defers - never interrupts - when the worker is busy, whatever the budget says", () => {
    const plan = planCommandedRestart({
      assessment: { verdict: WORKER_VERDICT.BUSY, reason: "lock is active" },
      journal: [],
      nowMs: NOW,
      budgetPerDay: 99,
      backoffMs: 0
    });
    expect(plan.action).toBe("defer");
    expect(plan.reason).toMatch(/No process was terminated/);
  });

  it("still refuses to force a restart it cannot prove is safe", () => {
    const plan = planCommandedRestart({
      assessment: { verdict: WORKER_VERDICT.UNKNOWN, reason: "lock owner alive but not heartbeating" },
      journal: [],
      nowMs: NOW,
      budgetPerDay: 99,
      backoffMs: 0
    });
    expect(plan.action).toBe("defer");
  });

  it("the autonomous path is gated identically", () => {
    const dead = { verdict: WORKER_VERDICT.DEAD, reason: "never polled" };
    expect(planAutonomousAction({ assessment: dead, journal: journalWith([{ ts: new Date(NOW).toISOString(), intent_id: "a" }]), nowMs: NOW, budgetPerDay: 1, backoffMs: 0 }).action)
      .toBe("report_blocked");
  });
});

describe("blocker 5: budget counts distinct INTENTS, so re-driving one is not two restarts", () => {
  it("counts one intent that produced two journal lines as one restart", () => {
    const journal = journalWith([
      { ts: new Date(NOW - HOUR).toISOString(), intent_id: "same" },
      { ts: new Date(NOW - HOUR + 1000).toISOString(), intent_id: "same" }
    ]);
    expect(restartsInWindow(journal, NOW)).toBe(1);
  });

  it("counts distinct intents separately", () => {
    const journal = journalWith([
      { ts: new Date(NOW - HOUR).toISOString(), intent_id: "a" },
      { ts: new Date(NOW - HOUR).toISOString(), intent_id: "b" }
    ]);
    expect(restartsInWindow(journal, NOW)).toBe(2);
  });

  it("ignores restarts outside the 24h window", () => {
    const journal = journalWith([{ ts: new Date(NOW - 30 * HOUR).toISOString(), intent_id: "old" }]);
    expect(restartsInWindow(journal, NOW)).toBe(0);
  });
});

/**
 * "performRestart marks command executed BEFORE the start, never reconciles
 *  pending intent on next run, so crash before start loses request permanently."
 */
describe("blocker 5: an interrupted intent is reconciled from host evidence", () => {
  const health = (invokedIso, polledIso) => ({
    last_scheduler_invocation: invokedIso,
    last_queue_poll: polledIso
  });

  it("crash BEFORE the start: the effect never happened, so it is re-driven", () => {
    const intent = { stage: INTENT_STAGE.INTENT, created_at: new Date(NOW).toISOString() };
    const plan = planIntentReconciliation({
      intent,
      nowMs: NOW + 60_000,
      workerHealth: health(new Date(NOW - 60_000).toISOString(), null)
    });
    expect(plan.action).toBe("retry_effect");
    expect(plan.reason).toMatch(/never attempted|no effect has occurred/);
  });

  it("crash AFTER the start, with host evidence: confirmed, and NOT repeated", () => {
    const intent = { stage: INTENT_STAGE.EFFECT_ATTEMPTED, created_at: new Date(NOW).toISOString() };
    const plan = planIntentReconciliation({
      intent,
      nowMs: NOW + 5 * 60_000,
      workerHealth: health(new Date(NOW + 1000).toISOString(), null)
    });
    expect(plan.action).toBe("confirm");
  });

  it("crash AFTER the start, no evidence yet: UNCERTAIN, never a blind repeat", () => {
    const intent = { stage: INTENT_STAGE.EFFECT_ATTEMPTED, created_at: new Date(NOW).toISOString() };
    const plan = planIntentReconciliation({
      intent,
      nowMs: NOW + 60_000,
      workerHealth: health(new Date(NOW - 60_000).toISOString(), null)
    });
    expect(plan.action).toBe("uncertain");
  });

  it("crash AFTER the start, still nothing after the evidence window: the effect did not take", () => {
    const intent = { stage: INTENT_STAGE.EFFECT_ATTEMPTED, created_at: new Date(NOW).toISOString() };
    const plan = planIntentReconciliation({
      intent,
      nowMs: NOW + 25 * 60_000,
      workerHealth: health(new Date(NOW - 60_000).toISOString(), null)
    });
    expect(plan.action).toBe("retry_effect");
  });

  it("a settled result with a missing receipt retries ONLY the receipt", () => {
    const intent = { stage: INTENT_STAGE.RESULT_RECORDED, receipt_posted: false, created_at: new Date(NOW).toISOString(), result: { ok: true } };
    expect(planIntentReconciliation({ intent, nowMs: NOW + 60_000, workerHealth: {} }).action).toBe("post_receipt");
  });

  it("a fully settled intent is cleared", () => {
    const intent = { stage: INTENT_STAGE.RESULT_RECORDED, receipt_posted: true, created_at: new Date(NOW).toISOString() };
    expect(planIntentReconciliation({ intent, nowMs: NOW, workerHealth: {} }).action).toBe("clear");
  });

  it("no intent at all is a no-op", () => {
    expect(planIntentReconciliation({ intent: null, nowMs: NOW, workerHealth: {} }).action).toBe("clear");
  });

  it("a queue poll counts as evidence too, not only a scheduler invocation", () => {
    const intent = { stage: INTENT_STAGE.EFFECT_ATTEMPTED, created_at: new Date(NOW).toISOString() };
    const plan = planIntentReconciliation({ intent, nowMs: NOW + 60_000, workerHealth: health(null, new Date(NOW + 500).toISOString()) });
    expect(plan.action).toBe("confirm");
  });
});

describe("a scheduled-task query that FAILED is not 'the task is not registered'", () => {
  it("reports UNKNOWN rather than assuming anything", () => {
    const assessment = assessWorker({
      healthEvents: [],
      lockInfo: null,
      scheduledTask: { exists: false, query_failed: true, error: "Access is denied" },
      workerDisabled: false,
      nowMs: NOW,
      deadWorkerMs: 30 * 60_000
    });
    expect(assessment.verdict).toBe(WORKER_VERDICT.UNKNOWN);
    expect(assessment.reason).toMatch(/could not be queried/);
  });

  it("an unprovable lock owner is UNKNOWN, never DEAD", () => {
    const assessment = assessWorker({
      healthEvents: [],
      lockInfo: { pid: 4242, host: "H", start_time: "S", heartbeat_at: new Date(NOW).toISOString() },
      scheduledTask: { exists: true, state: "Ready" },
      workerDisabled: false,
      nowMs: NOW,
      deadWorkerMs: 30 * 60_000,
      lockOpts: { host: "H", alive: () => true, startTime: () => null }
    });
    expect(assessment.verdict).toBe(WORKER_VERDICT.UNKNOWN);
  });
});

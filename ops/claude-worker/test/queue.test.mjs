/**
 * D132: deterministic queue selection, eligibility and supersession.
 *
 * The centrepiece is `reproduces the exact D-131 sequence`, which replays the
 * real timeline recorded in the host's `state.json` on 2026-09-11 and proves the
 * old recovery task is never dispatched again.
 */

import { describe, it, expect } from "vitest";

import { selectNextTask, INELIGIBLE, TIER } from "../lib/queue.mjs";
import { TASK_STATUS, defaultState, upsertTask } from "../lib/state.mjs";

const TRUSTED = "tsworkflow";

function taskEntry(taskId, createdAt, id) {
  return {
    taskId,
    comment: { id, created_at: createdAt, user: { login: TRUSTED }, body: `ARCHITECT_TASK\nTASK_ID=${taskId}` },
    updates: []
  };
}

function report(taskId, status, createdAt, id) {
  return {
    id,
    created_at: createdAt,
    user: { login: TRUSTED },
    body: `CLAUDE_REPORT\nTASK_ID=${taskId}\nSTATUS=${status}`
  };
}

function stateWith(records) {
  const state = defaultState();
  for (const [taskId, patch] of Object.entries(records)) upsertTask(state, taskId, patch);
  return state;
}

const NOW = Date.parse("2026-09-11T06:00:00Z");

describe("D132 root cause 2: an older task can never preempt a newer one", () => {
  it("a never-dispatched NEW task outranks an eligible retry of an OLD task", () => {
    const tasks = [
      taskEntry("OLD-TASK", "2026-09-11T04:18:00Z", 100),
      taskEntry("NEW-TASK", "2026-09-11T05:23:00Z", 200)
    ];
    const state = stateWith({
      "OLD-TASK": {
        status: TASK_STATUS.FAILED_RETRYABLE,
        attempts: 2,
        first_dispatch_at: "2026-09-11T04:18:05Z",
        next_eligible_at: "2026-09-11T05:00:00Z" // backoff long elapsed
      }
    });

    const sel = selectNextTask({ tasks, state, comments: [], trustedAuthor: TRUSTED, nowMs: NOW });

    expect(sel.candidate.taskId).toBe("NEW-TASK");
    expect(sel.candidateTier).toBe(TIER.FRESH);
  });

  it("the OLD ordering (oldest-first find) would have chosen the old task - this is the regression", () => {
    // Documents the exact defect: under the previous selection the first
    // eligible task in oldest-first order won, which is OLD-TASK.
    const tasks = [
      taskEntry("OLD-TASK", "2026-09-11T04:18:00Z", 100),
      taskEntry("NEW-TASK", "2026-09-11T05:23:00Z", 200)
    ];
    const oldBehaviour = tasks.find((t) => t.taskId === "OLD-TASK" || t.taskId === "NEW-TASK");
    expect(oldBehaviour.taskId).toBe("OLD-TASK");
  });

  it("among several retries the NEWEST is chosen, closest to current repo truth", () => {
    const tasks = [
      taskEntry("RETRY-OLD", "2026-09-11T01:00:00Z", 1),
      taskEntry("RETRY-MID", "2026-09-11T02:00:00Z", 2),
      taskEntry("RETRY-NEW", "2026-09-11T03:00:00Z", 3)
    ];
    const state = stateWith({
      "RETRY-OLD": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T01:05:00Z" },
      "RETRY-MID": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T02:05:00Z" },
      "RETRY-NEW": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T03:05:00Z" }
    });

    const sel = selectNextTask({ tasks, state, comments: [], trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.candidate.taskId).toBe("RETRY-NEW");
    expect(sel.candidateTier).toBe(TIER.RETRY);
  });

  it("among several FRESH tasks the architect's own order is preserved (oldest first)", () => {
    const tasks = [
      taskEntry("FRESH-A", "2026-09-11T01:00:00Z", 1),
      taskEntry("FRESH-B", "2026-09-11T02:00:00Z", 2)
    ];
    const sel = selectNextTask({ tasks, state: defaultState(), comments: [], trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.candidate.taskId).toBe("FRESH-A");
  });

  it("ordering is total and deterministic when timestamps collide", () => {
    const tasks = [
      taskEntry("SAME-B", "2026-09-11T01:00:00Z", 20),
      taskEntry("SAME-A", "2026-09-11T01:00:00Z", 10)
    ];
    const run = () => selectNextTask({
      tasks: [...tasks], state: defaultState(), comments: [], trustedAuthor: TRUSTED, nowMs: NOW
    }).candidate.taskId;
    // Fresh tier breaks ties on ascending comment id, and repeats identically.
    expect(run()).toBe("SAME-A");
    expect(run()).toBe("SAME-A");
  });
});

describe("D132: a trusted terminal report retires a task, whatever local state says", () => {
  it("a COMPLETE report retires a task the state file still calls failed_retryable", () => {
    const tasks = [taskEntry("DONE-TASK", "2026-09-11T04:00:00Z", 100)];
    const state = stateWith({
      "DONE-TASK": {
        status: TASK_STATUS.FAILED_RETRYABLE,
        attempts: 3,
        first_dispatch_at: "2026-09-11T04:05:00Z",
        // The exact stale reason recorded on the host.
        last_failure_reason: "exit_0_without_matching_report (report_status_not_terminal (COMPLETE))"
      }
    });
    const comments = [report("DONE-TASK", "COMPLETE", "2026-09-11T04:49:30Z", 900)];

    const sel = selectNextTask({ tasks, state, comments, trustedAuthor: TRUSTED, nowMs: NOW });

    expect(sel.candidate).toBeNull();
    expect(sel.completedByReportTaskIds).toContain("DONE-TASK");
    const d = sel.decisions.find((x) => x.taskId === "DONE-TASK");
    expect(d.reason).toBe(INELIGIBLE.TERMINAL_REPORT);
  });

  it("a report with an UNRECOGNISED status is never a reason to retry", () => {
    const tasks = [taskEntry("WEIRD-TASK", "2026-09-11T04:00:00Z", 100)];
    const state = stateWith({
      "WEIRD-TASK": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T04:05:00Z" }
    });
    const comments = [report("WEIRD-TASK", "MOSTLY_THERE_ISH", "2026-09-11T04:49:30Z", 900)];

    const sel = selectNextTask({ tasks, state, comments, trustedAuthor: TRUSTED, nowMs: NOW });

    expect(sel.candidate).toBeNull();
    expect(sel.unrecognisedStatusTaskIds).toContain("WEIRD-TASK");
  });

  it("STATUS=IN_PROGRESS is recognised progress and stays retryable", () => {
    const tasks = [taskEntry("BUSY-TASK", "2026-09-11T04:00:00Z", 100)];
    const state = stateWith({
      "BUSY-TASK": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T04:05:00Z" }
    });
    const comments = [report("BUSY-TASK", "IN_PROGRESS", "2026-09-11T04:49:30Z", 900)];

    const sel = selectNextTask({ tasks, state, comments, trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.candidate.taskId).toBe("BUSY-TASK");
    expect(sel.unrecognisedStatusTaskIds).toHaveLength(0);
  });

  it("an untrusted author's terminal report retires nothing", () => {
    const tasks = [taskEntry("DONE-TASK", "2026-09-11T04:00:00Z", 100)];
    const state = stateWith({
      "DONE-TASK": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T04:05:00Z" }
    });
    const comments = [{
      id: 900,
      created_at: "2026-09-11T04:49:30Z",
      user: { login: "someone-else" },
      body: "CLAUDE_REPORT\nTASK_ID=DONE-TASK\nSTATUS=COMPLETE"
    }];

    const sel = selectNextTask({ tasks, state, comments, trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.candidate.taskId).toBe("DONE-TASK");
  });
});

describe("D132: supersession retires stale orders instead of replaying them", () => {
  it("a non-terminal OLD task is superseded once a strictly NEWER task completes", () => {
    const tasks = [
      taskEntry("OLD-TASK", "2026-09-11T04:18:00Z", 100),
      taskEntry("NEW-TASK", "2026-09-11T05:23:00Z", 200)
    ];
    const state = stateWith({
      "OLD-TASK": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 3, first_dispatch_at: "2026-09-11T04:18:05Z" },
      "NEW-TASK": { status: TASK_STATUS.COMPLETED, attempts: 1, first_dispatch_at: "2026-09-11T05:23:05Z" }
    });

    const sel = selectNextTask({ tasks, state, comments: [], trustedAuthor: TRUSTED, nowMs: NOW });

    expect(sel.candidate).toBeNull();
    expect(sel.supersededTaskIds).toEqual(["OLD-TASK"]);
    expect(sel.supersededBy).toBe("NEW-TASK");
  });

  it("a NEWER task is never superseded by an older completed one", () => {
    const tasks = [
      taskEntry("OLD-DONE", "2026-09-11T04:00:00Z", 100),
      taskEntry("NEW-PENDING", "2026-09-11T05:00:00Z", 200)
    ];
    const state = stateWith({
      "OLD-DONE": { status: TASK_STATUS.COMPLETED, attempts: 1, first_dispatch_at: "2026-09-11T04:05:00Z" }
    });

    const sel = selectNextTask({ tasks, state, comments: [], trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.candidate.taskId).toBe("NEW-PENDING");
    expect(sel.supersededTaskIds).toHaveLength(0);
  });

  it("a merely-dispatched (not completed) newer task supersedes nothing", () => {
    const tasks = [
      taskEntry("OLD-TASK", "2026-09-11T04:00:00Z", 100),
      taskEntry("NEW-TASK", "2026-09-11T05:00:00Z", 200)
    ];
    const state = stateWith({
      "OLD-TASK": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T04:05:00Z" },
      "NEW-TASK": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T05:05:00Z" }
    });

    const sel = selectNextTask({ tasks, state, comments: [], trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.supersededTaskIds).toHaveLength(0);
    expect(sel.candidate.taskId).toBe("NEW-TASK");
  });

  it("supersession is driven by FRESH comments even when worker state is stale", () => {
    // The newer task's completion exists ONLY as a trusted report; the state
    // file has not caught up. The old task must still be retired.
    const tasks = [
      taskEntry("OLD-TASK", "2026-09-11T04:18:00Z", 100),
      taskEntry("NEW-TASK", "2026-09-11T05:23:00Z", 200)
    ];
    const state = stateWith({
      "OLD-TASK": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 3, first_dispatch_at: "2026-09-11T04:18:05Z" },
      "NEW-TASK": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 2, first_dispatch_at: "2026-09-11T05:23:05Z" }
    });
    const comments = [report("NEW-TASK", "COMPLETE", "2026-09-11T05:45:00Z", 900)];

    const sel = selectNextTask({ tasks, state, comments, trustedAuthor: TRUSTED, nowMs: NOW });

    expect(sel.supersededTaskIds).toEqual(["OLD-TASK"]);
    expect(sel.candidate).toBeNull();
  });
});

describe("D132: terminal state cannot be resurrected", () => {
  for (const status of [TASK_STATUS.COMPLETED, TASK_STATUS.BLOCKED, TASK_STATUS.SUPERSEDED]) {
    it(`a ${status} task is never dispatched, even with an elapsed backoff clock`, () => {
      const tasks = [taskEntry("T", "2026-09-11T04:00:00Z", 100)];
      const state = stateWith({
        T: { status, attempts: 4, next_eligible_at: "2026-09-01T00:00:00Z" }
      });
      const sel = selectNextTask({ tasks, state, comments: [], trustedAuthor: TRUSTED, nowMs: NOW });
      expect(sel.candidate).toBeNull();
      expect(sel.decisions[0].reason).toBe(INELIGIBLE.TERMINAL_STATE);
    });
  }

  it("an IN_PROGRESS task is left to the recovery pass, not dispatched", () => {
    const tasks = [taskEntry("T", "2026-09-11T04:00:00Z", 100)];
    const state = stateWith({ T: { status: TASK_STATUS.IN_PROGRESS, attempts: 1 } });
    const sel = selectNextTask({ tasks, state, comments: [], trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.candidate).toBeNull();
    expect(sel.decisions[0].reason).toBe(INELIGIBLE.IN_PROGRESS);
  });

  it("a task still inside its backoff window waits", () => {
    const tasks = [taskEntry("T", "2026-09-11T04:00:00Z", 100)];
    const state = stateWith({
      T: { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, next_eligible_at: "2026-09-11T09:00:00Z" }
    });
    const sel = selectNextTask({ tasks, state, comments: [], trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.candidate).toBeNull();
    expect(sel.waitingTaskIds).toEqual(["T"]);
  });

  it("an unsafe TASK_ID is never selected", () => {
    const tasks = [taskEntry("../escape", "2026-09-11T04:00:00Z", 100)];
    const sel = selectNextTask({
      tasks, state: defaultState(), comments: [], trustedAuthor: TRUSTED, nowMs: NOW
    });
    expect(sel.candidate).toBeNull();
    expect(sel.decisions[0].reason).toBe(INELIGIBLE.UNSAFE_TASK_ID);
  });
});

describe("D132 REGRESSION: the exact D-131 sequence", () => {
  /**
   * Replays the real timeline from the host's state.json and issue #68:
   *
   *   04:18:05Z  D131-PR79-STASH-RECOVERY-20260911-A  first dispatched
   *   04:49:30Z  ...STASH-RECOVERY reports STATUS=COMPLETE   (terminal!)
   *   05:23:05Z  D131-PR79-MERGE-F12FF3B-20260911-B   dispatched (newer task)
   *   05:23:48Z  PR #79 merged - the authorised state transition happens
   *   05:19/06:14 ...MERGE-B reports STATUS=COMPLETE
   *   05:38:07Z  <-- THE DEFECT: the worker dispatched ...STASH-RECOVERY AGAIN
   *
   * Both reports said COMPLETE, which the old vocabulary did not contain, so
   * both tasks stayed `failed_retryable`; oldest-first selection then sent the
   * older one back out after the newer one had already merged.
   */
  const STASH = "D131-PR79-STASH-RECOVERY-20260911-A";
  const MERGE = "D131-PR79-MERGE-F12FF3B-20260911-B";

  const tasks = [
    taskEntry(STASH, "2026-09-11T04:17:00Z", 5626518917),
    taskEntry(MERGE, "2026-09-11T05:22:00Z", 5629730980)
  ];

  const comments = [
    ...tasks.map((t) => t.comment),
    report(STASH, "COMPLETE", "2026-09-11T04:49:30Z", 5628000001),
    report(MERGE, "COMPLETE", "2026-09-11T06:14:12Z", 5630000002)
  ];

  // The state exactly as the host recorded it, including the stale reasons.
  const state = stateWith({
    [STASH]: {
      status: TASK_STATUS.FAILED_RETRYABLE,
      attempts: 3,
      first_dispatch_at: "2026-09-11T04:18:05.290Z",
      last_dispatch_at: "2026-09-11T05:38:07.026Z",
      last_failure_reason: "exit_0_without_matching_report (no_matching_trusted_report)",
      next_eligible_at: "2026-09-11T06:44:40.947Z"
    },
    [MERGE]: {
      status: TASK_STATUS.FAILED_RETRYABLE,
      attempts: 2,
      first_dispatch_at: "2026-09-11T05:23:05.659Z",
      head_after: "c67a7ba792b8d655a26379655ffec31b353b7101",
      last_failure_reason: "exit_0_without_matching_report (report_status_not_terminal (COMPLETE))",
      next_eligible_at: "2026-09-11T06:34:20.919Z"
    }
  });

  it("does NOT dispatch the older recovery task after the newer merge task completed", () => {
    const sel = selectNextTask({
      tasks, state, comments, trustedAuthor: TRUSTED, nowMs: Date.parse("2026-09-11T07:00:00Z")
    });

    expect(sel.candidate).toBeNull();
    const stashDecision = sel.decisions.find((d) => d.taskId === STASH);
    expect(stashDecision.eligible).toBe(false);
    // Its own terminal report retires it - before supersession is even needed.
    expect(stashDecision.reason).toBe(INELIGIBLE.TERMINAL_REPORT);
  });

  it("recognises BOTH COMPLETE reports as terminal - the vocabulary defect is gone", () => {
    const sel = selectNextTask({
      tasks, state, comments, trustedAuthor: TRUSTED, nowMs: Date.parse("2026-09-11T07:00:00Z")
    });
    expect(sel.completedByReportTaskIds.sort()).toEqual([MERGE, STASH].sort());
  });

  it("even WITHOUT the stash task's own report, supersession still blocks the replay", () => {
    const withoutStashReport = comments.filter((c) => !String(c.body).includes(`TASK_ID=${STASH}\nSTATUS=`));
    const sel = selectNextTask({
      tasks, state, comments: withoutStashReport, trustedAuthor: TRUSTED, nowMs: Date.parse("2026-09-11T07:00:00Z")
    });

    expect(sel.candidate).toBeNull();
    const stashDecision = sel.decisions.find((d) => d.taskId === STASH);
    expect(stashDecision.reason).toBe(INELIGIBLE.SUPERSEDED);
    expect(stashDecision.supersededBy).toBe(MERGE);
  });

  it("at 05:38Z - the moment of the real defect - the NEWER merge task is chosen, not the older one", () => {
    // State as it stood just before the bad dispatch: neither task reported
    // terminal yet as far as the worker was concerned.
    const at0538 = stateWith({
      [STASH]: {
        status: TASK_STATUS.FAILED_RETRYABLE,
        attempts: 2,
        first_dispatch_at: "2026-09-11T04:18:05.290Z",
        next_eligible_at: "2026-09-11T05:30:00Z" // elapsed
      },
      [MERGE]: {
        status: TASK_STATUS.FAILED_RETRYABLE,
        attempts: 1,
        first_dispatch_at: "2026-09-11T05:23:05.659Z"
      }
    });

    const sel = selectNextTask({
      tasks, state: at0538, comments: tasks.map((t) => t.comment),
      trustedAuthor: TRUSTED, nowMs: Date.parse("2026-09-11T05:38:07Z")
    });

    expect(sel.candidate.taskId).toBe(MERGE);
  });
});

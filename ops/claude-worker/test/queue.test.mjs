/**
 * D132: deterministic queue selection, eligibility and supersession.
 *
 * The centrepiece is `reproduces the exact D-131 sequence`, which replays the
 * real timeline recorded in the host's `state.json` on 2026-09-11 and proves the
 * old recovery task is never dispatched again.
 */

import { describe, it, expect } from "vitest";

import { selectNextTask, INELIGIBLE, TIER, SUPERSESSION_BASIS, declaredSupersedes } from "../lib/queue.mjs";
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
      // `successful: true` is REQUIRED, not decoration. A `completed` record
      // that does not positively state success supersedes nothing - see the
      // "unsuccessful terminal outcomes" block below.
      "NEW-TASK": {
        status: TASK_STATUS.COMPLETED, attempts: 1, successful: true, first_dispatch_at: "2026-09-11T05:23:05Z"
      }
    });

    const sel = selectNextTask({ tasks, state, comments: [], trustedAuthor: TRUSTED, nowMs: NOW });

    expect(sel.candidate).toBeNull();
    expect(sel.supersededTaskIds).toEqual(["OLD-TASK"]);
    expect(sel.supersededBy).toBe("NEW-TASK");
    const d = sel.decisions.find((x) => x.taskId === "OLD-TASK");
    expect(d.supersessionBasis).toBe(SUPERSESSION_BASIS.SUCCESSFUL_COMPLETION);
  });

  it("a NEWER task is never superseded by an older completed one", () => {
    const tasks = [
      taskEntry("OLD-DONE", "2026-09-11T04:00:00Z", 100),
      taskEntry("NEW-PENDING", "2026-09-11T05:00:00Z", 200)
    ];
    const state = stateWith({
      "OLD-DONE": {
        status: TASK_STATUS.COMPLETED, attempts: 1, successful: true, first_dispatch_at: "2026-09-11T04:05:00Z"
      }
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

/**
 * PR #80 review blocker 3.
 *
 * Supersession is a permanent retirement, so the bar is positive evidence that
 * the architect's newer order actually carried. Before this fix ANY terminal
 * report cleared that bar - including `STATUS=BLOCKED` and `STATUS=FAILED`,
 * where `assessCompletion` had already computed `successful: false` and nobody
 * looked. A newer task that changed nothing therefore permanently discarded an
 * older, still-valid retry.
 */
describe("PR#80 blocker 3: an UNSUCCESSFUL newer terminal outcome supersedes nothing", () => {
  const olderRetry = () => [
    taskEntry("OLD-RETRY", "2026-09-11T04:18:00Z", 100),
    taskEntry("NEW-TASK", "2026-09-11T05:23:00Z", 200)
  ];
  const retryState = () => stateWith({
    "OLD-RETRY": {
      status: TASK_STATUS.FAILED_RETRYABLE,
      attempts: 1,
      first_dispatch_at: "2026-09-11T04:18:05Z",
      next_eligible_at: "2026-09-11T04:30:00Z" // backoff elapsed: it IS due
    }
  });

  for (const status of ["BLOCKED", "STOPPED", "HALTED"]) {
    it(`a newer ${status} report does not supersede an older retry`, () => {
      const comments = [report("NEW-TASK", status, "2026-09-11T05:45:00Z", 900)];
      const sel = selectNextTask({
        tasks: olderRetry(), state: retryState(), comments, trustedAuthor: TRUSTED, nowMs: NOW
      });
      expect(sel.supersededTaskIds).toHaveLength(0);
      // And the older task is still genuinely dispatchable, not merely un-retired.
      expect(sel.candidate.taskId).toBe("OLD-RETRY");
    });
  }

  for (const status of ["FAILED", "ERROR", "ABORTED", "CANCELLED"]) {
    it(`a newer ${status} report does not supersede an older retry`, () => {
      const comments = [report("NEW-TASK", status, "2026-09-11T05:45:00Z", 900)];
      const sel = selectNextTask({
        tasks: olderRetry(), state: retryState(), comments, trustedAuthor: TRUSTED, nowMs: NOW
      });
      expect(sel.supersededTaskIds).toHaveLength(0);
      expect(sel.candidate.taskId).toBe("OLD-RETRY");
    });
  }

  it("a LOCALLY RECONCILED unsuccessful terminal record does not supersede", () => {
    // This is the second half of the defect. The worker writes an unsuccessful
    // terminal report into state as `status: completed, successful: false`
    // (reconcileReportedTasks / the completion path in worker.mjs), so a fix
    // that only consulted fresh comments would have let the same task supersede
    // again one run later, straight out of the state file.
    const state = stateWith({
      "OLD-RETRY": {
        status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T04:18:05Z"
      },
      "NEW-TASK": {
        status: TASK_STATUS.COMPLETED,
        attempts: 1,
        successful: false,
        report_status: "BLOCKED",
        reconciled_without_redispatch: true,
        first_dispatch_at: "2026-09-11T05:23:05Z"
      }
    });
    const sel = selectNextTask({ tasks: olderRetry(), state, comments: [], trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.supersededTaskIds).toHaveLength(0);
    expect(sel.newestSuccessfulTaskId).toBeNull();
    expect(sel.candidate.taskId).toBe("OLD-RETRY");
  });

  it("a completed record that never recorded success does not supersede", () => {
    // e.g. a legacy v1-migrated row. Absence of evidence is not success.
    const state = stateWith({
      "OLD-RETRY": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T04:18:05Z" },
      "NEW-TASK": { status: TASK_STATUS.COMPLETED, attempts: 1, legacy_unverified: true }
    });
    const sel = selectNextTask({ tasks: olderRetry(), state, comments: [], trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.supersededTaskIds).toHaveLength(0);
  });

  it("an UNRECOGNISED newer report status supersedes nothing", () => {
    const comments = [report("NEW-TASK", "MOSTLY_THERE_ISH", "2026-09-11T05:45:00Z", 900)];
    const sel = selectNextTask({
      tasks: olderRetry(), state: retryState(), comments, trustedAuthor: TRUSTED, nowMs: NOW
    });
    expect(sel.supersededTaskIds).toHaveLength(0);
    expect(sel.candidate.taskId).toBe("OLD-RETRY");
  });

  it("a GENUINE successful newer completion still supersedes the older stale order", () => {
    // The capability must not be lost to the fix: this is the D-131 case.
    const comments = [report("NEW-TASK", "COMPLETE", "2026-09-11T05:45:00Z", 900)];
    const sel = selectNextTask({
      tasks: olderRetry(), state: retryState(), comments, trustedAuthor: TRUSTED, nowMs: NOW
    });
    expect(sel.supersededTaskIds).toEqual(["OLD-RETRY"]);
    expect(sel.candidate).toBeNull();
    const d = sel.decisions.find((x) => x.taskId === "OLD-RETRY");
    expect(d.supersessionBasis).toBe(SUPERSESSION_BASIS.SUCCESSFUL_COMPLETION);
    expect(d.supersededBy).toBe("NEW-TASK");
  });

  it("a fresh BLOCKED report overrides a stale `completed` row and stops superseding", () => {
    // Fresh truth must win in BOTH directions. A state file that still says
    // `completed, successful: true` cannot keep retiring work once the trusted
    // report for that task is readable as BLOCKED.
    const state = stateWith({
      "OLD-RETRY": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T04:18:05Z" },
      "NEW-TASK": { status: TASK_STATUS.COMPLETED, attempts: 1, successful: true, first_dispatch_at: "2026-09-11T05:23:05Z" }
    });
    const comments = [report("NEW-TASK", "BLOCKED", "2026-09-11T05:45:00Z", 900)];
    const sel = selectNextTask({ tasks: olderRetry(), state, comments, trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.supersededTaskIds).toHaveLength(0);
  });
});

describe("PR#80 blocker 3: explicit trusted supersession is exact and auditable", () => {
  const declaring = (createdAt, id, supersedes) => ({
    taskId: "NEW-TASK",
    comment: {
      id,
      created_at: createdAt,
      user: { login: TRUSTED },
      body: `ARCHITECT_TASK\nTASK_ID=NEW-TASK\nSUPERSEDES=${supersedes}\nDo the thing.`
    },
    updates: []
  });

  it("parses only syntactically valid ids, from the task comment and its updates", () => {
    expect(declaredSupersedes(declaring("2026-09-11T05:00:00Z", 1, "A-1, B-2  C-3"))).toEqual(["A-1", "B-2", "C-3"]);
    expect(declaredSupersedes(declaring("2026-09-11T05:00:00Z", 1, "../escape"))).toEqual([]);
    expect(declaredSupersedes(declaring("2026-09-11T05:00:00Z", 1, "a/b"))).toEqual([]);
  });

  it("an explicit declaration retires the named older task without it having run", () => {
    const tasks = [
      taskEntry("OLD-TASK", "2026-09-11T04:18:00Z", 100),
      declaring("2026-09-11T05:23:00Z", 200, "OLD-TASK")
    ];
    const state = stateWith({
      "OLD-TASK": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T04:18:05Z" }
    });
    const sel = selectNextTask({ tasks, state, comments: [], trustedAuthor: TRUSTED, nowMs: NOW });

    expect(sel.supersededTaskIds).toEqual(["OLD-TASK"]);
    const d = sel.decisions.find((x) => x.taskId === "OLD-TASK");
    expect(d.supersessionBasis).toBe(SUPERSESSION_BASIS.EXPLICIT_DECLARATION);
    expect(d.supersededBy).toBe("NEW-TASK");
    // Auditable: the exact comment that declared it is carried into the decision.
    expect(d.supersessionDeclaredByCommentId).toBe(200);
    // The declaring task itself is what runs.
    expect(sel.candidate.taskId).toBe("NEW-TASK");
  });

  it("an OLDER declaration can never retire a NEWER task", () => {
    const tasks = [
      declaring("2026-09-11T04:00:00Z", 100, "LATER-TASK"),
      taskEntry("LATER-TASK", "2026-09-11T05:00:00Z", 200)
    ];
    const sel = selectNextTask({ tasks, state: stateWith({}), comments: [], trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.supersededTaskIds).toHaveLength(0);
  });

  it("a task cannot declare itself superseded", () => {
    const tasks = [declaring("2026-09-11T05:00:00Z", 200, "NEW-TASK")];
    const sel = selectNextTask({ tasks, state: stateWith({}), comments: [], trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.supersededTaskIds).toHaveLength(0);
    expect(sel.candidate.taskId).toBe("NEW-TASK");
  });

  it("a declaration naming a task this worker does not know retires nothing", () => {
    const tasks = [declaring("2026-09-11T05:00:00Z", 200, "TASK-THAT-DOES-NOT-EXIST")];
    const sel = selectNextTask({ tasks, state: stateWith({}), comments: [], trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.supersededTaskIds).toHaveLength(0);
  });

  it("the declaration must be EXACT - a prefix of a real task id matches nothing", () => {
    const tasks = [
      taskEntry("OLD-TASK-20260911-A", "2026-09-11T04:00:00Z", 100),
      declaring("2026-09-11T05:00:00Z", 200, "OLD-TASK")
    ];
    const state = stateWith({
      "OLD-TASK-20260911-A": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1 }
    });
    const sel = selectNextTask({ tasks, state, comments: [], trustedAuthor: TRUSTED, nowMs: NOW });
    expect(sel.supersededTaskIds).toHaveLength(0);
  });
});

/* ==========================================================================
 * D-135: A HELD COMPLETION GATE RETIRES NOTHING
 * ==========================================================================
 *
 * This is the third of the three fail-open consequences the PR #80 review
 * found, and it is the one that survives a restart. The queue decides
 * supersession from FRESH control-issue truth on purpose - that is what makes a
 * terminal report beat stale bookkeeping - but the fresh truth here IS the
 * `STATUS=COMPLETE` report whose success claim the worker refused. Without a
 * durable local override, a task the worker had just parked as unverified would
 * go on retiring strictly older, still-valid tasks on the very next run,
 * through a code path that never looks at a provenance verdict at all.
 *
 * The state below is exactly what `parkHeldCompletion` writes.
 */
describe("D-135: a task with a HELD completion gate supersedes nothing", () => {
  const held = {
    status: TASK_STATUS.BLOCKED,
    successful: false,
    attempts: 1,
    first_dispatch_at: "2026-09-11T05:23:05Z",
    completion_gate: {
      held: true,
      reason: "commit_provenance_unverified",
      provenance_verdict: "unattributed",
      report_comment_id: 900,
      report_status: "COMPLETE"
    }
  };

  it("does not retire an older task, even though the FRESH report says COMPLETE", () => {
    const tasks = [
      taskEntry("OLD-TASK", "2026-09-11T04:18:00Z", 100),
      taskEntry("NEW-TASK", "2026-09-11T05:23:00Z", 200)
    ];
    const state = stateWith({
      "OLD-TASK": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T04:18:05Z" },
      "NEW-TASK": held
    });
    // The trusted, terminal, SUCCESSFUL report really is on the control issue.
    const comments = [report("NEW-TASK", "COMPLETE", "2026-09-11T05:40:00Z", 900)];

    const sel = selectNextTask({ tasks, state, comments, trustedAuthor: TRUSTED, nowMs: NOW });

    expect(sel.supersededTaskIds).toEqual([]);
    expect(sel.newestSuccessfulTaskId).toBeNull();
    // The older task is untouched and still the thing to run.
    const old = sel.decisions.find((d) => d.taskId === "OLD-TASK");
    expect(old.eligible).toBe(true);
    expect(old.reason).toBeNull();
    expect(sel.candidate.taskId).toBe("OLD-TASK");
  });

  it("the SAME queue WITHOUT the gate does retire the older task - the gate is what changes it", () => {
    // The control: identical inputs, `completion_gate` removed. If this did not
    // supersede, the test above would prove nothing about the gate.
    const tasks = [
      taskEntry("OLD-TASK", "2026-09-11T04:18:00Z", 100),
      taskEntry("NEW-TASK", "2026-09-11T05:23:00Z", 200)
    ];
    const withoutGate = { ...held };
    delete withoutGate.completion_gate;
    const state = stateWith({
      "OLD-TASK": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T04:18:05Z" },
      "NEW-TASK": { ...withoutGate, status: TASK_STATUS.COMPLETED, successful: true }
    });
    const comments = [report("NEW-TASK", "COMPLETE", "2026-09-11T05:40:00Z", 900)];

    const sel = selectNextTask({ tasks, state, comments, trustedAuthor: TRUSTED, nowMs: NOW });

    expect(sel.supersededTaskIds).toEqual(["OLD-TASK"]);
    expect(sel.newestSuccessfulTaskId).toBe("NEW-TASK");
  });

  it("a held task's EXPLICIT `SUPERSEDES=` declaration is preserved unexecuted, not acted on", () => {
    const declaringEntry = {
      taskId: "NEW-TASK",
      comment: {
        id: 200,
        created_at: "2026-09-11T05:23:00Z",
        user: { login: TRUSTED },
        body: "ARCHITECT_TASK\nTASK_ID=NEW-TASK\nSUPERSEDES=OLD-TASK\nDo the thing."
      },
      updates: []
    };
    const state = stateWith({
      "OLD-TASK": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T04:18:05Z" },
      "NEW-TASK": held
    });

    const sel = selectNextTask({
      tasks: [taskEntry("OLD-TASK", "2026-09-11T04:18:00Z", 100), declaringEntry],
      state,
      comments: [report("NEW-TASK", "COMPLETE", "2026-09-11T05:40:00Z", 900)],
      trustedAuthor: TRUSTED,
      nowMs: NOW
    });

    // Deliberately stricter than the D-133 explicit-declaration rule: a task that
    // claimed success over commits nobody can account for is not a safe basis for
    // retiring other work until a human has reconciled it.
    expect(sel.supersededTaskIds).toEqual([]);
    expect(sel.candidate.taskId).toBe("OLD-TASK");
  });

  it("the held task itself stays terminal and is never dispatched again", () => {
    const state = stateWith({ "NEW-TASK": held });
    const sel = selectNextTask({
      tasks: [taskEntry("NEW-TASK", "2026-09-11T05:23:00Z", 200)],
      state,
      comments: [report("NEW-TASK", "COMPLETE", "2026-09-11T05:40:00Z", 900)],
      trustedAuthor: TRUSTED,
      nowMs: NOW
    });
    expect(sel.candidate).toBeNull();
    expect(sel.decisions.find((d) => d.taskId === "NEW-TASK").reason).toBe(INELIGIBLE.TERMINAL_STATE);
  });

  it("a task whose gate PASSED still supersedes normally - only a hold blocks it", () => {
    const tasks = [
      taskEntry("OLD-TASK", "2026-09-11T04:18:00Z", 100),
      taskEntry("NEW-TASK", "2026-09-11T05:23:00Z", 200)
    ];
    const state = stateWith({
      "OLD-TASK": { status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, first_dispatch_at: "2026-09-11T04:18:05Z" },
      "NEW-TASK": {
        status: TASK_STATUS.COMPLETED,
        successful: true,
        attempts: 1,
        first_dispatch_at: "2026-09-11T05:23:05Z",
        completion_gate: { held: false, passed: true, reason: "commit_provenance_verified" }
      }
    });
    const sel = selectNextTask({
      tasks, state,
      comments: [report("NEW-TASK", "COMPLETE", "2026-09-11T05:40:00Z", 900)],
      trustedAuthor: TRUSTED, nowMs: NOW
    });
    expect(sel.supersededTaskIds).toEqual(["OLD-TASK"]);
    expect(sel.decisions.find((d) => d.taskId === "OLD-TASK").supersessionBasis)
      .toBe(SUPERSESSION_BASIS.SUCCESSFUL_COMPLETION);
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

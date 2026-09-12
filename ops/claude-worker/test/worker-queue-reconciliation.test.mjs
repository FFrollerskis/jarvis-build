/**
 * D132 integration tests: queue selection, reconciliation and supersession
 * driven through the ACTUAL worker entrypoint (`node worker.mjs run`).
 *
 * The centrepiece replays the real D-131 failure, whose full evidence is in the
 * host's `state.json` and in issue #68:
 *
 *   04:18:05Z  D131-PR79-STASH-RECOVERY-20260911-A   dispatched (attempt 1)
 *   05:23:05Z  D131-PR79-MERGE-F12FF3B-20260911-B    dispatched (newer task)
 *   05:23:48Z  PR #79 merged  - the authorised state transition happens
 *   05:38:07Z  <-- THE DEFECT: ...STASH-RECOVERY dispatched AGAIN, after the
 *                  newer task had already done the work
 *
 * Two independent bugs combined to produce that:
 *
 *   1. every CLAUDE_REPORT said `STATUS=COMPLETE`, a spelling the terminal
 *      vocabulary did not contain, so finished tasks stayed `failed_retryable`
 *      ("report_status_not_terminal (COMPLETE)", recorded verbatim on the host);
 *   2. candidate selection was `tasks.find(eligible)` over an OLDEST-FIRST list,
 *      so a stale old task always outranked a newer one.
 *
 * These tests fail on the pre-D132 worker and pass on the repaired one, and they
 * exercise the real process, lock, state and dispatch paths - `gh`, `git` and the
 * Claude CLI are node fixtures resolved through JARVIS_WORKER_GH /
 * JARVIS_WORKER_GIT / claudeCommand.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { loadState, saveStateAtomic, TASK_STATUS } from "../lib/state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "worker.mjs");
const FAKE_GH = join(HERE, "fixtures", "fake-gh.mjs");
const FAKE_GIT = join(HERE, "fixtures", "fake-git.mjs");
const FAKE_CLAUDE = join(HERE, "fixtures", "fake-claude.mjs");

const TRUSTED = "tsworkflow";
const OLD_TASK = "D131-PR79-STASH-RECOVERY-20260911-A";
const NEW_TASK = "D131-PR79-MERGE-F12FF3B-20260911-B";
const BRANCH = "claude/ua8-personal-digital-twin-core";
const MERGE_SHA = "c67a7ba792b8d655a26379655ffec31b353b7101";

let dir;
let workerRoot;
let repoPath;
let ghDir;
let gitDir;
let claudeDir;
let configPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-d132-"));
  workerRoot = join(dir, "worker");
  repoPath = join(dir, "repo");
  ghDir = join(dir, "gh");
  gitDir = join(dir, "git");
  claudeDir = join(dir, "claude");
  for (const d of [workerRoot, repoPath, ghDir, gitDir, claudeDir, join(workerRoot, "logs")]) {
    mkdirSync(d, { recursive: true });
  }

  configPath = join(workerRoot, "config.json");
  writeFileSync(configPath, JSON.stringify({
    repoOwner: "tsworkflow",
    repoName: "jarvisbuild",
    controlIssue: 68,
    trustedAuthor: TRUSTED,
    repoPath,
    claudeCommand: process.execPath,
    claudeArgs: [FAKE_CLAUDE],
    promptDelivery: "stdin",
    claudeTimeoutMinutes: 5,
    heartbeatSeconds: 5,
    heartbeatTimeoutMinutes: 15,
    logDir: join(workerRoot, "logs"),
    healthFile: join(workerRoot, "logs", "health.jsonl"),
    stateFile: join(workerRoot, "state.json"),
    stateBackupFile: join(workerRoot, "state.json.bak"),
    lockFile: join(workerRoot, ".worker.lock"),
    disabledFlagFile: join(workerRoot, "disabled.flag"),
    postedStatusFile: join(workerRoot, "logs", "posted-status.jsonl"),
    scratchRoot: join(workerRoot, "tmp"),
    quarantineRoot: join(workerRoot, "tmp", "quarantine"),
    manifestFile: join(workerRoot, "logs", "quarantine-manifest.jsonl"),
    maxAttempts: 4,
    backoffBaseMinutes: 1,
    backoffMaxHours: 1,
    statusRepeatHours: 6,
    malformedLockGraceSeconds: 5
  }, null, 2), "utf8");

  writeFileSync(join(ghDir, "branches.json"), JSON.stringify(["main", BRANCH]), "utf8");
  writeFileSync(join(ghDir, "pulls.json"), JSON.stringify([]), "utf8");
  writeFileSync(join(gitDir, "git.json"), JSON.stringify({
    status: [],
    head: "f12ff3b2f344d17f8e020088083b3bf88129585d",
    branch: "main",
    remote: "https://github.com/tsworkflow/jarvisbuild"
  }, null, 2), "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** ---------------- helpers ---------------- */

function architectTask(taskId, createdAt, id) {
  return {
    id,
    created_at: createdAt,
    updated_at: createdAt,
    author_association: "OWNER",
    user: { login: TRUSTED },
    body: `ARCHITECT_TASK\nTASK_ID=${taskId}\nDo the thing.`
  };
}

function setComments(list) {
  writeFileSync(join(ghDir, "comments.json"), JSON.stringify(list, null, 2), "utf8");
}

function comments() {
  return JSON.parse(readFileSync(join(ghDir, "comments.json"), "utf8"));
}

function appendComment(c) {
  setComments([...comments(), c]);
}

function runWorker(mode, extraEnv = {}) {
  const child = spawn(process.execPath, [WORKER, "run"], {
    env: {
      ...process.env,
      JARVIS_WORKER_CONFIG: configPath,
      JARVIS_WORKER_GH: FAKE_GH,
      JARVIS_WORKER_GIT: FAKE_GIT,
      JARVIS_FAKE_GH_DIR: ghDir,
      JARVIS_FAKE_GH_AUTHOR: TRUSTED,
      JARVIS_FAKE_GIT_DIR: gitDir,
      JARVIS_FAKE_CLAUDE_DIR: claudeDir,
      JARVIS_FAKE_CLAUDE_MODE: mode,
      // Deliberately NOT pinned: the fixture reports for whichever task it was
      // actually handed, which is the whole point of a multi-task queue test.
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, output: out })));
}

function state() {
  return loadState(join(workerRoot, "state.json"), join(workerRoot, "state.json.bak"), { schema: "worker" }).state;
}

function task(id) {
  return state()?.tasks?.[id] ?? null;
}

/** Which TASK_IDs the Claude fixture was actually handed, in order. */
function dispatched() {
  const path = join(claudeDir, "dispatched.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function prompt() {
  const path = join(claudeDir, "prompt.txt");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Force a task's backoff clock into the past, i.e. "the wait has elapsed". */
function elapseBackoff(taskId) {
  const s = state();
  s.tasks[taskId].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
  saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"), { schema: "worker" });
}

/** ---------------- the regression ---------------- */

describe("D132 REGRESSION: the exact D-131 sequence, through the real entrypoint", () => {
  it("never dispatches the older task again after the newer one completes", async () => {
    // --- 04:18Z: only the OLD recovery task exists. It exits 0 without posting
    //     a report, exactly as every real D-131 attempt did.
    setComments([architectTask(OLD_TASK, "2026-09-11T04:17:00Z", 5626518917)]);

    const first = await runWorker("silent");
    expect(dispatched()).toEqual([OLD_TASK]);
    expect(task(OLD_TASK).status).toBe(TASK_STATUS.FAILED_RETRYABLE);
    expect(task(OLD_TASK).last_failure_reason).toMatch(/exit_0_without_matching_report/);
    // Exit 0 is never claimed for a task with no evidence behind it.
    expect(first.code).not.toBe(0);

    // --- 05:22Z: the architect issues the NEWER merge task. The old one's
    //     backoff has meanwhile elapsed, which is precisely the state in which
    //     the pre-D132 worker went back and re-ran the old task.
    appendComment(architectTask(NEW_TASK, "2026-09-11T05:22:00Z", 5629730980));
    elapseBackoff(OLD_TASK);

    const second = await runWorker("report");

    // THE INVARIANT: the newer, never-dispatched task wins.
    expect(dispatched()).toEqual([OLD_TASK, NEW_TASK]);
    expect(second.code).toBe(0);

    // And it is recognised as COMPLETE - the fixture posts STATUS=COMPLETE, the
    // spelling the real child uses and the old vocabulary rejected.
    const newRecord = task(NEW_TASK);
    expect(newRecord.status).toBe(TASK_STATUS.COMPLETED);
    expect(newRecord.report_status).toBe("COMPLETE");
    expect(newRecord.report_status_canonical).toBe("COMPLETE");

    // --- 05:38Z equivalent: a third run, with the old task's backoff elapsed
    //     again. This is the moment the defect actually fired.
    elapseBackoff(OLD_TASK);
    const third = await runWorker("report");

    // THE CORE ASSERTION: the old task is NOT dispatched a second time.
    expect(dispatched()).toEqual([OLD_TASK, NEW_TASK]);
    expect(third.code).toBe(0);

    // It was retired deliberately and traceably - not silently dropped.
    const oldRecord = task(OLD_TASK);
    expect(oldRecord.status).toBe(TASK_STATUS.SUPERSEDED);
    expect(oldRecord.superseded_by).toBe(NEW_TASK);
    expect(oldRecord.superseded_at).toBeTruthy();

    // The architect is told, on the control issue, exactly what happened.
    const notice = comments().find((c) => String(c.body).includes("superseded_by_newer_completed_task"));
    expect(notice).toBeTruthy();
    expect(String(notice.body)).toContain(OLD_TASK);
  }, 120_000);

  it("a restart cannot resurrect the superseded task", async () => {
    setComments([
      architectTask(OLD_TASK, "2026-09-11T04:17:00Z", 1),
      architectTask(NEW_TASK, "2026-09-11T05:22:00Z", 2)
    ]);
    // Pre-seed the end state of the previous test.
    await runWorker("silent");          // dispatches OLD (oldest fresh first)
    elapseBackoff(OLD_TASK);
    await runWorker("report");          // dispatches NEW, completes it
    elapseBackoff(OLD_TASK);
    await runWorker("report");          // retires OLD as superseded
    expect(task(OLD_TASK).status).toBe(TASK_STATUS.SUPERSEDED);

    const before = dispatched().length;

    // Three further restarts, with the backoff clock repeatedly wound back.
    for (let i = 0; i < 3; i += 1) {
      const s = state();
      s.tasks[OLD_TASK].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
      saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"), { schema: "worker" });
      const res = await runWorker("report");
      expect(res.code).toBe(0);
    }

    expect(dispatched()).toHaveLength(before);
    expect(task(OLD_TASK).status).toBe(TASK_STATUS.SUPERSEDED);
  }, 180_000);
});

describe("D132: a trusted terminal report closes a task without re-dispatching it", () => {
  it("a COMPLETE report retires a task the state file still calls retryable", async () => {
    setComments([architectTask(OLD_TASK, "2026-09-11T04:17:00Z", 1)]);

    // Attempt 1 exits 0 with no report -> failed_retryable.
    await runWorker("silent");
    expect(task(OLD_TASK).status).toBe(TASK_STATUS.FAILED_RETRYABLE);

    // The report then arrives out of band - the crash-after-report case, where
    // the child posted but the parent never recorded it.
    appendComment({
      id: 5628000001,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      author_association: "OWNER",
      user: { login: TRUSTED },
      body: `CLAUDE_REPORT\nTASK_ID=${OLD_TASK}\nSTATUS=COMPLETE\nBRANCH=${BRANCH}`
    });
    elapseBackoff(OLD_TASK);

    const before = dispatched().length;
    const res = await runWorker("report");

    expect(dispatched()).toHaveLength(before); // NOT dispatched again
    expect(res.code).toBe(0);
    const rec = task(OLD_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.reconciled_without_redispatch).toBe(true);
    expect(rec.report_status_canonical).toBe("COMPLETE");
  }, 120_000);

  it("an UNRECOGNISED report status is parked as BLOCKED, never retried forever", async () => {
    setComments([architectTask(OLD_TASK, "2026-09-11T04:17:00Z", 1)]);

    const res = await runWorker("report", { JARVIS_FAKE_CLAUDE_STATUS: "MOSTLY_THERE_ISH" });

    expect(dispatched()).toEqual([OLD_TASK]);
    const rec = task(OLD_TASK);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.last_failure_reason).toMatch(/report_status_unrecognised/);
    expect(res.code).toBe(3); // EXIT.BLOCKED

    // A blocked task is terminal: a restart does not dispatch it again.
    const before = dispatched().length;
    await runWorker("report");
    expect(dispatched()).toHaveLength(before);
  }, 120_000);

  /**
   * D-135: the same out-of-band COMPLETE report, against a task whose LAST
   * ATTEMPT recorded that it could not account for the commits in its worktree.
   *
   * This is the non-dispatch half of the gate. The report arrives while no child
   * is running, so no fresh provenance is computed - the gate is evaluated
   * against the verdict the previous attempt durably recorded, which is the only
   * evidence that ever existed while the range was still small. Without the gate
   * here, a run that merely RE-READ the control issue would launder exactly the
   * completion the dispatch path had just refused.
   */
  it("D-135: an out-of-band COMPLETE report is PARKED when the recorded provenance is unverified", async () => {
    const FOREIGN = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    setComments([architectTask(OLD_TASK, "2026-09-11T04:17:00Z", 1)]);

    await runWorker("silent");
    expect(task(OLD_TASK).status).toBe(TASK_STATUS.FAILED_RETRYABLE);

    // The honest verdict the previous attempt left behind.
    const s = state();
    s.tasks[OLD_TASK].commit_provenance = {
      verdict: "unattributed",
      verified: false,
      head_before: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      head_after: FOREIGN,
      attributed_commits: [],
      unattributed_commits: [{ sha: FOREIGN, subject: "unrelated maintenance commit" }],
      unattributed_count: 1,
      reason: "no commit in the range carries this task's attempt evidence (1 unexplained)"
    };
    s.tasks[OLD_TASK].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
    saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"), { schema: "worker" });

    appendComment({
      id: 5628000042,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      author_association: "OWNER",
      user: { login: TRUSTED },
      body: `CLAUDE_REPORT\nTASK_ID=${OLD_TASK}\nSTATUS=COMPLETE\nBRANCH=${BRANCH}`
    });

    const before = dispatched().length;
    const res = await runWorker("report");

    // Not re-dispatched (a second child on top of unexplained commits is exactly
    // what must not happen) and not completed either.
    expect(dispatched()).toHaveLength(before);
    const rec = task(OLD_TASK);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.status).not.toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(false);
    expect(rec.completion_gate.held).toBe(true);
    expect(rec.completion_gate.provenance_verdict).toBe("unattributed");
    expect(rec.completion_gate.unattributed_commits).toEqual([FOREIGN]);
    expect(res.code).not.toBe(0);

    // The health journal never claims this completed.
    const health = existsSync(join(workerRoot, "logs", "health.jsonl"))
      ? readFileSync(join(workerRoot, "logs", "health.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    expect(health.filter((e) => e.event === "completion_confirmed" && e.task_id === OLD_TASK)).toEqual([]);
    expect(health.some((e) => e.event === "blocked" && e.reason === "completion_gate_held")).toBe(true);
  }, 120_000);
});

describe("D132: an already-merged task is reconciled, not re-merged", () => {
  it("the resumed prompt carries the merge truth and forbids a second merge", async () => {
    setComments([architectTask(NEW_TASK, "2026-09-11T05:22:00Z", 2)]);

    // Attempt 1: exits 0 with no report, but records the branch association.
    appendComment({
      id: 5629999999,
      created_at: "2026-09-11T05:23:00Z",
      updated_at: "2026-09-11T05:23:00Z",
      author_association: "OWNER",
      user: { login: TRUSTED },
      body: `CLAUDE_ACK\nTASK_ID=${NEW_TASK}\nBRANCH=${BRANCH}\nPR_NUMBER=79`
    });
    await runWorker("silent");
    expect(task(NEW_TASK).status).toBe(TASK_STATUS.FAILED_RETRYABLE);

    // The merge then happens out of band - exactly the real D-131 situation,
    // where PR #79 was merged after the attempt that reported on it.
    writeFileSync(join(ghDir, "pulls.json"), JSON.stringify([{
      number: 79,
      headRefName: BRANCH,
      state: "closed",
      mergedAt: "2026-09-11T05:23:48Z",
      mergeCommitSha: MERGE_SHA
    }], null, 2), "utf8");
    elapseBackoff(NEW_TASK);

    await runWorker("report");

    const delivered = prompt();
    expect(delivered).toContain("ALREADY MERGED");
    expect(delivered).toContain(MERGE_SHA);
    expect(delivered).toContain("Do NOT merge again");
    expect(delivered).toContain("post-merge state");
  }, 120_000);

  /**
   * D-134. This test used to assert the DEFECT.
   *
   * It injected `head_after = <some sha>` into state and then required the
   * prompt to say "THIS TASK'S OWN WORK" - i.e. it pinned the invalid inference
   * that a moved HEAD proves authorship. The injection is kept EXACTLY as it
   * was, because it is a faithful model of what a PRE-D134 worker left on disk:
   * a pair of ref readings and no evidence of any kind. It is therefore also the
   * migration case - state written by the old worker, read by the new one. What
   * changed is the required conclusion.
   */
  it("a bare head_after with NO commit evidence is presented as UNVERIFIED, not as the task's work", async () => {
    setComments([architectTask(NEW_TASK, "2026-09-11T05:22:00Z", 2)]);

    await runWorker("silent");

    const s = state();
    s.tasks[NEW_TASK].head_after = MERGE_SHA;
    // Exactly the shape a pre-D134 worker persisted: no verdict was ever
    // computed, because that worker did not ask the question at all.
    delete s.tasks[NEW_TASK].commit_provenance;
    s.tasks[NEW_TASK].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
    saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"), { schema: "worker" });

    await runWorker("report");

    const delivered = prompt();
    // The observation is still reported - suppressing it would strand the child.
    expect(delivered).toContain(MERGE_SHA);
    // But it is never dressed up as authorship.
    expect(delivered).toContain("COMMIT PROVENANCE: UNVERIFIED");
    expect(delivered).not.toContain("THIS TASK'S OWN WORK");
    expect(delivered).toContain("A moved HEAD is an OBSERVATION, not proof of authorship");
    // Fail-closed in BOTH directions: not adopted, and not destroyed either.
    expect(delivered).toMatch(/Never stash, reset, revert, clean, checkout over, force-push, rebase or/);
    expect(delivered).toContain("Do NOT adopt them as this task's output");
  }, 120_000);

  it("a recorded ATTRIBUTED verdict IS presented as the task's own work, with the same anti-destruction rule", async () => {
    setComments([architectTask(NEW_TASK, "2026-09-11T05:22:00Z", 2)]);

    await runWorker("silent");

    // What a well-behaved previous attempt leaves behind: a durable verdict that
    // was computed from positive per-commit evidence, not from the head pair.
    const s = state();
    const wtHead = s.tasks[NEW_TASK].head_after;
    s.tasks[NEW_TASK].commit_provenance = {
      verdict: "task_attributed",
      verified: true,
      head_before: "f12ff3b2f344d17f8e020088083b3bf88129585d",
      head_after: wtHead,
      attributed_commits: [{ sha: MERGE_SHA, subject: "feat: the task's own commit" }],
      unattributed_commits: [],
      reason: "every commit in the range carries this task's own attempt evidence (1)",
      error: null,
      checked_at: new Date().toISOString()
    };
    s.tasks[NEW_TASK].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
    saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"), { schema: "worker" });

    await runWorker("report");

    const delivered = prompt();
    expect(delivered).toContain("COMMIT PROVENANCE: VERIFIED AS THIS TASK'S OWN WORK");
    expect(delivered).toContain(MERGE_SHA);
    expect(delivered).toMatch(/Never stash, reset, force-push, revert or\s+re-apply/);
    expect(delivered).not.toContain("COMMIT PROVENANCE: UNVERIFIED");
  }, 120_000);

  it("a verified verdict is DOWNGRADED when the worktree head has drifted since it was recorded", async () => {
    setComments([architectTask(NEW_TASK, "2026-09-11T05:22:00Z", 2)]);

    await runWorker("silent");

    // Same verified record as above, except that it names a head_after which is
    // NOT where the worktree actually sits now. Something moved the ref while no
    // attempt was running, so the stored verdict can no longer be relied on.
    const s = state();
    s.tasks[NEW_TASK].commit_provenance = {
      verdict: "task_attributed",
      verified: true,
      head_before: "f12ff3b2f344d17f8e020088083b3bf88129585d",
      head_after: MERGE_SHA,
      attributed_commits: [{ sha: MERGE_SHA, subject: "feat: the task's own commit" }],
      unattributed_commits: [],
      reason: "every commit in the range carries this task's own attempt evidence (1)",
      error: null,
      checked_at: new Date().toISOString()
    };
    s.tasks[NEW_TASK].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
    saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"), { schema: "worker" });

    await runWorker("report");

    const delivered = prompt();
    expect(delivered).toContain("COMMIT PROVENANCE: UNVERIFIED");
    expect(delivered).not.toContain("VERIFIED AS THIS TASK'S OWN WORK");
    expect(delivered).toMatch(/moved again AFTER the previous attempt had already ended/);
  }, 120_000);
});

/**
 * PR #80 review blocker 3, through the real entrypoint.
 *
 * The unit tests in queue.test.mjs pin the decision function; these pin the
 * whole process - state file, retirement persistence and status posting
 * included - because the defect had TWO doors into it and only one of them was
 * visible from `selectNextTask` in isolation: the worker writes an unsuccessful
 * terminal report into state as `completed, successful: false`, so a fix that
 * only consulted fresh comments would still have superseded on the next run.
 */
describe("PR#80 blocker 3: an unsuccessful newer task never retires older work (real entrypoint)", () => {
  for (const status of ["BLOCKED", "FAILED"]) {
    it(`a newer ${status} task does not supersede an older retry, now or after a restart`, async () => {
      setComments([architectTask(OLD_TASK, "2026-09-11T04:17:00Z", 1)]);

      // The older task has real, unfinished work: one attempt, no report.
      await runWorker("silent");
      expect(dispatched()).toEqual([OLD_TASK]);
      expect(task(OLD_TASK).status).toBe(TASK_STATUS.FAILED_RETRYABLE);

      // A newer task arrives and ends TERMINAL BUT UNSUCCESSFUL.
      appendComment(architectTask(NEW_TASK, "2026-09-11T05:22:00Z", 2));
      await runWorker("report", { JARVIS_FAKE_CLAUDE_STATUS: status });
      expect(dispatched()).toEqual([OLD_TASK, NEW_TASK]);

      // It is recorded as terminal, and honestly as NOT successful.
      const newRec = task(NEW_TASK);
      expect(newRec.report_status).toBe(status);
      expect(newRec.successful).toBe(false);

      // THE INVARIANT: the older task is untouched and still dispatchable.
      expect(task(OLD_TASK).status).toBe(TASK_STATUS.FAILED_RETRYABLE);
      expect(task(OLD_TASK).superseded_by ?? null).toBeNull();

      elapseBackoff(OLD_TASK);
      await runWorker("report");

      // It actually RAN - not merely "was not retired".
      expect(dispatched()).toEqual([OLD_TASK, NEW_TASK, OLD_TASK]);
      expect(task(OLD_TASK).status).toBe(TASK_STATUS.COMPLETED);
      expect(task(OLD_TASK).successful).toBe(true);

      // And no supersession notice was ever posted about it.
      const notice = comments().find((c) =>
        String(c.body).includes("superseded_by_newer_completed_task") && String(c.body).includes(OLD_TASK));
      expect(notice).toBeFalsy();
    }, 180_000);
  }

  it("a LOCALLY RECONCILED unsuccessful terminal record does not supersede on a later run", async () => {
    // The second door into the defect: the state file, not the fresh comments.
    setComments([architectTask(OLD_TASK, "2026-09-11T04:17:00Z", 1)]);
    await runWorker("silent");

    // Seed exactly what the worker writes for an unsuccessful terminal report,
    // with no corresponding comment left for the fresh-truth path to find.
    const s = state();
    s.tasks[NEW_TASK] = {
      task_id: NEW_TASK,
      status: TASK_STATUS.COMPLETED,
      attempts: 1,
      successful: false,
      report_status: "FAILED",
      reconciled_without_redispatch: true,
      first_dispatch_at: "2026-09-11T05:23:05Z"
    };
    s.tasks[OLD_TASK].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
    saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"), { schema: "worker" });
    appendComment(architectTask(NEW_TASK, "2026-09-11T05:22:00Z", 2));

    await runWorker("report");

    expect(task(OLD_TASK).status).not.toBe(TASK_STATUS.SUPERSEDED);
    expect(dispatched()).toContain(OLD_TASK);
  }, 180_000);

  it("a GENUINELY successful newer completion still supersedes, and records the basis", async () => {
    // The capability must survive the fix - this is the original D-131 case.
    setComments([architectTask(OLD_TASK, "2026-09-11T04:17:00Z", 1)]);
    await runWorker("silent");
    appendComment(architectTask(NEW_TASK, "2026-09-11T05:22:00Z", 2));
    elapseBackoff(OLD_TASK);
    await runWorker("report");                      // NEW completes, STATUS=COMPLETE
    expect(task(NEW_TASK).successful).toBe(true);

    elapseBackoff(OLD_TASK);
    const before = dispatched().length;
    await runWorker("report");

    expect(dispatched()).toHaveLength(before);
    const rec = task(OLD_TASK);
    expect(rec.status).toBe(TASK_STATUS.SUPERSEDED);
    expect(rec.superseded_by).toBe(NEW_TASK);
    expect(rec.superseded_basis).toBe("newer_task_completed_successfully");
  }, 180_000);

  it("an EXPLICIT trusted SUPERSEDES declaration retires the exact named task, auditably", async () => {
    setComments([architectTask(OLD_TASK, "2026-09-11T04:17:00Z", 1)]);
    await runWorker("silent");
    expect(task(OLD_TASK).status).toBe(TASK_STATUS.FAILED_RETRYABLE);

    // A newer trusted task states, in the control issue, that it replaces the
    // older order. It has not run yet - the architect's word is the authority.
    appendComment({
      id: 2,
      created_at: "2026-09-11T05:22:00Z",
      updated_at: "2026-09-11T05:22:00Z",
      author_association: "OWNER",
      user: { login: TRUSTED },
      body: `ARCHITECT_TASK\nTASK_ID=${NEW_TASK}\nSUPERSEDES=${OLD_TASK}\nDo the newer thing.`
    });
    elapseBackoff(OLD_TASK);

    await runWorker("report");

    const rec = task(OLD_TASK);
    expect(rec.status).toBe(TASK_STATUS.SUPERSEDED);
    expect(rec.superseded_by).toBe(NEW_TASK);
    expect(rec.superseded_basis).toBe("explicit_trusted_supersedes_declaration");
    // Auditable: the exact declaring comment is recorded and reported.
    expect(rec.superseded_declared_by_comment_id).toBe(2);
    const notice = comments().find((c) =>
      String(c.body).includes("superseded_by_newer_completed_task") && String(c.body).includes(OLD_TASK));
    expect(String(notice.body)).toContain("explicit_trusted_supersedes_declaration");
    expect(String(notice.body)).toContain("trusted control-issue comment 2");

    // The declaring task is the one that runs; the old one never runs again.
    expect(dispatched()).toEqual([OLD_TASK, NEW_TASK]);
  }, 180_000);

  it("a SUPERSEDES line in UNTRUSTED content is ignored completely", async () => {
    setComments([architectTask(OLD_TASK, "2026-09-11T04:17:00Z", 1)]);
    await runWorker("silent");

    // Same text, wrong author: not command authority, so it retires nothing.
    appendComment({
      id: 3,
      created_at: "2026-09-11T05:22:00Z",
      updated_at: "2026-09-11T05:22:00Z",
      author_association: "NONE",
      user: { login: "someone-else" },
      body: `ARCHITECT_TASK\nTASK_ID=${NEW_TASK}\nSUPERSEDES=${OLD_TASK}\n`
    });
    elapseBackoff(OLD_TASK);

    await runWorker("report");

    expect(task(OLD_TASK).status).not.toBe(TASK_STATUS.SUPERSEDED);
    expect(task(NEW_TASK)).toBeNull();  // the untrusted "task" was never a task
    expect(dispatched()).toEqual([OLD_TASK, OLD_TASK]);
  }, 180_000);
});

describe("D132: the dry run previews the SAME decision the real run would make", () => {
  it("reports the chosen candidate, its tier and what would be retired", async () => {
    setComments([
      architectTask(OLD_TASK, "2026-09-11T04:17:00Z", 1),
      architectTask(NEW_TASK, "2026-09-11T05:22:00Z", 2)
    ]);
    await runWorker("silent");   // OLD dispatched, now retryable
    elapseBackoff(OLD_TASK);

    const res = await runWorker("report", { JARVIS_WORKER_DRY_RUN: "1" });
    // `--dry-run` is an argv flag, so drive it the same way the host would.
    const dry = await new Promise((resolve) => {
      const child = spawn(process.execPath, [WORKER, "run", "--dry-run"], {
        env: {
          ...process.env,
          JARVIS_WORKER_CONFIG: configPath,
          JARVIS_WORKER_GH: FAKE_GH,
          JARVIS_WORKER_GIT: FAKE_GIT,
          JARVIS_FAKE_GH_DIR: ghDir,
          JARVIS_FAKE_GH_AUTHOR: TRUSTED,
          JARVIS_FAKE_GIT_DIR: gitDir,
          JARVIS_FAKE_CLAUDE_DIR: claudeDir
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.on("close", () => resolve(out));
    });

    expect(res.code).toBe(0);
    const parsed = JSON.parse(dry);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.wrote_anything).toBe(false);
    expect(Array.isArray(parsed.queue_decisions)).toBe(true);
    // The newer task completed in the previous run, so the older one is retired.
    expect(parsed.would_retire_superseded).toContain(OLD_TASK);
    expect(parsed.next_candidate).toBeNull();
  }, 120_000);
});

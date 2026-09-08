/**
 * Integration tests that drive the ACTUAL worker entrypoint - `node worker.mjs
 * run` as a real OS process - and crash it at the three points the D126 review
 * named:
 *
 *   "Test actual worker entrypoint after process crash before spawn, during
 *    child execution, and after report before completion save. Keep live child
 *    safe."
 *
 * On the reviewed implementation every one of these left the task permanently
 * IN_PROGRESS, and `isEligibleNow` then refused to dispatch it forever
 * (architect reproduction: CRASHED_IN_PROGRESS_ELIGIBLE=false). `gh`, `git` and
 * the Claude CLI are replaced by node fixtures resolved through
 * JARVIS_WORKER_GH / JARVIS_WORKER_GIT / claudeCommand, so the worker's own
 * process, lock, state and dispatch logic are genuinely exercised.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { loadState, saveStateAtomic, defaultState, TASK_STATUS } from "../lib/state.mjs";
import { readLock, ledgerDir } from "../lib/lock.mjs";
import { isProcessAlive, captureIdentity } from "../lib/procid.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "worker.mjs");
const FAKE_GH = join(HERE, "fixtures", "fake-gh.mjs");
const FAKE_GIT = join(HERE, "fixtures", "fake-git.mjs");
const FAKE_CLAUDE = join(HERE, "fixtures", "fake-claude.mjs");

const TASK_ID = "D126-INTEGRATION-20260907";
const TRUSTED = "tsworkflow";

let dir;
let workerRoot;
let repoPath;
let ghDir;
let gitDir;
let claudeDir;
let configPath;
let stray = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-int-"));
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

  writeFileSync(join(ghDir, "comments.json"), JSON.stringify([{
    id: 1,
    created_at: "2026-09-07T00:00:00.000Z",
    updated_at: "2026-09-07T00:00:00.000Z",
    author_association: "OWNER",
    user: { login: TRUSTED },
    body: `ARCHITECT_TASK\nTASK_ID=${TASK_ID}\nDo the thing.`
  }], null, 2), "utf8");
  writeFileSync(join(ghDir, "branches.json"), JSON.stringify(["main"]), "utf8");
  writeFileSync(join(ghDir, "pulls.json"), JSON.stringify([]), "utf8");
  writeFileSync(join(gitDir, "git.json"), JSON.stringify({
    status: [],
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    branch: "main",
    remote: "https://github.com/tsworkflow/jarvisbuild"
  }, null, 2), "utf8");
  stray = [];
});

afterEach(() => {
  for (const pid of stray) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

function workerEnv(mode) {
  return {
    ...process.env,
    JARVIS_WORKER_CONFIG: configPath,
    JARVIS_WORKER_GH: FAKE_GH,
    JARVIS_WORKER_GIT: FAKE_GIT,
    JARVIS_FAKE_GH_DIR: ghDir,
    JARVIS_FAKE_GH_AUTHOR: TRUSTED,
    JARVIS_FAKE_GIT_DIR: gitDir,
    JARVIS_FAKE_CLAUDE_DIR: claudeDir,
    JARVIS_FAKE_CLAUDE_MODE: mode,
    JARVIS_FAKE_CLAUDE_TASK_ID: TASK_ID,
    JARVIS_FAKE_CLAUDE_BRANCH: "claude/d126-integration",
    JARVIS_FAKE_CLAUDE_PR: "4321"
  };
}

function startWorker(mode, extraEnv = {}) {
  const child = spawn(process.execPath, [WORKER, "run"], {
    env: { ...workerEnv(mode), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return {
    child,
    output: () => out,
    exited: new Promise((resolve) => child.on("close", (code) => resolve(code)))
  };
}

function runWorker(mode, extraEnv = {}) {
  const handle = startWorker(mode, extraEnv);
  return handle.exited.then((code) => ({ code, output: handle.output() }));
}

function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (err) {
        return reject(err);
      }
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function state() {
  return loadState(join(workerRoot, "state.json"), join(workerRoot, "state.json.bak"), { schema: "worker" });
}

function task() {
  return state().state?.tasks?.[TASK_ID] ?? null;
}

function invocations() {
  const path = join(claudeDir, "invocations.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function comments() {
  return JSON.parse(readFileSync(join(ghDir, "comments.json"), "utf8"));
}

describe("baseline: the entrypoint completes a task on real evidence", () => {
  it("dispatches once, verifies the report, and marks it COMPLETED", async () => {
    const res = await runWorker("report");
    expect(res.code).toBe(0);
    expect(invocations()).toHaveLength(1);
    const t = task();
    expect(t.status).toBe(TASK_STATUS.COMPLETED);
    expect(t.report_comment_id).toBeTruthy();
    // The lock is an append-only claim ledger: "released" is what the highest
    // claim says, not the absence of a path.
    expect(readLock(join(workerRoot, ".worker.lock"))).toBeNull();
  }, 60_000);

  it("records the child's identity at spawn, not after the run", async () => {
    await runWorker("report");
    // The completed record clears it, but the health journal proves it was known
    // while the child was alive.
    const health = readFileSync(join(workerRoot, "logs", "health.jsonl"), "utf8");
    expect(health).toMatch(/"child_pid":\d+/);
  }, 60_000);

  it("tells the child, in the prompt, exactly where to put its drafts", async () => {
    await runWorker("report");
    const prompt = readFileSync(join(claudeDir, "prompt.txt"), "utf8");
    expect(prompt).toMatch(/SCRATCH DISCIPLINE/);
    expect(prompt).toContain(join(workerRoot, "tmp", TASK_ID));
    expect(prompt).toMatch(/Never write a draft into the/);
  }, 60_000);

  it("exit 0 without a report is NOT completion", async () => {
    const res = await runWorker("fail");
    expect(res.code).not.toBe(0);
    expect(task().status).toBe(TASK_STATUS.FAILED_RETRYABLE);
    expect(task().last_failure_reason).toMatch(/nonzero_exit/);
  }, 60_000);
});

/**
 * CRASH POINT 1 - before the child is spawned.
 */
describe("blocker 1: crash BEFORE spawn", () => {
  it("a kill during the queue poll leaves no stall: the next run dispatches normally", async () => {
    const handle = startWorker("report", { JARVIS_FAKE_GH_DELAY_MS: "4000" });
    await waitFor(() => readLock(join(workerRoot, ".worker.lock")) !== null);
    handle.child.kill("SIGKILL");
    await handle.exited;

    // A crashed parent leaves its claim behind, still marked held. It must not
    // block the next run - and the next run must SUPERSEDE it, never delete it.
    expect(readLock(join(workerRoot, ".worker.lock")).state).toBe("held");
    expect(invocations()).toHaveLength(0);

    const res = await runWorker("report");
    expect(res.code).toBe(0);
    expect(invocations()).toHaveLength(1);
    expect(task().status).toBe(TASK_STATUS.COMPLETED);
  }, 90_000);

  it("a task left IN_PROGRESS with no child recorded is recovered and re-dispatched", async () => {
    // Exactly the state a crash between "mark IN_PROGRESS" and "child spawned"
    // leaves behind. On the reviewed implementation this was terminal:
    // isEligibleNow returned false and nothing ever reconciled it.
    const s = defaultState();
    s.tasks[TASK_ID] = {
      task_id: TASK_ID,
      status: TASK_STATUS.IN_PROGRESS,
      attempts: 1,
      first_dispatch_at: new Date(Date.now() - 60_000).toISOString(),
      last_dispatch_at: new Date(Date.now() - 60_000).toISOString(),
      child_identity: null
    };
    saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"));

    const res = await runWorker("report");
    expect(res.code).toBe(0);
    expect(invocations()).toHaveLength(1);
    const t = task();
    expect(t.status).toBe(TASK_STATUS.COMPLETED);
    expect(t.attempts).toBe(2); // the crashed attempt still counted
  }, 90_000);
});

/**
 * CRASH POINT 2 - while the child is executing. The child must SURVIVE and be
 * protected; a second Claude must never be started for the same task.
 */
describe("blocker 1: crash DURING child execution keeps the live child safe", () => {
  it("persists the child's identity BEFORE the parent can die", async () => {
    const handle = startWorker("hang");
    const childPid = await waitFor(() => {
      const path = join(claudeDir, "running");
      return existsSync(path) ? Number(readFileSync(path, "utf8")) : null;
    });
    stray.push(childPid);

    // The decisive assertion for blocker 1: the identity is durable while the
    // child is still running, not written after runClaude returns.
    const recorded = await waitFor(() => (task()?.child_identity?.pid === childPid ? task().child_identity : null));
    expect(recorded.pid).toBe(childPid);
    expect(recorded.host).toBeTruthy();
    expect(recorded.observed_at).toBeTruthy();

    handle.child.kill("SIGKILL");
    await handle.exited;

    // The record survives the crash - this is what protects the child next run.
    expect(task().status).toBe(TASK_STATUS.IN_PROGRESS);
    expect(task().child_identity.pid).toBe(childPid);
    try { process.kill(childPid, "SIGKILL"); } catch { /* may already be gone */ }
  }, 120_000);

  /**
   * NOTE on how the orphan is produced.
   *
   * On this Windows host a grandchild does NOT outlive a TerminateProcess of its
   * parent (verified directly: spawning a hanging grandchild and killing the
   * middle process kills it too). So the orphan here is a live process the TEST
   * owns, with its identity captured by the SAME `captureIdentity` the worker
   * uses, and the crashed state is the exact record the test above proves the
   * worker writes. The recovery path under test is the real one.
   */
  it("protects a live orphan, starts no second Claude, and resumes once it is gone", async () => {
    const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: process.platform !== "win32"
    });
    if (typeof orphan.unref === "function") orphan.unref();
    await waitFor(() => Boolean(orphan.pid) && isProcessAlive(orphan.pid));
    stray.push(orphan.pid);

    const s = defaultState();
    s.tasks[TASK_ID] = {
      task_id: TASK_ID,
      status: TASK_STATUS.IN_PROGRESS,
      attempts: 1,
      first_dispatch_at: new Date(Date.now() - 60_000).toISOString(),
      last_dispatch_at: new Date(Date.now() - 60_000).toISOString(),
      child_identity: captureIdentity(orphan.pid),
      last_child_pid: orphan.pid
    };
    saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"));

    const blocked = await runWorker("hang");
    expect(blocked.code).toBe(3);
    expect(invocations()).toHaveLength(0); // no second Claude was started
    expect(isProcessAlive(orphan.pid)).toBe(true); // and nothing was terminated
    expect(task().status).toBe(TASK_STATUS.IN_PROGRESS);

    const posted = comments().map((c) => c.body).join("\n");
    expect(posted).toMatch(/previous_claude_child_still_running/);
    expect(posted).toMatch(/Nothing was terminated/);
    expect(posted).toMatch(new RegExp(`CHILD_PID=${orphan.pid}`));

    // The orphan finally exits. The very next run resumes the task.
    process.kill(orphan.pid, "SIGKILL");
    await waitFor(() => !isProcessAlive(orphan.pid));

    const resumed = await runWorker("report");
    expect(resumed.code).toBe(0);
    expect(invocations()).toHaveLength(1);
    expect(task().status).toBe(TASK_STATUS.COMPLETED);
  }, 120_000);
});

/**
 * CRASH POINT 3 - after the child posted its report, before the parent could
 * save completion. The work IS done; re-running it would duplicate effects.
 */
describe("blocker 1 + 6: crash AFTER the report, before the completion save", () => {
  it("reconciles the existing report and never dispatches a second time", async () => {
    const handle = startWorker("report-hang");
    await waitFor(() => existsSync(join(claudeDir, "report-posted")));
    const childPid = Number(readFileSync(join(claudeDir, "child.pid"), "utf8"));
    stray.push(childPid);

    handle.child.kill("SIGKILL");
    await handle.exited;
    try { process.kill(childPid, "SIGKILL"); } catch { /* the grandchild may already be gone */ }
    await waitFor(() => !isProcessAlive(childPid));

    expect(task().status).toBe(TASK_STATUS.IN_PROGRESS);
    expect(invocations()).toHaveLength(1);

    const res = await runWorker("report");
    expect(res.code).toBe(0);
    // The decisive assertion: the task closed out WITHOUT a second dispatch.
    expect(invocations()).toHaveLength(1);
    const t = task();
    expect(t.status).toBe(TASK_STATUS.COMPLETED);
    expect(t.reconciled_without_redispatch).toBe(true);
    expect(t.recovered_from_crash).toBe(true);
    expect(t.observed_branches).toContain("claude/d126-integration");
  }, 120_000);
});

/**
 * Blocker 6 in the real entrypoint: a failed lookup must never license a retry.
 */
describe("blocker 6: the entrypoint refuses to retry while duplicate risk is unknown", () => {
  it("defers instead of dispatching when the branch lookup fails", async () => {
    const s = defaultState();
    s.tasks[TASK_ID] = {
      task_id: TASK_ID,
      status: TASK_STATUS.IN_PROGRESS,
      attempts: 1,
      first_dispatch_at: new Date(Date.now() - 60_000).toISOString(),
      child_identity: null
    };
    saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"));
    writeFileSync(join(ghDir, "fail.json"), JSON.stringify({ branches: true, pulls: true }), "utf8");

    await runWorker("report");

    expect(invocations()).toHaveLength(0);
    const t = task();
    expect(t.status).toBe(TASK_STATUS.FAILED_RETRYABLE);
    expect(t.last_failure_reason).toMatch(/duplicate_risk_unknown/);
    expect(t.next_eligible_at).toBeTruthy();
  }, 90_000);
});

/**
 * Blocker 7 in the real entrypoint.
 */
describe("blocker 7: the entrypoint fails closed on git and on the remote", () => {
  it("blocks instead of treating an unanswerable git status as a clean worktree", async () => {
    writeFileSync(join(gitDir, "git.json"), JSON.stringify({ fail: ["status"] }), "utf8");
    const res = await runWorker("report");
    expect(res.code).toBe(3);
    expect(invocations()).toHaveLength(0);
    expect(comments().map((c) => c.body).join("\n")).toMatch(/git_preflight_failed/);
  }, 90_000);

  it("blocks when origin is not the configured repository", async () => {
    writeFileSync(join(gitDir, "git.json"), JSON.stringify({
      status: [],
      head: "abc",
      branch: "main",
      remote: "https://github.com/someone-else/other-repo"
    }), "utf8");
    const res = await runWorker("report");
    expect(res.code).toBe(3);
    expect(invocations()).toHaveLength(0);
    expect(comments().map((c) => c.body).join("\n")).toMatch(/origin_remote_does_not_match/);
  }, 90_000);

  it("blocks on a dirty worktree it did not create, without touching anything", async () => {
    writeFileSync(join(gitDir, "git.json"), JSON.stringify({
      status: ["?? someone-elses-file.txt"],
      head: "abc",
      branch: "main",
      remote: "https://github.com/tsworkflow/jarvisbuild"
    }), "utf8");
    const res = await runWorker("report");
    expect(res.code).toBe(3);
    expect(invocations()).toHaveLength(0);
    expect(comments().map((c) => c.body).join("\n")).toMatch(/worktree_dirty_unknown_files/);
  }, 90_000);
});

describe("blocker 2: state writes and the lock", () => {
  it("a dry run takes no lock and writes nothing", async () => {
    const before = existsSync(join(workerRoot, "state.json"));
    const child = spawn(process.execPath, [WORKER, "run", "--dry-run"], { env: workerEnv("report"), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    await new Promise((resolve) => child.on("close", resolve));
    expect(out).toMatch(/"took_lock": false/);
    expect(existsSync(ledgerDir(join(workerRoot, ".worker.lock")))).toBe(false);
    expect(existsSync(join(workerRoot, "state.json"))).toBe(before);
    expect(invocations()).toHaveLength(0);
  }, 60_000);

  it("a second instance does not run while the first holds the lock", async () => {
    const handle = startWorker("hang");
    const childPid = await waitFor(() => {
      const path = join(claudeDir, "running");
      return existsSync(path) ? Number(readFileSync(path, "utf8")) : null;
    });
    stray.push(childPid);
    await waitFor(() => readLock(join(workerRoot, ".worker.lock"))?.phase === "dispatch");

    const second = await runWorker("report");
    expect(second.code).toBe(0);
    expect(second.output).toMatch(/Another worker instance is active/);
    expect(invocations()).toHaveLength(1); // the second instance started nothing

    process.kill(childPid, "SIGKILL");
    handle.child.kill("SIGKILL");
    await handle.exited;
  }, 120_000);

  it("refuses to run rather than reset an unusable state file", async () => {
    writeFileSync(join(workerRoot, "state.json"), "null", "utf8");
    writeFileSync(join(workerRoot, "state.json.bak"), "[]", "utf8");
    const res = await runWorker("report");
    expect(res.code).toBe(3);
    expect(invocations()).toHaveLength(0);
    expect(readFileSync(join(workerRoot, "state.json"), "utf8")).toBe("null");
  }, 60_000);
});

/**
 * D126 FINAL review finding 1: "child identity persistence is best-effort, not a
 * precondition".
 *
 * The architect's direct-module reproduction on the exact HEAD made `onSpawn`
 * throw `durable write failed` and still got back
 * `{"outcome":"completed_exit_0","code":0,"childPid":14}` - a live Claude with
 * durable state saying IN_PROGRESS and `child_identity: null`, which recovery
 * cannot tell apart from a pre-spawn crash.
 *
 * These drive the REAL entrypoint (`node worker.mjs run` as its own OS process)
 * with the precondition faulted, and assert the four properties the review
 * demands: zero untracked live child, no duplicate dispatch, a truthful
 * non-zero/blocked outcome, and safe recovery afterwards.
 */
describe("finding 1: the durable child-identity handoff is an enforced gate", () => {
  for (const [fault, label] of [
    ["spawn_state_write", "a durable state-write failure during onSpawn"],
    ["spawn_lost_lock", "a lost lock during onSpawn"]
  ]) {
    describe(label, () => {
      it("never reports completion, and exits non-zero", async () => {
        const res = await runWorker("hang", { JARVIS_WORKER_FAULT: fault });
        expect(res.code).not.toBe(0);
        expect(res.output).toMatch(/HANDOFF FAILED/);
        const t = task();
        expect(t.status).not.toBe(TASK_STATUS.COMPLETED);
        expect(t.last_outcome).toBe("handoff_failed");
      }, 120_000);

      it("leaves ZERO untracked live children", async () => {
        await runWorker("hang", { JARVIS_WORKER_FAULT: fault });
        // The child announces its own pid before it can be aborted, so this is
        // the real process the worker created, not an inferred one.
        const runningPath = join(claudeDir, "running");
        if (!existsSync(runningPath)) return; // aborted before it announced: also fine
        const childPid = Number(readFileSync(runningPath, "utf8"));
        stray.push(childPid);
        await waitFor(() => !isProcessAlive(childPid), { timeoutMs: 45_000 });
        expect(isProcessAlive(childPid)).toBe(false);
      }, 120_000);

      it("never delivers the task to the child it is about to abort", async () => {
        await runWorker("hang", { JARVIS_WORKER_FAULT: fault });
        // The handshake: with stdin delivery the prompt is written only after
        // the identity record and the lock heartbeat are durable. A faulted
        // handoff therefore means the child never received its task at all.
        expect(existsSync(join(claudeDir, "prompt.txt"))).toBe(false);
      }, 120_000);

      it("dispatches exactly once and the NEXT run does not duplicate it", async () => {
        const first = await runWorker("hang", { JARVIS_WORKER_FAULT: fault });
        expect(first.code).not.toBe(0);
        // How far the child got before the abort reached it is a race, not a
        // property: on Linux the signal usually lands before it executes its
        // first line, on Windows it usually does not. What MUST hold is that
        // the worker started at most one child and never a second.
        const afterFirst = invocations().length;
        expect(afterFirst).toBeLessThanOrEqual(1);

        const runningPath = join(claudeDir, "running");
        if (existsSync(runningPath)) {
          const childPid = Number(readFileSync(runningPath, "utf8"));
          stray.push(childPid);
          await waitFor(() => !isProcessAlive(childPid), { timeoutMs: 45_000 });
        }

        // The child was PROVEN gone, so the attempt simply did not happen and
        // the task stays retryable - not dropped, not stuck IN_PROGRESS.
        const before = task();
        expect(before.status).toBe(TASK_STATUS.FAILED_RETRYABLE);
        expect(before.child_identity).toBeNull();
        expect(before.next_eligible_at).toBeTruthy();

        // An IMMEDIATE re-run must not dispatch again: the backoff still holds.
        const tooSoon = await runWorker("report");
        expect(tooSoon.code).toBe(0);
        expect(invocations()).toHaveLength(afterFirst); // nothing new was started

        // Once the backoff has elapsed, recovery dispatches EXACTLY once more.
        const s = state().state;
        s.tasks[TASK_ID].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
        saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"), { schema: "worker" });

        const second = await runWorker("report");
        expect(invocations()).toHaveLength(afterFirst + 1);
        expect(second.code).toBe(0);
        expect(task().status).toBe(TASK_STATUS.COMPLETED);
      }, 180_000);

      it("records the abort verification truthfully instead of asserting success", async () => {
        await runWorker("hang", { JARVIS_WORKER_FAULT: fault });
        const t = task();
        // Not "we killed it" - "we re-checked the exact identity and this is
        // what we found". GONE/REUSED are the only proofs of death.
        expect(t.handoff_child_terminated).toBe(true);
        expect(["gone", "reused"]).toContain(t.handoff_identity_state);
        expect(t.last_failure_reason).toMatch(/handoff_failed_child_aborted/);
      }, 120_000);

      it("leaves the lock released, so the next scheduled run is not blocked out", async () => {
        await runWorker("hang", { JARVIS_WORKER_FAULT: fault });
        expect(readLock(join(workerRoot, ".worker.lock"))).toBeNull();
      }, 120_000);
    });
  }

  /**
   * A precondition that keeps failing is a real problem. "The attempt did not
   * really happen" must not become a licence to retry forever.
   */
  it("a handoff that keeps failing consumes the attempt budget and ends BLOCKED", async () => {
    let lastCode = 0;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await runWorker("hang", { JARVIS_WORKER_FAULT: "spawn_state_write" });
      lastCode = res.code;
      const t = task();
      if (t.status === TASK_STATUS.BLOCKED) break;
      expect(t.status).toBe(TASK_STATUS.FAILED_RETRYABLE);
      // Make the next attempt eligible immediately instead of waiting out the
      // real backoff.
      const s = state().state;
      s.tasks[TASK_ID].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
      saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"), { schema: "worker" });
    }
    const t = task();
    expect(t.status).toBe(TASK_STATUS.BLOCKED);
    expect(t.attempts).toBe(4); // maxAttempts in this fixture's config
    expect(t.last_failure_reason).toMatch(/retry budget exhausted/);
    expect(lastCode).toBe(3);
    // Still no untracked child, even at the end of the budget.
    const runningPath = join(claudeDir, "running");
    if (existsSync(runningPath)) {
      const childPid = Number(readFileSync(runningPath, "utf8"));
      stray.push(childPid);
      await waitFor(() => !isProcessAlive(childPid), { timeoutMs: 45_000 });
    }
  }, 300_000);

  it("the armed fault is announced loudly and can never be silent", async () => {
    const res = await runWorker("hang", { JARVIS_WORKER_FAULT: "spawn_state_write" });
    expect(res.output).toMatch(/JARVIS_WORKER_FAULT=spawn_state_write is armed/);
    expect(res.output).toMatch(/TEST-ONLY/);
  }, 120_000);

  it("an unarmed run is completely unaffected by the fault machinery", async () => {
    const res = await runWorker("report");
    expect(res.code).toBe(0);
    expect(res.output).not.toMatch(/is armed/);
    expect(task().status).toBe(TASK_STATUS.COMPLETED);
  }, 60_000);
});

/**
 * D126 REVIEW F, through the REAL entrypoint.
 *
 * The gate used to end at `onSpawn`. The FIRST heartbeat - which is what puts
 * the child's identity on the worker lock - sat outside it, so a failure there
 * rejected `runClaude` and left a live child with no listeners, no timeout and
 * an armed interval. The direct-module proof is in `dispatch.test.mjs`; this
 * drives `node worker.mjs run` as its own OS process, because only that shows
 * the exit code, the persisted state and the real child's fate together.
 */
describe("review F: a failing FIRST heartbeat is gated at the real entrypoint", () => {
  for (const [fault, label] of [
    ["first_heartbeat_throw", "a durable write failure in the first heartbeat"],
    ["first_heartbeat_lost_lock", "lost lock ownership at the first heartbeat"]
  ]) {
    describe(label, () => {
      it("never reports completion, and exits non-zero", async () => {
        const res = await runWorker("hang", { JARVIS_WORKER_FAULT: fault });
        expect(res.code).not.toBe(0);
        expect(res.output).toMatch(/HANDOFF FAILED/);
        // The old behaviour: an unhandled rejection out of runClaude.
        expect(res.output).not.toMatch(/UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/);
        const t = task();
        expect(t.status).not.toBe(TASK_STATUS.COMPLETED);
        expect(t.last_outcome).toBe("handoff_failed");
      }, 120_000);

      it("never delivers the task to the child it is about to abort", async () => {
        await runWorker("hang", { JARVIS_WORKER_FAULT: fault });
        // Zero pre-gate task effect: with stdin delivery the prompt IS the task.
        expect(existsSync(join(claudeDir, "prompt.txt"))).toBe(false);
      }, 120_000);

      it("leaves ZERO untracked live children", async () => {
        await runWorker("hang", { JARVIS_WORKER_FAULT: fault });
        const runningPath = join(claudeDir, "running");
        if (!existsSync(runningPath)) return; // aborted before it announced: also fine
        const childPid = Number(readFileSync(runningPath, "utf8"));
        stray.push(childPid);
        await waitFor(() => !isProcessAlive(childPid), { timeoutMs: 45_000 });
        expect(isProcessAlive(childPid)).toBe(false);
      }, 120_000);

      it("records the abort verification truthfully and releases the lock", async () => {
        await runWorker("hang", { JARVIS_WORKER_FAULT: fault });
        const t = task();
        expect(t.handoff_child_terminated).toBe(true);
        expect(["gone", "reused"]).toContain(t.handoff_identity_state);
        // Not stuck IN_PROGRESS, and the next scheduled run is not locked out.
        expect(t.status).toBe(TASK_STATUS.FAILED_RETRYABLE);
        expect(readLock(join(workerRoot, ".worker.lock"))).toBeNull();
      }, 120_000);

      it("starts at most one child and the next run does not duplicate it", async () => {
        const first = await runWorker("hang", { JARVIS_WORKER_FAULT: fault });
        expect(first.code).not.toBe(0);
        const afterFirst = invocations().length;
        expect(afterFirst).toBeLessThanOrEqual(1);

        const runningPath = join(claudeDir, "running");
        if (existsSync(runningPath)) {
          const childPid = Number(readFileSync(runningPath, "utf8"));
          stray.push(childPid);
          await waitFor(() => !isProcessAlive(childPid), { timeoutMs: 45_000 });
        }
        const s = state().state;
        s.tasks[TASK_ID].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
        saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"), { schema: "worker" });

        const second = await runWorker("report");
        expect(invocations()).toHaveLength(afterFirst + 1);
        expect(second.code).toBe(0);
        expect(task().status).toBe(TASK_STATUS.COMPLETED);
      }, 180_000);
    });
  }
});

/**
 * D126 REVIEW F, the PERIODIC callback at the real entrypoint.
 *
 * `mode=report-slow` posts a genuine trusted CLAUDE_REPORT and then exits 0
 * after outliving one heartbeat interval. Every ordinary signal therefore says
 * "healthy": exit 0, matching report, HEAD as expected. The only thing wrong is
 * the worker's OWN bookkeeping - and that must be enough to stop it claiming
 * completion, without an uncaught crash and without killing the child.
 */
describe("review F: a failing PERIODIC heartbeat fails closed at the real entrypoint", () => {
  // heartbeatSeconds is 5 in this fixture's config and its minimum is 5, so the
  // child must live past that for a periodic beat to exist at all.
  const SLOW = { JARVIS_FAKE_CLAUDE_LINGER_MS: "7000" };

  for (const [fault, reason] of [
    ["periodic_heartbeat_throw", "heartbeat_unrecovered_during_dispatch"],
    ["periodic_heartbeat_lost_lock", "lock_ownership_lost_during_dispatch"]
  ]) {
    describe(fault, () => {
      it("does not crash the worker on an uncaught exception", async () => {
        const res = await runWorker("report-slow", { ...SLOW, JARVIS_WORKER_FAULT: fault });
        // A throw inside a setInterval callback used to be fatal to the process.
        expect(res.output).not.toMatch(/UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/);
        expect(res.output).not.toMatch(/Uncaught|uncaughtException/);
        expect(res.code).toBe(3); // EXIT.BLOCKED - a deliberate, truthful outcome
      }, 120_000);

      it("does NOT claim completion even though the child exited 0 with a real report", async () => {
        await runWorker("report-slow", { ...SLOW, JARVIS_WORKER_FAULT: fault });
        // The evidence a healthy run would have used really is there.
        expect(existsSync(join(claudeDir, "report-posted"))).toBe(true);
        expect(comments().some((c) => c.body.includes("CLAUDE_REPORT"))).toBe(true);
        const t = task();
        expect(t.status).not.toBe(TASK_STATUS.COMPLETED);
        expect(t.status).toBe(TASK_STATUS.BLOCKED);
        expect(t.last_outcome).toBe("completed_exit_0");
        expect(t.last_failure_reason).toMatch(new RegExp(reason));
      }, 120_000);

      it("leaves the child alone: it was doing legitimate authorized work", async () => {
        await runWorker("report-slow", { ...SLOW, JARVIS_WORKER_FAULT: fault });
        // The task WAS delivered and the child ran it to completion; the gate
        // had already passed, so withholding or killing would be wrong here.
        expect(existsSync(join(claudeDir, "prompt.txt"))).toBe(true);
        expect(invocations()).toHaveLength(1);
      }, 120_000);

      it("records the heartbeat failure truthfully and blocks replay", async () => {
        const res = await runWorker("report-slow", { ...SLOW, JARVIS_WORKER_FAULT: fault });
        expect(res.output).toMatch(new RegExp(`BLOCKED for TASK_ID=${TASK_ID}: ${reason}`));
        expect(res.output).toMatch(/The child was NOT killed; completion is NOT claimed/);
        const t = task();
        expect(t.heartbeat_failures).toBeGreaterThan(0);
        expect(t.heartbeat_ownership_lost).toBe(fault === "periodic_heartbeat_lost_lock");
        expect(t.blocked_at).toBeTruthy();

        // BLOCKED is never replayed on its own: a second run must not start a
        // second Claude on top of work that may already have landed.
        const second = await runWorker("report");
        expect(invocations()).toHaveLength(1);
        expect(second.code).toBe(0);
        expect(task().status).toBe(TASK_STATUS.BLOCKED);
      }, 180_000);
    });
  }

  it("an unfaulted slow child is still completed normally", async () => {
    const res = await runWorker("report-slow", SLOW);
    // The control: the fail-closed branch must not fire on a healthy long run.
    expect(res.code).toBe(0);
    expect(task().status).toBe(TASK_STATUS.COMPLETED);
    expect(invocations()).toHaveLength(1);
  }, 120_000);
});

/**
 * D126 ADDENDUM ITEM 4, through the REAL entrypoint.
 *
 * The direct-module coverage lives in `dispatch.test.mjs`. These drive
 * `node worker.mjs run` as its own OS process and assert the two properties
 * that only a real process can demonstrate: an unsupported delivery mode never
 * gets as far as creating a child, and the child that IS created never receives
 * the task on its command line - so with persistence or heartbeat faulted there
 * is provably zero prompt consumption and zero task effect before the gate.
 */
describe("addendum item 4: stdin-only delivery at the real entrypoint", () => {
  function setPromptDelivery(mode) {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    if (mode === undefined) delete cfg.promptDelivery;
    else cfg.promptDelivery = mode;
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
  }

  it("refuses to start at all when the config asks for argv delivery", async () => {
    setPromptDelivery("argv");
    const res = await runWorker("report");
    expect(res.code).not.toBe(0);
    expect(res.output).toMatch(/promptDelivery must be "stdin"/);
    // Nothing was spawned and no task effect exists: no child, no prompt file.
    expect(invocations()).toHaveLength(0);
    expect(existsSync(join(claudeDir, "prompt.txt"))).toBe(false);
    expect(existsSync(join(claudeDir, "argv.json"))).toBe(false);
    // The queue was never even consumed, so nothing was marked as attempted.
    expect(task()).toBeNull();
  }, 60_000);

  it("rejects any other unimplemented mode the same way", async () => {
    setPromptDelivery("carrier-pigeon");
    const res = await runWorker("report");
    expect(res.code).not.toBe(0);
    expect(invocations()).toHaveLength(0);
  }, 60_000);

  it("a real child never receives the task on its command line", async () => {
    await runWorker("report");
    const argv = JSON.parse(readFileSync(join(claudeDir, "argv.json"), "utf8"));
    // argv[0] is node, argv[1] is the fixture path. Nothing else, and above all
    // nothing carrying the ARCHITECT_TASK body.
    expect(argv).toHaveLength(2);
    for (const arg of argv) {
      expect(arg).not.toMatch(/ARCHITECT_TASK/);
      expect(arg).not.toMatch(new RegExp(TASK_ID));
    }
    // The task did arrive - over stdin, after the gate.
    expect(readFileSync(join(claudeDir, "prompt.txt"), "utf8")).toMatch(/ARCHITECT_TASK/);
  }, 60_000);

  for (const [fault, label] of [
    ["spawn_state_write", "an injected PERSISTENCE failure"],
    ["spawn_lost_lock", "an injected HEARTBEAT failure"]
  ]) {
    it(`${label} leaves the child with no task in argv and none on stdin`, async () => {
      await runWorker("hang", { JARVIS_WORKER_FAULT: fault });

      // If the child got far enough to record anything, prove its command line
      // was clean. If it never ran at all, that is a stronger version of the
      // same property.
      const argvPath = join(claudeDir, "argv.json");
      if (existsSync(argvPath)) {
        const argv = JSON.parse(readFileSync(argvPath, "utf8"));
        expect(argv).toHaveLength(2);
        for (const arg of argv) expect(arg).not.toMatch(/ARCHITECT_TASK/);
        const childPid = Number(readFileSync(join(claudeDir, "child.pid"), "utf8"));
        stray.push(childPid);
        await waitFor(() => !isProcessAlive(childPid), { timeoutMs: 45_000 });
      }
      // The gate never succeeded, so the prompt was never written: zero prompt
      // consumption and zero task effects.
      expect(existsSync(join(claudeDir, "prompt.txt"))).toBe(false);
      expect(existsSync(join(claudeDir, "report-posted"))).toBe(false);
      expect(task().status).not.toBe(TASK_STATUS.COMPLETED);
      expect(task().last_outcome).toBe("handoff_failed");
    }, 120_000);
  }

  it("stdin remains accepted, with or without the field present", async () => {
    setPromptDelivery(undefined);
    const res = await runWorker("report");
    expect(res.code).toBe(0);
    expect(task().status).toBe(TASK_STATUS.COMPLETED);
  }, 60_000);
});

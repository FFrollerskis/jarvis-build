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

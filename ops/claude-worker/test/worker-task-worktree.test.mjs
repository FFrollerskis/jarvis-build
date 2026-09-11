/**
 * D-133 process-level tests: task-owned uncommitted work, driven through the
 * ACTUAL worker entrypoint against a REAL git repository.
 *
 * These are the tests the PR #80 review asked for, and they are deliberately
 * not fixture-driven on the git side. The claim under test is physical - which
 * directory did the bytes land in, is the user's checkout still clean, does git
 * itself refuse to delete uncommitted work - and a fake `git` would simply
 * agree with whatever the worker did. Only `gh` and the Claude CLI are faked.
 *
 * The failure being regression-tested:
 *
 *   An attempt exits 0 without posting a trusted report, having made legitimate
 *   uncommitted changes. Before D-133 those changes landed in the shared
 *   checkout as anonymous dirt. Nothing attributed them to a task, so the next
 *   run's dirty guard blocked - correctly - and the work was stranded, with the
 *   only exits being to adopt unattributed files (which could destroy the
 *   user's work) or to stash/reset them away (which destroys the task's).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { loadState, saveStateAtomic, TASK_STATUS } from "../lib/state.mjs";
import { readClaim, claimFilePath, taskWorktreePath, CLAIM_STATE } from "../lib/worktree.mjs";
import { createRepo, statusLines, head, log, git } from "./fixtures/real-git-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "worker.mjs");
const FAKE_GH = join(HERE, "fixtures", "fake-gh.mjs");
const FAKE_CLAUDE = join(HERE, "fixtures", "fake-claude.mjs");

const TRUSTED = "tsworkflow";
const TASK_A = "D133-TASK-A-20260911-A";
const TASK_B = "D133-TASK-B-20260911-B";

let dir;
let workerRoot;
let repoPath;
let ghDir;
let claudeDir;
let configPath;
let worktreeRoot;
let baseline;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-d133-"));
  workerRoot = join(dir, "worker");
  repoPath = join(dir, "repo");
  ghDir = join(dir, "gh");
  claudeDir = join(dir, "claude");
  worktreeRoot = join(workerRoot, "worktrees");
  for (const d of [workerRoot, ghDir, claudeDir, join(workerRoot, "logs"), worktreeRoot]) {
    mkdirSync(d, { recursive: true });
  }

  ({ baseline } = createRepo(repoPath));

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
    worktreeRoot,
    maxAttempts: 6,
    backoffBaseMinutes: 1,
    backoffMaxHours: 1,
    statusRepeatHours: 6,
    malformedLockGraceSeconds: 5
  }, null, 2), "utf8");

  writeFileSync(join(ghDir, "branches.json"), JSON.stringify(["main"]), "utf8");
  writeFileSync(join(ghDir, "pulls.json"), JSON.stringify([]), "utf8");
  setComments([]);
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

/**
 * Drive the real entrypoint. `JARVIS_WORKER_GIT` is deliberately NOT set, so
 * the worker calls the real git binary against the real fixture repository.
 */
function runWorker(mode, extraEnv = {}) {
  const child = spawn(process.execPath, [WORKER, "run"], {
    env: {
      ...process.env,
      JARVIS_WORKER_CONFIG: configPath,
      JARVIS_WORKER_GH: FAKE_GH,
      JARVIS_FAKE_GH_DIR: ghDir,
      JARVIS_FAKE_GH_AUTHOR: TRUSTED,
      JARVIS_FAKE_CLAUDE_DIR: claudeDir,
      JARVIS_FAKE_CLAUDE_MODE: mode,
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return new Promise((resolve_) => child.on("close", (code) => resolve_({ code, output: out })));
}

function state() {
  return loadState(join(workerRoot, "state.json"), join(workerRoot, "state.json.bak"), { schema: "worker" }).state;
}

function task(id) {
  return state()?.tasks?.[id] ?? null;
}

function claim(taskId) {
  return readClaim(claimFilePath(worktreeRoot, taskId));
}

function wt(taskId) {
  return taskWorktreePath(worktreeRoot, taskId);
}

function dispatched() {
  const path = join(claudeDir, "dispatched.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

/** Every prompt the child has been handed, in order. */
function prompts() {
  const path = join(claudeDir, "prompts.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function mutations() {
  const path = join(claudeDir, "mutations.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

function elapseBackoff(taskId) {
  const s = state();
  s.tasks[taskId].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
  saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"), { schema: "worker" });
}

/** Make the child produce real tracked + untracked changes and report nothing. */
const MUTATE_SILENT = { JARVIS_FAKE_CLAUDE_MUTATE: "tracked,untracked" };

/** ---------------- the regression ---------------- */

describe("D-133: exit 0, no report, task-owned uncommitted changes -> safe resume", () => {
  it("lands the changes in the task's OWN worktree and resumes there on restart", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T04:00:00Z", 1)]);

    // --- attempt 1: real tracked + untracked mutations, exit 0, NO report ---
    const first = await runWorker("silent", MUTATE_SILENT);
    expect(first.code).not.toBe(0); // exit 0 without evidence is never success
    expect(dispatched()).toEqual([TASK_A]);

    // The child worked inside its own worktree, not the shared checkout.
    expect(mutations()[0]).toContain(resolve(wt(TASK_A)));

    // The changes are REAL and they are where they belong.
    const dirty = statusLines(wt(TASK_A));
    expect(dirty).toEqual(expect.arrayContaining([
      expect.stringMatching(/^ M tracked\.txt$/),
      expect.stringMatching(/^\?\? work-D133-TASK-A-20260911-A\.md$/)
    ]));

    // THE INVARIANT: the user's checkout is untouched and still clean.
    expect(statusLines(repoPath)).toEqual([]);

    // Ownership is durable, bound before the mutation, and readable.
    const c = claim(TASK_A);
    expect(c.ok).toBe(true);
    expect(c.claim.state).toBe(CLAIM_STATE.READY);
    expect(c.claim.task_id).toBe(TASK_A);
    expect(c.claim.task_comment_id).toBe(1);
    expect(c.claim.baseline_sha).toBe(baseline);
    expect(c.claim.attempts).toHaveLength(1);

    // The task record knows where its work lives - it is not anonymous dirt.
    const rec = task(TASK_A);
    expect(rec.status).toBe(TASK_STATUS.FAILED_RETRYABLE);
    expect(rec.worktree_path).toBe(resolve(wt(TASK_A)));
    expect(rec.worktree_task_owned_dirty.length).toBeGreaterThan(0);

    // --- restart: it must RESUME in the same proven context ---------------
    elapseBackoff(TASK_A);
    const second = await runWorker("report", MUTATE_SILENT);

    expect(dispatched()).toEqual([TASK_A, TASK_A]);
    expect(second.code).toBe(0);

    // Same directory, same claim, a second recorded attempt - not a new context.
    const resumedPrompt = prompts()[1];
    expect(resumedPrompt.cwd).toBe(resolve(wt(TASK_A)));
    const c2 = claim(TASK_A);
    expect(c2.claim.attempts).toHaveLength(2);
    expect(c2.claim.first_attempt_id).toBe(c.claim.first_attempt_id);
    expect(c2.claim.latest_attempt_id).not.toBe(c.claim.first_attempt_id);

    // And the resumed child is told the files are ITS OWN, with an explicit
    // prohibition on the destructive "get to a clean tree" reflex.
    expect(resumedPrompt.prompt).toContain("TASK-OWNED UNCOMMITTED CHANGES ALREADY PRESENT");
    expect(resumedPrompt.prompt).toContain("work-D133-TASK-A-20260911-A.md");
    expect(resumedPrompt.prompt).toMatch(/NEVER stash, reset, checkout over, clean or delete them/);

    // The primary checkout never became dirty at any point.
    expect(statusLines(repoPath)).toEqual([]);
  }, 180_000);

  it("keeps the worktree when the task ends unsuccessfully, and never force-removes it", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T04:00:00Z", 1)]);
    await runWorker("silent", MUTATE_SILENT);

    // A BLOCKED report is terminal but NOT successful, so cleanup must not run:
    // the uncommitted work is still there and is still the task's.
    appendComment({
      id: 900001,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      author_association: "OWNER",
      user: { login: TRUSTED },
      body: `CLAUDE_REPORT\nTASK_ID=${TASK_A}\nSTATUS=BLOCKED`
    });
    elapseBackoff(TASK_A);
    await runWorker("silent");

    expect(existsSync(wt(TASK_A))).toBe(true);
    expect(claim(TASK_A).claim.state).toBe(CLAIM_STATE.READY);
    expect(statusLines(wt(TASK_A)).length).toBeGreaterThan(0);
    expect(existsSync(join(wt(TASK_A), `work-${TASK_A}.md`))).toBe(true);
  }, 180_000);

  it("releases the worktree only after a SUCCESSFUL terminal reconciliation, and keeps the claim", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T04:00:00Z", 1)]);

    // A child that commits its work and reports COMPLETE leaves a clean tree.
    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked,untracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1"
    });
    expect(res.code).toBe(0);
    expect(task(TASK_A).status).toBe(TASK_STATUS.COMPLETED);
    expect(task(TASK_A).successful).toBe(true);

    // The directory is gone, but the EVIDENCE of what ran there is not.
    expect(existsSync(wt(TASK_A))).toBe(false);
    const c = claim(TASK_A);
    expect(c.ok).toBe(true);
    expect(c.claim.state).toBe(CLAIM_STATE.RELEASED);
    expect(c.claim.released_at).toBeTruthy();
    expect(c.claim.baseline_sha).toBe(baseline);

    // And git agrees the worktree is deregistered, with the primary intact.
    expect(git(repoPath, ["worktree", "list", "--porcelain"])).not.toContain(TASK_A);
    expect(statusLines(repoPath)).toEqual([]);
    expect(head(repoPath)).toBe(baseline);
  }, 180_000);
});

describe("D-133: unknown/user dirty state is never claimed and never altered", () => {
  it("blocks on the user's own dirty primary checkout without touching it", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T04:00:00Z", 1)]);
    writeFileSync(join(repoPath, "my-notes.md"), "the user's own work\n", "utf8");
    writeFileSync(join(repoPath, "tracked.txt"), "the user edited this\n", "utf8");

    const res = await runWorker("report", MUTATE_SILENT);

    expect(res.code).toBe(3); // EXIT.BLOCKED
    expect(dispatched()).toEqual([]); // nothing was dispatched at all
    // Byte-for-byte untouched, and never adopted into a task context.
    expect(readFileSync(join(repoPath, "my-notes.md"), "utf8")).toBe("the user's own work\n");
    expect(readFileSync(join(repoPath, "tracked.txt"), "utf8")).toBe("the user edited this\n");
    expect(claim(TASK_A).ok).toBe(false);
    expect(existsSync(wt(TASK_A))).toBe(false);
  }, 120_000);

  it("refuses an UNCLAIMED directory sitting at the task's worktree path", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T04:00:00Z", 1)]);
    // Content at the path, with nothing attributing it to this task. Adopting
    // it is exactly the move that could destroy someone else's work.
    mkdirSync(wt(TASK_A), { recursive: true });
    writeFileSync(join(wt(TASK_A), "someone-elses.txt"), "not the worker's\n", "utf8");

    const res = await runWorker("report", MUTATE_SILENT);

    expect(res.code).toBe(3);
    expect(dispatched()).toEqual([]);
    expect(readFileSync(join(wt(TASK_A), "someone-elses.txt"), "utf8")).toBe("not the worker's\n");
    // The refusal happens BEFORE the task is marked in progress, so it is not
    // recorded as attempted at all: it stays fully eligible for a later run.
    expect(task(TASK_A)).toBeNull();

    const notice = comments().find((c) => String(c.body).includes("task_worktree_foreign"));
    expect(notice).toBeTruthy();
    expect(String(notice.body)).toContain("NOTHING was stashed, reset, cleaned, deleted, moved or overwritten");
  }, 120_000);

  it("refuses a claim that belongs to a DIFFERENT task, and alters nothing", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T04:00:00Z", 1)]);
    mkdirSync(join(worktreeRoot, ".claims"), { recursive: true });
    mkdirSync(wt(TASK_A), { recursive: true });
    writeFileSync(join(wt(TASK_A), "other.txt"), "belongs to another task\n", "utf8");
    writeFileSync(claimFilePath(worktreeRoot, TASK_A), JSON.stringify({
      claim_schema_version: 1,
      state: "ready",
      task_id: "SOME-OTHER-TASK",
      repo: "tsworkflow/jarvisbuild",
      repo_path: resolve(repoPath),
      control_issue: 68,
      task_comment_id: 1,
      worktree_path: resolve(wt(TASK_A)),
      baseline_sha: baseline
    }, null, 2), "utf8");

    const res = await runWorker("report", MUTATE_SILENT);

    expect(res.code).toBe(3);
    expect(dispatched()).toEqual([]);
    expect(readFileSync(join(wt(TASK_A), "other.txt"), "utf8")).toBe("belongs to another task\n");
    // The foreign claim is evidence: it is not overwritten by ours.
    expect(JSON.parse(readFileSync(claimFilePath(worktreeRoot, TASK_A), "utf8")).task_id).toBe("SOME-OTHER-TASK");
  }, 120_000);
});

describe("D-133: one task's dirty context never reaches another task", () => {
  it("a newer task runs in its OWN worktree and is not blocked by the older task's dirt", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T04:00:00Z", 1)]);

    // Task A leaves real uncommitted work behind.
    await runWorker("silent", MUTATE_SILENT);
    expect(statusLines(wt(TASK_A)).length).toBeGreaterThan(0);

    // A newer task arrives while A is still dirty and still retryable.
    appendComment(architectTask(TASK_B, "2026-09-11T05:00:00Z", 2));
    elapseBackoff(TASK_A);

    const res = await runWorker("report", { JARVIS_FAKE_CLAUDE_MUTATE: "untracked" });

    // The newer, never-dispatched task wins the queue and is NOT blocked.
    expect(dispatched()).toEqual([TASK_A, TASK_B]);
    expect(res.code).toBe(0);
    expect(task(TASK_B).status).toBe(TASK_STATUS.COMPLETED);

    // It executed in its OWN context, not inside A's.
    const bPrompt = prompts()[1];
    expect(bPrompt.cwd).toBe(resolve(wt(TASK_B)));
    expect(bPrompt.cwd).not.toBe(resolve(wt(TASK_A)));
    expect(claim(TASK_B).claim.task_id).toBe(TASK_B);

    // A's uncommitted work is untouched, and invisible from B.
    expect(existsSync(join(wt(TASK_A), `work-${TASK_A}.md`))).toBe(true);
    expect(existsSync(join(wt(TASK_B), `work-${TASK_A}.md`))).toBe(false);
    expect(statusLines(wt(TASK_A))).toEqual(expect.arrayContaining([
      expect.stringMatching(/tracked\.txt$/)
    ]));

    // And the user's checkout stayed clean through both dispatches.
    expect(statusLines(repoPath)).toEqual([]);
  }, 240_000);

  it("two tasks can hold uncommitted work simultaneously without either stalling", async () => {
    setComments([
      architectTask(TASK_A, "2026-09-11T04:00:00Z", 1),
      architectTask(TASK_B, "2026-09-11T05:00:00Z", 2)
    ]);

    await runWorker("silent", MUTATE_SILENT);   // oldest fresh task first: A
    elapseBackoff(TASK_A);
    await runWorker("silent", MUTATE_SILENT);   // B is fresh, so B outranks A's retry

    expect(dispatched()).toEqual([TASK_A, TASK_B]);
    expect(statusLines(wt(TASK_A)).length).toBeGreaterThan(0);
    expect(statusLines(wt(TASK_B)).length).toBeGreaterThan(0);
    expect(statusLines(repoPath)).toEqual([]);

    // Each context is bound to its own task; neither claim covers the other.
    expect(claim(TASK_A).claim.task_id).toBe(TASK_A);
    expect(claim(TASK_B).claim.task_id).toBe(TASK_B);

    // A is still dispatchable despite B's dirty context existing.
    elapseBackoff(TASK_A);
    elapseBackoff(TASK_B);
    await runWorker("report", MUTATE_SILENT);
    expect(dispatched().length).toBe(3);
  }, 300_000);
});

describe("D-133: a restart preserves ownership and does not duplicate work", () => {
  it("a resumed attempt reuses the same worktree and adds no duplicate commit", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T04:00:00Z", 1)]);

    // Attempt 1 COMMITS real work, then exits 0 with no report - the
    // crash-after-work-before-report shape.
    await runWorker("silent", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked,untracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1"
    });
    const afterFirst = head(wt(TASK_A));
    expect(afterFirst).not.toBe(baseline);
    expect(log(wt(TASK_A))).toHaveLength(2);

    // Two further restarts, each with the backoff wound back. The child makes
    // no new changes this time, so nothing new should be committed.
    for (let i = 0; i < 2; i += 1) {
      elapseBackoff(TASK_A);
      await runWorker("silent");
    }

    // Same worktree, same commit - resumed, not restarted from the baseline.
    expect(head(wt(TASK_A))).toBe(afterFirst);
    expect(log(wt(TASK_A))).toHaveLength(2);
    expect(claim(TASK_A).claim.attempts).toHaveLength(3);
    expect(claim(TASK_A).claim.first_attempt_id).toBe(claim(TASK_A).claim.attempts[0].attempt_id);

    // The task's own provenance is handed to every resumed attempt.
    const last = prompts()[prompts().length - 1];
    expect(last.cwd).toBe(resolve(wt(TASK_A)));
    expect(last.prompt).toContain("ISOLATED TASK WORKTREE");
    expect(last.prompt).toContain(afterFirst);

    // The user's checkout never saw any of it.
    expect(statusLines(repoPath)).toEqual([]);
    expect(head(repoPath)).toBe(baseline);
  }, 240_000);

  it("a crashed parent that left the task IN_PROGRESS resumes in the same claimed context", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T04:00:00Z", 1)]);
    await runWorker("silent", MUTATE_SILENT);

    const firstClaim = claim(TASK_A).claim;
    const dirtyBefore = statusLines(wt(TASK_A));

    // Simulate a parent that died mid-dispatch: the record is left IN_PROGRESS
    // with no child identity, which is the pre-spawn-crash shape the recovery
    // pass handles.
    const s = state();
    s.tasks[TASK_A].status = TASK_STATUS.IN_PROGRESS;
    s.tasks[TASK_A].child_identity = null;
    saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"), { schema: "worker" });

    await runWorker("report");   // recovery run: converts it back to retryable
    elapseBackoff(TASK_A);
    await runWorker("report");   // and then re-dispatches it

    // The recovered attempt landed in the SAME claimed directory, and the
    // earlier uncommitted work was neither lost nor treated as foreign.
    const resumed = prompts()[prompts().length - 1];
    expect(resumed.cwd).toBe(resolve(wt(TASK_A)));
    expect(claim(TASK_A).claim.first_attempt_id).toBe(firstClaim.first_attempt_id);
    expect(claim(TASK_A).claim.baseline_sha).toBe(baseline);
    for (const line of dirtyBefore) {
      expect(statusLines(wt(TASK_A))).toContain(line);
    }
    expect(statusLines(repoPath)).toEqual([]);
  }, 240_000);
});

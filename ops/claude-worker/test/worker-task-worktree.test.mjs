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
import { COMMIT_PROVENANCE } from "../lib/provenance.mjs";
import { createRepo, statusLines, head, log, logBodies, git, foreignCommit } from "./fixtures/real-git-repo.mjs";

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
    // D-166: an ISOLATED admission ledger. The default root is derived from
    // repoOwner/repoName/controlIssue - which this fixture sets to the REAL
    // tsworkflow/jarvisbuild issue 68 - so without this every test would share
    // one host-global ledger with each other AND with the live worker, and the
    // first terminalised task id would refuse every later test that reuses it.
    admissionRoot: join(workerRoot, "admission"),
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

/** Wait for a file the fixture writes, so a test never synchronises on a sleep. */
async function waitForFile(path, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
}

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
    // D-139 B: the resumed attempt COMMITS what it finds and what it adds. The
    // property under test is resumption in the same proven context, and the
    // prompt assertions below still prove the child was told the existing dirt
    // is its own. A resumed attempt that reported COMPLETE while leaving work
    // uncommitted would now be held on the cleanliness half of the gate - which
    // is correct, but is a different test (see worker-crash-provenance).
    const second = await runWorker("report", { ...MUTATE_SILENT, JARVIS_FAKE_CLAUDE_COMMIT: "1" });

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

    // D-139 B: B COMMITS what it does. The property under test is isolation -
    // that B runs in its own context and is not blocked by A's dirt - and a
    // child that left its own work uncommitted would now be held on the
    // cleanliness half of the gate, which would prove nothing about isolation.
    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_MUTATE: "untracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1"
    });

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

  it("a resumed attempt that committed WITH evidence trailers is told the commits are proven its own", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T04:00:00Z", 1)]);

    // A well-behaved child: it commits, and it stamps the task/attempt trailers
    // the worker gave it. That - and only that - is what makes the commit
    // provably the task's rather than merely concurrent with it.
    await runWorker("silent", { JARVIS_FAKE_CLAUDE_MUTATE: "tracked,untracked", JARVIS_FAKE_CLAUDE_COMMIT: "1" });

    const committed = head(wt(TASK_A));
    expect(committed).not.toBe(baseline);
    expect(logBodies(wt(TASK_A))[0].message).toContain(`Jarvis-Task-Id: ${TASK_A}`);

    const rec = task(TASK_A);
    expect(rec.commit_provenance.verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(rec.commit_provenance.verified).toBe(true);
    expect(rec.commit_provenance.attributed_commits.map((c) => c.sha)).toEqual([committed]);
    expect(rec.commit_provenance.unattributed_commits).toEqual([]);
    // The attempt id in the evidence is the one the claim actually issued.
    expect(claim(TASK_A).claim.attempts.map((a) => a.attempt_id))
      .toContain(rec.commit_provenance.attributed_commits[0].attempt_id);

    elapseBackoff(TASK_A);
    await runWorker("silent");

    const resumed = prompts()[prompts().length - 1].prompt;
    expect(resumed).toContain("COMMIT PROVENANCE: VERIFIED AS THIS TASK'S OWN WORK");
    expect(resumed).toContain(committed);
    expect(resumed).not.toContain("COMMIT PROVENANCE: UNVERIFIED");
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

/**
 * D-134, THE ADVERSARIAL CASE, through the real entrypoint against real git.
 *
 * PR #80 review blocker: D-132/D-133 told a resumed child that any HEAD movement
 * during an attempt window was "THIS TASK'S OWN WORK". That is not an inference
 * the worker is entitled to make. It reads the ref twice; it cannot see who
 * moved it in between, and any process with access to the worktree can.
 *
 * So here an UNRELATED WRITER - the test process, using a different git identity
 * and touching a file the child never touches - commits into the isolated task
 * worktree WHILE an attempt is genuinely running. Everything the worker records
 * is then exactly what it records for a legitimate self-made commit:
 * head_before != head_after, in the task's own claimed directory, inside the
 * attempt window.
 *
 * The required outcome is not "detect the intruder" - that is not knowable. It
 * is: do not CLAIM to know. Preserve the commit, present it as unverified, and
 * authorise nothing destructive in either direction.
 *
 * Real git, real worktree, real process boundary: a fake git would simply agree
 * with whatever the worker concluded, which is worthless for this property.
 */
describe("D-134: an unrelated writer moves the worktree HEAD during a running attempt", () => {
  /** Drive an attempt with a real, observable running window and race a commit into it. */
  async function attemptWithForeignCommit(extraEnv = {}) {
    setComments([architectTask(TASK_A, "2026-09-11T04:00:00Z", 1)]);

    const run = runWorker("silent-slow", {
      // By default the child makes only UNCOMMITTED changes, so the only thing
      // that moves HEAD in this window is the foreign writer. That keeps the
      // assertion about authorship rather than about ordering.
      JARVIS_FAKE_CLAUDE_MUTATE: "untracked",
      JARVIS_FAKE_CLAUDE_LINGER_MS: "12000",
      ...extraEnv
    });

    // Synchronise on the fixture's own "I am running" marker, not on a sleep.
    await waitForFile(join(claudeDir, "running"), 90_000);
    const foreign = foreignCommit(wt(TASK_A));

    const res = await run;
    return { res, foreign };
  }

  /** Resume once more and return the prompt the resumed child was handed. */
  async function resumePrompt() {
    elapseBackoff(TASK_A);
    await runWorker("silent");
    return prompts()[prompts().length - 1].prompt;
  }

  it("does not call the foreign commit task-owned and does not accept it as task output", async () => {
    const { foreign } = await attemptWithForeignCommit();

    // The setup is real: HEAD genuinely moved inside the attempt window, in the
    // task's own claimed worktree, and the commit is genuinely not the child's.
    expect(head(wt(TASK_A))).toBe(foreign);
    const rec = task(TASK_A);
    expect(rec.head_before).toBe(baseline);
    expect(rec.head_after).toBe(foreign);

    // The verdict answers the question instead of assuming it.
    expect(rec.commit_provenance.verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(rec.commit_provenance.verified).toBe(false);
    expect(rec.commit_provenance.attributed_commits).toEqual([]);
    expect(rec.commit_provenance.unattributed_commits.map((c) => c.sha)).toEqual([foreign]);

    // --- the resume prompt: the part that actually reaches a decision-maker ---
    const resumed = await resumePrompt();

    expect(resumed).toContain("COMMIT PROVENANCE: UNVERIFIED");
    expect(resumed).toContain(foreign);
    // It is never described as the task's own work, in any of the old phrasings.
    expect(resumed).not.toContain("THIS TASK'S OWN WORK");
    expect(resumed).not.toContain("HEAD ADVANCED during that attempt");
    expect(resumed).not.toContain("TASK-OWNED PROVENANCE");
    expect(resumed).not.toMatch(/Treat them as yours/);
    // And it is not accepted as this attempt's output either.
    expect(resumed).toContain("Do NOT adopt them as this task's output");
    expect(resumed).toContain("A moved HEAD is an OBSERVATION, not proof of authorship");
  }, 300_000);

  it("authorises NO destructive reconciliation, and destroys nothing itself", async () => {
    const { foreign } = await attemptWithForeignCommit();
    const resumed = await resumePrompt();

    // The explicit prohibition is present...
    expect(resumed).toMatch(/Never stash, reset, revert, clean, checkout over, force-push, rebase or/);
    // ...and no destructive instruction is offered anywhere in the prompt.
    for (const forbidden of [/\bgit stash\b/, /\bgit reset\b/, /\bgit revert\b/, /\bgit clean\b/, /--force\b/]) {
      expect(resumed).not.toMatch(forbidden);
    }

    // The worker did not act on it either: the foreign commit is still there,
    // still reachable, and the file it introduced is untouched.
    expect(head(wt(TASK_A))).toBe(foreign);
    expect(existsSync(join(wt(TASK_A), "unrelated-writer.txt"))).toBe(true);
    expect(log(wt(TASK_A))).toHaveLength(2);

    // The claim is intact and the user's primary checkout never saw any of it.
    expect(claim(TASK_A).claim.state).toBe(CLAIM_STATE.READY);
    expect(statusLines(repoPath)).toEqual([]);
    expect(head(repoPath)).toBe(baseline);
  }, 300_000);

  it("a MIXED range - the child's own commit plus a foreign one - is unverified as a whole", async () => {
    const { foreign } = await attemptWithForeignCommit({
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked,untracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1"
    });

    const rec = task(TASK_A);
    // One of each: the child's stamped commit, and the intruder's.
    expect(rec.commit_provenance.verdict).toBe(COMMIT_PROVENANCE.PARTIAL);
    expect(rec.commit_provenance.verified).toBe(false);
    expect(rec.commit_provenance.attributed_commits).toHaveLength(1);
    expect(rec.commit_provenance.unattributed_commits.map((c) => c.sha)).toEqual([foreign]);

    const resumed = await resumePrompt();

    // One unexplained commit poisons the whole range: partial trust is not trust.
    expect(resumed).toContain("COMMIT PROVENANCE: UNVERIFIED");
    expect(resumed).not.toContain("VERIFIED AS THIS TASK'S OWN WORK");
    expect(resumed).toContain(foreign);
  }, 300_000);

  it("a commit made WITHOUT the evidence trailers is unverified, even from the worker's own child", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T04:00:00Z", 1)]);

    // The forgetful child: it really is the worker's own, and it really did the
    // work - but it left no evidence, so nothing can prove that afterwards.
    // Fail-closed means this is treated as unknown, NOT waved through because
    // "it was probably ours". The work is still preserved.
    await runWorker("silent", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked,untracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1",
      JARVIS_FAKE_CLAUDE_NO_TRAILER: "1"
    });

    const committed = head(wt(TASK_A));
    expect(committed).not.toBe(baseline);
    const rec = task(TASK_A);
    expect(rec.commit_provenance.verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(rec.commit_provenance.verified).toBe(false);

    const resumed = await resumePrompt();
    expect(resumed).toContain("COMMIT PROVENANCE: UNVERIFIED");
    expect(resumed).not.toContain("THIS TASK'S OWN WORK");
    // Preserved regardless: unverified is not unwanted.
    expect(head(wt(TASK_A))).toBe(committed);
    expect(log(wt(TASK_A))).toHaveLength(2);
  }, 300_000);

  it("an unrelated writer that REWINDS the ref is reported as drifted, and nothing is restored", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T04:00:00Z", 1)]);

    // Attempt 1: the child commits its own, properly stamped work.
    await runWorker("silent", { JARVIS_FAKE_CLAUDE_MUTATE: "tracked", JARVIS_FAKE_CLAUDE_COMMIT: "1" });
    const mine = head(wt(TASK_A));
    expect(task(TASK_A).commit_provenance.verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);

    // Then an unrelated writer replaces the tip with an unrelated history while
    // no attempt is running at all. A stored "verified" verdict must not survive
    // that: it was true about a tip the worktree no longer sits on.
    git(wt(TASK_A), ["checkout", "--detach", baseline]);
    const rewound = foreignCommit(wt(TASK_A), { file: "rewritten.txt", message: "replacement history" });
    expect(rewound).not.toBe(mine);

    const resumed = await resumePrompt();

    expect(resumed).toContain("COMMIT PROVENANCE: UNVERIFIED");
    expect(resumed).not.toContain("VERIFIED AS THIS TASK'S OWN WORK");
    expect(resumed).toMatch(/moved again AFTER the previous attempt had already ended/);

    // The worker restored nothing and rewrote nothing: the tip is exactly where
    // the unrelated writer left it, and the earlier commit still exists.
    expect(head(wt(TASK_A))).toBe(rewound);
    expect(git(wt(TASK_A), ["cat-file", "-t", mine])).toBe("commit");
    expect(statusLines(repoPath)).toEqual([]);
  }, 300_000);
});

/**
 * D-135: THE ADVERSARIAL CASE D-134 SET UP AND THEN DID NOT ACT ON.
 *
 * Everything above proves the worker ANSWERS the authorship question honestly.
 * None of it proves the answer CHANGES anything, and it did not: the completion
 * path read `completion.complete` and nothing else. So the full adversarial
 * scenario - unrelated writer advances the claimed worktree's HEAD inside the
 * attempt window, AND the child posts a genuine, trusted `STATUS=COMPLETE` -
 * still ended in a clean success. The worker marked the task completed and
 * successful, emitted COMPLETION_CONFIRMED, released the worktree holding the
 * unexplained commit, and that record then retired strictly older, still-valid
 * tasks through the queue's fresh-truth supersession rule.
 *
 * This is that exact scenario, through the real entrypoint, against a real git
 * repository. The two halves - the foreign commit and the trusted success report
 * - must BOTH be real for the test to mean anything: a fake verdict or a
 * hand-written state row would prove only that the assertion matches itself.
 */
describe("D-135: a foreign commit mid-attempt + a trusted STATUS=COMPLETE is NOT a success", () => {
  const TASK_OLDER = "D135-OLDER-TASK-20260911-A";

  function healthEvents() {
    const path = join(workerRoot, "logs", "health.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  function statusComments() {
    return comments().filter((c) => String(c.body ?? "").includes("REASON="));
  }

  /**
   * One attempt in which the child posts a REAL trusted completion report and an
   * unrelated writer commits into the claimed worktree while it is still running.
   */
  async function successReportRacedByForeignCommit(extraEnv = {}) {
    const run = runWorker("report-slow", {
      // Untracked only: the child never commits, so the ONLY thing that moves
      // HEAD in this window is the foreign writer. That keeps the assertion
      // about authorship rather than about ordering.
      JARVIS_FAKE_CLAUDE_MUTATE: "untracked",
      JARVIS_FAKE_CLAUDE_LINGER_MS: "12000",
      ...extraEnv
    });

    // `report-slow` writes `running` AFTER it has posted its report, so by the
    // time the foreign commit lands, the trusted success claim already exists.
    await waitForFile(join(claudeDir, "running"), 90_000);
    const foreign = foreignCommit(wt(TASK_A));

    const res = await run;
    return { res, foreign };
  }

  it("the setup is real: a trusted COMPLETE report AND an unexplained commit", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T05:00:00Z", 2)]);
    const { foreign } = await successReportRacedByForeignCommit();

    // The report genuinely exists, is genuinely trusted, and genuinely says
    // COMPLETE. Nothing about this half is faked or weakened.
    const posted = comments().filter((c) => String(c.body ?? "").startsWith("CLAUDE_REPORT"));
    expect(posted).toHaveLength(1);
    expect(posted[0].user.login).toBe(TRUSTED);
    expect(posted[0].body).toContain(`TASK_ID=${TASK_A}`);
    expect(posted[0].body).toContain("STATUS=COMPLETE");

    // And the commit genuinely is not the child's.
    expect(head(wt(TASK_A))).toBe(foreign);
    const rec = task(TASK_A);
    expect(rec.head_before).toBe(baseline);
    expect(rec.head_after).toBe(foreign);
    expect(rec.commit_provenance.verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(rec.commit_provenance.verified).toBe(false);
  }, 300_000);

  it("the task is NOT successful and NOT completed - it is parked for reconciliation", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T05:00:00Z", 2)]);
    const { res, foreign } = await successReportRacedByForeignCommit();

    const rec = task(TASK_A);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.status).not.toBe(TASK_STATUS.COMPLETED);
    // Positively false, not merely absent: the queue's supersession rule demands
    // a positive `true`, so an absent field must never drift into meaning success.
    expect(rec.successful).toBe(false);
    expect(rec.completed_at).toBeUndefined();

    // The gate is recorded durably, with the evidence that produced it.
    expect(rec.completion_gate.held).toBe(true);
    expect(rec.completion_gate.reason).toBe("commit_provenance_unverified");
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(rec.completion_gate.unattributed_commits).toEqual([foreign]);
    expect(rec.completion_gate.report_status).toBe("COMPLETE");

    // The run itself does not claim to be healthy.
    expect(res.code).not.toBe(0);
  }, 300_000);

  it("COMPLETION_CONFIRMED is never emitted, and the block is visible instead", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T05:00:00Z", 2)]);
    await successReportRacedByForeignCommit();

    const events = healthEvents();
    // The decisive negative: nothing in the health journal says this completed.
    expect(events.filter((e) => e.event === "completion_confirmed")).toEqual([]);

    const blocked = events.filter((e) => e.event === "blocked" && e.reason === "completion_gate_held");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].task_id).toBe(TASK_A);
    expect(blocked[0].verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    // Not retryable: a second child must not be launched on top of commits
    // nobody has accounted for.
    expect(blocked[0].retryable).toBe(false);

    // And a human-readable status notice was posted, naming what was refused.
    const notice = statusComments().find((c) => c.body.includes("completion_gate_held"));
    expect(notice).toBeTruthy();
    expect(notice.body).toContain("claims SUCCESSFUL completion");
    expect(notice.body).toContain("did NOT release or remove");
  }, 300_000);

  it("the worktree, the claim and the foreign commit all survive untouched", async () => {
    setComments([architectTask(TASK_A, "2026-09-11T05:00:00Z", 2)]);
    const { foreign } = await successReportRacedByForeignCommit();

    // The worktree was NOT released - which is the concrete difference the gate
    // makes, because a successful completion would have removed this directory.
    expect(existsSync(wt(TASK_A))).toBe(true);
    expect(claim(TASK_A).claim.state).toBe(CLAIM_STATE.READY);
    expect(claim(TASK_A).claim.released_at ?? null).toBeNull();
    expect(git(repoPath, ["worktree", "list", "--porcelain"])).toContain(wt(TASK_A).replace(/\\/g, "/"));

    // The foreign commit and its file are exactly where the intruder left them,
    // and the child's own uncommitted work is still there too.
    expect(head(wt(TASK_A))).toBe(foreign);
    expect(log(wt(TASK_A))).toHaveLength(2);
    expect(existsSync(join(wt(TASK_A), "unrelated-writer.txt"))).toBe(true);
    expect(existsSync(join(wt(TASK_A), `work-${TASK_A}.md`))).toBe(true);

    // Nothing reached the user's checkout.
    expect(statusLines(repoPath)).toEqual([]);
    expect(head(repoPath)).toBe(baseline);
  }, 300_000);

  it("retains the worktree even when it is CLEAN - the gate is the only thing stopping release", async () => {
    // The case above is not sufficient on its own: the child left an untracked
    // file there, and `releaseTaskWorktree` refuses on a dirty worktree anyway,
    // so the retention could not be attributed to the gate. Here the child makes
    // NO uncommitted changes and the foreign writer commits its own file, so the
    // worktree ends CLEAN at the unexplained tip - the exact state in which a
    // successful completion WOULD have removed the directory.
    setComments([architectTask(TASK_A, "2026-09-11T05:00:00Z", 2)]);
    const { foreign } = await successReportRacedByForeignCommit({ JARVIS_FAKE_CLAUDE_MUTATE: "" });

    expect(statusLines(wt(TASK_A))).toEqual([]);   // genuinely clean
    expect(head(wt(TASK_A))).toBe(foreign);        // and genuinely at the foreign tip

    expect(task(TASK_A).completion_gate.held).toBe(true);
    expect(existsSync(wt(TASK_A))).toBe(true);
    expect(claim(TASK_A).claim.state).toBe(CLAIM_STATE.READY);
    expect(claim(TASK_A).claim.released_at ?? null).toBeNull();
    expect(existsSync(join(wt(TASK_A), "unrelated-writer.txt"))).toBe(true);
  }, 300_000);

  it("the parked record cannot retire older valid work, and is never re-dispatched", async () => {
    // TASK_A is the NEWER order; the older one has never run. Before D-135 the
    // fresh `STATUS=COMPLETE` report made TASK_A count as "completed
    // successfully", so this strictly older task was retired as stale - work the
    // architect had asked for, discarded on the strength of a commit range the
    // worker itself could not account for.
    setComments([architectTask(TASK_A, "2026-09-11T05:00:00Z", 2)]);
    await successReportRacedByForeignCommit();
    expect(task(TASK_A).completion_gate.held).toBe(true);

    appendComment(architectTask(TASK_OLDER, "2026-09-11T04:00:00Z", 1));
    await runWorker("silent");

    // The older task ran, on its own merits.
    expect(dispatched()).toContain(TASK_OLDER);
    const older = task(TASK_OLDER);
    expect(older.status).not.toBe(TASK_STATUS.SUPERSEDED);
    expect(older.superseded_by ?? null).toBeNull();

    // The held task was not touched again: still BLOCKED, still never completed,
    // still one dispatch only, and its worktree is still retained.
    expect(dispatched().filter((d) => d === TASK_A)).toHaveLength(1);
    expect(task(TASK_A).status).toBe(TASK_STATUS.BLOCKED);
    expect(task(TASK_A).successful).toBe(false);
    expect(claim(TASK_A).claim.state).toBe(CLAIM_STATE.READY);
    expect(healthEvents().filter((e) => e.event === "completion_confirmed" && e.task_id === TASK_A)).toEqual([]);
  }, 300_000);

  it("CONTROL: the same trusted report with NO foreign commit completes normally", async () => {
    // Without this, every assertion above could be satisfied by a worker that
    // simply never completes anything. Same fixture, same report, same mode -
    // the ONLY difference is that nobody races a commit into the worktree.
    setComments([architectTask(TASK_A, "2026-09-11T05:00:00Z", 2)]);
    const res = await runWorker("report-slow", {
      JARVIS_FAKE_CLAUDE_MUTATE: "",
      JARVIS_FAKE_CLAUDE_LINGER_MS: "1000"
    });

    const rec = task(TASK_A);
    expect(res.code).toBe(0);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    // HEAD never moved, so there was no authorship question to answer.
    expect(rec.commit_provenance.verdict).toBe(COMMIT_PROVENANCE.UNCHANGED);
    expect(rec.completion_gate.held).toBe(false);
    expect(rec.completion_gate.reason).toBe("commit_provenance_verified");
    expect(healthEvents().some((e) => e.event === "completion_confirmed" && e.task_id === TASK_A)).toBe(true);
  }, 300_000);
});

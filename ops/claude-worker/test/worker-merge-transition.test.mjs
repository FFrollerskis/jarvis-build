/**
 * D-145 process-level tests: the D-144 MERGE CLOSEOUT, through the ACTUAL worker
 * entrypoint, against a REAL git repository.
 *
 * ------------------------------------------------------------------------
 * WHAT IS REPRODUCED
 * ------------------------------------------------------------------------
 *
 * D-144's shape, with nothing simulated that matters:
 *
 *   - a REAL two-parent merge commit, built by `commit-tree` with GitHub's own
 *     committer identity, whose tree IS the approved head's tree - the object
 *     GitHub produces for a normal merge of an up-to-date branch;
 *   - a REAL child, dispatched by the real worker into its real isolated
 *     worktree, which fast-forwards that worktree onto the merge commit exactly
 *     as the real child synced local main, and then posts a REAL trusted
 *     `STATUS=COMPLETE`;
 *   - the REAL provenance machinery, which classifies the resulting range as
 *     `unattributed` - because it genuinely is: Claude did not write that commit
 *     and could not have trailered it.
 *
 * Under the code before this change that combination produced `STATUS=BLOCKED`
 * (issue #68 comment 5672082571). It must now retire successfully - and the
 * commit must STILL never be attributed to the task.
 *
 * ------------------------------------------------------------------------
 * WHY THE NEGATIVES ARE HALF THE FILE
 * ------------------------------------------------------------------------
 *
 * A change that makes one blocked task pass is worthless if it makes anything
 * else pass too. Every negative below is the SAME successful merge fixture with
 * exactly one fact altered, driven through the same real entrypoint, and every
 * one of them must still be held.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { loadState, TASK_STATUS } from "../lib/state.mjs";
import { isProcessAlive } from "../lib/procid.mjs";
import { readClaim, claimFilePath, taskWorktreePath, CLAIM_STATE } from "../lib/worktree.mjs";
import { COMMIT_PROVENANCE, COMPLETION_GATE } from "../lib/provenance.mjs";
import { MERGE_TRANSITION, TRANSITION_EXCUSE } from "../lib/merge-transition.mjs";
import {
  createRepo, statusLines, head, git, treeOf, parentsOf, syntheticMerge, treeWithExtraFile
} from "./fixtures/real-git-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "worker.mjs");
const FAKE_GH = join(HERE, "fixtures", "fake-gh.mjs");
const FAKE_CLAUDE = join(HERE, "fixtures", "fake-claude.mjs");

const TRUSTED = "tsworkflow";
/** The real D-144 task id, so the fixture is unmistakably that sequence. */
const MERGE_TASK = "D144-PR80-MERGE-CLOSEOUT-20260915-A";
const PLAIN_TASK = "D145-ORDINARY-IMPLEMENTATION-20260915-A";
const PR = 80;

let dir;
let workerRoot;
let repoPath;
let ghDir;
let claudeDir;
let configPath;
let worktreeRoot;
/** previous main (the authorized base) and the PR head the worktree starts at. */
let prevMain;
let prHead;
let stray;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-d145-"));
  workerRoot = join(dir, "worker");
  repoPath = join(dir, "repo");
  ghDir = join(dir, "gh");
  claudeDir = join(dir, "claude");
  worktreeRoot = join(workerRoot, "worktrees");
  for (const d of [workerRoot, ghDir, claudeDir, join(workerRoot, "logs"), worktreeRoot]) {
    mkdirSync(d, { recursive: true });
  }
  stray = [];

  // Two real commits: the base the architect authorized, and the PR head that
  // was reviewed. The worktree baseline is the repo's HEAD, i.e. the PR head -
  // exactly D-144's starting position.
  ({ baseline: prevMain } = createRepo(repoPath));
  writeFileSync(join(repoPath, "feature.txt"), "the reviewed change\n", "utf8");
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "-m", "feat: the change PR #80 carries"]);
  prHead = head(repoPath);

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
  writeFileSync(join(ghDir, "commits.json"), JSON.stringify({}), "utf8");
  writeFileSync(join(ghDir, "check-runs.json"), JSON.stringify({}), "utf8");
  setComments([]);
});

afterEach(() => {
  for (const pid of stray) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

/** ---------------- the control-plane fixture ---------------- */

/** The trusted, owner-posted ARCHITECT_TASK that authorizes the D-144 merge. */
function mergeTask(overrides = {}) {
  const fields = {
    TASK_ID: MERGE_TASK,
    TASK_TYPE: "GUARDED_MERGE_AND_POSTMERGE_CLOSEOUT",
    REPO: "tsworkflow/jarvisbuild",
    PR_NUMBER: String(PR),
    EXPECTED_BASE_SHA: prevMain,
    EXPECTED_HEAD_SHA: prHead,
    ARCHITECT_MERGE_APPROVED: "true",
    MERGE_AUTHORIZED: "true",
    ...overrides
  };
  return {
    id: 5671900015,
    created_at: "2026-09-14T22:52:00Z",
    updated_at: "2026-09-14T22:52:00Z",
    author_association: "OWNER",
    user: { login: TRUSTED },
    body: ["ARCHITECT_TASK", ...Object.entries(fields).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`),
      "", "Perform the routine, guarded closeout merge for PR #80."].join("\n")
  };
}

/** An ORDINARY implementation order - no merge authorization anywhere in it. */
function ordinaryTask() {
  return {
    id: 5672177452,
    created_at: "2026-09-14T23:23:57Z",
    updated_at: "2026-09-14T23:23:57Z",
    author_association: "OWNER",
    user: { login: TRUSTED },
    body: `ARCHITECT_TASK\nTASK_ID=${PLAIN_TASK}\nARCHITECT_MERGE_APPROVED=false\nMERGE_AUTHORIZED=false\n`
      + "Do some ordinary implementation work."
  };
}

/**
 * Publish the remote truth a merged PR produces: the PR's merge state, the merge
 * commit's real parents and tree, the approved head's real tree, and green
 * post-merge check runs on the merge commit.
 */
function publishMerge(mergeSha, { checks = null, pull = {} } = {}) {
  writeFileSync(join(ghDir, "pulls.json"), JSON.stringify([{
    number: PR,
    headRefName: "claude/d132-worker-recovery-reconciliation",
    state: "closed",
    merged: true,
    mergedAt: "2026-09-14T23:05:00Z",
    mergeCommitSha: mergeSha,
    headSha: prHead,
    baseSha: prevMain,
    baseRef: "main",
    ...pull
  }], null, 2), "utf8");

  const commits = {};
  for (const sha of [mergeSha, prHead, prevMain]) {
    commits[sha] = { sha, treeSha: treeOf(repoPath, sha), parents: parentsOf(repoPath, sha) };
  }
  writeFileSync(join(ghDir, "commits.json"), JSON.stringify(commits, null, 2), "utf8");

  writeFileSync(join(ghDir, "check-runs.json"), JSON.stringify({
    [mergeSha]: checks ?? [
      { name: "build-test", status: "completed", conclusion: "success" },
      { name: "windows-git-auth", status: "completed", conclusion: "success" },
      { name: "gitleaks", status: "completed", conclusion: "success" }
    ]
  }, null, 2), "utf8");
}

function setComments(list) {
  writeFileSync(join(ghDir, "comments.json"), JSON.stringify(list, null, 2), "utf8");
}

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
  return new Promise((r) => child.on("close", (code) => r({ code, output: out })));
}

function state() {
  return loadState(join(workerRoot, "state.json"), join(workerRoot, "state.json.bak"), { schema: "worker" }).state;
}

function task(id) {
  return state()?.tasks?.[id] ?? null;
}

function wt(taskId) {
  return taskWorktreePath(worktreeRoot, taskId);
}

function claim(taskId) {
  return readClaim(claimFilePath(worktreeRoot, taskId));
}

function healthEvents() {
  const path = join(workerRoot, "logs", "health.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function dispatched() {
  const path = join(claudeDir, "dispatched.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

/**
 * The closeout evidence D-144's real report carried, field for field.
 *
 * D-146: this is no longer optional decoration. `merge_closeout_v1` requires
 * every one of these, bound to the verified truth, and the three local ones
 * (LOCAL_HEAD, ORIGIN_MAIN, WORKTREE_CLEAN) are the only evidence the worker will
 * ever have that the child actually synced and left nothing behind.
 */
function closeoutFields(mergeSha, overrides = {}) {
  return {
    MERGED: "true",
    MERGE_SHA: mergeSha,
    PARENT_1: prevMain,
    PARENT_2: prHead,
    EXPECTED_BASE_SHA: prevMain,
    EXPECTED_HEAD_SHA: prHead,
    TWO_PARENT_MERGE_VERIFIED: "true",
    POST_MERGE_CI_RUN: "34906721592",
    POST_MERGE_BUILD_TEST: "success",
    POST_MERGE_WINDOWS_GIT_AUTH: "success",
    POST_MERGE_GITLEAKS: "success",
    LOCAL_HEAD: mergeSha,
    ORIGIN_MAIN: mergeSha,
    WORKTREE_CLEAN: "true",
    SELF_APPROVAL: "false",
    HARD_EXTERNAL_BLOCKER: "false",
    ...overrides
  };
}

/**
 * The child that behaves exactly as D-144's did: sync locally, then post a
 * COMPLETE closeout report. `extra.closeout` overrides one report field (`null`
 * deletes it, an array emits it twice); any other key is passed through as an
 * environment variable.
 */
const mergeChild = (mergeSha, { closeout = {}, ...env } = {}) => ({
  JARVIS_FAKE_CLAUDE_SYNC_TO: mergeSha,
  JARVIS_FAKE_CLAUDE_PR: String(PR),
  JARVIS_FAKE_CLAUDE_REPORT_FIELDS: JSON.stringify(closeoutFields(mergeSha, closeout)),
  ...env
});

/* ==========================================================================
 * THE REGRESSION: D-144 RETIRES SUCCESSFULLY
 * ========================================================================== */

describe("D-145: the D-144 merge closeout retires successfully through the real entrypoint", () => {
  let merge;

  beforeEach(() => {
    merge = syntheticMerge(repoPath, { base: prevMain, head: prHead, message: `Merge pull request #${PR}` });
    publishMerge(merge);
    setComments([mergeTask()]);
  });

  it("the merge fixture really is a normal two-parent merge with the head's tree", () => {
    // The fixture is asserted before it is used: a fixture that quietly did not
    // reproduce GitHub's shape would make every test below meaningless.
    expect(parentsOf(repoPath, merge)).toEqual([prevMain, prHead]);
    expect(treeOf(repoPath, merge)).toBe(treeOf(repoPath, prHead));
    expect(treeOf(repoPath, merge)).not.toBe(treeOf(repoPath, prevMain));
  });

  it("completes: successful, confirmed, and the worktree released", async () => {
    const res = await runWorker("report", mergeChild(merge));

    expect(res.code).toBe(0);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    expect(rec.completed_at).toBeTruthy();
    expect(healthEvents().some((e) => e.event === "completion_confirmed" && e.task_id === MERGE_TASK)).toBe(true);
    // A settled, successful task releases its worktree and keeps the claim.
    expect(existsSync(wt(MERGE_TASK))).toBe(false);
    expect(claim(MERGE_TASK).claim.state).toBe(CLAIM_STATE.RELEASED);
  }, 300_000);

  it("the worktree HEAD really did advance onto the GitHub merge commit", async () => {
    // Without this the test could pass for the trivial reason that nothing ever
    // moved, which is a different (already-handled) case entirely.
    await runWorker("report", mergeChild(merge));
    const rec = task(MERGE_TASK);
    expect(rec.head_before).toBe(prHead);
    expect(rec.head_after).toBe(merge);
  }, 300_000);

  it("passes on TRANSITION evidence - and STILL does not attribute the commit to Claude", async () => {
    await runWorker("report", mergeChild(merge));
    const gate = task(MERGE_TASK).completion_gate;

    expect(gate.held).toBe(false);
    expect(gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
    // The honest half: the commit range verdict is UNCHANGED from what it was
    // when this task was blocked. Nothing claims Claude wrote the merge commit.
    expect(gate.provenance_verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(gate.unattributed_commits).toEqual([merge]);
    expect(task(MERGE_TASK).commit_provenance.attributed_count).toBe(0);
    expect(task(MERGE_TASK).commit_provenance.verified).toBe(false);

    // ...and the transition evidence that carried it is recorded in full.
    expect(gate.merge_transition_verified).toBe(true);
    expect(gate.merge_commit_sha).toBe(merge);
    expect(gate.transition_excused_commits).toEqual([merge]);
    const t = task(MERGE_TASK).merge_transition;
    expect(t.verified).toBe(true);
    expect(t.reason).toBe(MERGE_TRANSITION.VERIFIED);
    expect(t.pr_number).toBe(PR);
    expect(t.merge_parents).toEqual([prevMain, prHead]);
    expect(t.merge_tree_sha).toBe(t.head_tree_sha);
    expect(t.check_runs.map((r) => r.name).sort()).toEqual(["build-test", "gitleaks", "windows-git-auth"]);
  }, 300_000);

  it("the same shape also retires through the CRASH-RECOVERY path", async () => {
    // The four close-out paths must agree. A merge accepted after a clean
    // dispatch and refused after a crash would be the same split-brain D-135
    // removed from the other direction.
    const handle = spawn(process.execPath, [WORKER, "run"], {
      env: {
        ...process.env,
        JARVIS_WORKER_CONFIG: configPath,
        JARVIS_WORKER_GH: FAKE_GH,
        JARVIS_FAKE_GH_DIR: ghDir,
        JARVIS_FAKE_GH_AUTHOR: TRUSTED,
        JARVIS_FAKE_CLAUDE_DIR: claudeDir,
        JARVIS_FAKE_CLAUDE_MODE: "report-hang",
        ...mergeChild(merge)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const exited = new Promise((r) => handle.on("close", r));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !existsSync(join(claudeDir, "report-posted"))) {
      await new Promise((r) => setTimeout(r, 50));
    }
    handle.kill("SIGKILL");
    await exited;
    const childPid = Number(readFileSync(join(claudeDir, "child.pid"), "utf8"));
    stray.push(childPid);
    try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
    while (isProcessAlive(childPid)) await new Promise((r) => setTimeout(r, 50));

    // No provenance checkpoint was ever written, so the verdict is DERIVED.
    expect(task(MERGE_TASK).commit_provenance).toBeUndefined();
    expect(head(wt(MERGE_TASK))).toBe(merge);

    const res = await runWorker("silent");

    expect(res.code).toBe(0);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    expect(rec.recovered_from_crash).toBe(true);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
    expect(rec.reconciliation_provenance.verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    // And it was NOT dispatched a second time on top of an already-merged PR.
    expect(dispatched().filter((d) => d === MERGE_TASK)).toHaveLength(1);
  }, 300_000);

  it("nothing reaches the user's primary checkout", async () => {
    await runWorker("report", mergeChild(merge));
    expect(statusLines(repoPath)).toEqual([]);
    expect(head(repoPath)).toBe(prHead);
  }, 300_000);
});

/* ==========================================================================
 * ADVERSARIAL NEGATIVES, through the same real entrypoint
 * ========================================================================== */

describe("D-145: the transition path does not generalize - every deviation is still held", () => {
  /** Assert the run was refused, nothing was destroyed, and why. */
  async function expectHeld(extraEnv = {}, { gateReason = COMPLETION_GATE.HELD_PROVENANCE_UNVERIFIED } = {}) {
    const res = await runWorker("report", extraEnv);
    expect(res.code).toBe(3);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.successful).toBe(false);
    expect(rec.completed_at ?? null).toBe(null);
    expect(rec.completion_gate.held).toBe(true);
    expect(rec.completion_gate.reason).toBe(gateReason);
    expect(healthEvents().filter((e) => e.event === "completion_confirmed" && e.task_id === MERGE_TASK)).toEqual([]);
    // Preserved, never destroyed - the fail-closed direction that must not move.
    expect(existsSync(wt(MERGE_TASK))).toBe(true);
    expect(claim(MERGE_TASK).claim.state).toBe(CLAIM_STATE.READY);
    return rec;
  }

  it("a SQUASH merge (one parent) is refused", async () => {
    // A real squash merge: one commit, parented on the previous main only, with
    // the PR head nowhere in its ancestry. That is the shape `MERGE_METHOD=merge`
    // is supposed to exclude, and the parent count alone refutes it - no field
    // claiming a method is consulted.
    const squash = syntheticMerge(repoPath, { base: prevMain, head: prHead, squash: true, message: "Squashed #80" });
    expect(parentsOf(repoPath, squash)).toEqual([prevMain]);
    publishMerge(squash);
    setComments([mergeTask()]);

    const rec = await expectHeld(mergeChild(squash));
    expect(rec.merge_transition.verified).toBe(false);
    expect(rec.merge_transition.reason).toBe(MERGE_TRANSITION.NOT_A_TWO_PARENT_MERGE);
  }, 300_000);

  it("a merge whose SECOND PARENT is not the approved head is refused", async () => {
    // A real two-parent merge of a DIFFERENT commit: the review never saw it.
    git(repoPath, ["branch", "sneaky", prHead]);
    const wtPath = join(dir, "sneak");
    git(repoPath, ["worktree", "add", wtPath, "sneaky"]);
    writeFileSync(join(wtPath, "sneaky.txt"), "not reviewed\n", "utf8");
    git(wtPath, ["add", "-A"]);
    git(wtPath, ["commit", "-m", "unreviewed change"]);
    const otherHead = head(wtPath);
    git(repoPath, ["worktree", "remove", "--force", wtPath]);

    const merge = syntheticMerge(repoPath, { base: prevMain, head: otherHead, message: `Merge pull request #${PR}` });
    publishMerge(merge);
    setComments([mergeTask()]);

    const rec = await expectHeld(mergeChild(merge));
    expect(rec.merge_transition.reason).toBe(MERGE_TRANSITION.SECOND_PARENT_MISMATCH);
  }, 300_000);

  it("a merge onto a DIFFERENT base than the one authorized is refused", async () => {
    const merge = syntheticMerge(repoPath, { base: prevMain, head: prHead });
    publishMerge(merge);
    // The architect authorized a base that is not this merge's first parent.
    setComments([mergeTask({ EXPECTED_BASE_SHA: "1111111111111111111111111111111111111111" })]);

    const rec = await expectHeld(mergeChild(merge));
    expect(rec.merge_transition.reason).toBe(MERGE_TRANSITION.FIRST_PARENT_MISMATCH);
  }, 300_000);

  it("a two-parent merge carrying EXTRA CONTENT is refused", async () => {
    // Perfectly well-formed parents; a tree the review never saw.
    const tree = treeWithExtraFile(repoPath, prHead);
    const merge = syntheticMerge(repoPath, { base: prevMain, head: prHead, tree });
    publishMerge(merge);
    setComments([mergeTask()]);

    const rec = await expectHeld(mergeChild(merge));
    expect(rec.merge_transition.reason).toBe(MERGE_TRANSITION.TREE_MISMATCH);
  }, 300_000);

  it("a PR that is NOT merged is refused", async () => {
    const merge = syntheticMerge(repoPath, { base: prevMain, head: prHead });
    publishMerge(merge, { pull: { merged: false, mergeCommitSha: null } });
    setComments([mergeTask()]);

    const rec = await expectHeld(mergeChild(merge));
    expect(rec.merge_transition.reason).toBe(MERGE_TRANSITION.NOT_MERGED);
  }, 300_000);

  it("a FAILING required post-merge check run is refused", async () => {
    // D-146: all three REQUIRED checks are present, so the refusal is about the
    // one that failed rather than about one that never ran. The "a required check
    // is simply absent" case is a separate test below, because the two used to be
    // indistinguishable and only one of them was being caught.
    const merge = syntheticMerge(repoPath, { base: prevMain, head: prHead });
    publishMerge(merge, { checks: [
      { name: "build-test", status: "completed", conclusion: "success" },
      { name: "windows-git-auth", status: "completed", conclusion: "success" },
      { name: "gitleaks", status: "completed", conclusion: "failure" }
    ] });
    setComments([mergeTask()]);

    const rec = await expectHeld(mergeChild(merge));
    expect(rec.merge_transition.reason).toBe(MERGE_TRANSITION.CHECKS_REQUIRED_NOT_SUCCESS);
  }, 300_000);

  it("an UNRELATED commit riding alongside the merge commit is refused", async () => {
    // The sharpest negative in the file: the transition itself VERIFIES, and the
    // task is still held, because the range contains something it cannot account
    // for. This is the exact laundering the narrowing exists to stop.
    const merge = syntheticMerge(repoPath, { base: prevMain, head: prHead });
    publishMerge(merge);
    setComments([mergeTask()]);

    const rec = await expectHeld(mergeChild(merge, {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1",
      JARVIS_FAKE_CLAUDE_NO_TRAILER: "1"
    }));
    expect(rec.merge_transition.verified).toBe(true);
    expect(rec.merge_transition.reason).toBe(MERGE_TRANSITION.VERIFIED);
    expect(rec.completion_gate.transition_excuse_reason).toBe(TRANSITION_EXCUSE.MORE_THAN_THE_MERGE_COMMIT);
    expect(rec.completion_gate.unattributed_count).toBe(2);
  }, 300_000);

  it("a merge task that left its worktree DIRTY is refused (D-139 B still holds)", async () => {
    const merge = syntheticMerge(repoPath, { base: prevMain, head: prHead });
    publishMerge(merge);
    setComments([mergeTask()]);

    const rec = await expectHeld(
      mergeChild(merge, { JARVIS_FAKE_CLAUDE_MUTATE: "untracked" }),
      { gateReason: COMPLETION_GATE.HELD_WORKTREE_DIRTY }
    );
    // The transition verified; cleanliness is a separate question and it fails.
    expect(rec.merge_transition.verified).toBe(true);
  }, 300_000);

  it("a BLOCKED report for the merge task never completes it", async () => {
    const merge = syntheticMerge(repoPath, { base: prevMain, head: prHead });
    publishMerge(merge);
    setComments([mergeTask()]);

    await runWorker("report", mergeChild(merge, { JARVIS_FAKE_CLAUDE_STATUS: "BLOCKED" }));

    const rec = task(MERGE_TASK);
    // BLOCKED is a canonical TERMINAL status, so the row is retired from the
    // queue - but it is retired UNSUCCESSFULLY, and that is the property that
    // matters: `successful` is positively false, so nothing downstream (worktree
    // release, supersession of older work) can act on it.
    expect(rec.successful).toBe(false);
    expect(rec.report_status).toBe("BLOCKED");
    // The transition path was never even reached: the gate passes non-success
    // claims without consulting provenance or any merge evidence at all.
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_NOT_A_SUCCESS_CLAIM);
    expect(rec.completion_gate.merge_transition_verified).toBe(false);
    expect(rec.merge_transition ?? null).toBe(null);
    // Nothing was released or destroyed on the strength of a blocked report.
    expect(existsSync(wt(MERGE_TASK))).toBe(true);
    expect(claim(MERGE_TASK).claim.state).toBe(CLAIM_STATE.READY);
  }, 300_000);

  it("a FAILED report for the merge task never completes it successfully", async () => {
    const merge = syntheticMerge(repoPath, { base: prevMain, head: prHead });
    publishMerge(merge);
    setComments([mergeTask()]);

    await runWorker("report", mergeChild(merge, { JARVIS_FAKE_CLAUDE_STATUS: "FAILED" }));

    const rec = task(MERGE_TASK);
    expect(rec.successful).toBe(false);
    expect(rec.report_status).toBe("FAILED");
    expect(rec.merge_transition ?? null).toBe(null);
    expect(existsSync(wt(MERGE_TASK))).toBe(true);
  }, 300_000);

  it("an unauthorized task cannot borrow another task's merge: the authorization is per-task", async () => {
    // The real, owner-posted merge authorization for D-144 is on the issue. An
    // ORDINARY task's unexplained commit must not be excused by it.
    const merge = syntheticMerge(repoPath, { base: prevMain, head: prHead });
    publishMerge(merge);
    setComments([mergeTask(), ordinaryTask()]);

    // Both orders are on the issue; the worker dispatches one task per run, so
    // two runs retire both. The merge task is expected to pass - that is the
    // point: the SAME verified transition is on the issue, and it must not reach
    // the ordinary task's range.
    await runWorker("report", mergeChild(merge));
    await runWorker("report", mergeChild(merge));

    expect(task(MERGE_TASK).completion_gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);

    const rec = task(PLAIN_TASK);
    expect(rec).toBeTruthy();
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.successful).toBe(false);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.HELD_PROVENANCE_UNVERIFIED);
    // No transition was even attempted for it: it is not a merge task.
    expect(rec.completion_gate.merge_transition_verified).toBe(false);
    expect(rec.merge_transition ?? null).toBe(null);
  }, 300_000);
});

/* ==========================================================================
 * D-146: THE POST-MERGE EVIDENCE GATES, THROUGH THE REAL ENTRYPOINT
 *
 * The unit suite in `postmerge-evidence.test.mjs` proves the rules. These prove
 * the WIRING: that the real worker, dispatching a real child into a real
 * worktree against a real merge commit, actually reaches those rules and is
 * actually held by them. A rule nothing calls is not a gate.
 * ========================================================================== */

describe("D-146: required check identity and bound closeout evidence, end to end", () => {
  let merge;

  beforeEach(() => {
    merge = syntheticMerge(repoPath, { base: prevMain, head: prHead, message: `Merge pull request #${PR}` });
  });

  /**
   * Refused, nothing destroyed, and for the named post-merge reason.
   *
   * Deliberately ONE worker run per call: a BLOCKED task is never replayed, so a
   * second run inside the same test would assert the FIRST run's record again
   * and pass for the wrong reason.
   */
  async function expectHeldFor(reason, { checks = null, closeout = {}, order = null, env = {} } = {}) {
    publishMerge(merge, checks ? { checks } : {});
    setComments([order ?? mergeTask()]);

    const res = await runWorker("report", mergeChild(merge, { closeout, ...env }));
    expect(res.code).toBe(3);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.successful).toBe(false);
    expect(rec.completed_at ?? null).toBe(null);
    expect(rec.completion_gate.held).toBe(true);
    expect(rec.merge_transition.verified).toBe(false);
    expect(rec.merge_transition.reason).toBe(reason);
    expect(healthEvents().filter((e) => e.event === "completion_confirmed" && e.task_id === MERGE_TASK)).toEqual([]);
    // The fail-closed direction that must never move: preserved, not destroyed.
    expect(existsSync(wt(MERGE_TASK))).toBe(true);
    expect(claim(MERGE_TASK).claim.state).toBe(CLAIM_STATE.READY);
    return rec;
  }

  /** The three required checks, with one of them altered. */
  const checksWith = (name, over) => [
    { name: "build-test", status: "completed", conclusion: "success" },
    { name: "windows-git-auth", status: "completed", conclusion: "success" },
    { name: "gitleaks", status: "completed", conclusion: "success" }
  ].map((r) => (r.name === name ? { ...r, ...over } : r));

  describe("gap 1: an unrelated green check is not a required check", () => {
    it("ONLY an unrelated green check on the merge commit is refused", async () => {
      // The exact PR #81 fail-open, driven through the real worker: under D-145
      // this run completed successfully with `build-test` never having run.
      const rec = await expectHeldFor(MERGE_TRANSITION.CHECKS_REQUIRED_MISSING, {
        checks: [{ name: "some-other-job", status: "completed", conclusion: "success" }]
      });
      expect(rec.merge_transition.detail).toContain("build-test");
      expect(rec.merge_transition.required_checks)
        .toEqual(["build-test", "windows-git-auth", "gitleaks"]);
    }, 300_000);

    it("one required check MISSING while the other two are green is refused", async () => {
      const rec = await expectHeldFor(MERGE_TRANSITION.CHECKS_REQUIRED_MISSING, {
        checks: [
          { name: "build-test", status: "completed", conclusion: "success" },
          { name: "gitleaks", status: "completed", conclusion: "success" }
        ]
      });
      expect(rec.merge_transition.detail).toContain("windows-git-auth");
    }, 300_000);

    it("a DUPLICATE required check name is refused even when both copies are green", async () => {
      await expectHeldFor(MERGE_TRANSITION.CHECKS_REQUIRED_AMBIGUOUS, {
        checks: [
          { name: "build-test", status: "completed", conclusion: "success" },
          { name: "build-test", status: "completed", conclusion: "success" },
          { name: "windows-git-auth", status: "completed", conclusion: "success" },
          { name: "gitleaks", status: "completed", conclusion: "success" }
        ]
      });
    }, 300_000);

    it("a required check concluding NEUTRAL is refused", async () => {
      await expectHeldFor(MERGE_TRANSITION.CHECKS_REQUIRED_NOT_SUCCESS, {
        checks: checksWith("windows-git-auth", { conclusion: "neutral" })
      });
    }, 300_000);

    it("a required check concluding SKIPPED is refused", async () => {
      await expectHeldFor(MERGE_TRANSITION.CHECKS_REQUIRED_NOT_SUCCESS, {
        checks: checksWith("gitleaks", { conclusion: "skipped" })
      });
    }, 300_000);

    it("a required check that has not finished is refused", async () => {
      await expectHeldFor(MERGE_TRANSITION.CHECKS_REQUIRED_UNFINISHED, {
        checks: checksWith("build-test", { status: "in_progress", conclusion: null })
      });
    }, 300_000);

    it("a task declaring an EMPTY required set fails closed, never open", async () => {
      await expectHeldFor(MERGE_TRANSITION.POLICY_NO_REQUIRED_CHECKS, {
        order: mergeTask({ REQUIRED_POST_MERGE_CHECKS: "" })
      });
    }, 300_000);
  });

  describe("gap 2: the trusted report's LOCAL closeout evidence is bound", () => {
    it("a report that omits local sync entirely is refused", async () => {
      const rec = await expectHeldFor(MERGE_TRANSITION.REPORT_FIELD_MISSING, {
        closeout: { LOCAL_HEAD: null, ORIGIN_MAIN: null }
      });
      expect(rec.merge_transition.detail).toContain("LOCAL_HEAD");
    }, 300_000);

    it("LOCAL_HEAD still on the PR head - the child never synced - is refused", async () => {
      const rec = await expectHeldFor(MERGE_TRANSITION.REPORT_FIELD_MISMATCH, {
        closeout: { LOCAL_HEAD: prHead }
      });
      expect(rec.merge_transition.detail).toContain("LOCAL_HEAD");
    }, 300_000);

    it("ORIGIN_MAIN still on the old base is refused", async () => {
      const rec = await expectHeldFor(MERGE_TRANSITION.REPORT_FIELD_MISMATCH, {
        closeout: { ORIGIN_MAIN: prevMain }
      });
      expect(rec.merge_transition.detail).toContain("ORIGIN_MAIN");
    }, 300_000);

    it("a DIRTY report is refused although every remote fact is perfect", async () => {
      const rec = await expectHeldFor(MERGE_TRANSITION.REPORT_FIELD_MISMATCH, {
        closeout: { WORKTREE_CLEAN: "false" }
      });
      expect(rec.merge_transition.detail).toContain("WORKTREE_CLEAN");
    }, 300_000);

    it("a report whose MERGE_SHA is not the real merge sha is refused", async () => {
      const rec = await expectHeldFor(MERGE_TRANSITION.REPORT_FIELD_MISMATCH, {
        closeout: { MERGE_SHA: prHead }
      });
      expect(rec.merge_transition.detail).toContain("MERGE_SHA");
    }, 300_000);

    it("CONTRADICTORY duplicate fields are refused - neither value is chosen", async () => {
      const rec = await expectHeldFor(MERGE_TRANSITION.REPORT_FIELD_DUPLICATE, {
        closeout: { WORKTREE_CLEAN: ["false", "true"] }
      });
      expect(rec.merge_transition.detail).toContain("WORKTREE_CLEAN");
    }, 300_000);

    it("a report claiming a required check failed, against a green remote, is refused", async () => {
      await expectHeldFor(MERGE_TRANSITION.REPORT_CI_CONTRADICTS_REMOTE, {
        closeout: { POST_MERGE_BUILD_TEST: "failure" }
      });
    }, 300_000);

    it("a report naming a different PR than the authorization is refused", async () => {
      // Driven through the child's single canonical PR_NUMBER line, so this
      // asserts the BINDING rule and not the duplicate rule.
      const rec = await expectHeldFor(MERGE_TRANSITION.REPORT_FIELD_MISMATCH, {
        env: { JARVIS_FAKE_CLAUDE_PR: "81" }
      });
      expect(rec.merge_transition.detail).toContain("PR_NUMBER");
    }, 300_000);

    it("a report that states PR_NUMBER TWICE is ambiguous and refused on that ground", async () => {
      const rec = await expectHeldFor(MERGE_TRANSITION.REPORT_FIELD_DUPLICATE, {
        closeout: { PR_NUMBER: String(PR) }   // the child already emits one
      });
      expect(rec.merge_transition.detail).toContain("PR_NUMBER");
    }, 300_000);

    it("SELF_APPROVAL=true is refused", async () => {
      const rec = await expectHeldFor(MERGE_TRANSITION.REPORT_FIELD_MISMATCH, {
        closeout: { SELF_APPROVAL: "true" }
      });
      expect(rec.merge_transition.detail).toContain("SELF_APPROVAL");
    }, 300_000);

    it("the D-145-shaped report - STATUS only, no closeout evidence - no longer passes", async () => {
      // This is literally what the old fixture posted, and what the old verifier
      // accepted. It must now be refused for want of bindable evidence.
      publishMerge(merge);
      setComments([mergeTask()]);
      const res = await runWorker("report", {
        JARVIS_FAKE_CLAUDE_SYNC_TO: merge,
        JARVIS_FAKE_CLAUDE_PR: String(PR)
      });
      expect(res.code).toBe(3);
      const rec = task(MERGE_TASK);
      expect(rec.status).toBe(TASK_STATUS.BLOCKED);
      expect(rec.merge_transition.verified).toBe(false);
      expect(rec.merge_transition.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_MISSING);
    }, 300_000);
  });

  it("POSITIVE CONTROL: with every required check and every bound field, it still retires", async () => {
    // Without this, every assertion above would be satisfied by a gate that
    // simply refuses everything.
    publishMerge(merge);
    setComments([mergeTask()]);

    const res = await runWorker("report", mergeChild(merge));
    expect(res.code).toBe(0);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
    expect(rec.merge_transition.verified).toBe(true);
    expect(rec.merge_transition.required_checks).toEqual(["build-test", "windows-git-auth", "gitleaks"]);
    // The record says out loud which part of its proof is a bound claim.
    expect(rec.merge_transition.report_local_evidence_fields)
      .toEqual(["LOCAL_HEAD", "ORIGIN_MAIN", "WORKTREE_CLEAN"]);
    // ...and STILL never claims Claude authored the merge commit.
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(rec.completion_gate.transition_excused_commits).toEqual([merge]);
  }, 300_000);
});

/* ==========================================================================
 * THE RULE THAT DID NOT MOVE
 * ========================================================================== */

describe("D-145 CONTROL: ordinary commit provenance is still fail-closed", () => {
  beforeEach(() => {
    setComments([ordinaryTask()]);
  });

  it("an ordinary task whose child commits WITHOUT trailers is still held", async () => {
    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1",
      JARVIS_FAKE_CLAUDE_NO_TRAILER: "1"
    });

    expect(res.code).toBe(3);
    const rec = task(PLAIN_TASK);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.successful).toBe(false);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.HELD_PROVENANCE_UNVERIFIED);
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    // Preserved: unverified is not unwanted.
    expect(existsSync(wt(PLAIN_TASK))).toBe(true);
  }, 300_000);

  it("an ordinary task whose child commits WITH trailers still completes normally", async () => {
    // The positive control. Without it, every assertion above would be satisfied
    // by a worker that simply never completes anything.
    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1"
    });

    expect(res.code).toBe(0);
    const rec = task(PLAIN_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    // Still the ORIGINAL pass reason: nothing about this task touched the new path.
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(rec.completion_gate.merge_transition_verified).toBe(false);
  }, 300_000);
});

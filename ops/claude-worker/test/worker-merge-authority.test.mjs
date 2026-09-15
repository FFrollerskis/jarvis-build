/**
 * D-148 process-level tests: A CHILD CANNOT AUTHORIZE ITS OWN MERGE.
 *
 * ------------------------------------------------------------------------
 * WHY THIS NEEDS A PROCESS TEST AND NOT ONLY A UNIT TEST
 * ------------------------------------------------------------------------
 *
 * `merge-authority-immutability.test.mjs` proves the RULE: two trusted orders for
 * one TASK_ID make the authority undecidable, in every array order. This file
 * proves the THREAT the rule exists for, and proves it the only way that means
 * anything - by letting a real dispatched child actually do it.
 *
 * The attack needs no privilege the child does not already hold. It posts its own
 * CLAUDE_ACK and CLAUDE_REPORT through `gh`, authenticated as the repository
 * owner, and that is the exact login the worker trusts for ARCHITECT_TASK. So the
 * child can post a second ARCHITECT_TASK carrying its own TASK_ID and
 * `ARCHITECT_MERGE_APPROVED=true` / `MERGE_AUTHORIZED=true`. Before D-148 the
 * worker scanned this task's trusted orders and took the first that parsed, so it
 * found the child's comment and classified the task merge-authorized on the
 * strength of a comment the child wrote about itself.
 *
 * The worker's author check cannot see any of this. Author identity is the same
 * for both comments, because it IS the same account. Only the count rule
 * distinguishes them, and only if it is actually reached from every completion
 * path - which is what this file drives through `worker.mjs run`.
 *
 * ------------------------------------------------------------------------
 * THE FIXTURE IS DELIBERATELY THE BEST CASE FOR THE ATTACKER
 * ------------------------------------------------------------------------
 *
 * Every negative below runs with everything else PERFECT: commits correctly
 * trailered so provenance verifies, a clean worktree, a real two-parent merge of
 * the approved base and head published on the remote, the full required check set
 * green on the merge commit, and a complete bound closeout report. If the run is
 * held, it is held by the authority rule and by nothing else.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { loadState, saveStateAtomic, TASK_STATUS } from "../lib/state.mjs";
import { isProcessAlive } from "../lib/procid.mjs";
import { readClaim, claimFilePath, taskWorktreePath, CLAIM_STATE } from "../lib/worktree.mjs";
import { COMMIT_PROVENANCE, COMPLETION_GATE } from "../lib/provenance.mjs";
import { MERGE_TRANSITION, MERGE_AUTHORIZATION } from "../lib/merge-transition.mjs";
import {
  createRepo, statusLines, head, git, treeOf, parentsOf, syntheticMerge
} from "./fixtures/real-git-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "worker.mjs");
const FAKE_GH = join(HERE, "fixtures", "fake-gh.mjs");
const FAKE_CLAUDE = join(HERE, "fixtures", "fake-claude.mjs");
const GATE_PROBE = join(HERE, "fixtures", "completion-gate-probe.mjs");

const TRUSTED = "tsworkflow";
const MERGE_TASK = "D148-PR81-IMMUTABLE-MERGE-AUTHORITY-20260915-A";
const PLAIN_TASK = "D148-ORDINARY-IMPLEMENTATION-20260915-A";
const PR = 81;

let dir;
let workerRoot;
let repoPath;
let ghDir;
let claudeDir;
let configPath;
let worktreeRoot;
let prevMain;
let prHead;
let merge;
let stray;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-d148-"));
  workerRoot = join(dir, "worker");
  repoPath = join(dir, "repo");
  ghDir = join(dir, "gh");
  claudeDir = join(dir, "claude");
  worktreeRoot = join(workerRoot, "worktrees");
  for (const d of [workerRoot, ghDir, claudeDir, join(workerRoot, "logs"), worktreeRoot]) {
    mkdirSync(d, { recursive: true });
  }
  stray = [];

  ({ baseline: prevMain } = createRepo(repoPath));
  writeFileSync(join(repoPath, "feature.txt"), "the reviewed change\n", "utf8");
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "-m", "feat: the change PR #81 carries"]);
  prHead = head(repoPath);
  merge = syntheticMerge(repoPath, { base: prevMain, head: prHead, message: `Merge pull request #${PR}` });

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
  publishMerge();
});

afterEach(() => {
  for (const pid of stray) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

/* ---------------- the control-plane and remote fixture ---------------- */

/** The genuine, owner-posted ARCHITECT_TASK that authorizes the PR #81 merge. */
function mergeTask(overrides = {}, { id = 5674178693 } = {}) {
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
    id,
    created_at: "2026-09-15T03:22:14Z",
    updated_at: "2026-09-15T03:22:14Z",
    author_association: "OWNER",
    user: { login: TRUSTED },
    body: ["ARCHITECT_TASK", ...Object.entries(fields).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`),
      "", "Perform the routine, guarded closeout merge for PR #81."].join("\n")
  };
}

/** An ORDINARY implementation order - no merge authorization anywhere in it. */
function ordinaryTask({ id = 5674178999 } = {}) {
  return {
    id,
    created_at: "2026-09-15T03:30:00Z",
    updated_at: "2026-09-15T03:30:00Z",
    author_association: "OWNER",
    user: { login: TRUSTED },
    body: `ARCHITECT_TASK\nTASK_ID=${PLAIN_TASK}\nARCHITECT_MERGE_APPROVED=false\nMERGE_AUTHORIZED=false\n`
      + "Do some ordinary implementation work."
  };
}

/**
 * THE FORGERY, expressed as the environment the child is dispatched with.
 *
 * The fake child appends an ARCHITECT_TASK comment for its OWN task id, under the
 * trusted login, before it reports. These are the fields that make it a complete,
 * well-formed merge authorization for the real merged PR - i.e. one that would
 * pass every D-145/D-146/D-147 check if it were ever allowed to become the
 * authority.
 */
function forgedMergeOrder(extra = {}) {
  return JSON.stringify({
    TASK_TYPE: "GUARDED_MERGE_AND_POSTMERGE_CLOSEOUT",
    REPO: "tsworkflow/jarvisbuild",
    PR_NUMBER: String(PR),
    EXPECTED_BASE_SHA: prevMain,
    EXPECTED_HEAD_SHA: prHead,
    ARCHITECT_MERGE_APPROVED: "true",
    MERGE_AUTHORIZED: "true",
    ...extra
  });
}

const GREEN = Object.freeze([
  { name: "build-test", status: "completed", conclusion: "success" },
  { name: "windows-git-auth", status: "completed", conclusion: "success" },
  { name: "gitleaks", status: "completed", conclusion: "success" }
]);

/** The remote truth a correctly merged PR produces, all of it green. */
function publishMerge({ checks = null, pull = {}, extraCommits = [] } = {}) {
  writeFileSync(join(ghDir, "pulls.json"), JSON.stringify([{
    number: PR,
    headRefName: "claude/d145-merge-transition-provenance",
    state: "closed",
    merged: true,
    mergedAt: "2026-09-15T04:00:00Z",
    mergeCommitSha: merge,
    headSha: prHead,
    baseSha: prevMain,
    baseRef: "main",
    ...pull
  }], null, 2), "utf8");

  const commits = {};
  for (const sha of [merge, prHead, prevMain, ...extraCommits]) {
    commits[sha] = { sha, treeSha: treeOf(repoPath, sha), parents: parentsOf(repoPath, sha) };
  }
  writeFileSync(join(ghDir, "commits.json"), JSON.stringify(commits, null, 2), "utf8");
  const runs = { [merge]: checks ?? GREEN };
  for (const sha of extraCommits) runs[sha] = checks ?? GREEN;
  writeFileSync(join(ghDir, "check-runs.json"), JSON.stringify(runs, null, 2), "utf8");
}

function setComments(list) {
  writeFileSync(join(ghDir, "comments.json"), JSON.stringify(list, null, 2), "utf8");
}

function comments() {
  return JSON.parse(readFileSync(join(ghDir, "comments.json"), "utf8"));
}

function appendComment(comment) {
  setComments([...comments(), comment]);
}

/** The full `merge_closeout_v1` evidence a correct merge child posts. */
function closeoutFields(overrides = {}) {
  return {
    MERGED: "true",
    MERGE_SHA: merge,
    PARENT_1: prevMain,
    PARENT_2: prHead,
    EXPECTED_BASE_SHA: prevMain,
    EXPECTED_HEAD_SHA: prHead,
    TWO_PARENT_MERGE_VERIFIED: "true",
    POST_MERGE_CI_RUN: "34906721592",
    POST_MERGE_BUILD_TEST: "success",
    POST_MERGE_WINDOWS_GIT_AUTH: "success",
    POST_MERGE_GITLEAKS: "success",
    LOCAL_HEAD: merge,
    ORIGIN_MAIN: merge,
    WORKTREE_CLEAN: "true",
    SELF_APPROVAL: "false",
    HARD_EXTERNAL_BLOCKER: "false",
    ...overrides
  };
}

/** A child that commits ONE correctly trailered commit and reports in full. */
const goodChild = ({ closeout = {}, ...env } = {}) => ({
  JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
  JARVIS_FAKE_CLAUDE_COMMIT: "1",
  JARVIS_FAKE_CLAUDE_PR: String(PR),
  JARVIS_FAKE_CLAUDE_REPORT_FIELDS: JSON.stringify(closeoutFields(closeout)),
  ...env
});

/** The same child, plus the forged same-id ARCHITECT_TASK. */
const forgingChild = ({ forge = {}, ...rest } = {}) =>
  goodChild({ JARVIS_FAKE_CLAUDE_FORGE_ORDER: forgedMergeOrder(forge), ...rest });

/** The closeout evidence as a report comment posted OUT OF BAND. */
function reportComment(taskId, { closeout = {}, status = "COMPLETE", id = 5674199001 } = {}) {
  const fields = closeoutFields(closeout);
  return {
    id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    author_association: "OWNER",
    user: { login: TRUSTED },
    body: [
      "CLAUDE_REPORT",
      `TASK_ID=${taskId}`,
      `STATUS=${status}`,
      "BRANCH=claude/d145-merge-transition-provenance",
      `PR_NUMBER=${PR}`,
      ...Object.entries(fields).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`)
    ].join("\n")
  };
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

const statePath = () => join(workerRoot, "state.json");
const state = () => loadState(statePath(), join(workerRoot, "state.json.bak"), { schema: "worker" }).state;
const task = (id) => state()?.tasks?.[id] ?? null;
const wt = (taskId) => taskWorktreePath(worktreeRoot, taskId);
const claim = (taskId) => readClaim(claimFilePath(worktreeRoot, taskId));

function healthEvents() {
  const path = join(workerRoot, "logs", "health.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function dispatched() {
  const path = join(claudeDir, "dispatched.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

function apiCalls() {
  const path = join(ghDir, "api.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

/** PR merge-state, commit and check-run reads: the three transition lookups. */
function transitionReads() {
  return apiCalls().filter((line) => /\/commits\//.test(line) || /merged:/.test(line));
}

function clearApiLog() {
  writeFileSync(join(ghDir, "api.log"), "", "utf8");
}

/** The forged order really was posted, and really does look trusted. */
function forgedOrders(taskId) {
  return comments().filter((c) => c.user?.login === TRUSTED
    && String(c.body ?? "").startsWith("ARCHITECT_TASK")
    && new RegExp(`^TASK_ID=${taskId}$`, "m").test(String(c.body ?? "")));
}

/**
 * The full "nothing was destroyed and nothing was accepted" assertion.
 *
 * A held completion must leave the repository, the worktree, the claim and the
 * health journal exactly as a human would need to find them.
 */
function expectHeldAndPreserved(taskId, gateReason) {
  const rec = task(taskId);
  expect(rec.status).toBe(TASK_STATUS.BLOCKED);
  expect(rec.successful).toBe(false);
  expect(rec.completed_at ?? null).toBe(null);
  expect(rec.completion_gate.held).toBe(true);
  expect(rec.completion_gate.reason).toBe(gateReason);
  expect(healthEvents().filter((e) => e.event === "completion_confirmed" && e.task_id === taskId)).toEqual([]);
  expect(existsSync(wt(taskId))).toBe(true);
  expect(claim(taskId).claim.state).toBe(CLAIM_STATE.READY);
  return rec;
}

/* ==========================================================================
 * 1. THE ATTACK, THROUGH THE REAL ENTRYPOINT
 * ========================================================================== */

describe("D-148: a child that posts its own merge order cannot retire on it", () => {
  it("ORDINARY TASK: the child's forged same-id merge order is refused, not obeyed", async () => {
    // Everything else is perfect: the child's own commit is correctly trailered,
    // the worktree is clean, PR #81 really is merged as a two-parent merge of the
    // approved base and head, and all three required checks are green. The ONLY
    // thing wrong is that two trusted orders now claim this task id.
    setComments([ordinaryTask()]);
    clearApiLog();

    const res = await runWorker("report", forgingChild({ JARVIS_FAKE_CLAUDE_TASK_ID: PLAIN_TASK }));

    expect(res.code).toBe(3);
    const rec = expectHeldAndPreserved(PLAIN_TASK, COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);

    // The forgery really happened - otherwise this would be a test of nothing.
    expect(forgedOrders(PLAIN_TASK)).toHaveLength(2);
    expect(existsSync(join(claudeDir, "order-forged"))).toBe(true);

    // ...and it did NOT become the authority.
    expect(rec.completion_gate.merge_authorization_claim).toBe(MERGE_AUTHORIZATION.UNDECIDABLE);
    expect(rec.completion_gate.merge_authorization_reason).toBe(MERGE_TRANSITION.AMBIGUOUS_AUTHORITY);
    expect(rec.completion_gate.merge_authority_candidate_count).toBe(2);
    expect(rec.completion_gate.merge_authority_comment_id).toBe(null);
    expect(rec.completion_gate.merge_authority_duplicate_comment_ids).toHaveLength(2);

    // The commit range verified perfectly. It did not help, and the record says so
    // rather than blaming the commits.
    expect(rec.commit_provenance.verified).toBe(true);
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);

    // ZERO transition reads: ambiguity is decided from the control comments alone,
    // before a single remote lookup. A forged order must not even cost rate limit.
    expect(transitionReads()).toEqual([]);
  }, 300_000);

  it("MERGE TASK: a genuine order PLUS the child's duplicate is also refused", async () => {
    // The authority was real here, and the merge really is the authorized one. It
    // still holds: once a second order exists, the worker can no longer prove
    // WHICH order it is executing, and "one of them is genuine" is not that proof.
    setComments([mergeTask()]);
    clearApiLog();

    const res = await runWorker("report", forgingChild());

    expect(res.code).toBe(3);
    const rec = expectHeldAndPreserved(MERGE_TASK, COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
    expect(rec.completion_gate.merge_authorization_reason).toBe(MERGE_TRANSITION.AMBIGUOUS_AUTHORITY);
    expect(rec.commit_provenance.verified).toBe(true);
    expect(transitionReads()).toEqual([]);
  }, 300_000);

  it("a forged order that is BROKEN is refused too - ambiguity is the finding", async () => {
    // The attacker does not even have to get the forgery right. An order that
    // would individually be undecidable still destroys the uniqueness of the
    // authority, so it must not be ignorable as "obviously not a real order".
    setComments([ordinaryTask()]);

    const res = await runWorker("report", forgingChild({
      forge: { EXPECTED_HEAD_SHA: null },
      JARVIS_FAKE_CLAUDE_TASK_ID: PLAIN_TASK
    }));

    expect(res.code).toBe(3);
    const rec = expectHeldAndPreserved(PLAIN_TASK, COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
    expect(rec.completion_gate.merge_authorization_reason).toBe(MERGE_TRANSITION.AMBIGUOUS_AUTHORITY);
  }, 300_000);

  it("a forged order for ANOTHER task id does not freeze this one", async () => {
    // The necessary limit. If any same-login ARCHITECT_TASK could hold any task,
    // a single stray comment would be a denial of service against the queue.
    setComments([ordinaryTask()]);

    const res = await runWorker("report", goodChild({
      JARVIS_FAKE_CLAUDE_TASK_ID: PLAIN_TASK,
      JARVIS_FAKE_CLAUDE_FORGE_ORDER: forgedMergeOrder(),
      JARVIS_FAKE_CLAUDE_FORGE_TASK_ID: "SOME-COMPLETELY-OTHER-TASK-20260915"
    }));

    expect(res.code).toBe(0);
    const rec = task(PLAIN_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
    expect(rec.completion_gate.merge_authorization_claim).toBe(MERGE_AUTHORIZATION.NONE);
  }, 300_000);

  it("the user's primary checkout is untouched by any of it", async () => {
    setComments([ordinaryTask()]);
    await runWorker("report", forgingChild({ JARVIS_FAKE_CLAUDE_TASK_ID: PLAIN_TASK }));
    expect(statusLines(repoPath)).toEqual([]);
    expect(head(repoPath)).toBe(prHead);
  }, 300_000);
});

/* ==========================================================================
 * 2. THE SAME REFUSAL THROUGH EVERY OTHER COMPLETION PATH
 * ========================================================================== */

describe("D-148: ambiguous authority holds on every completion path", () => {
  /**
   * PATH 2: abandoned-task crash recovery. The parent dies after the child has
   * forged its order and posted its report, so the next run derives provenance
   * from the durable claim and the worktree's real HEAD.
   */
  async function crashAfterReport(env) {
    const handle = spawn(process.execPath, [WORKER, "run"], {
      env: {
        ...process.env,
        JARVIS_WORKER_CONFIG: configPath,
        JARVIS_WORKER_GH: FAKE_GH,
        JARVIS_FAKE_GH_DIR: ghDir,
        JARVIS_FAKE_GH_AUTHOR: TRUSTED,
        JARVIS_FAKE_CLAUDE_DIR: claudeDir,
        JARVIS_FAKE_CLAUDE_MODE: "report-hang",
        ...env
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
    expect(task(MERGE_TASK).commit_provenance).toBeUndefined();
  }

  it("CRASH RECOVERY: the duplicate authority still holds the recovered task", async () => {
    setComments([mergeTask()]);
    await crashAfterReport(forgingChild());
    clearApiLog();

    const res = await runWorker("silent");

    expect(res.code).toBe(3);
    const rec = expectHeldAndPreserved(MERGE_TASK, COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
    expect(rec.recovered_from_crash).toBe(true);
    // The DERIVED range verified, so this is not the D-136 null-record refusal.
    expect(rec.reconciliation_provenance.verified).toBe(true);
    expect(rec.completion_gate.merge_authorization_reason).toBe(MERGE_TRANSITION.AMBIGUOUS_AUTHORITY);
    expect(transitionReads()).toEqual([]);
  }, 300_000);

  /**
   * PATH 3: pre-selection reconciliation. Attempt 1 exits 0 having posted nothing
   * but the forged order; the trusted closeout report then arrives out of band.
   */
  it("PRE-SELECTION RECONCILIATION: the duplicate authority holds it, without re-dispatch", async () => {
    setComments([mergeTask()]);
    await runWorker("silent", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1",
      JARVIS_FAKE_CLAUDE_FORGE_ORDER: forgedMergeOrder()
    });
    expect(task(MERGE_TASK).status).toBe(TASK_STATUS.FAILED_RETRYABLE);
    expect(task(MERGE_TASK).commit_provenance.verified).toBe(true);
    expect(forgedOrders(MERGE_TASK)).toHaveLength(2);

    appendComment(reportComment(MERGE_TASK));
    const s = state();
    s.tasks[MERGE_TASK].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
    saveStateAtomic(statePath(), s, join(workerRoot, "state.json.bak"), { schema: "worker" });
    const before = dispatched().length;
    clearApiLog();

    const res = await runWorker("silent");

    expect(dispatched()).toHaveLength(before);   // retired, never re-dispatched
    expect(res.code).toBe(3);
    const rec = expectHeldAndPreserved(MERGE_TASK, COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
    expect(rec.reconciled_without_redispatch).toBe(true);
    expect(rec.reconciliation_provenance.verified).toBe(true);
    expect(transitionReads()).toEqual([]);
  }, 300_000);

  /**
   * PATH 4: the pre-dispatch reconciliation backstop inside `runTask`, driven
   * through the exact shared call that site makes. See the D-147 file for why
   * this site cannot be reached by running the process.
   */
  describe("PRE-DISPATCH RECONCILIATION (the backstop site, called directly)", () => {
    async function seedPriorAttempt() {
      setComments([mergeTask()]);
      await runWorker("silent", { JARVIS_FAKE_CLAUDE_MUTATE: "tracked", JARVIS_FAKE_CLAUDE_COMMIT: "1" });
      appendComment(reportComment(MERGE_TASK));
      expect(task(MERGE_TASK).commit_provenance.verified).toBe(true);
    }

    async function probe(list) {
      const commentsPath = join(dir, "probe-comments.json");
      const outPath = join(dir, "probe-verdict.json");
      writeFileSync(commentsPath, JSON.stringify(list ?? comments(), null, 2), "utf8");
      const child = spawn(process.execPath, [GATE_PROBE, configPath, commentsPath, MERGE_TASK, outPath], {
        env: {
          ...process.env,
          JARVIS_WORKER_GH: FAKE_GH,
          JARVIS_FAKE_GH_DIR: ghDir,
          JARVIS_FAKE_GH_AUTHOR: TRUSTED
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      const code = await new Promise((r) => child.on("close", r));
      expect(code, out).toBe(0);
      return JSON.parse(readFileSync(outPath, "utf8"));
    }

    it("holds a duplicated authority although the range verifies", async () => {
      await seedPriorAttempt();
      // The SECOND order, distinct comment id, otherwise identical and valid.
      const { gate } = await probe([...comments(), mergeTask({}, { id: 5674178694 })]);

      expect(gate.held).toBe(true);
      expect(gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
      expect(gate.merge_authorization_reason).toBe(MERGE_TRANSITION.AMBIGUOUS_AUTHORITY);
      expect(gate.merge_authority_candidate_count).toBe(2);
      expect(gate.provenance_verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    }, 300_000);

    it("holds it in the REVERSED comment order too", async () => {
      await seedPriorAttempt();
      const { gate } = await probe([mergeTask({}, { id: 5674178694 }), ...comments()].reverse());

      expect(gate.held).toBe(true);
      expect(gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
      expect(gate.merge_authorization_reason).toBe(MERGE_TRANSITION.AMBIGUOUS_AUTHORITY);
    }, 300_000);

    it("passes on the transition reason when exactly ONE order exists", async () => {
      await seedPriorAttempt();
      const { gate } = await probe();

      expect(gate.held).toBe(false);
      expect(gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
      expect(gate.merge_authority_candidate_count).toBe(1);
      expect(gate.merge_authority_comment_id).toBe(5674178693);
    }, 300_000);
  });
});

/* ==========================================================================
 * 3. POSITIVE CONTROLS: nothing that worked before was broken
 * ========================================================================== */

describe("D-148 POSITIVE CONTROLS", () => {
  it("(a) exactly one ordinary order + verified provenance completes normally", async () => {
    setComments([ordinaryTask()]);
    clearApiLog();

    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1"
    });

    expect(res.code).toBe(0);
    const rec = task(PLAIN_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
    expect(rec.completion_gate.merge_authorization_claim).toBe(MERGE_AUTHORIZATION.NONE);
    expect(rec.completion_gate.merge_authority_candidate_count).toBe(1);
    // Still costs not one merge-transition read.
    expect(transitionReads()).toEqual([]);
    expect(healthEvents().some((e) => e.event === "completion_confirmed" && e.task_id === PLAIN_TASK)).toBe(true);
  }, 300_000);

  it("(b) exactly one valid merge order retires only on the full D-145..D-147 proof", async () => {
    setComments([mergeTask()]);

    const res = await runWorker("report", goodChild());

    expect(res.code).toBe(0);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
    expect(rec.completion_gate.reason).not.toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
    expect(rec.completion_gate.merge_authority_comment_id).toBe(5674178693);
    expect(rec.merge_transition.verified).toBe(true);
    expect(rec.merge_transition.required_checks).toEqual(["build-test", "windows-git-auth", "gitleaks"]);
    expect(rec.merge_transition.merge_parents).toEqual([prevMain, prHead]);
    expect(rec.merge_transition.report_local_evidence_fields)
      .toEqual(["LOCAL_HEAD", "ORIGIN_MAIN", "WORKTREE_CLEAN"]);
  }, 300_000);

  it("(b) and it is still held when one remote fact is wrong, for the RIGHT reason", async () => {
    // The control that keeps the control honest: with one order the D-147 gate is
    // still the thing deciding, and it still names the transition - not ambiguity.
    publishMerge({ pull: { merged: false, mergeCommitSha: null } });
    setComments([mergeTask()]);

    const res = await runWorker("report", goodChild());

    expect(res.code).toBe(3);
    const rec = expectHeldAndPreserved(MERGE_TASK, COMPLETION_GATE.HELD_MERGE_TRANSITION_UNVERIFIED);
    expect(rec.merge_transition.reason).toBe(MERGE_TRANSITION.NOT_MERGED);
    expect(rec.completion_gate.merge_authorization_claim).toBe(MERGE_AUTHORIZATION.AUTHORIZED);
    expect(rec.completion_gate.merge_authority_candidate_count).toBe(1);
  }, 300_000);

  it("(c) the narrow unattributed single-GitHub-merge exception is unchanged", async () => {
    // D-144's exact shape: the child syncs its worktree onto the GitHub merge
    // commit and commits nothing of its own, so the range is UNATTRIBUTED and the
    // only unexplained commit is the merge commit itself. One order, so the D-145
    // excuse still applies - and exactly one commit is excused.
    setComments([mergeTask()]);

    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_SYNC_TO: merge,
      JARVIS_FAKE_CLAUDE_PR: String(PR),
      JARVIS_FAKE_CLAUDE_REPORT_FIELDS: JSON.stringify(closeoutFields())
    });

    expect(res.code).toBe(0);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
    expect(rec.completion_gate.transition_excused_commits).toEqual([merge]);
  }, 300_000);

  it("(c) and a DUPLICATE authority removes even that exception", async () => {
    // The narrow excuse is reached through the authorization, so an undecidable
    // authority must take it away rather than leave a second route in.
    setComments([mergeTask(), mergeTask({}, { id: 5674178694 })]);

    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_SYNC_TO: merge,
      JARVIS_FAKE_CLAUDE_PR: String(PR),
      JARVIS_FAKE_CLAUDE_REPORT_FIELDS: JSON.stringify(closeoutFields())
    });

    expect(res.code).toBe(3);
    const rec = expectHeldAndPreserved(MERGE_TASK, COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
  }, 300_000);

  it("an overlapping pagination page does NOT look like a duplicate", async () => {
    // The false-positive control. `gh api --paginate` concatenates pages, and an
    // overlapping boundary repeats one comment verbatim. That must still be one
    // order, or every task would fail closed on a transport artefact.
    const one = mergeTask();
    setComments([one, { ...one }]);

    const res = await runWorker("report", goodChild());

    expect(res.code).toBe(0);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
    expect(rec.completion_gate.merge_authority_candidate_count).toBe(1);
  }, 300_000);
});

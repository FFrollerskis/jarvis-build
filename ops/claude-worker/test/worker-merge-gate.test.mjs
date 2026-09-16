/**
 * D-147 process-level tests: A MERGE-AUTHORIZED TASK WHOSE COMMIT PROVENANCE IS
 * VERIFIED, driven through the ACTUAL worker entrypoint against a REAL git repo.
 *
 * ------------------------------------------------------------------------
 * WHY THIS FIXTURE AND NOT THE D-145 ONE
 * ------------------------------------------------------------------------
 *
 * `worker-merge-transition.test.mjs` reproduces D-144: a merge task whose child
 * fast-forwarded onto the GitHub merge commit, leaving a range the worker classes
 * `unattributed`. Every gate in that file is reached BECAUSE the range is
 * unverified - which is exactly why none of them could detect the remaining
 * bypass, and why the PR #81 review found it by reading the code rather than by
 * running the suite.
 *
 * The fixture here is the other half of the space, and it is trivially reachable
 * in production: the SAME trusted merge order, and a child that commits ONE
 * correctly trailered commit of its own. The range is `task_attributed` and
 * `verified: true`. Under D-145/D-146 the worker then never called
 * `verifyMergeTransition` at all - no PR read, no required check, no closeout
 * binding - and retired the task as `commit_provenance_verified`, having proven
 * only that Claude wrote Claude's commits. The remote merge was never checked.
 *
 * So every negative below is that VERIFIED-provenance fixture with exactly one
 * remote or report fact altered, and every one of them must be BLOCKED. A gate
 * that only fires when provenance already failed is not a gate.
 *
 * ------------------------------------------------------------------------
 * ALL FOUR COMPLETION PATHS
 * ------------------------------------------------------------------------
 *
 * The same mandatory gate is exercised through post-dispatch, abandoned-task
 * crash recovery and pre-selection reconciliation via the real entrypoint, and
 * through the pre-dispatch reconciliation site by calling the exact shared
 * function that site calls. See that section's comment for why the last one
 * cannot be reached by running the process, and what is done about it.
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
const MERGE_TASK = "D147-PR81-MERGE-GATE-20260915-A";
const PLAIN_TASK = "D147-ORDINARY-IMPLEMENTATION-20260915-A";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-d147-"));
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

/** The trusted, owner-posted ARCHITECT_TASK that authorizes the PR #81 merge. */
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
    id: 5673481484,
    created_at: "2026-09-15T01:54:17Z",
    updated_at: "2026-09-15T01:54:17Z",
    author_association: "OWNER",
    user: { login: TRUSTED },
    body: ["ARCHITECT_TASK", ...Object.entries(fields).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`),
      "", "Perform the routine, guarded closeout merge for PR #81."].join("\n")
  };
}

/** An ORDINARY implementation order - no merge authorization anywhere in it. */
function ordinaryTask() {
  return {
    id: 5673481999,
    created_at: "2026-09-15T02:10:00Z",
    updated_at: "2026-09-15T02:10:00Z",
    author_association: "OWNER",
    user: { login: TRUSTED },
    body: `ARCHITECT_TASK\nTASK_ID=${PLAIN_TASK}\nARCHITECT_MERGE_APPROVED=false\nMERGE_AUTHORIZED=false\n`
      + "Do some ordinary implementation work."
  };
}

const GREEN = Object.freeze([
  { name: "build-test", status: "completed", conclusion: "success" },
  { name: "windows-git-auth", status: "completed", conclusion: "success" },
  { name: "gitleaks", status: "completed", conclusion: "success" }
]);

/**
 * The remote truth a merged PR produces. `pull`/`checks` alter exactly one fact.
 * `extraCommits` publishes further real commits the PR may point at, so a test
 * can name a DIFFERENT merge commit without the remote 404ing on it - a 404
 * would refuse for the wrong reason ("unreadable") and prove nothing about the
 * structural check under test.
 */
function publishMerge({ checks = null, pull = {}, extraCommits = [] } = {}) {
  writeFileSync(join(ghDir, "pulls.json"), JSON.stringify([{
    number: PR,
    headRefName: "claude/d145-merge-transition-provenance",
    state: "closed",
    merged: true,
    mergedAt: "2026-09-15T02:00:00Z",
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
  // D-158: no comparison fixture. The merge proof recomputes the merge from the
  // real objects in `repoPath`, which this fixture already has.
}

function setComments(list) {
  writeFileSync(join(ghDir, "comments.json"), JSON.stringify(list, null, 2), "utf8");
}

function appendComment(comment) {
  const list = JSON.parse(readFileSync(join(ghDir, "comments.json"), "utf8"));
  list.push(comment);
  setComments(list);
}

/** The full `merge_closeout_v1` evidence, with one field altered per test. */
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

/**
 * THE FIXTURE AT THE CENTRE OF THIS FILE.
 *
 * A child that commits ONE correctly trailered commit and posts a full closeout
 * report. It deliberately does NOT sync onto the merge commit, so its range
 * contains nothing but its own properly attributed work: commit provenance comes
 * back `task_attributed`, `verified: true`. That is the state in which the old
 * worker skipped the entire merge proof.
 */
const verifiedChild = ({ closeout = {}, ...env } = {}) => ({
  JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
  JARVIS_FAKE_CLAUDE_COMMIT: "1",
  JARVIS_FAKE_CLAUDE_PR: String(PR),
  JARVIS_FAKE_CLAUDE_REPORT_FIELDS: JSON.stringify(closeoutFields(closeout)),
  ...env
});

/** The same closeout evidence as a report comment posted OUT OF BAND. */
function reportComment(taskId, { closeout = {}, status = "COMPLETE", id = 5673499001 } = {}) {
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
      ...Object.entries(fields).filter(([, v]) => v !== null)
        .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((one) => `${k}=${one}`))
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

function statePath() {
  return join(workerRoot, "state.json");
}

function state() {
  return loadState(statePath(), join(workerRoot, "state.json.bak"), { schema: "worker" }).state;
}

function task(id) {
  return state()?.tasks?.[id] ?? null;
}

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

/**
 * Every `gh` invocation so far, and the subset of them that is a MERGE-TRANSITION
 * read: the single-PR merge-state projection, a commit object, or a commit's
 * check runs. "The ordinary path costs nothing extra" is a claim about calls that
 * did not happen, so it is checked here rather than assumed.
 */
function apiCalls() {
  const path = join(ghDir, "api.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

function transitionReads() {
  return apiCalls().filter((line) => /\/commits\//.test(line) || /merged:/.test(line));
}

function clearApiLog() {
  writeFileSync(join(ghDir, "api.log"), "", "utf8");
}

/* ==========================================================================
 * 1. THE FIXTURE ITSELF, AND THE BYPASS IT EXPOSES
 * ========================================================================== */

describe("D-147: a merge-authorized task with VERIFIED commit provenance", () => {
  beforeEach(() => {
    setComments([mergeTask()]);
  });

  it("the fixture really does produce a VERIFIED commit range", async () => {
    // Asserted before it is used. If this fixture quietly produced an
    // unattributed range it would be the D-145 fixture again, and every negative
    // below would pass for the old reason instead of the new one.
    await runWorker("report", verifiedChild());
    const rec = task(MERGE_TASK);
    expect(rec.commit_provenance.verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(rec.commit_provenance.verified).toBe(true);
    expect(rec.commit_provenance.unattributed_count).toBe(0);
    expect(rec.head_after).not.toBe(rec.head_before);
  }, 300_000);

  it("THE BYPASS: an UNMERGED PR is refused although the commit range verifies", async () => {
    // The exact D-146 integration gap, driven through the real entrypoint. The
    // trusted order authorizes a merge of PR #81; the remote says it never
    // merged; the child's own commits are flawless. Under D-145/D-146 this run
    // completed successfully as `commit_provenance_verified` without ever asking
    // the remote a single question.
    publishMerge({ pull: { merged: false, mergeCommitSha: null } });

    const res = await runWorker("report", verifiedChild());

    expect(res.code).toBe(3);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.successful).toBe(false);
    expect(rec.completed_at ?? null).toBe(null);
    expect(rec.completion_gate.held).toBe(true);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_TRANSITION_UNVERIFIED);
    expect(rec.merge_transition.reason).toBe(MERGE_TRANSITION.NOT_MERGED);
    // The range verified, and it did not help. That is the whole point.
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(rec.completion_gate.merge_authorization_claim).toBe(MERGE_AUTHORIZATION.AUTHORIZED);
    expect(healthEvents().filter((e) => e.event === "completion_confirmed" && e.task_id === MERGE_TASK)).toEqual([]);
    // Preserved, never destroyed.
    expect(existsSync(wt(MERGE_TASK))).toBe(true);
    expect(claim(MERGE_TASK).claim.state).toBe(CLAIM_STATE.READY);
  }, 300_000);

  it("POSITIVE CONTROL (b): with the full transition, CI and bound report, it retires", async () => {
    const res = await runWorker("report", verifiedChild());

    expect(res.code).toBe(0);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    // THE INVARIANT: never the provenance reason, even though provenance verified.
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
    expect(rec.completion_gate.reason).not.toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(rec.merge_transition.verified).toBe(true);
    expect(rec.merge_transition.required_checks).toEqual(["build-test", "windows-git-auth", "gitleaks"]);
    expect(rec.merge_transition.merge_parents).toEqual([prevMain, prHead]);
    expect(rec.merge_transition.report_local_evidence_fields)
      .toEqual(["LOCAL_HEAD", "ORIGIN_MAIN", "WORKTREE_CLEAN"]);
    expect(healthEvents().some((e) => e.event === "completion_confirmed" && e.task_id === MERGE_TASK)).toBe(true);
  }, 300_000);

  it("nothing reaches the user's primary checkout", async () => {
    await runWorker("report", verifiedChild());
    expect(statusLines(repoPath)).toEqual([]);
    expect(head(repoPath)).toBe(prHead);
  }, 300_000);
});

/* ==========================================================================
 * 2. THE ADVERSARIAL MATRIX, all against the VERIFIED-provenance fixture
 * ========================================================================== */

describe("D-147: every deviation is still BLOCKED when provenance verifies", () => {
  /**
   * One worker run, refused, nothing destroyed, and for the named reasons.
   *
   * Deliberately ONE run per call: a BLOCKED task is never replayed, so a second
   * run would re-assert the first run's record and pass for the wrong reason.
   */
  async function expectHeld({
    gateReason = COMPLETION_GATE.HELD_MERGE_TRANSITION_UNVERIFIED,
    transitionReason = null,
    checks = null,
    pull = null,
    extraCommits = [],
    closeout = {},
    order = null,
    env = {}
  } = {}) {
    publishMerge({ checks, pull: pull ?? {}, extraCommits });
    setComments([order ?? mergeTask()]);

    const res = await runWorker("report", verifiedChild({ closeout, ...env }));
    expect(res.code).toBe(3);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.successful).toBe(false);
    expect(rec.completed_at ?? null).toBe(null);
    expect(rec.completion_gate.held).toBe(true);
    expect(rec.completion_gate.reason).toBe(gateReason);
    // The range verified in EVERY one of these, so none of them is held for the
    // old D-145 reason. Without this line a regression could silently convert
    // these back into ordinary provenance failures.
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(rec.commit_provenance.verified).toBe(true);
    if (transitionReason) expect(rec.merge_transition.reason).toBe(transitionReason);
    expect(healthEvents().filter((e) => e.event === "completion_confirmed" && e.task_id === MERGE_TASK)).toEqual([]);
    expect(existsSync(wt(MERGE_TASK))).toBe(true);
    expect(claim(MERGE_TASK).claim.state).toBe(CLAIM_STATE.READY);
    return rec;
  }

  const checksWith = (name, over) => GREEN.map((r) => (r.name === name ? { ...r, ...over } : r));

  describe("a broken merge ORDER is a named refusal, not an ordinary task", () => {
    /** These must fail closed BEFORE any remote call: the order is unreadable. */
    async function expectUndecidable(order, reason) {
      const rec = await expectHeld({
        order,
        gateReason: COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE,
        transitionReason: reason
      });
      expect(rec.completion_gate.merge_authorization_claim).toBe(MERGE_AUTHORIZATION.UNDECIDABLE);
      expect(rec.completion_gate.merge_authorization_decidable).toBe(false);
      return rec;
    }

    it("half a merge authorization is refused", async () => {
      await expectUndecidable(mergeTask({ MERGE_AUTHORIZED: "false" }),
        MERGE_TRANSITION.MERGE_AUTHORIZATION_PARTIAL);
    }, 300_000);

    it("a merge authorization with no EXPECTED_HEAD_SHA is refused", async () => {
      await expectUndecidable(mergeTask({ EXPECTED_HEAD_SHA: null }),
        MERGE_TRANSITION.AUTHORIZATION_INCOMPLETE);
    }, 300_000);

    it("a merge authorization with an EMPTY required-check set is refused", async () => {
      await expectUndecidable(mergeTask({ REQUIRED_POST_MERGE_CHECKS: "" }),
        MERGE_TRANSITION.POLICY_NO_REQUIRED_CHECKS);
    }, 300_000);

    it("an undecidable order costs ZERO remote transition reads", async () => {
      // Fail closed BEFORE the network, not after it. A broken order that still
      // triggered three API calls per run would be a cheap denial-of-service on
      // the rate limit as well as a muddier refusal.
      publishMerge();
      setComments([mergeTask({ MERGE_AUTHORIZED: "false" })]);
      clearApiLog();
      await runWorker("report", verifiedChild());
      expect(task(MERGE_TASK).completion_gate.reason)
        .toBe(COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
      expect(transitionReads()).toEqual([]);
    }, 300_000);
  });

  describe("required post-merge CI identity", () => {
    it("only an unrelated green check is refused", async () => {
      const rec = await expectHeld({
        checks: [{ name: "some-other-job", status: "completed", conclusion: "success" }],
        transitionReason: MERGE_TRANSITION.CHECKS_REQUIRED_MISSING
      });
      expect(rec.merge_transition.detail).toContain("build-test");
    }, 300_000);

    it("a required check that is simply absent is refused", async () => {
      await expectHeld({
        checks: GREEN.filter((r) => r.name !== "windows-git-auth"),
        transitionReason: MERGE_TRANSITION.CHECKS_REQUIRED_MISSING
      });
    }, 300_000);

    it("a DUPLICATE required check is refused even when both copies are green", async () => {
      await expectHeld({
        checks: [...GREEN, { name: "build-test", status: "completed", conclusion: "success" }],
        transitionReason: MERGE_TRANSITION.CHECKS_REQUIRED_AMBIGUOUS
      });
    }, 300_000);

    it("an UNFINISHED required check is refused", async () => {
      await expectHeld({
        checks: checksWith("build-test", { status: "in_progress", conclusion: null }),
        transitionReason: MERGE_TRANSITION.CHECKS_REQUIRED_UNFINISHED
      });
    }, 300_000);

    for (const conclusion of ["neutral", "skipped", "cancelled", "failure"]) {
      it(`a required check concluding ${conclusion.toUpperCase()} is refused`, async () => {
        await expectHeld({
          checks: checksWith("gitleaks", { conclusion }),
          transitionReason: MERGE_TRANSITION.CHECKS_REQUIRED_NOT_SUCCESS
        });
      }, 300_000);
    }

    it("no check runs at all on the merge commit are refused", async () => {
      await expectHeld({ checks: [], transitionReason: MERGE_TRANSITION.CHECKS_MISSING });
    }, 300_000);
  });

  describe("the merge itself", () => {
    it("a merge whose PARENTS are in the wrong order is refused", async () => {
      // A REAL two-parent merge, published and green, whose first parent is the
      // reviewed head and whose second is the previous main - the authorized
      // transition run backwards. The structure alone refutes it.
      const backwards = syntheticMerge(repoPath, { base: prHead, head: prevMain, message: "backwards" });
      expect(parentsOf(repoPath, backwards)).toEqual([prHead, prevMain]);

      await expectHeld({
        pull: { mergeCommitSha: backwards },
        extraCommits: [backwards],
        closeout: { MERGE_SHA: backwards, PARENT_1: prHead, PARENT_2: prevMain },
        transitionReason: MERGE_TRANSITION.FIRST_PARENT_MISMATCH
      });
    }, 300_000);

    it("a SQUASH merge (one parent) is refused", async () => {
      const squash = syntheticMerge(repoPath, { base: prevMain, head: prHead, squash: true, message: "Squashed #81" });
      expect(parentsOf(repoPath, squash)).toEqual([prevMain]);

      await expectHeld({
        pull: { mergeCommitSha: squash },
        extraCommits: [squash],
        closeout: { MERGE_SHA: squash, PARENT_2: prevMain },
        transitionReason: MERGE_TRANSITION.NOT_A_TWO_PARENT_MERGE
      });
    }, 300_000);

    it("a PR whose head is not the approved head is refused", async () => {
      await expectHeld({
        pull: { headSha: prevMain },
        transitionReason: MERGE_TRANSITION.PULL_HEAD_MISMATCH
      });
    }, 300_000);
  });

  describe("the bound closeout report", () => {
    it("a report carrying no closeout evidence at all is refused", async () => {
      publishMerge();
      setComments([mergeTask()]);
      const res = await runWorker("report", {
        JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
        JARVIS_FAKE_CLAUDE_COMMIT: "1",
        JARVIS_FAKE_CLAUDE_PR: String(PR)
      });
      expect(res.code).toBe(3);
      const rec = task(MERGE_TASK);
      expect(rec.status).toBe(TASK_STATUS.BLOCKED);
      expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_TRANSITION_UNVERIFIED);
      expect(rec.merge_transition.reason).toBe(MERGE_TRANSITION.REPORT_FIELD_MISSING);
      expect(rec.commit_provenance.verified).toBe(true);
    }, 300_000);

    for (const field of ["MERGE_SHA", "PARENT_1", "PARENT_2", "EXPECTED_BASE_SHA", "EXPECTED_HEAD_SHA"]) {
      it(`a report whose ${field} does not match the verified truth is refused`, async () => {
        const rec = await expectHeld({
          closeout: { [field]: "1111111111111111111111111111111111111111" },
          transitionReason: MERGE_TRANSITION.REPORT_FIELD_MISMATCH
        });
        expect(rec.merge_transition.detail).toContain(field);
      }, 300_000);
    }

    it("a report naming a different PR than the authorization is refused", async () => {
      const rec = await expectHeld({
        env: { JARVIS_FAKE_CLAUDE_PR: "82" },
        transitionReason: MERGE_TRANSITION.REPORT_FIELD_MISMATCH
      });
      expect(rec.merge_transition.detail).toContain("PR_NUMBER");
    }, 300_000);

    it("LOCAL_HEAD that never reached the merge is refused", async () => {
      const rec = await expectHeld({
        closeout: { LOCAL_HEAD: prHead }, transitionReason: MERGE_TRANSITION.REPORT_FIELD_MISMATCH
      });
      expect(rec.merge_transition.detail).toContain("LOCAL_HEAD");
    }, 300_000);

    it("ORIGIN_MAIN still on the old base is refused", async () => {
      const rec = await expectHeld({
        closeout: { ORIGIN_MAIN: prevMain }, transitionReason: MERGE_TRANSITION.REPORT_FIELD_MISMATCH
      });
      expect(rec.merge_transition.detail).toContain("ORIGIN_MAIN");
    }, 300_000);

    it("WORKTREE_CLEAN=false is refused", async () => {
      const rec = await expectHeld({
        closeout: { WORKTREE_CLEAN: "false" }, transitionReason: MERGE_TRANSITION.REPORT_FIELD_MISMATCH
      });
      expect(rec.merge_transition.detail).toContain("WORKTREE_CLEAN");
    }, 300_000);

    it("a MISSING WORKTREE_CLEAN is refused", async () => {
      const rec = await expectHeld({
        closeout: { WORKTREE_CLEAN: null }, transitionReason: MERGE_TRANSITION.REPORT_FIELD_MISSING
      });
      expect(rec.merge_transition.detail).toContain("WORKTREE_CLEAN");
    }, 300_000);

    it("a DUPLICATE WORKTREE_CLEAN is refused - neither value is chosen", async () => {
      const rec = await expectHeld({
        closeout: { WORKTREE_CLEAN: ["true", "false"] },
        transitionReason: MERGE_TRANSITION.REPORT_FIELD_DUPLICATE
      });
      expect(rec.merge_transition.detail).toContain("WORKTREE_CLEAN");
    }, 300_000);

    it("SELF_APPROVAL=true is refused however green everything else is", async () => {
      const rec = await expectHeld({
        closeout: { SELF_APPROVAL: "true" }, transitionReason: MERGE_TRANSITION.REPORT_FIELD_MISMATCH
      });
      expect(rec.merge_transition.detail).toContain("SELF_APPROVAL");
    }, 300_000);

    it("a report claiming a required check failed, against a green remote, is refused", async () => {
      await expectHeld({
        closeout: { POST_MERGE_BUILD_TEST: "failure" },
        transitionReason: MERGE_TRANSITION.REPORT_CI_CONTRADICTS_REMOTE
      });
    }, 300_000);
  });
});

/* ==========================================================================
 * 3. THE SAME MANDATORY GATE, THROUGH EVERY COMPLETION PATH
 * ========================================================================== */

describe("D-147: the mandatory gate is the same on every completion path", () => {
  /**
   * PATH 2: abandoned-task crash recovery.
   *
   * The parent dies after the child has committed and reported, so no
   * post-dispatch provenance checkpoint was ever written and the verdict is
   * DERIVED on the next run - from the durable claim and the worktree's real HEAD.
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
    // The parent never reached its checkpoint: there is no recorded verdict.
    expect(task(MERGE_TASK).commit_provenance).toBeUndefined();
  }

  it("CRASH RECOVERY: an unmerged PR is refused although the derived range verifies", async () => {
    publishMerge({ pull: { merged: false, mergeCommitSha: null } });
    setComments([mergeTask()]);
    await crashAfterReport(verifiedChild());

    const res = await runWorker("silent");

    expect(res.code).toBe(3);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.successful).toBe(false);
    expect(rec.recovered_from_crash).toBe(true);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_TRANSITION_UNVERIFIED);
    // The derived verdict really did verify - so this is not the D-136 refusal.
    expect(rec.reconciliation_provenance.verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(rec.reconciliation_provenance.verified).toBe(true);
    expect(healthEvents().filter((e) => e.event === "completion_confirmed" && e.task_id === MERGE_TASK)).toEqual([]);
    expect(existsSync(wt(MERGE_TASK))).toBe(true);
  }, 300_000);

  it("CRASH RECOVERY: the complete proof retires it, and never as the provenance reason", async () => {
    publishMerge();
    setComments([mergeTask()]);
    await crashAfterReport(verifiedChild());

    const res = await runWorker("silent");

    expect(res.code).toBe(0);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    expect(rec.recovered_from_crash).toBe(true);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
    expect(rec.reconciliation_provenance.verified).toBe(true);
    expect(rec.merge_transition.verified).toBe(true);
    // And it was NOT dispatched a second time on top of an already-merged PR.
    expect(dispatched().filter((d) => d === MERGE_TASK)).toHaveLength(1);
  }, 300_000);

  /**
   * PATH 3: pre-selection reconciliation.
   *
   * Attempt 1 exits 0 having posted nothing, which parks the task as retryable.
   * The trusted closeout report then arrives OUT OF BAND - the crash-after-report
   * shape - and the next run must retire it before any candidate is chosen.
   */
  async function reportArrivesOutOfBand(closeout = {}) {
    setComments([mergeTask()]);
    await runWorker("silent", { JARVIS_FAKE_CLAUDE_MUTATE: "tracked", JARVIS_FAKE_CLAUDE_COMMIT: "1" });
    expect(task(MERGE_TASK).status).toBe(TASK_STATUS.FAILED_RETRYABLE);
    expect(task(MERGE_TASK).commit_provenance.verified).toBe(true);

    appendComment(reportComment(MERGE_TASK, { closeout }));
    const s = state();
    s.tasks[MERGE_TASK].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
    saveStateAtomic(statePath(), s, join(workerRoot, "state.json.bak"), { schema: "worker" });
  }

  it("PRE-SELECTION RECONCILIATION: an unmerged PR is refused although the range verifies", async () => {
    publishMerge({ pull: { merged: false, mergeCommitSha: null } });
    await reportArrivesOutOfBand();
    const before = dispatched().length;

    const res = await runWorker("silent");

    expect(dispatched()).toHaveLength(before);   // retired without re-dispatching
    expect(res.code).toBe(3);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.successful).toBe(false);
    expect(rec.reconciled_without_redispatch).toBe(true);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_TRANSITION_UNVERIFIED);
    expect(rec.reconciliation_provenance.verified).toBe(true);
    expect(healthEvents().filter((e) => e.event === "completion_confirmed" && e.task_id === MERGE_TASK)).toEqual([]);
  }, 300_000);

  it("PRE-SELECTION RECONCILIATION: the complete proof retires it on the transition reason", async () => {
    publishMerge();
    await reportArrivesOutOfBand();

    const res = await runWorker("silent");

    expect(res.code).toBe(0);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    expect(rec.reconciled_without_redispatch).toBe(true);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
    expect(rec.completion_gate.reason).not.toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
    expect(rec.merge_transition.verified).toBe(true);
  }, 300_000);

  /**
   * PATH 4: the pre-dispatch reconciliation inside `runTask`.
   *
   * This site is a BACKSTOP. `reconcileReportedTasks` runs earlier in the same
   * run, over the same comments, for every non-terminal task with at least one
   * attempt - which is a superset of the candidates `runTask` can be handed - so
   * whenever both would fire, the pre-selection pass has already retired the task
   * and `runTask` is never reached with it. It therefore cannot be driven through
   * the process entrypoint at all, and pretending otherwise would be a test that
   * silently exercised path 3 twice.
   *
   * What CAN be exercised is the thing the site actually does: it calls
   * `completionGateFor(cfg, prior, rec.completion, comments)` and acts on
   * `gate.held`, with no logic of its own. So it is called here with exactly that
   * argument shape, against the real config, the real durable claim and the real
   * worktree a preceding run left behind.
   */
  describe("PRE-DISPATCH RECONCILIATION (the backstop site, called directly)", () => {
    /** Leave behind a real prior attempt: real commits, real claim, real worktree. */
    async function seedPriorAttempt() {
      setComments([mergeTask()]);
      await runWorker("silent", { JARVIS_FAKE_CLAUDE_MUTATE: "tracked", JARVIS_FAKE_CLAUDE_COMMIT: "1" });
      appendComment(reportComment(MERGE_TASK));
      expect(task(MERGE_TASK).commit_provenance.verified).toBe(true);
    }

    /** Run the probe against a given comment set and return its parsed verdict. */
    async function probe(comments = null) {
      const commentsPath = join(dir, "probe-comments.json");
      const outPath = join(dir, "probe-verdict.json");
      writeFileSync(commentsPath, JSON.stringify(
        comments ?? JSON.parse(readFileSync(join(ghDir, "comments.json"), "utf8")), null, 2), "utf8");
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

    it("holds an unmerged PR although the range verifies", async () => {
      publishMerge({ pull: { merged: false, mergeCommitSha: null } });
      await seedPriorAttempt();

      const { gate, mergeTransition, completion } = await probe();

      expect(completion).toEqual({ complete: true, successful: true });
      expect(gate.held).toBe(true);
      expect(gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_TRANSITION_UNVERIFIED);
      expect(gate.provenance_verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
      expect(mergeTransition.reason).toBe(MERGE_TRANSITION.NOT_MERGED);
    }, 300_000);

    it("holds an undecidable merge order although the range verifies", async () => {
      await seedPriorAttempt();
      const all = JSON.parse(readFileSync(join(ghDir, "comments.json"), "utf8"));
      const { gate } = await probe([mergeTask({ MERGE_AUTHORIZED: "false" }), ...all.slice(1)]);

      expect(gate.held).toBe(true);
      expect(gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
      expect(gate.provenance_verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    }, 300_000);

    it("passes on the transition reason when the whole proof holds", async () => {
      await seedPriorAttempt();

      const { gate } = await probe();

      expect(gate.held).toBe(false);
      expect(gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
      expect(gate.reason).not.toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
    }, 300_000);
  });

  /**
   * The structural half of "no path-specific shortcut". Every one of the four
   * sites reaches `evaluateCompletionGate`, and a future edit that reintroduced a
   * provenance-conditional at ONE of them would be invisible to every behavioural
   * test above that happens not to cover that path.
   */
  it("NO PATH-SPECIFIC SHORTCUT: every gate evaluation is handed a merge classification", () => {
    const source = readFileSync(WORKER, "utf8");
    const calls = [...source.matchAll(/evaluateCompletionGate\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const args of calls) {
      // The one exemption is the explicit non-success early return, which is
      // decided before any evidence is gathered and gathers none.
      const isNonSuccessEarlyReturn = /provenance:\s*null/.test(args);
      if (isNonSuccessEarlyReturn) continue;
      expect(args).toMatch(/mergeAuthorization/);
    }
    // ...and the one decision function is the only producer of that argument.
    expect([...source.matchAll(/completionEvidenceFor\(/g)]).toHaveLength(3); // 1 definition + 2 call sites
    expect([...source.matchAll(/completionGateFor\(cfg,/g)]).toHaveLength(4); // 1 definition + 3 call sites
  });
});

/* ==========================================================================
 * 4. THE ORDINARY PATH DID NOT MOVE
 * ========================================================================== */

describe("D-147 POSITIVE CONTROL (a): the ordinary non-merge path is unchanged and cheap", () => {
  it("an ordinary task with verified provenance and a clean worktree still completes", async () => {
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
    // Still the ORIGINAL pass reason. D-147 must not make every task a merge task.
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(rec.completion_gate.merge_authorization_claim).toBe(MERGE_AUTHORIZATION.NONE);
    expect(rec.completion_gate.merge_authorization_claimed).toBe(false);
    expect(rec.merge_transition ?? null).toBe(null);
    // ...and it cost NOT ONE merge-transition read, even with a merged PR and a
    // full set of green checks sitting on the remote the whole time.
    expect(transitionReads()).toEqual([]);
  }, 300_000);

  it("an ordinary task whose child commits WITHOUT trailers is still held on provenance", async () => {
    setComments([ordinaryTask()]);

    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1",
      JARVIS_FAKE_CLAUDE_NO_TRAILER: "1"
    });

    expect(res.code).toBe(3);
    const rec = task(PLAIN_TASK);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.HELD_PROVENANCE_UNVERIFIED);
    expect(existsSync(wt(PLAIN_TASK))).toBe(true);
  }, 300_000);

  it("an ordinary task cannot borrow the merge order sitting on the same issue", async () => {
    // The trusted merge authorization for the merge task is on the control issue
    // and the PR really is merged. It must not reach the ordinary task in either
    // direction: not as an excuse, and not as a requirement.
    setComments([mergeTask(), ordinaryTask()]);

    await runWorker("report", verifiedChild());
    await runWorker("report", { JARVIS_FAKE_CLAUDE_MUTATE: "tracked", JARVIS_FAKE_CLAUDE_COMMIT: "1" });

    expect(task(MERGE_TASK).completion_gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
    const plain = task(PLAIN_TASK);
    expect(plain.status).toBe(TASK_STATUS.COMPLETED);
    expect(plain.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
    expect(plain.completion_gate.merge_authorization_claimed).toBe(false);
  }, 300_000);
});

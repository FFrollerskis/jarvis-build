/**
 * D-149 process-level tests: A CHILD CANNOT ESCAPE THE MERGE GATE BY REMOVING
 * ITS OWN ORDER.
 *
 * ------------------------------------------------------------------------
 * WHY THIS NEEDS A PROCESS TEST
 * ------------------------------------------------------------------------
 *
 * `durable-order-binding.test.mjs` proves the RULE. This file proves the THREAT,
 * the only way that means anything: by letting a real dispatched child actually
 * delete, replace and edit the control comment it was dispatched from, and then
 * driving `worker.mjs run` to completion over the issue as the child left it.
 *
 * The attack needs no privilege the child does not already hold. It posts its own
 * CLAUDE_ACK and CLAUDE_REPORT through `gh`, authenticated as the repository
 * owner - so `DELETE /repos/:o/:r/issues/comments/:id` is as available to it as
 * the POST it already uses. And the pay-off was larger than D-148's forgery:
 *
 *   FORGE A DUPLICATE  -> two candidates -> AMBIGUOUS -> refused (D-148)
 *   DELETE THE ORIGINAL -> zero candidates -> "no order" -> NOT A MERGE TASK
 *                        -> no transition proof, no required CI, no bound
 *                           closeout report -> retires as SUCCESSFUL.
 *
 * ------------------------------------------------------------------------
 * THE FIXTURE IS DELIBERATELY THE BEST CASE FOR THE ATTACKER
 * ------------------------------------------------------------------------
 *
 * Every negative below runs with everything else PERFECT: commits correctly
 * trailered so provenance verifies, a clean worktree, a real two-parent merge of
 * the approved base and head published on the remote, all required checks green,
 * and a complete bound closeout report. If a run is held, it is held by the
 * binding and by nothing else - and the assertions check that explicitly.
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
import { MERGE_AUTHORIZATION, MERGE_TRANSITION } from "../lib/merge-transition.mjs";
import { ORDER_BINDING, orderBodyDigest } from "../lib/order-binding.mjs";
import {
  createRepo, statusLines, head, git, treeOf, parentsOf, syntheticMerge
} from "./fixtures/real-git-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "worker.mjs");
const FAKE_GH = join(HERE, "fixtures", "fake-gh.mjs");
const FAKE_CLAUDE = join(HERE, "fixtures", "fake-claude.mjs");
const GATE_PROBE = join(HERE, "fixtures", "completion-gate-probe.mjs");

const TRUSTED = "tsworkflow";
const MERGE_TASK = "D149-PR81-DURABLE-ORDER-BINDING-20260915-A";
const PLAIN_TASK = "D149-ORDINARY-IMPLEMENTATION-20260915-A";
const ORDER_ID = 5674803631;
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-d149-"));
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
function mergeTask(overrides = {}, { id = ORDER_ID } = {}) {
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
    created_at: "2026-09-15T04:36:50Z",
    updated_at: "2026-09-15T04:36:50Z",
    author_association: "OWNER",
    user: { login: TRUSTED },
    body: ["ARCHITECT_TASK", ...Object.entries(fields).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`),
      "", "Perform the routine, guarded closeout merge for PR #81."].join("\n")
  };
}

/** An ORDINARY implementation order - no merge authorization anywhere in it. */
function ordinaryTask({ id = 5674803999 } = {}) {
  return {
    id,
    // Deliberately OLDER than `mergeTask`, so that when both are on the issue the
    // queue's oldest-fresh-first rule dispatches this one. A test that relied on
    // the other order would be testing the queue, not the binding.
    created_at: "2026-09-15T04:00:00Z",
    updated_at: "2026-09-15T04:00:00Z",
    author_association: "OWNER",
    user: { login: TRUSTED },
    // D-139 head tier OUTRANKS the fresh/retry tier and the timestamp, so an
    // order that declares no head would lose to `mergeTask` whenever both are on
    // the issue. Declaring the head we are actually on keeps the two comparable,
    // so the multi-task cases below test the BINDING and not the queue.
    body: `ARCHITECT_TASK\nTASK_ID=${PLAIN_TASK}\nEXPECTED_HEAD_SHA=${prHead}\n`
      + "ARCHITECT_MERGE_APPROVED=false\nMERGE_AUTHORIZED=false\n"
      + "Do some ordinary implementation work."
  };
}

const GREEN = Object.freeze([
  { name: "build-test", status: "completed", conclusion: "success" },
  { name: "windows-git-auth", status: "completed", conclusion: "success" },
  { name: "gitleaks", status: "completed", conclusion: "success" }
]);

/** The remote truth a correctly merged PR produces, all of it green. */
function publishMerge({ checks = null, pull = {} } = {}) {
  writeFileSync(join(ghDir, "pulls.json"), JSON.stringify([{
    number: PR,
    headRefName: "claude/d145-merge-transition-provenance",
    state: "closed",
    merged: true,
    mergedAt: "2026-09-15T05:00:00Z",
    mergeCommitSha: merge,
    headSha: prHead,
    baseSha: prevMain,
    baseRef: "main",
    ...pull
  }], null, 2), "utf8");

  const commits = {};
  for (const sha of [merge, prHead, prevMain]) {
    commits[sha] = { sha, treeSha: treeOf(repoPath, sha), parents: parentsOf(repoPath, sha) };
  }
  writeFileSync(join(ghDir, "commits.json"), JSON.stringify(commits, null, 2), "utf8");
  writeFileSync(join(ghDir, "check-runs.json"), JSON.stringify({ [merge]: checks ?? GREEN }, null, 2), "utf8");
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

/** The same child, plus the tampering with its own original order. */
const tamperingChild = (tamper, { taskId = null, ...rest } = {}) => goodChild({
  JARVIS_FAKE_CLAUDE_ORDER_TAMPER: tamper,
  ...(taskId ? { JARVIS_FAKE_CLAUDE_TASK_ID: taskId } : {}),
  ...rest
});

/** The closeout evidence as a report comment posted OUT OF BAND. */
function reportComment(taskId, { closeout = {}, status = "COMPLETE", id = 5674899001 } = {}) {
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

/** Is the original order still on the issue at all? */
function ordersFor(taskId) {
  return comments().filter((c) => c.user?.login === TRUSTED
    && String(c.body ?? "").split(/\r?\n/)[0].trim() === "ARCHITECT_TASK"
    && new RegExp(`^TASK_ID=${taskId}\\s*$`, "m").test(String(c.body ?? "")));
}

/**
 * The full "nothing was destroyed and nothing was accepted" assertion, plus the
 * D-149 half: the binding evidence is recorded and no order body leaked into it.
 */
function expectHeldAndPreserved(taskId, bindingReason) {
  const rec = task(taskId);
  expect(rec.status).toBe(TASK_STATUS.BLOCKED);
  expect(rec.successful).toBe(false);
  expect(rec.completed_at ?? null).toBe(null);
  expect(rec.completion_gate.held).toBe(true);
  expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
  expect(rec.completion_gate.merge_authorization_claim).toBe(MERGE_AUTHORIZATION.UNDECIDABLE);
  if (bindingReason) expect(rec.completion_gate.order_binding_reason).toBe(bindingReason);
  expect(rec.completion_gate.order_binding_verified).toBe(false);
  // NEVER a completion, and never a released worktree.
  expect(healthEvents().filter((e) => e.event === "completion_confirmed" && e.task_id === taskId)).toEqual([]);
  expect(existsSync(wt(taskId))).toBe(true);
  expect(claim(taskId).claim.state).toBe(CLAIM_STATE.READY);
  // The binding evidence carries digests, never the order.
  const serialised = JSON.stringify(rec.completion_gate);
  expect(serialised).not.toContain("ARCHITECT_MERGE_APPROVED");
  return rec;
}

/* ==========================================================================
 * 1. ADMISSION: the binding is written before the child exists
 * ========================================================================== */

describe("D-149 admission", () => {
  it("binds the exact order BEFORE dispatching, and the record proves it", async () => {
    setComments([mergeTask()]);

    await runWorker("report", goodChild());

    const rec = task(MERGE_TASK);
    expect(rec.architect_order).toBeTruthy();
    expect(rec.architect_order.comment_id).toBe(String(ORDER_ID));
    expect(rec.architect_order.created_at).toBe("2026-09-15T04:36:50Z");
    expect(rec.architect_order.body_sha256).toBe(orderBodyDigest(mergeTask().body).sha256);
    expect(rec.architect_order.task_id).toBe(MERGE_TASK);
    // No order body reached worker state.
    expect(JSON.stringify(rec.architect_order)).not.toContain("MERGE_AUTHORIZED");
  }, 300_000);

  it("REFUSES to re-dispatch a task admitted without a binding, and never invents one", async () => {
    // The legacy-migration shape: a record written by a pre-D-149 build, already
    // dispatched once, non-terminal. Synthesising a binding for it now would
    // adopt whatever order is on the issue today as its "original".
    setComments([mergeTask()]);
    await runWorker("silent", { JARVIS_FAKE_CLAUDE_MUTATE: "tracked", JARVIS_FAKE_CLAUDE_COMMIT: "1" });
    expect(task(MERGE_TASK).status).toBe(TASK_STATUS.FAILED_RETRYABLE);

    // Strip the binding, exactly as a migrated pre-D-149 record would be.
    const s = state();
    s.tasks[MERGE_TASK].architect_order = null;
    s.tasks[MERGE_TASK].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
    saveStateAtomic(statePath(), s, join(workerRoot, "state.json.bak"), { schema: "worker" });
    const before = dispatched().length;

    const res = await runWorker("report", goodChild());

    expect(res.code).toBe(3);
    expect(dispatched()).toHaveLength(before);            // NOT re-dispatched
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.last_failure_reason).toContain("architect_order_binding_unavailable");
    expect(rec.order_binding_failure.reason).toBe(ORDER_BINDING.BINDING_MISSING);
    // The binding was NOT synthesised from the order that is sitting right there.
    expect(rec.architect_order ?? null).toBe(null);
    expect(ordersFor(MERGE_TASK)).toHaveLength(1);
  }, 300_000);

  it("REFUSES to re-dispatch when the order has changed since admission", async () => {
    setComments([mergeTask()]);
    await runWorker("silent", { JARVIS_FAKE_CLAUDE_MUTATE: "tracked", JARVIS_FAKE_CLAUDE_COMMIT: "1" });
    const bound = task(MERGE_TASK).architect_order;
    expect(bound.comment_id).toBe(String(ORDER_ID));

    // The order is rewritten in place, widening nothing but changing one field.
    setComments([mergeTask({ PR_NUMBER: "82" })]);
    const s = state();
    s.tasks[MERGE_TASK].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
    saveStateAtomic(statePath(), s, join(workerRoot, "state.json.bak"), { schema: "worker" });
    const before = dispatched().length;

    const res = await runWorker("report", goodChild());

    expect(res.code).toBe(3);
    expect(dispatched()).toHaveLength(before);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.order_binding_failure.reason).toBe(ORDER_BINDING.BODY_DIGEST_MISMATCH);
    // IMMUTABLE: the stored binding is byte-identical to what admission wrote.
    expect(rec.architect_order).toEqual(bound);
  }, 300_000);

  it("a normal retry REUSES the binding rather than recomputing it", async () => {
    setComments([mergeTask()]);
    await runWorker("silent", { JARVIS_FAKE_CLAUDE_MUTATE: "tracked", JARVIS_FAKE_CLAUDE_COMMIT: "1" });
    const first = task(MERGE_TASK).architect_order;

    const s = state();
    s.tasks[MERGE_TASK].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
    saveStateAtomic(statePath(), s, join(workerRoot, "state.json.bak"), { schema: "worker" });

    await runWorker("silent", { JARVIS_FAKE_CLAUDE_MUTATE: "tracked", JARVIS_FAKE_CLAUDE_COMMIT: "1" });

    // Same document, including `bound_at` - a recomputed one would have moved.
    expect(task(MERGE_TASK).architect_order).toEqual(first);
    expect(task(MERGE_TASK).attempts).toBe(2);
  }, 300_000);
});

/* ==========================================================================
 * 2. THE ATTACK, THROUGH THE REAL ENTRYPOINT (post-dispatch completion)
 * ========================================================================== */

describe("D-149: a child that removes its own order cannot retire on it", () => {
  it("MERGE TASK, ORDER DELETED: held, and specifically NOT downgraded to ordinary", async () => {
    // THE HEADLINE CASE. Before D-149 this retired as COMPLETED + successful on
    // `commit_provenance_verified`, having proven only that Claude wrote its own
    // commits - with the merge gate silently removed.
    setComments([mergeTask()]);
    clearApiLog();

    const res = await runWorker("report", tamperingChild("delete"));

    expect(res.code).toBe(3);
    const rec = expectHeldAndPreserved(MERGE_TASK, ORDER_BINDING.ORDER_ABSENT);

    // The deletion really happened - otherwise this is a test of nothing.
    expect(existsSync(join(claudeDir, "order-deleted"))).toBe(true);
    expect(ordersFor(MERGE_TASK)).toHaveLength(0);

    // The commit range verified PERFECTLY. It did not help, and the record says
    // so rather than blaming the commits.
    expect(rec.commit_provenance.verified).toBe(true);
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(rec.completion_gate.provenance_verified).toBe(true);

    // The evidence names exactly what was expected and what was seen.
    expect(rec.completion_gate.expected_order_comment_id).toBe(String(ORDER_ID));
    expect(rec.completion_gate.observed_order_comment_ids).toEqual([]);
    expect(rec.completion_gate.control_comments_complete).toBe(true);

    // ZERO transition API reads: the binding failed, so nothing downstream ran.
    expect(transitionReads()).toEqual([]);
  }, 300_000);

  it("ORDER REPLACED by a different-id false/false order: held, never 'ordinary'", async () => {
    setComments([mergeTask()]);
    clearApiLog();

    const res = await runWorker("report", tamperingChild("replace"));

    expect(res.code).toBe(3);
    const rec = expectHeldAndPreserved(MERGE_TASK, ORDER_BINDING.COMMENT_ID_MISMATCH);
    // A replacement order EXISTS and says false/false. Reading it would make the
    // task ordinary - which is precisely what must not happen.
    expect(ordersFor(MERGE_TASK)).toHaveLength(1);
    expect(rec.completion_gate.observed_order_comment_ids).toEqual([String(ORDER_ID + 777)]);
    expect(rec.completion_gate.merge_authorization_claim).not.toBe(MERGE_AUTHORIZATION.NONE);
    expect(transitionReads()).toEqual([]);
  }, 300_000);

  it("ORDER EDITED in place (one byte): held on the digest", async () => {
    setComments([mergeTask()]);
    clearApiLog();

    const res = await runWorker("report", tamperingChild("edit"));

    expect(res.code).toBe(3);
    const rec = expectHeldAndPreserved(MERGE_TASK, ORDER_BINDING.BODY_DIGEST_MISMATCH);
    expect(ordersFor(MERGE_TASK)).toHaveLength(1);
    expect(rec.completion_gate.observed_order_comment_ids).toEqual([String(ORDER_ID)]);
    expect(rec.completion_gate.observed_order_body_digest)
      .not.toBe(rec.completion_gate.expected_order_body_digest);
    expect(transitionReads()).toEqual([]);
  }, 300_000);

  it("ORDER RE-POSTED with the SAME id and body but a new created_at: held", async () => {
    // The nastiest shape: indistinguishable by comment id, and the body digest
    // matches too. Only the bound creation metadata catches it.
    setComments([mergeTask()]);

    const res = await runWorker("report", tamperingChild("reissue"));

    expect(res.code).toBe(3);
    expectHeldAndPreserved(MERGE_TASK, ORDER_BINDING.CREATED_AT_MISMATCH);
  }, 300_000);

  it("ORDINARY TASK, ORDER DELETED: also held - the rule is not merge-specific", async () => {
    // An ordinary task's order is evidence too. A task whose order vanished
    // cannot prove it was ordinary rather than merge-authorized, and the worker
    // must not assume the cheaper of the two.
    setComments([ordinaryTask()]);
    clearApiLog();

    const res = await runWorker("report", tamperingChild("delete", { taskId: PLAIN_TASK }));

    expect(res.code).toBe(3);
    const rec = expectHeldAndPreserved(PLAIN_TASK, ORDER_BINDING.ORDER_ABSENT);
    expect(rec.commit_provenance.verified).toBe(true);
    expect(transitionReads()).toEqual([]);
  }, 300_000);

  it("deleting ANOTHER task's order does not freeze this one", async () => {
    // The necessary limit. Otherwise one stray deletion is a denial of service
    // against the whole queue.
    setComments([ordinaryTask(), mergeTask()]);

    const res = await runWorker("report", goodChild({
      JARVIS_FAKE_CLAUDE_TASK_ID: PLAIN_TASK,
      JARVIS_FAKE_CLAUDE_ORDER_TAMPER: "delete",
      JARVIS_FAKE_CLAUDE_ORDER_TAMPER_TASK_ID: MERGE_TASK
    }));

    expect(res.code).toBe(0);
    const rec = task(PLAIN_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
    expect(rec.completion_gate.order_binding_verified).toBe(true);
  }, 300_000);

  it("the user's primary checkout is untouched by any of it", async () => {
    setComments([mergeTask()]);
    await runWorker("report", tamperingChild("delete"));
    expect(statusLines(repoPath)).toEqual([]);
    expect(head(repoPath)).toBe(prHead);
  }, 300_000);
});

/* ==========================================================================
 * 3. THE SAME REFUSAL THROUGH EVERY OTHER COMPLETION PATH
 * ========================================================================== */

describe("D-149: a missing order holds on every completion path", () => {
  /**
   * PATH 2: abandoned-task crash recovery. The parent dies after the child has
   * deleted its order and posted its report, so the next run derives provenance
   * from the durable claim and the worktree's real HEAD - and reads the binding
   * from the state row the crashed parent DID write before it dispatched.
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

  it("CRASH RECOVERY: the deleted order still holds the recovered task", async () => {
    setComments([mergeTask()]);
    await crashAfterReport(tamperingChild("delete"));
    // The binding survived the crash: it was written at admission, before the
    // child existed, and that is the whole reason this path can still decide.
    expect(task(MERGE_TASK).architect_order.comment_id).toBe(String(ORDER_ID));
    expect(ordersFor(MERGE_TASK)).toHaveLength(0);
    clearApiLog();

    const res = await runWorker("silent");

    expect(res.code).toBe(3);
    const rec = expectHeldAndPreserved(MERGE_TASK, ORDER_BINDING.ORDER_ABSENT);
    expect(rec.recovered_from_crash).toBe(true);
    // The DERIVED range verified, so this is not the D-136 null-record refusal.
    expect(rec.reconciliation_provenance.verified).toBe(true);
    expect(transitionReads()).toEqual([]);
  }, 300_000);

  /**
   * PATH 3: pre-selection reconciliation. Attempt 1 exits 0 having deleted its
   * order and posted nothing; the trusted closeout report arrives out of band.
   */
  it("PRE-SELECTION RECONCILIATION: the deleted order holds it, without re-dispatch", async () => {
    setComments([mergeTask()]);
    await runWorker("silent", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1",
      JARVIS_FAKE_CLAUDE_ORDER_TAMPER: "delete"
    });
    expect(task(MERGE_TASK).status).toBe(TASK_STATUS.FAILED_RETRYABLE);
    expect(task(MERGE_TASK).commit_provenance.verified).toBe(true);
    expect(ordersFor(MERGE_TASK)).toHaveLength(0);

    appendComment(reportComment(MERGE_TASK));
    const s = state();
    s.tasks[MERGE_TASK].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
    saveStateAtomic(statePath(), s, join(workerRoot, "state.json.bak"), { schema: "worker" });
    const before = dispatched().length;
    clearApiLog();

    const res = await runWorker("silent");

    expect(dispatched()).toHaveLength(before);   // retired, never re-dispatched
    expect(res.code).toBe(3);
    const rec = expectHeldAndPreserved(MERGE_TASK, ORDER_BINDING.ORDER_ABSENT);
    expect(rec.reconciled_without_redispatch).toBe(true);
    expect(rec.reconciliation_provenance.verified).toBe(true);
    expect(transitionReads()).toEqual([]);
  }, 300_000);

  /**
   * PATH 4: the pre-dispatch reconciliation backstop inside `runTask`, driven
   * through the exact shared call that site makes. See the D-147 file for why
   * the site cannot be reached by running the process.
   */
  describe("PRE-DISPATCH RECONCILIATION (the backstop site, called directly)", () => {
    async function seedPriorAttempt() {
      setComments([mergeTask()]);
      await runWorker("silent", { JARVIS_FAKE_CLAUDE_MUTATE: "tracked", JARVIS_FAKE_CLAUDE_COMMIT: "1" });
      appendComment(reportComment(MERGE_TASK));
      expect(task(MERGE_TASK).commit_provenance.verified).toBe(true);
      expect(task(MERGE_TASK).architect_order.comment_id).toBe(String(ORDER_ID));
    }

    async function probe(list, completeness = "complete") {
      const commentsPath = join(dir, "probe-comments.json");
      const outPath = join(dir, "probe-verdict.json");
      writeFileSync(commentsPath, JSON.stringify(list ?? comments(), null, 2), "utf8");
      const child = spawn(process.execPath,
        [GATE_PROBE, configPath, commentsPath, MERGE_TASK, outPath, completeness], {
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

    it("holds when the order is gone, although the range verifies", async () => {
      await seedPriorAttempt();
      const withoutOrder = comments().filter((c) => !String(c.body).startsWith("ARCHITECT_TASK"));
      const { gate } = await probe(withoutOrder);

      expect(gate.held).toBe(true);
      expect(gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
      expect(gate.order_binding_reason).toBe(ORDER_BINDING.ORDER_ABSENT);
      expect(gate.provenance_verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
      expect(gate.provenance_verified).toBe(true);
    }, 300_000);

    it("holds when the order body changed", async () => {
      await seedPriorAttempt();
      const { gate } = await probe([...comments().filter((c) => !String(c.body).startsWith("ARCHITECT_TASK")),
        mergeTask({ PR_NUMBER: "82" })]);

      expect(gate.held).toBe(true);
      expect(gate.order_binding_reason).toBe(ORDER_BINDING.BODY_DIGEST_MISMATCH);
    }, 300_000);

    it("holds on an INCOMPLETE read, with the order present and matching", async () => {
      await seedPriorAttempt();
      const { gate } = await probe(null, "incomplete");

      expect(gate.held).toBe(true);
      expect(gate.order_binding_reason).toBe(ORDER_BINDING.COLLECTION_INCOMPLETE);
      expect(gate.control_comments_complete).toBe(false);
    }, 300_000);

    it("passes on the transition proof when the bound order is intact", async () => {
      await seedPriorAttempt();
      const { gate } = await probe();

      expect(gate.held).toBe(false);
      expect(gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
      expect(gate.order_binding_verified).toBe(true);
      expect(gate.expected_order_comment_id).toBe(String(ORDER_ID));
      expect(gate.control_comments_complete).toBe(true);
    }, 300_000);
  });
});

/* ==========================================================================
 * 4. POSITIVE CONTROLS: nothing that worked before was broken
 * ========================================================================== */

describe("D-149 POSITIVE CONTROLS", () => {
  it("(a) an unchanged bound ORDINARY task completes on provenance + clean worktree", async () => {
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
    // NONE, but now provably from a PRESENT, PROVEN, MATCHING order.
    expect(rec.completion_gate.order_binding_verified).toBe(true);
    expect(rec.completion_gate.control_comments_complete).toBe(true);
    // Still costs not one merge-transition read.
    expect(transitionReads()).toEqual([]);
    expect(healthEvents().some((e) => e.event === "completion_confirmed" && e.task_id === PLAIN_TASK)).toBe(true);
  }, 300_000);

  it("(b) an unchanged bound MERGE task completes only on the full transition proof", async () => {
    setComments([mergeTask()]);

    const res = await runWorker("report", goodChild());

    expect(res.code).toBe(0);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
    expect(rec.completion_gate.reason).not.toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
    expect(rec.completion_gate.order_binding_verified).toBe(true);
    expect(rec.merge_transition.verified).toBe(true);
    expect(rec.merge_transition.required_checks).toEqual(["build-test", "windows-git-auth", "gitleaks"]);
    expect(rec.merge_transition.merge_parents).toEqual([prevMain, prHead]);
    expect(rec.merge_transition.report_local_evidence_fields)
      .toEqual(["LOCAL_HEAD", "ORIGIN_MAIN", "WORKTREE_CLEAN"]);
  }, 300_000);

  it("(b) and it is still held for the RIGHT reason when a remote fact is wrong", async () => {
    // The control that keeps the control honest: with the binding intact, the
    // D-147 gate is still what decides, and it names the transition - not the
    // binding.
    publishMerge({ pull: { merged: false, mergeCommitSha: null } });
    setComments([mergeTask()]);

    const res = await runWorker("report", goodChild());

    expect(res.code).toBe(3);
    const rec = task(MERGE_TASK);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_TRANSITION_UNVERIFIED);
    expect(rec.merge_transition.reason).toBe(MERGE_TRANSITION.NOT_MERGED);
    expect(rec.completion_gate.merge_authorization_claim).toBe(MERGE_AUTHORIZATION.AUTHORIZED);
    expect(rec.completion_gate.order_binding_verified).toBe(true);
  }, 300_000);

  it("(c) the narrow unattributed single-GitHub-merge exception is unchanged", async () => {
    // D-144's exact shape: the child syncs its worktree onto the GitHub merge
    // commit and commits nothing of its own, so the range is UNATTRIBUTED and
    // the only unexplained commit is the merge commit itself.
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

  it("(c) and DELETING the order removes even that exception", async () => {
    // The narrow excuse is reached through the authorization, so a missing
    // binding must take it away rather than leave a second route in.
    setComments([mergeTask()]);

    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_SYNC_TO: merge,
      JARVIS_FAKE_CLAUDE_PR: String(PR),
      JARVIS_FAKE_CLAUDE_REPORT_FIELDS: JSON.stringify(closeoutFields()),
      JARVIS_FAKE_CLAUDE_ORDER_TAMPER: "delete"
    });

    expect(res.code).toBe(3);
    const rec = expectHeldAndPreserved(MERGE_TASK, ORDER_BINDING.ORDER_ABSENT);
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
  }, 300_000);

  it("an overlapping pagination copy of the order is still ONE order", async () => {
    // The false-positive control. `gh api --paginate` concatenates pages and an
    // overlapping boundary repeats one comment verbatim; refusing on that would
    // fail every task on a transport artefact.
    const one = mergeTask();
    setComments([one, { ...one }]);

    const res = await runWorker("report", goodChild());

    expect(res.code).toBe(0);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_AUTHORIZED_MERGE_TRANSITION);
    expect(rec.completion_gate.merge_authority_candidate_count).toBe(1);
    expect(rec.completion_gate.order_binding_verified).toBe(true);
  }, 300_000);

  it("D-148's duplicate refusal still fires, and names AMBIGUITY not the binding", async () => {
    // D-150 note: the duplicate now arrives FROM THE CHILD, after the task was
    // admitted from a single unambiguous order. Seeding two orders up front no
    // longer reaches the completion gate at all - the admission gate refuses
    // before any child exists (asserted directly in the case below). The
    // completion-time verdict this control is about is unchanged, and posting the
    // duplicate mid-attempt is the only remaining way to reach it.
    setComments([mergeTask()]);

    const res = await runWorker("report", goodChild({
      JARVIS_FAKE_CLAUDE_FORGE_ORDER: JSON.stringify({
        ARCHITECT_MERGE_APPROVED: "true",
        MERGE_AUTHORIZED: "true",
        PR_NUMBER: String(PR),
        EXPECTED_BASE_SHA: prevMain,
        EXPECTED_HEAD_SHA: prHead
      })
    }));

    expect(res.code).toBe(3);
    expect(ordersFor(MERGE_TASK)).toHaveLength(2);
    const rec = task(MERGE_TASK);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
    expect(rec.completion_gate.merge_authorization_reason).toBe(MERGE_TRANSITION.AMBIGUOUS_AUTHORITY);
    expect(rec.completion_gate.merge_authority_candidate_count).toBe(2);
    // The binding is NOT what refused: it is intact and names the real original.
    expect(rec.architect_order.comment_id).toBe(String(ORDER_ID));
  }, 300_000);

  it("D-150: the same two orders present up front are refused BEFORE any child", async () => {
    // Strictly stronger, and the reason the control above had to move. Nothing is
    // dispatched, so there is no completion gate to reach and no binding to make.
    setComments([mergeTask(), mergeTask({}, { id: ORDER_ID + 1 })]);
    const before = dispatched().length;

    const res = await runWorker("report", goodChild());

    expect(res.code).toBe(3);
    expect(dispatched()).toHaveLength(before);
    expect(existsSync(wt(MERGE_TASK))).toBe(false);
    const rec = task(MERGE_TASK);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.completion_gate ?? null).toBeNull();
    expect(rec.architect_order ?? null).toBeNull();
    expect(rec.order_authority_failure.distinct_order_count).toBe(2);
  }, 300_000);
});

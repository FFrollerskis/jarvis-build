/**
 * D-151 process-level tests: A CYCLE DECIDES FROM ONE COMPLETE, IMMUTABLE
 * SNAPSHOT, OR IT DECIDES NOTHING.
 *
 * ------------------------------------------------------------------------
 * WHY THIS NEEDS A PROCESS TEST
 * ------------------------------------------------------------------------
 *
 * `authority-snapshot.test.mjs` proves the RULE and `queue.test.mjs` proves the
 * ranking and retirement logic. Neither can prove what actually matters here,
 * which is a claim about EFFECTS THAT DID NOT OCCUR: that a held cycle retired
 * nothing, superseded nothing, wrote no state, created no worktree or scratch
 * directory, read no transition API, built no prompt and spawned no child. A
 * claim like that can only be checked against the things that would exist if it
 * were false - so every case below drives the REAL `worker.mjs run` entrypoint as
 * a real OS process, over a real git repository, and then looks.
 *
 * ------------------------------------------------------------------------
 * WHAT D-150 LEFT REACHABLE, AND WHAT EACH BLOCK CLOSES
 * ------------------------------------------------------------------------
 *
 *   INCOMPLETE READ    D-150 enforced completeness AT ADMISSION, for the ONE task
 *   AS A WARNING       already chosen. `runOwned` logged a warning and carried on
 *                      into crash recovery, report reconciliation, ranking and
 *                      retirement first - all of which write TERMINAL state and
 *                      all of which turn on something being ABSENT.
 *
 *   A SECOND, WEAKER   `collectTrustedTasks` computed `uniqueAuthority` from a
 *   AUTHORITY DECIDER  count and promoted a representative by ARRAY POSITION. The
 *                      queue then ranked and proved direction from it.
 *
 *   SEMANTIC FIELDS    A unique but EDITED order still declared `SUPERSEDES=` and
 *   FROM A REFUSED     retired a victim; an order with no usable id or no
 *   ORDER              parseable `created_at` scored 0/0 and sorted to the FRONT
 *                      of the fresh tier, preempting a live order.
 *
 * Every negative below runs with everything else PERFECT - correctly trailered
 * commits, a clean worktree, a real two-parent merge on the remote, all required
 * checks green. If a run refuses, it is the snapshot gate and nothing else.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { loadState, saveStateAtomic, TASK_STATUS } from "../lib/state.mjs";
import { claimFilePath, taskWorktreePath } from "../lib/worktree.mjs";
import { ORDER_AUTHORITY } from "../lib/order-authority.mjs";
import { AUTHORITY_SNAPSHOT } from "../lib/authority-snapshot.mjs";
import { orderBodyDigest } from "../lib/order-binding.mjs";
import { SUPERSESSION_BASIS } from "../lib/queue.mjs";
import { createRepo, git, head, treeOf, parentsOf, syntheticMerge } from "./fixtures/real-git-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "worker.mjs");
const FAKE_GH = join(HERE, "fixtures", "fake-gh.mjs");
const FAKE_CLAUDE = join(HERE, "fixtures", "fake-claude.mjs");

const TRUSTED = "tsworkflow";
/** The older, still-eligible task every destructive case is aimed at. */
const VICTIM = "D151-OLDER-VICTIM-20260915-A";
/** The newer order under test - genuine in the positive controls, not otherwise. */
const DECLARER = "D151-NEWER-DECLARER-20260915-B";
const VICTIM_ID = 5677000001;
const DECLARER_ID = 5677000002;
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-d151-"));
  workerRoot = join(dir, "worker");
  repoPath = join(dir, "repo");
  ghDir = join(dir, "gh");
  claudeDir = join(dir, "claude");
  worktreeRoot = join(workerRoot, "worktrees");
  for (const d of [workerRoot, ghDir, claudeDir, join(workerRoot, "logs"), worktreeRoot]) {
    mkdirSync(d, { recursive: true });
  }

  ({ baseline: prevMain } = createRepo(repoPath));
  writeFileSync(join(repoPath, "feature.txt"), "the reviewed change\n", "utf8");
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "-m", "feat: the change PR #81 carries"]);
  prHead = head(repoPath);
  const merge = syntheticMerge(repoPath, { base: prevMain, head: prHead, message: `Merge pull request #${PR}` });

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
  writeFileSync(join(ghDir, "pulls.json"), JSON.stringify([{
    number: PR,
    headRefName: "claude/d145-merge-transition-provenance",
    state: "closed",
    merged: true,
    mergedAt: "2026-09-15T08:00:00Z",
    mergeCommitSha: merge,
    headSha: prHead,
    baseSha: prevMain,
    baseRef: "main"
  }], null, 2), "utf8");
  const commits = {};
  for (const sha of [merge, prHead, prevMain]) {
    commits[sha] = { sha, treeSha: treeOf(repoPath, sha), parents: parentsOf(repoPath, sha) };
  }
  writeFileSync(join(ghDir, "commits.json"), JSON.stringify(commits, null, 2), "utf8");
  writeFileSync(join(ghDir, "check-runs.json"), JSON.stringify({
    [merge]: [
      { name: "build-test", status: "completed", conclusion: "success" },
      { name: "windows-git-auth", status: "completed", conclusion: "success" },
      { name: "gitleaks", status: "completed", conclusion: "success" }
    ]
  }, null, 2), "utf8");
  // D-158: no comparison fixture. The merge proof recomputes the merge from the
  // real objects in `repoPath`, which this fixture already has.
  writeFileSync(join(ghDir, "fail.json"), JSON.stringify({}), "utf8");
  setComments([]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/* ---------------- the control plane ---------------- */

/**
 * An ordinary, trusted ARCHITECT_TASK.
 *
 * Every case declares the head the repository is actually on, so head tiering is
 * never what decides anything here - these tests are about AUTHORITY.
 */
function task({
  taskId,
  id,
  createdAt,
  updatedAt = null,
  supersedes = null,
  expectedHead = undefined,
  extra = ""
}) {
  const head = expectedHead === undefined ? prHead : expectedHead;
  const body = [
    "ARCHITECT_TASK",
    `TASK_ID=${taskId}`,
    head ? `EXPECTED_HEAD_SHA=${head}` : "",
    supersedes ? `SUPERSEDES=${supersedes}` : "",
    "ARCHITECT_MERGE_APPROVED=false",
    "MERGE_AUTHORIZED=false",
    extra,
    "Do some ordinary implementation work."
  ].filter(Boolean).join("\n");
  const comment = {
    id,
    created_at: createdAt,
    author_association: "OWNER",
    user: { login: TRUSTED },
    body
  };
  if (updatedAt !== null) comment.updated_at = updatedAt;
  else if (createdAt !== null) comment.updated_at = createdAt;
  return comment;
}

const victimOrder = (over = {}) =>
  task({ taskId: VICTIM, id: VICTIM_ID, createdAt: "2026-09-15T06:00:00Z", ...over });
const declarerOrder = (over = {}) =>
  task({ taskId: DECLARER, id: DECLARER_ID, createdAt: "2026-09-15T07:00:00Z", ...over });

function setComments(list) {
  writeFileSync(join(ghDir, "comments.json"), JSON.stringify(list, null, 2), "utf8");
}

function setFailures(patch) {
  writeFileSync(join(ghDir, "fail.json"), JSON.stringify(patch, null, 2), "utf8");
}

function runWorker(mode = "report", extraEnv = {}) {
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
const record = (id) => state()?.tasks?.[id] ?? null;
const wt = (taskId) => taskWorktreePath(worktreeRoot, taskId);

/** The EXACT bytes of the state file, for a byte-for-byte unchanged assertion. */
const stateBytes = () => (existsSync(statePath()) ? readFileSync(statePath()) : null);

function healthEvents() {
  const path = join(workerRoot, "logs", "health.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function dispatched() {
  const path = join(claudeDir, "dispatched.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

function prompts() {
  const path = join(claudeDir, "prompts.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).prompt)
    : [];
}

function apiCalls() {
  const path = join(ghDir, "api.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

/** PR merge-state, commit and check-run reads: the three transition lookups. */
const transitionReads = () =>
  apiCalls().filter((line) => /\/commits\//.test(line) || /merged:/.test(line));

/** Anything the worker posted back to the control issue this run. */
function postedComments(since) {
  return JSON.parse(readFileSync(join(ghDir, "comments.json"), "utf8")).slice(since);
}

/** Seed the older victim as a real, non-terminal, immediately eligible task. */
function seedVictim(patch = {}) {
  const s = state() ?? { schema_version: 2, tasks: {} };
  s.tasks = s.tasks ?? {};
  s.tasks[VICTIM] = {
    task_id: VICTIM,
    status: TASK_STATUS.FAILED_RETRYABLE,
    attempts: 1,
    first_dispatch_at: "2026-09-15T06:05:00Z",
    last_dispatch_at: "2026-09-15T06:05:00Z",
    next_eligible_at: new Date(Date.now() - 60_000).toISOString(),
    successful: false,
    last_failure_reason: "exit_0_without_matching_report",
    architect_order: {
      binding_version: 1,
      task_id: VICTIM,
      comment_id: String(VICTIM_ID),
      created_at: "2026-09-15T06:00:00Z",
      body_sha256: orderBodyDigest(victimOrder().body).sha256,
      body_bytes: orderBodyDigest(victimOrder().body).bytes,
      bound_at: "2026-09-15T06:05:00Z"
    },
    ...patch
  };
  saveStateAtomic(statePath(), s, join(workerRoot, "state.json.bak"), { schema: "worker" });
}

/**
 * THE FULL "THIS CYCLE DECIDED NOTHING" ASSERTION.
 *
 * Takes the exact state bytes and comment count captured before the run.
 */
function expectCycleDecidedNothing({ before, commentsBefore }) {
  // No child, no prompt bytes.
  expect(dispatched()).toEqual([]);
  expect(prompts()).toEqual([]);
  // No worktree and no claim for anything.
  expect(existsSync(wt(VICTIM))).toBe(false);
  expect(existsSync(wt(DECLARER))).toBe(false);
  expect(existsSync(claimFilePath(worktreeRoot, DECLARER))).toBe(false);
  // No repository or transition API mutation.
  expect(transitionReads()).toEqual([]);
  // No completion, no supersession.
  expect(healthEvents().filter((e) => e.event === "completion_confirmed")).toEqual([]);
  expect(healthEvents().filter((e) => e.reason === "superseded_by_newer_completed_task")).toEqual([]);
  // Worker state byte-for-byte as it was.
  expect(stateBytes()).toEqual(before);
  // Exactly one status comment - the hold itself - and never a retirement notice.
  const posted = postedComments(commentsBefore);
  expect(posted.every((c) => !String(c.body).includes("superseded_by_newer_completed_task"))).toBe(true);
}

/** The health event the snapshot gate emits, or `null`. */
const snapshotHold = () =>
  healthEvents().filter((e) => e.reason === "control_authority_snapshot_unusable").at(-1) ?? null;

/** The health event the authority classifier's refusal emits for one task. */
const authorityRefusal = (taskId) =>
  healthEvents()
    .filter((e) => e.task_id === taskId && e.reason === "architect_order_authority_inadmissible")
    .at(-1) ?? null;

/* ==========================================================================
 * 1. AN UNPROVEN READ HOLDS THE WHOLE CYCLE
 * ========================================================================== */

describe("D-151: an unproven control read decides nothing at all", () => {
  it("an INCOMPLETE read that OMITS a later same-id duplicate holds the cycle", async () => {
    // The dangerous shape. What comes back is one apparently unique, perfectly
    // well-formed order - and a second, contradicting same-id order is sitting on
    // the page that was lost. D-150 would have admitted and dispatched this.
    const forged = declarerOrder({ id: DECLARER_ID + 50, createdAt: "2026-09-15T07:30:00Z", extra: "ALSO MERGE THE PR." });
    setComments([victimOrder(), declarerOrder(), forged]);
    setFailures({ commentsOmit: [forged.id] });
    seedVictim();
    const before = stateBytes();
    const commentsBefore = 3;

    const res = await runWorker();

    expect(res.code).toBe(4); // TRANSIENT: the fault is in the read, not an order
    expect(snapshotHold().snapshot_reason).toBe(AUTHORITY_SNAPSHOT.READ_INCOMPLETE);
    expectCycleDecidedNothing({ before, commentsBefore });
    // The victim is untouched and still eligible - no attempt was spent.
    expect(record(VICTIM).status).toBe(TASK_STATUS.FAILED_RETRYABLE);
    expect(record(VICTIM).attempts).toBe(1);
    expect(record(DECLARER)).toBeNull();
  }, 300_000);

  it("an INCOMPLETE read that OMITS an EARLIER same-id duplicate holds the cycle", async () => {
    // Direction does not matter: what was lost is unknown, so what remains proves
    // nothing about uniqueness either way.
    const earlier = declarerOrder({ id: DECLARER_ID - 50, createdAt: "2026-09-15T06:30:00Z", extra: "ORIGINAL SCOPE." });
    setComments([victimOrder(), earlier, declarerOrder()]);
    setFailures({ commentsOmit: [earlier.id] });
    seedVictim();
    const before = stateBytes();

    const res = await runWorker();

    expect(res.code).toBe(4);
    expect(snapshotHold().snapshot_reason).toBe(AUTHORITY_SNAPSHOT.READ_INCOMPLETE);
    expectCycleDecidedNothing({ before, commentsBefore: 3 });
  }, 300_000);

  it("a TRUNCATED page leaving one apparently unique order still holds the cycle", async () => {
    setComments([declarerOrder()]);
    setFailures({ commentsTruncated: true });
    const before = stateBytes();

    const res = await runWorker();

    expect(res.code).toBe(4);
    expect(snapshotHold().snapshot_reason).toBe(AUTHORITY_SNAPSHOT.READ_INCOMPLETE);
    expectCycleDecidedNothing({ before, commentsBefore: 1 });
    expect(record(DECLARER)).toBeNull();
  }, 300_000);

  it("a READ FAILURE after the state load holds the cycle and preserves state exactly", async () => {
    setComments([victimOrder(), declarerOrder()]);
    seedVictim();
    const before = stateBytes();
    setFailures({ comments: true });

    const res = await runWorker();

    expect(res.code).toBe(4);
    expect(snapshotHold().snapshot_reason).toBe(AUTHORITY_SNAPSHOT.READ_FAILED);
    expect(dispatched()).toEqual([]);
    expect(prompts()).toEqual([]);
    expect(stateBytes()).toEqual(before);
    expect(record(VICTIM).status).toBe(TASK_STATUS.FAILED_RETRYABLE);
  }, 300_000);

  it("a held cycle performs NO crash recovery and leaves an IN_PROGRESS task alone", async () => {
    // Recovery used to run BEFORE completeness was ever consulted, and it writes
    // terminal state. An abandoned task must survive a bad read untouched.
    setComments([victimOrder()]);
    seedVictim({
      status: TASK_STATUS.IN_PROGRESS,
      child_identity: { pid: 999999, started_at: "2026-09-15T06:05:00Z", command: "node" },
      last_dispatch_at: new Date(Date.now() - 6 * 60 * 60_000).toISOString()
    });
    const before = stateBytes();
    setFailures({ commentsTruncated: true });

    const res = await runWorker();

    expect(res.code).toBe(4);
    expect(stateBytes()).toEqual(before);
    expect(record(VICTIM).status).toBe(TASK_STATUS.IN_PROGRESS);
    expect(healthEvents().filter((e) => e.reason === "recovered_abandoned_in_progress")).toEqual([]);
  }, 300_000);

  it("the SAME queue proceeds normally once the read is complete", async () => {
    // The other half of "the fault is in the read". A dropped page must cost
    // nothing permanent, or one flaky request is a denial of service.
    setComments([declarerOrder()]);
    setFailures({ commentsTruncated: true });
    await runWorker();
    expect(record(DECLARER)).toBeNull();

    setFailures({});
    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1"
    });

    expect(res.code).toBe(0);
    expect(dispatched()).toEqual([DECLARER]);
    expect(record(DECLARER).status).toBe(TASK_STATUS.COMPLETED);
  }, 300_000);
});

/* ==========================================================================
 * 2. NOTHING SEMANTIC FROM AN INADMISSIBLE ORDER REACHES STATE
 * ========================================================================== */

describe("D-151: an inadmissible order retires nothing and ranks nowhere", () => {
  /** Every way an order can be inadmissible on a COMPLETE read. */
  const inadmissible = [
    ["an EDITED order", () => declarerOrder({ supersedes: VICTIM, updatedAt: "2026-09-15T09:00:00Z" }),
      ORDER_AUTHORITY.EDITED],
    ["an order with NO usable comment id", () => declarerOrder({ supersedes: VICTIM, id: null }),
      ORDER_AUTHORITY.NO_COMMENT_IDENTITY],
    ["an order with an UNPARSEABLE created_at", () => declarerOrder({ supersedes: VICTIM, createdAt: "whenever" }),
      ORDER_AUTHORITY.NO_ORDERING_METADATA]
  ];

  for (const [name, make, reason] of inadmissible) {
    it(`${name} declaring SUPERSEDES leaves the victim byte-for-byte unchanged`, async () => {
      setComments([victimOrder(), make()]);
      // Parked in a FUTURE backoff window, so nothing about this run can touch
      // the victim for any legitimate reason either. "Unchanged" then means
      // exactly that - identical - rather than "changed, but only in ways we
      // decided to tolerate".
      seedVictim({ next_eligible_at: new Date(Date.now() + 60 * 60_000).toISOString() });
      const victimBefore = JSON.stringify(record(VICTIM));

      const res = await runWorker();

      expect(res.code).toBe(3); // BLOCKED: the finding is about the ORDER
      expect(authorityRefusal(DECLARER).authority_reason).toBe(reason);
      // THE VICTIM IS UNTOUCHED. Not "not superseded" - identical.
      expect(JSON.stringify(record(VICTIM))).toBe(victimBefore);
      expect(record(VICTIM).status).toBe(TASK_STATUS.FAILED_RETRYABLE);
      expect(healthEvents().filter((e) => e.reason === "superseded_by_newer_completed_task")).toEqual([]);
      // The refused order is terminal and carries its finding, never a binding.
      expect(record(DECLARER).status).toBe(TASK_STATUS.BLOCKED);
      expect(record(DECLARER).architect_order ?? null).toBeNull();
      expect(record(DECLARER).order_authority_failure.reason).toBe(reason);
      // And it was never executed: no worktree, no claim, no prompt, no child.
      expect(dispatched()).toEqual([]);
      expect(prompts()).toEqual([]);
      expect(existsSync(wt(DECLARER))).toBe(false);
      expect(existsSync(claimFilePath(worktreeRoot, DECLARER))).toBe(false);
      expect(transitionReads()).toEqual([]);
    }, 300_000);
  }

  it("a DUPLICATE same-id order declaring SUPERSEDES retires nothing", async () => {
    setComments([
      victimOrder(),
      declarerOrder({ supersedes: VICTIM }),
      declarerOrder({ id: DECLARER_ID + 1, createdAt: "2026-09-15T07:10:00Z", supersedes: VICTIM, extra: "ALSO MERGE." })
    ]);
    seedVictim({ next_eligible_at: new Date(Date.now() + 60 * 60_000).toISOString() });
    const victimBefore = JSON.stringify(record(VICTIM));

    const res = await runWorker();

    expect(res.code).toBe(3);
    expect(authorityRefusal(DECLARER).authority_reason).toBe(ORDER_AUTHORITY.AMBIGUOUS);
    expect(authorityRefusal(DECLARER).distinct_order_count).toBe(2);
    expect(JSON.stringify(record(VICTIM))).toBe(victimBefore);
  }, 300_000);

  it("the victim RUNS normally afterwards - a refused declarer costs it nothing", async () => {
    // The complement of the four cases above, and the reason the refusal must not
    // simply stall the queue: the older order is still perfectly valid, so once
    // its backoff elapses it dispatches exactly as though the bad order had never
    // been posted.
    setComments([victimOrder(), declarerOrder({ supersedes: VICTIM, updatedAt: "2026-09-15T09:00:00Z" })]);
    seedVictim();

    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1"
    });

    expect(dispatched()).toEqual([VICTIM]);
    expect(record(VICTIM).status).toBe(TASK_STATUS.COMPLETED);
    expect(record(VICTIM).successful).toBe(true);
    expect(record(DECLARER).status).toBe(TASK_STATUS.BLOCKED);
    // Still not a healthy run: a control comment needs a human and a fresh id.
    expect(res.code).toBe(3);
  }, 300_000);

  it("an inadmissible order's EXPECTED_HEAD_SHA cannot preempt an admissible one", async () => {
    // The concrete regression. An order with no parseable `created_at` used to
    // score `createdMs = 0`, which sorted it to the FRONT of the fresh tier - so
    // it was chosen, its own pre-flight refused it, and the live order waited.
    const stale = task({
      taskId: "D151-UNORDERED-20260915-C",
      id: 5677000009,
      createdAt: "not-a-timestamp",
      expectedHead: prHead
    });
    setComments([stale, declarerOrder()]);

    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1"
    });

    // The ADMISSIBLE order ran. The unordered one took no place in the queue.
    expect(dispatched()).toEqual([DECLARER]);
    expect(record(DECLARER).status).toBe(TASK_STATUS.COMPLETED);
    expect(record("D151-UNORDERED-20260915-C").status).toBe(TASK_STATUS.BLOCKED);
    expect(authorityRefusal("D151-UNORDERED-20260915-C").authority_reason)
      .toBe(ORDER_AUTHORITY.NO_ORDERING_METADATA);
    // A refused order is still a finding a human has to see, so the run is not
    // reported healthy even though a different task dispatched successfully.
    expect(res.code).toBe(3);
  }, 300_000);

  it("the refusal record and status carry ids and counts, never order text", async () => {
    setComments([
      declarerOrder({ extra: "SECRET_SCOPE_TEXT" }),
      declarerOrder({ id: DECLARER_ID + 1, createdAt: "2026-09-15T07:10:00Z", extra: "OTHER_SECRET_TEXT" })
    ]);

    await runWorker();

    const rec = record(DECLARER);
    expect(rec.order_authority_failure.candidate_comment_ids).toHaveLength(2);
    expect(JSON.stringify(rec)).not.toContain("SECRET_SCOPE_TEXT");
    expect(JSON.stringify(rec)).not.toContain("OTHER_SECRET_TEXT");
    const posted = postedComments(2).map((c) => c.body).join("\n");
    expect(posted).not.toContain("SECRET_SCOPE_TEXT");
    expect(posted).toContain(ORDER_AUTHORITY.AMBIGUOUS);
  }, 300_000);

  it("a refused task is reported ONCE and not re-diagnosed on the next run", async () => {
    setComments([
      declarerOrder(),
      declarerOrder({ id: DECLARER_ID + 1, createdAt: "2026-09-15T07:10:00Z", extra: "SECOND ORDER." })
    ]);
    await runWorker();
    const afterFirst = healthEvents().filter((e) => e.reason === "architect_order_authority_inadmissible").length;

    await runWorker();

    expect(healthEvents().filter((e) => e.reason === "architect_order_authority_inadmissible").length)
      .toBe(afterFirst);
    expect(record(DECLARER).status).toBe(TASK_STATUS.BLOCKED);
  }, 300_000);
});

/* ==========================================================================
 * 3. POSITIVE CONTROLS - THE CAPABILITY IS NOT LOST TO THE FIX
 * ========================================================================== */

describe("D-151: a complete snapshot with one admissible order works exactly as before", () => {
  it("dispatches exactly the bound bytes of its one order", async () => {
    const order = declarerOrder();
    setComments([order]);

    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1"
    });

    expect(res.code).toBe(0);
    expect(dispatched()).toEqual([DECLARER]);
    // The prompt carries the order body verbatim and nothing else claiming to be
    // an order - D-150's boundary, unchanged.
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toContain(order.body);
    const rec = record(DECLARER);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.architect_order.comment_id).toBe(String(DECLARER_ID));
    expect(rec.architect_order.body_sha256).toBe(orderBodyDigest(order.body).sha256);
  }, 300_000);

  it("a provably identical overlapping-page copy creates no false ambiguity", async () => {
    const order = declarerOrder();
    setComments([order, { ...order }]);

    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1"
    });

    expect(res.code).toBe(0);
    expect(dispatched()).toEqual([DECLARER]);
    expect(authorityRefusal(DECLARER)).toBeNull();
  }, 300_000);

  it("an ADMISSIBLE fresh order supersedes an older task, with comment-id AND digest evidence", async () => {
    const declaring = declarerOrder({ supersedes: VICTIM });
    setComments([victimOrder(), declaring]);
    seedVictim();

    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1"
    });

    expect(res.code).toBe(0);
    const rec = record(VICTIM);
    expect(rec.status).toBe(TASK_STATUS.SUPERSEDED);
    expect(rec.superseded_by).toBe(DECLARER);
    expect(rec.superseded_basis).toBe(SUPERSESSION_BASIS.EXPLICIT_DECLARATION);
    expect(rec.superseded_declared_by_comment_id).toBe(DECLARER_ID);
    // D-151: the retirement is tied to the exact BYTES that ordered it, not just
    // to a comment id that could since have been edited.
    expect(rec.superseded_declarations).toHaveLength(1);
    expect(rec.superseded_declarations[0]).toMatchObject({
      task_id: DECLARER,
      comment_id: String(DECLARER_ID),
      created_at: "2026-09-15T07:00:00Z",
      body_sha256: orderBodyDigest(declaring.body).sha256
    });
    expect(rec.superseded_snapshot_complete).toBe(true);
    // The declaring task itself is what ran.
    expect(dispatched()).toEqual([DECLARER]);
  }, 300_000);

  it("an OLDER admissible declaration still cannot retire a NEWER task", async () => {
    // Directionality is proven from the two ADMITTED orders' own timestamps.
    const backwards = task({
      taskId: "D151-OLD-DECLARER-20260915-D",
      id: 5677000003,
      createdAt: "2026-09-15T05:00:00Z",
      supersedes: VICTIM
    });
    setComments([backwards, victimOrder()]);
    seedVictim({ next_eligible_at: new Date(Date.now() + 60 * 60_000).toISOString() });
    const victimBefore = JSON.stringify(record(VICTIM));

    await runWorker("report", { JARVIS_FAKE_CLAUDE_MUTATE: "tracked", JARVIS_FAKE_CLAUDE_COMMIT: "1" });

    // The victim is NEWER than the declaration, so the declaration is void - and
    // the victim's record is untouched by it.
    expect(JSON.stringify(record(VICTIM))).toBe(victimBefore);
    expect(record(VICTIM).status).toBe(TASK_STATUS.FAILED_RETRYABLE);
    expect(healthEvents().filter((e) => e.reason === "superseded_by_newer_completed_task")).toEqual([]);
  }, 300_000);
});

/* ==========================================================================
 * 4. THE DRY RUN SHOWS THE SAME TRUTH, WITHOUT MUTATING ANYTHING
 * ========================================================================== */

describe("D-151: the dry run previews snapshot, verdicts and supersession safely", () => {
  const dryRun = () => new Promise((r) => {
    const child = spawn(process.execPath, [WORKER, "run", "--dry-run"], {
      env: {
        ...process.env,
        JARVIS_WORKER_CONFIG: configPath,
        JARVIS_WORKER_GH: FAKE_GH,
        JARVIS_FAKE_GH_DIR: ghDir,
        JARVIS_FAKE_GH_AUTHOR: TRUSTED,
        JARVIS_FAKE_CLAUDE_DIR: claudeDir
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => r({ code, out }));
  });

  it("shows snapshot completeness, EVERY order's verdict, and would_dispatch", async () => {
    setComments([
      victimOrder(),
      declarerOrder({ supersedes: VICTIM }),
      task({ taskId: "D151-BAD-20260915-E", id: 5677000004, createdAt: "2026-09-15T07:30:00Z", updatedAt: "2026-09-15T08:00:00Z" })
    ]);
    seedVictim();
    const before = stateBytes();

    const { code, out } = await dryRun();
    const json = JSON.parse(out);

    expect(code).toBe(0);
    expect(json.snapshot_usable).toBe(true);
    expect(json.control_comments_complete).toBe(true);
    expect(json.order_authority).toHaveLength(3);
    const bad = json.order_authority.find((o) => o.task_id === "D151-BAD-20260915-E");
    expect(bad).toMatchObject({ admissible: false, reason: ORDER_AUTHORITY.EDITED });
    expect(json.inadmissible_authority).toEqual(["D151-BAD-20260915-E"]);
    expect(json.next_candidate_order_authority.would_dispatch).toBe(true);
    // And it changed nothing.
    expect(json.wrote_anything).toBe(false);
    expect(stateBytes()).toEqual(before);
    expect(dispatched()).toEqual([]);
  }, 300_000);

  it("shows a proposed supersession as ADMISSIBLE, with its declaring id and digest", async () => {
    const declaring = declarerOrder({ supersedes: VICTIM });
    setComments([victimOrder(), declaring]);
    seedVictim();
    const before = stateBytes();

    const { out } = await dryRun();
    const json = JSON.parse(out);

    expect(json.supersession_preview).toHaveLength(1);
    expect(json.supersession_preview[0]).toMatchObject({
      victim_task_id: VICTIM,
      declared_by_task_id: DECLARER,
      admissible: true,
      refused_reason: null,
      declaring_comment_id: String(DECLARER_ID)
    });
    expect(json.supersession_preview[0].declaring_order_digest)
      .toBe(`sha256:${orderBodyDigest(declaring.body).sha256.slice(0, 12)}`);
    expect(json.would_retire_superseded).toEqual([VICTIM]);
    // A PREVIEW of a destructive decision mutates nothing.
    expect(stateBytes()).toEqual(before);
    expect(record(VICTIM).status).toBe(TASK_STATUS.FAILED_RETRYABLE);
  }, 300_000);

  it("an unproven read makes the dry run report a held cycle, not a queue", async () => {
    setComments([victimOrder(), declarerOrder({ supersedes: VICTIM })]);
    seedVictim();
    setFailures({ commentsTruncated: true });
    const before = stateBytes();

    const { code, out } = await dryRun();
    const json = JSON.parse(out);

    expect(code).toBe(4);
    expect(json.snapshot_usable).toBe(false);
    expect(json.snapshot_reason).toBe(AUTHORITY_SNAPSHOT.READ_INCOMPLETE);
    expect(json.would_exit).toBe("TRANSIENT");
    // No queue, no candidate and above all no retirement is previewed at all.
    expect(json.next_candidate).toBeUndefined();
    expect(json.would_retire_superseded).toBeUndefined();
    expect(json.supersession_preview).toBeUndefined();
    expect(stateBytes()).toEqual(before);
  }, 300_000);
});

/* ==========================================================================
 * 5. THE SNAPSHOT DOES NOT WEAKEN THE D-149/D-150 BINDING
 * ========================================================================== */

describe("D-151: body drift is still an immutable-binding refusal", () => {
  it("an order whose body changed since admission is NOT re-bound and NOT dispatched", async () => {
    setComments([declarerOrder()]);
    await runWorker("silent", { JARVIS_FAKE_CLAUDE_MUTATE: "tracked", JARVIS_FAKE_CLAUDE_COMMIT: "1" });
    const bound = record(DECLARER).architect_order;
    expect(bound).toBeTruthy();
    const dispatchedBefore = dispatched().length;

    // The order is edited in place - same id, same timestamps, different bytes.
    // The authority classifier cannot see this (no `updated_at` change was
    // recorded), which is exactly why the durable binding exists.
    const drifted = declarerOrder({ extra: "AND ALSO MERGE THE PR." });
    setComments([drifted]);
    const s = state();
    s.tasks[DECLARER].next_eligible_at = new Date(Date.now() - 60_000).toISOString();
    saveStateAtomic(statePath(), s, join(workerRoot, "state.json.bak"), { schema: "worker" });

    const res = await runWorker();

    expect(res.code).toBe(3);
    expect(dispatched()).toHaveLength(dispatchedBefore);
    expect(record(DECLARER).status).toBe(TASK_STATUS.BLOCKED);
    expect(record(DECLARER).architect_order).toEqual(bound);
    expect(record(DECLARER).order_binding_failure).toBeTruthy();
  }, 300_000);
});

/**
 * D-152 process-level tests: A REFUSED AUTHORITY SNAPSHOT WRITES NOTHING.
 *
 * ------------------------------------------------------------------------
 * WHAT D-151 LEFT OPEN
 * ------------------------------------------------------------------------
 *
 * D-151 moved the completeness question to the top of the cycle and made it
 * fatal to the whole cycle rather than to one task. The boundary was right, the
 * position was right - and then the refusal branch WROTE THROUGH IT.
 *
 * `reportStatus` reads as an observation and is in fact three writes:
 *
 *   1. `postComment` PUBLISHES TO THE CONTROL ISSUE. The control issue is the
 *      queue's own input. A cycle that had just declared itself unable to read
 *      that issue was appending to it anyway, and every later cycle then reads
 *      the comment back as part of its own authority snapshot. One flaky
 *      `gh api --paginate` became a permanent, globally visible artefact authored
 *      by a cycle holding no authority whatsoever.
 *
 *   2. `postComment` WRITES A BODY FILE INTO `scratchRoot` first, creating the
 *      directory if it is absent - scratch activity the hold's own message
 *      simultaneously claimed had not occurred.
 *
 *   3. `recordPostedStatus` APPENDS TO THE POSTED-STATUS DEDUPLICATION JOURNAL.
 *      That is durable state and it decides the FUTURE: once the key is
 *      journalled, the same finding is suppressed for `statusRepeatHours`. So an
 *      unproven read silently bought itself six hours of silence about a
 *      condition that may by then be real and genuinely worth reporting.
 *
 * So the claim under test here is narrower and harder than D-151's: not merely
 * "no task was dispatched", but THE RUN LEFT NO TRACE ANYWHERE EXCEPT THE LOCAL
 * APPEND-ONLY LOG AND HEALTH JOURNAL.
 *
 * ------------------------------------------------------------------------
 * HOW IT IS PROVED
 * ------------------------------------------------------------------------
 *
 * A claim about effects that did not occur can only be checked against the
 * things that would exist if it were false. So every case below:
 *
 *   - drives the REAL `worker.mjs run` entrypoint as a real OS process, over a
 *     real git repository, with only `gh` and the Claude CLI faked;
 *   - PRE-SEEDS every durable surface the refusal must not touch - worker state,
 *     the state backup, the posted-status journal, a task worktree with real
 *     contents and a claim file - and then asserts each is BYTE-IDENTICAL;
 *   - takes a full recursive digest of the worker root before and after and
 *     asserts the ONLY paths that changed are the permitted append-only ones,
 *     and that each of those GREW (old bytes still an exact prefix);
 *   - reads `fake-gh`'s `api.log`, which records every invocation in order, and
 *     asserts zero comment POSTs, zero review calls and zero transition reads.
 *
 * Every negative runs with everything else PERFECT - a clean repository, a real
 * two-parent merge on the remote, all required checks green. If a run refuses, it
 * is the snapshot gate and nothing else.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { loadState, saveStateAtomic, TASK_STATUS } from "../lib/state.mjs";
import { claimFilePath, taskWorktreePath } from "../lib/worktree.mjs";
import { AUTHORITY_SNAPSHOT } from "../lib/authority-snapshot.mjs";
import { orderBodyDigest } from "../lib/order-binding.mjs";
import { statusKey } from "../lib/reconcile.mjs";
import { createRepo, git, head, treeOf, parentsOf, statusLines, syntheticMerge } from "./fixtures/real-git-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "worker.mjs");
const FAKE_GH = join(HERE, "fixtures", "fake-gh.mjs");
const FAKE_CLAUDE = join(HERE, "fixtures", "fake-claude.mjs");

const TRUSTED = "tsworkflow";
/** A pre-existing, non-terminal task. Every refusal must leave it exactly alone. */
const SEEDED = "D152-SEEDED-TASK-20260915-A";
/** The order in the control issue the refused read is nominally about. */
const PENDING = "D152-PENDING-ORDER-20260915-B";
const SEEDED_ID = 5678000001;
const PENDING_ID = 5678000002;
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-d152-"));
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
  writeFileSync(join(ghDir, "fail.json"), JSON.stringify({}), "utf8");
  setComments([]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/* ---------------- the control plane ---------------- */

function task({ taskId, id, createdAt, supersedes = null, extra = "" }) {
  const body = [
    "ARCHITECT_TASK",
    `TASK_ID=${taskId}`,
    `EXPECTED_HEAD_SHA=${prHead}`,
    supersedes ? `SUPERSEDES=${supersedes}` : "",
    "ARCHITECT_MERGE_APPROVED=false",
    "MERGE_AUTHORIZED=false",
    extra,
    "Do some ordinary implementation work."
  ].filter(Boolean).join("\n");
  return {
    id,
    created_at: createdAt,
    updated_at: createdAt,
    author_association: "OWNER",
    user: { login: TRUSTED },
    body
  };
}

const seededOrder = (over = {}) =>
  task({ taskId: SEEDED, id: SEEDED_ID, createdAt: "2026-09-15T06:00:00Z", ...over });
const pendingOrder = (over = {}) =>
  task({ taskId: PENDING, id: PENDING_ID, createdAt: "2026-09-15T07:00:00Z", ...over });

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

/* ---------------- reading what happened ---------------- */

const statePath = () => join(workerRoot, "state.json");
const backupPath = () => join(workerRoot, "state.json.bak");
const postedStatusPath = () => join(workerRoot, "logs", "posted-status.jsonl");
const state = () => loadState(statePath(), backupPath(), { schema: "worker" }).state;
const record = (id) => state()?.tasks?.[id] ?? null;
const wt = (taskId) => taskWorktreePath(worktreeRoot, taskId);

const bytes = (p) => (existsSync(p) ? readFileSync(p) : null);

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

/** Every `gh` invocation this run made, in order. */
function apiCalls() {
  const path = join(ghDir, "api.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

/** A comment POST is the only shape `postComment` can take: `-F body=@<file>`. */
const commentPosts = () => apiCalls().filter((l) => l.includes("body=@"));
/** PR review submissions - never legitimate from this worker at all. */
const reviewCalls = () => apiCalls().filter((l) => /\/reviews\b/.test(l));
/** PR merge-state, commit and check-run reads: the three transition lookups. */
const transitionReads = () =>
  apiCalls().filter((l) => /\/commits\//.test(l) || /merged:/.test(l));

const controlComments = () => JSON.parse(readFileSync(join(ghDir, "comments.json"), "utf8"));

/** The health event the snapshot gate emits, or `null`. */
const snapshotHold = () =>
  healthEvents().filter((e) => e.reason === "control_authority_snapshot_unusable").at(-1) ?? null;

/* ---------------- byte-level surfaces ---------------- */

/**
 * A full recursive digest of a directory: every file path mapped to the sha256
 * of its bytes.
 *
 * This is what makes "only the permitted evidence changed" checkable as a
 * statement about the WHOLE worker root rather than about the handful of files
 * someone remembered to assert on. A new durable write introduced later shows up
 * here as an unexpected changed path, with no test needing to anticipate it.
 */
function digestTree(root) {
  const out = {};
  if (!existsSync(root)) return out;
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        out[relative(root, child).split(sep).join("/")] =
          createHash("sha256").update(readFileSync(child)).digest("hex");
      }
    }
  };
  walk(root);
  return out;
}

/** The repository's observable state: HEAD, working tree, and any fetch trace. */
function repoState() {
  return {
    head: head(repoPath),
    status: statusLines(repoPath),
    // A `git fetch` writes this file. Its absence is positive evidence none ran.
    fetchHead: existsSync(join(repoPath, ".git", "FETCH_HEAD")),
    branches: git(repoPath, ["for-each-ref", "--format=%(refname) %(objectname)"])
  };
}

/**
 * The permitted append-only evidence surfaces, relative to the worker root.
 *
 * These and ONLY these may differ across a refused cycle, and each may only
 * GROW: the bytes that were there before must still be an exact prefix.
 */
const APPEND_ONLY = [
  "logs/health.jsonl",
  `logs/worker-${new Date().toISOString().slice(0, 10)}.log`
];

/**
 * THE LOCK LEDGER, which is permitted but is NOT evidence.
 *
 * `<lockFile>.d/<generation>.claim` is the worker's mutual-exclusion ledger, and
 * it is append-only by construction: acquiring appends `maxGeneration + 1`, and
 * no existing claim is ever rewritten. It is taken in `cmdRun` BEFORE `runOwned`
 * is entered at all - so it is not something the refusal branch does, and it is
 * not a decision: it records that a process held exclusive access, never what
 * that process concluded.
 *
 * It is listed explicitly rather than filtered silently, and the assertion below
 * is deliberately stricter than "ignore it": a refused cycle may APPEND a new
 * generation, and may not modify or remove an existing one.
 */
const LOCK_LEDGER = /^\.worker\.lock\.d\/\d{12}\.claim$/;

const isPermittedPath = (p) => APPEND_ONLY.includes(p) || LOCK_LEDGER.test(p);

/**
 * THE FULL "THIS REFUSAL WROTE NOTHING" ASSERTION.
 *
 * `before` is everything captured immediately prior to the run.
 */
function expectZeroWrite(before) {
  /* --- 1. no GitHub write of any kind --------------------------------- */
  expect(commentPosts()).toEqual([]);
  expect(reviewCalls()).toEqual([]);
  expect(transitionReads()).toEqual([]);
  // The control issue itself is byte-identical: nothing was appended to the very
  // thing this cycle said it could not read.
  expect(controlComments()).toEqual(before.controlComments);

  /* --- 2. no prompt, no child ----------------------------------------- */
  expect(dispatched()).toEqual([]);
  expect(prompts()).toEqual([]);

  /* --- 3. no repository or worktree activity -------------------------- */
  expect(repoState()).toEqual(before.repo);
  expect(existsSync(wt(PENDING))).toBe(false);
  expect(existsSync(claimFilePath(worktreeRoot, PENDING))).toBe(false);

  /* --- 4. every pre-seeded durable surface byte-identical -------------- */
  expect(bytes(statePath())).toEqual(before.state);
  expect(bytes(backupPath())).toEqual(before.backup);
  expect(bytes(postedStatusPath())).toEqual(before.postedStatus);
  expect(bytes(claimFilePath(worktreeRoot, SEEDED))).toEqual(before.claim);
  expect(bytes(join(wt(SEEDED), "work-in-progress.txt"))).toEqual(before.worktreeFile);

  /* --- 5. ONLY the permitted append-only evidence changed -------------- */
  const after = digestTree(workerRoot);
  const changed = [
    ...Object.keys(after).filter((p) => after[p] !== before.tree[p]),
    ...Object.keys(before.tree).filter((p) => !(p in after))
  ].sort();
  expect(changed.filter((p) => !isPermittedPath(p))).toEqual([]);
  // The lock ledger may only be APPENDED to: no pre-existing claim may be
  // rewritten, and none may disappear.
  for (const p of Object.keys(before.tree).filter((p) => LOCK_LEDGER.test(p))) {
    expect(after[p]).toBe(before.tree[p]);
  }
  // ... and each permitted evidence surface only GREW.
  for (const p of APPEND_ONLY) {
    const old = before.rawAppendOnly[p];
    if (old === null) continue;
    const now = bytes(join(workerRoot, p));
    expect(now).not.toBeNull();
    expect(now.subarray(0, old.length)).toEqual(old);
  }

  /* --- 6. the evidence names the refusal and does not claim a post ----- */
  const hold = snapshotHold();
  expect(hold).not.toBeNull();
  expect(hold.status_comment_posted).toBe(false);
  expect(hold.posted_status_recorded).toBe(false);
  expect(hold.durable_state_written).toBe(false);
  expect(hold.held).toBe(true);
  expect(hold.exit).toBe(4);
}

/** Capture every surface `expectZeroWrite` compares against. */
function captureBefore() {
  const rawAppendOnly = {};
  for (const p of APPEND_ONLY) rawAppendOnly[p] = bytes(join(workerRoot, p));
  return {
    tree: digestTree(workerRoot),
    rawAppendOnly,
    state: bytes(statePath()),
    backup: bytes(backupPath()),
    postedStatus: bytes(postedStatusPath()),
    claim: bytes(claimFilePath(worktreeRoot, SEEDED)),
    worktreeFile: bytes(join(wt(SEEDED), "work-in-progress.txt")),
    controlComments: controlComments(),
    repo: repoState()
  };
}

/* ---------------- pre-seeding the durable surfaces ---------------- */

/** A real, non-terminal, immediately eligible task, plus its state backup. */
function seedState(patch = {}) {
  const s = state() ?? { schema_version: 2, tasks: {} };
  s.tasks = s.tasks ?? {};
  s.tasks[SEEDED] = {
    task_id: SEEDED,
    status: TASK_STATUS.FAILED_RETRYABLE,
    attempts: 1,
    first_dispatch_at: "2026-09-15T06:05:00Z",
    last_dispatch_at: "2026-09-15T06:05:00Z",
    next_eligible_at: new Date(Date.now() - 60_000).toISOString(),
    successful: false,
    last_failure_reason: "exit_0_without_matching_report",
    architect_order: {
      binding_version: 1,
      task_id: SEEDED,
      comment_id: String(SEEDED_ID),
      created_at: "2026-09-15T06:00:00Z",
      body_sha256: orderBodyDigest(seededOrder().body).sha256,
      body_bytes: orderBodyDigest(seededOrder().body).bytes,
      bound_at: "2026-09-15T06:05:00Z"
    },
    ...patch
  };
  saveStateAtomic(statePath(), s, backupPath(), { schema: "worker" });
  // saveStateAtomic only refreshes the backup on a later write; make sure BOTH
  // files exist before the run, so "backup unchanged" is a real assertion rather
  // than null === null.
  writeFileSync(backupPath(), readFileSync(statePath()));
}

/**
 * The seeded task's isolated worktree, with UNCOMMITTED WORK in it, and its
 * claim file.
 *
 * Uncommitted work is the case that matters: it is what a resume must find
 * intact, and it is what a careless cleanup path would destroy. Written as plain
 * files rather than a real linked worktree deliberately - the refusal must not
 * reach this path at all, so there is nothing for git semantics to contribute.
 */
function seedWorktree() {
  mkdirSync(wt(SEEDED), { recursive: true });
  writeFileSync(join(wt(SEEDED), "work-in-progress.txt"),
    "half-finished work an interrupted attempt left behind\n", "utf8");
  mkdirSync(dirname(claimFilePath(worktreeRoot, SEEDED)), { recursive: true });
  writeFileSync(claimFilePath(worktreeRoot, SEEDED), JSON.stringify({
    task_id: SEEDED,
    attempt_id: "seeded-attempt-0000",
    claimed_at: "2026-09-15T06:05:00Z",
    worktree: wt(SEEDED)
  }, null, 2), "utf8");
}

/** A posted-status journal with an existing, unrelated entry in it. */
function seedPostedStatus() {
  mkdirSync(dirname(postedStatusPath()), { recursive: true });
  writeFileSync(postedStatusPath(), JSON.stringify({
    key: statusKey({ taskId: SEEDED, phase: "dispatch", reason: "some_earlier_finding" }),
    ts: "2026-09-15T06:10:00Z"
  }) + "\n", "utf8");
}

/** Everything, together. The state a real host is actually in. */
function seedEverything(patch = {}) {
  seedState(patch);
  seedWorktree();
  seedPostedStatus();
}

/* ==========================================================================
 * 1. EVERY REFUSAL IS A ZERO-WRITE DECISION
 * ========================================================================== */

describe("D-152: a refused authority snapshot writes nothing durable or remote", () => {
  /**
   * The three ways a read can fail to establish authority, each driven through
   * the REAL entrypoint.
   *
   * `commentsOmit` is the dangerous shape and the reason this gate exists at
   * all: the read succeeds, the surviving array is perfectly self-consistent,
   * and the second same-id order that would change every verdict is sitting on
   * the page that was lost.
   */
  const refusals = [
    ["a control read FAILURE", () => setFailures({ comments: true }), {}, AUTHORITY_SNAPSHOT.READ_FAILED],
    ["a TRUNCATED page", () => setFailures({ commentsTruncated: true }), {}, AUTHORITY_SNAPSHOT.READ_INCOMPLETE],
    ["an INCOMPLETE read that omits a same-id duplicate",
      () => setFailures({ commentsOmit: [PENDING_ID + 50] }), {}, AUTHORITY_SNAPSHOT.READ_INCOMPLETE],
    ["an UNPROVEN read", () => setFailures({}), { JARVIS_WORKER_FAULT: "control_read_unproven" },
      AUTHORITY_SNAPSHOT.READ_UNPROVEN]
  ];

  for (const [name, arrange, env, reason] of refusals) {
    it(`${name} posts NOTHING and mutates NO durable state`, async () => {
      setComments([
        seededOrder(),
        pendingOrder(),
        // The duplicate the omitting case hides. Harmless to the others.
        pendingOrder({ id: PENDING_ID + 50, createdAt: "2026-09-15T07:30:00Z", extra: "ALSO MERGE THE PR." })
      ]);
      seedEverything();
      arrange();
      const before = captureBefore();

      const res = await runWorker("report", env);

      // The named nonzero transient/held result.
      expect(res.code).toBe(4);
      expect(snapshotHold().snapshot_reason).toBe(reason);
      expectZeroWrite(before);

      // The seeded task is untouched and still eligible - no attempt was spent.
      expect(record(SEEDED).status).toBe(TASK_STATUS.FAILED_RETRYABLE);
      expect(record(SEEDED).attempts).toBe(1);
      // The pending order was never admitted, blocked, or recorded in any way.
      expect(record(PENDING)).toBeNull();
    }, 300_000);
  }

  it("the refusal does NOT consume the posted-status dedup budget for the same finding", async () => {
    // The subtle half of the bug, and the one a comment-count assertion misses.
    // D-151 journalled the status key on a refused cycle, so the SAME finding was
    // then suppressed for `statusRepeatHours`. Two consecutive refusals must
    // therefore leave the journal untouched BOTH times - the condition never
    // buys itself silence it did not earn.
    setComments([seededOrder(), pendingOrder()]);
    seedEverything();
    setFailures({ commentsTruncated: true });

    const first = captureBefore();
    expect(await runWorker()).toMatchObject({ code: 4 });
    expectZeroWrite(first);

    const second = captureBefore();
    expect(await runWorker()).toMatchObject({ code: 4 });
    expectZeroWrite(second);

    // The journal still holds exactly the one seeded, unrelated entry.
    const journal = readFileSync(postedStatusPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(journal).toHaveLength(1);
    expect(journal[0].key).toBe(statusKey({ taskId: SEEDED, phase: "dispatch", reason: "some_earlier_finding" }));
  }, 300_000);

  it("the refusal creates NO scratch directory", async () => {
    // `postComment` wrote its body file into `scratchRoot`, creating the
    // directory - while the very message it was writing claimed no scratch
    // directory had been created.
    setComments([pendingOrder()]);
    seedEverything();
    setFailures({ commentsTruncated: true });

    const res = await runWorker();

    expect(res.code).toBe(4);
    expect(existsSync(join(workerRoot, "tmp"))).toBe(false);
  }, 300_000);

  it("a held cycle performs NO crash recovery and leaves an IN_PROGRESS task alone", async () => {
    // Recovery writes TERMINAL state and used to run before completeness was
    // consulted. An abandoned task must survive a bad read untouched.
    setComments([seededOrder()]);
    seedEverything({
      status: TASK_STATUS.IN_PROGRESS,
      child_identity: { pid: 999999, started_at: "2026-09-15T06:05:00Z", command: "node" },
      last_dispatch_at: new Date(Date.now() - 6 * 60 * 60_000).toISOString()
    });
    setFailures({ commentsTruncated: true });
    const before = captureBefore();

    const res = await runWorker();

    expect(res.code).toBe(4);
    expectZeroWrite(before);
    expect(record(SEEDED).status).toBe(TASK_STATUS.IN_PROGRESS);
    expect(healthEvents().filter((e) => e.reason === "recovered_abandoned_in_progress")).toEqual([]);
  }, 300_000);

  it("the local log states the refusal and the held exit WITHOUT claiming a post", async () => {
    // Observability is the whole point of keeping anything at all here: an
    // operator must be able to see that the worker held, why, and that it
    // deliberately said nothing on GitHub.
    setComments([pendingOrder()]);
    seedEverything();
    setFailures({ commentsTruncated: true });

    const res = await runWorker();

    expect(res.code).toBe(4);
    const logFile = join(workerRoot, "logs", `worker-${new Date().toISOString().slice(0, 10)}.log`);
    const text = readFileSync(logFile, "utf8");
    expect(text).toContain(AUTHORITY_SNAPSHOT.READ_INCOMPLETE);
    expect(text).toContain("HOLDING the whole cycle");
    expect(text).toContain("NO GitHub comment was posted");
    expect(text).toContain("EXIT: 4 (TRANSIENT)");
    // It must never claim the thing it no longer does.
    expect(text).not.toContain("Posted status comment");
  }, 300_000);
});

/* ==========================================================================
 * 2. THE COMPLETE-SNAPSHOT PATH IS UNCHANGED
 * ========================================================================== */

describe("D-152: a proven complete snapshot still decides and still reports", () => {
  it("a complete read dispatches normally and completes the task", async () => {
    // The other half of "the fault is in the read": a dropped page must cost
    // nothing permanent, or one flaky request is a denial of service.
    setComments([pendingOrder()]);
    setFailures({ commentsTruncated: true });
    expect(await runWorker()).toMatchObject({ code: 4 });
    expect(record(PENDING)).toBeNull();

    setFailures({});
    const res = await runWorker("report", {
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1"
    });

    expect(res.code).toBe(0);
    expect(dispatched()).toEqual([PENDING]);
    expect(record(PENDING).status).toBe(TASK_STATUS.COMPLETED);
  }, 300_000);

  it("legitimate status posting after a COMPLETE read still works and still dedups", async () => {
    // The regression guard in the other direction. D-152 removes posting from the
    // REFUSED branch only; an ordinary finding on a PROVEN read must still reach
    // the control issue and must still journal its dedup key.
    //
    // An EDITED order is the simplest such finding: the read is complete, the
    // verdict is about the ORDER, and the worker is entitled to say so.
    const edited = { ...pendingOrder(), updated_at: "2026-09-15T09:00:00Z" };
    setComments([edited]);
    seedPostedStatus();
    const commentsBefore = controlComments().length;

    const res = await runWorker();

    expect(res.code).toBe(3); // BLOCKED: the finding is about the order
    // It DID post, exactly once.
    expect(commentPosts()).toHaveLength(1);
    const posted = controlComments().slice(commentsBefore);
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toContain("CLAUDE_WORKER_STATUS");
    expect(posted[0].body).toContain("PHASE=admission");
    // ... and it DID journal the dedup key, on top of the seeded entry.
    const journal = readFileSync(postedStatusPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(journal).toHaveLength(2);
    expect(journal[1].key).toContain(PENDING);
  }, 300_000);

  it("a refused cycle does not suppress the NEXT cycle's legitimate report", async () => {
    // The end-to-end consequence of not journalling on refusal: the finding the
    // refused cycle would have reported is still fully reportable once a real
    // read arrives.
    const edited = { ...pendingOrder(), updated_at: "2026-09-15T09:00:00Z" };
    setComments([edited]);
    seedPostedStatus();

    setFailures({ commentsTruncated: true });
    expect(await runWorker()).toMatchObject({ code: 4 });
    expect(commentPosts()).toEqual([]);

    setFailures({});
    const res = await runWorker();

    expect(res.code).toBe(3);
    // Not suppressed: the refusal bought no silence.
    expect(commentPosts()).toHaveLength(1);
    expect(controlComments().at(-1).body).toContain("CLAUDE_WORKER_STATUS");
  }, 300_000);
});

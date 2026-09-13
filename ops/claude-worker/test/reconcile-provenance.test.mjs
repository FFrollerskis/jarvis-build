/**
 * D-136 unit tests: deriving CURRENT commit provenance for a reconciliation
 * that is NOT backed by a live dispatch in this process.
 *
 * Real git, real linked worktrees, real claim files written by the production
 * `establishTaskWorktree`. The git side is deliberately not faked: the property
 * under test is whether the answer is TRUE OF THE FILESYSTEM - which directory,
 * which commits, whose trailers - and a fixture would only ever agree with
 * whatever the derivation concluded.
 *
 * The question being answered is the one the crash window leaves open. The
 * worker persists IN_PROGRESS, the child identity and the durable claim BEFORE
 * it spawns, and writes `commit_provenance` only at the post-dispatch checkpoint
 * AFTER the child exits. A parent killed in between leaves no verdict at all, so
 * the next run has to DERIVE one - it can neither inherit one nor, as D-135 did,
 * treat its absence as permission.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  COMMIT_PROVENANCE,
  RECONCILE_PROVENANCE,
  commitTrailerLines,
  deriveReconciliationProvenance,
  evaluateCompletionGate,
  reconciliationProvenanceForGate
} from "../lib/provenance.mjs";
import {
  CLAIM_STATE,
  claimFilePath,
  establishTaskWorktree,
  readClaim,
  taskWorktreePath,
  writeClaim
} from "../lib/worktree.mjs";
import { createRepo, foreignCommit, git, head } from "./fixtures/real-git-repo.mjs";

const TASK_ID = "D136-DERIVE-20260912-A";
const COMMENT_ID = 4242;
const SUCCESS_REPORT = { complete: true, successful: true, status: "COMPLETE", reportCommentId: 9 };

let dir;
let repoPath;
let worktreeRoot;
let baseline;
let cfg;
let comment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-d136-derive-"));
  repoPath = join(dir, "repo");
  worktreeRoot = join(dir, "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  ({ baseline } = createRepo(repoPath));
  cfg = {
    repoOwner: "tsworkflow",
    repoName: "jarvisbuild",
    controlIssue: 68,
    repoPath,
    worktreeRoot
  };
  comment = { id: COMMENT_ID, created_at: "2026-09-12T04:00:00Z", user: { login: "tsworkflow" } };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Establish the isolated context exactly as a dispatch would. */
function establish({ attempt = 1, attemptId = "attempt-id-one" } = {}) {
  const ws = establishTaskWorktree({
    cfg,
    taskId: TASK_ID,
    comment,
    worktreeRoot,
    baselineSha: baseline,
    baselineBranch: "main",
    attempt,
    attemptId,
    workerVersion: "test"
  });
  expect(ws.ok).toBe(true);
  return ws;
}

/** The task row a crashed parent leaves behind: dispatched, and NO verdict. */
function crashedTaskRow(extra = {}) {
  return {
    task_id: TASK_ID,
    status: "in_progress",
    attempts: 1,
    comment_id: COMMENT_ID,
    head_before: baseline,
    ...extra
  };
}

function wtPath() {
  return taskWorktreePath(worktreeRoot, TASK_ID);
}

function claimOf() {
  return readClaim(claimFilePath(worktreeRoot, TASK_ID)).claim;
}

function rewriteClaim(patch) {
  writeClaim(claimFilePath(worktreeRoot, TASK_ID), { ...claimOf(), ...patch });
}

/** A commit the CHILD would make: stamped with an attempt id from the claim. */
function stampedCommit(path, { attemptId, file = "child-work.txt", subject = "feat: the child's own work" }) {
  writeFileSync(join(path, file), `written by the child at ${new Date().toISOString()}\n`, "utf8");
  git(path, ["add", "--", file]);
  git(path, ["-c", "user.email=fake@example.invalid", "-c", "user.name=fake-claude", "commit", "-m",
    `${subject}\n\n${commitTrailerLines({ taskId: TASK_ID, attemptId }).join("\n")}\n`]);
  return head(path);
}

function derive(task = crashedTaskRow(), overrides = {}) {
  return deriveReconciliationProvenance({ cfg, taskId: TASK_ID, task, worktreeRoot, ...overrides });
}

/** A git runner that fails ONE specific query and passes everything else through. */
function runnerFailing(mustContainAll) {
  return (command, args, opts) => (mustContainAll.every((m) => args.includes(m))
    ? { status: 128, stdout: "", stderr: "fatal: injected failure", error: null }
    : spawnSync(command, args, opts));
}

function gateFor(provenance) {
  return evaluateCompletionGate({ completion: SUCCESS_REPORT, provenance });
}

/** ---------------- the POSITIVE controls ---------------- */

describe("D-136: a derivable, trustworthy range passes", () => {
  it("an UNCHANGED head is verified: there was never an authorship question", () => {
    establish();
    const { state, provenance } = derive();

    expect(state).toBe(RECONCILE_PROVENANCE.CLASSIFIED);
    expect(provenance.verdict).toBe(COMMIT_PROVENANCE.UNCHANGED);
    expect(provenance.verified).toBe(true);
    expect(provenance.head_now).toBe(baseline);
    expect(provenance.derived_for_reconciliation).toBe(true);
    expect(provenance.baseline_sha).toBe(baseline);
    // The per-attempt observation is READ and reported, but it is not the anchor.
    expect(provenance.recorded_head_before).toBe(baseline);
    expect(gateFor(provenance).held).toBe(false);
  });

  it("a FULLY trailer-attributed range is verified, and names the commits", () => {
    const ws = establish();
    const mine = stampedCommit(ws.path, { attemptId: "attempt-id-one" });

    const { state, provenance } = derive();

    expect(state).toBe(RECONCILE_PROVENANCE.CLASSIFIED);
    expect(provenance.verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(provenance.verified).toBe(true);
    expect(provenance.head_now).toBe(mine);
    expect(provenance.attributed_commits.map((c) => c.sha)).toEqual([mine]);
    expect(provenance.unattributed_commits).toEqual([]);
    expect(gateFor(provenance).held).toBe(false);
  });

  it("accepts a commit stamped by an EARLIER attempt of the same task", () => {
    // Attempt 1 commits, attempt 2 resumes. Both ids live in the same claim, so
    // the earlier attempt's work is still this task's own work.
    const first = establish({ attempt: 1, attemptId: "attempt-id-one" });
    const mine = stampedCommit(first.path, { attemptId: "attempt-id-one" });
    establish({ attempt: 2, attemptId: "attempt-id-two" });

    const { provenance } = derive(crashedTaskRow({ attempt_id: "attempt-id-two" }));
    expect(provenance.verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(provenance.verified).toBe(true);
    expect(provenance.attributed_commits.map((c) => c.sha)).toEqual([mine]);
  });
});

/** ---------------- the ADVERSARIAL cases ---------------- */

describe("D-136: an unaccountable range is refused", () => {
  it("a FOREIGN commit in the claimed worktree is unattributed and unverified", () => {
    const ws = establish();
    const foreign = foreignCommit(ws.path);

    const { provenance } = derive();

    expect(provenance.verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(provenance.verified).toBe(false);
    expect(provenance.unattributed_commits.map((c) => c.sha)).toEqual([foreign]);
    expect(gateFor(provenance).held).toBe(true);
  });

  it("a MIXED range is unverified as a whole - partial trust is not trust", () => {
    const ws = establish();
    stampedCommit(ws.path, { attemptId: "attempt-id-one" });
    const foreign = foreignCommit(ws.path);

    const { provenance } = derive();

    expect(provenance.verdict).toBe(COMMIT_PROVENANCE.PARTIAL);
    expect(provenance.verified).toBe(false);
    expect(provenance.unattributed_commits.map((c) => c.sha)).toEqual([foreign]);
    expect(gateFor(provenance).held).toBe(true);
  });

  it("a commit made WITHOUT the evidence trailers earns no trust either", () => {
    const ws = establish();
    writeFileSync(join(ws.path, "forgetful.txt"), "the child forgot its trailers\n", "utf8");
    git(ws.path, ["add", "-A"]);
    git(ws.path, ["-c", "user.email=fake@example.invalid", "-c", "user.name=fake-claude",
      "commit", "-m", "work with no evidence at all"]);

    const { provenance } = derive();
    expect(provenance.verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(provenance.verified).toBe(false);
  });

  it("a REWOUND ref is unverified, never merely 'changed'", () => {
    const ws = establish();
    stampedCommit(ws.path, { attemptId: "attempt-id-one" });
    // Replace the history so the current tip no longer descends from the claim's
    // baseline at all - the shape a reset or a force-checkout leaves behind.
    const root = git(ws.path, ["rev-list", "--max-parents=0", "HEAD"]).split(/\r?\n/)[0];
    git(ws.path, ["checkout", "--detach", root]);
    writeFileSync(join(ws.path, "rewritten.txt"), "replacement history\n", "utf8");
    git(ws.path, ["add", "-A"]);
    git(ws.path, ["-c", "user.email=x@y.invalid", "-c", "user.name=x",
      "commit", "--amend", "-m", "replaced root"]);

    const { provenance } = derive();
    expect(provenance.verified).toBe(false);
    expect([COMMIT_PROVENANCE.DIVERGED, COMMIT_PROVENANCE.UNKNOWN]).toContain(provenance.verdict);
    expect(gateFor(provenance).held).toBe(true);
  });
});

/** ---------------- every refusal is UNKNOWN, never "clean" ---------------- */

describe("D-136: a question that cannot be answered holds", () => {
  it("holds as UNKNOWN when NO durable claim exists at all", () => {
    // Nothing was ever established: no claim, no worktree, no attempt id.
    const { state, provenance } = derive();
    expect(state).toBe(RECONCILE_PROVENANCE.CLAIM_MISSING);
    expect(provenance.verdict).toBe(COMMIT_PROVENANCE.UNKNOWN);
    expect(provenance.verified).toBe(false);
    expect(provenance.reason).toMatch(/no claim file at/);
    expect(gateFor(provenance).held).toBe(true);
  });

  it("holds as UNKNOWN when the claim cannot be parsed", () => {
    establish();
    writeFileSync(claimFilePath(worktreeRoot, TASK_ID), "{ not json", "utf8");
    const { state, provenance } = derive();
    expect(state).toBe(RECONCILE_PROVENANCE.CLAIM_UNREADABLE);
    expect(provenance.verified).toBe(false);
  });

  it("holds as UNKNOWN when the claim binds a DIFFERENT task", () => {
    establish();
    rewriteClaim({ task_id: "SOME-OTHER-TASK" });
    const { state, provenance } = derive();
    expect(state).toBe(RECONCILE_PROVENANCE.CLAIM_FOREIGN);
    expect(provenance.verified).toBe(false);
  });

  it("holds as UNKNOWN when the claim names a different control comment", () => {
    // A re-used TASK_ID pointing at another trusted order is a different order,
    // and must not inherit either the context or its evidence.
    establish();
    const { state } = derive(crashedTaskRow({ comment_id: 999999 }));
    expect(state).toBe(RECONCILE_PROVENANCE.CLAIM_FOREIGN);
  });

  it("holds as UNKNOWN when the claim is not READY", () => {
    establish();
    rewriteClaim({ state: CLAIM_STATE.CREATING });
    expect(derive().state).toBe(RECONCILE_PROVENANCE.CLAIM_NOT_READY);
  });

  it("holds as UNKNOWN when the claim has no usable baseline", () => {
    establish();
    rewriteClaim({ baseline_sha: null });
    const { state, provenance } = derive();
    expect(state).toBe(RECONCILE_PROVENANCE.BASELINE_MISSING);
    expect(provenance.verified).toBe(false);
  });

  it("holds as UNKNOWN when no attempt id was ever recorded", () => {
    // Without an attempt id no commit could ever carry evidence binding it to
    // this task, so a verified answer would be structurally impossible to earn.
    const ws = establish();
    stampedCommit(ws.path, { attemptId: "attempt-id-one" });
    rewriteClaim({ attempts: [], first_attempt_id: null, latest_attempt_id: null });
    const { state, provenance } = derive(crashedTaskRow({ attempt_id: null }));
    expect(state).toBe(RECONCILE_PROVENANCE.ATTEMPT_IDS_MISSING);
    expect(provenance.verified).toBe(false);
  });

  it("holds as UNKNOWN when the claimed worktree directory is gone", () => {
    establish();
    git(repoPath, ["worktree", "remove", wtPath()]);
    const { state, provenance } = derive();
    expect(state).toBe(RECONCILE_PROVENANCE.WORKTREE_MISSING);
    expect(provenance.verified).toBe(false);
  });

  it("holds as UNKNOWN when git has no worktree registered at the claimed path", () => {
    establish();
    git(repoPath, ["worktree", "remove", wtPath()]);
    // Content is back at the path, but it is not a linked worktree any more, so
    // nothing there can be read as this task's isolated context.
    mkdirSync(wtPath(), { recursive: true });
    writeFileSync(join(wtPath(), "leftover.txt"), "not a worktree\n", "utf8");
    expect(derive().state).toBe(RECONCILE_PROVENANCE.WORKTREE_NOT_REGISTERED);
  });

  it("holds as UNKNOWN when the worktree topology cannot be read", () => {
    establish();
    const { state, provenance } = derive(crashedTaskRow(), { runner: runnerFailing(["worktree", "list"]) });
    expect(state).toBe(RECONCILE_PROVENANCE.WORKTREE_TOPOLOGY_UNKNOWN);
    expect(provenance.verified).toBe(false);
  });

  it("holds as UNKNOWN when the worktree HEAD cannot be read", () => {
    establish();
    const { state, provenance } = derive(crashedTaskRow(), { runner: runnerFailing(["rev-parse", "HEAD"]) });
    expect(state).toBe(RECONCILE_PROVENANCE.HEAD_UNREADABLE);
    expect(provenance.verified).toBe(false);
  });

  it("holds as UNKNOWN when the commit range itself cannot be read", () => {
    const ws = establish();
    stampedCommit(ws.path, { attemptId: "attempt-id-one" });
    const { provenance } = derive(crashedTaskRow(), { runner: runnerFailing(["log", "--reverse"]) });
    expect(provenance.verdict).toBe(COMMIT_PROVENANCE.UNKNOWN);
    expect(provenance.verified).toBe(false);
    expect(gateFor(provenance).held).toBe(true);
  });

  it("holds as UNKNOWN for an unsafe TASK_ID rather than touching the filesystem", () => {
    const { state, provenance } = deriveReconciliationProvenance({
      cfg, taskId: "../escape", task: crashedTaskRow(), worktreeRoot
    });
    expect(state).toBe(RECONCILE_PROVENANCE.UNSAFE_TASK_ID);
    expect(provenance.verified).toBe(false);
  });
});

/** ---------------- migration: absence never becomes trust ---------------- */

describe("D-136: legacy and stale records gain nothing from absence", () => {
  it("a legacy row with a raw head_after and no verdict gains NO trust from the absence", () => {
    // Exactly what a pre-D-134 worker persisted: two ref readings and nothing
    // else. The derivation ignores both and asks the repository instead.
    const ws = establish();
    const foreign = foreignCommit(ws.path);
    const legacy = {
      task_id: TASK_ID, status: "in_progress", attempts: 1, comment_id: COMMENT_ID,
      head_before: baseline, head_after: foreign
      // ...and no `commit_provenance` field at all.
    };

    const { provenance } = derive(legacy);
    expect(provenance.verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(provenance.verified).toBe(false);
    expect(gateFor(provenance).held).toBe(true);
  });

  it("a legacy row with no claim behind it is refused rather than waved through", () => {
    // The oldest shape of all: a task the pre-D-133 worker dispatched into the
    // shared checkout, so there is no isolated context to verify anything in.
    const { state, provenance } = derive({
      task_id: TASK_ID, status: "in_progress", attempts: 1,
      head_before: baseline, head_after: "9".repeat(40)
    });
    expect(state).toBe(RECONCILE_PROVENANCE.CLAIM_MISSING);
    expect(gateFor(provenance).held).toBe(true);
  });

  it("a stored VERIFIED verdict cannot launder a range the worktree no longer matches", () => {
    // The stored record was true about the tip it was computed on. Something
    // moved the ref afterwards, so a stale verified record buys nothing: the
    // derivation classifies the CURRENT range.
    const ws = establish();
    const mine = stampedCommit(ws.path, { attemptId: "attempt-id-one" });
    const foreign = foreignCommit(ws.path);

    const { provenance } = derive(crashedTaskRow({
      commit_provenance: {
        verdict: COMMIT_PROVENANCE.ATTRIBUTED, verified: true,
        head_before: baseline, head_after: mine,
        attributed_commits: [{ sha: mine }], unattributed_commits: [], unattributed_count: 0
      }
    }));

    expect(provenance.verdict).toBe(COMMIT_PROVENANCE.PARTIAL);
    expect(provenance.verified).toBe(false);
    expect(provenance.unattributed_commits.map((c) => c.sha)).toEqual([foreign]);
  });

  it("anchors at the CLAIM BASELINE, so an earlier attempt's foreign commit still counts", () => {
    // The LATEST attempt's `head_before` starts after the foreign commit, so
    // anchoring there would have hidden it. The claim's baseline covers every
    // commit that has ever appeared in that directory, across every attempt.
    const ws = establish({ attempt: 1, attemptId: "attempt-id-one" });
    const foreign = foreignCommit(ws.path);
    establish({ attempt: 2, attemptId: "attempt-id-two" });
    const mine = stampedCommit(ws.path, { attemptId: "attempt-id-two" });

    const { provenance } = derive(crashedTaskRow({ head_before: foreign, attempt_id: "attempt-id-two" }));

    expect(provenance.head_now).toBe(mine);
    expect(provenance.verdict).toBe(COMMIT_PROVENANCE.PARTIAL);
    expect(provenance.verified).toBe(false);
    expect(provenance.unattributed_commits.map((c) => c.sha)).toEqual([foreign]);
  });
});

/**
 * D-136: deriving a fresh verdict must not become a way to ERASE an old one.
 *
 * This is the D-135 protection the derivation would otherwise have walked
 * straight through. A task whose last attempt recorded `unattributed` can
 * present a perfectly tidy `unchanged` range now - the ref only has to have been
 * moved back - and a gate that looked only at the fresh answer would then retire
 * as a success exactly the completion the dispatch path had already refused.
 */
describe("D-136: the recorded verdict can only DOWNGRADE the derived one", () => {
  const FOREIGN = "b".repeat(40);
  const recordedUnverified = {
    verdict: COMMIT_PROVENANCE.UNATTRIBUTED,
    verified: false,
    unattributed_commits: [{ sha: FOREIGN, subject: "unrelated maintenance commit" }],
    unattributed_count: 1,
    reason: "no commit in the range carries this task's attempt evidence (1 unexplained)"
  };

  it("a recorded UNVERIFIED verdict holds even when the fresh look is clean", () => {
    establish();
    const { provenance: derived } = derive();
    expect(derived.verified).toBe(true); // the fresh look really is clean

    const combined = reconciliationProvenanceForGate({ stored: recordedUnverified, derived });

    expect(combined.verified).toBe(false);
    expect(combined.downgraded_by_recorded_verdict).toBe(true);
    expect(combined.verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(combined.recorded_verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    // The commit the EARLIER look could not account for travels with the record,
    // even though it is no longer reachable from the current tip.
    expect(combined.unattributed_commits.map((c) => c.sha)).toContain(FOREIGN);
    expect(combined.unattributed_count).toBe(1);
    expect(gateFor(combined).held).toBe(true);
  });

  it("a recorded UNVERIFIED verdict and a dirty fresh look report BOTH commits", () => {
    const ws = establish();
    const freshForeign = foreignCommit(ws.path);
    const { provenance: derived } = derive();

    const combined = reconciliationProvenanceForGate({ stored: recordedUnverified, derived });

    expect(combined.verified).toBe(false);
    // The CURRENT finding names the current verdict; the older one is carried.
    expect(combined.verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(combined.unattributed_commits.map((c) => c.sha)).toEqual([freshForeign, FOREIGN]);
    expect(combined.unattributed_count).toBe(2);
  });

  it("a recorded VERIFIED verdict buys nothing: the fresh look must stand alone", () => {
    const ws = establish();
    const foreign = foreignCommit(ws.path);
    const { provenance: derived } = derive();

    const combined = reconciliationProvenanceForGate({
      stored: { verdict: COMMIT_PROVENANCE.ATTRIBUTED, verified: true, unattributed_commits: [] },
      derived
    });

    expect(combined.verified).toBe(false);
    expect(combined.verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(combined.unattributed_commits.map((c) => c.sha)).toEqual([foreign]);
    expect(combined.downgraded_by_recorded_verdict).toBeUndefined();
  });

  it("both verified is the ONLY combination that passes", () => {
    establish();
    const { provenance: derived } = derive();
    const combined = reconciliationProvenanceForGate({
      stored: { verdict: COMMIT_PROVENANCE.ATTRIBUTED, verified: true },
      derived
    });
    expect(combined.verified).toBe(true);
    expect(gateFor(combined).held).toBe(false);
  });

  it("no stored record at all leaves the derived record exactly as it is", () => {
    establish();
    const { provenance: derived } = derive();
    expect(reconciliationProvenanceForGate({ stored: null, derived })).toBe(derived);
  });

  it("a malformed or half-verified stored record downgrades rather than passing", () => {
    establish();
    const { provenance: derived } = derive();
    for (const stored of [
      { verdict: COMMIT_PROVENANCE.ATTRIBUTED },                       // `verified` absent
      { verdict: COMMIT_PROVENANCE.ATTRIBUTED, verified: "true" },     // not a boolean
      { verdict: "something_this_build_has_never_heard_of", verified: true },
      { verified: true }                                               // no verdict at all
    ]) {
      const combined = reconciliationProvenanceForGate({ stored, derived });
      expect(combined.verified).toBe(false);
      expect(gateFor(combined).held).toBe(true);
    }
  });

  it("returns null only when there is no derived record to gate", () => {
    expect(reconciliationProvenanceForGate({ stored: recordedUnverified, derived: null })).toBeNull();
    // ...and the gate refuses that on its own.
    expect(gateFor(null).held).toBe(true);
  });
});

describe("D-136: the derivation is read-only", () => {
  it("never writes, removes or rewrites anything it looked at", () => {
    const ws = establish();
    const foreign = foreignCommit(ws.path);
    const claimBefore = JSON.stringify(claimOf());

    derive();

    expect(head(ws.path)).toBe(foreign);
    expect(git(ws.path, ["cat-file", "-t", foreign])).toBe("commit");
    expect(JSON.stringify(claimOf())).toBe(claimBefore);
    // And the primary checkout was never touched.
    expect(head(repoPath)).toBe(baseline);
    expect(resolve(ws.path)).not.toBe(resolve(repoPath));
  });
});

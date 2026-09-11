/**
 * D-133 unit tests: the task-ownership claim and the worktree classifier.
 *
 * `classifyTaskWorktree` is the decision that separates "this uncommitted work
 * is this task's own, resume it" from "this is unattributed content, never
 * touch it". It is pure, so every fail-closed branch is asserted here directly
 * rather than being inferred from a log line in an integration run.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CLAIM_SCHEMA_VERSION,
  CLAIM_STATE,
  WORKTREE_STATE,
  taskWorktreePath,
  claimFilePath,
  expectationFor,
  buildClaim,
  readClaim,
  writeClaim,
  verifyClaim,
  classifyTaskWorktree
} from "../lib/worktree.mjs";

const CFG = {
  repoOwner: "tsworkflow",
  repoName: "jarvisbuild",
  controlIssue: 68,
  repoPath: resolve("/repo/jarvis")
};
const TASK = "D133-TEST-20260911-A";
const COMMENT = { id: 5630497923, created_at: "2026-09-11T06:36:56Z", user: { login: "tsworkflow" } };

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "jarvis-wt-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function expectation(overrides = {}) {
  return { ...expectationFor({ cfg: CFG, taskId: TASK, comment: COMMENT, worktreeRoot: root }), ...overrides };
}

function claimFor(overrides = {}) {
  return {
    ...buildClaim({
      expectation: expectation(),
      baselineSha: "a".repeat(40),
      baselineBranch: "main",
      attempt: 1,
      attemptId: "attempt-1",
      workerVersion: "2.1.0",
      taskCommentCreatedAt: COMMENT.created_at,
      taskCommentAuthor: COMMENT.user.login
    }),
    ...overrides
  };
}

describe("D-133: a TASK_ID becomes a path only after validation", () => {
  for (const bad of ["../escape", "a/b", "..", ".", "", "with space", null]) {
    it(`refuses to derive a worktree path from ${JSON.stringify(bad)}`, () => {
      expect(() => taskWorktreePath(root, bad)).toThrow(/unsafe TASK_ID/);
      expect(() => claimFilePath(root, bad)).toThrow(/unsafe TASK_ID/);
    });
  }

  it("keeps the task id as a single path component under the root", () => {
    expect(taskWorktreePath(root, TASK)).toBe(join(root, TASK));
    expect(claimFilePath(root, TASK)).toBe(join(root, ".claims", `${TASK}.json`));
  });
});

describe("D-133: a claim binds a directory to an exact task, before any mutation", () => {
  it("is created in the staged CREATING state, not as an accomplished fact", () => {
    const claim = claimFor();
    expect(claim.state).toBe(CLAIM_STATE.CREATING);
    expect(claim.claim_schema_version).toBe(CLAIM_SCHEMA_VERSION);
  });

  it("carries the full identity the ownership decision depends on", () => {
    const claim = claimFor();
    expect(claim.task_id).toBe(TASK);
    expect(claim.repo).toBe("tsworkflow/jarvisbuild");
    expect(claim.repo_path).toBe(CFG.repoPath);
    expect(claim.control_issue).toBe(68);
    expect(claim.task_comment_id).toBe(COMMENT.id);
    expect(claim.task_comment_created_at).toBe(COMMENT.created_at);
    expect(claim.task_comment_author).toBe("tsworkflow");
    expect(claim.baseline_sha).toBe("a".repeat(40));
    expect(claim.baseline_branch).toBe("main");
    expect(claim.worktree_path).toBe(resolve(join(root, TASK)));
    expect(claim.first_attempt_id).toBe("attempt-1");
    expect(claim.attempts).toHaveLength(1);
  });

  it("round-trips durably", () => {
    const file = claimFilePath(root, TASK);
    writeClaim(file, claimFor());
    const read = readClaim(file);
    expect(read.ok).toBe(true);
    expect(read.claim.task_id).toBe(TASK);
  });

  it("distinguishes MISSING from UNUSABLE - an unreadable claim is never 'no claim'", () => {
    const file = claimFilePath(root, TASK);
    expect(readClaim(file)).toMatchObject({ ok: false, missing: true });

    mkdirSync(join(root, ".claims"), { recursive: true });
    writeFileSync(file, "{ not json", "utf8");
    expect(readClaim(file)).toMatchObject({ ok: false, missing: false });
    expect(readClaim(file).reason).toMatch(/unparseable/);

    writeFileSync(file, JSON.stringify({ claim_schema_version: 99, state: "ready" }), "utf8");
    expect(readClaim(file).reason).toMatch(/schema_version_unsupported/);

    writeFileSync(file, JSON.stringify({ claim_schema_version: CLAIM_SCHEMA_VERSION, state: "whatever" }), "utf8");
    expect(readClaim(file).reason).toMatch(/state_unknown/);
  });
});

describe("D-133: verifyClaim is exact equality and nothing weaker", () => {
  it("accepts only a full match", () => {
    expect(verifyClaim(claimFor(), expectation()).ok).toBe(true);
  });

  const cases = {
    "a different task id": { task_id: "OTHER-TASK" },
    "a different repository": { repo: "someone/else" },
    "a different local checkout": { repo_path: resolve("/repo/other") },
    "a different control issue": { control_issue: 99 },
    "a different control comment": { task_comment_id: 1 },
    "a different directory": { worktree_path: resolve("/somewhere/else") }
  };
  for (const [label, patch] of Object.entries(cases)) {
    it(`rejects ${label}`, () => {
      const verdict = verifyClaim(claimFor(patch), expectation());
      expect(verdict.ok).toBe(false);
      expect(verdict.mismatches.length).toBeGreaterThan(0);
    });
  }

  it("does not accept a prefix or a case variation of the task id", () => {
    expect(verifyClaim(claimFor({ task_id: TASK.toLowerCase() }), expectation()).ok).toBe(false);
    expect(verifyClaim(claimFor({ task_id: TASK.slice(0, 8) }), expectation()).ok).toBe(false);
  });
});

describe("D-133: classification fails closed on anything it cannot attribute", () => {
  const registered = [resolve(join("/other", "place"))];
  const ours = () => resolve(join(root, TASK));

  it("ABSENT: no claim, no directory -> safe to create", () => {
    const v = classifyTaskWorktree({
      expectation: expectation(),
      claimRead: { ok: false, missing: true, reason: "claim_missing" },
      dirExists: false,
      dirEmpty: true,
      registeredPaths: registered
    });
    expect(v.state).toBe(WORKTREE_STATE.ABSENT);
  });

  it("FOREIGN: content with NO claim is never adopted", () => {
    // This is the whole point. Dirty files that nothing attributes to a task
    // are the user's until proven otherwise, and they are never proven
    // otherwise by their own presence.
    const v = classifyTaskWorktree({
      expectation: expectation(),
      claimRead: { ok: false, missing: true, reason: "claim_missing" },
      dirExists: true,
      dirEmpty: false,
      registeredPaths: registered
    });
    expect(v.state).toBe(WORKTREE_STATE.FOREIGN);
    expect(v.reason).toMatch(/NO claim/);
  });

  it("FOREIGN: a claim belonging to a DIFFERENT task never transfers", () => {
    const v = classifyTaskWorktree({
      expectation: expectation(),
      claimRead: { ok: true, claim: claimFor({ task_id: "SOMEONE-ELSE", state: CLAIM_STATE.READY }) },
      dirExists: true,
      dirEmpty: false,
      registeredPaths: [...registered, ours()]
    });
    expect(v.state).toBe(WORKTREE_STATE.FOREIGN);
    expect(v.reason).toMatch(/does not belong to this task/);
  });

  it("UNPROVEN: an unreadable claim is a refusal, not an invitation to overwrite", () => {
    const v = classifyTaskWorktree({
      expectation: expectation(),
      claimRead: { ok: false, missing: false, reason: "claim_unparseable: bad" },
      dirExists: true,
      dirEmpty: false,
      registeredPaths: registered
    });
    expect(v.state).toBe(WORKTREE_STATE.UNPROVEN);
  });

  it("UNPROVEN: git has a worktree registered where we have no claim", () => {
    const v = classifyTaskWorktree({
      expectation: expectation(),
      claimRead: { ok: false, missing: true, reason: "claim_missing" },
      dirExists: false,
      dirEmpty: true,
      registeredPaths: [ours()]
    });
    expect(v.state).toBe(WORKTREE_STATE.UNPROVEN);
  });

  it("UNPROVEN: a READY claim whose directory has vanished - work may have been destroyed", () => {
    const v = classifyTaskWorktree({
      expectation: expectation(),
      claimRead: { ok: true, claim: claimFor({ state: CLAIM_STATE.READY }) },
      dirExists: false,
      dirEmpty: true,
      registeredPaths: registered
    });
    expect(v.state).toBe(WORKTREE_STATE.UNPROVEN);
    expect(v.reason).toMatch(/may have been removed/);
  });

  it("UNPROVEN: a READY claim and a directory, but git does not know the worktree", () => {
    const v = classifyTaskWorktree({
      expectation: expectation(),
      claimRead: { ok: true, claim: claimFor({ state: CLAIM_STATE.READY }) },
      dirExists: true,
      dirEmpty: false,
      registeredPaths: registered
    });
    expect(v.state).toBe(WORKTREE_STATE.UNPROVEN);
  });

  it("INCOMPLETE: a crash between claim and worktree is reconcilable, not fatal", () => {
    const v = classifyTaskWorktree({
      expectation: expectation(),
      claimRead: { ok: true, claim: claimFor({ state: CLAIM_STATE.CREATING }) },
      dirExists: false,
      dirEmpty: true,
      registeredPaths: registered
    });
    expect(v.state).toBe(WORKTREE_STATE.INCOMPLETE);
  });

  it("OWNED: a valid claim plus a registered worktree is resumable", () => {
    const v = classifyTaskWorktree({
      expectation: expectation(),
      claimRead: { ok: true, claim: claimFor({ state: CLAIM_STATE.READY }) },
      dirExists: true,
      dirEmpty: false,
      registeredPaths: [ours()]
    });
    expect(v.state).toBe(WORKTREE_STATE.OWNED);
  });

  it("RELEASED + leftover content is UNPROVEN, never silently reused", () => {
    const v = classifyTaskWorktree({
      expectation: expectation(),
      claimRead: { ok: true, claim: claimFor({ state: CLAIM_STATE.RELEASED }) },
      dirExists: true,
      dirEmpty: false,
      registeredPaths: registered
    });
    expect(v.state).toBe(WORKTREE_STATE.UNPROVEN);
  });

  it("an UNANSWERABLE worktree listing is never read as 'nothing registered'", () => {
    // `registeredPaths: null` is how the caller expresses "git could not tell
    // me". It must not collapse into the empty-list case.
    const v = classifyTaskWorktree({
      expectation: expectation(),
      claimRead: { ok: true, claim: claimFor({ state: CLAIM_STATE.READY }) },
      dirExists: true,
      dirEmpty: false,
      registeredPaths: null
    });
    expect(v.state).toBe(WORKTREE_STATE.OWNED);
  });
});

describe("D-133: ownership can never be inferred backwards from dirty files", () => {
  it("an empty claims directory plus arbitrary dirt yields FOREIGN for every task id", () => {
    for (const taskId of ["A-1", "B-2", TASK]) {
      const exp = expectationFor({ cfg: CFG, taskId, comment: COMMENT, worktreeRoot: root });
      const v = classifyTaskWorktree({
        expectation: exp,
        claimRead: { ok: false, missing: true, reason: "claim_missing" },
        dirExists: true,
        dirEmpty: false,
        registeredPaths: []
      });
      expect(v.state).toBe(WORKTREE_STATE.FOREIGN);
    }
  });

  it("a claim written for one comment does not cover a re-issued task id", () => {
    // Same TASK_ID, different trusted comment: a different order, so the old
    // context is not inherited and the new order starts from a clean decision.
    const file = claimFilePath(root, TASK);
    writeClaim(file, claimFor({ state: CLAIM_STATE.READY }));
    const reissued = expectation({ task_comment_id: 9999999 });
    const v = classifyTaskWorktree({
      expectation: reissued,
      claimRead: readClaim(file),
      dirExists: true,
      dirEmpty: false,
      registeredPaths: [resolve(join(root, TASK))]
    });
    expect(v.state).toBe(WORKTREE_STATE.FOREIGN);
    expect(v.reason).toMatch(/task_comment_id/);
  });

  it("the claim file is plain, inspectable JSON - the evidence is readable by a human", () => {
    const file = claimFilePath(root, TASK);
    writeClaim(file, claimFor());
    const text = readFileSync(file, "utf8");
    expect(text).toContain(TASK);
    expect(text).toContain(String(COMMENT.id));
    expect(JSON.parse(text).baseline_sha).toBe("a".repeat(40));
  });
});

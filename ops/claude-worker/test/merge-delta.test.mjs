/**
 * D-157: THE EFFECTIVE-CHANGE PROOF THAT REPLACED MERGE-TREE-EQUALS-HEAD-TREE.
 *
 * The fixture at the centre of this file is not invented. It is PR #82's exact
 * topology, with the real shas read fresh from GitHub while this change was
 * written:
 *
 *   authorized base   091ba091...   (main at merge time)
 *   approved head     170e5810...   (reviewed by 5211287259, on this exact sha)
 *   merge commit      6f1c980c...   parents [091ba091, 170e5810]
 *   merge tree        eef13c74...   head tree 64815377...   -> NOT EQUAL
 *   base...head       status=diverged  ahead_by=3  behind_by=17
 *
 * D-145's rule refused that merge with
 * `the_merge_commit_tree_is_not_the_approved_head_tree_so_the_merge_introduced_unreviewed_content`
 * and held D-156's completion gate (issue #68 comment 5684346209) on a merge
 * that was exactly the authorized one. The branch was simply 17 commits behind.
 *
 * The positive tests assert the new proof accepts that topology. Every negative
 * is the SAME fixture with exactly one fact altered, because a verifier that only
 * ever says yes is worth nothing.
 */

import { describe, it, expect } from "vitest";

import {
  COMPARE_FILE_PAGE_CAP,
  MERGE_DELTA,
  describeMergeDelta,
  normalizeComparison,
  verifyMergeDelta
} from "../lib/merge-delta.mjs";

/** The real PR #82 shas. */
const BASE = "091ba091141a15c86f7181cc6e0762136db72bcc";
const HEAD = "170e5810110c48596ea393bd9c55f3065096afe2";
const MERGE = "6f1c980c3493c6f68fe97bb2c8f045b4d196af75";
const MERGE_BASE = "0c803bf1c1724413dc8e8071a7aabe7fd52562e4";
const OTHER = "1111111111111111111111111111111111111111";

/** The reviewed delta: three of PR #82's eight real files, shape for shape. */
function files(over = []) {
  const base = [
    {
      filename: "docs/OPEN_QUESTIONS.md",
      status: "modified",
      previousFilename: null,
      blobSha: "191f95fa0d1e4b3c8a7d6e5f4c3b2a1908070605",
      additions: 12,
      deletions: 3,
      patch: "@@ -1,3 +1,12 @@\n context\n-old\n+new\n"
    },
    {
      filename: "modules/core/src/db/migrations/054_tool_executions_postcondition.sql",
      status: "added",
      previousFilename: null,
      blobSha: "2a2a2a2a0d1e4b3c8a7d6e5f4c3b2a1908070605",
      additions: 41,
      deletions: 0,
      patch: "@@ -0,0 +1,41 @@\n+create table ...\n"
    },
    {
      filename: "modules/tool-gateway/src/gateway.ts",
      status: "modified",
      previousFilename: null,
      blobSha: "3b3b3b3b0d1e4b3c8a7d6e5f4c3b2a1908070605",
      additions: 88,
      deletions: 9,
      patch: "@@ -120,9 +120,88 @@ export class ToolGateway {\n-  old\n+  new\n"
    }
  ];
  return base.map((f, i) => ({ ...f, ...(over[i] ?? {}) }));
}

/** `compare(parent1...merge)`: strictly ahead of the base, nothing behind. */
function mergeDelta(over = {}) {
  return {
    ok: true,
    error: null,
    item: {
      baseSha: BASE,
      mergeBaseSha: BASE,
      headSha: MERGE,
      status: "ahead",
      aheadBy: 4,
      behindBy: 0,
      totalCommits: 4,
      commitCount: 4,
      fileCount: 3,
      files: files(),
      ...over
    }
  };
}

/** `compare(base...head)`: DIVERGED - 3 ahead, 17 behind. The real shape. */
function reviewedDelta(over = {}) {
  return {
    ok: true,
    error: null,
    item: {
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
      headSha: HEAD,
      status: "diverged",
      aheadBy: 3,
      behindBy: 17,
      totalCommits: 3,
      commitCount: 3,
      fileCount: 3,
      files: files(),
      ...over
    }
  };
}

// `in` rather than `??`: a test that passes an explicit `null` is asserting the
// NEVER-QUERIED case, and `??` would silently hand it the passing default.
function verify(over = {}) {
  return verifyMergeDelta({
    mergeDelta: "mergeDelta" in over ? over.mergeDelta : mergeDelta(),
    reviewedDelta: "reviewedDelta" in over ? over.reviewedDelta : reviewedDelta(),
    parent1: over.parent1 ?? BASE,
    mergeSha: over.mergeSha ?? MERGE,
    expectedBase: over.expectedBase ?? BASE,
    expectedHead: over.expectedHead ?? HEAD
  });
}

/* ==========================================================================
 * THE REGRESSION: PR #82's DIVERGED TOPOLOGY
 * ========================================================================== */

describe("D-157 REGRESSION: a diverged branch merges provably, without tree equality", () => {
  it("accepts PR #82's exact topology - merge tree != head tree, 17 commits behind", () => {
    const v = verify();
    expect(v.ok).toBe(true);
    expect(v.reason).toBe(MERGE_DELTA.DELTA_MATCHES);
    expect(v.evidence.compared_file_count).toBe(3);
    expect(v.evidence.reviewed_delta.status).toBe("diverged");
    expect(v.evidence.reviewed_delta.behind_by).toBe(17);
    expect(v.evidence.merge_delta.status).toBe("ahead");
    expect(v.evidence.merge_delta.behind_by).toBe(0);
  });

  it("the detail explains WHY tree identity is not, and never was, the invariant", () => {
    expect(verify().detail).toContain("tree identity with the head is not, and never was, the invariant");
  });

  it("the end-of-range identity cross-check is confirmed when the commit lists are whole", () => {
    expect(verify().evidence.head_identity_confirmed_from_commits).toBe(true);
  });

  it("an UP-TO-DATE topology - head already contains base - passes under the SAME rule", () => {
    // PR #81's shape: nothing behind, merge tree would equal the head tree. One
    // rule covers both topologies; there is no special case to get wrong.
    const v = verify({
      reviewedDelta: reviewedDelta({ mergeBaseSha: BASE, status: "ahead", aheadBy: 3, behindBy: 0 })
    });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe(MERGE_DELTA.DELTA_MATCHES);
  });
});

/* ==========================================================================
 * UNREVIEWED CONTENT - the property the old rule was reaching for
 * ========================================================================== */

describe("D-157: unreviewed content in the merge is refused by name", () => {
  it("an EXTRA file the merge introduced and nobody reviewed fails", () => {
    const extra = [...files(), {
      filename: "slipped-in.txt",
      status: "added",
      previousFilename: null,
      blobSha: "9999999999999999999999999999999999999999",
      additions: 1,
      deletions: 0,
      patch: "@@ -0,0 +1 @@\n+never reviewed\n"
    }];
    const v = verify({ mergeDelta: mergeDelta({ files: extra, fileCount: 4 }) });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.DELTA_FILE_SET_MISMATCH);
    expect(v.detail).toContain("slipped-in.txt");
    expect(v.detail).toContain("never reviewed");
  });

  it("a reviewed file the merge DROPPED fails", () => {
    const v = verify({ mergeDelta: mergeDelta({ files: files().slice(0, 2), fileCount: 2 }) });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.DELTA_FILE_SET_MISMATCH);
    expect(v.detail).toContain("reviewed but not produced by the merge");
  });

  it("a MODIFIED HUNK - same files, altered patch - fails and names the file and field", () => {
    const tampered = files([{}, {}, {
      patch: "@@ -120,9 +120,88 @@ export class ToolGateway {\n-  old\n+  something nobody reviewed\n"
    }]);
    const v = verify({ mergeDelta: mergeDelta({ files: tampered }) });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.DELTA_CONTENT_MISMATCH);
    expect(v.evidence.mismatched_file).toBe("modules/tool-gateway/src/gateway.ts");
    expect(v.evidence.mismatched_field).toBe("patch");
  });

  it("a DIFFERENT RESULTING BLOB fails even when the patch text is identical", () => {
    // The content-addressed half of the proof: a binary file, or one too large
    // for a rendered patch, is still compared exactly.
    const v = verify({
      mergeDelta: mergeDelta({ files: files([{ blobSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }]) })
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.DELTA_CONTENT_MISMATCH);
    expect(v.evidence.mismatched_field).toBe("blob_sha");
  });

  it("a changed line COUNT fails", () => {
    const v = verify({ mergeDelta: mergeDelta({ files: files([{ additions: 13 }]) }) });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.DELTA_CONTENT_MISMATCH);
    expect(v.evidence.mismatched_field).toBe("additions");
  });

  it("a changed STATUS - added where the review saw modified - fails", () => {
    const v = verify({ mergeDelta: mergeDelta({ files: files([{ status: "added" }]) }) });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.DELTA_CONTENT_MISMATCH);
    expect(v.evidence.mismatched_field).toBe("status");
  });

  it("a rename whose SOURCE differs fails", () => {
    const renamed = files([{ status: "renamed", previousFilename: "docs/OLD.md" }]);
    const reviewedRenamed = files([{ status: "renamed", previousFilename: "docs/DIFFERENT.md" }]);
    const v = verify({
      mergeDelta: mergeDelta({ files: renamed }),
      reviewedDelta: reviewedDelta({ files: reviewedRenamed })
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.DELTA_CONTENT_MISMATCH);
    expect(v.evidence.mismatched_field).toBe("previous_filename");
  });

  it("a file with NEITHER a blob sha NOR a patch is refused instead of compared as two nulls", () => {
    const blind = files([{ blobSha: null, patch: null }]);
    const v = verify({
      mergeDelta: mergeDelta({ files: blind }),
      reviewedDelta: reviewedDelta({ files: blind })
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.DELTA_FILE_UNVERIFIABLE);
  });
});

/* ==========================================================================
 * STRUCTURE: squash, rebase, wrong anchor, synthetic history
 * ========================================================================== */

describe("D-157: a transition that is not a forward merge from parent 1 is refused", () => {
  it("a comparison anchored somewhere other than the merge's own first parent fails", () => {
    const v = verify({ mergeDelta: mergeDelta({ baseSha: OTHER }) });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.MERGE_DELTA_WRONG_RANGE);
  });

  it("a merge that is BEHIND its own first parent - a rebase or replaced history - fails", () => {
    const v = verify({ mergeDelta: mergeDelta({ status: "diverged", behindBy: 4 }) });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.MERGE_NOT_DESCENDED_FROM_FIRST_PARENT);
  });

  it("a merge base that is NOT the first parent fails even when nothing is behind", () => {
    const v = verify({ mergeDelta: mergeDelta({ mergeBaseSha: MERGE_BASE }) });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.MERGE_NOT_DESCENDED_FROM_FIRST_PARENT);
  });

  it("a comparison that ends somewhere other than the merge commit fails", () => {
    const v = verify({ mergeDelta: mergeDelta({ headSha: OTHER }) });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.MERGE_DELTA_WRONG_RANGE);
  });

  it("a reviewed comparison anchored at the wrong base fails", () => {
    const v = verify({ reviewedDelta: reviewedDelta({ baseSha: OTHER }) });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.REVIEWED_DELTA_WRONG_RANGE);
  });

  it("a reviewed comparison that ends at a head OTHER than the approved one fails", () => {
    const v = verify({ reviewedDelta: reviewedDelta({ headSha: OTHER }) });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.REVIEWED_DELTA_WRONG_RANGE);
  });

  it("a MOVED authorized head - the order names a head the comparison is not about - fails", () => {
    const v = verify({ expectedHead: OTHER });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.REVIEWED_DELTA_WRONG_RANGE);
  });

  it("a MOVED authorized base fails", () => {
    const v = verify({ expectedBase: OTHER });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.REVIEWED_DELTA_WRONG_RANGE);
  });

  it("a parent 1 that is not a full sha is refused rather than compared loosely", () => {
    const v = verify({ parent1: "091ba09" });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.MERGE_DELTA_WRONG_RANGE);
  });
});

/* ==========================================================================
 * UNREADABLE AND INCOMPLETE EVIDENCE NEVER PASSES
 * ========================================================================== */

describe("D-157: evidence that was not read, or not read whole, never proves a match", () => {
  it("an unreadable merge comparison fails and carries the remote's error", () => {
    const v = verify({ mergeDelta: { ok: false, item: null, error: "gh: HTTP 403 rate limit exceeded" } });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.MERGE_DELTA_UNREADABLE);
    expect(v.detail).toContain("403");
  });

  it("an unreadable reviewed comparison fails", () => {
    const v = verify({ reviewedDelta: { ok: false, item: null, error: "gh: HTTP 404" } });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.REVIEWED_DELTA_UNREADABLE);
  });

  it("a comparison that was never queried at all fails", () => {
    const v = verify({ mergeDelta: null });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.MERGE_DELTA_UNREADABLE);
    expect(v.detail).toBe("not queried");
  });

  it("a file page AT the remote's cap is treated as possibly short, not as complete", () => {
    const many = Array.from({ length: COMPARE_FILE_PAGE_CAP }, (_, i) => ({
      filename: `f${i}.txt`, status: "added", previousFilename: null,
      blobSha: String(i).padStart(40, "0"), additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+x\n"
    }));
    const v = verify({
      mergeDelta: mergeDelta({ files: many, fileCount: COMPARE_FILE_PAGE_CAP }),
      reviewedDelta: reviewedDelta({ files: many, fileCount: COMPARE_FILE_PAGE_CAP })
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.DELTA_TRUNCATED);
  });

  it("a file COUNT larger than the files actually returned is truncation and fails", () => {
    const v = verify({ mergeDelta: mergeDelta({ fileCount: 9 }) });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.DELTA_TRUNCATED);
  });

  it("a capped COMMIT list downgrades only the redundant cross-check, and says so", () => {
    // Files are what the content proof rests on; the commit list is a redundant
    // end-of-range confirmation. A capped commit page must not refuse a merge
    // whose files were all read - but it must never be passed over in silence.
    const v = verify({ mergeDelta: mergeDelta({ totalCommits: 900, commitCount: 250 }) });
    expect(v.ok).toBe(true);
    expect(v.evidence.head_identity_confirmed_from_commits).toBe(false);
    expect(v.detail).toContain("the commit lists were capped");
  });

  it("an EMPTY reviewed delta is refused - two empty sets are an identity, not evidence", () => {
    const v = verify({
      mergeDelta: mergeDelta({ files: [], fileCount: 0 }),
      reviewedDelta: reviewedDelta({ files: [], fileCount: 0 })
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_DELTA.REVIEWED_DELTA_EMPTY);
  });
});

/* ==========================================================================
 * THE RECORD
 * ========================================================================== */

describe("D-157: the evidence record", () => {
  it("file order does not change the verdict", () => {
    const reversed = [...files()].reverse();
    const v = verify({ mergeDelta: mergeDelta({ files: reversed }) });
    expect(v.ok).toBe(true);
  });

  it("evidence is populated on refusals too, so a held gate is understandable", () => {
    const v = verify({ mergeDelta: mergeDelta({ files: files([{ additions: 999 }]) }) });
    expect(v.ok).toBe(false);
    expect(v.evidence.merge_delta).not.toBeNull();
    expect(v.evidence.reviewed_delta).not.toBeNull();
    expect(v.evidence.mismatched_file).toBe("docs/OPEN_QUESTIONS.md");
  });

  it("normalizeComparison reports completeness rather than assuming it", () => {
    const n = normalizeComparison({ files: [{ filename: "a" }], fileCount: 5, totalCommits: 2, commitCount: 2 });
    expect(n.files_complete).toBe(false);
    expect(n.commits_complete).toBe(true);
  });

  it("describeMergeDelta names the first mismatch for a status comment", () => {
    const v = verify({ mergeDelta: mergeDelta({ files: files([{ additions: 999 }]) }) });
    const lines = describeMergeDelta(v.evidence).join("\n");
    expect(lines).toContain("FIRST MISMATCH");
    expect(lines).toContain("docs/OPEN_QUESTIONS.md");
  });
});

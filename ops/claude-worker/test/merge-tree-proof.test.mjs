/**
 * D-158: the merge proof, at the pure boundary and over REAL GIT OBJECTS.
 *
 * Two halves, deliberately:
 *
 *   `verifyMergeTreeProof` is pure, so every fail-closed branch can be driven
 *   exactly - including the ones real git will not produce on demand, like a
 *   computation that resolved different commits than the order authorized.
 *
 *   `computeMergeTree` touches git and the filesystem, so it is tested against a
 *   REAL repository with real objects. A fixture cannot certify "the tree git
 *   produces for these two commits", because a fixture would simply agree with
 *   whatever this code did. The topologies here are built by real commits and
 *   merged by real `git merge-tree`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MERGE_TREE_PROOF, verifyMergeTreeProof, describeMergeTreeProof } from "../lib/merge-tree-proof.mjs";
import { computeMergeTree, mergeProofStorePath } from "../lib/merge-tree.mjs";
import { git, createRepo, head, treeOf, parentsOf, syntheticMerge, realMergeTree } from "./fixtures/real-git-repo.mjs";

const BASE = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";
const MERGE = "3333333333333333333333333333333333333333";
const TREE = "4444444444444444444444444444444444444444";
const OTHER_TREE = "5555555555555555555555555555555555555555";

/* ==========================================================================
 * THE PURE PROOF
 * ========================================================================== */

/** A complete, correct computation record - one field changed per case. */
const computation = (over = {}) => ({
  attempted: true,
  ok: true,
  stage: "complete",
  error: null,
  store_path: "C:/worker/tmp/merge-proof.git",
  fetched: false,
  fetch_error: null,
  missing_objects: [],
  resolved_base: BASE,
  resolved_head: HEAD,
  resolved_merge: MERGE,
  expected_tree: TREE,
  conflicted: false,
  conflict_detail: null,
  merge_commit_tree: TREE,
  merge_commit_parents: [BASE, HEAD],
  ...over
});

const verify = (over = {}) => verifyMergeTreeProof({
  computation: "computation" in over ? over.computation : computation(),
  mergeSha: "mergeSha" in over ? over.mergeSha : MERGE,
  expectedBase: "expectedBase" in over ? over.expectedBase : BASE,
  expectedHead: "expectedHead" in over ? over.expectedHead : HEAD,
  projectedTree: "projectedTree" in over ? over.projectedTree : TREE,
  projectedParents: "projectedParents" in over ? over.projectedParents : [BASE, HEAD]
});

describe("D-158: verifyMergeTreeProof accepts exactly the authorized merge", () => {
  it("passes when the merge commit's tree IS the recomputed merge tree", () => {
    const v = verify();
    expect(v.ok).toBe(true);
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_PROVEN);
    expect(v.evidence.proven).toBe(true);
    expect(v.evidence.expected_tree).toBe(TREE);
    expect(v.evidence.merge_commit_tree).toBe(TREE);
  });

  it("says so in the detail when objects had to be fetched", () => {
    expect(verify({ computation: computation({ fetched: true }) }).detail).toContain("fetched by exact sha");
  });

  it("is case-insensitive about sha spelling but not about identity", () => {
    expect(verify({
      computation: computation({ expected_tree: TREE.toUpperCase(), merge_commit_tree: TREE }),
      projectedTree: TREE.toUpperCase()
    }).ok).toBe(true);
  });
});

describe("D-158: an uncomputed, incomplete or ambiguous proof is never a pass", () => {
  it("refuses when the computation was never attempted", () => {
    const v = verify({ computation: null });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_NOT_COMPUTED);
  });

  it("refuses an explicitly unattempted record", () => {
    expect(verify({ computation: { attempted: false, ok: false } }).reason)
      .toBe(MERGE_TREE_PROOF.MERGE_TREE_NOT_COMPUTED);
  });

  it("refuses a failed computation and names the stage", () => {
    const v = verify({ computation: computation({ ok: false, stage: "merge_tree", error: "git is too old" }) });
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_NOT_COMPUTED);
    expect(v.detail).toContain("git is too old");
    expect(v.detail).toContain("merge_tree");
  });

  it("refuses when an exact object could not be obtained", () => {
    const v = verify({
      computation: computation({ ok: false, stage: "resolve", missing_objects: [HEAD], error: "not on the remote" })
    });
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_OBJECTS_UNAVAILABLE);
    expect(v.evidence.computation.missing_objects).toEqual([HEAD]);
  });

  it("refuses a missing object even when the record otherwise claims success", () => {
    // Fail-closed beats a self-report: a record cannot be complete AND short.
    expect(verify({ computation: computation({ missing_objects: [BASE] }) }).reason)
      .toBe(MERGE_TREE_PROOF.MERGE_TREE_OBJECTS_UNAVAILABLE);
  });

  it("refuses when the merge produced no tree object id", () => {
    expect(verify({ computation: computation({ expected_tree: null }) }).reason)
      .toBe(MERGE_TREE_PROOF.MERGE_TREE_NOT_COMPUTED);
    expect(verify({ computation: computation({ expected_tree: "not-a-sha" }) }).reason)
      .toBe(MERGE_TREE_PROOF.MERGE_TREE_NOT_COMPUTED);
  });

  it("refuses when the conflict question was never answered", () => {
    // `null` is not `false`. An unstated conflict is not the absence of one.
    const v = verify({ computation: computation({ conflicted: null }) });
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_NOT_COMPUTED);
    expect(v.detail).toContain("unstated conflict");
  });
});

describe("D-158: a conflict is refused, and a resolution is never silently accepted", () => {
  it("refuses a conflicted merge by name", () => {
    const v = verify({
      computation: computation({
        ok: false,
        stage: "merge_tree",
        conflicted: true,
        conflict_detail: "CONFLICT (content): Merge conflict in f.txt",
        error: "merging conflicts"
      })
    });
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_CONFLICTED);
    expect(v.detail).toContain("f.txt");
    expect(v.detail).toContain("never covered");
  });

  it("refuses a conflict even if the record also claims ok and supplies a tree", () => {
    // The adversarial shape: a computation that conflicted but reports a tree
    // anyway. Accepting it would be accepting a resolution nobody reviewed.
    const v = verify({ computation: computation({ ok: true, conflicted: true, expected_tree: TREE }) });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_CONFLICTED);
  });
});

describe("D-158: the proof must answer about the AUTHORIZED commits", () => {
  it("refuses shas that are not full object ids", () => {
    for (const over of [{ expectedBase: "1111111" }, { expectedHead: null }, { mergeSha: "" }]) {
      expect(verify(over).reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_WRONG_INPUTS);
    }
  });

  it("refuses a computation that resolved a different base, head or merge", () => {
    for (const field of ["resolved_base", "resolved_head", "resolved_merge"]) {
      const v = verify({ computation: computation({ [field]: OTHER_TREE }) });
      expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_WRONG_INPUTS);
      expect(v.detail).toContain(OTHER_TREE);
    }
  });

  it("refuses a moved expected base or head", () => {
    // The order's shas changed under a stale computation: the same record now
    // describes a merge nobody authorized.
    expect(verify({ expectedBase: OTHER_TREE }).reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_WRONG_INPUTS);
    expect(verify({ expectedHead: OTHER_TREE }).reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_WRONG_INPUTS);
  });

  it("refuses the WRONG PR merge sha", () => {
    expect(verify({ mergeSha: OTHER_TREE }).reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_WRONG_INPUTS);
  });
});

describe("D-158: the merge commit object itself", () => {
  it("refuses an unreadable merge commit", () => {
    expect(verify({ computation: computation({ merge_commit_tree: null }) }).reason)
      .toBe(MERGE_TREE_PROOF.MERGE_COMMIT_OBJECT_UNREADABLE);
    expect(verify({ computation: computation({ merge_commit_parents: null }) }).reason)
      .toBe(MERGE_TREE_PROOF.MERGE_COMMIT_OBJECT_UNREADABLE);
  });

  it("refuses a squash: the object has one parent", () => {
    const v = verify({
      computation: computation({ merge_commit_parents: [BASE] }),
      projectedParents: [BASE]
    });
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_COMMIT_OBJECT_DISAGREES);
  });

  it("refuses REVERSED parents", () => {
    expect(verify({
      computation: computation({ merge_commit_parents: [HEAD, BASE] }),
      projectedParents: [HEAD, BASE]
    }).reason).toBe(MERGE_TREE_PROOF.MERGE_COMMIT_OBJECT_DISAGREES);
  });

  it("refuses an ADDITIONAL parent (an octopus wearing a merge's name)", () => {
    expect(verify({
      computation: computation({ merge_commit_parents: [BASE, HEAD, OTHER_TREE] }),
      projectedParents: [BASE, HEAD, OTHER_TREE]
    }).reason).toBe(MERGE_TREE_PROOF.MERGE_COMMIT_OBJECT_DISAGREES);
  });

  it("refuses when the API projection and the real object disagree about the parents", () => {
    const v = verify({ projectedParents: [BASE, OTHER_TREE] });
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_COMMIT_OBJECT_DISAGREES);
    expect(v.detail).toContain("the object itself");
  });

  it("refuses when the API projection and the real object disagree about the tree", () => {
    const v = verify({ projectedTree: OTHER_TREE });
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_COMMIT_OBJECT_DISAGREES);
    expect(v.detail).toContain(OTHER_TREE);
  });

  it("still proves the merge when no projection is supplied to cross-check against", () => {
    // The cross-check is additive. Its absence must not become a pass for
    // something else, nor a refusal of a proof that stands on the object alone.
    expect(verify({ projectedTree: null, projectedParents: null }).ok).toBe(true);
  });
});

describe("D-158: THE IDENTITY", () => {
  it("refuses a merge tree that is not the recomputed merge tree", () => {
    const v = verify({ computation: computation({ merge_commit_tree: OTHER_TREE }), projectedTree: OTHER_TREE });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_MISMATCH);
    expect(v.detail).toContain(TREE);
    expect(v.detail).toContain(OTHER_TREE);
    expect(v.evidence.proven).toBe(false);
  });

  it("carries evidence on refusals too", () => {
    const v = verify({ computation: computation({ merge_commit_tree: OTHER_TREE }), projectedTree: OTHER_TREE });
    expect(v.evidence.expected_tree).toBe(TREE);
    expect(v.evidence.merge_commit_tree).toBe(OTHER_TREE);
    expect(describeMergeTreeProof(v.evidence).join("\n")).toContain(TREE);
  });

  it("describes nothing rather than throwing on a missing record", () => {
    expect(describeMergeTreeProof(null)).toEqual([]);
  });
});

/* ==========================================================================
 * THE COMPUTATION, OVER REAL GIT OBJECTS
 * ==========================================================================
 *
 * Every topology below is real commits merged by real `git merge-tree`. The
 * same-file/non-overlap case is the one D-157 refused, and it is built here from
 * two commits that touch DIFFERENT HUNKS of one text file.
 */

describe("D-158: computeMergeTree, against a real repository", () => {
  let dir;
  let repoPath;
  let cfg;
  let B0;

  /** A ten-line file, with individual lines overridden. */
  const lines = (over = {}) => `${Array.from({ length: 10 }, (_, i) => over[i + 1] ?? `l${i + 1}`).join("\n")}\n`;

  const commitFile = (name, content, message) => {
    writeFileSync(join(repoPath, name), content, "utf8");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "-m", message]);
    return head(repoPath);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-d158-"));
    repoPath = join(dir, "repo");
    createRepo(repoPath);
    B0 = commitFile("f.txt", lines(), "b0: the file both sides start from");
    cfg = {
      repoOwner: "tsworkflow",
      repoName: "jarvisbuild",
      repoPath,
      scratchRoot: join(dir, "worker", "tmp")
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Build `base` and `head` from B0, merge them for real, and prove it. */
  function topology({ baseFile, baseContent, headFile, headContent, extra = null }) {
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    const base = commitFile(baseFile, baseContent, "base: work that landed while the branch was open");
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    const hd = commitFile(headFile, headContent, "head: the reviewed change");
    const merge = syntheticMerge(repoPath, {
      base,
      head: hd,
      tree: realMergeTree(repoPath, base, hd, extra ? { extra } : {}),
      message: "Merge pull request #84"
    });
    return { base, head: hd, merge };
  }

  const prove = ({ base, head: hd, merge }) => {
    const c = computeMergeTree(cfg, { expectedBase: base, expectedHead: hd, mergeSha: merge });
    return {
      computation: c,
      verdict: verifyMergeTreeProof({
        computation: c,
        mergeSha: merge,
        expectedBase: base,
        expectedHead: hd,
        projectedTree: treeOf(repoPath, merge),
        projectedParents: parentsOf(repoPath, merge)
      })
    };
  };

  it("PASSES a diverged merge that touched DIFFERENT FILES", () => {
    const t = topology({
      baseFile: "base-only.txt", baseContent: "landed meanwhile\n",
      headFile: "feature.txt", headContent: "the reviewed change\n"
    });
    const { computation: c, verdict } = prove(t);
    expect(c.ok).toBe(true);
    expect(c.conflicted).toBe(false);
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_PROVEN);
  });

  it("PASSES different NON-OVERLAPPING HUNKS OF THE SAME FILE - the D-157 false negative", () => {
    const t = topology({
      baseFile: "f.txt", baseContent: lines({ 1: "l1-CHANGED-ON-BASE" }),
      headFile: "f.txt", headContent: lines({ 10: "l10-CHANGED-ON-HEAD" })
    });

    // The fixture really IS the refused shape, asserted before it is relied on:
    // one file, both sides changed it, and the merge blob equals NEITHER side's.
    expect(git(repoPath, ["diff", "--name-only", B0, t.base])).toBe("f.txt");
    expect(git(repoPath, ["diff", "--name-only", B0, t.head])).toBe("f.txt");
    const mergedBlob = git(repoPath, ["rev-parse", `${t.merge}:f.txt`]);
    expect(mergedBlob).not.toBe(git(repoPath, ["rev-parse", `${t.head}:f.txt`]));
    expect(mergedBlob).not.toBe(git(repoPath, ["rev-parse", `${t.base}:f.txt`]));
    // ...and it carries BOTH sides' hunks.
    const merged = git(repoPath, ["cat-file", "-p", `${t.merge}:f.txt`]);
    expect(merged).toContain("l1-CHANGED-ON-BASE");
    expect(merged).toContain("l10-CHANGED-ON-HEAD");

    const { verdict } = prove(t);
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_PROVEN);
  });

  it("PASSES when the base is already contained by the head", () => {
    // No divergence at all: the branch is ahead, the merge tree IS the head tree.
    // One rule, both topologies - which is the whole point of recomputing.
    const base = B0;
    const hd = commitFile("feature.txt", "the reviewed change\n", "head: ahead of its base");
    const merge = syntheticMerge(repoPath, { base, head: hd, message: "Merge pull request #84" });
    expect(treeOf(repoPath, merge)).toBe(treeOf(repoPath, hd));

    const { verdict } = prove({ base, head: hd, merge });
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_PROVEN);
  });

  it("BLOCKS same-file OVERLAPPING edits: a conflict has no one correct tree", () => {
    // `topology()` is not usable here on purpose: it asks git for the merge tree,
    // and there ISN'T one - `git merge-tree` refuses these two commits. So the
    // merge commit is built over the head's tree, which is what a side that
    // simply took its own version would produce. The gate must stop at the
    // conflict, before it ever gets as far as comparing a tree.
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    const base = commitFile("f.txt", lines({ 1: "l1-BASE-WINS" }), "base");
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    const hd = commitFile("f.txt", lines({ 1: "l1-HEAD-WINS" }), "head");
    const merge = syntheticMerge(repoPath, { base, head: hd });

    const c = computeMergeTree(cfg, { expectedBase: base, expectedHead: hd, mergeSha: merge });
    expect(c.ok).toBe(false);
    expect(c.conflicted).toBe(true);
    expect(c.expected_tree).toBe(null);
    expect(c.conflict_detail).toContain("f.txt");

    const v = verifyMergeTreeProof({ computation: c, mergeSha: merge, expectedBase: base, expectedHead: hd });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_CONFLICTED);
  });

  it("BLOCKS a MANUALLY RESOLVED conflict presented as a normal merge", () => {
    // The adversarial case the order names: a perfectly well-formed two-parent
    // merge whose tree is somebody's hand-picked resolution. It must not be
    // accepted merely because it is well formed.
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    const base = commitFile("f.txt", lines({ 1: "l1-BASE-WINS" }), "base");
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    const hd = commitFile("f.txt", lines({ 1: "l1-HEAD-WINS" }), "head");
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    const resolved = commitFile("f.txt", lines({ 1: "l1-SOMEBODY-CHOSE-THIS" }), "a resolution nobody reviewed");
    const merge = syntheticMerge(repoPath, { base, head: hd, tree: treeOf(repoPath, resolved) });

    expect(parentsOf(repoPath, merge)).toEqual([base, hd]);
    const v = prove({ base, head: hd, merge }).verdict;
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_CONFLICTED);
  });

  it("BLOCKS an EXTRA FILE in the merge tree", () => {
    const t = topology({
      baseFile: "base-only.txt", baseContent: "landed meanwhile\n",
      headFile: "feature.txt", headContent: "the reviewed change\n",
      extra: { file: "slipped-in.txt", content: "never reviewed\n" }
    });
    const v = prove(t).verdict;
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_MISMATCH);
  });

  it("BLOCKS a DROPPED reviewed hunk", () => {
    // Same parents, but the merge tree is the base's tree: the reviewed change
    // never made it in. The parents alone cannot see this; the tree can.
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    const base = commitFile("base-only.txt", "landed meanwhile\n", "base");
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    const hd = commitFile("f.txt", lines({ 5: "l5-REVIEWED" }), "head");
    const merge = syntheticMerge(repoPath, { base, head: hd, tree: treeOf(repoPath, base) });
    expect(prove({ base, head: hd, merge }).verdict.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_MISMATCH);
  });

  it("BLOCKS an ALTERED reviewed hunk", () => {
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    const base = commitFile("base-only.txt", "landed meanwhile\n", "base");
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    const hd = commitFile("f.txt", lines({ 5: "l5-REVIEWED" }), "head");
    git(repoPath, ["checkout", "--quiet", "--detach", base]);
    const tampered = commitFile("f.txt", lines({ 5: "l5-NOT-WHAT-WAS-REVIEWED" }), "altered");
    const merge = syntheticMerge(repoPath, { base, head: hd, tree: treeOf(repoPath, tampered) });
    expect(prove({ base, head: hd, merge }).verdict.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_MISMATCH);
  });

  it("BLOCKS an ALTERED BASE-ONLY hunk - content neither predecessor ever looked at", () => {
    // This is the case D-145 and D-157 were both structurally blind to: the
    // base-only change is absent from `base...head` and from `parent1...merge`,
    // so a comparison of those two says nothing whatsoever about it.
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    const base = commitFile("f.txt", lines({ 1: "l1-BASE-ONLY" }), "base");
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    const hd = commitFile("feature.txt", "the reviewed change\n", "head");

    // A tree that is the correct merge EXCEPT that the base-only line is gone.
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    writeFileSync(join(repoPath, "f.txt"), lines({ 1: "l1-QUIETLY-REVERTED" }), "utf8");
    writeFileSync(join(repoPath, "feature.txt"), "the reviewed change\n", "utf8");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "-m", "the merge, with the base-only hunk quietly altered"]);
    const tamperedTree = treeOf(repoPath, head(repoPath));

    const merge = syntheticMerge(repoPath, { base, head: hd, tree: tamperedTree });
    const v = prove({ base, head: hd, merge }).verdict;
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_MISMATCH);
  });

  it("BLOCKS a changed FILE MODE, which no line-based diff would report", () => {
    const t = topology({
      baseFile: "base-only.txt", baseContent: "landed meanwhile\n",
      headFile: "script.sh", headContent: "#!/bin/sh\necho reviewed\n"
    });
    // Same content, executable bit set: a tree id sees it, a patch does not.
    const correct = realMergeTree(repoPath, t.base, t.head);
    const listing = git(repoPath, ["ls-tree", correct])
      .split(/\r?\n/)
      .map((l) => l.replace(/^100644 (blob \w+\tscript\.sh)$/, "100755 $1"))
      .join("\n");
    const mk = spawnSync("git", ["mktree"], { cwd: repoPath, input: `${listing}\n`, encoding: "utf8", windowsHide: true });
    expect(mk.status).toBe(0);
    const modeTree = String(mk.stdout).trim();
    expect(modeTree).not.toBe(correct);

    const merge = syntheticMerge(repoPath, { base: t.base, head: t.head, tree: modeTree });
    expect(prove({ base: t.base, head: t.head, merge }).verdict.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_MISMATCH);
  });

  it("BLOCKS a SQUASH: the real object has one parent", () => {
    const t = topology({
      baseFile: "base-only.txt", baseContent: "landed meanwhile\n",
      headFile: "feature.txt", headContent: "the reviewed change\n"
    });
    const squash = syntheticMerge(repoPath, {
      base: t.base, head: t.head, tree: realMergeTree(repoPath, t.base, t.head), squash: true
    });
    const v = prove({ base: t.base, head: t.head, merge: squash }).verdict;
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_COMMIT_OBJECT_DISAGREES);
  });

  it("BLOCKS a merge whose parents are the RIGHT shape but the WRONG commits", () => {
    const t = topology({
      baseFile: "base-only.txt", baseContent: "landed meanwhile\n",
      headFile: "feature.txt", headContent: "the reviewed change\n"
    });
    const reversed = syntheticMerge(repoPath, {
      base: t.head, head: t.base, tree: realMergeTree(repoPath, t.base, t.head)
    });
    expect(prove({ base: t.base, head: t.head, merge: reversed }).verdict.reason)
      .toBe(MERGE_TREE_PROOF.MERGE_COMMIT_OBJECT_DISAGREES);
  });

  it("BLOCKS a missing object rather than inventing a merge", () => {
    const t = topology({
      baseFile: "base-only.txt", baseContent: "landed meanwhile\n",
      headFile: "feature.txt", headContent: "the reviewed change\n"
    });
    const absent = "0123456789012345678901234567890123456789";
    // `origin` is pointed at a dead LOCAL path that still ends in
    // `/tsworkflow/jarvisbuild`, so the remote guard passes, the fetch is
    // attempted and fails, and the suite stays offline. The gate must stop.
    git(repoPath, ["remote", "set-url", "origin",
      `${dir.replace(/\\/g, "/")}/nowhere/tsworkflow/jarvisbuild`]);
    const c = computeMergeTree(cfg, { expectedBase: t.base, expectedHead: absent, mergeSha: t.merge });
    expect(c.ok).toBe(false);
    expect(c.fetched).toBe(true);
    expect(c.missing_objects).toContain(absent);
    expect(verifyMergeTreeProof({ computation: c, mergeSha: t.merge, expectedBase: t.base, expectedHead: absent }).reason)
      .toBe(MERGE_TREE_PROOF.MERGE_TREE_OBJECTS_UNAVAILABLE);
  }, 60_000);

  it("BLOCKS an abbreviated or malformed sha instead of resolving it", () => {
    const c = computeMergeTree(cfg, { expectedBase: B0.slice(0, 7), expectedHead: B0, mergeSha: B0 });
    expect(c.ok).toBe(false);
    expect(c.stage).toBe("inputs");
  });

  it("BLOCKS when the repository cannot be read at all", () => {
    const broken = { ...cfg, repoPath: join(dir, "does-not-exist") };
    const c = computeMergeTree(broken, { expectedBase: B0, expectedHead: B0, mergeSha: B0 });
    expect(c.ok).toBe(false);
    expect(c.stage).toBe("object_store");
  });

  it("refuses to fetch from an origin that is not this repository", () => {
    git(repoPath, ["remote", "set-url", "origin", "https://github.com/someone/else"]);
    const absent = "0123456789012345678901234567890123456789";
    const c = computeMergeTree(cfg, { expectedBase: B0, expectedHead: absent, mergeSha: B0 });
    expect(c.ok).toBe(false);
    expect(c.stage).toBe("fetch");
    expect(c.error).toContain("does not point at");
  });
});

/* ==========================================================================
 * THE COMPUTATION TOUCHES NOTHING A HUMAN IS WORKING ON
 * ========================================================================== */

describe("D-158: the proof never mutates the repository it reads", () => {
  let dir;
  let repoPath;
  let cfg;

  /** Every path under a directory, sorted - an exact before/after snapshot. */
  function tree(root) {
    if (!existsSync(root)) return [];
    const out = [];
    const walk = (p, rel) => {
      for (const e of readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const child = join(p, e.name);
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(child, childRel);
        else out.push(childRel);
      }
    };
    walk(root, "");
    return out;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-d158-iso-"));
    repoPath = join(dir, "repo");
    createRepo(repoPath);
    cfg = { repoOwner: "tsworkflow", repoName: "jarvisbuild", repoPath, scratchRoot: join(dir, "worker", "tmp") };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes every new object into scratch and nothing into the repository", () => {
    const B0 = head(repoPath);
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    writeFileSync(join(repoPath, "base-only.txt"), "landed meanwhile\n", "utf8");
    git(repoPath, ["add", "-A"]); git(repoPath, ["commit", "-m", "base"]);
    const base = head(repoPath);
    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    writeFileSync(join(repoPath, "feature.txt"), "reviewed\n", "utf8");
    git(repoPath, ["add", "-A"]); git(repoPath, ["commit", "-m", "head"]);
    const hd = head(repoPath);
    git(repoPath, ["checkout", "--quiet", "-B", "main", base]);
    const merge = syntheticMerge(repoPath, { base, head: hd, tree: realMergeTree(repoPath, base, hd) });

    // `realMergeTree` above already wrote the merged tree into the repo, which is
    // the FIXTURE's doing. Snapshot after it, so what is measured below is only
    // what `computeMergeTree` itself does.
    const objectsBefore = tree(join(repoPath, ".git", "objects"));
    const refsBefore = git(repoPath, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const headBefore = git(repoPath, ["rev-parse", "HEAD"]);
    const statusBefore = git(repoPath, ["status", "--porcelain=v1", "--untracked-files=all"]);

    const c = computeMergeTree(cfg, { expectedBase: base, expectedHead: hd, mergeSha: merge });
    expect(c.ok).toBe(true);

    expect(tree(join(repoPath, ".git", "objects"))).toEqual(objectsBefore);
    expect(git(repoPath, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refsBefore);
    expect(git(repoPath, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(repoPath, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(statusBefore);

    // ...and the store it DID write to is the scratch one, outside the repo.
    expect(c.store_path).toBe(mergeProofStorePath(cfg));
    expect(existsSync(mergeProofStorePath(cfg))).toBe(true);
    expect(mergeProofStorePath(cfg).startsWith(repoPath)).toBe(false);
  });

  it("reuses an existing store rather than deleting and rebuilding it", () => {
    const B0 = head(repoPath);
    const store = mergeProofStorePath(cfg);
    mkdirSync(store, { recursive: true });
    // A file no correct run would remove. If a rebuild ever replaces reuse, this
    // is the assertion that says so - this module deletes nothing, ever.
    writeFileSync(join(store, "do-not-delete.txt"), "evidence from an earlier attempt\n", "utf8");

    computeMergeTree(cfg, { expectedBase: B0, expectedHead: B0, mergeSha: B0 });
    expect(existsSync(join(store, "do-not-delete.txt"))).toBe(true);
  });

  /**
   * D-158: THE ANSWER MUST NOT DEPEND ON THE HOST THAT COMPUTED IT.
   *
   * The expected tree is only a proof if merging those two commits produces the
   * SAME tree everywhere. Rename detection is the setting that can quietly break
   * that: a merge that SEES a rename carries the other side's edits across it,
   * and a merge that does not see it records a delete plus an add instead. Two
   * different trees, both "correct", chosen by whatever `merge.renames` the
   * deployed host happens to have in its config.
   *
   * `gitMergeTree` pins that on the command line, where `-c` outranks repository,
   * global and system config. This drives the case through the real store: a
   * rename plus an edit from the other side - exactly the shape rename detection
   * changes - computed once normally, then again with rename detection turned OFF
   * in the store's own config. Same tree both times, or the pin is not working.
   */
  it("pins rename detection, so a hostile host config cannot move the expected tree", () => {
    const B0 = head(repoPath);

    // base: renames the file. head: edits it under its ORIGINAL name.
    git(repoPath, ["mv", "tracked.txt", "renamed.txt"]);
    git(repoPath, ["commit", "-m", "base renames the file"]);
    const base = head(repoPath);

    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    writeFileSync(join(repoPath, "tracked.txt"), "baseline\nedited by the reviewed head\n", "utf8");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "-m", "head edits it under the old name"]);
    const hd = head(repoPath);
    git(repoPath, ["checkout", "--quiet", "-B", "main", base]);

    const merge = syntheticMerge(repoPath, { base, head: hd, tree: realMergeTree(repoPath, base, hd) });

    const first = computeMergeTree(cfg, { expectedBase: base, expectedHead: hd, mergeSha: merge });
    expect(first.ok).toBe(true);
    expect(first.conflicted).toBe(false);

    // Now poison the store's own config the way a host's global config could.
    // `git init --bare` reuses this store, so these survive into the next run.
    const store = mergeProofStorePath(cfg);
    git(store, ["config", "merge.renames", "false"]);
    git(store, ["config", "diff.renames", "false"]);

    // Verified by removing the pin: without it this run returns
    // `ok: false, conflicted: true` - the rename-blind merge cannot reconcile an
    // edit to a path the other side deleted, so a VALID merge is reported as a
    // CONFLICT and the gate refuses it. That is precisely the false-negative
    // class D-158 exists to close, arriving through a different door.
    const second = computeMergeTree(cfg, { expectedBase: base, expectedHead: hd, mergeSha: merge });
    expect(second.ok).toBe(true);
    expect(second.conflicted).toBe(false);
    expect(second.expected_tree).toBe(first.expected_tree);

    // And the proof still passes on the tree git actually produced.
    expect(verifyMergeTreeProof({
      computation: second, mergeSha: merge, expectedBase: base, expectedHead: hd
    }).ok).toBe(true);
  });
});

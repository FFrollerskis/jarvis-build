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
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MERGE_TREE_PROOF, verifyMergeTreeProof, describeMergeTreeProof } from "../lib/merge-tree-proof.mjs";
import {
  PROOF_OWNER_MARKER,
  computeMergeTree,
  mergeProofEnvPaths,
  mergeProofStorePath,
  mergeProofTaskRoot,
  proofTaskSegment
} from "../lib/merge-tree.mjs";
import { git, createRepo, head, treeOf, parentsOf, syntheticMerge, realMergeTree } from "./fixtures/real-git-repo.mjs";

const BASE = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";
const MERGE = "3333333333333333333333333333333333333333";
const TREE = "4444444444444444444444444444444444444444";
const OTHER_TREE = "5555555555555555555555555555555555555555";
/** D-159: a proof belongs to one admitted task id, so every fixture names one. */
const TASK = "D159-PR84-D158-RECOVERY-CLOSEOUT-20260916-A";
const OTHER_TASK = "D158-PR84-SAME-FILE-MERGE-PROOF-HARDENING-20260915-A";

/**
 * An ownership marker exactly as the module writes one.
 *
 * Deliberately spelled out here instead of imported: a test that built the
 * marker with the same function the code under test uses would agree with a
 * wrong format just as happily as with a right one.
 */
const ownerMarker = (taskId, kind) =>
  `${JSON.stringify({ jarvis_merge_proof_owner: 1, kind, task_id: taskId }, null, 2)}\n`;

/* ==========================================================================
 * THE PURE PROOF
 * ========================================================================== */

/** A complete, correct computation record - one field changed per case. */
const computation = (over = {}) => ({
  attempted: true,
  ok: true,
  stage: "complete",
  error: null,
  store_path: `C:/worker/tmp/${TASK}/merge-proof.git`,
  // D-159: WHOSE store it was is part of a complete record, and the cases below
  // drive "another task's", "explicitly unowned" and "never stated" separately.
  store_owned: true,
  store_owner_task_id: TASK,
  fetched: false,
  fetch_error: null,
  missing_objects: [],
  // D-158 REVIEW-FIX: the conditions the merge was computed under are part of a
  // COMPLETE record, so the canonical fixture states them and the cases below
  // drive each of "false" and "never stated" separately.
  config_isolated: true,
  foreign_config: [],
  custom_merge_drivers: [],
  attribute_files_scanned: 0,
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
  taskId: "taskId" in over ? over.taskId : TASK,
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

/* ==========================================================================
 * D-158 REVIEW-FIX: THE CONDITIONS THE MERGE WAS COMPUTED UNDER
 * ==========================================================================
 *
 * A tree id only means "the authorized merge" if the merge was computed the way
 * an ordinary merge of those two commits is. Git executes whatever a merge
 * driver names and COMMITTED content chooses the driver, so these two are part
 * of the proof, not preconditions someone else is trusted to have checked.
 */

describe("D-158 REVIEW-FIX: a merge computed under uncontrolled configuration is never a pass", () => {
  it("refuses an explicitly non-isolated computation, and names what was out of policy", () => {
    const v = verify({
      computation: computation({
        ok: false,
        stage: "config_isolation",
        config_isolated: false,
        foreign_config: ["file:C:/Users/x/.gitconfig -> merge.evil.driver (not the proof store's own config)"],
        error: "the merge proof would run under configuration this worker does not control"
      })
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_CONFIG_NOT_ISOLATED);
    expect(v.detail).toContain("merge.evil.driver");
    expect(v.evidence.computation.config_isolated).toBe(false);
  });

  it("refuses an UNSTATED configuration even on a record that claims success", () => {
    // The pre-review record shape: complete, ok, and silent about the
    // configuration it ran under. Silence is refused exactly like false.
    const v = verify({ computation: computation({ config_isolated: undefined }) });
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_CONFIG_NOT_ISOLATED);
    expect(v.detail).toContain("unstated condition is not a satisfied one");
  });

  it("refuses when the content requests a non-built-in merge driver", () => {
    const v = verify({
      computation: computation({
        ok: false,
        stage: "attributes",
        custom_merge_drivers: [`${BASE.slice(0, 12)}:.gitattributes -> merge=evil`],
        error: "the content being merged requests a non-built-in merge driver"
      })
    });
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_DRIVER_REQUESTED);
    expect(v.evidence.computation.custom_merge_drivers).toHaveLength(1);
  });

  it("refuses a driver request even when the record otherwise claims success", () => {
    expect(verify({ computation: computation({ custom_merge_drivers: ["x:.gitattributes -> merge=evil"] }) }).reason)
      .toBe(MERGE_TREE_PROOF.MERGE_TREE_DRIVER_REQUESTED);
  });

  it("refuses when the driver question was never asked", () => {
    const v = verify({ computation: computation({ custom_merge_drivers: null }) });
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_DRIVER_REQUESTED);
    expect(v.detail).toContain("unanswered question is not an answer of no");
  });

  it("states both conditions in the passing detail, so a pass is readable", () => {
    expect(verify().detail).toContain("configuration this worker controls");
    expect(verify().detail).toContain("no non-built-in merge driver");
  });

  it("describes the conditions for a status comment", () => {
    const lines = describeMergeTreeProof(verify().evidence).join("\n");
    expect(lines).toContain("isolated, allowlisted git configuration");
    expect(lines).toContain("merge drivers requested by content: none");
  });
});

/**
 * D-159: ...AND IN A DIRECTORY THIS EXACT TASK OWNS.
 *
 * Architect review 5217710904 (P1): isolating and allowlisting the git
 * CONFIGURATION says nothing about who owns the FILES. The pure decider is the
 * last place that can refuse a record produced somewhere shared, so it refuses
 * four distinguishable things - no task named, ownership denied, ownership never
 * claimed, and ownership claimed by somebody else.
 */
describe("D-159: a merge computed in a store this task does not own is never a pass", () => {
  it("refuses a proof that does not name the task it decides", () => {
    const v = verify({ taskId: null });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_STORE_NOT_TASK_OWNED);
    expect(v.detail).toContain("without naming the task it decides");
  });

  it("refuses a blank task id exactly like a missing one", () => {
    expect(verify({ taskId: "   " }).reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_STORE_NOT_TASK_OWNED);
  });

  it("refuses an explicitly unowned store and repeats what went wrong", () => {
    const v = verify({
      computation: computation({
        ok: false,
        stage: "store_ownership",
        store_owned: false,
        store_owner_task_id: TASK,
        error: `C:/worker/tmp/${TASK}/merge-proof.git already exists but carries no ${PROOF_OWNER_MARKER}`
      })
    });
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_STORE_NOT_TASK_OWNED);
    expect(v.detail).toContain(PROOF_OWNER_MARKER);
    expect(v.evidence.computation.store_owned).toBe(false);
  });

  it("refuses an UNSTATED ownership claim even on a record that claims success", () => {
    // The pre-D-159 record shape: complete, ok, and silent about whose store it
    // ran in. Silence is refused exactly like a denial.
    const v = verify({ computation: computation({ store_owned: undefined, store_owner_task_id: undefined }) });
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_STORE_NOT_TASK_OWNED);
    expect(v.detail).toContain("unstated claim of ownership is not ownership");
  });

  it("refuses evidence produced for a DIFFERENT task, however complete it is", () => {
    const v = verify({ computation: computation({ store_owner_task_id: OTHER_TASK }) });
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_STORE_NOT_TASK_OWNED);
    expect(v.detail).toContain(OTHER_TASK);
    expect(v.detail).toContain("does not decide another");
  });

  it("asks about ownership BEFORE anything else about the result", () => {
    // A record that is unowned AND conflicted AND non-isolated must report the
    // ownership failure: the others are claims about evidence that may not even
    // be this task's.
    const v = verify({
      computation: computation({
        ok: false, store_owned: false, conflicted: true, config_isolated: false,
        missing_objects: [BASE]
      })
    });
    expect(v.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_STORE_NOT_TASK_OWNED);
  });

  it("names the owning task in the passing detail and in the description", () => {
    expect(verify().detail).toContain(`bound to this task (${TASK})`);
    const lines = describeMergeTreeProof(verify().evidence).join("\n");
    expect(lines).toContain(`owned by task ${TASK}`);
  });

  it("says so in the description when ownership was denied or never stated", () => {
    expect(describeMergeTreeProof(verify({ computation: computation({ store_owned: false }) }).evidence).join("\n"))
      .toContain("NO TASK THIS WORKER COULD PROVE");
    expect(describeMergeTreeProof(verify({ computation: computation({ store_owned: undefined }) }).evidence).join("\n"))
      .toContain("an UNSTATED owner");
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
    const c = computeMergeTree(cfg, { expectedBase: base, expectedHead: hd, mergeSha: merge, taskId: TASK });
    return {
      computation: c,
      verdict: verifyMergeTreeProof({
        computation: c,
        mergeSha: merge,
        expectedBase: base,
        expectedHead: hd,
        taskId: TASK,
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

    const c = computeMergeTree(cfg, { expectedBase: base, expectedHead: hd, mergeSha: merge, taskId: TASK });
    expect(c.ok).toBe(false);
    expect(c.conflicted).toBe(true);
    expect(c.expected_tree).toBe(null);
    expect(c.conflict_detail).toContain("f.txt");

    const v = verifyMergeTreeProof({ computation: c, mergeSha: merge, expectedBase: base, expectedHead: hd, taskId: TASK });
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
    const c = computeMergeTree(cfg, { expectedBase: t.base, expectedHead: absent, mergeSha: t.merge, taskId: TASK });
    expect(c.ok).toBe(false);
    expect(c.fetched).toBe(true);
    expect(c.missing_objects).toContain(absent);
    expect(verifyMergeTreeProof({ computation: c, mergeSha: t.merge, expectedBase: t.base, expectedHead: absent, taskId: TASK }).reason)
      .toBe(MERGE_TREE_PROOF.MERGE_TREE_OBJECTS_UNAVAILABLE);
  }, 60_000);

  it("BLOCKS an abbreviated or malformed sha instead of resolving it", () => {
    const c = computeMergeTree(cfg, { expectedBase: B0.slice(0, 7), expectedHead: B0, mergeSha: B0, taskId: TASK });
    expect(c.ok).toBe(false);
    expect(c.stage).toBe("inputs");
  });

  it("BLOCKS when the repository cannot be read at all", () => {
    const broken = { ...cfg, repoPath: join(dir, "does-not-exist") };
    const c = computeMergeTree(broken, { expectedBase: B0, expectedHead: B0, mergeSha: B0, taskId: TASK });
    expect(c.ok).toBe(false);
    expect(c.stage).toBe("object_store");
  });

  it("refuses to fetch from an origin that is not this repository", () => {
    git(repoPath, ["remote", "set-url", "origin", "https://github.com/someone/else"]);
    const absent = "0123456789012345678901234567890123456789";
    const c = computeMergeTree(cfg, { expectedBase: B0, expectedHead: absent, mergeSha: B0, taskId: TASK });
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

    const c = computeMergeTree(cfg, { expectedBase: base, expectedHead: hd, mergeSha: merge, taskId: TASK });
    expect(c.ok).toBe(true);

    expect(tree(join(repoPath, ".git", "objects"))).toEqual(objectsBefore);
    expect(git(repoPath, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refsBefore);
    expect(git(repoPath, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(repoPath, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(statusBefore);

    // ...and the store it DID write to is THIS TASK's, under scratch, outside
    // the repo - and it says whose it is (D-159).
    expect(c.store_path).toBe(mergeProofStorePath(cfg, TASK));
    expect(existsSync(mergeProofStorePath(cfg, TASK))).toBe(true);
    expect(mergeProofStorePath(cfg, TASK).startsWith(repoPath)).toBe(false);
    expect(mergeProofStorePath(cfg, TASK).startsWith(join(cfg.scratchRoot, TASK))).toBe(true);
    expect(c.store_owned).toBe(true);
    expect(c.store_owner_task_id).toBe(TASK);
  });

  it("resumes its OWN store rather than deleting and rebuilding it", () => {
    const B0 = head(repoPath);
    const store = mergeProofStorePath(cfg, TASK);
    mkdirSync(store, { recursive: true });
    // D-159: an earlier attempt OF THIS TASK left the store behind, marker and
    // all. Reuse stays additive: the objects it had to fetch are still there.
    writeFileSync(join(store, PROOF_OWNER_MARKER), ownerMarker(TASK, "merge-proof-store"), "utf8");
    // A file no correct run would remove. If a rebuild ever replaces reuse, this
    // is the assertion that says so - this module deletes nothing, ever.
    writeFileSync(join(store, "do-not-delete.txt"), "evidence from an earlier attempt\n", "utf8");

    const c = computeMergeTree(cfg, { expectedBase: B0, expectedHead: B0, mergeSha: B0, taskId: TASK });
    expect(existsSync(join(store, "do-not-delete.txt"))).toBe(true);
    expect(c.store_owned).toBe(true);
    expect(c.store_owner_task_id).toBe(TASK);
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

    const first = computeMergeTree(cfg, { expectedBase: base, expectedHead: hd, mergeSha: merge, taskId: TASK });
    expect(first.ok).toBe(true);
    expect(first.conflicted).toBe(false);

    // Now poison the HOST's global config, which is where a deployed worker
    // would really meet this - `merge.renames=false` in somebody's ~/.gitconfig.
    //
    // Verified by removing the pin: without it this run returns
    // `ok: false, conflicted: true` - the rename-blind merge cannot reconcile an
    // edit to a path the other side deleted, so a VALID merge is reported as a
    // CONFLICT and the gate refuses it. That is precisely the false-negative
    // class D-158 exists to close, arriving through a different door.
    const hostileGlobal = join(dir, "hostile.gitconfig");
    writeFileSync(hostileGlobal, "[merge]\n\trenames = false\n[diff]\n\trenames = false\n", "utf8");
    const restore = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = hostileGlobal;
    let second;
    try {
      second = computeMergeTree(cfg, { expectedBase: base, expectedHead: hd, mergeSha: merge, taskId: TASK });
    } finally {
      if (restore === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = restore;
    }
    expect(second.ok).toBe(true);
    expect(second.conflicted).toBe(false);
    expect(second.expected_tree).toBe(first.expected_tree);
    expect(second.config_isolated).toBe(true);

    // And the proof still passes on the tree git actually produced.
    expect(verifyMergeTreeProof({
      computation: second, mergeSha: merge, expectedBase: base, expectedHead: hd, taskId: TASK
    }).ok).toBe(true);
  });

  /**
   * D-158 REVIEW-FIX: and a poisoned STORE is refused outright.
   *
   * The store is reused between gates on purpose, so anything left in its own
   * config outlives the run that put it there. Before this fix such a key simply
   * applied; now it is not "outranked", it is a NAMED REFUSAL - because a key
   * that can move the tree could equally have been one that names a command.
   */
  it("REFUSES a proof store whose own config carries anything outside the allowlist", () => {
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
    const args = { expectedBase: base, expectedHead: hd, mergeSha: merge, taskId: TASK };

    expect(computeMergeTree(cfg, args).ok).toBe(true);

    git(mergeProofStorePath(cfg, TASK), ["config", "merge.renames", "false"]);

    const c = computeMergeTree(cfg, args);
    expect(c.ok).toBe(false);
    expect(c.stage).toBe("config_isolation");
    expect(c.config_isolated).toBe(false);
    expect(c.foreign_config.join(" ")).toContain("merge.renames");
    const verdict = verifyMergeTreeProof({ computation: c, mergeSha: merge, expectedBase: base, expectedHead: hd, taskId: TASK });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_CONFIG_NOT_ISOLATED);
  });
});

/* ==========================================================================
 * D-158 REVIEW-FIX: REPOSITORY CONTENT MAY NOT SELECT A COMMAND
 * ==========================================================================
 *
 * Architect review 5216915623 (P1) on PR #84. The first version of this proof
 * passed no environment, so `git merge-tree` inherited the host's - and git's
 * merge machinery runs whatever `merge.<driver>.driver` names, with a COMMITTED
 * `.gitattributes` choosing the driver.
 *
 * The first test below EXECUTES THE DEFECT rather than describing it: the same
 * two commits, merged the way the unfixed code merged them, actually run the
 * driver and write a marker file. Everything after it is the fix refusing to.
 * A security property that is only argued for in a comment is not tested.
 */

describe("D-158 REVIEW-FIX: no merge driver may execute during the proof", () => {
  let dir;
  let repoPath;
  let cfg;
  let marker;
  let driverScript;
  let hostileGlobal;
  const savedEnv = {};

  /** base and head edit different hunks of ONE attributed file. */
  const lines = (over = {}) => `${Array.from({ length: 10 }, (_, i) => over[i + 1] ?? `l${i + 1}`).join("\n")}\n`;

  /**
   * The same-file/non-overlap topology, with `.gitattributes` committed on the
   * SHARED ANCESTOR so both sides carry it - which is how a repository really
   * attributes its own content.
   *
   * `nested` adds a second attributes file in a subdirectory. `realMerge` asks
   * git for the true merge tree; the refusal cases deliberately do not, because
   * a fixture must not have to perform the merge the gate is about to refuse.
   */
  const topology = ({ attributes, nested = null, realMerge = false }) => {
    writeFileSync(join(repoPath, "attributed.txt"), lines(), "utf8");
    writeFileSync(join(repoPath, ".gitattributes"), attributes, "utf8");
    if (nested !== null) {
      mkdirSync(join(repoPath, "sub"), { recursive: true });
      writeFileSync(join(repoPath, "sub", ".gitattributes"), nested, "utf8");
      writeFileSync(join(repoPath, "sub", "note.md"), "a file the nested rule matches\n", "utf8");
    }
    git(repoPath, ["add", "-A"]); git(repoPath, ["commit", "-m", "b0: attributed content"]);
    const B0 = head(repoPath);

    writeFileSync(join(repoPath, "attributed.txt"), lines({ 10: "changed by the head" }), "utf8");
    git(repoPath, ["add", "-A"]); git(repoPath, ["commit", "-m", "head: the reviewed change"]);
    const headSha = head(repoPath);

    git(repoPath, ["checkout", "--quiet", "--detach", B0]);
    writeFileSync(join(repoPath, "attributed.txt"), lines({ 1: "changed on the base" }), "utf8");
    git(repoPath, ["add", "-A"]); git(repoPath, ["commit", "-m", "base: work that landed meanwhile"]);
    const baseSha = head(repoPath);
    git(repoPath, ["checkout", "--quiet", "-B", "main", baseSha]);

    const mergeSha = syntheticMerge(repoPath, {
      base: baseSha,
      head: headSha,
      tree: realMerge ? realMergeTree(repoPath, baseSha, headSha) : treeOf(repoPath, headSha)
    });
    return {
      base: baseSha, head: headSha, merge: mergeSha,
      args: { expectedBase: baseSha, expectedHead: headSha, mergeSha, taskId: TASK }
    };
  };

  const proveIt = (t, c) => verifyMergeTreeProof({
    computation: c, mergeSha: t.merge, expectedBase: t.base, expectedHead: t.head, taskId: TASK
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-d158-drv-"));
    repoPath = join(dir, "repo");
    createRepo(repoPath);
    cfg = { repoOwner: "tsworkflow", repoName: "jarvisbuild", repoPath, scratchRoot: join(dir, "worker", "tmp") };

    // A driver that proves it ran, by writing a file nothing else writes.
    marker = join(dir, "DRIVER-EXECUTED");
    driverScript = join(dir, "driver.mjs");
    writeFileSync(driverScript, "import { writeFileSync } from \"node:fs\";\n"
      + `writeFileSync(${JSON.stringify(marker)}, "the merge driver ran\\n");\n`
      + "process.exit(0);\n", "utf8");
    hostileGlobal = join(dir, "hostile.gitconfig");
    writeFileSync(hostileGlobal,
      "[merge \"evil\"]\n\tname = a driver the repository asked for\n"
      + `\tdriver = node ${driverScript.replace(/\\/g, "/")} %A %O %B\n`, "utf8");
  });

  afterEach(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
      delete savedEnv[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Put the hostile definition where a real host would have it. */
  const poisonHostEnvironment = () => {
    for (const key of ["GIT_CONFIG_GLOBAL", "HOME", "USERPROFILE"]) savedEnv[key] = process.env[key];
    process.env.GIT_CONFIG_GLOBAL = hostileGlobal;
    const fakeHome = join(dir, "home");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, ".gitconfig"),
      `[merge "evil"]\n\tdriver = node ${driverScript.replace(/\\/g, "/")} %A %O %B\n`, "utf8");
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  };

  it("THE DEFECT, EXECUTED: an inherited host config runs the driver on these very commits", () => {
    // This is what the pre-fix proof did - `git merge-tree` with the process's
    // own environment. It is run here against the real objects so that "content
    // could select a host command" is a measured fact, not a claim.
    const t = topology({ attributes: "*.txt merge=evil\n" });
    poisonHostEnvironment();
    expect(existsSync(marker)).toBe(false);

    const res = spawnSync("git", ["merge-tree", "--write-tree", t.base, t.head], {
      cwd: repoPath, encoding: "utf8", windowsHide: true, env: process.env
    });

    expect(res.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it("...and the ISOLATED proof neither runs it nor accepts the merge", () => {
    const t = topology({ attributes: "*.txt merge=evil\n" });
    poisonHostEnvironment();

    const c = computeMergeTree(cfg, t.args);

    // Nothing ran: the driver is not defined under the proof's configuration,
    // and the content that asked for it is refused before the merge is computed.
    expect(existsSync(marker)).toBe(false);
    // The host's global config never reached the computation...
    expect(c.config_isolated).toBe(true);
    expect(c.foreign_config).toEqual([]);
    // ...and the request itself is the refusal.
    expect(c.ok).toBe(false);
    expect(c.stage).toBe("attributes");
    expect(c.custom_merge_drivers.join(" ")).toContain("merge=evil");

    const verdict = proveIt(t, c);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_DRIVER_REQUESTED);
  });

  it("refuses a requested driver even when NO hostile config exists anywhere", () => {
    // The driver is undefined, so git would silently fall back to its built-in
    // merge - a different tree from the one a machine holding the driver
    // computes. Fail closed on the ambiguity rather than pick one of them.
    const t = topology({ attributes: "*.txt merge=evil\n" });
    const c = computeMergeTree(cfg, t.args);
    expect(existsSync(marker)).toBe(false);
    expect(c.ok).toBe(false);
    expect(c.stage).toBe("attributes");
    expect(proveIt(t, c).reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_DRIVER_REQUESTED);
  });

  it("refuses a driver requested from a NESTED .gitattributes, and from a MACRO", () => {
    const t = topology({
      attributes: "[attr]mine merge=evil\n*.txt mine\n",
      nested: "*.md merge=alsoevil\n"
    });
    const c = computeMergeTree(cfg, t.args);
    expect(c.ok).toBe(false);
    expect(c.custom_merge_drivers.join(" ")).toContain("merge=evil");
    expect(c.custom_merge_drivers.join(" ")).toContain("merge=alsoevil");
    expect(c.attribute_files_scanned).toBeGreaterThan(1);
  });

  it("PASSES ordinary attributes: text, union, -merge and binary are all built in", () => {
    // The refusal must be narrow. These are the attributes real repositories
    // carry, and none of them can name a command.
    const t = topology({
      attributes: "* text=auto\n*.lock -merge\n*.log merge=union\n*.png binary\n*.bin merge=binary\n",
      realMerge: true
    });
    const c = computeMergeTree(cfg, t.args);
    expect(c.ok).toBe(true);
    expect(c.custom_merge_drivers).toEqual([]);
    expect(c.attribute_files_scanned).toBeGreaterThan(0);
    expect(proveIt(t, c).ok).toBe(true);
  });

  it("ignores a commented-out driver request rather than refusing on the word", () => {
    const t = topology({ attributes: "# *.txt merge=evil\n* text=auto\n", realMerge: true });
    const c = computeMergeTree(cfg, t.args);
    expect(c.ok).toBe(true);
    expect(c.custom_merge_drivers).toEqual([]);
    expect(proveIt(t, c).ok).toBe(true);
  });

  it("REFUSES an include.path in the store, which is how a driver would be smuggled back in", () => {
    // An include resolves to its OWN origin in `config --list --show-origin`,
    // which is exactly what makes it detectable instead of invisible.
    const t = topology({ attributes: "* text=auto\n", realMerge: true });
    expect(computeMergeTree(cfg, t.args).ok).toBe(true);

    git(mergeProofStorePath(cfg, TASK), ["config", "include.path", hostileGlobal.replace(/\\/g, "/")]);

    const c = computeMergeTree(cfg, t.args);
    expect(existsSync(marker)).toBe(false);
    expect(c.config_isolated).toBe(false);
    expect(c.foreign_config.join(" ")).toContain("merge.evil.driver");
    expect(proveIt(t, c).reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_CONFIG_NOT_ISOLATED);
  });

  it("removes a stale info/attributes from the reused store rather than obeying it", () => {
    // `$GIT_DIR/info/attributes` is an attributes source that lives outside
    // every tree, so a leftover one could attribute content that never asked.
    const t = topology({ attributes: "* text=auto\n", realMerge: true });
    expect(computeMergeTree(cfg, t.args).ok).toBe(true);

    const info = join(mergeProofStorePath(cfg, TASK), "info");
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, "attributes"), "*.txt merge=evil\n", "utf8");

    const c = computeMergeTree(cfg, t.args);
    expect(existsSync(join(info, "attributes"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(c.ok).toBe(true);
    expect(proveIt(t, c).ok).toBe(true);
  });

  it("neither merge.default, renormalization nor an out-of-tree attributes file can move the tree", () => {
    // The review named these three by name. `merge.default` selects a driver for
    // paths with NO merge attribute - it does not need `.gitattributes` at all -
    // `core.attributesFile` attributes content from outside every tree, and
    // `merge.renormalize` re-normalises line endings before merging.
    const t = topology({ attributes: "* text=auto\n", realMerge: true });
    const clean = computeMergeTree(cfg, t.args);
    expect(clean.ok).toBe(true);

    const hostileAttributes = join(dir, "hostile.gitattributes");
    writeFileSync(hostileAttributes, "*.txt merge=evil\n", "utf8");
    writeFileSync(hostileGlobal,
      "[merge \"evil\"]\n"
      + `\tdriver = node ${driverScript.replace(/\\/g, "/")} %A %O %B\n`
      + "[merge]\n\tdefault = evil\n\trenormalize = true\n"
      + `[core]\n\tattributesFile = ${hostileAttributes.replace(/\\/g, "/")}\n\tautocrlf = true\n`, "utf8");
    poisonHostEnvironment();

    const poisoned = computeMergeTree(cfg, t.args);

    expect(existsSync(marker)).toBe(false);
    expect(poisoned.config_isolated).toBe(true);
    expect(poisoned.ok).toBe(true);
    // The same two commits, the same tree - the host contributed nothing.
    expect(poisoned.expected_tree).toBe(clean.expected_tree);
    expect(poisoned.expected_tree).toBe(treeOf(repoPath, t.merge));
    expect(proveIt(t, poisoned).ok).toBe(true);
  });

  it("strips environment-injected configuration, which outranks every file", () => {
    // `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` are `-c` by another name: a
    // supervisor's environment could define a driver with no file on disk
    // saying so, and an environment variable beats every config file.
    for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) savedEnv[key] = process.env[key];
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "merge.evil.driver";
    process.env.GIT_CONFIG_VALUE_0 = `node ${driverScript.replace(/\\/g, "/")} %A %O %B`;

    const t = topology({ attributes: "* text=auto\n", realMerge: true });
    const c = computeMergeTree(cfg, t.args);
    expect(existsSync(marker)).toBe(false);
    expect(c.config_isolated).toBe(true);
    expect(c.foreign_config).toEqual([]);
    expect(c.ok).toBe(true);
    expect(proveIt(t, c).ok).toBe(true);
  });
});

/* ==========================================================================
 * D-159: THE PROOF'S WORKING DIRECTORIES BELONG TO ONE TASK ID
 * ==========================================================================
 *
 * Architect review 5217710904 on PR #84 (P1). D-158 put the store and the
 * isolated environment at a FIXED place under `scratchRoot`, shared by every
 * task on the host, and then reused them - truncating the env files,
 * overwriting `objects/info/alternates`, force-removing `info/attributes`.
 * Isolating the CONFIGURATION says nothing about who owns the FILES.
 *
 * These are filesystem claims, so they are measured against the real
 * filesystem: what exists before, what exists after, and byte for byte whether
 * anything the task could not prove it owned was touched at all.
 */

describe("D-159: the merge proof works only in a directory this task owns", () => {
  let dir;
  let repoPath;
  let cfg;
  let B0;

  /** Every file under a directory with its exact bytes - an unforgeable before/after. */
  function snapshot(root) {
    const out = new Map();
    if (!existsSync(root)) return out;
    const walk = (p, rel) => {
      for (const e of readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const child = join(p, e.name);
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(child, childRel);
        else out.set(childRel, readFileSync(child));
      }
    };
    walk(root, "");
    return out;
  }

  const same = (a, b) => a.size === b.size
    && [...a.keys()].every((k) => b.has(k) && Buffer.compare(a.get(k), b.get(k)) === 0);

  /**
   * A directory link that works on Windows WITHOUT elevation.
   *
   * `junction` is a reparse point rather than a symbolic link, which is exactly
   * the case the review names: Node reports it through `lstat` as a symbolic
   * link, and a naive recursive `mkdir` would happily write through it.
   */
  const linkDir = (target, path) => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-d159-"));
    repoPath = join(dir, "repo");
    createRepo(repoPath);
    B0 = head(repoPath);
    cfg = { repoOwner: "tsworkflow", repoName: "jarvisbuild", repoPath, scratchRoot: join(dir, "worker", "tmp") };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (taskId) => computeMergeTree(cfg, { expectedBase: B0, expectedHead: B0, mergeSha: B0, taskId });

  /* --- where the directories are, and whose they are ---------------------- */

  it("places the store and the environment under THIS task's own scratch directory", () => {
    expect(mergeProofTaskRoot(cfg, TASK)).toBe(join(cfg.scratchRoot, TASK));
    expect(mergeProofStorePath(cfg, TASK)).toBe(join(cfg.scratchRoot, TASK, "merge-proof.git"));
    expect(mergeProofEnvPaths(cfg, TASK).root).toBe(join(cfg.scratchRoot, TASK, "merge-proof-env"));
  });

  it("stamps both directories with a marker naming this exact task", () => {
    const c = run(TASK);
    expect(c.store_owned).toBe(true);
    expect(c.store_owner_task_id).toBe(TASK);

    const storeMarker = join(mergeProofStorePath(cfg, TASK), PROOF_OWNER_MARKER);
    const envMarker = join(mergeProofEnvPaths(cfg, TASK).root, PROOF_OWNER_MARKER);
    expect(readFileSync(storeMarker, "utf8")).toBe(ownerMarker(TASK, "merge-proof-store"));
    expect(readFileSync(envMarker, "utf8")).toBe(ownerMarker(TASK, "merge-proof-env"));
  });

  it("gives two different task ids two different stores, and neither decides the other", () => {
    const mine = run(TASK);
    const theirs = run(OTHER_TASK);

    expect(mine.store_path).not.toBe(theirs.store_path);
    expect(mine.store_owner_task_id).toBe(TASK);
    expect(theirs.store_owner_task_id).toBe(OTHER_TASK);
    expect(readFileSync(join(theirs.store_path, PROOF_OWNER_MARKER), "utf8"))
      .toBe(ownerMarker(OTHER_TASK, "merge-proof-store"));

    // ...and the decider will not let one task's evidence settle the other's gate.
    expect(verifyMergeTreeProof({
      computation: theirs, mergeSha: B0, expectedBase: B0, expectedHead: B0, taskId: TASK
    }).reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_STORE_NOT_TASK_OWNED);
  });

  /* --- a directory it cannot prove it owns is refused, and left alone ----- */

  it("REFUSES an unmarked pre-existing store and changes not one byte of it", () => {
    const store = mergeProofStorePath(cfg, TASK);
    mkdirSync(join(store, "objects", "info"), { recursive: true });
    mkdirSync(join(store, "info"), { recursive: true });
    // Exactly the three things D-158 would have overwritten or force-removed.
    writeFileSync(join(store, "config"), "[core]\n\tbare = true\n[merge \"evil\"]\n\tdriver = whoami\n", "utf8");
    writeFileSync(join(store, "objects", "info", "alternates"), "D:/somebody/elses/objects\n", "utf8");
    writeFileSync(join(store, "info", "attributes"), "* merge=evil\n", "utf8");
    const before = snapshot(store);

    const c = run(TASK);
    expect(c.ok).toBe(false);
    expect(c.stage).toBe("store_ownership");
    expect(c.store_owned).toBe(false);
    expect(c.error).toContain(PROOF_OWNER_MARKER);
    expect(c.error).toContain("left exactly as found");

    expect(same(before, snapshot(store))).toBe(true);
    expect(existsSync(join(store, PROOF_OWNER_MARKER))).toBe(false);
    expect(verifyMergeTreeProof({
      computation: c, mergeSha: B0, expectedBase: B0, expectedHead: B0, taskId: TASK
    }).reason).toBe(MERGE_TREE_PROOF.MERGE_TREE_STORE_NOT_TASK_OWNED);
  });

  it("REFUSES a store another task owns, and leaves that task's work intact", () => {
    const store = mergeProofStorePath(cfg, TASK);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, PROOF_OWNER_MARKER), ownerMarker(OTHER_TASK, "merge-proof-store"), "utf8");
    writeFileSync(join(store, "their-evidence.txt"), "another task's fetched objects\n", "utf8");
    const before = snapshot(store);

    const c = run(TASK);
    expect(c.ok).toBe(false);
    expect(c.stage).toBe("store_ownership");
    expect(c.store_owned).toBe(false);
    expect(c.error).toContain(OTHER_TASK);

    expect(same(before, snapshot(store))).toBe(true);
  });

  it("REFUSES a marker it cannot read as an ownership claim rather than replacing it", () => {
    const store = mergeProofStorePath(cfg, TASK);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, PROOF_OWNER_MARKER), "{ this is not json", "utf8");
    const before = snapshot(store);

    const c = run(TASK);
    expect(c.ok).toBe(false);
    expect(c.store_owned).toBe(false);
    expect(same(before, snapshot(store))).toBe(true);
  });

  it("REFUSES a marker from an unknown future version rather than assuming its meaning", () => {
    const store = mergeProofStorePath(cfg, TASK);
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, PROOF_OWNER_MARKER),
      `${JSON.stringify({ jarvis_merge_proof_owner: 99, kind: "merge-proof-store", task_id: TASK })}\n`,
      "utf8"
    );
    expect(run(TASK).store_owned).toBe(false);
  });

  it("REFUSES a marker of the wrong KIND, so the env and the store cannot be swapped", () => {
    const store = mergeProofStorePath(cfg, TASK);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, PROOF_OWNER_MARKER), ownerMarker(TASK, "merge-proof-env"), "utf8");
    expect(run(TASK).store_owned).toBe(false);
  });

  it("REFUSES an unmarked ENVIRONMENT directory and never truncates the files in it", () => {
    const env = mergeProofEnvPaths(cfg, TASK);
    mkdirSync(env.emptyHome, { recursive: true });
    // D-158 truncated these on every run. Here they are somebody else's.
    writeFileSync(env.emptyConfig, "[merge \"evil\"]\n\tdriver = whoami\n", "utf8");
    writeFileSync(env.emptyAttributes, "* merge=evil\n", "utf8");
    const before = snapshot(env.root);

    const c = run(TASK);
    expect(c.ok).toBe(false);
    expect(c.stage).toBe("environment");
    expect(c.store_owned).toBe(false);
    expect(same(before, snapshot(env.root))).toBe(true);
    // The store is never even reached, so nothing was created for it either.
    expect(existsSync(mergeProofStorePath(cfg, TASK))).toBe(false);
  });

  /* --- and nothing is reached through a link ------------------------------ */

  it("REFUSES a store reached through a junction or symlink, and writes nothing through it", () => {
    const elsewhere = join(dir, "not-the-task-directory");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "someone-elses.txt"), "not this task's\n", "utf8");
    const before = snapshot(elsewhere);

    mkdirSync(mergeProofTaskRoot(cfg, TASK), { recursive: true });
    linkDir(elsewhere, mergeProofStorePath(cfg, TASK));

    const c = run(TASK);
    expect(c.ok).toBe(false);
    expect(c.stage).toBe("store_ownership");
    expect(c.store_owned).toBe(false);
    expect(c.error).toMatch(/symbolic link, junction or other reparse point/);

    // Nothing was created, initialised or stamped on the far side of the link.
    expect(same(before, snapshot(elsewhere))).toBe(true);
  });

  it("REFUSES an ENVIRONMENT reached through a junction or symlink", () => {
    const elsewhere = join(dir, "env-elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "keep.gitconfig"), "[user]\n\tname = somebody\n", "utf8");
    const before = snapshot(elsewhere);

    mkdirSync(mergeProofTaskRoot(cfg, TASK), { recursive: true });
    linkDir(elsewhere, mergeProofEnvPaths(cfg, TASK).root);

    const c = run(TASK);
    expect(c.ok).toBe(false);
    expect(c.stage).toBe("environment");
    expect(same(before, snapshot(elsewhere))).toBe(true);
  });

  it("REFUSES a TASK ROOT that is itself a link, not just the leaf directory", () => {
    const elsewhere = join(dir, "task-root-elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const before = snapshot(elsewhere);

    mkdirSync(cfg.scratchRoot, { recursive: true });
    linkDir(elsewhere, mergeProofTaskRoot(cfg, TASK));

    const c = run(TASK);
    expect(c.ok).toBe(false);
    expect(c.store_owned).toBe(false);
    expect(same(before, snapshot(elsewhere))).toBe(true);
  });

  it("REFUSES a path component that exists but is a FILE", () => {
    mkdirSync(cfg.scratchRoot, { recursive: true });
    writeFileSync(mergeProofTaskRoot(cfg, TASK), "not a directory\n", "utf8");

    const c = run(TASK);
    expect(c.ok).toBe(false);
    expect(c.store_owned).toBe(false);
    expect(c.error).toContain("not a directory");
    expect(readFileSync(mergeProofTaskRoot(cfg, TASK), "utf8")).toBe("not a directory\n");
  });

  /* --- a task id that is not a path segment is not a task id -------------- */

  it("REFUSES a task id that could leave the scratch root, and creates nothing", () => {
    const escapes = [
      "..", ".", "../../escaped", "..\\..\\escaped", "a/b", "a\\b", "C:evil",
      "", "   ", null, undefined, 42, ".hidden-leading-dot", "x".repeat(200)
    ];
    for (const taskId of escapes) {
      expect(proofTaskSegment(taskId)).toBe(null);
      expect(mergeProofStorePath(cfg, taskId)).toBe(null);
      expect(mergeProofEnvPaths(cfg, taskId)).toBe(null);
      const c = computeMergeTree(cfg, { expectedBase: B0, expectedHead: B0, mergeSha: B0, taskId });
      expect(c.ok).toBe(false);
      expect(c.stage).toBe("store_ownership");
      expect(c.store_owned).toBe(false);
    }
    // Not one of them brought a directory into existence anywhere.
    expect(existsSync(cfg.scratchRoot)).toBe(false);
    expect(existsSync(join(dir, "worker"))).toBe(false);
  });

  it("accepts the real task-id shape this worker is admitted under", () => {
    for (const id of [TASK, OTHER_TASK, "D-159", "a", "worker_2.3.0-rc1"]) {
      expect(proofTaskSegment(id)).toBe(id);
    }
    // Surrounding whitespace is trimmed, not treated as a different task.
    expect(proofTaskSegment(`  ${TASK}  `)).toBe(TASK);
  });

  /* --- reuse stays additive for the task that owns it --------------------- */

  it("resumes its OWN store across attempts without deleting anything in it", () => {
    const first = run(TASK);
    expect(first.ok).toBe(true);
    const store = first.store_path;
    writeFileSync(join(store, "fetched-earlier.txt"), "objects an earlier attempt paid for\n", "utf8");

    const second = run(TASK);
    expect(second.ok).toBe(true);
    expect(second.store_path).toBe(store);
    expect(readFileSync(join(store, "fetched-earlier.txt"), "utf8"))
      .toBe("objects an earlier attempt paid for\n");
    expect(readFileSync(join(store, PROOF_OWNER_MARKER), "utf8")).toBe(ownerMarker(TASK, "merge-proof-store"));
  });

  it("still removes a stale info/attributes - but only from the store it owns", () => {
    expect(run(TASK).ok).toBe(true);
    const store = mergeProofStorePath(cfg, TASK);
    mkdirSync(join(store, "info"), { recursive: true });
    writeFileSync(join(store, "info", "attributes"), "* merge=evil\n", "utf8");

    expect(run(TASK).ok).toBe(true);
    expect(existsSync(join(store, "info", "attributes"))).toBe(false);
  });
});

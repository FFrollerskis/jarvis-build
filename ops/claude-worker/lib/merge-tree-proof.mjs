/**
 * D-158: IS THIS MERGE COMMIT *THE* MERGE OF THE TWO COMMITS THAT WERE AUTHORIZED?
 *
 * ------------------------------------------------------------------------
 * THE CONTROL-PLANE FALSE NEGATIVE THIS MODULE CLOSES
 * ------------------------------------------------------------------------
 *
 * D-145 asked `merge tree === approved head tree`. That holds only when the head
 * already contains every commit on its base, and it held D-156 on a merge that
 * was exactly the authorized one.
 *
 * D-157 replaced it with an EFFECTIVE-CHANGE comparison: the GitHub three-dot
 * projections `parent1...merge` and `expectedBase...expectedHead` had to be equal
 * file for file and field for field, including the resulting blob sha and the
 * patch text. That is correct for the topology its fixtures had - base and head
 * changing DIFFERENT FILES - and wrong for an equally ordinary one:
 *
 *     base and head each change a different, NON-OVERLAPPING HUNK OF ONE FILE.
 *
 * The correct merge blob for that file contains BOTH hunks. It therefore cannot
 * equal the head's blob, the two projections cannot be equal, and the completion
 * gate returns `DELTA_CONTENT_MISMATCH` for a valid, conflict-free, correctly
 * authorized merge. Two different rules had now each been written from the one
 * topology their fixtures happened to have.
 *
 * ------------------------------------------------------------------------
 * WHY THIS ONE IS NOT THE SAME MISTAKE A THIRD TIME
 * ------------------------------------------------------------------------
 *
 * Both predecessors asserted a RESEMBLANCE between the merge and something else -
 * a tree it should equal, a diff it should look like - and a resemblance has to
 * be re-derived for every topology, which is exactly how each of them acquired a
 * topology it was wrong for.
 *
 * This asks the only question that never needed a topology:
 *
 *     Is the recorded merge commit's tree the tree that merging the authorized
 *     base and the authorized head PRODUCES?
 *
 * The expected tree is not an assertion about the merge; it is computed from the
 * two immutable authorized commits by git's own three-way merge, with no working
 * tree and no checkout (see `merge-tree.mjs`). Then one identity decides it:
 *
 *     tree(mergeCommit) === merge3(expectedBase, expectedHead)
 *
 * Every topology is the same statement. A head that already contained its base, a
 * head 17 commits behind, different files, different hunks of the same file - git
 * computes the right answer for each, because computing that answer is what a
 * merge IS. There is no case analysis here to get wrong.
 *
 * And it is stronger than both rules it replaces, because a tree id is the whole
 * tree: every path, every file mode, symlinks, submodule gitlinks and binary
 * content are inside it. Nothing has to be enumerated, so nothing can be
 * forgotten, and no rendering, rename heuristic or diff-formatting choice can
 * move it.
 *
 *   - an extra file in the merge         -> different tree -> refused
 *   - a reviewed hunk dropped or altered -> different tree -> refused
 *   - a BASE-ONLY hunk dropped or altered-> different tree -> refused
 *     (neither predecessor looked at base-only content at all: it is absent from
 *     both compared diffs, so anything could have happened to it)
 *   - a changed file mode, or a file replaced by a symlink -> different tree
 *   - a manually resolved conflict       -> refused twice over: the computation
 *     reports CONFLICTED, and a hand-made resolution is not a tree git produces
 *
 * ------------------------------------------------------------------------
 * WHAT IS DELIBERATELY *NOT* TRUSTED
 * ------------------------------------------------------------------------
 *
 * The merge commit's tree and parents used here are read from the REAL OBJECT in
 * an object store, not from the API projection. The API's answer is still
 * required - and required to AGREE - so the two are a cross-check on each other
 * rather than one standing in for the other.
 *
 * Nothing else is weakened. Exact-sha authorization, the PR-recorded merge sha,
 * ordered two-parent structure, merge-method refusal, the required review on the
 * exact head, required pre-merge CI, required post-merge CI with exact job
 * identities on the exact merge sha, the durable order binding, commit
 * provenance, the dirty/isolation guards and no-self-approval all stand and all
 * remain mandatory.
 *
 * Pure. Every input is already-gathered data, every branch is a named
 * fail-closed refusal, and nothing here can reach the filesystem, the network or
 * git.
 */

/**
 * Every outcome this module can produce, in the same flat reason namespace
 * `merge-transition.mjs` spreads its other leaf modules into - so a record, a log
 * line and a status comment never have to know which half of the proof refused.
 */
export const MERGE_TREE_PROOF = Object.freeze({
  /** The merge commit's tree IS the merge of the two authorized commits. */
  MERGE_TREE_PROVEN:
    "the_merge_commit_tree_is_exactly_the_tree_that_merging_the_authorized_base_and_head_produces",

  /* --- the computation. Uncomputed is never "proven". --- */
  /** The expected merge tree was never computed, or the attempt failed. */
  MERGE_TREE_NOT_COMPUTED:
    "the_expected_merge_tree_for_the_authorized_base_and_head_could_not_be_computed",
  /** One of the three exact objects could not be obtained. */
  MERGE_TREE_OBJECTS_UNAVAILABLE:
    "an_exact_object_the_merge_proof_needs_could_not_be_obtained_so_the_merge_cannot_be_recomputed",
  /** The computation answered about commits other than the authorized ones. */
  MERGE_TREE_WRONG_INPUTS:
    "the_merge_tree_computation_does_not_answer_about_the_exact_authorized_base_head_and_merge_commit",
  /** Merging the authorized base and head conflicts: there is no one correct tree. */
  MERGE_TREE_CONFLICTED:
    "merging_the_authorized_base_and_head_conflicts_so_no_merge_result_can_be_accepted_without_review_of_the_resolution",

  /* --- the merge commit object itself --- */
  /** The recorded merge commit could not be read as a real object. */
  MERGE_COMMIT_OBJECT_UNREADABLE:
    "the_recorded_merge_commit_could_not_be_read_as_a_real_git_object",
  /** The real object and the API projection tell different stories. */
  MERGE_COMMIT_OBJECT_DISAGREES:
    "the_recorded_merge_commit_object_disagrees_with_the_pull_request_projection_about_its_own_tree_or_parents",

  /* --- the proof --- */
  /** The merge tree is not the tree the authorized merge produces. */
  MERGE_TREE_MISMATCH:
    "the_merge_commit_tree_is_not_the_tree_merging_the_authorized_base_and_head_produces_so_the_merge_is_not_the_authorized_one"
});

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

function fullSha(value) {
  return typeof value === "string" && FULL_SHA_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
}

function sameSha(a, b) {
  const x = fullSha(a);
  const y = fullSha(b);
  return x !== null && y !== null && x === y;
}

/** Compact evidence, carried on every outcome, pass or refusal. */
function computationEvidence(c) {
  if (!c || typeof c !== "object") return null;
  return {
    stage: c.stage ?? null,
    store_path: c.store_path ?? null,
    fetched: c.fetched === true,
    missing_objects: Array.isArray(c.missing_objects) ? c.missing_objects : [],
    resolved_base: c.resolved_base ?? null,
    resolved_head: c.resolved_head ?? null,
    resolved_merge: c.resolved_merge ?? null,
    conflicted: typeof c.conflicted === "boolean" ? c.conflicted : null,
    expected_tree: c.expected_tree ?? null,
    merge_commit_tree: c.merge_commit_tree ?? null,
    merge_commit_parents: Array.isArray(c.merge_commit_parents) ? c.merge_commit_parents : null
  };
}

/**
 * THE PROOF.
 *
 *   computation      the record from `computeMergeTree` in `merge-tree.mjs`
 *   mergeSha         the merge commit the PULL REQUEST records
 *   expectedBase     the authorized base, from the trusted ARCHITECT_TASK
 *   expectedHead     the authorized head, from the trusted ARCHITECT_TASK
 *   projectedTree    the merge commit's tree AS THE API REPORTED IT
 *   projectedParents the merge commit's parents AS THE API REPORTED THEM
 *
 * Returns `{ ok, reason, detail, evidence }`. `ok: false` is always a named
 * refusal, and `evidence` is populated on refusals too, so a held gate can be
 * understood without re-running anything.
 */
export function verifyMergeTreeProof({
  computation,
  mergeSha,
  expectedBase,
  expectedHead,
  projectedTree = null,
  projectedParents = null
}) {
  const base = fullSha(expectedBase);
  const head = fullSha(expectedHead);
  const merge = fullSha(mergeSha);

  let evidence = {
    computation: computationEvidence(computation),
    expected_tree: null,
    merge_commit_tree: null,
    projected_tree: fullSha(projectedTree),
    proven: false
  };
  const refuse = (reason, detail) => ({ ok: false, reason, detail, evidence });

  // --- 1. the caller's own inputs have to be exact --------------------------
  if (!base || !head || !merge) {
    return refuse(MERGE_TREE_PROOF.MERGE_TREE_WRONG_INPUTS,
      `a merge proof can only be bound to full 40-character object ids; got base=${JSON.stringify(expectedBase ?? null)}, `
      + `head=${JSON.stringify(expectedHead ?? null)}, merge=${JSON.stringify(mergeSha ?? null)}`);
  }

  // --- 2. the computation actually happened --------------------------------
  const c = computation && typeof computation === "object" ? computation : null;
  if (!c || c.attempted !== true) {
    return refuse(MERGE_TREE_PROOF.MERGE_TREE_NOT_COMPUTED,
      "the expected merge tree was never computed, so there is nothing to compare the merge commit against");
  }
  if (Array.isArray(c.missing_objects) && c.missing_objects.length > 0) {
    return refuse(MERGE_TREE_PROOF.MERGE_TREE_OBJECTS_UNAVAILABLE, c.error ?? `missing: ${c.missing_objects.join(", ")}`);
  }
  if (c.conflicted === true) {
    return refuse(MERGE_TREE_PROOF.MERGE_TREE_CONFLICTED,
      `${c.error ?? `merging ${base} and ${head} conflicts`}`
      + (c.conflict_detail ? `; git reported: ${c.conflict_detail}` : "")
      + ". A conflict has no single correct resolution, so whatever tree the merge commit carries embodies choices "
      + "that were made after the review and were never covered by it");
  }
  if (c.ok !== true) {
    return refuse(MERGE_TREE_PROOF.MERGE_TREE_NOT_COMPUTED,
      `${c.error ?? "the computation reported no result"} (stage: ${c.stage ?? "unknown"})`);
  }

  // --- 3. and it answered about the AUTHORIZED commits ---------------------
  //
  // The computation echoes back what each input actually RESOLVED to in the
  // object store it used. Without this, a record built for some other task - or
  // a stale one reused - would be compared against these shas while describing
  // different ones.
  if (!sameSha(c.resolved_base, base) || !sameSha(c.resolved_head, head) || !sameSha(c.resolved_merge, merge)) {
    return refuse(MERGE_TREE_PROOF.MERGE_TREE_WRONG_INPUTS,
      `the computation resolved base=${JSON.stringify(c.resolved_base ?? null)}, `
      + `head=${JSON.stringify(c.resolved_head ?? null)}, merge=${JSON.stringify(c.resolved_merge ?? null)}, `
      + `but this task authorizes base=${base}, head=${head} and the pull request records merge=${merge}`);
  }
  if (c.conflicted !== false) {
    return refuse(MERGE_TREE_PROOF.MERGE_TREE_NOT_COMPUTED,
      `the computation did not state whether merging ${base} and ${head} conflicts, and an unstated conflict is not `
      + "the same thing as no conflict");
  }

  const expectedTree = fullSha(c.expected_tree);
  if (!expectedTree) {
    return refuse(MERGE_TREE_PROOF.MERGE_TREE_NOT_COMPUTED,
      `the computation produced ${JSON.stringify(c.expected_tree ?? null)} instead of a tree object id`);
  }
  evidence = { ...evidence, expected_tree: expectedTree };

  // --- 4. the merge commit, read as a REAL OBJECT --------------------------
  const mergeTree = fullSha(c.merge_commit_tree);
  const parents = Array.isArray(c.merge_commit_parents) ? c.merge_commit_parents.map((p) => fullSha(p)) : null;
  if (!mergeTree || !parents) {
    return refuse(MERGE_TREE_PROOF.MERGE_COMMIT_OBJECT_UNREADABLE,
      `the merge commit ${merge} did not yield both a tree (${JSON.stringify(c.merge_commit_tree ?? null)}) and an `
      + `ordered parent list (${JSON.stringify(c.merge_commit_parents ?? null)})`);
  }
  evidence = { ...evidence, merge_commit_tree: mergeTree };

  // The object's OWN parents must be the authorized base and head, in order.
  // The caller has already checked this against the API's projection; doing it
  // again from the object is not duplication, it is the cross-check - a
  // projection is served by the remote, an object is the thing itself.
  if (parents.length !== 2 || !sameSha(parents[0], base) || !sameSha(parents[1], head)) {
    return refuse(MERGE_TREE_PROOF.MERGE_COMMIT_OBJECT_DISAGREES,
      `the merge commit object ${merge} has parents ${JSON.stringify(parents)}, not exactly `
      + `[${base}, ${head}]; the pull request projection and the object itself do not describe the same commit`);
  }
  if (projectedParents !== null) {
    const projected = Array.isArray(projectedParents) ? projectedParents.map((p) => fullSha(p)) : null;
    if (!projected || projected.length !== parents.length || projected.some((p, i) => p !== parents[i])) {
      return refuse(MERGE_TREE_PROOF.MERGE_COMMIT_OBJECT_DISAGREES,
        `the API reports parents ${JSON.stringify(projectedParents)} for ${merge} and the object itself has `
        + `${JSON.stringify(parents)}`);
    }
  }
  if (projectedTree !== null) {
    if (!sameSha(projectedTree, mergeTree)) {
      return refuse(MERGE_TREE_PROOF.MERGE_COMMIT_OBJECT_DISAGREES,
        `the API reports tree ${JSON.stringify(projectedTree)} for ${merge} and the object itself points at `
        + `${mergeTree}`);
    }
  }

  // --- 5. THE IDENTITY -----------------------------------------------------
  if (mergeTree !== expectedTree) {
    return refuse(MERGE_TREE_PROOF.MERGE_TREE_MISMATCH,
      `merging the authorized base ${base} and head ${head} produces tree ${expectedTree}, but the merge commit `
      + `${merge} points at tree ${mergeTree}. A tree id covers every path, mode, symlink and byte in the result, so `
      + "this merge contains something the authorized merge of those two commits does not - extra content, a dropped "
      + "or altered reviewed hunk, an altered base-only hunk, or a resolution nobody reviewed");
  }

  evidence = { ...evidence, proven: true };
  return {
    ok: true,
    reason: MERGE_TREE_PROOF.MERGE_TREE_PROVEN,
    detail: `the merge commit ${merge} points at tree ${mergeTree}, which is exactly the tree git produces by merging `
      + `the authorized base ${base} and the authorized head ${head} - computed from those two immutable objects, `
      + "without a checkout and without touching any working tree. Both sides' changes, every base-only change, and "
      + "every file mode are inside that one id, so the merge carries the authorized content and nothing besides"
      + (evidence.computation?.fetched ? " (objects missing locally were fetched by exact sha from origin)" : ""),
    evidence
  };
}

/** Human-readable lines for a status comment or log. */
export function describeMergeTreeProof(evidence) {
  if (!evidence) return [];
  const c = evidence.computation;
  const lines = [
    `  expected merge tree (merge3 of authorized base+head): ${evidence.expected_tree ?? "not computed"}`,
    `  merge commit tree (read from the object):             ${evidence.merge_commit_tree ?? "unknown"}`
  ];
  if (c) {
    lines.push(`  proof store: ${c.store_path ?? "none"} (stage ${c.stage ?? "unknown"}`
      + `${c.fetched ? ", objects fetched by sha" : ""}`
      + `${c.conflicted === true ? ", CONFLICTED" : ""}`
      + `${c.missing_objects?.length ? `, missing ${c.missing_objects.join(", ")}` : ""})`);
  }
  return lines;
}

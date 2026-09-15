/**
 * D-158: COMPUTING WHAT A MERGE OF THE AUTHORIZED BASE AND HEAD MUST PRODUCE.
 *
 * ------------------------------------------------------------------------
 * THE HALF OF THE PROOF THAT HAS TO TOUCH THE WORLD
 * ------------------------------------------------------------------------
 *
 * `merge-tree-proof.mjs` decides; this module gathers. It is the only impure
 * part of the merge-transition proof, and everything it does is arranged so that
 * "gathering evidence" can never become "changing the thing being measured".
 *
 * Three facts are produced, all from REAL GIT OBJECTS rather than from any API
 * projection:
 *
 *   EXPECTED TREE   `git merge-tree --write-tree <expectedBase> <expectedHead>`
 *                   the one tree a conflict-free normal merge of exactly those
 *                   two commits can have
 *   MERGE TREE      the tree the recorded merge commit actually points at
 *   MERGE PARENTS   that commit's parents, in order
 *
 * ------------------------------------------------------------------------
 * WHY THIS REPLACED COMPARING TWO API DIFFS (D-157)
 * ------------------------------------------------------------------------
 *
 * D-157 proved "the merge introduced no unreviewed content" by requiring the
 * GitHub three-dot projections `parent1...merge` and `expectedBase...expectedHead`
 * to be equal file for file and field for field, INCLUDING the resulting blob sha.
 *
 * That is false for a topology that is not merely legal but ordinary. Let base and
 * head each change a DIFFERENT, NON-OVERLAPPING HUNK OF ONE FILE. The correct
 * merge blob for that file contains BOTH changes, so it cannot equal the head's
 * blob, so `parent1...merge` cannot equal `expectedBase...expectedHead`, and the
 * gate returns `DELTA_CONTENT_MISMATCH` for a merge that is exactly the authorized
 * one. D-157 passed its own tests only because its fixtures changed different
 * FILES, where the merge blob and the head blob do coincide.
 *
 * A projection comparison was the wrong instrument. The question is not "does the
 * merge's diff look like the review's diff" - it is:
 *
 *     Is this merge commit THE merge of the two commits that were authorized?
 *
 * which has an exact, content-addressed answer that git itself computes, and that
 * no formatting, rename heuristic or rendering choice can perturb. Both sides'
 * hunks, base-only hunks, file modes, symlinks and binary content are all inside
 * the tree id; nothing has to be enumerated, so nothing can be forgotten.
 *
 * ------------------------------------------------------------------------
 * NOT TOUCHING USER WORK IS A STRUCTURAL PROPERTY HERE, NOT A PROMISE
 * ------------------------------------------------------------------------
 *
 * `merge-tree --write-tree` writes the tree it computes, so this cannot be done
 * with reads alone. It is therefore done in an object store this worker OWNS:
 *
 *   - a bare repository under `cfg.scratchRoot`, which `config.mjs` already
 *     asserts at load time is OUTSIDE `repoPath` - so no write here can reach the
 *     checkout the dirty guard protects, whatever this file does;
 *   - with `objects/info/alternates` pointing at the primary repository's object
 *     database, which makes every object the clone already has READABLE without
 *     copying it and without writing to it;
 *   - so every new object - the merged tree, and anything fetched - lands in the
 *     scratch store and nowhere else.
 *
 * No checkout, no index, no ref written, no branch moved, nothing stashed, reset
 * or cleaned, and the working tree of the real repository is never named. An
 * object missing locally is fetched BY EXACT SHA from the repository's own
 * `origin` - verified with `remoteMatchesRepo` first - with no refspec, so even
 * that adds objects and nothing else.
 *
 * ------------------------------------------------------------------------
 * EVERY FAILURE IS UNKNOWN
 * ------------------------------------------------------------------------
 *
 * Nothing here decides anything. It returns a record with an explicit `stage`
 * naming how far it got, and `verifyMergeTreeProof` refuses on anything that is
 * not a complete, unambiguous, conflict-free computation over the exact expected
 * shas. A missing object, a git that is too old for `--write-tree`, a fetch that
 * failed, a conflict, an unreadable merge commit: all of them arrive there as
 * evidence of an UNKNOWN, and none of them can arrive as a pass.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitize } from "./health.mjs";
import {
  atPath,
  gitCommitParents,
  gitCommitTree,
  gitFetchObjects,
  gitMergeTree,
  gitObjectsDir,
  gitRemoteUrl,
  gitResolveCommit,
  remoteMatchesRepo,
  runGit
} from "./git.mjs";

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

const norm = (v) => (typeof v === "string" && FULL_SHA_RE.test(v.trim()) ? v.trim().toLowerCase() : null);

/**
 * Where the isolated object store lives.
 *
 * Under `scratchRoot` on purpose, and exported so a test can assert the location
 * rather than infer it: `config.mjs` guarantees `scratchRoot` is outside the
 * repository, and that guarantee is the reason this whole module cannot dirty a
 * checkout even if every other line of it were wrong.
 */
export function mergeProofStorePath(cfg) {
  return join(cfg.scratchRoot, "merge-proof.git");
}

/** The empty record, so every field exists on every outcome including a throw. */
function blank(over = {}) {
  return {
    attempted: true,
    ok: false,
    stage: null,
    error: null,
    store_path: null,
    fetched: false,
    fetch_error: null,
    missing_objects: [],
    resolved_base: null,
    resolved_head: null,
    resolved_merge: null,
    expected_tree: null,
    conflicted: null,
    conflict_detail: null,
    merge_commit_tree: null,
    merge_commit_parents: null,
    ...over
  };
}

/**
 * Create (or re-open) the scratch object store and point it at the real one.
 *
 * `git init --bare` is idempotent, so a store left over from a previous gate is
 * reused rather than deleted - deliberately: a rebuild would throw away objects
 * a previous run had to fetch, and this module deletes nothing, ever.
 */
function prepareStore(cfg, runner) {
  const storePath = mergeProofStorePath(cfg);

  // The real object database, asked of git rather than assembled from a path.
  const objects = gitObjectsDir(cfg, runner);
  if (!objects.ok) {
    return { ok: false, stage: "object_store", error: `could not locate the repository object database: ${objects.error}` };
  }

  try {
    mkdirSync(storePath, { recursive: true });
  } catch (err) {
    return { ok: false, stage: "object_store", error: `could not create ${storePath}: ${sanitize(err.message)}` };
  }

  const at = atPath(cfg, storePath);
  const init = runGit(at, ["init", "--bare", "--quiet"], runner);
  if (!init.ok) {
    return { ok: false, stage: "object_store", error: `could not initialise ${storePath}: ${init.error}` };
  }

  // Written every time rather than only when absent: it is one line, and a store
  // whose alternates had gone stale would silently look like a store that is
  // missing every object, which is a refusal for the wrong reason.
  try {
    mkdirSync(join(storePath, "objects", "info"), { recursive: true });
    writeFileSync(join(storePath, "objects", "info", "alternates"), `${objects.value}\n`, "utf8");
  } catch (err) {
    return { ok: false, stage: "object_store", error: `could not point ${storePath} at the repository objects: ${sanitize(err.message)}` };
  }

  return { ok: true, storePath, at };
}

/**
 * THE COMPUTATION.
 *
 *   expectedBase   the authorized base, from the trusted ARCHITECT_TASK
 *   expectedHead   the authorized head, from the trusted ARCHITECT_TASK
 *   mergeSha       the merge commit the PR itself records
 *
 * Returns the record `verifyMergeTreeProof` consumes. It never throws: a throw
 * would reach the completion gate as an exception rather than as a refusal, and
 * a gate that crashes has not decided anything.
 */
export function computeMergeTree(cfg, { expectedBase, expectedHead, mergeSha } = {}, runner = spawnSync) {
  try {
    return compute(cfg, { expectedBase, expectedHead, mergeSha }, runner);
  } catch (err) {
    return blank({ stage: "threw", error: `the merge-tree computation threw: ${sanitize(err.message)}` });
  }
}

function compute(cfg, { expectedBase, expectedHead, mergeSha }, runner) {
  // --- 1. the inputs must be exact commit ids ------------------------------
  const base = norm(expectedBase);
  const head = norm(expectedHead);
  const merge = norm(mergeSha);
  if (!base || !head || !merge) {
    return blank({
      stage: "inputs",
      error: "a merge proof can only be computed from full 40-character object ids; got base="
        + `${JSON.stringify(expectedBase ?? null)}, head=${JSON.stringify(expectedHead ?? null)}, `
        + `merge=${JSON.stringify(mergeSha ?? null)}`
    });
  }

  // --- 2. an object store that is ours -------------------------------------
  const store = prepareStore(cfg, runner);
  if (!store.ok) return blank({ stage: store.stage, error: store.error });
  const { at, storePath } = store;
  const rec = (over) => blank({ store_path: storePath, ...over });

  // --- 3. every object present, fetching by exact sha if not ---------------
  const resolve = () => {
    const out = { missing: [], unknown: null, shas: {} };
    for (const sha of [base, head, merge]) {
      const r = gitResolveCommit(at, sha, runner);
      if (!r.ok) { out.unknown = `${sha}: ${r.error}`; return out; }
      if (!r.present) out.missing.push(sha);
      else out.shas[sha] = r.sha;
    }
    return out;
  };

  let found = resolve();
  if (found.unknown) {
    return rec({ stage: "resolve", error: `an object lookup could not be answered - ${found.unknown}` });
  }

  let fetched = false;
  let fetchError = null;
  if (found.missing.length > 0) {
    const url = gitRemoteUrl(cfg, "origin", runner);
    if (!url.ok) {
      return rec({
        stage: "fetch",
        missing_objects: found.missing,
        error: `${found.missing.length} object(s) are not present locally and the repository's origin URL could not `
          + `be read, so they cannot be fetched: ${url.error}`
      });
    }
    if (!remoteMatchesRepo(url.value, cfg)) {
      // The same guard the rest of the worker uses before it trusts a remote.
      // Fetching objects from somewhere else and then proving a merge against
      // them would be proving something about the wrong repository.
      return rec({
        stage: "fetch",
        missing_objects: found.missing,
        error: `the repository's origin does not point at ${cfg.repoOwner}/${cfg.repoName}, so no object may be `
          + "fetched from it for this proof"
      });
    }
    const got = gitFetchObjects(at, url.value, found.missing, runner);
    fetched = true;
    if (!got.ok) fetchError = got.error;
    found = resolve();
    if (found.unknown) {
      return rec({
        stage: "resolve",
        fetched,
        fetch_error: fetchError,
        error: `an object lookup could not be answered after fetching - ${found.unknown}`
      });
    }
  }

  if (found.missing.length > 0) {
    return rec({
      stage: "resolve",
      fetched,
      fetch_error: fetchError,
      missing_objects: found.missing,
      error: `the exact object(s) ${found.missing.join(", ")} could not be obtained, so the merge this task claims `
        + "cannot be recomputed at all"
        + (fetchError ? `; the fetch reported: ${fetchError}` : "")
    });
  }

  const resolved = {
    resolved_base: found.shas[base] ?? null,
    resolved_head: found.shas[head] ?? null,
    resolved_merge: found.shas[merge] ?? null
  };

  // --- 4. the merge git itself computes from those exact objects -----------
  const merged = gitMergeTree(at, base, head, runner);
  if (!merged.ok) {
    return rec({
      stage: "merge_tree",
      fetched,
      fetch_error: fetchError,
      ...resolved,
      error: `the three-way merge of ${base} and ${head} could not be computed: ${merged.error}`
    });
  }
  if (merged.conflicted) {
    return rec({
      stage: "merge_tree",
      fetched,
      fetch_error: fetchError,
      ...resolved,
      conflicted: true,
      conflict_detail: merged.detail,
      error: `merging ${base} and ${head} CONFLICTS, so there is no single tree a normal merge of them must have`
    });
  }

  // --- 5. and what the recorded merge commit actually is -------------------
  const mergeTree = gitCommitTree(at, merge, runner);
  const mergeParents = gitCommitParents(at, merge, runner);
  if (!mergeTree.ok || !mergeParents.ok) {
    return rec({
      stage: "merge_commit",
      fetched,
      fetch_error: fetchError,
      ...resolved,
      conflicted: false,
      expected_tree: merged.tree,
      error: `the merge commit ${merge} could not be read as an object: `
        + [mergeTree.ok ? null : `tree: ${mergeTree.error}`, mergeParents.ok ? null : `parents: ${mergeParents.error}`]
          .filter(Boolean).join("; ")
    });
  }

  return rec({
    ok: true,
    stage: "complete",
    fetched,
    fetch_error: fetchError,
    ...resolved,
    conflicted: false,
    expected_tree: merged.tree,
    merge_commit_tree: norm(mergeTree.value),
    merge_commit_parents: mergeParents.parents.map((p) => norm(p))
  });
}

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
 * with reads alone. It is therefore done in an object store this worker OWNS -
 * and, since D-159, one that THIS TASK owns:
 *
 *   - a bare repository under `join(cfg.scratchRoot, taskId)`, which
 *     `config.mjs` already asserts at load time is OUTSIDE `repoPath` - so no
 *     write here can reach the checkout the dirty guard protects, whatever this
 *     file does - and which carries an ownership marker naming the admitted
 *     TASK_ID, checked before anything is created, written or removed;
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
 * AND THE MERGE IS COMPUTED UNDER A CONFIGURATION THE WORKER CONTROLS
 * ------------------------------------------------------------------------
 *
 * D-158 REVIEW-FIX (architect review 5216915623 on PR #84, P1). The first
 * version of this module pinned five settings on the command line and inherited
 * everything else from the host and from the reused scratch store. Pinning
 * scalars is not isolation, and the gap was not theoretical - both halves were
 * reproduced on this host before the fix:
 *
 *   1. COMMAND EXECUTION. `git`'s merge machinery honours `merge=<driver>` in a
 *      COMMITTED `.gitattributes`, and runs whatever `merge.<driver>.driver`
 *      names. With that driver defined in the host's GLOBAL config, a committed
 *      attribute file made `merge-tree --write-tree` execute it during the
 *      completion gate - repository content selecting a host command inside a
 *      security gate - and produced a different tree than the merge without it.
 *   2. HOST-DEPENDENT ANSWERS. This host's SYSTEM config sets `core.autocrlf`
 *      and the `filter.lfs.*` commands; `merge.default`, `merge.renormalize`,
 *      `core.attributesFile` and an `include.path` in the store's own config can
 *      each move the computed tree too. A content-addressed proof whose answer
 *      depends on which machine ran it is not a proof.
 *
 * Three layers close it, and none of them is trusted alone:
 *
 *   ISOLATE   every invocation that computes or reads the proof runs under
 *             `isolatedGitEnv` - system, global, XDG and environment-injected
 *             configuration removed, not merely overridden (see `git.mjs`).
 *             The FETCH deliberately keeps the host environment: it needs the
 *             host's credentials, it computes nothing, and `git fetch <url>
 *             <sha>` is content-addressed, so a rewritten URL or a hostile
 *             credential helper can only make it FAIL - never substitute
 *             content under a sha the proof then merges.
 *   VALIDATE  the effective configuration is then LISTED WITH ITS ORIGINS and
 *             every entry must come from the store's own config file and be in
 *             a narrow allowlist. An `include.path` resolves to its own origin
 *             and is therefore visible; a stale or hostile key in the reused
 *             store, or a new key from a future git, is a NAMED REFUSAL rather
 *             than something the isolation list happened not to think of. That
 *             is what makes "no merge driver is defined" a checked fact.
 *   REFUSE    and because a driver could still be requested by content while
 *             being undefined here - git silently falls back to the built-in
 *             merge, which is a DIFFERENT tree from the one a machine that has
 *             the driver computes - every `.gitattributes` in the base, head and
 *             merge-base trees is read, and a `merge=` naming anything but
 *             git's built-in `text`/`binary`/`union` fails the proof CLOSED.
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
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { sanitize } from "./health.mjs";
import {
  atPath,
  gitCommitParents,
  gitCommitTree,
  gitConfigOrigins,
  gitFetchObjects,
  gitListTree,
  gitMergeBase,
  gitMergeTree,
  gitObjectsDir,
  gitRemoteUrl,
  gitResolveCommit,
  gitShowBlob,
  isolatedGitEnv,
  remoteMatchesRepo,
  runGit,
  withGitEnv
} from "./git.mjs";

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

const norm = (v) => (typeof v === "string" && FULL_SHA_RE.test(v.trim()) ? v.trim().toLowerCase() : null);

/* ==========================================================================
 * D-159: THE PROOF'S WORKING DIRECTORIES BELONG TO ONE TASK ID
 * ==========================================================================
 *
 * D-158 put the store and the isolated environment at a FIXED place under
 * `scratchRoot` - `merge-proof.git` and `merge-proof-env` - shared by every task
 * that ever runs on this host, and then reused them: truncating the env files,
 * overwriting `objects/info/alternates`, force-removing `info/attributes`.
 *
 * Architect review 5217710904 on PR #84 (P1) named what that costs. Isolating
 * and allowlisting the CONFIGURATION says nothing about who owns the FILES. A
 * shared namespace means:
 *
 *   - state another task left behind is an input to this security gate, and the
 *     config allowlist is not a general answer - the alternates file, the
 *     attributes file and the object database are not config;
 *   - this gate DELETES and TRUNCATES paths it cannot prove it owns, which is
 *     the one thing the order forbids everywhere else in the worker;
 *   - two tasks running concurrently share one store, so neither can say which
 *     of them the evidence describes.
 *
 * So the directories are bound to the immutable admitted TASK_ID, under that
 * task's own authorized scratch directory - `join(scratchRoot, taskId)`, the
 * same directory `worker.mjs` already hands the child - and ownership is a
 * CHECKED FACT before anything is written:
 *
 *   CLAIM     a directory that does not exist is created and stamped with an
 *             ownership marker naming this exact task id and kind.
 *   PROVE     a directory that DOES exist must carry that marker, and it must
 *             name this exact task id and kind. Anything else - a foreign task's
 *             store, an unmarked directory, an unreadable or malformed marker -
 *             fails closed WITHOUT deleting, truncating or overwriting it. A
 *             resumed attempt of the SAME task finds its own marker and reuses
 *             its objects, which is what keeps reuse additive.
 *   CONTAIN   nothing is reached through a symlink, junction or other reparse
 *             point, and the real path of what was claimed must still be inside
 *             the real scratch root - so a planted link cannot redirect the
 *             gate's writes out of the task's own directory.
 *
 * The exact-tree proof itself is untouched; only WHERE it works, and on whose
 * authority, changed.
 */

/** The file that records which TASK_ID owns a proof directory. */
export const PROOF_OWNER_MARKER = "jarvis-merge-proof-owner.json";

/** Bumped only if the marker's meaning changes; an unknown version is refused. */
const PROOF_OWNER_VERSION = 1;

/**
 * A TASK_ID is used here as a PATH SEGMENT, so it has to be one.
 *
 * Deliberately narrower than "what a task id might be": letters, digits, dot,
 * dash and underscore only. That excludes `.`/`..`, both separators, a drive
 * letter, a UNC prefix, an ADS `:` and every reserved character, so
 * `join(scratchRoot, taskId)` cannot leave `scratchRoot` no matter what the
 * order contained. A legitimate id that this rejects is a visible refusal; an
 * id that escapes would not be.
 */
const TASK_ID_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The task id as a usable path segment, or `null` if it is not one. */
export function proofTaskSegment(taskId) {
  const id = typeof taskId === "string" ? taskId.trim() : "";
  return TASK_ID_SEGMENT_RE.test(id) ? id : null;
}

/** This task's own scratch directory - the same one `worker.mjs` hands the child. */
export function mergeProofTaskRoot(cfg, taskId) {
  const id = proofTaskSegment(taskId);
  return id === null ? null : join(cfg.scratchRoot, id);
}

/**
 * Where this TASK's isolated object store lives.
 *
 * Exported so a test can assert the location rather than infer it. `null` means
 * the task id is not usable as a path segment, and the caller refuses: a proof
 * that cannot say whose directory it ran in is not bound to anything.
 */
export function mergeProofStorePath(cfg, taskId) {
  const root = mergeProofTaskRoot(cfg, taskId);
  return root === null ? null : join(root, "merge-proof.git");
}

/**
 * The empty config, empty attributes file and empty HOME the proof runs under -
 * also this task's own, and rewritten empty on every run of THIS task. A file
 * that is "empty" only because nobody has written to it yet is not a guarantee.
 */
export function mergeProofEnvPaths(cfg, taskId) {
  const taskRoot = mergeProofTaskRoot(cfg, taskId);
  if (taskRoot === null) return null;
  const root = join(taskRoot, "merge-proof-env");
  return {
    root,
    emptyConfig: join(root, "empty.gitconfig"),
    emptyAttributes: join(root, "empty.gitattributes"),
    emptyHome: join(root, "home")
  };
}

/** The exact bytes of an ownership marker for one task and one kind. */
function ownerMarkerBody(taskId, kind) {
  return `${JSON.stringify({ jarvis_merge_proof_owner: PROOF_OWNER_VERSION, kind, task_id: taskId }, null, 2)}\n`;
}

/**
 * Every existing path component from `root` down to `path` must be a real
 * directory - never a symlink, junction or other reparse point.
 *
 * Checked BEFORE anything is created, because `mkdirSync(recursive)` happily
 * follows a link that is already there, and the write would then land wherever
 * the link points. A component that does not exist yet ends the walk: what does
 * not exist cannot redirect anything, and what this function creates later is
 * created by us.
 *
 * `root` itself is resolved but not link-checked: `scratchRoot` is the worker's
 * own configuration, and a host that legitimately places it behind a link would
 * otherwise be refused for a reason that has nothing to do with task isolation.
 * The containment check below resolves it either way, so a link there still
 * cannot widen what counts as "inside".
 */
function refuseLinkedComponents(path, root) {
  const rel = relative(resolvePath(root), resolvePath(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, error: `${path} is not inside the worker scratch root ${root}` };
  }
  let current = resolvePath(root);
  for (const segment of rel.split(/[\\/]/)) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (err) {
      // Nothing below here exists yet, so nothing below here can redirect.
      if (err?.code === "ENOENT") return { ok: true, error: null };
      return { ok: false, error: `${current} could not be inspected: ${sanitize(err.message)}` };
    }
    if (stat.isSymbolicLink()) {
      return {
        ok: false,
        error: `${current} is a symbolic link, junction or other reparse point. The merge proof writes only inside `
          + "the directory this task owns, and a link could redirect those writes somewhere it does not; it is refused "
          + "and left exactly as found"
      };
    }
    if (!stat.isDirectory()) {
      return { ok: false, error: `${current} exists and is not a directory, so it cannot hold this task's merge proof` };
    }
  }
  return { ok: true, error: null };
}

/**
 * After claiming, what we actually hold must still resolve to somewhere inside
 * the scratch root - the second, independent answer to "did anything redirect
 * this?", asked of the filesystem rather than of a component walk.
 */
function refuseEscapedRealPath(path, root) {
  let realPath;
  let realRoot;
  try {
    realPath = realpathSync(path);
    realRoot = realpathSync(root);
  } catch (err) {
    return { ok: false, error: `${path} could not be resolved to a real path: ${sanitize(err.message)}` };
  }
  const rel = relative(realRoot, realPath);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    return {
      ok: false,
      error: `${path} really resolves to ${realPath}, which is outside the worker scratch root ${realRoot}. The merge `
        + "proof will not compute anything in a directory it cannot prove is its own"
    };
  }
  return { ok: true, error: null };
}

/**
 * Claim `path` for exactly this task id and kind, or refuse WITHOUT touching it.
 *
 * The only write this makes into a directory that already exists is the marker
 * itself, with `wx` - so it cannot clobber a marker another attempt wrote, and
 * the read-back below is what decides ownership in either case. A directory that
 * exists without a marker is NOT adopted: writing one would be this task
 * declaring itself the owner of work it did not create.
 */
function claimProofDir(cfg, path, { taskId, kind }) {
  const links = refuseLinkedComponents(path, cfg.scratchRoot);
  if (!links.ok) return links;

  const marker = join(path, PROOF_OWNER_MARKER);
  let present = null;
  try {
    present = lstatSync(path);
  } catch (err) {
    if (err?.code !== "ENOENT") return { ok: false, error: `${path} could not be inspected: ${sanitize(err.message)}` };
  }

  if (present === null) {
    try {
      mkdirSync(path, { recursive: true });
      writeFileSync(marker, ownerMarkerBody(taskId, kind), { encoding: "utf8", flag: "wx" });
    } catch (err) {
      // `EEXIST` on the marker means something else got there first; that is not
      // an error yet, it is a question, and the read-back answers it.
      if (err?.code !== "EEXIST") {
        return { ok: false, error: `could not create this task's ${kind} at ${path}: ${sanitize(err.message)}` };
      }
    }
  } else if (!present.isDirectory()) {
    return { ok: false, error: `${path} exists and is not a directory, so it cannot hold this task's ${kind}` };
  }

  // ONE verification path for both "just created" and "found already there", so
  // a claim is never believed on the strength of having tried to make it.
  let raw;
  try {
    raw = readFileSync(marker, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: err?.code === "ENOENT"
        ? `${path} already exists but carries no ${PROOF_OWNER_MARKER}, so this task cannot prove it owns it. It is `
          + "left exactly as found - unread, untruncated and undeleted - and the merge proof refuses rather than "
          + "reusing state of unknown authorship"
        : `${marker} could not be read: ${sanitize(err.message)}`
    };
  }

  let owner = null;
  try {
    owner = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `${marker} is not readable as an ownership claim: ${sanitize(err.message)}` };
  }
  if (owner?.jarvis_merge_proof_owner !== PROOF_OWNER_VERSION || owner?.kind !== kind || owner?.task_id !== taskId) {
    return {
      ok: false,
      error: `${path} is claimed by ${JSON.stringify(owner?.task_id ?? null)} `
        + `(kind ${JSON.stringify(owner?.kind ?? null)}, marker version `
        + `${JSON.stringify(owner?.jarvis_merge_proof_owner ?? null)}), not by ${taskId} (kind ${kind}). It belongs to `
        + "another task or to nothing this worker can identify, so it is left untouched and the proof refuses"
    };
  }

  const contained = refuseEscapedRealPath(path, cfg.scratchRoot);
  if (!contained.ok) return contained;

  return { ok: true, error: null, path };
}

/**
 * The ONLY configuration keys the proof store may carry.
 *
 * These are what `git init --bare` itself writes, plus the `extensions.*` a
 * repository's object/ref format legitimately needs (a sha256 or reftable
 * repository must be readable here). Nothing in this list can name a command,
 * a path, an attributes file or another config file. Anything else - including
 * a key a future git starts writing - is a refusal, which is the safe direction:
 * a false refusal is visible and fixable, a missed `merge.<x>.driver` is not.
 */
export const ALLOWED_STORE_CONFIG_KEYS = Object.freeze([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.symlinks",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.logallrefupdates",
  "core.hidedotfiles",
  "core.sharedrepository",
  "extensions.objectformat",
  "extensions.compatobjectformat",
  "extensions.refstorage"
]);

/** git's BUILT-IN merge drivers: named by content, but never a command. */
export const BUILTIN_MERGE_DRIVERS = Object.freeze(["text", "binary", "union"]);

const samePath = (a, b) => resolvePath(a).replace(/\\/g, "/").toLowerCase() === resolvePath(b).replace(/\\/g, "/").toLowerCase();

/**
 * Does every effective config entry come from the store's own config file, and
 * is every key allowlisted?
 *
 * Returns `{ ok, foreign: [...], error }`. `foreign` is capped and carried into
 * the evidence, so a held gate names the exact key and origin that held it.
 */
function validateStoreConfig(at, storePath, runner) {
  const listed = gitConfigOrigins(at, runner);
  if (!listed.ok) return { ok: false, foreign: [], error: `the effective git configuration could not be listed: ${listed.error}` };

  const ownConfig = join(storePath, "config");
  const allowed = new Set(ALLOWED_STORE_CONFIG_KEYS);
  const foreign = [];
  for (const entry of listed.entries) {
    const origin = String(entry.origin ?? "");
    const path = origin.startsWith("file:") ? origin.slice("file:".length) : null;
    // `--show-origin` prints the store's own config relative to the cwd, which
    // IS the store - so both spellings are the same file and both are checked
    // by path rather than by string.
    const ownOrigin = path !== null && (path === "config" || samePath(join(storePath, path), ownConfig) || samePath(path, ownConfig));
    const key = String(entry.key ?? "").toLowerCase();
    if (!ownOrigin) {
      foreign.push(`${origin} -> ${key} (not the proof store's own config)`);
    } else if (!allowed.has(key)) {
      foreign.push(`${origin} -> ${key} (not an allowlisted key)`);
    }
    if (foreign.length >= 20) break;
  }
  return foreign.length === 0
    ? { ok: true, foreign: [], error: null }
    : {
      ok: false,
      foreign,
      error: `the merge proof would run under configuration this worker does not control: ${foreign.join("; ")}`
    };
}

/**
 * Every `merge=<driver>` requested by a `.gitattributes` committed in the trees
 * this merge reads, that is not one of git's built-ins.
 *
 * Returns `{ ok, requested: [...], scanned, error }`. `ok: false` is UNKNOWN - a
 * tree that could not be listed, or an attributes blob that could not be read,
 * must never be reported as "no driver requested".
 */
function scanMergeDrivers(at, commits, runner) {
  const requested = [];
  let scanned = 0;
  for (const commit of commits) {
    if (!commit) continue;
    const listed = gitListTree(at, commit, runner);
    if (!listed.ok) return { ok: false, requested: [], scanned, error: `the tree of ${commit} could not be listed: ${listed.error}` };
    const attributeFiles = listed.paths.filter((p) => p === ".gitattributes" || p.endsWith("/.gitattributes"));
    for (const path of attributeFiles) {
      const blob = gitShowBlob(at, `${commit}:${path}`, runner);
      if (!blob.ok) return { ok: false, requested: [], scanned, error: `${commit}:${path} could not be read: ${blob.error}` };
      scanned += 1;
      for (const driver of customDriversIn(blob.content)) {
        requested.push(`${commit.slice(0, 12)}:${path} -> merge=${driver}`);
        if (requested.length >= 20) return { ok: true, requested, scanned, error: null };
      }
    }
  }
  return { ok: true, requested, scanned, error: null };
}

/**
 * The `merge=<driver>` tokens in one `.gitattributes`, built-ins removed.
 *
 * Comments and blank lines are skipped, `[attr]` macro definitions are read the
 * same way as pattern lines - a macro that expands to `merge=evil` selects the
 * driver just as directly - and quoted patterns do not matter because only the
 * attribute tokens are inspected.
 */
function customDriversIn(content) {
  const found = [];
  for (const raw of String(content ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    for (const token of line.split(/\s+/)) {
      const m = /^merge=(.+)$/.exec(token);
      if (!m) continue;
      const driver = m[1].replace(/^"|"$/g, "").toLowerCase();
      if (!BUILTIN_MERGE_DRIVERS.includes(driver) && !found.includes(driver)) found.push(driver);
    }
  }
  return found;
}

/** The empty record, so every field exists on every outcome including a throw. */
function blank(over = {}) {
  return {
    attempted: true,
    ok: false,
    stage: null,
    error: null,
    store_path: null,
    // D-159: `null` until ownership is actually established, and
    // `merge-tree-proof.mjs` refuses an unstated claim exactly like a failed one.
    // `store_owner_task_id` is echoed back so the pure decider can re-check the
    // binding against the task it is deciding for, rather than trust this record
    // to be about the right task.
    store_owned: null,
    store_owner_task_id: null,
    fetched: false,
    fetch_error: null,
    missing_objects: [],
    // D-158 REVIEW-FIX: `null` on both until they are actually established, and
    // `merge-tree-proof.mjs` refuses anything that is not an explicit `true` /
    // empty list. An unasked question is not a negative answer.
    config_isolated: null,
    foreign_config: [],
    custom_merge_drivers: null,
    attribute_files_scanned: 0,
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
 *
 * D-158 REVIEW-FIX: reuse is exactly why the store is not TRUSTED. `git init`
 * over an existing directory leaves whatever config and `info/attributes` were
 * there, so the out-of-tree attributes file is removed here and the effective
 * configuration is validated by the caller before anything is merged.
 */
function prepareStore(cfg, taskId, env, runner) {
  const storePath = mergeProofStorePath(cfg, taskId);
  if (storePath === null) {
    return { ok: false, stage: "store_ownership", error: `${JSON.stringify(taskId ?? null)} is not usable as a task-owned directory name` };
  }

  // D-159: BEFORE anything is created, initialised, written or removed here,
  // this task must prove the directory is its own. A refusal below leaves the
  // path exactly as it was found.
  const claim = claimProofDir(cfg, storePath, { taskId, kind: "merge-proof-store" });
  if (!claim.ok) return { ok: false, stage: "store_ownership", storePath, error: claim.error };

  // The real object database, asked of git rather than assembled from a path -
  // and asked under the isolated environment too, so that the answer depends on
  // the working directory alone and not on a `GIT_DIR` that happens to be set.
  const objects = gitObjectsDir(withGitEnv(cfg, env), runner);
  if (!objects.ok) {
    return { ok: false, stage: "object_store", error: `could not locate the repository object database: ${objects.error}` };
  }

  try {
    mkdirSync(storePath, { recursive: true });
  } catch (err) {
    return { ok: false, stage: "object_store", error: `could not create ${storePath}: ${sanitize(err.message)}` };
  }

  // The fetch keeps the host environment (credentials); everything that reads or
  // computes the proof runs under the isolated one.
  const fetchAt = atPath(cfg, storePath);
  const at = withGitEnv(fetchAt, env);
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
    // `$GIT_DIR/info/attributes` is a full attributes source that lives OUTSIDE
    // every tree, so a stale one in a reused store could select a merge driver
    // for content that never asked for one. Removed, not read.
    rmSync(join(storePath, "info", "attributes"), { force: true });
  } catch (err) {
    return { ok: false, stage: "object_store", error: `could not point ${storePath} at the repository objects: ${sanitize(err.message)}` };
  }

  return { ok: true, storePath, at, fetchAt };
}

/**
 * Write the empty config, empty attributes file and empty HOME the proof runs
 * under, and build the environment that points git at them.
 */
function prepareEnvironment(cfg, taskId) {
  const paths = mergeProofEnvPaths(cfg, taskId);
  if (paths === null) {
    return { ok: false, error: `${JSON.stringify(taskId ?? null)} is not usable as a task-owned directory name` };
  }
  // D-159: the environment root is claimed on the same terms as the store. It is
  // the one place this module TRUNCATES files, so "nobody else's" has to be a
  // proven fact and not a naming convention.
  const claim = claimProofDir(cfg, paths.root, { taskId, kind: "merge-proof-env" });
  if (!claim.ok) return { ok: false, error: claim.error };
  try {
    mkdirSync(paths.emptyHome, { recursive: true });
    // Truncated to empty on EVERY run: a file that is empty only because nobody
    // has written to it yet is not a guarantee about anything.
    writeFileSync(paths.emptyConfig, "", "utf8");
    writeFileSync(paths.emptyAttributes, "", "utf8");
  } catch (err) {
    return { ok: false, error: `could not prepare the isolated git environment under ${paths.root}: ${sanitize(err.message)}` };
  }
  return { ok: true, paths, env: isolatedGitEnv(paths) };
}

/**
 * THE COMPUTATION.
 *
 *   expectedBase   the authorized base, from the trusted ARCHITECT_TASK
 *   expectedHead   the authorized head, from the trusted ARCHITECT_TASK
 *   mergeSha       the merge commit the PR itself records
 *   taskId         D-159: the IMMUTABLE ADMITTED TASK_ID this proof is for. It
 *                  is not decoration - it selects and authorises the only
 *                  directories this computation may create, read or write, and
 *                  it is echoed into the record so the decider can re-check it.
 *
 * Returns the record `verifyMergeTreeProof` consumes. It never throws: a throw
 * would reach the completion gate as an exception rather than as a refusal, and
 * a gate that crashes has not decided anything.
 */
export function computeMergeTree(cfg, { expectedBase, expectedHead, mergeSha, taskId } = {}, runner = spawnSync) {
  try {
    return compute(cfg, { expectedBase, expectedHead, mergeSha, taskId }, runner);
  } catch (err) {
    return blank({ stage: "threw", error: `the merge-tree computation threw: ${sanitize(err.message)}` });
  }
}

function compute(cfg, { expectedBase, expectedHead, mergeSha, taskId }, runner) {
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

  // --- 1b. ...and the proof must know WHOSE it is (D-159) -------------------
  //
  // The task id selects the directories this computation may touch, so an
  // absent or unusable one is refused here rather than defaulted to a shared
  // location. "Which task's evidence is this?" has to have an answer before any
  // evidence exists.
  const owner = proofTaskSegment(taskId);
  if (owner === null) {
    return blank({
      stage: "store_ownership",
      store_owned: false,
      error: `a merge proof runs only in a directory bound to the admitted TASK_ID, and `
        + `${JSON.stringify(taskId ?? null)} is not usable as one`
    });
  }

  // --- 2. an environment and an object store that are both ours -------------
  const environment = prepareEnvironment(cfg, owner);
  if (!environment.ok) {
    return blank({ stage: "environment", store_owned: false, store_owner_task_id: owner, error: environment.error });
  }

  const store = prepareStore(cfg, owner, environment.env, runner);
  if (!store.ok) {
    return blank({
      stage: store.stage,
      store_path: store.storePath ?? null,
      store_owned: store.stage === "store_ownership" ? false : null,
      store_owner_task_id: owner,
      error: store.error
    });
  }
  const { at, fetchAt, storePath } = store;
  // From here on the store and the environment are PROVEN to be this task's own,
  // so every later record states it.
  const rec = (over) => blank({ store_path: storePath, store_owned: true, store_owner_task_id: owner, ...over });

  // --- 2b. ...and a CONFIGURATION that is ours (D-158 REVIEW-FIX) -----------
  //
  // Isolation is not trusted on its own. This lists what git would actually
  // apply, with origins, and refuses anything outside the store's own config or
  // the allowlist - which is what turns "no merge driver can execute" from a
  // property of the environment list into a checked fact about this run.
  const configVerdict = validateStoreConfig(at, storePath, runner);
  if (!configVerdict.ok) {
    return rec({ stage: "config_isolation", config_isolated: false, foreign_config: configVerdict.foreign, error: configVerdict.error });
  }
  const isolation = { config_isolated: true, foreign_config: [] };

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
    return rec({ ...isolation, stage: "resolve", error: `an object lookup could not be answered - ${found.unknown}` });
  }

  let fetched = false;
  let fetchError = null;
  if (found.missing.length > 0) {
    const url = gitRemoteUrl(cfg, "origin", runner);
    if (!url.ok) {
      return rec({
        ...isolation,
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
        ...isolation,
        stage: "fetch",
        missing_objects: found.missing,
        error: `the repository's origin does not point at ${cfg.repoOwner}/${cfg.repoName}, so no object may be `
          + "fetched from it for this proof"
      });
    }
    // The ONE invocation that keeps the host environment: it needs the host's
    // credentials, it computes nothing, and what it brings back is verified by
    // sha by git itself - so it can fail, but it cannot substitute content.
    const got = gitFetchObjects(fetchAt, url.value, found.missing, runner);
    fetched = true;
    if (!got.ok) fetchError = got.error;
    found = resolve();
    if (found.unknown) {
      return rec({
        ...isolation,
        stage: "resolve",
        fetched,
        fetch_error: fetchError,
        error: `an object lookup could not be answered after fetching - ${found.unknown}`
      });
    }
  }

  if (found.missing.length > 0) {
    return rec({
      ...isolation,
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
  const so_far = { ...isolation, fetched, fetch_error: fetchError, ...resolved };

  // --- 3b. does any COMMITTED attribute request a merge driver? ------------
  //
  // No driver can EXECUTE - the configuration has just been proven to define
  // none. But git falls back to its built-in merge silently when an attribute
  // names a driver it does not have (measured, not assumed), and that fallback
  // is a DIFFERENT tree from the one a machine holding the driver computes. So
  // content that asks for one is an ambiguity, and ambiguity fails closed.
  const mergeBase = gitMergeBase(at, base, head, runner);
  if (!mergeBase.ok) {
    return rec({ ...so_far, stage: "attributes", error: `the merge base of ${base} and ${head} could not be read: ${mergeBase.error}` });
  }
  const drivers = scanMergeDrivers(at, [base, head, mergeBase.sha], runner);
  if (!drivers.ok) {
    return rec({ ...so_far, stage: "attributes", attribute_files_scanned: drivers.scanned, error: `the committed merge attributes could not be read, so it is not known whether this merge asks for a driver: ${drivers.error}` });
  }
  const scanned = { custom_merge_drivers: drivers.requested, attribute_files_scanned: drivers.scanned };
  if (drivers.requested.length > 0) {
    return rec({
      ...so_far,
      ...scanned,
      stage: "attributes",
      error: `the content being merged requests a non-built-in merge driver (${drivers.requested.join("; ")}). No such `
        + "driver is defined here and none may be, so git would fall back to its built-in merge - which is not "
        + "necessarily the tree this merge was made with. That is an ambiguity, and an ambiguous proof is not a proof"
    });
  }

  // --- 4. the merge git itself computes from those exact objects -----------
  const merged = gitMergeTree(at, base, head, runner, { emptyAttributes: environment.paths.emptyAttributes });
  if (!merged.ok) {
    return rec({
      ...so_far,
      ...scanned,
      stage: "merge_tree",
      error: `the three-way merge of ${base} and ${head} could not be computed: ${merged.error}`
    });
  }
  if (merged.conflicted) {
    return rec({
      ...so_far,
      ...scanned,
      stage: "merge_tree",
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
      ...so_far,
      ...scanned,
      conflicted: false,
      expected_tree: merged.tree,
      error: `the merge commit ${merge} could not be read as an object: `
        + [mergeTree.ok ? null : `tree: ${mergeTree.error}`, mergeParents.ok ? null : `parents: ${mergeParents.error}`]
          .filter(Boolean).join("; ")
    });
  }

  return rec({
    ...so_far,
    ...scanned,
    ok: true,
    stage: "complete",
    conflicted: false,
    expected_tree: merged.tree,
    merge_commit_tree: norm(mergeTree.value),
    merge_commit_parents: mergeParents.parents.map((p) => norm(p))
  });
}

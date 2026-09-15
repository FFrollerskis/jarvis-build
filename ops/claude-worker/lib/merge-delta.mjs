/**
 * D-157: THE EFFECTIVE CHANGE A MERGE INTRODUCED, COMPARED TO WHAT WAS REVIEWED.
 *
 * ------------------------------------------------------------------------
 * THE CONTROL-PLANE FALSE NEGATIVE THIS MODULE CLOSES
 * ------------------------------------------------------------------------
 *
 * D-145 proved "the merge introduced no unreviewed content" by requiring
 *
 *     merge commit tree === approved head tree
 *
 * That equality is TRUE for exactly one topology: a branch that already contains
 * every commit on its base. It is the topology D-144's fixture happened to have,
 * and the invariant was written from that fixture.
 *
 * It is NOT an invariant of a normal merge. When a branch was cut before later
 * base commits landed - the ordinary case for any repository with more than one
 * PR in flight - GitHub's merge commit correctly carries BOTH the reviewed head
 * delta AND the base-only content the branch never had. Its tree therefore
 * differs from the head tree, by construction, with nothing whatsoever wrong.
 *
 * D-156 is the proof. PR #82 merged from base `091ba091` and head `170e5810`
 * into merge commit `6f1c980c`, with exactly two parents in the right order,
 * three green post-merge CI jobs and an independently reviewed delta. Read fresh
 * from the remote:
 *
 *     merge tree  eef13c74...   head tree  64815377...       -> NOT EQUAL
 *     base...head  status=diverged  ahead_by=3  behind_by=17
 *
 * The branch was 17 commits behind. The old rule called that
 * `..._so_the_merge_introduced_unreviewed_content` and held a completion gate on
 * a merge that was, in fact, exactly the authorized one. A control-plane gate
 * that refuses correct history is not "strict"; it is WRONG, and it trains the
 * operator to route around the gate, which is how a real fail-open gets shipped.
 *
 * ------------------------------------------------------------------------
 * WHAT IS PROVEN INSTEAD, AND WHY IT IS STRICTLY STRONGER
 * ------------------------------------------------------------------------
 *
 * The question was never "does the merge tree equal the head tree?". It is:
 *
 *     Did the merge introduce, onto the authorized base, EXACTLY the change that
 *     was independently reviewed for the exact authorized head - and nothing else?
 *
 * That is a statement about the EFFECTIVE CHANGE, not about a tree identity, and
 * it is decidable from two SHA-addressed comparisons that GitHub will compute on
 * demand and that no actor in this system can influence:
 *
 *     MERGE DELTA     compare(parent1 ... mergeSha)
 *                     what the merge actually did to the base branch
 *     REVIEWED DELTA  compare(expectedBase ... expectedHead)
 *                     the delta the trusted order authorized, addressed purely by
 *                     the two shas the architect named
 *
 * `parent1` is the merge commit's own first parent, already proven equal to
 * `expectedBase` by the caller, and `mergeSha` is the PR's recorded merge commit.
 * So both comparisons are pinned to immutable commit shas - not to a branch name,
 * not to a mutable PR resource, and not to anything the child reported.
 *
 * THE INVARIANT: those two deltas must be IDENTICAL, file for file and field for
 * field - filename, status, rename source, resulting blob sha, added and deleted
 * line counts, and patch text.
 *
 * This is strictly stronger than the tree check it replaces:
 *
 *   - Tree equality said nothing at all about HOW the merge got there. The delta
 *     says the merge's effect on the base is precisely the reviewed patch.
 *   - Any conflict resolution that was not covered by the review - a rewritten
 *     hunk, a dropped hunk, a file taken from the wrong side - changes
 *     `compare(parent1...merge)` and is refused by name.
 *   - Any extra file slipped into the merge tree appears in the merge delta and
 *     not in the reviewed delta, and is refused by name.
 *   - The resulting BLOB SHA is compared per file, so content equality does not
 *     rest on patch text. A binary file, or a file too large for GitHub to render
 *     a patch for, is still compared by content-addressed identity.
 *
 * And it is correct for BOTH topologies, with ONE rule rather than a special case:
 *
 *   - head already contains base: merge-base is the base, the merge tree equals
 *     the head tree, and `diff(base, merge) == diff(base, head)`. Passes.
 *   - head diverged from base with no overlapping change: the merge tree differs
 *     from the head tree, and `diff(parent1, merge)` is still exactly the reviewed
 *     delta. Passes - and this is the case D-156 was wrongly refused for.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ------------------------------------------------------------------------
 *
 * It does not read the PR's own file list. `pulls/<n>/files` is a MUTABLE
 * projection of a mutable resource whose diff base GitHub is free to recompute,
 * and it adds nothing: the reviewed delta is already a pure function of the two
 * shas the trusted order names, and the caller has separately proven that the
 * remote PR's head IS `expectedHead`. Binding a safety gate to an undocumented
 * projection would add a false-negative surface, not a guarantee.
 *
 * It does not weaken, replace or stand in for any other guard. Exact-sha
 * authorization, ordered two-parent structure, merge-method refusal, required
 * exact-head review, required post-merge CI on the exact merge sha, the durable
 * order binding, commit provenance and the narrow single-commit excuse are all
 * unchanged and all still mandatory.
 *
 * Pure. Every input is already-fetched data, every branch is a named fail-closed
 * refusal, and nothing here can reach the filesystem, the network or git.
 */

/**
 * Every outcome this module can produce. One name per distinct finding, in the
 * same flat reason namespace `merge-transition.mjs` spreads its other leaf
 * modules into, so a record, a log line and a status comment never have to know
 * which half of the proof refused.
 */
export const MERGE_DELTA = Object.freeze({
  /** The effective change from parent 1 to the merge IS the reviewed delta. */
  DELTA_MATCHES:
    "the_effective_change_from_the_merge_first_parent_to_the_merge_commit_is_exactly_the_reviewed_pull_request_delta",

  /* --- readability. Unreadable is never "matches". --- */
  /** `compare(parent1...merge)` could not be read. */
  MERGE_DELTA_UNREADABLE:
    "the_effective_change_from_the_merge_first_parent_to_the_merge_commit_could_not_be_read_from_the_remote",
  /** `compare(expectedBase...expectedHead)` could not be read. */
  REVIEWED_DELTA_UNREADABLE:
    "the_reviewed_pull_request_delta_for_the_authorized_base_and_head_could_not_be_read_from_the_remote",

  /* --- identity: did the remote answer about the range we asked about? --- */
  /** The merge comparison is not anchored at the merge commit's own first parent. */
  MERGE_DELTA_WRONG_RANGE:
    "the_merge_delta_comparison_does_not_answer_about_the_exact_merge_first_parent_and_merge_commit",
  /** The reviewed comparison is not anchored at the authorized base and head. */
  REVIEWED_DELTA_WRONG_RANGE:
    "the_reviewed_delta_comparison_does_not_answer_about_the_exact_authorized_base_and_head",
  /**
   * The merge commit does not strictly descend from its own first parent.
   *
   * A normal merge is always AHEAD of parent 1 and never behind it. A rebase, a
   * force-pushed replacement or a synthetic history that merely claims these
   * parents fails here, structurally, without trusting any field that says
   * "method=merge".
   */
  MERGE_NOT_DESCENDED_FROM_FIRST_PARENT:
    "the_merge_commit_does_not_strictly_descend_from_its_own_first_parent_so_the_transition_is_not_a_forward_merge",

  /* --- completeness. A file we never saw cannot be compared. --- */
  /** A comparison hit the remote's page cap, so some changed file was never seen. */
  DELTA_TRUNCATED:
    "a_delta_comparison_was_truncated_by_the_remote_so_at_least_one_changed_file_was_never_seen",

  /* --- the comparison itself --- */
  /** The reviewed delta changes nothing, so there is no reviewed change to reproduce. */
  REVIEWED_DELTA_EMPTY:
    "the_reviewed_pull_request_delta_is_empty_so_there_is_no_reviewed_change_for_the_merge_to_reproduce",
  /** The merge touched a different SET of files than the review did. */
  DELTA_FILE_SET_MISMATCH:
    "the_merge_changed_a_different_set_of_files_than_the_reviewed_pull_request_delta",
  /** Same file, different content: altered patch, or conflict resolution the review never saw. */
  DELTA_CONTENT_MISMATCH:
    "a_file_the_merge_changed_does_not_match_the_reviewed_pull_request_delta_for_that_file",
  /** Neither a blob sha nor a patch is available, so content equality is unprovable. */
  DELTA_FILE_UNVERIFIABLE:
    "a_changed_file_carries_neither_a_blob_sha_nor_a_patch_so_its_content_cannot_be_compared_exactly"
});

/**
 * GitHub serves at most 300 files and 250 commits on one page of a comparison.
 * Hitting either cap means the answer MAY be short, and a file we never saw
 * cannot be compared - so the caps are treated as evidence of truncation rather
 * than as an upper bound to silently accept.
 */
export const COMPARE_FILE_PAGE_CAP = 300;
export const COMPARE_COMMIT_PAGE_CAP = 250;

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

function fullSha(value) {
  return typeof value === "string" && FULL_SHA_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
}

function sameSha(a, b) {
  const x = fullSha(a);
  const y = fullSha(b);
  return x !== null && y !== null && x === y;
}

/** A string, or null. Never `undefined`, so equality is total and predictable. */
function str(value) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === "" ? null : s;
}

/** A finite integer, or null. `null !== 0`, deliberately: unknown is not zero. */
function int(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

/**
 * One changed file, reduced to exactly the fields that carry content identity.
 *
 * `blobSha` is the resulting file's object id. It is the strongest field here:
 * content-addressed, produced by git rather than rendered by the API, and
 * unaffected by how a patch happens to be formatted.
 */
export function normalizeDeltaFile(raw) {
  const f = raw && typeof raw === "object" ? raw : {};
  return {
    filename: str(f.filename),
    status: str(f.status),
    previous_filename: str(f.previousFilename ?? f.previous_filename),
    blob_sha: str(f.blobSha ?? f.sha),
    additions: int(f.additions),
    deletions: int(f.deletions),
    patch: str(f.patch)
  };
}

/** The comparison fields, in a fixed order, so a mismatch names ONE field. */
const COMPARED_FIELDS = Object.freeze([
  "status", "previous_filename", "blob_sha", "additions", "deletions", "patch"
]);

/**
 * Normalize one comparison result into the shape this module compares.
 *
 * `complete` is computed here rather than trusted from the caller: it is the
 * difference between "these are the changed files" and "these are SOME of the
 * changed files", and the second can never prove anything.
 */
export function normalizeComparison(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const files = (Array.isArray(c.files) ? c.files : []).map(normalizeDeltaFile);
  const fileCount = int(c.fileCount) ?? files.length;
  const totalCommits = int(c.totalCommits);
  const commitCount = int(c.commitCount);
  return {
    base_sha: fullSha(c.baseSha),
    merge_base_sha: fullSha(c.mergeBaseSha),
    head_sha: fullSha(c.headSha),
    status: str(c.status),
    ahead_by: int(c.aheadBy),
    behind_by: int(c.behindBy),
    total_commits: totalCommits,
    commit_count: commitCount,
    file_count: fileCount,
    files,
    // Files are what the content proof rests on: a short file page is fatal.
    files_complete: files.length === fileCount && fileCount < COMPARE_FILE_PAGE_CAP,
    // Commits are used ONLY for the head-identity cross-check below, which is a
    // redundant confirmation rather than load-bearing - so a short commit page
    // downgrades that one check instead of refusing the whole comparison.
    commits_complete: totalCommits !== null && commitCount === totalCommits
      && commitCount < COMPARE_COMMIT_PAGE_CAP
  };
}

/** Compact per-comparison evidence, carried on every outcome, pass or refusal. */
function comparisonEvidence(c) {
  if (!c) return null;
  return {
    base_sha: c.base_sha,
    merge_base_sha: c.merge_base_sha,
    head_sha: c.head_sha,
    status: c.status,
    ahead_by: c.ahead_by,
    behind_by: c.behind_by,
    total_commits: c.total_commits,
    file_count: c.file_count,
    files_complete: c.files_complete,
    commits_complete: c.commits_complete
  };
}

/**
 * THE PROOF. Is the effective change the merge introduced onto its own first
 * parent exactly the reviewed delta the trusted order authorized?
 *
 *   mergeDelta      `{ ok, item }` for `compare(parent1 ... mergeSha)`
 *   reviewedDelta   `{ ok, item }` for `compare(expectedBase ... expectedHead)`
 *   parent1         the merge commit's OWN first parent, read off the merge commit
 *   mergeSha        the PR's recorded merge commit sha
 *   expectedBase    the authorized base, from the trusted ARCHITECT_TASK
 *   expectedHead    the authorized head, from the trusted ARCHITECT_TASK
 *
 * Returns `{ ok, reason, detail, evidence }`. `ok: false` is always a named
 * refusal, and `evidence` is populated on refusals too so a held gate can be
 * understood without re-running anything.
 */
export function verifyMergeDelta({
  mergeDelta,
  reviewedDelta,
  parent1,
  mergeSha,
  expectedBase,
  expectedHead
}) {
  const p1 = fullSha(parent1);
  const merge = fullSha(mergeSha);
  const base = fullSha(expectedBase);
  const head = fullSha(expectedHead);

  let evidence = {
    merge_delta: null,
    reviewed_delta: null,
    compared_file_count: 0,
    compared_files: [],
    head_identity_confirmed_from_commits: false,
    mismatched_file: null,
    mismatched_field: null
  };
  const refuse = (reason, detail) => ({ ok: false, reason, detail, evidence });

  // --- 1. both comparisons were actually read ------------------------------
  if (!mergeDelta || mergeDelta.ok !== true || !mergeDelta.item) {
    return refuse(MERGE_DELTA.MERGE_DELTA_UNREADABLE, mergeDelta?.error ?? "not queried");
  }
  if (!reviewedDelta || reviewedDelta.ok !== true || !reviewedDelta.item) {
    return refuse(MERGE_DELTA.REVIEWED_DELTA_UNREADABLE, reviewedDelta?.error ?? "not queried");
  }
  const M = normalizeComparison(mergeDelta.item);
  const R = normalizeComparison(reviewedDelta.item);
  evidence = { ...evidence, merge_delta: comparisonEvidence(M), reviewed_delta: comparisonEvidence(R) };

  // --- 2. the merge comparison is anchored where we think it is ------------
  //
  // `base_commit` is the commit the remote compared FROM. If it is not the merge
  // commit's own first parent, this answer is about some other range and proves
  // nothing about this merge.
  if (!p1 || !merge) {
    return refuse(MERGE_DELTA.MERGE_DELTA_WRONG_RANGE,
      `the caller supplied parent1=${JSON.stringify(parent1 ?? null)} and mergeSha=${JSON.stringify(mergeSha ?? null)},`
      + " and a comparison can only be bound to full 40-character shas");
  }
  if (!sameSha(M.base_sha, p1)) {
    return refuse(MERGE_DELTA.MERGE_DELTA_WRONG_RANGE,
      `the merge comparison is anchored at ${JSON.stringify(M.base_sha)}, not at the merge commit's own first `
      + `parent ${p1}`);
  }
  // A normal merge is strictly AHEAD of parent 1: parent 1 is its ancestor, so
  // the merge base of the two IS parent 1 and nothing is behind. A rebase or a
  // replaced history cannot produce this shape.
  if (!sameSha(M.merge_base_sha, p1) || M.behind_by !== 0 || M.status !== "ahead") {
    return refuse(MERGE_DELTA.MERGE_NOT_DESCENDED_FROM_FIRST_PARENT,
      `compare(${p1}...${merge}) reports status=${JSON.stringify(M.status)}, ahead_by=${M.ahead_by}, `
      + `behind_by=${M.behind_by}, merge_base=${JSON.stringify(M.merge_base_sha)}; a normal two-parent merge is `
      + "strictly ahead of its own first parent, with that parent as the merge base and nothing behind");
  }

  // --- 3. the reviewed comparison is anchored at the AUTHORIZED shas --------
  if (!base || !head) {
    return refuse(MERGE_DELTA.REVIEWED_DELTA_WRONG_RANGE,
      `the authorization supplied base=${JSON.stringify(expectedBase ?? null)} and `
      + `head=${JSON.stringify(expectedHead ?? null)}`);
  }
  if (!sameSha(R.base_sha, base)) {
    return refuse(MERGE_DELTA.REVIEWED_DELTA_WRONG_RANGE,
      `the reviewed comparison is anchored at ${JSON.stringify(R.base_sha)}, not at the authorized base ${base}`);
  }

  // The head-identity cross-check. `commits` is ordered oldest-first and its last
  // element is the commit compared TO, so when the commit list is PROVEN whole it
  // confirms the remote answered about the exact sha each URL named. When the
  // commit page was capped this confirmation is unavailable - which is recorded
  // as `head_identity_confirmed_from_commits: false` rather than passed over in
  // silence. It is a redundant confirmation either way: both URLs are built from
  // shas already verified against the merge commit object and the trusted order,
  // and an unknown sha is a 404, not a wrong answer.
  const headIdentityAvailable = M.commits_complete && R.commits_complete
    && M.head_sha !== null && R.head_sha !== null;
  if (headIdentityAvailable) {
    if (!sameSha(M.head_sha, merge)) {
      return refuse(MERGE_DELTA.MERGE_DELTA_WRONG_RANGE,
        `the merge comparison ends at ${JSON.stringify(M.head_sha)}, not at the merge commit ${merge}`);
    }
    if (!sameSha(R.head_sha, head)) {
      return refuse(MERGE_DELTA.REVIEWED_DELTA_WRONG_RANGE,
        `the reviewed comparison ends at ${JSON.stringify(R.head_sha)}, not at the authorized head ${head}`);
    }
    evidence = { ...evidence, head_identity_confirmed_from_commits: true };
  }

  // --- 4. completeness: every changed file was actually seen ---------------
  if (!M.files_complete || !R.files_complete) {
    return refuse(MERGE_DELTA.DELTA_TRUNCATED,
      `merge delta: ${M.files.length} of ${M.file_count} file(s) read; reviewed delta: ${R.files.length} of `
      + `${R.file_count} file(s) read; the remote serves at most ${COMPARE_FILE_PAGE_CAP} files per comparison, so a `
      + "count at or above that cap may be short - and a changed file that was never seen can never be compared");
  }

  // --- 5. a merge that reproduces nothing proves nothing --------------------
  if (R.files.length === 0) {
    return refuse(MERGE_DELTA.REVIEWED_DELTA_EMPTY,
      `compare(${base}...${head}) reports no changed files; two empty deltas are trivially equal, which is an `
      + "identity rather than evidence that an authorized change was merged");
  }

  // --- 6. the same SET of files -------------------------------------------
  const byName = (a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
  const mf = [...M.files].sort(byName);
  const rf = [...R.files].sort(byName);
  const mNames = mf.map((f) => f.filename);
  const rNames = rf.map((f) => f.filename);
  evidence = { ...evidence, compared_file_count: rNames.length, compared_files: rNames };

  if (mNames.length !== rNames.length || mNames.some((n, i) => n !== rNames[i])) {
    const extra = mNames.filter((n) => !rNames.includes(n));
    const missing = rNames.filter((n) => !mNames.includes(n));
    return refuse(MERGE_DELTA.DELTA_FILE_SET_MISMATCH,
      `the merge changed ${mNames.length} file(s) and the review covered ${rNames.length}; `
      + `introduced by the merge and never reviewed: ${extra.length ? JSON.stringify(extra) : "none"}; `
      + `reviewed but not produced by the merge: ${missing.length ? JSON.stringify(missing) : "none"}`);
  }

  // --- 7. and the same CONTENT, file by file, field by field ---------------
  for (let i = 0; i < rf.length; i++) {
    const m = mf[i];
    const r = rf[i];
    // Content must be provable by SOMETHING. A blob sha is content-addressed and
    // survives a missing patch (binary, or too large to render); a patch survives
    // a missing blob sha. Neither present means two nulls would compare equal
    // while proving nothing, so it is refused by name instead.
    if (m.blob_sha === null && m.patch === null) {
      return refuse(MERGE_DELTA.DELTA_FILE_UNVERIFIABLE,
        `the merge delta entry for ${JSON.stringify(r.filename)} carries neither a blob sha nor a patch`);
    }
    if (r.blob_sha === null && r.patch === null) {
      return refuse(MERGE_DELTA.DELTA_FILE_UNVERIFIABLE,
        `the reviewed delta entry for ${JSON.stringify(r.filename)} carries neither a blob sha nor a patch`);
    }
    for (const field of COMPARED_FIELDS) {
      if (m[field] === r[field]) continue;
      evidence = { ...evidence, mismatched_file: r.filename, mismatched_field: field };
      const show = (v) => (field === "patch"
        ? `${v === null ? "absent" : `${String(v).length} character(s)`}`
        : JSON.stringify(v));
      return refuse(MERGE_DELTA.DELTA_CONTENT_MISMATCH,
        `${JSON.stringify(r.filename)}: the merge produced ${field}=${show(m[field])} but the reviewed delta for the `
        + `authorized head has ${field}=${show(r[field])}; the merge therefore did not reproduce the reviewed change `
        + "for this file - an altered patch, a dropped hunk or a conflict resolution the review never covered");
    }
  }

  return {
    ok: true,
    reason: MERGE_DELTA.DELTA_MATCHES,
    detail: `the merge commit ${merge} changes exactly the ${rf.length} file(s) the reviewed delta `
      + `compare(${base}...${head}) changes, with identical status, rename source, resulting blob sha, line counts `
      + `and patch text for every one of them; the branch was ${R.behind_by ?? "an unknown number of"} commit(s) `
      + `behind its base and ${R.ahead_by ?? "an unknown number of"} ahead, so the merge tree legitimately carries `
      + "base-only content as well - which is why tree identity with the head is not, and never was, the invariant"
      + (evidence.head_identity_confirmed_from_commits
        ? ""
        : " (the commit lists were capped, so the redundant end-of-range identity cross-check was unavailable; both "
          + "ranges remain pinned to shas verified against the merge commit object and the trusted order)"),
    evidence
  };
}

/** Human-readable lines for a status comment or log. */
export function describeMergeDelta(evidence) {
  if (!evidence) return [];
  const m = evidence.merge_delta;
  const r = evidence.reviewed_delta;
  const lines = [
    `  MERGE DELTA (parent1 -> merge): ${m ? `${m.status} +${m.ahead_by}/-${m.behind_by}, ${m.file_count} file(s)`
      : "not read"}`,
    `  REVIEWED DELTA (base -> head):  ${r ? `${r.status} +${r.ahead_by}/-${r.behind_by}, ${r.file_count} file(s)`
      : "not read"}`,
    `  compared files: ${evidence.compared_file_count}`
      + (evidence.compared_files?.length ? ` (${evidence.compared_files.slice(0, 8).join(", ")}`
        + `${evidence.compared_files.length > 8 ? ", ..." : ""})` : "")
  ];
  if (evidence.mismatched_file) {
    lines.push(`  FIRST MISMATCH: ${evidence.mismatched_file} field=${evidence.mismatched_field}`);
  }
  return lines;
}

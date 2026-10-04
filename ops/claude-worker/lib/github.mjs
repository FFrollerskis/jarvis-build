/**
 * GitHub access via the `gh` CLI.
 *
 * No token is ever handled, read, logged or passed as an argument here - `gh`
 * owns its own stored auth. If auth is unavailable the caller fails closed.
 *
 * D126 review blocker 6: every lookup now returns `{ ok, items, error }`.
 * `listRemoteBranches` and `listPulls` used to swallow ANY failure and return
 * `[]`, so a rate limit, a network drop or an auth expiry was indistinguishable
 * from "this task has never produced a branch or a PR" - and the worker would
 * then happily dispatch a duplicate attempt. A failed lookup is never proof of
 * absence, and the caller is now forced to see the difference.
 *
 * Pull requests are paginated: `per_page=50` silently truncated the search, so a
 * PR older than the newest 50 simply did not exist as far as reconciliation was
 * concerned.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { sanitize } from "./health.mjs";

/**
 * Test seam. `JARVIS_WORKER_GH` may name a real executable or a `.mjs` script;
 * a script is run with this same node binary, so an integration test can drive
 * the REAL worker entrypoint cross-platform without a `gh` install. The variable
 * is host-controlled, exactly like config.json, so this widens no trust boundary.
 */
export function resolveBinary(envName, fallback) {
  const override = process.env[envName];
  if (!override) return { command: fallback, prefix: [] };
  if (/\.(mjs|cjs|js)$/i.test(override)) return { command: process.execPath, prefix: [override] };
  return { command: override, prefix: [] };
}

/**
 * D-397 (JARVIS-088): every `gh` call is time-bounded. `execFileSync` without a timeout blocks the worker (and, through the
 * lock heartbeat it can no longer renew, the whole queue) for as long as GitHub or the network cares to hang. A timeout
 * surfaces as a thrown error, which every caller here already maps to `{ ok: false }` = UNKNOWN, never "nothing there".
 * Override with `JARVIS_WORKER_GH_TIMEOUT_MS` (clamped 1 s .. 30 min); default 2 min.
 */
export function timeoutMsFromEnv(envName, fallbackMs, env = process.env) {
  const raw = Number(env[envName]);
  if (!Number.isFinite(raw) || raw <= 0) return fallbackMs;
  return Math.min(30 * 60_000, Math.max(1_000, Math.trunc(raw)));
}

function gh(args, opts = {}) {
  const { command, prefix } = resolveBinary("JARVIS_WORKER_GH", "gh");
  return execFileSync(command, [...prefix, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMsFromEnv("JARVIS_WORKER_GH_TIMEOUT_MS", 120_000),
    killSignal: "SIGKILL",
    ...opts
  });
}

export function verifyAuth(runner = gh) {
  try {
    runner(["auth", "status"]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: sanitize(err.message) };
  }
}

/**
 * Parse `gh api --paginate` output, which may be one JSON array per page.
 *
 * D-149: this ALSO reports whether every fragment it was handed actually parsed.
 * The fallback branch below drops a fragment it cannot read, and a dropped page
 * is indistinguishable from a short page by looking at the result array - which
 * is precisely how a control comment can go missing without anything failing.
 * `complete: false` means AT LEAST ONE FRAGMENT WAS LOST, and a caller deciding
 * anything from the ABSENCE of an element must refuse on it.
 *
 * Returns `{ items, complete, dropped_fragments }`.
 */
export function parsePaginatedJsonDetailed(text) {
  const trimmed = String(text ?? "").trim();
  // An empty response is a complete answer: `gh` printed nothing because there
  // was nothing. That is a PROVEN empty set, not a failed read.
  if (!trimmed) return { items: [], complete: true, dropped_fragments: 0 };
  try {
    const parsed = JSON.parse(trimmed);
    return { items: Array.isArray(parsed) ? parsed : [parsed], complete: true, dropped_fragments: 0 };
  } catch {
    const re = /\[[\s\S]*?\](?=\s*\[|\s*$)/g;
    const items = [];
    let dropped = 0;
    let covered = 0;
    let uncovered = "";
    let match;
    while ((match = re.exec(trimmed)) !== null) {
      // Anything BETWEEN two recognised fragments was never even offered to
      // JSON.parse. A truncated page is exactly that shape, and counting only
      // parse failures would have missed it entirely - so the gap is measured,
      // not assumed away.
      uncovered += trimmed.slice(covered, match.index);
      covered = match.index + match[0].length;
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) items.push(...parsed);
        else items.push(parsed);
      } catch {
        dropped += 1;
      }
    }
    uncovered += trimmed.slice(covered);
    // Whitespace between pages is not a lost page.
    if (uncovered.trim() !== "") dropped += 1;
    // Nothing matched at all: the whole response is one unreadable fragment.
    if (items.length === 0 && dropped === 0) dropped = 1;
    return { items, complete: dropped === 0, dropped_fragments: dropped };
  }
}

/** Backwards-compatible projection: the items alone. */
export function parsePaginatedJson(text) {
  return parsePaginatedJsonDetailed(text).items;
}

/** Parse newline-delimited JSON produced by `gh api --jq`. */
export function parseJsonLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

/**
 * Control-issue comments, WITH an explicit completeness verdict.
 *
 * D-149: `{ ok, items, complete, error }`. The three states are deliberately
 * distinct and a caller must not collapse them:
 *
 *   ok:true,  complete:true   every page was read and parsed. An empty `items`
 *                             is then a PROVEN empty set.
 *   ok:true,  complete:false  something came back, but at least one fragment
 *                             could not be parsed. Absence proves NOTHING.
 *   ok:false, complete:false  the read failed outright. Absence proves nothing,
 *                             and `items` is empty only because there is no data.
 *
 * Reading `items.length === 0` without consulting `complete` is exactly the bug
 * D-149 closes: a failed read handed to a decision that treats "not found" as
 * "there was never an order".
 */
export function fetchIssueCommentsDetailed({ repoOwner, repoName, controlIssue }, runner = gh) {
  let out;
  try {
    out = runner([
      "api",
      `repos/${repoOwner}/${repoName}/issues/${controlIssue}/comments`,
      "--paginate"
    ]);
  } catch (err) {
    return { ok: false, items: [], complete: false, dropped_fragments: 0, error: sanitize(err.message) };
  }
  const parsed = parsePaginatedJsonDetailed(out);
  return {
    ok: true,
    items: parsed.items,
    complete: parsed.complete,
    dropped_fragments: parsed.dropped_fragments,
    error: parsed.complete
      ? null
      : `${parsed.dropped_fragments} paginated fragment(s) could not be parsed, so the comment collection is incomplete`
  };
}

/**
 * Control-issue comments. Throws on failure - the caller must treat an
 * unreadable queue as transient, never as an empty queue.
 *
 * Retained as the array-returning form for callers that only need the items and
 * that already treat a throw as "unknown". Anything deciding on ABSENCE must use
 * `fetchIssueCommentsDetailed` and honour `complete`.
 */
export function fetchIssueComments(cfg, runner = gh) {
  const result = fetchIssueCommentsDetailed(cfg, runner);
  if (!result.ok) throw new Error(result.error);
  return result.items;
}

/**
 * Post a comment. The body is written to a temp file OUTSIDE the repository and
 * passed by reference, so no shell quoting, no argv length limit and no chance
 * of a body fragment leaking into a process listing.
 */
export function postComment({ repoOwner, repoName, controlIssue }, body, scratchDir, runner = gh) {
  mkdirSync(scratchDir, { recursive: true });
  const file = join(scratchDir, `comment-${process.pid}-${Date.now()}.md`);
  writeFileSync(file, sanitize(body), "utf8");
  try {
    const out = runner([
      "api",
      `repos/${repoOwner}/${repoName}/issues/${controlIssue}/comments`,
      "-F",
      `body=@${file}`,
      "--jq",
      ".id"
    ]);
    return { ok: true, commentId: out.trim() };
  } catch (err) {
    return { ok: false, error: sanitize(err.message) };
  } finally {
    try { unlinkSync(file); } catch { /* best effort */ }
  }
}

/**
 * All remote branch names, paginated.
 * Returns `{ ok, items, error }`. `ok: false` means UNKNOWN, not empty.
 */
export function listRemoteBranches({ repoOwner, repoName }, runner = gh) {
  try {
    const out = runner(["api", `repos/${repoOwner}/${repoName}/branches?per_page=100`, "--paginate", "--jq", ".[].name"]);
    return { ok: true, items: out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) };
  } catch (err) {
    return { ok: false, items: [], error: sanitize(err.message) };
  }
}

/**
 * Open + closed PRs with head branch and merge state, paginated, for
 * duplicate-effect checks. Returns `{ ok, items, error }`.
 */
export function listPulls({ repoOwner, repoName }, runner = gh) {
  try {
    const out = runner([
      "api",
      `repos/${repoOwner}/${repoName}/pulls?state=all&per_page=100`,
      "--paginate",
      "--jq",
      // D132: `merge_commit_sha` is carried through so a resumed merge/post-merge
      // task can VERIFY the transition it already caused instead of retrying a
      // now-stale pre-merge action against post-merge state.
      ".[] | {number: .number, headRefName: .head.ref, state: .state, mergedAt: .merged_at, "
        + "mergeCommitSha: .merge_commit_sha, title: .title, body: .body}"
    ]);
    return { ok: true, items: parseJsonLines(out) };
  } catch (err) {
    return { ok: false, items: [], error: sanitize(err.message) };
  }
}

/** One specific PR by number. Used to confirm an association we already know. */
export function getPull({ repoOwner, repoName }, number, runner = gh) {
  try {
    const out = runner([
      "api",
      `repos/${repoOwner}/${repoName}/pulls/${Number(number)}`,
      "--jq",
      "{number: .number, headRefName: .head.ref, state: .state, mergedAt: .merged_at, "
        + "mergeCommitSha: .merge_commit_sha, title: .title}"
    ]);
    const parsed = parseJsonLines(out);
    return parsed.length > 0 ? { ok: true, item: parsed[0] } : { ok: false, item: null, error: "empty_response" };
  } catch (err) {
    return { ok: false, item: null, error: sanitize(err.message) };
  }
}

/**
 * D-145: the MERGE STATE of one PR, read fresh from the remote.
 *
 * Deliberately separate from `getPull`: that projection exists for duplicate
 * detection and carries no `merged` boolean, no base sha and no head sha, so it
 * cannot answer "did the AUTHORIZED merge actually happen?" at all. This one
 * returns only exact, checkable identity - never a summary and never a claim.
 *
 * `{ ok, item: { number, merged, mergeCommitSha, headSha, baseSha, baseRef,
 * headRef, state }, error }`. `ok: false` means UNKNOWN, never "not merged".
 */
export function getPullMergeState({ repoOwner, repoName }, number, runner = gh) {
  try {
    const out = runner([
      "api",
      `repos/${repoOwner}/${repoName}/pulls/${Number(number)}`,
      "--jq",
      "{number: .number, merged: .merged, mergeCommitSha: .merge_commit_sha, headSha: .head.sha, "
        + "baseSha: .base.sha, headRef: .head.ref, baseRef: .base.ref, state: .state}"
    ]);
    const parsed = parseJsonLines(out);
    return parsed.length > 0
      ? { ok: true, item: parsed[0], error: null }
      : { ok: false, item: null, error: "empty_response" };
  } catch (err) {
    return { ok: false, item: null, error: sanitize(err.message) };
  }
}

/**
 * D-145: one commit's exact identity, parents and tree.
 *
 * The PARENT LIST is the evidence that a merge was a normal two-parent merge
 * rather than a squash or a rebase, and the TREE is the evidence that the merge
 * introduced no content the review never saw. Both come from the remote, not
 * from anything the child says about what it did.
 *
 * `{ ok, item: { sha, parents: [...], treeSha, ... }, error }`.
 */
export function getCommit({ repoOwner, repoName }, sha, runner = gh) {
  try {
    const out = runner([
      "api",
      `repos/${repoOwner}/${repoName}/commits/${encodeURIComponent(String(sha))}`,
      "--jq",
      "{sha: .sha, treeSha: .commit.tree.sha, parents: [.parents[].sha], "
        + "verified: .commit.verification.verified, message: .commit.message}"
    ]);
    const parsed = parseJsonLines(out);
    return parsed.length > 0
      ? { ok: true, item: parsed[0], error: null }
      : { ok: false, item: null, error: "empty_response" };
  } catch (err) {
    return { ok: false, item: null, error: sanitize(err.message) };
  }
}

/**
 * D-145: the check runs on one exact commit.
 *
 * Used to confirm POST-MERGE CI on the merge commit itself. The CI a PR ran
 * before the merge is a different commit and does not answer this question.
 *
 * `{ ok, runs: [{ name, status, conclusion }], error }`. `ok: false` is UNKNOWN,
 * and the caller must never read UNKNOWN as green.
 */
export function getCommitCheckRuns({ repoOwner, repoName }, sha, runner = gh) {
  try {
    const out = runner([
      "api",
      `repos/${repoOwner}/${repoName}/commits/${encodeURIComponent(String(sha))}/check-runs?per_page=100`,
      "--paginate",
      "--jq",
      ".check_runs[] | {name: .name, status: .status, conclusion: .conclusion}"
    ]);
    return { ok: true, runs: parseJsonLines(out), error: null };
  } catch (err) {
    return { ok: false, runs: [], error: sanitize(err.message) };
  }
}

/*
 * D-158: `compareCommits` USED TO LIVE HERE AND IS GONE ON PURPOSE.
 *
 * D-157 added it to read `repos/O/R/compare/<a>...<b>`, so the gate could require
 * `parent1...merge` and `expectedBase...expectedHead` to be equal field for
 * field. That comparison is false for a valid merge whenever base and head
 * changed different NON-OVERLAPPING HUNKS OF ONE FILE - the merge blob correctly
 * holds both sides - so it refused correct history.
 *
 * The merge proof no longer asks the remote to diff anything. It recomputes the
 * merge from the two authorized objects with git itself (see `merge-tree.mjs`),
 * which is exact, topology-independent and not a rendered projection. The reader
 * is left as a comment rather than as an unused export so that it is not
 * reintroduced by someone looking for "the compare helper we already had".
 */

/** Does an exact branch exist on the remote? `{ ok, exists, error }`. */
export function getBranch({ repoOwner, repoName }, branch, runner = gh) {
  try {
    runner([
      "api",
      `repos/${repoOwner}/${repoName}/branches/${encodeURIComponent(String(branch))}`,
      "--jq",
      ".name"
    ]);
    return { ok: true, exists: true };
  } catch (err) {
    const message = String(err.message ?? "");
    if (/HTTP 404|Not Found|Branch not found/i.test(message)) {
      return { ok: true, exists: false };
    }
    return { ok: false, exists: null, error: sanitize(message) };
  }
}

export { dirname, gh };

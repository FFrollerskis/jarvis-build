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

function gh(args, opts = {}) {
  const { command, prefix } = resolveBinary("JARVIS_WORKER_GH", "gh");
  return execFileSync(command, [...prefix, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
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

/** Parse `gh api --paginate` output, which may be one JSON array per page. */
export function parsePaginatedJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const parts = trimmed.match(/\[[\s\S]*?\](?=\s*\[|\s*$)/g) || [trimmed];
    return parts.flatMap((p) => {
      try {
        const parsed = JSON.parse(p);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [];
      }
    });
  }
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
 * Control-issue comments. Throws on failure - the caller must treat an
 * unreadable queue as transient, never as an empty queue.
 */
export function fetchIssueComments({ repoOwner, repoName, controlIssue }, runner = gh) {
  const out = runner([
    "api",
    `repos/${repoOwner}/${repoName}/issues/${controlIssue}/comments`,
    "--paginate"
  ]);
  return parsePaginatedJson(out);
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

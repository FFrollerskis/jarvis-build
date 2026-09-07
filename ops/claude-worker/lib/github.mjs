/**
 * GitHub access via the `gh` CLI.
 *
 * No token is ever handled, read, logged or passed as an argument here - `gh`
 * owns its own stored auth. If auth is unavailable the caller fails closed.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { sanitize } from "./health.mjs";

function gh(args, opts = {}) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts
  });
}

export function verifyAuth() {
  try {
    gh(["auth", "status"]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: sanitize(err.message) };
  }
}

export function fetchIssueComments({ repoOwner, repoName, controlIssue }) {
  const out = gh([
    "api",
    `repos/${repoOwner}/${repoName}/issues/${controlIssue}/comments`,
    "--paginate"
  ]);
  const text = out.trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    // Some gh versions concatenate one JSON array per page.
    const parts = text.match(/\[[\s\S]*?\](?=\s*\[|\s*$)/g) || [text];
    return parts.flatMap((p) => {
      try { return JSON.parse(p); } catch { return []; }
    });
  }
}

/**
 * Post a comment. The body is written to a temp file OUTSIDE the repository and
 * passed by reference, so no shell quoting, no argv length limit and no chance
 * of a body fragment leaking into a process listing.
 */
export function postComment({ repoOwner, repoName, controlIssue }, body, scratchDir) {
  mkdirSync(scratchDir, { recursive: true });
  const file = join(scratchDir, `comment-${process.pid}-${Date.now()}.md`);
  writeFileSync(file, sanitize(body), "utf8");
  try {
    const out = gh([
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

/** Remote branch names, used to reconcile a prior attempt before any retry. */
export function listRemoteBranches({ repoOwner, repoName }) {
  try {
    const out = gh(["api", `repos/${repoOwner}/${repoName}/branches`, "--paginate", "--jq", ".[].name"]);
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/** Open+closed PRs with head branch and merge state, for duplicate-effect checks. */
export function listPulls({ repoOwner, repoName }) {
  try {
    const out = gh([
      "api",
      `repos/${repoOwner}/${repoName}/pulls?state=all&per_page=50`,
      "--jq",
      ".[] | {number: .number, headRefName: .head.ref, state: .state, mergedAt: .merged_at}"
    ]);
    return out.split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export { dirname };

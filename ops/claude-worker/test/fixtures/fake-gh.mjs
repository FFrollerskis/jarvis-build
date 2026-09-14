/**
 * Stand-in for the `gh` CLI, used by the worker integration test.
 *
 * The worker reaches GitHub only through `lib/github.mjs`, which resolves its
 * binary from JARVIS_WORKER_GH. Pointing that at this script lets the test drive
 * the REAL worker entrypoint - process start, lock, state, dispatch, crash
 * recovery - cross-platform, without a gh install and without touching the real
 * control issue.
 *
 * Store layout (JARVIS_FAKE_GH_DIR):
 *   comments.json   - the control issue's comments, read and appended to
 *   branches.json   - remote branch names
 *   pulls.json      - pull requests. D-145: an entry may additionally carry
 *                     `merged`, `headSha`, `baseSha`, `headRef`, `baseRef`, which
 *                     `repos/O/R/pulls/<n>` serves as the merge-state projection.
 *   commits.json    - D-145: `{ "<sha>": { sha, treeSha, parents: [...] } }`,
 *                     served by `repos/O/R/commits/<sha>`. A sha that is absent
 *                     404s, exactly as the real API does.
 *   check-runs.json - D-145: `{ "<sha>": [{ name, status, conclusion }] }`,
 *                     served by `repos/O/R/commits/<sha>/check-runs`.
 *   fail.json       - optional { auth, comments, branches, pulls, commits,
 *                     checks, mergeState } booleans
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.JARVIS_FAKE_GH_DIR;
const args = process.argv.slice(2);

function read(name, fallback) {
  const path = join(DIR, name);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

const failures = read("fail.json", {});

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (args[0] === "auth" && args[1] === "status") {
  if (failures.auth) die("gh: You are not logged into any GitHub hosts");
  process.stdout.write("Logged in to github.com\n");
  process.exit(0);
}

const urlArg = args.find((a) => a.startsWith("repos/")) ?? "";

// POST a comment: `-F body=@<file>`
const bodyFlag = args.find((a) => a.startsWith("body=@"));
if (bodyFlag) {
  if (failures.post) die("gh: could not post comment");
  const file = bodyFlag.slice("body=@".length);
  const body = readFileSync(file, "utf8");
  const comments = read("comments.json", []);
  const id = 900000 + comments.length;
  const now = new Date().toISOString();
  comments.push({
    id,
    body,
    created_at: now,
    updated_at: now,
    author_association: "OWNER",
    user: { login: process.env.JARVIS_FAKE_GH_AUTHOR ?? "tsworkflow" }
  });
  writeFileSync(join(DIR, "comments.json"), JSON.stringify(comments, null, 2), "utf8");
  process.stdout.write(`${id}\n`);
  process.exit(0);
}

if (urlArg.includes("/issues/") && urlArg.includes("/comments")) {
  if (failures.comments) die("gh: HTTP 503 while listing comments");
  const delay = Number(process.env.JARVIS_FAKE_GH_DELAY_MS ?? 0);
  if (delay > 0) {
    const until = Date.now() + delay;
    while (Date.now() < until) { /* deliberate busy wait: the test kills us here */ }
  }
  process.stdout.write(JSON.stringify(read("comments.json", []), null, 2));
  process.exit(0);
}

if (urlArg.includes("/branches")) {
  if (failures.branches) die("gh: HTTP 403 rate limit exceeded");
  process.stdout.write(read("branches.json", ["main"]).join("\n") + "\n");
  process.exit(0);
}

/**
 * D-145: one commit's parents and tree, and the check runs on it.
 *
 * Matched BEFORE `/pulls` deliberately - `repos/O/R/commits/...` shares no
 * prefix with it, but keeping the exact-commit routes first makes the ordering
 * independent of how the pull routes are matched.
 */
const commitMatch = urlArg.match(/\/commits\/([^/?]+)(\/check-runs)?/);
if (commitMatch) {
  const sha = decodeURIComponent(commitMatch[1]);
  if (commitMatch[2]) {
    if (failures.checks) die("gh: HTTP 403 rate limit exceeded");
    const runs = read("check-runs.json", {})[sha];
    // An unknown sha has no check runs - not an error, just nothing.
    process.stdout.write((runs ?? []).map((r) => JSON.stringify({
      name: r.name, status: r.status ?? "completed", conclusion: r.conclusion ?? null
    })).join("\n") + ((runs ?? []).length > 0 ? "\n" : ""));
    process.exit(0);
  }
  if (failures.commits) die("gh: HTTP 403 rate limit exceeded");
  const commit = read("commits.json", {})[sha];
  if (!commit) die(`gh: HTTP 404: No commit found for SHA: ${sha}`);
  process.stdout.write(JSON.stringify({
    sha: commit.sha ?? sha,
    treeSha: commit.treeSha ?? null,
    parents: commit.parents ?? [],
    verified: commit.verified ?? true,
    message: commit.message ?? ""
  }) + "\n");
  process.exit(0);
}

// D-145: the merge-state projection for ONE pull request. Distinguished from the
// list route by the trailing number, and from `getPull` by the fields asked for.
const oneP = urlArg.match(/\/pulls\/(\d+)$/);
if (oneP && args.some((a) => String(a).includes("merged:"))) {
  if (failures.mergeState || failures.pulls) die("gh: HTTP 403 rate limit exceeded");
  const p = read("pulls.json", []).find((x) => Number(x.number) === Number(oneP[1]));
  if (!p) die(`gh: HTTP 404: Not Found (pulls/${oneP[1]})`);
  process.stdout.write(JSON.stringify({
    number: p.number,
    merged: p.merged ?? false,
    mergeCommitSha: p.mergeCommitSha ?? null,
    headSha: p.headSha ?? null,
    baseSha: p.baseSha ?? null,
    headRef: p.headRefName ?? null,
    baseRef: p.baseRef ?? "main",
    state: p.state ?? "open"
  }) + "\n");
  process.exit(0);
}

if (urlArg.includes("/pulls")) {
  if (failures.pulls) die("gh: HTTP 403 rate limit exceeded");
  const pulls = read("pulls.json", []);
  process.stdout.write(pulls.map((p) => JSON.stringify({
    number: p.number,
    headRefName: p.headRefName,
    state: p.state,
    mergedAt: p.mergedAt ?? null,
    mergeCommitSha: p.mergeCommitSha ?? null,
    title: p.title ?? "",
    body: p.body ?? ""
  })).join("\n") + (pulls.length > 0 ? "\n" : ""));
  process.exit(0);
}

die(`fake-gh: unhandled invocation: ${args.join(" ")}`);

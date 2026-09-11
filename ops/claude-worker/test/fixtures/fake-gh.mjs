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
 *   comments.json  - the control issue's comments, read and appended to
 *   branches.json  - remote branch names
 *   pulls.json     - pull requests
 *   fail.json      - optional { auth, comments, branches, pulls } booleans
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

/**
 * Stand-in for `git`, used by the worker integration test.
 *
 * Resolved through JARVIS_WORKER_GIT (see lib/git.mjs), so the test drives the
 * real worker without needing a real repository in a specific state - and can
 * make any individual git query FAIL, to prove the worker treats an
 * unanswerable query as UNKNOWN rather than as a clean worktree.
 *
 * Store: JARVIS_FAKE_GIT_DIR/git.json
 *   { "status": ["?? x.md"], "head": "abc", "branch": "claude/x",
 *     "remote": "https://github.com/o/r", "fail": ["status"] }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.JARVIS_FAKE_GIT_DIR;
const args = process.argv.slice(2);

let cfg = {};
const path = join(DIR ?? ".", "git.json");
if (existsSync(path)) {
  try { cfg = JSON.parse(readFileSync(path, "utf8")); } catch { cfg = {}; }
}
const fail = new Set(cfg.fail ?? []);

function emit(text) {
  process.stdout.write(text);
  process.exit(0);
}

function die(kind, message) {
  process.stderr.write(`${message}\n`);
  process.exit(kind);
}

if (args[0] === "status") {
  if (fail.has("status")) die(128, "fatal: not a git repository (or any of the parent directories): .git");
  emit((cfg.status ?? []).join("\n") + ((cfg.status ?? []).length > 0 ? "\n" : ""));
}

if (args[0] === "rev-parse" && args[1] === "HEAD") {
  if (fail.has("head")) die(128, "fatal: ambiguous argument 'HEAD'");
  emit(`${cfg.head ?? "0000000000000000000000000000000000000000"}\n`);
}

if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
  if (fail.has("branch")) die(128, "fatal: ambiguous argument 'HEAD'");
  emit(`${cfg.branch ?? "claude/test-branch"}\n`);
}

if (args[0] === "remote" && args[1] === "get-url") {
  if (fail.has("remote")) die(2, "error: No such remote 'origin'");
  emit(`${cfg.remote ?? "https://github.com/tsworkflow/jarvisbuild"}\n`);
}

die(1, `fake-git: unhandled invocation: ${args.join(" ")}`);

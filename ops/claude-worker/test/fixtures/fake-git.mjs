/**
 * Stand-in for `git`, used by the worker integration tests.
 *
 * Resolved through JARVIS_WORKER_GIT (see lib/git.mjs), so the test drives the
 * real worker without needing a real repository in a specific state - and can
 * make any individual git query FAIL, to prove the worker treats an
 * unanswerable query as UNKNOWN rather than as a clean worktree.
 *
 * Store: JARVIS_FAKE_GIT_DIR/git.json      (the PRIMARY checkout)
 *   { "status": ["?? x.md"], "head": "abc", "branch": "claude/x",
 *     "remote": "https://github.com/o/r", "fail": ["status"] }
 *
 * Store: JARVIS_FAKE_GIT_DIR/worktrees.json  (D-133 LINKED worktrees)
 *   { "<absolute path>": { "head": "abc", "branch": null, "status": [] } }
 *
 * D-133: `git worktree` is now part of the worker's critical path, so the
 * fixture has to model it rather than stub it away. It creates and removes real
 * directories and answers `status` / `rev-parse` for whichever worktree it was
 * invoked IN - the worker selects a worktree purely by cwd (`lib/git.mjs`
 * `atPath`), so answering from cwd is what makes the fixture faithful.
 *
 * `worktree remove` is deliberately NOT forced here either: a worktree whose
 * recorded status is non-empty makes it exit non-zero, exactly as real git does.
 * That is the behaviour the conservative-cleanup test relies on, so stubbing it
 * as always-succeeds would have hidden the property it is meant to prove.
 *
 * For tests that need REAL tracked/untracked mutations, do not use this fixture
 * at all: leave JARVIS_WORKER_GIT unset and point the worker at a real
 * temporary repository (see test/fixtures/real-git-repo.mjs).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = process.env.JARVIS_FAKE_GIT_DIR;
const args = process.argv.slice(2);

const CFG_PATH = join(DIR ?? ".", "git.json");
const WT_PATH = join(DIR ?? ".", "worktrees.json");

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

const cfg = readJson(CFG_PATH, {});
const worktrees = readJson(WT_PATH, {});
const fail = new Set(cfg.fail ?? []);

/** Paths are compared case-insensitively on Windows, exactly as the OS does. */
function key(path) {
  const abs = resolve(path);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

const byKey = new Map(Object.entries(worktrees).map(([p, v]) => [key(p), { path: resolve(p), ...v }]));

function saveWorktrees() {
  const out = {};
  for (const wt of byKey.values()) {
    out[wt.path] = { head: wt.head ?? null, branch: wt.branch ?? null, status: wt.status ?? [] };
  }
  writeFileSync(WT_PATH, JSON.stringify(out, null, 2), "utf8");
}

function emit(text) {
  process.stdout.write(text);
  process.exit(0);
}

function die(kind, message) {
  process.stderr.write(`${message}\n`);
  process.exit(kind);
}

/**
 * Which checkout is this invocation about? The worker never passes `-C`; it
 * sets the child's cwd, so cwd IS the selector.
 */
const here = byKey.get(key(process.cwd())) ?? null;

/** ---------------- worktree subcommands ---------------- */

if (args[0] === "worktree") {
  if (fail.has("worktree")) die(128, "fatal: not a git repository (or any of the parent directories): .git");

  if (args[1] === "list") {
    if (fail.has("worktree-list")) die(128, "fatal: could not list worktrees");
    const blocks = [
      `worktree ${resolve(cfg.mainWorktree ?? process.cwd())}\nHEAD ${cfg.head ?? "0".repeat(40)}\nbranch refs/heads/${cfg.branch ?? "main"}\n`
    ];
    for (const wt of byKey.values()) {
      blocks.push(`worktree ${wt.path}\nHEAD ${wt.head ?? "0".repeat(40)}\ndetached\n`);
    }
    emit(blocks.join("\n") + "\n");
  }

  if (args[1] === "add") {
    if (fail.has("worktree-add")) die(128, "fatal: could not create worktree");
    // `worktree add --detach <path> <commitish>`
    const rest = args.slice(2).filter((a) => !a.startsWith("--"));
    const path = resolve(rest[0]);
    const commitish = rest[1] ?? cfg.head ?? "0".repeat(40);
    if (byKey.has(key(path))) die(128, `fatal: '${path}' is already registered`);
    mkdirSync(path, { recursive: true });
    // A real worktree is never an empty directory; the worker's classifier
    // treats "empty" as "nothing here", so the fixture must not look empty.
    writeFileSync(join(path, ".git"), `gitdir: ${resolve(cfg.mainWorktree ?? process.cwd())}/.git/worktrees/x\n`, "utf8");
    byKey.set(key(path), { path, head: commitish, branch: null, status: [] });
    saveWorktrees();
    emit(`Preparing worktree (detached HEAD ${String(commitish).slice(0, 7)})\n`);
  }

  if (args[1] === "remove") {
    if (fail.has("worktree-remove")) die(128, "fatal: could not remove worktree");
    const path = resolve(args.slice(2).filter((a) => !a.startsWith("--"))[0]);
    const wt = byKey.get(key(path));
    if (!wt) die(128, `fatal: '${path}' is not a working tree`);
    // No `--force` is ever passed by the worker, so real git would refuse here.
    if ((wt.status ?? []).length > 0) {
      die(128, `fatal: '${path}' contains modified or untracked files, use --force to delete it`);
    }
    byKey.delete(key(path));
    saveWorktrees();
    try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
    emit("");
  }

  die(1, `fake-git: unhandled worktree invocation: ${args.join(" ")}`);
}

/** ---------------- ordinary queries, answered for the CURRENT checkout ------- */

if (args[0] === "status") {
  if (fail.has("status")) die(128, "fatal: not a git repository (or any of the parent directories): .git");
  const lines = here ? (here.status ?? []) : (cfg.status ?? []);
  emit(lines.join("\n") + (lines.length > 0 ? "\n" : ""));
}

if (args[0] === "rev-parse" && args[1] === "HEAD") {
  if (fail.has("head")) die(128, "fatal: ambiguous argument 'HEAD'");
  emit(`${(here ? here.head : cfg.head) ?? "0000000000000000000000000000000000000000"}\n`);
}

if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
  if (fail.has("branch")) die(128, "fatal: ambiguous argument 'HEAD'");
  // A detached linked worktree reports HEAD, exactly as real git does.
  emit(`${here ? (here.branch ?? "HEAD") : (cfg.branch ?? "claude/test-branch")}\n`);
}

if (args[0] === "remote" && args[1] === "get-url") {
  if (fail.has("remote")) die(2, "error: No such remote 'origin'");
  emit(`${cfg.remote ?? "https://github.com/tsworkflow/jarvisbuild"}\n`);
}

die(1, `fake-git: unhandled invocation: ${args.join(" ")}`);

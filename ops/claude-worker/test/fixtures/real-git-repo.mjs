/**
 * A REAL git repository for the D-133 isolation tests.
 *
 * Every other worker integration test drives `git` through `fake-git.mjs`,
 * which is the right tool for asserting how the worker reacts to a git answer -
 * including answers real git will not produce on demand, like a failing
 * `status`. It is the wrong tool here.
 *
 * What D-133 has to prove is not "the worker handles this git output" but
 * "uncommitted work physically lands in the task's own worktree and nowhere
 * else, and the primary checkout stays clean". That is a claim about the
 * filesystem and about git's real linked-worktree semantics - tracked vs
 * untracked, what `git worktree remove` refuses to do, whether a commit in one
 * worktree is visible from another. A fixture cannot certify any of it, because
 * a fixture would simply agree with whatever the worker did.
 *
 * So these tests use the real binary against a throwaway repository, with only
 * `gh` and the Claude CLI faked. `origin` is set to the configured repository
 * so the worker's remote guard passes; nothing is ever fetched or pushed.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Run a real git command and fail loudly - a silently broken fixture is worse than none. */
export function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout || res.error?.message}`);
  }
  return String(res.stdout ?? "").trim();
}

/**
 * `git status --porcelain` lines for any checkout, as the worker itself reads
 * them - byte-identical, including the two-character status prefix.
 *
 * Deliberately NOT built on `git()`: that trims, which would eat the leading
 * space of ` M tracked.txt` and quietly turn a tracked modification into
 * something the assertions could not tell apart from an untracked add.
 */
export function statusLines(cwd) {
  const res = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd, encoding: "utf8", windowsHide: true
  });
  if (res.status !== 0) throw new Error(`git status failed in ${cwd}: ${res.stderr || res.error?.message}`);
  return String(res.stdout ?? "").split(/\r?\n/).filter((l) => l.trim().length > 0);
}

export function head(cwd) {
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Commits on HEAD, newest first. Used to prove a resume did not duplicate work. */
export function log(cwd) {
  return git(cwd, ["log", "--pretty=%H %s"]).split(/\r?\n/).filter(Boolean);
}

/**
 * Commit subjects AND full bodies on HEAD, newest first. `log()` gives subjects
 * only, which cannot show whether a commit carries its evidence trailers - and
 * that is precisely what D-134 has to assert about.
 */
export function logBodies(cwd) {
  const out = git(cwd, ["log", "--format=%H%x1f%B%x1e"]);
  return out.split("").map((b) => b.replace(/^[\r\n]+/, "")).filter((b) => b.trim() !== "")
    .map((b) => {
      const [sha, ...rest] = b.split("");
      return { sha: sha.trim(), message: rest.join("") };
    });
}

/**
 * An UNRELATED WRITER: some other process on the host commits into a checkout.
 *
 * This is the actor the worker cannot see and must never mistake for its own
 * child. It is a plain `git commit` by a different identity - nothing exotic -
 * because the point is that the ORDINARY case is already indistinguishable from
 * the child's work if you only look at HEAD before and after.
 */
export function foreignCommit(cwd, { file = "unrelated-writer.txt", message = "unrelated maintenance commit" } = {}) {
  writeFileSync(join(cwd, file), `written by an unrelated process at ${new Date().toISOString()}\n`, "utf8");
  git(cwd, ["add", "--", file]);
  git(cwd, ["-c", "user.email=someone-else@example.invalid", "-c", "user.name=unrelated writer",
    "commit", "-m", message]);
  return head(cwd);
}

/**
 * Create a repository with one baseline commit containing a TRACKED file, so a
 * test can produce a genuine tracked modification as well as untracked files.
 */
export function createRepo(path, { remote = "https://github.com/tsworkflow/jarvisbuild" } = {}) {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"]);
  git(path, ["config", "user.email", "fixture@example.invalid"]);
  git(path, ["config", "user.name", "jarvis test fixture"]);
  // Keep the fixture independent of the host's global git config.
  git(path, ["config", "commit.gpgsign", "false"]);
  git(path, ["config", "core.autocrlf", "false"]);

  writeFileSync(join(path, "tracked.txt"), "baseline\n", "utf8");
  writeFileSync(join(path, "README.md"), "# fixture repo\n", "utf8");
  git(path, ["add", "-A"]);
  git(path, ["commit", "-m", "baseline"]);
  git(path, ["remote", "add", "origin", remote]);

  return { path, baseline: head(path) };
}

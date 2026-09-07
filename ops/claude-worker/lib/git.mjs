/**
 * Fail-closed git access (D126 review blocker 7).
 *
 * The v2 worker did this:
 *
 *     const out = git(cfg, ["status", "--porcelain=v1", ...]).stdout ?? "";
 *     return out.split(...)
 *
 * `spawnSync` returns `{ error, status, stdout: null }` when the binary is
 * missing, when the cwd does not exist, when the repository is not a git
 * repository, or when git exits non-zero. Every one of those produced an EMPTY
 * list, which the dirty guard read as "the worktree is clean" and happily
 * dispatched a task into an unknown repository state.
 *
 * Every helper here reports `{ ok: false, error }` on ANY of: spawn failure,
 * non-zero exit, or missing stdout. Nothing here ever converts a failure into a
 * benign-looking empty result.
 */

import { spawnSync } from "node:child_process";
import { sanitize } from "./health.mjs";
import { resolveBinary } from "./github.mjs";

export function runGit(cfg, args, runner = spawnSync) {
  let res;
  try {
    const { command, prefix } = resolveBinary("JARVIS_WORKER_GIT", "git");
    res = runner(command, [...prefix, ...args], { cwd: cfg.repoPath, encoding: "utf8", windowsHide: true });
  } catch (err) {
    return { ok: false, error: `git_spawn_threw: ${sanitize(err.message)}`, args };
  }
  if (!res) {
    return { ok: false, error: "git_returned_nothing", args };
  }
  if (res.error) {
    return { ok: false, error: `git_spawn_failed: ${sanitize(res.error.message ?? String(res.error))}`, args };
  }
  if (res.status !== 0) {
    return {
      ok: false,
      error: `git_exit_${res.status}: ${sanitize(String(res.stderr ?? "").trim()).slice(0, 400)}`,
      code: res.status,
      args
    };
  }
  if (typeof res.stdout !== "string") {
    return { ok: false, error: "git_produced_no_stdout", args };
  }
  return { ok: true, stdout: res.stdout, stderr: String(res.stderr ?? ""), code: 0, args };
}

/**
 * `git status --porcelain=v1 --untracked-files=all` as a list of lines.
 * `{ ok: false }` means UNKNOWN - it never means clean.
 */
export function gitStatusLines(cfg, runner = spawnSync) {
  const res = runGit(cfg, ["status", "--porcelain=v1", "--untracked-files=all"], runner);
  if (!res.ok) return { ok: false, lines: null, error: res.error };
  return { ok: true, lines: res.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0) };
}

/** Resolved value of a single-line git query, e.g. `rev-parse HEAD`. */
function singleLine(cfg, args, runner) {
  const res = runGit(cfg, args, runner);
  if (!res.ok) return { ok: false, value: null, error: res.error };
  const value = res.stdout.trim();
  if (!value) return { ok: false, value: null, error: `git_empty_output (${args.join(" ")})` };
  return { ok: true, value };
}

export function gitHead(cfg, runner = spawnSync) {
  return singleLine(cfg, ["rev-parse", "HEAD"], runner);
}

export function gitCurrentBranch(cfg, runner = spawnSync) {
  return singleLine(cfg, ["rev-parse", "--abbrev-ref", "HEAD"], runner);
}

export function gitRemoteUrl(cfg, remote = "origin", runner = spawnSync) {
  return singleLine(cfg, ["remote", "get-url", remote], runner);
}

/**
 * Everything the preflight needs, in one place, with an explicit verdict.
 * `ok: false` carries every individual failure so the status comment can state
 * exactly which git query could not be answered.
 */
export function collectRepoFacts(cfg, runner = spawnSync) {
  const status = gitStatusLines(cfg, runner);
  const head = gitHead(cfg, runner);
  const branch = gitCurrentBranch(cfg, runner);
  const remote = gitRemoteUrl(cfg, "origin", runner);

  const failures = [];
  if (!status.ok) failures.push(`status: ${status.error}`);
  if (!head.ok) failures.push(`head: ${head.error}`);
  if (!branch.ok) failures.push(`branch: ${branch.error}`);
  if (!remote.ok) failures.push(`remote: ${remote.error}`);

  return {
    ok: failures.length === 0,
    failures,
    statusLines: status.ok ? status.lines : null,
    head: head.ok ? head.value : null,
    branch: branch.ok ? branch.value : null,
    remoteUrl: remote.ok ? remote.value : null
  };
}

/**
 * Does the configured remote actually point at the repository this worker is
 * allowed to act on? A worker that has been pointed at a different remote must
 * stop, not push somewhere unexpected.
 */
export function remoteMatchesRepo(remoteUrl, { repoOwner, repoName }) {
  if (typeof remoteUrl !== "string" || !remoteUrl) return false;
  const normalised = remoteUrl.trim().replace(/\.git$/, "").toLowerCase();
  const target = `${repoOwner}/${repoName}`.toLowerCase();
  return normalised.endsWith(`/${target}`) || normalised.endsWith(`:${target}`);
}

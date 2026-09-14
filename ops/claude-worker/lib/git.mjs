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

/** ---------------- linked worktrees (D-133) ---------------- */

/**
 * Run a git query with the working directory pointed somewhere else - normally
 * a task's isolated linked worktree rather than the primary checkout.
 *
 * Every helper above takes its cwd from `cfg.repoPath`, so a shallow override is
 * all that is needed and no signature changes. It is a function rather than an
 * inline spread so the intent is greppable and so a caller cannot accidentally
 * mutate the shared config object.
 */
export function atPath(cfg, path) {
  return { ...cfg, repoPath: path };
}

/**
 * `git worktree list --porcelain` as `[{ path, head, branch, detached, bare }]`.
 *
 * `{ ok: false }` means UNKNOWN. It never means "no linked worktrees exist" -
 * treating a failed query as absence is exactly how a worker would conclude a
 * task's isolated context had vanished and start over on top of live work.
 */
export function gitWorktreeList(cfg, runner = spawnSync) {
  const res = runGit(cfg, ["worktree", "list", "--porcelain"], runner);
  if (!res.ok) return { ok: false, items: null, error: res.error };

  const items = [];
  let current = null;
  for (const raw of res.stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "") {
      if (current) items.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      if (current) items.push(current);
      current = { path: value, head: null, branch: null, detached: false, bare: false };
    } else if (current) {
      if (key === "HEAD") current.head = value;
      else if (key === "branch") current.branch = value;
      else if (key === "detached") current.detached = true;
      else if (key === "bare") current.bare = true;
    }
  }
  if (current) items.push(current);
  return { ok: true, items };
}

/**
 * Create a linked worktree, DETACHED at an exact commit.
 *
 * Detached on purpose: the primary checkout may already have the interesting
 * branch checked out, and git refuses to check the same branch out twice. The
 * child creates its own branch inside its own worktree, which is also what keeps
 * two concurrent tasks from ever contending for one ref.
 */
export function gitWorktreeAdd(cfg, { path, commitish }, runner = spawnSync) {
  const res = runGit(cfg, ["worktree", "add", "--detach", path, commitish], runner);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

/**
 * Remove a linked worktree WITHOUT `--force`.
 *
 * The missing `--force` is the safety property, not an oversight: git itself
 * then refuses to remove a worktree that still has modifications, so an
 * uncommitted task-owned change cannot be destroyed by a cleanup pass even if
 * the caller's own guards were wrong.
 */
export function gitWorktreeRemove(cfg, path, runner = spawnSync) {
  const res = runGit(cfg, ["worktree", "remove", path], runner);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

/** ---------------- commit-range queries (D-134) ---------------- */

/**
 * Is `ancestor` reachable from `descendant`?
 *
 * `git merge-base --is-ancestor` answers by EXIT CODE: 0 yes, 1 no, anything
 * else is a real failure. `runGit` reports any non-zero exit as `ok: false`, so
 * the "no" answer has to be separated from the "could not be answered" answer
 * here - collapsing them would turn an ordinary negative into an unknown, and
 * turn a broken repository into a confident negative. Both directions matter:
 * `false` means the ref was REWOUND or REPLACED (a reset/force somewhere), which
 * is a strictly more serious observation than a plain fast-forward.
 */
export function gitIsAncestor(cfg, ancestor, descendant, runner = spawnSync) {
  const res = runGit(cfg, ["merge-base", "--is-ancestor", ancestor, descendant], runner);
  if (res.ok) return { ok: true, isAncestor: true };
  if (res.code === 1) return { ok: true, isAncestor: false };
  return { ok: false, isAncestor: null, error: res.error ?? "git_merge_base_failed" };
}

/** Field/record separators: control characters a commit message cannot contain. */
const FIELD_SEP = "";
const RECORD_SEP = "";

/**
 * The commits in `from..to`, oldest first, with their FULL message bodies.
 *
 * The full body - not the subject - is the point: the only positive evidence
 * that binds a commit to a task and attempt lives in its trailers (see
 * `lib/provenance.mjs`), and `%s` would throw that away. `{ ok: false }` means
 * UNKNOWN; it never means "the range is empty".
 *
 * D-135: `limit` bounds how much of the range is READ, so an unexpectedly huge
 * range cannot be pulled into memory whole. The bound is applied by asking git
 * for ONE MORE commit than the caller is willing to examine: if that extra
 * commit comes back, the range is larger than the bound and `truncated` is
 * `true`. The caller must then treat the range as UNEXAMINED, because a verdict
 * derived from a prefix says nothing about the commits behind it - that was
 * exactly the false-verification edge the PR #80 review found.
 */
export function gitLogRange(cfg, from, to, runner = spawnSync, { limit = null } = {}) {
  const format = `--format=%H${FIELD_SEP}%cI${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%B${RECORD_SEP}`;
  const bounded = Number.isFinite(limit) && limit > 0;
  const args = ["log", "--reverse", format];
  // One more than the bound: the (limit + 1)-th commit is the PROOF of overflow,
  // never something we pretend to have classified.
  if (bounded) args.push(`-n`, String(limit + 1));
  args.push(`${from}..${to}`);
  const res = runGit(cfg, args, runner);
  if (!res.ok) return { ok: false, commits: null, truncated: null, error: res.error };

  const commits = [];
  for (const block of res.stdout.split(RECORD_SEP)) {
    const record = block.replace(/^[\r\n]+/, "");
    if (record.trim() === "") continue;
    const [sha, committedAt, authorName, authorEmail, ...rest] = record.split(FIELD_SEP);
    commits.push({
      sha: String(sha ?? "").trim(),
      committed_at: String(committedAt ?? "").trim(),
      author_name: String(authorName ?? "").trim(),
      author_email: String(authorEmail ?? "").trim(),
      // Rejoining on the separator keeps a message that somehow contains one
      // intact rather than silently truncating the evidence we are about to read.
      message: rest.join(FIELD_SEP)
    });
  }
  if (bounded && commits.length > limit) {
    // Do NOT hand back the prefix as if it were the range. The caller is told
    // the range is bigger than it agreed to examine, and the commits it did get
    // are returned only so the refusal can name a few of them.
    return { ok: true, commits: commits.slice(0, limit), truncated: true };
  }
  return { ok: true, commits, truncated: false };
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

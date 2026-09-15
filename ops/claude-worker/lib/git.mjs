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

/**
 * The raw spawn, shared by the two public doors below.
 *
 * `exited` is the distinction everything here rests on: `true` means git ran and
 * chose an exit code, `false` means there was never a process to have an opinion
 * (binary missing, cwd gone, spawn threw). Only the first can ever be an answer.
 */
function spawnGit(cfg, args, runner) {
  let res;
  try {
    const { command, prefix } = resolveBinary("JARVIS_WORKER_GIT", "git");
    res = runner(command, [...prefix, ...args], { cwd: cfg.repoPath, encoding: "utf8", windowsHide: true });
  } catch (err) {
    return { exited: false, error: `git_spawn_threw: ${sanitize(err.message)}`, args };
  }
  if (!res) return { exited: false, error: "git_returned_nothing", args };
  if (res.error) {
    return { exited: false, error: `git_spawn_failed: ${sanitize(res.error.message ?? String(res.error))}`, args };
  }
  return {
    exited: true,
    code: res.status,
    stdout: typeof res.stdout === "string" ? res.stdout : null,
    stderr: String(res.stderr ?? ""),
    args
  };
}

export function runGit(cfg, args, runner = spawnSync) {
  const res = spawnGit(cfg, args, runner);
  if (!res.exited) return { ok: false, error: res.error, args };
  if (res.code !== 0) {
    return {
      ok: false,
      error: `git_exit_${res.code}: ${sanitize(String(res.stderr ?? "").trim()).slice(0, 400)}`,
      code: res.code,
      args
    };
  }
  if (typeof res.stdout !== "string") {
    return { ok: false, error: "git_produced_no_stdout", args };
  }
  return { ok: true, stdout: res.stdout, stderr: res.stderr, code: 0, args };
}

/**
 * D-158: the SAME fail-closed run, for the few plumbing commands whose EXIT CODE
 * is an ANSWER rather than a failure.
 *
 * `git merge-tree --write-tree` exits 1 for a merge that CONFLICTED, and prints
 * the conflict report on stdout; `git rev-parse --verify --quiet` exits 1 for an
 * object this store simply does not have. Both are findings a caller must be
 * able to name, and `runGit` deliberately throws stdout away on a non-zero exit
 * precisely so that no caller can mistake a failure's partial output for a
 * result.
 *
 * So this is a separate, explicitly-named door rather than a loosening of that
 * rule. `ok` still means exactly "exit 0". A caller that wants a non-zero exit's
 * stdout has to have SAID SO by choosing this function, and it still gets
 * `exited: false, code: null` when there was no process at all - which is
 * UNKNOWN and must never be read as an answer.
 *
 * Note that exit 1 is not self-describing: `merge-tree` exits 1 both for a real
 * conflict and for an object it could not even load. Distinguishing those is the
 * CALLER's job, from the output, and `merge-tree.mjs` does it rather than
 * assuming a code means what it would like it to mean.
 */
export function runGitAllowingExitCode(cfg, args, runner = spawnSync) {
  const res = spawnGit(cfg, args, runner);
  if (!res.exited) {
    return { ok: false, exited: false, code: null, stdout: null, stderr: null, error: res.error, args };
  }
  const error = res.code === 0
    ? null
    : `git_exit_${res.code}: ${sanitize(String(res.stderr ?? "").trim()).slice(0, 400)}`;
  return {
    ok: res.code === 0 && typeof res.stdout === "string",
    exited: true,
    code: res.code,
    stdout: res.stdout,
    stderr: res.stderr,
    error,
    args
  };
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

/** ---------------- exact-object queries for the merge proof (D-158) ---------------- */

/**
 * The ABSOLUTE path of a repository's object database.
 *
 * Read from git rather than assembled from `repoPath`, because `.git` is a
 * directory in a normal clone, a FILE in a linked worktree, and neither in a
 * bare repository - and the merge proof's isolated object store has to point an
 * `objects/info/alternates` line at the real one in all three shapes.
 */
export function gitObjectsDir(cfg, runner = spawnSync) {
  return singleLine(cfg, ["rev-parse", "--path-format=absolute", "--git-path", "objects"], runner);
}

/**
 * Does THIS object store hold `rev` as a COMMIT, and what does it resolve to?
 *
 * `--verify --quiet` is the whole point: it makes "this store does not have that
 * object" a plain exit 1 with no output, instead of the exit 128 a bare
 * `rev-parse` produces - which is indistinguishable from "this is not a
 * repository". Presence and absence are both ANSWERS here (`ok: true`); anything
 * else is UNKNOWN (`ok: false`) and must never be read as absence.
 */
export function gitResolveCommit(cfg, rev, runner = spawnSync) {
  const res = runGitAllowingExitCode(cfg, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], runner);
  if (res.ok) {
    const sha = String(res.stdout ?? "").trim();
    return sha ? { ok: true, present: true, sha } : { ok: false, present: null, sha: null, error: "git_rev_parse_empty_output" };
  }
  if (res.exited && res.code === 1) return { ok: true, present: false, sha: null };
  return { ok: false, present: null, sha: null, error: res.error ?? "git_rev_parse_failed" };
}

/** The tree a commit points at, read from the real object. */
export function gitCommitTree(cfg, sha, runner = spawnSync) {
  return singleLine(cfg, ["rev-parse", "--verify", `${sha}^{tree}`], runner);
}

/**
 * A commit's parents, IN ORDER, read from the real object.
 *
 * This is the independent cross-check on what the API said the parents were: the
 * API serves a projection, this is the object itself. `{ ok: false }` is UNKNOWN
 * and never "no parents" - a root commit legitimately has none, and conflating
 * the two would let an unreadable object look like one.
 */
export function gitCommitParents(cfg, sha, runner = spawnSync) {
  const res = runGit(cfg, ["rev-list", "--parents", "-n", "1", sha], runner);
  if (!res.ok) return { ok: false, parents: null, error: res.error };
  const fields = res.stdout.trim().split(/\s+/).filter(Boolean);
  if (fields.length === 0) return { ok: false, parents: null, error: "git_rev_list_empty_output" };
  return { ok: true, parents: fields.slice(1) };
}

/**
 * Fetch EXACT objects by sha from a URL, writing NO ref and NO tag.
 *
 * Every safety property here is in the flags. There is no refspec, so nothing
 * local is created or moved; `--no-write-fetch-head` keeps even FETCH_HEAD
 * unwritten; `--no-tags` and `--no-recurse-submodules` keep the transfer to the
 * objects actually named. The result is additive to an object store and visible
 * nowhere else - which is what lets the merge proof run without touching a
 * single thing a human is working on.
 */
export function gitFetchObjects(cfg, url, shas, runner = spawnSync) {
  const res = runGit(cfg, [
    "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--quiet", url, ...shas
  ], runner);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

/**
 * `git merge-tree --write-tree`: the three-way merge of two exact commits, as a
 * TREE OBJECT, computed without an index, a working tree or a checkout.
 *
 * Returns `{ ok, tree, conflicted, detail, error }`.
 *
 *   ok: true,  conflicted: false  the merge is clean and `tree` is its result
 *   ok: true,  conflicted: true   git merged and found CONFLICTS; `detail` is
 *                                 its report. `tree` is git's conflicted tree
 *                                 and is deliberately NOT returned as a result
 *   ok: false                     UNKNOWN - git could not perform the merge
 *
 * The exit code alone cannot tell the first two apart from the third: git exits
 * 1 BOTH for a conflicted merge and for an object it could not load at all (the
 * probe for this change confirmed it - `merge-tree --write-tree <base> <missing>`
 * exits 1 with an empty stdout). So "conflicted" is concluded only from the
 * evidence that git actually merged, namely a tree object id on the first line.
 * Exit 1 with no tree is an UNKNOWN, never a conflict and never a pass.
 *
 * EVERY SETTING THAT CAN MOVE THE RESULT IS PINNED ON THE COMMAND LINE, because
 * a content-addressed proof that depends on WHICH MACHINE RAN IT is not a proof.
 * `-c` beats repository, global and system config, so none of these can be
 * changed by the host the worker happens to be deployed on:
 *
 *   core.autocrlf=false, core.eol=lf   the merged blobs are byte-for-byte what
 *                                      the objects say, not what a Windows
 *                                      checkout would have rewritten them into
 *   merge.renames, diff.renames,       rename detection CHANGES THE MERGED TREE:
 *   merge.renameLimit                  a rename the merge sees is a rename its
 *                                      content follows, and one it does not see
 *                                      becomes a delete plus an add. A host with
 *                                      `merge.renames=false` in its global config
 *                                      would compute a different - and equally
 *                                      "correct" - tree for the same two commits.
 *
 * The pinned values are git's own defaults, chosen deliberately: the expected
 * tree has to be the one an ordinary merge of those two commits produces, which
 * is also what the forge computed. Pinning is here to stop a host's local config
 * from moving the answer, NOT to pick a different answer from the default one.
 *
 * A host whose config did move the result would produce a MISMATCH, so this
 * hardening only ever removes FALSE NEGATIVES - the exact failure class D-158
 * exists to close. It cannot turn a refusal into a pass.
 */
export function gitMergeTree(cfg, base, head, runner = spawnSync) {
  const res = runGitAllowingExitCode(cfg, [
    "-c", "core.autocrlf=false",
    "-c", "core.eol=lf",
    "-c", "merge.renames=true",
    "-c", "diff.renames=true",
    "-c", "merge.renameLimit=7000",
    "merge-tree", "--write-tree", base, head
  ], runner);
  if (!res.exited) return { ok: false, tree: null, conflicted: null, detail: null, error: res.error };

  const stdout = String(res.stdout ?? "");
  const [firstLine, ...rest] = stdout.split(/\r?\n/);
  const tree = /^[0-9a-f]{40}$/i.test(String(firstLine ?? "").trim()) ? firstLine.trim().toLowerCase() : null;

  if (res.code === 0) {
    return tree
      ? { ok: true, tree, conflicted: false, detail: null, error: null }
      : { ok: false, tree: null, conflicted: null, detail: null, error: "git_merge_tree_produced_no_tree_object_id" };
  }
  if (res.code === 1 && tree) {
    // git DID merge, and said the result conflicts. A conflicted tree is a real
    // object, and returning it would invite a caller to compare against it - so
    // it is reported as a finding with its report, and not as a tree.
    return {
      ok: true,
      tree: null,
      conflicted: true,
      detail: sanitize(rest.join("\n").trim()).slice(0, 600),
      error: null
    };
  }
  return { ok: false, tree: null, conflicted: null, detail: null, error: res.error ?? `git_merge_tree_exit_${res.code}` };
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

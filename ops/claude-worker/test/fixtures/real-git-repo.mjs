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

/** The tree a commit points at. The D-145 tree-equality evidence is about this. */
export function treeOf(cwd, sha) {
  return git(cwd, ["rev-parse", `${sha}^{tree}`]);
}

/** A commit's parents, in order. The evidence that a merge was a NORMAL merge. */
export function parentsOf(cwd, sha) {
  return git(cwd, ["rev-list", "--parents", "-n", "1", sha]).split(/\s+/).slice(1);
}

/**
 * D-145: a REAL two-parent merge commit, exactly the shape GitHub produces for a
 * normal (`--no-ff`) merge of an up-to-date branch.
 *
 * Built with `commit-tree` rather than `git merge` so the test controls the
 * parent ORDER and the committer identity precisely, and so the resulting commit
 * is - like GitHub's - written by nobody the worker ever dispatched. Its tree is
 * the HEAD branch's tree, which is what makes "the merge introduced no
 * unreviewed content" a checkable statement rather than an assumption.
 *
 * `squash: true` instead produces the SINGLE-parent commit a squash merge makes,
 * which the verifier must refuse. `extraContent` adds a file to the merge tree,
 * producing the tree mismatch it must also refuse.
 */
export function syntheticMerge(cwd, {
  base, head, tree = null, message = "Merge pull request #80", squash = false
} = {}) {
  const args = ["-c", "user.email=noreply@github.com", "-c", "user.name=GitHub",
    "commit-tree", tree ?? treeOf(cwd, head), "-p", base];
  if (!squash) args.push("-p", head);
  args.push("-m", message);
  return git(cwd, args);
}

/**
 * A tree that is `head`'s tree PLUS one extra file, built as a real object
 * without moving any ref. Feeding it to `syntheticMerge({ tree })` produces the
 * adversarial "unreviewed content slipped in with the merge" case: a perfectly
 * well-formed two-parent merge whose tree is NOT the approved head tree.
 */
export function treeWithExtraFile(cwd, head, { file = "slipped-in.txt", content = "never reviewed\n" } = {}) {
  const res = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd, input: content, encoding: "utf8", windowsHide: true
  });
  if (res.status !== 0) throw new Error(`git hash-object failed: ${res.stderr}`);
  const blob = String(res.stdout).trim();

  const listing = git(cwd, ["ls-tree", head]);
  const mk = spawnSync("git", ["mktree"], {
    cwd,
    input: `${listing}\n100644 blob ${blob}\t${file}\n`,
    encoding: "utf8",
    windowsHide: true
  });
  if (mk.status !== 0) throw new Error(`git mktree failed: ${mk.stderr}`);
  return String(mk.stdout).trim();
}

/**
 * D-157: the tree a REAL three-way merge of `base` and `head` produces.
 *
 * `syntheticMerge` defaults the merge tree to the HEAD's tree, which is only
 * correct when the head already contains its base. For a DIVERGED branch - the
 * topology D-156 was wrongly refused for - the correct merge tree carries both
 * sides, and inventing it would be inventing the very thing under test. So git
 * computes it, with `merge-tree --write-tree` (git >= 2.38, present on every
 * supported runner and on the dev host).
 *
 * `extra` optionally adds a file to the resulting tree, which is the adversarial
 * "conflict resolution introduced content nobody reviewed" case: a well-formed
 * two-parent merge whose effective delta is NOT the reviewed one.
 */
export function realMergeTree(cwd, base, head, { extra = null } = {}) {
  const tree = git(cwd, ["merge-tree", "--write-tree", base, head]).split(/\r?\n/)[0].trim();
  if (!extra) return tree;

  const res = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd, input: extra.content ?? "never reviewed\n", encoding: "utf8", windowsHide: true
  });
  if (res.status !== 0) throw new Error(`git hash-object failed: ${res.stderr}`);
  const blob = String(res.stdout).trim();
  const listing = git(cwd, ["ls-tree", tree]);
  const mk = spawnSync("git", ["mktree"], {
    cwd,
    input: `${listing}\n100644 blob ${blob}\t${extra.file ?? "slipped-in.txt"}\n`,
    encoding: "utf8",
    windowsHide: true
  });
  if (mk.status !== 0) throw new Error(`git mktree failed: ${mk.stderr}`);
  return String(mk.stdout).trim();
}

/** git's raw status letters, mapped to the words the GitHub compare API uses. */
const RAW_STATUS = { A: "added", M: "modified", D: "removed", R: "renamed", C: "copied", T: "changed" };

/**
 * D-157: the `repos/O/R/compare/<base>...<head>` projection, DERIVED FROM REAL
 * GIT rather than invented.
 *
 * This is what makes the D-157 integration tests real. The verifier's whole
 * claim is "the effective change from parent 1 to the merge IS the reviewed
 * delta", and a hand-written fixture would simply assert whatever the test
 * author believed - including, in the failing direction, agreeing with a bug.
 * Here both ranges are computed by the same derivation from real objects, so a
 * genuine difference (an extra file in the merge tree, a rewritten hunk, a
 * dropped commit) shows up because git says so.
 *
 * Mirrors the real endpoint's semantics: a THREE-DOT comparison, anchored at the
 * merge base, with `commits` oldest-first so the last entry is the commit
 * compared to.
 */
export function compareProjection(cwd, base, head) {
  const mergeBase = git(cwd, ["merge-base", base, head]);
  const aheadBy = Number(git(cwd, ["rev-list", "--count", `${mergeBase}..${head}`]));
  const behindBy = Number(git(cwd, ["rev-list", "--count", `${mergeBase}..${base}`]));
  const status = aheadBy === 0 && behindBy === 0 ? "identical"
    : aheadBy > 0 && behindBy === 0 ? "ahead"
      : aheadBy === 0 ? "behind" : "diverged";
  const commits = aheadBy === 0
    ? []
    : git(cwd, ["rev-list", "--reverse", `${mergeBase}..${head}`]).split(/\r?\n/).filter(Boolean);

  // Line counts per path, keyed by the path the change lands on.
  const numstat = new Map();
  const numstatOut = git(cwd, ["diff", "--numstat", "-M", mergeBase, head]);
  for (const line of numstatOut.split(/\r?\n/).filter(Boolean)) {
    const [add, del, ...rest] = line.split("\t");
    const path = rest[rest.length - 1];
    numstat.set(path, { additions: Number(add) || 0, deletions: Number(del) || 0 });
  }

  const files = [];
  const rawOut = git(cwd, ["diff", "--raw", "-M", "-z", mergeBase, head]);
  // `-z` output is NUL-separated: "<meta>\0<path>\0" and, for R/C, an extra path.
  const parts = rawOut.split("\0").filter((p) => p !== "");
  for (let i = 0; i < parts.length;) {
    const meta = parts[i++];
    if (!meta.startsWith(":")) continue;
    const fields = meta.slice(1).split(/\s+/);
    const srcBlob = fields[2];
    const dstBlob = fields[3];
    const code = fields[4];
    const letter = code[0];
    const from = parts[i++];
    const to = letter === "R" || letter === "C" ? parts[i++] : null;
    const filename = to ?? from;
    const counts = numstat.get(filename) ?? { additions: 0, deletions: 0 };
    const patchRaw = git(cwd, ["diff", "-M", mergeBase, head, "--", ...(to ? [from, to] : [from])]);
    // GitHub's `patch` begins at the first hunk header, with no file header.
    const at = patchRaw.indexOf("@@");
    files.push({
      filename,
      status: RAW_STATUS[letter] ?? "modified",
      previousFilename: to ? from : null,
      // The RESULTING blob, which is what GitHub reports; a deletion has none,
      // so the pre-image is used, exactly as the real API does.
      blobSha: /^0+$/.test(dstBlob) ? srcBlob : dstBlob,
      additions: counts.additions,
      deletions: counts.deletions,
      patch: at >= 0 ? patchRaw.slice(at) : null
    });
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));

  return {
    baseSha: git(cwd, ["rev-parse", base]),
    mergeBaseSha: mergeBase,
    headSha: git(cwd, ["rev-parse", head]),
    status,
    aheadBy,
    behindBy,
    totalCommits: commits.length,
    commitCount: commits.length,
    fileCount: files.length,
    commits,
    files
  };
}

/**
 * D-157: the whole `compare.json` store a merge fixture needs, in one call.
 *
 * The verifier makes exactly two comparisons - `parent1...merge` and
 * `base...head` - so every integration fixture that publishes a merged PR needs
 * both, derived from the same real repository the rest of the fixture uses.
 * Shared rather than copied into each suite: a fixture that silently lacked a
 * range would make its gate refuse for a reason the test was not about.
 *
 * A range that cannot be computed is simply omitted, which the fake `gh` serves
 * as a 404 - exactly what the real API does for an unknown sha, and exactly the
 * UNKNOWN the verifier must refuse on rather than treat as a match.
 */
export function compareStore(cwd, { mergeSha = null, base = null, head = null } = {}) {
  const store = {};
  const add = (a, b) => {
    try {
      store[`${a}...${b}`] = compareProjection(cwd, a, b);
    } catch { /* an uncomputable range 404s, exactly like the real API */ }
  };
  if (mergeSha) {
    const parent1 = parentsOf(cwd, mergeSha)[0] ?? null;
    if (parent1) add(parent1, mergeSha);
  }
  if (base && head) add(base, head);
  return store;
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

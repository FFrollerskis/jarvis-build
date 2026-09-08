import { describe, it, expect } from "vitest";

import { runGit, gitStatusLines, gitHead, gitCurrentBranch, collectRepoFacts, remoteMatchesRepo } from "../lib/git.mjs";

const cfg = { repoPath: "/repo", repoOwner: "tsworkflow", repoName: "jarvisbuild" };

function runner(result) {
  return () => result;
}

/**
 * D126 review blocker 7:
 * "gitStatusLines ignores git exit/error and treats missing stdout as clean.
 *  Check exit status/errors for preflight/HEAD/remote and fail explicitly."
 *
 * Each case below produced `[]` on the reviewed implementation, which the dirty
 * guard then read as "the worktree is clean" and dispatched into an UNKNOWN
 * repository state.
 */
describe("blocker 7: an unanswerable git query is never a clean worktree", () => {
  it("a spawn error is a failure, not an empty status", () => {
    const res = gitStatusLines(cfg, runner({ error: new Error("spawn git ENOENT"), status: null, stdout: null }));
    expect(res.ok).toBe(false);
    expect(res.lines).toBeNull();
    expect(res.error).toMatch(/git_spawn_failed/);
  });

  it("a non-zero exit is a failure, not an empty status", () => {
    const res = gitStatusLines(cfg, runner({ status: 128, stdout: "", stderr: "fatal: not a git repository" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/git_exit_128/);
    expect(res.error).toMatch(/not a git repository/);
  });

  it("a missing stdout is a failure, not an empty status", () => {
    const res = gitStatusLines(cfg, runner({ status: 0, stdout: null }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no_stdout/);
  });

  it("a thrown runner is a failure", () => {
    const res = gitStatusLines(cfg, () => { throw new Error("EPERM"); });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/git_spawn_threw/);
  });

  it("a genuinely clean worktree is reported as clean", () => {
    const res = gitStatusLines(cfg, runner({ status: 0, stdout: "" }));
    expect(res.ok).toBe(true);
    expect(res.lines).toEqual([]);
  });

  it("dirty entries are parsed and blank lines dropped", () => {
    const res = gitStatusLines(cfg, runner({ status: 0, stdout: "?? a.md\n M b.ts\n\n" }));
    expect(res.lines).toEqual(["?? a.md", " M b.ts"]);
  });
});

describe("blocker 7: HEAD, branch and remote must be ANSWERED", () => {
  it("an empty rev-parse output is a failure", () => {
    expect(gitHead(cfg, runner({ status: 0, stdout: "  \n" })).ok).toBe(false);
    expect(gitCurrentBranch(cfg, runner({ status: 0, stdout: "" })).ok).toBe(false);
  });

  it("collectRepoFacts reports every individual failure", () => {
    const facts = collectRepoFacts(cfg, runner({ status: 129, stdout: "", stderr: "boom" }));
    expect(facts.ok).toBe(false);
    expect(facts.failures).toHaveLength(4);
    expect(facts.statusLines).toBeNull();
    expect(facts.head).toBeNull();
  });

  it("collectRepoFacts succeeds when git answers everything", () => {
    const responses = {
      status: { status: 0, stdout: "" },
      "rev-parse HEAD": { status: 0, stdout: "abc123\n" },
      "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "claude/x\n" },
      "remote get-url origin": { status: 0, stdout: "https://github.com/tsworkflow/jarvisbuild\n" }
    };
    const facts = collectRepoFacts(cfg, (_bin, args) => {
      const key = args.join(" ");
      if (key.startsWith("status")) return responses.status;
      return responses[key] ?? { status: 1, stdout: "", stderr: `unexpected ${key}` };
    });
    expect(facts.ok).toBe(true);
    expect(facts.head).toBe("abc123");
    expect(facts.branch).toBe("claude/x");
    expect(facts.remoteUrl).toBe("https://github.com/tsworkflow/jarvisbuild");
  });
});

describe("the configured remote must be the one we are allowed to act on", () => {
  it("accepts the exact HTTPS and SSH forms", () => {
    expect(remoteMatchesRepo("https://github.com/tsworkflow/jarvisbuild", cfg)).toBe(true);
    expect(remoteMatchesRepo("https://github.com/tsworkflow/jarvisbuild.git", cfg)).toBe(true);
    expect(remoteMatchesRepo("git@github.com:tsworkflow/jarvisbuild.git", cfg)).toBe(true);
  });

  it("rejects a different repository or owner", () => {
    expect(remoteMatchesRepo("https://github.com/someone-else/jarvisbuild", cfg)).toBe(false);
    expect(remoteMatchesRepo("https://github.com/tsworkflow/other-repo", cfg)).toBe(false);
    expect(remoteMatchesRepo("", cfg)).toBe(false);
    expect(remoteMatchesRepo(null, cfg)).toBe(false);
  });

  it("rejects a lookalike suffix", () => {
    expect(remoteMatchesRepo("https://github.com/evil/tsworkflow-jarvisbuild", cfg)).toBe(false);
  });
});

describe("runGit surfaces the arguments it failed on", () => {
  it("includes argv in the failure", () => {
    const res = runGit(cfg, ["status"], runner({ status: 1, stdout: "", stderr: "x" }));
    expect(res.args).toEqual(["status"]);
  });
});

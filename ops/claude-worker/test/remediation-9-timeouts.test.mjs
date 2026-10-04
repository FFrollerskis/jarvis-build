import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { timeoutMsFromEnv, verifyAuth, listRemoteBranches } from "../lib/github.mjs";
import { gitHead, gitStatusLines } from "../lib/git.mjs";

/**
 * D-397 (JARVIS-088): `gh` and `git` calls are time-bounded. A binary that never returns used to hang the worker forever;
 * now the call is killed and reported as UNKNOWN (`ok: false`), which is never read as "clean" or "empty".
 */
const dir = mkdtempSync(join(tmpdir(), "jarvis-worker-timeout-"));
const sleeper = join(dir, "sleep.mjs");
writeFileSync(sleeper, "setTimeout(() => process.stdout.write('late'), 60_000);\n");
const quick = join(dir, "quick.mjs");
writeFileSync(quick, "process.stdout.write('{\"ok\":true}');\n");

const saved = { gh: process.env.JARVIS_WORKER_GH, git: process.env.JARVIS_WORKER_GIT, ght: process.env.JARVIS_WORKER_GH_TIMEOUT_MS, gitt: process.env.JARVIS_WORKER_GIT_TIMEOUT_MS };
afterEach(() => {
  for (const [k, v] of [["JARVIS_WORKER_GH", saved.gh], ["JARVIS_WORKER_GIT", saved.git], ["JARVIS_WORKER_GH_TIMEOUT_MS", saved.ght], ["JARVIS_WORKER_GIT_TIMEOUT_MS", saved.gitt]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("timeoutMsFromEnv", () => {
  it("uses the fallback for missing/invalid values and clamps to 1 s .. 30 min", () => {
    expect(timeoutMsFromEnv("X", 5000, {})).toBe(5000);
    expect(timeoutMsFromEnv("X", 5000, { X: "abc" })).toBe(5000);
    expect(timeoutMsFromEnv("X", 5000, { X: "-3" })).toBe(5000);
    expect(timeoutMsFromEnv("X", 5000, { X: "10" })).toBe(1000);
    expect(timeoutMsFromEnv("X", 5000, { X: "999999999" })).toBe(30 * 60_000);
    expect(timeoutMsFromEnv("X", 5000, { X: "2500" })).toBe(2500);
  });
});

describe("gh is time-bounded", () => {
  it("a hanging gh is killed and reported as UNKNOWN (ok:false), well before the binary would have returned", async () => {
    process.env.JARVIS_WORKER_GH = sleeper;
    process.env.JARVIS_WORKER_GH_TIMEOUT_MS = "1000";
    const started = Date.now();
    const auth = verifyAuth();
    const branches = listRemoteBranches({ repoOwner: "o", repoName: "r" });
    expect(auth.ok).toBe(false);
    expect(branches.ok).toBe(false);
    expect(branches.items).toEqual([]);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("a gh that answers in time is unaffected", () => {
    process.env.JARVIS_WORKER_GH = quick;
    process.env.JARVIS_WORKER_GH_TIMEOUT_MS = "5000";
    expect(verifyAuth()).toEqual({ ok: true });
  });
});

describe("git is time-bounded", () => {
  it("a hanging git is killed; status/head are UNKNOWN, never a clean worktree", () => {
    process.env.JARVIS_WORKER_GIT = sleeper;
    process.env.JARVIS_WORKER_GIT_TIMEOUT_MS = "1000";
    const cfg = { repoPath: dir, repoOwner: "o", repoName: "r" };
    const status = gitStatusLines(cfg);
    expect(status.ok).toBe(false);
    expect(status.lines).toBeNull();
    expect(status.error).toMatch(/git_spawn_failed|ETIMEDOUT/);
    expect(gitHead(cfg).ok).toBe(false);
  }, 20_000);
});

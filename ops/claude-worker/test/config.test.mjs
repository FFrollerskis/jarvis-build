import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

import {
  loadWorkerConfig,
  loadSupervisorConfig,
  validateClaudeArgs,
  assertOutsideRepo,
  isInside,
  PERMISSION_BYPASS_ARGS
} from "../lib/config.mjs";

let dir;
let root;
let repoPath;
let configPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-cfg-"));
  root = join(dir, "worker");
  repoPath = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  mkdirSync(repoPath, { recursive: true });
  configPath = join(root, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function baseConfig(overrides = {}) {
  return {
    repoOwner: "tsworkflow",
    repoName: "jarvisbuild",
    controlIssue: 68,
    trustedAuthor: "tsworkflow",
    repoPath,
    claudeArgs: ["-p"],
    ...overrides
  };
}

function write(cfg) {
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
  return configPath;
}

/**
 * D126 review blocker 7:
 * "loadWorkerConfig defaults missing claudeArgs to --dangerously-skip-permissions,
 *  conflicting with preserving hardened host permissions: preserve explicit
 *  installed configuration, no permissive fallback; require safe explicit args."
 */
describe("blocker 7: there is no permissive claudeArgs fallback", () => {
  it("refuses to load a config with NO claudeArgs at all", () => {
    const cfg = baseConfig();
    delete cfg.claudeArgs;
    expect(() => loadWorkerConfig(write(cfg), root)).toThrow(/missing required field: claudeArgs/);
  });

  it("refuses an empty claudeArgs array", () => {
    expect(() => validateClaudeArgs([])).toThrow(/non-empty array/);
  });

  it("never injects a permission-bypass flag by itself", () => {
    const loaded = loadWorkerConfig(write(baseConfig({ claudeArgs: ["-p"] })), root);
    expect(loaded.claudeArgs).toEqual(["-p"]);
    for (const flag of PERMISSION_BYPASS_ARGS) {
      expect(loaded.claudeArgs).not.toContain(flag);
    }
  });

  it("refuses an UNACKNOWLEDGED permission-bypass flag", () => {
    expect(() => loadWorkerConfig(write(baseConfig({ claudeArgs: ["-p", "--dangerously-skip-permissions"] })), root))
      .toThrow(/permission-bypass flag/);
  });

  it("preserves an EXPLICITLY acknowledged installed configuration", () => {
    const loaded = loadWorkerConfig(
      write(baseConfig({ claudeArgs: ["-p", "--dangerously-skip-permissions"], acknowledgeDangerousClaudeArgs: true })),
      root
    );
    expect(loaded.claudeArgs).toEqual(["-p", "--dangerously-skip-permissions"]);
    expect(loaded.claudeArgsAcknowledgedBypass).toEqual(["--dangerously-skip-permissions"]);
  });

  it("rejects non-string and control-character arguments", () => {
    expect(() => validateClaudeArgs(["-p", 5])).toThrow(/non-empty strings/);
    expect(() => validateClaudeArgs(["-p", "a\u0000b"])).toThrow(/control characters/);
  });
});

describe("blocker 7: every numeric bound is finite and checked", () => {
  it("rejects a non-numeric timeout instead of turning it into NaN", () => {
    expect(() => loadWorkerConfig(write(baseConfig({ claudeTimeoutMinutes: "fifty" })), root))
      .toThrow(/must be a finite number/);
  });

  it("rejects out-of-range values", () => {
    expect(() => loadWorkerConfig(write(baseConfig({ maxAttempts: 0 })), root)).toThrow(/between 1 and 50/);
    expect(() => loadWorkerConfig(write(baseConfig({ claudeTimeoutMinutes: 100000 })), root)).toThrow(/between 1 and 110/);
    expect(() => loadWorkerConfig(write(baseConfig({ heartbeatSeconds: 0 })), root)).toThrow(/between 5 and 3600/);
  });

  it("D-398 (JARVIS-099): claudeTimeoutMinutes can never exceed the scheduled task's 2 h execution limit", () => {
    expect(() => loadWorkerConfig(write(baseConfig({ claudeTimeoutMinutes: 111 })), root)).toThrow(/between 1 and 110/);
    expect(() => loadWorkerConfig(write(baseConfig({ claudeTimeoutMinutes: 110 })), root)).not.toThrow();
  });

  it("D-398 (JARVIS-099): the 110 min cap stays below install-task.ps1's -ExecutionTimeLimit (structural)", () => {
    const ps = readFileSync(new URL("../install-task.ps1", import.meta.url), "utf8");
    const hours = Number(/ExecutionTimeLimit \(New-TimeSpan -Hours (\d+)\)/.exec(ps)?.[1]);
    expect(hours).toBeGreaterThan(0);
    expect(110).toBeLessThan(hours * 60);
  });

  it("rejects a heartbeat interval that would make a healthy owner look stale", () => {
    expect(() => loadWorkerConfig(write(baseConfig({ heartbeatSeconds: 3000, heartbeatTimeoutMinutes: 1 })), root))
      .toThrow(/well below/);
  });

  it("rejects a malformed control issue number", () => {
    expect(() => loadWorkerConfig(write(baseConfig({ controlIssue: "sixty-eight" })), root)).toThrow(/integer between/);
  });

  it("rejects an implausible owner or repo name", () => {
    expect(() => loadWorkerConfig(write(baseConfig({ repoOwner: "bad owner/../x" })), root)).toThrow(/repoOwner/);
    expect(() => loadWorkerConfig(write(baseConfig({ repoName: "a/b" })), root)).toThrow(/repoName/);
  });

  it("rejects a relative repoPath", () => {
    expect(() => loadWorkerConfig(write(baseConfig({ repoPath: "./repo" })), root)).toThrow(/absolute path/);
  });

  it("rejects a promptDelivery it does not implement", () => {
    expect(() => loadWorkerConfig(write(baseConfig({ promptDelivery: "carrier-pigeon" })), root)).toThrow(/promptDelivery/);
  });

  /**
   * D126 addendum item 4: `argv` is no longer an accepted mode. It handed the
   * whole task to the child on its command line at process-creation time, so
   * there was no point at which the durable-handoff gate could withhold it.
   */
  it("rejects argv delivery: it has no pre-execution handshake", () => {
    expect(() => loadWorkerConfig(write(baseConfig({ promptDelivery: "argv" })), root))
      .toThrow(/promptDelivery must be "stdin"/);
    expect(() => loadWorkerConfig(write(baseConfig({ promptDelivery: "argv" })), root))
      .toThrow(/before the handoff gate has run/);
  });

  it("stdin is accepted and is also the default", () => {
    expect(loadWorkerConfig(write(baseConfig({ promptDelivery: "stdin" })), root).promptDelivery).toBe("stdin");
    const withoutField = baseConfig();
    delete withoutField.promptDelivery;
    expect(loadWorkerConfig(write(withoutField), root).promptDelivery).toBe("stdin");
  });
});

describe("blocker 7: nothing the worker writes may land inside the repository", () => {
  it("isInside is correct for the obvious cases", () => {
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/c")).toBe(false);
    expect(isInside("/a/b", "/a/b/../c")).toBe(false);
  });

  it("refuses a scratch root inside the repo", () => {
    expect(() => loadWorkerConfig(write(baseConfig({ scratchRoot: join(repoPath, "tmp") })), root))
      .toThrow(/INSIDE the repository/);
  });

  it("refuses a state file inside the repo", () => {
    expect(() => loadWorkerConfig(write(baseConfig({ stateFile: join(repoPath, "state.json") })), root))
      .toThrow(/INSIDE the repository/);
  });

  it("refuses a log directory inside the repo", () => {
    expect(() => loadWorkerConfig(write(baseConfig({ logDir: join(repoPath, "logs") })), root))
      .toThrow(/INSIDE the repository/);
  });

  it("assertOutsideRepo names every offending entry", () => {
    expect(() => assertOutsideRepo("/repo", { a: "/repo/x", b: "/elsewhere", c: "/repo/y" }))
      .toThrow(/a=\/repo\/x.*c=\/repo\/y/);
  });

  it("accepts a fully external layout", () => {
    const loaded = loadWorkerConfig(write(baseConfig()), root);
    expect(loaded.scratchRoot.startsWith(root)).toBe(true);
    expect(loaded.postedStatusFile).toMatch(/posted-status\.jsonl$/);
  });
});

describe("blocker 7: the supervisor is bound to the ACTUAL host", () => {
  function supervisorConfig(overrides = {}) {
    const path = join(root, "supervisor.config.json");
    writeFileSync(path, JSON.stringify({
      repoOwner: "tsworkflow",
      repoName: "jarvisbuild",
      controlIssue: 68,
      trustedAuthor: "tsworkflow",
      workerTaskName: "JarvisClaudeWorker",
      host: hostname(),
      ...overrides
    }, null, 2), "utf8");
    return path;
  }

  it("loads when the configured host is this machine", () => {
    const cfg = loadSupervisorConfig(supervisorConfig(), root);
    expect(cfg.host).toBe(hostname());
  });

  it("refuses to run when the configured host is a DIFFERENT machine", () => {
    expect(() => loadSupervisorConfig(supervisorConfig({ host: "SOME-OTHER-PC" }), root))
      .toThrow(/this machine is/);
  });

  it("refuses a placeholder host", () => {
    expect(() => loadSupervisorConfig(supervisorConfig({ host: "SET-THIS-TO-THE-EXACT-HOSTNAME" }), root))
      .toThrow(/this machine is/);
  });

  it("rejects an unsafe scheduled task name", () => {
    expect(() => loadSupervisorConfig(supervisorConfig({ workerTaskName: "Jarvis; Remove-Item C:\\" }), root))
      .toThrow(/workerTaskName/);
  });

  it("bounds the restart budget", () => {
    expect(() => loadSupervisorConfig(supervisorConfig({ restartBudgetPerDay: 0 }), root)).toThrow(/between 1 and 100/);
    expect(() => loadSupervisorConfig(supervisorConfig({ deadWorkerMinutes: "soon" }), root)).toThrow(/finite number/);
  });
});

describe("a malformed config file fails loudly", () => {
  it("reports invalid JSON rather than crashing opaquely", () => {
    writeFileSync(configPath, "{ not json", "utf8");
    expect(() => loadWorkerConfig(configPath, root)).toThrow(/not valid JSON/);
  });

  it("rejects a JSON array", () => {
    writeFileSync(configPath, "[]", "utf8");
    expect(() => loadWorkerConfig(configPath, root)).toThrow(/must contain a JSON object/);
  });
});

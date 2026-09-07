import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

import {
  PAYLOAD,
  planPayload,
  planObsolete,
  stageRelease,
  activateRelease,
  rollbackRelease,
  assessQuiescence,
  readPendingActivation,
  latestBackupDir,
  isOperationalPath,
  sha256
} from "../lib/deploy.mjs";

let dir;
let source;
let destination;

const TEST_PAYLOAD = ["worker.mjs", "run-worker.ps1", "lib/state.mjs", "lib/supervise.mjs", "supervisor.mjs"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-deploy-"));
  source = join(dir, "src");
  destination = join(dir, "dest");
  mkdirSync(join(source, "lib"), { recursive: true });
  mkdirSync(destination, { recursive: true });
  for (const rel of TEST_PAYLOAD) {
    writeFileSync(join(source, rel), `NEW ${rel}\n`, "utf8");
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** An existing deployment: two of the payload files, plus operational data. */
function seedOldDeployment({ withObsolete = true } = {}) {
  mkdirSync(join(destination, "lib"), { recursive: true });
  writeFileSync(join(destination, "worker.mjs"), "OLD worker.mjs\n", "utf8");
  writeFileSync(join(destination, "run-worker.ps1"), "OLD run-worker.ps1\n", "utf8");
  writeFileSync(join(destination, "lib", "state.mjs"), "OLD lib/state.mjs\n", "utf8");
  if (withObsolete) writeFileSync(join(destination, "run-worker-safe.ps1"), "OLD SAFE WRAPPER\n", "utf8");
  // Operational data must survive every operation untouched.
  writeFileSync(join(destination, "config.json"), '{"host":"real"}', "utf8");
  writeFileSync(join(destination, "state.json"), '{"state_version":2,"tasks":{}}', "utf8");
  mkdirSync(join(destination, "logs"), { recursive: true });
  writeFileSync(join(destination, "logs", "worker.log"), "history\n", "utf8");
}

function stage(version = "20260907-010000") {
  return stageRelease({ sourceDir: source, destination, payload: TEST_PAYLOAD, version });
}

function operationalIntact() {
  return readFileSync(join(destination, "config.json"), "utf8") === '{"host":"real"}'
    && readFileSync(join(destination, "state.json"), "utf8") === '{"state_version":2,"tasks":{}}'
    && readFileSync(join(destination, "logs", "worker.log"), "utf8") === "history\n";
}

describe("planning", () => {
  it("classifies create / update / unchanged correctly", () => {
    seedOldDeployment();
    const plan = planPayload({ sourceDir: source, destination, payload: TEST_PAYLOAD });
    const byRel = Object.fromEntries(plan.entries.map((e) => [e.rel, e.action]));
    expect(byRel["worker.mjs"]).toBe("update");
    expect(byRel["lib/supervise.mjs"]).toBe("create");
    expect(byRel["supervisor.mjs"]).toBe("create");
  });

  it("refuses a partial install when a payload file is missing from the source", () => {
    rmSync(join(source, "worker.mjs"));
    const plan = planPayload({ sourceDir: source, destination, payload: TEST_PAYLOAD });
    expect(plan.complete).toBe(false);
    expect(plan.missing).toContain("worker.mjs");
    expect(() => stage()).toThrow(/Refusing a partial install/);
  });

  it("refuses to put operational data in the payload", () => {
    expect(() => planPayload({ sourceDir: source, destination, payload: ["config.json"] })).toThrow(/operational path/);
    expect(isOperationalPath("logs/worker.log")).toBe(true);
    expect(isOperationalPath("lib/state.mjs")).toBe(false);
  });

  it("the real payload lists every shipped module", () => {
    for (const rel of ["worker.mjs", "supervisor.mjs", "deploy.mjs", "lib/recovery.mjs", "lib/procid.mjs", "lib/git.mjs", "lib/statusjournal.mjs", "lib/deploy.mjs"]) {
      expect(PAYLOAD).toContain(rel);
    }
  });
});

/**
 * D126 review blocker 4: "install.ps1 ... deletes run-worker-safe.ps1 WHILE the
 * existing scheduled task still points at it".
 */
describe("blocker 4: a superseded file is never removed while a task points at it", () => {
  it("KEEPS it when a registered task still references it", () => {
    seedOldDeployment();
    const plan = planObsolete({
      destination,
      taskCommandLines: [{ taskName: "JarvisClaudeWorker", command: "powershell.exe -File C:\\w\\run-worker-safe.ps1" }]
    });
    expect(plan[0].action).toBe("keep");
    expect(plan[0].reason).toMatch(/JarvisClaudeWorker/);
  });

  it("KEEPS it when the scheduled tasks could not be queried at all", () => {
    seedOldDeployment();
    const plan = planObsolete({ destination, taskCommandLines: [], taskQueryOk: false });
    expect(plan[0].action).toBe("keep");
    expect(plan[0].reason).toMatch(/could not be queried/);
  });

  it("removes it only once no task references it", () => {
    seedOldDeployment();
    const plan = planObsolete({
      destination,
      taskCommandLines: [{ taskName: "JarvisClaudeWorker", command: "powershell.exe -File C:\\w\\run-worker.ps1" }]
    });
    expect(plan[0].action).toBe("remove");
  });

  it("end to end: the obsolete wrapper survives activation while it is still referenced", () => {
    seedOldDeployment();
    stage();
    const res = activateRelease({
      destination,
      version: "20260907-010000",
      taskCommandLines: [{ taskName: "JarvisClaudeWorker", command: "-File run-worker-safe.ps1" }]
    });
    expect(res.ok).toBe(true);
    expect(existsSync(join(destination, "run-worker-safe.ps1"))).toBe(true);
    expect(res.obsolete[0].action).toBe("keep");
  });
});

/**
 * "install.ps1 copies over live deployment file-by-file ... it only checks
 *  worker PID once, not supervisor or scheduler startup races."
 */
describe("blocker 4: a live worker or supervisor DEFERS activation instead of being overwritten", () => {
  function writeLiveLock(name) {
    writeFileSync(join(destination, name), JSON.stringify({
      lock_version: 2,
      pid: process.pid,
      host: hostname(),
      start_time: null,
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      phase: "dispatch",
      owner_token: "t"
    }, null, 2), "utf8");
  }

  it("detects a live worker lock", () => {
    writeLiveLock(".worker.lock");
    const q = assessQuiescence({ destination });
    expect(q.quiet).toBe(false);
    expect(q.blockers[0].lock).toBe(".worker.lock");
  });

  it("detects a live SUPERVISOR lock too, not only the worker", () => {
    writeLiveLock(".supervisor.lock");
    const q = assessQuiescence({ destination });
    expect(q.quiet).toBe(false);
    expect(q.blockers[0].lock).toBe(".supervisor.lock");
  });

  it("treats an unreadable lock as a blocker rather than guessing", () => {
    writeFileSync(join(destination, ".worker.lock"), "", "utf8");
    expect(assessQuiescence({ destination }).quiet).toBe(false);
  });

  it("defers, changes nothing, and records a handoff marker", () => {
    seedOldDeployment();
    writeLiveLock(".worker.lock");
    stage();
    const before = readFileSync(join(destination, "worker.mjs"), "utf8");

    const res = activateRelease({ destination, version: "20260907-010000" });
    expect(res.ok).toBe(false);
    expect(res.deferred).toBe(true);
    // The live parent was neither killed nor overwritten.
    expect(readFileSync(join(destination, "worker.mjs"), "utf8")).toBe(before);
    expect(existsSync(join(destination, "lib", "supervise.mjs"))).toBe(false);

    const pending = readPendingActivation(destination);
    expect(pending.version).toBe("20260907-010000");
    expect(pending.reason).toMatch(/\.worker\.lock/);
  });

  it("the same staged release activates cleanly once the parent has exited", () => {
    seedOldDeployment();
    writeLiveLock(".worker.lock");
    stage();
    expect(activateRelease({ destination, version: "20260907-010000" }).deferred).toBe(true);

    rmSync(join(destination, ".worker.lock")); // the legitimate parent exited
    const res = activateRelease({ destination, version: "20260907-010000" });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(destination, "worker.mjs"), "utf8")).toBe("NEW worker.mjs\n");
    expect(operationalIntact()).toBe(true);
  });
});

describe("a successful activation", () => {
  it("installs every file, verifies each hash and records old + new hashes", () => {
    seedOldDeployment();
    stage();
    const res = activateRelease({ destination, version: "20260907-010000", taskCommandLines: [] });
    expect(res.ok).toBe(true);
    for (const rel of TEST_PAYLOAD) {
      expect(readFileSync(join(destination, rel), "utf8")).toBe(`NEW ${rel}\n`);
    }
    const manifest = JSON.parse(readFileSync(res.manifestPath, "utf8"));
    const worker = manifest.files.find((f) => f.file === "worker.mjs");
    expect(worker.old_sha256).toBeTruthy();
    expect(worker.new_sha256).toBe(sha256(join(source, "worker.mjs")));
    const introduced = manifest.files.filter((f) => f.introduced).map((f) => f.file).sort();
    expect(introduced).toEqual(["lib/supervise.mjs", "supervisor.mjs"]);
    expect(operationalIntact()).toBe(true);
  });

  it("never leaves an entrypoint missing at any point during the switch", () => {
    seedOldDeployment();
    stage();
    const observations = [];
    activateRelease({
      destination,
      version: "20260907-010000",
      hooks: {
        beforeSwitch: () => observations.push(existsSync(join(destination, "run-worker.ps1"))),
        afterFileSwitch: () => observations.push(existsSync(join(destination, "run-worker.ps1")))
      }
    });
    expect(observations.length).toBeGreaterThan(1);
    expect(observations.every(Boolean)).toBe(true);
  });
});

/**
 * "Deliver a transactional/versioned activation with verified backups ...
 *  Test failures at each step in fixtures."
 */
describe("blocker 4: a failure at ANY step rolls the deployment back", () => {
  it("a failure before the first file leaves the old deployment exactly as it was", () => {
    seedOldDeployment();
    stage();
    const res = activateRelease({
      destination,
      version: "20260907-010000",
      hooks: { beforeSwitch: () => { throw new Error("injected: crash before switch"); } }
    });
    expect(res.ok).toBe(false);
    expect(res.rolled_back).toBe(true);
    expect(readFileSync(join(destination, "worker.mjs"), "utf8")).toBe("OLD worker.mjs\n");
    expect(existsSync(join(destination, "supervisor.mjs"))).toBe(false);
    expect(operationalIntact()).toBe(true);
  });

  for (const failAt of [0, 1, 2, 3]) {
    it(`a failure after file #${failAt} restores the previous bytes and removes introduced files`, () => {
      seedOldDeployment();
      stage();
      const res = activateRelease({
        destination,
        version: "20260907-010000",
        hooks: {
          afterFileSwitch: (_rel, index) => {
            if (index === failAt) throw new Error(`injected: crash after file ${index}`);
          }
        }
      });
      expect(res.ok).toBe(false);
      expect(res.rolled_back).toBe(true);
      expect(readFileSync(join(destination, "worker.mjs"), "utf8")).toBe("OLD worker.mjs\n");
      expect(readFileSync(join(destination, "run-worker.ps1"), "utf8")).toBe("OLD run-worker.ps1\n");
      expect(readFileSync(join(destination, "lib", "state.mjs"), "utf8")).toBe("OLD lib/state.mjs\n");
      // The exact reviewed gap: newly INTRODUCED modules must not be left behind.
      expect(existsSync(join(destination, "lib", "supervise.mjs"))).toBe(false);
      expect(existsSync(join(destination, "supervisor.mjs"))).toBe(false);
      expect(operationalIntact()).toBe(true);
    });
  }

  it("a failure during obsolete removal also rolls back, and the wrapper is restored", () => {
    seedOldDeployment();
    stage();
    const res = activateRelease({
      destination,
      version: "20260907-010000",
      taskCommandLines: [{ taskName: "JarvisClaudeWorker", command: "-File run-worker.ps1" }],
      hooks: { afterObsoleteRemoval: () => { throw new Error("injected: crash after obsolete removal"); } }
    });
    expect(res.ok).toBe(false);
    expect(res.rolled_back).toBe(true);
    expect(readFileSync(join(destination, "run-worker-safe.ps1"), "utf8")).toBe("OLD SAFE WRAPPER\n");
    expect(readFileSync(join(destination, "worker.mjs"), "utf8")).toBe("OLD worker.mjs\n");
  });

  it("a corrupted staged file is caught BEFORE anything live is touched", () => {
    seedOldDeployment();
    stage();
    writeFileSync(join(destination, "staging", "20260907-010000", "worker.mjs"), "TAMPERED", "utf8");
    expect(() => activateRelease({ destination, version: "20260907-010000" }))
      .toThrow(/does not match its manifest hash/);
    expect(readFileSync(join(destination, "worker.mjs"), "utf8")).toBe("OLD worker.mjs\n");
  });
});

/**
 * "Rollback restores only previously existing files and leaves the newly added
 *  supervisor task/modules active, and does not enforce old hashes from
 *  manifest."
 */
describe("blocker 4: rollback is complete and hash-enforced", () => {
  it("an explicit rollback after a SUCCESSFUL install removes the introduced modules", () => {
    seedOldDeployment();
    stage();
    const res = activateRelease({ destination, version: "20260907-010000", taskCommandLines: [] });
    expect(res.ok).toBe(true);
    expect(existsSync(join(destination, "supervisor.mjs"))).toBe(true);

    const back = rollbackRelease({ destination, backupDir: res.backupDir });
    expect(back.ok).toBe(true);
    expect(back.removed_introduced_files.sort()).toEqual(["lib/supervise.mjs", "supervisor.mjs"]);
    expect(existsSync(join(destination, "supervisor.mjs"))).toBe(false);
    expect(existsSync(join(destination, "lib", "supervise.mjs"))).toBe(false);
    expect(readFileSync(join(destination, "worker.mjs"), "utf8")).toBe("OLD worker.mjs\n");
    expect(operationalIntact()).toBe(true);
  });

  it("restores an obsolete file the install removed", () => {
    seedOldDeployment();
    stage();
    const res = activateRelease({
      destination,
      version: "20260907-010000",
      taskCommandLines: [{ taskName: "JarvisClaudeWorker", command: "-File run-worker.ps1" }]
    });
    expect(existsSync(join(destination, "run-worker-safe.ps1"))).toBe(false);
    rollbackRelease({ destination, backupDir: res.backupDir });
    expect(readFileSync(join(destination, "run-worker-safe.ps1"), "utf8")).toBe("OLD SAFE WRAPPER\n");
  });

  it("ENFORCES the manifest's old hash and refuses a tampered backup", () => {
    seedOldDeployment();
    stage();
    const res = activateRelease({ destination, version: "20260907-010000", taskCommandLines: [] });
    writeFileSync(join(res.backupDir, "worker.mjs"), "TAMPERED BACKUP\n", "utf8");
    const back = rollbackRelease({ destination, backupDir: res.backupDir });
    expect(back.ok).toBe(false);
    expect(back.failures.join(" ")).toMatch(/do not match the manifest's old hash/);
  });

  it("reports a missing backup copy instead of silently skipping it", () => {
    seedOldDeployment();
    stage();
    const res = activateRelease({ destination, version: "20260907-010000", taskCommandLines: [] });
    rmSync(join(res.backupDir, "worker.mjs"));
    const back = rollbackRelease({ destination, backupDir: res.backupDir });
    expect(back.ok).toBe(false);
    expect(back.failures.join(" ")).toMatch(/backup copy is missing/);
  });

  it("refuses to act without a manifest rather than guessing", () => {
    const back = rollbackRelease({ destination, backupDir: join(destination, "backups", "nope") });
    expect(back.ok).toBe(false);
    expect(back.error).toMatch(/no install-manifest.json/);
  });

  it("finds the most recent backup automatically", () => {
    seedOldDeployment();
    stageRelease({ sourceDir: source, destination, payload: TEST_PAYLOAD, version: "20260907-010000" });
    const first = activateRelease({ destination, version: "20260907-010000", taskCommandLines: [] });
    expect(first.ok).toBe(true);
    writeFileSync(join(source, "worker.mjs"), "NEWER worker.mjs\n", "utf8");
    stageRelease({ sourceDir: source, destination, payload: TEST_PAYLOAD, version: "20260907-020000" });
    activateRelease({ destination, version: "20260907-020000", taskCommandLines: [] });
    expect(latestBackupDir(destination)).toBe(join(destination, "backups", "20260907-020000"));
  });

  it("a first-time install rolls back to an empty destination", () => {
    stage();
    const res = activateRelease({ destination, version: "20260907-010000", taskCommandLines: [] });
    expect(res.ok).toBe(true);
    const back = rollbackRelease({ destination, backupDir: res.backupDir });
    expect(back.ok).toBe(true);
    for (const rel of TEST_PAYLOAD) {
      expect(existsSync(join(destination, rel))).toBe(false);
    }
  });
});

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
  recordIntroducedTask,
  recordTaskIntent,
  confirmTaskIntent,
  reconcileTaskIntents,
  tasksToUnregister,
  assessQuiescence,
  readPendingActivation,
  latestBackupDir,
  isOperationalPath,
  sha256,
  captureQuiescenceOwners,
  runBootstrapHandoff
} from "../lib/deploy.mjs";
import { IDENTITY, readProcessStartTime } from "../lib/procid.mjs";

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

  it("unregisters a task the install INTRODUCED, and only that task", () => {
    seedOldDeployment();
    stage();
    const res = activateRelease({ destination, version: "20260907-010000", taskCommandLines: [] });
    // install-supervisor.ps1 records this after a first-time registration.
    expect(recordIntroducedTask({ destination, taskName: "JarvisWorkerSupervisor" }).ok).toBe(true);
    // Recording twice must stay idempotent.
    expect(recordIntroducedTask({ destination, taskName: "JarvisWorkerSupervisor" }).alreadyRecorded).toBe(true);

    const back = rollbackRelease({ destination, backupDir: res.backupDir });
    expect(back.ok).toBe(true);
    expect(back.tasks_to_unregister).toEqual(["JarvisWorkerSupervisor"]);
    // The pre-existing worker task is NOT in the list: rollback never removes a
    // schedule the install did not create.
    expect(back.tasks_to_unregister).not.toContain("JarvisClaudeWorker");
  });

  it("refuses to record an introduced task with no manifest to record against", () => {
    const res = recordIntroducedTask({ destination, taskName: "JarvisWorkerSupervisor" });
    expect(res.ok).toBe(false);
  });

  /**
   * The remaining D126 deployment obligation: the installer used to REGISTER
   * first and journal afterwards, warning if the journalling failed. A crash in
   * that window left an introduced task absent from rollback history.
   */
  describe("durable registration intent (crash window between register and journal)", () => {
    function installed() {
      seedOldDeployment();
      stage();
      const res = activateRelease({ destination, version: "20260907-010000", taskCommandLines: [] });
      expect(res.ok).toBe(true);
      return res;
    }

    it("the intent is durable BEFORE registration, so a crash right after registering is still rolled back", () => {
      const res = installed();
      // Step 1: the installer records the intent and only THEN registers.
      expect(recordTaskIntent({ destination, taskName: "JarvisWorkerSupervisor", preExisting: false }).ok).toBe(true);
      // Step 2 happens on the host. Step 3 (confirmation) never runs: crash.
      const back = rollbackRelease({ destination, backupDir: res.backupDir });
      expect(back.tasks_to_unregister).toEqual(["JarvisWorkerSupervisor"]);
      expect(back.unconfirmed_task_intents.map((i) => i.task)).toEqual(["JarvisWorkerSupervisor"]);
    });

    it("an install that cannot journal its intent is refused before anything is registered", () => {
      // No manifest at all: the installer must abort rather than register.
      const res = recordTaskIntent({ destination, taskName: "JarvisWorkerSupervisor", preExisting: false });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/manifest/);
    });

    it("a REPLACED pre-existing task is never unregistered by a rollback", () => {
      const res = installed();
      expect(recordTaskIntent({ destination, taskName: "JarvisClaudeWorker", preExisting: true }).ok).toBe(true);
      // Even unconfirmed, a pre-existing task is not ours to remove.
      const back = rollbackRelease({ destination, backupDir: res.backupDir });
      expect(back.tasks_to_unregister).toEqual([]);
    });

    it("confirmation promotes an intent to an introduced task exactly once", () => {
      const res = installed();
      recordTaskIntent({ destination, taskName: "JarvisWorkerSupervisor", preExisting: false });
      const confirmed = confirmTaskIntent({ destination, taskName: "JarvisWorkerSupervisor", outcome: "introduced" });
      expect(confirmed.ok).toBe(true);
      expect(confirmed.intent.state).toBe("confirmed");
      expect(confirmed.introduced_tasks).toEqual(["JarvisWorkerSupervisor"]);
      const back = rollbackRelease({ destination, backupDir: res.backupDir });
      expect(back.tasks_to_unregister).toEqual(["JarvisWorkerSupervisor"]);
      expect(back.unconfirmed_task_intents).toEqual([]);
    });

    it("confirming without a durable intent is refused - the order can never be inverted", () => {
      installed();
      const res = confirmTaskIntent({ destination, taskName: "JarvisWorkerSupervisor", outcome: "introduced" });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/BEFORE registering/);
    });

    it("reconciliation resolves a crashed intent from the HOST, not from an assumption", () => {
      installed();
      recordTaskIntent({ destination, taskName: "JarvisWorkerSupervisor", preExisting: false });
      const rec = reconcileTaskIntents({ destination, queryTask: () => ({ ok: true, exists: true }) });
      expect(rec.ok).toBe(true);
      expect(rec.resolved).toEqual([{ task: "JarvisWorkerSupervisor", outcome: "introduced" }]);
      expect(rec.introduced_tasks).toEqual(["JarvisWorkerSupervisor"]);
    });

    it("a task the host says does not exist is resolved as aborted and not unregistered", () => {
      const res = installed();
      recordTaskIntent({ destination, taskName: "JarvisWorkerSupervisor", preExisting: false });
      const rec = reconcileTaskIntents({ destination, queryTask: () => ({ ok: true, exists: false }) });
      expect(rec.resolved).toEqual([{ task: "JarvisWorkerSupervisor", outcome: "aborted" }]);
      const back = rollbackRelease({ destination, backupDir: res.backupDir });
      expect(back.tasks_to_unregister).toEqual([]);
    });

    it("'I could not ask the host' never resolves an intent, and rollback keeps it", () => {
      const res = installed();
      recordTaskIntent({ destination, taskName: "JarvisWorkerSupervisor", preExisting: false });
      const rec = reconcileTaskIntents({ destination, queryTask: () => ({ ok: false, error: "access denied" }) });
      expect(rec.ok).toBe(false);
      expect(rec.resolved).toEqual([]);
      expect(rec.unresolved).toEqual([{ task: "JarvisWorkerSupervisor", reason: "access denied" }]);
      const back = rollbackRelease({ destination, backupDir: res.backupDir });
      expect(back.tasks_to_unregister).toEqual(["JarvisWorkerSupervisor"]);
    });

    it("tasksToUnregister never duplicates a task recorded by both paths", () => {
      installed();
      recordTaskIntent({ destination, taskName: "JarvisWorkerSupervisor", preExisting: false });
      confirmTaskIntent({ destination, taskName: "JarvisWorkerSupervisor", outcome: "introduced" });
      recordIntroducedTask({ destination, taskName: "JarvisWorkerSupervisor" });
      const manifestPath = join(latestBackupDir(destination), "install-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(tasksToUnregister(manifest)).toEqual(["JarvisWorkerSupervisor"]);
    });
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

/**
 * D126 FINAL review finding 3: "deferred activation is not a proven bootstrap
 * handoff from the deployed legacy runner".
 *
 * The fixture deliberately starts from a LEGACY deployed destination: the
 * installed run-worker.ps1 has NO pending-activation support, and the registered
 * scheduled task points at that legacy entrypoint. That is the state the host is
 * actually in, and it is exactly the state in which "the next scheduler tick
 * applies the marker" is circular - the tick runs the OLD file.
 *
 * `runBootstrapHandoff` is the non-circular half: it runs from the source tree
 * before the payload is switched, waits for the EXACT captured parent identity
 * to exit, re-checks quiescence, and only then activates transactionally.
 */
describe("finding 3: controlled bootstrap handoff from a LEGACY deployment", () => {
  const VERSION = "20260907-010000";
  const LEGACY_ENTRYPOINT = "OLD run-worker.ps1 - no pending-activation support\n";
  // The "legitimate parent" is a genuinely live process with a real start time,
  // so `classifyLock` reaches the same `active` verdict it would on the host.
  // Anything less and quiescence would classify it as stale and the install
  // would never defer in the first place.
  const PARENT = { pid: process.pid, host: hostname(), start_time: readProcessStartTime(process.pid) };

  /** The legacy scheduled task command line: it points at the OLD entrypoint. */
  function legacyTask() {
    return [{
      taskName: "JarvisClaudeWorker",
      command: `powershell.exe -File ${join(destination, "run-worker.ps1")}`,
      principal: { userId: "Tobia", logonType: "Password", runLevel: "Highest" }
    }];
  }

  function seedLegacyDeployment() {
    mkdirSync(join(destination, "lib"), { recursive: true });
    writeFileSync(join(destination, "worker.mjs"), "OLD worker.mjs (v1)\n", "utf8");
    writeFileSync(join(destination, "run-worker.ps1"), LEGACY_ENTRYPOINT, "utf8");
    writeFileSync(join(destination, "lib", "state.mjs"), "OLD lib/state.mjs\n", "utf8");
    writeFileSync(join(destination, "config.json"), '{"host":"real"}', "utf8");
    writeFileSync(join(destination, "state.json"), '{"state_version":2,"tasks":{}}', "utf8");
    mkdirSync(join(destination, "logs"), { recursive: true });
    writeFileSync(join(destination, "logs", "worker.log"), "history\n", "utf8");
  }

  /** The live parent that launched this install and still owns the lock. */
  function writeParentLock(name = ".worker.lock") {
    writeFileSync(join(destination, name), JSON.stringify({
      lock_version: 2,
      pid: PARENT.pid,
      host: PARENT.host,
      start_time: PARENT.start_time,
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      phase: "dispatch",
      task_id: "T-LEGACY",
      owner_token: "t"
    }, null, 2), "utf8");
  }

  /**
   * Identity probe under our control. It reports the parent as alive for the
   * first `aliveFor` probes, then gone - i.e. the parent exits on its own. It
   * is never killed; nothing in this path terminates anything.
   */
  function exitingParent(aliveFor = 2) {
    let probes = 0;
    return () => {
      probes += 1;
      return probes <= aliveFor
        ? { state: IDENTITY.MATCH, reason: `pid ${PARENT.pid} is the same process that was recorded` }
        : { state: IDENTITY.GONE, reason: `pid ${PARENT.pid} no longer exists` };
    };
  }

  /** The parent exits, so the lock it owned stops being a blocker. */
  function parentExits() {
    rmSync(join(destination, ".worker.lock"), { force: true });
  }

  const NEVER_SLEEP = () => {};

  function deferInstall() {
    seedLegacyDeployment();
    writeParentLock();
    stage(VERSION);
    const res = activateRelease({ destination, version: VERSION, taskCommandLines: legacyTask() });
    expect(res.deferred).toBe(true);
    return res;
  }

  it("install invoked by its child defers, and the legacy entrypoint is untouched", () => {
    deferInstall();
    expect(readFileSync(join(destination, "run-worker.ps1"), "utf8")).toBe(LEGACY_ENTRYPOINT);
    expect(readFileSync(join(destination, "worker.mjs"), "utf8")).toBe("OLD worker.mjs (v1)\n");
    expect(readPendingActivation(destination).version).toBe(VERSION);
  });

  it("captures the EXACT parent identity, pid AND start time AND host", () => {
    deferInstall();
    const { owners } = captureQuiescenceOwners({ destination });
    expect(owners).toHaveLength(1);
    expect(owners[0].lock).toBe(".worker.lock");
    expect(owners[0].identity).toEqual({ pid: PARENT.pid, host: PARENT.host, start_time: PARENT.start_time });
  });

  it("the full handoff: parent exits -> activation applies the EXACT staged hashes", () => {
    deferInstall();
    const owners = captureQuiescenceOwners({ destination }).owners;

    const res = runBootstrapHandoff({
      destination,
      owners,
      matchIdentity: exitingParent(2),
      sleep: () => parentExits(), // the parent exits while we wait; never killed
      taskCommandLines: legacyTask(),
      pollIntervalMs: 1
    });

    expect(res.ok).toBe(true);
    expect(res.activated).toBe(true);
    expect(res.version).toBe(VERSION);
    expect(res.waited[0]).toEqual({ lock: ".worker.lock", pid: PARENT.pid, exit_state: IDENTITY.GONE });

    // Every switched file matches the hash recorded when it was staged.
    const stageManifest = JSON.parse(readFileSync(join(destination, "staging", VERSION, "stage-manifest.json"), "utf8"));
    for (const f of stageManifest.files) {
      expect(sha256(join(destination, f.file)), f.file).toBe(f.new_sha256);
    }
    // The marker is consumed only on success.
    expect(readPendingActivation(destination)).toBeNull();
    expect(operationalIntact()).toBe(true);
  });

  it("the scheduled task remains runnable: its entrypoint still exists afterwards", () => {
    deferInstall();
    const owners = captureQuiescenceOwners({ destination }).owners;
    runBootstrapHandoff({
      destination, owners, matchIdentity: exitingParent(1),
      sleep: () => parentExits(), taskCommandLines: legacyTask(), pollIntervalMs: 1
    });
    // The command line the scheduler holds still resolves to a real file, and
    // that file is now the NEW runner - registration was never touched.
    const entrypoint = join(destination, "run-worker.ps1");
    expect(existsSync(entrypoint)).toBe(true);
    expect(readFileSync(entrypoint, "utf8")).toBe("NEW run-worker.ps1\n");
  });

  it("waits for the EXACT identity: a live parent is never overwritten", () => {
    deferInstall();
    const owners = captureQuiescenceOwners({ destination }).owners;
    const res = runBootstrapHandoff({
      destination, owners,
      matchIdentity: () => ({ state: IDENTITY.MATCH, reason: "still running" }),
      sleep: NEVER_SLEEP, waitDeadlineMs: 0, taskCommandLines: legacyTask()
    });
    expect(res.ok).toBe(false);
    expect(res.deferred).toBe(true);
    expect(res.activated).toBe(false);
    // Nothing was activated, nothing was terminated, the marker survives.
    expect(readFileSync(join(destination, "run-worker.ps1"), "utf8")).toBe(LEGACY_ENTRYPOINT);
    expect(readPendingActivation(destination).version).toBe(VERSION);
  });

  it("UNPROVEN liveness is never accepted as 'the parent exited'", () => {
    deferInstall();
    const owners = captureQuiescenceOwners({ destination }).owners;
    const res = runBootstrapHandoff({
      destination, owners,
      matchIdentity: () => ({ state: IDENTITY.UNPROVEN, reason: "start time cannot be read" }),
      sleep: NEVER_SLEEP, waitDeadlineMs: 0, taskCommandLines: legacyTask()
    });
    expect(res.activated).toBe(false);
    expect(res.reason).toMatch(/unproven/);
    expect(readFileSync(join(destination, "run-worker.ps1"), "utf8")).toBe(LEGACY_ENTRYPOINT);
  });

  it("a NEW owner that appears while waiting defers the handoff again", () => {
    deferInstall();
    const owners = captureQuiescenceOwners({ destination }).owners;
    const res = runBootstrapHandoff({
      destination, owners,
      matchIdentity: () => ({ state: IDENTITY.GONE, reason: "the original parent exited" }),
      // The original parent is gone, but a fresh supervisor has taken its own
      // lock in the meantime.
      sleep: NEVER_SLEEP,
      hooks: { afterParentExit: () => writeParentLock(".supervisor.lock") },
      taskCommandLines: legacyTask()
    });
    expect(res.ok).toBe(false);
    expect(res.deferred).toBe(true);
    expect(res.reason).toMatch(/became active again/);
    expect(readFileSync(join(destination, "run-worker.ps1"), "utf8")).toBe(LEGACY_ENTRYPOINT);
    expect(readPendingActivation(destination).version).toBe(VERSION);
  });

  it("does not require the staged runner to be live: it works from the OLD one", () => {
    deferInstall();
    // Proof the legacy entrypoint has no idea about the marker: it is still the
    // old bytes at the moment the handoff starts, and the handoff never reads
    // or executes it.
    expect(readFileSync(join(destination, "run-worker.ps1"), "utf8")).toBe(LEGACY_ENTRYPOINT);
    const owners = captureQuiescenceOwners({ destination }).owners;
    const res = runBootstrapHandoff({
      destination, owners, matchIdentity: exitingParent(1),
      sleep: () => parentExits(), taskCommandLines: legacyTask(), pollIntervalMs: 1
    });
    expect(res.activated).toBe(true);
  });

  /**
   * Fault injection before and after every handoff step. After each one the
   * deployment must be rollback-complete and the scheduler's entrypoint must
   * still exist - a missing entrypoint is the failure that stopped the loop.
   */
  describe("injected failures at each handoff step", () => {
    const STEPS = ["beforeWait", "afterParentExit", "beforeActivate", "beforeSwitch", "afterObsoleteRemoval", "afterActivate"];

    for (const step of STEPS) {
      it(`a failure at ${step} leaves no missing entrypoint`, () => {
        deferInstall();
        const owners = captureQuiescenceOwners({ destination }).owners;
        let threw = null;
        let res = null;
        try {
          res = runBootstrapHandoff({
            destination, owners, matchIdentity: exitingParent(1),
            sleep: () => parentExits(), taskCommandLines: legacyTask(), pollIntervalMs: 1,
            hooks: { [step]: () => { throw new Error(`injected failure at ${step}`); } }
          });
        } catch (err) {
          threw = err;
        }

        // Whatever happened, the scheduler's entrypoint exists and is one of the
        // two complete, valid versions - never absent, never a partial file.
        const entrypoint = join(destination, "run-worker.ps1");
        expect(existsSync(entrypoint), step).toBe(true);
        const bytes = readFileSync(entrypoint, "utf8");
        expect([LEGACY_ENTRYPOINT, "NEW run-worker.ps1\n"], step).toContain(bytes);

        // Operational data is never collateral damage.
        expect(operationalIntact(), step).toBe(true);

        // A fault inside the switch must have rolled the whole deployment back
        // to the legacy bytes, not left a mixture of old and new modules.
        if (step === "beforeSwitch") {
          expect(threw).toBeNull();
          expect(res.ok).toBe(false);
          expect(res.rolled_back).toBe(true);
          expect(bytes).toBe(LEGACY_ENTRYPOINT);
          expect(readFileSync(join(destination, "worker.mjs"), "utf8")).toBe("OLD worker.mjs (v1)\n");
          // Files the install INTRODUCED are removed again.
          expect(existsSync(join(destination, "lib", "supervise.mjs"))).toBe(false);
        }

        // A fault before activation must not have touched anything at all.
        if (step === "beforeWait" || step === "afterParentExit" || step === "beforeActivate") {
          expect(bytes).toBe(LEGACY_ENTRYPOINT);
          expect(readFileSync(join(destination, "worker.mjs"), "utf8")).toBe("OLD worker.mjs (v1)\n");
        }

        // The marker survives every failure, so the handoff is retryable and
        // never silently lost.
        if (step !== "afterActivate") {
          expect(readPendingActivation(destination)?.version, step).toBe(VERSION);
        }
      });
    }

    it("a retry after a rolled-back switch still completes cleanly", () => {
      deferInstall();
      const owners = captureQuiescenceOwners({ destination }).owners;
      const failed = runBootstrapHandoff({
        destination, owners, matchIdentity: exitingParent(1),
        sleep: () => parentExits(), taskCommandLines: legacyTask(), pollIntervalMs: 1,
        hooks: { beforeSwitch: () => { throw new Error("injected"); } }
      });
      expect(failed.rolled_back).toBe(true);

      const retry = runBootstrapHandoff({
        destination, owners,
        matchIdentity: () => ({ state: IDENTITY.GONE, reason: "parent already exited" }),
        sleep: () => {}, taskCommandLines: legacyTask(), pollIntervalMs: 1
      });
      expect(retry.ok).toBe(true);
      expect(readFileSync(join(destination, "run-worker.ps1"), "utf8")).toBe("NEW run-worker.ps1\n");
      expect(operationalIntact()).toBe(true);
    });
  });

  it("refuses when there is no pending activation and no version", () => {
    seedLegacyDeployment();
    const res = runBootstrapHandoff({ destination, owners: [], sleep: NEVER_SLEEP });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no pending activation/);
  });

  /**
   * D126 ADDENDUM ITEM 5: "bootstrap handoff can abandon a deferred legacy
   * install forever".
   *
   * The defect: `captureQuiescenceOwners` put a syntactically unreadable lock
   * into a separate `unreadable` list that nothing consumed, and dropped a
   * SEMANTICALLY malformed verdict - which is exactly what a genuine legacy
   * lock without a `host` produces - entirely. `runBootstrapHandoff` consumed
   * only `owners`, so against such a lock it captured ZERO identities, waited
   * for nothing, hit `assessQuiescence` (which DOES treat those as blockers),
   * returned `deferred` immediately, and the standalone process EXITED. On a
   * legacy installation the registered entrypoint has no pending-activation
   * support, so the marker had no future consumer at all.
   *
   * The corrected behaviour: stay alive and poll fail-closed inside ONE fixed
   * bounded deadline for BOTH kinds of blocker, preserve the exact captured
   * identities, never terminate or substitute anything, and only activate once
   * the blockers have resolved and quiescence has been re-checked.
   */
  describe("addendum item 5: an unclassifiable lock is polled, never abandoned", () => {
    /** A lock file whose bytes are not JSON at all. */
    function writeMalformedJsonLock(name = ".worker.lock") {
      writeFileSync(join(destination, name), "{not json at all", "utf8");
    }

    /**
     * A GENUINE old lock shape: the v1 file the currently deployed worker
     * writes. It has no host binding and no start time, so the schema check
     * fails and `classifyLock` returns `malformed` - a semantic verdict, not a
     * parse error. This is the shape the previous code discarded silently.
     */
    function writeLegacyMissingHostLock(name = ".worker.lock") {
      writeFileSync(join(destination, name), JSON.stringify({
        pid: 4242,
        started_at: new Date().toISOString(),
        phase: "dispatch"
      }, null, 2), "utf8");
    }

    /** A reader that fails the way an access-denied or sharing violation does. */
    function throwingReader(rel = ".worker.lock") {
      return (path) => {
        if (path.endsWith(rel)) throw new Error("EACCES: permission denied");
        return null;
      };
    }

    /** A clock that only moves when the handoff sleeps: deterministic timing. */
    function fakeClock(stepMs) {
      let t = 0;
      return { clock: () => t, sleep: () => { t += stepMs; } };
    }

    function deferWithBlocker(seedBlocker) {
      seedLegacyDeployment();
      writeParentLock();
      stage(VERSION);
      const res = activateRelease({ destination, version: VERSION, taskCommandLines: legacyTask() });
      expect(res.deferred).toBe(true);
      // Replace the well-formed parent lock with the blocking shape under test.
      rmSync(join(destination, ".worker.lock"), { force: true });
      seedBlocker();
    }

    it("records a syntactically malformed lock as a blocker, not as an absence", () => {
      deferWithBlocker(writeMalformedJsonLock);
      const snap = captureQuiescenceOwners({ destination });
      expect(snap.owners).toHaveLength(0);
      expect(snap.blockers).toHaveLength(1);
      expect(snap.blockers[0].lock).toBe(".worker.lock");
      expect(snap.blockers[0].kind).toBe("unreadable");
      // The old `unreadable` list is still populated for existing reporting.
      expect(snap.unreadable).toHaveLength(1);
    });

    it("records a SEMANTIC malformed verdict (legacy, no host) as a blocker", () => {
      deferWithBlocker(writeLegacyMissingHostLock);
      const snap = captureQuiescenceOwners({ destination });
      // This is the case that used to vanish completely: it parses fine, so it
      // never reached `unreadable`, and its verdict was not in the owner list.
      expect(snap.owners).toHaveLength(0);
      expect(snap.blockers).toHaveLength(1);
      expect(snap.blockers[0].kind).toBe("malformed_claim");
      expect(snap.blockers[0].reason).toMatch(/host binding is missing/);
    });

    it("records a read/access error as a blocker, never as a free lock", () => {
      deferWithBlocker(writeMalformedJsonLock);
      const snap = captureQuiescenceOwners({ destination, readRaw: throwingReader() });
      expect(snap.owners).toHaveLength(0);
      expect(snap.blockers[0].kind).toBe("read_error");
      expect(snap.blockers[0].reason).toMatch(/EACCES/);
      // assessQuiescence agrees: an unreadable lock is never quiet.
      expect(assessQuiescence({ destination, readRaw: throwingReader() }).quiet).toBe(false);
    });

    for (const [label, seed] of [
      ["syntactically malformed JSON", writeMalformedJsonLock],
      ["a genuine legacy lock with no host", writeLegacyMissingHostLock]
    ]) {
      it(`polls instead of abandoning the install when the lock is ${label}`, () => {
        deferWithBlocker(seed);
        const { clock, sleep } = fakeClock(1_000);
        let polls = 0;
        const res = runBootstrapHandoff({
          destination,
          matchIdentity: () => ({ state: IDENTITY.GONE, reason: "no captured owner" }),
          clock,
          // The blocker clears on the third poll: the legacy owner released it.
          sleep: () => {
            sleep();
            polls += 1;
            if (polls === 3) rmSync(join(destination, ".worker.lock"), { force: true });
          },
          waitDeadlineMs: 60_000,
          pollIntervalMs: 1_000,
          taskCommandLines: legacyTask()
        });

        // The decisive assertion: it did NOT return on the first look.
        expect(polls).toBeGreaterThanOrEqual(3);
        expect(res.polls).toBeGreaterThanOrEqual(3);
        expect(res.ok).toBe(true);
        expect(res.activated).toBe(true);
        expect(readPendingActivation(destination)).toBeNull();
        expect(readFileSync(join(destination, "run-worker.ps1"), "utf8")).toBe("NEW run-worker.ps1\n");
      });
    }

    it("polls through a transient read/access error and activates once it clears", () => {
      deferWithBlocker(writeMalformedJsonLock);
      rmSync(join(destination, ".worker.lock"), { force: true });
      let reads = 0;
      const { clock, sleep } = fakeClock(1_000);
      const res = runBootstrapHandoff({
        destination,
        // Inaccessible for the first four reads (one of which is the initial
        // capture), then genuinely absent.
        readRaw: (path) => {
          if (!path.endsWith(".worker.lock")) return null;
          reads += 1;
          if (reads <= 4) throw new Error("EACCES: permission denied");
          return null;
        },
        blockers: [{ lock: ".worker.lock", kind: "read_error", reason: "EACCES: permission denied", pid: null }],
        owners: [],
        matchIdentity: () => ({ state: IDENTITY.GONE, reason: "no captured owner" }),
        clock, sleep,
        waitDeadlineMs: 60_000,
        pollIntervalMs: 1_000,
        taskCommandLines: legacyTask()
      });
      expect(res.polls).toBeGreaterThanOrEqual(3);
      expect(res.ok).toBe(true);
      expect(res.activated).toBe(true);
    });

    it("a blocker that never resolves expires the ONE deadline and defers, marker intact", () => {
      deferWithBlocker(writeLegacyMissingHostLock);
      const before = readFileSync(join(destination, ".worker.lock"), "utf8");
      const { clock, sleep } = fakeClock(1_000);
      const res = runBootstrapHandoff({
        destination,
        matchIdentity: () => ({ state: IDENTITY.GONE, reason: "no captured owner" }),
        clock, sleep,
        waitDeadlineMs: 5_000,
        pollIntervalMs: 1_000,
        taskCommandLines: legacyTask()
      });

      expect(res.ok).toBe(false);
      expect(res.activated).toBe(false);
      expect(res.deferred).toBe(true);
      expect(res.deadline_expired).toBe(true);
      // It waited out the whole budget rather than giving up immediately.
      expect(res.polls).toBeGreaterThanOrEqual(5);
      expect(res.waited_ms).toBeGreaterThanOrEqual(5_000);
      expect(res.unresolved_blockers[0].kind).toBe("malformed_claim");
      // Nothing was terminated, nothing was overwritten, nothing was lost: the
      // lock file is byte-identical and the marker is still there.
      expect(readFileSync(join(destination, ".worker.lock"), "utf8")).toBe(before);
      expect(readFileSync(join(destination, "run-worker.ps1"), "utf8")).toBe(LEGACY_ENTRYPOINT);
      expect(readPendingActivation(destination).version).toBe(VERSION);
      expect(operationalIntact()).toBe(true);
    });

    it("a captured owner that never exits expires the SAME single deadline", () => {
      deferInstall();
      const owners = captureQuiescenceOwners({ destination }).owners;
      const { clock, sleep } = fakeClock(1_000);
      const res = runBootstrapHandoff({
        destination, owners,
        matchIdentity: () => ({ state: IDENTITY.MATCH, reason: "still running" }),
        clock, sleep, waitDeadlineMs: 4_000, pollIntervalMs: 1_000,
        taskCommandLines: legacyTask()
      });
      expect(res.deferred).toBe(true);
      expect(res.deadline_expired).toBe(true);
      expect(res.unresolved_owners[0]).toMatchObject({ lock: ".worker.lock", pid: PARENT.pid, state: IDENTITY.MATCH });
      // The EXACT captured identity is preserved and reported, never swapped
      // for whatever happens to hold the lock now.
      expect(res.parents[0].identity).toEqual({ pid: PARENT.pid, host: PARENT.host, start_time: PARENT.start_time });
      expect(readPendingActivation(destination).version).toBe(VERSION);
    });

    it("a NEW owner appearing while polling defers instead of overwriting it", () => {
      deferWithBlocker(writeMalformedJsonLock);
      const { clock, sleep } = fakeClock(1_000);
      let polls = 0;
      const res = runBootstrapHandoff({
        destination,
        matchIdentity: () => ({ state: IDENTITY.GONE, reason: "no captured owner" }),
        clock,
        sleep: () => {
          sleep();
          polls += 1;
          // The malformed lock is replaced by a VALID, live owner: the race the
          // handoff must lose safely rather than win destructively.
          if (polls === 2) writeParentLock();
        },
        waitDeadlineMs: 60_000,
        pollIntervalMs: 1_000,
        taskCommandLines: legacyTask()
      });

      expect(res.ok).toBe(false);
      expect(res.activated).toBe(false);
      expect(res.deferred).toBe(true);
      expect(res.reason).toMatch(/became active again/);
      // The new owner was never adopted as "the captured parent" and never
      // terminated: its lock is untouched and it still owns the deployment.
      expect(res.parents).toEqual([]);
      expect(existsSync(join(destination, ".worker.lock"))).toBe(true);
      expect(readFileSync(join(destination, "run-worker.ps1"), "utf8")).toBe(LEGACY_ENTRYPOINT);
      expect(readPendingActivation(destination).version).toBe(VERSION);
    });

    it("the OLD defect is gone: an unclassifiable lock no longer defers on poll zero", () => {
      deferWithBlocker(writeLegacyMissingHostLock);
      const { clock, sleep } = fakeClock(1_000);
      let polls = 0;
      const res = runBootstrapHandoff({
        destination,
        matchIdentity: () => ({ state: IDENTITY.GONE, reason: "no captured owner" }),
        clock,
        sleep: () => { sleep(); polls += 1; },
        waitDeadlineMs: 3_000,
        pollIntervalMs: 1_000,
        taskCommandLines: legacyTask()
      });
      // Previously: zero captured owners -> zero waiting -> immediate deferral
      // and process exit, with no future consumer for the marker.
      expect(polls).toBeGreaterThan(0);
      expect(res.deadline_expired).toBe(true);
      expect(res.reason).toMatch(/wait budget expired/);
      expect(res.reason).toMatch(/could not be classified as safe/);
    });
  });
});

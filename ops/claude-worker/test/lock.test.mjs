import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, statSync, readdirSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  classifyLock,
  acquireLock,
  heartbeat,
  releaseLock,
  readLock,
  readLockRaw,
  holdsLock,
  publishExclusive,
  removeVerified,
  MALFORMED_LOCK_GRACE_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS
} from "../lib/lock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RACER = join(HERE, "fixtures", "lock-racer.mjs");

let dir;
let lockFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-lock-"));
  lockFile = join(dir, ".worker.lock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-09-07T02:00:00.000Z");

function lockInfo(overrides = {}) {
  return {
    lock_version: 2,
    pid: 4242,
    host: hostname(),
    start_time: "2026-09-07T01:00:00.0000000Z",
    started_at: new Date(NOW - 60_000).toISOString(),
    heartbeat_at: new Date(NOW - 10_000).toISOString(),
    task_id: "T",
    phase: "dispatch",
    owner_token: "token-1",
    ...overrides
  };
}

describe("classification binds to process identity, not to a pid", () => {
  it("a live, heartbeating owner is active however long it has been running", () => {
    const info = lockInfo({ started_at: new Date(NOW - 50 * 60_000).toISOString() });
    const verdict = classifyLock(info, { nowMs: NOW, alive: () => true, startTime: () => info.start_time });
    expect(verdict.state).toBe("active");
  });

  it("a reused pid is never mistaken for our worker", () => {
    const info = lockInfo();
    const verdict = classifyLock(info, { nowMs: NOW, alive: () => true, startTime: () => "2026-09-07T01:59:00.0000000Z" });
    expect(verdict.state).toBe("stale_reused_pid");
  });

  it("a dead owner is detected immediately, without an age budget", () => {
    const verdict = classifyLock(lockInfo(), { nowMs: NOW, alive: () => false });
    expect(verdict.state).toBe("stale_dead");
  });

  it("an unreadable start time is UNPROVEN, never assumed dead or alive", () => {
    const verdict = classifyLock(lockInfo(), { nowMs: NOW, alive: () => true, startTime: () => null });
    expect(verdict.state).toBe("unproven_identity");
  });

  it("a foreign host is never touched", () => {
    const verdict = classifyLock(lockInfo({ host: "OTHER-MACHINE" }), { nowMs: NOW, alive: () => true });
    expect(verdict.state).toBe("foreign_host");
  });

  it("a lock without a host binding cannot be reasoned about and is malformed", () => {
    const verdict = classifyLock(lockInfo({ host: undefined }), { nowMs: NOW, alive: () => true });
    expect(verdict.state).toBe("malformed");
  });

  it("an alive owner past the heartbeat budget needs attention, not a silent kill", () => {
    const info = lockInfo({ heartbeat_at: new Date(NOW - DEFAULT_HEARTBEAT_TIMEOUT_MS - 60_000).toISOString() });
    const verdict = classifyLock(info, { nowMs: NOW, alive: () => true, startTime: () => info.start_time });
    expect(verdict.state).toBe("stale_no_heartbeat");
  });
});

/**
 * D126 review blocker 2, architect reproduction: EMPTY_LOCK_RECLAIMED=true.
 *
 * "acquireLock publishes an EMPTY wx file, closes fd then writes JSON.
 *  Empty/malformed locks are immediately unlinked."
 */
describe("blocker 2: a freshly unreadable lock is NOT stolen", () => {
  it("refuses to reclaim an empty lock inside the publication grace window", () => {
    writeFileSync(lockFile, "", "utf8"); // exactly what a mid-publication lock looks like
    const res = acquireLock(lockFile, { nowMs: Date.now() });
    expect(res.acquired).toBe(false);
    expect(res.verdict.state).toBe("publishing");
    expect(readFileSync(lockFile, "utf8")).toBe(""); // untouched
  });

  it("refuses to reclaim a half-written JSON lock inside the grace window", () => {
    writeFileSync(lockFile, '{"pid": 12', "utf8");
    const res = acquireLock(lockFile, { nowMs: Date.now() });
    expect(res.acquired).toBe(false);
    expect(res.verdict.state).toBe("publishing");
    expect(existsSync(lockFile)).toBe(true);
  });

  it("does reclaim an unreadable lock once it is demonstrably old", () => {
    writeFileSync(lockFile, "", "utf8");
    const old = (Date.now() - MALFORMED_LOCK_GRACE_MS - 60_000) / 1000;
    utimesSync(lockFile, old, old);
    const res = acquireLock(lockFile, { nowMs: Date.now() });
    expect(res.acquired).toBe(true);
    expect(JSON.parse(readFileSync(lockFile, "utf8")).pid).toBe(process.pid);
  });
});

describe("blocker 2: publication is atomic - the lock is never observable empty", () => {
  it("publishExclusive writes complete content or nothing at all", () => {
    const payload = JSON.stringify(lockInfo(), null, 2);
    const first = publishExclusive(lockFile, payload);
    expect(first.ok).toBe(true);
    expect(readFileSync(lockFile, "utf8")).toBe(payload);

    const second = publishExclusive(lockFile, JSON.stringify({ pid: 1 }));
    expect(second.ok).toBe(false);
    expect(second.code).toBe("EEXIST");
    // The loser must not have disturbed the winner's bytes.
    expect(readFileSync(lockFile, "utf8")).toBe(payload);
  });

  it("leaves no staging files behind", () => {
    publishExclusive(lockFile, JSON.stringify(lockInfo()));
    const leftovers = readdirSync(dir).filter((f) => f.includes(".staging-"));
    expect(leftovers).toEqual([]);
  });

  it("a heartbeat is published atomically and the file always parses", () => {
    const res = acquireLock(lockFile);
    expect(res.acquired).toBe(true);
    for (let i = 0; i < 300; i += 1) {
      expect(heartbeat(lockFile, { token: res.token, phase: `p${i}` })).toBe(true);
      const raw = readFileSync(lockFile, "utf8");
      expect(raw.length).toBeGreaterThan(0);
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(JSON.parse(raw).pid).toBe(process.pid);
    }
    releaseLock(lockFile, res.token);
  });
});

/**
 * "Concurrent reclaimers can unlink each other's new locks."
 */
describe("blocker 2: reclaim is content-verified and single-winner", () => {
  it("removeVerified refuses when the bytes changed under it", () => {
    writeFileSync(lockFile, "ORIGINAL", "utf8");
    const res = removeVerified(lockFile, "SOMETHING ELSE");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("lock_changed_during_reclaim");
    // The lock we did NOT verify must still be there.
    expect(readFileSync(lockFile, "utf8")).toBe("ORIGINAL");
  });

  it("removeVerified succeeds only for the exact classified bytes", () => {
    writeFileSync(lockFile, "ORIGINAL", "utf8");
    expect(removeVerified(lockFile, "ORIGINAL").ok).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("reports a lost reclaim race instead of destroying the winner's lock", () => {
    const dead = lockInfo({ pid: 999999, start_time: null, host: hostname() });
    writeFileSync(lockFile, JSON.stringify(dead, null, 2), "utf8");
    // Between classification and reclaim, another instance publishes a new lock.
    // `removeVerified` is handed the bytes we classified, so the swap is caught.
    const swapped = JSON.stringify(lockInfo({ pid: 4242 }), null, 2);
    writeFileSync(lockFile, swapped, "utf8");
    const res = removeVerified(lockFile, JSON.stringify(dead, null, 2));
    expect(res.ok).toBe(false);
    expect(readFileSync(lockFile, "utf8")).toBe(swapped);
  });
});

describe("ownership is a token, not a pid", () => {
  it("heartbeat and release require the exact token", () => {
    const res = acquireLock(lockFile);
    expect(res.acquired).toBe(true);
    expect(holdsLock(lockFile, res.token)).toBe(true);
    expect(holdsLock(lockFile, "wrong-token")).toBe(false);
    expect(heartbeat(lockFile, { token: "wrong-token" })).toBe(false);
    expect(releaseLock(lockFile, "wrong-token")).toBe(false);
    expect(existsSync(lockFile)).toBe(true);
    expect(releaseLock(lockFile, res.token)).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("a lock replaced by someone else is not released by us", () => {
    const res = acquireLock(lockFile);
    writeFileSync(lockFile, JSON.stringify(lockInfo({ pid: 777, owner_token: "someone-else" })), "utf8");
    expect(releaseLock(lockFile, res.token)).toBe(false);
    expect(existsSync(lockFile)).toBe(true);
  });

  it("readLock reports malformed content without throwing", () => {
    writeFileSync(lockFile, "not json", "utf8");
    expect(readLock(lockFile)).toEqual({ malformed: true });
    expect(readLockRaw(lockFile).malformed).toBe(true);
    expect(readLockRaw(lockFile).raw).toBe("not json");
  });
});

/** ---------------- real concurrency ---------------- */

function runRacers(count, { holdMs = 250, mode = "acquire", barrierDelayMs = 900 } = {}) {
  const barrier = Date.now() + barrierDelayMs;
  const results = [];
  const children = [];
  for (let i = 0; i < count; i += 1) {
    const resultFile = join(dir, `result-${i}.json`);
    results.push(resultFile);
    children.push(new Promise((resolve) => {
      const child = spawn(process.execPath, [RACER, lockFile, resultFile, String(barrier), String(holdMs), mode], {
        stdio: "ignore"
      });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    }));
  }
  return Promise.all(children).then(() => results
    .filter((f) => existsSync(f))
    .map((f) => JSON.parse(readFileSync(f, "utf8"))));
}

describe("blocker 2: REAL concurrent processes, not a sequential simulation", () => {
  it("exactly one of eight simultaneous processes acquires the lock", async () => {
    const outcomes = await runRacers(8, { holdMs: 400 });
    expect(outcomes.length).toBe(8);
    const winners = outcomes.filter((o) => o.acquired);
    expect(winners).toHaveLength(1);
    expect(winners[0].lostOwnership).toBe(false);
    expect(winners[0].still_holds).toBe(true);
    for (const loser of outcomes.filter((o) => !o.acquired)) {
      expect(loser.threw).toBeUndefined();
    }
    expect(existsSync(lockFile)).toBe(false); // the winner released it
  }, 30_000);

  it("a live heartbeating owner is never displaced by six concurrent challengers", async () => {
    const outcomes = await runRacers(6, { holdMs: 700, mode: "heartbeat" });
    const winners = outcomes.filter((o) => o.acquired);
    expect(winners).toHaveLength(1);
    expect(winners[0].beats).toBeGreaterThan(0);
    expect(winners[0].lostOwnership).toBe(false);
  }, 30_000);

  it("a stale lock left by a dead process is reclaimed by exactly one racer", async () => {
    writeFileSync(lockFile, JSON.stringify(lockInfo({ pid: 999999, start_time: null }), null, 2), "utf8");
    const old = (Date.now() - 3600_000) / 1000;
    utimesSync(lockFile, old, old);
    const outcomes = await runRacers(6, { holdMs: 200 });
    expect(outcomes.filter((o) => o.acquired)).toHaveLength(1);
  }, 30_000);

  it("an EMPTY lock file is not stolen by any of six concurrent racers while it is fresh", async () => {
    writeFileSync(lockFile, "", "utf8");
    const outcomes = await runRacers(6, { holdMs: 100 });
    expect(outcomes.filter((o) => o.acquired)).toHaveLength(0);
    expect(readFileSync(lockFile, "utf8")).toBe("");
    expect(statSync(lockFile).size).toBe(0);
  }, 30_000);
});

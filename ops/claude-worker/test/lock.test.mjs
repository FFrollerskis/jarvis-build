/**
 * Requirement C acceptance tests: one worker at a time, and a live long-running
 * child must never be mistaken for a stale lock.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

import { classifyLock, acquireLock, releaseLock, heartbeat, readLock, isProcessAlive, DEFAULT_HEARTBEAT_TIMEOUT_MS } from "../lib/lock.mjs";

let dir;
let lockFile;
const HOST = hostname();
const NOW = Date.parse("2026-09-07T02:00:00.000Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-lock-"));
  lockFile = join(dir, ".worker.lock");
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const aliveAlways = () => true;
const deadAlways = () => false;

describe("acceptance: a live long-running job is never declared stale", () => {
  it("keeps a 50-minute-old lock active as long as it is heartbeating", () => {
    const info = {
      pid: 932,
      host: HOST,
      start_time: "2026-09-07T01:10:03.000Z",
      started_at: "2026-09-07T01:10:03.000Z",       // ~50 minutes old
      heartbeat_at: "2026-09-07T01:59:30.000Z",     // but beating 30s ago
      task_id: "WORKER-SELF-RECOVERY-20260907",
      phase: "dispatch",
      child_pid: 4242
    };
    const verdict = classifyLock(info, {
      nowMs: NOW, host: HOST, alive: aliveAlways, startTime: () => "2026-09-07T01:10:03.000Z"
    });
    expect(verdict.state).toBe("active");
  });

  it("refuses to acquire while a real owner is active", () => {
    writeFileSync(lockFile, JSON.stringify({
      pid: 932, host: HOST, started_at: new Date(NOW - 1000).toISOString(),
      heartbeat_at: new Date(NOW - 1000).toISOString(), phase: "dispatch"
    }), "utf8");

    const res = acquireLock(lockFile, { nowMs: NOW, host: HOST, alive: aliveAlways, startTime: () => null });
    expect(res.acquired).toBe(false);
    expect(res.verdict.state).toBe("active");
    // The active lock file must survive untouched.
    expect(JSON.parse(readFileSync(lockFile, "utf8")).pid).toBe(932);
  });

  it("flags an alive-but-silent owner for attention instead of killing it", () => {
    const info = {
      pid: 932, host: HOST,
      started_at: new Date(NOW - 3 * 3_600_000).toISOString(),
      heartbeat_at: new Date(NOW - DEFAULT_HEARTBEAT_TIMEOUT_MS - 60_000).toISOString()
    };
    const verdict = classifyLock(info, { nowMs: NOW, host: HOST, alive: aliveAlways, startTime: () => null });
    expect(verdict.state).toBe("stale_no_heartbeat");

    writeFileSync(lockFile, JSON.stringify(info), "utf8");
    const res = acquireLock(lockFile, { nowMs: NOW, host: HOST, alive: aliveAlways, startTime: () => null });
    expect(res.acquired).toBe(false);
    expect(res.needs_attention).toBe(true);
    // Critically: NOT cleared automatically.
    expect(existsSync(lockFile)).toBe(true);
  });
});

describe("acceptance: genuinely stale locks are reclaimed", () => {
  it("reclaims a lock whose owner process is gone", () => {
    writeFileSync(lockFile, JSON.stringify({
      pid: 4242, host: HOST, started_at: new Date(NOW - 60_000).toISOString(), heartbeat_at: new Date(NOW - 60_000).toISOString()
    }), "utf8");

    const verdict = classifyLock(readLock(lockFile), { nowMs: NOW, host: HOST, alive: deadAlways });
    expect(verdict.state).toBe("stale_dead");

    const res = acquireLock(lockFile, { nowMs: NOW, host: HOST, alive: deadAlways, startTime: () => null });
    expect(res.acquired).toBe(true);
    expect(readLock(lockFile).pid).toBe(process.pid);
  });

  it("detects pid reuse and does not trust a recycled pid", () => {
    const info = {
      pid: 932, host: HOST,
      start_time: "2026-09-07T01:10:03.000Z",
      started_at: "2026-09-07T01:10:03.000Z",
      heartbeat_at: new Date(NOW - 1000).toISOString()
    };
    const verdict = classifyLock(info, {
      nowMs: NOW, host: HOST, alive: aliveAlways,
      startTime: () => "2026-09-07T01:55:00.000Z" // different process, same pid
    });
    expect(verdict.state).toBe("stale_reused_pid");
  });

  it("never touches a lock taken on another host", () => {
    const info = { pid: 1, host: "SOME-OTHER-PC", started_at: new Date(NOW).toISOString(), heartbeat_at: new Date(NOW).toISOString() };
    const verdict = classifyLock(info, { nowMs: NOW, host: HOST, alive: aliveAlways });
    expect(verdict.state).toBe("foreign_host");

    writeFileSync(lockFile, JSON.stringify(info), "utf8");
    const res = acquireLock(lockFile, { nowMs: NOW, host: HOST, alive: aliveAlways });
    expect(res.acquired).toBe(false);
    expect(existsSync(lockFile)).toBe(true);
  });

  it("treats a malformed lock as reclaimable rather than deadlocking forever", () => {
    writeFileSync(lockFile, "{{{ not json", "utf8");
    expect(readLock(lockFile)).toEqual({ malformed: true });
    const res = acquireLock(lockFile, { nowMs: NOW, host: HOST, alive: deadAlways, startTime: () => null });
    expect(res.acquired).toBe(true);
  });
});

describe("acceptance: concurrent invocations dispatch once", () => {
  it("lets exactly one of two racing acquisitions win", () => {
    const first = acquireLock(lockFile, { nowMs: NOW, host: HOST, startTime: () => null });
    const second = acquireLock(lockFile, {
      nowMs: NOW, host: HOST,
      alive: aliveAlways,             // the first owner (this very process) is alive
      startTime: () => readLock(lockFile).start_time
    });
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.verdict.state).toBe("active");
  });

  it("releases only our own lock and leaves a foreign one alone", () => {
    acquireLock(lockFile, { nowMs: NOW, host: HOST, startTime: () => null });
    expect(releaseLock(lockFile)).toBe(true);
    expect(existsSync(lockFile)).toBe(false);

    writeFileSync(lockFile, JSON.stringify({ pid: process.pid + 12345, host: HOST }), "utf8");
    expect(releaseLock(lockFile)).toBe(false);
    expect(existsSync(lockFile)).toBe(true);
  });
});

describe("heartbeat", () => {
  it("records phase and child pid so progress is observable during a long run", () => {
    acquireLock(lockFile, { nowMs: NOW, host: HOST, startTime: () => null });
    expect(heartbeat(lockFile, { phase: "dispatch", taskId: "T-1", childPid: 777, nowMs: NOW + 60_000 })).toBe(true);

    const info = readLock(lockFile);
    expect(info.phase).toBe("dispatch");
    expect(info.child_pid).toBe(777);
    expect(info.task_id).toBe("T-1");
    expect(Date.parse(info.heartbeat_at)).toBe(NOW + 60_000);
  });

  it("refuses to heartbeat a lock owned by another process", () => {
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid + 999, host: HOST }), "utf8");
    expect(heartbeat(lockFile, { phase: "dispatch" })).toBe(false);
  });
});

describe("process liveness probe", () => {
  it("reports this process as alive and a bogus pid as dead", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(null)).toBe(false);
  });
});

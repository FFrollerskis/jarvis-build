/**
 * Single-worker lock (requirement C).
 *
 * The lock covers the WHOLE critical section - preflight, quarantine, dispatch
 * and every state write - not just the dispatch.
 *
 * The v1 lock decided staleness from `process.kill(pid, 0)` plus a wall-clock
 * age budget. Both are unsafe on their own:
 *   - a pid is reused after a reboot, so a live UNRELATED process can look like
 *     "our worker still running" (or vice versa);
 *   - a genuinely long, healthy Claude run trips a fixed age budget and gets
 *     declared stale while it is still working.
 *
 * This version binds the lock to process IDENTITY (pid + process start time +
 * host) and to a HEARTBEAT. A long-running child that is still heartbeating is
 * never stale, however long it runs. A dead owner is detected immediately,
 * without waiting out an age budget.
 */

import { existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";

/** How long a lock may go without a heartbeat before we consider the owner hung. */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15 * 60_000;

/**
 * Best-effort process start time, used to defeat pid reuse.
 * Returns null when unavailable - callers must then fall back to liveness only.
 */
export function readProcessStartTime(pid, runner = defaultStartTimeRunner) {
  try {
    return runner(pid);
  } catch {
    return null;
  }
}

function defaultStartTimeRunner(pid) {
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString("o") }`
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }
    ).trim();
    return out || null;
  }
  const out = execFileSync("ps", ["-o", "lstart=", "-p", String(Number(pid))], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000
  }).trim();
  return out || null;
}

export function isProcessAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user - alive, and
    // definitely not ours to touch.
    return err.code === "EPERM";
  }
}

/**
 * Classify an existing lock. Pure decision logic; probes are injected.
 *
 * Returns one of:
 *   active           - a real owner is running (possibly a long healthy job)
 *   stale_dead       - the owner process no longer exists
 *   stale_reused_pid - a process with that pid exists but is NOT our worker
 *   stale_no_heartbeat - owner alive but has not heartbeated within the budget
 *   foreign_host     - lock was taken on a different machine; never touched here
 *   malformed        - unreadable lock content
 */
export function classifyLock(info, {
  nowMs,
  host = hostname(),
  heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  alive = isProcessAlive,
  startTime = readProcessStartTime
} = {}) {
  if (!info || typeof info !== "object" || !Number.isInteger(info.pid)) {
    return { state: "malformed", reason: "lock file unreadable or missing pid" };
  }
  if (info.host && info.host !== host) {
    return { state: "foreign_host", reason: `lock owned by host ${info.host}` };
  }
  if (!alive(info.pid)) {
    return { state: "stale_dead", reason: `owner pid ${info.pid} is gone` };
  }
  // The pid exists. Confirm it is the SAME process that took the lock.
  if (info.start_time) {
    const current = startTime(info.pid);
    if (current && current !== info.start_time) {
      return { state: "stale_reused_pid", reason: `pid ${info.pid} was reused by a different process` };
    }
  }
  const beat = info.heartbeat_at ? new Date(info.heartbeat_at).getTime() : new Date(info.started_at ?? 0).getTime();
  if (Number.isFinite(beat) && nowMs - beat > heartbeatTimeoutMs) {
    return {
      state: "stale_no_heartbeat",
      reason: `owner pid ${info.pid} alive but last heartbeat ${new Date(beat).toISOString()} exceeds budget`
    };
  }
  return { state: "active", reason: `owner pid ${info.pid} is alive and heartbeating` };
}

export function readLock(lockFile) {
  if (!existsSync(lockFile)) return null;
  try {
    return JSON.parse(readFileSync(lockFile, "utf8"));
  } catch {
    return { malformed: true };
  }
}

/**
 * Acquire the lock, or refuse.
 *
 * A lock classified `active` or `foreign_host` is NEVER cleared - that is the
 * rule that stops a scheduled run from stomping on a live 50-minute Claude
 * session (and it is why this very task's own parent worker is safe).
 *
 * `stale_no_heartbeat` is deliberately NOT auto-cleared either: an alive owner
 * that stopped heartbeating may still be doing real work, so it is reported for
 * explicit handling rather than silently killed.
 */
export function acquireLock(lockFile, { taskId = null, phase = "startup", nowMs = Date.now(), ...opts } = {}) {
  const existing = readLock(lockFile);
  if (existing) {
    const verdict = classifyLock(existing.malformed ? null : existing, { nowMs, ...opts });
    if (verdict.state === "active" || verdict.state === "foreign_host") {
      return { acquired: false, verdict, owner: existing };
    }
    if (verdict.state === "stale_no_heartbeat") {
      return { acquired: false, verdict, owner: existing, needs_attention: true };
    }
    // stale_dead / stale_reused_pid / malformed -> safe to reclaim.
    try { unlinkSync(lockFile); } catch { /* raced with another reclaim */ }
  }

  const info = {
    pid: process.pid,
    host: hostname(),
    start_time: readProcessStartTime(process.pid),
    started_at: new Date(nowMs).toISOString(),
    heartbeat_at: new Date(nowMs).toISOString(),
    task_id: taskId,
    phase
  };
  try {
    mkdirSync(dirname(lockFile), { recursive: true });
    // "wx" fails atomically if another instance won the race in between.
    const fd = openSync(lockFile, "wx");
    closeSync(fd);
    writeFileSync(lockFile, JSON.stringify(info, null, 2), "utf8");
    return { acquired: true, info };
  } catch (err) {
    if (err.code === "EEXIST") {
      return { acquired: false, verdict: { state: "active", reason: "lost acquisition race" }, owner: readLock(lockFile) };
    }
    throw err;
  }
}

/** Refresh the heartbeat and record which phase we are in. Never throws. */
export function heartbeat(lockFile, { phase, taskId, childPid, nowMs = Date.now() } = {}) {
  try {
    const info = readLock(lockFile);
    if (!info || info.malformed || info.pid !== process.pid) return false;
    info.heartbeat_at = new Date(nowMs).toISOString();
    if (phase) info.phase = phase;
    if (taskId) info.task_id = taskId;
    if (childPid !== undefined) info.child_pid = childPid;
    writeFileSync(lockFile, JSON.stringify(info, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Release only OUR lock. A lock owned by anyone else is left strictly alone. */
export function releaseLock(lockFile) {
  try {
    const info = readLock(lockFile);
    if (info && !info.malformed && info.pid !== process.pid) return false;
    unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

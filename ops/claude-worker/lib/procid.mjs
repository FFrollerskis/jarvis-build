/**
 * Process IDENTITY, not process id.
 *
 * Blocker 1 of the D126 review: "Do not use PID-only orphan checks (PID reuse
 * causes permanent false block)." A bare pid is not an identity - after a reboot
 * or a wrap-around an unrelated process answers to it, and the worker would then
 * either refuse to run forever ("a Claude child is still alive") or, worse,
 * start a second Claude on top of a live one.
 *
 * An identity here is (pid, start_time, host). All three must match. When the
 * start time cannot be read at all, liveness is deliberately treated as
 * UNPROVEN rather than as either "alive" or "dead", and the caller applies a
 * bounded, evidence-based grace window instead of blocking permanently.
 */

import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

/** Identity confidence levels returned by `matchProcessIdentity`. */
export const IDENTITY = Object.freeze({
  MATCH: "match",           // same pid, same start time, same host - it IS ours
  GONE: "gone",             // no such process - it cannot be ours
  REUSED: "reused",         // pid exists but the start time differs - not ours
  FOREIGN_HOST: "foreign_host",
  UNPROVEN: "unproven"      // pid exists but the start time is unavailable
});

/**
 * Best-effort process start time, used to defeat pid reuse.
 * Returns null when unavailable - callers must then treat identity as UNPROVEN.
 */
export function readProcessStartTime(pid, runner = defaultStartTimeRunner) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return runner(pid) || null;
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
        `$ErrorActionPreference='Stop'; $p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString("o") }`
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
 * Capture the identity of a process we have just spawned (or of ourselves).
 * `start_time` may legitimately be null on a host where it cannot be read; the
 * caller records that fact rather than pretending the pid alone is an identity.
 */
export function captureIdentity(pid, {
  host = hostname(),
  startTime = readProcessStartTime,
  now = () => new Date()
} = {}) {
  return {
    pid: Number.isInteger(pid) ? pid : null,
    host,
    start_time: Number.isInteger(pid) ? startTime(pid) : null,
    observed_at: now().toISOString()
  };
}

/**
 * Compare a recorded identity against the live system.
 *
 * NEVER returns MATCH on a pid alone. If the recorded identity has no start
 * time, or the current start time cannot be read, the answer is UNPROVEN.
 */
export function matchProcessIdentity(identity, {
  host = hostname(),
  alive = isProcessAlive,
  startTime = readProcessStartTime
} = {}) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) {
    return { state: IDENTITY.GONE, reason: "no recorded pid" };
  }
  if (identity.host && identity.host !== host) {
    return { state: IDENTITY.FOREIGN_HOST, reason: `identity was recorded on host ${identity.host}, this is ${host}` };
  }
  if (!alive(identity.pid)) {
    return { state: IDENTITY.GONE, reason: `pid ${identity.pid} no longer exists` };
  }
  if (!identity.start_time) {
    return { state: IDENTITY.UNPROVEN, reason: `pid ${identity.pid} exists but no start time was recorded at spawn` };
  }
  const current = startTime(identity.pid);
  if (!current) {
    return { state: IDENTITY.UNPROVEN, reason: `pid ${identity.pid} exists but its start time cannot be read now` };
  }
  if (current !== identity.start_time) {
    return { state: IDENTITY.REUSED, reason: `pid ${identity.pid} was reused by a different process` };
  }
  return { state: IDENTITY.MATCH, reason: `pid ${identity.pid} is the same process that was recorded` };
}

/**
 * Direct children of `pid`, best effort, used ONLY for reporting and for
 * descendant accounting. Never used on its own to decide liveness.
 */
export function listChildPids(pid, runner = defaultChildRunner) {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  try {
    return runner(pid);
  } catch {
    return [];
  }
}

function defaultChildRunner(pid) {
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}" | ForEach-Object { $_.ProcessId }`
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }
    );
    return parsePidList(out);
  }
  const out = execFileSync("ps", ["-o", "pid=", "--ppid", String(Number(pid))], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 20_000
  });
  return parsePidList(out);
}

export function parsePidList(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Whole descendant tree of `pid` (excluding `pid` itself), bounded so a cycle or
 * a pathological host can never spin. Reported alongside a protected orphan so
 * the operator can see exactly what is still running.
 */
export function listDescendants(pid, { children = listChildPids, maxNodes = 200 } = {}) {
  const seen = new Set();
  const out = [];
  const queue = [pid];
  while (queue.length > 0 && out.length < maxNodes) {
    const current = queue.shift();
    for (const child of children(current)) {
      if (seen.has(child) || child === pid) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

export { hostname };

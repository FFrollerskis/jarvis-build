/**
 * Single-worker ownership lock (requirement C, D126 review blocker 2).
 *
 * The lock covers the WHOLE critical section - state load, preflight,
 * quarantine, dispatch and every state write - not just the dispatch.
 *
 * The v1 lock decided staleness from `process.kill(pid, 0)` plus a wall-clock
 * age budget. Both are unsafe on their own:
 *   - a pid is reused after a reboot, so a live UNRELATED process can look like
 *     "our worker still running" (or vice versa);
 *   - a genuinely long, healthy Claude run trips a fixed age budget and gets
 *     declared stale while it is still working.
 * v2 therefore binds the lock to process IDENTITY (pid + start time + host) and
 * to a HEARTBEAT.
 *
 * What the D126 review found in v2, and what changed here:
 *
 *   1. PUBLICATION WAS NOT ATOMIC. `acquireLock` created an EMPTY file with
 *      `wx`, closed the fd, and only then wrote the JSON. Between those two
 *      steps the lock on disk was a zero-byte file, which every other instance
 *      classifies as `malformed` and immediately unlinks. `heartbeat` truncated
 *      the same file in place and reopened the same window on every beat.
 *      Now: the full content is written to a private staging file, fsynced, and
 *      published with `link()`, which fails atomically with EEXIST if anyone
 *      else won. A heartbeat is published with an atomic `rename()` over the
 *      lock, so a reader never sees a partial document.
 *
 *   2. CONCURRENT RECLAIMERS COULD UNLINK EACH OTHER'S FRESH LOCKS. Reclaim was
 *      a bare `unlink()`. Now a reclaim is `rename()` to a private tombstone
 *      (exactly one racer can win) followed by a byte-comparison against the
 *      content that was actually classified. If the bytes changed, the lock we
 *      moved is NOT the one we judged, so it is put straight back and we lose
 *      the race instead of destroying a live owner's claim.
 *
 *   3. AN UNREADABLE LOCK WAS RECLAIMED INSTANTLY. Now a malformed lock must
 *      also be older than a short grace window before it may be reclaimed, so a
 *      lock caught mid-publication by a legacy writer is never stolen.
 *
 *   4. OWNERSHIP WAS "same pid". A pid is not proof after a reuse. Each holder
 *      now mints a random `owner_token`; heartbeat, release and every guarded
 *      state write require that exact token.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
  mkdirSync,
  renameSync,
  linkSync,
  statSync
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { readProcessStartTime, isProcessAlive } from "./procid.mjs";

/** How long a lock may go without a heartbeat before we consider the owner hung. */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15 * 60_000;

/**
 * How long an unreadable lock must have existed before it may be reclaimed.
 * Covers the publication window of any writer that is not link-atomic.
 */
export const MALFORMED_LOCK_GRACE_MS = 60_000;

export const LOCK_VERSION = 2;

export { readProcessStartTime, isProcessAlive };

/** ---------------- low-level, race-safe file primitives ---------------- */

function stagingPath(lockFile, tag) {
  return `${lockFile}.${tag}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

function writeDurable(path, contents) {
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Publish `contents` as the lock, failing if a lock already exists.
 *
 * `link()` is atomic and refuses to overwrite, so the file becomes visible only
 * once, already complete. On a filesystem without hard links we fall back to an
 * exclusive create and write through the SAME fd - still one open, and the
 * malformed grace window above covers the remaining sliver.
 */
export function publishExclusive(lockFile, contents) {
  const staging = stagingPath(lockFile, "staging");
  writeDurable(staging, contents);
  try {
    linkSync(staging, lockFile);
    return { ok: true, mode: "link" };
  } catch (err) {
    if (err.code === "EEXIST") return { ok: false, code: "EEXIST" };
    if (["EPERM", "ENOSYS", "EXDEV", "EMLINK", "EOPNOTSUPP", "EACCES"].includes(err.code)) {
      try {
        writeDurable(lockFile, contents);
        return { ok: true, mode: "exclusive_create" };
      } catch (fallbackErr) {
        if (fallbackErr.code === "EEXIST") return { ok: false, code: "EEXIST" };
        throw fallbackErr;
      }
    }
    throw err;
  } finally {
    try { unlinkSync(staging); } catch { /* best effort */ }
  }
}

/**
 * Remove a lock whose exact bytes we have already classified.
 *
 * Atomic single-winner: `rename` succeeds for exactly one racer. The moved file
 * is then compared byte for byte against what we judged; if it differs, another
 * process published a NEW lock between our read and our rename, so we restore it
 * and report a lost race. A lock we have not verified is never destroyed.
 */
export function removeVerified(lockFile, expectedRaw) {
  const tombstone = stagingPath(lockFile, "reclaimed");
  try {
    renameSync(lockFile, tombstone);
  } catch (err) {
    if (err.code === "ENOENT") return { ok: false, reason: "lock_already_gone" };
    throw err;
  }
  let actual = null;
  try {
    actual = readFileSync(tombstone, "utf8");
  } catch {
    // Unreadable: null can never equal the string we classified, so this
    // always takes the "changed under us" path below.
    actual = null;
  }
  if (actual !== expectedRaw) {
    let restored = false;
    try {
      linkSync(tombstone, lockFile);
      restored = true;
    } catch { /* someone published in the meantime; keep the tombstone as evidence */ }
    if (restored) {
      try { unlinkSync(tombstone); } catch { /* best effort */ }
    }
    return { ok: false, reason: "lock_changed_during_reclaim", evidence: restored ? null : tombstone };
  }
  try { unlinkSync(tombstone); } catch { /* best effort */ }
  return { ok: true };
}

/** ---------------- reading ---------------- */

/** Raw snapshot: exact bytes, mtime and parsed content. Used for race-safe decisions. */
export function readLockRaw(lockFile) {
  if (!existsSync(lockFile)) return null;
  let raw;
  try {
    raw = readFileSync(lockFile, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    return { malformed: true, raw: null, mtimeMs: null, read_error: err.code ?? err.message };
  }
  let mtimeMs = null;
  try {
    mtimeMs = statSync(lockFile).mtimeMs;
  } catch { /* file may have vanished; treated as unknown age */ }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { malformed: true, raw, mtimeMs };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { malformed: true, raw, mtimeMs };
  }
  return { malformed: false, raw, mtimeMs, info: parsed };
}

/** Parsed lock content, or `{ malformed: true }`, or null when there is no lock. */
export function readLock(lockFile) {
  const snap = readLockRaw(lockFile);
  if (!snap) return null;
  if (snap.malformed) return { malformed: true };
  return snap.info;
}

/** ---------------- classification ---------------- */

/**
 * Classify an existing lock. Pure decision logic; probes are injected.
 *
 * Returns one of:
 *   active             - a real owner is running (possibly a long healthy job)
 *   stale_dead         - the owner process no longer exists
 *   stale_reused_pid   - a process with that pid exists but is NOT our worker
 *   stale_no_heartbeat - owner alive but has not heartbeated within the budget
 *   foreign_host       - lock was taken on a different machine; never touched here
 *   unproven_identity  - owner pid is alive but its identity cannot be confirmed
 *   malformed          - unreadable lock content
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
  if (!info.host) {
    // A lock without a host binding cannot be reasoned about safely.
    return { state: "malformed", reason: "lock has no host binding" };
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
    if (!current) {
      return {
        state: "unproven_identity",
        reason: `owner pid ${info.pid} is alive but its start time cannot be read; refusing to guess`
      };
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

/** States that must never be cleared automatically by another instance. */
const NEVER_RECLAIM = Object.freeze(["active", "foreign_host", "unproven_identity"]);

/** ---------------- acquire / heartbeat / release ---------------- */

/**
 * Acquire the lock, or refuse.
 *
 * A lock classified `active`, `foreign_host` or `unproven_identity` is NEVER
 * cleared - that is the rule that stops a scheduled run from stomping on a live
 * 50-minute Claude session.
 *
 * `stale_no_heartbeat` is deliberately NOT auto-cleared either: an alive owner
 * that stopped heartbeating may still be doing real work, so it is reported for
 * explicit handling rather than silently killed.
 *
 * On success returns `{ acquired: true, info, token }`. The token is required
 * by `heartbeat`, `releaseLock` and `holdsLock`; a pid alone is never accepted
 * as proof of ownership.
 */
export function acquireLock(lockFile, {
  taskId = null,
  phase = "startup",
  nowMs = Date.now(),
  malformedGraceMs = MALFORMED_LOCK_GRACE_MS,
  ...opts
} = {}) {
  mkdirSync(dirname(lockFile), { recursive: true });

  const snapshot = readLockRaw(lockFile);
  if (snapshot) {
    const verdict = classifyLock(snapshot.malformed ? null : snapshot.info, { nowMs, ...opts });
    if (NEVER_RECLAIM.includes(verdict.state)) {
      return { acquired: false, verdict, owner: snapshot.malformed ? null : snapshot.info };
    }
    if (verdict.state === "stale_no_heartbeat") {
      return { acquired: false, verdict, owner: snapshot.info, needs_attention: true };
    }
    if (verdict.state === "malformed") {
      const age = snapshot.mtimeMs === null ? Number.POSITIVE_INFINITY : nowMs - snapshot.mtimeMs;
      if (age < malformedGraceMs) {
        return {
          acquired: false,
          verdict: {
            state: "publishing",
            reason: `lock file is unreadable but only ${Math.max(0, Math.round(age / 1000))}s old - another instance may be publishing it`
          },
          owner: null
        };
      }
    }
    // stale_dead / stale_reused_pid / aged-out malformed -> reclaimable, but
    // ONLY the exact bytes we classified.
    const reclaimed = removeVerified(lockFile, snapshot.raw);
    if (!reclaimed.ok) {
      return {
        acquired: false,
        verdict: { state: "lost_reclaim_race", reason: reclaimed.reason },
        owner: readLock(lockFile),
        evidence: reclaimed.evidence ?? null
      };
    }
  }

  const token = randomUUID();
  const info = {
    lock_version: LOCK_VERSION,
    pid: process.pid,
    host: hostname(),
    start_time: readProcessStartTime(process.pid),
    started_at: new Date(nowMs).toISOString(),
    heartbeat_at: new Date(nowMs).toISOString(),
    task_id: taskId,
    phase,
    owner_token: token
  };

  const published = publishExclusive(lockFile, JSON.stringify(info, null, 2));
  if (!published.ok) {
    return {
      acquired: false,
      verdict: { state: "active", reason: "lost acquisition race" },
      owner: readLock(lockFile)
    };
  }
  return { acquired: true, info, token };
}

/** Do we still hold this lock? Requires the exact token minted at acquisition. */
export function holdsLock(lockFile, token) {
  const snap = readLockRaw(lockFile);
  if (!snap || snap.malformed) return false;
  const info = snap.info;
  if (info.pid !== process.pid) return false;
  if (info.host !== hostname()) return false;
  if (!token || info.owner_token !== token) return false;
  return true;
}

/**
 * Refresh the heartbeat and record which phase we are in.
 *
 * Published with an atomic rename over the lock, so a concurrent reader can
 * never observe a truncated document. Never throws.
 */
export function heartbeat(lockFile, { token, phase, taskId, childPid, childIdentity, nowMs = Date.now() } = {}) {
  try {
    const snap = readLockRaw(lockFile);
    if (!snap || snap.malformed) return false;
    const info = snap.info;
    if (info.pid !== process.pid || info.host !== hostname()) return false;
    if (!token || info.owner_token !== token) return false;

    info.heartbeat_at = new Date(nowMs).toISOString();
    if (phase) info.phase = phase;
    if (taskId) info.task_id = taskId;
    if (childPid !== undefined) info.child_pid = childPid;
    if (childIdentity !== undefined) info.child_identity = childIdentity;

    const staging = stagingPath(lockFile, "beat");
    writeDurable(staging, JSON.stringify(info, null, 2));
    try {
      renameSync(staging, lockFile);
    } catch (err) {
      try { unlinkSync(staging); } catch { /* best effort */ }
      throw err;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Release only OUR lock, verified by token AND by the exact bytes on disk.
 * A lock owned by anyone else - or one that changed under us - is left alone.
 */
export function releaseLock(lockFile, token) {
  try {
    const snap = readLockRaw(lockFile);
    if (!snap) return false;
    if (snap.malformed) return false;
    const info = snap.info;
    if (info.pid !== process.pid || info.host !== hostname()) return false;
    if (!token || info.owner_token !== token) return false;
    return removeVerified(lockFile, snap.raw).ok;
  } catch {
    return false;
  }
}

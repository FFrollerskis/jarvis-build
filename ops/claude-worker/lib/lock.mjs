/**
 * Single-worker ownership lock, v3 - APPEND-ONLY CLAIM LEDGER.
 *
 * ---------------------------------------------------------------------------
 * WHY v2 WAS REPLACED RATHER THAN PATCHED
 * ---------------------------------------------------------------------------
 * v2 removed a lock with `removeVerified`: rename the CURRENT lock to a private
 * tombstone, THEN compare its bytes against the snapshot that had been
 * classified. That is not a compare-and-delete. It is a delete followed by an
 * audit, and the audit happens too late:
 *
 *   A classifies the lock as stale and stalls.
 *   B publishes a fresh lock and starts working.
 *   A resumes and renames B's live lock to a tombstone. The public path is now
 *     EMPTY even though B is alive and believes it owns the critical section.
 *   C acquires the empty path and also believes it owns the critical section.
 *   A finally compares bytes, sees a mismatch, and tries to restore - which
 *     fails with EEXIST because C is there. B is displaced, C is wrong, and the
 *     tombstone is only evidence of the damage.
 *
 * A tombstone is evidence, not mutual exclusion. v2's heartbeat had the same
 * shape: check the file, then rename over it, which can overwrite a replacement
 * that appeared after the check.
 *
 * ---------------------------------------------------------------------------
 * THE SERIALIZATION PRIMITIVE
 * ---------------------------------------------------------------------------
 * The only genuinely atomic, single-winner operations the filesystem gives us
 * are CREATE-IF-ABSENT (`link()`, `open(..., "wx")`, `mkdir()`). There is no
 * atomic compare-and-delete and no atomic compare-and-swap on a path. v3 is
 * therefore built exclusively on create-if-absent:
 *
 *   The lock is an APPEND-ONLY LEDGER directory `<lockFile>.d/` holding claim
 *   files named `<generation>.claim` (12-digit, zero padded). Generation
 *   numbers only ever increase.
 *
 *   OWNERSHIP  = "I created the highest-numbered claim file, and its content is
 *                 still mine and still `held`."
 *   ACQUISITION= append `<maxGeneration + 1>.claim` with create-if-absent.
 *                Exactly one process can win a given generation - the loser
 *                gets EEXIST from the kernel, not from a byte comparison.
 *   RECLAIM    = there is none. A stale claim is SUPERSEDED by a higher
 *                generation; it is never moved, emptied or deleted.
 *   RELEASE    = mark MY OWN claim `released` (atomic rename over my own path).
 *
 * THE INVARIANT THAT MAKES THIS SAFE:
 *
 *   No process ever renames, overwrites, truncates or unlinks a path it did not
 *   itself create with create-if-absent.
 *
 * Consequences:
 *   - A live owner's claim can never be moved out of the public path, not even
 *     for a microsecond, so there is no window in which the lock looks free.
 *   - A stale reclaimer's worst case is that it appends a generation that has
 *     already been superseded. It then observes that it is NOT the maximum and
 *     retracts by marking ONLY ITS OWN file released. Nobody else is touched.
 *   - The architect's schedule (classify -> stall -> live replacement -> resume)
 *     ends in EEXIST or in self-retraction. It cannot displace anyone. This is
 *     covered by `hooks.afterClassify` in the deterministic tests below.
 *
 * FAILURE AND RECOVERY SEMANTICS:
 *   - Holder crashes: its claim stays at the maximum with `state: "held"`. The
 *     next acquirer classifies it from process identity (pid + start time +
 *     host) and heartbeat age. Only when it is provably NOT live may it be
 *     superseded by generation+1. The crashed claim stays on disk as forensic
 *     evidence and is only ever removed later by a VERIFIED current holder's
 *     garbage collection of generations far below the maximum.
 *   - Unknown process identity, unreadable claim, or ANY filesystem error:
 *     fail closed. We refuse rather than guess. An unreadable maximum claim is
 *     never deleted; once past a grace window it is simply superseded, so a
 *     corrupt claim cannot deadlock the worker either.
 *   - Torn writes are impossible: a claim is written to a private staging file,
 *     fsynced, and then `link()`ed into place, so it is complete the first time
 *     it is visible. On a filesystem without hard links we fall back to an
 *     exclusive create written through the SAME fd, and the malformed grace
 *     window covers the remaining sliver.
 *   - LEGACY locks: a plain FILE at `<lockFile>` is a v1/v2 lock written by an
 *     older deployment. It is classified and honoured (we refuse while it looks
 *     live) but NEVER written to, moved or deleted - a v3 process must not
 *     re-introduce the very race it removed on behalf of an older peer.
 *
 * What v3 keeps from v2: identity-bound ownership (pid + start time + host),
 * per-holder `owner_token`, heartbeats, and the rule that `active`,
 * `foreign_host`, `unproven_identity` and `stale_no_heartbeat` are NEVER
 * cleared automatically.
 */

import {
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  linkSync,
  statSync
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { readProcessStartTime, isProcessAlive } from "./procid.mjs";

/** How long a lock may go without a heartbeat before we consider the owner hung. */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15 * 60_000;

/**
 * How long an unreadable claim must have existed before it may be superseded.
 * Covers the publication window of any writer that is not link-atomic.
 */
export const MALFORMED_LOCK_GRACE_MS = 60_000;

export const LOCK_VERSION = 3;

/** Generations far below the maximum that a verified holder may garbage collect. */
export const GENERATION_HISTORY_KEEP = 20;

/** Bounded retries when we lose a generation to another racer. Never unbounded. */
const MAX_ACQUIRE_ATTEMPTS = 8;

const CLAIM_RE = /^(\d{12})\.claim$/;
const GENERATION_WIDTH = 12;

export { readProcessStartTime, isProcessAlive };

/** ---------------- ledger paths ---------------- */

/** The append-only claim ledger for a lock path. */
export function ledgerDir(lockFile) {
  return `${lockFile}.d`;
}

function claimPath(dir, generation) {
  return join(dir, `${String(generation).padStart(GENERATION_WIDTH, "0")}.claim`);
}

function stagingPath(dir, tag) {
  return join(dir, `.${tag}-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
}

/** ---------------- low-level, single-winner primitives ---------------- */

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
 * CREATE-IF-ABSENT. The one primitive this module trusts.
 *
 * `link()` is atomic and refuses to overwrite, so the file becomes visible only
 * once and already complete. Exactly one caller can win a given path; every
 * other caller is rejected by the kernel with EEXIST.
 */
export function publishExclusive(targetPath, contents) {
  // Staging lives next to the target so `link()` stays within one filesystem.
  const staging = `${targetPath}.staging-${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
  writeDurable(staging, contents);
  try {
    linkSync(staging, targetPath);
    return { ok: true, mode: "link" };
  } catch (err) {
    if (err.code === "EEXIST") return { ok: false, code: "EEXIST" };
    if (["EPERM", "ENOSYS", "EXDEV", "EMLINK", "EOPNOTSUPP", "EACCES"].includes(err.code)) {
      try {
        writeDurable(targetPath, contents);
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
 * Atomically replace a claim file we created ourselves.
 *
 * This is the ONLY overwrite in the module and it is always applied to our own
 * generation, whose path no other process may write while we are alive. The
 * caller must have verified ownership immediately beforehand.
 */
function replaceOwnClaim(dir, generation, contents) {
  const staging = stagingPath(dir, "beat");
  writeDurable(staging, contents);
  const target = claimPath(dir, generation);
  for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt += 1) {
    try {
      renameSync(staging, target);
      return true;
    } catch (err) {
      if (!TRANSIENT_FS_ERRORS.includes(err.code) || attempt === TRANSIENT_RETRIES) {
        try { unlinkSync(staging); } catch { /* best effort */ }
        throw err;
      }
      backoff(attempt);
    }
  }
  return false;
}

/** ---------------- reading the ledger ---------------- */

/**
 * Errors that mean "the filesystem was busy", not "the data is bad".
 *
 * On Windows a rename over an open file, or a read of a file being renamed over,
 * fails transiently with EPERM/EACCES/EBUSY because libuv does not open regular
 * files with FILE_SHARE_DELETE. Treating that as "unreadable claim" would let a
 * challenger supersede a perfectly live owner, and treating it as "I lost the
 * lock" would abort a healthy 50-minute run. It is neither: it is a retry.
 */
const TRANSIENT_FS_ERRORS = Object.freeze(["EPERM", "EACCES", "EBUSY", "EMFILE", "ENFILE", "EAGAIN"]);
const TRANSIENT_RETRIES = 8;

const IO_SLEEPER = new Int32Array(new SharedArrayBuffer(4));
function backoff(attempt) {
  Atomics.wait(IO_SLEEPER, 0, 0, Math.min(1 + attempt, 8));
}

function readClaimFile(path) {
  let raw;
  let lastError = null;
  for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt += 1) {
    try {
      raw = readFileSync(path, "utf8");
      lastError = null;
      break;
    } catch (err) {
      if (err.code === "ENOENT") return null;
      lastError = err;
      if (!TRANSIENT_FS_ERRORS.includes(err.code)) break;
      backoff(attempt);
    }
  }
  if (lastError) {
    // Never "malformed enough to supersede": io_error means we do not KNOW.
    return { malformed: true, io_error: true, raw: null, mtimeMs: null, read_error: lastError.code ?? lastError.message };
  }
  let mtimeMs = null;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch { /* may have been GC'd; unknown age */ }
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

/**
 * Snapshot of the ledger: every generation present, and the maximum one.
 *
 * Read-only. Never repairs, never deletes. A directory listing that fails is
 * reported as an error rather than as "empty" (fail closed).
 */
export function scanLedger(lockFile) {
  const dir = ledgerDir(lockFile);
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") return { dir, exists: false, generations: [], maxGeneration: 0, claim: null };
    return { dir, exists: true, error: err.code ?? err.message, generations: [], maxGeneration: 0, claim: null };
  }
  const generations = [];
  for (const name of names) {
    const m = CLAIM_RE.exec(name);
    if (m) generations.push(Number(m[1]));
  }
  generations.sort((a, b) => a - b);
  if (generations.length === 0) {
    return { dir, exists: true, generations, maxGeneration: 0, claim: null };
  }
  const maxGeneration = generations[generations.length - 1];
  const file = readClaimFile(claimPath(dir, maxGeneration));
  if (file === null) {
    // Vanished between listing and reading. Only a verified holder's garbage
    // collection removes claims, and it never removes the maximum, so treat
    // this as a transient and report it as unknown rather than as "free".
    return { dir, exists: true, generations, maxGeneration, claim: null, vanished: true };
  }
  return { dir, exists: true, generations, maxGeneration, claim: { generation: maxGeneration, ...file } };
}

/** Is this claim a live ownership assertion (as opposed to a released one)? */
function isHeld(info) {
  return !!info && info.state !== "released";
}

/** ---------------- legacy (v1/v2) plain-file locks ---------------- */

/**
 * A plain file at `<lockFile>` was written by a pre-v3 deployment. We read and
 * honour it, and we never write, move or delete it.
 */
function readLegacyLock(lockFile) {
  let st;
  try {
    st = statSync(lockFile);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const file = readClaimFile(lockFile);
  if (!file) return null;
  return { legacy: true, ...file };
}

/** ---------------- public read API (shape preserved from v2) ---------------- */

/**
 * Raw snapshot of the CURRENT ownership claim: exact bytes, mtime and parsed
 * content, or null when nothing owns the lock.
 */
export function readLockRaw(lockFile) {
  const ledger = scanLedger(lockFile);
  if (ledger.error) {
    return { malformed: true, raw: null, mtimeMs: null, read_error: ledger.error };
  }
  if (ledger.vanished) {
    return { malformed: true, raw: null, mtimeMs: null, read_error: "claim vanished while reading the ledger" };
  }
  if (ledger.claim) {
    if (!ledger.claim.malformed && !isHeld(ledger.claim.info)) {
      // Highest claim is an explicit release: the lock is free.
      return readLegacyLock(lockFile);
    }
    return ledger.claim;
  }
  return readLegacyLock(lockFile);
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
 *   released           - the owner released it explicitly; the lock is free
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
  if (info.state === "released") {
    return { state: "released", reason: `generation ${info.generation ?? "?"} was released by its owner` };
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

/** States that must never be superseded automatically by another instance. */
const NEVER_SUPERSEDE = Object.freeze(["active", "foreign_host", "unproven_identity", "stale_no_heartbeat"]);

/** ---------------- acquire ---------------- */

function refusal(state, reason, extra = {}) {
  return { acquired: false, verdict: { state, reason }, owner: null, ...extra };
}

/**
 * Decide whether the current maximum claim may be superseded.
 * Returns `{ ok: true }` or a ready-made refusal.
 */
function judgeIncumbent(claim, { nowMs, malformedGraceMs, classifyOpts }) {
  if (claim.io_error) {
    // We could not READ the claim, which is not the same as the claim being
    // garbage. Fail closed: never supersede a claim we never saw.
    return refusal("unreadable", `claim ${claim.generation} could not be read (${claim.read_error}); refusing to supersede a claim we have not seen`);
  }
  if (claim.malformed) {
    const age = claim.mtimeMs === null ? Number.POSITIVE_INFINITY : nowMs - claim.mtimeMs;
    if (age < malformedGraceMs) {
      return refusal(
        "publishing",
        `claim ${claim.generation} is unreadable but only ${Math.max(0, Math.round(age / 1000))}s old - another instance may be publishing it`
      );
    }
    // Aged-out unreadable claim: superseded, never deleted.
    return { ok: true, verdict: { state: "malformed", reason: "unreadable claim older than the grace window" } };
  }
  const verdict = classifyLock(claim.info, { nowMs, ...classifyOpts });
  if (verdict.state === "released") return { ok: true, verdict };
  if (verdict.state === "stale_no_heartbeat") {
    return { acquired: false, verdict, owner: claim.info, needs_attention: true };
  }
  if (NEVER_SUPERSEDE.includes(verdict.state)) {
    return { acquired: false, verdict, owner: claim.info };
  }
  return { ok: true, verdict };
}

/**
 * Acquire the lock, or refuse.
 *
 * A claim classified `active`, `foreign_host`, `unproven_identity` or
 * `stale_no_heartbeat` is NEVER superseded - that is the rule that stops a
 * scheduled run from stomping on a live 50-minute Claude session, and the rule
 * that keeps an alive-but-silent owner from being silently discarded.
 *
 * On success returns `{ acquired: true, info, token, generation }`. The token is
 * required by `heartbeat`, `releaseLock` and `holdsLock`; a pid alone is never
 * accepted as proof of ownership.
 *
 * `hooks.afterClassify` exists so tests can stall a process at EXACTLY the point
 * v2 was unsafe - after classification, before mutation - and prove that a stale
 * reclaimer can no longer displace a live replacement owner. It is never set in
 * production.
 */
export function acquireLock(lockFile, {
  taskId = null,
  phase = "startup",
  nowMs = Date.now(),
  malformedGraceMs = MALFORMED_LOCK_GRACE_MS,
  maxAttempts = MAX_ACQUIRE_ATTEMPTS,
  hooks = {},
  collectGarbage = true,
  ...opts
} = {}) {
  const dir = ledgerDir(lockFile);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return refusal("filesystem_error", `cannot create the claim ledger ${dir}: ${err.code ?? err.message}`);
  }

  // A pre-v3 deployment's plain lock file is honoured but never touched.
  const legacy = readLegacyLock(lockFile);
  if (legacy?.io_error) {
    return refusal("unreadable", `the legacy v1/v2 lock file could not be read (${legacy.read_error}); refusing to guess whether a process owns it`, { legacy: true });
  }
  if (legacy) {
    const legacyVerdict = legacy.malformed
      ? { state: "malformed", reason: "legacy lock file is unreadable" }
      : classifyLock(legacy.info, { nowMs, ...opts });
    if (NEVER_SUPERSEDE.includes(legacyVerdict.state)) {
      return {
        acquired: false,
        verdict: { state: legacyVerdict.state, reason: `legacy v1/v2 lock file: ${legacyVerdict.reason}` },
        owner: legacy.malformed ? null : legacy.info,
        legacy: true,
        needs_attention: legacyVerdict.state === "stale_no_heartbeat" ? true : undefined
      };
    }
    if (legacyVerdict.state === "malformed") {
      const age = legacy.mtimeMs === null ? Number.POSITIVE_INFINITY : nowMs - legacy.mtimeMs;
      if (age < malformedGraceMs) {
        return refusal("publishing", "legacy v1/v2 lock file is unreadable and recent - another instance may be publishing it", { legacy: true });
      }
    }
    // Dead legacy artifact: ignored from here on, and deliberately left on disk.
  }

  let lastRefusal = refusal("lost_acquisition_race", "another instance won every generation we attempted");

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const ledger = scanLedger(lockFile);
    if (ledger.error) {
      return refusal("filesystem_error", `cannot read the claim ledger ${dir}: ${ledger.error}`);
    }
    if (ledger.vanished) {
      // Someone is mutating the ledger right now; re-read instead of guessing.
      lastRefusal = refusal("publishing", "the maximum claim vanished while reading the ledger");
      continue;
    }

    let incumbentVerdict = null;
    if (ledger.claim) {
      const judged = judgeIncumbent(ledger.claim, { nowMs, malformedGraceMs, classifyOpts: opts });
      if (!judged.ok) return judged;
      incumbentVerdict = judged.verdict;
    }

    // The exact interleaving point that v2 got wrong. Nothing has been mutated.
    if (typeof hooks.afterClassify === "function") hooks.afterClassify(ledger);

    const generation = ledger.maxGeneration + 1;
    const token = randomUUID();
    const info = {
      lock_version: LOCK_VERSION,
      generation,
      state: "held",
      pid: process.pid,
      host: hostname(),
      start_time: readProcessStartTime(process.pid),
      started_at: new Date(nowMs).toISOString(),
      heartbeat_at: new Date(nowMs).toISOString(),
      task_id: taskId,
      phase,
      owner_token: token,
      superseded: ledger.claim
        ? { generation: ledger.claim.generation, verdict: incumbentVerdict?.state ?? null }
        : null
    };

    let published;
    try {
      published = publishExclusive(claimPath(dir, generation), JSON.stringify(info, null, 2));
    } catch (err) {
      return refusal("filesystem_error", `cannot publish claim ${generation}: ${err.code ?? err.message}`);
    }
    if (!published.ok) {
      // Another process took this generation. We touched nothing. Re-read.
      lastRefusal = refusal("lost_acquisition_race", `generation ${generation} was taken by another instance`, {
        owner: readLock(lockFile)
      });
      continue;
    }

    // Post-publication confirmation. If we are no longer the maximum, someone
    // superseded us; we retract by marking ONLY OUR OWN claim released.
    const confirm = confirmOwnership(lockFile, generation, token, { nowMs, classifyOpts: opts });
    if (!confirm.ok) {
      retractOwnClaim(dir, generation, token, nowMs);
      lastRefusal = { acquired: false, verdict: confirm.verdict, owner: confirm.owner ?? null };
      if (confirm.terminal) return lastRefusal;
      continue;
    }

    if (collectGarbage) collectLedgerGarbage(lockFile, generation, token);

    return { acquired: true, info, token, generation };
  }

  return lastRefusal;
}

/**
 * Confirm that our generation is still the maximum and that the claim we
 * superseded has not turned out to be live after all.
 */
function confirmOwnership(lockFile, generation, token, { nowMs, classifyOpts }) {
  const ledger = scanLedger(lockFile);
  if (ledger.error) {
    return { ok: false, terminal: true, verdict: { state: "filesystem_error", reason: `cannot confirm ownership: ${ledger.error}` } };
  }
  if (ledger.maxGeneration > generation) {
    return {
      ok: false,
      verdict: { state: "superseded", reason: `generation ${ledger.maxGeneration} appeared after ours (${generation})` },
      owner: ledger.claim && !ledger.claim.malformed ? ledger.claim.info : null
    };
  }
  if (!ledger.claim || ledger.claim.malformed || ledger.claim.info.owner_token !== token) {
    return { ok: false, terminal: true, verdict: { state: "lost_acquisition_race", reason: "our claim is not the current maximum" } };
  }
  // Re-classify the claim we superseded, with fresh probes.
  const prev = generation - 1;
  if (ledger.generations.includes(prev)) {
    const prevClaim = readClaimFile(claimPath(ledger.dir, prev));
    if (prevClaim && !prevClaim.malformed) {
      const verdict = classifyLock(prevClaim.info, { nowMs, ...classifyOpts });
      if (NEVER_SUPERSEDE.includes(verdict.state)) {
        return {
          ok: false,
          terminal: true,
          verdict: { state: verdict.state, reason: `generation ${prev} is live after all: ${verdict.reason}` },
          owner: prevClaim.info
        };
      }
    }
  }
  return { ok: true };
}

/** Mark our own claim released. Touches no other path, ever. */
function retractOwnClaim(dir, generation, token, nowMs) {
  try {
    const current = readClaimFile(claimPath(dir, generation));
    if (!current || current.malformed || current.info.owner_token !== token) return false;
    const info = { ...current.info, state: "released", released_at: new Date(nowMs).toISOString(), release_reason: "retracted" };
    replaceOwnClaim(dir, generation, JSON.stringify(info, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Trim ancient generations. Only a VERIFIED current holder runs this, and it
 * only ever removes generations far BELOW its own, never the maximum. A stale
 * process that later appends one of those numbers immediately observes that it
 * is not the maximum and retracts, so removing history cannot grant ownership.
 */
export function collectLedgerGarbage(lockFile, generation, token, { keep = GENERATION_HISTORY_KEEP } = {}) {
  if (!holdsLock(lockFile, token)) return { removed: [] };
  const ledger = scanLedger(lockFile);
  if (ledger.error || ledger.maxGeneration !== generation) return { removed: [] };
  const cutoff = generation - keep;
  const removed = [];
  for (const gen of ledger.generations) {
    if (gen >= cutoff || gen === ledger.maxGeneration) continue;
    try {
      unlinkSync(claimPath(ledger.dir, gen));
      removed.push(gen);
    } catch { /* best effort; history is forensic, not load-bearing */ }
  }
  return { removed };
}

/** ---------------- ownership checks ---------------- */

/**
 * Do we still hold this lock? Requires the exact token minted at acquisition,
 * our own pid and host, `state: "held"`, AND that our claim is still the highest
 * generation. Fails closed on every error.
 */
export function holdsLock(lockFile, token) {
  try {
    const ledger = scanLedger(lockFile);
    if (ledger.error || ledger.vanished) return false;
    const claim = ledger.claim;
    if (!claim || claim.malformed) return false;
    const info = claim.info;
    if (!isHeld(info)) return false;
    if (info.pid !== process.pid) return false;
    if (info.host !== hostname()) return false;
    if (!token || info.owner_token !== token) return false;
    return true;
  } catch {
    return false;
  }
}

/** Our current generation, or null when we do not hold the lock. */
export function heldGeneration(lockFile, token) {
  if (!holdsLock(lockFile, token)) return null;
  return scanLedger(lockFile).maxGeneration;
}

/** ---------------- heartbeat / release ---------------- */

/**
 * Refresh the heartbeat and record which phase we are in.
 *
 * Ownership is verified first, and the write then targets OUR OWN generation
 * path - a path no other process may write while we are alive. v2's failure
 * mode (check the shared lock, then rename over whatever is there now) is
 * structurally impossible here: even a heartbeat issued by a process that has
 * just lost ownership can only rewrite its own superseded claim, which nobody
 * reads. Never throws.
 */
export function heartbeat(lockFile, { token, phase, taskId, childPid, childIdentity, nowMs = Date.now() } = {}) {
  try {
    const ledger = scanLedger(lockFile);
    if (ledger.error || ledger.vanished) return false;
    const claim = ledger.claim;
    if (!claim || claim.malformed) return false;
    const info = claim.info;
    if (!isHeld(info)) return false;
    if (info.pid !== process.pid || info.host !== hostname()) return false;
    if (!token || info.owner_token !== token) return false;

    const next = { ...info };
    next.heartbeat_at = new Date(nowMs).toISOString();
    if (phase) next.phase = phase;
    if (taskId) next.task_id = taskId;
    if (childPid !== undefined) next.child_pid = childPid;
    if (childIdentity !== undefined) next.child_identity = childIdentity;

    replaceOwnClaim(ledger.dir, claim.generation, JSON.stringify(next, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Release only OUR claim, verified by token, pid, host and maximum generation.
 * The claim is marked `released` in place - it is never unlinked here, so the
 * generation counter can never go backwards and no other process's path is
 * touched.
 */
export function releaseLock(lockFile, token, { nowMs = Date.now() } = {}) {
  try {
    const ledger = scanLedger(lockFile);
    if (ledger.error || ledger.vanished) return false;
    const claim = ledger.claim;
    if (!claim || claim.malformed) return false;
    const info = claim.info;
    if (!isHeld(info)) return false;
    if (info.pid !== process.pid || info.host !== hostname()) return false;
    if (!token || info.owner_token !== token) return false;

    const next = { ...info, state: "released", released_at: new Date(nowMs).toISOString() };
    replaceOwnClaim(ledger.dir, claim.generation, JSON.stringify(next, null, 2));
    return true;
  } catch {
    return false;
  }
}

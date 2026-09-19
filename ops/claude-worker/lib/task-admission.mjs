/**
 * CROSS-WORKER TASK ADMISSION (D-166).
 *
 * ---------------------------------------------------------------------------
 * THE HOLE THIS CLOSES
 * ---------------------------------------------------------------------------
 *
 * `lib/lock.mjs` makes exactly one WORKER INSTANCE run at a time - per lock
 * FILE. `lib/worktree.mjs` makes exactly one directory belong to a task. Neither
 * makes exactly one worker OWN A TASK_ID, because both are scoped to one
 * deployment's own paths:
 *
 *     worker A, root .../claude-worker      -> lockFile .../claude-worker/.worker.lock
 *     worker B, root .../claude-worker-2    -> lockFile .../claude-worker-2/.worker.lock
 *
 * Two roots, two lock files, two ledgers - and the kernel serialises nothing
 * between them, because they never touch the same path. Both read the SAME
 * control issue, both rank the SAME queue, both select the SAME TASK_ID, and
 * both dispatch a child that posts CLAUDE_ACK under that id.
 *
 * That is not a hypothetical. D-165 recorded it on the real control issue:
 *
 *     5706901949  CLAUDE_ACK     D165-...-20260917-A   01:12:27Z
 *     5706911174  CLAUDE_ACK     D165-...-20260917-A   01:13:41Z   <- second worker
 *     5706914372  CLAUDE_REPORT  D165-...-20260917-A   01:14:06Z
 *     5706934609  CLAUDE_REPORT  D165-...-20260917-A   01:16:46Z   <- second worker
 *
 * D-165 happened to be READ_ONLY, so the cost was two redundant reports. On a
 * WRITING order the same schedule is two children pushing, branching, commenting
 * and possibly merging against one order, each believing it is the only one.
 *
 * ---------------------------------------------------------------------------
 * THE KEY IS THE TASK, AND THE PATH IS SHARED
 * ---------------------------------------------------------------------------
 *
 * Mutual exclusion only exists where two processes contend for ONE path. So the
 * lease for a TASK_ID must live somewhere that does not depend on which
 * deployment root a worker was installed under. `admissionRootFor` derives it
 * from the CONTROL PLANE IDENTITY the contenders necessarily share - owner, repo
 * and control issue - under a host location that is outside every checkout.
 * Two workers racing for one order therefore race for one file, and the kernel
 * decides.
 *
 * ---------------------------------------------------------------------------
 * THE PRIMITIVE, AND WHY IT IS BORROWED RATHER THAN REINVENTED
 * ---------------------------------------------------------------------------
 *
 * The only atomic single-winner operation a filesystem offers is
 * CREATE-IF-ABSENT. `lock.mjs` already reduced that to one audited function,
 * `publishExclusive`, together with the append-only generation ledger that makes
 * "compare and swap" expressible without an atomic compare-and-swap:
 *
 *     CAS(observed version V) == create `<V+1>.lease` with create-if-absent.
 *
 * If the ledger moved after we read it, our create either loses to EEXIST or
 * lands below a newer maximum and is retracted by us as `void`. Either way the
 * winner is decided by the kernel, never by a byte comparison after the fact.
 * This module reuses that primitive verbatim instead of growing a second one.
 *
 * ---------------------------------------------------------------------------
 * LEASE STATES
 * ---------------------------------------------------------------------------
 *
 *   held      an owner is executing this TASK_ID right now.
 *   released  the owner finished its cycle WITHOUT the task reaching a terminal
 *             report. An explicit handoff: the next worker may admit the task.
 *   terminal  the task reached a terminal, trusted CLAUDE_REPORT. PERMANENT.
 *             This is the durable half of task-id dedupe: it survives a reboot,
 *             a lost state.json and a fresh deployment root, so a finished order
 *             cannot be dispatched a second time by a worker that has no memory
 *             of it.
 *   void      a speculative version its own author retracted after publication
 *             confirmation proved it never owned anything. TRANSPARENT - see
 *             lock.mjs for why collapsing this into `released` is a real defect
 *             and not a spelling choice.
 *
 * ---------------------------------------------------------------------------
 * TAKEOVER IS FAIL CLOSED, AND CROSS-HOST TAKEOVER DOES NOT EXIST
 * ---------------------------------------------------------------------------
 *
 * D-143 established that a timestamp written by another HOST's wall clock cannot
 * be measured against ours: a contender whose clock runs fast would "observe" a
 * perfectly healthy lease as expired and steal live work. That finding applies
 * here unchanged, so a lease held by another host is `HELD_FOREIGN_HOST` and is
 * never reclaimed, whatever its timestamps say. The admission root is host-local
 * by construction, so this is a guard against a shared/synced directory rather
 * than an ordinary path - which is exactly when you want it to hold.
 *
 * On THIS host, takeover requires ALL THREE of:
 *
 *   1. the owner is provably gone - its pid no longer exists, or it exists with a
 *      different start time (pid reuse, which is what a reboot produces);
 *   2. the lease has EXPLICITLY EXPIRED - `now > lease_expires_at_ms`, a
 *      timestamp written by a process on this host, so one clock throughout;
 *   3. a successful CAS against the EXACT version observed in (1) and (2).
 *
 * Every other state refuses. In particular an owner that is ALIVE is never
 * superseded - not when its lease has expired, not when its heartbeat is stale.
 * A live process doing authorised work outranks our bookkeeping, exactly as in
 * `lock.mjs`, and a hung owner is an operator's decision rather than a race.
 *
 * REBOOT DURABILITY falls out of this rather than being bolted on: the ledger is
 * an ordinary fsynced directory, so it is there after the reboot; the pid it
 * names is either absent (1) or answers with a different start time (1); and the
 * expiry it carries was written before the reboot, so it is long past (2). The
 * first contender after the reboot CASes once and becomes the single owner.
 *
 * NOTHING in this module deletes, truncates, renames or overwrites a path it did
 * not itself create with create-if-absent. A crashed owner's lease stays on disk
 * as evidence and is SUPERSEDED by a higher version, never removed.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { publishExclusive, readProcessStartTime, isProcessAlive } from "./lock.mjs";
import { isValidTaskId, writeFileDurable } from "./state.mjs";

export const ADMISSION_SCHEMA_VERSION = 1;

/** Lease states. See the header for why `void` is not `released`. */
export const LEASE_STATE = Object.freeze({
  HELD: "held",
  RELEASED: "released",
  TERMINAL: "terminal",
  VOID: "void"
});

/**
 * Admission verdicts. Exactly one of these is returned for every attempt, and
 * only `FREE` and `RECLAIMABLE` ever lead to a claim being published.
 */
export const ADMISSION = Object.freeze({
  /** Nothing owns this task id. */
  FREE: "free",
  /** Owner provably gone on this host AND the lease has expired. CAS may run. */
  RECLAIMABLE: "reclaimable_expired",
  /** We published the winning version. */
  ACQUIRED: "acquired",

  /** A live, identity-confirmed owner on this host. Never superseded. */
  HELD_ACTIVE: "held_active",
  /** Owned by another host. Never superseded, whatever its clock says (D-143). */
  HELD_FOREIGN_HOST: "held_foreign_host",
  /** Owner pid is alive but its identity cannot be confirmed. Refuse. */
  HELD_UNPROVEN_IDENTITY: "held_unproven_identity",
  /** Owner is gone but the lease has NOT expired yet. Refuse until it does. */
  HELD_NOT_EXPIRED: "held_not_expired",
  /** The task already reached a terminal report. Permanently closed. */
  TERMINAL: "terminal",

  /** Another contender took the version we tried. */
  LOST_RACE: "lost_acquisition_race",
  /** A lease that may be mid-publication. Refuse for now. */
  PUBLISHING: "publishing",
  /** Present but unreadable. Refuse; never supersede what we have not seen. */
  UNREADABLE: "unreadable",
  /** The ledger ancestry has a hole in it. Refuse rather than assume free. */
  UNRESOLVED: "unresolved_ancestry",
  /** The admission directory itself is unusable. Refuse. */
  FILESYSTEM_ERROR: "filesystem_error",
  /** The task id is not usable as a path component. Refuse. */
  UNSAFE_TASK_ID: "unsafe_task_id"
});

/** Verdicts that mean "another owner exists"; a loser must exit silently. */
export const CONTENDED_VERDICTS = Object.freeze([
  ADMISSION.HELD_ACTIVE,
  ADMISSION.HELD_FOREIGN_HOST,
  ADMISSION.HELD_UNPROVEN_IDENTITY,
  ADMISSION.HELD_NOT_EXPIRED,
  ADMISSION.LOST_RACE,
  ADMISSION.PUBLISHING
]);

/** Default lease budget. Matches the worker lock's heartbeat budget. */
export const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

/** How long an unreadable lease must have existed before it may be superseded. */
export const MALFORMED_LEASE_GRACE_MS = 60_000;

const LEASE_RE = /^(\d{12})\.lease$/;
const VERSION_WIDTH = 12;
const MAX_ACQUIRE_ATTEMPTS = 8;

/** ---------------- where the shared ledger lives ---------------- */

/**
 * A path component derived from the control-plane identity two contenders must
 * agree on if they are contending at all. Sanitised because it becomes a
 * directory name, and asserted rather than trusted: `repoOwner`/`repoName` are
 * already pattern-validated in config.mjs, and `controlIssue` is an integer.
 */
export function admissionScopeKey({ repoOwner, repoName, controlIssue }) {
  const safe = (v) => String(v ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe(repoOwner)}__${safe(repoName)}__issue${safe(controlIssue)}`;
}

/**
 * The shared admission root for a configuration.
 *
 * DELIBERATELY NOT under the worker's own root: that is precisely the scoping
 * mistake that let two deployments miss each other. It is host-local and outside
 * every checkout, and `loadWorkerConfig` asserts the latter rather than assuming
 * it. A host may override it with `admissionRoot` in config.json - two workers
 * that are meant to contend must then be given the SAME value, and one that is
 * deliberately isolated (a test rig) can be given its own.
 */
export function admissionRootFor(cfg, { home = homedir } = {}) {
  if (cfg?.admissionRoot) return resolve(cfg.admissionRoot);
  return join(home(), ".jarvis-worker-admission", admissionScopeKey(cfg ?? {}));
}

export function taskLedgerDir(admissionRoot, taskId) {
  if (!isValidTaskId(taskId)) {
    throw new Error(`refusing to derive an admission path from an unsafe TASK_ID: ${String(taskId).slice(0, 64)}`);
  }
  return join(admissionRoot, taskId);
}

function leasePath(dir, version) {
  return join(dir, `${String(version).padStart(VERSION_WIDTH, "0")}.lease`);
}

/** ---------------- reading ---------------- */

const TRANSIENT_FS_ERRORS = Object.freeze(["EPERM", "EACCES", "EBUSY", "EMFILE", "ENFILE", "EAGAIN"]);
const TRANSIENT_RETRIES = 8;
const IO_SLEEPER = new Int32Array(new SharedArrayBuffer(4));

function backoff(attempt) {
  Atomics.wait(IO_SLEEPER, 0, 0, Math.min(1 + attempt, 8));
}

function readLeaseFile(path) {
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
    // "I could not read it" is not evidence about its contents.
    return { malformed: true, io_error: true, mtimeMs: null, read_error: lastError.code ?? lastError.message };
  }
  let mtimeMs = null;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch { /* unknown age */ }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { malformed: true, mtimeMs };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { malformed: true, mtimeMs };
  }
  return { malformed: false, mtimeMs, info: parsed };
}

/**
 * Schema/semantic validation of a lease that already PARSED.
 *
 * Same reasoning as `validateClaimSchema` in lock.mjs: parsing as JSON and being
 * a lease are different questions, and a document that answers neither must be
 * judged under the SAME fail-closed grace policy rather than superseded on sight.
 */
export function validateLeaseSchema(info) {
  if (!info || typeof info !== "object" || Array.isArray(info)) return ["lease is not a JSON object"];
  const problems = [];
  if (typeof info.task_id !== "string" || info.task_id.trim() === "") {
    problems.push("task_id is missing or is not a non-empty string");
  }
  if (typeof info.host !== "string" || info.host.trim() === "") {
    problems.push("host binding is missing or is not a non-empty string");
  }
  if (typeof info.state !== "string" || !Object.values(LEASE_STATE).includes(info.state)) {
    problems.push(`state is missing or unknown (${String(info.state).slice(0, 24)})`);
  }
  if (typeof info.owner_token !== "string" || info.owner_token.trim() === "") {
    problems.push("owner_token is missing or is not a non-empty string");
  }
  if (!Number.isInteger(info.version) || info.version <= 0) {
    problems.push("version is missing or is not a positive integer");
  }
  // A lease that is HELD makes claims about a running process; one that is
  // released or terminal no longer does, so those fields are only required for
  // an ownership assertion.
  if (info.state === LEASE_STATE.HELD) {
    if (!Number.isInteger(info.pid) || info.pid <= 0) {
      problems.push("pid is missing or is not a positive integer on a held lease");
    }
    if (!Number.isFinite(Number(info.lease_expires_at_ms))) {
      problems.push("lease_expires_at_ms is missing or is not a finite number on a held lease");
    }
  }
  return problems;
}

function isWellFormed(info) {
  return validateLeaseSchema(info).length === 0;
}

/**
 * Resolve the EFFECTIVE lease: the highest version that is not void.
 *
 * Walks DOWN past void versions and stops at the first one that says something.
 * A missing version below a void one means the ancestry cannot be proven, which
 * is reported as unresolved and never as "free".
 */
function resolveEffectiveLease(dir, versions) {
  const voided = [];
  let expected = null;
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    const version = versions[i];
    if (expected !== null && version !== expected) {
      return { unresolved: true, missingVersion: expected, voided };
    }
    const file = readLeaseFile(leasePath(dir, version));
    if (file === null) return { unresolved: true, missingVersion: version, voided };
    if (!file.malformed && isWellFormed(file.info) && file.info.state === LEASE_STATE.VOID) {
      voided.push(version);
      expected = version - 1;
      continue;
    }
    return { lease: { version, ...file }, voided };
  }
  if (expected !== null && expected >= 1) {
    return { unresolved: true, missingVersion: expected, voided };
  }
  return { lease: null, voided };
}

/**
 * Snapshot of one task's lease ledger. Read-only: never repairs, never deletes.
 */
export function scanTaskLedger(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") return { dir, exists: false, versions: [], maxVersion: 0, lease: null };
    return { dir, exists: true, error: err.code ?? err.message, versions: [], maxVersion: 0, lease: null };
  }
  const versions = [];
  for (const name of names) {
    const m = LEASE_RE.exec(name);
    if (m) versions.push(Number(m[1]));
  }
  versions.sort((a, b) => a - b);
  if (versions.length === 0) return { dir, exists: true, versions, maxVersion: 0, lease: null };
  const maxVersion = versions[versions.length - 1];
  const resolved = resolveEffectiveLease(dir, versions);
  if (resolved.unresolved) {
    return {
      dir,
      exists: true,
      versions,
      maxVersion,
      lease: null,
      vanished: true,
      unresolvedVersion: resolved.missingVersion
    };
  }
  return { dir, exists: true, versions, maxVersion, lease: resolved.lease };
}

/** ---------------- classification ---------------- */

/**
 * Classify the effective lease. Pure decision logic; the process probes are
 * injected so a test can drive every branch deterministically.
 */
export function classifyLease(info, {
  nowMs,
  host = hostname(),
  alive = isProcessAlive,
  startTime = readProcessStartTime
} = {}) {
  const problems = validateLeaseSchema(info);
  if (problems.length > 0) {
    return { verdict: "malformed", reason: `lease does not satisfy the schema: ${problems.join("; ")}` };
  }
  if (info.state === LEASE_STATE.TERMINAL) {
    return {
      verdict: ADMISSION.TERMINAL,
      reason: `task already terminal (${info.terminal_outcome ?? "unknown outcome"}, `
        + `report comment ${info.terminal_report_comment_id ?? "unknown"}) at ${info.terminalized_at ?? "unknown time"}`
    };
  }
  if (info.state === LEASE_STATE.RELEASED) {
    return { verdict: ADMISSION.FREE, reason: `version ${info.version} was released by its owner` };
  }
  if (info.state === LEASE_STATE.VOID) {
    // Only reachable through a direct read; resolution never stops on a void.
    return { verdict: ADMISSION.FREE, reason: `version ${info.version} was retracted and never owned the task` };
  }

  // --- from here the lease asserts ownership ---

  if (info.host !== host) {
    // D-143: a foreign host's timestamps are not measurable against our clock,
    // so there is no honest expiry test to run. Fail closed, always.
    return {
      verdict: ADMISSION.HELD_FOREIGN_HOST,
      reason: `lease is held by host ${info.host}; a remote owner is never reclaimed from here`
    };
  }

  const ownerGone = !alive(info.pid);
  let reused = false;
  if (!ownerGone && info.start_time) {
    const current = startTime(info.pid);
    if (!current) {
      return {
        verdict: ADMISSION.HELD_UNPROVEN_IDENTITY,
        reason: `owner pid ${info.pid} is alive but its start time cannot be read; refusing to guess`
      };
    }
    reused = current !== info.start_time;
  }
  if (!ownerGone && !reused) {
    return {
      verdict: ADMISSION.HELD_ACTIVE,
      reason: `owner pid ${info.pid} is alive and is the same process that took the lease`
    };
  }

  // The owner is provably gone (dead, or its pid answers as a different
  // process). Takeover still requires an EXPLICIT expiry, measured against a
  // timestamp written on this host.
  const expiresAt = Number(info.lease_expires_at_ms);
  if (!(nowMs > expiresAt)) {
    return {
      verdict: ADMISSION.HELD_NOT_EXPIRED,
      reason: `owner pid ${info.pid} is ${reused ? "a reused pid" : "gone"}, but the lease does not expire until `
        + `${new Date(expiresAt).toISOString()} (in ${Math.max(0, Math.round((expiresAt - nowMs) / 1000))}s)`
    };
  }
  return {
    verdict: ADMISSION.RECLAIMABLE,
    reason: `owner pid ${info.pid} is ${reused ? "a reused pid" : "gone"} and the lease expired at `
      + `${new Date(expiresAt).toISOString()}`
  };
}

function refusal(verdict, reason, extra = {}) {
  return { acquired: false, verdict, reason, owner: null, ...extra };
}

/**
 * One fail-closed policy for every malformed lease, whether it failed to parse
 * or parsed into something that is not a lease. A FRESH one gets the publication
 * grace, because another contender may be halfway through writing it.
 */
function judgeMalformed(lease, { nowMs, malformedGraceMs, detail }) {
  const age = lease.mtimeMs === null ? Number.POSITIVE_INFINITY : nowMs - lease.mtimeMs;
  if (age < malformedGraceMs) {
    return refusal(
      ADMISSION.PUBLISHING,
      `lease version ${lease.version} is unreadable but only ${Math.max(0, Math.round(age / 1000))}s old`
      + ` - another worker may be publishing it${detail ? ` (${detail})` : ""}`
    );
  }
  return { ok: true, verdict: ADMISSION.FREE, reason: "malformed lease older than the publication grace window" };
}

function judgeIncumbent(lease, { nowMs, malformedGraceMs, classifyOpts }) {
  if (lease.io_error) {
    return refusal(
      ADMISSION.UNREADABLE,
      `lease version ${lease.version} could not be read (${lease.read_error}); refusing to supersede a lease we have not seen`
    );
  }
  if (lease.malformed) return judgeMalformed(lease, { nowMs, malformedGraceMs });
  const decision = classifyLease(lease.info, { nowMs, ...classifyOpts });
  if (decision.verdict === "malformed") {
    return judgeMalformed(lease, { nowMs, malformedGraceMs, detail: decision.reason });
  }
  if (decision.verdict === ADMISSION.FREE || decision.verdict === ADMISSION.RECLAIMABLE) {
    return { ok: true, verdict: decision.verdict, reason: decision.reason };
  }
  return { acquired: false, verdict: decision.verdict, reason: decision.reason, owner: lease.info };
}

/** ---------------- acquire ---------------- */

/**
 * Take the admission lease for `taskId`, or refuse.
 *
 * On success returns `{ acquired: true, handle }`, where the handle carries the
 * exact version and token every later mutation is verified against. A pid alone
 * is never accepted as proof of ownership.
 *
 * `hooks.afterClassify` lets a test stall a contender at exactly the unsafe
 * point - after classification, before publication - and prove that a stale
 * reclaimer still cannot displace a live owner. Never set in production.
 */
export function acquireTaskAdmission({
  admissionRoot,
  taskId,
  attemptId = randomUUID(),
  orderCommentId = null,
  workerRoot = null,
  workerVersion = null,
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  malformedGraceMs = MALFORMED_LEASE_GRACE_MS,
  maxAttempts = MAX_ACQUIRE_ATTEMPTS,
  nowMs = Date.now(),
  hooks = {},
  ...classifyOpts
}) {
  if (!isValidTaskId(taskId)) {
    return refusal(ADMISSION.UNSAFE_TASK_ID, `TASK_ID ${String(taskId).slice(0, 64)} is not usable as a path component`);
  }
  const dir = taskLedgerDir(admissionRoot, taskId);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return refusal(ADMISSION.FILESYSTEM_ERROR, `cannot create the admission ledger ${dir}: ${err.code ?? err.message}`);
  }

  let last = refusal(ADMISSION.LOST_RACE, "another worker won every version we attempted");

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const ledger = scanTaskLedger(dir);
    if (ledger.error) {
      return refusal(ADMISSION.FILESYSTEM_ERROR, `cannot read the admission ledger ${dir}: ${ledger.error}`);
    }
    if (ledger.vanished) {
      return refusal(
        ADMISSION.UNRESOLVED,
        `version ${ledger.unresolvedVersion} is missing, so the ledger ancestry cannot be resolved; `
        + "refusing to assume nothing owns this task"
      );
    }

    let incumbent = null;
    if (ledger.lease) {
      const judged = judgeIncumbent(ledger.lease, { nowMs, malformedGraceMs, classifyOpts });
      if (!judged.ok) return judged;
      incumbent = judged;
    }

    // The exact interleaving point a compare-then-write would get wrong.
    // Nothing has been mutated yet.
    if (typeof hooks.afterClassify === "function") hooks.afterClassify(ledger);

    // THE CAS: exactly `observed maximum + 1`, create-if-absent. If the ledger
    // moved since we read it, the kernel rejects us or the confirmation below
    // does.
    const version = ledger.maxVersion + 1;
    const token = randomUUID();
    const lease = {
      admission_schema_version: ADMISSION_SCHEMA_VERSION,
      version,
      state: LEASE_STATE.HELD,
      task_id: taskId,
      attempt_id: attemptId,
      order_comment_id: orderCommentId,
      owner_token: token,
      pid: process.pid,
      host: hostname(),
      start_time: readProcessStartTime(process.pid),
      worker_root: workerRoot,
      worker_version: workerVersion,
      acquired_at: new Date(nowMs).toISOString(),
      heartbeat_at: new Date(nowMs).toISOString(),
      lease_expires_at_ms: nowMs + leaseTtlMs,
      lease_ttl_ms: leaseTtlMs,
      phase: "admission",
      superseded: ledger.lease ? { version: ledger.lease.version, verdict: incumbent?.verdict ?? null } : null
    };

    let published;
    try {
      published = publishExclusive(leasePath(dir, version), JSON.stringify(lease, null, 2));
    } catch (err) {
      return refusal(ADMISSION.FILESYSTEM_ERROR, `cannot publish lease ${version}: ${err.code ?? err.message}`);
    }
    if (!published.ok) {
      // Another worker took this version. We touched nothing. Re-read.
      last = refusal(ADMISSION.LOST_RACE, `version ${version} was taken by another worker`);
      continue;
    }

    const confirmed = confirmAdmission(dir, version, token, { nowMs, malformedGraceMs, classifyOpts });
    if (!confirmed.ok) {
      retractOwnLease(dir, version, token, nowMs, confirmed.verdict);
      last = { acquired: false, verdict: confirmed.verdict, reason: confirmed.reason, owner: confirmed.owner ?? null };
      if (confirmed.terminal) return last;
      continue;
    }

    return {
      acquired: true,
      verdict: ADMISSION.ACQUIRED,
      reason: ledger.lease
        ? `took over from version ${ledger.lease.version} (${incumbent?.verdict}): ${incumbent?.reason}`
        : "no previous lease existed for this task id",
      handle: { dir, taskId, version, token, attemptId, leaseTtlMs, admissionRoot },
      lease
    };
  }

  return last;
}

/**
 * Confirm that our version is still the maximum and that the lease we superseded
 * has not turned out to be live after all. The predecessor re-probed is the
 * EFFECTIVE lease below us, not blindly `version - 1`.
 */
function confirmAdmission(dir, version, token, { nowMs, malformedGraceMs, classifyOpts }) {
  const ledger = scanTaskLedger(dir);
  if (ledger.error) {
    return { ok: false, terminal: true, verdict: ADMISSION.FILESYSTEM_ERROR, reason: `cannot confirm admission: ${ledger.error}` };
  }
  if (ledger.maxVersion > version) {
    return {
      ok: false,
      verdict: ADMISSION.LOST_RACE,
      reason: `version ${ledger.maxVersion} appeared after ours (${version})`,
      owner: ledger.lease && !ledger.lease.malformed ? ledger.lease.info : null
    };
  }
  if (!ledger.lease || ledger.lease.malformed || ledger.lease.info.owner_token !== token) {
    return { ok: false, terminal: true, verdict: ADMISSION.LOST_RACE, reason: "our lease is not the current maximum" };
  }
  const below = ledger.versions.filter((v) => v < version);
  const previous = resolveEffectiveLease(dir, below);
  if (previous.unresolved) {
    return {
      ok: false,
      terminal: true,
      verdict: ADMISSION.UNRESOLVED,
      reason: `version ${previous.missingVersion} is missing below ours (${version}); refusing to assume nothing owns it`
    };
  }
  if (previous.lease) {
    const judged = judgeIncumbent(previous.lease, { nowMs, malformedGraceMs, classifyOpts });
    if (!judged.ok) {
      return {
        ok: false,
        terminal: true,
        verdict: judged.verdict,
        reason: `version ${previous.lease.version} is live after all: ${judged.reason}`,
        owner: judged.owner ?? null
      };
    }
  }
  return { ok: true };
}

/**
 * Atomically replace a lease file WE created. This is the only overwrite in the
 * module and it always targets our own version, whose path no other process may
 * write while we are alive.
 */
function replaceOwnLease(dir, version, contents) {
  const staging = join(dir, `.swap-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  writeFileDurable(staging, contents);
  try {
    renameSync(staging, leasePath(dir, version));
    return true;
  } catch (err) {
    try { unlinkSync(staging); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Mark OUR OWN version void: it never owned the task, so it must not be mistaken
 * for a voluntary release and must not mask whatever lies below it.
 */
function retractOwnLease(dir, version, token, nowMs, reason) {
  try {
    const current = readLeaseFile(leasePath(dir, version));
    if (!current || current.malformed || current.info.owner_token !== token) return false;
    replaceOwnLease(dir, version, JSON.stringify({
      ...current.info,
      state: LEASE_STATE.VOID,
      voided_at: new Date(nowMs).toISOString(),
      void_reason: reason ?? "unconfirmed"
    }, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** ---------------- ownership, heartbeat, terminalisation ---------------- */

/** Do we still hold this lease? Requires the exact token, our pid and our host. */
export function holdsTaskAdmission(handle) {
  if (!handle?.dir || !handle?.token) return false;
  try {
    const ledger = scanTaskLedger(handle.dir);
    if (ledger.error || ledger.vanished || !ledger.lease || ledger.lease.malformed) return false;
    const info = ledger.lease.info;
    return info.state === LEASE_STATE.HELD
      && info.version === handle.version
      && info.owner_token === handle.token
      && info.pid === process.pid
      && info.host === hostname();
  } catch {
    return false;
  }
}

/**
 * Refresh the lease expiry. Ownership is verified first and the write targets
 * OUR OWN version, so a heartbeat issued by a process that has just lost the
 * lease can only rewrite its own superseded file, which nobody reads.
 */
export function heartbeatTaskAdmission(handle, { phase = null, nowMs = Date.now() } = {}) {
  try {
    if (!holdsTaskAdmission(handle)) return false;
    const current = readLeaseFile(leasePath(handle.dir, handle.version));
    if (!current || current.malformed || current.info.owner_token !== handle.token) return false;
    const next = { ...current.info, heartbeat_at: new Date(nowMs).toISOString(), lease_expires_at_ms: nowMs + handle.leaseTtlMs };
    if (phase) next.phase = phase;
    replaceOwnLease(handle.dir, handle.version, JSON.stringify(next, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand the task back. The cycle ended WITHOUT a terminal report, so the next
 * worker may admit it normally. Verified by token; never touches another path.
 */
export function releaseTaskAdmission(handle, { reason = "cycle_finished", nowMs = Date.now() } = {}) {
  try {
    if (!holdsTaskAdmission(handle)) return false;
    const current = readLeaseFile(leasePath(handle.dir, handle.version));
    if (!current || current.malformed || current.info.owner_token !== handle.token) return false;
    replaceOwnLease(handle.dir, handle.version, JSON.stringify({
      ...current.info,
      state: LEASE_STATE.RELEASED,
      released_at: new Date(nowMs).toISOString(),
      release_reason: reason
    }, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Close the task PERMANENTLY.
 *
 * This is the durable half of task-id dedupe. Once written, every later
 * admission attempt for this TASK_ID - from this worker, from another
 * deployment, after a reboot, after state.json is lost - is refused with
 * `ADMISSION.TERMINAL` and the evidence that closed it. The lease file is never
 * deleted, so the evidence outlives the worker that produced it.
 */
export function terminalizeTaskAdmission(handle, {
  outcome,
  status = null,
  reportCommentId = null,
  successful = null,
  nowMs = Date.now()
} = {}) {
  try {
    if (!holdsTaskAdmission(handle)) return false;
    const current = readLeaseFile(leasePath(handle.dir, handle.version));
    if (!current || current.malformed || current.info.owner_token !== handle.token) return false;
    replaceOwnLease(handle.dir, handle.version, JSON.stringify({
      ...current.info,
      state: LEASE_STATE.TERMINAL,
      terminalized_at: new Date(nowMs).toISOString(),
      terminal_outcome: outcome ?? null,
      terminal_status: status,
      terminal_successful: successful,
      terminal_report_comment_id: reportCommentId
    }, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** ---------------- read-only inspection (status / dry run) ---------------- */

/**
 * What does the admission ledger say about this task right now? Strictly
 * read-only - it creates nothing, so a dry run stays a dry run.
 */
export function inspectTaskAdmission({ admissionRoot, taskId, nowMs = Date.now(), ...classifyOpts }) {
  if (!isValidTaskId(taskId)) return { verdict: ADMISSION.UNSAFE_TASK_ID, reason: "unsafe task id", lease: null };
  const dir = taskLedgerDir(admissionRoot, taskId);
  const ledger = scanTaskLedger(dir);
  if (ledger.error) return { verdict: ADMISSION.FILESYSTEM_ERROR, reason: ledger.error, lease: null };
  if (ledger.vanished) return { verdict: ADMISSION.UNRESOLVED, reason: `version ${ledger.unresolvedVersion} is missing`, lease: null };
  if (!ledger.lease) return { verdict: ADMISSION.FREE, reason: "no lease has ever been taken for this task id", lease: null };
  if (ledger.lease.io_error) return { verdict: ADMISSION.UNREADABLE, reason: ledger.lease.read_error, lease: null };
  if (ledger.lease.malformed) return { verdict: ADMISSION.PUBLISHING, reason: "lease is unreadable", lease: null };
  const decision = classifyLease(ledger.lease.info, { nowMs, ...classifyOpts });
  return { verdict: decision.verdict, reason: decision.reason, lease: ledger.lease.info, version: ledger.lease.version };
}

/** Human-readable explanation of a refusal, for the log and the health journal. */
export function describeAdmissionRefusal(taskId, result) {
  const lines = [
    `TASK ADMISSION REFUSED for ${taskId}: ${result.verdict}`,
    `  ${result.reason}`
  ];
  if (result.owner) {
    lines.push(
      `  current owner: pid=${result.owner.pid} host=${result.owner.host} attempt=${result.owner.attempt_id ?? "?"} `
      + `phase=${result.owner.phase ?? "?"} acquired=${result.owner.acquired_at ?? "?"}`
    );
  }
  if (CONTENDED_VERDICTS.includes(result.verdict)) {
    lines.push(
      "  Another worker owns this TASK_ID. This process posts NO CLAUDE_ACK, NO report and NO status comment,",
      "  creates NO worktree and NO branch, and makes NO remote mutation for it."
    );
  }
  if (result.verdict === ADMISSION.TERMINAL) {
    lines.push(
      "  This TASK_ID already reached a terminal, trusted CLAUDE_REPORT. It is closed permanently and will",
      "  never be dispatched again. A changed scope needs a FRESH TASK_ID with an explicit SUPERSEDES."
    );
  }
  return lines;
}

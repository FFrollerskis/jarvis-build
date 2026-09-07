/**
 * Transactional, versioned deployment of the worker + supervisor (D126 review
 * blocker 4).
 *
 * What the reviewed install.ps1 actually did, and why each part is dangerous:
 *
 *   - it copied over the LIVE deployment file by file, so a failure halfway
 *     through left a mixture of old and new modules running against each other;
 *   - it DELETED run-worker-safe.ps1 while the registered scheduled task could
 *     still be pointing at it, i.e. it could remove the only entrypoint the
 *     scheduler knew about and leave no recovery path at all;
 *   - it checked the worker pid once, and never the supervisor or a scheduler
 *     start racing the copy;
 *   - install-task.ps1 / install-supervisor.ps1 UNREGISTERED the working task
 *     before the new registration could fail, so a denied registration
 *     destroyed a working schedule;
 *   - rollback restored only files that had existed before, leaving newly
 *     INTRODUCED modules and the new supervisor task active, and it never
 *     enforced the manifest's old hashes.
 *
 * The engine here is deliberately written in Node rather than PowerShell so the
 * whole switch/verify/rollback path can be exercised with real files and real
 * injected faults in CI on any OS. PowerShell keeps only what genuinely needs
 * it: scheduled-task registration.
 *
 * Guarantees:
 *   1. STAGE then ACTIVATE. Nothing in the live directory is touched until every
 *      payload byte has been staged and hash-verified.
 *   2. No transient missing entrypoint: each file is written beside its target
 *      and renamed over it. A target is never removed first.
 *   3. Quiescence: a live worker or supervisor lock defers activation instead of
 *      overwriting a running process. An installation launched BY the worker is
 *      therefore staged and handed off - the parent is never killed or replaced
 *      under itself.
 *   4. Any failure during the switch triggers an immediate rollback to the exact
 *      recorded OLD hashes, and files the install INTRODUCED are removed again.
 *   5. Obsolete files are removed only when no registered scheduled task still
 *      references them.
 *   6. Operational data (config.json, state.json, logs/, tmp/) is never in the
 *      payload and is never touched.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  statSync,
  openSync,
  fsyncSync,
  closeSync
} from "node:fs";
import { join, dirname, relative, sep } from "node:path";

import { readLockRaw, classifyLock } from "./lock.mjs";
import { matchProcessIdentity, IDENTITY } from "./procid.mjs";

export const DEPLOY_VERSION = 1;

/** Files this repository owns on the host. Anything not listed is never written. */
export const PAYLOAD = Object.freeze([
  "worker.mjs",
  "supervisor.mjs",
  "deploy.mjs",
  "run-worker.ps1",
  "run-supervisor.ps1",
  "install.ps1",
  "install-task.ps1",
  "install-supervisor.ps1",
  "uninstall-task.ps1",
  "rollback.ps1",
  "verify-scripts.ps1",
  "config.example.json",
  "supervisor.config.example.json",
  "README.md",
  "lib/health.mjs",
  "lib/state.mjs",
  "lib/lock.mjs",
  "lib/procid.mjs",
  "lib/quarantine.mjs",
  "lib/trust.mjs",
  "lib/reconcile.mjs",
  "lib/recovery.mjs",
  "lib/config.mjs",
  "lib/git.mjs",
  "lib/github.mjs",
  "lib/dispatch.mjs",
  "lib/statusjournal.mjs",
  "lib/supervise.mjs",
  "lib/wintask.mjs",
  "lib/deploy.mjs"
]);

/**
 * Superseded by the worker's own quarantine logic. Removed ONLY when no
 * registered task still points at it.
 */
export const OBSOLETE = Object.freeze(["run-worker-safe.ps1"]);

/** Never staged, never overwritten, never rolled back. */
export const OPERATIONAL_PATHS = Object.freeze([
  "config.json",
  "supervisor.config.json",
  "state.json",
  "state.json.bak",
  "supervisor-state.json",
  "supervisor-state.json.bak",
  "logs",
  "supervisor-logs",
  "tmp",
  "backups",
  "staging",
  "disabled.flag",
  "supervisor-disabled.flag"
]);

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256OrNull(path) {
  return existsSync(path) ? sha256(path) : null;
}

function writeDurable(target, buffer) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.abs(hashString(target))}`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, buffer);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

function hashString(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}

/** A path is operational (never touched) when its first segment is on the list. */
export function isOperationalPath(rel) {
  const head = String(rel ?? "").split(/[\\/]/)[0];
  return OPERATIONAL_PATHS.includes(head);
}

/** ---------------- planning ---------------- */

export function planPayload({ sourceDir, destination, payload = PAYLOAD }) {
  const entries = [];
  const missing = [];
  for (const rel of payload) {
    if (isOperationalPath(rel)) {
      throw new Error(`refusing to include an operational path in the payload: ${rel}`);
    }
    const src = join(sourceDir, rel);
    if (!existsSync(src)) {
      missing.push(rel);
      continue;
    }
    const dst = join(destination, rel);
    const srcHash = sha256(src);
    const dstHash = sha256OrNull(dst);
    entries.push({
      rel,
      srcHash,
      dstHash,
      introduced: dstHash === null,
      action: dstHash === null ? "create" : (dstHash === srcHash ? "unchanged" : "update")
    });
  }
  return { entries, missing, complete: missing.length === 0 };
}

/**
 * Decide whether an obsolete file may be removed.
 *
 * `taskCommandLines` is every registered scheduled task's Execute + Arguments +
 * WorkingDirectory, joined. If any of them mentions the file, removing it would
 * break a live schedule, so it is KEPT and reported.
 */
export function planObsolete({ destination, obsolete = OBSOLETE, taskCommandLines = [], taskQueryOk = true }) {
  return obsolete.map((rel) => {
    const dst = join(destination, rel);
    if (!existsSync(dst)) return { rel, action: "absent", reason: "not deployed" };
    if (!taskQueryOk) {
      return {
        rel,
        action: "keep",
        reason: "the registered scheduled tasks could not be queried; refusing to remove a possible live entrypoint"
      };
    }
    const referencedBy = taskCommandLines.filter((line) => String(line?.command ?? "").toLowerCase().includes(rel.toLowerCase()));
    if (referencedBy.length > 0) {
      return {
        rel,
        action: "keep",
        reason: `still referenced by registered task(s): ${referencedBy.map((r) => r.taskName).join(", ")}. `
          + "Re-register the task to the new entrypoint first; the installer never removes an entrypoint a scheduler still points at."
      };
    }
    return { rel, action: "remove", reason: "no registered task references it" };
  });
}

/** ---------------- quiescence ---------------- */

/**
 * Is it safe to modify the live deployment right now?
 *
 * A live worker (or supervisor) lock means NO. The installer never terminates
 * anything, so the answer is "stage it and hand off", never "overwrite it".
 */
export function assessQuiescence({ destination, lockFiles = [".worker.lock", ".supervisor.lock"], nowMs = Date.now() }) {
  const blockers = [];
  for (const rel of lockFiles) {
    const path = join(destination, rel);
    const snap = readLockRaw(path);
    if (!snap) continue;
    if (snap.malformed) {
      blockers.push({ lock: rel, state: "malformed", reason: "lock file is unreadable; refusing to guess whether a process is running" });
      continue;
    }
    const verdict = classifyLock(snap.info, { nowMs });
    // `malformed` is in this list for the same reason as the `snap.malformed`
    // branch above: a lock we cannot validate is not evidence that nothing is
    // running. Overwriting a live deployment on the strength of an unparseable
    // claim is exactly the outcome quiescence exists to prevent.
    if (["active", "unproven_identity", "stale_no_heartbeat", "foreign_host", "malformed"].includes(verdict.state)) {
      blockers.push({ lock: rel, state: verdict.state, pid: snap.info?.pid ?? null, reason: verdict.reason });
    }
  }
  return { quiet: blockers.length === 0, blockers };
}

/** ---------------- staging ---------------- */

export function stageRelease({ sourceDir, destination, payload = PAYLOAD, version, now = () => new Date() }) {
  const plan = planPayload({ sourceDir, destination, payload });
  if (!plan.complete) {
    throw new Error(`payload file(s) missing from the source: ${plan.missing.join(", ")}. Refusing a partial install.`);
  }
  const stagingDir = join(destination, "staging", version);
  mkdirSync(stagingDir, { recursive: true });

  const files = [];
  for (const entry of plan.entries) {
    const target = join(stagingDir, entry.rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceDir, entry.rel), target);
    const staged = sha256(target);
    if (staged !== entry.srcHash) {
      throw new Error(`hash mismatch while staging ${entry.rel} (source ${entry.srcHash}, staged ${staged})`);
    }
    files.push({ file: entry.rel, new_sha256: entry.srcHash, old_sha256: entry.dstHash, introduced: entry.introduced, action: entry.action });
  }

  const manifest = {
    deploy_version: DEPLOY_VERSION,
    version,
    staged_at_utc: now().toISOString(),
    source: sourceDir,
    destination,
    files
  };
  writeFileSync(join(stagingDir, "stage-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { stagingDir, manifest, plan };
}

/**
 * Record a pending activation so a LATER, quiescent run applies it.
 *
 * The marker on its own is NOT the handoff. Writing it proves only that
 * activation was refused safely; something still has to apply it, and that
 * something must not be assumed to be the newly staged runner (finding 3). The
 * marker is applied by whichever of these actually runs first:
 *   - `runBootstrapHandoff`, started by install.ps1 from the SOURCE tree at
 *     defer time. This is the one that works from a LEGACY deployment, because
 *     it does not require the staged run-worker.ps1 to be live;
 *   - `run-worker.ps1 -> deploy.mjs apply-pending`, which only helps once the
 *     new runner is already deployed;
 *   - a human running `deploy.mjs apply-pending` or `bootstrap-handoff`.
 * Until one of them succeeds the marker simply stays on disk; it is never lost.
 */
export function writePendingActivation({ destination, version, reason, now = () => new Date() }) {
  const path = join(destination, "pending-activation.json");
  writeFileSync(path, JSON.stringify({
    deploy_version: DEPLOY_VERSION,
    version,
    requested_at_utc: now().toISOString(),
    reason
  }, null, 2), "utf8");
  return path;
}

export function readPendingActivation(destination) {
  const path = join(destination, "pending-activation.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && typeof parsed.version === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function clearPendingActivation(destination) {
  const path = join(destination, "pending-activation.json");
  try { unlinkSync(path); return true; } catch { return false; }
}

/** ---------------- activation ---------------- */

/**
 * Switch the live deployment to a staged version, atomically per file, with a
 * verified backup and an automatic rollback on ANY failure.
 *
 * `hooks` exists purely so tests can inject a fault at each individual step and
 * prove the rollback path really restores the previous deployment.
 */
export function activateRelease({
  destination,
  version,
  taskCommandLines = [],
  taskQueryOk = true,
  exportTask = null,
  obsolete = OBSOLETE,
  hooks = {},
  now = () => new Date(),
  requireQuiescence = true
}) {
  const stagingDir = join(destination, "staging", version);
  const stageManifestPath = join(stagingDir, "stage-manifest.json");
  if (!existsSync(stageManifestPath)) {
    throw new Error(`no staged release ${version} at ${stagingDir}`);
  }
  const stageManifest = JSON.parse(readFileSync(stageManifestPath, "utf8"));

  // 1. verify every staged byte before touching anything live
  for (const f of stageManifest.files) {
    const staged = join(stagingDir, f.file);
    if (!existsSync(staged)) throw new Error(`staged file is missing: ${f.file}`);
    const actual = sha256(staged);
    if (actual !== f.new_sha256) {
      throw new Error(`staged file ${f.file} does not match its manifest hash (expected ${f.new_sha256}, got ${actual})`);
    }
  }

  // 2. quiescence - never overwrite a running worker or supervisor
  if (requireQuiescence) {
    const quiescence = assessQuiescence({ destination });
    if (!quiescence.quiet) {
      const reason = quiescence.blockers.map((b) => `${b.lock}: ${b.state} (${b.reason})`).join("; ");
      writePendingActivation({ destination, version, reason, now });
      return {
        ok: false,
        deferred: true,
        reason,
        detail:
          "Activation was DEFERRED, not forced. A live worker or supervisor still owns its lock, so the "
          + "deployment was left exactly as it is and a pending-activation marker was written. Nothing was "
          + "terminated and no file was overwritten. The marker is applied by the controlled bootstrap "
          + "handoff (deploy.mjs bootstrap-handoff), which install.ps1 starts from the SOURCE tree at this "
          + "point; it does NOT depend on the staged run-worker.ps1 already being the live entrypoint."
      };
    }
  }

  // 3. back up everything we are about to change, plus the task definitions
  const backupDir = join(destination, "backups", version);
  mkdirSync(backupDir, { recursive: true });

  const manifestFiles = [];
  for (const f of stageManifest.files) {
    const dst = join(destination, f.file);
    const record = {
      file: f.file,
      new_sha256: f.new_sha256,
      old_sha256: sha256OrNull(dst),
      introduced: !existsSync(dst),
      backed_up_to: null
    };
    if (existsSync(dst)) {
      const backupPath = join(backupDir, f.file);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(dst, backupPath);
      const verified = sha256(backupPath);
      if (verified !== record.old_sha256) {
        throw new Error(`backup of ${f.file} does not match the original (expected ${record.old_sha256}, got ${verified})`);
      }
      record.backed_up_to = backupPath;
    }
    manifestFiles.push(record);
  }

  const obsoletePlan = planObsolete({ destination, obsolete, taskCommandLines, taskQueryOk });
  const removedObsolete = [];
  for (const o of obsoletePlan) {
    if (o.action !== "remove") continue;
    const dst = join(destination, o.rel);
    const backupPath = join(backupDir, o.rel);
    mkdirSync(dirname(backupPath), { recursive: true });
    copyFileSync(dst, backupPath);
    removedObsolete.push({ file: o.rel, old_sha256: sha256(backupPath), backed_up_to: backupPath });
  }

  const backedUpTasks = [];
  if (typeof exportTask === "function") {
    for (const t of taskCommandLines) {
      const xml = exportTask(t.taskName);
      if (typeof xml === "string" && xml.trim()) {
        const xmlPath = join(backupDir, `${t.taskName}.task.xml`);
        writeFileSync(xmlPath, xml, "utf8");
        backedUpTasks.push({ name: t.taskName, xml_path: xmlPath });
      }
    }
  }

  const manifest = {
    deploy_version: DEPLOY_VERSION,
    version,
    installed_at_utc: now().toISOString(),
    source: stageManifest.source,
    destination,
    files: manifestFiles,
    removed_obsolete: removedObsolete,
    kept_obsolete: obsoletePlan.filter((o) => o.action === "keep"),
    backed_up_tasks: backedUpTasks,
    // Tasks this install introduces are recorded so a rollback can remove them
    // again instead of leaving a new schedule running against old code.
    introduced_tasks: [],
    // Durable INTENT records, written BEFORE any registration is attempted, so a
    // crash between "register" and "journal" can never hide a task from
    // rollback. See recordTaskIntent / reconcileTaskIntents.
    task_intents: []
  };
  const manifestPath = join(backupDir, "install-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  // 4. the switch. Rename-over only: a target is never deleted first, so there
  //    is no instant at which an entrypoint does not exist.
  const switched = [];
  try {
    hooks.beforeSwitch?.();
    for (let i = 0; i < stageManifest.files.length; i += 1) {
      const f = stageManifest.files[i];
      const src = join(stagingDir, f.file);
      const dst = join(destination, f.file);
      mkdirSync(dirname(dst), { recursive: true });
      const tmp = writeDurable(dst, readFileSync(src));
      renameSync(tmp, dst);
      const verified = sha256(dst);
      if (verified !== f.new_sha256) {
        throw new Error(`hash mismatch after installing ${f.file} (expected ${f.new_sha256}, got ${verified})`);
      }
      switched.push(f.file);
      hooks.afterFileSwitch?.(f.file, i);
    }

    for (const o of removedObsolete) {
      unlinkSync(join(destination, o.file));
    }
    hooks.afterObsoleteRemoval?.();
  } catch (err) {
    const restored = rollbackRelease({ destination, backupDir, reason: `activation failed: ${err.message}` });
    return {
      ok: false,
      deferred: false,
      error: err.message,
      rolled_back: restored.ok,
      rollback: restored,
      backupDir,
      manifestPath,
      detail:
        `The switch failed after ${switched.length} file(s) and the previous deployment was restored `
        + `from ${backupDir}, verified against the manifest's recorded old hashes.`
    };
  }

  return { ok: true, backupDir, manifestPath, manifest, switched, obsolete: obsoletePlan, stagingDir };
}

/** ---------------- controlled bootstrap handoff ---------------- */

/**
 * D126 FINAL review finding 3.
 *
 * The deferred-activation path was CIRCULAR. `install.ps1` stages the payload
 * and writes `pending-activation.json`; the new `run-worker.ps1` knows how to
 * apply that marker - but the new `run-worker.ps1` is exactly the file that has
 * not been installed yet. When the installation is launched by the currently
 * deployed OLD worker, quiescence correctly defers, and the next scheduler tick
 * then invokes the OLD registered entrypoint, which has never heard of
 * `pending-activation.json`. "The next scheduler tick applies it" is only true
 * if the already-deployed entrypoint supports the protocol, and host evidence
 * says it does not: the host still runs the old worker path.
 *
 * This is the non-circular half. It runs from the SOURCE tree, with the node
 * binary that is already on the host, and it is therefore runnable BEFORE the
 * payload is switched - it never depends on the staged runner being live. It:
 *
 *   1. captures the EXACT identity (pid + start time + host) of every process
 *      that currently blocks quiescence, ONCE, at install time;
 *   2. waits for precisely those identities to exit - never a pid on its own,
 *      and never treating "cannot tell" as "has exited";
 *   3. re-checks worker AND supervisor quiescence afterwards, so a NEW owner
 *      that started meanwhile defers the handoff again instead of being
 *      overwritten;
 *   4. only then activates, transactionally, through the same
 *      `activateRelease` that verifies staged hashes, backs up, renames over
 *      (never deletes first) and rolls back on any failure.
 *
 * It NEVER terminates anything, never overwrites a live parent, never touches
 * scheduled-task registration, credentials or principal, and never requires the
 * newly staged runner to already be active. On any refusal the
 * pending-activation marker is left exactly where it is, so the handoff can be
 * retried instead of being lost.
 */

/**
 * Capture, once, the exact identity of everything that currently blocks
 * activation. `null` start times are recorded as such rather than invented.
 */
export function captureQuiescenceOwners({ destination, lockFiles = [".worker.lock", ".supervisor.lock"], nowMs = Date.now() }) {
  const owners = [];
  const unreadable = [];
  for (const rel of lockFiles) {
    const snap = readLockRaw(join(destination, rel));
    if (!snap) continue;
    if (snap.malformed) {
      unreadable.push({ lock: rel, reason: snap.read_error ?? "unreadable lock content" });
      continue;
    }
    const verdict = classifyLock(snap.info, { nowMs });
    if (!["active", "unproven_identity", "stale_no_heartbeat", "foreign_host"].includes(verdict.state)) continue;
    owners.push({
      lock: rel,
      state: verdict.state,
      identity: {
        pid: snap.info.pid ?? null,
        host: snap.info.host ?? null,
        start_time: snap.info.start_time ?? null
      },
      task_id: snap.info.task_id ?? null
    });
  }
  return { owners, unreadable };
}

/** Has this exact recorded identity stopped running? Never pid-only. */
function ownerHasExited(owner, matchIdentity) {
  let verdict;
  try {
    verdict = matchIdentity(owner.identity);
  } catch (err) {
    return { exited: false, state: "probe_failed", reason: err.message };
  }
  // GONE  - the process does not exist any more.
  // REUSED- the pid belongs to a different process, so ours is finished.
  // MATCH / UNPROVEN / FOREIGN_HOST are all "not proven to have exited", and
  // UNPROVEN in particular must never be read as permission to proceed.
  return {
    exited: verdict.state === IDENTITY.GONE || verdict.state === IDENTITY.REUSED,
    state: verdict.state,
    reason: verdict.reason
  };
}

/**
 * Run the handoff. Synchronous by design: it is a standalone process whose only
 * job is to wait and then activate, and a blocking poll is the simplest thing
 * that cannot leave a half-finished activation behind if the event loop dies.
 *
 * `hooks` injects a fault at each individual step so tests can prove that a
 * failure before OR after every step still leaves a rollback-complete
 * deployment with no missing entrypoint.
 */
export function runBootstrapHandoff({
  destination,
  version = null,
  owners = null,
  waitDeadlineMs = 30 * 60_000,
  pollIntervalMs = 2_000,
  matchIdentity = matchProcessIdentity,
  sleep = defaultSleep,
  now = () => new Date(),
  clock = () => Date.now(),
  hooks = {},
  activate = activateRelease,
  taskCommandLines = [],
  taskQueryOk = true,
  exportTask = null
}) {
  const startedAt = clock();
  const pending = readPendingActivation(destination);
  const target = version ?? pending?.version ?? null;
  if (!target) {
    return { ok: false, activated: false, deferred: false, reason: "no pending activation and no --version was given" };
  }

  // The identities we wait for are captured ONCE. Re-deriving them later would
  // mean a brand new owner could reset the wait indefinitely, and worse, could
  // silently redefine "the legitimate parent" to be some other process.
  const captured = owners ?? captureQuiescenceOwners({ destination }).owners;

  hooks.beforeWait?.();

  const waited = [];
  for (const owner of captured) {
    let last = ownerHasExited(owner, matchIdentity);
    while (!last.exited) {
      if (clock() - startedAt >= waitDeadlineMs) {
        // Give up WITHOUT activating. The marker stays, so a later run - or a
        // human - can complete the handoff. Nothing is terminated.
        return {
          ok: false,
          activated: false,
          deferred: true,
          reason: `the legitimate parent for ${owner.lock} (pid ${owner.identity.pid}) had not exited within the wait budget`
            + ` (last verdict: ${last.state} - ${last.reason}). Nothing was activated and nothing was terminated.`,
          version: target,
          parents: captured,
          waited_ms: clock() - startedAt
        };
      }
      sleep(pollIntervalMs);
      last = ownerHasExited(owner, matchIdentity);
    }
    waited.push({ lock: owner.lock, pid: owner.identity.pid, exit_state: last.state });
  }

  hooks.afterParentExit?.();

  // A new owner may have started while we waited. Re-check BOTH locks before
  // touching anything; deferring again is always safe, overwriting never is.
  const quiescence = assessQuiescence({ destination });
  if (!quiescence.quiet) {
    return {
      ok: false,
      activated: false,
      deferred: true,
      reason: "a worker or supervisor became active again while the handoff was waiting: "
        + quiescence.blockers.map((b) => `${b.lock}: ${b.state} (${b.reason})`).join("; ")
        + ". The pending-activation marker was left in place and nothing was overwritten.",
      version: target,
      parents: captured,
      waited,
      quiescence,
      waited_ms: clock() - startedAt
    };
  }

  hooks.beforeActivate?.();

  let result;
  try {
    result = activate({
      destination,
      version: target,
      taskCommandLines,
      taskQueryOk,
      exportTask,
      now,
      // Belt and braces: activateRelease re-checks quiescence itself, so even a
      // process that starts between the check above and the switch defers.
      requireQuiescence: true,
      hooks
    });
  } catch (err) {
    return {
      ok: false, activated: false, deferred: false,
      reason: `activation threw: ${err.message}. The pending-activation marker was left in place.`,
      version: target, parents: captured, waited, waited_ms: clock() - startedAt
    };
  }

  hooks.afterActivate?.();

  if (!result.ok) {
    // Deferred or failed-and-rolled-back. Either way the marker stays so the
    // handoff is retryable rather than silently lost.
    return {
      ok: false,
      activated: false,
      deferred: result.deferred === true,
      reason: result.reason ?? result.error ?? "activation did not succeed",
      rolled_back: result.rolled_back ?? false,
      rollback: result.rollback ?? null,
      version: target, parents: captured, waited, waited_ms: clock() - startedAt
    };
  }

  clearPendingActivation(destination);
  return {
    ok: true,
    activated: true,
    deferred: false,
    version: target,
    parents: captured,
    waited,
    switched: result.switched,
    backupDir: result.backupDir,
    manifestPath: result.manifestPath,
    waited_ms: clock() - startedAt
  };
}

/** Blocking sleep: this process has nothing else to do, and must not race. */
function defaultSleep(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, Math.max(1, ms));
}

/** ---------------- rollback ---------------- */

/**
 * Restore the deployment recorded in `backupDir/install-manifest.json`.
 *
 * Unlike the reviewed rollback.ps1 this:
 *   - ENFORCES the manifest's `old_sha256` for every restored file,
 *   - REMOVES files the install introduced, so a failed upgrade does not leave
 *     new modules behind for old code to import,
 *   - reports the tasks the install introduced so the caller can unregister
 *     them,
 *   - restores obsolete files the install removed,
 *   - and touches no operational data at all.
 */
export function rollbackRelease({ destination, backupDir, reason = "manual rollback" }) {
  const manifestPath = join(backupDir, "install-manifest.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, error: `no install-manifest.json in ${backupDir}; refusing to guess what to restore` };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const restored = [];
  const removed = [];
  const failures = [];

  for (const f of manifest.files ?? []) {
    if (isOperationalPath(f.file)) {
      failures.push(`${f.file}: refused, operational data is never rolled back`);
      continue;
    }
    const dst = join(destination, f.file);
    if (f.introduced || f.old_sha256 === null) {
      // The install created this file. Rolling back means it must go away again.
      try {
        if (existsSync(dst)) unlinkSync(dst);
        removed.push(f.file);
      } catch (err) {
        failures.push(`${f.file}: could not remove introduced file (${err.message})`);
      }
      continue;
    }
    if (!f.backed_up_to || !existsSync(f.backed_up_to)) {
      failures.push(`${f.file}: backup copy is missing (${f.backed_up_to ?? "not recorded"})`);
      continue;
    }
    try {
      mkdirSync(dirname(dst), { recursive: true });
      const tmp = writeDurable(dst, readFileSync(f.backed_up_to));
      renameSync(tmp, dst);
      const verified = sha256(dst);
      if (verified !== f.old_sha256) {
        failures.push(`${f.file}: restored bytes do not match the manifest's old hash (expected ${f.old_sha256}, got ${verified})`);
        continue;
      }
      restored.push(f.file);
    } catch (err) {
      failures.push(`${f.file}: ${err.message}`);
    }
  }

  for (const o of manifest.removed_obsolete ?? []) {
    const dst = join(destination, o.file);
    try {
      const tmp = writeDurable(dst, readFileSync(o.backed_up_to));
      renameSync(tmp, dst);
      const verified = sha256(dst);
      if (verified !== o.old_sha256) {
        failures.push(`${o.file}: restored obsolete file does not match its recorded hash`);
        continue;
      }
      restored.push(o.file);
    } catch (err) {
      failures.push(`${o.file}: ${err.message}`);
    }
  }

  return {
    ok: failures.length === 0,
    reason,
    restored,
    removed_introduced_files: removed,
    // The caller unregisters these; this module never touches Task Scheduler.
    // Unconfirmed intents are included: a task that was never created is
    // harmless to unregister, one left behind is not.
    tasks_to_unregister: tasksToUnregister(manifest),
    unconfirmed_task_intents: (manifest.task_intents ?? []).filter((i) => i.state === "intended"),
    tasks_to_reimport: manifest.backed_up_tasks ?? [],
    failures
  };
}

/**
 * Record that this install INTRODUCED a scheduled task that did not exist
 * before, so a rollback can unregister it again.
 *
 * The task scripts call this after a successful first-time registration. Without
 * it, rolling back the files would leave a brand-new schedule running against
 * the restored older code - which is exactly the gap the D126 review named
 * ("rollback ... leaves the newly added supervisor task/modules active").
 */
export function recordIntroducedTask({ destination, taskName, backupDir = null }) {
  const dir = backupDir ?? latestBackupDir(destination);
  if (!dir) return { ok: false, error: "no install manifest to record against" };
  const manifestPath = join(dir, "install-manifest.json");
  if (!existsSync(manifestPath)) return { ok: false, error: `no install-manifest.json in ${dir}` };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const tasks = new Set(manifest.introduced_tasks ?? []);
  if (tasks.has(taskName)) return { ok: true, alreadyRecorded: true, manifestPath };
  tasks.add(taskName);
  manifest.introduced_tasks = [...tasks];
  writeManifest(manifestPath, manifest);
  return { ok: true, alreadyRecorded: false, manifestPath, introduced_tasks: manifest.introduced_tasks };
}

/** ---------------- durable task-registration intent ---------------- */

/**
 * The D126 review's remaining deployment obligation.
 *
 * The old order was: register the task, THEN journal it, and only WARN if the
 * journalling failed. A crash - or a denied write - in that window left a task
 * registered on the host that no rollback history knew about, so a rollback
 * restored the old files and left a brand-new schedule pointing at them.
 *
 * The order is now INTENT -> EFFECT -> CONFIRMATION:
 *
 *   1. `recordTaskIntent` writes a durable `intended` record BEFORE anything is
 *      registered, and FAILS the install if it cannot be written. Nothing is
 *      registered unless the rollback history already knows it might be.
 *   2. The installer registers the task.
 *   3. `confirmTaskIntent` records the observed outcome. This step is allowed to
 *      fail, because step 1 already made the rollback safe.
 *   4. `reconcileTaskIntents` resolves any intent still in `intended` from the
 *      HOST's actual answer, so a crash in the window is repaired from evidence
 *      rather than assumed either way.
 *
 * `rollbackRelease` treats an unconfirmed intent for a task that did NOT exist
 * before as something to unregister: unregistering a task that was never
 * created is harmless, leaving one behind is not.
 */
export function recordTaskIntent({ destination, taskName, preExisting, backupDir = null, now = () => new Date() }) {
  const dir = backupDir ?? latestBackupDir(destination);
  if (!dir) return { ok: false, error: "no install manifest to record the intent against" };
  const manifestPath = join(dir, "install-manifest.json");
  if (!existsSync(manifestPath)) return { ok: false, error: `no install-manifest.json in ${dir}` };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { ok: false, error: `install-manifest.json in ${dir} is unreadable: ${err.message}` };
  }
  const intents = manifest.task_intents ?? [];
  const existing = intents.find((i) => i.task === taskName);
  const record = {
    task: taskName,
    pre_existing: preExisting === true,
    state: "intended",
    intended_at_utc: now().toISOString(),
    confirmed_at_utc: null,
    outcome: null
  };
  if (existing) Object.assign(existing, record);
  else intents.push(record);
  manifest.task_intents = intents;
  try {
    writeManifest(manifestPath, manifest);
  } catch (err) {
    return { ok: false, error: `could not durably record the intent: ${err.message}` };
  }
  return { ok: true, manifestPath, intent: record };
}

/** Record the observed outcome of a registration whose intent is already durable. */
export function confirmTaskIntent({ destination, taskName, outcome, backupDir = null, now = () => new Date() }) {
  const dir = backupDir ?? latestBackupDir(destination);
  if (!dir) return { ok: false, error: "no install manifest to confirm against" };
  const manifestPath = join(dir, "install-manifest.json");
  if (!existsSync(manifestPath)) return { ok: false, error: `no install-manifest.json in ${dir}` };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const intents = manifest.task_intents ?? [];
  const record = intents.find((i) => i.task === taskName);
  if (!record) return { ok: false, error: `no durable intent for '${taskName}'; the installer must record one BEFORE registering` };
  if (!["introduced", "replaced", "aborted"].includes(outcome)) {
    return { ok: false, error: `unknown outcome '${outcome}'` };
  }
  record.state = "confirmed";
  record.outcome = outcome;
  record.confirmed_at_utc = now().toISOString();
  if (outcome === "introduced") {
    const tasks = new Set(manifest.introduced_tasks ?? []);
    tasks.add(taskName);
    manifest.introduced_tasks = [...tasks];
  }
  manifest.task_intents = intents;
  writeManifest(manifestPath, manifest);
  return { ok: true, manifestPath, intent: record, introduced_tasks: manifest.introduced_tasks ?? [] };
}

/**
 * Resolve intents left in `intended` by a crash, from the host's own answer.
 *
 * `queryTask(name)` must return `{ ok, exists }`. "I could not ask" is never
 * read as "the task does not exist": an unanswerable intent stays unresolved
 * and is reported, and rollback keeps treating it as possibly-introduced.
 */
export function reconcileTaskIntents({ destination, backupDir = null, queryTask, now = () => new Date() }) {
  const dir = backupDir ?? latestBackupDir(destination);
  if (!dir) return { ok: false, error: "no install manifest to reconcile" };
  const manifestPath = join(dir, "install-manifest.json");
  if (!existsSync(manifestPath)) return { ok: false, error: `no install-manifest.json in ${dir}` };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const intents = manifest.task_intents ?? [];
  const resolved = [];
  const unresolved = [];
  for (const record of intents) {
    if (record.state !== "intended") continue;
    const answer = typeof queryTask === "function" ? queryTask(record.task) : { ok: false, error: "no host query available" };
    if (!answer?.ok) {
      unresolved.push({ task: record.task, reason: answer?.error ?? "the host could not be queried" });
      continue;
    }
    record.state = "confirmed";
    record.confirmed_at_utc = now().toISOString();
    record.outcome = answer.exists ? (record.pre_existing ? "replaced" : "introduced") : "aborted";
    record.reconciled_from = "host_query";
    if (record.outcome === "introduced") {
      const tasks = new Set(manifest.introduced_tasks ?? []);
      tasks.add(record.task);
      manifest.introduced_tasks = [...tasks];
    }
    resolved.push({ task: record.task, outcome: record.outcome });
  }
  manifest.task_intents = intents;
  writeManifest(manifestPath, manifest);
  return { ok: unresolved.length === 0, manifestPath, resolved, unresolved, introduced_tasks: manifest.introduced_tasks ?? [] };
}

/**
 * Tasks a rollback must attempt to unregister: everything confirmed as
 * introduced, PLUS every intent that is still unconfirmed for a task that did
 * not exist before the install. The second group is the crash window.
 */
export function tasksToUnregister(manifest) {
  const tasks = new Set(manifest.introduced_tasks ?? []);
  for (const record of manifest.task_intents ?? []) {
    if (record.pre_existing) continue;
    if (record.state === "intended") tasks.add(record.task);
    if (record.state === "confirmed" && record.outcome === "introduced") tasks.add(record.task);
  }
  return [...tasks];
}

/** Manifest writes are durable: a rollback history that was not flushed is not history. */
function writeManifest(manifestPath, manifest) {
  const tmp = writeDurable(manifestPath, JSON.stringify(manifest, null, 2));
  renameSync(tmp, manifestPath);
}

/** Most recent backup directory, used by `rollback.ps1` with no explicit -BackupDir. */
export function latestBackupDir(destination) {
  const root = join(destination, "backups");
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root)
    .map((name) => ({ name, path: join(root, name) }))
    .filter((d) => {
      try { return statSync(d.path).isDirectory() && existsSync(join(d.path, "install-manifest.json")); } catch { return false; }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return dirs.length > 0 ? dirs[dirs.length - 1].path : null;
}

export { join, relative, sep };

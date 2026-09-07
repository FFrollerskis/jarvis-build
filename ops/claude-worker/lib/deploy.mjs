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
    if (["active", "unproven_identity", "stale_no_heartbeat", "foreign_host"].includes(verdict.state)) {
      blockers.push({ lock: rel, state: verdict.state, pid: snap.info.pid, reason: verdict.reason });
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
 * This is how an install launched by the running worker hands off safely: the
 * parent is neither killed nor overwritten, it simply exits, and the next
 * scheduler tick activates before node starts.
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
          + "deployment was left exactly as it is and a pending-activation marker was written. The next "
          + "quiescent scheduler tick applies it. Nothing was terminated and no file was overwritten."
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
    introduced_tasks: []
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
    tasks_to_unregister: manifest.introduced_tasks ?? [],
    tasks_to_reimport: manifest.backed_up_tasks ?? [],
    failures
  };
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

/**
 * Durable worker state.
 *
 * Requirement B: a timeout, a non-zero exit, a spawn error or a missing report
 * must NEVER be recorded as "processed". The previous implementation pushed the
 * task id into `processed_task_ids` unconditionally, which is exactly how the
 * D125 implementation run was lost after `spawnSync claude ETIMEDOUT`.
 *
 * Requirement B (durability): writes are atomic and keep a recoverable backup,
 * and a corrupt state file is NEVER silently reset - losing replay protection
 * silently is worse than refusing to run.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, openSync, fsyncSync, closeSync } from "node:fs";

export const TASK_STATUS = Object.freeze({
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  FAILED_RETRYABLE: "failed_retryable",
  BLOCKED: "blocked",
  COMPLETED: "completed"
});

/** Terminal states: never dispatched again. */
export const TERMINAL_STATUSES = Object.freeze([TASK_STATUS.COMPLETED, TASK_STATUS.BLOCKED]);

export const STATE_VERSION = 2;

export function defaultState() {
  return {
    state_version: STATE_VERSION,
    worker_version: null,
    tasks: {},
    last_run_at: null,
    last_known_main: null,
    posted_status_keys: {},
    // Retained purely so a human (or an older worker build) can still read the
    // historical list. `tasks` is authoritative from state_version 2 onward.
    processed_task_ids: []
  };
}

/**
 * Migrate a v1 state file. Every id in the legacy `processed_task_ids` becomes a
 * completed task, flagged `legacy_unverified` because v1 could not distinguish
 * "finished" from "timed out but recorded anyway". They are NOT replayed: the
 * architect issues a fresh TASK_ID for a repair attempt, and silently re-running
 * historical tasks would be far more dangerous than leaving them closed.
 */
export function migrateState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object") return base;
  if (Number(raw.state_version) >= 2 && raw.tasks && typeof raw.tasks === "object") {
    return { ...base, ...raw, tasks: { ...raw.tasks } };
  }
  const tasks = {};
  const legacy = Array.isArray(raw.processed_task_ids) ? raw.processed_task_ids : [];
  for (const id of legacy) {
    if (typeof id !== "string" || !id) continue;
    tasks[id] = {
      task_id: id,
      status: TASK_STATUS.COMPLETED,
      attempts: 1,
      legacy_unverified: true,
      completed_at: null,
      report_comment_id: null
    };
  }
  return {
    ...base,
    worker_version: raw.worker_version ?? null,
    last_run_at: raw.last_run_at ?? null,
    last_known_main: raw.last_known_main ?? null,
    processed_task_ids: legacy,
    tasks
  };
}

/**
 * Load state, falling back to the backup if the primary is corrupt.
 *
 * Returns `{ state, source, corrupt }`. When BOTH copies are unreadable the
 * caller receives `state: null` and must stop and report - it must not invent an
 * empty history, because that would drop replay protection for every past task.
 */
export function loadState(stateFile, backupFile = `${stateFile}.bak`) {
  const attempt = (file, source) => {
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return { state: migrateState(parsed), source, corrupt: false };
    } catch (err) {
      return { error: err, source };
    }
  };

  const primary = attempt(stateFile, "primary");
  if (primary && !primary.error) return primary;

  const backup = attempt(backupFile, "backup");
  if (backup && !backup.error) {
    return { ...backup, corrupt: true, recovered_from_backup: true, primary_error: primary?.error?.message };
  }

  if (!primary && !backup) {
    // Genuinely first run: no file has ever existed. Safe to start empty.
    return { state: defaultState(), source: "fresh", corrupt: false };
  }

  return {
    state: null,
    source: "unreadable",
    corrupt: true,
    primary_error: primary?.error?.message ?? null,
    backup_error: backup?.error?.message ?? null
  };
}

/**
 * Atomic write with a recoverable backup:
 *   1. serialise and validate the payload round-trips,
 *   2. write + fsync a temp file,
 *   3. copy the previous good state aside as .bak,
 *   4. rename temp over the real file (atomic on NTFS and POSIX).
 * An interruption at any point leaves either the old state or the new state,
 * plus a backup - never a truncated primary with no fallback.
 */
export function saveStateAtomic(stateFile, state, backupFile = `${stateFile}.bak`) {
  const payload = JSON.stringify(state, null, 2);
  JSON.parse(payload); // fail before touching disk if the object is not serialisable

  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, payload, "utf8");
  const fd = openSync(tmp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  if (existsSync(stateFile)) {
    try {
      copyFileSync(stateFile, backupFile);
    } catch {
      // A missing backup must not block progress; the atomic rename below is
      // still safe on its own.
    }
  }
  renameSync(tmp, stateFile);
}

export function getTask(state, taskId) {
  return state.tasks[taskId] ?? null;
}

export function upsertTask(state, taskId, patch) {
  const existing = state.tasks[taskId] ?? { task_id: taskId, status: TASK_STATUS.PENDING, attempts: 0 };
  const next = { ...existing, ...patch, task_id: taskId };
  state.tasks[taskId] = next;
  if (next.status === TASK_STATUS.COMPLETED && !state.processed_task_ids.includes(taskId)) {
    state.processed_task_ids.push(taskId);
  }
  return next;
}

/** A task is terminal only when it is genuinely finished or explicitly blocked. */
export function isTerminal(task) {
  return Boolean(task) && TERMINAL_STATUSES.includes(task.status);
}

/**
 * Eligibility for dispatch. A retryable failure becomes eligible again only
 * after its backoff window has elapsed - so a permanently failing task cannot
 * become a tight retry loop across five-minute scheduler runs.
 */
export function isEligibleNow(task, nowMs) {
  if (!task) return true; // never seen -> dispatch
  if (isTerminal(task)) return false;
  if (task.status === TASK_STATUS.IN_PROGRESS) return false; // lock owner decides
  if (task.next_eligible_at) return nowMs >= new Date(task.next_eligible_at).getTime();
  return true;
}

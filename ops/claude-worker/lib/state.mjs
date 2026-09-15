/**
 * Durable worker/supervisor state.
 *
 * Requirement B: a timeout, a non-zero exit, a spawn error or a missing report
 * must NEVER be recorded as "processed". The v1 implementation pushed the task
 * id into `processed_task_ids` unconditionally, which is exactly how the D125
 * implementation run was lost after `spawnSync claude ETIMEDOUT`.
 *
 * D126 review fixes (blocker 3 - durability):
 *   - syntactically valid but structurally INVALID state (null, [], {}, a task
 *     map with unknown statuses, a supervisor journal that is not an array) is
 *     no longer silently accepted as "empty history". `migrateState(null)`
 *     returning a fresh empty state destroyed replay protection in silence.
 *   - `saveStateAtomic` no longer blindly copies the CURRENT primary over the
 *     only good backup. After recovering from backup the primary is corrupt by
 *     definition; copying it forward destroyed the last verified copy
 *     (reproduced by the architect: BACKUP_AFTER_RECOVERY_SAVE=corrupt).
 *     The backup is rotated ONLY from a primary that parses AND validates, and
 *     it is itself written atomically, so an interrupted write can never leave a
 *     truncated backup.
 *   - a genuine first run (no file has ever existed) is reported distinctly from
 *     "a file exists but is unusable", so lost state can never masquerade as a
 *     fresh install.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { validateOrderBinding } from "./order-binding.mjs";

export const TASK_STATUS = Object.freeze({
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  FAILED_RETRYABLE: "failed_retryable",
  BLOCKED: "blocked",
  COMPLETED: "completed",
  /**
   * D132: the architect has moved past this task - a STRICTLY NEWER trusted
   * ARCHITECT_TASK has already run to completion. Replaying it would apply a
   * stale instruction to state that has since moved on, which is precisely what
   * happened on 2026-09-11: `D131-PR79-STASH-RECOVERY-20260911-A` (first
   * dispatched 04:18Z) was dispatched AGAIN at 05:38Z, after the newer
   * `D131-PR79-MERGE-F12FF3B-20260911-B` had already merged PR #79.
   *
   * It is TERMINAL on purpose. Nothing is silently dropped: `superseded_by` and
   * `superseded_at` are recorded, and the worker posts one status notice, so the
   * architect can re-issue a FRESH TASK_ID if the old order is still wanted.
   */
  SUPERSEDED: "superseded"
});

/**
 * Terminal states: never dispatched again, and - decisively for requirement
 * "worker restart/supervisor restart cannot resurrect a terminal or superseded
 * task" - never made eligible again by any amount of stale retry bookkeeping.
 */
export const TERMINAL_STATUSES = Object.freeze([
  TASK_STATUS.COMPLETED,
  TASK_STATUS.BLOCKED,
  TASK_STATUS.SUPERSEDED
]);

const KNOWN_STATUSES = Object.freeze(Object.values(TASK_STATUS));

export const STATE_VERSION = 2;

/**
 * A TASK_ID is used as a directory name (the per-task scratch dir) and as a
 * journal key, so it is validated as a single safe path component BEFORE it is
 * ever concatenated into a path. No separators, no dots-dots, no spaces.
 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidTaskId(id) {
  return typeof id === "string" && TASK_ID_PATTERN.test(id) && id !== "." && id !== "..";
}

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

export function defaultSupervisorState() {
  return {
    state_version: STATE_VERSION,
    supervisor_version: null,
    journal: [],
    executed_command_ids: [],
    posted_status_keys: {},
    // Blocker 5: a deferred command must be PRESERVED until it is safely acted
    // on or explicitly expires. v1 consumed it, so a restart requested while the
    // worker was busy was silently lost forever.
    deferred_commands: {},
    // Blocker 5: durable intent -> effect -> result -> receipt staging, so a
    // crash at any point is reconciled from host evidence instead of guessed.
    pending_intent: null,
    last_restart_at: null,
    last_poll_at: null,
    consecutive_poll_failures: 0
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** ---------------- schema validation ---------------- */

/**
 * Decide what a parsed worker-state document actually IS.
 * Returns `{ kind: "v2" | "v1" | "invalid", reason }`.
 *
 * Anything that is not recognisably a worker state - including `null`, `[]`,
 * `{}` and a truncated-but-parseable fragment - is INVALID, never "empty".
 */
export function classifyRawWorkerState(raw) {
  if (!isPlainObject(raw)) {
    return { kind: "invalid", reason: `not_a_state_object (${Array.isArray(raw) ? "array" : typeof raw})` };
  }
  if (raw.state_version !== undefined && !Number.isFinite(Number(raw.state_version))) {
    return { kind: "invalid", reason: "state_version_not_a_number" };
  }
  const version = Number(raw.state_version);

  if (Number.isFinite(version) && version >= 2) {
    if (!isPlainObject(raw.tasks)) return { kind: "invalid", reason: "v2_tasks_missing_or_not_an_object" };
    for (const [id, task] of Object.entries(raw.tasks)) {
      if (!isValidTaskId(id)) return { kind: "invalid", reason: `v2_invalid_task_id (${String(id).slice(0, 48)})` };
      if (!isPlainObject(task)) return { kind: "invalid", reason: `v2_task_not_an_object (${id})` };
      if (task.task_id !== undefined && task.task_id !== id) {
        return { kind: "invalid", reason: `v2_task_id_key_mismatch (${id})` };
      }
      if (!KNOWN_STATUSES.includes(task.status)) {
        return { kind: "invalid", reason: `v2_unknown_task_status (${id}: ${String(task.status).slice(0, 32)})` };
      }
      if (task.attempts !== undefined && (!Number.isInteger(task.attempts) || task.attempts < 0)) {
        return { kind: "invalid", reason: `v2_invalid_attempts (${id})` };
      }
      // D-149: MIGRATION FAILS CLOSED ON A CORRUPT BINDING.
      //
      // `architect_order` is the only positive evidence that a task was admitted
      // from a specific, unmodified order. A present-but-unreadable one is the
      // most dangerous shape there is: silently dropping it would turn a bound
      // task back into an unbound one, and an unbound task is the case the
      // classifier has to treat as merely "recoverable". So a malformed binding
      // makes the whole document INVALID, which routes it to the verified backup
      // rather than into a load that quietly forgets which order was authority.
      //
      // ABSENT is not invalid - a pre-D-149 record legitimately has none, and it
      // is preserved as such and marked below, never repaired.
      if (task.architect_order !== undefined && task.architect_order !== null) {
        const bound = validateOrderBinding(task.architect_order, { taskId: id });
        if (!bound.ok) {
          return { kind: "invalid", reason: `v2_invalid_architect_order (${id}: ${bound.reason})` };
        }
      }
    }
    if (raw.posted_status_keys !== undefined && !isPlainObject(raw.posted_status_keys)) {
      return { kind: "invalid", reason: "v2_posted_status_keys_not_an_object" };
    }
    if (raw.processed_task_ids !== undefined && !Array.isArray(raw.processed_task_ids)) {
      return { kind: "invalid", reason: "v2_processed_task_ids_not_an_array" };
    }
    return { kind: "v2" };
  }

  // No version, or version 1: the legacy shape.
  if (raw.processed_task_ids !== undefined && !Array.isArray(raw.processed_task_ids)) {
    return { kind: "invalid", reason: "v1_processed_task_ids_not_an_array" };
  }
  if (raw.tasks !== undefined && !isPlainObject(raw.tasks)) {
    return { kind: "invalid", reason: "v1_tasks_not_an_object" };
  }
  // A worker state must carry at least one recognisable worker field. `{}` is
  // NOT an empty history - it is an unusable document.
  const recognisable = ["processed_task_ids", "tasks", "last_run_at", "worker_version", "last_known_main"];
  if (!recognisable.some((k) => raw[k] !== undefined)) {
    return { kind: "invalid", reason: "unrecognised_worker_state_shape" };
  }
  return { kind: "v1" };
}

export function classifyRawSupervisorState(raw) {
  if (!isPlainObject(raw)) {
    return { kind: "invalid", reason: `not_a_state_object (${Array.isArray(raw) ? "array" : typeof raw})` };
  }
  if (raw.journal !== undefined && !Array.isArray(raw.journal)) {
    return { kind: "invalid", reason: "journal_not_an_array" };
  }
  if (raw.executed_command_ids !== undefined && !Array.isArray(raw.executed_command_ids)) {
    return { kind: "invalid", reason: "executed_command_ids_not_an_array" };
  }
  if (raw.posted_status_keys !== undefined && !isPlainObject(raw.posted_status_keys)) {
    return { kind: "invalid", reason: "posted_status_keys_not_an_object" };
  }
  if (raw.deferred_commands !== undefined && !isPlainObject(raw.deferred_commands)) {
    return { kind: "invalid", reason: "deferred_commands_not_an_object" };
  }
  if (raw.pending_intent !== undefined && raw.pending_intent !== null && !isPlainObject(raw.pending_intent)) {
    return { kind: "invalid", reason: "pending_intent_not_an_object" };
  }
  if (raw.consecutive_poll_failures !== undefined
      && (!Number.isInteger(raw.consecutive_poll_failures) || raw.consecutive_poll_failures < 0)) {
    return { kind: "invalid", reason: "consecutive_poll_failures_invalid" };
  }
  const recognisable = ["journal", "executed_command_ids", "last_restart_at", "last_poll_at", "pending_intent"];
  if (!recognisable.some((k) => raw[k] !== undefined)) {
    return { kind: "invalid", reason: "unrecognised_supervisor_state_shape" };
  }
  return { kind: "supervisor" };
}

/** ---------------- migration ---------------- */

/**
 * Migrate a parsed worker-state document.
 *
 * Every id in a legacy `processed_task_ids` becomes a completed task, flagged
 * `legacy_unverified` because v1 could not distinguish "finished" from "timed
 * out but recorded anyway". They are NOT replayed: the architect issues a fresh
 * TASK_ID for a repair attempt, and silently re-running historical tasks would
 * be far more dangerous than leaving them closed.
 *
 * Returns `{ ok: true, state, kind }` or `{ ok: false, reason }`. It NEVER
 * returns an empty state for unusable input.
 */
export function migrateState(raw) {
  const verdict = classifyRawWorkerState(raw);
  if (verdict.kind === "invalid") return { ok: false, reason: verdict.reason };

  const base = defaultState();
  if (verdict.kind === "v2") {
    const tasks = {};
    for (const [id, task] of Object.entries(raw.tasks)) {
      const migrated = { ...task, task_id: id };
      // D-149: MARK, NEVER REPAIR.
      //
      // A record written by a pre-D-149 build carries no `architect_order`. That
      // is a real, recoverable gap and it is recorded as one: the migration says
      // so explicitly rather than leaving a later reader to infer it from an
      // absent field, and it emphatically does NOT invent a binding from
      // whatever order happens to be on the control issue now. Synthesising
      // authority evidence for an already-known task is the exact move D-149
      // forbids - it would let a deleted or replaced order bind itself.
      //
      // Only NON-TERMINAL, already-dispatched records are marked: a completed or
      // blocked task is never dispatched or completion-gated again, so a binding
      // it never had can no longer decide anything.
      if (migrated.architect_order === undefined || migrated.architect_order === null) {
        migrated.architect_order = null;
        if (!TERMINAL_STATUSES.includes(migrated.status) && (migrated.attempts ?? 0) > 0) {
          migrated.architect_order_missing_at_migration = true;
        }
      }
      tasks[id] = migrated;
    }
    return {
      ok: true,
      kind: "v2",
      state: {
        ...base,
        ...raw,
        state_version: STATE_VERSION,
        tasks,
        posted_status_keys: { ...(raw.posted_status_keys ?? {}) },
        processed_task_ids: Array.isArray(raw.processed_task_ids) ? [...raw.processed_task_ids] : []
      }
    };
  }

  const tasks = {};
  const legacy = Array.isArray(raw.processed_task_ids) ? raw.processed_task_ids : [];
  for (const id of legacy) {
    if (!isValidTaskId(id)) continue;
    tasks[id] = {
      task_id: id,
      status: TASK_STATUS.COMPLETED,
      attempts: 1,
      legacy_unverified: true,
      completed_at: null,
      report_comment_id: null,
      // D-149: v1 recorded nothing but an id, so there is nothing to bind to.
      // These are TERMINAL and are never dispatched or completion-gated again,
      // so an absent binding decides nothing here - but it is recorded as an
      // explicit `null` rather than left undefined, so "never bound" is a stated
      // fact in the record instead of a gap a later reader has to interpret.
      architect_order: null
    };
  }
  return {
    ok: true,
    kind: "v1",
    state: {
      ...base,
      worker_version: raw.worker_version ?? null,
      last_run_at: raw.last_run_at ?? null,
      last_known_main: raw.last_known_main ?? null,
      processed_task_ids: legacy.filter((id) => typeof id === "string"),
      tasks
    }
  };
}

export function migrateSupervisorState(raw) {
  const verdict = classifyRawSupervisorState(raw);
  if (verdict.kind === "invalid") return { ok: false, reason: verdict.reason };
  const base = defaultSupervisorState();
  return {
    ok: true,
    kind: "supervisor",
    state: {
      ...base,
      ...raw,
      state_version: STATE_VERSION,
      journal: [...(raw.journal ?? [])],
      executed_command_ids: [...(raw.executed_command_ids ?? [])],
      posted_status_keys: { ...(raw.posted_status_keys ?? {}) },
      deferred_commands: { ...(raw.deferred_commands ?? {}) },
      pending_intent: raw.pending_intent ?? null
    }
  };
}

export const SCHEMAS = Object.freeze({
  worker: { migrate: migrateState, fresh: defaultState },
  supervisor: { migrate: migrateSupervisorState, fresh: defaultSupervisorState }
});

function schemaFor(name) {
  const schema = SCHEMAS[name];
  if (!schema) throw new Error(`unknown state schema: ${name}`);
  return schema;
}

/** ---------------- load ---------------- */

/**
 * Load state, falling back to the backup when the primary is unreadable OR
 * structurally invalid.
 *
 * Returns `{ state, source, corrupt, first_run, primary_valid, ... }`.
 * When BOTH copies exist and neither is usable the caller receives
 * `state: null` and MUST stop and report - it must not invent an empty history,
 * because that would drop replay protection for every past task.
 */
export function loadState(stateFile, backupFile = `${stateFile}.bak`, { schema = "worker" } = {}) {
  const { migrate, fresh } = schemaFor(schema);

  const attempt = (file, source) => {
    if (!existsSync(file)) return { missing: true, source };
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      return { source, error: `read_failed: ${err.code ?? err.message}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { source, error: `unparseable_json: ${err.message}` };
    }
    const migrated = migrate(parsed);
    if (!migrated.ok) return { source, error: `invalid_state: ${migrated.reason}` };
    return { source, state: migrated.state, kind: migrated.kind };
  };

  const primary = attempt(stateFile, "primary");
  if (primary.state) {
    return {
      state: primary.state,
      source: "primary",
      corrupt: false,
      first_run: false,
      primary_valid: true,
      migrated_from: primary.kind
    };
  }

  const backup = attempt(backupFile, "backup");
  if (backup.state) {
    return {
      state: backup.state,
      source: "backup",
      corrupt: true,
      first_run: false,
      primary_valid: false,
      recovered_from_backup: true,
      primary_error: primary.error ?? (primary.missing ? "primary_missing" : null),
      migrated_from: backup.kind
    };
  }

  if (primary.missing && backup.missing) {
    // Genuinely first run: no file has ever existed. Safe to start empty, and
    // reported explicitly so it can never be confused with lost state.
    return { state: fresh(), source: "fresh", corrupt: false, first_run: true, primary_valid: false };
  }

  return {
    state: null,
    source: "unreadable",
    corrupt: true,
    first_run: false,
    primary_valid: false,
    primary_error: primary.error ?? (primary.missing ? "primary_missing" : null),
    backup_error: backup.error ?? (backup.missing ? "backup_missing" : null)
  };
}

/** ---------------- atomic save ---------------- */

/**
 * Write + fsync a uniquely named temp file, then rename it over the target
 * (atomic on NTFS and POSIX). Exported because the task-worktree claim in
 * worktree.mjs has the same durability requirement as the state file: an
 * interrupted write must leave either the old claim or the new one, never a
 * truncated document that would make a task's ownership unreadable.
 */
export function writeFileDurable(target, payload) {
  const tmp = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const fd = openSync(tmp, "wx");
  try {
    writeFileSync(fd, payload, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Atomic write that keeps a VERIFIED recoverable backup.
 *
 *   1. validate the state we are about to write (a caller must never be able to
 *      persist a document that would fail to load),
 *   2. rotate the backup ONLY from a primary that parses AND validates - a
 *      corrupt primary is left alone so the last good backup survives,
 *   3. write + fsync a uniquely named temp file,
 *   4. rename it over the real file (atomic on NTFS and POSIX).
 *
 * An interruption at any point leaves either the old state or the new state,
 * plus the last VERIFIED backup - never a truncated primary with no fallback,
 * and never a backup overwritten by a corrupt primary.
 */
export function saveStateAtomic(stateFile, state, backupFile = `${stateFile}.bak`, { schema = "worker" } = {}) {
  const { migrate } = schemaFor(schema);

  const payload = JSON.stringify(state, null, 2);
  let roundTripped;
  try {
    roundTripped = JSON.parse(payload);
  } catch (err) {
    throw new Error(`refusing to persist unserialisable state: ${err.message}`);
  }
  const check = migrate(roundTripped);
  if (!check.ok) {
    throw new Error(`refusing to persist state that would not load back: ${check.reason}`);
  }

  // --- backup rotation, guarded ---
  let backupUpdated = false;
  let backupSkippedReason = null;
  if (existsSync(stateFile)) {
    let current = null;
    try {
      current = readFileSync(stateFile, "utf8");
    } catch (err) {
      backupSkippedReason = `primary_unreadable (${err.code ?? err.message})`;
    }
    if (current !== null) {
      let valid = false;
      try {
        valid = migrate(JSON.parse(current)).ok;
      } catch {
        valid = false;
      }
      if (valid) {
        try {
          writeFileDurable(backupFile, current);
          backupUpdated = true;
        } catch (err) {
          // A missing backup must not block progress; the atomic rename below is
          // still safe on its own.
          backupSkippedReason = `backup_write_failed (${err.code ?? err.message})`;
        }
      } else {
        // THIS is the reproduced bug: the primary is corrupt (we are most likely
        // running right after a recovery from this very backup). Copying it over
        // the backup would destroy the only good copy.
        backupSkippedReason = "primary_invalid_backup_preserved";
      }
    }
  } else {
    backupSkippedReason = "no_primary_yet";
  }

  writeFileDurable(stateFile, payload);
  return { written: true, backupUpdated, backupSkippedReason };
}

/** ---------------- task helpers ---------------- */

export function getTask(state, taskId) {
  return state.tasks[taskId] ?? null;
}

export function upsertTask(state, taskId, patch) {
  if (!isValidTaskId(taskId)) throw new Error(`refusing to record an unsafe TASK_ID: ${String(taskId).slice(0, 64)}`);
  const existing = state.tasks[taskId] ?? { task_id: taskId, status: TASK_STATUS.PENDING, attempts: 0 };
  const next = { ...existing, ...patch, task_id: taskId };
  if (!KNOWN_STATUSES.includes(next.status)) {
    throw new Error(`refusing to record unknown task status: ${String(next.status).slice(0, 32)}`);
  }
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
 * Eligibility for DISPATCH. IN_PROGRESS is never dispatchable here: the owner of
 * the lock decides what happens to it, via `findAbandonedTasks` below.
 *
 * Blocker 1: this is why a crash mid-task used to stall the loop permanently -
 * nothing ever converted the orphaned IN_PROGRESS record back into work. It is
 * still correct as a dispatch guard; the recovery pass now runs first, under the
 * ownership lock, before any candidate is chosen.
 */
export function isEligibleNow(task, nowMs) {
  if (!task) return true; // never seen -> dispatch
  if (isTerminal(task)) return false;
  if (task.status === TASK_STATUS.IN_PROGRESS) return false; // lock owner decides
  if (task.next_eligible_at) return nowMs >= new Date(task.next_eligible_at).getTime();
  return true;
}

/**
 * Tasks left IN_PROGRESS by a crashed/rebooted parent. Returned so the lock
 * owner can reconcile them - protecting a still-live child - instead of leaving
 * them permanently undispatchable.
 */
export function findAbandonedTasks(state) {
  return Object.values(state.tasks ?? {}).filter((t) => t && t.status === TASK_STATUS.IN_PROGRESS);
}

/** Every non-terminal task that has already been dispatched at least once. */
export function findUnreconciledTasks(state) {
  return Object.values(state.tasks ?? {}).filter((t) => t && !isTerminal(t) && (t.attempts ?? 0) > 0);
}

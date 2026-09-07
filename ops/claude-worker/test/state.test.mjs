/**
 * Requirement B acceptance tests: failure must never mean "processed", and a
 * corrupt state file must never silently erase replay-protection history.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadState, saveStateAtomic, migrateState, upsertTask, getTask,
  isEligibleNow, isTerminal, TASK_STATUS, defaultState
} from "../lib/state.mjs";

let dir;
let stateFile;
let backupFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-state-"));
  stateFile = join(dir, "state.json");
  backupFile = join(dir, "state.json.bak");
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** The real deployed v1 state, abbreviated. */
const V1_STATE = {
  processed_task_ids: [
    "D124-MERGE-AUTH-20260906T0544Z",
    "D125-UA7-TELEGRAM-INBOUND-OWNER-20260906T0627Z",
    "D125-POSTMERGE-LOCAL-CLOSEOUT-20260906T1924Z"
  ],
  active_task_id: null,
  last_run_at: "2026-09-06T17:15:02.810Z",
  worker_version: "1.0.0",
  last_known_main: "94e4aaa528477fbdc87ce8f4f6c37cb9d3bebb1d"
};

describe("v1 -> v2 migration", () => {
  it("preserves every historical id and marks them completed-but-unverified", () => {
    const migrated = migrateState(V1_STATE);
    expect(Object.keys(migrated.tasks)).toHaveLength(3);
    for (const id of V1_STATE.processed_task_ids) {
      expect(migrated.tasks[id]).toMatchObject({ status: TASK_STATUS.COMPLETED, legacy_unverified: true });
      // Still terminal, so historical work is never silently replayed.
      expect(isTerminal(migrated.tasks[id])).toBe(true);
    }
    expect(migrated.last_known_main).toBe(V1_STATE.last_known_main);
  });

  it("is idempotent for an already-migrated state", () => {
    const once = migrateState(V1_STATE);
    const twice = migrateState(once);
    expect(Object.keys(twice.tasks)).toEqual(Object.keys(once.tasks));
  });
});

describe("acceptance: corrupt or interrupted state recovers safely, never silently", () => {
  it("falls back to the backup and keeps the full history", () => {
    const good = migrateState(V1_STATE);
    saveStateAtomic(stateFile, good, backupFile);
    // Second save creates the backup from the first good copy.
    saveStateAtomic(stateFile, good, backupFile);

    writeFileSync(stateFile, '{"tasks": {"broken": ', "utf8"); // truncated write

    const loaded = loadState(stateFile, backupFile);
    expect(loaded.state).not.toBeNull();
    expect(loaded.recovered_from_backup).toBe(true);
    expect(Object.keys(loaded.state.tasks)).toHaveLength(3);
  });

  it("REFUSES to invent an empty history when both copies are unreadable", () => {
    writeFileSync(stateFile, "{ not json", "utf8");
    writeFileSync(backupFile, "also not json", "utf8");

    const loaded = loadState(stateFile, backupFile);
    // The critical property: no silent reset to an empty processed list.
    expect(loaded.state).toBeNull();
    expect(loaded.corrupt).toBe(true);
    expect(loaded.primary_error).toBeTruthy();
    expect(loaded.backup_error).toBeTruthy();
  });

  it("treats a genuine first run as an empty state, not as corruption", () => {
    const loaded = loadState(stateFile, backupFile);
    expect(loaded.source).toBe("fresh");
    expect(loaded.corrupt).toBe(false);
    expect(loaded.state.tasks).toEqual({});
  });

  it("never leaves a truncated primary without a usable fallback", () => {
    const s = defaultState();
    upsertTask(s, "T1", { status: TASK_STATUS.COMPLETED });
    saveStateAtomic(stateFile, s, backupFile);
    upsertTask(s, "T2", { status: TASK_STATUS.COMPLETED });
    saveStateAtomic(stateFile, s, backupFile);

    expect(existsSync(backupFile)).toBe(true);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).tasks).toHaveProperty("T2");
    expect(JSON.parse(readFileSync(backupFile, "utf8")).tasks).toHaveProperty("T1");
    // No temp file left behind after a clean save.
    expect(existsSync(`${stateFile}.tmp`)).toBe(false);
  });
});

describe("acceptance: failure never marks a task processed", () => {
  it("keeps a timed-out task eligible for the next poll", () => {
    const s = defaultState();
    upsertTask(s, "TASK-A", {
      status: TASK_STATUS.FAILED_RETRYABLE,
      attempts: 1,
      last_failure_reason: "timeout",
      next_eligible_at: new Date(Date.now() - 1000).toISOString()
    });

    const t = getTask(s, "TASK-A");
    expect(isTerminal(t)).toBe(false);
    expect(s.processed_task_ids).not.toContain("TASK-A"); // the v1 bug, now impossible
    expect(isEligibleNow(t, Date.now())).toBe(true);
  });

  it("holds a task inside its backoff window", () => {
    const s = defaultState();
    upsertTask(s, "TASK-B", {
      status: TASK_STATUS.FAILED_RETRYABLE,
      attempts: 2,
      next_eligible_at: new Date(Date.now() + 600_000).toISOString()
    });
    expect(isEligibleNow(getTask(s, "TASK-B"), Date.now())).toBe(false);
  });

  it("never re-dispatches a completed or blocked task", () => {
    const s = defaultState();
    upsertTask(s, "DONE", { status: TASK_STATUS.COMPLETED });
    upsertTask(s, "STUCK", { status: TASK_STATUS.BLOCKED });
    expect(isEligibleNow(getTask(s, "DONE"), Date.now())).toBe(false);
    expect(isEligibleNow(getTask(s, "STUCK"), Date.now())).toBe(false);
    expect(s.processed_task_ids).toContain("DONE");
    expect(s.processed_task_ids).not.toContain("STUCK");
  });

  it("dispatches a task it has never seen", () => {
    expect(isEligibleNow(null, Date.now())).toBe(true);
  });

  it("does not dispatch a task another instance holds in progress", () => {
    const s = defaultState();
    upsertTask(s, "RUNNING", { status: TASK_STATUS.IN_PROGRESS, attempts: 1 });
    expect(isEligibleNow(getTask(s, "RUNNING"), Date.now())).toBe(false);
  });
});

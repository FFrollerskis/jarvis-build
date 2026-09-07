import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TASK_STATUS,
  STATE_VERSION,
  defaultState,
  defaultSupervisorState,
  migrateState,
  classifyRawWorkerState,
  classifyRawSupervisorState,
  loadState,
  saveStateAtomic,
  upsertTask,
  getTask,
  isTerminal,
  isEligibleNow,
  isValidTaskId,
  findAbandonedTasks
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
  rmSync(dir, { recursive: true, force: true });
});

const V1_STATE = {
  processed_task_ids: ["D124-ONE", "D125-TWO", "D125-THREE"],
  last_run_at: "2026-09-06T10:00:00.000Z",
  worker_version: "1.0.0"
};

describe("v1 -> v2 migration", () => {
  it("preserves every historical id and marks them completed-but-unverified", () => {
    const migrated = migrateState(V1_STATE);
    expect(migrated.ok).toBe(true);
    expect(Object.keys(migrated.state.tasks)).toHaveLength(3);
    for (const id of V1_STATE.processed_task_ids) {
      expect(migrated.state.tasks[id]).toMatchObject({ status: TASK_STATUS.COMPLETED, legacy_unverified: true });
    }
    expect(migrated.state.state_version).toBe(STATE_VERSION);
  });

  it("is idempotent for an already-migrated state", () => {
    const once = migrateState(V1_STATE);
    const twice = migrateState(once.state);
    expect(twice.ok).toBe(true);
    expect(Object.keys(twice.state.tasks)).toEqual(Object.keys(once.state.tasks));
  });
});

/**
 * D126 review blocker 3, architect reproduction:
 *   NULL_STATE_ACCEPTED_AS_EMPTY=true
 * `migrateState(null)` returned a fresh empty state, so any syntactically valid
 * but structurally wrong document silently wiped replay protection.
 */
describe("blocker 3: structurally invalid state is never accepted as an empty history", () => {
  const invalid = [
    ["null", null],
    ["an array", []],
    ["a bare number", 7],
    ["a string", "state"],
    ["an empty object", {}],
    ["an unrecognised object", { hello: "world" }],
    ["a v2 state whose tasks is not an object", { state_version: 2, tasks: [] }],
    ["a v2 state with an unknown task status", { state_version: 2, tasks: { A: { status: "weird" } } }],
    ["a v2 state with an unsafe task id", { state_version: 2, tasks: { "../escape": { status: "completed" } } }],
    ["a v1 state whose processed_task_ids is not an array", { processed_task_ids: "D125" }],
    ["a non-numeric state_version", { state_version: "two", tasks: {} }]
  ];

  for (const [label, value] of invalid) {
    it(`rejects ${label}`, () => {
      expect(classifyRawWorkerState(value).kind).toBe("invalid");
      const migrated = migrateState(value);
      expect(migrated.ok).toBe(false);
      expect(migrated.state).toBeUndefined();
    });
  }

  it("accepts a genuine v2 state", () => {
    const state = defaultState();
    upsertTask(state, "D126-X", { status: TASK_STATUS.COMPLETED });
    expect(migrateState(JSON.parse(JSON.stringify(state))).ok).toBe(true);
  });

  it("refuses to LOAD a null state file rather than starting empty", () => {
    writeFileSync(stateFile, "null", "utf8");
    const loaded = loadState(stateFile, backupFile);
    expect(loaded.state).toBeNull();
    expect(loaded.source).toBe("unreadable");
    expect(loaded.primary_error).toMatch(/invalid_state/);
  });
});

describe("first run is distinguishable from lost state", () => {
  it("reports first_run only when no file has ever existed", () => {
    const fresh = loadState(stateFile, backupFile);
    expect(fresh.first_run).toBe(true);
    expect(fresh.source).toBe("fresh");
    expect(fresh.state.tasks).toEqual({});
  });

  it("never reports first_run when a file exists but is unusable", () => {
    writeFileSync(stateFile, "{ not json", "utf8");
    const loaded = loadState(stateFile, backupFile);
    expect(loaded.first_run).toBe(false);
    expect(loaded.state).toBeNull();
  });
});

/**
 * D126 review blocker 3, architect reproduction:
 *   BACKUP_AFTER_RECOVERY_SAVE=corrupt
 * "saveStateAtomic blindly copies corrupt primary over the only good backup
 *  after recovering from backup."
 */
describe("blocker 3: the last verified backup survives a corrupt primary", () => {
  it("does NOT overwrite a good backup with a corrupt primary (exact architect repro)", () => {
    const good = defaultState();
    upsertTask(good, "D125-IMPORTANT", { status: TASK_STATUS.COMPLETED });
    writeFileSync(backupFile, JSON.stringify(good, null, 2), "utf8");
    writeFileSync(stateFile, "corrupt", "utf8");

    const loaded = loadState(stateFile, backupFile);
    expect(loaded.recovered_from_backup).toBe(true);
    expect(loaded.primary_valid).toBe(false);
    expect(getTask(loaded.state, "D125-IMPORTANT")).toBeTruthy();

    const result = saveStateAtomic(stateFile, loaded.state, backupFile);
    expect(result.backupUpdated).toBe(false);
    expect(result.backupSkippedReason).toBe("primary_invalid_backup_preserved");

    // The exact assertion that failed on the reviewed implementation.
    expect(readFileSync(backupFile, "utf8")).not.toBe("corrupt");
    expect(JSON.parse(readFileSync(backupFile, "utf8")).tasks["D125-IMPORTANT"]).toBeTruthy();
  });

  it("rotates the backup again once the primary is valid", () => {
    const state = defaultState();
    upsertTask(state, "A", { status: TASK_STATUS.COMPLETED });
    saveStateAtomic(stateFile, state, backupFile); // no primary yet
    upsertTask(state, "B", { status: TASK_STATUS.COMPLETED });
    const second = saveStateAtomic(stateFile, state, backupFile);
    expect(second.backupUpdated).toBe(true);
    expect(JSON.parse(readFileSync(backupFile, "utf8")).tasks.A).toBeTruthy();
    expect(JSON.parse(readFileSync(backupFile, "utf8")).tasks.B).toBeUndefined();
  });

  it("still refuses to write a state that would not load back", () => {
    const broken = { state_version: 2, tasks: { A: { status: "nonsense" } } };
    expect(() => saveStateAtomic(stateFile, broken, backupFile)).toThrow(/would not load back/);
    expect(existsSync(stateFile)).toBe(false);
  });
});

describe("fault injection during the atomic write", () => {
  it("an interrupted write leaves the previous primary AND the verified backup intact", () => {
    const first = defaultState();
    upsertTask(first, "KEEP-ME", { status: TASK_STATUS.COMPLETED });
    saveStateAtomic(stateFile, first, backupFile);
    const second = defaultState();
    upsertTask(second, "KEEP-ME", { status: TASK_STATUS.COMPLETED });
    upsertTask(second, "ALSO-ME", { status: TASK_STATUS.COMPLETED });
    saveStateAtomic(stateFile, second, backupFile);

    // Simulate a crash that left a stray temp file behind: nothing else may be
    // affected, and both copies must still load.
    writeFileSync(`${stateFile}.tmp-99999-deadbeef`, "half-written {", "utf8");

    const loaded = loadState(stateFile, backupFile);
    expect(loaded.source).toBe("primary");
    expect(getTask(loaded.state, "ALSO-ME")).toBeTruthy();
    expect(JSON.parse(readFileSync(backupFile, "utf8")).tasks["KEEP-ME"]).toBeTruthy();
  });

  it("recovers from the backup when the primary is truncated mid-document", () => {
    const good = defaultState();
    upsertTask(good, "HISTORY", { status: TASK_STATUS.COMPLETED });
    saveStateAtomic(stateFile, good, backupFile);
    upsertTask(good, "SECOND", { status: TASK_STATUS.COMPLETED });
    saveStateAtomic(stateFile, good, backupFile);

    const truncated = readFileSync(stateFile, "utf8").slice(0, 40);
    writeFileSync(stateFile, truncated, "utf8");

    const loaded = loadState(stateFile, backupFile);
    expect(loaded.recovered_from_backup).toBe(true);
    expect(getTask(loaded.state, "HISTORY")).toBeTruthy();
  });

  it("refuses to run when BOTH copies are unusable", () => {
    writeFileSync(stateFile, "{{{", "utf8");
    writeFileSync(backupFile, "[]", "utf8");
    const loaded = loadState(stateFile, backupFile);
    expect(loaded.state).toBeNull();
    expect(loaded.primary_error).toBeTruthy();
    expect(loaded.backup_error).toBeTruthy();
  });
});

describe("supervisor state schema", () => {
  it("accepts a real supervisor state and rejects nonsense", () => {
    expect(classifyRawSupervisorState(defaultSupervisorState()).kind).toBe("supervisor");
    expect(classifyRawSupervisorState(null).kind).toBe("invalid");
    expect(classifyRawSupervisorState({}).kind).toBe("invalid");
    expect(classifyRawSupervisorState({ journal: "nope" }).kind).toBe("invalid");
    expect(classifyRawSupervisorState({ journal: [], pending_intent: 5 }).kind).toBe("invalid");
  });

  it("round-trips through save/load with the supervisor schema", () => {
    const state = defaultSupervisorState();
    state.pending_intent = { intent_id: "abc", stage: "intent", created_at: new Date().toISOString() };
    saveStateAtomic(stateFile, state, backupFile, { schema: "supervisor" });
    const loaded = loadState(stateFile, backupFile, { schema: "supervisor" });
    expect(loaded.state.pending_intent.intent_id).toBe("abc");
  });

  it("does not accept a WORKER state as a supervisor state", () => {
    saveStateAtomic(stateFile, defaultState(), backupFile, { schema: "worker" });
    const loaded = loadState(stateFile, backupFile, { schema: "supervisor" });
    expect(loaded.state).toBeNull();
  });
});

describe("task ids are validated before they become path components", () => {
  it("accepts real architect ids", () => {
    expect(isValidTaskId("D126-REVIEW-FIX-20260907-A")).toBe(true);
    expect(isValidTaskId("D125-UA7-TELEGRAM-INBOUND-OWNER-20260906T0627Z")).toBe(true);
  });

  it("rejects anything that could escape a directory", () => {
    for (const bad of ["..", ".", "../etc", "a/b", "a\\b", "", "with space", "x".repeat(200), null, 5]) {
      expect(isValidTaskId(bad)).toBe(false);
    }
  });

  it("upsertTask refuses an unsafe id", () => {
    const state = defaultState();
    expect(() => upsertTask(state, "../escape", { status: TASK_STATUS.PENDING })).toThrow(/unsafe TASK_ID/);
  });
});

describe("eligibility and abandonment", () => {
  it("an in-progress task is never dispatchable, but IS reported as abandoned", () => {
    const state = defaultState();
    upsertTask(state, "CRASHED", { status: TASK_STATUS.IN_PROGRESS, attempts: 1 });
    expect(isEligibleNow(getTask(state, "CRASHED"), Date.now())).toBe(false);
    expect(findAbandonedTasks(state).map((t) => t.task_id)).toEqual(["CRASHED"]);
  });

  it("terminal tasks are never eligible and never abandoned", () => {
    const state = defaultState();
    upsertTask(state, "DONE", { status: TASK_STATUS.COMPLETED });
    upsertTask(state, "STOP", { status: TASK_STATUS.BLOCKED });
    expect(isTerminal(getTask(state, "DONE"))).toBe(true);
    expect(isTerminal(getTask(state, "STOP"))).toBe(true);
    expect(findAbandonedTasks(state)).toHaveLength(0);
  });

  it("a retryable task becomes eligible only after its backoff", () => {
    const state = defaultState();
    const future = new Date(Date.now() + 60_000).toISOString();
    upsertTask(state, "WAIT", { status: TASK_STATUS.FAILED_RETRYABLE, next_eligible_at: future });
    expect(isEligibleNow(getTask(state, "WAIT"), Date.now())).toBe(false);
    expect(isEligibleNow(getTask(state, "WAIT"), Date.now() + 120_000)).toBe(true);
  });
});

describe("unreadable files are not silently treated as absent", () => {
  it("an unreadable primary falls through to the backup", () => {
    const good = defaultState();
    upsertTask(good, "HIST", { status: TASK_STATUS.COMPLETED });
    writeFileSync(backupFile, JSON.stringify(good), "utf8");
    writeFileSync(stateFile, JSON.stringify(good), "utf8");
    try {
      chmodSync(stateFile, 0o000);
    } catch {
      return; // permission semantics unavailable here; the JSON path is covered above
    }
    const loaded = loadState(stateFile, backupFile);
    try { chmodSync(stateFile, 0o600); } catch { /* restore best effort */ }
    // Either the read failed (recovered from backup) or the platform ignores the
    // mode; both must still yield the preserved history, never an empty one.
    expect(getTask(loaded.state, "HIST")).toBeTruthy();
  });
});

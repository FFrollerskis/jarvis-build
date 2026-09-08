import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

vi.mock("../lib/github.mjs", () => ({
  verifyAuth: vi.fn(() => ({ ok: true })),
  fetchIssueComments: vi.fn(() => []),
  postComment: vi.fn(() => ({ ok: true, commentId: "receipt-1" })),
  resolveBinary: vi.fn(() => ({ command: "gh", prefix: [] }))
}));

vi.mock("../lib/wintask.mjs", () => ({
  getScheduledTask: vi.fn(() => ({ exists: true, state: "Ready", lastTaskResult: 0, query_failed: false })),
  startScheduledTask: vi.fn(() => ({ ok: true, output: "JARVIS_TASK_STARTED" })),
  getScheduledTaskDefinition: vi.fn(() => ({ exists: false })),
  assertSafeTaskName: (n) => n,
  ps: vi.fn()
}));

const github = await import("../lib/github.mjs");
const wintask = await import("../lib/wintask.mjs");
const { runOwned } = await import("../supervisor.mjs");
const { acquireLock, releaseLock } = await import("../lib/lock.mjs");
const { loadState, saveStateAtomic, defaultSupervisorState } = await import("../lib/state.mjs");

let dir;
let cfg;
let lockToken;

const HOST = hostname();
const WORKER_TASK = "JarvisClaudeWorker";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-sup-"));
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "supervisor-logs"), { recursive: true });
  cfg = {
    repoOwner: "tsworkflow",
    repoName: "jarvisbuild",
    controlIssue: 68,
    trustedAuthor: "tsworkflow",
    workerTaskName: WORKER_TASK,
    supervisorTaskName: "JarvisWorkerSupervisor",
    host: HOST,
    workerRoot: dir,
    workerHealthFile: join(dir, "logs", "health.jsonl"),
    workerLockFile: join(dir, ".worker.lock"),
    logDir: join(dir, "supervisor-logs"),
    scratchRoot: join(dir, "supervisor-logs", "tmp"),
    healthFile: join(dir, "supervisor-logs", "supervisor-health.jsonl"),
    stateFile: join(dir, "supervisor-state.json"),
    stateBackupFile: join(dir, "supervisor-state.json.bak"),
    lockFile: join(dir, ".supervisor.lock"),
    disabledFlagFile: join(dir, "supervisor-disabled.flag"),
    deadWorkerMinutes: 120,
    restartBudgetPerDay: 4,
    backoffBaseMinutes: 10,
    maxAttempts: 4,
    statusRepeatHours: 6
  };
  const lock = acquireLock(cfg.lockFile, { phase: "test" });
  expect(lock.acquired).toBe(true);
  lockToken = lock.token;

  vi.mocked(github.verifyAuth).mockReturnValue({ ok: true });
  vi.mocked(github.fetchIssueComments).mockReturnValue([]);
  vi.mocked(github.postComment).mockReturnValue({ ok: true, commentId: "receipt-1" });
  vi.mocked(wintask.getScheduledTask).mockReturnValue({ exists: true, state: "Ready", lastTaskResult: 0, query_failed: false });
  vi.mocked(wintask.startScheduledTask).mockReturnValue({ ok: true, output: "JARVIS_TASK_STARTED" });
});

afterEach(() => {
  releaseLock(cfg.lockFile, lockToken);
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** Give the worker a health journal so it looks alive and polling. */
function workerPolledAt(iso) {
  appendFileSync(cfg.workerHealthFile, JSON.stringify({ ts: iso, event: "queue_polled" }) + "\n", "utf8");
  appendFileSync(cfg.workerHealthFile, JSON.stringify({ ts: iso, event: "scheduler_invoked" }) + "\n", "utf8");
}

/** A live worker lock: the supervisor must treat this as BUSY and never restart it. */
function workerBusy() {
  writeFileSync(cfg.workerLockFile, JSON.stringify({
    lock_version: 2,
    pid: process.pid,
    host: HOST,
    start_time: null,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    phase: "dispatch",
    task_id: "D126-SOMETHING",
    owner_token: "t"
  }, null, 2), "utf8");
}

function controlComment(id, commandId, { command = "RESTART_WORKER", createdAt = new Date().toISOString(), expiresInMs = 30 * 60_000 } = {}) {
  const issued = new Date(Date.now() - 1000).toISOString();
  const expires = new Date(Date.now() + expiresInMs).toISOString();
  return {
    id,
    created_at: createdAt,
    updated_at: createdAt,
    author_association: "OWNER",
    user: { login: "tsworkflow" },
    body: [
      "ARCHITECT_CONTROL",
      `COMMAND_ID=${commandId}`,
      `COMMAND=${command}`,
      `TARGET_HOST=${HOST}`,
      `TARGET_WORKER=${WORKER_TASK}`,
      `ISSUED_AT=${issued}`,
      `EXPIRES_AT=${expires}`
    ].join("\n")
  };
}

function seedState(patch = {}) {
  const state = { ...defaultSupervisorState(), ...patch };
  saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile, { schema: "supervisor" });
  return state;
}

function readSupervisorState() {
  return loadState(cfg.stateFile, cfg.stateBackupFile, { schema: "supervisor" }).state;
}

/**
 * D126 review blocker 5:
 * "Commands are validated in one batch before journal updates, so duplicate
 *  COMMAND_ID comments within that batch both execute."
 */
describe("blocker 5: two comments with the SAME COMMAND_ID in one poll execute once", () => {
  it("starts the scheduled task exactly once", async () => {
    workerPolledAt(new Date().toISOString());
    seedState();
    github.fetchIssueComments.mockReturnValue([
      controlComment(1, "RESTART-AAAAAAAA"),
      controlComment(2, "RESTART-AAAAAAAA")
    ]);

    await runOwned(cfg, lockToken, { dryRun: false });

    expect(wintask.startScheduledTask).toHaveBeenCalledTimes(1);
    const state = readSupervisorState();
    expect(state.executed_command_ids).toEqual(["RESTART-AAAAAAAA"]);
    expect(state.journal.filter((e) => e.action === "restart_started")).toHaveLength(1);
  });

  it("a replay of the same id in a LATER poll is also rejected", async () => {
    workerPolledAt(new Date().toISOString());
    seedState();
    github.fetchIssueComments.mockReturnValue([controlComment(1, "RESTART-AAAAAAAA")]);
    await runOwned(cfg, lockToken, { dryRun: false });
    expect(wintask.startScheduledTask).toHaveBeenCalledTimes(1);

    // Clear the backoff so only the replay guard can stop it.
    const state = readSupervisorState();
    state.last_restart_at = new Date(Date.now() - 60 * 60_000).toISOString();
    saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile, { schema: "supervisor" });

    await runOwned(cfg, lockToken, { dryRun: false });
    expect(wintask.startScheduledTask).toHaveBeenCalledTimes(1);
  });
});

describe("blocker 5: two UNIQUE restart requests are budget-enforced", () => {
  it("the second is refused when the daily budget is 1", async () => {
    workerPolledAt(new Date().toISOString());
    seedState();
    cfg.restartBudgetPerDay = 1;
    github.fetchIssueComments.mockReturnValue([
      controlComment(1, "RESTART-AAAAAAAA"),
      controlComment(2, "RESTART-BBBBBBBB")
    ]);

    await runOwned(cfg, lockToken, { dryRun: false });

    expect(wintask.startScheduledTask).toHaveBeenCalledTimes(1);
    const state = readSupervisorState();
    expect(state.journal.some((e) => e.action === "restart_rejected")).toBe(true);
  });

  it("the second is deferred by the backoff when the budget still allows it", async () => {
    workerPolledAt(new Date().toISOString());
    seedState();
    cfg.restartBudgetPerDay = 10;
    github.fetchIssueComments.mockReturnValue([
      controlComment(1, "RESTART-AAAAAAAA"),
      controlComment(2, "RESTART-BBBBBBBB")
    ]);

    await runOwned(cfg, lockToken, { dryRun: false });

    expect(wintask.startScheduledTask).toHaveBeenCalledTimes(1);
    const state = readSupervisorState();
    expect(Object.keys(state.deferred_commands)).toContain("RESTART-BBBBBBBB");
  });
});

/**
 * "Busy 'deferred' requests are consumed rather than deferred."
 */
describe("blocker 5: a deferred request is PRESERVED until it can be acted on", () => {
  it("does not consume the command while the worker is busy, and acts once it goes idle", async () => {
    workerPolledAt(new Date().toISOString());
    workerBusy();
    seedState();
    const comment = controlComment(1, "RESTART-CCCCCCCC");
    github.fetchIssueComments.mockReturnValue([comment]);

    await runOwned(cfg, lockToken, { dryRun: false });

    expect(wintask.startScheduledTask).not.toHaveBeenCalled();
    let state = readSupervisorState();
    expect(state.executed_command_ids).not.toContain("RESTART-CCCCCCCC");
    expect(state.deferred_commands["RESTART-CCCCCCCC"]).toBeTruthy();
    expect(state.deferred_commands["RESTART-CCCCCCCC"].deferrals).toBe(1);

    // The worker finishes its legitimate work and goes idle.
    rmSync(cfg.workerLockFile);
    await runOwned(cfg, lockToken, { dryRun: false });

    expect(wintask.startScheduledTask).toHaveBeenCalledTimes(1);
    state = readSupervisorState();
    expect(state.executed_command_ids).toContain("RESTART-CCCCCCCC");
    expect(state.deferred_commands["RESTART-CCCCCCCC"]).toBeUndefined();
  });

  it("closes out a deferral explicitly once the request expires, instead of silently dropping it", async () => {
    workerPolledAt(new Date().toISOString());
    workerBusy();
    seedState({
      deferred_commands: {
        "RESTART-DDDDDDDD": {
          command: "RESTART_WORKER",
          first_deferred_at: new Date(Date.now() - 60_000).toISOString(),
          last_deferred_at: new Date(Date.now() - 60_000).toISOString(),
          expires_at: new Date(Date.now() - 1000).toISOString(),
          reason: "worker was busy",
          deferrals: 3
        }
      }
    });
    github.fetchIssueComments.mockReturnValue([]);

    await runOwned(cfg, lockToken, { dryRun: false });

    expect(wintask.startScheduledTask).not.toHaveBeenCalled();
    const state = readSupervisorState();
    expect(state.deferred_commands["RESTART-DDDDDDDD"]).toBeUndefined();
    expect(state.journal.some((e) => e.action === "restart_deferral_expired")).toBe(true);
    const receipt = vi.mocked(github.postComment).mock.calls.map((c) => c[1]).join("\n");
    expect(receipt).toMatch(/RESULT=never_performed/);
  });
});

/**
 * "performRestart marks command executed BEFORE the start, never reconciles
 *  pending intent on next run, so crash before start loses request permanently."
 */
describe("blocker 5: a crash around the start is reconciled, not lost and not repeated", () => {
  it("crash BEFORE Start-ScheduledTask: the request is re-driven on the next run", async () => {
    const now = Date.now();
    workerPolledAt(new Date(now - 5000).toISOString());
    seedState({
      pending_intent: {
        intent_id: "intent-1",
        command_id: "RESTART-EEEEEEEE",
        kind: "restart",
        stage: "intent",
        created_at: new Date(now).toISOString(),
        result: null,
        receipt_posted: false
      },
      executed_command_ids: ["RESTART-EEEEEEEE"],
      journal: [{ ts: new Date(now).toISOString(), action: "restart_started", intent_id: "intent-1", command_id: "RESTART-EEEEEEEE" }],
      last_restart_at: new Date(now).toISOString()
    });

    await runOwned(cfg, lockToken, { dryRun: false });

    expect(wintask.startScheduledTask).toHaveBeenCalledTimes(1);
    const state = readSupervisorState();
    expect(state.pending_intent).toBeNull();
    // Re-driving the SAME intent must not consume a second unit of budget.
    expect(state.journal.filter((e) => e.action === "restart_started").map((e) => e.intent_id)).toEqual(["intent-1"]);
  });

  it("crash AFTER Start-ScheduledTask: host evidence confirms it and it is NOT repeated", async () => {
    const now = Date.now();
    seedState({
      pending_intent: {
        intent_id: "intent-2",
        command_id: "RESTART-FFFFFFFF",
        kind: "restart",
        stage: "effect_attempted",
        created_at: new Date(now - 60_000).toISOString(),
        result: null,
        receipt_posted: false
      },
      executed_command_ids: ["RESTART-FFFFFFFF"],
      last_restart_at: new Date(now - 60_000).toISOString()
    });
    // The worker demonstrably ran AFTER the intent was recorded.
    workerPolledAt(new Date(now).toISOString());

    await runOwned(cfg, lockToken, { dryRun: false });

    expect(wintask.startScheduledTask).not.toHaveBeenCalled();
    const state = readSupervisorState();
    expect(state.pending_intent).toBeNull();
    expect(state.journal.some((e) => e.action === "restart_result" && e.reconciled === true)).toBe(true);
  });

  it("a FAILED receipt is retried without repeating the effect", async () => {
    const now = Date.now();
    workerPolledAt(new Date(now).toISOString());
    seedState({
      pending_intent: {
        intent_id: "intent-3",
        command_id: "RESTART-GGGGGGGG",
        kind: "restart",
        stage: "result_recorded",
        created_at: new Date(now - 60_000).toISOString(),
        result: { ok: true, error: null },
        receipt_posted: false
      },
      executed_command_ids: ["RESTART-GGGGGGGG"],
      last_restart_at: new Date(now - 60_000).toISOString()
    });
    github.postComment.mockReturnValue({ ok: false, error: "gh: network unreachable" });

    await runOwned(cfg, lockToken, { dryRun: false });

    expect(wintask.startScheduledTask).not.toHaveBeenCalled();
    let state = readSupervisorState();
    expect(state.pending_intent).not.toBeNull();
    expect(state.pending_intent.receipt_posted).toBe(false);

    // GitHub comes back; the receipt lands and the effect is still not repeated.
    github.postComment.mockReturnValue({ ok: true, commentId: "receipt-9" });
    await runOwned(cfg, lockToken, { dryRun: false });

    expect(wintask.startScheduledTask).not.toHaveBeenCalled();
    state = readSupervisorState();
    expect(state.pending_intent).toBeNull();
  });

  it("a start that FAILS is recorded as failed, never as started", async () => {
    workerPolledAt(new Date().toISOString());
    seedState();
    wintask.startScheduledTask.mockReturnValue({ ok: false, error: "Access is denied" });
    github.fetchIssueComments.mockReturnValue([controlComment(1, "RESTART-HHHHHHHH")]);

    await runOwned(cfg, lockToken, { dryRun: false });

    const state = readSupervisorState();
    const result = state.journal.find((e) => e.action === "restart_result");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Access is denied/);
    const bodies = vi.mocked(github.postComment).mock.calls.map((c) => c[1]).join("\n");
    expect(bodies).toMatch(/RESULT=failed/);
  });
});

describe("STATUS is answered without ever mutating the worker", () => {
  it("reports and consumes the command, and starts nothing", async () => {
    workerPolledAt(new Date().toISOString());
    seedState();
    github.fetchIssueComments.mockReturnValue([controlComment(1, "STATUS-11111111", { command: "STATUS" })]);

    await runOwned(cfg, lockToken, { dryRun: false });

    expect(wintask.startScheduledTask).not.toHaveBeenCalled();
    expect(readSupervisorState().executed_command_ids).toContain("STATUS-11111111");
    const bodies = vi.mocked(github.postComment).mock.calls.map((c) => c[1]).join("\n");
    expect(bodies).toMatch(/COMMAND=STATUS/);
    expect(bodies).toMatch(/WORKER_VERDICT=/);
  });
});

describe("a dry run mutates nothing at all", () => {
  it("takes no action and writes no state", async () => {
    workerPolledAt(new Date().toISOString());
    seedState();
    const before = readFileSync(cfg.stateFile, "utf8");
    github.fetchIssueComments.mockReturnValue([controlComment(1, "RESTART-IIIIIIII")]);

    await runOwned(cfg, lockToken, { dryRun: true });

    expect(wintask.startScheduledTask).not.toHaveBeenCalled();
    expect(github.postComment).not.toHaveBeenCalled();
    expect(readFileSync(cfg.stateFile, "utf8")).toBe(before);
  });
});

describe("unusable supervisor state stops the run instead of replaying commands", () => {
  it("refuses to run when both copies are unusable", async () => {
    writeFileSync(cfg.stateFile, "{{{", "utf8");
    writeFileSync(cfg.stateBackupFile, "null", "utf8");
    const code = await runOwned(cfg, lockToken, { dryRun: false });
    expect(code).toBe(3);
    expect(wintask.startScheduledTask).not.toHaveBeenCalled();
  });

  it("recovers from the backup and does NOT overwrite it with the corrupt primary", async () => {
    workerPolledAt(new Date().toISOString());
    const good = { ...defaultSupervisorState(), executed_command_ids: ["OLD-COMMAND"] };
    writeFileSync(cfg.stateBackupFile, JSON.stringify(good, null, 2), "utf8");
    writeFileSync(cfg.stateFile, "corrupt", "utf8");
    github.fetchIssueComments.mockReturnValue([]);

    await runOwned(cfg, lockToken, { dryRun: false });

    expect(JSON.parse(readFileSync(cfg.stateBackupFile, "utf8")).executed_command_ids).toContain("OLD-COMMAND");
    expect(readSupervisorState().executed_command_ids).toContain("OLD-COMMAND");
  });
});

describe("state is never written without owning the supervisor lock", () => {
  it("throws rather than writing with a bogus token", async () => {
    workerPolledAt(new Date().toISOString());
    seedState();
    github.fetchIssueComments.mockReturnValue([controlComment(1, "RESTART-JJJJJJJJ")]);
    await expect(runOwned(cfg, "not-the-token", { dryRun: false })).rejects.toThrow(/no longer owns the supervisor lock/);
  });
});

describe("the supervisor never terminates anything", () => {
  it("has no kill path at all in its module graph", () => {
    const sources = ["../supervisor.mjs", "../lib/supervise.mjs", "../lib/wintask.mjs"]
      .map((rel) => readFileSync(new URL(rel, import.meta.url), "utf8"))
      .join("\n");
    expect(sources).not.toMatch(/Stop-Process/);
    expect(sources).not.toMatch(/taskkill/i);
    expect(sources).not.toMatch(/process\.kill\(/);
    expect(existsSync(cfg.workerLockFile) || true).toBe(true);
  });
});

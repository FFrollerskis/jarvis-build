#!/usr/bin/env node
/**
 * Jarvis worker recovery supervisor.
 *
 * Authorised by the scope update on control-issue task WORKER-SELF-RECOVERY-20260907:
 * ONE lightweight recovery supervisor, narrowly superseding the "no second
 * scheduler" rule for recovery only - never a second implementation worker.
 *
 * What it does:
 *   - observes the existing JarvisClaudeWorker scheduled task and the worker's
 *     own health journal / lock (read-only),
 *   - polls the SAME trusted control issue for a strictly allowlisted control
 *     schema (STATUS and RESTART_WORKER only),
 *   - starts the existing scheduled task when the worker is provably a dead
 *     queue consumer, within a daily budget and with backoff,
 *   - posts deduplicated receipts.
 *
 * What it deliberately CANNOT do:
 *   - execute implementation tasks, edit repository files or run arbitrary
 *     shell input (there is no code path that interpolates comment text into a
 *     command),
 *   - kill or force-terminate any process, including the worker,
 *   - expand credentials or scopes: it reuses the existing `gh` auth,
 *   - open a network port or accept commands from anywhere except comments by
 *     the verified repo owner on the configured control issue.
 */

import { existsSync, mkdirSync, appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

import { loadSupervisorConfig, WORKER_VERSION } from "./lib/config.mjs";
import { HEALTH_EVENTS, emitHealth, readHealth, sanitize } from "./lib/health.mjs";
import { loadState, saveStateAtomic } from "./lib/state.mjs";
import { acquireLock, releaseLock, readLock, heartbeat } from "./lib/lock.mjs";
import { validateControlCommand } from "./lib/trust.mjs";
import { shouldPostStatus, statusKey, computeBackoff } from "./lib/reconcile.mjs";
import { verifyAuth, fetchIssueComments, postComment } from "./lib/github.mjs";
import { getScheduledTask, startScheduledTask } from "./lib/wintask.mjs";
import { assessWorker, planAutonomousAction, planCommandedRestart, WORKER_VERDICT } from "./lib/supervise.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.JARVIS_SUPERVISOR_CONFIG || join(HERE, "supervisor.config.json");
export const SUPERVISOR_VERSION = "1.0.0";

const EXIT = Object.freeze({ OK: 0, BLOCKED: 3, TRANSIENT: 4, FATAL: 1 });

function log(cfg, line) {
  const stamped = `[${new Date().toISOString()}] ${sanitize(line)}`;
  console.log(stamped);
  try {
    mkdirSync(cfg.logDir, { recursive: true });
    appendFileSync(join(cfg.logDir, `supervisor-${new Date().toISOString().slice(0, 10)}.log`), stamped + "\n", "utf8");
  } catch { /* logging failure must not crash recovery */ }
}

function defaultSupervisorState() {
  return { journal: [], executed_command_ids: [], posted_status_keys: {}, last_restart_at: null, last_poll_at: null, consecutive_poll_failures: 0 };
}

/** Durable, atomic, append-only journal. Idempotency lives here. */
function appendJournal(state, entry) {
  state.journal = [...(state.journal ?? []), entry].slice(-500);
  return entry;
}

function postReceipt(cfg, state, { commandId, command, observed, action, result, detail }) {
  const key = statusKey({ taskId: commandId ?? "autonomous", phase: command ?? "autonomous", reason: `${observed}/${action}/${result}` });
  const decision = shouldPostStatus(state.posted_status_keys, key, Date.now(), cfg.statusRepeatHours * 3_600_000);
  if (!decision.post) {
    log(cfg, `Receipt suppressed (${decision.reason}) for ${command ?? "autonomous"}/${observed}/${action}`);
    return { posted: false };
  }
  const body = [
    "SUPERVISOR_RECEIPT",
    `COMMAND_ID=${commandId ?? "none (autonomous)"}`,
    `COMMAND=${command ?? "none (autonomous)"}`,
    `SUPERVISOR_VERSION=${SUPERVISOR_VERSION}`,
    `HOST=${cfg.host}`,
    `TARGET_WORKER=${cfg.workerTaskName}`,
    `OBSERVED_STATE=${observed}`,
    `ACTION=${action}`,
    `RESULT=${result}`,
    "",
    detail ?? "",
    "",
    "Posted by the local recovery supervisor. It does not execute implementation tasks,",
    "does not merge, and never terminates processes."
  ].join("\n");
  const res = postComment(cfg, body, cfg.logDir);
  if (res.ok) {
    state.posted_status_keys[key] = new Date().toISOString();
    log(cfg, `Posted receipt ${res.commentId} (${command ?? "autonomous"}/${action}/${result})`);
  } else {
    log(cfg, `Failed to post receipt: ${res.error}`);
  }
  return { posted: res.ok, ...res };
}

/** Gather independent evidence about the worker. Read-only. */
function observeWorker(cfg) {
  const healthEvents = readHealth(cfg.workerHealthFile);
  const lockInfo = readLock(cfg.workerLockFile);
  const scheduledTask = getScheduledTask(cfg.workerTaskName);
  const workerDisabled = existsSync(join(cfg.workerRoot, "disabled.flag"));
  return {
    healthEvents,
    lockInfo,
    scheduledTask,
    workerDisabled,
    assessment: assessWorker({
      healthEvents,
      lockInfo,
      scheduledTask,
      workerDisabled,
      nowMs: Date.now(),
      deadWorkerMs: cfg.deadWorkerMinutes * 60_000
    })
  };
}

/**
 * Perform a restart. This ONLY starts the existing scheduled task - there is no
 * kill, no force, no in-place rewrite. Recorded in the journal BEFORE the start
 * so a crash between "started" and "state saved" reconciles as already-done
 * rather than restarting twice.
 */
function performRestart(cfg, state, { commandId, reason }) {
  const entry = appendJournal(state, {
    ts: new Date().toISOString(),
    action: "restart_started",
    command_id: commandId ?? null,
    reason,
    worker_task: cfg.workerTaskName
  });
  state.last_restart_at = entry.ts;
  if (commandId && !state.executed_command_ids.includes(commandId)) {
    state.executed_command_ids = [...state.executed_command_ids, commandId].slice(-500);
  }
  // Persist the intent BEFORE acting: a crash after this point is reconciled as
  // "already restarted", never as "restart again".
  saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);

  const res = startScheduledTask(cfg.workerTaskName);
  appendJournal(state, {
    ts: new Date().toISOString(),
    action: "restart_result",
    command_id: commandId ?? null,
    ok: res.ok,
    error: res.ok ? null : sanitize(res.error)
  });
  saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
  emitHealth(cfg.healthFile, HEALTH_EVENTS.SUPERVISOR_ACTION, { action: "restart", ok: res.ok, command_id: commandId ?? null });
  return res;
}

async function cmdRun(cfg, { dryRun }) {
  emitHealth(cfg.healthFile, HEALTH_EVENTS.SUPERVISOR_POLLED, { supervisor_version: SUPERVISOR_VERSION, pid: process.pid });

  if (existsSync(cfg.disabledFlagFile) && !dryRun) {
    log(cfg, "Supervisor is disabled (supervisor-disabled.flag present) - exiting cleanly.");
    return EXIT.OK;
  }

  const loaded = loadState(cfg.stateFile, cfg.stateBackupFile);
  const state = loaded.state
    ? { ...defaultSupervisorState(), ...loaded.state }
    : null;
  if (!state) {
    log(cfg, `FATAL: supervisor state and backup are both unreadable (primary=${loaded.primary_error}, backup=${loaded.backup_error}). Refusing to run rather than replay executed commands.`);
    return EXIT.BLOCKED;
  }
  if (loaded.recovered_from_backup) log(cfg, "WARNING: supervisor state recovered from backup; command history preserved.");

  // Serialise supervisor with itself. Concurrent invocations must not double-start.
  const lock = acquireLock(cfg.lockFile, { phase: "supervise" });
  if (!lock.acquired) {
    log(cfg, `Another supervisor instance is active (${lock.verdict?.reason}) - exiting cleanly.`);
    return EXIT.OK;
  }

  try {
    heartbeat(cfg.lockFile, { phase: "observe" });
    const observation = observeWorker(cfg);
    log(cfg, `Worker verdict: ${observation.assessment.verdict} (${observation.assessment.reason}); windows task state=${observation.scheduledTask?.state ?? "n/a"} lastTaskResult=${observation.scheduledTask?.lastTaskResult ?? "n/a"}`);

    // --- control commands (STATUS / RESTART_WORKER) ---
    const auth = verifyAuth();
    let commands = [];
    if (!auth.ok) {
      state.consecutive_poll_failures = (state.consecutive_poll_failures ?? 0) + 1;
      log(cfg, `GitHub auth unavailable: ${auth.error} (consecutive failures: ${state.consecutive_poll_failures})`);
    } else {
      try {
        const comments = fetchIssueComments(cfg);
        state.consecutive_poll_failures = 0;
        state.last_poll_at = new Date().toISOString();
        commands = comments
          .map((c) => ({
            comment: c,
            v: validateControlCommand(c, {
              trustedAuthor: cfg.trustedAuthor,
              host: cfg.host,
              workerTaskName: cfg.workerTaskName,
              nowMs: Date.now(),
              executedCommandIds: state.executed_command_ids
            })
          }))
          .filter((x) => x.v.ok);
      } catch (err) {
        state.consecutive_poll_failures = (state.consecutive_poll_failures ?? 0) + 1;
        log(cfg, `Control issue poll failed: ${sanitize(err.message)} (consecutive failures: ${state.consecutive_poll_failures})`);
      }
    }

    // Bounded backoff for transient poll failures: never a tight loop, never silent.
    if (state.consecutive_poll_failures > 0) {
      const bo = computeBackoff(state.consecutive_poll_failures, {
        maxAttempts: cfg.maxAttempts,
        baseMs: cfg.backoffBaseMinutes * 60_000,
        maxMs: 6 * 3_600_000
      });
      if (bo.exhausted) {
        postReceipt(cfg, state, {
          commandId: null,
          command: null,
          observed: observation.assessment.verdict,
          action: "none",
          result: "poll_failing",
          detail: `The supervisor has failed to poll the control issue ${state.consecutive_poll_failures} consecutive times. GitHub auth or network is unavailable from this host. The supervisor cannot recover a queue it cannot read.`
        });
        saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
        return EXIT.TRANSIENT;
      }
    }

    // Oldest first, so a replayed newer command cannot jump the queue.
    commands.sort((a, b) => Date.parse(a.comment.created_at) - Date.parse(b.comment.created_at));

    for (const { v } of commands) {
      if (dryRun) {
        log(cfg, `Dry run: would execute ${v.command} (COMMAND_ID=${v.commandId}). No action taken.`);
        continue;
      }
      if (v.command === "STATUS") {
        state.executed_command_ids = [...state.executed_command_ids, v.commandId].slice(-500);
        appendJournal(state, { ts: new Date().toISOString(), action: "status_reported", command_id: v.commandId });
        saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
        postReceipt(cfg, state, {
          commandId: v.commandId,
          command: "STATUS",
          observed: observation.assessment.verdict,
          action: "report",
          result: "ok",
          detail: [
            `WORKER_VERDICT=${observation.assessment.verdict} (${observation.assessment.reason})`,
            `WINDOWS_TASK_STATE=${observation.scheduledTask?.state ?? "unknown"} (this is NOT queue health)`,
            `WINDOWS_LAST_TASK_RESULT=${observation.scheduledTask?.lastTaskResult ?? "unknown"}`,
            `LAST_SCHEDULER_INVOCATION=${observation.assessment.health.last_scheduler_invocation ?? "never"}`,
            `LAST_QUEUE_POLL=${observation.assessment.health.last_queue_poll ?? "never"}`,
            `LAST_DISPATCH_STARTED=${observation.assessment.health.last_dispatch_started ?? "never"}`,
            `LAST_HEARTBEAT=${observation.assessment.health.last_heartbeat ?? "never"}`,
            `LAST_COMPLETION_CONFIRMED=${observation.assessment.health.last_completion_confirmed ?? "never"}`,
            `WORKER_VERSION=${WORKER_VERSION}`
          ].join("\n")
        });
        saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
        continue;
      }

      // RESTART_WORKER
      const plan = planCommandedRestart({ assessment: observation.assessment });
      if (plan.action === "restart") {
        const res = performRestart(cfg, state, { commandId: v.commandId, reason: plan.reason });
        postReceipt(cfg, state, {
          commandId: v.commandId,
          command: "RESTART_WORKER",
          observed: observation.assessment.verdict,
          action: "restart",
          result: res.ok ? "started" : "failed",
          detail: res.ok
            ? `Started scheduled task ${cfg.workerTaskName}. No process was terminated. Confirm real recovery via the worker's next queue poll, not via this receipt.`
            : `Failed to start scheduled task: ${sanitize(res.error)}. This is a host action the supervisor cannot perform - check the task registration and the account's rights.`
        });
      } else {
        // Deferred or blocked: record the command as handled so it is not replayed,
        // but be explicit that no restart happened.
        state.executed_command_ids = [...state.executed_command_ids, v.commandId].slice(-500);
        appendJournal(state, { ts: new Date().toISOString(), action: `restart_${plan.action}`, command_id: v.commandId, reason: plan.reason });
        postReceipt(cfg, state, {
          commandId: v.commandId,
          command: "RESTART_WORKER",
          observed: observation.assessment.verdict,
          action: plan.action,
          result: "no_restart_performed",
          detail: plan.reason
        });
      }
      saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
    }

    // --- autonomous recovery of a demonstrably dead worker ---
    if (!dryRun) {
      const plan = planAutonomousAction({
        assessment: observation.assessment,
        journal: state.journal,
        nowMs: Date.now(),
        budgetPerDay: cfg.restartBudgetPerDay,
        backoffMs: cfg.backoffBaseMinutes * 60_000,
        lastRestartAt: state.last_restart_at
      });
      log(cfg, `Autonomous plan: ${plan.action} (${plan.reason})`);

      if (plan.action === "restart") {
        const res = performRestart(cfg, state, { commandId: null, reason: plan.reason });
        postReceipt(cfg, state, {
          commandId: null, command: null,
          observed: observation.assessment.verdict,
          action: "autonomous_restart",
          result: res.ok ? "started" : "failed",
          detail: res.ok
            ? `The worker was a dead queue consumer (${plan.reason}). Started ${cfg.workerTaskName}. Nothing was terminated.`
            : `Could not start ${cfg.workerTaskName}: ${sanitize(res.error)}`
        });
      } else if (plan.action === "report_blocked") {
        postReceipt(cfg, state, {
          commandId: null, command: null,
          observed: observation.assessment.verdict,
          action: "none",
          result: "blocked",
          detail: `${plan.reason}. No restart was attempted and no process was terminated.`
        });
        saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
        return EXIT.BLOCKED;
      }
    }

    saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile);
    return observation.assessment.verdict === WORKER_VERDICT.HEALTHY || observation.assessment.verdict === WORKER_VERDICT.BUSY
      ? EXIT.OK
      : EXIT.TRANSIENT;
  } finally {
    releaseLock(cfg.lockFile);
  }
}

function cmdStatus(cfg) {
  const observation = observeWorker(cfg);
  const loaded = loadState(cfg.stateFile, cfg.stateBackupFile);
  console.log(JSON.stringify({
    supervisor_version: SUPERVISOR_VERSION,
    host: cfg.host,
    worker_task: cfg.workerTaskName,
    worker_verdict: observation.assessment.verdict,
    worker_reason: observation.assessment.reason,
    windows_task: observation.scheduledTask,
    worker_health: observation.assessment.health,
    restarts_recorded: (loaded.state?.journal ?? []).filter((e) => e.action === "restart_started").length,
    last_restart_at: loaded.state?.last_restart_at ?? null,
    last_poll_at: loaded.state?.last_poll_at ?? null
  }, null, 2));
  return EXIT.OK;
}

async function main() {
  const cfg = loadSupervisorConfig(CONFIG_PATH, HERE);
  if (!cfg.host) cfg.host = hostname();
  const args = process.argv.slice(2);
  const sub = args[0] && !args[0].startsWith("--") ? args[0] : "run";
  const dryRun = args.includes("--dry-run");
  switch (sub) {
    case "status": return cmdStatus(cfg);
    case "enable": try { unlinkSync(cfg.disabledFlagFile); } catch { /* already enabled */ } console.log("Supervisor enabled."); return EXIT.OK;
    case "disable": writeFileSync(cfg.disabledFlagFile, `disabled at ${new Date().toISOString()}\n`); console.log("Supervisor disabled."); return EXIT.OK;
    case "run":
    default: return cmdRun(cfg, { dryRun });
  }
}

main()
  .then((code) => { process.exitCode = code ?? EXIT.OK; })
  .catch((err) => {
    console.error(`[${new Date().toISOString()}] FATAL: ${sanitize(err.message)}`);
    process.exitCode = EXIT.FATAL;
  });

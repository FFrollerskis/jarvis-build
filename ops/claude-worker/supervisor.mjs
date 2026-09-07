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
 *
 * D126 review blocker 5 - the restart protocol was rebuilt around durable
 * intent -> effect -> result -> receipt stages:
 *
 *   - commanded restarts no longer bypass the daily budget and backoff,
 *   - commands are validated AT THE POINT OF EXECUTION, not once for the whole
 *     batch, so two comments carrying the same COMMAND_ID in one poll can no
 *     longer both execute, and expiry is re-checked per action,
 *   - the worker is re-observed before every action, so a decision is never made
 *     from an observation taken before the previous action changed the world,
 *   - a crash between "intent recorded" and "start confirmed" is reconciled from
 *     actual host evidence instead of being lost forever,
 *   - a receipt that failed to post is retried WITHOUT repeating the effect,
 *   - a DEFERRED request is preserved until it is safely acted on or explicitly
 *     expires, instead of being consumed and silently dropped.
 */

import { existsSync, mkdirSync, appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { loadSupervisorConfig, WORKER_VERSION } from "./lib/config.mjs";
import { HEALTH_EVENTS, emitHealth, readHealth, sanitize } from "./lib/health.mjs";
import { loadState, saveStateAtomic } from "./lib/state.mjs";
import { acquireLock, releaseLock, readLock, heartbeat, holdsLock } from "./lib/lock.mjs";
import { validateControlCommand } from "./lib/trust.mjs";
import { shouldPostStatus, statusKey, computeBackoff } from "./lib/reconcile.mjs";
import { verifyAuth, fetchIssueComments, postComment } from "./lib/github.mjs";
import { getScheduledTask, startScheduledTask } from "./lib/wintask.mjs";
import {
  assessWorker,
  planAutonomousAction,
  planCommandedRestart,
  planIntentReconciliation,
  INTENT_STAGE,
  WORKER_VERDICT
} from "./lib/supervise.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.JARVIS_SUPERVISOR_CONFIG || join(HERE, "supervisor.config.json");
export const SUPERVISOR_VERSION = "1.1.0";

const EXIT = Object.freeze({ OK: 0, BLOCKED: 3, TRANSIENT: 4, FATAL: 1 });

function log(cfg, line) {
  const stamped = `[${new Date().toISOString()}] ${sanitize(line)}`;
  console.log(stamped);
  try {
    mkdirSync(cfg.logDir, { recursive: true });
    appendFileSync(join(cfg.logDir, `supervisor-${new Date().toISOString().slice(0, 10)}.log`), stamped + "\n", "utf8");
  } catch { /* logging failure must not crash recovery */ }
}

/** Every supervisor state write requires verified ownership of the supervisor lock. */
function persist(cfg, state, token) {
  if (!holdsLock(cfg.lockFile, token)) {
    throw new Error("refusing to write supervisor state: this process no longer owns the supervisor lock.");
  }
  return saveStateAtomic(cfg.stateFile, state, cfg.stateBackupFile, { schema: "supervisor" });
}

/** Durable, atomic, append-only journal. Idempotency lives here. */
function appendJournal(state, entry) {
  state.journal = [...(state.journal ?? []), entry].slice(-500);
  return entry;
}

function markExecuted(state, commandId) {
  if (!commandId) return;
  if (!state.executed_command_ids.includes(commandId)) {
    state.executed_command_ids = [...state.executed_command_ids, commandId].slice(-500);
  }
  if (state.deferred_commands[commandId]) delete state.deferred_commands[commandId];
}

function postReceipt(cfg, state, { commandId, command, observed, action, result, detail }) {
  const key = statusKey({ taskId: commandId ?? "autonomous", phase: command ?? "autonomous", reason: `${observed}/${action}/${result}` });
  const decision = shouldPostStatus(state.posted_status_keys, key, Date.now(), cfg.statusRepeatHours * 3_600_000);
  if (!decision.post) {
    log(cfg, `Receipt suppressed (${decision.reason}) for ${command ?? "autonomous"}/${observed}/${action}`);
    return { posted: false, suppressed: true };
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
  const res = postComment(cfg, body, cfg.scratchRoot);
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

/** ---------------- durable intent staging ---------------- */

function beginIntent(cfg, state, token, { commandId, reason }) {
  const createdAt = new Date().toISOString();
  const intent = {
    intent_id: randomUUID(),
    command_id: commandId ?? null,
    kind: "restart",
    reason,
    stage: INTENT_STAGE.INTENT,
    created_at: createdAt,
    host: cfg.host,
    worker_task: cfg.workerTaskName,
    result: null,
    receipt_posted: false
  };
  state.pending_intent = intent;
  appendJournal(state, {
    ts: createdAt,
    action: "restart_started",
    intent_id: intent.intent_id,
    command_id: commandId ?? null,
    reason,
    worker_task: cfg.workerTaskName
  });
  state.last_restart_at = createdAt;
  markExecuted(state, commandId);
  // Persist the intent BEFORE acting: a crash after this point is reconciled
  // from host evidence, never guessed and never silently lost.
  persist(cfg, state, token);
  return intent;
}

/**
 * Attempt the effect for an intent that has not yet produced a durable result.
 * Only ever called when reconciliation has established that the effect has NOT
 * already happened.
 */
function driveIntent(cfg, state, token, intent) {
  intent.stage = INTENT_STAGE.EFFECT_ATTEMPTED;
  intent.effect_attempted_at = new Date().toISOString();
  state.pending_intent = intent;
  persist(cfg, state, token);

  const res = startScheduledTask(cfg.workerTaskName);

  intent.stage = INTENT_STAGE.RESULT_RECORDED;
  intent.result_recorded_at = new Date().toISOString();
  intent.result = { ok: res.ok, error: res.ok ? null : sanitize(res.error ?? "unknown error") };
  state.pending_intent = intent;
  appendJournal(state, {
    ts: intent.result_recorded_at,
    action: "restart_result",
    intent_id: intent.intent_id,
    command_id: intent.command_id,
    ok: res.ok,
    error: intent.result.error
  });
  persist(cfg, state, token);
  emitHealth(cfg.healthFile, HEALTH_EVENTS.SUPERVISOR_ACTION, {
    action: "restart", ok: res.ok, command_id: intent.command_id, intent_id: intent.intent_id
  });
  return res;
}

/** Post the intent's receipt and clear it only once the receipt is durable. */
function settleIntent(cfg, state, token, intent, { observed, detail, result }) {
  const receipt = postReceipt(cfg, state, {
    commandId: intent.command_id,
    command: intent.command_id ? "RESTART_WORKER" : null,
    observed,
    action: intent.command_id ? "restart" : "autonomous_restart",
    result,
    detail
  });
  if (receipt.posted || receipt.suppressed) {
    intent.receipt_posted = true;
    appendJournal(state, {
      ts: new Date().toISOString(),
      action: "intent_settled",
      intent_id: intent.intent_id,
      command_id: intent.command_id,
      result
    });
    state.pending_intent = null;
  } else {
    // Receipt failed: keep the intent so the NEXT run retries the receipt only.
    intent.receipt_posted = false;
    state.pending_intent = intent;
  }
  persist(cfg, state, token);
  return receipt;
}

/**
 * Re-drive whatever a crash left half-done, from actual host evidence.
 * Never repeats an effect that demonstrably already happened.
 */
function reconcilePendingIntent(cfg, state, token, observation) {
  const intent = state.pending_intent;
  if (!intent) return { handled: false };

  const plan = planIntentReconciliation({
    intent,
    nowMs: Date.now(),
    workerHealth: observation.assessment.health
  });
  log(cfg, `Pending intent ${intent.intent_id} (stage=${intent.stage}): ${plan.action} - ${plan.reason}`);

  if (plan.action === "clear") {
    state.pending_intent = null;
    persist(cfg, state, token);
    return { handled: true };
  }

  if (plan.action === "post_receipt") {
    settleIntent(cfg, state, token, intent, {
      observed: observation.assessment.verdict,
      result: intent.result?.ok ? "started" : "failed",
      detail: intent.result?.ok
        ? `Recovered receipt for an interrupted run. Started scheduled task ${cfg.workerTaskName}; the effect was already durable, so it was NOT repeated.`
        : `Recovered receipt for an interrupted run. The start had already FAILED: ${intent.result?.error}. The effect was not repeated.`
    });
    return { handled: true };
  }

  if (plan.action === "confirm") {
    intent.stage = INTENT_STAGE.RESULT_RECORDED;
    intent.result = { ok: true, error: null, reconciled_from_host_evidence: true };
    intent.result_recorded_at = new Date().toISOString();
    appendJournal(state, {
      ts: intent.result_recorded_at,
      action: "restart_result",
      intent_id: intent.intent_id,
      command_id: intent.command_id,
      ok: true,
      reconciled: true,
      reason: plan.reason
    });
    persist(cfg, state, token);
    settleIntent(cfg, state, token, intent, {
      observed: observation.assessment.verdict,
      result: "started",
      detail: `Reconciled after an interrupted run: ${plan.reason}. The effect was NOT repeated.`
    });
    return { handled: true };
  }

  if (plan.action === "retry_effect") {
    const res = driveIntent(cfg, state, token, intent);
    settleIntent(cfg, state, token, intent, {
      observed: observation.assessment.verdict,
      result: res.ok ? "started" : "failed",
      detail: res.ok
        ? `Re-drove an interrupted restart intent (${plan.reason}). This is the SAME intent, so it consumes no additional restart budget. Nothing was terminated.`
        : `Re-drove an interrupted restart intent and the start FAILED: ${sanitize(res.error)}. This is a host action the supervisor cannot perform - check the task registration and the account's rights.`
    });
    return { handled: true };
  }

  // uncertain
  postReceipt(cfg, state, {
    commandId: intent.command_id,
    command: intent.command_id ? "RESTART_WORKER" : null,
    observed: observation.assessment.verdict,
    action: "reconcile",
    result: "uncertain",
    detail: `${plan.reason}. The effect was NOT repeated and nothing was terminated; the intent stays pending until it can be decided from evidence.`
  });
  persist(cfg, state, token);
  return { handled: true, uncertain: true };
}

/** ---------------- run ---------------- */

async function cmdRun(cfg, { dryRun }) {
  emitHealth(cfg.healthFile, HEALTH_EVENTS.SUPERVISOR_POLLED, { supervisor_version: SUPERVISOR_VERSION, pid: process.pid });

  if (existsSync(cfg.disabledFlagFile) && !dryRun) {
    log(cfg, "Supervisor is disabled (supervisor-disabled.flag present) - exiting cleanly.");
    return EXIT.OK;
  }

  // Serialise supervisor with itself BEFORE any state is read as authoritative.
  const lock = acquireLock(cfg.lockFile, { phase: "supervise" });
  if (!lock.acquired) {
    log(cfg, `Another supervisor instance is active (${lock.verdict?.reason}) - exiting cleanly.`);
    return EXIT.OK;
  }
  try {
    return await runOwned(cfg, lock.token, { dryRun });
  } finally {
    releaseLock(cfg.lockFile, lock.token);
  }
}

async function runOwned(cfg, token, { dryRun }) {
  const loaded = loadState(cfg.stateFile, cfg.stateBackupFile, { schema: "supervisor" });
  if (!loaded.state) {
    log(cfg, `FATAL: supervisor state and backup are both unusable (primary=${loaded.primary_error}, backup=${loaded.backup_error}). Refusing to run rather than replay executed commands.`);
    return EXIT.BLOCKED;
  }
  const state = loaded.state;
  state.supervisor_version = SUPERVISOR_VERSION;
  if (loaded.first_run) log(cfg, "First run: no supervisor state has ever existed on this host.");
  if (loaded.recovered_from_backup) log(cfg, "WARNING: supervisor state recovered from backup; command history preserved and the backup is not overwritten until the primary is valid again.");

  heartbeat(cfg.lockFile, { token, phase: "observe" });
  let observation = observeWorker(cfg);
  log(cfg, `Worker verdict: ${observation.assessment.verdict} (${observation.assessment.reason}); windows task state=${observation.scheduledTask?.state ?? "n/a"} lastTaskResult=${observation.scheduledTask?.lastTaskResult ?? "n/a"}`);

  // --- 1. finish whatever a previous run left half-done ---
  if (!dryRun) {
    reconcilePendingIntent(cfg, state, token, observation);
    observation = observeWorker(cfg);
  } else if (state.pending_intent) {
    log(cfg, `Dry run: a pending intent exists (${state.pending_intent.intent_id}, stage=${state.pending_intent.stage}). Nothing was reconciled.`);
  }

  // --- 2. control commands (STATUS / RESTART_WORKER) ---
  const auth = verifyAuth();
  let candidates = [];
  if (!auth.ok) {
    state.consecutive_poll_failures = (state.consecutive_poll_failures ?? 0) + 1;
    log(cfg, `GitHub auth unavailable: ${auth.error} (consecutive failures: ${state.consecutive_poll_failures})`);
  } else {
    try {
      const comments = fetchIssueComments(cfg);
      state.consecutive_poll_failures = 0;
      state.last_poll_at = new Date().toISOString();
      // Oldest first, so a replayed newer command cannot jump the queue.
      candidates = comments
        .filter((c) => typeof c?.body === "string")
        .sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? ""));
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
      if (!dryRun) {
        postReceipt(cfg, state, {
          commandId: null,
          command: null,
          observed: observation.assessment.verdict,
          action: "none",
          result: "poll_failing",
          detail: `The supervisor has failed to poll the control issue ${state.consecutive_poll_failures} consecutive times. GitHub auth or network is unavailable from this host. The supervisor cannot recover a queue it cannot read.`
        });
        persist(cfg, state, token);
      }
      return EXIT.TRANSIENT;
    }
  }

  for (const comment of candidates) {
    // BLOCKER 5: validated HERE, immediately before acting, against the state as
    // it stands right now - so two comments carrying the same COMMAND_ID in one
    // poll cannot both execute, and an expiry that elapses mid-batch is caught.
    const v = validateControlCommand(comment, {
      trustedAuthor: cfg.trustedAuthor,
      host: cfg.host,
      workerTaskName: cfg.workerTaskName,
      nowMs: Date.now(),
      executedCommandIds: state.executed_command_ids
    });
    if (!v.ok) continue;

    if (dryRun) {
      log(cfg, `Dry run: would execute ${v.command} (COMMAND_ID=${v.commandId}). No action taken.`);
      continue;
    }

    // Fresh observation per action: the previous command may have changed the world.
    observation = observeWorker(cfg);

    if (v.command === "STATUS") {
      markExecuted(state, v.commandId);
      appendJournal(state, { ts: new Date().toISOString(), action: "status_reported", command_id: v.commandId });
      persist(cfg, state, token);
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
          `WINDOWS_TASK_QUERY_OK=${observation.scheduledTask?.query_failed ? "false" : "true"}`,
          `LAST_SCHEDULER_INVOCATION=${observation.assessment.health.last_scheduler_invocation ?? "never"}`,
          `LAST_QUEUE_POLL=${observation.assessment.health.last_queue_poll ?? "never"}`,
          `LAST_DISPATCH_STARTED=${observation.assessment.health.last_dispatch_started ?? "never"}`,
          `LAST_HEARTBEAT=${observation.assessment.health.last_heartbeat ?? "never"}`,
          `LAST_COMPLETION_CONFIRMED=${observation.assessment.health.last_completion_confirmed ?? "never"}`,
          `PENDING_INTENT=${state.pending_intent ? `${state.pending_intent.intent_id} (${state.pending_intent.stage})` : "none"}`,
          `DEFERRED_COMMANDS=${Object.keys(state.deferred_commands).length}`,
          `WORKER_VERSION=${WORKER_VERSION}`
        ].join("\n")
      });
      persist(cfg, state, token);
      continue;
    }

    // RESTART_WORKER - budget and backoff apply exactly as on the autonomous path.
    const plan = planCommandedRestart({
      assessment: observation.assessment,
      journal: state.journal,
      nowMs: Date.now(),
      budgetPerDay: cfg.restartBudgetPerDay,
      backoffMs: cfg.backoffBaseMinutes * 60_000,
      lastRestartAt: state.last_restart_at
    });

    if (plan.action === "restart") {
      const intent = beginIntent(cfg, state, token, { commandId: v.commandId, reason: plan.reason });
      const res = driveIntent(cfg, state, token, intent);
      settleIntent(cfg, state, token, intent, {
        observed: observation.assessment.verdict,
        result: res.ok ? "started" : "failed",
        detail: res.ok
          ? `Started scheduled task ${cfg.workerTaskName}. No process was terminated. Confirm real recovery via the worker's next queue poll, not via this receipt.`
          : `Failed to start scheduled task: ${sanitize(res.error)}. This is a host action the supervisor cannot perform - check the task registration and the account's rights.`
      });
      continue;
    }

    if (plan.action === "defer") {
      // BLOCKER 5: a deferred request is PRESERVED, not consumed. It stays out of
      // executed_command_ids, so the next poll re-evaluates it against a fresh
      // observation until it can be acted on safely or it expires.
      const existing = state.deferred_commands[v.commandId];
      state.deferred_commands[v.commandId] = {
        command: v.command,
        first_deferred_at: existing?.first_deferred_at ?? new Date().toISOString(),
        last_deferred_at: new Date().toISOString(),
        expires_at: v.expiresAt,
        reason: plan.reason,
        deferrals: (existing?.deferrals ?? 0) + 1
      };
      appendJournal(state, { ts: new Date().toISOString(), action: "restart_deferred", command_id: v.commandId, reason: plan.reason });
      persist(cfg, state, token);
      postReceipt(cfg, state, {
        commandId: v.commandId,
        command: "RESTART_WORKER",
        observed: observation.assessment.verdict,
        action: "defer",
        result: "no_restart_performed_request_preserved",
        detail: `${plan.reason}\n\nThe request has NOT been consumed. It is re-evaluated on every supervisor poll until it can be acted on safely or until EXPIRES_AT=${v.expiresAt} passes.`
      });
      persist(cfg, state, token);
      continue;
    }

    // report_blocked: an explicit, final rejection - consume it.
    markExecuted(state, v.commandId);
    appendJournal(state, { ts: new Date().toISOString(), action: "restart_rejected", command_id: v.commandId, reason: plan.reason });
    persist(cfg, state, token);
    postReceipt(cfg, state, {
      commandId: v.commandId,
      command: "RESTART_WORKER",
      observed: observation.assessment.verdict,
      action: "report_blocked",
      result: "no_restart_performed",
      detail: `${plan.reason}\n\nNo process was terminated and no restart was attempted.`
    });
    persist(cfg, state, token);
  }

  if (!dryRun) sweepExpiredDeferrals(cfg, state, token, observation);

  // --- 3. autonomous recovery of a demonstrably dead worker ---
  if (!dryRun && !state.pending_intent) {
    observation = observeWorker(cfg);
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
      const intent = beginIntent(cfg, state, token, { commandId: null, reason: plan.reason });
      const res = driveIntent(cfg, state, token, intent);
      settleIntent(cfg, state, token, intent, {
        observed: observation.assessment.verdict,
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
      persist(cfg, state, token);
      return EXIT.BLOCKED;
    }
  }

  if (!dryRun) persist(cfg, state, token);
  return observation.assessment.verdict === WORKER_VERDICT.HEALTHY || observation.assessment.verdict === WORKER_VERDICT.BUSY
    ? EXIT.OK
    : EXIT.TRANSIENT;
}

/**
 * A deferred request is preserved, but not forever: once its own EXPIRES_AT has
 * passed it is closed out explicitly, with a receipt, so the operator learns
 * that it was never acted on rather than assuming it eventually ran.
 */
function sweepExpiredDeferrals(cfg, state, token, observation) {
  const now = Date.now();
  let changed = false;
  for (const [commandId, record] of Object.entries(state.deferred_commands ?? {})) {
    const expires = Date.parse(record?.expires_at ?? "");
    if (!Number.isFinite(expires) || expires > now) continue;
    delete state.deferred_commands[commandId];
    appendJournal(state, { ts: new Date().toISOString(), action: "restart_deferral_expired", command_id: commandId, reason: record?.reason ?? null });
    changed = true;
    postReceipt(cfg, state, {
      commandId,
      command: record?.command ?? "RESTART_WORKER",
      observed: observation.assessment.verdict,
      action: "expire",
      result: "never_performed",
      detail: [
        `This request was deferred ${record?.deferrals ?? 1} time(s) and has now passed its own EXPIRES_AT (${record?.expires_at}).`,
        `Last deferral reason: ${record?.reason ?? "unknown"}.`,
        "",
        "No restart was ever performed and nothing was terminated. Issue a fresh command if it is still wanted."
      ].join("\n")
    });
  }
  if (changed) persist(cfg, state, token);
}

function cmdStatus(cfg) {
  const observation = observeWorker(cfg);
  const loaded = loadState(cfg.stateFile, cfg.stateBackupFile, { schema: "supervisor" });
  console.log(JSON.stringify({
    supervisor_version: SUPERVISOR_VERSION,
    host: cfg.host,
    worker_task: cfg.workerTaskName,
    worker_verdict: observation.assessment.verdict,
    worker_reason: observation.assessment.reason,
    windows_task: observation.scheduledTask,
    worker_health: observation.assessment.health,
    state_source: loaded.source,
    state_readable: Boolean(loaded.state),
    restarts_recorded: (loaded.state?.journal ?? []).filter((e) => e.action === "restart_started").length,
    pending_intent: loaded.state?.pending_intent ?? null,
    deferred_commands: Object.keys(loaded.state?.deferred_commands ?? {}),
    last_restart_at: loaded.state?.last_restart_at ?? null,
    last_poll_at: loaded.state?.last_poll_at ?? null
  }, null, 2));
  return EXIT.OK;
}

async function main() {
  const cfg = loadSupervisorConfig(CONFIG_PATH, HERE);
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

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main()
    .then((code) => { process.exitCode = code ?? EXIT.OK; })
    .catch((err) => {
      console.error(`[${new Date().toISOString()}] FATAL: ${sanitize(err.message)}`);
      process.exitCode = EXIT.FATAL;
    });
}

export { main, cmdRun, runOwned, reconcilePendingIntent, sweepExpiredDeferrals };

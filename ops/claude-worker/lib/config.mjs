/**
 * Configuration loading for the worker and the supervisor.
 *
 * Config lives on the host (outside this repository) and may contain host paths.
 * It never contains credentials: all GitHub access goes through the `gh` CLI,
 * which manages its own stored auth. Nothing here reads or prints a token.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

export const WORKER_VERSION = "2.0.0";

const REQUIRED = ["repoOwner", "repoName", "controlIssue", "trustedAuthor", "repoPath"];

function resolveUnder(root, value, fallback) {
  const v = value ?? fallback;
  return isAbsolute(v) ? v : join(root, v);
}

export function loadWorkerConfig(configPath, root) {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}. Copy config.example.json to config.json and edit it first.`);
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  for (const key of REQUIRED) {
    if (!raw[key]) throw new Error(`config.json is missing required field: ${key}`);
  }

  const logDir = resolveUnder(root, raw.logDir, "logs");
  const scratchRoot = resolveUnder(root, raw.scratchRoot, "tmp");

  return {
    repoOwner: raw.repoOwner,
    repoName: raw.repoName,
    controlIssue: Number(raw.controlIssue),
    trustedAuthor: raw.trustedAuthor,
    repoPath: raw.repoPath,

    claudeCommand: raw.claudeCommand || "claude",
    claudeArgs: Array.isArray(raw.claudeArgs) ? raw.claudeArgs : ["-p", "--dangerously-skip-permissions"],
    claudeTimeoutMinutes: Number(raw.claudeTimeoutMinutes ?? 55),
    promptDelivery: raw.promptDelivery || "stdin",

    logDir,
    healthFile: resolveUnder(root, raw.healthFile, join(logDir, "health.jsonl")),
    stateFile: resolveUnder(root, raw.stateFile, "state.json"),
    stateBackupFile: resolveUnder(root, raw.stateBackupFile, "state.json.bak"),
    lockFile: resolveUnder(root, raw.lockFile, ".worker.lock"),
    disabledFlagFile: resolveUnder(root, raw.disabledFlagFile, "disabled.flag"),

    scratchRoot,
    quarantineRoot: resolveUnder(root, raw.quarantineRoot, join(scratchRoot, "quarantine")),
    manifestFile: resolveUnder(root, raw.manifestFile, join(logDir, "quarantine-manifest.jsonl")),

    heartbeatSeconds: Number(raw.heartbeatSeconds ?? 60),
    heartbeatTimeoutMinutes: Number(raw.heartbeatTimeoutMinutes ?? 15),
    maxAttempts: Number(raw.maxAttempts ?? 4),
    backoffBaseMinutes: Number(raw.backoffBaseMinutes ?? 10),
    backoffMaxHours: Number(raw.backoffMaxHours ?? 6),
    statusRepeatHours: Number(raw.statusRepeatHours ?? 6),

    workerTaskName: raw.workerTaskName || "JarvisClaudeWorker"
  };
}

export function loadSupervisorConfig(configPath, root) {
  if (!existsSync(configPath)) {
    throw new Error(`Supervisor config not found: ${configPath}. Copy supervisor.config.example.json and edit it.`);
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  for (const key of ["repoOwner", "repoName", "controlIssue", "trustedAuthor", "workerTaskName", "host"]) {
    if (!raw[key]) throw new Error(`supervisor.config.json is missing required field: ${key}`);
  }
  const logDir = resolveUnder(root, raw.logDir, "supervisor-logs");
  return {
    repoOwner: raw.repoOwner,
    repoName: raw.repoName,
    controlIssue: Number(raw.controlIssue),
    trustedAuthor: raw.trustedAuthor,
    workerTaskName: raw.workerTaskName,
    host: raw.host,

    // The supervisor observes the worker's own health journal and lock; it never
    // reads or writes the worker's task state.
    workerRoot: raw.workerRoot ?? root,
    workerHealthFile: resolveUnder(root, raw.workerHealthFile, join("logs", "health.jsonl")),
    workerLockFile: resolveUnder(root, raw.workerLockFile, ".worker.lock"),

    logDir,
    healthFile: resolveUnder(root, raw.supervisorHealthFile, join(logDir, "supervisor-health.jsonl")),
    stateFile: resolveUnder(root, raw.supervisorStateFile, "supervisor-state.json"),
    stateBackupFile: resolveUnder(root, raw.supervisorStateBackupFile, "supervisor-state.json.bak"),
    lockFile: resolveUnder(root, raw.supervisorLockFile, ".supervisor.lock"),
    disabledFlagFile: resolveUnder(root, raw.supervisorDisabledFlagFile, "supervisor-disabled.flag"),

    // A worker that has not polled the queue for this long, while the scheduled
    // task is supposedly enabled, is treated as a dead queue consumer.
    deadWorkerMinutes: Number(raw.deadWorkerMinutes ?? 30),
    restartBudgetPerDay: Number(raw.restartBudgetPerDay ?? 4),
    backoffBaseMinutes: Number(raw.backoffBaseMinutes ?? 10),
    maxAttempts: Number(raw.maxAttempts ?? 4),
    statusRepeatHours: Number(raw.statusRepeatHours ?? 6)
  };
}

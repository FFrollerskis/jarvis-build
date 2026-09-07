#!/usr/bin/env node
/**
 * Deployment CLI for the Jarvis worker + recovery supervisor.
 *
 * The engine lives in lib/deploy.mjs; this file only parses arguments, gathers
 * host facts (which scheduled tasks exist and what they actually execute) and
 * prints a machine-readable result.
 *
 * Subcommands:
 *   plan     --source <dir> --destination <dir>     what would change (read-only)
 *   stage    --source <dir> --destination <dir>     copy + hash-verify into staging/<version>
 *   activate --destination <dir> [--version <v>]    switch, verify, auto-rollback on failure
 *   apply-pending --destination <dir>               activate a deferred handoff, if quiescent
 *   bootstrap-handoff --destination <dir> [--version <v>] [--wait-seconds <n>]
 *                                                   wait for the EXACT legitimate parent to exit,
 *                                                   re-check quiescence, then activate. Runs from
 *                                                   the SOURCE tree, so it works before the payload
 *                                                   is switched and never needs the staged runner
 *                                                   to already be live (finding 3).
 *   rollback --destination <dir> [--backup-dir <d>] restore, enforcing manifest old hashes
 *   status   --destination <dir>                    what is deployed / staged / pending
 *   record-task-intent      --destination <dir> --task <n> [--pre-existing]
 *                                                   DURABLE intent, written BEFORE registering
 *   confirm-task-intent     --destination <dir> --task <n> --outcome <introduced|replaced|aborted>
 *   reconcile-task-intents  --destination <dir>     resolve crash-window intents from the host
 *
 * Nothing here registers, starts or stops a scheduled task. That stays in
 * install-task.ps1 / install-supervisor.ps1, so file deployment and schedule
 * changes are separately reviewable.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

import {
  PAYLOAD,
  OBSOLETE,
  planPayload,
  planObsolete,
  stageRelease,
  activateRelease,
  rollbackRelease,
  recordIntroducedTask,
  recordTaskIntent,
  confirmTaskIntent,
  reconcileTaskIntents,
  latestBackupDir,
  assessQuiescence,
  readPendingActivation,
  clearPendingActivation,
  runBootstrapHandoff
} from "./lib/deploy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const EXIT = Object.freeze({ OK: 0, DEFERRED: 5, FAILED: 1, BLOCKED: 3 });

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function defaultVersion() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

/**
 * What each registered scheduled task actually runs.
 *
 * `--tasks <file.json>` lets a test (and a non-Windows CI run) supply the same
 * shape without Task Scheduler. On Windows with no override we ask the host.
 * A FAILED query is reported as such and makes the installer keep every
 * obsolete file, because "I could not ask" is never "nothing references it".
 */
async function collectTaskCommandLines(args) {
  if (typeof args.tasks === "string") {
    const parsed = JSON.parse(readFileSync(args.tasks, "utf8"));
    return { ok: true, lines: parsed.map((t) => ({ taskName: t.taskName, command: t.command })) };
  }
  if (process.platform !== "win32") {
    return { ok: false, lines: [], error: "not running on Windows; scheduled tasks cannot be queried" };
  }
  const { getScheduledTaskDefinition } = await import("./lib/wintask.mjs");
  const names = String(args["task-names"] ?? "JarvisClaudeWorker,JarvisWorkerSupervisor").split(",").map((s) => s.trim()).filter(Boolean);
  const lines = [];
  for (const name of names) {
    const def = getScheduledTaskDefinition(name);
    if (def.query_failed) return { ok: false, lines: [], error: `${name}: ${def.error}` };
    if (!def.exists) continue;
    const command = (def.actions ?? [])
      .map((a) => [a.execute, a.arguments, a.workingDirectory].filter(Boolean).join(" "))
      .join(" | ");
    lines.push({ taskName: name, command, principal: { userId: def.userId, logonType: def.logonType, runLevel: def.runLevel } });
  }
  return { ok: true, lines };
}

async function exportTaskXml(taskName) {
  if (process.platform !== "win32") return null;
  const { ps } = await import("./lib/wintask.mjs");
  try {
    return ps(`Export-ScheduledTask -TaskName '${taskName}' -ErrorAction Stop`);
  } catch {
    return null;
  }
}

function out(obj, code) {
  console.log(JSON.stringify(obj, null, 2));
  return code;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sub = args._[0] ?? "status";
  const source = resolve(args.source ?? HERE);
  const destination = resolve(args.destination ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".jarvis-claude-worker"));

  if (sub === "plan") {
    const plan = planPayload({ sourceDir: source, destination, payload: PAYLOAD });
    const tasks = await collectTaskCommandLines(args);
    return out({
      subcommand: "plan",
      source,
      destination,
      complete: plan.complete,
      missing: plan.missing,
      changes: plan.entries.filter((e) => e.action !== "unchanged").map((e) => ({ file: e.rel, action: e.action })),
      unchanged: plan.entries.filter((e) => e.action === "unchanged").length,
      obsolete: planObsolete({ destination, obsolete: OBSOLETE, taskCommandLines: tasks.lines, taskQueryOk: tasks.ok }),
      task_query_ok: tasks.ok,
      task_query_error: tasks.error ?? null,
      quiescence: assessQuiescence({ destination })
    }, plan.complete ? EXIT.OK : EXIT.FAILED);
  }

  if (sub === "stage") {
    const version = String(args.version ?? defaultVersion());
    const staged = stageRelease({ sourceDir: source, destination, payload: PAYLOAD, version });
    return out({
      subcommand: "stage",
      version,
      staging_dir: staged.stagingDir,
      files: staged.manifest.files.length,
      changes: staged.manifest.files.filter((f) => f.action !== "unchanged").map((f) => ({ file: f.file, action: f.action })),
      note: "Nothing live has been touched. Run `activate` next."
    }, EXIT.OK);
  }

  if (sub === "activate" || sub === "apply-pending") {
    let version = args.version ? String(args.version) : null;
    if (sub === "apply-pending") {
      const pending = readPendingActivation(destination);
      if (!pending) return out({ subcommand: sub, applied: false, reason: "no pending activation" }, EXIT.OK);
      version = pending.version;
    }
    if (!version) return out({ subcommand: sub, error: "--version is required" }, EXIT.FAILED);

    const tasks = await collectTaskCommandLines(args);
    const result = activateRelease({
      destination,
      version,
      taskCommandLines: tasks.lines,
      taskQueryOk: tasks.ok,
      exportTask: process.platform === "win32" ? (name) => exportTaskXmlSync(name) : null,
      requireQuiescence: args["force-unquiesced"] !== true
    });
    if (result.ok && sub === "apply-pending") clearPendingActivation(destination);
    if (result.ok) clearPendingActivation(destination);
    return out({ subcommand: sub, ...result }, result.ok ? EXIT.OK : (result.deferred ? EXIT.DEFERRED : EXIT.FAILED));
  }

  if (sub === "bootstrap-handoff") {
    // FINDING 3: the non-circular half of the deferred activation. This runs
    // from the SOURCE tree with the node binary already on the host, so it is
    // runnable BEFORE the payload is switched and never assumes the newly
    // staged run-worker.ps1 is live. It waits for the EXACT captured parent
    // identity to exit, re-checks quiescence, then activates transactionally.
    // It never terminates anything and never touches task registration.
    const tasks = await collectTaskCommandLines(args);
    const waitSeconds = Number(args["wait-seconds"] ?? 1800);
    if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
      return out({ subcommand: sub, error: "--wait-seconds must be a positive number" }, EXIT.FAILED);
    }
    const result = runBootstrapHandoff({
      destination,
      version: args.version ? String(args.version) : null,
      waitDeadlineMs: waitSeconds * 1000,
      taskCommandLines: tasks.lines,
      taskQueryOk: tasks.ok,
      exportTask: process.platform === "win32" ? (name) => exportTaskXmlSync(name) : null
    });
    return out({ subcommand: sub, ...result }, result.ok ? EXIT.OK : (result.deferred ? EXIT.DEFERRED : EXIT.FAILED));
  }

  if (sub === "record-task-intent" || sub === "confirm-task-intent") {
    const taskName = String(args.task ?? "");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(taskName)) {
      return out({ subcommand: sub, error: "--task must be a plain scheduled task name" }, EXIT.FAILED);
    }
    const backupDir = args["backup-dir"] ? resolve(String(args["backup-dir"])) : null;
    const result = sub === "record-task-intent"
      ? recordTaskIntent({ destination, taskName, preExisting: args["pre-existing"] === true || args["pre-existing"] === "true", backupDir })
      : confirmTaskIntent({ destination, taskName, outcome: String(args.outcome ?? ""), backupDir });
    return out({ subcommand: sub, task: taskName, ...result }, result.ok ? EXIT.OK : EXIT.FAILED);
  }

  if (sub === "reconcile-task-intents") {
    const result = reconcileTaskIntents({
      destination,
      backupDir: args["backup-dir"] ? resolve(String(args["backup-dir"])) : null,
      queryTask: process.platform === "win32" ? (name) => queryTaskExistsSync(name) : () => ({ ok: false, error: "task query is only available on Windows" })
    });
    return out({ subcommand: sub, ...result }, result.ok ? EXIT.OK : EXIT.FAILED);
  }

  if (sub === "record-introduced-task") {
    const taskName = String(args.task ?? "");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(taskName)) {
      return out({ subcommand: sub, error: "--task must be a plain scheduled task name" }, EXIT.FAILED);
    }
    const result = recordIntroducedTask({
      destination,
      taskName,
      backupDir: args["backup-dir"] ? resolve(String(args["backup-dir"])) : null
    });
    return out({ subcommand: sub, task: taskName, ...result }, result.ok ? EXIT.OK : EXIT.FAILED);
  }

  if (sub === "rollback") {
    const backupDir = args["backup-dir"] ? resolve(String(args["backup-dir"])) : latestBackupDir(destination);
    if (!backupDir) return out({ subcommand: "rollback", error: "no backup directory found" }, EXIT.FAILED);
    const result = rollbackRelease({ destination, backupDir, reason: String(args.reason ?? "manual rollback") });
    return out({ subcommand: "rollback", backup_dir: backupDir, ...result }, result.ok ? EXIT.OK : EXIT.FAILED);
  }

  // status
  const plan = existsSync(source) ? planPayload({ sourceDir: source, destination, payload: PAYLOAD }) : null;
  return out({
    subcommand: "status",
    destination,
    deployed: existsSync(destination),
    pending_activation: readPendingActivation(destination),
    latest_backup: latestBackupDir(destination),
    quiescence: assessQuiescence({ destination }),
    drift: plan ? plan.entries.filter((e) => e.action !== "unchanged").map((e) => ({ file: e.rel, action: e.action })) : null
  }, EXIT.OK);
}

/**
 * `activateRelease` calls `exportTask` synchronously, so the async dynamic
 * import is resolved up front on Windows and cached here.
 */
let cachedPs = null;
function exportTaskXmlSync(taskName) {
  if (!cachedPs) return null;
  try {
    return cachedPs(`Export-ScheduledTask -TaskName '${taskName}' -ErrorAction Stop`);
  } catch {
    return null;
  }
}

/**
 * Does the host actually have this task registered right now?
 *
 * `{ ok: false }` means "I could not ask", which `reconcileTaskIntents` must
 * never read as "the task does not exist".
 */
let cachedGetTask = null;
function queryTaskExistsSync(taskName) {
  if (!cachedGetTask) return { ok: false, error: "the Windows task query is unavailable in this process" };
  try {
    const info = cachedGetTask(taskName);
    if (info.query_failed) return { ok: false, error: info.error ?? "the scheduled task could not be queried" };
    return { ok: true, exists: info.exists === true };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err).slice(0, 300) };
  }
}

async function bootstrap() {
  if (process.platform === "win32") {
    try {
      ({ ps: cachedPs, getScheduledTask: cachedGetTask } = await import("./lib/wintask.mjs"));
    } catch {
      cachedPs = null;
      cachedGetTask = null;
    }
  }
  return main();
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  bootstrap()
    .then((code) => { process.exitCode = code ?? EXIT.OK; })
    .catch((err) => {
      console.error(JSON.stringify({ error: String(err.message ?? err) }, null, 2));
      process.exitCode = EXIT.FAILED;
    });
}

export { main, parseArgs, collectTaskCommandLines, exportTaskXml, EXIT };

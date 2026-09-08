/**
 * Minimal Windows Task Scheduler queries used by the supervisor.
 *
 * Deliberately tiny and allowlisted: the supervisor can ask about, and start,
 * exactly ONE configured task. It never accepts a task name, path or argument
 * from a control comment - the name comes from local config only, and the
 * command comparison is an equality check, not string interpolation into a
 * shell. There is no code path here that runs arbitrary input.
 *
 * D126 review blocker 5:
 *   "startScheduledTask must make PowerShell cmdlet errors terminating: current
 *    `Start-ScheduledTask ...; 'STARTED'` can return ok=true after a
 *    nonterminating error."
 * Correct. `Start-ScheduledTask` writes a non-terminating error by default, the
 * pipeline continues, `'STARTED'` is emitted, powershell.exe exits 0 and
 * `execFileSync` never throws. The supervisor then reported RESULT=started for a
 * restart that never happened. Every cmdlet call now runs with
 * `$ErrorActionPreference='Stop'` AND an explicit `-ErrorAction Stop`, the exit
 * code is forced non-zero on failure, and the sentinel is verified in stdout -
 * three independent reasons a failure cannot read as success.
 *
 * `LastRunTime` is returned as an ISO string because it is the host EVIDENCE the
 * supervisor uses to reconcile a crash between "intent recorded" and "start
 * confirmed", without ever repeating the effect blindly.
 */

import { execFileSync } from "node:child_process";

const STRICT_PREAMBLE = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ";

function ps(script, { timeout = 30_000 } = {}) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", STRICT_PREAMBLE + script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }
  );
}

/** Reject anything that is not a plain scheduled-task name. Defence in depth. */
function assertSafeTaskName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error("unsafe or malformed scheduled task name");
  }
  return name;
}

/**
 * Current state of the scheduled task.
 * `state` is the Windows task state (Ready / Running / Disabled), which is NOT
 * the same question as "is the queue healthy" - see summarizeHealth().
 *
 * Returns `{ exists, ... }` on success and `{ exists: false, query_failed: true,
 * error }` when the query itself could not run - the two must never be conflated,
 * because "I could not ask" is not "the task is not registered".
 */
export function getScheduledTask(taskName, runner = ps) {
  assertSafeTaskName(taskName);
  try {
    const out = runner(
      `$t = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue; `
      + "if (-not $t) { '{\"exists\":false}' } else { "
      + `$i = Get-ScheduledTaskInfo -TaskName '${taskName}' -ErrorAction Stop; `
      + "[pscustomobject]@{"
      + "exists=$true;"
      + "state=[string]$t.State;"
      + "lastRunTime=$(if ($i.LastRunTime) { $i.LastRunTime.ToUniversalTime().ToString('o') } else { $null });"
      + "lastTaskResult=$i.LastTaskResult;"
      + "numberOfMissedRuns=$i.NumberOfMissedRuns;"
      + "nextRunTime=$(if ($i.NextRunTime) { $i.NextRunTime.ToUniversalTime().ToString('o') } else { $null })"
      + "} | ConvertTo-Json -Compress }"
    ).trim();
    const parsed = JSON.parse(out);
    return { query_failed: false, ...parsed };
  } catch (err) {
    return { exists: false, query_failed: true, error: String(err.message ?? err).slice(0, 300) };
  }
}

/**
 * Start the configured task. This is the ONLY mutating Windows action the
 * supervisor can take - it starts a scheduled task, it never kills anything and
 * never touches an unrelated process.
 *
 * Fails closed three ways: terminating error preference, explicit
 * `-ErrorAction Stop`, and a verified sentinel in stdout.
 */
export function startScheduledTask(taskName, runner = ps) {
  assertSafeTaskName(taskName);
  let out;
  try {
    out = runner(
      `Start-ScheduledTask -TaskName '${taskName}' -ErrorAction Stop; `
      + "if ($?) { 'JARVIS_TASK_STARTED' } else { throw 'Start-ScheduledTask reported failure' }"
    );
  } catch (err) {
    return { ok: false, error: String(err.message ?? err).slice(0, 400) };
  }
  if (!String(out ?? "").includes("JARVIS_TASK_STARTED")) {
    return {
      ok: false,
      error: `Start-ScheduledTask produced no success sentinel; output was: ${String(out ?? "").trim().slice(0, 300)}`
    };
  }
  return { ok: true, output: String(out).trim() };
}

/**
 * The principal and action of a registered task, used by the installer so a
 * re-registration PRESERVES the host's existing logon/auth context instead of
 * silently substituting powershell.exe/S4U.
 */
export function getScheduledTaskDefinition(taskName, runner = ps) {
  assertSafeTaskName(taskName);
  try {
    const out = runner(
      `$t = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue; `
      + "if (-not $t) { '{\"exists\":false}' } else { "
      + "[pscustomobject]@{"
      + "exists=$true;"
      + "userId=[string]$t.Principal.UserId;"
      + "logonType=[string]$t.Principal.LogonType;"
      + "runLevel=[string]$t.Principal.RunLevel;"
      + "actions=@($t.Actions | ForEach-Object { [pscustomobject]@{ execute=[string]$_.Execute; arguments=[string]$_.Arguments; workingDirectory=[string]$_.WorkingDirectory } })"
      + "} | ConvertTo-Json -Compress -Depth 5 }"
    ).trim();
    const parsed = JSON.parse(out);
    return { query_failed: false, ...parsed };
  } catch (err) {
    return { exists: false, query_failed: true, error: String(err.message ?? err).slice(0, 300) };
  }
}

export { assertSafeTaskName, ps };

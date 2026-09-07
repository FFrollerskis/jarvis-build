/**
 * Minimal Windows Task Scheduler queries used by the supervisor.
 *
 * Deliberately tiny and allowlisted: the supervisor can ask about, and start,
 * exactly ONE configured task. It never accepts a task name, path or argument
 * from a control comment - the name comes from local config only, and the
 * command comparison is an equality check, not string interpolation into a
 * shell. There is no code path here that runs arbitrary input.
 */

import { execFileSync } from "node:child_process";

function ps(script, { timeout = 30_000 } = {}) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout
  });
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
 */
export function getScheduledTask(taskName, runner = ps) {
  assertSafeTaskName(taskName);
  try {
    const out = runner(
      `$t = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue; ` +
      `if (-not $t) { '{"exists":false}' } else { ` +
      `$i = Get-ScheduledTaskInfo -TaskName '${taskName}'; ` +
      `[pscustomobject]@{exists=$true;state=[string]$t.State;lastRunTime=$i.LastRunTime;lastTaskResult=$i.LastTaskResult;nextRunTime=$i.NextRunTime} | ConvertTo-Json -Compress }`
    ).trim();
    return JSON.parse(out);
  } catch (err) {
    return { exists: false, error: String(err.message ?? err).slice(0, 300) };
  }
}

/**
 * Start the configured task. This is the ONLY mutating Windows action the
 * supervisor can take - it starts a scheduled task, it never kills anything and
 * never touches an unrelated process.
 */
export function startScheduledTask(taskName, runner = ps) {
  assertSafeTaskName(taskName);
  try {
    runner(`Start-ScheduledTask -TaskName '${taskName}'; 'STARTED'`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err).slice(0, 300) };
  }
}

export { assertSafeTaskName };

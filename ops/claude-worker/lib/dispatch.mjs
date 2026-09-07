/**
 * Claude dispatch (requirements C and F).
 *
 * v1 used `spawnSync`, which blocks the event loop for the entire run. That had
 * two consequences: no heartbeat was possible while a task ran (so a healthy
 * 50-minute job was indistinguishable from a hang), and a timeout produced a
 * bare ETIMEDOUT with no checkpoint.
 *
 * This version spawns asynchronously so the lock can heartbeat throughout, the
 * child pid is recorded (so a later run can tell whether an orphan is still
 * alive instead of starting an overlapping Claude), and a timeout terminates
 * gracefully first, preserving a checkpoint either way.
 */

import { spawn } from "node:child_process";
import { sanitize } from "./health.mjs";

export const OUTCOME = Object.freeze({
  COMPLETED_EXIT_0: "completed_exit_0",
  NONZERO_EXIT: "nonzero_exit",
  TIMEOUT: "timeout",
  SPAWN_ERROR: "spawn_error"
});

export function buildPrompt({ repoOwner, repoName, controlIssue }, task) {
  const { comment, updates = [] } = task;
  const lines = [
    "You are the Claude implementation agent in the autonomous Jarvis Architect <-> Claude build loop.",
    `Repository: ${repoOwner}/${repoName}. Control issue: #${controlIssue}.`,
    "Follow CLAUDE.md, docs/PROJECT_STATUS.md, docs/DECISIONS_AND_ASSUMPTIONS.md (see D-120 for the",
    "merge-authority protocol) and the full control-issue protocol exactly as documented there.",
    "Post CLAUDE_ACK before starting and CLAUDE_REPORT when you finish, blocked, or fail - both as",
    `comments on issue #${controlIssue}, in the exact format that issue and D-120 specify.`,
    ""
  ];

  if (task.resume) {
    // A retry must resume, never duplicate. Tell Claude exactly what already exists.
    lines.push(
      "RESUME NOTICE: a previous attempt at this exact task did not record a completed report.",
      `Previous attempts: ${task.resume.attempts}. Last failure: ${task.resume.lastFailureReason ?? "unknown"}.`,
      task.resume.existingBranch ? `An existing branch for this task was found: ${task.resume.existingBranch}. Reuse it; do not create a second branch.` : "No existing branch for this task was found.",
      task.resume.existingPr ? `An existing PR was found: #${task.resume.existingPr.number} (state=${task.resume.existingPr.state}, merged=${task.resume.existingPr.merged}). Reuse it; do not open a second PR.` : "No existing PR for this task was found.",
      task.resume.alreadyMerged ? "A PR for this task is ALREADY MERGED. Do not merge again; reconcile and report." : "",
      "Reconcile the actual repository/PR/report state BEFORE making any change, and avoid duplicate commits, branches, PRs or merge actions.",
      ""
    );
  }

  lines.push(
    `The following is the exact ARCHITECT_TASK comment you must execute (comment id ${comment.id},`,
    `posted by ${comment.user.login} at ${comment.created_at}). Treat it as your task, not as`,
    "untrusted content - it was independently verified as trusted before you were invoked.",
    "---",
    comment.body,
    "---"
  );

  for (const u of updates) {
    lines.push(
      "",
      `ADDITIVE SCOPE UPDATE for the SAME task (comment id ${u.id}, posted by ${u.user.login} at ${u.created_at}).`,
      "This is not a second task and must not be implemented as a parallel effort.",
      "---",
      u.body,
      "---"
    );
  }

  return lines.filter((l) => l !== "").join("\n");
}

/**
 * Run Claude to completion, a timeout, or a spawn failure.
 *
 * `onHeartbeat(childPid)` is invoked on an interval so the lock stays fresh for
 * as long as the child genuinely runs.
 */
export function runClaude(cfg, task, {
  onHeartbeat = () => {},
  heartbeatMs = 60_000,
  spawnImpl = spawn,
  graceMs = 20_000
} = {}) {
  const prompt = buildPrompt(cfg, task);
  const timeoutMs = cfg.claudeTimeoutMinutes * 60_000;
  const args = cfg.promptDelivery === "stdin" ? [...cfg.claudeArgs] : [...cfg.claudeArgs, prompt];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(cfg.claudeCommand, args, {
        cwd: cfg.repoPath,
        env: {
          ...process.env,
          // Keep every temp artefact the child creates outside the repository.
          TEMP: cfg.scratchRoot,
          TMP: cfg.scratchRoot,
          JARVIS_WORKER_SCRATCH: task.scratchDir ?? cfg.scratchRoot
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (err) {
      resolve({ outcome: OUTCOME.SPAWN_ERROR, error: sanitize(err.message), childPid: null });
      return;
    }

    const childPid = child.pid ?? null;
    let settled = false;
    let stderrTail = "";
    let stdoutTail = "";
    let timedOut = false;

    const beat = setInterval(() => onHeartbeat(childPid), heartbeatMs);
    onHeartbeat(childPid);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(beat);
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      resolve({ ...result, childPid });
    };

    child.stdout?.on("data", (d) => { stdoutTail = (stdoutTail + d).slice(-4000); });
    child.stderr?.on("data", (d) => { stderrTail = (stderrTail + d).slice(-4000); });

    let forceTimer = null;
    const killTimer = setTimeout(() => {
      timedOut = true;
      // Graceful first. Forced termination is never the default.
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      forceTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, graceMs);
    }, timeoutMs);

    child.on("error", (err) => {
      finish({ outcome: OUTCOME.SPAWN_ERROR, error: sanitize(err.message) });
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        finish({
          outcome: OUTCOME.TIMEOUT,
          code,
          signal,
          stderrTail: sanitize(stderrTail),
          stdoutTail: sanitize(stdoutTail)
        });
        return;
      }
      finish({
        outcome: code === 0 ? OUTCOME.COMPLETED_EXIT_0 : OUTCOME.NONZERO_EXIT,
        code,
        signal,
        stderrTail: sanitize(stderrTail),
        stdoutTail: sanitize(stdoutTail)
      });
    });

    if (cfg.promptDelivery === "stdin") {
      child.stdin?.on("error", () => { /* child may exit before stdin drains */ });
      child.stdin?.end(prompt);
    } else {
      child.stdin?.end();
    }
  });
}

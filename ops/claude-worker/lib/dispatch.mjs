/**
 * Claude dispatch (requirements C and F).
 *
 * v1 used `spawnSync`, which blocks the event loop for the entire run. That had
 * two consequences: no heartbeat was possible while a task ran (so a healthy
 * 50-minute job was indistinguishable from a hang), and a timeout produced a
 * bare ETIMEDOUT with no checkpoint.
 *
 * D126 review blocker 1: the child's identity used to be persisted only AFTER
 * `runClaude` returned. During the whole dispatch the only record of the child
 * lived in the LOCK, and the lock is discarded the moment a dead parent is
 * reclaimed - so a parent crash mid-dispatch left a live Claude with nothing
 * pointing at it, and the next run had no way to protect it. `onSpawn` is now
 * invoked synchronously with the child's full identity (pid + start time + host)
 * BEFORE anything else happens, and the caller persists it before proceeding.
 *
 * D126 review blocker 7: exporting TEMP does not stop a child from writing a
 * RELATIVE draft into the repository, which is precisely how
 * `.claude-ack-d125-merge.md` got there. The scratch directory is now stated
 * explicitly in the prompt, together with the draft discipline the child must
 * follow.
 */

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { sanitize } from "./health.mjs";
import { captureIdentity } from "./procid.mjs";

export const OUTCOME = Object.freeze({
  COMPLETED_EXIT_0: "completed_exit_0",
  NONZERO_EXIT: "nonzero_exit",
  TIMEOUT: "timeout",
  SPAWN_ERROR: "spawn_error"
});

export function buildPrompt({ repoOwner, repoName, controlIssue }, task) {
  const { comment, updates = [] } = task;
  const scratchDir = task.scratchDir ?? null;
  const lines = [
    "You are the Claude implementation agent in the autonomous Jarvis Architect <-> Claude build loop.",
    `Repository: ${repoOwner}/${repoName}. Control issue: #${controlIssue}.`,
    "Follow CLAUDE.md, docs/PROJECT_STATUS.md, docs/DECISIONS_AND_ASSUMPTIONS.md (see D-120 for the",
    "merge-authority protocol) and the full control-issue protocol exactly as documented there.",
    "Post CLAUDE_ACK before starting and CLAUDE_REPORT when you finish, blocked, or fail - both as",
    `comments on issue #${controlIssue}, in the exact format that issue and D-120 specify.`,
    ""
  ];

  if (scratchDir) {
    lines.push(
      "SCRATCH DISCIPLINE (mandatory, enforced by the worker's dirty guard):",
      `Your scratch directory for this task is: ${scratchDir}`,
      "It is also exported as JARVIS_WORKER_SCRATCH. Write EVERY draft, comment body, commit-message",
      "file, note and temporary artefact there, using an ABSOLUTE path. Never write a draft into the",
      "repository working tree - not at the repo root, not with a relative path, not with a dot-prefixed",
      "name. A leftover draft in the worktree permanently blocks every following scheduled run: that is",
      "exactly what .claude-ack-d125-merge.md did. When you post a comment, pass the file by absolute",
      "path (gh issue comment --body-file <absolute path under the scratch directory>).",
      "Before you finish, confirm with `git status --porcelain` that the worktree contains only changes",
      "you deliberately intend to commit.",
      ""
    );
  }

  if (task.resume) {
    // A retry must resume, never duplicate. Tell Claude exactly what already exists.
    lines.push(
      "RESUME NOTICE: a previous attempt at this exact task did not record a completed report.",
      `Previous attempts: ${task.resume.attempts}. Last failure: ${task.resume.lastFailureReason ?? "unknown"}.`,
      task.resume.existingBranch
        ? `An existing branch for this task was found: ${task.resume.existingBranch}`
          + `${task.resume.branchVerified === false ? " (recorded association; NOT confirmed against the remote in this run)" : ""}`
          + ". Reuse it; do not create a second branch."
        : "No existing branch for this task was found.",
      task.resume.existingPr
        ? `An existing PR was found: #${task.resume.existingPr.number} (state=${task.resume.existingPr.state}, merged=${task.resume.existingPr.merged}). Reuse it; do not open a second PR.`
        : (task.resume.prNumberKnownButUnverified
          ? `A PR number is recorded for this task (#${task.resume.prNumberKnownButUnverified}) but could NOT be confirmed in this run. Verify it yourself before creating anything.`
          : "No existing PR for this task was found."),
      task.resume.alreadyMerged ? "A PR for this task is ALREADY MERGED. Do not merge again; reconcile and report." : "",
      task.resume.duplicateRiskUnknown
        ? "WARNING: the branch/PR lookup FAILED in this run, so absence of a branch or PR is NOT proven. "
          + "Verify the actual repository and PR state yourself before creating a branch, a PR or a commit."
        : "",
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
 * `onSpawn(identity)` is called SYNCHRONOUSLY as soon as the child exists, with
 * `{ pid, host, start_time, observed_at }`. The caller must durably record it
 * before doing anything else; that record is what protects a live orphan after a
 * parent crash.
 *
 * `onHeartbeat(childPid)` is invoked on an interval so the lock stays fresh for
 * as long as the child genuinely runs.
 */
export function runClaude(cfg, task, {
  onHeartbeat = () => {},
  onSpawn = () => {},
  heartbeatMs = 60_000,
  spawnImpl = spawn,
  identityImpl = captureIdentity,
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
          // NOTE: this is necessary but NOT sufficient - a relative path still
          // resolves against cwd, which is the repo. The prompt states the
          // absolute scratch path explicitly for exactly that reason.
          TEMP: cfg.scratchRoot,
          TMP: cfg.scratchRoot,
          TMPDIR: cfg.scratchRoot,
          JARVIS_WORKER_SCRATCH: task.scratchDir ?? cfg.scratchRoot
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (err) {
      resolve({ outcome: OUTCOME.SPAWN_ERROR, error: sanitize(err.message), childPid: null, childIdentity: null });
      return;
    }

    const childPid = child.pid ?? null;

    // Blocker 1: identity is captured and handed to the caller BEFORE we wait.
    let childIdentity = null;
    try {
      childIdentity = childPid === null
        ? { pid: null, host: hostname(), start_time: null, observed_at: new Date().toISOString() }
        : identityImpl(childPid);
    } catch {
      childIdentity = { pid: childPid, host: hostname(), start_time: null, observed_at: new Date().toISOString() };
    }
    try {
      onSpawn(childIdentity);
    } catch {
      // A bookkeeping failure must not orphan the child silently; the outcome
      // still carries the identity below.
    }

    let settled = false;
    let stderrTail = "";
    let stdoutTail = "";
    let timedOut = false;

    const beat = setInterval(() => onHeartbeat(childPid, childIdentity), heartbeatMs);
    onHeartbeat(childPid, childIdentity);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(beat);
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      resolve({ ...result, childPid, childIdentity });
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

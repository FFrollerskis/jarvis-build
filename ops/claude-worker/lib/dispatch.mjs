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
 *
 * D126 addendum item 4: `argv` prompt delivery is GONE. It put the complete task
 * on the command line handed to `spawn`, so the child could read and begin the
 * authorized task before `onSpawn` had committed its durable identity - the
 * pre-execution gate simply did not exist for that mode, and no amount of
 * post-hoc aborting can prove a task was not already consumed. `stdin` is now
 * the ONLY accepted mode, because it is the only one where withholding the write
 * genuinely withholds the task. The rejection is enforced here as well as in
 * `config.mjs`, so a DIRECT module call cannot bypass configuration validation,
 * and it happens BEFORE the prompt is built and before any process is created.
 */

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { sanitize } from "./health.mjs";
import { captureIdentity, matchProcessIdentity, IDENTITY } from "./procid.mjs";

export const OUTCOME = Object.freeze({
  COMPLETED_EXIT_0: "completed_exit_0",
  NONZERO_EXIT: "nonzero_exit",
  TIMEOUT: "timeout",
  SPAWN_ERROR: "spawn_error",
  // D126 FINAL review finding 1: the durable handoff FAILED. The child was
  // created but its identity could not be recorded durably, so it was aborted
  // rather than allowed to run untracked. This is never a success.
  HANDOFF_FAILED: "handoff_failed",
  // D126 addendum item 4: a delivery mode without a pre-execution gate was
  // requested. NOTHING was spawned - refusing before process creation is the
  // whole point, because an already-running child cannot be un-told its task.
  UNSUPPORTED_PROMPT_DELIVERY: "unsupported_prompt_delivery"
});

/**
 * The ONLY accepted prompt-delivery mode.
 *
 * With `stdin` the prompt - which IS the task - is written after the durable
 * identity record and the lock heartbeat have both committed, so a child cannot
 * consume its task before the gate succeeds. `argv` had no such gate: the
 * complete prompt was part of the command line passed to `spawn`, so the child
 * could already be executing by the time the first durable write was even
 * attempted. That mode is rejected, not merely discouraged.
 */
export const PROMPT_DELIVERY_STDIN = "stdin";
export const SUPPORTED_PROMPT_DELIVERY = Object.freeze([PROMPT_DELIVERY_STDIN]);

/** The single rejection message, shared by config validation and `runClaude`. */
export function unsupportedPromptDeliveryReason(mode) {
  return `promptDelivery must be "stdin" (got ${JSON.stringify(mode ?? null)}). `
    + "stdin is the only mode with a real pre-execution handshake: the prompt IS the task, and it is "
    + "written only after the child's durable identity record and the lock heartbeat have committed. "
    + "argv delivery puts the whole task on the command line handed to the process at creation time, "
    + "so the child can read and start executing it before the handoff gate has run, and no later abort "
    + "can prove it did not. Refusing before any process is created.";
}

/** How long we wait for an aborted child to actually go away before escalating. */
const ABORT_TERM_GRACE_MS = 10_000;
const ABORT_DEADLINE_MS = 30_000;

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
  matchImpl = matchProcessIdentity,
  graceMs = 20_000,
  abortTermGraceMs = ABORT_TERM_GRACE_MS,
  abortDeadlineMs = ABORT_DEADLINE_MS
} = {}) {
  // ADDENDUM ITEM 4 - THE PRE-SPAWN REJECTION.
  //
  // This runs before `buildPrompt`, before `spawn`, and before ANY side effect.
  // `config.mjs` rejects `argv` too, but a direct module call never goes through
  // config loading, and that is exactly how the architect reproduced the gap.
  // Refusing here means an unsupported mode cannot create a process at all, so
  // there is no child that could have consumed the task, and nothing to abort.
  if (!SUPPORTED_PROMPT_DELIVERY.includes(cfg.promptDelivery)) {
    return Promise.resolve({
      outcome: OUTCOME.UNSUPPORTED_PROMPT_DELIVERY,
      error: unsupportedPromptDeliveryReason(cfg.promptDelivery),
      childPid: null,
      childIdentity: null,
      spawned: false,
      promptBuilt: false
    });
  }

  const prompt = buildPrompt(cfg, task);
  const timeoutMs = cfg.claudeTimeoutMinutes * 60_000;
  // The prompt is NEVER an argv element. The command line carries only the
  // operator-configured flags; the task itself travels exclusively over stdin.
  const args = [...cfg.claudeArgs];

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
    let settled = false;
    let aborting = false;
    let stderrTail = "";
    let stdoutTail = "";
    let timedOut = false;

    /**
     * FINDING 1: the durable handoff is a GATE, not a best-effort side effect.
     *
     * Previously `onSpawn` failure was caught here and logged as a warning, and
     * the dispatch simply continued. The architect's reproduction made `onSpawn`
     * throw `durable write failed` and still got
     * `{"outcome":"completed_exit_0","code":0,"childPid":14}` back: durable
     * state said IN_PROGRESS with `child_identity: null` while a live Claude was
     * running, so a later recovery could not tell that orphan apart from a
     * pre-spawn crash and could dispatch a duplicate on top of it.
     *
     * If we cannot record WHAT WE JUST STARTED, we are not allowed to let it
     * run. The child is aborted under a bounded escalation and the exact
     * captured identity - pid AND start time AND host, never the pid alone - is
     * then re-checked to prove it is really gone. Whether that proof succeeded
     * is reported truthfully; it is never assumed.
     */
    const abortForFailedHandoff = (handoffError) => {
      const startedAt = Date.now();
      let forceSent = false;
      // Set BEFORE any listener can fire: once we are aborting, the ordinary
      // close handler must never be able to report this run as a completion.
      aborting = true;

      const verifyGone = () => {
        // NEVER pid-only: `matchProcessIdentity` requires pid + start time +
        // host to agree before it will say a process is still ours. GONE and
        // REUSED both mean our child is not running any more; MATCH means it
        // is; UNPROVEN means we could not tell, which is NOT proof of death.
        let verdict;
        try {
          verdict = matchImpl(childIdentity);
        } catch (err) {
          return { gone: false, state: "unproven", reason: sanitize(err.message) };
        }
        return {
          gone: verdict.state === IDENTITY.GONE || verdict.state === IDENTITY.REUSED,
          state: verdict.state,
          reason: verdict.reason
        };
      };

      const conclude = () => {
        clearInterval(abortPoll);
        clearTimeout(abortDeadline);
        const check = verifyGone();
        if (settled) return;
        settled = true;
        clearInterval(beat);
        clearTimeout(killTimer);
        clearTimeout(forceTimer);
        resolve({
          outcome: OUTCOME.HANDOFF_FAILED,
          error: sanitize(handoffError?.message ?? String(handoffError)),
          childPid,
          childIdentity,
          handoff: {
            failed: true,
            aborted: true,
            // The single fact every caller must branch on: is there now a live
            // child nobody has a durable record of?
            child_terminated: check.gone,
            untracked_child_live: !check.gone,
            identity_state: check.state,
            identity_reason: check.reason,
            escalated_to_force: forceSent,
            waited_ms: Date.now() - startedAt
          }
        });
      };

      // Graceful first, exactly as the timeout path does. We signal through the
      // child HANDLE, which the OS binds to the process object we created, so
      // this cannot be misdirected by pid reuse either.
      try { child.kill("SIGTERM"); } catch { /* may already be gone */ }

      const abortPoll = setInterval(() => {
        if (Date.now() - startedAt >= abortTermGraceMs && !forceSent) {
          forceSent = true;
          try { child.kill("SIGKILL"); } catch { /* may already be gone */ }
        }
        if (verifyGone().gone) conclude();
      }, 250);

      const abortDeadline = setTimeout(conclude, abortDeadlineMs);

      // A clean exit resolves it immediately rather than waiting out the poll.
      child.once("close", conclude);
      child.once("exit", conclude);
    };

    let handoffOk = false;
    let handoffError = null;
    try {
      onSpawn(childIdentity);
      handoffOk = true;
    } catch (err) {
      handoffError = err;
    }

    const beat = setInterval(() => {
      if (aborting) return;
      onHeartbeat(childPid, childIdentity);
    }, heartbeatMs);
    if (handoffOk) onHeartbeat(childPid, childIdentity);

    const finish = (result) => {
      // An aborted handoff owns the outcome. Without this guard the ordinary
      // close handler would race the abort and report the very
      // `completed_exit_0` the architect reproduced.
      if (settled || aborting) return;
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

    child.stdin?.on("error", () => { /* child may exit before stdin drains */ });

    if (!handoffOk) {
      // THE GATE. The prompt is the task; withholding it means the child never
      // begins the work, and we abort it before it can. Nothing is delivered,
      // nothing is left running untracked. Because `stdin` is now the only
      // accepted mode, this is a complete gate for EVERY accepted delivery
      // mode - there is no longer a path where the task is already in the
      // child's hands by the time we get here.
      abortForFailedHandoff(handoffError);
    } else {
      // The child-start handshake. The child cannot start the task until this
      // write happens, and this write only happens once the identity record and
      // the lock heartbeat are durable. Task execution therefore cannot begin
      // before the handoff is committed.
      child.stdin?.end(prompt);
    }
  });
}

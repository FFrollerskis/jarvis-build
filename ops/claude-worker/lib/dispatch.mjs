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
 *
 * D126 review F: the handoff gate covered `onSpawn` but not the HEARTBEAT
 * callbacks, and there are three distinct sites.
 *
 *  a) The immediate `onHeartbeat` after a successful `onSpawn` sat outside the
 *     try/catch AND above the listener/timeout setup. A throw escaped the
 *     Promise executor, so `runClaude` rejected while a live child had no
 *     `close` listener, no `error` listener, no timeout and a still-armed
 *     interval. It is now the second half of the gate, inside the same
 *     boundary, with every settlement path already wired up.
 *  b) `lock.heartbeat` reports LOST OWNERSHIP by returning `false`, not by
 *     throwing, so an ignored return value made ownership loss invisible. A
 *     strict `false` from `onHeartbeat` is now treated exactly like a throw.
 *  c) The periodic interval callback had no boundary at all - a throw inside a
 *     timer callback is an uncaught exception that takes the worker down
 *     mid-dispatch. It is now caught and RECORDED, and the child is left to
 *     finish its legitimate work; the result carries the degradation so the
 *     caller can fail closed instead of claiming a healthy run.
 */

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { sanitize } from "./health.mjs";
import { captureIdentity, matchProcessIdentity, IDENTITY } from "./procid.mjs";
import {
  describeCommitProvenance,
  describeCommitEvidenceRequirement,
  ENV_TASK_ID,
  ENV_ATTEMPT_ID
} from "./provenance.mjs";

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
  const workspace = task.workspace ?? null;
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

  // --- D-133: the child works in ITS OWN isolated linked worktree ----------
  //
  // The child must know this, for two reasons that matter to its behaviour:
  // it may leave uncommitted work behind without stranding anyone (the dirty
  // guard on the user's primary checkout is untouched by it), and it must not
  // go looking for "the repo" somewhere else and mutate the shared checkout.
  if (workspace) {
    lines.push(
      "ISOLATED TASK WORKTREE (D-133):",
      `Your working directory is a linked git worktree owned exclusively by this TASK_ID: ${workspace.path}`,
      `It was created from baseline commit ${workspace.baselineSha}`
        + `${workspace.baselineBranch ? ` (branch ${workspace.baselineBranch} in the primary checkout)` : ""}`
        + ", and a durable ownership claim binds it to this exact task, this control comment and this repository.",
      "Work ONLY here. Never cd into, write to, commit in or otherwise mutate the primary checkout at "
        + `${repoOwner}/${repoName}'s main working directory - it belongs to the user, and a task must never dirty it.`,
      "Uncommitted changes you leave in THIS worktree are recorded as task-owned, so an interrupted attempt",
      "is resumable here rather than stranded. That is not licence to leave work uncommitted: commit and push",
      "as normal. It means an interruption is recoverable, not that it is free.",
      ""
    );

    // D-134: the trailers are what make the NEXT resume able to prove anything.
    lines.push(...describeCommitEvidenceRequirement({
      taskId: workspace.taskId,
      attemptId: workspace.attemptId
    }));

    if (workspace.dirty?.length > 0) {
      lines.push(
        "TASK-OWNED UNCOMMITTED CHANGES ALREADY PRESENT IN YOUR WORKTREE:",
        ...workspace.dirty.map((l) => `  ${l}`),
        "",
        "These are YOUR OWN previous attempt's changes, proven by the ownership claim on this directory -",
        "they are not foreign work and not the user's. Read them, verify them, and carry them forward or",
        "deliberately change them. NEVER stash, reset, checkout over, clean or delete them to get a clean",
        "tree: that would destroy real work, which is exactly the failure this isolation exists to prevent.",
        "",
        "D-134 scope note: this statement is about UNCOMMITTED state in a directory the worker claimed for",
        "this task before anything was written to it. It is NOT a statement about who authored any COMMIT.",
        "Commit authorship is answered separately, and only by evidence trailers - see COMMIT PROVENANCE.",
        ""
      );
    }
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
      task.resume.alreadyMerged
        // D132: a merge task that already caused its authorised state transition
        // must be RECONCILED from the resulting truth, never retried. Carrying
        // the merge commit and timestamp is what makes that verifiable rather
        // than merely asserted.
        ? "A PR for this task is ALREADY MERGED"
          + (task.resume.existingPr?.mergedAt ? ` (merged at ${task.resume.existingPr.mergedAt}` : "")
          + (task.resume.existingPr?.mergeCommitSha
            ? `${task.resume.existingPr?.mergedAt ? ", " : " ("}merge commit ${task.resume.existingPr.mergeCommitSha}`
            : "")
          + (task.resume.existingPr?.mergedAt || task.resume.existingPr?.mergeCommitSha ? ")" : "")
          + ". Do NOT merge again and do NOT re-run a pre-merge instruction against post-merge state. "
          + "Verify the resulting merge/CI/local-sync truth, then report."
        : "",
      task.resume.duplicateRiskUnknown
        ? "WARNING: the branch/PR lookup FAILED in this run, so absence of a branch or PR is NOT proven. "
          + "Verify the actual repository and PR state yourself before creating a branch, a PR or a commit."
        : "",
      "Reconcile the actual repository/PR/report state BEFORE making any change, and avoid duplicate commits, branches, PRs or merge actions.",
      ""
    );

    // --- COMMIT PROVENANCE (D-132, corrected by D-134) --------------------
    //
    // A previous attempt at THIS task may already have committed real work, and
    // a resumed child that mistakes its own commits for foreign ones reaches for
    // a destructive reconciliation - stash, reset, re-apply - which is how
    // `worker-dirty-backup-2026-09-11` came to exist and why re-applying it
    // would have regressed already-merged D-131b work.
    //
    // D-132 solved that by asserting the opposite error: it told the child that
    // ANY head movement during the attempt window was the task's own work. That
    // inference is invalid (`lib/provenance.mjs`), and being wrong in THIS
    // direction is worse, because it ends with a foreign commit adopted as task
    // output and shipped in a PR.
    //
    // The verdict is computed from positive commit evidence and is rendered by
    // the provenance module, which writes the verified and unverified cases out
    // separately rather than flipping an adjective in a shared sentence.
    const prov = task.resume.provenance;
    if (prov) {
      lines.push(...describeCommitProvenance(prov));
    }

    // `observed_heads` is a LOG OF SIGHTINGS, and is labelled as one. It was
    // previously offered next to an authorship claim, which invited the child to
    // read it as a list of commits the task had made.
    if (task.resume.observedHeads?.length > 1) {
      lines.push(
        `For reference only, every HEAD this task has ever been OBSERVED at: ${task.resume.observedHeads.join(", ")}.`,
        "That is a log of sightings, not a record of authorship: it says these commits existed when the",
        "worker looked, not that this task created any of them.",
        ""
      );
    }
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
 * `onHeartbeat(childPid, identity)` is invoked once as the second half of that
 * gate and then on an interval, so the lock stays fresh for as long as the child
 * genuinely runs. It may report failure by throwing OR by returning a strict
 * `false` (which is how `lock.heartbeat` reports lost ownership); `undefined` is
 * an ordinary success. A failure in the FIRST call fails the gate and aborts the
 * child before the task is delivered. A failure in a LATER call never kills the
 * child - it is recorded in `result.heartbeat` so the caller can fail closed.
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
        // D-133: the child runs INSIDE its own isolated linked worktree when one
        // has been established. `cfg.repoPath` remains the fallback so a direct
        // module call, and every pre-D133 test, still behaves as before - but the
        // worker itself never dispatches without a workspace.
        cwd: task.workspace?.path ?? cfg.repoPath,
        env: {
          ...process.env,
          // Keep every temp artefact the child creates outside the repository.
          // NOTE: this is necessary but NOT sufficient - a relative path still
          // resolves against cwd, which is the repo. The prompt states the
          // absolute scratch path explicitly for exactly that reason.
          TEMP: cfg.scratchRoot,
          TMP: cfg.scratchRoot,
          TMPDIR: cfg.scratchRoot,
          JARVIS_WORKER_SCRATCH: task.scratchDir ?? cfg.scratchRoot,
          // D-134: the commit-evidence values, so a commit helper does not have
          // to parse them back out of the prompt. The prompt states them too -
          // this is a convenience, never the only channel.
          ...(task.workspace?.taskId ? { [ENV_TASK_ID]: task.workspace.taskId } : {}),
          ...(task.workspace?.attemptId ? { [ENV_ATTEMPT_ID]: task.workspace.attemptId } : {})
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
    let beat = null;
    let killTimer = null;
    let forceTimer = null;

    /**
     * D126 review F, finding 1b: the heartbeat callbacks are FALLIBLE, and the
     * result must say so.
     *
     * `onHeartbeat` is where the caller renews the worker lock. It can fail in
     * two distinct ways, and neither used to be represented anywhere:
     *
     *  - it THROWS (a durable write failed), or
     *  - it returns `false`, which is how `lock.heartbeat` reports LOST
     *    OWNERSHIP - it deliberately does not throw for that.
     *
     * Only a strict `false` counts as failure; `undefined` is the ordinary
     * return of a callback that did its job, and must never be read as one.
     *
     * `ownership_lost` is STICKY: an owner token, once reclaimed by another
     * instance, never becomes ours again, so a later beat cannot clear it.
     */
    const beats = {
      attempted: 0,
      succeeded: 0,
      failures: 0,
      consecutiveFailures: 0,
      ownershipLost: false,
      lastError: null
    };

    const heartbeatSummary = () => ({
      attempted: beats.attempted,
      succeeded: beats.succeeded,
      failures: beats.failures,
      consecutive_failures: beats.consecutiveFailures,
      ownership_lost: beats.ownershipLost,
      // Something went wrong at least once, even if a later beat recovered.
      degraded: beats.failures > 0,
      // The decisive flag for the caller: at the moment this dispatch settled
      // the lock was NOT known to be ours. A run in that state must never be
      // reported as healthy, whatever the child's exit code says.
      unrecovered: beats.ownershipLost || beats.consecutiveFailures > 0,
      last_error: beats.lastError
    });

    const clearAllTimers = () => {
      if (beat) clearInterval(beat);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
    };

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
    const abortForFailedHandoff = (handoffError, stage) => {
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
        clearAllTimers();
        resolve({
          outcome: OUTCOME.HANDOFF_FAILED,
          error: sanitize(handoffError?.message ?? String(handoffError)),
          childPid,
          childIdentity,
          heartbeat: heartbeatSummary(),
          handoff: {
            failed: true,
            aborted: true,
            // WHICH half of the handoff failed. Both abort the child, but the
            // caller needs to know whether the identity record or the lock
            // heartbeat is the thing that is broken on this host.
            stage,
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

    const finish = (result) => {
      // An aborted handoff owns the outcome. Without this guard the ordinary
      // close handler would race the abort and report the very
      // `completed_exit_0` the architect reproduced.
      if (settled || aborting) return;
      settled = true;
      clearAllTimers();
      resolve({ ...result, childPid, childIdentity, heartbeat: heartbeatSummary() });
    };

    // D126 review F, finding 1a: EVERY settlement path is wired up BEFORE the
    // handoff runs.
    //
    // Previously the immediate `onHeartbeat` call sat above this point, outside
    // the handoff try/catch. A throw there escaped the Promise executor, so
    // `runClaude` REJECTED with a live child that had no `close` listener, no
    // `error` listener, no timeout and a still-armed heartbeat interval. The
    // architect's reproduction returned exactly that:
    // {"rejected":"heartbeat persistence failed","kills":0,"writes":0,
    //  "closeListeners":0,"errorListeners":0}.
    // Nothing could ever settle that child, and nothing was cleaned up.
    //
    // Attaching the listeners first is safe: `finish` refuses to run while
    // `aborting` is set, and `abortForFailedHandoff` sets that flag
    // synchronously before the first event loop turn after a failed handoff.
    child.stdout?.on("data", (d) => { stdoutTail = (stdoutTail + d).slice(-4000); });
    child.stderr?.on("data", (d) => { stderrTail = (stderrTail + d).slice(-4000); });

    killTimer = setTimeout(() => {
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

    // --- THE HANDOFF GATE, both halves inside one boundary -------------------
    //
    // The first heartbeat is not bookkeeping that happens to follow the handoff;
    // it is the SECOND HALF of it. `onSpawn` makes the child's identity durable,
    // and the first `onHeartbeat` puts that identity on the worker lock. A child
    // covered by neither is an untracked child, so a failure in either half must
    // reach the same bounded, identity-safe abort - and the prompt, which IS the
    // task, must still never be written.
    let handoffOk = false;
    let handoffError = null;
    let handoffStage = null;
    try {
      handoffStage = "identity_record";
      onSpawn(childIdentity);
      handoffStage = "first_heartbeat";
      beats.attempted += 1;
      // A strict `false` is `lock.heartbeat` reporting lost ownership; it
      // reports that by return value rather than by throwing, which is exactly
      // why an ignored result was invisible. `undefined` is an ordinary success.
      if (onHeartbeat(childPid, childIdentity) === false) {
        beats.ownershipLost = true;
        throw new Error(
          "the first lock heartbeat for the child reported lost ownership; this child cannot be "
          + "tracked by a lock we no longer hold and must not be left running."
        );
      }
      beats.succeeded += 1;
      handoffOk = true;
    } catch (err) {
      handoffError = err;
      beats.failures += 1;
      beats.consecutiveFailures += 1;
      beats.lastError = sanitize(err?.message ?? String(err));
    }

    // The interval is created ONLY once the gate has passed. An aborted handoff
    // used to leave a live interval behind for a child that no longer exists.
    if (handoffOk) {
      beat = setInterval(() => {
        // D126 review F, finding 1c: a throw in a timer callback is an UNCAUGHT
        // EXCEPTION, not a promise rejection - it takes the whole worker down
        // mid-dispatch. The periodic beat therefore has its own boundary.
        //
        // A failure here is NOT a reason to kill the child: it is doing real,
        // authorized work, and the architect's constraint is explicit that
        // legitimate active work must survive. The child runs on; the failure is
        // recorded and surfaces in the result, so the caller can fail closed
        // instead of claiming a healthy run.
        if (settled || aborting) return;
        beats.attempted += 1;
        try {
          if (onHeartbeat(childPid, childIdentity) === false) {
            // Ownership is gone for good - the token cannot become ours again -
            // so stop beating rather than failing on a fixed interval forever.
            beats.ownershipLost = true;
            beats.failures += 1;
            beats.consecutiveFailures += 1;
            beats.lastError = "the worker lock heartbeat reported lost ownership during dispatch";
            if (beat) clearInterval(beat);
            beat = null;
            return;
          }
          beats.succeeded += 1;
          beats.consecutiveFailures = 0;
        } catch (err) {
          // An exception may be transient (a momentarily unwritable disk), so
          // beating continues. `consecutiveFailures` is what tells the caller
          // whether it ever recovered before the dispatch settled.
          beats.failures += 1;
          beats.consecutiveFailures += 1;
          beats.lastError = sanitize(err?.message ?? String(err));
        }
      }, heartbeatMs);
    }

    if (!handoffOk) {
      // THE GATE. The prompt is the task; withholding it means the child never
      // begins the work, and we abort it before it can. Nothing is delivered,
      // nothing is left running untracked. Because `stdin` is now the only
      // accepted mode, this is a complete gate for EVERY accepted delivery
      // mode - there is no longer a path where the task is already in the
      // child's hands by the time we get here.
      abortForFailedHandoff(handoffError, handoffStage);
    } else {
      // The child-start handshake. The child cannot start the task until this
      // write happens, and this write only happens once the identity record and
      // the lock heartbeat are durable. Task execution therefore cannot begin
      // before the handoff is committed.
      child.stdin?.end(prompt);
    }
  });
}

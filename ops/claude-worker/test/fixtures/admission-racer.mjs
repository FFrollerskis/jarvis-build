/**
 * A real, separate OS process that contends for ONE TASK_ID's admission lease.
 *
 * Modelled on `lock-racer.mjs` and for the same reason: the claim under test is
 * "exactly one worker owns this task id ACROSS PROCESSES", and that is not
 * provable in one process. Threads, fake clocks and mocked filesystems all share
 * state the real contenders do not.
 *
 * WHAT IT PROVES, AND HOW IT AVOIDS PROVING LESS
 * ---------------------------------------------
 * Counting `acquired === true` would only show how many processes THINK they
 * won. The dangerous failure is a SECOND WORKER PRODUCING EFFECTS, so every
 * effect a real dispatch would produce is simulated as a file in `effectsDir`,
 * created ONLY after the lease is held:
 *
 *     <pid>.ack        stands for the CLAUDE_ACK the dispatched child posts
 *     <pid>.worktree   stands for the isolated task worktree
 *     <pid>.remote     stands for any other GitHub mutation
 *     <pid>.report     stands for the terminal CLAUDE_REPORT
 *
 * A loser must leave `effectsDir` untouched. The parent therefore asserts on the
 * DIRECTORY LISTING - what was actually created by anyone - rather than on what
 * each child says about itself, so a child that lies, crashes or is never
 * scheduled cannot hide a side effect.
 *
 * Ownership intervals (`enter_ms`/`exit_ms`) are recorded so the parent can test
 * for OVERLAP rather than counting, exactly as the lock racer does.
 *
 * The result file is always written, including on failure, so the parent can
 * insist every expected child is accounted for. Exit code 0 means "I completed
 * the protocol"; it does NOT mean "I acquired". A deliberate crash mode exits 9
 * and is the only non-zero exit that is not a protocol violation.
 *
 * argv: <admissionRoot> <taskId> <resultFile> <readyFile> <startFile> <effectsDir>
 *       <mode> <holdMs> <deadlineMs> <leaseTtlMs>
 *
 *   mode=single            one attempt at the collision point, then report
 *   mode=contend           retry until acquired or the deadline
 *   mode=crash_before_ack  acquire, produce NO effect at all, die (exit 9)
 *   mode=crash_after_ack   acquire, write ONLY the ack effect, die (exit 9)
 *   mode=terminal          acquire, produce every effect, terminalize the lease
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  acquireTaskAdmission,
  heartbeatTaskAdmission,
  releaseTaskAdmission,
  terminalizeTaskAdmission,
  holdsTaskAdmission
} from "../../lib/task-admission.mjs";

const [
  admissionRoot,
  taskId,
  resultFile,
  readyFile,
  startFile,
  effectsDir,
  mode = "single",
  holdRaw = "0",
  deadlineRaw = "20000",
  leaseTtlRaw = "900000"
] = process.argv.slice(2);

const holdMs = Number(holdRaw);
const deadlineMs = Number(deadlineRaw);
const leaseTtlMs = Number(leaseTtlRaw);

const result = {
  pid: process.pid,
  mode,
  protocol_complete: false,
  acquired: false,
  verdict: null,
  reason: null,
  lease_version: null,
  attempts: [],
  effects_written: [],
  enter_ms: null,
  exit_ms: null,
  beats: 0,
  still_held_at_exit: null,
  release_ok: null,
  terminalized: null,
  threw: null
};

function write() {
  mkdirSync(dirname(resultFile), { recursive: true });
  writeFileSync(resultFile, JSON.stringify(result, null, 2), "utf8");
}

/** A simulated side effect. Reachable ONLY from inside a held lease. */
function effect(kind) {
  const path = join(effectsDir, `${process.pid}.${kind}`);
  mkdirSync(effectsDir, { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: process.pid, kind, at: Date.now() }), "utf8");
  result.effects_written.push(kind);
}

const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) {
  Atomics.wait(SLEEPER, 0, 0, ms);
}

function waitWhile(predicate, untilMs, { spinLastMs = 0 } = {}) {
  while (predicate() && Date.now() < untilMs) {
    if (spinLastMs > 0 && untilMs - Date.now() <= spinLastMs) continue;
    sleep(1);
  }
}

try {
  writeFileSync(readyFile, String(process.pid), "utf8");
  waitWhile(() => !existsSync(startFile), Date.now() + deadlineMs, { spinLastMs: 0 });
  if (!existsSync(startFile)) throw new Error("parent never signalled START");

  const giveUpAt = Date.now() + deadlineMs;
  let held = null;

  do {
    const res = acquireTaskAdmission({ admissionRoot, taskId, leaseTtlMs });
    result.attempts.push({ at_ms: Date.now(), acquired: !!res.acquired, verdict: res.verdict ?? null });
    result.verdict = res.verdict ?? null;
    result.reason = res.reason ?? null;
    if (res.acquired) {
      held = res;
      break;
    }
    if (mode !== "contend") break;
    sleep(5);
  } while (Date.now() < giveUpAt);

  if (held) {
    result.acquired = true;
    result.lease_version = held.handle.version;
    result.enter_ms = Date.now();

    if (mode === "crash_before_ack") {
      // Die holding the lease, having produced NOTHING. This is the window the
      // architect asked to be proven: claimed, but not yet acknowledged.
      result.protocol_complete = true;
      write();
      process.exit(9);
    }

    effect("ack");

    if (mode === "crash_after_ack") {
      // Acknowledged, no terminal report. The next owner must RESUME or PARK,
      // and must not repeat the work.
      result.protocol_complete = true;
      write();
      process.exit(9);
    }

    effect("worktree");
    effect("remote");

    const holdUntil = result.enter_ms + holdMs;
    while (Date.now() < holdUntil) {
      if (heartbeatTaskAdmission(held.handle, { phase: "race-beat" })) result.beats += 1;
      if (!holdsTaskAdmission(held.handle)) break;
      sleep(10);
    }

    effect("report");
    result.still_held_at_exit = holdsTaskAdmission(held.handle);
    result.exit_ms = Date.now();

    if (mode === "terminal") {
      result.terminalized = terminalizeTaskAdmission(held.handle, {
        outcome: "completed",
        status: "PASS",
        successful: true,
        reportCommentId: 4242
      });
    } else {
      result.release_ok = releaseTaskAdmission(held.handle, { reason: "race_finished" });
    }
  }

  result.protocol_complete = true;
  write();
  process.exit(0);
} catch (err) {
  result.threw = String(err?.stack ?? err?.message ?? err);
  try { write(); } catch { /* nothing more we can do */ }
  process.exit(2);
}

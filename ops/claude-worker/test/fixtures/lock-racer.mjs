/**
 * Real, separate OS process that contends for the worker lock.
 *
 * The D126-LOCK review rejected the previous harness for good reasons:
 *   - it synchronised on a WALL-CLOCK barrier, so a late child could acquire
 *     legitimately after the first owner had already released;
 *   - it then counted `acquired === true` and treated the count as proof of
 *     overlapping ownership, which it is not;
 *   - missing result files were filtered away, so a child that died silently
 *     disappeared from the evidence.
 *
 * This fixture therefore reports INTERVALS, not counts, and it participates in
 * an explicit four-phase protocol with the parent:
 *
 *   1. READY     - the child writes `<readyFile>` and then blocks.
 *   2. START     - the parent creates `<startFile>` only after EVERY child is
 *                  ready; the children spin on it, so they collide for real.
 *   3. ATTEMPT   - each acquisition attempt is recorded with its verdict.
 *   4. RELEASE   - a successful holder records `enter_ms` before doing anything
 *                  and `exit_ms` immediately before releasing, so the parent can
 *                  test the critical sections for OVERLAP rather than counting.
 *
 * The result file is always written (even on failure), so the parent can insist
 * that every expected child is accounted for. Exit code 0 means "I completed the
 * protocol and my result file is trustworthy" - it does NOT mean "I acquired".
 * Any protocol violation exits non-zero.
 *
 * argv: <lockFile> <resultFile> <readyFile> <startFile> <holdMs> <mode> <deadlineMs>
 *   mode=contend   - retry until acquired or the deadline; MUST acquire
 *   mode=single    - exactly one attempt at the collision point
 *   mode=challenge - exactly one attempt; MUST be refused (a live owner exists)
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { acquireLock, heartbeat, releaseLock, holdsLock } from "../../lib/lock.mjs";

const [lockFile, resultFile, readyFile, startFile, holdRaw, mode = "contend", deadlineRaw = "20000"] =
  process.argv.slice(2);

const holdMs = Number(holdRaw);
const deadlineMs = Number(deadlineRaw);

const result = {
  pid: process.pid,
  mode,
  protocol_complete: false,
  acquired: false,
  attempts: [],
  enter_ms: null,
  exit_ms: null,
  beats: 0,
  lost_ownership_during_hold: false,
  still_held_at_exit: null,
  release_ok: null,
  threw: null
};

function write() {
  mkdirSync(dirname(resultFile), { recursive: true });
  writeFileSync(resultFile, JSON.stringify(result, null, 2), "utf8");
}

/**
 * Blocking sleep with no event loop and no busy wait.
 *
 * The first version of this harness busy-waited everywhere. With eight children
 * spinning at once the machine was oversubscribed, which starved processes and
 * made the SUITE flaky without saying anything about the lock. Waiting is now
 * genuinely idle; only the last millisecond before the barrier is spun on, which
 * is all that is needed for the children to collide.
 */
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
  waitWhile(() => !existsSync(startFile), Date.now() + deadlineMs);
  if (!existsSync(startFile)) throw new Error("parent never signalled START");

  const giveUpAt = Date.now() + deadlineMs;
  let held = null;

  do {
    const res = acquireLock(lockFile, { phase: "race", taskId: `racer-${process.pid}` });
    result.attempts.push({ at_ms: Date.now(), acquired: !!res.acquired, verdict: res.verdict?.state ?? null });
    if (res.acquired) {
      held = res;
      break;
    }
    if (mode !== "contend") break;
    sleep(5);
  } while (Date.now() < giveUpAt);

  if (held) {
    result.acquired = true;
    result.enter_ms = Date.now();

    const holdUntil = result.enter_ms + holdMs;
    while (Date.now() < holdUntil) {
      if (!heartbeat(lockFile, { token: held.token, phase: "race-beat" })) {
        result.lost_ownership_during_hold = true;
        break;
      }
      result.beats += 1;
      if (!holdsLock(lockFile, held.token)) {
        result.lost_ownership_during_hold = true;
        break;
      }
      sleep(10);
    }

    result.still_held_at_exit = holdsLock(lockFile, held.token);
    result.exit_ms = Date.now();
    result.release_ok = releaseLock(lockFile, held.token);
  }

  result.protocol_complete = true;
  write();
  process.exit(0);
} catch (err) {
  result.threw = String(err?.stack ?? err?.message ?? err);
  try { write(); } catch { /* nothing more we can do */ }
  process.exit(2);
}

/**
 * Real, separate OS process that races for the worker lock.
 *
 * The D126 review noted that the previous "racing" test was sequential and
 * therefore could not catch the reclaim race at all. This fixture is spawned N
 * times at once, all instances spin until the same wall-clock barrier, and then
 * they all try to acquire simultaneously.
 *
 * argv: <lockFile> <resultFile> <barrierEpochMs> <holdMs> [mode]
 *   mode=acquire (default) - acquire, hold, release
 *   mode=heartbeat         - acquire, heartbeat continuously for holdMs, release
 */

import { writeFileSync } from "node:fs";
import { acquireLock, heartbeat, releaseLock, holdsLock } from "../../lib/lock.mjs";

const [lockFile, resultFile, barrierRaw, holdRaw, mode = "acquire"] = process.argv.slice(2);
const barrier = Number(barrierRaw);
const holdMs = Number(holdRaw);

function spinUntil(untilMs) {
  while (Date.now() < untilMs) {
    // Deliberately a busy wait: a timer would let the OS stagger the wake-ups
    // and the processes would no longer genuinely collide.
  }
}

function write(result) {
  writeFileSync(resultFile, JSON.stringify({ pid: process.pid, ...result }, null, 2), "utf8");
}

spinUntil(barrier);

let res;
try {
  res = acquireLock(lockFile, { phase: "race", taskId: `racer-${process.pid}` });
} catch (err) {
  write({ acquired: false, threw: String(err.message ?? err) });
  process.exit(0);
}

if (!res.acquired) {
  write({ acquired: false, verdict: res.verdict ?? null });
  process.exit(0);
}

const deadline = Date.now() + holdMs;
let beats = 0;
let lostOwnership = false;

if (mode === "heartbeat") {
  while (Date.now() < deadline) {
    if (!heartbeat(lockFile, { token: res.token, phase: "race-beat" })) {
      lostOwnership = true;
      break;
    }
    beats += 1;
  }
} else {
  spinUntil(deadline);
  if (!holdsLock(lockFile, res.token)) lostOwnership = true;
}

write({ acquired: true, token: res.token, beats, lostOwnership, still_holds: holdsLock(lockFile, res.token) });
releaseLock(lockFile, res.token);
process.exit(0);

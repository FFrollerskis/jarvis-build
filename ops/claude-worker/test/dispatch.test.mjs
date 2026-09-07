/**
 * Direct-module tests for the child-identity handoff gate (D126 FINAL review
 * finding 1).
 *
 * `worker-crash-recovery.test.mjs` proves the gate through the REAL entrypoint
 * as a real OS process. This file covers the branches an OS process cannot be
 * made to produce on demand: a child that does not die when it is signalled, and
 * an identity whose liveness cannot be established at all. Both must end as
 * "there may be an untracked live child", never as a completion.
 *
 * The child is injected, so the abort escalation, the identity verification and
 * the reported outcome are exercised without depending on host timing.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";

import { runClaude, OUTCOME, buildPrompt, SUPPORTED_PROMPT_DELIVERY } from "../lib/dispatch.mjs";
import { IDENTITY } from "../lib/procid.mjs";

const CFG = {
  repoOwner: "tsworkflow",
  repoName: "jarvisbuild",
  controlIssue: 68,
  repoPath: "/nonexistent",
  scratchRoot: "/nonexistent/tmp",
  claudeCommand: "node",
  claudeArgs: [],
  promptDelivery: "stdin",
  claudeTimeoutMinutes: 60
};

const TASK = {
  comment: {
    id: 1,
    user: { login: "tsworkflow" },
    created_at: "2026-09-07T00:00:00.000Z",
    body: "ARCHITECT_TASK\nTASK_ID=T-1\nDo the thing."
  },
  scratchDir: "/nonexistent/tmp/T-1"
};

const IDENT = { pid: 14, host: "test-host", start_time: "2026-09-07T01:00:00Z", observed_at: "2026-09-07T01:00:01Z" };

/**
 * A stand-in child process. `diesOnSignal: false` models the case the abort
 * escalation exists for: a process that does not go away when asked.
 */
function fakeChild({ pid = 14, diesOnSignal = true } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.signals = [];
  child.stdinEnded = false;
  child.stdinPayload = undefined;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    on: () => {},
    end: (payload) => { child.stdinEnded = true; child.stdinPayload = payload; }
  };
  child.kill = (signal) => {
    child.signals.push(signal);
    if (diesOnSignal) setTimeout(() => child.emit("close", null, signal), 5);
    return true;
  };
  return child;
}

function run(overrides = {}, cfg = CFG) {
  const child = overrides.child ?? fakeChild();
  const opts = {
    spawnImpl: () => child,
    identityImpl: () => IDENT,
    matchImpl: () => ({ state: IDENTITY.GONE, reason: "pid 14 no longer exists" }),
    heartbeatMs: 10_000,
    abortTermGraceMs: 30,
    abortDeadlineMs: 900,
    ...overrides
  };
  delete opts.child;
  return { child, promise: runClaude(cfg, TASK, opts) };
}

describe("finding 1: a failed handoff is never a completion", () => {
  /**
   * The architect's exact direct-module reproduction on f123e650: `onSpawn`
   * throwing `durable write failed` returned
   * `{"outcome":"completed_exit_0","code":0,"childPid":14}`.
   */
  it("the architect's repro no longer returns completed_exit_0", async () => {
    const { promise } = run({ onSpawn: () => { throw new Error("durable write failed"); } });
    const res = await promise;
    expect(res.outcome).toBe(OUTCOME.HANDOFF_FAILED);
    expect(res.outcome).not.toBe(OUTCOME.COMPLETED_EXIT_0);
    expect(res.code).toBeUndefined();
    expect(res.error).toMatch(/durable write failed/);
    expect(res.handoff.failed).toBe(true);
    expect(res.handoff.aborted).toBe(true);
    expect(res.handoff.child_terminated).toBe(true);
    expect(res.handoff.untracked_child_live).toBe(false);
  });

  it("the child is signalled gracefully first, never force-killed by default", async () => {
    const { child, promise } = run({ onSpawn: () => { throw new Error("durable write failed"); } });
    await promise;
    expect(child.signals[0]).toBe("SIGTERM");
    expect(child.signals).not.toContain("SIGKILL");
  });

  it("the task is never delivered to a child whose handoff failed", async () => {
    const { child, promise } = run({ onSpawn: () => { throw new Error("durable write failed"); } });
    await promise;
    // The handshake: with stdin delivery the prompt IS the task, and it is only
    // written once the identity record and lock heartbeat are durable.
    expect(child.stdinPayload).toBeUndefined();
  });

  it("a successful handoff does deliver the task, unchanged", async () => {
    const child = fakeChild();
    const { promise } = run({
      child,
      onSpawn: () => {},
      spawnImpl: () => { setTimeout(() => child.emit("close", 0, null), 5); return child; }
    });
    const res = await promise;
    expect(res.outcome).toBe(OUTCOME.COMPLETED_EXIT_0);
    expect(child.stdinPayload).toBe(buildPrompt(CFG, TASK));
  });

  it("the identity record is handed over BEFORE the task is delivered", async () => {
    const order = [];
    const child = fakeChild();
    // The spy must exist BEFORE runClaude runs: it delivers the prompt
    // synchronously inside the promise executor.
    child.stdin.end = (payload) => { order.push("prompt"); child.stdinPayload = payload; };
    const { promise } = run({
      child,
      onSpawn: (identity) => { order.push(`onSpawn:${identity.pid}`); },
      spawnImpl: () => { setTimeout(() => child.emit("close", 0, null), 5); return child; }
    });
    await promise;
    // The first heartbeat is the second half of the gate, so it lands between
    // the identity record and the prompt - never after it.
    expect(order).toEqual(["onSpawn:14", "prompt"]);
  });
});

/**
 * D126 REVIEW F, finding 1: the gate covered `onSpawn` but not `onHeartbeat`.
 *
 * The architect injected a throwing `onHeartbeat` together with a successful
 * `onSpawn` into the real `runClaude` and got:
 *
 *   {"rejected":"heartbeat persistence failed","kills":0,"writes":0,
 *    "closeListeners":0,"errorListeners":0}
 *
 * Every number in that object is a separate defect: the promise REJECTED rather
 * than resolving to an outcome, nothing was killed, and the live child had no
 * `close` or `error` listener because the immediate call sat ABOVE the listener
 * setup. `writes: 0` is the one reassuring number - the prompt had not been
 * delivered - and it must stay 0.
 */
describe("review F: a failing IMMEDIATE heartbeat is a failed handoff, not a rejection", () => {
  function runImmediateFailure(overrides = {}, cfg = CFG) {
    const child = overrides.child ?? fakeChild();
    const seen = { closeListeners: null, errorListeners: null };
    const opts = {
      spawnImpl: () => child,
      identityImpl: () => IDENT,
      matchImpl: () => ({ state: IDENTITY.GONE, reason: "pid 14 no longer exists" }),
      onSpawn: () => {},
      onHeartbeat: () => {
        seen.closeListeners = child.listenerCount("close");
        seen.errorListeners = child.listenerCount("error");
        throw new Error("heartbeat persistence failed");
      },
      heartbeatMs: 10_000,
      abortTermGraceMs: 30,
      abortDeadlineMs: 900,
      ...overrides
    };
    delete opts.child;
    return { child, seen, promise: runClaude(cfg, TASK, opts) };
  }

  it("does not reject: it resolves to HANDOFF_FAILED", async () => {
    let rejection = null;
    const { promise } = runImmediateFailure();
    const res = await promise.catch((err) => { rejection = err; return null; });
    // "rejected":"heartbeat persistence failed" - gone.
    expect(rejection).toBeNull();
    expect(res.outcome).toBe(OUTCOME.HANDOFF_FAILED);
    expect(res.outcome).not.toBe(OUTCOME.COMPLETED_EXIT_0);
    expect(res.code).toBeUndefined();
    expect(res.error).toMatch(/heartbeat persistence failed/);
    // Which half of the handoff broke, so the caller is not left guessing.
    expect(res.handoff.stage).toBe("first_heartbeat");
  });

  it("the child IS cleaned up: kills is no longer 0", async () => {
    const { child, promise } = runImmediateFailure();
    const res = await promise;
    expect(child.signals[0]).toBe("SIGTERM");
    expect(child.signals.length).toBeGreaterThan(0);
    expect(res.handoff.aborted).toBe(true);
    expect(res.handoff.child_terminated).toBe(true);
    expect(res.handoff.untracked_child_live).toBe(false);
  });

  it("the close and error listeners are already attached when the callback runs", async () => {
    const { seen, promise } = runImmediateFailure();
    await promise;
    // "closeListeners":0,"errorListeners":0 - both were zero because the
    // immediate call ran above the listener setup. They are now non-zero.
    expect(seen.closeListeners).toBeGreaterThan(0);
    expect(seen.errorListeners).toBeGreaterThan(0);
  });

  it("delivers ZERO prompt bytes - the pre-gate task effect stays at nothing", async () => {
    const { child, promise } = runImmediateFailure();
    await promise;
    expect(child.stdinPayload).toBeUndefined();
    expect(child.stdinEnded).toBe(false);
  });

  it("leaves no heartbeat interval armed for a child that was aborted", async () => {
    let calls = 0;
    const { promise } = runImmediateFailure({
      heartbeatMs: 5,
      onHeartbeat: () => { calls += 1; throw new Error("heartbeat persistence failed"); }
    });
    await promise;
    const atSettle = calls;
    await new Promise((r) => setTimeout(r, 80));
    // The interval used to be created BEFORE the immediate call and survived the
    // rejection. There must be exactly one call ever: the gate's own.
    expect(atSettle).toBe(1);
    expect(calls).toBe(atSettle);
  });

  it("leaves no timeout timer armed after the abort settles", async () => {
    // 60 ms timeout: it would fire well after the ~40 ms abort if it survived.
    const { child, promise } = runImmediateFailure({}, { ...CFG, claudeTimeoutMinutes: 0.001 });
    await promise;
    const atSettle = [...child.signals];
    await new Promise((r) => setTimeout(r, 250));
    expect(child.signals).toEqual(atSettle);
  });

  it("preserves the EXACT captured identity, never a bare pid", async () => {
    const { promise } = runImmediateFailure({
      child: fakeChild({ diesOnSignal: false }),
      matchImpl: () => ({ state: IDENTITY.MATCH, reason: "pid 14 is still the same process" })
    });
    const res = await promise;
    expect(res.childIdentity).toEqual(IDENT);
    expect(res.handoff.untracked_child_live).toBe(true);
    expect(res.handoff.identity_state).toBe(IDENTITY.MATCH);
  });

  /**
   * `lock.heartbeat` reports LOST OWNERSHIP by returning false, not by throwing.
   * An ignored return value is exactly how that became invisible.
   */
  it("a strict false from the first heartbeat fails the gate just like a throw", async () => {
    const { child, promise } = runImmediateFailure({ onHeartbeat: () => false });
    const res = await promise;
    expect(res.outcome).toBe(OUTCOME.HANDOFF_FAILED);
    expect(res.handoff.stage).toBe("first_heartbeat");
    expect(res.heartbeat.ownership_lost).toBe(true);
    expect(res.error).toMatch(/lost ownership/);
    expect(child.stdinPayload).toBeUndefined();
    expect(child.signals[0]).toBe("SIGTERM");
  });

  it("an ordinary undefined return is a SUCCESS, not a failure", async () => {
    const child = fakeChild();
    const res = await runClaude(CFG, TASK, {
      spawnImpl: () => { setTimeout(() => child.emit("close", 0, null), 5); return child; },
      identityImpl: () => IDENT,
      onSpawn: () => {},
      onHeartbeat: () => undefined,
      heartbeatMs: 10_000
    });
    expect(res.outcome).toBe(OUTCOME.COMPLETED_EXIT_0);
    expect(res.heartbeat.degraded).toBe(false);
    expect(res.heartbeat.unrecovered).toBe(false);
    expect(res.heartbeat.succeeded).toBe(1);
    expect(child.stdinPayload).toBe(buildPrompt(CFG, TASK));
  });

  it("an onSpawn failure is still attributed to the identity record, not the heartbeat", async () => {
    const { promise } = run({ onSpawn: () => { throw new Error("durable write failed"); } });
    const res = await promise;
    expect(res.handoff.stage).toBe("identity_record");
    // The heartbeat was never even attempted for a child that failed earlier.
    expect(res.heartbeat.attempted).toBe(0);
  });
});

/**
 * D126 REVIEW F, finding 2: the PERIODIC callback had no exception boundary at
 * all. A throw inside a `setInterval` callback is an uncaught exception - it
 * does not reject the dispatch promise, it takes the whole worker process down
 * mid-dispatch, orphaning a live child.
 *
 * The constraint is two-sided: no crash and no false healthy claim, but also no
 * killing of a child that is doing legitimate authorized work.
 */
describe("review F: a failing PERIODIC heartbeat neither crashes nor claims health", () => {
  /** A child that stays alive across several beats, then exits cleanly. */
  function runPeriodic({ onHeartbeat, liveMs = 90, heartbeatMs = 10 }) {
    const child = fakeChild();
    return {
      child,
      promise: runClaude(CFG, TASK, {
        spawnImpl: () => { setTimeout(() => child.emit("close", 0, null), liveMs); return child; },
        identityImpl: () => IDENT,
        matchImpl: () => ({ state: IDENTITY.GONE, reason: "pid 14 no longer exists" }),
        onSpawn: () => {},
        onHeartbeat,
        heartbeatMs
      })
    };
  }

  it("a throwing periodic beat does not reject and does not kill the child", async () => {
    let rejection = null;
    let calls = 0;
    const { child, promise } = runPeriodic({
      onHeartbeat: () => { calls += 1; if (calls > 1) throw new Error("durable write failed"); }
    });
    const res = await promise.catch((err) => { rejection = err; return null; });
    expect(rejection).toBeNull();
    expect(calls).toBeGreaterThan(1);
    // The child was doing real work. Bookkeeping failure is not a death warrant.
    expect(child.signals).toEqual([]);
    // The task WAS delivered - the gate had already passed.
    expect(child.stdinPayload).toBe(buildPrompt(CFG, TASK));
    // The exit code is reported truthfully...
    expect(res.outcome).toBe(OUTCOME.COMPLETED_EXIT_0);
    // ...but the run is NOT presented as healthy.
    expect(res.heartbeat.degraded).toBe(true);
    expect(res.heartbeat.unrecovered).toBe(true);
    expect(res.heartbeat.failures).toBeGreaterThan(0);
    expect(res.heartbeat.last_error).toMatch(/durable write failed/);
  });

  it("a periodic failure that RECOVERS is degraded but not unrecovered", async () => {
    let calls = 0;
    const { promise } = runPeriodic({
      // Fail only the second beat; every later one succeeds again.
      onHeartbeat: () => { calls += 1; if (calls === 2) throw new Error("transient disk hiccup"); }
    });
    const res = await promise;
    expect(res.heartbeat.failures).toBe(1);
    expect(res.heartbeat.degraded).toBe(true);
    // It came back before the dispatch settled, so the lock was ours at the end.
    expect(res.heartbeat.consecutive_failures).toBe(0);
    expect(res.heartbeat.unrecovered).toBe(false);
    expect(res.heartbeat.ownership_lost).toBe(false);
  });

  it("ownership lost on a later beat is sticky, stops the beating, and never recovers", async () => {
    let calls = 0;
    const { child, promise } = runPeriodic({
      onHeartbeat: () => { calls += 1; return calls === 1 ? true : false; }
    });
    const res = await promise;
    // Beat 1 (the gate) succeeded; beat 2 reported lost ownership and the
    // interval stopped rather than failing on a fixed schedule forever.
    expect(calls).toBe(2);
    expect(res.heartbeat.ownership_lost).toBe(true);
    expect(res.heartbeat.unrecovered).toBe(true);
    expect(res.outcome).toBe(OUTCOME.COMPLETED_EXIT_0);
    // Still no killing of legitimate work.
    expect(child.signals).toEqual([]);
  });

  it("a fully healthy run reports no degradation at all", async () => {
    const { promise } = runPeriodic({ onHeartbeat: () => true });
    const res = await promise;
    expect(res.heartbeat.degraded).toBe(false);
    expect(res.heartbeat.unrecovered).toBe(false);
    expect(res.heartbeat.ownership_lost).toBe(false);
    expect(res.heartbeat.failures).toBe(0);
    expect(res.heartbeat.succeeded).toBe(res.heartbeat.attempted);
  });

  it("beating stops once the dispatch has settled", async () => {
    let calls = 0;
    const { promise } = runPeriodic({ onHeartbeat: () => { calls += 1; }, liveMs: 45 });
    await promise;
    const atSettle = calls;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(atSettle);
  });
});

describe("finding 1: termination is verified, never assumed", () => {
  it("a child that will not die is reported as a POSSIBLE untracked live child", async () => {
    const { child, promise } = run({
      child: fakeChild({ diesOnSignal: false }),
      onSpawn: () => { throw new Error("durable write failed"); },
      matchImpl: () => ({ state: IDENTITY.MATCH, reason: "pid 14 is the same process that was recorded" })
    });
    const res = await promise;
    expect(res.outcome).toBe(OUTCOME.HANDOFF_FAILED);
    expect(res.handoff.child_terminated).toBe(false);
    expect(res.handoff.untracked_child_live).toBe(true);
    expect(res.handoff.identity_state).toBe(IDENTITY.MATCH);
    // Escalation happened, in order, and only after the graceful window.
    expect(res.handoff.escalated_to_force).toBe(true);
    expect(child.signals[0]).toBe("SIGTERM");
    expect(child.signals).toContain("SIGKILL");
    // The identity is still carried, because it is the only thing a later
    // recovery can use to find that orphan.
    expect(res.childIdentity).toEqual(IDENT);
  });

  it("UNPROVEN liveness is NOT accepted as proof of death", async () => {
    const { promise } = run({
      child: fakeChild({ diesOnSignal: false }),
      onSpawn: () => { throw new Error("durable write failed"); },
      matchImpl: () => ({ state: IDENTITY.UNPROVEN, reason: "start time cannot be read now" })
    });
    const res = await promise;
    expect(res.handoff.child_terminated).toBe(false);
    expect(res.handoff.untracked_child_live).toBe(true);
  });

  it("a REUSED pid proves our child is gone: it is a different process now", async () => {
    const { promise } = run({
      child: fakeChild({ diesOnSignal: false }),
      onSpawn: () => { throw new Error("durable write failed"); },
      matchImpl: () => ({ state: IDENTITY.REUSED, reason: "pid 14 was reused by a different process" })
    });
    const res = await promise;
    expect(res.handoff.child_terminated).toBe(true);
    expect(res.handoff.untracked_child_live).toBe(false);
  });

  it("a verification that throws is treated as unproven, not as success", async () => {
    const { promise } = run({
      child: fakeChild({ diesOnSignal: false }),
      onSpawn: () => { throw new Error("durable write failed"); },
      matchImpl: () => { throw new Error("probe exploded"); }
    });
    const res = await promise;
    expect(res.handoff.child_terminated).toBe(false);
    expect(res.handoff.untracked_child_live).toBe(true);
  });

  /**
   * The ordinary close handler and the abort both listen for `close`. Without
   * the `aborting` guard the ordinary one wins the race and reports exactly the
   * `completed_exit_0` this finding is about.
   */
  it("a child that exits 0 DURING the abort still reports a failed handoff", async () => {
    const child = fakeChild({ diesOnSignal: false });
    const { promise } = run({
      child,
      onSpawn: () => {
        setTimeout(() => child.emit("close", 0, null), 10);
        throw new Error("durable write failed");
      }
    });
    const res = await promise;
    expect(res.outcome).toBe(OUTCOME.HANDOFF_FAILED);
    expect(res.code).toBeUndefined();
  });

  it("no heartbeat is issued for a child whose handoff failed", async () => {
    let beats = 0;
    const { promise } = run({
      onSpawn: () => { throw new Error("durable write failed"); },
      onHeartbeat: () => { beats += 1; },
      heartbeatMs: 5
    });
    await promise;
    expect(beats).toBe(0);
  });
});

/**
 * D126 ADDENDUM ITEM 4: "accepted argv delivery bypasses the durable
 * pre-execution handoff gate".
 *
 * `argv` put the complete task on the command line handed to `spawn`, so the
 * child could read and begin executing the authorized task before `onSpawn` had
 * committed anything. The abort path could still fire, but it could never prove
 * the task had not already been consumed - and no dispatch test covered the
 * accepted argv path at all.
 *
 * The correction is the strong one the addendum prefers: `stdin` is the ONLY
 * accepted mode, and the rejection is enforced here in `runClaude` as well as in
 * `config.mjs`, because a DIRECT module call never goes through config loading.
 */
describe("addendum item 4: stdin is the only accepted prompt-delivery mode", () => {
  it("stdin is the entire accepted set", () => {
    expect(SUPPORTED_PROMPT_DELIVERY).toEqual(["stdin"]);
  });

  for (const mode of ["argv", "carrier-pigeon", "", null, undefined]) {
    it(`a DIRECT module call with promptDelivery=${JSON.stringify(mode)} spawns nothing`, async () => {
      let spawned = 0;
      const res = await runClaude({ ...CFG, promptDelivery: mode }, TASK, {
        spawnImpl: () => { spawned += 1; return fakeChild(); },
        onSpawn: () => {},
        onHeartbeat: () => {}
      });
      // The rejection happens BEFORE process creation, which is the only point
      // at which "the child has not consumed the task" is provable at all.
      expect(spawned).toBe(0);
      expect(res.outcome).toBe(OUTCOME.UNSUPPORTED_PROMPT_DELIVERY);
      expect(res.spawned).toBe(false);
      expect(res.promptBuilt).toBe(false);
      expect(res.childPid).toBeNull();
      expect(res.childIdentity).toBeNull();
      expect(res.error).toMatch(/promptDelivery must be "stdin"/);
      // Never mistakable for a completed run.
      expect(res.outcome).not.toBe(OUTCOME.COMPLETED_EXIT_0);
      expect(res.code).toBeUndefined();
    });
  }

  it("the prompt is NEVER placed on the child's command line", async () => {
    let seenArgs = null;
    const child = fakeChild();
    await runClaude({ ...CFG, claudeArgs: ["--print", "--model", "opus"] }, TASK, {
      spawnImpl: (_cmd, args) => { seenArgs = args; setTimeout(() => child.emit("close", 0, null), 5); return child; },
      identityImpl: () => IDENT,
      onSpawn: () => {},
      heartbeatMs: 10_000
    });
    expect(seenArgs).toEqual(["--print", "--model", "opus"]);
    // The decisive property: nothing in argv carries the task.
    for (const arg of seenArgs) {
      expect(arg).not.toContain("ARCHITECT_TASK");
      expect(arg).not.toContain(TASK.comment.body);
    }
    // It travelled over stdin instead, after the gate.
    expect(child.stdinPayload).toBe(buildPrompt({ ...CFG, claudeArgs: ["--print", "--model", "opus"] }, TASK));
  });

  /**
   * The addendum's core demand: for EVERY accepted delivery mode, injected
   * persistence and heartbeat failures must prove zero prompt consumption and
   * zero task effects before the gate succeeds.
   */
  for (const mode of SUPPORTED_PROMPT_DELIVERY) {
    describe(`accepted mode "${mode}"`, () => {
      for (const [label, failure] of [
        ["a persistence failure", new Error("durable write failed")],
        ["a lock-heartbeat failure", new Error("the worker lock could not be heartbeated with the child's identity at spawn")]
      ]) {
        it(`${label} in the gate delivers ZERO prompt bytes to the child`, async () => {
          const child = fakeChild();
          const res = await runClaude({ ...CFG, promptDelivery: mode }, TASK, {
            spawnImpl: () => child,
            identityImpl: () => IDENT,
            matchImpl: () => ({ state: IDENTITY.GONE, reason: "pid 14 no longer exists" }),
            onSpawn: () => { throw failure; },
            heartbeatMs: 10_000,
            abortTermGraceMs: 30,
            abortDeadlineMs: 900
          });
          expect(res.outcome).toBe(OUTCOME.HANDOFF_FAILED);
          // Not "an empty prompt was written" - stdin was never ended at all,
          // so the child got no task and no end-of-input to act on.
          expect(child.stdinPayload).toBeUndefined();
          expect(child.stdinEnded).toBe(false);
          expect(res.handoff.child_terminated).toBe(true);
        });
      }

      it("the gate runs to completion BEFORE a single prompt byte is written", async () => {
        const order = [];
        const child = fakeChild();
        child.stdin.end = (payload) => { order.push("prompt"); child.stdinPayload = payload; };
        await runClaude({ ...CFG, promptDelivery: mode }, TASK, {
          spawnImpl: () => { setTimeout(() => child.emit("close", 0, null), 5); return child; },
          identityImpl: () => IDENT,
          onSpawn: () => { order.push("persist"); order.push("heartbeat"); },
          onHeartbeat: () => { order.push("beat"); },
          heartbeatMs: 10_000
        });
        // Persistence and heartbeat both commit first; the prompt is last.
        expect(order.indexOf("persist")).toBeLessThan(order.indexOf("prompt"));
        expect(order.indexOf("heartbeat")).toBeLessThan(order.indexOf("prompt"));
        expect(order[order.length - 1]).toBe("prompt");
      });
    });
  }
});

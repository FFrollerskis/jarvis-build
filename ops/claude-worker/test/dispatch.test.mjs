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
    expect(order).toEqual(["onSpawn:14", "prompt"]);
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

/**
 * D-166: cross-worker admission exclusivity per TASK_ID.
 *
 * The invariant under test is NOT "the module refuses when asked nicely". It is:
 *
 *     Across concurrent OS processes, crashes and reboots, at most ONE worker
 *     ever produces effects for a given TASK_ID, and a TASK_ID that has reached
 *     a terminal report never produces effects again.
 *
 * So the multi-process tests assert on the EFFECTS DIRECTORY - what any process
 * actually created - rather than on what each process reports about itself. A
 * contender that lies, crashes or is descheduled cannot hide a side effect from
 * a directory listing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  ADMISSION,
  CONTENDED_VERDICTS,
  LEASE_STATE,
  DEFAULT_LEASE_TTL_MS,
  acquireTaskAdmission,
  classifyLease,
  heartbeatTaskAdmission,
  holdsTaskAdmission,
  releaseTaskAdmission,
  terminalizeTaskAdmission,
  inspectTaskAdmission,
  scanTaskLedger,
  taskLedgerDir,
  admissionRootFor,
  admissionScopeKey,
  validateLeaseSchema
} from "../lib/task-admission.mjs";
import { classifyReportStatus, TERMINAL_STATUS_ALIASES } from "../lib/reconcile.mjs";

const RACER = fileURLToPath(new URL("./fixtures/admission-racer.mjs", import.meta.url));
const TASK_ID = "D166-SYNTHETIC-ADMISSION-RACE-20260917-A";

let dir;
let admissionRoot;
let effectsDir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-admission-"));
  admissionRoot = join(dir, "admission");
  effectsDir = join(dir, "effects");
  mkdirSync(effectsDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Every effect file any process created, as `<kind>` counts. */
function effectsByKind() {
  const out = {};
  for (const name of readdirSync(effectsDir)) {
    const kind = name.split(".").pop();
    (out[kind] ??= []).push(name);
  }
  return out;
}

function runRacers(count, { mode = "single", holdMs = 120, deadlineMs = 25_000, leaseTtlMs = DEFAULT_LEASE_TTL_MS, taskId = TASK_ID } = {}) {
  const startFile = join(dir, `start-${Math.random().toString(36).slice(2)}`);
  const children = [];
  for (let i = 0; i < count; i += 1) {
    const resultFile = join(dir, `result-${mode}-${i}-${Date.now()}-${i}.json`);
    const readyFile = join(dir, `ready-${mode}-${i}-${Date.now()}-${i}`);
    const child = spawn(process.execPath, [
      RACER, admissionRoot, taskId, resultFile, readyFile, startFile, effectsDir,
      mode, String(holdMs), String(deadlineMs), String(leaseTtlMs)
    ], { stdio: "ignore" });
    children.push({ child, resultFile, readyFile, exit: new Promise((res) => child.on("exit", (code) => res(code))) });
  }

  return (async () => {
    // Every child must be READY before any of them is allowed to attempt, so the
    // collision is real rather than a staggered sequence that would pass trivially.
    const readyBy = Date.now() + deadlineMs;
    while (Date.now() < readyBy && !children.every((c) => existsSync(c.readyFile))) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(children.every((c) => existsSync(c.readyFile))).toBe(true);

    writeFileSync(startFile, "go", "utf8");
    const codes = await Promise.all(children.map((c) => c.exit));
    const results = children.map((c) => {
      // A missing result file is a HARD failure, never filtered away: a child that
      // vanished silently is exactly the one that might have produced an effect.
      expect(existsSync(c.resultFile), `child result file missing: ${c.resultFile}`).toBe(true);
      return JSON.parse(readFileSync(c.resultFile, "utf8"));
    });
    return { codes, results };
  })();
}

/** Do any two ownership intervals overlap? */
function anyOverlap(results) {
  const held = results.filter((r) => r.acquired && r.enter_ms !== null && r.exit_ms !== null)
    .map((r) => [r.enter_ms, r.exit_ms])
    .sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < held.length; i += 1) {
    if (held[i][0] < held[i - 1][1]) return true;
  }
  return false;
}

/** ---------------------------------------------------------------- */
describe("admission root is SHARED across deployments", () => {
  it("is derived from the control-plane identity, not from the worker's own root", () => {
    const a = admissionRootFor({ repoOwner: "tsworkflow", repoName: "jarvisbuild", controlIssue: 68 });
    const b = admissionRootFor({ repoOwner: "tsworkflow", repoName: "jarvisbuild", controlIssue: 68 });
    expect(a).toBe(b);
    // The whole D-165 defect in one assertion: two deployments, one meeting point.
    expect(admissionScopeKey({ repoOwner: "tsworkflow", repoName: "jarvisbuild", controlIssue: 68 }))
      .toBe("tsworkflow__jarvisbuild__issue68");
  });

  it("separates different control planes", () => {
    expect(admissionRootFor({ repoOwner: "o", repoName: "r", controlIssue: 1 }))
      .not.toBe(admissionRootFor({ repoOwner: "o", repoName: "r", controlIssue: 2 }));
  });

  it("honours an explicit override so a test rig can be isolated on purpose", () => {
    expect(admissionRootFor({ admissionRoot: join(dir, "explicit") })).toBe(join(dir, "explicit"));
  });

  it("refuses to derive a path from an unsafe TASK_ID", () => {
    expect(() => taskLedgerDir(admissionRoot, "../escape")).toThrow(/unsafe TASK_ID/);
    const res = acquireTaskAdmission({ admissionRoot, taskId: "../escape" });
    expect(res.acquired).toBe(false);
    expect(res.verdict).toBe(ADMISSION.UNSAFE_TASK_ID);
  });
});

/** ---------------------------------------------------------------- */
describe("PROOF 1 - two concurrent processes, one owner", () => {
  it("admits exactly one, and only that one produces ANY effect", async () => {
    const { codes, results } = await runRacers(2, { mode: "single", holdMs: 150 });

    expect(codes).toEqual([0, 0]);
    expect(results.every((r) => r.protocol_complete)).toBe(true);
    expect(results.every((r) => r.threw === null)).toBe(true);

    const winners = results.filter((r) => r.acquired);
    const losers = results.filter((r) => !r.acquired);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // The loser saw a real owner and said so, rather than failing for some
    // unrelated reason that would have made the exclusion accidental.
    for (const l of losers) {
      expect(CONTENDED_VERDICTS).toContain(l.verdict);
      expect(l.effects_written).toEqual([]);
    }

    // THE DECISIVE ASSERTION: one ack, one worktree, one remote mutation, one
    // report - in total, across every process, read from the filesystem.
    const effects = effectsByKind();
    expect(effects.ack).toHaveLength(1);
    expect(effects.worktree).toHaveLength(1);
    expect(effects.remote).toHaveLength(1);
    expect(effects.report).toHaveLength(1);
    expect(effects.ack[0].startsWith(`${winners[0].pid}.`)).toBe(true);

    expect(anyOverlap(results)).toBe(false);
  }, 60_000);
});

describe("PROOF 2 - ten concurrent processes, one owner", () => {
  it("holds the same invariant under real contention", async () => {
    const { codes, results } = await runRacers(10, { mode: "single", holdMs: 200 });

    expect(codes.every((c) => c === 0)).toBe(true);
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.protocol_complete)).toBe(true);

    const winners = results.filter((r) => r.acquired);
    expect(winners).toHaveLength(1);

    for (const l of results.filter((r) => !r.acquired)) {
      expect(CONTENDED_VERDICTS).toContain(l.verdict);
      expect(l.effects_written).toEqual([]);
    }

    const effects = effectsByKind();
    expect(effects.ack).toHaveLength(1);
    expect(effects.worktree).toHaveLength(1);
    expect(effects.remote).toHaveLength(1);
    expect(effects.report).toHaveLength(1);
    expect(anyOverlap(results)).toBe(false);

    // Nine losers appended nothing at all: the ledger holds exactly the one
    // version the winner published. A loser that had published speculatively and
    // retracted would leave a `void` file, which is legitimate - but must not
    // happen here, because the winner published first and every loser saw it.
    const ledger = scanTaskLedger(taskLedgerDir(admissionRoot, TASK_ID));
    expect(ledger.lease.info.state).toBe(LEASE_STATE.RELEASED);
    expect(ledger.lease.info.pid).toBe(winners[0].pid);
  }, 90_000);
});

describe("PROOF 2b - a serial second wave admits exactly one NEW owner", () => {
  it("does not let a released lease admit two", async () => {
    const first = await runRacers(3, { mode: "single", holdMs: 80 });
    expect(first.results.filter((r) => r.acquired)).toHaveLength(1);

    const second = await runRacers(3, { mode: "single", holdMs: 80 });
    expect(second.results.filter((r) => r.acquired)).toHaveLength(1);

    // Two waves, two owners TOTAL - never three, and never two at once.
    const effects = effectsByKind();
    expect(effects.ack).toHaveLength(2);
    expect(anyOverlap([...first.results, ...second.results])).toBe(false);
  }, 90_000);
});

/** ---------------------------------------------------------------- */
describe("PROOF 3 - crash after the claim, before the ACK", () => {
  it("leaves a held lease that BLOCKS, and only an explicit expiry + CAS admits exactly one successor", async () => {
    // A generous TTL, so the crashed owner's lease is genuinely unexpired.
    const crashed = await runRacers(1, { mode: "crash_before_ack", leaseTtlMs: 10 * 60_000 });
    expect(crashed.codes).toEqual([9]);
    expect(crashed.results[0].acquired).toBe(true);
    // The crash window: claimed, and NOTHING produced.
    expect(crashed.results[0].effects_written).toEqual([]);
    expect(readdirSync(effectsDir)).toEqual([]);

    const ledgerDir = taskLedgerDir(admissionRoot, TASK_ID);
    const held = scanTaskLedger(ledgerDir).lease.info;
    expect(held.state).toBe(LEASE_STATE.HELD);
    expect(held.pid).toBe(crashed.results[0].pid);

    // 1. The owner is provably gone, but the lease has NOT expired: refuse.
    const early = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, nowMs: Date.now() });
    expect(early.acquired).toBe(false);
    expect(early.verdict).toBe(ADMISSION.HELD_NOT_EXPIRED);
    expect(scanTaskLedger(ledgerDir).versions).toEqual([1]);

    // 2. A live owner is NEVER taken over, however long the lease has expired.
    //    Expiry alone is not a licence; the owner must also be provably gone.
    const liveButExpired = acquireTaskAdmission({
      admissionRoot,
      taskId: TASK_ID,
      nowMs: held.lease_expires_at_ms + 10 * 60_000,
      alive: () => true,
      startTime: () => held.start_time
    });
    expect(liveButExpired.acquired).toBe(false);
    expect(liveButExpired.verdict).toBe(ADMISSION.HELD_ACTIVE);

    // 3. Gone AND expired: exactly one successor, and it is version 2 - a CAS
    //    against the exact version observed, not a deletion of version 1.
    const afterExpiry = Date.now() + 11 * 60_000;
    const winner = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, nowMs: afterExpiry });
    expect(winner.acquired).toBe(true);
    expect(winner.handle.version).toBe(2);

    // 4. A second contender at the same moment is refused by the NEW owner.
    const alsoTrying = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, nowMs: afterExpiry });
    expect(alsoTrying.acquired).toBe(false);
    expect(alsoTrying.verdict).toBe(ADMISSION.HELD_ACTIVE);

    // The crashed owner's evidence was never destroyed.
    const ledger = scanTaskLedger(ledgerDir);
    expect(ledger.versions).toEqual([1, 2]);
    expect(JSON.parse(readFileSync(join(ledgerDir, "000000000001.lease"), "utf8")).pid)
      .toBe(crashed.results[0].pid);
  }, 60_000);

  it("admits exactly one successor when TEN processes race for an expired, dead lease", async () => {
    // A very short TTL is the "controlled expiry" - the same code path, with the
    // waiting compressed so it is testable.
    const crashed = await runRacers(1, { mode: "crash_before_ack", leaseTtlMs: 300 });
    expect(crashed.codes).toEqual([9]);
    await new Promise((r) => setTimeout(r, 600));

    const { codes, results } = await runRacers(10, { mode: "single", holdMs: 100, leaseTtlMs: 300 });
    expect(codes.every((c) => c === 0)).toBe(true);
    expect(results.filter((r) => r.acquired)).toHaveLength(1);

    const effects = effectsByKind();
    expect(effects.ack).toHaveLength(1);
    expect(effects.report).toHaveLength(1);
    expect(anyOverlap(results)).toBe(false);
  }, 90_000);
});

/** ---------------------------------------------------------------- */
describe("PROOF 4 - crash after the ACK, before the terminal report", () => {
  it("resumes deterministically as exactly one owner, and does not duplicate the ACK", async () => {
    const crashed = await runRacers(1, { mode: "crash_after_ack", leaseTtlMs: 300 });
    expect(crashed.codes).toEqual([9]);
    expect(crashed.results[0].effects_written).toEqual(["ack"]);

    // The ACK happened. The task is NOT terminal, so the lease must eventually be
    // resumable - but not while it is unexpired.
    const blocked = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, nowMs: Date.now() - 1000 });
    expect(blocked.acquired).toBe(false);
    expect(CONTENDED_VERDICTS).toContain(blocked.verdict);

    await new Promise((r) => setTimeout(r, 600));

    const { results } = await runRacers(6, { mode: "single", holdMs: 80, leaseTtlMs: 300 });
    expect(results.filter((r) => r.acquired)).toHaveLength(1);

    const effects = effectsByKind();
    // Exactly ONE resumption: two acks in total (the crashed attempt and the one
    // resumer), never three. Six contenders produced one.
    expect(effects.ack).toHaveLength(2);
    expect(effects.worktree).toHaveLength(1);
    expect(effects.report).toHaveLength(1);
  }, 90_000);

  it("parks fail-closed rather than resuming when the lease cannot be resolved", () => {
    const first = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID });
    expect(first.acquired).toBe(true);
    // Simulate a hole in the ancestry: a higher version with nothing below it.
    const ledgerDir = taskLedgerDir(admissionRoot, TASK_ID);
    writeFileSync(join(ledgerDir, "000000000004.lease"), JSON.stringify({
      admission_schema_version: 1, version: 4, state: LEASE_STATE.VOID, task_id: TASK_ID,
      owner_token: "t", host: hostname(), pid: 1
    }), "utf8");

    const res = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID });
    expect(res.acquired).toBe(false);
    expect(res.verdict).toBe(ADMISSION.UNRESOLVED);
  });
});

/** ---------------------------------------------------------------- */
describe("PROOF 5 - reboot durability and terminal task-id dedupe", () => {
  it("survives a reboot: the lease is on disk, the owner is gone, and one successor CASes in", () => {
    const owner = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, leaseTtlMs: 60_000 });
    expect(owner.acquired).toBe(true);
    const leaseFile = join(taskLedgerDir(admissionRoot, TASK_ID), "000000000001.lease");
    const onDisk = JSON.parse(readFileSync(leaseFile, "utf8"));

    // A reboot is exactly this: the file is still there, and the pid it names is
    // now either absent or answers as a DIFFERENT process. Both are proved here
    // by injection, because a real reboot cannot be performed in a test - and the
    // expiry is long past, because it was written before the machine went down.
    const afterReboot = onDisk.lease_expires_at_ms + 60_000;

    const reusedPid = acquireTaskAdmission({
      admissionRoot, taskId: TASK_ID, nowMs: afterReboot,
      alive: () => true, startTime: () => "a-completely-different-process-start-time"
    });
    expect(reusedPid.acquired).toBe(true);
    expect(reusedPid.handle.version).toBe(2);

    // And the same for a pid that simply does not exist any more.
    releaseTaskAdmission(reusedPid.handle);
    const gone = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, alive: () => false });
    expect(gone.acquired).toBe(true);
    expect(gone.handle.version).toBe(3);
  });

  it("a reused pid whose identity cannot be read is UNPROVEN, never reclaimed", () => {
    const owner = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, leaseTtlMs: 1 });
    expect(owner.acquired).toBe(true);
    const res = acquireTaskAdmission({
      admissionRoot, taskId: TASK_ID, nowMs: Date.now() + 60_000,
      alive: () => true, startTime: () => null
    });
    expect(res.acquired).toBe(false);
    expect(res.verdict).toBe(ADMISSION.HELD_UNPROVEN_IDENTITY);
  });

  it("a lease held by another HOST is never reclaimed, whatever its clock says (D-143)", () => {
    const owner = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, leaseTtlMs: 1 });
    const file = join(taskLedgerDir(admissionRoot, TASK_ID), "000000000001.lease");
    const lease = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...lease, host: "some-other-machine", lease_expires_at_ms: 0 }), "utf8");
    expect(owner.acquired).toBe(true);

    const res = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, nowMs: Date.now() + 10 * 365 * 24 * 3600_000 });
    expect(res.acquired).toBe(false);
    expect(res.verdict).toBe(ADMISSION.HELD_FOREIGN_HOST);
  });

  it("a TERMINAL task id is refused forever, by every worker, after a reboot, with the evidence intact", async () => {
    const { codes, results } = await runRacers(1, { mode: "terminal", holdMs: 30 });
    expect(codes).toEqual([0]);
    expect(results[0].terminalized).toBe(true);

    // Every later attempt - a fresh process's worth of state, an expired clock, a
    // dead owner, an injected reboot - is refused on the SAME ground.
    for (const opts of [
      {},
      { nowMs: Date.now() + 10 * 365 * 24 * 3600_000 },
      { alive: () => false },
      { alive: () => true, startTime: () => "different" }
    ]) {
      const res = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, ...opts });
      expect(res.acquired).toBe(false);
      expect(res.verdict).toBe(ADMISSION.TERMINAL);
    }

    // A second wave of ten real processes produces NOTHING.
    const before = readdirSync(effectsDir).length;
    const wave = await runRacers(10, { mode: "single", holdMs: 50 });
    expect(wave.results.filter((r) => r.acquired)).toHaveLength(0);
    expect(wave.results.every((r) => r.verdict === ADMISSION.TERMINAL)).toBe(true);
    expect(readdirSync(effectsDir).length).toBe(before);

    // The evidence that closed it survives, and is readable without mutating.
    const seen = inspectTaskAdmission({ admissionRoot, taskId: TASK_ID });
    expect(seen.verdict).toBe(ADMISSION.TERMINAL);
    expect(seen.lease.terminal_report_comment_id).toBe(4242);
    expect(seen.lease.terminal_status).toBe("PASS");
  }, 90_000);

  it("inspect is strictly read-only: it creates no ledger for a task it has never seen", () => {
    const unseen = inspectTaskAdmission({ admissionRoot, taskId: "D166-NEVER-SEEN-20260917-A" });
    expect(unseen.verdict).toBe(ADMISSION.FREE);
    expect(existsSync(taskLedgerDir(admissionRoot, "D166-NEVER-SEEN-20260917-A"))).toBe(false);
  });
});

/** ---------------------------------------------------------------- */
describe("lease lifecycle is token-bound", () => {
  it("only the token holder can heartbeat, release or terminalize", () => {
    const owner = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID });
    expect(owner.acquired).toBe(true);
    const forged = { ...owner.handle, token: "not-the-token" };

    expect(holdsTaskAdmission(forged)).toBe(false);
    expect(heartbeatTaskAdmission(forged)).toBe(false);
    expect(releaseTaskAdmission(forged)).toBe(false);
    expect(terminalizeTaskAdmission(forged, { outcome: "completed" })).toBe(false);

    // The real holder is untouched by all of that.
    expect(holdsTaskAdmission(owner.handle)).toBe(true);
    expect(scanTaskLedger(owner.handle.dir).lease.info.state).toBe(LEASE_STATE.HELD);
  });

  it("a heartbeat extends the expiry without changing the owner", () => {
    const owner = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, nowMs: 1_000_000, leaseTtlMs: 60_000 });
    const before = scanTaskLedger(owner.handle.dir).lease.info;
    expect(heartbeatTaskAdmission(owner.handle, { phase: "dispatch", nowMs: 1_030_000 })).toBe(true);
    const after = scanTaskLedger(owner.handle.dir).lease.info;
    expect(after.lease_expires_at_ms).toBe(1_090_000);
    expect(after.lease_expires_at_ms).toBeGreaterThan(before.lease_expires_at_ms);
    expect(after.owner_token).toBe(before.owner_token);
    expect(after.phase).toBe("dispatch");
    expect(after.version).toBe(before.version);
  });

  it("a released lease frees the id immediately, with no expiry required", () => {
    const first = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, leaseTtlMs: 60 * 60_000 });
    expect(releaseTaskAdmission(first.handle, { reason: "cycle_finished" })).toBe(true);
    const second = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID });
    expect(second.acquired).toBe(true);
    expect(second.handle.version).toBe(2);
  });
});

/** ---------------------------------------------------------------- */
describe("unreadable and malformed leases fail closed", () => {
  it("never supersedes a lease it could not read", () => {
    acquireTaskAdmission({ admissionRoot, taskId: TASK_ID });
    const ledgerDir = taskLedgerDir(admissionRoot, TASK_ID);
    writeFileSync(join(ledgerDir, "000000000001.lease"), "{ this is not json", "utf8");

    const fresh = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, nowMs: Date.now() });
    expect(fresh.acquired).toBe(false);
    expect(fresh.verdict).toBe(ADMISSION.PUBLISHING);
  });

  it("a semantically empty object is judged by the SAME grace rule, not superseded on sight", () => {
    const ledgerDir = taskLedgerDir(admissionRoot, TASK_ID);
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, "000000000001.lease"), JSON.stringify({ state: "held" }), "utf8");

    const fresh = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, nowMs: Date.now() });
    expect(fresh.acquired).toBe(false);
    expect(fresh.verdict).toBe(ADMISSION.PUBLISHING);

    // Past the grace window it may be superseded - but the file is still there.
    const later = acquireTaskAdmission({ admissionRoot, taskId: TASK_ID, nowMs: Date.now() + 5 * 60_000 });
    expect(later.acquired).toBe(true);
    expect(later.handle.version).toBe(2);
    expect(existsSync(join(ledgerDir, "000000000001.lease"))).toBe(true);
  });

  it("validateLeaseSchema names every missing binding", () => {
    expect(validateLeaseSchema(null)).toEqual(["lease is not a JSON object"]);
    const problems = validateLeaseSchema({ state: LEASE_STATE.HELD });
    expect(problems.join("; ")).toMatch(/task_id/);
    expect(problems.join("; ")).toMatch(/host/);
    expect(problems.join("; ")).toMatch(/owner_token/);
    expect(problems.join("; ")).toMatch(/pid/);
    expect(problems.join("; ")).toMatch(/lease_expires_at_ms/);
  });

  it("classifyLease refuses a lease whose state it does not recognise", () => {
    const verdict = classifyLease(
      { task_id: TASK_ID, host: hostname(), state: "something_new", owner_token: "t", version: 1, pid: 1 },
      { nowMs: Date.now() }
    );
    expect(verdict.verdict).toBe("malformed");
  });
});

/** ---------------------------------------------------------------- */
describe("PROOF 6 - terminal status vocabulary", () => {
  it("PASS, SUCCESS and COMPLETED all terminalize as success", () => {
    for (const raw of ["PASS", "PASSED", "SUCCESS", "COMPLETED", "COMPLETE", "pass", "**PASS**", "PASS (all gates green)"]) {
      const v = classifyReportStatus(raw);
      expect(v.terminal, `${raw} should be terminal`).toBe(true);
      expect(v.successful, `${raw} should be successful`).toBe(true);
      expect(v.recognised).toBe(true);
      expect(v.outcome).toBe("COMPLETE");
    }
  });

  it("BLOCKED and FAILED stay terminal but UNSUCCESSFUL", () => {
    expect(classifyReportStatus("BLOCKED")).toMatchObject({ terminal: true, successful: false });
    expect(classifyReportStatus("FAILED")).toMatchObject({ terminal: true, successful: false });
  });

  it("IN_PROGRESS stays recognised and NON-terminal", () => {
    const v = classifyReportStatus("IN_PROGRESS");
    expect(v.terminal).toBe(false);
    expect(v.recognised).toBe(true);
  });

  it("an unknown spelling still blocks fail-closed - the fix is not a loosening", () => {
    for (const raw of ["PASSABLE", "MOSTLY_FINE", "PAS", "", "   "]) {
      const v = classifyReportStatus(raw);
      expect(v.terminal, `${raw} must not be terminal`).toBe(false);
      expect(v.recognised, `${raw} must not be recognised`).toBe(false);
    }
  });

  it("PASS is in the enumerated vocabulary, so the reported list is honest", () => {
    expect(Object.keys(TERMINAL_STATUS_ALIASES)).toContain("PASS");
  });
});

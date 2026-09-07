import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

import {
  classifyLock,
  acquireLock,
  heartbeat,
  releaseLock,
  readLock,
  readLockRaw,
  holdsLock,
  publishExclusive,
  scanLedger,
  ledgerDir,
  collectLedgerGarbage,
  heldGeneration,
  readProcessStartTime,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  MALFORMED_LOCK_GRACE_MS,
  LOCK_VERSION
} from "../lib/lock.mjs";

const RACER = fileURLToPath(new URL("./fixtures/lock-racer.mjs", import.meta.url));
const LOCK_MODULE = fileURLToPath(new URL("../lib/lock.mjs", import.meta.url));

let dir;
let lockFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-lock-"));
  lockFile = join(dir, ".worker.lock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-09-07T02:00:00.000Z");

function lockInfo(over = {}) {
  return {
    lock_version: LOCK_VERSION,
    generation: 1,
    state: "held",
    pid: 4242,
    host: hostname(),
    start_time: "2026-09-07T01:00:00.0000000Z",
    started_at: new Date(NOW - 60_000).toISOString(),
    heartbeat_at: new Date(NOW - 60_000).toISOString(),
    task_id: "T-1",
    phase: "dispatch",
    owner_token: "token-1",
    ...over
  };
}

/**
 * Like `lockInfo`, but with timestamps relative to the real clock so that
 * anything seeded onto disk is judged against `Date.now()`, not against the
 * frozen NOW used by the pure classification tests.
 */
function freshInfo(over = {}) {
  const now = Date.now();
  return lockInfo({
    started_at: new Date(now - 1000).toISOString(),
    heartbeat_at: new Date(now - 1000).toISOString(),
    ...over
  });
}

/** Write a claim straight into the ledger, the way a previous run would have left it. */
function seedClaim(generation, over = {}, { ageMs = 0 } = {}) {
  const d = ledgerDir(lockFile);
  mkdirSync(d, { recursive: true });
  const path = join(d, `${String(generation).padStart(12, "0")}.claim`);
  const raw = typeof over === "string"
    ? over
    : JSON.stringify(freshInfo({ generation, ...over }), null, 2);
  writeFileSync(path, raw, "utf8");
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(path, t, t);
  }
  return path;
}

function claimFiles() {
  const d = ledgerDir(lockFile);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((n) => /^\d{12}\.claim$/.test(n)).sort();
}

/** ---------------- classification (pure) ---------------- */

describe("classifyLock", () => {
  it("an alive owner with a matching start time is active", () => {
    const info = lockInfo();
    const verdict = classifyLock(info, { nowMs: NOW, alive: () => true, startTime: () => info.start_time });
    expect(verdict.state).toBe("active");
  });

  it("a reused pid is stale, not active", () => {
    const info = lockInfo();
    const verdict = classifyLock(info, { nowMs: NOW, alive: () => true, startTime: () => "2026-09-07T01:59:00.0000000Z" });
    expect(verdict.state).toBe("stale_reused_pid");
  });

  it("a dead owner is stale_dead", () => {
    expect(classifyLock(lockInfo(), { nowMs: NOW, alive: () => false }).state).toBe("stale_dead");
  });

  it("an unreadable start time is unproven_identity, never a guess", () => {
    expect(classifyLock(lockInfo(), { nowMs: NOW, alive: () => true, startTime: () => null }).state)
      .toBe("unproven_identity");
  });

  it("a lock from another host is never touched", () => {
    expect(classifyLock(lockInfo({ host: "OTHER-MACHINE" }), { nowMs: NOW, alive: () => true }).state)
      .toBe("foreign_host");
  });

  it("a lock without a host binding is malformed", () => {
    expect(classifyLock(lockInfo({ host: undefined }), { nowMs: NOW, alive: () => true }).state).toBe("malformed");
  });

  it("an alive owner past the heartbeat budget is stale_no_heartbeat", () => {
    const info = lockInfo({ heartbeat_at: new Date(NOW - DEFAULT_HEARTBEAT_TIMEOUT_MS - 60_000).toISOString() });
    const verdict = classifyLock(info, { nowMs: NOW, alive: () => true, startTime: () => info.start_time });
    expect(verdict.state).toBe("stale_no_heartbeat");
  });

  it("an explicitly released claim is free, not owned", () => {
    expect(classifyLock(lockInfo({ state: "released" }), { nowMs: NOW, alive: () => true }).state).toBe("released");
  });
});

/** ---------------- the serialization primitive ---------------- */

describe("create-if-absent is the only mutation primitive", () => {
  it("publishExclusive writes complete content or nothing at all", () => {
    const target = join(dir, "x.claim");
    const payload = JSON.stringify(lockInfo(), null, 2);
    expect(publishExclusive(target, payload).ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(payload);

    const second = publishExclusive(target, JSON.stringify({ pid: 1 }));
    expect(second.ok).toBe(false);
    expect(second.code).toBe("EEXIST");
    expect(readFileSync(target, "utf8")).toBe(payload); // the loser changed nothing
  });

  it("publishExclusive leaves no staging files behind", () => {
    publishExclusive(join(dir, "y.claim"), "content");
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
  });

  it("acquiring appends a generation and never removes the one it superseded", () => {
    seedClaim(1, { pid: 999999, start_time: null }, { ageMs: 3600_000 });
    const res = acquireLock(lockFile, { nowMs: Date.now(), alive: () => false });
    expect(res.acquired).toBe(true);
    expect(res.generation).toBe(2);
    expect(claimFiles()).toEqual(["000000000001.claim", "000000000002.claim"]);
    expect(JSON.parse(readFileSync(join(ledgerDir(lockFile), "000000000001.claim"), "utf8")).pid).toBe(999999);
  });

  it("release marks our own claim released instead of unlinking it", () => {
    const res = acquireLock(lockFile);
    expect(releaseLock(lockFile, res.token)).toBe(true);
    expect(claimFiles()).toEqual(["000000000001.claim"]);
    expect(readLock(lockFile)).toBeNull();
    const next = acquireLock(lockFile);
    expect(next.generation).toBe(2); // generations never go backwards
    releaseLock(lockFile, next.token);
  });
});

/** ---------------- the confirmed source defect ---------------- */

describe("a stale reclaimer cannot displace a live owner (architect repro 5565113307)", () => {
  /**
   * The exact schedule the architect ran against v2:
   *   A classifies the current lock as stale and stalls at that point;
   *   B publishes a fresh lock and is genuinely live;
   *   A resumes and performs its mutation;
   *   C then tries to acquire.
   * On v2 this produced challengerStillHolds=true with B displaced. Here A's
   * mutation is a create-if-absent on a generation B already took, so A cannot
   * touch B at all.
   */
  /**
   * Realistic probes: only THIS process is alive, so the seeded dead pid is
   * genuinely dead while a claim taken by this test process is genuinely live.
   */
  const PROBE = { alive: (pid) => pid === process.pid, startTime: (pid) => readProcessStartTime(pid) };

  it("A stalls after classification, B takes over, A's resumed mutation fails and B keeps the lock", () => {
    seedClaim(1, { pid: 999999, start_time: null }, { ageMs: 3600_000 });

    let bToken = null;
    let bGeneration = null;

    // A: classify -> STALL (this is where v2 renamed the live lock away) -> mutate.
    const aResult = acquireLock(lockFile, {
      ...PROBE,
      hooks: {
        afterClassify: () => {
          if (bToken) return;
          const b = acquireLock(lockFile, { ...PROBE, phase: "replacement-owner" });
          bToken = b.token;
          bGeneration = b.generation;
        }
      }
    });

    // B is the live owner and was never moved, emptied or overwritten.
    expect(bGeneration).toBe(2);
    expect(holdsLock(lockFile, bToken)).toBe(true);
    expect(readLock(lockFile).owner_token).toBe(bToken);

    // A lost. It either hit EEXIST on generation 2 or retracted its own claim.
    expect(aResult.acquired).toBe(false);
    expect(["lost_acquisition_race", "superseded", "active"]).toContain(aResult.verdict.state);

    // C: the challenger that used to win in v2's displacement window.
    const c = acquireLock(lockFile, PROBE);
    expect(c.acquired).toBe(false);
    expect(holdsLock(lockFile, bToken)).toBe(true);
  });

  it("a DELAYED reclaimer that wakes after B released and C acquired retracts only its own claim", () => {
    seedClaim(1, { pid: 999999, start_time: null }, { ageMs: 3600_000 });

    let cToken = null;
    const stale = acquireLock(lockFile, {
      ...PROBE,
      hooks: {
        afterClassify: () => {
          if (cToken) return;
          // B takes over and releases; C then acquires and is still holding.
          const b = acquireLock(lockFile, PROBE);
          releaseLock(lockFile, b.token);
          const c = acquireLock(lockFile, PROBE);
          cToken = c.token;
        }
      }
    });

    expect(stale.acquired).toBe(false);
    expect(holdsLock(lockFile, cToken)).toBe(true);
    expect(readLock(lockFile).owner_token).toBe(cToken);
    // Nothing the stale process wrote is the current claim.
    expect(readLock(lockFile).state).toBe("held");
  });

  it("no state where the lock momentarily looks free: every generation file survives", () => {
    seedClaim(1, { pid: 999999, start_time: null }, { ageMs: 3600_000 });
    const seen = [];
    acquireLock(lockFile, {
      alive: () => false,
      hooks: { afterClassify: () => { seen.push(claimFiles().length); } }
    });
    // The incumbent claim is still on disk at the moment of mutation.
    expect(seen[0]).toBe(1);
    expect(claimFiles()).toEqual(["000000000001.claim", "000000000002.claim"]);
  });
});

/** ---------------- retracted claims must not mask a live predecessor ---------------- */

describe("a retracted claim cannot mask a live predecessor (architect repro 5567261855)", () => {
  const PROBE = { alive: (pid) => pid === process.pid, startTime: (pid) => readProcessStartTime(pid) };

  /**
   * The architect's exact three-party sequence, driven deterministically by the
   * scheduling hook - no sleeps, no timing luck:
   *   1. generation 1 is acquired normally by a process that stays live;
   *   2. a second acquirer is fed `alive = () => false`, so it misclassifies
   *      generation 1 as dead and publishes generation 2;
   *   3. `afterClassify` flips that probe back to the truth, so post-publication
   *      confirmation correctly rejects and retracts generation 2;
   *   4. a third acquirer runs with honest probes.
   *
   * On f839668 step 4 succeeded, because the retracted generation 2 was written
   * as an ordinary `released` claim and the live generation 1 underneath it was
   * never looked at again.
   */
  function runThreePartySequence() {
    const first = acquireLock(lockFile, { ...PROBE, phase: "live-owner" });

    let probeLies = true;
    const second = acquireLock(lockFile, {
      alive: (pid) => (probeLies ? false : pid === process.pid),
      startTime: (pid) => readProcessStartTime(pid),
      phase: "stale-reclaimer",
      hooks: { afterClassify: () => { probeLies = false; } }
    });

    const third = acquireLock(lockFile, { ...PROBE, phase: "challenger" });
    return { first, second, third };
  }

  /**
   * Re-read the ledger the way a restart would: a brand new Node process with no
   * in-memory state, importing the module fresh from disk.
   */
  function readLedgerInFreshProcess() {
    const source = `
      const { pathToFileURL } = require("node:url");
      import(pathToFileURL(process.argv[1]).href).then((lock) => {
        const ledger = lock.scanLedger(process.argv[2]);
        const claim = ledger.claim && !ledger.claim.malformed ? ledger.claim : null;
        const res = lock.acquireLock(process.argv[2], { collectGarbage: false });
        process.stdout.write(JSON.stringify({
          maxGeneration: ledger.maxGeneration,
          effectiveGeneration: claim ? claim.generation : null,
          voidGenerations: ledger.voidGenerations,
          ownerToken: claim ? claim.info.owner_token : null,
          acquired: res.acquired === true,
          verdict: res.verdict ?? null
        }));
      });
    `;
    const out = execFileSync(process.execPath, ["-e", source, LOCK_MODULE, lockFile], { encoding: "utf8" });
    return JSON.parse(out);
  }

  it("the live generation-1 owner survives a retracted generation 2 and generation 3 is refused", () => {
    const { first, second, third } = runThreePartySequence();

    expect(first.acquired).toBe(true);
    expect(first.generation).toBe(1);

    // The speculative generation 2 published, then confirmation caught the truth.
    expect(second.acquired).toBe(false);
    expect(second.verdict.state).toBe("active");
    expect(second.verdict.reason).toContain("generation 1 is live after all");

    // The forbidden outcome: a challenger entering while a live worker is inside.
    expect(third.acquired).toBe(false);
    expect(third.verdict.state).toBe("active");

    // The original owner is still effective, not merely still running.
    expect(holdsLock(lockFile, first.token)).toBe(true);
    expect(heldGeneration(lockFile, first.token)).toBe(1);
    expect(readLock(lockFile).owner_token).toBe(first.token);

    // Append-only is intact: nothing was moved, emptied or deleted, and the
    // retracted claim is recorded as void rather than as a voluntary release.
    expect(claimFiles()).toEqual(["000000000001.claim", "000000000002.claim"]);
    const retracted = JSON.parse(readFileSync(join(ledgerDir(lockFile), "000000000002.claim"), "utf8"));
    expect(retracted.state).toBe("void");
    expect(retracted.owner_token).not.toBe(first.token);

    // The ledger resolves to the effective claim, not to the raw maximum.
    const ledger = scanLedger(lockFile);
    expect(ledger.maxGeneration).toBe(2);
    expect(ledger.claim.generation).toBe(1);
    expect(ledger.voidGenerations).toEqual([2]);

    expect(releaseLock(lockFile, first.token)).toBe(true);
  });

  it("the surviving owner can still heartbeat and release across the retracted claim", () => {
    const { first } = runThreePartySequence();

    expect(heartbeat(lockFile, { token: first.token, phase: "still-working" })).toBe(true);
    expect(readLock(lockFile).phase).toBe("still-working");

    expect(releaseLock(lockFile, first.token)).toBe(true);
    expect(holdsLock(lockFile, first.token)).toBe(false);

    // Liveness: once the real owner is gone the void claim must not deadlock the
    // lock either. The next acquirer appends ABOVE the raw maximum.
    const next = acquireLock(lockFile, PROBE);
    expect(next.acquired).toBe(true);
    expect(next.generation).toBe(3);
    releaseLock(lockFile, next.token);
  });

  it("a restarted process re-reading the ledger from disk reaches the same verdict", () => {
    const { first } = runThreePartySequence();

    const fromDisk = readLedgerInFreshProcess();
    expect(fromDisk.maxGeneration).toBe(2);
    expect(fromDisk.effectiveGeneration).toBe(1);
    expect(fromDisk.voidGenerations).toEqual([2]);
    expect(fromDisk.ownerToken).toBe(first.token);

    // A genuinely separate process, using real probes against this test process,
    // must refuse - and must not append a claim while refusing.
    expect(fromDisk.acquired).toBe(false);
    expect(["active", "unproven_identity"]).toContain(fromDisk.verdict.state);
    expect(claimFiles()).toEqual(["000000000001.claim", "000000000002.claim"]);

    expect(holdsLock(lockFile, first.token)).toBe(true);
    releaseLock(lockFile, first.token);
  });

  it("a claim retracted by an older build (released + release_reason) is read as void", () => {
    seedClaim(1, { pid: process.pid, owner_token: "live-owner", start_time: readProcessStartTime(process.pid) });
    seedClaim(2, { pid: 999999, state: "released", release_reason: "retracted", owner_token: "failed-challenger" });

    expect(readLock(lockFile).owner_token).toBe("live-owner");
    expect(scanLedger(lockFile).claim.generation).toBe(1);

    const res = acquireLock(lockFile, PROBE);
    expect(res.acquired).toBe(false);
    expect(res.verdict.state).toBe("active");
  });

  it("a void claim over an unresolvable ancestry fails closed instead of looking free", () => {
    seedClaim(1, { pid: process.pid, owner_token: "live-owner", start_time: readProcessStartTime(process.pid) });
    // Generation 2 is absent, so nothing proves what generation 3 was hiding.
    seedClaim(3, { pid: 999999, state: "void", owner_token: "failed-challenger" });

    const ledger = scanLedger(lockFile);
    expect(ledger.claim).toBeNull();
    expect(ledger.vanished).toBe(true);
    expect(ledger.unresolvedGeneration).toBe(2);
    expect(readLockRaw(lockFile).read_error).toContain("ancestry");

    const res = acquireLock(lockFile, PROBE);
    expect(res.acquired).toBe(false);
    expect(claimFiles()).toEqual(["000000000001.claim", "000000000003.claim"]);
  });

  it("a genuine voluntary release still frees the lock", () => {
    const first = acquireLock(lockFile, PROBE);
    expect(releaseLock(lockFile, first.token)).toBe(true);
    expect(scanLedger(lockFile).claim.generation).toBe(1);
    expect(readLock(lockFile)).toBeNull();

    const second = acquireLock(lockFile, PROBE);
    expect(second.acquired).toBe(true);
    expect(second.generation).toBe(2);
    releaseLock(lockFile, second.token);
  });
});

/** ---------------- never-supersede rules ---------------- */

describe("claims that must never be superseded", () => {
  it("an active owner is refused, not reclaimed", () => {
    seedClaim(1, { pid: 4242 });
    const res = acquireLock(lockFile, { alive: () => true, startTime: () => lockInfo().start_time });
    expect(res.acquired).toBe(false);
    expect(res.verdict.state).toBe("active");
    expect(claimFiles()).toEqual(["000000000001.claim"]);
  });

  it("an owner with unprovable identity is refused, never guessed away", () => {
    seedClaim(1);
    const res = acquireLock(lockFile, { alive: () => true, startTime: () => null });
    expect(res.acquired).toBe(false);
    expect(res.verdict.state).toBe("unproven_identity");
  });

  it("a foreign-host claim is refused", () => {
    seedClaim(1, { host: "OTHER-MACHINE" });
    const res = acquireLock(lockFile, { alive: () => true });
    expect(res.acquired).toBe(false);
    expect(res.verdict.state).toBe("foreign_host");
  });

  it("an alive owner that stopped heartbeating is flagged, never taken", () => {
    seedClaim(1, { heartbeat_at: new Date(Date.now() - DEFAULT_HEARTBEAT_TIMEOUT_MS - 60_000).toISOString() });
    const res = acquireLock(lockFile, { alive: () => true, startTime: () => lockInfo().start_time });
    expect(res.acquired).toBe(false);
    expect(res.verdict.state).toBe("stale_no_heartbeat");
    expect(res.needs_attention).toBe(true);
  });

  it("a fresh unreadable claim is treated as mid-publication, not as garbage", () => {
    seedClaim(1, "");
    const res = acquireLock(lockFile);
    expect(res.acquired).toBe(false);
    expect(res.verdict.state).toBe("publishing");
    expect(readFileSync(join(ledgerDir(lockFile), "000000000001.claim"), "utf8")).toBe("");
  });

  it("an aged-out unreadable claim is superseded, never deleted, so it cannot deadlock", () => {
    seedClaim(1, '{"pid": 12', { ageMs: MALFORMED_LOCK_GRACE_MS + 60_000 });
    const res = acquireLock(lockFile);
    expect(res.acquired).toBe(true);
    expect(res.generation).toBe(2);
    expect(readFileSync(join(ledgerDir(lockFile), "000000000001.claim"), "utf8")).toBe('{"pid": 12');
  });

  it("a ledger that cannot be listed fails closed", () => {
    mkdirSync(ledgerDir(lockFile), { recursive: true });
    // A file where the ledger directory must be is an ENOTDIR on read.
    const bogus = join(dir, "bogus.lock");
    writeFileSync(`${bogus}.d`, "not a directory", "utf8");
    const res = acquireLock(bogus);
    expect(res.acquired).toBe(false);
    expect(res.verdict.state).toBe("filesystem_error");
  });
});

/** ---------------- legacy v1/v2 plain-file locks ---------------- */

describe("pre-v3 plain lock files", () => {
  it("a live legacy lock blocks acquisition and is never written to or removed", () => {
    const raw = JSON.stringify(freshInfo({ generation: undefined }), null, 2);
    writeFileSync(lockFile, raw, "utf8");
    const res = acquireLock(lockFile, { alive: () => true, startTime: () => lockInfo().start_time });
    expect(res.acquired).toBe(false);
    expect(res.verdict.state).toBe("active");
    expect(res.legacy).toBe(true);
    expect(readFileSync(lockFile, "utf8")).toBe(raw);
  });

  it("a dead legacy lock is ignored and still left untouched on disk", () => {
    const raw = JSON.stringify(freshInfo({ pid: 999999, generation: undefined }), null, 2);
    writeFileSync(lockFile, raw, "utf8");
    const res = acquireLock(lockFile, { alive: () => false });
    expect(res.acquired).toBe(true);
    expect(readFileSync(lockFile, "utf8")).toBe(raw); // never deleted by us
  });

  it("an empty legacy lock file is not stolen while it is fresh", () => {
    writeFileSync(lockFile, "", "utf8");
    const res = acquireLock(lockFile);
    expect(res.acquired).toBe(false);
    expect(res.verdict.state).toBe("publishing");
    expect(statSync(lockFile).size).toBe(0);
  });
});

/** ---------------- ownership is a token, not a pid ---------------- */

describe("ownership is a token, not a pid", () => {
  it("heartbeat and release require the exact token", () => {
    const res = acquireLock(lockFile);
    expect(holdsLock(lockFile, res.token)).toBe(true);
    expect(holdsLock(lockFile, "wrong-token")).toBe(false);
    expect(heartbeat(lockFile, { token: "wrong-token" })).toBe(false);
    expect(releaseLock(lockFile, "wrong-token")).toBe(false);
    expect(holdsLock(lockFile, res.token)).toBe(true);
    expect(releaseLock(lockFile, res.token)).toBe(true);
    expect(holdsLock(lockFile, res.token)).toBe(false);
  });

  it("heartbeat writes a complete document every time", () => {
    const res = acquireLock(lockFile);
    const path = join(ledgerDir(lockFile), "000000000001.claim");
    for (let i = 0; i < 30; i += 1) {
      expect(heartbeat(lockFile, { token: res.token, phase: `p${i}` })).toBe(true);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.phase).toBe(`p${i}`);
      expect(parsed.owner_token).toBe(res.token);
    }
    releaseLock(lockFile, res.token);
  });

  it("a heartbeat from a superseded holder cannot overwrite the current owner", () => {
    const first = acquireLock(lockFile);
    // Simulate a replacement owner appearing at a higher generation.
    seedClaim(2, { pid: process.pid, owner_token: "replacement", start_time: readProcessStartTime(process.pid) });
    expect(heartbeat(lockFile, { token: first.token, phase: "should-not-apply" })).toBe(false);
    expect(readLock(lockFile).owner_token).toBe("replacement");
    expect(holdsLock(lockFile, first.token)).toBe(false);
    expect(releaseLock(lockFile, first.token)).toBe(false);
  });

  it("readLock reports malformed content without throwing", () => {
    seedClaim(1, "not json");
    expect(readLock(lockFile)).toEqual({ malformed: true });
    expect(readLockRaw(lockFile).raw).toBe("not json");
  });

  it("heldGeneration reports our generation only while we own it", () => {
    const res = acquireLock(lockFile);
    expect(heldGeneration(lockFile, res.token)).toBe(1);
    releaseLock(lockFile, res.token);
    expect(heldGeneration(lockFile, res.token)).toBeNull();
  });
});

/** ---------------- history / garbage collection ---------------- */

describe("ledger history", () => {
  it("garbage collection never removes the maximum claim and requires ownership", () => {
    for (let g = 1; g <= 30; g += 1) seedClaim(g, { pid: 999999, state: "released" });
    const res = acquireLock(lockFile, { alive: () => false, collectGarbage: false });
    expect(res.generation).toBe(31);

    expect(collectLedgerGarbage(lockFile, res.generation, "wrong-token").removed).toEqual([]);
    expect(claimFiles()).toHaveLength(31);

    const gc = collectLedgerGarbage(lockFile, res.generation, res.token, { keep: 5 });
    expect(gc.removed.length).toBeGreaterThan(0);
    const remaining = claimFiles();
    expect(remaining).toContain("000000000031.claim");
    expect(holdsLock(lockFile, res.token)).toBe(true);
    releaseLock(lockFile, res.token);
  });

  it("scanLedger reports an unreadable ledger as an error, never as empty", () => {
    const bogus = join(dir, "bogus2.lock");
    writeFileSync(`${bogus}.d`, "not a directory", "utf8");
    expect(scanLedger(bogus).error).toBeTruthy();
    expect(readLockRaw(bogus).malformed).toBe(true);
  });
});

/** ---------------- real multiprocess evidence ---------------- */

/**
 * Explicit four-phase harness: every child announces READY, the parent releases
 * them all with a single START file, and every child MUST return a result file
 * and exit 0. Nothing is filtered away, and mutual exclusion is judged from
 * critical-section INTERVALS, not from a count of `acquired`.
 */
function runRacers(count, { holdMs = 120, mode = "contend", deadlineMs = 25_000, tag = "r" } = {}) {
  const startFile = join(dir, `start-${tag}`);
  const children = [];
  const expected = [];
  for (let i = 0; i < count; i += 1) {
    const resultFile = join(dir, `result-${tag}-${i}.json`);
    const readyFile = join(dir, `ready-${tag}-${i}`);
    expected.push({ resultFile, readyFile, index: i });
    children.push(new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [RACER, lockFile, resultFile, readyFile, startFile, String(holdMs), mode, String(deadlineMs)],
        { stdio: "ignore" }
      );
      let stderr = null;
      child.on("error", (err) => { stderr = String(err.message); });
      child.on("close", (code) => resolve({ index: i, code, spawnError: stderr }));
    }));
  }

  return waitForAll(expected.map((e) => e.readyFile), deadlineMs)
    .then((ready) => {
      if (!ready) throw new Error("not every child reached READY before the deadline");
      writeFileSync(startFile, "go", "utf8");
      return Promise.all(children);
    })
    .then((exits) => {
      const outcomes = expected.map((e, i) => ({
        ...exits[i],
        resultFilePresent: existsSync(e.resultFile),
        result: existsSync(e.resultFile) ? JSON.parse(readFileSync(e.resultFile, "utf8")) : null
      }));
      return outcomes;
    });
}

function waitForAll(paths, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (paths.every((p) => existsSync(p))) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Every child accounted for: exit 0, result file present, protocol completed. */
function assertAllAccountedFor(outcomes, count) {
  expect(outcomes).toHaveLength(count);
  for (const o of outcomes) {
    expect(o.spawnError, `child ${o.index} failed to spawn`).toBeNull();
    expect(o.resultFilePresent, `child ${o.index} produced no result file`).toBe(true);
    expect(o.code, `child ${o.index} exited non-zero`).toBe(0);
    expect(o.result.threw, `child ${o.index} threw`).toBeNull();
    expect(o.result.protocol_complete, `child ${o.index} did not complete the protocol`).toBe(true);
  }
}

/** The actual mutual-exclusion evidence: no two critical sections overlap. */
function assertNoOverlap(outcomes) {
  const intervals = outcomes
    .filter((o) => o.result.acquired)
    .map((o) => ({ pid: o.result.pid, enter: o.result.enter_ms, exit: o.result.exit_ms }))
    .sort((a, b) => a.enter - b.enter);
  for (const iv of intervals) {
    expect(Number.isFinite(iv.enter) && Number.isFinite(iv.exit)).toBe(true);
    expect(iv.exit).toBeGreaterThanOrEqual(iv.enter);
  }
  for (let i = 1; i < intervals.length; i += 1) {
    const prev = intervals[i - 1];
    const cur = intervals[i];
    expect(
      cur.enter >= prev.exit,
      `critical sections overlapped: pid ${prev.pid} [${prev.enter},${prev.exit}] and pid ${cur.pid} [${cur.enter},${cur.exit}]`
    ).toBe(true);
  }
  return intervals;
}

describe("genuine multiprocess serialization", () => {
  it("eight simultaneous processes each get the lock, and no two critical sections overlap", async () => {
    const outcomes = await runRacers(8, { holdMs: 120, mode: "contend", tag: "contend" });
    assertAllAccountedFor(outcomes, 8);

    // Every child must eventually acquire: a serialized lock is also a LIVE one.
    for (const o of outcomes) {
      expect(o.result.acquired, `child ${o.index} never acquired`).toBe(true);
      expect(o.result.lost_ownership_during_hold, `child ${o.index} lost ownership mid-section`).toBe(false);
      expect(o.result.still_held_at_exit).toBe(true);
      expect(o.result.release_ok).toBe(true);
      expect(o.result.beats).toBeGreaterThan(0);
    }
    const intervals = assertNoOverlap(outcomes);
    expect(intervals).toHaveLength(8);
    expect(readLock(lockFile)).toBeNull(); // the last holder released
  }, 60_000);

  /**
   * Deliberately NOT "exactly one acquired". Eight children released from one
   * barrier are not guaranteed to attempt inside the first holder's critical
   * section - the OS may delay a child past the release, and acquiring then is
   * CORRECT, not a bug. Counting winners would therefore be a flaky assertion
   * about scheduling rather than a statement about mutual exclusion. What is
   * asserted instead: no two critical sections overlap, every refusal is a
   * genuine ownership refusal, and the run really was contended.
   */
  it("at a single collision point no two processes are ever inside the critical section", async () => {
    const outcomes = await runRacers(8, { holdMs: 250, mode: "single", tag: "single" });
    assertAllAccountedFor(outcomes, 8);

    const winners = outcomes.filter((o) => o.result.acquired);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    for (const w of winners) {
      expect(w.result.lost_ownership_during_hold).toBe(false);
      expect(w.result.still_held_at_exit).toBe(true);
      expect(w.result.release_ok).toBe(true);
    }
    for (const loser of outcomes.filter((o) => !o.result.acquired)) {
      expect(loser.result.attempts).toHaveLength(1);
      expect(["active", "lost_acquisition_race", "publishing", "superseded", "unproven_identity", "unreadable"])
        .toContain(loser.result.attempts[0].verdict);
    }

    assertNoOverlap(outcomes);

    // Prove the run was genuinely contended and not a vacuous pass: most
    // children must have been refused BECAUSE they observed another process's
    // claim, which is only possible if they attempted while it existed.
    const blockedByAnother = outcomes.filter((o) => !o.result.acquired
      && ["active", "unproven_identity", "lost_acquisition_race"].includes(o.result.attempts[0].verdict));
    expect(blockedByAnother.length, "no child was refused because of another process's claim")
      .toBeGreaterThanOrEqual(outcomes.length - winners.length - 1);
  }, 60_000);

  it("a live heartbeating owner is never displaced by six concurrent challengers", async () => {
    // Phase 1: establish a real owner in its OWN process and wait until it holds.
    const ownerResult = join(dir, "owner-result.json");
    const ownerReady = join(dir, "owner-ready");
    const ownerStart = join(dir, "owner-start");
    const ownerExit = new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [RACER, lockFile, ownerResult, ownerReady, ownerStart, "6000", "contend", "25000"],
        { stdio: "ignore" }
      );
      child.on("close", (code) => resolve(code));
    });
    expect(await waitForAll([ownerReady], 20_000)).toBe(true);
    writeFileSync(ownerStart, "go", "utf8");

    const ownerPid = await new Promise((resolve) => {
      const deadline = Date.now() + 20_000;
      const tick = () => {
        const cur = readLock(lockFile);
        if (cur && !cur.malformed && cur.state === "held") return resolve(cur.pid);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(tick, 10);
      };
      tick();
    });
    expect(ownerPid, "the owner process never established the lock").not.toBeNull();
    const ownerGeneration = scanLedger(lockFile).maxGeneration;

    // Phase 2: six challengers, one attempt each, while the owner is alive.
    const outcomes = await runRacers(6, { holdMs: 50, mode: "challenge", tag: "challenge" });
    assertAllAccountedFor(outcomes, 6);
    for (const o of outcomes) {
      expect(o.result.acquired, `challenger ${o.index} displaced a live owner`).toBe(false);
      expect(o.result.attempts).toHaveLength(1);
      // `unproven_identity` (this host refuses to report another process's start
      // time) and `unreadable` (a transient Windows sharing violation) are
      // fail-closed REFUSALS exactly like `active`. They are accepted here for
      // that reason - the load-bearing assertion is `acquired === false`.
      expect(["active", "unproven_identity", "unreadable"]).toContain(o.result.attempts[0].verdict);
    }

    // Phase 3: the owner is still the same claim, still held, still its own pid.
    const during = readLock(lockFile);
    expect(during.pid).toBe(ownerPid);
    expect(during.state).toBe("held");
    expect(scanLedger(lockFile).maxGeneration).toBe(ownerGeneration);

    expect(await ownerExit).toBe(0);
    const owner = JSON.parse(readFileSync(ownerResult, "utf8"));
    expect(owner.acquired).toBe(true);
    expect(owner.lost_ownership_during_hold).toBe(false);
    expect(owner.beats).toBeGreaterThan(0);
    expect(owner.release_ok).toBe(true);
  }, 90_000);

  it("a stale claim left by a dead process is superseded without any two racers overlapping", async () => {
    seedClaim(1, { pid: 999999, start_time: null }, { ageMs: 3600_000 });
    const outcomes = await runRacers(6, { holdMs: 200, mode: "single", tag: "stale" });
    assertAllAccountedFor(outcomes, 6);
    expect(outcomes.filter((o) => o.result.acquired).length).toBeGreaterThanOrEqual(1);
    assertNoOverlap(outcomes);
    // The dead claim is still on disk: superseded, never destroyed.
    expect(claimFiles()).toContain("000000000001.claim");
    // Every generation from 1 upwards is present: the ledger is append-only.
    const generations = claimFiles().map((n) => Number(n.slice(0, 12)));
    expect(generations).toEqual(generations.map((_, i) => i + 1));
  }, 60_000);
});

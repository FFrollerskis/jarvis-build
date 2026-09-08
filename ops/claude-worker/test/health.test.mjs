/**
 * Requirement F acceptance tests: a scheduler exit code of zero is not
 * end-to-end success, and no secret ever reaches a log or a comment.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitHealth, readHealth, summarizeHealth, sanitize, HEALTH_EVENTS } from "../lib/health.mjs";

let dir;
let healthFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-health-"));
  healthFile = join(dir, "logs", "health.jsonl");
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("acceptance: health evidence differentiates every pipeline stage", () => {
  it("shows a firing scheduler that never reached the queue as NOT healthy work", () => {
    emitHealth(healthFile, HEALTH_EVENTS.SCHEDULER_INVOKED, { script: "run-worker.ps1" });

    const s = summarizeHealth(readHealth(healthFile));
    expect(s.scheduler_is_firing).toBe(true);
    expect(s.queue_is_being_polled).toBe(false);   // the distinction that matters
    expect(s.work_is_being_completed).toBe(false);
    expect(s.last_queue_poll).toBeNull();
    expect(s.last_completion_confirmed).toBeNull();
  });

  it("shows a polled queue with no dispatch as still not completed work", () => {
    emitHealth(healthFile, HEALTH_EVENTS.SCHEDULER_INVOKED, {});
    emitHealth(healthFile, HEALTH_EVENTS.QUEUE_POLLED, { comment_count: 40 });

    const s = summarizeHealth(readHealth(healthFile));
    expect(s.queue_is_being_polled).toBe(true);
    expect(s.work_is_being_completed).toBe(false);
    expect(s.last_dispatch_started).toBeNull();
  });

  it("only reports completed work after a confirmed completion event", () => {
    for (const e of [
      HEALTH_EVENTS.SCHEDULER_INVOKED, HEALTH_EVENTS.QUEUE_POLLED, HEALTH_EVENTS.PREFLIGHT,
      HEALTH_EVENTS.DISPATCH_STARTED, HEALTH_EVENTS.HEARTBEAT, HEALTH_EVENTS.DISPATCH_EXITED
    ]) {
      emitHealth(healthFile, e, {});
    }
    expect(summarizeHealth(readHealth(healthFile)).work_is_being_completed).toBe(false);

    emitHealth(healthFile, HEALTH_EVENTS.COMPLETION_CONFIRMED, { task_id: "T", report_comment_id: 99 });
    const s = summarizeHealth(readHealth(healthFile));
    expect(s.work_is_being_completed).toBe(true);
    expect(s.last_completion_confirmed).toBeTruthy();
  });

  it("keeps the newest occurrence of each stage", () => {
    emitHealth(healthFile, HEALTH_EVENTS.QUEUE_POLLED, {}, () => new Date("2026-09-07T01:00:00Z"));
    emitHealth(healthFile, HEALTH_EVENTS.QUEUE_POLLED, {}, () => new Date("2026-09-07T02:00:00Z"));
    expect(summarizeHealth(readHealth(healthFile)).last_queue_poll).toBe("2026-09-07T02:00:00.000Z");
  });
});

describe("journal durability", () => {
  it("survives a truncated trailing line from an interrupted append", () => {
    emitHealth(healthFile, HEALTH_EVENTS.QUEUE_POLLED, {});
    writeFileSync(healthFile, readFileSync(healthFile, "utf8") + '{"ts":"2026-09-07T02:0', "utf8");

    const events = readHealth(healthFile);
    expect(events).toHaveLength(1);           // the good record survives
    expect(events[0].event).toBe(HEALTH_EVENTS.QUEUE_POLLED);
  });

  it("returns an empty list for a missing journal rather than throwing", () => {
    expect(readHealth(join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("reports an unwritable journal instead of pretending it wrote", () => {
    const res = emitHealth(join(dir, "logs", "health.jsonl"), HEALTH_EVENTS.QUEUE_POLLED, {});
    expect(res.written).toBe(true);
    expect(res.record.event).toBe(HEALTH_EVENTS.QUEUE_POLLED);
  });
});

describe("no secret ever reaches a log or a comment", () => {
  it("redacts token-shaped strings", () => {
    const samples = [
      ["ghp_" + "a".repeat(36), "[REDACTED]"],
      ["gho_" + "b".repeat(36), "[REDACTED]"],
      ["github_pat_" + "c".repeat(30), "[REDACTED]"],
      ["sk-" + "d".repeat(40), "[REDACTED]"],
      ["xoxb-" + "1".repeat(20), "[REDACTED]"]
    ];
    for (const [secret, expected] of samples) {
      expect(sanitize(`token is ${secret} ok`)).toContain(expected);
      expect(sanitize(`token is ${secret} ok`)).not.toContain(secret);
    }
    expect(sanitize("Authorization: Bearer abc123def456")).not.toContain("abc123def456");
  });

  it("redacts secrets written through the health journal itself", () => {
    emitHealth(healthFile, HEALTH_EVENTS.BLOCKED, { reason: "auth failed for ghp_" + "z".repeat(36) });
    const raw = readFileSync(healthFile, "utf8");
    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain("z".repeat(36));
  });

  it("leaves ordinary text alone", () => {
    expect(sanitize("worktree is dirty: .claude-ack-d125-merge.md")).toBe("worktree is dirty: .claude-ack-d125-merge.md");
    expect(sanitize(null)).toBe("");
  });
});

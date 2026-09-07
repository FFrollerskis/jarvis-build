/**
 * Health-event journal and secret sanitisation.
 *
 * Requirement F: a scheduler exit code of zero is NOT end-to-end success.
 * Every stage of the pipeline emits a distinct, machine-readable event so
 * "the scheduled task ran" can never be confused with "the queue was polled",
 * "a task was dispatched", "the child was alive" or "a task actually completed".
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** Ordered pipeline stages. Each is strictly stronger evidence than the one before. */
export const HEALTH_EVENTS = Object.freeze({
  SCHEDULER_INVOKED: "scheduler_invoked",
  WORKER_STARTED: "worker_started",
  QUEUE_POLLED: "queue_polled",
  PREFLIGHT: "preflight",
  QUARANTINE: "quarantine",
  DISPATCH_STARTED: "dispatch_started",
  HEARTBEAT: "heartbeat",
  DISPATCH_EXITED: "dispatch_exited",
  COMPLETION_CONFIRMED: "completion_confirmed",
  BLOCKED: "blocked",
  SUPERVISOR_POLLED: "supervisor_polled",
  SUPERVISOR_ACTION: "supervisor_action"
});

const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // Must consume the REST OF THE LINE, not one token: `Authorization:\s*\S+`
  // matched only the scheme ("Bearer") and left the credential in the clear.
  /Authorization:\s*[^\r\n]+/gi,
  /Bearer\s+[^\s\r\n]+/gi
];

/** Redact anything token-shaped. Applied to every string that reaches a log or a comment. */
export function sanitize(text) {
  let out = String(text ?? "");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

/**
 * Append one health event as JSONL. Never throws: an unwritable log must not
 * take down a worker run, but it also must not be silently reported as healthy,
 * so the failure is surfaced through the return value.
 */
export function emitHealth(healthFile, event, fields = {}, now = () => new Date()) {
  const record = { ts: now().toISOString(), event, ...fields };
  const line = sanitize(JSON.stringify(record));
  try {
    mkdirSync(dirname(healthFile), { recursive: true });
    appendFileSync(healthFile, line + "\n", "utf8");
    return { written: true, record };
  } catch (err) {
    return { written: false, record, error: sanitize(err.message) };
  }
}

/** Read the health journal, tolerating partially written trailing lines. */
export function readHealth(healthFile, limit = 500) {
  if (!existsSync(healthFile)) return [];
  let raw;
  try {
    raw = readFileSync(healthFile, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A crash mid-append can leave one truncated line; skip it rather than
      // discarding the whole journal.
    }
  }
  return out.slice(-limit);
}

/**
 * Collapse the journal into "what do we actually know", per stage.
 * Used by the `health` subcommand and by the supervisor to tell a healthy
 * idle queue apart from a worker that is invoked but never gets anywhere.
 */
export function summarizeHealth(events) {
  const latest = {};
  for (const e of events) {
    if (e && typeof e.event === "string") latest[e.event] = e;
  }
  const at = (name) => (latest[name] ? latest[name].ts : null);
  return {
    last_scheduler_invocation: at(HEALTH_EVENTS.SCHEDULER_INVOKED),
    last_queue_poll: at(HEALTH_EVENTS.QUEUE_POLLED),
    last_dispatch_started: at(HEALTH_EVENTS.DISPATCH_STARTED),
    last_heartbeat: at(HEALTH_EVENTS.HEARTBEAT),
    last_dispatch_exit: at(HEALTH_EVENTS.DISPATCH_EXITED),
    last_completion_confirmed: at(HEALTH_EVENTS.COMPLETION_CONFIRMED),
    last_blocked: at(HEALTH_EVENTS.BLOCKED),
    // Deliberately explicit: these are different questions with different answers.
    scheduler_is_firing: Boolean(at(HEALTH_EVENTS.SCHEDULER_INVOKED)),
    queue_is_being_polled: Boolean(at(HEALTH_EVENTS.QUEUE_POLLED)),
    work_is_being_completed: Boolean(at(HEALTH_EVENTS.COMPLETION_CONFIRMED))
  };
}

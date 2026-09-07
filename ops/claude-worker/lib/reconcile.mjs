/**
 * Completion reconciliation and bounded backoff (requirements B and D).
 *
 * Core rule: exit code 0 is NOT completion. A task counts as done only when a
 * matching TRUSTED CLAUDE_REPORT exists for that exact TASK_ID, posted after the
 * dispatch started, carrying a terminal STATUS - i.e. task-specific evidence
 * that the work actually happened, not merely that a process exited.
 */

import { firstNonEmptyLine, extractField } from "./trust.mjs";

/** STATUS values that genuinely close a task. */
export const TERMINAL_REPORT_STATUSES = Object.freeze([
  "COMPLETED",
  "CLOSEOUT_COMPLETED",
  "MERGED",
  "DELIVERED",
  "BLOCKED",
  "FAILED"
]);

/** Statuses that close the task but must NOT be presented as success. */
export const UNSUCCESSFUL_REPORT_STATUSES = Object.freeze(["BLOCKED", "FAILED"]);

/**
 * Find a trusted CLAUDE_REPORT for `taskId`.
 *
 * `sinceIso` scopes the search to reports created at/after the dispatch, so an
 * old report for a re-issued id can never be mistaken for fresh evidence.
 */
export function findTrustedReport(comments, { taskId, trustedAuthor, sinceIso = null }) {
  const sinceMs = sinceIso ? Date.parse(sinceIso) : null;
  const matches = comments.filter((c) => {
    if (c?.user?.login !== trustedAuthor) return false;
    if (firstNonEmptyLine(c.body) !== "CLAUDE_REPORT") return false;
    if (extractField(c.body, "TASK_ID") !== taskId) return false;
    if (sinceMs !== null) {
      const created = Date.parse(c.created_at ?? "");
      // Allow a small skew: the report is posted by the dispatched child, whose
      // clock is the same machine, but the comparison should not be brittle.
      if (Number.isFinite(created) && created < sinceMs - 120_000) return false;
    }
    return true;
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""));
  return matches[0];
}

/**
 * Decide whether a dispatch actually completed.
 *
 * Returns `{ complete, successful, status, reportCommentId, reason }`.
 * `complete` false means the task stays retryable - regardless of exit code.
 */
export function assessCompletion({ taskId, comments, trustedAuthor, sinceIso = null }) {
  const report = findTrustedReport(comments, { taskId, trustedAuthor, sinceIso });
  if (!report) {
    return {
      complete: false,
      successful: false,
      status: null,
      reportCommentId: null,
      reason: "no_matching_trusted_report"
    };
  }
  const status = extractField(report.body, "STATUS");
  if (!status) {
    return {
      complete: false,
      successful: false,
      status: null,
      reportCommentId: report.id,
      reason: "report_has_no_status_field"
    };
  }
  if (!TERMINAL_REPORT_STATUSES.includes(status)) {
    // e.g. STATUS=IN_PROGRESS - real evidence of progress, but not completion.
    return {
      complete: false,
      successful: false,
      status,
      reportCommentId: report.id,
      reason: `report_status_not_terminal (${status})`
    };
  }
  return {
    complete: true,
    successful: !UNSUCCESSFUL_REPORT_STATUSES.includes(status),
    status,
    reportCommentId: report.id,
    reason: "matching_trusted_report_with_terminal_status"
  };
}

/**
 * Reconcile side effects that may already exist from a previous attempt, so a
 * retry RESUMES instead of duplicating commits, branches, PRs or merges.
 *
 * This is what makes "crash after report/PR/merge but before state save" safe:
 * the next run sees the report and/or the PR and closes the task out rather than
 * dispatching the same work a second time.
 */
export function reconcilePriorAttempt({ taskId, comments, trustedAuthor, branches = [], pulls = [], sinceIso = null }) {
  const completion = assessCompletion({ taskId, comments, trustedAuthor, sinceIso });
  const branch = branches.find((b) => typeof b === "string" && b.includes(slugForTask(taskId))) ?? null;
  const pr = pulls.find((p) => p && typeof p.headRefName === "string" && p.headRefName.includes(slugForTask(taskId))) ?? null;
  return {
    completion,
    existingBranch: branch,
    existingPr: pr ? { number: pr.number, state: pr.state, merged: Boolean(pr.merged || pr.mergedAt) } : null,
    // If a PR for this task is already merged, a retry must never merge again.
    alreadyMerged: Boolean(pr && (pr.merged || pr.mergedAt))
  };
}

/** Lowercased, punctuation-normalised task token used to match branches/PRs. */
export function slugForTask(taskId) {
  return String(taskId ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** ---------------- bounded backoff ---------------- */

export const DEFAULT_BACKOFF = Object.freeze({
  maxAttempts: 4,
  baseMs: 10 * 60_000,
  maxMs: 6 * 60 * 60_000
});

/**
 * Exponential backoff with a hard attempt ceiling.
 *
 * Deterministic (no jitter): a single-host worker has no thundering-herd problem,
 * and a deterministic next-eligible time is far easier to verify and to report.
 */
export function computeBackoff(attempts, cfg = DEFAULT_BACKOFF) {
  const { maxAttempts, baseMs, maxMs } = { ...DEFAULT_BACKOFF, ...cfg };
  if (attempts >= maxAttempts) {
    return { exhausted: true, delayMs: null, attemptsRemaining: 0 };
  }
  const delayMs = Math.min(baseMs * 2 ** Math.max(0, attempts - 1), maxMs);
  return { exhausted: false, delayMs, attemptsRemaining: maxAttempts - attempts };
}

/**
 * Deduplicated status reporting.
 *
 * The same blocking reason must not spam the control queue every five minutes,
 * but it must also never go silent - so an unchanged reason is re-posted once
 * per `repeatAfterMs` and any CHANGE in reason is posted immediately.
 */
export function shouldPostStatus(postedKeys, key, nowMs, repeatAfterMs = 6 * 60 * 60_000) {
  const last = postedKeys[key];
  if (!last) return { post: true, reason: "new_status_key" };
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return { post: true, reason: "unparseable_last_post" };
  if (nowMs - lastMs >= repeatAfterMs) return { post: true, reason: "repeat_window_elapsed" };
  return { post: false, reason: "already_reported_recently" };
}

export function statusKey({ taskId, phase, reason }) {
  return [taskId ?? "-", phase ?? "-", String(reason ?? "-").slice(0, 120)].join("|");
}

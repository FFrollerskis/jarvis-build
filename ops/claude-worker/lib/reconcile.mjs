/**
 * Completion reconciliation and bounded backoff (requirements B and D).
 *
 * Core rule: exit code 0 is NOT completion. A task counts as done only when a
 * matching TRUSTED CLAUDE_REPORT exists for that exact TASK_ID, posted after the
 * dispatch started, carrying a terminal STATUS - i.e. task-specific evidence
 * that the work actually happened, not merely that a process exited.
 *
 * D126 review blocker 6 (duplicate-effect reconciliation). The v2 matcher was
 *
 *     branches.find((b) => b.includes(slugForTask(taskId)))
 *
 * which assumes the whole TASK_ID slug appears in the branch name. It does not.
 * Reproduced by the architect on real data:
 *
 *     D125-UA7-TELEGRAM-INBOUND-OWNER-20260906T0627Z
 *     vs branch claude/d125-ua7-telegram-inbound-owner
 *     => existingBranch=null, existingPr=null, despite PR #74 existing.
 *
 * So a retry was told "nothing exists yet" and would have duplicated the branch,
 * the PR and possibly the merge. The fix is to stop guessing entirely:
 *
 *   1. EXACT recorded associations win. The worker persists `branch_after` and
 *      every branch/PR it has observed for a task; those are used first.
 *   2. Otherwise the association is read from the TRUSTED protocol comments for
 *      that exact TASK_ID (CLAUDE_ACK / CLAUDE_REPORT carry `BRANCH=` and
 *      `PR_NUMBER=`), or from a PR whose title/body contains the exact, full
 *      TASK_ID. All exact string equality - no normalisation, no fuzzy prefix.
 *   3. A FAILED lookup is never read as "nothing exists". `{ ok: false }` from
 *      GitHub propagates as `lookup_failed`, and the caller must treat duplicate
 *      risk as UNKNOWN rather than dispatching over the top of real work.
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

/** Protocol headers that may legitimately carry a branch/PR association. */
export const ASSOCIATION_HEADERS = Object.freeze(["CLAUDE_ACK", "CLAUDE_REPORT"]);

/** Branch names that are never a task's working branch. */
const NON_TASK_BRANCHES = Object.freeze(["main", "master", "HEAD", "", null, undefined]);

/**
 * Find a trusted CLAUDE_REPORT for `taskId`.
 *
 * `sinceIso` scopes the search to reports created at/after the dispatch, so an
 * old report for a re-issued id can never be mistaken for fresh evidence.
 */
export function findTrustedReport(comments, { taskId, trustedAuthor, sinceIso = null }) {
  const sinceMs = sinceIso ? Date.parse(sinceIso) : null;
  const matches = (comments ?? []).filter((c) => {
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

/** ---------------- exact task <-> effect association ---------------- */

function usableBranch(name) {
  return typeof name === "string" && name.length > 0 && !NON_TASK_BRANCHES.includes(name);
}

/**
 * Branch names and PR numbers this task is EXACTLY known to be associated with.
 *
 * Sources, in descending authority:
 *   - what the worker itself recorded while running the task,
 *   - what the trusted protocol comments for this exact TASK_ID state.
 * Nothing is inferred from the shape of the id.
 */
export function extractAssociations({ taskId, comments = [], trustedAuthor, priorTask = null }) {
  const branches = [];
  const prNumbers = [];
  const sources = [];

  const addBranch = (name, source) => {
    if (!usableBranch(name) || branches.includes(name)) return;
    branches.push(name);
    sources.push({ kind: "branch", value: name, source });
  };
  const addPr = (value, source) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0 || prNumbers.includes(n)) return;
    prNumbers.push(n);
    sources.push({ kind: "pr", value: n, source });
  };

  if (priorTask) {
    addBranch(priorTask.branch_after, "worker_state.branch_after");
    for (const b of priorTask.observed_branches ?? []) addBranch(b, "worker_state.observed_branches");
    for (const p of priorTask.observed_pr_numbers ?? []) addPr(p, "worker_state.observed_pr_numbers");
  }

  for (const c of comments) {
    if (c?.user?.login !== trustedAuthor) continue;
    if (!ASSOCIATION_HEADERS.includes(firstNonEmptyLine(c.body))) continue;
    if (extractField(c.body, "TASK_ID") !== taskId) continue;
    addBranch(extractField(c.body, "BRANCH"), `comment:${c.id}`);
    addPr(extractField(c.body, "PR_NUMBER"), `comment:${c.id}`);
  }

  return { branches, prNumbers, sources };
}

function normalisePull(pr) {
  if (!pr) return null;
  return {
    number: Number(pr.number),
    state: pr.state ?? null,
    headRefName: typeof pr.headRefName === "string" ? pr.headRefName : null,
    merged: Boolean(pr.merged || pr.mergedAt)
  };
}

/**
 * Reconcile side effects that may already exist from a previous attempt, so a
 * retry RESUMES instead of duplicating commits, branches, PRs or merges.
 *
 * `branchLookup` / `pullLookup` are the `{ ok, items, error }` results from
 * github.mjs. When either failed, `lookupFailed` is true and the caller MUST NOT
 * treat "nothing found" as proof that nothing exists.
 */
export function reconcilePriorAttempt({
  taskId,
  comments = [],
  trustedAuthor,
  priorTask = null,
  branchLookup = { ok: true, items: [] },
  pullLookup = { ok: true, items: [] },
  sinceIso = null
}) {
  const completion = assessCompletion({ taskId, comments, trustedAuthor, sinceIso });
  const assoc = extractAssociations({ taskId, comments, trustedAuthor, priorTask });

  const lookupFailures = [];
  if (!branchLookup.ok) lookupFailures.push(`branches: ${branchLookup.error ?? "unknown error"}`);
  if (!pullLookup.ok) lookupFailures.push(`pulls: ${pullLookup.error ?? "unknown error"}`);

  // --- branch ---
  let existingBranch = null;
  let branchVerified = false;
  if (branchLookup.ok) {
    existingBranch = assoc.branches.find((b) => branchLookup.items.includes(b)) ?? null;
    branchVerified = existingBranch !== null;
  }
  if (!existingBranch && assoc.branches.length > 0) {
    // We know the association but could not confirm it against the remote.
    existingBranch = assoc.branches[0];
    branchVerified = false;
  }

  // --- pull request ---
  const pulls = pullLookup.ok ? (pullLookup.items ?? []) : [];
  let matchedPull = null;
  if (assoc.prNumbers.length > 0) {
    matchedPull = pulls.find((p) => assoc.prNumbers.includes(Number(p?.number))) ?? null;
  }
  if (!matchedPull && assoc.branches.length > 0) {
    matchedPull = pulls.find((p) => assoc.branches.includes(p?.headRefName)) ?? null;
  }
  if (!matchedPull) {
    // Exact, full TASK_ID present in the PR title or body. Still an exact
    // string match - never a normalised prefix.
    matchedPull = pulls.find((p) =>
      (typeof p?.title === "string" && p.title.includes(taskId))
      || (typeof p?.body === "string" && p.body.includes(taskId))
    ) ?? null;
  }

  const existingPr = normalisePull(matchedPull);
  const prNumberKnownButUnverified = !existingPr && assoc.prNumbers.length > 0 ? assoc.prNumbers[0] : null;

  return {
    completion,
    existingBranch,
    branchVerified,
    existingPr,
    prNumberKnownButUnverified,
    alreadyMerged: Boolean(existingPr?.merged),
    associations: assoc,
    lookupFailed: lookupFailures.length > 0,
    lookupFailures,
    // True when we cannot rule out that side effects exist that we simply could
    // not see. The caller must NOT silently re-dispatch in that case.
    duplicateRiskUnknown: lookupFailures.length > 0
  };
}

/**
 * Merge freshly observed associations into a task record, without ever dropping
 * one we already knew about.
 */
export function mergeObservedAssociations(task, { branch = null, prNumber = null } = {}) {
  const branches = [...(task?.observed_branches ?? [])];
  const prNumbers = [...(task?.observed_pr_numbers ?? [])];
  if (usableBranch(branch) && !branches.includes(branch)) branches.push(branch);
  const n = Number(prNumber);
  if (Number.isInteger(n) && n > 0 && !prNumbers.includes(n)) prNumbers.push(n);
  return { observed_branches: branches, observed_pr_numbers: prNumbers };
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

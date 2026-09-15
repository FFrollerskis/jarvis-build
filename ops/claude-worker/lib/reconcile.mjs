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

/**
 * D132 ROOT CAUSE 1 - THE TERMINAL-STATUS VOCABULARY WAS NOT CANONICAL.
 *
 * The list below used to be a bare string array containing `COMPLETED`, and
 * `assessCompletion` compared `STATUS=` against it with `Array.includes`. Claude
 * writes `STATUS=COMPLETE`. Those are different strings, so a genuinely finished
 * task was classified `report_status_not_terminal (COMPLETE)` - real evidence of
 * completion, read correctly, and then thrown away over one letter.
 *
 * This is not hypothetical. It is recorded verbatim in the host's own state file
 * for two separate D-131 tasks:
 *
 *   D131-PR79-PROVEN-KEY-BINDING-20260911-A
 *     last_failure_reason: exit_0_without_matching_report
 *                          (report_status_not_terminal (COMPLETE))
 *     status: failed_retryable, attempts: 3
 *
 *   D131-PR79-MERGE-F12FF3B-20260911-B
 *     last_failure_reason: exit_0_without_matching_report
 *                          (report_status_not_terminal (COMPLETE))
 *     status: failed_retryable, head_after: c67a7ba (the merge it had ALREADY
 *     performed and correctly reported)
 *
 * A task that reports completion and is recorded as retryable is re-dispatched
 * until its attempt budget runs out - which is exactly the "old task re-runs
 * after the work is done" failure this module now has to make impossible.
 *
 * The repair is to stop doing exact-string equality against one spelling and to
 * classify the status CANONICALLY instead:
 *
 *   - normalise the raw value (case, whitespace, markdown/quoting noise that
 *     survives a copy-paste, hyphens vs underscores),
 *   - map every accepted spelling onto ONE canonical outcome,
 *   - and - decisively - distinguish "I recognise this and it is not terminal"
 *     (STATUS=IN_PROGRESS: retry is correct) from "I do not recognise this at
 *     all" (retrying forever is NOT correct; see `recognised` below).
 *
 * The existing test suite could never have caught this: `fixtures/fake-claude.mjs`
 * posted `STATUS=COMPLETED`, a spelling the real child does not use. The fixture
 * now defaults to the real one.
 */

/** Canonical terminal outcomes a report can carry. */
export const REPORT_OUTCOME = Object.freeze({
  COMPLETE: "COMPLETE",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED"
});

/**
 * Every accepted spelling -> canonical outcome.
 *
 * Keys are already normalised by `normalizeReportStatus`. Being generous here is
 * safe in a way that being strict is not: a spelling we fail to recognise costs a
 * duplicate dispatch of real work, while a spelling we recognise too eagerly is
 * still gated on a TRUSTED report for that EXACT TASK_ID - the trust boundary in
 * trust.mjs is untouched and does all the authority work.
 */
export const TERMINAL_STATUS_ALIASES = Object.freeze({
  COMPLETE: REPORT_OUTCOME.COMPLETE,
  COMPLETED: REPORT_OUTCOME.COMPLETE,
  CLOSEOUT_COMPLETE: REPORT_OUTCOME.COMPLETE,
  CLOSEOUT_COMPLETED: REPORT_OUTCOME.COMPLETE,
  DONE: REPORT_OUTCOME.COMPLETE,
  FINISHED: REPORT_OUTCOME.COMPLETE,
  SUCCESS: REPORT_OUTCOME.COMPLETE,
  SUCCEEDED: REPORT_OUTCOME.COMPLETE,
  SUCCESSFUL: REPORT_OUTCOME.COMPLETE,
  DELIVERED: REPORT_OUTCOME.COMPLETE,
  MERGED: REPORT_OUTCOME.COMPLETE,
  BLOCKED: REPORT_OUTCOME.BLOCKED,
  STOPPED: REPORT_OUTCOME.BLOCKED,
  HALTED: REPORT_OUTCOME.BLOCKED,
  FAILED: REPORT_OUTCOME.FAILED,
  FAILURE: REPORT_OUTCOME.FAILED,
  ERROR: REPORT_OUTCOME.FAILED,
  ABORTED: REPORT_OUTCOME.FAILED,
  CANCELLED: REPORT_OUTCOME.FAILED,
  CANCELED: REPORT_OUTCOME.FAILED
});

/**
 * Spellings that are RECOGNISED and deliberately NOT terminal.
 *
 * This set is what keeps the fix honest. Without it the only safe reading of an
 * unknown status would be "not terminal", which is precisely the behaviour that
 * produced the D-131 loop. With it, "not terminal" is a POSITIVE statement about
 * a status we understand, and anything outside both sets is an explicit
 * vocabulary mismatch the control plane must surface rather than silently retry.
 */
export const NON_TERMINAL_STATUSES = Object.freeze([
  "IN_PROGRESS",
  "PROGRESS",
  "STARTED",
  "RUNNING",
  "WORKING",
  "CONTINUING",
  "PARTIAL",
  "PENDING",
  "ACCEPTED",
  "ACK",
  "ACKNOWLEDGED",
  "RESUMED"
]);

/** Canonical outcomes that close the task but must NOT be presented as success. */
export const UNSUCCESSFUL_OUTCOMES = Object.freeze([REPORT_OUTCOME.BLOCKED, REPORT_OUTCOME.FAILED]);

/**
 * Strip the formatting noise a status value picks up in practice and fold it to
 * one comparable token.
 *
 * Handles: surrounding whitespace, markdown emphasis and code fencing
 * (`**COMPLETE**`, `` `COMPLETE` ``), quotes, a trailing comment or parenthetical
 * (`COMPLETE (all gates green)`), lowercase, and hyphen/space vs underscore.
 * Returns `null` for anything that normalises away to nothing.
 */
export function normalizeReportStatus(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  // A trailing parenthetical or comment is commentary ABOUT the status, not part
  // of it: `STATUS=COMPLETE (CI green)` means COMPLETE.
  s = s.replace(/\s*[(#].*$/, "");
  // Markdown emphasis, code fencing and quoting.
  s = s.replace(/^[\s*_`'"[\]]+/, "").replace(/[\s*_`'"[\]]+$/, "");
  // Trailing sentence punctuation.
  s = s.replace(/[.,;:]+$/, "");
  s = s.trim().toUpperCase();
  // Internal separators: COMPLETE, "closeout complete" and CLOSEOUT-COMPLETE are
  // the same token.
  s = s.replace(/[\s-]+/g, "_");
  return s.length > 0 ? s : null;
}

/**
 * Classify a raw `STATUS=` value.
 *
 * Returns `{ raw, canonical, outcome, terminal, successful, recognised }`.
 *
 *   recognised=false  the vocabulary does not contain this spelling AT ALL. The
 *                     caller must NOT treat that as ordinary progress and must
 *                     NOT retry on it indefinitely - that is the D-131 loop. It
 *                     is a control-plane defect and has to become visible.
 */
export function classifyReportStatus(raw) {
  const canonical = normalizeReportStatus(raw);
  if (canonical === null) {
    return { raw: raw ?? null, canonical: null, outcome: null, terminal: false, successful: false, recognised: false };
  }
  const outcome = TERMINAL_STATUS_ALIASES[canonical] ?? null;
  if (outcome) {
    return {
      raw,
      canonical,
      outcome,
      terminal: true,
      successful: !UNSUCCESSFUL_OUTCOMES.includes(outcome),
      recognised: true
    };
  }
  if (NON_TERMINAL_STATUSES.includes(canonical)) {
    return { raw, canonical, outcome: null, terminal: false, successful: false, recognised: true };
  }
  return { raw, canonical, outcome: null, terminal: false, successful: false, recognised: false };
}

/**
 * Every spelling that closes a task. Kept as a derived export because callers and
 * tests enumerate it; it is no longer the thing the comparison is done against.
 */
export const TERMINAL_REPORT_STATUSES = Object.freeze(Object.keys(TERMINAL_STATUS_ALIASES));

/** Statuses that close the task but must NOT be presented as success. */
export const UNSUCCESSFUL_REPORT_STATUSES = Object.freeze(
  Object.keys(TERMINAL_STATUS_ALIASES).filter((k) => UNSUCCESSFUL_OUTCOMES.includes(TERMINAL_STATUS_ALIASES[k]))
);

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
 * Returns `{ complete, successful, status, reportCommentId, reportBody, reason }`.
 * `complete` false means the task stays retryable - regardless of exit code.
 *
 * D-146: `reportBody` is the EXACT body of the comment `reportCommentId` names,
 * and the two always travel together. Callers that need to bind closeout evidence
 * (`verifyCloseoutReport`) must never re-select a report themselves: re-selection
 * is the seam through which one task's verdict could be paired with another
 * task's text, or with a stale report for a re-issued id that `sinceIso` had
 * already excluded here. Selection happens once, in this function, and what comes
 * out is one verdict bound to one identified body.
 */
export function assessCompletion({ taskId, comments, trustedAuthor, sinceIso = null }) {
  const report = findTrustedReport(comments, { taskId, trustedAuthor, sinceIso });
  if (!report) {
    return {
      complete: false,
      successful: false,
      status: null,
      reportCommentId: null,
      reportBody: null,
      reason: "no_matching_trusted_report"
    };
  }
  const reportBody = typeof report.body === "string" ? report.body : null;
  const status = extractField(report.body, "STATUS");
  if (!status) {
    return {
      complete: false,
      successful: false,
      status: null,
      canonicalStatus: null,
      statusRecognised: false,
      reportCommentId: report.id,
      reportBody,
      reason: "report_has_no_status_field"
    };
  }

  const verdict = classifyReportStatus(status);

  if (!verdict.terminal) {
    return {
      complete: false,
      successful: false,
      status,
      canonicalStatus: verdict.canonical,
      // The decisive new field. `false` means the report exists and was trusted,
      // but its STATUS is a spelling this worker does not know. Retrying on that
      // basis is what produced the D-131 loop, so the caller must fail closed and
      // make the mismatch visible instead of spinning.
      statusRecognised: verdict.recognised,
      reportCommentId: report.id,
      reportBody,
      reason: verdict.recognised
        // e.g. STATUS=IN_PROGRESS - real evidence of progress, but not completion.
        ? `report_status_not_terminal (${verdict.canonical})`
        : `report_status_unrecognised (${String(status).slice(0, 48)})`
    };
  }

  return {
    complete: true,
    successful: verdict.successful,
    status,
    canonicalStatus: verdict.canonical,
    outcome: verdict.outcome,
    statusRecognised: true,
    reportCommentId: report.id,
    reportBody,
    reportCreatedAt: report.created_at ?? null,
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

/**
 * D132: the merge TRUTH travels with the association, not just a boolean.
 *
 * A merge task that already performed its authorised state transition and then
 * lost its report must be closeable from evidence. "merged=true" alone does not
 * let the resumed child verify anything; the merge commit and the timestamp do.
 * Re-running a pre-merge instruction against post-merge state is exactly the
 * stale action the architect forbids.
 */
function normalisePull(pr) {
  if (!pr) return null;
  return {
    number: Number(pr.number),
    state: pr.state ?? null,
    headRefName: typeof pr.headRefName === "string" ? pr.headRefName : null,
    merged: Boolean(pr.merged || pr.mergedAt),
    mergedAt: pr.mergedAt ?? null,
    mergeCommitSha: pr.mergeCommitSha ?? null
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
export function mergeObservedAssociations(task, { branch = null, prNumber = null, head = null } = {}) {
  const branches = [...(task?.observed_branches ?? [])];
  const prNumbers = [...(task?.observed_pr_numbers ?? [])];
  // Every commit this task has been OBSERVED at, in order.
  //
  // D-134: this is a log of SIGHTINGS and nothing more. It records that a given
  // commit was the worktree's HEAD at a moment when the worker looked; it does
  // NOT record that this task authored any of them, and no code may read it that
  // way. Commit authorship is answered only by `lib/provenance.mjs`, from
  // positive per-attempt evidence carried in the commit itself.
  const heads = [...(task?.observed_heads ?? [])];
  if (usableBranch(branch) && !branches.includes(branch)) branches.push(branch);
  const n = Number(prNumber);
  if (Number.isInteger(n) && n > 0 && !prNumbers.includes(n)) prNumbers.push(n);
  if (typeof head === "string" && /^[0-9a-f]{7,40}$/i.test(head) && !heads.includes(head)) heads.push(head);
  return { observed_branches: branches, observed_pr_numbers: prNumbers, observed_heads: heads };
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

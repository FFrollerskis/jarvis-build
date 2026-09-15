/**
 * Trusted command boundary.
 *
 * UNCHANGED and deliberately not weakened by this repair (requirement D): a task
 * is command authority ONLY when it is a comment on the exact control issue,
 * authored by the exact trusted GitHub login, whose first non-empty line is
 * literally ARCHITECT_TASK, carrying a unique TASK_ID.
 *
 * This file additionally defines the supervisor's control schema, which is
 * strictly NARROWER than the task schema: two allowlisted commands, no free-form
 * arguments, no paths, host/worker binding, short expiry and replay rejection.
 */

import { collapseIdenticalOrderRepeats, orderByIssueSequence } from "./order-binding.mjs";

export function firstNonEmptyLine(body) {
  const line = String(body ?? "").split(/\r?\n/).find((l) => l.trim().length > 0);
  return (line ?? "").trim();
}

export function extractField(body, key) {
  const re = new RegExp(`^${key}=(.*)$`, "m");
  const m = String(body ?? "").match(re);
  return m ? m[1].trim() : null;
}

/** ---------------- ARCHITECT_TASK (worker) ---------------- */

export function validateTrustedTask(comment, { trustedAuthor }) {
  if (comment?.user?.login !== trustedAuthor) return { ok: false, reason: "author_mismatch" };
  if (firstNonEmptyLine(comment.body) !== "ARCHITECT_TASK") return { ok: false, reason: "not_architect_task" };
  const taskId = extractField(comment.body, "TASK_ID");
  if (!taskId) return { ok: false, reason: "missing_task_id" };
  return { ok: true, taskId };
}

/**
 * GROUP every trusted ARCHITECT_TASK comment by the TASK_ID it declares.
 *
 * D-150: SAME-ID TASK_UPDATE SEMANTICS ARE GONE. A second comment carrying an
 * existing TASK_ID used to be folded in as an "additive scope update" and its
 * body was written straight into the dispatched prompt - executable authority
 * that the durable admission binding did not cover and that no review had to have
 * seen. One task id has exactly ONE order. Changed or consolidated scope is
 * issued as a FRESH TASK_ID with an explicit `SUPERSEDES=<old id>`.
 *
 * D-151: THIS FUNCTION NO LONGER DECIDES ANYTHING. It used to publish two things
 * that read like verdicts and were not:
 *
 *   uniqueAuthority  a boolean derived from a COUNT, computed without knowing
 *                    whether the read was complete and without any of the edit,
 *                    comment-id, `created_at` or empty-body checks the real
 *                    classifier applies. Everything that read a body gated on it,
 *                    so a unique-but-EDITED order still declared `SUPERSEDES=`.
 *   comment          the oldest same-id candidate, promoted to "the entry's
 *                    order" by ARRAY POSITION. The queue then ranked and proved
 *                    direction from that representative's `created_at` and `id`.
 *
 * Both are gone. There is exactly one authority classifier
 * (`selectAdmissibleOrder`), it is asked once per cycle from the atomic snapshot
 * (`captureAuthoritySnapshot`), and its verdict is what travels. What is left
 * here is grouping and counting, which is all a grouping function should ever do.
 *
 * Each entry carries:
 *
 *   taskId             the exact id declared.
 *   candidates         EVERY same-id trusted comment, in a total, deterministic
 *                      issue sequence. Not "the order and its duplicates" - a
 *                      candidate SET, with no member privileged over another.
 *   distinctOrderCount how many DISTINCT orders exist for this id, after
 *                      provably-identical `--paginate` repeats are collapsed.
 *
 * The returned list is ordered by each group's EARLIEST candidate purely so that
 * output is stable and diffable. That ordering is presentational: nothing
 * downstream may rank, dispatch or retire from it.
 */
export function collectTrustedTasks(comments, { trustedAuthor }) {
  const byId = new Map();
  for (const c of Array.isArray(comments) ? comments : []) {
    const v = validateTrustedTask(c, { trustedAuthor });
    if (!v.ok) continue;
    if (!byId.has(v.taskId)) byId.set(v.taskId, []);
    byId.get(v.taskId).push(c);
  }

  const entries = [];
  for (const [taskId, all] of byId) {
    const candidates = [...all].sort(orderByIssueSequence);
    entries.push({
      taskId,
      candidates,
      distinctOrderCount: collapseIdenticalOrderRepeats(candidates).length
    });
  }
  return entries.sort((a, b) => orderByIssueSequence(a.candidates[0], b.candidates[0]));
}

/** ---------------- ARCHITECT_CONTROL (supervisor) ---------------- */

export const SUPERVISOR_COMMANDS = Object.freeze(["STATUS", "RESTART_WORKER"]);

/** Strict allowlist: any key outside this set makes the command invalid. */
export const SUPERVISOR_ALLOWED_KEYS = Object.freeze([
  "COMMAND_ID",
  "COMMAND",
  "TARGET_HOST",
  "TARGET_WORKER",
  "ISSUED_AT",
  "EXPIRES_AT"
]);

export const MAX_COMMAND_LIFETIME_MS = 60 * 60_000;

/**
 * Validate one supervisor control command.
 *
 * Rejects: wrong author, non-owner association, wrong header, unknown/extra keys,
 * unknown command, wrong host, wrong worker, missing/!ISO timestamps, expired,
 * over-long lifetime, EDITED comments (created_at !== updated_at, i.e. a replay
 * or after-the-fact tamper) and already-executed COMMAND_IDs.
 *
 * Author identity is taken from the GitHub-computed `user.login` and
 * `author_association`, never from anything the body claims about itself.
 */
export function validateControlCommand(comment, {
  trustedAuthor,
  host,
  workerTaskName,
  nowMs,
  executedCommandIds = []
}) {
  const reject = (reason) => ({ ok: false, reason });

  if (comment?.user?.login !== trustedAuthor) return reject("author_mismatch");
  if (comment?.author_association !== "OWNER") return reject("author_association_not_owner");
  if (firstNonEmptyLine(comment.body) !== "ARCHITECT_CONTROL") return reject("not_architect_control");

  // An edited comment cannot be trusted: the reviewed text and the executed text
  // would no longer provably be the same.
  if (comment.created_at && comment.updated_at && comment.created_at !== comment.updated_at) {
    return reject("comment_edited_after_creation");
  }

  const body = String(comment.body ?? "");
  const keyed = {};
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "ARCHITECT_CONTROL" || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z_]+)=(.*)$/);
    if (!m) return reject(`unparseable_line: ${trimmed.slice(0, 40)}`);
    if (!SUPERVISOR_ALLOWED_KEYS.includes(m[1])) return reject(`key_not_allowlisted: ${m[1]}`);
    if (keyed[m[1]] !== undefined) return reject(`duplicate_key: ${m[1]}`);
    keyed[m[1]] = m[2].trim();
  }

  for (const key of SUPERVISOR_ALLOWED_KEYS) {
    if (!keyed[key]) return reject(`missing_key: ${key}`);
  }
  if (!SUPERVISOR_COMMANDS.includes(keyed.COMMAND)) return reject(`command_not_allowlisted: ${keyed.COMMAND}`);
  if (!/^[0-9A-Za-z._-]{8,64}$/.test(keyed.COMMAND_ID)) return reject("command_id_malformed");
  if (keyed.TARGET_HOST !== host) return reject(`wrong_target_host (expected ${host})`);
  if (keyed.TARGET_WORKER !== workerTaskName) return reject(`wrong_target_worker (expected ${workerTaskName})`);

  const issued = Date.parse(keyed.ISSUED_AT);
  const expires = Date.parse(keyed.EXPIRES_AT);
  if (!Number.isFinite(issued)) return reject("issued_at_not_iso");
  if (!Number.isFinite(expires)) return reject("expires_at_not_iso");
  if (expires <= issued) return reject("expires_at_not_after_issued_at");
  if (expires - issued > MAX_COMMAND_LIFETIME_MS) return reject("lifetime_exceeds_maximum");
  if (nowMs > expires) return reject("command_expired");

  if (executedCommandIds.includes(keyed.COMMAND_ID)) return reject("command_id_already_executed");

  return {
    ok: true,
    commandId: keyed.COMMAND_ID,
    command: keyed.COMMAND,
    issuedAt: keyed.ISSUED_AT,
    expiresAt: keyed.EXPIRES_AT,
    commentId: comment.id
  };
}

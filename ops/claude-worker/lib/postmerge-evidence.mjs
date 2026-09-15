/**
 * REQUIRED POST-MERGE EVIDENCE (D-146).
 *
 * ------------------------------------------------------------------------
 * THE TWO FAIL-OPEN GAPS THIS MODULE CLOSES
 * ------------------------------------------------------------------------
 *
 * D-145 built the right structural proof of an authorized merge: the remote PR
 * is merged, the merge commit has exactly two parents in the authorized order,
 * and its tree is the approved head's tree. That part is untouched here.
 *
 * The independent exact-head review of PR #81 found that the POST-MERGE half of
 * the same proof was still fail-open in two places:
 *
 *   1. "ANY GREEN CHECK" — `classifyPostMergeChecks` accepted WHATEVER check runs
 *      the remote happened to return. It never asked which checks were REQUIRED.
 *      So a merge commit carrying one unrelated green check passed while
 *      `build-test` was simply absent, and `neutral`/`skipped` sat on the
 *      acceptable list. Absence of a required check was being read as success.
 *
 *   2. "THE REPORT CONTRIBUTES NOTHING" — verification took only `complete` and
 *      `successful` from the completion assessment. None of the task-required
 *      LOCAL closeout evidence was parsed or bound, so a child could post
 *      `STATUS=COMPLETE` before its local checkout was synced to the merge, or
 *      with a dirty worktree, and once remote CI went green the path accepted it.
 *
 * ------------------------------------------------------------------------
 * WHAT EACH KIND OF EVIDENCE IS ALLOWED TO PROVE
 * ------------------------------------------------------------------------
 *
 * This module keeps two classes of evidence strictly apart, because conflating
 * them is exactly how gap 2 opened:
 *
 *   REMOTE TRUTH — PR state, commit parents, commit tree, check-run conclusions.
 *     Read fresh from GitHub at gate time. The report's claims about any of these
 *     are NEVER accepted as proof of them; they are only ever CROSS-CHECKED
 *     against the fresh remote answer, and a disagreement fails closed.
 *
 *   LOCAL TRUTH — did the child sync its checkout to the merge, and did it leave
 *     the worktree clean? The worker cannot re-observe the child's local state
 *     after the fact, so the trusted terminal report is the ONLY available
 *     evidence for these. That is a real limitation, not a hidden one: the fields
 *     that rest on it are tagged `evidence: "local"` and are surfaced as
 *     `local_evidence_fields` on every result so a record can say plainly which
 *     part of its proof is a bound claim rather than a re-observation.
 *
 * Trust for BOTH classes is bound to the trusted ARCHITECT_TASK comment and the
 * worker's own configuration. Nothing is ever taken from PR text, PR titles,
 * branch names, CI logs or any other untrusted surface.
 *
 * ------------------------------------------------------------------------
 * WHY A DEFAULT REQUIRED SET IS NOT A BYPASS
 * ------------------------------------------------------------------------
 *
 * D-144's historical ARCHITECT_TASK states its required checks in PROSE
 * ("required build-test, windows-git-auth and gitleaks all SUCCESS"), not in a
 * machine-readable field. Parsing prose to decide a security gate is exactly the
 * kind of guess this control plane refuses to make.
 *
 * So the required set is resolved from TRUSTED POLICY, in descending authority:
 *
 *   1. `REQUIRED_POST_MERGE_CHECKS=` in this task's own trusted ARCHITECT_TASK;
 *   2. `postMergeEvidence.requiredChecks` in the worker's own config.json;
 *   3. `DEFAULT_REQUIRED_POST_MERGE_CHECKS` — the repository's actual required CI
 *      jobs, which are the three job ids in `.github/workflows/ci.yml`.
 *
 * Level 3 is a REPOSITORY-WIDE policy that applies to every merge task this
 * worker will ever run. It is not keyed to a task id, a comment id or a PR, and
 * it grants nothing: D-144 retires under it only because the repository's real
 * required checks really were green on the real merge commit. A future repo with
 * different jobs changes one constant or one config key; a future task that needs
 * a different set declares it in the trusted order.
 *
 * And if resolution yields NOTHING — an empty declaration, an empty config, an
 * empty default — the answer is a named refusal, never "then accept any green
 * check". Too little policy to decide is a decision to fail closed.
 */

import { firstNonEmptyLine } from "./trust.mjs";
import { classifyReportStatus } from "./reconcile.mjs";

/** Every outcome the post-merge evidence gates can produce. */
export const POST_MERGE_EVIDENCE = Object.freeze({
  /* --- policy resolution --- */
  /** No trusted policy names a single required check, so there is nothing to require. */
  POLICY_NO_REQUIRED_CHECKS:
    "no_trusted_policy_declares_which_post_merge_checks_are_required_so_the_gate_cannot_decide",
  /** A declared required check name is empty or not a usable check-run name. */
  POLICY_CHECK_NAME_MALFORMED: "a_declared_required_post_merge_check_name_is_malformed",
  /** The same required check name was declared twice. */
  POLICY_DUPLICATE_REQUIRED_CHECK: "the_same_required_post_merge_check_name_is_declared_more_than_once",
  /** The declared extra-check policy is not one this build knows. */
  POLICY_EXTRA_CHECKS_UNKNOWN: "the_declared_policy_for_extra_post_merge_checks_is_not_recognised",
  /** The declared closeout profile is not one this build knows. */
  POLICY_PROFILE_UNKNOWN: "the_declared_post_merge_closeout_evidence_profile_is_not_recognised",
  /** A `REQUIRED_CLOSEOUT_FIELDS` entry could not be parsed into a known rule. */
  POLICY_CLOSEOUT_FIELD_MALFORMED: "a_declared_required_closeout_field_is_malformed_or_names_an_unknown_rule",

  /* --- required check identity --- */
  /**
   * Check runs could not be read. Unknown CI is never green CI.
   *
   * This and `CHECKS_MISSING` keep the exact string values D-145 gave them: they
   * are the same two findings, and a recorded verdict written by an older build
   * must stay comparable to one written by this build.
   */
  CHECKS_UNREADABLE: "the_post_merge_check_runs_on_the_merge_commit_could_not_be_read",
  /** No check run exists on the merge commit at all. */
  CHECKS_MISSING: "no_post_merge_check_run_exists_on_the_merge_commit",
  /** A required check does not exist on the merge commit at all. */
  CHECKS_REQUIRED_MISSING: "a_required_post_merge_check_does_not_exist_on_the_merge_commit",
  /** A required check name appears more than once, so which one counts is ambiguous. */
  CHECKS_REQUIRED_AMBIGUOUS: "a_required_post_merge_check_name_appears_more_than_once_on_the_merge_commit",
  /** A required check exists but has not finished. */
  CHECKS_REQUIRED_UNFINISHED: "a_required_post_merge_check_on_the_merge_commit_has_not_finished",
  /** A required check finished as something other than `success`. */
  CHECKS_REQUIRED_NOT_SUCCESS: "a_required_post_merge_check_on_the_merge_commit_did_not_conclude_success",
  /** A check outside the required set failed, under the `must_not_fail` policy. */
  CHECKS_EXTRA_FAILED: "a_post_merge_check_outside_the_required_set_failed_on_the_merge_commit",
  /** A check outside the required set exists at all, under the `forbid` policy. */
  CHECKS_EXTRA_FORBIDDEN: "a_post_merge_check_outside_the_required_set_exists_and_the_policy_forbids_extra_checks",

  /* --- the bound terminal report --- */
  /** No report body travelled with the completion assessment, so nothing can be bound. */
  REPORT_BODY_UNAVAILABLE:
    "the_completion_assessment_carried_no_trusted_report_body_so_no_closeout_evidence_could_be_bound",
  /** The body that travelled is not a CLAUDE_REPORT at all. */
  REPORT_NOT_A_CLAUDE_REPORT: "the_carried_report_body_is_not_a_claude_report",
  /** The body is not identified by a comment id, so it cannot be bound to a source. */
  REPORT_NOT_IDENTIFIED: "the_carried_report_body_is_not_bound_to_an_identified_control_issue_comment",
  /** A required closeout field is absent from the report. */
  REPORT_FIELD_MISSING: "a_required_closeout_field_is_absent_from_the_trusted_report",
  /** A required closeout field appears more than once: duplicate or contradictory. */
  REPORT_FIELD_DUPLICATE: "a_required_closeout_field_appears_more_than_once_in_the_trusted_report",
  /** A required closeout field is present but does not carry the value it must. */
  REPORT_FIELD_MISMATCH: "a_required_closeout_field_in_the_trusted_report_does_not_match_the_verified_truth",
  /** The report's CI claim contradicts the fresh remote check-run conclusion. */
  REPORT_CI_CONTRADICTS_REMOTE:
    "the_trusted_report_claims_a_post_merge_check_result_that_the_fresh_remote_check_runs_contradict"
});

/**
 * The repository's own required CI jobs, taken from the job ids in
 * `.github/workflows/ci.yml`. Level-3 policy: repository-wide, not task-keyed.
 */
export const DEFAULT_REQUIRED_POST_MERGE_CHECKS = Object.freeze([
  "build-test",
  "windows-git-auth",
  "gitleaks"
]);

/** What may be done about check runs OUTSIDE the required set. */
export const EXTRA_CHECK_POLICY = Object.freeze({
  /** Extras are not consulted at all. */
  IGNORE: "ignore",
  /** Extras may exist and may be unfinished or neutral, but may NOT have failed. */
  MUST_NOT_FAIL: "must_not_fail",
  /** No check outside the required set may exist on the merge commit. */
  FORBID: "forbid"
});

const EXTRA_CHECK_POLICIES = Object.freeze(Object.values(EXTRA_CHECK_POLICY));

/** Conclusions that are an outright failure wherever they appear. */
const FAILING_CONCLUSIONS = Object.freeze([
  "failure",
  "timed_out",
  "action_required",
  "cancelled",
  "stale"
]);

/**
 * The rule vocabulary a closeout profile may use. Deliberately tiny and fixed:
 * every rule is a total function of (report value, bound truth), none of them can
 * reach the network or the filesystem, and an unknown rule name is a refusal
 * rather than a skipped field.
 */
export const CLOSEOUT_RULES = Object.freeze([
  "equals",
  "equals_number",
  "equals_sha",
  "literal_true",
  "literal_false",
  "present",
  "successful_terminal_status",
  "equals_remote_check_conclusion"
]);

/** Binding names a declared field may refer to. Nothing else is addressable. */
export const CLOSEOUT_BINDINGS = Object.freeze([
  "taskId",
  "prNumber",
  "expectedBase",
  "expectedHead",
  "mergeSha",
  "parent1",
  "parent2"
]);

/**
 * `merge_closeout_v1` — the evidence a D-144-style guarded merge closeout must
 * carry. `evidence: "local"` marks the three fields for which the trusted report
 * is the ONLY available proof; everything else is cross-checked against fresh
 * remote truth and the trusted authorization.
 */
export const MERGE_CLOSEOUT_V1 = Object.freeze([
  Object.freeze({ key: "TASK_ID", rule: "equals", bind: "taskId" }),
  Object.freeze({ key: "STATUS", rule: "successful_terminal_status" }),
  Object.freeze({ key: "PR_NUMBER", rule: "equals_number", bind: "prNumber" }),
  Object.freeze({ key: "EXPECTED_BASE_SHA", rule: "equals_sha", bind: "expectedBase" }),
  Object.freeze({ key: "EXPECTED_HEAD_SHA", rule: "equals_sha", bind: "expectedHead" }),
  Object.freeze({ key: "MERGED", rule: "literal_true" }),
  Object.freeze({ key: "MERGE_SHA", rule: "equals_sha", bind: "mergeSha" }),
  Object.freeze({ key: "PARENT_1", rule: "equals_sha", bind: "parent1" }),
  Object.freeze({ key: "PARENT_2", rule: "equals_sha", bind: "parent2" }),
  Object.freeze({ key: "TWO_PARENT_MERGE_VERIFIED", rule: "literal_true" }),
  Object.freeze({ key: "POST_MERGE_CI_RUN", rule: "present" }),
  // The local half. Not re-observable by the worker after the child has exited.
  Object.freeze({ key: "LOCAL_HEAD", rule: "equals_sha", bind: "mergeSha", evidence: "local" }),
  Object.freeze({ key: "ORIGIN_MAIN", rule: "equals_sha", bind: "mergeSha", evidence: "local" }),
  Object.freeze({ key: "WORKTREE_CLEAN", rule: "literal_true", evidence: "local" }),
  // D-120: a task may never have approved itself, and a hard external blocker is
  // never a successful closeout however green the CI is.
  Object.freeze({ key: "SELF_APPROVAL", rule: "literal_false" }),
  Object.freeze({ key: "HARD_EXTERNAL_BLOCKER", rule: "literal_false" })
]);

/**
 * Known profiles. A future profile is a new entry here; there is deliberately no
 * "none" profile, because a switch that turns the report gate off entirely is the
 * bypass this whole module exists to remove.
 */
export const CLOSEOUT_PROFILES = Object.freeze({
  merge_closeout_v1: MERGE_CLOSEOUT_V1
});

export const DEFAULT_CLOSEOUT_PROFILE = "merge_closeout_v1";

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
/** A GitHub check-run name: printable, no leading/trailing space, not empty. */
const CHECK_NAME_RE = /^[^\s](?:.*[^\s])?$/;
/** A protocol field line. Anchored, so prose and fenced code cannot fabricate one. */
const FIELD_LINE_RE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

function fullSha(value) {
  return typeof value === "string" && FULL_SHA_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/**
 * Turn a check-run name into the report field that must carry its result.
 *
 *     build-test       -> POST_MERGE_BUILD_TEST
 *     windows-git-auth -> POST_MERGE_WINDOWS_GIT_AUTH
 *
 * Deterministic and general: a new required check automatically requires its own
 * report field, with no per-task or per-check special case anywhere.
 */
export function reportFieldForCheck(name) {
  const slug = String(name ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug ? `POST_MERGE_${slug}` : null;
}

/**
 * Read EVERY protocol field occurrence in a body.
 *
 * Returns `Map<key, string[]>` — the full occurrence list, not the first hit.
 * `extractField` deliberately returns only the first match, which is right for
 * reading a trusted order but wrong for auditing a report: a body carrying
 * `WORKTREE_CLEAN=false` followed by `WORKTREE_CLEAN=true` would read as `false`
 * with `extractField` and as `true` with a naive last-wins reader, and neither is
 * an honest answer. Here both occurrences survive and the caller fails closed.
 *
 * The whole body is scanned rather than just the header block, so a field
 * appended anywhere later is still a duplicate. The `^KEY=` anchor means ordinary
 * prose, indented lines and fenced code cannot manufacture a field.
 */
export function readAllFields(body) {
  const fields = new Map();
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const m = line.match(FIELD_LINE_RE);
    if (!m) continue;
    const list = fields.get(m[1]);
    if (list) list.push(m[2].trim());
    else fields.set(m[1], [m[2].trim()]);
  }
  return fields;
}

function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve the post-merge evidence policy for ONE authorized merge task.
 *
 * `declared` is the trusted ARCHITECT_TASK body (already author-validated by the
 * caller). `workerPolicy` is the worker's own config. Neither PR text nor the
 * child's report is an input, and there is no code path by which one could be.
 *
 * Returns `{ ok, reason, detail, requiredChecks, extraChecksPolicy, profile,
 * closeoutFields, sources }`. `ok: false` is always a named refusal.
 */
export function resolvePostMergeEvidencePolicy({ declared = null, workerPolicy = null } = {}) {
  const refuse = (reason, detail = null) => ({
    ok: false, reason, detail, requiredChecks: [], extraChecksPolicy: null, profile: null, closeoutFields: [],
    sources: {}
  });
  const fields = readAllFields(declared);
  const wp = workerPolicy && typeof workerPolicy === "object" ? workerPolicy : {};
  const sources = {};

  // A field declared twice in the ORDER is as ambiguous as one declared twice in
  // a report, and an ambiguous order is not an order.
  for (const key of ["REQUIRED_POST_MERGE_CHECKS", "EXTRA_POST_MERGE_CHECKS",
    "POST_MERGE_EVIDENCE_PROFILE", "REQUIRED_CLOSEOUT_FIELDS"]) {
    if ((fields.get(key)?.length ?? 0) > 1) {
      return refuse(POST_MERGE_EVIDENCE.POLICY_DUPLICATE_REQUIRED_CHECK,
        `the trusted task declares ${key} ${fields.get(key).length} times`);
    }
  }

  // --- required checks ------------------------------------------------------
  let requiredChecks;
  const declaredChecks = fields.get("REQUIRED_POST_MERGE_CHECKS")?.[0];
  if (declaredChecks !== undefined) {
    requiredChecks = splitList(declaredChecks);
    sources.requiredChecks = "trusted_architect_task";
  } else if (Array.isArray(wp.requiredChecks)) {
    requiredChecks = wp.requiredChecks.map((c) => String(c ?? "").trim()).filter((c) => c.length > 0);
    sources.requiredChecks = "worker_config";
  } else {
    requiredChecks = [...DEFAULT_REQUIRED_POST_MERGE_CHECKS];
    sources.requiredChecks = "repository_default";
  }

  if (requiredChecks.length === 0) {
    return refuse(POST_MERGE_EVIDENCE.POLICY_NO_REQUIRED_CHECKS,
      `the resolved required-check set is empty (source=${sources.requiredChecks}); an authorized merge task `
      + "without a required check set fails closed rather than accepting whatever checks happen to be green");
  }
  for (const name of requiredChecks) {
    if (!CHECK_NAME_RE.test(name)) {
      return refuse(POST_MERGE_EVIDENCE.POLICY_CHECK_NAME_MALFORMED, `required check ${JSON.stringify(name)}`);
    }
    if (!reportFieldForCheck(name)) {
      return refuse(POST_MERGE_EVIDENCE.POLICY_CHECK_NAME_MALFORMED,
        `required check ${JSON.stringify(name)} has no usable report field name`);
    }
  }
  const seen = new Set();
  for (const name of requiredChecks) {
    if (seen.has(name)) {
      return refuse(POST_MERGE_EVIDENCE.POLICY_DUPLICATE_REQUIRED_CHECK, `required check ${JSON.stringify(name)}`);
    }
    seen.add(name);
  }
  // Two different check names must not collapse onto the same report field, or
  // one of them would be silently unverifiable in the report.
  const byField = new Map();
  for (const name of requiredChecks) {
    const field = reportFieldForCheck(name);
    if (byField.has(field)) {
      return refuse(POST_MERGE_EVIDENCE.POLICY_DUPLICATE_REQUIRED_CHECK,
        `required checks ${JSON.stringify(byField.get(field))} and ${JSON.stringify(name)} both map to the report `
        + `field ${field}`);
    }
    byField.set(field, name);
  }

  // --- extra-check policy ---------------------------------------------------
  let extraChecksPolicy;
  const declaredExtra = fields.get("EXTRA_POST_MERGE_CHECKS")?.[0];
  if (declaredExtra !== undefined) {
    extraChecksPolicy = declaredExtra.toLowerCase();
    sources.extraChecksPolicy = "trusted_architect_task";
  } else if (typeof wp.extraChecksPolicy === "string" && wp.extraChecksPolicy.trim()) {
    extraChecksPolicy = wp.extraChecksPolicy.trim().toLowerCase();
    sources.extraChecksPolicy = "worker_config";
  } else {
    extraChecksPolicy = EXTRA_CHECK_POLICY.MUST_NOT_FAIL;
    sources.extraChecksPolicy = "repository_default";
  }
  if (!EXTRA_CHECK_POLICIES.includes(extraChecksPolicy)) {
    return refuse(POST_MERGE_EVIDENCE.POLICY_EXTRA_CHECKS_UNKNOWN,
      `EXTRA_POST_MERGE_CHECKS=${JSON.stringify(extraChecksPolicy)}; known policies are `
      + EXTRA_CHECK_POLICIES.join(", "));
  }

  // --- closeout profile -----------------------------------------------------
  let profile;
  const declaredProfile = fields.get("POST_MERGE_EVIDENCE_PROFILE")?.[0];
  if (declaredProfile !== undefined) {
    profile = declaredProfile.trim();
    sources.profile = "trusted_architect_task";
  } else if (typeof wp.profile === "string" && wp.profile.trim()) {
    profile = wp.profile.trim();
    sources.profile = "worker_config";
  } else {
    profile = DEFAULT_CLOSEOUT_PROFILE;
    sources.profile = "repository_default";
  }
  if (!Object.prototype.hasOwnProperty.call(CLOSEOUT_PROFILES, profile)) {
    return refuse(POST_MERGE_EVIDENCE.POLICY_PROFILE_UNKNOWN,
      `POST_MERGE_EVIDENCE_PROFILE=${JSON.stringify(profile)}; known profiles are `
      + Object.keys(CLOSEOUT_PROFILES).join(", "));
  }

  // --- the field list -------------------------------------------------------
  // Profile fields, then one generated field per required check, then whatever
  // the trusted order declared on top. Extra declarations may only ADD.
  const closeoutFields = [...CLOSEOUT_PROFILES[profile]];
  for (const name of requiredChecks) {
    closeoutFields.push(Object.freeze({
      key: reportFieldForCheck(name),
      rule: "equals_remote_check_conclusion",
      check: name
    }));
  }

  const declaredFields = fields.get("REQUIRED_CLOSEOUT_FIELDS")?.[0];
  if (declaredFields !== undefined) {
    sources.closeoutFields = "trusted_architect_task";
    for (const entry of splitList(declaredFields)) {
      // KEY:rule  or  KEY:rule:binding
      const parts = entry.split(":").map((p) => p.trim());
      const [key, rule, bind] = parts;
      if (parts.length < 2 || parts.length > 3 || !key || !FIELD_LINE_RE.test(`${key}=`)) {
        return refuse(POST_MERGE_EVIDENCE.POLICY_CLOSEOUT_FIELD_MALFORMED,
          `REQUIRED_CLOSEOUT_FIELDS entry ${JSON.stringify(entry)} is not KEY:rule or KEY:rule:binding`);
      }
      if (!CLOSEOUT_RULES.includes(rule)) {
        return refuse(POST_MERGE_EVIDENCE.POLICY_CLOSEOUT_FIELD_MALFORMED,
          `REQUIRED_CLOSEOUT_FIELDS entry ${JSON.stringify(entry)} names rule ${JSON.stringify(rule)}; known rules `
          + `are ${CLOSEOUT_RULES.join(", ")}`);
      }
      // `equals_remote_check_conclusion` is generated from the required set, not
      // declarable: a hand-declared one could name a check nobody requires.
      if (rule === "equals_remote_check_conclusion") {
        return refuse(POST_MERGE_EVIDENCE.POLICY_CLOSEOUT_FIELD_MALFORMED,
          `REQUIRED_CLOSEOUT_FIELDS entry ${JSON.stringify(entry)} uses equals_remote_check_conclusion, which is `
          + "generated from REQUIRED_POST_MERGE_CHECKS and cannot be declared by hand");
      }
      const needsBind = ["equals", "equals_number", "equals_sha"].includes(rule);
      if (needsBind && (!bind || !CLOSEOUT_BINDINGS.includes(bind))) {
        return refuse(POST_MERGE_EVIDENCE.POLICY_CLOSEOUT_FIELD_MALFORMED,
          `REQUIRED_CLOSEOUT_FIELDS entry ${JSON.stringify(entry)} needs a binding from `
          + `${CLOSEOUT_BINDINGS.join(", ")}`);
      }
      if (!needsBind && bind !== undefined) {
        return refuse(POST_MERGE_EVIDENCE.POLICY_CLOSEOUT_FIELD_MALFORMED,
          `REQUIRED_CLOSEOUT_FIELDS entry ${JSON.stringify(entry)} gives a binding to rule ${rule}, which takes none`);
      }
      if (closeoutFields.some((f) => f.key === key)) continue; // already required, at least as strictly
      closeoutFields.push(Object.freeze(bind ? { key, rule, bind } : { key, rule }));
    }
  }

  return {
    ok: true,
    reason: null,
    detail: null,
    requiredChecks,
    extraChecksPolicy,
    profile,
    closeoutFields: Object.freeze(closeoutFields),
    sources
  };
}

/**
 * Classify the post-merge check runs on the merge commit against the REQUIRED set.
 *
 * Fail-closed in every direction: unreadable is not green, empty is not green,
 * unfinished is not green, absent is not green, and `neutral`/`skipped` are not
 * green for a REQUIRED check. Extra checks are evaluated separately and can only
 * ever make the answer worse — there is no branch in which an extra check
 * satisfies a required name.
 */
export function classifyPostMergeChecks(checks, policy = null) {
  const empty = [];
  if (!policy || policy.ok !== true) {
    return {
      ok: false,
      reason: policy?.reason ?? POST_MERGE_EVIDENCE.POLICY_NO_REQUIRED_CHECKS,
      detail: policy?.detail ?? "no resolved post-merge evidence policy was supplied",
      runs: empty,
      required: [],
      extra: []
    };
  }
  if (!checks || checks.ok !== true) {
    return {
      ok: false,
      reason: POST_MERGE_EVIDENCE.CHECKS_UNREADABLE,
      detail: checks?.error ?? "not queried",
      runs: empty,
      required: policy.requiredChecks,
      extra: []
    };
  }
  const runs = (Array.isArray(checks.runs) ? checks.runs : []).map((r) => ({
    name: String(r?.name ?? "").trim(),
    status: String(r?.status ?? "").toLowerCase(),
    conclusion: r?.conclusion === null || r?.conclusion === undefined ? null : String(r.conclusion).toLowerCase()
  }));

  const required = policy.requiredChecks;
  const requiredSet = new Set(required);
  const fail = (reason, detail) => ({ ok: false, reason, detail, runs, required, extra: [] });

  if (runs.length === 0) {
    return fail(POST_MERGE_EVIDENCE.CHECKS_MISSING,
      `the merge commit has no check runs at all, so all ${required.length} required check(s) are absent: `
      + required.join(", "));
  }

  // --- the required set, name by name, exactly once each --------------------
  const conclusions = new Map();
  for (const name of required) {
    const matches = runs.filter((r) => r.name === name);
    if (matches.length === 0) {
      return fail(POST_MERGE_EVIDENCE.CHECKS_REQUIRED_MISSING,
        `required check ${JSON.stringify(name)} does not exist on the merge commit; the commit carries `
        + `${runs.length} check run(s) (${runs.map((r) => r.name).join(", ")}), and a check outside the required `
        + "set never substitutes for a required one");
    }
    if (matches.length > 1) {
      return fail(POST_MERGE_EVIDENCE.CHECKS_REQUIRED_AMBIGUOUS,
        `required check ${JSON.stringify(name)} appears ${matches.length} times `
        + `(${matches.map((r) => `${r.status}/${r.conclusion ?? "null"}`).join(", ")}); which run is THE required `
        + "check cannot be decided, so it is not decided in favour of passing");
    }
    const run = matches[0];
    if (run.status !== "completed") {
      return fail(POST_MERGE_EVIDENCE.CHECKS_REQUIRED_UNFINISHED,
        `required check ${JSON.stringify(name)} is status=${run.status || "unknown"}`);
    }
    if (run.conclusion !== "success") {
      return fail(POST_MERGE_EVIDENCE.CHECKS_REQUIRED_NOT_SUCCESS,
        `required check ${JSON.stringify(name)} concluded ${JSON.stringify(run.conclusion)}; a required check must `
        + "conclude success, and neutral, skipped, cancelled and null are not success");
    }
    conclusions.set(name, run.conclusion);
  }

  // --- everything else ------------------------------------------------------
  const extra = runs.filter((r) => !requiredSet.has(r.name));
  if (policy.extraChecksPolicy === EXTRA_CHECK_POLICY.FORBID && extra.length > 0) {
    return {
      ok: false,
      reason: POST_MERGE_EVIDENCE.CHECKS_EXTRA_FORBIDDEN,
      detail: `${extra.length} check run(s) outside the required set: ${extra.map((r) => r.name).join(", ")}`,
      runs,
      required,
      extra
    };
  }
  if (policy.extraChecksPolicy === EXTRA_CHECK_POLICY.MUST_NOT_FAIL) {
    const failed = extra.filter((r) => FAILING_CONCLUSIONS.includes(r.conclusion ?? ""));
    if (failed.length > 0) {
      return {
        ok: false,
        reason: POST_MERGE_EVIDENCE.CHECKS_EXTRA_FAILED,
        detail: failed.map((r) => `${r.name}=${r.conclusion}`).join(", "),
        runs,
        required,
        extra
      };
    }
  }

  return { ok: true, reason: null, detail: null, runs, required, extra, conclusions };
}

/** Evaluate ONE closeout field spec. Pure; returns `null` when it passes. */
function evaluateField(spec, values, bindings, conclusions) {
  const bad = (reason, detail) => ({ reason, detail: `${spec.key}: ${detail}` });

  if (values === undefined) {
    return bad(POST_MERGE_EVIDENCE.REPORT_FIELD_MISSING,
      `the trusted report declares no ${spec.key}, and an absent field is never a satisfied one`);
  }
  if (values.length > 1) {
    return bad(POST_MERGE_EVIDENCE.REPORT_FIELD_DUPLICATE,
      `declared ${values.length} times (${values.map((v) => JSON.stringify(v)).join(", ")}); a duplicated field is `
      + "ambiguous whether or not the values agree, and ambiguity is not evidence");
  }
  const value = values[0];

  switch (spec.rule) {
    case "present":
      if (value.length === 0) return bad(POST_MERGE_EVIDENCE.REPORT_FIELD_MISSING, "declared but empty");
      return null;

    case "literal_true":
      if (value.toLowerCase() !== "true") {
        return bad(POST_MERGE_EVIDENCE.REPORT_FIELD_MISMATCH, `is ${JSON.stringify(value)}, must be literally true`);
      }
      return null;

    case "literal_false":
      if (value.toLowerCase() !== "false") {
        return bad(POST_MERGE_EVIDENCE.REPORT_FIELD_MISMATCH, `is ${JSON.stringify(value)}, must be literally false`);
      }
      return null;

    case "successful_terminal_status": {
      const verdict = classifyReportStatus(value);
      if (!verdict.terminal || !verdict.successful) {
        return bad(POST_MERGE_EVIDENCE.REPORT_FIELD_MISMATCH,
          `STATUS=${JSON.stringify(value)} is not a recognised SUCCESSFUL terminal status `
          + `(terminal=${verdict.terminal}, successful=${verdict.successful})`);
      }
      return null;
    }

    case "equals": {
      const expected = bindings[spec.bind];
      if (expected === null || expected === undefined || value !== String(expected)) {
        return bad(POST_MERGE_EVIDENCE.REPORT_FIELD_MISMATCH,
          `is ${JSON.stringify(value)}, the verified ${spec.bind} is ${JSON.stringify(expected ?? null)}`);
      }
      return null;
    }

    case "equals_number": {
      const expected = bindings[spec.bind];
      if (!/^\d+$/.test(value) || Number(value) !== Number(expected)) {
        return bad(POST_MERGE_EVIDENCE.REPORT_FIELD_MISMATCH,
          `is ${JSON.stringify(value)}, the verified ${spec.bind} is ${JSON.stringify(expected ?? null)}`);
      }
      return null;
    }

    case "equals_sha": {
      const expected = fullSha(bindings[spec.bind]);
      const got = fullSha(value);
      if (expected === null || got === null || got !== expected) {
        return bad(POST_MERGE_EVIDENCE.REPORT_FIELD_MISMATCH,
          `is ${JSON.stringify(value)}, the verified ${spec.bind} is ${JSON.stringify(expected)}`);
      }
      return null;
    }

    case "equals_remote_check_conclusion": {
      const remote = conclusions?.get?.(spec.check) ?? null;
      if (remote === null) {
        return bad(POST_MERGE_EVIDENCE.REPORT_CI_CONTRADICTS_REMOTE,
          `the fresh remote check runs carry no conclusion for required check ${JSON.stringify(spec.check)}`);
      }
      if (value.toLowerCase() !== remote) {
        return bad(POST_MERGE_EVIDENCE.REPORT_CI_CONTRADICTS_REMOTE,
          `the report claims ${JSON.stringify(value)} for required check ${JSON.stringify(spec.check)}, the fresh `
          + `remote check run concluded ${JSON.stringify(remote)}`);
      }
      return null;
    }

    default:
      // Unreachable via `resolvePostMergeEvidencePolicy`, which rejects unknown
      // rules at parse time. Still a refusal rather than a silent pass, because a
      // rule this build cannot evaluate has evaluated nothing.
      return bad(POST_MERGE_EVIDENCE.POLICY_CLOSEOUT_FIELD_MALFORMED,
        `rule ${JSON.stringify(spec.rule)} is not evaluable by this build`);
  }
}

/**
 * Verify the EXACT trusted terminal report that completion assessment selected.
 *
 * `completion` must be an `assessCompletion` result carrying `reportBody` and
 * `reportCommentId` — the two travel together precisely so no caller can pair one
 * task's verdict with another task's text. The body's own `TASK_ID` is then
 * re-checked against the task the AUTHORIZATION binds, so a report borrowed from
 * another task or another comment fails closed even if it were handed in here.
 *
 * `bindings` is verified truth: the authorization's task/PR/base/head plus the
 * FRESH remote merge sha and parents. Nothing in `bindings` comes from the report.
 */
export function verifyCloseoutReport({ completion, policy, bindings, checkVerdict }) {
  const commentId = completion?.reportCommentId ?? null;
  const base = {
    ok: false,
    report_comment_id: commentId,
    report_status: completion?.status ?? null,
    profile: policy?.profile ?? null,
    checked_fields: [],
    local_evidence_fields: []
  };
  const refuse = (reason, detail) => ({ ...base, reason, detail });

  if (!policy || policy.ok !== true) {
    return refuse(policy?.reason ?? POST_MERGE_EVIDENCE.POLICY_NO_REQUIRED_CHECKS,
      policy?.detail ?? "no resolved post-merge evidence policy was supplied");
  }
  const body = typeof completion?.reportBody === "string" ? completion.reportBody : null;
  if (!body || body.trim().length === 0) {
    return refuse(POST_MERGE_EVIDENCE.REPORT_BODY_UNAVAILABLE,
      "the completion assessment produced no trusted report body; without the exact selected report there is "
      + "nothing to bind, and an unbindable closeout claim is refused rather than assumed");
  }
  if (commentId === null || commentId === undefined) {
    return refuse(POST_MERGE_EVIDENCE.REPORT_NOT_IDENTIFIED,
      "the carried report body has no control-issue comment id, so its source cannot be named");
  }
  if (firstNonEmptyLine(body) !== "CLAUDE_REPORT") {
    return refuse(POST_MERGE_EVIDENCE.REPORT_NOT_A_CLAUDE_REPORT,
      `the carried body's first non-empty line is ${JSON.stringify(firstNonEmptyLine(body).slice(0, 40))}`);
  }

  const fields = readAllFields(body);
  const checked = [];
  const localFields = [];
  for (const spec of policy.closeoutFields) {
    const failure = evaluateField(spec, fields.get(spec.key), bindings ?? {}, checkVerdict?.conclusions);
    if (failure) return { ...base, reason: failure.reason, detail: failure.detail };
    checked.push(spec.key);
    if (spec.evidence === "local") localFields.push(spec.key);
  }

  return {
    ...base,
    ok: true,
    reason: null,
    detail: `all ${checked.length} required closeout field(s) in trusted report ${commentId} are present exactly `
      + `once and bound to the verified truth (${checked.join(", ")})`,
    checked_fields: checked,
    local_evidence_fields: localFields
  };
}

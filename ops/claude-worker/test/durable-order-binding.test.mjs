/**
 * D-149: AN ADMITTED TASK IS BOUND TO ITS ORIGINAL ORDER, DURABLY AND IMMUTABLY.
 *
 * ------------------------------------------------------------------------
 * THE DOWNGRADE THESE RULES CLOSE
 * ------------------------------------------------------------------------
 *
 * D-148 asserts that TWO orders for one TASK_ID are undecidable. D-149 asserts
 * the other half, which D-148 left as the ordinary path:
 *
 *     ZERO orders for a task that WAS ADMITTED FROM ONE is also undecidable.
 *
 * Before this, `|candidates| == 0` mapped to `NO_TRUSTED_TASK` -> claim `NONE` ->
 * "not a merge task" -> no transition proof, no required CI, no bound closeout
 * report. So the whole of D-145/D-146/D-147 could be removed by REMOVING THE
 * ORDER - and the actor able to do that is the dispatched child, which runs `gh`
 * as the repository owner.
 *
 * The invariant, stated once:
 *
 *     "I cannot find the order now" is a fact about the WORKER'S READ.
 *     It is never a fact about the ORDER. Only PRE-ADMISSION DISCOVERY may
 *     read "no match" as genuine absence.
 *
 * ------------------------------------------------------------------------
 * WHAT IS ASSERTED HERE
 * ------------------------------------------------------------------------
 *
 * The pure layer, exhaustively:
 *
 *   BINDING     built once from the exact body bytes; immutable; a rebind
 *               attempt against a different order is a named refusal and never
 *               a silent update.
 *   CLASSIFY    for a bound task: a missing/invalid binding, an unproven read,
 *               zero candidates, a different id, a changed byte, a changed
 *               created_at and every D-148 duplicate shape are all UNDECIDABLE.
 *               NONE is reachable only from an order that is PRESENT, PROVEN and
 *               MATCHING and that declares false/false.
 *   GATE        every one of those holds the completion gate, with the binding
 *               evidence recorded and no order body anywhere in it.
 *   STATE       the binding survives an atomic save/load round trip, a corrupt
 *               binding makes the document invalid rather than being dropped,
 *               and a legacy record without one is MARKED rather than repaired.
 *
 * The process-level half - a real child actually deleting its own order, through
 * all four completion paths - is in `worker-order-binding.test.mjs`.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ORDER_BINDING,
  ORDER_BINDING_VERSION,
  bindOrderOnce,
  buildOrderBinding,
  describeOrderBinding,
  digestLabel,
  orderBindingEvidence,
  orderBodyDigest,
  validateOrderBinding,
  verifyOrderAgainstBinding
} from "../lib/order-binding.mjs";
import {
  MERGE_AUTHORIZATION,
  MERGE_TRANSITION,
  classifyBoundMergeAuthorization,
  classifyMergeAuthorization
} from "../lib/merge-transition.mjs";
import { COMPLETION_GATE, describeCompletionGate, evaluateCompletionGate } from "../lib/provenance.mjs";
import {
  TASK_STATUS,
  classifyRawWorkerState,
  loadState,
  migrateState,
  saveStateAtomic
} from "../lib/state.mjs";
import { parsePaginatedJsonDetailed } from "../lib/github.mjs";

const TRUSTED = "tsworkflow";
const TASK_ID = "D149-PR81-DURABLE-ORDER-BINDING-20260915-A";
const BASE = "0c803bf1c1724413dc8e8071a7aabe7fd52562e4";
const HEAD = "930c81fcb0247bac3ccfe1fc4fe7f666b3a2111b";
const ORDER_ID = 5674803631;
const CREATED = "2026-09-15T04:36:50Z";

const OPTS = Object.freeze({
  trustedAuthor: TRUSTED,
  taskId: TASK_ID,
  repoOwner: "tsworkflow",
  repoName: "jarvisbuild"
});

/** One trusted-looking ARCHITECT_TASK comment, with every knob exposed. */
function order(fields = {}, {
  author = TRUSTED,
  header = "ARCHITECT_TASK",
  taskId = TASK_ID,
  id = ORDER_ID,
  createdAt = CREATED,
  updatedAt = undefined
} = {}) {
  const all = {
    TASK_ID: taskId,
    REPO: "tsworkflow/jarvisbuild",
    PR_NUMBER: "81",
    EXPECTED_BASE_SHA: BASE,
    EXPECTED_HEAD_SHA: HEAD,
    ARCHITECT_MERGE_APPROVED: "true",
    MERGE_AUTHORIZED: "true",
    ...fields
  };
  return {
    id,
    created_at: createdAt,
    updated_at: updatedAt === undefined ? createdAt : updatedAt,
    author_association: "OWNER",
    user: { login: author },
    body: [header, ...Object.entries(all).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`)].join("\n")
  };
}

const AUTHORIZING = () => order();
const ORDINARY = () => order({ ARCHITECT_MERGE_APPROVED: "false", MERGE_AUTHORIZED: "false" });

/** The binding a real admission would have written for `comment`. */
function bindingFor(comment) {
  const built = buildOrderBinding({ comment, taskId: TASK_ID, boundAt: "2026-09-15T04:40:00Z" });
  expect(built.ok).toBe(true);
  return built.binding;
}

/** Classify as an ADMITTED task with a proven-complete read, unless told otherwise. */
function classifyBound(comments, { binding = bindingFor(AUTHORIZING()), complete = true } = {}) {
  return classifyBoundMergeAuthorization({ comments, commentsComplete: complete, binding, ...OPTS });
}

/** Every hold ends here: UNDECIDABLE, named, never NONE, never AUTHORIZED. */
function expectUndecidable(claim, reason) {
  expect(claim.claim).toBe(MERGE_AUTHORIZATION.UNDECIDABLE);
  expect(claim.claimed).toBe(true);
  expect(claim.decidable).toBe(false);
  // THE WHOLE POINT. A missing order must never look like an ordinary task.
  expect(claim.claim).not.toBe(MERGE_AUTHORIZATION.NONE);
  expect(claim.claim).not.toBe(MERGE_AUTHORIZATION.AUTHORIZED);
  if (reason) expect(claim.reason).toBe(reason);
  return claim;
}

/* ==========================================================================
 * 1. THE DIGEST: it is over BYTES, and it notices one of them
 * ========================================================================== */

describe("D-149 digest", () => {
  it("is deterministic and stable across calls", () => {
    const a = orderBodyDigest("ARCHITECT_TASK\nTASK_ID=X\n");
    const b = orderBodyDigest("ARCHITECT_TASK\nTASK_ID=X\n");
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.bytes).toBe(Buffer.from("ARCHITECT_TASK\nTASK_ID=X\n", "utf8").length);
  });

  it("changes for a ONE BYTE difference anywhere in the body", () => {
    const base = AUTHORIZING().body;
    const mutations = [
      base.replace("MERGE_AUTHORIZED=true", "MERGE_AUTHORIZED=TRUE"),
      base.replace("PR_NUMBER=81", "PR_NUMBER=82"),
      base.replace(BASE, BASE.slice(0, 39) + "5"),
      `${base} `,
      ` ${base}`,
      `${base}\n`
    ];
    const original = orderBodyDigest(base).sha256;
    for (const m of mutations) {
      expect(m, "the mutation must actually differ").not.toBe(base);
      expect(orderBodyDigest(m).sha256).not.toBe(original);
    }
  });

  it("does NOT normalise whitespace, case or line endings", () => {
    // Every one of these normalisations would let two materially different
    // orders digest identically, which is the one thing the digest must not do.
    const crlf = AUTHORIZING().body.split("\n").join("\r\n");
    expect(orderBodyDigest(crlf).sha256).not.toBe(orderBodyDigest(AUTHORIZING().body).sha256);
  });

  it("refuses to digest a non-string body", () => {
    for (const body of [null, undefined, 42, {}, []]) {
      expect(orderBodyDigest(body)).toBe(null);
    }
  });

  it("digestLabel leaks nothing and is stable", () => {
    const d = orderBodyDigest(AUTHORIZING().body);
    expect(digestLabel(d.sha256)).toBe(`sha256:${d.sha256.slice(0, 12)}`);
    expect(digestLabel(d.sha256)).not.toContain("MERGE_AUTHORIZED");
    expect(digestLabel(null)).toBe("sha256:unknown");
  });
});

/* ==========================================================================
 * 2. BINDING: built once, never rebuilt
 * ========================================================================== */

describe("D-149 binding is built at admission and is immutable", () => {
  it("binds the comment id, created_at and the exact body digest", () => {
    const b = bindingFor(AUTHORIZING());
    expect(b.binding_version).toBe(ORDER_BINDING_VERSION);
    expect(b.task_id).toBe(TASK_ID);
    expect(b.comment_id).toBe(String(ORDER_ID));
    expect(b.created_at).toBe(CREATED);
    expect(b.body_sha256).toBe(orderBodyDigest(AUTHORIZING().body).sha256);
    expect(b.body_bytes).toBe(Buffer.from(AUTHORIZING().body, "utf8").length);
    // NO BODY. A binding is safe to log, post and paste.
    expect(JSON.stringify(b)).not.toContain("MERGE_AUTHORIZED");
    expect(JSON.stringify(b)).not.toContain("ARCHITECT_TASK");
  });

  it("normalises a numeric and a string comment id to the same value", () => {
    const n = buildOrderBinding({ comment: order({}, { id: 12345 }), taskId: TASK_ID });
    const s = buildOrderBinding({ comment: { ...order({}, { id: 12345 }), id: "12345" }, taskId: TASK_ID });
    expect(n.binding.comment_id).toBe(s.binding.comment_id);
  });

  it("refuses a comment with no usable id or no body", () => {
    for (const bad of [{ ...AUTHORIZING(), id: null }, { ...AUTHORIZING(), id: "  " }]) {
      const r = buildOrderBinding({ comment: bad, taskId: TASK_ID });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(ORDER_BINDING.UNBINDABLE_COMMENT);
    }
    const noBody = buildOrderBinding({ comment: { ...AUTHORIZING(), body: null }, taskId: TASK_ID });
    expect(noBody.ok).toBe(false);
    expect(noBody.reason).toBe(ORDER_BINDING.UNBINDABLE_COMMENT);
  });

  it("REUSES the stored document when the same order is offered again", () => {
    const existing = bindingFor(AUTHORIZING());
    const again = bindOrderOnce({ existing, comment: AUTHORIZING(), taskId: TASK_ID });
    expect(again.ok).toBe(true);
    expect(again.created).toBe(false);
    expect(again.reused).toBe(true);
    // The STORED bytes, not a freshly computed copy - `bound_at` proves it.
    expect(again.binding).toBe(existing);
    expect(again.binding.bound_at).toBe("2026-09-15T04:40:00Z");
  });

  it("REFUSES to rebind to a different order, and writes nothing", () => {
    const existing = bindingFor(AUTHORIZING());

    // A different comment id entirely.
    const other = bindOrderOnce({ existing, comment: order({}, { id: ORDER_ID + 1 }), taskId: TASK_ID });
    expect(other.ok).toBe(false);
    expect(other.reason).toBe(ORDER_BINDING.COMMENT_ID_MISMATCH);
    expect(other.binding).toBe(existing);     // untouched

    // Same id, one byte different.
    const edited = bindOrderOnce({ existing, comment: order({ PR_NUMBER: "82" }), taskId: TASK_ID });
    expect(edited.ok).toBe(false);
    expect(edited.reason).toBe(ORDER_BINDING.BODY_DIGEST_MISMATCH);

    // Same id, same body, different creation time: a re-post wearing the old id.
    const reissued = bindOrderOnce({
      existing, comment: order({}, { createdAt: "2026-09-16T00:00:00Z" }), taskId: TASK_ID
    });
    expect(reissued.ok).toBe(false);
    expect(reissued.reason).toBe(ORDER_BINDING.CREATED_AT_MISMATCH);

    // Gone entirely.
    const absent = bindOrderOnce({ existing, comment: null, taskId: TASK_ID });
    expect(absent.ok).toBe(false);
    expect(absent.reason).toBe(ORDER_BINDING.IMMUTABLE_CONFLICT);
  });

  it("REFUSES to repair a corrupt stored binding from current text", () => {
    // The tempting "fix": the binding is unreadable, the order is right there,
    // so rebuild it. That is exactly "authority recomputed from later mutable
    // text", and it is refused.
    for (const corrupt of [{}, { binding_version: 1 }, { binding_version: 1, task_id: TASK_ID }, []]) {
      const r = bindOrderOnce({ existing: corrupt, comment: AUTHORIZING(), taskId: TASK_ID });
      expect(r.ok).toBe(false);
      expect([ORDER_BINDING.BINDING_INVALID, ORDER_BINDING.BINDING_MISSING]).toContain(r.reason);
      expect(r.created).toBe(false);
    }
  });

  it("REFUSES a binding from an unsupported future version", () => {
    const future = { ...bindingFor(AUTHORIZING()), binding_version: ORDER_BINDING_VERSION + 1 };
    const v = validateOrderBinding(future, { taskId: TASK_ID });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(ORDER_BINDING.BINDING_VERSION_UNSUPPORTED);
  });

  it("REFUSES a binding that names another task", () => {
    const foreign = { ...bindingFor(AUTHORIZING()), task_id: "SOME-OTHER-TASK-20260915-A" };
    const v = validateOrderBinding(foreign, { taskId: TASK_ID });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(ORDER_BINDING.BINDING_TASK_ID_MISMATCH);
  });

  it("creates a binding when there is genuinely none", () => {
    const fresh = bindOrderOnce({ existing: null, comment: AUTHORIZING(), taskId: TASK_ID });
    expect(fresh.ok).toBe(true);
    expect(fresh.created).toBe(true);
    expect(fresh.binding.comment_id).toBe(String(ORDER_ID));
  });

  it("REFUSES to create one for a task that has ALREADY been admitted", () => {
    // `existing === null` means two different things and only the caller knows
    // which. A task that has run before HAD an order, so an absent binding for
    // it is a gap in OUR records - and filling that gap from the order that is
    // on the issue today is exactly the adoption this whole module forbids.
    const late = bindOrderOnce({
      existing: null, comment: AUTHORIZING(), taskId: TASK_ID, alreadyAdmitted: true
    });
    expect(late.ok).toBe(false);
    expect(late.created).toBe(false);
    expect(late.binding).toBe(null);
    expect(late.reason).toBe(ORDER_BINDING.BINDING_MISSING);
    expect(late.detail).toContain("will NOT be synthesised");
  });

  it("does not invent a created_at claim it never made", () => {
    // An API projection that omitted `created_at` bound no claim about it, so a
    // later read that HAS one is not a mismatch. The opposite rule would be a
    // false refusal - the other failure direction, but still a failure.
    const b = bindingFor(order({}, { createdAt: null }));
    expect(b.created_at).toBe(null);
    const v = verifyOrderAgainstBinding({
      binding: b, comment: order({}, { createdAt: "2026-09-20T00:00:00Z" }), taskId: TASK_ID
    });
    expect(v.ok).toBe(true);
  });
});

/* ==========================================================================
 * 3. THE CLASSIFICATION: zero is UNDECIDABLE, not NONE
 * ========================================================================== */

describe("D-149: a bound task never downgrades to an ordinary non-merge task", () => {
  it("THE HEADLINE CASE: the order is DELETED after admission", () => {
    // Under D-148 this returned NONE and the task retired on commit provenance
    // alone, with no transition proof, no required CI and no bound report.
    const before = classifyMergeAuthorization([], OPTS);
    expect(before.claim).toBe(MERGE_AUTHORIZATION.NONE);   // the old behaviour

    const claim = classifyBound([]);
    expectUndecidable(claim, ORDER_BINDING.ORDER_ABSENT);
    expect(claim.binding.expected_order_comment_id).toBe(String(ORDER_ID));
    expect(claim.binding.observed_order_comment_ids).toEqual([]);
    expect(claim.binding.control_comments_complete).toBe(true);
  });

  it("the order is REPLACED by one carrying a different TASK_ID", () => {
    const claim = classifyBound([order({}, { taskId: "D150-SOMETHING-ELSE-20260916-A", id: ORDER_ID + 9 })]);
    expectUndecidable(claim, ORDER_BINDING.ORDER_ABSENT);
    expect(claim.binding.observed_order_comment_ids).toEqual([]);
  });

  it("the order is REPLACED by a same-task order under a different comment id", () => {
    const claim = classifyBound([ORDINARY(), ].concat([]).map((c) => ({ ...c, id: ORDER_ID + 777 })));
    expectUndecidable(claim, ORDER_BINDING.COMMENT_ID_MISMATCH);
    expect(claim.binding.observed_order_comment_ids).toEqual([String(ORDER_ID + 777)]);
    // ...and specifically NOT read as "the order says false/false, so ordinary".
    expect(claim.claim).not.toBe(MERGE_AUTHORIZATION.NONE);
  });

  it("ONE BYTE of the order body changed", () => {
    const claim = classifyBound([order({ PR_NUMBER: "82" })]);
    expectUndecidable(claim, ORDER_BINDING.BODY_DIGEST_MISMATCH);
    expect(claim.binding.observed_order_body_digest).not.toBe(claim.binding.expected_order_body_digest);
    // The FINDING, not the content.
    expect(claim.detail).not.toContain("MERGE_AUTHORIZED");
    expect(claim.detail).toContain("sha256:");
  });

  it("the order body changed in a way that WIDENS the authority", () => {
    // The dangerous direction: admitted as false/false, now says true/true.
    const claim = classifyBound([AUTHORIZING()], { binding: bindingFor(ORDINARY()) });
    expectUndecidable(claim, ORDER_BINDING.BODY_DIGEST_MISMATCH);
  });

  it("the order's created_at changed under the same id", () => {
    const claim = classifyBound([order({}, { createdAt: "2026-09-16T00:00:00Z" })]);
    expectUndecidable(claim, ORDER_BINDING.CREATED_AT_MISMATCH);
  });

  it("the BINDING is missing, and the order is right there", () => {
    // The legacy-migration shape, and the most tempting one to "repair".
    const claim = classifyBound([AUTHORIZING()], { binding: null });
    expectUndecidable(claim, ORDER_BINDING.BINDING_MISSING);
    expect(claim.binding.order_binding_present).toBe(false);
    // The order IS observable - so this is provably a refusal to synthesise,
    // not a failure to look.
    expect(claim.binding.observed_order_comment_ids).toEqual([String(ORDER_ID)]);
  });

  it("the BINDING is structurally invalid", () => {
    for (const bad of [{}, { binding_version: 0 }, { binding_version: 1, task_id: TASK_ID, comment_id: null }]) {
      const claim = classifyBound([AUTHORIZING()], { binding: bad });
      expectUndecidable(claim);
      expect([ORDER_BINDING.BINDING_INVALID, ORDER_BINDING.BINDING_MISSING]).toContain(claim.reason);
    }
  });

  it("the binding's digest does not match its own recorded id (a tampered record)", () => {
    const tampered = { ...bindingFor(AUTHORIZING()), body_sha256: "0".repeat(64) };
    const claim = classifyBound([AUTHORIZING()], { binding: tampered });
    expectUndecidable(claim, ORDER_BINDING.BODY_DIGEST_MISMATCH);
  });

  it("the READ was not proven complete - even with the order present and matching", () => {
    // A partial page or a failed fetch. Everything is perfect in the data we DO
    // have, and it still holds, because the completeness of the set is what the
    // absence argument rests on and we cannot vouch for it.
    const claim = classifyBound([AUTHORIZING()], { complete: false });
    expectUndecidable(claim, ORDER_BINDING.COLLECTION_INCOMPLETE);
    expect(claim.binding.control_comments_complete).toBe(false);
  });

  it("the caller never ESTABLISHED completeness at all", () => {
    const claim = classifyBoundMergeAuthorization({
      comments: [AUTHORIZING()], binding: bindingFor(AUTHORIZING()), ...OPTS
      // commentsComplete deliberately omitted
    });
    expectUndecidable(claim, ORDER_BINDING.COLLECTION_INCOMPLETE);
    expect(claim.binding.control_comments_complete).toBe(null);
  });

  it("completeness is checked BEFORE the candidate set, so an incomplete read of "
    + "an empty issue is not 'deleted'", () => {
    // Two different findings, and the human does different things about each.
    expect(classifyBound([], { complete: false }).reason).toBe(ORDER_BINDING.COLLECTION_INCOMPLETE);
    expect(classifyBound([], { complete: true }).reason).toBe(ORDER_BINDING.ORDER_ABSENT);
  });

  it("D-148's duplicate and edit verdicts are preserved exactly", () => {
    const dup = classifyBound([AUTHORIZING(), order({}, { id: ORDER_ID + 1 })]);
    expectUndecidable(dup, MERGE_TRANSITION.AMBIGUOUS_AUTHORITY);

    const edited = classifyBound([order({}, { updatedAt: "2026-09-15T05:00:00Z" })]);
    expectUndecidable(edited, MERGE_TRANSITION.AUTHORITY_COMMENT_EDITED);
  });

  it("an overlapping pagination copy of the SAME comment is not ambiguity", () => {
    // The false-positive control, carried forward from D-148. `--paginate`
    // concatenates pages and an overlapping boundary repeats one comment
    // verbatim; refusing on that would fail every task on a transport artefact.
    const one = AUTHORIZING();
    const claim = classifyBound([one, { ...one }]);
    expect(claim.claim).toBe(MERGE_AUTHORIZATION.AUTHORIZED);
    expect(claim.binding.order_binding_verified).toBe(true);
    expect(claim.selection.candidate_count).toBe(1);
  });

  it("array order is not an input to ANY of it", () => {
    const shapes = [
      [AUTHORIZING(), order({}, { id: ORDER_ID + 1 })],
      [order({}, { taskId: "OTHER-TASK-20260916-A", id: 1 }), order({ PR_NUMBER: "82" })],
      [ORDINARY(), AUTHORIZING()]
    ];
    for (const list of shapes) {
      const fwd = classifyBound(list);
      const rev = classifyBound([...list].reverse());
      expect(rev.claim).toBe(fwd.claim);
      expect(rev.reason).toBe(fwd.reason);
    }
  });
});

/* ==========================================================================
 * 4. THE SEMANTICS THAT MUST NOT CHANGE
 * ========================================================================== */

describe("D-149 preserves the authorization semantics exactly", () => {
  it("a uniquely bound false/false order is ORDINARY non-merge", () => {
    const claim = classifyBound([ORDINARY()], { binding: bindingFor(ORDINARY()) });
    expect(claim.claim).toBe(MERGE_AUTHORIZATION.NONE);
    expect(claim.claimed).toBe(false);
    expect(claim.decidable).toBe(true);
    // NONE is reachable - but only from an order that is PRESENT, PROVEN and
    // MATCHING. That is the whole difference from before.
    expect(claim.binding.order_binding_verified).toBe(true);
    expect(claim.binding.expected_order_comment_id).toBe(String(ORDER_ID));
  });

  it("a uniquely bound true/true order is AUTHORIZED and still owes the transition", () => {
    const claim = classifyBound([AUTHORIZING()]);
    expect(claim.claim).toBe(MERGE_AUTHORIZATION.AUTHORIZED);
    expect(claim.authorization.ok).toBe(true);
    expect(claim.authorization.prNumber).toBe(81);
    expect(claim.authorization.expectedBase).toBe(BASE);
    expect(claim.authorization.expectedHead).toBe(HEAD);
    expect(claim.binding.order_binding_verified).toBe(true);

    // ...and the gate still REQUIRES the transition, with a perfect range behind it.
    const gate = evaluateCompletionGate({
      completion: { complete: true, successful: true, reportCommentId: 1, status: "COMPLETE" },
      provenance: { verdict: "task_attributed", verified: true, unattributed_commits: [], unattributed_count: 0 },
      worktree: { verdict: "clean", entry_count: 0, entries: [] },
      mergeTransition: { verified: false, reason: MERGE_TRANSITION.NOT_MERGED },
      mergeAuthorization: claim
    });
    expect(gate.held).toBe(true);
    expect(gate.reason).toBe(COMPLETION_GATE.HELD_MERGE_TRANSITION_UNVERIFIED);
  });

  it("a half-declared merge is still PARTIAL, not absent and not ordinary", () => {
    const partial = order({ MERGE_AUTHORIZED: "false" });
    const claim = classifyBound([partial], { binding: bindingFor(partial) });
    expectUndecidable(claim, MERGE_TRANSITION.MERGE_AUTHORIZATION_PARTIAL);
  });

  it("a bound order for ANOTHER repository is still a broken authorization", () => {
    const elsewhere = order({ REPO: "someone/else" });
    const claim = classifyBound([elsewhere], { binding: bindingFor(elsewhere) });
    expectUndecidable(claim, MERGE_TRANSITION.REPO_MISMATCH);
  });

  it("an UNTRUSTED author posting the bound comment id cannot satisfy the binding", () => {
    // The binding is checked only against candidates that already passed the
    // trust filter, so an impostor reusing the id is simply not a candidate -
    // which reads as ABSENT, and absent holds.
    const impostor = order({}, { author: "someone-else" });
    const claim = classifyBound([impostor]);
    expectUndecidable(claim, ORDER_BINDING.ORDER_ABSENT);
  });

  it("a CLAUDE_REPORT carrying the bound comment id is not an order", () => {
    const report = {
      id: ORDER_ID,
      created_at: CREATED,
      updated_at: CREATED,
      author_association: "OWNER",
      user: { login: TRUSTED },
      body: `CLAUDE_REPORT\nTASK_ID=${TASK_ID}\nSTATUS=COMPLETE\nMERGE_AUTHORIZED=true`
    };
    const claim = classifyBound([report]);
    expectUndecidable(claim, ORDER_BINDING.ORDER_ABSENT);
  });
});

/* ==========================================================================
 * 5. THE GATE AND THE EVIDENCE
 * ========================================================================== */

describe("D-149 gate evidence", () => {
  const SUCCESS = { complete: true, successful: true, reportCommentId: 5674999001, status: "COMPLETE" };
  const PERFECT_RANGE = {
    verdict: "task_attributed", verified: true, unattributed_commits: [], unattributed_count: 0
  };
  const CLEAN = { verdict: "clean", entry_count: 0, entries: [], path: "C:/wt/task" };

  function gateFor(claim) {
    return evaluateCompletionGate({
      completion: SUCCESS, provenance: PERFECT_RANGE, worktree: CLEAN, mergeAuthorization: claim
    });
  }

  it("HOLDS every binding failure, with a perfect range and a clean worktree", () => {
    const cases = [
      ["deleted", classifyBound([])],
      ["replaced", classifyBound([{ ...ORDINARY(), id: ORDER_ID + 5 }])],
      ["edited body", classifyBound([order({ PR_NUMBER: "82" })])],
      ["edited timestamp", classifyBound([order({}, { createdAt: "2026-09-16T00:00:00Z" })])],
      ["no binding", classifyBound([AUTHORIZING()], { binding: null })],
      ["unproven read", classifyBound([AUTHORIZING()], { complete: false })],
      ["duplicates", classifyBound([AUTHORIZING(), order({}, { id: ORDER_ID + 1 })])]
    ];
    for (const [name, claim] of cases) {
      const gate = gateFor(claim);
      expect(gate.held, name).toBe(true);
      expect(gate.reason, name).toBe(COMPLETION_GATE.HELD_MERGE_AUTHORIZATION_UNDECIDABLE);
      // The range verified. It did not help, and the record says so.
      expect(gate.provenance_verified, name).toBe(true);
      expect(gate.passed, name).toBe(false);
    }
  });

  it("records the expected id, the expected digest, the observed ids and the reason", () => {
    const gate = gateFor(classifyBound([{ ...ORDINARY(), id: ORDER_ID + 5 }]));
    expect(gate.order_binding_present).toBe(true);
    expect(gate.order_binding_verified).toBe(false);
    expect(gate.order_binding_reason).toBe(ORDER_BINDING.COMMENT_ID_MISMATCH);
    expect(gate.expected_order_comment_id).toBe(String(ORDER_ID));
    expect(gate.expected_order_created_at).toBe(CREATED);
    expect(gate.expected_order_body_digest).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(gate.expected_order_body_bytes).toBeGreaterThan(0);
    expect(gate.observed_order_comment_ids).toEqual([String(ORDER_ID + 5)]);
    expect(gate.order_bound_at).toBe("2026-09-15T04:40:00Z");
    expect(gate.control_comments_complete).toBe(true);
  });

  it("NEVER puts an order body into the evidence or the status comment", () => {
    for (const claim of [classifyBound([]), classifyBound([order({ PR_NUMBER: "82" })])]) {
      const gate = gateFor(claim);
      const serialised = JSON.stringify(gate);
      expect(serialised).not.toContain("ARCHITECT_MERGE_APPROVED");
      expect(serialised).not.toContain("EXPECTED_BASE_SHA");
      const text = describeCompletionGate({ taskId: TASK_ID, gate, worktreePath: "C:/wt/task" });
      expect(text).not.toContain("ARCHITECT_MERGE_APPROVED");
      expect(text).toContain("DURABLE ORDER BINDING");
    }
  });

  it("the status comment distinguishes a FAILED READ from a DELETED order", () => {
    const deleted = describeCompletionGate({ taskId: TASK_ID, gate: gateFor(classifyBound([])) });
    expect(deleted).toContain("NO trusted order for this TASK_ID");
    expect(deleted).toContain("proven complete: true");

    const unread = describeCompletionGate({
      taskId: TASK_ID, gate: gateFor(classifyBound([AUTHORIZING()], { complete: false }))
    });
    expect(unread).toContain("proven complete: false");
  });

  it("the status comment names the legacy-migration case explicitly", () => {
    const text = describeCompletionGate({
      taskId: TASK_ID, gate: gateFor(classifyBound([AUTHORIZING()], { binding: null }))
    });
    expect(text).toContain("DURABLE ORDER BINDING: ABSENT");
    expect(text).toContain("FRESH TASK_ID");
  });

  it("a PASSING ordinary task still records a verified binding", () => {
    const gate = gateFor(classifyBound([ORDINARY()], { binding: bindingFor(ORDINARY()) }));
    expect(gate.held).toBe(false);
    expect(gate.reason).toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
    expect(gate.order_binding_verified).toBe(true);
    expect(gate.expected_order_comment_id).toBe(String(ORDER_ID));
  });

  it("describeOrderBinding renders both directions without a body", () => {
    const ok = describeOrderBinding(classifyBound([AUTHORIZING()]).binding);
    expect(ok.join("\n")).toContain("VERIFIED");
    const bad = describeOrderBinding(classifyBound([]).binding);
    expect(bad.join("\n")).toContain("NOT VERIFIED");
    expect(bad.join("\n")).toContain("no trusted order for this task id");
    expect(bad.join("\n")).not.toContain("MERGE_AUTHORIZED");
  });

  it("orderBindingEvidence keeps completeness as a TRI-STATE", () => {
    expect(orderBindingEvidence({ collectionComplete: true }).control_comments_complete).toBe(true);
    expect(orderBindingEvidence({ collectionComplete: false }).control_comments_complete).toBe(false);
    expect(orderBindingEvidence({}).control_comments_complete).toBe(null);
    expect(orderBindingEvidence({ collectionComplete: "yes" }).control_comments_complete).toBe(null);
  });
});

/* ==========================================================================
 * 6. DURABILITY: the binding survives a restart and cannot be overwritten
 * ========================================================================== */

describe("D-149 state durability", () => {
  function tmp() {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-d149-state-"));
    return { dir, file: join(dir, "state.json"), bak: join(dir, "state.json.bak") };
  }

  it("survives an atomic save/load round trip byte for byte", () => {
    const { dir, file, bak } = tmp();
    try {
      const binding = bindingFor(AUTHORIZING());
      const state = {
        state_version: 2,
        tasks: { [TASK_ID]: { task_id: TASK_ID, status: TASK_STATUS.IN_PROGRESS, attempts: 1, architect_order: binding } },
        posted_status_keys: {},
        processed_task_ids: []
      };
      saveStateAtomic(file, state, bak, { schema: "worker" });
      const back = loadState(file, bak, { schema: "worker" });
      expect(back.state.tasks[TASK_ID].architect_order).toEqual(binding);
      // And it still verifies against the original order after the round trip.
      expect(verifyOrderAgainstBinding({
        binding: back.state.tasks[TASK_ID].architect_order, comment: AUTHORIZING(), taskId: TASK_ID
      }).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a RESUME reads the stored binding and cannot replace it", () => {
    const { dir, file, bak } = tmp();
    try {
      const original = bindingFor(AUTHORIZING());
      saveStateAtomic(file, {
        state_version: 2,
        tasks: { [TASK_ID]: { task_id: TASK_ID, status: TASK_STATUS.FAILED_RETRYABLE, attempts: 1, architect_order: original } },
        posted_status_keys: {},
        processed_task_ids: []
      }, bak, { schema: "worker" });

      const loaded = loadState(file, bak, { schema: "worker" }).state;
      const stored = loaded.tasks[TASK_ID].architect_order;

      // The order on the issue has since been replaced with a widening one.
      const attempt = bindOrderOnce({ existing: stored, comment: order({ PR_NUMBER: "82" }), taskId: TASK_ID });
      expect(attempt.ok).toBe(false);
      expect(attempt.created).toBe(false);
      expect(attempt.binding).toEqual(original);

      // Persisting whatever the resume produced must not have changed anything.
      saveStateAtomic(file, loaded, bak, { schema: "worker" });
      expect(loadState(file, bak, { schema: "worker" }).state.tasks[TASK_ID].architect_order).toEqual(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a CORRUPT binding makes the document invalid rather than being dropped", () => {
    // Silently dropping it would turn a BOUND task back into an UNBOUND one,
    // and unbound is the merely-recoverable case. Fail closed instead, so the
    // load falls back to the verified backup.
    const doc = {
      state_version: 2,
      tasks: { [TASK_ID]: { task_id: TASK_ID, status: TASK_STATUS.IN_PROGRESS, attempts: 1,
        architect_order: { binding_version: 1, task_id: TASK_ID, comment_id: 1, body_sha256: "nope" } } }
    };
    const verdict = classifyRawWorkerState(doc);
    expect(verdict.kind).toBe("invalid");
    expect(verdict.reason).toContain("v2_invalid_architect_order");
    expect(migrateState(doc).ok).toBe(false);
  });

  it("a binding belonging to a DIFFERENT task id is invalid state", () => {
    const doc = {
      state_version: 2,
      tasks: { [TASK_ID]: { task_id: TASK_ID, status: TASK_STATUS.IN_PROGRESS, attempts: 1,
        architect_order: { ...bindingFor(AUTHORIZING()), task_id: "SOMEONE-ELSES-TASK-20260916-A" } } }
    };
    expect(classifyRawWorkerState(doc).kind).toBe("invalid");
  });

  it("refuses to PERSIST a state whose binding would not load back", () => {
    const { dir, file, bak } = tmp();
    try {
      expect(() => saveStateAtomic(file, {
        state_version: 2,
        tasks: { [TASK_ID]: { task_id: TASK_ID, status: TASK_STATUS.IN_PROGRESS, attempts: 1,
          architect_order: { binding_version: 99, task_id: TASK_ID, comment_id: 1, body_sha256: "0".repeat(64) } } },
        posted_status_keys: {},
        processed_task_ids: []
      }, bak, { schema: "worker" })).toThrow(/would not load back/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers the LAST GOOD binding from the backup when the primary is corrupted", () => {
    const { dir, file, bak } = tmp();
    try {
      const binding = bindingFor(AUTHORIZING());
      const good = {
        state_version: 2,
        tasks: { [TASK_ID]: { task_id: TASK_ID, status: TASK_STATUS.IN_PROGRESS, attempts: 1, architect_order: binding } },
        posted_status_keys: {},
        processed_task_ids: []
      };
      saveStateAtomic(file, good, bak, { schema: "worker" });
      saveStateAtomic(file, { ...good, last_run_at: "2026-09-15T05:00:00Z" }, bak, { schema: "worker" });

      // Someone corrupts the binding in the primary.
      const raw = JSON.parse(readFileSync(file, "utf8"));
      raw.tasks[TASK_ID].architect_order.body_sha256 = "not-a-digest";
      writeFileSync(file, JSON.stringify(raw, null, 2), "utf8");

      const back = loadState(file, bak, { schema: "worker" });
      expect(back.recovered_from_backup).toBe(true);
      expect(back.state.tasks[TASK_ID].architect_order).toEqual(binding);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("MIGRATION marks a legacy in-progress record, and never infers NONE for it", () => {
    const migrated = migrateState({
      state_version: 2,
      tasks: {
        [TASK_ID]: { task_id: TASK_ID, status: TASK_STATUS.IN_PROGRESS, attempts: 2 },
        "D100-FINISHED-20260101-A": { task_id: "D100-FINISHED-20260101-A", status: TASK_STATUS.COMPLETED, attempts: 1 },
        "D101-NEVER-RAN-20260101-A": { task_id: "D101-NEVER-RAN-20260101-A", status: TASK_STATUS.PENDING, attempts: 0 }
      }
    });
    expect(migrated.ok).toBe(true);

    const legacy = migrated.state.tasks[TASK_ID];
    expect(legacy.architect_order).toBe(null);
    expect(legacy.architect_order_missing_at_migration).toBe(true);

    // A terminal task is never dispatched or gated again, so it is not marked.
    expect(migrated.state.tasks["D100-FINISHED-20260101-A"].architect_order_missing_at_migration).toBeUndefined();
    // Nor is a task that has never run: it will bind cleanly on its own admission.
    expect(migrated.state.tasks["D101-NEVER-RAN-20260101-A"].architect_order_missing_at_migration).toBeUndefined();

    // And the classification for the marked one HOLDS with a recoverable reason
    // rather than inferring that there was no order.
    const claim = classifyBound([AUTHORIZING()], { binding: legacy.architect_order });
    expectUndecidable(claim, ORDER_BINDING.BINDING_MISSING);
  });

  it("a v1 state migrates to terminal records with an explicit null binding", () => {
    const migrated = migrateState({ processed_task_ids: ["D001-ANCIENT-20250101-A"] });
    expect(migrated.ok).toBe(true);
    const rec = migrated.state.tasks["D001-ANCIENT-20250101-A"];
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.architect_order).toBe(null);
    expect(rec.architect_order_missing_at_migration).toBeUndefined();
  });
});

/* ==========================================================================
 * 7. THE READ ITSELF: a dropped page is not an empty issue
 * ========================================================================== */

describe("D-149: a paginated read reports its own completeness", () => {
  it("a single well-formed array is complete", () => {
    const r = parsePaginatedJsonDetailed(JSON.stringify([{ id: 1 }, { id: 2 }]));
    expect(r.complete).toBe(true);
    expect(r.items).toHaveLength(2);
  });

  it("concatenated pages are complete", () => {
    const r = parsePaginatedJsonDetailed(`${JSON.stringify([{ id: 1 }])}\n${JSON.stringify([{ id: 2 }])}`);
    expect(r.complete).toBe(true);
    expect(r.items.map((i) => i.id)).toEqual([1, 2]);
  });

  it("an EMPTY response is a PROVEN empty set, not a failure", () => {
    for (const text of ["", "   ", "\n"]) {
      const r = parsePaginatedJsonDetailed(text);
      expect(r.complete).toBe(true);
      expect(r.items).toEqual([]);
    }
  });

  it("a page that will not parse is INCOMPLETE, and says how many were lost", () => {
    // This is the exact shape that used to vanish silently: the old
    // `parsePaginatedJson` returned `[]` for the bad fragment and the caller saw
    // a short list it could not distinguish from a short issue.
    const text = `${JSON.stringify([{ id: 1 }])}\n[{"id": 2, "body": ]\n${JSON.stringify([{ id: 3 }])}`;
    const r = parsePaginatedJsonDetailed(text);
    expect(r.complete).toBe(false);
    expect(r.dropped_fragments).toBeGreaterThan(0);
    // Whatever DID parse is still returned - nothing is thrown away.
    expect(r.items.length).toBeGreaterThan(0);
  });

  it("a TRUNCATED tail is incomplete too, not silently ignored", () => {
    // The nastier half, and the one that slipped through the first attempt at
    // this function: an unterminated fragment never matches the page regex at
    // all, so counting only PARSE FAILURES declared the read complete while a
    // whole page had gone missing. The gap between recognised fragments is
    // measured instead.
    const r = parsePaginatedJsonDetailed(`${JSON.stringify([{ id: 1 }])}[{"id": 2, `);
    expect(r.complete).toBe(false);
    expect(r.items.map((i) => i.id)).toEqual([1]);
  });

  it("a wholly unreadable response is incomplete, never a proven empty set", () => {
    const r = parsePaginatedJsonDetailed("gh: HTTP 502 Bad Gateway");
    expect(r.complete).toBe(false);
    expect(r.items).toEqual([]);
  });

  it("an incomplete read reaching the classifier holds, however good its content", () => {
    const r = parsePaginatedJsonDetailed(`${JSON.stringify([AUTHORIZING()])}\n[{"broken"`);
    expect(r.complete).toBe(false);
    expect(r.items).toHaveLength(1);   // the order IS here, and it still holds
    const claim = classifyBound(r.items, { complete: r.complete });
    expectUndecidable(claim, ORDER_BINDING.COLLECTION_INCOMPLETE);
  });
});

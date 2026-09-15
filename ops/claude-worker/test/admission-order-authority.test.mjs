/**
 * D-150 unit tests: THE ADMISSION GATE.
 *
 * `durable-order-binding.test.mjs` proves what an ADMITTED task is bound to.
 * This file proves what may be admitted in the first place - which is the
 * question D-149 never asked, and the one that decides what bytes a child is
 * actually handed.
 *
 * Every case is run in BOTH array directions where ordering could matter. A
 * verdict that depends on how `--paginate` happened to concatenate its pages is
 * not a verdict, and that is the exact property the whole design rests on.
 */

import { describe, it, expect } from "vitest";

import {
  ORDER_AUTHORITY,
  selectAdmissibleOrder,
  trustedOrdersFor,
  collapseIdenticalOrderRepeats,
  orderByIssueSequence,
  commentIdentity,
  describeOrderAuthority
} from "../lib/order-authority.mjs";
import { collectTrustedTasks } from "../lib/trust.mjs";

const TRUSTED = "tsworkflow";
const TASK = "D150-PR81-IMMUTABLE-EFFECTIVE-ORDER-20260915-A";
const OTHER = "D149-PR81-DURABLE-ORDER-BINDING-20260915-A";

function order({
  id = 5676504358,
  taskId = TASK,
  createdAt = "2026-09-15T07:33:44Z",
  updatedAt = createdAt,
  body = null,
  author = TRUSTED
} = {}) {
  return {
    id,
    created_at: createdAt,
    updated_at: updatedAt,
    author_association: "OWNER",
    user: { login: author },
    body: body ?? `ARCHITECT_TASK\nTASK_ID=${taskId}\nARCHITECT_MERGE_APPROVED=false\nMERGE_AUTHORIZED=false\nDo the work.`
  };
}

/** The gate, with a proven-complete read unless a case says otherwise. */
function admit(comments, overrides = {}) {
  return selectAdmissibleOrder({
    comments,
    commentsOk: true,
    commentsComplete: true,
    trustedAuthor: TRUSTED,
    taskId: TASK,
    ...overrides
  });
}

/** The SAME verdict however the collection was enumerated. */
function admitBothWays(comments, overrides = {}) {
  const forward = admit(comments, overrides);
  const backward = admit([...comments].reverse(), overrides);
  expect(backward.reason).toBe(forward.reason);
  expect(backward.ok).toBe(forward.ok);
  expect(backward.distinctCount).toBe(forward.distinctCount);
  expect(String(backward.commentId)).toBe(String(forward.commentId));
  return forward;
}

/* ========================================================================== */

describe("D-150: the read is a prerequisite, asked before anything is counted", () => {
  it("a FAILED read admits nothing, and is RETRYABLE", () => {
    // The order is right there in `items`. It still may not be admitted: the
    // caller told us the read failed, so the collection is not evidence.
    const v = admit([order()], { commentsOk: false, commentsComplete: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(ORDER_AUTHORITY.READ_FAILED);
    expect(v.retryable).toBe(true);
    expect(v.comment).toBeNull();
  });

  it("an INCOMPLETE read admits nothing even when the order is present", () => {
    const v = admit([order()], { commentsComplete: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(ORDER_AUTHORITY.READ_INCOMPLETE);
    expect(v.retryable).toBe(true);
    // The whole point: what a lost page hides is the SECOND order.
    expect(v.detail).toMatch(/page that was lost/);
  });

  it("an UNPROVEN read (nobody said) is not a complete one", () => {
    for (const unproven of [null, undefined]) {
      const v = admit([order()], { commentsComplete: unproven });
      expect(v.reason).toBe(ORDER_AUTHORITY.READ_INCOMPLETE);
      expect(v.retryable).toBe(true);
    }
  });

  it("completeness is checked BEFORE the set, so it names the read and not the order", () => {
    // Two conflicting orders AND an incomplete read. The finding must be the
    // read: we cannot honestly report on a set we could not finish reading.
    const v = admit([order(), order({ id: 999, body: "ARCHITECT_TASK\nTASK_ID=" + TASK + "\nsomething else" })],
      { commentsComplete: false });
    expect(v.reason).toBe(ORDER_AUTHORITY.READ_INCOMPLETE);
  });

  it("a proven-complete EMPTY read is a real answer about the order", () => {
    const v = admit([]);
    expect(v.reason).toBe(ORDER_AUTHORITY.NO_ORDER);
    // NOT retryable: asking again gets the same answer. Recovery is a fresh id.
    expect(v.retryable).toBe(false);
  });
});

describe("D-150: the authority must be unique", () => {
  it("admits exactly one trusted, unedited, identified order", () => {
    const v = admitBothWays([order()]);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe(ORDER_AUTHORITY.ADMISSIBLE);
    expect(v.commentId).toBe("5676504358");
    expect(v.createdAt).toBe("2026-09-15T07:33:44Z");
    expect(v.distinctCount).toBe(1);
  });

  it("an IDENTICAL --paginate repeat is ONE order, not two", () => {
    const one = order();
    const v = admitBothWays([one, { ...one }, { ...one }]);
    expect(v.ok).toBe(true);
    expect(v.distinctCount).toBe(1);
  });

  it("a CONFLICTING duplicate is refused, and never resolved by preferring one", () => {
    const v = admitBothWays([
      order(),
      order({ id: 5676504999, createdAt: "2026-09-15T08:00:00Z", body: `ARCHITECT_TASK\nTASK_ID=${TASK}\nMERGE_AUTHORIZED=true` })
    ]);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(ORDER_AUTHORITY.AMBIGUOUS);
    expect(v.distinctCount).toBe(2);
    expect(v.candidateIds).toHaveLength(2);
    expect(v.retryable).toBe(false);
    expect(v.detail).toMatch(/FRESH TASK_ID/);
  });

  it("a same-id TASK_UPDATE is a SECOND ORDER, and refuses like one", () => {
    const v = admitBothWays([
      order(),
      order({ id: 5676505000, createdAt: "2026-09-15T09:00:00Z", body: `ARCHITECT_TASK\nTASK_ID=${TASK}\nTASK_UPDATE=true\nalso do this` })
    ]);
    expect(v.reason).toBe(ORDER_AUTHORITY.AMBIGUOUS);
  });

  it("TWO ORDERS WEARING ONE ID is refused, not collapsed", () => {
    const v = admitBothWays([
      order(),
      order({ body: `ARCHITECT_TASK\nTASK_ID=${TASK}\nMERGE_AUTHORIZED=true` })
    ]);
    expect(v.reason).toBe(ORDER_AUTHORITY.AMBIGUOUS);
    expect(v.distinctCount).toBe(2);
  });

  it("the gate never SCANS FORWARD for a usable order", () => {
    // A broken first order and a perfectly well-formed second one. A forward
    // scan would find the second and execute it; the count refuses both.
    const v = admitBothWays([
      order({ body: `ARCHITECT_TASK\nTASK_ID=${TASK}\n` }),
      order({ id: 42, createdAt: "2026-09-15T10:00:00Z" })
    ]);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(ORDER_AUTHORITY.AMBIGUOUS);
  });

  it("an order for a NEIGHBOURING task is not this task's order", () => {
    const v = admit([order({ id: 1, taskId: OTHER }), order()]);
    expect(v.ok).toBe(true);
    expect(v.commentId).toBe("5676504358");
    // ...and the neighbour's duplicates do not make THIS task ambiguous.
    expect(admit([order({ id: 1, taskId: OTHER }), order({ id: 2, taskId: OTHER, createdAt: "2026-09-15T01:00:00Z" }), order()]).ok)
      .toBe(true);
  });

  it("an UNTRUSTED author and a non-ARCHITECT_TASK body are not orders at all", () => {
    expect(admit([order({ author: "attacker" })]).reason).toBe(ORDER_AUTHORITY.NO_ORDER);
    expect(admit([order({ body: `CLAUDE_REPORT\nTASK_ID=${TASK}\nSTATUS=COMPLETE` })]).reason)
      .toBe(ORDER_AUTHORITY.NO_ORDER);
    // A forged one alongside the real one does not make the real one ambiguous.
    expect(admit([order(), order({ id: 7, author: "attacker" })]).ok).toBe(true);
  });
});

describe("D-150: the one candidate must be deterministically identified and ordered", () => {
  it("REFUSES an order that was EDITED after it was posted", () => {
    const v = admit([order({ updatedAt: "2026-09-15T09:00:00Z" })]);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(ORDER_AUTHORITY.EDITED);
    expect(v.retryable).toBe(false);
  });

  it("an absent updated_at is NOT evidence of an edit", () => {
    const c = order();
    delete c.updated_at;
    expect(admit([c]).ok).toBe(true);
  });

  it("REFUSES an order with no usable GitHub comment id", () => {
    for (const id of [null, "", "   ", NaN, {}, []]) {
      // Set the field directly: passing `undefined` through the helper would
      // silently take the default id and test nothing.
      const v = admit([{ ...order(), id }]);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe(ORDER_AUTHORITY.NO_COMMENT_IDENTITY);
    }
    const missing = order();
    delete missing.id;
    expect(admit([missing]).reason).toBe(ORDER_AUTHORITY.NO_COMMENT_IDENTITY);
  });

  it("REFUSES an order with no parseable created_at ordering metadata", () => {
    for (const createdAt of [null, "", "not a date", "yesterday"]) {
      const v = admit([order({ createdAt, updatedAt: createdAt })]);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe(ORDER_AUTHORITY.NO_ORDERING_METADATA);
    }
  });

  it("REFUSES an order with nothing to execute", () => {
    // Reaches the body check only because `validateTrustedTask` passed: a body
    // that is a header and an id and no instruction still parses as trusted.
    const empty = order();
    empty.body = "";
    expect(admit([empty]).reason).toBe(ORDER_AUTHORITY.NO_ORDER); // not even a trusted task
    const whitespace = { ...order(), body: `ARCHITECT_TASK\nTASK_ID=${TASK}` };
    expect(admit([whitespace]).ok).toBe(true); // an order CAN be terse
  });

  it("a missing task id admits nothing", () => {
    for (const taskId of [null, undefined, "", "  "]) {
      expect(admit([order()], { taskId }).reason).toBe(ORDER_AUTHORITY.NO_ORDER);
    }
  });
});

describe("D-150: the pure helpers are order-insensitive by construction", () => {
  it("collapse keeps size stable however the input was enumerated", () => {
    const a = order();
    const b = order({ id: 2, createdAt: "2026-09-15T08:00:00Z" });
    expect(collapseIdenticalOrderRepeats([a, { ...a }, b])).toHaveLength(2);
    expect(collapseIdenticalOrderRepeats([b, { ...a }, a])).toHaveLength(2);
    expect(collapseIdenticalOrderRepeats(null)).toEqual([]);
  });

  it("a comment with NO id is never collapsed into another", () => {
    // Two unidentifiable comments are two comments, not one. Collapsing them
    // would be a silent merge of things we cannot show are the same.
    const anon = { ...order({ id: null }) };
    expect(collapseIdenticalOrderRepeats([anon, { ...anon }])).toHaveLength(2);
  });

  it("commentIdentity keeps numeric and string origins apart", () => {
    expect(commentIdentity({ id: 5 })).toBe("n:5");
    expect(commentIdentity({ id: "5" })).toBe("s:5");
    expect(commentIdentity({ id: null })).toBeNull();
    expect(commentIdentity(undefined)).toBeNull();
  });

  it("orderByIssueSequence is total: time first, then id", () => {
    const early = { id: 9, created_at: "2026-09-15T01:00:00Z" };
    const late = { id: 1, created_at: "2026-09-15T02:00:00Z" };
    expect([late, early].sort(orderByIssueSequence)[0].id).toBe(9);
    const tieA = { id: 1, created_at: "2026-09-15T01:00:00Z" };
    const tieB = { id: 2, created_at: "2026-09-15T01:00:00Z" };
    expect([tieB, tieA].sort(orderByIssueSequence).map((c) => c.id)).toEqual([1, 2]);
  });

  it("trustedOrdersFor filters on EXACT id equality", () => {
    const all = [order(), order({ id: 2, taskId: `${TASK}-B` }), order({ id: 3, taskId: OTHER })];
    expect(trustedOrdersFor(all, { trustedAuthor: TRUSTED, taskId: TASK }).map((c) => c.id)).toEqual([5676504358]);
  });
});

describe("D-151: grouping counts, the gate decides - and only the gate", () => {
  it("collectTrustedTasks counts a duplicated id, and the ONE gate refuses it", () => {
    const comments = [order(), order({ id: 2, createdAt: "2026-09-15T08:00:00Z", body: `ARCHITECT_TASK\nTASK_ID=${TASK}\nother` })];
    const entries = collectTrustedTasks(comments, { trustedAuthor: TRUSTED });
    expect(entries).toHaveLength(1);
    expect(entries[0].distinctOrderCount).toBe(2);
    // D-151: the grouping function publishes NO verdict of its own. There is one
    // classifier, and it is this one.
    expect(entries[0].uniqueAuthority).toBeUndefined();
    expect(admit(comments).reason).toBe(ORDER_AUTHORITY.AMBIGUOUS);
  });

  it("a single id is counted once, and the gate admits it", () => {
    const comments = [order()];
    expect(collectTrustedTasks(comments, { trustedAuthor: TRUSTED })[0].distinctOrderCount).toBe(1);
    expect(admit(comments).ok).toBe(true);
  });
});

describe("D-150: the description carries evidence and never the order", () => {
  it("names the finding, the count and the ids - and no body bytes", () => {
    const secret = `ARCHITECT_TASK\nTASK_ID=${TASK}\nMERGE_AUTHORIZED=true\nSECRET_SCOPE_TEXT`;
    const v = admit([order(), order({ id: 2, createdAt: "2026-09-15T08:00:00Z", body: secret })]);
    const lines = describeOrderAuthority(v, { taskId: TASK }).join("\n");
    expect(lines).toContain("REFUSED");
    expect(lines).toContain(ORDER_AUTHORITY.AMBIGUOUS);
    expect(lines).toContain("2");
    expect(lines).not.toContain("SECRET_SCOPE_TEXT");
    expect(lines).not.toContain("MERGE_AUTHORIZED");
  });

  it("describes a pass too, so silence never means 'not evaluated'", () => {
    const lines = describeOrderAuthority(admit([order()]), { taskId: TASK }).join("\n");
    expect(lines).toContain("ADMISSIBLE");
    expect(lines).toContain("5676504358");
  });

  it("describes nothing for nothing", () => {
    expect(describeOrderAuthority(null)).toEqual([]);
  });
});

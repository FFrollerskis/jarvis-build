/**
 * D-151 unit tests: ONE COMPLETE, IMMUTABLE AUTHORITY SNAPSHOT PER CYCLE.
 *
 * The rule under test:
 *
 *     A WORKER CYCLE DECIDES FROM ONE COMPLETE, IMMUTABLE SNAPSHOT, OR IT
 *     DECIDES NOTHING.
 *
 * These are the PURE half - the snapshot's own findings and the shape it hands
 * downstream. The claims about EFFECTS (no retirement, no worktree, no prompt, no
 * child) belong to `worker-authority-snapshot.test.mjs`, which drives the real
 * `worker.mjs run` entrypoint, because a claim about things that did not happen
 * can only be checked against the things that would exist if they had.
 */

import { describe, it, expect } from "vitest";

import {
  AUTHORITY_SNAPSHOT,
  authoritySnapshotEvidence,
  authorityVerdicts,
  captureAuthoritySnapshot,
  describeAuthoritySnapshot
} from "../lib/authority-snapshot.mjs";
import { ORDER_AUTHORITY } from "../lib/order-authority.mjs";

const TRUSTED = "tsworkflow";
const TASK = "D151-PR81-ATOMIC-AUTHORITY-SNAPSHOT-20260915-A";
const OTHER = "D151-ORDINARY-20260915-B";

function order({
  taskId = TASK,
  id = 5677099821,
  createdAt = "2026-09-15T08:24:49Z",
  updatedAt = undefined,
  body = null,
  author = TRUSTED
} = {}) {
  const comment = {
    id,
    created_at: createdAt,
    author_association: "OWNER",
    user: { login: author },
    body: body ?? `ARCHITECT_TASK\nTASK_ID=${taskId}\nEXPECTED_HEAD_SHA=67b3084\nDo the work.`
  };
  if (updatedAt !== undefined) comment.updated_at = updatedAt;
  return comment;
}

const capture = (control) => captureAuthoritySnapshot({ control, trustedAuthor: TRUSTED });
const complete = (items) => capture({ ok: true, complete: true, items });

/* ==========================================================================
 * 1. THE READ DECIDES WHETHER ANYTHING MAY BE DECIDED
 * ========================================================================== */

describe("D-151: an unproven read yields a snapshot that decides nothing", () => {
  it("a FAILED read is READ_FAILED, retryable, and carries no entries at all", () => {
    const snap = capture({ ok: false, items: [], complete: false, error: "gh: HTTP 503" });
    expect(snap.ok).toBe(false);
    expect(snap.reason).toBe(AUTHORITY_SNAPSHOT.READ_FAILED);
    expect(snap.retryable).toBe(true);
    expect(snap.readOk).toBe(false);
    expect(snap.entries).toEqual([]);
    expect(snap.taskIds).toEqual([]);
  });

  it("an INCOMPLETE read is refused even though the order is plainly in `items`", () => {
    // The whole point. The array looks perfect; the page we lost is exactly where
    // a second same-id order would be.
    const snap = capture({ ok: true, complete: false, items: [order()], dropped_fragments: 1 });
    expect(snap.ok).toBe(false);
    expect(snap.reason).toBe(AUTHORITY_SNAPSHOT.READ_INCOMPLETE);
    expect(snap.retryable).toBe(true);
    expect(snap.readOk).toBe(true);
    expect(snap.entries).toEqual([]);
    expect(snap.authorityFor(TASK)).toBeNull();
  });

  it("a BARE ARRAY is READ_UNPROVEN - accepted as input, never as evidence", () => {
    const snap = capture([order()]);
    expect(snap.ok).toBe(false);
    expect(snap.reason).toBe(AUTHORITY_SNAPSHOT.READ_UNPROVEN);
    expect(snap.entries).toEqual([]);
  });

  it("a result that never states `complete` is READ_UNPROVEN, not assumed complete", () => {
    expect(capture({ ok: true, items: [order()] }).reason).toBe(AUTHORITY_SNAPSHOT.READ_UNPROVEN);
    expect(capture({ ok: true, items: [order()], complete: "yes" }).reason)
      .toBe(AUTHORITY_SNAPSHOT.READ_UNPROVEN);
  });

  it("nothing at all is READ_UNPROVEN rather than an empty success", () => {
    expect(capture(null).ok).toBe(false);
    expect(capture(undefined).reason).toBe(AUTHORITY_SNAPSHOT.READ_UNPROVEN);
    expect(capture({ ok: true, complete: true }).reason).toBe(AUTHORITY_SNAPSHOT.READ_UNPROVEN);
  });

  it("the refusal detail never contains order text", () => {
    const secret = `ARCHITECT_TASK\nTASK_ID=${TASK}\nMERGE_AUTHORIZED=true\nSECRET_SCOPE_TEXT`;
    const snap = capture({ ok: true, complete: false, items: [order({ body: secret })] });
    expect(JSON.stringify(snap.detail)).not.toContain("SECRET_SCOPE_TEXT");
    expect(describeAuthoritySnapshot(snap).join("\n")).not.toContain("SECRET_SCOPE_TEXT");
  });
});

/* ==========================================================================
 * 2. AUTHORITY IS CLASSIFIED ONCE, FOR EVERY TASK ID
 * ========================================================================== */

describe("D-151: every task id in the snapshot is classified by the one classifier", () => {
  it("classifies EVERY id, not just the one a caller happens to ask about", () => {
    const snap = complete([order(), order({ taskId: OTHER, id: 2, createdAt: "2026-09-15T09:00:00Z" })]);
    expect(snap.ok).toBe(true);
    // Copied before sorting on purpose: the snapshot's own arrays are frozen.
    expect([...snap.taskIds].sort()).toEqual([OTHER, TASK].sort());
    expect([...snap.admissibleTaskIds].sort()).toEqual([OTHER, TASK].sort());
    expect(snap.entries.every((e) => e.authority.reason === ORDER_AUTHORITY.ADMISSIBLE)).toBe(true);
  });

  it("an ADMISSIBLE entry carries the proven order and its identity", () => {
    const comment = order();
    const entry = complete([comment]).entryFor(TASK);
    expect(entry.admissible).toBe(true);
    expect(entry.order).toBe(comment);
    expect(entry.comment).toBe(comment);
    expect(entry.orderCommentId).toBe("5677099821");
    expect(entry.orderCreatedAt).toBe("2026-09-15T08:24:49Z");
    expect(entry.distinctOrderCount).toBe(1);
  });

  for (const [name, comments, reason] of [
    ["a duplicate same-id order", [order(), order({ id: 2, createdAt: "2026-09-15T09:00:00Z", body: `ARCHITECT_TASK\nTASK_ID=${TASK}\nother scope` })], ORDER_AUTHORITY.AMBIGUOUS],
    ["an EDITED order", [order({ updatedAt: "2026-09-15T10:00:00Z" })], ORDER_AUTHORITY.EDITED],
    ["no usable comment id", [order({ id: null })], ORDER_AUTHORITY.NO_COMMENT_IDENTITY],
    ["no parseable created_at", [order({ createdAt: "whenever" })], ORDER_AUTHORITY.NO_ORDERING_METADATA]
  ]) {
    it(`an INADMISSIBLE entry (${name}) carries NO order, NO comment and NO identity`, () => {
      const entry = complete(comments).entryFor(TASK);
      expect(entry.admissible).toBe(false);
      expect(entry.authority.reason).toBe(reason);
      // THE STRUCTURAL GUARANTEE: every downstream reader of an order's semantics
      // reads `null` here and fails closed by construction, not by remembering to
      // check a flag first.
      expect(entry.order).toBeNull();
      expect(entry.comment).toBeNull();
      expect(entry.orderCommentId).toBeNull();
      expect(entry.orderCreatedAt).toBeNull();
    });
  }

  it("an inadmissible entry still carries candidate IDS - a refusal must be checkable", () => {
    const entry = complete([
      order(),
      order({ id: 2, createdAt: "2026-09-15T09:00:00Z", body: `ARCHITECT_TASK\nTASK_ID=${TASK}\nother` })
    ]).entryFor(TASK);
    expect(entry.candidateCommentIds).toEqual([5677099821, 2]);
    expect(entry.distinctOrderCount).toBe(2);
  });

  it("a provably identical overlapping-page copy is ONE order, not ambiguity", () => {
    const comment = order();
    const entry = complete([comment, { ...comment }]).entryFor(TASK);
    expect(entry.admissible).toBe(true);
    expect(entry.distinctOrderCount).toBe(1);
  });

  it("an untrusted author is not in the snapshot at all", () => {
    expect(complete([order({ author: "attacker" })]).taskIds).toEqual([]);
  });

  it("one refused id does not affect another id's verdict", () => {
    const snap = complete([
      order(),
      order({ id: 2, createdAt: "2026-09-15T09:00:00Z", body: `ARCHITECT_TASK\nTASK_ID=${TASK}\nsecond order` }),
      order({ taskId: OTHER, id: 3, createdAt: "2026-09-15T09:30:00Z" })
    ]);
    expect(snap.inadmissibleTaskIds).toEqual([TASK]);
    expect(snap.admissibleTaskIds).toEqual([OTHER]);
    expect(snap.entryFor(OTHER).admissible).toBe(true);
  });
});

/* ==========================================================================
 * 3. THE SNAPSHOT IS IMMUTABLE
 * ========================================================================== */

describe("D-151: the snapshot cannot be edited after it is captured", () => {
  it("the snapshot, its comment list and its entries are frozen", () => {
    const snap = complete([order()]);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.comments)).toBe(true);
    expect(Object.isFrozen(snap.entries)).toBe(true);
    expect(Object.isFrozen(snap.entries[0])).toBe(true);
    expect(() => { snap.entries[0].admissible = true; }).toThrow();
    expect(() => { snap.complete = false; }).toThrow();
  });

  it("mutating the caller's array afterwards does not change the snapshot", () => {
    const items = [order()];
    const snap = complete(items);
    items.push(order({ id: 2, createdAt: "2026-09-15T09:00:00Z", body: `ARCHITECT_TASK\nTASK_ID=${TASK}\nsecond` }));
    expect(snap.commentCount).toBe(1);
    expect(snap.entryFor(TASK).admissible).toBe(true);
  });
});

/* ==========================================================================
 * 4. THE EVIDENCE AN OPERATOR READS
 * ========================================================================== */

describe("D-151: snapshot evidence is complete, auditable and body-free", () => {
  it("evidence names the read, the counts and every id on both sides", () => {
    const snap = complete([
      order(),
      order({ id: 2, createdAt: "2026-09-15T09:00:00Z", body: `ARCHITECT_TASK\nTASK_ID=${TASK}\nsecond` }),
      order({ taskId: OTHER, id: 3, createdAt: "2026-09-15T09:30:00Z" })
    ]);
    expect(authoritySnapshotEvidence(snap)).toMatchObject({
      snapshot_usable: true,
      control_read_ok: true,
      control_comments_complete: true,
      control_comment_count: 3,
      admissible_task_ids: [OTHER],
      inadmissible_task_ids: [TASK]
    });
  });

  it("evidence for a refused snapshot says so positively, with nothing admitted", () => {
    expect(authoritySnapshotEvidence(capture({ ok: true, complete: false, items: [order()] })))
      .toMatchObject({
        snapshot_usable: false,
        snapshot_reason: AUTHORITY_SNAPSHOT.READ_INCOMPLETE,
        control_comments_complete: false,
        admissible_task_ids: [],
        inadmissible_task_ids: []
      });
  });

  it("per-order verdicts name the finding and the candidate ids, never the body", () => {
    const secret = `ARCHITECT_TASK\nTASK_ID=${TASK}\nSECRET_SCOPE_TEXT`;
    const snap = complete([order(), order({ id: 2, createdAt: "2026-09-15T09:00:00Z", body: secret })]);
    const verdicts = authorityVerdicts(snap);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      task_id: TASK,
      admissible: false,
      reason: ORDER_AUTHORITY.AMBIGUOUS,
      distinct_order_count: 2,
      order_comment_id: null
    });
    expect(JSON.stringify(verdicts)).not.toContain("SECRET_SCOPE_TEXT");
  });

  it("the human description states the refusal and that nothing was decided", () => {
    const lines = describeAuthoritySnapshot(capture({ ok: true, complete: false, items: [order()] })).join("\n");
    expect(lines).toContain("REFUSED");
    expect(lines).toContain(AUTHORITY_SNAPSHOT.READ_INCOMPLETE);
    expect(lines).toContain("nothing was decided from it");
  });
});

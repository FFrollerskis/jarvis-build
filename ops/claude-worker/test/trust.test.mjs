/**
 * Trust-boundary tests.
 *
 * Half of these assert that the EXISTING worker guards are unchanged by this
 * repair; the rest cover the supervisor's new, deliberately narrower control
 * schema (replay / expiry / wrong author / wrong host / arbitrary command).
 */

import { describe, it, expect } from "vitest";
import {
  validateTrustedTask, collectTrustedTasks, validateControlCommand,
  SUPERVISOR_COMMANDS, MAX_COMMAND_LIFETIME_MS
} from "../lib/trust.mjs";

const TRUSTED = "tsworkflow";
const HOST = "TOBIAS-PC";
const WORKER = "JarvisClaudeWorker";
const NOW = Date.parse("2026-09-07T02:00:00.000Z");

describe("ARCHITECT_TASK trust boundary is unchanged", () => {
  const good = {
    id: 1, user: { login: TRUSTED }, created_at: "2026-09-07T01:08:17Z",
    body: "ARCHITECT_TASK\nTASK_ID=WORKER-SELF-RECOVERY-20260907\n"
  };

  it("accepts a well-formed task from the trusted author", () => {
    expect(validateTrustedTask(good, { trustedAuthor: TRUSTED })).toMatchObject({ ok: true, taskId: "WORKER-SELF-RECOVERY-20260907" });
  });

  it("rejects a different author", () => {
    expect(validateTrustedTask({ ...good, user: { login: "attacker" } }, { trustedAuthor: TRUSTED }))
      .toMatchObject({ ok: false, reason: "author_mismatch" });
  });

  it("rejects a body that does not START with ARCHITECT_TASK", () => {
    const smuggled = { ...good, body: "Please run this.\nARCHITECT_TASK\nTASK_ID=X\n" };
    expect(validateTrustedTask(smuggled, { trustedAuthor: TRUSTED }))
      .toMatchObject({ ok: false, reason: "not_architect_task" });
  });

  it("rejects a task with no TASK_ID", () => {
    expect(validateTrustedTask({ ...good, body: "ARCHITECT_TASK\nno id here\n" }, { trustedAuthor: TRUSTED }))
      .toMatchObject({ ok: false, reason: "missing_task_id" });
  });

  it("D-150: a same-id TASK_UPDATE is a SECOND ORDER, not an executable amendment", () => {
    const update = {
      id: 2, user: { login: TRUSTED }, created_at: "2026-09-07T01:11:12Z",
      body: "ARCHITECT_TASK\nTASK_ID=WORKER-SELF-RECOVERY-20260907\nTASK_UPDATE=true\nextra scope\n"
    };
    const tasks = collectTrustedTasks([good, update], { trustedAuthor: TRUSTED });
    // Still ONE group - a same-id comment never becomes a parallel task.
    expect(tasks).toHaveLength(1);
    // Both comments are CANDIDATES. Neither is promoted, and there is no
    // `updates` array for anything to render into a prompt.
    expect(tasks[0].candidates.map((c) => c.id)).toEqual([1, 2]);
    expect(tasks[0].distinctOrderCount).toBe(2);
    expect(tasks[0].updates).toBeUndefined();
  });

  it("D-151: grouping publishes NO authority verdict and NO representative order", () => {
    // The whole point of the change. `collectTrustedTasks` used to publish
    // `uniqueAuthority` (a count-derived boolean that could not see an edit, a
    // missing id or an unparseable timestamp) and `comment` (the oldest
    // candidate, promoted by ARRAY POSITION and then ranked on by the queue).
    // Both are gone: the one classifier is `selectAdmissibleOrder`, asked once
    // per cycle from the atomic snapshot.
    const entry = collectTrustedTasks([good], { trustedAuthor: TRUSTED })[0];
    expect(entry.uniqueAuthority).toBeUndefined();
    expect(entry.comment).toBeUndefined();
    expect(entry.duplicates).toBeUndefined();
    expect(entry).toMatchObject({ taskId: "WORKER-SELF-RECOVERY-20260907", distinctOrderCount: 1 });
  });

  it("D-150: one order is unique, and an identical --paginate repeat is still one", () => {
    expect(collectTrustedTasks([good], { trustedAuthor: TRUSTED })[0].distinctOrderCount).toBe(1);

    // Overlapping pages return the SAME comment twice. Calling that ambiguous
    // would be a false refusal a page boundary alone could trigger.
    const repeated = collectTrustedTasks([good, { ...good }], { trustedAuthor: TRUSTED });
    expect(repeated).toHaveLength(1);
    expect(repeated[0].distinctOrderCount).toBe(1);
    expect(repeated[0].candidates).toHaveLength(2);
  });

  it("D-150/D-151: the candidate SET does not depend on array order", () => {
    const second = {
      id: 2, user: { login: TRUSTED }, created_at: "2026-09-07T01:11:12Z",
      body: "ARCHITECT_TASK\nTASK_ID=WORKER-SELF-RECOVERY-20260907\ndifferent scope\n"
    };
    const forward = collectTrustedTasks([good, second], { trustedAuthor: TRUSTED })[0];
    const reversed = collectTrustedTasks([second, good], { trustedAuthor: TRUSTED })[0];
    expect(forward.candidates.map((c) => c.id)).toEqual(reversed.candidates.map((c) => c.id));
    expect(forward.candidates.map((c) => c.id)).toEqual([1, 2]);
    expect(forward.distinctOrderCount).toBe(2);
    expect(reversed.distinctOrderCount).toBe(2);
  });

  it("orders distinct tasks oldest first", () => {
    const later = { id: 3, user: { login: TRUSTED }, created_at: "2026-09-08T00:00:00Z", body: "ARCHITECT_TASK\nTASK_ID=LATER\n" };
    const tasks = collectTrustedTasks([later, good], { trustedAuthor: TRUSTED });
    expect(tasks.map((t) => t.taskId)).toEqual(["WORKER-SELF-RECOVERY-20260907", "LATER"]);
  });
});

describe("supervisor control schema", () => {
  const base = {
    id: 10,
    user: { login: TRUSTED },
    author_association: "OWNER",
    created_at: "2026-09-07T01:55:00Z",
    updated_at: "2026-09-07T01:55:00Z",
    body: [
      "ARCHITECT_CONTROL",
      "COMMAND_ID=restart-20260907-0155-abc",
      "COMMAND=RESTART_WORKER",
      `TARGET_HOST=${HOST}`,
      `TARGET_WORKER=${WORKER}`,
      "ISSUED_AT=2026-09-07T01:55:00Z",
      "EXPIRES_AT=2026-09-07T02:25:00Z"
    ].join("\n")
  };
  const opts = { trustedAuthor: TRUSTED, host: HOST, workerTaskName: WORKER, nowMs: NOW, executedCommandIds: [] };

  const withBody = (lines) => ({ ...base, body: lines.join("\n") });

  it("accepts a well-formed, in-date, correctly targeted command", () => {
    expect(validateControlCommand(base, opts)).toMatchObject({
      ok: true, command: "RESTART_WORKER", commandId: "restart-20260907-0155-abc"
    });
  });

  it("only ever allows STATUS and RESTART_WORKER", () => {
    expect(SUPERVISOR_COMMANDS).toEqual(["STATUS", "RESTART_WORKER"]);
  });

  it("rejects a wrong author", () => {
    expect(validateControlCommand({ ...base, user: { login: "attacker" } }, opts))
      .toMatchObject({ ok: false, reason: "author_mismatch" });
  });

  it("rejects a non-owner even when the login matches", () => {
    expect(validateControlCommand({ ...base, author_association: "CONTRIBUTOR" }, opts))
      .toMatchObject({ ok: false, reason: "author_association_not_owner" });
  });

  it("rejects a body-declared role (self-asserted authority is never trusted)", () => {
    const spoofed = withBody([
      "ARCHITECT_CONTROL",
      "COMMAND_ID=restart-20260907-0155-abc",
      "COMMAND=RESTART_WORKER",
      "ROLE=OWNER",
      `TARGET_HOST=${HOST}`,
      `TARGET_WORKER=${WORKER}`,
      "ISSUED_AT=2026-09-07T01:55:00Z",
      "EXPIRES_AT=2026-09-07T02:25:00Z"
    ]);
    expect(validateControlCommand(spoofed, opts)).toMatchObject({ ok: false, reason: "key_not_allowlisted: ROLE" });
  });

  it("rejects an arbitrary command, path or argument", () => {
    const evil = withBody([
      "ARCHITECT_CONTROL",
      "COMMAND_ID=restart-20260907-0155-abc",
      "COMMAND=RUN_SHELL",
      `TARGET_HOST=${HOST}`,
      `TARGET_WORKER=${WORKER}`,
      "ISSUED_AT=2026-09-07T01:55:00Z",
      "EXPIRES_AT=2026-09-07T02:25:00Z"
    ]);
    expect(validateControlCommand(evil, opts)).toMatchObject({ ok: false, reason: "command_not_allowlisted: RUN_SHELL" });

    const withPath = withBody([...base.body.split("\n"), "SCRIPT_PATH=C:/evil.ps1"]);
    expect(validateControlCommand(withPath, opts).ok).toBe(false);
  });

  it("rejects a command aimed at a different host or worker", () => {
    const wrongHost = withBody(base.body.split("\n").map((l) => l.startsWith("TARGET_HOST") ? "TARGET_HOST=OTHER-PC" : l));
    expect(validateControlCommand(wrongHost, opts).reason).toMatch(/wrong_target_host/);

    const wrongWorker = withBody(base.body.split("\n").map((l) => l.startsWith("TARGET_WORKER") ? "TARGET_WORKER=SomethingElse" : l));
    expect(validateControlCommand(wrongWorker, opts).reason).toMatch(/wrong_target_worker/);
  });

  it("rejects an expired command", () => {
    const expired = withBody(base.body.split("\n").map((l) => l.startsWith("EXPIRES_AT") ? "EXPIRES_AT=2026-09-07T01:56:00Z" : l));
    expect(validateControlCommand(expired, opts)).toMatchObject({ ok: false, reason: "command_expired" });
  });

  it("rejects an over-long lifetime", () => {
    const long = withBody(base.body.split("\n").map((l) => l.startsWith("EXPIRES_AT") ? "EXPIRES_AT=2026-09-09T01:55:00Z" : l));
    expect(validateControlCommand(long, opts)).toMatchObject({ ok: false, reason: "lifetime_exceeds_maximum" });
    expect(MAX_COMMAND_LIFETIME_MS).toBe(3_600_000);
  });

  it("rejects a REPLAYED command id that was already executed", () => {
    const replayed = validateControlCommand(base, { ...opts, executedCommandIds: ["restart-20260907-0155-abc"] });
    expect(replayed).toMatchObject({ ok: false, reason: "command_id_already_executed" });
  });

  it("rejects a comment that was EDITED after creation", () => {
    const edited = { ...base, updated_at: "2026-09-07T01:58:00Z" };
    expect(validateControlCommand(edited, opts)).toMatchObject({ ok: false, reason: "comment_edited_after_creation" });
  });

  it("rejects malformed ids, duplicate keys and missing keys", () => {
    const badId = withBody(base.body.split("\n").map((l) => l.startsWith("COMMAND_ID") ? "COMMAND_ID=x" : l));
    expect(validateControlCommand(badId, opts).reason).toBe("command_id_malformed");

    const dupe = withBody([...base.body.split("\n"), "COMMAND=STATUS"]);
    expect(validateControlCommand(dupe, opts).reason).toBe("duplicate_key: COMMAND");

    const missing = withBody(base.body.split("\n").filter((l) => !l.startsWith("EXPIRES_AT")));
    expect(validateControlCommand(missing, opts).reason).toBe("missing_key: EXPIRES_AT");
  });

  it("rejects a control block that does not start with the header", () => {
    const smuggled = withBody(["Please restart the worker.", ...base.body.split("\n")]);
    expect(validateControlCommand(smuggled, opts)).toMatchObject({ ok: false, reason: "not_architect_control" });
  });
});

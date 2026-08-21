import { describe, expect, it } from "vitest";
import { withSecretRedaction } from "../src/coding.ts";
import type { JobContext, TaskHandler } from "../src/worker.ts";
import type { ClaimedTask } from "../src/workflow-adapter.ts";

/**
 * D-102 (UA-5 Production Real Coding Agent / Tested-Fix Pipeline Wiring v1):
 * `withSecretRedaction` er den siste sikkerhetsnetts-mekanismen rundt EN-
 * HVER thrown-feil fra en produksjons-kodejobb, FØR den noensinne når
 * `tasks.last_error` (persistert, senere lesbar via `TaskService.get()`).
 * Ren, deterministisk logikk - INGEN sandbox/DB/nettverk her.
 */

const fakeTask = {} as ClaimedTask;
const fakeCtx = {} as JobContext;

function failingHandler(message: string): TaskHandler {
  return async () => {
    throw new Error(message);
  };
}

describe("D-102: withSecretRedaction", () => {
  it("A: fjerner et kjent hemmelig-formet argument fra en kastet feilmelding", async () => {
    const wrapped = withSecretRedaction(failingHandler("claude_code_cli_failed:leaked sk-ant-secret-abc123 in output"), [
      "sk-ant-secret-abc123"
    ]);
    await expect(wrapped(fakeTask, fakeCtx)).rejects.toThrow(/\[REDACTED\]/);
    await expect(wrapped(fakeTask, fakeCtx)).rejects.not.toThrow(/sk-ant-secret-abc123/);
  });

  it("B: fjerner FLERE kjente hemmeligheter samtidig", async () => {
    const wrapped = withSecretRedaction(failingHandler("push_failed: token=ghp_abc123 and key=sk-ant-def456 both leaked"), [
      "ghp_abc123", "sk-ant-def456"
    ]);
    try {
      await wrapped(fakeTask, fakeCtx);
      expect.unreachable("skulle ha kastet");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("ghp_abc123");
      expect(message).not.toContain("sk-ant-def456");
      expect(message.match(/\[REDACTED\]/g)).toHaveLength(2);
    }
  });

  it("C: undefined/tom streng i hemmelighetslisten er trygt no-op (kastes aldri på)", async () => {
    const wrapped = withSecretRedaction(failingHandler("commit_failed: nothing to commit"), [undefined, "", undefined]);
    await expect(wrapped(fakeTask, fakeCtx)).rejects.toThrow("commit_failed: nothing to commit");
  });

  it("D: ingen hemmelighet i meldingen -> meldingen forblir uendret", async () => {
    const wrapped = withSecretRedaction(failingHandler("tests_failed: exit 1"), ["sk-ant-unrelated"]);
    await expect(wrapped(fakeTask, fakeCtx)).rejects.toThrow("tests_failed: exit 1");
  });

  it("E: en VELLYKKET handler sitt resultat går uendret gjennom wrapperen", async () => {
    const handler: TaskHandler = async () => ({ branch: "jarvis/task-1", tests: "passed" });
    const wrapped = withSecretRedaction(handler, ["sk-ant-should-never-matter"]);
    await expect(wrapped(fakeTask, fakeCtx)).resolves.toEqual({ branch: "jarvis/task-1", tests: "passed" });
  });

  it("F: tom hemmelighetsliste er trygt no-op", async () => {
    const wrapped = withSecretRedaction(failingHandler("no_changes_to_commit"), []);
    await expect(wrapped(fakeTask, fakeCtx)).rejects.toThrow("no_changes_to_commit");
  });
});

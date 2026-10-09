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

  it("G (WP-C3): hemmelighetslisten kan være en funksjon som leses PÅ FEILTIDSPUNKTET - kortlevde tokens (utstedt etter oppstart) redigeres også", async () => {
    const issuedLater: string[] = [];
    const wrapped = withSecretRedaction(failingHandler("push_failed: remote said token ghs_RotatedInstallationToken123 is bad"), () => issuedLater);
    issuedLater.push("ghs_RotatedInstallationToken123"); // utstedt ETTER at wrapperen ble laget
    await expect(wrapped(fakeTask, fakeCtx)).rejects.toThrow("push_failed: remote said token [REDACTED] is bad");
  });

  it("H (WP-C3): en funksjon som kaster skjuler aldri den opprinnelige feilen (fail-open for redaksjon, fail-closed for feilmeldingen)", async () => {
    const wrapped = withSecretRedaction(failingHandler("tests_failed: exit 1"), () => { throw new Error("kilde nede"); });
    await expect(wrapped(fakeTask, fakeCtx)).rejects.toThrow("tests_failed: exit 1");
  });

  // WP-C3 review F12: tidligere ble HELE listen (også de statiske nøklene) hoppet over hvis den ene funksjonen kastet. Nå skjermes hver dynamiske kilde for seg.
  const boom = (): never => { throw new Error("kilde nede"); };
  const messageOf = async (wrapped: TaskHandler): Promise<string> => wrapped(fakeTask, fakeCtx).then(() => "OK (kastet ikke)", (err: Error) => err.message);

  it("I (WP-C3 F12): en dynamisk kilde som kaster hopper kun over SEG SELV - de statiske hemmelighetene i samme liste redigeres likevel", async () => {
    const wrapped = withSecretRedaction(failingHandler("push_failed: sk-ant-STATISK-123 og ghp_STATISK_PAT_456 lekket"), ["sk-ant-STATISK-123", "ghp_STATISK_PAT_456", boom]);
    expect(await messageOf(wrapped)).toBe("push_failed: [REDACTED] og [REDACTED] lekket");
  });

  it("J (WP-C3 F12): flere dynamiske kilder - den som kaster hoppes, de andre (før og etter) brukes, og de leses PÅ FEILTIDSPUNKTET", async () => {
    const early: string[] = [];
    const late: string[] = [];
    const wrapped = withSecretRedaction(failingHandler("x ghs_TIDLIG_1 y ghs_SEN_2 z sk-ant-STATISK-9"), [() => early, boom, "sk-ant-STATISK-9", () => late]);
    early.push("ghs_TIDLIG_1");
    late.push("ghs_SEN_2"); // begge utstedt ETTER at wrapperen ble laget
    expect(await messageOf(wrapped)).toBe("x [REDACTED] y [REDACTED] z [REDACTED]");
  });

  it("K (WP-C3 F12): en kilde som returnerer noe annet enn en liste (undefined/null/tall), eller liste med ikke-strenger, krasjer aldri redaksjonen og skjuler aldri jobbfeilen", async () => {
    const weird = [() => undefined, () => null, () => 42, () => [undefined, "", 7, null, {}, "sk-ant-OK-5"]] as unknown as Array<() => readonly (string | undefined)[]>;
    const wrapped = withSecretRedaction(failingHandler("tests_failed: sk-ant-OK-5 i utskrift"), ["", undefined, ...weird]);
    expect(await messageOf(wrapped)).toBe("tests_failed: [REDACTED] i utskrift");
  });

  it("L (WP-C3 F12): når ALLE kilder kaster, er jobbfeilen uendret (aldri en redaksjonsfeil i stedet)", async () => {
    const wrapped = withSecretRedaction(failingHandler("tests_failed: exit 1"), [boom, boom]);
    expect(await messageOf(wrapped)).toBe("tests_failed: exit 1");
    expect(await messageOf(withSecretRedaction(failingHandler("tests_failed: exit 1"), boom))).toBe("tests_failed: exit 1");
  });

  it("M (WP-C3 F12): gammel form (hele listen som én funksjon) virker som før, og en vellykket handler påvirkes ikke av en kastende kilde", async () => {
    expect(await messageOf(withSecretRedaction(failingHandler("a ghs_X1 b"), () => ["ghs_X1"]))).toBe("a [REDACTED] b");
    const ok: TaskHandler = async () => ({ tests: "passed" });
    await expect(withSecretRedaction(ok, ["sk-ant-1", boom])(fakeTask, fakeCtx)).resolves.toEqual({ tests: "passed" });
  });
});

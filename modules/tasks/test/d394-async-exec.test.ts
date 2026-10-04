import { describe, expect, it } from "vitest";
import { execProcess } from "../src/process-exec.ts";
import { ProcessSandboxRunner } from "../src/sandbox.ts";

/** D-394 (JARVIS-023): barneprosesser blokkerer ikke Node-event-loopen. */
describe("JARVIS-023: asynkron prosesskjøring", () => {
  it("event-loopen lever mens en 600 ms lang barneprosess kjører (tidligere spawnSync-frys)", async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    const result = await execProcess(process.execPath, ["-e", "setTimeout(() => console.log('ferdig'), 600)"], { timeoutMs: 10_000 });
    clearInterval(timer);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ferdig");
    expect(ticks).toBeGreaterThan(10); // ville vært 0 med spawnSync
  });

  it("tidsavbrudd dreper prosessen (SIGKILL) og rapporterer timedOut", async () => {
    const started = Date.now();
    const result = await execProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.status).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("ikke-null exit-kode og stderr returneres; manglende binær gir spawnError i stedet for unntak", async () => {
    const failed = await execProcess(process.execPath, ["-e", "console.error('feil'); process.exit(3)"]);
    expect(failed.status).toBe(3);
    expect(failed.stderr).toContain("feil");
    const missing = await execProcess("/finnes/ikke/binar", []);
    expect(missing.spawnError).toBeDefined();
    expect(missing.status).toBeNull();
  });

  it("utdata er begrenset (aldri ubegrenset minne fra en løpsk prosess)", async () => {
    const result = await execProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(5_000_000))"], { maxOutputBytes: 1_000 });
    expect(result.stdout.length).toBeLessThanOrEqual(1_000);
    expect(result.stderr).toContain("[output_truncated]");
  });

  it("ProcessSandboxRunner.exec er asynkron og bruker ren env", async () => {
    const sandbox = await new ProcessSandboxRunner().create({ ONLY_JOB_VAR: "ja" });
    try {
      const r = await sandbox.exec(process.execPath, ["-e", "console.log(process.env.ONLY_JOB_VAR + '|' + (process.env.HOME ?? 'ingen-home'))"]);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("ja|ingen-home");
    } finally {
      await sandbox.dispose();
    }
  });
});

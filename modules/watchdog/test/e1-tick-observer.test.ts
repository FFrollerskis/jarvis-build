import { describe, expect, it, vi } from "vitest";
import { MemoryAlertSink, Watchdog, type HealthCheck, type WatchdogTickReport } from "../src/watchdog.ts";

/**
 * WP-E1 (JARVIS-068): vakthundens tikk-observatør (leveres til incident-produsenten). Hvert FULLFØRT tikk rapporterer ALLE sjekker (ok og feil); et hoppet overlappende tikk rapporterer ingenting
 * (ellers ville «ingen resultater» sett ut som «alt er ok»); og en observatør som kaster/avviser kan aldri velte vakthunden eller endre varslingen.
 */
const killSwitch = {} as never;
const check = (name: string, ok: () => boolean, severity: "warning" | "critical" = "warning"): HealthCheck => ({
  name, runbook: `docs/runbooks/${name}.md`,
  async run() { return ok() ? { ok: true, severity: "info", message: "" } : { ok: false, severity, message: `${name} feilet` }; }
});

describe("Watchdog: tikk-observatør", () => {
  it("rapporterer alle sjekker (ok og feil) i ett fullført tikk, med runbook og uten melding for ok", async () => {
    const wd = new Watchdog(new MemoryAlertSink(), killSwitch, 5000);
    let good = true;
    wd.register(check("database", () => true));
    wd.register(check("stuck_tasks", () => good, "critical"));
    const reports: WatchdogTickReport[] = [];
    wd.setObserver((r) => { reports.push(r); });
    await wd.tick();
    good = false;
    await wd.tick();
    expect(reports).toHaveLength(2);
    expect(reports[0]!.results).toEqual([
      { check: "database", ok: true, severity: "info", message: "", runbook: "docs/runbooks/database.md" },
      { check: "stuck_tasks", ok: true, severity: "info", message: "", runbook: "docs/runbooks/stuck_tasks.md" }
    ]);
    expect(reports[1]!.results[1]).toEqual({ check: "stuck_tasks", ok: false, severity: "critical", message: "stuck_tasks feilet", runbook: "docs/runbooks/stuck_tasks.md" });
    expect(Number.isNaN(Date.parse(reports[1]!.at))).toBe(false);
  });

  it("en sjekk som kaster rapporteres som feilet (critical), ikke som ok", async () => {
    const wd = new Watchdog(new MemoryAlertSink(), killSwitch, 5000);
    wd.register({ name: "boom", runbook: "r", async run() { throw new Error("db nede"); } });
    const reports: WatchdogTickReport[] = [];
    wd.setObserver((r) => { reports.push(r); });
    await wd.tick();
    expect(reports[0]!.results[0]).toMatchObject({ check: "boom", ok: false, severity: "critical" });
    expect(reports[0]!.results[0]!.message).toContain("db nede");
  });

  it("et hoppet overlappende tikk rapporterer ingenting", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const wd = new Watchdog(new MemoryAlertSink(), killSwitch, 5000);
    let release: () => void = () => undefined;
    wd.register({ name: "slow", runbook: "r", run: () => new Promise((resolve) => { release = () => resolve({ ok: true, severity: "info", message: "" }); }) });
    const reports: WatchdogTickReport[] = [];
    wd.setObserver((r) => { reports.push(r); });
    const first = wd.tick();
    const overlapped = await wd.tick();
    expect(overlapped).toEqual([]);
    expect(reports).toHaveLength(0);
    release();
    await first;
    expect(reports).toHaveLength(1);
  });

  it("en observatør som kaster eller avviser påvirker verken varsling eller tikkets resultat", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const observer of [() => { throw new Error("sync feil"); }, async () => { throw new Error("async feil"); }]) {
      const sink = new MemoryAlertSink();
      const wd = new Watchdog(sink, killSwitch, 5000);
      wd.register(check("stuck_tasks", () => false));
      wd.setObserver(observer);
      const fired = await wd.tick();
      await new Promise((r) => setTimeout(r, 5));
      expect(fired.map((a) => a.check)).toEqual(["stuck_tasks"]);
      expect(sink.alerts).toHaveLength(1);
    }
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAINTENANCE_CATALOG } from "@jarvis/self-modification";
import { MAINTENANCE_COVERAGE, backupCoverage } from "../src/evolution-source.ts";
import { backupMaintenanceLastRun } from "../src/backup-status.ts";

/**
 * WP-OPS2a K4: EV-19-koblingen (`BUILT_UNWIRED` -> `WIRED`, kun lesing). Beslutningsbevisene ligger i `evolution-source.test.ts` (enhet) og `wpb-evolution-source-db.test.ts` (ekte fil + ekte Postgres); her låses wiringen i `main.ts`
 * og at dekningstabellen og `backupMaintenanceLastRun` er enige om hvilke oppgaver som kommer fra backup-statusfilen.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const main = readFileSync(join(ROOT, "apps/api/src/main.ts"), "utf8");

describe("wiring i main.ts", () => {
  it("evolusjonskildene får SAMME backup-statuskilde som selvdiagnosen (ÉN kilde, ett kall til backupStatusSourceFromEnv), kun når den finnes", () => {
    expect(main.match(/backupStatusSourceFromEnv\(/g)).toHaveLength(1);
    expect(main).toContain("...(backupStatusSource ? { backupStatus: backupStatusSource } : {})");
    const deps = main.indexOf("const evolutionSourceDeps: EvolutionSourceDeps = {");
    const end = main.indexOf("const evolutionReports = createEvolutionReportProvider(evolutionSourceDeps)");
    expect(deps).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(deps);
    expect(main.slice(deps, end)).toContain("backupStatus: backupStatusSource");
  });
});

describe("dekningstabellen", () => {
  it("nøyaktig to oppgaver kommer fra backup-statusfilen, og de er de samme som `backupMaintenanceLastRun` gir `last_run` for", () => {
    const fromBackup = Object.entries(MAINTENANCE_COVERAGE).filter(([, c]) => c.by === "backup").map(([id]) => id).sort();
    expect(fromBackup).toEqual(["backup_status", "disaster_recovery_sample_restore"]);
    const snapshot = { generated_at: "2026-10-15T11:00:00.000Z", restore_verify: { last_success_at: "2026-10-10T11:00:00.000Z" } } as never;
    expect(Object.keys(backupMaintenanceLastRun(snapshot)).sort()).toEqual(fromBackup);
    const ids = new Set(MAINTENANCE_CATALOG.map((t) => t.id));
    for (const id of fromBackup) expect(ids.has(id), id).toBe(true);
  });

  it("backupCoverage er ren: `null` (ingen kilde) og en mislykket lesing gir ingen dekning og ingen `last_run`", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    for (const read of [null, { ok: false } as const, { ok: true, v: { kind: "missing" } } as const, { ok: true, v: { kind: "invalid", reason: "not_json" } } as const]) {
      const c = backupCoverage(read as never, now);
      expect(c.covered.size).toBe(0);
      expect(c.last_run).toEqual({});
      expect(c.note).toContain("er ikke vurdert");
    }
  });

  it("en ugyldig årsak fra leseren (utenfor det lukkede settet) siteres aldri - notatet sier «ukjent»", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    const hostile = backupCoverage({ ok: true, v: { kind: "invalid", reason: "../../etc/passwd Authorization: Bearer abc" } } as never, now);
    expect(hostile.note).toContain("kunne ikke leses (ukjent)");
    expect(hostile.note).not.toContain("passwd");
    expect(hostile.note).not.toContain("Bearer");
    expect(backupCoverage({ ok: true, v: "tull" } as never, now).covered.size).toBe(0);
    expect(backupCoverage({ ok: true, v: null } as never, now).covered.size).toBe(0);
    expect(backupCoverage({ ok: true, v: { kind: "noe-annet" } } as never, now).note).toContain("ugyldig svar");
  });
});

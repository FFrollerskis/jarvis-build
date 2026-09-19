import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseWatchdogIntervalMs, parseCostHardLimitOre,
  WATCHDOG_INTERVAL_MS_DEFAULT, WATCHDOG_INTERVAL_MS_MIN, WATCHDOG_INTERVAL_MS_MAX,
  COST_HARD_LIMIT_ORE_DEFAULT
} from "../src/watchdog.ts";

/**
 * D-187 (BLOCKER B2, arkitekt-order D187 mot PR #96 - fersk review av post-B1
 * HEAD): `worker-main.ts` kalte tidligere `Number(process.env[...] ?? default)`
 * uten validering for `JARVIS_WATCHDOG_INTERVAL_MS`/`JARVIS_COST_HARD_LIMIT_ORE`.
 * En feilformet streng gir `NaN` fra `Number(...)` - ALDRI en exception - og en
 * `NaN`-hardgrense gjør `spent < hardLimitOre` ALLTID `false`, slik at
 * `costExplosionCheck` ville forsøke durabel nødstopp ved FØRSTE tick uansett
 * faktisk forbruk. Denne suiten beviser BEHAVIORALT (rene funksjoner, ingen DB)
 * at begge parserne validerer FØR verdien når kallerne sine, per ordrens 16
 * påkrevde caser (9 intervall + 7 kostnadsgrense).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("D187 §A: JARVIS_WATCHDOG_INTERVAL_MS - parseWatchdogIntervalMs()", () => {
  it("1) usatt (undefined) -> default 60_000", () => {
    expect(parseWatchdogIntervalMs(undefined)).toBe(60_000);
    expect(parseWatchdogIntervalMs(undefined)).toBe(WATCHDOG_INTERVAL_MS_DEFAULT);
  });

  it("2) gyldig, bounded heltall -> akseptert uendret", () => {
    expect(parseWatchdogIntervalMs("30000")).toBe(30_000);
    expect(parseWatchdogIntervalMs(String(WATCHDOG_INTERVAL_MS_MIN))).toBe(WATCHDOG_INTERVAL_MS_MIN);
    expect(parseWatchdogIntervalMs(String(WATCHDOG_INTERVAL_MS_MAX))).toBe(WATCHDOG_INTERVAL_MS_MAX);
  });

  it("3) null (0) -> avvist (kaster)", () => {
    expect(() => parseWatchdogIntervalMs("0")).toThrow(/JARVIS_WATCHDOG_INTERVAL_MS/);
  });

  it("4) negativ -> avvist (kaster)", () => {
    expect(() => parseWatchdogIntervalMs("-1000")).toThrow(/JARVIS_WATCHDOG_INTERVAL_MS/);
  });

  it("5) NaN/ikke-tall -> avvist (kaster)", () => {
    expect(() => parseWatchdogIntervalMs("ikke-et-tall")).toThrow(/JARVIS_WATCHDOG_INTERVAL_MS/);
    expect(() => parseWatchdogIntervalMs("NaN")).toThrow(/JARVIS_WATCHDOG_INTERVAL_MS/);
    expect(() => parseWatchdogIntervalMs("")).toThrow(/JARVIS_WATCHDOG_INTERVAL_MS/);
  });

  it("6) Infinity -> avvist (kaster)", () => {
    expect(() => parseWatchdogIntervalMs("Infinity")).toThrow(/JARVIS_WATCHDOG_INTERVAL_MS/);
    expect(() => parseWatchdogIntervalMs("-Infinity")).toThrow(/JARVIS_WATCHDOG_INTERVAL_MS/);
  });

  it("7) under nedre grense -> avvist (kaster) - beviser at en 'utilsiktet stram løkke' er strukturelt umulig", () => {
    expect(() => parseWatchdogIntervalMs(String(WATCHDOG_INTERVAL_MS_MIN - 1))).toThrow(/utenfor gyldig område/);
    expect(() => parseWatchdogIntervalMs("1")).toThrow(/utenfor gyldig område/);
  });

  it("8) over øvre grense -> avvist (kaster)", () => {
    expect(() => parseWatchdogIntervalMs(String(WATCHDOG_INTERVAL_MS_MAX + 1))).toThrow(/utenfor gyldig område/);
  });

  it("9) fraksjonell verdi -> avvist (kaster)", () => {
    expect(() => parseWatchdogIntervalMs("60000.5")).toThrow(/JARVIS_WATCHDOG_INTERVAL_MS/);
    expect(() => parseWatchdogIntervalMs("60000.0000001")).toThrow(/JARVIS_WATCHDOG_INTERVAL_MS/);
  });
});

describe("D187 §B: JARVIS_COST_HARD_LIMIT_ORE - parseCostHardLimitOre()", () => {
  it("10) usatt (undefined) -> default 300_000", () => {
    expect(parseCostHardLimitOre(undefined)).toBe(300_000);
    expect(parseCostHardLimitOre(undefined)).toBe(COST_HARD_LIMIT_ORE_DEFAULT);
  });

  it("11) gyldig, positivt heltall -> akseptert uendret", () => {
    expect(parseCostHardLimitOre("500000")).toBe(500_000);
    expect(parseCostHardLimitOre("1")).toBe(1);
  });

  it("12) null (0) -> avvist (kaster) - dette er den DIREKTE motbevisningen av B2-scenarioet: 0 forblir 0, aldri NaN, og en NaN-hardgrense kan derfor aldri naa costExplosionCheck() via denne parseren", () => {
    expect(() => parseCostHardLimitOre("0")).toThrow(/JARVIS_COST_HARD_LIMIT_ORE/);
  });

  it("13) negativ -> avvist (kaster)", () => {
    expect(() => parseCostHardLimitOre("-1")).toThrow(/JARVIS_COST_HARD_LIMIT_ORE/);
  });

  it("14) NaN/ikke-tall -> avvist (kaster)", () => {
    expect(() => parseCostHardLimitOre("ikke-et-tall")).toThrow(/JARVIS_COST_HARD_LIMIT_ORE/);
    expect(() => parseCostHardLimitOre("NaN")).toThrow(/JARVIS_COST_HARD_LIMIT_ORE/);
    expect(() => parseCostHardLimitOre("")).toThrow(/JARVIS_COST_HARD_LIMIT_ORE/);
  });

  it("15) Infinity -> avvist (kaster)", () => {
    expect(() => parseCostHardLimitOre("Infinity")).toThrow(/JARVIS_COST_HARD_LIMIT_ORE/);
  });

  it("16) fraksjonell verdi -> avvist (kaster)", () => {
    expect(() => parseCostHardLimitOre("300000.5")).toThrow(/JARVIS_COST_HARD_LIMIT_ORE/);
  });
});

describe("D187: worker-main.ts sender KUN de validerte verdiene til setInterval()/costExplosionCheck() - strukturelt bevis", () => {
  const workerMainSource = readSource("../../../apps/api/src/worker-main.ts");

  it("importerer parseWatchdogIntervalMs/parseCostHardLimitOre fra @jarvis/watchdog", () => {
    expect(workerMainSource).toMatch(/import\s*\{[^}]*parseWatchdogIntervalMs[^}]*\}\s*from\s*"@jarvis\/watchdog"/s);
    expect(workerMainSource).toMatch(/import\s*\{[^}]*parseCostHardLimitOre[^}]*\}\s*from\s*"@jarvis\/watchdog"/s);
  });

  it("WATCHDOG_INTERVAL_MS er tildelt DIREKTE fra parseWatchdogIntervalMs(...) - ingen rå Number(...) igjen for dette feltet", () => {
    const assignIdx = workerMainSource.indexOf("const WATCHDOG_INTERVAL_MS =");
    expect(assignIdx).toBeGreaterThan(-1);
    const line = workerMainSource.slice(assignIdx, workerMainSource.indexOf(";", assignIdx) + 1);
    expect(line).toMatch(/parseWatchdogIntervalMs\(process\.env\["JARVIS_WATCHDOG_INTERVAL_MS"\]\)/);
    expect(line).not.toMatch(/Number\(/);
  });

  it("setInterval() sitt andre argument ER navnet WATCHDOG_INTERVAL_MS - den validerte konstanten, ikke et separat, uvalidert uttrykk", () => {
    // Søker etter det FAKTISKE kallet (`setInterval(\n  () =>`), ikke bokstavelige
    // "setInterval()"-forekomster i kommentarprosa (f.eks. D187-begrunnelsen over).
    const setIntervalIdx = workerMainSource.indexOf("setInterval(\n  () =>");
    expect(setIntervalIdx).toBeGreaterThan(-1);
    const block = workerMainSource.slice(setIntervalIdx, workerMainSource.indexOf(");", setIntervalIdx) + 2);
    expect(block).toContain("WATCHDOG_INTERVAL_MS");
    expect(block).not.toMatch(/Number\(process\.env/);
  });

  it("costExplosionCheck(...) sitt hardLimitOre-argument ER parseCostHardLimitOre(process.env[...]) - ingen rå Number(...) igjen", () => {
    const callIdx = workerMainSource.indexOf("costExplosionCheck(pool,");
    expect(callIdx).toBeGreaterThan(-1);
    const call = workerMainSource.slice(callIdx, workerMainSource.indexOf("\n", callIdx));
    expect(call).toMatch(/parseCostHardLimitOre\(process\.env\["JARVIS_COST_HARD_LIMIT_ORE"\]\)/);
    expect(call).not.toMatch(/Number\(/);
  });
});

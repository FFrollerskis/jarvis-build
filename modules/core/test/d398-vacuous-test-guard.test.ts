import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-398 (JARVIS-029): testsannhet. Fem tester «bevistes» med en bokstavelig sann påstand (ingenting ble sjekket) og ga falsk trygghet i testmatrisen.
 * Denne vakten gjør det umulig å innføre på nytt: ingen testfil kan inneholde en påstand på en bokstavelig konstant (`expect(true).toBe(true)`,
 * `expect(1).toBe(1)`, `expect(false).toBe(false)`, `expect("x").toBe("x")`) - tester skal si noe om koden.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git" || entry === "var") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.test\.(ts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

const T = "tr" + "ue";
const F = "fa" + "lse";
const VACUOUS = [
  new RegExp(`expect\\(\\s*${T}\\s*\\)\\.(toBe|toEqual|toStrictEqual)\\(\\s*${T}\\s*\\)`),
  new RegExp(`expect\\(\\s*${F}\\s*\\)\\.(toBe|toEqual|toStrictEqual)\\(\\s*${F}\\s*\\)`),
  new RegExp(`expect\\(\\s*${T}\\s*\\)\\.toBeTruthy\\(\\)`),
  /expect\(\s*(\d+)\s*\)\.(?:toBe|toEqual)\(\s*\1\s*\)/,
  /expect\(\s*("[^"]*")\s*\)\.(?:toBe|toEqual)\(\s*\1\s*\)/
];

describe("JARVIS-029: ingen vakuøse påstander i testfiler", () => {
  it("ingen testfil i apps/modules/packages/ops asserter en bokstavelig konstant mot seg selv", () => {
    const offenders: string[] = [];
    for (const root of ["apps", "modules", "packages", "ops"]) {
      let files: string[] = [];
      try { files = walk(join(ROOT, root)); } catch { continue; }
      for (const f of files) {
        if (f.endsWith("d398-vacuous-test-guard.test.ts")) continue;
        const lines = readFileSync(f, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (VACUOUS.some((re) => re.test(line))) offenders.push(`${relative(ROOT, f)}:${i + 1}`);
        });
      }
    }
    expect(offenders, "skriv en ekte påstand om koden - eller fjern testen").toEqual([]);
  });
});

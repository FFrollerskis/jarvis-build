import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeActOperationFingerprint } from "../src/service.ts";

/**
 * D-396/D-398 (JARVIS-095): `computeActOperationFingerprint` skilte feltene med RÅE NUL-bytes i kildefilen - git behandlet filen som binær (ingen
 * lesbar diff/merge, verktøy kuttet den). Nå står separatoren som escape (`\u0000`); runtime-verdien er identisk, og fingeravtrykket er festet med en golden hash.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git" || entry === "var") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js|json|sql|md|yml|yaml|ps1|sh)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("JARVIS-095: ingen rå NUL-bytes i kildefiler", () => {
  it("ingen tekstlig kildefil i apps/modules/packages/ops/infra/docs inneholder en rå 0x00-byte", () => {
    const offenders: string[] = [];
    for (const root of ["apps", "modules", "packages", "ops", "infra", "docs"]) {
      let files: string[] = [];
      try { files = walk(join(ROOT, root)); } catch { continue; }
      for (const f of files) if (readFileSync(f).includes(0)) offenders.push(f.slice(ROOT.length + 1));
    }
    expect(offenders, "bruk escape (\\u0000) i stedet for en rå NUL-byte").toEqual([]);
  });

  it("golden: act-fingeravtrykket er stabilt (separator = U+0000, kanonisk JSON sortert)", () => {
    expect(computeActOperationFingerprint("sit-1", "email", "send", { b: 2, a: [1, "x"], c: { z: null } }))
      .toBe("54229e6734b4858525da9713d28b725da5d68d85752da18c8a7c52466573ad75");
    // nøkkelrekkefølge påvirker ikke fingeravtrykket
    expect(computeActOperationFingerprint("sit-1", "email", "send", { c: { z: null }, a: [1, "x"], b: 2 }))
      .toBe(computeActOperationFingerprint("sit-1", "email", "send", { b: 2, a: [1, "x"], c: { z: null } }));
  });
});

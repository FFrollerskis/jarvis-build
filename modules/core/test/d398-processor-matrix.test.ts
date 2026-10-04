import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-398 (JARVIS-087): Telegram er en ekstern behandler av eierens varsler/brief/godkjenningsvarsler, men sto ikke i behandlermatrisen. Raden skal finnes og
 * være ærlig: vilkårene er IKKE verifisert, og kanalen kvalifiserer aldri for helse-/hemmelighetsinnhold. (Matrisen er ellers en tekstpåstand; denne vakten hindrer
 * at raden stille forsvinner eller flippes til «VERIFIED» uten at noen faktisk har verifisert vilkårene.)
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const matrix = readFileSync(join(ROOT, "docs/security/PROCESSOR_REGION_MATRIX.md"), "utf8");

describe("PROCESSOR_REGION_MATRIX har en Telegram-rad", () => {
  const row = matrix.split("\n").find((l) => l.startsWith("|") && l.includes("Telegram"));

  it("raden finnes og navngir Bot API-bruken", () => {
    expect(row).toBeDefined();
    expect(row).toContain("Bot API");
  });

  it("vilkårene er IKKE VERIFISERT (region, DPA, trening, retensjon) - ingen falsk «VERIFIED»", () => {
    expect(row).toContain("IKKE VERIFISERT");
    expect((row!.match(/IKKE VERIFISERT/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(row).not.toMatch(/\bGODKJENT\b/);
  });

  it("utelukker helse-/SECRET_RESTRICTED-innhold", () => {
    expect(row).toMatch(/aldri `health`\/`SECRET_RESTRICTED`/);
  });
});

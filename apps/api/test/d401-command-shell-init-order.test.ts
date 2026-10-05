import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-401: `command.html` kalte `activate(restored)` FØR `const voiceDot` var deklarert (temporal dead zone) →
 * `ReferenceError: Cannot access 'voiceDot' before initialization` ved oppstart på NAS, resten av skriptet døde.
 * Verifisert i ekte Chromium før/etter (feil → 0 feil, «3/3 flater klare»); testen låser bare rekkefølgen.
 */
const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../web/command.html"), "utf8");

describe("command.html: initialiseringsrekkefølge", () => {
  it("activate(restored) kalles etter at voiceDot er deklarert", () => {
    const decl = html.indexOf('const voiceDot = document.getElementById("voice-dot")');
    const call = html.indexOf("activate(restored);");
    expect(decl).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(decl);
    expect(html.indexOf("activate(restored);", call + 1)).toBe(-1);
  });
});

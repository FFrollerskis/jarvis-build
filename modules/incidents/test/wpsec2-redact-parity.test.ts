import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redactLogText, scanForSecrets } from "@jarvis/core";
import { redactSecrets } from "../src/redact.ts";

/**
 * WP-SEC2 (K7d): `redactSecrets` (incidents) er den felles `redactLogText` og redigerer ALDRI mindre enn sentralen: ingen egne mønsterkopier, og alt sentralen finner er borte også her.
 */
const gh = ["gh", "p_"].join("") + "Zx3Qk9Lm2Vb7Nc4Rt8Wy1Hd5Fs6Jg0Pa8TnX";

describe("incidents/redact.ts", () => {
  it("er bare en tynn omslag rundt den felles funksjonen (ingen mønsterkopier)", () => {
    const src = readFileSync(new URL("../src/redact.ts", import.meta.url), "utf8");
    expect(src).toContain("redactLogText");
    expect(src).not.toMatch(/gh\[pousr\]_|sk-ant-\[|Authorization:\\s|Bearer\\s\+/);
    for (const text of ["calling API with Bearer abc123XYZ.def", "Authorization: Basic dXNlcjpwYXNz", `x ${gh}`, "DB_PASSWORD=hunter2 ok"]) expect(redactSecrets(text)).toBe(redactLogText(text));
  });

  it("redigerer minst like mye som sentralen for skjulte, delte og JSON-formede hemmeligheter (aldri svakere)", () => {
    const probes = [`${gh.slice(0, 5)}${String.fromCodePoint(0x200b)}${gh.slice(5)}`, `${gh.slice(0, 20)}\n${gh.slice(20)}`, `{"client_secret":"${"abcDEF123456"}"}`, `Cookie: sid=${"abcDEF123456"}; a=b`, "Authorization: Bearer abc123"];
    for (const probe of probes) {
      expect(scanForSecrets(probe).findings.length, probe).toBeGreaterThan(0);
      const out = redactSecrets(probe);
      expect(scanForSecrets(out).findings, probe).toEqual([]);
      expect(out, probe).not.toContain("abcDEF123456");
      expect(out, probe).not.toContain("abc123");
      expect(out, probe).not.toContain(gh.slice(8, 30));
    }
  });
});

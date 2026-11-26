import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scanForSecrets } from "@jarvis/core";
import { redactVendorText } from "../src/vendor-text.ts";

/**
 * WP-SEC2 (K7b/K7d): leverandørtekst skannes FØR den kuttes, og `docker-transport.ts` har ingen egne mønsterkopier (den bruker den felles `redactLogText` i @jarvis/core).
 */
const token = ["gh", "p_"].join("") + "Zx3Qk9Lm2Vb7Nc4Rt8Wy1Hd5Fs6Jg0Pa8TnX";

describe("vendor-text: skann først, kutt etterpå", () => {
  it("et token bak 65 536+ blanke (det gamle kuttet) blir ikke et halvt token igjen", () => {
    const text = `${" ".repeat(65_536 - 10)}${token}`;
    expect(text.slice(0, 65_536)).toContain("ghp_"); // gammel rekkefølge: kutt først lot et halvt token stå
    const out = redactVendorText(text, 160);
    expect(out).toBe("[REDACTED:github_token]");
  });

  it("vanlig leverandørtekst er som før: blanke kollapset, kuttet til `max`, hemmeligheter redigert", () => {
    expect(redactVendorText("  feil:   tilkobling\n avbrutt  ")).toBe("feil: tilkobling avbrutt");
    expect(redactVendorText(`rotasjon feilet: postgres://u:${"pw" + "12345"}@db/x`)).toBe("rotasjon feilet: postgres://u:[REDACTED:url_credentials]@db/x");
    expect(redactVendorText("a".repeat(500), 40)).toHaveLength(40);
    expect(scanForSecrets(redactVendorText(`${token} og mer`)).findings).toEqual([]);
  });
});

describe("docker-transport: ingen egne mønsterkopier (K7d)", () => {
  it("kilden definerer ingen token-/Authorization-regexer selv, men bruker den felles redactLogText", () => {
    const src = readFileSync(new URL("../src/docker-transport.ts", import.meta.url), "utf8");
    expect(src).toContain("redactLogText");
    expect(src).not.toMatch(/gh\[pousr\]_|sk-ant-\[|Authorization:\\s|Bearer\\s\+/);
  });
});

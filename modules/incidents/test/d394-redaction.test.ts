import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redact.ts";

/** D-394 (JARVIS-069): driftslogger/evidens redigeres av BÅDE de lokale mønstrene og den sentrale skanneren. */
describe("JARVIS-069: redaksjon av driftstekst", () => {
  it("dekker formater de fire lokale mønstrene misset (JWT, Stripe, AWS, Telegram, privat nøkkel, passordfrase)", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    const text = [
      `token ${jwt}`,
      "stripe sk_live_abcdefghijklmnop1234",
      "aws AKIAABCDEFGHIJKLMNOP",
      "bot 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
      "passordet mitt er hemmelig123"
    ].join("\n");
    const out = redactSecrets(text);
    for (const leaked of [jwt, "sk_live_abcdefghijklmnop1234", "AKIAABCDEFGHIJKLMNOP", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "MIIEvQIBADANBg", "hemmelig123"]) {
      expect(out).not.toContain(leaked);
    }
  });

  it("de gamle mønstrene virker fortsatt (Bearer, Authorization, NAVN=verdi)", () => {
    const out = redactSecrets("Authorization: Bearer abc.def.ghi\nJARVIS_TOKEN=hunter2hunter2");
    expect(out).not.toContain("hunter2hunter2");
    expect(out).toContain("[REDACTED");
  });
});

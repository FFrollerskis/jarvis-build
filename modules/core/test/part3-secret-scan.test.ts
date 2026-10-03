import { describe, expect, it } from "vitest";
import { containsSecret, describeSecretFindings, scanForSecrets } from "../src/services/secret-scan.ts";

/** Del 3 (JARVIS-013): kjente hemmelighetsformater fjernes FØR lagring/modellkall; vanlig tekst røres ikke. */
const SECRETS: Array<[string, string, string]> = [
  ["github_token", "min token er ghp_abcdefghijklmnopqrstuvwxyz0123456789 takk", "ghp_abcdefghij"],
  ["github_token", "github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz", "github_pat_11ABC"],
  ["anthropic_key", "bruk sk-ant-api03-abcdefghijklmnop", "sk-ant-api03"],
  ["openai_key", "OPENAI sk-proj-abcdefghijklmnopqrstuvwxyz123", "sk-proj-abcdefghij"],
  ["stripe_key", "sk_live_abcdefghijklmnop1234", "sk_live_abcdefgh"],
  ["slack_token", "xoxb-1234567890-abcdefghijkl", "xoxb-1234567890"],
  ["aws_access_key", "AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7"],
  ["google_api_key", "AIzaSyA1234567890abcdefghijklmnopqrstuv", "AIzaSyA12345"],
  ["telegram_bot_token", "bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw9", "AAHdqTcvCH1v"],
  ["enrollment_ticket", "enr_gAyHxhllmW60abhNHI41MYOz6T7CbbfZ8dN9HOozgLM", "enr_gAyHxhll"],
  ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", "eyJhbGciOiJ"],
  ["bearer_token", "Authorization: Bearer abcdefghijklmnopqrstuv123456", "abcdefghijklmnopqrstuv"],
  ["private_key", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----", "MIIEvQIBADANBg"],
  ["named_secret", "INFISICAL_ENCRYPTION_KEY=6c1fe4e407b8911c104518103505b218", "6c1fe4e407b8"],
  ["named_secret", "JARVIS_DB_ADMIN_PASSWORD: hemmeligPassord123", "hemmeligPassord123"],
  ["spoken_password", "passordet mitt er Sommer2026!", "Sommer2026"],
  ["spoken_password", "the password is hunter22xyz", "hunter22xyz"],
  ["card_number", "kortet er 4111 1111 1111 1111 ok", "4111 1111"]
];

describe("scanForSecrets", () => {
  for (const [kind, input, leak] of SECRETS) {
    it(`fjerner ${kind}: ${input.slice(0, 30).replace(/\n/g, " ")}…`, () => {
      const r = scanForSecrets(input);
      expect(r.findings.map((f) => f.kind)).toContain(kind);
      expect(r.text).not.toContain(leak);
      expect(r.text).toContain("[REDACTED:");
      expect(containsSecret(input)).toBe(true);
    });
  }

  it("lar vanlig tekst, tall, datoer og telefonnumre være uendret", () => {
    for (const ok of [
      "Pappa heter Henrik og bor i Oslo.",
      "Møtet er 2026-10-03 kl. 14:30 og koster 1500 kr.",
      "Ring meg på +47 99 99 88 77 i morgen.",
      "Dette er et token-fritt, nøkkelfritt og passordfritt avsnitt.",
      "Ordrenummer 123456789012 er sendt",
      "https://example.com/artikkel?id=42"
    ]) {
      const r = scanForSecrets(ok);
      expect(r.findings, ok).toEqual([]);
      expect(r.text).toBe(ok);
    }
  });

  it("beholder navnet i NAVN=verdi (nyttig for diagnose), fjerner bare verdien, og teller hver forekomst", () => {
    const r = scanForSecrets("A_TOKEN=abcdef123456 og B_SECRET=zyxwvu987654");
    expect(r.text).toBe("A_TOKEN=[REDACTED:named_secret] og B_SECRET=[REDACTED:named_secret]");
    expect(r.findings).toEqual([{ kind: "named_secret", count: 2 }]);
  });

  it("describeSecretFindings viser kun typer, aldri verdier", () => {
    const r = scanForSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789 og passord er hemmelig99");
    const d = describeSecretFindings(r.findings);
    expect(d).toContain("github_token");
    expect(d).not.toContain("hemmelig99");
  });

  it("er idempotent: å skanne en allerede redigert tekst gir ingen nye funn", () => {
    const once = scanForSecrets("passord er Sommer2026! og AKIAIOSFODNN7EXAMPLE");
    expect(scanForSecrets(once.text).findings).toEqual([]);
  });
});

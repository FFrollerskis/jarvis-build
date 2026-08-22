import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redact.ts";

describe("D-105 §Q: redactSecrets (kjøretids-redaksjon FØR persistering)", () => {
  it("A: Bearer-token redigeres", () => {
    expect(redactSecrets("calling API with Bearer abc123XYZ.def")).toBe("calling API with Bearer [REDACTED]");
  });

  it("B: Authorization-header redigeres", () => {
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [REDACTED]");
  });

  it("C: GitHub-token-mønster redigeres", () => {
    expect(redactSecrets(`token=ghp_${"a".repeat(36)}`)).not.toContain("ghp_");
  });

  it("D: Anthropic-nøkkel-mønster redigeres", () => {
    expect(redactSecrets(`key sk-ant-${"a".repeat(20)}`)).not.toContain("sk-ant-a");
  });

  it("E: generisk NAVN=verdi der navnet ser hemmelig ut - KUN verdien redigeres, navnet bevares", () => {
    const out = redactSecrets("DB_PASSWORD=hunter2 startup complete");
    expect(out).toContain("DB_PASSWORD=[REDACTED]");
    expect(out).not.toContain("hunter2");
  });

  it("F: vanlig tekst UTEN hemmeligheter forblir UENDRET", () => {
    const text = "container started successfully, listening on port 8080";
    expect(redactSecrets(text)).toBe(text);
  });

  it("G: flere hemmeligheter i samme linje redigeres alle", () => {
    const out = redactSecrets("Authorization: Bearer xyz AND API_KEY=secret123");
    expect(out).not.toContain("xyz");
    expect(out).not.toContain("secret123");
  });
});

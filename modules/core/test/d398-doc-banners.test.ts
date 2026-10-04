import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-398 (JARVIS-100): utkastdokumenter (aldri formelt godkjent) skal bære en synlig henvisning til ADR-001 øverst, og lenkene i banneret skal peke på filer som finnes.
 * `RUNTIME_GATES.md` skal si at historiske «VERIFIED»-påstander ikke er re-verifisert. `apps/api` skal ikke lenger beskrive seg som «fase 1 ... minimalt fundament».
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DRAFTS = ["docs/CANONICAL_SPEC.md", "docs/VOICE_ARCHITECTURE.md", "docs/SECURITY_MODEL.md", "docs/security/THREAT_MODEL.md", "docs/security/DPIA_DRAFT.md"];

describe("utkastdokumenter har ADR-001-banner", () => {
  for (const rel of DRAFTS) {
    it(`${rel}: banner i de første 8 linjene, lenker løser seg`, () => {
      const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
      const head = lines.slice(0, 8).join("\n");
      expect(head).toContain("ADR-001");
      expect(head).toContain("Dokumentstatus");
      for (const m of head.matchAll(/\]\(([^)#]+\.md)\)/g)) {
        expect(existsSync(resolve(dirname(join(ROOT, rel)), m[1] as string)), `${rel} -> ${m[1]}`).toBe(true);
      }
    });
  }

  it("RUNTIME_GATES.md advarer om at historiske VERIFIED-påstander ikke er re-verifisert", () => {
    const head = readFileSync(join(ROOT, "docs/RUNTIME_GATES.md"), "utf8").split("\n").slice(0, 6).join("\n");
    expect(head).toMatch(/ikke re-verifisert/i);
  });

  it("apps/api/package.json beskriver ikke seg selv som «fase 1 ... minimalt fundament»", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "apps/api/package.json"), "utf8")) as { description: string };
    expect(pkg.description).not.toMatch(/fase 1|minimalt/i);
  });
});

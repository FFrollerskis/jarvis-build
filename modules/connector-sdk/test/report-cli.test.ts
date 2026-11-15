import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../scripts/report.ts";

/**
 * WP-I (D-472): `scripts/report.ts` er kommandoen runbook §10 (steg 2 og 3) sender eieren til. Testen kjører den (i prosess og som den dokumenterte kommandoen), så runbooken aldri henviser til en kommando som ikke virker.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const ROOT = resolve(PKG, "..", "..");
const SCRIPT = join(PKG, "scripts", "report.ts");

const capture = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { log: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("report guard (runbook §10 steg 2)", () => {
  it("viser vaktens dom, dekningen og arbeidslisten - og connectorer med fullt manifest står IKKE i arbeidslisten", async () => {
    const r = await capture(["guard"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("CI-vakt: OK (0 brudd)");
    expect(r.out).toContain("fulle manifester: github, cloudflare, stripe");
    expect(r.out).toContain("Arbeidsliste");
    expect(r.out).toMatch(/^\s+\d+\s+google_drive\s+\(i baselinen\)$/m);
    for (const full of ["github", "cloudflare", "stripe"]) expect(r.out, full).not.toMatch(new RegExp(`^\\s+\\d+\\s+${full}\\b`, "m"));
  });

  it("--json gir hele rapporten maskinlesbart", async () => {
    const r = await capture(["guard", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { ok: boolean; violations: unknown[]; coverage: { full: string[]; skeleton: number; skeleton_baseline: number; unknown_fields_by_connector: Record<string, number> } };
    expect(j.ok).toBe(true);
    expect(j.violations).toEqual([]);
    expect(j.coverage.full).toEqual(["github", "cloudflare", "stripe"]);
    expect(Object.keys(j.coverage.unknown_fields_by_connector).length).toBe(j.coverage.skeleton);
    expect(j.coverage.skeleton_baseline).toBeGreaterThan(40);
  });
});

describe("report contract <id> (runbook §10 steg 3)", () => {
  it("kjører kittet mot referansefakene og viser at beviset er MODELLERT, med akseptanse-gapene som arbeidsliste", async () => {
    for (const id of ["github", "cloudflare", "stripe"]) {
      const r = await capture(["contract", id]);
      expect(r.code, id).toBe(0);
      // 27 sjekker: GitHub og Cloudflare består alle 27; Stripe 26 + 1 begrunnet hopp-over (ingen automatisk rollback).
      expect(r.out).toMatch(id === "stripe" ? /26 bestått, 0 feilet, 1 hoppet over/ : /27 bestått, 0 feilet, 0 hoppet over/);
      expect(r.out).toContain("adapter_kind: fake_from_manifest");
      expect(r.out).toContain("MODELLERT");
      expect(r.out).toContain("dom gaps");
      expect(r.out).toContain("GAP        R.health_retry_breaker_runbook");
      expect(r.out).not.toMatch(/\bproven \d/);
    }
  });

  it("ugyldig bruk gir kode 2 uten å kaste: ukjent connector, ugyldig id (ingen stiinjeksjon), manglende argument", async () => {
    expect((await capture(["contract", "no_such_connector"])).code).toBe(2);
    const evil = await capture(["contract", "../../etc/passwd"]);
    expect(evil.code).toBe(2);
    expect(evil.err).toContain("snake_case");
    expect((await capture(["contract"])).code).toBe(2);
    expect((await capture(["guard", "extra"])).code).toBe(2);
    expect((await capture([])).code).toBe(2);
    expect((await capture([])).err).toContain("Bruk:");
  });
});

describe("den dokumenterte kommandoen", () => {
  it("node --experimental-transform-types modules/connector-sdk/scripts/report.ts guard kjører fra repo-roten og avslutter 0", () => {
    const r = spawnSync(process.execPath, ["--experimental-transform-types", "modules/connector-sdk/scripts/report.ts", "guard"], { cwd: ROOT, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("CI-vakt: OK");
    const c = spawnSync(process.execPath, ["--experimental-transform-types", SCRIPT, "contract", "stripe"], { cwd: ROOT, encoding: "utf8" });
    expect(c.status, c.stderr).toBe(0);
    expect(c.stdout).toContain("Kontraktstest-kit for stripe: OK");
  });
});

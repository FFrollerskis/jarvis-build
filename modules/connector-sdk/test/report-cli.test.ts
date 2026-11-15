import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FULL_MANIFESTS, SKELETON_BASELINE } from "../src/index.ts";
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

/** Review N6: rapporttestene gjelder RAPPORTEN (format, dekning, arbeidsliste, koden følger vaktens dom) - ikke selve vaktens dom, som er `guard.test.ts` (PORTEN) sitt ansvar. Dermed blir de ikke røde av en urelatert WP som legger til en bygd registeroppføring. */
const FULL_IDS = FULL_MANIFESTS.map((m) => m.identity.id);

describe("report guard (runbook §10 steg 2)", () => {
  it("viser vaktens dom, dekningen og arbeidslisten - og connectorer med fullt manifest står IKKE i arbeidslisten; koden følger vaktens dom", async () => {
    const r = await capture(["guard"]);
    const ok = r.out.includes("CI-vakt: OK (0 brudd)");
    expect(r.code).toBe(ok ? 0 : 1);
    expect(r.out).toMatch(/^CI-vakt: (OK|BRUDD) \(\d+ brudd\)$/m);
    expect(r.out).toContain(`fulle manifester: ${FULL_IDS.join(", ")}`);
    expect(r.out).toContain("Arbeidsliste");
    // Hver linje i arbeidslisten bærer «(i baselinen)» NÅR og bare når id-en står i den committede baselinen (ingen pinnet connector - baselinen kan legitimt krympe).
    const lines = [...r.out.matchAll(/^\s+\d+\s+([a-z0-9_]+)(\s+\(i baselinen\))?$/gm)];
    expect(lines.length).toBeGreaterThan(0);
    for (const m of lines) expect(m[2] !== undefined, m[1]).toBe(SKELETON_BASELINE.includes(m[1]!));
    for (const full of FULL_IDS) expect(r.out, full).not.toMatch(new RegExp(`^\\s+\\d+\\s+${full}\\b`, "m"));
  });

  it("--json gir hele rapporten maskinlesbart", async () => {
    const r = await capture(["guard", "--json"]);
    const j = JSON.parse(r.out) as { ok: boolean; violations: unknown[]; coverage: { full: string[]; skeleton: number; skeleton_baseline: number; unknown_fields_by_connector: Record<string, number> } };
    expect(r.code).toBe(j.ok ? 0 : 1);
    expect(j.ok).toBe(j.violations.length === 0);
    expect(j.coverage.full).toEqual(FULL_IDS);
    expect(Object.keys(j.coverage.unknown_fields_by_connector).length).toBe(j.coverage.skeleton);
    // Review N6: baselinen kan legitimt krympe - rapporten skal gjengi den committede, ikke et pinnet tall (`> 40` ble rødt av en god endring).
    expect(j.coverage.skeleton_baseline).toBe(SKELETON_BASELINE.length);
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
  it("node --experimental-transform-types modules/connector-sdk/scripts/report.ts guard kjører fra repo-roten (kode 0 når vakten er grønn, 1 ved brudd - aldri 2/uventet) og viser dommen", () => {
    const r = spawnSync(process.execPath, ["--experimental-transform-types", "modules/connector-sdk/scripts/report.ts", "guard"], { cwd: ROOT, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(r.stdout.includes("CI-vakt: OK (0 brudd)") ? 0 : 1);
    expect(r.stdout).toMatch(/^CI-vakt: (OK|BRUDD) \(\d+ brudd\)$/m);
    expect(r.stderr).not.toContain("UVENTET");
    const c = spawnSync(process.execPath, ["--experimental-transform-types", SCRIPT, "contract", "stripe"], { cwd: ROOT, encoding: "utf8" });
    expect(c.status, c.stderr).toBe(0);
    expect(c.stdout).toContain("Kontraktstest-kit for stripe: OK");
  });
});

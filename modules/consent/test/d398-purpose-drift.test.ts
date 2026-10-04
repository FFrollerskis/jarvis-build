import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-398 (JARVIS-084, drift-vakt): `ConsentPurpose` har to verdier, men kun `attribution` evalueres av produksjonskode (growth kaller `ConsentEnforcementService.enforce(..., "attribution", ...)`).
 * `tracking` er et dokumentert, bevisst IKKE-aktivert fremtidig formål (D-91). Ny verdi i typen UTEN enten et enforce-kallsted eller en begrunnet oppføring her skal feile -
 * ellers får vi nok et formål som finnes i modellen men aldri håndheves.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const DOCUMENTED_NOT_YET_ENFORCED: Record<string, string> = {
  tracking: "D-91: fremtidig formål (ingen sporingsflate er bygget); `attribution` aktiverer ALDRI `tracking` implisitt (purpose-spesifikk, enforcement-service.ts)"
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === "test" || e === ".git") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.ts$/.test(e) && !e.endsWith(".d.ts")) out.push(f);
  }
  return out;
}

describe("ConsentPurpose-dekning", () => {
  const types = readFileSync(join(ROOT, "modules/consent/src/types.ts"), "utf8");
  const purposes = [...(/export type ConsentPurpose\s*=\s*([^;]+);/.exec(types)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);

  it("typen har verdier (parseren fant dem)", () => {
    expect(purposes.length).toBeGreaterThanOrEqual(2);
  });

  it("hvert formål har et enforce-kallsted utenfor consent-modulen, eller er eksplisitt dokumentert som ikke-aktivert", () => {
    const sources = ["apps", "modules", "packages"].flatMap((r) => walk(join(ROOT, r)))
      .filter((f) => !f.includes("/modules/consent/"))
      .map((f) => readFileSync(f, "utf8"));
    for (const purpose of purposes) {
      const enforced = sources.some((src) => new RegExp(`\\.enforce\\([^)]*"${purpose}"|enforce\\([^)]*"${purpose}"`, "s").test(src) || new RegExp(`consentPurpose[^\\n]*"${purpose}"|"${purpose}"\\s*as ConsentPurpose`).test(src));
      if (!enforced) expect(DOCUMENTED_NOT_YET_ENFORCED, `${purpose} har ingen enforce-bruk og er ikke dokumentert`).toHaveProperty(purpose);
    }
  });

  it("dokumentasjonslisten er ærlig: ingen oppført verdi finnes ikke lenger i typen", () => {
    for (const p of Object.keys(DOCUMENTED_NOT_YET_ENFORCED)) expect(purposes).toContain(p);
  });
});

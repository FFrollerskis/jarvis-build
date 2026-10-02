import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOST_ACCEPTANCE_CONSENT_ENV,
  HOST_ACCEPTANCE_CONSENT_VALUE,
  ProductionMutationConsentError,
  requireProductionMutationConsent
} from "../scripts/lib/production-mutation-guard.ts";

/**
 * Remediation part 1 / JARVIS-086: host acceptance scripts mutate the live stack (rebuild, force-
 * recreate api/worker, toggle real kill switches). They must not run without explicit consent.
 */
const modulesDir = fileURLToPath(new URL("../..", import.meta.url));

function hostRunScripts(): string[] {
  return readdirSync(modulesDir)
    .flatMap((mod) => {
      try {
        return readdirSync(join(modulesDir, mod, "scripts")).filter((f) => f.endsWith("-host-run.ts")).map((f) => join(modulesDir, mod, "scripts", f));
      } catch {
        return [];
      }
    })
    .sort();
}

describe("production-mutation guard", () => {
  it("kaster uten samtykke og med feil verdi, passerer med nøyaktig verdi", () => {
    expect(() => requireProductionMutationConsent("x.ts", {})).toThrow(ProductionMutationConsentError);
    expect(() => requireProductionMutationConsent("x.ts", { [HOST_ACCEPTANCE_CONSENT_ENV]: "true" })).toThrow(/refuses to run/);
    expect(() => requireProductionMutationConsent("x.ts", { [HOST_ACCEPTANCE_CONSENT_ENV]: HOST_ACCEPTANCE_CONSENT_VALUE })).not.toThrow();
  });

  it("HVER *-host-run.ts-script kaller guarden med sitt eget filnavn, FØR resten av scriptet", () => {
    const scripts = hostRunScripts();
    expect(scripts.length).toBeGreaterThanOrEqual(25);
    for (const file of scripts) {
      const src = readFileSync(file, "utf8");
      const call = `requireProductionMutationConsent("${basename(file)}");`;
      expect(src, basename(file)).toContain(call);
      // guard-kallet står før første funksjon-/kjøringskode (etter importene)
      const callIdx = src.indexOf(call);
      const firstExecIdx = src.search(/^(const |function |async function |let |await )/m);
      expect(callIdx, basename(file)).toBeLessThan(firstExecIdx);
    }
  });

  it("de to kontrollbryter-live-scriptene (d174, K1) er også vernet", () => {
    for (const f of ["executive/scripts/d174-executive-control-surface-live.ts", "owner-controls/scripts/k1-owner-control-authority-live.ts"]) {
      expect(readFileSync(join(modulesDir, f), "utf8")).toContain("requireProductionMutationConsent(");
    }
  });

  it("ATFERD: et ekte host-run-script avslutter ikke-null uten samtykke, uten å gjøre noe (feiler ved innlasting)", () => {
    const script = join(modulesDir, "watchdog/scripts/w1-watchdog-durability-host-run.ts");
    const env: NodeJS.ProcessEnv = { PATH: process.env["PATH"] };
    const res = spawnSync(process.execPath, ["--experimental-transform-types", script], { env, encoding: "utf8", timeout: 60_000 });
    expect(res.status).not.toBe(0);
    expect(`${res.stderr}${res.stdout}`).toContain("refuses to run");
    expect(`${res.stderr}${res.stdout}`).not.toMatch(/docker compose|pnpm install/);
  });
});

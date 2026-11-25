import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_GITHUB_REPO, LEGACY_GITHUB_REPOS } from "@jarvis/contracts";
import { configuredGithubRepo } from "@jarvis/tool-gateway";
import { SelfModificationService, type SelfModificationServiceDeps } from "../src/service.ts";

/**
 * WP-A1 (D-479, JARVIS-117 a): selvmodifikasjonens standardrepo følger SAMME definisjon av «konfigurert repo» som repolåsen (Q-50 B), connectorens live-test og
 * mesh-verktøyet. Før rettingen var standarden `process.env["JARVIS_GITHUB_REPO"] ?? CANONICAL`: compose setter variabelen TOM som standard (`JARVIS_GITHUB_REPO: ${JARVIS_GITHUB_REPO:-}`),
 * og `"" ?? CANONICAL` er `""` - altså en tom repo-slug og URL-en `https://github.com/.git`. Konstruktøren bruker kun `repoSlug`/`baseBranch`/`budgetLock`/`changeLedger`, så testen trenger ingen database.
 */
const ENV = "JARVIS_GITHUB_REPO";
let saved: string | undefined;
beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV]; });
afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

function repoSlugOf(deps: Partial<SelfModificationServiceDeps> = {}): string {
  const service = new SelfModificationService({ ownerPersonId: "owner", ...deps } as unknown as SelfModificationServiceDeps);
  return (service as unknown as { repoSlug: string }).repoSlug;
}

describe("SelfModificationService: standardrepo", () => {
  it("uten, tom, blank eller ugyldig JARVIS_GITHUB_REPO brukes det kanoniske repoet (aldri en tom slug)", () => {
    expect(repoSlugOf()).toBe(CANONICAL_GITHUB_REPO);
    for (const bad of ["", "   ", "\n", "ugyldig", "a/b/c", "https://github.com/acme/app", "acme/", "/app"]) {
      process.env[ENV] = bad;
      expect(repoSlugOf(), JSON.stringify(bad)).toBe(CANONICAL_GITHUB_REPO);
    }
  });

  it("en gyldig verdi vinner (trimmet), også det gamle repoet når eieren velger det; eksplisitt deps.repoSlug vinner over miljøet", () => {
    process.env[ENV] = "  acme/app \n";
    expect(repoSlugOf()).toBe("acme/app");
    process.env[ENV] = LEGACY_GITHUB_REPOS[0] as string;
    expect(repoSlugOf()).toBe(LEGACY_GITHUB_REPOS[0]);
    process.env[ENV] = "acme/app";
    expect(repoSlugOf({ repoSlug: "other/repo" })).toBe("other/repo");
  });

  it("er enig med repolåsen og connectoren: samme repo for hver verdi", () => {
    for (const value of [undefined, "", "   ", "acme/app", " acme/app ", "ugyldig", "https://github.com/acme/app"]) {
      if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
      expect(repoSlugOf(), JSON.stringify(value)).toBe(configuredGithubRepo(process.env));
    }
  });
});

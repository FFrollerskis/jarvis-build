import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as main from "../src/index.ts";
import * as testing from "../src/testing.ts";
// @ts-expect-error -- harness-typer finnes kun i testing-inngangen: typecheck feiler hvis hovedinngangen begynner å eksportere dem (og `ContractAdapter` mangler da feilen her)
import type { ContractAdapter } from "../src/index.ts";

/**
 * WP-I (D-472), review M1 (D-396/JARVIS-096): hovedinngangen til `@jarvis/connector-sdk` eksporterer INGEN fake-/harness-symboler. Harnessen bærer med vilje brutale defekter (`leaks_credential`,
 * `cross_tenant_allowed` ...) og skal ikke kunne dra inn i en produksjons-API-modulgraf hvis `apps/api` en dag importerer pakken (connector-gjeld, runbook §8). Den nås kun via `./testing`.
 *
 * Merk: D-396-vakten (`modules/core/test/d396-fake-export-guard.test.ts`) matcher kun `export class Fake*|Scripted*|InMemory*|Mock*` i src/ og er UENDRET; denne testen er en NY, strengere vakt
 * for akkurat denne pakkens hovedinngang (funksjoner og konstanter, ikke bare klasser, og import-grafen).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const SRC = join(PKG, "src");

/** De åtte harness-symbolene review M1 fant i hovedbarrelen. */
const HARNESS_SYMBOLS = ["FAKE_DEFECTS", "createFakeConnector", "VirtualClock", "FAKE_TENANT", "FAKE_CREDENTIAL_CANARY", "secretShapes", "INJECTION_PAYLOAD", "settle"] as const;

/** Mønstre for test-doubles: Fake*, create*Fake*, FAKE_*, Virtual*, Scripted*, InMemory*, Mock*, Canary. */
const DOUBLE_PATTERNS: readonly RegExp[] = [/^Fake/, /Fake/, /^FAKE_/, /^Virtual/, /^Scripted/, /^InMemory/, /^Mock/, /Canary/i, /^create.*Fake/];

/** Alle kildefiler som nås fra en inngang via relative importer (også `import type` - strengere enn kjøretidsgrafen). */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\bfrom\s*"(\.{1,2}\/[^"]+)"/g)) stack.push(resolve(dirname(file), m[1]!));
  }
  return seen;
}

const rel = (p: string): string => relative(PKG, p).split(sep).join("/");

describe("hovedinngangen har ingen fake-/harness-symboler (D-396)", () => {
  const mainNames = Object.keys(main);
  const testingNames = Object.keys(testing);

  it("ingen av de åtte harness-symbolene eksporteres fra hovedinngangen", () => {
    for (const name of HARNESS_SYMBOLS) expect(mainNames, name).not.toContain(name);
  });

  it("ingen eksport i hovedinngangen matcher Fake*/create*Fake*/FAKE_*/Virtual*/Canary-mønstrene", () => {
    const hits = mainNames.filter((n) => DOUBLE_PATTERNS.some((re) => re.test(n)));
    expect(hits).toEqual([]);
  });

  it("flyttingen er reell: alle åtte symbolene finnes i testing-inngangen (de er flyttet, ikke slettet), og testing-inngangen eksporterer ikke noe fra hovedinngangen på nytt", () => {
    for (const name of HARNESS_SYMBOLS) expect(testingNames, name).toContain(name);
    for (const name of ["runConnectorContract", "scoreAcceptance", "CONTRACT_CHECK_IDS"]) expect(testingNames, name).toContain(name);
    const overlap = testingNames.filter((n) => mainNames.includes(n));
    expect(overlap).toEqual([]);
  });

  it("review N3: proveniens-branden (brandRealTransportAdapter/adapterKindOf) er modul-privat - ikke eksportert fra noen inngang, og ikke nådd via barrel-eksporter", () => {
    for (const name of ["brandRealTransportAdapter", "adapterKindOf"]) {
      expect(mainNames, name).not.toContain(name);
      expect(testingNames, name).not.toContain(name);
    }
    const barrels = [join(SRC, "index.ts"), join(SRC, "testing.ts"), join(SRC, "contract", "index.ts")].map((f) => readFileSync(f, "utf8"));
    for (const text of barrels) expect(/provenance/.test(text)).toBe(false);
  });

  it("hovedinngangen er uendret i det den skal gi: validator, avledning, katalog, vakt, gjeld og referansemanifestene", () => {
    for (const name of ["validateConnectorManifest", "deriveSkeletonManifests", "buildManifestCatalogue", "runManifestGuard", "computeConnectorDebt", "FULL_MANIFESTS", "productionConnectorDefinitions", "ConnectorManifestSchema"]) {
      expect(mainNames, name).toContain(name);
    }
  });
});

describe("import-grafen: hovedinngangen når aldri contract/ eller testing.ts", () => {
  const graph = [...importGraph(join(SRC, "index.ts"))].map(rel);

  it("ingen fil som nås fra src/index.ts ligger i src/contract/ eller er src/testing.ts", () => {
    expect(graph.filter((f) => f.startsWith("src/contract/") || f === "src/testing.ts")).toEqual([]);
  });

  it("grafen er ikke tom (testen er ikke vakuøs): manifest, validator, vakt og gjeld er med", () => {
    for (const f of ["src/manifest.ts", "src/validate.ts", "src/guard.ts", "src/debt.ts", "src/health-state.ts", "src/manifests/github.ts"]) expect(graph, f).toContain(f);
  });

  it("testing-inngangen når kittet, harnessen og klokken, og de når ikke tilbake til hovedbarrelen (src/index.ts)", () => {
    const t = [...importGraph(join(SRC, "testing.ts"))].map(rel);
    for (const f of ["src/contract/kit.ts", "src/contract/fake.ts", "src/contract/clock.ts", "src/contract/scoring.ts"]) expect(t, f).toContain(f);
    expect(t).not.toContain("src/index.ts");
  });
});

describe("pakkens exports-kart", () => {
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { exports: Record<string, string> };

  it("har nøyaktig «.» -> src/index.ts og «./testing» -> src/testing.ts, og filene finnes", () => {
    expect(pkg.exports).toEqual({ ".": "./src/index.ts", "./testing": "./src/testing.ts" });
    for (const target of Object.values(pkg.exports)) expect(existsSync(join(PKG, target)), target).toBe(true);
  });

  it("hovedbarrelen re-eksporterer ikke testing eller contract (kildeskanning av export-linjene)", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    const exportLines = index.split("\n").filter((l) => /^\s*export\b/.test(l));
    expect(exportLines.filter((l) => /testing|contract/.test(l))).toEqual([]);
  });
});

/** Type-låsen over (`@ts-expect-error`) trenger en bruk for at lint ikke skal klage på en ubrukt import. */
export type HarnessTypeNotInMain = ContractAdapter;

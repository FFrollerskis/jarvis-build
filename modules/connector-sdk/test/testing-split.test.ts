import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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
const ROOT = resolve(PKG, "..", "..");

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

// ---------------------------------------------------------------------------------------------------------------------
// Review N7: INGEN produksjonskilde importerer `@jarvis/connector-sdk/testing`. Før var det bare prosa; en regex-test over import-grafen (over) dekker pakkens EGEN graf, ikke de andre pakkene.
// ---------------------------------------------------------------------------------------------------------------------

/** Alle literale modulspesifikatorer en kildefil refererer, funnet med TypeScript-parseren (ikke regex): `import`, `export ... from`, `import x = require()`, `import()`, `require()`, `require.resolve()`, `createRequire(...)()`, `import.meta.resolve()`, `import("x").T`. */
export function moduleSpecifiers(fileName: string, text: string): string[] {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const out: string[] = [];
  const literal = (n: ts.Node | undefined): void => { if (n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))) out.push(n.text); };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) literal(n.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) literal(n.moduleReference.expression);
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) literal(n.argument.literal);
    else if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const isRequireLike =
        callee.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(callee) && callee.text === "require")
        || (ts.isPropertyAccessExpression(callee) && ((ts.isIdentifier(callee.expression) && callee.expression.text === "require") || ts.isMetaProperty(callee.expression) || callee.name.text === "require"))
        || (ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "createRequire");
      if (isRequireLike) literal(n.arguments[0]);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return out;
}

/** Er spesifikatoren (fra `fromFile`) en vei til SDK-ets test-/harness-kode? Pakkens eneste lovlige produksjonsinngang er `@jarvis/connector-sdk` (hovedinngangen); ALT under den (`/testing` er den eneste som finnes) og alle relative stier inn i `src/testing`, `src/contract/`, `test/` eller `scripts/` er brudd. */
export function reachesSdkTesting(spec: string, fromFile: string): boolean {
  if (spec === "@jarvis/connector-sdk") return false;
  if (spec.startsWith("@jarvis/connector-sdk/")) return true;
  if (!spec.startsWith(".") && !spec.startsWith("/")) return false;
  const target = resolve(dirname(fromFile), spec).split(sep).join("/");
  const sdk = PKG.split(sep).join("/");
  return target.startsWith(`${sdk}/`) && /^\/(src\/(testing|contract)|test|scripts)(\/|\.|$)/.test(target.slice(sdk.length));
}

/** Produksjonskilder: `src/`-mappen i hver pakke under apps, modules (unntatt connector-sdk selv) og packages, uten tester (filer med `.test.` eller `.spec.` i navnet), `node_modules` og `dist`. */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(full);
    }
  };
  for (const group of ["apps", "modules", "packages"]) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base, { withFileTypes: true })) {
      if (!pkg.isDirectory() || join(base, pkg.name) === PKG) continue;
      const src = join(base, pkg.name, "src");
      if (existsSync(src)) walk(src);
    }
  }
  return out;
}

describe("review N7: ingen produksjonskilde importerer @jarvis/connector-sdk/testing (harnessen med FAKE_DEFECTS hører ikke hjemme i en produksjonsmodulgraf)", () => {
  const files = productionSources();

  it("skanningen er ikke vakuøs (mange kilder i apps/modules/packages, connector-sdk selv holdt utenfor) og ingen kilde refererer test-inngangen - uansett import-form", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.startsWith(`${PKG}${sep}`))).toBe(false);
    expect(files.some((f) => f.includes(`${sep}apps${sep}api${sep}src${sep}`))).toBe(true);
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (!text.includes("connector-sdk")) continue; // hver relevant spesifikator inneholder «connector-sdk»; parseren kjøres bare der det er noe å finne
      for (const spec of moduleSpecifiers(f, text)) if (reachesSdkTesting(spec, f)) offenders.push(`${relative(ROOT, f)}: ${spec}`);
    }
    expect(offenders).toEqual([]);
  });

  it("detektoren fanger hver import-form (selvtest: import, import type, side-effekt-import, export * / { } / type from, import(), require(), import x = require(), import(\"x\").T, mal-literal, createRequire, require.resolve, import.meta.resolve, flerlinjers med kommentarer, relativ dypimport)", () => {
    const T = "@jarvis/connector-sdk/testing";
    const from = join(ROOT, "apps", "api", "src", "x.ts");
    const hits = (code: string, file = from): string[] => moduleSpecifiers(file, code).filter((s) => reachesSdkTesting(s, file));
    const forms: Array<[string, string]> = [
      ["import", `import { runConnectorContract } from "${T}";`], ["import type", `import type { FakeDefect } from "${T}";`], ["side-effekt", `import "${T}";`],
      ["export *", `export * from "${T}";`], ["export { }", `export { createFakeConnector } from "${T}";`], ["export type", `export type { FakeDefect } from '${T}';`],
      ["import()", `const m = await import("${T}");`], ["require()", `const m = require("${T}");`], ["import x = require()", `import m = require("${T}");`],
      ["import type-node", `type D = import("${T}").FakeDefect;`], ["mal-literal", `const m = await import(\`${T}\`);`], ["createRequire", `createRequire(import.meta.url)("${T}");`],
      ["require.resolve", `require.resolve("${T}");`], ["import.meta.resolve", `import.meta.resolve("${T}");`], ["module.require", `module.require("${T}");`],
      ["flerlinjers", `import {\n  // kommentar\n  a,\n  b /* mer */,\n} from\n  "${T}";`],
      ["relativ dypimport", `import { runConnectorContract } from "../../../modules/connector-sdk/src/testing.ts";`], ["relativ dypimport contract", `import { x } from "../../../modules/connector-sdk/src/contract/kit.ts";`]
    ];
    for (const [label, code] of forms) expect(hits(code).length, label).toBeGreaterThan(0);
    expect(hits(`const m = require("${T}");`, join(ROOT, "apps", "api", "src", "y.cjs")).length, "cjs").toBeGreaterThan(0);
    expect(hits(`import { x } from "${T}"; export const C = () => <div />;`, join(ROOT, "apps", "web", "src", "z.tsx")).length, "tsx").toBeGreaterThan(0);
    // ...og flagger IKKE det som er lovlig eller ikke en import:
    const fine: Array<[string, string]> = [
      ["hovedinngangen", `import { validateConnectorManifest } from "@jarvis/connector-sdk";`], ["kommentar", `// import "${T}";\n/* import x from "${T}" */`],
      ["vanlig streng", `const s = "${T}"; console.log(\`${T}\`);`], ["annen pakkes /testing", `import { x } from "@jarvis/core/testing";`],
      ["relativ til hovedbarrelen", `import { x } from "../../../modules/connector-sdk/src/index.ts";`], ["ikke-literal", "const n = 'testing'; await import(`@jarvis/connector-sdk/${n}`);"]
    ];
    for (const [label, code] of fine) expect(hits(code), label).toEqual([]);
  });

  it("kjente grenser (ærlig): en beregnet spesifikator (`import(`...${n}`)`) kan ingen statisk analyse se - kun literale spesifikatorer dekkes", () => {
    const from = join(ROOT, "apps", "api", "src", "x.ts");
    expect(moduleSpecifiers(from, "await import(`@jarvis/connector-sdk/${n}`);")).toEqual([]);
  });
});

/** Type-låsen over (`@ts-expect-error`) trenger en bruk for at lint ikke skal klage på en ubrukt import. */
export type HarnessTypeNotInMain = ContractAdapter;

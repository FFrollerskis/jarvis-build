import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gateVerdict } from "../src/program/baseline.ts";
import { BASELINE_ORIGIN } from "../src/program/baseline-origin.ts";
import { ERROR_CODE_DEFS } from "../src/error-codes.ts";
import { loadProgramData } from "../src/program/fs-loader.ts";
import { buildProgramIndex } from "../src/program/index-builder.ts";
import { formatReport, runProgramIndex } from "../src/program/run.ts";

/**
 * WP-PGA / PG1+PG3: programindeksen mot det VIRKELIGE repoet. Modusen (`guard.mode` i manifestet, evt. hevet av `PROGRAM_INDEX_MODE=enforce`) styrer om funn feiler bygget:
 *  - `report` (standard): funnene skrives ut, men kun baseline-ratchet og dataintegritet (ugyldige/løse filer, ufullstendig portsett) feiler;
 *  - `enforce`: funn utenfor baselinen feiler også.
 * Kjør strengt lokalt: `PROGRAM_INDEX_MODE=enforce pnpm exec vitest run packages/contracts/test/program-index-repo.test.ts`.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const run = runProgramIndex({ root: ROOT, env: process.env["PROGRAM_INDEX_MODE"] });

describe(`programindeksen mot repoet (modus: ${run.mode.mode})`, () => {
  it("dommen: baseline-ratchet alltid; i enforce også nye funn (rapporten skrives ut når det finnes funn)", () => {
    if (run.findings.length > 0) console.warn(`\n${formatReport(run, 100)}\n`);
    expect(run.verdict.failures, formatReport(run, 100)).toEqual([]);
    expect(run.verdict.ok).toBe(true);
  });

  it("dataintegritet er rød i begge moduser: ingen ugyldige, løse eller feilnavngitte datafiler, og komplett port-/nivåsett", () => {
    expect(loadProgramData(ROOT).findings).toEqual([]);
    expect(run.findings.filter((f) => f.rule === "gate_set_incomplete")).toEqual([]);
    const total = (c: { OPEN: number; PASS: number; FAIL: number }): number => c.OPEN + c.PASS + c.FAIL;
    expect(total(run.counts.gates_declared)).toBe(17);
    expect(total(run.counts.orls_declared)).toBe(6);
  });

  it("baselinen kan bare krympe: ingen vekst utover den frosne origin-listen, ingen foreldede oppføringer", () => {
    expect(run.baseline.growth_entries).toEqual([]);
    expect(run.baseline.stale_entries).toEqual([]);
    const ids = loadProgramData(ROOT).baseline.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(BASELINE_ORIGIN).toContain(id);
  });

  it("moduser er monotone: det som er ok i enforce er også ok i report", () => {
    for (const result of [run.baseline, { ...run.baseline, new_findings: [] }, { ...run.baseline, growth_entries: ["x:y"] }]) {
      if (gateVerdict("enforce", result).ok) expect(gateVerdict("report", result).ok).toBe(true);
    }
    // Vekst og foreldede oppføringer er røde i begge moduser; nye funn kun i enforce.
    const fake = { new_findings: [{ rule: "table_orphan", component_id: null, subject: "t", id: "table_orphan:t", message: "m" }], known_findings: [], stale_entries: [], growth_entries: [] };
    expect(gateVerdict("report", fake).ok).toBe(true);
    expect(gateVerdict("enforce", fake).ok).toBe(false);
    expect(gateVerdict("report", { ...fake, new_findings: [], stale_entries: ["a:b"] }).ok).toBe(false);
    expect(gateVerdict("report", { ...fake, new_findings: [], growth_entries: ["a:b"] }).ok).toBe(false);
  });

  it("skanningen leser faktisk repoet (en feil rot ville gitt null funn og null dekning): gulv fra første fyll", () => {
    expect(run.counts.tables_total).toBeGreaterThanOrEqual(182);
    expect(run.counts.migrations_total).toBeGreaterThanOrEqual(121);
    expect(run.counts.workspace_dirs).toBeGreaterThanOrEqual(37);
    expect(run.counts.services_total).toBeGreaterThanOrEqual(10);
    expect(run.counts.components_total).toBeGreaterThanOrEqual(76);
    expect(run.counts.event_types).toBeGreaterThanOrEqual(28);
  });

  it("indeksen er deterministisk: samme digest uansett lesrekkefølge", () => {
    const data = loadProgramData(ROOT);
    const a = buildProgramIndex(data.manifest, data.components, data.gates, data.orls);
    const b = buildProgramIndex(data.manifest, [...data.components].reverse(), [...data.gates].reverse(), [...data.orls].reverse());
    expect(b.digest).toBe(a.digest);
    expect(a.digest).toBe(run.index.digest);
  });

  it("DX0 (feilkode-registeret): hver feilkodes eier er en komponent i programindeksen", () => {
    const ids = new Set(run.index.components.map((c) => c.component_id));
    expect(ERROR_CODE_DEFS.filter((d) => !ids.has(d.owner)).map((d) => `${d.code} -> ${d.owner}`)).toEqual([]);
  });

  it("alle komponenter er ærlige ved første fyll: ingenting er VERIFIED uten evidens, ingen komponent eies av en person", () => {
    for (const c of run.index.components) {
      if (c.verification === "VERIFIED") expect(c.evidence_ref, c.component_id).not.toBeNull();
      expect(["owner", "platform_operator"]).toContain(c.owner.role);
    }
  });
});

describe("BUILT_UNWIRED: programmodulen er ikke koblet inn i kjøretid", () => {
  const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".claude"]);
  function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) sources(abs, out);
      else if (/\.(?:ts|mts|mjs|js|tsx)$/.test(name)) out.push(abs);
    }
    return out;
  }

  /** ALLE modulene i src/program (fra katalogen, så en ny modul automatisk er med: fiks 1 L2 fant at vakten bare kjente 10 av 17). */
  const PROGRAM_MODULES = readdirSync(join(ROOT, "packages/contracts/src/program"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.slice(0, -3))
    .sort();
  /** En import-form som peker på en programmodul: `from "…/program/x"`, `import "…/program/x"`, `import("…/program/x")`, `require("…/program/x")` og `export … from`, med eller uten .ts. */
  const IMPORT_OF_PROGRAM = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+|\\brequire\\s*\\(\\s*)["'][^"']*\\/program\\/(?:${PROGRAM_MODULES.join("|")})(?:\\.ts)?["']`);

  it("vakten kjenner alle programmodulene (ikke bare de ti den første versjonen listet) og er ikke tom", () => {
    expect(PROGRAM_MODULES.length).toBeGreaterThanOrEqual(20);
    for (const m of ["hash", "ids", "semver", "sql-schema", "findings", "baseline-origin", "gate-events", "gates", "run", "scan", "schema", "fs-loader", "index-builder", "gate-recorder", "fingerprint-tool", "baseline", "mode", "evidence-header", "file-lock", "frozen-rules"]) {
      expect(PROGRAM_MODULES, m).toContain(m);
    }
  });

  it("detektoren fanger alle import-former mot alle moduler (reviewerens koblings-prober: hash, run via import(), gates, gate-events, baseline-origin), og ingenting annet", () => {
    for (const m of PROGRAM_MODULES) {
      for (const form of [`import { x } from "../../../packages/contracts/src/program/${m}.ts";`, `import { x } from '../program/${m}';`, `import "../program/${m}.ts";`, `const x = (await import("../../packages/contracts/src/program/${m}.ts")).x;`, `const x = require("../program/${m}");`, `export * from "../program/${m}.ts";`, `export { x } from "./program/${m}";`, `import {\n  x\n} from\n"../program/${m}.ts";`]) {
        expect(IMPORT_OF_PROGRAM.test(form), form).toBe(true);
      }
    }
    for (const innocent of ['import { x } from "../program/ukjent-modul.ts";', 'import { x } from "../programs/hash.ts";', 'const s = "program/hash";', "// program/hash.ts er bare nevnt", 'import { x } from "./hash.ts";', 'import { x } from "../src/error-codes.ts";']) {
      expect(IMPORT_OF_PROGRAM.test(innocent), innocent).toBe(false);
    }
  });

  it("ingen kildefil utenfor src/program, test og scripts importerer program/-modulene (statisk eller dynamisk), og barrelen eksporterer dem ikke", () => {
    const allowedPrefixes = ["packages/contracts/src/program/", "packages/contracts/test/", "packages/contracts/scripts/", "ops/acceptance/"];
    const offenders: string[] = [];
    for (const top of ["apps", "modules", "packages", "ops"]) {
      for (const file of sources(join(ROOT, top))) {
        const rel = relative(ROOT, file).split("\\").join("/");
        if (allowedPrefixes.some((p) => rel.startsWith(p)) || /\/test\//.test(rel)) continue;
        if (IMPORT_OF_PROGRAM.test(readFileSync(file, "utf8"))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
    const barrel = readFileSync(join(ROOT, "packages/contracts/src/index.ts"), "utf8");
    expect(barrel).not.toMatch(/\.\/program\//);
    expect(barrel).toContain('export * from "./error-codes.ts"');
  });
});

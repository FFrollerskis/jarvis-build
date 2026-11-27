import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLASS_C_COVERAGE } from "@jarvis/tool-gateway";

/**
 * WP-AUTH2a (K5/K8): DRIFT-TEST for runbooken `docs/runbooks/WPAUTH2A_CLASS_C.md`. Dekningstabellen i runbooken (alle klasse C-handlinger: handling, status, kode:linje, test) skal være NØYAKTIG den samme som
 * `CLASS_C_COVERAGE` i koden: samme nøkler, samme status og kategori, kodereferanser som faktisk peker på riktig linje, og testfiler som finnes. Endres koden uten at tabellen regenereres, feiler denne testen
 * og viser hva som avviker. Ren filtest (ingen database).
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RUNBOOK_PATH = "docs/runbooks/WPAUTH2A_CLASS_C.md";
const RUNBOOK = readFileSync(join(ROOT, RUNBOOK_PATH), "utf8");

interface Row { key: string; status: string; category: string | null; anchors: string; tests: string }

function coverageRows(): Row[] {
  const rows: Row[] = [];
  for (const line of RUNBOOK.split("\n")) {
    if (!/^\| `[a-z0-9_]+\.[a-z0-9_]+` \| `(covered|existing_chain|owner_override|deferred)` \| /.test(line)) continue;
    const cells = line.slice(2, -2).split(" | ");
    if (cells.length < 6) throw new Error(`tabellrad med feil antall kolonner: ${line.slice(0, 120)}`);
    const strip = (cell: string): string => cell.replace(/`/g, "");
    rows.push({ key: strip(cells[0]!), status: strip(cells[1]!), category: cells[2] === "-" ? null : strip(cells[2]!), anchors: cells[3]!, tests: cells[4]! });
  }
  return rows;
}

const ROWS = coverageRows();
const MANIFEST = Object.entries(CLASS_C_COVERAGE);

function lineOf(relativeToModules: string, line: number): string {
  const path = join(ROOT, "modules", relativeToModules);
  expect(existsSync(path), `${relativeToModules} finnes ikke`).toBe(true);
  const lines = readFileSync(path, "utf8").split("\n");
  expect(line, `${relativeToModules}:${line} er utenfor filen`).toBeGreaterThanOrEqual(1);
  expect(line, `${relativeToModules}:${line} er utenfor filen`).toBeLessThanOrEqual(lines.length);
  return lines[line - 1] ?? "";
}

describe("runbooken er sannhetstro mot dekningsmanifestet (CLASS_C_COVERAGE)", () => {
  it("tabellen har NØYAKTIG en rad per klasse C-handling i manifestet - ingen manglende, ingen ekstra, ingen duplikater", () => {
    const keys = ROWS.map((r) => r.key);
    expect(new Set(keys).size, "duplikate rader").toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.keys(CLASS_C_COVERAGE).sort());
    expect(ROWS.length).toBeGreaterThanOrEqual(100);
  });

  it("status og kategori i hver rad er lik manifestets", () => {
    for (const row of ROWS) {
      const entry = CLASS_C_COVERAGE[row.key]!;
      expect(row.status, row.key).toBe(entry.status);
      expect(row.category, row.key).toBe(entry.category ?? null);
    }
  });

  it("sumlinjen stemmer med manifestet (totalt og per status)", () => {
    const m = RUNBOOK.match(/\*\*Sum:\*\* (\d+) klasse C-handlinger = (\d+) `covered` \+ (\d+) `existing_chain` \+ (\d+) `owner_override` \+ (\d+) `deferred`\./);
    expect(m, "sumlinjen mangler eller har endret format").not.toBeNull();
    const count = (status: string): number => MANIFEST.filter(([, e]) => e.status === status).length;
    expect(Number(m![1])).toBe(MANIFEST.length);
    expect([Number(m![2]), Number(m![3]), Number(m![4]), Number(m![5])]).toEqual([count("covered"), count("existing_chain"), count("owner_override"), count("deferred")]);
  });

  it("hver kodereferanse (sti relativt til modules/, linje) peker på linjen som faktisk deklarerer handlingen", () => {
    for (const row of ROWS) {
      const anchors = [...row.anchors.matchAll(/`([A-Za-z0-9_./-]+):(\d+)`/g)].map((m) => ({ file: m[1]!, line: Number(m[2]) }));
      expect(anchors.length, `${row.key}: ingen kodereferanse`).toBeGreaterThanOrEqual(1);
      const seen = new Set<string>();
      for (const anchor of anchors) {
        const text = lineOf(anchor.file, anchor.line);
        if (anchor.file === "tool-gateway/src/class-c-coverage.ts") {
          expect(text.startsWith(`  "${row.key}": {`), `${row.key}: ${anchor.file}:${anchor.line} er ikke manifestlinjen (${text.slice(0, 60)})`).toBe(true);
          seen.add("coverage");
        } else if (anchor.file === "tool-gateway/src/class-c-pipeline.ts") {
          expect(text, `${row.key}: ${anchor.file}:${anchor.line}`).toContain("export function isClassCOwnerOverride");
          seen.add("owner");
        } else if (anchor.file === "growth/src/write/tool-factory.ts") {
          expect(text, `${row.key}: ${anchor.file}:${anchor.line}`).toContain("export function buildGrowthToolDefinitions");
          seen.add("chain");
        } else {
          expect(text, `${row.key}: ${anchor.file}:${anchor.line} er ikke adapterens deklarasjon`).toContain(`"${row.key}"`);
          seen.add("adapter");
        }
      }
      expect(seen.has("coverage"), `${row.key}: mangler manifestreferansen`).toBe(true);
      expect(seen.has("adapter"), `${row.key}: adapterreferanse kun for covered`).toBe(row.status === "covered");
      expect(seen.has("owner"), `${row.key}: eierreferanse kun for owner_override`).toBe(row.status === "owner_override");
      expect(seen.has("chain"), `${row.key}: kjedereferanse kun for existing_chain`).toBe(row.status === "existing_chain");
    }
  });

  it("hver testfil i tabellen finnes, og hver dekket handling har sin adaptertest", () => {
    const covered = ROWS.filter((r) => r.status === "covered");
    expect(covered.map((r) => r.key).sort()).toEqual([
      "business.update_lead_status", "drive.create_file", "drive.move", "drive.rename", "drive.trash", "drive.update_content", "github.create_pr", "growth.set_campaign_status"
    ]);
    for (const row of ROWS) {
      const tests = [...row.tests.matchAll(/`([A-Za-z0-9_./-]+\.test\.ts)`/g)].map((m) => m[1]!);
      expect(tests.length, `${row.key}: ingen testreferanse`).toBeGreaterThanOrEqual(1);
      for (const test of tests) expect(existsSync(join(ROOT, test)), `${row.key}: ${test} finnes ikke`).toBe(true);
      if (row.status === "covered") expect(tests.some((t) => t.includes("class-c-adapter")), `${row.key}: adaptertest mangler`).toBe(true);
    }
  });

  it("de åtte dekkede handlingene står også i adaptertabellen (§5), og runbooken nevner flagget, modusene og at alt er NOT VERIFIED", () => {
    for (const row of ROWS.filter((r) => r.status === "covered")) {
      expect(RUNBOOK.split(`| \`${row.key}\` |`).length - 1, `${row.key}: skal stå i både §5 og §7`).toBe(2);
    }
    for (const word of ["JARVIS_CLASS_C_PIPELINE", "observe", "enforce", "NOT VERIFIED", "DORMANT", "Rollback", "owner_override", "unobservable"]) expect(RUNBOOK, word).toContain(word);
    expect(RUNBOOK, "uoppløste plassholdere").not.toMatch(/@@[A-Z_]+@@/);
  });

  it("runbooken er norsk dokumentasjon uten hemmelighetslignende verdier eller lenker til slettede statusfiler", () => {
    expect(RUNBOOK).not.toMatch(/SESSION_LOG|HANDOFF_REPORT/);
    expect(RUNBOOK).not.toMatch(/(?:ghp|gho|sk-[a-z]{2,}|xox[bap])[-_][A-Za-z0-9]{16,}/);
  });
});

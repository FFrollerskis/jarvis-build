import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WP-J (D-450): lukkingsmatrisen (`docs/CLOSURE_MATRIX_HF1_HF2.md`) er ett sted som viser hva som er bygget, koblet, sovende, ikke bygget og
 * verifisert for HF1/HF2. Den er et STATUSdokument (ADR-001 nivå 6), ikke et krav - men den kan ikke lyve: vakten håndhever bare ærlighetsreglene,
 * ikke at byggingen er ferdig.
 *   1. hver rad i en tabell med «Status»-kolonne bruker et kjent statusord (ingen frie «ferdig»/«fungerer»);
 *   2. `VERIFIED` står aldri uten et lenket artefakt i samme rad (evidensfil eller URL) - «NOT VERIFIED»/«IKKE VERIFIED» er alltid lov;
 *   3. dokumentet beholder sin egen ærlighetsregel (kanarifugl mot at den fjernes stille);
 *   4. kodestier som matrisen peker på (med rot modules/apps/ops/docs/infra/packages/config) finnes - dokumentet råtner ikke stille når filer flyttes.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const matrixPath = join(ROOT, "docs/CLOSURE_MATRIX_HF1_HF2.md");
const matrix = readFileSync(matrixPath, "utf8");

const ALLOWED_STATUS = ["WIRED", "DORMANT", "BUILT_UNWIRED", "NOT_BUILT", "CODE_FIXED", "VERIFIED", "BLOCKED_EXTERNAL", "DEFERRED", "PARTIAL", "BUILT"] as const;
const STATUS_WORD = new RegExp(`\\b(?:${ALLOWED_STATUS.join("|")})\\b`);
/** «NOT VERIFIED», «IKKE VERIFIED», «ikke `VERIFIED`» og «før … VERIFIED» er avkreftelser, ikke påstander. */
const NEGATED_VERIFIED = /(?:NOT|IKKE|ikke|not|aldri|før|uten)\s+`?VERIFIED/g;

interface Row {
  line: number;
  cells: string[];
  header: string[];
}

function tables(md: string): Row[] {
  const rows: Row[] = [];
  const lines = md.split("\n");
  let header: string[] | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.startsWith("|")) {
      header = null;
      continue;
    }
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue; // skillelinjen
    if (header === null) {
      header = cells;
      continue;
    }
    rows.push({ line: i + 1, cells, header });
  }
  return rows;
}

function expandBraces(path: string): string[] {
  const m = path.match(/^(.*)\{([^{}]+)\}(.*)$/);
  if (!m) return [path];
  return m[2]!.split(",").flatMap((alt) => expandBraces(`${m[1]}${alt.trim()}${m[3]}`));
}

const statusRows = tables(matrix).filter((r) => r.header.some((h) => /^status$/i.test(h)));

describe("lukkingsmatrisen HF1/HF2 er ærlig (WP-J)", () => {
  it("matrisen har tabeller med statuskolonne og dekker alle EV-radene", () => {
    expect(statusRows.length).toBeGreaterThanOrEqual(20);
    const ev = statusRows.filter((r) => /^EV-\d+/.test(r.cells[0] ?? ""));
    expect(ev.length).toBeGreaterThanOrEqual(20);
  });

  it("hver statusrad bruker et kjent statusord (ingen frie «ferdig»/«fungerer»)", () => {
    const bad: string[] = [];
    for (const r of statusRows) {
      const idx = r.header.findIndex((h) => /^status$/i.test(h));
      const cell = r.cells[idx] ?? "";
      if (!STATUS_WORD.test(cell)) bad.push(`l.${r.line} ${r.cells[0]}: «${cell.slice(0, 60)}»`);
    }
    expect(bad).toEqual([]);
  });

  it("VERIFIED står aldri uten lenket artefakt i samme rad", () => {
    const bad: string[] = [];
    for (const r of statusRows) {
      const idx = r.header.findIndex((h) => /^status$/i.test(h));
      const cell = (r.cells[idx] ?? "").replace(NEGATED_VERIFIED, "");
      if (!/\bVERIFIED\b/.test(cell)) continue;
      const row = r.cells.join(" | ");
      if (!/docs\/evidence\/|https:\/\//.test(row)) bad.push(`l.${r.line} ${r.cells[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it("dokumentet beholder sin ærlighetsregel (kanarifugl)", () => {
    expect(matrix).toContain("Ingenting under er `VERIFIED` før et artefakt");
    expect(matrix).toMatch(/Statusord/);
  });

  it("kodestier i matrisen finnes (modules/apps/ops/docs/infra/packages/config)", () => {
    const refs = new Set<string>();
    for (const m of matrix.matchAll(/`((?:modules|apps|ops|docs|infra|packages|config)\/[A-Za-z0-9_./{},*<>-]+)`/g)) {
      const raw = m[1]!;
      if (/[*<>]/.test(raw)) continue; // mønstre/plassholdere
      for (const p of expandBraces(raw)) refs.add(p.replace(/\/$/, ""));
    }
    expect(refs.size).toBeGreaterThan(10);
    const missing = [...refs].filter((p) => !existsSync(join(ROOT, p)) && !existsSync(join(ROOT, `${p}.ts`)) && !existsSync(join(ROOT, `${p}.md`))).sort();
    expect(missing).toEqual([]);
  });
});

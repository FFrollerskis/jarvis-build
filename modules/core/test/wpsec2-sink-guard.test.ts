import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WP-SEC2 K7e: STRUKTURVAKT for lagringssteder. Hver `INSERT INTO <tabell>`/`UPDATE <tabell> SET` i produktkoden (apps/modules/packages `src`) er klassifisert i `fixtures/secret-sink-baseline.json`:
 *  - `verified`: hand-kontrollert fritekst-sink - filen skriver til tabellen OG skanner teksten (beviset `evidence` finnes i filen);
 *  - `safe`: vurdert som kun id/enum/tall/hash/vektor (ingen fritekst);
 *  - `file_level`: filen kaller skanneren et sted (ikke bevist per kolonne);
 *  - `unreviewed`: ikke vurdert enkeltvis (DEFERRED/PARTIAL; se runbooken).
 * En NY (fil, tabell)-skriving som ikke står i baseline feller testen: skann teksten (og legg raden under `verified`), eller klassifiser den bevisst under `unreviewed` med en begrunnelse i runbooken. `audit_events` har kun ÉN skriver.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = JSON.parse(readFileSync(join(ROOT, "modules/core/test/fixtures/secret-sink-baseline.json"), "utf8")) as {
  verified: Array<{ table: string; file: string; evidence: string }>;
  safe: Array<{ file: string; tables: string[]; why: string }>;
  file_level: Array<{ file: string; tables: string[] }>;
  unreviewed: Array<{ file: string; tables: string[] }>;
};
const GENERAL_EVIDENCE = /scanForSecrets|containsSecret|redactSecrets|redactVendorText|vendorText\(|scanStructuredForSecrets|neutralizeUntrustedText|sanitizeDisplayText|sanitizeParameterValue|clipRedacted/;
const PAIR = /\b(INSERT\s+INTO|UPDATE)\s+([a-z_][a-z0-9_]*)\b/gi;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
}

/** (fil -> tabeller) for all produktkode: kun under `src/` (ikke test/scripts). */
function discover(): Map<string, Set<string>> {
  const files: string[] = [];
  for (const top of ["apps", "modules", "packages"]) {
    const base = join(ROOT, top);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base)) {
      const src = join(base, pkg, "src");
      if (existsSync(src)) walk(src, files);
    }
  }
  const found = new Map<string, Set<string>>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(PAIR)) {
      const kind = (m[1] as string).toUpperCase();
      const table = (m[2] as string).toLowerCase();
      const tail = text.slice((m.index as number) + m[0].length, (m.index as number) + m[0].length + 60);
      if (kind === "UPDATE" && !/^\s+(?:AS\s+\w+\s+|\w+\s+)?SET\b/i.test(tail)) continue;
      if (["the", "a", "of", "set", "table", "from", "into", "values", "select", "where"].includes(table)) continue;
      const rel = relative(ROOT, file);
      if (!found.has(rel)) found.set(rel, new Set());
      (found.get(rel) as Set<string>).add(table);
    }
  }
  return found;
}

describe("K7e: ingen ny lagringssted-skriving uten klassifisering", () => {
  const found = discover();
  const known = new Map<string, Set<string>>();
  const add = (file: string, table: string): void => {
    if (!known.has(file)) known.set(file, new Set());
    (known.get(file) as Set<string>).add(table);
  };
  for (const v of baseline.verified) add(v.file, v.table);
  for (const e of [...baseline.safe, ...baseline.file_level, ...baseline.unreviewed]) for (const t of e.tables) add(e.file, t);

  it("hver INSERT/UPDATE (fil, tabell) i produktkoden er klassifisert i baseline (en ny, uklassifisert skriving feller testen)", () => {
    const unclassified: string[] = [];
    for (const [file, tables] of found) for (const table of tables) if (!known.get(file)?.has(table)) unclassified.push(`${file} -> ${table}`);
    expect(unclassified, `nye lagringssteder uten klassifisering - skann teksten og legg dem til under «verified» i modules/core/test/fixtures/secret-sink-baseline.json (eller bevisst «unreviewed» + begrunnelse i runbooken):\n${unclassified.join("\n")}`).toEqual([]);
    expect(found.size).toBeGreaterThan(60);
  });

  it("hver `verified`-sink skriver fortsatt til tabellen og har fortsatt skannebeviset sitt i filen (fjernes skanningen, feller testen)", () => {
    expect(baseline.verified.length).toBeGreaterThanOrEqual(15);
    for (const v of baseline.verified) {
      const text = readFileSync(join(ROOT, v.file), "utf8");
      expect(found.get(v.file)?.has(v.table), `${v.file} skriver ikke lenger til ${v.table}`).toBe(true);
      expect(new RegExp(v.evidence).test(text), `${v.file}: skannebeviset /${v.evidence}/ for ${v.table} mangler`).toBe(true);
    }
  });

  it("`file_level`-filer kaller fortsatt skanneren et sted", () => {
    for (const e of baseline.file_level) {
      if (!existsSync(join(ROOT, e.file))) continue;
      expect(GENERAL_EVIDENCE.test(readFileSync(join(ROOT, e.file), "utf8")), `${e.file} kaller ikke lenger skanneren - flytt den til «unreviewed» bevisst`).toBe(true);
    }
  });

  it("`audit_events` har nøyaktig ÉN skriver (writeAudit), og den skanner reason og nyttelast", () => {
    const writers = [...found].filter(([, tables]) => tables.has("audit_events")).map(([file]) => file);
    expect(writers).toEqual(["modules/core/src/services/audit-writer.ts"]);
    const text = readFileSync(join(ROOT, writers[0] as string), "utf8");
    expect(text).toMatch(/scanForSecrets\(entry\.reason\)/);
    expect(text).toMatch(/scanStructuredForSecrets\(entry\.payload/);
  });
});

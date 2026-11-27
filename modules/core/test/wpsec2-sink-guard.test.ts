import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GENERAL_EVIDENCE, evidenceCount, stripComments, writesIn } from "./support/sink-guard.ts";

/**
 * WP-SEC2 K7e: STRUKTURVAKT for lagringssteder. Hver `INSERT INTO <tabell>`/`UPDATE <tabell> SET` i produktkoden (apps/modules/packages `src`) er klassifisert i `fixtures/secret-sink-baseline.json`:
 *  - `verified`: hand-kontrollert fritekst-sink - filen skriver til tabellen OG skanner teksten (beviset `evidence` finnes i filen, kommentarer ikke medregnet, minst `min_evidence` ganger; antall skrivinger er pinnet i `writes`);
 *  - `safe`: vurdert som kun id/enum/tall/hash/vektor (ingen fritekst);
 *  - `file_level`: filen kaller skanneren et sted (ikke bevist per kolonne);
 *  - `unreviewed`: ikke vurdert enkeltvis (DEFERRED/PARTIAL; se runbooken). Antallet har et TAK (`UNREVIEWED_PAIR_CEILING`) som bare kan krympe.
 * En NY (fil, tabell)-skriving som ikke står i baseline feller testen: skann teksten (og legg raden under `verified`), eller klassifiser den bevisst under `unreviewed` med en begrunnelse i runbooken. `audit_events` har kun ÉN skriver.
 *
 * Fiks-runde 1 (review B, M4) lukket seks omgåelser: (1) `unreviewed` kunne vokse uten brems -> tak; (2) `INSERT INTO ${tabell}`, sitert eller skjemakvalifisert tabell var usynlig -> `dynamic`-liste med eksakt antall;
 * (3) en NY uskannet skriving i et kjent par -> `writes`-pinning; (4) beviset kunne stå i en KOMMENTAR -> kommentarer fjernes før beviset telles; (5) ett av flere like bevis kunne fjernes -> `min_evidence`;
 * (6) `neutralizeUntrustedText`/`sanitizeDisplayText` talte som skanner-bevis -> de er fjernet fra beviset (de fjerner styretegn, de redigerer ikke hemmeligheter). Selve vaktfunksjonene er testet mot syntetiske omgåelser nederst.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = JSON.parse(readFileSync(join(ROOT, "modules/core/test/fixtures/secret-sink-baseline.json"), "utf8")) as {
  verified: Array<{ table: string; file: string; evidence: string; writes: number; min_evidence: number }>;
  safe: Array<{ file: string; tables: string[]; why: string }>;
  file_level: Array<{ file: string; tables: string[] }>;
  unreviewed: Array<{ file: string; tables: string[] }>;
  dynamic: Array<{ file: string; count: number; why: string }>;
};
/** Taket på antall `unreviewed` (fil, tabell)-par. KAN BARE KRYMPE: en ny sink skal bli `verified`/`safe`, ikke `unreviewed`. Å øke tallet er en bevisst, synlig endring som krever godkjenning (se runbooken). */
const UNREVIEWED_PAIR_CEILING = 158;
function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
}

/** (fil -> tabell -> antall skrivinger) og (fil -> antall dynamiske) for all produktkode: kun under `src/` (ikke test/scripts). */
function discover(): { found: Map<string, Map<string, number>>; dynamic: Map<string, number> } {
  const files: string[] = [];
  for (const top of ["apps", "modules", "packages"]) {
    const base = join(ROOT, top);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base)) {
      const src = join(base, pkg, "src");
      if (existsSync(src)) walk(src, files);
    }
  }
  const found = new Map<string, Map<string, number>>();
  const dynamic = new Map<string, number>();
  for (const file of files) {
    const { tables, dynamic: dyn } = writesIn(readFileSync(file, "utf8"));
    const rel = relative(ROOT, file);
    if (tables.size > 0) found.set(rel, tables);
    if (dyn > 0) dynamic.set(rel, dyn);
  }
  return { found, dynamic };
}

describe("K7e: ingen ny lagringssted-skriving uten klassifisering", () => {
  const { found, dynamic } = discover();
  const classes = new Map<string, string[]>();
  const add = (cls: string, file: string, table: string): void => {
    const key = `${file} -> ${table}`;
    classes.set(key, [...(classes.get(key) ?? []), cls]);
  };
  for (const v of baseline.verified) add("verified", v.file, v.table);
  for (const e of baseline.safe) for (const t of e.tables) add("safe", e.file, t);
  for (const e of baseline.file_level) for (const t of e.tables) add("file_level", e.file, t);
  for (const e of baseline.unreviewed) for (const t of e.tables) add("unreviewed", e.file, t);

  it("hver INSERT/UPDATE (fil, tabell) i produktkoden er klassifisert i baseline (en ny, uklassifisert skriving feller testen)", () => {
    const unclassified: string[] = [];
    for (const [file, tables] of found) for (const table of tables.keys()) if (!classes.has(`${file} -> ${table}`)) unclassified.push(`${file} -> ${table}`);
    expect(unclassified, `nye lagringssteder uten klassifisering - skann teksten og legg dem til under «verified» i modules/core/test/fixtures/secret-sink-baseline.json (eller bevisst «unreviewed» + begrunnelse i runbooken):\n${unclassified.join("\n")}`).toEqual([]);
    expect(found.size).toBeGreaterThan(60);
  });

  it("hvert par står i NØYAKTIG én klasse (verified, safe, file_level ELLER unreviewed) - ingen tvetydig klassifisering", () => {
    const ambiguous = [...classes].filter(([, cls]) => cls.length > 1).map(([key, cls]) => `${key}: ${cls.join(" + ")}`);
    expect(ambiguous).toEqual([]);
  });

  it("antall `unreviewed`-par er under taket og kan bare krympe (en ny sink skal bli `verified`/`safe`)", () => {
    const pairs = baseline.unreviewed.reduce((n, e) => n + e.tables.length, 0);
    expect(pairs, `unreviewed-parene vokste til ${pairs} (tak ${UNREVIEWED_PAIR_CEILING}): skann og klassifiser den nye sinken i stedet`).toBeLessThanOrEqual(UNREVIEWED_PAIR_CEILING);
  });

  it("hver `verified`-sink skriver fortsatt til tabellen, har ikke fått FLERE skrivinger (en ny skriving i et kjent par må bevises og pinnes bevisst) og har fortsatt skannebeviset sitt (utenfor kommentarer, minst `min_evidence` ganger)", () => {
    expect(baseline.verified.length).toBeGreaterThanOrEqual(15);
    for (const v of baseline.verified) {
      const text = readFileSync(join(ROOT, v.file), "utf8");
      const writes = found.get(v.file)?.get(v.table) ?? 0;
      expect(writes, `${v.file} skriver ikke lenger til ${v.table}`).toBeGreaterThan(0);
      expect(writes, `${v.file}: ${v.table} har fått en NY skriving (${writes} mot pinnet ${v.writes}) - skann teksten og pin antallet i baseline`).toBeLessThanOrEqual(v.writes);
      const count = evidenceCount(text, new RegExp(v.evidence));
      expect(count, `${v.file}: skannebeviset /${v.evidence}/ for ${v.table} finnes ${count} ganger (utenfor kommentarer), forventet minst ${v.min_evidence}`).toBeGreaterThanOrEqual(Math.max(1, v.min_evidence));
    }
  });

  it("`file_level`-filer kaller fortsatt skanneren et sted (utenfor kommentarer; sanitering av styretegn teller ikke)", () => {
    for (const e of baseline.file_level) {
      if (!existsSync(join(ROOT, e.file))) continue;
      expect(GENERAL_EVIDENCE.test(stripComments(readFileSync(join(ROOT, e.file), "utf8"))), `${e.file} kaller ikke lenger skanneren - flytt den til «unreviewed» bevisst`).toBe(true);
    }
  });

  it("dynamiske/siterte/skjemakvalifiserte skrivinger (`INSERT INTO ${t}`, `UPDATE \"t\"`, `s.t`) er kun tillatt der baseline eksplisitt lister dem, med eksakt antall og en begrunnelse", () => {
    const allowed = new Map(baseline.dynamic.map((d) => [d.file, d]));
    const unexpected: string[] = [];
    for (const [file, count] of dynamic) if (allowed.get(file)?.count !== count) unexpected.push(`${file}: ${count} (baseline: ${allowed.get(file)?.count ?? "ikke listet"})`);
    for (const d of baseline.dynamic) {
      expect(d.why.trim().length, `${d.file}: mangler begrunnelse`).toBeGreaterThan(20);
      if (!dynamic.has(d.file)) unexpected.push(`${d.file}: ikke lenger dynamisk (fjern fra baseline)`);
    }
    expect(unexpected, "dynamiske tabellnavn kan ikke klassifiseres per tabell: bruk et fast tabellnavn, eller list filen under «dynamic» med begrunnelse").toEqual([]);
  });

  it("`audit_events` har nøyaktig ÉN skriver (writeAudit), og den skanner reason og nyttelast", () => {
    const writers = [...found].filter(([, tables]) => tables.has("audit_events")).map(([file]) => file);
    expect(writers).toEqual(["modules/core/src/services/audit-writer.ts"]);
    const text = readFileSync(join(ROOT, writers[0] as string), "utf8");
    expect(text).toMatch(/scanForSecrets\(typeof rawReason === "string" \? rawReason : String\(rawReason\)\)/); // reason (også en ikke-streng fra en JS-kaller) skannes (fiks-runde 1, B-L1)
    expect(text).toMatch(/scanStructuredForSecrets\(entry\.payload/);
  });
});

describe("K7e: vaktfunksjonene fanger de syntetiske omgåelsene fra review B (guard-bypass)", () => {
  const evidence = /scanForSecrets\(content\)/;
  it("(a) ny tabell i en ny fil og (e) `INSERT INTO ${tabell}`, (f) sitert og skjemakvalifisert tabell oppdages (som dynamiske, ikke ignorert)", () => {
    expect(writesIn("await c.query(`INSERT INTO ny_tabell (a) VALUES ($1)`)").tables.get("ny_tabell")).toBe(1);
    expect(writesIn("await c.query(`INSERT INTO ${table} (a) VALUES ($1)`)").dynamic).toBe(1);
    expect(writesIn('await c.query(`INSERT INTO "messages" (a) VALUES ($1)`)').dynamic).toBe(1);
    expect(writesIn("await c.query(`INSERT INTO public.messages (a) VALUES ($1)`)").dynamic).toBe(1);
    expect(writesIn("await c.query(`UPDATE ${table} SET a = 1`)").dynamic).toBe(1);
    expect(writesIn('const s = "UPDATE the user settings"; // prosa, ikke SQL').tables.size).toBe(0);
  });
  it("(b) en NY uskannet INSERT i et kjent par øker antall skrivinger (som er pinnet i baseline)", () => {
    const before = "const s = scanForSecrets(content);\nawait c.query(`INSERT INTO messages (a) VALUES ($1)`, [s.text]);";
    const after = `${before}\nawait c.query(\`INSERT INTO messages (a) VALUES ($1)\`, [content]);`;
    expect(writesIn(before).tables.get("messages")).toBe(1);
    expect(writesIn(after).tables.get("messages")).toBe(2);
  });
  it("(c) et skannebevis i en KOMMENTAR (linje eller blokk) er ikke et bevis, men `https://` i en streng kutter ikke koden etter seg", () => {
    expect(evidenceCount("// const s = scanForSecrets(content);\nawait c.query(`INSERT INTO messages ...`);", evidence)).toBe(0);
    expect(evidenceCount("/* scanForSecrets(content) */\nawait c.query(`INSERT INTO messages ...`);", evidence)).toBe(0);
    expect(evidenceCount("/**\n * scanForSecrets(content)\n */ const x = 1;", evidence)).toBe(0);
    expect(evidenceCount('const u = "https://example.com"; const s = scanForSecrets(content);', evidence)).toBe(1);
    expect(evidenceCount("const s = scanForSecrets(content); // bevis", evidence)).toBe(1);
  });
  it("(g) at ett av flere like bevis fjernes teller: antallet bevis synker under `min_evidence`", () => {
    const three = "x = scanForSecrets(content);\ny = scanForSecrets(content);\nz = scanForSecrets(content);";
    const two = "x = scanForSecrets(content);\ny = scanForSecrets(content);";
    expect(evidenceCount(three, evidence)).toBe(3);
    expect(evidenceCount(two, evidence)).toBeLessThan(3);
  });
  it("(d/6) `neutralizeUntrustedText` og `sanitizeDisplayText` er ikke skanner-bevis på filnivå", () => {
    expect(GENERAL_EVIDENCE.test("const t = neutralizeUntrustedText(x); const u = sanitizeDisplayText(y);")).toBe(false);
    expect(GENERAL_EVIDENCE.test("const t = scanForSecrets(x);")).toBe(true);
    expect(GENERAL_EVIDENCE.test("const t = clipRedacted(x, 10);")).toBe(true);
  });
});

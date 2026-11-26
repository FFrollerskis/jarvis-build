import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FINANCE_DERIVED_LOOP_TYPES } from "@jarvis/business";
import { CONTROL_CENTER_FLAGS } from "../src/control-center/shared.ts";
import { startH0Db, type H0Db } from "./support/h0-db.ts";
import { CENTER_ROWS, ROWS } from "./support/n1b-rows.ts";

/**
 * WP-N1b fiks-runde 1 (FIX-8): runbooken er et KRAV på hva som skal kontrolleres på NAS, så den må ikke råtne uten at noe feiler. Tre ting låses:
 *  A. TABELLEN: «Antall rader i kartleggingstabellen: **N**» og radnavnene i tabellen er NØYAKTIG radene i koden (`n1b-rows.ts` + R23, oversikten). Runde 1 sa «23 stier (R01-R23)» etter at koden hadde 30 rader (R08b/R08c/R24a/R24b/R25 kom til); en rad som legges til
 *     eller fjernes uten at runbooken følger med feller testen. Foreldede tall («23 stier», «R01-R23», «de 23 stiene») er forbudt, og tallene som omtaler tabellen er lik radantallet.
 *  B. SQL-SNIPPENE: HVER `-c "SELECT ..."` i NAS-stegene kjøres mot en ekte, migrert database (superbruker, kun lesing). Runde 1 hadde `audit_events.created_at` (kolonnen heter `at`) i to steg og en plassholder (`<finanstypene>`) i SQL. En snippet som ikke kjører, eller som ikke er en ren
 *     SELECT, feller testen; forventningene i steg 1-4 (migrasjon 140, kolonnen, rettighetene, umerkede rader) kontrolleres mot de faktiske verdiene; finanstypene i steg 7h er NØYAKTIG de i koden.
 *  C. AKTIVERINGSREKKEFØLGEN nevner ALLE kontrollsenter-flaggene (`CONTROL_CENTER_FLAGS`): et nytt senterflagg i koden uten en plass i rekkefølgen feller testen (Sikkerhet-flagget manglet i runde 1). Fiks-runde 2 (FIX-B): steg 8-LISTEN
 *     over flagg er pinnet for seg (ikke bare «et sted i NAS-seksjonen»: 7n nevner Sikkerhet-flagget også, så et flagg som falt ut av steg 8 slapp forbi).
 *  D. FORBEHOLDENE rundt de ekte skyturene (fiks-runde 2, FIX-B): 7g-7q kjøres KUN mot en TEST-tenant med syntetiske data (felles forbehold øverst, og i 7m som slår vakten AV og 7n som fryser en kobling); Sikkerhet-flagget slås på MIDLERTIDIG
 *     kun for 7n (steg 3 og 7n sier det, og steg 3 grupperer ikke lenger Sikkerhet under «bygges uten finansavledet tilstand»).
 */
const RUNBOOK = readFileSync(fileURLToPath(new URL("../../../docs/runbooks/WPN1_RESTRICTED_HISTORY.md", import.meta.url)), "utf8");

/** Tekst mellom to overskrifter (første treff av `from` til første påfølgende `to`). */
function section(from: RegExp, to: RegExp): string {
  const start = RUNBOOK.search(from);
  expect(start, `fant ikke seksjonen ${String(from)}`).toBeGreaterThanOrEqual(0);
  const afterHeading = RUNBOOK.indexOf("\n", start) + 1; // søker etter slutten FRA neste linje, så overskriften selv aldri matcher `to`
  const rest = RUNBOOK.slice(afterHeading);
  const end = rest.search(to);
  return end < 0 ? rest : rest.slice(0, end);
}

const CODE_ROW_IDS = [...ROWS.map((r) => r.id), ...CENTER_ROWS.map((r) => r.id), "R23"].sort();

describe("A: kartleggingstabellen i runbooken er radene i koden", () => {
  const table = section(/^### K2 - kartleggingstabellen/m, /^### |^## /m);
  const docIds = [...table.matchAll(/^\| (R\d+[a-z]?) \|/gm)].map((m) => m[1] as string).sort();

  it("radnavnene i tabellen er NØYAKTIG radene i koden (ROWS + CENTER_ROWS + R23), uten duplikater", () => {
    expect(new Set(docIds).size, `duplikater i tabellen: ${docIds.join(",")}`).toBe(docIds.length);
    expect(docIds).toEqual(CODE_ROW_IDS);
  });

  it("«Antall rader i kartleggingstabellen: **N**» er radantallet i koden", () => {
    const m = /Antall rader i kartleggingstabellen: \*\*(\d+)\*\*/.exec(RUNBOOK);
    expect(m, "setningen «Antall rader i kartleggingstabellen: **N**» mangler").not.toBeNull();
    expect(Number(m?.[1])).toBe(CODE_ROW_IDS.length);
    expect(CODE_ROW_IDS.length).toBe(30);
  });

  it("alle tall som omtaler tabellen («N rader», «N listede radene», «R01-RNN») er lik radantallet; ingen foreldede tall (23 stier, R01-R23)", () => {
    expect(RUNBOOK).not.toMatch(/\b23 stier\b/);
    expect(RUNBOOK).not.toMatch(/\bde 23 stiene\b/);
    expect(RUNBOOK).not.toMatch(/R01-R23\b/);
    const lastId = CODE_ROW_IDS.map((id) => Number(/^R(\d+)/.exec(id)?.[1])).reduce((a, b) => Math.max(a, b), 0);
    const ranges = [...RUNBOOK.matchAll(/R01-R(\d+)/g)].map((m) => Number(m[1]));
    expect(ranges.length).toBeGreaterThan(0);
    for (const r of ranges) expect(r, "R01-R<siste> i teksten").toBe(lastId);
    const counts = [...RUNBOOK.matchAll(/\b(\d+) (?:listede )?(?:rader|radene)\b/g)]
      .map((m) => ({ n: Number(m[1]), ctx: RUNBOOK.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + 60).replace(/\s+/g, " ") }))
      .filter((c) => /tabell|R01-R|kartlegg|WP-N1b|K2|R0\d|flagget `off`|Antall rader/.test(c.ctx));
    expect(counts.length).toBeGreaterThan(0);
    for (const c of counts) expect(c.n, `«${c.ctx}»`).toBe(CODE_ROW_IDS.length);
  });

  it("raden for hver håndterte handling finnes i tabellen: R24 (Sikkerhet), R25 (driftsbildet), R08b/R08c (infra) og R22 (vedlikehold) er med", () => {
    for (const id of ["R08b", "R08c", "R22", "R23", "R24a", "R24b", "R25"]) expect(docIds, id).toContain(id);
  });
});

describe("B: hver SQL-snippet i NAS-stegene kjører mot en ekte, migrert database (kun lesing)", () => {
  let db: H0Db;
  const snippets = [...RUNBOOK.matchAll(/-c "([^"]+)"/g)].map((m) => (m[1] as string).trim());

  beforeAll(async () => { db = await startH0Db("n1brunbook"); }, 240_000);
  afterAll(async () => { await db?.stop(); }, 120_000);

  it("runbooken har SQL-snippene (ikke en tom match)", () => {
    expect(snippets.length).toBeGreaterThanOrEqual(15);
  });

  it("hver snippet er en ren SELECT uten plassholder (`<...>`), uten skriving og uten `created_at` mot `audit_events` (kolonnen heter `at`)", () => {
    for (const s of snippets) {
      expect(s, s).toMatch(/^SELECT\b/);
      expect(s, `plassholder i SQL: ${s}`).not.toMatch(/<[A-Za-zæøåÆØÅ_ ]+>/);
      const withoutLiterals = s.replace(/'[^']*'/g, "''"); // `has_column_privilege(..., 'UPDATE')` er en tekstverdi, ikke en skriving
      expect(withoutLiterals, s).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT)\b/i);
      if (/\bFROM audit_events\b/.test(s)) expect(s, `audit_events har kolonnen \`at\`, ikke \`created_at\`: ${s}`).not.toMatch(/\bcreated_at\b/);
    }
  });

  it("hver snippet KJØRER (kolonner og tabeller finnes) - superbruker mot den migrerte databasen", async () => {
    for (const s of snippets) {
      const r = await db.adminPool.query(s);
      expect(Array.isArray(r.rows), s).toBe(true);
    }
  });

  it("forventningene i steg 1-4 stemmer mot den faktiske databasen (migrasjon 140, kolonnen, rettighetene, ingen merkede rader)", async () => {
    const find = (re: RegExp): string => {
      const s = snippets.find((x) => re.test(x));
      expect(s, `fant ikke snippet ${String(re)}`).toBeDefined();
      return s as string;
    };
    const mig = await db.adminPool.query(find(/FROM schema_migrations WHERE name = '140_messages_restricted\.sql'/));
    expect(mig.rowCount, "steg 1: én rad").toBe(1);
    const col = await db.adminPool.query(find(/FROM information_schema\.columns WHERE table_name = 'messages' AND column_name = 'restricted'/));
    expect(col.rows).toEqual([expect.objectContaining({ column_name: "restricted", data_type: "boolean", is_nullable: "NO", column_default: "false" })]);
    const priv = await db.adminPool.query(find(/has_column_privilege\('jarvis_app','messages','restricted','UPDATE'\)/));
    expect(priv.rows[0]).toEqual({ kan_merke: true, kan_endre_innhold: false, trigger: "1" });
    const rows = await db.adminPool.query(find(/^SELECT restricted, count\(\*\) FROM messages GROUP BY 1/));
    for (const r of rows.rows as Array<{ restricted: boolean }>) expect(r.restricted, "steg 4: kun umerkede rader").toBe(false);
  });

  it("steg 7h: finanstypene i SQL-en er NØYAKTIG de 12 finansavledede løkketypene i koden", () => {
    const s = snippets.find((x) => /FROM business_open_loops WHERE loop_type NOT IN \(/.test(x));
    expect(s, "snippeten med finanstypene mangler").toBeDefined();
    const listed = [...(s as string).matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string).sort();
    expect(listed).toEqual([...FINANCE_DERIVED_LOOP_TYPES].sort());
    expect(listed.length).toBe(12);
  });
});

describe("C: aktiveringsrekkefølgen nevner ALLE kontrollsenter-flaggene (og ingen plassholder for tellinger fra audit_events)", () => {
  const order = section(/^\*\*Rekkefølge \(Q-66 alternativ A\):\*\*/m, /^## /m);
  const nas = section(/^## NAS-verifisering/m, /^\*\*Rollback:\*\*/m);

  /** Teksten til ETT nummerert steg i NAS-seksjonen (fra `<id>. **` til neste nummererte steg eller en blank linje); innrykkede fortsettelseslinjer hører til steget. */
  const step = (id: string): string => {
    const start = nas.search(new RegExp(`^${id}\\. \\*\\*`, "m"));
    expect(start, `steg ${id} mangler i NAS-seksjonen`).toBeGreaterThanOrEqual(0);
    const rest = nas.slice(start + 1);
    const end = rest.search(/\n(?:\d+[a-z]?\. \*\*|\*\*Felles forbehold|\n)/);
    return end < 0 ? nas.slice(start) : nas.slice(start, start + 1 + end);
  };

  it("hvert flagg i `CONTROL_CENTER_FLAGS` står i rekkefølgen (fullt navn eller `_SUFFIKS` etter et fullt navn), og i STEG 8-listen selv (ikke bare et sted i NAS-seksjonen: 7n nevner `_SECURITY` også)", () => {
    const flags = Object.values(CONTROL_CENTER_FLAGS);
    expect(flags.length).toBe(8);
    const step8 = step("8");
    expect(step8).toMatch(/^8\. \*\*Først nå\*\*/);
    for (const f of flags) {
      const suffix = f.replace("JARVIS_CONTROL_CENTER", "");
      const mentioned = (text: string): boolean => text.includes(f) || text.includes(`\`${suffix}\``) || text.includes(`\`${suffix}=`);
      expect(mentioned(order), `${f} mangler i aktiveringsrekkefølgen (steg 3)`).toBe(true);
      expect(mentioned(step8), `${f} mangler i NAS-steg 8 (selve listen)`).toBe(true);
    }
    expect(order).toContain("JARVIS_CONTROL_CENTER_SECURITY");
  });

  it("steg 7g-7q finnes (K1/K2 + fiks-runde 1) og steg 8 viser til dem; tilbakehold telles IKKE fra `audit_events` (ingen egen revisjonsrad)", () => {
    for (const step of ["7g.", "7h.", "7i.", "7j.", "7k.", "7l.", "7m.", "7n.", "7o.", "7p.", "7q."]) expect(nas, step).toContain(`${step} **`);
    expect(nas).toContain("7g-7q");
    expect(nas).toMatch(/INGEN egen revisjonsrad/);
    expect(nas).not.toMatch(/7g-7m/);
  });
});

describe("D: forbeholdene rundt de ekte skyturene (7g-7q): KUN TEST-tenant/syntetiske data, og Sikkerhet-flagget er bare midlertidig på for 7n", () => {
  const order = section(/^\*\*Rekkefølge \(Q-66 alternativ A\):\*\*/m, /^## /m);
  const nas = section(/^## NAS-verifisering/m, /^\*\*Rollback:\*\*/m);
  const step = (id: string): string => {
    const start = nas.search(new RegExp(`^${id}\\. \\*\\*`, "m"));
    expect(start, `steg ${id} mangler`).toBeGreaterThanOrEqual(0);
    const rest = nas.slice(start + 1);
    const end = rest.search(/\n(?:\d+[a-z]?\. \*\*|\*\*Felles forbehold|\n)/);
    return end < 0 ? nas.slice(start) : nas.slice(start, start + 1 + end);
  };

  it("et FELLES forbehold står rett før 7g og sier TEST-tenant, syntetiske data og aldri produksjon, og at vakten slås PÅ igjen etter 7m", () => {
    const at = nas.search(/^\*\*Felles forbehold for 7g-7q/m);
    expect(at, "det felles forbeholdet mangler").toBeGreaterThanOrEqual(0);
    expect(at, "forbeholdet skal stå FØR 7g").toBeLessThan(nas.search(/^7g\. \*\*/m));
    const common = nas.slice(at, nas.search(/^7g\. \*\*/m));
    expect(common).toMatch(/TEST-tenant/);
    expect(common).toMatch(/syntetiske data/);
    expect(common).toMatch(/aldri mot produksjon/);
    expect(common).toMatch(/vakten PÅ igjen etter 7m/);
  });

  it("7m (slår vakten AV) og 7n (fryser en kobling) sier hver for seg «KUN TEST-tenant/syntetiske data»; 7m sier også «aldri produksjon»", () => {
    for (const id of ["7m", "7n"]) expect(step(id), id).toMatch(/KUN TEST-tenant\/syntetiske data/);
    expect(step("7m")).toMatch(/aldri produksjon/);
    expect(step("7m")).toMatch(/PÅ igjen/);
    expect(step("7n")).toMatch(/aldri en ekte produksjonskobling/);
  });

  it("7n krever Sikkerhet-flagget MIDLERTIDIG (kun for dette steget, av igjen før steg 8), og steg 3 gir det som eneste unntak fra «ingen kontrollsenter-flagg før 7g-7q»", () => {
    expect(step("7n")).toMatch(/JARVIS_CONTROL_CENTER_SECURITY=on` slått på MIDLERTIDIG bare for dette steget/);
    expect(step("7n")).toMatch(/av igjen etterpå, før steg 8/);
    expect(order).toMatch(/Eneste unntak \(fiks-runde 2\):\*\* `JARVIS_CONTROL_CENTER_SECURITY=on` slås på MIDLERTIDIG, kun mot en TEST-tenant og kun for steg 7n/);
    expect(step("8")).toMatch(/kun var midlertidig på for 7n/);
  });

  it("steg 3 grupperer IKKE lenger Sikkerhet under «bygges uten finansavledet tilstand» (filtreres per element, rad R24); Minne/Agent/Drift/Personvern gjør det", () => {
    expect(order).not.toMatch(/Sikkerhet\/Minne\/Agent\/Drift\/Personvern bygges uten finansavledet tilstand/);
    expect(order).toMatch(/Sikkerhet FILTRERES per element med vakten på/);
    expect(order).toMatch(/rad R24\), Minne\/Agent\/Drift\/Personvern bygges uten finansavledet tilstand/);
  });
});

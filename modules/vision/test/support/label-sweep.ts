import type pg from "pg";
import { normalizeObjectLabel } from "../../src/labels.ts";

/**
 * WP-G3 (D-465), mini-fiks-runden (review delta D1): felles sveip-verktøy for etikett-CHECK-ene (133: mild, 135: streng).
 * Sveipene kjører mot SELVE constraint-uttrykket i databasen (`pg_get_constraintdef`) og over HELE Unicode-rommet (BMP + supplementære plan, ikke surrogater), i klynger med ULIKE locales -
 * en regel som bruker POSIX-klasser (`[:punct:]` ...) gir ulike svar i `C` og `C.UTF-8`/`en_US.UTF-8` (glibc regner tall-tegn av kategori No som tegnsetting), og det var nettopp det
 * som slapp gjennom da sveipet bare kjørte i standard-klyngen (locale `C`).
 */
export const OBS_CHECK = "vision_event_observations_object_label_check";
export const INV_CHECK = "vision_inventory_items_object_label_check";

/** Hver Unicode-skalarverdi (1..0x10FFFF, uten surrogater: de finnes ikke i UTF-8). Kodepunkt 0 kan ikke ligge i en tekstverdi. */
export function* scalarValues(): Generator<number> {
  for (let cp = 1; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    yield cp;
  }
}

export const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/** Formene hvert kodepunkt settes inn i: alene, inni og på begge sider av en bokstav (en NFKC-sammensetning eller et skille-tegn kan endre utfallet bare i noen posisjoner). */
export const SWEEP_FORMS: ReadonlyArray<(ch: string) => string> = [(ch) => ch, (ch) => `a${ch}a`, (ch) => `${ch}b`, (ch) => `b${ch}`];

/** ALLE ikke-null resultater av `normalizeObjectLabel` over alle kodepunkt og alle former (dedupliserte). */
export function normalizerOutputs(forms: ReadonlyArray<(ch: string) => string> = SWEEP_FORMS): string[] {
  const outputs = new Set<string>();
  for (const cp of scalarValues()) {
    const ch = String.fromCodePoint(cp);
    for (const make of forms) {
      const out = normalizeObjectLabel(make(ch));
      if (out !== null) outputs.add(out);
    }
  }
  return [...outputs];
}

export async function constraintExpression(admin: pg.Pool, name: string): Promise<string> {
  const row = (await admin.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [name])).rows[0] as { def: string } | undefined;
  if (row === undefined) throw new Error(`constraint_not_found:${name}`);
  return row.def.replace(/^CHECK\s*/, "").replace(/\s+NOT VALID$/, "");
}

/** Indeksene (i `labels`) som constraint-uttrykket AVVISER. Evaluerer uttrykket slik en CHECK gjør (NULL = godtatt). Ingen skriving. */
export async function rejectedIndexes(admin: pg.Pool, constraint: string, labels: readonly string[], chunkSize = 25_000): Promise<number[]> {
  const expr = await constraintExpression(admin, constraint);
  const rejected: number[] = [];
  for (let start = 0; start < labels.length; start += chunkSize) {
    const chunk = labels.slice(start, start + chunkSize);
    const res = await admin.query(`SELECT t.ord::int AS ord FROM unnest($1::text[]) WITH ORDINALITY AS t(object_label, ord) WHERE NOT COALESCE(${expr}, true) ORDER BY t.ord`, [chunk]);
    for (const row of res.rows as Array<{ ord: number }>) rejected.push(start + row.ord - 1);
  }
  return rejected;
}

/** Formene et kodepunkt settes inn i, som SQL-uttrykk over `g.cp` (samme former som JS-siden: alene, midt i, foran og bak en bokstav). */
export const SQL_FORMS = {
  wrapped: `('a' || chr(g.cp) || 'a')`,
  bare: `chr(g.cp)`,
  prefix: `(chr(g.cp) || 'b')`,
  suffix: `('b' || chr(g.cp))`
} as const;
export type SweepForm = keyof typeof SQL_FORMS;

export const JS_FORMS: Record<SweepForm, (ch: string) => string> = { wrapped: (ch) => `a${ch}a`, bare: (ch) => ch, prefix: (ch) => `${ch}b`, suffix: (ch) => `b${ch}` };

/** Kodepunktene constraint-uttrykket avviser i den gitte formen (standard: midt i et ellers gyldig navn, `a<tegn>a`, der KUN tegnet avgjør utfallet). Hele rommet i én spørring. */
export async function rejectedCodePoints(admin: pg.Pool, constraint: string, form: SweepForm = "wrapped"): Promise<number[]> {
  const expr = await constraintExpression(admin, constraint);
  const res = await admin.query(
    `SELECT cp FROM (SELECT generate_series(1, 55295) AS cp UNION ALL SELECT generate_series(57344, 1114111)) g,
       LATERAL (SELECT ${SQL_FORMS[form]} AS object_label) s
      WHERE NOT COALESCE(${expr}, true) ORDER BY cp`
  );
  return (res.rows as Array<{ cp: number }>).map((r) => r.cp);
}

/** JS-regelens avviste kodepunkter i samme form (for sammenligning mot `rejectedCodePoints`). */
export function jsRejectedCodePoints(rule: (label: string) => boolean, form: SweepForm = "wrapped"): number[] {
  const rejected: number[] = [];
  for (const cp of scalarValues()) if (!rule(JS_FORMS[form](String.fromCodePoint(cp)))) rejected.push(cp);
  return rejected;
}

/** Lesbar, kort beskrivelse av avvikere (kodepunkt, ikke rå tegn: utskriften skal aldri inneholde kontroll-/bidi-tegn). */
export function describeLabels(labels: readonly string[], limit = 12): string {
  return labels.slice(0, limit).map((label) => [...label].map((ch) => hex(ch.codePointAt(0) as number)).join("+")).join(", ") + (labels.length > limit ? ` ... (${labels.length} totalt)` : "");
}

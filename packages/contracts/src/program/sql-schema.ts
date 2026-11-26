/**
 * WP-PGA / PG1: SQL-lesing for eierskapsskanningen. Ingen SQL-parser: en STØY-FRI skanner som blanker kommentarer og strenginnhold før den leter etter CREATE TABLE / ALTER TABLE / DROP TABLE,
 * så en tabell som bare er «nevnt» i en kommentar eller en streng aldri teller. Ren modul (ingen filsystem): migrasjonsfilene gis inn som tekst.
 *
 * KJENTE GRENSER (ærlig): (1) dynamisk SQL (`EXECUTE format('ALTER TABLE %I ...')`) kan ingen statisk skanning se - kun literale tabellnavn dekkes; (2) skjemaprefiks (`public.t`) ignoreres, så to like tabellnavn
 * i ulike skjemaer ville blitt slått sammen (finnes ikke i repoet); (3) rekkefølgen mellom setninger INNE i én fil er create -> rename -> drop, ikke tekstrekkefølgen; (4) `ALTER TABLE ... ADD COLUMN` leses for
 * kolonnenavn, men ikke `ALTER COLUMN`/`RENAME COLUMN`/`DROP COLUMN`.
 */

export interface BlankOptions {
  /** Behold innholdet i enkeltapostrofstrenger (kommentarer blankes fortsatt). Brukes når stringliteraler skal leses (f.eks. 'active' i en CHECK). */
  keepStrings?: boolean;
}

const DOLLAR_TAG = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const blankText = (text: string): string => text.replace(/[^\n]/g, " ");

/** Samme lengde og linjeskift som inndata; kommentarer og (valgfritt) strenginnhold er blanket. Dollar-siterte blokker leses som kode (rekursivt), så statiske ALTER i DO-blokker fanges. */
export function blankSqlNoise(sql: string, options: BlankOptions = {}): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      let j = i;
      while (j < n && sql[j] !== "\n") j += 1;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth += 1;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth -= 1;
          j += 2;
        } else j += 1;
      }
      out += blankText(sql.slice(i, j));
      i = j;
      continue;
    }
    if (c === "'") {
      const prev = i > 0 ? (sql[i - 1] as string) : "";
      const beforePrev = i > 1 ? (sql[i - 2] as string) : "";
      const escapeString = /[eE]/.test(prev) && !IDENT_CHAR.test(beforePrev);
      let j = i + 1;
      while (j < n) {
        if (escapeString && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      const end = Math.min(j, n);
      const inner = sql.slice(i + 1, end);
      out += `'${options.keepStrings === true ? inner : blankText(inner)}${j < n ? "'" : ""}`;
      i = j < n ? j + 1 : n;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      const end = j < n ? j + 1 : n;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === "$" && !(i > 0 && IDENT_CHAR.test(sql[i - 1] as string))) {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(sql);
      if (m !== null) {
        const open = m[0];
        const close = sql.indexOf(open, i + open.length);
        if (close !== -1) {
          out += open + blankSqlNoise(sql.slice(i + open.length, close), options) + open;
          i = close + open.length;
          continue;
        }
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

const NAME = `(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = `${NAME}(?:\\s*\\.\\s*${NAME})?`;
const CREATE_RE = new RegExp(`\\bCREATE\\s+(?:(?:GLOBAL\\s+|LOCAL\\s+)?(TEMP|TEMPORARY)\\s+|UNLOGGED\\s+)?TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})`, "gi");
const ALTER_RE = new RegExp(`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QUALIFIED})`, "gi");
const RENAME_RE = new RegExp(`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QUALIFIED})\\s+RENAME\\s+TO\\s+(${QUALIFIED})`, "gi");
const DROP_RE = new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${QUALIFIED}(?:\\s*,\\s*${QUALIFIED})*)`, "gi");
const NAME_TOKEN = new RegExp(NAME, "g");
const ADD_COLUMN = new RegExp(`^\\s*ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})`, "i");
const NOT_COLUMN_AFTER_ADD = new Set(["constraint", "primary", "foreign", "unique", "check", "exclude", "like"]);
const TABLE_CONSTRAINT_START = new Set(["constraint", "primary", "foreign", "unique", "check", "exclude", "like"]);

/** Siste (tabell)ledd av et mulig skjemaprefiksert navn, uten anførselstegn og med små bokstaver. */
function normalizeName(qualified: string): string {
  const parts = qualified.match(NAME_TOKEN) ?? [];
  const last = parts[parts.length - 1] ?? "";
  return (last.startsWith('"') ? last.slice(1, -1).replace(/""/g, '"') : last).toLowerCase();
}

/** Indeksen til parentesen som lukker den som åpner i `open` (anførte identifikatorer hoppes over). -1 hvis ubalansert. */
function matchingParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (c === '"') {
      i += 1;
      while (i < code.length && !(code[i] === '"' && code[i + 1] !== '"')) i += code[i] === '"' ? 2 : 1;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Del en liste på komma på toppnivå (parenteser og anførte identifikatorer respekteres). */
function splitTopLevel(code: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i];
    if (c === '"') {
      i += 1;
      while (i < code.length && !(code[i] === '"' && code[i + 1] !== '"')) i += code[i] === '"' ? 2 : 1;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(code.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(code.slice(start));
  return parts;
}

/** Første ord i et element: nøkkelord (små bokstaver) eller et anført navn. */
function firstToken(item: string): { raw: string; name: string; quoted: boolean } | null {
  const m = /^\s*(?:("(?:[^"]|"")+")|([A-Za-z_][A-Za-z0-9_$]*))/.exec(item);
  if (m === null) return null;
  if (m[1] !== undefined) return { raw: m[1], name: m[1].slice(1, -1).replace(/""/g, '"').toLowerCase(), quoted: true };
  return { raw: m[2] as string, name: (m[2] as string).toLowerCase(), quoted: false };
}

/** Kolonnenavn fra innholdet i en CREATE TABLE-parentes: tabellbegrensninger (CONSTRAINT/PRIMARY/FOREIGN/UNIQUE/CHECK/EXCLUDE/LIKE som FØRSTE ORD) hoppes over. */
function columnNames(bodyCode: string): string[] {
  const out: string[] = [];
  for (const item of splitTopLevel(bodyCode)) {
    const t = firstToken(item);
    if (t === null) continue;
    if (!t.quoted && TABLE_CONSTRAINT_START.has(t.name)) continue;
    out.push(t.name);
  }
  return out;
}

export interface CreatedTable {
  name: string;
  columns: string[];
  temporary: boolean;
  if_not_exists: boolean;
  /** Parentesinnholdet slik det står (kommentarer blanket, strenger beholdt): brukes av reglene som leser literaler. */
  body_text: string;
}

export interface AlterStatement {
  table: string;
  /** Hele ALTER-setningen (kommentarer blanket, strenger beholdt). */
  text: string;
  added_columns: string[];
}

export interface ParsedMigration {
  file: string;
  created: CreatedTable[];
  /** Unike tabeller (i rekkefølge) med minst én ALTER TABLE. */
  altered: string[];
  alter_statements: AlterStatement[];
  dropped: string[];
  renamed: Array<{ from: string; to: string }>;
}

/** Tekst til og med neste `;` på parentesdybde 0 fra `from` (eller til slutten). */
function statementEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    const c = code[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === ";" && depth <= 0) return i;
  }
  return code.length;
}

export function parseMigration(file: string, sql: string): ParsedMigration {
  const code = blankSqlNoise(sql);
  const text = blankSqlNoise(sql, { keepStrings: true });
  const created: CreatedTable[] = [];
  for (const m of code.matchAll(CREATE_RE)) {
    const name = normalizeName(m[3] as string);
    const end = (m.index as number) + m[0].length;
    let k = end;
    while (k < code.length && /\s/.test(code[k] as string)) k += 1;
    let columns: string[] = [];
    let bodyText = "";
    if (code[k] === "(") {
      const close = matchingParen(code, k);
      if (close !== -1) {
        columns = columnNames(code.slice(k + 1, close));
        bodyText = text.slice(k + 1, close);
      }
    }
    created.push({ name, columns, temporary: m[1] !== undefined, if_not_exists: m[2] !== undefined, body_text: bodyText });
  }

  const alterStatements: AlterStatement[] = [];
  const altered: string[] = [];
  for (const m of code.matchAll(ALTER_RE)) {
    const table = normalizeName(m[1] as string);
    const start = m.index as number;
    const end = statementEnd(code, start + m[0].length);
    const rest = code.slice(start + m[0].length, end);
    const added: string[] = [];
    for (const action of splitTopLevel(rest)) {
      const a = ADD_COLUMN.exec(action);
      if (a === null) continue;
      const first = firstToken(a[1] as string);
      if (first === null) continue;
      // «ADD CONSTRAINT x», «ADD PRIMARY KEY (..)» osv. er ikke kolonner (et anført navn er alltid en kolonne).
      if (!first.quoted && NOT_COLUMN_AFTER_ADD.has(first.name) && !/^\s*ADD\s+COLUMN\b/i.test(action)) continue;
      added.push(first.name);
    }
    alterStatements.push({ table, text: text.slice(start, end), added_columns: added });
    if (!altered.includes(table)) altered.push(table);
  }

  const renamed: Array<{ from: string; to: string }> = [];
  for (const m of code.matchAll(RENAME_RE)) renamed.push({ from: normalizeName(m[1] as string), to: normalizeName(m[2] as string) });

  const dropped: string[] = [];
  for (const m of code.matchAll(DROP_RE)) for (const element of splitTopLevel(m[1] as string)) dropped.push(normalizeName(element));

  return { file, created, altered, alter_statements: alterStatements, dropped, renamed };
}

export interface EffectiveTable {
  name: string;
  /** Filen som opprettet tabellen (følger med en RENAME). */
  created_in: string;
  /** Kolonner fra CREATE TABLE pluss `ADD COLUMN` i senere ALTER (kun navn). */
  columns: string[];
  /** CREATE-kroppen og ALTER-setningene som berører tabellen (strenger beholdt): leses av literalreglene. */
  definition_text: string;
}

export interface CreatedRecord {
  name: string;
  file: string;
  dropped_in?: string;
}

export interface MigrationSet {
  /** Tabeller som finnes etter ALLE migrasjoner (DROP/RENAME anvendt). */
  tables: Map<string, EffectiveTable>;
  /** Hver opprettelse (ikke midlertidige, ikke IF NOT EXISTS-gjentakelser), med filen som evt. droppet den. */
  created: CreatedRecord[];
  alters: Array<{ table: string; file: string }>;
  /** Tabell opprettet to ganger uten DROP imellom (uten IF NOT EXISTS). */
  duplicates: Array<{ table: string; files: string[] }>;
}

/** Filene behandles i navnerekkefølge (NNN_navn.sql), uansett hvilken rekkefølge de gis i. */
export function parseMigrationSet(files: ReadonlyArray<{ name: string; sql: string }>): MigrationSet {
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const tables = new Map<string, EffectiveTable>();
  const created: CreatedRecord[] = [];
  const alters: Array<{ table: string; file: string }> = [];
  const duplicates: Array<{ table: string; files: string[] }> = [];
  for (const f of ordered) {
    const m = parseMigration(f.name, f.sql);
    for (const c of m.created) {
      if (c.temporary) continue;
      const existing = tables.get(c.name);
      if (existing !== undefined) {
        if (!c.if_not_exists) duplicates.push({ table: c.name, files: [existing.created_in, f.name] });
        continue;
      }
      tables.set(c.name, { name: c.name, created_in: f.name, columns: [...c.columns], definition_text: c.body_text });
      created.push({ name: c.name, file: f.name });
    }
    for (const a of m.alter_statements) {
      alters.push({ table: a.table, file: f.name });
      const t = tables.get(a.table);
      if (t !== undefined) {
        for (const col of a.added_columns) if (!t.columns.includes(col)) t.columns.push(col);
        t.definition_text += `\n${a.text}`;
      }
    }
    for (const r of m.renamed) {
      const t = tables.get(r.from);
      if (t === undefined) continue;
      tables.delete(r.from);
      tables.set(r.to, { ...t, name: r.to });
    }
    for (const name of m.dropped) {
      if (!tables.delete(name)) continue;
      for (let i = created.length - 1; i >= 0; i -= 1) {
        const rec = created[i] as CreatedRecord;
        if (rec.name === name && rec.dropped_in === undefined) {
          rec.dropped_in = f.name;
          break;
        }
      }
    }
  }
  return { tables, created, alters, duplicates };
}

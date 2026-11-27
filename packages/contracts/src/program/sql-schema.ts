/**
 * WP-PGA / PG1: SQL-lesing for eierskapsskanningen. Ingen SQL-parser: en STØY-FRI skanner som blanker kommentarer og strenginnhold før den leter etter CREATE TABLE / ALTER TABLE / DROP TABLE,
 * så en tabell som bare er «nevnt» i en kommentar eller en streng aldri teller. Ren modul (ingen filsystem): migrasjonsfilene gis inn som tekst.
 *
 * Setningene prosesseres i TEKSTREKKEFØLGE (fiks 1, M4): `DROP TABLE IF EXISTS x; CREATE TABLE x (...)` gir tabellen x, og en `ALTER` etter en `RENAME` treffer det nye navnet. Filene prosesseres i navnerekkefølge.
 * Hver CREATE INDEX, CREATE POLICY, CREATE TRIGGER ... ON <tabell> og INSERT INTO <tabell> telles som en endring av tabellen (`touch`), likt en ALTER: eieren må kvittere filen.
 *
 * KJENTE GRENSER (ærlig): (1) DYNAMISK SQL: en `EXECUTE`-setning hvis argument inneholder `CREATE/ALTER/DROP TABLE` flagges som dynamisk DDL (`dynamic_ddl`; skanningen gir `migration_dynamic_ddl`), men SELVE
 * tabellen/endringen ses ikke. To former: (a) enkeltapostrofstrenger (`EXECUTE 'CREATE TABLE x ...'`, `EXECUTE format('ALTER TABLE %I ...', t)`) blankes og er usynlige for den statiske skanningen; (b)
 * dollar-siterte strenger (`EXECUTE $q$CREATE TABLE x ...$q$`) leses som kode, så tabellen SES OG flagges. SQL bygd i en variabel og kjørt med `EXECUTE v` ses ikke. RLS-hjelperne
 * (`EXECUTE format('ALTER TABLE %I ENABLE|FORCE ROW LEVEL SECURITY', t)`) er unntatt som eksakt mønster; (2) skjemaprefiks (`public.t`) ignoreres, så to like tabellnavn i ulike skjemaer ville blitt slått sammen
 * (finnes ikke i repoet); (3) funksjonskropper (dollar-sitert) leses som kode, så en INSERT eller CREATE TABLE inni en funksjon som aldri kjøres teller likevel; (4) `ALTER TABLE ... ADD COLUMN` leses for
 * kolonnenavn, men ikke `ALTER COLUMN`/`RENAME COLUMN`/`DROP COLUMN`; (5) UPDATE/DELETE/TRUNCATE mot en annen eiers tabell telles ikke (kun INSERT).
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
const INDEX_RE = new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:(?!ON\\b)${NAME}\\s+)?ON\\s+(?:ONLY\\s+)?(${QUALIFIED})`, "gi");
const POLICY_RE = new RegExp(`\\bCREATE\\s+POLICY\\s+${NAME}\\s+ON\\s+(${QUALIFIED})`, "gi");
const TRIGGER_RE = new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+${NAME}\\s+(?:BEFORE|AFTER|INSTEAD\\s+OF)\\s+[^;]*?\\bON\\s+(${QUALIFIED})`, "gi");
const INSERT_RE = new RegExp(`\\bINSERT\\s+INTO\\s+(${QUALIFIED})`, "gi");
/** PL/pgSQL `EXECUTE <uttrykk>` (dynamisk SQL). `EXECUTE FUNCTION/PROCEDURE` (trigger) og `GRANT/REVOKE EXECUTE ON ...` er ikke det. */
const EXECUTE_RE = /\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE|ON)\b)/gi;
/** Tabell-DDL i teksten til en dynamisk setning (midlertidige tabeller er ikke tilstand og teller ikke, som i den statiske skanningen). */
const DDL_IN_STRING = /\b(?:CREATE\s+(?:UNLOGGED\s+)?TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i;
/** RLS-hjelperne i migrasjonene: nøyaktig `EXECUTE format('ALTER TABLE %I ENABLE|FORCE ROW LEVEL SECURITY', <variabel>)` (etter normalisert mellomrom). DISABLE, NO FORCE og alt annet er IKKE unntatt. */
const RLS_HELPER = /^EXECUTE format\( ?'ALTER TABLE %I (?:ENABLE|FORCE) ROW LEVEL SECURITY' ?, ?[A-Za-z_][A-Za-z0-9_]* ?\)$/i;
const NAME_TOKEN = new RegExp(NAME, "g");
const ADD_COLUMN = new RegExp(`^\\s*ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})(?:\\s+(${QUALIFIED}))?`, "i");
/** Typenavnet rett etter kolonnenavnet i en kolonnedefinisjon (`state ci_state NOT NULL ...`). */
const COLUMN_TYPE = new RegExp(`^\\s*${NAME}\\s+(${QUALIFIED})`);
/** `CREATE TYPE <navn> AS ENUM (`: verdiene leses fra teksten med strenger beholdt. */
const ENUM_RE = new RegExp(`\\bCREATE\\s+TYPE\\s+(${QUALIFIED})\\s+AS\\s+ENUM\\s*\\(`, "gi");
/** `ALTER TYPE <navn> ADD VALUE [IF NOT EXISTS] '<verdi>'` og `RENAME VALUE '<gammel>' TO '<ny>'` (strengen starter ved siste tegn i treffet). */
const ENUM_ADD_RE = new RegExp(`\\bALTER\\s+TYPE\\s+(${QUALIFIED})\\s+ADD\\s+VALUE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'`, "gi");
const ENUM_RENAME_RE = new RegExp(`\\bALTER\\s+TYPE\\s+(${QUALIFIED})\\s+RENAME\\s+VALUE\\s+'`, "gi");
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

/** Kolonnenavn og typenavn fra innholdet i en CREATE TABLE-parentes: tabellbegrensninger (CONSTRAINT/PRIMARY/FOREIGN/UNIQUE/CHECK/EXCLUDE/LIKE som FØRSTE ORD) hoppes over. */
function columnDefs(bodyCode: string): Array<{ name: string; type: string | null }> {
  const out: Array<{ name: string; type: string | null }> = [];
  for (const item of splitTopLevel(bodyCode)) {
    const t = firstToken(item);
    if (t === null) continue;
    if (!t.quoted && TABLE_CONSTRAINT_START.has(t.name)) continue;
    const ty = COLUMN_TYPE.exec(item);
    out.push({ name: t.name, type: ty === null ? null : normalizeName(ty[1] as string) });
  }
  return out;
}

/** Innholdet mellom `(` og tilhørende `)` i teksten (strenger beholdt) som en liste av enkeltapostrof-literaler (`''` blir `'`). */
const literalsIn = (text: string): string[] => [...text.matchAll(/'((?:[^']|'')*)'/g)].map((m) => (m[1] as string).replace(/''/g, "'"));

/** Leser ÉN enkeltapostrof-literal som starter ved `open` (indeksen til åpningsapostrofen): verdien og indeksen rett etter den lukkende apostrofen. */
function readLiteral(text: string, open: number): { value: string; end: number } {
  let j = open + 1;
  let value = "";
  while (j < text.length) {
    if (text[j] === "'") {
      if (text[j + 1] === "'") {
        value += "'";
        j += 2;
        continue;
      }
      break;
    }
    value += text[j];
    j += 1;
  }
  return { value, end: Math.min(j + 1, text.length) };
}

export interface CreatedTable {
  name: string;
  columns: string[];
  /** Typenavnene (små bokstaver, uten skjema) kolonnene bruker, til oppslag av enum-typer. */
  column_types: string[];
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
  /** Typenavnene til de tilføyde kolonnene (uten dem uten type). */
  added_column_types: string[];
}

/** Hva en setning gjør med en tabell uten å endre dens definisjon: indeks, policy, trigger eller innsetting av rader. */
export type TouchKind = "index" | "policy" | "trigger" | "insert";

/** Én setning med posisjon (tegnindeks i filen): hendelsene sorteres på posisjon og prosesseres i den rekkefølgen. */
export type SqlEvent =
  | { kind: "create"; pos: number; table: CreatedTable }
  | { kind: "alter"; pos: number; statement: AlterStatement }
  | { kind: "rename"; pos: number; from: string; to: string }
  | { kind: "drop"; pos: number; name: string }
  | { kind: "touch"; pos: number; touch: { kind: TouchKind; table: string } }
  /** `CREATE TYPE <navn> AS ENUM (...)`. */
  | { kind: "enum"; pos: number; name: string; values: string[] }
  /** `ALTER TYPE <navn> ADD VALUE '<verdi>'` (også den nye verdien i `RENAME VALUE ... TO ...`): en enum-verdi kan komme etter at tabellen finnes. */
  | { kind: "enum_add"; pos: number; name: string; value: string };

/** En `EXECUTE`-setning med tabell-DDL i argumentet (teksten med strenger beholdt, mellomrom normalisert). `rls_helper` = RLS-hjelperen, som er unntatt. */
export interface DynamicDdl {
  statement: string;
  rls_helper: boolean;
}

export interface ParsedMigration {
  file: string;
  created: CreatedTable[];
  /** Unike tabeller (i rekkefølge) med minst én ALTER TABLE. */
  altered: string[];
  alter_statements: AlterStatement[];
  dropped: string[];
  renamed: Array<{ from: string; to: string }>;
  /** ALLE hendelser (create/alter/rename/drop/touch) i tekstrekkefølge. */
  events: SqlEvent[];
  /** Dynamisk tabell-DDL (`EXECUTE`), i tekstrekkefølge. */
  dynamic_ddl: DynamicDdl[];
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

const EVENT_ORDER: Record<SqlEvent["kind"], number> = { create: 0, alter: 1, rename: 2, drop: 3, touch: 4, enum: 5, enum_add: 6 };
const KEEP_BLANK_WS = /\s+/g;

export function parseMigration(file: string, sql: string): ParsedMigration {
  const code = blankSqlNoise(sql);
  const text = blankSqlNoise(sql, { keepStrings: true });
  const events: SqlEvent[] = [];
  const created: CreatedTable[] = [];
  for (const m of code.matchAll(CREATE_RE)) {
    const name = normalizeName(m[3] as string);
    const end = (m.index as number) + m[0].length;
    let k = end;
    while (k < code.length && /\s/.test(code[k] as string)) k += 1;
    let columns: string[] = [];
    let columnTypes: string[] = [];
    let bodyText = "";
    if (code[k] === "(") {
      const close = matchingParen(code, k);
      if (close !== -1) {
        const defs = columnDefs(code.slice(k + 1, close));
        columns = defs.map((d) => d.name);
        columnTypes = defs.flatMap((d) => (d.type === null ? [] : [d.type]));
        bodyText = text.slice(k + 1, close);
      }
    }
    const table: CreatedTable = { name, columns, column_types: columnTypes, temporary: m[1] !== undefined, if_not_exists: m[2] !== undefined, body_text: bodyText };
    created.push(table);
    events.push({ kind: "create", pos: m.index as number, table });
  }

  const alterStatements: AlterStatement[] = [];
  const altered: string[] = [];
  for (const m of code.matchAll(ALTER_RE)) {
    const table = normalizeName(m[1] as string);
    const start = m.index as number;
    const end = statementEnd(code, start + m[0].length);
    const rest = code.slice(start + m[0].length, end);
    const added: string[] = [];
    const addedTypes: string[] = [];
    for (const action of splitTopLevel(rest)) {
      const a = ADD_COLUMN.exec(action);
      if (a === null) continue;
      const first = firstToken(a[1] as string);
      if (first === null) continue;
      // «ADD CONSTRAINT x», «ADD PRIMARY KEY (..)» osv. er ikke kolonner (et anført navn er alltid en kolonne).
      if (!first.quoted && NOT_COLUMN_AFTER_ADD.has(first.name) && !/^\s*ADD\s+COLUMN\b/i.test(action)) continue;
      added.push(first.name);
      if (a[2] !== undefined) addedTypes.push(normalizeName(a[2]));
    }
    const statement: AlterStatement = { table, text: text.slice(start, end), added_columns: added, added_column_types: addedTypes };
    alterStatements.push(statement);
    events.push({ kind: "alter", pos: start, statement });
    if (!altered.includes(table)) altered.push(table);
  }

  const renamed: Array<{ from: string; to: string }> = [];
  for (const m of code.matchAll(RENAME_RE)) {
    const r = { from: normalizeName(m[1] as string), to: normalizeName(m[2] as string) };
    renamed.push(r);
    events.push({ kind: "rename", pos: m.index as number, ...r });
  }

  const dropped: string[] = [];
  for (const m of code.matchAll(DROP_RE)) {
    for (const element of splitTopLevel(m[1] as string)) {
      const name = normalizeName(element);
      dropped.push(name);
      events.push({ kind: "drop", pos: m.index as number, name });
    }
  }

  for (const [re, kind] of [[INDEX_RE, "index"], [POLICY_RE, "policy"], [TRIGGER_RE, "trigger"], [INSERT_RE, "insert"]] as const) {
    for (const m of code.matchAll(re)) events.push({ kind: "touch", pos: m.index as number, touch: { kind, table: normalizeName(m[1] as string) } });
  }

  for (const m of code.matchAll(ENUM_RE)) {
    const open = (m.index as number) + m[0].length - 1;
    const close = matchingParen(code, open);
    if (close !== -1) events.push({ kind: "enum", pos: m.index as number, name: normalizeName(m[1] as string), values: literalsIn(text.slice(open + 1, close)) });
  }
  for (const m of code.matchAll(ENUM_ADD_RE)) {
    const lit = readLiteral(text, (m.index as number) + m[0].length - 1);
    events.push({ kind: "enum_add", pos: m.index as number, name: normalizeName(m[1] as string), value: lit.value });
  }
  for (const m of code.matchAll(ENUM_RENAME_RE)) {
    const old = readLiteral(text, (m.index as number) + m[0].length - 1);
    const to = /^\s+TO\s+'/i.exec(text.slice(old.end));
    if (to !== null) events.push({ kind: "enum_add", pos: m.index as number, name: normalizeName(m[1] as string), value: readLiteral(text, old.end + to[0].length - 1).value });
  }

  const dynamic: DynamicDdl[] = [];
  for (const m of code.matchAll(EXECUTE_RE)) {
    const start = m.index as number;
    const statement = text.slice(start, statementEnd(code, start + m[0].length)).replace(KEEP_BLANK_WS, " ").trim();
    if (DDL_IN_STRING.test(statement)) dynamic.push({ statement, rls_helper: RLS_HELPER.test(statement) });
  }

  events.sort((a, b) => a.pos - b.pos || EVENT_ORDER[a.kind] - EVENT_ORDER[b.kind]);
  return { file, created, altered, alter_statements: alterStatements, dropped, renamed, events, dynamic_ddl: dynamic };
}

export interface EffectiveTable {
  name: string;
  /** Filen som opprettet tabellen (følger med en RENAME). */
  created_in: string;
  /** Kolonner fra CREATE TABLE pluss `ADD COLUMN` i senere ALTER (kun navn). */
  columns: string[];
  /**
   * CREATE-kroppen og ALTER-setningene som berører tabellen (strenger beholdt), pluss én linje `ENUM <type> ('verdi', ...)` for hver enum-type en kolonne bruker (verdiene slik de står ETTER alle
   * migrasjoner): leses av literalreglene (ACTIVE-vakten), så en forbudt verdi i en enum-type ikke slipper unna fordi den står utenfor tabellen.
   */
  definition_text: string;
  /** Typenavnene kolonnene bruker (til enum-oppslaget). Utelatt i hånd-bygde fakta. */
  column_types?: string[];
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
  /** Hver endring av en tabell i en fil: ALTER (uten `via`) eller indeks/policy/trigger/insert (med `via`). Eieren av tabellen må kvittere filen (PGA-D-07). */
  alters: Array<{ table: string; file: string; via?: TouchKind }>;
  /** Tabell opprettet to ganger uten DROP imellom (uten IF NOT EXISTS). */
  duplicates: Array<{ table: string; files: string[] }>;
  /** Dynamisk tabell-DDL (`EXECUTE`) som IKKE er en RLS-hjelper, med filen den står i. */
  dynamic_ddl: Array<{ file: string; statement: string }>;
}

/** Filene behandles i navnerekkefølge (NNN_navn.sql), uansett hvilken rekkefølge de gis i; setningene i hver fil i TEKSTREKKEFØLGE. */
export function parseMigrationSet(files: ReadonlyArray<{ name: string; sql: string }>): MigrationSet {
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const tables = new Map<string, EffectiveTable>();
  const created: CreatedRecord[] = [];
  const alters: Array<{ table: string; file: string; via?: TouchKind }> = [];
  const duplicates: Array<{ table: string; files: string[] }> = [];
  const dynamic: Array<{ file: string; statement: string }> = [];
  const enums = new Map<string, string[]>();
  for (const f of ordered) {
    const m = parseMigration(f.name, f.sql);
    for (const ev of m.events) {
      switch (ev.kind) {
        case "create": {
          const c = ev.table;
          if (c.temporary) break;
          const existing = tables.get(c.name);
          if (existing !== undefined) {
            if (!c.if_not_exists) duplicates.push({ table: c.name, files: [existing.created_in, f.name] });
            break;
          }
          tables.set(c.name, { name: c.name, created_in: f.name, columns: [...c.columns], definition_text: c.body_text, column_types: [...c.column_types] });
          created.push({ name: c.name, file: f.name });
          break;
        }
        case "alter": {
          const a = ev.statement;
          alters.push({ table: a.table, file: f.name });
          const t = tables.get(a.table);
          if (t !== undefined) {
            for (const col of a.added_columns) if (!t.columns.includes(col)) t.columns.push(col);
            t.column_types = [...(t.column_types ?? []), ...a.added_column_types];
            t.definition_text += `\n${a.text}`;
          }
          break;
        }
        case "rename": {
          const t = tables.get(ev.from);
          if (t === undefined) break;
          tables.delete(ev.from);
          tables.set(ev.to, { ...t, name: ev.to });
          break;
        }
        case "drop": {
          if (!tables.delete(ev.name)) break;
          for (let i = created.length - 1; i >= 0; i -= 1) {
            const rec = created[i] as CreatedRecord;
            if (rec.name === ev.name && rec.dropped_in === undefined) {
              rec.dropped_in = f.name;
              break;
            }
          }
          break;
        }
        case "touch":
          alters.push({ table: ev.touch.table, file: f.name, via: ev.touch.kind });
          break;
        case "enum":
          enums.set(ev.name, [...ev.values]);
          break;
        case "enum_add":
          enums.set(ev.name, [...(enums.get(ev.name) ?? []), ev.value]);
          break;
      }
    }
    for (const d of m.dynamic_ddl) if (!d.rls_helper) dynamic.push({ file: f.name, statement: d.statement });
  }
  // Enum-verdiene slik de står etter ALLE filer (en `ALTER TYPE ... ADD VALUE` kan komme lenge etter tabellen) føres inn i definisjonsteksten til hver tabell som bruker typen.
  for (const t of tables.values()) {
    for (const type of new Set(t.column_types ?? [])) {
      const values = enums.get(type);
      if (values !== undefined) t.definition_text += `\nENUM ${type} (${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")})`;
    }
  }
  return { tables, created, alters, duplicates, dynamic_ddl: dynamic };
}

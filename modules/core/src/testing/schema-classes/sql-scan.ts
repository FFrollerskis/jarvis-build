/**
 * WP-MC8a (HF3 MC-8 del a): minimal SQL-skanner for migrasjonsfilene.
 *
 * Skanneren gjør kun det klassifiseringslinten trenger: finne kommentarer (direktiver), blanke ut literal-innhold (slik at et `CREATE TABLE`
 * i en streng aldri regnes som DDL), dele i setninger og finne `CREATE/DROP TABLE`. Den er IKKE en SQL-parser. Alt den ikke kan avgjøre
 * (dynamisk DDL i `EXECUTE`, `RENAME`, visninger, ikke-public skjema) rapporteres eksplisitt som `unsupported`/`dynamic` i stedet for å
 * hoppes over stille - katalogsjekken mot en migrert database er alltid den endelige sannheten.
 */

export interface SqlComment {
  readonly line: number;
  /** Teksten etter `--` (uten ledende `--`). */
  readonly text: string;
}

export interface DollarBlock {
  readonly tag: string;
  /** Råtekst mellom åpnende og lukkende dollar-tagg. */
  readonly body: string;
  /** Indeks i kildeteksten (og i `code`) der åpnende tagg starter. */
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

export interface SqlScan {
  /** Kilden med kommentarer og literal-innhold blanket ut (samme lengde og samme linjeskift som kilden). */
  readonly code: string;
  readonly comments: readonly SqlComment[];
  readonly dollarBlocks: readonly DollarBlock[];
}

export class SqlScanError extends Error {
  constructor(
    readonly kind: "unterminated_string" | "unterminated_comment" | "unterminated_dollar_quote" | "unterminated_identifier",
    readonly line: number
  ) {
    super(`sql_scan_${kind}:linje ${line}`);
    this.name = "SqlScanError";
  }
}

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

function blank(segment: string): string {
  return segment.replace(/[^\n]/g, " ");
}

function newlines(segment: string): number {
  let n = 0;
  for (const ch of segment) if (ch === "\n") n += 1;
  return n;
}

export function scanSql(sql: string): SqlScan {
  const out: string[] = [];
  const comments: SqlComment[] = [];
  const dollarBlocks: DollarBlock[] = [];
  const n = sql.length;
  let i = 0;
  let line = 1;
  while (i < n) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      let j = i;
      while (j < n && sql[j] !== "\n") j += 1;
      comments.push({ line, text: sql.slice(i + 2, j) });
      out.push(" ".repeat(j - i));
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth += 1;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      if (depth > 0) throw new SqlScanError("unterminated_comment", line);
      const seg = sql.slice(i, j);
      out.push(blank(seg));
      line += newlines(seg);
      i = j;
      continue;
    }
    if (ch === "'") {
      // E'...' tillater backslash-escapes; vanlige strenger bruker kun '' som escape.
      const prev = sql[i - 1];
      const beforePrev = sql[i - 2];
      const escapeString = (prev === "E" || prev === "e") && (beforePrev === undefined || !IDENT_CHAR.test(beforePrev));
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = sql[j] as string;
        if (escapeString && c === "\\") {
          j += 2;
          continue;
        }
        if (c === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) throw new SqlScanError("unterminated_string", line);
      const seg = sql.slice(i + 1, j);
      out.push("'", blank(seg), "'");
      line += newlines(seg);
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      // Sitert identifikator: beholdes synlig (navnet kan være en tabell), men kommentartegn inni den tolkes ikke.
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) throw new SqlScanError("unterminated_identifier", line);
      out.push(sql.slice(i, j + 1));
      line += newlines(sql.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const prev = sql[i - 1];
      const m = prev !== undefined && IDENT_CHAR.test(prev) ? null : DOLLAR_TAG.exec(sql.slice(i, i + 80));
      if (m !== null) {
        const open = m[0];
        const closeAt = sql.indexOf(open, i + open.length);
        if (closeAt === -1) throw new SqlScanError("unterminated_dollar_quote", line);
        const body = sql.slice(i + open.length, closeAt);
        dollarBlocks.push({ tag: m[1] ?? "", body, start: i, end: closeAt + open.length, line });
        out.push(open, blank(body), open);
        line += newlines(body);
        i = closeAt + open.length;
        continue;
      }
    }
    if (ch === "\n") line += 1;
    out.push(ch);
    i += 1;
  }
  return { code: out.join(""), comments, dollarBlocks };
}

export interface SqlStatement {
  /** Setningen med kommentarer/literaler blanket ut (ingen avsluttende `;`). */
  readonly text: string;
  readonly start: number;
  readonly line: number;
}

/** Deler den blankede koden på `;`. Dollar-siterte kropper er blanket, så `;` inni funksjons-/DO-kropper deler ikke. */
export function splitStatements(scan: SqlScan): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let startIdx = 0;
  let line = 1;
  let stmtLine = 1;
  const code = scan.code;
  const push = (end: number): void => {
    const text = code.slice(startIdx, end);
    if (text.trim() !== "") {
      const lead = text.length - text.trimStart().length;
      statements.push({ text: text.trim(), start: startIdx + lead, line: stmtLine + newlines(text.slice(0, lead)) });
    }
  };
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "\n") line += 1;
    if (ch === ";") {
      push(i);
      startIdx = i + 1;
      stmtLine = line;
    }
  }
  push(code.length);
  return statements;
}

export interface TableName {
  /** Skjemanavn slik det står (null hvis ikke oppgitt). */
  readonly schema: string | null;
  /** Tabellnavn; ukvotert navn er foldet til små bokstaver (som Postgres). */
  readonly name: string;
  readonly quoted: boolean;
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;

export function parseTableName(raw: string): TableName {
  const parts: Array<{ text: string; quoted: boolean }> = [];
  const re = new RegExp(IDENT, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const token = m[0];
    parts.push(token.startsWith('"') ? { text: token.slice(1, -1).replace(/""/g, '"'), quoted: true } : { text: token.toLowerCase(), quoted: false });
  }
  const last = parts[parts.length - 1];
  const first = parts.length > 1 ? parts[0] : undefined;
  if (last === undefined) return { schema: null, name: raw.trim(), quoted: false };
  return { schema: first?.text ?? null, name: last.text, quoted: parts.some((p) => p.quoted) };
}

export type TableEvent =
  | { readonly op: "create"; readonly table: TableName; readonly line: number; readonly temporary: boolean; readonly viaDo: boolean }
  | { readonly op: "drop"; readonly table: TableName; readonly line: number; readonly viaDo: boolean };

export interface UnsupportedDdl {
  readonly line: number;
  readonly what: string;
}

export interface DefinerFunction {
  /** Funksjonsnavn uten argumenter (små bokstaver). */
  readonly name: string;
  readonly line: number;
}

export interface SqlAnalysis {
  readonly events: TableEvent[];
  readonly unsupported: UnsupportedDdl[];
  /** `CREATE TABLE` skjult i en streng i en DO-blokk (EXECUTE): kan ikke klassifiseres statisk. */
  readonly dynamicCreates: number[];
  readonly definerFunctions: DefinerFunction[];
  readonly comments: readonly SqlComment[];
}

const CREATE_TABLE = new RegExp(String.raw`^create\s+(?:(?:global\s+|local\s+)?(temp|temporary)\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(${QUALIFIED})`, "i");
const DROP_TABLE = /^drop\s+table\s+(?:if\s+exists\s+)?([\s\S]+?)(?:\s+(?:cascade|restrict))?$/i;
const CREATE_FUNCTION = new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?function\s+(${QUALIFIED})\s*\(`, "i");
const DYNAMIC_CREATE = /create\s+(?:(?:unlogged|temp|temporary|global|local)\s+)*table/gi;

function analyseStatement(stmt: SqlStatement, viaDo: boolean, into: SqlAnalysis, lineOffset: number): void {
  const text = stmt.text;
  const line = stmt.line + lineOffset;
  const create = CREATE_TABLE.exec(text);
  if (create !== null) {
    const table = parseTableName(create[2] as string);
    const rest = text.slice(create[0].length);
    if (/^\s*(?:\([^)]*\)\s*)?partition\s+of\b/i.test(rest) || /^\s*partition\s+of\b/i.test(rest)) {
      into.unsupported.push({ line, what: `CREATE TABLE ${table.name} ... PARTITION OF (partisjoner støttes ikke av klassifiseringen)` });
    }
    into.events.push({ op: "create", table, line, temporary: create[1] !== undefined, viaDo });
    return;
  }
  const drop = DROP_TABLE.exec(text);
  if (drop !== null) {
    for (const part of (drop[1] as string).split(",")) {
      if (part.trim() !== "") into.events.push({ op: "drop", table: parseTableName(part.trim()), line, viaDo });
    }
    return;
  }
  if (/^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?\S+\s+rename\s+to\s+/i.test(text)) {
    into.unsupported.push({ line, what: "ALTER TABLE ... RENAME TO (gi ny tabell + kopi + DROP i stedet; klassifiseringen sporer ikke omdøping)" });
    return;
  }
  if (/^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?\S+\s+set\s+schema\s+/i.test(text)) {
    into.unsupported.push({ line, what: "ALTER TABLE ... SET SCHEMA (kun skjemaet `public` støttes)" });
    return;
  }
  if (/^create\s+(?:or\s+replace\s+)?(?:(?:global\s+|local\s+)?(?:temp|temporary)\s+)?(?:recursive\s+)?(?:materialized\s+)?view\b/i.test(text)) {
    into.unsupported.push({ line, what: "CREATE VIEW/MATERIALIZED VIEW (en visning eid av en superbruker omgår RLS; ingen klasse finnes for visninger)" });
    return;
  }
  if (/^create\s+foreign\s+table\b/i.test(text)) {
    into.unsupported.push({ line, what: "CREATE FOREIGN TABLE (støttes ikke av klassifiseringen)" });
    return;
  }
  if (/^create\s+schema\b/i.test(text)) {
    into.unsupported.push({ line, what: "CREATE SCHEMA (kun skjemaet `public` støttes av klassifiseringen)" });
    return;
  }
  const fn = CREATE_FUNCTION.exec(text);
  if (fn !== null && /\bsecurity\s+definer\b/i.test(text)) {
    into.definerFunctions.push({ name: parseTableName(fn[1] as string).name, line });
  }
}

/** Analyserer én migrasjonsfil: tabellhendelser (også i DO-blokker), ustøttet DDL, dynamisk `CREATE TABLE` og DEFINER-funksjoner. */
export function analyseSql(sql: string): SqlAnalysis {
  const scan = scanSql(sql);
  const result: SqlAnalysis = { events: [], unsupported: [], dynamicCreates: [], definerFunctions: [], comments: scan.comments };
  for (const stmt of splitStatements(scan)) {
    analyseStatement(stmt, false, result, 0);
    if (/^do\b/i.test(stmt.text)) {
      for (const block of scan.dollarBlocks) {
        if (block.start < stmt.start || block.end > stmt.start + stmt.text.length + 1) continue;
        const inner = scanSql(block.body);
        const innerStatements = splitStatements(inner);
        let staticCreates = 0;
        for (const innerStmt of innerStatements) {
          // PL/pgSQL-setninger kan stå etter `BEGIN`/`THEN`/`LOOP`: fjern et ledende blokkstartord før DDL-gjenkjenning.
          const cleaned: SqlStatement = { ...innerStmt, text: innerStmt.text.replace(/^(?:declare\b[\s\S]*?)?begin\s+/i, "").replace(/^(?:then|loop|else)\s+/i, "") };
          const before = result.events.length;
          analyseStatement(cleaned, true, result, block.line - 1);
          if (result.events.length > before && result.events[result.events.length - 1]?.op === "create") staticCreates += 1;
        }
        const rawWithoutComments = block.body.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
        const rawCount = (rawWithoutComments.match(DYNAMIC_CREATE) ?? []).length;
        if (rawCount > staticCreates) result.dynamicCreates.push(block.line);
      }
    }
  }
  return result;
}

/**
 * WP-C2 (review F2): `globals.sql` er UBETRODD INNDATA. age-kryptering er ikke autentisert - alle som kjenner den OFFENTLIGE nøkkelen kan lage et sett som er
 * konsistent mot sitt eget manifest (sjekksummene beviser ikke hvem som laget det). Å mate den dekrypterte teksten rett til `psql -f -` betyr derfor at et sett kan
 * kjøre psql-metakommandoer (`\! kommando`, `\i`, `\copy`, `\o`, ...) på verifisererens vert. Dette er filteret mellom dekrypteringen og psql.
 *
 * Fremgangsmåte: teksten tokeniseres (strenger og siterte identifikatorer maskeres ut først), delt i setninger ved `;` utenfor sitat, og HVER setning må passe en
 * av noen få, kjente former - det samme `pg_dumpall --globals-only` skriver. Alt annet nektes (hele filen), og det som slippes gjennom skrives på nytt fra de
 * validerte delene (aldri den rå teksten). Konkret:
 *  - ENHVER backslash nektes, også inne i strenger (psql-leksikonet leser backslash ulikt etter `standard_conforming_strings`, så ingen tolkning er trygg) - med ÉTT
 *    unntak: `\restrict <nøkkel>` / `\unrestrict <nøkkel>` som egne linjer (pg_dumpall ≥ 16.10 skriver dem selv; de fjernes og sendes ikke videre).
 *  - `$` (dollar-sitert tekst), `:` (psql-variabler), blokk-kommentarer, prefiksede strenger (`E'..'`, `U&'..'`), kontrolltegn og ikke-ASCII utenfor sitat nektes.
 *  - Setningene som tillates: `SET <navn> = <verdi>`, `CREATE ROLE <navn>`, `ALTER ROLE <navn> WITH <roller-valg>`, `ALTER ROLE <navn> [IN DATABASE <db>] SET <navn> TO <verdier>`,
 *    `GRANT <rolle> TO <rolle> [WITH ...] [GRANTED BY <rolle>]`, `COMMENT ON ROLE <navn> IS <tekst>` og `SELECT pg_catalog.set_config('search_path', '', false)`.
 *  - `PASSWORD '…'` FJERNES fra `ALTER ROLE`: scratch-serveren skal ikke arve produksjonens passord-hasher (og en feilpekt scratch skal aldri få passordene overskrevet).
 * Ingenting herfra gjør det trygt å restore en UBETRODD custom-format-dump (`pg_restore`) mot en vanlig database - se runbook §6.6: restore kun til en kastbar instans.
 */
export const GLOBALS_MAX_BYTES = 4 * 1024 * 1024;
const MAX_STATEMENTS = 20_000;
const RESTRICT_LINE = /^\\(?:un)?restrict [A-Za-z0-9]{1,128}$/;

export class GlobalsRejectedError extends Error {
  /** @param {string} reason kort, uten innhold fra filen @param {number | null} line */
  constructor(reason, line = null) {
    super(`globals.sql nektes: ${reason}${line === null ? "" : ` (linje ${line})`}`);
    this.name = "GlobalsRejectedError";
    this.code = "globals_rejected";
    this.reason = reason;
    this.line = line;
  }
}

const STR_OPEN = "\u0001";
const STR_CLOSE = "\u0002";
const ID_OPEN = "\u0003";
const ID_CLOSE = "\u0004";

/** Maskerer strenger/siterte identifikatorer og deler i setninger. Kaster `GlobalsRejectedError`. */
function tokenize(text) {
  const statements = [];
  let masked = "";
  let lits = [];
  let stmtLine = 1;
  let line = 1;
  let atLineStart = true;
  let lastWasLiteral = false;
  const n = text.length;
  let i = 0;
  const reject = (reason, at = line) => new GlobalsRejectedError(reason, at);
  const emptyStatement = () => masked.trim() === "";
  const space = () => {
    if (!masked.endsWith(" ")) masked += " ";
    lastWasLiteral = false;
  };

  while (i < n) {
    const ch = text[i];
    if (atLineStart && ch === "\\") {
      const eol = text.indexOf("\n", i);
      const lineText = text.slice(i, eol === -1 ? n : eol).replace(/\r$/, "");
      if (emptyStatement() && RESTRICT_LINE.test(lineText)) {
        i = eol === -1 ? n : eol; // selve linjeskiftet håndteres under
        continue;
      }
      throw reject("backslash (psql-metakommando) er ikke tillatt");
    }
    if (ch === "\n") {
      line += 1;
      atLineStart = true;
      space();
      i += 1;
      continue;
    }
    atLineStart = false;
    if (ch === " " || ch === "\t" || ch === "\r") {
      space();
      i += 1;
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      const eol = text.indexOf("\n", i);
      i = eol === -1 ? n : eol;
      space();
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") throw reject("blokk-kommentarer er ikke tillatt");
    if (ch === "\\") throw reject("backslash (psql-metakommando) er ikke tillatt");
    if (ch === "'" || ch === '"') {
      const prev = masked.at(-1) ?? " ";
      if (/[A-Za-z0-9_&$]/.test(prev) || lastWasLiteral) throw reject("prefiksert eller sammenhengende tekst-literal er ikke tillatt");
      const startLine = line;
      let j = i + 1;
      let content = "";
      for (;;) {
        if (j >= n) throw reject("uavsluttet sitat", startLine);
        const c = text[j];
        if (c === "\\") throw reject("backslash i tekst er ikke tillatt", line);
        if (c === ch) {
          if (text[j + 1] === ch) {
            content += ch + ch;
            j += 2;
            continue;
          }
          break;
        }
        if (c === "\n") line += 1;
        content += c;
        j += 1;
      }
      const index = lits.length;
      lits.push({ kind: ch === "'" ? "str" : "id", text: content });
      masked += ch === "'" ? `${STR_OPEN}${index}${STR_CLOSE}` : `${ID_OPEN}${index}${ID_CLOSE}`;
      lastWasLiteral = true;
      i = j + 1;
      continue;
    }
    if (lastWasLiteral && /[A-Za-z0-9_]/.test(ch)) throw reject("tekst-literal direkte etterfulgt av tegn");
    if (ch === ";") {
      if (!emptyStatement()) statements.push({ masked: masked.trim(), lits, line: stmtLine });
      masked = "";
      lits = [];
      stmtLine = line;
      lastWasLiteral = false;
      i += 1;
      continue;
    }
    if (/[A-Za-z0-9_,=().-]/.test(ch)) {
      if (emptyStatement()) stmtLine = line;
      masked += ch;
      lastWasLiteral = false;
      i += 1;
      continue;
    }
    if (ch === "$") throw reject("dollar-sitert tekst er ikke tillatt");
    if (ch === ":") throw reject("psql-variabel (:navn) er ikke tillatt");
    throw reject("uventet tegn utenfor sitert tekst");
  }
  if (!emptyStatement()) throw reject("siste setning mangler avsluttende semikolon", stmtLine);
  return statements;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Tillatte former (på den maskerte, whitespace-normaliserte setningen)
// ---------------------------------------------------------------------------------------------------------------------------------------------
const WORD = "[A-Za-z_][A-Za-z0-9_]*";
const GUC = `${WORD}(?:\\.${WORD})?`;
const ID = `(?:${WORD}|${ID_OPEN}\\d+${ID_CLOSE})`;
const STR = `${STR_OPEN}\\d+${STR_CLOSE}`;
const NUM = "-?\\d+";
const VAL = `(?:${STR}|${NUM}|${WORD}|${ID})`;
const VALS = `${VAL}(?: ?, ?${VAL})*`;

const RE_SET = new RegExp(`^SET (${GUC}) ?(?:=|TO) ?(${VALS})$`, "i");
const RE_SET_CONFIG = new RegExp(`^SELECT pg_catalog\\.set_config\\((${STR}), ?(${STR}), ?(false|true)\\)$`, "i");
const RE_CREATE_ROLE = new RegExp(`^CREATE ROLE (${ID})$`, "i");
const RE_ALTER_ROLE_WITH = new RegExp(`^ALTER ROLE (${ID}) WITH (.+)$`, "i"); // valgene valideres token for token i roleOptions()
const RE_ALTER_ROLE_SET = new RegExp(`^ALTER ROLE (${ID})(?: IN DATABASE (${ID}))? SET (${GUC}) ?(?:=|TO) ?(${VALS})$`, "i");
const RE_GRANT = new RegExp(`^GRANT (${ID}) TO (${ID})((?: WITH [A-Za-z ,]+?)?)((?: GRANTED BY ${ID})?)$`, "i");
const RE_COMMENT = new RegExp(`^COMMENT ON ROLE (${ID}) IS (${STR}|NULL)$`, "i");

/** Rolle-valg i `ALTER ROLE … WITH`: lukket sett; `PASSWORD` fjernes. Returnerer null hvis noe annet finnes. */
const ROLE_FLAGS = new Set(["SUPERUSER", "NOSUPERUSER", "INHERIT", "NOINHERIT", "CREATEROLE", "NOCREATEROLE", "CREATEDB", "NOCREATEDB", "LOGIN", "NOLOGIN", "REPLICATION", "NOREPLICATION", "BYPASSRLS", "NOBYPASSRLS"]);
function roleOptions(optionText) {
  const tokens = optionText.split(" ").filter(Boolean);
  const keep = [];
  let passwordsStripped = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toUpperCase();
    if (ROLE_FLAGS.has(t)) {
      keep.push(tokens[i]);
    } else if (t === "CONNECTION" && tokens[i + 1]?.toUpperCase() === "LIMIT" && /^-?\d+$/.test(tokens[i + 2] ?? "")) {
      keep.push(tokens[i], tokens[i + 1], tokens[i + 2]);
      i += 2;
    } else if (t === "VALID" && tokens[i + 1]?.toUpperCase() === "UNTIL" && new RegExp(`^${STR}$`).test(tokens[i + 2] ?? "")) {
      keep.push(tokens[i], tokens[i + 1], tokens[i + 2]);
      i += 2;
    } else if (t === "PASSWORD" && (new RegExp(`^${STR}$`).test(tokens[i + 1] ?? "") || tokens[i + 1]?.toUpperCase() === "NULL")) {
      passwordsStripped += 1;
      i += 1;
    } else {
      return null;
    }
  }
  return { keep, passwordsStripped };
}

const GRANT_OPTION = /^(?:ADMIN|INHERIT|SET) (?:OPTION|TRUE|FALSE)$/i;

function unmask(masked, lits) {
  return masked
    .replace(new RegExp(`${STR_OPEN}(\\d+)${STR_CLOSE}`, "g"), (_m, idx) => `'${lits[Number(idx)].text}'`)
    .replace(new RegExp(`${ID_OPEN}(\\d+)${ID_CLOSE}`, "g"), (_m, idx) => `"${lits[Number(idx)].text}"`);
}

/** Returnerer den rene setningen (uten semikolon) eller kaster. `stripped` teller fjernede passord. */
function classify(stmt) {
  const { masked, lits } = stmt;
  let m;
  if ((m = RE_SET.exec(masked)) !== null) return { text: masked, stripped: 0 };
  if ((m = RE_SET_CONFIG.exec(masked)) !== null) {
    const [, a, b, flag] = m;
    if (lits[Number(a.slice(1, -1))].text === "search_path" && lits[Number(b.slice(1, -1))].text === "" && flag.toLowerCase() === "false") return { text: masked, stripped: 0 };
    throw new GlobalsRejectedError("set_config med annet enn search_path", stmt.line);
  }
  if (RE_CREATE_ROLE.test(masked)) return { text: masked, stripped: 0 };
  if ((m = RE_ALTER_ROLE_WITH.exec(masked)) !== null) {
    const options = roleOptions(m[2]);
    if (options === null) throw new GlobalsRejectedError("ALTER ROLE med ukjent valg", stmt.line);
    if (options.keep.length === 0) return { text: null, stripped: options.passwordsStripped };
    return { text: `ALTER ROLE ${m[1]} WITH ${options.keep.join(" ")}`, stripped: options.passwordsStripped };
  }
  if (RE_ALTER_ROLE_SET.test(masked)) return { text: masked, stripped: 0 };
  if ((m = RE_GRANT.exec(masked)) !== null) {
    const withPart = m[3].trim();
    if (withPart !== "") {
      const options = withPart.replace(/^WITH /i, "").split(",").map((s) => s.trim());
      if (options.some((o) => !GRANT_OPTION.test(o))) throw new GlobalsRejectedError("GRANT med ukjent valg", stmt.line);
    }
    return { text: masked, stripped: 0 };
  }
  if (RE_COMMENT.test(masked)) return { text: masked, stripped: 0 };
  throw new GlobalsRejectedError("setning utenfor de tillatte formene", stmt.line);
}

/**
 * @param {string} text dekryptert `globals.sql`
 * @returns {{ sql: string, statements: number, passwordsStripped: number }} `sql` er SAFE å sende til `psql -f -` (kun validerte, gjenoppbygde setninger)
 * @throws {GlobalsRejectedError}
 */
export function sanitizeGlobals(text) {
  if (typeof text !== "string") throw new GlobalsRejectedError("ikke tekst");
  if (Buffer.byteLength(text, "utf8") > GLOBALS_MAX_BYTES) throw new GlobalsRejectedError("for stor");
  // eslint-disable-next-line no-control-regex
  const bad = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.exec(text);
  if (bad !== null) throw new GlobalsRejectedError("kontrolltegn", text.slice(0, bad.index).split("\n").length);
  const statements = tokenize(text);
  if (statements.length > MAX_STATEMENTS) throw new GlobalsRejectedError("for mange setninger");
  const out = [];
  let passwordsStripped = 0;
  for (const stmt of statements) {
    const result = classify(stmt);
    passwordsStripped += result.stripped;
    if (result.text !== null) out.push(`${unmask(result.text, stmt.lits)};`);
  }
  const sql = out.length === 0 ? "" : `${out.join("\n")}\n`;
  // Siste forsvarslinje, uavhengig av tokenisereren: det som går til psql har aldri en backslash (ingen metakommando kan finnes) eller våre interne plassholdertegn.
  // eslint-disable-next-line no-control-regex
  if (sql.includes("\\") || /[\u0001-\u0004]/.test(sql)) throw new GlobalsRejectedError("intern kontroll: utdata inneholder forbudte tegn");
  return { sql, statements: out.length, passwordsStripped };
}

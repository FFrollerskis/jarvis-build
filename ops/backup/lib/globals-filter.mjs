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
 *  - Setningene som tillates: `SET <navn> = <verdi>`, `CREATE ROLE <navn>`, `ALTER ROLE <navn> WITH <roller-valg>`, `ALTER ROLE <navn> [IN DATABASE <db>] SET <navn> TO <verdier>`
 *    (kun parametere på `ROLE_SET_ALLOWLIST`), `GRANT <rolle> TO <rolle> [WITH ...] [GRANTED BY <rolle>]`, `COMMENT ON ROLE <navn> IS <tekst>` og
 *    `SELECT pg_catalog.set_config('search_path', '', false)`.
 *  - `PASSWORD '…'` FJERNES fra `ALTER ROLE`: scratch-serveren skal ikke arve produksjonens passord-hasher (og en feilpekt scratch skal aldri få passordene overskrevet).
 *
 * Review runde 2 (M1) - ROLLEN VERIFISERINGEN SELV LOGGER INN SOM og klyngeglobale effekter:
 *  - Rollenavn-posisjon godtar aldri nøkkelordene `CURRENT_USER`, `SESSION_USER`, `CURRENT_ROLE`, `ALL`, `PUBLIC` og `NONE` (bare ord, ikke siterte navn): `ALTER ROLE CURRENT_USER WITH NOLOGIN`
 *    og `ALTER ROLE ALL SET …` ville truffet verifisereren selv / ALLE roller i klyngen.
 *  - Setninger som angår innloggingsrollen (`CREATE ROLE`, `ALTER ROLE … WITH/SET`, `COMMENT ON ROLE` for DEN rollen) HOPPES OVER og sendes aldri til psql (telles i `skippedLoginRole`).
 *    Valgt framfor å nekte filen: ENHVER ekte `pg_dumpall` inneholder `CREATE ROLE postgres; ALTER ROLE postgres WITH SUPERUSER … LOGIN …` (kildens bootstrap-superbruker), så å nekte ville
 *    felt hver ekte verifisering; å hoppe over er like lukket (verifisererens rolle røres aldri: `ALTER ROLE postgres WITH NOLOGIN` låste ellers ut `psql -U postgres` for resten
 *    av kjøringen) og gir minst overraskelse (scratch har allerede rollen). Sammenligningen er case-insensitiv og følger Postgres sin 63-byte-avkorting av identifikatorer (over-treff er trygt).
 *  - `ALTER ROLE … SET <parameter>` lagres KLYNGEGLOBALT (overlever `DROP DATABASE`-oppryddingen) og leses ved neste tilkobling: `session_preload_libraries = '/tmp/x.so'` ville vært
 *    kodelasting. Kun en kort allowlist av ufarlige parametere slippes gjennom; alt annet (også `*_preload_libraries`, `dynamic_library_path`, `session_replication_role`, `role`,
 *    `session_authorization` og enhver punktum-parameter) nekter hele filen.
 *
 * Review runde 2 (M2) - KVADRATISK CPU: strenger bygges som array (`parts.join`), «har setningen innhold?» er et flagg (ikke `trim()` per tegn), og hver setning har et tak
 * (`GLOBALS_MAX_STATEMENT_CHARS`) som avviser en fiendtlig lang setning etter 8 KiB i stedet for å tokenisere alt. Antall setninger avvises underveis (ikke først etter tokeniseringen).
 *
 * Ingenting herfra gjør det trygt å restore en UBETRODD custom-format-dump (`pg_restore`) mot en vanlig database - se runbook §6.6: restore kun til en kastbar instans.
 */
export const GLOBALS_MAX_BYTES = 4 * 1024 * 1024;
/** Tak per setning, i tegn fra første innholdstegn til semikolonet (inkl. kommentarer og sitert tekst inni): en ekte `pg_dumpall`-setning er langt under dette. */
export const GLOBALS_MAX_STATEMENT_CHARS = 8 * 1024;
const MAX_STATEMENTS = 20_000;
const RESTRICT_LINE = /^\\(?:un)?restrict [A-Za-z0-9]{1,128}$/;

/**
 * Parametere `ALTER ROLE … SET` får sette på scratch-serveren. Bevisst kort: ufarlige visnings-/tidsavbrudds-/minneinnstillinger. IKKE (og aldri) `*_preload_libraries`,
 * `dynamic_library_path`, `session_replication_role`, `role`, `session_authorization`, `log_*` utover `log_statement`, eller noe med punktum (utvidelses-/egendefinerte parametere).
 * Trenger en ekte kilde en til, legg den til HER etter en vurdering - verifiseringen feiler høylytt (`globals`-trinnet) til da, i stedet for å kjøre noe ukjent.
 */
export const ROLE_SET_ALLOWLIST = Object.freeze(new Set([
  "search_path", "statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout", "idle_session_timeout", "application_name", "log_statement",
  "timezone", "datestyle", "intervalstyle", "client_encoding", "default_transaction_read_only", "work_mem", "maintenance_work_mem"
]));
/** Nøkkelord (ikke siterte navn) som aldri er et konkret rollenavn: de peker på «meg selv», «alle» eller «ingen». */
const RESERVED_ROLE_WORDS = new Set(["current_user", "session_user", "current_role", "all", "public", "none"]);

export class GlobalsRejectedError extends Error {
  /** @param {string} reason kort, uten innhold fra filen @param {number | null} line @param {string} kind stabil, maskinlesbar årsak (f.eks. `statement_too_long`) */
  constructor(reason, line = null, kind = "rejected") {
    super(`globals.sql nektes: ${reason}${line === null ? "" : ` (linje ${line})`}`);
    this.name = "GlobalsRejectedError";
    this.code = "globals_rejected";
    this.reason = reason;
    this.line = line;
    this.kind = kind;
  }
}

const STR_OPEN = "\u0001";
const STR_CLOSE = "\u0002";
const ID_OPEN = "\u0003";
const ID_CLOSE = "\u0004";

/**
 * Maskerer strenger/siterte identifikatorer og deler i setninger. Kaster `GlobalsRejectedError`.
 * Lineær tid (review M2): setningen bygges som `parts` (array) og «har innhold» er et flagg - tidligere ble `masked.trim()` kjørt per tegn, og `endsWith`/`+=` på en voksende streng
 * flatet den ut hver gang (31,7 s ved 300 kB). Hver setning har dessuten et tak (`GLOBALS_MAX_STATEMENT_CHARS`), så en fiendtlig lang setning avvises etter 8 KiB.
 */
function tokenize(text) {
  const statements = [];
  let parts = []; // den maskerte setningen, tegn for tegn (join ved semikolon)
  let hasContent = false; // finnes det noe annet enn mellomrom i setningen så langt?
  let endsWithSpace = true; // siste element i `parts` er et mellomrom (eller setningen er tom)
  let prevChar = " "; // siste tegn i den maskerte teksten (for prefiks-sjekken på sitat)
  let lits = [];
  let stmtLine = 1;
  let stmtStart = 0; // indeks i `text` der setningen begynte
  let line = 1;
  let atLineStart = true;
  let lastWasLiteral = false;
  const n = text.length;
  let i = 0;
  const reject = (reason, at = line, kind = "rejected") => new GlobalsRejectedError(reason, at, kind);
  const tooLong = () => reject("setningen er for lang", stmtLine, "statement_too_long");
  const space = () => {
    if (hasContent && !endsWithSpace) {
      parts.push(" ");
      endsWithSpace = true;
      prevChar = " ";
    }
    lastWasLiteral = false;
  };
  const begin = () => {
    if (hasContent) return;
    hasContent = true;
    stmtLine = line;
    stmtStart = i;
  };

  while (i < n) {
    if (hasContent && i - stmtStart > GLOBALS_MAX_STATEMENT_CHARS) throw tooLong();
    const ch = text[i];
    if (atLineStart && ch === "\\") {
      const eol = text.indexOf("\n", i);
      const lineText = text.slice(i, eol === -1 ? n : eol).replace(/\r$/, "");
      if (!hasContent && RESTRICT_LINE.test(lineText)) {
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
      if (/[A-Za-z0-9_&$]/.test(prevChar) || lastWasLiteral) throw reject("prefiksert eller sammenhengende tekst-literal er ikke tillatt");
      begin();
      const startLine = line;
      let j = i + 1;
      const content = [];
      for (;;) {
        if (j >= n) throw reject("uavsluttet sitat", startLine);
        if (j - stmtStart > GLOBALS_MAX_STATEMENT_CHARS) throw tooLong();
        const c = text[j];
        if (c === "\\") throw reject("backslash i tekst er ikke tillatt", line);
        if (c === ch) {
          if (text[j + 1] === ch) {
            content.push(ch, ch);
            j += 2;
            continue;
          }
          break;
        }
        if (c === "\n") line += 1;
        content.push(c);
        j += 1;
      }
      const index = lits.length;
      lits.push({ kind: ch === "'" ? "str" : "id", text: content.join("") });
      parts.push(ch === "'" ? `${STR_OPEN}${index}${STR_CLOSE}` : `${ID_OPEN}${index}${ID_CLOSE}`);
      prevChar = ch === "'" ? STR_CLOSE : ID_CLOSE;
      endsWithSpace = false;
      lastWasLiteral = true;
      i = j + 1;
      continue;
    }
    if (lastWasLiteral && /[A-Za-z0-9_]/.test(ch)) throw reject("tekst-literal direkte etterfulgt av tegn");
    if (ch === ";") {
      if (hasContent) {
        if (statements.length >= MAX_STATEMENTS) throw reject("for mange setninger", stmtLine, "too_many_statements");
        statements.push({ masked: parts.join("").trim(), lits, line: stmtLine });
      }
      parts = [];
      lits = [];
      hasContent = false;
      endsWithSpace = true;
      prevChar = " ";
      stmtLine = line;
      lastWasLiteral = false;
      i += 1;
      continue;
    }
    if (/[A-Za-z0-9_,=().-]/.test(ch)) {
      begin();
      parts.push(ch);
      endsWithSpace = false;
      prevChar = ch;
      lastWasLiteral = false;
      i += 1;
      continue;
    }
    if (ch === "$") throw reject("dollar-sitert tekst er ikke tillatt");
    if (ch === ":") throw reject("psql-variabel (:navn) er ikke tillatt");
    throw reject("uventet tegn utenfor sitert tekst");
  }
  if (hasContent) throw reject("siste setning mangler avsluttende semikolon", stmtLine);
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
const RE_GRANT = new RegExp(`^GRANT (${ID}) TO (${ID})((?: WITH [A-Za-z ,]+?)?)(?: GRANTED BY (${ID}))?$`, "i");
const RE_COMMENT = new RegExp(`^COMMENT ON ROLE (${ID}) IS (${STR}|NULL)$`, "i");
const RE_STR_TOKEN = new RegExp(`^${STR}$`);
const RE_QUOTED_ID = new RegExp(`^${ID_OPEN}(\\d+)${ID_CLOSE}$`);

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
    } else if (t === "VALID" && tokens[i + 1]?.toUpperCase() === "UNTIL" && RE_STR_TOKEN.test(tokens[i + 2] ?? "")) {
      keep.push(tokens[i], tokens[i + 1], tokens[i + 2]);
      i += 2;
    } else if (t === "PASSWORD" && (RE_STR_TOKEN.test(tokens[i + 1] ?? "") || tokens[i + 1]?.toUpperCase() === "NULL")) {
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

/** Postgres avkorter identifikatorer til 63 byte (NAMEDATALEN 64) ved tegngrensen: samme avkorting her, så et langt navn ikke kan unngå sammenligningen. */
function clipIdentifier(name) {
  let bytes = 0;
  let out = "";
  for (const ch of name) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > 63) break;
    bytes += size;
    out += ch;
  }
  return out;
}
/** Sammenligningsnøkkel for et rollenavn: avkortet og små bokstaver (case-insensitivt er bevisst en over-match: det feiler lukket). */
const roleKey = (name) => clipIdentifier(name).toLowerCase();

/** Navnet bak et ID-token. Bare ord foldes til små bokstaver slik Postgres gjør; siterte beholder innholdet (`""` er ett `"`). */
function roleNameOf(idToken, lits) {
  const quoted = RE_QUOTED_ID.exec(idToken);
  if (quoted !== null) return { name: lits[Number(quoted[1])].text.replace(/""/g, '"'), bare: false };
  return { name: idToken.toLowerCase(), bare: true };
}

/**
 * Returnerer den rene setningen (uten semikolon) eller kaster. `stripped` teller fjernede passord, `skipped` at setningen angikk innloggingsrollen og IKKE sendes videre.
 * @param {{ masked: string, lits: Array<{ text: string }>, line: number }} stmt
 * @param {string} loginKey `roleKey` for rollen verifisereren selv logger inn som
 */
function classify(stmt, loginKey) {
  const { masked, lits } = stmt;
  const refuse = (reason, kind) => new GlobalsRejectedError(reason, stmt.line, kind);
  /** Kaster hvis rollenavnet er et nøkkelord; returnerer true hvis det er innloggingsrollen. */
  const isLoginRole = (idToken) => {
    const r = roleNameOf(idToken, lits);
    if (r.bare && RESERVED_ROLE_WORDS.has(r.name)) throw refuse("rollenavn er et nøkkelord (CURRENT_USER/SESSION_USER/CURRENT_ROLE/ALL/PUBLIC/NONE)", "reserved_role_name");
    return roleKey(r.name) === loginKey;
  };
  const keep = (text, stripped = 0) => ({ text, stripped, skipped: false });
  const skipLogin = (stripped = 0) => ({ text: null, stripped, skipped: true });
  let m;
  if (RE_SET.test(masked)) return keep(masked);
  if ((m = RE_SET_CONFIG.exec(masked)) !== null) {
    const [, a, b, flag] = m;
    if (lits[Number(a.slice(1, -1))].text === "search_path" && lits[Number(b.slice(1, -1))].text === "" && flag.toLowerCase() === "false") return keep(masked);
    throw refuse("set_config med annet enn search_path");
  }
  if ((m = RE_CREATE_ROLE.exec(masked)) !== null) return isLoginRole(m[1]) ? skipLogin() : keep(masked);
  if ((m = RE_ALTER_ROLE_WITH.exec(masked)) !== null) {
    const login = isLoginRole(m[1]);
    const options = roleOptions(m[2]);
    if (options === null) throw refuse("ALTER ROLE med ukjent valg");
    if (login) return skipLogin(options.passwordsStripped);
    if (options.keep.length === 0) return keep(null, options.passwordsStripped);
    return keep(`ALTER ROLE ${m[1]} WITH ${options.keep.join(" ")}`, options.passwordsStripped);
  }
  if ((m = RE_ALTER_ROLE_SET.exec(masked)) !== null) {
    const login = isLoginRole(m[1]);
    if (!ROLE_SET_ALLOWLIST.has(m[3].toLowerCase())) throw refuse("ALTER ROLE … SET med en parameter utenfor allowlisten", "role_setting_not_allowed");
    return login ? skipLogin() : keep(masked);
  }
  if ((m = RE_GRANT.exec(masked)) !== null) {
    isLoginRole(m[1]); // nøkkelord nektes; et medlemskap som berører innloggingsrollen endrer ikke innloggingen og sendes videre (typisk `GRANTED BY postgres`)
    isLoginRole(m[2]);
    if (m[4] !== undefined) isLoginRole(m[4]);
    const withPart = m[3].trim();
    if (withPart !== "") {
      const options = withPart.replace(/^WITH /i, "").split(",").map((s) => s.trim());
      if (options.some((o) => !GRANT_OPTION.test(o))) throw refuse("GRANT med ukjent valg");
    }
    return keep(masked);
  }
  if ((m = RE_COMMENT.exec(masked)) !== null) return isLoginRole(m[1]) ? skipLogin() : keep(masked);
  throw refuse("setning utenfor de tillatte formene");
}

/**
 * @param {string} text dekryptert `globals.sql`
 * @param {{ loginRole?: string }} [options] `loginRole`: rollen verifisereren selv logger inn som på scratch-serveren (standard `postgres`). Setninger som angår DEN rollen slippes aldri gjennom.
 * @returns {{ sql: string, statements: number, passwordsStripped: number, skippedLoginRole: number }} `sql` er SAFE å sende til `psql -f -` (kun validerte, gjenoppbygde setninger)
 * @throws {GlobalsRejectedError}
 */
export function sanitizeGlobals(text, { loginRole = "postgres" } = {}) {
  if (typeof text !== "string") throw new GlobalsRejectedError("ikke tekst");
  // eslint-disable-next-line no-control-regex
  if (typeof loginRole !== "string" || loginRole === "" || Buffer.byteLength(loginRole, "utf8") > 63 || /[\u0000-\u001f\u007f]/.test(loginRole)) {
    throw new GlobalsRejectedError("innloggingsrollen er ugyldig", null, "login_role_invalid");
  }
  const loginKey = roleKey(loginRole);
  if (Buffer.byteLength(text, "utf8") > GLOBALS_MAX_BYTES) throw new GlobalsRejectedError("for stor", null, "too_large");
  // eslint-disable-next-line no-control-regex
  const bad = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.exec(text);
  if (bad !== null) throw new GlobalsRejectedError("kontrolltegn", text.slice(0, bad.index).split("\n").length);
  const statements = tokenize(text); // håndhever også MAX_STATEMENTS (underveis, så en 4 MiB-fil med 500 000 setninger ikke bygges opp først)
  const out = [];
  let passwordsStripped = 0;
  let skippedLoginRole = 0;
  for (const stmt of statements) {
    const result = classify(stmt, loginKey);
    passwordsStripped += result.stripped;
    if (result.skipped) skippedLoginRole += 1;
    if (result.text !== null) out.push(`${unmask(result.text, stmt.lits)};`);
  }
  const sql = out.length === 0 ? "" : `${out.join("\n")}\n`;
  // Siste forsvarslinje, uavhengig av tokenisereren: det som går til psql har aldri en backslash (ingen metakommando kan finnes) eller våre interne plassholdertegn.
  // eslint-disable-next-line no-control-regex
  if (sql.includes("\\") || /[\u0001-\u0004]/.test(sql)) throw new GlobalsRejectedError("intern kontroll: utdata inneholder forbudte tegn");
  return { sql, statements: out.length, passwordsStripped, skippedLoginRole };
}

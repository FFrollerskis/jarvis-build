import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { GLOBALS_MAX_BYTES, GLOBALS_MAX_STATEMENT_CHARS, GlobalsRejectedError, ROLE_SET_ALLOWLIST, sanitizeGlobals } from "../lib/globals-filter.mjs";
import { GLOBALS_DUMP_KEY, REAL_GLOBALS_DUMP } from "./helpers.mjs";

/**
 * WP-C2 review F2: globals.sql er UBETRODD SQL som ender i `psql -f -` på verifisererens vert. Filteret er den eneste tingen som står mellom en ondsinnet
 * (men konsistent mot sitt eget manifest) fil og `\! kommando`. Alt under er derfor skrevet for å ANGRIPE det.
 */
const KEY = GLOBALS_DUMP_KEY;
const REAL_DUMP = REAL_GLOBALS_DUMP;

const rejects = (text, reason) => {
  let error;
  try {
    sanitizeGlobals(text);
  } catch (err) {
    error = err;
  }
  expect(error, `skulle vært nektet: ${JSON.stringify(String(text).slice(0, 80))}`).toBeInstanceOf(GlobalsRejectedError);
  expect(error.code).toBe("globals_rejected");
  if (reason !== undefined) expect(error.message).toContain(reason);
  return error;
};

describe("WP-C2 review F2: globals-filteret slipper gjennom det pg_dumpall faktisk skriver - og gjenoppbygger det", () => {
  it("et ekte uttrekk (PG 16): alle roller, medlemskap, innstillinger og kommentarer kommer gjennom; \\restrict fjernes; passord-hasher fjernes", () => {
    const r = sanitizeGlobals(REAL_DUMP);
    expect(r.passwordsStripped).toBe(1);
    expect(r.statements).toBe(14); // 16 setninger i uttrekket minus CREATE ROLE postgres og ALTER ROLE postgres (innloggingsrollen, runde 2 M1)
    expect(r.skippedLoginRole).toBe(2);
    expect(r.sql).not.toMatch(/ROLE postgres/);
    expect(r.sql).toContain('CREATE ROLE "Weird Role;x";');
    expect(r.sql).toContain('ALTER ROLE "Weird Role;x" WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 VALID UNTIL \'2030-01-01 00:00:00+00\';');
    expect(r.sql).toContain("ALTER ROLE jarvis_app WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS;");
    expect(r.sql).toContain("COMMENT ON ROLE jarvis_app IS 'Appen: it''s fine -- ø æ å';"); // `--` og `:` inne i en streng er data, ikke kommentar/variabel
    expect(r.sql).toContain("ALTER ROLE jarvis_app SET search_path TO 'myschema', 'public';");
    expect(r.sql).toContain("GRANT reader TO jarvis_app WITH ADMIN OPTION, INHERIT TRUE GRANTED BY postgres;");
    expect(r.sql).toContain("SET default_transaction_read_only = off;");
    expect(r.sql).toContain("SET client_encoding = 'UTF8';");
    expect(r.sql).not.toMatch(/\\|restrict|SCRAM|PASSWORD|not-real/i);
  });

  it("hver tillatt form, én for én, med eksakt utdata (nøkkelord i vilkårlig case, ekstra mellomrom/linjeskift normaliseres)", () => {
    const cases = [
      ["SET x = 1;", "SET x = 1;"],
      ["set search_path to a, b;", "set search_path to a, b;"],
      ["SET app.setting = 'v';", "SET app.setting = 'v';"],
      ["SET timezone TO \"Europe/Oslo\";", "SET timezone TO \"Europe/Oslo\";"],
      ["SET x = -3;", "SET x = -3;"],
      ["SELECT pg_catalog.set_config('search_path', '', false);", "SELECT pg_catalog.set_config('search_path', '', false);"],
      ["CREATE ROLE foo;", "CREATE ROLE foo;"],
      ["create   role\n\"Fo o\"\n;", "create role \"Fo o\";"],
      ["ALTER ROLE foo WITH LOGIN CREATEDB;", "ALTER ROLE foo WITH LOGIN CREATEDB;"],
      ["ALTER ROLE foo WITH LOGIN PASSWORD 'p' CONNECTION LIMIT -1;", "ALTER ROLE foo WITH LOGIN CONNECTION LIMIT -1;"],
      ["ALTER ROLE foo WITH PASSWORD NULL NOLOGIN;", "ALTER ROLE foo WITH NOLOGIN;"],
      ["ALTER ROLE foo IN DATABASE bar SET statement_timeout TO '5s';", "ALTER ROLE foo IN DATABASE bar SET statement_timeout TO '5s';"],
      ["ALTER ROLE foo SET search_path = \"$user\", public;", "ALTER ROLE foo SET search_path = \"$user\", public;"],
      ["GRANT a TO b;", "GRANT a TO b;"],
      ["GRANT a TO b WITH ADMIN OPTION GRANTED BY c;", "GRANT a TO b WITH ADMIN OPTION GRANTED BY c;"],
      ["GRANT a TO b WITH INHERIT FALSE, SET TRUE;", "GRANT a TO b WITH INHERIT FALSE, SET TRUE;"],
      ["COMMENT ON ROLE foo IS 'hei';", "COMMENT ON ROLE foo IS 'hei';"],
      ["COMMENT ON ROLE foo IS NULL;", "COMMENT ON ROLE foo IS NULL;"]
    ];
    for (const [input, expected] of cases) expect(sanitizeGlobals(input).sql, input).toBe(`${expected}\n`);
  });

  it("PASSWORD fjernes uansett form, og en ALTER ROLE som bare satte passord forsvinner helt (roller restores uten passord)", () => {
    const r = sanitizeGlobals(`ALTER ROLE a WITH PASSWORD 'x';\nALTER ROLE b WITH LOGIN PASSWORD 'y';\nALTER ROLE c WITH PASSWORD NULL;\n`);
    expect(r.sql).toBe("ALTER ROLE b WITH LOGIN;\n");
    expect(r.passwordsStripped).toBe(3);
    expect(r.statements).toBe(1);
  });

  it("tomt innhold, bare kommentarer og bare \\restrict er gyldig og gir ingenting å kjøre", () => {
    expect(sanitizeGlobals("")).toEqual({ sql: "", statements: 0, passwordsStripped: 0, skippedLoginRole: 0 });
    expect(sanitizeGlobals("-- bare en kommentar\n\n")).toEqual({ sql: "", statements: 0, passwordsStripped: 0, skippedLoginRole: 0 });
    expect(sanitizeGlobals(`\\restrict abc\n\\unrestrict abc\n`).sql).toBe("");
    expect(sanitizeGlobals("-- \\! touch /tmp/x\nCREATE ROLE a;").sql).toBe("CREATE ROLE a;\n"); // en backslash i en kommentar er død tekst og slippes ikke videre
  });

  it("CRLF-linjeskift (fil gått via Windows) og tabulatorer tåles", () => {
    expect(sanitizeGlobals("CREATE ROLE a;\r\nCREATE\tROLE b;\r\n").sql).toBe("CREATE ROLE a;\nCREATE ROLE b;\n");
  });
});

describe("WP-C2 review F2: psql-metakommandoer (kjører på VERIFISERERENS VERT) slipper aldri gjennom", () => {
  it("backslash nektes overalt: linjestart, midt i en setning, etter semikolon, i en streng, i en sitert identifikator, i en kommentar-lignende posisjon", () => {
    for (const text of [
      "\\! touch /tmp/pwned\n", "CREATE ROLE a;\n\\! touch /tmp/pwned\n", "CREATE ROLE a; \\! touch /tmp/pwned\n", "CREATE ROLE a \\! touch /tmp/pwned;\n",
      "  \\! touch /tmp/pwned\n", "\t\\! touch /tmp/pwned\n", "CREATE ROLE a;\r\n\\! touch /tmp/pwned\r\n",
      "\\i /etc/passwd\n", "\\copy x to '/tmp/y'\n", "\\o |touch /tmp/pwned\n", "\\gexec\n", "\\g\n", "\\c postgres\n", "\\set ON_ERROR_STOP 0\n", "\\lo_import /etc/shadow\n",
      "SELECT 1 \\gexec\n", "COMMENT ON ROLE a IS 'x\\y';\n", "COMMENT ON ROLE a IS 'x\\\\y';\n", 'CREATE ROLE "a\\b";\n', "COMMENT ON ROLE a IS 'a\n\\! touch /tmp/pwned\n';\n",
      "/* \\! touch */ CREATE ROLE a;\n"
    ]) {
      rejects(text);
    }
  });

  it("\\restrict er det ENESTE unntaket, og kun som egen linje mellom setninger med en ren nøkkel - ikke som skjul for en kommando", () => {
    sanitizeGlobals(`\\restrict ${KEY}\nCREATE ROLE a;\n\\unrestrict ${KEY}\n`);
    for (const text of [
      "\\restrict\n", "\\restrict \n", "\\restrict a b\n", "\\restrict a;b\n", "\\restrict a! touch\n", `\\restrict ${"a".repeat(129)}\n`, "\\restrict ab cd\n",
      "CREATE ROLE a\n\\restrict abc\n;\n", "\\restrict abc \\! touch /tmp/x\n", "\\restrict abc\\! touch /tmp/x\n", "\\restrict abc\r\\! touch /tmp/x\n", "\\restrict abc;\n",
      "\\restrictx abc\n", "\\Restrict abc\n", " \\restrict abc\n", "\\restrict-abc\n", "\\unrestrict\n"
    ]) {
      rejects(text);
    }
  });

  it("psql-variabler (:navn, :'navn', :\"navn\"), dollar-sitert tekst, blokk-kommentarer og prefiksede strenger nektes", () => {
    for (const text of [
      "SET x = :foo;", "SET x = :'foo';", 'SET x = :"foo";', "CREATE ROLE :foo;", "SET x = $$a$$;", "SET x = $tag$a$tag$;", "SET x = $1;", "CREATE ROLE a$b$c;",
      "/* kommentar */ CREATE ROLE a;", "CREATE ROLE a; /* \n \\! touch /tmp/x \n */", "/*", "SET x = E'a';", "SET x = e'a';", "SET x = U&'a';", "SET x = B'1';", "SET x = X'ff';", "SET x = N'a';",
      "CREATE ROLE U&\"a\";", "SET x = 'a''b'c;", "SET x = 'a'b;"
    ]) {
      rejects(text);
    }
    expect(sanitizeGlobals("SET x = 'a''b';").sql).toBe("SET x = 'a''b';\n"); // doblet anførselstegn er bare tekst
    rejects("SET x = 'a''b';'c'", "siste setning mangler"); // en hengende literal er ikke en komplett setning
  });

  it("kontrolltegn og ikke-ASCII utenfor sitat nektes; forfalskede interne plassholdertegn også; ikke-ASCII INNE i sitat er data og tillatt", () => {
    for (const text of ["CREATE ROLE a;\u0000", "CREATE ROLE a\u0001;", "SET x = \u0002;", "CREATE ROLE \u0003a;", "CREATE ROLE a;\u001b[2J", "CREATE ROLE a;\u007f", "\ufeffCREATE ROLE a;", "CREATE ROLE ø;", "CREATE ROLE a;\u2028CREATE ROLE b;", "CREATE ROLE a;\u0085"]) {
      rejects(text);
    }
    // forsøk på å smugle inn plassholdertegn som ser ut som en maskert streng
    rejects("CREATE ROLE \u00010\u0002;");
    expect(sanitizeGlobals("COMMENT ON ROLE a IS 'blåbærsyltetøy 日本語 😀';").sql).toContain("blåbærsyltetøy 日本語 😀");
  });

  it("uavsluttet sitat, manglende avsluttende semikolon, ukjente tegn utenfor sitat", () => {
    rejects("COMMENT ON ROLE a IS 'uavsluttet;", "uavsluttet sitat");
    rejects('CREATE ROLE "uavsluttet;', "uavsluttet sitat");
    rejects("CREATE ROLE a", "siste setning mangler");
    for (const bad of ["CREATE ROLE a@b;", "CREATE ROLE a%b;", "CREATE ROLE a|b;", "CREATE ROLE a`b;", "CREATE ROLE a{b};", "CREATE ROLE a[b];", "CREATE ROLE a#b;", "CREATE ROLE a!b;", "CREATE ROLE a~b;", "CREATE ROLE a^b;", "CREATE ROLE a<b;", "CREATE ROLE a?b;", "CREATE ROLE a*b;", "CREATE ROLE a+b;", "CREATE ROLE a/b;"]) {
      rejects(bad);
    }
  });
});

describe("WP-C2 review F2: kun kjente rolle-setninger - SQL-nivå-angrep nektes selv uten metakommandoer", () => {
  it("alt utenfor whitelisten nektes (hele filen), uansett om resten er gyldig", () => {
    for (const stmt of [
      "COPY (SELECT 1) TO PROGRAM 'touch /tmp/pwned'", "COPY t FROM '/etc/passwd'", "DO 'BEGIN PERFORM 1; END'", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      "CREATE EXTENSION plpython3u", "ALTER SYSTEM SET archive_command = 'touch /tmp/x'", "DROP ROLE postgres", "DROP DATABASE postgres", "CREATE DATABASE evil", "ALTER DATABASE postgres SET x = 1",
      "CREATE TABLESPACE t LOCATION '/tmp/x'", "CREATE TABLE t (a int)", "INSERT INTO t VALUES (1)", "DELETE FROM pg_authid", "UPDATE pg_authid SET rolsuper = true", "TRUNCATE t",
      "SELECT pg_read_file('/etc/passwd')", "SELECT pg_catalog.set_config('log_statement', 'all', false)", "SELECT pg_catalog.set_config('search_path', 'evil', false)", "SELECT pg_catalog.set_config('search_path', '', true)",
      "SELECT 1", "LOAD '/tmp/evil.so'", "REVOKE ALL ON DATABASE postgres FROM public", "GRANT ALL ON DATABASE postgres TO evil", "GRANT SELECT ON t TO evil", "GRANT a TO b WITH GRANT OPTION",
      "GRANT a TO b WITH ADMIN OPTION; DROP ROLE x", "ALTER ROLE a RENAME TO b", "ALTER ROLE a RESET ALL", "ALTER ROLE a WITH SUPERUSER FOO", "ALTER ROLE a WITH ENCRYPTED PASSWORD 'x'",
      "ALTER ROLE a WITH PASSWORD 'x' 'y'", "ALTER ROLE a WITH PASSWORD", "ALTER ROLE a WITH VALID UNTIL 5", "ALTER ROLE a WITH CONNECTION LIMIT x", "ALTER ROLE a SET x FROM CURRENT", "ALTER ROLE a SET x",
      "CREATE ROLE a SUPERUSER", "CREATE ROLE a WITH LOGIN", "CREATE USER a", "CREATE ROLE a, b", "COMMENT ON TABLE t IS 'x'", "COMMENT ON ROLE a IS 5", "COMMENT ON ROLE a IS 'x' 'y'",
      "SET LOCAL x = 1", "SET x", "SET = 1", "SET x = (SELECT 1)", "SET x = 1 + 1", "RESET ALL", "BEGIN", "COMMIT", "VACUUM", "NOTIFY x", "SELECT pg_catalog.set_config(", "ROLLBACK; DROP ROLE x"
    ]) {
      rejects(`CREATE ROLE ok_role;\n${stmt};\nCREATE ROLE ok_role2;\n`);
    }
  });

  it("GRANT/ALTER ROLE-valg er et lukket sett (ukjente valg gir feil, ikke stille videresending)", () => {
    rejects("ALTER ROLE a WITH SUPERUSER BECOME_ROOT;", "ukjent valg");
    rejects("GRANT a TO b WITH FOO OPTION;", "ukjent valg");
    rejects("GRANT a TO b WITH ADMIN OPTION, EVIL TRUE;", "ukjent valg");
  });

  it("feilmeldingene siterer ALDRI innholdet i filen (kun fast tekst og linjenummer)", () => {
    for (const text of ["\\! EVIL-SENTINEL-1\n", "DROP ROLE EVIL_SENTINEL_2;", "COMMENT ON ROLE a IS 'EVIL-SENTINEL-3\\';", "SET x = $EVIL-SENTINEL-4$;", "SET x = EVIL-SENTINEL-5 y;", "CREATE ROLE EVIL-SENTINEL-6", "ALTER ROLE a WITH EVIL_SENTINEL_7;"]) {
      const err = rejects(text);
      expect(err.message).not.toMatch(/SENTINEL/i);
      expect(JSON.stringify(err.reason)).not.toMatch(/SENTINEL/i);
    }
    expect(rejects("CREATE ROLE a;\nCREATE ROLE b;\nDROP ROLE c;\n").line).toBe(3);
  });

  it("størrelsesgrenser: for stor fil og for mange setninger nektes", () => {
    rejects(`-- ${"x".repeat(GLOBALS_MAX_BYTES)}\n`, "for stor");
    rejects("CREATE ROLE a;\n".repeat(20_001), "for mange setninger");
    expect(sanitizeGlobals("CREATE ROLE a;\n".repeat(20_000)).statements).toBe(20_000);
    rejects(undefined);
    rejects(Buffer.from("CREATE ROLE a;"));
  });
});

/** Erstatter hver sitert streng/identifikator med et tomt par (venstre mot høyre, så et `'` inne i `"…"` ikke forveksles). Kaster hvis sitatene ikke er balansert. */
function stripQuoted(sql) {
  let out = "";
  for (let i = 0; i < sql.length;) {
    const ch = sql[i];
    if (ch !== "'" && ch !== '"') {
      out += ch;
      i += 1;
      continue;
    }
    let j = i + 1;
    for (;;) {
      if (j >= sql.length) throw new Error("ubalansert sitat i utdata");
      if (sql[j] === ch) {
        if (sql[j + 1] === ch) {
          j += 2;
          continue;
        }
        break;
      }
      j += 1;
    }
    out += ch + ch;
    i = j + 1;
  }
  return out;
}

/** Deler utdata i setninger ved `;` UTENFOR sitat (en streng kan inneholde både `;` og linjeskift). Uavhengig av filterets kode. */
function splitOutsideQuotes(sql) {
  const out = [];
  let current = "";
  let quote = null;
  for (const ch of sql) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null; // doblede sitat (`''`) åpner og lukker rett etter hverandre
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === ";") {
      if (current.trim() !== "") out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

/** Rollenavnet (bart ord → små bokstaver, sitert → innholdet) rett etter `prefix` i en setning, ellers null. Uavhengig av filterets kode. */
function roleAfter(stmt, prefix) {
  const m = new RegExp(`^${prefix} ("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*)`, "i").exec(stmt);
  if (m === null) return null;
  return m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1].toLowerCase();
}

/** Uavhengig kontroll av utdata (bruker ikke filterets egen kode): intet utenfor sitat annet enn kjente setninger, aldri backslash, aldri nøkkelord som rollenavn, aldri innloggingsrollen. */
function assertSafeOutput(sql, loginRole = "postgres") {
  expect(sql).not.toContain("\\");
  // eslint-disable-next-line no-control-regex
  expect(sql).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  const bare = stripQuoted(sql);
  expect(bare).not.toMatch(/[$:\\]|\/\*|--|[^\x20-\x7e\n]/);
  for (const stmt of bare.split(";").map((s) => s.trim()).filter(Boolean)) {
    expect(stmt, stmt).toMatch(/^(?:SET|CREATE ROLE|ALTER ROLE|GRANT|COMMENT ON ROLE|SELECT pg_catalog\.set_config)\b/i);
  }
  // Rolle-setninger i den ORIGINALE utdata (med sitater): hverken nøkkelord eller innloggingsrollen som subjekt, og ALTER ROLE … SET kun med allowlistede parametere
  for (const stmt of splitOutsideQuotes(sql)) {
    for (const prefix of ["CREATE ROLE", "ALTER ROLE", "COMMENT ON ROLE"]) {
      const role = roleAfter(stmt, prefix);
      if (role === null) continue;
      expect(["current_user", "session_user", "current_role", "all", "public", "none"], stmt).not.toContain(role);
      expect(role, stmt).not.toBe(loginRole.toLowerCase());
    }
    const set = /^ALTER ROLE ("(?:[^"]|"")*"|\S+)(?: IN DATABASE ("(?:[^"]|"")*"|\S+))? SET (\S+)/i.exec(stmt);
    if (set !== null) expect(ROLE_SET_ALLOWLIST.has(set[3].toLowerCase()), stmt).toBe(true);
  }
}

describe("WP-C2 review F2: mutasjons-fuzzing - uansett hva vi gjør med et ekte uttrekk er utfallet 'nektet' eller 'trygt'", () => {
  const prng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const PAYLOADS = [
    "\\! touch /tmp/pwned", "\\i /etc/passwd", "COPY (SELECT 1) TO PROGRAM 'x'", "DO $$ BEGIN END $$", ":foo", "/* x */", "E'\\x41'", "\\restrict a b", "SELECT 1", "DROP ROLE postgres",
    "'; \\! touch /tmp/pwned; --", "\"; \\! touch /tmp/pwned; --", "$$", "\u0001", "\u0000", "--", "\\", ";", "'", '"',
    // runde 2 (M1): reviewerens eksempler og beslektede former - skal nektes eller hoppes over, aldri nå psql
    "ALTER ROLE postgres WITH NOLOGIN", "ALTER ROLE CURRENT_USER WITH NOSUPERUSER NOLOGIN", "ALTER ROLE ALL SET statement_timeout TO 1", "ALTER ROLE postgres SET session_preload_libraries TO '/tmp/x.so'",
    "ALTER ROLE x IN DATABASE postgres SET dynamic_library_path TO '/tmp'", "GRANT a TO PUBLIC", "CREATE ROLE SESSION_USER", "COMMENT ON ROLE postgres IS 'x'", "ALTER ROLE \"postgres\" WITH SUPERUSER"
  ];
  const ALPHABET = ["\\", ";", "'", '"', "$", ":", "-", "/", "*", "\n", "\r", " ", "E", "e", "U", "&", "(", ")", "=", ",", ".", "x", "\u00e6", "\t"];

  it("5000 tilfeldige mutasjoner av et ekte uttrekk (innsetting, sletting, nytt innhold, duplisering): aldri noe annet enn GlobalsRejectedError, og alt som slipper gjennom er trygt", () => {
    const rnd = prng(20261009);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 5000; i++) {
      let text = REAL_DUMP;
      const edits = 1 + Math.floor(rnd() * 3);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(rnd() * (text.length + 1));
        const kind = Math.floor(rnd() * 5);
        if (kind === 0) text = text.slice(0, at) + pick(ALPHABET) + text.slice(at);
        else if (kind === 1) text = text.slice(0, at) + pick(PAYLOADS) + text.slice(at);
        else if (kind === 2) text = text.slice(0, at) + text.slice(at + 1 + Math.floor(rnd() * 12));
        else if (kind === 3) text = `${text.slice(0, at)}\n${pick(PAYLOADS)};\n${text.slice(at)}`;
        else {
          const lines = text.split("\n");
          const from = Math.floor(rnd() * lines.length);
          lines.splice(from, 0, lines[Math.floor(rnd() * lines.length)] ?? "");
          text = lines.join("\n");
        }
      }
      try {
        const r = sanitizeGlobals(text);
        assertSafeOutput(r.sql);
        accepted++;
      } catch (err) {
        if (!(err instanceof GlobalsRejectedError)) throw err;
        refused++;
      }
    }
    // Fuzzingen er bare meningsfull hvis den treffer begge utfall (mutasjoner i kommentarer slipper gjennom, i setninger nektes)
    expect(accepted).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(100);
  });

  it("2000 rene tilfeldige strenger fra et angrepsalfabet: aldri en uventet feil, og ingen utdata med backslash", () => {
    const rnd = prng(7);
    const WORDS = ["CREATE", "ROLE", "ALTER", "WITH", "SET", "GRANT", "TO", "COMMENT", "ON", "IS", "PASSWORD", "LOGIN", "a", "b", "1"];
    for (let i = 0; i < 2000; i++) {
      let text = "";
      const n = 1 + Math.floor(rnd() * 40);
      for (let k = 0; k < n; k++) text += rnd() < 0.6 ? `${WORDS[Math.floor(rnd() * WORDS.length)]} ` : ALPHABET[Math.floor(rnd() * ALPHABET.length)];
      try {
        assertSafeOutput(sanitizeGlobals(text).sql);
      } catch (err) {
        if (!(err instanceof GlobalsRejectedError)) throw err;
      }
    }
  });
});

/**
 * WP-C2 re-review (runde 2), M1: filteret slapp `ALTER ROLE postgres WITH NOLOGIN` (låste ut verifisereren), `ALTER ROLE ALL/CURRENT_USER …` og
 * `ALTER ROLE … SET session_preload_libraries` (lagres klyngeglobalt, kodelasting ved neste tilkobling) gjennom. Reviewerens eksempler er regresjonstester under.
 */
const RESERVED = ["CURRENT_USER", "SESSION_USER", "CURRENT_ROLE", "ALL", "PUBLIC", "NONE"];
const ROLE_POSITIONS = [
  "CREATE ROLE {K};", "ALTER ROLE {K} WITH NOLOGIN;", "ALTER ROLE {K} SET search_path TO x;", "ALTER ROLE {K} IN DATABASE d SET search_path TO x;",
  "GRANT {K} TO b;", "GRANT a TO {K};", "GRANT a TO b GRANTED BY {K};", "GRANT a TO b WITH ADMIN OPTION GRANTED BY {K};", "COMMENT ON ROLE {K} IS 'x';"
];

describe("WP-C2 review runde 2 M1 (a): nøkkelord i rollenavn-posisjon nektes", () => {
  it("CURRENT_USER/SESSION_USER/CURRENT_ROLE/ALL/PUBLIC/NONE nektes i HVER posisjon og i alle skrivemåter - med stabil `kind`", () => {
    for (const keyword of RESERVED) {
      for (const spelling of [keyword, keyword.toLowerCase(), keyword[0] + keyword.slice(1).toLowerCase()]) {
        for (const template of ROLE_POSITIONS) {
          const err = rejects(template.replace("{K}", spelling), "nøkkelord");
          expect(err.kind, template).toBe("reserved_role_name");
        }
      }
    }
  });

  it("reviewerens eksempler: `ALTER ROLE ALL SET …` og `ALTER ROLE CURRENT_USER WITH NOSUPERUSER NOLOGIN` nektes (hele filen), også innimellom gyldige setninger", () => {
    rejects("ALTER ROLE ALL SET statement_timeout TO '1ms';", "nøkkelord");
    rejects("ALTER ROLE ALL IN DATABASE postgres SET statement_timeout TO '1ms';", "nøkkelord");
    rejects("ALTER ROLE CURRENT_USER WITH NOSUPERUSER NOLOGIN;", "nøkkelord");
    rejects("CREATE ROLE a;\nALTER ROLE current_user WITH NOLOGIN;\nCREATE ROLE b;\n", "nøkkelord");
  });

  it("et SITERT navn er et ordinært rollenavn (pg_dumpall siterer et rolle som heter `all`), og bokstavene i et lengre ord som starter likt er greit", () => {
    expect(sanitizeGlobals('CREATE ROLE "current_user";\nALTER ROLE "ALL" WITH LOGIN;\nGRANT "public" TO "none";\nCREATE ROLE all_roles;\nCREATE ROLE publicity;').statements).toBe(5);
    expect(sanitizeGlobals('ALTER ROLE "all" SET search_path TO x;').sql).toBe('ALTER ROLE "all" SET search_path TO x;\n');
  });
});

describe("WP-C2 review runde 2 M1 (b): setninger om innloggingsrollen sendes aldri til psql", () => {
  const ABOUT = (role) => [
    `CREATE ROLE ${role};`, `ALTER ROLE ${role} WITH SUPERUSER INHERIT LOGIN PASSWORD 'hash';`, `ALTER ROLE ${role} SET search_path TO a;`,
    `ALTER ROLE ${role} IN DATABASE d SET statement_timeout TO 5;`, `COMMENT ON ROLE ${role} IS 'x';`
  ].join("\n");

  it("reviewerens eksempel: `ALTER ROLE postgres WITH NOLOGIN` slippes ikke videre (verifisereren ville vært låst ute), men filen nektes heller ikke", () => {
    expect(sanitizeGlobals("ALTER ROLE postgres WITH NOLOGIN;")).toEqual({ sql: "", statements: 0, passwordsStripped: 0, skippedLoginRole: 1 });
    // en ANNEN innloggingsrolle på scratch betyr at `postgres` ikke er verifisereren, og da er setningen en vanlig rolle-setning
    expect(sanitizeGlobals("ALTER ROLE postgres WITH NOLOGIN;", { loginRole: "scratch_admin" }).sql).toBe("ALTER ROLE postgres WITH NOLOGIN;\n");
    expect(sanitizeGlobals("ALTER ROLE scratch_admin WITH NOLOGIN;", { loginRole: "scratch_admin" })).toMatchObject({ sql: "", skippedLoginRole: 1 });
  });

  it("alle setningsformer og skrivemåter (bart ord i alle case, sitert, avkortet til 63 byte) hoppes over; andre roller kommer gjennom; passord telles som fjernet", () => {
    for (const spelling of ["postgres", "POSTGRES", "Postgres", '"postgres"', '"POSTGRES"']) {
      const r = sanitizeGlobals(`${ABOUT(spelling)}\nCREATE ROLE other;`);
      expect(r.sql, spelling).toBe("CREATE ROLE other;\n");
      expect(r.skippedLoginRole, spelling).toBe(5);
      expect(r.passwordsStripped, spelling).toBe(1); // hashen i en hoppet over setning sendes heller aldri videre
    }
    const long = "a".repeat(63);
    expect(sanitizeGlobals(`ALTER ROLE ${long}zzz WITH NOLOGIN;`, { loginRole: long })).toMatchObject({ sql: "", skippedLoginRole: 1 }); // Postgres avkorter 66 tegn til 63
    // 31 × «é» = 62 byte; 32 × «é» = 64 byte avkortes av Postgres ved tegngrensen til 62 byte (ikke midt i et tegn) = innloggingsrollen
    expect(sanitizeGlobals(`ALTER ROLE "${"é".repeat(32)}" WITH NOLOGIN;`, { loginRole: "é".repeat(31) }).skippedLoginRole).toBe(1);
    expect(sanitizeGlobals(`ALTER ROLE "${"é".repeat(31)}x" WITH NOLOGIN;`, { loginRole: "é".repeat(31) }).skippedLoginRole).toBe(0); // 63 byte: ikke avkortet, et annet navn
  });

  it("setninger om andre roller rører ikke telleren; GRANT som nevner innloggingsrollen (GRANTED BY postgres) sendes videre - det endrer ikke innloggingen", () => {
    const r = sanitizeGlobals("CREATE ROLE reader;\nGRANT reader TO postgres;\nGRANT pg_read_all_data TO reader WITH INHERIT TRUE GRANTED BY postgres;\nALTER ROLE postgres_backup WITH NOLOGIN;");
    expect(r.skippedLoginRole).toBe(0);
    expect(r.statements).toBe(4);
  });

  it("en ugyldig innloggingsrolle feiler lukket (ingenting slippes gjennom på gjetning)", () => {
    for (const loginRole of ["", "a".repeat(64), "bad\nrole", "bad\u0000role", 5, null, ["postgres"], {}]) {
      let error;
      try {
        sanitizeGlobals("CREATE ROLE a;", { loginRole });
      } catch (err) {
        error = err;
      }
      expect(error, JSON.stringify(loginRole)).toBeInstanceOf(GlobalsRejectedError);
      expect(error.kind).toBe("login_role_invalid");
    }
    expect(sanitizeGlobals("CREATE ROLE a;", { loginRole: undefined }).statements).toBe(1); // utelatt = standard `postgres`
  });
});

describe("WP-C2 review runde 2 M1 (c): `ALTER ROLE … SET` kun for ufarlige parametere", () => {
  const DANGEROUS = [
    "session_preload_libraries", "shared_preload_libraries", "local_preload_libraries", "dynamic_library_path", "session_replication_role", "role", "session_authorization",
    "log_line_prefix", "archive_command", "allow_system_table_mods", "row_security", "default_tablespace", "temp_tablespaces", "plperl.on_plperl_init", "plpython3.x", "app.setting",
    "search_path.x", "work_mem.y", "ikke_en_parameter", "SESSION_PRELOAD_LIBRARIES"
  ];

  it("reviewerens eksempel `ALTER ROLE postgres SET session_preload_libraries TO '/tmp/x.so'` nektes - også for ANDRE roller og med IN DATABASE", () => {
    rejects("ALTER ROLE postgres SET session_preload_libraries TO '/tmp/x.so';", "allowlisten");
    for (const guc of DANGEROUS) {
      for (const text of [`ALTER ROLE someone SET ${guc} TO '/tmp/x.so';`, `ALTER ROLE someone IN DATABASE d SET ${guc} = 1;`, `ALTER ROLE postgres SET ${guc} TO x;`]) {
        const err = rejects(text);
        expect(err.kind, text).toBe("role_setting_not_allowed");
      }
    }
  });

  it("hver parameter på allowlisten slippes gjennom (case-insensitivt, med og uten IN DATABASE); selve allowlisten er kort og inneholder ingen farlige parametere", () => {
    expect(ROLE_SET_ALLOWLIST.size).toBeLessThanOrEqual(20);
    for (const dangerous of DANGEROUS) expect(ROLE_SET_ALLOWLIST.has(dangerous.toLowerCase())).toBe(false);
    for (const guc of ROLE_SET_ALLOWLIST) {
      expect(guc).toMatch(/^[a-z_]+$/); // ingen punktum-parametere
      expect(sanitizeGlobals(`ALTER ROLE r SET ${guc} TO '1';`).sql).toBe(`ALTER ROLE r SET ${guc} TO '1';\n`);
      expect(sanitizeGlobals(`ALTER ROLE r IN DATABASE d SET ${guc.toUpperCase()} = 1;`).statements).toBe(1);
    }
    for (const want of ["search_path", "statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout", "application_name", "log_statement", "timezone", "datestyle", "client_encoding", "default_transaction_read_only"]) {
      expect(ROLE_SET_ALLOWLIST.has(want), want).toBe(true);
    }
  });

  it("parameteren sjekkes FØR innloggingsrollen hoppes over: en farlig SET for innloggingsrollen nektes (ikke stille droppes)", () => {
    expect(rejects("ALTER ROLE postgres SET dynamic_library_path TO '/tmp';").kind).toBe("role_setting_not_allowed");
    expect(sanitizeGlobals("ALTER ROLE postgres SET search_path TO x;")).toMatchObject({ sql: "", skippedLoginRole: 1 });
  });
});

/**
 * WP-C2 re-review (runde 2), M2: `SET x = a,a,…` på 300 kB tok 31,7 s (kvadratisk: `trim()` per tegn og `endsWith` på en voksende streng); taket er 4 MiB. Fiendtlige 4 MiB-innganger
 * skal nå avvises eller filtreres på under ett sekund (generøs grense: målt er titalls ms).
 */
describe("WP-C2 review runde 2 M2: fiendtlige innganger på opptil 4 MiB gir ingen DoS", () => {
  const FAST_MS = 1000;
  const MAX = GLOBALS_MAX_BYTES;
  const fill = (unit, bytes = MAX - 64) => unit.repeat(Math.floor(bytes / unit.length));
  const timed = (text) => {
    const t0 = performance.now();
    let outcome;
    try {
      outcome = sanitizeGlobals(text);
    } catch (err) {
      outcome = err;
    }
    return { ms: performance.now() - t0, outcome };
  };

  it("én setning som er nær 4 MiB (verdiliste, streng, sitert identifikator, doblede anførselstegn, mange literaler, ingen semikolon) avvises raskt med `statement_too_long`", () => {
    const hostile = {
      "SET x = a,a,…": `SET x = ${fill("a,")}a;`,
      "SET x = a,a,… uten semikolon": `SET x = ${fill("a,")}a`,
      "enorm streng": `COMMENT ON ROLE a IS '${fill("x")}';`,
      "enorm sitert identifikator": `CREATE ROLE "${fill("x")}";`,
      "doblede anførselstegn": `COMMENT ON ROLE a IS '${fill("''")}';`,
      "mange literaler": `SET x = ${fill("'a' ")}'a';`,
      "ett langt ord": `SET ${fill("a")} = 1;`,
      "ALTER ROLE med mange valg": `ALTER ROLE a WITH ${fill("LOGIN ")}LOGIN;`,
      "GRANT-valg": `GRANT a TO b WITH ${fill("ADMIN OPTION, ")}ADMIN OPTION;`
    };
    for (const [what, text] of Object.entries(hostile)) {
      expect(Buffer.byteLength(text), what).toBeLessThanOrEqual(MAX);
      const { ms, outcome } = timed(text);
      expect(outcome, what).toBeInstanceOf(GlobalsRejectedError);
      expect(outcome.kind, what).toBe("statement_too_long");
      expect(ms, `${what}: ${Math.round(ms)} ms`).toBeLessThan(FAST_MS);
    }
  });

  it("mange små setninger avvises underveis (`too_many_statements`), og lange kommentarer/mellomrom/linjeskift/tomme setninger tas lineært", () => {
    const many = timed(fill("CREATE ROLE a;\n"));
    expect(many.outcome.kind).toBe("too_many_statements");
    expect(many.ms).toBeLessThan(FAST_MS);
    const manySet = timed(fill("SET x=1;"));
    expect(manySet.outcome.kind).toBe("too_many_statements");
    expect(manySet.ms).toBeLessThan(FAST_MS);
    const benign = {
      "4 MiB kommentar": `-- ${fill("x")}\nCREATE ROLE a;\n`,
      "4 MiB mellomrom": `${fill(" ")}CREATE ROLE a;`,
      "4 MiB linjeskift": `${fill("\n")}CREATE ROLE a;`,
      "4 MiB semikolon": fill(";"),
      "4 MiB kommentarlinjer": fill("-- kommentar\n"),
      "4 MiB CRLF": `${fill("\r\n")}CREATE ROLE a;`
    };
    for (const [what, text] of Object.entries(benign)) {
      const { ms, outcome } = timed(text);
      expect(outcome, what).not.toBeInstanceOf(Error);
      expect(ms, `${what}: ${Math.round(ms)} ms`).toBeLessThan(FAST_MS);
    }
  });

  it("taket per setning er nøyaktig `GLOBALS_MAX_STATEMENT_CHARS`: en setning på akkurat taket tas, én tegn over nektes - og en ekte setning er langt under", () => {
    const stmt = (contentLength) => `SET x = '${"a".repeat(contentLength)}';`; // setningen er 10 tegn pluss innholdet (SET x = ' … ')
    expect(GLOBALS_MAX_STATEMENT_CHARS).toBe(8192);
    expect(sanitizeGlobals(stmt(GLOBALS_MAX_STATEMENT_CHARS - 10)).statements).toBe(1);
    const over = rejects(stmt(GLOBALS_MAX_STATEMENT_CHARS - 9));
    expect(over.kind).toBe("statement_too_long");
    expect(over.line).toBe(1);
    expect(sanitizeGlobals(`COMMENT ON ROLE a IS '${"x".repeat(4000)}';`).statements).toBe(1); // en lang, men ekte kommentar
    // taket gjelder PER setning: mange setninger som til sammen er langt over taket er greit
    expect(sanitizeGlobals(`${"CREATE ROLE some_role_name;\n".repeat(2000)}`).statements).toBe(2000);
    // linjenummeret peker på setningens start
    expect(rejects(`CREATE ROLE a;\n\nSET x = ${"a,".repeat(GLOBALS_MAX_STATEMENT_CHARS)}a;`).line).toBe(3);
  });

  it("ytelse er lineær også for en ekte, stor fil (20 000 roller med kommentarer) - ca. 2 MB tas på godt under ett sekund", () => {
    const lines = [];
    for (let i = 0; i < 6000; i++) lines.push(`CREATE ROLE role_${i};`, `ALTER ROLE role_${i} WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS PASSWORD 'SCRAM-SHA-256$4096:salt$key:key';`, `COMMENT ON ROLE role_${i} IS 'rolle nummer ${i}';`);
    const { ms, outcome } = timed(`${lines.join("\n")}\n`);
    expect(outcome.statements).toBe(18_000);
    expect(ms).toBeLessThan(FAST_MS);
  });
});

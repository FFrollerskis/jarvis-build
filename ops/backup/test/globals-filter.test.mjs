import { describe, expect, it } from "vitest";
import { GLOBALS_MAX_BYTES, GlobalsRejectedError, sanitizeGlobals } from "../lib/globals-filter.mjs";
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
    expect(r.statements).toBe(16);
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
    expect(sanitizeGlobals("")).toEqual({ sql: "", statements: 0, passwordsStripped: 0 });
    expect(sanitizeGlobals("-- bare en kommentar\n\n")).toEqual({ sql: "", statements: 0, passwordsStripped: 0 });
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

/** Uavhengig kontroll av utdata (bruker ikke filterets egen kode): intet utenfor sitat annet enn kjente setninger, aldri backslash. */
function assertSafeOutput(sql) {
  expect(sql).not.toContain("\\");
  // eslint-disable-next-line no-control-regex
  expect(sql).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  const bare = stripQuoted(sql);
  expect(bare).not.toMatch(/[$:\\]|\/\*|--|[^\x20-\x7e\n]/);
  for (const stmt of bare.split(";").map((s) => s.trim()).filter(Boolean)) {
    expect(stmt, stmt).toMatch(/^(?:SET|CREATE ROLE|ALTER ROLE|GRANT|COMMENT ON ROLE|SELECT pg_catalog\.set_config)\b/i);
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
    "'; \\! touch /tmp/pwned; --", "\"; \\! touch /tmp/pwned; --", "$$", "\u0001", "\u0000", "--", "\\", ";", "'", '"'
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

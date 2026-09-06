import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-124: regresjonsvakt mot Windows-utrygg encoding i migrasjonskilder.
 *
 * BAKGRUNNEN (reell, ikke hypotetisk): `040_stripe.sql` inneholdt ETT tegn,
 * `Ē` (U+0112), i en SQL-KOMMENTAR. Filen var gyldig UTF-8, så ingen
 * lint/typecheck/CI-jobb på Linux fanget det. På Tobias sin Windows-host
 * initialiseres embedded-Postgres-klyngen med `WIN1252` som database-
 * encoding, og U+0112 har INGEN WIN1252-ekvivalent. Serveren avviste derfor
 * hele setningen:
 *
 *   ERROR: character with byte sequence 0xc4 0x92 in encoding "UTF8"
 *          has no equivalent in encoding "WIN1252"
 *
 * Fordi `runMigrations()` kjører filene i rekkefølge FØR noen test kjører,
 * feilet ENHVER DB-suite på hosten ved migrasjon 040 - også suiter som ikke
 * har noe med Stripe å gjøre (`fase8-device`, `d123-voice-session-authority`,
 * `voice-e2e`). Ett kommentartegn blokkerte hele den lokale DB-testbanen.
 *
 * POLICYEN denne vakten håndhever er bevisst SMAL: hvert tegn i en
 * migrasjons-`.sql` må kunne representeres i WIN1252. Den forbyr IKKE
 * norsk - `ø`, `å`, `æ`, `É`, `§` og resten av det norske repertoaret ligger
 * alle i WIN1252 og passerer uendret. Historiske norske kommentarer skrives
 * derfor ikke om; kun tegn som faktisk ville brutt migrasjonskjeden på
 * Windows avvises.
 *
 * Vakten dekker KUN migrasjons-SQL - filene som sendes ordrett til en
 * Postgres-server som kan være WIN1252-initialisert. Dokumentasjon,
 * TypeScript-kilde og øvrig repo-innhold berøres ikke: de går aldri gjennom
 * en database-encoding-konvertering.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../src/db/migrations", import.meta.url));

/**
 * WIN1252-repertoaret utledes fra `TextDecoder`, ikke fra en håndskrevet
 * liste - en håndskrevet liste ville selv vært en kilde til feil. Bytene
 * 0x81/0x8D/0x8F/0x90/0x9D er UDEFINERTE i WIN1252 (WHATWG-dekoderen mapper
 * dem til C1-kontrolltegn); de holdes derfor utenfor det trygge settet.
 */
const WIN1252_UNDEFINED_BYTES = [0x81, 0x8d, 0x8f, 0x90, 0x9d];

function win1252Repertoire(): Set<string> {
  const decoder = new TextDecoder("windows-1252");
  const safe = new Set<string>();
  for (let byte = 0x00; byte <= 0xff; byte += 1) {
    if (WIN1252_UNDEFINED_BYTES.includes(byte)) {
      continue;
    }
    safe.add(decoder.decode(Uint8Array.of(byte)));
  }
  return safe;
}

const WIN1252_SAFE = win1252Repertoire();

interface EncodingViolation {
  line: number;
  column: number;
  char: string;
  codePoint: string;
}

/**
 * DEN faktiske policy-funksjonen. Rapporterer hvert brudd med linje/kolonne
 * og kodepunkt, slik at et framtidig brudd kan rettes uten å gjette.
 * Iterasjonen går over kodepunkt (`for...of`), ikke UTF-16-kodeenheter, så
 * tegn utenfor BMP rapporteres som ETT tegn og ikke som to surrogater.
 */
function findEncodingViolations(source: string): EncodingViolation[] {
  const violations: EncodingViolation[] = [];
  source.split("\n").forEach((lineText, lineIndex) => {
    let column = 1;
    for (const char of lineText) {
      if (!WIN1252_SAFE.has(char)) {
        violations.push({
          line: lineIndex + 1,
          column,
          char,
          codePoint: `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`
        });
      }
      column += 1;
    }
  });
  return violations;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}_.*\.sql$/.test(file))
    .sort();
}

/** Migratoren leser med `"utf8"`; en fil som ikke ER gyldig UTF-8 er allerede ødelagt. */
function readStrictUtf8(file: string): string {
  const bytes = readFileSync(`${MIGRATIONS_DIR}/${file}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

describe("D-124: vakten selv fanger tegnet som faktisk brakk migrasjonskjeden", () => {
  it("flagger U+0112 (`Ē`) i en SQL-kommentar, med linje, kolonne og kodepunkt", () => {
    const violations = findEncodingViolations("-- kun ĒN tenant faktisk er konfigurert");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 1, codePoint: "U+0112", char: "Ē" });
  });

  it("rapporterer linjenummer for brudd som ikke ligger på første linje", () => {
    const violations = findEncodingViolations(["CREATE TABLE t (id text);", "", "-- Ē"].join("\n"));

    expect(violations.map((v) => v.line)).toEqual([3]);
  });

  it("er ikke en ASCII-vakt: norske tegn ligger i WIN1252 og skal passere uendret", () => {
    const norwegian = "-- mønster, FØR, blåbær, ÉN tenant, §7, «sitat», Ø/ø/Æ/æ/Å/å";

    expect(findEncodingViolations(norwegian)).toEqual([]);
  });

  it("fanger også andre ikke-WIN1252-tegn enn U+0112", () => {
    // Typiske smugtegn: latinske utvidelser, kyrillisk homoglyf, emoji, NBSP-varianter.
    for (const char of ["Ā", "е", "中", "\u{1f600}", " "]) {
      expect(findEncodingViolations(`-- ${char}`)).toHaveLength(1);
    }
  });
});

describe("D-124: alle migrasjonskilder er Windows-trygge", () => {
  const files = migrationFiles();

  it("finner faktisk migrasjonsfilene (vakten kan ikke passere tomt)", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain("040_stripe.sql");
  });

  it.each(files)("%s er gyldig UTF-8 og fullt representerbar i WIN1252", (file) => {
    const violations = findEncodingViolations(readStrictUtf8(file));
    const detail = violations.map((v) => `${file}:${v.line}:${v.column} ${v.codePoint} (${v.char})`).join("\n");

    expect(violations, `Windows-utrygge tegn i migrasjonskilde:\n${detail}`).toEqual([]);
  });

  it("040_stripe.sql inneholder ikke lenger U+0112", () => {
    expect(readStrictUtf8("040_stripe.sql")).not.toContain("Ē");
  });
});

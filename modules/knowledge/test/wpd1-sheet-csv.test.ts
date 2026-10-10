import { describe, expect, it } from "vitest";
import { MAX_CELL_CHARS, capCsvRows, columnLetters, quoteSheetTitle, valuesToCsv } from "../src/sheet-csv.ts";

/**
 * WP-D1 (UA-2): rene hjelpere for regneark -> CSV. Regneark-innhold er UBETRODD data: kontrolltegn/usynlige tegn fjernes, hver celle blir én linje, og harde grenser (rader, kolonner, cellelengde)
 * gjelder. Ingen nettverk, ingen database.
 */
describe("A: A1-notasjon", () => {
  it("columnLetters: 1 -> A, 26 -> Z, 27 -> AA, 52 -> AZ, 53 -> BA, 702 -> ZZ, 703 -> AAA; ugyldig -> A", () => {
    expect([1, 26, 27, 52, 53, 702, 703].map(columnLetters)).toEqual(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
    expect([0, -5, Number.NaN, Number.POSITIVE_INFINITY].map(columnLetters)).toEqual(["A", "A", "A", "A"]);
    expect(columnLetters(50)).toBe("AX");
  });

  it("quoteSheetTitle: enkle sitater rundt, enkle sitater inni doblet (kan ikke bryte ut av områdenotasjonen)", () => {
    expect(quoteSheetTitle("Ark 1")).toBe("'Ark 1'");
    expect(quoteSheetTitle("Per's ark")).toBe("'Per''s ark'");
    expect(quoteSheetTitle("a'!B1:C2")).toBe("'a''!B1:C2'");
  });
});

describe("B: valuesToCsv (Sheets-API-verdier)", () => {
  it("tekst, tall og sannhetsverdier; null/objekter/lister blir tomme celler; kommaer og sitater siteres", () => {
    const out = valuesToCsv([["Navn", "Beløp", "Betalt"], ["Ola, Nordmann", 1200.5, true], ['Han sa "hei"', null, { x: 1 }]], 100, 10);
    expect(out.text).toBe('Navn,Beløp,Betalt\n"Ola, Nordmann",1200.5,true\n"Han sa ""hei"""');
    expect(out.rows).toBe(3);
    expect(out.truncated).toBe(false);
  });

  it("linjeskift og kontrolltegn i en celle blir ett mellomrom/fjernes: en celle kan aldri bli flere rader eller skjule tekst", () => {
    const out = valuesToCsv([["a\nb\r\nc", "x\u0000y\u200ez\u202e"]], 10, 10);
    expect(out.text).toBe("a b c,x yz");
    expect(out.text.split("\n")).toHaveLength(1);
  });

  it("blanke rader hoppes over, avsluttende tomme celler fjernes, radtak setter truncated, og taket gjelder kolonner", () => {
    const out = valuesToCsv([["a", "b", "", ""], [], ["", ""], ["c", "d"], ["e"], ["f"]], 3, 2);
    // Radtaket gjelder INNKOMMENDE rader (3 første), ikke de ikke-blanke: [a,b], [], [,] -> kun «a,b» er igjen.
    expect(out.text).toBe("a,b");
    expect(out.truncated).toBe(true);
    const cols = valuesToCsv([["a", "b", "c", "d"]], 10, 2);
    expect(cols.text).toBe("a,b");
  });

  it("cellelengde-taket kutter lange celler", () => {
    const out = valuesToCsv([["x".repeat(MAX_CELL_CHARS + 500)]], 10, 10);
    expect(out.text.length).toBeLessThanOrEqual(MAX_CELL_CHARS);
    expect(out.text.endsWith("…")).toBe(true);
  });

  it("ikke-array input gir tomt resultat (aldri en kastet feil på uventet API-svar)", () => {
    for (const bad of [undefined, null, "tekst", 5, { values: [] }]) {
      expect(valuesToCsv(bad, 10, 10)).toEqual({ text: "", rows: 0, truncated: false });
    }
    expect(valuesToCsv([null, "ikke en rad", 7, ["ok"]], 10, 10).text).toBe("ok");
  });
});

describe("C: capCsvRows (Drives CSV-eksport)", () => {
  it("kutter ved radtaket og melder truncated; under taket er teksten uendret (uten avsluttende linjeskift)", () => {
    expect(capCsvRows("a,b\nc,d\ne,f\n", 2)).toEqual({ text: "a,b\nc,d", rows: 2, truncated: true });
    expect(capCsvRows("a,b\nc,d\n", 5)).toEqual({ text: "a,b\nc,d", rows: 2, truncated: false });
    expect(capCsvRows("a,b\nc,d", 5)).toEqual({ text: "a,b\nc,d", rows: 2, truncated: false });
  });

  it("sitat-bevisst: et linjeskift inni sitater er ikke en radslutt", () => {
    const csv = 'a,"linje 1\nlinje 2"\nb,c\nd,e\n';
    const out = capCsvRows(csv, 2);
    expect(out.text).toBe('a,"linje 1\nlinje 2"\nb,c');
    expect(out.rows).toBe(2);
    expect(out.truncated).toBe(true);
  });

  it("NUL og usynlige tegn fjernes (en NUL-byte kan ikke lagres), og tom CSV gir 0 rader", () => {
    expect(capCsvRows("a\u0000b,c\u200f", 5).text).toBe("a b,c");
    expect(capCsvRows("", 5)).toEqual({ text: "", rows: 0, truncated: false });
  });

  it("når taket treffer nøyaktig siste rad og det ikke er mer igjen, er resultatet ikke avkortet", () => {
    expect(capCsvRows("a\nb\n", 2)).toEqual({ text: "a\nb", rows: 2, truncated: false });
  });
});

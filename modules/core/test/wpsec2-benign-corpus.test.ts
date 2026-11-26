import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scanForSecrets } from "../src/services/secret-scan.ts";
import { scanStructuredForSecrets } from "../src/services/secret-scan-structured.ts";

/**
 * WP-SEC2 K5 (HARD PORT): falske positiver. Korpuset `fixtures/secret-scan-benign.txt` (norske e-poster, kalender, møtenotater, kontonummer/KID/org.nr./telefon/fakturanr., git-SHA, UUID, docker-digest, filstier, stakksporinger,
 * kode med `password`/`token` som navn uten verdi, lange sammensatte norske ord, URL uten credentials, JSON med `token_count`, prefikser nevnt i prosa ...) skal gå BYTE-IDENTISK gjennom skanneren: 0 funn. Hver ny regel har minst
 * ett nytt godartet tilfelle her (Authorization/Cookie/JSON-nøkler/hex-base64-kontekst/klemt visning). Kortnummerregelen er IKKE utvidet.
 */
const raw = readFileSync(new URL("./fixtures/secret-scan-benign.txt", import.meta.url), "utf8");
const lines = raw.split("\n").filter((l) => l !== "" && !l.startsWith("#"));

describe("K5: godartet korpus gir 0 funn og uendret tekst", () => {
  it("korpuset har minst 80 realistiske linjer", () => {
    expect(lines.length).toBeGreaterThanOrEqual(80);
  });

  it("hver linje, i NFC, NFD og NFKC-trygg form, er byte-identisk uendret", () => {
    for (const line of lines) {
      for (const form of [line, line.normalize("NFC"), line.normalize("NFD")]) {
        const r = scanForSecrets(form);
        expect(r.findings, JSON.stringify(form)).toEqual([]);
        expect(r.text).toBe(form);
      }
    }
  });

  it("hele filen under ett (LF, CRLF, og med blanke linjer mellom) er byte-identisk uendret - søsken-liming finner heller ingenting", () => {
    for (const joined of [lines.join("\n"), lines.join("\r\n"), lines.join("\n\n"), lines.join(" "), raw]) {
      const r = scanForSecrets(joined);
      expect(r.findings).toEqual([]);
      expect(r.text).toBe(joined);
    }
    const structured = scanStructuredForSecrets({ linjer: lines, nested: { a: lines.slice(0, 40), b: lines.slice(40) } });
    expect(structured.findings).toEqual([]);
    expect((structured.value as { linjer: string[] }).linjer).toEqual(lines);
  });

  it("hver linje som verdi under en vanlig nøkkel i JSON-tekst er uendret", () => {
    for (const line of lines.slice(0, 60)) {
      const json = JSON.stringify({ melding: line, id: 7 });
      const r = scanForSecrets(json);
      expect(r.findings, json).toEqual([]);
    }
  });
});

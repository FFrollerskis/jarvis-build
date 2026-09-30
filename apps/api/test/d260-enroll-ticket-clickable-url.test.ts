import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-260 (Tobias direkte i chat, 2026-09-25): gjentatte
 * "enrollment_ticket_invalid"-feil på tvers av FLERE ferske, korrekt
 * genererte billetter (bekreftet via direkte DB-spørring: tenant/person/
 * device/expiry/consumed_at var alle korrekte) - bekreftet rotårsak
 * ("skrev feil"): ren kopier/lim-inn-korrupsjon av selve billett-strengen
 * (44-tegns base64url, `-`/`_` - tegn mobile nettlesere/SSH-klienter ofte
 * tolker som ordgrenser ved dobbelttrykk-for-å-velge). Eksplisitt
 * tilbakemelding: "slutt å be meg gjøre ting og finn ut av det".
 *
 * Fiksen fjerner selve kopisteget: `enroll-ticket-main.ts` skriver nå (når
 * `JARVIS_PUBLIC_VOICE_BASE_URL` er satt) en FULLSTENDIG, KLIKKBAR lenke til
 * `<base>/voice?enroll=<billett>` - `voice.html` sin `tryAutoEnrollFromUrl()`
 * (se `voice-page-wiring.test.ts`) leser billetten derfra og innrullerer
 * automatisk ved sidelasting. Denne suiten beviser KUN den statiske
 * kildeteksten til CLI-scriptet (samme mønster som resten av repoet for
 * skript som ikke trygt kan importeres/kjøres direkte i en test - scriptet
 * er et top-level side-effekt-skript som kobler til databasen og kaller
 * `process.exit()`).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const scriptSource = readSource("../src/enroll-ticket-main.ts");

describe("D-260: enroll-ticket-main.ts skriver en klikkbar innrulleringslenke når JARVIS_PUBLIC_VOICE_BASE_URL er satt", () => {
  it("leser JARVIS_PUBLIC_VOICE_BASE_URL fra miljøet", () => {
    expect(scriptSource).toContain('process.env["JARVIS_PUBLIC_VOICE_BASE_URL"]');
  });

  it("bygger URL-en som <base>/<targetPath>?enroll=<billett> - SAMME query-parameter voice.html/index.html/dashboard.html sin tryAutoEnrollFromUrl() leser (D-347: målsiden er nå valgbar)", () => {
    expect(scriptSource).toMatch(/\/\$\{targetPath\}\?enroll=\$\{created\.ticket\}/);
  });

  it("D-347: targetPath default er UENDRET 'voice' (D-260 sin opprinnelige, testede oppførsel) når --path ikke er gitt", () => {
    expect(scriptSource).toContain('(flag("path") ?? "voice")');
  });

  it("fjerner et evt. etterfølgende skråstrek fra base-URL-en (unngår dobbel // i den ferdige lenken)", () => {
    expect(scriptSource).toMatch(/publicBaseUrl\.replace\(\/\\\/\+\$\/, ""\)/);
  });

  it("degraderer trygt til KUN den bare billett-strengen når variabelen ikke er satt - ingen krasj, ingen tom/ugyldig lenke skrevet", () => {
    const idx = scriptSource.indexOf('process.env["JARVIS_PUBLIC_VOICE_BASE_URL"]');
    expect(idx).toBeGreaterThan(-1);
    const ifIdx = scriptSource.indexOf("if (publicBaseUrl)", idx);
    const elseIdx = scriptSource.indexOf("} else {", ifIdx);
    expect(ifIdx).toBeGreaterThan(idx);
    expect(elseIdx).toBeGreaterThan(ifIdx);
  });
});

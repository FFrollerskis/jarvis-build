import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-347 (Tobias direkte i chat, live NAS: dashboard.html avviste
 * `/session/authorize` med 403 for en helt fersk nettleser - `audit_events`
 * bekreftet 0 rader for `identity.denied`, som utelukker enhver avslagsgrunn
 * `authorizeProvenDevice()` reviderer og etterlater KUN de tre tidlige,
 * ureviderte avslagene i `ChannelSessionAuthority.authorize()`
 * (`device_proof_invalid`/`malformed_evidence`/`unknown_channel`) - statisk
 * lesing av `dashboard.html` sin faste evidence-form (channel "web",
 * memory_space "personal", begge gyldige mot kontraktens enum) utelukker de
 * to siste, og etterlater `device_proof_invalid`: en enhet som ALDRI har
 * kjørt innrulleringsflyten. Dette er FORVENTET, korrekt håndhevelse - ikke
 * en bug i selve autorisasjonen. Den faktiske bruksfeilen var at
 * `apps/web/voice.html` sin D-260-fiks (?enroll=-URL, ingen manuell
 * kopi/lim-inn av en 44-tegns billett) ALDRI ble portert til
 * `dashboard.html`/`index.html` - begge hadde fortsatt KUN det manuelle
 * skjemaet, som er nøyaktig det kopi/lim-inn-feilutsatte mønsteret D-260
 * allerede beviste er upraktisk for Tobias. Denne suiten speiler
 * `voice-page-wiring.test.ts` sin D-260-seksjon for begge sidene.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe.each([
  { name: "dashboard.html", path: "../../web/dashboard.html" },
  { name: "index.html", path: "../../web/index.html" }
])("D-347: $name innrullerer automatisk via ?enroll=-URL, samme mønster som voice.html (D-260)", ({ path }) => {
  const html = readSource(path);

  it("tryAutoEnrollFromUrl() leser billetten fra ?enroll= - IKKE fra skjemafeltet", () => {
    expect(html).toContain("function tryAutoEnrollFromUrl()");
    expect(html).toMatch(/new URLSearchParams\(location\.search\)\.get\("enroll"\)/);
  });

  it("fjerner billetten fra adresselinjen (history.replaceState) FØR selve innrulleringsforsøket", () => {
    const fnIdx = html.indexOf("function tryAutoEnrollFromUrl()");
    expect(fnIdx).toBeGreaterThan(-1);
    const replaceIdx = html.indexOf("history.replaceState(", fnIdx);
    const submitIdx = html.indexOf("submitEnrollment(ticket)", fnIdx);
    expect(replaceIdx).toBeGreaterThan(fnIdx);
    expect(replaceIdx).toBeLessThan(submitIdx);
  });

  it("tryAutoEnrollFromUrl() faktisk kalles ved sidelasting (ikke bare definert, aldri påkalt)", () => {
    expect(html).toMatch(/\n\s*tryAutoEnrollFromUrl\(\);\s*\n/);
  });

  it("det manuelle skjemaet (enrollForm) og auto-innrulleringen deler SAMME submitEnrollment()-logikk - ingen duplisert/avvikende innrulleringssti", () => {
    const formHandlerIdx = html.indexOf('enrollForm.addEventListener("submit"');
    expect(formHandlerIdx).toBeGreaterThan(-1);
    const formBlockEnd = html.indexOf("});", formHandlerIdx);
    const formBlock = html.slice(formHandlerIdx, formBlockEnd);
    expect(formBlock).toContain("submitEnrollment(ticket)");
  });
});

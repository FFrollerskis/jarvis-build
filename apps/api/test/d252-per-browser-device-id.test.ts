import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-252 (live NAS-migreringsfunn, Tobias direkte i chat: "dette kan ikke
 * komme hver gang" - gjentatt "Autorisering feilet: enhet ikke innrullert").
 * Root cause: `device_id: "dev-web"` var en literal DELT av apps/web/
 * index.html, dashboard.html OG voice.html - enhver nettleser som lastet en
 * av disse tre sidene brukte NØYAKTIG samme `device_id`. Siden innrullering/
 * nøkkelrotasjon er PER `device_id` (D-131), rullet innrullering fra ÉN
 * nettleser stille nøkkelen for ALLE andre - telefon, PC, en ny nettleser-
 * profil kunne aldri holde gyldig autorisasjon samtidig.
 *
 * Samme statiske kildetekst-mønster som `voice-page-wiring.test.ts`/
 * `executive-query-wiring.test.ts` (ingen av dem kjører selve inline-
 * scriptet i en nettleser-simulering - disse tre sidenes JS er allerede
 * `node --check`-verifisert syntaktisk gyldig separat, se PR-beskrivelsen).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const pages = {
  "apps/web/index.html": readSource("../../web/index.html"),
  "apps/web/dashboard.html": readSource("../../web/dashboard.html"),
  "apps/web/voice.html": readSource("../../web/voice.html")
};

describe("D-252: device_id er en per-nettleser generert/persistert verdi, ALDRI en delt literal", () => {
  for (const [name, source] of Object.entries(pages)) {
    it(`${name}: device_id kommer fra loadOrCreateDeviceId(), ikke en hardkodet "dev-web"-streng`, () => {
      expect(source).not.toMatch(/device_id:\s*"dev-web"/);
      expect(source).toMatch(/device_id:\s*loadOrCreateDeviceId\(\)/);
    });

    it(`${name}: loadOrCreateDeviceId() leser/skriver den delte localStorage-nøkkelen "jarvis.deviceid"`, () => {
      const fnMatch = source.match(/function loadOrCreateDeviceId\(\)\s*\{([\s\S]*?)\n {2}\}/);
      expect(fnMatch).not.toBeNull();
      const body = fnMatch?.[1] ?? "";
      expect(body).toContain('localStorage.getItem("jarvis.deviceid")');
      expect(body).toContain('localStorage.setItem("jarvis.deviceid"');
      // Genererer en fersk, tilfeldig ID KUN når ingen finnes fra før -
      // aldri en ny ID ved hver sideinnlasting (som ville vært samme bug,
      // bare per-fane i stedet for per-alle-nettlesere).
      expect(body).toContain("randomUUID()");
    });

    // D-342 (host-bevist: "crypto.randomUUID is not a function" ved tilgang
    // over Tailscale/annen ren HTTP - metoden finnes rett og slett ikke i en
    // nettleser uten "secure context", HTTPS/localhost): loadOrCreateDeviceId()
    // kaller nå en lokal randomUUID()-wrapper (ikke crypto.randomUUID() direkte)
    // som faller trygt tilbake til en Math.random()-basert v4-UUID - trygt
    // fordi dette KUN er en lokal enhets-ID (aldri et kryptografisk hemmelig
    // token, se D-131-kommentaren i filene selv).
    it(`${name}: har en randomUUID()-wrapper med trygg fallback når crypto.randomUUID() ikke finnes (usikker kontekst)`, () => {
      const fnMatch = source.match(/function randomUUID\(\)\s*\{([\s\S]*?)\n {2}\}/);
      expect(fnMatch).not.toBeNull();
      const body = fnMatch?.[1] ?? "";
      expect(body).toContain('typeof crypto.randomUUID === "function"');
      expect(body).toContain("crypto.randomUUID()");
      expect(body).toMatch(/Math\.random/);
    });
  }

  it("alle tre sidene bruker NØYAKTIG samme localStorage-nøkkelnavn - dashbord/tale/webchat på samme nettleser deler derfor samme enhetsidentitet (bevisst, se D-252-kommentaren i voice.html)", () => {
    for (const source of Object.values(pages)) {
      expect(source).toContain('localStorage.getItem("jarvis.deviceid")');
    }
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WP-K (D-471, JARVIS-056): api og worker kobler Google-klientens hvelv-først-leser inn ved oppstart (API/worker-parity), og Drive-sjekken måles hvelv-bevisst FØR `firstWaveTools()` (ellers ville
 * dashbord-/Infisical-lagret Google-konfig aldri registrert Drive-verktøyene). main.ts/worker-main.ts er top-level skript som ikke kan importeres - samme tekstvakt-presedens som `drive-runtime-wiring.test.ts`.
 */
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("Google-klientens hvelv-først-kilde er koblet inn i begge prosessene, før Drive-registreringen", () => {
  for (const [name, source, secrets] of [
    ["apps/api/src/main.ts", read("../src/main.ts"), "readSecretProvider"],
    ["apps/api/src/worker-main.ts", read("../src/worker-main.ts"), "toolSecretProvider"]
  ] as const) {
    it(`${name}: kilden kobles med samme Infisical-instans som ToolGateway skriver til, og Drive-sjekken primes før firstWaveTools`, () => {
      const infisical = source.indexOf("const infisicalSecretProvider = new InfisicalSecretProvider();");
      const configure = source.indexOf("configureGoogleOAuthClientSource(createVaultFirstConfigReader({ vault: infisicalSecretProvider }));");
      const prime = source.indexOf(`await primeGoogleDriveCredentialCheck((ref) => ${secrets}.get(ref));`);
      const tools = source.indexOf("firstWaveTools({");
      expect(infisical, "infisicalSecretProvider").toBeGreaterThan(-1);
      expect(configure, "configureGoogleOAuthClientSource").toBeGreaterThan(infisical);
      expect(prime, "primeGoogleDriveCredentialCheck").toBeGreaterThan(configure);
      expect(tools, "firstWaveTools").toBeGreaterThan(prime);
    });

    it(`${name}: ingen egen miljølesing av Google-/Spotify-klientens id/secret (alt går via den delte leseren)`, () => {
      expect(source).not.toMatch(/process\.env\[\s*"JARVIS_GOOGLE_CLIENT_(ID|SECRET)"\s*\]/);
      expect(source).not.toMatch(/process\.env\[\s*"JARVIS_SPOTIFY_CLIENT_(ID|SECRET)"\s*\]/);
    });
  }

  it("Spotify får resolvere mot secret-kjeden i begge prosessene (ikke den logget-deprecated standardfallbacken)", () => {
    expect(read("../src/main.ts")).toContain('clientId: () => readSecretProvider.get("JARVIS_SPOTIFY_CLIENT_ID")');
    expect(read("../src/worker-main.ts")).toContain('clientId: () => toolSecretProvider.get("JARVIS_SPOTIFY_CLIENT_ID")');
  });
});

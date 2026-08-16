import { describe, expect, it } from "vitest";
import {
  MalformedAuthorizationUrlError,
  MalformedClientSecretJsonError,
  MissingClientCredentialsError,
  REQUIRED_REAUTH_SCOPES,
  WrongOAuthClientTypeError,
  buildAuthorizationUrl,
  buildCredentialsConsoleUrl,
  buildRedirectUri,
  classifyAccountConsistency,
  classifyDiscoveryResult,
  decideRefreshToken,
  deriveProjectNumberFromClientId,
  formatAccountMismatchReport,
  formatCandidateSelectionPrompt,
  hasAllRequiredScopes,
  isValidCallbackState,
  maskEmail,
  parseCallbackQuery,
  parseCandidateSelection,
  parseClientSecretJson,
  selectNewCandidateJsonFiles,
  tokenExchangeFailureReason,
  validateAuthorizationUrl,
  validateClientCredentials
} from "../scripts/lib/google-drive-reauth-lib.ts";

/**
 * GOOGLE DRIVE FULL-ACCESS REAUTH (2026-08-16) §13: rene, deterministiske
 * tester for URL-bygging/parsing/beslutningslogikken `google-drive-
 * reauth.ts` bruker. INGEN nettverk/nettleser/ekte Google-konto nødvendig.
 */
describe("§A: manglende klient-credentials -> tydelig feil FØR noe startes", () => {
  it("kaster MissingClientCredentialsError når client_id mangler", () => {
    expect(() => validateClientCredentials(undefined, "secret")).toThrow(MissingClientCredentialsError);
  });
  it("kaster MissingClientCredentialsError når client_secret mangler", () => {
    expect(() => validateClientCredentials("client-id", undefined)).toThrow(MissingClientCredentialsError);
  });
  it("kaster IKKE når begge er satt", () => {
    expect(() => validateClientCredentials("client-id", "secret")).not.toThrow();
  });
});

describe("§B: autorisasjons-URL ber om FULL Drive-scope (+ eksisterende Calendar + minimal identity-scope)", () => {
  const url = buildAuthorizationUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:8942/oauth2callback", scopes: REQUIRED_REAUTH_SCOPES, state: "state-123" });
  const parsed = new URL(url);

  it("scope-parameteren inneholder den bekreftede FULLE Drive-scopen (ikke drive.file/drive.readonly)", () => {
    const scope = parsed.searchParams.get("scope") ?? "";
    expect(scope.split(" ")).toContain("https://www.googleapis.com/auth/drive");
    expect(scope).not.toContain("drive.file");
    expect(scope).not.toContain("drive.readonly");
  });
  it("scope-parameteren inneholder EKSISTERENDE Calendar-scope (unngår regresjon på delt JARVIS_GOOGLE_TOKEN)", () => {
    expect((parsed.searchParams.get("scope") ?? "").split(" ")).toContain("https://www.googleapis.com/auth/calendar");
  });
  it("ber om offline access + tvunget consent (påkrevd for pålitelig refresh_token, bekreftet mot google-auth-library sin dokumentasjon)", () => {
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect((parsed.searchParams.get("prompt") ?? "").split(" ")).toContain("consent");
  });
  it("§C (host-fix): prompt inkluderer OGSÅ select_account - Google skal ALDRI stille bruke en allerede innlogget konto uten å spørre (host-funn: henrik@ffskis.com)", () => {
    expect((parsed.searchParams.get("prompt") ?? "").split(" ")).toContain("select_account");
  });
  it("bevarer tidligere godkjente scopes (inkrementell autorisering - ingen regresjon for andre integrasjoner)", () => {
    expect(parsed.searchParams.get("include_granted_scopes")).toBe("true");
  });
  it("client_secret opptrer ALDRI i autorisasjons-URL-en (kun client_id, som ikke er hemmelig)", () => {
    expect(url).not.toContain("secret");
  });
  it("response_type=code er ALLTID med (host-funn: 'Required parameter is missing: response_type')", () => {
    expect(parsed.searchParams.get("response_type")).toBe("code");
  });
  it("redirect_uri bevares NØYAKTIG som oppgitt (round-trip, ingen mutasjon)", () => {
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8942/oauth2callback");
  });
  it("state bevares NØYAKTIG som oppgitt", () => {
    expect(parsed.searchParams.get("state")).toBe("state-123");
  });
});

describe("§3 (host-fix): login_hint er KUN et hint - satt når konfigurert, men hindrer ALDRI kontovalg", () => {
  it("login_hint settes når loginHint oppgis", () => {
    const url = buildAuthorizationUrl({ clientId: "cid", redirectUri: buildRedirectUri(8942), scopes: REQUIRED_REAUTH_SCOPES, state: "s", loginHint: "tobias@ffskis.com" });
    expect(new URL(url).searchParams.get("login_hint")).toBe("tobias@ffskis.com");
  });
  it("login_hint utelates HELT når ingen konto er konfigurert (ingen 'undefined'-streng i URL-en)", () => {
    const url = buildAuthorizationUrl({ clientId: "cid", redirectUri: buildRedirectUri(8942), scopes: REQUIRED_REAUTH_SCOPES, state: "s" });
    expect(new URL(url).searchParams.has("login_hint")).toBe(false);
  });
  it("select_account er ALLTID med selv når login_hint er satt - hindrer aldri kontobytte", () => {
    const url = buildAuthorizationUrl({ clientId: "cid", redirectUri: buildRedirectUri(8942), scopes: REQUIRED_REAUTH_SCOPES, state: "s", loginHint: "tobias@ffskis.com" });
    expect((new URL(url).searchParams.get("prompt") ?? "").split(" ")).toContain("select_account");
  });
});

describe("§4/§B (host-fix): pre-flight-validering av den genererte autorisasjons-URL-en FØR nettleseren åpnes", () => {
  const validUrl = buildAuthorizationUrl({ clientId: "cid", redirectUri: buildRedirectUri(8942), scopes: REQUIRED_REAUTH_SCOPES, state: "state-123" });

  it("en KORREKT URL (fra buildAuthorizationUrl selv) validerer uten å kaste", () => {
    expect(() => validateAuthorizationUrl(validUrl, REQUIRED_REAUTH_SCOPES)).not.toThrow();
  });
  it("B: en URL UTEN response_type kastes EKSPLISITT (nøyaktig host-feilen: 'Required parameter is missing: response_type')", () => {
    const broken = new URL(validUrl);
    broken.searchParams.delete("response_type");
    expect(() => validateAuthorizationUrl(broken.toString(), REQUIRED_REAUTH_SCOPES)).toThrow(MalformedAuthorizationUrlError);
    expect(() => validateAuthorizationUrl(broken.toString(), REQUIRED_REAUTH_SCOPES)).toThrow(/response_type=code/);
  });
  it("en URL med feil response_type (ikke 'code') kastes", () => {
    const broken = new URL(validUrl);
    broken.searchParams.set("response_type", "token");
    expect(() => validateAuthorizationUrl(broken.toString(), REQUIRED_REAUTH_SCOPES)).toThrow(MalformedAuthorizationUrlError);
  });
  it("en URL uten client_id kastes", () => {
    const broken = new URL(validUrl);
    broken.searchParams.delete("client_id");
    expect(() => validateAuthorizationUrl(broken.toString(), REQUIRED_REAUTH_SCOPES)).toThrow(MalformedAuthorizationUrlError);
  });
  it("I: en URL uten redirect_uri kastes", () => {
    const broken = new URL(validUrl);
    broken.searchParams.delete("redirect_uri");
    expect(() => validateAuthorizationUrl(broken.toString(), REQUIRED_REAUTH_SCOPES)).toThrow(MalformedAuthorizationUrlError);
  });
  it("J: en URL uten state kastes", () => {
    const broken = new URL(validUrl);
    broken.searchParams.delete("state");
    expect(() => validateAuthorizationUrl(broken.toString(), REQUIRED_REAUTH_SCOPES)).toThrow(MalformedAuthorizationUrlError);
  });
  it("H: en URL som mangler full Drive-scope kastes, med de manglende scopene nevnt i feilmeldingen", () => {
    const broken = new URL(validUrl);
    broken.searchParams.set("scope", "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email");
    expect(() => validateAuthorizationUrl(broken.toString(), REQUIRED_REAUTH_SCOPES)).toThrow(/drive/);
  });
});

describe("§C: den avviklede OOB-flyten ('urn:ietf:wg:oauth:2.0:oob') brukes ALDRI", () => {
  it("buildAuthorizationUrl produserer aldri en OOB-redirect_uri", () => {
    const url = buildAuthorizationUrl({ clientId: "cid", redirectUri: buildRedirectUri(8942), scopes: REQUIRED_REAUTH_SCOPES, state: "s" });
    expect(url).not.toContain("urn:ietf:wg:oauth:2.0:oob");
  });
  it("buildRedirectUri produserer en loopback-IP-URI (RFC 8252), aldri OOB", () => {
    expect(buildRedirectUri(8942)).toBe("http://127.0.0.1:8942/oauth2callback");
    expect(buildRedirectUri(8942)).not.toContain("oob");
  });
});

describe("§D/§E: lokal callback state/CSRF-vern", () => {
  it("D: korrekt state (eksakt match) godtas", () => {
    expect(isValidCallbackState("expected-state", "expected-state")).toBe(true);
  });
  it("E: feil state avvises EKSPLISITT", () => {
    expect(isValidCallbackState("wrong-state", "expected-state")).toBe(false);
  });
  it("E: manglende state (undefined) avvises", () => {
    expect(isValidCallbackState(undefined, "expected-state")).toBe(false);
  });
});

describe("§F: OAuth-feil-callback håndteres (f.eks. access_denied)", () => {
  it("parseCallbackQuery henter ut error-parameteren", () => {
    const result = parseCallbackQuery("http://127.0.0.1:8942/oauth2callback?error=access_denied&state=abc");
    expect(result.error).toBe("access_denied");
    expect(result.code).toBeUndefined();
    expect(result.state).toBe("abc");
  });
  it("parseCallbackQuery henter ut code+state ved suksess (ingen error-felt)", () => {
    const result = parseCallbackQuery("http://127.0.0.1:8942/oauth2callback?code=auth-code-xyz&state=abc");
    expect(result.code).toBe("auth-code-xyz");
    expect(result.state).toBe("abc");
    expect(result.error).toBeUndefined();
  });
});

describe("§G: token-exchange-feil klassifiseres typet, aldri kropp/secrets", () => {
  it("returnerer en typet, statuskode-inkluderende, ikke-hemmelig årsak", () => {
    expect(tokenExchangeFailureReason(400)).toBe("google_reauth_token_exchange_failed_400");
    expect(tokenExchangeFailureReason(401)).toBe("google_reauth_token_exchange_failed_401");
  });
});

describe("§H: utilstrekkelig scope nektes - EKSAKT token-match, aldri substring", () => {
  it("full scope-streng med alle tre påkrevde scopes -> true", () => {
    expect(hasAllRequiredScopes(REQUIRED_REAUTH_SCOPES.join(" "), REQUIRED_REAUTH_SCOPES)).toBe(true);
  });
  it("manglende drive-scope -> false", () => {
    expect(hasAllRequiredScopes("https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email", REQUIRED_REAUTH_SCOPES)).toBe(false);
  });
  it("en NÆRLIGGENDE men SMALERE drive-scope (drive.metadata.readonly) matcher IKKE et krav om full 'drive' - ingen falsk positiv via substring", () => {
    const granted = "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email";
    expect(hasAllRequiredScopes(granted, REQUIRED_REAUTH_SCOPES)).toBe(false);
  });
  it("tom scope-streng -> false", () => {
    expect(hasAllRequiredScopes("", REQUIRED_REAUTH_SCOPES)).toBe(false);
  });
});

describe("§I: refresh-token-beslutning (§6 i ordren)", () => {
  it("token-responsen HAR en refresh_token -> bruk den nye (normalfall, garantert av prompt=consent)", () => {
    const decision = decideRefreshToken({ refreshToken: "new-refresh-token" }, "old-refresh-token", false);
    expect(decision).toEqual({ action: "use_new", refreshToken: "new-refresh-token" });
  });
  it("token-responsen MANGLER refresh_token, men eksisterende er LIVE-bevist full scope -> behold eksisterende", () => {
    const decision = decideRefreshToken({ refreshToken: undefined }, "old-refresh-token", true);
    expect(decision).toEqual({ action: "retain_existing", refreshToken: "old-refresh-token" });
  });
  it("token-responsen MANGLER refresh_token, eksisterende IKKE bevist full scope -> feil tydelig (aldri stille aksept av en smalere/tom credential)", () => {
    const decision = decideRefreshToken({ refreshToken: undefined }, "old-refresh-token", false);
    expect(decision.action).toBe("fail");
  });
  it("token-responsen MANGLER refresh_token OG ingen eksisterende finnes -> feil tydelig", () => {
    const decision = decideRefreshToken({ refreshToken: undefined }, undefined, false);
    expect(decision.action).toBe("fail");
  });
});

describe("§5 i ordren: maskert e-post - aldri hele adressen", () => {
  it("maskerer alt unntatt første tegn + domene", () => {
    expect(maskEmail("tobias@ffskis.com")).toBe("t***@ffskis.com");
  });
  it("håndterer en ugyldig/tom e-post trygt (ingen krasj, ingen lekkasje)", () => {
    expect(maskEmail("ikke-en-epost")).toBe("***");
    expect(maskEmail("")).toBe("***");
  });
});

describe("§8 i ordren: konto-konsistens-klassifisering", () => {
  it("ingen konfigurert konto -> ingenting å sammenligne mot, ingen konflikt mulig", () => {
    expect(classifyAccountConsistency("tobias@ffskis.com", undefined)).toBe("no_configured_account");
  });
  it("identitet kunne ikke bestemmes -> undetermined (ALDRI stille behandlet som match)", () => {
    expect(classifyAccountConsistency(undefined, "tobias@ffskis.com")).toBe("undetermined");
  });
  it("samme konto (case-insensitivt) -> match", () => {
    expect(classifyAccountConsistency("Tobias@FFSkis.com", "tobias@ffskis.com")).toBe("match");
  });
  it("ulik konto -> mismatch (krever eksplisitt bekreftelse i orchestratoren)", () => {
    expect(classifyAccountConsistency("annenperson@example.com", "tobias@ffskis.com")).toBe("mismatch");
  });
});

describe("§D (host-fix): formatAccountMismatchReport - trygg, grep-bar rapportform, ALDRI hele e-postadresser", () => {
  it("inneholder BEGGE eksplisitte etiketter (expected_account/authorized_account) med maskerte verdier", () => {
    expect(formatAccountMismatchReport("t***@ffskis.com", "h***@ffskis.com")).toBe(
      "expected_account=t***@ffskis.com authorized_account=h***@ffskis.com"
    );
  });
});

/**
 * HOST FIX #2 (2026-08-16): Tobias sin faktiske klient ga
 * "redirect_uri_mismatch" - sterk evidens for at den er en "Web
 * application"-type, ikke "Desktop app". Disse testene dekker den
 * permanente løsningen: import av en Desktop-klients nedlastede
 * client-secret-JSON, og avvisning av feil klienttype.
 */
describe("parseClientSecretJson - Desktop app ('installed') godtas, Web application ('web') avvises EKSPLISITT", () => {
  it("en gyldig 'installed' (Desktop app) JSON gir client_id/client_secret", () => {
    const json = JSON.stringify({ installed: { client_id: "123456789012-abc.apps.googleusercontent.com", client_secret: "desktop-secret", redirect_uris: ["http://localhost"] } });
    expect(parseClientSecretJson(json)).toEqual({ clientId: "123456789012-abc.apps.googleusercontent.com", clientSecret: "desktop-secret" });
  });
  it("web client redirect mismatch classification: en 'web' (Web application)-JSON kastes EKSPLISITT - samme brittleness som klienten Tobias allerede har", () => {
    const json = JSON.stringify({ web: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "web-secret", redirect_uris: ["https://example.com/callback"] } });
    expect(() => parseClientSecretJson(json)).toThrow(WrongOAuthClientTypeError);
  });
  it("ugyldig JSON kastes tydelig, ikke en kryptisk parse-feil", () => {
    expect(() => parseClientSecretJson("dette er ikke json")).toThrow(MalformedClientSecretJsonError);
  });
  it("verken 'installed' eller 'web'-nøkkel funnet -> kastes tydelig", () => {
    expect(() => parseClientSecretJson(JSON.stringify({ some: "other-shape" }))).toThrow(MalformedClientSecretJsonError);
  });
  it("'installed' finnes men mangler client_id/client_secret -> kastes tydelig", () => {
    expect(() => parseClientSecretJson(JSON.stringify({ installed: { client_id: "" } }))).toThrow(MalformedClientSecretJsonError);
  });
  it("secrets logges/eksponeres ALDRI av selve feilmeldingen (feilmeldingen nevner ALDRI en client_secret-verdi)", () => {
    const json = JSON.stringify({ web: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "super-hemmelig-verdi-123" } });
    try {
      parseClientSecretJson(json);
      throw new Error("skulle ha kastet");
    } catch (err) {
      expect((err as Error).message).not.toContain("super-hemmelig-verdi-123");
    }
  });
});

describe("deriveProjectNumberFromClientId / buildCredentialsConsoleUrl - direkte lenke til RIKTIG Cloud Console-side", () => {
  it("henter prosjektnummeret fra den stabile client_id-formen (<nummer>-<random>.apps.googleusercontent.com)", () => {
    expect(deriveProjectNumberFromClientId("123456789012-abcdef.apps.googleusercontent.com")).toBe("123456789012");
  });
  it("en client_id som IKKE matcher det kjente mønsteret gir undefined - ALDRI en gjettet verdi", () => {
    expect(deriveProjectNumberFromClientId("ikke-en-gyldig-client-id")).toBeUndefined();
  });
  it("URL-en inkluderer prosjektnummeret som query-parameter når det er kjent", () => {
    expect(buildCredentialsConsoleUrl("123456789012")).toBe("https://console.cloud.google.com/apis/credentials?project=123456789012");
  });
  it("en generisk (uten prosjekt) URL brukes trygt når prosjektnummeret er ukjent - aldri en feilformet lenke", () => {
    expect(buildCredentialsConsoleUrl(undefined)).toBe("https://console.cloud.google.com/apis/credentials");
  });
});

/**
 * GOOGLE OAUTH HOST FIX #3 "ZERO MANUAL ENV EDITING" (2026-08-16): Tobias
 * skal KUN gjøre ÉN uunngåelig manuell handling (opprette Desktop-klienten +
 * trykke "Download JSON" i Cloud Console) - ALDRI redigere .env, kopiere
 * client_id/secret, eller lime inn en filsti. Disse testene dekker den rene
 * beslutnings-/filtreringslogikken bak "oppdag den nedlastede JSON-en
 * automatisk fra Nedlastinger-mappa".
 */
describe("selectNewCandidateJsonFiles (§B/§C i ordren)", () => {
  it("B: filtrerer til KUN .json-filer (andre filtyper i Nedlastinger ignoreres)", () => {
    const files = [
      { name: "client_secret_123.json", path: "/dl/client_secret_123.json", mtimeMs: 2000 },
      { name: "notat.txt", path: "/dl/notat.txt", mtimeMs: 2000 },
      { name: "bilde.png", path: "/dl/bilde.png", mtimeMs: 2000 }
    ];
    expect(selectNewCandidateJsonFiles(files, 0).map((f) => f.name)).toEqual(["client_secret_123.json"]);
  });
  it("C: KUN filer med mtime FRA OG MED kjøringens starttidspunkt regnes som nylig lastet ned - en gammel, urelatert JSON fra FØR kjøringen plukkes ALDRI opp", () => {
    const runStartMs = 5000;
    const files = [
      { name: "gammel-ukjent-fil.json", path: "/dl/gammel-ukjent-fil.json", mtimeMs: 1000 },
      { name: "client_secret_ny.json", path: "/dl/client_secret_ny.json", mtimeMs: 5500 }
    ];
    expect(selectNewCandidateJsonFiles(files, runStartMs).map((f) => f.name)).toEqual(["client_secret_ny.json"]);
  });
  it("sorterer nyest FØRST", () => {
    const files = [
      { name: "eldre.json", path: "/dl/eldre.json", mtimeMs: 100 },
      { name: "nyere.json", path: "/dl/nyere.json", mtimeMs: 200 }
    ];
    expect(selectNewCandidateJsonFiles(files, 0).map((f) => f.name)).toEqual(["nyere.json", "eldre.json"]);
  });
  it("filnavn-matching er case-insensitiv (.JSON godtas også)", () => {
    const files = [{ name: "CLIENT_SECRET.JSON", path: "/dl/CLIENT_SECRET.JSON", mtimeMs: 100 }];
    expect(selectNewCandidateJsonFiles(files, 0)).toHaveLength(1);
  });
});

describe("classifyDiscoveryResult (§A/§G i ordren) - ALDRI gjett stille ved flere kandidater", () => {
  it("A: ingen gyldige kandidater -> 'none' (fortsett å vente/poll)", () => {
    expect(classifyDiscoveryResult([])).toEqual({ kind: "none" });
  });
  it("nøyaktig ÉN gyldig kandidat -> 'single', brukes automatisk", () => {
    const candidate = { name: "jarvis-desktop.json", path: "/dl/jarvis-desktop.json", mtimeMs: 100 };
    expect(classifyDiscoveryResult([candidate])).toEqual({ kind: "single", candidate });
  });
  it("G: FLERE gyldige kandidater -> 'multiple' - krever eksplisitt valg, ALDRI en stille gjetning på hvilken som er riktig", () => {
    const a = { name: "a.json", path: "/dl/a.json", mtimeMs: 100 };
    const b = { name: "b.json", path: "/dl/b.json", mtimeMs: 200 };
    expect(classifyDiscoveryResult([a, b])).toEqual({ kind: "multiple", candidates: [a, b] });
  });
});

describe("formatCandidateSelectionPrompt / parseCandidateSelection - trygg, KUN-filnavn nummerert liste", () => {
  it("nummererer filnavnene 1-indeksert, ett per linje", () => {
    expect(formatCandidateSelectionPrompt(["a.json", "b.json"])).toBe("  1) a.json\n  2) b.json");
  });
  it("H: prompten inneholder ALDRI client_id/client_secret - kun filnavn (testes strukturelt her ved at funksjonen kun tar imot en string[] av navn, ingen credential-verdier kan lekke inn)", () => {
    const prompt = formatCandidateSelectionPrompt(["client_secret_abc123.json"]);
    expect(prompt).not.toMatch(/GOCSPX|client_secret":/);
  });
  it("gyldig tallvalg innenfor rekkevidde returnerer en 0-indeksert posisjon", () => {
    expect(parseCandidateSelection("1", 2)).toBe(0);
    expect(parseCandidateSelection("2", 2)).toBe(1);
  });
  it("ugyldig/utenfor-rekkevidde/ikke-numerisk input returnerer undefined (orchestratoren spør på nytt, kaster ALDRI en kryptisk indeksfeil)", () => {
    expect(parseCandidateSelection("0", 2)).toBeUndefined();
    expect(parseCandidateSelection("3", 2)).toBeUndefined();
    expect(parseCandidateSelection("abc", 2)).toBeUndefined();
    expect(parseCandidateSelection("1.5", 2)).toBeUndefined();
    expect(parseCandidateSelection("", 2)).toBeUndefined();
  });
});

describe("D/E/F (host-fix #3): en oppdaget kandidatfil valideres FORTSATT med den EKSISTERENDE parseClientSecretJson() - ingen ny/parallell valideringslogikk", () => {
  it("D: en gyldig installed/Desktop-JSON blant kandidatene aksepteres", () => {
    const json = JSON.stringify({ installed: { client_id: "1-abc.apps.googleusercontent.com", client_secret: "s" } });
    expect(parseClientSecretJson(json)).toEqual({ clientId: "1-abc.apps.googleusercontent.com", clientSecret: "s" });
  });
  it("E: en web-JSON blant kandidatene avvises EKSPLISITT (samme WrongOAuthClientTypeError som før - orchestratoren ekskluderer denne stille fra kandidatlisten i stedet for å krasje hele polling-løkka)", () => {
    const json = JSON.stringify({ web: { client_id: "1-abc.apps.googleusercontent.com", client_secret: "s" } });
    expect(() => parseClientSecretJson(json)).toThrow(WrongOAuthClientTypeError);
  });
  it("F: en søppel/ugyldig JSON blant kandidatene avvises EKSPLISITT (samme MalformedClientSecretJsonError som før)", () => {
    expect(() => parseClientSecretJson("{ ikke gyldig")).toThrow(MalformedClientSecretJsonError);
  });
});

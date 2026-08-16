import { describe, expect, it } from "vitest";
import {
  MissingClientCredentialsError,
  REQUIRED_REAUTH_SCOPES,
  buildAuthorizationUrl,
  buildRedirectUri,
  classifyAccountConsistency,
  decideRefreshToken,
  hasAllRequiredScopes,
  isValidCallbackState,
  maskEmail,
  parseCallbackQuery,
  tokenExchangeFailureReason,
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
    expect(parsed.searchParams.get("prompt")).toBe("consent");
  });
  it("bevarer tidligere godkjente scopes (inkrementell autorisering - ingen regresjon for andre integrasjoner)", () => {
    expect(parsed.searchParams.get("include_granted_scopes")).toBe("true");
  });
  it("client_secret opptrer ALDRI i autorisasjons-URL-en (kun client_id, som ikke er hemmelig)", () => {
    expect(url).not.toContain("secret");
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GmailTransport,
  classifyGoogleTokenEndpointError,
  formatGoogleAuthErrorReport,
  isRecoverableGoogleAuthErrorClass,
  parseGoogleAuthFailureReason
} from "@jarvis/tool-gateway";

/**
 * UA-2 P1B-A HOST FIX #1 (2026-08-16, host-funn run_id `3af67dab`): den
 * TIDLIGERE `googleAccessToken()` samlet ALLE token-endepunkt-feil til den
 * ugjennomsiktige `google_auth_failed_401` - denne suiten beviser den nye,
 * klassifiserte erstatningen. `classifyGoogleTokenEndpointError()` parser
 * Google sin RFC 6749 §5.2 FLATE feilform (`{error, error_description}`) -
 * IKKE den nøstede API-feilformen `classifyDriveProbeError()` dekker.
 *
 * UA-2 P1B-A HOST FIX #2 (2026-08-16, host-funn run_id `ab43fb1f`): et ekte
 * `unauthorized_client` mot den ALLEREDE host-bevist Desktop-klienten viste at
 * den forrige, ALLTID-fail-closed `GOOGLE_INVALID_CLIENT`-klassifiseringen var
 * feil for AKKURAT dette tilfellet - `classifyGoogleTokenEndpointError()` tar
 * nå en eksplisitt `GoogleAuthClientContext` (`provenDesktopClient`) for å
 * skille et kontekst-bevist gjenopprettbart tilfelle (`EMAIL_REAUTH_REQUIRED`)
 * fra det fortsatt fail-closed generelle tilfellet (`GOOGLE_INVALID_CLIENT`).
 */
const notProvenDesktop = { provenDesktopClient: false };
const provenDesktop = { provenDesktopClient: true };

describe("classifyGoogleTokenEndpointError - RFC 6749 §5.2 flat feilform", () => {
  it("A: invalid_grant MED en beskrivelse som nevner en annen klient → EMAIL_TOKEN_CLIENT_MISMATCH", () => {
    const details = classifyGoogleTokenEndpointError(400, JSON.stringify({ error: "invalid_grant", error_description: "Token was issued to a different client id." }), notProvenDesktop);
    expect(details.errorClass).toBe("EMAIL_TOKEN_CLIENT_MISMATCH");
    expect(details.googleError).toBe("invalid_grant");
  });

  it("B: invalid_grant MED en beskrivelse som nevner utløpt/tilbakekalt → EMAIL_REFRESH_TOKEN_REVOKED", () => {
    const details = classifyGoogleTokenEndpointError(400, JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), notProvenDesktop);
    expect(details.errorClass).toBe("EMAIL_REFRESH_TOKEN_REVOKED");
  });

  it("C: invalid_grant UTEN en gjenkjennelig beskrivelse → GOOGLE_INVALID_GRANT (den generiske grenen, IKKE en gjettet mer presis klasse)", () => {
    const details = classifyGoogleTokenEndpointError(400, JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" }), notProvenDesktop);
    expect(details.errorClass).toBe("GOOGLE_INVALID_GRANT");
  });

  it("D: invalid_client UTEN en bevist Desktop-klient → GOOGLE_INVALID_CLIENT, fail-closed (uprøvd/feilkonfigurert klient - HOST FIX #2 test B)", () => {
    const details = classifyGoogleTokenEndpointError(401, JSON.stringify({ error: "invalid_client", error_description: "Unauthorized" }), notProvenDesktop);
    expect(details.errorClass).toBe("GOOGLE_INVALID_CLIENT");
    expect(details.recoveryReason).toBeUndefined();
  });

  it("E: unauthorized_client behandles SAMME som invalid_client → GOOGLE_INVALID_CLIENT når klienten IKKE er bevist Desktop-type", () => {
    const details = classifyGoogleTokenEndpointError(401, JSON.stringify({ error: "unauthorized_client" }), notProvenDesktop);
    expect(details.errorClass).toBe("GOOGLE_INVALID_CLIENT");
  });

  it("F: insufficient_scope → EMAIL_INSUFFICIENT_SCOPE", () => {
    const details = classifyGoogleTokenEndpointError(403, JSON.stringify({ error: "insufficient_scope" }), notProvenDesktop);
    expect(details.errorClass).toBe("EMAIL_INSUFFICIENT_SCOPE");
  });

  it("G: ukjent/manglende error-felt → UNKNOWN_GOOGLE_AUTH, ALDRI en gjettet mer presis klasse", () => {
    expect(classifyGoogleTokenEndpointError(500, "{}", notProvenDesktop).errorClass).toBe("UNKNOWN_GOOGLE_AUTH");
    expect(classifyGoogleTokenEndpointError(500, "", notProvenDesktop).errorClass).toBe("UNKNOWN_GOOGLE_AUTH");
  });

  it("H: ikke-JSON kropp kaster ALDRI - trygg UNKNOWN_GOOGLE_AUTH-fallback", () => {
    expect(() => classifyGoogleTokenEndpointError(500, "<html>ikke json</html>", notProvenDesktop)).not.toThrow();
    expect(classifyGoogleTokenEndpointError(500, "<html>ikke json</html>", notProvenDesktop).errorClass).toBe("UNKNOWN_GOOGLE_AUTH");
  });

  it("I: error_description avkortes til 300 tegn (samme sikkerhetsnett som classifyDriveProbeError)", () => {
    const long = "x".repeat(500);
    const details = classifyGoogleTokenEndpointError(400, JSON.stringify({ error: "invalid_grant", error_description: long }), notProvenDesktop);
    expect(details.googleErrorDescription?.length).toBe(300);
  });
});

/** HOST FIX #2 test-matrise-punkt A/B/C: kontekst-bevisst invalid_client/unauthorized_client-klassifisering. */
describe("classifyGoogleTokenEndpointError - HOST FIX #2: invalid_client/unauthorized_client MED en bevist Desktop-klient", () => {
  it("A: unauthorized_client MED provenDesktopClient=true → EMAIL_REAUTH_REQUIRED, gjenopprettbar (host-funn run_id ab43fb1f)", () => {
    const details = classifyGoogleTokenEndpointError(401, JSON.stringify({ error: "unauthorized_client" }), provenDesktop);
    expect(details.errorClass).toBe("EMAIL_REAUTH_REQUIRED");
  });

  it("B: invalid_client MED provenDesktopClient=true → EMAIL_REAUTH_REQUIRED (samme gren som unauthorized_client)", () => {
    const details = classifyGoogleTokenEndpointError(401, JSON.stringify({ error: "invalid_client" }), provenDesktop);
    expect(details.errorClass).toBe("EMAIL_REAUTH_REQUIRED");
  });

  it("C: EMAIL_REAUTH_REQUIRED bærer recoveryReason=LEGACY_TOKEN_OR_CLIENT_BINDING - ALDRI en påstand om at Google faktisk eksponerte den gamle klient-IDen", () => {
    const details = classifyGoogleTokenEndpointError(401, JSON.stringify({ error: "unauthorized_client" }), provenDesktop);
    expect(details.recoveryReason).toBe("LEGACY_TOKEN_OR_CLIENT_BINDING");
  });

  it("uten provenDesktopClient (false) forblir invalid_client/unauthorized_client GOOGLE_INVALID_CLIENT - ALDRI globalt gjenopprettbar (§3 i ordren: manglende secret/uprøvd/feilkonfigurert klient skal fortsatt fail-closed)", () => {
    expect(classifyGoogleTokenEndpointError(401, JSON.stringify({ error: "invalid_client" }), notProvenDesktop).errorClass).toBe("GOOGLE_INVALID_CLIENT");
    expect(classifyGoogleTokenEndpointError(401, JSON.stringify({ error: "unauthorized_client" }), notProvenDesktop).errorClass).toBe("GOOGLE_INVALID_CLIENT");
  });
});

describe("formatGoogleAuthErrorReport - trygg, grep-bar logglinje", () => {
  it("J: inneholder ALDRI 'error_description'-teksten selv (kun klassifisert felt) - unngår at en fremtidig Google-feilbeskrivelse med uventet innhold havner rått i loggen", () => {
    const details = classifyGoogleTokenEndpointError(400, JSON.stringify({ error: "invalid_grant", error_description: "hemmelig-utseende-tekst-12345" }), notProvenDesktop);
    const report = formatGoogleAuthErrorReport(details);
    expect(report).not.toContain("hemmelig-utseende-tekst-12345");
    expect(report).toContain("google_auth_error_class=GOOGLE_INVALID_GRANT");
  });

  it("HOST FIX #2: inkluderer recovery_reason KUN for EMAIL_REAUTH_REQUIRED, ALDRI for GOOGLE_INVALID_CLIENT", () => {
    const recoverable = classifyGoogleTokenEndpointError(401, JSON.stringify({ error: "unauthorized_client" }), provenDesktop);
    expect(formatGoogleAuthErrorReport(recoverable)).toContain("recovery_reason=LEGACY_TOKEN_OR_CLIENT_BINDING");
    const failClosed = classifyGoogleTokenEndpointError(401, JSON.stringify({ error: "unauthorized_client" }), notProvenDesktop);
    expect(formatGoogleAuthErrorReport(failClosed)).not.toContain("recovery_reason");
  });
});

describe("isRecoverableGoogleAuthErrorClass", () => {
  it("K: token-relaterte klasser er gjenopprettbare via reauth", () => {
    expect(isRecoverableGoogleAuthErrorClass("EMAIL_TOKEN_CLIENT_MISMATCH")).toBe(true);
    expect(isRecoverableGoogleAuthErrorClass("EMAIL_REFRESH_TOKEN_REVOKED")).toBe(true);
    expect(isRecoverableGoogleAuthErrorClass("GOOGLE_INVALID_GRANT")).toBe(true);
    expect(isRecoverableGoogleAuthErrorClass("EMAIL_INSUFFICIENT_SCOPE")).toBe(true);
  });
  it("HOST FIX #2: EMAIL_REAUTH_REQUIRED er gjenopprettbar (kontekst-beviset skjedde allerede ved klassifisering)", () => {
    expect(isRecoverableGoogleAuthErrorClass("EMAIL_REAUTH_REQUIRED")).toBe(true);
  });
  it("L: klient-/ukjent-feil er IKKE automatisk gjenopprettbare (krever manuell undersøkelse, ALDRI en gjentatt automatisk løkke mot feil årsak)", () => {
    expect(isRecoverableGoogleAuthErrorClass("GOOGLE_INVALID_CLIENT")).toBe(false);
    expect(isRecoverableGoogleAuthErrorClass("UNKNOWN_GOOGLE_AUTH")).toBe(false);
  });
});

describe("parseGoogleAuthFailureReason - parser ToolGateway sin 'tool_failed:<message>'-innpakning", () => {
  it("M: parser en gyldig klassifisert reason-streng korrekt", () => {
    expect(parseGoogleAuthFailureReason("tool_failed:google_auth_failed_400:EMAIL_TOKEN_CLIENT_MISMATCH:invalid_grant")).toBe("EMAIL_TOKEN_CLIENT_MISMATCH");
  });
  it("N: fungerer også UTEN ToolGateway sin 'tool_failed:'-prefiks (samme mønster, uavhengig av innpakningslag)", () => {
    expect(parseGoogleAuthFailureReason("google_auth_failed_401:GOOGLE_INVALID_CLIENT")).toBe("GOOGLE_INVALID_CLIENT");
  });
  it("O: en helt annen feil (ikke Google-auth i det hele tatt) gir undefined - ALDRI en gjettet klasse", () => {
    expect(parseGoogleAuthFailureReason("tool_failed:drive_rate_limited")).toBeUndefined();
    expect(parseGoogleAuthFailureReason("tool_failed:gmail_attachment_not_found_att-1")).toBeUndefined();
  });
  it("HOST FIX #2: parser EMAIL_REAUTH_REQUIRED (den nye klassen) korrekt", () => {
    expect(parseGoogleAuthFailureReason("tool_failed:google_auth_failed_401:EMAIL_REAUTH_REQUIRED:unauthorized_client")).toBe("EMAIL_REAUTH_REQUIRED");
  });
});

const originalFetch = global.fetch;
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GmailTransport - googleAccessToken() feilbane sender NÅ den klassifiserte meldingen videre (regresjon mot host-funnet)", () => {
  const originalClientType = process.env["JARVIS_GOOGLE_OAUTH_CLIENT_TYPE"];
  beforeEach(() => {
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "test-client-id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "test-client-secret";
    delete process.env["JARVIS_GOOGLE_OAUTH_CLIENT_TYPE"];
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalClientType === undefined) delete process.env["JARVIS_GOOGLE_OAUTH_CLIENT_TYPE"];
    else process.env["JARVIS_GOOGLE_OAUTH_CLIENT_TYPE"] = originalClientType;
  });

  it("P: en 400 invalid_grant fra token-endepunktet gir en feilmelding som BÅDE inneholder 'google_auth_failed_400' (bakoverkompatibel med classifyToolFailure() sin AUTH-regex) OG den nye klassen", async () => {
    global.fetch = vi.fn(async () => jsonResponse(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })) as unknown as typeof fetch;
    const transport = new GmailTransport();
    await expect(transport.invoke("list_messages", { max: 5 }, "some-refresh-token")).rejects.toThrow(
      /google_auth_failed_400:EMAIL_REFRESH_TOKEN_REVOKED:invalid_grant/
    );
  });

  it("Q: ALDRI logger/kaster selve refresh-tokenet eller client_secret i feilmeldingen", async () => {
    global.fetch = vi.fn(async () => jsonResponse(400, { error: "invalid_grant", error_description: "expired" })) as unknown as typeof fetch;
    const transport = new GmailTransport();
    try {
      await transport.invoke("list_messages", { max: 5 }, "SUPER-SECRET-REFRESH-TOKEN-VALUE");
      expect.fail("skulle kastet");
    } catch (err) {
      expect((err as Error).message).not.toContain("SUPER-SECRET-REFRESH-TOKEN-VALUE");
      expect((err as Error).message).not.toContain("test-client-secret");
    }
  });

  it("R: en respons UTEN gyldig JSON-kropp gir fortsatt en klassifisert (UNKNOWN_GOOGLE_AUTH) feil - ALDRI en ukastet/hengende promise", async () => {
    global.fetch = vi.fn(async () => new Response("plain text error", { status: 500 })) as unknown as typeof fetch;
    const transport = new GmailTransport();
    await expect(transport.invoke("list_messages", { max: 5 }, "token")).rejects.toThrow(/google_auth_failed_500:UNKNOWN_GOOGLE_AUTH/);
  });

  it("HOST FIX #2 (host-funn run_id ab43fb1f): unauthorized_client MED JARVIS_GOOGLE_OAUTH_CLIENT_TYPE=desktop satt → EMAIL_REAUTH_REQUIRED, ikke lenger GOOGLE_INVALID_CLIENT", async () => {
    process.env["JARVIS_GOOGLE_OAUTH_CLIENT_TYPE"] = "desktop";
    global.fetch = vi.fn(async () => jsonResponse(401, { error: "unauthorized_client" })) as unknown as typeof fetch;
    const transport = new GmailTransport();
    await expect(transport.invoke("list_messages", { max: 5 }, "legacy-refresh-token")).rejects.toThrow(
      /google_auth_failed_401:EMAIL_REAUTH_REQUIRED:unauthorized_client/
    );
  });

  it("HOST FIX #2: samme unauthorized_client UTEN JARVIS_GOOGLE_OAUTH_CLIENT_TYPE=desktop satt → forblir GOOGLE_INVALID_CLIENT, fail-closed", async () => {
    global.fetch = vi.fn(async () => jsonResponse(401, { error: "unauthorized_client" })) as unknown as typeof fetch;
    const transport = new GmailTransport();
    await expect(transport.invoke("list_messages", { max: 5 }, "legacy-refresh-token")).rejects.toThrow(
      /google_auth_failed_401:GOOGLE_INVALID_CLIENT:unauthorized_client/
    );
  });
});

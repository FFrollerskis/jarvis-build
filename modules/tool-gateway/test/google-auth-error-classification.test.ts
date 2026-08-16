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
 */
describe("classifyGoogleTokenEndpointError - RFC 6749 §5.2 flat feilform", () => {
  it("A: invalid_grant MED en beskrivelse som nevner en annen klient → EMAIL_TOKEN_CLIENT_MISMATCH", () => {
    const details = classifyGoogleTokenEndpointError(400, JSON.stringify({ error: "invalid_grant", error_description: "Token was issued to a different client id." }));
    expect(details.errorClass).toBe("EMAIL_TOKEN_CLIENT_MISMATCH");
    expect(details.googleError).toBe("invalid_grant");
  });

  it("B: invalid_grant MED en beskrivelse som nevner utløpt/tilbakekalt → EMAIL_REFRESH_TOKEN_REVOKED", () => {
    const details = classifyGoogleTokenEndpointError(400, JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }));
    expect(details.errorClass).toBe("EMAIL_REFRESH_TOKEN_REVOKED");
  });

  it("C: invalid_grant UTEN en gjenkjennelig beskrivelse → GOOGLE_INVALID_GRANT (den generiske grenen, IKKE en gjettet mer presis klasse)", () => {
    const details = classifyGoogleTokenEndpointError(400, JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" }));
    expect(details.errorClass).toBe("GOOGLE_INVALID_GRANT");
  });

  it("D: invalid_client → GOOGLE_INVALID_CLIENT", () => {
    const details = classifyGoogleTokenEndpointError(401, JSON.stringify({ error: "invalid_client", error_description: "Unauthorized" }));
    expect(details.errorClass).toBe("GOOGLE_INVALID_CLIENT");
  });

  it("E: unauthorized_client behandles SAMME som invalid_client → GOOGLE_INVALID_CLIENT", () => {
    const details = classifyGoogleTokenEndpointError(401, JSON.stringify({ error: "unauthorized_client" }));
    expect(details.errorClass).toBe("GOOGLE_INVALID_CLIENT");
  });

  it("F: insufficient_scope → EMAIL_INSUFFICIENT_SCOPE", () => {
    const details = classifyGoogleTokenEndpointError(403, JSON.stringify({ error: "insufficient_scope" }));
    expect(details.errorClass).toBe("EMAIL_INSUFFICIENT_SCOPE");
  });

  it("G: ukjent/manglende error-felt → UNKNOWN_GOOGLE_AUTH, ALDRI en gjettet mer presis klasse", () => {
    expect(classifyGoogleTokenEndpointError(500, "{}").errorClass).toBe("UNKNOWN_GOOGLE_AUTH");
    expect(classifyGoogleTokenEndpointError(500, "").errorClass).toBe("UNKNOWN_GOOGLE_AUTH");
  });

  it("H: ikke-JSON kropp kaster ALDRI - trygg UNKNOWN_GOOGLE_AUTH-fallback", () => {
    expect(() => classifyGoogleTokenEndpointError(500, "<html>ikke json</html>")).not.toThrow();
    expect(classifyGoogleTokenEndpointError(500, "<html>ikke json</html>").errorClass).toBe("UNKNOWN_GOOGLE_AUTH");
  });

  it("I: error_description avkortes til 300 tegn (samme sikkerhetsnett som classifyDriveProbeError)", () => {
    const long = "x".repeat(500);
    const details = classifyGoogleTokenEndpointError(400, JSON.stringify({ error: "invalid_grant", error_description: long }));
    expect(details.googleErrorDescription?.length).toBe(300);
  });
});

describe("formatGoogleAuthErrorReport - trygg, grep-bar logglinje", () => {
  it("J: inneholder ALDRI 'error_description'-teksten selv (kun klassifisert felt) - unngår at en fremtidig Google-feilbeskrivelse med uventet innhold havner rått i loggen", () => {
    const details = classifyGoogleTokenEndpointError(400, JSON.stringify({ error: "invalid_grant", error_description: "hemmelig-utseende-tekst-12345" }));
    const report = formatGoogleAuthErrorReport(details);
    expect(report).not.toContain("hemmelig-utseende-tekst-12345");
    expect(report).toContain("google_auth_error_class=GOOGLE_INVALID_GRANT");
  });
});

describe("isRecoverableGoogleAuthErrorClass", () => {
  it("K: token-relaterte klasser er gjenopprettbare via reauth", () => {
    expect(isRecoverableGoogleAuthErrorClass("EMAIL_TOKEN_CLIENT_MISMATCH")).toBe(true);
    expect(isRecoverableGoogleAuthErrorClass("EMAIL_REFRESH_TOKEN_REVOKED")).toBe(true);
    expect(isRecoverableGoogleAuthErrorClass("GOOGLE_INVALID_GRANT")).toBe(true);
    expect(isRecoverableGoogleAuthErrorClass("EMAIL_INSUFFICIENT_SCOPE")).toBe(true);
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
});

const originalFetch = global.fetch;
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GmailTransport - googleAccessToken() feilbane sender NÅ den klassifiserte meldingen videre (regresjon mot host-funnet)", () => {
  beforeEach(() => {
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "test-client-id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "test-client-secret";
  });
  afterEach(() => {
    global.fetch = originalFetch;
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
});

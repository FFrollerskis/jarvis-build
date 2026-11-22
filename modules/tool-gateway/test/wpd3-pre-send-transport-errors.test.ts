import { describe, expect, it } from "vitest";
import { UnsafeVendorUrlError, isIndeterminateTransportError, isProvenPreSendTransportError, transportErrorKind } from "../src/index.ts";

/**
 * WP-D3 review H1 (D-459): `isProvenPreSendTransportError` er det MOTSATTE standardvalget av `isIndeterminateTransportError`: den er `true` KUN når feilen BEVISER at ingen byte av forespørselen nådde leverandøren.
 * En transport som vet at forespørselen er en mutasjon (growth-skriving) bruker den til å regne ALT ANNET som ukjent utfall - også feilformer vi ikke kjenner. Ren funksjon, ingen I/O.
 */
const withCode = (message: string, code: string, name = "Error"): Error => Object.assign(new Error(message), { code, name });
const fetchFailed = (cause: unknown): TypeError => new TypeError("fetch failed", { cause });

describe("isProvenPreSendTransportError", () => {
  it("BEVIST aldri sendt: tilkobling nektet, DNS, tilkoblingstidsavbrudd, TLS-oppsett, ugyldig URL, utrygg URL", () => {
    const cases: Array<[string, unknown]> = [
      ["ECONNREFUSED", fetchFailed(withCode("connect ECONNREFUSED 127.0.0.1:9", "ECONNREFUSED"))],
      ["ENOTFOUND", fetchFailed(withCode("getaddrinfo ENOTFOUND x.invalid", "ENOTFOUND"))],
      ["EAI_AGAIN", fetchFailed(withCode("getaddrinfo EAI_AGAIN", "EAI_AGAIN"))],
      ["EHOSTUNREACH", fetchFailed(withCode("connect EHOSTUNREACH", "EHOSTUNREACH"))],
      ["connect-timeout", fetchFailed(withCode("Connect Timeout Error", "UND_ERR_CONNECT_TIMEOUT"))],
      ["TLS: ugyldig sertifikat", fetchFailed(withCode("self-signed certificate", "DEPTH_ZERO_SELF_SIGNED_CERT"))],
      ["TLS: ERR_TLS_CERT_ALTNAME_INVALID", fetchFailed(withCode("Hostname mismatch", "ERR_TLS_CERT_ALTNAME_INVALID"))],
      ["ugyldig URL", withCode("Invalid URL", "ERR_INVALID_URL", "TypeError")],
      ["utrygg URL (UnsafeVendorUrlError før fetch)", new UnsafeVendorUrlError("url_malformed")],
      ["AggregateError der alle forsøk ble nektet", fetchFailed(Object.assign(new AggregateError([withCode("refused", "ECONNREFUSED")], "x"), { code: "ECONNREFUSED" }))]
    ];
    for (const [label, error] of cases) expect(isProvenPreSendTransportError(error), label).toBe(true);
  });

  it("IKKE bevist (= ukjent for en mutasjon): nullstilt/avbrutt/tidsavbrutt etter sending, 3xx fra leverandøren, uleselig 2xx, ukjente feilformer og blandede feil", () => {
    const cases: Array<[string, unknown]> = [
      ["ECONNRESET", fetchFailed(withCode("read ECONNRESET", "ECONNRESET"))],
      ["undici SocketError (other side closed)", fetchFailed(withCode("other side closed", "UND_ERR_SOCKET", "SocketError"))],
      ["EPIPE", fetchFailed(withCode("write EPIPE", "EPIPE"))],
      ["headers-timeout", fetchFailed(withCode("Headers Timeout Error", "UND_ERR_HEADERS_TIMEOUT", "HeadersTimeoutError"))],
      ["TimeoutError", new DOMException("The operation was aborted due to timeout", "TimeoutError")],
      ["AbortError", new DOMException("This operation was aborted", "AbortError")],
      ["gatewayens tidsavbrudd", new Error("tool_timeout")],
      ["3xx fra leverandøren (guardedFetch kaster ETTER sending)", new UnsafeVendorUrlError("unexpected_redirect_http_307")],
      ["SyntaxError fra JSON.parse av et svar", new SyntaxError("Unexpected token < in JSON at position 0")],
      ["feil som bærer en 2xx-status", Object.assign(new Error("body not json"), { httpStatus: 200 })],
      ["fetch failed uten kjent årsak", new TypeError("fetch failed")],
      ["terminated", new TypeError("terminated")],
      ["en helt ukjent feilform", new Error("boom")],
      ["en streng", "streng"],
      ["null", null],
      ["blandet: nektet + nullstilt (AggregateError) er ikke bevist", fetchFailed(Object.assign(new AggregateError([withCode("refused", "ECONNREFUSED"), withCode("reset", "ECONNRESET")], "x"), { code: undefined }))],
      ["en nektet-kode OG en abort i samme kjede er ikke bevist", Object.assign(new Error("x"), { code: "ECONNREFUSED", cause: new DOMException("aborted", "AbortError") })]
    ];
    for (const [label, error] of cases) expect(isProvenPreSendTransportError(error), label).toBe(false);
  });

  it("forholdet til isIndeterminateTransportError: ingen feil er begge deler, og redirect-arten er `redirect`", () => {
    const shapes: unknown[] = [
      fetchFailed(withCode("refused", "ECONNREFUSED")), fetchFailed(withCode("reset", "ECONNRESET")), new UnsafeVendorUrlError("url_malformed"), new UnsafeVendorUrlError("unexpected_redirect_http_303"),
      new Error("boom"), new DOMException("t", "TimeoutError")
    ];
    for (const shape of shapes) expect(isProvenPreSendTransportError(shape) && isIndeterminateTransportError(shape)).toBe(false);
    expect(transportErrorKind(new UnsafeVendorUrlError("unexpected_redirect_http_307"))).toBe("redirect");
  });
});

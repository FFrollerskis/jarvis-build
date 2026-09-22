import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FIKEN_REAUTH_PORT,
  FIKEN_OAUTH_AUTHORIZE_ENDPOINT,
  FIKEN_OAUTH_TOKEN_ENDPOINT,
  MalformedFikenAuthorizationUrlError,
  MissingFikenRefreshTokenError,
  buildAuthorizationCodeExchangeBody,
  buildFikenAuthorizationUrl,
  buildFikenRedirectUri,
  buildRefreshTokenExchangeBody,
  extractFikenRefreshToken,
  fikenBasicAuthHeader,
  fikenTokenExchangeFailureReason,
  validateFikenAuthorizationUrl
} from "../src/fiken-oauth.ts";
import { fikenAccessToken } from "../src/fiken-transport.ts";

/**
 * D-107 HOST-FIX #3-regresjon: Fiken OAuth-kontrakten, verifisert mot Fikens
 * EGEN dokumentasjonstekst (verbatim - se fiken-oauth.ts sin toppkommentar).
 * Låser SPESIELT den rettede token-endepunkt-autentiseringen: HTTP Basic med
 * client-credentials i HEADEREN - den opprinnelige D-107-implementasjonen
 * sendte dem i form-kroppen (bekreftet avvik fra dokumentasjonen, ville
 * feilet med 401 ved første ekte credential).
 */

describe("A: token-endepunkt-autentisering (den rettede defekten)", () => {
  it("fikenBasicAuthHeader bygger korrekt Basic-header (base64 av id:secret)", () => {
    const header = fikenBasicAuthHeader("my-id", "my-secret");
    expect(header).toBe(`Basic ${Buffer.from("my-id:my-secret").toString("base64")}`);
    expect(header.startsWith("Basic ")).toBe(true);
  });
  it("buildRefreshTokenExchangeBody inneholder KUN grant_type/refresh_token - ALDRI client_id/client_secret (de hører i Basic-headeren)", () => {
    const body = buildRefreshTokenExchangeBody("rt-123");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-123");
    expect(body.has("client_id")).toBe(false);
    expect(body.has("client_secret")).toBe(false);
    expect([...body.keys()].sort()).toEqual(["grant_type", "refresh_token"]);
  });
  it("buildAuthorizationCodeExchangeBody følger dokumentasjonen eksakt (grant_type/code/redirect_uri/state, ingen client-credentials i kroppen)", () => {
    const body = buildAuthorizationCodeExchangeBody("auth-code-x", "http://localhost:8944/oauth2callback", "state-y");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-x");
    expect(body.get("redirect_uri")).toBe("http://localhost:8944/oauth2callback");
    expect(body.get("state")).toBe("state-y");
    expect(body.has("client_id")).toBe(false);
    expect(body.has("client_secret")).toBe(false);
  });
});

describe("B: runtime-refresh-flyten (fikenAccessToken) bruker FAKTISK Basic-auth - ende-til-ende med mocket fetch", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env["JARVIS_FIKEN_CLIENT_ID"];
    delete process.env["JARVIS_FIKEN_CLIENT_SECRET"];
  });

  it("sender Authorization: Basic-header og en kropp UTEN client-credentials mot det dokumenterte token-endepunktet", async () => {
    process.env["JARVIS_FIKEN_CLIENT_ID"] = "cid-test";
    process.env["JARVIS_FIKEN_CLIENT_SECRET"] = "csecret-test";
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string>)["authorization"] ?? null;
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ access_token: "at-fresh" }), { status: 200 });
    }) as typeof fetch;

    const token = await fikenAccessToken("rt-abc");
    expect(token).toBe("at-fresh");
    expect(capturedUrl).toBe(FIKEN_OAUTH_TOKEN_ENDPOINT);
    expect(capturedAuth).toBe(fikenBasicAuthHeader("cid-test", "csecret-test"));
    const parsed = new URLSearchParams(capturedBody);
    expect(parsed.get("grant_type")).toBe("refresh_token");
    expect(parsed.get("refresh_token")).toBe("rt-abc");
    expect(parsed.has("client_id")).toBe(false);
    expect(parsed.has("client_secret")).toBe(false);
  });

  it("kaster fiken_oauth_client_not_configured FØR noe nettverkskall når client-credentials mangler", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    await expect(fikenAccessToken("rt-abc")).rejects.toThrow("fiken_oauth_client_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("en feilet token-veksling kaster typet FikenApiError med status - aldri en stille suksess", async () => {
    process.env["JARVIS_FIKEN_CLIENT_ID"] = "cid-test";
    process.env["JARVIS_FIKEN_CLIENT_SECRET"] = "csecret-test";
    globalThis.fetch = vi.fn(async () => new Response("denied", { status: 401 })) as typeof fetch;
    await expect(fikenAccessToken("rt-bad")).rejects.toThrow("fiken_auth_failed_401");
  });
});

describe("C: autorisasjons-URL - eksakt de fire dokumenterte parameterne", () => {
  it("bygger response_type=code + client_id + redirect_uri + state mot det dokumenterte endepunktet", () => {
    const url = new URL(buildFikenAuthorizationUrl({ clientId: "cid", redirectUri: "http://localhost:8944/oauth2callback", state: "s1" }));
    expect(url.origin + url.pathname).toBe(FIKEN_OAUTH_AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8944/oauth2callback");
    expect(url.searchParams.get("state")).toBe("s1");
  });
  it("legger IKKE til udokumenterte parametre (scope/prompt/access_type er Google-konsepter, ikke Fikens dokumenterte flyt)", () => {
    const url = new URL(buildFikenAuthorizationUrl({ clientId: "cid", redirectUri: "http://localhost:8944/oauth2callback", state: "s1" }));
    expect([...url.searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "response_type", "state"]);
  });
  it("validateFikenAuthorizationUrl godtar en korrekt bygget URL", () => {
    const url = buildFikenAuthorizationUrl({ clientId: "cid", redirectUri: buildFikenRedirectUri(DEFAULT_FIKEN_REAUTH_PORT), state: "s1" });
    expect(() => validateFikenAuthorizationUrl(url)).not.toThrow();
  });
  it("validateFikenAuthorizationUrl avviser manglende state/client_id/feil endepunkt (fail-closed FØR nettleseren åpnes)", () => {
    expect(() => validateFikenAuthorizationUrl("https://fiken.no/oauth/authorize?response_type=code&client_id=cid&redirect_uri=http%3A%2F%2Flocalhost%3A8944%2Foauth2callback")).toThrow(
      MalformedFikenAuthorizationUrlError
    );
    expect(() => validateFikenAuthorizationUrl("https://evil.example/oauth/authorize?response_type=code&client_id=cid&redirect_uri=x&state=s")).toThrow(MalformedFikenAuthorizationUrlError);
  });
});

describe("D: redirect-URI/callback-kontrakt", () => {
  it("buildFikenRedirectUri bruker vertsnavnet localhost (D-241: Fiken avviser IP-literalen 127.0.0.1 - krever https for alt utenom localhost) + dedikert Fiken-port + felles callback-path", () => {
    expect(buildFikenRedirectUri(DEFAULT_FIKEN_REAUTH_PORT)).toBe("http://localhost:8944/oauth2callback");
  });
  it("porten er distinkt fra Drive- (8942) og Gmail- (8943) reauth-portene", () => {
    expect(DEFAULT_FIKEN_REAUTH_PORT).toBe(8944);
  });
});

describe("E: refresh-token-ekstraksjon og feilstier", () => {
  it("extractFikenRefreshToken returnerer tokenet når det finnes", () => {
    expect(extractFikenRefreshToken({ access_token: "a", refresh_token: "r" })).toBe("r");
  });
  it("kaster MissingFikenRefreshTokenError (aldri en stille halv-konfigurasjon) når responsen mangler refresh_token", () => {
    expect(() => extractFikenRefreshToken({ access_token: "a" })).toThrow(MissingFikenRefreshTokenError);
  });
  it("fikenTokenExchangeFailureReason gir en typet, status-basert (aldri kropp-ekko) årsak", () => {
    expect(fikenTokenExchangeFailureReason(401)).toBe("fiken_reauth_token_exchange_failed_401");
  });
});

describe("F: bootstrap-orchestrator-wiring (strukturelle sikkerhetslåser, samme grep-presedens som *-host-run-wiring-testene)", () => {
  const source = readFileSync(join(__dirname, "..", "scripts", "fiken-reauth.ts"), "utf8");

  it("gjenbruker de KANONISKE delte hjelperne - ingen duplisert OAuth-/env-logikk", () => {
    expect(source).toContain('from "../src/fiken-oauth.ts"');
    expect(source).toContain('google-drive-reauth-lib.ts"');
    expect(source).toContain("buildUpdatedEnvLines");
    expect(source).toContain("parseEnvValues");
  });
  it("skriver .env atomisk (backup + tmp + rename) og kun de to bootstrap-produserte variablene", () => {
    expect(source).toContain("copyFileSync(envPath, backupPath)");
    expect(source).toContain("renameSync(tmpPath, envPath)");
    expect(source).toMatch(/JARVIS_FIKEN_REFRESH_TOKEN:\s*refreshToken/);
    expect(source).toMatch(/JARVIS_FIKEN_COMPANY_SLUG:\s*companySlug/);
    expect(source).not.toMatch(/JARVIS_FIKEN_CLIENT_ID:\s/);
    expect(source).not.toMatch(/JARVIS_FIKEN_CLIENT_SECRET:\s/);
  });
  it("interpolerer ALDRI secret-variabler (refreshToken/clientSecret/access_token/code) inn i en logglinje", () => {
    expect(source).not.toMatch(/log\([^)]*\$\{(refreshToken|clientSecret|tokens\.access_token|callback\.code)/);
    expect(source).not.toMatch(/console\.(log|error)\([^)]*\$\{(refreshToken|clientSecret)/);
  });
  it("CSRF-vern: validerer callback-state mot kjøringens egen state og avviser mismatch fail-closed", () => {
    expect(source).toContain("isValidCallbackState(callback.state, state)");
    expect(source).toContain("fiken_reauth_state_mismatch");
  });
  it("fail-closed uten client-credentials: ingen server/nettleser startes", () => {
    expect(source).toContain("fiken_reauth_missing_client_credentials");
  });
  it("ber ALDRI interaktivt om en secret (readline brukes kun til company-valg)", () => {
    expect(source).not.toMatch(/question\([^)]*(secret|token|passord)/i);
  });
});

/**
 * Fiken OAuth2 - RENE, testbare byggefunksjoner delt mellom runtime-
 * refresh-flyten (`fiken-transport.ts` sin `fikenAccessToken()`) og
 * engangs-bootstrappen (`scripts/fiken-reauth.ts`). INGEN nettverk/
 * filsystem/prosess-side-effekter her (samme presedens som
 * `google-drive-reauth-lib.ts`).
 *
 * D-41-verifiseringsstatus (D-107 host-fix #3): verifisert mot Fiken sin
 * EGEN API-dokumentasjonstekst (verbatim-utdrag fra `info.description` i
 * Fikens OpenAPI-spec, speilet uendret på GitHub - `bjerkio/fiken-js`;
 * direkte `api.fiken.no` er fortsatt egress-blokkert fra byggemiljøet):
 *   - Autorisasjon: `GET https://fiken.no/oauth/authorize?response_type=
 *     code&client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&state=STATE` -
 *     NØYAKTIG disse fire parameterne er dokumentert; ingen `scope`-param
 *     i autorisasjons-URL-en er dokumentert, og legges derfor BEVISST ikke
 *     til (D-41: aldri gjettede parametre).
 *   - Token-endepunkt: `POST https://fiken.no/oauth/token` - "The token
 *     endpoint is protected with Http Basic Authentication and you should
 *     use your application client id and client secret as credentials".
 *     Klient-credentials går altså i `Authorization: Basic ...`-headeren,
 *     ALDRI i form-kroppen (den opprinnelige D-107-implementasjonen sendte
 *     dem i kroppen - en bekreftet avvik-fra-dokumentasjon-defekt, rettet
 *     her).
 *   - Kode-veksling: kropp `grant_type=authorization_code&code=AUTHCODE&
 *     redirect_uri=REDIRECT_URI&state=STATE` (dokumentasjonen inkluderer
 *     `state` OGSÅ i token-forespørselen - beholdt nøyaktig).
 *   - Fornyelse: kropp `grant_type=refresh_token&refresh_token=...`.
 *     Ingen refresh-token-ROTASJON er dokumentert - refresh-tokenet er
 *     stabilt og ugyldiggjøres kun ved at brukeren trekker tilbake appens
 *     samtykke.
 */

export const FIKEN_OAUTH_AUTHORIZE_ENDPOINT = "https://fiken.no/oauth/authorize";
export const FIKEN_OAUTH_TOKEN_ENDPOINT = "https://fiken.no/oauth/token";

/** Egen standardport for Fiken-reauth-loopback-serveren - distinkt fra Drive (8942)/Gmail (8943), samme eksplisitt-intensjon-presedens. */
export const DEFAULT_FIKEN_REAUTH_PORT = 8944;
export const FIKEN_OAUTH_CALLBACK_PATH = "/oauth2callback";

export function buildFikenRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${FIKEN_OAUTH_CALLBACK_PATH}`;
}

/** Dokumentert token-endepunkt-autentisering: HTTP Basic med client_id:client_secret - `Buffer` er en Node-global (ingen import), verdien logges ALDRI. */
export function fikenBasicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

export interface FikenAuthorizationUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
}

/** Bygger NØYAKTIG den dokumenterte autorisasjons-URL-en - fire parametre, ingen gjettet `scope`/`prompt`/`access_type` (Google-spesifikke konsepter som IKKE finnes i Fikens dokumenterte flyt). */
export function buildFikenAuthorizationUrl(params: FikenAuthorizationUrlParams): string {
  const url = new URL(FIKEN_OAUTH_AUTHORIZE_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

export class MalformedFikenAuthorizationUrlError extends Error {
  constructor(missing: string[]) {
    super(`fiken_reauth_malformed_authorization_url: mangler ${missing.join("; ")} - nettleseren blir IKKE åpnet.`);
    this.name = "MalformedFikenAuthorizationUrlError";
  }
}

/** Pre-flight-validering FØR nettleseren åpnes (samme fail-closed-presedens som `validateAuthorizationUrl` i google-drive-reauth-lib). */
export function validateFikenAuthorizationUrl(authorizationUrl: string): void {
  const parsed = new URL(authorizationUrl);
  const missing: string[] = [];
  if (parsed.origin + parsed.pathname !== FIKEN_OAUTH_AUTHORIZE_ENDPOINT) missing.push(`endepunkt (${FIKEN_OAUTH_AUTHORIZE_ENDPOINT})`);
  if (parsed.searchParams.get("response_type") !== "code") missing.push("response_type=code");
  if (!parsed.searchParams.get("client_id")) missing.push("client_id");
  if (!parsed.searchParams.get("redirect_uri")) missing.push("redirect_uri");
  if (!parsed.searchParams.get("state")) missing.push("state");
  if (missing.length > 0) throw new MalformedFikenAuthorizationUrlError(missing);
}

/** Dokumentert kode-vekslings-kropp: grant_type/code/redirect_uri/state - client_id/client_secret hører hjemme i Basic-headeren, ALDRI her. */
export function buildAuthorizationCodeExchangeBody(code: string, redirectUri: string, state: string): URLSearchParams {
  return new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, state });
}

/** Dokumentert fornyelses-kropp: KUN grant_type/refresh_token - client-credentials i Basic-headeren. */
export function buildRefreshTokenExchangeBody(refreshToken: string): URLSearchParams {
  return new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
}

/** Typet, loggbar (ALDRI kropp/secrets) årsak for en feilet token-veksling. */
export function fikenTokenExchangeFailureReason(status: number): string {
  return `fiken_reauth_token_exchange_failed_${status}`;
}

export interface FikenTokenResponse {
  access_token?: string;
  refresh_token?: string;
}

export class MissingFikenRefreshTokenError extends Error {
  constructor() {
    super(
      "fiken_reauth_no_refresh_token: token-responsen manglet refresh_token. Fiken sin dokumenterte flyt returnerer " +
        "den sammen med access_token ved kode-veksling - trekk tilbake appens samtykke i Fiken og kjør bootstrappen på nytt. .env er IKKE endret."
    );
    this.name = "MissingFikenRefreshTokenError";
  }
}

/** Fail-closed: Fiken-dokumentasjonen garanterer refresh_token i kode-vekslings-responsen - mangler den, feiler bootstrappen EKSPLISITT (aldri en stille halv-konfigurasjon). */
export function extractFikenRefreshToken(response: FikenTokenResponse): string {
  if (!response.refresh_token) throw new MissingFikenRefreshTokenError();
  return response.refresh_token;
}

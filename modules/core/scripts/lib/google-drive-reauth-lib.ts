// GOOGLE DRIVE FULL-ACCESS REAUTH (2026-08-16): rene, testbare bygge-/parse-/
// beslutningsfunksjoner for `google-drive-reauth.ts`. INGEN nettverk/
// filsystem/prosess-side-effekter her (samme presedens som
// lib/q21-env-recovery.ts og lib/drive-acceptance-sandbox.ts) - selve HTTP-
// serveren, fetch-kallene, nettleseråpningen og .env-skrivingen bor i
// orchestrator-scriptet, slik at denne fila kan testes deterministisk uten
// en ekte nettleser/Google-konto/nettverkstilgang.

export const GOOGLE_OAUTH_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_OAUTH_TOKENINFO_ENDPOINT = "https://oauth2.googleapis.com/tokeninfo";
export const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
export const GOOGLE_DRIVE_ROOT_METADATA_ENDPOINT = "https://www.googleapis.com/drive/v3/files/root?fields=id";

/**
 * Verifisert mot Google sitt offisielle Drive API v3-, Calendar API v3- og
 * OAuth2/userinfo-discovery-dokument (IKKE gjettet - samme presedens som
 * D-41-scope-endringen): full Drive read/write/permissions
 * (`.../auth/drive` - `drive.file` dekker kun app-opprettede filer, allerede
 * bekreftet utilstrekkelig) + EKSISTERENDE Calendar read/create-capability
 * (`.../auth/calendar` - unngår å regressere kalenderfunksjonen, som deler
 * SAMME `JARVIS_GOOGLE_TOKEN`) + et minimalt, ikke-sensitivt identity-scope
 * (KUN e-postadressen, `.../auth/userinfo.email`) brukt utelukkende til §8
 * sin konto-konsistens-sjekk. Gmail (`JARVIS_EMAIL_TOKEN`) er en HELT annen,
 * i dag ukonfigurert credential - bevisst UTENFOR denne reauth-flyten.
 */
export const REQUIRED_REAUTH_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email"
] as const;

export const DEFAULT_REAUTH_PORT = 8942;
export const OAUTH_CALLBACK_PATH = "/oauth2callback";

export class MissingClientCredentialsError extends Error {
  constructor() {
    super(
      "google_reauth_missing_client_credentials: JARVIS_GOOGLE_CLIENT_ID og/eller JARVIS_GOOGLE_CLIENT_SECRET " +
        "mangler i .env - ingen nettleser åpnet, ingen lokal server startet."
    );
    this.name = "MissingClientCredentialsError";
  }
}

/** §1.A i ordren: fail-closed FØR noe (server/nettleser) startes. */
export function validateClientCredentials(clientId: string | undefined, clientSecret: string | undefined): asserts clientId is string {
  if (!clientId || !clientSecret) {
    throw new MissingClientCredentialsError();
  }
}

export interface AuthorizationUrlParams {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
}

/**
 * §3/§4 i ordren: offisiell "authorization code" + loopback-redirect-flyt
 * (RFC 8252) for installerte/CLI-klienter - ALDRI den avviklede OOB-flyten
 * (`urn:ietf:wg:oauth:2.0:oob` finnes IKKE noe sted i denne fila, se
 * regresjonstest i google-drive-reauth-lib.test.ts). `access_type=offline`
 * + `prompt=consent` er PÅKREVD for pålitelig å få en refresh_token tilbake
 * HVER gang (bekreftet mot google-auth-library sin offisielle Node.js-
 * dokumentasjon: "A refresh token is only returned the first time the user
 * consents... setting prompt to 'consent' will force this consent every
 * time, forcing a refresh_token to be returned"). `include_granted_scopes=
 * true` bevarer tidligere godkjente scopes (inkrementell autorisering) i
 * tillegg til de nye - ingen regresjon for andre Google-integrasjoner som
 * deler samme OAuth-klient.
 */
export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
  const url = new URL(GOOGLE_OAUTH_AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", params.state);
  return url.toString();
}

export function buildRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`;
}

export interface CallbackResult {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
}

/** Parser query-strengen fra den lokale loopback-callback-requesten - kalleren avgjør selv path-matching (`/oauth2callback`) FØR denne kalles. */
export function parseCallbackQuery(requestUrl: string): CallbackResult {
  const url = new URL(requestUrl, "http://127.0.0.1");
  return {
    code: url.searchParams.get("code") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
    error: url.searchParams.get("error") ?? undefined
  };
}

/** §D/§E i ordren: CSRF-vern - callback-staten MÅ matche EKSAKT det vi selv genererte for DENNE kjøringen. */
export function isValidCallbackState(received: string | undefined, expected: string): boolean {
  return Boolean(received) && received === expected;
}

/** §G i ordren: typet, loggbar (ALDRI kropp/secrets) årsak for en feilet token-exchange-HTTP-status. */
export function tokenExchangeFailureReason(status: number): string {
  return `google_reauth_token_exchange_failed_${status}`;
}

/**
 * §7 i ordren: IKKE nok at selve OAuth-callbacken lyktes - den FAKTISK
 * tildelte scope-strengen (fra token-endepunktets `scope`-felt, ELLER
 * tokeninfo-endepunktet ved re-verifisering av en eksisterende token) må
 * inneholde ALLE påkrevde scopes som EKSAKTE tokens (space-delimited),
 * ALDRI en substring-sjekk (unngår at f.eks. "drive.metadata.readonly"
 * feilaktig "matcher" et krav om "drive").
 */
export function hasAllRequiredScopes(grantedScope: string, required: readonly string[]): boolean {
  const granted = new Set(grantedScope.split(/\s+/).filter(Boolean));
  return required.every((scope) => granted.has(scope));
}

export interface TokenExchangeOutcome {
  refreshToken: string | undefined;
}

export type RefreshTokenDecision =
  | { action: "use_new"; refreshToken: string }
  | { action: "retain_existing"; refreshToken: string }
  | { action: "fail"; reason: string };

/**
 * §6 i ordren: Google returnerer NORMALT en fersk refresh_token hver gang
 * (siden orchestratoren ALLTID ber om `prompt=consent`, bevist §3 over) -
 * denne grenen dekker KUN det uventede unntaket der token-responsen likevel
 * mangler den. Den eksisterende refresh_token-en beholdes DA KUN dersom
 * (a) den faktisk finnes fra før OG (b) kalleren har LIVE-verifisert
 * (tokeninfo + en faktisk Drive-metadata-lesing - se orchestratoren) at DEN
 * eksisterende token-en NÅ har full scope FØR denne funksjonen kalles -
 * `verifiedFullScopeWithExisting` er derfor et eksplisitt, påkrevd input,
 * ALDRI en antakelse denne funksjonen selv gjør om Google sin interne
 * inkrementell-autorisering-oppførsel.
 */
export function decideRefreshToken(
  exchange: TokenExchangeOutcome,
  existingRefreshToken: string | undefined,
  verifiedFullScopeWithExisting: boolean
): RefreshTokenDecision {
  if (exchange.refreshToken) {
    return { action: "use_new", refreshToken: exchange.refreshToken };
  }
  if (existingRefreshToken && verifiedFullScopeWithExisting) {
    return { action: "retain_existing", refreshToken: existingRefreshToken };
  }
  return {
    action: "fail",
    reason:
      "google_reauth_no_refresh_token: token-responsen manglet refresh_token, og ingen eksisterende, live-bevist " +
      "fullscope-credential kunne beholdes trygt. Fjern Jarvis sin tilgang på " +
      "https://myaccount.google.com/permissions og prøv igjen for å tvinge en fullstendig ny consent."
  };
}

/** §5 i ordren: en TRYGG, ikke-sensitiv identifikator for logging/sammenligning - ALDRI hele e-postadressen. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

export type AccountConsistency = "match" | "mismatch" | "no_configured_account" | "undetermined";

/**
 * §8 i ordren: unngå å stille autorisere feil Google-identitet der det kan
 * oppdages. "undetermined" (identiteten kunne ikke hentes) blokkerer IKKE
 * automatisk - orchestratoren logger det ærlig som ukjent i stedet for å
 * late som en sammenligning fant sted; "mismatch" krever eksplisitt
 * bekreftelse fra Tobias (se orchestratoren) FØR noe skrives til .env.
 */
export function classifyAccountConsistency(detectedEmail: string | undefined, configuredAccount: string | undefined): AccountConsistency {
  if (!configuredAccount) return "no_configured_account";
  if (!detectedEmail) return "undetermined";
  return detectedEmail.toLowerCase() === configuredAccount.toLowerCase() ? "match" : "mismatch";
}

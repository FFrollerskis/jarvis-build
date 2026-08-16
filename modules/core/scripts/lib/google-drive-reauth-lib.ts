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
  /** §2/§3 i host-fix-ordren: KUN et hint til Google sin kontovelger - forhindrer ALDRI kontobytte, se `login_hint`-dokumentasjonen. */
  loginHint?: string | undefined;
}

/** §2 i host-fix-ordren: BEGGE tvinges samtidig - `select_account` viser ALLTID kontovelgeren (aldri en stille auto-valgt allerede-innlogget konto), `consent` garanterer en fersk refresh_token (se buildAuthorizationUrl sin dokumentasjon under). */
export const OAUTH_PROMPT = "consent select_account";

/**
 * §3/§4 i ordren: offisiell "authorization code" + loopback-redirect-flyt
 * (RFC 8252) for installerte/CLI-klienter - ALDRI den avviklede OOB-flyten
 * (`urn:ietf:wg:oauth:2.0:oob` finnes IKKE noe sted i denne fila, se
 * regresjonstest i google-drive-reauth-lib.test.ts). `access_type=offline`
 * + `prompt` inkluderer `consent` er PÅKREVD for pålitelig å få en
 * refresh_token tilbake HVER gang (bekreftet mot google-auth-library sin
 * offisielle Node.js-dokumentasjon: "A refresh token is only returned the
 * first time the user consents... setting prompt to 'consent' will force
 * this consent every time, forcing a refresh_token to be returned").
 * `prompt` inkluderer OGSÅ `select_account` (host-fix, 2026-08-16): Google
 * sin `prompt`-parameter godtar en mellomrom-delt liste av
 * `none`/`consent`/`select_account` - uten `select_account` bruker Google
 * stille en ALLEREDE INNLOGGET nettleser-konto (host-funnet: Tobias fikk
 * `henrik@ffskis.com` uten å bli spurt). `login_hint` (kun satt hvis
 * `JARVIS_GOOGLE_ACCOUNT` er konfigurert) er BEVISST kun et HINT - Google
 * sin egen dokumentasjon er eksplisitt på at det IKKE hindrer brukeren i å
 * velge en annen konto i kontovelgeren. `include_granted_scopes=true`
 * bevarer tidligere godkjente scopes (inkrementell autorisering) i tillegg
 * til de nye - ingen regresjon for andre Google-integrasjoner som deler
 * samme OAuth-klient.
 */
export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
  const url = new URL(GOOGLE_OAUTH_AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", OAUTH_PROMPT);
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", params.state);
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  return url.toString();
}

export function buildRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`;
}

export class MalformedAuthorizationUrlError extends Error {
  constructor(missing: string[]) {
    super(`google_reauth_malformed_authorization_url: mangler ${missing.join("; ")} - nettleseren blir IKKE åpnet.`);
    this.name = "MalformedAuthorizationUrlError";
  }
}

/**
 * §4 i host-fix-ordren: PRE-FLIGHT-validering FØR nettleseren i det hele
 * tatt åpnes - parser den GENERERTE URL-en tilbake og krever eksplisitt
 * `response_type=code` + `client_id`/`redirect_uri`/`state` + full
 * Drive-scope. Dette er et sikkerhetsnett MOT AKKURAT den observerte
 * host-feilen (URL-en ble korrumpert MELLOM generering og det Google
 * faktisk mottok - se `openBrowser()` sin Windows-fiks i
 * google-drive-reauth.ts for selve transport-root cause) - fanger enhver
 * FREMTIDIG regresjon i selve URL-byggingen, fail-closed.
 */
export function validateAuthorizationUrl(authorizationUrl: string, requiredScopes: readonly string[]): void {
  const parsed = new URL(authorizationUrl);
  const missing: string[] = [];
  if (parsed.searchParams.get("response_type") !== "code") missing.push("response_type=code");
  if (!parsed.searchParams.get("client_id")) missing.push("client_id");
  if (!parsed.searchParams.get("redirect_uri")) missing.push("redirect_uri");
  if (!parsed.searchParams.get("state")) missing.push("state");
  const scope = parsed.searchParams.get("scope") ?? "";
  if (!hasAllRequiredScopes(scope, requiredScopes)) {
    const missingScopes = requiredScopes.filter((s) => !new Set(scope.split(/\s+/)).has(s));
    missing.push(`scope (mangler: ${missingScopes.join(", ")})`);
  }
  if (missing.length > 0) {
    throw new MalformedAuthorizationUrlError(missing);
  }
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

/** §3 i host-fix-ordren: den trygge (maskerte), grep-bare rapportformen orchestratoren viser Tobias FØR den ber om eksplisitt bekreftelse. */
export function formatAccountMismatchReport(expectedMasked: string, authorizedMasked: string): string {
  return `expected_account=${expectedMasked} authorized_account=${authorizedMasked}`;
}

/**
 * HOST FIX #2 (2026-08-16): "redirect_uri_mismatch" fra Google (host-funn -
 * Tobias sin faktiske kjøring). Google validerer `redirect_uri` FØR noe
 * annet (sikkerhetskritisk, hindrer open-redirect) - ved mismatch vises en
 * feilside DIREKTE i nettleseren, og callback-serveren vår mottar ALDRI noe
 * (ingen HTTP-request kommer tilbake i det hele tatt). Dette er derfor
 * STRUKTURELT umulig å oppdage programmatisk via callback-serveren - denne
 * fila kan bevise/teste alt UNNTATT selve deteksjonen av feilen mens den
 * skjer (se orchestratoren sin loggmelding FØR nettleseren åpnes for den
 * ærlige Ctrl+C-veiledningen i stedet).
 *
 * En "Desktop app"-klient (RFC 8252, native/installert app) godtar EN
 * loopback-IP-redirect på HVILKEN SOM HELST port UTEN forhåndsregistrering -
 * bekreftet Google-dokumentert oppførsel. En "Web application"-klient
 * krever en EKSAKT forhåndsregistrert redirect-URI. At Tobias sin
 * eksisterende klient ga `redirect_uri_mismatch` for en loopback-URI er
 * derfor sterk evidens (ikke gjettet) for at den er registrert som "Web
 * application" - Jarvis sin lokale, interaktive eier-reauth-flyt er
 * NØYAKTIG scenarioet Google bygde "Desktop app"-klienttypen for.
 */
export class WrongOAuthClientTypeError extends Error {
  constructor(foundType: string) {
    super(
      `google_reauth_wrong_oauth_client_type: den valgte JSON-filen er en "${foundType}"-type OAuth-klient. ` +
        `Jarvis sin lokale nettleser-reauth krever en "Desktop app"-klient (loopback-redirect uten forhåndsregistrert ` +
        `port). Opprett en NY OAuth-klient av typen "Desktop app" i Google Cloud Console (APIs & Services > ` +
        `Credentials > Create Credentials > OAuth client ID > Desktop app), last ned JSON-en, og pek ` +
        `JARVIS_GOOGLE_CLIENT_SECRET_JSON til DEN filen i .env i stedet. .env er IKKE endret.`
    );
    this.name = "WrongOAuthClientTypeError";
  }
}

export class MalformedClientSecretJsonError extends Error {
  constructor(reason: string) {
    super(`google_reauth_malformed_client_secret_json: ${reason} - .env er IKKE endret.`);
    this.name = "MalformedClientSecretJsonError";
  }
}

export interface ParsedInstalledClientSecret {
  clientId: string;
  clientSecret: string;
}

/**
 * §6 i host-fix #2-ordren: Google sin STABILE, offisielle nedlastede
 * OAuth-klient-JSON-form (samme skjema alle google-auth-library-
 * quickstarts har brukt i årevis - ikke gjettet): toppnivånøkkelen er
 * `installed` for en "Desktop app"-klient, `web` for en "Web
 * application"-klient. Godtar KUN `installed` - en `web`-fil kastes
 * EKSPLISITT (samme brittleness som klienten Tobias allerede har, se
 * WrongOAuthClientTypeError over) i stedet for å stille prøve den og feile
 * likt igjen.
 */
export function parseClientSecretJson(raw: string): ParsedInstalledClientSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MalformedClientSecretJsonError("ugyldig JSON i JARVIS_GOOGLE_CLIENT_SECRET_JSON-fila");
  }
  const body = parsed as Record<string, unknown>;
  if (body["web"] && typeof body["web"] === "object") {
    throw new WrongOAuthClientTypeError("web");
  }
  const installed = body["installed"];
  if (!installed || typeof installed !== "object") {
    throw new MalformedClientSecretJsonError(
      'mangler "installed"-nøkkelen (verken "installed" eller "web" funnet - er dette en gyldig nedlastet OAuth-klient-JSON fra Google Cloud Console?)'
    );
  }
  const { client_id: clientId, client_secret: clientSecret } = installed as Record<string, unknown>;
  if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string" || !clientSecret) {
    throw new MalformedClientSecretJsonError('"installed".client_id/client_secret mangler eller er tomme i JSON-fila');
  }
  return { clientId, clientSecret };
}

const CLIENT_ID_PROJECT_NUMBER_PATTERN = /^(\d+)-/;

/**
 * Google OAuth-klient-IDer har den STABILE, offentlig kjente formen
 * `<prosjektnummer>-<random>.apps.googleusercontent.com` (ikke gjettet -
 * samme mønster synlig i ethvert Google API-eksempel/nedlastet
 * credentials.json). Returnerer undefined for en ID som ikke matcher
 * (fail-safe - ALDRI en gjettet/feil URL).
 */
export function deriveProjectNumberFromClientId(clientId: string): string | undefined {
  const match = CLIENT_ID_PROJECT_NUMBER_PATTERN.exec(clientId);
  return match ? match[1] : undefined;
}

/** §6.2 i ordren: direkte lenke til RIKTIG Google Cloud Console-side - Tobias skal ALDRI måtte navigere dit manuelt selv. */
export function buildCredentialsConsoleUrl(projectNumber: string | undefined): string {
  const base = "https://console.cloud.google.com/apis/credentials";
  return projectNumber ? `${base}?project=${projectNumber}` : base;
}

/**
 * HOST FIX #3 "ZERO MANUAL ENV EDITING" (2026-08-16): Tobias skal KUN gjøre
 * ÉN uunngåelig manuell handling (opprette en Desktop-klient i Cloud
 * Console og trykke "Download JSON") - ALDRI redigere `.env`, kopiere
 * client_id/client_secret, eller lime inn en filsti. Denne seksjonen er den
 * rene beslutnings-/filtreringslogikken bak "oppdag den nedlastede JSON-en
 * automatisk fra Nedlastinger-mappa" - selve filsystem-pollingen,
 * fil-lesingen og terminal-promptet bor i orchestratoren (samme
 * "ingen fs/nettverk i denne fila"-presedens som resten av fila).
 */
export interface DownloadCandidateFile {
  name: string;
  path: string;
  mtimeMs: number;
}

/**
 * §2 i ordren: KUN JSON-filer med mtime FRA OG MED kjøringens eget
 * starttidspunkt regnes som "nylig lastet ned" - en gammel, urelatert
 * JSON-fil som allerede lå i Nedlastinger FØR kjøringen startet skal
 * ALDRI plukkes opp automatisk (§2/§C i ordren). Nyest FØRST.
 */
export function selectNewCandidateJsonFiles(files: readonly DownloadCandidateFile[], sinceMs: number): DownloadCandidateFile[] {
  return files
    .filter((f) => f.name.toLowerCase().endsWith(".json") && f.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export type DesktopClientDiscoveryResult =
  | { kind: "none" }
  | { kind: "single"; candidate: DownloadCandidateFile }
  | { kind: "multiple"; candidates: DownloadCandidateFile[] };

/**
 * §4 i ordren: gitt filene som FAKTISK besto `parseClientSecretJson()`
 * (gyldig "installed"/Desktop-type - "web"-filer og søppel er allerede
 * silent utelatt av orchestratoren FØR denne kalles, se
 * `watchForDesktopClientDownload()`): ALDRI gjett stille ved flere gyldige
 * kandidater - `"multiple"` krever eksplisitt valg (nummerert
 * fil-navn-liste) i orchestratoren.
 */
export function classifyDiscoveryResult(validCandidates: readonly DownloadCandidateFile[]): DesktopClientDiscoveryResult {
  if (validCandidates.length === 0) return { kind: "none" };
  if (validCandidates.length === 1) return { kind: "single", candidate: validCandidates[0]! };
  return { kind: "multiple", candidates: [...validCandidates] };
}

/** §4 i ordren: trygg, KUN-filnavn nummerert liste - ALDRI client_id/client_secret eller full filsti (kan inneholde brukernavn). */
export function formatCandidateSelectionPrompt(names: readonly string[]): string {
  return names.map((name, i) => `  ${i + 1}) ${name}`).join("\n");
}

/** Validerer Tobias sitt tallvalg mot antall kandidater - undefined for et ugyldig/tomt svar (orchestratoren spør på nytt, kaster ALDRI en kryptisk NaN-indeksfeil). */
export function parseCandidateSelection(input: string, count: number): number | undefined {
  const n = Number(input.trim());
  if (!Number.isInteger(n) || n < 1 || n > count) return undefined;
  return n - 1;
}

/**
 * HOST FIX #5 "CLASSIFY REAL DRIVE 403 + AUTO-GUIDE" (2026-08-16): Desktop-
 * OAuth-bootstrappen er nå host-bevist FUNGERENDE (token-exchange lyktes,
 * scope-strengen så riktig ut) - blokkeringen er en 403 FRA selve Drive
 * `files/root`-proben. Google sin feilkropp-form (`{error:{code,message,
 * status,errors[],details[]}}`) er STABIL og IDENTISK på tvers av samtlige
 * Google Cloud/Workspace-API-er (bekreftet, ikke gjettet) - denne funksjonen
 * klassifiserer den, uten å noensinne anta MER presisjon enn Google faktisk
 * gir (se `WORKSPACE_ADMIN_POLICY`-kommentaren under for den ene bevisst
 * beste-innsats-grenen).
 */
export type DriveProbeBlocker = "API_NOT_ENABLED" | "INSUFFICIENT_SCOPE" | "WORKSPACE_ADMIN_POLICY" | "RATE_LIMIT" | "AUTH_INVALID" | "UNKNOWN_PROVIDER_403";

export interface DriveProbeErrorDetails {
  httpStatus: number;
  googleStatus: string | undefined;
  googleReason: string | undefined;
  serviceId: string | undefined;
  safeMessage: string;
  enableUrl: string | undefined;
  blocker: DriveProbeBlocker;
}

interface GoogleApiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ domain?: string; reason?: string; message?: string }>;
    details?: Array<{ reason?: string; domain?: string; metadata?: Record<string, string> }>;
  };
}

/**
 * Google sin klassiske "API ikke aktivert"-feilmelding inneholder BOKSTAVELIG
 * TALT en direkte "Enable"-lenke (`https://console.developers.google.com/
 * apis/api/<api>.googleapis.com/overview?project=<nummer>`) - ekstremt
 * velkjent, stabilt mønster på tvers av alle Google Cloud API-klientbiblioteker
 * (ikke gjettet). Foretrekkes FREMFOR å konstruere URL-en selv, siden Google
 * sin egen lenke garantert peker til RIKTIG prosjekt.
 */
const ENABLE_URL_PATTERN = /https:\/\/console\.developers\.google\.com\/apis\/api\/[^\s")]+/;

/** §1 i ordren: klassifiserer et Drive API-feilsvar - HTTP-status + Google sin egen error.status/error.reason/error.details. Kaster ALDRI (ugyldig/ikke-JSON-kropp -> tomt objekt, fortsatt en trygg klassifisering). Meldingen SANERES (avkortet til 300 tegn) - Google sin feilkropp inneholder ALDRI access/refresh-token/client_secret (de sendes kun i forespørselen, aldri ekko-et tilbake i en feilrespons), men avkortingen er et ekstra sikkerhetsnett for trygg logging uansett. */
export function classifyDriveProbeError(httpStatus: number, rawBody: string): DriveProbeErrorDetails {
  let parsed: GoogleApiErrorBody = {};
  try {
    parsed = JSON.parse(rawBody) as GoogleApiErrorBody;
  } catch {
    // Ikke-JSON-kropp (sjeldent) - fortsett med tomt objekt, ALDRI kast.
  }
  const error = parsed.error;
  const message = error?.message ?? "";
  const googleStatus = error?.status;
  const legacyReason = error?.errors?.[0]?.reason;
  const detail = error?.details?.find((d) => typeof d.reason === "string");
  const googleReason = detail?.reason ?? legacyReason;
  const serviceId = detail?.metadata?.["service"];
  const enableUrlMatch = ENABLE_URL_PATTERN.exec(message);
  const safeMessage = message.slice(0, 300);

  let blocker: DriveProbeBlocker;
  if (googleReason === "SERVICE_DISABLED" || googleReason === "accessNotConfigured" || /has not been used in project/i.test(message)) {
    blocker = "API_NOT_ENABLED";
  } else if (googleReason === "insufficientPermissions" || /insufficient authentication scopes/i.test(message)) {
    blocker = "INSUFFICIENT_SCOPE";
  } else if (httpStatus === 429 || googleReason === "rateLimitExceeded" || googleReason === "userRateLimitExceeded") {
    blocker = "RATE_LIMIT";
  } else if (httpStatus === 401 || googleReason === "authError") {
    blocker = "AUTH_INVALID";
  } else if (httpStatus === 403 && googleStatus === "PERMISSION_DENIED") {
    // §4 i ordren: BESTE-INNSATS, IKKE et Google-bekreftet unikt signal -
    // Google gir INGEN mer presist maskinlesbart tegn for "Workspace-
    // administrator har ikke tillatt denne appen/scopet" enn en generisk
    // PERMISSION_DENIED på dette tidspunktet i flyten (selve samtykke-
    // blokkeringen skjer normalt FØR token-exchange, ikke her) - dette er
    // likevel den mest sannsynlige forklaringen for AKKURAT dette
    // tidspunktet (token-exchange OG scope-streng begge allerede bekreftet
    // riktige), og eksplisitt navngitt sådan i loggen orchestratoren skriver.
    blocker = "WORKSPACE_ADMIN_POLICY";
  } else {
    blocker = "UNKNOWN_PROVIDER_403";
  }

  return { httpStatus, googleStatus, googleReason, serviceId, safeMessage, enableUrl: enableUrlMatch ? enableUrlMatch[0] : undefined, blocker };
}

/** Trygg, grep-bar diagnosetekst - ALDRI token/secret, kun de klassifiserte, ikke-sensitive feltene. */
export function formatDriveProbeReport(details: DriveProbeErrorDetails): string {
  return `google_drive_blocker=${details.blocker} http_status=${details.httpStatus} google_status=${details.googleStatus ?? "unknown"} google_reason=${details.googleReason ?? "unknown"} service=${details.serviceId ?? "unknown"}`;
}

/** §2 i ordren: fallback KUN hvis Google sin feilmelding IKKE inneholdt en direkte lenke (`enableUrl` i `DriveProbeErrorDetails`) - samme URL-mønster Google selv bruker, med prosjektnummer utledet fra OAuth-klienten når kjent. */
export function buildDriveApiEnableUrl(projectNumber: string | undefined): string {
  const base = "https://console.developers.google.com/apis/api/drive.googleapis.com/overview";
  return projectNumber ? `${base}?project=${projectNumber}` : base;
}

/** §4 i ordren: Google Workspace Admin Console sin generelle "Security > API controls"-landingsside - IKKE et forsøk på å dype-lenke til en spesifikk "trust this app"-underside (varierer med Workspace-utgave/UI-versjon - ingen gjetning av en uverifisert dypere sti). */
export const GOOGLE_ADMIN_API_CONTROLS_URL = "https://admin.google.com/ac/owl";

/** Kun de to blocker-typene et ETT klikk andre steder faktisk kan løse MENS denne prosessen venter - alle andre (feil scope, ugyldig token, rate-limit, ukjent) krever en helt ny flyt/en annen fiks, ikke gjentatt polling av AKKURAT samme kall. */
export function isRecoverableDriveProbeBlocker(blocker: DriveProbeBlocker): boolean {
  return blocker === "API_NOT_ENABLED" || blocker === "WORKSPACE_ADMIN_POLICY";
}

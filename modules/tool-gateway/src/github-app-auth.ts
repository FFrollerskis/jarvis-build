import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { UnsafeVendorUrlError, assertGithubRepoSlug, assertSafeVendorUrl, guardedFetch } from "./url-safety.ts";

/**
 * WP-C3 (Q-45 b / D-35 / D-450): GitHub App-autentisering - en BEDRE AUTENTISERINGSMETODE bak den eksisterende GitHub-adapteren
 * (`GithubTransport`), ikke en ny leverandør (CLAUDE.md regel 12: GitHub er allerede en akseptert connector, EXTERNAL_CANONICAL;
 * D-41 styrer fortsatt hvor FULL kapabiliteten er - denne filen endrer ingen risikoklasse og ingen handling).
 *
 * Flyten (verifisert mot offisiell dokumentasjon 2026-10-09: docs.github.com «Generating a JSON Web Token (JWT) for a GitHub App» og
 * «Generating an installation access token for a GitHub App», hentet fra github/docs-repoet):
 *   1. JWT, algoritme `RS256`, claims `iat` (anbefalt 60 s tilbake i tid mot klokkeskjev), `exp` (maks 10 min frem i tid) og `iss`
 *      (App-ens client-id ELLER app-id), signert med App-ens PRIVATNØKKEL (PEM, PKCS#1 slik GitHub laster den ned, eller PKCS#8).
 *   2. `POST {apiBase}/app/installations/{installation_id}/access_tokens` med `Authorization: Bearer <JWT>`. Valgfri kropp:
 *      `repositories` (repo-NAVN, maks 500) og `permissions` (nedskalering). Svar 201: `token`, `expires_at` (1 time frem), `permissions`,
 *      `repository_selection`, `repositories`. Dokumenterte feil: 401, 403, 404, 422.
 *   3. Installasjonstokenet brukes som vanlig `Bearer` mot REST/GraphQL og som HTTP-passord for git (`x-access-token:<token>`).
 *
 * Sikkerhetsegenskaper (alle dekket av tester i `test/wpc3-github-app-auth.test.ts`):
 *  - Tokenet er ALLTID repo-scopet: uten eksplisitt `repositories` brukes den konfigurerte standardlisten (`JARVIS_GITHUB_REPO` /
 *    `JARVIS_GIT_ALLOWED_REPOS`); finnes ingen liste feiler utstedelsen lukket (`GITHUB_APP_SCOPE_UNDEFINED`) - ALDRI «alle repoer i
 *    installasjonen». Svaret kontrolleres mot det som ble forespurt (leverandøren kan ikke utvide scopet stille).
 *  - Privatnøkkelen leses fra vaulten ved HVER signering og holdes aldri i langlevd minne; avvises hvis den ikke er RSA, er < 2048 bit,
 *    er passordbeskyttet eller ikke kan tolkes. JWT, privatnøkkel og token havner aldri i logg, feilmeldinger, `toJSON()` eller status.
 *  - Utgående kall går via `guardedFetch` (D-436: rå-URL-sjekk + timeout). API-basen må være https (unntak kun `http://127.0.0.1` via et
 *    eksplisitt TESTFLAGG i koden - det finnes ingen miljøvariabel som kan slå det på).
 *  - Fornyelse: cache til 5 min før `expires_at`, én felles pågående utstedelse per scope (single-flight), eksponentiell backoff på
 *    5xx/rate limit (respekterer `Retry-After`), kort fail-fast etter en feil (ingen hamring), og et fortsatt gyldig token brukes videre
 *    hvis fornyelsen feiler. Klokkeskjev rettes opp fra `Date`-headeren i GitHub sine svar (én umiddelbar gjentakelse ved 401).
 */

export const DEFAULT_GITHUB_API_BASE = "https://api.github.com";
/** Vault-/SecretProvider-referansen for App-ens privatnøkkel (PEM). Flerlinje-PEM hører hjemme i vaulten, aldri som vanlig env-verdi i compose. */
export const GITHUB_APP_PRIVATE_KEY_REF = "JARVIS_GITHUB_APP_PRIVATE_KEY";
const GITHUB_API_VERSION = "2022-11-28";

/** GitHub: «iat ... we recommend that you set this 60 seconds in the past»; «exp ... no more than 10 minutes into the future». */
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 9 * 60;
/** Cache gjelder til 5 min før `expires_at` (oppgaven); deretter fornyes tokenet. */
export const GITHUB_APP_REFRESH_MARGIN_MS = 5 * 60_000;
/** Bruker et fortsatt gyldig, cachet token videre når fornyelsen feiler - men aldri et som utløper om mindre enn dette. */
const STALE_GRACE_MIN_REMAINING_MS = 30_000;
const MAX_INLINE_WAIT_MS = 30_000;
const BASE_BACKOFF_MS = 500;
const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;
const MAX_REPOSITORIES = 500;
/** GitHub gir 1 time; vi cacher aldri lenger enn dette selv om et svar påstår noe annet. */
const MAX_TOKEN_LIFETIME_MS = 65 * 60_000;
/** Klokkeavvik under dette ignoreres (Date-headeren har 1 s oppløsning); over korrigeres JWT-tidene. */
const SKEW_THRESHOLD_MS = 5_000;
const SKEW_MAX_MS = 24 * 3_600_000;
const RECENT_TOKEN_MEMORY = 20;
const RECENT_TOKEN_TTL_MS = 3 * 3_600_000;

export type GitHubAppAuthErrorCode =
  | "GITHUB_APP_NOT_CONFIGURED"
  | "GITHUB_APP_CONFIG_INVALID"
  | "GITHUB_APP_SCOPE_UNDEFINED"
  | "GITHUB_APP_KEY_MISSING"
  | "GITHUB_APP_KEY_INVALID"
  | "GITHUB_APP_AUTH_FAILED"
  | "GITHUB_APP_INSTALLATION_NOT_FOUND"
  | "GITHUB_APP_INSTALLATION_SUSPENDED"
  | "GITHUB_APP_FORBIDDEN"
  | "GITHUB_APP_REQUEST_REJECTED"
  | "GITHUB_APP_SCOPE_MISMATCH"
  | "GITHUB_APP_RATE_LIMITED"
  | "GITHUB_APP_UNAVAILABLE"
  | "GITHUB_APP_RESPONSE_INVALID"
  | "GITHUB_TOKEN_UNAVAILABLE";

/** Norsk, eier-vendt forklaring + tiltak per feilkategori (brukes av akseptansescriptet og runbooken - aldri en hemmelighet). */
export const GITHUB_APP_ERROR_HINTS: Readonly<Record<GitHubAppAuthErrorCode, string>> = {
  GITHUB_APP_NOT_CONFIGURED: "GitHub App er ikke konfigurert (JARVIS_GITHUB_APP_ID og JARVIS_GITHUB_APP_INSTALLATION_ID mangler).",
  GITHUB_APP_CONFIG_INVALID: "Ugyldig App-konfig (App-id, installasjons-id eller API-base). Sjekk .env - API-basen må være https.",
  GITHUB_APP_SCOPE_UNDEFINED: "Ingen repo er konfigurert som scope. Sett JARVIS_GITHUB_REPO (eller JARVIS_GIT_ALLOWED_REPOS) - Jarvis ber aldri om «alle repoer i installasjonen».",
  GITHUB_APP_KEY_MISSING: "Privatnøkkelen JARVIS_GITHUB_APP_PRIVATE_KEY finnes ikke i vaulten. Lagre PEM-filen i Infisical (eller dashbordet).",
  GITHUB_APP_KEY_INVALID: "Privatnøkkelen kan ikke brukes (må være en ukryptert RSA-nøkkel på minst 2048 bit i PEM-format).",
  GITHUB_APP_AUTH_FAILED: "GitHub avviste App-JWT-en (401). Feil App-id, feil/slettet privatnøkkel, eller for stort klokkeavvik på verten.",
  GITHUB_APP_INSTALLATION_NOT_FOUND: "Installasjonen finnes ikke for denne App-en (404). Sjekk JARVIS_GITHUB_APP_INSTALLATION_ID og at App-en er installert.",
  GITHUB_APP_INSTALLATION_SUSPENDED: "Installasjonen er suspendert på GitHub. Opphev suspensjonen i installasjonsinnstillingene.",
  GITHUB_APP_FORBIDDEN: "GitHub nektet utstedelse av installasjonstoken (403).",
  GITHUB_APP_REQUEST_REJECTED: "GitHub avviste forespørselen (422/4xx): repoene eller rettighetene er ikke gitt til installasjonen. Utvid installasjonen eller App-rettighetene.",
  GITHUB_APP_SCOPE_MISMATCH: "Tokenet dekket ikke nøyaktig det som ble forespurt (repoer/rettigheter) og ble avvist.",
  GITHUB_APP_RATE_LIMITED: "GitHub rate limit ved utstedelse av token. Prøver igjen etter Retry-After.",
  GITHUB_APP_UNAVAILABLE: "GitHub svarte ikke (nettverk/timeout/5xx) etter flere forsøk.",
  GITHUB_APP_RESPONSE_INVALID: "GitHub sendte et svar Jarvis ikke kan stole på (manglende/ugyldig token eller utløpstid).",
  GITHUB_TOKEN_UNAVAILABLE: "Ingen GitHub-credential er tilgjengelig (verken installasjonstoken eller PAT)."
};

/**
 * Normalisert feil UTEN hemmeligheter: meldingen er alltid `<KODE>:<kort, maskert detalj>`, aldri en rå leverandørkropp, aldri JWT/nøkkel/token.
 * `cause` settes bevisst ikke (en underliggende feil kan bære URL-er/headere).
 */
export class GitHubAppAuthError extends Error {
  readonly code: GitHubAppAuthErrorCode;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;

  constructor(code: GitHubAppAuthErrorCode, detail: string, options: { httpStatus?: number; retryAfterMs?: number; retryable?: boolean } = {}) {
    super(`${code}:${safeDetail(detail)}`);
    this.name = "GitHubAppAuthError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable = options.retryable ?? false;
  }

  toJSON(): { name: string; code: GitHubAppAuthErrorCode; http_status: number | null; message: string } {
    return { name: this.name, code: this.code, http_status: this.httpStatus, message: this.message };
  }
}

export function asGitHubAppAuthError(err: unknown): GitHubAppAuthError {
  if (err instanceof GitHubAppAuthError) return err;
  // Ukjent feiltype: aldri videresend rå melding (kan bære hemmeligheter) - kun feilklassen.
  return new GitHubAppAuthError("GITHUB_APP_UNAVAILABLE", `unexpected_${err instanceof Error ? err.name : "error"}`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Maskering
// ---------------------------------------------------------------------------------------------------------------------------------

const PEM_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
// ghs_/ghp_/gho_/ghu_/ghr_ (klassisk 40 tegn OG det nye statuløse formatet `ghs_<APPID>_<JWT>` - lengden skal aldri antas) + fine-grained PAT.
const TOKEN_PATTERN = /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9_.-]{12,}|github_pat_[A-Za-z0-9_]{12,})/g;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const BEARER_PATTERN = /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi;

/** Fjerner alt som ligner PEM-privatnøkkel, GitHub-token, JWT eller Bearer-verdi - pluss eksakte kjente hemmeligheter. */
export function maskGitHubSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 8) out = out.split(secret).join("[REDACTED]");
  }
  return out
    .replace(PEM_PATTERN, "[REDACTED_KEY]")
    .replace(TOKEN_PATTERN, "[REDACTED_TOKEN]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(BEARER_PATTERN, "$1 [REDACTED]");
}

/** Kort, enlinjes, maskert tekst som trygt kan inngå i en feilmelding/logg. */
function safeDetail(text: string, max = 160): string {
  let out = "";
  // Begrens kostnaden mot et ondsinnet, kjempestort svar FØR maskeringen; selve resultatet kuttes til `max` etterpå.
  for (const ch of maskGitHubSecrets(String(text).slice(0, 65_536))) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Privatnøkkel og JWT
// ---------------------------------------------------------------------------------------------------------------------------------

const keyInvalid = (reason: string): GitHubAppAuthError => new GitHubAppAuthError("GITHUB_APP_KEY_INVALID", reason);
const configInvalid = (reason: string): GitHubAppAuthError => new GitHubAppAuthError("GITHUB_APP_CONFIG_INVALID", reason);

const MAX_KEY_INPUT_CHARS = 16_384;

/**
 * Gjør en lagret nøkkelverdi om til kanonisk PEM. Vaulten, dashbordets enlinjes passordfelt og `.env` leverer nøkkelen i ulike former,
 * og et flerlinje-PEM mister linjeskiftene sine overalt unntatt i selve vaulten - derfor tåler vi: (1) ekte PEM, (2) bokstavelige `\n`,
 * (3) linjeskift som er blitt mellomrom/fjernet, (4) hele PEM-filen base64-kodet på én linje (`base64 -w0 nøkkel.pem`), (5) omsluttende
 * anførselstegn. Kun ukrypterte `RSA PRIVATE KEY` (PKCS#1, slik GitHub laster ned) og `PRIVATE KEY` (PKCS#8) godtas.
 */
export function normalizeGitHubAppPrivateKey(raw: string): string {
  if (typeof raw !== "string") throw keyInvalid("not_a_string");
  let text = raw.trim();
  if (text.length === 0) throw keyInvalid("empty");
  if (text.length > MAX_KEY_INPUT_CHARS) throw keyInvalid("too_long");
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1).trim();
  text = text.replace(/\\r\\n|\\n|\\r/g, "\n");
  if (!text.includes("-----BEGIN")) {
    const compact = text.replace(/\s+/g, "");
    if (compact.length >= 64 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) {
      const decoded = Buffer.from(compact, "base64").toString("utf8");
      if (decoded.includes("-----BEGIN")) text = decoded.trim();
    }
  }
  const match = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!match) throw keyInvalid("no_pem_block");
  const label = match[1] as string;
  if (label === "ENCRYPTED PRIVATE KEY") throw keyInvalid("encrypted");
  if (label !== "RSA PRIVATE KEY" && label !== "PRIVATE KEY") throw keyInvalid("unsupported_format");
  const rawBody = match[2] as string;
  if (/Proc-Type:|DEK-Info:/i.test(rawBody)) throw keyInvalid("encrypted");
  const body = rawBody.replace(/\s+/g, "");
  if (body.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw keyInvalid("bad_base64");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** Tolker og validerer nøkkelen: RSA, minst 2048 bit. Kaster `GITHUB_APP_KEY_INVALID` (aldri med nøkkelmateriale i meldingen). */
export function parseGitHubAppPrivateKey(raw: string): KeyObject {
  const pem = normalizeGitHubAppPrivateKey(raw);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw keyInvalid("unparseable");
  }
  if (key.asymmetricKeyType !== "rsa") throw keyInvalid("not_rsa");
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (typeof bits !== "number" || bits < 2048) throw keyInvalid("too_small");
  if (bits > 16_384) throw keyInvalid("too_large");
  return key;
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

/**
 * App-JWT (RS256). `iat` = nå - 60 s, `exp` = nå + 9 min (GitHub tillater maks 10), `iss` = App-id/client-id. Eksportert for tester og for
 * akseptansescriptet; produksjonskoden går via `GitHubAppAuth`.
 */
export function createGitHubAppJwt(key: KeyObject, issuer: string, nowMs: number): string {
  const nowSeconds = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - JWT_BACKDATE_S, exp: nowSeconds + JWT_LIFETIME_S, iss: issuer }));
  let signature: Buffer;
  try {
    signature = sign("sha256", Buffer.from(`${header}.${payload}`), key);
  } catch {
    throw keyInvalid("signing_failed");
  }
  return `${header}.${payload}.${base64url(signature)}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Konfig
// ---------------------------------------------------------------------------------------------------------------------------------

const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INSTALLATION_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

/** App-id (numerisk) ELLER client-id (`Iv1.…`/`Iv23…`) - GitHub godtar begge som `iss`, og anbefaler client-id. */
export const isValidGitHubAppId = (value: string): boolean => APP_ID_PATTERN.test(value);
export const isValidGitHubInstallationId = (value: string): boolean => INSTALLATION_ID_PATTERN.test(value);

/**
 * `https://host[:port][/sti]` uten brukerinfo/query/fragment. Den RÅ strengen valideres først med samme vakt som alle utgående leverandørkall
 * (`assertSafeVendorUrl`: ingen `.`/`..`/`%2e`-segmenter, ingen stille URL-normalisering), deretter https-/vertsreglene her.
 * Loopback-http kun når testflagget er satt (aldri fra miljøet).
 */
export function normalizeGitHubApiBase(raw: string | undefined, allowLoopbackHttpForTests = false): string {
  const value = (raw ?? "").trim() === "" ? DEFAULT_GITHUB_API_BASE : (raw as string).trim();
  if (/[\\\s]/.test(value) || value.length > 200) throw configInvalid("api_base_malformed");
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) throw configInvalid("api_base_malformed");
  }
  try {
    assertSafeVendorUrl(value);
  } catch (err) {
    throw configInvalid(err instanceof UnsafeVendorUrlError ? `api_base_unsafe:${err.reason}` : "api_base_not_a_url");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configInvalid("api_base_not_a_url");
  }
  if (url.username !== "" || url.password !== "") throw configInvalid("api_base_has_credentials");
  if (url.search !== "" || url.hash !== "") throw configInvalid("api_base_has_query");
  const isLoopbackHttp = url.protocol === "http:" && url.hostname === "127.0.0.1";
  if (isLoopbackHttp) {
    if (!allowLoopbackHttpForTests) throw configInvalid("api_base_must_be_https");
  } else {
    if (url.protocol !== "https:") throw configInvalid("api_base_must_be_https");
    const host = url.hostname.toLowerCase();
    // IP-literaler og lokale navn har ikke noe på en offentlig GitHub-API-base å gjøre (JWT-en ville gått til feil mottaker).
    if (host === "localhost" || host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.endsWith(".local") || !host.includes(".")) {
      throw configInvalid("api_base_host_not_allowed");
    }
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

interface RepoRef {
  readonly name: string;
  readonly owner: string | undefined;
}

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

function parseRepoRef(raw: unknown): RepoRef {
  if (typeof raw !== "string") throw configInvalid("repository_invalid");
  const value = raw.trim();
  if (value.includes("/")) {
    try {
      assertGithubRepoSlug(value);
    } catch {
      throw configInvalid("repository_invalid");
    }
    const [owner, name] = value.split("/") as [string, string];
    return { owner, name };
  }
  if (!REPO_NAME.test(value) || value === "." || value === ".." || value.startsWith("-")) throw configInvalid("repository_invalid");
  return { owner: undefined, name: value };
}

export type GitHubPermissionLevel = "read" | "write" | "admin";
export type GitHubPermissionRequest = Readonly<Record<string, GitHubPermissionLevel>>;

const PERMISSION_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const PERMISSION_RANK: Readonly<Record<string, number>> = { read: 1, write: 2, admin: 3 };

function normalizePermissions(raw: GitHubPermissionRequest | undefined): Record<string, GitHubPermissionLevel> | undefined {
  if (raw === undefined) return undefined;
  const entries = Object.entries(raw);
  if (entries.length === 0) return undefined;
  const out: Record<string, GitHubPermissionLevel> = {};
  for (const [name, level] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!PERMISSION_NAME.test(name) || (level !== "read" && level !== "write" && level !== "admin")) throw configInvalid("permission_invalid");
    out[name] = level;
  }
  return out;
}

/** Offentlig, hemmelighetsfri metadata om et utstedt installasjonstoken (aldri selve verdien). */
export interface GitHubTokenInfo {
  readonly issued_at: string;
  readonly expires_at: string;
  readonly repository_selection: "selected" | "all";
  readonly repositories: readonly string[];
  readonly permissions: Readonly<Record<string, string>>;
}

export interface GitHubInstallationInfo {
  readonly id: string;
  readonly account: string | null;
  readonly account_type: string | null;
  readonly repository_selection: "selected" | "all";
  readonly permissions: Readonly<Record<string, string>>;
  readonly suspended: boolean;
  readonly checked_at: string;
}

export interface GitHubTokenScope {
  /** Repo-navn eller `owner/navn`. Utelatt = konfigurert standardliste (aldri «alle»). */
  readonly repositories?: readonly string[] | undefined;
  /** Valgfri nedskalering. Utelatt = alle rettigheter installasjonen er gitt. */
  readonly permissions?: GitHubPermissionRequest | undefined;
}

export type GitHubAuthLogEvent = { readonly level: "info" | "warn" | "error"; readonly msg: string } & Readonly<Record<string, string | number | boolean | null>>;

export interface GitHubAppAuthOptions {
  readonly appId: string;
  readonly installationId: string;
  /** Leser PEM fra vaulten ved HVER signering. `null`/tom = nøkkelen mangler. */
  readonly privateKey: () => Promise<string | null | undefined>;
  readonly apiBase?: string | undefined;
  /** Standard-scope (repo-navn eller `owner/navn`). Påkrevd for utstedelse uten eksplisitt scope. */
  readonly repositories?: readonly string[] | undefined;
  /** Valgfri nedskalering av standard-scopet. */
  readonly permissions?: GitHubPermissionRequest | undefined;
  /** Injiserbar HTTP (tester). Standard: `guardedFetch`. */
  readonly http?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly random?: (() => number) | undefined;
  readonly log?: ((event: GitHubAuthLogEvent) => void) | undefined;
  readonly maxAttempts?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  /** Øvre grense for hele utstedelsen (alle forsøk + ventetid). */
  readonly deadlineMs?: number | undefined;
  readonly refreshMarginMs?: number | undefined;
  /** KUN TEST: tillat `http://127.0.0.1:<port>` som API-base. Kan ikke settes fra miljøet. */
  readonly allowLoopbackHttpForTests?: boolean | undefined;
}

interface NormalizedScope {
  readonly key: string;
  readonly repositories: readonly RepoRef[];
  readonly permissions: Record<string, GitHubPermissionLevel> | undefined;
}

interface CacheEntry {
  readonly token: string;
  readonly expiresAtLocalMs: number;
  readonly issuedAtLocalMs: number;
  readonly info: GitHubTokenInfo;
}

export interface GitHubAppAuthState {
  readonly app_id: string;
  readonly installation_id: string;
  readonly api_base: string;
  readonly configured_repositories: readonly string[];
  /** Metadata for det cachede standard-scope-tokenet (kun hvis det fortsatt er gyldig). Aldri selve verdien. */
  readonly token: GitHubTokenInfo | null;
  readonly installation: GitHubInstallationInfo | null;
  readonly last_error: { readonly code: GitHubAppAuthErrorCode; readonly at: string; readonly http_status: number | null } | null;
  readonly consecutive_failures: number;
  readonly clock_skew_ms: number;
}

const isTimeoutLike = (err: unknown): boolean => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (value.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

function errorMessageOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : "";
  } catch {
    return "";
  }
}

function cooldownMsFor(err: GitHubAppAuthError): number {
  switch (err.code) {
    case "GITHUB_APP_RATE_LIMITED":
      return Math.min(Math.max(err.retryAfterMs ?? 60_000, 10_000), 600_000);
    case "GITHUB_APP_UNAVAILABLE":
      return 10_000;
    case "GITHUB_APP_AUTH_FAILED":
    case "GITHUB_APP_INSTALLATION_NOT_FOUND":
    case "GITHUB_APP_INSTALLATION_SUSPENDED":
    case "GITHUB_APP_FORBIDDEN":
    case "GITHUB_APP_REQUEST_REJECTED":
    case "GITHUB_APP_SCOPE_MISMATCH":
    case "GITHUB_APP_RESPONSE_INVALID":
      return 5_000;
    default:
      // Lokale konfig-/nøkkelfeil: ingen nettverkskall er gjort, og eieren skal kunne rette opp og prøve igjen umiddelbart.
      return 0;
  }
}

export class GitHubAppAuth {
  readonly #appId: string;
  readonly #installationId: string;
  readonly #apiBase: string;
  readonly #readKey: () => Promise<string | null | undefined>;
  readonly #defaultRepositories: readonly RepoRef[];
  readonly #defaultPermissions: Record<string, GitHubPermissionLevel> | undefined;
  readonly #http: (url: string, init: RequestInit) => Promise<Response>;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #emit: (event: GitHubAuthLogEvent) => void;
  readonly #maxAttempts: number;
  readonly #requestTimeoutMs: number;
  readonly #deadlineMs: number;
  readonly #refreshMarginMs: number;

  readonly #cache = new Map<string, CacheEntry>();
  readonly #flights = new Map<string, Promise<CacheEntry>>();
  readonly #cooldowns = new Map<string, { untilMs: number; error: GitHubAppAuthError }>();
  readonly #recentTokens = new Map<string, number>();
  readonly #lastLogAt = new Map<string, number>();
  #defaultScopeKey: string | null = null;
  #installation: GitHubInstallationInfo | null = null;
  #lastError: { code: GitHubAppAuthErrorCode; at: string; http_status: number | null } | null = null;
  #consecutiveFailures = 0;
  #skewMs = 0;

  constructor(options: GitHubAppAuthOptions) {
    if (!APP_ID_PATTERN.test(options.appId)) throw configInvalid("app_id_invalid");
    if (!INSTALLATION_ID_PATTERN.test(options.installationId)) throw configInvalid("installation_id_invalid");
    this.#appId = options.appId;
    this.#installationId = options.installationId;
    this.#apiBase = normalizeGitHubApiBase(options.apiBase, options.allowLoopbackHttpForTests === true);
    this.#readKey = options.privateKey;
    this.#defaultRepositories = (options.repositories ?? []).map(parseRepoRef);
    if (this.#defaultRepositories.length > MAX_REPOSITORIES) throw configInvalid("too_many_repositories");
    this.#defaultPermissions = normalizePermissions(options.permissions);
    this.#http = options.http ?? ((url, init) => guardedFetch(url, init));
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
    this.#emit = options.log ?? defaultGitHubAuthLog;
    this.#maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
    this.#deadlineMs = options.deadlineMs ?? 20_000;
    this.#refreshMarginMs = options.refreshMarginMs ?? GITHUB_APP_REFRESH_MARGIN_MS;
  }

  get appId(): string { return this.#appId; }
  get installationId(): string { return this.#installationId; }
  get apiBase(): string { return this.#apiBase; }
  /** Standard-scope slik det er konfigurert (repo-navn eller `owner/navn`). */
  get defaultRepositories(): readonly string[] {
    return this.#defaultRepositories.map((r) => (r.owner ? `${r.owner}/${r.name}` : r.name));
  }

  // ---- offentlig API ------------------------------------------------------------------------------------------------------------

  /** Kun tokenverdien (til transportlaget). Standard-scope hvis intet annet er oppgitt. */
  async token(scope?: GitHubTokenScope): Promise<string> {
    return (await this.#issue(scope)).token;
  }

  /** Token + hemmelighetsfri metadata. */
  async issue(scope?: GitHubTokenScope): Promise<{ readonly token: string; readonly info: GitHubTokenInfo }> {
    const entry = await this.#issue(scope);
    return { token: entry.token, info: entry.info };
  }

  /** Hemmelighetsfri status uten nettverkskall. */
  state(): GitHubAppAuthState {
    const now = this.#now();
    const cached = this.#defaultScopeKey ? this.#cache.get(this.#defaultScopeKey) : undefined;
    return {
      app_id: this.#appId,
      installation_id: this.#installationId,
      api_base: this.#apiBase,
      configured_repositories: this.defaultRepositories,
      token: cached && cached.expiresAtLocalMs > now ? cached.info : null,
      installation: this.#installation,
      last_error: this.#lastError,
      consecutive_failures: this.#consecutiveFailures,
      clock_skew_ms: this.#skewMs
    };
  }

  /** Verdier som skal maskeres hvis de skulle dukke opp i tekst (nylig utstedte tokens). Aldri til logg/modell - kun til redaksjon. */
  knownTokens(): string[] {
    const now = this.#now();
    for (const [token, until] of this.#recentTokens) if (until <= now) this.#recentTokens.delete(token);
    return [...this.#recentTokens.keys()];
  }

  /** 401 fra GitHub med et token vi selv utstedte: forkast tokens eldre enn 15 s slik at neste kall utsteder et nytt (revokert/ugyldiggjort). */
  noteUnauthorized(): void {
    const now = this.#now();
    for (const [key, entry] of this.#cache) if (now - entry.issuedAtLocalMs > 15_000) this.#cache.delete(key);
  }

  /** Glem alle cachede tokens (f.eks. etter nøkkelrotasjon). */
  invalidate(): void {
    this.#cache.clear();
    this.#cooldowns.clear();
  }

  /** `GET /app/installations/{id}` med App-JWT: installasjonens egne innstillinger (repoutvalg, rettigheter, suspensjon). Kun JWT - ingen token utstedes. */
  async inspectInstallation(): Promise<GitHubInstallationInfo> {
    const key = await this.#loadKey();
    const result = await this.#requestWithJwt("GET", `/app/installations/${this.#installationId}`, undefined, key);
    const json = asRecord(result.json);
    const account = asRecord(json?.["account"]);
    const selection = json?.["repository_selection"];
    if (!json || (selection !== "selected" && selection !== "all")) throw new GitHubAppAuthError("GITHUB_APP_RESPONSE_INVALID", "installation_shape");
    const info: GitHubInstallationInfo = {
      id: String(json["id"] ?? this.#installationId).slice(0, 20),
      account: typeof account?.["login"] === "string" ? safeDetail(account["login"], 100) : null,
      account_type: typeof account?.["type"] === "string" ? safeDetail(account["type"], 40) : null,
      repository_selection: selection,
      permissions: sanitizePermissions(json["permissions"]),
      suspended: typeof json["suspended_at"] === "string" && json["suspended_at"] !== "",
      checked_at: new Date(this.#now()).toISOString()
    };
    this.#installation = info;
    return info;
  }

  /** `GET /app/installations` med App-JWT - hjelper eieren å finne installasjons-id-en. */
  async listInstallations(): Promise<Array<{ id: string; account: string | null; repository_selection: string; suspended: boolean }>> {
    const key = await this.#loadKey();
    const result = await this.#requestWithJwt("GET", "/app/installations?per_page=100", undefined, key);
    if (!Array.isArray(result.json)) throw new GitHubAppAuthError("GITHUB_APP_RESPONSE_INVALID", "installations_shape");
    return result.json.slice(0, 100).map((raw: unknown) => {
      const item = asRecord(raw);
      const account = asRecord(item?.["account"]);
      return {
        id: String(item?.["id"] ?? "").slice(0, 20),
        account: typeof account?.["login"] === "string" ? safeDetail(account["login"], 100) : null,
        repository_selection: typeof item?.["repository_selection"] === "string" ? safeDetail(item["repository_selection"], 20) : "unknown",
        suspended: typeof item?.["suspended_at"] === "string" && item["suspended_at"] !== ""
      };
    });
  }

  /** `DELETE /installation/token` (godkjent av selve tokenet): ugyldiggjør et installasjonstoken umiddelbart. Idempotent (401 = allerede ugyldig). */
  async revoke(token: string): Promise<void> {
    let response: Response;
    try {
      response = await this.#http(`${this.#apiBase}/installation/token`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "jarvis", "x-github-api-version": GITHUB_API_VERSION },
        signal: AbortSignal.timeout(this.#requestTimeoutMs)
      });
    } catch (err) {
      if (err instanceof UnsafeVendorUrlError) throw configInvalid(`api_base_unsafe:${err.reason}`);
      throw new GitHubAppAuthError("GITHUB_APP_UNAVAILABLE", isTimeoutLike(err) ? "timeout" : "network_error", { retryable: true });
    }
    await response.text().catch(() => "");
    if (response.status === 204 || response.status === 401) {
      for (const [key, entry] of this.#cache) if (entry.token === token) this.#cache.delete(key);
      return;
    }
    throw new GitHubAppAuthError("GITHUB_APP_REQUEST_REJECTED", `revoke_http_${response.status}`, { httpStatus: response.status });
  }

  // ---- utstedelse ---------------------------------------------------------------------------------------------------------------

  async #issue(scope: GitHubTokenScope | undefined): Promise<CacheEntry> {
    let normalized: NormalizedScope;
    try {
      normalized = this.#normalizeScope(scope);
    } catch (err) {
      // Ingen scope å be om (typisk: JARVIS_GITHUB_REPO mangler) - lokal konfigfeil, men like synlig som en leverandørfeil.
      throw this.#recordFailure(err, null);
    }
    if (scope === undefined || (scope.repositories === undefined && scope.permissions === undefined)) this.#defaultScopeKey = normalized.key;
    const now = this.#now();
    const cached = this.#cache.get(normalized.key);
    if (cached && cached.expiresAtLocalMs - this.#refreshMarginMs > now) return cached;
    // Et token som fortsatt er gyldig (men er inne i fornyelsesvinduet) brukes videre hvis fornyelsen feiler.
    const usable = cached !== undefined && cached.expiresAtLocalMs - STALE_GRACE_MIN_REMAINING_MS > now ? cached : undefined;

    const cooling = this.#cooldowns.get(normalized.key);
    if (cooling && cooling.untilMs > now) {
      if (usable) return usable;
      throw cooling.error;
    }

    let flight = this.#flights.get(normalized.key);
    if (!flight) {
      flight = this.#mintAndStore(normalized).finally(() => { this.#flights.delete(normalized.key); });
      this.#flights.set(normalized.key, flight);
    }
    try {
      return await flight;
    } catch (err) {
      // Fornyelsen feilet, men vi har et token som fortsatt er gyldig: bruk det videre (feilen er allerede registrert og logget).
      if (usable) return usable;
      throw err;
    }
  }

  #normalizeScope(scope: GitHubTokenScope | undefined): NormalizedScope {
    const refs = scope?.repositories !== undefined ? scope.repositories.map(parseRepoRef) : this.#defaultRepositories;
    if (refs.length === 0) {
      throw new GitHubAppAuthError("GITHUB_APP_SCOPE_UNDEFINED", "no_repository_scope_configured");
    }
    if (refs.length > MAX_REPOSITORIES) throw configInvalid("too_many_repositories");
    const seen = new Set<string>();
    const unique: RepoRef[] = [];
    for (const ref of refs) {
      const id = `${ref.owner ? `${ref.owner}/` : ""}${ref.name}`.toLowerCase();
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(ref);
      }
    }
    const permissions = scope?.permissions !== undefined ? normalizePermissions(scope.permissions) : this.#defaultPermissions;
    const key = JSON.stringify({ r: [...seen].sort(), p: permissions ? Object.entries(permissions) : null });
    return { key, repositories: unique, permissions };
  }

  async #mintAndStore(scope: NormalizedScope): Promise<CacheEntry> {
    try {
      const entry = await this.#mint(scope);
      this.#cache.set(scope.key, entry);
      this.#cooldowns.delete(scope.key);
      this.#lastError = null;
      this.#consecutiveFailures = 0;
      this.#rememberToken(entry.token, entry.expiresAtLocalMs);
      this.#log({
        level: "info", msg: "github_app_token_issued", expires_at: entry.info.expires_at, repository_count: entry.info.repositories.length,
        repository_selection: entry.info.repository_selection, permissions: Object.keys(entry.info.permissions).sort().join(",")
      }, `ok:${scope.key}`, 300_000);
      return entry;
    } catch (err) {
      throw this.#recordFailure(err, scope.key);
    }
  }

  /** Registrerer feilen i status, setter evt. kort fail-fast-vindu og logger (hemmelighetsfritt, maks én linje per kode per minutt). */
  #recordFailure(err: unknown, scopeKey: string | null): GitHubAppAuthError {
    const error = asGitHubAppAuthError(err);
    this.#lastError = { code: error.code, at: new Date(this.#now()).toISOString(), http_status: error.httpStatus };
    this.#consecutiveFailures += 1;
    const cooldown = cooldownMsFor(error);
    if (scopeKey !== null && cooldown > 0) this.#cooldowns.set(scopeKey, { untilMs: this.#now() + cooldown, error });
    this.#log({ level: "error", msg: "github_app_auth_failed", code: error.code, http_status: error.httpStatus, retryable: error.retryable }, `fail:${error.code}`, 60_000);
    return error;
  }

  async #mint(scope: NormalizedScope): Promise<CacheEntry> {
    const key = await this.#loadKey();
    const body = JSON.stringify({
      repositories: scope.repositories.map((r) => r.name),
      ...(scope.permissions ? { permissions: scope.permissions } : {})
    });
    const result = await this.#requestWithJwt("POST", `/app/installations/${this.#installationId}/access_tokens`, body, key);
    return this.#parseTokenResponse(result.json, scope);
  }

  async #loadKey(): Promise<KeyObject> {
    let raw: string | null | undefined;
    try {
      raw = await this.#readKey();
    } catch {
      throw new GitHubAppAuthError("GITHUB_APP_KEY_MISSING", "key_source_error");
    }
    if (typeof raw !== "string" || raw.trim() === "") throw new GitHubAppAuthError("GITHUB_APP_KEY_MISSING", "no_key_in_vault");
    return parseGitHubAppPrivateKey(raw);
  }

  #parseTokenResponse(json: unknown, scope: NormalizedScope): CacheEntry {
    const body = asRecord(json);
    const invalid = (reason: string): GitHubAppAuthError => new GitHubAppAuthError("GITHUB_APP_RESPONSE_INVALID", reason);
    if (!body) throw invalid("not_an_object");
    const token = body["token"];
    // Ikke anta 40 tegn: fra april 2026 innføres det statuløse formatet `ghs_<APPID>_<JWT>`. Kun «ett printbart ord uten mellomrom».
    if (typeof token !== "string" || !/^[!-~]{16,8192}$/.test(token)) throw invalid("token_missing_or_malformed");
    const expiresIso = body["expires_at"];
    const expiresServerMs = typeof expiresIso === "string" ? Date.parse(expiresIso) : Number.NaN;
    if (!Number.isFinite(expiresServerMs)) throw invalid("expires_at_missing_or_malformed");
    const now = this.#now();
    const expiresAtLocalMs = Math.min(expiresServerMs - this.#skewMs, now + MAX_TOKEN_LIFETIME_MS);
    if (expiresAtLocalMs <= now) throw invalid("token_already_expired");
    const selection = body["repository_selection"];
    if (selection !== "selected" && selection !== "all") throw invalid("repository_selection_missing");
    const repositories = parseReturnedRepositories(body["repositories"]);
    if (repositories === null) throw invalid("repositories_malformed");
    const permissions = sanitizePermissions(body["permissions"]);

    // Svaret må dekke NØYAKTIG det vi ba om. Leverandøren kan ikke (feil eller ondsinnet) gi oss et bredere eller annet token enn forespurt.
    const mismatch = (reason: string): GitHubAppAuthError => new GitHubAppAuthError("GITHUB_APP_SCOPE_MISMATCH", reason);
    if (selection !== "selected") throw mismatch("repository_selection_not_selected");
    if (repositories.length !== scope.repositories.length) throw mismatch("repository_count_differs");
    for (const wanted of scope.repositories) {
      const hit = repositories.some((r) =>
        r.name.toLowerCase() === wanted.name.toLowerCase() && (wanted.owner === undefined || r.fullName.toLowerCase() === `${wanted.owner}/${wanted.name}`.toLowerCase())
      );
      if (!hit) throw mismatch("requested_repository_missing");
    }
    if (scope.permissions) {
      for (const [name, level] of Object.entries(permissions)) {
        const requested = scope.permissions[name];
        const implicitMetadata = name === "metadata" && level === "read";
        if (!implicitMetadata && (requested === undefined || (PERMISSION_RANK[level] ?? 99) > (PERMISSION_RANK[requested] ?? 0))) {
          throw mismatch("permissions_exceed_request");
        }
      }
    }
    const info: GitHubTokenInfo = {
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(expiresServerMs).toISOString(),
      repository_selection: "selected",
      repositories: repositories.map((r) => r.fullName),
      permissions
    };
    return { token, expiresAtLocalMs, issuedAtLocalMs: now, info };
  }

  // ---- HTTP med retry/backoff/skjev-korrigering ---------------------------------------------------------------------------------

  async #requestWithJwt(method: "GET" | "POST", path: string, body: string | undefined, key: KeyObject): Promise<{ status: number; json: unknown }> {
    const url = `${this.#apiBase}${path}`;
    const startedAt = this.#now();
    let attempt = 0;
    let skewRetried = false;
    for (;;) {
      attempt += 1;
      const remaining = this.#deadlineMs - (this.#now() - startedAt);
      // JWT med klokke korrigert for kjent skjev; lages på nytt for HVERT forsøk (kort levetid, billig).
      const jwt = createGitHubAppJwt(key, this.#appId, this.#now() + this.#skewMs);
      let response: Response;
      let text: string;
      try {
        response = await this.#http(url, {
          method,
          headers: {
            authorization: `Bearer ${jwt}`,
            accept: "application/vnd.github+json",
            "user-agent": "jarvis",
            "x-github-api-version": GITHUB_API_VERSION,
            ...(body !== undefined ? { "content-type": "application/json" } : {})
          },
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(Math.max(250, Math.min(this.#requestTimeoutMs, remaining)))
        });
        text = await response.text();
      } catch (err) {
        if (err instanceof UnsafeVendorUrlError) throw configInvalid(`api_base_unsafe:${err.reason}`);
        if (await this.#backoff(attempt, startedAt, null)) continue;
        throw new GitHubAppAuthError("GITHUB_APP_UNAVAILABLE", isTimeoutLike(err) ? "timeout" : "network_error", { retryable: true });
      }

      const skewLearned = this.#learnSkew(response);
      const status = response.status;
      if (status >= 200 && status < 300) {
        if (text.length > MAX_RESPONSE_CHARS) throw new GitHubAppAuthError("GITHUB_APP_RESPONSE_INVALID", "response_too_large");
        try {
          return { status, json: text === "" ? null : (JSON.parse(text) as unknown) };
        } catch {
          throw new GitHubAppAuthError("GITHUB_APP_RESPONSE_INVALID", "not_json");
        }
      }

      const message = errorMessageOf(text);
      if (status === 401) {
        // Klokkeskjev gir 401 på iat/exp. Når Date-headeren viser et avvik vi ikke allerede har rettet for: prøv ÉN gang til umiddelbart.
        if (skewLearned && !skewRetried) {
          skewRetried = true;
          attempt -= 1;
          continue;
        }
        throw new GitHubAppAuthError("GITHUB_APP_AUTH_FAILED", `http_401:${message}`, { httpStatus: 401 });
      }
      if (status === 404) throw new GitHubAppAuthError("GITHUB_APP_INSTALLATION_NOT_FOUND", `http_404:${message}`, { httpStatus: 404 });

      const retryAfterHeader = parseRetryAfterMs(response.headers.get("retry-after"), this.#now() + this.#skewMs);
      const primaryExhausted = response.headers.get("x-ratelimit-remaining") === "0";
      const secondary = /secondary rate limit|abuse detection|spammed/i.test(message);
      if (status === 429 || ((status === 403 || status === 422) && (primaryExhausted || secondary || (status === 403 && retryAfterHeader !== null)))) {
        let waitMs = retryAfterHeader;
        if (waitMs === null && primaryExhausted) {
          const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
          if (Number.isFinite(resetSeconds) && resetSeconds > 0) waitMs = Math.max(1_000, resetSeconds * 1000 - (this.#now() + this.#skewMs));
        }
        if (await this.#backoff(attempt, startedAt, waitMs)) continue;
        throw new GitHubAppAuthError("GITHUB_APP_RATE_LIMITED", `http_${status}:${message}`, { httpStatus: status, retryAfterMs: waitMs ?? 60_000, retryable: true });
      }
      if (status === 403) {
        if (/suspended/i.test(message)) throw new GitHubAppAuthError("GITHUB_APP_INSTALLATION_SUSPENDED", `http_403:${message}`, { httpStatus: 403 });
        throw new GitHubAppAuthError("GITHUB_APP_FORBIDDEN", `http_403:${message}`, { httpStatus: 403 });
      }
      if (status >= 500) {
        if (await this.#backoff(attempt, startedAt, retryAfterHeader)) continue;
        throw new GitHubAppAuthError("GITHUB_APP_UNAVAILABLE", `http_${status}:${message}`, { httpStatus: status, retryable: true });
      }
      throw new GitHubAppAuthError("GITHUB_APP_REQUEST_REJECTED", `http_${status}:${message}`, { httpStatus: status });
    }
  }

  /**
   * Eksponentiell backoff (500 ms, 1 s, ...) med jitter, eller leverandørens eget `Retry-After`. Returnerer false (= gi opp) når forsøkene
   * er brukt opp, ventetiden er urimelig lang for en kall-sti (> 30 s) eller totalfristen ville blitt overskredet.
   * NB: dette er BEVISST forskjellig fra D-392 sin «ingen automatisk retry av 5xx på mutasjoner»: utstedelse av et installasjonstoken har
   * ingen forretningsmessig bivirkning (et ekstra token er ufarlig og utløper av seg selv), så en gjentakelse kan aldri bli en dobbel handling.
   */
  async #backoff(attempt: number, startedAt: number, hintMs: number | null): Promise<boolean> {
    if (attempt >= this.#maxAttempts) return false;
    const wait = hintMs ?? Math.round(BASE_BACKOFF_MS * 2 ** (attempt - 1) * (0.8 + 0.4 * this.#random()));
    if (wait > MAX_INLINE_WAIT_MS) return false;
    if (this.#now() - startedAt + wait >= this.#deadlineMs) return false;
    await this.#sleep(wait);
    return true;
  }

  /** Leser serverens `Date` og lærer klokkeavviket. Returnerer true når avviket er nytt og stort nok til å forklare et 401. */
  #learnSkew(response: Response): boolean {
    const header = response.headers.get("date");
    if (header === null) return false;
    const serverMs = Date.parse(header);
    if (!Number.isFinite(serverMs)) return false;
    const skew = serverMs - this.#now();
    if (Math.abs(skew) < SKEW_THRESHOLD_MS || Math.abs(skew) > SKEW_MAX_MS) {
      this.#skewMs = Math.abs(skew) > SKEW_MAX_MS ? this.#skewMs : 0;
      return false;
    }
    const changed = Math.abs(skew - this.#skewMs) >= SKEW_THRESHOLD_MS;
    this.#skewMs = skew;
    return changed;
  }

  #rememberToken(token: string, expiresAtLocalMs: number): void {
    this.#recentTokens.set(token, Math.max(expiresAtLocalMs, this.#now()) + RECENT_TOKEN_TTL_MS);
    while (this.#recentTokens.size > RECENT_TOKEN_MEMORY) {
      const oldest = this.#recentTokens.keys().next().value;
      if (oldest === undefined) break;
      this.#recentTokens.delete(oldest);
    }
  }

  #log(event: GitHubAuthLogEvent, rateKey: string, minIntervalMs: number): void {
    const now = this.#now();
    const last = this.#lastLogAt.get(rateKey);
    if (last !== undefined && now - last < minIntervalMs) return;
    this.#lastLogAt.set(rateKey, now);
    try {
      this.#emit(event);
    } catch {
      // En feilende logger skal aldri påvirke autentiseringen.
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Hjelpere for svar-tolkning
// ---------------------------------------------------------------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function sanitizePermissions(raw: unknown): Record<string, string> {
  const source = asRecord(raw);
  const out: Record<string, string> = {};
  if (!source) return out;
  for (const [name, level] of Object.entries(source).sort(([a], [b]) => a.localeCompare(b))) {
    if (PERMISSION_NAME.test(name) && (level === "read" || level === "write" || level === "admin")) out[name] = level;
  }
  return out;
}

function parseReturnedRepositories(raw: unknown): Array<{ name: string; fullName: string }> | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: Array<{ name: string; fullName: string }> = [];
  for (const item of raw.slice(0, MAX_REPOSITORIES + 1)) {
    const repo = asRecord(item);
    const name = repo?.["name"];
    const fullName = repo?.["full_name"];
    if (typeof name !== "string" || typeof fullName !== "string") return null;
    try {
      assertGithubRepoSlug(fullName);
    } catch {
      return null;
    }
    out.push({ name, fullName });
  }
  return out;
}

/** Standardlogger: én JSON-linje per hendelse (error -> stderr, warn -> console.warn). Hendelsene inneholder aldri hemmeligheter. */
export function defaultGitHubAuthLog(event: GitHubAuthLogEvent): void {
  const line = JSON.stringify(event);
  if (event.level === "error") console.error(line);
  else if (event.level === "warn") console.warn(line);
  else console.log(line);
}

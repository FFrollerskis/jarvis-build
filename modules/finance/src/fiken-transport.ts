/**
 * UA-6 Finance & Spend Integrity Gateway - Fiken (P0, masterplan-navngitt
 * "primary accounting connector", IKKE et Claude-valgt leverandørvalg -
 * `CORE_DEPENDENCY_DECISION_REQUIRED=false`, se D-107).
 * `payment_intents`/idempotens/avviksdeteksjon/kill-switch forblir
 * `JARVIS_CANONICAL` (service.ts, uendret av denne filen); den offisielle
 * bokførte regnskapsposten (norsk bokføringslov) er Fiken sitt
 * `EXTERNAL_CANONICAL` ansvar - Jarvis bygger ALDRI om dobbel bokføring/
 * MVA-regelverk selv.
 *
 * D-41-verifiseringsstatus (viktig - samme ærlighetsdisiplin som
 * `google-ads-transport.ts` D-83/D-84): direkte `WebFetch` mot
 * `api.fiken.no` var EGRESS-BLOKKERT i denne runden (samme strukturelle
 * proxy-begrensning som rammet `developers.google.com`/
 * `platform.moonshot.ai` tidligere). Endepunkter/OAuth-flyt under er
 * derfor `VERIFIED_SEARCH_SNIPPET` (hentet fra Fiken sin egen offentlige
 * OpenAPI/swagger-spec, speilet på GitHub - `bjerkio/fiken-js`, en
 * community-vedlikeholdt TypeScript-klient som distribuerer Fiken sin
 * EGEN spec-fil uendret, IKKE en tredjeparts gjetning), IKKE
 * `VERIFIED_PRIMARY_SOURCE`:
 *   - OAuth2: `authorization_code`/`refresh_token`-grant mot
 *     `https://fiken.no/oauth/authorize` / `https://fiken.no/oauth/token`,
 *     scopes `read`/`write`. Personlig API-token (Bearer) støttes som
 *     alternativ - IKKE brukt her (owner-connector-flyt krever ekte OAuth
 *     for korrekt eierskap/tilbaketrekkbarhet, samme prinsipp som Google-
 *     adapterne).
 *   - Base-URL: `https://api.fiken.no/api/v2`, ressurser adressert via
 *     `/companies/{companySlug}/...`.
 *   - Verifiserte LESE-endepunkter denne sliceen: `/companies`,
 *     `/companies/{slug}/contacts`, `/companies/{slug}/bankAccounts`,
 *     `/companies/{slug}/journalEntries`.
 *   - Verifisert SKRIVE-endepunkt: `POST /companies/{slug}/
 *     generalJournalEntries` ("fri postering" - generisk journalpost med
 *     kontokode-baserte linjer, IKKE knyttet til en spesifikk kjøps-/
 *     salgs-arbeidsflyt).
 *   - BEVISST IKKE implementert (D-41 STOPP, ikke gjettet): `POST
 *     /purchases` (kjøpsregistrering) - endepunktet EKSISTERER (bekreftet
 *     via `GET /purchases`/`/purchases/drafts`), men denne
 *     spec-utvinningen ga IKKE en fullstendig, pålitelig request-body-
 *     skjema (linje-/kontokode-/mva-felt) - å gjette feltnavn for en
 *     ekte regnskapspostering er UAKSEPTABELT (D-41). `POST /invoices`
 *     (fakturering) er UTENFOR denne sliceens omfang uansett (Fiken er
 *     her regnskaps-BOKFØRINGS-connectoren, ikke en fakturerings-
 *     arbeidsflyt). Ingen idempotens-/duplikat-deteksjon-felt ble funnet
 *     dokumentert på NOEN Fiken-endepunkt i denne utvinningen - Jarvis sin
 *     EGEN `payment_intents.idempotency_key`-UNIQUE-constraint (service.ts)
 *     er derfor den ENESTE idempotens-garantien, IKKE en antakelse om at
 *     Fiken selv deduplikerer.
 */

import { FIKEN_OAUTH_TOKEN_ENDPOINT, buildRefreshTokenExchangeBody, fikenBasicAuthHeader } from "./fiken-oauth.ts";

const FIKEN_API_BASE = "https://api.fiken.no/api/v2";
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

import { financeSignal, isRetrySafe } from "./http.ts";

export class FikenApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "FikenApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tolerant, avkortet (200 tegn) sanering av Fiken sin feilrespons - ALDRI rå kropp/headere logget (samme presedens som `classifyGoogleAdsErrorBody`). */
function classifyFikenErrorBody(rawBody: string): string {
  const trimmed = rawBody.slice(0, 200).trim();
  return trimmed.length > 0 ? trimmed : "no_body";
}

/**
 * Henter et kortlivet access-token fra en persistert OAuth refresh token -
 * ALDRI logget (samme mønster som `googleAccessToken()` i
 * `live-transports.ts`). `JARVIS_FIKEN_CLIENT_ID`/`JARVIS_FIKEN_CLIENT_SECRET`
 * MÅ være konfigurert i `.env`.
 *
 * D-107 HOST-FIX #3: token-endepunktet er per Fikens EGEN dokumentasjon
 * beskyttet med HTTP BASIC-autentisering ("you should use your application
 * client id and client secret as credentials") - klient-credentials sendes
 * derfor i `Authorization: Basic ...`-headeren via de delte, testede
 * hjelperne i `fiken-oauth.ts` (SAMME kode som bootstrappen
 * `scripts/fiken-reauth.ts` bruker), ALDRI i form-kroppen slik den
 * opprinnelige D-107-implementasjonen gjorde.
 */
/**
 * D-398 (JARVIS-097): tidligere én token-utveksling per Fiken-kall (og per transport-instans, som lages per operasjon). Access-tokenet caches nå i minnet
 * (nøkkel = refresh-token; 60 s sikkerhetsmargin før utløp; parallelle kall deler én utveksling; feil caches aldri). Tokenet logges aldri.
 */
const fikenTokenCache = new Map<string, { token: string; expiresAtMs: number }>();
const fikenTokenInflight = new Map<string, Promise<string>>();
const FIKEN_TOKEN_MARGIN_MS = 60_000;
const FIKEN_TOKEN_DEFAULT_TTL_S = 3600;
export function resetFikenAccessTokenCache(): void {
  fikenTokenCache.clear();
  fikenTokenInflight.clear();
}

async function exchangeFikenAccessToken(refreshToken: string): Promise<{ token: string; ttlSeconds: number }> {
  const clientId = process.env["JARVIS_FIKEN_CLIENT_ID"];
  const clientSecret = process.env["JARVIS_FIKEN_CLIENT_SECRET"];
  if (!clientId || !clientSecret) throw new Error("fiken_oauth_client_not_configured");
  const response = await fetch(FIKEN_OAUTH_TOKEN_ENDPOINT, {
        signal: financeSignal(),
    method: "POST",
    headers: { authorization: fikenBasicAuthHeader(clientId, clientSecret), "content-type": "application/x-www-form-urlencoded" },
    body: buildRefreshTokenExchangeBody(refreshToken)
  });
  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    throw new FikenApiError(`fiken_auth_failed_${response.status}:${classifyFikenErrorBody(rawBody)}`, response.status, false);
  }
  const body = (await response.json()) as { access_token: string; expires_in?: number | string };
  const ttl = Number(body.expires_in);
  return { token: body.access_token, ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : FIKEN_TOKEN_DEFAULT_TTL_S };
}

export async function fikenAccessToken(refreshToken: string): Promise<string> {
  // Fail-closed FØR cachen: uten klient-credentials skal aldri et cachet token (fra tidligere konfigurasjon) slippe gjennom.
  if (!process.env["JARVIS_FIKEN_CLIENT_ID"] || !process.env["JARVIS_FIKEN_CLIENT_SECRET"]) throw new Error("fiken_oauth_client_not_configured");
  const cached = fikenTokenCache.get(refreshToken);
  if (cached && cached.expiresAtMs - FIKEN_TOKEN_MARGIN_MS > Date.now()) return cached.token;
  const pending = fikenTokenInflight.get(refreshToken);
  if (pending) return pending;
  const run = (async () => {
    try {
      const { token, ttlSeconds } = await exchangeFikenAccessToken(refreshToken);
      fikenTokenCache.set(refreshToken, { token, expiresAtMs: Date.now() + ttlSeconds * 1000 });
      return token;
    } finally {
      fikenTokenInflight.delete(refreshToken);
    }
  })();
  fikenTokenInflight.set(refreshToken, run);
  return run;
}

export interface FikenContact {
  contactId: number;
  name: string;
  organizationNumber?: string;
  customer?: boolean;
  supplier?: boolean;
}

export interface FikenBankAccount {
  bankAccountId: number;
  name: string;
  type: string;
  bank?: string;
}

export interface FikenJournalEntry {
  journalEntryId: number;
  description?: string;
  date?: string;
}

export interface FikenGeneralJournalEntryLine {
  /** Fiken kontokode (`NNNN` eller `NNNN:NNNNN`) - validert av `service.ts` FØR dette kallet (D-41: deterministisk fangst, ikke Fiken sitt ansvar alene). */
  account: string;
  /** Beløp i øre - positivt for debet, negativt for kredit (dobbel bokføring balanseres av kalleren, IKKE av denne transporten). */
  amount: number;
}

export interface FikenGeneralJournalEntryInput {
  description: string;
  date: string;
  lines: readonly FikenGeneralJournalEntryLine[];
}

/**
 * FØRSTE ekte leverandøradapter for Finance Core. `fetch()`-basert (samme
 * "ingen ny SDK uten begrunnelse"-prinsipp som CLAUDE.md regel 3 og alle
 * andre provider-adaptere i denne kodebasen) - INGEN offisiell Fiken
 * Node/TypeScript-klient finnes uansett.
 */
export class FikenTransport {
  constructor(
    private readonly refreshToken: string,
    private readonly companySlug: string
  ) {}

  private async accessToken(): Promise<string> {
    return fikenAccessToken(this.refreshToken);
  }

  private async request<T>(method: string, path: string, body?: unknown, onSuccess?: (response: Response) => Promise<T>): Promise<T> {
    const token = await this.accessToken();
    let lastError: FikenApiError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await fetch(`${FIKEN_API_BASE}${path}`, {
        signal: financeSignal(),
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json"
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      if (response.ok) {
        if (onSuccess) return onSuccess(response);
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }
      const rawBody = await response.text().catch(() => "");
      const retryable = RETRYABLE_HTTP_STATUS.has(response.status) && isRetrySafe(method, response.status, false);
      lastError = new FikenApiError(`fiken_api_failed_${response.status}:${classifyFikenErrorBody(rawBody)}`, response.status, retryable);
      if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    throw lastError ?? new FikenApiError("fiken_api_failed_unknown", 0, false);
  }

  /** Billig helsesjekk-/reachability-probe (Fiken sin egen dokumenterte "hent companySlug"-inngang) - INGEN mutasjon. */
  async listCompanies(): Promise<Array<{ slug: string; name: string }>> {
    return this.request("GET", "/companies");
  }

  async listContacts(): Promise<FikenContact[]> {
    return this.request("GET", `/companies/${this.companySlug}/contacts`);
  }

  async listBankAccounts(): Promise<FikenBankAccount[]> {
    return this.request("GET", `/companies/${this.companySlug}/bankAccounts`);
  }

  async listJournalEntries(): Promise<FikenJournalEntry[]> {
    return this.request("GET", `/companies/${this.companySlug}/journalEntries`);
  }

  /**
   * "Fri postering" - den ENESTE skrive-operasjonen denne sliceen bygger
   * (verifisert endepunkt, se toppkommentar). Kalleren (service.ts) har
   * ALLEREDE validert kontokode-/beløp-format FØR dette kallet - denne
   * transporten gjetter ALDRI et manglende felt.
   */
  async createGeneralJournalEntry(input: FikenGeneralJournalEntryInput): Promise<FikenJournalEntry> {
    return this.request("POST", `/companies/${this.companySlug}/generalJournalEntries`, input, (response) => readCreatedJournalEntry(response, input));
  }
}

/**
 * WP-F1 (D-453): leser svaret på `POST generalJournalEntries`. Svarformen er IKKE verifisert mot Fikens primærdokumentasjon (en `201 Created` kan komme med JSON-kropp som har
 * `journalEntryId`, eller kun en `Location`-header uten kropp). Begge tolkes derfor KONSERVATIVT: id-en tas fra `journalEntryId` i kroppen, ellers fra en `Location` hvis sti
 * ender på `/journalEntries/<tall>` eller `/generalJournalEntries/<tall>` (aldri en vilkårlig siste sti-del - den kan være en annen ressurs-id). Finnes ingen id er det et UKJENT
 * utfall (`outcome_unknown:` - posteringen KAN være opprettet): kjeden varsler og krever avstemming i stedet for å anta feil eller prøve på nytt (Fiken har ingen Idempotency-Key).
 */
export async function readCreatedJournalEntry(
  response: { text(): Promise<string>; headers?: { get(name: string): string | null } },
  input: Pick<FikenGeneralJournalEntryInput, "description" | "date">
): Promise<FikenJournalEntry> {
  const text = await response.text().catch(() => "");
  let id: number | null = null;
  if (text.trim().length > 0) {
    try {
      const value = (JSON.parse(text) as { journalEntryId?: unknown } | null)?.journalEntryId;
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) id = value;
      else if (typeof value === "string" && /^\d{1,15}$/.test(value) && Number(value) > 0) id = Number(value);
    } catch {
      // ikke JSON - prøv Location under
    }
  }
  if (id === null) {
    const location = response.headers?.get("location") ?? null;
    const match = location === null ? null : /\/(?:generalJournalEntries|journalEntries)\/(\d{1,15})\/?$/.exec(location.split("?")[0]!);
    if (match && Number(match[1]) > 0) id = Number(match[1]);
  }
  if (id === null) throw new Error("outcome_unknown:fiken_created_without_journal_entry_id");
  return { journalEntryId: id, description: input.description, date: input.date };
}

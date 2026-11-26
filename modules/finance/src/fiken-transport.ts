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

import { detachFromCallSignal, raceCallSignal, throwIfAborted } from "@jarvis/tool-gateway";
import { FIKEN_OAUTH_TOKEN_ENDPOINT, buildRefreshTokenExchangeBody, fikenBasicAuthHeader } from "./fiken-oauth.ts";

const FIKEN_API_BASE = "https://api.fiken.no/api/v2";
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

import { financeBackoff, financeFetch, isRetrySafe } from "./http.ts";
import { expectAccessToken, expectArray, expectId, expectRecord, optionalText, readJsonBody, type ResponseContext, expectNumericId } from "./provider-response.ts";

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
  const response = await financeFetch(FIKEN_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { authorization: fikenBasicAuthHeader(clientId, clientSecret), "content-type": "application/x-www-form-urlencoded" },
    body: buildRefreshTokenExchangeBody(refreshToken)
  });
  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    throw new FikenApiError(`fiken_auth_failed_${response.status}:${classifyFikenErrorBody(rawBody)}`, response.status, false);
  }
  // WP-FIN2 (K7): ugyldig token-svar er en typet feil (aldri `Bearer undefined`, aldri en cachet «undefined»). Token-utvekslingen er ingen pengemutasjon.
  const ctx: ResponseContext = { operation: "fiken.access_token", mutation: false };
  const body = expectRecord(await readJsonBody(response, ctx), ctx);
  const token = expectAccessToken(body, "access_token", ctx);
  const ttl = Number(body["expires_in"]);
  return { token, ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : FIKEN_TOKEN_DEFAULT_TTL_S };
}

export async function fikenAccessToken(refreshToken: string): Promise<string> {
  // Fail-closed FØR cachen: uten klient-credentials skal aldri et cachet token (fra tidligere konfigurasjon) slippe gjennom.
  if (!process.env["JARVIS_FIKEN_CLIENT_ID"] || !process.env["JARVIS_FIKEN_CLIENT_SECRET"]) throw new Error("fiken_oauth_client_not_configured");
  const cached = fikenTokenCache.get(refreshToken);
  if (cached && cached.expiresAtMs - FIKEN_TOKEN_MARGIN_MS > Date.now()) return cached.token;
  // WP-FIN2 (D-486, K2d): token-utvekslingen er DELT arbeid (parallelle kall venter på samme løfte). Den startes FRAKOBLET fra det enkelte kallets signal (egen 20 s-frist), så første kallers
  // gateway-tidsavbrudd ikke dreper utvekslingen for de andre; hver kaller venter med `raceCallSignal` og slippes fri av SITT EGET tidsavbrudd uten å avbryte utvekslingen.
  const pending = fikenTokenInflight.get(refreshToken);
  if (pending) return raceCallSignal(pending);
  throwIfAborted(); // et allerede avbrutt kall skal ikke starte en ny (frakoblet) utveksling
  const run = detachFromCallSignal(() => (async () => {
    try {
      const { token, ttlSeconds } = await exchangeFikenAccessToken(refreshToken);
      fikenTokenCache.set(refreshToken, { token, expiresAtMs: Date.now() + ttlSeconds * 1000 });
      return token;
    } finally {
      fikenTokenInflight.delete(refreshToken);
    }
  })());
  fikenTokenInflight.set(refreshToken, run);
  return raceCallSignal(run);
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

  private async request<T>(method: string, path: string, body?: unknown, onSuccess?: (response: Response) => Promise<T>, operation?: string): Promise<T> {
    const token = await this.accessToken();
    let lastError: FikenApiError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await financeFetch(`${FIKEN_API_BASE}${path}`, {
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
        // WP-FIN2 (K7): en uparserbar 2xx-kropp er et ugyldig svar (typet feil for lesing), aldri en rå `SyntaxError`.
        return (await readJsonBody(response, { operation: operation ?? `fiken.${method.toLowerCase()}_request`, mutation: method.toUpperCase() !== "GET" })) as T;
      }
      const rawBody = await response.text().catch(() => "");
      const retryable = RETRYABLE_HTTP_STATUS.has(response.status) && isRetrySafe(method, response.status, false);
      lastError = new FikenApiError(`fiken_api_failed_${response.status}:${classifyFikenErrorBody(rawBody)}`, response.status, retryable);
      if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;
      await financeBackoff(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    throw lastError ?? new FikenApiError("fiken_api_failed_unknown", 0, false);
  }

  /** Billig helsesjekk-/reachability-probe (Fiken sin egen dokumenterte "hent companySlug"-inngang) - INGEN mutasjon. */
  async listCompanies(): Promise<Array<{ slug: string; name: string }>> {
    // WP-FIN2 (K7): svaret må være en liste av selskaper med trygg `slug` (brukes til å adressere alle øvrige kall). Navnet er kun visning (fraværende = tomt).
    const ctx: ResponseContext = { operation: "fiken.list_companies", mutation: false };
    return expectArray(await this.request<unknown>("GET", "/companies", undefined, undefined, ctx.operation), ctx).map((item) => {
      const company = expectRecord(item, ctx, "company");
      return { slug: expectId(company, "slug", ctx), name: optionalText(company, "name", ctx) ?? "" };
    });
  }

  /**
   * WP-FIN2 fiks-runde 1 (FIX-6): de tre Fiken-LESERNE var `as T` uten noen feltsjekk (K7 dekket dem ikke). Nå: svaret MÅ være en liste av objekter der id-feltet (`contactId`/`bankAccountId`/
   * `journalEntryId`: positivt heltall) er til stede og gyldig - en HTML-200, et objekt eller en liste med ugyldige elementer er en typet feil (`provider_response_invalid:<operasjon>:<kode>`),
   * aldri en stille tom liste. Elementene returneres UENDRET (alle felt bevares, f.eks. bilagslinjene `fiken-posting-reader.ts` summerer); bare id-feltet valideres. Fikens svarform er `unverified` (D-41).
   */
  private async readList<T>(path: string, operation: string, idField: string): Promise<T[]> {
    const ctx: ResponseContext = { operation, mutation: false };
    return expectArray(await this.request<unknown>("GET", path, undefined, undefined, operation), ctx).map((item) => {
      const record = expectRecord(item, ctx, "item");
      expectNumericId(record, idField, ctx);
      return record as T;
    });
  }

  async listContacts(): Promise<FikenContact[]> {
    return this.readList<FikenContact>(`/companies/${this.companySlug}/contacts`, "fiken.list_contacts", "contactId");
  }

  async listBankAccounts(): Promise<FikenBankAccount[]> {
    return this.readList<FikenBankAccount>(`/companies/${this.companySlug}/bankAccounts`, "fiken.list_bank_accounts", "bankAccountId");
  }

  async listJournalEntries(): Promise<FikenJournalEntry[]> {
    return this.readList<FikenJournalEntry>(`/companies/${this.companySlug}/journalEntries`, "fiken.list_journal_entries", "journalEntryId");
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
 * WP-F1 (D-462): leser svaret på `POST generalJournalEntries`. Svarformen er IKKE verifisert mot Fikens primærdokumentasjon (en `201 Created` kan komme med JSON-kropp som har
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

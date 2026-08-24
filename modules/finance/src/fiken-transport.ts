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

const FIKEN_API_BASE = "https://api.fiken.no/api/v2";
const FIKEN_TOKEN_URL = "https://fiken.no/oauth/token";
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

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
 * MÅ være konfigurert i `.env` (D-41: eier-tilkoblet, MAKSIMAL nyttig
 * kapabilitet - `read write`-scope forespørres, ALDRI read-only-som-
 * standard-av-bekvemmelighet).
 */
export async function fikenAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env["JARVIS_FIKEN_CLIENT_ID"];
  const clientSecret = process.env["JARVIS_FIKEN_CLIENT_SECRET"];
  if (!clientId || !clientSecret) throw new Error("fiken_oauth_client_not_configured");
  const response = await fetch(FIKEN_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken })
  });
  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    throw new FikenApiError(`fiken_auth_failed_${response.status}:${classifyFikenErrorBody(rawBody)}`, response.status, false);
  }
  return ((await response.json()) as { access_token: string }).access_token;
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.accessToken();
    let lastError: FikenApiError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await fetch(`${FIKEN_API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json"
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }
      const rawBody = await response.text().catch(() => "");
      const retryable = RETRYABLE_HTTP_STATUS.has(response.status);
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
    return this.request("POST", `/companies/${this.companySlug}/generalJournalEntries`, input);
  }
}

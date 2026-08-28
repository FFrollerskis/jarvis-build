/**
 * UA-6 Finance & Spend Integrity Gateway - FEMTE slice (Slice 5, D-111):
 * Neonomics Open Banking-transport. Neonomics er TOBIAS-GODKJENT primær
 * open-banking-leverandør (D-111) - `payment_intents`/normalisering/
 * avstemming/avvik/kill-switch forblir JARVIS_CANONICAL; bank-rapportert
 * konto-/saldo-/transaksjonsdata, samtykketilstand og provider-
 * betalingstilstand er Neonomics sitt EXTERNAL_CANONICAL ansvar.
 *
 * D-41-verifiseringsstatus (SAMME disiplin som stripe-/vipps-transport):
 * `docs.neonomics.io` var EGRESS-BLOKKERT i denne runden - kontrakten
 * under er `VERIFIED_SEARCH_SNIPPET` (uavhengig websøk mot flere offisielt
 * indekserte docs.neonomics.io-sider - IKKE `VERIFIED_PRIMARY_SOURCE`,
 * full kildeliste i D-111, DECISIONS_AND_ASSUMPTIONS.md):
 *
 *   - **Regulatorisk modell**: Neonomics er selv lisensiert TPP
 *     (AISP+PISP) under PSD2 - kunden (Jarvis) opererer GJENNOM Neonomics
 *     sine tillatelser og trenger ikke egen lisens.
 *   - **Miljøer**: sandbox `https://sandbox.neonomics.io`, produksjon
 *     `https://api.neonomics.io` - separate credential-sett/realm.
 *   - **Auth**: OAuth2 client_credentials mot
 *     `/auth/realms/{realm}/protocol/openid-connect/token`
 *     (Content-Type: application/x-www-form-urlencoded, grant_type=
 *     client_credentials + client_id + client_secret) -> `{ access_token,
 *     expires_in }`. Realm: 'sandbox' i sandbox (produksjons-realm
 *     konfigureres via env når credentials faktisk settes opp - D-108).
 *   - **Obligatoriske headere**: `Authorization: Bearer <token>` +
 *     `x-device-id` (Jarvis-tildelt stabil UUID per bruker/enhet) på ALLE
 *     ICS-kall. `x-psu-id` (kryptert sluttbruker-ID, RSA + base64 mot
 *     nedlastet nøkkel) kreves av ENKELTE banker - nøkkelhåndteringen er
 *     credential-fase-arbeid og er DEFERRED under D-108 (dokumentert gap,
 *     aldri stille utelatt).
 *   - **Sesjon/samtykke**: POST `/ics/v3/session` `{ bankId }` ->
 *     `{ sessionId }` (samtykke lagres PER SESJON per bank). Feilkode
 *     1426 «consent required» -> GET `/ics/v3/consent/{sessionId}` ->
 *     URL sluttbrukeren MÅ besøke (SCA hos banken, redirect-flyt).
 *   - **Banker**: GET `/ics/v3/banks` - institusjonskatalog (Norge-først;
 *     bredere europeisk dekning bevart via samme katalog).
 *   - **AIS**: GET `/ics/v3/accounts` (per sesjon), GET
 *     `/ics/v3/accounts/{id}/balances`, GET
 *     `/ics/v3/accounts/{id}/transactions` (paginert).
 *   - **PIS**: POST `/ics/v3/payments/domestic-transfer` (Norge; SEPA via
 *     `/payments/sepa-credit` for euro-land). Feilkode 1428 «payment
 *     authorization required» -> GET
 *     `/ics/v3/payments/{paymentProduct}/{paymentId}/authorize` ->
 *     SCA-URL. Status: GET `/ics/v3/payments/{paymentProduct}/{paymentId}`
 *     - ISO 20022-koder (ACSC=oppgjort, ACCP/ACTC/PDNG=underveis,
 *     RJCT=avvist, CANC=kansellert).
 *   - **Feilmodell**: JSON med numerisk `errorCode` (1426/1428 er
 *     FLYT-signaler, ikke feil) + `message`; provider-request-ID-er i
 *     headere.
 */

const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const TOKEN_REFRESH_SKEW_MS = 60_000;

export type NeonomicsEnvironment = "sandbox" | "production";

export function neonomicsApiBaseUrl(environment: NeonomicsEnvironment): string {
  return environment === "production" ? "https://api.neonomics.io" : "https://sandbox.neonomics.io";
}

export class NeonomicsApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    /** Neonomics sin numeriske domene-feilkode når responsen bar en (1426/1428 er FLYT-signaler og kastes ALDRI som denne feilen - se `request()`). */
    readonly providerErrorCode: number | null,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "NeonomicsApiError";
  }
}

/** 1426 «consent required» - flyt-signal: kalleren må sende brukeren til samtykke-URL-en (aldri en retry-bar feil). */
export class NeonomicsConsentRequiredError extends Error {
  constructor(readonly sessionId: string) {
    super(`neonomics_consent_required:${sessionId}`);
    this.name = "NeonomicsConsentRequiredError";
  }
}

/** 1428 «payment authorization required» - flyt-signal: betalingen krever SCA hos banken (bruker-handling). */
export class NeonomicsPaymentAuthorizationRequiredError extends Error {
  constructor(readonly paymentId: string) {
    super(`neonomics_payment_authorization_required:${paymentId}`);
    this.name = "NeonomicsPaymentAuthorizationRequiredError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Avkortet (200 tegn), token-/header-fri sanering av feilkropp - ALDRI rå headere/hemmeligheter i meldingen (byggeordrens §25). */
function classifyErrorBody(rawBody: string): { message: string; errorCode: number | null } {
  try {
    const parsed = JSON.parse(rawBody) as { errorCode?: number | string; message?: string };
    const code = parsed.errorCode !== undefined ? Number(parsed.errorCode) : null;
    return {
      message: typeof parsed.message === "string" ? parsed.message.slice(0, 200) : rawBody.slice(0, 200).trim() || "no_body",
      errorCode: Number.isFinite(code) ? (code as number) : null
    };
  } catch {
    return { message: rawBody.slice(0, 200).trim() || "no_body", errorCode: null };
  }
}

export interface NeonomicsBank {
  id: string;
  bankDisplayName: string | null;
  countryCode: string | null;
}

export interface NeonomicsAccount {
  id: string;
  accountName: string | null;
  accountNumber: string | null;
  currency: string | null;
  accountType: string | null;
}

export interface NeonomicsBalance {
  type: string;
  /** Neonomics rapporterer desimalbeløp - transporten konverterer til øre EKSAKT (streng-basert, aldri flyttall-multiplikasjon) via `decimalToMinorUnits()`. */
  amountOre: number;
  currency: string;
  referenceDate: string | null;
}

export interface NeonomicsTransaction {
  id: string;
  status: "pending" | "booked";
  /** Positiv = kredit (inn), negativ = debet (ut) hos de fleste PSD2-banker - transporten normaliserer til eksplisitt retning + absolutt beløp. */
  amountOre: number;
  direction: "debit" | "credit";
  currency: string;
  bookingDate: string | null;
  valueDate: string | null;
  counterpartyName: string | null;
  referenceText: string | null;
  bankTransactionCode: string | null;
}

export interface NeonomicsTransactionPage {
  transactions: NeonomicsTransaction[];
  nextPageToken: string | null;
}

export interface NeonomicsPaymentObject {
  id: string;
  /** ISO 20022-status (ACSC/ACCP/ACTC/PDNG/RJCT/CANC...) - RÅ verdi, mapping til Jarvis-tilstand skjer i types.ts sitt deterministiske kart. */
  status: string;
}

export interface InitiateNeonomicsPaymentInput {
  sessionId: string;
  debtorAccountId: string;
  creditorName: string;
  creditorAccountIdentifier: string;
  amountOre: number;
  currency: string;
  referenceText: string;
  /** Jarvis-egen deterministisk idempotens-referanse - sendes som betalingens `endToEndId`/melding slik at et usikkert utfall kan gjenfinnes hos provider. */
  endToEndReference: string;
}

/**
 * Eksakt desimal->øre-konvertering via strengmanipulasjon - ALDRI
 * `Number(x) * 100` (flyttall-pengearitmetikk er forbudt i hele
 * Finance-domenet). Kaster på mer enn 2 desimaler (ingen stille avrunding
 * av penger).
 */
export function decimalToMinorUnits(decimal: string | number): number {
  const s = String(decimal).trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!match) throw new Error(`neonomics_unparseable_amount:${s.slice(0, 30)}`);
  const [, sign, whole, frac = ""] = match;
  const ore = Number(whole) * 100 + Number((frac ?? "").padEnd(2, "0") || "0");
  return sign === "-" ? -ore : ore;
}

/**
 * Eksakt øre->desimal-konvertering via strengmanipulasjon - den OMVENDTE
 * retningen av `decimalToMinorUnits()`, SAMME "aldri flyttall for penger"-
 * prinsipp (CLAUDE.md/§Financial Data Integrity). `amountOre / 100` ville
 * introdusert flyttall-presisjonstap for beløp som ikke er eksakt
 * representerbare i IEEE-754 (f.eks. 1999 øre -> 19.99, som IKKE er en
 * eksakt binær flyttallsverdi) - dette var en reell, tidligere untestet
 * inkonsistens i `initiateDomesticPayment()` (UA-6 closeout-audit).
 */
export function minorUnitsToDecimalString(amountOre: number): string {
  if (!Number.isInteger(amountOre) || amountOre < 0) throw new Error(`neonomics_invalid_minor_units:${amountOre}`);
  const s = String(amountOre).padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/**
 * Minimalt grensesnitt FinanceService/BankingService faktisk trenger -
 * SAMME "narrow injectable writer"-prinsipp som Stripe-/Vipps-
 * transportene. Token-/sesjonshåndtering er innkapslet.
 */
export interface NeonomicsGateway {
  listBanks(): Promise<NeonomicsBank[]>;
  createSession(bankId: string): Promise<{ sessionId: string }>;
  getConsentUrl(sessionId: string, redirectUrl: string): Promise<{ url: string }>;
  listAccounts(sessionId: string): Promise<NeonomicsAccount[]>;
  getBalances(sessionId: string, accountId: string): Promise<NeonomicsBalance[]>;
  listTransactions(sessionId: string, accountId: string, pageToken: string | null): Promise<NeonomicsTransactionPage>;
  initiateDomesticPayment(input: InitiateNeonomicsPaymentInput): Promise<NeonomicsPaymentObject>;
  getPaymentAuthorizeUrl(sessionId: string, paymentId: string, redirectUrl: string): Promise<{ url: string }>;
  getPayment(sessionId: string, paymentId: string): Promise<NeonomicsPaymentObject>;
}

/** `fetch()`-basert (ingen vendor-SDK - CLAUDE.md regel 3, samme som alle øvrige transporter). */
export class NeonomicsTransport implements NeonomicsGateway {
  private readonly baseUrl: string;
  private cachedToken: { token: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    /** Stabil Jarvis-tildelt enhets-UUID (x-device-id) - konfigurert, aldri generert per kall (Neonomics knytter samtykke/sesjon til den). */
    private readonly deviceId: string,
    environment: NeonomicsEnvironment,
    private readonly realm: string = environment === "production" ? "production" : "sandbox"
  ) {
    this.baseUrl = neonomicsApiBaseUrl(environment);
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now) {
      return this.cachedToken.token;
    }
    const response = await fetch(`${this.baseUrl}/auth/realms/${encodeURIComponent(this.realm)}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.clientId, client_secret: this.clientSecret }).toString()
    });
    if (!response.ok) {
      const { message } = classifyErrorBody(await response.text().catch(() => ""));
      throw new NeonomicsApiError(`neonomics_token_failed_${response.status}:${message}`, response.status, null, RETRYABLE_HTTP_STATUS.has(response.status));
    }
    const body = (await response.json()) as { access_token: string; expires_in: number | string };
    const expiresInMs = Number(body.expires_in) * 1000;
    this.cachedToken = { token: body.access_token, expiresAtMs: now + (Number.isFinite(expiresInMs) && expiresInMs > 0 ? expiresInMs : 300_000) };
    return body.access_token;
  }

  private async request<T>(method: string, path: string, opts: { body?: unknown; sessionId?: string } = {}): Promise<T> {
    let lastError: NeonomicsApiError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const token = await this.getAccessToken();
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "x-device-id": this.deviceId,
          accept: "application/json",
          ...(opts.sessionId !== undefined ? { "x-session-id": opts.sessionId } : {}),
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {})
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {})
      });
      if (response.ok) {
        return (await response.json()) as T;
      }
      const { message, errorCode } = classifyErrorBody(await response.text().catch(() => ""));
      // 1426/1428 er dokumenterte FLYT-signaler (samtykke/SCA kreves) -
      // typede flyt-unntak, aldri retry (en retry endrer ingenting før
      // BRUKEREN har handlet hos banken).
      if (errorCode === 1426) throw new NeonomicsConsentRequiredError(opts.sessionId ?? "(ingen sesjon)");
      if (errorCode === 1428) throw new NeonomicsPaymentAuthorizationRequiredError(message);
      const retryable = RETRYABLE_HTTP_STATUS.has(response.status);
      lastError = new NeonomicsApiError(`neonomics_api_failed_${response.status}:${message}`, response.status, errorCode, retryable);
      if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    throw lastError ?? new NeonomicsApiError("neonomics_api_failed_unknown", 0, null, false);
  }

  async listBanks(): Promise<NeonomicsBank[]> {
    const raw = await this.request<Array<Record<string, unknown>>>("GET", "/ics/v3/banks");
    return raw.map((b) => ({
      id: String(b["id"]),
      bankDisplayName: typeof b["bankDisplayName"] === "string" ? (b["bankDisplayName"] as string) : null,
      countryCode: typeof b["countryCode"] === "string" ? (b["countryCode"] as string) : null
    }));
  }

  async createSession(bankId: string): Promise<{ sessionId: string }> {
    const raw = await this.request<Record<string, unknown>>("POST", "/ics/v3/session", { body: { bankId } });
    return { sessionId: String(raw["sessionId"]) };
  }

  async getConsentUrl(sessionId: string, redirectUrl: string): Promise<{ url: string }> {
    const raw = await this.request<Record<string, unknown>>("GET", `/ics/v3/consent/${encodeURIComponent(sessionId)}?redirect_url=${encodeURIComponent(redirectUrl)}`);
    const links = raw["links"] as Array<Record<string, unknown>> | undefined;
    const href = links?.find((l) => typeof l["href"] === "string")?.["href"];
    const url = typeof href === "string" ? href : typeof raw["url"] === "string" ? (raw["url"] as string) : null;
    if (!url) throw new NeonomicsApiError("neonomics_consent_url_missing", 200, null, false);
    return { url };
  }

  async listAccounts(sessionId: string): Promise<NeonomicsAccount[]> {
    const raw = await this.request<Array<Record<string, unknown>>>("GET", "/ics/v3/accounts", { sessionId });
    return raw.map((a) => ({
      id: String(a["id"]),
      accountName: typeof a["accountName"] === "string" ? (a["accountName"] as string) : null,
      accountNumber: typeof a["accountNumber"] === "string" ? (a["accountNumber"] as string) : null,
      currency: typeof a["currency"] === "string" ? (a["currency"] as string).toUpperCase() : null,
      accountType: typeof a["accountType"] === "string" ? (a["accountType"] as string) : null
    }));
  }

  async getBalances(sessionId: string, accountId: string): Promise<NeonomicsBalance[]> {
    const raw = await this.request<Array<Record<string, unknown>>>("GET", `/ics/v3/accounts/${encodeURIComponent(accountId)}/balances`, { sessionId });
    return raw.map((b) => ({
      type: String(b["type"] ?? "unknown"),
      amountOre: decimalToMinorUnits(String(b["amount"] ?? "0")),
      currency: String(b["currency"] ?? "NOK").toUpperCase(),
      referenceDate: typeof b["referenceDate"] === "string" ? (b["referenceDate"] as string) : null
    }));
  }

  async listTransactions(sessionId: string, accountId: string, pageToken: string | null): Promise<NeonomicsTransactionPage> {
    const path = `/ics/v3/accounts/${encodeURIComponent(accountId)}/transactions${pageToken ? `?page=${encodeURIComponent(pageToken)}` : ""}`;
    const raw = await this.request<Record<string, unknown>>("GET", path, { sessionId });
    const list = (Array.isArray(raw) ? raw : (raw["transactions"] as Array<Record<string, unknown>> | undefined)) ?? [];
    const transactions: NeonomicsTransaction[] = list.map((t) => {
      const signedOre = decimalToMinorUnits(String(t["amount"] ?? "0"));
      return {
        id: String(t["id"]),
        status: t["status"] === "pending" ? "pending" : "booked",
        amountOre: Math.abs(signedOre),
        direction: signedOre < 0 ? "debit" : "credit",
        currency: String(t["currency"] ?? "NOK").toUpperCase(),
        bookingDate: typeof t["bookingDate"] === "string" ? (t["bookingDate"] as string) : null,
        valueDate: typeof t["valueDate"] === "string" ? (t["valueDate"] as string) : null,
        counterpartyName: typeof t["counterpartyName"] === "string" ? (t["counterpartyName"] as string) : null,
        referenceText: typeof t["referenceText"] === "string" ? (t["referenceText"] as string) : null,
        bankTransactionCode: typeof t["bankTransactionCode"] === "string" ? (t["bankTransactionCode"] as string) : null
      };
    });
    const nextPageToken = !Array.isArray(raw) && typeof raw["nextPageToken"] === "string" ? (raw["nextPageToken"] as string) : null;
    return { transactions, nextPageToken };
  }

  async initiateDomesticPayment(input: InitiateNeonomicsPaymentInput): Promise<NeonomicsPaymentObject> {
    const raw = await this.request<Record<string, unknown>>("POST", "/ics/v3/payments/domestic-transfer", {
      sessionId: input.sessionId,
      body: {
        debtorAccount: { id: input.debtorAccountId },
        creditorName: input.creditorName,
        creditorAccount: { bban: input.creditorAccountIdentifier },
        instrumentedAmount: minorUnitsToDecimalString(input.amountOre),
        currency: input.currency,
        remittanceInformationUnstructured: input.referenceText.slice(0, 140),
        endToEndIdentification: input.endToEndReference
      }
    });
    return { id: String(raw["id"]), status: String(raw["status"] ?? "PDNG") };
  }

  async getPaymentAuthorizeUrl(sessionId: string, paymentId: string, redirectUrl: string): Promise<{ url: string }> {
    const raw = await this.request<Record<string, unknown>>(
      "GET",
      `/ics/v3/payments/domestic-transfer/${encodeURIComponent(paymentId)}/authorize?redirect_url=${encodeURIComponent(redirectUrl)}`,
      { sessionId }
    );
    const links = raw["links"] as Array<Record<string, unknown>> | undefined;
    const href = links?.find((l) => typeof l["href"] === "string")?.["href"];
    const url = typeof href === "string" ? href : typeof raw["url"] === "string" ? (raw["url"] as string) : null;
    if (!url) throw new NeonomicsApiError("neonomics_authorize_url_missing", 200, null, false);
    return { url };
  }

  async getPayment(sessionId: string, paymentId: string): Promise<NeonomicsPaymentObject> {
    const raw = await this.request<Record<string, unknown>>("GET", `/ics/v3/payments/domestic-transfer/${encodeURIComponent(paymentId)}`, { sessionId });
    return { id: String(raw["id"]), status: String(raw["status"] ?? "PDNG") };
  }
}

import { createSign } from "node:crypto";

/**
 * UA-6 Finance & Spend Integrity Gateway - SJETTE slice (Slice 6, D-112):
 * Wallester-transport. Wallester er TOBIAS-GODKJENT primær programmerbar
 * kort-/wallet-leverandør (D-112) - kortformål/policy/avstemming/avvik/
 * kill-switch forblir JARVIS_CANONICAL; utstedt kortidentitet, provider-
 * livssyklustilstand, nettverks-autorisasjon/oppgjør og provider-saldo er
 * Wallester sitt EXTERNAL_CANONICAL ansvar.
 *
 * === D-113/PR #62 runde 4-KORRIGERING (PRIMARY_SOURCE_EVIDENCE_MODE=
 * OWNER_PROVIDED_PRIMARY_SOURCE_AUDIT) ===
 * Wallester publiserer TO ulike, gjeldende API-kontrakter:
 *   - Wallester BUSINESS (api-frontend.wallester.com) - VALGT PRODUKT for
 *     D-112 (Jarvis styrer bedriftskort/-konti/-saldo/avstemming for
 *     Tobias-eide selskaper).
 *   - Wallester Card API (api-doc.wallester.com) - en SEPARAT kontrakt
 *     (X-Product-Code/X-Audit-Source-Type/X-Audit-User-Id, Decision
 *     Request-sanntidsautorisasjon, iss/aud/sub/exp/rbh-JWT-modellen fra
 *     github.com/wallester/integration-examples) - IKKE valgt produkt.
 * Denne transporten implementerer UTELUKKENDE Business-kontrakten under.
 * Tidligere kode (D-112 HOST FIX #1) implementerte feilaktig Card API sin
 * auth-modell (iss/aud/sub="api-request"/rbh) for det valgte Business-
 * produktet - rettet her. Kilden for dette er EIER-LEVERT (Tobias), IKKE
 * selv hentet av denne økten (egne forsøk på å nå api-frontend.wallester.com
 * OG api-doc.wallester.com via WebFetch, direkte curl (CONNECT-tunnel 403),
 * Wayback Machine og et titalls uavhengige søk fant INGEN korroborering -
 * se D-113/D-114 i DECISIONS_AND_ASSUMPTIONS.md for full revisjonshistorikk).
 *
 * Business-auth (eier-levert primærkilde):
 *   - JWT Bearer-autentisering; en FERSK JWT per forespørsel; provider-
 *     levetid ca. 5 sekunder.
 *   - Claims: KUN `api_key` (Wallester Client Portal-API-nøkkel) og `ts`
 *     (nåværende UNIX-tidsstempel, kan ikke være i fortiden). INGEN
 *     iss/aud/sub/exp/rbh.
 *   - Signeringsbibliotek MÅ støtte RS256.
 *   - `Authorization: Bearer <JWT>`.
 *   - INGEN X-Product-Code/X-Audit-Source-Type/X-Audit-User-Id - de er
 *     Card-API-headere, IKKE en del av Business-kontrakten.
 *
 * BUSINESS_AUTH_SIGNING_MATERIAL=PRIMARY_SOURCE_PUBLIC_DOC_GAP: den
 * offentlig leverte Business-dokumentasjonen bekrefter RS256 + api_key/ts,
 * men forklarer IKKE eksplisitt hvor RSA-PRIVATNØKKELEN som signerer JWT-en
 * kommer fra (egen "RSA keys"-seksjon i Business-dokumentene gjelder
 * UTTRYKKELIG kryptert kortdata-utveksling, IKKE JWT-signering - gjenbrukes
 * ALDRI stille som samme nøkkelmateriale uten bevis). Denne transporten
 * løser derfor auth-VERDIKONTRAKTEN (api_key/ts/Bearer/RS256-algoritme)
 * fra selve nøkkel-PROVISJONERINGEN: en injisert `WallesterBusinessJwtSigner`
 * representerer RS256-signeringsGRENSESNITTET - produksjons-nøkkelopphavet
 * forblir en D-108-credential-fase-avklaring, ALDRI gjettet her.
 *
 * Realtidsautorisasjon (§10): Business-autorisasjonswebhooks er
 * INFORMATIVE varsler (§10-webhookseksjonen under) - IKKE en synkron
 * godkjenn/avslå-beslutningsvei. Card API sin "Decision request"-
 * kapabilitet (X-Request-ID, ~1s svartid, klient-definert
 * default-oppførsel) er EKTE, men tilhører UTELUKKENDE det ikke-valgte
 * Card API-produktet - importeres ALDRI inn i denne Business-transporten.
 */

const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
/** Provider-dokumentert JWT-levetid (eier-levert primærkilde: ca. 5 sekunder) - hver forespørsel bygger en FERSK JWT uansett. */
const BUSINESS_JWT_LIFETIME_SECONDS = 5;
/** Business-paginering (eier-levert primærkilde): `from_record`/`records_count`, ALDRI et gjettet side-token. */
const RECORDS_COUNT = 100;

export class WallesterApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "WallesterApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Avkortet, token-/nøkkelfri sanering av feilkropp - ALDRI hemmeligheter i meldingen (byggeordrens §23). */
function sanitizeErrorBody(rawBody: string): string {
  return rawBody.slice(0, 200).trim() || "no_body";
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * RS256-signeringsGRENSESNITTET (IKKE et bekreftet produksjons-
 * nøkkelopphav - se filhodet, `BUSINESS_AUTH_SIGNING_MATERIAL=
 * PRIMARY_SOURCE_PUBLIC_DOC_GAP`). Tar `${header}.${payload}` og
 * returnerer en base64url-kodet RS256-signatur.
 */
export type WallesterBusinessJwtSigner = (signingInput: string) => string;

/**
 * Hjelpefunksjon for å bygge en signer fra en PEM-kodet RSA-privatnøkkel -
 * BRUKES av tester (ekte engangsnøkkelpar) og KAN gjenbrukes i produksjon
 * DERSOM D-108-credential-fasen bekrefter at kunde-generert PEM faktisk er
 * riktig nøkkelkilde for Business. Denne funksjonen selv gjør INGEN slik
 * antakelse - den bygger kun en gyldig RS256-signer fra hvilken som helst
 * PEM den mottar.
 */
export function createRsaJwtSigner(privateKeyPem: string): WallesterBusinessJwtSigner {
  return (signingInput: string) => base64Url(createSign("RSA-SHA256").update(signingInput, "utf8").sign(privateKeyPem));
}

/**
 * Bygger et Wallester Business-forespørsels-JWT. Ren funksjon over
 * injisert klokke (testbar deterministisk) og injisert signer (RS256-
 * grensesnittet, IKKE et hardkodet nøkkelopphav). Claims PER EIER-LEVERT
 * PRIMÆRKILDE (Business, IKKE Card API): KUN `api_key` og `ts` - INGEN
 * iss/aud/sub/exp/rbh.
 */
export function buildWallesterBusinessJwt(input: { apiKey: string; sign: WallesterBusinessJwtSigner; nowEpochSeconds: number }): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ api_key: input.apiKey, ts: input.nowEpochSeconds }));
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${input.sign(signingInput)}`;
}

export interface WallesterCardObject {
  /** Provider-kort-ID (EXTERNAL_CANONICAL). */
  id: string;
  /** Rå provider-tilstand (mappes deterministisk i card-types.ts). */
  status: string;
  /** KUN maskert referanse (siste 4) - transporten ber ALDRI om og viderefører ALDRI full PAN/CVV/PIN (PCI-grensen §23). */
  maskedCardNumber: string | null;
  accountId: string | null;
  tokenizationStatus: string | null;
}

export interface CreateWallesterCardInput {
  /** Jarvis-deterministisk idempotens-referanse (kanonisk card_id) - sendes som ekstern referanse slik at et usikkert utfall kan gjenfinnes. */
  externalReference: string;
  name: string;
  type: "virtual" | "physical" | "disposable";
  currency: string;
  cardholderName: string | null;
  limits: WallesterCardLimitsInput;
}

export interface WallesterCardLimitsInput {
  transactionLimitOre: number | null;
  dailyLimitOre: number | null;
  weeklyLimitOre: number | null;
  monthlyLimitOre: number | null;
  atmEnabled: boolean;
  onlineEnabled: boolean;
  contactlessEnabled: boolean;
}

export interface WallesterCardLimitsApplied extends WallesterCardLimitsInput {
  /** Provider-ekko: hva Wallester FAKTISK anvendte (autoritativt over requested - §7). */
  confirmed: boolean;
}

export interface WallesterAuthorizationObject {
  id: string;
  cardId: string;
  status: "approved" | "declined" | "reversed" | "settled" | "expired" | "unknown";
  amountOre: number;
  currency: string;
  merchantName: string | null;
  merchantCategoryCode: string | null;
  channel: "pos" | "online" | "atm" | "contactless" | "unknown";
  declineReason: string | null;
  authorizedAt: string | null;
}

export interface WallesterTransactionObject {
  id: string;
  cardId: string;
  authorizationId: string | null;
  type: "purchase" | "refund" | "reversal" | "fee" | "unknown";
  amountOre: number;
  currency: string;
  merchantName: string | null;
  merchantCategoryCode: string | null;
  channel: "pos" | "online" | "atm" | "contactless" | "unknown";
  transactionAt: string | null;
  settledAt: string | null;
}

export interface WallesterPage<T> {
  items: T[];
  nextPageToken: string | null;
}

export interface WallesterAccountBalance {
  accountId: string;
  availableAmountOre: number;
  currency: string;
}

/**
 * Minimalt grensesnitt CardService faktisk trenger - SAMME "narrow
 * injectable gateway"-prinsipp som Stripe-/Vipps-/Neonomics-transportene.
 * JWT-/nøkkelhåndtering er innkapslet. INGEN metode eksponerer
 * PAN/CVV/PIN (PCI-grensen §23 - sensitive-data-endepunkter brukes IKKE).
 */
export interface WallesterGateway {
  createCard(input: CreateWallesterCardInput): Promise<WallesterCardObject>;
  getCard(providerCardId: string): Promise<WallesterCardObject>;
  activateCard(providerCardId: string): Promise<WallesterCardObject>;
  blockCard(providerCardId: string): Promise<WallesterCardObject>;
  unblockCard(providerCardId: string): Promise<WallesterCardObject>;
  closeCard(providerCardId: string): Promise<WallesterCardObject>;
  updateCardLimits(providerCardId: string, limits: WallesterCardLimitsInput): Promise<WallesterCardLimitsApplied>;
  listAuthorizations(providerCardId: string, pageToken: string | null): Promise<WallesterPage<WallesterAuthorizationObject>>;
  listTransactions(providerCardId: string, pageToken: string | null): Promise<WallesterPage<WallesterTransactionObject>>;
  getAccountBalance(): Promise<WallesterAccountBalance>;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function toChannel(v: unknown): "pos" | "online" | "atm" | "contactless" | "unknown" {
  const s = String(v ?? "").toLowerCase();
  if (s === "pos" || s === "online" || s === "atm" || s === "contactless") return s;
  return "unknown";
}

/** `fetch()`-basert (ingen vendor-SDK - CLAUDE.md regel 3, samme som alle øvrige transporter). */
export class WallesterTransport implements WallesterGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly sign: WallesterBusinessJwtSigner,
    /** Business Account-ID kortene/saldoen tilhører (enkelt-global-konto-mønsteret, SAMME presedens som Stripe/Vipps/Neonomics). */
    private readonly accountId: string
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const serialized = body !== undefined ? JSON.stringify(body) : "";
    let lastError: WallesterApiError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Fersk JWT per forespørsel (eier-levert primærkilde: ~5s provider-
      // levetid) - INGEN Card-API-headere (X-Product-Code/X-Audit-*).
      const jwt = buildWallesterBusinessJwt({
        apiKey: this.apiKey,
        sign: this.sign,
        nowEpochSeconds: Math.floor(Date.now() / 1000)
      });
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {})
        },
        ...(body !== undefined ? { body: serialized } : {})
      });
      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
      const message = sanitizeErrorBody(await response.text().catch(() => ""));
      const retryable = RETRYABLE_HTTP_STATUS.has(response.status);
      lastError = new WallesterApiError(`wallester_api_failed_${response.status}:${message}`, response.status, retryable);
      if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    throw lastError ?? new WallesterApiError("wallester_api_failed_unknown", 0, false);
  }

  private mapCard(raw: Record<string, unknown>): WallesterCardObject {
    return {
      id: String(raw["id"]),
      status: String(raw["status"] ?? "unknown"),
      maskedCardNumber: str(raw["masked_card_number"]) ?? str(raw["maskedCardNumber"]),
      accountId: str(raw["account_id"]) ?? str(raw["accountId"]),
      tokenizationStatus: str(raw["tokenization_status"]) ?? str(raw["tokenizationStatus"])
    };
  }

  async createCard(input: CreateWallesterCardInput): Promise<WallesterCardObject> {
    if (input.type === "physical") {
      // ChipAndPin (fysisk) krever dokumenterte embossing-/utleverings-
      // felt Jarvis IKKE samler inn ennå - ALDRI fabrikkert, fail-closed
      // (se WallesterPhysicalCardUnsupportedError-presedensen i
      // card-types.ts / eier-levert primærkilde-audit runde 4).
      throw new WallesterApiError("wallester_physical_card_delivery_fields_unavailable", 0, false);
    }
    const raw = await this.request<Record<string, unknown>>("POST", "/v1/cards", {
      external_reference: input.externalReference,
      account_id: this.accountId,
      // Business-kortenum (eier-levert primærkilde): "Virtual"/"ChipAndPin"
      // - fysisk gren over kaster FØR denne linjen nås.
      type: "Virtual",
      // Engangskort uttrykkes via `is_disposable` (eier-levert primærkilde),
      // IKKE en gjettet usage=single_use/multiple_use-kontrakt.
      is_disposable: input.type === "disposable",
      name: input.name,
      currency: input.currency,
      ...(input.cardholderName ? { cardholder_name: input.cardholderName } : {}),
      limits: this.mapLimitsBody(input.limits),
      security: this.mapSecurityBody(input.limits)
    });
    return this.mapCard(raw);
  }

  /**
   * Business-grensefeltfamilien (eier-levert primærkilde) har separate
   * all_time_/daily_/weekly_/monthly_/transaction_-beløpsgrenser PER KANAL
   * (contactless_purchase/internet_purchase/withdrawal) OG en generell
   * "_purchase"-grense. Jarvis sin kanoniske policy modellerer KUN én
   * beløpsgrense per tidsvindu (ikke per kanal) - mappes derfor UTELUKKENDE
   * til de generelle "_purchase"-feltene (semantisk eksakt); per-kanal-
   * beløpsgrensene og `all_time_*` sendes ALDRI gjettet/uinitialisert.
   */
  private mapLimitsBody(limits: WallesterCardLimitsInput): Record<string, unknown> {
    return {
      ...(limits.transactionLimitOre !== null ? { transaction_purchase: limits.transactionLimitOre } : {}),
      ...(limits.dailyLimitOre !== null ? { daily_purchase: limits.dailyLimitOre } : {}),
      ...(limits.weeklyLimitOre !== null ? { weekly_purchase: limits.weeklyLimitOre } : {}),
      ...(limits.monthlyLimitOre !== null ? { monthly_purchase: limits.monthlyLimitOre } : {})
    };
  }

  /**
   * Business-sikkerhetsfeltene (eier-levert primærkilde) er EGEN
   * PATCH /v1/cards/{id}/security - separat fra beløpsgrenser. Mapper KUN
   * de tre Jarvis-kanoniske kanal-boolean-feltene som har en eksakt
   * Business-motpart; `all_time_limits_enabled` har INGEN etablert
   * Jarvis-drevet verdi og sendes ALDRI gjettet.
   */
  private mapSecurityBody(limits: WallesterCardLimitsInput): Record<string, unknown> {
    return {
      withdrawal_enabled: limits.atmEnabled,
      internet_purchase_enabled: limits.onlineEnabled,
      contactless_enabled: limits.contactlessEnabled
    };
  }

  async getCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.mapCard(await this.request<Record<string, unknown>>("GET", `/v1/cards/${encodeURIComponent(providerCardId)}`));
  }

  // Business kortlivssyklus-verb (eier-levert primærkilde): PATCH, IKKE POST.
  async activateCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.mapCard(await this.request<Record<string, unknown>>("PATCH", `/v1/cards/${encodeURIComponent(providerCardId)}/activate`, {}));
  }

  async blockCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.mapCard(await this.request<Record<string, unknown>>("PATCH", `/v1/cards/${encodeURIComponent(providerCardId)}/block`, {}));
  }

  async unblockCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.mapCard(await this.request<Record<string, unknown>>("PATCH", `/v1/cards/${encodeURIComponent(providerCardId)}/unblock`, {}));
  }

  async closeCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.mapCard(await this.request<Record<string, unknown>>("PATCH", `/v1/cards/${encodeURIComponent(providerCardId)}/close`, {}));
  }

  /**
   * Business skiller grenser (PATCH .../limits) fra sikkerhet
   * (PATCH .../security) som TO separate endepunkter (eier-levert
   * primærkilde) - CardService sin ØNSKET-vs-ANVENDT-invariant forblir
   * ETT sammenslått resultat (minst mulig arkitekturendring, §7 uendret).
   */
  async updateCardLimits(providerCardId: string, limits: WallesterCardLimitsInput): Promise<WallesterCardLimitsApplied> {
    const rawLimits = await this.request<Record<string, unknown>>("PATCH", `/v1/cards/${encodeURIComponent(providerCardId)}/limits`, this.mapLimitsBody(limits));
    const rawSecurity = await this.request<Record<string, unknown>>("PATCH", `/v1/cards/${encodeURIComponent(providerCardId)}/security`, this.mapSecurityBody(limits));
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
    return {
      transactionLimitOre: num(rawLimits["transaction_purchase"]),
      dailyLimitOre: num(rawLimits["daily_purchase"]),
      weeklyLimitOre: num(rawLimits["weekly_purchase"]),
      monthlyLimitOre: num(rawLimits["monthly_purchase"]),
      atmEnabled: bool(rawSecurity["withdrawal_enabled"], limits.atmEnabled),
      onlineEnabled: bool(rawSecurity["internet_purchase_enabled"], limits.onlineEnabled),
      contactlessEnabled: bool(rawSecurity["contactless_enabled"], limits.contactlessEnabled),
      confirmed: true
    };
  }

  private mapAuthorization(raw: Record<string, unknown>): WallesterAuthorizationObject {
    const status = String(raw["status"] ?? "").toLowerCase();
    // Fail-safe (eier-levert primærkilde-korrigering, runde 4): en UKJENT
    // provider-status mappes ALDRI stille til "approved" - forblir "unknown".
    const knownStatus = status === "approved" || status === "declined" || status === "reversed" || status === "settled" || status === "expired";
    return {
      id: String(raw["id"]),
      cardId: String(raw["card_id"] ?? raw["cardId"] ?? ""),
      status: knownStatus ? (status as WallesterAuthorizationObject["status"]) : "unknown",
      amountOre: Number(raw["amount"] ?? 0),
      currency: String(raw["currency"] ?? "EUR").toUpperCase(),
      merchantName: str(raw["merchant_name"]),
      merchantCategoryCode: str(raw["merchant_category_code"]),
      channel: toChannel(raw["channel"]),
      declineReason: str(raw["decline_reason"]),
      authorizedAt: str(raw["authorized_at"])
    };
  }

  /** Business-paginering (eier-levert primærkilde): `from_record`/`records_count` - ALDRI et gjettet side-token. `pageToken` bærer neste `from_record` som streng. */
  async listAuthorizations(providerCardId: string, pageToken: string | null): Promise<WallesterPage<WallesterAuthorizationObject>> {
    const fromRecord = pageToken ? Number(pageToken) : 0;
    const path = `/v1/cards/${encodeURIComponent(providerCardId)}/authorizations?from_record=${fromRecord}&records_count=${RECORDS_COUNT}`;
    const raw = await this.request<Record<string, unknown>>("GET", path);
    const list = (raw["authorizations"] as Array<Record<string, unknown>> | undefined) ?? [];
    const nextFromRecord = fromRecord + list.length;
    return { items: list.map((a) => this.mapAuthorization(a)), nextPageToken: list.length === RECORDS_COUNT ? String(nextFromRecord) : null };
  }

  private mapTransaction(raw: Record<string, unknown>): WallesterTransactionObject {
    const type = String(raw["type"] ?? "").toLowerCase();
    // Fail-safe (eier-levert primærkilde-korrigering, runde 4): en UKJENT
    // provider-transaksjonstype mappes ALDRI stille til "purchase".
    const knownType = type === "purchase" || type === "refund" || type === "reversal" || type === "fee";
    return {
      id: String(raw["id"]),
      cardId: String(raw["card_id"] ?? raw["cardId"] ?? ""),
      authorizationId: str(raw["authorization_id"]),
      type: knownType ? (type as WallesterTransactionObject["type"]) : "unknown",
      amountOre: Number(raw["amount"] ?? 0),
      currency: String(raw["currency"] ?? "EUR").toUpperCase(),
      merchantName: str(raw["merchant_name"]),
      merchantCategoryCode: str(raw["merchant_category_code"]),
      channel: toChannel(raw["channel"]),
      transactionAt: str(raw["transaction_at"]),
      settledAt: str(raw["settled_at"])
    };
  }

  async listTransactions(providerCardId: string, pageToken: string | null): Promise<WallesterPage<WallesterTransactionObject>> {
    const fromRecord = pageToken ? Number(pageToken) : 0;
    const path = `/v1/cards/${encodeURIComponent(providerCardId)}/transactions?from_record=${fromRecord}&records_count=${RECORDS_COUNT}`;
    const raw = await this.request<Record<string, unknown>>("GET", path);
    const list = (raw["transactions"] as Array<Record<string, unknown>> | undefined) ?? [];
    const nextFromRecord = fromRecord + list.length;
    return { items: list.map((t) => this.mapTransaction(t)), nextPageToken: list.length === RECORDS_COUNT ? String(nextFromRecord) : null };
  }

  /** Business Account-ressursen (eier-levert primærkilde) - IKKE en gjettet global `/v1/accounts/balance`. */
  async getAccountBalance(): Promise<WallesterAccountBalance> {
    const raw = await this.request<Record<string, unknown>>("GET", `/v1/accounts/${encodeURIComponent(this.accountId)}`);
    return {
      accountId: this.accountId,
      availableAmountOre: Number(raw["available_amount"] ?? 0),
      currency: String(raw["currency"] ?? "EUR").toUpperCase()
    };
  }
}

/** Eksportert for host-akseptanse-skriptet sin markør-timing-dokumentasjon (ALDRI brukt til å forkorte selve JWT-en - hver forespørsel bygger fersk). */
export const WALLESTER_BUSINESS_JWT_LIFETIME_SECONDS = BUSINESS_JWT_LIFETIME_SECONDS;

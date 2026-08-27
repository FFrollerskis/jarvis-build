import { createHash, createSign } from "node:crypto";

/**
 * UA-6 Finance & Spend Integrity Gateway - SJETTE slice (Slice 6, D-112):
 * Wallester-transport. Wallester er TOBIAS-GODKJENT primær programmerbar
 * kort-/wallet-leverandør (D-112) - kortformål/policy/avstemming/avvik/
 * kill-switch forblir JARVIS_CANONICAL; utstedt kortidentitet, provider-
 * livssyklustilstand, nettverks-autorisasjon/oppgjør og provider-saldo er
 * Wallester sitt EXTERNAL_CANONICAL ansvar.
 *
 * D-41-verifiseringsstatus (SAMME disiplin som stripe-/vipps-/neonomics-
 * transportene): `docs.wallester.com`, `wallester.com`,
 * `api-frontend.wallester.com` og `deepwiki.com` var ALLE EGRESS-BLOKKERT
 * i denne runden - kontrakten under er `VERIFIED_SEARCH_SNIPPET`
 * (uavhengig websøk mot flere offisielt indekserte Wallester-kilder,
 * inkl. wallester/integration-examples-sammendrag - IKKE
 * `VERIFIED_PRIMARY_SOURCE`, full kildeliste i D-112,
 * DECISIONS_AND_ASSUMPTIONS.md):
 *
 *   - **Regulatorisk modell**: Wallester AS er selv lisensiert finans-
 *     foretak (estisk e-pengeinstitusjon, Visa Principal Member) -
 *     kortutstedelsen skjer under WALLESTER sin konsesjon. Wallester
 *     Business er tilgjengelig for EØS-selskaper (Norge kvalifisert);
 *     API-tilgang krever kommersiell aktivering ("eligible plans").
 *     KYB (selskap) og KYC (kortholder) er provider-kanoniske prosesser.
 *   - **Auth (JWT/RS256) - VERIFIED_PRIMARY_SOURCE** (D-112 HOST FIX #1:
 *     `github.com/wallester/integration-examples`, README.md +
 *     `examples/go/jwt/jwt.go` - Wallester sitt EGET offisielle
 *     referanse-repo, IKKE lenger kun `VERIFIED_SEARCH_SNIPPET` for denne
 *     delen av kontrakten): kunden genererer RSA-nøkkelpar (2048),
 *     registrerer OFFENTLIG nøkkel hos Wallester, og signerer et FERSKT
 *     JWT per forespørsel med PRIVAT nøkkel (RS256). Claims: iss (egen
 *     utsteder-ID), aud (Wallester sin audience-ID), sub = FAST LITERAL
 *     `"api-request"` (IKKE utsteder-ID - opprinnelig kode hadde dette
 *     feil, rettet i D-112 HOST FIX #1), exp, `rbh` =
 *     base64(sha256(request-body som BINÆR, IKKE hex)). Token sendes i
 *     `Authorization`-headeren som `"Bearer <JWT>"` (opprinnelig kode
 *     manglet "Bearer "-prefikset, rettet samme runde). RESPONSEN bærer
 *     ALLTID et JWT i `Authorization`-headeren (samme "Bearer <JWT>"-
 *     format) med `rbh` over responskroppen - primærkilden instruerer
 *     kunden til å verifisere dette. IKKE IMPLEMENTERT ENNÅ: denne
 *     transporten verifiserer IKKE responsens JWT/signatur (krever
 *     Wallester sin offentlige nøkkel, en credential-fase-artefakt per
 *     D-108) - dette er en bevisst, ærlig avgrenset gap, IKKE en stille
 *     antakelse om at det skjer.
 *   - **Produkt-kode**: byggeordren angir en `X-Product-Code`-header for
 *     produkt-/programruting. UBEKREFTET i det uavhengige søket
 *     (UNCONFIRMED_FIELD) - sendes derfor KUN når eksplisitt konfigurert;
 *     eksakt semantikk verifiseres i credential-/live-fasen (D-108).
 *   - **Kort**: virtuelle, fysiske OG engangskort (single-use) opprettes
 *     via REST API; bruksart (single-use/multiple-use) settes ved
 *     opprettelse; egendefinert utløp (opptil 3 år). Engangskort
 *     auto-lukkes hos Wallester etter ÉN VELLYKKET transaksjon (avslag
 *     holder kortet aktivt). Livssyklus: aktiver/blokker/avblokker/lukk.
 *     3DS-verifiseringsmetode konfigurerbar via API.
 *   - **Grenser/kontroller**: per-transaksjons-/dag-/uke-/månedsgrenser
 *     per kort ELLER konto; av/på for ATM-uttak, internett-kjøp og
 *     contactless; PATCH-oppdaterbare i sanntid; hierarki kort <= konto
 *     <= selskap; Wallester AUTO-AVSLÅR transaksjoner over grensen.
 *     MCC-filtre/valuta-restriksjoner/tidsvinduer per kort er dokumentert
 *     kapabilitet (detaljkontrakt verifiseres i live-fasen).
 *   - **Autorisasjon vs oppgjør**: autorisasjonshendelser (approve/
 *     decline besluttet AV WALLESTER i beslutningsøyeblikket) er DISTINKT
 *     fra oppgjørstransaksjoner. Webhooks er VARSLER om fattede
 *     beslutninger - IKKE beslutnings-callbacks (ingen tilgjengelig kilde,
 *     primær eller sekundær, bekreftet ELLER avkreftet en decision-request-
 *     kapabilitet for det valgte programmet) -> §10 sanntidsautorisasjons-
 *     policy er `UNVERIFIED_PRODUCT_ENTITLEMENT` (korrigert D-113 - IKKE
 *     `NOT_APPLICABLE`, som ville påstått et bekreftet fravær).
 *   - **Miljøer**: privat sandbox med test-kort-simulering + produksjon -
 *     separate base-URL-er/credential-sett (eksakte verter konfigureres
 *     via env i credential-fasen; ingen verifisert offentlig sandbox-vert
 *     i søket - UNCONFIRMED_FIELD, derfor env-konfigurert, aldri gjettet
 *     hardkodet).
 */

const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
/** JWT-levetid per forespørsel - kort og fersk (kontrakten sier "exp inn i fremtiden, maks tillatt av Wallester"); 60s er konservativt trygt. */
const JWT_TTL_SECONDS = 60;

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
 * `rbh`-claimen: base64-kodet SHA-256 av forespørselskroppen som BINÆR
 * (eksplisitt IKKE hex - verifisert kontraktsdetalj). Tom kropp hashes
 * som tom streng (integration-examples-mønsteret).
 */
export function computeRequestBodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("base64");
}

/**
 * Wallester sin faste, dokumenterte `sub`-claim-verdi for ALLE
 * API-forespørsler (PRIMARY SOURCE: github.com/wallester/integration-
 * examples, README.md + examples/go/jwt/jwt.go - `sub: "api-request"` er
 * en LITERAL konstant, IKKE utstederens egen ID). Rettet i D-112 HOST FIX
 * #1 - opprinnelig implementasjon satte feilaktig `sub = iss`.
 */
const JWT_SUBJECT = "api-request";

/**
 * Bygger og RS256-signerer et Wallester-forespørsels-JWT. Ren funksjon
 * over injisert klokke (testbar deterministisk). Claims per PRIMARY
 * SOURCE (github.com/wallester/integration-examples): iss (kunde-/API-
 * identitet registrert hos Wallester), aud (Wallester sin audience-ID),
 * sub (FAST "api-request"), exp (kort fremtid), rbh (kropphash).
 */
export function buildWallesterJwt(input: {
  issuer: string;
  audience: string;
  privateKeyPem: string;
  body: string;
  nowEpochSeconds: number;
  ttlSeconds?: number;
}): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: input.issuer,
      aud: input.audience,
      sub: JWT_SUBJECT,
      exp: input.nowEpochSeconds + (input.ttlSeconds ?? JWT_TTL_SECONDS),
      rbh: computeRequestBodyHash(input.body)
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput, "utf8").sign(input.privateKeyPem);
  return `${signingInput}.${base64Url(signature)}`;
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
  status: "approved" | "declined" | "reversed" | "settled" | "expired";
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
  type: "purchase" | "refund" | "reversal" | "fee";
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
    private readonly issuer: string,
    private readonly audience: string,
    private readonly privateKeyPem: string,
    /** UNCONFIRMED_FIELD (se filhode): sendes som `X-Product-Code` KUN når konfigurert. */
    private readonly productCode: string | null
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const serialized = body !== undefined ? JSON.stringify(body) : "";
    let lastError: WallesterApiError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const jwt = buildWallesterJwt({
        issuer: this.issuer,
        audience: this.audience,
        privateKeyPem: this.privateKeyPem,
        body: serialized,
        nowEpochSeconds: Math.floor(Date.now() / 1000)
      });
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          // PRIMARY SOURCE (wallester/integration-examples README): headeren
          // er "Authorization: Bearer <JWT>", ikke det rå JWT-et alene.
          // Rettet i D-112 HOST FIX #1 - opprinnelig implementasjon manglet
          // "Bearer "-prefikset.
          authorization: `Bearer ${jwt}`,
          accept: "application/json",
          ...(this.productCode ? { "x-product-code": this.productCode } : {}),
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
    const raw = await this.request<Record<string, unknown>>("POST", "/v1/cards", {
      external_reference: input.externalReference,
      name: input.name,
      type: input.type === "disposable" ? "virtual" : input.type,
      // Engangssemantikken uttrykkes via bruksart (VERIFIED_SEARCH_SNIPPET:
      // "card usage type: single-use or multiple-use").
      usage: input.type === "disposable" ? "single_use" : "multiple_use",
      currency: input.currency,
      ...(input.cardholderName ? { cardholder_name: input.cardholderName } : {}),
      limits: this.mapLimitsBody(input.limits)
    });
    return this.mapCard(raw);
  }

  private mapLimitsBody(limits: WallesterCardLimitsInput): Record<string, unknown> {
    return {
      ...(limits.transactionLimitOre !== null ? { transaction_limit: limits.transactionLimitOre } : {}),
      ...(limits.dailyLimitOre !== null ? { daily_limit: limits.dailyLimitOre } : {}),
      ...(limits.weeklyLimitOre !== null ? { weekly_limit: limits.weeklyLimitOre } : {}),
      ...(limits.monthlyLimitOre !== null ? { monthly_limit: limits.monthlyLimitOre } : {}),
      atm_enabled: limits.atmEnabled,
      online_enabled: limits.onlineEnabled,
      contactless_enabled: limits.contactlessEnabled
    };
  }

  async getCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.mapCard(await this.request<Record<string, unknown>>("GET", `/v1/cards/${encodeURIComponent(providerCardId)}`));
  }

  async activateCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.mapCard(await this.request<Record<string, unknown>>("POST", `/v1/cards/${encodeURIComponent(providerCardId)}/activate`, {}));
  }

  async blockCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.mapCard(await this.request<Record<string, unknown>>("POST", `/v1/cards/${encodeURIComponent(providerCardId)}/block`, {}));
  }

  async unblockCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.mapCard(await this.request<Record<string, unknown>>("POST", `/v1/cards/${encodeURIComponent(providerCardId)}/unblock`, {}));
  }

  async closeCard(providerCardId: string): Promise<WallesterCardObject> {
    return this.mapCard(await this.request<Record<string, unknown>>("POST", `/v1/cards/${encodeURIComponent(providerCardId)}/close`, {}));
  }

  async updateCardLimits(providerCardId: string, limits: WallesterCardLimitsInput): Promise<WallesterCardLimitsApplied> {
    // PATCH-oppdaterbare grenser i sanntid (VERIFIED_SEARCH_SNIPPET).
    const raw = await this.request<Record<string, unknown>>("PATCH", `/v1/cards/${encodeURIComponent(providerCardId)}/limits`, this.mapLimitsBody(limits));
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
    return {
      transactionLimitOre: num(raw["transaction_limit"]),
      dailyLimitOre: num(raw["daily_limit"]),
      weeklyLimitOre: num(raw["weekly_limit"]),
      monthlyLimitOre: num(raw["monthly_limit"]),
      atmEnabled: bool(raw["atm_enabled"], limits.atmEnabled),
      onlineEnabled: bool(raw["online_enabled"], limits.onlineEnabled),
      contactlessEnabled: bool(raw["contactless_enabled"], limits.contactlessEnabled),
      confirmed: true
    };
  }

  private mapAuthorization(raw: Record<string, unknown>): WallesterAuthorizationObject {
    const status = String(raw["status"] ?? "").toLowerCase();
    return {
      id: String(raw["id"]),
      cardId: String(raw["card_id"] ?? raw["cardId"] ?? ""),
      status: status === "approved" || status === "declined" || status === "reversed" || status === "settled" || status === "expired" ? status : "approved",
      amountOre: Number(raw["amount"] ?? 0),
      currency: String(raw["currency"] ?? "EUR").toUpperCase(),
      merchantName: str(raw["merchant_name"]),
      merchantCategoryCode: str(raw["merchant_category_code"]),
      channel: toChannel(raw["channel"]),
      declineReason: str(raw["decline_reason"]),
      authorizedAt: str(raw["authorized_at"])
    };
  }

  async listAuthorizations(providerCardId: string, pageToken: string | null): Promise<WallesterPage<WallesterAuthorizationObject>> {
    const path = `/v1/cards/${encodeURIComponent(providerCardId)}/authorizations${pageToken ? `?page=${encodeURIComponent(pageToken)}` : ""}`;
    const raw = await this.request<Record<string, unknown>>("GET", path);
    const list = (raw["authorizations"] as Array<Record<string, unknown>> | undefined) ?? [];
    return { items: list.map((a) => this.mapAuthorization(a)), nextPageToken: str(raw["next_page_token"]) };
  }

  private mapTransaction(raw: Record<string, unknown>): WallesterTransactionObject {
    const type = String(raw["type"] ?? "").toLowerCase();
    return {
      id: String(raw["id"]),
      cardId: String(raw["card_id"] ?? raw["cardId"] ?? ""),
      authorizationId: str(raw["authorization_id"]),
      type: type === "purchase" || type === "refund" || type === "reversal" || type === "fee" ? type : "purchase",
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
    const path = `/v1/cards/${encodeURIComponent(providerCardId)}/transactions${pageToken ? `?page=${encodeURIComponent(pageToken)}` : ""}`;
    const raw = await this.request<Record<string, unknown>>("GET", path);
    const list = (raw["transactions"] as Array<Record<string, unknown>> | undefined) ?? [];
    return { items: list.map((t) => this.mapTransaction(t)), nextPageToken: str(raw["next_page_token"]) };
  }

  async getAccountBalance(): Promise<WallesterAccountBalance> {
    const raw = await this.request<Record<string, unknown>>("GET", "/v1/accounts/balance");
    return {
      accountId: String(raw["account_id"] ?? ""),
      availableAmountOre: Number(raw["available_amount"] ?? 0),
      currency: String(raw["currency"] ?? "EUR").toUpperCase()
    };
  }
}

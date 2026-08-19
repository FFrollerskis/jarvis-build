import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolTransport } from "@jarvis/tool-gateway";
import { googleAccessToken } from "@jarvis/tool-gateway";
import type { GrowthService } from "./service.ts";
import type { CampaignStatus } from "./types.ts";

/**
 * UA-4 Google Ads-slice (D-83): FØRSTE ekte leverandøradapter for Growth
 * Core. Google Ads er en ADAPTER (D-64) - `marketing_campaigns`/
 * `marketing_spend_events`/`marketing_campaign_tracking_tags` forblir
 * `JARVIS_CANONICAL`, uendret av denne filen; kampanje-serveringstilstand/
 * rå utgift/klikk/visning er `EXTERNAL_CANONICAL` FAKTA denne adapteren
 * henter og videresender - ALDRI Jarvis sin egen mening om dem.
 *
 * D-41-verifiseringsstatus (viktig - se D-83/D-84 i
 * DECISIONS_AND_ASSUMPTIONS.md for full begrunnelse): WebFetch mot
 * `developers.google.com` var BLOKKERT i BÅDE D-83-runden og D-84
 * PRE-MERGE-re-audit-runden (samme egress-begrensning som D-81/D-82-
 * forskningen) - ALLE fakta under er derfor `VERIFIED_OFFICIAL_SEARCH_
 * SNIPPET` (D-84 sin re-audit fant FLERE uavhengige, innbyrdes konsistente
 * søkekilder for hvert punkt - en styrking fra D-83 sin opprinnelige,
 * enklere `VERIFIED_SEARCH_SNIPPET`-klassifisering), IKKE
 * `VERIFIED_PRIMARY_SOURCE`. ÉN presisering fra D-84: at 401/403 ALDRI skal
 * retries er en RIMELIG, men IKKE direkte sitert regel (utledet fra Googles
 * generelle autentiserings- vs. retry-bar-feil-kategorisering, ikke en
 * eksplisitt "401/403 skal aldri retries"-setning funnet i dokumentasjonen)
 * - klassifisert `UNVERIFIED_INFERRED` i D-84, IKKE handlet på ved å bygge
 * NOE nytt (koden var ALLEREDE konservativ - retry KUN på 429/5xx var
 * allerede riktig valg uansett). Kapabiliteter som IKKE kunne bekreftes i
 * det hele tatt er BEVISST STOPPET (ikke bygget), fremfor gjettet:
 *   - Mutate/skriving (kampanje-/budsjett-/bud-endring): IKKE implementert
 *     her - dette er BÅDE utenfor Finance Integrity-grensen for denne
 *     sliceen (ingen autonome forbruks-mutasjoner FØR UA-6) OG en reell
 *     D-41-STOPP (ingen bekreftet idempotens-mekanisme for mutate-kall ble
 *     funnet - "les-før-skriv" måtte antas, ikke bekreftet).
 *   - Offline conversion-opplasting (`ConversionUploadService`): IKKE
 *     implementert - forskningen fant et mulig BLOKKERENDE gyldighetskrav
 *     (utviklertoken-historikk) innført 15. juni 2026 som IKKE kunne
 *     bekreftes mot primærkilde - eksplisitt utenfor denne sliceens omfang
 *     uansett (kun lese-/synk-omfang bestilt).
 *   - Nøyaktig QPS-grense: ukjent/uoppgitt i søkeresultatene - INGEN
 *     oppdiktet tall brukt her; kun generisk eksponentiell backoff på
 *     bekreftede retry-bare HTTP-statuser (429/5xx).
 * Kapabiliteter som ER implementert (kampanje-lesing, daglig utgift/klikk/
 * visning-lesing, click_view/gclid-lesing, GAQL search, feilmodell) hviler
 * på FLERE uavhengige søkekilder som var konsistente med hverandre - se
 * D-83 for kildeliste.
 *
 * INGEN offisiell Node/TypeScript Google Ads-klient finnes (kun
 * community-vedlikeholdte npm-pakker, IKKE Google-støttet) - rå REST/GAQL
 * via `fetch()` er derfor BEVISST valgt fremfor en tredjeparts-SDK-
 * avhengighet for noe som til slutt vil røre ekte annonseforbruk (samme
 * "ingen ny SDK uten begrunnelse"-prinsipp som CLAUDE.md regel 3 krever,
 * og SAMME `fetch()`-baserte mønster som ALLE andre provider-adaptere i
 * denne kodebasen - `gemini.ts`/`openai.ts`/`gemma.ts` - allerede bruker).
 */

const DEFAULT_API_VERSION = "v25";
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class GoogleAdsApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "GoogleAdsApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tolerant JSON-parsing av Google sin generiske API-feilkonvolutt
 * (`{error:{code,message,status}}`, SAMME mønster som andre Google-APIer i
 * denne kodebasen). Returnerer ALDRI rå kropp/headere - kun en kort,
 * avkortet (200 tegn, samme presedens som `googleErrorDescription`-
 * avkortingen i `live-transports.ts`), sanert årsak. Google ekko-er ALDRI
 * credentials i en feilrespons, men avkortingen er et ekstra sikkerhetsnett
 * uansett - ALDRI en antakelse om at det er unødvendig.
 */
function classifyGoogleAdsErrorBody(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { status?: string; message?: string } };
    const status = parsed.error?.status ?? "UNKNOWN";
    const message = (parsed.error?.message ?? "").slice(0, 200);
    return message ? `${status}:${message}` : status;
  } catch {
    return "UNCLASSIFIED_ERROR_BODY";
  }
}

interface GaqlSearchOptions {
  customerId: string;
  accessToken: string;
  developerToken: string;
  loginCustomerId: string | undefined;
  apiVersion: string;
  query: string;
}

interface GaqlCampaignPart {
  id?: string;
  name?: string;
  status?: string;
}
interface GaqlMetricsPart {
  costMicros?: string;
  clicks?: string;
  impressions?: string;
}
interface GaqlSegmentsPart {
  date?: string;
}
interface GaqlClickViewPart {
  gclid?: string;
}
interface GaqlRow {
  campaign?: GaqlCampaignPart;
  metrics?: GaqlMetricsPart;
  segments?: GaqlSegmentsPart;
  clickView?: GaqlClickViewPart;
}

/**
 * `GoogleAdsService.Search` (paged, IKKE streaming - enklere JSON-parsing i
 * en fetch-basert adapter, bekreftet-search-snippet REST-mønster:
 * `POST /v{version}/customers/{customerId}/googleAds:search`). Bounded
 * retry KUN på bekreftede retry-bare statuser (429/5xx) - ALDRI en
 * retry-storm (§"no retry storms" i byggeordren), eksponentiell backoff.
 * `developer-token`/`login-customer-id` i HEADERE (ALDRI i query-strengen/
 * URL-en) - samme "nøkkel i header, aldri URL"-sikkerhetsinvariant som
 * `gemini.ts`/`gemma.ts`.
 */
async function gaqlSearch(options: GaqlSearchOptions): Promise<GaqlRow[]> {
  const url = `https://googleads.googleapis.com/${options.apiVersion}/customers/${options.customerId}/googleAds:search`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${options.accessToken}`,
    "developer-token": options.developerToken
  };
  if (options.loginCustomerId) headers["login-customer-id"] = options.loginCustomerId;

  const rows: GaqlRow[] = [];
  let pageToken: string | undefined;
  do {
    const body = JSON.stringify({ query: options.query, ...(pageToken ? { pageToken } : {}) });
    let lastError: GoogleAdsApiError | undefined;
    let json: { results?: GaqlRow[]; nextPageToken?: string } | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await fetch(url, { method: "POST", headers, body });
      if (response.ok) {
        json = (await response.json()) as { results?: GaqlRow[]; nextPageToken?: string };
        lastError = undefined;
        break;
      }
      const rawBody = await response.text().catch(() => "");
      const retryable = RETRYABLE_HTTP_STATUS.has(response.status);
      lastError = new GoogleAdsApiError(`google_ads_api_error_${response.status}:${classifyGoogleAdsErrorBody(rawBody)}`, response.status, retryable);
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    if (lastError) throw lastError;
    rows.push(...(json?.results ?? []));
    pageToken = json?.nextPageToken;
  } while (pageToken);
  return rows;
}

/**
 * Google sin `campaign.status` (ENABLED/PAUSED/REMOVED) mappet DETERMINISTISK
 * til Jarvis sin `CampaignStatus`. `undefined` for UNKNOWN/UNSPECIFIED/andre
 * verdier - kalleren lar da EKSISTERENDE Jarvis-status stå urørt fremfor å
 * gjette (samme "udefinert forblir udefinert"-prinsipp som D-82).
 */
export function mapGoogleAdsCampaignStatus(raw: string | undefined): CampaignStatus | undefined {
  switch (raw) {
    case "ENABLED":
      return "active";
    case "PAUSED":
      return "paused";
    case "REMOVED":
      return "ended";
    default:
      return undefined;
  }
}

/**
 * `metrics.cost_micros` er millimonter av kontovalutaen (bekreftet
 * search-snippet: $15.50 -> 15500000). Jarvis sine `*_ore`-felt er
 * heltalls-minorenheter (1/100 av hovedenheten for de fleste valutaer,
 * inkl. NOK) - `micros / 10_000` konverterer korrekt for disse. Kjente,
 * dokumenterte grense (ikke skjult): valutaer uten et 1/100-minorenhets-
 * mønster (f.eks. JPY) ville trengt en annen faktor - samme eksisterende
 * antakelse resten av `marketing_spend_events`-skjemaet allerede gjør
 * (`027_growth.sql`, uendret her).
 */
export function microsToMinorUnits(costMicros: string | number | undefined): number {
  const micros = Number(costMicros ?? 0);
  if (!Number.isFinite(micros)) return 0;
  return Math.round(micros / 10_000);
}

export interface GoogleAdsSyncStats {
  scanned: number;
  synced: number;
  failed: number;
  errors: Array<{ external_campaign_id: string; reason: string }>;
}

function newStats(scanned: number): GoogleAdsSyncStats {
  return { scanned, synced: 0, failed: 0, errors: [] };
}

/** ALDRI et rått Error-objekt/stack videre til kalleren - kun en kort, allerede-sanert årsak (GrowthService sine egne feil er ALLEREDE trygge tekststrenger, ALDRI credentials). */
function sanitizeSyncError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return "unknown_error";
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`google_ads_missing_parameter:${key}`);
  return value;
}

/** Streng `YYYY-MM-DD`-validering FØR strenginterpolering inn i GAQL - GAQL har INGEN parameteriserte spørringer (bekreftet search-snippet), så dette er den eneste injeksjonsbeskyttelsen som finnes for datofelt. */
function requireDateString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) throw new Error(`google_ads_invalid_date_parameter:${key}`);
  return value;
}

export class GoogleAdsTransport implements ToolTransport {
  constructor(
    private readonly growth: GrowthService,
    private readonly defaultCustomerId: string | undefined = process.env["JARVIS_GOOGLE_ADS_CUSTOMER_ID"],
    private readonly developerToken: string | undefined = process.env["JARVIS_GOOGLE_ADS_DEVELOPER_TOKEN"],
    private readonly loginCustomerId: string | undefined = process.env["JARVIS_GOOGLE_ADS_LOGIN_CUSTOMER_ID"],
    private readonly apiVersion: string = process.env["JARVIS_GOOGLE_ADS_API_VERSION"] ?? DEFAULT_API_VERSION
  ) {}

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;
    const customerId = parameters["customer_id"] !== undefined ? String(parameters["customer_id"]) : this.defaultCustomerId;
    if (!customerId) throw new Error("google_ads_customer_id_not_configured");
    if (!this.developerToken) throw new Error("google_ads_developer_token_not_configured");
    // Access-tokenet hentes ÉN gang per invoke() - gjenbrukt for eventuell paginering INNENFOR samme handling (googleAccessToken() sin egen feilklassifisering/HOST-FIX-presedens forblir uendret, gjenbrukt her, ikke duplisert).
    const accessToken = await googleAccessToken(credential);

    switch (action) {
      case "list_campaigns": {
        const campaigns = await this.fetchCampaigns(customerId, accessToken);
        return { data: campaigns as unknown as JsonValue };
      }
      case "sync_campaigns": {
        const campaigns = await this.fetchCampaigns(customerId, accessToken);
        const stats = await this.syncCampaigns(tenantId, memorySpace, campaigns);
        return { data: stats as unknown as JsonValue };
      }
      case "sync_spend": {
        const startDate = requireDateString(parameters, "start_date");
        const endDate = requireDateString(parameters, "end_date");
        const rows = await this.fetchSpend(customerId, accessToken, startDate, endDate);
        const stats = await this.syncSpend(tenantId, memorySpace, customerId, rows);
        return { data: stats as unknown as JsonValue };
      }
      case "sync_tracking_tags": {
        const date = requireDateString(parameters, "date");
        const rows = await this.fetchClickViews(customerId, accessToken, date);
        const stats = await this.syncTrackingTags(tenantId, memorySpace, rows);
        return { data: stats as unknown as JsonValue };
      }
      default:
        throw new Error(`google_ads_action_not_implemented:${action}`);
    }
  }

  private gaqlOptions(customerId: string, accessToken: string, query: string): GaqlSearchOptions {
    return {
      customerId,
      accessToken,
      developerToken: this.developerToken!,
      loginCustomerId: this.loginCustomerId,
      apiVersion: this.apiVersion,
      query
    };
  }

  private async fetchCampaigns(customerId: string, accessToken: string): Promise<Array<{ external_campaign_id: string; name: string; status: CampaignStatus | undefined }>> {
    const rows = await gaqlSearch(this.gaqlOptions(customerId, accessToken, "SELECT campaign.id, campaign.name, campaign.status FROM campaign"));
    return rows
      .map((r) => ({ external_campaign_id: String(r.campaign?.id ?? ""), name: r.campaign?.name ?? "", status: mapGoogleAdsCampaignStatus(r.campaign?.status) }))
      .filter((c) => c.external_campaign_id.length > 0);
  }

  private async syncCampaigns(
    tenantId: string,
    memorySpace: MemorySpace,
    campaigns: Array<{ external_campaign_id: string; name: string; status: CampaignStatus | undefined }>
  ): Promise<GoogleAdsSyncStats> {
    const stats = newStats(campaigns.length);
    for (const c of campaigns) {
      try {
        await this.growth.upsertCampaignFromProvider(tenantId, memorySpace, {
          channel: "google_ads",
          external_campaign_id: c.external_campaign_id,
          name: c.name,
          ...(c.status !== undefined ? { status: c.status } : {})
        });
        stats.synced++;
      } catch (error) {
        stats.failed++;
        stats.errors.push({ external_campaign_id: c.external_campaign_id, reason: sanitizeSyncError(error) });
      }
    }
    return stats;
  }

  private async fetchSpend(
    customerId: string,
    accessToken: string,
    startDate: string,
    endDate: string
  ): Promise<Array<{ external_campaign_id: string; name: string; status: CampaignStatus | undefined; event_date: string; cost_micros: string | undefined; clicks: number | undefined; impressions: number | undefined }>> {
    const query = `SELECT campaign.id, campaign.name, campaign.status, segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions FROM campaign WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'`;
    const rows = await gaqlSearch(this.gaqlOptions(customerId, accessToken, query));
    return rows
      .map((r) => ({
        external_campaign_id: String(r.campaign?.id ?? ""),
        name: r.campaign?.name ?? "",
        status: mapGoogleAdsCampaignStatus(r.campaign?.status),
        event_date: r.segments?.date ?? "",
        cost_micros: r.metrics?.costMicros,
        clicks: r.metrics?.clicks !== undefined ? Number(r.metrics.clicks) : undefined,
        impressions: r.metrics?.impressions !== undefined ? Number(r.metrics.impressions) : undefined
      }))
      .filter((r) => r.external_campaign_id.length > 0 && r.event_date.length > 0);
  }

  private async syncSpend(
    tenantId: string,
    memorySpace: MemorySpace,
    customerId: string,
    rows: Array<{ external_campaign_id: string; name: string; status: CampaignStatus | undefined; event_date: string; cost_micros: string | undefined; clicks: number | undefined; impressions: number | undefined }>
  ): Promise<GoogleAdsSyncStats> {
    const stats = newStats(rows.length);
    for (const r of rows) {
      try {
        const campaign = await this.growth.upsertCampaignFromProvider(tenantId, memorySpace, {
          channel: "google_ads",
          external_campaign_id: r.external_campaign_id,
          name: r.name,
          ...(r.status !== undefined ? { status: r.status } : {})
        });
        await this.growth.recordSpendEvent(tenantId, memorySpace, campaign.campaign_id, {
          event_date: r.event_date,
          spend_amount_ore: microsToMinorUnits(r.cost_micros),
          source_type: "provider_sync",
          ...(r.clicks !== undefined ? { clicks: r.clicks } : {}),
          ...(r.impressions !== undefined ? { impressions: r.impressions } : {}),
          source_pointer: `googleads:customers/${customerId}/campaigns/${r.external_campaign_id}`
        });
        stats.synced++;
      } catch (error) {
        stats.failed++;
        stats.errors.push({ external_campaign_id: r.external_campaign_id, reason: sanitizeSyncError(error) });
      }
    }
    return stats;
  }

  /**
   * `click_view` MÅ filtreres til ÉN enkelt `segments.date` (bekreftet
   * search-snippet-begrensning) - kalleren styrer datoen eksplisitt per
   * kall, ALDRI et implisitt/ubegrenset tidsvindu.
   */
  private async fetchClickViews(customerId: string, accessToken: string, date: string): Promise<Array<{ external_campaign_id: string; gclid: string }>> {
    const query = `SELECT campaign.id, click_view.gclid, segments.date FROM click_view WHERE segments.date = '${date}'`;
    const rows = await gaqlSearch(this.gaqlOptions(customerId, accessToken, query));
    return rows
      .map((r) => ({ external_campaign_id: String(r.campaign?.id ?? ""), gclid: r.clickView?.gclid ?? "" }))
      .filter((r) => r.external_campaign_id.length > 0 && r.gclid.length > 0);
  }

  /**
   * Krever at kampanjen ALLEREDE er synket (`sync_campaigns` kjørt FØRST) -
   * oppretter BEVISST INGEN "tynn"/uten-navn kampanjerad her (ville brutt
   * "aldri fabriker data" - en kampanje uten et ekte, hentet navn er verre
   * enn en tydelig `campaign_not_yet_synced`-feilrad per klikk).
   */
  private async syncTrackingTags(tenantId: string, memorySpace: MemorySpace, rows: Array<{ external_campaign_id: string; gclid: string }>): Promise<GoogleAdsSyncStats> {
    const stats = newStats(rows.length);
    const seenGclids = new Set<string>();
    for (const r of rows) {
      if (seenGclids.has(r.gclid)) continue;
      seenGclids.add(r.gclid);
      try {
        const campaign = await this.growth.findCampaignByExternalId(tenantId, memorySpace, "google_ads", r.external_campaign_id);
        if (!campaign) {
          stats.failed++;
          stats.errors.push({ external_campaign_id: r.external_campaign_id, reason: "campaign_not_yet_synced" });
          continue;
        }
        await this.growth.registerCampaignTrackingTag(tenantId, memorySpace, campaign.campaign_id, { click_id_param: "gclid", click_id_value: r.gclid });
        stats.synced++;
      } catch (error) {
        stats.failed++;
        stats.errors.push({ external_campaign_id: r.external_campaign_id, reason: sanitizeSyncError(error) });
      }
    }
    return stats;
  }
}

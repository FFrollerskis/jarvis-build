import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolTransport } from "@jarvis/tool-gateway";
import type { GrowthService } from "./service.ts";
import type { CampaignStatus } from "./types.ts";

/**
 * D-335 (UA-4 Meta Ads-slice, TOTREKKER-D-64-port fra D-316-notatet i
 * PROJECT_STATUS.md): ANDRE ekte leverandøradapter for Growth Core, SAMME
 * arkitektur som `GoogleAdsTransport` (D-83/D-84) - Meta Ads er en ADAPTER
 * (D-64), IKKE en frittstående `ToolGateway`-connector med egne rå
 * handlinger. `marketing_campaigns`/`marketing_spend_events`/
 * `marketing_campaign_tracking_tags` forblir `JARVIS_CANONICAL`, uendret av
 * denne filen; kampanje-serveringstilstand/rå utgift/klikk/visning er
 * `EXTERNAL_CANONICAL` FAKTA denne adapteren henter og videresender - ALDRI
 * Jarvis sin egen mening om dem. `"meta_ads"`/`"fbclid"` fantes ALLEREDE som
 * gyldige verdier i `CampaignChannel`/`ClickIdParam` (`types.ts`) - ingen
 * skjemaendring nødvendig, D-64-porten var allerede lukket av D-83/D-84 sin
 * presedens (bekreftet av D-64-undersøkelsen som fant `modules/growth` sin
 * eksisterende adapter-arkitektur FØR denne filen ble skrevet).
 *
 * D-41-verifiseringsstatus (viktig - se D-335 i DECISIONS_AND_ASSUMPTIONS.md
 * for full begrunnelse): `WebSearch` (IKKE `WebFetch` - nettverksegress mot
 * `developers.facebook.com` selv ble IKKE forsøkt direkte) BLE brukt denne
 * økten og returnerte FLERE uavhengige, innbyrdes konsistente kilder for
 * hvert punkt under - klassifisert `VERIFIED_SEARCH_SNIPPET` (samme nivå som
 * D-83 sin opprinnelige klassifisering), IKKE `VERIFIED_PRIMARY_SOURCE`:
 *   - Endepunkt/versjon: `https://graph.facebook.com/v26.0/act_{ad_account_id}/
 *     campaigns` og `.../insights` (Graph API v26.0 er gjeldende versjon,
 *     utgitt 29. juli 2026).
 *   - Autentisering: `access_token` som QUERY-PARAMETER (IKKE en
 *     `Authorization`-header - EN TREDJE, STRUKTURELT ULIK auth-form i denne
 *     familien, etter Google Ads sin Bearer-header-etter-refresh-utveksling
 *     og Pipedrive sin `x-api-token`-header). Et system-bruker-langlivet
 *     token (anbefalt for server-til-server-bruk) utløper IKKE tidsbasert -
 *     INGEN per-kall token-utveksling er derfor nødvendig (ULIKT Google Ads
 *     sin `googleAccessToken()`-refresh-flyt) - `credential`-parameteren
 *     brukes DIREKTE som access_token.
 *   - `campaign.status`: ACTIVE/PAUSED/ARCHIVED/DELETED (bekreftet
 *     search-snippet).
 *   - `insights.spend`: en DESIMAL-STRENG i kontovalutaen (f.eks. "5339.5"),
 *     IKKE mikroenheter som Google Ads sin `cost_micros` - EGEN
 *     konverteringsfunksjon (`decimalCurrencyToMinorUnits`), ALDRI
 *     `microsToMinorUnits` gjenbrukt feilaktig på tvers av leverandører.
 *   - Feilkonvolutt: `{error:{message,type,code,error_subcode,fbtrace_id}}`
 *     (bekreftet search-snippet, strukturelt likt, men IKKE identisk med
 *     Google sin `{error:{code,message,status}}`).
 *   - Paginering: markør-basert via `paging.next` (en FULLSTENDIG URL,
 *     inkludert access_token) - fravær av `paging.next` betyr siste side.
 *
 * Kapabiliteter som er BEVISST STOPPET (ikke bygget), fremfor gjettet -
 * SAMME D-41-disiplin som Google Ads sin `sync_tracking_tags`-eksklusjon av
 * mutate/offline-opplasting:
 *   - **`sync_tracking_tags` (fbclid) er IKKE implementert i denne
 *     sliceen.** Google Ads har en dedikert, søkbar `click_view`-ressurs for
 *     gclid; INGEN strukturelt ekvivalent, direkte spørrbar
 *     fbclid-per-klikk-ressurs ble bekreftet for Meta Marketing API i denne
 *     økten (fbclid inngår typisk i Conversions API-hendelser/UTM-lenker,
 *     IKKE i et `campaign`/`insights`-spørrbart felt) - BEVISST STOPPET
 *     fremfor å gjette et endepunkt. `"fbclid"` FORBLIR en gyldig
 *     `ClickIdParam`-verdi i skjemaet (uendret) for en FREMTIDIG slice som
 *     bekrefter riktig kilde.
 *   - Mutate/skriving (kampanje-/budsjett-endring): IKKE implementert -
 *     SAMME Finance Integrity-grense og D-41-STOPP-begrunnelse som Google
 *     Ads (ingen bekreftet idempotens-mekanisme for mutate-kall funnet).
 *   - Nøyaktig rate-limit-tall: IKKE bekreftet til et presist tall
 *     (søkeresultatene sier kun "spend-basert, sjenerøst for normale
 *     arbeidsflyter") - INGEN oppdiktet grense brukt; kun generisk
 *     eksponentiell backoff på bekreftede retry-bare HTTP-statuser (429/5xx).
 * Kapabiliteter som ER implementert (kampanje-lesing, daglig utgift/klikk/
 * visning-lesing via Insights, status-mapping, paginering, feilmodell)
 * hviler på FLERE uavhengige søkekilder som var konsistente med hverandre -
 * se D-335 for kildeliste.
 *
 * INGEN offisiell Node/TypeScript Meta Marketing-klient med Jarvis sin egen
 * fetch()-only-konvensjon finnes - rå REST via `fetch()` er BEVISST valgt
 * fremfor en tredjeparts-SDK-avhengighet, SAMME "ingen ny SDK uten
 * begrunnelse"-prinsipp som CLAUDE.md regel 3 krever (identisk begrunnelse
 * som `google-ads-transport.ts`).
 */

const DEFAULT_API_VERSION = "v26.0";
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_PAGES = 50;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class MetaAdsApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "MetaAdsApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tolerant JSON-parsing av Meta sin generiske API-feilkonvolutt
 * (`{error:{type,code,message}}`) - avkortet (200 tegn, samme presedens som
 * `classifyGoogleAdsErrorBody`), ALDRI rå kropp/headere videre.
 */
function classifyMetaAdsErrorBody(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { type?: string; code?: number; message?: string } };
    const type = parsed.error?.type ?? "UNKNOWN";
    const code = parsed.error?.code !== undefined ? String(parsed.error.code) : "?";
    const message = (parsed.error?.message ?? "").slice(0, 200);
    return message ? `${type}:${code}:${message}` : `${type}:${code}`;
  } catch {
    return "UNCLASSIFIED_ERROR_BODY";
  }
}

interface MetaGraphRow {
  id?: string;
  name?: string;
  status?: string;
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  clicks?: string;
  impressions?: string;
  date_start?: string;
}

interface MetaGraphPage {
  data?: MetaGraphRow[];
  paging?: { next?: string };
}

/**
 * Bounded, markør-basert henting (`paging.next` - en FULLSTENDIG URL som
 * ALLEREDE inneholder access_token, ALDRI rekonstruert manuelt her) - KUN
 * retry på bekreftede retry-bare statuser (429/5xx), ALDRI en retry-storm,
 * ALDRI en uendelig pagineringsløkke (`MAX_PAGES`-grense, samme forsvars-
 * prinsipp som Google Ads sin `MAX_ATTEMPTS`).
 */
async function metaGraphGetAllPages(initialUrl: string): Promise<MetaGraphRow[]> {
  const rows: MetaGraphRow[] = [];
  let url: string | undefined = initialUrl;
  let pages = 0;
  while (url && pages < MAX_PAGES) {
    pages++;
    let lastError: MetaAdsApiError | undefined;
    let page: MetaGraphPage | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await fetch(url);
      if (response.ok) {
        page = (await response.json()) as MetaGraphPage;
        lastError = undefined;
        break;
      }
      const rawBody = await response.text().catch(() => "");
      const retryable = RETRYABLE_HTTP_STATUS.has(response.status);
      lastError = new MetaAdsApiError(`meta_ads_api_error_${response.status}:${classifyMetaAdsErrorBody(rawBody)}`, response.status, retryable);
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    if (lastError) throw lastError;
    rows.push(...(page?.data ?? []));
    url = page?.paging?.next;
  }
  return rows;
}

/**
 * Meta sin `campaign.status` (ACTIVE/PAUSED/ARCHIVED/DELETED) mappet
 * DETERMINISTISK til Jarvis sin `CampaignStatus`. `undefined` for
 * ukjente/andre verdier - kalleren lar da EKSISTERENDE Jarvis-status stå
 * urørt fremfor å gjette (SAMME "udefinert forblir udefinert"-prinsipp som
 * `mapGoogleAdsCampaignStatus`, D-82).
 */
export function mapMetaAdsCampaignStatus(raw: string | undefined): CampaignStatus | undefined {
  switch (raw) {
    case "ACTIVE":
      return "active";
    case "PAUSED":
      return "paused";
    case "ARCHIVED":
    case "DELETED":
      return "ended";
    default:
      return undefined;
  }
}

/**
 * Meta sitt `spend`-felt er en DESIMAL-STRENG i kontovalutaen (bekreftet
 * search-snippet: "15.50" -> 15.50 kr), IKKE mikroenheter som Google Ads.
 * Jarvis sine `*_ore`-felt er heltalls-minorenheter (1/100 av hovedenheten)
 * - `round(parseFloat(spend) * 100)` konverterer korrekt for disse. SAMME
 * kjente, dokumenterte JPY-lignende-valuta-grense som
 * `microsToMinorUnits` allerede har (uendret antakelse i `027_growth.sql`).
 */
export function decimalCurrencyToMinorUnits(spend: string | number | undefined): number {
  const value = typeof spend === "number" ? spend : Number(spend ?? 0);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

export interface MetaAdsSyncStats {
  scanned: number;
  synced: number;
  failed: number;
  errors: Array<{ external_campaign_id: string; reason: string }>;
}

function newStats(scanned: number): MetaAdsSyncStats {
  return { scanned, synced: 0, failed: 0, errors: [] };
}

/** ALDRI et rått Error-objekt/stack videre til kalleren - kun en kort, allerede-sanert årsak (GrowthService sine egne feil er ALLEREDE trygge tekststrenger, ALDRI credentials). */
function sanitizeSyncError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return "unknown_error";
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`meta_ads_missing_parameter:${key}`);
  return value;
}

/** Streng `YYYY-MM-DD`-validering FØR bruk i `time_range` - samme forsiktighetsprinsipp som Google Ads sin GAQL-dato-validering, selv om `URLSearchParams` her allerede unngår injeksjon strukturelt. */
function requireDateString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) throw new Error(`meta_ads_invalid_date_parameter:${key}`);
  return value;
}

export class MetaAdsTransport implements ToolTransport {
  constructor(
    private readonly growth: GrowthService,
    private readonly defaultAdAccountId: string | undefined = process.env["JARVIS_META_ADS_AD_ACCOUNT_ID"],
    // Remediering del 1 (JARVIS-083/092): en blank `KEY=` i .env er IKKE en versjon - tom/usatt = default.
    private readonly apiVersion: string = (process.env["JARVIS_META_ADS_API_VERSION"] ?? "").trim() || DEFAULT_API_VERSION
  ) {}

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;
    const adAccountId = parameters["ad_account_id"] !== undefined ? String(parameters["ad_account_id"]) : this.defaultAdAccountId;
    if (!adAccountId) throw new Error("meta_ads_ad_account_id_not_configured");

    switch (action) {
      case "list_campaigns": {
        const campaigns = await this.fetchCampaigns(adAccountId, credential);
        return { data: campaigns as unknown as JsonValue };
      }
      case "sync_campaigns": {
        const campaigns = await this.fetchCampaigns(adAccountId, credential);
        const stats = await this.syncCampaigns(tenantId, memorySpace, campaigns);
        return { data: stats as unknown as JsonValue };
      }
      case "sync_spend": {
        const startDate = requireDateString(parameters, "start_date");
        const endDate = requireDateString(parameters, "end_date");
        const rows = await this.fetchSpend(adAccountId, credential, startDate, endDate);
        const stats = await this.syncSpend(tenantId, memorySpace, adAccountId, rows);
        return { data: stats as unknown as JsonValue };
      }
      default:
        throw new Error(`meta_ads_action_not_implemented:${action}`);
    }
  }

  private graphUrl(path: string, adAccountId: string, credential: string, extraParams: Record<string, string>): string {
    const url = new URL(`https://graph.facebook.com/${this.apiVersion}/act_${adAccountId}/${path}`);
    for (const [key, value] of Object.entries(extraParams)) url.searchParams.set(key, value);
    url.searchParams.set("access_token", credential);
    return url.toString();
  }

  private async fetchCampaigns(adAccountId: string, credential: string): Promise<Array<{ external_campaign_id: string; name: string; status: CampaignStatus | undefined }>> {
    const url = this.graphUrl("campaigns", adAccountId, credential, { fields: "id,name,status" });
    const rows = await metaGraphGetAllPages(url);
    return rows
      .map((r) => ({ external_campaign_id: String(r.id ?? ""), name: r.name ?? "", status: mapMetaAdsCampaignStatus(r.status) }))
      .filter((c) => c.external_campaign_id.length > 0);
  }

  private async syncCampaigns(
    tenantId: string,
    memorySpace: MemorySpace,
    campaigns: Array<{ external_campaign_id: string; name: string; status: CampaignStatus | undefined }>
  ): Promise<MetaAdsSyncStats> {
    const stats = newStats(campaigns.length);
    for (const c of campaigns) {
      try {
        await this.growth.upsertCampaignFromProvider(tenantId, memorySpace, {
          channel: "meta_ads",
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

  /**
   * `level=campaign`+`time_increment=1` gir ÉN rad per (kampanje, dag) -
   * `campaign.status` er BEVISST IKKE inkludert her (Insights-ressursen
   * eksponerer ikke status) - `upsertCampaignFromProvider` sitt `status`-
   * felt utelates derfor i `syncSpend` (eksisterende Jarvis-status står
   * urørt, SAMME "udefinert forblir udefinert"-prinsipp, IKKE et ekstra
   * `fetchCampaigns()`-kall kun for å late som status var kjent her).
   */
  private async fetchSpend(
    adAccountId: string,
    credential: string,
    startDate: string,
    endDate: string
  ): Promise<Array<{ external_campaign_id: string; name: string; event_date: string; spend: string | undefined; clicks: number | undefined; impressions: number | undefined }>> {
    const timeRange = JSON.stringify({ since: startDate, until: endDate });
    const url = this.graphUrl("insights", adAccountId, credential, {
      level: "campaign",
      time_increment: "1",
      time_range: timeRange,
      fields: "campaign_id,campaign_name,spend,clicks,impressions,date_start"
    });
    const rows = await metaGraphGetAllPages(url);
    return rows
      .map((r) => ({
        external_campaign_id: String(r.campaign_id ?? ""),
        name: r.campaign_name ?? "",
        event_date: r.date_start ?? "",
        spend: r.spend,
        clicks: r.clicks !== undefined ? Number(r.clicks) : undefined,
        impressions: r.impressions !== undefined ? Number(r.impressions) : undefined
      }))
      .filter((r) => r.external_campaign_id.length > 0 && r.event_date.length > 0);
  }

  private async syncSpend(
    tenantId: string,
    memorySpace: MemorySpace,
    adAccountId: string,
    rows: Array<{ external_campaign_id: string; name: string; event_date: string; spend: string | undefined; clicks: number | undefined; impressions: number | undefined }>
  ): Promise<MetaAdsSyncStats> {
    const stats = newStats(rows.length);
    for (const r of rows) {
      try {
        const campaign = await this.growth.upsertCampaignFromProvider(tenantId, memorySpace, {
          channel: "meta_ads",
          external_campaign_id: r.external_campaign_id,
          name: r.name
        });
        await this.growth.recordSpendEvent(tenantId, memorySpace, campaign.campaign_id, {
          event_date: r.event_date,
          spend_amount_ore: decimalCurrencyToMinorUnits(r.spend),
          source_type: "provider_sync",
          ...(r.clicks !== undefined ? { clicks: r.clicks } : {}),
          ...(r.impressions !== undefined ? { impressions: r.impressions } : {}),
          source_pointer: `metaads:act_${adAccountId}/campaigns/${r.external_campaign_id}`
        });
        stats.synced++;
      } catch (error) {
        stats.failed++;
        stats.errors.push({ external_campaign_id: r.external_campaign_id, reason: sanitizeSyncError(error) });
      }
    }
    return stats;
  }
}

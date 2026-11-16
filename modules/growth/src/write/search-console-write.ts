import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { normalizeGrowthTarget } from "./config.ts";
import { VendorHttp } from "./http.ts";
import { cleanText, removeOp } from "./op-builders.ts";
import { GoogleOAuthTransport, type GoogleRestOptions } from "./google-rest.ts";
import type { Auth, OpSpec, ProviderToolSpec } from "./tool-factory.ts";
import { asArr, asObj, num, str, type Params } from "./validators.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): Google Search Console - nettstedskart (sitemaps), søkeanalyse og URL-inspeksjon. Nytt navnerom `growth_searchconsole` (eier-eksklusivt, forbudt for modellflater); eget
 * refresh-token `JARVIS_GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN`, scope `https://www.googleapis.com/auth/webmasters` (full tilgang; `webmasters.readonly` ville gitt kun lesing).
 * D-41 (`VERIFIED_OFFICIAL_SEARCH_SNIPPET`): `sitemaps.submit` = PUT `/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}`, `sitemaps.delete` = DELETE samme sti; URL-inspeksjon har fast kvote 2000/dag og 600/min per
 * nettsted; søkeanalyse 1200/min per nettsted. Utdata fra søkeanalyse/inspeksjon er UBETRODDE data (søkeord er brukerskrevet tekst).
 * DEFERRED: `sites.add`/`sites.delete` (eierskap/verifisering har egen flyt og er ikke en vekstoppgave), indekseringsvarsel (Indexing API gjelder kun jobb-/direktesendt-sider).
 */
const BASE_URL = "https://www.googleapis.com/webmasters/v3";
const INSPECT_BASE_URL = "https://searchconsole.googleapis.com/v1";
const DIMENSIONS = ["date", "query", "page", "country", "device", "searchAppearance"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const siteOf = (p: Params): string => {
  const v = normalizeGrowthTarget("search_console", p["site_url"]);
  if (v === null) throw new Error("growth_invalid_site_url");
  return v;
};
const safeSite = (p: Params): string => normalizeGrowthTarget("search_console", p["site_url"]) ?? "?";
const siteShape = { site_url: z.string().min(8).max(260) };
const sitemapsOf = (s: JsonValue): Array<Record<string, unknown>> => asArr(asObj(s)["sitemaps"]).map(asObj);
const enc = (v: string): string => encodeURIComponent(v);

/** Hører URL-en til eiendommen? URL-prefiks: samme opprinnelse og sti-prefiks. Domeneeiendom: verten er domenet eller et underdomene. */
export function urlBelongsToSite(site: string, url: unknown): boolean {
  if (typeof url !== "string" || url.length > 2048) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return false;
  if (site.startsWith("sc-domain:")) {
    const domain = site.slice("sc-domain:".length).toLowerCase();
    return parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`);
  }
  return parsed.href.toLowerCase().startsWith(site.toLowerCase());
}

export function searchConsoleWriteSpec(): ProviderToolSpec {
  const scopes = ["searchconsole.write"];
  const readScopes = ["searchconsole.read"];
  const ops: OpSpec[] = [
    { action: "list_sitemaps", description: "List nettstedskartene som er sendt inn for en Search Console-eiendom (status, advarsler, feil) - ubetrodd leverandørdata", shape: siteShape, risk: "A", targetParam: "site_url", scopes: readScopes },
    {
      action: "query_search_analytics", risk: "A", targetParam: "site_url", scopes: readScopes,
      description: "Hent søkeanalyse (klikk, visninger, CTR, posisjon) for en eiendom og periode. Søkeord er brukerskrevet tekst = ubetrodd data. Maks 1000 rader.",
      shape: {
        ...siteShape, start_date: z.string().regex(DATE), end_date: z.string().regex(DATE), dimensions: z.array(z.enum(DIMENSIONS)).max(3).optional(), row_limit: z.number().int().min(1).max(1000).optional()
      }
    },
    {
      action: "inspect_url", risk: "A", targetParam: "site_url", scopes: readScopes,
      description: "Inspiser indekseringsstatus for en URL under eiendommen (kvote: 2000/dag og 600/min per nettsted). Utdata er ubetrodd data.",
      shape: { ...siteShape, inspection_url: z.string().url().max(2048) }
    },
    {
      action: "register_sitemap", risk: "C", spend: "none", targetParam: "site_url", stateAction: "list_sitemaps", scopes,
      description: "Send inn (registrer) et nettstedskart for eiendommen. Idempotent: finnes det allerede, gjøres ingenting.",
      shape: { ...siteShape, feedpath: z.string().url().max(2048) },
      rollback: "remove_sitemap med samme feedpath fjerner innsendingen igjen (selve nettstedskartet på nettstedet røres ikke)",
      validate: (_s, p) => (urlBelongsToSite(safeSite(p), p["feedpath"]) ? null : "feedpath_not_under_site"),
      noop: (s, p) => sitemapsOf(s).some((m) => m["path"] === p["feedpath"]),
      post: (a, p) => sitemapsOf(a).some((m) => m["path"] === p["feedpath"]),
      target: (p) => `searchconsole:${safeSite(p)}:sitemap:${typeof p["feedpath"] === "string" ? (p["feedpath"] as string).slice(0, 200) : "?"}`,
      summary: (_s, p) => `Search Console: send inn nettstedskart for ${safeSite(p)}`
    },
    removeOp({
      action: "remove_sitemap", label: "Search Console-nettstedskart", spend: "none", stateAction: "list_sitemaps", targetParam: "site_url", risk: "C", scopes,
      shape: { ...siteShape, feedpath: z.string().url().max(2048) },
      statusOf: (s, p) => (sitemapsOf(s).some((m) => m["path"] === p["feedpath"]) ? "PRESENT" : "REMOVED"), targetCheck: () => true, removed: ["REMOVED"],
      ref: (p) => `searchconsole:${safeSite(p)}:sitemap:${typeof p["feedpath"] === "string" ? (p["feedpath"] as string).slice(0, 200) : "?"}`,
      rollback: "register_sitemap med samme feedpath sender inn nettstedskartet på nytt"
    })
  ];
  return { provider: "search_console", toolId: "growth_searchconsole", credentialRef: "JARVIS_GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN", ops };
}

export class SearchConsoleWriteTransport extends GoogleOAuthTransport {
  protected readonly label = "search_console";
  private readonly http: VendorHttp;
  private readonly inspectHttp: VendorHttp;

  constructor(options: GoogleRestOptions & { inspectBaseUrl?: string }) {
    super(options);
    const sleep = options.sleep ? { sleep: options.sleep } : {};
    this.http = new VendorHttp({ label: "search_console", baseUrl: options.baseUrl ?? BASE_URL, ...sleep });
    this.inspectHttp = new VendorHttp({ label: "search_console", baseUrl: options.inspectBaseUrl ?? options.baseUrl ?? INSPECT_BASE_URL, ...sleep });
  }

  protected async readState(action: string, p: Params, auth: Auth): Promise<JsonValue | null> {
    const site = siteOf(p);
    switch (action) {
      case "list_sitemaps": {
        const res = await this.http.request({ method: "GET", path: `/sites/${enc(site)}/sitemaps`, headers: auth.headers, secrets: auth.secrets, allowNotFound: true });
        if (res === null) return null;
        const sitemaps = asArr(asObj(res.json)["sitemap"]).slice(0, 200).map((raw) => {
          const m = asObj(raw);
          return { path: str(m["path"]), last_submitted: str(m["lastSubmitted"]), is_pending: m["isPending"] === true, is_sitemaps_index: m["isSitemapsIndex"] === true, warnings: num(m["warnings"]), errors: num(m["errors"]) };
        });
        return { site_url: site, sitemaps };
      }
      case "query_search_analytics": {
        const start = String(p["start_date"]);
        const end = String(p["end_date"]);
        if (!DATE.test(start) || !DATE.test(end) || start > end) throw new Error("growth_invalid_date_range");
        const dimensions = asArr(p["dimensions"]).filter((d): d is string => typeof d === "string");
        const rowLimit = typeof p["row_limit"] === "number" ? Math.min(1000, Math.max(1, Math.trunc(p["row_limit"]))) : 100;
        const res = await this.http.request({
          method: "POST", path: `/sites/${enc(site)}/searchAnalytics/query`, headers: auth.headers, secrets: auth.secrets, allowNotFound: true,
          body: { startDate: start, endDate: end, ...(dimensions.length > 0 ? { dimensions } : {}), rowLimit }
        });
        if (res === null) return null;
        const rows = asArr(asObj(res.json)["rows"]).slice(0, rowLimit).map((raw) => {
          const r = asObj(raw);
          return { keys: asArr(r["keys"]).map((k) => cleanText(k, 200)), clicks: num(r["clicks"]), impressions: num(r["impressions"]), ctr: num(r["ctr"]), position: num(r["position"]) };
        });
        return { site_url: site, start_date: start, end_date: end, dimensions, rows };
      }
      case "inspect_url": {
        if (!urlBelongsToSite(site, p["inspection_url"])) throw new Error("growth_inspection_url_not_under_site");
        const res = await this.inspectHttp.request({
          method: "POST", path: "/urlInspection/index:inspect", headers: auth.headers, secrets: auth.secrets,
          body: { inspectionUrl: String(p["inspection_url"]), siteUrl: site, languageCode: "nb" }
        });
        const idx = asObj(asObj(asObj(res?.json)["inspectionResult"])["indexStatusResult"]);
        return {
          site_url: site, verdict: str(idx["verdict"]), coverage_state: cleanText(idx["coverageState"]), indexing_state: str(idx["indexingState"]), robots_txt_state: str(idx["robotsTxtState"]),
          last_crawl_time: str(idx["lastCrawlTime"]), google_canonical: cleanText(idx["googleCanonical"], 2048), user_canonical: cleanText(idx["userCanonical"], 2048)
        };
      }
      default:
        throw new Error(`search_console_action_not_implemented:${action}`);
    }
  }

  protected async applyWrite(action: string, p: Params, auth: Auth): Promise<{ external_id?: string; data?: JsonValue }> {
    const site = siteOf(p);
    const feed = String(p["feedpath"]);
    switch (action) {
      case "register_sitemap":
        await this.http.request({ method: "PUT", path: `/sites/${enc(site)}/sitemaps/${enc(feed)}`, headers: auth.headers, secrets: auth.secrets, mutation: true });
        return { external_id: feed.slice(0, 200) };
      case "remove_sitemap":
        await this.http.request({ method: "DELETE", path: `/sites/${enc(site)}/sitemaps/${enc(feed)}`, headers: auth.headers, secrets: auth.secrets, mutation: true });
        return { external_id: feed.slice(0, 200) };
      default:
        throw new Error(`search_console_action_not_implemented:${action}`);
    }
  }
}

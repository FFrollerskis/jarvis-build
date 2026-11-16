import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { googleAccessToken } from "@jarvis/tool-gateway";
import { creativeHref, creativeHrefOrRaw, creativeUrlHost, normalizeGrowthTarget, type GrowthWriteConfig } from "./config.ts";
import { VendorHttp } from "./http.ts";
import { cleanText, directionalAmountCheck, pauseEnableOps, removeOp } from "./op-builders.ts";
import { GrowthWriteTransportBase, killSwitchOpen, type Auth, type OpSpec, type ProviderToolSpec, type WriteTransportDeps } from "./tool-factory.ts";
import { asArr, asObj, assertDigits, assertOre, num, oreToMicros, sameStringSet, str, zDigits, zOre, zText, MICROS_PER_ORE, type Params } from "./validators.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): Google Ads SKRIVING (budsjett, bud, kampanje-/annonsegruppe-/annonse-/nøkkelordstatus, nøkkelord, responsive søkeannonser). Rå REST + GAQL via `VendorHttp`
 * (ingen SDK, regel 3) mot `googleads.googleapis.com`. Utvider den EKSISTERENDE lese-connectoren (`GoogleAdsTransport`, samme refresh-token `JARVIS_GOOGLE_ADS_REFRESH_TOKEN`, samme utviklertoken-/
 * login-kunde-konfig); skrivehandlingene bor i EGET navnerom `growth_googleads` (eier-eksklusivt, forbudt for alle modellflater), slik at lese-/synk-handlingene på chat-nivåene er uendret.
 *
 * D-41-STATUS (alt under er `VERIFIED_OFFICIAL_SEARCH_SNIPPET`, IKKE primærkilde - WebFetch mot developers.google.com er blokkert; se runbook §D-41-revisjon):
 *  - REST `POST /v{N}/customers/{id}/{ressurs}:mutate` med `operations[]` (`create`/`update`+`updateMask`/`remove`), atomisk uten `partialFailure`; beløp i mikroenheter som STRENG (int64).
 *  - INGEN idempotensnøkkel finnes hos leverandøren: idempotens = tilstandslesing før skriving + absolutt-tilstand-oppdateringer + readback + opprettelser dedupet mot eksisterende (nøkkelord/RSA).
 *  - `REMOVED` er terminal (kan ikke aktiveres igjen). Developer token: testkonto-tilgang -> Basic (15 000 operasjoner/dag) -> Standard; ny GCP-prosjektbasert tilgang med merkevareverifisering fra 9. sept. 2026 = BLOCKED_EXTERNAL.
 *  - UVERIFISERT (merket i runbook): `updateMask` på camelCase-form (`amountMicros`), tegngrenser for RSA (overskrift 30, beskrivelse 90, sti 15), RSA-tekstendring (immutable via adGroupAds; `ads:mutate` ikke verifisert = DEFERRED).
 * DEFERRED: kampanjeopprettelse, budsjett-/budstrategi-bytte, delte budsjetter (nektes eksplisitt), RSA-tekstendring, kampanjenivå-negative-nøkkelord, offline-konverteringsopplasting, bruker-/kontotilgang (tilgangsstyring).
 */
export const GOOGLE_ADS_DEFAULT_API_VERSION = "v25";
const BASE_URL = "https://googleads.googleapis.com";

const cidOf = (p: Params): string => {
  const v = normalizeGrowthTarget("google_ads", p["customer_id"]);
  if (v === null) throw new Error("growth_invalid_customer_id");
  return v;
};
const safeCid = (p: Params): string => normalizeGrowthTarget("google_ads", p["customer_id"]) ?? "?";
const safeId = (p: Params, key: string): string => (typeof p[key] === "string" && /^\d{1,20}$/.test(p[key] as string) ? (p[key] as string) : "?");

const customerShape = { customer_id: z.string().min(10).max(14) };
const campaignShape = { ...customerShape, campaign_id: zDigits(1, 20) };
const adGroupShape = { ...customerShape, ad_group_id: zDigits(1, 20) };
const matchType = z.enum(["BROAD", "PHRASE", "EXACT"]);
const keywordEntry = z.object({ text: zText(1, 80), match_type: matchType }).strict();
const KEYWORD_TEXT = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;

const refCampaign = (p: Params) => `googleads:${safeCid(p)}:campaign:${safeId(p, "campaign_id")}`;
const refAdGroup = (p: Params) => `googleads:${safeCid(p)}:ad_group:${safeId(p, "ad_group_id")}`;

const keywordKey = (text: string, match: string, negative: boolean) => `${text.trim().replace(/\s+/g, " ").toLowerCase()}|${match}|${negative ? "neg" : "pos"}`;
const requestedKeywords = (p: Params): Array<{ text: string; match_type: string }> =>
  asArr(p["keywords"]).map(asObj).map((k) => ({ text: String(k["text"] ?? ""), match_type: String(k["match_type"] ?? "") }));
const keywordsOf = (s: JsonValue): Array<Record<string, unknown>> => asArr(asObj(s)["keywords"]).map(asObj);
const adsOf = (s: JsonValue): Array<Record<string, unknown>> => asArr(asObj(s)["ads"]).map(asObj);
const adGroupStatus = (s: JsonValue): string | null => str(asObj(s)["ad_group_status"]) ?? str(asObj(s)["status"]);

function sameRsa(ad: Record<string, unknown>, p: Params): boolean {
  const wantHeadlines = asArr(p["headlines"]).map(String);
  const wantDescriptions = asArr(p["descriptions"]).map(String);
  return sameStringSet(asArr(ad["headlines"]), wantHeadlines) && sameStringSet(asArr(ad["descriptions"]), wantDescriptions) && sameStringSet(asArr(ad["final_urls"]), [creativeHrefOrRaw(p["final_url"] ?? "")]);
}

export function googleAdsWriteSpec(config: Pick<GrowthWriteConfig, "creativeHosts">): ProviderToolSpec {
  const scopes = ["googleads.write"];
  const readScopes = ["googleads.read"];
  const read = (action: string, description: string, shape: z.ZodRawShape): OpSpec => ({ action, description, shape, risk: "A", targetParam: "customer_id", scopes: readScopes });

  const ops: OpSpec[] = [
    read("get_campaign_state", "Les tilstanden til én kampanje (status, budsjett i mikroenheter og øre, delt budsjett, budstrategi, valuta) - ubetrodd leverandørdata", campaignShape),
    read("get_ad_group_state", "Les tilstanden til én annonsegruppe (status, standard-CPC-bud, kampanje)", adGroupShape),
    read("get_keyword_state", "List nøkkelordene i en annonsegruppe (tekst, match-type, status, negativ) - ubetrodd leverandørdata", adGroupShape),
    read("get_ad_state", "List annonsene (responsive søkeannonser) i en annonsegruppe (status, tekster, mål-URL, godkjenningsstatus) - ubetrodd leverandørdata", adGroupShape),

    {
      action: "set_campaign_budget", risk: "D", spend: "directional", targetParam: "customer_id", stateAction: "get_campaign_state", scopes,
      description: "Sett kampanjens DAGSBUDSJETT (absolutt, i øre = 1/100 av kontovalutaen). Opp krever åpen finans-nødbryter; ned er alltid tillatt. Delte budsjetter nektes.",
      shape: { ...campaignShape, amount_ore: zOre, expected_amount_ore: zOre.optional() },
      rollback: "set_campaign_budget med forrige beløp (budget_amount_micros i før-tilstanden er journalført) gjenoppretter budsjettet",
      targetCheck: (s) => str(asObj(s)["campaign_id"]) !== null,
      validate: (s, p) => {
        const o = asObj(s);
        if (o["status"] === "REMOVED") return "campaign_removed";
        if (o["budget_shared"] === true) return "shared_budget_not_supported";
        if (str(o["budget_id"]) === null) return "budget_missing";
        const next = oreToMicros(assertOre(p["amount_ore"], "amount_ore"));
        const expected = p["expected_amount_ore"] === undefined ? undefined : oreToMicros(assertOre(p["expected_amount_ore"], "expected_amount_ore"));
        return directionalAmountCheck(s, num(o["budget_amount_micros"]), next, expected);
      },
      noop: (s, p) => num(asObj(s)["budget_amount_micros"]) === oreToMicros(assertOre(p["amount_ore"], "amount_ore")),
      post: (a, p) => num(asObj(a)["budget_amount_micros"]) === oreToMicros(assertOre(p["amount_ore"], "amount_ore")),
      target: (p) => `${refCampaign(p)}:budget`,
      summary: (s, p) => {
        const was = num(asObj(s)["budget_amount_micros"]);
        return `Google Ads: sett dagsbudsjett for ${refCampaign(p)} til ${String(p["amount_ore"])} øre (før: ${was === null ? "ukjent" : `${Math.round(was / MICROS_PER_ORE)} øre`})`;
      }
    },
    ...pauseEnableOps({
      noun: "campaign", label: "Google Ads-kampanje", stateAction: "get_campaign_state", targetParam: "customer_id", shape: campaignShape, scopes,
      statusOf: (s) => str(asObj(s)["status"]), terminal: ["REMOVED"], paused: "PAUSED", active: "ENABLED", ref: refCampaign
    }),
    removeOp({
      action: "remove_campaign", label: "Google Ads-kampanje", stateAction: "get_campaign_state", targetParam: "customer_id", shape: campaignShape, scopes,
      statusOf: (s) => str(asObj(s)["status"]), removed: ["REMOVED"], ref: refCampaign,
      rollback: "ingen teknisk reversering - REMOVED er terminal hos Google Ads; en ny kampanje må opprettes manuelt (før-tilstand med navn, status og budsjett er journalført)"
    }),
    ...pauseEnableOps({
      noun: "ad_group", label: "Google Ads-annonsegruppe", stateAction: "get_ad_group_state", targetParam: "customer_id", shape: adGroupShape, scopes,
      statusOf: (s) => str(asObj(s)["status"]), terminal: ["REMOVED"], paused: "PAUSED", active: "ENABLED", ref: refAdGroup
    }),
    {
      action: "set_ad_group_bid", risk: "D", spend: "directional", targetParam: "customer_id", stateAction: "get_ad_group_state", scopes,
      description: "Sett annonsegruppens standard-CPC-bud (absolutt, i øre). Opp krever åpen finans-nødbryter; ned er alltid tillatt.",
      shape: { ...adGroupShape, cpc_bid_ore: zOre, expected_cpc_bid_ore: zOre.optional() },
      rollback: "set_ad_group_bid med forrige bud (cpc_bid_micros i før-tilstanden er journalført) gjenoppretter budet",
      validate: (s, p) => {
        const o = asObj(s);
        if (o["status"] === "REMOVED") return "ad_group_removed";
        const next = oreToMicros(assertOre(p["cpc_bid_ore"], "cpc_bid_ore"));
        const expected = p["expected_cpc_bid_ore"] === undefined ? undefined : oreToMicros(assertOre(p["expected_cpc_bid_ore"], "expected_cpc_bid_ore"));
        return directionalAmountCheck(s, num(o["cpc_bid_micros"]), next, expected);
      },
      noop: (s, p) => num(asObj(s)["cpc_bid_micros"]) === oreToMicros(assertOre(p["cpc_bid_ore"], "cpc_bid_ore")),
      post: (a, p) => num(asObj(a)["cpc_bid_micros"]) === oreToMicros(assertOre(p["cpc_bid_ore"], "cpc_bid_ore")),
      target: (p) => `${refAdGroup(p)}:cpc_bid`,
      summary: (_s, p) => `Google Ads: sett standard-CPC for ${refAdGroup(p)} til ${String(p["cpc_bid_ore"])} øre`
    },
    {
      action: "add_keywords", risk: "C", spend: "directional", targetParam: "customer_id", stateAction: "get_keyword_state", scopes,
      description: "Legg til nøkkelord (eller NEGATIVE nøkkelord) i en annonsegruppe; standard status PAUSED. Allerede eksisterende nøkkelord hoppes over (idempotent). ENABLED krever åpen finans-nødbryter.",
      shape: { ...adGroupShape, keywords: z.array(keywordEntry).min(1).max(50), negative: z.boolean().optional(), status: z.enum(["PAUSED", "ENABLED"]).optional() },
      rollback: "remove_keyword per opprettet kriterium (criterion_id fra svaret) fjerner nøkkelordene igjen; negative nøkkelord fjernes på samme måte",
      validate: (s, p) => {
        if (adGroupStatus(s) === "REMOVED") return "ad_group_removed";
        for (const k of requestedKeywords(p)) if (!KEYWORD_TEXT.test(k.text)) return "invalid_keyword_text";
        const starts = p["negative"] !== true && p["status"] === "ENABLED";
        return starts && !killSwitchOpen(s) ? "finance_kill_switch_active_or_unknown" : null;
      },
      noop: (s, p) => {
        const have = new Set(keywordsOf(s).map((k) => keywordKey(String(k["text"] ?? ""), String(k["match_type"] ?? ""), k["negative"] === true)));
        return requestedKeywords(p).every((k) => have.has(keywordKey(k.text, k.match_type, p["negative"] === true)));
      },
      post: (a, p) => {
        const have = new Set(keywordsOf(a).map((k) => keywordKey(String(k["text"] ?? ""), String(k["match_type"] ?? ""), k["negative"] === true)));
        return requestedKeywords(p).every((k) => have.has(keywordKey(k.text, k.match_type, p["negative"] === true)));
      },
      target: (p) => `${refAdGroup(p)}:keywords`,
      summary: (_s, p) => `Google Ads: legg til ${asArr(p["keywords"]).length} ${p["negative"] === true ? "negative " : ""}nøkkelord i ${refAdGroup(p)} (status ${String(p["status"] ?? "PAUSED")})`
    },
    ...pauseEnableOps({
      noun: "keyword", label: "Google Ads-nøkkelord", stateAction: "get_keyword_state", targetParam: "customer_id", enableRisk: "C",
      shape: { ...adGroupShape, criterion_id: zDigits(1, 20) }, scopes,
      statusOf: (s, p) => str(keywordsOf(s).find((k) => k["criterion_id"] === p["criterion_id"])?.["status"]),
      targetCheck: (s, p) => keywordsOf(s).some((k) => k["criterion_id"] === p["criterion_id"]),
      terminal: ["REMOVED"], paused: "PAUSED", active: "ENABLED", ref: (p) => `${refAdGroup(p)}:keyword:${safeId(p, "criterion_id")}`
    }),
    removeOp({
      action: "remove_keyword", label: "Google Ads-nøkkelord", stateAction: "get_keyword_state", targetParam: "customer_id", scopes,
      shape: { ...adGroupShape, criterion_id: zDigits(1, 20) },
      statusOf: (s, p) => (keywordsOf(s).some((k) => k["criterion_id"] === p["criterion_id"]) ? "PRESENT" : "REMOVED"),
      targetCheck: () => true, removed: ["REMOVED"], ref: (p) => `${refAdGroup(p)}:keyword:${safeId(p, "criterion_id")}`,
      rollback: "add_keywords med nøkkelordets tekst og match-type (fra før-tilstanden) oppretter det på nytt - kriteriet får ny id"
    }),
    {
      action: "create_responsive_search_ad", risk: "C", spend: "structural", targetParam: "customer_id", stateAction: "get_ad_state", scopes,
      description: "Opprett en responsiv søkeannonse i en annonsegruppe - ALLTID PAUSET (aktivering er en egen klasse D-handling). Mål-URL må stå i JARVIS_GROWTH_CREATIVE_URL_HOSTS. Identisk annonse hoppes over.",
      shape: {
        ...adGroupShape, final_url: z.string().url().max(2048), headlines: z.array(zText(1, 30)).min(3).max(15), descriptions: z.array(zText(1, 90)).min(2).max(4),
        path1: zText(1, 15).optional(), path2: zText(1, 15).optional()
      },
      rollback: "pause_ad/remove via leverandørens grensesnitt; annonsen er opprettet PAUSET og har ikke vist noe (ad_id fra svaret). remove_ad er DEFERRED",
      validate: (s, p) => {
        if (adGroupStatus(s) === "REMOVED") return "ad_group_removed";
        if (creativeUrlHost(p["final_url"], config.creativeHosts) === null) return "creative_url_host_not_allowed";
        for (const t of [...asArr(p["headlines"]), ...asArr(p["descriptions"])]) if (typeof t !== "string" || !KEYWORD_TEXT.test(t)) return "invalid_creative_text";
        return null;
      },
      noop: (s, p) => adsOf(s).some((ad) => sameRsa(ad, p)),
      post: (a, p) => adsOf(a).some((ad) => sameRsa(ad, p)),
      target: (p) => `${refAdGroup(p)}:rsa`,
      summary: (_s, p) => `Google Ads: opprett PAUSET responsiv søkeannonse i ${refAdGroup(p)} (${asArr(p["headlines"]).length} overskrifter, ${asArr(p["descriptions"]).length} beskrivelser)`
    },
    ...pauseEnableOps({
      noun: "ad", label: "Google Ads-annonse", stateAction: "get_ad_state", targetParam: "customer_id", shape: { ...adGroupShape, ad_id: zDigits(1, 20) }, scopes,
      statusOf: (s, p) => str(adsOf(s).find((ad) => ad["ad_id"] === p["ad_id"])?.["status"]),
      targetCheck: (s, p) => adsOf(s).some((ad) => ad["ad_id"] === p["ad_id"]),
      terminal: ["REMOVED"], paused: "PAUSED", active: "ENABLED", ref: (p) => `${refAdGroup(p)}:ad:${safeId(p, "ad_id")}`
    })
  ];
  return { provider: "google_ads", toolId: "growth_googleads", credentialRef: "JARVIS_GOOGLE_ADS_REFRESH_TOKEN", freezeConnectorIds: ["googleads"], ops };
}

export interface GoogleAdsWriteOptions extends WriteTransportDeps {
  spec: ProviderToolSpec;
  developerToken: () => Promise<string | null>;
  loginCustomerId?: () => Promise<string | null>;
  apiVersion?: string;
  baseUrl?: string;
  /** Refresh-token -> access-token (standard: den delte `googleAccessToken`; injiseres i tester). */
  accessToken?: (refreshToken: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

export class GoogleAdsWriteTransport extends GrowthWriteTransportBase {
  protected readonly label = "google_ads";
  protected readonly ops: ReadonlyMap<string, OpSpec>;
  private readonly http: VendorHttp;
  private readonly version: string;

  constructor(private readonly options: GoogleAdsWriteOptions) {
    super(options);
    this.ops = new Map(options.spec.ops.map((o) => [o.action, o]));
    const version = (options.apiVersion ?? "").trim() || GOOGLE_ADS_DEFAULT_API_VERSION;
    if (!/^v\d{1,3}$/.test(version)) throw new Error("google_ads_invalid_api_version");
    this.version = version;
    this.http = new VendorHttp({ label: "google_ads", baseUrl: options.baseUrl ?? BASE_URL, ...(options.sleep ? { sleep: options.sleep } : {}) });
  }

  protected async authenticate(credential: string): Promise<Auth> {
    const developerToken = await this.options.developerToken();
    if (!developerToken) throw new Error("google_ads_developer_token_not_configured");
    const accessToken = await (this.options.accessToken ?? googleAccessToken)(credential);
    const login = this.options.loginCustomerId ? await this.options.loginCustomerId() : null;
    return {
      headers: { authorization: `Bearer ${accessToken}`, "developer-token": developerToken, ...(login && /^\d{10}$/.test(login.replace(/-/g, "")) ? { "login-customer-id": login.replace(/-/g, "") } : {}) },
      secrets: [accessToken, developerToken, credential]
    };
  }

  private async gaql(cid: string, query: string, auth: Auth): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await this.http.request({
        method: "POST", path: `/${this.version}/customers/${cid}/googleAds:search`, headers: auth.headers, secrets: auth.secrets,
        body: { query, ...(pageToken ? { pageToken } : {}) }
      });
      const json = asObj(res?.json);
      rows.push(...asArr(json["results"]).map(asObj));
      pageToken = str(json["nextPageToken"]) ?? undefined;
      if (!pageToken) break;
    }
    return rows;
  }

  private async mutate(cid: string, service: string, operations: unknown[], auth: Auth): Promise<Record<string, unknown>> {
    const res = await this.http.request({
      method: "POST", path: `/${this.version}/customers/${cid}/${service}:mutate`, headers: auth.headers, secrets: auth.secrets, mutation: true, body: { operations }
    });
    return asObj(res?.json);
  }

  private async adGroup(cid: string, adGroupId: string, auth: Auth): Promise<Record<string, JsonValue> | null> {
    const rows = await this.gaql(cid, `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros, campaign.id, campaign.status FROM ad_group WHERE ad_group.id = ${adGroupId}`, auth);
    const r = rows[0];
    if (!r) return null;
    const g = asObj(r["adGroup"]);
    const c = asObj(r["campaign"]);
    const bid = num(g["cpcBidMicros"]);
    return {
      customer_id: cid, ad_group_id: str(g["id"]) ?? adGroupId, name: cleanText(g["name"]), status: str(g["status"]), cpc_bid_micros: bid !== null && Number.isSafeInteger(bid) ? bid : null,
      campaign_id: str(c["id"]), campaign_status: str(c["status"])
    };
  }

  protected async readState(action: string, p: Params, auth: Auth): Promise<JsonValue | null> {
    const cid = cidOf(p);
    switch (action) {
      case "get_campaign_state": {
        const campaignId = assertDigits(p["campaign_id"], "campaign_id", 1, 20);
        const rows = await this.gaql(cid,
          `SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.campaign_budget, campaign_budget.id, campaign_budget.amount_micros, campaign_budget.explicitly_shared, customer.currency_code FROM campaign WHERE campaign.id = ${campaignId}`, auth);
        const r = rows[0];
        if (!r) return null;
        const c = asObj(r["campaign"]);
        const b = asObj(r["campaignBudget"]);
        const micros = num(b["amountMicros"]);
        return {
          customer_id: cid, campaign_id: str(c["id"]) ?? campaignId, name: cleanText(c["name"]), status: str(c["status"]), serving_status: str(c["servingStatus"]),
          channel_type: str(c["advertisingChannelType"]), bidding_strategy_type: str(c["biddingStrategyType"]), budget_id: str(b["id"]),
          budget_amount_micros: micros !== null && Number.isSafeInteger(micros) ? micros : null, budget_shared: b["explicitlyShared"] === true, currency: str(asObj(r["customer"])["currencyCode"])
        };
      }
      case "get_ad_group_state":
        return this.adGroup(cid, assertDigits(p["ad_group_id"], "ad_group_id", 1, 20), auth);
      case "get_keyword_state": {
        const adGroupId = assertDigits(p["ad_group_id"], "ad_group_id", 1, 20);
        const group = await this.adGroup(cid, adGroupId, auth);
        if (group === null) return null;
        const rows = await this.gaql(cid,
          `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.negative FROM ad_group_criterion WHERE ad_group.id = ${adGroupId} AND ad_group_criterion.type = KEYWORD AND ad_group_criterion.status != REMOVED`, auth);
        const keywords = rows.slice(0, 1000).map((r) => {
          const k = asObj(r["adGroupCriterion"]);
          const kw = asObj(k["keyword"]);
          return { criterion_id: str(k["criterionId"]), text: cleanText(kw["text"], 80), match_type: str(kw["matchType"]), status: str(k["status"]), negative: k["negative"] === true };
        });
        return { customer_id: cid, ad_group_id: adGroupId, ad_group_status: str(group["status"]), keywords };
      }
      case "get_ad_state": {
        const adGroupId = assertDigits(p["ad_group_id"], "ad_group_id", 1, 20);
        const group = await this.adGroup(cid, adGroupId, auth);
        if (group === null) return null;
        const rows = await this.gaql(cid,
          `SELECT ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.policy_summary.approval_status FROM ad_group_ad WHERE ad_group.id = ${adGroupId} AND ad_group_ad.status != REMOVED`, auth);
        const ads = rows.slice(0, 200).map((r) => {
          const aga = asObj(r["adGroupAd"]);
          const ad = asObj(aga["ad"]);
          const rsa = asObj(ad["responsiveSearchAd"]);
          return {
            ad_id: str(ad["id"]), status: str(aga["status"]), type: str(ad["type"]), final_urls: asArr(ad["finalUrls"]).filter((u): u is string => typeof u === "string").slice(0, 5).map((u) => cleanText(u, 2048)),
            headlines: asArr(rsa["headlines"]).map((h) => cleanText(asObj(h)["text"], 90)).filter((t): t is string => t !== null),
            descriptions: asArr(rsa["descriptions"]).map((d) => cleanText(asObj(d)["text"], 200)).filter((t): t is string => t !== null),
            approval_status: str(asObj(aga["policySummary"])["approvalStatus"])
          };
        });
        return { customer_id: cid, ad_group_id: adGroupId, ad_group_status: str(group["status"]), ads } as unknown as JsonValue;
      }
      default:
        throw new Error(`google_ads_action_not_implemented:${action}`);
    }
  }

  private setStatus(cid: string, service: string, resourceName: string, status: string, auth: Auth) {
    return this.mutate(cid, service, [{ update: { resourceName, status }, updateMask: "status" }], auth);
  }

  protected async applyWrite(action: string, p: Params, auth: Auth, before: JsonValue): Promise<{ external_id?: string; data?: JsonValue }> {
    const cid = cidOf(p);
    const b = asObj(before);
    switch (action) {
      case "set_campaign_budget": {
        const budgetId = assertDigits(b["budget_id"], "budget_id", 1, 20);
        await this.mutate(cid, "campaignBudgets", [{ update: { resourceName: `customers/${cid}/campaignBudgets/${budgetId}`, amountMicros: String(oreToMicros(assertOre(p["amount_ore"], "amount_ore"))) }, updateMask: "amountMicros" }], auth);
        return { external_id: `campaignBudgets/${budgetId}` };
      }
      case "pause_campaign":
      case "enable_campaign": {
        const id = assertDigits(p["campaign_id"], "campaign_id", 1, 20);
        await this.setStatus(cid, "campaigns", `customers/${cid}/campaigns/${id}`, action === "pause_campaign" ? "PAUSED" : "ENABLED", auth);
        return { external_id: `campaigns/${id}` };
      }
      case "remove_campaign": {
        const id = assertDigits(p["campaign_id"], "campaign_id", 1, 20);
        await this.mutate(cid, "campaigns", [{ remove: `customers/${cid}/campaigns/${id}` }], auth);
        return { external_id: `campaigns/${id}` };
      }
      case "pause_ad_group":
      case "enable_ad_group": {
        const id = assertDigits(p["ad_group_id"], "ad_group_id", 1, 20);
        await this.setStatus(cid, "adGroups", `customers/${cid}/adGroups/${id}`, action === "pause_ad_group" ? "PAUSED" : "ENABLED", auth);
        return { external_id: `adGroups/${id}` };
      }
      case "set_ad_group_bid": {
        const id = assertDigits(p["ad_group_id"], "ad_group_id", 1, 20);
        await this.mutate(cid, "adGroups", [{ update: { resourceName: `customers/${cid}/adGroups/${id}`, cpcBidMicros: String(oreToMicros(assertOre(p["cpc_bid_ore"], "cpc_bid_ore"))) }, updateMask: "cpcBidMicros" }], auth);
        return { external_id: `adGroups/${id}` };
      }
      case "add_keywords": {
        const agId = assertDigits(p["ad_group_id"], "ad_group_id", 1, 20);
        const negative = p["negative"] === true;
        const have = new Set(keywordsOf(before).map((k) => keywordKey(String(k["text"] ?? ""), String(k["match_type"] ?? ""), k["negative"] === true)));
        const seen = new Set<string>();
        const toCreate = requestedKeywords(p).filter((k) => {
          const key = keywordKey(k.text, k.match_type, negative);
          if (have.has(key) || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (toCreate.length === 0) return { data: { unchanged: true } };
        const status = p["status"] === "ENABLED" ? "ENABLED" : "PAUSED";
        const res = await this.mutate(cid, "adGroupCriteria", toCreate.map((k) => ({
          create: { adGroup: `customers/${cid}/adGroups/${agId}`, status, ...(negative ? { negative: true } : {}), keyword: { text: k.text, matchType: k.match_type } }
        })), auth);
        const created = asArr(res["results"]).map((r) => str(asObj(r)["resourceName"])).filter((r): r is string => r !== null && /^customers\/\d{10}\/[A-Za-z]+\/[0-9~]{1,50}$/.test(r));
        return { ...(created[0] ? { external_id: created[0].split("/").pop() ?? created[0] } : {}), data: { created: toCreate.length, resource_names: created.slice(0, 50) } };
      }
      case "pause_keyword":
      case "enable_keyword": {
        const agId = assertDigits(p["ad_group_id"], "ad_group_id", 1, 20);
        const crit = assertDigits(p["criterion_id"], "criterion_id", 1, 20);
        await this.setStatus(cid, "adGroupCriteria", `customers/${cid}/adGroupCriteria/${agId}~${crit}`, action === "pause_keyword" ? "PAUSED" : "ENABLED", auth);
        return { external_id: `${agId}~${crit}` };
      }
      case "remove_keyword": {
        const agId = assertDigits(p["ad_group_id"], "ad_group_id", 1, 20);
        const crit = assertDigits(p["criterion_id"], "criterion_id", 1, 20);
        await this.mutate(cid, "adGroupCriteria", [{ remove: `customers/${cid}/adGroupCriteria/${agId}~${crit}` }], auth);
        return { external_id: `${agId}~${crit}` };
      }
      case "create_responsive_search_ad": {
        const agId = assertDigits(p["ad_group_id"], "ad_group_id", 1, 20);
        if (adsOf(before).some((ad) => sameRsa(ad, p))) return { data: { unchanged: true } };
        const res = await this.mutate(cid, "adGroupAds", [{
          create: {
            adGroup: `customers/${cid}/adGroups/${agId}`, status: "PAUSED",
            ad: {
              finalUrls: [creativeHref(p["final_url"])],
              responsiveSearchAd: {
                headlines: asArr(p["headlines"]).map((text) => ({ text: String(text) })), descriptions: asArr(p["descriptions"]).map((text) => ({ text: String(text) })),
                ...(typeof p["path1"] === "string" ? { path1: p["path1"] } : {}), ...(typeof p["path2"] === "string" ? { path2: p["path2"] } : {})
              }
            }
          }
        }], auth);
        const name = str(asObj(asArr(res["results"])[0])["resourceName"]);
        return { ...(name ? { external_id: name.split("/").pop() ?? name } : {}), data: { created: 1, status: "PAUSED" } };
      }
      case "pause_ad":
      case "enable_ad": {
        const agId = assertDigits(p["ad_group_id"], "ad_group_id", 1, 20);
        const adId = assertDigits(p["ad_id"], "ad_id", 1, 20);
        await this.setStatus(cid, "adGroupAds", `customers/${cid}/adGroupAds/${agId}~${adId}`, action === "pause_ad" ? "PAUSED" : "ENABLED", auth);
        return { external_id: `${agId}~${adId}` };
      }
      default:
        throw new Error(`google_ads_action_not_implemented:${action}`);
    }
  }
}

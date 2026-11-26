import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { creativeHref, creativeUrlHost, normalizeGrowthTarget, type GrowthWriteConfig } from "./config.ts";
import { GrowthVendorError, VendorHttp } from "./http.ts";
import { cleanText, pauseEnableOps, removeOp } from "./op-builders.ts";
import { GrowthWriteTransportBase, killSwitchOpen, type Auth, type OpSpec, type ProviderToolSpec, type WriteTransportDeps } from "./tool-factory.ts";
import { asArr, asObj, assertDigits, assertOre, num, str, truncatedOf, zDigits, zOre, zText, type Params } from "./validators.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): Meta Ads (Marketing API / Graph) SKRIVING: kampanje-/annonsesett-/annonsestatus, annonsesett-dagsbudsjett og -bud, opprettelse av PAUSET lenkeannonse. Rå REST via `VendorHttp`
 * mot `graph.facebook.com` (ingen SDK, regel 3). Utvider den EKSISTERENDE lese-connectoren (`MetaAdsTransport`, samme `JARVIS_META_ADS_ACCESS_TOKEN`); skrivehandlingene bor i EGET navnerom
 * `growth_metaads` (eier-eksklusivt, forbudt for modellflater). Tokenet sendes som `Authorization: Bearer`-header (aldri i URL; den eksisterende lese-transporten bruker `access_token`-spørringsparameter -
 * header-formen er UVERIFISERT mot primærkilde og verifiseres i sandkasse-steget i runbooken).
 *
 * D-41-STATUS (`VERIFIED_OFFICIAL_SEARCH_SNIPPET`; developers.facebook.com var ikke tilgjengelig for WebFetch):
 *  - Beløp (budsjett/bud) i kontovalutaens MINSTE enhet (øre for NOK). KUN valutaer i `TWO_DECIMAL` støttes (null-desimal-valutaer som JPY nektes = DEFERRED), så øre -> minste enhet er identitet.
 *  - Status ACTIVE/PAUSED/DELETED/ARCHIVED; DELETED er terminal (`delete_campaign`). ARCHIVED kan gjenopprettes med ACTIVE (ifølge dokumentasjonen).
 *  - `POST act_{konto}/ads` med `adset_id`, `creative` (inline `object_story_spec` med `page_id` + `link_data`) og `status`.
 *  - Ingen idempotensnøkkel: tilstandslesing før skriving, absolutt-tilstand-oppdateringer, readback og navnededuplisering ved opprettelse.
 *  - Tilgang: `ads_management` (Standard Access holder for EGEN konto; Advanced Access/forretningsverifisering kreves for andres) = BLOCKED_EXTERNAL til eieren har gjennomført verifiseringen.
 *  - Rate-limit-feilkoder (17/80000/80004/613) kommer som HTTP 400 og gjentas ALDRI automatisk for en mutasjon.
 * DEFERRED: kampanjeopprettelse, livstidsbudsjett, kampanjebudsjett (CBO), lagring/opplasting av bilde/video, annonsesett-opprettelse/-målgrupper, tilgangsstyring (assigned_users), Conversions API.
 */
export const META_ADS_DEFAULT_API_VERSION = "v26.0";
const BASE_URL = "https://graph.facebook.com";
/**
 * Valutaer der minste enhet = 1/100 av hovedenheten (Jarvis' øre-konvensjon er identitet). Alt annet nektes (fail-closed: `currency_not_supported`) til en eier-beslutning utvider listen.
 * Review N7: PLN, CZK og SGD er FJERNET - Metas valutaoffset for dem er ikke verifisert mot offisiell dokumentasjon (developers.facebook.com var utilgjengelig), og en feil offset ville satt et budsjett
 * 100 ganger for høyt/lavt. LinkedIn og TikTok deler listen (konservativt); legg en valuta tilbake KUN etter at offset/format er verifisert mot plattformens egen valutatabell.
 */
export const TWO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(["NOK", "SEK", "DKK", "EUR", "USD", "GBP", "CHF", "CAD", "AUD", "NZD"]);
const BID_STRATEGIES_WITH_AMOUNT: ReadonlySet<string> = new Set(["LOWEST_COST_WITH_BID_CAP", "COST_CAP"]);

const acctOf = (p: Params): string => {
  const v = normalizeGrowthTarget("meta_ads", p["ad_account_id"]);
  if (v === null) throw new Error("growth_invalid_ad_account_id");
  return v;
};
const safeAcct = (p: Params): string => normalizeGrowthTarget("meta_ads", p["ad_account_id"]) ?? "?";
const safeId = (p: Params, key: string): string => (typeof p[key] === "string" && /^\d{1,25}$/.test(p[key] as string) ? (p[key] as string) : "?");

const accountShape = { ad_account_id: z.string().min(5).max(24) };
const campaignShape = { ...accountShape, campaign_id: zDigits(5, 25) };
const adSetShape = { ...accountShape, ad_set_id: zDigits(5, 25) };
const adShape = { ...accountShape, ad_id: zDigits(5, 25) };
const refCampaign = (p: Params) => `metaads:act_${safeAcct(p)}:campaign:${safeId(p, "campaign_id")}`;
const refAdSet = (p: Params) => `metaads:act_${safeAcct(p)}:ad_set:${safeId(p, "ad_set_id")}`;
const refAd = (p: Params) => `metaads:act_${safeAcct(p)}:ad:${safeId(p, "ad_id")}`;
const statusOf = (s: JsonValue): string | null => str(asObj(s)["status"]);
const adsOf = (s: JsonValue): Array<Record<string, unknown>> => asArr(asObj(s)["ads"]).map(asObj);
/** Review N6: `list_ads` leser ÉN side (100). Full side eller `paging.next` = listen er KUTTET: fravær beviser ikke at annonsen mangler (dedupe i `create_ad`; paginering = DEFERRED). */
const ADS_PAGE_SIZE = 100;
const currencyOk = (s: JsonValue): boolean => TWO_DECIMAL_CURRENCIES.has(str(asObj(s)["currency"]) ?? "");

export function metaAdsWriteSpec(config: Pick<GrowthWriteConfig, "creativeHosts">): ProviderToolSpec {
  const scopes = ["metaads.write"];
  const read = (action: string, description: string, shape: z.ZodRawShape): OpSpec => ({ action, description, shape, risk: "A", targetParam: "ad_account_id", scopes: ["metaads.read"] });
  const sameAccount = (s: JsonValue, p: Params) => str(asObj(s)["account_id"]) === acctOf(p);

  const ops: OpSpec[] = [
    read("get_campaign_state", "Les tilstanden til én kampanje (status, effektiv status, mål, kjøpstype) - ubetrodd leverandørdata", campaignShape),
    read("get_ad_set_state", "Les tilstanden til ett annonsesett (status, dagsbudsjett, bud, budstrategi, valuta) - ubetrodd leverandørdata", adSetShape),
    read("get_ad_state", "Les tilstanden til én annonse (status, effektiv status, annonsesett) - ubetrodd leverandørdata", adShape),
    read("list_ads", "List annonsene i et annonsesett (id, navn, status) - ubetrodd leverandørdata", adSetShape),

    ...pauseEnableOps({
      noun: "campaign", label: "Meta-kampanje", stateAction: "get_campaign_state", targetParam: "ad_account_id", shape: campaignShape, scopes,
      statusOf: (s) => statusOf(s), terminal: ["DELETED"], paused: "PAUSED", active: "ACTIVE", ref: refCampaign, targetCheck: sameAccount
    }),
    removeOp({
      action: "delete_campaign", label: "Meta-kampanje", stateAction: "get_campaign_state", targetParam: "ad_account_id", shape: campaignShape, scopes,
      statusOf: (s) => statusOf(s), removed: ["DELETED"], ref: refCampaign, targetCheck: sameAccount,
      rollback: "ingen teknisk reversering - DELETED er terminal hos Meta (kampanjen stopper levering; data kan fortsatt vises i rapporter); en ny kampanje må opprettes manuelt (før-tilstand er journalført)"
    }),
    ...pauseEnableOps({
      noun: "ad_set", label: "Meta-annonsesett", stateAction: "get_ad_set_state", targetParam: "ad_account_id", shape: adSetShape, scopes,
      statusOf: (s) => statusOf(s), terminal: ["DELETED"], paused: "PAUSED", active: "ACTIVE", ref: refAdSet, targetCheck: sameAccount
    }),
    {
      action: "set_ad_set_budget", risk: "D", spend: "directional", targetParam: "ad_account_id", stateAction: "get_ad_set_state", scopes,
      description: "Sett annonsesettets DAGSBUDSJETT (absolutt, i øre = kontovalutaens minste enhet; kun støttede 2-desimal-valutaer). Opp krever åpen finans-nødbryter; ned er alltid tillatt.",
      shape: { ...adSetShape, daily_budget_ore: zOre, expected_daily_budget_ore: zOre.optional() },
      rollback: "set_ad_set_budget med forrige dagsbudsjett (daily_budget_minor i før-tilstanden er journalført) gjenoppretter budsjettet",
      targetCheck: sameAccount,
      validate: (s, p) => {
        const o = asObj(s);
        if (o["status"] === "DELETED") return "ad_set_deleted";
        if (!currencyOk(s)) return "currency_not_supported";
        const current = num(o["daily_budget_minor"]);
        if (current === null) return "no_daily_budget_lifetime_or_cbo_not_supported";
        const next = assertOre(p["daily_budget_ore"], "daily_budget_ore");
        if (p["expected_daily_budget_ore"] !== undefined && assertOre(p["expected_daily_budget_ore"], "expected_daily_budget_ore") !== current) return "precondition_changed";
        return next > current && !killSwitchOpen(s) ? "finance_kill_switch_active_or_unknown" : null;
      },
      noop: (s, p) => num(asObj(s)["daily_budget_minor"]) === assertOre(p["daily_budget_ore"], "daily_budget_ore"),
      post: (a, p) => num(asObj(a)["daily_budget_minor"]) === assertOre(p["daily_budget_ore"], "daily_budget_ore"),
      target: (p) => `${refAdSet(p)}:daily_budget`,
      summary: (s, p) => `Meta Ads: sett dagsbudsjett for ${refAdSet(p)} til ${String(p["daily_budget_ore"])} øre (før: ${String(num(asObj(s)["daily_budget_minor"]) ?? "ukjent")} øre)`
    },
    {
      action: "set_ad_set_bid", risk: "D", spend: "directional", targetParam: "ad_account_id", stateAction: "get_ad_set_state", scopes,
      description: "Sett annonsesettets budbeløp (bid_amount; kun for budstrategiene LOWEST_COST_WITH_BID_CAP og COST_CAP). Opp krever åpen finans-nødbryter; ned er alltid tillatt.",
      shape: { ...adSetShape, bid_amount_ore: zOre, expected_bid_amount_ore: zOre.optional() },
      rollback: "set_ad_set_bid med forrige budbeløp (bid_amount_minor i før-tilstanden er journalført) gjenoppretter budet",
      targetCheck: sameAccount,
      validate: (s, p) => {
        const o = asObj(s);
        if (o["status"] === "DELETED") return "ad_set_deleted";
        if (!currencyOk(s)) return "currency_not_supported";
        if (!BID_STRATEGIES_WITH_AMOUNT.has(str(o["bid_strategy"]) ?? "")) return "bid_strategy_has_no_bid_amount";
        const current = num(o["bid_amount_minor"]);
        if (current === null) return "current_bid_unreadable";
        const next = assertOre(p["bid_amount_ore"], "bid_amount_ore");
        if (p["expected_bid_amount_ore"] !== undefined && assertOre(p["expected_bid_amount_ore"], "expected_bid_amount_ore") !== current) return "precondition_changed";
        return next > current && !killSwitchOpen(s) ? "finance_kill_switch_active_or_unknown" : null;
      },
      noop: (s, p) => num(asObj(s)["bid_amount_minor"]) === assertOre(p["bid_amount_ore"], "bid_amount_ore"),
      post: (a, p) => num(asObj(a)["bid_amount_minor"]) === assertOre(p["bid_amount_ore"], "bid_amount_ore"),
      target: (p) => `${refAdSet(p)}:bid_amount`,
      summary: (_s, p) => `Meta Ads: sett budbeløp for ${refAdSet(p)} til ${String(p["bid_amount_ore"])} øre`
    },
    ...pauseEnableOps({
      noun: "ad", label: "Meta-annonse", stateAction: "get_ad_state", targetParam: "ad_account_id", shape: adShape, scopes,
      statusOf: (s) => statusOf(s), terminal: ["DELETED"], paused: "PAUSED", active: "ACTIVE", ref: refAd, targetCheck: sameAccount
    }),
    {
      action: "create_ad", risk: "C", spend: "structural", targetParam: "ad_account_id", stateAction: "list_ads", scopes, idempotentExternal: false,
      description: "Opprett en lenkeannonse (inline kreativ: tekst + lenke + Facebook-side) i et annonsesett - ALLTID PAUSET (aktivering er en egen klasse D-handling). Lenkens vert må stå i JARVIS_GROWTH_CREATIVE_URL_HOSTS. Annonse med samme navn hoppes over.",
      shape: { ...adSetShape, name: zText(1, 100), page_id: zDigits(5, 25), link: z.string().url().max(2048), message: zText(1, 500), headline: zText(1, 80) },
      rollback: "pause_ad/delete via leverandøren; annonsen er opprettet PAUSET og har ikke vist noe (ad_id fra svaret). delete_ad er DEFERRED",
      targetCheck: sameAccount,
      validate: (s, p) => {
        if (str(asObj(s)["ad_set_status"]) === "DELETED") return "ad_set_deleted";
        if (truncatedOf(s)) return "ad_list_truncated";
        return creativeUrlHost(p["link"], config.creativeHosts) === null ? "creative_url_host_not_allowed" : null;
      },
      noop: (s, p) => adsOf(s).some((ad) => ad["name"] === cleanText(p["name"], 100)),
      post: (a, p) => adsOf(a).some((ad) => ad["name"] === cleanText(p["name"], 100)),
      target: (p) => `${refAdSet(p)}:ad_create`,
      summary: (_s, p) => `Meta Ads: opprett PAUSET lenkeannonse i ${refAdSet(p)}`
    }
  ];
  return { provider: "meta_ads", toolId: "growth_metaads", credentialRef: "JARVIS_META_ADS_ACCESS_TOKEN", freezeConnectorIds: ["metaads"], ops };
}

export interface MetaAdsWriteOptions extends WriteTransportDeps {
  spec: ProviderToolSpec;
  apiVersion?: string;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class MetaAdsWriteTransport extends GrowthWriteTransportBase {
  protected readonly label = "meta_ads";
  protected readonly ops: ReadonlyMap<string, OpSpec>;
  private readonly http: VendorHttp;
  private readonly version: string;

  constructor(options: MetaAdsWriteOptions) {
    super(options);
    this.ops = new Map(options.spec.ops.map((o) => [o.action, o]));
    const version = (options.apiVersion ?? "").trim() || META_ADS_DEFAULT_API_VERSION;
    if (!/^v\d{1,2}\.\d$/.test(version)) throw new Error("meta_ads_invalid_api_version");
    this.version = version;
    this.http = new VendorHttp({ label: "meta_ads", baseUrl: options.baseUrl ?? BASE_URL, ...(options.sleep ? { sleep: options.sleep } : {}) });
  }

  protected async authenticate(credential: string): Promise<Auth> {
    if (credential.length < 8) throw new Error("meta_ads_credential_invalid");
    return { headers: { authorization: `Bearer ${credential}` }, secrets: [credential] };
  }

  private async get(path: string, query: Record<string, string>, auth: Auth): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.http.request({ method: "GET", path: `/${this.version}/${path}`, query, headers: auth.headers, secrets: auth.secrets, allowNotFound: true });
      return res === null ? null : asObj(res.json);
    } catch (err) {
      // Graph svarer HTTP 400 (kode 100) for en id som ikke finnes - det er «ikke funnet», ikke en feil.
      if (err instanceof GrowthVendorError && err.httpStatus === 400 && /GraphMethodException/.test(err.message) && /does not exist|cannot be loaded|missing permissions/i.test(err.message)) return null;
      throw err;
    }
  }

  private async post(path: string, body: Record<string, unknown>, auth: Auth): Promise<Record<string, unknown>> {
    const res = await this.http.request({ method: "POST", path: `/${this.version}/${path}`, headers: auth.headers, secrets: auth.secrets, mutation: true, body });
    const json = asObj(res?.json);
    // Graph svarer `{success:true}` for oppdateringer og `{id}` for opprettelser; alt annet etter en akseptert mutasjon er et UKJENT utfall (kastes av basen via readback-mismatch).
    return json;
  }

  private async currency(acct: string, auth: Auth): Promise<string | null> {
    const account = await this.get(`act_${acct}`, { fields: "currency" }, auth);
    return account === null ? null : str(account["currency"]);
  }

  private minor(v: unknown): number | null {
    const n = num(v);
    return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
  }

  protected async readState(action: string, p: Params, auth: Auth): Promise<JsonValue | null> {
    const acct = acctOf(p);
    switch (action) {
      case "get_campaign_state": {
        const id = assertDigits(p["campaign_id"], "campaign_id", 5, 25);
        const o = await this.get(id, { fields: "id,name,status,effective_status,objective,buying_type,account_id" }, auth);
        if (o === null || str(o["account_id"]) !== acct) return null;
        return { ad_account_id: acct, campaign_id: id, account_id: acct, name: cleanText(o["name"]), status: str(o["status"]), effective_status: str(o["effective_status"]), objective: str(o["objective"]), buying_type: str(o["buying_type"]) };
      }
      case "get_ad_set_state": {
        const id = assertDigits(p["ad_set_id"], "ad_set_id", 5, 25);
        const o = await this.get(id, { fields: "id,name,status,effective_status,daily_budget,lifetime_budget,bid_amount,bid_strategy,campaign_id,account_id,end_time" }, auth);
        if (o === null || str(o["account_id"]) !== acct) return null;
        const currency = await this.currency(acct, auth);
        return {
          ad_account_id: acct, ad_set_id: id, account_id: acct, name: cleanText(o["name"]), status: str(o["status"]), effective_status: str(o["effective_status"]), campaign_id: str(o["campaign_id"]),
          daily_budget_minor: this.minor(o["daily_budget"]), lifetime_budget_minor: this.minor(o["lifetime_budget"]), bid_amount_minor: this.minor(o["bid_amount"]), bid_strategy: str(o["bid_strategy"]), currency
        };
      }
      case "get_ad_state": {
        const id = assertDigits(p["ad_id"], "ad_id", 5, 25);
        const o = await this.get(id, { fields: "id,name,status,effective_status,adset_id,campaign_id,account_id" }, auth);
        if (o === null || str(o["account_id"]) !== acct) return null;
        return { ad_account_id: acct, ad_id: id, account_id: acct, name: cleanText(o["name"], 100), status: str(o["status"]), effective_status: str(o["effective_status"]), ad_set_id: str(o["adset_id"]), campaign_id: str(o["campaign_id"]) };
      }
      case "list_ads": {
        const id = assertDigits(p["ad_set_id"], "ad_set_id", 5, 25);
        const set = await this.get(id, { fields: "id,status,account_id" }, auth);
        if (set === null || str(set["account_id"]) !== acct) return null;
        const list = await this.get(`${id}/ads`, { fields: "id,name,status", limit: String(ADS_PAGE_SIZE) }, auth);
        // WP-P3 K1 (JARVIS-106, review N10): `get()` svelger HTTP 400 «does not exist / cannot be loaded / missing permissions» som `null`. For selve annonsesettet er det «ikke funnet», men for `ads`-KANTEN
        // (annonsesettet ble nettopp lest) betyr `null` at listen er ULESELIG - fravær av annonser er da ikke bevist. Tilstanden er derfor avkortet (`truncated`) og merket `ads_unreadable`, så `create_ad`
        // nektes `ad_list_truncated` FØR noen POST (ellers ville dedupe sett en tom liste og laget en duplikat). Alle andre feil (401/403/5xx/nett) kastes fortsatt av `get()`.
        const unreadable = list === null;
        const rawAds = asArr(list?.["data"]);
        const truncated = unreadable || str(asObj(list?.["paging"])["next"]) !== null || rawAds.length >= ADS_PAGE_SIZE;
        const ads = rawAds.slice(0, ADS_PAGE_SIZE).map((a) => ({ id: str(asObj(a)["id"]), name: cleanText(asObj(a)["name"], 100), status: str(asObj(a)["status"]) }));
        return { ad_account_id: acct, ad_set_id: id, account_id: acct, ad_set_status: str(set["status"]), ads, truncated, ...(unreadable ? { ads_unreadable: true } : {}) };
      }
      default:
        throw new Error(`meta_ads_action_not_implemented:${action}`);
    }
  }

  protected async applyWrite(action: string, p: Params, auth: Auth, before: JsonValue): Promise<{ external_id?: string; data?: JsonValue }> {
    const acct = acctOf(p);
    switch (action) {
      case "pause_campaign": case "enable_campaign": case "delete_campaign": {
        const id = assertDigits(p["campaign_id"], "campaign_id", 5, 25);
        await this.post(id, { status: action === "pause_campaign" ? "PAUSED" : action === "enable_campaign" ? "ACTIVE" : "DELETED" }, auth);
        return { external_id: id };
      }
      case "pause_ad_set": case "enable_ad_set": {
        const id = assertDigits(p["ad_set_id"], "ad_set_id", 5, 25);
        await this.post(id, { status: action === "pause_ad_set" ? "PAUSED" : "ACTIVE" }, auth);
        return { external_id: id };
      }
      case "pause_ad": case "enable_ad": {
        const id = assertDigits(p["ad_id"], "ad_id", 5, 25);
        await this.post(id, { status: action === "pause_ad" ? "PAUSED" : "ACTIVE" }, auth);
        return { external_id: id };
      }
      case "set_ad_set_budget": {
        const id = assertDigits(p["ad_set_id"], "ad_set_id", 5, 25);
        await this.post(id, { daily_budget: assertOre(p["daily_budget_ore"], "daily_budget_ore") }, auth);
        return { external_id: id };
      }
      case "set_ad_set_bid": {
        const id = assertDigits(p["ad_set_id"], "ad_set_id", 5, 25);
        await this.post(id, { bid_amount: assertOre(p["bid_amount_ore"], "bid_amount_ore") }, auth);
        return { external_id: id };
      }
      case "create_ad": {
        const setId = assertDigits(p["ad_set_id"], "ad_set_id", 5, 25);
        const name = cleanText(p["name"], 100);
        if (adsOf(before).some((ad) => ad["name"] === name)) return { data: { unchanged: true } };
        const json = await this.post(`act_${acct}/ads`, {
          name, adset_id: setId, status: "PAUSED",
          creative: { object_story_spec: { page_id: assertDigits(p["page_id"], "page_id", 5, 25), link_data: { link: creativeHref(p["link"]), message: String(p["message"]), name: String(p["headline"]) } } }
        }, auth);
        const id = str(json["id"]);
        // Uten ad-id etter en akseptert opprettelse kan vi ikke vite hva som skjedde (readback finner den på navn) - ikke et «ok»-svar uten id.
        return { ...(id ? { external_id: id } : {}), data: { created: 1, status: "PAUSED" } };
      }
      default:
        throw new Error(`meta_ads_action_not_implemented:${action}`);
    }
  }
}

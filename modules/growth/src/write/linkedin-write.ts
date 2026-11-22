import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { normalizeGrowthTarget } from "./config.ts";
import { VendorHttp } from "./http.ts";
import { cleanText, directionalAmountCheck, pauseEnableOps } from "./op-builders.ts";
import { GrowthWriteTransportBase, type Auth, type OpSpec, type ProviderToolSpec, type WriteTransportDeps } from "./tool-factory.ts";
import { TWO_DECIMAL_CURRENCIES } from "./meta-ads-write.ts";
import { asObj, assertDigits, assertOre, num, str, zDigits, zOre, type Params } from "./validators.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): LinkedIn Marketing API (Advertising) - kampanjestatus og dagsbudsjett. Nytt navnerom `growth_linkedin` (eier-eksklusivt, forbudt for modellflater); eget token
 * `JARVIS_LINKEDIN_ACCESS_TOKEN` (OAuth, scope `rw_ads` - UVERIFISERT mot primærkilde). Rå REST (`/rest/adAccounts/{konto}/adCampaigns/{id}`), `LinkedIn-Version`-header (standard 202601, konfigurerbar),
 * delvis oppdatering med `X-RestLi-Method: PARTIAL_UPDATE` og `{patch:{$set:{...}}}` (`VERIFIED_OFFICIAL_SEARCH_SNIPPET` via speil - ikke LinkedIns egen side).
 * Budsjett er et DESIMALT beløp i hovedenhet (`{amount:"500.00", currencyCode}`), omregnet fra øre; kun 2-desimal-valutaer (samme liste som Meta). Ingen idempotensnøkkel: absolutt-tilstand + readback.
 * TILGANG: Marketing Developer Platform-godkjenning (utviklingsnivå -> standardnivå via vurdering/skjermopptak) = BLOCKED_EXTERNAL. `w_organization_social` (organisk sidepost) krever egen godkjenning.
 * DEFERRED: kampanje-/kampanjegruppe-opprettelse, kreativer, målgrupper, `totalBudget`, organiske poster, konverteringsopplasting, tilgangsstyring (`adAccountUsers`).
 */
export const LINKEDIN_DEFAULT_API_VERSION = "202601";
const BASE_URL = "https://api.linkedin.com/rest";

const accountOf = (p: Params): string => {
  const v = normalizeGrowthTarget("linkedin", p["account_id"]);
  if (v === null) throw new Error("growth_invalid_account_id");
  return v;
};
const safeAccount = (p: Params): string => normalizeGrowthTarget("linkedin", p["account_id"]) ?? "?";
const campaignShape = { account_id: z.string().min(4).max(40), campaign_id: zDigits(4, 20) };
const refCampaign = (p: Params) => `linkedin:account:${safeAccount(p)}:campaign:${typeof p["campaign_id"] === "string" ? (p["campaign_id"] as string).slice(0, 20) : "?"}`;

/** «50.00» -> 5000 øre. `null` ved mer enn 2 desimaler eller ugyldig tall (aldri stille avrunding av penger). */
export function decimalToOre(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
}
export function oreToDecimal(ore: number): string {
  return `${Math.floor(ore / 100)}.${String(ore % 100).padStart(2, "0")}`;
}

export function linkedinWriteSpec(): ProviderToolSpec {
  const scopes = ["linkedin.write"];
  const ops: OpSpec[] = [
    { action: "get_campaign_state", description: "Les tilstanden til én annonsekampanje (status, dagsbudsjett, valuta) - ubetrodd leverandørdata", shape: campaignShape, risk: "A", targetParam: "account_id", scopes: ["linkedin.read"] },
    ...pauseEnableOps({
      noun: "campaign", label: "LinkedIn-kampanje", stateAction: "get_campaign_state", targetParam: "account_id", shape: campaignShape, scopes,
      statusOf: (s) => str(asObj(s)["status"]), terminal: ["ARCHIVED", "CANCELED", "COMPLETED", "DRAFT"], paused: "PAUSED", active: "ACTIVE", ref: refCampaign
    }),
    {
      action: "set_campaign_daily_budget", risk: "D", spend: "directional", targetParam: "account_id", stateAction: "get_campaign_state", scopes,
      description: "Sett kampanjens DAGSBUDSJETT (absolutt, i øre; kun støttede 2-desimal-valutaer). Opp krever åpen finans-nødbryter; ned er alltid tillatt.",
      shape: { ...campaignShape, daily_budget_ore: zOre, expected_daily_budget_ore: zOre.optional() },
      rollback: "set_campaign_daily_budget med forrige dagsbudsjett (daily_budget_ore i før-tilstanden er journalført) gjenoppretter budsjettet",
      validate: (s, p) => {
        const o = asObj(s);
        if (["ARCHIVED", "CANCELED", "COMPLETED"].includes(str(o["status"]) ?? "")) return "campaign_closed";
        if (!TWO_DECIMAL_CURRENCIES.has(str(o["currency"]) ?? "")) return "currency_not_supported";
        const next = assertOre(p["daily_budget_ore"], "daily_budget_ore");
        const expected = p["expected_daily_budget_ore"] === undefined ? undefined : assertOre(p["expected_daily_budget_ore"], "expected_daily_budget_ore");
        return directionalAmountCheck(s, num(o["daily_budget_ore"]), next, expected);
      },
      noop: (s, p) => num(asObj(s)["daily_budget_ore"]) === assertOre(p["daily_budget_ore"], "daily_budget_ore"),
      post: (a, p) => num(asObj(a)["daily_budget_ore"]) === assertOre(p["daily_budget_ore"], "daily_budget_ore"),
      target: (p) => `${refCampaign(p)}:daily_budget`,
      summary: (s, p) => `LinkedIn Ads: sett dagsbudsjett for ${refCampaign(p)} til ${String(p["daily_budget_ore"])} øre (før: ${String(num(asObj(s)["daily_budget_ore"]) ?? "ukjent")} øre)`
    }
  ];
  return { provider: "linkedin", toolId: "growth_linkedin", credentialRef: "JARVIS_LINKEDIN_ACCESS_TOKEN", ops };
}

export interface LinkedinWriteOptions extends WriteTransportDeps {
  spec: ProviderToolSpec;
  apiVersion?: string;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class LinkedinWriteTransport extends GrowthWriteTransportBase {
  protected readonly label = "linkedin";
  protected readonly ops: ReadonlyMap<string, OpSpec>;
  private readonly http: VendorHttp;
  private readonly version: string;

  constructor(options: LinkedinWriteOptions) {
    super(options);
    this.ops = new Map(options.spec.ops.map((o) => [o.action, o]));
    const version = (options.apiVersion ?? "").trim() || LINKEDIN_DEFAULT_API_VERSION;
    if (!/^\d{6}$/.test(version)) throw new Error("linkedin_invalid_api_version");
    this.version = version;
    this.http = new VendorHttp({ label: "linkedin", baseUrl: options.baseUrl ?? BASE_URL, ...(options.sleep ? { sleep: options.sleep } : {}) });
  }

  protected async authenticate(credential: string): Promise<Auth> {
    if (credential.length < 8) throw new Error("linkedin_credential_invalid");
    return { headers: { authorization: `Bearer ${credential}`, "linkedin-version": this.version, "x-restli-protocol-version": "2.0.0" }, secrets: [credential] };
  }

  protected async readState(action: string, p: Params, auth: Auth): Promise<JsonValue | null> {
    if (action !== "get_campaign_state") throw new Error(`linkedin_action_not_implemented:${action}`);
    const account = accountOf(p);
    const id = assertDigits(p["campaign_id"], "campaign_id", 4, 20);
    const res = await this.http.request({ method: "GET", path: `/adAccounts/${account}/adCampaigns/${id}`, headers: auth.headers, secrets: auth.secrets, allowNotFound: true });
    if (res === null) return null;
    const o = asObj(res.json);
    if (!(str(o["account"]) ?? "").endsWith(`:${account}`)) return null;
    const budget = asObj(o["dailyBudget"]);
    return { account_id: account, campaign_id: id, name: cleanText(o["name"]), status: str(o["status"]), daily_budget_ore: budget["amount"] === undefined ? null : decimalToOre(budget["amount"]), currency: str(budget["currencyCode"]) };
  }

  protected async applyWrite(action: string, p: Params, auth: Auth, before: JsonValue): Promise<{ external_id?: string; data?: JsonValue }> {
    const account = accountOf(p);
    const id = assertDigits(p["campaign_id"], "campaign_id", 4, 20);
    const patch = async (set: Record<string, unknown>) => {
      await this.http.request({
        method: "POST", path: `/adAccounts/${account}/adCampaigns/${id}`, headers: { ...auth.headers, "x-restli-method": "PARTIAL_UPDATE" }, secrets: auth.secrets, mutation: true, body: { patch: { $set: set } }
      });
    };
    switch (action) {
      case "pause_campaign": await patch({ status: "PAUSED" }); return { external_id: id };
      case "enable_campaign": await patch({ status: "ACTIVE" }); return { external_id: id };
      case "set_campaign_daily_budget": {
        const currency = str(asObj(before)["currency"]);
        if (currency === null) throw new Error("growth_precondition_failed:currency_unreadable");
        await patch({ dailyBudget: { amount: oreToDecimal(assertOre(p["daily_budget_ore"], "daily_budget_ore")), currencyCode: currency } });
        return { external_id: id };
      }
      default:
        throw new Error(`linkedin_action_not_implemented:${action}`);
    }
  }
}

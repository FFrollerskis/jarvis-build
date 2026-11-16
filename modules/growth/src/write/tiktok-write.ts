import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { OUTCOME_UNKNOWN_PREFIX } from "@jarvis/tool-gateway";
import { normalizeGrowthTarget } from "./config.ts";
import { GrowthVendorError, VendorHttp } from "./http.ts";
import { cleanText, directionalAmountCheck, pauseEnableOps, removeOp } from "./op-builders.ts";
import { GrowthWriteTransportBase, type Auth, type OpSpec, type ProviderToolSpec, type WriteTransportDeps } from "./tool-factory.ts";
import { TWO_DECIMAL_CURRENCIES } from "./meta-ads-write.ts";
import { decimalToOre, oreToDecimal } from "./linkedin-write.ts";
import { asArr, asObj, assertDigits, assertOre, num, str, zDigits, zOre, type Params } from "./validators.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): TikTok Business API (Marketing API v1.3) - kampanjestatus og kampanjebudsjett. Nytt navnerom `growth_tiktok` (eier-eksklusivt, forbudt for modellflater); eget token
 * `JARVIS_TIKTOK_ACCESS_TOKEN` (header `Access-Token`). Svar er `{code, message, data}` med HTTP 200 også ved feil: `code != 0` er en feil; systemfeil (50000-59999) etter en mutasjon er UKJENT utfall.
 * D-41 (`VERIFIED_OFFICIAL_SEARCH_SNIPPET`, DELVIS): statusverdiene ENABLE/DISABLE/DELETE; STI-KONFLIKT mellom kilder (`/campaign/status/update/` vs `/campaign/update/status/`) - denne bygningen bruker
 * `/campaign/status/update/` og merker det UVERIFISERT; budsjettendring via `/campaign/update/` er UVERIFISERT. Begge MÅ prøves mot sandkasse-/testkonto før flagget slås på (runbook). Developer-app-godkjenning
 * og annonsør-autorisasjon = BLOCKED_EXTERNAL. Content Posting API (`video.publish`) er IKKE bygget: ureviderte klienter låses til private poster (DEFERRED, revisjon 2-6 uker).
 * DEFERRED: annonsegruppe-/annonse-handlinger, kampanjeopprettelse, kreativer/aktiva, målgrupper, Events API, tilgangsstyring.
 */
export const TIKTOK_DEFAULT_BASE_URL = "https://business-api.tiktok.com/open_api/v1.3";

const advertiserOf = (p: Params): string => {
  const v = normalizeGrowthTarget("tiktok", p["advertiser_id"]);
  if (v === null) throw new Error("growth_invalid_advertiser_id");
  return v;
};
const safeAdvertiser = (p: Params): string => normalizeGrowthTarget("tiktok", p["advertiser_id"]) ?? "?";
const campaignShape = { advertiser_id: z.string().min(5).max(25), campaign_id: zDigits(5, 25) };
const refCampaign = (p: Params) => `tiktok:advertiser:${safeAdvertiser(p)}:campaign:${typeof p["campaign_id"] === "string" ? (p["campaign_id"] as string).slice(0, 25) : "?"}`;
const statusOf = (s: JsonValue): string | null => str(asObj(s)["status"]);

export function tiktokWriteSpec(): ProviderToolSpec {
  const scopes = ["tiktok.write"];
  const ops: OpSpec[] = [
    { action: "get_campaign_state", description: "Les tilstanden til én annonsekampanje (status, budsjett, budsjettmodus, valuta) - ubetrodd leverandørdata", shape: campaignShape, risk: "A", targetParam: "advertiser_id", scopes: ["tiktok.read"] },
    ...pauseEnableOps({
      noun: "campaign", label: "TikTok-kampanje", stateAction: "get_campaign_state", targetParam: "advertiser_id", shape: campaignShape, scopes,
      statusOf: (s) => statusOf(s), terminal: ["DELETE"], paused: "DISABLE", active: "ENABLE", ref: refCampaign
    }),
    removeOp({
      action: "delete_campaign", label: "TikTok-kampanje", stateAction: "get_campaign_state", targetParam: "advertiser_id", shape: campaignShape, scopes, absentIsDone: true,
      statusOf: (s) => statusOf(s), removed: ["DELETE"], ref: refCampaign,
      rollback: "ingen teknisk reversering - DELETE er terminal hos TikTok; en ny kampanje må opprettes manuelt (før-tilstand er journalført)"
    }),
    {
      action: "set_campaign_budget", risk: "D", spend: "directional", targetParam: "advertiser_id", stateAction: "get_campaign_state", scopes,
      description: "Sett kampanjens budsjett (absolutt, i øre; kun støttede 2-desimal-valutaer). Sti og felt er UVERIFISERT mot primærkilde. Opp krever åpen finans-nødbryter; ned er alltid tillatt.",
      shape: { ...campaignShape, budget_ore: zOre, expected_budget_ore: zOre.optional() },
      rollback: "set_campaign_budget med forrige budsjett (budget_ore i før-tilstanden er journalført) gjenoppretter budsjettet",
      validate: (s, p) => {
        const o = asObj(s);
        if (o["status"] === "DELETE") return "campaign_deleted";
        if (!TWO_DECIMAL_CURRENCIES.has(str(o["currency"]) ?? "")) return "currency_not_supported";
        const expected = p["expected_budget_ore"] === undefined ? undefined : assertOre(p["expected_budget_ore"], "expected_budget_ore");
        return directionalAmountCheck(s, num(o["budget_ore"]), assertOre(p["budget_ore"], "budget_ore"), expected);
      },
      noop: (s, p) => num(asObj(s)["budget_ore"]) === assertOre(p["budget_ore"], "budget_ore"),
      post: (a, p) => num(asObj(a)["budget_ore"]) === assertOre(p["budget_ore"], "budget_ore"),
      target: (p) => `${refCampaign(p)}:budget`,
      summary: (s, p) => `TikTok Ads: sett budsjett for ${refCampaign(p)} til ${String(p["budget_ore"])} øre (før: ${String(num(asObj(s)["budget_ore"]) ?? "ukjent")} øre)`
    }
  ];
  return { provider: "tiktok", toolId: "growth_tiktok", credentialRef: "JARVIS_TIKTOK_ACCESS_TOKEN", ops };
}

export interface TiktokWriteOptions extends WriteTransportDeps {
  spec: ProviderToolSpec;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class TiktokWriteTransport extends GrowthWriteTransportBase {
  protected readonly label = "tiktok";
  protected readonly ops: ReadonlyMap<string, OpSpec>;
  private readonly http: VendorHttp;

  constructor(options: TiktokWriteOptions) {
    super(options);
    this.ops = new Map(options.spec.ops.map((o) => [o.action, o]));
    this.http = new VendorHttp({ label: "tiktok", baseUrl: options.baseUrl ?? TIKTOK_DEFAULT_BASE_URL, ...(options.sleep ? { sleep: options.sleep } : {}) });
  }

  protected async authenticate(credential: string): Promise<Auth> {
    if (credential.length < 8) throw new Error("tiktok_credential_invalid");
    return { headers: { "access-token": credential }, secrets: [credential] };
  }

  /**
   * Åpner `{code,message,data}`-konvolutten: `code != 0` er en feil selv med HTTP 200; systemfeil etter en mutasjon er UKJENT utfall. Review H1/L4: et 2xx-svar på en MUTASJON uten tallet `code`
   * (ingen konvolutt: en mellomtjeneste/feilside/uventet form) kan ikke tolkes og er UKJENT utfall - ikke en vanlig feil som inviterer til en ny skriving.
   */
  private async call(req: { method: "GET" | "POST"; path: string; query?: Record<string, string>; body?: unknown; mutation?: boolean }, auth: Auth): Promise<Record<string, unknown>> {
    const res = await this.http.request({ ...req, headers: auth.headers, secrets: auth.secrets });
    const env = asObj(res?.json);
    const code = num(env["code"]);
    if (code === 0) return asObj(env["data"]);
    if (req.mutation === true && code === null) throw new Error(`${OUTCOME_UNKNOWN_PREFIX}:tiktok_response_no_envelope`);
    if (req.mutation === true && code !== null && code >= 50000 && code <= 59999) throw new Error(`${OUTCOME_UNKNOWN_PREFIX}:tiktok_system_error_${code}`);
    throw new GrowthVendorError(`tiktok_error_${String(code ?? "unknown")}:${cleanText(env["message"], 120) ?? ""}`.slice(0, 200), 200, false, String(code ?? ""));
  }

  protected async readState(action: string, p: Params, auth: Auth): Promise<JsonValue | null> {
    if (action !== "get_campaign_state") throw new Error(`tiktok_action_not_implemented:${action}`);
    const advertiser = advertiserOf(p);
    const id = assertDigits(p["campaign_id"], "campaign_id", 5, 25);
    const data = await this.call({
      method: "GET", path: "/campaign/get/",
      query: { advertiser_id: advertiser, filtering: JSON.stringify({ campaign_ids: [id] }), fields: JSON.stringify(["campaign_id", "campaign_name", "operation_status", "budget", "budget_mode"]) }
    }, auth);
    const c = asObj(asArr(data["list"])[0]);
    // En slettet kampanje (DELETE) regnes som «finnes ikke» uansett om API-et fortsatt lister den - da stemmer readback-modellen (`absentIsDone`) i gatewayen i begge tilfeller.
    if (str(c["campaign_id"]) !== id || str(c["operation_status"]) === "DELETE") return null;
    const info = await this.call({ method: "GET", path: "/advertiser/info/", query: { advertiser_ids: JSON.stringify([advertiser]), fields: JSON.stringify(["currency"]) } }, auth);
    const currency = str(asObj(asArr(info["list"])[0])["currency"]);
    return {
      advertiser_id: advertiser, campaign_id: id, name: cleanText(c["campaign_name"]), status: str(c["operation_status"]), budget_mode: str(c["budget_mode"]),
      budget_ore: c["budget"] === undefined || c["budget"] === null ? null : decimalToOre(c["budget"]), currency
    };
  }

  protected async applyWrite(action: string, p: Params, auth: Auth): Promise<{ external_id?: string; data?: JsonValue }> {
    const advertiser = advertiserOf(p);
    const id = assertDigits(p["campaign_id"], "campaign_id", 5, 25);
    const setStatus = (operation_status: string) =>
      this.call({ method: "POST", path: "/campaign/status/update/", mutation: true, body: { advertiser_id: advertiser, campaign_ids: [id], operation_status } }, auth);
    switch (action) {
      case "pause_campaign": await setStatus("DISABLE"); return { external_id: id };
      case "enable_campaign": await setStatus("ENABLE"); return { external_id: id };
      case "delete_campaign": await setStatus("DELETE"); return { external_id: id };
      case "set_campaign_budget":
        await this.call({ method: "POST", path: "/campaign/update/", mutation: true, body: { advertiser_id: advertiser, campaign_id: id, budget: Number(oreToDecimal(assertOre(p["budget_ore"], "budget_ore"))) } }, auth);
        return { external_id: id };
      default:
        throw new Error(`tiktok_action_not_implemented:${action}`);
    }
  }
}

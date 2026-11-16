import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { normalizeGrowthTarget } from "./config.ts";
import { VendorHttp } from "./http.ts";
import { cleanText, removeOp } from "./op-builders.ts";
import { GoogleOAuthTransport, type GoogleRestOptions } from "./google-rest.ts";
import type { Auth, OpSpec, ProviderToolSpec } from "./tool-factory.ts";
import { asArr, asObj, assertDigits, str, type Params } from "./validators.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): Google Analytics 4 (Admin API v1beta) - nøkkelhendelser (konverteringer). Nytt navnerom `growth_ga4` (eier-eksklusivt, forbudt for modellflater); eget refresh-token
 * `JARVIS_GOOGLE_ANALYTICS_REFRESH_TOKEN` med scope `analytics.edit` (verifisert for create/delete via søk; patch-scope IKKE bekreftet).
 * D-41 (`VERIFIED_OFFICIAL_SEARCH_SNIPPET`): `keyEvents` har create/delete/get/list/patch under `/v1beta/properties/{id}/keyEvents`. Handlingene er konfigurasjon (hva som teller som konvertering), ingen direkte utgift = klasse C.
 * DEFERRED: patch av tellemetode (scope ikke bekreftet), egendefinerte dimensjoner/metrikker, datastrømmer, Measurement Protocol-hendelser (krever samtykke/JARVIS-084-grensen), målgrupper, Ads-lenking,
 * tilgangsstyring (`accessBindings`, v1alpha, scope `analytics.manage.users` ikke bekreftet for enkelt-create = PARTIAL/DEFERRED).
 */
const BASE_URL = "https://analyticsadmin.googleapis.com/v1beta";
const propertyOf = (p: Params): string => {
  const v = normalizeGrowthTarget("ga4", p["property_id"]);
  if (v === null) throw new Error("growth_invalid_property_id");
  return v;
};
const safeProperty = (p: Params): string => normalizeGrowthTarget("ga4", p["property_id"]) ?? "?";
const propertyShape = { property_id: z.string().min(4).max(24) };
const eventsOf = (s: JsonValue): Array<Record<string, unknown>> => asArr(asObj(s)["key_events"]).map(asObj);
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export function ga4WriteSpec(): ProviderToolSpec {
  const scopes = ["ga4.write"];
  const ops: OpSpec[] = [
    { action: "get_property", description: "Les GA4-eiendommens grunndata (navn, valuta, tidssone) - ubetrodd leverandørdata", shape: propertyShape, risk: "A", targetParam: "property_id", scopes: ["ga4.read"] },
    { action: "list_key_events", description: "List nøkkelhendelsene (konverteringene) i en GA4-eiendom - ubetrodd leverandørdata", shape: propertyShape, risk: "A", targetParam: "property_id", scopes: ["ga4.read"] },
    {
      action: "create_key_event", risk: "C", spend: "none", targetParam: "property_id", stateAction: "list_key_events", scopes,
      description: "Merk en hendelse som nøkkelhendelse (konvertering) i GA4. Finnes den allerede, gjøres ingenting (idempotent).",
      shape: { ...propertyShape, event_name: z.string().regex(EVENT_NAME), counting_method: z.enum(["ONCE_PER_EVENT", "ONCE_PER_SESSION"]).optional() },
      rollback: "delete_key_event med key_event_id fra svaret fjerner nøkkelhendelsen igjen (historiske data påvirkes ikke)",
      noop: (s, p) => eventsOf(s).some((e) => e["event_name"] === p["event_name"]),
      post: (a, p) => eventsOf(a).some((e) => e["event_name"] === p["event_name"]),
      target: (p) => `ga4:properties/${safeProperty(p)}:key_event:${typeof p["event_name"] === "string" ? p["event_name"] : "?"}`,
      summary: (_s, p) => `GA4: opprett nøkkelhendelse «${typeof p["event_name"] === "string" ? p["event_name"] : "?"}» i eiendom ${safeProperty(p)}`
    },
    removeOp({
      action: "delete_key_event", label: "GA4-nøkkelhendelse", stateAction: "list_key_events", targetParam: "property_id", risk: "C", scopes,
      shape: { ...propertyShape, key_event_id: z.string().regex(/^\d{1,20}$/) },
      statusOf: (s, p) => (eventsOf(s).some((e) => e["key_event_id"] === p["key_event_id"]) ? "PRESENT" : "REMOVED"),
      targetCheck: () => true, removed: ["REMOVED"], ref: (p) => `ga4:properties/${safeProperty(p)}:key_event:${typeof p["key_event_id"] === "string" ? p["key_event_id"] : "?"}`,
      rollback: "create_key_event med samme hendelsesnavn (fra før-tilstanden) oppretter nøkkelhendelsen på nytt (ny id)"
    })
  ];
  return { provider: "ga4", toolId: "growth_ga4", credentialRef: "JARVIS_GOOGLE_ANALYTICS_REFRESH_TOKEN", ops };
}

export class Ga4WriteTransport extends GoogleOAuthTransport {
  protected readonly label = "ga4";
  private readonly http: VendorHttp;

  constructor(options: GoogleRestOptions) {
    super(options);
    this.http = new VendorHttp({ label: "ga4", baseUrl: options.baseUrl ?? BASE_URL, ...(options.sleep ? { sleep: options.sleep } : {}) });
  }

  protected async readState(action: string, p: Params, auth: Auth): Promise<JsonValue | null> {
    const property = propertyOf(p);
    const res = await this.http.request({ method: "GET", path: `/properties/${property}`, headers: auth.headers, secrets: auth.secrets, allowNotFound: true });
    if (res === null) return null;
    const o = asObj(res.json);
    const base = { property_id: property, display_name: cleanText(o["displayName"]), currency: str(o["currencyCode"]), time_zone: str(o["timeZone"]) };
    if (action === "get_property") return base;
    if (action !== "list_key_events") throw new Error(`ga4_action_not_implemented:${action}`);
    const list = await this.http.request({ method: "GET", path: `/properties/${property}/keyEvents`, query: { pageSize: "200" }, headers: auth.headers, secrets: auth.secrets });
    const key_events = asArr(asObj(list?.json)["keyEvents"]).slice(0, 200).map((raw) => {
      const e = asObj(raw);
      return { key_event_id: (str(e["name"]) ?? "").split("/").pop() ?? null, event_name: cleanText(e["eventName"], 40), counting_method: str(e["countingMethod"]), custom: e["custom"] === true, deletable: e["deletable"] === true };
    });
    return { ...base, key_events };
  }

  protected async applyWrite(action: string, p: Params, auth: Auth): Promise<{ external_id?: string; data?: JsonValue }> {
    const property = propertyOf(p);
    switch (action) {
      case "create_key_event": {
        const res = await this.http.request({
          method: "POST", path: `/properties/${property}/keyEvents`, headers: auth.headers, secrets: auth.secrets, mutation: true,
          body: { eventName: String(p["event_name"]), ...(typeof p["counting_method"] === "string" ? { countingMethod: p["counting_method"] } : {}) }
        });
        const name = str(asObj(res?.json)["name"]);
        return { ...(name ? { external_id: name.split("/").pop() ?? name } : {}), data: { created: 1 } };
      }
      case "delete_key_event": {
        const id = assertDigits(p["key_event_id"], "key_event_id", 1, 20);
        await this.http.request({ method: "DELETE", path: `/properties/${property}/keyEvents/${id}`, headers: auth.headers, secrets: auth.secrets, mutation: true });
        return { external_id: id };
      }
      default:
        throw new Error(`ga4_action_not_implemented:${action}`);
    }
  }
}

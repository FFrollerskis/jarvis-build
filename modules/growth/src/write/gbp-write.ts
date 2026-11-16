import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { creativeUrlHost, normalizeGrowthTarget, type GrowthWriteConfig } from "./config.ts";
import { VendorHttp } from "./http.ts";
import { cleanText, removeOp } from "./op-builders.ts";
import { GoogleOAuthTransport, type GoogleRestOptions } from "./google-rest.ts";
import type { Auth, OpSpec, ProviderToolSpec } from "./tool-factory.ts";
import { asArr, asObj, assertDigits, str, zDigits, zText, type Params } from "./validators.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): Google Business Profile - åpningstider, profiltekst/nettsted, lokale innlegg og svar på omtaler. Nytt navnerom `growth_gbp` (eier-eksklusivt, forbudt for modellflater); eget
 * refresh-token `JARVIS_GOOGLE_BUSINESS_PROFILE_REFRESH_TOKEN`, scope `https://www.googleapis.com/auth/business.manage`.
 * D-41 (`VERIFIED_OFFICIAL_SEARCH_SNIPPET`, delvis): Business Information API v1 `PATCH /v1/locations/{id}?updateMask=...`; v4 `localPosts` (create/get/list/patch/delete) og `reviews.updateReply`/`deleteReply`
 * (`PUT/DELETE .../reviews/{id}/reply`, kun verifiserte lokasjoner). API-TILGANG KREVER GODKJENNING FRA GOOGLE (standardkvote er 0 forespørsler/min til tilgang er innvilget) = BLOCKED_EXTERNAL.
 * UVERIFISERT: feltnavn for regularHours/profile.description mot primærkilde, `readMask`-verdier, `TimeOfDay` for sen stengetid. Anmelders navn leses ALDRI (personopplysning uten formål).
 * DEFERRED: lokasjonsopprettelse/-sletting, kategorier, attributter, medier, spørsmål og svar, bekreftelse (verification), tilgangsstyring (Account Management API `admins` create/delete: roller IKKE bekreftet).
 */
const INFO_BASE_URL = "https://mybusinessbusinessinformation.googleapis.com/v1";
const V4_BASE_URL = "https://mybusiness.googleapis.com/v4";
const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

const locationOf = (p: Params): string => {
  const v = normalizeGrowthTarget("google_business_profile", p["location_id"]);
  if (v === null) throw new Error("growth_invalid_location_id");
  return v;
};
const safeLocation = (p: Params): string => normalizeGrowthTarget("google_business_profile", p["location_id"]) ?? "?";
const locationShape = { location_id: z.string().min(4).max(34) };
const accountLocationShape = { account_id: zDigits(4, 25), ...locationShape };
const periodShape = z.object({ open_day: z.enum(DAYS), open_time: z.string().regex(TIME), close_day: z.enum(DAYS), close_time: z.string().regex(TIME) }).strict();
const reviewsOf = (s: JsonValue): Array<Record<string, unknown>> => asArr(asObj(s)["reviews"]).map(asObj);
const postsOf = (s: JsonValue): Array<Record<string, unknown>> => asArr(asObj(s)["posts"]).map(asObj);

const toTimeOfDay = (hhmm: string) => ({ hours: Number(hhmm.slice(0, 2)), minutes: Number(hhmm.slice(3, 5)) });
const fromTimeOfDay = (t: unknown): string => {
  const o = asObj(t);
  const h = typeof o["hours"] === "number" ? o["hours"] : 0;
  const m = typeof o["minutes"] === "number" ? o["minutes"] : 0;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};
/** Kanonisk, sortert signatur for en liste åpningsperioder (for noop-/etterbetingelsessammenligning). */
export function periodsSignature(periods: unknown[]): string {
  return periods.map((raw) => {
    const o = asObj(raw);
    return `${String(o["open_day"])}@${String(o["open_time"])}-${String(o["close_day"])}@${String(o["close_time"])}`;
  }).sort().join("|");
}

export function gbpWriteSpec(config: Pick<GrowthWriteConfig, "creativeHosts">): ProviderToolSpec {
  const scopes = ["gbp.write"];
  const readScopes = ["gbp.read"];
  const ref = (p: Params, what: string) => `gbp:locations/${safeLocation(p)}:${what}`;
  const ops: OpSpec[] = [
    { action: "get_location", description: "Les lokasjonens profil (tittel, nettsted, telefon, beskrivelse, åpningstider) - ubetrodd leverandørdata", shape: locationShape, risk: "A", targetParam: "location_id", scopes: readScopes },
    { action: "list_reviews", description: "List omtalene for en lokasjon (stjerner, tekst, om det finnes svar) - UBETRODD brukertekst; anmelders navn leses aldri", shape: accountLocationShape, risk: "A", targetParam: "location_id", scopes: readScopes },
    { action: "list_local_posts", description: "List de lokale innleggene for en lokasjon (sammendrag, tilstand) - ubetrodd leverandørdata", shape: accountLocationShape, risk: "A", targetParam: "location_id", scopes: readScopes },
    {
      action: "update_location_hours", risk: "C", spend: "none", targetParam: "location_id", stateAction: "get_location", scopes,
      description: "Sett lokasjonens ordinære åpningstider (erstatter hele listen).",
      shape: { ...locationShape, periods: z.array(periodShape).min(1).max(14) },
      rollback: "update_location_hours med periods fra før-tilstanden (regular_hours er journalført) gjenoppretter åpningstidene",
      noop: (s, p) => periodsSignature(asArr(asObj(s)["regular_hours"])) === periodsSignature(asArr(p["periods"])),
      post: (a, p) => periodsSignature(asArr(asObj(a)["regular_hours"])) === periodsSignature(asArr(p["periods"])),
      target: (p) => ref(p, "hours"), summary: (_s, p) => `Business Profile: oppdater åpningstider for ${safeLocation(p)} (${asArr(p["periods"]).length} perioder)`
    },
    {
      action: "update_location_profile", risk: "C", spend: "none", targetParam: "location_id", stateAction: "get_location", scopes,
      description: "Oppdater lokasjonens beskrivelse og/eller nettsted. Nettstedets vert må stå i JARVIS_GROWTH_CREATIVE_URL_HOSTS.",
      shape: { ...locationShape, description: zText(1, 750).optional(), website_uri: z.string().url().max(2048).optional() },
      rollback: "update_location_profile med description/website_uri fra før-tilstanden (journalført) gjenoppretter profilen",
      validate: (_s, p) => {
        if (p["description"] === undefined && p["website_uri"] === undefined) return "nothing_to_update";
        return p["website_uri"] !== undefined && creativeUrlHost(p["website_uri"], config.creativeHosts) === null ? "website_host_not_allowed" : null;
      },
      noop: (s, p) => (p["description"] === undefined || asObj(s)["description"] === cleanText(p["description"], 750)) && (p["website_uri"] === undefined || asObj(s)["website_uri"] === p["website_uri"]),
      post: (a, p) => (p["description"] === undefined || asObj(a)["description"] === cleanText(p["description"], 750)) && (p["website_uri"] === undefined || asObj(a)["website_uri"] === p["website_uri"]),
      target: (p) => ref(p, "profile"), summary: (_s, p) => `Business Profile: oppdater profil for ${safeLocation(p)}`
    },
    {
      action: "create_local_post", risk: "C", spend: "none", targetParam: "location_id", stateAction: "list_local_posts", scopes, idempotentExternal: false,
      description: "Publiser et lokalt innlegg (STANDARD) på lokasjonen. Finnes et innlegg med identisk tekst fra før, gjøres ingenting. Lenkens vert må stå i JARVIS_GROWTH_CREATIVE_URL_HOSTS.",
      shape: { ...accountLocationShape, summary: zText(1, 1500), action_url: z.string().url().max(2048).optional() },
      rollback: "slett innlegget (delete_local_post er DEFERRED - gjøres i leverandørens grensesnitt); post_id fra svaret",
      validate: (_s, p) => (p["action_url"] !== undefined && creativeUrlHost(p["action_url"], config.creativeHosts) === null ? "action_url_host_not_allowed" : null),
      noop: (s, p) => postsOf(s).some((post) => post["summary"] === cleanText(p["summary"], 1500)),
      post: (a, p) => postsOf(a).some((post) => post["summary"] === cleanText(p["summary"], 1500)),
      target: (p) => ref(p, "local_post"), summary: (_s, p) => `Business Profile: publiser lokalt innlegg på ${safeLocation(p)}`
    },
    {
      action: "reply_to_review", risk: "C", spend: "none", targetParam: "location_id", stateAction: "list_reviews", scopes,
      description: "Svar på en omtale (eller erstatt eierens eksisterende svar). Kun verifiserte lokasjoner. Identisk svar fra før gir ingen endring.",
      shape: { ...accountLocationShape, review_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), comment: zText(1, 4000) },
      rollback: "delete_review_reply fjerner svaret; forrige svartekst (hvis noen) ligger i før-tilstanden",
      targetCheck: (s, p) => reviewsOf(s).some((r) => r["review_id"] === p["review_id"]),
      noop: (s, p) => reviewsOf(s).some((r) => r["review_id"] === p["review_id"] && r["reply_comment"] === cleanText(p["comment"], 4000)),
      post: (a, p) => reviewsOf(a).some((r) => r["review_id"] === p["review_id"] && r["reply_comment"] === cleanText(p["comment"], 4000)),
      target: (p) => ref(p, `review:${typeof p["review_id"] === "string" ? (p["review_id"] as string).slice(0, 60) : "?"}:reply`),
      summary: (_s, p) => `Business Profile: svar på omtale i ${safeLocation(p)}`
    },
    removeOp({
      action: "delete_review_reply", label: "Business Profile-svar på omtale", stateAction: "list_reviews", targetParam: "location_id", risk: "C", scopes,
      shape: { ...accountLocationShape, review_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) },
      statusOf: (s, p) => { const r = reviewsOf(s).find((x) => x["review_id"] === p["review_id"]); return r === undefined ? null : r["has_reply"] === true ? "PRESENT" : "REMOVED"; },
      targetCheck: (s, p) => reviewsOf(s).some((r) => r["review_id"] === p["review_id"]), removed: ["REMOVED"],
      ref: (p) => ref(p, `review:${typeof p["review_id"] === "string" ? (p["review_id"] as string).slice(0, 60) : "?"}:reply`),
      rollback: "reply_to_review med forrige svartekst (fra før-tilstanden) gjenoppretter svaret"
    })
  ];
  return { provider: "google_business_profile", toolId: "growth_gbp", credentialRef: "JARVIS_GOOGLE_BUSINESS_PROFILE_REFRESH_TOKEN", ops };
}

export class GbpWriteTransport extends GoogleOAuthTransport {
  protected readonly label = "gbp";
  private readonly info: VendorHttp;
  private readonly v4: VendorHttp;

  constructor(options: GoogleRestOptions & { v4BaseUrl?: string }) {
    super(options);
    const sleep = options.sleep ? { sleep: options.sleep } : {};
    this.info = new VendorHttp({ label: "gbp", baseUrl: options.baseUrl ?? INFO_BASE_URL, ...sleep });
    this.v4 = new VendorHttp({ label: "gbp", baseUrl: options.v4BaseUrl ?? V4_BASE_URL, ...sleep });
  }

  private v4Path(p: Params, tail: string): string {
    return `/accounts/${assertDigits(p["account_id"], "account_id", 4, 25)}/locations/${locationOf(p)}${tail}`;
  }

  protected async readState(action: string, p: Params, auth: Auth): Promise<JsonValue | null> {
    const location = locationOf(p);
    switch (action) {
      case "get_location": {
        const res = await this.info.request({ method: "GET", path: `/locations/${location}`, query: { readMask: "name,title,phoneNumbers,websiteUri,regularHours,profile" }, headers: auth.headers, secrets: auth.secrets, allowNotFound: true });
        if (res === null) return null;
        const o = asObj(res.json);
        const periods = asArr(asObj(o["regularHours"])["periods"]).slice(0, 14).map((raw) => {
          const q = asObj(raw);
          return { open_day: str(q["openDay"]), open_time: fromTimeOfDay(q["openTime"]), close_day: str(q["closeDay"]), close_time: fromTimeOfDay(q["closeTime"]) };
        });
        return {
          location_id: location, title: cleanText(o["title"], 120), website_uri: str(o["websiteUri"]), phone_primary: cleanText(asObj(o["phoneNumbers"])["primaryPhone"], 40),
          description: cleanText(asObj(o["profile"])["description"], 750), regular_hours: periods
        };
      }
      case "list_reviews": {
        const res = await this.v4.request({ method: "GET", path: this.v4Path(p, "/reviews"), query: { pageSize: "50" }, headers: auth.headers, secrets: auth.secrets, allowNotFound: true });
        if (res === null) return null;
        const reviews = asArr(asObj(res.json)["reviews"]).slice(0, 50).map((raw) => {
          const r = asObj(raw);
          const reply = asObj(r["reviewReply"]);
          return { review_id: str(r["reviewId"]), star_rating: str(r["starRating"]), comment: cleanText(r["comment"], 500), create_time: str(r["createTime"]), has_reply: str(reply["comment"]) !== null, reply_comment: cleanText(reply["comment"], 4000) };
        });
        return { location_id: location, reviews };
      }
      case "list_local_posts": {
        const res = await this.v4.request({ method: "GET", path: this.v4Path(p, "/localPosts"), query: { pageSize: "20" }, headers: auth.headers, secrets: auth.secrets, allowNotFound: true });
        if (res === null) return null;
        const posts = asArr(asObj(res.json)["localPosts"]).slice(0, 20).map((raw) => {
          const q = asObj(raw);
          return { post_id: (str(q["name"]) ?? "").split("/").pop() ?? null, summary: cleanText(q["summary"], 1500), state: str(q["state"]), topic_type: str(q["topicType"]) };
        });
        return { location_id: location, posts };
      }
      default:
        throw new Error(`gbp_action_not_implemented:${action}`);
    }
  }

  protected async applyWrite(action: string, p: Params, auth: Auth): Promise<{ external_id?: string; data?: JsonValue }> {
    const location = locationOf(p);
    switch (action) {
      case "update_location_hours": {
        const periods = asArr(p["periods"]).map((raw) => {
          const o = asObj(raw);
          return { openDay: o["open_day"], openTime: toTimeOfDay(String(o["open_time"])), closeDay: o["close_day"], closeTime: toTimeOfDay(String(o["close_time"])) };
        });
        await this.info.request({ method: "PATCH", path: `/locations/${location}`, query: { updateMask: "regularHours" }, headers: auth.headers, secrets: auth.secrets, mutation: true, body: { regularHours: { periods } } });
        return { external_id: `locations/${location}` };
      }
      case "update_location_profile": {
        const mask = [...(p["description"] !== undefined ? ["profile.description"] : []), ...(p["website_uri"] !== undefined ? ["websiteUri"] : [])];
        await this.info.request({
          method: "PATCH", path: `/locations/${location}`, query: { updateMask: mask.join(",") }, headers: auth.headers, secrets: auth.secrets, mutation: true,
          body: { ...(p["description"] !== undefined ? { profile: { description: String(p["description"]) } } : {}), ...(p["website_uri"] !== undefined ? { websiteUri: String(p["website_uri"]) } : {}) }
        });
        return { external_id: `locations/${location}` };
      }
      case "create_local_post": {
        const res = await this.v4.request({
          method: "POST", path: this.v4Path(p, "/localPosts"), headers: auth.headers, secrets: auth.secrets, mutation: true,
          body: { languageCode: "nb", summary: String(p["summary"]), topicType: "STANDARD", ...(typeof p["action_url"] === "string" ? { callToAction: { actionType: "LEARN_MORE", url: p["action_url"] } } : {}) }
        });
        const name = str(asObj(res?.json)["name"]);
        return { ...(name ? { external_id: name.split("/").pop() ?? name } : {}), data: { created: 1 } };
      }
      case "reply_to_review": {
        const review = String(p["review_id"]);
        await this.v4.request({ method: "PUT", path: this.v4Path(p, `/reviews/${encodeURIComponent(review)}/reply`), headers: auth.headers, secrets: auth.secrets, mutation: true, body: { comment: String(p["comment"]) } });
        return { external_id: review };
      }
      case "delete_review_reply": {
        const review = String(p["review_id"]);
        await this.v4.request({ method: "DELETE", path: this.v4Path(p, `/reviews/${encodeURIComponent(review)}/reply`), headers: auth.headers, secrets: auth.secrets, mutation: true });
        return { external_id: review };
      }
      default:
        throw new Error(`gbp_action_not_implemented:${action}`);
    }
  }
}

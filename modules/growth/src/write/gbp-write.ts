import { createHash } from "node:crypto";
import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { creativeHref, creativeHrefOrRaw, creativeUrlHost, normalizeGrowthTarget, type GrowthWriteConfig } from "./config.ts";
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
 * UVERIFISERT: feltnavn for regularHours/profile.description mot primærkilde, `readMask`-verdier, `TimeOfDay` for sen stengetid. Anmelders navn leses ALDRI (personopplysning uten formål), og lokasjonens telefonnummer heller ikke (review N5: `readMask` uten `phoneNumbers`, ingen `phone_primary` i tilstanden - den ville havnet i journal/ledger/audit uten at noen handling trenger den).
 * PERSONVERN (review M4): omtaletekst er brukerskrevet og kan inneholde personopplysninger (også helse). Skrivehandlingene (`reply_to_review`, `delete_review_reply`) bruker `get_review` (ÉN omtale, `reviews.get`) som tilstand:
 * kun id, stjerner, tidspunkt, om eieren har svart og en DIGEST av eierens svar - aldri omtalens tekst, aldri anmelders navn, aldri svarteksten. Dermed havner ingen omtaletekst i journalen, `tool_executions` eller
 * `audit_events` (der erasure ikke rekker). `list_reviews` (klasse A, kun for eieren å lese) viser teksten, men resultatet lagres ingen steder. Nåbarhet: `list_reviews` viser de 50 NYESTE omtalene (ingen paginering bygget =
 * DEFERRED); `get_review`/`reply_to_review`/`delete_review_reply` virker på ENHVER omtale-id eieren kjenner. Leverandørens grense for svar er 4096 BYTES (ikke tegn).
 * DEFERRED: lokasjonsopprettelse/-sletting, kategorier, attributter, medier, spørsmål og svar, bekreftelse (verification), tilgangsstyring (Account Management API `admins` create/delete: roller IKKE bekreftet).
 */
const INFO_BASE_URL = "https://mybusinessbusinessinformation.googleapis.com/v1";
const V4_BASE_URL = "https://mybusiness.googleapis.com/v4";
const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const REVIEW_ID = /^[A-Za-z0-9_-]{1,200}$/;
const STAR_RATINGS: ReadonlySet<string> = new Set(["STAR_RATING_UNSPECIFIED", "ONE", "TWO", "THREE", "FOUR", "FIVE"]);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Leverandørens grense for et svar på en omtale er 4096 BYTES (ikke tegn): 4000 flerbyte-tegn kunne overskredet den. */
const REPLY_MAX_BYTES = 4096;
const replyText = z.string().min(1).max(REPLY_MAX_BYTES).refine((value) => Buffer.byteLength(value, "utf8") <= REPLY_MAX_BYTES, "reply_too_long_bytes");
/** Digest av eierens svartekst (renset på samme måte på begge sider): sammenligning av «samme svar» uten at teksten lagres i journal/ledger/audit. */
export const replyDigest = (text: unknown): string => createHash("sha256").update(cleanText(text, REPLY_MAX_BYTES) ?? "").digest("hex");

const assertReviewId = (value: unknown): string => {
  if (typeof value !== "string" || !REVIEW_ID.test(value)) throw new Error("growth_invalid_review_id");
  return value;
};
const locationOf = (p: Params): string => {
  const v = normalizeGrowthTarget("google_business_profile", p["location_id"]);
  if (v === null) throw new Error("growth_invalid_location_id");
  return v;
};
const safeLocation = (p: Params): string => normalizeGrowthTarget("google_business_profile", p["location_id"]) ?? "?";
const locationShape = { location_id: z.string().min(4).max(34) };
const accountLocationShape = { account_id: zDigits(4, 25), ...locationShape };
const periodShape = z.object({ open_day: z.enum(DAYS), open_time: z.string().regex(TIME), close_day: z.enum(DAYS), close_time: z.string().regex(TIME) }).strict();
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
    { action: "get_location", description: "Les lokasjonens profil (tittel, nettsted, beskrivelse, åpningstider) - ubetrodd leverandørdata. Telefonnummer leses ikke (dataminimering: ingen handling trenger det)", shape: locationShape, risk: "A", targetParam: "location_id", scopes: readScopes },
    { action: "list_reviews", description: "List de 50 NYESTE omtalene for en lokasjon (stjerner, tekst, om det finnes svar) - UBETRODD brukertekst som kun vises til eieren (lagres aldri); anmelders navn leses aldri", shape: accountLocationShape, risk: "A", targetParam: "location_id", scopes: readScopes },
    {
      action: "get_review", risk: "A", targetParam: "location_id", scopes: readScopes, shape: { ...accountLocationShape, review_id: z.string().regex(REVIEW_ID) },
      description: "Les ÉN omtale: id, stjerner, tidspunkt, om eieren har svart og en digest av svaret - ALDRI omtalens tekst, anmelders navn eller svarteksten (personvern). Tilstanden som svar-/slett-handlingene bygger på."
    },
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
      action: "update_location_profile", risk: "D", spend: "none", targetParam: "location_id", stateAction: "get_location", scopes,
      description: "Oppdater lokasjonens beskrivelse og/eller nettsted. Nettstedets vert må stå i JARVIS_GROWTH_CREATIVE_URL_HOSTS.",
      shape: { ...locationShape, description: zText(1, 750).optional(), website_uri: z.string().url().max(2048).optional() },
      rollback: "update_location_profile med description/website_uri fra før-tilstanden (journalført) gjenoppretter profilen",
      validate: (_s, p) => {
        if (p["description"] === undefined && p["website_uri"] === undefined) return "nothing_to_update";
        return p["website_uri"] !== undefined && creativeUrlHost(p["website_uri"], config.creativeHosts) === null ? "website_host_not_allowed" : null;
      },
      noop: (s, p) => (p["description"] === undefined || asObj(s)["description"] === cleanText(p["description"], 750)) && (p["website_uri"] === undefined || asObj(s)["website_uri"] === creativeHrefOrRaw(p["website_uri"])),
      post: (a, p) => (p["description"] === undefined || asObj(a)["description"] === cleanText(p["description"], 750)) && (p["website_uri"] === undefined || asObj(a)["website_uri"] === creativeHrefOrRaw(p["website_uri"])),
      target: (p) => ref(p, "profile"), summary: (_s, p) => `Business Profile: oppdater profil for ${safeLocation(p)}`
    },
    {
      action: "create_local_post", risk: "D", spend: "none", targetParam: "location_id", stateAction: "list_local_posts", scopes, idempotentExternal: false,
      description: "Publiser et lokalt innlegg (STANDARD) på lokasjonen. Finnes et innlegg med identisk tekst fra før, gjøres ingenting. Lenkens vert må stå i JARVIS_GROWTH_CREATIVE_URL_HOSTS.",
      shape: { ...accountLocationShape, summary: zText(1, 1500), action_url: z.string().url().max(2048).optional() },
      rollback: "slett innlegget (delete_local_post er DEFERRED - gjøres i leverandørens grensesnitt); post_id fra svaret",
      validate: (_s, p) => (p["action_url"] !== undefined && creativeUrlHost(p["action_url"], config.creativeHosts) === null ? "action_url_host_not_allowed" : null),
      noop: (s, p) => postsOf(s).some((post) => post["summary"] === cleanText(p["summary"], 1500)),
      post: (a, p) => postsOf(a).some((post) => post["summary"] === cleanText(p["summary"], 1500)),
      target: (p) => ref(p, "local_post"), summary: (_s, p) => `Business Profile: publiser lokalt innlegg på ${safeLocation(p)}`
    },
    {
      action: "reply_to_review", risk: "D", spend: "none", targetParam: "location_id", stateAction: "get_review", scopes,
      description: "Svar på en omtale (eller erstatt eierens eksisterende svar). Kun verifiserte lokasjoner. Identisk svar fra før gir ingen endring. Svaret er maks 4096 BYTES. Journal/audit bærer aldri omtalens tekst eller svarteksten (kun en digest).",
      shape: { ...accountLocationShape, review_id: z.string().regex(REVIEW_ID), comment: replyText },
      rollback: "delete_review_reply fjerner svaret. Forrige svartekst er IKKE journalført (personvern: den kan nevne omtaleren) - kun en digest; ta vare på teksten fra Google-profilen FØR et eksisterende svar erstattes",
      targetCheck: (s, p) => asObj(s)["review_id"] === p["review_id"],
      noop: (s, p) => asObj(s)["has_reply"] === true && asObj(s)["reply_digest"] === replyDigest(p["comment"]),
      post: (a, p) => asObj(a)["has_reply"] === true && asObj(a)["reply_digest"] === replyDigest(p["comment"]),
      target: (p) => ref(p, `review:${typeof p["review_id"] === "string" ? (p["review_id"] as string).slice(0, 60) : "?"}:reply`),
      summary: (_s, p) => `Business Profile: svar på omtale i ${safeLocation(p)}`
    },
    removeOp({
      action: "delete_review_reply", label: "Business Profile-svar på omtale", spend: "none", stateAction: "get_review", targetParam: "location_id", scopes,
      shape: { ...accountLocationShape, review_id: z.string().regex(REVIEW_ID) },
      statusOf: (s) => (asObj(s)["has_reply"] === true ? "PRESENT" : "REMOVED"),
      targetCheck: (s, p) => asObj(s)["review_id"] === p["review_id"], removed: ["REMOVED"],
      ref: (p) => ref(p, `review:${typeof p["review_id"] === "string" ? (p["review_id"] as string).slice(0, 60) : "?"}:reply`),
      rollback: "reply_to_review med forrige svartekst gjenoppretter svaret - teksten er IKKE journalført (personvern; kun en digest), så den må hentes fra Google-profilen/eierens egen kopi FØR svaret slettes"
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
        const res = await this.info.request({ method: "GET", path: `/locations/${location}`, query: { readMask: "name,title,websiteUri,regularHours,profile" }, headers: auth.headers, secrets: auth.secrets, allowNotFound: true });
        if (res === null) return null;
        const o = asObj(res.json);
        const periods = asArr(asObj(o["regularHours"])["periods"]).slice(0, 14).map((raw) => {
          const q = asObj(raw);
          return { open_day: str(q["openDay"]), open_time: fromTimeOfDay(q["openTime"]), close_day: str(q["closeDay"]), close_time: fromTimeOfDay(q["closeTime"]) };
        });
        return {
          location_id: location, title: cleanText(o["title"], 120), website_uri: str(o["websiteUri"]),
          description: cleanText(asObj(o["profile"])["description"], 750), regular_hours: periods
        };
      }
      case "get_review": {
        // Review M4: ÉN omtale, KUN metadata. Omtalens tekst, anmelders navn og svarteksten leses ut av responsen og forkastes - kun en digest av svaret beholdes (for «samme svar»-sammenligning).
        const review = assertReviewId(p["review_id"]);
        const res = await this.v4.request({ method: "GET", path: this.v4Path(p, `/reviews/${encodeURIComponent(review)}`), headers: auth.headers, secrets: auth.secrets, allowNotFound: true });
        if (res === null) return null;
        const r = asObj(res.json);
        if (str(r["reviewId"]) !== review) return null; // en annen omtale enn den vi ba om er «ikke funnet»
        const reply = asObj(r["reviewReply"]);
        const rating = str(r["starRating"]);
        const created = str(r["createTime"]);
        const replyComment = str(reply["comment"]);
        return {
          location_id: location, review_id: review, star_rating: rating !== null && STAR_RATINGS.has(rating) ? rating : null, create_time: created !== null && ISO_TIME.test(created) ? created : null,
          has_reply: replyComment !== null && replyComment.trim().length > 0, reply_digest: replyComment !== null && replyComment.trim().length > 0 ? replyDigest(replyComment) : null
        };
      }
      case "list_reviews": {
        const res = await this.v4.request({ method: "GET", path: this.v4Path(p, "/reviews"), query: { pageSize: "50" }, headers: auth.headers, secrets: auth.secrets, allowNotFound: true });
        if (res === null) return null;
        const reviews = asArr(asObj(res.json)["reviews"]).slice(0, 50).map((raw) => {
          const r = asObj(raw);
          const reply = asObj(r["reviewReply"]);
          return { review_id: str(r["reviewId"]), star_rating: str(r["starRating"]), comment: cleanText(r["comment"], 500), create_time: str(r["createTime"]), has_reply: str(reply["comment"]) !== null, reply_comment: cleanText(reply["comment"], REPLY_MAX_BYTES) };
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
          body: { ...(p["description"] !== undefined ? { profile: { description: String(p["description"]) } } : {}), ...(p["website_uri"] !== undefined ? { websiteUri: creativeHref(p["website_uri"]) } : {}) }
        });
        return { external_id: `locations/${location}` };
      }
      case "create_local_post": {
        const res = await this.v4.request({
          method: "POST", path: this.v4Path(p, "/localPosts"), headers: auth.headers, secrets: auth.secrets, mutation: true,
          body: { languageCode: "nb", summary: String(p["summary"]), topicType: "STANDARD", ...(typeof p["action_url"] === "string" ? { callToAction: { actionType: "LEARN_MORE", url: creativeHref(p["action_url"]) } } : {}) }
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

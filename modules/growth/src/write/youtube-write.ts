import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { normalizeGrowthTarget } from "./config.ts";
import { VendorHttp } from "./http.ts";
import { cleanText, removeOp } from "./op-builders.ts";
import { GoogleOAuthTransport, type GoogleRestOptions } from "./google-rest.ts";
import type { Auth, OpSpec, ProviderToolSpec } from "./tool-factory.ts";
import { asArr, asObj, str, zText, type Params } from "./validators.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): YouTube Data API v3 - metadata, synlighet og sletting av EGNE videoer. Nytt navnerom `growth_youtube` (eier-eksklusivt, forbudt for modellflater); eget refresh-token
 * `JARVIS_YOUTUBE_REFRESH_TOKEN` (scope `youtube.force-ssl` - UVERIFISERT mot primærkilde; videos.update/delete krever en skrive-scope). Mål-autorisasjonen er kanal-id-en (`UC...`); en video som ikke
 * tilhører den autoriserte kanalen leses som «ikke funnet» (aldri lekket, aldri endret).
 * D-41 (`VERIFIED_OFFICIAL_SEARCH_SNIPPET`): kvotekost videos.update 50 / videos.delete 50 enheter, standardkvote 10 000/dag. `videos.update` ERSTATTER de oppgitte delene (`snippet`/`status`) - derfor sendes alle
 * kjente verdier fra før-tilstanden med (read-modify-write) så ikke tags/lisens/embeddable nullstilles. Uverifiserte API-prosjekter får videoer LÅST SOM PRIVATE ved opplasting (revisjon kreves) = BLOCKED_EXTERNAL for opplasting.
 * DEFERRED: opplasting (`videos.insert`, resumable media + revisjon), miniatyrbilder, spillelister, kommentar-moderering, kanalinnstillinger, tilgangsstyring (kanal-roller håndteres kun i YouTube Studio).
 */
const BASE_URL = "https://www.googleapis.com/youtube/v3";
const channelOf = (p: Params): string => {
  const v = normalizeGrowthTarget("youtube", p["channel_id"]);
  if (v === null) throw new Error("growth_invalid_channel_id");
  return v;
};
const safeChannel = (p: Params): string => normalizeGrowthTarget("youtube", p["channel_id"]) ?? "?";
const videoShape = { channel_id: z.string().min(24).max(24), video_id: z.string().regex(/^[A-Za-z0-9_-]{11}$/) };
const refVideo = (p: Params, what: string) => `youtube:${safeChannel(p)}:video:${typeof p["video_id"] === "string" ? (p["video_id"] as string).slice(0, 11) : "?"}:${what}`;
const NO_ANGLE = /^[^<>\p{Cc}]*$/u;
const tagsOf = (v: unknown): string[] => asArr(v).filter((t): t is string => typeof t === "string");

export function youtubeWriteSpec(): ProviderToolSpec {
  const scopes = ["youtube.write"];
  const ops: OpSpec[] = [
    { action: "get_video", description: "Les en egen video (tittel, beskrivelse, tags, synlighet, opplastingsstatus) - ubetrodd leverandørdata (1 kvoteenhet)", shape: videoShape, risk: "A", targetParam: "channel_id", scopes: ["youtube.read"] },
    {
      action: "update_video_metadata", risk: "C", spend: "none", targetParam: "channel_id", stateAction: "get_video", scopes,
      description: "Oppdater tittel, beskrivelse og/eller tags på en egen video (read-modify-write; ikke oppgitte felt beholdes). 50 kvoteenheter.",
      shape: { ...videoShape, title: zText(1, 100).optional(), description: zText(1, 5000).optional(), tags: z.array(zText(1, 100)).max(40).optional() },
      rollback: "update_video_metadata med forrige tittel/beskrivelse/tags (fra før-tilstanden, journalført) gjenoppretter metadata",
      validate: (_s, p) => {
        if (p["title"] === undefined && p["description"] === undefined && p["tags"] === undefined) return "nothing_to_update";
        if ((typeof p["title"] === "string" && !NO_ANGLE.test(p["title"])) || (typeof p["description"] === "string" && !NO_ANGLE.test(p["description"]))) return "invalid_characters";
        return tagsOf(p["tags"]).join(",").length > 500 ? "tags_too_long" : null;
      },
      noop: (s, p) => (p["title"] === undefined || asObj(s)["title"] === cleanText(p["title"], 100)) && (p["description"] === undefined || asObj(s)["description"] === cleanText(p["description"], 5000)) && (p["tags"] === undefined || JSON.stringify(tagsOf(asObj(s)["tags"])) === JSON.stringify(tagsOf(p["tags"]))),
      post: (a, p) => (p["title"] === undefined || asObj(a)["title"] === cleanText(p["title"], 100)) && (p["description"] === undefined || asObj(a)["description"] === cleanText(p["description"], 5000)) && (p["tags"] === undefined || JSON.stringify(tagsOf(asObj(a)["tags"])) === JSON.stringify(tagsOf(p["tags"]))),
      target: (p) => refVideo(p, "metadata"), summary: (_s, p) => `YouTube: oppdater metadata på ${refVideo(p, "metadata")}`
    },
    {
      action: "set_video_privacy", risk: "C", spend: "none", targetParam: "channel_id", stateAction: "get_video", scopes,
      description: "Sett synligheten (private/unlisted/public) på en egen video. NB: «public» eksponerer videoen for alle; uverifiserte API-prosjekter kan være låst til private.",
      shape: { ...videoShape, privacy_status: z.enum(["private", "unlisted", "public"]) },
      rollback: "set_video_privacy med forrige synlighet (privacy_status i før-tilstanden er journalført); publisert innhold kan ha blitt sett/kopiert og kan ikke «u-vises»",
      noop: (s, p) => asObj(s)["privacy_status"] === p["privacy_status"],
      post: (a, p) => asObj(a)["privacy_status"] === p["privacy_status"],
      target: (p) => refVideo(p, "privacy"), summary: (_s, p) => `YouTube: sett synlighet ${String(p["privacy_status"])} på ${refVideo(p, "privacy")}`
    },
    removeOp({
      action: "delete_video", label: "YouTube-video", spend: "none", stateAction: "get_video", targetParam: "channel_id", shape: videoShape, scopes, absentIsDone: true,
      statusOf: () => "PRESENT", removed: ["REMOVED"], ref: (p) => refVideo(p, "delete"),
      rollback: "ingen teknisk reversering - en slettet video kan ikke gjenopprettes via API-et (må lastes opp på nytt; før-tilstand med metadata er journalført)"
    })
  ];
  return { provider: "youtube", toolId: "growth_youtube", credentialRef: "JARVIS_YOUTUBE_REFRESH_TOKEN", ops };
}

export class YoutubeWriteTransport extends GoogleOAuthTransport {
  protected readonly label = "youtube";
  private readonly http: VendorHttp;

  constructor(options: GoogleRestOptions) {
    super(options);
    this.http = new VendorHttp({ label: "youtube", baseUrl: options.baseUrl ?? BASE_URL, ...(options.sleep ? { sleep: options.sleep } : {}) });
  }

  protected async readState(action: string, p: Params, auth: Auth): Promise<JsonValue | null> {
    if (action !== "get_video") throw new Error(`youtube_action_not_implemented:${action}`);
    const channel = channelOf(p);
    const videoId = String(p["video_id"]);
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("growth_invalid_video_id");
    const res = await this.http.request({ method: "GET", path: "/videos", query: { part: "snippet,status", id: videoId }, headers: auth.headers, secrets: auth.secrets, allowNotFound: true });
    const item = asObj(asArr(asObj(res?.json)["items"])[0]);
    const snippet = asObj(item["snippet"]);
    const status = asObj(item["status"]);
    // En video på en ANNEN kanal er «ikke funnet» for oss (mål-autorisasjon på kanalnivå, aldri lekket).
    if (str(item["id"]) === null || str(snippet["channelId"]) !== channel) return null;
    return {
      channel_id: channel, video_id: videoId, title: cleanText(snippet["title"], 100), description: cleanText(snippet["description"], 5000), tags: tagsOf(snippet["tags"]).slice(0, 40).map((t) => cleanText(t, 100)),
      category_id: str(snippet["categoryId"]), privacy_status: str(status["privacyStatus"]), upload_status: str(status["uploadStatus"]), embeddable: status["embeddable"] === true, license: str(status["license"]),
      public_stats_viewable: status["publicStatsViewable"] === true, made_for_kids: status["selfDeclaredMadeForKids"] === true
    };
  }

  protected async applyWrite(action: string, p: Params, auth: Auth, before: JsonValue): Promise<{ external_id?: string; data?: JsonValue }> {
    const videoId = String(p["video_id"]);
    const b = asObj(before);
    switch (action) {
      case "update_video_metadata": {
        const title = typeof p["title"] === "string" ? p["title"] : String(b["title"] ?? "");
        const categoryId = str(b["category_id"]);
        if (title.length === 0 || categoryId === null) throw new Error("growth_precondition_failed:snippet_incomplete");
        await this.http.request({
          method: "PUT", path: "/videos", query: { part: "snippet" }, headers: auth.headers, secrets: auth.secrets, mutation: true,
          body: { id: videoId, snippet: { title, categoryId, description: typeof p["description"] === "string" ? p["description"] : String(b["description"] ?? ""), tags: p["tags"] !== undefined ? tagsOf(p["tags"]) : tagsOf(b["tags"]) } }
        });
        return { external_id: videoId };
      }
      case "set_video_privacy": {
        await this.http.request({
          method: "PUT", path: "/videos", query: { part: "status" }, headers: auth.headers, secrets: auth.secrets, mutation: true,
          body: { id: videoId, status: { privacyStatus: String(p["privacy_status"]), embeddable: b["embeddable"] === true, publicStatsViewable: b["public_stats_viewable"] === true, selfDeclaredMadeForKids: b["made_for_kids"] === true, ...(str(b["license"]) ? { license: str(b["license"]) } : {}) } }
        });
        return { external_id: videoId };
      }
      case "delete_video": {
        await this.http.request({ method: "DELETE", path: "/videos", query: { id: videoId }, headers: auth.headers, secrets: auth.secrets, mutation: true });
        return { external_id: videoId };
      }
      default:
        throw new Error(`youtube_action_not_implemented:${action}`);
    }
  }
}

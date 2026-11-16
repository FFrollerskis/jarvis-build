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
 * D-41 (`VERIFIED_OFFICIAL_SEARCH_SNIPPET`): kvotekost videos.update 50 / videos.delete 50 enheter, standardkvote 10 000/dag. `videos.update` ERSTATTER de oppgitte delene (`snippet`/`status`): en utelatt MUTERBAR egenskap
 * som har en verdi SLETTES. Derfor er skriving en read-modify-write mot den RÅ ressursen (aldri mot den saniterte tilstanden som vises til eieren): `snippet` sendes tilbake i sin helhet slik leverandøren leverte den
 * (så vel beskrivelse med linjeskift/kapitler, tags med tab, `defaultLanguage` m.fl. beholdes eksakt) - samme mønster som leverandørens eget eksempel (`youtube/api-samples` `update_video.py`: hele `snippet` fra
 * `videos.list` sendes tilbake med `id`, kun feltene brukeren oppgir endres; `VERIFIED` mot primærkilden) - og `status` bygges av de dokumenterte skrivbare feltene (embeddable, license, publicStatsViewable,
 * selfDeclaredMadeForKids, containsSyntheticMedia, privacyStatus og - kun når målet er `private` - publishAt). Validering bruker `cleanText`; det som SENDES er alltid originalverdien.
 * Uverifiserte API-prosjekter får videoer LÅST SOM PRIVATE ved opplasting (revisjon kreves) = BLOCKED_EXTERNAL for opplasting.
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
/** Tags slik de VISES/sammenlignes (kontrolltegn fjernet): validering og noop/etterbetingelse bruker `cleanText`, men det som SENDES er alltid originalverdien. */
const cleanTags = (v: unknown): string[] => tagsOf(v).slice(0, 40).map((t) => cleanText(t, 100) ?? "");
const BCP47 = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** YouTube grenser beskrivelsen i BYTES (5000), ikke tegn: 5000 flerbyte-tegn ville blitt avvist hos leverandøren. */
const DESCRIPTION_MAX_BYTES = 5000;
const byteLimited = (max: number) => (value: string): boolean => Buffer.byteLength(value, "utf8") <= max;
/** Linjeskift/tab er LOVLIGE i en beskrivelse (kapitler, avsnitt); andre kontrolltegn og < > er det ikke (leverandøren avviser < >). */
const descriptionOk = (value: string): boolean => NO_ANGLE.test(value.replace(/[\r\n\t]/g, " "));

/**
 * Review M3: SNIPPET-kropp for `videos.update` = den RÅ `snippet` slik leverandøren leverte den (alle felt: beskrivelse med linjeskift, tags med tab, `defaultLanguage`, `defaultAudioLanguage` ...), med KUN de oppgitte
 * feltene byttet ut med de ORIGINALE (usanerte) parameterverdiene. En utelatt muterbar egenskap slettes av leverandøren, så ingenting bygges opp på nytt fra den saniterte tilstanden.
 */
export function youtubeSnippetBody(rawSnippet: Record<string, unknown>, p: Params): Record<string, unknown> {
  const snippet: Record<string, unknown> = { ...rawSnippet };
  if (typeof p["title"] === "string") snippet["title"] = p["title"];
  if (typeof p["description"] === "string") snippet["description"] = p["description"];
  if (p["tags"] !== undefined) snippet["tags"] = tagsOf(p["tags"]);
  return snippet;
}

/** De DOKUMENTERTE skrivbare `status`-feltene (verifisert via leverandørens referanse for videos.update). Alt annet i `status` er skrivebeskyttet (uploadStatus, failureReason, rejectionReason, madeForKids). */
const SETTABLE_STATUS_KEYS = ["embeddable", "license", "publicStatsViewable", "selfDeclaredMadeForKids", "containsSyntheticMedia"] as const;

/**
 * Review M3: STATUS-kropp for `videos.update` bygget av den RÅ `status`: alle skrivbare felt som FINNES beholdes uendret (ingenting sendes som `false` bare fordi det manglet), `privacyStatus` settes til målet.
 * `publishAt` (planlagt publisering) kan ifølge leverandøren kun settes når synligheten er `private`: beholdes når målet er `private`, og droppes når videoen publiseres/gjøres uoppført nå (planen er da overflødig;
 * den ligger i før-tilstanden `publish_at` som journalen bærer).
 */
export function youtubeStatusBody(rawStatus: Record<string, unknown>, privacy: string): Record<string, unknown> {
  const status: Record<string, unknown> = {};
  for (const key of SETTABLE_STATUS_KEYS) if (rawStatus[key] !== undefined) status[key] = rawStatus[key];
  if (privacy === "private" && typeof rawStatus["publishAt"] === "string") status["publishAt"] = rawStatus["publishAt"];
  status["privacyStatus"] = privacy;
  return status;
}

export function youtubeWriteSpec(): ProviderToolSpec {
  const scopes = ["youtube.write"];
  const titleOf = (v: unknown) => cleanText(v, 100);
  const descriptionOf = (v: unknown) => cleanText(v, DESCRIPTION_MAX_BYTES);
  const metadataMatches = (s: JsonValue, p: Params): boolean => {
    const o = asObj(s);
    return (p["title"] === undefined || o["title"] === titleOf(p["title"])) && (p["description"] === undefined || o["description"] === descriptionOf(p["description"]))
      && (p["tags"] === undefined || JSON.stringify(tagsOf(o["tags"])) === JSON.stringify(cleanTags(p["tags"])));
  };
  const ops: OpSpec[] = [
    { action: "get_video", description: "Les en egen video (tittel, beskrivelse, tags, synlighet, planlagt publisering, språk, opplastingsstatus) - ubetrodd leverandørdata (1 kvoteenhet)", shape: videoShape, risk: "A", targetParam: "channel_id", scopes: ["youtube.read"] },
    {
      action: "update_video_metadata", risk: "D", spend: "none", targetParam: "channel_id", stateAction: "get_video", scopes,
      description: "Oppdater tittel, beskrivelse og/eller tags på en egen video (read-modify-write mot den RÅ ressursen; ikke oppgitte felt beholdes eksakt, inkl. linjeskift, språk m.fl.). Beskrivelsen kan ha linjeskift (maks 5000 bytes). 50 kvoteenheter.",
      shape: {
        ...videoShape, title: zText(1, 100).optional(), description: zText(1, DESCRIPTION_MAX_BYTES).refine(byteLimited(DESCRIPTION_MAX_BYTES), "description_too_long_bytes").optional(), tags: z.array(zText(1, 100)).max(40).optional()
      },
      rollback: "update_video_metadata med forrige tittel/tags fra før-tilstanden (journalført); beskrivelsen er journalført flatet og kuttet til 500 tegn - den fulle originalteksten (linjeskift/kapitler) må hentes fra eierens egen kopi",
      validate: (_s, p) => {
        if (p["title"] === undefined && p["description"] === undefined && p["tags"] === undefined) return "nothing_to_update";
        if ((typeof p["title"] === "string" && !NO_ANGLE.test(p["title"])) || (typeof p["description"] === "string" && !descriptionOk(p["description"]))) return "invalid_characters";
        if (tagsOf(p["tags"]).some((t) => !NO_ANGLE.test(t))) return "invalid_characters";
        return tagsOf(p["tags"]).join(",").length > 500 ? "tags_too_long" : null;
      },
      noop: metadataMatches, post: metadataMatches,
      target: (p) => refVideo(p, "metadata"), summary: (_s, p) => `YouTube: oppdater metadata på ${refVideo(p, "metadata")}`
    },
    {
      action: "set_video_privacy", risk: "D", spend: "none", targetParam: "channel_id", stateAction: "get_video", scopes,
      description: "Sett synligheten (private/unlisted/public) på en egen video. NB: «public» eksponerer videoen for alle; uverifiserte API-prosjekter kan være låst til private. En planlagt publisering (`publishAt`) beholdes kun når målet er `private`.",
      shape: { ...videoShape, privacy_status: z.enum(["private", "unlisted", "public"]) },
      rollback: "set_video_privacy med forrige synlighet (privacy_status og evt. publish_at i før-tilstanden er journalført); publisert innhold kan ha blitt sett/kopiert og kan ikke «u-vises»",
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

  /**
   * Den RÅ videoressursen (`snippet` + `status`) slik leverandøren leverte den - grunnlaget for både den saniterte visningen (`readState`) og skrivingen (`applyWrite`). En video på en ANNEN kanal er «ikke funnet»
   * for oss (mål-autorisasjon på kanalnivå, aldri lekket). `snippet.channelId` kommer kun med `part=snippet`, så begge delene hentes alltid (1 kvoteenhet).
   */
  private async rawVideo(channel: string, videoId: string, auth: Auth): Promise<{ snippet: Record<string, unknown>; status: Record<string, unknown> } | null> {
    const res = await this.http.request({ method: "GET", path: "/videos", query: { part: "snippet,status", id: videoId }, headers: auth.headers, secrets: auth.secrets, allowNotFound: true });
    const item = asObj(asArr(asObj(res?.json)["items"])[0]);
    const snippet = asObj(item["snippet"]);
    if (str(item["id"]) === null || str(snippet["channelId"]) !== channel) return null;
    return { snippet, status: asObj(item["status"]) };
  }

  protected async readState(action: string, p: Params, auth: Auth): Promise<JsonValue | null> {
    if (action !== "get_video") throw new Error(`youtube_action_not_implemented:${action}`);
    const channel = channelOf(p);
    const videoId = String(p["video_id"]);
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("growth_invalid_video_id");
    const raw = await this.rawVideo(channel, videoId, auth);
    if (raw === null) return null;
    const { snippet, status } = raw;
    const language = str(snippet["defaultLanguage"]);
    const publishAt = str(status["publishAt"]);
    return {
      channel_id: channel, video_id: videoId, title: cleanText(snippet["title"], 100), description: cleanText(snippet["description"], DESCRIPTION_MAX_BYTES), tags: cleanTags(snippet["tags"]),
      category_id: str(snippet["categoryId"]), default_language: language !== null && BCP47.test(language) ? language : null, privacy_status: str(status["privacyStatus"]),
      publish_at: publishAt !== null && ISO_TIME.test(publishAt) ? publishAt : null, upload_status: str(status["uploadStatus"]), embeddable: status["embeddable"] === true, license: str(status["license"]),
      public_stats_viewable: status["publicStatsViewable"] === true, made_for_kids: status["selfDeclaredMadeForKids"] === true
    };
  }

  protected async applyWrite(action: string, p: Params, auth: Auth): Promise<{ external_id?: string; data?: JsonValue }> {
    const channel = channelOf(p);
    const videoId = String(p["video_id"]);
    switch (action) {
      case "update_video_metadata": {
        // Review M3: read-modify-write mot den RÅ ressursen rett FØR skrivingen (ikke mot den saniterte tilstanden): hele `snippet` sendes tilbake med kun de oppgitte feltene byttet ut.
        const raw = await this.rawVideo(channel, videoId, auth);
        if (raw === null) throw new Error("growth_precondition_failed:video_not_found");
        const snippet = youtubeSnippetBody(raw.snippet, p);
        if (typeof snippet["title"] !== "string" || snippet["title"].length === 0 || str(snippet["categoryId"]) === null) throw new Error("growth_precondition_failed:snippet_incomplete");
        await this.http.request({ method: "PUT", path: "/videos", query: { part: "snippet" }, headers: auth.headers, secrets: auth.secrets, mutation: true, body: { id: videoId, snippet } });
        return { external_id: videoId };
      }
      case "set_video_privacy": {
        const raw = await this.rawVideo(channel, videoId, auth);
        if (raw === null) throw new Error("growth_precondition_failed:video_not_found");
        await this.http.request({
          method: "PUT", path: "/videos", query: { part: "status" }, headers: auth.headers, secrets: auth.secrets, mutation: true,
          body: { id: videoId, status: youtubeStatusBody(raw.status, String(p["privacy_status"])) }
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

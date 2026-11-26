import { encodePathSegment, guardedFetch, isIndeterminateTransportError, transportErrorKind, UnsafeVendorUrlError, type GuardedFetchInit } from "@jarvis/tool-gateway";
import type { CommsChannel, CommsProvider } from "./channels.ts";
import type { TemplateContent } from "./policy.ts";

/**
 * WP-G1 (D-463, P1c + P2f): kanal-ADAPTERE - ett tynt, testbart lag per leverandør (CLAUDE.md regel 3: alle leverandører bak adaptere). En adapter gjør KUN leverandørkallet; ALL policy (opt-out, stille timer, AI-opplysning,
 * kontoer, vindu) er avgjort FØR adapteren kalles (`policy.ts`), og journalen føres av traktene rundt (`funnel.ts`). Ingen leverandør-SDK: rå `guardedFetch` (URL-sikring, ingen redirect på mutasjoner, tidsavbrudd).
 *
 * FEILKLASSIFISERING (idempotens/replay etter ukjent utfall): en mutasjon som KAN ha nådd leverandøren men der svaret mangler/er uleselig er `outcome_unknown:<kode>` - aldri en vanlig feil som inviterer til dobbel sending:
 *   - nettverksfeil/tidsavbrudd ETTER at forespørselen kan ha gått ut, 3xx (uventet redirect), 5xx, og et 2xx-svar uten bekreftet meldings-id = UKJENT;
 *   - et entydig leverandøravslag (4xx, Slack `ok:false`, 429) og feil som BEVISER at ingenting ble sendt (ugyldig URL, DNS, tilkobling nektet) = vanlig feil, retry tillatt med NY forespørsels-id.
 * Feilkoder er faste strenger (`comms_provider_rejected:<leverandør>:<kode>`) - aldri leverandørens fritekst (kan sitere klientdata/token).
 */
export interface AdapterTarget {
  readonly account_ref: string;
  readonly recipient: string;
}

export interface AdapterSend extends AdapterTarget {
  readonly text: string | null;
  readonly template: TemplateContent | null;
  readonly media: { readonly kind: "image" | "document" | "audio" | "video"; readonly url: string } | null;
  readonly thread_ref: string | null;
}

export interface AdapterResult {
  readonly provider_message_id: string;
  readonly thread_ref?: string;
}

export interface ChannelAdapter {
  readonly provider: CommsProvider;
  send(request: AdapterSend, credential: string): Promise<AdapterResult>;
  edit?(request: AdapterTarget & { target_message_id: string; text: string }, credential: string): Promise<AdapterResult>;
  delete?(request: AdapterTarget & { target_message_id: string }, credential: string): Promise<void>;
  react?(request: AdapterTarget & { target_message_id: string; reaction: string }, credential: string): Promise<void>;
  /** Fersk lesing av en melding (preflight/etterbetingelse for sletting): finnes den fortsatt? */
  messageExists?(request: AdapterTarget & { target_message_id: string }, credential: string): Promise<boolean>;
  /**
   * Utgående samtale (P3h). `script` er HELE det som skal sies og begynner ALLTID med AI-opplysningen (policyen setter den først). Opptak er aldri på. Kun leverandører der opplysningen kan garanteres som første talte innhold har
   * denne metoden (Twilio med inline TwiML); en leverandør uten den feiler lukket (`comms_action_not_supported_by_provider`).
   */
  call?(request: AdapterTarget & { script: string }, credential: string): Promise<AdapterResult>;
}

/** Leverandøravslag (entydig: ingen bivirkning). `code` er en trygg, fast kode. */
export class ProviderRejectedError extends Error {
  constructor(readonly provider: string, readonly code: string) {
    super(`comms_provider_rejected:${provider}:${code}`);
    this.name = "ProviderRejectedError";
  }
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,60}$/;
export function safeVendorCode(value: unknown): string {
  const s = typeof value === "number" ? String(value) : value;
  return typeof s === "string" && SAFE_CODE.test(s) ? s.toLowerCase() : "unspecified";
}

const MAX_BODY_CHARS = 1_000_000;

export interface ProviderResponse {
  readonly status: number;
  readonly json: Record<string, unknown> | null;
}

/**
 * ÉN felles fetch-vei for adapterne. `mutation` = kallet kan endre noe hos leverandøren: da er alt som ikke BEVISER «aldri sendt» et UKJENT utfall. Lesinger kaster vanlige feil. Svaret leses begrenset (1 MB).
 */
export async function providerCall(provider: string, url: string, init: GuardedFetchInit, mutation: boolean): Promise<ProviderResponse> {
  let response: Response;
  try {
    response = await guardedFetch(url, init);
  } catch (err) {
    if (err instanceof UnsafeVendorUrlError) {
      // En uventet redirect betyr at forespørselen GIKK UT og leverandøren svarte med 3xx - utfallet er ukjent. Alle andre URL-feil skjedde FØR sending.
      if (mutation && err.reason.startsWith("unexpected_redirect")) throw new Error(`outcome_unknown:comms_${provider}_redirect`);
      throw new Error(`comms_unsafe_request:${provider}`);
    }
    if (mutation && isIndeterminateTransportError(err)) throw new Error(`outcome_unknown:comms_${provider}_transport_${transportErrorKind(err)}`);
    throw new Error(`comms_provider_unreachable:${provider}`);
  }
  if (mutation && response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`outcome_unknown:comms_${provider}_http_${response.status}`);
  }
  let json: Record<string, unknown> | null = null;
  try {
    const text = await response.text();
    if (text.length > MAX_BODY_CHARS) {
      if (mutation && response.ok) throw new Error(`outcome_unknown:comms_${provider}_response_too_large`);
    } else if (text.length > 0) {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("outcome_unknown:")) throw err;
    // Uleselig svar: en 2xx-mutasjon er UKJENT (kan være utført); alt annet behandles som «ingen tolkbar kropp».
    if (mutation && response.ok) throw new Error(`outcome_unknown:comms_${provider}_unreadable_response`);
  }
  return { status: response.status, json };
}

function rejectFrom(provider: string, res: ProviderResponse, path: readonly string[]): never {
  let cursor: unknown = res.json;
  for (const key of path) cursor = typeof cursor === "object" && cursor !== null && !Array.isArray(cursor) ? (cursor as Record<string, unknown>)[key] : undefined;
  // Telnyx svarer `errors: [{ code, ... }]`: koden til første feil.
  if (Array.isArray(cursor)) cursor = typeof cursor[0] === "object" && cursor[0] !== null ? (cursor[0] as Record<string, unknown>)["code"] : undefined;
  throw new ProviderRejectedError(provider, cursor === undefined ? `http_${res.status}` : safeVendorCode(cursor));
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

const DEFAULT_CALL_VOICE = "Polly.Liv";

/** Er ALLE tegn gyldige i XML 1.0 (`Char`: tab, linjeskift, vognretur, U+0020-D7FF, U+E000-FFFD, U+10000-10FFFF)? U+FFFE/U+FFFF, kontrolltegn og ensomme surrogater er det ikke. */
export function isXmlSafe(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (!(cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff))) return false;
  }
  return true;
}

/** XML-escaping for TwiML (`&`, `<`, `>`, `"`, `'`): ingen tekst kan lukke `<Say>` eller legge til egne TwiML-verb. */
export function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ------------------------------------------------------------------------------------------------ Slack
/**
 * Slack Web API (verifisert mot Slacks metodereferanser via søk 2026-11): `chat.postMessage`/`chat.update`/`chat.delete` -> `chat:write`; `reactions.add` -> `reactions:write` (channel, name, timestamp påkrevd);
 * `conversations.history`/`replies` -> `channels:history`/`groups:history`/`im:history`/`mpim:history`. Slack svarer ofte HTTP 200 med `{ok:false,error}` - `ok` sjekkes ALLTID. Lenke-/mediaforhåndsvisning er slått av
 * (Slack henter ellers URL-er i teksten selv).
 */
export class SlackAdapter implements ChannelAdapter {
  readonly provider = "slack" as const;

  private async api(method: string, token: string, body: Record<string, unknown>, mutation: boolean): Promise<Record<string, unknown>> {
    const res = await providerCall("slack", `https://slack.com/api/${method}`, { method: "POST", headers: bearer(token), body: JSON.stringify(body) }, mutation);
    if (res.json === null) {
      // En lest, tom 2xx-mutasjon er UKJENT; et HTTP-avslag (f.eks. 429 uten kropp) er et entydig avslag.
      if (mutation && res.status < 400) throw new Error("outcome_unknown:comms_slack_unreadable_response");
      throw new ProviderRejectedError("slack", `http_${res.status}`);
    }
    if (res.json["ok"] !== true) {
      // WP-G1c (JARVIS-112 g3): Slack dokumenterer `fatal_error` og `internal_error` som feil der «noe av operasjonen kan ha lyktes før feilen oppsto» (UVERIFISERT mot Slacks egen referanse i denne økten: docs.slack.dev var ikke nåbar, kun
      // søkeutdrag og funnet L4 i reviewer A). For en MUTASJON er utfallet derfor UKJENT, aldri et sikkert avslag: journalen får `outcome_unknown` (teller i takene, ingen automatisk retry, eieren avstemmer), ikke `failed` som tillater en ny
      // sending med ny nøkkel og dermed en mulig dobbel melding. Lesinger er uberørt (en lesing har ingen effekt å være usikker på). Kun koden `comms_slack_<kode>` forlater adapteren, aldri leverandørens tekst.
      const code = res.json["error"];
      if (mutation && (code === "fatal_error" || code === "internal_error")) throw new Error(`outcome_unknown:comms_slack_${code}`);
      return rejectFrom("slack", res, ["error"]);
    }
    return res.json;
  }

  async send(request: AdapterSend, token: string): Promise<AdapterResult> {
    const body: Record<string, unknown> = { channel: request.recipient, text: request.text, unfurl_links: false, unfurl_media: false };
    if (request.thread_ref !== null) body["thread_ts"] = request.thread_ref;
    const json = await this.api("chat.postMessage", token, body, true);
    const ts = json["ts"];
    if (typeof ts !== "string" || ts.length === 0) throw new Error("outcome_unknown:comms_slack_no_message_id");
    const threadTs = (json["message"] as { thread_ts?: unknown } | undefined)?.thread_ts;
    return { provider_message_id: ts, thread_ref: typeof threadTs === "string" ? threadTs : request.thread_ref ?? ts };
  }

  async edit(request: AdapterTarget & { target_message_id: string; text: string }, token: string): Promise<AdapterResult> {
    const json = await this.api("chat.update", token, { channel: request.recipient, ts: request.target_message_id, text: request.text, unfurl_links: false, unfurl_media: false }, true);
    return { provider_message_id: typeof json["ts"] === "string" ? (json["ts"] as string) : request.target_message_id };
  }

  async delete(request: AdapterTarget & { target_message_id: string }, token: string): Promise<void> {
    try {
      await this.api("chat.delete", token, { channel: request.recipient, ts: request.target_message_id }, true);
    } catch (err) {
      // Allerede borte = etterbetingelsen («meldingen finnes ikke») er oppfylt.
      if (err instanceof ProviderRejectedError && err.code === "message_not_found") return;
      throw err;
    }
  }

  async react(request: AdapterTarget & { target_message_id: string; reaction: string }, token: string): Promise<void> {
    const name = request.reaction.replace(/^:|:$/g, "");
    if (!/^[a-z0-9_+-]{1,100}$/.test(name)) throw new ProviderRejectedError("slack", "invalid_reaction_name");
    try {
      await this.api("reactions.add", token, { channel: request.recipient, name, timestamp: request.target_message_id }, true);
    } catch (err) {
      if (err instanceof ProviderRejectedError && err.code === "already_reacted") return;
      throw err;
    }
  }

  async messageExists(request: AdapterTarget & { target_message_id: string }, token: string): Promise<boolean> {
    const json = await this.api("conversations.history", token, { channel: request.recipient, latest: request.target_message_id, inclusive: true, limit: 1 }, false);
    const first = (json["messages"] as Array<{ ts?: unknown }> | undefined)?.[0];
    return first?.ts === request.target_message_id;
  }
}

// ------------------------------------------------------------------------------------------------ Discord
/**
 * Discord REST v10: opprett (`POST /channels/{id}/messages`), rediger (`PATCH`), slett (`DELETE`; egen melding trenger ikke MANAGE_MESSAGES - kun andres), reaksjon (`PUT .../reactions/{emoji}/@me`).
 * Omtale-parsing er ALLTID av (`allowed_mentions: { parse: [] }`): en modellstyrt tekst kan aldri kringkaste @everyone/@here. UVERIFISERT i denne økten: eksakte tillatelsesbit for reaksjon (READ_MESSAGE_HISTORY + ADD_REACTIONS).
 */
export class DiscordAdapter implements ChannelAdapter {
  readonly provider = "discord" as const;
  private static readonly BASE = "https://discord.com/api/v10";

  private headers(token: string): Record<string, string> {
    return { authorization: `Bot ${token}`, "content-type": "application/json" };
  }

  private async mutate(method: "POST" | "PATCH" | "DELETE" | "PUT", path: string, token: string, body?: Record<string, unknown>): Promise<ProviderResponse> {
    const res = await providerCall("discord", `${DiscordAdapter.BASE}${path}`, { method, headers: this.headers(token), ...(body ? { body: JSON.stringify(body) } : {}) }, true);
    if (res.status >= 400) return rejectFrom("discord", res, ["code"]);
    return res;
  }

  async send(request: AdapterSend, token: string): Promise<AdapterResult> {
    const body: Record<string, unknown> = { content: request.text, allowed_mentions: { parse: [] } };
    if (request.thread_ref !== null) body["message_reference"] = { message_id: request.thread_ref, fail_if_not_exists: false };
    const res = await this.mutate("POST", `/channels/${encodePathSegment(request.recipient, "channel")}/messages`, token, body);
    const id = res.json?.["id"];
    if (typeof id !== "string" || id.length === 0) throw new Error("outcome_unknown:comms_discord_no_message_id");
    return { provider_message_id: id, thread_ref: request.thread_ref ?? id };
  }

  async edit(request: AdapterTarget & { target_message_id: string; text: string }, token: string): Promise<AdapterResult> {
    await this.mutate("PATCH", `/channels/${encodePathSegment(request.recipient, "channel")}/messages/${encodePathSegment(request.target_message_id, "message")}`, token, { content: request.text, allowed_mentions: { parse: [] } });
    return { provider_message_id: request.target_message_id };
  }

  async delete(request: AdapterTarget & { target_message_id: string }, token: string): Promise<void> {
    try {
      await this.mutate("DELETE", `/channels/${encodePathSegment(request.recipient, "channel")}/messages/${encodePathSegment(request.target_message_id, "message")}`, token);
    } catch (err) {
      if (err instanceof ProviderRejectedError && (err.code === "10008" || err.code === "http_404")) return; // Unknown Message = allerede borte
      throw err;
    }
  }

  async react(request: AdapterTarget & { target_message_id: string; reaction: string }, token: string): Promise<void> {
    await this.mutate("PUT", `/channels/${encodePathSegment(request.recipient, "channel")}/messages/${encodePathSegment(request.target_message_id, "message")}/reactions/${encodeURIComponent(request.reaction)}/@me`, token);
  }

  async messageExists(request: AdapterTarget & { target_message_id: string }, token: string): Promise<boolean> {
    const res = await providerCall("discord", `${DiscordAdapter.BASE}/channels/${encodePathSegment(request.recipient, "channel")}/messages/${encodePathSegment(request.target_message_id, "message")}`, { headers: this.headers(token) }, false);
    if (res.status === 404) return false;
    if (res.status >= 400) return rejectFrom("discord", res, ["code"]);
    return res.json?.["id"] === request.target_message_id;
  }
}

// ------------------------------------------------------------------------------------------------ WhatsApp Business (Meta Cloud API)
/**
 * `POST /{phone_number_id}/messages` (verifisert: send-endepunktet og `type: template` med template-objekt). Tekst, mal og media (lenke). Reaksjon (`type: reaction`) er UVERIFISERT mot Metas dokumentasjon i denne økten.
 * Fritekst er kun lovlig innenfor 24-timers kundeserviceviduet (avgjort av policyen FØR dette kalles). Grafversjonen er konfigurerbar (`JARVIS_META_GRAPH_VERSION`, standard v25.0 - UVERIFISERT).
 */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly provider = "meta_whatsapp" as const;
  constructor(private readonly graphVersion: string) {}

  private async post(request: AdapterTarget, token: string, payload: Record<string, unknown>): Promise<ProviderResponse> {
    const res = await providerCall("whatsapp", `https://graph.facebook.com/${this.graphVersion}/${encodePathSegment(request.account_ref, "phone_number_id")}/messages`,
      { method: "POST", headers: bearer(token), body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: request.recipient, ...payload }) }, true);
    if (res.status >= 400) return rejectFrom("whatsapp", res, ["error", "code"]);
    return res;
  }

  async send(request: AdapterSend, token: string): Promise<AdapterResult> {
    let payload: Record<string, unknown>;
    if (request.template !== null) {
      const t = request.template;
      payload = {
        type: "template",
        template: { name: t.name, language: { code: t.language }, ...(t.params.length > 0 ? { components: [{ type: "body", parameters: t.params.map((p) => ({ type: "text", text: p })) }] } : {}) }
      };
    } else if (request.media !== null) {
      const media = request.media;
      if (media.kind === "audio") {
        // A-M1: en WhatsApp-lydmelding kan ikke ha bildetekst, så AI-opplysningen ville gått tapt (mens journalen sa `ai_disclosure_applied`). Opplysningen (og evt. tekst) sendes derfor som EGEN tekstmelding FØRST, og lyden rett etter.
        // Feiler lyden entydig ETTER at teksten er levert, er noe levert til mottakeren: utfallet er da UKJENT (aldri `failed`, som ville late som at ingenting nådde fram).
        if (request.text === null || request.text.length === 0) throw new Error("comms_whatsapp_audio_requires_disclosure_text");
        await this.postWithId(request, token, { type: "text", text: { body: request.text, preview_url: false } });
        try {
          return { provider_message_id: await this.postWithId(request, token, { type: "audio", audio: { link: media.url } }) };
        } catch (err) {
          if (err instanceof ProviderRejectedError) throw new Error("outcome_unknown:comms_whatsapp_audio_not_delivered_after_disclosure");
          throw err;
        }
      }
      payload = { type: media.kind, [media.kind]: { link: media.url, ...(request.text !== null ? { caption: request.text } : {}) } };
    } else {
      payload = { type: "text", text: { body: request.text, preview_url: false } };
    }
    return { provider_message_id: await this.postWithId(request, token, payload) };
  }

  /** Sender én melding og krever et bekreftet meldings-id (2xx uten id er UKJENT utfall). */
  private async postWithId(request: AdapterTarget, token: string, payload: Record<string, unknown>): Promise<string> {
    const res = await this.post(request, token, payload);
    const id = (res.json?.["messages"] as Array<{ id?: unknown }> | undefined)?.[0]?.id;
    if (typeof id !== "string" || id.length === 0) throw new Error("outcome_unknown:comms_whatsapp_no_message_id");
    return id;
  }

  async react(request: AdapterTarget & { target_message_id: string; reaction: string }, token: string): Promise<void> {
    await this.post(request, token, { type: "reaction", reaction: { message_id: request.target_message_id, emoji: request.reaction } });
  }
}

// ------------------------------------------------------------------------------------------------ SMS: Twilio og Telnyx
/**
 * Twilio Messages API (`POST /Accounts/{sid}/Messages.json`, Basic-auth med AccountSid/AuthToken). STOP-avmelding: Twilio svarer feil 21610 (verifisert mot Twilios feilkodeside) på sending til en avmeldt mottaker - kallerlaget
 * registrerer da avmeldingen selv (`ProviderRejectedError.code === "21610"`). `From` er ALLTID den allowlistede kontoen (`account_ref`), aldri en parameter.
 */
export class TwilioSmsAdapter implements ChannelAdapter {
  readonly provider = "twilio" as const;
  constructor(private readonly accountSid: () => Promise<string | null>, private readonly options: { callLanguage?: string; callVoice?: string } = {}) {}

  /**
   * Utgående samtale: `POST /Accounts/{sid}/Calls.json` med `To`, `From` (alltid den allowlistede kontoen) og INLINE `Twiml` (`<Say>` - ingen URL å hente, ingen opptak: parameteren `Record` sendes aldri). Manuset er XML-escapet (ingen
   * TwiML-injeksjon) og begynner med AI-opplysningen (satt av policyen). UVERIFISERT mot Twilios dokumentasjon i denne økten: eksakt `Twiml`-parameter, `<Say language="nb-NO">`-støtte og at opptak er av som standard.
   */
  async call(request: AdapterTarget & { script: string }, authToken: string): Promise<AdapterResult> {
    const sid = await this.accountSid();
    if (!sid || !/^[A-Za-z0-9]{10,64}$/.test(sid)) throw new Error("comms_twilio_account_sid_not_configured");
    const language = this.options.callLanguage ?? "nb-NO";
    if (!/^[a-z]{2}-[A-Z]{2}$/.test(language)) throw new Error("comms_twilio_call_language_invalid");
    // L4: `<Say language="nb-NO">` uten `voice` bruker standardstemmen, som ikke støtter norsk (kan feile eller lese feil språk) - en eksplisitt stemme settes. `Polly.Liv` (Amazon Polly, norsk bokmål) er UVERIFISERT mot Twilios stemmeliste i denne økten.
    const voice = this.options.callVoice ?? DEFAULT_CALL_VOICE;
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,39}$/.test(voice)) throw new Error("comms_twilio_call_voice_invalid");
    // XML 1.0 tillater ikke alle tegn (U+FFFE/U+FFFF, kontrolltegn): manuset avvises FØR noe sendes i stedet for at Twilio avviser/avkorter TwiML-en etter at AI-opplysningen er lest opp.
    if (!isXmlSafe(request.script)) throw new Error("comms_twiml_invalid_character");
    const twiml = `<Response><Say voice="${voice}" language="${language}">${xmlEscape(request.script)}</Say></Response>`;
    const res = await providerCall("twilio", `https://api.twilio.com/2010-04-01/Accounts/${encodePathSegment(sid, "account_sid")}/Calls.json`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: request.recipient, From: request.account_ref, Twiml: twiml }).toString()
    }, true);
    if (res.status >= 400) return rejectFrom("twilio", res, ["code"]);
    const id = res.json?.["sid"];
    if (typeof id !== "string" || id.length === 0) throw new Error("outcome_unknown:comms_twilio_no_call_id");
    return { provider_message_id: id };
  }

  async send(request: AdapterSend, authToken: string): Promise<AdapterResult> {
    const sid = await this.accountSid();
    if (!sid || !/^[A-Za-z0-9]{10,64}$/.test(sid)) throw new Error("comms_twilio_account_sid_not_configured");
    const res = await providerCall("twilio", `https://api.twilio.com/2010-04-01/Accounts/${encodePathSegment(sid, "account_sid")}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: request.recipient, From: request.account_ref, Body: request.text ?? "" }).toString()
    }, true);
    if (res.status >= 400) return rejectFrom("twilio", res, ["code"]);
    const id = res.json?.["sid"];
    if (typeof id !== "string" || id.length === 0) throw new Error("outcome_unknown:comms_twilio_no_message_id");
    return { provider_message_id: id };
  }
}

/** Telnyx Messaging API v2 (`POST /v2/messages`, Bearer API-nøkkel; samme form som eksisterende `telnyx.notify`). Mottaker-STOP håndteres av Telnyx/operatør og av vårt eget opt-out-register. */
export class TelnyxSmsAdapter implements ChannelAdapter {
  readonly provider = "telnyx" as const;

  async send(request: AdapterSend, apiKey: string): Promise<AdapterResult> {
    const res = await providerCall("telnyx", "https://api.telnyx.com/v2/messages", {
      method: "POST", headers: bearer(apiKey), body: JSON.stringify({ from: request.account_ref, to: request.recipient, text: request.text })
    }, true);
    if (res.status >= 400) return rejectFrom("telnyx", res, ["errors"]);
    const id = (res.json?.["data"] as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || id.length === 0) throw new Error("outcome_unknown:comms_telnyx_no_message_id");
    return { provider_message_id: id };
  }
}

// ------------------------------------------------------------------------------------------------ Messenger / Instagram (Meta Send API, P2f)
/**
 * Messenger Platform Send API: `POST /{page_id}/messages` med `recipient: { id }` (side-scopet id), `messaging_type: "RESPONSE"` og `message: { text }` (verifisert via søk mot Metas Send API-referanse 2026-11: `pages_messaging`,
 * side-tilgangstoken, RESPONSE kun innenfor 24-timersvinduet). Meldingskoder (`MESSAGE_TAG`), engangsvarsler og sponsede meldinger brukes ALDRI (policyen avslår tekst utenfor vinduet). Instagram med Facebook-side bruker SAMME Send API
 * (IGSID som mottaker; `account_ref` er id-en i `/{id}/messages`-stien). UVERIFISERT: «Instagram API with Instagram Login» (annen vert/sti), Graf-versjonen, og at app-gjennomgang er innvilget (BLOCKED_EXTERNAL live).
 */
export class MetaMessagingAdapter implements ChannelAdapter {
  constructor(readonly provider: "meta_messenger" | "meta_instagram", private readonly graphVersion: string) {}

  private get label(): string {
    return this.provider === "meta_messenger" ? "messenger" : "instagram";
  }

  async send(request: AdapterSend, token: string): Promise<AdapterResult> {
    if (request.text === null || request.template !== null || request.media !== null) throw new ProviderRejectedError(this.label, "text_only_channel");
    const res = await providerCall(this.label, `https://graph.facebook.com/${this.graphVersion}/${encodePathSegment(request.account_ref, "page_id")}/messages`, {
      method: "POST", headers: bearer(token), body: JSON.stringify({ recipient: { id: request.recipient }, messaging_type: "RESPONSE", message: { text: request.text } })
    }, true);
    if (res.status >= 400) return rejectFrom(this.label, res, ["error", "code"]);
    const id = res.json?.["message_id"];
    if (typeof id !== "string" || id.length === 0) throw new Error(`outcome_unknown:comms_${this.label}_no_message_id`);
    return { provider_message_id: id };
  }
}

// ------------------------------------------------------------------------------------------------ Microsoft Teams (Graph, P2f)
/**
 * Microsoft Graph: `POST /chats/{chat-id}/messages` og `POST /teams/{team-id}/channels/{channel-id}/messages` med `body: { contentType: "text", content }` (ren tekst: ingen HTML, ingen omtaler). VERIFISERT via søk mot Microsofts
 * rettighetsreferanse 2026-11: `ChatMessage.Send` og `ChannelMessage.Send` finnes KUN som DELEGERTE rettigheter (app-only kan ikke sende; `Teamwork.Migrate.All` er kun for migrering) - sending krever derfor eierens egen delegerte
 * tilgang (refresh-token med disse scopene -> access-token via `tokenFor`) og nytt eier-samtykke (BLOCKED_EXTERNAL live). Rotert refresh-token lagres IKKE (DEFERRED). Redigering/sletting/reaksjon er ikke bygget (DEFERRED).
 */
export class TeamsGraphAdapter implements ChannelAdapter {
  readonly provider = "ms_graph" as const;
  constructor(private readonly tokenFor: (credential: string) => Promise<string> = async (credential) => credential) {}

  private path(recipient: string): string {
    if (recipient.startsWith("chat:")) return `/chats/${encodePathSegment(recipient.slice("chat:".length), "chat_id")}/messages`;
    if (recipient.startsWith("channel:")) {
      const [team, channel] = recipient.slice("channel:".length).split("/");
      if (team === undefined || channel === undefined) throw new ProviderRejectedError("teams", "invalid_target");
      return `/teams/${encodePathSegment(team, "team_id")}/channels/${encodePathSegment(channel, "channel_id")}/messages`;
    }
    throw new ProviderRejectedError("teams", "invalid_target");
  }

  async send(request: AdapterSend, credential: string): Promise<AdapterResult> {
    if (request.text === null || request.template !== null || request.media !== null) throw new ProviderRejectedError("teams", "text_only_channel");
    const path = this.path(request.recipient);
    let token: string;
    try {
      token = await this.tokenFor(credential);
    } catch {
      throw new Error("comms_teams_token_unavailable");
    }
    const res = await providerCall("teams", `https://graph.microsoft.com/v1.0${path}`, { method: "POST", headers: bearer(token), body: JSON.stringify({ body: { contentType: "text", content: request.text } }) }, true);
    if (res.status >= 400) return rejectFrom("teams", res, ["error", "code"]);
    const id = res.json?.["id"];
    if (typeof id !== "string" || id.length === 0) throw new Error("outcome_unknown:comms_teams_no_message_id");
    return { provider_message_id: id };
  }
}

/** Credential-referansene (vault-navn, ALDRI verdier) per leverandør. Samme navn som de eksisterende connectorene bruker - ingen ny credential-vei. */
export const PROVIDER_CREDENTIAL_REFS: Readonly<Record<CommsProvider, string>> = {
  slack: "JARVIS_SLACK_BOT_TOKEN",
  discord: "JARVIS_DISCORD_BOT_TOKEN",
  meta_whatsapp: "JARVIS_WHATSAPP_TOKEN",
  twilio: "JARVIS_TWILIO_AUTH_TOKEN",
  telnyx: "JARVIS_TELNYX_API_KEY",
  ms_graph: "JARVIS_TEAMS_REFRESH_TOKEN",
  meta_messenger: "JARVIS_META_PAGE_ACCESS_TOKEN",
  meta_instagram: "JARVIS_INSTAGRAM_ACCESS_TOKEN"
};

/** Connector-id-en en eierfrys skal gjelde for, utledet av den LØSTE credential-referansen (samme id-er som `CONNECTOR_REGISTRY`). */
export function connectorIdsForCredentialRef(ref: string): readonly string[] {
  switch (ref) {
    case "JARVIS_SLACK_BOT_TOKEN": return ["slack"];
    case "JARVIS_DISCORD_BOT_TOKEN": return ["discord"];
    case "JARVIS_WHATSAPP_TOKEN": return ["whatsapp"];
    case "JARVIS_TWILIO_AUTH_TOKEN": return ["twilio"];
    case "JARVIS_TELNYX_API_KEY": return ["telnyx"];
    case "JARVIS_TEAMS_REFRESH_TOKEN": return ["microsoft_outlook"];
    default: return [];
  }
}

export type AdapterMap = Partial<Record<CommsProvider, ChannelAdapter>>;

export function channelOfProvider(provider: CommsProvider): CommsChannel[] {
  switch (provider) {
    case "slack": return ["slack"];
    case "discord": return ["discord"];
    case "meta_whatsapp": return ["whatsapp"];
    case "twilio":
    case "telnyx": return ["sms", "phone"];
    case "ms_graph": return ["teams"];
    case "meta_messenger": return ["messenger"];
    case "meta_instagram": return ["instagram"];
    default: return [];
  }
}

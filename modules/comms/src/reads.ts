import { encodePathSegment } from "@jarvis/tool-gateway";
import { ProviderRejectedError, providerCall } from "./adapters.ts";
import { sanitizeInboundText } from "./webhooks/ingest.ts";

/**
 * WP-G1 (D-463, P1c): leverandør-LESING (`JARVIS_COMMS_VENDOR_READS=on`, krever `JARVIS_COMMS_OUTBOUND=on` for kontoene). Rene lesinger (klasse A, eier-kun, aldri en modellflate): Slack-tråd og brukerliste, Discord-melding,
 * WhatsApp-maler og Twilio-melding (leveringsstatus). Alt innhold fra leverandøren er UBETRODD DATA: tekst renses (kontrolltegn/usynlige tegn fjernes, hemmeligheter redigeres, maks 2000 tegn) og resultatet merkes `untrusted`;
 * personlige felt minimeres (Slack-brukere: id/handle/bot-flagg - aldri navn/e-post/telefon). Ingen skriving, ingen redirect, 1 MB-grense (`providerCall`). Telnyx-lesing er DEFERRED (ikke verifisert i denne økten).
 *
 * Verifisering mot leverandørdokumentasjon (søk 2026-11): Slack `conversations.replies`/`users.list`; Discord `GET /channels/{id}/messages/{id}` (READ_MESSAGE_HISTORY); Meta `GET /{waba-id}/message_templates`; Twilio
 * `GET /Accounts/{sid}/Messages/{sid}.json`. Eksakte scopes/tillatelser og feltnavn er UVERIFISERT utover metodenavnene - hver rad står i runbook D-41-tabellen med status.
 */
export interface ReadMessage {
  readonly id: string;
  readonly author: string | null;
  readonly text: string | null;
  readonly ts: string | null;
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const safeId = (value: unknown): string | null => (typeof value === "string" && SAFE_ID.test(value) ? value : null);
const asRecord = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

function reject(provider: string, res: { status: number; json: Record<string, unknown> | null }, errorKey: string): never {
  const raw = res.json?.[errorKey];
  const code = typeof raw === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(raw) ? raw.toLowerCase() : `http_${res.status}`;
  throw new ProviderRejectedError(provider, code);
}

export class VendorReads {
  constructor(private readonly deps: { graphVersion: string; accountSid: () => Promise<string | null> }) {}

  /** Slack `conversations.replies`: meldingene i en tråd (maks `limit`). */
  async slackThread(token: string, channelId: string, threadTs: string, limit: number): Promise<ReadMessage[]> {
    const res = await providerCall("slack", "https://slack.com/api/conversations.replies", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ channel: channelId, ts: threadTs, limit })
    }, false);
    if (res.json?.["ok"] !== true) return reject("slack", res, "error");
    const messages = Array.isArray(res.json["messages"]) ? (res.json["messages"] as unknown[]) : [];
    return messages.slice(0, limit).flatMap((m) => {
      const r = asRecord(m);
      const id = safeId(r?.["ts"]);
      return r === null || id === null ? [] : [{ id, author: safeId(r["user"]) ?? safeId(r["bot_id"]), text: sanitizeInboundText(typeof r["text"] === "string" ? r["text"] : null), ts: id }];
    });
  }

  /** Slack `users.list`: KUN id, handle, bot-flagg og slettet-flagg (aldri navn, e-post eller telefon). */
  async slackUsers(token: string, limit: number, cursor: string | undefined): Promise<{ users: Array<{ id: string; handle: string | null; is_bot: boolean; deleted: boolean }>; next_cursor: string | null }> {
    const res = await providerCall("slack", "https://slack.com/api/users.list", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ limit, ...(cursor !== undefined ? { cursor } : {}) })
    }, false);
    if (res.json?.["ok"] !== true) return reject("slack", res, "error");
    const members = Array.isArray(res.json["members"]) ? (res.json["members"] as unknown[]) : [];
    const users = members.slice(0, limit).flatMap((m) => {
      const r = asRecord(m);
      const id = safeId(r?.["id"]);
      return r === null || id === null ? [] : [{ id, handle: safeId(r["name"]), is_bot: r["is_bot"] === true, deleted: r["deleted"] === true }];
    });
    const next = asRecord(res.json["response_metadata"])?.["next_cursor"];
    return { users, next_cursor: typeof next === "string" && next.length > 0 && next.length <= 300 ? next : null };
  }

  /** Discord `GET /channels/{channel}/messages/{message}`. `null` = finnes ikke (404). */
  async discordMessage(token: string, channelId: string, messageId: string): Promise<ReadMessage | null> {
    const res = await providerCall("discord", `https://discord.com/api/v10/channels/${encodePathSegment(channelId, "channel")}/messages/${encodePathSegment(messageId, "message")}`, { headers: { authorization: `Bot ${token}` } }, false);
    if (res.status === 404) return null;
    if (res.status >= 400) return reject("discord", res, "code");
    const id = safeId(res.json?.["id"]);
    if (res.json === null || id === null) throw new Error("comms_discord_unreadable_message");
    return { id, author: safeId(asRecord(res.json["author"])?.["id"]), text: sanitizeInboundText(typeof res.json["content"] === "string" ? res.json["content"] : null), ts: typeof res.json["timestamp"] === "string" ? res.json["timestamp"].slice(0, 40) : null };
  }

  /** WhatsApp `GET /{waba-id}/message_templates`: navn, språk, status og kategori (aldri malinnholdet). */
  async whatsappTemplates(token: string, wabaId: string, limit: number): Promise<Array<{ name: string; language: string; status: string; category: string | null }>> {
    const url = `https://graph.facebook.com/${this.deps.graphVersion}/${encodePathSegment(wabaId, "waba_id")}/message_templates?fields=name,language,status,category&limit=${limit}`;
    const res = await providerCall("whatsapp", url, { headers: { authorization: `Bearer ${token}` } }, false);
    if (res.status >= 400) return reject("whatsapp", res, "error");
    const data = Array.isArray(res.json?.["data"]) ? (res.json?.["data"] as unknown[]) : [];
    return data.slice(0, limit).flatMap((t) => {
      const r = asRecord(t);
      const name = typeof r?.["name"] === "string" && /^[a-z0-9_]{1,512}$/.test(r["name"]) ? r["name"] : null;
      const language = safeId(r?.["language"]);
      const status = safeId(r?.["status"]);
      return r === null || name === null || language === null || status === null ? [] : [{ name, language, status, category: safeId(r["category"]) }];
    });
  }

  /** Twilio `GET /Accounts/{sid}/Messages/{sid}.json`: leveringsstatus + retning + feilkode (+ renset tekst). */
  async twilioMessage(authToken: string, messageSid: string): Promise<{ sid: string; status: string | null; direction: string | null; error_code: string | null; date_sent: string | null; body: string | null }> {
    const accountSid = await this.deps.accountSid();
    if (!accountSid || !/^[A-Za-z0-9]{10,64}$/.test(accountSid)) throw new Error("comms_twilio_account_sid_not_configured");
    const res = await providerCall("twilio", `https://api.twilio.com/2010-04-01/Accounts/${encodePathSegment(accountSid, "account_sid")}/Messages/${encodePathSegment(messageSid, "message_sid")}.json`, {
      headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}` }
    }, false);
    if (res.status >= 400) return reject("twilio", res, "code");
    const sid = safeId(res.json?.["sid"]);
    if (res.json === null || sid === null) throw new Error("comms_twilio_unreadable_message");
    const code = res.json["error_code"];
    return {
      sid, status: safeId(res.json["status"]), direction: safeId(res.json["direction"]), error_code: typeof code === "number" || typeof code === "string" ? safeId(String(code)) : null,
      date_sent: typeof res.json["date_sent"] === "string" ? res.json["date_sent"].slice(0, 40) : null, body: sanitizeInboundText(typeof res.json["body"] === "string" ? res.json["body"] : null)
    };
  }
}

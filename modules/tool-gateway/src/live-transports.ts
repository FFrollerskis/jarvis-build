import type { JsonValue } from "@jarvis/contracts";
import type { ToolTransport } from "./gateway.ts";

/**
 * PRODUKSJONSTRANSPORTER (BO-03). Live-verifisering krever credentials i .env
 * (BLOCKED_EXTERNAL til de finnes) - koden er komplett og typesjekket.
 * Credential-argumentet kommer fra SecretProvider via Tool Gateway; for Google
 * er det en OAuth REFRESH TOKEN (kortlivet access-token hentes her og logges
 * aldri). Konto-/tenant-oppløsning: hver transport-instans er bundet til én
 * eksplisitt konto (accountEmail) - ingen implisitt cross-account fallback.
 */
async function googleAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env["JARVIS_GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["JARVIS_GOOGLE_CLIENT_SECRET"];
  if (!clientId || !clientSecret) throw new Error("google_oauth_client_not_configured");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken })
  });
  if (!response.ok) throw new Error(`google_auth_failed_${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

export class GmailTransport implements ToolTransport {
  constructor(readonly accountEmail: string = process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com") {}
  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    if (action !== "read_inbox") throw new Error(`gmail_unsupported_action_${action}`);
    const token = await googleAccessToken(credential);
    const auth = { authorization: `Bearer ${token}` };
    const max = Number(parameters["max"] ?? 15);
    const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=newer_than:2d`, { headers: auth });
    if (!list.ok) throw new Error(`gmail_error_${list.status}`);
    const ids = (((await list.json()) as { messages?: Array<{ id: string }> }).messages ?? []).slice(0, max);
    const messages: JsonValue[] = [];
    for (const { id } of ids) {
      const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: auth });
      if (!m.ok) continue;
      const msg = (await m.json()) as { id: string; threadId: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: Array<{ name: string; value: string }> } };
      const h = (name: string) => msg.payload?.headers?.find((x) => x.name === name)?.value ?? "";
      messages.push({
        id: msg.id, thread: msg.threadId, from: h("From"), subject: h("Subject"),
        at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : h("Date"),
        unanswered: String(msg.labelIds?.includes("UNREAD") ?? false),
        important: String(msg.labelIds?.includes("IMPORTANT") ?? false),
        account: this.accountEmail
      });
    }
    return { data: { messages } };
  }
}

export class GoogleCalendarTransport implements ToolTransport {
  constructor(readonly accountEmail: string = process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com") {}
  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    if (action !== "read_events") throw new Error(`calendar_unsupported_action_${action}`);
    const token = await googleAccessToken(credential);
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(String(parameters["from"]))}&timeMax=${encodeURIComponent(String(parameters["to"]))}&maxResults=25`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`calendar_error_${response.status}`);
    const body = (await response.json()) as { items?: Array<{ id: string; summary?: string; description?: string; location?: string; hangoutLink?: string; attendees?: unknown[]; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string } }> };
    const events: JsonValue[] = (body.items ?? []).map((e) => ({
      id: e.id, title: e.summary ?? "(uten tittel)",
      start: e.start?.dateTime ?? e.start?.date ?? "", end: e.end?.dateTime ?? "",
      location: e.location ?? e.hangoutLink ?? "",
      attendees: String((e.attendees ?? []).length),
      needs_prep: String(Boolean(e.description && e.description.length > 40)),
      account: this.accountEmail
    }));
    return { data: { events } };
  }
}

/**
 * UA-2 P1A §18/§24: Google Drive - READ ONLY (ingen write/delete/trash-
 * handling er implementert her i det hele tatt). Samme kontomønster som
 * Gmail/Calendar (én eksplisitt konto, ingen implisitt cross-account
 * fallback), samme `googleAccessToken()` OAuth-vei (ingen ny credential-type).
 *
 * To handlinger:
 * - `list_files`: én SIDE av en listing (§`folder_id` styrer scope - satt av
 *   `GoogleDriveKnowledgeSource` ut fra dens konfigurerte scope, ALDRI en
 *   default her; paginering er `page_token` inn/ut, aggregering skjer i
 *   kilden). `trashed=false` er alltid med i spørringen - en slettet/
 *   papirkurv-fil forsvinner dermed naturlig fra neste vellykkede listing,
 *   som er nøyaktig mekanismen `KnowledgeSyncService` bruker for tombstoning.
 * - `read_document`: eksporterer Google Docs til text/plain (den ENESTE
 *   Google-native filtypen P1A eksporterer - IKKE Sheets/Slides/Forms, se
 *   §14 "Bygges IKKE"), eller leser rå innhold for tekstlige MIME-typer.
 *   Alt annet (bilder, PDF, binærformater, andre Google-native typer) kaster
 *   en typet `drive_unsupported_content_<mime>`-feil - ALDRI lest som
 *   søppel-tekst, ALDRI stille utelatt (kilden mapper dette til et
 *   `SkippedRecord`, ikke en feilet listing).
 */
const GOOGLE_DOC_EXPORT_MIME = "application/vnd.google-apps.document";
const GOOGLE_NATIVE_MIME_PREFIX = "application/vnd.google-apps.";
const DRIVE_SUPPORTED_RAW_MIME = new Set([
  "text/plain", "text/markdown", "text/x-markdown", "text/csv",
  "application/json", "text/html", "text/css", "application/x-yaml", "text/yaml"
]);

function isDriveSupportedRawMime(mimeType: string): boolean {
  return DRIVE_SUPPORTED_RAW_MIME.has(mimeType) || mimeType.startsWith("text/");
}

export class GoogleDriveTransport implements ToolTransport {
  constructor(readonly accountEmail: string = process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com") {}

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    const token = await googleAccessToken(credential);
    const auth = { authorization: `Bearer ${token}` };

    if (action === "list_files") {
      const folderId = parameters["folder_id"] ? String(parameters["folder_id"]) : undefined;
      const pageToken = parameters["page_token"] ? String(parameters["page_token"]) : undefined;
      const q = folderId ? `'${folderId}' in parents and trashed=false` : "trashed=false";
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set("q", q);
      url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime,size)");
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("spaces", "drive");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await fetch(url, { headers: auth });
      if (response.status === 401 || response.status === 403) throw new Error(`drive_auth_error_${response.status}`);
      if (response.status === 429) throw new Error("drive_rate_limited");
      if (!response.ok) throw new Error(`drive_list_error_${response.status}`);
      const body = (await response.json()) as {
        nextPageToken?: string;
        files?: Array<{ id: string; name: string; mimeType: string; modifiedTime?: string; size?: string }>;
      };
      return {
        data: {
          files: (body.files ?? []).map((f) => ({
            id: f.id, name: f.name, mime_type: f.mimeType,
            modified_at: f.modifiedTime ?? null, size_bytes: f.size ?? null
          })),
          next_page_token: body.nextPageToken ?? null
        }
      };
    }

    if (action === "read_document") {
      const documentId = String(parameters["document_id"]);
      const mimeType = String(parameters["mime_type"] ?? "");
      if (mimeType === GOOGLE_DOC_EXPORT_MIME) {
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${documentId}/export?mimeType=text%2Fplain`,
          { headers: auth }
        );
        if (response.status === 404) throw new Error(`drive_not_found_${documentId}`);
        if (response.status === 401 || response.status === 403) throw new Error(`drive_auth_error_${response.status}`);
        if (response.status === 429) throw new Error("drive_rate_limited");
        if (!response.ok) throw new Error(`drive_export_error_${response.status}`);
        return { data: { content: await response.text(), content_type: "text/plain" } };
      }
      if (mimeType.startsWith(GOOGLE_NATIVE_MIME_PREFIX) || !isDriveSupportedRawMime(mimeType)) {
        // Sheets/Slides/Forms/binærformater/bilder/PDF - eksplisitt utenfor P1A-scope (§14).
        throw new Error(`drive_unsupported_content_${mimeType || "unknown"}`);
      }
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${documentId}?alt=media`, { headers: auth });
      if (response.status === 404) throw new Error(`drive_not_found_${documentId}`);
      if (response.status === 401 || response.status === 403) throw new Error(`drive_auth_error_${response.status}`);
      if (response.status === 429) throw new Error("drive_rate_limited");
      if (!response.ok) throw new Error(`drive_read_error_${response.status}`);
      return { data: { content: await response.text(), content_type: mimeType } };
    }

    throw new Error(`drive_unsupported_action_${action}`);
  }
}

export class TelegramTransport implements ToolTransport {
  constructor(private readonly chatId: string | undefined = process.env["JARVIS_TELEGRAM_CHAT_ID"]) {}
  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    if (action !== "notify") throw new Error(`telegram_unsupported_action_${action}`);
    if (!this.chatId) throw new Error("telegram_chat_id_not_configured");
    const response = await fetch(`https://api.telegram.org/bot${credential}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: String(parameters["message"]) })
    });
    if (!response.ok) throw new Error(`telegram_error_${response.status}`);
    const body = (await response.json()) as { result?: { message_id?: number } };
    return { external_id: String(body.result?.message_id ?? "sent") };
  }
}

export class GithubTransport implements ToolTransport {
  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    const auth = { authorization: `Bearer ${credential}`, accept: "application/vnd.github+json", "user-agent": "jarvis" };
    if (action === "read_issues") {
      const response = await fetch(`https://api.github.com/repos/${String(parameters["repo"])}/issues?state=open&per_page=20`, { headers: auth });
      if (!response.ok) throw new Error(`github_error_${response.status}`);
      const items = (await response.json()) as Array<{ number: number; title: string; updated_at: string; pull_request?: unknown }>;
      return { data: { issues: items.map((i) => ({ id: String(i.number), title: i.title, at: i.updated_at, is_pr: String(Boolean(i.pull_request)), ci_failing: "false" })) } };
    }
    // UA-2 P0 §3: repo-metadata for kunnskaps-ingestion - samme PAT/scope som
    // read_issues (ingen ny credential-type), ett ekstra read-only GET-kall.
    if (action === "read_repo_meta") {
      const response = await fetch(`https://api.github.com/repos/${String(parameters["repo"])}`, { headers: auth });
      if (!response.ok) throw new Error(`github_error_${response.status}`);
      const repo = (await response.json()) as { full_name: string; description: string | null; updated_at: string; default_branch: string };
      return {
        data: {
          full_name: repo.full_name,
          description: repo.description ?? "",
          updated_at: repo.updated_at,
          default_branch: repo.default_branch
        }
      };
    }
    throw new Error(`github_unsupported_action_${action}`);
  }
}

/**
 * Telegram-kommandopolling: /brief og /status via getUpdates (long-poll).
 * Svar leveres via Tool Gateway (policy/audit) - aldri direkte fetch tilbake.
 */
export class TelegramCommandPoller {
  private offset = 0;
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly token: string,
    private readonly ownerChatId: string,
    private readonly handlers: { brief(): Promise<string>; status(): Promise<string>; ai?(): Promise<string> },
    private readonly send: (text: string) => Promise<void>
  ) {}

  start(intervalMs = 4000): void {
    this.timer = setInterval(() => void this.poll().catch(() => undefined), intervalMs);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=0`);
    if (!response.ok) return;
    const body = (await response.json()) as { result?: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }> };
    for (const update of body.result ?? []) {
      this.offset = update.update_id + 1;
      const chat = String(update.message?.chat.id ?? "");
      if (chat !== this.ownerChatId) continue; // kun owner - ingen fremmede kommandoer
      const text = update.message?.text ?? "";
      if (text.startsWith("/brief")) await this.send(await this.handlers.brief());
      else if (text.startsWith("/status")) await this.send(await this.handlers.status());
      else if (text.startsWith("/ai") && this.handlers.ai) await this.send(await this.handlers.ai());
    }
  }
}

import type { JsonValue } from "@jarvis/contracts";
import type { ToolInvocationContext, ToolTransport } from "./gateway.ts";
import { GithubRateLimitedError, GithubRateLimitController } from "./github-rate-limit-controller.ts";

/**
 * UA-2 P1B-A HOST FIX #1 (2026-08-16, host-funn run_id `3af67dab`): den
 * TIDLIGERE `googleAccessToken()` samlet ALLE token-endepunkt-feil til
 * `google_auth_failed_<status>` - selve Google-feilkroppen (`error`/
 * `error_description`, RFC 6749 §5.2 sitt FLATE skjema - IKKE den nøstede
 * `{error:{code,message,status,...}}`-formen `classifyDriveProbeError()`
 * under klassifiserer, som er en ANNEN Google-API-feilform) ble ALDRI lest.
 * Host-kjøringen fikk derfor kun `tool_failed:google_auth_failed_401` - IKKE
 * nok til å avgjøre om `JARVIS_EMAIL_TOKEN` var utstedt til en ANNEN
 * OAuth-klient (§3 i host-fix-ordren), tilbakekalt, eller noe helt annet.
 * `classifyGoogleTokenEndpointError()` er BEVISST tekst-basert-beste-innsats
 * på `error_description` (samme presedens som `classifyDriveProbeError()`
 * sin `WORKSPACE_ADMIN_POLICY`-gren) - Google gir INGEN mer presist
 * maskinlesbart signal for "token utstedt til en annen klient" enn en
 * `invalid_grant`-feilbeskrivelse som nevner det eksplisitt.
 *
 * UA-2 P1B-A HOST FIX #2 (2026-08-16, host-funn run_id `ab43fb1f`): et ekte
 * host-funn viste `invalid_client`/`unauthorized_client` (HTTP 401) mot den
 * ALLEREDE host-bevist FUNGERENDE Desktop-OAuth-klienten (samme klient som
 * bevist av Drive/D-42) - den forrige, blindt-ikke-gjenopprettbare
 * `GOOGLE_INVALID_CLIENT`-klassifiseringen stoppet derfor auto-reauth-forsøket
 * feilaktig. Vi kan IKKE kryptografisk bevise fra selve refresh-tokenet HVILKEN
 * gammel klient som opprinnelig utstedte det (§2 i ordren - IKKE påstå at
 * Google eksponerer det) - men NÅR den GJELDENDE Desktop-klienten allerede er
 * host-bevist (`JARVIS_GOOGLE_OAUTH_CLIENT_TYPE=desktop`, persistert KUN etter
 * en tidligere `google-drive-reauth.ts`-suksess) og BEGGE client_id/_secret
 * faktisk er satt (ellers kastes `google_oauth_client_not_configured` FØR
 * dette punktet i det hele tatt), er en `invalid_client`/`unauthorized_client`
 * på DENNE ene credential-en (`JARVIS_EMAIL_TOKEN`) mest sannsynlig en
 * gjenstående gammel Gmail-tildeling fra FØR Desktop-klient-migreringen - IKKE
 * et bevis på at selve klienten er ødelagt/uprøvd. `EMAIL_REAUTH_REQUIRED`
 * skiller EKSPLISITT dette "kontekst-bevist trygt å reautorisere"-tilfellet
 * fra det generelle `GOOGLE_INVALID_CLIENT` (manglende secret, ikke-Desktop/
 * uprøvd klient, feilkonfigurert klient) - som FORTSATT fail-closed stopper
 * uten automatisk reauth-forsøk (§3 i ordren: "Do not globally make every
 * invalid_client error recoverable").
 */
export type GoogleAuthErrorClass =
  | "EMAIL_TOKEN_CLIENT_MISMATCH"
  | "EMAIL_REFRESH_TOKEN_REVOKED"
  | "EMAIL_INSUFFICIENT_SCOPE"
  | "GOOGLE_INVALID_GRANT"
  | "GOOGLE_INVALID_CLIENT"
  | "EMAIL_REAUTH_REQUIRED"
  | "UNKNOWN_GOOGLE_AUTH";

/** HOST FIX #2: KUN satt (til `"LEGACY_TOKEN_OR_CLIENT_BINDING"`) når `errorClass === "EMAIL_REAUTH_REQUIRED"` - en trygg, menneskelesbar/grep-bar begrunnelse, ALDRI en påstand om at Google faktisk eksponerte den gamle klient-IDen. */
export type GoogleAuthRecoveryReason = "LEGACY_TOKEN_OR_CLIENT_BINDING";

export interface GoogleAuthErrorDetails {
  httpStatus: number;
  /** Google sin RFC 6749 §5.2 `error`-kode, f.eks. "invalid_grant" - `undefined` hvis kroppen ikke var gyldig JSON eller manglet feltet. */
  googleError: string | undefined;
  /** Google sin `error_description` - ALDRI en secret (Google ekko-er aldri tilbake selve tokenet/client_secret i en feilrespons), men avkortet (300 tegn) som et ekstra sikkerhetsnett. */
  googleErrorDescription: string | undefined;
  errorClass: GoogleAuthErrorClass;
  /** HOST FIX #2: kun til stede for `EMAIL_REAUTH_REQUIRED` - se `GoogleAuthRecoveryReason`. */
  recoveryReason: GoogleAuthRecoveryReason | undefined;
}

interface TokenEndpointErrorBody {
  error?: string;
  error_description?: string;
}

/** HOST FIX #2: konteksten `classifyGoogleTokenEndpointError()` trenger for å skille et kontekst-bevist gjenopprettbart `invalid_client` (gjenbrukt, allerede host-bevist Desktop-klient) fra et FORTSATT fail-closed `invalid_client` (uprøvd/ikke-Desktop/feilkonfigurert klient). */
export interface GoogleAuthClientContext {
  /** `true` KUN når `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE === "desktop"` - persistert AV `google-drive-reauth.ts` KUN etter en fullstendig host-bevist Desktop-OAuth-suksess (se D-42). ALDRI antatt sann uten denne eksplisitte markøren. */
  provenDesktopClient: boolean;
}

/**
 * KUN for selve TOKEN-ENDEPUNKTET (`https://oauth2.googleapis.com/token`) -
 * IKKE for et Google API-kall som allerede har et access-token (se
 * `classifyDriveProbeError()` for DEN, nøstede feilformen). ALDRI kaster -
 * en ikke-JSON eller uventet kropp gir fortsatt en trygg (UNKNOWN_GOOGLE_AUTH)
 * klassifisering fremfor å knekke selve feilrapporteringen.
 */
export function classifyGoogleTokenEndpointError(httpStatus: number, rawBody: string, context: GoogleAuthClientContext): GoogleAuthErrorDetails {
  let parsed: TokenEndpointErrorBody = {};
  try {
    parsed = JSON.parse(rawBody) as TokenEndpointErrorBody;
  } catch {
    // Ikke-JSON-kropp (sjeldent for Google sitt token-endepunkt) - fortsett med tomt objekt.
  }
  const googleError = parsed.error;
  const googleErrorDescription = parsed.error_description?.slice(0, 300);
  const desc = googleErrorDescription ?? "";

  let errorClass: GoogleAuthErrorClass;
  let recoveryReason: GoogleAuthRecoveryReason | undefined;
  if (googleError === "invalid_grant") {
    if (/not match|different client|another client|client.?id/i.test(desc)) {
      errorClass = "EMAIL_TOKEN_CLIENT_MISMATCH";
    } else if (/expired|revoked/i.test(desc)) {
      errorClass = "EMAIL_REFRESH_TOKEN_REVOKED";
    } else {
      errorClass = "GOOGLE_INVALID_GRANT";
    }
  } else if (googleError === "invalid_client" || googleError === "unauthorized_client") {
    // HOST FIX #2 §3: KUN gjenopprettbar når den GJELDENDE klienten selv
    // allerede er host-bevist (Desktop-type) - ALDRI globalt for enhver
    // invalid_client (manglende secret/uprøvd/feilkonfigurert klient forblir
    // GOOGLE_INVALID_CLIENT, fail-closed, under).
    if (context.provenDesktopClient) {
      errorClass = "EMAIL_REAUTH_REQUIRED";
      recoveryReason = "LEGACY_TOKEN_OR_CLIENT_BINDING";
    } else {
      errorClass = "GOOGLE_INVALID_CLIENT";
    }
  } else if (googleError === "insufficient_scope" || /insufficient/i.test(desc)) {
    errorClass = "EMAIL_INSUFFICIENT_SCOPE";
  } else {
    errorClass = "UNKNOWN_GOOGLE_AUTH";
  }
  return { httpStatus, googleError, googleErrorDescription, errorClass, recoveryReason };
}

/** Trygg, grep-bar én-linjes diagnosetekst - ALDRI token/secret, kun de klassifiserte, ikke-sensitive feltene (samme presedens som `formatDriveProbeReport()`). */
export function formatGoogleAuthErrorReport(details: GoogleAuthErrorDetails): string {
  const reason = details.recoveryReason ? ` recovery_reason=${details.recoveryReason}` : "";
  return `google_auth_error_class=${details.errorClass} http_status=${details.httpStatus} google_error=${details.googleError ?? "unknown"}${reason}`;
}

/** Klassene som er trygge å AUTOMATISK forsøke reautorisert via `google-email-reauth.ts` - de resterende (GOOGLE_INVALID_CLIENT/UNKNOWN_GOOGLE_AUTH) krever manuell undersøkelse, ALDRI en gjentatt automatisk reauth-løkke mot en sannsynligvis feil grunnleggende årsak. HOST FIX #2: `EMAIL_REAUTH_REQUIRED` er BEVIST kontekst-trygg av `classifyGoogleTokenEndpointError()` selv (kun satt når `provenDesktopClient` var sann) - INGEN ekstra kontekst trengs her, unngår en duplisert/divergerende sjekk. */
export function isRecoverableGoogleAuthErrorClass(errorClass: GoogleAuthErrorClass): boolean {
  return errorClass === "EMAIL_TOKEN_CLIENT_MISMATCH" || errorClass === "EMAIL_REFRESH_TOKEN_REVOKED" ||
    errorClass === "GOOGLE_INVALID_GRANT" || errorClass === "EMAIL_INSUFFICIENT_SCOPE" || errorClass === "EMAIL_REAUTH_REQUIRED";
}

const GOOGLE_AUTH_FAILED_MESSAGE_PATTERN = /google_auth_failed_(\d+):(\w+)(?::(.+))?$/;

/**
 * Parser den klassifiserte meldingen `googleAccessToken()` kaster tilbake ut
 * av en `ToolResult` sin `reason`-streng (`tool_failed:google_auth_failed_
 * <status>:<class>[:<google_error>]` - se `ToolGateway.execute()` sin
 * "tool_failed:<message>"-innpakning). `undefined` for ALT annet (en
 * uklassifisert/annen type feil) - kalleren skal ALDRI anta Google-auth uten
 * dette mønsteret faktisk til stede.
 */
export function parseGoogleAuthFailureReason(reason: string): GoogleAuthErrorClass | undefined {
  const match = GOOGLE_AUTH_FAILED_MESSAGE_PATTERN.exec(reason);
  const errorClass = match?.[2];
  if (!errorClass) return undefined;
  const known: readonly GoogleAuthErrorClass[] = [
    "EMAIL_TOKEN_CLIENT_MISMATCH", "EMAIL_REFRESH_TOKEN_REVOKED", "EMAIL_INSUFFICIENT_SCOPE",
    "GOOGLE_INVALID_GRANT", "GOOGLE_INVALID_CLIENT", "EMAIL_REAUTH_REQUIRED", "UNKNOWN_GOOGLE_AUTH"
  ];
  return (known as readonly string[]).includes(errorClass) ? (errorClass as GoogleAuthErrorClass) : undefined;
}

/**
 * PRODUKSJONSTRANSPORTER (BO-03). Live-verifisering krever credentials i .env
 * (BLOCKED_EXTERNAL til de finnes) - koden er komplett og typesjekket.
 * Credential-argumentet kommer fra SecretProvider via Tool Gateway; for Google
 * er det en OAuth REFRESH TOKEN (kortlivet access-token hentes her og logges
 * aldri). Konto-/tenant-oppløsning: hver transport-instans er bundet til én
 * eksplisitt konto (accountEmail) - ingen implisitt cross-account fallback.
 */
export async function googleAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env["JARVIS_GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["JARVIS_GOOGLE_CLIENT_SECRET"];
  if (!clientId || !clientSecret) throw new Error("google_oauth_client_not_configured");
  // HOST FIX #2: KUN LEST (aldri skrevet/eksponert) for å avgjøre om DENNE
  // klienten allerede er host-bevist Desktop-type - samme markør
  // `google-drive-reauth.ts` persisterer, brukt her UTELUKKENDE til
  // `classifyGoogleTokenEndpointError()` sin kontekst-bevisste
  // EMAIL_REAUTH_REQUIRED-gren (se dens toppkommentar).
  const provenDesktopClient = process.env["JARVIS_GOOGLE_OAUTH_CLIENT_TYPE"] === "desktop";
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken })
  });
  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    const details = classifyGoogleTokenEndpointError(response.status, rawBody, { provenDesktopClient });
    throw new Error(`google_auth_failed_${response.status}:${details.errorClass}${details.googleError ? `:${details.googleError}` : ""}`);
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

/** Gmail sin `attachmentId`/vedleggs-metadata, funnet ved å gå gjennom MIME-treet (`payload.parts`, kan være nøstet). */
interface GmailAttachmentPart {
  attachment_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

interface GmailMimePart {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: unknown[];
}

/** Rekursivt - Gmail sitt MIME-tre kan nøste `parts` (f.eks. multipart/mixed → multipart/alternative → vedlegg). */
function collectAttachmentParts(part: GmailMimePart | undefined): GmailAttachmentPart[] {
  if (!part) return [];
  const found: GmailAttachmentPart[] = [];
  if (part.filename && part.body?.attachmentId) {
    found.push({
      attachment_id: part.body.attachmentId, filename: part.filename,
      mime_type: part.mimeType ?? "application/octet-stream", size_bytes: part.body.size ?? 0
    });
  }
  for (const child of part.parts ?? []) {
    found.push(...collectAttachmentParts(child as GmailMimePart));
  }
  return found;
}

/**
 * Rekursivt - finner FØRSTE `text/plain`-del uten `attachmentId` (skiller
 * body-tekst fra en `.txt`-VEDLEGG, som skal gå gjennom `attachments`, ikke
 * `body_text`). Samme MIME-tre-nøsting som `collectAttachmentParts()`.
 */
function findBodyTextPart(part: GmailMimePart | undefined): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === "text/plain" && part.body?.data && !part.body.attachmentId) {
    return part.body.data;
  }
  for (const child of part.parts ?? []) {
    const found = findBodyTextPart(child as GmailMimePart);
    if (found) return found;
  }
  return undefined;
}

/** Gmail returnerer vedleggsdata som URL-safe base64 (RFC 4648 §5) - konverter til standard base64 FØR det når resten av Jarvis (data-URIer, Model Gateway vision-innhold forventer standard base64). */
function base64UrlToStandard(data: string): string {
  const standard = data.replace(/-/g, "+").replace(/_/g, "/");
  const padding = standard.length % 4 === 0 ? "" : "=".repeat(4 - (standard.length % 4));
  return standard + padding;
}

export class GmailTransport implements ToolTransport {
  constructor(readonly accountEmail: string = process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com") {}
  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    const token = await googleAccessToken(credential);
    const auth = { authorization: `Bearer ${token}` };
    switch (action) {
      case "read_inbox":
        return this.readInbox(parameters, auth);
      case "list_messages":
        return this.listMessages(parameters, auth);
      case "read_attachment":
        return this.readAttachment(parameters, auth);
      default:
        throw new Error(`gmail_unsupported_action_${action}`);
    }
  }

  private async readInbox(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
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

  /**
   * UA-2 P1B-A §2: FULL meldingslisting (i motsetning til `read_inbox` sin
   * `format=metadata` - kun headere) - henter `format=full` PER melding for å
   * finne MIME-vedleggsdelene (`attachmentId`/filnavn/mime/størrelse), i
   * tillegg til body-tekst (`text/plain`-delen, når tilstede). Paginering
   * skjer INNENFOR denne ene handlingen (samme mønster som Drive sin
   * `list_files` → `KnowledgeSource.list()`-aggregering) - kalleren (
   * `EmailAttachmentKnowledgeSource`) MÅ selv styre `max`/tidsvindu, ingen
   * ubegrenset full-postkasse-skann her.
   */
  private async listMessages(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const max = Number(parameters["max"] ?? 15);
    const query = parameters["query"] ? String(parameters["query"]) : "newer_than:14d";
    const list = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(query)}`,
      { headers: auth }
    );
    if (!list.ok) throw new Error(`gmail_error_${list.status}`);
    const ids = (((await list.json()) as { messages?: Array<{ id: string }> }).messages ?? []).slice(0, max);
    const messages: JsonValue[] = [];
    for (const { id } of ids) {
      const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: auth });
      if (!m.ok) continue;
      const msg = (await m.json()) as {
        id: string; threadId: string; internalDate?: string;
        payload?: {
          headers?: Array<{ name: string; value: string }>;
          mimeType?: string; body?: { data?: string };
          parts?: Array<{ mimeType?: string; body?: { data?: string; attachmentId?: string; size?: number }; filename?: string; parts?: unknown[] }>;
        };
      };
      const h = (name: string) => msg.payload?.headers?.find((x) => x.name === name)?.value ?? "";
      const bodyData = findBodyTextPart(msg.payload as GmailMimePart | undefined);
      const bodyText = bodyData ? Buffer.from(base64UrlToStandard(bodyData), "base64").toString("utf8") : "";
      const attachments = collectAttachmentParts(msg.payload as GmailMimePart | undefined);
      messages.push({
        id: msg.id, thread: msg.threadId, from: h("From"), to: h("To"), cc: h("Cc"), subject: h("Subject"),
        at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : h("Date"),
        body_text: bodyText,
        attachments: attachments as unknown as JsonValue,
        account: this.accountEmail
      });
    }
    return { data: { messages } };
  }

  /** UA-2 P1B-A §2: last ned RÅ vedleggsbytes (standard base64) for ETT vedlegg - aldri hele meldingen på nytt. */
  private async readAttachment(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const messageId = String(parameters["message_id"]);
    const attachmentId = String(parameters["attachment_id"]);
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
      { headers: auth }
    );
    if (response.status === 404) throw new Error(`gmail_attachment_not_found_${attachmentId}`);
    if (!response.ok) throw new Error(`gmail_error_${response.status}`);
    const body = (await response.json()) as { size?: number; data?: string };
    return {
      data: {
        content_base64: body.data ? base64UrlToStandard(body.data) : "",
        size_bytes: body.size ?? 0
      }
    };
  }
}

export class GoogleCalendarTransport implements ToolTransport {
  constructor(readonly accountEmail: string = process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com") {}
  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    switch (action) {
      case "read_events":
        return this.readEvents(parameters, credential);
      case "list_events":
        return this.listEvents(parameters, credential);
      default:
        throw new Error(`calendar_unsupported_action_${action}`);
    }
  }

  private async readEvents(parameters: Record<string, JsonValue>, credential: string) {
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

  /**
   * UA-3 business-event-linkage: struktur-fokusert listing (i motsetning til
   * `read_events` sin persondagsbrief-egnede form - kun antall deltakere) -
   * eksponerer FAKTISKE deltaker-e-poster + en stabil `html_link` (Google sin
   * egen kalenderlenke) slik at Business OS kan gjøre deterministisk kontakt-
   * gjenkjenning (§9 i byggeordren) og peke tidslinjen til KILDEN, aldri en
   * kopi. Bevisst INGEN `description` her (§15/DPIA: aldri kopier fullt
   * møteinnhold inn i en egen tabell) - kun strukturelle felt samme klasse
   * som `read_events` allerede eksponerer (tittel/tid/sted), pluss identitet.
   */
  private async listEvents(parameters: Record<string, JsonValue>, credential: string) {
    const token = await googleAccessToken(credential);
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(String(parameters["from"]))}&timeMax=${encodeURIComponent(String(parameters["to"]))}&maxResults=${Number(parameters["max"] ?? 25)}`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`calendar_error_${response.status}`);
    const body = (await response.json()) as {
      items?: Array<{
        id: string; summary?: string; location?: string; htmlLink?: string;
        organizer?: { email?: string }; attendees?: Array<{ email?: string; resource?: boolean }>;
        start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
      }>;
    };
    const events: JsonValue[] = (body.items ?? []).map((e) => ({
      id: e.id, title: e.summary ?? "(uten tittel)",
      start: e.start?.dateTime ?? e.start?.date ?? "", end: e.end?.dateTime ?? e.end?.date ?? "",
      location: e.location ?? "",
      html_link: e.htmlLink ?? "",
      organizer: e.organizer?.email ?? "",
      attendees: (e.attendees ?? []).filter((a) => !a.resource && a.email).map((a) => String(a.email)) as unknown as JsonValue,
      account: this.accountEmail
    }));
    return { data: { events } };
  }
}

/**
 * UA-2 P1A §18/§24 (utvidet - Drive full read/write, se OWNER CONNECTOR
 * CAPABILITY INVARIANT i CLAUDE.md): Google Drive med FULL funksjonell
 * tilgang - les, skriv, omdøp, flytt, papirkurv, permanent slett, dele/
 * tilgangsstyring. OAuth-scope for produksjon MÅ være
 * `https://www.googleapis.com/auth/drive` (bekreftet mot Google sitt
 * offisielle discovery-dokument for Drive API v3 - `drive.file` dekker KUN
 * filer appen selv har opprettet, ikke "alle filer", og er derfor
 * UTILSTREKKELIG for faktisk full tilgang). Samme kontomønster som Gmail/
 * Calendar (én eksplisitt konto, ingen implisitt cross-account fallback),
 * samme `googleAccessToken()` OAuth-vei (ingen ny credential-type).
 *
 * Innhold er fortsatt begrenset til TEKST (samme P1A-scope-grense som
 * ingestion-siden - §14 "Bygges IKKE": ingen binær/OCR-oppretting/-oppdatering).
 * `create_file`/`update_content` skriver derfor kun tekstlig innhold.
 *
 * Handlinger (les):
 * - `list_files`: én SIDE av en listing (§`folder_id` styrer scope, ALDRI en
 *   default). `trashed=false` alltid med - en slettet fil forsvinner naturlig
 *   fra neste vellykkede listing (tombstone-mekanismen i `KnowledgeSyncService`).
 * - `read_document`: Google Docs → text/plain-eksport; tekstlige MIME-typer
 *   leses rått; alt annet kaster `drive_unsupported_content_<mime>`.
 * - `get_metadata`: id/name/parents/trashed/headRevisionId/modifiedTime -
 *   brukes som preflight/konflikt-sjekk FØR mutasjon (se under).
 * - `read_permissions`: lister delinger på en fil.
 *
 * Handlinger (skriv, kapabilitetsklasse C - reversible): `create_file`,
 * `create_folder`, `update_content`, `rename`, `move`, `trash`.
 * `update_content`/`rename`/`move`/`trash` godtar en VALGFRI
 * `expected_head_revision_id` - hvis oppgitt, leses filens FAKTISKE
 * `headRevisionId` FØRST og sammenlignes; ved mismatch kastes en typet
 * `drive_conflict_stale_version`-feil FØR noen mutasjon forsøkes (§7 i
 * scope-endringen: rapporter konflikt som typet feil, ALDRI som stille
 * suksess som overskriver en nyere endring).
 *
 * Handlinger (destruktive/sikkerhetskritiske, kapabilitetsklasse D):
 * `delete_permanent` (Drive sin `files.delete` er PERMANENT - flytter IKKE
 * til papirkurv, bekreftet mot API-dokumentasjonen), `create_permission`/
 * `update_permission`/`delete_permission` (deling/tilgangsstyring).
 */
const GOOGLE_DOC_EXPORT_MIME = "application/vnd.google-apps.document";
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_NATIVE_MIME_PREFIX = "application/vnd.google-apps.";
const DRIVE_SUPPORTED_RAW_MIME = new Set([
  "text/plain", "text/markdown", "text/x-markdown", "text/csv",
  "application/json", "text/html", "text/css", "application/x-yaml", "text/yaml"
]);

function isDriveSupportedRawMime(mimeType: string): boolean {
  return DRIVE_SUPPORTED_RAW_MIME.has(mimeType) || mimeType.startsWith("text/");
}

interface DriveMetadata {
  id: string;
  name: string;
  mimeType: string;
  trashed: boolean;
  parents: string[];
  headRevisionId: string | null;
  modifiedTime: string | null;
}

export class GoogleDriveTransport implements ToolTransport {
  constructor(readonly accountEmail: string = process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com") {}

  /** Felles status→typet-feil-mapping - IDENTISK klassifisering på tvers av alle Drive-endepunkt. */
  private async assertOk(response: Response, notFoundId?: string): Promise<void> {
    if (response.status === 404) throw new Error(`drive_not_found_${notFoundId ?? "unknown"}`);
    if (response.status === 401 || response.status === 403) throw new Error(`drive_auth_error_${response.status}`);
    if (response.status === 429) throw new Error("drive_rate_limited");
    if (!response.ok) throw new Error(`drive_error_${response.status}`);
  }

  private async getMetadata(fileId: string, auth: Record<string, string>): Promise<DriveMetadata> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
    url.searchParams.set("fields", "id,name,mimeType,trashed,parents,headRevisionId,modifiedTime");
    const response = await fetch(url, { headers: auth });
    await this.assertOk(response, fileId);
    const body = (await response.json()) as Partial<DriveMetadata>;
    return {
      id: body.id ?? fileId, name: body.name ?? "", mimeType: body.mimeType ?? "",
      trashed: body.trashed ?? false, parents: body.parents ?? [],
      headRevisionId: body.headRevisionId ?? null, modifiedTime: body.modifiedTime ?? null
    };
  }

  /** §7 (scope-endring): FØR en mutasjon som godtar `expected_head_revision_id` - fail-closed konfliktsjekk, ALDRI en stille overskriving. */
  private async assertNotStale(fileId: string, parameters: Record<string, JsonValue>, auth: Record<string, string>): Promise<void> {
    const expected = parameters["expected_head_revision_id"];
    if (expected === undefined) return; // ingen precondition oppgitt - kalleren har bevisst ikke bedt om en
    const current = await this.getMetadata(fileId, auth);
    if (current.headRevisionId !== String(expected)) {
      throw new Error(`drive_conflict_stale_version_${fileId}`);
    }
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const token = await googleAccessToken(credential);
    const auth = { authorization: `Bearer ${token}` };

    switch (action) {
      case "list_files":
        return this.listFiles(parameters, auth);
      case "read_document":
        return this.readDocument(parameters, auth);
      case "get_metadata": {
        const meta = await this.getMetadata(String(parameters["file_id"]), auth);
        return { data: { ...meta, parents: meta.parents } as unknown as Record<string, JsonValue> };
      }
      case "read_permissions":
        return this.readPermissions(parameters, auth);
      case "create_file":
        return this.createFile(parameters, auth, false);
      case "create_folder":
        return this.createFile(parameters, auth, true);
      case "update_content":
        return this.updateContent(parameters, auth);
      case "rename":
        return this.rename(parameters, auth);
      case "move":
        return this.move(parameters, auth);
      case "trash":
        return this.setTrashed(parameters, auth, true);
      case "delete_permanent":
        return this.deletePermanent(parameters, auth);
      case "create_permission":
        return this.createPermission(parameters, auth);
      case "update_permission":
        return this.updatePermission(parameters, auth);
      case "delete_permission":
        return this.deletePermission(parameters, auth);
      default:
        throw new Error(`drive_unsupported_action_${action}`);
    }
  }

  private async listFiles(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
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
    await this.assertOk(response);
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

  private async readDocument(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const documentId = String(parameters["document_id"]);
    const mimeType = String(parameters["mime_type"] ?? "");
    if (mimeType === GOOGLE_DOC_EXPORT_MIME) {
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${documentId}/export?mimeType=text%2Fplain`,
        { headers: auth }
      );
      await this.assertOk(response, documentId);
      return { data: { content: await response.text(), content_type: "text/plain" } };
    }
    if (mimeType.startsWith(GOOGLE_NATIVE_MIME_PREFIX) || !isDriveSupportedRawMime(mimeType)) {
      // Sheets/Slides/Forms/binærformater/bilder/PDF - eksplisitt utenfor P1A-scope (§14).
      throw new Error(`drive_unsupported_content_${mimeType || "unknown"}`);
    }
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${documentId}?alt=media`, { headers: auth });
    await this.assertOk(response, documentId);
    return { data: { content: await response.text(), content_type: mimeType } };
  }

  private async readPermissions(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`);
    url.searchParams.set("fields", "permissions(id,type,role,emailAddress,domain)");
    const response = await fetch(url, { headers: auth });
    await this.assertOk(response, fileId);
    const body = (await response.json()) as { permissions?: Array<{ id: string; type: string; role: string; emailAddress?: string; domain?: string }> };
    return { data: { permissions: (body.permissions ?? []) as unknown as JsonValue } };
  }

  /**
   * Enkel multipart-opplasting (metadata + tekstlig innhold i én request) -
   * SAMME mønster Google sin egen "simple/multipart upload"-dokumentasjon
   * beskriver for tekstbasert innhold. Ingen binær-/resumable-opplasting
   * (utenfor P1A-scope).
   */
  private async createFile(parameters: Record<string, JsonValue>, auth: Record<string, string>, isFolder: boolean) {
    const name = String(parameters["name"]);
    const parentFolderId = parameters["parent_folder_id"] ? String(parameters["parent_folder_id"]) : undefined;
    const content = isFolder ? undefined : (parameters["content"] !== undefined ? String(parameters["content"]) : "");
    const mimeType = isFolder ? GOOGLE_FOLDER_MIME : String(parameters["mime_type"] ?? "text/plain");
    const metadata: Record<string, JsonValue> = { name, mimeType, ...(parentFolderId ? { parents: [parentFolderId] } : {}) };

    if (isFolder) {
      const response = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,parents", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(metadata)
      });
      await this.assertOk(response);
      const body = (await response.json()) as { id: string; name: string };
      return { external_id: body.id, data: { id: body.id, name: body.name } };
    }

    const boundary = `jarvis-drive-boundary-${Date.now()}`;
    const multipartBody =
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n${content}\r\n` +
      `--${boundary}--`;
    const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,headRevisionId", {
      method: "POST",
      headers: { ...auth, "content-type": `multipart/related; boundary=${boundary}` },
      body: multipartBody
    });
    await this.assertOk(response);
    const body = (await response.json()) as { id: string; name: string; headRevisionId?: string };
    return { external_id: body.id, data: { id: body.id, name: body.name, head_revision_id: body.headRevisionId ?? null } };
  }

  private async updateContent(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    await this.assertNotStale(fileId, parameters, auth);
    const content = String(parameters["content"] ?? "");
    const mimeType = String(parameters["mime_type"] ?? "text/plain");
    const response = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name,headRevisionId`, {
      method: "PATCH",
      headers: { ...auth, "content-type": mimeType },
      body: content
    });
    await this.assertOk(response, fileId);
    const body = (await response.json()) as { id: string; name: string; headRevisionId?: string };
    return { external_id: body.id, data: { id: body.id, name: body.name, head_revision_id: body.headRevisionId ?? null } };
  }

  private async rename(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    await this.assertNotStale(fileId, parameters, auth);
    const newName = String(parameters["new_name"]);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: newName })
    });
    await this.assertOk(response, fileId);
    const body = (await response.json()) as { id: string; name: string };
    return { external_id: body.id, data: { id: body.id, name: body.name } };
  }

  private async move(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    await this.assertNotStale(fileId, parameters, auth);
    const newParentId = String(parameters["new_parent_folder_id"]);
    const meta = await this.getMetadata(fileId, auth);
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
    url.searchParams.set("addParents", newParentId);
    if (meta.parents.length > 0) url.searchParams.set("removeParents", meta.parents.join(","));
    url.searchParams.set("fields", "id,name,parents");
    const response = await fetch(url, { method: "PATCH", headers: auth });
    await this.assertOk(response, fileId);
    const body = (await response.json()) as { id: string; name: string; parents?: string[] };
    return { external_id: body.id, data: { id: body.id, name: body.name, parents: (body.parents ?? []) as unknown as JsonValue } };
  }

  private async setTrashed(parameters: Record<string, JsonValue>, auth: Record<string, string>, trashed: boolean) {
    const fileId = String(parameters["file_id"]);
    await this.assertNotStale(fileId, parameters, auth);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,trashed`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ trashed })
    });
    await this.assertOk(response, fileId);
    const body = (await response.json()) as { id: string; name: string; trashed: boolean };
    return { external_id: body.id, data: { id: body.id, name: body.name, trashed: String(body.trashed) } };
  }

  /** `files.delete` er PERMANENT (bekreftet mot Drive API v3-dokumentasjonen) - flytter IKKE til papirkurv. */
  private async deletePermanent(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: "DELETE", headers: auth });
    if (response.status === 404) {
      // Allerede borte - idempotent utfall for en retry, ikke en feil.
      return { external_id: fileId, data: { id: fileId, already_deleted: "true" } };
    }
    await this.assertOk(response, fileId);
    return { external_id: fileId, data: { id: fileId, already_deleted: "false" } };
  }

  private async createPermission(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    const role = String(parameters["role"]);
    const type = String(parameters["type"]);
    const body: Record<string, JsonValue> = { role, type };
    if (parameters["email_address"] !== undefined) body["emailAddress"] = String(parameters["email_address"]);
    if (parameters["domain"] !== undefined) body["domain"] = String(parameters["domain"]);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=id,type,role`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    await this.assertOk(response, fileId);
    const created = (await response.json()) as { id: string; type: string; role: string };
    return { external_id: created.id, data: { id: created.id, type: created.type, role: created.role } };
  }

  private async updatePermission(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    const permissionId = String(parameters["permission_id"]);
    const role = String(parameters["role"]);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${permissionId}?fields=id,role`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ role })
    });
    await this.assertOk(response, `${fileId}:${permissionId}`);
    const body = (await response.json()) as { id: string; role: string };
    return { external_id: body.id, data: { id: body.id, role: body.role } };
  }

  private async deletePermission(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    const permissionId = String(parameters["permission_id"]);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${permissionId}`, {
      method: "DELETE", headers: auth
    });
    if (response.status === 404) {
      return { external_id: permissionId, data: { id: permissionId, already_deleted: "true" } };
    }
    await this.assertOk(response, `${fileId}:${permissionId}`);
    return { external_id: permissionId, data: { id: permissionId, already_deleted: "false" } };
  }
}

/**
 * P1A RUNTIME WIRING CLOSEOUT (2026-08-16): de tre env-variablene
 * `googleAccessToken()` faktisk KREVER for et ekte Drive-kall
 * (`JARVIS_GOOGLE_CLIENT_ID`/`_SECRET` lest direkte der, `JARVIS_GOOGLE_
 * TOKEN` sendt inn av ToolGateway som `credential` via `SecretProvider`).
 * `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE` er BEVISST IKKE sjekket her - den er en
 * ren bokføringsmarkør for `google-drive-reauth.ts` sin egen
 * gjenopptakelseslogikk, aldri lest av selve runtime-transporten. Leser
 * KUN tilstedeværelse (`Boolean`) - ALDRI selve verdiene; ingen credential
 * logges/returneres/eksponeres her.
 */
export function googleDriveCredentialsConfigured(): boolean {
  return Boolean(
    process.env["JARVIS_GOOGLE_CLIENT_ID"] && process.env["JARVIS_GOOGLE_CLIENT_SECRET"] && process.env["JARVIS_GOOGLE_TOKEN"]
  );
}

/**
 * Delt fabrikk-fragment - api/main.ts og worker-main.ts kaller BEGGE denne
 * SAMME funksjonen (spredd inn i `firstWaveTools({...})`) i stedet for å
 * duplisere credential-sjekken to steder - garanterer at api og worker
 * ALDRI kan divergere i om Drive-verktøyene er registrert. I motsetning
 * til de andre første-bølge-transportene (email/calendar/github/telegram,
 * som ALLTID konstrueres uansett credential-tilstand og lar selve
 * HTTP-kallet feile ved manglende credential) holdes Drive sin FULLE
 * D-klasse-kapabilitet (permanent sletting, deling/tilgangsstyring)
 * eksplisitt tilbake fra registrering til den koherente credential-
 * tripletten faktisk finnes - en bevisst strengere, men IKKE en parallell,
 * registreringsvei (samme `firstWaveTools()`/`ToolGateway.register()` som
 * alt annet). Mangler credentials: returnerer et tomt objekt - `drive`-
 * nøkkelen er da fraværende og `firstWaveTools()` sin egen
 * `UnconfiguredHttpTransport("drive")`-fallback brukes i stedet (samme
 * eksisterende, allerede idempotente skall-oppførsel som FØR denne
 * closeout-rundes - INGEN oppstartskrasj, INGEN ny feilbane).
 */
export function driveTransportsIfConfigured(): Partial<Record<string, ToolTransport>> {
  return googleDriveCredentialsConfigured() ? { drive: new GoogleDriveTransport() } : {};
}

/**
 * D-247: `chatId` var FØR et rått `string | undefined`-felt, frosset ÉN gang
 * ved konstruksjon fra `process.env["JARVIS_TELEGRAM_CHAT_ID"]` - HELT
 * UTENOM `readSecretProvider`/`toolSecretProvider` (Infisical-primær, se
 * D-246). Dashbordets "Lagre" skriver KUN til Infisical, så en eier-limt
 * chat-ID der ble ALDRI sett av selve utsendelsen (`telegram.notify`,
 * inkl. Daily Brief-levering og watchdog sitt nødvarsel) - identisk
 * bug-klasse som D-246 sine fem finans-connectorer, funnet her under samme
 * "alle skal fungere absolutt alle"-gjennomgang. Fiks: konstruktøren
 * godtar NÅ ENTEN en rå streng (uendret oppførsel - brukt av eksisterende
 * scripts/tester som bevisst vil ha en fast/deterministisk verdi) ELLER en
 * resolver-funksjon som slås opp PÅ NYTT ved HVERT kall (samme mønster som
 * finans-fiksens `getCredentials()`) - produksjons-wiring (main.ts/
 * worker-main.ts) sender nå en resolver mot `readSecretProvider`/
 * `toolSecretProvider`, slik at en ny dashbord-verdi virker UTEN restart.
 */
export class TelegramTransport implements ToolTransport {
  constructor(
    private readonly chatId: string | undefined | (() => Promise<string | null>) = process.env["JARVIS_TELEGRAM_CHAT_ID"]
  ) {}
  private async resolveChatId(): Promise<string | undefined> {
    if (typeof this.chatId === "function") return (await this.chatId()) ?? undefined;
    return this.chatId;
  }
  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    if (action === "get_bot_info") {
      // Task #122 (D-213): Telegram Bot API sin offisielle `getMe` - KUN
      // boten sin egen token kreves, INGEN `chat_id`, INGEN sideeffekt.
      // Lagt til nettopp fordi `notify` under sender en EKTE melding og
      // derfor aldri kunne vært en trygg "virker credentialen?"-test.
      const response = await fetch(`https://api.telegram.org/bot${credential}/getMe`);
      if (!response.ok) throw new Error(`telegram_error_${response.status}`);
      const body = (await response.json()) as { result?: JsonValue };
      return { data: body.result ?? null };
    }
    if (action !== "notify") throw new Error(`telegram_unsupported_action_${action}`);
    const chatId = await this.resolveChatId();
    if (!chatId) throw new Error("telegram_chat_id_not_configured");
    const response = await fetch(`https://api.telegram.org/bot${credential}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: String(parameters["message"]) })
    });
    if (!response.ok) throw new Error(`telegram_error_${response.status}`);
    const body = (await response.json()) as { result?: { message_id?: number } };
    return { external_id: String(body.result?.message_id ?? "sent") };
  }
}

/**
 * D-292 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres"). Slack Web API - offisielt dokumenterte endepunkter, ikke
 * gjettet: `chat.postMessage` (send), `auth.test` (boten sin egen identitet,
 * INGEN sideeffekt - SAMME "trygg tilkoblingstest"-rolle som Telegram sin
 * `getMe` over), `conversations.list`/`conversations.history` (lesing).
 * Autentisering: `Authorization: Bearer <bot-token>`-header på ALLE kall
 * (Slack sin egen dokumenterte standard, IKKE en URL-embedded token som
 * Telegram). Slack sin EGEN respons-konvolutt er `{ok: boolean, error?:
 * string, ...}` uansett HTTP-status (200 selv ved logisk feil) - `body.ok`
 * MÅ derfor sjekkes eksplisitt, en `response.ok`-sjekk alene ville sluppet
 * gjennom en logisk Slack-feil som suksess.
 */
export class SlackTransport implements ToolTransport {
  private async call(
    method: string, credential: string, params: Record<string, JsonValue>, useJsonBody: boolean
  ): Promise<{ ok: boolean; error?: string; [key: string]: JsonValue | boolean | string | undefined }> {
    const url = `https://slack.com/api/${method}`;
    const response = useJsonBody
      ? await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
          body: JSON.stringify(params)
        })
      : await fetch(`${url}?${new URLSearchParams(params as Record<string, string>).toString()}`, {
          headers: { authorization: `Bearer ${credential}` }
        });
    if (!response.ok) throw new Error(`slack_error_${response.status}`);
    return (await response.json()) as { ok: boolean; error?: string };
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    if (action === "notify") {
      const body = await this.call(
        "chat.postMessage", credential,
        { channel: String(parameters["channel"]), text: String(parameters["message"]) }, true
      );
      if (!body.ok) throw new Error(`slack_error_${body.error ?? "unknown"}`);
      return { external_id: String((body as { ts?: string }).ts ?? "sent") };
    }
    if (action === "get_bot_info") {
      const body = await this.call("auth.test", credential, {}, true);
      if (!body.ok) throw new Error(`slack_error_${body.error ?? "unknown"}`);
      return { data: body as JsonValue };
    }
    if (action === "list_channels") {
      const body = await this.call("conversations.list", credential, {}, false);
      if (!body.ok) throw new Error(`slack_error_${body.error ?? "unknown"}`);
      return { data: (body as { channels?: JsonValue }).channels ?? null };
    }
    if (action === "read_channel_history") {
      const params: Record<string, JsonValue> = { channel: String(parameters["channel"]) };
      if (parameters["limit"] !== undefined) params["limit"] = parameters["limit"];
      const body = await this.call("conversations.history", credential, params, false);
      if (!body.ok) throw new Error(`slack_error_${body.error ?? "unknown"}`);
      return { data: (body as { messages?: JsonValue }).messages ?? null };
    }
    throw new Error(`slack_unsupported_action_${action}`);
  }
}

/**
 * D-294 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - andre slice, samme mønster som Slack/D-292 over). Discord
 * sitt offisielle REST API v10 (`discord.com/developers/docs`) - ULIK
 * Slack: INGEN `{ok, error}`-konvolutt, en suksess-respons ER selve
 * ressurs-JSON-en direkte, og en feil kommer som en EKTE HTTP-feilstatus
 * (`response.ok` alene er derfor tilstrekkelig her, i motsetning til
 * Slack). Autentisering: `Authorization: Bot <bot-token>`-header på ALLE
 * kall. `POST /channels/{channel_id}/messages` (send, `SEND_MESSAGES`),
 * `GET /users/@me` (boten sin egen identitet, INGEN sideeffekt - SAMME
 * trygge tilkoblingstest-rolle som Telegram/Slack sine egne over),
 * `GET /guilds/{guild_id}/channels` (`VIEW_CHANNEL`), `GET /channels/
 * {channel_id}/messages` (`READ_MESSAGE_HISTORY`) - alle fire offisielt
 * dokumenterte, ikke gjettet.
 */
export class DiscordTransport implements ToolTransport {
  private async call(path: string, credential: string, init?: RequestInit): Promise<JsonValue> {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      ...init,
      headers: { ...init?.headers, authorization: `Bot ${credential}` }
    });
    if (!response.ok) throw new Error(`discord_error_${response.status}`);
    return (await response.json()) as JsonValue;
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    if (action === "notify") {
      const body = await this.call(`/channels/${String(parameters["channel_id"])}/messages`, credential, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: String(parameters["message"]) })
      });
      return { external_id: String((body as { id?: string }).id ?? "sent") };
    }
    if (action === "get_bot_info") {
      const body = await this.call("/users/@me", credential);
      return { data: body };
    }
    if (action === "list_channels") {
      const body = await this.call(`/guilds/${String(parameters["guild_id"])}/channels`, credential);
      return { data: body };
    }
    if (action === "read_channel_history") {
      const query = parameters["limit"] !== undefined ? `?limit=${String(parameters["limit"])}` : "";
      const body = await this.call(`/channels/${String(parameters["channel_id"])}/messages${query}`, credential);
      return { data: body };
    }
    throw new Error(`discord_unsupported_action_${action}`);
  }
}

/**
 * D-295 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - tredje slice). Twilio sitt offisielle REST API
 * (`www.twilio.com/docs/sms/api`) - `Basic`-autentisering (`AccountSid`
 * som brukernavn, `AuthToken` som passord), IKKE en bearer-token som
 * Slack/Discord. `POST /Messages.json` (send SMS, `AccountSid` i URL-
 * stien), `GET /Accounts/{AccountSid}.json` (kontoens egen identitet,
 * INGEN sideeffekt - SAMME trygge tilkoblingstest-rolle som Telegram/
 * Slack/Discord sine egne over), `GET /Messages.json` (lesing). Twilio
 * krever et TREDJE, fast konfigurasjonsverdi utover selve credential-en
 * boten sender - avsendernummeret (`From`) - som IKKE er en sideeffekt-
 * fri modell-/kall-parameter (Twilio validerer at nummeret faktisk
 * tilhører kontoen), derfor injisert som en resolver-closure via
 * konstruktøren, SAMME mønster som Telegram sin `chat_id` (D-247) - IKKE
 * en ny mekanisme. `AccountSid` injiseres på SAMME måte (URL-stien
 * krever den, men selve `credential_ref` gateway.execute() slår opp er
 * `JARVIS_TWILIO_AUTH_TOKEN` - `credential_refs`-listen i
 * `connector-registry.ts` forblir uendret den fulle, presence-visende
 * listen av alle tre).
 */
export class TwilioTransport implements ToolTransport {
  constructor(
    private readonly accountSid: () => Promise<string | null>,
    private readonly fromNumber: () => Promise<string | null>
  ) {}

  private async call(path: string, credential: string, init?: RequestInit): Promise<JsonValue> {
    const accountSid = await this.accountSid();
    if (!accountSid) throw new Error("twilio_account_sid_not_configured");
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}${path}`, {
      ...init,
      headers: { ...init?.headers, authorization: `Basic ${Buffer.from(`${accountSid}:${credential}`).toString("base64")}` }
    });
    if (!response.ok) throw new Error(`twilio_error_${response.status}`);
    return (await response.json()) as JsonValue;
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    if (action === "notify") {
      const from = await this.fromNumber();
      if (!from) throw new Error("twilio_from_number_not_configured");
      const body = await this.call("/Messages.json", credential, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: String(parameters["to"]), From: from, Body: String(parameters["message"]) }).toString()
      });
      return { external_id: String((body as { sid?: string }).sid ?? "sent") };
    }
    if (action === "get_account_info") {
      const body = await this.call(".json", credential);
      return { data: body };
    }
    if (action === "read_messages") {
      const query = parameters["limit"] !== undefined ? `?PageSize=${String(parameters["limit"])}` : "";
      const body = await this.call(`/Messages.json${query}`, credential);
      return { data: (body as { messages?: JsonValue }).messages ?? null };
    }
    throw new Error(`twilio_unsupported_action_${action}`);
  }
}

/**
 * D-296 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - fjerde slice). Brave Search API sitt offisielle REST-
 * endepunkt (`api.search.brave.com/res/v1/...`) - `X-Subscription-Token`-
 * header (IKKE `Authorization: Bearer`, verifisert mot offisiell
 * dokumentasjon, ikke antatt fra de forrige connectorenes mønster).
 * STRUKTURELT ULIK Telegram/Slack/Discord/Twilio: INGEN `notify`/sideeffekt-
 * handling finnes i det hele tatt - Brave Search er en RENT lesende
 * søke-API, leverandøren tilbyr genuint INGEN skrivehandling (D-41 sitt
 * "read-only kun akseptabelt når leverandøren faktisk ikke tilbyr mer"-
 * unntak gjelder derfor ÆRLIG her, ikke som en snarvei). To handlinger -
 * `web_search` (`/res/v1/web/search`) og `news_search` (`/res/v1/news/
 * search`) - begge offisielt dokumenterte separate endepunkter, IKKE
 * gjettet. Siden ALT er lesing uten sideeffekt, kan `web_search` selv
 * TRYGT brukes direkte som `live_test` - INGEN egen "get_account_info"-
 * handling er nødvendig (Brave har heller ingen kontoidentitets-endepunkt
 * å teste mot).
 */
export class BraveSearchTransport implements ToolTransport {
  private async call(path: string, credential: string, params: Record<string, string>): Promise<JsonValue> {
    const response = await fetch(`https://api.search.brave.com/res/v1/${path}?${new URLSearchParams(params).toString()}`, {
      headers: { "x-subscription-token": credential, accept: "application/json" }
    });
    if (!response.ok) throw new Error(`brave_search_error_${response.status}`);
    return (await response.json()) as JsonValue;
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    if (action === "web_search") {
      const params: Record<string, string> = { q: String(parameters["query"]) };
      if (parameters["count"] !== undefined) params["count"] = String(parameters["count"]);
      const body = await this.call("web/search", credential, params);
      return { data: (body as { web?: { results?: JsonValue } }).web?.results ?? null };
    }
    if (action === "news_search") {
      const params: Record<string, string> = { q: String(parameters["query"]) };
      if (parameters["count"] !== undefined) params["count"] = String(parameters["count"]);
      const body = await this.call("news/search", credential, params);
      return { data: (body as { results?: JsonValue }).results ?? null };
    }
    throw new Error(`brave_search_unsupported_action_${action}`);
  }
}

/**
 * D-297 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - femte slice). **Ærlighetsmerknad (se D-297 i DECISIONS_AND_
 * ASSUMPTIONS.md):** dette øktens miljø blokkerer utgående nettverkstrafikk
 * til vilkårlige eksterne domener (`docs.tavily.com`/`api.search.brave.com`
 * begge bekreftet EGRESS_BLOCKED via `WebFetch` under bygging av denne
 * connectoren) - API-formen under kunne derfor IKKE bekreftes mot en LEVENDE
 * hentet kopi av Sentry sin offisielle dokumentasjon denne økten, i motsetning
 * til hva D-292/D-294/D-295/D-296 sine kommentarer hevdet ("verifisert mot
 * offisiell dokumentasjon"). Den er basert på Sentry sitt organisasjons-
 * scopede REST-API v0 (`sentry.io/api/0/...`, `Authorization: Bearer <token>`)
 * - et offentlig, stabilt uendret API-mønster over flere år - men dette er
 * TRENT kunnskap, IKKE en denne-økten-bekreftet kilde. `SENTRY_LIVE_GATE`
 * forblir derfor `PENDING_CREDENTIALS` og krever en EKTE live-test med et
 * ekte token FØR `LIVE_VERIFIED` kan påstås - se `connector-registry.ts`.
 *
 * Organisasjons-slug er, som Twilio sin AccountSid (D-295), en resolver-
 * closure slått opp PÅ NYTT ved hvert kall (IKKE frosset ved oppstart) -
 * Sentry sitt organisasjonsscopede API krever slug-en i URL-stien for alle
 * fire handlinger under. `update_issue` er den ENESTE skrivehandlingen -
 * en PUT mot et eksisterende issue (status-endring: resolved/ignored/
 * unresolved) er reversibel (en ny `update_issue` kan sette status tilbake)
 * og idempotent (samme body gir samme sluttilstand, ULIKT Slack/Discord/
 * Twilio sin `notify` som alltid oppretter en NY melding per kall).
 */
export class SentryTransport implements ToolTransport {
  constructor(private readonly orgSlug: () => Promise<string | null>) {}

  private async call(path: string, credential: string, init?: RequestInit): Promise<JsonValue> {
    const orgSlug = await this.orgSlug();
    if (!orgSlug) throw new Error("sentry_org_slug_not_configured");
    const response = await fetch(`https://sentry.io/api/0/organizations/${orgSlug}${path}`, {
      ...init,
      headers: { ...init?.headers, authorization: `Bearer ${credential}`, "content-type": "application/json" }
    });
    if (!response.ok) throw new Error(`sentry_error_${response.status}`);
    return (await response.json()) as JsonValue;
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    if (action === "list_projects") {
      const body = await this.call("/projects/", credential);
      return { data: body };
    }
    if (action === "list_issues") {
      const query = encodeURIComponent(String(parameters["query"] ?? "is:unresolved"));
      const body = await this.call(`/issues/?query=${query}`, credential);
      return { data: body };
    }
    if (action === "get_issue") {
      const body = await this.call(`/issues/${String(parameters["issue_id"])}/`, credential);
      return { data: body };
    }
    if (action === "update_issue") {
      const body = await this.call(`/issues/${String(parameters["issue_id"])}/`, credential, {
        method: "PUT",
        body: JSON.stringify({ status: parameters["status"] })
      });
      return { data: body };
    }
    throw new Error(`sentry_unsupported_action_${action}`);
  }
}

/**
 * D-242/D-248 (funnet UAVHENGIG to ganger, samme bug, se D-248 sin egen
 * lærdomskolonne i DECISIONS_AND_ASSUMPTIONS.md): `vercel` har hatt en
 * `live_test`-oppføring i `connector-registry.ts` siden D-213, men
 * `integrations.ts` sin `firstWaveTools()` fikk ALDRI en ekte transport for
 * `tool_id: "vercel"` i `transports`-recorden (`main.ts`/`worker-main.ts`) -
 * kallet falt derfor gjennom til `UnconfiguredHttpTransport`, som ALLTID
 * kaster `vercel_not_configured`, uansett om credentialen er gyldig. Dette
 * er "koden eksisterer" != "koden er faktisk koblet inn", SAMME klasse funn
 * som D-211/D-212 (se DECISIONS_AND_ASSUMPTIONS.md).
 * D-248 (samme "alle skal fungere absolutt alle"-gjennomgang som D-247):
 * `vercel`/`read_deployments` var registrert i BÅDE `connector-registry.ts`
 * (dashbord, `credential_refs`, `live_test`) OG `integrations.ts` sin
 * `firstWaveTools()` (`ToolDefinition` med `credential_ref`) - men INGEN
 * `VercelTransport`-klasse fantes noe sted i kodebasen, og INGEN
 * `main.ts`/`worker-main.ts` sendte noensinne en `vercel`-nøkkel inn i
 * `firstWaveTools({...})`. `transport("vercel")` (se `integrations.ts`)
 * falt derfor ALLTID tilbake til `UnconfiguredHttpTransport("vercel")`,
 * som ubetinget kaster `vercel_not_configured` - UANSETT om
 * `JARVIS_VERCEL_TOKEN` var satt (Infisical ELLER `.env`). Dette er
 * NØYAKTIG cross-cutting Theme 1 fra full-prosjekt-revisjonen
 * (`docs/audit/2026-09-23-full-project-audit/SUMMARY.md`) - "registrert,
 * men aldri faktisk wiret til en reell utførelsesvei" - funnet live via
 * Tobias sin egen dashbord-test (`feilet: tool_failed:vercel_not_configured`)
 * FØR denne posten; en tidligere Docker-rebuild-fiks samme økt løste en
 * ekte, men SEPARAT, stale-image-årsak - den rørte ALDRI denne strukturelle
 * mangelen. Offisiell Vercel REST API v6 "List deployments"
 * (`GET https://api.vercel.com/v6/deployments`, `Authorization: Bearer
 * <token>`) - verifisert mot Vercel sin offisielle API-dokumentasjon, ikke
 * gjettet. KUN `read_deployments` (klasse A, side-effektfri lesing,
 * eksisterende registrert scope) implementeres her - en bredere D-41-
 * kapabilitetsvurdering (skriv/redeploy/env vars) er BEVISST en egen,
 * separat oppgave, ikke del av denne bug-fiksen.
 */
export class VercelTransport implements ToolTransport {
  async invoke(action: string, _parameters: Record<string, JsonValue>, credential: string) {
    if (action !== "read_deployments") throw new Error(`vercel_unsupported_action_${action}`);
    const response = await fetch("https://api.vercel.com/v6/deployments?limit=20", {
      headers: { authorization: `Bearer ${credential}` }
    });
    if (!response.ok) throw new Error(`vercel_error_${response.status}`);
    const body = (await response.json()) as {
      deployments?: Array<{ uid: string; name: string; url: string; state?: string; readyState?: string; created: number }>;
    };
    const deployments = (body.deployments ?? []).map((d) => ({
      id: d.uid, name: d.name, url: d.url, state: d.readyState ?? d.state ?? "unknown",
      created_at: new Date(d.created).toISOString()
    }));
    return { data: { deployments } };
  }
}

/**
 * UA-5 GitHub Developer Control Plane v1 (D-64: GitHub er EXTERNAL_CANONICAL
 * for repo/commit/branch/PR/review/workflow-tilstand - Jarvis normaliserer
 * ALDRI dette til sin egen "sannhet", kun videreformidler det med proveniens,
 * Q-26). D-41-audit: forrige versjon av denne transporten var UTILSIKTET
 * begrenset til to lese-handlinger + "create_pr (aldri merge)" - IKKE fordi
 * GitHub-APIet mangler kapabilitet eller fordi Tobias har begrenset
 * connectoren, men fordi ingen tidligere slice bygde resten. D-41 krever
 * MAKSIMAL nyttig kapabilitet som default, IKKE read-only-som-bekvemmelighet
 * - denne versjonen erstatter derfor "aldri merge" med en autoritetsstyrt
 * `merge_pr` (klasse D, sovereign owner-modus utfører autonomt uten kunstig
 * godkjenningssperre, jf. D-41/UA0-AUTHORITY - IKKE et permanent forbud).
 */
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const GITHUB_MAX_ATTEMPTS = 3;
const GITHUB_BASE_BACKOFF_MS = 500;
/** Samme konvensjon som `modules/tasks/src/coding.ts` sin `PROTECTED_BRANCHES` - aldri slett/omgå disse, uansett repo. */
const GITHUB_PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master", "production"]);

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
    /** D-97: satt naar `GithubRateLimitController` (hvis wired) klassifiserte svaret som et rate-limit-signal - typet resultat-kontrakt (§18), aldri en gjettet 500. */
    readonly rateLimitClassification?: "PRIMARY_RATE_LIMIT" | "SECONDARY_RATE_LIMIT" | "PERMISSION_403"
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

function githubSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GitHub sin feilkonvolutt (`{message, documentation_url,...}`) - avkortet (200 tegn), aldri rå kropp/headere videre. */
function classifyGithubErrorBody(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { message?: string };
    const message = (parsed.message ?? "").slice(0, 200);
    return message || "UNKNOWN";
  } catch {
    return "UNCLASSIFIED_ERROR_BODY";
  }
}

/**
 * Bounded retry KUN på bekreftede retry-bare statuser (429/5xx) - ALDRI en
 * retry-storm, ALDRI retry på 4xx (auth-/valideringsfeil er ikke forbigående).
 * Respekterer GitHub sin dokumenterte `Retry-After`-header (sekundær
 * rate-limiting) FREMFOR en gjettet backoff når headeren finnes - samme
 * "les leverandørens eget signal først"-prinsipp som `google-ads-transport.ts`.
 *
 * D-97: naar en `GithubRateLimitController` er wired (`controller` !==
 * undefined - produksjon via `main.ts`/`worker-main.ts`, IKKE i eksisterende
 * tester som konstruerer `new GithubTransport()` uten argumenter - 100%
 * uendret oppførsel der), sjekkes eligibilitet FØR nettverkskallet i det hele
 * tatt gjøres (§12 - aldri sleep/busy-wait for en flertimimutters cooldown),
 * og et 429/rate-limit-klassifisert 403 sløyfer ALDRI lenger den gamle
 * inline-sleep-retry-en (den flytter til kontrolleren sin delte
 * cooldown-tilstand - neste forsøk, når som helst senere, blokkeres i
 * stedet av eligibilitetssjekken over). Ekte forbigående 5xx beholder
 * UENDRET kort inline-retry - det er ikke et rate-limit-anliggende.
 */
async function githubFetchRaw(url: string, init: RequestInit, controller?: GithubRateLimitController): Promise<Response> {
  const mutation = (init.method ?? "GET") !== "GET";
  if (controller) {
    const eligibility = await controller.checkEligible(mutation);
    if (!eligibility.eligible) {
      throw new GithubRateLimitedError(eligibility.reason, eligibility.retryAt, eligibility.retryAfterSource);
    }
  }
  const attemptAll = async (): Promise<Response> => {
    let lastError: GithubApiError | undefined;
    for (let attempt = 1; attempt <= GITHUB_MAX_ATTEMPTS; attempt++) {
      const response = await fetch(url, init);
      if (response.ok) {
        if (controller) await controller.recordOutcome(mutation, response.status, response.headers, "");
        return response;
      }
      const rawBody = await response.text().catch(() => "");
      const outcome = controller ? await controller.recordOutcome(mutation, response.status, response.headers, rawBody) : undefined;
      const rateLimitClassified = outcome?.kind === "PRIMARY_RATE_LIMIT" || outcome?.kind === "SECONDARY_RATE_LIMIT";
      const retryable = GITHUB_RETRYABLE_STATUS.has(response.status) && !rateLimitClassified;
      lastError = new GithubApiError(
        `github_api_error_${response.status}:${classifyGithubErrorBody(rawBody)}`, response.status, retryable,
        outcome && outcome.kind !== "OK" && outcome.kind !== "OTHER" ? outcome.kind : undefined
      );
      if (!retryable || attempt === GITHUB_MAX_ATTEMPTS) break;
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : Number.NaN;
      await githubSleep(Number.isFinite(retryAfterMs) ? retryAfterMs : GITHUB_BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    throw lastError!;
  };
  return mutation && controller ? controller.runMutation(attemptAll) : attemptAll();
}

function githubHeaders(credential: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${credential}`,
    accept: "application/vnd.github+json",
    "user-agent": "jarvis",
    "x-github-api-version": GITHUB_API_VERSION,
    ...extra
  };
}

function ghRequireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`github_missing_parameter:${key}`);
  return value;
}
function ghOptionalString(parameters: Record<string, JsonValue>, key: string): string | undefined {
  const value = parameters[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function ghOptionalStringArray(parameters: Record<string, JsonValue>, key: string): string[] | undefined {
  const value = parameters[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

interface GithubPullRequestSummary {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  html_url: string;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string | null;
}

function toPullRequestSummary(pr: {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
}): GithubPullRequestSummary {
  return {
    number: pr.number, title: pr.title, state: pr.state, draft: Boolean(pr.draft),
    head_ref: pr.head.ref, head_sha: pr.head.sha, base_ref: pr.base.ref, html_url: pr.html_url,
    merged: Boolean(pr.merged), mergeable: pr.mergeable ?? null, mergeable_state: pr.mergeable_state ?? null
  };
}

export class GithubTransport implements ToolTransport {
  /** D-97: `rateLimitController` er valgfri - UDEFINERT bevarer 100% av tidligere oppførsel (alle eksisterende kallesteder/tester som konstruerer `new GithubTransport()` uendret). Wired med en ekte kontroller kun i produksjon (`apps/api/src/main.ts`/`worker-main.ts`). */
  constructor(private readonly rateLimitController?: GithubRateLimitController) {}

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string, _context?: ToolInvocationContext) {
    const repo = ghRequireString(parameters, "repo");
    const base = `https://api.github.com/repos/${repo}`;
    const headers = githubHeaders(credential);
    const writeHeaders = githubHeaders(credential, { "content-type": "application/json" });
    const githubFetch = (url: string, init: RequestInit = {}) => githubFetchRaw(url, init, this.rateLimitController);

    switch (action) {
      // --- LES (klasse A) -------------------------------------------------
      case "read_issues": {
        // UNCHANGED (UA-2 P0): GithubKnowledgeSource avhenger av nøyaktig denne formen.
        const response = await githubFetch(`${base}/issues?state=open&per_page=20`, { headers });
        const items = (await response.json()) as Array<{ number: number; title: string; updated_at: string; pull_request?: unknown }>;
        return { data: { issues: items.map((i) => ({ id: String(i.number), title: i.title, at: i.updated_at, is_pr: String(Boolean(i.pull_request)), ci_failing: "false" })) } };
      }
      case "read_repo_meta": {
        // UNCHANGED (UA-2 P0): GithubKnowledgeSource avhenger av nøyaktig denne formen.
        const response = await githubFetch(base, { headers });
        const meta = (await response.json()) as { full_name: string; description: string | null; updated_at: string; default_branch: string };
        return { data: { full_name: meta.full_name, description: meta.description ?? "", updated_at: meta.updated_at, default_branch: meta.default_branch } };
      }
      case "list_branches": {
        const response = await githubFetch(`${base}/branches?per_page=100`, { headers });
        const items = (await response.json()) as Array<{ name: string; commit: { sha: string }; protected: boolean }>;
        return { data: { branches: items.map((b) => ({ name: b.name, sha: b.commit.sha, protected: b.protected })) } };
      }
      case "get_branch": {
        const branch = ghRequireString(parameters, "branch");
        const response = await githubFetch(`${base}/branches/${encodeURIComponent(branch)}`, { headers });
        const b = (await response.json()) as { name: string; commit: { sha: string }; protected: boolean };
        return { data: { name: b.name, sha: b.commit.sha, protected: b.protected } };
      }
      case "get_commit": {
        const ref = ghRequireString(parameters, "ref");
        const response = await githubFetch(`${base}/commits/${encodeURIComponent(ref)}`, { headers });
        const c = (await response.json()) as { sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } } };
        return { external_id: c.sha, data: { sha: c.sha, message: c.commit.message, author: c.commit.author.name, date: c.commit.author.date, html_url: c.html_url } };
      }
      case "list_pull_requests": {
        const state = ghOptionalString(parameters, "state") ?? "open";
        const response = await githubFetch(`${base}/pulls?state=${encodeURIComponent(state)}&per_page=50`, { headers });
        const items = (await response.json()) as Array<Parameters<typeof toPullRequestSummary>[0]>;
        return { data: { pull_requests: items.map(toPullRequestSummary) as unknown as JsonValue } };
      }
      case "get_pull_request": {
        const prNumber = ghRequireString(parameters, "pr_number");
        const response = await githubFetch(`${base}/pulls/${encodeURIComponent(prNumber)}`, { headers });
        const pr = (await response.json()) as Parameters<typeof toPullRequestSummary>[0];
        return { external_id: String(pr.number), data: toPullRequestSummary(pr) as unknown as JsonValue };
      }
      case "list_workflow_runs": {
        const branchFilter = ghOptionalString(parameters, "branch");
        const statusFilter = ghOptionalString(parameters, "status");
        const query = new URLSearchParams({ per_page: "20" });
        if (branchFilter) query.set("branch", branchFilter);
        if (statusFilter) query.set("status", statusFilter);
        const response = await githubFetch(`${base}/actions/runs?${query.toString()}`, { headers });
        const body = (await response.json()) as { workflow_runs: Array<{ id: number; name: string; status: string; conclusion: string | null; head_sha: string; head_branch: string; html_url: string; created_at: string }> };
        return {
          data: {
            workflow_runs: body.workflow_runs.map((r) => ({
              id: String(r.id), name: r.name, status: r.status, conclusion: r.conclusion ?? "", head_sha: r.head_sha, head_branch: r.head_branch, html_url: r.html_url, created_at: r.created_at
            })) as unknown as JsonValue
          }
        };
      }
      case "get_workflow_run": {
        // D-105 (UA-5 kriterium 1 host-fix): utvidet med `created_at` - DEN
        // FAKTISKE providertidsstemplet GitHub allerede returnerer på dette
        // endepunktet (samme felt `list_workflow_runs` allerede har brukt),
        // som `deployment-ingestion.ts` bruker som `deployed_at` - ALDRI
        // `Date.now()` kalt "providersannhet".
        const runId = ghRequireString(parameters, "run_id");
        const response = await githubFetch(`${base}/actions/runs/${encodeURIComponent(runId)}`, { headers });
        const r = (await response.json()) as { id: number; name: string; status: string; conclusion: string | null; head_sha: string; head_branch: string; html_url: string; created_at: string };
        return { external_id: String(r.id), data: { id: String(r.id), name: r.name, status: r.status, conclusion: r.conclusion ?? "", head_sha: r.head_sha, head_branch: r.head_branch, html_url: r.html_url, created_at: r.created_at } };
      }
      case "list_workflow_jobs": {
        const runId = ghRequireString(parameters, "run_id");
        const response = await githubFetch(`${base}/actions/runs/${encodeURIComponent(runId)}/jobs`, { headers });
        const body = (await response.json()) as { jobs: Array<{ id: number; name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null; steps?: Array<{ name: string; status: string; conclusion: string | null; number: number }> }> };
        return {
          data: {
            jobs: body.jobs.map((j) => ({
              id: String(j.id), name: j.name, status: j.status, conclusion: j.conclusion ?? "",
              started_at: j.started_at ?? "", completed_at: j.completed_at ?? "",
              steps: (j.steps ?? []).map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion ?? "", number: s.number })) as unknown as JsonValue
            })) as unknown as JsonValue
          }
        };
      }

      // --- SKRIV, reversibel (klasse B) -----------------------------------
      case "create_branch": {
        const branch = ghRequireString(parameters, "branch");
        const fromSha = ghRequireString(parameters, "from_sha");
        if (GITHUB_PROTECTED_BRANCHES.has(branch)) {
          throw new Error("github_protected_branch_refused");
        }
        try {
          const response = await githubFetch(`${base}/git/refs`, {
            method: "POST", headers: writeHeaders,
            body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha })
          });
          const created = (await response.json()) as { object: { sha: string } };
          return { external_id: created.object.sha, data: { branch, sha: created.object.sha, created: true } };
        } catch (err) {
          // Idempotens KUN når branchen faktisk peker på DEN SAMME sha-en vi
          // ba om - en generisk 422 "already exists" er ALDRI nok alene
          // (kunne peke på en helt annen commit). Ulik sha = ekte
          // stale-target-konflikt, ALDRI stille behandlet som suksess.
          if (err instanceof GithubApiError && err.httpStatus === 422 && /already exists/i.test(err.message)) {
            const existing = await githubFetch(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, { headers });
            const ref = (await existing.json()) as { object: { sha: string } };
            if (ref.object.sha !== fromSha) {
              throw new GithubApiError(`github_branch_stale_target:${branch}_exists_at_different_sha`, 409, false);
            }
            return { external_id: ref.object.sha, data: { branch, sha: ref.object.sha, created: false } };
          }
          throw err;
        }
      }
      case "update_pr": {
        const prNumber = ghRequireString(parameters, "pr_number");
        const title = ghOptionalString(parameters, "title");
        const body = ghOptionalString(parameters, "body");
        const state = ghOptionalString(parameters, "state"); // "open" | "closed" - ALDRI "merged" her, se merge_pr
        const patch: Record<string, string> = {};
        if (title !== undefined) patch["title"] = title;
        if (body !== undefined) patch["body"] = body;
        if (state !== undefined) patch["state"] = state;
        const response = await githubFetch(`${base}/pulls/${encodeURIComponent(prNumber)}`, { method: "PATCH", headers: writeHeaders, body: JSON.stringify(patch) });
        const pr = (await response.json()) as Parameters<typeof toPullRequestSummary>[0];
        return { external_id: String(pr.number), data: toPullRequestSummary(pr) as unknown as JsonValue };
      }
      case "comment_on_issue": {
        // Samme endepunkt for issues OG PR-er (GitHub sin egen konvensjon - en PR ER et issue for kommentar-formål).
        const issueNumber = ghRequireString(parameters, "issue_number");
        const body = ghRequireString(parameters, "body");
        const response = await githubFetch(`${base}/issues/${encodeURIComponent(issueNumber)}/comments`, { method: "POST", headers: writeHeaders, body: JSON.stringify({ body }) });
        const comment = (await response.json()) as { id: number; html_url: string };
        return { external_id: String(comment.id), data: { id: String(comment.id), html_url: comment.html_url } };
      }
      case "set_labels": {
        // PUT erstatter HELE label-settet - naturlig idempotent (samme input = samme sluttilstand, ikke akkumulerende POST).
        const issueNumber = ghRequireString(parameters, "issue_number");
        const labels = ghOptionalStringArray(parameters, "labels") ?? [];
        const response = await githubFetch(`${base}/issues/${encodeURIComponent(issueNumber)}/labels`, { method: "PUT", headers: writeHeaders, body: JSON.stringify({ labels }) });
        const items = (await response.json()) as Array<{ name: string }>;
        return { data: { labels: items.map((l) => l.name) as unknown as JsonValue } };
      }
      case "request_reviewers": {
        const prNumber = ghRequireString(parameters, "pr_number");
        const reviewers = ghOptionalStringArray(parameters, "reviewers") ?? [];
        const response = await githubFetch(`${base}/pulls/${encodeURIComponent(prNumber)}/requested_reviewers`, { method: "POST", headers: writeHeaders, body: JSON.stringify({ reviewers }) });
        const pr = (await response.json()) as { requested_reviewers?: Array<{ login: string }> };
        return { data: { requested_reviewers: (pr.requested_reviewers ?? []).map((r) => r.login) as unknown as JsonValue } };
      }
      case "create_issue": {
        const title = ghRequireString(parameters, "title");
        const body = ghOptionalString(parameters, "body");
        const response = await githubFetch(`${base}/issues`, { method: "POST", headers: writeHeaders, body: JSON.stringify({ title, ...(body !== undefined ? { body } : {}) }) });
        const issue = (await response.json()) as { number: number; html_url: string };
        return { external_id: String(issue.number), data: { number: String(issue.number), html_url: issue.html_url } };
      }
      case "update_issue": {
        const issueNumber = ghRequireString(parameters, "issue_number");
        const title = ghOptionalString(parameters, "title");
        const body = ghOptionalString(parameters, "body");
        const state = ghOptionalString(parameters, "state"); // "open" | "closed"
        const patch: Record<string, string> = {};
        if (title !== undefined) patch["title"] = title;
        if (body !== undefined) patch["body"] = body;
        if (state !== undefined) patch["state"] = state;
        const response = await githubFetch(`${base}/issues/${encodeURIComponent(issueNumber)}`, { method: "PATCH", headers: writeHeaders, body: JSON.stringify(patch) });
        const issue = (await response.json()) as { number: number; state: string; html_url: string };
        return { external_id: String(issue.number), data: { number: String(issue.number), state: issue.state, html_url: issue.html_url } };
      }
      case "rerun_workflow_run": {
        const runId = ghRequireString(parameters, "run_id");
        const failedOnly = parameters["failed_only"] === true;
        const path = failedOnly ? "rerun-failed-jobs" : "rerun";
        await githubFetch(`${base}/actions/runs/${encodeURIComponent(runId)}/${path}`, { method: "POST", headers: writeHeaders, body: "" });
        return { external_id: runId, data: { run_id: runId, action: path } };
      }
      case "cancel_workflow_run": {
        const runId = ghRequireString(parameters, "run_id");
        await githubFetch(`${base}/actions/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", headers: writeHeaders, body: "" });
        return { external_id: runId, data: { run_id: runId, cancelled: true } };
      }

      // --- SKRIV, betydelig men gjenopprettbar (klasse C) -----------------
      case "create_pr": {
        const branch = ghRequireString(parameters, "branch");
        const title = ghRequireString(parameters, "title");
        const prBase = ghOptionalString(parameters, "base") ?? "main";
        const body = ghOptionalString(parameters, "body");
        try {
          const response = await githubFetch(`${base}/pulls`, {
            method: "POST", headers: writeHeaders,
            body: JSON.stringify({ title, head: branch, base: prBase, ...(body !== undefined ? { body } : {}) })
          });
          const pr = (await response.json()) as { number: number; html_url: string };
          return { external_id: String(pr.number), data: { number: String(pr.number), html_url: pr.html_url, created: true } };
        } catch (err) {
          // Idempotens KUN når den eksisterende PR-en faktisk løser seg til
          // SAMME repo/head/base - `base` filtreres server-side (GitHub sitt
          // eget `base`-spørreparameter), IKKE bare det første treffet for
          // riktig head. En generisk 422 (annen valideringsfeil) rekastes uendret.
          if (err instanceof GithubApiError && err.httpStatus === 422 && /already exists/i.test(err.message)) {
            const owner = repo.split("/")[0];
            const existing = await githubFetch(`${base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(prBase)}`, { headers });
            const matches = (await existing.json()) as Array<{ number: number; html_url: string }>;
            const match = matches[0];
            if (match) return { external_id: String(match.number), data: { number: String(match.number), html_url: match.html_url, created: false } };
          }
          throw err;
        }
      }
      case "dispatch_workflow": {
        const workflowId = ghRequireString(parameters, "workflow_id");
        const ref = ghRequireString(parameters, "ref");
        const inputs = parameters["inputs"];
        await githubFetch(`${base}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, {
          method: "POST", headers: writeHeaders,
          body: JSON.stringify({ ref, ...(inputs && typeof inputs === "object" ? { inputs } : {}) })
        });
        return { data: { workflow_id: workflowId, ref, dispatched: true } };
      }

      // --- KRITISK / DESTRUKTIV (klasse D) --------------------------------
      case "merge_pr": {
        const prNumber = ghRequireString(parameters, "pr_number");
        const mergeMethod = ghOptionalString(parameters, "merge_method") ?? "merge"; // merge|squash|rebase
        const expectedHeadSha = ghOptionalString(parameters, "expected_head_sha");
        try {
          const response = await githubFetch(`${base}/pulls/${encodeURIComponent(prNumber)}/merge`, {
            method: "PUT", headers: writeHeaders,
            body: JSON.stringify({ merge_method: mergeMethod, ...(expectedHeadSha !== undefined ? { sha: expectedHeadSha } : {}) })
          });
          const result = (await response.json()) as { sha: string; merged: boolean; message: string };
          return { external_id: result.sha, data: { sha: result.sha, merged: result.merged, message: result.message } };
        } catch (err) {
          // Merge-idempotens (§12): GitHub svarer 405 BÅDE for "allerede merget"
          // OG "ikke mergeable" - IKKE nok alene å tolke feilteksten. Les PR-en
          // PÅ NYTT og stol KUN på det faktiske `merged`-feltet - samme
          // "verifiser ekte tilstand, ikke gjett fra feiltekst"-prinsipp som
          // create_branch/create_pr sin 422-håndtering over.
          if (err instanceof GithubApiError && err.httpStatus === 405) {
            const recheck = await githubFetch(`${base}/pulls/${encodeURIComponent(prNumber)}`, { headers });
            const pr = (await recheck.json()) as { merged?: boolean; merge_commit_sha?: string | null };
            if (pr.merged === true && pr.merge_commit_sha) {
              return { external_id: pr.merge_commit_sha, data: { sha: pr.merge_commit_sha, merged: true, message: "already_merged_verified_on_reread" } };
            }
          }
          throw err;
        }
      }
      case "delete_branch": {
        const branch = ghRequireString(parameters, "branch");
        if (GITHUB_PROTECTED_BRANCHES.has(branch)) {
          throw new Error("github_protected_branch_refused");
        }
        await githubFetch(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "DELETE", headers });
        return { data: { branch, deleted: true } };
      }

      default:
        throw new Error(`github_unsupported_action_${action}`);
    }
  }
}

/**
 * D-125 (UA-7): en inngående eier-melding, slik den overleveres til
 * `handlers.chat`. Feltene er UBETRODD innhold fra Telegram (Ingestion Zone,
 * CLAUDE.md regel 7) og er DATA - aldri instruksjoner. `chat_id` er den ENESTE
 * verdien som får delta i identitets-/autoritetsavgjørelser, og den avgjøres
 * ikke her: den sendes videre nettopp slik at den betrodde server-side
 * autoriteten kan gjøre sin EGEN uavhengige eier-sjekk (forsvar i dybden -
 * pollerens egen sjekk under er den første, ikke den eneste).
 */
export interface TelegramInboundOwnerMessage {
  chat_id: string;
  text: string;
}

/**
 * Maks antall `update_id` som huskes som allerede behandlet. Rikelig for et
 * hvilket som helst realistisk poll-vindu, og bundet slik at en langtkjørende
 * prosess ikke vokser ubegrenset.
 */
const TELEGRAM_HANDLED_UPDATE_MEMORY = 512;

/**
 * Telegram-kommandopolling: /brief og /status via getUpdates (long-poll).
 * Svar leveres via Tool Gateway (policy/audit) - aldri direkte fetch tilbake.
 *
 * D-125 (UA-7, FEMTE slice): i tillegg til de eksisterende kommandoene kan
 * VANLIG eier-tekst nå rutes videre via den valgfrie `chat`-handleren, som
 * apps/api binder til den kanoniske samtalebanen. Er `chat` ikke satt, oppfører
 * polleren seg NØYAKTIG som før (vanlig tekst ignoreres) - eksisterende
 * oppsett er derfor uendret.
 *
 * To ting endret seg strukturelt, og begge er PÅKREVD av at `chat` kan være
 * treg (en modellsamtale tar sekunder, en `/status` gjør ikke det):
 *
 *  1. RE-ENTRANS-LÅS. `start()` bruker `setInterval`. Uten låsen ville tick
 *     nr. 2 startet en ny `getUpdates` mens tick nr. 1 fortsatt ventet på
 *     modellen - og fordi `offset` først avanseres NÅR svaret er lest, ville
 *     nr. 2 hentet NØYAKTIG DE SAMME oppdateringene og svart en gang til.
 *  2. BEHANDLET-UPDATE-GUARD. `update_id` markeres som behandlet FØR
 *     dispatch. Telegram kan gjenlevere en oppdatering helt til en senere
 *     `getUpdates` med høyere `offset` bekrefter den; guarden gjør leveringen
 *     at-most-once innenfor prosessens levetid. At-most-once er den TRYGGE
 *     retningen: en tapt `/brief` er ubehagelig, en dobbelt utført handling
 *     er en ekte feil.
 *
 * Hver oppdatering håndteres også isolert: en feil på én melding avslutter
 * ikke løkken. Uten det ville de resterende oppdateringene i samme batch blitt
 * stille borte - `offset` var allerede avansert forbi dem.
 */
export class TelegramCommandPoller {
  private offset = 0;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private readonly handled = new Set<number>();
  constructor(
    private readonly token: string,
    private readonly ownerChatId: string,
    private readonly handlers: {
      brief(): Promise<string>;
      status(): Promise<string>;
      ai?(): Promise<string>;
      /**
       * Task #121 (D-214): rask "one-tap" eier-godkjenning for
       * `requires_approval`-klassifiserte selvendringsforespørsler (se
       * modules/self-modification) - `/godkjenn <request_id>` og
       * `/avvis <request_id>`. Dette er BEVISST den samme betrodde eier-
       * chat-bindingen som `/brief`/`/status` (fail-closed lenger opp i
       * `poll()` - kun `ownerChatId` når hit i det hele tatt), IKKE en
       * kryptografisk per-handling-signatur som Ed25519 `SignedApproval`
       * (modules/policy/src/approval-verifier.ts) - eksplisitt eierens eget
       * valg (AskUserQuestion-svar), en bevisst mindre, men ekte, tillits-
       * grense enn den generelle klasse D-mekanismen.
       */
      approveSelfMod?(requestId: string): Promise<string>;
      rejectSelfMod?(requestId: string): Promise<string>;
      /**
       * D-125: vanlig (ikke-kommando) eier-tekst. Returner `undefined` for å
       * ikke svare i det hele tatt - det er hva en fail-closed autoritet skal
       * gi, og polleren sender da INGENTING (ingen informasjonslekkasje, ikke
       * engang en feilmelding som bekrefter at boten finnes).
       */
      chat?(message: TelegramInboundOwnerMessage): Promise<string | undefined>;
    },
    private readonly send: (text: string) => Promise<void>
  ) {}

  start(intervalMs = 4000): void {
    // D-222: tidligere `.catch(() => undefined)` - en `poll()`-feil UTENFOR
    // per-melding-løkken (fetch-nettverksfeil, ugyldig JSON, en uventet feil
    // FØR selve `try`-blokken slipper til) forsvant HELT sporløst, samme
    // "siste sikkerhetsnett"-anti-mønster som D-218 (`DailyScheduler.start()`)
    // og D-196 (`main.ts` sin `worker.drain()`-løkke) allerede fikset.
    this.timer = setInterval(() => void this.poll().catch((err) => {
      console.error(JSON.stringify({
        msg: "telegram_poll_tick_failed",
        error: err instanceof Error ? err.message : String(err)
      }));
    }), intervalMs);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    if (this.polling) return; // se §1 i klassekommentaren - aldri to samtidige poll
    this.polling = true;
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=0`);
      if (!response.ok) return;
      const body = (await response.json()) as { result?: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }> };
      for (const update of body.result ?? []) {
        this.offset = update.update_id + 1;
        if (this.handled.has(update.update_id)) continue; // §2 - aldri dobbel handling
        const chat = String(update.message?.chat.id ?? "");
        // Fail-closed FØR alt annet: en fremmed chat markeres ikke, teller ikke,
        // og utløser ingen modell-, verktøy- eller sesjonsarbeid.
        if (chat !== this.ownerChatId) continue; // kun owner - ingen fremmede kommandoer
        this.rememberHandled(update.update_id);
        const text = update.message?.text ?? "";
        try {
          await this.dispatch(chat, text);
        } catch (err) {
          // D-222: bar `catch {}` uten fanget feil-variabel - STERKERE signal
          // enn `.catch(() => undefined)` (D-221-lærdommen: ingen mulighet å
          // logge originalfeilen uten en kodeendring). Isolasjonen (én
          // melding feiler ikke resten av batchen) er UENDRET - kun
          // stillheten var feilen.
          console.error(JSON.stringify({
            msg: "telegram_dispatch_failed",
            update_id: update.update_id,
            error: err instanceof Error ? err.message : String(err)
          }));
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Kommandoene er UENDRET og har fortsatt forrang. Kun tekst som verken er
   * tom eller starter med `/` når `chat`-handleren: kommando-navnerommet
   * forblir dermed 100% deterministisk, og en ukjent `/kommando` blir aldri
   * stille omtolket til en modellsamtale.
   */
  private async dispatch(chatId: string, text: string): Promise<void> {
    if (text.startsWith("/brief")) return void (await this.send(await this.handlers.brief()));
    if (text.startsWith("/status")) return void (await this.send(await this.handlers.status()));
    if (text.startsWith("/ai") && this.handlers.ai) return void (await this.send(await this.handlers.ai()));
    if (text.startsWith("/godkjenn") && this.handlers.approveSelfMod) {
      return void (await this.dispatchSelfModDecision(text, "/godkjenn", this.handlers.approveSelfMod));
    }
    if (text.startsWith("/avvis") && this.handlers.rejectSelfMod) {
      return void (await this.dispatchSelfModDecision(text, "/avvis", this.handlers.rejectSelfMod));
    }
    if (text.startsWith("/") || text.trim().length === 0 || !this.handlers.chat) return;
    const reply = await this.handlers.chat({ chat_id: chatId, text });
    if (reply !== undefined && reply.length > 0) await this.send(reply);
  }

  /**
   * Task #121 (D-214): `/godkjenn <request_id>` / `/avvis <request_id>`.
   * Manglende/tom id svarer med en brukbarhets-melding i stedet for å kalle
   * handleren med en tom streng - `SelfModificationService.resolveApproval()`
   * skal ALDRI motta en ugyldig/gjettet id fra en parse-glipp her.
   */
  private async dispatchSelfModDecision(
    text: string,
    command: "/godkjenn" | "/avvis",
    handler: (requestId: string) => Promise<string>
  ): Promise<void> {
    const requestId = text.slice(command.length).trim().split(/\s+/)[0];
    if (!requestId) {
      await this.send(`Bruk: ${command} <request_id>`);
      return;
    }
    await this.send(await handler(requestId));
  }

  private rememberHandled(updateId: number): void {
    this.handled.add(updateId);
    if (this.handled.size > TELEGRAM_HANDLED_UPDATE_MEMORY) {
      // Sett bevarer innsettingsrekkefølge - den eldste er alltid først, og
      // `offset` gjør uansett at gamle ID-er aldri hentes på nytt.
      const oldest = this.handled.values().next();
      if (!oldest.done) this.handled.delete(oldest.value);
    }
  }
}

/**
 * D-298 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - sjette slice). **Samme ærlighetsforbehold som D-297** (se
 * DECISIONS_AND_ASSUMPTIONS.md): dette øktens nettverksegress er blokkert
 * mot eksterne dokumentasjonsdomener, så API-formen under er basert på
 * trent kunnskap om Google Maps Platform sitt offentlige, år-stabile
 * Geocoding API (`maps.googleapis.com/maps/api/geocode/json`), IKKE en
 * denne-økten-bekreftet kilde. BEVISST AVGRENSET til KUN Geocoding
 * (`geocode`/`reverse_geocode`) - Places- og Routes-API-ene er separate,
 * fortsatt ubygde backlog-id-er (`google_places`/`google_routes`) med egne
 * credential_refs i `connector-registry.ts`, IKKE konflatert inn her.
 * STRUKTURELT LIK Brave Search: leverandøren tilbyr genuint bare lesing for
 * Geocoding-endepunktet, D-41 sitt read-only-unntak ærlig oppfylt. API-
 * nøkkelen sendes som `key`-query-parameter (Google sin egen dokumenterte
 * REST-konvensjon for denne API-en, IKKE en header som Brave Search).
 * Google sin egen `status`-verdi i svaret (OK/ZERO_RESULTS/REQUEST_DENIED/
 * OVER_QUERY_LIMIT/...) returneres RÅTT som en del av `data` - transporten
 * tolker den IKKE selv (samme "ikke overtolke leverandørsvar"-disiplin som
 * andre lesehandlinger i denne rekken).
 */
export class GoogleMapsTransport implements ToolTransport {
  private async call(params: Record<string, string>, credential: string): Promise<JsonValue> {
    const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${new URLSearchParams({ ...params, key: credential }).toString()}`);
    if (!response.ok) throw new Error(`google_maps_error_${response.status}`);
    return (await response.json()) as JsonValue;
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    if (action === "geocode") {
      const body = await this.call({ address: String(parameters["address"]) }, credential);
      return { data: body };
    }
    if (action === "reverse_geocode") {
      const body = await this.call({ latlng: String(parameters["latlng"]) }, credential);
      return { data: body };
    }
    throw new Error(`google_maps_unsupported_action_${action}`);
  }
}

/**
 * D-299 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - syvende slice). **Samme ærlighetsforbehold som D-297/D-298**
 * (nettverksegress blokkert, basert på trent kunnskap om Google Sheets API
 * v4, ikke denne-økten-bekreftet). Gjenbruker den EKSISTERENDE, allerede
 * proven `googleAccessToken()` OAuth-refresh-token-utveksleren (SAMME
 * `JARVIS_GOOGLE_CLIENT_ID`/`JARVIS_GOOGLE_CLIENT_SECRET` Desktop-klient som
 * Gmail/Calendar/Drive allerede bruker) - MEN med sin EGEN, separate
 * `credential_ref` (`JARVIS_GOOGLE_SHEETS_TOKEN`, samme som D-232 sin
 * opprinnelige plassholder allerede spesifiserte), IKKE gjenbruk av
 * `JARVIS_GOOGLE_TOKEN`. Årsak: Sheets sin celledata-API (`sheets.
 * googleapis.com/v4/...`) krever den DEDIKERTE `spreadsheets`-OAuth-scopen -
 * Drive sin brede `auth/drive`-scope dekker Sheets-FILER som Drive-objekter
 * (liste/slette/dele), men IKKE selve celleinnholdet via Sheets-API-et. Å
 * anta det eksisterende `JARVIS_GOOGLE_TOKEN` allerede har denne scopen ville
 * vært en USIKKER antakelse denne økten ikke kan bekrefte - en egen credential
 * er derfor det ÆRLIGE valget (feiler tydelig med `insufficient_scope` hvis
 * Tobias limmer inn feil token, i stedet for å late som det virker).
 * D-41 sitt "maksimal nyttig kapabilitet"-prinsipp (ikke read-only av
 * bekvemmelighet): `read_range`/`list_sheets` (klasse A) OG `update_range`/
 * `append_row` (klasse B, ekte skrivehandlinger) - samme "full funksjonell
 * tilgang"-disiplin som Drive (D-42) allerede etablerte, ikke en kunstig
 * innsnevring.
 */
export class GoogleSheetsTransport implements ToolTransport {
  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    const token = await googleAccessToken(credential);
    const spreadsheetId = String(parameters["spreadsheet_id"]);
    if (action === "list_sheets") {
      const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
        headers: { authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error(`sheets_error_${response.status}`);
      const body = (await response.json()) as { sheets?: Array<{ properties?: { title?: string; sheetId?: number } }> };
      return { data: (body.sheets ?? []).map((s) => ({ title: s.properties?.title ?? "", sheet_id: s.properties?.sheetId ?? null })) as unknown as JsonValue };
    }
    if (action === "read_range") {
      const range = encodeURIComponent(String(parameters["range"]));
      const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
        headers: { authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error(`sheets_error_${response.status}`);
      const body = (await response.json()) as { values?: JsonValue };
      return { data: body.values ?? [] };
    }
    if (action === "update_range") {
      const range = encodeURIComponent(String(parameters["range"]));
      const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ range: String(parameters["range"]), values: parameters["values"] })
      });
      if (!response.ok) throw new Error(`sheets_error_${response.status}`);
      return { data: (await response.json()) as JsonValue };
    }
    if (action === "append_row") {
      const range = encodeURIComponent(String(parameters["range"]));
      const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ range: String(parameters["range"]), values: [parameters["row"]] })
      });
      if (!response.ok) throw new Error(`sheets_error_${response.status}`);
      const body = (await response.json()) as { updates?: { updatedRange?: string } };
      return { external_id: body.updates?.updatedRange ?? "appended" };
    }
    throw new Error(`sheets_unsupported_action_${action}`);
  }
}

/**
 * D-301 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
 * fullføres" - tilbake til ett-connector-per-PR etter D-297-300-samlingen).
 * **Samme ærlighetsforbehold som D-297/D-298/D-299/D-300** (nettverksegress
 * blokkert denne økten, `WebFetch` mot eksterne dokumentasjonsdomener
 * bekreftet `EGRESS_BLOCKED` - se D-297): API-formen under er basert på
 * trent kunnskap om Tavily sitt offentlige Search-API, IKKE en denne-økten-
 * bekreftet kilde. Tavily sender API-nøkkelen som `api_key`-FELT I POST-
 * BODY-en (IKKE en `Authorization`-header, ULIK Sentry/Brave Search) - deres
 * opprinnelige, mest utbredt dokumenterte autentiseringsform. Kun ÉTT reelt
 * dokumentert endepunkt (`POST /search`) er kjent med tilstrekkelig
 * sikkerhet - `web_search`/`news_search` skiller seg derfor KUN på `topic`-
 * body-feltet (general/news) mot SAMME endepunkt, i stedet for å gjette på
 * et separat nyhets-endepunkts URL/form. STRUKTURELT LIK Brave Search: D-41
 * sitt read-only-unntak ærlig oppfylt (søke-API, ingen skrivehandling).
 */
export class TavilyTransport implements ToolTransport {
  private async call(topic: "general" | "news", parameters: Record<string, JsonValue>, credential: string): Promise<JsonValue> {
    const body: Record<string, JsonValue> = { api_key: credential, query: String(parameters["query"]), topic };
    if (parameters["max_results"] !== undefined) body["max_results"] = parameters["max_results"];
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`tavily_error_${response.status}`);
    return (await response.json()) as JsonValue;
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    if (action === "web_search") {
      const body = await this.call("general", parameters, credential);
      return { data: (body as { results?: JsonValue }).results ?? null };
    }
    if (action === "news_search") {
      const body = await this.call("news", parameters, credential);
      return { data: (body as { results?: JsonValue }).results ?? null };
    }
    throw new Error(`tavily_unsupported_action_${action}`);
  }
}

/**
 * D-302 (Tobias direkte i chat: "fortsett og jobbe ikke vent på ci" - niende
 * slice). **Samme ærlighetsforbehold som D-297/D-298/D-299/D-300/D-301**
 * (nettverksegress blokkert denne økten, `WebFetch` mot eksterne
 * dokumentasjonsdomener bekreftet `EGRESS_BLOCKED` - se D-297): API-formen
 * under er basert på trent kunnskap om Exa sitt offentlige, nevrale søke-API,
 * IKKE en denne-økten-bekreftet kilde. Exa sender API-nøkkelen som en
 * `x-api-key`-HEADER (IKKE `Authorization: Bearer`, IKKE et body-felt som
 * Tavily). TO separate, EGNE endepunkter - `POST /search` (`web_search`) og
 * `POST /findSimilar` (`find_similar`, tar en `url` i stedet for en `query`)
 * - ULIK Tavily, som deler ETT endepunkt via et body-felt. STRUKTURELT LIK
 * Brave Search/Tavily: D-41 sitt read-only-unntak ærlig oppfylt (søke-API,
 * ingen skrivehandling).
 */
export class ExaTransport implements ToolTransport {
  private async post(path: string, body: Record<string, JsonValue>, credential: string): Promise<JsonValue> {
    const response = await fetch(`https://api.exa.ai${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": credential },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`exa_error_${response.status}`);
    return (await response.json()) as JsonValue;
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    if (action === "web_search") {
      const body: Record<string, JsonValue> = { query: String(parameters["query"]) };
      if (parameters["num_results"] !== undefined) body["numResults"] = parameters["num_results"];
      const result = await this.post("/search", body, credential);
      return { data: (result as { results?: JsonValue }).results ?? null };
    }
    if (action === "find_similar") {
      const body: Record<string, JsonValue> = { url: String(parameters["url"]) };
      if (parameters["num_results"] !== undefined) body["numResults"] = parameters["num_results"];
      const result = await this.post("/findSimilar", body, credential);
      return { data: (result as { results?: JsonValue }).results ?? null };
    }
    throw new Error(`exa_unsupported_action_${action}`);
  }
}

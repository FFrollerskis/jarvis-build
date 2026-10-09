import { createHash } from "node:crypto";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { isDriveMacroOrScriptMime, type ToolGateway } from "@jarvis/tool-gateway";
import { stripControlAndInvisible } from "./knowledge-hits.ts";
import { capCsvRows, columnLetters, quoteSheetTitle, valuesToCsv } from "./sheet-csv.ts";
import {
  KnowledgeSourceError,
  classifyToolFailure,
  type KnowledgeListResult,
  type KnowledgeRecord,
  type KnowledgeSource,
  type SkippedRecord
} from "./source.ts";

const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";

interface DriveFile {
  id: string;
  name: string;
  mime_type: string;
  modified_at: string | null;
  size_bytes: string | null;
}

/** §18: eksplisitt scope - "whole_drive" må velges bevisst, finnes ingen default. */
export type GoogleDriveScope = { kind: "folder"; folder_id: string } | { kind: "whole_drive" };

/**
 * WP-D1 (UA-2): valg for Google-dokumenttypene. Alle grenser har harde tak (en feilkonfigurasjon kan ikke gi ubegrenset minne, tid eller API-bruk).
 *  - `sheets`: `first` (standard) = Drives CSV-eksport av FØRSTE ark - krever ingen ekstra credential. `all` = ett dokument PER ARK via Sheets-API-et (`google_sheets.list_sheets`/`read_range`) -
 *    krever den dedikerte Sheets-credentialen (`JARVIS_GOOGLE_SHEETS_TOKEN`); mangler den, hoppes arkene over (beskyttet mot tombstoning) og Docs/Slides/tekst synkes som vanlig.
 *  - `max_sheet_rows`/`max_sheet_columns`: radtak og kolonnetak per ark (resten kuttes; `metadata.truncated` sier fra).
 *  - `max_sheets_per_file`: maks antall ark lest per regneark (resten rapporteres som `skipped`/`sheet_limit`).
 *  - `pace_ms`: minste pause mellom to API-kall. ToolGatewayen begrenser `drive.list_files`/`read_document` og Sheets-lesing til 20 per minutt; uten pause ville alt etter de ~20 første filene bli hoppet over
 *    (`rate_limited`) ved HVER synk. Standard 0 (ingen pause); produksjon bruker `DRIVE_PRODUCTION_PACING`.
 *  - `rate_limit_backoff_ms`: ventetid før ÉTT nytt forsøk når et kall likevel ble avvist av begrenseren. Standard 0 = ingen nytt forsøk.
 */
export interface GoogleDriveSourceOptions {
  sheets?: "first" | "all" | undefined;
  max_sheet_rows?: number | undefined;
  max_sheet_columns?: number | undefined;
  max_sheets_per_file?: number | undefined;
  pace_ms?: number | undefined;
  rate_limit_backoff_ms?: number | undefined;
}

export const DRIVE_SHEET_DEFAULTS = { max_rows: 2_000, max_columns: 50, max_sheets: 25 } as const;
/**
 * Pausen produksjonskilden bruker (registry/synk-løperen setter den): 60 s / 20 kall = 3 s per lesing, pluss litt luft. Klassens EGEN standard er 0 (ingen pause, ingen nytt forsøk) slik at kilden
 * er rask og deterministisk i tester og i engangs-kjøringer; pausen er en driftsinnstilling, ikke en del av kildens kontrakt.
 */
export const DRIVE_PRODUCTION_PACING = { pace_ms: 3_100, rate_limit_backoff_ms: 20_000 } as const;
const DRIVE_CEILINGS = { max_rows: 20_000, max_columns: 200, max_sheets: 100, pace_ms: 60_000, backoff_ms: 120_000 } as const;
const TITLE_MAX_CHARS = 200;

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

const cleanTitle = (text: string): string => {
  const cleaned = stripControlAndInvisible(text).replace(/\s+/g, " ").trim();
  return cleaned.length > TITLE_MAX_CHARS ? `${cleaned.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : cleaned;
};

/** Hvordan en fil leses. `unsupported` bærer MIME-typen som `detail` i `skipped`. */
type DriveReadKind = "doc" | "slides" | "sheet" | "text" | { unsupported: string };

/**
 * MIME-ALLOWLIST (positiv liste): Google Docs/Slides/Sheets, tekstlige MIME-typer og JSON. Alt annet - også Forms, Drawings, snarveier, Sites, Apps Script, makro-aktiverte Office-formater,
 * kjørbare filer/skript, bilder, PDF og andre binærformater - er `unsupported` og leses ALDRI (kontrollen finnes i tillegg i Drive-transporten, forsvar i dybden).
 */
export function driveReadKind(mimeType: string): DriveReadKind {
  if (isDriveMacroOrScriptMime(mimeType)) return { unsupported: "macro_or_script_denied" };
  if (mimeType === GOOGLE_DOC_MIME) return "doc";
  if (mimeType === GOOGLE_SLIDES_MIME) return "slides";
  if (mimeType === GOOGLE_SHEET_MIME) return "sheet";
  if (mimeType.startsWith("application/vnd.google-apps.")) return { unsupported: mimeType };
  if (mimeType.startsWith("text/") || mimeType === "application/json") return "text";
  return { unsupported: mimeType };
}

/**
 * UA-2 P1A §18/§25: Google Drive som kunnskapskilde - READ ONLY. Går gjennom
 * EKSISTERENDE `ToolGateway`/`GoogleDriveTransport` (samme mønster som
 * `GithubKnowledgeSource`) - ingen ny autentiseringsvei, ingen ny
 * rate-limit-mekanisme.
 *
 * Nøkkelbeslutninger (dokumentert her, ikke bare i hodet):
 * - `external_id` = Drive sin stabile `file.id` - ALDRI filnavn/sti. En
 *   omdøpning i Drive endrer `title` men IKKE `external_id`, så
 *   `KnowledgeSyncService` ser den som samme canonical document (§25
 *   "rename-stable-identity"), ikke slett+ny.
 * - Paginering skjer INNENFOR `list()` (§ kontrakt-invariant i source.ts) -
 *   alle sider av én mappe/hele driven aggregeres før retur, eller kastes
 *   `KnowledgeSourceError` hvis en side feiler midtveis. ALDRI et partielt
 *   resultat returnert som om det var fullstendig.
 * - Sletting/tombstoning: INGEN egen Google Drive Changes-API-integrasjon i
 *   P1A (bevisst, se advarselen mot overengineering i byggeordren) - i
 *   stedet gjenbrukes den eksisterende "fraværende i en VELLYKKET full
 *   listing = tombstone"-mekanismen. `list_files` spør alltid med
 *   `trashed=false`, så en papirkurv-lagt fil forsvinner naturlig fra neste
 *   listing. Dette er en DETERMINISTISK full-scan-strategi, ikke sann
 *   inkrementell sync - dokumentert bevisst valg, ikke en forglemmelse.
 * - Mappe-scope er REKURSIV (hele undertreet under `folder_id`), men
 *   IMPORTERER ALDRI hele driven når konfigurert for én mappe - `list_files`
 *   sendes alltid med et eksplisitt `folder_id`-filter i mappe-scope.
 * - WP-D1: Google Docs og Slides eksporteres til ren tekst, Sheets til CSV (se `GoogleDriveSourceOptions.sheets`: første ark via Drive-eksport, eller ett dokument per ark via Sheets-API-et), alt
 *   med størrelses- og radtak. Alt utenfor MIME-allowlisten (`driveReadKind`) hoppes over med en typet `SkippedRecord` - ALDRI lest som søppel-tekst, ALDRI stille utelatt fra rapporten.
 * - En AUTH/PERMISSION-feil på ENKELTFIL-lesing eskaleres til en kastet
 *   `KnowledgeSourceError` for HELE listingen (i stedet for å behandles som
 *   en per-fil-skip) - en slik feil indikerer typisk et systemisk problem
 *   (tilbakekalt token), og §15 krever at det ALDRI feiltolkes som at
 *   enkeltfiler er slettet. NOT_FOUND/RATE_LIMIT/TRANSIENT_NETWORK på
 *   enkeltfil-lesing er derimot trygt å behandle som en per-fil-skip
 *   (beskyttet mot tombstoning av `KnowledgeSyncService`, prøves igjen
 *   neste sync-runde). Unntak (WP-D1): feil på SHEETS-API-et (en annen credential/scope enn Drive) hopper over arkene i stedet for å felle hele listingen.
 */
export class GoogleDriveKnowledgeSource implements KnowledgeSource {
  readonly source_type = "google_drive";
  readonly source_instance_id: string;
  private readonly sheetMode: "first" | "all";
  private readonly maxSheetRows: number;
  private readonly maxSheetColumns: number;
  private readonly maxSheetsPerFile: number;
  private readonly paceMs: number;
  private readonly backoffMs: number;
  private lastCallAt = 0;

  constructor(
    private readonly toolGateway: ToolGateway,
    private readonly identity: IdentityContext,
    private readonly scope: GoogleDriveScope,
    sourceInstanceId?: string,
    options: GoogleDriveSourceOptions = {}
  ) {
    this.source_instance_id =
      sourceInstanceId ?? (scope.kind === "folder" ? `drive:${scope.folder_id}` : "drive:whole_drive");
    this.sheetMode = options.sheets === "all" ? "all" : "first";
    this.maxSheetRows = clampInt(options.max_sheet_rows, 1, DRIVE_CEILINGS.max_rows, DRIVE_SHEET_DEFAULTS.max_rows);
    this.maxSheetColumns = clampInt(options.max_sheet_columns, 1, DRIVE_CEILINGS.max_columns, DRIVE_SHEET_DEFAULTS.max_columns);
    this.maxSheetsPerFile = clampInt(options.max_sheets_per_file, 1, DRIVE_CEILINGS.max_sheets, DRIVE_SHEET_DEFAULTS.max_sheets);
    this.paceMs = clampInt(options.pace_ms, 0, DRIVE_CEILINGS.pace_ms, 0);
    this.backoffMs = clampInt(options.rate_limit_backoff_ms, 0, DRIVE_CEILINGS.backoff_ms, 0);
  }

  async list(): Promise<KnowledgeListResult> {
    const files = await this.collectFiles();
    const records: KnowledgeRecord[] = [];
    const skipped: SkippedRecord[] = [];
    const protectedPrefixes: string[] = [];

    for (const file of files) {
      const kind = driveReadKind(file.mime_type);
      if (typeof kind === "object") {
        skipped.push({ external_id: file.id, reason: "UNSUPPORTED_CONTENT", detail: kind.unsupported });
        continue;
      }

      if (kind === "sheet" && this.sheetMode === "all") {
        await this.readSheets(file, records, skipped, protectedPrefixes);
        continue;
      }

      const contentResult = await this.call("drive", "read_document", { document_id: file.id, mime_type: file.mime_type });

      if (!contentResult.ok) {
        const errorClass = classifyToolFailure(contentResult.reason);
        if (errorClass === "AUTH" || errorClass === "PERMISSION") {
          // §15: systemisk (token tilbakekalt/rettigheter endret) - eskaler til
          // total svikt i stedet for å risikere å tolke N enkeltfiler som slettet.
          throw new KnowledgeSourceError(errorClass, `drive_read_document_failed: ${contentResult.reason}`);
        }
        if (/unsupported_content|macro_or_script_denied/.test(contentResult.reason)) {
          skipped.push({ external_id: file.id, reason: "UNSUPPORTED_CONTENT", detail: file.mime_type });
          continue;
        }
        if (/content_too_large/.test(contentResult.reason)) {
          skipped.push({ external_id: file.id, reason: "UNSUPPORTED_CONTENT", detail: "too_large" });
          continue;
        }
        // NOT_FOUND (slettet mellom listing og lesing) / RATE_LIMIT / TRANSIENT_NETWORK /
        // SOURCE_UNAVAILABLE - trygt å hoppe over DENNE filen denne runden, beskyttet mot
        // tombstoning (se sync.ts), prøves igjen neste sync.
        skipped.push({ external_id: file.id, reason: errorClass, detail: contentResult.reason });
        continue;
      }

      const body = contentResult.data as { content: string; content_type: string } | undefined;
      if (!body || typeof body.content !== "string") {
        skipped.push({ external_id: file.id, reason: "SOURCE_UNAVAILABLE", detail: "empty_response" });
        continue;
      }

      let content = body.content;
      let contentType = kind === "doc" || kind === "slides" ? "text/plain" : body.content_type;
      const extra: Record<string, JsonValue> = { kind };
      if (kind === "sheet") {
        // Drive eksporterer KUN første ark som CSV. Radtaket kutter resten (sitat-bevisst: et linjeskift inni en celle er ikke en radslutt).
        const capped = capCsvRows(content, this.maxSheetRows);
        content = capped.text;
        contentType = "text/csv";
        extra["sheet_scope"] = "first_sheet";
        extra["rows"] = capped.rows;
        extra["truncated"] = capped.truncated;
      }
      if (content.includes("\u0000")) {
        // En NUL-byte kan ikke lagres som tekst i Postgres - binærinnhold merket som tekst.
        skipped.push({ external_id: file.id, reason: "UNSUPPORTED_CONTENT", detail: "binary_content" });
        continue;
      }
      if (content.trim().length === 0) {
        // Et tomt dokument har ikke noe å søke i; det blir stående som «ikke sett» (tombstones om det tidligere hadde innhold).
        continue;
      }

      records.push({
        source_type: this.source_type,
        source_instance_id: this.source_instance_id,
        external_id: file.id,
        canonical_uri: `https://drive.google.com/file/d/${file.id}/view`,
        title: cleanTitle(file.name),
        content,
        content_type: contentType,
        content_hash: createHash("sha256").update(content).digest("hex"),
        modified_at: file.modified_at,
        metadata: { mime_type: file.mime_type, drive_file_id: file.id, size_bytes: file.size_bytes ?? null, ...extra } as Record<string, JsonValue>
      });
    }

    return { records, skipped, ...(protectedPrefixes.length > 0 ? { protected_prefixes: protectedPrefixes } : {}) };
  }

  /**
   * WP-D1: ett dokument PER ARK (`external_id` = `<fil-id>#<ark-id>`). Arklisten og hvert ark leses via Sheets-API-et med radtak/kolonnetak i selve områdespørringen (API-et returnerer aldri mer enn
   * taket). Feil her er ALDRI total svikt: Sheets bruker en egen credential og scope, så manglende/ugyldig Sheets-token skal ikke stoppe Docs/Slides/tekst. I stedet beskyttes alt som tilhører regnearket
   * mot tombstoning (`protected_prefixes` når arklisten ikke kunne leses, ellers eksakt id per ark som ikke kunne leses).
   */
  private async readSheets(file: DriveFile, records: KnowledgeRecord[], skipped: SkippedRecord[], protectedPrefixes: string[]): Promise<void> {
    const prefix = `${file.id}#`;
    const listed = await this.call("google_sheets", "list_sheets", { spreadsheet_id: file.id });
    if (!listed.ok) {
      protectedPrefixes.push(prefix);
      skipped.push({ external_id: file.id, reason: classifyToolFailure(listed.reason), detail: `sheets_list_failed: ${listed.reason}`.slice(0, 160) });
      return;
    }
    const sheets = parseSheetList(listed.data);
    if (sheets === null) {
      protectedPrefixes.push(prefix);
      skipped.push({ external_id: file.id, reason: "SOURCE_UNAVAILABLE", detail: "sheets_list_bad_response" });
      return;
    }
    const lastColumn = columnLetters(this.maxSheetColumns);
    for (const [index, sheet] of sheets.entries()) {
      const externalId = `${file.id}#${sheet.sheet_id}`;
      if (index >= this.maxSheetsPerFile) {
        skipped.push({ external_id: externalId, reason: "UNSUPPORTED_CONTENT", detail: "sheet_limit" });
        continue;
      }
      // +1 rad: er det flere rader enn taket, vet vi at arket ble kuttet.
      const range = `${quoteSheetTitle(sheet.title)}!A1:${lastColumn}${this.maxSheetRows + 1}`;
      const read = await this.call("google_sheets", "read_range", { spreadsheet_id: file.id, range });
      if (!read.ok) {
        skipped.push({ external_id: externalId, reason: classifyToolFailure(read.reason), detail: `sheets_read_failed: ${read.reason}`.slice(0, 160) });
        continue;
      }
      const csv = valuesToCsv(read.data, this.maxSheetRows, this.maxSheetColumns);
      // Et tomt ark gir ikke noe dokument (og et tidligere indeksert innhold i arket tombstones).
      if (csv.rows === 0) continue;
      if (csv.text.includes("\u0000")) {
        skipped.push({ external_id: externalId, reason: "UNSUPPORTED_CONTENT", detail: "binary_content" });
        continue;
      }
      records.push({
        source_type: this.source_type,
        source_instance_id: this.source_instance_id,
        external_id: externalId,
        canonical_uri: `https://docs.google.com/spreadsheets/d/${file.id}/edit#gid=${sheet.sheet_id}`,
        title: cleanTitle(`${file.name} - ${sheet.title}`),
        content: csv.text,
        content_type: "text/csv",
        content_hash: createHash("sha256").update(csv.text).digest("hex"),
        modified_at: file.modified_at,
        metadata: {
          mime_type: file.mime_type, drive_file_id: file.id, size_bytes: file.size_bytes ?? null, kind: "sheet", sheet_scope: "sheet", sheet_id: sheet.sheet_id, rows: csv.rows, truncated: csv.truncated
        } as Record<string, JsonValue>
      });
    }
  }

  /**
   * Ett ToolGateway-kall med pause mellom kallene (se `pace_ms`) og ÉTT nytt forsøk etter en ventetid hvis begrenseren likevel avviste kallet. Pausen er KUN for lesing av innhold;
   * `list_files` (sidevis, få kall) går gjennom samme metode og får samme pause.
   */
  private async call(toolId: "drive" | "google_sheets", action: string, parameters: Record<string, JsonValue>): Promise<{ ok: true; data: JsonValue | undefined } | { ok: false; reason: string }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.pace();
      const result = await this.toolGateway.execute({ identity: this.identity, tool_id: toolId, action, parameters });
      if (result.ok) return { ok: true, data: result.data as JsonValue | undefined };
      if (attempt === 0 && classifyToolFailure(result.reason) === "RATE_LIMIT" && this.backoffMs > 0) {
        await sleep(this.backoffMs);
        continue;
      }
      return { ok: false, reason: result.reason };
    }
    return { ok: false, reason: "rate_limited" };
  }

  private async pace(): Promise<void> {
    if (this.paceMs > 0) {
      const wait = this.lastCallAt + this.paceMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    this.lastCallAt = Date.now();
  }

  /**
   * §18: aggregerer ALLE sider av mappe-scope (rekursivt undertre) eller hele
   * driven, INNENFOR `list()` (se kontrakt-invariant i source.ts). Kaster
   * `KnowledgeSourceError` hvis noen side feiler - ALDRI et partielt resultat.
   */
  private async collectFiles(): Promise<DriveFile[]> {
    if (this.scope.kind === "whole_drive") {
      return this.paginateFolder(undefined);
    }
    const files: DriveFile[] = [];
    const foldersToVisit = [this.scope.folder_id];
    const visited = new Set<string>();
    while (foldersToVisit.length > 0) {
      const folderId = foldersToVisit.shift();
      if (!folderId || visited.has(folderId)) continue;
      visited.add(folderId);
      const items = await this.paginateFolder(folderId);
      for (const item of items) {
        if (item.mime_type === GOOGLE_FOLDER_MIME) {
          foldersToVisit.push(item.id);
        } else {
          files.push(item);
        }
      }
    }
    return files;
  }

  private async paginateFolder(folderId: string | undefined): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const result = await this.call("drive", "list_files", { ...(folderId ? { folder_id: folderId } : {}), ...(pageToken ? { page_token: pageToken } : {}) });
      if (!result.ok) {
        throw new KnowledgeSourceError(classifyToolFailure(result.reason), `drive_list_files_failed: ${result.reason}`);
      }
      const body = result.data as { files: DriveFile[]; next_page_token: string | null } | undefined;
      if (body) {
        files.push(...body.files);
        pageToken = body.next_page_token ?? undefined;
      } else {
        pageToken = undefined;
      }
    } while (pageToken);
    return files;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Arklisten fra `google_sheets.list_sheets`: `[{ title, sheet_id }]`. Ugyldig form = `null` (aldri en gjetning). Dupliserte/ugyldige ark-id-er forkastes. */
function parseSheetList(data: JsonValue | undefined): Array<{ title: string; sheet_id: number }> | null {
  if (!Array.isArray(data)) return null;
  const out: Array<{ title: string; sheet_id: number }> = [];
  const seen = new Set<number>();
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const title = (entry as Record<string, unknown>)["title"];
    const sheetId = (entry as Record<string, unknown>)["sheet_id"];
    if (typeof title !== "string" || title.length === 0 || title.length > 100) continue; // Sheets begrenser arknavn til 100 tegn; alt annet er ikke et ekte ark
    if (typeof sheetId !== "number" || !Number.isInteger(sheetId) || sheetId < 0 || seen.has(sheetId)) continue;
    seen.add(sheetId);
    out.push({ title, sheet_id: sheetId });
  }
  return out;
}

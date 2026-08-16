import { createHash } from "node:crypto";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import {
  KnowledgeSourceError,
  classifyToolFailure,
  type KnowledgeListResult,
  type KnowledgeRecord,
  type KnowledgeSource,
  type SkippedRecord
} from "./source.ts";

const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_DOC_EXPORT_MIME = "application/vnd.google-apps.document";

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
 * - Ustøttet innhold (Sheets/Slides/Forms/bilder/PDF/binærformater) hoppes
 *   over med en typet `SkippedRecord` - ALDRI lest som søppel-tekst, ALDRI
 *   stille utelatt fra rapporten.
 * - En AUTH/PERMISSION-feil på ENKELTFIL-lesing eskaleres til en kastet
 *   `KnowledgeSourceError` for HELE listingen (i stedet for å behandles som
 *   en per-fil-skip) - en slik feil indikerer typisk et systemisk problem
 *   (tilbakekalt token), og §15 krever at det ALDRI feiltolkes som at
 *   enkeltfiler er slettet. NOT_FOUND/RATE_LIMIT/TRANSIENT_NETWORK på
 *   enkeltfil-lesing er derimot trygt å behandle som en per-fil-skip
 *   (beskyttet mot tombstoning av `KnowledgeSyncService`, prøves igjen
 *   neste sync-runde).
 */
export class GoogleDriveKnowledgeSource implements KnowledgeSource {
  readonly source_type = "google_drive";
  readonly source_instance_id: string;

  constructor(
    private readonly toolGateway: ToolGateway,
    private readonly identity: IdentityContext,
    private readonly scope: GoogleDriveScope,
    sourceInstanceId?: string
  ) {
    this.source_instance_id =
      sourceInstanceId ?? (scope.kind === "folder" ? `drive:${scope.folder_id}` : "drive:whole_drive");
  }

  async list(): Promise<KnowledgeListResult> {
    const files = await this.collectFiles();
    const records: KnowledgeRecord[] = [];
    const skipped: SkippedRecord[] = [];

    for (const file of files) {
      if (!this.isReadableMime(file.mime_type)) {
        skipped.push({ external_id: file.id, reason: "UNSUPPORTED_CONTENT", detail: file.mime_type });
        continue;
      }

      const contentResult = await this.toolGateway.execute({
        identity: this.identity, tool_id: "drive", action: "read_document",
        parameters: { document_id: file.id, mime_type: file.mime_type }
      });

      if (!contentResult.ok) {
        const errorClass = classifyToolFailure(contentResult.reason);
        if (errorClass === "AUTH" || errorClass === "PERMISSION") {
          // §15: systemisk (token tilbakekalt/rettigheter endret) - eskaler til
          // total svikt i stedet for å risikere å tolke N enkeltfiler som slettet.
          throw new KnowledgeSourceError(errorClass, `drive_read_document_failed: ${contentResult.reason}`);
        }
        if (/unsupported_content/.test(contentResult.reason)) {
          skipped.push({ external_id: file.id, reason: "UNSUPPORTED_CONTENT", detail: file.mime_type });
          continue;
        }
        // NOT_FOUND (slettet mellom listing og lesing) / RATE_LIMIT / TRANSIENT_NETWORK /
        // SOURCE_UNAVAILABLE - trygt å hoppe over DENNE filen denne runden, beskyttet mot
        // tombstoning (se sync.ts), prøves igjen neste sync.
        skipped.push({ external_id: file.id, reason: errorClass, detail: contentResult.reason });
        continue;
      }

      const body = contentResult.data as { content: string; content_type: string } | undefined;
      if (!body) {
        skipped.push({ external_id: file.id, reason: "SOURCE_UNAVAILABLE", detail: "empty_response" });
        continue;
      }

      records.push({
        source_type: this.source_type,
        source_instance_id: this.source_instance_id,
        external_id: file.id,
        canonical_uri: `https://drive.google.com/file/d/${file.id}/view`,
        title: file.name,
        content: body.content,
        content_type: file.mime_type === GOOGLE_DOC_EXPORT_MIME ? "text/plain" : body.content_type,
        content_hash: createHash("sha256").update(body.content).digest("hex"),
        modified_at: file.modified_at,
        metadata: { mime_type: file.mime_type, drive_file_id: file.id, size_bytes: file.size_bytes ?? null } as Record<string, JsonValue>
      });
    }

    return { records, skipped };
  }

  /** Google Docs (eksporteres) + tekstlige MIME-typer. Andre Google-native typer og binærformater er IKKE lesbare i P1A. */
  private isReadableMime(mimeType: string): boolean {
    if (mimeType === GOOGLE_DOC_EXPORT_MIME) return true;
    if (mimeType.startsWith("application/vnd.google-apps.")) return false;
    return mimeType.startsWith("text/") || mimeType === "application/json";
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
      const result = await this.toolGateway.execute({
        identity: this.identity, tool_id: "drive", action: "list_files",
        parameters: { ...(folderId ? { folder_id: folderId } : {}), ...(pageToken ? { page_token: pageToken } : {}) }
      });
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

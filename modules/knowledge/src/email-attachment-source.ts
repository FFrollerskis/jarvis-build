import { createHash } from "node:crypto";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import {
  EXTRACTION_TIMEOUT_MS,
  assertWithinPageLimit,
  assertWithinSizeLimit,
  classifyFileKind,
  decideExtractionTier,
  sanitizeAttachmentFilename
} from "./extraction-safety.ts";
import type { ImageInput, OcrProvider, VisionDescriptionProvider } from "./ocr-provider.ts";
import { PdfExtractor } from "./pdf-extraction.ts";
import {
  KnowledgeSourceError,
  classifyToolFailure,
  type KnowledgeListResult,
  type KnowledgeRecord,
  type KnowledgeSource,
  type SkippedRecord
} from "./source.ts";

interface GmailAttachmentSummary {
  attachment_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

interface GmailMessageSummary {
  id: string;
  thread: string;
  from: string;
  subject: string;
  at: string;
  body_text: string;
  attachments: GmailAttachmentSummary[];
  account: string;
}

/** §7: en attachment-utvinning som henger (nettverk/modell) skal ALDRI blokkere resten av synkroniseringen på ubestemt tid. */
async function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * UA-2 P1B-A: e-post-vedlegg + OCR/vision som kunnskapskilde - går gjennom
 * EKSISTERENDE `ToolGateway`/`GmailTransport` (samme mønster som
 * `GoogleDriveKnowledgeSource`/`GithubKnowledgeSource`) - ingen ny
 * autentiseringsvei (gjenbruker `JARVIS_EMAIL_TOKEN`, se §2/D-43).
 *
 * Nøkkelbeslutninger (D-43/D-44, dokumentert her - ikke bare i hodet):
 * - `external_id`-skjema (side-granulær "chunking" UTEN ny tabell, D-43 §2):
 *   `msg:<message_id>` for selve e-postteksten, `att:<message_id>:
 *   <attachment_id>` for et ikke-paginert vedlegg (tekst/bilde),
 *   `att:<message_id>:<attachment_id>:page:<n>` for HVER PDF-side. En
 *   endring i sideantall ved neste sync tombstoner automatisk de sidene som
 *   ikke lenger finnes - ren gjenbruk av `KnowledgeSyncService` sin
 *   eksisterende "fraværende i vellykket listing = tombstone"-mekanisme.
 * - Routing (D-43 §1/D-44): native tekst-lag FØRST (ingen modellkall);
 *   under terskelen → OCR (`ocr.transcribeText()`); OCR uten treff → vision-
 *   beskrivelse (`ocr.describeImage()`) som siste fallback. PDF-sider rastres
 *   KUN når native tekst er utilstrekkelig (se D-44 for `pdf-parse`-valget).
 * - Fail-closed (§7): størrelse/side/tidsgrenser håndheves FØR/RUNDT enhver
 *   ekstraksjon (`extraction-safety.ts`); arkiver/docx/xlsx/pptx hoppes over
 *   som `UNSUPPORTED_CONTENT` (ALDRI åpnet/utpakket - ingen archive-
 *   rekursjon); filnavn saneres (`sanitizeAttachmentFilename`) FØR bruk i
 *   metadata (path-traversal-vern - ingen fil skrives faktisk til disk her,
 *   men navnet kan senere brukes av en kaller til akkurat det).
 * - Per-vedlegg/per-side feilisolasjon (§`processAttachment`/side-løkken i
 *   `extractPdf`): ÉN korrupt/utidsavbrutt fil eller side blir en
 *   `SkippedRecord` - stopper ALDRI resten av meldingen/postkassen.
 * - AUTH/PERMISSION på `read_attachment`/`list_messages` eskaleres til
 *   `KnowledgeSourceError` for HELE listingen (samme §15-mønster som
 *   `GoogleDriveKnowledgeSource` - en slik feil er typisk systemisk, ALDRI
 *   tolket som at vedlegg/meldinger faktisk er slettet).
 */
export class EmailAttachmentKnowledgeSource implements KnowledgeSource {
  readonly source_type = "email_attachment";
  readonly source_instance_id: string;

  constructor(
    private readonly toolGateway: ToolGateway,
    private readonly identity: IdentityContext,
    private readonly ocr: OcrProvider & VisionDescriptionProvider,
    sourceInstanceId?: string,
    private readonly listParams: { max?: number; query?: string } = {}
  ) {
    this.source_instance_id = sourceInstanceId ?? "email:inbox";
  }

  async list(): Promise<KnowledgeListResult> {
    const messages = await this.fetchMessages();
    const records: KnowledgeRecord[] = [];
    const skipped: SkippedRecord[] = [];

    for (const message of messages) {
      if (message.body_text.trim().length > 0) {
        records.push(
          this.buildTextRecord(
            message,
            `msg:${message.id}`,
            this.canonicalUri(message.id),
            message.subject || "(uten emne)",
            message.body_text,
            "text/plain",
            { kind: "email_body", message_id: message.id, thread_id: message.thread, from: message.from }
          )
        );
      }
      for (const attachment of message.attachments) {
        const outcome = await this.processAttachment(message, attachment);
        records.push(...outcome.records);
        skipped.push(...outcome.skipped);
      }
    }
    return { records, skipped };
  }

  private canonicalUri(messageId: string): string {
    return `https://mail.google.com/mail/u/0/#all/${messageId}`;
  }

  private async fetchMessages(): Promise<GmailMessageSummary[]> {
    const result = await this.toolGateway.execute({
      identity: this.identity, tool_id: "email", action: "list_messages",
      parameters: { max: this.listParams.max ?? 15, ...(this.listParams.query ? { query: this.listParams.query } : {}) }
    });
    if (!result.ok) {
      throw new KnowledgeSourceError(classifyToolFailure(result.reason), `email_list_messages_failed: ${result.reason}`);
    }
    const body = result.data as { messages: GmailMessageSummary[] } | undefined;
    return body?.messages ?? [];
  }

  private buildTextRecord(
    message: GmailMessageSummary, externalId: string, canonicalUri: string, title: string,
    content: string, contentType: string, metadata: Record<string, JsonValue>
  ): KnowledgeRecord {
    return {
      source_type: this.source_type, source_instance_id: this.source_instance_id,
      external_id: externalId, canonical_uri: canonicalUri, title, content, content_type: contentType,
      content_hash: createHash("sha256").update(content).digest("hex"), modified_at: message.at, metadata
    };
  }

  private async processAttachment(
    message: GmailMessageSummary, attachment: GmailAttachmentSummary
  ): Promise<{ records: KnowledgeRecord[]; skipped: SkippedRecord[] }> {
    const baseExternalId = `att:${message.id}:${attachment.attachment_id}`;
    const safeFilename = sanitizeAttachmentFilename(attachment.filename);
    const kind = classifyFileKind(attachment.mime_type);

    if (kind === "unsupported" || kind === "unsupported_archive" || kind === "unsupported_office") {
      return { records: [], skipped: [{ external_id: baseExternalId, reason: "UNSUPPORTED_CONTENT", detail: `${kind}:${attachment.mime_type}` }] };
    }

    try {
      assertWithinSizeLimit(attachment.size_bytes, safeFilename);
    } catch (err) {
      return { records: [], skipped: [{ external_id: baseExternalId, reason: "UNSUPPORTED_CONTENT", detail: (err as Error).message }] };
    }

    try {
      return await withTimeout(
        this.extractAttachment(message, attachment, baseExternalId, safeFilename, kind),
        EXTRACTION_TIMEOUT_MS,
        `attachment_extraction_timeout:${baseExternalId}`
      );
    } catch (err) {
      // §15-mønster: en systemisk AUTH/PERMISSION-feil skal ALDRI fanges som en per-vedlegg-skip.
      if (err instanceof KnowledgeSourceError) throw err;
      return { records: [], skipped: [{ external_id: baseExternalId, reason: "SOURCE_UNAVAILABLE", detail: (err as Error).message.slice(0, 200) }] };
    }
  }

  private async extractAttachment(
    message: GmailMessageSummary, attachment: GmailAttachmentSummary,
    baseExternalId: string, safeFilename: string, kind: "text" | "pdf" | "image"
  ): Promise<{ records: KnowledgeRecord[]; skipped: SkippedRecord[] }> {
    const downloadResult = await this.toolGateway.execute({
      identity: this.identity, tool_id: "email", action: "read_attachment",
      parameters: { message_id: message.id, attachment_id: attachment.attachment_id }
    });
    if (!downloadResult.ok) {
      const errorClass = classifyToolFailure(downloadResult.reason);
      if (errorClass === "AUTH" || errorClass === "PERMISSION") {
        throw new KnowledgeSourceError(errorClass, `email_read_attachment_failed: ${downloadResult.reason}`);
      }
      return { records: [], skipped: [{ external_id: baseExternalId, reason: errorClass, detail: downloadResult.reason }] };
    }
    const body = downloadResult.data as { content_base64: string; size_bytes: number } | undefined;
    if (!body?.content_base64) {
      return { records: [], skipped: [{ external_id: baseExternalId, reason: "SOURCE_UNAVAILABLE", detail: "empty_attachment_body" }] };
    }
    const bytes = Buffer.from(body.content_base64, "base64");
    const commonMetadata: Record<string, JsonValue> = {
      message_id: message.id, thread_id: message.thread, from: message.from,
      filename: safeFilename, mime_type: attachment.mime_type
    };

    if (kind === "text") {
      const text = bytes.toString("utf8");
      return {
        records: [this.buildTextRecord(message, baseExternalId, this.canonicalUri(message.id), safeFilename, text, attachment.mime_type, {
          ...commonMetadata, kind: "email_attachment", extraction_method: "native"
        })],
        skipped: []
      };
    }

    if (kind === "image") {
      const image: ImageInput = { media_type: attachment.mime_type, data: body.content_base64 };
      const { text, method } = await this.extractFromImage(image);
      if (text.trim().length === 0) {
        return { records: [], skipped: [{ external_id: baseExternalId, reason: "UNSUPPORTED_CONTENT", detail: "vision_no_content_found" }] };
      }
      return {
        records: [this.buildTextRecord(message, baseExternalId, this.canonicalUri(message.id), safeFilename, text, "text/plain", {
          ...commonMetadata, kind: "email_attachment", extraction_method: method
        })],
        skipped: []
      };
    }

    return this.extractPdf(message, attachment, baseExternalId, safeFilename, bytes, commonMetadata);
  }

  /** OCR FØRST (transkriber synlig tekst); vision-beskrivelse KUN som fallback når OCR ikke fant meningsfull tekst (D-43 §1). */
  private async extractFromImage(image: ImageInput): Promise<{ text: string; method: "ocr" | "vision" }> {
    const transcribed = await this.ocr.transcribeText(image);
    if (transcribed.trim().length > 0) return { text: transcribed, method: "ocr" };
    const description = await this.ocr.describeImage(image);
    return { text: description, method: "vision" };
  }

  private async extractPdf(
    message: GmailMessageSummary, attachment: GmailAttachmentSummary,
    baseExternalId: string, safeFilename: string, bytes: Buffer, commonMetadata: Record<string, JsonValue>
  ): Promise<{ records: KnowledgeRecord[]; skipped: SkippedRecord[] }> {
    const extractor = new PdfExtractor(bytes);
    try {
      const pageCount = await extractor.pageCount();
      try {
        assertWithinPageLimit(pageCount, safeFilename);
      } catch (err) {
        return { records: [], skipped: [{ external_id: baseExternalId, reason: "UNSUPPORTED_CONTENT", detail: (err as Error).message }] };
      }

      const nativeTextByPage = await extractor.nativeTextByPage();
      const records: KnowledgeRecord[] = [];
      const skipped: SkippedRecord[] = [];

      for (let page = 1; page <= pageCount; page++) {
        const pageExternalId = `${baseExternalId}:page:${page}`;
        const nativeText = nativeTextByPage.get(page) ?? "";
        const tier = decideExtractionTier(nativeText);

        if (tier === "native") {
          records.push(this.buildTextRecord(message, pageExternalId, this.canonicalUri(message.id), `${safeFilename} (side ${page})`, nativeText, "text/plain", {
            ...commonMetadata, kind: "email_attachment_page", page, extraction_method: "native"
          }));
          continue;
        }

        // §7-per-side-isolasjon: én dårlig side (rendering-/OCR-/vision-feil) hopper KUN over DEN siden.
        try {
          const image = await extractor.renderPageToImage(page);
          const { text, method } = await this.extractFromImage(image);
          if (text.trim().length === 0) {
            skipped.push({ external_id: pageExternalId, reason: "UNSUPPORTED_CONTENT", detail: "vision_no_content_found" });
            continue;
          }
          records.push(this.buildTextRecord(message, pageExternalId, this.canonicalUri(message.id), `${safeFilename} (side ${page})`, text, "text/plain", {
            ...commonMetadata, kind: "email_attachment_page", page, extraction_method: method
          }));
        } catch (err) {
          skipped.push({ external_id: pageExternalId, reason: "SOURCE_UNAVAILABLE", detail: (err as Error).message.slice(0, 200) });
        }
      }
      return { records, skipped };
    } finally {
      await extractor.destroy();
    }
  }
}

/**
 * UA-2 P1B-A §3/§7: rene, deterministiske bygge-blokker for e-post-vedlegg-
 * ingestion - fil-typeklassifisering, fail-closed grenser (størrelse/sider),
 * native→OCR/vision-routing-beslutning, og trygg filnavn-sanering (mot
 * path traversal). INGEN nettverk/filsystem/modellkall her - alt er rene
 * funksjoner, testbare uten mocks (samme stil som `source.ts` sin
 * `classifyToolFailure`).
 */

export type FileKind = "text" | "pdf" | "image" | "unsupported_archive" | "unsupported_office" | "unsupported";

const TEXT_MIME_TYPES = new Set([
  "text/plain", "text/markdown", "text/x-markdown", "text/csv", "application/json", "text/html", "text/css",
  "application/x-yaml", "text/yaml"
]);

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/tiff", "image/bmp"]);

/** §3: arkivformater eksplisitt UTELUKKET - ALDRI åpnet/utpakket (ingen archive-rekursjon, uansett fremtidig behov). */
const ARCHIVE_MIME_TYPES = new Set([
  "application/zip", "application/x-zip-compressed", "application/x-rar-compressed", "application/vnd.rar",
  "application/x-7z-compressed", "application/gzip", "application/x-gzip", "application/x-tar", "application/x-bzip2"
]);

/** §3/D-43 §4: docx/xlsx/pptx EKSPLISITT vurdert og UTSATT denne runden (IKKE stille utelatt - se D-43). */
const OFFICE_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"
]);

/** Deterministisk, kun basert på MIME-type (ALDRI filendelse alene - en ondsinnet/feilmerket vedleggsnavn skal ikke kunne endre klassifisering). */
export function classifyFileKind(mimeType: string): FileKind {
  const normalized = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  if (normalized === "application/pdf") return "pdf";
  if (IMAGE_MIME_TYPES.has(normalized) || normalized.startsWith("image/")) return "image";
  if (ARCHIVE_MIME_TYPES.has(normalized)) return "unsupported_archive";
  if (OFFICE_MIME_TYPES.has(normalized)) return "unsupported_office";
  if (TEXT_MIME_TYPES.has(normalized) || normalized.startsWith("text/")) return "text";
  return "unsupported";
}

/** §7: fail-closed grenser - dokumenterte, bevisste tall (ikke ubegrenset "beste innsats"). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB
export const MAX_PAGES_PER_ATTACHMENT = 50;
export const EXTRACTION_TIMEOUT_MS = 60_000;

export class AttachmentTooLargeError extends Error {
  constructor(
    readonly filename: string,
    readonly sizeBytes: number
  ) {
    super(`attachment_too_large: ${filename} (${sizeBytes} bytes > ${MAX_ATTACHMENT_BYTES})`);
    this.name = "AttachmentTooLargeError";
  }
}

export class TooManyPagesError extends Error {
  constructor(
    readonly filename: string,
    readonly pageCount: number
  ) {
    super(`too_many_pages: ${filename} (${pageCount} sider > ${MAX_PAGES_PER_ATTACHMENT})`);
    this.name = "TooManyPagesError";
  }
}

export function assertWithinSizeLimit(sizeBytes: number, filename: string): void {
  if (sizeBytes > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(filename, sizeBytes);
}

export function assertWithinPageLimit(pageCount: number, filename: string): void {
  if (pageCount > MAX_PAGES_PER_ATTACHMENT) throw new TooManyPagesError(filename, pageCount);
}

/**
 * §5/D-43 §1: deterministisk native→bilde-ekstraksjon-beslutning. En side med
 * NOK ekte, native tekst (over terskelen) trenger ALDRI et modellkall - kun
 * sider med for lite/ingen native tekst rutes videre til OCR (og, dersom OCR
 * selv ikke finner meningsfull tekst, videre til en generell vision-
 * beskrivelse - den ESKALERINGEN skjer i `EmailAttachmentKnowledgeSource`
 * basert på det FAKTISKE OCR-resultatet, ikke her, siden denne funksjonen
 * kun har statisk informasjon tilgjengelig FØR noe modellkall er gjort).
 */
export const NATIVE_TEXT_MIN_CHARS = 40;
export type ExtractionTier = "native" | "needs_image_extraction";

export function decideExtractionTier(nativeText: string): ExtractionTier {
  return nativeText.trim().length >= NATIVE_TEXT_MIN_CHARS ? "native" : "needs_image_extraction";
}

/**
 * §7 (path traversal): et vedleggsnavn er UBETRODD (kommer fra en ekstern
 * avsenders MIME-header) - denne funksjonen fjerner ALLE katalogkomponenter
 * (både `/` og `\`, uansett OS), null-bytes, og degenererte navn (`.`/`..`/
 * tomt) FØR navnet noensinne brukes til å konstruere en fil-sti. Kalleren
 * skal ALLTID kombinere resultatet med et `mkdtemp()`-generert, tilfeldig
 * katalognavn - denne funksjonen alene garanterer IKKE et trygt absolutt
 * mål, kun at selve navnet ikke kan "hoppe ut" av en gitt katalog.
 */
export function sanitizeAttachmentFilename(filename: string): string {
  const lastSegment = filename.split(/[/\\]/).filter((s) => s.length > 0).pop() ?? "";
  const noNulls = lastSegment.replace(/\0/g, "").trim();
  if (noNulls.length === 0 || noNulls === "." || noNulls === "..") return "vedlegg";
  return noNulls.slice(0, 200);
}

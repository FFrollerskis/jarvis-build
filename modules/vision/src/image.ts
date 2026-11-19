import { createHash } from "node:crypto";

/**
 * WP-G3 (D-465): validering av ETT kamerabilde (øyeblikksbilde) før noe annet skjer med det.
 *
 * Bildebytes fra en kilde (Home Assistant `camera_proxy`, en enhetssignert opplasting) er UBETRODD data (CLAUDE.md regel 7): kilden
 * kan være feilkonfigurert, kompromittert eller sende noe som ikke er et bilde (HTML, SVG med skript, en lastebombe). Her
 * avgjøres derfor, deterministisk og uten å stole på `content-type`-headeren alene:
 *   - media type utledes av BYTENE (magic bytes) og må være JPEG, PNG eller WebP (ingen SVG, GIF, HTML eller andre formater),
 *   - størrelsen har en hard øvre grense (standard 5 MiB; aldri over 20 MiB, som også er DB-CHECK i 134) - ett øyeblikksbilde, ikke video,
 *   - sha256 beregnes av de samme bytene (integritet, revisjon og signaturbinding for enhetsopplasting).
 * Funksjonen leser aldri pikseldata og dekoder ingenting (ingen bildebibliotek = ingen dekoder-angrepsflate i denne prosessen);
 * selve visjonsmodellen sitter bak lokal modell-adapter. Et bilde som ikke består gir en typet feil med en kort, stabil kode.
 */
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ABSOLUTE_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export type SnapshotMediaType = "image/jpeg" | "image/png" | "image/webp";

export class VisionImageError extends Error {
  constructor(readonly code: "empty" | "too_large" | "unsupported_format" | "content_type_mismatch") {
    super(`vision_image_invalid:${code}`);
    this.name = "VisionImageError";
  }
}

export interface InspectedImage {
  media_type: SnapshotMediaType;
  byte_length: number;
  sha256: string;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

export function sniffMediaType(bytes: Uint8Array): SnapshotMediaType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // WebP: "RIFF" <4 bytes størrelse> "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/**
 * `declaredType` er hva kilden SA (HTTP content-type eller en signert opplastingsfelt). Den brukes kun som en konsistenssjekk
 * mot bytene: avviker den fra det bytene viser, avvises bildet (en kilde som sier «image/png» men leverer JPEG er enten
 * feilkonfigurert eller forsøker noe). `maxBytes` kan senkes av kalleren, aldri heves over `ABSOLUTE_MAX_IMAGE_BYTES`.
 */
export function inspectImage(bytes: Uint8Array, options: { maxBytes?: number; declaredType?: string | undefined } = {}): InspectedImage {
  const maxBytes = Math.min(options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES, ABSOLUTE_MAX_IMAGE_BYTES);
  if (bytes.length === 0) throw new VisionImageError("empty");
  if (bytes.length > maxBytes) throw new VisionImageError("too_large");
  const media_type = sniffMediaType(bytes);
  if (media_type === null) throw new VisionImageError("unsupported_format");
  if (options.declaredType !== undefined) {
    const declared = options.declaredType.split(";")[0]?.trim().toLowerCase() ?? "";
    // «image/jpg» er en vanlig feilstavet variant av image/jpeg og regnes som det samme.
    const normalized = declared === "image/jpg" ? "image/jpeg" : declared;
    if (normalized !== media_type) throw new VisionImageError("content_type_mismatch");
  }
  return { media_type, byte_length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Leser en HTTP-kropp med HARD bytegrense (avbryter strømmen ved overskridelse). En kilde som sender en endeløs eller svært stor kropp
 * kan aldri fylle minnet: lesingen stopper ved grensen + 1 byte og feiler lukket.
 */
export async function readBodyLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new VisionImageError("too_large");
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new VisionImageError("too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

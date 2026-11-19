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
 *   - mål (bredde/høyde) leses fra BILDEHODET (PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X) og har en grense (review A-L6): et lite PNG/JPEG kan deklarere enorme mål og velte den LOKALE modellserveren
 *     når den dekoder det (en «pikselbombe»). Mål som ikke kan leses = avvist (fail-closed).
 * Funksjonen leser aldri pikseldata og dekoder ingenting (ingen bildebibliotek = ingen dekoder-angrepsflate i denne prosessen; kun et par bytes i hodet leses, med grensesjekk);
 * selve visjonsmodellen sitter bak lokal modell-adapter. Et bilde som ikke består gir en typet feil med en kort, stabil kode.
 */
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ABSOLUTE_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Største side og største antall piksler (review A-L6). 8192 x 6048 (48 MP) består; 8192 x 8192 og enhver side over 8192 avvises. */
export const MAX_IMAGE_SIDE = 8192;
export const MAX_IMAGE_PIXELS = 50_000_000;

export type SnapshotMediaType = "image/jpeg" | "image/png" | "image/webp";

export class VisionImageError extends Error {
  constructor(readonly code: "empty" | "too_large" | "unsupported_format" | "content_type_mismatch" | "dimensions_unreadable" | "dimensions_too_large") {
    super(`vision_image_invalid:${code}`);
    this.name = "VisionImageError";
  }
}

export interface InspectedImage {
  media_type: SnapshotMediaType;
  byte_length: number;
  sha256: string;
  /** Mål lest fra bildehodet (aldri fra pikseldata). */
  width: number;
  height: number;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, o: number): number => ((b[o] as number) << 8) | (b[o + 1] as number);
const u16le = (b: Uint8Array, o: number): number => (b[o] as number) | ((b[o + 1] as number) << 8);
const u24le = (b: Uint8Array, o: number): number => (b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16);
const u32be = (b: Uint8Array, o: number): number => (b[o] as number) * 0x1000000 + (((b[o + 1] as number) << 16) | ((b[o + 2] as number) << 8) | (b[o + 3] as number));
const u32le = (b: Uint8Array, o: number): number => ((b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16) | ((b[o + 3] as number) << 24)) >>> 0;

/** JPEG SOF-markører som bærer mål (alle med lengde; C4 = DHT, C8 = reservert og CC = DAC er IKKE SOF). */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  // signatur (8) + chunk-lengde (4) + «IHDR» (4) + bredde (4) + høyde (4) = 24 bytes
  if (bytes.length < 24 || !startsWith(bytes, [0x49, 0x48, 0x44, 0x52], 12)) return null;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  let i = 2; // etter SOI (FF D8)
  for (let guard = 0; guard < 4096 && i + 4 <= bytes.length; guard += 1) {
    if (bytes[i] !== 0xff) return null;
    while (bytes[i + 1] === 0xff && i + 2 < bytes.length) i += 1; // fyllbytes før markøren
    const marker = bytes[i + 1] as number;
    if (marker === 0x00) return null; // stuffet byte hører hjemme i bildedata, ikke i markørlaget
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // frittstående markør (ingen lengde)
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI/SOS uten at en SOF er sett: ingen mål å lese
    const length = u16be(bytes, i + 2);
    if (length < 2) return null;
    if (JPEG_SOF.has(marker)) {
      if (length < 8 || i + 9 > bytes.length) return null;
      return { height: u16be(bytes, i + 5), width: u16be(bytes, i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null;
  const chunk = String.fromCharCode(bytes[12] as number, bytes[13] as number, bytes[14] as number, bytes[15] as number);
  if (chunk === "VP8 ") {
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return null; // startkode etter rammehodet
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null; // signaturbyte
    const bits = u32le(bytes, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
  return null;
}

/** Mål fra bildehodet, eller `null` når hodet ikke kan tolkes. Leser kun noen få bytes (med grensesjekk), aldri pikseldata. */
export function readImageDimensions(bytes: Uint8Array, mediaType: SnapshotMediaType): ImageDimensions | null {
  const dimensions = mediaType === "image/png" ? pngDimensions(bytes) : mediaType === "image/jpeg" ? jpegDimensions(bytes) : webpDimensions(bytes);
  return dimensions !== null && dimensions.width >= 1 && dimensions.height >= 1 ? dimensions : null;
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
export function inspectImage(bytes: Uint8Array, options: { maxBytes?: number; declaredType?: string | undefined; maxSide?: number; maxPixels?: number } = {}): InspectedImage {
  const maxBytes = Math.min(options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES, ABSOLUTE_MAX_IMAGE_BYTES);
  const maxSide = Math.min(options.maxSide ?? MAX_IMAGE_SIDE, MAX_IMAGE_SIDE);
  const maxPixels = Math.min(options.maxPixels ?? MAX_IMAGE_PIXELS, MAX_IMAGE_PIXELS);
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
  // Review A-L6: målene leses fra hodet (ingen dekoder). Ulesbare mål og for store mål avvises FØR bildet når modellserveren.
  const dimensions = readImageDimensions(bytes, media_type);
  if (dimensions === null) throw new VisionImageError("dimensions_unreadable");
  if (dimensions.width > maxSide || dimensions.height > maxSide || dimensions.width * dimensions.height > maxPixels) throw new VisionImageError("dimensions_too_large");
  return { media_type, byte_length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: dimensions.width, height: dimensions.height };
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

import { randomBytes } from "node:crypto";

/**
 * WP-G3 (D-465): strukturelt GYLDIGE bildehoder for tester (SOI/JFIF/SOF/SOS, PNG IHDR, WebP VP8/VP8L/VP8X) med de oppgitte målene, etterfulgt av tilfeldig innhold (hver kall gir en ny sha256).
 * Dette er IKKE dekodbare bilder - `inspectImage` leser kun hodet (review A-L6: mål leses fra hodet, ingen dekoder). Ligger under test/support/ (ingen produksjonskode).
 */
export interface ImageOptions {
  width?: number;
  height?: number;
  /** Antall tilfeldige bytes som legges etter hodet. */
  size?: number;
}

const be16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const le24 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

export interface JpegOptions extends ImageOptions {
  /** SOF-markør (standard C0 = baseline; C2 = progressive). */
  sof?: number;
  /** Antall nullbytes i et APP1-segment (EXIF-lignende) FØR SOF - SOF ligger ikke rett etter JFIF. */
  appPadding?: number;
}

/** JPEG: SOI, JFIF-APP0, (valgfritt APP1), SOF med målene, SOS, tilfeldig innhold. */
export function jpegBytes(options: JpegOptions = {}): Uint8Array {
  const { width = 64, height = 48, size = 512, sof = 0xc0, appPadding = 0 } = options;
  const app1 = appPadding > 0 ? [0xff, 0xe1, ...be16(appPadding + 2), ...new Array<number>(appPadding).fill(0)] : [];
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    ...app1,
    0xff, sof, 0x00, 0x11, 0x08, ...be16(height), ...be16(width), 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
    ...randomBytes(size)
  ]);
}

/** PNG: signatur, IHDR med målene (8 bit RGB), ugyldig CRC (ikke lest), tilfeldig innhold. */
export function pngBytes(options: ImageOptions = {}): Uint8Array {
  const { width = 64, height = 48, size = 256 } = options;
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, ...ascii("IHDR"), ...be32(width), ...be32(height), 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ...randomBytes(size)]);
}

export type WebpKind = "vp8" | "vp8l" | "vp8x";

export interface WebpOptions extends ImageOptions {
  /** Kun vp8x: lerretets mål (standard = bildets mål). Satt til noe annet enn bildets mål gir en INKONSISTENT fil (lerret og ramme avviker). */
  canvas?: { width: number; height: number };
  /** Kun vp8x: chunken som bærer bildet etter VP8X og `before` (standard `vp8l`, med bildets mål). `none` = ingen bildechunk, `anim`/`anmf` = animasjonschunk der bildechunken skulle stått. */
  inner?: "vp8" | "vp8l" | "none" | "anim" | "anmf";
  /** Kun vp8x: chunker FØR bildechunken (ALPH, ICCP, EXIF, ... ) med gitt nyttelastlengde; en oddetallslengde gir et polstringsbyte, slik formatet krever. */
  before?: Array<{ fourcc: string; size: number }>;
  /** Kun vp8x: animasjonsflagget (0x02) i VP8X-flaggene. */
  animation?: boolean;
  /** Kun vp8x: VP8X-chunkens lengdefelt (standard 10). */
  vp8xSize?: number;
}

function webpImageChunk(kind: "vp8" | "vp8l", width: number, height: number, size: number): number[] {
  if (kind === "vp8l") return [...ascii("VP8L"), ...le32(size + 5), 0x2f, ...le32(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14))];
  return [...ascii("VP8 "), ...le32(size + 10), 0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(width & 0x3fff), ...le16(height & 0x3fff)];
}

/**
 * WebP: RIFF-hode og én av de tre chunk-formene med målene. `vp8x` er det UTVIDEDE formatet: VP8X-chunk (lerret) FULGT AV en ekte bildechunk (standard VP8L med samme mål), slik en dekoder krever -
 * se `WebpOptions` for å bygge inkonsistente/animerte/avkortede filer.
 */
export function webpBytes(kind: WebpKind = "vp8x", options: WebpOptions = {}): Uint8Array {
  const { width = 64, height = 48, size = 256 } = options;
  const riff = [...ascii("RIFF"), ...le32(size + 30), ...ascii("WEBP")];
  if (kind === "vp8l" || kind === "vp8") return Uint8Array.from([...riff, ...webpImageChunk(kind, width, height, size), ...randomBytes(size)]);
  const canvas = options.canvas ?? { width, height };
  const flags = options.animation === true ? 0x02 : 0x00;
  const header = [...ascii("VP8X"), ...le32(options.vp8xSize ?? 10), flags, 0x00, 0x00, 0x00, ...le24(canvas.width - 1), ...le24(canvas.height - 1)];
  const before = (options.before ?? []).flatMap(({ fourcc, size: length }) => [...ascii(fourcc), ...le32(length), ...new Array<number>(length).fill(0), ...(length % 2 === 1 ? [0] : [])]);
  const inner = options.inner ?? "vp8l";
  const image = inner === "none" ? [] : inner === "anim" || inner === "anmf" ? [...ascii(inner === "anim" ? "ANIM" : "ANMF"), ...le32(16), ...new Array<number>(16).fill(0)] : webpImageChunk(inner, width, height, size);
  return Uint8Array.from([...riff, ...header, ...before, ...image, ...randomBytes(size)]);
}

import { stripControlAndInvisible } from "./knowledge-hits.ts";

/**
 * WP-D1 (UA-2): REN inntakslogikk for møtetranskripter (tekst, WebVTT, SRT, JSON) - ingen filsystem, ingen nettverk, ingen modell. Selve transkripsjonen (tale -> tekst) er UA-7 og ikke bygget her;
 * denne modulen leser transkripter som ALLEREDE finnes som filer og gjør dem til normalisert tekst + deltakere (kun navn/ref).
 *
 * SIKKERHETSEGENSKAPER:
 *  - Alt som leses er UBETRODD data (et referat kan inneholde hva som helst, også instruksjoner til en modell). Teksten renses for kontrolltegn/tagger og lagres kun som DATA.
 *  - E-postadresser lagres ALDRI: de redigeres bort (`[e-postadresse]`) fra tekst, deltakernavn og tittel FØR noe leveres videre, så de aldri kan dukke opp i et treff. Deltakere er kun
 *    `{ name, ref }`; `ref` er en nøytral løpenummer-referanse (`p1`, `p2` ...) eller en oppgitt ID som ikke ligner en e-postadresse - aldri en hash av en adresse.
 *  - Harde grenser (størrelse, antall segmenter, segmentlengde, antall deltakere, linjelengde) - en ondsinnet/ødelagt fil gir `TranscriptParseError`, aldri ubegrenset minne eller regex-løp.
 *  - JSON leses som rene data (kun kjente felt leses; ingen sammenslåing inn i objekter), og alle regulære uttrykk er forankret/enkle.
 */
export type TranscriptFormat = "txt" | "vtt" | "srt" | "json";

export const TRANSCRIPT_EXTENSIONS: Readonly<Record<string, TranscriptFormat>> = { ".txt": "txt", ".vtt": "vtt", ".srt": "srt", ".json": "json" };

export const TRANSCRIPT_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxSegments: 20_000,
  maxSegmentChars: 4_000,
  maxParticipants: 50,
  maxNameChars: 80,
  maxTitleChars: 200,
  maxLineChars: 8_000,
  maxDurationMs: 48 * 3_600_000
} as const;

export interface TranscriptSegment {
  speaker: string | null;
  start_ms: number | null;
  end_ms: number | null;
  text: string;
}

export interface TranscriptParticipant {
  name: string;
  ref: string;
}

export interface ParsedTranscript {
  format: TranscriptFormat;
  title: string | null;
  /** ISO-tidspunkt for møtet når kilden oppgir det (aldri gjettet). */
  started_at: string | null;
  participants: TranscriptParticipant[];
  segments: TranscriptSegment[];
  /** Antall e-postadresser som ble redigert bort. */
  emails_redacted: number;
}

export class TranscriptParseError extends Error {
  constructor(readonly reason: string) {
    super(`transcript_parse_failed:${reason}`);
    this.name = "TranscriptParseError";
  }
}

export function transcriptFormatOf(fileName: string): TranscriptFormat | null {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? null : TRANSCRIPT_EXTENSIONS[fileName.slice(dot).toLowerCase()] ?? null;
}

const EMAIL_RE = /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,8}/gu;
export const EMAIL_PLACEHOLDER = "[e-postadresse]";

/** Redigerer bort e-postadresser fra en tekst (brukes også på filnavn/titler som kilden bygger selv). */
export function redactEmailAddresses(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(EMAIL_RE, () => {
    count += 1;
    return EMAIL_PLACEHOLDER;
  });
  return { text: out, count };
}

interface Ctx {
  emails: number;
}

function clean(text: string, ctx: Ctx, max: number): string {
  let out = stripControlAndInvisible(text).normalize("NFC");
  out = out.replace(EMAIL_RE, () => {
    ctx.emails += 1;
    return EMAIL_PLACEHOLDER;
  });
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
const decodeEntities = (text: string): string => text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);

/** `HH:MM:SS(.mmm|,mmm)` eller `MM:SS(.mmm)` -> millisekunder; ugyldig/utenfor 0..48 timer -> null. */
export function parseClock(raw: string): number | null {
  const m = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(raw.trim());
  if (!m) return null;
  const hours = m[1] === undefined ? 0 : Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (seconds > 59 || (m[1] !== undefined && minutes > 59)) return null;
  const ms = m[4] === undefined ? 0 : Number(m[4].padEnd(3, "0"));
  const total = ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
  return total >= 0 && total <= TRANSCRIPT_LIMITS.maxDurationMs ? total : null;
}

function numberToMs(value: unknown, unit: "s" | "ms"): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const ms = Math.round(unit === "s" ? value * 1000 : value);
  return ms <= TRANSCRIPT_LIMITS.maxDurationMs ? ms : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Taleretiketten i «Navn: tekst» - kort, med bokstaver først, uten kolon: ellers er det bare en setning med kolon. */
const SPEAKER_PREFIX = /^([\p{L}][\p{L}\p{N} .'’-]{0,38}?)\s*:\s+(\S[\s\S]*)$/u;

function splitSpeaker(line: string): { speaker: string | null; text: string } {
  const m = SPEAKER_PREFIX.exec(line);
  if (!m) return { speaker: null, text: line };
  const label = (m[1] as string).trim();
  // Maks 4 ord, og ingen sifre alene (klokkeslett/URL-er): ellers er det ikke en taler.
  if (label.split(/\s+/).length > 4 || /^\d+$/.test(label)) return { speaker: null, text: line };
  return { speaker: label, text: m[2] as string };
}

function pushSegment(out: TranscriptSegment[], seg: TranscriptSegment): void {
  if (seg.text.length === 0) return;
  if (out.length >= TRANSCRIPT_LIMITS.maxSegments) throw new TranscriptParseError("too_many_segments");
  out.push(seg);
}

function limitLines(raw: string): string[] {
  return raw.replace(/\r\n?/g, "\n").split("\n").map((l) => (l.length > TRANSCRIPT_LIMITS.maxLineChars ? l.slice(0, TRANSCRIPT_LIMITS.maxLineChars) : l));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// WebVTT og SRT
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const CUE_TIMING = /^((?:\d{1,3}:)?\d{1,3}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d{1,3}:)?\d{1,3}:\d{2}[.,]\d{1,3})(?:\s.*)?$/;

function parseCueBlocks(raw: string, format: "vtt" | "srt", ctx: Ctx): TranscriptSegment[] {
  const lines = limitLines(raw);
  if (lines[0] !== undefined && lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
  if (format === "vtt" && !/^WEBVTT(?:\s|$)/.test(lines[0] ?? "")) throw new TranscriptParseError("vtt_header_missing");
  const segments: TranscriptSegment[] = [];
  let i = format === "vtt" ? 1 : 0;
  while (i < lines.length) {
    // Hopp til neste blokk-start (tomlinje-separert).
    while (i < lines.length && (lines[i] ?? "").trim() === "") i += 1;
    if (i >= lines.length) break;
    const block: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "") {
      block.push(lines[i] as string);
      i += 1;
    }
    if (format === "vtt" && /^(NOTE|STYLE|REGION)(\s|$)/.test(block[0] ?? "")) continue;
    const timingIndex = block.findIndex((l) => CUE_TIMING.test(l.trim()));
    if (timingIndex === -1 || timingIndex > 1) continue; // ikke en cue (id-linje er maks én linje foran tidslinjen)
    const timing = CUE_TIMING.exec((block[timingIndex] as string).trim()) as RegExpExecArray;
    const payload = block.slice(timingIndex + 1).join(" ");
    let speaker: string | null = null;
    let body = payload;
    // (klassene mellom punktum kan ikke selv inneholde punktum: ellers er oppdelingen tvetydig og regexen kan løpe eksponentielt på en ondsinnet linje)
    const voice = /<v(?:\.[^\s.>]*)*\s+([^>]{1,120})>/.exec(payload);
    if (voice) speaker = voice[1] as string;
    body = decodeEntities(body.replace(/<[^>]*>/g, " ").replace(/\{\\[^}]*\}/g, " "));
    if (speaker === null) {
      const split = splitSpeaker(clean(body, ctx, TRANSCRIPT_LIMITS.maxSegmentChars * 2));
      speaker = split.speaker;
      body = split.text;
    }
    const text = clean(body, ctx, TRANSCRIPT_LIMITS.maxSegmentChars);
    pushSegment(segments, {
      speaker: speaker === null ? null : cleanName(speaker, ctx),
      start_ms: parseClock(timing[1] as string),
      end_ms: parseClock(timing[2] as string),
      text
    });
  }
  if (segments.length === 0) throw new TranscriptParseError("no_segments");
  return segments;
}

function cleanName(raw: string, ctx: Ctx): string | null {
  const name = clean(decodeEntities(raw), ctx, TRANSCRIPT_LIMITS.maxNameChars);
  return name.length === 0 || name === EMAIL_PLACEHOLDER ? null : name;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Ren tekst
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const HEADER = /^(tittel|title|emne|subject|dato|date|møtedato|deltakere|participants|attendees)\s*:\s*(.*)$/i;
const LEADING_CLOCK = /^[[(]?(\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)[\])]?\s*[-–]?\s*(.*)$/;

interface TxtResult {
  segments: TranscriptSegment[];
  title: string | null;
  started_at: string | null;
  listedParticipants: string[];
}

function parseTxt(raw: string, ctx: Ctx): TxtResult {
  const lines = limitLines(raw);
  const segments: TranscriptSegment[] = [];
  let title: string | null = null;
  let startedAt: string | null = null;
  const listed: string[] = [];
  let inHeader = true;
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (line === "") continue;
    if (inHeader) {
      const h = HEADER.exec(line);
      if (h) {
        const key = (h[1] as string).toLowerCase();
        const value = h[2] as string;
        if (key === "tittel" || key === "title" || key === "emne" || key === "subject") title = clean(value, ctx, TRANSCRIPT_LIMITS.maxTitleChars) || null;
        else if (key === "dato" || key === "date" || key === "møtedato") startedAt = isoOrNull(value.trim());
        else for (const part of value.split(/[,;]/)) {
          const name = cleanName(part, ctx);
          if (name !== null && listed.length < TRANSCRIPT_LIMITS.maxParticipants) listed.push(name);
        }
        continue;
      }
      inHeader = false;
    }
    let start: number | null = null;
    let rest = line;
    const clock = LEADING_CLOCK.exec(line);
    if (clock) {
      start = parseClock(clock[1] as string);
      rest = clock[2] as string;
    }
    const split = splitSpeaker(rest);
    const text = clean(split.text, ctx, TRANSCRIPT_LIMITS.maxSegmentChars);
    const hasMarker = start !== null || split.speaker !== null;
    const prev = segments[segments.length - 1];
    if (!hasMarker && prev !== undefined) {
      // Fortsettelse av forrige ytring (lang tekst brutt over flere linjer).
      const joined = `${prev.text} ${text}`;
      prev.text = joined.length > TRANSCRIPT_LIMITS.maxSegmentChars ? `${joined.slice(0, TRANSCRIPT_LIMITS.maxSegmentChars - 1).trimEnd()}…` : joined;
      continue;
    }
    pushSegment(segments, { speaker: split.speaker === null ? null : cleanName(split.speaker, ctx), start_ms: start, end_ms: null, text });
  }
  if (segments.length === 0) throw new TranscriptParseError("no_segments");
  return { segments, title, started_at: startedAt, listedParticipants: listed };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function jsonTime(obj: Record<string, unknown>, key: "start" | "end"): number | null {
  const msKey = obj[`${key}_ms`];
  if (msKey !== undefined) return numberToMs(msKey, "ms");
  const v = obj[key];
  if (typeof v === "number") return numberToMs(v, "s");
  if (typeof v === "string") return parseClock(v);
  return null;
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,40}$/.test(value) && !value.includes("@") ? value : null;
}

interface JsonResult extends TxtResult {
  ids: Map<string, string>;
}

function parseJson(raw: string, ctx: Ctx): JsonResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new TranscriptParseError("json_invalid");
  }
  const root = Array.isArray(data) ? { segments: data } : isRecord(data) ? data : null;
  if (root === null) throw new TranscriptParseError("json_shape");
  const rawSegments = root["segments"];
  if (!Array.isArray(rawSegments)) throw new TranscriptParseError("json_segments_missing");
  if (rawSegments.length > TRANSCRIPT_LIMITS.maxSegments) throw new TranscriptParseError("too_many_segments");
  const ids = new Map<string, string>();
  const segments: TranscriptSegment[] = [];
  for (const entry of rawSegments) {
    if (!isRecord(entry) || typeof entry["text"] !== "string") continue; // ukjent element: hoppes over (aldri tolket)
    let speaker: string | null = null;
    const sp = entry["speaker"] ?? entry["speaker_name"];
    if (typeof sp === "string") speaker = cleanName(sp, ctx);
    else if (isRecord(sp) && typeof sp["name"] === "string") {
      speaker = cleanName(sp["name"], ctx);
      const id = safeId(sp["id"]);
      if (speaker !== null && id !== null) ids.set(speaker.toLowerCase(), id);
    }
    const sid = safeId(entry["speaker_id"]);
    if (speaker !== null && sid !== null) ids.set(speaker.toLowerCase(), sid);
    pushSegment(segments, { speaker, start_ms: jsonTime(entry, "start"), end_ms: jsonTime(entry, "end"), text: clean(entry["text"], ctx, TRANSCRIPT_LIMITS.maxSegmentChars) });
  }
  if (segments.length === 0) throw new TranscriptParseError("no_segments");
  const listed: string[] = [];
  const rawParticipants = root["participants"] ?? root["attendees"];
  if (Array.isArray(rawParticipants)) {
    for (const p of rawParticipants.slice(0, TRANSCRIPT_LIMITS.maxParticipants)) {
      const name = typeof p === "string" ? cleanName(p, ctx) : isRecord(p) && typeof p["name"] === "string" ? cleanName(p["name"], ctx) : null;
      if (name === null) continue;
      listed.push(name);
      if (isRecord(p)) {
        const id = safeId(p["id"]);
        if (id !== null) ids.set(name.toLowerCase(), id);
      }
    }
  }
  const title = typeof root["title"] === "string" ? clean(root["title"], ctx, TRANSCRIPT_LIMITS.maxTitleChars) || null : null;
  const started = isoOrNull(root["started_at"] ?? root["date"] ?? root["start_time"]);
  return { segments, title, started_at: started, listedParticipants: listed, ids };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Offentlig API
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export function parseTranscript(format: TranscriptFormat, raw: string): ParsedTranscript {
  if (typeof raw !== "string" || raw.trim().length === 0) throw new TranscriptParseError("empty");
  if (Buffer.byteLength(raw, "utf8") > TRANSCRIPT_LIMITS.maxBytes) throw new TranscriptParseError("too_large");
  const ctx: Ctx = { emails: 0 };
  let segments: TranscriptSegment[];
  let title: string | null = null;
  let startedAt: string | null = null;
  let listed: string[] = [];
  let ids = new Map<string, string>();
  if (format === "vtt" || format === "srt") {
    segments = parseCueBlocks(raw, format, ctx);
  } else if (format === "json") {
    const r = parseJson(raw, ctx);
    ({ segments, title, started_at: startedAt, listedParticipants: listed } = r);
    ids = r.ids;
  } else {
    const r = parseTxt(raw, ctx);
    ({ segments, title, started_at: startedAt, listedParticipants: listed } = r);
  }

  // Deltakere: oppgitt liste først, deretter talere i rekkefølge; kun navn + nøytral ref, dedupet uten hensyn til store/små bokstaver.
  const participants: TranscriptParticipant[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    const key = name.toLowerCase();
    if (seen.has(key) || participants.length >= TRANSCRIPT_LIMITS.maxParticipants) return;
    seen.add(key);
    participants.push({ name, ref: ids.get(key) ?? `p${participants.length + 1}` });
  };
  for (const name of listed) add(name);
  for (const s of segments) if (s.speaker !== null) add(s.speaker);
  return { format, title, started_at: startedAt, participants, segments, emails_redacted: ctx.emails };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

export function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** Normalisert tekst som lagres som dokumentinnhold (fulltekst/embedding): overskrift, deltakere og tidsstemplede ytringer med taler. */
export function renderTranscriptText(t: ParsedTranscript): string {
  const lines: string[] = [];
  if (t.title !== null) lines.push(`Møte: ${t.title}`);
  if (t.started_at !== null) lines.push(`Dato: ${t.started_at.slice(0, 10)}`);
  if (t.participants.length > 0) lines.push(`Deltakere: ${t.participants.map((p) => p.name).join(", ")}`);
  if (lines.length > 0) lines.push("");
  for (const s of t.segments) {
    lines.push(`${s.start_ms !== null ? `[${formatClock(s.start_ms)}] ` : ""}${s.speaker !== null ? `${s.speaker}: ` : ""}${s.text}`);
  }
  return lines.join("\n");
}

/** Lengden på møtet i ms (det største sluttidspunktet, ellers det største starttidspunktet), `null` når ingen tider finnes. */
export function transcriptDurationMs(t: ParsedTranscript): number | null {
  let max: number | null = null;
  for (const s of t.segments) for (const v of [s.end_ms, s.start_ms]) if (v !== null && (max === null || v > max)) max = v;
  return max;
}

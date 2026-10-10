import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { JsonValue } from "@jarvis/contracts";
import { DEFAULT_WALK_LIMITS, readWalkedFile, walkAllowlistedFiles, type WalkLimits } from "./filesystem-source.ts";
import type { KnowledgeListResult, KnowledgeRecord, KnowledgeSource, SkippedRecord } from "./source.ts";
import {
  EMAIL_PLACEHOLDER,
  TRANSCRIPT_EXTENSIONS,
  TRANSCRIPT_LIMITS,
  TranscriptParseError,
  parseTranscript,
  redactEmailAddresses,
  renderTranscriptText,
  transcriptDurationMs,
  transcriptFormatOf,
  type TranscriptFormat
} from "./transcript-parse.ts";

export interface MeetingTranscriptSourceOptions {
  /** Hvilke formater som leses (standard: alle fire). */
  formats?: readonly TranscriptFormat[];
  limits?: Partial<WalkLimits>;
}

const ALL_FORMATS: readonly TranscriptFormat[] = ["txt", "vtt", "srt", "json"];

/**
 * Stabil ekstern id for en transkriptfil: den relative stien - men aldri med en e-postadresse i klartekst (et filnavn som «mote-med-ola@acme.no.txt» er vanlig i eksporter). Inneholder stien en
 * adresse, redigeres den bort og en kort hash av den opprinnelige stien legges til, så id-en forblir stabil og unik uten at adressen lagres.
 */
export function transcriptExternalId(relPath: string): string {
  const redacted = redactEmailAddresses(relPath);
  return redacted.count === 0 ? relPath : `${redacted.text}~${createHash("sha256").update(relPath).digest("hex").slice(0, 12)}`;
}

/**
 * WP-D1 (UA-2): møtetranskripter som kunnskapskilde (`meeting_transcript`). Leser ferdige transkripter (tekst/WebVTT/SRT/JSON med talere og tidsstempler) fra en konfigurert, allowlistet rotmappe.
 * Selve transkripsjonen (tale -> tekst) er UA-7 og IKKE bygget her - denne kilden tar kun imot filer som allerede finnes.
 *
 * SIKKERHET OG PERSONVERN:
 *  - Rotmappen vandres med den felles, sikre vandringen (`walkAllowlistedFiles`): ingen symlink-/`..`-utbrudd, ingen løkker, størrelses-/antallsgrenser.
 *  - Innholdet er UBETRODD data (et referat kan inneholde instruksjoner til en modell): det renses for kontrolltegn/tagger og lagres kun som tekst (se `transcript-parse.ts`).
 *  - E-postadresser lagres ALDRI: de redigeres bort fra tekst, deltakernavn, tittel OG filnavn før noe lagres. Deltakere er kun `{ name, ref }` i metadata.
 *  - `canonical_uri` er en nøytral referanse (hash av den relative stien), aldri verts-stien og aldri filnavnet, så ingen sti/adresse kan lekke via et treff.
 *  - `modified_at` er filens mtime (system-styrt), IKKE datoen transkriptet selv oppgir: innholdet kan ikke manipulere oppbevaringsfristen. Fristen (`retention_days`) settes på kilden og
 *    håndheves av synk + `KnowledgeRetentionService`.
 *  - En fil som ikke lar seg tolke hoppes over (`skipped`, beskyttet mot tombstoning) - aldri en feil som stopper resten.
 */
export class MeetingTranscriptKnowledgeSource implements KnowledgeSource {
  readonly source_type = "meeting_transcript";
  readonly source_instance_id: string;
  private readonly extensions: ReadonlySet<string>;
  private readonly limits: WalkLimits;

  constructor(private readonly rootPath: string, sourceInstanceId: string, options: MeetingTranscriptSourceOptions = {}) {
    this.source_instance_id = sourceInstanceId;
    const formats = options.formats ?? ALL_FORMATS;
    this.extensions = new Set(Object.entries(TRANSCRIPT_EXTENSIONS).filter(([, format]) => formats.includes(format)).map(([ext]) => ext));
    // Aldri større per-fil-grense enn parserens egen.
    this.limits = { ...DEFAULT_WALK_LIMITS, ...(options.limits ?? {}) };
    this.limits.maxFileBytes = Math.min(this.limits.maxFileBytes, TRANSCRIPT_LIMITS.maxBytes);
  }

  async list(): Promise<KnowledgeListResult> {
    const walk = await walkAllowlistedFiles(this.rootPath, this.extensions, this.limits);
    const records: KnowledgeRecord[] = [];
    const skipped: SkippedRecord[] = walk.oversized.map((f) => ({ external_id: transcriptExternalId(f.relPath), reason: "UNSUPPORTED_CONTENT" as const, detail: "too_large" }));
    for (const file of walk.files) {
      const format = transcriptFormatOf(file.relPath);
      if (format === null) continue;
      const read = await readWalkedFile(file, this.limits.maxFileBytes);
      if ("skip" in read) {
        skipped.push({ external_id: transcriptExternalId(file.relPath), reason: read.skip === "unreadable" ? "SOURCE_UNAVAILABLE" : "UNSUPPORTED_CONTENT", detail: read.skip });
        continue;
      }
      let parsed;
      try {
        parsed = parseTranscript(format, read.text);
      } catch (err) {
        skipped.push({ external_id: transcriptExternalId(file.relPath), reason: "UNSUPPORTED_CONTENT", detail: err instanceof TranscriptParseError ? err.reason : "parse_failed" });
        continue;
      }
      const content = renderTranscriptText(parsed);
      const stem = basename(file.relPath).replace(/\.[^.]+$/, "");
      // Tittel-reserve fra filnavnet: e-post redigeres bort først, og understrek/bindestrek bli mellomrom UTENFOR plassholderen.
      const fallbackTitle = redactEmailAddresses(stem).text.split(EMAIL_PLACEHOLDER).map((part) => part.replace(/[_-]+/g, " ")).join(EMAIL_PLACEHOLDER).replace(/\s+/g, " ").trim().slice(0, TRANSCRIPT_LIMITS.maxTitleChars);
      const duration = transcriptDurationMs(parsed);
      records.push({
        source_type: this.source_type,
        source_instance_id: this.source_instance_id,
        external_id: transcriptExternalId(file.relPath),
        canonical_uri: `transcript://${this.source_instance_id}/${createHash("sha256").update(file.relPath).digest("hex").slice(0, 16)}`,
        title: parsed.title ?? (fallbackTitle.length > 0 ? fallbackTitle : "Møtetranskript"),
        content,
        content_type: "text/plain",
        content_hash: createHash("sha256").update(content).digest("hex"),
        modified_at: file.mtime.toISOString(),
        metadata: {
          format: parsed.format,
          started_at: parsed.started_at,
          participants: parsed.participants.map((p) => ({ name: p.name, ref: p.ref })) as JsonValue,
          segment_count: parsed.segments.length,
          duration_ms: duration,
          emails_redacted: parsed.emails_redacted,
          size_bytes: file.size
        }
      });
    }
    return {
      records, skipped,
      ...(walk.truncated ? { listing: "partial" as const } : {}),
      ...(walk.protected_prefixes.length > 0 ? { protected_prefixes: walk.protected_prefixes } : {})
    };
  }
}

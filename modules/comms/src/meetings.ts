import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { evaluateSpeechRouting, type JsonValue, type MemorySpace, type MemorySpaceAuthority, type SpeechProcessorDeclaration } from "@jarvis/contracts";
import type { BusinessService } from "@jarvis/business";
import type { ConversationGraphService } from "@jarvis/conversation-graph";
import { TranscriptParseError, parseTranscript, type ParsedTranscript, type TranscriptFormat } from "@jarvis/knowledge";
import { withMemoryTransaction } from "@jarvis/memory";
import type { Actor, Clock } from "./store.ts";
import { sanitizeInboundText } from "./webhooks/ingest.ts";

/**
 * WP-G1 (D-463, P2g): møtetranskripsjon-pipelinen (`JARVIS_COMMS_MEETINGS=on`, DORMANT og NOT VERIFIED). Inndata er TEKST som allerede finnes (UA-2/Meet/Teams-transkripter: txt/vtt/srt/json) eller LYD via en `AudioTranscriber`
 * (porten bak `SpeechAdapter`; ingen produksjonsadapter er bundet - DEFERRED). Ingen møte-bot: Jarvis blir aldri med i et møte (en bot er en ekstern leverandør = `CORE_DEPENDENCY_DECISION_REQUIRED`, ikke bygget).
 *
 * Det som skjer, deterministisk og uten modell: (1) eierens eksplisitte attest på rettslig grunnlag (D-122 - Jarvis avgjør det aldri selv); (2) parsing (kontrolltegn/e-post renset av `@jarvis/knowledge`); (3) idempotens på innholds-hash;
 * (4) deltakere: eksakt kanal-id-treff (Teams/Slack/Discord-id i transkriptet) eller KANDIDAT (kun forslag) - ukjent forblir ukjent, eieren bekrefter; (5) forpliktelser: FORESLÅTTE utdrag funnet av navngitte mønstre - de blir en åpen oppfølging (`business_followups`)
 * først når eieren godtar. Selve transkripsjonsteksten lagres ALDRI (kun hash, antall segmenter, tittel, deltakernavn og korte utdrag). Oppbevaring: `retention_until` (sveip + erasure-planen).
 */
export const MEETING_TEXT_MAX_CHARS = 500_000;
export const MEETING_MAX_COMMITMENTS = 50;
const COMMITMENT_MAX_CHARS = 300;

export interface AudioTranscriber {
  /** Tale -> tekst for ÉN lydfil. Produksjonsbinding (lokal Whisper via voice-gateway) er DEFERRED; kun lokale behandlere er tillatt av rutingsporten i dag. */
  transcribe(audio: Buffer, options: { language: string }): Promise<{ text: string }>;
}

export interface MeetingContext {
  readonly tenantId: string;
  readonly space: MemorySpace;
  readonly actor: Actor;
}

export interface ExtractedCommitment {
  readonly speaker_ref: string | null;
  readonly text: string;
  readonly due_at: string | null;
  readonly rule: string;
  readonly segment_index: number;
}

const MONTHS: Readonly<Record<string, number>> = { januar: 1, februar: 2, mars: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, desember: 12 };

/** Navngitte mønstre (aldri modell). Hver treff er et FORSLAG - mange vanlige setninger («jeg skal på ferie») treffer også, derfor godtar eieren hver for seg. */
const RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: "action_prefix", pattern: /^\s*(?:action|oppgave|todo|to-do|neste steg)\s*[:-]\s*\S/iu },
  { rule: "no_skal_maa", pattern: /\b(?:jeg|vi)\s+(?:skal|må)\s+\p{L}{2,}/iu },
  { rule: "no_verb", pattern: /\b(?:jeg|vi)\s+(?:sender|ordner|følger\s+opp|booker|ringer|fikser|tar\s+det|lover\s+å)\b/iu },
  { rule: "en_will", pattern: /\b(?:I|we)(?:\s+will|'ll|\s+shall|\s+need\s+to|\s+have\s+to|\s+promise\s+to)\s+\w{2,}/iu }
];

function isoDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day, 12));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d.toISOString() : null;
}

/** Kun en EKSPLISITT dato (ISO, eller «20. november [2026]» der året er oppgitt eller kommer fra møtets starttid) - aldri gjettet, aldri «fredag»/«neste uke». */
export function explicitDueDate(sentence: string, meetingStartedAt: string | null): string | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(sentence);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const no = /\b(\d{1,2})\.\s*(januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember)(?:\s+(\d{4}))?\b/iu.exec(sentence);
  if (!no) return null;
  const year = no[3] !== undefined ? Number(no[3]) : meetingStartedAt !== null ? new Date(meetingStartedAt).getUTCFullYear() : Number.NaN;
  return Number.isInteger(year) ? isoDate(year, MONTHS[no[2]!.toLowerCase()]!, Number(no[1])) : null;
}

export function extractCommitments(parsed: ParsedTranscript): ExtractedCommitment[] {
  const refByName = new Map(parsed.participants.map((p) => [p.name.toLowerCase(), p.ref]));
  const out: ExtractedCommitment[] = [];
  const seen = new Set<string>();
  for (const [index, segment] of parsed.segments.entries()) {
    for (const raw of segment.text.split(/(?<=[.!?])\s+|\n+/u)) {
      if (out.length >= MEETING_MAX_COMMITMENTS) return out;
      const sentence = raw.trim();
      if (sentence.length < 8) continue;
      const hit = RULES.find((r) => r.pattern.test(sentence));
      if (hit === undefined) continue;
      const text = sanitizeInboundText(Array.from(sentence).slice(0, COMMITMENT_MAX_CHARS).join(""));
      if (text === null || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      out.push({ speaker_ref: segment.speaker === null ? null : refByName.get(segment.speaker.toLowerCase()) ?? null, text, due_at: explicitDueDate(sentence, parsed.started_at), rule: hit.rule, segment_index: index });
    }
  }
  return out;
}

export interface MeetingSummary {
  readonly meeting_id: string;
  readonly deduplicated: boolean;
  readonly source: "text_transcript" | "audio_file";
  readonly title: string | null;
  readonly segment_count: number;
  readonly participants: number;
  readonly participants_resolved: number;
  readonly commitments_proposed: number;
}

export interface TextIngestInput {
  readonly format: TranscriptFormat;
  readonly text: string;
  readonly title?: string | undefined;
  readonly attest_legal_basis: boolean;
  readonly legal_basis_note?: string | undefined;
}

export interface MeetingServiceDeps {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly graph: Pick<ConversationGraphService, "resolveIdentityByChannel">;
  readonly business?: Pick<BusinessService, "createFollowup">;
  readonly retentionDays: number;
  readonly transcriber?: AudioTranscriber;
  readonly speechProcessor?: SpeechProcessorDeclaration;
  readonly warn?: (event: Record<string, unknown>) => void;
}

const id = (prefix: string): string => `${prefix}-${randomUUID()}`;
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const clean = (value: string | undefined, max: number): string | null => (value === undefined ? null : sanitizeInboundText(Array.from(value).slice(0, max).join("")));

export class MeetingService {
  constructor(private readonly deps: MeetingServiceDeps) {}

  /** Tekstkilde (UA-2/Meet/Teams-transkript som tekst/vtt/srt/json). */
  async ingestText(ctx: MeetingContext, input: TextIngestInput): Promise<MeetingSummary> {
    return this.ingest(ctx, input, "text_transcript", null);
  }

  /** Lyd -> tekst via `AudioTranscriber`, FØRST etter rutingsporten (`evaluateSpeechRouting`, D-122). Produksjonsadapter er ikke bundet; ingen verktøyflate tar lyd (ingen filsti-lesing). */
  async ingestAudio(ctx: MeetingContext, input: { audio: Buffer; language?: string; title?: string; attest_legal_basis: boolean; legal_basis_note?: string; memory_space_authority: MemorySpaceAuthority }): Promise<MeetingSummary> {
    const { transcriber, speechProcessor } = this.deps;
    if (transcriber === undefined || speechProcessor === undefined) throw new Error("meeting_audio_not_configured");
    if (input.audio.length === 0 || input.audio.length > 200 * 1024 * 1024) throw new Error("meeting_audio_size_invalid");
    const decision = evaluateSpeechRouting(speechProcessor, ctx.space, input.memory_space_authority);
    if (!decision.allowed) throw new Error(`meeting_audio_routing_denied:${decision.outcome}`.toLowerCase().slice(0, 100));
    const { text } = await transcriber.transcribe(input.audio, { language: input.language ?? "nb" });
    return this.ingest(ctx, { format: "txt", text, title: input.title, attest_legal_basis: input.attest_legal_basis, legal_basis_note: input.legal_basis_note }, "audio_file", speechProcessor.locality);
  }

  private async ingest(ctx: MeetingContext, input: TextIngestInput, source: "text_transcript" | "audio_file", locality: "local" | "external" | null): Promise<MeetingSummary> {
    if (input.attest_legal_basis !== true) throw new Error("meeting_legal_basis_not_attested");
    if (typeof input.text !== "string" || input.text.length === 0 || input.text.length > MEETING_TEXT_MAX_CHARS) throw new Error("meeting_text_size_invalid");
    let parsed: ParsedTranscript;
    try {
      parsed = parseTranscript(input.format, input.text);
    } catch (err) {
      throw new Error(err instanceof TranscriptParseError ? `meeting_transcript_invalid:${err.reason}`.slice(0, 80) : "meeting_transcript_invalid");
    }
    const hash = sha256(`${input.format}\n${input.text}`);
    const commitments = extractCommitments(parsed);
    const now = this.deps.clock();
    const retention = new Date(now.getTime() + this.deps.retentionDays * 86_400_000);
    const title = clean(input.title, 200) ?? clean(parsed.title ?? undefined, 200);
    // EKSAKT treff: deltakerens id i transkriptet (Teams: Entra-objekt-GUID, Slack-/Discord-id) er en kjent kanal-identifikator i Conversation Graph. Ugyldig form for en kanal = ikke et treff; ukjent forblir ukjent.
    const resolved = await Promise.all(parsed.participants.map(async (p) => {
      for (const channel of ["teams", "slack", "discord"] as const) {
        try {
          const hit = await this.deps.graph.resolveIdentityByChannel(ctx.tenantId, ctx.space, channel, p.ref);
          if (hit !== null) return hit.identity_id;
        } catch {
          // identifikatoren har ikke formen til denne kanalen
        }
      }
      return null;
    }));
    return withMemoryTransaction(this.deps.pool, ctx.tenantId, [ctx.space], async (client) => {
      const existing = await client.query(`SELECT meeting_id, source, title, segment_count FROM comms_meetings WHERE tenant_id = $1 AND content_sha256 = $2`, [ctx.tenantId, hash]);
      if (existing.rows.length === 1) {
        const row = existing.rows[0] as { meeting_id: string; source: MeetingSummary["source"]; title: string | null; segment_count: number };
        const counts = await client.query(
          `SELECT (SELECT count(*)::int FROM comms_meeting_participants WHERE tenant_id = $1 AND meeting_id = $2) AS p,
                  (SELECT count(*)::int FROM comms_meeting_participants WHERE tenant_id = $1 AND meeting_id = $2 AND identity_id IS NOT NULL) AS r,
                  (SELECT count(*)::int FROM comms_meeting_commitments WHERE tenant_id = $1 AND meeting_id = $2) AS c`, [ctx.tenantId, row.meeting_id]);
        const c = counts.rows[0] as { p: number; r: number; c: number };
        return { meeting_id: row.meeting_id, deduplicated: true, source: row.source, title: row.title, segment_count: row.segment_count, participants: c.p, participants_resolved: c.r, commitments_proposed: c.c };
      }
      const meetingId = id("meet");
      await client.query(
        `INSERT INTO comms_meetings (tenant_id, meeting_id, memory_space_id, source, source_format, title, started_at, duration_ms, content_sha256, segment_count, legal_basis_attested, legal_basis_note,
                                     speech_processor_locality, person_id, session_id, task_id, created_at, retention_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$13,$14,$15,$16,$17)`,
        [ctx.tenantId, meetingId, ctx.space, source, input.format, title, parsed.started_at, durationMs(parsed), hash, parsed.segments.length, clean(input.legal_basis_note, 300), locality,
          ctx.actor.person_id, ctx.actor.session_id, ctx.actor.task_id ?? null, now, retention]
      );
      let resolvedCount = 0;
      for (const [index, p] of parsed.participants.entries()) {
        const identityId = resolved[index] ?? null;
        if (identityId !== null) resolvedCount += 1;
        // Kandidat = KUN forslag: nøyaktig én aktiv identitet med samme visningsnavn (uten hensyn til store/små bokstaver) - aldri en kobling.
        let candidate: string | null = null;
        if (identityId === null) {
          const c = await client.query(`SELECT identity_id FROM conversation_identities WHERE tenant_id = $1 AND status = 'active' AND lower(display_name) = lower($2) LIMIT 2`, [ctx.tenantId, p.name]);
          candidate = c.rows.length === 1 ? (c.rows[0] as { identity_id: string }).identity_id : null;
        }
        const resolution = identityId !== null ? "exact" : candidate !== null ? "candidate" : "unresolved";
        await client.query(
          `INSERT INTO comms_meeting_participants (tenant_id, meeting_id, memory_space_id, participant_ref, display_name, identity_id, resolution, candidate_identity_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [ctx.tenantId, meetingId, ctx.space, p.ref.slice(0, 80), Array.from(p.name).slice(0, 80).join(""), identityId, resolution, candidate]
        );
      }
      for (const c of commitments) {
        await client.query(
          `INSERT INTO comms_meeting_commitments (tenant_id, meeting_id, memory_space_id, commitment_id, participant_ref, commitment_text, due_at, rule, segment_index, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [ctx.tenantId, meetingId, ctx.space, id("mcom"), c.speaker_ref, c.text, c.due_at, c.rule, c.segment_index, now]
        );
      }
      return { meeting_id: meetingId, deduplicated: false, source, title, segment_count: parsed.segments.length, participants: parsed.participants.length, participants_resolved: resolvedCount, commitments_proposed: commitments.length };
    });
  }

  async list(ctx: MeetingContext, limit = 50): Promise<Array<Record<string, JsonValue>>> {
    return withMemoryTransaction(this.deps.pool, ctx.tenantId, [ctx.space], async (client) => {
      const res = await client.query(
        `SELECT m.meeting_id, m.source, m.title, m.started_at, m.segment_count, m.created_at, m.retention_until,
                (SELECT count(*)::int FROM comms_meeting_participants p WHERE p.tenant_id = m.tenant_id AND p.meeting_id = m.meeting_id) AS participants,
                (SELECT count(*)::int FROM comms_meeting_commitments c WHERE c.tenant_id = m.tenant_id AND c.meeting_id = m.meeting_id AND c.status = 'proposed') AS open_proposals
         FROM comms_meetings m WHERE m.tenant_id = $1 ORDER BY m.created_at DESC LIMIT $2`, [ctx.tenantId, Math.min(Math.max(limit, 1), 100)]);
      return res.rows.map((r) => iso(r as Record<string, unknown>)) as Array<Record<string, JsonValue>>;
    });
  }

  async get(ctx: MeetingContext, meetingId: string): Promise<Record<string, JsonValue> | null> {
    return withMemoryTransaction(this.deps.pool, ctx.tenantId, [ctx.space], async (client) => {
      const m = await client.query(`SELECT meeting_id, source, title, started_at, segment_count, retention_until FROM comms_meetings WHERE tenant_id = $1 AND meeting_id = $2`, [ctx.tenantId, meetingId]);
      if (m.rows.length === 0) return null;
      const p = await client.query(`SELECT participant_ref, display_name, resolution, identity_id, candidate_identity_id FROM comms_meeting_participants WHERE tenant_id = $1 AND meeting_id = $2 ORDER BY participant_ref`, [ctx.tenantId, meetingId]);
      return { ...iso(m.rows[0] as Record<string, unknown>), exists: true, participants: p.rows as unknown as JsonValue } as Record<string, JsonValue>;
    });
  }

  async commitments(ctx: MeetingContext, opts: { meeting_id?: string | undefined; status?: "proposed" | "accepted" | "dismissed" | undefined; limit?: number | undefined } = {}): Promise<Array<Record<string, JsonValue>>> {
    return withMemoryTransaction(this.deps.pool, ctx.tenantId, [ctx.space], async (client) => {
      const res = await client.query(
        `SELECT commitment_id, meeting_id, participant_ref, commitment_text, due_at, detection, rule, segment_index, status, followup_id, decided_at
         FROM comms_meeting_commitments WHERE tenant_id = $1 AND ($2::text IS NULL OR meeting_id = $2) AND ($3::text IS NULL OR status = $3) ORDER BY created_at DESC, segment_index LIMIT $4`,
        [ctx.tenantId, opts.meeting_id ?? null, opts.status ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 200)]);
      return res.rows.map((r) => iso(r as Record<string, unknown>)) as Array<Record<string, JsonValue>>;
    });
  }

  /** Godta = en åpen oppfølging (`business_followups`, idempotent på forpliktelses-id) + status `accepted`; avvis = `dismissed`. Terminalt og enveis. Fristen er teksten sin egen, eierens, eller 7 dager (oppgitt i svaret). */
  async decide(ctx: MeetingContext, input: { commitment_id: string; decision: "accept" | "dismiss"; due_at?: string | undefined }): Promise<Record<string, JsonValue>> {
    const row = await withMemoryTransaction(this.deps.pool, ctx.tenantId, [ctx.space], async (client) => {
      const r = await client.query(`SELECT commitment_text, due_at, status, followup_id FROM comms_meeting_commitments WHERE tenant_id = $1 AND commitment_id = $2`, [ctx.tenantId, input.commitment_id]);
      return r.rows[0] as { commitment_text: string; due_at: Date | null; status: string; followup_id: string | null } | undefined;
    });
    if (row === undefined) throw new Error("meeting_commitment_not_found");
    if (row.status !== "proposed") return { commitment_id: input.commitment_id, status: row.status, followup_id: row.followup_id, already_decided: true };
    const now = this.deps.clock();
    let followupId: string | null = null;
    let dueSource: "owner" | "transcript" | "default_7_days" | null = null;
    if (input.decision === "accept") {
      if (this.deps.business === undefined) throw new Error("meeting_followups_not_available");
      const dueIso = input.due_at !== undefined ? input.due_at : row.due_at !== null ? row.due_at.toISOString() : new Date(now.getTime() + 7 * 86_400_000).toISOString();
      dueSource = input.due_at !== undefined ? "owner" : row.due_at !== null ? "transcript" : "default_7_days";
      const followup = await this.deps.business.createFollowup(ctx.tenantId, ctx.space, {
        title: Array.from(row.commitment_text).slice(0, 200).join(""), reason: "Møteforpliktelse (foreslått av Jarvis, godkjent av eieren)", next_action: row.commitment_text,
        due_at: dueIso, owner_person_id: ctx.actor.person_id, idempotency_key: `meeting-commitment:${input.commitment_id}`
      });
      followupId = followup.followup_id;
    }
    await withMemoryTransaction(this.deps.pool, ctx.tenantId, [ctx.space], async (client) => {
      await client.query(
        `UPDATE comms_meeting_commitments SET status = $3, followup_id = $4, decided_by_person_id = $5, decided_at = $6 WHERE tenant_id = $1 AND commitment_id = $2 AND status = 'proposed'`,
        [ctx.tenantId, input.commitment_id, input.decision === "accept" ? "accepted" : "dismissed", followupId, ctx.actor.person_id, now]);
    });
    return { commitment_id: input.commitment_id, status: input.decision === "accept" ? "accepted" : "dismissed", followup_id: followupId, ...(dueSource !== null ? { due_source: dueSource } : {}), already_decided: false };
  }

  /** Eierens bekreftelse av en deltaker -> identitet (eneste vei utover eksakt treff). Identiteten må tilhøre tenanten og være aktiv. */
  async confirmParticipant(ctx: MeetingContext, input: { meeting_id: string; participant_ref: string; identity_id: string }): Promise<{ confirmed: boolean }> {
    return withMemoryTransaction(this.deps.pool, ctx.tenantId, [ctx.space], async (client) => {
      const owned = await client.query(`SELECT 1 FROM conversation_identities WHERE tenant_id = $1 AND identity_id = $2 AND status = 'active'`, [ctx.tenantId, input.identity_id]);
      if ((owned.rowCount ?? 0) === 0) throw new Error("meeting_identity_not_found");
      const res = await client.query(
        `UPDATE comms_meeting_participants SET identity_id = $4, resolution = 'owner_confirmed', candidate_identity_id = NULL, confirmed_by_person_id = $5, confirmed_at = $6
         WHERE tenant_id = $1 AND meeting_id = $2 AND participant_ref = $3 AND resolution IN ('unresolved','candidate')`,
        [ctx.tenantId, input.meeting_id, input.participant_ref, input.identity_id, ctx.actor.person_id, this.deps.clock()]);
      return { confirmed: (res.rowCount ?? 0) === 1 };
    });
  }

  async deleteMeeting(ctx: MeetingContext, meetingId: string): Promise<{ deleted: boolean }> {
    return withMemoryTransaction(this.deps.pool, ctx.tenantId, [ctx.space], async (client) => {
      const res = await client.query(`DELETE FROM comms_meetings WHERE tenant_id = $1 AND meeting_id = $2`, [ctx.tenantId, meetingId]);
      return { deleted: (res.rowCount ?? 0) === 1 };
    });
  }

  /** Retensjonssveip: utløpte møter slettes (deltakere/forpliktelser følger via CASCADE). */
  async purgeExpired(tenantId: string, space: MemorySpace): Promise<number> {
    return withMemoryTransaction(this.deps.pool, tenantId, [space], async (client) => {
      const res = await client.query(`DELETE FROM comms_meetings WHERE tenant_id = $1 AND retention_until < $2`, [tenantId, this.deps.clock()]);
      return res.rowCount ?? 0;
    });
  }
}

function durationMs(parsed: ParsedTranscript): number | null {
  let max: number | null = null;
  for (const s of parsed.segments) if (s.end_ms !== null && (max === null || s.end_ms > max)) max = s.end_ms;
  return max;
}

function iso(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
}

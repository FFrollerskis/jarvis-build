import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, MemorySpace, TrustLevel } from "@jarvis/contracts";
import { containsSecret, writeAudit } from "@jarvis/core";
import type { PolicyGateway } from "@jarvis/policy";
import { classifyContentSensitivity } from "@jarvis/model-gateway";
import { assertLocalEmbedding, type EmbeddingProvider } from "./embedding.ts";
import { normalizeKeywords, type ExistingMemoryHint, type ExtractionAdapter, type ExtractionContext, type MemoryCandidate, type MemoryType } from "./extraction.ts";
import { withMemoryTransaction } from "./spaces.ts";
import { compileMemoryProfile } from "./profile.ts";
import { hasPgVector, similaritySql, upsertVector, vectorArg } from "./vectors.ts";

export interface SourceRef {
  kind: "conversation" | "document" | "tool" | "manual";
  ref: string;
  trust: TrustLevel;
}

export type ApplyOutcome =
  | { op: "ADD"; memory_item_id: string; status: "active" | "quarantined" }
  | { op: "UPDATE"; memory_item_id: string; version: number; conflict: boolean }
  | { op: "QUARANTINED_CONFLICT"; memory_item_id: string; conflicts_with: string }
  | { op: "NOOP"; memory_item_id: string }
  | { op: "INVALIDATE"; memory_item_id: string };

interface ItemRow {
  memory_item_id: string;
  content: string;
  subject: string;
  version: number;
  valid_from: Date;
  trust_level: TrustLevel;
  status: string;
  sensitivity: ItemSensitivity;
}

/**
 * Memory Writer (MEMORY_ARCHITECTURE §6): kontrollert skrivepunkt.
 * - untrusted kilde => karantene, aldri direkte autoritet (akseptanse 3)
 * - untrusted kan aldri overskrive trusted/internal innhold
 * - endringer versjoneres (motstrid markeres, skjules aldri)
 * - all skriving auditeres i samme transaksjon
 */
/**
 * D-386 (lukker D-376-gapet «sensitivitet fastsettes FØR lagring», MEMORY_ARCHITECTURE §6.6): sensitivitet per item
 * avgjøres av INNHOLDET, ikke bare rommet. Helse-/finans-/hemmelighetssignaler (samme deterministiske klassifisering
 * som ruteren bruker) ⇒ `special` uansett space, så faktumet senere kun går til lokal modell (D-384-regelen). Et
 * privat-/forretningssignal ⇒ `sensitive`. Helse-rommet er alltid `special`.
 */
export type ItemSensitivity = "normal" | "sensitive" | "special";

const ITEM_SENSITIVITY_RANK: Readonly<Record<ItemSensitivity, number>> = { normal: 0, sensitive: 1, special: 2 };

/**
 * D-449 (Q-50, gjennomgang nr. 2): en oppdatering regnet tidligere IKKE om `sensitivity` - helsetekst inn i et element merket `normal` ble stående som `normal` (og gamle versjoner med helsetekst
 * likeså). Nå er sensitiviteten det strengeste av den gamle og den nye tekstens, og senkes aldri av en harmløs senere tekst (en gammel versjon ligger fortsatt i `memory_versions`).
 */
export function stricterItemSensitivity(a: ItemSensitivity, b: ItemSensitivity): ItemSensitivity {
  return ITEM_SENSITIVITY_RANK[a] >= ITEM_SENSITIVITY_RANK[b] ? a : b;
}

export function itemSensitivity(space: MemorySpace, candidate: Pick<MemoryCandidate, "subject" | "content">): ItemSensitivity {
  if (space === "health") return "special";
  const level = classifyContentSensitivity({ texts: [`${candidate.subject} ${candidate.content}`] }).sensitivity;
  if (level === "SECRET_RESTRICTED") return "special";
  if (level === "PRIVATE" || level === "BUSINESS_CONFIDENTIAL") return "sensitive";
  return "normal";
}

/** D-386: viktighet når uttrekket ikke oppgir en (forpliktelser/beslutninger høyt, hendelser lavt). */
export const DEFAULT_IMPORTANCE: Readonly<Record<MemoryType, number>> = {
  commitment: 8, decision: 8, relation: 7, preference: 7, project: 6, semantic: 5, operational: 5, procedure: 5, episodic: 3
};

/** D-386 (§6.8): en betrodd kandidat under denne konfidensen blir KARANTENE (eieren godkjenner i dashbordet), aldri aktivt minne. */
export const CONFIDENCE_MIN_ACTIVE = 0.5;

const TRIVIAL_WORD = /^(hei+|hallo|heisann|hey|yo|takk|tusen|skal|du|ha|ok+|okei|okay|ja|nei|jepp|nope|greit|flott|bra|supert|perfekt|fint|hade|det|god|natt|morgen|morn|stopp|avbryt|hm+|æh+|eh+|mm+|ja+|nei+|jo)$/iu;

/**
 * D-386 (JARVIS-067): ytringer uten informasjonsverdi (hilsen/bekreftelse/for kort) skal ALDRI koste et LLM-uttrekk eller en
 * hint-spørring. Deterministisk, konservativ liste - heller ett unødvendig uttrekk for en tvilsom setning enn et tapt faktum.
 */
export function isTrivialUtterance(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return true;
  const words = t.toLowerCase().split(/[\s!.?,;:]+/u).filter((w) => w.length > 0);
  return words.length <= 4 && words.every((w) => TRIVIAL_WORD.test(w));
}

function contentHash(text: string): string {
  return createHash("sha256").update(text.normalize("NFKC").trim().toLowerCase()).digest("hex").slice(0, 32);
}

const PROPOSAL_MAX_SUBJECT = 120;
const PROPOSAL_MAX_CONTENT = 1000;
const PROPOSAL_TYPES: readonly MemoryType[] = [
  "semantic", "episodic", "preference", "procedure", "relation", "project", "operational", "decision", "commitment"
];

export class MemoryWriter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly embeddings: EmbeddingProvider,
    private readonly extractor: ExtractionAdapter,
    private readonly policy: PolicyGateway
  ) {
    assertLocalEmbedding(embeddings);
  }

  /**
   * Registrer kilde + (D-386) lagre eierens VERBATIM ytring som episode + trekk ut kandidater + anvend dem.
   * - Trivielle ytringer (hilsen/bekreftelse) hopper over alt (JARVIS-067).
   * - Episoden er lag 1 for samtale: søkbar verbatim («struktur skal utfylle verbatim tekst, ikke erstatte den»), og hvert
   *   uttrukket faktum peker tilbake på den (`evidence_episode_id`). Kun betrodde samtalekilder - innlimt/ubetrodd tekst er
   *   ikke eierens egne ord og lagres ikke verbatim.
   * - Hver kandidat anvendes ISOLERT: en feil (f.eks. UNIQUE-race når to meldinger lærer samme emne samtidig) mister aldri
   *   resten av kandidatene; en race prøves én gang til (raden finnes nå → oppdateringsgrenen).
   * - `op: "INVALIDATE"` (eieren sier at noe ikke lenger gjelder) invaliderer det eksisterende minnet - aldri sletting.
   */
  async ingestText(
    identity: IdentityContext,
    source: SourceRef,
    text: string,
    opts: { recent_turns?: ExtractionContext["recent_turns"]; channel?: string } = {}
  ): Promise<ApplyOutcome[]> {
    // Del 3 (JARVIS-013): tekst med en kjent hemmelighet lagres ALDRI i minnet (kallere redigerer først; dette er siste forsvar).
    if (containsSecret(text)) return [];
    if (isTrivialUtterance(text)) return [];
    const observedAt = new Date().toISOString();
    const space = identity.memory_space_id as MemorySpace;
    const episodeId = source.kind === "conversation" && source.trust !== "untrusted"
      ? await this.persistEpisode(identity, space, text, source.trust, observedAt, opts.channel ?? identity.channel)
      : undefined;
    // D-373: kun BETRODDE kilder får se eksisterende minner (ubetrodd innhold skal aldri trekke ut/avsløre autoritativt minne).
    const hints = source.trust === "untrusted" ? [] : await this.relatedHints(identity, text);
    const candidates = await this.extractor.extract(text, identity, source.trust, hints, {
      observed_at: observedAt,
      ...(opts.recent_turns ? { recent_turns: opts.recent_turns } : {})
    });
    const outcomes: ApplyOutcome[] = [];
    for (const candidate of candidates) {
      const meta = { observedAt, ...(episodeId ? { evidenceEpisodeId: episodeId } : {}) };
      try {
        if (candidate.op === "INVALIDATE") {
          if (source.trust !== "untrusted") {
            const out = await this.invalidateBySubject(identity, space, candidate.type, candidate.subject, "owner_negation");
            if (out) outcomes.push(out);
          }
          continue;
        }
        outcomes.push(await this.apply(identity, source, candidate, meta));
      } catch (err) {
        let failure: unknown = err;
        if ((err as { code?: string }).code === "23505") {
          // Subjekt-race: en annen melding lærte samme (type, subject) mellom oppslaget og INSERT - raden finnes nå, så en ny
          // runde går deterministisk i oppdateringsgrenen i stedet for å miste kandidaten.
          try {
            outcomes.push(await this.apply(identity, source, candidate, meta));
            continue;
          } catch (retryErr) {
            failure = retryErr;
          }
        }
        console.error(JSON.stringify({ msg: "memory_candidate_apply_failed", subject: candidate.subject, type: candidate.type, error: (failure as Error).message.slice(0, 200) }));
      }
    }
    // D-386: profilen (alltid-tilstede blokk) rekompileres når et varig faktum ble lagt til/oppdatert/invalidert - billig og
    // deterministisk; feil her skal aldri velte selve lagringen (nattlig sveip tar det uansett).
    if (outcomes.some((o) => o.op !== "NOOP")) {
      try {
        await compileMemoryProfile(this.pool, identity.tenant_id, space);
      } catch (err) {
        console.error(JSON.stringify({ msg: "memory_profile_compile_failed", error: (err as Error).message.slice(0, 200) }));
      }
    }
    return outcomes;
  }

  /** D-386: verbatim ytring som episode (dedupe per sesjon på innholdshash). Vektor skrives forsøksvis; feil velter ikke lagringen. */
  private async persistEpisode(identity: IdentityContext, space: MemorySpace, text: string, trust: TrustLevel, observedAt: string, channel: string): Promise<string> {
    const hash = contentHash(text);
    const sensitivity = itemSensitivity(space, { subject: "", content: text });
    return withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) => {
      const existing = await client.query(
        "SELECT episode_id FROM memory_episodes WHERE tenant_id = $1 AND space = $2 AND session_id = $3 AND content_hash = $4",
        [identity.tenant_id, space, identity.session_id, hash]
      );
      const found = (existing.rows[0] as { episode_id: string } | undefined)?.episode_id;
      if (found) return found;
      const id = `ep-${randomUUID()}`;
      await client.query(
        `INSERT INTO memory_episodes (episode_id, tenant_id, space, owner_person_id, session_id, channel, role, content, content_hash, observed_at, sensitivity, trust_level)
         VALUES ($1, $2, $3, $4, $5, $6, 'user', $7, $8, $9, $10, $11)`,
        [id, identity.tenant_id, space, identity.person_id, identity.session_id, channel, text, hash, observedAt, sensitivity, trust]
      );
      try {
        const vector = await this.embeddings.embed(text);
        await upsertVector(client, this.pool, { kind: "episode", id, tenantId: identity.tenant_id, space }, this.embeddings, vector);
      } catch (err) {
        console.error(JSON.stringify({ msg: "memory_embedding_failed", model: this.embeddings.model, episode_id: id, error: (err as Error).message.slice(0, 200) }));
      }
      await writeAudit(client, identity, { type: "memory.episode", payload: { episode_id: id, sensitivity } });
      return id;
    });
  }

  /** D-386: eierens negasjon («glem at …», «ikke lenger …») invaliderer det aktive minnet for (type, subject). Null når ingen finnes. */
  async invalidateBySubject(identity: IdentityContext, space: MemorySpace, type: MemoryType, subject: string, reason: string): Promise<ApplyOutcome | null> {
    const row = await withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) =>
      (await client.query(
        "SELECT memory_item_id FROM memory_items WHERE tenant_id = $1 AND space = $2 AND type = $3 AND subject = $4 AND status = 'active'",
        [identity.tenant_id, space, type, subject]
      )).rows[0] as { memory_item_id: string } | undefined
    );
    if (!row) return null;
    return this.invalidate(identity, space, row.memory_item_id, reason);
  }

  /**
   * D-373: de mest relevante aktive, betrodde minnene i identitetens space (ordoverlapp mot teksten + de nyeste), så uttrekket kan
   * gjenbruke samme `subject` for samme fakta. Fail-soft: en feil her gir ingen hint (som før D-373), aldri en kastet feil.
   */
  private async relatedHints(identity: IdentityContext, text: string): Promise<ExistingMemoryHint[]> {
    try {
      const space = identity.memory_space_id as MemorySpace;
      const rows = await withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) => {
        const res = await client.query(
          `SELECT type, subject, content FROM memory_items
           WHERE tenant_id = $1 AND space = $2 AND status = 'active' AND trust_level <> 'untrusted'
           ORDER BY updated_at DESC LIMIT 200`,
          [identity.tenant_id, space]
        );
        return res.rows as ExistingMemoryHint[];
      });
      const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-zæøå0-9]+/).filter((t) => t.length >= 3));
      const wanted = tokens(text);
      const scored = rows.map((r, index) => {
        let overlap = 0;
        for (const t of tokens(`${r.subject} ${r.content}`)) if (wanted.has(t)) overlap++;
        return { r, index, overlap };
      });
      const picked = new Map<string, ExistingMemoryHint>();
      // D-386: semantiske naboer FØRST (ekte modell) - fanger «samme ting, andre ord» som ordoverlapp aldri ser. Hash-provideren
      // hoppes over (dens naboer er støy). Fail-soft.
      for (const r of await this.semanticNeighbours(identity, space, text)) picked.set(`${r.type}\u0000${r.subject}`, r);
      for (const x of [...scored].sort((a, b) => b.overlap - a.overlap || a.index - b.index).filter((x) => x.overlap > 0).slice(0, 12)) {
        picked.set(`${x.r.type}\u0000${x.r.subject}`, x.r);
      }
      for (const x of scored.slice(0, 12)) picked.set(`${x.r.type}\u0000${x.r.subject}`, x.r);
      return [...picked.values()].slice(0, 24);
    } catch {
      return [];
    }
  }

  private async semanticNeighbours(identity: IdentityContext, space: MemorySpace, text: string): Promise<ExistingMemoryHint[]> {
    if (this.embeddings.model === "local-hash-v1") return [];
    try {
      const vector = await this.embeddings.embed(text);
      return await withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) => {
        const pgv = await hasPgVector(client, this.pool);
        const sim = similaritySql(this.embeddings, pgv, "$1");
        const res = await client.query(
          `SELECT m.type, m.subject, m.content
             FROM memory_vectors v JOIN memory_items m ON m.memory_item_id = v.ref_id
            WHERE v.ref_kind = 'item' AND v.model = $2 AND v.dim = $3 AND m.status = 'active' AND m.trust_level <> 'untrusted'
              AND ${sim} >= $4
            ORDER BY ${sim} DESC LIMIT 8`,
          [vectorArg(pgv, vector), this.embeddings.model, this.embeddings.dim, this.embeddings.minSimilarity]
        );
        return res.rows as ExistingMemoryHint[];
      });
    } catch {
      return [];
    }
  }

  async apply(
    identity: IdentityContext,
    source: SourceRef,
    candidate: MemoryCandidate,
    meta: { observedAt?: string; evidenceEpisodeId?: string } = {}
  ): Promise<ApplyOutcome> {
    const space = candidate.space;
    return withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) => {
      const sourceId = await this.ensureSource(client, identity.tenant_id, source);
      const observedAt = candidate.observed_at ?? meta.observedAt ?? new Date().toISOString();

      // D-357 (funn ved kildekode-gjennomgang, IKKE rapportert av Tobias): raden
      // MÅ inkludere 'invalidated' her, ikke bare 'active'/'quarantined'. Uten
      // dette blir en tidligere INVALIDERT rad (f.eks. D-287 sin 60-dagers
      // retensjons-sveip, eller en eksplisitt `invalidate()`) usynlig for DETTE
      // oppslaget - `!row` under blir sann selv om en rad FAKTISK eksisterer for
      // (tenant_id, space, type, subject) - og `insertItem()` under kaster da en
      // rå Postgres UNIQUE-krasj (`008_memory.sql` sin
      // `UNIQUE (tenant_id, space, type, subject)`-begrensning dekker ALLE
      // statuser, ikke bare aktive). Siden `ConversationEngine` sitt kall til
      // `memory.ingest()` er fire-and-forget og SVELGER feil (D-283s kommentar i
      // `conversation.ts`), var den observerbare konsekvensen en STILLE, permanent
      // "dette faktumet kan ALDRI læres på nytt" - nøyaktig samme symptomklasse
      // ("husker ingenting") som D-300 fant en ANNEN rotårsak til (for smal
      // regelbasert uttrekking) - dette er en TREDJE, uavhengig årsak til samme
      // symptom, oppdaget ved lesing, ikke ved en ny Tobias-rapport.
      const existing = await client.query(
        `SELECT memory_item_id, content, subject, version, valid_from, trust_level, status, sensitivity
         FROM memory_items
         WHERE tenant_id = $1 AND space = $2 AND type = $3 AND subject = $4
           AND status IN ('active','quarantined','invalidated')`,
        [identity.tenant_id, space, candidate.type, candidate.subject]
      );
      const row = existing.rows[0] as ItemRow | undefined;

      if (!row) {
        // D-373: NØYAKTIG samme innhold finnes allerede aktivt under et annet emne -> ingen duplikatrad. Sammenlignes i JS
        // (ikke `lower()` i SQL: den følger databasens locale og lowercaser ikke Æ/Ø/Å i C-locale). Begrenset til de 500
        // nyeste aktive radene av samme type/space.
        const wantedContent = candidate.content.trim().toLowerCase();
        const recent = await client.query(
          `SELECT memory_item_id, content FROM memory_items
           WHERE tenant_id = $1 AND space = $2 AND type = $3 AND status = 'active'
           ORDER BY updated_at DESC LIMIT 500`,
          [identity.tenant_id, space, candidate.type]
        );
        const dup = (recent.rows as Array<{ memory_item_id: string; content: string }>).find(
          (r) => r.content.trim().toLowerCase() === wantedContent
        );
        if (dup) {
          await writeAudit(client, identity, { type: "memory.noop", payload: { memory_item_id: dup.memory_item_id, reason: "duplicate_content" } });
          return { op: "NOOP", memory_item_id: dup.memory_item_id } as const;
        }
        // D-386 (§6.8): ubetrodd kilde ⇒ karantene; en betrodd kandidat med LAV konfidens (gjetning, mishørt tale) ⇒ også karantene
        // (eieren godkjenner i dashbordet) - aldri stille et aktivt, autoritativt minne.
        const lowConfidence = source.trust !== "untrusted" && candidate.confidence < CONFIDENCE_MIN_ACTIVE;
        const status = source.trust === "untrusted" || lowConfidence ? "quarantined" : "active";
        const id = await this.insertItem(client, identity, space, candidate, sourceId, observedAt, source.trust, status, meta.evidenceEpisodeId);
        if (status === "active") {
          await this.writeEmbedding(client, identity.tenant_id, space, id, candidate);
          await this.linkEntities(client, identity.tenant_id, space, id, candidate);
        }
        await writeAudit(client, identity, {
          type: "memory.add",
          payload: { memory_item_id: id, status, subject: candidate.subject, ...(lowConfidence ? { reason: "low_confidence" } : {}) }
        });
        return { op: "ADD", memory_item_id: id, status } as const;
      }

      // D-357: en tidligere INVALIDERT rad må ALDRI behandles som et stille NOOP
      // selv om innholdet er byte-for-byte likt det som ble invalidert - et
      // faktum som "blir sant igjen" er en reell statusendring (invalidated ->
      // active/quarantined), ALDRI en no-op, ellers forblir raden permanent
      // usynlig for lesing (`status='invalidated'`) uansett hvor mange ganger
      // det gjentas. NOOP-optimaliseringen gjelder derfor KUN en allerede-synlig
      // (active/quarantined) rad, uendret fra før.
      const normalized = (s: string) => s.trim().toLowerCase();
      if (row.status !== "invalidated" && normalized(row.content) === normalized(candidate.content)) {
        await writeAudit(client, identity, { type: "memory.noop", payload: { memory_item_id: row.memory_item_id } });
        return { op: "NOOP", memory_item_id: row.memory_item_id } as const;
      }

      // Untrusted kan aldri overskrive eksisterende trusted/internal innhold -
      // men KUN relevant for en CURRENTLY LIVE (active/quarantined) rad; en
      // invalidert rad har INGEN nåværende sannhet å beskytte, så gjenoppliving
      // av den går ALLTID til den generelle oppdaterings-/gjenopplivings-grenen
      // under (som selv avgjør ny status ut fra `source.trust`, SAMME regel som
      // `!row`-grenen over bruker for et helt nytt faktum).
      if (source.trust === "untrusted" && row.status !== "invalidated" && row.trust_level !== "untrusted") {
        const id = await this.insertItem(
          client, identity, space,
          { ...candidate, subject: `${candidate.subject}#quarantined-${randomUUID().slice(0, 8)}` },
          sourceId, observedAt, "untrusted", "quarantined"
        );
        await client.query("UPDATE memory_items SET has_conflict = true, updated_at = now() WHERE memory_item_id = $1", [
          row.memory_item_id
        ]);
        await writeAudit(client, identity, {
          type: "memory.quarantined_conflict",
          payload: { candidate_item: id, conflicts_with: row.memory_item_id }
        });
        return { op: "QUARANTINED_CONFLICT", memory_item_id: id, conflicts_with: row.memory_item_id } as const;
      }

      // D-357: gjenopplivings-status for en tidligere INVALIDERT rad følger
      // NØYAKTIG samme regel som `!row`-grenen over (trusted -> active,
      // untrusted -> quarantined, krever samme eksplisitte
      // `promoteFromQuarantine()`-godkjenning som ethvert nytt untrusted
      // faktum). En allerede LIVE rad (active/quarantined) beholder sin
      // EKSISTERENDE status UENDRET her - en vanlig oppdatering av et
      // quarantined faktum forfremmer det ALDRI stille til active (§"aldri
      // automatisk" i `promoteFromQuarantine()` sin klassekommentar gjelder
      // identisk for denne grenen, ikke bare den eksplisitte godkjenningsveien).
      // D-386: eierens EGNE, betrodde ord overstyrer en karantenert rad for samme emne (f.eks. først sett i en innlimt e-post) -
      // raden blir aktiv i stedet for at eierens utsagn forblir usynlig for alltid. Ubetrodd/lav konfidens beholder karantenen.
      const trustedOverride = row.status === "quarantined" && source.trust === "trusted" && candidate.confidence >= CONFIDENCE_MIN_ACTIVE;
      const newStatus =
        row.status === "invalidated"
          ? (source.trust === "untrusted" ? "quarantined" : "active")
          : trustedOverride ? "active" : row.status;

      // Versjoner den gamle sannheten (bitemporalt: gyldig til nå), oppdater itemet.
      await client.query(
        `INSERT INTO memory_versions
           (memory_item_id, tenant_id, space, version, subject, content, valid_from, valid_to, change_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 'superseded')`,
        [row.memory_item_id, identity.tenant_id, space, row.version, row.subject, row.content, row.valid_from]
      );
      const newVersion = row.version + 1;
      // D-386: bitemporalt - `valid_from` er NÅR det nye gjelder i verden (hendelsestid når kjent), `observed_at` når vi fikk vite det;
      // `has_conflict` kun ved reell motstrid (modellen avgjør; ukjent ⇒ true som før), ikke ved enhver presisering.
      await client.query(
        `UPDATE memory_items
           SET content = $2, version = $3, observed_at = $4, valid_from = COALESCE($8::timestamptz, now()),
               trust_level = $5, confidence = $6, has_conflict = $9, updated_at = now(),
               status = $7, valid_to = NULL,
               importance = COALESCE($10, importance), keywords = $11, event_time_raw = COALESCE($12, event_time_raw),
               evidence_episode_id = COALESCE($13, evidence_episode_id), sensitivity = $14
         WHERE memory_item_id = $1`,
        [
          row.memory_item_id, candidate.content, newVersion, observedAt, source.trust, candidate.confidence, newStatus,
          candidate.event_time ?? null, candidate.contradicts_existing ?? true, candidate.importance ?? null,
          normalizeKeywords(candidate.keywords), candidate.event_time_raw ?? null, meta.evidenceEpisodeId ?? null,
          stricterItemSensitivity(row.sensitivity, itemSensitivity(space, { subject: row.subject, content: candidate.content }))
        ]
      );
      if (candidate.entities && candidate.entities.length > 0 && newStatus === "active") {
        await this.linkEntities(client, identity.tenant_id, space, row.memory_item_id, candidate);
      }
      // UENDRET fra før D-357: writeEmbedding() kalles ubetinget på enhver
      // oppdatering (også en som forblir 'quarantined') - IKKE endret her for å
      // holde denne fiksen avgrenset til re-add-etter-invalidert-bugen alene;
      // en eventuell innstramming av embedding-skriving for ikke-aktive rader
      // er en egen, separat vurdering (krever å lese `retriever.ts` sin
      // status-filtrering FØR den endres), ikke gjort blindt her.
      await this.writeEmbedding(client, identity.tenant_id, space, row.memory_item_id, candidate);
      await writeAudit(client, identity, {
        type: "memory.update",
        payload: { memory_item_id: row.memory_item_id, version: newVersion, status: newStatus }
      });
      return { op: "UPDATE", memory_item_id: row.memory_item_id, version: newVersion, conflict: candidate.contradicts_existing ?? true } as const;
    });
  }

  async invalidate(identity: IdentityContext, space: MemorySpace, itemId: string, reason: string): Promise<ApplyOutcome> {
    return withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) => {
      const existing = await client.query(
        `SELECT version, subject, content, valid_from FROM memory_items
         WHERE memory_item_id = $1 AND status = 'active'`,
        [itemId]
      );
      const row = existing.rows[0] as ItemRow | undefined;
      if (!row) {
        throw new Error("memory_item_not_found");
      }
      await client.query(
        `INSERT INTO memory_versions
           (memory_item_id, tenant_id, space, version, subject, content, valid_from, valid_to, change_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 'invalidated')`,
        [itemId, identity.tenant_id, space, row.version, row.subject, row.content, row.valid_from]
      );
      await client.query(
        `UPDATE memory_items SET status = 'invalidated', valid_to = now(), updated_at = now() WHERE memory_item_id = $1`,
        [itemId]
      );
      await writeAudit(client, identity, { type: "memory.invalidate", payload: { memory_item_id: itemId, reason } });
      return { op: "INVALIDATE", memory_item_id: itemId } as const;
    });
  }

  /**
   * D-367: modell-initiert «husk dette» - ALLTID karantene, aldri direkte autoritativt minne (regel 7).
   * Kilden er `tool`/untrusted (aldri `conversation`/trusted som automatisk uttrekk bruker), så `apply()` gir
   * `quarantined` (og skriver ingen embedding, så det kommer aldri fram i `search()` før eieren godkjenner).
   * Space er ALLTID `identity.memory_space_id` - modellen kan ikke velge space. Et forslag kan aldri overskrive
   * en trusted/aktiv rad (`apply()` gir da QUARANTINED_CONFLICT med eget emne).
   */
  async propose(
    identity: IdentityContext,
    input: { subject: string; content: string; type?: MemoryType; owner_stated?: boolean }
  ): Promise<ApplyOutcome & { auto_approved?: boolean }> {
    const subject = typeof input.subject === "string" ? input.subject.trim() : "";
    const content = typeof input.content === "string" ? input.content.trim() : "";
    const type = input.type ?? "semantic";
    // eslint-disable-next-line no-control-regex
    const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
    if (subject.length < 1 || subject.length > PROPOSAL_MAX_SUBJECT || CONTROL.test(subject)) throw new Error("invalid_proposal_subject");
    if (content.length < 1 || content.length > PROPOSAL_MAX_CONTENT || CONTROL.test(content)) throw new Error("invalid_proposal_content");
    if (!PROPOSAL_TYPES.includes(type)) throw new Error("invalid_proposal_type");
    if (containsSecret(subject) || containsSecret(content)) throw new Error("invalid_proposal_secret");
    const candidate: MemoryCandidate = {
      space: identity.memory_space_id as MemorySpace,
      type, subject, content, confidence: 0.5
    };
    // D-369 (revidert): eieren ba UTTRYKKELIG om dette i samme tur (avgjort deterministisk av kalleren, `ownerStatesMemory`). Da regnes
    // innholdet som eierens egne ord - SAMME tillitsnivå og versjonering som D-283 sin automatiske lagring av eierens meldinger
    // (ADD / UPDATE med bevart historikk og motstrid markert / NOOP), IKKE en karantene-konflikt mot eksisterende minne. Policy
    // Gateway (klasse B, aktiv auth) må fortsatt tillate det; ved DENY faller vi tilbake til vanlig karantene-forslag under.
    if (input.owner_stated === true) {
      const decision = await this.policy.authorize({
        identity,
        toolCall: { tool_id: "memory", action: "auto_approve_owner_stated", capability_class: "B", parameters: { subject } }
      });
      if (decision.decision === "ALLOW") {
        const applied = await this.apply(identity, { kind: "tool", ref: `memory.propose.owner:${identity.session_id}`, trust: "trusted" }, candidate);
        await withMemoryTransaction(this.pool, identity.tenant_id, [candidate.space], (client) =>
          writeAudit(client, identity, {
            type: "memory.auto_approved",
            payload: { memory_item_id: applied.memory_item_id, op: applied.op, reason: "owner_explicit_request" }
          })
        );
        return { ...applied, auto_approved: true };
      }
    }
    const outcome = await this.apply(identity, { kind: "tool", ref: `memory.propose:${identity.session_id}`, trust: "untrusted" }, candidate);
    return input.owner_stated === true ? { ...outcome, auto_approved: false } : outcome;
  }

  /** Åpne (karantene-)forslag fra `memory.propose` for eierens space - kun lesing, kun forslag (kilde `tool`). */
  async listProposals(identity: IdentityContext): Promise<Array<{ memory_item_id: string; subject: string; content: string; type: string; proposed_at: string }>> {
    const space = identity.memory_space_id as MemorySpace;
    return withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) => {
      const result = await client.query(
        `SELECT m.memory_item_id, m.subject, m.content, m.type, m.observed_at
           FROM memory_items m JOIN memory_sources s ON s.source_id = m.source_id
          WHERE m.tenant_id = $1 AND m.space = $2 AND m.owner_person_id = $3
            AND m.status = 'quarantined' AND s.kind IN ('tool', 'conversation')
          ORDER BY m.observed_at DESC LIMIT 50`,
        [identity.tenant_id, space, identity.person_id]
      );
      return result.rows.map((r: { memory_item_id: string; subject: string; content: string; type: string; observed_at: Date | string }) => ({
        memory_item_id: r.memory_item_id, subject: r.subject, content: r.content, type: r.type,
        proposed_at: new Date(r.observed_at).toISOString()
      }));
    });
  }

  /** Eierens avvisning av et karantene-forslag: invalideres (ikke slettet - sporbart), aldri autoritativt. Klasse B via Policy Gateway. */
  async rejectFromQuarantine(identity: IdentityContext, space: MemorySpace, itemId: string): Promise<boolean> {
    const decision = await this.policy.authorize({
      identity,
      toolCall: { tool_id: "memory", action: "reject_quarantined", capability_class: "B", parameters: { memory_item_id: itemId } }
    });
    if (decision.decision !== "ALLOW") return false;
    return withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) => {
      const result = await client.query(
        `UPDATE memory_items SET status = 'invalidated', valid_to = now(), updated_at = now()
          WHERE memory_item_id = $1 AND tenant_id = $2 AND space = $3 AND status = 'quarantined'
          RETURNING memory_item_id`,
        [itemId, identity.tenant_id, space]
      );
      if (result.rowCount === 0) return false;
      await writeAudit(client, identity, { type: "memory.rejected", payload: { memory_item_id: itemId } });
      return true;
    });
  }

  /**
   * Godkjenningssteget som gjør karantene-innhold autoritativt (akseptanse 3).
   * Går gjennom Policy Gateway (klasse B) - aldri automatisk.
   */
  async promoteFromQuarantine(identity: IdentityContext, space: MemorySpace, itemId: string): Promise<boolean> {
    const decision = await this.policy.authorize({
      identity,
      toolCall: {
        tool_id: "memory",
        action: "promote_quarantined",
        capability_class: "B",
        parameters: { memory_item_id: itemId }
      }
    });
    if (decision.decision !== "ALLOW") {
      return false;
    }
    return withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) => {
      const result = await client.query(
        `UPDATE memory_items SET status = 'active', trust_level = 'internal', updated_at = now()
         WHERE memory_item_id = $1 AND status = 'quarantined'
         RETURNING subject, content, type`,
        [itemId]
      );
      const row = result.rows[0] as { subject: string; content: string; type: MemoryCandidate["type"] } | undefined;
      if (!row) {
        return false;
      }
      await this.writeEmbedding(client, identity.tenant_id, space, itemId, {
        subject: row.subject, content: row.content
      });
      await writeAudit(client, identity, { type: "memory.promoted", payload: { memory_item_id: itemId } });
      return true;
    });
  }

  private async ensureSource(client: pg.PoolClient, tenantId: string, source: SourceRef): Promise<string> {
    // Tenant-skopet ID: en delt ID på tvers av tenants ville gitt en kilde-rad
    // eid av én tenant som andre tenants ikke ser under RLS (JOIN mister radene).
    const sourceId = `src-${tenantId}-${source.kind}-${source.ref}`;
    await client.query(
      `INSERT INTO memory_sources (source_id, tenant_id, kind, ref, trust_level)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (source_id) DO NOTHING`,
      [sourceId, tenantId, source.kind, source.ref, source.trust]
    );
    return sourceId;
  }

  private async insertItem(
    client: pg.PoolClient,
    identity: IdentityContext,
    space: MemorySpace,
    candidate: MemoryCandidate,
    sourceId: string,
    observedAt: string,
    trust: TrustLevel,
    status: "active" | "quarantined",
    evidenceEpisodeId?: string
  ): Promise<string> {
    const id = `mem-${randomUUID()}`;
    await client.query(
      `INSERT INTO memory_items
         (memory_item_id, tenant_id, space, owner_person_id, type, subject, content, source_id,
          observed_at, valid_from, sensitivity, trust_level, confidence, status,
          importance, keywords, event_time_raw, evidence_episode_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($14::timestamptz, $9),$10,$11,$12,$13,$15,$16,$17,$18)`,
      [
        id, identity.tenant_id, space, identity.person_id, candidate.type, candidate.subject,
        candidate.content, sourceId, observedAt,
        itemSensitivity(space, candidate), trust, candidate.confidence, status,
        candidate.event_time ?? null, candidate.importance ?? DEFAULT_IMPORTANCE[candidate.type],
        normalizeKeywords(candidate.keywords), candidate.event_time_raw ?? null, evidenceEpisodeId ?? null
      ]
    );
    return id;
  }

  /**
   * D-386: vektor til det modellbevisste `memory_vectors` (068); den frosne `embeddings`-tabellen skrives ikke lenger.
   * En feil i embedding-tjenesten (Ollama nede, dimensjonsfeil) skal ALDRI velte selve minneskrivingen - faktumet
   * lagres uansett (fulltekst virker), feilen logges, og `runMemoryReembedSweep` fyller vektoren senere.
   */
  private async writeEmbedding(
    client: pg.PoolClient,
    tenantId: string,
    space: MemorySpace,
    itemId: string,
    candidate: Pick<MemoryCandidate, "subject" | "content">
  ): Promise<void> {
    let vector: number[];
    try {
      vector = await this.embeddings.embed(`${candidate.subject} ${candidate.content}`);
    } catch (err) {
      console.error(JSON.stringify({ msg: "memory_embedding_failed", model: this.embeddings.model, memory_item_id: itemId, error: (err as Error).message.slice(0, 200) }));
      return;
    }
    await upsertVector(client, this.pool, { kind: "item", id: itemId, tenantId, space }, this.embeddings, vector);
  }

  private async linkEntities(
    client: pg.PoolClient,
    tenantId: string,
    space: MemorySpace,
    itemId: string,
    candidate: MemoryCandidate
  ): Promise<void> {
    for (const entity of candidate.entities ?? []) {
      const key = `${entity.kind}:${entity.name.toLowerCase()}`;
      // D-386 (JARVIS-076): entity_id er PK uten tenant - samme (kind, name) i to tenanter kolliderte. Tenant-skopet hash-id.
      const entityId = `ent-${createHash("sha256").update(`${tenantId}\u0000${key}`).digest("hex").slice(0, 24)}`;
      await client.query(
        `INSERT INTO entities (entity_id, tenant_id, space, kind, name, canonical_key)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, canonical_key) DO NOTHING`,
        [entityId, tenantId, space, entity.kind, entity.name, key]
      );
      await client.query(
        `INSERT INTO memory_item_entities (memory_item_id, entity_id, tenant_id, space)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [itemId, entityId, tenantId, space]
      );
    }
  }
}

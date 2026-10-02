import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, MemorySpace, TrustLevel } from "@jarvis/contracts";
import { writeAudit } from "@jarvis/core";
import type { PolicyGateway } from "@jarvis/policy";
import type { EmbeddingProvider } from "./embedding.ts";
import type { ExtractionAdapter, MemoryCandidate, MemoryType } from "./extraction.ts";
import { withMemoryTransaction } from "./spaces.ts";

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
}

/**
 * Memory Writer (MEMORY_ARCHITECTURE §6): kontrollert skrivepunkt.
 * - untrusted kilde => karantene, aldri direkte autoritet (akseptanse 3)
 * - untrusted kan aldri overskrive trusted/internal innhold
 * - endringer versjoneres (motstrid markeres, skjules aldri)
 * - all skriving auditeres i samme transaksjon
 */
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
  ) {}

  /** Registrer kilde + trekk ut kandidater + anvend dem. */
  async ingestText(identity: IdentityContext, source: SourceRef, text: string): Promise<ApplyOutcome[]> {
    const candidates = await this.extractor.extract(text, identity, source.trust);
    const outcomes: ApplyOutcome[] = [];
    for (const candidate of candidates) {
      outcomes.push(await this.apply(identity, source, candidate));
    }
    return outcomes;
  }

  async apply(identity: IdentityContext, source: SourceRef, candidate: MemoryCandidate): Promise<ApplyOutcome> {
    const space = candidate.space;
    return withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) => {
      const sourceId = await this.ensureSource(client, identity.tenant_id, source);
      const observedAt = candidate.observed_at ?? new Date().toISOString();

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
        `SELECT memory_item_id, content, subject, version, valid_from, trust_level, status
         FROM memory_items
         WHERE tenant_id = $1 AND space = $2 AND type = $3 AND subject = $4
           AND status IN ('active','quarantined','invalidated')`,
        [identity.tenant_id, space, candidate.type, candidate.subject]
      );
      const row = existing.rows[0] as ItemRow | undefined;

      if (!row) {
        const status = source.trust === "untrusted" ? "quarantined" : "active";
        const id = await this.insertItem(client, identity, space, candidate, sourceId, observedAt, source.trust, status);
        if (status === "active") {
          await this.writeEmbedding(client, identity.tenant_id, space, id, candidate);
          await this.linkEntities(client, identity.tenant_id, space, id, candidate);
        }
        await writeAudit(client, identity, {
          type: "memory.add",
          payload: { memory_item_id: id, status, subject: candidate.subject }
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
      const newStatus =
        row.status === "invalidated" ? (source.trust === "untrusted" ? "quarantined" : "active") : row.status;

      // Versjoner den gamle sannheten (bitemporalt: gyldig til nå), oppdater itemet.
      await client.query(
        `INSERT INTO memory_versions
           (memory_item_id, tenant_id, space, version, subject, content, valid_from, valid_to, change_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 'superseded')`,
        [row.memory_item_id, identity.tenant_id, space, row.version, row.subject, row.content, row.valid_from]
      );
      const newVersion = row.version + 1;
      await client.query(
        `UPDATE memory_items
           SET content = $2, version = $3, observed_at = $4, valid_from = now(),
               trust_level = $5, confidence = $6, has_conflict = true, updated_at = now(),
               status = $7, valid_to = NULL
         WHERE memory_item_id = $1`,
        [row.memory_item_id, candidate.content, newVersion, observedAt, source.trust, candidate.confidence, newStatus]
      );
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
      return { op: "UPDATE", memory_item_id: row.memory_item_id, version: newVersion, conflict: true } as const;
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
    input: { subject: string; content: string; type?: MemoryType }
  ): Promise<ApplyOutcome> {
    const subject = typeof input.subject === "string" ? input.subject.trim() : "";
    const content = typeof input.content === "string" ? input.content.trim() : "";
    const type = input.type ?? "semantic";
    // eslint-disable-next-line no-control-regex
    const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
    if (subject.length < 1 || subject.length > PROPOSAL_MAX_SUBJECT || CONTROL.test(subject)) throw new Error("invalid_proposal_subject");
    if (content.length < 1 || content.length > PROPOSAL_MAX_CONTENT || CONTROL.test(content)) throw new Error("invalid_proposal_content");
    if (!PROPOSAL_TYPES.includes(type)) throw new Error("invalid_proposal_type");
    const candidate: MemoryCandidate = {
      space: identity.memory_space_id as MemorySpace,
      type, subject, content, confidence: 0.5
    };
    return this.apply(identity, { kind: "tool", ref: `memory.propose:${identity.session_id}`, trust: "untrusted" }, candidate);
  }

  /** Åpne (karantene-)forslag fra `memory.propose` for eierens space - kun lesing, kun forslag (kilde `tool`). */
  async listProposals(identity: IdentityContext): Promise<Array<{ memory_item_id: string; subject: string; content: string; type: string; proposed_at: string }>> {
    const space = identity.memory_space_id as MemorySpace;
    return withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) => {
      const result = await client.query(
        `SELECT m.memory_item_id, m.subject, m.content, m.type, m.observed_at
           FROM memory_items m JOIN memory_sources s ON s.source_id = m.source_id
          WHERE m.tenant_id = $1 AND m.space = $2 AND m.owner_person_id = $3
            AND m.status = 'quarantined' AND s.kind = 'tool'
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
    status: "active" | "quarantined"
  ): Promise<string> {
    const id = `mem-${randomUUID()}`;
    await client.query(
      `INSERT INTO memory_items
         (memory_item_id, tenant_id, space, owner_person_id, type, subject, content, source_id,
          observed_at, valid_from, sensitivity, trust_level, confidence, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13)`,
      [
        id, identity.tenant_id, space, identity.person_id, candidate.type, candidate.subject,
        candidate.content, sourceId, observedAt,
        space === "health" ? "special" : "normal", trust, candidate.confidence, status
      ]
    );
    return id;
  }

  private async writeEmbedding(
    client: pg.PoolClient,
    tenantId: string,
    space: MemorySpace,
    itemId: string,
    candidate: Pick<MemoryCandidate, "subject" | "content">
  ): Promise<void> {
    const vector = await this.embeddings.embed(`${candidate.subject} ${candidate.content}`);
    await client.query(
      `INSERT INTO embeddings (memory_item_id, tenant_id, space, model, dim, embedding)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (memory_item_id) DO UPDATE SET model = $4, dim = $5, embedding = $6`,
      [itemId, tenantId, space, this.embeddings.model, this.embeddings.dim, vector]
    );
    // D-28: speil til pgvector-kolonnen når den finnes (Docker-PG). Ufarlig no-op ellers.
    if (this.pgVectorCache === undefined) {
      const r = await client.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='embeddings' AND column_name='vec') AS has"
      );
      this.pgVectorCache = (r.rows[0] as { has: boolean }).has;
    }
    if (this.pgVectorCache) {
      await client.query("UPDATE embeddings SET vec = ($2::text)::vector WHERE memory_item_id = $1",
        [itemId, JSON.stringify(vector)]);
    }
  }
  private pgVectorCache: boolean | undefined;

  private async linkEntities(
    client: pg.PoolClient,
    tenantId: string,
    space: MemorySpace,
    itemId: string,
    candidate: MemoryCandidate
  ): Promise<void> {
    for (const entity of candidate.entities ?? []) {
      const key = `${entity.kind}:${entity.name.toLowerCase()}`;
      const entityId = `ent-${key.replace(/[^a-z0-9:]/g, "-")}`;
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

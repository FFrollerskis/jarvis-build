import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, MemorySpace, TrustLevel } from "@jarvis/contracts";
import { writeAudit } from "@jarvis/core";
import type { PolicyGateway } from "@jarvis/policy";
import type { EmbeddingProvider } from "./embedding.ts";
import type { ExtractionAdapter, MemoryCandidate } from "./extraction.ts";
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
export class MemoryWriter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly embeddings: EmbeddingProvider,
    private readonly extractor: ExtractionAdapter,
    private readonly policy: PolicyGateway
  ) {}

  /** Registrer kilde + trekk ut kandidater + anvend dem. */
  async ingestText(identity: IdentityContext, source: SourceRef, text: string): Promise<ApplyOutcome[]> {
    const candidates = await this.extractor.extract(text, identity.memory_space_id, source.trust);
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

      const existing = await client.query(
        `SELECT memory_item_id, content, subject, version, valid_from, trust_level, status
         FROM memory_items
         WHERE tenant_id = $1 AND space = $2 AND type = $3 AND subject = $4 AND status IN ('active','quarantined')`,
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

      const normalized = (s: string) => s.trim().toLowerCase();
      if (normalized(row.content) === normalized(candidate.content)) {
        await writeAudit(client, identity, { type: "memory.noop", payload: { memory_item_id: row.memory_item_id } });
        return { op: "NOOP", memory_item_id: row.memory_item_id } as const;
      }

      // Untrusted kan aldri overskrive eksisterende trusted/internal innhold:
      if (source.trust === "untrusted" && row.trust_level !== "untrusted") {
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
               trust_level = $5, confidence = $6, has_conflict = true, updated_at = now()
         WHERE memory_item_id = $1`,
        [row.memory_item_id, candidate.content, newVersion, observedAt, source.trust, candidate.confidence]
      );
      await this.writeEmbedding(client, identity.tenant_id, space, row.memory_item_id, candidate);
      await writeAudit(client, identity, {
        type: "memory.update",
        payload: { memory_item_id: row.memory_item_id, version: newVersion }
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

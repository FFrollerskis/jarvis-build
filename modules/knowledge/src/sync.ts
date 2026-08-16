import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction, type EmbeddingProvider } from "@jarvis/memory";
import { isFingerprintErased } from "@jarvis/core";
import type { KnowledgeRecord, KnowledgeSource } from "./source.ts";

/** UA-2 P0 §9: idempotent sync-rapport - en ny kjøring uten kildeendringer skal være nær no-op. */
export interface SyncReport {
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  tombstoned: number;
  reactivated: number;
  failed: number;
  /** Q-20 §5: dokumenter som IKKE ble opprettet fordi de matcher en erasure-fingerprint (resurrection protection). */
  suppressed: number;
}

const EMPTY_REPORT: SyncReport = {
  scanned: 0, created: 0, updated: 0, unchanged: 0, tombstoned: 0, reactivated: 0, failed: 0, suppressed: 0
};

/**
 * UA-2 P0 §4-§6/§9: kilde-uavhengig sync-orkestrering. Kilden vet kun å liste
 * sine records (`KnowledgeSource.list()`); ALL canonical-identity/dedupe/
 * tombstone-logikk bor her, én gang, felles for alle kilder.
 */
export class KnowledgeSyncService {
  private pgVectorCache: boolean | undefined;

  constructor(
    private readonly pool: pg.Pool,
    private readonly embeddings: EmbeddingProvider
  ) {}

  async sync(identity: IdentityContext, memorySpace: MemorySpace, source: KnowledgeSource): Promise<SyncReport> {
    let records: KnowledgeRecord[];
    try {
      records = await source.list();
    } catch {
      // Hele kilden feilet (f.eks. nettverk/credential) - ingen dokumenter ble
      // sett, derfor INGEN tombstoning (§5: vi skal aldri tombstone pga. en
      // feilet listing - kun pga. et dokument som faktisk mangler i en VELLYKKET listing).
      return { ...EMPTY_REPORT, failed: 1 };
    }

    const report: SyncReport = { ...EMPTY_REPORT };
    const seenExternalIds: string[] = [];

    await withMemoryTransaction(this.pool, identity.tenant_id, [memorySpace], async (client) => {
      for (const record of records) {
        report.scanned += 1;
        seenExternalIds.push(record.external_id);
        try {
          await this.upsertOne(client, identity.tenant_id, memorySpace, record, report);
        } catch {
          report.failed += 1;
        }
      }

      // §5: tombstone alt som IKKE ble sett i denne VELLYKKEDE listingen -
      // aldri hard-delete, historikk/provenance blir stående.
      const tombstoneResult = await client.query(
        `UPDATE knowledge_documents SET deleted = true, deleted_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND source_type = $2 AND source_instance_id = $3 AND deleted = false
           AND NOT (external_id = ANY($4::text[]))`,
        [identity.tenant_id, source.source_type, source.source_instance_id, seenExternalIds]
      );
      report.tombstoned = tombstoneResult.rowCount ?? 0;
    });

    return report;
  }

  private async upsertOne(
    client: pg.PoolClient,
    tenantId: string,
    space: MemorySpace,
    record: KnowledgeRecord,
    report: SyncReport
  ): Promise<void> {
    const existing = await client.query(
      `SELECT knowledge_document_id, content_hash, deleted FROM knowledge_documents
       WHERE tenant_id = $1 AND source_type = $2 AND source_instance_id = $3 AND external_id = $4`,
      [tenantId, record.source_type, record.source_instance_id, record.external_id]
    );
    const row = existing.rows[0] as { knowledge_document_id: string; content_hash: string; deleted: boolean } | undefined;

    if (!row) {
      // Q-20 §5: dette external_id-et finnes ikke i knowledge_documents - enten
      // fordi det er reelt nytt, ELLER fordi det tidligere ble hard-slettet
      // (executeErasure fjerner selve raden, i motsetning til tombstoning).
      // En matchende erasure-fingerprint betyr "slettet - skal IKKE gjenoppstå".
      const erased = await isFingerprintErased(client, tenantId, record.source_type, record.source_instance_id, record.external_id);
      if (erased) {
        report.suppressed += 1;
        return;
      }
      // §4: ny canonical document.
      const id = `kd-${randomUUID()}`;
      await client.query(
        `INSERT INTO knowledge_documents
           (knowledge_document_id, tenant_id, memory_space_id, source_type, source_instance_id, external_id,
            canonical_uri, title, content, content_type, content_hash, modified_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id, tenantId, space, record.source_type, record.source_instance_id, record.external_id,
          record.canonical_uri, record.title, record.content, record.content_type, record.content_hash,
          record.modified_at, JSON.stringify(record.metadata)
        ]
      );
      await this.embedAndStore(client, id, tenantId, space, record.content);
      report.created += 1;
      return;
    }

    if (row.content_hash === record.content_hash && !row.deleted) {
      // §9: uendret - nær no-op, INGEN re-embedding.
      await client.query("UPDATE knowledge_documents SET last_synced_at = now() WHERE knowledge_document_id = $1", [
        row.knowledge_document_id
      ]);
      report.unchanged += 1;
      return;
    }

    if (row.content_hash === record.content_hash && row.deleted) {
      // §5: reappearing document, INGEN innholdsendring - reaktiveres
      // deterministisk uten unødvendig re-embedding (embedding-raden ble
      // aldri slettet ved tombstoning, kun dokumentet markert deleted).
      await client.query(
        `UPDATE knowledge_documents
         SET deleted = false, deleted_at = NULL, title = $2, canonical_uri = $3, modified_at = $4,
             metadata = $5, last_synced_at = now(), updated_at = now()
         WHERE knowledge_document_id = $1`,
        [row.knowledge_document_id, record.title, record.canonical_uri, record.modified_at, JSON.stringify(record.metadata)]
      );
      report.reactivated += 1;
      return;
    }

    // Innhold endret (§4: ny versjon/hash) - og/eller reappearing MED endring (§5: reaktiveres samtidig).
    await client.query(
      `UPDATE knowledge_documents
       SET content = $2, content_hash = $3, version = version + 1, deleted = false, deleted_at = NULL,
           title = $4, canonical_uri = $5, content_type = $6, modified_at = $7, metadata = $8,
           last_synced_at = now(), updated_at = now()
       WHERE knowledge_document_id = $1`,
      [
        row.knowledge_document_id, record.content, record.content_hash, record.title, record.canonical_uri,
        record.content_type, record.modified_at, JSON.stringify(record.metadata)
      ]
    );
    await this.embedAndStore(client, row.knowledge_document_id, tenantId, space, record.content);
    if (row.deleted) {
      report.reactivated += 1;
    } else {
      report.updated += 1;
    }
  }

  /** Speiler mønsteret i modules/memory/src/memory-writer.ts (D-28: pgvector når tilgjengelig). */
  private async embedAndStore(
    client: pg.PoolClient,
    knowledgeDocumentId: string,
    tenantId: string,
    space: MemorySpace,
    content: string
  ): Promise<void> {
    const vector = await this.embeddings.embed(content);
    await client.query(
      `INSERT INTO knowledge_embeddings (knowledge_document_id, tenant_id, memory_space_id, model, dim, embedding)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (knowledge_document_id) DO UPDATE SET model = $4, dim = $5, embedding = $6`,
      [knowledgeDocumentId, tenantId, space, this.embeddings.model, this.embeddings.dim, vector]
    );
    if (this.pgVectorCache === undefined) {
      const r = await client.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='knowledge_embeddings' AND column_name='vec') AS has"
      );
      this.pgVectorCache = (r.rows[0] as { has: boolean }).has;
    }
    if (this.pgVectorCache) {
      await client.query("UPDATE knowledge_embeddings SET vec = ($2::text)::vector WHERE knowledge_document_id = $1", [
        knowledgeDocumentId,
        JSON.stringify(vector)
      ]);
    }
  }
}

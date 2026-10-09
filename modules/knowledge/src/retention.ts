import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction } from "@jarvis/memory";
import { pruneOrphanEntities } from "./entity-graph.ts";

/**
 * WP-D1 (UA-2): oppbevaring. En kilde kan ha en `retention_days`-frist (møtetranskripter og andre kilder med innhold som ikke skal ligge for alltid). Tre deler:
 *  1. `KnowledgeSyncService` indekserer ikke innhold hvis `modified_at` er eldre enn fristen, og tombstoner det som alt er indeksert (se `retention_days` i sync-valgene).
 *  2. DENNE tjenesten fjerner innholdet FYSISK: dokumenter hvis `modified_at` er eldre enn fristen, og tombstones som har ligget lenger enn fristen. Alt avledet følger med - embeddings, entitetslenker,
 *     entiteter som ikke har noen lenke igjen (navn hentet fra det fjernede innholdet) og evidens-utdrag - ellers ville innholdet overleve fristen i utledede tabeller.
 *  3. Ingen erasure-fingerprint skrives: en frist-utløpt fil som fortsatt ligger i kilden skal ikke gjenskapes av synk (alders-filteret i punkt 1 hindrer det), mens en fil som kommer tilbake
 *     med nyere `modified_at` er nytt innhold fra kilden og skal indekseres på vanlig måte.
 * Et dokument uten `modified_at` regnes aldri som utløpt mens det er levende (alderen er ikke kjent); det fjernes først når det er tombstonet og tombstonen er eldre enn fristen.
 */
export interface DerivedDeleteCounts {
  documents: number;
  embeddings: number;
  links: number;
  entities: number;
  evidence: number;
}

/**
 * Sletter dokumentene med id-ene `ids` og ALT avledet av dem, i FK-sikker rekkefølge (lenker -> foreldreløse entiteter -> evidens -> embeddings -> dokumenter). Kjører i kallerens transaksjon
 * (RLS-konteksten for tenant og rom er allerede satt); alle setninger er i tillegg eksplisitt skopet til (tenant, rom).
 */
export async function deleteDocumentsWithDerived(client: pg.PoolClient, tenantId: string, space: MemorySpace, ids: readonly string[]): Promise<DerivedDeleteCounts> {
  const counts: DerivedDeleteCounts = { documents: 0, embeddings: 0, links: 0, entities: 0, evidence: 0 };
  if (ids.length === 0) return counts;
  const idList = [...ids];
  const candidates = await client.query(
    "SELECT DISTINCT entity_id FROM knowledge_links WHERE tenant_id = $1 AND memory_space_id = $2 AND knowledge_document_id = ANY($3::text[])",
    [tenantId, space, idList]
  );
  const entityIds = (candidates.rows as Array<{ entity_id: string }>).map((r) => r.entity_id);
  const links = await client.query("DELETE FROM knowledge_links WHERE tenant_id = $1 AND memory_space_id = $2 AND knowledge_document_id = ANY($3::text[])", [tenantId, space, idList]);
  counts.links = links.rowCount ?? 0;
  // (låser entitetsradene før lenkesjekken - en samtidig synk som nettopp lenket til en av dem skal ikke få lenken stille slettet av kaskaden)
  counts.entities = await pruneOrphanEntities(client, tenantId, space, entityIds);
  const evidence = await client.query("DELETE FROM claim_evidence WHERE tenant_id = $1 AND memory_space_id = $2 AND knowledge_document_id = ANY($3::text[])", [tenantId, space, idList]);
  counts.evidence = evidence.rowCount ?? 0;
  const embeddings = await client.query("DELETE FROM knowledge_embeddings WHERE tenant_id = $1 AND memory_space_id = $2 AND knowledge_document_id = ANY($3::text[])", [tenantId, space, idList]);
  counts.embeddings = embeddings.rowCount ?? 0;
  const documents = await client.query("DELETE FROM knowledge_documents WHERE tenant_id = $1 AND memory_space_id = $2 AND knowledge_document_id = ANY($3::text[])", [tenantId, space, idList]);
  counts.documents = documents.rowCount ?? 0;
  return counts;
}

export interface RetentionPurgeReport extends DerivedDeleteCounts {
  /** Antall omganger (batcher) som ble kjørt. */
  batches: number;
}

export interface PurgeOptions {
  /** Tidspunkt «nå» (kun for tester). */
  now?: Date;
  /** Maks dokumenter per batch (en transaksjon per batch holder låsene korte). */
  batchSize?: number;
  /** Maks antall batcher per kall - resten tas ved neste kjøring. */
  maxBatches?: number;
}

export class KnowledgeRetentionService {
  constructor(private readonly pool: pg.Pool) {}

  /** Fjerner utløpt innhold for ÉN kildeinstans i ÉT rom. `retention_days` må være et positivt heltall - ellers kastes det (aldri en stille «slett alt»). */
  async purgeExpired(
    identity: IdentityContext,
    space: MemorySpace,
    source: { source_type: string; source_instance_id: string },
    retentionDays: number,
    options: PurgeOptions = {}
  ): Promise<RetentionPurgeReport> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error("invalid_retention_days");
    const cutoff = new Date((options.now ?? new Date()).getTime() - retentionDays * 86_400_000);
    const batchSize = Math.min(Math.max(options.batchSize ?? 200, 1), 1000);
    const maxBatches = Math.min(Math.max(options.maxBatches ?? 50, 1), 1000);
    const total: RetentionPurgeReport = { documents: 0, embeddings: 0, links: 0, entities: 0, evidence: 0, batches: 0 };
    for (let i = 0; i < maxBatches; i += 1) {
      const batch = await withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) => {
        const due = await client.query(
          `SELECT knowledge_document_id FROM knowledge_documents
            WHERE tenant_id = $1 AND memory_space_id = $2 AND source_type = $3 AND source_instance_id = $4
              AND ((modified_at IS NOT NULL AND modified_at < $5) OR (deleted AND deleted_at IS NOT NULL AND deleted_at < $5))
            ORDER BY knowledge_document_id LIMIT $6`,
          [identity.tenant_id, space, source.source_type, source.source_instance_id, cutoff, batchSize]
        );
        const ids = (due.rows as Array<{ knowledge_document_id: string }>).map((r) => r.knowledge_document_id);
        return ids.length === 0 ? undefined : deleteDocumentsWithDerived(client, identity.tenant_id, space, ids);
      });
      if (batch === undefined) break;
      total.batches += 1;
      total.documents += batch.documents;
      total.embeddings += batch.embeddings;
      total.links += batch.links;
      total.entities += batch.entities;
      total.evidence += batch.evidence;
      if (batch.documents < batchSize) break;
    }
    return total;
  }
}

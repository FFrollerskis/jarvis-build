import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction, type EmbeddingProvider } from "@jarvis/memory";

/** UA-2 P0 §6: hvert retrieval-resultat kan spores tilbake til original kilde - aldri modellgenerert. */
export interface KnowledgeProvenance {
  source_type: string;
  source_instance_id: string;
  external_id: string;
  canonical_uri: string;
  content_hash: string;
  version: number;
  last_synced_at: string;
  modified_at: string | null;
}

export interface KnowledgeSearchResult {
  knowledge_document_id: string;
  title: string;
  content: string;
  score: number;
  provenance: KnowledgeProvenance;
}

export interface KnowledgeSearchOptions {
  query: string;
  spaces: MemorySpace[];
  limit?: number;
}

/**
 * UA-2 P0 §8: FTS + vector hybrid retrieval (graph-retrieval er IKKE bygget -
 * §14/Q-10). Deleted/tombstoned rader filtreres alltid bort (§5). Beholder
 * samme RLS-transaksjonsmønster som `MemoryRetriever` - INGEN ny
 * isolasjonslogikk, samme sikkerhetsgrense.
 */
export class KnowledgeRetriever {
  private pgVectorCache: boolean | undefined;

  private async usesPgVector(client: pg.PoolClient): Promise<boolean> {
    if (this.pgVectorCache === undefined) {
      const r = await client.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='knowledge_embeddings' AND column_name='vec') AS has"
      );
      this.pgVectorCache = (r.rows[0] as { has: boolean }).has;
    }
    return this.pgVectorCache;
  }

  constructor(
    private readonly pool: pg.Pool,
    private readonly embeddings: EmbeddingProvider
  ) {}

  async search(identity: IdentityContext, options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult[]> {
    const limit = options.limit ?? 8;
    const queryVector = await this.embeddings.embed(options.query);

    return withMemoryTransaction(this.pool, identity.tenant_id, options.spaces, async (client) => {
      const fts = await client.query(
        `SELECT knowledge_document_id, title, content, source_type, source_instance_id, external_id,
                canonical_uri, content_hash, version, last_synced_at, modified_at,
                ts_rank(fts, plainto_tsquery('norwegian', $1)) AS fts_rank
         FROM knowledge_documents
         WHERE deleted = false AND fts @@ plainto_tsquery('norwegian', $1)
         ORDER BY fts_rank DESC LIMIT 60`,
        [options.query]
      );

      const pgv = await this.usesPgVector(client);
      const simExpr = pgv ? "1 - (e.vec <=> ($1::text)::vector)" : "cosine_sim(e.embedding, $1::real[])";
      const vecArg = pgv ? JSON.stringify(queryVector) : queryVector;
      const vec = await client.query(
        `SELECT d.knowledge_document_id, d.title, d.content, d.source_type, d.source_instance_id, d.external_id,
                d.canonical_uri, d.content_hash, d.version, d.last_synced_at, d.modified_at,
                ${simExpr} AS sim
         FROM knowledge_embeddings e
         JOIN knowledge_documents d ON d.knowledge_document_id = e.knowledge_document_id
         WHERE d.deleted = false AND e.model = $2 AND e.dim = $3${pgv ? " AND e.vec IS NOT NULL" : ""} AND ${simExpr} >= 0.4
         ORDER BY sim DESC LIMIT 60`,
        // D-396 (JARVIS-031): kun vektorer fra SAMME embedding-modell/dimensjon som spørringen - to ulike modeller har ikke sammenlignbare rom
        // (cosine mellom dem er meningsløst og, med pgvector, en dimensjonsfeil). Dokumenter embeddet med en annen modell finnes fortsatt via FTS.
        [vecArg, this.embeddings.model, this.embeddings.dim]
      );

      const byId = new Map<string, KnowledgeSearchResult & { fts_rank: number; sim: number }>();
      const upsert = (row: Record<string, unknown>, kind: "fts" | "vec") => {
        const id = row["knowledge_document_id"] as string;
        const entry = byId.get(id) ?? {
          knowledge_document_id: id,
          title: row["title"] as string,
          content: row["content"] as string,
          score: 0,
          fts_rank: 0,
          sim: 0,
          provenance: {
            source_type: row["source_type"] as string,
            source_instance_id: row["source_instance_id"] as string,
            external_id: row["external_id"] as string,
            canonical_uri: row["canonical_uri"] as string,
            content_hash: row["content_hash"] as string,
            version: row["version"] as number,
            last_synced_at: String(row["last_synced_at"]),
            modified_at: row["modified_at"] ? String(row["modified_at"]) : null
          }
        };
        if (kind === "fts") entry.fts_rank = Number(row["fts_rank"]);
        else entry.sim = Number(row["sim"]);
        byId.set(id, entry);
      };
      for (const row of fts.rows) upsert(row as Record<string, unknown>, "fts");
      for (const row of vec.rows) upsert(row as Record<string, unknown>, "vec");

      const maxFts = Math.max(0.001, ...[...byId.values()].map((e) => e.fts_rank));
      for (const entry of byId.values()) {
        // Enkel fusion: 0.5 FTS + 0.5 vektor (§8 - "ryddig hybrid ranking",
        // ingen ferskhetsvekting ennå - dokumentferskhet er allerede i
        // provenance for klienten å selv vurdere, §6).
        entry.score = 0.5 * (entry.fts_rank / maxFts) + 0.5 * entry.sim;
      }
      return [...byId.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => ({
          knowledge_document_id: entry.knowledge_document_id,
          title: entry.title,
          content: entry.content,
          score: entry.score,
          provenance: entry.provenance
        }));
    });
  }
}

import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { orTsQuery, queryTerms, withMemoryTransaction, type EmbeddingProvider } from "@jarvis/memory";
import type { KnowledgeSourceKind } from "@jarvis/tool-gateway";
import { extractSnippet, neutralizeUntrustedText, sourceKindOf, sourceTypeOf, truncateText, TITLE_MAX_CHARS, URI_MAX_CHARS, type KnowledgeHit } from "./knowledge-hits.ts";
import { classifyKnowledgeSensitivity } from "./sensitivity.ts";

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

/** WP-D1: alternativer for det normaliserte, modellvendte søket (`searchHits`). */
export interface KnowledgeHitSearchOptions {
  query: string;
  spaces: MemorySpace[];
  limit?: number;
  /** Begrens til disse kildetypene (konfigurert `kind`, f.eks. `drive`). */
  source_kinds?: readonly KnowledgeSourceKind[];
}

/** Hvor mange kandidater hver gren (fulltekst/vektor) henter før fusjonen. */
const CANDIDATE_LIMIT = 60;
const MAX_HITS = 10;

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
  /**
   * WP-D1 (UA-2, JARVIS-060): det NORMALISERTE søket chatten bruker (`knowledge.search`). Samme hybride rangering som `search()` (0,5 fulltekst + 0,5 vektor,
   * kun vektorer fra SAMME embedding-modell), men:
   *  - fulltekst som ELLER over innholdsordene (`queryTerms`/`orTsQuery`, som minnesøket) - et naturlig spørsmål («hva står det i kontrakten om oppsigelse») har ord
   *    dokumentet ikke har, og OG-semantikken i `plainto_tsquery` ville drept treffet;
   *  - rangeringen skjer først på id-er; kun de `limit` beste leses med innhold (ingen full tekst for 120 kandidater);
   *  - hvert treff får et nøytralisert, avkortet utdrag og STRUKTURERTE merker (`sensitivity`, `memory_space`, `trust_level`) som skyskjermen kan stole på.
   * Tenant/space-isolasjonen er den samme som i `search()`: `withMemoryTransaction` setter RLS-konteksten, så ingenting utenfor `spaces` er synlig.
   * Slettede (tombstonede) dokumenter filtreres alltid bort.
   */
  async searchHits(identity: IdentityContext, options: KnowledgeHitSearchOptions): Promise<KnowledgeHit[]> {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 5), 1), MAX_HITS);
    const query = options.query.trim().slice(0, 500);
    const terms = queryTerms(query);
    if (query.length === 0) return [];
    const tsQuery = orTsQuery(terms);
    const sourceTypes = options.source_kinds && options.source_kinds.length > 0 ? options.source_kinds.map(sourceTypeOf) : undefined;
    const queryVector = await this.embeddings.embed(query);

    return withMemoryTransaction(this.pool, identity.tenant_id, options.spaces, async (client) => {
      const scores = new Map<string, { fts: number; sim: number }>();
      const typeFilter = (n: number, column: string): string => (sourceTypes ? ` AND ${column} = ANY($${n}::text[])` : "");

      if (tsQuery !== "") {
        const fts = await client.query(
          `SELECT knowledge_document_id, ts_rank_cd(fts, to_tsquery('norwegian', $1)) AS fts_rank
             FROM knowledge_documents
            WHERE deleted = false AND fts @@ to_tsquery('norwegian', $1)${typeFilter(2, "source_type")}
            ORDER BY fts_rank DESC LIMIT ${CANDIDATE_LIMIT}`,
          sourceTypes ? [tsQuery, sourceTypes] : [tsQuery]
        );
        for (const row of fts.rows as Array<{ knowledge_document_id: string; fts_rank: number | string }>) {
          scores.set(row.knowledge_document_id, { fts: Number(row.fts_rank), sim: 0 });
        }
      }

      const pgv = await this.usesPgVector(client);
      const simExpr = pgv ? "1 - (e.vec <=> ($1::text)::vector)" : "cosine_sim(e.embedding, $1::real[])";
      const vecArg = pgv ? JSON.stringify(queryVector) : queryVector;
      const vec = await client.query(
        `SELECT d.knowledge_document_id, ${simExpr} AS sim
           FROM knowledge_embeddings e
           JOIN knowledge_documents d ON d.knowledge_document_id = e.knowledge_document_id
          WHERE d.deleted = false AND e.model = $2 AND e.dim = $3${pgv ? " AND e.vec IS NOT NULL" : ""} AND ${simExpr} >= 0.4${typeFilter(4, "d.source_type")}
          ORDER BY sim DESC LIMIT ${CANDIDATE_LIMIT}`,
        // D-396 (JARVIS-031): kun vektorer fra SAMME embedding-modell/dimensjon som spørringen.
        sourceTypes ? [vecArg, this.embeddings.model, this.embeddings.dim, sourceTypes] : [vecArg, this.embeddings.model, this.embeddings.dim]
      );
      for (const row of vec.rows as Array<{ knowledge_document_id: string; sim: number | string }>) {
        const entry = scores.get(row.knowledge_document_id) ?? { fts: 0, sim: 0 };
        entry.sim = Number(row.sim);
        scores.set(row.knowledge_document_id, entry);
      }
      if (scores.size === 0) return [];

      const maxFts = Math.max(0.001, ...[...scores.values()].map((e) => e.fts));
      const ranked = [...scores.entries()]
        .map(([id, e]) => ({ id, score: 0.5 * (e.fts / maxFts) + 0.5 * e.sim }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit);

      const details = await client.query(
        `SELECT knowledge_document_id, memory_space_id, source_type, title, content, canonical_uri, modified_at, last_synced_at
           FROM knowledge_documents WHERE deleted = false AND knowledge_document_id = ANY($1::text[])`,
        [ranked.map((r) => r.id)]
      );
      const byId = new Map((details.rows as Array<Record<string, unknown>>).map((row) => [row["knowledge_document_id"] as string, row]));
      const hits: KnowledgeHit[] = [];
      for (const { id, score } of ranked) {
        const row = byId.get(id);
        if (!row) continue;
        hits.push(this.toHit(row, score, terms));
      }
      return hits;
    });
  }

  private toHit(row: Record<string, unknown>, score: number, terms: readonly string[]): KnowledgeHit {
    const space = row["memory_space_id"] as MemorySpace;
    const title = String(row["title"] ?? "");
    const content = String(row["content"] ?? "");
    // Strengeste av kildens gulv (standard `sensitive`) og klassifiseringen av tittel + HELE innholdet NÅ (ordforrådet vokser; en rad lagret før en utvidelse slipper ikke forbi).
    const decision = classifyKnowledgeSensitivity({ memory_space: space, texts: [title, content], floor: "sensitive" });
    const toIso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value));
    return {
      document_id: String(row["knowledge_document_id"]),
      source_kind: sourceKindOf(String(row["source_type"])),
      title: truncateText(neutralizeUntrustedText(title), TITLE_MAX_CHARS),
      snippet: extractSnippet(content, terms),
      uri: truncateText(neutralizeUntrustedText(String(row["canonical_uri"] ?? "")), URI_MAX_CHARS),
      memory_space: space,
      sensitivity: decision.sensitivity,
      trust_level: "untrusted",
      score: Math.round(score * 1000) / 1000,
      observed_at: toIso(row["last_synced_at"]) ?? new Date(0).toISOString(),
      modified_at: toIso(row["modified_at"])
    };
  }
}

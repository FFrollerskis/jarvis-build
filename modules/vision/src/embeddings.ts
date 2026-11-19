import type pg from "pg";
import { assertLocalEmbedding, hasPgVector, similaritySql, upsertVector, vectorArg, withMemoryTransaction, type EmbeddingProvider } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { describeEventForEmbedding } from "./labels.ts";

/**
 * WP-G3 (D-465), P1c: objekt-/hendelses-embeddings i den EKSISTERENDE vektorlagringen (`memory_vectors`, 068; ingen ny vektorleverandør).
 *
 * - Bruker minnets `EmbeddingProvider` og dets fail-closed lokalitetsregel (`assertLocalEmbedding`): kun lokal embedding. En sky-embedding gir `EmbeddingLocalityError` ved konstruksjon.
 * - Det som embeddes er den VALIDERTE tekstbeskrivelsen (hendelsestype + normalisert objektnavn + eierens romnavn; `describeEventForEmbedding`), aldri bildet og aldri rå modelltekst.
 *   Bildeembeddinger (CLIP-lignende) er DEFERRED: Jarvis har ingen bildeembedding-adapter, og å innføre en ville vært en ny modellleverandør.
 * - Vektoren lagres under `ref_kind = 'vision_event'`, `ref_id = observation_id` (135 utvidet CHECK-en). En AFTER DELETE-trigger fjerner den når hendelsen slettes (oppbevaring, erasure).
 * - Søk filtrerer ALLTID på providerens `model` + `dim` (vektorer fra ulike modeller sammenlignes aldri) og på person/tenant/space (RLS + eksplisitt scope).
 * - Embedding-feil (modellserver nede) er ikke fatale for pipelinen: hendelsen skrives uten vektor og `backfillMissing()` fyller etter.
 */
export interface EmbeddingMatch {
  observation_id: string;
  object_label: string;
  room_id: string | null;
  room_name: string | null;
  observed_at: string;
  confidence: number | null;
  has_snapshot: boolean;
  source_type: string;
  source_instance_id: string;
  similarity: number;
}

export class VisionEmbeddingService {
  constructor(
    private readonly pool: pg.Pool,
    readonly provider: EmbeddingProvider
  ) {
    assertLocalEmbedding(provider);
  }

  /** Beskrivelsen som embeddes (delt med pipelinen og backfill, så vektoren alltid er av samme tekst). */
  descriptorFor(parts: { event_type: string; object_label?: string | null; room_name?: string | null }): string {
    return describeEventForEmbedding(parts);
  }

  async embed(text: string): Promise<number[]> {
    const vector = await this.provider.embed(text);
    if (!Array.isArray(vector) || vector.length !== this.provider.dim || vector.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
      throw new Error("vision_embedding_invalid_vector");
    }
    return vector;
  }

  async storeInTransaction(client: pg.PoolClient, ref: { observationId: string; tenantId: string; memorySpace: MemorySpace }, vector: number[]): Promise<void> {
    await upsertVector(client, this.pool, { kind: "vision_event", id: ref.observationId, tenantId: ref.tenantId, space: ref.memorySpace }, this.provider, vector);
  }

  /** Semantisk søk etter objekter lignende `queryText` blant personens `object_detected`-hendelser. Nyeste først ved lik likhet. */
  async searchObjects(
    tenantId: string,
    memorySpace: MemorySpace,
    personId: string,
    queryText: string,
    options: { limit?: number; minSimilarity?: number; sinceMs?: number } = {}
  ): Promise<EmbeddingMatch[]> {
    const vector = await this.embed(queryText);
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 50);
    const minSimilarity = options.minSimilarity ?? this.provider.minSimilarity;
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const pgv = await hasPgVector(client, this.pool);
      const sim = similaritySql(this.provider, pgv, "$5");
      const params: unknown[] = [tenantId, this.provider.model, this.provider.dim, personId, vectorArg(pgv, vector), minSimilarity, limit];
      let since = "";
      if (options.sinceMs !== undefined) {
        params.push(new Date(options.sinceMs).toISOString());
        since = ` AND o.observed_at >= $${params.length}`;
      }
      const { rows } = await client.query(
        `SELECT o.observation_id, o.object_label, o.room_id, r.name AS room_name, o.observed_at, o.confidence, (o.snapshot_ref IS NOT NULL) AS has_snapshot,
                o.source_type, o.source_instance_id, ${sim} AS similarity
           FROM memory_vectors v
           JOIN vision_event_observations o ON o.tenant_id = v.tenant_id AND o.observation_id = v.ref_id
           LEFT JOIN vision_rooms r ON r.tenant_id = o.tenant_id AND r.memory_space_id = o.memory_space_id AND r.person_id = o.person_id AND r.room_id = o.room_id
          WHERE v.ref_kind = 'vision_event' AND v.tenant_id = $1 AND v.model = $2 AND v.dim = $3
            AND o.person_id = $4 AND o.event_type = 'object_detected' AND o.object_label IS NOT NULL AND ${sim} >= $6${since}
          ORDER BY similarity DESC, o.observed_at DESC LIMIT $7`,
        params
      );
      return (rows as Array<Record<string, unknown>>).map((row) => ({
        observation_id: String(row["observation_id"]),
        object_label: String(row["object_label"]),
        room_id: row["room_id"] === null ? null : String(row["room_id"]),
        room_name: row["room_name"] === null ? null : String(row["room_name"]),
        observed_at: new Date(String(row["observed_at"])).toISOString(),
        confidence: row["confidence"] === null ? null : Number(row["confidence"]),
        has_snapshot: row["has_snapshot"] === true,
        source_type: String(row["source_type"]),
        source_instance_id: String(row["source_instance_id"]),
        similarity: Number(row["similarity"])
      }));
    });
  }

  /**
   * Fyller manglende vektorer for gjeldende embedding-modell (en embedding-feil under skriving, eller et modellbytte). Begrenset batch per kall; kjøres av vedlikeholdssveipet.
   * Hver vektor skrives i sin egen korte transaksjon etter at embeddingen er beregnet UTENFOR transaksjon.
   */
  async backfillMissing(tenantId: string, memorySpace: MemorySpace, limit = 50): Promise<{ embedded: number; failed: number }> {
    const rows = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: found } = await client.query(
        `SELECT o.observation_id, o.event_type, o.object_label, r.name AS room_name
           FROM vision_event_observations o
           LEFT JOIN vision_rooms r ON r.tenant_id = o.tenant_id AND r.memory_space_id = o.memory_space_id AND r.person_id = o.person_id AND r.room_id = o.room_id
           LEFT JOIN memory_vectors v ON v.ref_kind = 'vision_event' AND v.ref_id = o.observation_id AND v.tenant_id = o.tenant_id AND v.model = $3
          WHERE o.tenant_id = $1 AND o.memory_space_id = $2 AND o.event_type = 'object_detected' AND o.object_label IS NOT NULL AND v.ref_id IS NULL
          ORDER BY o.observed_at DESC LIMIT $4`,
        [tenantId, memorySpace, this.provider.model, Math.min(Math.max(limit, 1), 500)]
      );
      return found as Array<{ observation_id: string; event_type: string; object_label: string; room_name: string | null }>;
    });
    let embedded = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const vector = await this.embed(this.descriptorFor({ event_type: row.event_type, object_label: row.object_label, room_name: row.room_name }));
        await withMemoryTransaction(this.pool, tenantId, [memorySpace], (client) => this.storeInTransaction(client, { observationId: row.observation_id, tenantId, memorySpace }, vector));
        embedded += 1;
      } catch {
        failed += 1;
      }
    }
    return { embedded, failed };
  }
}

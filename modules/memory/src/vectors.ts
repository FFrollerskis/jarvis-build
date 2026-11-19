import type pg from "pg";
import type { EmbeddingProvider } from "./embedding.ts";

/**
 * D-386: felles vektorlager (`memory_vectors`, 068) for items, episoder og sammendrag. Modellbevisst: en rad per
 * (ref_kind, ref_id, model); søk filtrerer ALLTID på providerens `model`+`dim`, så vektorer fra ulike modeller aldri
 * sammenlignes. pgvector-kolonnen `vec` finnes kun i Docker-PG (embedded test-PG mangler utvidelsen) - da brukes
 * `cosine_sim(real[], real[])` (008) med identisk resultat, bare uten HNSW.
 */
/** WP-G3 (D-465, 135): `vision_event` = objekt-/hendelsesvektor for UA-9 (ref_id = vision_event_observations.observation_id); en trigger fjerner den når hendelsen slettes. */
export type VectorRefKind = "item" | "episode" | "summary" | "vision_event";

const pgVectorByPool = new WeakMap<object, boolean>();

export async function hasPgVector(client: pg.PoolClient, cacheKey: object): Promise<boolean> {
  const cached = pgVectorByPool.get(cacheKey);
  if (cached !== undefined) return cached;
  const r = await client.query(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memory_vectors' AND column_name='vec') AS has"
  );
  const has = (r.rows[0] as { has: boolean }).has;
  pgVectorByPool.set(cacheKey, has);
  return has;
}

export async function upsertVector(
  client: pg.PoolClient,
  cacheKey: object,
  ref: { kind: VectorRefKind; id: string; tenantId: string; space: string },
  provider: EmbeddingProvider,
  vector: number[]
): Promise<void> {
  await client.query(
    `INSERT INTO memory_vectors (ref_kind, ref_id, tenant_id, space, model, dim, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (ref_kind, ref_id, model) DO UPDATE SET dim = EXCLUDED.dim, embedding = EXCLUDED.embedding, created_at = now()`,
    [ref.kind, ref.id, ref.tenantId, ref.space, provider.model, provider.dim, vector]
  );
  if (await hasPgVector(client, cacheKey)) {
    await client.query(
      "UPDATE memory_vectors SET vec = ($4::text)::vector WHERE ref_kind = $1 AND ref_id = $2 AND model = $3",
      [ref.kind, ref.id, provider.model, JSON.stringify(vector)]
    );
  }
}

/**
 * Likhetsuttrykk (alias `v` = memory_vectors), deterministisk fra providerens dimensjon slik at de partielle
 * HNSW-indeksene i 068 (`(vec::vector(N)) ... WHERE dim = N`) faktisk brukes. `vecParam` er `$n` for spørringsvektoren,
 * som må leveres med `vectorArg()` i samme form (JSON-tekst for pgvector, real[] ellers).
 */
export function similaritySql(provider: EmbeddingProvider, pgv: boolean, vecParam: string): string {
  return pgv
    ? `(1 - (v.vec::vector(${provider.dim}) <=> (${vecParam}::text)::vector(${provider.dim})))`
    : `cosine_sim(v.embedding, ${vecParam}::real[])`;
}

export function vectorArg(pgv: boolean, vector: number[]): unknown {
  return pgv ? JSON.stringify(vector) : vector;
}

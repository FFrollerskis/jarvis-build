import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import { listAllTenantIds, listTenantMemorySpaces } from "@jarvis/core";
import { assertLocalEmbedding, type EmbeddingProvider } from "./embedding.ts";
import { withMemoryTransaction } from "./spaces.ts";
import { upsertVector, type VectorRefKind } from "./vectors.ts";

export interface ReembedSweepSummary {
  /** Antall rader som fikk vektor for providerens modell, per `"<tenant>:<space>"`. */
  embeddedByTenant: Record<string, number>;
  failed: Array<{ tenant_id: string; memory_space_id: string; error: string }>;
  /** True når sveipet stoppet på `maxRows` (det finnes mer å gjøre neste gang). */
  truncated: boolean;
}

export interface ReembedSweepOptions {
  /** Øvre grense per kjøring (beskytter en liten GPU/PC mot timesvis av arbeid i ett jafs). */
  maxRows?: number;
  batchSize?: number;
}

/**
 * D-386: fyller `memory_vectors` for providerens NÅVÆRENDE modell der vektor mangler - items, episoder og sammendrag.
 * Kjøres (1) nattlig via DailyScheduler, (2) én gang kort etter oppstart (så et modellbytte i `.env` virker samme
 * dag), og (3) etter at en vektorskriving feilet i skriveøyeblikket (Ollama nede). Modellbevisst: en rad per modell,
 * gamle rader fra en tidligere modell røres ikke (ingenting slettes stille; de er bare aldri sammenlignbare).
 * Bruker en syntetisk systemidentitet-fri vei: rene RLS-transaksjoner per (tenant, space), ingen audit per rad
 * (vektorer er avledet, ikke sannhet).
 */
export async function runMemoryReembedSweepForAllTenants(
  pool: pg.Pool,
  provider: EmbeddingProvider,
  options: ReembedSweepOptions = {}
): Promise<ReembedSweepSummary> {
  assertLocalEmbedding(provider);
  const maxRows = options.maxRows ?? 2000;
  const batchSize = Math.max(1, Math.min(64, options.batchSize ?? 16));
  const summary: ReembedSweepSummary = { embeddedByTenant: {}, failed: [], truncated: false };
  let remaining = maxRows;

  const tenantIds = await listAllTenantIds(pool, 200);
  for (const tenantId of tenantIds) {
    if (remaining <= 0) { summary.truncated = true; break; }
    let spaces: string[];
    try {
      spaces = await listTenantMemorySpaces(pool, tenantId);
    } catch (err) {
      summary.failed.push({ tenant_id: tenantId, memory_space_id: "*", error: (err as Error).message.slice(0, 200) });
      continue;
    }
    for (const space of spaces) {
      if (remaining <= 0) { summary.truncated = true; break; }
      try {
        const n = await reembedSpace(pool, provider, tenantId, space as MemorySpace, remaining, batchSize);
        remaining -= n;
        if (n > 0) summary.embeddedByTenant[`${tenantId}:${space}`] = n;
      } catch (err) {
        const failure = { tenant_id: tenantId, memory_space_id: space, error: (err as Error).message.slice(0, 200) };
        summary.failed.push(failure);
        console.error(JSON.stringify({ msg: "memory_reembed_sweep_failed", ...failure }));
      }
    }
  }
  console.log(JSON.stringify({ msg: "memory_reembed_sweep_done", model: provider.model, embedded: summary.embeddedByTenant, failed: summary.failed.length, truncated: summary.truncated }));
  return summary;
}

const SOURCES: ReadonlyArray<{ kind: VectorRefKind; sql: string }> = [
  {
    kind: "item",
    sql: `SELECT m.memory_item_id AS id, m.subject || ' ' || m.content AS text
            FROM memory_items m
            LEFT JOIN memory_vectors v ON v.ref_kind = 'item' AND v.ref_id = m.memory_item_id AND v.model = $3
           WHERE m.tenant_id = $1 AND m.space = $2 AND m.status = 'active' AND v.ref_id IS NULL
           ORDER BY m.updated_at DESC LIMIT $4`
  },
  {
    kind: "episode",
    sql: `SELECT e.episode_id AS id, e.content AS text
            FROM memory_episodes e
            LEFT JOIN memory_vectors v ON v.ref_kind = 'episode' AND v.ref_id = e.episode_id AND v.model = $3
           WHERE e.tenant_id = $1 AND e.space = $2 AND e.status = 'active' AND v.ref_id IS NULL
           ORDER BY e.observed_at DESC LIMIT $4`
  },
  {
    kind: "summary",
    sql: `SELECT s.summary_id AS id, s.content AS text
            FROM summaries s
            LEFT JOIN memory_vectors v ON v.ref_kind = 'summary' AND v.ref_id = s.summary_id AND v.model = $3
           WHERE s.tenant_id = $1 AND s.space = $2 AND v.ref_id IS NULL
           ORDER BY s.created_at DESC LIMIT $4`
  }
];

async function reembedSpace(pool: pg.Pool, provider: EmbeddingProvider, tenantId: string, space: MemorySpace, limit: number, batchSize: number): Promise<number> {
  let done = 0;
  for (const source of SOURCES) {
    if (done >= limit) break;
    const rows = await withMemoryTransaction(pool, tenantId, [space], async (client) =>
      (await client.query<{ id: string; text: string }>(source.sql, [tenantId, space, provider.model, limit - done])).rows
    );
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      // Embedding skjer UTENFOR transaksjonen (kan ta sekunder på en liten GPU) - ingen lange åpne DB-transaksjoner.
      const vectors = await provider.embedBatch(batch.map((r) => r.text));
      await withMemoryTransaction(pool, tenantId, [space], async (client) => {
        for (let j = 0; j < batch.length; j++) {
          const row = batch[j] as { id: string; text: string };
          const vector = vectors[j];
          if (!vector) continue;
          await upsertVector(client, pool, { kind: source.kind, id: row.id, tenantId, space }, provider, vector);
        }
      });
      done += batch.length;
    }
  }
  return done;
}

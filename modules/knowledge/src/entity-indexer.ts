import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import { DeterministicEntityExtractor, ENTITY_LIMITS, type EntityExtractor, type KnownEntity } from "./entity-extractor.ts";
import { replaceDocumentLinks } from "./entity-graph.ts";
import type { KnowledgeEntityIndexPort } from "./sync.ts";

export interface KnowledgeEntityIndexerOptions {
  /** Må være deterministisk: indekseringen kjører INLINE i synk-transaksjonen, og et modellkall skal aldri holde en databasetransaksjon åpen (modellassistert uttrekk er et eget pass, `entity-llm.ts`). */
  extractor?: EntityExtractor | undefined;
  /** Hvor lenge minnets ordliste (kjente navn) gjenbrukes per (tenant, rom). Standard 60 s. */
  known_cache_ms?: number | undefined;
  /** Klokke (tester). */
  now?: (() => number) | undefined;
}

/**
 * WP-D1 (UA-2): den DETERMINISTISKE entitetsindekseringen (`KnowledgeEntityIndexPort`). For hvert dokument: les minnets kjente navn for SAMME rom (kun lesing, aldri skriving til minnet), trekk ut
 * entiteter med den rene uttrekkeren, og erstatt dokumentets deterministiske lenker (`replaceDocumentLinks`). Kjører i synkroniseringens transaksjon og egen delsavepoint, så en feil her aldri mister dokumentet.
 *
 * Versjonen (`<navn>@<versjon>`) inngår i dokumentets indekseringsnøkkel: endres uttrekkeren, bygges lenkene på nytt for alle dokumenter ved neste synk.
 */
export class KnowledgeEntityIndexer implements KnowledgeEntityIndexPort {
  readonly version: string;
  private readonly extractor: EntityExtractor;
  private readonly knownCacheMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; known: KnownEntity[] }>();

  constructor(options: KnowledgeEntityIndexerOptions = {}) {
    this.extractor = options.extractor ?? new DeterministicEntityExtractor();
    if (this.extractor.method !== "deterministic") throw new Error("entity_indexer_requires_deterministic_extractor");
    this.version = `${this.extractor.name}@${this.extractor.version}`;
    this.knownCacheMs = Math.max(0, options.known_cache_ms ?? 60_000);
    this.now = options.now ?? Date.now;
  }

  async index(
    client: pg.PoolClient,
    input: Parameters<KnowledgeEntityIndexPort["index"]>[1]
  ): Promise<void> {
    const known = await this.loadKnown(client, input.tenant_id, input.memory_space_id);
    const entities = await this.extractor.extract({ source_type: input.source_type, title: input.title, content: input.content, metadata: input.metadata, known });
    await replaceDocumentLinks(client, {
      tenant_id: input.tenant_id, memory_space_id: input.memory_space_id, knowledge_document_id: input.knowledge_document_id, method: "deterministic", entities
    });
  }

  /** Minnets entiteter for (tenant, rom). Cachen er nøklet på begge, så et rom aldri ser et annet rommets navn. */
  private async loadKnown(client: pg.PoolClient, tenantId: string, space: MemorySpace): Promise<KnownEntity[]> {
    const key = `${tenantId}\u0000${space}`;
    const cached = this.cache.get(key);
    const at = this.now();
    if (cached !== undefined && at - cached.at <= this.knownCacheMs) return cached.known;
    const rows = await client.query(
      "SELECT entity_id, kind, name FROM entities WHERE tenant_id = $1 AND space = $2 ORDER BY entity_id LIMIT $3",
      [tenantId, space, ENTITY_LIMITS.maxKnown]
    );
    const known = rows.rows as KnownEntity[];
    this.cache.set(key, { at, known });
    return known;
  }
}

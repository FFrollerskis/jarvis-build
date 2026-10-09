import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction, type EmbeddingProvider } from "@jarvis/memory";
import { isFingerprintErased } from "@jarvis/core";
import { KnowledgeSourceError, type KnowledgeRecord, type KnowledgeSource, type SourceErrorClass } from "./source.ts";
import { classifyKnowledgeSensitivity, type KnowledgeSensitivity, type KnowledgeTrustLevel } from "./sensitivity.ts";
import { exceedsCeiling, resolveSourcePolicy, type KnowledgeSourcePolicy } from "./source-policy.ts";

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
  /** UA-2 P1A §16: elementer kilden selv bevisst hoppet over (f.eks. ustøttet binærfil) - IKKE en feil. */
  skipped: number;
  /** UA-2 P1A §16: satt KUN når `source.list()` kastet et klassifisert `KnowledgeSourceError` - observability, endrer ALDRI tombstone-oppførsel. */
  error_class?: SourceErrorClass;
  /** D-396 (JARVIS-032): `partial` når kilden meldte en delvis/vindu-listing - da ble ingenting tombstonet. */
  listing?: "complete" | "partial";
  /** WP-D1: dokumenter som IKKE ble indeksert fordi de er strengere enn kildens `max_sensitivity` (et allerede indeksert slikt dokument tombstones). Utelatt når 0. */
  excluded?: number;
  /** WP-D1: dokumenter der entitetsindekseringen feilet (selve dokumentet er lagret; indekseringen prøves igjen neste synk). Utelatt når 0. */
  entity_index_failed?: number;
  /** WP-D1: dokumenter eldre enn kildens oppbevaringsfrist (`retention_days`) - ikke indeksert (et allerede indeksert slikt dokument tombstones). Utelatt når 0. */
  expired?: number;
}

/**
 * WP-D1: port mot den DETERMINISTISKE entitetsindekseringen (`KnowledgeEntityIndexer`). Kjøres inline i synk-transaksjonen (rask, ingen modellkall) i en egen delsavepoint: en feil her mister aldri
 * selve dokumentet. Modellassistert uttrekk hører IKKE hjemme her (et modellkall skal aldri holde en databasetransaksjon åpen) - det er et eget pass.
 */
export interface KnowledgeEntityIndexPort {
  /** Versjon av den deterministiske uttrekkeren. Endres den, bygges lenkene på nytt for alle dokumenter ved neste synk (nøkkelen er `<content_hash>:<version>`). */
  readonly version: string;
  index(
    client: pg.PoolClient,
    input: {
      tenant_id: string;
      memory_space_id: MemorySpace;
      knowledge_document_id: string;
      title: string;
      content: string;
      /** Kildens egne (betrodde) proveniens-felt, f.eks. deltakerlisten i et møtereferat. Aldri modellgenerert. */
      metadata: Record<string, JsonValue>;
      sensitivity: KnowledgeSensitivity;
    }
  ): Promise<void>;
}

export interface KnowledgeSyncOptions {
  /** Kildens egne valg (sensitivitetsgulv/-tak, tillit). Utelatt = standardene i `resolveSourcePolicy` (privat, ubetrodd, ingen tak). */
  policy?: KnowledgeSourcePolicy;
  /**
   * Kildens oppbevaringsfrist i dager: et dokument hvis `modified_at` er eldre enn fristen indekseres ikke (og et allerede indeksert tombstones av den vanlige mekanismen). Selve fjerningen av innholdet
   * (hard sletting) gjør `KnowledgeRetentionService.purgeExpired`. Utelatt = ingen frist. Et levende dokument uten `modified_at` regnes aldri som utløpt (alderen er ikke kjent); det fjernes først når det er tombstonet og tombstonen er eldre enn fristen.
   */
  retention_days?: number;
  /** Tidspunkt «nå» for fristberegningen (kun for tester). */
  now?: Date;
  /** Valgfri deterministisk entitetsindeksering (av som standard). */
  entity_indexer?: KnowledgeEntityIndexPort;
}

/**
 * UA-2 P1A §27 (chunking-safeguard): Drive/Obsidian-dokumenter kan bli langt
 * større enn P0 sine korte GitHub-issues/notater. Ekte embedding-leverandører
 * har et input-tak (OpenAI text-embedding-3-small: 8191 tokens) - uten en
 * grense her ville en stor kilde-fil kastet en API-feil inne i
 * `embedAndStore()`, fanget av `upsertOne()` sin try/catch og telt som
 * `failed` (dokumentet lagres, men uten embedding - kun FTS-søkbart).
 *
 * Bevisst MINIMAL løsning (§18/§27 i byggeordren advarer mot avansert
 * semantisk chunking): trunkerer KUN teksten som sendes til `embed()`.
 * `content`-kolonnen (og dermed FTS-indeksen, generert fra `content`) lagrer
 * ALLTID hele, utrunkerte teksten - ingen informasjon går tapt for
 * fulltekstsøk, kun vektorsøket ser en avkortet representasjon av svært
 * lange dokumenter. Dette er IKKE ekte multi-chunk-retrieval (ingen ny
 * chunk-tabell/rader) - en bevisst, dokumentert grense, ikke en forglemmelse.
 */
const MAX_EMBEDDING_INPUT_CHARS = 24_000;

function truncateForEmbedding(content: string): string {
  return content.length > MAX_EMBEDDING_INPUT_CHARS ? content.slice(0, MAX_EMBEDDING_INPUT_CHARS) : content;
}

/** Korte, ikke-reverserbare referanser i logger: en ekstern id kan være et filnavn (møtereferat, personnavn) og skal ikke stå i klartekst i driftsloggen. */
function logRef(externalId: string): string {
  return createHash("sha256").update(externalId).digest("hex").slice(0, 12);
}

/** Frist -> avskjæringstidspunkt (ms siden epoch); ugyldig/utelatt frist = ingen frist. */
function retentionCutoffOf(days: number | undefined, now: Date): number | undefined {
  if (days === undefined || !Number.isFinite(days) || days <= 0) return undefined;
  return now.getTime() - days * 86_400_000;
}

function isOlderThan(modifiedAt: string | null, cutoffMs: number): boolean {
  if (modifiedAt === null) return false;
  const t = Date.parse(modifiedAt);
  return Number.isFinite(t) && t < cutoffMs;
}

/** Øvre grense for `protected_prefixes` fra en kilde (en feilaktig kilde kan ikke gjøre tombstone-spørringen vilkårlig dyr). */
const MAX_PROTECTED_PREFIXES = 1000;

const EMPTY_REPORT: SyncReport = {
  scanned: 0, created: 0, updated: 0, unchanged: 0, tombstoned: 0, reactivated: 0, failed: 0, suppressed: 0, skipped: 0
};

/** Det som utledes per dokument av kildens policy + teksten (se `source-policy.ts`). */
interface DerivedMarks {
  sensitivity: KnowledgeSensitivity;
  trust_level: KnowledgeTrustLevel;
}

/**
 * UA-2 P0 §4-§6/§9: kilde-uavhengig sync-orkestrering. Kilden vet kun å liste
 * sine records (`KnowledgeSource.list()`); ALL canonical-identity/dedupe/
 * tombstone-logikk bor her, én gang, felles for alle kilder.
 *
 * WP-D1 (JARVIS-032): identiteten er nå SPACE-BEVISST - (tenant, memory space, source_type, source_instance_id, external_id) - så en kildeinstans kan finnes i flere rom i
 * samme tenant (migrasjon 086). Alle oppslag og tombstone-spørringer er eksplisitt skopet til rommet, i tillegg til RLS.
 */
export class KnowledgeSyncService {
  private pgVectorCache: boolean | undefined;

  constructor(
    private readonly pool: pg.Pool,
    private readonly embeddings: EmbeddingProvider
  ) {}

  async sync(identity: IdentityContext, memorySpace: MemorySpace, source: KnowledgeSource, options: KnowledgeSyncOptions = {}): Promise<SyncReport> {
    const policy = resolveSourcePolicy(options.policy);
    let records: KnowledgeRecord[];
    let skippedExternalIds: string[] = [];
    let listingPartial = false;
    let tombstoneScope: { metadata_key: string; values: string[] } | undefined;
    let protectedPrefixes: string[] = [];
    try {
      const result = await source.list();
      records = result.records;
      listingPartial = result.listing === "partial";
      tombstoneScope = result.tombstone_scope;
      skippedExternalIds = result.skipped.map((s) => s.external_id);
      protectedPrefixes = (result.protected_prefixes ?? []).filter((p) => typeof p === "string" && p.length > 0).slice(0, MAX_PROTECTED_PREFIXES);
    } catch (err) {
      // Hele kilden feilet (f.eks. nettverk/credential) - ingen dokumenter ble
      // sett, derfor INGEN tombstoning (§5: vi skal aldri tombstone pga. en
      // feilet listing - kun pga. et dokument som faktisk mangler i en VELLYKKET listing).
      // §16: klassifisert kun for observability - påvirker ALDRI dette utfallet.
      const error_class = err instanceof KnowledgeSourceError ? err.errorClass : undefined;
      return { ...EMPTY_REPORT, failed: 1, ...(error_class ? { error_class } : {}) };
    }

    const report: SyncReport = { ...EMPTY_REPORT, skipped: skippedExternalIds.length, ...(listingPartial ? { listing: "partial" as const } : {}) };
    const seenExternalIds: string[] = [];
    const retentionCutoff = retentionCutoffOf(options.retention_days, options.now ?? new Date());

    await withMemoryTransaction(this.pool, identity.tenant_id, [memorySpace], async (client) => {
      for (const record of records) {
        report.scanned += 1;
        // WP-D1: oppbevaringsfrist - for gammelt innhold indekseres ikke (og regnes ikke som «sett», så et indeksert dokument tombstones og senere fjernes av purge).
        if (retentionCutoff !== undefined && isOlderThan(record.modified_at, retentionCutoff)) {
          report.expired = (report.expired ?? 0) + 1;
          continue;
        }
        // WP-D1: sensitivitet = strengeste av kildens gulv og klassifiseringen av tittel + innhold (rommet teller: helse er alltid special). Et dokument over kildens tak indekseres ikke, og
        // regnes bevisst IKKE som «sett»: et allerede indeksert dokument som nå er over taket tombstones av den vanlige mekanismen under (ikke beskyttet som `skipped`).
        const marks: DerivedMarks = {
          sensitivity: classifyKnowledgeSensitivity({ memory_space: memorySpace, texts: [record.title, record.content], floor: policy.floor }).sensitivity,
          trust_level: policy.trust
        };
        if (exceedsCeiling(marks.sensitivity, policy.ceiling)) {
          report.excluded = (report.excluded ?? 0) + 1;
          continue;
        }
        seenExternalIds.push(record.external_id);
        // D-396 (JARVIS-032): én mislykket SQL-setning i en Postgres-transaksjon avbryter HELE transaksjonen («current transaction is aborted») -
        // alle påfølgende records og tombstone-spørringen feilet da også. SAVEPOINT per record isolerer feilen til akkurat dette dokumentet.
        await client.query("SAVEPOINT knowledge_record");
        try {
          await this.upsertOne(client, identity.tenant_id, memorySpace, record, report, marks, options.entity_indexer);
          await client.query("RELEASE SAVEPOINT knowledge_record");
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT knowledge_record");
          await client.query("RELEASE SAVEPOINT knowledge_record");
          report.failed += 1;
          // Kun feilmelding (aldri innhold) - tidligere ble årsaken svelget helt.
          console.warn(JSON.stringify({
            msg: "knowledge_sync_record_failed", source_type: source.source_type, external_id_ref: logRef(record.external_id),
            error: (err as Error).message.slice(0, 200)
          }));
        }
      }

      // §5/§16: tombstone alt som IKKE ble sett OG IKKE ble eksplisitt hoppet
      // over i denne VELLYKKEDE listingen. Et `skipped`-element (f.eks. en
      // enkelt fil kilden midlertidig ikke fikk lest pga. rate-limit/nettverk)
      // er IKKE bekreftet borte - det skal ALDRI tombstones bare fordi ETT
      // element feilet, kun elementer kilden faktisk så mangle. Aldri
      // hard-delete her uansett - historikk/provenance blir stående.
      const protectedExternalIds = [...seenExternalIds, ...skippedExternalIds];
      if (listingPartial) {
        // D-396 (JARVIS-032): partiell listing (vindu/avkortet) - fravær er ikke bevis på sletting. Kilden kan peke ut en trygg delmengde
        // (`tombstone_scope`, f.eks. meldinger som faktisk ble listet); uten scope tombstones ingenting.
        if (!tombstoneScope || tombstoneScope.values.length === 0 || !/^[a-z_][a-z0-9_]*$/.test(tombstoneScope.metadata_key)) {
          report.tombstoned = 0;
          return;
        }
        const scoped = await client.query(
          `UPDATE knowledge_documents SET deleted = true, deleted_at = now(), updated_at = now()
           WHERE tenant_id = $1 AND memory_space_id = $7 AND source_type = $2 AND source_instance_id = $3 AND deleted = false
             AND (metadata ->> $5) = ANY($6::text[]) AND NOT (external_id = ANY($4::text[]))
             AND NOT EXISTS (SELECT 1 FROM unnest($8::text[]) AS p(prefix) WHERE left(external_id, length(p.prefix)) = p.prefix)`,
          [identity.tenant_id, source.source_type, source.source_instance_id, protectedExternalIds, tombstoneScope.metadata_key, tombstoneScope.values, memorySpace, protectedPrefixes]
        );
        report.tombstoned = scoped.rowCount ?? 0;
        return;
      }
      const tombstoneResult = await client.query(
        `UPDATE knowledge_documents SET deleted = true, deleted_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND memory_space_id = $5 AND source_type = $2 AND source_instance_id = $3 AND deleted = false
           AND NOT (external_id = ANY($4::text[]))
           AND NOT EXISTS (SELECT 1 FROM unnest($6::text[]) AS p(prefix) WHERE left(external_id, length(p.prefix)) = p.prefix)`,
        [identity.tenant_id, source.source_type, source.source_instance_id, protectedExternalIds, memorySpace, protectedPrefixes]
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
    report: SyncReport,
    marks: DerivedMarks,
    indexer: KnowledgeEntityIndexPort | undefined
  ): Promise<void> {
    const existing = await client.query(
      `SELECT knowledge_document_id, content_hash, deleted, entities_indexed_key FROM knowledge_documents
       WHERE tenant_id = $1 AND memory_space_id = $2 AND source_type = $3 AND source_instance_id = $4 AND external_id = $5`,
      [tenantId, space, record.source_type, record.source_instance_id, record.external_id]
    );
    const row = existing.rows[0] as { knowledge_document_id: string; content_hash: string; deleted: boolean; entities_indexed_key: string | null } | undefined;

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
            canonical_uri, title, content, content_type, content_hash, modified_at, metadata, sensitivity, trust_level)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id, tenantId, space, record.source_type, record.source_instance_id, record.external_id,
          record.canonical_uri, record.title, record.content, record.content_type, record.content_hash,
          record.modified_at, JSON.stringify(record.metadata), marks.sensitivity, marks.trust_level
        ]
      );
      await this.embedAndStore(client, id, tenantId, space, record.content);
      await this.indexEntities(client, indexer, tenantId, space, id, record, marks.sensitivity, report);
      report.created += 1;
      return;
    }

    if (row.content_hash === record.content_hash && !row.deleted) {
      // §9: uendret INNHOLD - nær no-op, INGEN re-embedding. Tittel/uri/
      // metadata oppdateres likevel (billig, ingen embedding involvert) -
      // UA-2 P1A §25: en Drive-omdøpning endrer `title` men ALDRI
      // `external_id` (stabil fil-id), og skal derfor synes i neste sync
      // uten å telle som et innholds-"updated".
      // WP-D1: sensitivitet/tillit regnes om hver gang (kildens policy eller ordforrådet kan ha endret seg) - billig, ingen embedding.
      await client.query(
        `UPDATE knowledge_documents
         SET title = $2, canonical_uri = $3, modified_at = $4, metadata = $5, last_synced_at = now(), sensitivity = $6, trust_level = $7
         WHERE knowledge_document_id = $1`,
        [row.knowledge_document_id, record.title, record.canonical_uri, record.modified_at, JSON.stringify(record.metadata), marks.sensitivity, marks.trust_level]
      );
      await this.indexEntities(client, indexer, tenantId, space, row.knowledge_document_id, record, marks.sensitivity, report, row.entities_indexed_key);
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
             metadata = $5, last_synced_at = now(), updated_at = now(), sensitivity = $6, trust_level = $7
         WHERE knowledge_document_id = $1`,
        [row.knowledge_document_id, record.title, record.canonical_uri, record.modified_at, JSON.stringify(record.metadata), marks.sensitivity, marks.trust_level]
      );
      await this.indexEntities(client, indexer, tenantId, space, row.knowledge_document_id, record, marks.sensitivity, report, row.entities_indexed_key);
      report.reactivated += 1;
      return;
    }

    // Innhold endret (§4: ny versjon/hash) - og/eller reappearing MED endring (§5: reaktiveres samtidig).
    await client.query(
      `UPDATE knowledge_documents
       SET content = $2, content_hash = $3, version = version + 1, deleted = false, deleted_at = NULL,
           title = $4, canonical_uri = $5, content_type = $6, modified_at = $7, metadata = $8,
           last_synced_at = now(), updated_at = now(), sensitivity = $9, trust_level = $10
       WHERE knowledge_document_id = $1`,
      [
        row.knowledge_document_id, record.content, record.content_hash, record.title, record.canonical_uri,
        record.content_type, record.modified_at, JSON.stringify(record.metadata), marks.sensitivity, marks.trust_level
      ]
    );
    await this.embedAndStore(client, row.knowledge_document_id, tenantId, space, record.content);
    await this.indexEntities(client, indexer, tenantId, space, row.knowledge_document_id, record, marks.sensitivity, report, null);
    if (row.deleted) {
      report.reactivated += 1;
    } else {
      report.updated += 1;
    }
  }

  /**
   * WP-D1: deterministisk entitetsindeksering inline, i en EGEN delsavepoint (en feil mister aldri dokumentet). Hopper over når nøkkelen (`<content_hash>:<versjon>`) allerede stemmer -
   * dermed er en uendret synk fortsatt nær no-op, mens endret innhold, en ny uttrekker-versjon eller et dokument som aldri ble indeksert (grafen ble slått på senere) bygges på nytt.
   * Tombstonede dokumenter indekseres ikke (kun levende innhold skal kunne nås via grafen).
   */
  private async indexEntities(
    client: pg.PoolClient,
    indexer: KnowledgeEntityIndexPort | undefined,
    tenantId: string,
    space: MemorySpace,
    documentId: string,
    record: KnowledgeRecord,
    sensitivity: KnowledgeSensitivity,
    report: SyncReport,
    currentKey?: string | null
  ): Promise<void> {
    if (indexer === undefined) return;
    const key = `${record.content_hash}:${indexer.version}`;
    if (currentKey !== undefined && currentKey === key) return;
    await client.query("SAVEPOINT knowledge_entities");
    try {
      await indexer.index(client, {
        tenant_id: tenantId, memory_space_id: space, knowledge_document_id: documentId, title: record.title, content: record.content, metadata: record.metadata, sensitivity
      });
      await client.query("UPDATE knowledge_documents SET entities_indexed_key = $2 WHERE knowledge_document_id = $1", [documentId, key]);
      await client.query("RELEASE SAVEPOINT knowledge_entities");
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT knowledge_entities");
      await client.query("RELEASE SAVEPOINT knowledge_entities");
      report.entity_index_failed = (report.entity_index_failed ?? 0) + 1;
      console.warn(JSON.stringify({ msg: "knowledge_entity_index_failed", source_type: record.source_type, external_id_ref: logRef(record.external_id), error: (err as Error).message.slice(0, 200) }));
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
    const vector = await this.embeddings.embed(truncateForEmbedding(content));
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

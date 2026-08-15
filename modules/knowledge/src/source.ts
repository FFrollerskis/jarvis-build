import type { JsonValue } from "@jarvis/contracts";

/**
 * UA-2 P0 §1: kilde-uavhengig kunnskapsrecord. ALLE fremtidige kilder
 * (Obsidian, Pieces, Drive, e-post, møtetranskripsjon - UA-2 P1+) skal kunne
 * representeres uten å redesigne denne kontrakten eller lagringsmodellen.
 *
 * ALDRI credentials her - kun trusted provenance-metadata. `metadata` er for
 * kilde-spesifikke felter (f.eks. GitHub issue-state, filstørrelse) - aldri
 * hemmeligheter, aldri modellgenerert innhold.
 */
export interface KnowledgeRecord {
  /** Kildetype, f.eks. "github" | "filesystem" (fremtidig: "obsidian" | "drive" | ...). */
  source_type: string;
  /** Stabil identifikator for KILDEINSTANSEN (f.eks. "github:tsworkflow/jarvisbuild", "fs:docs-root"). */
  source_instance_id: string;
  /** Stabil identifikator INNENFOR kilden (issue-nummer, relativ filsti) - canonical identity for dedupe. */
  external_id: string;
  /** Menneske-/maskinlesbar lokasjon (URL, filsti). */
  canonical_uri: string;
  title: string;
  content: string;
  /** MIME-type eller enkel typemarkør, f.eks. "text/markdown". */
  content_type: string;
  /** sha256 av `content` - endringsdeteksjon og idempotent re-embedding. */
  content_hash: string;
  /** Kildens eget endringstidspunkt, når tilgjengelig (ALDRI antatt/gjettet). */
  modified_at: string | null;
  /** Trusted provenance-ekstra - aldri secrets, aldri modellgenerert. */
  metadata: Record<string, JsonValue>;
}

/**
 * En kilde vet KUN å liste sine nåværende records - sync/dedupe/tombstone-
 * logikken (§4-§5) eies av `KnowledgeSyncService`, ikke kilden selv. Dette
 * holder kildeadaptere tynne, akkurat som `ToolTransport` i Tool Gateway.
 */
export interface KnowledgeSource {
  readonly source_type: string;
  readonly source_instance_id: string;
  list(): Promise<KnowledgeRecord[]>;
}

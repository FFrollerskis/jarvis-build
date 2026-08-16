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
  /** Kildetype, f.eks. "github" | "filesystem" | "google_drive" | "obsidian". */
  source_type: string;
  /** Stabil identifikator for KILDEINSTANSEN (f.eks. "github:tsworkflow/jarvisbuild", "fs:docs-root"). */
  source_instance_id: string;
  /** Stabil identifikator INNENFOR kilden (issue-nummer, relativ filsti, Drive file id) - canonical identity for dedupe/rename-toleranse. */
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
 * UA-2 P1A §16: typet feilklassifisering for kilde-svikt. Skillet
 * retryable/ikke-retryable + AUTH/PERMISSION/RATE_LIMIT osv. lar
 * `KnowledgeSyncService` (og en fremtidig retry-orkestrering) reagere
 * PRESIST i stedet for å behandle enhver feil likt.
 *
 * KRITISK sikkerhetsegenskap (§15): en typet feil her betyr ALLTID "listingen
 * lyktes ikke" - `KnowledgeSyncService.sync()` tombstoner ALDRI noe når
 * `list()` kaster, uansett feilklasse. Skillet finnes for observability/
 * diagnostikk, IKKE for å avgjøre om tombstoning er trygt (den regelen er
 * absolutt og uavhengig av feilklasse).
 */
export type SourceErrorClass =
  | "AUTH"
  | "PERMISSION"
  | "RATE_LIMIT"
  | "TRANSIENT_NETWORK"
  | "NOT_FOUND"
  | "UNSUPPORTED_CONTENT"
  | "INVALID_CONFIG"
  | "SOURCE_UNAVAILABLE";

const RETRYABLE_CLASSES: ReadonlySet<SourceErrorClass> = new Set(["RATE_LIMIT", "TRANSIENT_NETWORK", "SOURCE_UNAVAILABLE"]);

/** Kastes av en `KnowledgeSource.list()`-implementasjon for TOTAL svikt (hele listingen kunne ikke fullføres trygt). */
export class KnowledgeSourceError extends Error {
  readonly errorClass: SourceErrorClass;
  readonly retryable: boolean;

  constructor(errorClass: SourceErrorClass, message: string) {
    super(message);
    this.name = "KnowledgeSourceError";
    this.errorClass = errorClass;
    this.retryable = RETRYABLE_CLASSES.has(errorClass);
  }
}

/** Ett enkelt element bevisst IKKE inkludert i denne synkroniseringen - ALDRI en feil som skal stoppe resten av kilden. */
export interface SkippedRecord {
  external_id: string;
  reason: SourceErrorClass;
  /** Trygg, kort forklaring - ALDRI innhold/secrets. */
  detail?: string;
}

export interface KnowledgeListResult {
  records: KnowledgeRecord[];
  /** Elementer bevisst hoppet over (f.eks. binærfiler Drive ikke kan eksportere til tekst) - IKKE en feil, IKKE tombstonet. */
  skipped: SkippedRecord[];
}

/**
 * En kilde vet KUN å liste sine nåværende records - sync/dedupe/tombstone-
 * logikken (§4-§5) eies av `KnowledgeSyncService`, ikke kilden selv. Dette
 * holder kildeadaptere tynne, akkurat som `ToolTransport` i Tool Gateway.
 *
 * UA-2 P1A: `list()` MÅ enten (a) returnere et resultat som representerer
 * kildens FULLSTENDIGE nåværende tilstand (alt annet tombstones), eller
 * (b) kaste `KnowledgeSourceError` for TOTAL svikt (ingenting tombstones).
 * Et PARTIELT resultat (noen elementer lest, resten feilet) skal ALDRI
 * returneres som om det var fullstendig - kilder som kan liste i sider
 * MÅ selv aggregere alle sider internt før de returnerer, eller kaste hvis
 * en side feiler midtveis (se `GoogleDriveKnowledgeSource` for et konkret
 * eksempel - paginering håndteres INNENFOR `list()`, ikke eksponert i
 * kontrakten, nettopp for å bevare denne invarianten enkelt og verifiserbart).
 */
export interface KnowledgeSource {
  readonly source_type: string;
  readonly source_instance_id: string;
  list(): Promise<KnowledgeListResult>;
}

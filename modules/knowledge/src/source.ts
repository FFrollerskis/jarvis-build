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

/**
 * UA-2 P1A §15: mapper en ToolGateway `reason`-streng (fra `ToolResult`
 * sitt `{ ok: false, reason }`) til en typet `SourceErrorClass`. Delt
 * mellom alle ToolGateway-baserte kilder (GitHub, Google Drive) - samme
 * klassifiseringsregel skal ALDRI driftes fra hverandre per kilde.
 * Konservativ default (`SOURCE_UNAVAILABLE`, retryable) for ukjente
 * årsaker - en transient feil skal ALDRI klassifiseres som noe som ser
 * mer permanent/skummelt ut enn den er.
 */
export function classifyToolFailure(reason: string): SourceErrorClass {
  // Dekker BÅDE en direkte policy-deny ("rate_limited" fra ToolGateway sin
  // egen rate-limiter) OG et transport-kastet feilbudskap pakket i
  // "tool_failed:<message>" (f.eks. "tool_failed:drive_rate_limited") -
  // samme substring-tilnærming som ToolGateway sin egen health-klassifisering
  // (gateway.ts: /401|403|auth/, /429|rate/) for å unngå at de to driver fra hverandre.
  if (/429|rate.?limit/.test(reason)) return "RATE_LIMIT";
  if (/auth_failed|401|403/.test(reason)) return "AUTH";
  if (/not_found|404/.test(reason)) return "NOT_FOUND";
  return "SOURCE_UNAVAILABLE";
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
  /**
   * D-396 (JARVIS-032): `partial` = listingen er et VINDU/en avkortet delmengde av kildens tilstand (f.eks. e-post «siste 14 dager, maks N»).
   * Fravær i en partiell listing betyr IKKE at dokumentet er slettet - `KnowledgeSyncService` tombstoner da ALDRI. Utelatt = `complete` (uendret kontrakt).
   */
  listing?: "complete" | "partial";
  /**
   * D-396 (JARVIS-032): for en `partial` listing kan kilden likevel peke ut en TRYGG delmengde å tombstone: kun dokumenter hvis `metadata[metadata_key]`
   * er blant `values` (f.eks. e-post: meldinger som faktisk ble listet - et vedlegg/en side som mangler i en listet melding er borte; meldinger utenfor vinduet røres ikke).
   */
  tombstone_scope?: { metadata_key: string; values: string[] };
  /**
   * WP-D1: `external_id`-prefikser kilden IKKE fikk talt opp denne runden (f.eks. alle arkene i et regneark der arklisten midlertidig feilet). Allerede lagrede dokumenter hvis `external_id` STARTER med en av dem
   * tombstones aldri - samme prinsipp som `skipped`, men for underelementer kilden ikke kjenner id-ene til. Utelatt = ingen prefikser (uendret kontrakt).
   */
  protected_prefixes?: string[];
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

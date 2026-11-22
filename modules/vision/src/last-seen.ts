import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import type { VisionEmbeddingService } from "./embeddings.ts";
import { DEFAULT_INVENTORY_HALF_LIFE_HOURS, type VisionInventoryService } from "./inventory.ts";
import { decayedConfidence, normalizeObjectLabel } from "./labels.ts";

/**
 * WP-G3 (D-465), P1c: «sist sett»-arbeidsflyten (UA-9 akseptansekriterium 1: «object identification and 'last seen' workflows work when event data exists»).
 *
 * Svaret bygges UTELUKKENDE av lagrede, klassifiserte kamerahendelser (tidsminnet) + inventaret + (valgfritt) vektorer:
 *   1. EKSAKT: nyeste `object_detected`-hendelse med nøyaktig samme normaliserte objektnavn (samme `normalizeObjectLabel` som skriveren bruker).
 *   2. SEMANTISK (kun hvis ingen eksakt treff og en lokal embedding finnes): nærmeste objektnavn etter vektorlikhet - merket `match: "semantic"` med likheten, aldri presentert som eksakt.
 *   3. INVENTAR: om gjenstanden FORTSATT regnes som til stede i et rom (forfalt confidence over terskel), og hvilket.
 * Ingenting her «vet» noe utover hendelsene: er det ingen hendelser, er svaret `found: false` (aldri gjetting). `caveats` sier ærlig hva svaret bygger på (kameraplassering, ikke
 * visuell romgjenkjenning; modellklassifisering er ubetrodd; hash-embedding er unøyaktig). Objektnavnene i svaret er normaliserte DATA, ikke instruksjoner - kalleren (tool/rute) merker
 * utdata `untrusted`. Kamerabilder er BEGRENSET data: svaret inneholder aldri bildebytes, kun `has_snapshot`.
 */
export interface LastSeenSighting {
  observation_id: string;
  object_label: string;
  room_id: string | null;
  room_name: string | null;
  observed_at: string;
  confidence: number | null;
  has_snapshot: boolean;
  source_type: string;
  source_instance_id: string;
  match: "exact" | "semantic";
  /** `null` for eksakte treff. */
  similarity: number | null;
}

export interface LastSeenAnswer {
  /** Det NORMALISERTE søkeordet (`null` hvis spørsmålet ikke lot seg normalisere). */
  query: string | null;
  found: boolean;
  last?: LastSeenSighting;
  /** Sekunder siden `observed_at` (kildens tidsstempel). */
  age_seconds?: number;
  /** Observasjonens confidence forfalt etter alder (samme formel som inventaret). */
  effective_confidence?: number;
  /** Regnes gjenstanden fortsatt som til stede (inventar over terskel) - og i så fall hvor. */
  inventory_present_now?: boolean;
  inventory_rooms?: Array<{ room_id: string; room_name: string | null; effective_confidence: number; last_seen_at: string }>;
  /** Tidligere observasjoner av samme navn (nyeste først, maks 5, uten `last`). */
  earlier: LastSeenSighting[];
  caveats: string[];
}

export interface LastSeenOptions {
  embeddings?: VisionEmbeddingService;
  inventory?: VisionInventoryService;
  now?: () => Date;
  halfLifeHours?: number;
}

function toSighting(row: Record<string, unknown>, match: "exact" | "semantic", similarity: number | null): LastSeenSighting {
  return {
    observation_id: String(row["observation_id"]),
    object_label: String(row["object_label"]),
    room_id: row["room_id"] === null || row["room_id"] === undefined ? null : String(row["room_id"]),
    room_name: row["room_name"] === null || row["room_name"] === undefined ? null : String(row["room_name"]),
    observed_at: new Date(String(row["observed_at"])).toISOString(),
    confidence: row["confidence"] === null || row["confidence"] === undefined ? null : Number(row["confidence"]),
    has_snapshot: row["has_snapshot"] === true,
    source_type: String(row["source_type"]),
    source_instance_id: String(row["source_instance_id"]),
    match,
    similarity
  };
}

export class VisionLastSeenService {
  private readonly now: () => Date;
  private readonly halfLifeHours: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: LastSeenOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.halfLifeHours = options.halfLifeHours ?? options.inventory?.halfLifeHours ?? DEFAULT_INVENTORY_HALF_LIFE_HOURS;
  }

  private async exactSightings(tenantId: string, memorySpace: MemorySpace, personId: string, label: string, limit: number): Promise<LastSeenSighting[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT o.observation_id, o.object_label, o.room_id, r.name AS room_name, o.observed_at, o.confidence, (o.snapshot_ref IS NOT NULL) AS has_snapshot, o.source_type, o.source_instance_id
           FROM vision_event_observations o
           LEFT JOIN vision_rooms r ON r.tenant_id = o.tenant_id AND r.memory_space_id = o.memory_space_id AND r.person_id = o.person_id AND r.room_id = o.room_id
          WHERE o.tenant_id = $1 AND o.person_id = $2 AND o.event_type = 'object_detected' AND o.object_label = $3
          ORDER BY o.observed_at DESC, o.recorded_at DESC LIMIT $4`,
        [tenantId, personId, label, limit]
      );
      return (rows as Array<Record<string, unknown>>).map((row) => toSighting(row, "exact", null));
    });
  }

  async whereLastSeen(tenantId: string, memorySpace: MemorySpace, personId: string, rawQuery: string): Promise<LastSeenAnswer> {
    const caveats: string[] = ["based_on_camera_events_only", "room_from_camera_placement_not_visual_recognition", "model_classification_is_untrusted"];
    const label = normalizeObjectLabel(rawQuery);
    if (label === null) return { query: null, found: false, earlier: [], caveats: [...caveats, "invalid_query"] };

    let sightings = await this.exactSightings(tenantId, memorySpace, personId, label, 6);
    let semantic = false;
    if (sightings.length === 0 && this.options.embeddings !== undefined) {
      try {
        const matches = await this.options.embeddings.searchObjects(tenantId, memorySpace, personId, this.options.embeddings.descriptorFor({ event_type: "object_detected", object_label: label }), { limit: 6 });
        sightings = matches.map((m) =>
          toSighting({ ...m, has_snapshot: m.has_snapshot }, "semantic", m.similarity)
        );
        semantic = sightings.length > 0;
      } catch {
        caveats.push("semantic_search_unavailable");
      }
    }
    if (semantic) caveats.push(this.options.embeddings?.provider.model === "local-hash-v1" ? "semantic_match_is_approximate_hash_embedding" : "semantic_match_is_approximate");
    const last = sightings[0];
    if (last === undefined) return { query: label, found: false, earlier: [], caveats };

    const nowMs = this.now().getTime();
    const observedMs = new Date(last.observed_at).getTime();
    const answer: LastSeenAnswer = {
      query: label,
      found: true,
      last,
      age_seconds: Math.max(0, Math.round((nowMs - observedMs) / 1000)),
      effective_confidence: decayedConfidence(last.confidence ?? 0.5, observedMs, nowMs, this.halfLifeHours),
      earlier: sightings.slice(1, 6),
      caveats
    };
    if (this.options.inventory !== undefined) {
      const items = (await this.options.inventory.find(tenantId, memorySpace, personId, last.object_label)).filter((item) => item.present);
      answer.inventory_present_now = items.length > 0;
      answer.inventory_rooms = items.map((item) => ({ room_id: item.room_id, room_name: item.room_name, effective_confidence: item.effective_confidence, last_seen_at: item.last_seen_at }));
    }
    return answer;
  }
}

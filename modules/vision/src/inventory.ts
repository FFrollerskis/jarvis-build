import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { decayedConfidence } from "./labels.ts";

/**
 * WP-G3 (D-465), P1c: inventar per rom (`vision_inventory_items`, 135) - den AVLEDEDE tilstanden «hva står i dette rommet nå», bygget av objektobservasjoner (pipeline.ts).
 *
 * - Én rad per (person, rom, normalisert objektnavn). Romassosiasjonen kommer fra kameraets PLASSERING (eierens egen `vision_cameras.room_id`), ikke fra visuell romgjenkjenning
 *   (DEFERRED: Jarvis gjetter aldri et rom fra et bilde).
 * - Confidence FORFALLER med tiden: `effective = confidence * 0.5^(alder / halveringstid)` (standard 24 t). En gjenstand regnes som «til stede» når effektiv confidence >= terskel
 *   (standard 0,30). En ny observasjon blander forfalt gammel confidence med den nye (støy-eller: `1 - (1-gammel)(1-ny)`, maks 0,99). SQL-upserten og `decayedConfidence()` bruker
 *   SAMME formel (låst av en test), så det som skrives og det som leses aldri driver fra hverandre.
 * - Utløp: `expires_at` forankres på databasens EGEN klokke ved hver oppdatering (aldri på kildens tidsstempel); `last_seen_at` klemmes til `now()` (et fremtidsdatert kildetidsstempel
 *   kan ikke holde en gjenstand «ferskt sett» for alltid). Utløpte rader slettes av vedlikeholdssveipet (sweep.ts) og av erasure.
 * - FRAVÆR («nøklene er borte») utledes IKKE (DEFERRED): kamerabildet viser kun det som er synlig, ikke det som mangler.
 */
export const DEFAULT_INVENTORY_HALF_LIFE_HOURS = 24;
export const DEFAULT_INVENTORY_PRESENT_THRESHOLD = 0.3;

export interface InventoryItem {
  item_id: string;
  room_id: string;
  room_name: string | null;
  object_label: string;
  /** Confidence ved siste observasjon (blandet). */
  confidence: number;
  /** Confidence NÅ (forfalt etter alder). */
  effective_confidence: number;
  present: boolean;
  seen_count: number;
  first_seen_at: string;
  last_seen_at: string;
  expires_at: string;
}

export interface SightingInput {
  tenantId: string;
  memorySpace: MemorySpace;
  personId: string;
  roomId: string;
  objectLabel: string;
  confidence: number;
  observedAt: string;
  observationId: string;
  sourceType: string;
  sourceInstanceId: string;
  taskId: string;
  sessionId?: string | undefined;
  retentionDays: number;
}

export interface InventoryOptions {
  halfLifeHours?: number;
  presentThreshold?: number;
  now?: () => Date;
}

export class VisionInventoryService {
  readonly halfLifeHours: number;
  readonly presentThreshold: number;
  private readonly now: () => Date;

  constructor(
    private readonly pool: pg.Pool,
    options: InventoryOptions = {}
  ) {
    this.halfLifeHours = options.halfLifeHours ?? DEFAULT_INVENTORY_HALF_LIFE_HOURS;
    this.presentThreshold = options.presentThreshold ?? DEFAULT_INVENTORY_PRESENT_THRESHOLD;
    this.now = options.now ?? (() => new Date());
    if (!(this.halfLifeHours > 0)) throw new Error("vision_inventory_half_life_invalid");
  }

  /** Oppdaterer inventaret for ÉN observasjon i kallerens transaksjon (pipeline.ts skriver hendelse, vektor og inventar atomisk). */
  async recordSightingInTransaction(client: pg.PoolClient, input: SightingInput): Promise<void> {
    await client.query(
      `INSERT INTO vision_inventory_items
         (item_id, tenant_id, memory_space_id, person_id, room_id, object_label, confidence, seen_count, first_seen_at, last_seen_at, last_observation_id,
          source_type, source_instance_id, expires_at, task_id, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, LEAST($8::timestamptz, now()), LEAST($8::timestamptz, now()), $9, $10, $11, now() + ($12 || ' days')::interval, $13, $14)
       ON CONFLICT (tenant_id, memory_space_id, person_id, room_id, object_label) DO UPDATE SET
         confidence = LEAST(0.99, 1 - (1 - (vision_inventory_items.confidence * power(0.5, GREATEST(0, EXTRACT(EPOCH FROM (EXCLUDED.last_seen_at - vision_inventory_items.last_seen_at)) / 3600.0) / $15::double precision))) * (1 - EXCLUDED.confidence)),
         seen_count = vision_inventory_items.seen_count + 1,
         first_seen_at = LEAST(vision_inventory_items.first_seen_at, EXCLUDED.first_seen_at),
         last_observation_id = CASE WHEN EXCLUDED.last_seen_at >= vision_inventory_items.last_seen_at THEN EXCLUDED.last_observation_id ELSE vision_inventory_items.last_observation_id END,
         last_seen_at = GREATEST(vision_inventory_items.last_seen_at, EXCLUDED.last_seen_at),
         source_type = EXCLUDED.source_type, source_instance_id = EXCLUDED.source_instance_id,
         expires_at = EXCLUDED.expires_at, task_id = EXCLUDED.task_id, session_id = EXCLUDED.session_id, updated_at = now()`,
      [
        `vis-inv-${randomUUID()}`, input.tenantId, input.memorySpace, input.personId, input.roomId, input.objectLabel, Math.min(0.99, Math.max(0, input.confidence)),
        input.observedAt, input.observationId, input.sourceType, input.sourceInstanceId, input.retentionDays, input.taskId, input.sessionId ?? null, this.halfLifeHours
      ]
    );
  }

  private toItem(row: Record<string, unknown>, nowMs: number): InventoryItem {
    const confidence = Number(row["confidence"]);
    const lastSeen = new Date(String(row["last_seen_at"])).getTime();
    const effective = decayedConfidence(confidence, lastSeen, nowMs, this.halfLifeHours);
    return {
      item_id: String(row["item_id"]),
      room_id: String(row["room_id"]),
      room_name: row["room_name"] === null || row["room_name"] === undefined ? null : String(row["room_name"]),
      object_label: String(row["object_label"]),
      confidence,
      effective_confidence: effective,
      present: effective >= this.presentThreshold,
      seen_count: Number(row["seen_count"]),
      first_seen_at: new Date(String(row["first_seen_at"])).toISOString(),
      last_seen_at: new Date(lastSeen).toISOString(),
      expires_at: new Date(String(row["expires_at"])).toISOString()
    };
  }

  /** Inventaret for ÉN navngitt person (eksplisitt scope), valgfritt ett rom. Utløpte rader er skjult; `presentOnly` skjuler også forfalt-under-terskel. */
  async list(tenantId: string, memorySpace: MemorySpace, personId: string, filter: { roomId?: string; presentOnly?: boolean } = {}): Promise<InventoryItem[]> {
    const nowMs = this.now().getTime();
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const params: unknown[] = [tenantId, personId];
      let roomClause = "";
      if (filter.roomId !== undefined) {
        params.push(filter.roomId);
        roomClause = ` AND i.room_id = $${params.length}`;
      }
      const { rows } = await client.query(
        `SELECT i.*, r.name AS room_name FROM vision_inventory_items i
           LEFT JOIN vision_rooms r ON r.tenant_id = i.tenant_id AND r.memory_space_id = i.memory_space_id AND r.person_id = i.person_id AND r.room_id = i.room_id
          WHERE i.tenant_id = $1 AND i.person_id = $2 AND i.expires_at > now()${roomClause}
          ORDER BY i.last_seen_at DESC, i.object_label ASC`,
        params
      );
      const items = (rows as Array<Record<string, unknown>>).map((row) => this.toItem(row, nowMs));
      return (filter.presentOnly ? items.filter((item) => item.present) : items).sort((a, b) => b.effective_confidence - a.effective_confidence || a.object_label.localeCompare(b.object_label));
    });
  }

  /** Én gjenstand (rom + navn) - brukes av «sist sett» for å si om den fortsatt regnes som til stede. */
  async find(tenantId: string, memorySpace: MemorySpace, personId: string, objectLabel: string): Promise<InventoryItem[]> {
    const all = await this.list(tenantId, memorySpace, personId);
    return all.filter((item) => item.object_label === objectLabel);
  }

  async purgeExpired(tenantId: string, memorySpace: MemorySpace): Promise<number> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rowCount } = await client.query(`DELETE FROM vision_inventory_items WHERE tenant_id = $1 AND memory_space_id = $2 AND expires_at <= now()`, [tenantId, memorySpace]);
      return rowCount ?? 0;
    });
  }
}

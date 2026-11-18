import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { z } from "zod";
import type { VisionRoutePolicy, VisionZoneKind } from "./policy.ts";

/**
 * WP-G3 (D-465): kameraregisteret (`vision_cameras`, 133) - Jarvis' EGEN domenetilstand (JARVIS_CANONICAL, D-64). Home Assistant og iPhone er KILDER: `source_ref` er en peker
 * (HA: kameraets entity_id; iPhone: enhetens device_id), aldri en kopi av leverandørens tilstand.
 *
 * Autoritet: registrering/endring/fjerning skjer KUN via eier-ruter (apps/api/src/vision-routes.ts: eier + signert enhetsøkt); det finnes ingen modellvei hit. Tjenesten
 * validerer i tillegg selv (aldri bare databasen): HA-entity-id-er har et lukket tegnsett (de interpoleres i en URL-sti mot Home Assistant), etiketten er eierens egen tekst
 * uten kontrolltegn, og sone-/policy-regelen («kun hjemmesonen lagrer bilder») sjekkes FØR databasen (som i tillegg har en CHECK).
 */
export interface VisionCamera {
  camera_id: string;
  tenant_id: string;
  memory_space_id: string;
  person_id: string;
  label: string;
  source_type: "home_assistant" | "iphone";
  source_ref: string;
  trigger_entities: string[];
  room_id: string | null;
  zone_kind: VisionZoneKind;
  route_policy: VisionRoutePolicy;
  cooldown_seconds: number;
  enabled: boolean;
  task_id: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export class VisionCameraValidationError extends Error {
  constructor(
    readonly field: string,
    readonly detail: string
  ) {
    super(`vision_camera_invalid:${field}:${detail}`);
    this.name = "VisionCameraValidationError";
  }
}

const HA_CAMERA_ENTITY = /^camera\.[a-z0-9_]{1,100}$/;
const HA_TRIGGER_ENTITY = /^(?:binary_sensor|event|alarm_control_panel)\.[a-z0-9_]{1,100}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL = /\p{Cc}/u;

const ZoneSchema = z.enum(["home", "workplace", "shared"]);
const PolicySchema = z.enum(["discard", "local_only", "store_snapshot"]);

export const RegisterCameraInputSchema = z
  .object({
    person_id: z.string().min(1).max(200),
    label: z.string().min(1).max(80),
    source_type: z.enum(["home_assistant", "iphone"]),
    source_ref: z.string().min(1).max(200),
    trigger_entities: z.array(z.string().min(1).max(200)).max(8).optional(),
    room_id: z.string().min(1).max(200).optional(),
    zone_kind: ZoneSchema,
    /** Ingen standard: Jarvis gjetter aldri hva et kamera får gjøre med et bilde. */
    route_policy: PolicySchema,
    cooldown_seconds: z.number().int().min(5).max(3600).optional(),
    enabled: z.boolean().optional()
  })
  .strict();
export type RegisterCameraInput = z.infer<typeof RegisterCameraInputSchema>;

export const UpdateCameraInputSchema = z
  .object({
    label: z.string().min(1).max(80).optional(),
    zone_kind: ZoneSchema.optional(),
    route_policy: PolicySchema.optional(),
    cooldown_seconds: z.number().int().min(5).max(3600).optional(),
    enabled: z.boolean().optional(),
    trigger_entities: z.array(z.string().min(1).max(200)).max(8).optional()
  })
  .strict();
export type UpdateCameraInput = z.infer<typeof UpdateCameraInputSchema>;

function fail(field: string, detail: string): never {
  throw new VisionCameraValidationError(field, detail);
}

function validateLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > 80 || CONTROL.test(trimmed)) fail("label", "invalid");
  return trimmed;
}

function validateTriggers(source_type: string, entities: readonly string[] | undefined): string[] {
  const list = [...new Set(entities ?? [])];
  if (source_type === "iphone") {
    if (list.length > 0) fail("trigger_entities", "iphone_has_no_triggers");
    return [];
  }
  for (const entity of list) if (!HA_TRIGGER_ENTITY.test(entity)) fail("trigger_entities", "invalid_entity_id");
  return list;
}

/** Sone-/policyregelen (samme som DB-CHECK `vision_cameras_zone_storage_rule`): kun hjemmesonen kan lagre bilder. */
function assertZonePolicy(zone: VisionZoneKind, policy: VisionRoutePolicy): void {
  if (policy === "store_snapshot" && zone !== "home") fail("route_policy", "zone_forbids_storage");
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(issue?.path.join(".") || "input", issue?.code ?? "schema_validation_failed");
  }
  return parsed.data;
}

export class VisionCameraService {
  constructor(private readonly pool: pg.Pool) {}

  async registerCamera(tenantId: string, memorySpace: MemorySpace, input: RegisterCameraInput, provenance: { task_id?: string; session_id?: string } = {}): Promise<VisionCamera> {
    const value = parse(RegisterCameraInputSchema, input);
    const label = validateLabel(value.label);
    if (value.source_type === "home_assistant" && !HA_CAMERA_ENTITY.test(value.source_ref)) fail("source_ref", "invalid_ha_camera_entity");
    if (value.source_type === "iphone" && !DEVICE_ID.test(value.source_ref)) fail("source_ref", "invalid_device_id");
    const triggers = validateTriggers(value.source_type, value.trigger_entities);
    assertZonePolicy(value.zone_kind, value.route_policy);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `INSERT INTO vision_cameras (camera_id, tenant_id, memory_space_id, person_id, label, source_type, source_ref, trigger_entities, room_id, zone_kind, route_policy, cooldown_seconds, enabled, task_id, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
        [
          `vis-cam-${randomUUID()}`, tenantId, memorySpace, value.person_id, label, value.source_type, value.source_ref, triggers, value.room_id ?? null,
          value.zone_kind, value.route_policy, value.cooldown_seconds ?? 30, value.enabled ?? true, provenance.task_id ?? null, provenance.session_id ?? null
        ]
      );
      return rows[0] as VisionCamera;
    });
  }

  async getCamera(tenantId: string, memorySpace: MemorySpace, personId: string, cameraId: string): Promise<VisionCamera | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM vision_cameras WHERE tenant_id = $1 AND person_id = $2 AND camera_id = $3`, [tenantId, personId, cameraId]);
      return (rows[0] as VisionCamera | undefined) ?? null;
    });
  }

  /** Kameraene til ÉN navngitt person (eksplisitt scope i signaturen - aldri et blankt «gi meg alt»-oppslag). */
  async listCameras(tenantId: string, memorySpace: MemorySpace, personId: string, filter: { enabledOnly?: boolean; sourceType?: "home_assistant" | "iphone" } = {}): Promise<VisionCamera[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const conditions = ["tenant_id = $1", "person_id = $2"];
      const params: unknown[] = [tenantId, personId];
      if (filter.enabledOnly) conditions.push("enabled = true");
      if (filter.sourceType) {
        params.push(filter.sourceType);
        conditions.push(`source_type = $${params.length}`);
      }
      const { rows } = await client.query(`SELECT * FROM vision_cameras WHERE ${conditions.join(" AND ")} ORDER BY label ASC, camera_id ASC`, params);
      return rows as VisionCamera[];
    });
  }

  /** Endrer label/sone/policy/cooldown/på-av/triggere. Sone-/policyregelen sjekkes mot den RESULTERENDE kombinasjonen (ikke bare det som endres). */
  async updateCamera(tenantId: string, memorySpace: MemorySpace, personId: string, cameraId: string, input: UpdateCameraInput): Promise<VisionCamera | null> {
    const value = parse(UpdateCameraInputSchema, input);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await client.query(`SELECT * FROM vision_cameras WHERE tenant_id = $1 AND person_id = $2 AND camera_id = $3 FOR UPDATE`, [tenantId, personId, cameraId]);
      const row = current.rows[0] as VisionCamera | undefined;
      if (!row) return null;
      const zone = value.zone_kind ?? row.zone_kind;
      const policy = value.route_policy ?? row.route_policy;
      assertZonePolicy(zone, policy);
      const label = value.label !== undefined ? validateLabel(value.label) : row.label;
      const triggers = value.trigger_entities !== undefined ? validateTriggers(row.source_type, value.trigger_entities) : row.trigger_entities;
      const { rows } = await client.query(
        `UPDATE vision_cameras SET label = $4, zone_kind = $5, route_policy = $6, cooldown_seconds = $7, enabled = $8, trigger_entities = $9, updated_at = now()
          WHERE tenant_id = $1 AND person_id = $2 AND camera_id = $3 RETURNING *`,
        [tenantId, personId, cameraId, label, zone, policy, value.cooldown_seconds ?? row.cooldown_seconds, value.enabled ?? row.enabled, triggers]
      );
      return rows[0] as VisionCamera;
    });
  }

  /**
   * Fjerner kameraet OG alle bildene det har tatt (FK `ON DELETE CASCADE` + gravsteiner sørger for at bildeobjektene også slettes). Hendelsene beholdes (de følger sin egen
   * retensjon). DESTRUKTIV (regel 8): krever `confirm: true` - eier-ruten krever i tillegg en typet bekreftelse og signert enhetsøkt.
   */
  async removeCamera(tenantId: string, memorySpace: MemorySpace, personId: string, cameraId: string, options: { confirm: boolean }): Promise<boolean> {
    if (options.confirm !== true) fail("confirm", "explicit_confirmation_required");
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rowCount } = await client.query(`DELETE FROM vision_cameras WHERE tenant_id = $1 AND person_id = $2 AND camera_id = $3`, [tenantId, personId, cameraId]);
      return (rowCount ?? 0) > 0;
    });
  }
}

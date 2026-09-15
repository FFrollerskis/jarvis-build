import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import {
  CreateVisionRoomInputSchema,
  VisionObservationInputSchema,
  type CreateVisionRoomInput,
  type SetVisionRetentionPolicyInput,
  type VisionEventObservation,
  type VisionEventSource,
  type VisionObservationInput,
  type VisionRetentionPolicy,
  type VisionRoom
} from "./types.ts";

/**
 * UA-9 Vision & Physical World: JARVIS_CANONICAL hendelses-ingestion-/lese-
 * tjeneste (D-64/D-153 Core-vs-Adapter-porten kjørt FØRST - se
 * DECISIONS_AND_ASSUMPTIONS.md).
 *
 * Dette er et KONTRAKT-/INGESTION-lag, IKKE en live iPhone-kamera-/Home
 * Assistant-kamera-integrasjon - dette miljøet har verken fysisk
 * kameramaskinvare eller en objektklassifiseringsmodell koblet til, og INGEN
 * kode her later som den snakker med en ekte kamera-kjøretid.
 * `VisionEventSource` (types.ts) er den STABILE, provider-nøytrale
 * kontrakten en fremtidig ekte adapter implementerer - denne tjenesten sine
 * interne metoder endres IKKE når en slik adapter en dag bygges.
 *
 * MULTI-SPACE (location-stil, D-153): i motsetning til `@jarvis/health`
 * (strukturelt låst til det ENE `'health'`-spacet) tar HVER metode her et
 * eksplisitt `memorySpace`-argument - ingen 'vision'-verdi er reservert i
 * den kanoniske `memory_spaces`-enumereringen, og kamera-/hendelsesdata
 * hører naturlig til FLERE spaces (personlig hjem, bedriftskontor,
 * gjesteområder). `withMemoryTransaction(..., [memorySpace], ...)` +
 * `055_vision.sql` sin RESTRICTIVE RLS-space-policy håndhever isolasjonen
 * strukturelt for HVERT kall - samme "forsvar-i-dybden, ikke duplisering"-
 * prinsipp som resten av repoet.
 *
 * APPEND-ONLY: `vision_event_observations` har INGEN UPDATE-grant (samme
 * "strukturelt, ikke konvensjonelt"-prinsipp som `health_metric_
 * observations`). En feilklassifisert hendelse korrigeres av en NY
 * observasjon fra kilden, ALDRI ved å mutere en historisk rad.
 */
export class VisionObservationValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly detail: string
  ) {
    super(`vision_observation_invalid:${field}:${detail}`);
    this.name = "VisionObservationValidationError";
  }
}

/**
 * Personvern-beskyttende, ENDELIG standardvindu i FRAVÆR av en eier-
 * konfigurert `vision_retention_policies`-rad (MOTSATT retning av D-92 sin
 * "disabled" fail-open-standard, samme "fravær av konfigurasjon betyr ALDRI
 * 'behold for alltid'"-prinsipp som `@jarvis/location`). KORTERE enn
 * location sitt 90-dagers-vindu: kamera-/hendelsesdata avslører BÅDE
 * tilstedeværelse OG aktivitet (minst like sensitivt som posisjon alene).
 */
export const DEFAULT_RETENTION_DAYS = 30;

export class VisionService {
  constructor(private readonly pool: pg.Pool) {}

  // ---------------------------------------------------------------------
  // Retention policy (eier-konfigurert, se filhode)
  // ---------------------------------------------------------------------

  async getRetentionPolicy(tenantId: string, memorySpace: MemorySpace): Promise<VisionRetentionPolicy | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM vision_retention_policies WHERE tenant_id = $1 AND memory_space_id = $2`,
        [tenantId, memorySpace]
      );
      return (rows[0] as VisionRetentionPolicy | undefined) ?? null;
    });
  }

  /** Eksplisitt eier-handling - endrer KUN retensjonsvinduet, oppretter/leser ALDRI observasjoner selv. */
  async setRetentionPolicy(
    tenantId: string,
    memorySpace: MemorySpace,
    input: SetVisionRetentionPolicyInput
  ): Promise<VisionRetentionPolicy> {
    if (!Number.isInteger(input.retention_days) || input.retention_days <= 0) {
      throw new VisionObservationValidationError("retention_days", "must_be_positive_integer");
    }
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `INSERT INTO vision_retention_policies (tenant_id, memory_space_id, retention_days, actor_person_id, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, memory_space_id)
         DO UPDATE SET retention_days = EXCLUDED.retention_days, actor_person_id = EXCLUDED.actor_person_id, updated_at = now()
         RETURNING *`,
        [tenantId, memorySpace, input.retention_days, input.actor_person_id ?? null]
      );
      return rows[0] as VisionRetentionPolicy;
    });
  }

  private async retentionDaysInTransaction(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace): Promise<number> {
    const { rows } = await client.query(
      `SELECT retention_days FROM vision_retention_policies WHERE tenant_id = $1 AND memory_space_id = $2`,
      [tenantId, memorySpace]
    );
    return (rows[0] as { retention_days: number } | undefined)?.retention_days ?? DEFAULT_RETENTION_DAYS;
  }

  // ---------------------------------------------------------------------
  // Rooms (romassosiasjon)
  // ---------------------------------------------------------------------

  async createRoom(tenantId: string, memorySpace: MemorySpace, input: CreateVisionRoomInput): Promise<VisionRoom> {
    const parsed = CreateVisionRoomInputSchema.safeParse(input);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new VisionObservationValidationError(firstIssue?.path.join(".") || "input", firstIssue?.message ?? "schema_validation_failed");
    }
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const room_id = `vis-rm-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO vision_rooms (room_id, tenant_id, memory_space_id, person_id, name)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [room_id, tenantId, memorySpace, parsed.data.person_id, parsed.data.name]
      );
      return rows[0] as VisionRoom;
    });
  }

  /** Rommene til ÉN navngitt person - IKKE et blankt "gi meg alt"-oppslag (eksplisitt scope i signaturen, samme mønster som `LocationService.listZones()`). */
  async listRooms(tenantId: string, memorySpace: MemorySpace, personId: string): Promise<VisionRoom[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM vision_rooms WHERE tenant_id = $1 AND person_id = $2 ORDER BY name ASC`,
        [tenantId, personId]
      );
      return rows as VisionRoom[];
    });
  }

  // ---------------------------------------------------------------------
  // Event observations
  // ---------------------------------------------------------------------

  /**
   * Validerer OG skriver ÉN ny hendelse. Fail-closed: kaster en typet
   * `VisionObservationValidationError` (ALDRI en stille avvist/klippet
   * verdi) for en ugyldig `event_type`/`confidence`-verdi utenfor [0,1]
   * eller et `observed_at` som ikke er et gyldig parsbart tidsstempel. Et
   * strukturelt ugyldig `room_id` (rom finnes ikke / tilhører en annen
   * person) avvises av `055_vision.sql` sin sammensatte FK som en ekte
   * Postgres-feil (`23503`) - INGEN duplisert eksistens-sjekk her (samme
   * "databasen er den strukturelle autoriteten"-disiplin som resten av
   * repoet).
   *
   * `retention_expires_at` beregnes ATOMISK i SAMME INSERT (ikke i JS,
   * unngår enhver klokke-/tidssone-avvik) fra `vision_retention_policies`
   * sin `retention_days` for tenanten+spacet - faller tilbake til
   * `DEFAULT_RETENTION_DAYS` (samme "fravær av policy betyr ALDRI 'behold
   * for alltid'"-prinsipp som `@jarvis/location`, MOTSATT retning av
   * `@jarvis/health` sin NULL-til-policy-konfigureres-mønster).
   */
  async ingestObservation(
    tenantId: string,
    memorySpace: MemorySpace,
    personId: string,
    input: VisionObservationInput
  ): Promise<VisionEventObservation> {
    const parsed = VisionObservationInputSchema.safeParse(input);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new VisionObservationValidationError(firstIssue?.path.join(".") || "input", firstIssue?.message ?? "schema_validation_failed");
    }
    const value = parsed.data;
    if (Number.isNaN(Date.parse(value.observed_at))) {
      throw new VisionObservationValidationError("observed_at", "not_a_valid_iso_datetime");
    }

    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const retentionDays = await this.retentionDaysInTransaction(client, tenantId, memorySpace);
      const observedAtMs = new Date(value.observed_at).getTime();
      const retentionExpiresAt = new Date(observedAtMs + retentionDays * 24 * 60 * 60 * 1000).toISOString();

      const { rows } = await client.query(
        `INSERT INTO vision_event_observations
           (observation_id, tenant_id, memory_space_id, person_id, room_id, event_type, object_label, confidence, snapshot_ref, source_type, source_instance_id, observed_at, retention_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          `vis-ob-${randomUUID()}`,
          tenantId,
          memorySpace,
          personId,
          value.room_id ?? null,
          value.event_type,
          value.object_label ?? null,
          value.confidence ?? null,
          value.snapshot_ref ?? null,
          value.source_type,
          value.source_instance_id ?? null,
          value.observed_at,
          retentionExpiresAt
        ]
      );
      return rows[0] as VisionEventObservation;
    });
  }

  /**
   * Provider-nøytral komposisjons-metode (samme mønster som
   * `HealthService.ingestFromSource()`): henter hendelser fra EN GITT
   * `VisionEventSource`-adapter (ekte fremtidig adapter ELLER
   * `FakeVisionEventSource` i tester) og validerer + skriver hver av dem
   * via `ingestObservation()` - ALDRI en egen, parallell skrivevei. En
   * hendelse som feiler validering kaster UMIDDELBART (fail-fast) - delvis
   * batch-innsetting for ÉN kildehenting anses som mer overraskende enn
   * nyttig i v1.
   */
  async ingestFromSource(
    tenantId: string,
    memorySpace: MemorySpace,
    personId: string,
    source: VisionEventSource,
    options: { sinceMs?: number } = {}
  ): Promise<VisionEventObservation[]> {
    const inputs = await source.fetchRecent({ personId, ...(options.sinceMs !== undefined ? { sinceMs: options.sinceMs } : {}) });
    const written: VisionEventObservation[] = [];
    for (const input of inputs) {
      written.push(await this.ingestObservation(tenantId, memorySpace, personId, input));
    }
    return written;
  }

  /** Lese-API, vision-space-scoped (RLS + eksplisitt `memorySpace`-argument, samme "aldri et blankt gi-meg-alt-kall"-disiplin som `@jarvis/location`). */
  async getRecentEvents(
    tenantId: string,
    memorySpace: MemorySpace,
    personId: string,
    filter: { eventType?: string; roomId?: string; sinceMs?: number } = {}
  ): Promise<VisionEventObservation[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const conditions = ["tenant_id = $1", "person_id = $2"];
      const params: Array<string | number> = [tenantId, personId];
      if (filter.eventType) {
        params.push(filter.eventType);
        conditions.push(`event_type = $${params.length}`);
      }
      if (filter.roomId) {
        params.push(filter.roomId);
        conditions.push(`room_id = $${params.length}`);
      }
      if (filter.sinceMs !== undefined) {
        params.push(new Date(filter.sinceMs).toISOString());
        conditions.push(`observed_at >= $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT * FROM vision_event_observations WHERE ${conditions.join(" AND ")} ORDER BY observed_at DESC`,
        params
      );
      return rows as VisionEventObservation[];
    });
  }

  /**
   * UA-9 akseptansekriterium 1 ("object identification and 'last seen'
   * workflows work when event data exists"): siste kjente hendelse for et
   * gitt `objectLabel`, eller `null` hvis ingen finnes/er innenfor RLS-scope
   * - IKKE selve objektklassifiseringen (den skjer oppstrøms i en fremtidig
   * adapter, se `types.ts`), kun ende-til-ende-kanonisk spørring mot
   * allerede lagrede, klassifiserte hendelser.
   */
  async getLastSeen(tenantId: string, memorySpace: MemorySpace, personId: string, objectLabel: string): Promise<VisionEventObservation | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM vision_event_observations
         WHERE tenant_id = $1 AND person_id = $2 AND object_label = $3
         ORDER BY observed_at DESC LIMIT 1`,
        [tenantId, personId, objectLabel]
      );
      return (rows[0] as VisionEventObservation | undefined) ?? null;
    });
  }

  /**
   * Reell retention-håndhevelse (samme mønster som `HealthService.
   * purgeExpiredObservations()`/`LocationService.purgeExpiredObservations()`):
   * sletter KUN rader hvor `retention_expires_at` er satt OG faktisk er
   * passert. Ingen annen tabell FK-refererer `vision_event_observations`
   * (i motsetning til `location_zone_visits` -> `location_observations`) -
   * ingen forelder/barn-slette-rekkefølge nødvendig her.
   */
  async purgeExpiredObservations(tenantId: string, memorySpace: MemorySpace): Promise<number> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM vision_event_observations WHERE tenant_id = $1 AND memory_space_id = $2 AND retention_expires_at IS NOT NULL AND retention_expires_at <= now()`,
        [tenantId, memorySpace]
      );
      return rowCount ?? 0;
    });
  }
}

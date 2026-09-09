import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import { writeAudit } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import {
  CONTEXT_VALUE_SCHEMAS,
  type ContextDimension,
  type ContextDimensionSnapshot,
  type ContextObservationRow,
  type DeviceContextValue,
  type MeetingContextValue,
  type PersonContextSnapshot,
  type RecordObservationInput,
  type RecordObservationResult
} from "./types.ts";

/** Kastes naar `value` ikke matcher den zod-valideringen dimensjonen krever - se `types.ts`. */
export class InvalidContextObservationValueError extends Error {
  constructor(
    public readonly dimension: ContextDimension,
    public readonly validationError: unknown
  ) {
    super(`invalid_context_observation_value:${dimension}: ${(validationError as Error)?.message ?? String(validationError)}`);
    this.name = "InvalidContextObservationValueError";
  }
}

/**
 * Ferskhets-vinduer per dimensjon (millisekunder) - `getCurrentContext()`
 * flagger en observasjon `stale: true` naar `now - observed_at` overstiger
 * dette. Ulike dimensjoner blir foreldet i ulikt tempo av natur (§ i
 * byggeordren): et møte har en kort, naturlig levetid og maa re-avledes
 * ofte; et sted endrer seg sjeldnere. Konfigurerbart per instans (se
 * konstruktøren) - disse er BEVISST dokumenterte, fornuftige defaults, ikke
 * en paastand om en "riktig" universell verdi.
 */
export const DEFAULT_MAX_AGE_MS: Record<ContextDimension, number> = {
  place: 60 * 60_000, // 1 time - sted endres sjelden brått
  device: 15 * 60_000, // 15 min - "aktiv enhet" regnes gyldig en kort stund etter siste signal
  meeting: 5 * 60_000, // 5 min - møtestatus maa re-avledes ofte (kort levetid per natur, se types.ts)
  activity: 30 * 60_000
};

const ALL_DIMENSIONS: readonly ContextDimension[] = ["place", "device", "meeting", "activity"];

function mapRow(row: Record<string, unknown>): ContextObservationRow {
  return {
    observation_id: row["observation_id"] as string,
    tenant_id: row["tenant_id"] as string,
    person_id: row["person_id"] as string,
    memory_space_id: row["memory_space_id"] as string,
    dimension: row["dimension"] as ContextDimension,
    value: row["value"] as Record<string, unknown>,
    basis: row["basis"] as ContextObservationRow["basis"],
    source_type: row["source_type"] as string,
    source_instance_id: (row["source_instance_id"] as string | null) ?? null,
    confidence: (row["confidence"] as number | null) ?? null,
    observed_at: new Date(row["observed_at"] as string).toISOString(),
    created_at: new Date(row["created_at"] as string).toISOString(),
    updated_at: new Date(row["updated_at"] as string).toISOString()
  };
}

/**
 * UA-8 Personal Digital Twin - Personal Context Engine v1. Se
 * `049_context_engine.sql` for det fulle databasedesignet og
 * DECISIONS_AND_ASSUMPTIONS.md-loggen for D-41/D-64-forankringen.
 *
 * `recordObservation()` haandhever presedens-regelen i samme transaksjon som
 * skrivingen (SELECT ... FOR UPDATE mot SAMME rad `ON CONFLICT` senere
 * treffer - ingen race mellom sjekk og skriving): en 'deterministic'
 * observasjon skrives ALLTID; en 'inferred' observasjon skrives KUN naar det
 * IKKE allerede finnes en 'deterministic' observasjon for samme
 * (tenant, person, space, dimensjon) - "deterministisk foretrekkes naar
 * tilstede" haandheves derfor bokstavelig, ikke bare "naar nyere". Dette er
 * et BEVISST, dokumentert valg (se test B i service-rls.test.ts) - en
 * FREMTIDIG utvidelse kunne la en svaert gammel deterministic-rad "utløpe"
 * til fordel for en fersk inferred-rad, men det er IKKE bygget her (se
 * byggeordrens rapportpunkt 6, TODO).
 */
export class ContextEngine {
  private readonly maxAgeMs: Record<ContextDimension, number>;

  constructor(
    private readonly pool: pg.Pool,
    maxAgeOverrides: Partial<Record<ContextDimension, number>> = {}
  ) {
    this.maxAgeMs = { ...DEFAULT_MAX_AGE_MS, ...maxAgeOverrides };
  }

  async recordObservation(input: RecordObservationInput): Promise<RecordObservationResult> {
    const schema = CONTEXT_VALUE_SCHEMAS[input.dimension];
    const parsed = schema.safeParse(input.value);
    if (!parsed.success) {
      throw new InvalidContextObservationValueError(input.dimension, parsed.error);
    }
    return withMemoryTransaction(this.pool, input.tenant_id, [input.memory_space], (client) =>
      this.writeObservation(client, { ...input, value: parsed.data as Record<string, unknown> })
    );
  }

  /**
   * Live-leser den EKSISTERENDE `sessions`-tabellen (`SessionService`,
   * `@jarvis/core`) - ALDRI en duplisert enhets-tilstandsmotor. Kalles av en
   * fremtidig integrasjon naar noe FAKTISK dytter et signal (f.eks. en
   * sesjons-gjenopptakelse) - denne pakken finner ALDRI selv paa client-side
   * polling. Returnerer `null` naar personen ikke har noen aktiv sesjon i
   * tenanten (intet aa observere - IKKE en feil).
   */
  async recordDeviceObservationFromSession(
    tenantId: string,
    personId: string,
    memorySpace: MemorySpace
  ): Promise<RecordObservationResult | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT session_id, last_channel, last_device_id, last_active_at FROM sessions
         WHERE tenant_id = $1 AND person_id = $2 AND status = 'active'
         ORDER BY last_active_at DESC LIMIT 1`,
        [tenantId, personId]
      );
      const row = rows[0] as
        | { session_id: string; last_channel: string; last_device_id: string; last_active_at: string }
        | undefined;
      if (!row) return null;
      const value: DeviceContextValue = { device_id: row.last_device_id, channel: row.last_channel, session_id: row.session_id };
      return this.writeObservation(client, {
        tenant_id: tenantId,
        person_id: personId,
        memory_space: memorySpace,
        dimension: "device",
        value,
        basis: "deterministic",
        source_type: "session",
        source_instance_id: row.session_id,
        observed_at: new Date(row.last_active_at).toISOString()
      });
    });
  }

  /**
   * Live-avleder møte-/kalenderkontekst fra `business_activities`
   * (`activity_type = 'meeting'`, skrevet av EKSISTERENDE
   * `BusinessEventSyncService.syncCalendarActivities()` -
   * `modules/business/src/business-event-sync.ts`) - INGEN egen
   * kalender-ingestion bygges her. Se `types.ts` sin `MeetingContextValue`-
   * kommentar for det ærlige gapet (ingen sluttidspunkt lagres noe sted i
   * dagens skjema).
   *
   * `windowStart`/`windowEnd` er BEVISST navngitt separat fra
   * `DEFAULT_MAX_AGE_MS.meeting`: sistnevnte styrer NAAR den LAGREDE
   * observasjonen regnes foreldet av `getCurrentContext()`; disse styrer
   * HVILKET vindu rundt `now` som søkes for en møte-rad i utgangspunktet.
   */
  async recordMeetingObservationFromCalendar(
    tenantId: string,
    personId: string,
    memorySpace: MemorySpace,
    opts: { now?: Date; lookaheadMinutes?: number; assumedDurationMinutes?: number } = {}
  ): Promise<RecordObservationResult> {
    const now = opts.now ?? new Date();
    const lookaheadMinutes = opts.lookaheadMinutes ?? 15;
    const assumedDurationMinutes = opts.assumedDurationMinutes ?? 60;
    const windowStart = new Date(now.getTime() - assumedDurationMinutes * 60_000);
    const windowEnd = new Date(now.getTime() + lookaheadMinutes * 60_000);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT activity_id, occurred_at FROM business_activities
         WHERE tenant_id = $1 AND memory_space_id = $2 AND owner_person_id = $3 AND activity_type = 'meeting'
           AND occurred_at BETWEEN $4 AND $5
         ORDER BY occurred_at ASC LIMIT 1`,
        [tenantId, memorySpace, personId, windowStart.toISOString(), windowEnd.toISOString()]
      );
      const row = rows[0] as { activity_id: string; occurred_at: string } | undefined;
      let value: MeetingContextValue;
      let sourceInstanceId: string | undefined;
      if (!row) {
        value = { status: "none", end_time_known: false };
      } else {
        const startsAt = new Date(row.occurred_at);
        value = {
          status: startsAt.getTime() > now.getTime() ? "starting_soon" : "recently_started_duration_unknown",
          activity_id: row.activity_id,
          starts_at: startsAt.toISOString(),
          end_time_known: false
        };
        sourceInstanceId = row.activity_id;
      }
      return this.writeObservation(client, {
        tenant_id: tenantId,
        person_id: personId,
        memory_space: memorySpace,
        dimension: "meeting",
        value,
        basis: "deterministic",
        source_type: "business_activity",
        ...(sourceInstanceId !== undefined ? { source_instance_id: sourceInstanceId } : {}),
        observed_at: now.toISOString()
      });
    });
  }

  /**
   * Returnerer den ferskeste kjente verdien per dimensjon for
   * (tenant, person, space) - ALLTID med eksplisitt `basis`/`stale`, ALDRI
   * en stille gjetning fremstilt som fakta. En dimensjon uten noen
   * observasjon i det hele tatt gir `null` (ikke en fabrikkert default-verdi).
   */
  async getCurrentContext(tenantId: string, personId: string, memorySpace: MemorySpace): Promise<PersonContextSnapshot> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM context_observations WHERE tenant_id = $1 AND person_id = $2 AND memory_space_id = $3`,
        [tenantId, personId, memorySpace]
      );
      const byDimension = new Map<ContextDimension, ContextObservationRow>();
      for (const raw of rows as Array<Record<string, unknown>>) {
        const mapped = mapRow(raw);
        byDimension.set(mapped.dimension, mapped);
      }
      const now = Date.now();
      const dimensions = {} as Record<ContextDimension, ContextDimensionSnapshot | null>;
      for (const dimension of ALL_DIMENSIONS) {
        const row = byDimension.get(dimension);
        if (!row) {
          dimensions[dimension] = null;
          continue;
        }
        const ageMs = now - new Date(row.observed_at).getTime();
        dimensions[dimension] = {
          value: row.value,
          basis: row.basis,
          source_type: row.source_type,
          source_instance_id: row.source_instance_id,
          confidence: row.confidence,
          observed_at: row.observed_at,
          stale: ageMs > this.maxAgeMs[dimension]
        };
      }
      return {
        tenant_id: tenantId,
        person_id: personId,
        memory_space_id: memorySpace,
        generated_at: new Date(now).toISOString(),
        dimensions
      };
    });
  }

  /**
   * Interne skrive-/presedens-kjerne - deles av det offentlige
   * `recordObservation()` (aapner sin egen transaksjon) OG de live-avledende
   * metodene over (som allerede har en aapen `withMemoryTransaction`-klient).
   * `value` MAA allerede være validert av kalleren (offentlig
   * `recordObservation()` validerer via `CONTEXT_VALUE_SCHEMAS`; de interne
   * avledningsmetodene bygger `value` selv fra typed literals, derfor trygt
   * uten reparsing).
   */
  private async writeObservation(
    client: pg.PoolClient,
    input: RecordObservationInput
  ): Promise<RecordObservationResult> {
    const existing = await client.query(
      `SELECT observation_id, basis, observed_at FROM context_observations
       WHERE tenant_id = $1 AND person_id = $2 AND memory_space_id = $3 AND dimension = $4
       FOR UPDATE`,
      [input.tenant_id, input.person_id, input.memory_space, input.dimension]
    );
    const existingRow = existing.rows[0] as { observation_id: string; basis: string } | undefined;

    // D-41-prinsippet (se klasse-JSDoc): en 'inferred' observasjon overskriver
    // ALDRI en allerede tilstedeværende 'deterministic' observasjon for samme
    // dimensjon - uansett tidsstempel.
    if (existingRow && existingRow.basis === "deterministic" && input.basis === "inferred") {
      const current = await client.query(`SELECT * FROM context_observations WHERE observation_id = $1`, [
        existingRow.observation_id
      ]);
      await writeAudit(
        client,
        {
          tenant_id: input.tenant_id,
          person_id: input.person_id,
          session_id: input.session_id ?? "context-engine",
          device_id: input.device_id ?? "context-engine"
        },
        {
          type: "context.observation_ignored",
          reason: "deterministic_precedence",
          payload: { dimension: input.dimension, source_type: input.source_type }
        }
      );
      return { applied: false, reason: "deterministic_precedence", observation: mapRow(current.rows[0] as Record<string, unknown>) };
    }

    const observedAt = input.observed_at ?? new Date().toISOString();
    const { rows } = await client.query(
      `INSERT INTO context_observations
         (observation_id, tenant_id, person_id, memory_space_id, dimension, value, basis, source_type, source_instance_id, confidence, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, person_id, memory_space_id, dimension) DO UPDATE SET
         value = EXCLUDED.value,
         basis = EXCLUDED.basis,
         source_type = EXCLUDED.source_type,
         source_instance_id = EXCLUDED.source_instance_id,
         confidence = EXCLUDED.confidence,
         observed_at = EXCLUDED.observed_at,
         updated_at = now()
       RETURNING *`,
      [
        `ctx-${randomUUID()}`,
        input.tenant_id,
        input.person_id,
        input.memory_space,
        input.dimension,
        JSON.stringify(input.value),
        input.basis,
        input.source_type,
        input.source_instance_id ?? null,
        input.confidence ?? null,
        observedAt
      ]
    );
    await writeAudit(
      client,
      {
        tenant_id: input.tenant_id,
        person_id: input.person_id,
        session_id: input.session_id ?? "context-engine",
        device_id: input.device_id ?? "context-engine"
      },
      {
        type: "context.observation_recorded",
        payload: { dimension: input.dimension, basis: input.basis, source_type: input.source_type }
      }
    );
    return { applied: true, observation: mapRow(rows[0] as Record<string, unknown>) };
  }
}

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import type {
  CreateLocationZoneInput,
  IngestObservationInput,
  LocationObservation,
  LocationRetentionPolicy,
  LocationZone,
  LocationZoneVisit,
  SetLocationRetentionPolicyInput
} from "./types.ts";

/**
 * UA-8 Personal Digital Twin - Native Jarvis Location/Geofencing Core
 * (D-64 Core-vs-Adapter-porten kjørt FØRST): Jarvis EIER selv den kanoniske
 * lokasjons-/geofence-domenemodellen (JARVIS_CANONICAL, se 050_location.sql
 * sitt filhode). ZERO ekstern leverandør-avhengighet i denne sliceen - et
 * fremtidig eksternt system (Apple Find My/Google/etc.) er UTELUKKENDE en
 * ADAPTER som SKRIVER INN via `ingestObservation()` (`source_type`/
 * `source_instance_id`-pekere, ALDRI en rå leverandør-payload), ALDRI spurt
 * live, ALDRI domeneeier.
 *
 * MVP-geometri, BEVISST uten PostGIS: hver sone er en SIRKEL (senter +
 * radius) og punkt-i-sone avgjøres med Haversine-avstand mot sirkelens
 * senter (`haversineMeters()` under) - ingen ekstern geo-bibliotek-
 * avhengighet nødvendig for en sirkulær grense. DOKUMENTERT, BEVISST
 * DEFERRED (§6 i byggeordren): et POLYGON-boundary-format (uregelmessig
 * geofence-form) er en FREMTIDIG, EGEN utvidelse (ville krevd enten
 * PostGIS eller en punkt-i-polygon-algoritme + et nytt boundary-skjema) -
 * IKKE bygget her, fordi masterplanens MVP-behov (sirkulær hjemme-/
 * arbeidssone) er fullt dekket av senter+radius, og en tidlig, ubrukt
 * polygon-avhengighet ville vært unødvendig kompleksitet (samme
 * "byggeporten gjelder KUN det aktiv fase definerer"-disiplin som
 * CLAUDE.md regel 10).
 *
 * Retensjon (D-91/D-92-disiplin, se 050_location.sql sitt filhode for full
 * begrunnelse): `ingestObservation()` beregner `retention_expires_at` FRA
 * en EIER-KONFIGURERT `location_retention_policies`-rad (`setRetentionPolicy()`)
 * - Jarvis GJETTER ALDRI et retensjonsvindu. I FRAVÆR av en eksplisitt
 * eier-policy brukes `DEFAULT_RETENTION_DAYS` (90 dager) - et PERSONVERN-
 * BESKYTTENDE, ENDELIG standardvindu (MOTSATT retning av D-92 sin
 * "disabled"-fail-open-standard: for POSISJONSDATA må fravær av
 * konfigurasjon ALDRI bety "behold for alltid"). `purgeExpiredObservations()`
 * er den FAKTISKE håndhevingen - se filens bunn-kommentar for
 * scheduler-kravet (rapportert i byggeordrens svar, IKKE wiret her).
 */
export const DEFAULT_RETENTION_DAYS = 90;

const EARTH_RADIUS_METERS = 6_371_000;

/** Haversine storsirkel-avstand i meter mellom to (lat, lon)-punkter - ingen ekstern geo-bibliotek-avhengighet. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

export interface ZoneTransitionResult {
  entered: LocationZoneVisit[];
  left: LocationZoneVisit[];
}

export class LocationService {
  constructor(private readonly pool: pg.Pool) {}

  // ---------------------------------------------------------------------
  // Retention policy (eier-konfigurert, se filhode)
  // ---------------------------------------------------------------------

  async getRetentionPolicy(tenantId: string, memorySpace: MemorySpace): Promise<LocationRetentionPolicy | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM location_retention_policies WHERE tenant_id = $1 AND memory_space_id = $2`,
        [tenantId, memorySpace]
      );
      return (rows[0] as LocationRetentionPolicy | undefined) ?? null;
    });
  }

  /** Eksplisitt eier-handling - endrer KUN retensjonsvinduet, oppretter/leser ALDRI observasjoner selv. */
  async setRetentionPolicy(
    tenantId: string,
    memorySpace: MemorySpace,
    input: SetLocationRetentionPolicyInput
  ): Promise<LocationRetentionPolicy> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `INSERT INTO location_retention_policies (tenant_id, memory_space_id, retention_days, actor_person_id, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, memory_space_id)
         DO UPDATE SET retention_days = EXCLUDED.retention_days, actor_person_id = EXCLUDED.actor_person_id, updated_at = now()
         RETURNING *`,
        [tenantId, memorySpace, input.retention_days, input.actor_person_id ?? null]
      );
      return rows[0] as LocationRetentionPolicy;
    });
  }

  private async retentionDaysInTransaction(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace): Promise<number> {
    const { rows } = await client.query(
      `SELECT retention_days FROM location_retention_policies WHERE tenant_id = $1 AND memory_space_id = $2`,
      [tenantId, memorySpace]
    );
    return (rows[0] as { retention_days: number } | undefined)?.retention_days ?? DEFAULT_RETENTION_DAYS;
  }

  // ---------------------------------------------------------------------
  // Zones (geofences)
  // ---------------------------------------------------------------------

  async createZone(tenantId: string, memorySpace: MemorySpace, input: CreateLocationZoneInput): Promise<LocationZone> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const zone_id = `loc-zn-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO location_zones (zone_id, tenant_id, memory_space_id, person_id, name, center_lat, center_lon, radius_meters)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [zone_id, tenantId, memorySpace, input.person_id, input.name, input.center_lat, input.center_lon, input.radius_meters]
      );
      return rows[0] as LocationZone;
    });
  }

  async getZone(tenantId: string, memorySpace: MemorySpace, zoneId: string): Promise<LocationZone | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM location_zones WHERE tenant_id = $1 AND zone_id = $2`, [tenantId, zoneId]);
      return (rows[0] as LocationZone) ?? null;
    });
  }

  /** Sonene til ÉN navngitt person - IKKE et blankt "gi meg alt"-oppslag (eksplisitt scope i signaturen, se filhode/byggeordre). */
  async listZones(tenantId: string, memorySpace: MemorySpace, personId: string): Promise<LocationZone[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM location_zones WHERE tenant_id = $1 AND person_id = $2 ORDER BY name ASC`,
        [tenantId, personId]
      );
      return rows as LocationZone[];
    });
  }

  // ---------------------------------------------------------------------
  // Observations (rå, leverandør-nøytrale posisjonspunkter)
  // ---------------------------------------------------------------------

  /**
   * Registrerer ETT rått posisjonspunkt. Beregner `retention_expires_at`
   * FRA den eier-konfigurerte retensjonspolicyen (aldri hardkodet, se
   * filhode) og evaluerer DERETTER, i SAMME transaksjon, om personen har
   * krysset noen av sine konfigurerte soner (`evaluateZoneTransitionsInTransaction`)
   * - én innsatt observasjon er ALLTID atomisk med den avledede
   * sone-tilstanden den utløser.
   */
  async ingestObservation(tenantId: string, memorySpace: MemorySpace, input: IngestObservationInput): Promise<LocationObservation> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const retentionDays = await this.retentionDaysInTransaction(client, tenantId, memorySpace);
      const observedAtMs = new Date(input.observed_at).getTime();
      const retentionExpiresAt = new Date(observedAtMs + retentionDays * 24 * 60 * 60 * 1000).toISOString();

      const observation_id = `loc-ob-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO location_observations
           (observation_id, tenant_id, memory_space_id, person_id, source_type, source_instance_id, lat, lon, accuracy_meters, observed_at, retention_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [
          observation_id, tenantId, memorySpace, input.person_id, input.source_type, input.source_instance_id ?? null,
          input.lat, input.lon, input.accuracy_meters ?? null, input.observed_at, retentionExpiresAt
        ]
      );
      const observation = rows[0] as LocationObservation;
      await this.evaluateZoneTransitionsInTransaction(client, tenantId, memorySpace, observation);
      return observation;
    });
  }

  /**
   * Re-evaluerer sone-inn/ut-tilstand for EN EKSISTERENDE observasjon
   * (idempotent - trygg å kalle igjen, f.eks. ved backfill/replay). Normal
   * ingestering trenger ALDRI å kalle denne selv - `ingestObservation()`
   * gjør det allerede i samme transaksjon.
   */
  async evaluateZoneTransitions(tenantId: string, memorySpace: MemorySpace, observationId: string): Promise<ZoneTransitionResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM location_observations WHERE tenant_id = $1 AND memory_space_id = $2 AND observation_id = $3`,
        [tenantId, memorySpace, observationId]
      );
      const observation = rows[0] as LocationObservation | undefined;
      if (!observation) return { entered: [], left: [] };
      return this.evaluateZoneTransitionsInTransaction(client, tenantId, memorySpace, observation);
    });
  }

  private async evaluateZoneTransitionsInTransaction(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    observation: LocationObservation
  ): Promise<ZoneTransitionResult> {
    const { rows: zoneRows } = await client.query(
      `SELECT * FROM location_zones WHERE tenant_id = $1 AND memory_space_id = $2 AND person_id = $3`,
      [tenantId, memorySpace, observation.person_id]
    );
    const zones = zoneRows as LocationZone[];
    const entered: LocationZoneVisit[] = [];
    const left: LocationZoneVisit[] = [];

    for (const zone of zones) {
      const distance = haversineMeters(observation.lat, observation.lon, zone.center_lat, zone.center_lon);
      const inside = distance <= zone.radius_meters;

      const { rows: openRows } = await client.query(
        `SELECT * FROM location_zone_visits
         WHERE tenant_id = $1 AND memory_space_id = $2 AND person_id = $3 AND zone_id = $4 AND left_at IS NULL
         FOR UPDATE`,
        [tenantId, memorySpace, observation.person_id, zone.zone_id]
      );
      const openVisit = openRows[0] as LocationZoneVisit | undefined;

      if (inside && !openVisit) {
        const visit_id = `loc-vi-${randomUUID()}`;
        const { rows } = await client.query(
          `INSERT INTO location_zone_visits
             (visit_id, tenant_id, memory_space_id, person_id, zone_id, entered_at, source_observation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [visit_id, tenantId, memorySpace, observation.person_id, zone.zone_id, observation.observed_at, observation.observation_id]
        );
        entered.push(rows[0] as LocationZoneVisit);
      } else if (!inside && openVisit) {
        const { rows } = await client.query(
          `UPDATE location_zone_visits SET left_at = $1, updated_at = now()
           WHERE tenant_id = $2 AND memory_space_id = $3 AND visit_id = $4 RETURNING *`,
          [observation.observed_at, tenantId, memorySpace, openVisit.visit_id]
        );
        left.push(rows[0] as LocationZoneVisit);
      }
      // inside && openVisit -> fortsatt i sonen, ekte no-op (ingen ny rad, ingen oppdatering).
      // !inside && !openVisit -> fortsatt utenfor sonen, ekte no-op.
    }
    return { entered, left };
  }

  // ---------------------------------------------------------------------
  // Retensjons-HÅNDHEVING (faktisk sletting - se filens bunn-kommentar for scheduler-kravet)
  // ---------------------------------------------------------------------

  /**
   * Sletter alle `location_observations`-rader for ÉN (tenant, memory_space)
   * hvis `retention_expires_at` har passert. Dette er den FAKTISKE
   * håndhevingen - `retention_expires_at`-kolonnen alene håndhever
   * ingenting. Returnerer antall slettede rader. Rader UTEN en satt frist
   * røres ALDRI (skal i praksis ikke forekomme, se `ingestObservation()`,
   * men behandles bevisst som "ikke forfalt" - fail-safe mot utilsiktet
   * sletting av data uten kjent policy).
   */
  async purgeExpiredObservations(tenantId: string, memorySpace: MemorySpace): Promise<number> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM location_observations
         WHERE tenant_id = $1 AND memory_space_id = $2 AND retention_expires_at IS NOT NULL AND retention_expires_at < now()`,
        [tenantId, memorySpace]
      );
      return rowCount ?? 0;
    });
  }

  // ---------------------------------------------------------------------
  // Lese-API-er - eksplisitt (tenant, memory_space)-skopet i signaturen
  // (RLS håndhever det reelt, men et blankt "gi meg alt"-kall skal ALDRI
  // være mulig å uttrykke ved et uhell - se byggeordrens "routing"-krav).
  // ---------------------------------------------------------------------

  /** Personens SISTE kjente posisjon i det oppgitte space-et, eller null hvis ingen observasjon finnes/er innenfor RLS-scope. */
  async getPersonLocation(tenantId: string, memorySpace: MemorySpace, personId: string): Promise<LocationObservation | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM location_observations WHERE tenant_id = $1 AND person_id = $2 ORDER BY observed_at DESC LIMIT 1`,
        [tenantId, personId]
      );
      return (rows[0] as LocationObservation) ?? null;
    });
  }

  async listZoneVisits(
    tenantId: string,
    memorySpace: MemorySpace,
    personId: string,
    filter: { zone_id?: string; open_only?: boolean } = {}
  ): Promise<LocationZoneVisit[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const clauses = ["tenant_id = $1", "person_id = $2"];
      const params: unknown[] = [tenantId, personId];
      if (filter.zone_id !== undefined) {
        params.push(filter.zone_id);
        clauses.push(`zone_id = $${params.length}`);
      }
      if (filter.open_only) clauses.push("left_at IS NULL");
      const { rows } = await client.query(
        `SELECT * FROM location_zone_visits WHERE ${clauses.join(" AND ")} ORDER BY entered_at DESC`,
        params
      );
      return rows as LocationZoneVisit[];
    });
  }
}

/**
 * SCHEDULER-KRAV (rapportert i byggeordrens svar - IKKE wiret her, se
 * CLAUDE.md/byggeordre: `apps/api/src/main.ts`/`worker-main.ts` er utenfor
 * denne agentens eierskap): `LocationService.purgeExpiredObservations(tenantId,
 * memorySpace)` MÅ kalles periodisk for HVER (tenant, memory_space)-kombinasjon
 * som faktisk har lokasjonsdata - retensjonskolonnen håndhever INGENTING av
 * seg selv. Samme fan-out-mønster som `modules/business/src/open-loop-sweep.ts`
 * sin `runOpenLoopSweepForAllTenants()` (iterer tenants, kjør per (tenant,
 * space), fang og logg per-tenant-feil uten å velte hele sveipet) - MERK:
 * `listBusinessTenantIds()` (@jarvis/core) dekker KUN `kind='business'`-
 * tenants (se 023_business_tenant_catalog.sql) og er derfor IKKE tilstrekkelig
 * alene her, siden lokasjonsdata typisk hører til en PERSONLIG (`kind='person'`)
 * tenant - den sentrale wiringen trenger en tenant-katalog-spørring som
 * dekker BEGGE `kind`-verdiene (evt. en ny, tilsvarende `SECURITY DEFINER`-
 * katalogfunksjon), pluss en per-tenant `memory_spaces`-oppslag for hvilke
 * spaces som faktisk skal sveipes. Foreslått frekvens: DAGLIG (retensjon
 * måles i dager, ikke minutter - ingen presist sanntidsbehov, og hyppigere
 * kjøring gir ingen reell personvernsgevinst utover økt DB-last).
 */

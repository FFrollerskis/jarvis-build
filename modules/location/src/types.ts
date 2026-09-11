import { z } from "zod";

/**
 * UA-8 Personal Digital Twin - Native Jarvis Location/Geofencing Core
 * (D-64 Core-vs-Adapter-porten kjørt FØRST, se 050_location.sql sitt
 * filhode og DECISIONS_AND_ASSUMPTIONS.md D-64/D-129). Jarvis EIER selv den
 * kanoniske lokasjons-/geofence-domenemodellen - ZERO leverandør-spesifikke
 * felter her. Et fremtidig eksternt system (Apple Find My, Google, en
 * hjemme-hub, etc.) er en VALGFRI, senere ADAPTER som SKRIVER INN
 * observasjoner via `source_type`/`source_instance_id` (pointer-not-
 * payload) - ALDRI spurt live, ALDRI domeneeier.
 */

export const LocationSourceTypeSchema = z.string().min(1).max(64);
export type LocationSourceType = string;

// ---------------------------------------------------------------------
// Retention (eier-konfigurert, Jarvis håndhever - se 050_location.sql)
// ---------------------------------------------------------------------

export interface LocationRetentionPolicy {
  tenant_id: string;
  memory_space_id: string;
  retention_days: number;
  actor_person_id: string | null;
  updated_at: string;
}

export const SetLocationRetentionPolicyInputSchema = z.object({
  retention_days: z.number().int().positive(),
  actor_person_id: z.string().min(1).optional()
});
export type SetLocationRetentionPolicyInput = z.infer<typeof SetLocationRetentionPolicyInputSchema>;

// ---------------------------------------------------------------------
// Zones (geofences)
// ---------------------------------------------------------------------

export interface LocationZone {
  zone_id: string;
  tenant_id: string;
  memory_space_id: string;
  person_id: string;
  name: string;
  center_lat: number;
  center_lon: number;
  radius_meters: number;
  created_at: string;
}

export const CreateLocationZoneInputSchema = z.object({
  person_id: z.string().min(1),
  name: z.string().min(1),
  center_lat: z.number().min(-90).max(90),
  center_lon: z.number().min(-180).max(180),
  radius_meters: z.number().positive()
});
export type CreateLocationZoneInput = z.infer<typeof CreateLocationZoneInputSchema>;

// ---------------------------------------------------------------------
// Observations (rå, leverandør-nøytrale posisjonspunkter)
// ---------------------------------------------------------------------

export interface LocationObservation {
  observation_id: string;
  tenant_id: string;
  memory_space_id: string;
  person_id: string;
  source_type: string;
  source_instance_id: string | null;
  lat: number;
  lon: number;
  accuracy_meters: number | null;
  observed_at: string;
  recorded_at: string;
  retention_expires_at: string | null;
}

export const IngestObservationInputSchema = z.object({
  person_id: z.string().min(1),
  source_type: LocationSourceTypeSchema,
  source_instance_id: z.string().min(1).optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracy_meters: z.number().min(0).optional(),
  /** ISO-8601. Tidspunktet posisjonen faktisk BLE observert (kan avvike fra `recorded_at` ved forsinket levering). */
  observed_at: z.string().min(1)
});
export type IngestObservationInput = z.infer<typeof IngestObservationInputSchema>;

// ---------------------------------------------------------------------
// Zone visits (DERIVERT - se LocationService.evaluateZoneTransitions())
// ---------------------------------------------------------------------

export interface LocationZoneVisit {
  visit_id: string;
  tenant_id: string;
  memory_space_id: string;
  person_id: string;
  zone_id: string;
  entered_at: string;
  left_at: string | null;
  source_observation_id: string;
  created_at: string;
  updated_at: string;
}

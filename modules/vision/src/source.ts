import type { VisionEventType } from "./types.ts";

/**
 * WP-G3 (D-465), P1a: `VisionSource` - adaptergrensen (CLAUDE.md regel 3) mellom Jarvis og en KAMERAKILDE (Home Assistant i dag; iPhone på forespørsel går via capture.ts).
 *
 * Skillet fra den eldre `VisionEventSource` (types.ts, P0): den leverer ALLEREDE klassifiserte hendelser; `VisionSource` leverer RÅ utløsere (bevegelse, dørklokke, åpning,
 * alarm - bestemt av kildesensoren, aldri av en modell) og kan hente ETT øyeblikksbilde for en utløser. Klassifisering skjer i Jarvis (classifier.ts, lokal modell), og hva som
 * skjer med bildet bestemmes av datapolicyen (policy.ts) - aldri av kilden.
 *
 * Kontrakt og grenser:
 *   - Kun HENDELSESØYEBLIKKSBILDER: `fetchSnapshot` returnerer ETT stillbilde (bytes + deklarert type). Ingen metode abonnerer på en strøm; en implementasjon som gjorde det ville bli felt av
 *     vakttesten (g3-guards.test.ts) og av datapolicyen (`continuous_stream` forkastes alltid).
 *   - Kilden er UBETRODD: bytes valideres av `inspectImage` (magic bytes, størrelse) FØR noe annet; utløserens tekst/attributter brukes aldri som innhold (kun lukkede, deterministisk
 *     avledede felt).
 *   - Idempotens: `source_event_id` er en STABIL id utledet fra kilden (HA: `<entity_id>@<tidspunkt>`), slik at en gjentatt poll ikke gir en ny hendelse (055-dedupenøkkelen).
 *   - Kilden gjør ingen skrive-/styringshandlinger (D-41: HA-kamera er i denne versjonen kun LESING, klasse A; se runbook).
 */
export interface VisionSourceCamera {
  camera_id: string;
  /** HA: kameraets entity_id (`camera.*`). */
  source_ref: string;
  /** HA: sensorene (`binary_sensor.*`/`event.*`/`alarm_control_panel.*`) som produserer utløsere for dette kameraet. */
  trigger_entities: readonly string[];
}

export interface VisionSourceEvent {
  source_type: string;
  /** Alltid kameraets `camera_id` (stabil peker til det registrerte kameraet). */
  source_instance_id: string;
  source_event_id: string;
  /** Utledet DETERMINISTISK fra utløserens sensorklasse - aldri fra en modell. */
  event_type: VisionEventType;
  /** ISO 8601. */
  observed_at: string;
  /** Alder (ms) på utløseren da den ble lest. Et øyeblikksbilde hentet «nå» representerer kun en fersk hendelse (pipeline.ts `maxSnapshotAgeMs`). */
  age_ms: number;
  /** Sensoren (eierens konfigurerte entity_id) som utløste hendelsen. */
  trigger: string;
}

export interface CapturedImage {
  bytes: Uint8Array;
  /** HTTP content-type eller signert felt - kun en konsistenssjekk mot bytene (`inspectImage`). */
  declared_type?: string | undefined;
}

export interface VisionSource {
  readonly source_type: string;
  /** Leser utløserne for de gitte kameraene. Én utløser per (sensor, tidspunkt); kun ferske (innenfor kildens eget vindu). Kaster ved kildefeil (pipeline fanger per kamera). */
  pollEvents(cameras: readonly VisionSourceCamera[], now: Date): Promise<VisionSourceEvent[]>;
  /** Henter ETT øyeblikksbilde. `maxBytes` er en hard lesegrense. */
  fetchSnapshot(camera: VisionSourceCamera, maxBytes: number): Promise<CapturedImage>;
}

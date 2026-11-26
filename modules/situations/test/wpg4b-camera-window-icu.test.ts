import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SituationSignalBus } from "../src/signal-bus.ts";
import { episodeKeyFor } from "../src/signal-types.ts";
import type { VisionObservation } from "../src/vision-bridge.ts";
import { actorOwner, startG4Db, TENANT_A, type G4Db } from "./support/wpg4-db.ts";

/**
 * WP-G4b fiks-runde 1, FIX-12 (review A LOW-5, mutant M34): `starts_with(detection_key, prefiks)` i episodesøket (`SituationSignalBus.episodeKey`) er IKKE overflødig i produksjon. Områdesøket
 * `detection_key BETWEEN <nedre> AND <øvre>` følger kolonnens KOLLASJON: under en ICU-kollasjon (`und-x-icu`, `en-US-x-icu`) er `camera.A` og `camera.a` like på første nivå, så søket etter `camera.a` returnerer også nøkler for
 * `camera.A` (en ANNEN kamera-id). `starts_with` er byte-sammenligning og filtrerer dem bort. Under `C`-kollasjon (standard i testbasen) er filteret overflødig, derfor fanget ingen test fjerning av det (M34).
 * Testen bytter kolonnens kollasjon til ICU i en egen testbase og kjører den EKTE bussen. VERIFISERT: C, POSIX og ICU (`und-x-icu`, `en-US-x-icu`). IKKE verifisert: glibc `en_US` (NAS-ens Postgres-image); `starts_with` er byte-basert og gir
 * riktig resultat under alle kollasjoner, så filteret skal stå uansett.
 */
const MIN = 60_000;
const T0 = Date.parse("2026-11-19T10:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const PREFIX_LOWER = "vision:motion_detected:camera.a:";
const PREFIX_UPPER = "vision:motion_detected:camera.A:";

describe("ICU-kollasjon: kamera-id-er som kun skiller seg på store/små bokstaver er ULIKE kameraer", () => {
  let db: G4Db;
  beforeAll(async () => { db = await startG4Db("wpg4b_icu"); }, 240_000);
  afterAll(async () => { await db?.stop(); }, 120_000);
  beforeEach(async () => { await db.reset(); });

  const busAt = (nowMs: number): SituationSignalBus =>
    new SituationSignalBus({ pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses, subscriptions: (t, s) => db.registry.listEnabled(t, s), now: () => nowMs });
  const obs = (camera: string, atMs: number): VisionObservation => ({
    source: "vision", observation_id: `${camera}-${atMs}`, event_type: "motion_detected", source_instance_id: camera, source_event_id: `binary_sensor.b@${iso(atMs)}`, observed_at: iso(atMs), object_label: null, classification_status: "not_applicable"
  });
  const keys = async (): Promise<string[]> => (await db.adminPool.query(`SELECT detection_key FROM situations WHERE tenant_id = $1 AND domain = 'vision' ORDER BY detection_key COLLATE "C"`, [TENANT_A])).rows.map((r: { detection_key: string }) => r.detection_key);
  const setCollation = async (collation: string): Promise<void> => {
    await db.adminPool.query(`ALTER TABLE situations ALTER COLUMN detection_key TYPE text COLLATE "${collation}"`);
    const { rows } = await db.adminPool.query(`SELECT collation_name FROM information_schema.columns WHERE table_name = 'situations' AND column_name = 'detection_key'`);
    expect(rows[0]).toEqual({ collation_name: collation }); // beviser at testen faktisk kjører under ICU (ikke et tomt bevis)
  };

  for (const collation of ["und-x-icu", "en-US-x-icu"]) {
    it(`${collation}: forutsetningen (uten filteret finner områdesøket feil kameras nøkler) og den EKTE bussen (filteret holder kameraene adskilt)`, async () => {
      await setCollation(collation);
      await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "motion_detected", filter: {} }, actorOwner);

      // 1) FORUTSETNINGEN: samme områdesøk som `episodeKey`, MED og UTEN `starts_with`, mot en eksisterende `camera.A`-nøkkel
      await busAt(T0 + 1_000).publishBatch(TENANT_A, "home", [obs("camera.A", T0)]);
      expect(await keys()).toEqual([episodeKeyFor(PREFIX_UPPER, T0)]);
      const lower = episodeKeyFor(PREFIX_LOWER, T0 + MIN - 10 * MIN + 1);
      const upper = episodeKeyFor(PREFIX_LOWER, T0 + MIN);
      const range = (withStartsWith: boolean) => db.adminPool.query(
        `SELECT detection_key FROM situations WHERE tenant_id = $1 AND detection_key BETWEEN $2 AND $3 ${withStartsWith ? "AND starts_with(detection_key, $4)" : "AND $4::text IS NOT NULL"} AND substr(detection_key, $5) ~ $6`,
        [TENANT_A, lower, upper, PREFIX_LOWER, PREFIX_LOWER.length + 1, "^[0-9]{13}$"]
      );
      expect((await range(false)).rows.map((r: { detection_key: string }) => r.detection_key), `uten starts_with under ${collation}`).toEqual([episodeKeyFor(PREFIX_UPPER, T0)]); // FEIL kamera slipper gjennom
      expect((await range(true)).rows, `med starts_with under ${collation}`).toEqual([]);

      // 2) ATFERD: en hendelse fra `camera.a` ett minutt senere er IKKE en duplikat av `camera.A` (ulik kamera-id): ny episode, egen nøkkel
      const out = await busAt(T0 + MIN + 1_000).publishBatch(TENANT_A, "home", [obs("camera.a", T0 + MIN)]);
      expect(out).toMatchObject({ evaluated: 1, created: 1, failed: 0 });
      expect(await keys()).toEqual([episodeKeyFor(PREFIX_UPPER, T0), episodeKeyFor(PREFIX_LOWER, T0 + MIN)]);
      // og en duplikat INNENFOR samme kameras vindu slås fortsatt sammen (filteret bryter ikke den glidende semantikken)
      expect(await busAt(T0 + 2 * MIN + 1_000).publishBatch(TENANT_A, "home", [obs("camera.a", T0 + 2 * MIN)])).toMatchObject({ evaluated: 1, created: 0 });
      expect(await busAt(T0 + 2 * MIN + 2_000).publishBatch(TENANT_A, "home", [obs("camera.A", T0 + 2 * MIN)])).toMatchObject({ evaluated: 1, created: 0 });
      expect(await keys()).toHaveLength(2);
    });
  }
});

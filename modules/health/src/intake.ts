import { randomUUID } from "node:crypto";
import type pg from "pg";
import { writeAudit } from "@jarvis/core";
import type { IdentityContext } from "@jarvis/contracts";
import { withMemoryTransaction } from "@jarvis/memory";
import { HealthRetentionPolicyRequiredError } from "./service.ts";
import { MetricTypeSchema, type MetricType } from "./types.ts";
import { isPlausibleObservedAt, validateHealthObservation } from "./validation.ts";

/**
 * WP-G2 (D-464, UA-8 Personal Twin) P1d: HELSE-INNTAK fra personens egen iPhone/Watch. Serversiden av et enhetssignert push; selve appen finnes ikke (krever Mac + Apple Developer-konto = `BLOCKED_EXTERNAL`), så alt her er bygget
 * og testet mot FAKE data. Reglene (håndhevet i kode og database, ikke i en prompt):
 *  - dataene tilhører ALLTID den innloggede personen (`identity.person_id` fra det verifiserte grantet) og lander i `health`-rommet; kilden er fast `apple_health` og kilde-pekeren er grantets enhet - aldri noe appen selv påstår.
 *  - LUKKET metrikkliste og kanonisk enhet/grenser (`validateHealthObservation`, samme regelsett som enkeltinntaket); alt utenfor avvises per prøve med en årsakskode.
 *  - IDEMPOTENT: `external_sample_id` (HealthKits `HKObject.uuid`) + kilde + person er unik i databasen (`ON CONFLICT DO NOTHING`). Samme prøve på nytt = `duplicate`; samme id med ANNET innhold = `conflict` (HealthKit-prøver er
 *    uforanderlige, så en annen verdi under samme id er en feil, og den lagres ikke - ingen stille overskriving).
 *  - RETENSJON FAIL-CLOSED (D-396): uten en eier-konfigurert oppbevaringstid tas ingenting inn (`HealthRetentionPolicyRequiredError`); en prøve som allerede er utløpt ved ankomst lagres ikke (`expired`) - vi tar aldri inn noe som
 *    umiddelbart måtte slettes.
 *  - SLETTING: HealthKit kan slette og erstatte prøver (f.eks. hvilepuls) og slår sammen delprøver; appen sender slettede `uuid`-er i `deleted_external_sample_ids`, og de fjernes fra personens egne rader.
 *  - REVISJON uten innhold: én `health.intake_batch`-rad med KUN antall og metrikktyper (aldri verdier, prøve-id-er eller tidspunkt). Helsedata er begrenset (SECRET_RESTRICTED): ingen modell, prompt, logg eller verktøy ser dem - denne tjenesten har
 *    ingen avhengighet til modellgatewayen og er ikke registrert som noe verktøy.
 * Kjente begrensninger (ikke skjult; WP-G2c, D-483, JARVIS-113 e/5). ALLE er `DEFERRED`: de krever appen (`BLOCKED_EXTERNAL`), og en prøve bærer bare `observed_at` (ikke start/slutt eller HealthKit-kilde), så serveren kan ikke oppdage dem selv og
 * gjetter aldri hvilke prøver som er slått sammen. Appens kontrakt (uverifisert mot en ekte enhet - appen finnes ikke):
 *  1. SAMMENSLÅING gjelder ALLE metrikker, ikke bare de kumulative (`steps`, `active_energy_kcal`, `exercise_minutes`): HealthKit kan slå sammen eller erstatte prøver også for `heart_rate` (og erstatte f.eks. hvilepuls) under NYE uuid-er. Mottar vi ikke
 *     slettingen av de gamle prøvene (`deleted_external_sample_ids`, HKDeletedObject - midlertidig i HealthKit), blir både gamle og nye stående (og `steps_today` dobbelttelles). Appen MÅ sende slettingene sammen med erstatningen.
 *  2. SØVN er en SUM uten egen uuid (`sleep_duration_minutes` = `sleepAnalysis` summert av appen). Appen lager id-en selv, og den MÅ endres når summen endres: samme id med en annen verdi er `conflict` for alltid (prøver er uforanderlige, den nye
 *     verdien lagres aldri). Kontrakt: versjonert id (f.eks. `sleep:<natt>:<hash av de underliggende uuid-ene>`), og forrige versjons id sendes i `deleted_external_sample_ids` i SAMME batch. Rekkefølgen i en batch er innsettinger FØRST og slettinger
 *     SIST, i én transaksjon: en id som står i begge listene gir en slettet rad.
 *  3. SKRITT fra iPhone og Watch overlapper: sender appen råprøver fra begge, summeres de dobbelt i `steps_today` (familievisningen). Appen skal sende HealthKits DEDUPLISERTE statistikk (`HKStatisticsCollectionQuery`, kilder slått sammen etter prioritet)
 *     i lukkede intervaller i stedet for råprøver.
 */
export const HEALTH_INTAKE_SOURCE_TYPE = "apple_health";
/** Begrenset av `MAX_JSON_BODY_BYTES` (64 KiB) i API-et: 250 prøver à ~150 byte + 250 slettinger à ~40 byte holder seg trygt under (se testen); appen deler opp større mengder i flere kall. */
export const HEALTH_INTAKE_MAX_SAMPLES = 250;
export const HEALTH_INTAKE_MAX_DELETES = 250;
/** En klokke som går litt foran er normalt; mer enn dette frem i tid er en feil. */
export const HEALTH_INTAKE_MAX_FUTURE_SKEW_MS = 10 * 60_000;
/** `HKObject.uuid` (36 tegn) og lignende stabile id-er; tilsvarer migrasjon 128 (8-128 tegn). */
const SAMPLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type HealthIntakeErrorCode = "empty_batch" | "batch_too_large" | "invalid_request" | "invalid_timestamps";
export class HealthIntakeError extends Error {
  /** `invalid_timestamps`: INDEKSENE (aldri verdiene) til prøvene med et ugyldig `observed_at`, slik at appen kan rette dem og sende batchen på nytt. */
  constructor(readonly code: HealthIntakeErrorCode, readonly indexes?: readonly number[]) {
    super(`health_intake_${code}`);
    this.name = "HealthIntakeError";
  }
}

export type HealthIntakeSampleStatus = "created" | "duplicate" | "conflict" | "invalid" | "expired";
export interface HealthIntakeSampleResult {
  index: number;
  status: HealthIntakeSampleStatus;
  /** Kun for `invalid`/`conflict`/`expired`: en kort KODE (aldri verdien eller en feiltekst som kan inneholde den). */
  reason?: string;
}
export interface HealthIntakeCounts { created: number; duplicate: number; conflict: number; invalid: number; expired: number; deleted: number }
export interface HealthIntakeResult { results: HealthIntakeSampleResult[]; counts: HealthIntakeCounts }

/** Det inntaket trenger fra den verifiserte identiteten (fra grantet, aldri en kropp). */
export type HealthIntakeIdentity = Pick<IdentityContext, "tenant_id" | "person_id" | "session_id" | "device_id" | "channel">;

/** Feltnavn fra valideringen -> stabil årsakskode (aldri `detail`, som kan inneholde verdien). */
const REASON_BY_FIELD: Readonly<Record<string, string>> = { metric_type: "invalid_metric_type", unit: "invalid_unit", value: "value_out_of_range", observed_at: "invalid_observed_at", external_sample_id: "invalid_external_sample_id" };
const reasonFor = (field: string): string => REASON_BY_FIELD[field] ?? "invalid_sample";

export class HealthIntakeService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Tar inn ett batch i ÉN transaksjon (`health`-rommet alene). En ugyldig prøve avbryter ikke de andre (appen får en status per prøve og prøver bare de som feilet på nytt); en systemfeil (ingen retensjonspolicy, database) ruller hele batchen tilbake.
   * `request.samples`/`request.deleted_external_sample_ids` er URØRT, ubetrodd inndata fra appen.
   */
  async ingestBatch(identity: HealthIntakeIdentity, request: { samples?: unknown; deleted_external_sample_ids?: unknown }): Promise<HealthIntakeResult> {
    const samples = request.samples === undefined ? [] : request.samples;
    const deleted = request.deleted_external_sample_ids === undefined ? [] : request.deleted_external_sample_ids;
    if (!Array.isArray(samples) || !Array.isArray(deleted)) throw new HealthIntakeError("invalid_request");
    if (samples.length > HEALTH_INTAKE_MAX_SAMPLES || deleted.length > HEALTH_INTAKE_MAX_DELETES) throw new HealthIntakeError("batch_too_large");
    if (samples.length === 0 && deleted.length === 0) throw new HealthIntakeError("empty_batch");
    if (deleted.some((id) => typeof id !== "string" || !SAMPLE_ID.test(id))) throw new HealthIntakeError("invalid_request");
    // Et ugyldig `observed_at` (en streng JS godtar men Postgres avviser, f.eks. `2026-09-31T10:00:00Z`) ville felt HELE transaksjonen MIDT I (22008/22007 -> rollback av alle, 500, og appen ville sendt den samme giftige batchen for evig):
    // valider STRENGT FØR transaksjonen og avvis batchen med INDEKSENE (review B MEDIUM-2). En manglende/ikke-streng verdi er en vanlig per-prøve-feil (`invalid`) og når aldri databasen.
    const malformed = samples.flatMap((raw, index) => {
      const at = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>)["observed_at"] : undefined;
      return typeof at === "string" && !isPlausibleObservedAt(at) ? [index] : [];
    });
    if (malformed.length > 0) throw new HealthIntakeError("invalid_timestamps", malformed);

    return withMemoryTransaction(this.pool, identity.tenant_id, ["health"], async (client) => {
      const policy = await client.query(`SELECT retention_days, now() AS db_now FROM health_retention_policies WHERE tenant_id = $1 AND memory_space_id = 'health'`, [identity.tenant_id]);
      if (policy.rows.length === 0) throw new HealthRetentionPolicyRequiredError();
      const retentionMs = Number((policy.rows[0] as { retention_days: number }).retention_days) * 86_400_000;
      const dbNow = new Date((policy.rows[0] as { db_now: string }).db_now).getTime();

      const results: HealthIntakeSampleResult[] = [];
      const counts: HealthIntakeCounts = { created: 0, duplicate: 0, conflict: 0, invalid: 0, expired: 0, deleted: 0 };
      const createdMetrics = new Set<MetricType>();
      const outcome = (index: number, status: HealthIntakeSampleStatus, reason?: string): void => {
        results.push({ index, status, ...(reason !== undefined ? { reason } : {}) });
        counts[status] += 1;
      };

      for (const [index, raw] of samples.entries()) {
        const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
        const externalId = record?.["external_sample_id"];
        if (record === null || typeof externalId !== "string" || !SAMPLE_ID.test(externalId)) { outcome(index, "invalid", "invalid_external_sample_id"); continue; }
        // Kilde og kilde-peker settes HER (fast kilde + grantets enhet); `external_sample_id` er ikke en del av observasjonsskjemaet og fjernes før valideringen. Ukjente nøkler i prøven avvises av det strenge skjemaet.
        const { external_sample_id: _omit, ...fields } = record;
        void _omit;
        // Kilden er serverens, ikke appens: en prøve som selv oppgir kilde/kilde-peker er en app-feil og avvises (ikke stille overstyrt).
        if ("source_type" in fields || "source_instance_id" in fields) { outcome(index, "invalid", "source_fields_forbidden"); continue; }
        const checked = validateHealthObservation({ ...fields, source_type: HEALTH_INTAKE_SOURCE_TYPE, source_instance_id: identity.device_id });
        if (!checked.ok) { outcome(index, "invalid", reasonFor(checked.field)); continue; }
        const value = checked.value;
        const observedMs = Date.parse(value.observed_at);
        if (observedMs > dbNow + HEALTH_INTAKE_MAX_FUTURE_SKEW_MS) { outcome(index, "invalid", "observed_at_in_future"); continue; }
        if (observedMs + retentionMs <= dbNow) { outcome(index, "expired", "outside_retention_window"); continue; }

        const inserted = await client.query(
          `INSERT INTO health_metric_observations
             (observation_id, tenant_id, person_id, metric_type, value, unit, source_type, source_instance_id, observed_at, retention_expires_at, external_sample_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                   (SELECT $9::timestamptz + (retention_days || ' days')::interval FROM health_retention_policies WHERE tenant_id = $2 AND memory_space_id = 'health'),
                   $10)
           ON CONFLICT (tenant_id, person_id, source_type, external_sample_id) WHERE external_sample_id IS NOT NULL DO NOTHING
           RETURNING observation_id`,
          [`health-obs-${randomUUID()}`, identity.tenant_id, identity.person_id, value.metric_type, value.value, value.unit, HEALTH_INTAKE_SOURCE_TYPE, identity.device_id, value.observed_at, externalId]
        );
        if (inserted.rows.length > 0) {
          createdMetrics.add(value.metric_type);
          outcome(index, "created");
          continue;
        }
        const existing = await client.query(
          `SELECT metric_type, value, unit, observed_at FROM health_metric_observations WHERE tenant_id = $1 AND person_id = $2 AND source_type = $3 AND external_sample_id = $4`,
          [identity.tenant_id, identity.person_id, HEALTH_INTAKE_SOURCE_TYPE, externalId]
        );
        const row = existing.rows[0] as { metric_type: string; value: string | number; unit: string; observed_at: string | Date } | undefined;
        const same = row !== undefined && row.metric_type === value.metric_type && Number(row.value) === value.value && row.unit === value.unit && new Date(row.observed_at).getTime() === observedMs;
        if (same) outcome(index, "duplicate");
        else outcome(index, "conflict", "sample_id_reused_with_different_content");
      }

      if (deleted.length > 0) {
        // Kun personens EGNE rader fra denne kilden (RLS + person/kilde i vilkåret): en annen persons eller kildes rad kan aldri treffes av en liste med id-er.
        const removed = await client.query(
          `DELETE FROM health_metric_observations WHERE tenant_id = $1 AND person_id = $2 AND source_type = $3 AND external_sample_id = ANY($4::text[])`,
          [identity.tenant_id, identity.person_id, HEALTH_INTAKE_SOURCE_TYPE, deleted]
        );
        counts.deleted = removed.rowCount ?? 0;
      }

      await writeAudit(client, identity, {
        type: "health.intake_batch", decision: "ALLOW",
        payload: { ...counts, metric_types: [...createdMetrics].sort(), submitted: samples.length, deletions_requested: deleted.length, channel: identity.channel }
      });
      return { results, counts };
    });
  }
}

/** Tilgjengelig for tester og dokumentasjon: den lukkede listen akkurat slik inntaket godtar den. */
export const HEALTH_INTAKE_METRICS: readonly MetricType[] = MetricTypeSchema.options;

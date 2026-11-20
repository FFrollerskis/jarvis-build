import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import {
  type HealthMetricObservation,
  type HealthMetricSource,
  type HealthObservationInput,
  type HealthRetentionPolicy,
  type MetricType,
  type SetHealthRetentionPolicyInput
} from "./types.ts";
import { validateHealthObservation } from "./validation.ts";

/**
 * UA-8 Personal Digital Twin: JARVIS_CANONICAL helse-ingestion-/lese-tjeneste
 * (D-64 Core-vs-Adapter-porten kjørt FØRST - se DECISIONS_AND_ASSUMPTIONS.md).
 *
 * Dette er et KONTRAKT-/INGESTION-lag, IKKE en live Apple Health-integrasjon
 * - dette miljøet har verken en fysisk iPhone eller en Apple Health-
 * entitlement, og INGEN kode her later som den snakker med en ekte Apple-
 * kjøretid. `HealthMetricSource` (types.ts) er den STABILE, provider-
 * nøytrale kontrakten en fremtidig ekte adapter (Apple Health eller en
 * annen leverandør) implementerer - denne tjenesten sine interne metoder
 * endres IKKE når en slik adapter en dag bygges.
 *
 * SEGREGERING (ufravikelig): ALLE metoder bruker `withMemoryTransaction`
 * med `["health"]` som ENESTE space - ALDRI kombinert med et annet space i
 * samme kall (`assertSpacesAllowed()` i `@jarvis/memory` håndhever dette
 * strukturelt uansett). `049_health.sql` sin `CHECK (memory_space_id =
 * 'health')` er en UAVHENGIG, DB-strukturell garanti for AKKURAT samme ting
 * - forsvar-i-dybden, ikke duplisering.
 *
 * APPEND-ONLY: `health_metric_observations` har INGEN UPDATE-grant (samme
 * "strukturelt, ikke konvensjonelt"-prinsipp som `consent_decisions`). En
 * feilregistrert måling korrigeres av en NY observasjon fra kilden, ALDRI
 * ved å mutere en historisk rad.
 */
/**
 * D-396 (JARVIS-093): helsedata er særlig kategori (GDPR art. 9). Inntak uten en eier-konfigurert oppbevaringstid ga `retention_expires_at = NULL`
 * (lagres for alltid). Nå er inntak fail-closed: konfigurer oppbevaringsvindu (`setRetentionPolicy`) FØR helsedata tas inn.
 */
export class HealthRetentionPolicyRequiredError extends Error {
  constructor() {
    super("retention_policy_required");
    this.name = "HealthRetentionPolicyRequiredError";
  }
}

export class HealthObservationValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly detail: string
  ) {
    super(`health_observation_invalid:${field}:${detail}`);
    this.name = "HealthObservationValidationError";
  }
}

export class HealthService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Eier-konfigurert retention-vindu for tenanten sitt 'health'-space (se
   * `049_health.sql`). UPSERT på current-state-formen (samme mønster som
   * `consent_enforcement_policies`, IKKE en append-only-logg - dette er
   * operasjonell konfigurasjon, ikke en juridisk betydningsfull hendelse).
   */
  async setRetentionPolicy(tenantId: string, input: SetHealthRetentionPolicyInput): Promise<HealthRetentionPolicy> {
    if (!Number.isInteger(input.retention_days) || input.retention_days <= 0) {
      throw new HealthObservationValidationError("retention_days", "must_be_positive_integer");
    }
    return withMemoryTransaction(this.pool, tenantId, ["health"], async (client) => {
      const { rows } = await client.query(
        `INSERT INTO health_retention_policies (tenant_id, memory_space_id, retention_days, actor_person_id, updated_at)
         VALUES ($1, 'health', $2, $3, now())
         ON CONFLICT (tenant_id, memory_space_id)
         DO UPDATE SET retention_days = EXCLUDED.retention_days, actor_person_id = EXCLUDED.actor_person_id, updated_at = now()
         RETURNING *`,
        [tenantId, input.retention_days, input.actor_person_id ?? null]
      );
      return rows[0] as HealthRetentionPolicy;
    });
  }

  async getRetentionPolicy(tenantId: string): Promise<HealthRetentionPolicy | null> {
    return withMemoryTransaction(this.pool, tenantId, ["health"], async (client) => {
      const { rows } = await client.query(`SELECT * FROM health_retention_policies WHERE tenant_id = $1 AND memory_space_id = 'health'`, [
        tenantId
      ]);
      return (rows[0] as HealthRetentionPolicy | undefined) ?? null;
    });
  }

  /**
   * Validerer OG skriver ÉN ny observasjon. Fail-closed: kaster en typet
   * `HealthObservationValidationError` (ALDRI en stille avvist/klippet
   * verdi) for:
   *  - en `metric_type` utenfor det lukkede MVP-settet (zod-schema, i
   *    tillegg til `049_health.sql` sin egen CHECK - forsvar-i-dybden),
   *  - en `unit` som IKKE er den ENE kanoniske enheten for gitt
   *    `metric_type` (v1 støtter INGEN enhetskonvertering),
   *  - en `value` utenfor `METRIC_VALUE_BOUNDS` for gitt `metric_type`
   *    (inkluderer per definisjon "negativ verdi", f.eks. en negativ
   *    hjertefrekvens - `049_health.sql` sin `CHECK (value >= 0)` er en
   *    UAVHENGIG DB-strukturell backstop for AKKURAT dette),
   *  - et `observed_at` som ikke er et gyldig parsbart tidsstempel.
   *
   * `retention_expires_at` beregnes ATOMISK i SAMME INSERT (ikke i JS,
   * unngår enhver klokke-/tidssone-avvik mellom applikasjon og database)
   * fra `health_retention_policies` sin `retention_days` for tenanten -
   * `NULL` (aldri utløper / aldri automatisk purget) inntil eieren har
   * konfigurert et vindu (se `049_health.sql` sin migrasjons-kommentar).
   */
  async ingestObservation(tenantId: string, personId: string, input: HealthObservationInput): Promise<HealthMetricObservation> {
    // WP-G2 P1d: valideringen bor i `validation.ts` (delt med det enhetssignerte batch-inntaket); rekkefølge og meldinger er uendret.
    const checked = validateHealthObservation(input);
    if (!checked.ok) throw new HealthObservationValidationError(checked.field, checked.detail);
    const value = checked.value;

    return withMemoryTransaction(this.pool, tenantId, ["health"], async (client) => {
      const policy = await client.query(`SELECT 1 FROM health_retention_policies WHERE tenant_id = $1 AND memory_space_id = 'health'`, [tenantId]);
      if (policy.rows.length === 0) throw new HealthRetentionPolicyRequiredError();
      const { rows } = await client.query(
        `INSERT INTO health_metric_observations
           (observation_id, tenant_id, person_id, metric_type, value, unit, source_type, source_instance_id, observed_at, retention_expires_at)
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           (
             SELECT $9::timestamptz + (retention_days || ' days')::interval
             FROM health_retention_policies
             WHERE tenant_id = $2 AND memory_space_id = 'health'
           )
         )
         RETURNING *`,
        [
          `health-obs-${randomUUID()}`,
          tenantId,
          personId,
          value.metric_type,
          value.value,
          value.unit,
          value.source_type,
          value.source_instance_id ?? null,
          value.observed_at
        ]
      );
      return rows[0] as HealthMetricObservation;
    });
  }

  /**
   * Provider-nøytral komposisjons-metode (§ byggeordren, akseptansekriterium
   * H): henter observasjoner fra EN GITT `HealthMetricSource`-adapter (ekte
   * fremtidig adapter ELLER `FakeHealthMetricSource` i tester) og validerer
   * + skriver hver av dem via `ingestObservation()` - ALDRI en egen,
   * parallell skrivevei. En observasjon som feiler validering kaster
   * UMIDDELBART (fail-fast) - delvis batch-innsetting for EN kildehenting
   * anses som mer overraskende enn nyttig i v1; en fremtidig slice kan
   * legge til en "best effort, samle feil"-modus HVIS et reelt behov
   * oppstår.
   */
  async ingestFromSource(
    tenantId: string,
    personId: string,
    source: HealthMetricSource,
    options: { sinceMs?: number } = {}
  ): Promise<HealthMetricObservation[]> {
    const inputs = await source.fetchRecent({ personId, ...(options.sinceMs !== undefined ? { sinceMs: options.sinceMs } : {}) });
    const written: HealthMetricObservation[] = [];
    for (const input of inputs) {
      written.push(await this.ingestObservation(tenantId, personId, input));
    }
    return written;
  }

  /**
   * Lese-API, health-space-scoped (RLS + strukturell CHECK, se
   * `049_health.sql`). `metricType`/`sinceMs` er valgfrie filtre - `sinceMs`
   * filtrerer på `observed_at` (hendelsestidspunktet, IKKE `recorded_at`).
   */
  async getRecentMetrics(
    tenantId: string,
    personId: string,
    metricType?: MetricType,
    sinceMs?: number
  ): Promise<HealthMetricObservation[]> {
    return withMemoryTransaction(this.pool, tenantId, ["health"], async (client) => {
      const conditions = ["tenant_id = $1", "person_id = $2"];
      const params: Array<string | number> = [tenantId, personId];
      if (metricType) {
        params.push(metricType);
        conditions.push(`metric_type = $${params.length}`);
      }
      if (sinceMs !== undefined) {
        params.push(new Date(sinceMs).toISOString());
        conditions.push(`observed_at >= $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT * FROM health_metric_observations WHERE ${conditions.join(" AND ")} ORDER BY observed_at DESC, seq DESC`,
        params
      );
      return rows as HealthMetricObservation[];
    });
  }

  /**
   * Reell retention-håndhevelse (§ byggeordren, akseptansekriterium D):
   * sletter KUN rader hvor `retention_expires_at` er satt OG faktisk er
   * passert - rader med `retention_expires_at IS NULL` (ingen policy
   * konfigurert da de ble skrevet) IKKE rørt, uansett alder (samme "ingen
   * automatisk sletting uten eksplisitt eier-konfigurert vindu"-prinsipp
   * som `049_health.sql` sin migrasjons-kommentar). Tenant-scoped (samme
   * `withMemoryTransaction`-mønster som resten av tjenesten) - se
   * SERVICE.md-rapporten for hvordan dette skal plansjeres på tvers av
   * tenants (`listBusinessTenantIds`-mønsteret i `@jarvis/core`, IKKE
   * bygget/koblet inn her).
   */
  async purgeExpiredObservations(tenantId: string): Promise<number> {
    return withMemoryTransaction(this.pool, tenantId, ["health"], async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM health_metric_observations WHERE tenant_id = $1 AND retention_expires_at IS NOT NULL AND retention_expires_at <= now()`,
        [tenantId]
      );
      return rowCount ?? 0;
    });
  }
}

import { createHash, randomUUID } from "node:crypto";
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
  type VisionRoom,
  type VisionWriteExtras
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
 * ARKITEKT-REVIEW-FIKS (PR #83, RUNDE 2, P1): kastet når en innsettingsforsøk
 * treffer `055_vision.sql` sin `vision_event_observations_source_dedupe_key`
 * (samme `(tenant, space, person, source_type, source_instance_id,
 * source_event_id)`), MEN den eksisterende raden sin `payload_fingerprint`
 * IKKE stemmer med den nye forsøkte payloaden - dvs. en NØKKEL-GJENBRUK
 * (samme kilde-hendelses-ID brukt for to FAKTISK ulike hendelser, en
 * kilde-bug, eller datakorrupsjon), IKKE en genuin replay av SAMME hendelse.
 * Fail-closed: raden overskrives ALDRI (append-only, se filhode), og
 * kalleren får ALDRI en stille "vellykket" retur av en ANNEN hendelse enn
 * den de faktisk sendte.
 */
export class VisionReplayConflictError extends Error {
  constructor(
    public readonly sourceType: string,
    public readonly sourceInstanceId: string,
    public readonly sourceEventId: string
  ) {
    super(
      `vision_replay_conflict:source_type=${sourceType}:source_instance_id=${sourceInstanceId}:source_event_id=${sourceEventId}:existing row has a different payload_fingerprint than this attempt`
    );
    this.name = "VisionReplayConflictError";
  }
}

/**
 * ARKITEKT-REVIEW-FIKS (PR #83, RUNDE 2, P1): deterministisk fingerprint av
 * de semantisk MENINGSFULLE payload-feltene til én hendelse (IKKE av
 * genererte/interne felter som `observation_id`/`recorded_at`/
 * `retention_expires_at`) - brukes UTELUKKENDE til å oppdage om en
 * `ON CONFLICT`-replay under SAMME dedupe-nøkkel faktisk er en gjentatt
 * levering av DEN SAMME hendelsen (fingerprint stemmer - trygg, deterministisk
 * replay) eller en nøkkel-kollisjon med en ANNEN, avvikende hendelse
 * (fingerprint stemmer IKKE - `VisionReplayConflictError`, se der). `null`
 * verdier normaliseres eksplisitt (`?? null`) FØR JSON-serialisering slik at
 * `undefined` og `null` aldri gir ulik fingerprint for samme semantiske innhold.
 */
function computePayloadFingerprint(value: VisionObservationInput): string {
  const canonical = JSON.stringify({
    event_type: value.event_type,
    room_id: value.room_id ?? null,
    object_label: value.object_label ?? null,
    confidence: value.confidence ?? null,
    observed_at: value.observed_at
  });
  return createHash("sha256").update(canonical).digest("hex");
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

/**
 * WP-G3 (D-465): standard oppbevaring av lagrede ØYEBLIKKSBILDER i fravær av `snapshot_retention_days`. KORTERE enn hendelsesvinduet:
 * et bilde er mer sensitivt enn det strukturerte resultatet («person_present i stua» vs. selve bildet av stua). Det effektive vinduet
 * er alltid `min(snapshot_retention_days ?? 7, retention_days)` - aldri lengre enn hendelsene. Utkast; eieren setter selv verdien.
 */
export const DEFAULT_SNAPSHOT_RETENTION_DAYS = 7;

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
    if (input.snapshot_retention_days !== undefined && (!Number.isInteger(input.snapshot_retention_days) || input.snapshot_retention_days <= 0)) {
      throw new VisionObservationValidationError("snapshot_retention_days", "must_be_positive_integer");
    }
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `INSERT INTO vision_retention_policies (tenant_id, memory_space_id, retention_days, snapshot_retention_days, actor_person_id, updated_at)
         VALUES ($1, $2, $3, $5, $4, now())
         ON CONFLICT (tenant_id, memory_space_id)
         DO UPDATE SET retention_days = EXCLUDED.retention_days, snapshot_retention_days = EXCLUDED.snapshot_retention_days,
                       actor_person_id = EXCLUDED.actor_person_id, updated_at = now()
         RETURNING *`,
        [tenantId, memorySpace, input.retention_days, input.actor_person_id ?? null, input.snapshot_retention_days ?? null]
      );
      return rows[0] as VisionRetentionPolicy;
    });
  }

  /** Hendelsesvinduet (dager) i kallerens transaksjon - public siden WP-G3 (pipeline.ts setter inventarets utløp fra samme vindu). */
  async retentionDaysInTransaction(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace): Promise<number> {
    const { rows } = await client.query(
      `SELECT retention_days FROM vision_retention_policies WHERE tenant_id = $1 AND memory_space_id = $2`,
      [tenantId, memorySpace]
    );
    return (rows[0] as { retention_days: number } | undefined)?.retention_days ?? DEFAULT_RETENTION_DAYS;
  }

  /** WP-G3: effektivt vindu for lagrede bilder = `min(snapshot_retention_days ?? 7, retention_days)` - aldri lengre enn hendelsene. */
  async snapshotRetentionDaysInTransaction(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace): Promise<number> {
    const { rows } = await client.query(
      `SELECT retention_days, snapshot_retention_days FROM vision_retention_policies WHERE tenant_id = $1 AND memory_space_id = $2`,
      [tenantId, memorySpace]
    );
    const row = rows[0] as { retention_days: number; snapshot_retention_days: number | null } | undefined;
    const eventDays = row?.retention_days ?? DEFAULT_RETENTION_DAYS;
    return Math.min(row?.snapshot_retention_days ?? DEFAULT_SNAPSHOT_RETENTION_DAYS, eventDays);
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
   * Fail-closed synkron validering (ALDRI en stille avvist/klippet verdi):
   * en ugyldig `event_type`/`confidence`-verdi utenfor [0,1] eller et
   * `observed_at` som ikke er et gyldig parsbart tidsstempel kaster en typet
   * `VisionObservationValidationError`. Et strukturelt ugyldig `room_id`
   * (rom finnes ikke / tilhører en annen person) avvises av `055_vision.sql`
   * sin sammensatte FK som en ekte Postgres-feil (`23503`) - INGEN duplisert
   * eksistens-sjekk her (samme "databasen er den strukturelle autoriteten"-
   * disiplin som resten av repoet). Bevisst UTEN databasetilgang - kalles
   * FØR noen transaksjon åpnes, både fra `ingestObservation()` OG
   * `ingestFromSource()` (se ARKITEKT-REVIEW-FIKS-kommentaren der).
   */
  private validate(input: VisionObservationInput): VisionObservationInput {
    const parsed = VisionObservationInputSchema.safeParse(input);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new VisionObservationValidationError(firstIssue?.path.join(".") || "input", firstIssue?.message ?? "schema_validation_failed");
    }
    const value = parsed.data;
    if (Number.isNaN(Date.parse(value.observed_at))) {
      throw new VisionObservationValidationError("observed_at", "not_a_valid_iso_datetime");
    }
    return value;
  }

  /**
   * Skriver ÉN allerede-VALIDERT hendelse i en GITT, allerede-åpnet
   * transaksjon - kalt fra BÅDE `ingestObservation()` (egen transaksjon per
   * kall) OG `ingestFromSource()` (HELE batchen i ÉN transaksjon, se der).
   *
   * ARKITEKT-REVIEW-FIKS (PR #83, RUNDE 1+2, 2026-09-15):
   *  1. **Idempotens (RUNDE 1).** `INSERT ... ON CONFLICT (tenant_id,
   *     memory_space_id, person_id, source_type, source_instance_id,
   *     source_event_id) DO NOTHING` mot `055_vision.sql` sin
   *     `vision_event_observations_source_dedupe_key` - en gjentatt
   *     levering av SAMME kilde-hendelse (overlappende poll-vindu,
   *     transport-retry, et tidligere-innsatt element i en batch som
   *     retries) skriver INGEN ny rad. Postgres sin EGEN
   *     `INSERT ... ON CONFLICT`-låsing gjør dette trygt også for EKTE
   *     SAMTIDIGE dupliserte leveranser (den tapende transaksjonen venter på
   *     vinnerens commit FØR den evaluerer konflikten).
   *  2. **Kollisjonsdomene inkluderer `source_instance_id` (RUNDE 2).**
   *     `source_instance_id` er PÅKREVD og MED i nøkkelen - to uavhengige
   *     enheter bak samme `source_type` kan IKKE lenger overskrive
   *     hverandres hendelser selv om de tilfeldigvis bruker samme lokale
   *     `event_id`.
   *  3. **Payload-verifisert replay (RUNDE 2).** Ved konflikt sammenlignes
   *     den eksisterende radens `payload_fingerprint` mot en FERSK beregnet
   *     fingerprint av DENNE forsøkte payloaden (`computePayloadFingerprint()`).
   *     Stemmer de: deterministisk replay, EKSISTERENDE rad returneres
   *     (samme "idempotent kall returnerer samme resultat"-kontrakt som
   *     resten av repoet). Stemmer de IKKE: en `VisionReplayConflictError`
   *     kastes - ALDRI en stille retur av en annen hendelse enn den som
   *     faktisk ble sendt (nøkkel-gjenbruk/korrupsjon feiler LUKKET).
   *  4. **Klokke-tillit (RUNDE 1).** `retention_expires_at` beregnes fra
   *     `now()` (databasens EGEN, BETRODDE mottakstid) i SAMME INSERT, IKKE
   *     fra det UBETRODDE, kilde-produserte `observed_at` - en
   *     feilkonfigurert eller ondsinnet kilde kan dermed IKKE omgå
   *     retensjonsvinduet med et tidsstempel langt inn i fremtiden.
   *     `observed_at` sin proveniens er UENDRET for alt annet
   *     (visning/filtrering/`getLastSeen`).
   */
  private async insertValidatedInTransaction(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    personId: string,
    value: VisionObservationInput,
    extras: VisionWriteExtras = {}
  ): Promise<VisionEventObservation> {
    return (await this.insertValidatedDetailed(client, tenantId, memorySpace, personId, value, extras)).observation;
  }

  /**
   * Som `insertValidatedInTransaction`, men forteller OM raden faktisk ble skrevet (`inserted: true`) eller var en deterministisk
   * replay av en eksisterende rad (`inserted: false`). Pipelinen (pipeline.ts) trenger skillet: en replay skal ikke lage nye
   * vektorer/inventaroppdateringer en gang til. `extras` (WP-G3, 133/134) er felt KUN trusted pipelinekode setter.
   */
  private async insertValidatedDetailed(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    personId: string,
    value: VisionObservationInput,
    extras: VisionWriteExtras = {}
  ): Promise<{ observation: VisionEventObservation; inserted: boolean }> {
    const retentionDays = await this.retentionDaysInTransaction(client, tenantId, memorySpace);
    const fingerprint = computePayloadFingerprint(value);
    const { rows } = await client.query(
      `INSERT INTO vision_event_observations
         (observation_id, tenant_id, memory_space_id, person_id, room_id, event_type, object_label, confidence, source_type, source_instance_id, source_event_id, payload_fingerprint, observed_at, retention_expires_at,
          snapshot_ref, task_id, session_id, classification_status, classifier)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() + ($14 || ' days')::interval, $15, $16, $17, $18, $19)
       ON CONFLICT (tenant_id, memory_space_id, person_id, source_type, source_instance_id, source_event_id) DO NOTHING
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
        value.source_type,
        value.source_instance_id,
        value.source_event_id,
        fingerprint,
        value.observed_at,
        retentionDays,
        extras.snapshot_ref ?? null,
        extras.task_id ?? null,
        extras.session_id ?? null,
        extras.classification_status ?? "not_applicable",
        extras.classifier ?? null
      ]
    );
    if (rows[0]) return { observation: rows[0] as VisionEventObservation, inserted: true };

    const existing = await client.query(
      `SELECT * FROM vision_event_observations
       WHERE tenant_id = $1 AND memory_space_id = $2 AND person_id = $3 AND source_type = $4 AND source_instance_id = $5 AND source_event_id = $6`,
      [tenantId, memorySpace, personId, value.source_type, value.source_instance_id, value.source_event_id]
    );
    const existingRow = existing.rows[0] as VisionEventObservation;
    if (existingRow.payload_fingerprint !== fingerprint) {
      throw new VisionReplayConflictError(value.source_type, value.source_instance_id, value.source_event_id);
    }
    return { observation: existingRow, inserted: false };
  }

  /**
   * WP-G3: skriver ÉN hendelse i en transaksjon KALLEREN eier (pipeline.ts skriver hendelser, bilde-peker, vektorer og inventar atomisk).
   * Samme validering og samme idempotente `ON CONFLICT`-skriving som `ingestObservation()` - aldri en parallell skrivevei.
   */
  async ingestWithinTransaction(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    personId: string,
    input: VisionObservationInput,
    extras: VisionWriteExtras = {}
  ): Promise<{ observation: VisionEventObservation; inserted: boolean }> {
    return this.insertValidatedDetailed(client, tenantId, memorySpace, personId, this.validate(input), extras);
  }

  /** WP-G3: eksisterende hendelse for en kilde-hendelse-nøkkel (idempotens-forhåndssjekk FØR bilde hentes og modellen kalles), eller `null`. */
  async findBySourceEvent(
    tenantId: string,
    memorySpace: MemorySpace,
    personId: string,
    key: { source_type: string; source_instance_id: string; source_event_id: string }
  ): Promise<VisionEventObservation | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM vision_event_observations
         WHERE tenant_id = $1 AND memory_space_id = $2 AND person_id = $3 AND source_type = $4 AND source_instance_id = $5 AND source_event_id = $6`,
        [tenantId, memorySpace, personId, key.source_type, key.source_instance_id, key.source_event_id]
      );
      return (rows[0] as VisionEventObservation | undefined) ?? null;
    });
  }

  /** Validerer OG skriver ÉN ny hendelse, i sin egen transaksjon. Se `validate()`/`insertValidatedInTransaction()` for den delte logikken med `ingestFromSource()`. */
  async ingestObservation(
    tenantId: string,
    memorySpace: MemorySpace,
    personId: string,
    input: VisionObservationInput,
    extras: VisionWriteExtras = {}
  ): Promise<VisionEventObservation> {
    const value = this.validate(input);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) =>
      this.insertValidatedInTransaction(client, tenantId, memorySpace, personId, value, extras)
    );
  }

  /**
   * Provider-nøytral komposisjons-metode (samme mønster som
   * `HealthService.ingestFromSource()`): henter hendelser fra EN GITT
   * `VisionEventSource`-adapter (ekte fremtidig adapter ELLER
   * `FakeVisionEventSource` i tester) og validerer + skriver dem via
   * `insertValidatedInTransaction()` - ALDRI en egen, parallell skrivevei.
   *
   * ARKITEKT-REVIEW-FIKS (PR #83, P1, 2026-09-15): HELE den innhentede
   * batchen valideres FØRST (utenfor enhver transaksjon - `validate()` gjør
   * INGEN databasekall), FØR noen INSERT overhodet kjøres, OG skrives
   * DERETTER i ÉN DELT transaksjon. En `[gyldig, ugyldig]`-batch kaster derfor
   * FØR databasen i det hele tatt er rørt - INGEN delvis committet prefiks
   * som en retry ville duplisert. En etterfølgende retry av HELE batchen
   * (etter at kildens feil er rettet, eller ved en identisk re-poll) er trygg
   * takket være `insertValidatedInTransaction()` sin idempotente
   * `source_event_id`-dedupe: allerede skrevne elementer skriver ingen ny
   * rad, kun genuint nye elementer legges til.
   */
  async ingestFromSource(
    tenantId: string,
    memorySpace: MemorySpace,
    personId: string,
    source: VisionEventSource,
    options: { sinceMs?: number } = {}
  ): Promise<VisionEventObservation[]> {
    const inputs = await source.fetchRecent({ personId, ...(options.sinceMs !== undefined ? { sinceMs: options.sinceMs } : {}) });
    const validated = inputs.map((input) => this.validate(input));
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const written: VisionEventObservation[] = [];
      for (const value of validated) {
        written.push(await this.insertValidatedInTransaction(client, tenantId, memorySpace, personId, value));
      }
      return written;
    });
  }

  /**
   * Lese-API, vision-space-scoped (RLS + eksplisitt `memorySpace`-argument, samme "aldri et blankt gi-meg-alt-kall"-disiplin som `@jarvis/location`).
   * WP-G4 (B-LOW-6): valgfri `limit` (de NYESTE `limit` radene) - uten den er oppførselen uendret (ingen LIMIT) for alle eksisterende kallere; situasjonsløperen setter alltid et tak.
   */
  async getRecentEvents(
    tenantId: string,
    memorySpace: MemorySpace,
    personId: string,
    filter: { eventType?: string; roomId?: string; sinceMs?: number; limit?: number } = {}
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
      let limitClause = "";
      if (filter.limit !== undefined && Number.isFinite(filter.limit)) {
        params.push(Math.max(1, Math.floor(filter.limit)));
        limitClause = ` LIMIT $${params.length}`;
      }
      const { rows } = await client.query(
        `SELECT * FROM vision_event_observations WHERE ${conditions.join(" AND ")} ORDER BY observed_at DESC${limitClause}`,
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

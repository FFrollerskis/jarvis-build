import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { writeVisionAudit, type VisionChangeProvenance } from "./audit.ts";
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

/** Det effektive bildevinduet: `min(snapshot_retention_days ?? 7, retention_days)` - aldri lengre enn hendelsene. Én definisjon for skriving (`snapshotRetentionDaysInTransaction`) og for visning (`describeRetention`). */
export function effectiveSnapshotRetentionDays(retentionDays: number, snapshotRetentionDays: number | null | undefined): number {
  return Math.min(snapshotRetentionDays ?? DEFAULT_SNAPSHOT_RETENTION_DAYS, retentionDays);
}

// ---------------------------------------------------------------------
// WP-G3b (D-485), K1: eierens retensjonsrute (`/vision/retention/get|set`, apps/api/src/vision-routes.ts)
// ---------------------------------------------------------------------
//
// Grensene gjelder KUN det eieren kan sette gjennom ruten (`parseRetentionRequest`/`applyRetentionPolicy`); `setRetentionPolicy` under er uendret (databasen krever bare > 0).
//  - Nedre grense 1 dag (databasens CHECK er > 0).
//  - Hendelsesvinduet maks 365 dager: «fravær av konfigurasjon betyr aldri behold for alltid» gjelder også en konfigurasjon - en vilkårlig lang verdi (30 år) er i praksis «for alltid» for rader som viser tilstedeværelse og aktivitet.
//  - Bildevinduet maks 90 dager (og aldri lengre enn hendelsesvinduet): et bilde er mer sensitivt enn det strukturerte resultatet, og lagringstaket (`JARVIS_VISION_MAX_STORED_MB`, standard 2 GiB per space) gjør lengre vinduer uansett
//    ubrukelige - når taket er nådd lagres ikke nye bilder.
// Å heve en grense er en kodeendring med en beslutning (D-41 gjelder kapabilitet, ikke fravær av validering).
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;
export const MAX_SNAPSHOT_RETENTION_DAYS = 90;

/** Det eieren ser: kun dager og tidspunkt - aldri `tenant_id`, `actor_person_id` eller andre kolonner fra raden. */
export interface VisionRetentionView {
  /** `false` = ingen rad for dette spacet: standardvinduene (30 og 7 dager) gjelder. */
  configured: boolean;
  /** Hendelsesvinduet (konfigurert eller standard). */
  retention_days: number;
  /** Konfigurert bildevindu; `null` = standard (7 dager, aldri lengre enn hendelsesvinduet). */
  snapshot_retention_days: number | null;
  /** Det bildevinduet som faktisk brukes ved neste lagring. */
  effective_snapshot_retention_days: number;
  updated_at: string | null;
}

export function describeRetention(row: { retention_days: number; snapshot_retention_days: number | null; updated_at?: unknown } | null): VisionRetentionView {
  const retention = row?.retention_days ?? DEFAULT_RETENTION_DAYS;
  const snapshot = row?.snapshot_retention_days ?? null;
  const at = row === null || row.updated_at === undefined || row.updated_at === null ? Number.NaN : new Date(row.updated_at as string | number | Date).getTime();
  return {
    configured: row !== null,
    retention_days: retention,
    snapshot_retention_days: snapshot,
    effective_snapshot_retention_days: effectiveSnapshotRetentionDays(retention, snapshot),
    updated_at: Number.isNaN(at) ? null : new Date(at).toISOString()
  };
}

export interface VisionRetentionRequest {
  retention_days: number;
  snapshot_retention_days: number | null;
}

function boundedDays(field: "retention_days" | "snapshot_retention_days", value: unknown, max: number): number {
  if (value === undefined) throw new VisionObservationValidationError(field, "required");
  if (typeof value !== "number" || !Number.isInteger(value)) throw new VisionObservationValidationError(field, "not_integer");
  if (value < MIN_RETENTION_DAYS) throw new VisionObservationValidationError(field, "below_min");
  if (value > max) throw new VisionObservationValidationError(field, "above_max");
  return value;
}

/**
 * Ren validering av eierens forespørsel (stabile `detail`-koder, aldri frie tekster): begge feltene MÅ oppgis (PUT med absolutte verdier - ingenting nullstilles stille av et utelatt felt), `snapshot_retention_days: null` betyr eksplisitt
 * «standard». Heltall 1..365 / 1..90, og et oppgitt bildevindu er aldri lengre enn hendelsesvinduet (`exceeds_retention_days`) - ingen stille klemming.
 */
export function parseRetentionRequest(input: { retention_days?: unknown; snapshot_retention_days?: unknown }): VisionRetentionRequest {
  const retention = boundedDays("retention_days", input.retention_days, MAX_RETENTION_DAYS);
  const snapshot = input.snapshot_retention_days === null ? null : boundedDays("snapshot_retention_days", input.snapshot_retention_days, MAX_SNAPSHOT_RETENTION_DAYS);
  if (snapshot !== null && snapshot > retention) throw new VisionObservationValidationError("snapshot_retention_days", "exceeds_retention_days");
  return { retention_days: retention, snapshot_retention_days: snapshot };
}

export interface RetentionShortening {
  retention_days: boolean;
  snapshot_retention_days: boolean;
}

/**
 * WP-G3b fiks-runde 1 (F1): det EFFEKTIVE vinduet (dager) AVLEDEDE data følger ved sveip, som funksjon av `retention_days` i `vision_retention_policies` (`null` = ingen rad for dette spacet). Avledede data = signalsituasjoner i domenet `vision`
 * (G4, kun med JARVIS_SITUATION_SIGNALS=on), som ryddes mot `min(grunnvindu, retention_days)` ved hvert sveip - ikke forankret ved skriving som tabellene. Funksjonen leveres av kjøretiden (main.ts, fra G4-konfigurasjonen); tjenesten kjenner
 * verken G4 eller miljøvariabler.
 */
export type DerivedWindowDays = (retentionDays: number | null) => number;

/** Hvilke EKSISTERENDE (allerede lagrede) data en forkorting kan fjerne, utover det som gjelder nye rader: stabile koder, aldri fri tekst. */
export type RetentionAffectsExisting = "signal_situations";

/**
 * Blir det AVLEDEDE vinduet kortere? `derived(ny hendelsesvindu) < derived(gjeldende rad, eller `null` uten rad)` - uten rad gjelder grunnvinduet selv, så en første setting under grunnvinduet er en forkorting også når den er lengre enn
 * standarden (30). Uten funksjon (signalbryteren AV) finnes ingen avledede data å beskytte: alltid `false`.
 */
export function derivedWindowShortened(previous: VisionRetentionView, next: VisionRetentionRequest, derivedWindowDays: DerivedWindowDays | undefined): boolean {
  if (derivedWindowDays === undefined) return false;
  return derivedWindowDays(next.retention_days) < derivedWindowDays(previous.configured ? previous.retention_days : null);
}

/**
 * Blir noen av de EFFEKTIVE vinduene kortere enn de gjeldende (konfigurert eller standard)? Sammenlignes på effektive verdier, så en forkortet `retention_days` som klemmer bildevinduet også teller som forkorting av bildene.
 * `retention_days` teller også som forkortet når det AVLEDEDE vinduet blir kortere (`derivedWindowDays`, se `derivedWindowShortened`) - uten den funksjonen (standard) gjelder kun de effektive vinduene for nye rader.
 */
export function retentionShortening(previous: VisionRetentionView, next: VisionRetentionRequest, derivedWindowDays?: DerivedWindowDays): RetentionShortening {
  return {
    retention_days: next.retention_days < previous.retention_days || derivedWindowShortened(previous, next, derivedWindowDays),
    snapshot_retention_days: effectiveSnapshotRetentionDays(next.retention_days, next.snapshot_retention_days) < previous.effective_snapshot_retention_days
  };
}

/**
 * En forkorting kom uten bekreftelse. Kastes INNE i den låste transaksjonen FØR noe skrives; ruten gjør den til 409 `confirmation_required`. `affectsExisting` = hvilke EKSISTERENDE data en bekreftet forkorting kan fjerne
 * (`signal_situations`: avledede signalsituasjoner eldre enn det nye vinduet, også åpne og `security_alert`); tom = kun nye rader berøres.
 */
export class VisionRetentionConfirmationRequiredError extends Error {
  constructor(public readonly shortened: ReadonlyArray<"retention_days" | "snapshot_retention_days">, public readonly affectsExisting: ReadonlyArray<RetentionAffectsExisting> = []) {
    super(`vision_retention_confirmation_required:${shortened.join(",")}`);
    this.name = "VisionRetentionConfirmationRequiredError";
  }
}

export interface ApplyRetentionOptions extends VisionChangeProvenance {
  /** Personen som setter vinduet (grantets person): lagres som `actor_person_id` og er aktør i revisjonsraden. */
  actor_person_id: string;
  /** `true` = eieren har bekreftet en FORKORTING (den typede bekreftelsen sjekkes av kalleren, ruten). Uten den kastes `VisionRetentionConfirmationRequiredError` ved en forkorting. */
  confirm_shortening?: boolean | undefined;
  /**
   * WP-G3b fiks-runde 1 (F1): det effektive vinduet AVLEDEDE data følger (G4-signalsituasjoner i domenet `vision`), satt av kjøretiden KUN når signalbryteren er på. Utelatt = ingen avledede data å beskytte: da gjelder kun de effektive
   * vinduene for nye rader (uendret oppførsel). Satt: en endring som gjør det avledede vinduet kortere regnes som forkorting av `retention_days` og krever den typede bekreftelsen, evaluert mot raden som faktisk overskrives (inne i låsen).
   */
  derived_window_days?: DerivedWindowDays | undefined;
}

export interface VisionRetentionChange {
  /** `false` = forespørselen er allerede gjeldende tilstand (gjenspilling): ingenting skrevet, ingen revisjonsrad. */
  changed: boolean;
  shortened: RetentionShortening;
  previous: VisionRetentionView;
  current: VisionRetentionView;
}

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
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], (client) =>
      this.upsertRetention(client, tenantId, memorySpace, { retention_days: input.retention_days, snapshot_retention_days: input.snapshot_retention_days ?? null, actor_person_id: input.actor_person_id ?? null })
    );
  }

  /** Selve upserten (felles for `setRetentionPolicy` og `applyRetentionPolicy`): full erstatning av begge vinduene, `NULL` = standard bildevindu. Kallerens transaksjon. */
  private async upsertRetention(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    value: { retention_days: number; snapshot_retention_days: number | null; actor_person_id: string | null }
  ): Promise<VisionRetentionPolicy> {
    const { rows } = await client.query(
      `INSERT INTO vision_retention_policies (tenant_id, memory_space_id, retention_days, snapshot_retention_days, actor_person_id, updated_at)
       VALUES ($1, $2, $3, $5, $4, now())
       ON CONFLICT (tenant_id, memory_space_id)
       DO UPDATE SET retention_days = EXCLUDED.retention_days, snapshot_retention_days = EXCLUDED.snapshot_retention_days,
                     actor_person_id = EXCLUDED.actor_person_id, updated_at = now()
       RETURNING *`,
      [tenantId, memorySpace, value.retention_days, value.actor_person_id, value.snapshot_retention_days]
    );
    return rows[0] as VisionRetentionPolicy;
  }

  /** WP-G3b: det eieren ser (kun dager og tidspunkt) for ett (tenant, space) - standardvinduene når det ikke finnes en rad. Bruker den eksisterende lesingen `getRetentionPolicy`. */
  async getRetentionView(tenantId: string, memorySpace: MemorySpace): Promise<VisionRetentionView> {
    return describeRetention(await this.getRetentionPolicy(tenantId, memorySpace));
  }

  /**
   * WP-G3b (D-485), K1: eierens SETTING av vinduene. Alt skjer i ÉN transaksjon under en advisory-lås per (tenant, space), slik at to samtidige forespørsler serialiseres og «forkorting?» avgjøres mot den tilstanden som faktisk
   * overskrives (ingen sjekk-så-skriv-glipp):
   *  1. validering (`parseRetentionRequest`, stabile koder) FØR noe leses;
   *  2. IDEMPOTENS: er forespørselen allerede gjeldende rad, gjøres ingenting (`changed: false`, ingen skriving, ingen revisjonsrad) - en gjenspilling er ufarlig og en omkringflytende kopi av samme forespørsel støyer ikke i revisjonen;
   *  3. en FORKORTING (effektivt hendelses- eller bildevindu blir kortere, eller - med `derived_window_days` - det AVLEDEDE G4-vinduet, se `retentionShortening`) krever `confirm_shortening` - ellers kastes `VisionRetentionConfirmationRequiredError` og ingenting skrives;
   *  4. upsert via samme SQL som `setRetentionPolicy` + revisjonsrad (`vision.retention_set`, kun tall/enums) i SAMME transaksjon (`audit: true`): en endring uten revisjonsrad kan ikke committes.
   * Vinduene er FORANKRET VED SKRIVING (`retention_expires_at` settes ved innsetting): en endring gjelder rader som skrives ETTER den, og sletter ikke eksisterende hendelser, bilder eller inventar (bevist av TRIPWIRE-testen i g3b-retention.test.ts).
   * UNNTAK (en egen, avledet tabell): signalsituasjoner i domenet `vision` (G4) ryddes ved sveipet mot `min(grunnvindu, retention_days)`, så en forkorting kan fjerne EKSISTERENDE avledede situasjoner - derfor `derived_window_days`.
   */
  async applyRetentionPolicy(tenantId: string, memorySpace: MemorySpace, input: { retention_days?: unknown; snapshot_retention_days?: unknown }, options: ApplyRetentionOptions): Promise<VisionRetentionChange> {
    const next = parseRetentionRequest(input);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`vision-retention:${tenantId}:${memorySpace}`]);
      const found = await client.query(
        `SELECT retention_days, snapshot_retention_days, updated_at FROM vision_retention_policies WHERE tenant_id = $1 AND memory_space_id = $2`,
        [tenantId, memorySpace]
      );
      const row = found.rows[0] as { retention_days: number; snapshot_retention_days: number | null; updated_at: unknown } | undefined;
      const previous = describeRetention(row ?? null);
      if (row !== undefined && row.retention_days === next.retention_days && row.snapshot_retention_days === next.snapshot_retention_days) {
        return { changed: false, shortened: { retention_days: false, snapshot_retention_days: false }, previous, current: previous };
      }
      const shortened = retentionShortening(previous, next, options.derived_window_days);
      const shortenedFields = (["retention_days", "snapshot_retention_days"] as const).filter((field) => shortened[field]);
      const affectsExisting: RetentionAffectsExisting[] = derivedWindowShortened(previous, next, options.derived_window_days) ? ["signal_situations"] : [];
      if (shortenedFields.length > 0 && options.confirm_shortening !== true) throw new VisionRetentionConfirmationRequiredError(shortenedFields, affectsExisting);
      const saved = await this.upsertRetention(client, tenantId, memorySpace, { ...next, actor_person_id: options.actor_person_id });
      const current = describeRetention(saved);
      await writeVisionAudit(client, tenantId, options.actor_person_id, options, {
        type: "vision.retention_set", action: "retention_set",
        payload: {
          memory_space: memorySpace, previous_configured: previous.configured,
          previous_retention_days: previous.retention_days, previous_snapshot_retention_days: previous.snapshot_retention_days,
          retention_days: current.retention_days, snapshot_retention_days: current.snapshot_retention_days,
          effective_snapshot_retention_days: current.effective_snapshot_retention_days,
          shortened: shortenedFields, confirmed: shortenedFields.length > 0,
          ...(affectsExisting.length > 0 ? { affects_existing: affectsExisting } : {})
        }
      });
      return { changed: true, shortened, previous, current };
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
    return effectiveSnapshotRetentionDays(row?.retention_days ?? DEFAULT_RETENTION_DAYS, row?.snapshot_retention_days);
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

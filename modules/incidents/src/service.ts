import { createHash, randomUUID } from "node:crypto";
import { redactSecrets } from "./redact.ts";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import { writeAudit } from "@jarvis/core";
import type { MemorySpace } from "@jarvis/contracts";
import { assertValidIncidentTransition, isTerminalIncidentStatus } from "./state-machine.ts";
import { assertCanVerify, initialEvidenceStatus } from "./truth.ts";
import {
  PRODUCER_LIMITS,
  type AddEvidenceInput,
  type CreateIncidentInput,
  type EvidenceAssertedBy,
  type EvidenceSourceType,
  type EvidenceStatus,
  type EvidenceVerifiedBy,
  type IncidentActor,
  type IncidentEvidence,
  type IncidentFact,
  type IncidentRecord,
  type IncidentSeverity,
  type IncidentSourceKind,
  type IncidentStatus,
  type IncidentTransition,
  type OpenFromFactResult,
  type TransitionOptions
} from "./types.ts";

/**
 * D-104 Part A/B: hendelses-/bevis-LAGRINGEN. Selve deploy-korrelasjonen bor i
 * `correlation.ts`; hendelse->testet-fiks-orkestrering i `repair.ts`;
 * before/after/recovery i `recovery.ts` - denne filen eier KUN selve
 * hendelses-/bevis-lagringen.
 *
 * WP-E1 (JARVIS-068): livssyklusen har VARIG overgangshistorikk (`incident_transitions`, migrasjon 096) - `transition()` er den ENESTE veien til en statusendring
 * (den gamle `setStatus()` uten årsak/aktør er fjernet), og en utsatt DB-trigger gjør en statusendring uten overgangsrad umulig også med rå SQL. Bevis følger
 * sannhetstype-regimet (`truth.ts`/migrasjon 097): ingen avsender kan sette VERIFIED selv. Produsentene (`producers/`) åpner hendelser KUN via `openFromFact()`
 * (dedupe på fingeravtrykk, gjenåpning ved regresjon, demping etter eierens «ikke fiks», tak mot oversvømmelse) og løser KUN via `resolveByCheck()` (nytt VERIFIED bevis fra
 * en deterministisk re-måling av kilden, i samme transaksjon som overgangen).
 */
const MAX_REASON = 500;
const MAX_SUMMARY = 2000;
const MAX_TITLE = 300;
const MAX_REF = 200;
const MAX_SUBJECT = 120;

const SEVERITY_RANK: Readonly<Record<IncidentSeverity, number>> = { low: 0, normal: 1, high: 2, critical: 3 };

function cleanReason(reason: string): string {
  const cleaned = redactSecrets(String(reason ?? "")).trim().slice(0, MAX_REASON);
  if (cleaned.length === 0) throw new Error("incident_transition_reason_required");
  return cleaned;
}

function actorPerson(actor: IncidentActor): string | null {
  return actor.kind === "owner" ? actor.person_id : null;
}

/** Saner et emne til en trygg identifikator (aldri innhold): kun `[A-Za-z0-9._:/@#+-]`, resten blir `_`, maks 120 tegn. */
export function sanitizeIncidentSubject(subject: string): string {
  const cleaned = String(subject ?? "").replace(/[^A-Za-z0-9._:/@#+-]/g, "_").slice(0, MAX_SUBJECT);
  if (cleaned.length === 0) throw new Error("incident_fact_subject_required");
  return cleaned;
}

/** Fingeravtrykket for «samme fakta»: `<kilde>:<emne>` (aldri innhold). */
export function incidentDedupeKey(sourceKind: Exclude<IncidentSourceKind, "manual">, subject: string): string {
  return `${sourceKind}:${sanitizeIncidentSubject(subject)}`;
}

/** Deterministisk korrelasjons-id (`corr-` + 16 hex) fra tenant + fingeravtrykk - stabil over tid, avslører ikke nøkkelen. */
export function incidentCorrelationId(tenantId: string, dedupeKey: string): string {
  return `corr-${createHash("sha256").update(`${tenantId}\u0000${dedupeKey}`).digest("hex").slice(0, 16)}`;
}

function isoOrNow(value: string): string {
  return Number.isNaN(Date.parse(value)) ? new Date().toISOString() : new Date(value).toISOString();
}

export interface ResolveByCheckInput {
  source_type: EvidenceSourceType;
  source_ref?: string;
  /** Hva den deterministiske re-målingen så (kort, redigert). */
  summary: string;
  observed_at: string;
  /**
   * Gjennomgang av PR #324 (L3): `VERIFIED` (standard) = en deterministisk re-måling bekrefter at betingelsen er borte, og `verified_by` + `basis` er PÅKREVD. `PROVISIONAL` = KILDEN SELV sier at betingelsen er borte
   * (en ekstern påstand, f.eks. Sentry-status «resolved», som er en menneskelig/leverandør-handling og ikke en Jarvis-måling): hendelsen lukkes, men beviset forblir PROVISIONAL («observert, ikke bekreftet») -
   * `verified_by`/`basis` skal da IKKE oppgis (ingen halvt fylt verifisering).
   */
  confirmation?: "VERIFIED" | "PROVISIONAL";
  /** Hvorfor re-målingen teller som bekreftelse: `source_recheck` (samme primærkilde målt på nytt) eller `independent_probe` (uavhengig kilde). Påkrevd for `VERIFIED`. */
  verified_by?: Extract<EvidenceVerifiedBy, "source_recheck" | "independent_probe">;
  /** Grunnlaget som lagres med VERIFIED-statusen (≤ 300 tegn). Påkrevd for `VERIFIED`. */
  basis?: string;
  /** Årsaken i overgangshistorikken. */
  reason: string;
}

export class IncidentService {
  constructor(private readonly pool: pg.Pool) {}

  async createIncident(tenantId: string, memorySpace: MemorySpace, input: CreateIncidentInput): Promise<IncidentRecord> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const incident_id = `inc-${randomUUID()}`;
      const title = redactSecrets(input.title).trim().slice(0, MAX_TITLE);
      if (title.length === 0) throw new Error("incident_title_required");
      const { rows } = await client.query(
        `INSERT INTO incidents (incident_id, tenant_id, memory_space_id, title, severity, owner_person_id, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING *`,
        [incident_id, tenantId, memorySpace, title, input.severity ?? "normal", input.owner_person_id ?? null]
      );
      const incident = rows[0] as IncidentRecord;
      // Opprettelsesraden (fra-status = null) - en manuell hendelse har eieren som aktør når den er kjent, ellers systemet.
      const actor: IncidentActor = input.owner_person_id ? { kind: "owner", person_id: input.owner_person_id } : { kind: "system" };
      await this.insertTransition(client, incident, null, "open", actor, "opprettet manuelt", undefined);
      await this.audit(client, incident, actor, "incident.opened", { incident_id, source_kind: "manual", severity: incident.severity });
      return incident;
    });
  }

  async getIncident(tenantId: string, memorySpace: MemorySpace, incidentId: string): Promise<IncidentRecord | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM incidents WHERE tenant_id = $1 AND incident_id = $2`, [tenantId, incidentId]);
      return (rows[0] as IncidentRecord) ?? null;
    });
  }

  async listIncidents(tenantId: string, memorySpace: MemorySpace, status: IncidentStatus | "all" = "open"): Promise<IncidentRecord[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } =
        status === "all"
          ? await client.query(`SELECT * FROM incidents WHERE tenant_id = $1 ORDER BY opened_at DESC`, [tenantId])
          : await client.query(`SELECT * FROM incidents WHERE tenant_id = $1 AND status = $2 ORDER BY opened_at DESC`, [tenantId, status]);
      return rows as IncidentRecord[];
    });
  }

  /** WP-E1: aktive (ikke løste/lukkede) hendelser åpnet av én produsent - produsenten re-måler akkurat disse. */
  async listActiveBySource(tenantId: string, memorySpace: MemorySpace, sourceKind: Exclude<IncidentSourceKind, "manual">): Promise<IncidentRecord[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM incidents WHERE tenant_id = $1 AND source_kind = $2 AND status NOT IN ('resolved', 'wont_fix') ORDER BY opened_at ASC`,
        [tenantId, sourceKind]
      );
      return rows as IncidentRecord[];
    });
  }

  /**
   * WP-E1: den ENESTE veien til en statusendring. Tilstandsmaskinen (`state-machine.ts`) avgjør lovlighet deterministisk - en ugyldig overgang kaster og endrer INGENTING.
   * Hver endring skrives i SAMME transaksjon som `incident_transitions`-raden (hvem, når, hvorfor, hvilket bevis) og en revisjonsrad; en utsatt DB-trigger avviser enhver
   * statusendring uten overgangsrad. `reason` er PÅKREVD. Samme status som i dag er et idempotent no-op (ingen rad, ingen revisjon).
   *
   * Aktør-regler (håndheves her, ikke i en prompt):
   *  - `owner` må bære personen og kan gjøre enhver lovlig overgang.
   *  - `producer` kan kun (a) LØSE en egen (ikke-manuell) hendelse med en `evidence_ref` som peker på et VERIFIED bevis for SAMME hendelse (betingelsen er bekreftet borte - ikke bare
   *    «ikke sett i dag»), og (b) GJENÅPNE en løst hendelse (regresjon). Aldri en manuell hendelse, aldri «lukk uten tiltak» (`wont_fix` er en eierbeslutning) og aldri gjenåpne en
   *    hendelse eieren har lukket.
   *  - `repair` (reparasjonsflyten) kan kun foreslå tiltak (`repair_proposed`).
   *  - `system` er ikke tillatt her (kun opprettelses-/bakfyllsraden skrives av systemet).
   */
  async transition(
    tenantId: string,
    memorySpace: MemorySpace,
    incidentId: string,
    to: IncidentStatus,
    actor: IncidentActor,
    options: TransitionOptions
  ): Promise<IncidentRecord | null> {
    const reason = cleanReason(options.reason);
    const evidenceRef = options.evidence_ref === undefined ? undefined : redactSecrets(options.evidence_ref).slice(0, MAX_REF);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.lockIncident(client, tenantId, incidentId);
      if (!current) return null;
      return this.transitionTx(client, current, to, actor, reason, evidenceRef);
    });
  }

  /** Overgangshistorikken, eldste først. */
  async listTransitions(tenantId: string, memorySpace: MemorySpace, incidentId: string): Promise<IncidentTransition[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT transition_id, tenant_id, memory_space_id, incident_id, from_status, to_status, actor_kind, actor_person_id, reason, evidence_ref, occurred_at
           FROM incident_transitions WHERE tenant_id = $1 AND incident_id = $2 ORDER BY occurred_at, transition_id`,
        [tenantId, incidentId]
      );
      return rows as IncidentTransition[];
    });
  }

  /**
   * D-104 Part B: bevis legges ALLTID til, ALDRI overskrevet - selv når det
   * eksplisitt MOTSIER et tidligere bevis (`contradicts_evidence_id`).
   * WP-E1: `status` følger sannhetstype-regimet (`truth.ts`) - standard `UNVERIFIED` for eier, `PROVISIONAL` for produsent/kontroll, alltid `UNVERIFIED` for modell;
   * `VERIFIED` kan IKKE oppgis her (kastes). Forfremmelse skjer kun gjennom `verifyEvidence()` med et deterministisk grunnlag.
   */
  async addEvidence(tenantId: string, memorySpace: MemorySpace, incidentId: string, input: AddEvidenceInput): Promise<IncidentEvidence> {
    const assertedBy = input.asserted_by ?? "owner";
    const status = initialEvidenceStatus(assertedBy, input.status);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.lockIncident(client, tenantId, incidentId);
      if (!current) throw new Error("incident_not_found");
      return this.insertEvidence(client, current, assertedBy, status, input);
    });
  }

  async listEvidence(tenantId: string, memorySpace: MemorySpace, incidentId: string): Promise<IncidentEvidence[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM incident_evidence WHERE tenant_id = $1 AND incident_id = $2 ORDER BY observed_at ASC`,
        [tenantId, incidentId]
      );
      return rows as IncidentEvidence[];
    });
  }

  /**
   * WP-E1: ENESTE vei til VERIFIED. Kalles av deterministiske kontroller (deployment-treff i `correlation.ts`, en produsents gjentatte måling `source_recheck`, en uavhengig probe) -
   * aldri av en HTTP-rute med et klientoppgitt grunnlag. Grunnlaget (`basis`, ≤ 300 tegn, redigert) lagres med statusen. Idempotent: et allerede VERIFIED bevis er endelig og returneres
   * uendret. Modellskrevet bevis kan aldri forfremmes.
   */
  async verifyEvidence(
    tenantId: string,
    memorySpace: MemorySpace,
    evidenceId: string,
    verification: { verified_by: EvidenceVerifiedBy; basis: string }
  ): Promise<IncidentEvidence | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], (client) => this.verifyEvidenceTx(client, tenantId, evidenceId, verification));
  }

  /**
   * WP-E1: en PRODUSENT åpner (eller oppdaterer) en hendelse fra et deterministisk faktum. Atomisk (én transaksjon, serialisert per fingeravtrykk med en advisory-lås, så api og worker
   * aldri lager to aktive hendelser for samme fakta - den delvise unike indeksen er siste skanse):
   *  1. Aktiv hendelse med samme fingeravtrykk finnes -> `updated` (antall/sist sett, alvorlighet kun OPP, nytt bevis hvis det skiller seg fra forrige - bevismengden er tak-begrenset).
   *  2. Nylig LØST (innen `reopen_window_hours`) -> `reopened` (regresjon, ny overgangsrad). Eldre løst -> ny hendelse (samme korrelasjons-id binder historikken).
   *  3. Eieren har nylig lukket den uten tiltak (`owner_mute_days`) -> `suppressed` (kun telleren øker; vinduet forlenges ikke).
   *  4. Taket for aktive hendelser per produsent er nådd -> `suppressed` (en støyende kilde kan ikke fylle tabellen).
   *  5. Ellers -> `opened`, med opprettelsesrad, første bevis og revisjon.
   * Beviset er alltid `asserted_by = producer` og aldri VERIFIED (`PROVISIONAL`, eller `UNVERIFIED` for en ekstern kildes påstand).
   */
  async openFromFact(tenantId: string, memorySpace: MemorySpace, fact: IncidentFact): Promise<OpenFromFactResult> {
    const dedupeKey = incidentDedupeKey(fact.source_kind, fact.subject);
    const correlationId = incidentCorrelationId(tenantId, dedupeKey);
    const title = redactSecrets(fact.title).trim().slice(0, MAX_TITLE);
    if (title.length === 0) throw new Error("incident_title_required");
    const evidenceStatus = initialEvidenceStatus("producer", fact.evidence.status);
    const actor: IncidentActor = { kind: "producer" };
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client): Promise<OpenFromFactResult> => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [JSON.stringify(["incident-fingerprint", tenantId, memorySpace, dedupeKey])]);
      const evidenceInput: AddEvidenceInput = {
        source_type: fact.evidence.source_type,
        ...(fact.evidence.source_ref !== undefined ? { source_ref: fact.evidence.source_ref } : {}),
        summary: fact.evidence.summary,
        observed_at: isoOrNow(fact.observed_at)
      };

      const active = await client.query(
        `SELECT * FROM incidents WHERE tenant_id = $1 AND memory_space_id = $2 AND dedupe_key = $3 AND status NOT IN ('resolved', 'wont_fix') FOR UPDATE`,
        [tenantId, memorySpace, dedupeKey]
      );
      if (active.rows[0]) {
        const current = active.rows[0] as IncidentRecord;
        const updated = await this.bumpOccurrence(client, current, fact.severity, true);
        await this.appendProducerEvidence(client, updated, evidenceStatus, evidenceInput);
        return { action: "updated", incident: updated };
      }

      const terminal = await client.query(
        `SELECT * FROM incidents WHERE tenant_id = $1 AND memory_space_id = $2 AND dedupe_key = $3 AND status IN ('resolved', 'wont_fix')
          ORDER BY updated_at DESC, incident_id DESC LIMIT 1 FOR UPDATE`,
        [tenantId, memorySpace, dedupeKey]
      );
      const last = terminal.rows[0] as IncidentRecord | undefined;
      if (last) {
        const windows = await client.query(
          `SELECT ($1::timestamptz > now() - make_interval(hours => $2::int)) AS within_reopen, ($1::timestamptz > now() - make_interval(days => $3::int)) AS within_mute`,
          [last.updated_at, PRODUCER_LIMITS.reopen_window_hours, PRODUCER_LIMITS.owner_mute_days]
        );
        const w = windows.rows[0] as { within_reopen: boolean; within_mute: boolean };
        if (last.status === "wont_fix" && w.within_mute) {
          // Eierens «ikke fiks» står: kun telleren øker (updated_at røres IKKE, ellers ville dempingen forlenges så lenge faktumet vedvarer).
          await client.query(`UPDATE incidents SET occurrence_count = occurrence_count + 1, last_seen_at = now() WHERE tenant_id = $1 AND incident_id = $2`, [tenantId, last.incident_id]);
          return { action: "suppressed", reason: "owner_wont_fix_mute" };
        }
        if (last.status === "resolved" && w.within_reopen) {
          const reopened = await this.transitionTx(client, last, "open", actor, "regresjon: samme faktum observert på nytt etter at hendelsen ble løst", undefined);
          const bumped = await this.bumpOccurrence(client, reopened, fact.severity, false);
          await this.appendProducerEvidence(client, bumped, evidenceStatus, evidenceInput);
          return { action: "reopened", incident: bumped };
        }
      }

      const cap = await client.query(
        `SELECT count(*)::int AS n FROM incidents WHERE tenant_id = $1 AND memory_space_id = $2 AND source_kind = $3 AND status NOT IN ('resolved', 'wont_fix')`,
        [tenantId, memorySpace, fact.source_kind]
      );
      if ((cap.rows[0] as { n: number }).n >= PRODUCER_LIMITS.max_active_per_producer) return { action: "suppressed", reason: "active_cap_reached" };

      const incident_id = `inc-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO incidents (incident_id, tenant_id, memory_space_id, title, severity, owner_person_id, source_kind, dedupe_key, correlation_id, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, now()) RETURNING *`,
        [incident_id, tenantId, memorySpace, title, fact.severity, fact.source_kind, dedupeKey, correlationId]
      );
      const incident = rows[0] as IncidentRecord;
      await this.insertTransition(client, incident, null, "open", actor, `åpnet av produsenten ${fact.source_kind}`, undefined);
      await this.insertEvidence(client, incident, "producer", evidenceStatus, evidenceInput);
      await this.audit(client, incident, actor, "incident.opened", { incident_id, source_kind: fact.source_kind, severity: incident.severity });
      return { action: "opened", incident };
    });
  }

  /**
   * WP-E1: en PRODUSENT løser en hendelse fordi den deterministisk har MÅLT på nytt at betingelsen er borte. I SAMME transaksjon: nytt bevis (`asserted_by = check`) -> VERIFIED med
   * navngitt grunnlag -> overgang til `resolved` som peker på beviset. Aldri «løst fordi vi ikke har sett det på en stund», og aldri en manuell hendelse (kaster).
   * Allerede løst/lukket er et no-op.
   */
  async resolveByCheck(tenantId: string, memorySpace: MemorySpace, incidentId: string, check: ResolveByCheckInput): Promise<IncidentRecord | null> {
    const reason = cleanReason(check.reason);
    const confirmation = check.confirmation ?? "VERIFIED";
    if (confirmation === "VERIFIED" && (check.verified_by === undefined || check.basis === undefined)) throw new Error("incident_resolve_check_requires_basis");
    if (confirmation === "PROVISIONAL" && (check.verified_by !== undefined || check.basis !== undefined)) throw new Error("incident_resolve_provisional_has_no_verification");
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.lockIncident(client, tenantId, incidentId);
      if (!current) return null;
      if (isTerminalIncidentStatus(current.status)) return current;
      if (current.source_kind === "manual") throw new Error("incident_producer_cannot_touch_manual");
      const evidence = await this.insertEvidence(client, current, "check", initialEvidenceStatus("check", "PROVISIONAL"), {
        source_type: check.source_type,
        ...(check.source_ref !== undefined ? { source_ref: check.source_ref } : {}),
        summary: check.summary,
        observed_at: isoOrNow(check.observed_at)
      });
      if (confirmation === "VERIFIED") await this.verifyEvidenceTx(client, tenantId, evidence.evidence_id, { verified_by: check.verified_by!, basis: check.basis! });
      // L3: kun DENNE stien (kildens egen påstand, merket PROVISIONAL) får lukke en hendelse på et ikke-verifisert bevis - den generelle `transition()` krever fortsatt VERIFIED for en produsent.
      return this.transitionTx(client, current, "resolved", { kind: "producer" }, reason, evidence.evidence_id, { provisionalCheckProofOk: confirmation === "PROVISIONAL" });
    });
  }

  // ---- interne hjelpere (kjører i den PÅGÅENDE transaksjonen) ----

  private async lockIncident(client: pg.PoolClient, tenantId: string, incidentId: string): Promise<IncidentRecord | null> {
    const { rows } = await client.query(`SELECT * FROM incidents WHERE tenant_id = $1 AND incident_id = $2 FOR UPDATE`, [tenantId, incidentId]);
    return (rows[0] as IncidentRecord) ?? null;
  }

  private async transitionTx(
    client: pg.PoolClient,
    current: IncidentRecord,
    to: IncidentStatus,
    actor: IncidentActor,
    reason: string,
    evidenceRef: string | undefined,
    opts: { provisionalCheckProofOk?: boolean } = {}
  ): Promise<IncidentRecord> {
    if (actor.kind === "owner" && (typeof actor.person_id !== "string" || actor.person_id.length === 0)) throw new Error("incident_owner_actor_requires_person");
    if (actor.kind === "system") throw new Error("incident_system_actor_not_allowed");
    if (current.status === to) return current;
    assertValidIncidentTransition(current.status, to);
    if (actor.kind === "producer") {
      if (current.source_kind === "manual") throw new Error("incident_producer_cannot_touch_manual");
      if (to === "resolved") {
        // Standard: en produsent kan kun løse med et VERIFIED bevis for SAMME hendelse. Unntak (L3, kun fra `resolveByCheck` med `confirmation: "PROVISIONAL"`): kontrollens eget PROVISIONAL bevis.
        const accepted = opts.provisionalCheckProofOk === true ? "(status = 'VERIFIED' OR (status = 'PROVISIONAL' AND asserted_by = 'check'))" : "status = 'VERIFIED'";
        const proof = evidenceRef
          ? await client.query(`SELECT 1 FROM incident_evidence WHERE tenant_id = $1 AND incident_id = $2 AND evidence_id = $3 AND ${accepted}`, [current.tenant_id, current.incident_id, evidenceRef])
          : { rowCount: 0 };
        if (!proof.rowCount) throw new Error("incident_producer_resolve_requires_verified_evidence");
      } else if (to === "open") {
        if (current.status !== "resolved") throw new Error("incident_producer_cannot_reopen_closed");
      } else {
        throw new Error("incident_producer_transition_not_allowed");
      }
    }
    if (actor.kind === "repair" && to !== "repair_proposed") throw new Error("incident_repair_transition_not_allowed");
    const resolvedAtClause = to === "resolved" ? ", resolved_at = now()" : isTerminalIncidentStatus(current.status) ? ", resolved_at = NULL" : "";
    const { rows } = await client.query(
      `UPDATE incidents SET status = $1, updated_at = now()${resolvedAtClause} WHERE tenant_id = $2 AND incident_id = $3 RETURNING *`,
      [to, current.tenant_id, current.incident_id]
    );
    const updated = rows[0] as IncidentRecord;
    await this.insertTransition(client, updated, current.status, to, actor, reason, evidenceRef);
    await this.audit(client, updated, actor, "incident.transition", { incident_id: current.incident_id, from: current.status, to, ...(evidenceRef ? { evidence_ref: evidenceRef } : {}) });
    return updated;
  }

  /** Teller en ny observasjon på en aktiv (eller nettopp gjenåpnet) hendelse. Alvorlighet kan bare gå OPP. `touch = false` lar `updated_at` stå (gjenåpning har allerede satt den). */
  private async bumpOccurrence(client: pg.PoolClient, current: IncidentRecord, severity: IncidentSeverity, touch: boolean): Promise<IncidentRecord> {
    const next = SEVERITY_RANK[severity] > SEVERITY_RANK[current.severity] ? severity : current.severity;
    const { rows } = await client.query(
      `UPDATE incidents SET occurrence_count = occurrence_count + 1, last_seen_at = now(), severity = $3${touch ? ", updated_at = now()" : ""}
        WHERE tenant_id = $1 AND incident_id = $2 RETURNING *`,
      [current.tenant_id, current.incident_id, next]
    );
    return rows[0] as IncidentRecord;
  }

  /** Legger til produsentens bevis kun hvis det skiller seg fra forrige produsent-bevis og taket ikke er nådd (gjentatte målinger øker telleren, ikke bevismengden). */
  private async appendProducerEvidence(client: pg.PoolClient, incident: IncidentRecord, status: EvidenceStatus, input: AddEvidenceInput): Promise<void> {
    const { rows } = await client.query(
      `SELECT (SELECT count(*)::int FROM incident_evidence WHERE tenant_id = $1 AND incident_id = $2 AND asserted_by IN ('producer', 'check')) AS n,
              (SELECT source_type || '|' || coalesce(source_ref, '') || '|' || summary FROM incident_evidence
                WHERE tenant_id = $1 AND incident_id = $2 AND asserted_by = 'producer' ORDER BY created_at DESC, evidence_id DESC LIMIT 1) AS last_signature`,
      [incident.tenant_id, incident.incident_id]
    );
    const state = rows[0] as { n: number; last_signature: string | null };
    if (state.n >= PRODUCER_LIMITS.max_evidence_per_incident) return;
    const signature = `${input.source_type}|${input.source_ref ? redactSecrets(input.source_ref).slice(0, MAX_REF) : ""}|${redactSecrets(input.summary).slice(0, MAX_SUMMARY)}`;
    if (state.last_signature === signature) return;
    await this.insertEvidence(client, incident, "producer", status, input);
  }

  private async insertEvidence(
    client: pg.PoolClient,
    incident: Pick<IncidentRecord, "incident_id" | "tenant_id" | "memory_space_id">,
    assertedBy: EvidenceAssertedBy,
    status: EvidenceStatus,
    input: AddEvidenceInput
  ): Promise<IncidentEvidence> {
    // WP-K (D-471, JARVIS-068): en motsigelse peker på bevis i SAMME hendelse (og tenant). Tenant-FK-en (migrasjon 080) hindrer allerede en annen tenants rad, men ikke en annen HENDELSES
    // bevis (heller ikke et annet minne-rom - FK-oppslag omgår RLS): «dette beviset motsier den andre hendelsens» ville ellers vært en stille, uforklart kobling i sannhetsregimet.
    if (input.contradicts_evidence_id !== undefined) {
      const target = await client.query(
        `SELECT 1 FROM incident_evidence WHERE tenant_id = $1 AND incident_id = $2 AND evidence_id = $3`,
        [incident.tenant_id, incident.incident_id, input.contradicts_evidence_id]
      );
      if (!target.rowCount) throw new Error("incident_evidence_contradiction_target_invalid");
    }
    const evidence_id = `inc-ev-${randomUUID()}`;
    const { rows } = await client.query(
      `INSERT INTO incident_evidence
         (evidence_id, tenant_id, memory_space_id, incident_id, source_type, status, asserted_by, source_ref, summary, observed_at, contradicts_evidence_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        evidence_id, incident.tenant_id, incident.memory_space_id, incident.incident_id, input.source_type, status, assertedBy,
        input.source_ref ? redactSecrets(input.source_ref).slice(0, MAX_REF) : null,
        redactSecrets(input.summary).slice(0, MAX_SUMMARY), input.observed_at, input.contradicts_evidence_id ?? null
      ]
    );
    return rows[0] as IncidentEvidence;
  }

  private async verifyEvidenceTx(
    client: pg.PoolClient,
    tenantId: string,
    evidenceId: string,
    verification: { verified_by: EvidenceVerifiedBy; basis: string }
  ): Promise<IncidentEvidence | null> {
    const { rows } = await client.query(`SELECT * FROM incident_evidence WHERE tenant_id = $1 AND evidence_id = $2 FOR UPDATE`, [tenantId, evidenceId]);
    const current = rows[0] as IncidentEvidence | undefined;
    if (!current) return null;
    const basis = redactSecrets(String(verification.basis ?? "")).trim().slice(0, 300);
    if (assertCanVerify(current, verification.verified_by, basis) === "already_verified") return current;
    const updated = await client.query(
      `UPDATE incident_evidence SET status = 'VERIFIED', verified_by = $3, verification_basis = $4, verified_at = now() WHERE tenant_id = $1 AND evidence_id = $2 RETURNING *`,
      [tenantId, evidenceId, verification.verified_by, basis]
    );
    return updated.rows[0] as IncidentEvidence;
  }

  /** Skriver overgangsraden i den PÅGÅENDE transaksjonen (samme `txid` som den utsatte DB-triggeren krever). */
  private async insertTransition(
    client: pg.PoolClient,
    incident: Pick<IncidentRecord, "incident_id" | "tenant_id" | "memory_space_id">,
    from: IncidentStatus | null,
    to: IncidentStatus,
    actor: IncidentActor,
    reason: string,
    evidenceRef: string | undefined
  ): Promise<void> {
    await client.query(
      `INSERT INTO incident_transitions (transition_id, tenant_id, memory_space_id, incident_id, from_status, to_status, actor_kind, actor_person_id, reason, evidence_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [`inc-tr-${randomUUID()}`, incident.tenant_id, incident.memory_space_id, incident.incident_id, from, to, actor.kind, actorPerson(actor), reason, evidenceRef ?? null]
    );
  }

  /** Append-only revisjon i SAMME transaksjon; `trace_id` = hendelsens korrelasjons-id når den finnes (binder revisjon, overganger og bevis for samme fakta). Aldri fritekst. */
  private async audit(client: pg.PoolClient, incident: IncidentRecord, actor: IncidentActor, type: string, payload: Record<string, unknown>): Promise<void> {
    await writeAudit(
      client,
      { tenant_id: incident.tenant_id, person_id: actor.kind === "owner" ? actor.person_id : "system" },
      { type, payload: { ...payload, actor_kind: actor.kind }, ...(incident.correlation_id ? { trace_id: incident.correlation_id } : {}) }
    );
  }
}

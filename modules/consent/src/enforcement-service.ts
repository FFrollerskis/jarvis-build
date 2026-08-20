import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import type { ConsentService } from "./service.ts";
import type {
  ConsentEnforcementDecision, ConsentEnforcementEvent, ConsentEnforcementMode, ConsentEnforcementPolicy, ConsentPurpose,
  EnforcementSubject, SetConsentEnforcementModeInput
} from "./types.ts";

/**
 * D-92 (UA-4 NESTE SLICE): Consent Enforcement Activation / Rollout v1.
 *
 * Bevisst en EGEN klasse, IKKE lagt inn i D-91 sin allerede-mergede,
 * allerede-testede `ConsentService` - holder "hva motoren MENER"
 * (D-91, uendret av denne sliceen) strukturelt adskilt fra "OM den
 * meningen faktisk håndheves" (D-92, denne klassen), akkurat slik §16 i
 * byggeordren krever.
 */
export class ConsentEnforcementService {
  constructor(private readonly pool: pg.Pool, private readonly consent: ConsentService) {}

  /** `disabled` (§10 i byggeordren: trygg kompatibilitets-standard) ved fravær av rad - ALDRI stille "enforce". */
  async getEnforcementMode(tenantId: string, memorySpace: MemorySpace, purpose: ConsentPurpose): Promise<ConsentEnforcementMode> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const mode = await this.getEnforcementModeInTransaction(client, tenantId, memorySpace, purpose);
      return mode;
    });
  }

  private async getEnforcementModeInTransaction(
    client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, purpose: ConsentPurpose
  ): Promise<ConsentEnforcementMode> {
    const { rows } = await client.query(
      `SELECT mode FROM consent_enforcement_policies WHERE tenant_id = $1 AND memory_space_id = $2 AND purpose = $3`,
      [tenantId, memorySpace, purpose]
    );
    return (rows[0] as { mode: ConsentEnforcementMode } | undefined)?.mode ?? "disabled";
  }

  async getEnforcementPolicy(tenantId: string, memorySpace: MemorySpace, purpose: ConsentPurpose): Promise<ConsentEnforcementPolicy | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM consent_enforcement_policies WHERE tenant_id = $1 AND memory_space_id = $2 AND purpose = $3`,
        [tenantId, memorySpace, purpose]
      );
      return (rows[0] as ConsentEnforcementPolicy | undefined) ?? null;
    });
  }

  /**
   * Eksplisitt eier-aktivering (§11 i byggeordren) - endrer KUN om D-91
   * sin tilstand blir bindende for blokkering, ALDRI datasubjektets
   * faktiske samtykke-tilstand. Denne handlingen skaper ALDRI en
   * `ConsentDecision`-rad - den er en ren rollout-konfigurasjon.
   * Purpose-spesifikk (§19) - å aktivere for `attribution` aktiverer
   * ALDRI `tracking` implisitt.
   */
  async setEnforcementMode(tenantId: string, memorySpace: MemorySpace, input: SetConsentEnforcementModeInput): Promise<ConsentEnforcementPolicy> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `INSERT INTO consent_enforcement_policies (tenant_id, memory_space_id, purpose, mode, actor_person_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (tenant_id, memory_space_id, purpose)
         DO UPDATE SET mode = EXCLUDED.mode, actor_person_id = EXCLUDED.actor_person_id, updated_at = now()
         RETURNING *`,
        [tenantId, memorySpace, input.purpose, input.mode, input.actor_person_id ?? null]
      );
      return rows[0] as ConsentEnforcementPolicy;
    });
  }

  /**
   * DEN faktiske håndhevings-integrasjonspunktet (§13/§18/§31 i
   * byggeordren) - kalles av en STYRENDE tjeneste (f.eks. GrowthService)
   * INNENFOR sin EGEN `withMemoryTransaction`, med DEN SAMME `client`,
   * RETT FØR den styrte skrivingen. IKKE en separat transaksjon - dette
   * gir READ COMMITTED-konsistens mellom evaluering og skriving (samme
   * transaksjon), IKKE SERIALIZABLE (byggeordren §18 ber eksplisitt om å
   * IKKE finne opp serialiserbare transaksjoner overalt). DOKUMENTERT
   * grense: en `withdrawn`/`denied`-beslutning som committes i en GENUINT
   * samtidig, ANNEN transaksjon MELLOM denne lesningen og kallerens
   * commit, er IKKE garantert observert her - samme raseklasse som
   * allerede aksepteres andre steder i systemet (f.eks. PolicyGateway sin
   * autoritets-sjekk mot en samtidig tilbaketrukket godkjenning). INGEN
   * delvis skriving: kalleren MÅ selv la denne metodens
   * `enforcement_result === "blocked"` stoppe FØR sin egen INSERT/UPDATE
   * - denne metoden gjør INGEN styrt skriving selv.
   *
   * `subject.kind === "no_data_subject"` (f.eks. en lead/opportunity uten
   * lenket kontakt) betyr "intet datasubjekt å styre" - IKKE det samme som
   * `disabled`/`ALLOWED`/`UNKNOWN_NOT_CONFIGURED`, og forsøker ALDRI å
   * spørre `consent_decisions` (som uansett ville feilet mot dens NOT
   * NULL-FK) - rapporteres som en EGEN, eksplisitt forklart "proceed".
   *
   * `subject.kind === "unresolved"` (D-92 CLOSEOUT, PR #32 pre-merge
   * audit) betyr at kalleren IKKE fant NOEN rad for den oppgitte
   * entiteten i det hele tatt (feil `entity_id`, feil tenant, slettet
   * entitet, skrivefeil) - STRUKTURELT ULIKT `no_data_subject` (der en
   * rad ble funnet og dens kontakt-kolonne FAKTISK er NULL). Å behandle
   * `unresolved` som `no_data_subject` ville vært en policy-bypass-risiko
   * (en feil/ukjent `entity_id` kunne da stille omgå `enforce`-modus for
   * et datasubjekt som kanskje FAKTISK finnes). I `enforce`-modus
   * blokkeres derfor `unresolved` FAIL-CLOSED (kan IKKE bevise at det
   * ikke finnes et datasubjekt). I `audit`-modus fortsetter prosessering
   * (audit blokkerer ALDRI), men INGEN hendelse logges - det finnes ingen
   * gyldig `contact_id` å skrive den append-only loggens NOT NULL-FK mot.
   */
  async enforce(
    client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, subject: EnforcementSubject, purpose: ConsentPurpose, operation: string
  ): Promise<ConsentEnforcementDecision> {
    const mode = await this.getEnforcementModeInTransaction(client, tenantId, memorySpace, purpose);
    if (mode === "disabled") {
      return { enforcement_mode: "disabled", enforcement_result: "proceed", processing_decision: null, reason: "enforcement_not_activated_for_this_tenant_space_purpose" };
    }
    if (subject.kind === "no_data_subject") {
      return {
        enforcement_mode: mode, enforcement_result: "proceed", processing_decision: null,
        reason: "no_linked_contact_no_data_subject_to_govern"
      };
    }
    if (subject.kind === "unresolved") {
      if (mode === "enforce") {
        return {
          enforcement_mode: mode, enforcement_result: "blocked", processing_decision: null,
          reason: "subject_identity_unresolved_failing_closed_cannot_confirm_no_data_subject"
        };
      }
      return {
        enforcement_mode: mode, enforcement_result: "proceed", processing_decision: null,
        reason: "subject_identity_unresolved_audit_mode_cannot_evaluate_or_log_proceeding"
      };
    }
    const decision = await this.consent.evaluateProcessingDecisionInTransaction(client, tenantId, subject.contact_id, purpose);
    const wouldBlock = decision.outcome !== "ALLOWED";
    const enforcement_result = mode === "enforce" && wouldBlock ? "blocked" : "proceed";
    await this.recordEnforcementEvent(client, tenantId, memorySpace, subject.contact_id, purpose, operation, mode, decision.outcome, enforcement_result, decision.provenance, decision.policy_version);
    return {
      enforcement_mode: mode, enforcement_result, processing_decision: decision,
      reason: enforcement_result === "blocked"
        ? `enforce-modus aktiv, siste prosesserings-avgjørelse er '${decision.outcome}' - blokkert FØR styrt skriving`
        : mode === "audit"
          ? `audit-modus - evaluert og logget, prosessering fortsetter uansett utfall ('${decision.outcome}')`
          : `enforce-modus aktiv, siste prosesserings-avgjørelse er 'ALLOWED' - fortsetter`
    };
  }

  private async recordEnforcementEvent(
    client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, contactId: string, purpose: ConsentPurpose, operation: string,
    mode: "audit" | "enforce", outcome: ConsentEnforcementEvent["processing_outcome"], result: ConsentEnforcementEvent["enforcement_result"],
    decisionId: string | null, policyVersion: string | null
  ): Promise<void> {
    await client.query(
      `INSERT INTO consent_enforcement_events
         (event_id, tenant_id, memory_space_id, contact_id, purpose, operation, enforcement_mode, processing_outcome, enforcement_result, decision_id, policy_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [`cst-enf-${randomUUID()}`, tenantId, memorySpace, contactId, purpose, operation, mode, outcome, result, decisionId, policyVersion]
    );
  }

  async listEnforcementEvents(
    tenantId: string, memorySpace: MemorySpace, filter: { contact_id?: string; purpose?: ConsentPurpose } = {}
  ): Promise<ConsentEnforcementEvent[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const conditions = ["tenant_id = $1"];
      const params: string[] = [tenantId];
      if (filter.contact_id) {
        params.push(filter.contact_id);
        conditions.push(`contact_id = $${params.length}`);
      }
      if (filter.purpose) {
        params.push(filter.purpose);
        conditions.push(`purpose = $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT * FROM consent_enforcement_events WHERE ${conditions.join(" AND ")} ORDER BY recorded_at DESC, seq DESC`,
        params
      );
      return rows as ConsentEnforcementEvent[];
    });
  }
}

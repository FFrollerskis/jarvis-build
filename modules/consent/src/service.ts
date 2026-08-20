import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import type {
  ConsentDecision, ConsentPurpose, ListConsentDecisionsFilter, ProcessingDecisionResult, RecordConsentDecisionInput
} from "./types.ts";

/**
 * D-91 (UA-4 NESTE SLICE): Consent / Cookie / Data-Processing Governance
 * Core - deterministisk, append-only, fail-closed. ZERO ModelGateway.
 *
 * ARKITEKTONISK GRENSE mot PolicyGateway (`@jarvis/policy`, bevisst IKKE
 * duplisert her): PolicyGateway avgjør "kan DENNE IDENTITETEN kalle DETTE
 * verktøyet, gitt risikoklasse A-D og autoritetsmodus?" - en
 * verktøykall-risikoport. Denne tjenesten avgjør et HELT ANNET spørsmål:
 * "kan DENNE DATAEN behandles for DETTE FORMÅLET, gitt registrert samtykke-
 * /rettslig-grunnlag-tilstand for datasubjektet?" - en data-behandlings-
 * formålsport. De to komponerer (en fremtidig kalle-flyt kan sjekke BEGGE),
 * men INGEN av dem erstatter den andre.
 */
export class ConsentService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Registrerer EN NY, permanent beslutnings-rad - ALDRI en UPDATE av en
   * eksisterende rad (append-only-loggen, se `032_consent_governance.sql`
   * sin manglende UPDATE-grant). Idempotens er BEVISST IKKE innebygd her -
   * hver kall representerer en FAKTISK ny, tidsstemplet beslutningshendelse
   * (i motsetning til D-89 sin "no-op-resynk"-idempotens, som gjaldt
   * AVLEDET tilstand, ikke en eksplisitt registrert juridisk hendelse).
   */
  async recordConsentDecision(
    tenantId: string, memorySpace: MemorySpace, input: RecordConsentDecisionInput
  ): Promise<ConsentDecision> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `INSERT INTO consent_decisions
           (decision_id, tenant_id, memory_space_id, contact_id, purpose, state, legal_basis, evidence, policy_version, actor_person_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          `cst-dec-${randomUUID()}`, tenantId, memorySpace, input.contact_id, input.purpose, input.state,
          input.legal_basis, JSON.stringify(input.evidence), input.policy_version, input.actor_person_id ?? null,
          input.expires_at ?? null
        ]
      );
      return rows[0] as ConsentDecision;
    });
  }

  /**
   * Nyeste registrerte beslutning for (kontakt, formål) - `null` hvis ingen
   * finnes ennå (ærlig "ikke konfigurert", aldri gjettet). `ORDER BY
   * recorded_at DESC, seq DESC` - `seq` er en monotonisk tie-breaker (§11 i
   * lukkingsordren): to rader KAN dele identisk `recorded_at` under
   * samtidige innsettinger, og en uspesifisert SQL-rekkefølge blant like
   * tidsstempler er IKKE akseptabelt for en juridisk betydningsfull
   * beslutning. `decision_id` (en tilfeldig UUID) kunne IKKE brukt som
   * tie-breaker - den har ingen meningsfull rekkefølge.
   */
  async getCurrentConsentState(
    tenantId: string, memorySpace: MemorySpace, contactId: string, purpose: ConsentPurpose
  ): Promise<ConsentDecision | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM consent_decisions
         WHERE tenant_id = $1 AND contact_id = $2 AND purpose = $3
         ORDER BY recorded_at DESC, seq DESC LIMIT 1`,
        [tenantId, contactId, purpose]
      );
      return (rows[0] as ConsentDecision | undefined) ?? null;
    });
  }

  async listConsentDecisions(
    tenantId: string, memorySpace: MemorySpace, filter: ListConsentDecisionsFilter = {}
  ): Promise<ConsentDecision[]> {
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
        `SELECT * FROM consent_decisions WHERE ${conditions.join(" AND ")} ORDER BY recorded_at DESC, seq DESC`,
        params
      );
      return rows as ConsentDecision[];
    });
  }

  /**
   * Den DETERMINISTISKE håndhevings-kjernen (§15/§20 i byggeordren).
   * FAIL-CLOSED, EKSAKT samme lærdom som D-81 sin `isSensitivityEligible()`:
   * denne funksjonen returnerer `ALLOWED` UTELUKKENDE når den NYESTE
   * registrerte beslutningen for (kontakt, formål) faktisk er `'granted'`
   * OG ikke utløpt. INGEN annen sti returnerer `ALLOWED` - verken fravær av
   * data, en `'denied'`/`'withdrawn'`-tilstand, ELLER en utløpt
   * `'granted'`-rad. `UNKNOWN_NOT_CONFIGURED` er en EGEN, eksplisitt tredje
   * utfall (fravær av data er ALDRI stille implisitt tillatelse - se
   * `types.ts`).
   *
   * ZERO ModelGateway - ren deterministisk databaseoppslag + tidsstempel-
   * sammenligning, INGEN inferens fra atferd/fritekst noe sted.
   */
  async evaluateProcessingDecision(
    tenantId: string, memorySpace: MemorySpace, contactId: string, purpose: ConsentPurpose
  ): Promise<ProcessingDecisionResult> {
    const latest = await this.getCurrentConsentState(tenantId, memorySpace, contactId, purpose);
    return deriveProcessingDecision(contactId, purpose, latest);
  }

  /**
   * D-92 (UA-4 NESTE SLICE): SAMME evaluerings-logikk som
   * `evaluateProcessingDecision()`, men deltar i en kallers EKSISTERENDE
   * transaksjon (samme `client`) i stedet for å åpne sin egen via
   * `withMemoryTransaction`. Kreves for at en fremtidig håndhevende
   * kaller (se `ConsentEnforcementService.enforce()`) skal kunne
   * evaluere OG utføre sin styrte skriving i ÉN transaksjon (READ
   * COMMITTED-konsistens - se `enforce()`-JSDoc for den eksakte,
   * dokumenterte TOCTOU-grensen). RLS-sesjonskontekst (tenant/space) må
   * ALLEREDE være satt av kallerens EGEN `withMemoryTransaction`-kall -
   * denne metoden setter INGEN sesjonskontekst selv.
   */
  async evaluateProcessingDecisionInTransaction(
    client: pg.PoolClient, tenantId: string, contactId: string, purpose: ConsentPurpose
  ): Promise<ProcessingDecisionResult> {
    const { rows } = await client.query(
      `SELECT * FROM consent_decisions
       WHERE tenant_id = $1 AND contact_id = $2 AND purpose = $3
       ORDER BY recorded_at DESC, seq DESC LIMIT 1`,
      [tenantId, contactId, purpose]
    );
    const latest = (rows[0] as ConsentDecision | undefined) ?? null;
    return deriveProcessingDecision(contactId, purpose, latest);
  }
}

/** Ren funksjon, delt av BEGGE evaluerings-veiene over - garanterer IDENTISK fail-closed logikk uansett hvilken transaksjonskontekst kallet skjer i. */
function deriveProcessingDecision(
  contactId: string, purpose: ConsentPurpose, latest: ConsentDecision | null
): ProcessingDecisionResult {
  const evaluatedAt = new Date().toISOString();
  if (!latest) {
    return {
      outcome: "UNKNOWN_NOT_CONFIGURED", purpose, contact_id: contactId,
      reason: "ingen registrert samtykke-/rettslig-grunnlag-beslutning finnes for denne kontakten/formålet - fravær er ALDRI implisitt tillatelse",
      policy_version: null, provenance: null, evaluated_at: evaluatedAt
    };
  }
  const expired = latest.expires_at !== null && new Date(latest.expires_at).getTime() < Date.now();
  if (latest.state === "granted" && !expired) {
    return {
      outcome: "ALLOWED", purpose, contact_id: contactId,
      reason: `siste registrerte beslutning er 'granted' (rettslig grunnlag: ${latest.legal_basis}), ikke utløpt`,
      policy_version: latest.policy_version, provenance: latest.decision_id, evaluated_at: evaluatedAt
    };
  }
  return {
    outcome: "DENIED", purpose, contact_id: contactId,
    reason: expired
      ? `siste registrerte 'granted'-beslutning er utløpt (${latest.expires_at})`
      : `siste registrerte beslutning er '${latest.state}'`,
    policy_version: latest.policy_version, provenance: latest.decision_id, evaluated_at: evaluatedAt
  };
}

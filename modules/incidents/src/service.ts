import { randomUUID } from "node:crypto";
import { redactSecrets } from "./redact.ts";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { assertValidIncidentTransition } from "./state-machine.ts";
import type {
  AddEvidenceInput,
  CreateIncidentInput,
  Incident,
  IncidentEvidence,
  IncidentStatus
} from "./types.ts";

/**
 * D-104: kjerne-domenetjeneste for incident-lifecycle/-bevis. Gjenbruker
 * `withMemoryTransaction` (SAMME RLS-primitiv som resten av Business OS) -
 * ingen ny sikkerhetsmodell. Deterministisk korrelasjon lever i
 * `correlation.ts`; hendelse->testet-fiks-orkestrering i `repair.ts`;
 * before/after/recovery i `recovery.ts` - denne filen eier KUN selve
 * hendelses-/bevis-lagringen.
 */
export class IncidentService {
  constructor(private readonly pool: pg.Pool) {}

  async createIncident(tenantId: string, memorySpace: MemorySpace, input: CreateIncidentInput): Promise<Incident> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const incident_id = `inc-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO incidents (incident_id, tenant_id, memory_space_id, title, severity, owner_person_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [incident_id, tenantId, memorySpace, input.title, input.severity ?? "normal", input.owner_person_id ?? null]
      );
      return rows[0] as Incident;
    });
  }

  async getIncident(tenantId: string, memorySpace: MemorySpace, incidentId: string): Promise<Incident | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM incidents WHERE tenant_id = $1 AND incident_id = $2`, [tenantId, incidentId]);
      return (rows[0] as Incident) ?? null;
    });
  }

  async listIncidents(tenantId: string, memorySpace: MemorySpace, status: IncidentStatus | "all" = "open"): Promise<Incident[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } =
        status === "all"
          ? await client.query(`SELECT * FROM incidents WHERE tenant_id = $1 ORDER BY opened_at DESC`, [tenantId])
          : await client.query(`SELECT * FROM incidents WHERE tenant_id = $1 AND status = $2 ORDER BY opened_at DESC`, [tenantId, status]);
      return rows as Incident[];
    });
  }

  /** Statsovergang håndheves deterministisk (state-machine.ts) - ugyldig overgang kaster, endrer INGENTING. */
  async setStatus(tenantId: string, memorySpace: MemorySpace, incidentId: string, status: IncidentStatus): Promise<Incident | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, incidentId);
      if (!current) return null;
      assertValidIncidentTransition(current.status, status);
      const resolvedAtClause = status === "resolved" ? ", resolved_at = now()" : current.status === "resolved" ? ", resolved_at = NULL" : "";
      const { rows } = await client.query(
        `UPDATE incidents SET status = $1, updated_at = now()${resolvedAtClause} WHERE tenant_id = $2 AND incident_id = $3 RETURNING *`,
        [status, tenantId, incidentId]
      );
      return rows[0] as Incident;
    });
  }

  /**
   * D-104 Part B: bevis legges ALLTID til, ALDRI overskrevet - selv når det
   * eksplisitt MOTSIER et tidligere bevis (`contradicts_evidence_id`).
   * `status` defaulter til `UNVERIFIED` (Q-26-stil) - INGEN automatisk
   * forfremmelse til `VERIFIED` her; det gjøres KUN deterministisk av
   * `correlation.ts` når evidensen faktisk korroboreres.
   */
  async addEvidence(tenantId: string, memorySpace: MemorySpace, incidentId: string, input: AddEvidenceInput): Promise<IncidentEvidence> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.readForUpdate(client, tenantId, incidentId);
      if (!current) throw new Error("incident_not_found");
      const evidence_id = `inc-ev-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO incident_evidence
           (evidence_id, tenant_id, memory_space_id, incident_id, source_type, status, source_ref, summary, observed_at, contradicts_evidence_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          evidence_id, tenantId, memorySpace, incidentId, input.source_type, input.status ?? "UNVERIFIED",
          input.source_ref ? redactSecrets(input.source_ref) : null, redactSecrets(input.summary), input.observed_at, input.contradicts_evidence_id ?? null
        ]
      );
      return rows[0] as IncidentEvidence;
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

  /** Brukt internt av korrelasjon for å oppdatere en enkelt bevis-rads status (VERIFIED etter faktisk korroborering) - ALDRI en annen rads innhold. */
  async setEvidenceStatus(tenantId: string, memorySpace: MemorySpace, evidenceId: string, status: IncidentEvidence["status"]): Promise<void> {
    await withMemoryTransaction(this.pool, tenantId, [memorySpace], (client) =>
      client.query(`UPDATE incident_evidence SET status = $1 WHERE tenant_id = $2 AND evidence_id = $3`, [status, tenantId, evidenceId])
    );
  }

  private async readForUpdate(client: pg.PoolClient, tenantId: string, incidentId: string): Promise<Incident | null> {
    const { rows } = await client.query(`SELECT * FROM incidents WHERE tenant_id = $1 AND incident_id = $2`, [tenantId, incidentId]);
    return (rows[0] as Incident) ?? null;
  }
}

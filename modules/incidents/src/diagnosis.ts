import { randomUUID } from "node:crypto";
import { redactSecrets } from "./redact.ts";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import type { CreateDiagnosisInput, IncidentDiagnosis } from "./types.ts";

/**
 * D-105 Part G: diagnose ATSKILT fra `IncidentEvidence` (rå bevis). En
 * diagnose er ALDRI overskrevet/mutert etter opprettelse - en revurdering
 * oppretter en NY rad som peker `supersedes_diagnosis_id` BAKOVER til den
 * gamle (som forblir uendret, spørrbar, ALDRI slettet av en revurdering -
 * kun av Q-20-erasure). `conclusion` er KORT og allerede strukturert -
 * ALDRI rå chain-of-thought/full modellresonnering lagret her.
 */
export class DiagnosisService {
  constructor(private readonly pool: pg.Pool) {}

  async createDiagnosis(
    tenantId: string,
    memorySpace: MemorySpace,
    incidentId: string,
    input: CreateDiagnosisInput
  ): Promise<IncidentDiagnosis> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const incident = await client.query(`SELECT 1 FROM incidents WHERE tenant_id = $1 AND incident_id = $2`, [tenantId, incidentId]);
      if (incident.rows.length === 0) throw new Error("incident_not_found");
      if (input.supersedes_diagnosis_id) {
        const prior = await client.query(
          `SELECT 1 FROM incident_diagnoses WHERE tenant_id = $1 AND diagnosis_id = $2`,
          [tenantId, input.supersedes_diagnosis_id]
        );
        if (prior.rows.length === 0) throw new Error("superseded_diagnosis_not_found");
      }
      const diagnosis_id = `inc-dx-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO incident_diagnoses (diagnosis_id, tenant_id, memory_space_id, incident_id, conclusion, status, source, supersedes_diagnosis_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          diagnosis_id, tenantId, memorySpace, incidentId, redactSecrets(input.conclusion),
          input.status ?? "UNVERIFIED", input.source, input.supersedes_diagnosis_id ?? null
        ]
      );
      for (const evidenceId of input.supporting_evidence_ids ?? []) {
        await client.query(
          `INSERT INTO incident_diagnosis_evidence (diagnosis_id, evidence_id, relation) VALUES ($1, $2, 'supports')`,
          [diagnosis_id, evidenceId]
        );
      }
      for (const evidenceId of input.contradicting_evidence_ids ?? []) {
        await client.query(
          `INSERT INTO incident_diagnosis_evidence (diagnosis_id, evidence_id, relation) VALUES ($1, $2, 'contradicts')`,
          [diagnosis_id, evidenceId]
        );
      }
      return rows[0] as IncidentDiagnosis;
    });
  }

  async getDiagnosis(tenantId: string, memorySpace: MemorySpace, diagnosisId: string): Promise<IncidentDiagnosis | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM incident_diagnoses WHERE tenant_id = $1 AND diagnosis_id = $2`, [tenantId, diagnosisId]);
      return (rows[0] as IncidentDiagnosis) ?? null;
    });
  }

  /** Nyeste FØRST - konsumenten kan lese `[0]` for "gjeldende" diagnose, men ALLE tidligere (motsagte) forblir synlige/spørrbare. */
  async listDiagnoses(tenantId: string, memorySpace: MemorySpace, incidentId: string): Promise<IncidentDiagnosis[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM incident_diagnoses WHERE tenant_id = $1 AND incident_id = $2 ORDER BY created_at DESC`,
        [tenantId, incidentId]
      );
      return rows as IncidentDiagnosis[];
    });
  }

  async listEvidenceLinks(tenantId: string, memorySpace: MemorySpace, diagnosisId: string): Promise<Array<{ evidence_id: string; relation: "supports" | "contradicts" }>> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT de.evidence_id, de.relation FROM incident_diagnosis_evidence de
           JOIN incident_diagnoses d ON d.diagnosis_id = de.diagnosis_id
         WHERE d.tenant_id = $1 AND de.diagnosis_id = $2`,
        [tenantId, diagnosisId]
      );
      return rows as Array<{ evidence_id: string; relation: "supports" | "contradicts" }>;
    });
  }
}

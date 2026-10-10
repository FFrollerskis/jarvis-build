import { randomUUID } from "node:crypto";
import { redactSecrets } from "./redact.ts";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { initialDiagnosisStatus } from "./truth.ts";
import type { CreateDiagnosisInput, EvidenceStatus, IncidentDiagnosis } from "./types.ts";

/**
 * D-105 Part G: diagnose ATSKILT fra `IncidentEvidence` (rå bevis). En
 * diagnose er ALDRI overskrevet/mutert etter opprettelse - en revurdering
 * oppretter en NY rad som peker `supersedes_diagnosis_id` BAKOVER til den
 * gamle (som forblir uendret, spørrbar, ALDRI slettet av en revurdering -
 * kun av Q-20-erasure). `conclusion` er KORT og allerede strukturert -
 * ALDRI rå chain-of-thought/full modellresonnering lagret her.
 *
 * WP-E1 (JARVIS-068): sannhetstype-regimet (`truth.ts`) gjelder også her - en modell-hypotese er alltid UNVERIFIED, en eier-konklusjon kan aldri være VERIFIED, og en deterministisk
 * diagnose kan kun være VERIFIED når minst ett STØTTEbevis er VERIFIED (migrasjon 097 håndhever det samme i databasen). Alle bevis en diagnose siterer MÅ tilhøre SAMME hendelse.
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
      const citedIds = [...new Set([...(input.supporting_evidence_ids ?? []), ...(input.contradicting_evidence_ids ?? [])])];
      const cited = citedIds.length === 0
        ? { rows: [] as Array<{ evidence_id: string; status: EvidenceStatus }> }
        : await client.query(
            `SELECT evidence_id, status FROM incident_evidence WHERE tenant_id = $1 AND incident_id = $2 AND evidence_id = ANY($3::text[])`,
            [tenantId, incidentId, citedIds]
          );
      if (cited.rows.length !== citedIds.length) throw new Error("diagnosis_evidence_not_found_for_incident");
      const statusOf = new Map((cited.rows as Array<{ evidence_id: string; status: EvidenceStatus }>).map((r) => [r.evidence_id, r.status]));
      const supportingStatuses = (input.supporting_evidence_ids ?? []).map((id) => statusOf.get(id)!);
      const status = initialDiagnosisStatus(input.source, input.status, supportingStatuses);
      const conclusion = redactSecrets(input.conclusion).trim().slice(0, 2000);
      if (conclusion.length === 0) throw new Error("diagnosis_conclusion_required");
      const diagnosis_id = `inc-dx-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO incident_diagnoses (diagnosis_id, tenant_id, memory_space_id, incident_id, conclusion, status, source, supersedes_diagnosis_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [diagnosis_id, tenantId, memorySpace, incidentId, conclusion, status, input.source, input.supersedes_diagnosis_id ?? null]
      );
      for (const evidenceId of input.supporting_evidence_ids ?? []) {
        await client.query(
          `INSERT INTO incident_diagnosis_evidence (tenant_id, diagnosis_id, evidence_id, relation) VALUES ($1, $2, $3, 'supports')`,
          [tenantId, diagnosis_id, evidenceId]
        );
      }
      for (const evidenceId of input.contradicting_evidence_ids ?? []) {
        await client.query(
          `INSERT INTO incident_diagnosis_evidence (tenant_id, diagnosis_id, evidence_id, relation) VALUES ($1, $2, $3, 'contradicts')`,
          [tenantId, diagnosis_id, evidenceId]
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
           JOIN incident_diagnoses d ON d.tenant_id = de.tenant_id AND d.diagnosis_id = de.diagnosis_id
         WHERE d.tenant_id = $1 AND de.diagnosis_id = $2`,
        [tenantId, diagnosisId]
      );
      return rows as Array<{ evidence_id: string; relation: "supports" | "contradicts" }>;
    });
  }
}

import { createHash } from "node:crypto";
import type pg from "pg";

/**
 * Q-20 (docs/DATA_ERASURE.md): trygt fundament delt av `@jarvis/erasure`
 * (skriver ledgeren) og `@jarvis/knowledge` (leser den, for
 * resurrection-suppression - §5). Ligger i `@jarvis/core` fordi begge
 * modulene allerede avhenger av core, og en syklisk avhengighet mellom
 * erasure og knowledge dermed unngås.
 *
 * `erasure_fingerprints` lagrer ALDRI slettet innhold - kun en irreversibel
 * fingerprint av canonical identity (§5 i BO-en: "Ikke lagre slettet
 * body/subject/content").
 */
export function computeErasureFingerprint(
  tenantId: string,
  sourceType: string,
  sourceInstanceId: string,
  externalId: string
): string {
  return createHash("sha256").update(`${tenantId}|${sourceType}|${sourceInstanceId}|${externalId}`).digest("hex");
}

/**
 * Ren lesing (RLS-skopet av kallerens tenant-kontekst) - brukes av
 * `KnowledgeSyncService` FØR den oppretter et nytt canonical document.
 */
export async function isFingerprintErased(
  client: pg.PoolClient | pg.Pool,
  tenantId: string,
  sourceType: string,
  sourceInstanceId: string,
  externalId: string
): Promise<boolean> {
  const fingerprint = computeErasureFingerprint(tenantId, sourceType, sourceInstanceId, externalId);
  const { rows } = await client.query("SELECT 1 FROM erasure_fingerprints WHERE tenant_id = $1 AND fingerprint = $2", [
    tenantId,
    fingerprint
  ]);
  return rows.length > 0;
}

export interface ErasureFingerprintTarget {
  sourceType: string;
  sourceInstanceId: string;
  externalId: string;
}

/** Skriver suppresjons-fingerprints for et sett med slettede knowledge-dokumenter, i samme transaksjon som selve slettingen. */
export async function recordErasureFingerprints(
  client: pg.PoolClient,
  tenantId: string,
  erasureRequestId: string,
  targets: readonly ErasureFingerprintTarget[]
): Promise<void> {
  for (const target of targets) {
    const fingerprint = computeErasureFingerprint(tenantId, target.sourceType, target.sourceInstanceId, target.externalId);
    await client.query(
      `INSERT INTO erasure_fingerprints (fingerprint, tenant_id, source_type, source_instance_id, erasure_request_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, fingerprint) DO NOTHING`,
      [fingerprint, tenantId, target.sourceType, target.sourceInstanceId, erasureRequestId]
    );
  }
}

export type ErasureRequestStatus = "pending" | "completed" | "failed";

export interface ErasureRequestRow {
  request_id: string;
  tenant_id: string;
  scope_type: string;
  scope_summary: Record<string, unknown>;
  status: ErasureRequestStatus;
  record_counts: Record<string, number>;
  started_at: string;
  completed_at: string | null;
}

/** Idempotency-sjekk: finnes denne request_id-en allerede, brukes den lagrede tilstanden i stedet for å slette på nytt. */
export async function findErasureRequest(client: pg.PoolClient | pg.Pool, tenantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
  const { rows } = await client.query("SELECT * FROM erasure_requests WHERE tenant_id = $1 AND request_id = $2", [
    tenantId,
    requestId
  ]);
  return rows[0] as ErasureRequestRow | undefined;
}

export async function insertPendingErasureRequest(
  client: pg.PoolClient,
  requestId: string,
  tenantId: string,
  scopeType: string,
  scopeSummary: Record<string, unknown>,
  actor: { personId?: string; deviceId?: string }
): Promise<void> {
  await client.query(
    `INSERT INTO erasure_requests (request_id, tenant_id, scope_type, scope_summary, status, actor_person_id, actor_device_id)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
    [requestId, tenantId, scopeType, JSON.stringify(scopeSummary), actor.personId ?? null, actor.deviceId ?? null]
  );
}

export async function completeErasureRequest(
  client: pg.PoolClient,
  requestId: string,
  recordCounts: Record<string, number>
): Promise<void> {
  await client.query(
    `UPDATE erasure_requests SET status = 'completed', record_counts = $2, completed_at = now() WHERE request_id = $1`,
    [requestId, JSON.stringify(recordCounts)]
  );
}

/**
 * Kjøres UTENFOR den rullede-tilbake transaksjonen (fail-closed §5: hele
 * slettingen - INKLUSIVE den opprinnelige "pending"-raden - rulles tilbake
 * ved feil, så en ren UPDATE ville ikke funnet raden). UPSERT: skriver en
 * NY `failed`-rad hvis "pending"-raden aldri ble committet, ellers
 * oppdaterer en eksisterende rad. Egen tilkobling + egen tenant-RLS-kontekst.
 */
export async function failErasureRequest(
  pool: pg.Pool,
  tenantId: string,
  requestId: string,
  scopeType: string,
  scopeSummary: Record<string, unknown>,
  safeErrorMessage: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('jarvis.tenant_id', $1, true)", [tenantId]);
    await client.query(
      `INSERT INTO erasure_requests (request_id, tenant_id, scope_type, scope_summary, status, error, completed_at)
       VALUES ($1, $2, $3, $4, 'failed', $5, now())
       ON CONFLICT (request_id) DO UPDATE SET status = 'failed', error = $5, completed_at = now()`,
      [requestId, tenantId, scopeType, JSON.stringify(scopeSummary), safeErrorMessage.slice(0, 200)]
    );
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
  } finally {
    client.release();
  }
}

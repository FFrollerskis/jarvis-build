import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { computeErasureFingerprint } from "@jarvis/core";

/**
 * Logisk backup/restore v1 (Tier 1, DEPLOYMENT §4): app-nivå NDJSON per
 * tabell, deterministisk restore i FK-trygg rekkefølge, med MÅLT tid.
 * I drift suppleres dette med pg_dump/WAL-arkivering (runbook); kryptering
 * (age) skjer før filene forlater maskinen. En backup som aldri er
 * gjenopprettet regnes ikke som verifisert - derfor er restore en test.
 *
 * Q-20 (docs/DATA_ERASURE.md §8): `knowledge_documents`/`knowledge_embeddings`
 * manglet fra denne listen siden UA-2 P0 (reell pre-eksisterende gap - backup
 * dekket aldri knowledge-innhold i det hele tatt). `erasure_requests`/
 * `erasure_fingerprints` MÅ overleve en restore for at resurrection-
 * suppresjonen (§5) fortsatt skal virke etterpå - se `reapplyErasuresAfterRestore`.
 */
const TIER1_TABLES = [
  "tenants", "people", "person_tenants", "organizations", "projects", "sites", "rooms",
  "devices", "memory_spaces", "sessions", "messages", "events", "tasks", "capabilities",
  "approvals", "audit_events", "cost_events", "memory_sources", "memory_items",
  "memory_versions", "entities", "relations", "memory_item_entities", "summaries",
  "embeddings", "decisions", "commitments", "deadlines", "tool_executions", "artifacts",
  "knowledge_documents", "knowledge_embeddings", "erasure_requests", "erasure_fingerprints"
];

export class BackupService {
  constructor(private readonly adminPool: pg.Pool) {}

  async backup(targetDir: string): Promise<{ tables: number; rows: number; duration_ms: number }> {
    const started = performance.now();
    await mkdir(targetDir, { recursive: true });
    let rows = 0;
    for (const table of TIER1_TABLES) {
      const result = await this.adminPool.query(`SELECT * FROM ${table}`);
      rows += result.rows.length;
      await writeFile(join(targetDir, `${table}.ndjson`),
        result.rows.map((r) => JSON.stringify(r)).join("\n"), "utf8");
    }
    return { tables: TIER1_TABLES.length, rows, duration_ms: performance.now() - started };
  }

  /** Restore inn i en FERSK database (migrasjoner kjørt). Returnerer målt tid. */
  async restore(sourceDir: string, targetPool: pg.Pool): Promise<{ rows: number; duration_ms: number }> {
    const started = performance.now();
    let rows = 0;
    const files = await readdir(sourceDir);
    const client = await targetPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET session_replication_role = replica"); // FK/trigger-trygg restore som superuser
      for (const table of TIER1_TABLES) {
        if (!files.includes(`${table}.ndjson`)) continue;
        const content = await readFile(join(sourceDir, `${table}.ndjson`), "utf8");
        for (const line of content.split("\n").filter(Boolean)) {
          const row = JSON.parse(line) as Record<string, unknown>;
          const cols = Object.keys(row);
          await client.query(
            `INSERT INTO ${table} (${cols.join(",")}) OVERRIDING SYSTEM VALUE
             VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
            cols.map((c) => {
              const v = row[c];
              return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
            })
          );
          rows += 1;
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return { rows, duration_ms: performance.now() - started };
  }
}

/**
 * Q-20 restore-erasure-kontrakt (docs/DATA_ERASURE.md §8): en backup tatt FØR
 * en purge inneholder fortsatt det opprinnelig slettede innholdet - ren
 * restore ville gjenopplivet det. Kjøres FØR systemet regnes som klart til
 * bruk etter en restore: leser HELE `erasure_fingerprints`-ledgeren (som
 * ALDRI inneholder selve innholdet, kun fingerprints - se
 * `computeErasureFingerprint`), regner ut samme fingerprint for hvert
 * RESTORERTE knowledge-dokument, og fjerner treff på nytt. Idempotent -
 * ingen feil om raden allerede mangler. Kjøres mot admin-pool (kryssgår
 * flere tenants med vilje - dette er en administrativ vedlikeholdsoperasjon,
 * ikke en normal app-runtime-sti).
 */
export async function reapplyErasuresAfterRestore(adminPool: pg.Pool): Promise<{ removed: number }> {
  const { rows: fingerprints } = await adminPool.query<{ tenant_id: string; fingerprint: string }>(
    "SELECT tenant_id, fingerprint FROM erasure_fingerprints"
  );
  if (fingerprints.length === 0) {
    return { removed: 0 };
  }
  const erased = new Set(fingerprints.map((f) => `${f.tenant_id}:${f.fingerprint}`));

  const { rows: docs } = await adminPool.query<{
    knowledge_document_id: string;
    tenant_id: string;
    source_type: string;
    source_instance_id: string;
    external_id: string;
  }>("SELECT knowledge_document_id, tenant_id, source_type, source_instance_id, external_id FROM knowledge_documents");

  let removed = 0;
  for (const doc of docs) {
    const fingerprint = computeErasureFingerprint(doc.tenant_id, doc.source_type, doc.source_instance_id, doc.external_id);
    if (!erased.has(`${doc.tenant_id}:${fingerprint}`)) continue;
    await adminPool.query("DELETE FROM knowledge_embeddings WHERE knowledge_document_id = $1", [doc.knowledge_document_id]);
    await adminPool.query("DELETE FROM knowledge_documents WHERE knowledge_document_id = $1", [doc.knowledge_document_id]);
    removed += 1;
  }
  return { removed };
}

/** Kostnadsrapport (akseptanse: synlig per modell/agent/tenant/oppgave). */
export async function costReport(pool: pg.Pool): Promise<{
  by_kind: Array<{ kind: string; ore: number }>;
  by_tenant: Array<{ tenant_id: string; ore: number }>;
  by_task: Array<{ task_id: string | null; ore: number }>;
}> {
  const [kind, tenant, task] = await Promise.all([
    pool.query(`SELECT kind, sum(amount_ore)::int AS ore FROM cost_events GROUP BY kind ORDER BY ore DESC`),
    pool.query(`SELECT tenant_id, sum(amount_ore)::int AS ore FROM cost_events GROUP BY tenant_id ORDER BY ore DESC`),
    pool.query(`SELECT task_id, sum(amount_ore)::int AS ore FROM cost_events GROUP BY task_id ORDER BY ore DESC`)
  ]);
  return {
    by_kind: kind.rows as Array<{ kind: string; ore: number }>,
    by_tenant: tenant.rows as Array<{ tenant_id: string; ore: number }>,
    by_task: task.rows as Array<{ task_id: string | null; ore: number }>
  };
}

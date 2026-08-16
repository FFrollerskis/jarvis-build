import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeErasureFingerprint, runMigrations } from "@jarvis/core";
import { reapplyErasuresAfterRestore } from "@jarvis/watchdog";

/**
 * Q-20 §10 (docs/DATA_ERASURE.md §8): teknisk restore-erasure-kontrakt.
 * `BackupService.backup()` leser tabeller sekvensielt (ikke ett atomisk
 * snapshot) - en backup/restore-runde kan derfor i teorien inneholde et
 * RESTORERT knowledge-dokument SAMTIDIG som `erasure_fingerprints`-ledgeren
 * (som allerede sier "dette er slettet") også er restorert. Denne testen
 * beviser at `reapplyErasuresAfterRestore` løser akkurat den uoverensstemmelsen
 * i favør av ledgeren - deterministisk, idempotent, uten å kreve selve
 * innholdet i ledgeren.
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-restore-contract-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-restore','R','person')");
  await adminPool.query("INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-restore','tenant-restore','personal')");
}, 240_000);

afterAll(async () => {
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("Q-20 §10: reapplyErasuresAfterRestore", () => {
  it("fjerner et RESTORERT knowledge-dokument som matcher en fingerprint i den restorerte erasure_fingerprints-ledgeren", async () => {
    const tenantId = "tenant-restore";
    const sourceType = "filesystem";
    const sourceInstanceId = "fs:restore-contract";
    const externalId = "gjenoppstatt.md";
    const sentinel = "SentinelRestoreContract skal ikke gjenoppstå etter restore";

    await adminPool.query(
      `INSERT INTO knowledge_documents
        (knowledge_document_id, tenant_id, memory_space_id, source_type, source_instance_id, external_id,
         canonical_uri, title, content, content_type, content_hash)
       VALUES ('kd-restore-1',$1,'personal',$2,$3,$4,'file:///gjenoppstatt.md','Gjenoppstått',$5,'text/markdown','hash1')`,
      [tenantId, sourceType, sourceInstanceId, externalId, sentinel]
    );
    await adminPool.query(
      "INSERT INTO knowledge_embeddings (knowledge_document_id, tenant_id, memory_space_id, model, dim, embedding) VALUES ('kd-restore-1',$1,'personal','test-v1',2,'{0.1,0.2}')",
      [tenantId]
    );

    const fingerprint = computeErasureFingerprint(tenantId, sourceType, sourceInstanceId, externalId);
    await adminPool.query(
      "INSERT INTO erasure_requests (request_id, tenant_id, scope_type, scope_summary, status) VALUES ('req-restore-1',$1,'knowledge_document','{}','completed')",
      [tenantId]
    );
    await adminPool.query(
      "INSERT INTO erasure_fingerprints (fingerprint, tenant_id, source_type, source_instance_id, erasure_request_id) VALUES ($1,$2,$3,$4,'req-restore-1')",
      [fingerprint, tenantId, sourceType, sourceInstanceId]
    );

    // Uberørt dokument (annen external_id, INGEN matchende fingerprint) skal overleve.
    await adminPool.query(
      `INSERT INTO knowledge_documents
        (knowledge_document_id, tenant_id, memory_space_id, source_type, source_instance_id, external_id,
         canonical_uri, title, content, content_type, content_hash)
       VALUES ('kd-restore-2',$1,'personal',$2,$3,'uberort.md','file:///uberort.md','Uberørt','uberørt innhold','text/markdown','hash2')`,
      [tenantId, sourceType, sourceInstanceId]
    );

    const result = await reapplyErasuresAfterRestore(adminPool);
    expect(result.removed).toBe(1);

    const gone = await adminPool.query("SELECT 1 FROM knowledge_documents WHERE knowledge_document_id='kd-restore-1'");
    expect(gone.rowCount).toBe(0);
    const embGone = await adminPool.query("SELECT 1 FROM knowledge_embeddings WHERE knowledge_document_id='kd-restore-1'");
    expect(embGone.rowCount).toBe(0);
    const untouchedStillThere = await adminPool.query("SELECT 1 FROM knowledge_documents WHERE knowledge_document_id='kd-restore-2'");
    expect(untouchedStillThere.rowCount).toBe(1);

    // Idempotent: kjøre den samme funksjonen igjen (f.eks. neste restore) er trygt, ingen feil.
    const second = await reapplyErasuresAfterRestore(adminPool);
    expect(second.removed).toBe(0);
  });
});

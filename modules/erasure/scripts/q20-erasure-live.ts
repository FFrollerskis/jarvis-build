// Q-20 HOST LIVE ACCEPTANCE - kjøres AV TOBIAS mot ekte lokal Postgres/pgvector
// (docker-compose) og ekte filsystem. Gjenbruker KUN eksisterende arkitektur
// (@jarvis/erasure, @jarvis/knowledge, @jarvis/memory, @jarvis/core, @jarvis/policy)
// - ingen alternativ testimplementasjon. Speiler strukturen i
// modules/knowledge/scripts/ua2-p0-live.ts (samme log()/section()/Verdict-mønster).
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/core/scripts/q20-erasure-live.ts
//
// Skriver ALDRI SENTINEL-teksten selv til stdout utover et unikt, ufarlig
// prefiks (samme prinsipp som ua2-p0-live.ts §6) - kun statuser/tellinger.
// All test-scaffolding fjernes ved slutten (§21), bortsett fra selve
// purge-målet som allerede er slettet av testen selv.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { LocalHashEmbedding, withMemoryTransaction } from "@jarvis/memory";
import { FilesystemKnowledgeSource, KnowledgeRetriever, KnowledgeSyncService } from "@jarvis/knowledge";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "@jarvis/erasure";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  q20_preview: "FAIL",
  q20_hard_delete: "FAIL",
  q20_derived_delete: "FAIL",
  q20_fts_erasure: "FAIL",
  q20_vector_erasure: "FAIL",
  q20_hybrid_erasure: "FAIL",
  q20_memory_erasure: "FAIL",
  q20_no_resurrection: "FAIL",
  q20_idempotency: "FAIL",
  q20_tenant_isolation: "FAIL",
  q20_space_isolation: "FAIL",
  q20_receipt_safe: "FAIL",
  q20_sentinel_scan: "FAIL"
};
const diagnostics: Record<string, string> = {};

function log(msg: string): void {
  console.log(msg);
}

async function section<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  log(`\n== ${name} ==`);
  try {
    return await fn();
  } catch (err) {
    log(`${name}: UVENTET FEIL - ${(err as Error).message.slice(0, 200)}`);
    return undefined;
  }
}

const runId = randomUUID().slice(0, 8);
log(`Q-20 LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());
const embedding = new LocalHashEmbedding();

const TENANT_A = `tenant-q20-live-${runId}-a`;
const TENANT_B = `tenant-q20-live-${runId}-b`; // §16: annen tenant, skal forbli urørt
const OWNER_PERSON = `person-q20-live-${runId}`;
const SPACE_TARGET: MemorySpace = "personal";
const SPACE_OTHER: MemorySpace = "business"; // §17: annet memory-space, skal forbli urørt

function identityFor(tenantId: string, space: MemorySpace): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: space,
    session_id: `sess-q20-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

// SENTINEL: unik per kjøring, aldri en gjenbrukt/reell frase - gjør det trygt å
// grep'e HELE databasen etter den (§20) uten falske positiver fra ekte data.
const sentinel = `Q20SENTINEL_${runId}_${randomUUID().slice(0, 8)}`;
const otherSentinel = `Q20OTHER_${runId}_${randomUUID().slice(0, 8)}`;

async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query(
    `DELETE FROM knowledge_embeddings WHERE knowledge_document_id IN (SELECT knowledge_document_id FROM knowledge_documents WHERE tenant_id = $1)`,
    [tenantId]
  );
  await adminPool.query("DELETE FROM knowledge_documents WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM embeddings WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_items WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_sources WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM erasure_fingerprints WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM erasure_requests WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-q20-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) {
      await cleanupTenant(row.tenant_id).catch(() => undefined);
    }
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-q20-live-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

async function plantMemoryItem(tenantId: string, space: MemorySpace, content: string): Promise<void> {
  const memoryItemId = `mi-q20-${randomUUID()}`;
  const sourceId = `src-q20-${randomUUID()}`;
  await withMemoryTransaction(pool, tenantId, [space], async (client) => {
    await client.query("INSERT INTO memory_sources (source_id, tenant_id, kind, ref, trust_level) VALUES ($1,$2,'manual',$3,'trusted')", [
      sourceId, tenantId, memoryItemId
    ]);
    await client.query(
      `INSERT INTO memory_items (memory_item_id, tenant_id, space, owner_person_id, type, subject, content, source_id, observed_at, valid_from, trust_level)
       VALUES ($1,$2,$3,$4,'semantic','q20-live-sentinel',$5,$6, now(), now(), 'trusted')`,
      [memoryItemId, tenantId, space, OWNER_PERSON, content, sourceId]
    );
    const vector = await embedding.embed(content);
    await client.query(
      "INSERT INTO embeddings (memory_item_id, tenant_id, space, model, dim, embedding) VALUES ($1,$2,$3,$4,$5,$6)",
      [memoryItemId, tenantId, space, embedding.model, embedding.dim, vector]
    );
  });
}

async function main(): Promise<void> {
  // ===== §1: Q-21 RUNTIME ROLE (må fortsatt holde - Q-20 er bygget PÅ Q-21, ikke i stedet for) =====
  let runtimeRoleSafe = false;
  await section("§1 Q-21 RUNTIME ROLE", async () => {
    try {
      const status = await assertRuntimeRoleSafe(pool);
      runtimeRoleSafe = true;
      diagnostics["runtime_current_user"] = status.role;
      diagnostics["runtime_role_superuser"] = String(status.superuser);
      diagnostics["runtime_role_bypassrls"] = String(status.bypassrls);
      log(`q21_runtime_role_safe=PASS role=${status.role}`);
    } catch (err) {
      log(`q21_runtime_role_safe=FAIL - ${(err as Error).message}`);
    }
  });
  if (!runtimeRoleSafe) {
    log("\nQ-20 KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21 regresjon). Ingen destruktive kall forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  // ===== §2/§3: ISOLERT TESTDATA MED SENTINEL (original + derived) =====
  await selfHeal();
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Q20 Live A','person'), ('${TENANT_B}','Q20 Live B','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER_PERSON}','Q20 Live Tester') ON CONFLICT DO NOTHING;
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER_PERSON}','${TENANT_A}'), ('${OWNER_PERSON}','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('ms-q20-${runId}-a-personal','${TENANT_A}','personal'), ('ms-q20-${runId}-a-business','${TENANT_A}','business'),
      ('ms-q20-${runId}-b-personal','${TENANT_B}','personal');
  `);

  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A, TENANT_B] }
  });
  const erasure = new ErasureService(pool, policy, embedding);
  const sync = new KnowledgeSyncService(pool, embedding);
  const retriever = new KnowledgeRetriever(pool, embedding);

  let fsRoot = "";
  let fsFileName = "";
  let fsSourceInstanceId = "";
  let knowledgeDocumentId: string | undefined;

  await section("§2/§3 PLANT SENTINEL (original + derived)", async () => {
    fsRoot = await mkdtemp(join(tmpdir(), "jarvis-q20-live-"));
    fsFileName = `sentinel-${runId}.md`;
    fsSourceInstanceId = `fs:q20-live-${runId}`;
    await writeFile(join(fsRoot, fsFileName), sentinel);
    const report = await sync.sync(identityFor(TENANT_A, SPACE_TARGET), SPACE_TARGET, new FilesystemKnowledgeSource(fsRoot, fsSourceInstanceId));
    log(`knowledge sync: ${JSON.stringify(report)}`);
    await plantMemoryItem(TENANT_A, SPACE_TARGET, sentinel);

    // §16/§17-scaffolding: en ANNEN tenant og et ANNET space, urørt av purgen.
    await plantMemoryItem(TENANT_B, SPACE_TARGET, otherSentinel);
    await plantMemoryItem(TENANT_A, SPACE_OTHER, otherSentinel);

    const row = await withMemoryTransaction(pool, TENANT_A, [SPACE_TARGET], (client) =>
      client.query("SELECT knowledge_document_id FROM knowledge_documents WHERE tenant_id=$1 AND source_instance_id=$2 AND external_id=$3", [
        TENANT_A, fsSourceInstanceId, fsFileName
      ])
    );
    knowledgeDocumentId = (row.rows[0] as { knowledge_document_id: string } | undefined)?.knowledge_document_id;
    log(`knowledge_document_id=${knowledgeDocumentId ?? "MANGLER"}`);
  });

  if (!knowledgeDocumentId) {
    log("\nQ-20 KAN IKKE BEVISES: sentinel-dokumentet ble aldri opprettet.");
    return finish();
  }
  const docId = knowledgeDocumentId;

  // ===== §4: BEKREFT SENTINEL HENTBAR FØR PURGE (både knowledge OG memory) =====
  await section("§4 SENTINEL HENTBAR FØR PURGE", async () => {
    const foundKnowledge = await retriever.search(identityFor(TENANT_A, SPACE_TARGET), { query: sentinel, spaces: [SPACE_TARGET] });
    const foundMemory = await withMemoryTransaction(pool, TENANT_A, [SPACE_TARGET], (client) =>
      client.query("SELECT 1 FROM memory_items WHERE tenant_id=$1 AND space=$2 AND content=$3", [TENANT_A, SPACE_TARGET, sentinel])
    );
    log(
      `before_purge_knowledge_hits=${foundKnowledge.filter((r) => r.content.includes(sentinel)).length} before_purge_memory_hits=${foundMemory.rowCount}`
    );
  });

  // Purge-scope er `memory_space` (ikke bare `knowledge_document`) - dekker BEGGE original-artefaktene
  // (knowledge-dokumentet OG memory_item-en) i én operasjon, slik BO-ens §3 "original + derived data"
  // faktisk krever bevist samtidig.
  const purgeScope = { type: "memory_space", tenant_id: TENANT_A, memory_space_id: SPACE_TARGET } as const;

  // ===== §5: PREVIEW =====
  await section("§5 PREVIEW (ikke-destruktiv)", async () => {
    const preview = await erasure.previewErasure(purgeScope);
    log(`preview.affected=${JSON.stringify(preview.affected)}`);
    const stillThereAfterPreview = await retriever.search(identityFor(TENANT_A, SPACE_TARGET), { query: sentinel, spaces: [SPACE_TARGET] });
    results.q20_preview =
      (preview.affected["knowledge_documents"] ?? 0) >= 1 &&
      (preview.affected["memory_items"] ?? 0) >= 1 &&
      stillThereAfterPreview.some((r) => r.content.includes(sentinel))
        ? "PASS"
        : "FAIL";
    log(`q20_preview: ${results.q20_preview}`);
  });

  // ===== §6/§7: EXECUTE HARD PURGE + FYSISK SLETTING (knowledge OG memory) =====
  const requestId = `req-q20-live-${runId}`;
  await section("§6/§7 EXECUTE HARD PURGE", async () => {
    const result = await erasure.executeErasure({
      scope: purgeScope,
      requestId,
      identity: identityFor(TENANT_A, SPACE_TARGET)
    });
    log(`execute result: ${JSON.stringify(result)}`);
    results.q20_hard_delete = result.status === "completed" ? "PASS" : "FAIL";

    const docGone = await adminPool.query("SELECT 1 FROM knowledge_documents WHERE knowledge_document_id=$1", [docId]);
    const embGone = await adminPool.query("SELECT 1 FROM knowledge_embeddings WHERE knowledge_document_id=$1", [docId]);
    const memoryGone = await adminPool.query("SELECT 1 FROM memory_items WHERE tenant_id=$1 AND space=$2 AND content=$3", [
      TENANT_A, SPACE_TARGET, sentinel
    ]);
    const memoryEmbGone = await adminPool.query("SELECT 1 FROM embeddings WHERE tenant_id=$1 AND space=$2", [TENANT_A, SPACE_TARGET]);
    results.q20_derived_delete =
      docGone.rowCount === 0 && embGone.rowCount === 0 && memoryGone.rowCount === 0 && memoryEmbGone.rowCount === 0 ? "PASS" : "FAIL";
    log(`q20_hard_delete: ${results.q20_hard_delete} q20_derived_delete: ${results.q20_derived_delete}`);
  });

  // ===== §8/§9/§10/§11: FTS/VECTOR/HYBRID/MEMORY VERIFY =====
  await section("§8-§11 RETRIEVAL VERIFY (FTS/vector/hybrid/memory)", async () => {
    const verification = await erasure.verifyErasure({ identity: identityFor(TENANT_A, SPACE_TARGET), spaces: [SPACE_TARGET], sentinel });
    log(`verify=${JSON.stringify(verification)}`);
    results.q20_fts_erasure = verification.fts_hits === 0 ? "PASS" : "FAIL";
    results.q20_vector_erasure = verification.vector_hits === 0 ? "PASS" : "FAIL";
    results.q20_hybrid_erasure = verification.hybrid_hits === 0 ? "PASS" : "FAIL";
    results.q20_memory_erasure = verification.memory_hits === 0 ? "PASS" : "FAIL";
  });

  // ===== §12/§13: RESYNC -> NO RESURRECTION =====
  await section("§12/§13 RESYNC - NO RESURRECTION", async () => {
    const resync = await sync.sync(identityFor(TENANT_A, SPACE_TARGET), SPACE_TARGET, new FilesystemKnowledgeSource(fsRoot, fsSourceInstanceId));
    log(`resync: ${JSON.stringify(resync)}`);
    const foundAfterResync = await retriever.search(identityFor(TENANT_A, SPACE_TARGET), { query: sentinel, spaces: [SPACE_TARGET] });
    results.q20_no_resurrection =
      resync.created === 0 && resync.suppressed === 1 && !foundAfterResync.some((r) => r.content.includes(sentinel)) ? "PASS" : "FAIL";
    log(`q20_no_resurrection: ${results.q20_no_resurrection}`);
  });

  // ===== §14/§15: REPEAT REQUEST -> IDEMPOTENCY =====
  await section("§14/§15 REPEAT REQUEST - IDEMPOTENCY", async () => {
    const repeat = await erasure.executeErasure({
      scope: purgeScope,
      requestId, // SAMME request_id
      identity: identityFor(TENANT_A, SPACE_TARGET)
    });
    log(`repeat result: ${JSON.stringify(repeat)}`);
    results.q20_idempotency = repeat.status === "completed" && repeat.idempotent_replay === true ? "PASS" : "FAIL";
    log(`q20_idempotency: ${results.q20_idempotency}`);
  });

  // ===== §16/§17: ANDRE TENANT/SPACE URØRT =====
  await section("§16/§17 ANNEN TENANT / ANNET SPACE URØRT", async () => {
    // otherSentinel er plantet som et memory_item (§2/§3) - sjekk memory-laget direkte, ikke knowledge-retrieveren.
    const otherTenantFound = await withMemoryTransaction(pool, TENANT_B, [SPACE_TARGET], (client) =>
      client.query("SELECT 1 FROM memory_items WHERE tenant_id=$1 AND space=$2 AND content=$3", [TENANT_B, SPACE_TARGET, otherSentinel])
    );
    results.q20_tenant_isolation = (otherTenantFound.rowCount ?? 0) === 1 ? "PASS" : "FAIL";
    const otherSpaceFound = await withMemoryTransaction(pool, TENANT_A, [SPACE_OTHER], (client) =>
      client.query("SELECT content FROM memory_items WHERE tenant_id=$1 AND space=$2 AND content=$3", [TENANT_A, SPACE_OTHER, otherSentinel])
    );
    results.q20_space_isolation = (otherSpaceFound.rowCount ?? 0) === 1 ? "PASS" : "FAIL";
    log(`q20_tenant_isolation: ${results.q20_tenant_isolation} q20_space_isolation: ${results.q20_space_isolation}`);
  });

  // ===== §18/§19: ERASURE RECEIPT (finnes, ikke sentinel) =====
  await section("§18/§19 ERASURE RECEIPT SAFETY", async () => {
    const req = await adminPool.query("SELECT * FROM erasure_requests WHERE request_id=$1", [requestId]);
    const fp = await adminPool.query("SELECT * FROM erasure_fingerprints WHERE erasure_request_id=$1", [requestId]);
    const receiptExists = req.rowCount === 1;
    const receiptSafe = !JSON.stringify(req.rows).includes(sentinel) && !JSON.stringify(fp.rows).includes(sentinel);
    results.q20_receipt_safe = receiptExists && receiptSafe ? "PASS" : "FAIL";
    log(`receipt_exists=${receiptExists} receipt_safe=${receiptSafe} -> q20_receipt_safe: ${results.q20_receipt_safe}`);
  });

  // ===== §20: SENTINEL-SCAN AV KJENTE PERSISTENCE STORES =====
  await section("§20 SENTINEL SCAN (kjente persistence stores)", async () => {
    const textColumnsByTable: Record<string, string[]> = {
      knowledge_documents: ["title", "content"],
      knowledge_embeddings: [],
      memory_items: ["subject", "content"],
      memory_versions: ["subject", "content"],
      summaries: ["content"],
      decisions: ["content"],
      commitments: ["content"],
      messages: ["content"],
      erasure_requests: ["scope_summary::text", "error"],
      erasure_fingerprints: ["fingerprint"]
    };
    const hits: string[] = [];
    for (const [table, cols] of Object.entries(textColumnsByTable)) {
      for (const col of cols) {
        const r = await adminPool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} ILIKE $1`, [`%${sentinel}%`]);
        const n = (r.rows[0] as { n: number }).n;
        if (n > 0) hits.push(`${table}.${col}=${n}`);
      }
    }
    results.q20_sentinel_scan = hits.length === 0 ? "PASS" : "FAIL";
    log(`sentinel_scan_hits=${JSON.stringify(hits)} -> q20_sentinel_scan: ${results.q20_sentinel_scan}`);
  });

  // ===== §21: CLEANUP (kun gjenværende test-scaffolding) =====
  await section("§21 CLEANUP", async () => {
    await cleanupTenant(TENANT_A).catch((err: unknown) => log(`cleanup A feilet: ${(err as Error).message}`));
    await cleanupTenant(TENANT_B).catch((err: unknown) => log(`cleanup B feilet: ${(err as Error).message}`));
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch(() => undefined);
    await rm(fsRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  return finish();
}

function finish(): void {
  log("\n== Q-20 LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) {
    log(`${key}=${value}`);
  }
  log(`q21_runtime_role_safe=${diagnostics["runtime_role_superuser"] === "false" && diagnostics["runtime_role_bypassrls"] === "false" ? "PASS" : "FAIL"}`);
  for (const [key, value] of Object.entries(diagnostics)) {
    log(`${key}=${value}`);
  }
  const hardFail = Object.values(results).some((v) => v === "FAIL" || v === "BLOCKED_BY_RUNTIME_ROLE");
  log(`\nrun_id=${runId} hard_fail=${hardFail}`);
}

try {
  await main();
} finally {
  await pool.end();
  await adminPool.end();
}

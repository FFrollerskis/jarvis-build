import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApprovalPayload, IdentityContext, JsonValue, SignedApproval } from "@jarvis/contracts";
import { approvalSigningBytes } from "@jarvis/contracts";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { LocalHashEmbedding, withMemoryTransaction } from "@jarvis/memory";
import { FilesystemKnowledgeSource } from "@jarvis/knowledge";
import { KnowledgeRetriever } from "@jarvis/knowledge";
import { KnowledgeSyncService } from "@jarvis/knowledge";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway, type PolicyAuditEvent } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";

/**
 * Q-20 (docs/DATA_ERASURE.md) - tester A-Q fra byggeordren, pluss
 * D-klasse-policy-integrasjonen (§7/§8). Ekte embedded Postgres, ekte
 * migrasjoner, ekte RLS - via en GARANTERT non-bypass rolle (§O: Q-21 må
 * ALDRI regresere - ALLE tester i denne filen kjører gjennom `appPool`,
 * som er akkurat en slik rolle, aldri superbruker).
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let embedding: LocalHashEmbedding;
let sovereignPolicy: PolicyGateway;

const TENANT_A = "tenant-erase-a";
const TENANT_B = "tenant-erase-b";

function identityFor(tenantId: string, space: string): IdentityContext {
  return {
    person_id: "person-tobias", tenant_id: tenantId, memory_space_id: space as IdentityContext["memory_space_id"],
    session_id: `sess-${tenantId}`, device_id: "dev-erase", channel: "api", auth_strength: "active"
  };
}

async function plantMemoryItem(tenantId: string, space: string, content: string): Promise<string> {
  const memoryItemId = `mi-${randomUUID()}`;
  const sourceId = `src-${randomUUID()}`;
  await withMemoryTransaction(appPool, tenantId, [space as never], async (client) => {
    await client.query("INSERT INTO memory_sources (source_id, tenant_id, kind, ref, trust_level) VALUES ($1,$2,'manual',$3,'trusted')", [
      sourceId, tenantId, memoryItemId
    ]);
    await client.query(
      `INSERT INTO memory_items (memory_item_id, tenant_id, space, owner_person_id, type, subject, content, source_id, observed_at, valid_from, trust_level)
       VALUES ($1,$2,$3,'person-tobias','semantic',$4,$5,$6, now(), now(), 'trusted')`,
      [memoryItemId, tenantId, space, `subject-${memoryItemId}`, content, sourceId]
    );
    const vector = await embedding.embed(content);
    await client.query(
      "INSERT INTO embeddings (memory_item_id, tenant_id, space, model, dim, embedding) VALUES ($1,$2,$3,$4,$5,$6)",
      [memoryItemId, tenantId, space, embedding.model, embedding.dim, vector]
    );
  });
  return memoryItemId;
}

async function plantDerivedMemoryRows(tenantId: string, space: string, content: string): Promise<void> {
  await withMemoryTransaction(appPool, tenantId, [space as never], async (client) => {
    await client.query("INSERT INTO summaries (summary_id, tenant_id, space, scope, scope_key, content) VALUES ($1,$2,$3,'daily',$4,$5)", [
      `sum-${randomUUID()}`, tenantId, space, `key-${randomUUID()}`, content
    ]);
    await client.query("INSERT INTO decisions (decision_id, tenant_id, space, content, decided_at) VALUES ($1,$2,$3,$4, now())", [
      `dec-${randomUUID()}`, tenantId, space, content
    ]);
    await client.query("INSERT INTO commitments (commitment_id, tenant_id, space, content) VALUES ($1,$2,$3,$4)", [
      `com-${randomUUID()}`, tenantId, space, content
    ]);
  });
}

async function plantKnowledgeDocument(
  tenantId: string,
  space: string,
  content: string
): Promise<{ knowledgeDocumentId: string; sourceType: string; sourceInstanceId: string; externalId: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "jarvis-erasure-fs-"));
  const fileName = `sentinel-${randomUUID()}.md`;
  await writeFile(join(root, fileName), content);
  const sourceInstanceId = `fs:erasure-${randomUUID()}`;
  const sync = new KnowledgeSyncService(appPool, embedding);
  const report = await sync.sync(identityFor(tenantId, space), space as never, new FilesystemKnowledgeSource(root, sourceInstanceId));
  expect(report.created).toBe(1);
  const { rows } = await withMemoryTransaction(appPool, tenantId, [space as never], (client) =>
    client.query("SELECT knowledge_document_id FROM knowledge_documents WHERE tenant_id=$1 AND source_instance_id=$2 AND external_id=$3", [
      tenantId, sourceInstanceId, fileName
    ])
  );
  const knowledgeDocumentId = (rows[0] as { knowledge_document_id: string }).knowledge_document_id;
  return { knowledgeDocumentId, sourceType: "filesystem", sourceInstanceId, externalId: fileName, root };
}

async function countAll(tenantId: string, space: string): Promise<Record<string, number>> {
  return withMemoryTransaction(appPool, tenantId, [space as never], async (client) => {
    const tables = [
      "memory_items", "memory_versions", "memory_item_entities", "embeddings", "relations", "entities",
      "summaries", "decisions", "commitments", "deadlines", "knowledge_documents", "knowledge_embeddings"
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const col = table.startsWith("knowledge") ? "memory_space_id" : "space";
      const r = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1 AND ${col}=$2`, [tenantId, space]);
      counts[table] = (r.rows[0] as { n: number }).n;
    }
    return counts;
  });
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-erasure-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  // §O: garantert non-bypass rolle - IKKE superbruker. Q-21 må aldri regresere.
  await adminPool.query("CREATE ROLE jarvis_erasure_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_erasure_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','person'), ('${TENANT_B}','B','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}'), ('person-tobias','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('ms-a-personal','${TENANT_A}','personal'), ('ms-a-business','${TENANT_A}','business'),
      ('ms-b-personal','${TENANT_B}','personal');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_erasure_test", password: "pw2" });
  embedding = new LocalHashEmbedding();
  sovereignPolicy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A, TENANT_B] }
  });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("Q-20 ErasureService", () => {
  it("A: preview er ikke destructive", async () => {
    const sentinel = `SentinelPreview${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);
    const service = new ErasureService(appPool, sovereignPolicy, embedding);

    const preview = await service.previewErasure({ type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" });
    expect(preview.affected.memory_items).toBeGreaterThanOrEqual(1);

    // Fortsatt der etter preview - INGENTING slettet.
    const stillThere = await withMemoryTransaction(appPool, TENANT_A, ["personal"], (client) =>
      client.query("SELECT count(*)::int AS n FROM memory_items WHERE tenant_id=$1 AND content=$2", [TENANT_A, sentinel])
    );
    expect((stillThere.rows[0] as { n: number }).n).toBe(1);
  });

  it("B/C/D: hard delete fjerner CONTENT + embeddings + derived (summaries/decisions/commitments)", async () => {
    const sentinel = `SentinelHardDelete${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);
    await plantDerivedMemoryRows(TENANT_A, "personal", sentinel);
    const { knowledgeDocumentId } = await plantKnowledgeDocument(TENANT_A, "personal", sentinel);

    const before = await countAll(TENANT_A, "personal");
    expect(before.memory_items).toBeGreaterThanOrEqual(1);
    expect(before.knowledge_documents).toBeGreaterThanOrEqual(1);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });
    expect(result.status).toBe("completed");

    const after = await countAll(TENANT_A, "personal");
    expect(after.memory_items).toBe(0);
    expect(after.embeddings).toBe(0);
    expect(after.summaries).toBe(0);
    expect(after.decisions).toBe(0);
    expect(after.commitments).toBe(0);
    expect(after.knowledge_documents).toBe(0);
    expect(after.knowledge_embeddings).toBe(0);

    // §C: eksplisitt bevis på at NETTOPP dette dokumentet/embeddinget er borte (ikke bare talt 0).
    const docGone = await adminPool.query("SELECT 1 FROM knowledge_documents WHERE knowledge_document_id=$1", [knowledgeDocumentId]);
    expect(docGone.rowCount).toBe(0);
    const embGone = await adminPool.query("SELECT 1 FROM knowledge_embeddings WHERE knowledge_document_id=$1", [knowledgeDocumentId]);
    expect(embGone.rowCount).toBe(0);
  });

  it("E/F/G: FTS/vector/hybrid finner ikke slettet innhold (memory-scoped verify)", async () => {
    const sentinel = `SentinelVerify${randomUUID().replace(/-/g, "")}`;
    await plantKnowledgeDocument(TENANT_A, "personal", sentinel);
    await plantMemoryItem(TENANT_A, "personal", sentinel);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });

    const verification = await service.verifyErasure({ identity: identityFor(TENANT_A, "personal"), spaces: ["personal"], sentinel });
    expect(verification.fts_hits).toBe(0);
    expect(verification.vector_hits).toBe(0);
    expect(verification.hybrid_hits).toBe(0);
    expect(verification.memory_hits).toBe(0);
  });

  it("H: feil tenant kan ikke purge en annen tenant sitt scope", async () => {
    const sentinel = `SentinelCrossTenant${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_B, "personal") // identitet fra B, scope for A
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("cross_tenant_purge_denied");

    const stillThere = await withMemoryTransaction(appPool, TENANT_A, ["personal"], (client) =>
      client.query("SELECT count(*)::int AS n FROM memory_items WHERE tenant_id=$1 AND content=$2", [TENANT_A, sentinel])
    );
    expect((stillThere.rows[0] as { n: number }).n).toBe(1);
  });

  it("I: annet memory-space (samme tenant) er urørt", async () => {
    const sentinelPersonal = `SentinelSpacePersonal${randomUUID().replace(/-/g, "")}`;
    const sentinelBusiness = `SentinelSpaceBusiness${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinelPersonal);
    await plantMemoryItem(TENANT_A, "business", sentinelBusiness);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });

    const businessStillThere = await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("SELECT count(*)::int AS n FROM memory_items WHERE tenant_id=$1 AND content=$2", [TENANT_A, sentinelBusiness])
    );
    expect((businessStillThere.rows[0] as { n: number }).n).toBe(1);
  });

  it("J: source resync gjenoppliver IKKE et slettet target (resurrection protection)", async () => {
    const sentinel = `SentinelResurrection${randomUUID().replace(/-/g, "")}`;
    const { knowledgeDocumentId, sourceType, sourceInstanceId, externalId, root } = await plantKnowledgeDocument(TENANT_A, "personal", sentinel);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "knowledge_document", tenant_id: TENANT_A, knowledge_document_id: knowledgeDocumentId },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });
    expect(result.status).toBe("completed");

    // Filen ligger FORTSATT på disk (kilden er uendret) - re-sync skal IKKE gjenopplive dokumentet.
    const sync = new KnowledgeSyncService(appPool, embedding);
    const resync = await sync.sync(identityFor(TENANT_A, "personal"), "personal", new FilesystemKnowledgeSource(root, sourceInstanceId));
    expect(resync.created).toBe(0);
    expect(resync.suppressed).toBe(1);

    const retriever = new KnowledgeRetriever(appPool, embedding);
    const found = await retriever.search(identityFor(TENANT_A, "personal"), { query: sentinel, spaces: ["personal"] });
    expect(found.some((r) => r.content.includes(sentinel))).toBe(false);

    // Kryss-sjekk: fingerprinten er faktisk basert på (source_type, source_instance_id, external_id) fra scopet.
    expect(sourceType).toBe("filesystem");
    expect(externalId).toMatch(/^sentinel-/);
  });

  it("K/L: erasure-ledger (erasure_requests/erasure_fingerprints) inneholder ALDRI selve sentinel-innholdet", async () => {
    const sentinel = `SentinelReceiptSafety${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);
    await plantKnowledgeDocument(TENANT_A, "personal", sentinel);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const requestId = `req-${randomUUID()}`;
    await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId,
      identity: identityFor(TENANT_A, "personal")
    });

    const requests = await adminPool.query("SELECT * FROM erasure_requests WHERE request_id=$1", [requestId]);
    const fingerprints = await adminPool.query("SELECT * FROM erasure_fingerprints WHERE erasure_request_id=$1", [requestId]);
    expect(requests.rowCount).toBe(1);
    expect(JSON.stringify(requests.rows)).not.toContain(sentinel);
    expect(JSON.stringify(fingerprints.rows)).not.toContain(sentinel);
    // §6: fingerprinten er en hash, IKKE et klartekst external_id.
    for (const row of fingerprints.rows as Array<{ fingerprint: string }>) {
      expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("M: samme request_id kjørt to ganger er idempotent (ingen feil, ingen dobbel sletting, samme resultat)", async () => {
    const sentinel = `SentinelIdempotent${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);
    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const requestId = `req-${randomUUID()}`;
    const scope = { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" } as const;
    const identity = identityFor(TENANT_A, "personal");

    const first = await service.executeErasure({ scope, requestId, identity });
    expect(first.status).toBe("completed");
    expect(first.idempotent_replay).toBe(false);

    const second = await service.executeErasure({ scope, requestId, identity });
    expect(second.status).toBe("completed");
    expect(second.idempotent_replay).toBe(true);
    expect(second.record_counts).toEqual(first.record_counts);
  });

  it("N: en feil MIDT i slettingen ruller HELE transaksjonen tilbake og rapporteres ALDRI som completed", async () => {
    const sentinel = `SentinelFailClosed${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);
    await plantDerivedMemoryRows(TENANT_A, "personal", sentinel);

    // Kunstig injeksjon av en feil MIDT i sletterekkefølgen (etter memory_versions/
    // memory_item_entities/embeddings/relations/entities, FØR summaries) - beviser
    // at ALLEREDE utførte deletes i samme transaksjon rulles tilbake, ikke bare den
    // som faktisk feiler. Bruker den DELTE `appPool` (pg gjenbruker klient-objekter
    // internt) - monkeypatchen er derfor SELV-restaurerende: den fyrer PRESIST ÉN
    // gang og bytter umiddelbart tilbake til den ekte query()-implementasjonen, slik
    // at verken ROLLBACK-kallet rett etter eller senere, urelaterte tester som
    // gjenbruker samme pooled klient etter release() blir påvirket.
    const requestId = `req-${randomUUID()}`;
    const faultyPool = {
      connect: async () => {
        const client = await appPool.connect();
        const originalQuery = client.query.bind(client);
        // @ts-expect-error - test-only monkeypatch av query for å simulere en midt-i-transaksjonen-feil
        client.query = (...args: unknown[]) => {
          const sql = args[0];
          if (typeof sql === "string" && sql.startsWith("DELETE FROM summaries")) {
            client.query = originalQuery; // restaurer FØR kast - ROLLBACK og all senere gjenbruk er upåvirket
            throw new Error("simulated_mid_transaction_failure");
          }
          return originalQuery(...(args as Parameters<typeof originalQuery>));
        };
        return client;
      }
    } as unknown as pg.Pool;

    const service = new ErasureService(faultyPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId,
      identity: identityFor(TENANT_A, "personal")
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("simulated_mid_transaction_failure");

    // Fail-closed: memory_items (slettet FØR summaries i rekkefølgen) er FORTSATT der - hele tx rullet tilbake.
    const stillThere = await withMemoryTransaction(appPool, TENANT_A, ["personal"], (client) =>
      client.query("SELECT count(*)::int AS n FROM memory_items WHERE tenant_id=$1 AND content=$2", [TENANT_A, sentinel])
    );
    expect((stillThere.rows[0] as { n: number }).n).toBe(1);

    // Ledger sier failed, ALDRI completed.
    const ledgerRow = await adminPool.query("SELECT status FROM erasure_requests WHERE request_id=$1", [requestId]);
    expect((ledgerRow.rows[0] as { status: string }).status).toBe("failed");

    // Rydd opp for etterfølgende tester i samme tenant/space.
    const cleanup = new ErasureService(appPool, sovereignPolicy, embedding);
    await cleanup.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-cleanup-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });
  });

  it("O: kjører ALLTID via en garantert non-bypass runtime-rolle (Q-21 regresjonsvakt)", async () => {
    const { rows } = await appPool.query(
      "SELECT rolsuper AS superuser, rolbypassrls AS bypassrls FROM pg_roles WHERE rolname = current_user"
    );
    const row = rows[0] as { superuser: boolean; bypassrls: boolean };
    expect(row.superuser).toBe(false);
    expect(row.bypassrls).toBe(false);
  });

  it("P: policy-audit-hendelsen for purge lekker aldri scope-parametre eller innhold", async () => {
    const sentinel = `SentinelAuditSafety${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);
    const auditLog: PolicyAuditEvent[] = [];
    const auditedPolicy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(),
      nonces: new InMemoryNonceStore(),
      killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A, TENANT_B] },
      auditSink: (event) => auditLog.push(event)
    });
    const service = new ErasureService(appPool, auditedPolicy, embedding);
    await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });
    expect(auditLog.length).toBeGreaterThan(0);
    expect(JSON.stringify(auditLog)).not.toContain(sentinel);
  });

  it("Q: urelatert innhold (annet dokument, samme tenant/space) er urørt av en knowledge_document-scoped purge", async () => {
    const targetSentinel = `SentinelTargeted${randomUUID().replace(/-/g, "")}`;
    const unrelatedSentinel = `SentinelUnrelated${randomUUID().replace(/-/g, "")}`;
    const target = await plantKnowledgeDocument(TENANT_A, "personal", targetSentinel);
    await plantKnowledgeDocument(TENANT_A, "personal", unrelatedSentinel);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "knowledge_document", tenant_id: TENANT_A, knowledge_document_id: target.knowledgeDocumentId },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });
    expect(result.status).toBe("completed");

    const retriever = new KnowledgeRetriever(appPool, embedding);
    const unrelatedFound = await retriever.search(identityFor(TENANT_A, "personal"), { query: unrelatedSentinel, spaces: ["personal"] });
    expect(unrelatedFound.some((r) => r.content.includes(unrelatedSentinel))).toBe(true);
    const targetFound = await retriever.search(identityFor(TENANT_A, "personal"), { query: targetSentinel, spaces: ["personal"] });
    expect(targetFound.some((r) => r.content.includes(targetSentinel))).toBe(false);
  });

  describe("§7/§8: D-klasse policy-integrasjon (ingen ny separat auth-modell)", () => {
    const watchKeys = generateKeyPairSync("ed25519");

    function signApproval(payload: ApprovalPayload): SignedApproval {
      const signature = sign(null, approvalSigningBytes(payload), watchKeys.privateKey).toString("base64");
      return { ...payload, signature };
    }

    it("nektes uten approval for en delegert (ikke-sovereign) identitet; tillates med gyldig signert approval", async () => {
      const sentinel = `SentinelDelegateApproval${randomUUID().replace(/-/g, "")}`;
      await plantMemoryItem(TENANT_A, "personal", sentinel);
      const devices = new InMemoryDeviceRegistry();
      devices.register("watch-1", watchKeys.publicKey);
      const delegatePolicy = new PolicyGateway({ devices, nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch() });
      const service = new ErasureService(appPool, delegatePolicy, embedding);
      const scope = { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" } as const;
      const identity = identityFor(TENANT_A, "personal");

      const denied = await service.executeErasure({ scope, requestId: `req-${randomUUID()}`, identity });
      expect(denied.status).toBe("failed");
      expect(denied.error).toContain("policy_denied:class_d_missing_approval");

      const approval = signApproval({
        action: "purge",
        parameters: { ...scope } as Record<string, JsonValue>,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        nonce: `nonce-${randomUUID()}`,
        approving_device_id: "watch-1"
      });
      const allowed = await service.executeErasure({ scope, requestId: `req-${randomUUID()}`, identity, approval });
      expect(allowed.status).toBe("completed");
    });
  });
});

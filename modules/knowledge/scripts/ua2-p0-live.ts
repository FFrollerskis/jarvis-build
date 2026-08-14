// UA-2 P0 FINAL HOST ACCEPTANCE HARNESS - kjøres AV TOBIAS på Windows-hosten mot
// ekte lokal Postgres/pgvector (docker-compose) og ekte filsystem. Gjenbruker
// KUN eksisterende arkitektur (@jarvis/knowledge, @jarvis/core, @jarvis/policy,
// @jarvis/tool-gateway, @jarvis/memory) - ingen alternativ testimplementasjon.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/knowledge/scripts/ua2-p0-live.ts
//
// Skriver ALDRI secrets/dokumentinnhold til stdout - kun statuser, telling,
// score og korte trygge nøkkelord (§6). All test-scaffolding under
// var/ua2-p0-live-test/<runId>/ (gitignored) og unike, idempotente run-IDer
// slik at harnesset trygt kan kjøres flere ganger (§6).

import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { configFromEnv, createPool, PgApprovalStore, PgDeviceRegistry } from "@jarvis/core";
import { LocalHashEmbedding, withMemoryTransaction } from "@jarvis/memory";
import { KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { EnvSecretProvider, GithubTransport, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { FilesystemKnowledgeSource } from "../src/filesystem-source.ts";
import { GithubKnowledgeSource } from "../src/github-source.ts";
import { KnowledgeRetriever } from "../src/retriever.ts";
import { KnowledgeSyncService } from "../src/sync.ts";

type Verdict = "PASS" | "FAIL" | "SKIPPED" | "SKIPPED_HOST_PERMISSION" | "SKIPPED_NO_CREDENTIAL";

const results: Record<string, Verdict> = {
  filesystem_ingest: "FAIL",
  unchanged_resync: "FAIL",
  update_same_canonical: "FAIL",
  tombstone: "FAIL",
  reactivation: "FAIL",
  provenance: "FAIL",
  fts: "FAIL",
  vector: "FAIL",
  hybrid: "FAIL",
  tenant_isolation: "FAIL",
  memory_space_isolation: "FAIL",
  filesystem_allowlist: "FAIL",
  traversal_deny: "FAIL",
  symlink_escape: "FAIL",
  github_live: "FAIL"
};
let duplicateDocuments = -1;

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
const varRoot = join(process.cwd(), "var", "ua2-p0-live-test", runId);
log(`UA-2 P0 LIVE ACCEPTANCE - run_id=${runId}`);

const pool = createPool(configFromEnv());
const embedding = new LocalHashEmbedding(); // samme EmbeddingProvider som apps/api/src/main.ts sin ekte wiring
const sync = new KnowledgeSyncService(pool, embedding);
const retriever = new KnowledgeRetriever(pool, embedding);

const ownerTenant = process.env["JARVIS_TENANT_ID"] ?? "tenant-personal";
const ownerPerson = process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias";
const ownerIdentity: IdentityContext = {
  person_id: ownerPerson,
  tenant_id: ownerTenant,
  memory_space_id: "personal",
  session_id: `sess-ua2-p0-live-${runId}`,
  device_id: "jarvis-core",
  channel: "api",
  auth_strength: "active"
};
const fsSourceInstanceId = `fs:ua2-p0-live-${runId}`;
const isoSourceInstanceId = `fs:ua2-p0-live-space-${runId}`;

async function countDocs(
  identity: IdentityContext,
  spaces: MemorySpace[],
  sourceInstanceId: string,
  externalId: string
): Promise<number> {
  return withMemoryTransaction(pool, identity.tenant_id, spaces, async (client) => {
    const r = await client.query(
      "SELECT COUNT(*)::int AS n FROM knowledge_documents WHERE source_instance_id = $1 AND external_id = $2",
      [sourceInstanceId, externalId]
    );
    return (r.rows[0] as { n: number }).n;
  });
}

async function deleteBySourceInstance(identity: IdentityContext, spaces: MemorySpace[], sourceInstanceId: string): Promise<void> {
  await withMemoryTransaction(pool, identity.tenant_id, spaces, async (client) => {
    await client.query(
      `DELETE FROM knowledge_embeddings WHERE knowledge_document_id IN
         (SELECT knowledge_document_id FROM knowledge_documents WHERE source_instance_id = $1)`,
      [sourceInstanceId]
    );
    await client.query("DELETE FROM knowledge_documents WHERE source_instance_id = $1", [sourceInstanceId]);
  });
}

async function deleteTenant(tenantId: string): Promise<void> {
  await withMemoryTransaction(pool, tenantId, ["personal", "business"], async (client) => {
    await client.query(
      `DELETE FROM knowledge_embeddings WHERE knowledge_document_id IN
         (SELECT knowledge_document_id FROM knowledge_documents WHERE tenant_id = $1)`,
      [tenantId]
    );
    await client.query("DELETE FROM knowledge_documents WHERE tenant_id = $1", [tenantId]);
  });
  await pool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  // §6: best-effort opprydding fra evt. krasjede tidligere kjøringer - trygt å
  // kjøre selv om ingenting finnes (idempotent).
  try {
    const stale = await pool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-ua2-p0-iso-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) {
      await deleteTenant(row.tenant_id).catch(() => undefined);
    }
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  await mkdir(varRoot, { recursive: true });
  await selfHeal();

  const pgVectorRow = await pool.query(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='knowledge_embeddings' AND column_name='vec') AS has"
  );
  const pgVectorActive = (pgVectorRow.rows[0] as { has: boolean }).has;
  log(`pgvector_extension_active=${pgVectorActive} (ekte Docker-Postgres forventes true)`);

  // ===== §1: FILESYSTEM LIVE ACCEPTANCE (fullstendig livssyklus) =====
  await section("§1 FILESYSTEM LIVE ACCEPTANCE", async () => {
    const fsRoot = join(varRoot, "fs-root");
    await mkdir(fsRoot, { recursive: true });
    const filePath = join(fsRoot, "aurora-fact.md");
    const source = () => new FilesystemKnowledgeSource(fsRoot, fsSourceInstanceId);

    // 1. Opprett fil med unik fakta-streng.
    await writeFile(filePath, "Prosjekt Aurora bruker kodeord FJORD-742.");
    const r1 = await sync.sync(ownerIdentity, "personal", source());
    results.filesystem_ingest =
      r1.scanned === 1 && r1.created === 1 && r1.failed === 0 ? "PASS" : "FAIL";
    log(`ingest: scanned=${r1.scanned} created=${r1.created} failed=${r1.failed} -> ${results.filesystem_ingest}`);

    const found1 = await retriever.search(ownerIdentity, { query: "FJORD-742", spaces: ["personal"] });
    const hit1 = found1.find((r) => r.provenance.source_instance_id === fsSourceInstanceId);
    const provenanceOk1 =
      !!hit1 &&
      hit1.provenance.source_type === "filesystem" &&
      hit1.provenance.external_id === "aurora-fact.md" &&
      hit1.provenance.canonical_uri.includes("aurora-fact.md") &&
      hit1.provenance.content_hash.length === 64 &&
      hit1.provenance.version === 1;
    log(`retrieval etter ingest: treff=${!!hit1} provenance_shape_ok=${provenanceOk1}`);

    // 2. Uendret resync -> nær no-op.
    const r2 = await sync.sync(ownerIdentity, "personal", source());
    results.unchanged_resync =
      r2.scanned === 1 && r2.created === 0 && r2.updated === 0 && r2.unchanged === 1 && r2.tombstoned === 0
        ? "PASS"
        : "FAIL";
    const countAfterUnchanged = await countDocs(ownerIdentity, ["personal"], fsSourceInstanceId, "aurora-fact.md");
    if (countAfterUnchanged !== 1) results.unchanged_resync = "FAIL";
    log(`uendret resync: ${JSON.stringify(r2)} dokument_count=${countAfterUnchanged} -> ${results.unchanged_resync}`);

    // 3. Endre fil -> ny hash/versjon, samme canonical document.
    await writeFile(filePath, "Prosjekt Aurora bruker kodeord FJORD-913.");
    const r3 = await sync.sync(ownerIdentity, "personal", source());
    const found3 = await retriever.search(ownerIdentity, { query: "FJORD-913", spaces: ["personal"] });
    const found3Old = await retriever.search(ownerIdentity, { query: "FJORD-742", spaces: ["personal"] });
    const hit3 = found3.find((r) => r.provenance.source_instance_id === fsSourceInstanceId);
    results.update_same_canonical =
      r3.scanned === 1 &&
      r3.created === 0 &&
      r3.updated === 1 &&
      !!hit3 &&
      hit3.provenance.version === 2 &&
      !found3Old.some((r) => r.provenance.source_instance_id === fsSourceInstanceId)
        ? "PASS"
        : "FAIL";
    log(
      `endring: ${JSON.stringify(r3)} ny_versjon=${hit3?.provenance.version} gammel_fakta_borte=${!found3Old.some((r) => r.provenance.source_instance_id === fsSourceInstanceId)} -> ${results.update_same_canonical}`
    );

    // 4. Slett fil -> tombstone, ikke i normal retrieval.
    await rm(filePath);
    const r4 = await sync.sync(ownerIdentity, "personal", source());
    const found4 = await retriever.search(ownerIdentity, { query: "FJORD-913", spaces: ["personal"] });
    results.tombstone =
      r4.scanned === 0 &&
      r4.tombstoned === 1 &&
      !found4.some((r) => r.provenance.source_instance_id === fsSourceInstanceId)
        ? "PASS"
        : "FAIL";
    log(`sletting: ${JSON.stringify(r4)} fortsatt_synlig=${found4.some((r) => r.provenance.source_instance_id === fsSourceInstanceId)} -> ${results.tombstone}`);

    // 5. Gjenopprett fil (samme innhold som før sletting) -> deterministisk reaktivering, ingen duplikat.
    await writeFile(filePath, "Prosjekt Aurora bruker kodeord FJORD-913.");
    const r5 = await sync.sync(ownerIdentity, "personal", source());
    const found5 = await retriever.search(ownerIdentity, { query: "FJORD-913", spaces: ["personal"] });
    const countAfterReactivate = await countDocs(ownerIdentity, ["personal"], fsSourceInstanceId, "aurora-fact.md");
    results.reactivation =
      r5.scanned === 1 &&
      r5.created === 0 &&
      r5.reactivated === 1 &&
      countAfterReactivate === 1 &&
      found5.some((r) => r.provenance.source_instance_id === fsSourceInstanceId)
        ? "PASS"
        : "FAIL";
    log(`reaktivering: ${JSON.stringify(r5)} dokument_count=${countAfterReactivate} -> ${results.reactivation}`);

    duplicateDocuments = Math.max(0, countAfterReactivate - 1);
    results.provenance = provenanceOk1 ? "PASS" : "FAIL";
  });

  // ===== §5: REAL PGVECTOR (fts/vector/hybrid) - gjenbruker samme SQL-primitiver som retriever.ts/suite-testen =====
  await section("§5 REAL PGVECTOR (fts/vector/hybrid)", async () => {
    const ftsHits = await retriever.search(ownerIdentity, { query: "FJORD-913", spaces: ["personal"] });
    results.fts = ftsHits.some((r) => r.provenance.source_instance_id === fsSourceInstanceId) ? "PASS" : "FAIL";
    log(`fts: treff=${ftsHits.length} -> ${results.fts}`);

    const vecA = await embedding.embed("Prosjekt Aurora bruker kodeord FJORD-913.");
    const vecB = await embedding.embed("Prosjektet Aurora har kodeordet FJORD-913.");
    const simRow = await pool.query("SELECT cosine_sim($1::real[], $2::real[]) AS sim", [vecA, vecB]);
    const sim = Number((simRow.rows[0] as { sim: number }).sim);
    results.vector = sim >= 0.4 ? "PASS" : "FAIL";
    log(`vector: cosine_sim(nesten-duplikat)=${sim.toFixed(3)} (terskel 0.4) -> ${results.vector}`);
    if (results.vector === "PASS" && pgVectorActive) {
      const pgvRow = await pool.query("SELECT 1 - (($1::text)::vector <=> ($2::text)::vector) AS sim", [
        JSON.stringify(vecA),
        JSON.stringify(vecB)
      ]);
      log(`vector: ekte pgvector-operator sim=${Number((pgvRow.rows[0] as { sim: number }).sim).toFixed(3)}`);
    }

    const hybrid = await retriever.search(ownerIdentity, { query: "Aurora FJORD-913", spaces: ["personal"] });
    const top = hybrid[0];
    results.hybrid = !!top && hybrid.some((r) => r.provenance.source_instance_id === fsSourceInstanceId) ? "PASS" : "FAIL";
    log(`hybrid: topp-score=${top?.score.toFixed(3)} topp-kilde=${top?.provenance.source_type} -> ${results.hybrid}`);
  });

  // ===== §2: RLS / TENANT + MEMORY-SPACE ISOLASJON (isolerte kasttenants, ryddes opp) =====
  await section("§2 RLS/TENANT+MEMORY-SPACE ISOLASJON", async () => {
    const tenantA = `tenant-ua2-p0-iso-a-${runId}`;
    const tenantB = `tenant-ua2-p0-iso-b-${runId}`;
    await pool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,'UA2-P0-ISO-A','person')", [tenantA]);
    await pool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,'UA2-P0-ISO-B','person')", [tenantB]);
    await pool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [ownerPerson, tenantA]);
    await pool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [ownerPerson, tenantB]);

    const identityA: IdentityContext = { ...ownerIdentity, tenant_id: tenantA, session_id: `sess-iso-a-${runId}` };
    const identityB: IdentityContext = { ...ownerIdentity, tenant_id: tenantB, session_id: `sess-iso-b-${runId}` };

    try {
      const rootA = join(varRoot, "iso-a");
      const rootB = join(varRoot, "iso-b");
      await mkdir(rootA, { recursive: true });
      await mkdir(rootB, { recursive: true });
      await writeFile(join(rootA, "hemmelig-a.md"), `TenantIsoUniktOrdA-${runId}`);
      await writeFile(join(rootB, "hemmelig-b.md"), `TenantIsoUniktOrdB-${runId}`);
      await sync.sync(identityA, "personal", new FilesystemKnowledgeSource(rootA, `fs:iso-a-${runId}`));
      await sync.sync(identityB, "personal", new FilesystemKnowledgeSource(rootB, `fs:iso-b-${runId}`));

      const aSeesB = await retriever.search(identityA, { query: `TenantIsoUniktOrdB-${runId}`, spaces: ["personal"] });
      const bSeesA = await retriever.search(identityB, { query: `TenantIsoUniktOrdA-${runId}`, spaces: ["personal"] });
      const aFindsOwn = await retriever.search(identityA, { query: `TenantIsoUniktOrdA-${runId}`, spaces: ["personal"] });
      results.tenant_isolation = aSeesB.length === 0 && bSeesA.length === 0 && aFindsOwn.length > 0 ? "PASS" : "FAIL";
      log(`tenant_isolation: a_ser_b=${aSeesB.length} b_ser_a=${bSeesA.length} a_finner_egen=${aFindsOwn.length} -> ${results.tenant_isolation}`);

      const rootSpace = join(varRoot, "iso-space");
      await mkdir(rootSpace, { recursive: true });
      await writeFile(join(rootSpace, "biz.md"), `SpaceIsoUniktOrd-${runId}`);
      await sync.sync(identityA, "business", new FilesystemKnowledgeSource(rootSpace, isoSourceInstanceId));
      const personalSearch = await retriever.search(identityA, { query: `SpaceIsoUniktOrd-${runId}`, spaces: ["personal"] });
      const businessSearch = await retriever.search(identityA, { query: `SpaceIsoUniktOrd-${runId}`, spaces: ["business"] });
      results.memory_space_isolation = personalSearch.length === 0 && businessSearch.length > 0 ? "PASS" : "FAIL";
      log(
        `memory_space_isolation: personal_ser_business=${personalSearch.length} business_finner=${businessSearch.length} -> ${results.memory_space_isolation}`
      );
    } finally {
      await deleteTenant(tenantA).catch((err: unknown) => log(`opprydding tenantA feilet: ${(err as Error).message}`));
      await deleteTenant(tenantB).catch((err: unknown) => log(`opprydding tenantB feilet: ${(err as Error).message}`));
    }
  });

  // ===== §3: FILESYSTEM SECURITY LIVE =====
  await section("§3 FILESYSTEM SECURITY LIVE", async () => {
    const secRoot = join(varRoot, "sec-root");
    const outsideRoot = join(varRoot, "sec-outside");
    await mkdir(secRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(join(secRoot, "lovlig.md"), "lovlig innhold innenfor roten");
    await writeFile(join(outsideRoot, "hemmelig.md"), "hemmelig innhold utenfor allowlistet rot");

    // allowlist: kun filer innenfor roten listes, aldri noe fra en sidestilt mappe.
    const allowlistRecords = await new FilesystemKnowledgeSource(secRoot).list();
    results.filesystem_allowlist =
      allowlistRecords.some((r) => r.external_id === "lovlig.md") &&
      !allowlistRecords.some((r) => r.content.includes("hemmelig"))
        ? "PASS"
        : "FAIL";
    log(`filesystem_allowlist: filer=${allowlistRecords.length} -> ${results.filesystem_allowlist}`);

    // traversal: en rootPath med bokstavelige '..'-segmenter nøytraliseres av resolve() - ingen ekstern innhold lekker inn.
    await mkdir(join(secRoot, "sub"), { recursive: true });
    await writeFile(join(secRoot, "sub", "fil.txt"), "innhold i undermappe");
    const traversalRecords = await new FilesystemKnowledgeSource(join(secRoot, "sub", "..", "sub")).list();
    results.traversal_deny =
      traversalRecords.length === 1 && traversalRecords[0]?.external_id === "fil.txt" ? "PASS" : "FAIL";
    log(`traversal_deny: filer=${traversalRecords.length} -> ${results.traversal_deny}`);

    // symlink escape: symlink INNENFOR roten som peker UT av roten - hoppes over, ikke fake PASS uten faktisk privilegium.
    try {
      await symlink(join(outsideRoot, "hemmelig.md"), join(secRoot, "lenke-ut.md"));
    } catch {
      results.symlink_escape = "SKIPPED_HOST_PERMISSION";
    }
    if (results.symlink_escape !== "SKIPPED_HOST_PERMISSION") {
      const symlinkRecords = await new FilesystemKnowledgeSource(secRoot).list();
      results.symlink_escape =
        symlinkRecords.some((r) => r.external_id === "lovlig.md") &&
        !symlinkRecords.some((r) => r.content.includes("hemmelig")) &&
        !symlinkRecords.some((r) => r.external_id === "lenke-ut.md")
          ? "PASS"
          : "FAIL";
    }
    log(`symlink_escape: ${results.symlink_escape}`);
  });

  // ===== §4: GITHUB LIVE SOURCE =====
  await section("§4 GITHUB LIVE SOURCE", async () => {
    const token = process.env["JARVIS_GITHUB_TOKEN"];
    if (!token) {
      results.github_live = "SKIPPED_NO_CREDENTIAL";
      log("JARVIS_GITHUB_TOKEN mangler -> github_live=SKIPPED_NO_CREDENTIAL (endrer ikke scope)");
      return;
    }
    const repo = process.env["JARVIS_GITHUB_REPO"] ?? "tsworkflow/jarvisbuild";
    const killSwitch = new KillSwitch();
    const deviceRegistry = new PgDeviceRegistry(pool, ownerTenant);
    await deviceRegistry.refresh().catch(() => undefined);
    const policy = new PolicyGateway({
      devices: deviceRegistry,
      nonces: new PgApprovalStore(pool),
      killSwitch,
      authority: { owner_person_id: ownerPerson, owner_tenants: [ownerTenant] }
    });
    const toolGateway = new ToolGateway(pool, policy, new EnvSecretProvider(), new OwnerControls(killSwitch));
    for (const tool of firstWaveTools({ github: new GithubTransport() })) toolGateway.register(tool);

    const githubSourceInstanceId = `github:${repo}`;
    const githubSource = new GithubKnowledgeSource(toolGateway, ownerIdentity, repo);
    const r1 = await sync.sync(ownerIdentity, "personal", githubSource);
    const countBefore = await withMemoryTransaction(pool, ownerTenant, ["personal"], async (client) => {
      const q = await client.query(
        "SELECT knowledge_document_id, external_id, content_hash, version FROM knowledge_documents WHERE source_instance_id = $1 AND deleted = false",
        [githubSourceInstanceId]
      );
      return q.rows as Array<{ knowledge_document_id: string; external_id: string; content_hash: string; version: number }>;
    });
    log(`github sync #1: ${JSON.stringify(r1)} dokumenter_nå=${countBefore.length}`);

    if (r1.failed > 0 || countBefore.length === 0) {
      results.github_live = "FAIL";
      log("github_live: FAIL (ingen dokumenter ble faktisk ingestet - sjekk credential/nettverk på host)");
      return;
    }
    const stableProvenanceOk = countBefore.every(
      (d) => (d.external_id.startsWith("repo:") || d.external_id.startsWith("issue:")) && d.content_hash.length === 64
    );

    // resync -> dedupe/no duplicate.
    const r2 = await sync.sync(ownerIdentity, "personal", githubSource);
    const countAfter = await withMemoryTransaction(pool, ownerTenant, ["personal"], async (client) => {
      const q = await client.query(
        "SELECT COUNT(*)::int AS n FROM knowledge_documents WHERE source_instance_id = $1 AND deleted = false",
        [githubSourceInstanceId]
      );
      return (q.rows[0] as { n: number }).n;
    });
    log(`github sync #2 (resync): ${JSON.stringify(r2)} dokumenter_nå=${countAfter}`);

    results.github_live =
      stableProvenanceOk && r2.created === 0 && r2.failed === 0 && countAfter === countBefore.length ? "PASS" : "FAIL";
    log(`github_live: source_type=github stabil_provenance=${stableProvenanceOk} ingen_duplikat=${countAfter === countBefore.length} -> ${results.github_live}`);
    log("MERK: github-dokumentene beholdes i tenant/space (ekte data, ikke test-scaffolding) - ikke ryddet opp.");
  });

  // Opprydding av synteststed for §1/§5 (ownerTenant er ekte - kun den syntetiske test-kilden fjernes).
  await deleteBySourceInstance(ownerIdentity, ["personal"], fsSourceInstanceId).catch((err: unknown) =>
    log(`opprydding fs-test-dokument feilet: ${(err as Error).message}`)
  );
  await deleteBySourceInstance(ownerIdentity, ["business"], isoSourceInstanceId).catch(() => undefined);
  await rm(varRoot, { recursive: true, force: true }).catch(() => undefined);

  // ===== §7: MASKINLESBAR OPPSUMMERING =====
  log("\n== UA-2 P0 LIVE ACCEPTANCE SUMMARY (§7) ==");
  for (const [key, value] of Object.entries(results)) {
    log(`${key}=${value}`);
  }
  log(`duplicate_documents=${duplicateDocuments}`);

  const hardFail = Object.values(results).some((v) => v === "FAIL");
  log(`\nrun_id=${runId} hard_fail=${hardFail}`);
}

try {
  await main();
} finally {
  await pool.end();
}

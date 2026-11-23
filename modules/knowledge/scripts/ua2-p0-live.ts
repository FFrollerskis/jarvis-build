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
import { CANONICAL_GITHUB_REPO, type IdentityContext, type MemorySpace } from "@jarvis/contracts";
import { configFromEnv, createPool, PgApprovalStore, PgDeviceRegistry } from "@jarvis/core";
import { LocalHashEmbedding, withMemoryTransaction } from "@jarvis/memory";
import { KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { EnvSecretProvider, GithubTransport, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { FilesystemKnowledgeSource } from "../src/filesystem-source.ts";
import { GithubKnowledgeSource } from "../src/github-source.ts";
import { KnowledgeRetriever } from "../src/retriever.ts";
import { KnowledgeSyncService } from "../src/sync.ts";

type Verdict = "PASS" | "FAIL" | "SKIPPED" | "SKIPPED_HOST_PERMISSION" | "SKIPPED_NO_CREDENTIAL" | "BLOCKED_BY_RUNTIME_ROLE";

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

const dbConfig = configFromEnv();
const pool = createPool(dbConfig);
// Egen admin-tilkobling (samme credential-par docker-compose bruker for Postgres-superbrukeren,
// JARVIS_DB_ADMIN_USER/PASSWORD - allerede definert i .env.example) - KUN for orkestrering
// (kast-tenant-provisjonering, opprydding). ALDRI brukt som bevis for RLS - en superbruker
// bypasser RLS uansett policy (§2/Q-21). Isolasjons-BEVISET kjøres kun via `pool` selv,
// ETTER at Q-21-diagnosen har bekreftet den er non-bypass.
const adminPool = createPool({
  host: dbConfig.host,
  port: dbConfig.port,
  database: dbConfig.database,
  user: process.env["JARVIS_DB_ADMIN_USER"] ?? "postgres",
  ...(process.env["JARVIS_DB_ADMIN_PASSWORD"] !== undefined ? { password: process.env["JARVIS_DB_ADMIN_PASSWORD"] } : {})
});
const embedding = new LocalHashEmbedding(); // samme EmbeddingProvider som apps/api/src/main.ts sin ekte wiring
const sync = new KnowledgeSyncService(pool, embedding);
const retriever = new KnowledgeRetriever(pool, embedding);
const diagnostics: Record<string, string> = {};

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

// Opprydding/orkestrering går via adminPool (superuser) - jarvis_app har bevisst INGEN DELETE-grant
// noe sted (append-only-prinsipp, 005_rls.sql) - riktig sted for en DELETE er alltid admin-tilkoblingen,
// ALDRI et forsøk på å bruke app-rollen (som uansett ikke skal ha den rettigheten).
async function deleteBySourceInstance(sourceInstanceId: string): Promise<void> {
  await adminPool.query(
    `DELETE FROM knowledge_embeddings WHERE knowledge_document_id IN
       (SELECT knowledge_document_id FROM knowledge_documents WHERE source_instance_id = $1)`,
    [sourceInstanceId]
  );
  await adminPool.query("DELETE FROM knowledge_documents WHERE source_instance_id = $1", [sourceInstanceId]);
}

async function deleteTenant(tenantId: string): Promise<void> {
  await adminPool.query(
    `DELETE FROM knowledge_embeddings WHERE knowledge_document_id IN
       (SELECT knowledge_document_id FROM knowledge_documents WHERE tenant_id = $1)`,
    [tenantId]
  );
  await adminPool.query("DELETE FROM knowledge_documents WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  // §6: best-effort opprydding fra evt. krasjede tidligere kjøringer - trygt å
  // kjøre selv om ingenting finnes (idempotent).
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-ua2-p0-iso-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) {
      await deleteTenant(row.tenant_id).catch(() => undefined);
    }
  } catch {
    // best-effort
  }
}

/**
 * Q-21 AUTOMATISK DIAGNOSE: er den FAKTISKE runtime-rollen (JARVIS_DB_USER - samme
 * `pool`-tilkobling api/worker/migrate faktisk bruker) trygg å bevise RLS-isolasjon med?
 * Kjøres KUN via `pool` selv (aldri adminPool - vi diagnostiserer nettopp DENNE rollen,
 * ikke en annen). Ingen produksjonsrolle endres her - kun lest.
 */
let q21RuntimeRoleSafe = false;

async function diagnoseQ21(): Promise<void> {
  const identity = await pool.query("SELECT current_user AS cu, session_user AS su");
  const idRow = identity.rows[0] as { cu: string; su: string };
  diagnostics["current_user"] = idRow.cu;
  diagnostics["session_user"] = idRow.su;
  diagnostics["runtime_db_role"] = idRow.cu;

  const roleAttrs = await pool.query("SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1", [idRow.cu]);
  const ra = roleAttrs.rows[0] as { rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean } | undefined;
  diagnostics["runtime_role_superuser"] = String(ra?.rolsuper ?? "ukjent");
  diagnostics["runtime_role_bypassrls"] = String(ra?.rolbypassrls ?? "ukjent");
  diagnostics["runtime_role_canlogin"] = String(ra?.rolcanlogin ?? "ukjent");

  const classFlags = await pool.query(
    "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('knowledge_documents','knowledge_embeddings')"
  );
  const flagRows = classFlags.rows as Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
  const docs = flagRows.find((r) => r.relname === "knowledge_documents");
  const embs = flagRows.find((r) => r.relname === "knowledge_embeddings");
  diagnostics["knowledge_documents_rls"] = String(docs?.relrowsecurity ?? "ukjent");
  diagnostics["knowledge_documents_force_rls"] = String(docs?.relforcerowsecurity ?? "ukjent");
  diagnostics["knowledge_embeddings_rls"] = String(embs?.relrowsecurity ?? "ukjent");
  diagnostics["knowledge_embeddings_force_rls"] = String(embs?.relforcerowsecurity ?? "ukjent");

  q21RuntimeRoleSafe = ra?.rolsuper === false && ra?.rolbypassrls === false;
  diagnostics["q21_runtime_role_safe"] = q21RuntimeRoleSafe ? "PASS" : "FAIL";

  log(`current_user=${idRow.cu} session_user=${idRow.su}`);
  log(
    `runtime_db_role=${diagnostics["runtime_db_role"]} runtime_role_superuser=${diagnostics["runtime_role_superuser"]} runtime_role_bypassrls=${diagnostics["runtime_role_bypassrls"]} runtime_role_canlogin=${diagnostics["runtime_role_canlogin"]}`
  );
  log(
    `knowledge_documents_rls=${diagnostics["knowledge_documents_rls"]} knowledge_documents_force_rls=${diagnostics["knowledge_documents_force_rls"]} knowledge_embeddings_rls=${diagnostics["knowledge_embeddings_rls"]} knowledge_embeddings_force_rls=${diagnostics["knowledge_embeddings_force_rls"]}`
  );
  log(`q21_runtime_role_safe=${diagnostics["q21_runtime_role_safe"]}`);
  if (!q21RuntimeRoleSafe) {
    log(
      "Q-21 IKKE TRYGT: JARVIS_DB_USER (den faktiske app-rollen - samme som api/worker/migrate bruker) er superuser og/eller BYPASSRLS. RLS er derfor ALDRI håndhevet for denne tilkoblingen, verken her eller i den kjørende appen. MÅ FIKSES: pek JARVIS_DB_USER på en ekte LOGIN-rolle som er NOSUPERUSER NOBYPASSRLS og medlem av jarvis_app (samme gruppe-rolle 005_rls.sql allerede definerer, samme mønster suitens test-oppsett alltid har brukt) - IKKE samme rolle som JARVIS_DB_ADMIN_USER. Se Q-21 i docs/OPEN_QUESTIONS.md. §1/§4/§5 sine PASS-resultater over er IKKE bevis på isolasjon (de øvde aldri en cross-tenant/cross-space DENY-vei)."
    );
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

  // ===== Q-21: AUTOMATISK DB-ROLLE-DIAGNOSE (ÉN host-kommando avgjør alt) =====
  await section("Q-21 AUTOMATISK DB-ROLE DIAGNOSE", diagnoseQ21);

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

  // ===== §2: RLS / TENANT + MEMORY-SPACE ISOLASJON =====
  // Q-21-fiks: isolasjon bevises nå UTELUKKENDE via `pool` (den FAKTISKE runtime-rollen,
  // diagnostisert over) - IKKE via en separat bootstrappet rolle. Er runtime-rollen ikke
  // trygg (superuser/BYPASSRLS), kjøres ISOLASJONS-BEVISET IKKE i det hele tatt - vi faker
  // aldri PASS, og vi endrer aldri produksjonsrollen automatisk her.
  await section("§2 RLS/TENANT+MEMORY-SPACE ISOLASJON", async () => {
    if (!q21RuntimeRoleSafe) {
      results.tenant_isolation = "BLOCKED_BY_RUNTIME_ROLE";
      results.memory_space_isolation = "BLOCKED_BY_RUNTIME_ROLE";
      log(
        "HOPPER OVER isolasjons-acceptance: runtime-rollen er IKKE bevist trygg (se Q-21-diagnostikken over - runtime_role_superuser/runtime_role_bypassrls). Fiks JARVIS_DB_USER (pek på en NOSUPERUSER NOBYPASSRLS-rolle, medlem av jarvis_app) og kjør scriptet på nytt."
      );
      return;
    }

    const tenantA = `tenant-ua2-p0-iso-a-${runId}`;
    const tenantB = `tenant-ua2-p0-iso-b-${runId}`;
    try {
      // Kast-tenants opprettes/ryddes via adminPool (tenants-tabellens egen RLS-policy krever
      // jarvis.tenant_id=ny-tenant-id FØR innsetting under en non-bypass rolle - admin er riktig
      // sted for denne typen provisjonering, samme mønster som suitens adminPool alltid har brukt).
      await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,'UA2-P0-ISO-A','person')", [tenantA]);
      await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,'UA2-P0-ISO-B','person')", [tenantB]);
      await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [ownerPerson, tenantA]);
      await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [ownerPerson, tenantB]);

      const identityA: IdentityContext = { ...ownerIdentity, tenant_id: tenantA, session_id: `sess-iso-a-${runId}` };
      const identityB: IdentityContext = { ...ownerIdentity, tenant_id: tenantB, session_id: `sess-iso-b-${runId}` };

      const rootA = join(varRoot, "iso-a");
      const rootB = join(varRoot, "iso-b");
      await mkdir(rootA, { recursive: true });
      await mkdir(rootB, { recursive: true });
      await writeFile(join(rootA, "hemmelig-a.md"), `TenantIsoUniktOrdA-${runId}`);
      await writeFile(join(rootB, "hemmelig-b.md"), `TenantIsoUniktOrdB-${runId}`);
      // Bruker `sync`/`retriever` direkte - bundet til `pool`, DEN allerede diagnostiserte
      // og bevist non-bypass runtime-rollen. Ingen separat testrolle lenger.
      await sync.sync(identityA, "personal", new FilesystemKnowledgeSource(rootA, `fs:iso-a-${runId}`));
      await sync.sync(identityB, "personal", new FilesystemKnowledgeSource(rootB, `fs:iso-b-${runId}`));

      // Merk: rå listelengde er IKKE et presist mål her - vektorleddet (LocalHashEmbedding,
      // enkel trigram-hash) kan legitimt gi en tenants EGET dokument som svak treffkandidat
      // på en trigram-lik spørring, uten at det er en isolasjonslekkasje (bevist i
      // modules/knowledge/test/rls-role-isolation.test.ts §5.A-D). Det presise målet på en
      // FAKTISK lekkasje er om den ANDRE tenantens INNHOLD dukker opp - ikke om listen er tom.
      const wordA = `TenantIsoUniktOrdA-${runId}`;
      const wordB = `TenantIsoUniktOrdB-${runId}`;
      const aSeesB = await retriever.search(identityA, { query: wordB, spaces: ["personal"] });
      const bSeesA = await retriever.search(identityB, { query: wordA, spaces: ["personal"] });
      const aFindsOwn = await retriever.search(identityA, { query: wordA, spaces: ["personal"] });
      const aLeaksB = aSeesB.filter((r) => r.content.includes(wordB));
      const bLeaksA = bSeesA.filter((r) => r.content.includes(wordA));
      const aSeesOwn = aFindsOwn.filter((r) => r.content.includes(wordA));
      diagnostics["tenant_a_sees_tenant_b"] = String(aLeaksB.length);
      diagnostics["tenant_b_sees_tenant_a"] = String(bLeaksA.length);
      diagnostics["tenant_a_sees_own"] = String(aSeesOwn.length);
      results.tenant_isolation = aLeaksB.length === 0 && bLeaksA.length === 0 && aSeesOwn.length > 0 ? "PASS" : "FAIL";
      log(
        `tenant_a_sees_tenant_b=${aLeaksB.length} (rå_treff=${aSeesB.length}) tenant_b_sees_tenant_a=${bLeaksA.length} (rå_treff=${bSeesA.length}) tenant_a_sees_own=${aSeesOwn.length} -> tenant_isolation=${results.tenant_isolation}`
      );

      const rootPersonalWord = join(varRoot, "iso-space-personal");
      const rootBusinessWord = join(varRoot, "iso-space-business");
      await mkdir(rootPersonalWord, { recursive: true });
      await mkdir(rootBusinessWord, { recursive: true });
      const personalWord = `SpaceIsoPersonalOrd-${runId}`;
      const businessWord = `SpaceIsoBusinessOrd-${runId}`;
      await writeFile(join(rootPersonalWord, "pers.md"), personalWord);
      await writeFile(join(rootBusinessWord, "biz.md"), businessWord);
      await sync.sync(identityA, "personal", new FilesystemKnowledgeSource(rootPersonalWord, `${isoSourceInstanceId}-personal`));
      await sync.sync(identityA, "business", new FilesystemKnowledgeSource(rootBusinessWord, isoSourceInstanceId));

      const personalSeesBusiness = await retriever.search(identityA, { query: businessWord, spaces: ["personal"] });
      const businessSeesPersonal = await retriever.search(identityA, { query: personalWord, spaces: ["business"] });
      const personalFindsOwn = await retriever.search(identityA, { query: personalWord, spaces: ["personal"] });
      const businessFindsOwn = await retriever.search(identityA, { query: businessWord, spaces: ["business"] });
      const personalLeaksBusiness = personalSeesBusiness.filter((r) => r.content.includes(businessWord));
      const businessLeaksPersonal = businessSeesPersonal.filter((r) => r.content.includes(personalWord));
      diagnostics["personal_sees_business"] = String(personalLeaksBusiness.length);
      diagnostics["business_sees_personal"] = String(businessLeaksPersonal.length);
      results.memory_space_isolation =
        personalLeaksBusiness.length === 0 &&
        businessLeaksPersonal.length === 0 &&
        personalFindsOwn.some((r) => r.content.includes(personalWord)) &&
        businessFindsOwn.some((r) => r.content.includes(businessWord))
          ? "PASS"
          : "FAIL";
      log(
        `personal_sees_business=${personalLeaksBusiness.length} (rå_treff=${personalSeesBusiness.length}) business_sees_personal=${businessLeaksPersonal.length} (rå_treff=${businessSeesPersonal.length}) -> memory_space_isolation=${results.memory_space_isolation}`
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
    const allowlistRecords = (await new FilesystemKnowledgeSource(secRoot).list()).records;
    results.filesystem_allowlist =
      allowlistRecords.some((r) => r.external_id === "lovlig.md") &&
      !allowlistRecords.some((r) => r.content.includes("hemmelig"))
        ? "PASS"
        : "FAIL";
    log(`filesystem_allowlist: filer=${allowlistRecords.length} -> ${results.filesystem_allowlist}`);

    // traversal: en rootPath med bokstavelige '..'-segmenter nøytraliseres av resolve() - ingen ekstern innhold lekker inn.
    await mkdir(join(secRoot, "sub"), { recursive: true });
    await writeFile(join(secRoot, "sub", "fil.txt"), "innhold i undermappe");
    const traversalRecords = (await new FilesystemKnowledgeSource(join(secRoot, "sub", "..", "sub")).list()).records;
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
      const symlinkRecords = (await new FilesystemKnowledgeSource(secRoot).list()).records;
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
    const repo = process.env["JARVIS_GITHUB_REPO"] ?? CANONICAL_GITHUB_REPO;
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
  // §2 sine dokumenter lever under de midlertidige iso-tenantene og er allerede ryddet der (deleteTenant).
  await deleteBySourceInstance(fsSourceInstanceId).catch((err: unknown) =>
    log(`opprydding fs-test-dokument feilet: ${(err as Error).message}`)
  );
  await rm(varRoot, { recursive: true, force: true }).catch(() => undefined);

  // ===== §7: MASKINLESBAR OPPSUMMERING =====
  log("\n== UA-2 P0 LIVE ACCEPTANCE SUMMARY (§7) ==");
  for (const [key, value] of Object.entries(results)) {
    log(`${key}=${value}`);
  }
  log(`duplicate_documents=${duplicateDocuments}`);

  log("\n== RLS-DIAGNOSTIKK (host-blocker §6) ==");
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

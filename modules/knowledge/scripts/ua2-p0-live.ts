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
import type pg from "pg";
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

const dbConfig = configFromEnv();
const pool = createPool(dbConfig);
// Egen admin-tilkobling (samme credential-par docker-compose bruker for Postgres-superbrukeren,
// JARVIS_DB_ADMIN_USER/PASSWORD - allerede definert i .env.example) - KUN for orkestrering
// (rolle-bootstrap §2, kast-tenant-provisjonering, opprydding). ALDRI brukt som bevis for RLS -
// en superbruker bypasser RLS uansett policy, se §2/host-blocker-runden.
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

async function main(): Promise<void> {
  await mkdir(varRoot, { recursive: true });
  await selfHeal();

  const pgVectorRow = await pool.query(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='knowledge_embeddings' AND column_name='vec') AS has"
  );
  const pgVectorActive = (pgVectorRow.rows[0] as { has: boolean }).has;
  log(`pgvector_extension_active=${pgVectorActive} (ekte Docker-Postgres forventes true)`);

  // Ekstra transparens (host-blocker-runden §1): hvilken rolle er JARVIS_DB_USER (samme
  // pool som api/worker/migrate faktisk bruker) FAKTISK? En superbruker/BYPASSRLS-rolle
  // her betyr §1/§4/§5 sine PASS-resultater IKKE er bevis på RLS-håndhevelse (de øvde
  // aldri en cross-tenant/cross-space DENY-vei) - kun at data blir lest/skrevet korrekt
  // for ÉN tenant/space, noe som holder uansett bypass-status.
  try {
    const configuredRole = await pool.query("SELECT current_user AS u");
    const roleName = (configuredRole.rows[0] as { u: string }).u;
    const attrs = await pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1", [roleName]);
    const a = attrs.rows[0] as { rolsuper: boolean; rolbypassrls: boolean } | undefined;
    diagnostics["configured_app_role"] = roleName;
    diagnostics["configured_app_role_superuser"] = String(a?.rolsuper ?? "ukjent");
    diagnostics["configured_app_role_bypassrls"] = String(a?.rolbypassrls ?? "ukjent");
    log(
      `configured_app_role=${roleName} superuser=${diagnostics["configured_app_role_superuser"]} bypassrls=${diagnostics["configured_app_role_bypassrls"]} (JARVIS_DB_USER - samme rolle api/worker/migrate faktisk bruker)`
    );
    if (a?.rolsuper || a?.rolbypassrls) {
      log(
        "ADVARSEL: JARVIS_DB_USER er en superbruker/BYPASSRLS-rolle - RLS er ALDRI håndhevet for denne tilkoblingen, verken i dette scriptet ELLER i den faktiske kjørende appen (api/worker/migrate bruker samme configFromEnv()). §1/§4/§5 sine PASS-resultater er derfor IKKE bevis på tenant/space-isolasjon."
      );
    }
  } catch (err) {
    log(`configured_app_role: kunne ikke diagnostisere - ${(err as Error).message.slice(0, 150)}`);
  }

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

  // ===== §2: RLS / TENANT + MEMORY-SPACE ISOLASJON (host-blocker-fiks) =====
  // HOST-BLOCKER ROOT CAUSE (forrige runde): denne seksjonen kjørte assertions via `pool`
  // (JARVIS_DB_USER, samme rolle appen bruker) - UTEN å noensinne verifisere at rollen
  // faktisk er non-bypass. Suite-testene (knowledge-fundament.test.ts §7.G/§7.H) har ALLTID
  // bevist isolasjon korrekt fordi de eksplisitt bootstrapper en dedikert LOGIN-rolle
  // (`GRANT jarvis_app TO ...`, samme mønster som HER) - denne seksjonen gjorde ikke det,
  // og kunne derfor ikke skille "RLS fungerer" fra "rollen bypasser RLS". Fikset ved å
  // ALDRI bruke `pool` for isolasjons-BEVISET - kun en fersk, garantert non-bypass rolle.
  await section("§2 RLS/TENANT+MEMORY-SPACE ISOLASJON", async () => {
    const rlsRoleName = "jarvis_ua2_p0_rls_check";
    const rlsPassword = randomUUID();
    let rlsPool: pg.Pool | undefined;
    const tenantA = `tenant-ua2-p0-iso-a-${runId}`;
    const tenantB = `tenant-ua2-p0-iso-b-${runId}`;

    try {
      // §1 i BO-en: IKKE anta RLS er ødelagt - bootstrap en GARANTERT non-bypass rolle
      // (NOSUPERUSER NOBYPASSRLS, medlem av jarvis_app) og bevis assertions gjennom DEN,
      // aldri gjennom en tilkobling med ukjent/uverifisert privilegie-status.
      const exists = await adminPool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [rlsRoleName]);
      if (exists.rowCount === 0) {
        await adminPool.query(`CREATE ROLE ${rlsRoleName} LOGIN PASSWORD '${rlsPassword}' NOSUPERUSER NOBYPASSRLS`);
      } else {
        await adminPool.query(`ALTER ROLE ${rlsRoleName} WITH LOGIN PASSWORD '${rlsPassword}' NOSUPERUSER NOBYPASSRLS`);
      }
      await adminPool.query(`GRANT jarvis_app TO ${rlsRoleName}`);

      rlsPool = createPool({ host: dbConfig.host, port: dbConfig.port, database: dbConfig.database, user: rlsRoleName, password: rlsPassword });
      const rlsSync = new KnowledgeSyncService(rlsPool, embedding);
      const rlsRetriever = new KnowledgeRetriever(rlsPool, embedding);

      // §6-diagnostikk: bevis rollen VI BRUKER TIL Å TESTE er faktisk non-bypass -
      // uten dette kan ikke et PASS her skilles fra en ny bypass-illusjon.
      const roleAttrs = await rlsPool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
      const ra = roleAttrs.rows[0] as { rolsuper: boolean; rolbypassrls: boolean };
      const rlsFlags = await rlsPool.query(
        "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('knowledge_documents','knowledge_embeddings')"
      );
      const flagRows = rlsFlags.rows as Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
      const rlsEnabled = flagRows.length === 2 && flagRows.every((r) => r.relrowsecurity);
      const forceRls = flagRows.length === 2 && flagRows.every((r) => r.relforcerowsecurity);

      diagnostics["rls_test_role"] = rlsRoleName;
      diagnostics["rls_role_superuser"] = String(ra.rolsuper);
      diagnostics["rls_role_bypassrls"] = String(ra.rolbypassrls);
      diagnostics["knowledge_rls_enabled"] = String(rlsEnabled);
      diagnostics["knowledge_force_rls"] = String(forceRls);
      log(
        `rls_test_role=${rlsRoleName} rls_role_superuser=${ra.rolsuper} rls_role_bypassrls=${ra.rolbypassrls} knowledge_rls_enabled=${rlsEnabled} knowledge_force_rls=${forceRls}`
      );
      if (ra.rolsuper || ra.rolbypassrls) {
        // Skal være strukturelt umulig (rollen opprettes eksplisitt NOSUPERUSER NOBYPASSRLS
        // like over) - men verifiser i stedet for å anta, og fail-closed hvis Postgres av en
        // eller annen grunn likevel rapporterer bypass-status.
        results.tenant_isolation = "FAIL";
        results.memory_space_isolation = "FAIL";
        log("HARNESS FEIL: test-rollen rapporterer superuser/bypassrls=true til tross for eksplisitt NOSUPERUSER NOBYPASSRLS - kan IKKE bevise isolasjon. Ikke svekket RLS for å kompensere.");
        return;
      }
      if (!rlsEnabled || !forceRls) {
        results.tenant_isolation = "FAIL";
        results.memory_space_isolation = "FAIL";
        log("RUNTIME FEIL: knowledge_documents/knowledge_embeddings mangler ENABLE/FORCE ROW LEVEL SECURITY i skjemaet - dette er en ekte migrasjons-/policy-bug, ikke en rolle-/harness-feil.");
        return;
      }

      // Kast-tenants opprettes/ryddes via adminPool (tenants-tabellens egen RLS-policy krever
      // jarvis.tenant_id=ny-tenant-id FØR innsetting under en non-bypass rolle - admin er riktig
      // sted for denne typen provisjonering, akkurat som i suite-testenes adminPool-mønster).
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
      await rlsSync.sync(identityA, "personal", new FilesystemKnowledgeSource(rootA, `fs:iso-a-${runId}`));
      await rlsSync.sync(identityB, "personal", new FilesystemKnowledgeSource(rootB, `fs:iso-b-${runId}`));

      // Merk: rå listelengde er IKKE et presist mål her - vektorleddet (LocalHashEmbedding,
      // enkel trigram-hash) kan legitimt gi en tenants EGET dokument som svak treffkandidat
      // på en trigram-lik spørring, uten at det er en isolasjonslekkasje (bevist i
      // modules/knowledge/test/rls-role-isolation.test.ts §5.A-D). Det presise målet på en
      // FAKTISK lekkasje er om den ANDRE tenantens INNHOLD dukker opp - ikke om listen er tom.
      const wordA = `TenantIsoUniktOrdA-${runId}`;
      const wordB = `TenantIsoUniktOrdB-${runId}`;
      const aSeesB = await rlsRetriever.search(identityA, { query: wordB, spaces: ["personal"] });
      const bSeesA = await rlsRetriever.search(identityB, { query: wordA, spaces: ["personal"] });
      const aFindsOwn = await rlsRetriever.search(identityA, { query: wordA, spaces: ["personal"] });
      const aLeaksB = aSeesB.filter((r) => r.content.includes(wordB));
      const bLeaksA = bSeesA.filter((r) => r.content.includes(wordA));
      diagnostics["tenant_a_sees_tenant_b"] = String(aLeaksB.length);
      diagnostics["tenant_b_sees_tenant_a"] = String(bLeaksA.length);
      results.tenant_isolation = aLeaksB.length === 0 && bLeaksA.length === 0 && aFindsOwn.some((r) => r.content.includes(wordA)) ? "PASS" : "FAIL";
      log(
        `tenant_isolation (via ${rlsRoleName}): a_ser_b=${aLeaksB.length} (rå_treff=${aSeesB.length}) b_ser_a=${bLeaksA.length} (rå_treff=${bSeesA.length}) a_finner_egen=${aFindsOwn.length} -> ${results.tenant_isolation}`
      );

      const rootPersonalWord = join(varRoot, "iso-space-personal");
      const rootBusinessWord = join(varRoot, "iso-space-business");
      await mkdir(rootPersonalWord, { recursive: true });
      await mkdir(rootBusinessWord, { recursive: true });
      const personalWord = `SpaceIsoPersonalOrd-${runId}`;
      const businessWord = `SpaceIsoBusinessOrd-${runId}`;
      await writeFile(join(rootPersonalWord, "pers.md"), personalWord);
      await writeFile(join(rootBusinessWord, "biz.md"), businessWord);
      await rlsSync.sync(identityA, "personal", new FilesystemKnowledgeSource(rootPersonalWord, `${isoSourceInstanceId}-personal`));
      await rlsSync.sync(identityA, "business", new FilesystemKnowledgeSource(rootBusinessWord, isoSourceInstanceId));

      const personalSeesBusiness = await rlsRetriever.search(identityA, { query: businessWord, spaces: ["personal"] });
      const businessSeesPersonal = await rlsRetriever.search(identityA, { query: personalWord, spaces: ["business"] });
      const personalFindsOwn = await rlsRetriever.search(identityA, { query: personalWord, spaces: ["personal"] });
      const businessFindsOwn = await rlsRetriever.search(identityA, { query: businessWord, spaces: ["business"] });
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
        `memory_space_isolation (via ${rlsRoleName}): personal_ser_business=${personalLeaksBusiness.length} (rå_treff=${personalSeesBusiness.length}) business_ser_personal=${businessLeaksPersonal.length} (rå_treff=${businessSeesPersonal.length}) personal_finner_egen=${personalFindsOwn.length} business_finner_egen=${businessFindsOwn.length} -> ${results.memory_space_isolation}`
      );
    } finally {
      await deleteTenant(tenantA).catch((err: unknown) => log(`opprydding tenantA feilet: ${(err as Error).message}`));
      await deleteTenant(tenantB).catch((err: unknown) => log(`opprydding tenantB feilet: ${(err as Error).message}`));
      await rlsPool?.end().catch(() => undefined);
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

  const hardFail = Object.values(results).some((v) => v === "FAIL");
  log(`\nrun_id=${runId} hard_fail=${hardFail}`);
}

try {
  await main();
} finally {
  await pool.end();
  await adminPool.end();
}

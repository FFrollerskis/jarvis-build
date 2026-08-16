// UA-2 P1A LIVE ACCEPTANCE - kjøres AV TOBIAS mot ekte lokal Postgres/pgvector
// (docker-compose) og ekte filsystem. Gjenbruker KUN eksisterende arkitektur
// (@jarvis/knowledge, @jarvis/tool-gateway, @jarvis/policy, @jarvis/core) -
// ingen alternativ testimplementasjon. Speiler strukturen i
// modules/erasure/scripts/q20-erasure-live.ts (samme log()/section()/
// Verdict-mønster) og modules/knowledge/scripts/ua2-p0-live.ts.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/knowledge/scripts/ua2-p1a-live.ts
//
// UA-2 P1A scope-endring (2026-08-16, se OWNER CONNECTOR CAPABILITY INVARIANT
// i CLAUDE.md): PRODUKSJON har full Google Drive read/write/permissions -
// MEN akseptansen her er begrenset til JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID (en
// dedikert, trygg test-mappe Tobias selv har opprettet - ALDRI hele driven).
// Runneren oppretter/leser/oppdaterer/omdøper/flytter/trasher/sletter KUN
// artefakter den SELV har opprettet inne i test-roten, og rydder opp etter
// seg. Mangler noen av de fire nødvendige env-variablene, rapporteres
// google_drive_live=BLOCKED_NO_SAFE_TEST_SCOPE og INGENTING live-kalles. Har
// credentials for LESING men mangler write-scope (token utstedt før denne
// scope-endringen), rapporteres google_drive_live=BLOCKED_REAUTH_REQUIRED -
// ALDRI en fake PASS.
// Obsidian-akseptansen bruker en ISOLERT MIDLERTIDIG vault under systemets
// temp-katalog - ALDRI Tobias sin ekte vault.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, computeErasureFingerprint, configFromEnv, createPool } from "@jarvis/core";
import { LocalHashEmbedding } from "@jarvis/memory";
import { GoogleDriveKnowledgeSource, KnowledgeRetriever, KnowledgeSourceRegistry, KnowledgeSyncService, ObsidianVaultKnowledgeSource } from "@jarvis/knowledge";
import { EnvSecretProvider, GoogleDriveTransport, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE" | "BLOCKED_NO_SAFE_TEST_SCOPE" | "BLOCKED_REAUTH_REQUIRED" | "SKIPPED_UNSAFE";

const results: Record<string, Verdict> = {
  p1a_registry_tenant_scoping: "FAIL",
  p1a_obsidian_lifecycle: "FAIL",
  p1a_obsidian_obsidian_dir_excluded: "FAIL",
  p1a_obsidian_frontmatter_wikilinks: "FAIL",
  p1a_obsidian_no_resurrection: "FAIL",
  p1a_tenant_isolation_new_sources: "FAIL",
  p1a_retrieval_new_sources: "FAIL",
  p1a_no_content_in_audit: "FAIL",
  google_drive_live: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_auth_scope: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_read: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_create: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_update: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_rename: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_move: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_trash: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_cleanup: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_sync: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_q20_no_resurrection: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_idempotency: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_policy: "BLOCKED_NO_SAFE_TEST_SCOPE"
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
log(`UA-2 P1A LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());
const embedding = new LocalHashEmbedding();

const TENANT_A = `tenant-p1a-live-${runId}-a`;
const TENANT_B = `tenant-p1a-live-${runId}-b`;
const OWNER_PERSON = `person-p1a-live-${runId}`;
const SPACE: MemorySpace = "personal";

function identityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: SPACE,
    session_id: `sess-p1a-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query(
    `DELETE FROM knowledge_embeddings WHERE knowledge_document_id IN (SELECT knowledge_document_id FROM knowledge_documents WHERE tenant_id = $1)`,
    [tenantId]
  );
  await adminPool.query("DELETE FROM knowledge_documents WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM erasure_fingerprints WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM erasure_requests WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-p1a-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) {
      await cleanupTenant(row.tenant_id).catch(() => undefined);
    }
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-p1a-live-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  // ===== §1: Q-21 RUNTIME ROLE (P1A er bygget PÅ Q-21/Q-20, ikke i stedet for) =====
  let runtimeRoleSafe = false;
  await section("§1 Q-21 RUNTIME ROLE", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    diagnostics["runtime_current_user"] = status.role;
    diagnostics["runtime_role_superuser"] = String(status.superuser);
    diagnostics["runtime_role_bypassrls"] = String(status.bypassrls);
    log(`q21_runtime_role_safe=PASS role=${status.role}`);
  });
  if (!runtimeRoleSafe) {
    log("\nP1A KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21 regresjon). Ingen kall forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  await selfHeal();
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','P1A Live A','person'), ('${TENANT_B}','P1A Live B','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER_PERSON}','P1A Live Tester') ON CONFLICT DO NOTHING;
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER_PERSON}','${TENANT_A}'), ('${OWNER_PERSON}','${TENANT_B}');
  `);

  const sync = new KnowledgeSyncService(pool, embedding);
  const retriever = new KnowledgeRetriever(pool, embedding);

  // ===== §2: GENERISK REGISTRY - flere instanser, tenant-scoping =====
  await section("§2 SOURCE REGISTRY tenant-scoping", async () => {
    const vaultRootA = await mkdtemp(join(tmpdir(), "jarvis-p1a-registry-a-"));
    const vaultRootB = await mkdtemp(join(tmpdir(), "jarvis-p1a-registry-b-"));
    const registry = new KnowledgeSourceRegistry([
      { source_type: "obsidian", tenant_id: TENANT_A, memory_space_id: SPACE, source_instance_id: "vault-a", vault_root: vaultRootA },
      { source_type: "obsidian", tenant_id: TENANT_B, memory_space_id: SPACE, source_instance_id: "vault-b", vault_root: vaultRootB }
    ]);
    const forA = registry.forTenant(TENANT_A, SPACE);
    const forB = registry.forTenant(TENANT_B, SPACE);
    results.p1a_registry_tenant_scoping =
      forA.length === 1 && forB.length === 1 && forA[0]?.tenant_id === TENANT_A && registry.forTenant("ukjent-tenant", SPACE).length === 0
        ? "PASS"
        : "FAIL";
    log(`p1a_registry_tenant_scoping=${results.p1a_registry_tenant_scoping}`);
    await rm(vaultRootA, { recursive: true, force: true }).catch(() => undefined);
    await rm(vaultRootB, { recursive: true, force: true }).catch(() => undefined);
  });

  // ===== §3: OBSIDIAN - ISOLERT MIDLERTIDIG VAULT (ALDRI Tobias sin ekte vault) =====
  const obsidianSentinel = `P1AObsidianSentinel_${runId}`;
  let vaultRoot = "";
  await section("§3 OBSIDIAN livssyklus (midlertidig vault)", async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), "jarvis-p1a-live-vault-"));
    diagnostics["obsidian_vault_root"] = vaultRoot;
    await mkdir(join(vaultRoot, ".obsidian"), { recursive: true });
    await writeFile(join(vaultRoot, ".obsidian", "config.json"), '{"skal":"aldri indekseres"}');
    await writeFile(
      join(vaultRoot, "notat.md"),
      `---\ntitle: P1A Live\ntags: [p1a, live]\n---\n\n${obsidianSentinel}\n\nSe [[Annet Notat]].`
    );
    const source = new ObsidianVaultKnowledgeSource(vaultRoot, `obsidian:p1a-live-${runId}`);
    const { records } = await source.list();
    results.p1a_obsidian_obsidian_dir_excluded = !records.some((r) => r.external_id.startsWith(".obsidian/")) ? "PASS" : "FAIL";
    const note = records.find((r) => r.external_id === "notat.md");
    const frontmatter = note?.metadata["frontmatter"] as Record<string, unknown> | undefined;
    const wikiLinks = note?.metadata["wiki_links"];
    results.p1a_obsidian_frontmatter_wikilinks =
      frontmatter?.["title"] === "P1A Live" && Array.isArray(wikiLinks) && wikiLinks.includes("Annet Notat") ? "PASS" : "FAIL";

    const report = await sync.sync(identityFor(TENANT_A), SPACE, source);
    log(`obsidian sync: ${JSON.stringify(report)}`);
    const found = await retriever.search(identityFor(TENANT_A), { query: obsidianSentinel, spaces: [SPACE] });
    results.p1a_obsidian_lifecycle = report.created === 1 && found.some((r) => r.content.includes(obsidianSentinel)) ? "PASS" : "FAIL";
    log(`p1a_obsidian_lifecycle=${results.p1a_obsidian_lifecycle} p1a_obsidian_obsidian_dir_excluded=${results.p1a_obsidian_obsidian_dir_excluded} p1a_obsidian_frontmatter_wikilinks=${results.p1a_obsidian_frontmatter_wikilinks}`);
  });

  // ===== §4: OBSIDIAN Q-20 NO-RESURRECTION =====
  await section("§4 OBSIDIAN Q-20 no-resurrection", async () => {
    const docRow = await adminPool.query(
      "SELECT knowledge_document_id FROM knowledge_documents WHERE tenant_id=$1 AND source_type='obsidian' AND external_id='notat.md'",
      [TENANT_A]
    );
    const knowledgeDocumentId = (docRow.rows[0] as { knowledge_document_id: string } | undefined)?.knowledge_document_id;
    if (!knowledgeDocumentId) throw new Error("obsidian sentinel-dokument mangler - kan ikke bevise no-resurrection");
    await adminPool.query("DELETE FROM knowledge_embeddings WHERE knowledge_document_id=$1", [knowledgeDocumentId]);
    await adminPool.query("DELETE FROM knowledge_documents WHERE knowledge_document_id=$1", [knowledgeDocumentId]);
    const reqId = `req-p1a-live-${runId}`;
    await adminPool.query(
      "INSERT INTO erasure_requests (request_id, tenant_id, scope_type, scope_summary, status) VALUES ($1,$2,'knowledge_document','{}'::jsonb,'completed')",
      [reqId, TENANT_A]
    );
    const fingerprint = computeErasureFingerprint(TENANT_A, "obsidian", `obsidian:p1a-live-${runId}`, "notat.md");
    await adminPool.query(
      "INSERT INTO erasure_fingerprints (fingerprint, tenant_id, source_type, source_instance_id, erasure_request_id) VALUES ($1,$2,'obsidian',$3,$4)",
      [fingerprint, TENANT_A, `obsidian:p1a-live-${runId}`, reqId]
    );
    const resync = await sync.sync(identityFor(TENANT_A), SPACE, new ObsidianVaultKnowledgeSource(vaultRoot, `obsidian:p1a-live-${runId}`));
    log(`obsidian resync after erasure: ${JSON.stringify(resync)}`);
    const foundAfter = await retriever.search(identityFor(TENANT_A), { query: obsidianSentinel, spaces: [SPACE] });
    results.p1a_obsidian_no_resurrection =
      resync.created === 0 && resync.suppressed === 1 && !foundAfter.some((r) => r.content.includes(obsidianSentinel)) ? "PASS" : "FAIL";
    log(`p1a_obsidian_no_resurrection=${results.p1a_obsidian_no_resurrection}`);
  });

  // ===== §5: TENANT-ISOLASJON MED NYE KILDETYPER + RETRIEVAL =====
  await section("§5 tenant-isolasjon + retrieval (nye kildetyper)", async () => {
    const vaultB = await mkdtemp(join(tmpdir(), "jarvis-p1a-live-vault-b-"));
    const otherSentinel = `P1AOtherTenant_${runId}`;
    await writeFile(join(vaultB, "annet.md"), otherSentinel);
    await sync.sync(identityFor(TENANT_B), SPACE, new ObsidianVaultKnowledgeSource(vaultB, `obsidian:p1a-live-b-${runId}`));

    const aSeesB = await retriever.search(identityFor(TENANT_A), { query: otherSentinel, spaces: [SPACE] });
    const bSeesOwn = await retriever.search(identityFor(TENANT_B), { query: otherSentinel, spaces: [SPACE] });
    results.p1a_tenant_isolation_new_sources =
      !aSeesB.some((r) => r.content.includes(otherSentinel)) && bSeesOwn.some((r) => r.content.includes(otherSentinel)) ? "PASS" : "FAIL";
    results.p1a_retrieval_new_sources = bSeesOwn.some((r) => r.provenance.source_type === "obsidian") ? "PASS" : "FAIL";
    log(`p1a_tenant_isolation_new_sources=${results.p1a_tenant_isolation_new_sources} p1a_retrieval_new_sources=${results.p1a_retrieval_new_sources}`);
    await rm(vaultB, { recursive: true, force: true }).catch(() => undefined);
  });

  // ===== §6: GOOGLE DRIVE LIVE FULL READ/WRITE (KUN mot en dedikert, trygg test-mappe) =====
  await section("§6 GOOGLE DRIVE LIVE (betinget, full read/write, scopet til test-mappe)", async () => {
    const clientId = process.env["JARVIS_GOOGLE_CLIENT_ID"];
    const clientSecret = process.env["JARVIS_GOOGLE_CLIENT_SECRET"];
    const refreshToken = process.env["JARVIS_GOOGLE_TOKEN"];
    const testFolderId = process.env["JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID"];
    if (!clientId || !clientSecret || !refreshToken || !testFolderId) {
      log(
        `google_drive_live=BLOCKED_NO_SAFE_TEST_SCOPE (client_id=${Boolean(clientId)} client_secret=${Boolean(clientSecret)} token=${Boolean(refreshToken)} test_folder_id=${Boolean(testFolderId)}) - krever en DEDIKERT, trygg test-mappe. Ingen live-kall forsøkt.`
      );
      return;
    }
    diagnostics["drive_test_folder_id"] = testFolderId;

    // Owner sovereign-modus for DENNE live-kjøringen - speiler hvordan Jarvis
    // faktisk kjører for Tobias i produksjon (klasse D autonomt for eier,
    // ingen kunstig approval-friksjon). Delegert/approval-vei er allerede
    // suite-bevist (drive-full-access.test.ts §G/§I) - ALDRI gjentatt mot
    // ekte Drive-data.
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A] }
    });
    const secrets = new EnvSecretProvider();
    const toolGateway = new ToolGateway(pool, policy, secrets);
    for (const tool of firstWaveTools({ drive: new GoogleDriveTransport() })) toolGateway.register(tool);
    const identity = identityFor(TENANT_A);
    const createdFileIds: string[] = [];

    async function drive(action: string, parameters: Record<string, JsonValue>) {
      return toolGateway.execute({ identity, tool_id: "drive", action, parameters });
    }
    function isReauthSignal(reason: string): boolean {
      return /auth_error_401|auth_error_403/.test(reason);
    }

    // §auth_scope/§read: lesing i test-mappen (også en implisitt scope-sjekk).
    const listResult = await drive("list_files", { folder_id: testFolderId });
    if (!listResult.ok) {
      const reauth = isReauthSignal(listResult.reason);
      results.google_drive_auth_scope = reauth ? "BLOCKED_REAUTH_REQUIRED" : "FAIL";
      results.google_drive_read = "FAIL";
      results.google_drive_live = reauth ? "BLOCKED_REAUTH_REQUIRED" : "FAIL";
      log(`google_drive_auth_scope=${results.google_drive_auth_scope} (list_files feilet: ${listResult.reason}) - stopper Drive-akseptansen her.`);
      return;
    }
    results.google_drive_auth_scope = "PASS";
    results.google_drive_read = "PASS";

    // §create: en tekstfil OG en undermappe (for §move) - KUN inne i test-mappen.
    const createResult = await drive("create_file", { name: `p1a-live-${runId}.txt`, content: `p1a-live-sentinel-${runId}`, parent_folder_id: testFolderId });
    if (!createResult.ok) {
      const reauth = isReauthSignal(createResult.reason);
      results.google_drive_create = "FAIL";
      results.google_drive_live = reauth ? "BLOCKED_REAUTH_REQUIRED" : "FAIL";
      log(`google_drive_create=FAIL (${createResult.reason})${reauth ? " - lesing fungerte men skriving feilet på auth -> reautorisering (bredere scope) nødvendig" : ""}`);
      return;
    }
    results.google_drive_create = "PASS";
    const mainFileId = createResult.ok ? createResult.external_id : undefined;
    if (mainFileId) createdFileIds.push(mainFileId);

    const subfolderResult = await drive("create_folder", { name: `p1a-live-subfolder-${runId}`, parent_folder_id: testFolderId });
    const subfolderId = subfolderResult.ok ? subfolderResult.external_id : undefined;
    if (subfolderId) createdFileIds.push(subfolderId);

    // §update/§rename/§move/§trash - alle på fila §create nettopp opprettet.
    if (mainFileId) {
      const updateResult = await drive("update_content", { file_id: mainFileId, content: `p1a-live-sentinel-oppdatert-${runId}` });
      results.google_drive_update = updateResult.ok ? "PASS" : "FAIL";

      const renameResult = await drive("rename", { file_id: mainFileId, new_name: `p1a-live-omdopt-${runId}.txt` });
      results.google_drive_rename = renameResult.ok ? "PASS" : "FAIL";

      if (subfolderId) {
        const moveResult = await drive("move", { file_id: mainFileId, new_parent_folder_id: subfolderId });
        results.google_drive_move = moveResult.ok ? "PASS" : "FAIL";
      } else {
        results.google_drive_move = "FAIL";
      }

      const trashResult = await drive("trash", { file_id: mainFileId });
      results.google_drive_trash = trashResult.ok ? "PASS" : "FAIL";
      log(`google_drive_update=${results.google_drive_update} rename=${results.google_drive_rename} move=${results.google_drive_move} trash=${results.google_drive_trash}`);
    }

    // §idempotency: SAMME idempotency_key to ganger - forventer samme external_id, deduplicated=true andre gang.
    const idemKey = `p1a-live-idem-${runId}`;
    const idemFirst = await toolGateway.execute({ identity, tool_id: "drive", action: "create_file", parameters: { name: `p1a-live-idem-${runId}.txt`, parent_folder_id: testFolderId }, idempotency_key: idemKey });
    const idemSecond = await toolGateway.execute({ identity, tool_id: "drive", action: "create_file", parameters: { name: `p1a-live-idem-${runId}.txt`, parent_folder_id: testFolderId }, idempotency_key: idemKey });
    results.google_drive_idempotency =
      idemFirst.ok && idemSecond.ok && idemFirst.external_id === idemSecond.external_id && idemSecond.deduplicated ? "PASS" : "FAIL";
    if (idemFirst.ok && idemFirst.external_id) createdFileIds.push(idemFirst.external_id);
    log(`google_drive_idempotency=${results.google_drive_idempotency}`);

    // §policy: klasse D (delete_permanent) utført AUTONOMT under owner sovereign - INGEN approval sendt, INGEN DENY.
    // §sync: samme GoogleDriveKnowledgeSource+KnowledgeSyncService som ingestion-siden, scopet til test-mappen.
    const source = new GoogleDriveKnowledgeSource(toolGateway, identity, { kind: "folder", folder_id: testFolderId }, `drive:p1a-live-${runId}`);
    const syncReport = await sync.sync(identity, SPACE, source);
    log(`drive live sync: ${JSON.stringify(syncReport)}`);
    results.google_drive_sync = syncReport.failed === 0 ? "PASS" : "FAIL";

    // §q20_no_resurrection: hard-delete den synkede raden + fingerprint (samme mønster som Obsidian-§4), resync skal IKKE gjenopplive.
    const syncedRow = await adminPool.query(
      "SELECT knowledge_document_id, external_id FROM knowledge_documents WHERE tenant_id=$1 AND source_type='google_drive' AND source_instance_id=$2 LIMIT 1",
      [TENANT_A, `drive:p1a-live-${runId}`]
    );
    const synced = syncedRow.rows[0] as { knowledge_document_id: string; external_id: string } | undefined;
    if (synced) {
      await adminPool.query("DELETE FROM knowledge_embeddings WHERE knowledge_document_id=$1", [synced.knowledge_document_id]);
      await adminPool.query("DELETE FROM knowledge_documents WHERE knowledge_document_id=$1", [synced.knowledge_document_id]);
      const reqId = `req-p1a-drive-live-${runId}`;
      await adminPool.query(
        "INSERT INTO erasure_requests (request_id, tenant_id, scope_type, scope_summary, status) VALUES ($1,$2,'knowledge_document','{}'::jsonb,'completed')",
        [reqId, TENANT_A]
      );
      const fingerprint = computeErasureFingerprint(TENANT_A, "google_drive", `drive:p1a-live-${runId}`, synced.external_id);
      await adminPool.query(
        "INSERT INTO erasure_fingerprints (fingerprint, tenant_id, source_type, source_instance_id, erasure_request_id) VALUES ($1,$2,'google_drive',$3,$4)",
        [fingerprint, TENANT_A, `drive:p1a-live-${runId}`, reqId]
      );
      const resync = await sync.sync(identity, SPACE, source);
      results.google_drive_q20_no_resurrection = resync.created === 0 && resync.suppressed >= 1 ? "PASS" : "FAIL";
      log(`google_drive_sync=${results.google_drive_sync} google_drive_q20_no_resurrection=${results.google_drive_q20_no_resurrection}`);
    } else {
      results.google_drive_q20_no_resurrection = "FAIL";
      log("google_drive_q20_no_resurrection=FAIL (ingen synket rad funnet å slette)");
    }

    // §cleanup: PERMANENT sletting av ALT denne kjøringen selv opprettet - ALDRI noe annet i test-mappen.
    let cleanupOk = true;
    for (const fileId of createdFileIds) {
      const deleteResult = await drive("delete_permanent", { file_id: fileId });
      if (!deleteResult.ok) cleanupOk = false;
    }
    results.google_drive_cleanup = cleanupOk ? "PASS" : "FAIL";
    results.google_drive_policy = cleanupOk ? "PASS" : "FAIL"; // delete_permanent (klasse D) lyktes autonomt under sovereign owner-policy
    log(`google_drive_cleanup=${results.google_drive_cleanup} google_drive_policy=${results.google_drive_policy}`);

    // §observability: OAuth-tokenet skal ALDRI havne i noe persistert eller loggbart felt.
    const auditRows = await adminPool.query("SELECT payload::text AS p FROM audit_events WHERE tenant_id=$1 AND tool_id='drive'", [TENANT_A]);
    const tokenLeak = (auditRows.rows as Array<{ p: string }>).some((r) => r.p.includes(refreshToken));
    const docRows = await adminPool.query("SELECT metadata::text AS m FROM knowledge_documents WHERE tenant_id=$1 AND source_type='google_drive'", [TENANT_A]);
    const docLeak = (docRows.rows as Array<{ m: string }>).some((r) => r.m.includes(refreshToken));
    diagnostics["drive_token_leak_audit"] = String(tokenLeak);
    diagnostics["drive_token_leak_metadata"] = String(docLeak);

    const allDrivePassed = [
      results.google_drive_auth_scope, results.google_drive_read, results.google_drive_create,
      results.google_drive_update, results.google_drive_rename, results.google_drive_move,
      results.google_drive_trash, results.google_drive_cleanup, results.google_drive_sync,
      results.google_drive_q20_no_resurrection, results.google_drive_idempotency, results.google_drive_policy
    ].every((v) => v === "PASS");
    results.google_drive_live = allDrivePassed && !tokenLeak && !docLeak ? "PASS" : "FAIL";
    log(`google_drive_live=${results.google_drive_live} (token_leak_audit=${tokenLeak} token_leak_metadata=${docLeak})`);
  });

  // Permission-mutasjon (create/update/delete_permission) er BEVISST IKKE
  // live-testet her - byggeordren tillater det KUN "hvis det kan gjøres
  // trygt uten å involvere ekte personer", og enhver reell permission-
  // mutasjon på Tobias sin faktiske Drive-konto involverer ETT AV: (a) en
  // ekte e-postadresse (en reell person/konto), eller (b) "anyone"/domain-
  // deling (en reell eksponeringsendring). Ingen av delene er trygt å
  // automatisere i en ubetjent akseptansekjøring. Policy/klassifisering for
  // permission-handlinger (klasse D, samme mønster som delete_permanent) er
  // allerede deterministisk suite-bevist (drive-full-access.test.ts §I).

  // ===== §7: OBSERVABILITY - INGEN full body i audit_events =====
  await section("§7 no-content-in-audit (Obsidian har ingen ToolGateway-vei; sjekker likevel bredt)", async () => {
    const rows = await adminPool.query(
      "SELECT payload::text AS p FROM audit_events WHERE tenant_id = ANY($1::text[])",
      [[TENANT_A, TENANT_B]]
    );
    const leaked = (rows.rows as Array<{ p: string }>).some((r) => r.p.includes(obsidianSentinel));
    results.p1a_no_content_in_audit = !leaked ? "PASS" : "FAIL";
    log(`p1a_no_content_in_audit=${results.p1a_no_content_in_audit}`);
  });

  // ===== §8: CLEANUP =====
  await section("§8 CLEANUP", async () => {
    await cleanupTenant(TENANT_A).catch((err: unknown) => log(`cleanup A feilet: ${(err as Error).message}`));
    await cleanupTenant(TENANT_B).catch((err: unknown) => log(`cleanup B feilet: ${(err as Error).message}`));
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch(() => undefined);
    if (vaultRoot) await rm(vaultRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  return finish();
}

function finish(): void {
  log("\n== UA-2 P1A LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) {
    log(`${key}=${value}`);
  }
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

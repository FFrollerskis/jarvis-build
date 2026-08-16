// UA-2 P1A LIVE ACCEPTANCE - kjøres AV TOBIAS mot ekte lokal Postgres/pgvector
// (docker-compose) og ekte filsystem. Gjenbruker KUN eksisterende arkitektur
// (@jarvis/knowledge, @jarvis/tool-gateway, @jarvis/policy, @jarvis/core) -
// ingen alternativ testimplementasjon. Speiler strukturen i
// modules/erasure/scripts/q20-erasure-live.ts (samme log()/section()/
// Verdict-mønster) og modules/knowledge/scripts/ua2-p0-live.ts.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/knowledge/scripts/ua2-p1a-live.ts
//
// Google Drive-akseptansen krever EKSPLISITT konfigurerte credentials OG en
// dedikert, trygg test-mappe (JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID) - finnes
// ikke ALLE fire (client id/secret, refresh token, test-mappe-id), rapporteres
// google_drive_live=BLOCKED_NO_SAFE_TEST_SCOPE og INGENTING live-kalles. Drive
// er READ ONLY her - ingen skriving/sletting mot ekte Drive-data, uansett.
// Obsidian-akseptansen bruker en ISOLERT MIDLERTIDIG vault under systemets
// temp-katalog - ALDRI Tobias sin ekte vault.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, computeErasureFingerprint, configFromEnv, createPool } from "@jarvis/core";
import { LocalHashEmbedding } from "@jarvis/memory";
import { GoogleDriveKnowledgeSource, KnowledgeRetriever, KnowledgeSourceRegistry, KnowledgeSyncService, ObsidianVaultKnowledgeSource } from "@jarvis/knowledge";
import { EnvSecretProvider, GoogleDriveTransport, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE" | "BLOCKED_NO_SAFE_TEST_SCOPE";

const results: Record<string, Verdict> = {
  p1a_registry_tenant_scoping: "FAIL",
  p1a_obsidian_lifecycle: "FAIL",
  p1a_obsidian_obsidian_dir_excluded: "FAIL",
  p1a_obsidian_frontmatter_wikilinks: "FAIL",
  p1a_obsidian_no_resurrection: "FAIL",
  p1a_tenant_isolation_new_sources: "FAIL",
  p1a_retrieval_new_sources: "FAIL",
  p1a_no_content_in_audit: "FAIL",
  google_drive_live: "BLOCKED_NO_SAFE_TEST_SCOPE"
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

  // ===== §6: GOOGLE DRIVE LIVE (KUN med eksplisitt trygt test-scope) =====
  await section("§6 GOOGLE DRIVE LIVE (betinget)", async () => {
    const clientId = process.env["JARVIS_GOOGLE_CLIENT_ID"];
    const clientSecret = process.env["JARVIS_GOOGLE_CLIENT_SECRET"];
    const refreshToken = process.env["JARVIS_GOOGLE_TOKEN"];
    const testFolderId = process.env["JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID"];
    if (!clientId || !clientSecret || !refreshToken || !testFolderId) {
      results.google_drive_live = "BLOCKED_NO_SAFE_TEST_SCOPE";
      log(
        `google_drive_live=BLOCKED_NO_SAFE_TEST_SCOPE (client_id=${Boolean(clientId)} client_secret=${Boolean(clientSecret)} token=${Boolean(refreshToken)} test_folder_id=${Boolean(testFolderId)}) - Drive er READ ONLY og krever en DEDIKERT, trygg test-mappe. Ingen live-kall forsøkt.`
      );
      return;
    }
    const devices = new InMemoryDeviceRegistry();
    const policy = new PolicyGateway({ devices, nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch() });
    const secrets = new EnvSecretProvider();
    const toolGateway = new ToolGateway(pool, policy, secrets);
    for (const tool of firstWaveTools({ drive: new GoogleDriveTransport() })) toolGateway.register(tool);
    const source = new GoogleDriveKnowledgeSource(toolGateway, identityFor(TENANT_A), { kind: "folder", folder_id: testFolderId }, `drive:p1a-live-${runId}`);
    const report = await sync.sync(identityFor(TENANT_A), SPACE, source);
    log(`drive live sync: ${JSON.stringify(report)}`);

    // §16 (P1A): OAuth-tokenet skal ALDRI havne i noe persistert eller loggbart felt.
    const auditRows = await adminPool.query("SELECT payload::text AS p FROM audit_events WHERE tenant_id=$1 AND tool_id='drive'", [TENANT_A]);
    const tokenLeak = (auditRows.rows as Array<{ p: string }>).some((r) => r.p.includes(refreshToken));
    const docRows = await adminPool.query("SELECT metadata::text AS m FROM knowledge_documents WHERE tenant_id=$1 AND source_type='google_drive'", [TENANT_A]);
    const docLeak = (docRows.rows as Array<{ m: string }>).some((r) => r.m.includes(refreshToken));

    results.google_drive_live = report.failed === 0 && !tokenLeak && !docLeak ? "PASS" : "FAIL";
    diagnostics["drive_test_folder_id"] = testFolderId;
    diagnostics["drive_scanned"] = String(report.scanned);
    log(`google_drive_live=${results.google_drive_live} (token_leak_audit=${tokenLeak} token_leak_metadata=${docLeak})`);
  });

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

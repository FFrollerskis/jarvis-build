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
// i CLAUDE.md): PRODUKSJON har full Google Drive read/write/permissions.
// UA-2 P1A HOST RECOVERY (samme dag, "auto-create safe Drive test sandbox"):
// Tobias skal ALDRI måtte manuelt opprette en test-mappe/finne en mappe-ID/
// redigere .env for å kjøre denne akseptansen. Er
// JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID satt, brukes den (kun LEST av runneren,
// ALDRI slettet). Er den IKKE satt, oppretter runneren SELV en unikt
// navngitt, midlertidig mappe ("Jarvis P1A Acceptance <run_id>") og rydder
// den opp igjen ved slutten. Se modules/knowledge/scripts/lib/
// drive-acceptance-sandbox.ts for den rene grensekontroll-/cleanup-logikken
// (fail-closed - en mutasjon mot en ID denne kjøringen ikke selv sporet som
// opprettet kastes FØR noe Drive-kall gjøres). Mangler client_id/_secret/
// token, rapporteres google_drive_live=BLOCKED_NO_SAFE_TEST_SCOPE og
// INGENTING live-kalles. Har credentials for LESING men mangler write-scope
// (token utstedt før scope-endringen), rapporteres
// google_drive_live=BLOCKED_REAUTH_REQUIRED - ALDRI en fake PASS.
// Permission-mutasjon (dele/tilgangsstyring) er BEVISST IKKE live-testet -
// kan ikke gjøres trygt uten å involvere en ekte person/endre ekte
// eksponering i en ubetjent kjøring; rapporteres
// google_drive_permission_live=SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL.
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
import { DriveAcceptanceSandbox, classifyCleanupOutcome, determineTestRootSource, driveAcceptanceFolderName, isReauthSignal } from "./lib/drive-acceptance-sandbox.ts";

type Verdict =
  | "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE" | "BLOCKED_NO_SAFE_TEST_SCOPE"
  | "BLOCKED_REAUTH_REQUIRED" | "SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL";

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
  google_drive_permanent_delete: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_cleanup: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_sync: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_q20_no_resurrection: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_idempotency: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_policy: "BLOCKED_NO_SAFE_TEST_SCOPE",
  google_drive_permission_live: "BLOCKED_NO_SAFE_TEST_SCOPE"
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

/**
 * HOST FIX #8 (2026-08-16, host-funn run_id ff16c69d): "update or delete on
 * table tenants violates foreign key constraint tool_executions_tenant_id_
 * fkey". Root cause funnet mot det FAKTISKE skjemaet (IKKE gjettet) -
 * `tool_executions.tenant_id` REFERENCES tenants (010_tool_executions.sql);
 * §N sin idempotency-test (ToolGateway sin idempotency_key-dedupe) skriver
 * ÉN rad dit for TENANT_A, og denne funksjonen slettet den aldri FØR
 * `DELETE FROM tenants` ble forsøkt. Rekkefølgen under er FK-trygg (barn FØR
 * foreldre), utledet fra selve migrasjonsgrafen - ALDRI en gjettet
 * tabelliste, ALDRI `DISABLE TRIGGER`/`TRUNCATE`/en superbruker-omvei.
 *
 * BEVISST IKKE inkludert (verifisert mot faktisk kildekode, ikke antatt):
 * `audit_events.tenant_id` er en REN TEKSTKOLONNE (INGEN `REFERENCES
 * tenants` - se 004_audit_cost.sql) OG append-only-trigger-beskyttet
 * (samme Q-20-presedens: `events`/`audit_events` forblir aldri slettet her)
 * - blokkerer derfor IKKE denne slettingen og skal ALDRI forsøkes slettet.
 * `sessions`/`messages`/`events`/`devices`/`approvals`/`cost_events`/
 * `brief_seen` opprettes ALDRI av P1A-akseptansen (verifisert - ingen av
 * kallene her går via session-service.ts/message-store.ts/event-writer.ts/
 * device-service.ts/approval-store.ts/daily-brief.ts) - IKKE rørt, for å
 * aldri risikere å tømme en ekte operasjonell tabell utover denne
 * akseptansens egne midlertidige rader.
 */
async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
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

  // ===== §6: GOOGLE DRIVE LIVE FULL READ/WRITE (auto-oppretter en sikker sandkasse hvis ingen er konfigurert) =====
  await section("§6 GOOGLE DRIVE LIVE (betinget, full read/write, auto-sandkasse)", async () => {
    const clientId = process.env["JARVIS_GOOGLE_CLIENT_ID"];
    const clientSecret = process.env["JARVIS_GOOGLE_CLIENT_SECRET"];
    const refreshToken = process.env["JARVIS_GOOGLE_TOKEN"];
    const configuredTestFolderId = process.env["JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID"];
    if (!clientId || !clientSecret || !refreshToken) {
      log(
        `google_drive_live=BLOCKED_NO_SAFE_TEST_SCOPE (client_id=${Boolean(clientId)} client_secret=${Boolean(clientSecret)} token=${Boolean(refreshToken)}) - ingen Google-credentials konfigurert. Ingen live-kall forsøkt.`
      );
      return;
    }
    const testRootSource = determineTestRootSource(configuredTestFolderId);
    diagnostics["google_drive_test_scope"] = testRootSource === "configured" ? "CONFIGURED" : "AUTO_CREATED";

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

    async function drive(action: string, parameters: Record<string, JsonValue>) {
      return toolGateway.execute({ identity, tool_id: "drive", action, parameters });
    }

    // §2/§A i host-recovery-ordren: rent LESE-scope-probe FØRST - INGEN
    // mutasjon, ingen avhengighet av forhåndseksisterende filer ("root" er en
    // reservert Drive-id for brukerens egen rot, alltid trygg å lese).
    const rootProbe = await drive("get_metadata", { file_id: "root" });
    if (!rootProbe.ok) {
      const reauth = isReauthSignal(rootProbe.reason);
      results.google_drive_auth_scope = reauth ? "BLOCKED_REAUTH_REQUIRED" : "FAIL";
      results.google_drive_live = reauth ? "BLOCKED_REAUTH_REQUIRED" : "FAIL";
      log(`google_drive_auth_scope=${results.google_drive_auth_scope} (get_metadata("root") feilet: ${rootProbe.reason}) - stopper FØR noe forsøkes.`);
      return;
    }

    // Test-roten: enten Tobias sin eksplisitt konfigurerte mappe (kun LEST
    // her, ALDRI slettet av runneren), eller en NY, unikt navngitt mappe
    // denne kjøringen selv oppretter - som SAMTIDIG er den første
    // skrive-scope-proben (§B, §7 i host-recovery-ordren).
    let sandbox: DriveAcceptanceSandbox;
    if (testRootSource === "configured") {
      const configuredId = configuredTestFolderId as string;
      const readConfigured = await drive("get_metadata", { file_id: configuredId });
      if (!readConfigured.ok) {
        const reauth = isReauthSignal(readConfigured.reason);
        results.google_drive_auth_scope = reauth ? "BLOCKED_REAUTH_REQUIRED" : "FAIL";
        results.google_drive_live = reauth ? "BLOCKED_REAUTH_REQUIRED" : "FAIL";
        log(`google_drive_auth_scope=${results.google_drive_auth_scope} (konfigurert test-mappe ${configuredId} ikke lesbar: ${readConfigured.reason})`);
        return;
      }
      sandbox = new DriveAcceptanceSandbox(configuredId, false);
    } else {
      // BEVISST INGEN søk-etter-lignende-navn-og-gjenbruk her (§1 i ordren) -
      // ALLTID en fersk create_folder, ALDRI en list_files-basert oppslag.
      const folderName = driveAcceptanceFolderName(runId);
      const createRoot = await drive("create_folder", { name: folderName });
      if (!createRoot.ok) {
        const reauth = isReauthSignal(createRoot.reason);
        results.google_drive_auth_scope = reauth ? "BLOCKED_REAUTH_REQUIRED" : "FAIL";
        results.google_drive_live = reauth ? "BLOCKED_REAUTH_REQUIRED" : "FAIL";
        log(
          `google_drive_auth_scope=${results.google_drive_auth_scope} (auto-opprettelse av sandkasse-mappe feilet: ${createRoot.reason})` +
            `${reauth ? " - lesing fungerte men skriving feilet på auth -> reautorisering nødvendig" : ""}`
        );
        return;
      }
      sandbox = new DriveAcceptanceSandbox(createRoot.external_id as string, true);
    }
    results.google_drive_auth_scope = "PASS";
    diagnostics["google_drive_test_root_id"] = sandbox.rootId;
    log(`google_drive_test_scope=${diagnostics["google_drive_test_scope"]} root=${sandbox.rootId}`);

    /** §3 i ordren: fail-closed grensekontroll FØR ethvert mutasjonskall - en ID utenfor sandkassen kastes, aldri "prøv og se". */
    async function driveMutate(action: string, fileId: string, extraParams: Record<string, JsonValue> = {}) {
      sandbox.assertInSandbox(fileId);
      return drive(action, { file_id: fileId, ...extraParams });
    }

    // §H/§D: lesing INNENFOR sandkassen - listing + metadata.
    const listResult = await drive("list_files", { folder_id: sandbox.rootId });
    const rootMetaResult = await drive("get_metadata", { file_id: sandbox.rootId });
    results.google_drive_read = listResult.ok && rootMetaResult.ok ? "PASS" : "FAIL";

    // §B/§C: to undermapper (for §G move) + hovedtestfila - ALLE barn av sandkassen, sporet FØR de kan bli mutasjonsmål.
    const subfolderAResult = await drive("create_folder", { name: `subfolder-a-${runId}`, parent_folder_id: sandbox.rootId });
    const subfolderBResult = await drive("create_folder", { name: `subfolder-b-${runId}`, parent_folder_id: sandbox.rootId });
    const subfolderAId = subfolderAResult.ok ? subfolderAResult.external_id : undefined;
    const subfolderBId = subfolderBResult.ok ? subfolderBResult.external_id : undefined;
    if (subfolderAId) sandbox.trackCreated(subfolderAId);
    if (subfolderBId) sandbox.trackCreated(subfolderBId);

    const createResult = subfolderAId
      ? await drive("create_file", { name: `p1a-live-${runId}.txt`, content: `p1a-live-sentinel-${runId}`, parent_folder_id: subfolderAId })
      : ({ ok: false, reason: "subfolder_a_missing" } as const);
    const mainFileId = createResult.ok ? createResult.external_id : undefined;
    if (mainFileId) sandbox.trackCreated(mainFileId);
    results.google_drive_create = subfolderAId && subfolderBId && mainFileId ? "PASS" : "FAIL";
    if (results.google_drive_create !== "PASS") {
      const anyReauth = [subfolderAResult, subfolderBResult, createResult].some((r) => !r.ok && isReauthSignal(r.reason));
      results.google_drive_live = anyReauth ? "BLOCKED_REAUTH_REQUIRED" : "FAIL";
      log(`google_drive_create=FAIL (subfolder_a=${Boolean(subfolderAId)} subfolder_b=${Boolean(subfolderBId)} main_file=${Boolean(mainFileId)})`);
      return;
    }
    log(`google_drive_read=${results.google_drive_read} google_drive_create=PASS root=${sandbox.rootId} subfolder_a=${subfolderAId} subfolder_b=${subfolderBId} main_file=${mainFileId}`);

    // §E/§F/§G: update/rename/move - ALLE grensekontrollert via sandbox.assertInSandbox().
    const fileId = mainFileId as string;
    const updateResult = await driveMutate("update_content", fileId, { content: `p1a-live-sentinel-oppdatert-${runId}` });
    results.google_drive_update = updateResult.ok ? "PASS" : "FAIL";

    const renameResult = await driveMutate("rename", fileId, { new_name: `p1a-live-omdopt-${runId}.txt` });
    results.google_drive_rename = renameResult.ok ? "PASS" : "FAIL";

    const moveResult = await driveMutate("move", fileId, { new_parent_folder_id: subfolderBId as string });
    results.google_drive_move = moveResult.ok ? "PASS" : "FAIL";
    log(`google_drive_update=${results.google_drive_update} rename=${results.google_drive_rename} move=${results.google_drive_move} (subfolder-a -> subfolder-b)`);

    // §I/§J: samme GoogleDriveKnowledgeSource+KnowledgeSyncService som ingestion-siden - scopet til subfolder-b (der fila nå ligger etter §move) - + retrieval.
    const source = new GoogleDriveKnowledgeSource(toolGateway, identity, { kind: "folder", folder_id: subfolderBId as string }, `drive:p1a-live-${runId}`);
    const syncReport = await sync.sync(identity, SPACE, source);
    const foundAfterSync = await retriever.search(identity, { query: `p1a-live-sentinel-oppdatert-${runId}`, spaces: [SPACE] });
    results.google_drive_sync =
      syncReport.failed === 0 && foundAfterSync.some((r) => r.content.includes(`p1a-live-sentinel-oppdatert-${runId}`)) ? "PASS" : "FAIL";
    log(`drive live sync: ${JSON.stringify(syncReport)} google_drive_sync=${results.google_drive_sync}`);

    // §K/§L/§M: hard-delete den synkede raden + fingerprint (samme mønster som Obsidian-§4) - resync skal IKKE gjenopplive, OG Drive-originalen skal FORTSATT eksistere uavhengig av det.
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
      const driveOriginalStillExists = await drive("get_metadata", { file_id: fileId });
      results.google_drive_q20_no_resurrection =
        resync.created === 0 && resync.suppressed >= 1 && driveOriginalStillExists.ok ? "PASS" : "FAIL";
      log(`google_drive_q20_no_resurrection=${results.google_drive_q20_no_resurrection} (drive_original_still_exists=${driveOriginalStillExists.ok})`);
    } else {
      results.google_drive_q20_no_resurrection = "FAIL";
      log("google_drive_q20_no_resurrection=FAIL (ingen synket rad funnet å slette)");
    }

    // §O: trash er reversibelt - fila skal FORTSATT eksistere (trashed=true), ikke borte.
    const trashResult = await driveMutate("trash", fileId);
    results.google_drive_trash = trashResult.ok ? "PASS" : "FAIL";
    if (trashResult.ok) sandbox.markTrashed(fileId);
    log(`google_drive_trash=${results.google_drive_trash}`);

    // §N: SAMME idempotency_key to ganger for en NY fil - forventer samme external_id, deduplicated=true andre gang.
    const idemKey = `p1a-live-idem-${runId}`;
    const idemParams = { name: `p1a-live-idem-${runId}.txt`, parent_folder_id: subfolderAId as string };
    const idemFirst = await toolGateway.execute({ identity, tool_id: "drive", action: "create_file", parameters: idemParams, idempotency_key: idemKey });
    const idemSecond = await toolGateway.execute({ identity, tool_id: "drive", action: "create_file", parameters: idemParams, idempotency_key: idemKey });
    results.google_drive_idempotency =
      idemFirst.ok && idemSecond.ok && idemFirst.external_id === idemSecond.external_id && idemSecond.deduplicated ? "PASS" : "FAIL";
    if (idemFirst.ok && idemFirst.external_id) sandbox.trackCreated(idemFirst.external_id);
    log(`google_drive_idempotency=${results.google_drive_idempotency}`);

    // §P: permanent sletting - KUN på fila DENNE kjøringen selv opprettet; sandbox.assertInSandbox() garanterer det strukturelt, ikke bare ved konvensjon.
    const permanentDeleteResult = await driveMutate("delete_permanent", fileId);
    results.google_drive_permanent_delete = permanentDeleteResult.ok ? "PASS" : "FAIL";
    // HOST FIX #8 (2026-08-16, run_id ff16c69d): fila er NÅ faktisk borte fra
    // Drive - merkes ØYEBLIKKELIG PERMANENTLY_DELETED slik at §5-oppryddingen
    // under ALDRI forsøker å slette den på nytt (root cause for den
    // observerte google_drive_cleanup=FAIL: et redundant delete_permanent-
    // forsøk mot en allerede slettet fil traff klasse-D sin egen
    // preflight-sjekk med en 404 FØR transportens idempotente
    // 404-håndtering noensinne ble nådd - se drive-acceptance-sandbox.ts).
    if (permanentDeleteResult.ok) sandbox.markPermanentlyDeleted(fileId);
    // §Q: klasse D lyktes AUTONOMT under owner sovereign-policy - ingen approval sendt, ingen DENY (delegert/approval-vei suite-bevist separat).
    results.google_drive_policy = permanentDeleteResult.ok ? "PASS" : "FAIL";
    log(`google_drive_permanent_delete=${results.google_drive_permanent_delete} google_drive_policy=${results.google_drive_policy}`);

    // Permission-mutasjon: BEVISST IKKE live-testet (§4 i host-recovery-
    // ordren) - enhver reell permission-mutasjon på Tobias sin faktiske
    // Drive-konto involverer ETT AV: (a) en ekte e-postadresse (en reell
    // person/konto), eller (b) "anyone"/domain-deling (en reell
    // eksponeringsendring). Ingen av delene er trygt å automatisere i en
    // ubetjent akseptansekjøring. Policy/klassifisering for permission-
    // handlinger (klasse D, samme mønster som delete_permanent) er allerede
    // deterministisk suite-bevist (drive-full-access.test.ts §I) - dette
    // svekker ALDRI produksjonens permission-kapabilitet, kun hva denne
    // akseptansekjøringen selv utfører.
    results.google_drive_permission_live = "SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL";
    log(`google_drive_permission_live=${results.google_drive_permission_live}`);

    // §5: opprydding - permanent sletting av ALT ANNET denne kjøringen selv
    // opprettet (undermapper, idempotency-testfil, evt. auto-opprettet rot),
    // barn FØR roten. En eksplisitt KONFIGURERT rot slettes ALDRI.
    //
    // HOST FIX #8 (2026-08-16, run_id ff16c69d): `sandbox.cleanupTargets()`
    // utelater NÅ strukturelt hovedtestfila (merket PERMANENTLY_DELETED rett
    // etter §P over) - det redundante slettingsforsøket som forårsaket den
    // observerte `google_drive_cleanup=FAIL` (targets=5, root_deleted=true)
    // skjer derfor ALDRI lenger. `classifyCleanupOutcome()` er likevel et
    // bevisst forsvar-i-dybden-lag: en EKTE 404 for et SPORT sandkasse-
    // artefakt (sandbox.has()) telles trygt som "already_absent" (ALDRI
    // generalisert til vilkårlige Drive-filer utenfor sandkassen) - kun en
    // ANNEN feilårsak (rate-limit/auth/ukjent) teller som en faktisk
    // cleanup-svikt.
    const createdArtifactIds = sandbox.createdArtifactIds();
    const preCleanupAlreadyGone = createdArtifactIds.filter((id) => sandbox.stateOf(id) === "PERMANENTLY_DELETED").length;
    let cleanedCount = 0;
    let alreadyAbsentDuringCleanup = 0;
    let cleanupFailures = 0;
    const cleanupTargets = sandbox.cleanupTargets();
    for (const targetId of cleanupTargets) {
      const deleteResult = await drive("delete_permanent", { file_id: targetId });
      const outcome = classifyCleanupOutcome(sandbox, targetId, deleteResult);
      if (outcome === "cleaned") {
        cleanedCount++;
        sandbox.markCleaned(targetId);
      } else if (outcome === "already_absent") {
        alreadyAbsentDuringCleanup++;
        sandbox.markCleaned(targetId);
      } else {
        cleanupFailures++;
        log(`google_drive_cleanup target=${targetId} FEILET: ${deleteResult.ok ? "" : deleteResult.reason}`);
      }
    }
    const alreadyAbsentTotal = preCleanupAlreadyGone + alreadyAbsentDuringCleanup;
    // §4 i ordren: PASS avgjøres UTELUKKENDE av faktiske cleanup_failures -
    // ALDRI av at root_deleted=true alene (root kan ha blitt slettet mens et
    // ANNET mål feilet).
    results.google_drive_cleanup = cleanupFailures === 0 ? "PASS" : "FAIL";
    log(
      `google_drive_cleanup=${results.google_drive_cleanup} created_artifacts=${createdArtifactIds.length} ` +
        `cleaned_artifacts=${cleanedCount} already_absent=${alreadyAbsentTotal} cleanup_failures=${cleanupFailures} ` +
        `root_deleted=${sandbox.autoCreated}`
    );

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
      results.google_drive_trash, results.google_drive_permanent_delete, results.google_drive_cleanup,
      results.google_drive_sync, results.google_drive_q20_no_resurrection, results.google_drive_idempotency,
      results.google_drive_policy
    ].every((v) => v === "PASS");
    results.google_drive_live = allDrivePassed && !tokenLeak && !docLeak ? "PASS" : "FAIL";
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

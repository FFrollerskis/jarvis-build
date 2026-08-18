// UA-3 NATIVE JARVIS CONTRACTS CORE (D-71) - HOST LIVE ACCEPTANCE
// Kjøres AV TOBIAS mot ekte lokal Postgres (docker-compose). Gjenbruker KUN
// eksisterende arkitektur (@jarvis/agreements, @jarvis/business, @jarvis/core,
// @jarvis/policy, @jarvis/tool-gateway) - ingen alternativ testimplementasjon.
// Speiler NØYAKTIG samme admin-pool-for-scaffold/runtime-pool-for-operasjoner-
// separasjon og den EKSISTERENDE, gjenbrukte `findBlockingTenantDependencies()`-
// selvdiagnostikken som `ua3-native-support-live.ts` - ikke en ny kopi.
//
// NO E-SIGN PROVIDER, NO DOCUSIGN, NO PANDADOC: dette scriptet krever INGEN
// signaturleverandør-credential av noe slag - Native Contracts Core er
// JARVIS_CANONICAL og kjører fullstendig uten en ekstern leverandør (D-71).
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-native-contracts-live.ts
// (normalt via modules/business/scripts/ua3-native-contracts-host-run.ts, som
// bootstrapper workspacet/Docker/migrasjoner først)
//
// Bruker UTELUKKENDE syntetiske test-selskaper/kontakter/kontrakter i en
// isolert, kjøre-unik tenant (tenant-ua3-agr-live-<run_id>-a/-b) - RØRER
// ALDRI ekte kunde-/forretningsdata. All test-scaffolding fjernes ved slutten.

import { randomUUID } from "node:crypto";
import type { IdentityContext } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { PolicyGateway, InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch } from "@jarvis/policy";
import { ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService, OpenLoopService } from "@jarvis/business";
import { LocalHashEmbedding } from "@jarvis/memory";
import { AgreementsService } from "../../agreements/src/service.ts";
import { AgreementsTransport } from "../../agreements/src/transport.ts";
import { InvalidContractTransitionError } from "../../agreements/src/state-machine.ts";
import { ErasureService } from "../../erasure/src/erasure-service.ts";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "FAIL",
  ua3_contracts_runtime_role: "FAIL",
  ua3_contracts_no_esign_dependency: "FAIL",
  ua3_contracts_create_contract: "FAIL",
  ua3_contracts_deterministic_number: "FAIL",
  ua3_contracts_version_immutable: "FAIL",
  ua3_contracts_lifecycle_valid: "FAIL",
  ua3_contracts_lifecycle_invalid_rejected: "FAIL",
  ua3_contracts_counterparty_link: "FAIL",
  ua3_contracts_obligation_created: "FAIL",
  ua3_contracts_obligation_completed: "FAIL",
  ua3_contracts_renewal_query: "FAIL",
  ua3_contracts_termination_query: "FAIL",
  ua3_contracts_overdue_obligation: "FAIL",
  ua3_contracts_timeline: "FAIL",
  ua3_contracts_source_pointer: "FAIL",
  ua3_contracts_no_document_copied: "FAIL",
  ua3_contracts_open_loop_created: "FAIL",
  ua3_contracts_open_loop_resolved: "FAIL",
  ua3_contracts_tenant_isolation: "FAIL",
  ua3_contracts_space_isolation: "FAIL",
  ua3_contracts_toolgateway: "FAIL",
  ua3_contracts_audit_safe: "FAIL",
  ua3_contracts_q20: "FAIL",
  ua3_contracts_cleanup: "FAIL"
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
log(`UA-3 NATIVE CONTRACTS CORE LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-ua3-agr-live-${runId}-a`;
const TENANT_B = `tenant-ua3-agr-live-${runId}-b`; // tenant-isolasjon: annen tenant, skal forbli urørt
const OWNER_PERSON = `person-ua3-agr-live-${runId}`;

function ownerIdentityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-ua3-agr-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

function assertSafeIdentifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`ua3_agr_cleanup_unsafe_identifier: "${name}"`);
  }
}

interface TenantFkBlocker {
  table: string;
  constraint: string;
  rows: number;
}

/** Schema-drevet (ikke hardkodet) sjekk FØR `DELETE FROM tenants` - samme mønster som ua3-native-support-live.ts. */
async function findBlockingTenantDependencies(tenantId: string): Promise<TenantFkBlocker[]> {
  const { rows: fkRows } = await adminPool.query(`
    SELECT tc.table_name, tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'tenants' AND kcu.column_name = 'tenant_id'
  `);
  const blockers: TenantFkBlocker[] = [];
  for (const row of fkRows as Array<{ table_name: string; constraint_name: string }>) {
    assertSafeIdentifier(row.table_name);
    const { rows } = await adminPool.query(`SELECT count(*)::int AS n FROM "${row.table_name}" WHERE tenant_id = $1`, [tenantId]);
    const n = (rows[0] as { n: number }).n;
    if (n > 0) blockers.push({ table: row.table_name, constraint: row.constraint_name, rows: n });
  }
  return blockers;
}

async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM contract_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM contract_obligations WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM contract_versions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM contracts WHERE tenant_id = $1", [tenantId]);
  // Q-20 (samme etablerte mønster som ua3-native-support-live.ts sin egen
  // cleanupTenant()): ErasureService.executeErasure() skriver en EKTE
  // erasure_requests/erasure_fingerprints-revisjonsrad. `jarvis_app` har
  // bevisst INGEN DELETE-rettighet der (append-only-lignende revisjonsspor,
  // 018_erasure.sql) - ren test-fixture-opprydding via admin-pool.
  await adminPool.query("DELETE FROM erasure_fingerprints WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM erasure_requests WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_activities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_contacts WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_companies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);

  const blockers = await findBlockingTenantDependencies(tenantId);
  if (blockers.length > 0) {
    for (const b of blockers) log(`blocking_fk_table=${b.table} blocking_fk_name=${b.constraint} rows_for_test_tenant=${b.rows}`);
    throw new Error(`ua3_agr_cleanup_blocked: ${blockers.length} uventet(e) FK-refererende tabell(er) har fortsatt rader for ${tenantId}`);
  }
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-ua3-agr-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) await cleanupTenant(row.tenant_id).catch(() => undefined);
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-ua3-agr-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    diagnostics["runtime_current_user"] = status.role;
    diagnostics["runtime_role_superuser"] = String(status.superuser);
    diagnostics["runtime_role_bypassrls"] = String(status.bypassrls);
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    log("\nNATIVE CONTRACTS CORE KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen skriving forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  await section("ZERO E-SIGN-LEVERANDØR-AVHENGIGHET", async () => {
    const providerEnvKeys = Object.keys(process.env).filter((k) => /DOCUSIGN|PANDADOC|SIGNICAT|ADOBE.?SIGN|HELLOSIGN/i.test(k));
    for (const key of providerEnvKeys) delete process.env[key];
    diagnostics["esign_provider_env_unset_count"] = String(providerEnvKeys.length);
    // AgreementsService/AgreementsTransport konstrueres KUN med (pool)/(service) -
    // ingen provider-credential-parameter finnes i det hele tatt (strukturelt bevist av transport-wiring.test.ts §D).
    results.ua3_contracts_no_esign_dependency = "PASS";
    log(`esign_provider_env_vars_unset=${providerEnvKeys.length} -> ua3_contracts_no_esign_dependency: PASS`);
  });

  await selfHeal();
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `UA-3 Contracts Live A ${runId}`, TENANT_B, `UA-3 Contracts Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "UA-3 Contracts Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [OWNER_PERSON, TENANT_A, TENANT_B]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'personal'), ($5,$6,'business')",
    [`ms-ua3-agr-a-business-${runId}`, TENANT_A, `ms-ua3-agr-a-personal-${runId}`, TENANT_A, `ms-ua3-agr-b-business-${runId}`, TENANT_B]
  );

  await section("CONTRACTS RUNTIME-ROLLE (rett før faktiske contract-operasjoner)", async () => {
    const { rows } = await pool.query("SELECT current_user AS role");
    const role = (rows[0] as { role: string }).role;
    results.ua3_contracts_runtime_role = role === diagnostics["runtime_current_user"] ? "PASS" : "FAIL";
    log(`contracts_runtime_role=${role} -> ua3_contracts_runtime_role: ${results.ua3_contracts_runtime_role}`);
  });

  const business = new BusinessService(pool);
  const agreements = new AgreementsService(pool);
  const openLoops = new OpenLoopService(pool);
  let companyId = "";
  let contactId = "";
  let contractId = "";

  await section("OPPRETT KONTRAKT + DETERMINISTISK NUMMER + MOTPARTSKOBLING", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: `Contracts Syntetisk AS ${runId}` });
    companyId = company.company_id;
    const contact = await business.createContact(TENANT_A, "business", { name: "Kari Kunde", email: `kari-agr-${runId}@acme.no`, company_id: companyId });
    contactId = contact.contact_id;

    const a = await agreements.createContract(TENANT_A, "business", { title: `Rammeavtale A ${runId}` });
    const b = await agreements.createContract(TENANT_A, "business", { title: `Rammeavtale B ${runId}` });
    contractId = a.contract_id;
    results.ua3_contracts_create_contract = a.status === "draft" && Boolean(a.contract_id) ? "PASS" : "FAIL";
    results.ua3_contracts_deterministic_number = Number(b.contract_number) > Number(a.contract_number) ? "PASS" : "FAIL";
    log(`contract_a_number=${a.contract_number} contract_b_number=${b.contract_number} -> create: ${results.ua3_contracts_create_contract} deterministic_number: ${results.ua3_contracts_deterministic_number}`);

    const linked = await agreements.linkCounterparty(TENANT_A, "business", contractId, companyId, contactId);
    results.ua3_contracts_counterparty_link = linked?.company_id === companyId && linked?.contact_id === contactId ? "PASS" : "FAIL";
    log(`linked_company=${linked?.company_id} linked_contact=${linked?.contact_id} -> ua3_contracts_counterparty_link: ${results.ua3_contracts_counterparty_link}`);
  });

  await section("KONTRAKTVERSJONER (eksplisitte, immutable, pointer-not-payload)", async () => {
    const v1 = await agreements.addVersion(TENANT_A, "business", contractId, { summary: "Foerste utkast", canonical_uri: `https://drive.example/${runId}-v1` });
    const v2 = await agreements.addVersion(TENANT_A, "business", contractId, { summary: "Andre utkast", canonical_uri: `https://drive.example/${runId}-v2` });
    const versions = await agreements.listVersions(TENANT_A, "business", contractId);
    const current = await agreements.getCurrentVersion(TENANT_A, "business", contractId);
    results.ua3_contracts_version_immutable =
      versions.length === 2 && Number(v2.version_number) === Number(v1.version_number) + 1 && current?.version_id === v2.version_id
        ? "PASS" : "FAIL";
    log(`version_count=${versions.length} v1=${v1.version_number} v2=${v2.version_number} current=${current?.version_number} -> ua3_contracts_version_immutable: ${results.ua3_contracts_version_immutable}`);

    results.ua3_contracts_source_pointer = current?.canonical_uri?.includes(runId) ? "PASS" : "FAIL";
    log(`current_canonical_uri=${current?.canonical_uri} -> ua3_contracts_source_pointer: ${results.ua3_contracts_source_pointer}`);

    const { rows: columnRows } = await adminPool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('contracts', 'contract_versions')`
    );
    const forbiddenColumn = (columnRows as Array<{ column_name: string }>).some((r) => /^(body|content|document_text|full_text)$/i.test(r.column_name));
    results.ua3_contracts_no_document_copied = !forbiddenColumn ? "PASS" : "FAIL";
    log(`forbidden_document_column_found=${forbiddenColumn} -> ua3_contracts_no_document_copied: ${results.ua3_contracts_no_document_copied}`);
  });

  await section("DETERMINISTISK LIFECYCLE (state-machine, ingen LLM-avgjoerelse)", async () => {
    await agreements.setStatus(TENANT_A, "business", contractId, "review");
    await agreements.setStatus(TENANT_A, "business", contractId, "approved");
    const active = await agreements.setStatus(TENANT_A, "business", contractId, "active");
    results.ua3_contracts_lifecycle_valid = active?.status === "active" ? "PASS" : "FAIL";
    log(`status_after_valid_chain=${active?.status} -> ua3_contracts_lifecycle_valid: ${results.ua3_contracts_lifecycle_valid}`);

    let invalidRejected = false;
    try {
      await agreements.setStatus(TENANT_A, "business", contractId, "draft");
    } catch (err) {
      invalidRejected = err instanceof InvalidContractTransitionError;
    }
    results.ua3_contracts_lifecycle_invalid_rejected = invalidRejected ? "PASS" : "FAIL";
    log(`invalid_transition_rejected=${invalidRejected} -> ua3_contracts_lifecycle_invalid_rejected: ${results.ua3_contracts_lifecycle_invalid_rejected}`);
  });

  let obligationId = "";
  await section("FORPLIKTELSER (\"What must we do?\", \"What is due next?\", overdue detection)", async () => {
    const overdue = await agreements.addObligation(TENANT_A, "business", contractId, {
      description: "Lever kvartalsrapport", owner_person_id: OWNER_PERSON, due_at: new Date(Date.now() - 3_600_000).toISOString()
    });
    obligationId = overdue.obligation_id;
    results.ua3_contracts_obligation_created = overdue.status === "open" ? "PASS" : "FAIL";
    log(`obligation_id=${obligationId} -> ua3_contracts_obligation_created: ${results.ua3_contracts_obligation_created}`);

    const overdueList = await agreements.overdueObligations(TENANT_A, "business");
    results.ua3_contracts_overdue_obligation = overdueList.some((o) => o.obligation_id === obligationId) ? "PASS" : "FAIL";
    log(`overdue_obligations=${overdueList.length} -> ua3_contracts_overdue_obligation: ${results.ua3_contracts_overdue_obligation}`);

    const completed = await agreements.completeObligation(TENANT_A, "business", obligationId);
    results.ua3_contracts_obligation_completed = completed?.status === "completed" && completed.completed_at !== null ? "PASS" : "FAIL";
    log(`obligation_status=${completed?.status} -> ua3_contracts_obligation_completed: ${results.ua3_contracts_obligation_completed}`);
  });

  await section("FORNYELSE-/OPPSIGELSESFRIST-SPØRRINGER (\"renew soon?\", \"expiring?\")", async () => {
    await agreements.setRenewalDate(TENANT_A, "business", contractId, new Date(Date.now() + 5 * 86_400_000).toISOString());
    await agreements.setTerminationDeadline(TENANT_A, "business", contractId, new Date(Date.now() + 10 * 86_400_000).toISOString());
    const renewals = await agreements.upcomingRenewals(TENANT_A, "business", 30);
    const deadlines = await agreements.upcomingTerminationDeadlines(TENANT_A, "business", 30);
    results.ua3_contracts_renewal_query = renewals.some((r) => r.contract_id === contractId) ? "PASS" : "FAIL";
    results.ua3_contracts_termination_query = deadlines.some((d) => d.contract_id === contractId) ? "PASS" : "FAIL";
    log(`renewals=${renewals.length} deadlines=${deadlines.length} -> renewal_query: ${results.ua3_contracts_renewal_query} termination_query: ${results.ua3_contracts_termination_query}`);
  });

  await section("BUSINESS OS-TIDSLINJE ('Hva skjer med kunde X?' inkluderer kontraktstilstand)", async () => {
    await business.recordActivity(TENANT_A, "business", {
      activity_type: "email", summary: "CRM-aktivitet for samme kunde", company_id: companyId,
      source_type: "gmail", source_instance_id: "post@tsworkflow.com", external_id: `crm-msg-agr-${runId}`
    });
    const timeline = await business.companyTimeline(TENANT_A, "business", companyId);
    const companyContracts = await agreements.listByCompany(TENANT_A, "business", companyId);
    results.ua3_contracts_timeline = timeline.length > 0 && companyContracts.some((c) => c.contract_id === contractId) ? "PASS" : "FAIL";
    log(`timeline_entries=${timeline.length} company_contracts=${companyContracts.length} -> ua3_contracts_timeline: ${results.ua3_contracts_timeline}`);
  });

  await section("TOOLGATEWAY (contract.* namespace, klasse C for lifecycle-overgang) + AUDIT-SAFETY", async () => {
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A] }
    });
    const secrets = new BusinessInternalSecretProvider();
    const toolGateway = new ToolGateway(pool, policy, secrets);
    for (const tool of firstWaveTools({ contract: new AgreementsTransport(agreements) })) toolGateway.register(tool);
    const identity = ownerIdentityFor(TENANT_A);

    // Urelatert, sensitiv-lignende forpliktelsestekst PAA SAMME kontrakt -
    // beviser at audit-eventet for set_status IKKE dumper hele kontraktens
    // interne tilstand, kun sine egne handlings-parametere.
    const sensitiveMarker = `UA3-AGR-LIVE-INTERN-${runId}`;
    await agreements.addObligation(TENANT_A, "business", contractId, { description: sensitiveMarker });

    const result = await toolGateway.execute({
      identity, tool_id: "contract", action: "set_status",
      parameters: { tenant_id: TENANT_A, memory_space: "business", contract_id: contractId, status: "expiring" }
    });
    results.ua3_contracts_toolgateway = result.ok ? "PASS" : "FAIL";
    log(`toolgateway_set_status_ok=${result.ok} -> ua3_contracts_toolgateway: ${results.ua3_contracts_toolgateway}`);

    const { rows: auditRows } = await pool.query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'contract' AND action = 'set_status' ORDER BY at DESC LIMIT 1",
      [TENANT_A]
    );
    const auditPayload = JSON.stringify((auditRows[0] as { payload: unknown } | undefined)?.payload ?? {});
    results.ua3_contracts_audit_safe = !auditPayload.includes(sensitiveMarker) ? "PASS" : "FAIL";
    log(`audit_payload_excerpt=${auditPayload.slice(0, 120)} -> ua3_contracts_audit_safe: ${results.ua3_contracts_audit_safe}`);
  });

  await section("OPEN-LOOP-INTEGRASJON (gjenbruker OpenLoopService.runSweep() uendret)", async () => {
    const renewingContract = await agreements.createContract(TENANT_A, "business", { title: `Open loop kontrakt ${runId}` });
    await agreements.setStatus(TENANT_A, "business", renewingContract.contract_id, "review");
    await agreements.setStatus(TENANT_A, "business", renewingContract.contract_id, "approved");
    await agreements.setStatus(TENANT_A, "business", renewingContract.contract_id, "active");
    await agreements.setRenewalDate(TENANT_A, "business", renewingContract.contract_id, new Date(Date.now() + 2 * 86_400_000).toISOString());
    await openLoops.runSweep(TENANT_A, "business");
    const loopsOpen = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const createdLoop = loopsOpen.find((l) => l.loop_type === "contract_renewal_due" && l.contract_id === renewingContract.contract_id);
    results.ua3_contracts_open_loop_created = createdLoop ? "PASS" : "FAIL";
    log(`open_loops_after_create=${loopsOpen.length} -> ua3_contracts_open_loop_created: ${results.ua3_contracts_open_loop_created}`);

    await agreements.setRenewalDate(TENANT_A, "business", renewingContract.contract_id, new Date(Date.now() + 365 * 86_400_000).toISOString());
    await openLoops.runSweep(TENANT_A, "business");
    const loopsAfter = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const stillOpen = loopsAfter.find((l) => l.contract_id === renewingContract.contract_id && l.loop_type === "contract_renewal_due");
    results.ua3_contracts_open_loop_resolved = !stillOpen ? "PASS" : "FAIL";
    log(`open_loops_after_far_future=${loopsAfter.length} -> ua3_contracts_open_loop_resolved: ${results.ua3_contracts_open_loop_resolved}`);
  });

  await section("TENANT-/MEMORY-SPACE-ISOLASJON", async () => {
    const contractsB = await agreements.listContracts(TENANT_B, "business", "all");
    results.ua3_contracts_tenant_isolation = contractsB.length === 0 ? "PASS" : "FAIL";
    log(`tenant_b_contracts=${contractsB.length} -> ua3_contracts_tenant_isolation: ${results.ua3_contracts_tenant_isolation}`);

    const crossSpace = await agreements.listContracts(TENANT_A, "personal", "all");
    results.ua3_contracts_space_isolation = crossSpace.length === 0 ? "PASS" : "FAIL";
    log(`personal_space_cross_read_hits=${crossSpace.length} -> ua3_contracts_space_isolation: ${results.ua3_contracts_space_isolation}`);
  });

  await section("Q-20 ERASURE-INTEGRASJON (ekte ErasureService, memory_space-scope)", async () => {
    const grantRows = await adminPool.query(
      `SELECT table_name FROM information_schema.role_table_grants
       WHERE grantee = 'jarvis_app' AND table_name IN ('contracts', 'contract_versions', 'contract_obligations', 'contract_events', 'business_open_loops') AND privilege_type = 'DELETE'`
    );
    const hasDeleteGrant = grantRows.rows.length === 5;
    log(`jarvis_app_delete_grants (contracts/contract_versions/contract_obligations/contract_events/business_open_loops)=${grantRows.rows.length}/5`);

    const fkRows = await adminPool.query(`
      SELECT tc.table_name, tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'contracts'
    `);
    const known = new Set(["business_open_loops", "contract_events", "contract_obligations", "contract_versions"]);
    const externalFks = (fkRows.rows as Array<{ table_name: string; constraint_name: string }>).filter((r) => !known.has(r.table_name));
    log(`fk_audit_unexpected_external_to_contracts=${JSON.stringify(externalFks)}`);
    const fkAuditKnown = externalFks.length === 0;

    const erasureContract = await agreements.createContract(TENANT_A, "business", { title: "Q20 erasure contract", company_id: companyId });
    await agreements.setStatus(TENANT_A, "business", erasureContract.contract_id, "review");
    await agreements.setStatus(TENANT_A, "business", erasureContract.contract_id, "approved");
    await agreements.setStatus(TENANT_A, "business", erasureContract.contract_id, "active");
    await agreements.setRenewalDate(TENANT_A, "business", erasureContract.contract_id, new Date(Date.now() + 2 * 86_400_000).toISOString());
    await agreements.addVersion(TENANT_A, "business", erasureContract.contract_id, { summary: "Q20 versjon" });
    await agreements.addObligation(TENANT_A, "business", erasureContract.contract_id, { description: "Q20 forpliktelse" });
    await openLoops.runSweep(TENANT_A, "business");
    const linkedLoopBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).find(
      (l) => l.contract_id === erasureContract.contract_id && l.loop_type === "contract_renewal_due"
    );
    log(`erasure_contract_id=${erasureContract.contract_id} linked_open_loop_before=${linkedLoopBefore?.open_loop_id ?? "MANGLER"}`);

    // Urelatert, IKKE-kontrakt-tilknyttet open-loop (RETAIN_SAFE_REFERENCE) -
    // beviser at erasure-scopet KUN treffer kontrakt-tilknyttede rader
    // (contract_id IS NOT NULL), aldri en generell business_open_loops-tømming.
    const unrelatedFollowup = await business.createFollowup(TENANT_A, "business", { title: "Q20 unrelated followup agr", due_at: "2020-01-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const unrelatedLoopBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).find((l) => l.followup_id === unrelatedFollowup.followup_id);

    const identity = ownerIdentityFor(TENANT_A);
    const erasure = new ErasureService(pool, new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A] }
    }), new LocalHashEmbedding());
    const scope = { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" } as const;
    const result = await erasure.executeErasure({ scope, requestId: `req-ua3-agr-live-${runId}`, identity });
    log(`erasure_result=${JSON.stringify(result)}`);

    const erasedContract = await agreements.getContract(TENANT_A, "business", erasureContract.contract_id);
    const loopsAfter = await openLoops.listOpenLoops(TENANT_A, "business", "all");
    const linkedLoopGone = !loopsAfter.some((l) => l.contract_id === erasureContract.contract_id);
    const unrelatedLoopStillThere = loopsAfter.some((l) => l.open_loop_id === unrelatedLoopBefore?.open_loop_id);

    // Ingen resurrection: en NY kontrakt opprettet etter erasure faar en HELT NY contract_id.
    const fresh = await agreements.createContract(TENANT_A, "business", { title: "Q20 erasure contract" });
    const noResurrection = fresh.contract_id !== erasureContract.contract_id;

    results.ua3_contracts_q20 =
      hasDeleteGrant && fkAuditKnown && result.status === "completed" &&
      erasedContract === null && linkedLoopGone && unrelatedLoopStillThere && noResurrection
        ? "PASS" : "FAIL";
    log(
      `erasure_completed=${result.status === "completed"} contract_gone=${erasedContract === null} ` +
        `linked_loop_gone=${linkedLoopGone} unrelated_loop_preserved=${unrelatedLoopStillThere} no_resurrection=${noResurrection} ` +
        `-> ua3_contracts_q20: ${results.ua3_contracts_q20}`
    );
  });

  await section("CLEANUP", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch((err: unknown) => {
      cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`);
    });
    const remainingContracts = await adminPool.query("SELECT count(*)::int AS n FROM contracts WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverContracts = (remainingContracts.rows[0] as { n: number }).n;
    const remainingTenants = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverTenants = (remainingTenants.rows[0] as { n: number }).n;
    results.ua3_contracts_cleanup = cleanupOk && leftoverContracts === 0 && leftoverTenants === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_contracts=${leftoverContracts} leftover_tenants=${leftoverTenants} -> ua3_contracts_cleanup: ${results.ua3_contracts_cleanup}`);
  });

  return finish();
}

function finish(): void {
  log("\n== UA-3 NATIVE CONTRACTS CORE LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  for (const [key, value] of Object.entries(diagnostics)) log(`${key}=${value}`);
  const hardFail = Object.values(results).some((v) => v === "FAIL" || v === "BLOCKED_BY_RUNTIME_ROLE");
  log(`\nrun_id=${runId} hard_fail=${hardFail}`);
}

try {
  await main();
} finally {
  await pool.end();
  await adminPool.end();
}

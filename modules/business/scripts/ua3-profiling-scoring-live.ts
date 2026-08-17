// UA-3 PROFILING/SCORING (D-61) - TRANSPARENT BUSINESS-OPERASJONELL
// PRIORITERING/RISIKO-SCORING HOST LIVE ACCEPTANCE - kjøres AV TOBIAS mot
// ekte lokal Postgres (docker-compose). Business-scoring har INGEN ekstern
// leverandør-credential (samme som resten av Business OS, se
// `BusinessInternalSecretProvider`) - denne akseptansen krever derfor
// IKKE ekte Gmail/Calendar-credentials, i motsetning til
// `ua3-business-events-live.ts`.
//
// Gjenbruker KUN eksisterende arkitektur (@jarvis/business, @jarvis/core,
// @jarvis/policy, @jarvis/tool-gateway) - ingen alternativ testimplementasjon.
// Speiler NØYAKTIG samme admin-pool-for-scaffold/runtime-pool-for-operasjoner-
// separasjon (D-50) og den EKSISTERENDE, gjenbrukte
// `findBlockingTenantDependencies()`-selvdiagnostikken (D-55) som
// `ua3-open-loops-live.ts`/`ua3-business-events-live.ts` - IKKE en ny kopi
// (§29 i byggeordren: "reuse all lessons D-50 through D-55").
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-profiling-scoring-live.ts
// (normalt via modules/business/scripts/ua3-profiling-scoring-host-run.ts,
// som bootstrapper workspacet/Docker/migrasjoner først)
//
// Bruker UTELUKKENDE syntetiske test-selskaper/kontakter/leads/opportunities
// i en isolert, kjøre-unik tenant (tenant-ua3-scoring-live-<run_id>-a/-b) -
// RØRER ALDRI ekte kunde-/forretningsdata, og profilerer/scorer ALDRI en
// ekte mailboks-kontakt eller ekte person (§27 i byggeordren). All
// test-scaffolding fjernes ved slutten.

import { randomUUID } from "node:crypto";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool, withTenantTransaction } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import {
  ALLOWED_LEAD_FACTOR_CODES, ALLOWED_OPPORTUNITY_FACTOR_CODES, BusinessInternalSecretProvider, BusinessService,
  BusinessTransport, OpenLoopService, ScoringService, assertNoProhibitedFactorCodes
} from "@jarvis/business";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "FAIL",
  ua3_scoring_runtime_role: "FAIL",
  ua3_scoring_lead: "FAIL",
  ua3_scoring_opportunity: "FAIL",
  ua3_scoring_explainable: "FAIL",
  ua3_scoring_source_backed: "FAIL",
  ua3_scoring_versioned: "FAIL",
  ua3_scoring_idempotent: "FAIL",
  ua3_scoring_protected_traits_blocked: "FAIL",
  ua3_scoring_high_impact_blocked: "FAIL",
  ua3_scoring_manual_override: "FAIL",
  ua3_scoring_override_audit: "FAIL",
  ua3_scoring_tenant_isolation: "FAIL",
  ua3_scoring_space_isolation: "FAIL",
  ua3_scoring_toolgateway: "FAIL",
  ua3_scoring_audit_safe: "FAIL",
  ua3_scoring_cleanup: "FAIL"
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
log(`UA-3 PROFILING/SCORING LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-ua3-scoring-live-${runId}-a`;
const TENANT_B = `tenant-ua3-scoring-live-${runId}-b`; // §tenant-isolasjon: annen tenant, skal forbli urørt
const OWNER_PERSON = `person-ua3-scoring-live-${runId}`;

function ownerIdentityFor(tenantId: string, memorySpace: MemorySpace = "business"): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: memorySpace,
    session_id: `sess-ua3-scoring-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

// SAMME selvdiagnostiske FK-sperre-mønster som ua3-open-loops-live.ts/ua3-business-events-live.ts
// (D-55/D-59) - IKKE en ny kopi av logikken. §29 i byggeordren krever eksplisitt gjenbruk av
// denne mekanismen for å unngå å oppdage nye FK-avhengigheter én blind host-runde av gangen.
function assertSafeIdentifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`ua3_scoring_cleanup_unsafe_identifier: "${name}"`);
  }
}

interface TenantFkBlocker {
  table: string;
  constraint: string;
  rows: number;
}

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
  // business_scores har INGEN FK til business_leads/business_opportunities (kun løs
  // entity_id-tekstreferanse, §12 i byggeordren) - ryddes likevel FØRST, samme
  // forsiktighets-rekkefølge som business_open_loops (D-53).
  await adminPool.query("DELETE FROM business_scores WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_followups WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_activities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_opportunities WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_leads WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_contacts WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_companies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);

  const blockers = await findBlockingTenantDependencies(tenantId);
  if (blockers.length > 0) {
    for (const b of blockers) {
      log(`blocking_fk_table=${b.table} blocking_fk_name=${b.constraint} rows_for_test_tenant=${b.rows}`);
    }
    throw new Error(`ua3_scoring_cleanup_blocked: ${blockers.length} uventet(e) FK-refererende tabell(er) har fortsatt rader for ${tenantId} - se blocking_fk_table-diagnostikk over`);
  }

  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-ua3-scoring-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) {
      await cleanupTenant(row.tenant_id).catch(() => undefined);
    }
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-ua3-scoring-live-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

function ownerPolicy(tenantIds: string[]): PolicyGateway {
  return new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER_PERSON, owner_tenants: tenantIds }
  });
}

async function main(): Promise<void> {
  // ===== §Q-21 RUNTIME ROLE =====
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    diagnostics["runtime_current_user"] = status.role;
    diagnostics["runtime_role_superuser"] = String(status.superuser);
    diagnostics["runtime_role_bypassrls"] = String(status.bypassrls);
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role}`);
  });
  if (!runtimeRoleSafe) {
    log("\nUA-3 PROFILING/SCORING KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen skriving forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  await selfHeal();
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `UA-3 Scoring Live A ${runId}`, TENANT_B, `UA-3 Scoring Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "UA-3 Scoring Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [OWNER_PERSON, TENANT_A, TENANT_B]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'personal'), ($5,$6,'business')",
    [`ms-ua3-scoring-a-business-${runId}`, TENANT_A, `ms-ua3-scoring-a-personal-${runId}`, TENANT_A, `ms-ua3-scoring-b-business-${runId}`, TENANT_B]
  );

  await section("SCORING RUNTIME-ROLLE (rett før faktiske operasjoner)", async () => {
    const { rows } = await pool.query("SELECT current_user AS role");
    const role = (rows[0] as { role: string }).role;
    diagnostics["scoring_runtime_role"] = role;
    results.ua3_scoring_runtime_role = role === diagnostics["runtime_current_user"] ? "PASS" : "FAIL";
    log(`scoring_runtime_role=${role} -> ua3_scoring_runtime_role: ${results.ua3_scoring_runtime_role}`);
  });

  const service = new BusinessService(pool);
  const openLoops = new OpenLoopService(pool);
  const scoring = new ScoringService(pool);
  // Business-scoring har INGEN ekstern leverandør-credential (JARVIS_BUSINESS_INTERNAL_TOKEN
  // resolves internt av BusinessInternalSecretProvider) - i motsetning til
  // sync_business_events trengs INGEN Gmail/Calendar-credential her.
  const gateway = new ToolGateway(pool, ownerPolicy([TENANT_A, TENANT_B]), new BusinessInternalSecretProvider());
  const businessTransport = new BusinessTransport(service, openLoops, pool, gateway, scoring);
  for (const tool of firstWaveTools({ business: businessTransport })) gateway.register(tool);

  let leadId = "";
  let opportunityId = "";
  let activityId = "";
  let followupId = "";
  await section("SCAFFOLD - SYNTETISK SELSKAP/KONTAKT/LEAD/OPPORTUNITY/AKTIVITET/OPPFOELGING", async () => {
    const company = await service.createCompany(TENANT_A, "business", { name: `Scoring Syntetisk AS ${runId}` });
    const contact = await service.createContact(TENANT_A, "business", { name: "Scoring Kontakt", email: `kontakt-${runId}@syntetisk.no`, company_id: company.company_id });
    const lead = await service.createLead(TENANT_A, "business", { title: `Scoring-lead ${runId}`, status: "qualified", company_id: company.company_id, contact_id: contact.contact_id });
    leadId = lead.lead_id;
    const opportunity = await service.createOpportunity(TENANT_A, "business", { title: `Scoring-opportunity ${runId}`, stage: "proposal", company_id: company.company_id, lead_id: leadId });
    opportunityId = opportunity.opportunity_id;
    const activity = await service.recordActivity(TENANT_A, "business", {
      activity_type: "email", summary: "Scoring syntetisk aktivitet", lead_id: leadId, company_id: company.company_id
    });
    activityId = activity.activity_id;
    const followup = await service.createFollowup(TENANT_A, "business", {
      title: "Scoring syntetisk oppfoelging", due_at: "2020-01-01T00:00:00Z", opportunity_id: opportunityId, company_id: company.company_id
    });
    followupId = followup.followup_id;
    // Gjenbruker EKSISTERENDE OpenLoopService uendret (§15 i byggeordren: open-loop-tilstand
    // er ETT transparent input i risiko-scoren, INGEN ny deteksjonsmekanisme oppfunnet).
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    log(`lead_id=${leadId} opportunity_id=${opportunityId} activity_id=${activityId} followup_id=${followupId}`);
  });

  await section("LEAD-SCORE (via ToolGateway.execute, ikke direkte service-kall)", async () => {
    const recalcResult = await gateway.execute({
      identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "recalculate_score",
      parameters: { tenant_id: TENANT_A, memory_space: "business", entity_type: "lead", entity_id: leadId }
    });
    results.ua3_scoring_toolgateway = recalcResult.ok ? "PASS" : "FAIL";
    log(`recalculate_score_via_toolgateway_ok=${recalcResult.ok} -> ua3_scoring_toolgateway: ${results.ua3_scoring_toolgateway}`);

    const scoreResult = await gateway.execute({
      identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "get_lead_score",
      parameters: { tenant_id: TENANT_A, memory_space: "business", lead_id: leadId }
    });
    const data = scoreResult.ok ? (scoreResult.data as {
      score: number; rule_version: string; factor_summary: Array<{ code: string; label: string }>;
      evidence: Array<{ type: string; id: string }>;
    }) : undefined;
    results.ua3_scoring_lead = scoreResult.ok && typeof data?.score === "number" && data.score >= 0 && data.score <= 100 ? "PASS" : "FAIL";
    diagnostics["lead_score"] = String(data?.score ?? "n/a");
    log(`lead_score=${diagnostics["lead_score"]} -> ua3_scoring_lead: ${results.ua3_scoring_lead}`);

    results.ua3_scoring_explainable = Array.isArray(data?.factor_summary) && data.factor_summary.length > 0 && data.factor_summary.every((f) => typeof f.code === "string" && typeof f.label === "string") ? "PASS" : "FAIL";
    log(`factor_count=${data?.factor_summary.length ?? 0} -> ua3_scoring_explainable: ${results.ua3_scoring_explainable}`);

    results.ua3_scoring_versioned = data?.rule_version === "lead_priority_v1" ? "PASS" : "FAIL";
    log(`rule_version=${data?.rule_version} -> ua3_scoring_versioned: ${results.ua3_scoring_versioned}`);

    // §16/§12 i byggeordren: evidence peker til EKTE, allerede-eksisterende entitets-ID-er
    // (aktivitet/oppfoelging) - aldri en fabrikkert referanse, aldri kopiert innhold.
    const evidenceIds = new Set((data?.evidence ?? []).map((e) => e.id));
    results.ua3_scoring_source_backed = evidenceIds.has(activityId) ? "PASS" : "FAIL";
    log(`evidence_ids=${JSON.stringify([...evidenceIds])} activity_id=${activityId} -> ua3_scoring_source_backed: ${results.ua3_scoring_source_backed}`);

    // §4/§11 i byggeordren: samtlige returnerte faktor-koder MÅ være en delmengde av den
    // dokumenterte, gjennomsiktige whitelisten - INGEN beskyttet/sensitiv persontrekk-kode.
    const codes = (data?.factor_summary ?? []).map((f) => f.code);
    let protectedTraitsBlocked = codes.length > 0 && codes.every((c) => (ALLOWED_LEAD_FACTOR_CODES as readonly string[]).includes(c));
    try {
      assertNoProhibitedFactorCodes(codes);
    } catch {
      protectedTraitsBlocked = false;
    }
    results.ua3_scoring_protected_traits_blocked = protectedTraitsBlocked ? "PASS" : "FAIL";
    log(`lead_factor_codes=${JSON.stringify(codes)} -> ua3_scoring_protected_traits_blocked: ${results.ua3_scoring_protected_traits_blocked}`);
  });

  await section("OPPORTUNITY-SCORE (verifiserer BEGGE score-typer, ikke bare lead)", async () => {
    await gateway.execute({
      identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "recalculate_score",
      parameters: { tenant_id: TENANT_A, memory_space: "business", entity_type: "opportunity", entity_id: opportunityId }
    });
    const scoreResult = await gateway.execute({
      identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "get_opportunity_score",
      parameters: { tenant_id: TENANT_A, memory_space: "business", opportunity_id: opportunityId }
    });
    const data = scoreResult.ok ? (scoreResult.data as { score: number; rule_version: string; factor_summary: Array<{ code: string }> }) : undefined;
    results.ua3_scoring_opportunity = scoreResult.ok && typeof data?.score === "number" ? "PASS" : "FAIL";
    diagnostics["opportunity_score"] = String(data?.score ?? "n/a");
    log(`opportunity_score=${diagnostics["opportunity_score"]} rule_version=${data?.rule_version} -> ua3_scoring_opportunity: ${results.ua3_scoring_opportunity}`);

    const codes = (data?.factor_summary ?? []).map((f) => f.code);
    const oppCodesOk = codes.length > 0 && codes.every((c) => (ALLOWED_OPPORTUNITY_FACTOR_CODES as readonly string[]).includes(c));
    log(`opportunity_factor_codes=${JSON.stringify(codes)} all_whitelisted=${oppCodesOk}`);

    // §10 i byggeordren: en score-rad har strukturelt INGEN felt/verdi som representerer en
    // autonomt utfoert hoy-konsekvens-personbeslutning - kun et prioriterings-tall + forklaring.
    const forbiddenFields = ["rejected", "denied", "terminated", "credit_decision", "employment_decision", "insurance_decision"];
    const dataKeys = Object.keys((scoreResult.ok ? scoreResult.data : {}) as Record<string, unknown>);
    results.ua3_scoring_high_impact_blocked = forbiddenFields.every((f) => !dataKeys.includes(f)) ? "PASS" : "FAIL";
    log(`score_row_keys=${JSON.stringify(dataKeys)} -> ua3_scoring_high_impact_blocked: ${results.ua3_scoring_high_impact_blocked}`);
  });

  await section("IDEMPOTENS - REKALKULERING FLERE GANGER GIR INGEN DUPLIKAT", async () => {
    await gateway.execute({
      identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "recalculate_score",
      parameters: { tenant_id: TENANT_A, memory_space: "business", entity_type: "lead", entity_id: leadId }
    });
    await gateway.execute({
      identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "recalculate_score",
      parameters: { tenant_id: TENANT_A, memory_space: "business", entity_type: "lead", entity_id: leadId }
    });
    // HOST FIX #1 (D-62, ekte host-funn run_id `22226237`): TIDLIGERE brukte denne spørringen
    // `withTenantTransaction()` (kun `jarvis.tenant_id`) - SAMME feilklasse som D-54/D-59, men en
    // NY konkret forekomst: `business_scores` har (i motsetning til `audit_events`, som D-59
    // fikset MED `withTenantTransaction`) en EKSTRA RESTRICTIVE memory-space-policy
    // (`022_business_scoring.sql`, samme mønster som `business_open_loops`) - uten
    // `jarvis.memory_spaces` satt evaluerer den til NULL og blokkerer strukturelt ALLE rader,
    // uansett faktisk databasetilstand. Fikset til `withMemoryTransaction()` - SAMME hjelper
    // `ScoringService` selv bruker for all lesing/skriving mot `business_scores`.
    const { rows } = await withMemoryTransaction(pool, TENANT_A, ["business"], (client) =>
      client.query("SELECT count(*)::int AS n FROM business_scores WHERE tenant_id = $1 AND entity_id = $2 AND score_type = 'lead_priority'", [TENANT_A, leadId])
    );
    // §7 i HOST FIX-ordren: eksplisitt navngitt som "score_rows_for_same_identity" - antall
    // rader for den fullstendige idempotens-identiteten (tenant_id, entity_type, entity_id,
    // score_type), IKKE et duplikat-tall - se test B i scoring-idempotency-rls.test.ts for hvorfor
    // rule_version bevisst IKKE er en del av denne identiteten (kun ÉN gjeldende score per
    // entitet, ikke en versjonshistorikk-tabell).
    const scoreRowsForSameIdentity = (rows[0] as { n: number }).n;
    results.ua3_scoring_idempotent = scoreRowsForSameIdentity === 1 ? "PASS" : "FAIL";
    log(`score_rows_for_same_identity=${scoreRowsForSameIdentity} idempotency_identity=tenant_id+entity_type=lead+entity_id+score_type=lead_priority -> ua3_scoring_idempotent: ${results.ua3_scoring_idempotent}`);
  });

  await section("MANUELL OVERSTYRING (eier-autorisert, endrer ALDRI underliggende faktorer)", async () => {
    const before = await gateway.execute({
      identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "get_lead_score",
      parameters: { tenant_id: TENANT_A, memory_space: "business", lead_id: leadId }
    });
    const beforeData = before.ok ? (before.data as { score: number; factor_summary: unknown[] }) : undefined;

    const sensitiveReason = "HEMMELIG-OVERSTYRINGS-BEGRUNNELSE-SCORING";
    const overrideResult = await gateway.execute({
      identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "set_manual_override",
      parameters: { tenant_id: TENANT_A, memory_space: "business", entity_type: "lead", entity_id: leadId, override_score: 88, reason: sensitiveReason }
    });
    const overrideData = overrideResult.ok ? (overrideResult.data as { manual_override: boolean; override_score: number; score: number; factor_summary: unknown[] }) : undefined;
    results.ua3_scoring_manual_override =
      overrideResult.ok && overrideData?.manual_override === true && overrideData.override_score === 88 &&
      overrideData.score === beforeData?.score && JSON.stringify(overrideData.factor_summary) === JSON.stringify(beforeData?.factor_summary)
        ? "PASS" : "FAIL";
    log(`override_ok=${overrideResult.ok} override_score=${overrideData?.override_score} underlying_score_unchanged=${overrideData?.score === beforeData?.score} -> ua3_scoring_manual_override: ${results.ua3_scoring_manual_override}`);

    // §20 i byggeordren: overstyring skal auditeres via SAMME eksisterende ToolGateway-audit-vei,
    // ALDRI en egen, parallell audit-mekanisme. Lærdom fra D-59: bruker withTenantTransaction,
    // aldri en RLS-blind raw pool.query() mot audit_events (FORCE ROW LEVEL SECURITY).
    const auditRows = await withTenantTransaction(pool, TENANT_A, (client) =>
      client.query(
        "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'set_manual_override' ORDER BY at DESC LIMIT 1",
        [TENANT_A]
      )
    );
    const auditRow = auditRows.rows[0] as { payload: unknown } | undefined;
    const auditFound = auditRow !== undefined;
    const auditPayload = JSON.stringify(auditRow?.payload ?? {});
    const auditSafeContent = !/authorization|access_token|refresh_token|client_secret/i.test(auditPayload) && !auditPayload.includes(sensitiveReason);
    results.ua3_scoring_override_audit = auditFound && auditPayload.includes("credential_ref") && auditSafeContent ? "PASS" : "FAIL";
    log(`override_audit_event_found=${auditFound} override_audit_payload_excerpt=${auditPayload.slice(0, 160)} -> ua3_scoring_override_audit: ${results.ua3_scoring_override_audit}`);

    results.ua3_scoring_audit_safe = results.ua3_scoring_override_audit === "PASS" ? "PASS" : "FAIL";

    await gateway.execute({
      identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "clear_manual_override",
      parameters: { tenant_id: TENANT_A, memory_space: "business", entity_type: "lead", entity_id: leadId }
    });
  });

  await section("TENANT-/MEMORY-SPACE-ISOLASJON", async () => {
    const crossTenant = await gateway.execute({
      identity: ownerIdentityFor(TENANT_B), tool_id: "business", action: "get_lead_score",
      parameters: { tenant_id: TENANT_B, memory_space: "business", lead_id: leadId }
    });
    const crossTenantData = crossTenant.ok ? crossTenant.data : "not-ok";
    results.ua3_scoring_tenant_isolation = crossTenant.ok && crossTenantData === null ? "PASS" : "FAIL";
    log(`tenant_b_sees_tenant_a_score=${JSON.stringify(crossTenantData)} -> ua3_scoring_tenant_isolation: ${results.ua3_scoring_tenant_isolation}`);

    const crossSpace = await gateway.execute({
      identity: ownerIdentityFor(TENANT_A, "personal"), tool_id: "business", action: "get_lead_score",
      parameters: { tenant_id: TENANT_A, memory_space: "personal", lead_id: leadId }
    });
    const crossSpaceData = crossSpace.ok ? crossSpace.data : "not-ok";
    results.ua3_scoring_space_isolation = crossSpace.ok && crossSpaceData === null ? "PASS" : "FAIL";
    log(`personal_space_sees_business_score=${JSON.stringify(crossSpaceData)} -> ua3_scoring_space_isolation: ${results.ua3_scoring_space_isolation}`);
  });

  await section("CLEANUP", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch((err: unknown) => { cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`); });

    const remainingScores = await adminPool.query("SELECT count(*)::int AS n FROM business_scores WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverScores = (remainingScores.rows[0] as { n: number }).n;
    const remainingTenants = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverTenants = (remainingTenants.rows[0] as { n: number }).n;
    results.ua3_scoring_cleanup = cleanupOk && leftoverScores === 0 && leftoverTenants === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_scores=${leftoverScores} leftover_tenants=${leftoverTenants} -> ua3_scoring_cleanup: ${results.ua3_scoring_cleanup}`);
  });

  return finish();
}

function finish(): void {
  log("\n== UA-3 PROFILING/SCORING LIVE ACCEPTANCE SUMMARY ==");
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

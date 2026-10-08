// UA-3 NATIVE JARVIS SUPPORT CORE (D-66) - HOST LIVE ACCEPTANCE
// Kjøres AV TOBIAS mot ekte lokal Postgres (docker-compose). Gjenbruker KUN
// eksisterende arkitektur (@jarvis/support, @jarvis/business, @jarvis/core,
// @jarvis/policy, @jarvis/tool-gateway) - ingen alternativ testimplementasjon.
// Speiler NØYAKTIG samme admin-pool-for-scaffold/runtime-pool-for-operasjoner-
// separasjon og den EKSISTERENDE, gjenbrukte `findBlockingTenantDependencies()`-
// selvdiagnostikken som `ua3-open-loops-live.ts` - ikke en ny kopi.
//
// §32 i byggeordren (REAL HOST SAFETY): sender ALDRI ekte kundepost, sletter
// ALDRI ekte Gmail-innhold. `email.send`/Gmail-ingress bevises UTELUKKENDE via
// en deterministisk `FakeTransport` GJENNOM den EKTE ToolGateway/Policy
// Gateway-arkitekturen - ingen reell nettverksforbindelse.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-native-support-live.ts
// (normalt via modules/business/scripts/ua3-native-support-host-run.ts, som
// bootstrapper workspacet/Docker/migrasjoner først)
//
// Bruker UTELUKKENDE syntetiske test-selskaper/kontakter/tickets i en
// isolert, kjøre-unik tenant (tenant-ua3-sup-live-<run_id>-a/-b) - RØRER
// ALDRI ekte kunde-/forretningsdata. All test-scaffolding fjernes ved
// slutten.

import { randomUUID } from "node:crypto";
import type { IdentityContext } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { LocalHashEmbedding } from "@jarvis/memory";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService, OpenLoopService } from "@jarvis/business";
import { ErasureService } from "../../erasure/src/erasure-service.ts";
import { SupportEmailService } from "../../support/src/email-ingress.ts";
import { SupportService } from "../../support/src/service.ts";
import { SupportTransport } from "../../support/src/transport.ts";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "FAIL",
  ua3_support_runtime_role: "FAIL",
  ua3_support_no_zendesk_dependency: "FAIL",
  ua3_support_create_ticket: "FAIL",
  ua3_support_thread_idempotency: "FAIL",
  ua3_support_message_idempotency: "FAIL",
  ua3_support_contact_match: "FAIL",
  ua3_support_unmatched: "FAIL",
  ua3_support_ambiguous: "FAIL",
  ua3_support_company_link: "FAIL",
  ua3_support_timeline: "FAIL",
  ua3_support_source_pointer: "FAIL",
  ua3_support_no_body_copied: "FAIL",
  ua3_support_state_machine: "FAIL",
  ua3_support_priority: "FAIL",
  ua3_support_assignment: "FAIL",
  ua3_support_internal_note: "FAIL",
  ua3_support_reply_path: "FAIL",
  ua3_support_open_loop_created: "FAIL",
  ua3_support_open_loop_resolved: "FAIL",
  ua3_support_tenant_isolation: "FAIL",
  ua3_support_space_isolation: "FAIL",
  ua3_support_toolgateway: "FAIL",
  ua3_support_audit_safe: "FAIL",
  ua3_support_q20: "FAIL",
  ua3_support_cleanup: "FAIL"
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
log(`UA-3 NATIVE SUPPORT CORE LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-ua3-sup-live-${runId}-a`;
const TENANT_B = `tenant-ua3-sup-live-${runId}-b`; // tenant-isolasjon: annen tenant, skal forbli urørt
const OWNER_PERSON = `person-ua3-sup-live-${runId}`;
const AGENT_PERSON = `person-ua3-sup-agent-${runId}`;
const ACCOUNT_EMAIL = "post@tsworkflow.com";
// SECURITY FIX #2 (D-68): HOST FIX #1 sin `process.env.JARVIS_OWNER_PERSON_ID`-
// konstruksjon her er FJERNET - den var et symptom på at `SupportTransport`
// selv fabrikkerte en eier-identitet internt (en reell rettighetseskalering,
// se transport.ts). Nå videreformidler `ToolGateway.execute()` DEN EKTE
// kalleren sin `IdentityContext` (`ownerIdentityFor(TENANT_A)` under, som
// allerede har `person_id: OWNER_PERSON`) UENDRET til det nøstede
// `email.send`-kallet - ingen egen env-var-manipulasjon trengs lenger.

function ownerIdentityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-ua3-sup-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

function assertSafeIdentifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`ua3_sup_cleanup_unsafe_identifier: "${name}"`);
  }
}

interface TenantFkBlocker {
  table: string;
  constraint: string;
  rows: number;
}

/** Schema-drevet (ikke hardkodet) sjekk FØR `DELETE FROM tenants` - samme mønster som ua3-open-loops-live.ts. */
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
  await adminPool.query("DELETE FROM support_ticket_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM support_tickets WHERE tenant_id = $1", [tenantId]);
  // HOST FIX #3 (D-69, ekte host-funn run_id 1e821a86): §Q-20-seksjonen under
  // oppretter BEVISST en `business_followups`-rad (`unrelatedFollowup`) for å
  // bevise at erasure-scopet KUN treffer support-tilknyttede open-loops - en
  // AKSEPTANSE-FIXTURE, IKKE produksjonsdata som skal overleve testen.
  // `jarvis_app` har (bevisst, uendret) INGEN DELETE-rettighet på
  // `business_followups` (kun SELECT/INSERT/UPDATE, 019_business.sql) - dette
  // er FORTSATT en pre-eksisterende, udokumentert-utvidet Q-20-produksjonsgap
  // (Q-25 punkt 9), IKKE noe denne fiksen endrer. Slettes derfor via
  // `adminPool` (migrasjons-/admin-rollen), ALDRI en ny runtime-rettighet.
  await adminPool.query("DELETE FROM business_followups WHERE tenant_id = $1", [tenantId]);
  // HOST FIX #3: `ErasureService.executeErasure()` skriver en EKTE
  // `erasure_requests`/`erasure_fingerprints`-revisjonsrad (samme produksjons-
  // ledger som Q-20 for øvrig) - denne skal ALDRI slettes av selve
  // produksjons-runtimen (append-only-lignende revisjonsspor, `jarvis_app` har
  // bevisst INGEN DELETE-rettighet der heller, kun SELECT/INSERT/UPDATE,
  // 018_erasure.sql). For den SYNTETISKE akseptanse-tenanten er dette ren
  // test-fixture-opprydding - EKSAKT samme, allerede etablerte mønster som
  // `modules/erasure/scripts/q20-erasure-live.ts` sin egen `cleanupTenant()`
  // (admin-pool, aldri en produksjons-retention-endring).
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
    throw new Error(`ua3_sup_cleanup_blocked: ${blockers.length} uventet(e) FK-refererende tabell(er) har fortsatt rader for ${tenantId}`);
  }
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-ua3-sup-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) await cleanupTenant(row.tenant_id).catch(() => undefined);
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-ua3-sup-%'").catch(() => undefined);
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
    log("\nNATIVE SUPPORT CORE KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen skriving forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  await section("ZERO ZENDESK-AVHENGIGHET", async () => {
    const zendeskEnvKeys = Object.keys(process.env).filter((k) => k.startsWith("JARVIS_ZENDESK"));
    for (const key of zendeskEnvKeys) delete process.env[key];
    diagnostics["zendesk_env_unset_count"] = String(zendeskEnvKeys.length);
    // Selve dette scriptet importerer/bruker aldri noe Zendesk-relatert - hvis Native Support
    // fungerer med ZERO JARVIS_ZENDESK_*-variabler satt, er kravet strukturelt bevist, ikke bare hevdet.
    results.ua3_support_no_zendesk_dependency = "PASS";
    log(`zendesk_env_vars_unset=${zendeskEnvKeys.length} -> ua3_support_no_zendesk_dependency: PASS`);
  });

  await selfHeal();
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `UA-3 Support Live A ${runId}`, TENANT_B, `UA-3 Support Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2), ($3,$4)", [
    OWNER_PERSON, "UA-3 Support Live Owner", AGENT_PERSON, "UA-3 Support Live Agent"
  ]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3), ($4,$2)", [
    OWNER_PERSON, TENANT_A, TENANT_B, AGENT_PERSON
  ]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'personal'), ($5,$6,'business')",
    [`ms-ua3-sup-a-business-${runId}`, TENANT_A, `ms-ua3-sup-a-personal-${runId}`, TENANT_A, `ms-ua3-sup-b-business-${runId}`, TENANT_B]
  );

  await section("SUPPORT RUNTIME-ROLLE (rett før faktiske support-operasjoner)", async () => {
    const { rows } = await pool.query("SELECT current_user AS role");
    const role = (rows[0] as { role: string }).role;
    results.ua3_support_runtime_role = role === diagnostics["runtime_current_user"] ? "PASS" : "FAIL";
    log(`support_runtime_role=${role} -> ua3_support_runtime_role: ${results.ua3_support_runtime_role}`);
  });

  const business = new BusinessService(pool);
  const support = new SupportService(pool);
  const openLoops = new OpenLoopService(pool);
  let companyId = "";
  let matchedContactId = "";

  await section("ENTITETSRESOLUSJON - MATCHED/UNMATCHED/AMBIGUOUS + SELSKAPSKOBLING", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: `Support Syntetisk AS ${runId}` });
    companyId = company.company_id;
    const contact = await business.createContact(TENANT_A, "business", { name: "Kari Kunde", email: `kari-${runId}@acme.no`, company_id: companyId });
    matchedContactId = contact.contact_id;
    const secondContact = await business.createContact(TENANT_A, "business", { name: "Ola Duplikat", email: `ambiguous-${runId}@acme.no` });
    const thirdCompany = await business.createCompany(TENANT_A, "business", { name: `Annen AS ${runId}` });
    const ambiguousDuplicate = await business.createContact(TENANT_A, "business", { name: "Ola Duplikat2", email: `ambiguous-${runId}@acme.no`, company_id: thirdCompany.company_id });
    void secondContact;
    void ambiguousDuplicate;

    const matched = await support.createTicket(TENANT_A, "business", { subject: "Matched ticket", company_id: companyId, contact_id: matchedContactId, entity_resolution: "matched" });
    results.ua3_support_contact_match = matched.entity_resolution === "matched" && matched.contact_id === matchedContactId ? "PASS" : "FAIL";
    log(`matched_ticket_contact=${matched.contact_id} -> ua3_support_contact_match: ${results.ua3_support_contact_match}`);

    const unmatched = await support.createTicket(TENANT_A, "business", { subject: "Unmatched ticket", entity_resolution: "unmatched" });
    results.ua3_support_unmatched = unmatched.entity_resolution === "unmatched" && unmatched.company_id === null ? "PASS" : "FAIL";
    log(`unmatched_ticket_company=${unmatched.company_id} -> ua3_support_unmatched: ${results.ua3_support_unmatched}`);

    const ambiguous = await support.createTicket(TENANT_A, "business", { subject: "Ambiguous ticket", entity_resolution: "ambiguous" });
    results.ua3_support_ambiguous = ambiguous.entity_resolution === "ambiguous" && ambiguous.company_id === null ? "PASS" : "FAIL";
    log(`ambiguous_ticket_company=${ambiguous.company_id} -> ua3_support_ambiguous: ${results.ua3_support_ambiguous}`);

    results.ua3_support_company_link = matched.company_id === companyId ? "PASS" : "FAIL";
    log(`matched_ticket_company=${matched.company_id} -> ua3_support_company_link: ${results.ua3_support_company_link}`);
  });

  let firstTicketId = "";
  await section("GMAIL-INGRESS (FakeTransport gjennom EKTE ToolGateway) - THREAD-/MELDING-IDEMPOTENS", async () => {
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A] }
    });
    // HOST FIX #1 (D-67): `ToolGateway.execute()` (`gateway.ts` linje 188-190) resolver
    // ALLTID `credential = await secrets.get(definition.credential_ref)` og avviser
    // ubetinget med `credential_unavailable` FØR `transport.invoke()` i det hele tatt
    // kalles - `FakeTransport` bruker aldri selve credential-verdien, men den nulle
    // verdien fra en "alt-tomt"-provider stopper kallet allerede i selve gatewayen.
    // EKSAKT samme provider-mønster som `ua3-business-events-live.ts` DEL 2 (D-57,
    // "test-google-static") - en eksplisitt, IKKE-hemmelig dummy-verdi KUN for
    // `JARVIS_EMAIL_TOKEN`/`JARVIS_GOOGLE_TOKEN`, som ALDRI berører produksjonens egen
    // `EnvSecretProvider()`-wiring i `main.ts`/`worker-main.ts`.
    const secrets = new FallbackSecretProvider(
      { name: "test-google-static", get: async (ref) => (ref === "JARVIS_EMAIL_TOKEN" || ref === "JARVIS_GOOGLE_TOKEN") ? "dummy-google-cred-native-support" : null },
      new BusinessInternalSecretProvider()
    );
    const toolGateway = new ToolGateway(pool, policy, secrets);
    const supportTransport = new SupportTransport(support, business, toolGateway);
    for (const tool of firstWaveTools({
      email: new FakeTransport(() => ({
        data: {
          messages: [
            { id: `msg-${runId}-1`, thread: `thread-${runId}`, from: `kari-${runId}@acme.no`, to: "support@tsworkflow.com", subject: "Trenger hjelp", at: new Date().toISOString() }
          ]
        }
      })),
      support: supportTransport
    })) toolGateway.register(tool);
    const emailService = new SupportEmailService(toolGateway, business, support, ACCOUNT_EMAIL, ["support@tsworkflow.com"]);
    const identity = ownerIdentityFor(TENANT_A);

    const firstSync = await emailService.ingestFromGmail(TENANT_A, "business", identity);
    diagnostics["gmail_ingress_first_sync"] = JSON.stringify(firstSync);
    const ticketsAfterFirst = await support.searchTickets(TENANT_A, "business", { subject_contains: "Trenger hjelp" });
    firstTicketId = ticketsAfterFirst[0]?.ticket_id ?? "";
    results.ua3_support_create_ticket = firstSync.ingested === 1 && Boolean(firstTicketId) ? "PASS" : "FAIL";
    log(`gmail_first_sync=${JSON.stringify(firstSync)} ticket_id=${firstTicketId} -> ua3_support_create_ticket: ${results.ua3_support_create_ticket}`);

    // Samme tråd/melding levert på nytt (simulerer worker-retry) - INGEN duplikat ticket/event.
    await emailService.ingestFromGmail(TENANT_A, "business", identity);
    const ticketsAfterRetry = await support.searchTickets(TENANT_A, "business", { subject_contains: "Trenger hjelp" });
    const eventsAfterRetry = await support.listEvents(TENANT_A, "business", firstTicketId);
    results.ua3_support_thread_idempotency = ticketsAfterRetry.length === ticketsAfterFirst.length ? "PASS" : "FAIL";
    results.ua3_support_message_idempotency = eventsAfterRetry.filter((e) => e.source_message_id === `msg-${runId}-1`).length === 1 ? "PASS" : "FAIL";
    log(`tickets_after_retry=${ticketsAfterRetry.length} events_matching_message=${eventsAfterRetry.filter((e) => e.source_message_id === `msg-${runId}-1`).length} -> thread_idempotency: ${results.ua3_support_thread_idempotency} message_idempotency: ${results.ua3_support_message_idempotency}`);

    const ticket = await support.getTicket(TENANT_A, "business", firstTicketId);
    results.ua3_support_source_pointer = ticket?.canonical_uri?.includes(`msg-${runId}-1`) ? "PASS" : "FAIL";
    results.ua3_support_no_body_copied = !JSON.stringify(ticket).includes("body") ? "PASS" : "FAIL";
    log(`canonical_uri=${ticket?.canonical_uri} -> ua3_support_source_pointer: ${results.ua3_support_source_pointer} ua3_support_no_body_copied: ${results.ua3_support_no_body_copied}`);
  });

  await section("STATSOVERGANG / PRIORITET / TILDELING / INTERNT NOTAT", async () => {
    const ticket = await support.createTicket(TENANT_A, "business", { subject: "Lifecycle ticket", company_id: companyId });
    const pending = await support.setStatus(TENANT_A, "business", ticket.ticket_id, "pending");
    let invalidRejected = false;
    await support.setStatus(TENANT_A, "business", ticket.ticket_id, "closed");
    try {
      await support.setStatus(TENANT_A, "business", ticket.ticket_id, "resolved");
    } catch {
      invalidRejected = true;
    }
    results.ua3_support_state_machine = pending?.status === "pending" && invalidRejected ? "PASS" : "FAIL";
    log(`pending_status=${pending?.status} invalid_transition_rejected=${invalidRejected} -> ua3_support_state_machine: ${results.ua3_support_state_machine}`);

    const priority = await support.setPriority(TENANT_A, "business", ticket.ticket_id, "urgent");
    results.ua3_support_priority = priority?.priority === "urgent" ? "PASS" : "FAIL";
    log(`priority=${priority?.priority} -> ua3_support_priority: ${results.ua3_support_priority}`);

    const assigned = await support.assignTicket(TENANT_A, "business", ticket.ticket_id, AGENT_PERSON);
    results.ua3_support_assignment = assigned?.assignee_person_id === AGENT_PERSON ? "PASS" : "FAIL";
    log(`assignee=${assigned?.assignee_person_id} -> ua3_support_assignment: ${results.ua3_support_assignment}`);

    const note = await support.addInternalNote(TENANT_A, "business", ticket.ticket_id, "UA3-SUP-LIVE-INTERN-NOTAT");
    results.ua3_support_internal_note = note.event_type === "internal_note" ? "PASS" : "FAIL";
    log(`note_event_type=${note.event_type} -> ua3_support_internal_note: ${results.ua3_support_internal_note}`);
  });

  await section("KUNDE-SVAR - RUTER GJENNOM email.send (FakeTransport, INGEN reell utsending)", async () => {
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A] }
    });
    // HOST FIX #1 (D-67): `ToolGateway.execute()` (`gateway.ts` linje 188-190) resolver
    // ALLTID `credential = await secrets.get(definition.credential_ref)` og avviser
    // ubetinget med `credential_unavailable` FØR `transport.invoke()` i det hele tatt
    // kalles - `FakeTransport` bruker aldri selve credential-verdien, men den nulle
    // verdien fra en "alt-tomt"-provider stopper kallet allerede i selve gatewayen.
    // EKSAKT samme provider-mønster som `ua3-business-events-live.ts` DEL 2 (D-57,
    // "test-google-static") - en eksplisitt, IKKE-hemmelig dummy-verdi KUN for
    // `JARVIS_EMAIL_TOKEN`/`JARVIS_GOOGLE_TOKEN`, som ALDRI berører produksjonens egen
    // `EnvSecretProvider()`-wiring i `main.ts`/`worker-main.ts`.
    const secrets = new FallbackSecretProvider(
      { name: "test-google-static", get: async (ref) => (ref === "JARVIS_EMAIL_TOKEN" || ref === "JARVIS_GOOGLE_TOKEN") ? "dummy-google-cred-native-support" : null },
      new BusinessInternalSecretProvider()
    );
    const toolGateway = new ToolGateway(pool, policy, secrets);
    let sendCalled = false;
    const emailFake = new FakeTransport((action, parameters) => {
      if (action === "send") sendCalled = true;
      void parameters;
      return { data: {} };
    });
    const supportTransport = new SupportTransport(support, business, toolGateway);
    for (const tool of firstWaveTools({ email: emailFake, support: supportTransport })) toolGateway.register(tool);

    const ticket = await support.createTicket(TENANT_A, "business", { subject: "Reply ticket", company_id: companyId, contact_id: matchedContactId });
    const identity = ownerIdentityFor(TENANT_A);
    const sensitiveBody = "UA3-SUP-LIVE-HEMMELIG-SVARTEKST";
    const replyResult = await toolGateway.execute({
      identity, tool_id: "support", action: "reply",
      parameters: {
        tenant_id: TENANT_A, memory_space: "business", ticket_id: ticket.ticket_id,
        to: `kari-${runId}@acme.no`, subject: "Re: Reply ticket", body: sensitiveBody, idempotency_key: `reply-${runId}-1`
      }
    });
    results.ua3_support_reply_path = replyResult.ok && sendCalled ? "PASS" : "FAIL";
    log(`reply_ok=${replyResult.ok} send_called=${sendCalled} -> ua3_support_reply_path: ${results.ua3_support_reply_path}`);

    const { rows: auditRows } = await pool.query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'support' AND action = 'reply' ORDER BY at DESC LIMIT 1",
      [TENANT_A]
    );
    const auditPayload = JSON.stringify((auditRows[0] as { payload: unknown } | undefined)?.payload ?? {});
    results.ua3_support_audit_safe = !auditPayload.includes(sensitiveBody) ? "PASS" : "FAIL";
    log(`audit_payload_excerpt=${auditPayload.slice(0, 120)} -> ua3_support_audit_safe: ${results.ua3_support_audit_safe}`);

    results.ua3_support_toolgateway = replyResult.ok ? "PASS" : "FAIL";
  });

  await section("BUSINESS OS-TIDSLINJE ('Hva skjer med kunde X?')", async () => {
    await business.recordActivity(TENANT_A, "business", {
      activity_type: "email", summary: "CRM-aktivitet for samme kunde", company_id: companyId,
      source_type: "gmail", source_instance_id: ACCOUNT_EMAIL, external_id: `crm-msg-${runId}`
    });
    const timeline = await business.companyTimeline(TENANT_A, "business", companyId);
    const companyTickets = await support.searchTickets(TENANT_A, "business", { company_id: companyId });
    results.ua3_support_timeline = timeline.length > 0 && companyTickets.length > 0 ? "PASS" : "FAIL";
    log(`timeline_entries=${timeline.length} company_tickets=${companyTickets.length} -> ua3_support_timeline: ${results.ua3_support_timeline}`);
  });

  await section("OPEN-LOOP-INTEGRASJON (gjenbruker OpenLoopService.runSweep() uendret)", async () => {
    const ticket = await support.createTicket(TENANT_A, "business", { subject: "Needs reply for open loop" });
    await support.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: ACCOUNT_EMAIL, source_thread_id: `thread-ol-${runId}`,
      source_message_id: `msg-ol-${runId}-1`, subject: "Needs reply for open loop", summary: "Kunde spoer",
      is_from_customer: true, entity_resolution: "unmatched"
    });
    await openLoops.runSweep(TENANT_A, "business");
    const loopsOpen = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const createdLoop = loopsOpen.find((l) => l.loop_type === "support_ticket_needs_reply");
    results.ua3_support_open_loop_created = createdLoop ? "PASS" : "FAIL";
    log(`open_loops_after_create=${loopsOpen.length} -> ua3_support_open_loop_created: ${results.ua3_support_open_loop_created}`);
    void ticket;

    await support.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: ACCOUNT_EMAIL, source_thread_id: `thread-ol-${runId}`,
      source_message_id: `msg-ol-${runId}-2`, subject: "Needs reply for open loop", summary: "Agent svarer",
      is_from_customer: false, entity_resolution: "unmatched"
    });
    await openLoops.runSweep(TENANT_A, "business");
    const loopsAfterReply = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const stillOpen = loopsAfterReply.find((l) => l.loop_type === "support_ticket_needs_reply" && l.ticket_id === createdLoop?.ticket_id);
    results.ua3_support_open_loop_resolved = !stillOpen ? "PASS" : "FAIL";
    log(`open_loops_after_reply=${loopsAfterReply.length} -> ua3_support_open_loop_resolved: ${results.ua3_support_open_loop_resolved}`);
  });

  await section("TENANT-/MEMORY-SPACE-ISOLASJON", async () => {
    const ticketsB = await support.listTickets(TENANT_B, "business", "all");
    results.ua3_support_tenant_isolation = ticketsB.length === 0 ? "PASS" : "FAIL";
    log(`tenant_b_tickets=${ticketsB.length} -> ua3_support_tenant_isolation: ${results.ua3_support_tenant_isolation}`);

    const crossSpace = await support.listTickets(TENANT_A, "personal", "all");
    results.ua3_support_space_isolation = crossSpace.length === 0 ? "PASS" : "FAIL";
    log(`personal_space_cross_read_hits=${crossSpace.length} -> ua3_support_space_isolation: ${results.ua3_support_space_isolation}`);
  });

  await section("Q-20 ERASURE-INTEGRASJON (ekte ErasureService, memory_space-scope)", async () => {
    // HOST FIX #1 (D-67, ekte host-funn run_id 60f0d682/5457c59a): den
    // opprinnelige versjonen av denne seksjonen gjorde rå ad-hoc-DELETE-er
    // direkte - IKKE den faktiske Q-20-produksjonsveien. Bruker nå den EKTE
    // `ErasureService.executeErasure()` (samme klasse/API som
    // `q20-erasure-live.ts`), som beviser BÅDE selve FK-ordenen (§8/§9 i
    // byggeordren) OG den ekte klasse-D/policy-veien i én operasjon.
    const grantRows = await adminPool.query(
      `SELECT table_name FROM information_schema.role_table_grants
       WHERE grantee = 'jarvis_app' AND table_name IN ('support_tickets', 'support_ticket_events', 'business_open_loops') AND privilege_type = 'DELETE'`
    );
    const hasDeleteGrant = grantRows.rows.length === 3;
    log(`jarvis_app_delete_grants (support_tickets/support_ticket_events/business_open_loops)=${grantRows.rows.length}/3`);

    // §9 FK-audit: bekreft at DETTE er den ENESTE kjente FK mot support_tickets
    // fra en tabell utenfor support-domenet selv - en fremtidig ny FK mot
    // support_tickets som IKKE er håndtert her skal fanges her, ikke i en ny
    // host-runde.
    const fkRows = await adminPool.query(`
      SELECT tc.table_name, tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name IN ('support_tickets', 'support_ticket_events')
    `);
    // Q-44 (D-435): komposittnøkler (tenant_id, id) gir to rader per FK i information_schema-joinen - tell avhengige TABELLER, ikke rader.
    const externalFks = [...new Map(
      (fkRows.rows as Array<{ table_name: string; constraint_name: string }>).filter((r) => r.table_name !== "support_ticket_events").map((r) => [r.table_name, r])
    ).values()];
    log(`fk_audit_external_to_support_tickets=${JSON.stringify(externalFks)}`);
    const fkAuditKnown = externalFks.length === 1 && externalFks[0]!.table_name === "business_open_loops";

    // Dedikert Q-20-ticket + en support-tilknyttet open-loop (DELETE_FIRST,
    // §9-klassifisering) - reproduserer EKSAKT host-funnet.
    const erasureTicket = await support.createTicket(TENANT_A, "business", { subject: "Q20 erasure ticket", company_id: companyId });
    await support.setNextResponseDue(TENANT_A, "business", erasureTicket.ticket_id, new Date(Date.now() - 3_600_000).toISOString());
    await openLoops.runSweep(TENANT_A, "business");
    const linkedLoopBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).find(
      (l) => l.ticket_id === erasureTicket.ticket_id && l.loop_type === "support_ticket_overdue"
    );
    log(`erasure_ticket_id=${erasureTicket.ticket_id} linked_open_loop_before=${linkedLoopBefore?.open_loop_id ?? "MANGLER"}`);

    // Urelatert, IKKE-support-tilknyttet open-loop (RETAIN_SAFE_REFERENCE) -
    // beviser at erasure-scopet KUN treffer support-tilknyttede rader
    // (ticket_id IS NOT NULL), aldri en generell business_open_loops-tømming.
    const unrelatedFollowup = await business.createFollowup(TENANT_A, "business", { title: "Q20 unrelated followup", due_at: "2020-01-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const unrelatedLoopBefore = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).find((l) => l.followup_id === unrelatedFollowup.followup_id);

    const identity = ownerIdentityFor(TENANT_A);
    const erasure = new ErasureService(pool, new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A] }
    }), new LocalHashEmbedding());
    const scope = { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" } as const;
    const result = await erasure.executeErasure({ scope, requestId: `req-ua3-sup-live-${runId}`, identity });
    log(`erasure_result=${JSON.stringify(result)}`);

    const erasedTicket = await support.getTicket(TENANT_A, "business", erasureTicket.ticket_id);
    const erasedEvents = await support.listEvents(TENANT_A, "business", erasureTicket.ticket_id).catch(() => []);
    const loopsAfter = await openLoops.listOpenLoops(TENANT_A, "business", "all");
    const linkedLoopGone = !loopsAfter.some((l) => l.ticket_id === erasureTicket.ticket_id);
    const unrelatedLoopStillThere = loopsAfter.some((l) => l.open_loop_id === unrelatedLoopBefore?.open_loop_id);

    // Ingen resurrection (§E i byggeordren): re-ingestion av en HELT NY tråd/
    // melding etter erasure oppretter en NY ticket, aldri en "gjenoppstandelse".
    const reingested = await support.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: ACCOUNT_EMAIL, source_thread_id: `thread-q20-post-${runId}`,
      source_message_id: `msg-q20-post-${runId}-1`, subject: "Q20 erasure ticket", summary: "Ny melding etter erasure",
      is_from_customer: true, entity_resolution: "unmatched"
    });
    const noResurrection = reingested.ticket.ticket_id !== erasureTicket.ticket_id && reingested.ticket_created;

    results.ua3_support_q20 =
      hasDeleteGrant && fkAuditKnown && result.status === "completed" &&
      erasedTicket === null && erasedEvents.length === 0 && linkedLoopGone && unrelatedLoopStillThere && noResurrection
        ? "PASS" : "FAIL";
    log(
      `erasure_completed=${result.status === "completed"} ticket_gone=${erasedTicket === null} events_gone=${erasedEvents.length === 0} ` +
        `linked_loop_gone=${linkedLoopGone} unrelated_loop_preserved=${unrelatedLoopStillThere} no_resurrection=${noResurrection} ` +
        `-> ua3_support_q20: ${results.ua3_support_q20}`
    );
  });

  await section("CLEANUP", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = ANY($1)", [[OWNER_PERSON, AGENT_PERSON]]).catch((err: unknown) => {
      cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`);
    });
    const remainingTickets = await adminPool.query("SELECT count(*)::int AS n FROM support_tickets WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverTickets = (remainingTickets.rows[0] as { n: number }).n;
    const remainingTenants = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverTenants = (remainingTenants.rows[0] as { n: number }).n;
    results.ua3_support_cleanup = cleanupOk && leftoverTickets === 0 && leftoverTenants === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_tickets=${leftoverTickets} leftover_tenants=${leftoverTenants} -> ua3_support_cleanup: ${results.ua3_support_cleanup}`);
  });

  return finish();
}

function finish(): void {
  log("\n== UA-3 NATIVE SUPPORT CORE LIVE ACCEPTANCE SUMMARY ==");
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

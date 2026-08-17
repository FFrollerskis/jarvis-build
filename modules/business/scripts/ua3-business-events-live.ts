// UA-3 BUSINESS-EVENT-LINKAGE (D-57) - GMAIL/CALENDAR -> BUSINESS OS
// HOST LIVE ACCEPTANCE - kjøres AV TOBIAS mot ekte lokal Postgres (docker-compose)
// OG (for reachability-seksjonen) ekte konfigurerte Gmail/Calendar-credentials
// (SAMME JARVIS_EMAIL_TOKEN/JARVIS_GOOGLE_TOKEN som allerede kreves av
// api/worker sin normale runtime-wiring, se D-43/D-45/D-47).
//
// Gjenbruker KUN eksisterende arkitektur (@jarvis/business, @jarvis/core,
// @jarvis/policy, @jarvis/tool-gateway) - ingen alternativ testimplementasjon.
// Speiler NØYAKTIG samme admin-pool-for-scaffold/runtime-pool-for-operasjoner-
// separasjon (D-50/HOST FIX #1) og den EKSISTERENDE, gjenbrukte
// `findBlockingTenantDependencies()`-selvdiagnostikken (D-55/HOST FIX #2) som
// `ua3-open-loops-live.ts` - IKKE en ny kopi (§23 i byggeordren: "reuse
// lessons D-50 through D-55", ikke oppdag FK-avhengigheter én host-runde av
// gangen igjen).
//
// TO-DELT AKSEPTANSESTRATEGI (§8 i byggeordren - ærlig, ikke fabrikkert):
// (1) REACHABILITY: sync_business_events kjøres gjennom EKTE
//     GmailTransport/GoogleCalendarTransport (reelle Gmail/Calendar-API-kall,
//     reelle credentials) for en syntetisk tenant UTEN registrerte kontakter -
//     beviser at den NORMALE runtime-veien (ToolGateway -> ekte connector)
//     faktisk fungerer end-to-end (auth/parsing/ingen krasj), UTEN å anta at
//     en syntetisk test-e-post tilfeldigvis finnes i Tobias sin ekte innboks
//     (umulig å reprodusere deterministisk).
// (2) DETERMINISTISK ENTITETSGJENKJENNING: samme mønster som P0/D-53 sine
//     egne host-script - en SEPARAT ToolGateway-instans med `FakeTransport`
//     for email/calendar (fortsatt via ToolGateway.execute(), IKKE et
//     direkte service-snarvei-kall) beviser matchet/umatchet/tvetydig/
//     idempotens/tenant-isolasjon/kilde-peker-korrekthet reproduserbart.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-business-events-live.ts
// (normalt via modules/business/scripts/ua3-business-events-host-run.ts, som
// bootstrapper workspacet/Docker/migrasjoner først)
//
// Bruker UTELUKKENDE syntetiske test-selskaper/kontakter i en isolert,
// kjøre-unik tenant (tenant-ua3-be-live-<run_id>-a/-b) - RØRER ALDRI ekte
// kunde-/forretningsdata. All test-scaffolding fjernes ved slutten.

import { randomUUID } from "node:crypto";
import type { IdentityContext } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  EnvSecretProvider, FakeTransport, FallbackSecretProvider, GmailTransport, GoogleCalendarTransport, ToolGateway, firstWaveTools
} from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService } from "@jarvis/business";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "FAIL",
  ua3_events_runtime_role: "FAIL",
  ua3_events_gmail_real_connector_reachable: "FAIL",
  ua3_events_calendar_real_connector_reachable: "FAIL",
  ua3_events_gmail_matched: "FAIL",
  ua3_events_gmail_unmatched: "FAIL",
  ua3_events_gmail_ambiguous: "FAIL",
  ua3_events_calendar_matched: "FAIL",
  ua3_events_idempotency: "FAIL",
  ua3_events_no_body_content_stored: "FAIL",
  ua3_events_tenant_isolation: "FAIL",
  ua3_events_space_isolation: "FAIL",
  ua3_events_open_loop_reevaluation: "FAIL",
  ua3_events_toolgateway_wiring: "FAIL",
  ua3_events_audit_safe: "FAIL",
  ua3_events_cleanup: "FAIL"
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
log(`UA-3 BUSINESS-EVENT-LINKAGE LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());
const ACCOUNT = process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com";

const TENANT_A = `tenant-ua3-be-live-${runId}-a`;
const TENANT_B = `tenant-ua3-be-live-${runId}-b`; // §tenant-isolasjon: annen tenant, skal forbli urørt
const OWNER_PERSON = `person-ua3-be-live-${runId}`;

function ownerIdentityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-ua3-be-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

// SAMME selvdiagnostiske FK-sperre-mønster som ua3-open-loops-live.ts (D-55/HOST FIX #2) - IKKE
// en ny kopi av logikken, kun tilpasset denne sliceens egne kjøre-unike tenant-prefiks. §23 i
// byggeordren krever eksplisitt gjenbruk av denne mekanismen for å unngå å oppdage nye
// FK-avhengigheter (f.eks. en fremtidig cost_events/brief_seen-lignende avhengighet fra
// sync_business_events selv) én blind host-runde av gangen.
function assertSafeIdentifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`ua3_be_cleanup_unsafe_identifier: "${name}"`);
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

// Kjent, allerede-dokumentert FK-avhengighet (D-54/D-55, uendret her): `get_business_brief`/
// open-loop-sveip skriver `cost_events`/`brief_seen` - denne sliceen kaller `runSweep()` (§J under)
// og treffer derfor SAMME avhengighet. Ryddes FØRST, samme rekkefølge-presedens.
async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM cost_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM brief_seen WHERE tenant_id = $1", [tenantId]);
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
    throw new Error(`ua3_be_cleanup_blocked: ${blockers.length} uventet(e) FK-refererende tabell(er) har fortsatt rader for ${tenantId} - se blocking_fk_table-diagnostikk over`);
  }

  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-ua3-be-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) {
      await cleanupTenant(row.tenant_id).catch(() => undefined);
    }
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-ua3-be-live-%'").catch(() => undefined);
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
    log("\nUA-3 BUSINESS-EVENT-LINKAGE KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen skriving forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  await selfHeal();
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `UA-3 BE Live A ${runId}`, TENANT_B, `UA-3 BE Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "UA-3 BE Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [OWNER_PERSON, TENANT_A, TENANT_B]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'personal'), ($5,$6,'business')",
    [`ms-ua3-be-a-business-${runId}`, TENANT_A, `ms-ua3-be-a-personal-${runId}`, TENANT_A, `ms-ua3-be-b-business-${runId}`, TENANT_B]
  );

  await section("BUSINESS-EVENTS RUNTIME-ROLLE (rett før faktiske operasjoner)", async () => {
    const { rows } = await pool.query("SELECT current_user AS role");
    const role = (rows[0] as { role: string }).role;
    diagnostics["events_runtime_role"] = role;
    results.ua3_events_runtime_role = role === diagnostics["runtime_current_user"] ? "PASS" : "FAIL";
    log(`events_runtime_role=${role} -> ua3_events_runtime_role: ${results.ua3_events_runtime_role}`);
  });

  const service = new BusinessService(pool);
  const openLoops = new OpenLoopService(pool);

  // ===== DEL 1: REACHABILITY - EKTE GmailTransport/GoogleCalendarTransport via EKTE ToolGateway =====
  await section("REAL CONNECTOR REACHABILITY (ekte Gmail/Calendar-API, syntetisk tenant uten kontakter)", async () => {
    const realGateway = new ToolGateway(
      pool, ownerPolicy([TENANT_A]),
      // HOST FIX #1 (D-58, ekte host-funn run_id `7c5a5289`): ROTÅRSAK - denne seksjonen
      // brukte TIDLIGERE en ALLTID-null "env-empty"-stub-secret-provider (feilaktig kopiert
      // fra vitest-enhetstestenes mønster, der email/calendar-credentials BEVISST aldri skal
      // resolve) i stedet for den EKTE `EnvSecretProvider()` som produksjonen selv bruker
      // (`main.ts`/`worker-main.ts`) - `JARVIS_EMAIL_TOKEN`/`JARVIS_GOOGLE_TOKEN` ble derfor
      // ALDRI lest fra `.env` her, uansett om de faktisk var konfigurert, og
      // `ToolGateway.execute()` sin ubetingede `credential = await secrets.get(ref); if
      // (!credential) return deny("credential_unavailable")`-sjekk (gateway.ts) feilet
      // følgelig for BEGGE `email`/`calendar`-kallene. Dette var en REN
      // akseptanse-harness-bug i DENNE seksjonen - `main.ts`/`worker-main.ts` har brukt
      // `new FallbackSecretProvider(new EnvSecretProvider(), new
      // BusinessInternalSecretProvider())` korrekt hele tiden (bekreftet ved
      // kildekode-inspeksjon), så produksjons-runtime var ALDRI påvirket.
      new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider())
    );
    for (const tool of firstWaveTools({
      email: new GmailTransport(ACCOUNT), calendar: new GoogleCalendarTransport(ACCOUNT),
      business: new BusinessTransport(service, openLoops, pool, realGateway)
    })) realGateway.register(tool);

    const result = await realGateway.execute({
      identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "sync_business_events",
      parameters: { tenant_id: TENANT_A, memory_space: "business" }
    });
    if (!result.ok) {
      // Selve sync_business_events-HANDLINGEN feilet helt (f.eks. open-loop-reevalueringen
      // kastet) - IKKE et per-provider-funn. Begge markører FAIL, sanert årsak (§9/§17: aldri
      // et rått credential/token - `result.reason` er allerede ToolGateway sin egen korte,
      // kontrollerte klassifiseringsstreng).
      results.ua3_events_gmail_real_connector_reachable = "FAIL";
      results.ua3_events_calendar_real_connector_reachable = "FAIL";
      log(`sync_ok=false reason=${(result as { reason: string }).reason} -> begge reachability-markører FAIL (hele handlingen feilet, ikke bare én provider)`);
      return;
    }
    // §9 i HOST FIX #1-ordren: Gmail og Calendar rapporteres UAVHENGIG - `syncTenant()`
    // fanger nå hver providers feil separat (se business-event-sync.ts), så ett providerutfall
    // skjuler ALDRI det andre.
    const data = result.data as { gmail?: { scanned: number; error?: string }; calendar?: { scanned: number; error?: string } };
    const gmailReachable = data.gmail !== undefined && data.gmail.error === undefined;
    const calendarReachable = data.calendar !== undefined && data.calendar.error === undefined;
    diagnostics["real_gmail_scanned"] = String(data.gmail?.scanned ?? "n/a");
    diagnostics["real_calendar_scanned"] = String(data.calendar?.scanned ?? "n/a");
    // "Reachable" = handlingen faktisk fullførte MOT ekte Gmail/Calendar (ingen credential/nettverks-
    // feil) - IKKE et krav om at en tilfeldig ekte e-post/hendelse matcher en syntetisk kontakt.
    results.ua3_events_gmail_real_connector_reachable = gmailReachable ? "PASS" : "FAIL";
    results.ua3_events_calendar_real_connector_reachable = calendarReachable ? "PASS" : "FAIL";
    log(`gmail_reachable=${gmailReachable} gmail_scanned=${diagnostics["real_gmail_scanned"]} gmail_failure_class=${data.gmail?.error ?? "none"} -> ua3_events_gmail_real_connector_reachable: ${results.ua3_events_gmail_real_connector_reachable}`);
    log(`calendar_reachable=${calendarReachable} calendar_scanned=${diagnostics["real_calendar_scanned"]} calendar_failure_class=${data.calendar?.error ?? "none"} -> ua3_events_calendar_real_connector_reachable: ${results.ua3_events_calendar_real_connector_reachable}`);
  });

  // ===== DEL 2: DETERMINISTISK ENTITETSGJENKJENNING - FakeTransport via SAMME ToolGateway.execute()-vei =====
  // §6 Layer B i byggeordren: denne seksjonen er BEVISST credential-UAVHENGIG -
  // `FakeTransport.invoke()` bruker aldri selve credential-verdien, men
  // `ToolGateway.execute()` krever likevel ubetinget en ikke-null verdi FØR
  // `transport.invoke()` kalles (samme sjekk som rammet DEL 1). En eksplisitt,
  // ikke-hemmelig dummy-verdi KUN for Gmail/Calendar-referansene (SAMME mønster
  // som `business-transport-wiring.test.ts` sin "test-google-static"-provider)
  // gjør denne seksjonen uavhengig av om ekte `.env`-credentials er konfigurert -
  // i motsetning til DEL 1 (som MÅ ha ekte credentials for faktisk å bevise noe).
  const fakeGateway = new ToolGateway(
    pool, ownerPolicy([TENANT_A, TENANT_B]),
    new FallbackSecretProvider(
      { name: "test-google-static", get: async (ref) => (ref === "JARVIS_EMAIL_TOKEN" || ref === "JARVIS_GOOGLE_TOKEN") ? "dummy-google-cred-del2" : null },
      new BusinessInternalSecretProvider()
    )
  );
  let emailFake = new FakeTransport(() => ({ data: { messages: [] } }));
  let calendarFake = new FakeTransport(() => ({ data: { events: [] } }));
  const businessTransport = new BusinessTransport(service, openLoops, pool, fakeGateway);
  for (const tool of firstWaveTools({ email: emailFake, calendar: calendarFake, business: businessTransport })) fakeGateway.register(tool);

  let companyId = "";
  let companyTwoId = "";
  await section("SCAFFOLD - SYNTETISKE SELSKAPER/KONTAKTER", async () => {
    const company = await service.createCompany(TENANT_A, "business", { name: `BE Syntetisk AS ${runId}` });
    companyId = company.company_id;
    await service.createContact(TENANT_A, "business", { name: "BE Kontakt Én", email: `kontakt1-${runId}@syntetisk.no`, company_id: companyId });
    const companyTwo = await service.createCompany(TENANT_A, "business", { name: `BE Syntetisk To ${runId}` });
    companyTwoId = companyTwo.company_id;
    await service.createContact(TENANT_A, "business", { name: "BE Kontakt To", email: `kontakt2-${runId}@syntetisk.no`, company_id: companyTwoId });
    log(`company_id=${companyId} company_two_id=${companyTwoId}`);
  });

  await section("GMAIL - MATCHET/UMATCHET/TVETYDIG (via ToolGateway.execute, ikke direkte service-kall)", async () => {
    // Kaller selve handlingen som er den faktiske runtime-veien (sync_business_events), ikke
    // email-verktøyet isolert - TRE separate fake-oppsett, ett per scenario, holder hvert funn
    // isolert og deterministisk (BusinessEventSyncService bruker sin egen faste "max"-standard,
    // ingen scenario-styring via parametere er meningsfullt her).
    async function runGmailScenario(scenario: "matched" | "unmatched" | "ambiguous"): Promise<{ recorded: number; unmatched: number; ambiguous: number }> {
      emailFake = new FakeTransport(() => {
        if (scenario === "unmatched") {
          return { data: { messages: [{ id: `msg-be-${scenario}-${runId}`, from: "ukjent@fremmed.no", to: ACCOUNT, subject: "Ukjent avsender", at: new Date().toISOString() }] } };
        }
        if (scenario === "ambiguous") {
          return { data: { messages: [{ id: `msg-be-${scenario}-${runId}`, from: `kontakt1-${runId}@syntetisk.no`, to: `${ACCOUNT}, kontakt2-${runId}@syntetisk.no`, subject: "Fellesmøte", at: new Date().toISOString() }] } };
        }
        return { data: { messages: [{ id: `msg-be-${scenario}-${runId}`, from: `kontakt1-${runId}@syntetisk.no`, to: ACCOUNT, subject: "BE syntetisk henvendelse", at: new Date().toISOString(), body_text: "HEMMELIG-KROPP-SKAL-ALDRI-LAGRES" }] } };
      });
      for (const tool of firstWaveTools({ email: emailFake, calendar: calendarFake, business: businessTransport })) fakeGateway.register(tool);
      const result = await fakeGateway.execute({
        identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "sync_business_events",
        parameters: { tenant_id: TENANT_A, memory_space: "business" }
      });
      const data = result.ok ? (result.data as { gmail?: { recorded: number; unmatched: number; ambiguous: number } }) : undefined;
      return { recorded: data?.gmail?.recorded ?? -1, unmatched: data?.gmail?.unmatched ?? -1, ambiguous: data?.gmail?.ambiguous ?? -1 };
    }

    const matchedStats = await runGmailScenario("matched");
    results.ua3_events_gmail_matched = matchedStats.recorded === 1 ? "PASS" : "FAIL";
    log(`matched_recorded=${matchedStats.recorded} -> ua3_events_gmail_matched: ${results.ua3_events_gmail_matched}`);

    const unmatchedStats = await runGmailScenario("unmatched");
    results.ua3_events_gmail_unmatched = unmatchedStats.unmatched === 1 && unmatchedStats.recorded === 0 ? "PASS" : "FAIL";
    log(`unmatched_unmatched=${unmatchedStats.unmatched} unmatched_recorded=${unmatchedStats.recorded} -> ua3_events_gmail_unmatched: ${results.ua3_events_gmail_unmatched}`);

    const ambiguousStats = await runGmailScenario("ambiguous");
    results.ua3_events_gmail_ambiguous = ambiguousStats.ambiguous === 1 && ambiguousStats.recorded === 0 ? "PASS" : "FAIL";
    log(`ambiguous_ambiguous=${ambiguousStats.ambiguous} ambiguous_recorded=${ambiguousStats.recorded} -> ua3_events_gmail_ambiguous: ${results.ua3_events_gmail_ambiguous}`);

    const timeline = await service.companyTimeline(TENANT_A, "business", companyId);
    const matchedActivity = timeline.find((t) => t.summary === "E-post: BE syntetisk henvendelse");
    results.ua3_events_no_body_content_stored = Boolean(matchedActivity) && !JSON.stringify(timeline).includes("HEMMELIG-KROPP-SKAL-ALDRI-LAGRES") ? "PASS" : "FAIL";
    log(`matched_activity_found=${Boolean(matchedActivity)} body_leaked=${JSON.stringify(timeline).includes("HEMMELIG")} -> ua3_events_no_body_content_stored: ${results.ua3_events_no_body_content_stored}`);
  });

  await section("CALENDAR - MATCHET DELTAKER (html_link som canonical_uri)", async () => {
    calendarFake = new FakeTransport(() => ({
      data: {
        events: [{
          id: `evt-be-${runId}`, title: "BE syntetisk møte", start: new Date().toISOString(),
          html_link: `https://calendar.google.com/event?eid=${runId}`, attendees: [`kontakt1-${runId}@syntetisk.no`, ACCOUNT]
        }]
      }
    }));
    for (const tool of firstWaveTools({ email: emailFake, calendar: calendarFake, business: businessTransport })) fakeGateway.register(tool);
    const result = await fakeGateway.execute({
      identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "sync_business_events",
      parameters: { tenant_id: TENANT_A, memory_space: "business" }
    });
    const data = result.ok ? (result.data as { calendar?: { recorded: number } }) : undefined;
    results.ua3_events_calendar_matched = data?.calendar?.recorded === 1 ? "PASS" : "FAIL";
    log(`calendar_recorded=${data?.calendar?.recorded} -> ua3_events_calendar_matched: ${results.ua3_events_calendar_matched}`);
  });

  await section("IDEMPOTENS - RE-SYNK AV SAMME GMAIL-MELDING GIR INGEN DUPLIKAT", async () => {
    emailFake = new FakeTransport(() => ({
      data: { messages: [{ id: `msg-be-idempotent-${runId}`, from: `kontakt1-${runId}@syntetisk.no`, to: ACCOUNT, subject: "BE idempotens-test", at: new Date().toISOString() }] }
    }));
    for (const tool of firstWaveTools({ email: emailFake, calendar: calendarFake, business: businessTransport })) fakeGateway.register(tool);
    await fakeGateway.execute({ identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "sync_business_events", parameters: { tenant_id: TENANT_A, memory_space: "business" } });
    await fakeGateway.execute({ identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "sync_business_events", parameters: { tenant_id: TENANT_A, memory_space: "business" } });
    const { rows } = await withMemoryTransaction(pool, TENANT_A, ["business"], (client) =>
      client.query("SELECT count(*)::int AS n FROM business_activities WHERE tenant_id = $1 AND source_type = 'gmail' AND external_id = $2", [TENANT_A, `msg-be-idempotent-${runId}`])
    );
    const duplicateCount = (rows[0] as { n: number }).n;
    results.ua3_events_idempotency = duplicateCount === 1 ? "PASS" : "FAIL";
    log(`duplicate_rows_for_same_message=${duplicateCount} -> ua3_events_idempotency: ${results.ua3_events_idempotency}`);
  });

  await section("TENANT-/MEMORY-SPACE-ISOLASJON", async () => {
    await service.createContact(TENANT_B, "business", { name: "Kun i B", email: `kun-i-b-${runId}@isolert.no` });
    emailFake = new FakeTransport(() => ({
      data: { messages: [{ id: `msg-be-isolation-${runId}`, from: `kun-i-b-${runId}@isolert.no`, to: ACCOUNT, subject: "Isolasjonstest", at: new Date().toISOString() }] }
    }));
    for (const tool of firstWaveTools({ email: emailFake, calendar: calendarFake, business: businessTransport })) fakeGateway.register(tool);
    const result = await fakeGateway.execute({
      identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "sync_business_events",
      parameters: { tenant_id: TENANT_A, memory_space: "business" }
    });
    const data = result.ok ? (result.data as { gmail?: { unmatched: number; recorded: number } }) : undefined;
    results.ua3_events_tenant_isolation = data?.gmail?.unmatched === 1 && data.gmail.recorded === 0 ? "PASS" : "FAIL";
    log(`tenant_a_sync_of_tenant_b_contact_unmatched=${data?.gmail?.unmatched} -> ua3_events_tenant_isolation: ${results.ua3_events_tenant_isolation}`);

    const crossSpaceResult = await fakeGateway.execute({
      identity: { ...ownerIdentityFor(TENANT_A), memory_space_id: "personal" }, tool_id: "business", action: "sync_business_events",
      parameters: { tenant_id: TENANT_A, memory_space: "personal" }
    });
    results.ua3_events_space_isolation = crossSpaceResult.ok ? "PASS" : "FAIL";
    log(`personal_space_sync_ok=${crossSpaceResult.ok} (personal space har ingen matchende kontakter - forventet 0 recorded, ingen krasj) -> ua3_events_space_isolation: ${results.ua3_events_space_isolation}`);
  });

  await section("OPEN-LOOP-REEVALUERING (gjenbruker EKSISTERENDE OpenLoopService uendret)", async () => {
    await service.createFollowup(TENANT_A, "business", { title: "BE forfalt for reeval-test", due_at: "2020-01-01T00:00:00Z", company_id: companyId });
    emailFake = new FakeTransport(() => ({ data: { messages: [] } }));
    calendarFake = new FakeTransport(() => ({ data: { events: [] } }));
    for (const tool of firstWaveTools({ email: emailFake, calendar: calendarFake, business: businessTransport })) fakeGateway.register(tool);
    const result = await fakeGateway.execute({
      identity: ownerIdentityFor(TENANT_A), tool_id: "business", action: "sync_business_events",
      parameters: { tenant_id: TENANT_A, memory_space: "business" }
    });
    results.ua3_events_toolgateway_wiring = result.ok ? "PASS" : "FAIL";
    log(`sync_business_events_via_toolgateway_ok=${result.ok} -> ua3_events_toolgateway_wiring: ${results.ua3_events_toolgateway_wiring}`);

    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    results.ua3_events_open_loop_reevaluation = loops.some((l) => l.loop_type === "overdue_followup" && l.company_id === companyId) ? "PASS" : "FAIL";
    log(`open_loops_after_sync=${loops.length} -> ua3_events_open_loop_reevaluation: ${results.ua3_events_open_loop_reevaluation}`);

    const { rows: auditRows } = await pool.query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'sync_business_events' ORDER BY at DESC LIMIT 1",
      [TENANT_A]
    );
    const auditPayload = JSON.stringify((auditRows[0] as { payload: unknown } | undefined)?.payload ?? {});
    results.ua3_events_audit_safe = auditPayload.includes("credential_ref") && !/subject|body_text|attendees|kontakt1|kontakt2/i.test(auditPayload) ? "PASS" : "FAIL";
    log(`audit_payload_excerpt=${auditPayload.slice(0, 160)} -> ua3_events_audit_safe: ${results.ua3_events_audit_safe}`);
  });

  await section("CLEANUP", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch((err: unknown) => { cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`); });

    const remainingActivities = await adminPool.query("SELECT count(*)::int AS n FROM business_activities WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverActivities = (remainingActivities.rows[0] as { n: number }).n;
    const remainingTenants = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverTenants = (remainingTenants.rows[0] as { n: number }).n;
    results.ua3_events_cleanup = cleanupOk && leftoverActivities === 0 && leftoverTenants === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_activities=${leftoverActivities} leftover_tenants=${leftoverTenants} -> ua3_events_cleanup: ${results.ua3_events_cleanup}`);
  });

  return finish();
}

function finish(): void {
  log("\n== UA-3 BUSINESS-EVENT-LINKAGE LIVE ACCEPTANCE SUMMARY ==");
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

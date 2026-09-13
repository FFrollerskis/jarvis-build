import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { allocateEmbeddedPostgresPort, createPool, runMigrations, withTenantTransaction } from "@jarvis/core";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessService, BusinessTransport, OpenLoopService } from "../src/index.ts";

/**
 * UA-3 business-event-linkage HOST FIX #2 (D-59, ekte host-funn run_id
 * `b969e9e7`): `ua3_events_audit_safe=FAIL` med `audit_payload_excerpt={}`
 * til tross for at ALLE andre funksjonelle markører (inkl. `ua3_events_
 * toolgateway_wiring=PASS`, som beviser at `sync_business_events` faktisk
 * fullførte via ToolGateway - OG ToolGateway skriver audit i SAMME
 * transaksjon som selve verktøykjøringen) - rotårsak var IKKE en manglende
 * audit-rad, men en RLS-BLIND verifikasjons-spørring (SAMME feilklasse som
 * D-54): `audit_events` har `FORCE ROW LEVEL SECURITY` med policyen
 * `USING (tenant_id = current_setting('jarvis.tenant_id', true))`
 * (`005_rls.sql`) - en raw `pool.query()` under den ekte NOSUPERUSER/
 * NOBYPASSRLS `jarvis_runtime`-rollen (Q-21) setter ALDRI denne
 * session-GUC-en, saa spørringen strukturelt ser 0 rader UANSETT faktisk
 * databasetilstand. Denne suiten beviser BEGGE sider mekanisk: (A) den
 * RAW spørringen faktisk feiler slik host-loggen viste, (B) DEN SAMME
 * spørringen WRAPPET i `withTenantTransaction()` finner raden korrekt -
 * pluss at eksistens og innholds-sikkerhet forblir TO DISTINKTE krav.
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let toolGateway: ToolGateway;

const TENANT = "tenant-biz-audit-rls";
const ACCOUNT = "post@tsworkflow.com";
const ownerIdentity: IdentityContext = {
  person_id: "person-tobias", tenant_id: TENANT, memory_space_id: "business",
  session_id: "sess-audit-rls", device_id: "dev-audit-rls", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-business-audit-rls-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_business_audit_rls_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_business_audit_rls_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Audit RLS Test','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-audit-rls-business','${TENANT}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_business_audit_rls_test", password: "pw2" });

  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT] }
  });
  toolGateway = new ToolGateway(appPool, policy, { name: "test-static", get: async () => "dummy-credential" });
  const service = new BusinessService(appPool);
  const openLoops = new OpenLoopService(appPool);
  const businessTransport = new BusinessTransport(service, openLoops, appPool, toolGateway);
  const emailFake = new FakeTransport(() => ({
    data: { messages: [{ id: "msg-audit-rls-1", from: "ukjent@fremmed.no", to: ACCOUNT, subject: "HEMMELIG-EMNE-SKAL-ALDRI-I-AUDIT", at: new Date().toISOString(), body_text: "HEMMELIG-KROPP-SKAL-ALDRI-I-AUDIT" }] }
  }));
  const calendarFake = new FakeTransport(() => ({ data: { events: [] } }));
  for (const tool of firstWaveTools({ email: emailFake, calendar: calendarFake, business: businessTransport })) toolGateway.register(tool);

  // Kjør EN ekte sync_business_events gjennom SAMME ToolGateway-vei som live-scriptet - dette
  // produserer BÅDE en ytre 'business'/'sync_business_events'-audit-rad OG nøstede
  // 'email'/'list_messages' + 'calendar'/'list_events'-audit-rader (§5 i byggeordren).
  const result = await toolGateway.execute({
    identity: ownerIdentity, tool_id: "business", action: "sync_business_events",
    parameters: { tenant_id: TENANT, memory_space: "business" }
  });
  expect(result.ok).toBe(true);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: RLS-BLIND raw pool.query() (SAMME bug-klasse som D-54) reproduserer EKSAKT host-funnet", () => {
  it("en raw appPool.query() mot audit_events under den ekte non-bypass rollen finner 0 rader, til tross for at raden BEVISLIG finnes (adminPool ser den)", async () => {
    const viaAdmin = await adminPool.query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'sync_business_events'",
      [TENANT]
    );
    expect(viaAdmin.rows.length).toBeGreaterThanOrEqual(1);

    const viaRawRuntimeQuery = await appPool.query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'sync_business_events'",
      [TENANT]
    );
    // Dette ER selve bug-mekanismen host-loggen viste (audit_payload_excerpt={}) - en RAW
    // spørring under jarvis_runtime finner strukturelt 0 rader, ikke fordi raden mangler.
    expect(viaRawRuntimeQuery.rows.length).toBe(0);
  });
});

describe("B: HOST FIX #2 - withTenantTransaction() finner raden korrekt (samme fiks-mønster som D-54)", () => {
  it("SAMME spørring wrappet i withTenantTransaction(appPool, TENANT, ...) finner den ekte audit-raden", async () => {
    const result = await withTenantTransaction(appPool, TENANT, (client) =>
      client.query(
        "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'sync_business_events' ORDER BY at DESC LIMIT 1",
        [TENANT]
      )
    );
    expect(result.rows.length).toBe(1);
    const payload = JSON.stringify((result.rows[0] as { payload: unknown }).payload);
    expect(payload).toContain("credential_ref");
  });
});

describe("C: eksistens og innholds-sikkerhet er TO DISTINKTE krav (§3/§9 i byggeordren)", () => {
  it("et tomt/manglende audit-funn (auditFound=false) skal ALDRI tolkes som 'trygt' - en manglende rad MÅ feile, ikke stille passere", async () => {
    const result = await withTenantTransaction(appPool, TENANT, (client) =>
      client.query(
        "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'action_som_aldri_har_eksistert'",
        [TENANT]
      )
    );
    const auditRow = result.rows[0] as { payload: unknown } | undefined;
    const auditFound = auditRow !== undefined;
    const auditPayload = JSON.stringify(auditRow?.payload ?? {});
    const auditSafeContent = !/subject|body_text|attendees/i.test(auditPayload);
    // Samme logikk som live-scriptet (D-59-fiksen) - auditFound MÅ inngå i selve PASS-betingelsen.
    const wouldPass = auditFound && auditPayload.includes("credential_ref") && auditSafeContent;
    expect(auditFound).toBe(false);
    expect(wouldPass).toBe(false);
  });
});

describe("D/G/H/I: den ekte audit-raden for sync_business_events inneholder ALDRI Gmail-innhold/tokens", () => {
  it("audit-payloaden for business/sync_business_events mangler emne/body/attendee-sentinelene OG inneholder credential_ref (referanse, ikke verdi)", async () => {
    const result = await withTenantTransaction(appPool, TENANT, (client) =>
      client.query(
        "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'sync_business_events' ORDER BY at DESC LIMIT 1",
        [TENANT]
      )
    );
    const payload = JSON.stringify((result.rows[0] as { payload: unknown }).payload);
    expect(payload).toContain("credential_ref");
    expect(payload).not.toMatch(/HEMMELIG-EMNE|HEMMELIG-KROPP|subject|body_text|attendees|authorization|access_token|refresh_token|client_secret/i);
  });
});

describe("J: nøstede email/calendar-audit-rader forveksles ALDRI med den ytre business-handlingen", () => {
  it("email/list_messages produserer SIN EGEN audit-rad, men den matcher ALDRI tool_id='business' AND action='sync_business_events'-spørringen", async () => {
    const emailRows = await withTenantTransaction(appPool, TENANT, (client) =>
      client.query("SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'email' AND action = 'list_messages'", [TENANT])
    );
    expect(emailRows.rows.length).toBeGreaterThanOrEqual(1);

    const businessRows = await withTenantTransaction(appPool, TENANT, (client) =>
      client.query("SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'sync_business_events'", [TENANT])
    );
    // Den ytre spørringen finner KUN den ytre handlingens rad(er), aldri email/calendar sine.
    for (const row of businessRows.rows as Array<{ payload: unknown }>) {
      const payload = JSON.stringify(row.payload);
      expect(payload).not.toContain("list_messages");
    }
  });
});

describe("K/L: Q-21 og real-connector-credential-fiksen (D-58) forblir uendret av denne rundens fiks", () => {
  it("appPool sin rolle er fortsatt jarvis_business_audit_rls_test (non-superuser, non-bypass) - ingen RLS-svekkelse innført for å fikse verifikasjonen", async () => {
    const { rows } = await adminPool.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'jarvis_business_audit_rls_test'"
    );
    const role = rows[0] as { rolsuper: boolean; rolbypassrls: boolean };
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });
});

describe("M: live-scriptet gjenbruker den EKSISTERENDE withTenantTransaction() fremfor en ny mekanisme", () => {
  it("ua3-business-events-live.ts importerer withTenantTransaction fra @jarvis/core og bruker den for audit-spørringen (ikke en duplisert RLS-kontekst-primitiv)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const source = await readFile(fileURLToPath(new URL("../scripts/ua3-business-events-live.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/import\s*\{[^}]*withTenantTransaction[^}]*\}\s*from\s*"@jarvis\/core"/s);
    const auditSectionIdx = source.indexOf("OPEN-LOOP-REEVALUERING");
    const auditSection = source.slice(auditSectionIdx);
    expect(auditSection).toContain("withTenantTransaction(pool, TENANT_A");
    expect(auditSection).not.toMatch(/await pool\.query\(\s*"SELECT payload FROM audit_events/);
  });
});

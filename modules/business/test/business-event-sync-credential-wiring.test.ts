import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { EnvSecretProvider, FakeTransport, FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessTransport } from "../src/index.ts";

/**
 * UA-3 business-event-linkage HOST FIX #1 (D-58, ekte host-funn run_id
 * `7c5a5289`): rotårsaken til `tool_failed:credential_unavailable` var at
 * `ua3-business-events-live.ts` sin REACHABILITY-seksjon brukte en
 * ALLTID-null "env-empty"-stub-secret-provider i stedet for den EKTE
 * `EnvSecretProvider()` produksjonen (`main.ts`/`worker-main.ts`) allerede
 * bruker korrekt. Dette er en REN akseptanse-harness-bug - denne
 * testsuiten beviser den PRESISE mekanismen (§20 A/B/C/D/E i
 * byggeordren) med ekte `EnvSecretProvider`-oppførsel mot `process.env`
 * OG en ekte `ToolGateway.execute()`-kjøring mot embedded Postgres (samme
 * mønster som `business-transport-wiring.test.ts`) - UTEN å kreve ekte
 * nettverkstilgang til Gmail/Calendar (`FakeTransport` staar inn for selve
 * providerkallet - kun credential-OPPLØSNINGEN er ekte).
 */
const EMAIL_REF = "JARVIS_EMAIL_TOKEN";
const CALENDAR_REF = "JARVIS_GOOGLE_TOKEN";
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const TENANT = "tenant-biz-cred-wiring";
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: TENANT, memory_space_id: "business",
  session_id: "sess-cred-wiring", device_id: "dev-cred-wiring", channel: "api", auth_strength: "active"
};

function ownerPolicy(): PolicyGateway {
  return new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT] }
  });
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-business-cred-wiring-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_business_cred_wiring_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_business_cred_wiring_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Cred Wiring Test','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-cred-wiring-business','${TENANT}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_business_cred_wiring_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

beforeEach(() => {
  delete process.env[EMAIL_REF];
  delete process.env[CALENDAR_REF];
});
afterEach(() => {
  delete process.env[EMAIL_REF];
  delete process.env[CALENDAR_REF];
});

describe("A/B: EnvSecretProvider løser KONFIGURERTE Gmail/Calendar-credentials gjennom SAMME gateway-graf som sync_business_events bruker", () => {
  it("Gmail-verktøyet (email.list_messages) kjører naar JARVIS_EMAIL_TOKEN er satt i process.env", async () => {
    process.env[EMAIL_REF] = "real-looking-email-secret-xyz";
    const emailFake = new FakeTransport(() => ({ data: { messages: [] } }));
    const gateway = new ToolGateway(appPool, ownerPolicy(), new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()));
    for (const tool of firstWaveTools({ email: emailFake })) gateway.register(tool);
    const result = await gateway.execute({ identity, tool_id: "email", action: "list_messages", parameters: { max: 5 } });
    expect(result.ok).toBe(true);
    expect(emailFake.calls).toHaveLength(1);
  });

  it("Calendar-verktøyet (calendar.list_events) kjører naar JARVIS_GOOGLE_TOKEN er satt i process.env", async () => {
    process.env[CALENDAR_REF] = "real-looking-calendar-secret-xyz";
    const calendarFake = new FakeTransport(() => ({ data: { events: [] } }));
    const gateway = new ToolGateway(appPool, ownerPolicy(), new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()));
    for (const tool of firstWaveTools({ calendar: calendarFake })) gateway.register(tool);
    const result = await gateway.execute({
      identity, tool_id: "calendar", action: "list_events",
      parameters: { from: new Date().toISOString(), to: new Date().toISOString() }
    });
    expect(result.ok).toBe(true);
    expect(calendarFake.calls).toHaveLength(1);
  });
});

describe("C: manglende credential gir SANERT credential_unavailable, aldri stille suksess", () => {
  it("email.list_messages feiler med credential_unavailable naar JARVIS_EMAIL_TOKEN mangler", async () => {
    const gateway = new ToolGateway(appPool, ownerPolicy(), new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()));
    for (const tool of firstWaveTools({ email: new FakeTransport(() => ({ data: { messages: [] } })) })) gateway.register(tool);
    const result = await gateway.execute({ identity, tool_id: "email", action: "list_messages", parameters: { max: 5 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("credential_unavailable");
  });

  it("calendar.list_events feiler med credential_unavailable naar JARVIS_GOOGLE_TOKEN mangler", async () => {
    const gateway = new ToolGateway(appPool, ownerPolicy(), new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()));
    for (const tool of firstWaveTools({ calendar: new FakeTransport(() => ({ data: { events: [] } })) })) gateway.register(tool);
    const result = await gateway.execute({
      identity, tool_id: "calendar", action: "list_events",
      parameters: { from: new Date().toISOString(), to: new Date().toISOString() }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("credential_unavailable");
  });
});

describe("D: credential-verdier lekker ALDRI i feilmeldinger/reason-felt", () => {
  it("en satt (dummy) credential-verdi dukker aldri opp i ToolGateway sitt reason-felt ved en providerfeil", async () => {
    process.env[EMAIL_REF] = "SUPER-SECRET-SHOULD-NEVER-LEAK-42";
    const failingEmail = new FakeTransport(undefined, "gmail_simulated_outage");
    const gateway = new ToolGateway(appPool, ownerPolicy(), new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()));
    for (const tool of firstWaveTools({ email: failingEmail })) gateway.register(tool);
    const result = await gateway.execute({ identity, tool_id: "email", action: "list_messages", parameters: { max: 5 } });
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SUPER-SECRET-SHOULD-NEVER-LEAK-42");
  });
});

describe("E: BusinessTransport bruker den INJISERTE ToolGateway-instansen - konstruerer ALDRI sin egen nestede/uavhengige gateway", () => {
  it("sync_business_events sin email/calendar-kall treffer SAMME FakeTransport-instanser som ble registrert på den injiserte gatewayen", async () => {
    process.env[EMAIL_REF] = "dummy";
    process.env[CALENDAR_REF] = "dummy";
    const emailFake = new FakeTransport(() => ({ data: { messages: [] } }));
    const calendarFake = new FakeTransport(() => ({ data: { events: [] } }));
    const gateway = new ToolGateway(appPool, ownerPolicy(), new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()));
    const { BusinessService, OpenLoopService } = await import("../src/index.ts");
    const businessTransport = new BusinessTransport(new BusinessService(appPool), new OpenLoopService(appPool), appPool, gateway);
    for (const tool of firstWaveTools({ email: emailFake, calendar: calendarFake })) gateway.register(tool);
    await businessTransport.invoke("sync_business_events", { tenant_id: TENANT, memory_space: "business" });
    expect(emailFake.calls.length).toBeGreaterThanOrEqual(1);
    expect(calendarFake.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("H: credential_ref for connector-verktøy er en FAST konstant, ALDRI tenant-avledet - ingen per-tenant credential-binding å bryte", () => {
  it("email/calendar sine ToolDefinition.credential_ref er identiske uansett hvilken tenant som kaller (ingen tenant-scoped credential-lagring finnes for disse verktøyene)", () => {
    const defs = firstWaveTools({});
    const emailDef = defs.find((d) => d.tool_id === "email" && d.action === "list_messages");
    const calendarDef = defs.find((d) => d.tool_id === "calendar" && d.action === "list_events");
    expect(emailDef?.credential_ref).toBe("JARVIS_EMAIL_TOKEN");
    expect(calendarDef?.credential_ref).toBe("JARVIS_GOOGLE_TOKEN");
    // Ingen "tenant_id"-substring i selve credential_ref - bekrefter at credential-oppløsning
    // er PER VERKTØY (global eierkonto), ikke per-tenant - en syntetisk akseptanse-tenant kan
    // derfor verken "faa" eller "mangle" en tenant-spesifikk credential som ikke finnes.
    expect(emailDef?.credential_ref).not.toMatch(/tenant/i);
    expect(calendarDef?.credential_ref).not.toMatch(/tenant/i);
  });
});

describe("regresjon: sanitizeSyncError() begrenser lengde og aldri kaster selv (defense in depth)", () => {
  it("en veldig lang feilmelding trunkeres til 120 tegn i syncTenant() sitt error-felt", async () => {
    const { BusinessEventSyncService } = await import("../src/business-event-sync.ts");
    const longMessage = "x".repeat(500);
    const failingGateway = {
      execute: vi.fn().mockResolvedValue({ ok: false, reason: longMessage })
    } as unknown as ToolGateway;
    const service = new BusinessEventSyncService(failingGateway, {} as never, { runSweep: vi.fn().mockResolvedValue(undefined) } as never);
    const result = await service.syncTenant(TENANT, "business", identity);
    expect(result.gmail.error?.length).toBeLessThanOrEqual(120);
    expect(result.calendar.error?.length).toBeLessThanOrEqual(120);
  });
});

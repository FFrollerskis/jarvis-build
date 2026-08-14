import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore, createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, MeshToolExecutor, ToolGateway, firstWaveTools, type SecretProvider } from "@jarvis/tool-gateway";

/**
 * D-30 FINAL HOST ACCEPTANCE HARDENING §5 (Q-18): host-live fant at
 * ToolGateway sin idempotens-dedupe (§21 i BO-11: "aldri dobbel side-effekt")
 * gjelder for ALLE tool_executions-rader, også A-klasse READS med
 * idempotent_external=true. Voice-sesjoner er langtlevende (session_id
 * gjenopptas på tvers av taleturer, jf. SessionService.resumeOrCreate) - et
 * gjentatt identisk kalenderspørsmål i samme sesjon får derfor SAMME
 * idempotency_key (sha256 av tenant+session+tool+args) som første kall.
 *
 * Denne testen beviser DETERMINISTISK (ingen live-avhengighet) at andre
 * gangs identisk lesekall returnerer `deduplicated:true` UTEN data - fordi
 * A-klasse read-verktøy ikke har preflight_action (before/after-evidens er
 * kun for C/D), så tool_executions har ingenting å levere tilbake.
 * MeshToolExecutor.execute() mapper dette til `output: null` til modellen.
 *
 * KONKLUSJON: JA, reprodusert. BLOKKERER "gjenta samme spørring i samme
 * voice-sesjon"-mønsteret (§18 i OPEN_QUESTIONS.md). Minste foreslåtte fix
 * (IKKE implementert her - utenfor denne oppgavens "ikke redesign
 * ToolGateway"-grense): hopp over tool_executions-dedupe for verktøy der
 * capability_class === "A" (rene lesninger har intet side-effekt å beskytte
 * mot duplisering - dedupe-formålet gjelder kun C/D-mutasjoner).
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias",
  tenant_id: "tenant-q18",
  memory_space_id: "personal",
  session_id: "sess-q18-voice",
  device_id: "jarvis-voice-live",
  channel: "voice",
  auth_strength: "active"
};

const testSecrets: SecretProvider = { name: "test", async get() { return "secret-never-leaks"; } };

/** Samme konstruksjon som ModelGateway.executeToolCall (model-gateway.ts) - beviser mot EKTE nøkkel-formel. */
function idempotencyKey(toolName: string, args: Record<string, unknown> = {}): string {
  return createHash("sha256")
    .update(`${identity.tenant_id}:${identity.session_id}:${toolName}:${JSON.stringify(args, Object.keys(args).sort())}`)
    .digest("hex")
    .slice(0, 32);
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-q18-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_q18 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_q18");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-q18','Q18-test','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-q18');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_q18", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("Q-18: ToolGateway-dedupe på A-klasse read i samme (voice-)session", () => {
  it("REPRODUSERT: andre identiske kalenderlesing i samme session gir deduplicated=true UTEN data", async () => {
    const devices = new InMemoryDeviceRegistry();
    const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
    const calendarTransport = new FakeTransport(() => ({
      data: { events: [{ id: `ev-${randomUUID().slice(0, 6)}`, title: "standup", start: "09:00" }] }
    }));
    const toolGateway = new ToolGateway(appPool, policy, testSecrets);
    for (const tool of firstWaveTools({ calendar: calendarTransport })) toolGateway.register(tool);
    const executor = new MeshToolExecutor(toolGateway, identity);

    const key = idempotencyKey("read_calendar_today");
    const params = { from: new Date().toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() };

    // Første kall i sesjonen: EKTE utførelse med data (nøyaktig BO-11-live-beviset).
    const first = await executor.execute(
      { tool_call_id: "call-1", tool_name: "read_calendar_today", arguments: params, provider: "openai", model: "gpt" },
      { tenant_id: identity.tenant_id, session_id: identity.session_id, idempotency_key: key }
    );
    expect(first.success).toBe(true);
    expect(first.output).not.toBeNull();
    expect(calendarTransport.calls.length).toBe(1);

    // Andre gangs IDENTISK spørsmål SAMME sesjon (f.eks. "hva står på kalenderen"
    // spurt på nytt et par turer senere, uten task_id) -> SAMME idempotency_key:
    const second = await executor.execute(
      { tool_call_id: "call-2", tool_name: "read_calendar_today", arguments: params, provider: "openai", model: "gpt" },
      { tenant_id: identity.tenant_id, session_id: identity.session_id, idempotency_key: key }
    );

    // REPRODUSERT: transporten ble IKKE kalt på nytt (ingen ekte kalenderoppslag)...
    expect(calendarTransport.calls.length).toBe(1);
    // ...og modellen får `success:true` men `output:null` - IKKE et tomt/feil
    // svar fra Policy (som ville vært korrekt DENY), men en STILLE tom suksess
    // som kan få modellen til å påstå "ingen avtaler" eller "ingen tilgang"
    // selv om kalenderen faktisk har innhold (§18-funnet):
    expect(second.success).toBe(true);
    expect(second.output).toBeNull();
  });

  it("KONTROLLBEVIS: nytt session_id (ny voice-sesjon) gir FRISK utførelse - Q-18 er session-scoped", async () => {
    const devices = new InMemoryDeviceRegistry();
    const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
    const calendarTransport = new FakeTransport(() => ({ data: { events: [{ id: "ev-x", title: "standup" }] } }));
    const toolGateway = new ToolGateway(appPool, policy, testSecrets);
    for (const tool of firstWaveTools({ calendar: calendarTransport })) toolGateway.register(tool);
    const params = { from: new Date().toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() };

    const sessionA: IdentityContext = { ...identity, session_id: "sess-q18-a" };
    const sessionB: IdentityContext = { ...identity, session_id: "sess-q18-b" };
    const keyA = createHash("sha256")
      .update(`${sessionA.tenant_id}:${sessionA.session_id}:read_calendar_today:${JSON.stringify(params, Object.keys(params).sort())}`)
      .digest("hex").slice(0, 32);
    const keyB = createHash("sha256")
      .update(`${sessionB.tenant_id}:${sessionB.session_id}:read_calendar_today:${JSON.stringify(params, Object.keys(params).sort())}`)
      .digest("hex").slice(0, 32);

    const a = await new MeshToolExecutor(toolGateway, sessionA).execute(
      { tool_call_id: "c1", tool_name: "read_calendar_today", arguments: params, provider: "openai", model: "gpt" },
      { tenant_id: sessionA.tenant_id, session_id: sessionA.session_id, idempotency_key: keyA }
    );
    const b = await new MeshToolExecutor(toolGateway, sessionB).execute(
      { tool_call_id: "c2", tool_name: "read_calendar_today", arguments: params, provider: "openai", model: "gpt" },
      { tenant_id: sessionB.tenant_id, session_id: sessionB.session_id, idempotency_key: keyB }
    );
    expect(a.success && a.output !== null).toBe(true);
    expect(b.success && b.output !== null).toBe(true);
    expect(calendarTransport.calls.length).toBe(2); // begge sesjoner fikk ekte utførelse
  });
});

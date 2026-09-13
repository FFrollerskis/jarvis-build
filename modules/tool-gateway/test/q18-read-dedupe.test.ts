import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { allocateEmbeddedPostgresPort, createPool, PgApprovalStore, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, MeshToolExecutor, ToolGateway, firstWaveTools, type SecretProvider } from "@jarvis/tool-gateway";

/**
 * D-30 HOST FAILURE FIX §5/§6 (Q-18): host-live fant `tools=[read_calendar_today,
 * read_calendar_today]` på ÉN kalenderturn, og en tidligere test reproduserte at
 * ToolGateway sin database-dedupe rammet A-klasse READS (andre identisk lesing i
 * samme langtlevende voice-session ga `output:null` i stedet for ferske data).
 *
 * FIKS (modules/tool-gateway/src/gateway.ts, `dedupeApplies = capability_class
 * !== "A"`): tool_executions-dedupe (database-/session-nivå, på tvers av
 * BRUKER-turer) gjelder nå KUN C/D-mutasjoner - A-klasse reads utfører alltid
 * friskt. Beskyttelse mot at MODELLEN ber om samme kall flere ganger i ÉN
 * samtaletur er UENDRET og ligger i ModelGateway.completeWithTools sin
 * in-memory `executed`-cache (modules/model-gateway/src/model-gateway.ts) -
 * denne testfilen beviser BEGGE nivåer eksplisitt adskilt:
 *
 *  A. SAMME modellrunde/samtaletur, samme semantiske kall → maks 1 faktisk
 *     ToolGateway-/transport-utførelse (in-memory cache, uendret av denne fiksen).
 *  B. NESTE brukertur, samme session, samme semantiske kall → utføres FRISKT
 *     (database-dedupe gjelder ikke lenger A-klasse - dette ER Q-18-fiksen).
 *  C. Write/mutation (C/D) database-dedupe → UENDRET (fortsatt aktiv).
 */
const PORT = allocateEmbeddedPostgresPort();
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
function idempotencyKey(sessionId: string, toolName: string, args: Record<string, unknown> = {}): string {
  return createHash("sha256")
    .update(`${identity.tenant_id}:${sessionId}:${toolName}:${JSON.stringify(args, Object.keys(args).sort())}`)
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

function makeGateway(calendarTransport: FakeTransport): ToolGateway {
  const devices = new InMemoryDeviceRegistry();
  // Sovereign owner-config (v4.0-semantikk, matcher produksjonswiring) - uten
  // dette krever klasse C/D et mandat/godkjenning (legacy SCOPED), som ikke er
  // det denne testen undersøker (kun dedupe-oppførsel).
  const policy = new PolicyGateway({
    devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch(),
    authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
  });
  const toolGateway = new ToolGateway(appPool, policy, testSecrets);
  for (const tool of firstWaveTools({ calendar: calendarTransport })) toolGateway.register(tool);
  return toolGateway;
}

const calendarParams = () => ({ from: new Date().toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() });

describe("Q-18 FIX: A-class read database-dedupe fjernet - fersk utførelse per brukertur", () => {
  it("B (fiks): andre identisk kalenderlesing i SAMME session, NY tur (nytt idempotency_key-kontekst) → utføres FRISKT, ikke null", async () => {
    const calendarTransport = new FakeTransport(() => ({
      data: { events: [{ id: `ev-${randomUUID().slice(0, 6)}`, title: "standup", start: "09:00" }] }
    }));
    const toolGateway = makeGateway(calendarTransport);
    const executor = new MeshToolExecutor(toolGateway, identity);
    const key = idempotencyKey(identity.session_id as string, "read_calendar_today");
    const params = calendarParams();

    // Tur 1 i sesjonen:
    const first = await executor.execute(
      { tool_call_id: "call-1", tool_name: "read_calendar_today", arguments: params, provider: "openai", model: "gpt" },
      { tenant_id: identity.tenant_id, session_id: identity.session_id, idempotency_key: key }
    );
    expect(first.success).toBe(true);
    expect(first.output).not.toBeNull();
    expect(calendarTransport.calls.length).toBe(1);

    // Tur 2 i SAMME sesjon, SAMME idempotency_key (som ville vært samme nøkkel
    // FØR fiksen - dette er nøyaktig Q-18-scenarioet):
    const second = await executor.execute(
      { tool_call_id: "call-2", tool_name: "read_calendar_today", arguments: params, provider: "openai", model: "gpt" },
      { tenant_id: identity.tenant_id, session_id: identity.session_id, idempotency_key: key }
    );

    // FIKS: transporten kalles PÅ NYTT - ferske data, ikke deduplicated/null:
    expect(calendarTransport.calls.length).toBe(2);
    expect(second.success).toBe(true);
    expect(second.output).not.toBeNull();
    expect(second.error_category).toBeUndefined();
  });

  it("C (regresjon, uendret): write/mutation (klasse C) database-dedupe er FORTSATT aktiv", async () => {
    const calendarTransport = new FakeTransport(() => ({ external_id: `evt-${randomUUID().slice(0, 6)}` }));
    const toolGateway = makeGateway(calendarTransport);
    const params = { title: "Møte", start: new Date().toISOString(), end: new Date(Date.now() + 3_600_000).toISOString() };
    const key = createHash("sha256")
      .update(`${identity.tenant_id}:${identity.session_id}:create_event:${JSON.stringify(params, Object.keys(params).sort())}`)
      .digest("hex").slice(0, 32);

    const first = await toolGateway.execute({
      identity, tool_id: "calendar", action: "create_event", parameters: params, idempotency_key: key
    });
    expect(first.ok).toBe(true);
    expect(calendarTransport.calls.length).toBe(1);

    // Andre gangs IDENTISK mutasjon med SAMME idempotency_key → MÅ fortsatt
    // deduplicere (aldri dobbel side-effekt - dette er hele poenget med §21/§19):
    const second = await toolGateway.execute({
      identity, tool_id: "calendar", action: "create_event", parameters: params, idempotency_key: key
    });
    expect(calendarTransport.calls.length).toBe(1); // UENDRET - ingen ny mutasjon
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.deduplicated).toBe(true);
    }
  });
});

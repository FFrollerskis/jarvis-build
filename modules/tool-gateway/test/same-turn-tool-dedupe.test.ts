import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { allocateEmbeddedPostgresPort, createPool, PgApprovalStore, runMigrations } from "@jarvis/core";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { ScriptedAdapter, type StreamEvent, type ToolCallRequest } from "@jarvis/provider-adapters";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, MeshToolExecutor, ToolGateway, firstWaveTools, meshToolDefinitions } from "@jarvis/tool-gateway";

/**
 * D-30 HOST FAILURE FIX §5/§7.A: host-live viste `tools=[read_calendar_today,
 * read_calendar_today]` for ÉN kalenderturn (model_ttft=16041ms - unormalt
 * høyt). Denne testen avgjør DEFINITIVT via ekte kjøring (ikke gjetting):
 *
 *  A. to SSE/tool_call_complete-events for ÉTT faktisk ToolGateway-kall, eller
 *  B. to faktiske ToolGateway/transport-utførelser.
 *
 * FUNN: (A). ModelGateway.completeWithTools sin in-memory `executed`-cache
 * (nøkkel: tenant+session+tool_name+sorterte-args) deduper ALLEREDE korrekt
 * INNEN én completeWithTools-kjøring (én brukertur) - uansett om modellen ber
 * om samme kall to ganger i SAMME runde eller i to ETTERFØLGENDE runder. Den
 * ekstra SSE-hendelsen kommer fra at PROVIDER-adapteren strømmer
 * tool_call_complete for HVERT kall modellen ber om, FØR
 * completeWithTools sin dedupe-sjekk (som skjer etter runden er strømmet
 * ferdig) rekker å kjøre. Den observerte 16 sekunders TTFT-en skyldes derfor
 * en EKSTRA MODELLRUNDE (modellen ba om verktøyet på nytt før den svarte),
 * IKKE en ekstra ToolGateway-/transport-utførelse.
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias",
  tenant_id: "tenant-samturn",
  memory_space_id: "personal",
  session_id: "sess-samturn",
  device_id: "jarvis-voice-live",
  channel: "voice",
  auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-samturn-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_samturn LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_samturn");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-samturn','Same-turn-test','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-samturn');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_samturn", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

function newToolGateway(transport: FakeTransport): ToolGateway {
  const devices = new InMemoryDeviceRegistry();
  const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
  const tg = new ToolGateway(appPool, policy, { name: "test", async get() { return "secret"; } });
  for (const tool of firstWaveTools({ calendar: transport })) tg.register(tool);
  return tg;
}

const dCall = (id: string): ToolCallRequest => ({
  tool_call_id: id, tool_name: "read_calendar_today", arguments: {}, provider: "scripted", model: "scripted-1"
});

describe("§7.A REGRESJON: samme modellrunde/samtaletur, samme semantiske kall → maks 1 faktisk utførelse", () => {
  it("SAMME runde ber om read_calendar_today TVUNGET TO GANGER → 2 tool_call_complete-events, 1 transport-kall", async () => {
    const transport = new FakeTransport(() => ({ data: { events: [{ id: "e1", title: "standup" }] } }));
    const toolGateway = newToolGateway(transport);
    const executor = new MeshToolExecutor(toolGateway, identity);
    // Modellen (skriptet) ber om SAMME verktøy TO GANGER i runde 1, svarer i runde 2:
    const adapter = new ScriptedAdapter(
      () => "Ingen avtaler i dag.",
      (req) => (req.tool_exchanges ? [] : [dCall("c1"), dCall("c2")])
    );
    const gateway = new ModelGateway({ pool: appPool, trace: new MemoryTraceSink(), providers: [adapter] });
    const events: StreamEvent[] = [];
    const result = await gateway.completeWithTools(
      { tenant_id: identity.tenant_id, session_id: identity.session_id, purpose: "CHAT", request: { messages: [{ role: "user", content: "Hva står på kalenderen min i dag?" }], max_tokens: 100 } },
      { tools: meshToolDefinitions(), executor, onEvent: (e) => events.push(e) }
    );
    const toolCallCompleteEvents = events.filter((e) => e.type === "tool_call_complete");
    expect(toolCallCompleteEvents.length).toBe(2); // (A): modellen/provideren strømmet 2 events
    expect(transport.calls.length).toBe(1); // men KUN 1 faktisk transport-/ToolGateway-utførelse
    expect(result.text).toBe("Ingen avtaler i dag.");
  });

  it("TO ETTERFØLGENDE RUNDER ber om SAMME verktøy før svar → fortsatt 1 transport-kall (forklarer host sin 16s TTFT: ekstra RUNDE, ikke ekstra verktøykall)", async () => {
    const transport = new FakeTransport(() => ({ data: { events: [{ id: "e1", title: "standup" }] } }));
    const toolGateway = newToolGateway(transport);
    const executor = new MeshToolExecutor(toolGateway, identity);
    let round = 0;
    const adapter = new ScriptedAdapter(
      () => "Ingen avtaler i dag.",
      () => {
        round += 1;
        // Runde 1: be om verktøyet. Runde 2: be om DET SAMME verktøyet PÅ NYTT
        // (modellen "dobbeltsjekker" - nøyaktig host-symptomet). Runde 3: svar.
        return round <= 2 ? [dCall(`c${round}`)] : [];
      }
    );
    const gateway = new ModelGateway({ pool: appPool, trace: new MemoryTraceSink(), providers: [adapter] });
    const events: StreamEvent[] = [];
    const result = await gateway.completeWithTools(
      { tenant_id: identity.tenant_id, session_id: identity.session_id, purpose: "CHAT", request: { messages: [{ role: "user", content: "Hva står på kalenderen min i dag?" }], max_tokens: 100 } },
      { tools: meshToolDefinitions(), executor, onEvent: (e) => events.push(e), maxRounds: 4 }
    );
    const toolCallCompleteEvents = events.filter((e) => e.type === "tool_call_complete");
    expect(toolCallCompleteEvents.length).toBe(2); // 2 SSE-events (én per runde)
    expect(transport.calls.length).toBe(1); // in-memory cache dedupet den ANDRE runden
    expect(result.metadata?.["tool_rounds"]).toBe(2); // 2 runder brukte verktøy - dette ER ekstra-latensen
    expect(result.text).toBe("Ingen avtaler i dag.");
  });
});

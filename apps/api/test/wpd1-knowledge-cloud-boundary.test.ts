import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore, createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { FilesystemKnowledgeSource, KnowledgeRetriever, KnowledgeSyncService } from "@jarvis/knowledge";
import { LocalHashEmbedding } from "@jarvis/memory";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import type { ModelProviderAdapter, ModelRequest, ModelResult, ToolCallRequest } from "@jarvis/provider-adapters";
import {
  CHAT_READ_TIER,
  KnowledgeSearchTransport,
  MeshToolExecutor,
  ToolGateway,
  buildToolManifest,
  chatReadTierMeshTools,
  createTurnContext,
  knowledgeToolDefinitions,
  type SecretProvider
} from "@jarvis/tool-gateway";
import { cloudScreenedExecutor, servedByCloudModel } from "../src/cloud-tool-screen.ts";

/**
 * WP-D1 (UA-2, D-449/D-451): kunnskapssøket gjennom HELE kjeden som chatten bruker - ekte embedded Postgres (RLS som app-rolle), ekte `KnowledgeRetriever`, ekte `ToolGateway` + `PolicyGateway`,
 * ekte `MeshToolExecutor` (flate, manifest, taint) og den ekte `ModelGateway`-verktøyløkka med skriptede leverandør-adaptere. Det eneste som kontrolleres er det modellens adapter faktisk MOTTAR i runde 2
 * (`request.tool_exchanges`): det er det som forlater maskinen.
 */
const A = "tenant-wpd1-bnd";
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: A, memory_space_id: "personal", session_id: "sess-wpd1-bnd", device_id: "dev-bnd", channel: "web", auth_strength: "active"
};
const SECRET = "ALDRI-TIL-SKYEN-hemmelig-diagnose-psykiater";
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let toolGateway: ToolGateway;

function fakePool(): pg.Pool {
  const client = { query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }), release: () => undefined };
  return { connect: async () => client } as unknown as pg.Pool;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd1-bnd-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpd1_bnd LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpd1_bnd");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${A}','A','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${A}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd1_bnd", password: "pw2" });

  const root = await mkdtemp(join(tmpdir(), "jarvis-wpd1-bnd-docs-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "ski.md"), "Referat: vi planlegger skitur til Nordmarka i helgen og tar med termos.");
  await writeFile(join(root, "diagnose.md"), `Referat: ${SECRET}. Tobias har fått en ny diagnose og skal til legetime og tar resepten.`);
  const embedding = new LocalHashEmbedding();
  await new KnowledgeSyncService(appPool, embedding).sync(identity, "personal", new FilesystemKnowledgeSource(root, "fs:wpd1-bnd"));

  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
  const secrets: SecretProvider = { name: "test", async get() { return "intern-token"; } };
  toolGateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of knowledgeToolDefinitions(new KnowledgeSearchTransport(new KnowledgeRetriever(appPool, embedding)))) toolGateway.register(tool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

const usage = { input_tokens: 1, output_tokens: 1 };
const knowledgeCall = (provider: string, model: string): ToolCallRequest => ({ tool_call_id: "c1", tool_name: "knowledge__search", arguments: { query: "referat diagnose skitur" }, provider, model });

/** Runde 1: ber om kunnskapssøket. Runde 2+: ferdig svar. Husker hver request den mottok. */
function scripted(name: string, model: string): ModelProviderAdapter & { requests: ModelRequest[] } {
  let round = 0;
  const requests: ModelRequest[] = [];
  const next = (req: ModelRequest): ModelResult => {
    requests.push(JSON.parse(JSON.stringify(req)) as ModelRequest);
    round += 1;
    return round === 1
      ? ({ text: "", provider: name, model, tool_calls: [knowledgeCall(name, model)], usage, latency_ms: 1, finish_reason: "tool_calls" } as unknown as ModelResult)
      : ({ text: "Ferdig.", provider: name, model, usage, latency_ms: 1, finish_reason: "stop" } as unknown as ModelResult);
  };
  return { name, model, requests, available: () => true, complete: async (req: ModelRequest) => next(req), stream: async (req: ModelRequest) => next(req) } as unknown as ModelProviderAdapter & { requests: ModelRequest[] };
}
const seenInRound2 = (p: { requests: ModelRequest[] }): string => JSON.stringify(p.requests.slice(1).map((r) => r.tool_exchanges ?? []));

function chat(providerPreference: string[]) {
  const mappings = chatReadTierMeshTools(toolGateway.list(), CHAT_READ_TIER, "read");
  const turn = createTurnContext("web_chat", "hva står det i referatene mine om diagnose og skitur?");
  const reports: Array<{ tool: string; withheld: number }> = [];
  const executor = cloudScreenedExecutor(
    new MeshToolExecutor(toolGateway, identity, 20_000, mappings, turn, { manifest: buildToolManifest(toolGateway.list()) }),
    (r) => reports.push(r),
    servedByCloudModel
  );
  const cloud = scripted("anthropic", "claude-sonnet-5-5");
  const local = scripted("gemma_local", "gemma3");
  const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [cloud, local] });
  const run = () =>
    gateway.completeWithTools(
      { tenant_id: A, purpose: "CHAT", sensitivity: "PRIVATE", providerPreference, request: { messages: [{ role: "user", content: "hva står det i referatene mine om diagnose og skitur?" }] } },
      { tools: mappings.map((m) => m.def), executor, localStickiness: true }
    );
  return { run, cloud, local, turn, reports };
}

describe("WP-D1: det modellens adapter faktisk mottar fra kunnskapssøket (ekte kjede)", () => {
  it("skymodell: ser det trygge treffet, men aldri special-treffet (helsetekst) - resultatet er skjermet og modellen får beskjed om at noe ble holdt tilbake", async () => {
    const vi_ = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { run, cloud, local, reports } = chat(["anthropic"]);
      const out = await run();
      expect(out.provider).toBe("anthropic");
      expect(cloud.requests.length).toBe(2);
      expect(local.requests.length).toBe(0);
      const received = seenInRound2(cloud);
      expect(received).toContain("skitur til Nordmarka");
      expect(received).not.toContain(SECRET);
      expect(received).not.toContain("legetime");
      expect(received).toContain("withheld_count");
      expect(reports).toEqual([{ tool: "knowledge.search", withheld: 1 }]);
    } finally {
      vi_.mockRestore();
    }
  });

  it("lokal modell: får hele resultatet uskjermet (en lokal modell har lov til å se alt, D-378), og skyen kalles aldri", async () => {
    const { run, cloud, local, reports } = chat(["gemma_local"]);
    const out = await run();
    expect(out.provider).toBe("gemma_local");
    expect(cloud.requests.length).toBe(0);
    expect(seenInRound2(local)).toContain(SECRET);
    expect(seenInRound2(local)).toContain("skitur til Nordmarka");
    expect(reports).toEqual([]);
  });

  it("resultatet er markert ubetrodd og tainter turen: en instruks i et dokument kan ikke utløse en handling uten eierens egen bekreftelse", async () => {
    const { run, turn } = chat(["gemma_local"]);
    expect(turn.taint.tainted).toBe(false);
    await run();
    expect(turn.taint.tainted).toBe(true);
    expect(turn.taint.reasons).toContain("untrusted_output:knowledge.search");
  });

  it("en annen identitet (annen tenant) gjennom samme verktøy ser ingenting", async () => {
    const mappings = chatReadTierMeshTools(toolGateway.list(), CHAT_READ_TIER, "read");
    const other = { ...identity, tenant_id: "tenant-annen" };
    const executor = new MeshToolExecutor(toolGateway, other, 20_000, mappings, createTurnContext("web_chat", "x"), { manifest: buildToolManifest(toolGateway.list()) });
    const result = await executor.execute({ tool_call_id: "c1", tool_name: "knowledge__search", arguments: { query: "referat diagnose skitur" }, provider: "p", model: "m" }, { tenant_id: "tenant-annen", idempotency_key: "k-other" });
    // Ukjent tenant: enten avvist av gateway/policy eller tomt resultat - aldri tenant A sine dokumenter.
    expect(JSON.stringify(result.output)).not.toContain("Nordmarka");
    expect(JSON.stringify(result.output)).not.toContain(SECRET);
  });
});

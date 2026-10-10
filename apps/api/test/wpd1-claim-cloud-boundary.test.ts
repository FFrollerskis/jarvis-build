import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore, createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { ClaimVerificationService, KnowledgeRetriever, createKnowledgeClaimsPort } from "@jarvis/knowledge";
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
 * WP-D1 (Q-26, D-449/D-451): påstandsstatusen gjennom HELE kjeden chatten bruker - ekte embedded Postgres (RLS som app-rolle), ekte `ClaimVerificationService` (tilstandsmaskin + evidens),
 * ekte `ToolGateway` + `PolicyGateway`, ekte `MeshToolExecutor` (flate, manifest, taint) og den ekte `ModelGateway`-verktøyløkka med skriptede leverandør-adaptere. Det eneste som kontrolleres
 * er det modellens adapter faktisk MOTTAR i runde 2: det er det som forlater maskinen.
 */
const A = "tenant-wpd1-claimbnd";
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: A, memory_space_id: "personal", session_id: "sess-wpd1-claimbnd", device_id: "dev-claimbnd", channel: "web", auth_strength: "active"
};
const SAFE_CLAIM = "Folketallet i Norge økte i 2025 ifølge offentlig statistikk";
const HEALTH_CLAIM = "Tobias har fått en ny diagnose og skal ta resepten ALDRI-TIL-SKYEN-psykiater";
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let toolGateway: ToolGateway;

function fakePool(): pg.Pool {
  const client = { query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }), release: () => undefined };
  return { connect: async () => client } as unknown as pg.Pool;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd1-claimbnd-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpd1_claimbnd LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpd1_claimbnd");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${A}','A','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${A}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('${A}-personal', '${A}', 'personal');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd1_claimbnd", password: "pw2" });

  // To påstander med ekte evidens: en vanlig (VERIFIED av to uavhengige kilder) og en helsepåstand (special).
  const service = new ClaimVerificationService(appPool);
  for (const text of [SAFE_CLAIM, HEALTH_CLAIM]) {
    const { claim } = await service.registerClaim(identity, "personal", { claim_text: text, start_research: true });
    await service.addEvidence(identity, "personal", claim.claim_id, { stance: "supports", source_ref: "https://www.ssb.no/befolkning/rapport", is_primary: true, excerpt: "Folketallet økte med 0,6 prosent." });
    await service.addEvidence(identity, "personal", claim.claim_id, { stance: "supports", source_ref: "https://www.regjeringen.no/no/tema/statistikk" });
  }

  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
  const secrets: SecretProvider = { name: "test", async get() { return "intern-token"; } };
  toolGateway = new ToolGateway(appPool, policy, secrets);
  const retriever = new KnowledgeRetriever(appPool, new LocalHashEmbedding());
  for (const tool of knowledgeToolDefinitions(new KnowledgeSearchTransport(retriever, createKnowledgeClaimsPort(service)))) toolGateway.register(tool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

const usage = { input_tokens: 1, output_tokens: 1 };
const claimCall = (provider: string, model: string, claim: string): ToolCallRequest => ({ tool_call_id: "c1", tool_name: "knowledge__get_claim_status", arguments: { claim }, provider, model });

function scripted(name: string, model: string, claim: string): ModelProviderAdapter & { requests: ModelRequest[] } {
  let round = 0;
  const requests: ModelRequest[] = [];
  const next = (req: ModelRequest): ModelResult => {
    requests.push(JSON.parse(JSON.stringify(req)) as ModelRequest);
    round += 1;
    return round === 1
      ? ({ text: "", provider: name, model, tool_calls: [claimCall(name, model, claim)], usage, latency_ms: 1, finish_reason: "tool_calls" } as unknown as ModelResult)
      : ({ text: "Ferdig.", provider: name, model, usage, latency_ms: 1, finish_reason: "stop" } as unknown as ModelResult);
  };
  return { name, model, requests, available: () => true, complete: async (req: ModelRequest) => next(req), stream: async (req: ModelRequest) => next(req) } as unknown as ModelProviderAdapter & { requests: ModelRequest[] };
}
/** KUN verktøyresultatene modellen mottok i runde 2 (kallets egne argumenter er det modellen selv skrev, og regnes ikke som noe som lekker). */
const seenInRound2 = (p: { requests: ModelRequest[] }): string => JSON.stringify(p.requests.slice(1).map((r) => (r.tool_exchanges ?? []).map((x) => x.results)));

function chat(providerPreference: string[], claim: string) {
  const mappings = chatReadTierMeshTools(toolGateway.list(), CHAT_READ_TIER, "read");
  const turn = createTurnContext("web_chat", "er påstanden verifisert?");
  const reports: Array<{ tool: string; withheld: number }> = [];
  const executor = cloudScreenedExecutor(
    new MeshToolExecutor(toolGateway, identity, 20_000, mappings, turn, { manifest: buildToolManifest(toolGateway.list()) }),
    (r) => reports.push(r),
    servedByCloudModel
  );
  const cloud = scripted("anthropic", "claude-sonnet-5-5", claim);
  const local = scripted("gemma_local", "gemma3", claim);
  const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [cloud, local] });
  const run = () =>
    gateway.completeWithTools(
      { tenant_id: A, purpose: "CHAT", sensitivity: "PRIVATE", providerPreference, request: { messages: [{ role: "user", content: "er påstanden verifisert?" }] } },
      { tools: mappings.map((m) => m.def), executor, localStickiness: true }
    );
  return { run, cloud, local, turn, reports };
}

describe("WP-D1 Q-26: det modellens adapter faktisk mottar fra påstandsstatusen (ekte kjede)", () => {
  it("skymodell: en vanlig VERIFIED påstand med evidens og status kommer fram uskjermet (samme objekt, ingenting holdt tilbake)", async () => {
    const vi_ = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { run, cloud, reports } = chat(["anthropic"], SAFE_CLAIM);
      const out = await run();
      expect(out.provider).toBe("anthropic");
      expect(cloud.requests.length).toBe(2);
      const received = seenInRound2(cloud);
      expect(received).toContain("VERIFIED");
      expect(received).toContain("ssb.no");
      expect(received).toContain("regjeringen.no");
      expect(received).toContain("untrusted");
      expect(received).not.toContain("withheld_count");
      expect(reports).toEqual([]);
    } finally {
      vi_.mockRestore();
    }
  });

  it("skymodell: helsepåstanden (special) holdes tilbake i sin helhet - verken tekst, kilder eller utdrag forlater maskinen, og modellen får beskjed om at statusen ikke ble lest", async () => {
    const vi_ = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { run, cloud, local, reports } = chat(["anthropic"], HEALTH_CLAIM);
      await run();
      expect(local.requests.length).toBe(0);
      const received = seenInRound2(cloud);
      expect(received).not.toContain("ALDRI-TIL-SKYEN");
      expect(received).not.toContain("diagnose");
      expect(received).not.toContain("ssb.no");
      expect(received).toContain("withheld_count");
      expect(received).toContain("verifiseringsstatusen ikke ble lest");
      expect(reports).toEqual([{ tool: "knowledge.get_claim_status", withheld: 1 }]);
    } finally {
      vi_.mockRestore();
    }
  });

  it("lokal modell: får hele rapporten uskjermet også for helsepåstanden, og skyen kalles aldri", async () => {
    const { run, cloud, local, reports } = chat(["gemma_local"], HEALTH_CLAIM);
    const out = await run();
    expect(out.provider).toBe("gemma_local");
    expect(cloud.requests.length).toBe(0);
    const received = seenInRound2(local);
    expect(received).toContain("ALDRI-TIL-SKYEN-psykiater");
    expect(received).toContain("VERIFIED");
    expect(reports).toEqual([]);
  });

  it("en påstand som ikke er registrert er UNKNOWN (verken bekreftet eller avkreftet) - aldri en gjetning - og passerer skjermen", async () => {
    const vi_ = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { run, cloud, reports } = chat(["anthropic"], "Dette er en påstand ingen har sjekket ennå");
      await run();
      const received = seenInRound2(cloud);
      expect(received).toContain("UNKNOWN");
      expect(received).toContain("verken bekreftet eller avkreftet");
      expect(received).not.toContain("VERIFIED");
      expect(reports).toEqual([]);
    } finally {
      vi_.mockRestore();
    }
  });

  it("resultatet er markert ubetrodd og tainter turen; en annen tenant ser verken påstanden eller evidensen", async () => {
    const { run, turn } = chat(["gemma_local"], SAFE_CLAIM);
    expect(turn.taint.tainted).toBe(false);
    await run();
    expect(turn.taint.tainted).toBe(true);
    expect(turn.taint.reasons).toContain("untrusted_output:knowledge.get_claim_status");
    const mappings = chatReadTierMeshTools(toolGateway.list(), CHAT_READ_TIER, "read");
    const other = { ...identity, tenant_id: "tenant-annen" };
    const executor = new MeshToolExecutor(toolGateway, other, 20_000, mappings, createTurnContext("web_chat", "x"), { manifest: buildToolManifest(toolGateway.list()) });
    const result = await executor.execute({ tool_call_id: "c1", tool_name: "knowledge__get_claim_status", arguments: { claim: SAFE_CLAIM }, provider: "p", model: "m" }, { tenant_id: "tenant-annen", idempotency_key: "k-other" });
    expect(JSON.stringify(result.output)).not.toContain("ssb.no");
    expect(JSON.stringify(result.output)).not.toContain("VERIFIED");
  });
});

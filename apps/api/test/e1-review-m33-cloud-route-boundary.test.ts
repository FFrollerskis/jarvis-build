import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import {
  ChannelSessionAuthority, ContextBuilder, DeviceService, IdentityService, MessageStore, SessionGrantService, SessionService, createPool, runMigrations
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { DeploymentService, DiagnosisService, IncidentService } from "@jarvis/incidents";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, PolicyGateway, type AuthorityConfig } from "@jarvis/policy";
import { ScriptedAdapter } from "@jarvis/provider-adapters";
import { InProcessWorker, PgTaskQueue, TaskService } from "@jarvis/tasks";
import {
  CLOUD_CONTROL_TOOL_IDS, INFRA_GATED_TOOL_IDS, ToolGateway, cloudControlToolDefinitions, type SecretProvider, type ToolDefinition, type ToolTransport
} from "@jarvis/tool-gateway";
import { ConversationEngine } from "../src/conversation.ts";
import { ownerPredicate } from "../src/control-center/register.ts";
import { createApiServer } from "../src/server.ts";
import { generateDeviceKey, mintGrant, type TestDeviceKey } from "./support/grant-client.ts";

/**
 * Gjennomgang av PR #324 (M33 + L8): rutegrensene for skymålene.
 *
 * M33 - `POST /infra/cloud/read` er en KLASSE A-rute: kun registrerte lese-handlinger i de fire skymål-verktøy-id-ene kan nås. Ingen test beviste at en SKRIVE-handling (`cloudflare.purge_cache`, DNS/WAF-skriving,
 * Postgres-terminering, Infisical-rotasjon) eller et annet verktøy-id avvises FØR gatewayen kalles - bare at en kjent lesing fungerer. Overlevende mutant: fjernes `capability_class !== "A"`-linjen, gikk alle tester
 * fortsatt grønt. Her utledes mengden skrive-handlinger fra de FAKTISK registrerte definisjonene (så en fremtidig skrive-handling dekkes automatisk), og transport-spionen beviser at ingenting nådde leverandøren.
 * L8 - `POST /infra/cloud/mutate` med `provider: "constructor"`/`"__proto__"` ga en TypeError og generisk 400; nå en tydelig `cloud_mutation_unknown_provider:<navn>`.
 */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVER = readFileSync(join(REPO_ROOT, "apps/api/src/server.ts"), "utf8");
function routeBlock(source: string, path: string): string {
  const start = source.indexOf(`url.pathname === "${path}"`);
  if (start < 0) throw new Error(`fant ikke ruten ${path}`);
  const next = source.slice(start + 1).search(/\n {2,4}if \((?:deps\.|req\.method)/);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

describe("A: kildevakt - rekkefølgen i /infra/cloud/read er verktøy-id-allowlist, så lese-klasse, så gateway", () => {
  it("`CLOUD_CONTROL_TOOL_IDS.has(provider)` og `capability_class !== \"A\"` står begge FØR `gateway.execute(`", () => {
    const block = routeBlock(SERVER, "/infra/cloud/read");
    const allow = block.indexOf("CLOUD_CONTROL_TOOL_IDS.has(provider)");
    const klass = block.indexOf('capability_class !== "A"');
    const execute = block.indexOf("gateway.execute(");
    expect(allow).toBeGreaterThan(-1);
    expect(klass).toBeGreaterThan(allow);
    expect(execute).toBeGreaterThan(klass);
    expect(block).toContain('"cloud_read_not_a_read_action"');
    expect(block).toContain('"cloud_read_unknown_action"');
  });
});

const T = "tenant-m33";
const ZONE = "0123456789abcdef0123456789abcdef";
const ROTATION = "11111111-2222-4333-8444-555555555555";
const owner = { person_id: "person-m33-owner", tenant_id: T, memory_space: "business", device_id: "dev-m33-owner" };
const authority: AuthorityConfig = { owner_person_id: owner.person_id, owner_tenants: [T] };
const ownerKey: TestDeviceKey = generateDeviceKey();

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let server: ReturnType<typeof createApiServer>;
let baseUrl: string;
let grant: string;
/** Spionen: hver eneste transport-invokasjon (leverandørkall) mot noen av verktøyene. */
const transportCalls: Array<{ action: string }> = [];
let cloudDefinitions: ToolDefinition[] = [];

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1m33-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_test_e1m33 LOGIN PASSWORD 'pw2'");
  await admin.query("GRANT jarvis_app TO jarvis_test_e1m33");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}','M33','business');
    INSERT INTO people (person_id, display_name) VALUES ('${owner.person_id}','Eier');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${owner.person_id}','${T}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-m33','${T}','business');
  `);
  await admin.query("INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,'api',$4)", [owner.device_id, T, owner.person_id, ownerKey.publicKeyPem]);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_e1m33", password: "pw2" });

  const spy: ToolTransport = { invoke: async (action) => { transportCalls.push({ action }); return { data: { spy: true } as JsonValue }; } };
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), infraGate: new InfraExecutionGate(), infraToolIds: INFRA_GATED_TOOL_IDS, authority });
  const secrets: SecretProvider = { name: "fake", get: async () => "fake" };
  const gateway = new ToolGateway(app, policy, secrets);
  cloudDefinitions = cloudControlToolDefinitions(
    { cloudflare: spy, langfuse: spy, infisical: spy, postgres_ops: spy },
    { cloudflareMutationZones: new Set([ZONE]), infisicalRotationIds: new Set([ROTATION]) }
  );
  for (const d of cloudDefinitions) gateway.register(d);
  // Et KLASSE A-verktøy under en ANNEN verktøy-id: kommer det gjennom lese-ruten, er allowlisten brutt.
  gateway.register({
    tool_id: "github", action: "get_commit", description: "test", input_schema: z.object({}).strict() as unknown as ToolDefinition["input_schema"], capability_class: "A",
    scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60,
    credential_ref: "FAKE_GITHUB_TOKEN", output_trust: "untrusted", transport: spy
  });

  const trace = new MemoryTraceSink();
  const modelGateway = new ModelGateway({ pool: app, trace, providers: [new ScriptedAdapter(() => "ok")] });
  const queue = new PgTaskQueue(app);
  const taskService = new TaskService(app, queue, policy);
  const worker = new InProcessWorker(queue, 60);
  const identityService = new IdentityService(app);
  const sessionService = new SessionService(app);
  const deviceService = new DeviceService(app);
  const grantService = new SessionGrantService(app);
  server = createApiServer({
    identity: identityService, sessions: sessionService, devices: deviceService, grants: grantService,
    channelAuthority: new ChannelSessionAuthority({ pool: app, devices: deviceService, sessions: sessionService, identity: identityService, grants: grantService }),
    policy, worker, tasks: taskService, ownerGate: ownerPredicate(authority),
    conversation: new ConversationEngine({ messages: new MessageStore(app), context: new ContextBuilder(app), gateway: modelGateway, tasks: taskService, worker, trace }),
    incidents: { service: new IncidentService(app), deployments: new DeploymentService(app), diagnosis: new DiagnosisService(app), gateway, infraGate: new InfraExecutionGate(), pool: app }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  grant = await mintGrant(baseUrl, { ...owner, channel: "api" }, ownerKey);
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

/* eslint-disable @typescript-eslint/no-explicit-any */
async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_token: grant, ...body }) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
const ledgerRows = async (): Promise<number> => (await admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE tool_id = ANY($1::text[])", [[...CLOUD_CONTROL_TOOL_IDS, "github"]])).rows[0].n as number;

describe("B (M33): /infra/cloud/read avviser enhver skrive-handling i skymål-verktøyene FØR gatewayen og leverandøren røres", () => {
  it("utgangspunktet: de fire verktøy-id-ene har skrive-handlinger (inkl. cloudflare.purge_cache), utledet fra de registrerte definisjonene", () => {
    const writes = cloudDefinitions.filter((d) => d.capability_class !== "A");
    expect(writes.length).toBeGreaterThanOrEqual(10);
    for (const id of CLOUD_CONTROL_TOOL_IDS) expect(cloudDefinitions.some((d) => d.tool_id === id), id).toBe(true);
    expect(writes.some((d) => d.tool_id === "cloudflare" && d.action === "purge_cache")).toBe(true);
    expect(writes.some((d) => d.tool_id === "postgres_ops" && d.action === "terminate_backend")).toBe(true);
    expect(writes.some((d) => d.tool_id === "infisical" && d.action === "rotate_secrets")).toBe(true);
  });

  it("`cloudflare.purge_cache` (reviewerens eksempel): 400 `cloud_read_not_a_read_action`, ingen leverandørkall, ingen ledgerrad", async () => {
    transportCalls.length = 0;
    const before = await ledgerRows();
    const res = await post("/infra/cloud/read", { provider: "cloudflare", action: "purge_cache", parameters: { zone_id: ZONE, mode: "everything" } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "cloud_read_not_a_read_action" });
    expect(transportCalls).toEqual([]);
    expect(await ledgerRows()).toBe(before);
  });

  it("HVER registrerte skrive-handling (alle klasser over A, alle fire verktøy-id-er) nektes på samme måte - tabelltest utledet fra definisjonene", async () => {
    transportCalls.length = 0;
    const before = await ledgerRows();
    const writes = cloudDefinitions.filter((d) => d.capability_class !== "A");
    for (const d of writes) {
      const res = await post("/infra/cloud/read", { provider: d.tool_id, action: d.action, parameters: {} });
      expect(res.status, `${d.tool_id}.${d.action} (${d.capability_class})`).toBe(400);
      expect(res.body, `${d.tool_id}.${d.action}`).toMatchObject({ error: "cloud_read_not_a_read_action" });
    }
    expect(transportCalls).toEqual([]);
    expect(await ledgerRows()).toBe(before);
  });

  it("kontroll: lese-handlingene (klasse A) i de samme verktøyene avvises IKKE av grensen - de når gatewayen og leverandør-transporten", async () => {
    transportCalls.length = 0;
    const reads = cloudDefinitions.filter((d) => d.capability_class === "A");
    expect(reads.length).toBeGreaterThanOrEqual(10);
    let reached = 0;
    for (const d of reads) {
      const res = await post("/infra/cloud/read", { provider: d.tool_id, action: d.action, parameters: {} });
      expect(res.status, `${d.tool_id}.${d.action}`).toBe(200);
      expect(res.body["error"], `${d.tool_id}.${d.action}`).toBeUndefined();
      if (res.body["ok"] === true) reached += 1;
    }
    expect(reached).toBeGreaterThan(0);
    expect(transportCalls.length).toBeGreaterThan(0);
  });
});

describe("B2 (M33): verktøy-id-allowlisten og ukjente navn", () => {
  it("et klasse A-verktøy under en annen verktøy-id (`github.get_commit`) nektes `cloud_read_unknown_action` - lese-ruten er ikke en generell verktøykall-rute", async () => {
    transportCalls.length = 0;
    const res = await post("/infra/cloud/read", { provider: "github", action: "get_commit", parameters: {} });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "cloud_read_unknown_action" });
    expect(transportCalls).toEqual([]);
  });

  it("ukjent handling hos et skymål, prototype-navn og tomme navn -> `cloud_read_unknown_action` (aldri en 500)", async () => {
    for (const [provider, action] of [["cloudflare", "nope"], ["cloudflare", "constructor"], ["cloudflare", "__proto__"], ["constructor", "get_zone"], ["__proto__", "x"], ["toString", "x"]] as const) {
      const res = await post("/infra/cloud/read", { provider, action, parameters: {} });
      expect(res.status, `${provider}.${action}`).toBe(400);
      expect(res.body, `${provider}.${action}`).toMatchObject({ error: "cloud_read_unknown_action" });
    }
  });
});

describe("C (L8): /infra/cloud/mutate - leverandørnavn som er Object.prototype-egenskaper gir en tydelig avvisning", () => {
  it("`constructor`, `__proto__`, `toString`: 400 `cloud_mutation_rejected` med `cloud_mutation_unknown_provider:<navn>` (ikke en generisk feil), ingenting journalføres", async () => {
    transportCalls.length = 0;
    for (const provider of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const res = await post("/infra/cloud/mutate", { provider, action: "purge_cache", parameters: {}, idempotency_key: `m33-${provider}` });
      expect(res.status, provider).toBe(400);
      expect(res.body, provider).toMatchObject({ error: "cloud_mutation_rejected", reason: `cloud_mutation_unknown_provider:${provider}` });
    }
    expect((await admin.query("SELECT count(*)::int AS n FROM infra_executions WHERE idempotency_key LIKE 'm33-%'")).rows[0].n).toBe(0);
    expect(transportCalls).toEqual([]);
  });
});

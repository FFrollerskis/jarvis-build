import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChannelSessionAuthority, ContextBuilder, DeviceService, IdentityService, MessageStore, SessionGrantService, SessionService, createPool, runMigrations
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { DeploymentService, DiagnosisService, IncidentService, REPAIR_MODEL_BUDGET_CAP_ORE } from "@jarvis/incidents";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, PolicyGateway, type AuthorityConfig } from "@jarvis/policy";
import { ScriptedAdapter } from "@jarvis/provider-adapters";
import { InProcessWorker, PgTaskQueue, TaskService } from "@jarvis/tasks";
import { ToolGateway, type SecretProvider } from "@jarvis/tool-gateway";
import { ConversationEngine } from "../src/conversation.ts";
import { ownerPredicate } from "../src/control-center/register.ts";
import { createApiServer } from "../src/server.ts";
import { generateDeviceKey, mintGrant, type TestDeviceKey } from "./support/grant-client.ts";

/**
 * Gjennomgang av PR #324 (M3): `/incidents/transition` MERKET ENHVER AUTENTISERT GRANT-IDENTITET SOM `actor_kind: "owner"`.
 *
 * Funnet (bekreftet med kjøring): `authedRequest` bekrefter bare at grantet er gyldig, ikke at innehaveren er eieren, og policy-sjekken er klasse B. En annen person (eller en delegert/sekundær person i
 * eierens tenant) kunne dermed lukke eierens hendelser (`close` -> `wont_fix`), noe som demper produsentene (`owner_mute_days`), og historikken viste `{"actor_kind":"owner", ...}` for en som ikke er eier.
 * `/incidents/repair` og `/infra/overview` hadde ingen eier-sjekk (og repair ingen step-up), og `model_budget_ore` var kaller-styrt.
 *
 * Rettelsen bruker DET EKSISTERENDE eier-predikatet kontrollsentrene (WP-H0) bruker - `ownerPredicate(authority)` fra `control-center/register.ts`, bygget fra SAMME `AuthorityConfig` som en ekte
 * `PolicyGateway` - ingen ny logikk. Her: (A) kildevakt mot at koblingen glir (`server.ts`/`main.ts` leses som tekst), (B) kjøretid mot EKTE server + ekte Postgres + ekte `AuthorityConfig`:
 * ikke-eier / annen tenant / annen person nektes 403 `owner_required` med `tool.denied`-revisjon og uten at noe endres, eieren slipper gjennom med riktig aktør, fail-closed uten ownerGate,
 * (C) repair krever step-up og kan ikke øke budsjettet utover serverens tak, (D) skymutasjoner nektes svak/tale-identitet før noe journalføres.
 */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVER = readFileSync(join(REPO_ROOT, "apps/api/src/server.ts"), "utf8");
const MAIN = readFileSync(join(REPO_ROOT, "apps/api/src/main.ts"), "utf8");
/** `server.ts` uten kommentarer: de negative vaktene gjelder KODEN, ikke forklaringene (samme grep som `wph0-control-wiring.test.ts`). */
const SERVER_CODE = SERVER.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
/** Rutekroppen: fra `url.pathname === "<sti>"` til neste toppnivå-rute (`  if (` på to mellomrom) i route-funksjonen. */
function routeBlock(source: string, path: string): string {
  const start = source.indexOf(`url.pathname === "${path}"`);
  if (start < 0) throw new Error(`fant ikke ruten ${path}`);
  const next = source.slice(start + 1).search(/\n {2,4}if \((?:deps\.|req\.method)/);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

describe("A: kildevakt - eier-porten kan ikke glippe ut av rutene eller ut av main.ts", () => {
  it("main.ts bygger `ownerGate` ÉN gang, KUN fra `ownerPredicate(ownerAuthority)` (samme AuthorityConfig som Policy Gateway) - ingen egen eier-sammenligning", () => {
    expect(MAIN.match(/\bownerGate\s*:/g)).toHaveLength(1);
    expect(MAIN).toMatch(/ownerGate: ownerPredicate\(ownerAuthority\),/);
    expect(MAIN).toMatch(/import \{ createControlCenterRegistry, ownerPredicate, registerControlCenters \} from "\.\/control-center\/register\.ts";/);
    expect(MAIN.match(/ownerPredicate\(/g)).toHaveLength(1);
  });

  it("server.ts: `requireOwner` leser KUN `deps.ownerGate`, er fail-closed (mangler den, eller kaster den, nektes alle) og svarer 403 `owner_required` med `tool.denied`-revisjon", () => {
    const fn = SERVER.slice(SERVER.indexOf("async function requireOwner("), SERVER.indexOf("function fieldString("));
    expect(fn).toContain("deps.ownerGate !== undefined && deps.ownerGate(identity) === true");
    expect(fn).toMatch(/catch \{\s*allowed = false;/);
    expect(fn).toContain('"owner_gate_not_configured"');
    expect(fn).toContain('type: "tool.denied", decision: "DENY"');
    expect(fn).toContain('error: "owner_required"');
    expect(fn).toContain("403");
    // ingen egen eier-logikk i server.ts
    expect(SERVER_CODE).not.toMatch(/resolveAuthorityMode|["']SOVEREIGN["']/);
  });

  it("hver av de fire rutene kaller `requireOwner` FØR noe domenekall (overgang, reparasjon, oversikt, skymutasjon)", () => {
    const cases: Array<[string, string]> = [
      ["/incidents/transition", "service.transition("],
      ["/incidents/repair", "service.getIncident("],
      ["/infra/overview", "deps.executive.gateway.execute("],
      ["/infra/cloud/mutate", "executeCloudMutation("]
    ];
    for (const [path, domainCall] of cases) {
      const block = routeBlock(SERVER, path);
      const gate = block.indexOf("requireOwner(");
      const domain = block.indexOf(domainCall);
      expect(gate, `${path}: requireOwner finnes`).toBeGreaterThan(-1);
      expect(domain, `${path}: domenekallet finnes`).toBeGreaterThan(-1);
      expect(gate, `${path}: eier-porten FØR ${domainCall}`).toBeLessThan(domain);
    }
  });

  it("`/incidents/repair` og `/infra/cloud/mutate` kaller også step-up (`stepUpDenial`) før domenekallet; `/infra/recovery/attempt` for skymålene", () => {
    for (const [path, domainCall] of [["/incidents/repair", "service.getIncident("], ["/infra/cloud/mutate", "executeCloudMutation("]] as const) {
      const block = routeBlock(SERVER, path);
      expect(block.indexOf("stepUpDenial("), `${path}`).toBeGreaterThan(-1);
      expect(block.indexOf("stepUpDenial("), `${path}`).toBeLessThan(block.indexOf(domainCall));
    }
    const recovery = routeBlock(SERVER, "/infra/recovery/attempt");
    expect(recovery.indexOf("CLOUD_CONTROL_TOOL_IDS.has(toolId)")).toBeGreaterThan(-1);
    expect(recovery.indexOf("stepUpDenial(")).toBeLessThan(recovery.indexOf("attemptRecovery("));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Kjøretid
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const A = "tenant-m3-a";
const B = "tenant-m3-b";
type Who = { person_id: string; tenant_id: string; memory_space: string; device_id: string };
const owner: Who = { person_id: "person-m3-owner", tenant_id: A, memory_space: "business", device_id: "dev-m3-owner" };
const member: Who = { person_id: "person-m3-member", tenant_id: A, memory_space: "business", device_id: "dev-m3-member" };
const foreign: Who = { person_id: "person-m3-foreign", tenant_id: B, memory_space: "business", device_id: "dev-m3-foreign" };
const WHO = [owner, member, foreign];
const authority: AuthorityConfig = { owner_person_id: owner.person_id, owner_tenants: [A] };
const keys: Record<string, TestDeviceKey> = Object.fromEntries(WHO.map((w) => [w.device_id, generateDeviceKey()]));

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let baseUrl: string;
let server: ReturnType<typeof createApiServer>;
let bareServer: ReturnType<typeof createApiServer>;
let bareUrl: string;
const grants = new Map<string, string>();
const overviewCalls: Array<{ person_id: string; tool_id: string; action: string }> = [];

const grantOf = async (who: Who, channel = "api", url = baseUrl): Promise<string> => {
  const cacheKey = `${url}|${who.device_id}|${channel}`;
  const hit = grants.get(cacheKey);
  if (hit) return hit;
  const token = await mintGrant(url, { ...who, channel }, keys[who.device_id]!);
  grants.set(cacheKey, token);
  return token;
};

async function startServer(withGate: boolean): Promise<{ server: ReturnType<typeof createApiServer>; url: string }> {
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), infraGate: new InfraExecutionGate(), authority });
  const secrets: SecretProvider = { name: "fake", get: async () => "fake" };
  const gateway = new ToolGateway(app, policy, secrets);
  const trace = new MemoryTraceSink();
  const modelGateway = new ModelGateway({ pool: app, trace, providers: [new ScriptedAdapter(() => "ok")] });
  const queue = new PgTaskQueue(app);
  const taskService = new TaskService(app, queue, policy);
  const worker = new InProcessWorker(queue, 60);
  const identityService = new IdentityService(app);
  const sessionService = new SessionService(app);
  const deviceService = new DeviceService(app);
  const grantService = new SessionGrantService(app);
  const stubExecutive = {
    execute: async (request: { identity: { person_id: string }; tool_id: string; action: string }) => {
      overviewCalls.push({ person_id: request.identity.person_id, tool_id: request.tool_id, action: request.action });
      return { ok: true, data: { summary_no: "ok" }, output_trust: "trusted", deduplicated: false };
    }
  } as unknown as ToolGateway;
  const s = createApiServer({
    identity: identityService, sessions: sessionService, devices: deviceService, grants: grantService,
    channelAuthority: new ChannelSessionAuthority({ pool: app, devices: deviceService, sessions: sessionService, identity: identityService, grants: grantService }),
    policy, worker, tasks: taskService,
    ...(withGate ? { ownerGate: ownerPredicate(authority) } : {}),
    conversation: new ConversationEngine({ messages: new MessageStore(app), context: new ContextBuilder(app), gateway: modelGateway, tasks: taskService, worker, trace }),
    incidents: { service: new IncidentService(app), deployments: new DeploymentService(app), diagnosis: new DiagnosisService(app), gateway, infraGate: new InfraExecutionGate(), pool: app },
    executive: { gateway: stubExecutive }
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return { server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1m3-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_test_e1m3 LOGIN PASSWORD 'pw2'");
  await admin.query("GRANT jarvis_app TO jarvis_test_e1m3");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${A}','A','business'), ('${B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ${WHO.map((w) => `('${w.person_id}','${w.person_id}')`).join(",")};
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ${WHO.map((w) => `('${w.person_id}','${w.tenant_id}')`).join(",")};
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-m3-a','${A}','business'), ('sp-m3-b','${B}','business');
  `);
  for (const w of WHO) {
    await admin.query("INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,'api',$4)", [w.device_id, w.tenant_id, w.person_id, keys[w.device_id]!.publicKeyPem]);
  }
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_e1m3", password: "pw2" });
  ({ server, url: baseUrl } = await startServer(true));
  ({ server: bareServer, url: bareUrl } = await startServer(false));
}, 240_000);

afterAll(async () => {
  await Promise.all([server, bareServer].map((s) => new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()))));
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

/* eslint-disable @typescript-eslint/no-explicit-any */
async function post(path: string, body: Record<string, unknown>, as: Who = owner, opts: { channel?: string; url?: string } = {}): Promise<{ status: number; body: Record<string, any> }> {
  const url = opts.url ?? baseUrl;
  const grant_token = await grantOf(as, opts.channel ?? "api", url);
  const response = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_token, ...body }) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
const createIncident = async (title: string, as: Who = owner): Promise<string> => (await post("/incidents/create", { title }, as)).body["incident"]["incident_id"] as string;
const deniedAudits = async (personId: string, toolId: string, action: string): Promise<number> =>
  (await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE type = 'tool.denied' AND reason = 'owner_required' AND person_id = $1 AND tool_id = $2 AND action = $3", [personId, toolId, action])).rows[0].n as number;

describe("B: /incidents/transition - kun den suverene eieren, og aktøren i historikken er sann", () => {
  it("eier: 200, `actor_kind: owner` med eierens person - historikken viser riktig aktør", async () => {
    const id = await createIncident("Eierens hendelse");
    const res = await post("/incidents/transition", { incident_id: id, action: "acknowledge", reason: "ser på det" });
    expect(res.status).toBe(200);
    const history = (await post("/incidents/get", { incident_id: id })).body["transitions"] as Array<Record<string, unknown>>;
    expect(history.at(-1)).toMatchObject({ actor_kind: "owner", actor_person_id: owner.person_id, to_status: "diagnosing" });
  });

  it("annen person i eierens tenant (reviewerens repro): 403 owner_required, hendelsen er uendret, historikken har ingen ny rad, og en tool.denied-revisjonsrad er skrevet", async () => {
    const id = await createIncident("Skal ikke kunne lukkes av andre");
    const before = (await post("/incidents/get", { incident_id: id })).body["transitions"] as unknown[];
    for (const action of ["close", "resolve", "acknowledge"]) {
      const res = await post("/incidents/transition", { incident_id: id, action, reason: "forsøk fra en som ikke er eier" }, member);
      expect(res.status, action).toBe(403);
      expect(res.body, action).toMatchObject({ error: "owner_required", reason: "owner_required" });
    }
    const after = await post("/incidents/get", { incident_id: id });
    expect(after.body["incident"].status).toBe("open");
    expect(after.body["transitions"]).toHaveLength(before.length);
    expect(JSON.stringify(after.body["transitions"])).not.toContain(member.person_id);
    expect(await deniedAudits(member.person_id, "incidents", "transition")).toBeGreaterThanOrEqual(3);
  });

  it("annen tenant/annen person (identity B): 403 owner_required allerede FØR hendelsen slås opp - samme svar for en hendelse som finnes og en som ikke finnes (ingen orakel)", async () => {
    const id = await createIncident("Tenant A sin");
    const real = await post("/incidents/transition", { incident_id: id, action: "close", reason: "x" }, foreign);
    const missing = await post("/incidents/transition", { incident_id: "inc-finnes-ikke", action: "close", reason: "x" }, foreign);
    expect(real.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(real.body).toMatchObject({ error: "owner_required" });
    expect(missing.body).toMatchObject({ error: "owner_required" });
    expect((await post("/incidents/get", { incident_id: id })).body["incident"].status).toBe("open");
  });

  it("ikke-eieren får 403 også for en ugyldig kropp (ingen validerings-orakel), men uten grant er det fortsatt 401", async () => {
    expect((await post("/incidents/transition", { incident_id: "x", action: "constructor", reason: "x" }, member)).status).toBe(403);
    const noGrant = await fetch(`${baseUrl}/incidents/transition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ incident_id: "x", action: "close", reason: "x" }) });
    expect(noGrant.status).toBe(401);
  });

  it("FAIL-CLOSED: en server uten ownerGate nekter alle - også eieren (`owner_gate_not_configured`)", async () => {
    const id = await createIncident("Uten port", owner);
    const res = await post("/incidents/transition", { incident_id: id, action: "close", reason: "x" }, owner, { url: bareUrl });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "owner_required", reason: "owner_gate_not_configured" });
  });
});

describe("C: /incidents/repair - eier + step-up + budsjetttak", () => {
  const base = { repo_url: "https://github.com/tsworkflow/e1-repo", goal: "fiks feilen", test_command: ["node", "--test"] };

  it("ikke-eier nektes 403 owner_required (ingen jobb opprettes, hendelsen er uendret)", async () => {
    const id = await createIncident("Repair-nektelse");
    const res = await post("/incidents/repair", { ...base, incident_id: id }, member);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "owner_required" });
    expect((await post("/incidents/get", { incident_id: id })).body["incident"].status).toBe("open");
    expect((await admin.query("SELECT count(*)::int AS n FROM incident_repair_tasks WHERE incident_id = $1", [id])).rows[0].n).toBe(0);
    expect(await deniedAudits(member.person_id, "incidents", "repair")).toBeGreaterThanOrEqual(1);
  });

  it("eier uten enhetssignert eier-kanal (tale): 403 step_up_required:channel_voice_not_allowed - ingen jobb", async () => {
    const id = await createIncident("Repair-step-up");
    const res = await post("/incidents/repair", { ...base, incident_id: id }, owner, { channel: "voice" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "step_up_required", reason: "step_up_required:channel_voice_not_allowed" });
    expect((await admin.query("SELECT count(*)::int AS n FROM incident_repair_tasks WHERE incident_id = $1", [id])).rows[0].n).toBe(0);
  });

  it("budsjettet kan senkes men aldri økes utover serverens tak; ugyldige tall avvises; standarden er taket", async () => {
    expect(REPAIR_MODEL_BUDGET_CAP_ORE).toBe(20_000);
    const id = await createIncident("Repair-budsjett");
    for (const [value, reason] of [[REPAIR_MODEL_BUDGET_CAP_ORE + 1, "repair_budget_exceeds_cap"], [10_000_000, "repair_budget_exceeds_cap"], [-1, "repair_budget_invalid"], [12.5, "repair_budget_invalid"]] as const) {
      const res = await post("/incidents/repair", { ...base, incident_id: id, model_budget_ore: value });
      expect(res.status, String(value)).toBe(400);
      expect(res.body, String(value)).toMatchObject({ error: "repair_task_rejected", reason });
    }
    expect((await post("/incidents/get", { incident_id: id })).body["incident"].status).toBe("open");
    const lowered = await post("/incidents/repair", { ...base, incident_id: id, model_budget_ore: 500 });
    expect(lowered.status).toBe(200);
    const row = (await admin.query("SELECT contract FROM tasks WHERE task_id = $1", [lowered.body["task_id"]])).rows[0] as { contract: { model_budget_ore: number } } | undefined;
    expect(row?.contract.model_budget_ore).toBe(500);
    const defaulted = await createIncident("Repair-standard");
    const dflt = await post("/incidents/repair", { ...base, incident_id: defaulted });
    expect(dflt.status).toBe(200);
    const row2 = (await admin.query("SELECT contract FROM tasks WHERE task_id = $1", [dflt.body["task_id"]])).rows[0] as { contract: { model_budget_ore: number } };
    expect(row2.contract.model_budget_ore).toBe(REPAIR_MODEL_BUDGET_CAP_ORE);
  });
});

describe("D: /infra/overview og /infra/cloud/mutate - eier-port", () => {
  it("/infra/overview: ikke-eier nektes 403 owner_required og gatewayen kalles ALDRI; eieren slipper gjennom", async () => {
    overviewCalls.length = 0;
    for (const who of [member, foreign]) {
      const res = await post("/infra/overview", {}, who);
      expect(res.status, who.person_id).toBe(403);
      expect(res.body, who.person_id).toMatchObject({ error: "owner_required" });
    }
    expect(overviewCalls).toEqual([]);
    expect(await deniedAudits(member.person_id, "executive", "get_infra_status")).toBeGreaterThanOrEqual(1);
    const ok = await post("/infra/overview", {}, owner);
    expect(ok.status).toBe(200);
    expect(overviewCalls).toEqual([{ person_id: owner.person_id, tool_id: "executive", action: "get_infra_status" }]);
  });

  it("/infra/cloud/mutate: ikke-eier -> owner_required, eier på tale -> step_up_required - begge FØR noe journalføres; signert eier når frem til domenekallet", async () => {
    const body = { provider: "cloudflare", action: "purge_cache", parameters: { zone_id: "0123456789abcdef0123456789abcdef", mode: "everything" }, idempotency_key: "m3-key-1" };
    const notOwner = await post("/infra/cloud/mutate", body, member);
    expect(notOwner.status).toBe(403);
    expect(notOwner.body).toMatchObject({ error: "owner_required" });
    const voice = await post("/infra/cloud/mutate", { ...body, idempotency_key: "m3-key-2" }, owner, { channel: "voice" });
    expect(voice.status).toBe(403);
    expect(voice.body).toMatchObject({ error: "step_up_required", reason: "step_up_required:channel_voice_not_allowed" });
    expect((await admin.query("SELECT count(*)::int AS n FROM infra_executions WHERE idempotency_key IN ('m3-key-1','m3-key-2')")).rows[0].n).toBe(0);
    // Signert eier: porten passeres; verktøyet er ikke registrert i denne testserveren, så svaret er domenets egen avvisning (ikke owner_required/step_up_required).
    const signed = await post("/infra/cloud/mutate", { ...body, idempotency_key: "m3-key-3" }, owner);
    expect(signed.status).toBe(400);
    expect(signed.body).toMatchObject({ error: "cloud_mutation_rejected", reason: "cloud_mutation_tool_not_registered" });
  });

  it("/infra/recovery/attempt for et skymål: svak kanal nektes step_up_required før noe forsøkes", async () => {
    const res = await post("/infra/recovery/attempt", { tool_id: "cloudflare", action: "update_zone_setting", idempotency_key: "m3-rec-1", parameters: {} }, owner, { channel: "voice" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "step_up_required", reason: "step_up_required:channel_voice_not_allowed" });
    expect((await admin.query("SELECT count(*)::int AS n FROM infra_recovery_actions WHERE idempotency_key = 'm3-rec-1'")).rows[0].n).toBe(0);
  });
});

describe("E: ownerPredicate selv - de samme ikke-eier-kategoriene som kontrollsentrene (WP-H0) nektes", () => {
  it("SCOPED-person, delegat (eierens person MED delegation_id), gjest, annen tenant og annen person er ikke eier; eieren er det", () => {
    const isOwner = ownerPredicate(authority);
    const id = { person_id: owner.person_id, tenant_id: A, memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "signed" } as const;
    expect(isOwner(id)).toBe(true);
    for (const [label, identity] of [
      ["annen person i eierens tenant", { ...id, person_id: member.person_id }],
      ["delegat", { ...id, delegation_id: "deleg-1" }],
      ["gjest", { ...id, person_id: "person-gjest", memory_space_id: "guest" }],
      ["eierens person i annen tenant", { ...id, tenant_id: B }],
      ["annen person i annen tenant", { ...id, person_id: foreign.person_id, tenant_id: B }]
    ] as const) expect(isOwner(identity), label).toBe(false);
  });
});

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import {
  FINANCE_WITHHELD_REASON, MeshToolExecutor, SURFACE_TOOL_GRANTS, ToolGateway, allMeshTools, firstWaveTools, isFinancialNamespace,
  type FinanceExecutionLock, type ToolDefinition, type ToolGatewayOptions, type ToolInvocationContext, type ToolTransport
} from "@jarvis/tool-gateway";
import { servedByCloudModel } from "../src/cloud-tool-screen.ts";
import { FINANCE_EXECUTION_LOCK } from "../src/restricted-context-guard.ts";

/**
 * WP-N1 (fiks-runde 1, F-B1 HIGH): utførelseslåsen for `finance*` omgås av NØSTEDE kall. `executive.get_control_surface_status` og `executive.get_delegation_board` (begge på web_chat) henter `finance.get_kill_switch` via et
 * nøstet `ToolGateway.execute()` UTEN `servingModel`, så `ToolGateway`-låsen (som kun leser `request.servingModel`) ser det aldri. Fiksen holder avlesningen tilbake i selve executive-tjenesten for en skymodell (kun med vakten på).
 *  A. De to verktøyene fra en skymodell/lokal modell/eier-rute (ekte executive-transport, ekte ToolGateway, ekte leverandørregister), via gatewayen og via ekte `MeshToolExecutor`.
 *  B. Flagg AV: oppførselen er uendret fra main (kontroll: lekkasjen finnes uten fiksen, og det nøstede kallet gjøres).
 *  C. GENERELL invariant: ALLE web_chat-tildelte verktøy kalt som skymodell med låsen PÅ når aldri en `finance*`-transport.
 *  D. Kildevakt: ingen produksjonskode utenfor `modules/finance`, `executive`-tjenesten og verktøydefinisjonene utfører et `finance*`-kall selv (et nytt nøstet kall må vurderes mot låsen).
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-n1nest", memory_space_id: "personal", session_id: "sess-n1nest",
  device_id: "jarvis-web", channel: "web", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-n1nest-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const conn = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...conn, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_n1nest LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_n1nest");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-n1nest','N1NEST','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-n1nest');
  `);
  appPool = new pg.Pool({ ...conn, user: "jarvis_n1nest", password: "pw2" });
  appPool.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

/** NØYAKTIG det `main.ts` gir gatewayen (flagg PÅ): produksjonsobjektet, ikke en kopi (se også `wpn1-lock-predicate.test.ts`). */
const LOCK: FinanceExecutionLock = FINANCE_EXECUTION_LOCK;
const KILL_REASON = "N1NEST-KILLSWITCH-REASON-mistenkelig-trekk-på-kortet";
const CLOUD = { provider: "anthropic", model: "claude-sonnet-5-5" };
const LOCAL = { provider: "gemma_local", model: "gemma3:4b" };

interface Call { tool: string; action: string; context: ToolInvocationContext | undefined }
interface Rig { gateway: ToolGateway; calls: Call[]; financeCalls: () => Call[]; definitions: ToolDefinition[] }

const fakeDef = (tool_id: string, action: string, data: JsonValue): ToolDefinition => ({
  tool_id, action, description: "fake", input_schema: z.record(z.any()) as never, capability_class: "A", scopes: [], reversible: true, rollback_procedure: "ingen", idempotent_external: true,
  timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "", output_trust: "trusted",
  transport: { async invoke() { return { data }; } }
});

const FINANCE_TOOL_IDS = [...new Set(firstWaveTools({}).map((d) => d.tool_id).filter((id) => id.startsWith("finance")))];

/** `executiveOptions` speiler `main.ts`: `servedLocally` alltid (H1/H2), `withholdFinanceFromCloud` KUN med vakten på. */
function rig(opts: { lock?: FinanceExecutionLock; withholdFinanceFromCloud?: boolean } = {}): Rig {
  const calls: Call[] = [];
  const recorder = (tool: string): ToolTransport => ({
    async invoke(action, _p, _c, context) {
      calls.push({ tool, action, context });
      if (tool === "finance" && action === "get_kill_switch") {
        return { data: { tenant_id: identity.tenant_id, enabled: true, enabled_by_person_id: "person-tobias", enabled_at: "2026-11-01T00:00:00Z", disabled_at: null, reason: KILL_REASON, updated_at: "2026-11-01T00:00:00Z" } };
      }
      return { data: { rows: [], note: "FIN-RESULTAT" } };
    }
  });
  const transports = Object.fromEntries([...FINANCE_TOOL_IDS, "github"].map((id) => [id, recorder(id)]));
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch(),
    authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
  });
  const options: ToolGatewayOptions = opts.lock ? { financeExecutionLock: opts.lock } : {};
  const gateway = new ToolGateway(appPool, policy, { name: "test", async get() { return "secret"; } }, undefined, undefined, options);
  const definitions = firstWaveTools(transports);
  for (const tool of definitions) gateway.register(tool);
  gateway.register(fakeDef("owner_controls", "get_control_state", { kill_switch: false, frozen_connectors: [], revoked_credentials: [] }));
  gateway.register(fakeDef("situations", "get_pause_state", { paused: [] }));
  gateway.register(fakeDef("situations", "list_autonomy_policies", []));
  const service = new ExecutiveService(gateway, { servedLocally: (m: { provider: string }) => !servedByCloudModel({ provider: m.provider }), ...(opts.withholdFinanceFromCloud ? { withholdFinanceFromCloud: true } : {}) } as never);
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(service))) gateway.register(tool);
  return { gateway, calls, financeCalls: () => calls.filter((c) => c.tool.startsWith("finance")), definitions: [...definitions] };
}

const run = (gateway: ToolGateway, tool_id: string, action: string, parameters: Record<string, unknown>, servingModel?: { provider: string; model: string }) =>
  gateway.execute({ identity, tool_id, action, parameters: parameters as never, idempotency_key: `k-${randomUUID()}`, ...(servingModel !== undefined ? { servingModel } : {}) });

const NESTED_TOOLS = ["get_control_surface_status", "get_delegation_board"] as const;

describe("A: nøstede finansavlesninger holdes tilbake fra skymodeller (lås + vakt PÅ)", () => {
  it("kontrast: DIREKTE finance.get_kill_switch fra skymodellen nektes av ToolGateway-låsen (uendret)", async () => {
    const { gateway, calls } = rig({ lock: LOCK, withholdFinanceFromCloud: true });
    expect(await run(gateway, "finance", "get_kill_switch", { tenant_id: identity.tenant_id }, CLOUD)).toEqual({ ok: false, reason: FINANCE_WITHHELD_REASON });
    expect(calls).toEqual([]);
  });

  it("begge executive-verktøyene fra en SKYmodell: ingen fritekst-begrunnelse, ingen nøstet finance-transport, og et eksplisitt «holdt tilbake»-merke (aldri en null som ser ut som «ingen nødbryter»)", async () => {
    const { gateway, financeCalls } = rig({ lock: LOCK, withholdFinanceFromCloud: true });
    for (const action of NESTED_TOOLS) {
      const r = await run(gateway, "executive", action, {}, CLOUD);
      expect(r.ok, action).toBe(true);
      const text = JSON.stringify(r);
      expect(text, action).not.toContain(KILL_REASON);
      expect(text, action).not.toContain("enabled_by_person_id");
      const data = (r as { data: Record<string, unknown> }).data;
      expect(data["finance_kill_switch"], action).toBeNull();
      expect(data["finance_kill_switch_withheld"], action).toBe(true);
    }
    expect(financeCalls(), "det nøstede finance-kallet gjøres ikke i det hele tatt").toEqual([]);
  });

  it("ukjent/blank leverandør regnes som sky (fail-closed) også for de nøstede avlesningene", async () => {
    const { gateway, financeCalls } = rig({ lock: LOCK, withholdFinanceFromCloud: true });
    for (const model of [{ provider: "", model: "x" }, { provider: "ukjent", model: "x" }, { provider: "GEMMA_LOCAL", model: "x" }, { provider: "hermes", model: "x" }, { provider: "kimi", model: "x" }]) {
      for (const action of NESTED_TOOLS) expect(JSON.stringify(await run(gateway, "executive", action, {}, model)), `${model.provider}/${action}`).not.toContain(KILL_REASON);
    }
    expect(financeCalls()).toEqual([]);
  });

  it("LOKAL modell og eier-rute uten modell (siden, /control, eier-godkjent bekreftelse) får hele svaret, uten «holdt tilbake»-merke", async () => {
    const { gateway, financeCalls } = rig({ lock: LOCK, withholdFinanceFromCloud: true });
    for (const action of NESTED_TOOLS) {
      for (const [label, model] of [["lokal", LOCAL], ["ollama", { provider: "ollama", model: "x" }], ["eier-rute", undefined]] as const) {
        const r = await run(gateway, "executive", action, {}, model);
        expect(JSON.stringify(r), `${action} (${label})`).toContain(KILL_REASON);
        expect((r as { data: Record<string, unknown> }).data["finance_kill_switch_withheld"], `${action} (${label})`).toBeUndefined();
      }
    }
    expect(financeCalls().length).toBe(NESTED_TOOLS.length * 3);
  });

  it("via den EKTE MeshToolExecutor (adapter-stemplet skyleverandør): verktøyresultatet modellen ser har ingen begrunnelse; lokal modell får den", async () => {
    const { gateway } = rig({ lock: LOCK, withholdFinanceFromCloud: true });
    const mesh = allMeshTools(gateway);
    const names = mesh.map((m) => m.def.name).filter((n) => /executive__get_(control_surface_status|delegation_board)/.test(n));
    expect(names.length).toBe(2);
    const executor = new MeshToolExecutor(gateway, identity, 20_000, mesh);
    for (const tool_name of names) {
      const cloud = await executor.execute({ tool_call_id: `c-${tool_name}`, tool_name, arguments: {}, provider: "anthropic", model: "claude-sonnet-5-5" }, { tenant_id: identity.tenant_id, idempotency_key: `k-${randomUUID()}` });
      expect(cloud.success).toBe(true);
      expect(JSON.stringify(cloud.output)).not.toContain(KILL_REASON);
      expect(JSON.stringify(cloud.output)).toContain("finance_kill_switch_withheld");
      const local = await executor.execute({ tool_call_id: `l-${tool_name}`, tool_name, arguments: {}, provider: "gemma_local", model: "gemma3:4b" }, { tenant_id: identity.tenant_id, idempotency_key: `k-${randomUUID()}` });
      expect(JSON.stringify(local.output)).toContain(KILL_REASON);
    }
  });
});

describe("B: flagg AV er uendret fra main (valget utelatt)", () => {
  it("uten `withholdFinanceFromCloud` får en skymodell fortsatt svaret og det nøstede finance-kallet gjøres uten servingModel (kontroll: dette er lekkasjen fiksen lukker når vakten er på)", async () => {
    const { gateway, financeCalls } = rig({ lock: LOCK });
    for (const action of NESTED_TOOLS) {
      const r = await run(gateway, "executive", action, {}, CLOUD);
      expect(JSON.stringify(r), action).toContain(KILL_REASON);
      expect((r as { data: Record<string, unknown> }).data["finance_kill_switch_withheld"], action).toBeUndefined();
    }
    expect(financeCalls().map((c) => [c.tool, c.action, c.context?.servingModel ?? null])).toEqual([["finance", "get_kill_switch", null], ["finance", "get_kill_switch", null]]);
  });

  it("flagg AV: servicemetodene kalles uten ekstra argument og resultatet har ingen nye felter", async () => {
    const { gateway } = rig();
    const service = new ExecutiveService(gateway, {} as never);
    const status = await service.getControlSurfaceStatus(identity);
    const board = await service.getDelegationBoard(identity);
    expect(Object.keys(status).sort()).toEqual(["finance_kill_switch", "owner_control", "situation_domain_pauses"]);
    expect(Object.keys(board).sort()).toEqual(["autonomy_domains", "finance_kill_switch", "frozen_connectors", "revoked_credentials"]);
    expect(service.withholdsFinanceFromCloud(CLOUD)).toBe(false);
  });
});

describe("C: GENERELL invariant - alle web_chat-tildelte verktøy kalt som skymodell med låsen PÅ når aldri en finance*-transport", () => {
  /** Minimale gyldige parametre fra zod-skjemaet (best effort): kreves for å nå selve transporten, der nøstede kall skjer. */
  function sampleValue(schema: z.ZodTypeAny, key: string): unknown {
    const def = (schema as { _def: { typeName: string; innerType?: z.ZodTypeAny; values?: unknown[]; type?: z.ZodTypeAny } })._def;
    switch (def.typeName) {
      case "ZodString": return key.includes("tenant") ? identity.tenant_id : key.includes("person") ? identity.person_id : "x";
      case "ZodNumber": return 1;
      case "ZodBoolean": return false;
      case "ZodEnum": return def.values?.[0];
      case "ZodLiteral": return (def as unknown as { value: unknown }).value;
      case "ZodArray": return [];
      case "ZodOptional": case "ZodNullable": case "ZodDefault": return sampleValue(def.innerType!, key);
      case "ZodRecord": case "ZodObject": return {};
      default: return "x";
    }
  }
  function sampleParams(def: ToolDefinition): Record<string, unknown> {
    if (def.input_schema.safeParse({}).success) return {};
    const shape = (def.input_schema as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape ?? {};
    const out: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(shape)) if (!schema.isOptional()) out[key] = sampleValue(schema, key);
    return out;
  }
  const webChat = new Set(SURFACE_TOOL_GRANTS.web_chat.map((g) => `${g.tool_id}.${g.action}`));

  it("hvert registrerte web_chat-verktøy (lese- og handlingsnivå) kalt som sky: INGEN finance*-transport kalles (verken direkte eller nøstet); verktøyene vi faktisk når er mange nok til at testen ikke er tom", async () => {
    const { gateway, definitions, financeCalls } = rig({ lock: LOCK, withholdFinanceFromCloud: true });
    const registered = gateway.list().filter((d) => webChat.has(`${d.tool_id}.${d.action}`));
    expect(registered.length).toBeGreaterThan(60);
    let reached = 0;
    let financeDenied = 0;
    for (const def of registered) {
      const r = await run(gateway, def.tool_id, def.action, sampleParams(def), CLOUD);
      if (!r.ok && (r.reason === "unknown_tool" || r.reason === "invalid_parameters")) continue;
      reached += 1;
      if (!r.ok && r.reason === FINANCE_WITHHELD_REASON) financeDenied += 1;
    }
    expect(reached).toBeGreaterThan(60);
    expect(financeDenied, "finance*-verktøyene på flaten nektes av låsen").toBeGreaterThan(20);
    expect(financeCalls(), `finance*-transport kalt fra et skykall: ${JSON.stringify(financeCalls().map((c) => `${c.tool}.${c.action}`))}`).toEqual([]);
    expect(definitions.some((d) => isFinancialNamespace(d.tool_id))).toBe(true);
  });

  it("kontroll (testen er ikke tom): UTEN låsen og vakten når de samme skykallene finance*-transporten (både direkte og via executive)", async () => {
    const { gateway, financeCalls } = rig();
    const registered = gateway.list().filter((d) => webChat.has(`${d.tool_id}.${d.action}`));
    for (const def of registered) await run(gateway, def.tool_id, def.action, sampleParams(def), CLOUD);
    const touched = new Set(financeCalls().map((c) => `${c.tool}.${c.action}`));
    expect(touched.size).toBeGreaterThan(5);
    expect(touched.has("finance.get_kill_switch")).toBe(true);
  });

  it("låsen PÅ men vakten AV (kun gateway-låsen): de DIREKTE finansverktøyene er nektet, men det nøstede kallet gjøres - dette er hullet «vakten» (withholdFinanceFromCloud) lukker, og hvorfor begge følger samme flagg i main.ts", async () => {
    const { gateway, financeCalls } = rig({ lock: LOCK });
    for (const action of NESTED_TOOLS) await run(gateway, "executive", action, {}, CLOUD);
    expect(financeCalls().length).toBe(2);
  });
});

describe("D: kildevakt - hvem utfører et finance*-kall selv (et nytt nøstet kall må vurderes mot utførelseslåsen)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === "test" || entry === ".git") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|mjs)$/.test(entry) && !/\.test\.(ts|mjs)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
    }
    return out;
  }
  const files = [...readdirSync(join(ROOT, "modules")).flatMap((m) => walk(join(ROOT, "modules", m, "src"))).filter(Boolean), ...walk(join(ROOT, "apps", "api", "src"))];

  /** Rene deklarasjonstabeller (tildelinger per flate, connector-registeret) - de UTFØRER ingenting. */
  const DECLARATIONS = new Set(["modules/tool-gateway/src/chat-read-tier.ts", "modules/tool-gateway/src/chat-act-tier.ts", "modules/tool-gateway/src/connector-registry.ts", "modules/tool-gateway/src/integrations.ts"]);

  it("`tool_id: \"finance…\"` finnes i produksjonskoden KUN i finans-modulen selv, deklarasjonstabellene, eierens egen finansrute (`finance-actions.ts`, ingen modell i løkka) og executive-tjenestens kill switch-metoder - et NYTT sted må vurderes mot utførelseslåsen", () => {
    const hits = files
      .filter((f) => { const rel = relative(ROOT, f); return !rel.startsWith("modules/finance/") && !DECLARATIONS.has(rel); })
      .flatMap((f) => [...readFileSync(f, "utf8").matchAll(/tool_id:\s*["'`]finance[a-z_]*["'`]/g)].map(() => relative(ROOT, f)));
    const perFile = Object.fromEntries([...new Set(hits)].sort().map((f) => [f, hits.filter((h) => h === f).length]));
    // executive/service.ts: enable/disable/get_kill_switch (eier-handlinger; `executive.get_finance_kill_switch` står IKKE på modellflaten, se under) + de to nøstede avlesningene som holdes tilbake for sky (F-B1).
    // apps/api/src/finance-actions.ts: eierens finansrute (/finance/actions) - kjører uten servingModel, aldri fra en modell.
    expect(perFile).toEqual({ "apps/api/src/finance-actions.ts": 5, "modules/executive/src/service.ts": 3 });
  });

  it("executive.get_finance_kill_switch / enable / disable står IKKE på web_chat (kun de to nøstede avlesningene gjør det, og de er dekket)", () => {
    for (const action of ["get_finance_kill_switch", "enable_finance_kill_switch", "disable_finance_kill_switch"]) expect(SURFACE_TOOL_GRANTS.web_chat.some((g) => g.tool_id === "executive" && g.action === action), action).toBe(false);
    for (const action of NESTED_TOOLS) expect(SURFACE_TOOL_GRANTS.web_chat.some((g) => g.tool_id === "executive" && g.action === action), action).toBe(true);
  });
});

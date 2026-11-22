import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  FINANCE_WITHHELD_REASON, MeshToolExecutor, ToolGateway, allMeshTools, explainToolFailure, firstWaveTools, isFinancialNamespace,
  type FinanceExecutionLock, type SecretProvider, type ToolDefinition, type ToolGatewayOptions, type ToolInvocationContext, type ToolTransport
} from "../src/index.ts";

/**
 * WP-N1 (Q-64 pkt 3, K6): UTFØRELSESLÅS for `finance`/`finance_*` mot skymodeller, mot EKTE `ToolGateway` (DB-revisjon) og de EKTE produksjonsdefinisjonene.
 * Før N1 hadde finansverktøyene kun en utvalgslås: en skymodell som likevel kalte et ikke-valgt `finance_*`-verktøy fikk resultatet. Nå (flagg PÅ):
 *  - skymodell og ukjent modell (ukjent leverandør, ingen leverandørnavn, ingen `servedLocally`, kast, ikke-`true`) nektes FØR policy og transport (transporten kalles aldri), med en `tool.denied`-rad uten innhold,
 *  - lokal modell får hele resultatet; ingen modell i løkka (eierens ruter, `/control`, eier-godkjent bekreftelse) er uendret,
 *  - ikke-finansverktøy er uberørt, og uten valget (flagg AV) er gatewayen identisk med main (en skymodell slipper gjennom, som før).
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-n1k6", memory_space_id: "personal", session_id: "sess-n1k6",
  device_id: "jarvis-web", channel: "web", auth_strength: "active"
};
const secrets: SecretProvider = { name: "test", async get() { return "secret"; } };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-n1k6-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_n1k6 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_n1k6");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-n1k6','N1K6','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-n1k6');
  `);
  appPool = new pg.Pool({ ...base, user: "jarvis_n1k6", password: "pw2" });
  appPool.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

const LOCAL = new Set(["gemma_local", "ollama", "local_llm"]);
const servedLocally = (m: { provider: string }): boolean => LOCAL.has(m.provider);
const FINANCE_IDS = ["finance", "finance_neonomics", "finance_spend", "finance_stripe", "finance_vipps", "finance_wallester"];

interface Rig { gateway: ToolGateway; calls: Array<{ tool: string; action: string; context: ToolInvocationContext | undefined }>; definitions: ToolDefinition[] }

/** Produksjonsdefinisjonene (alle finansnavnerom + github) med en transport som registrerer hvert kall. `lock` utelatt = flagg AV. */
function rig(lock?: FinanceExecutionLock): Rig {
  const calls: Rig["calls"] = [];
  const recorder = (tool: string): ToolTransport => ({
    async invoke(action, _parameters, _credential, context) {
      calls.push({ tool, action, context });
      return { data: { rows: [], note: "FIN-RESULTAT" } };
    }
  });
  const transports = Object.fromEntries([...FINANCE_IDS, "github"].map((id) => [id, recorder(id)]));
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch(),
    authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
  });
  const options: ToolGatewayOptions = lock ? { financeExecutionLock: lock } : {};
  const gateway = new ToolGateway(appPool, policy, secrets, undefined, undefined, options);
  const definitions = firstWaveTools(transports);
  for (const tool of definitions) gateway.register(tool);
  return { gateway, calls, definitions };
}

const run = (gateway: ToolGateway, tool_id: string, action: string, parameters: Record<string, unknown>, servingModel?: { provider: string; model: string }) =>
  gateway.execute({ identity, tool_id, action, parameters: parameters as never, idempotency_key: `k-${randomUUID()}`, ...(servingModel ? { servingModel } : {}) });

const deniedRows = async (reason: string): Promise<Array<{ tool_id: string; action: string; payload: unknown; reason: string }>> =>
  (await adminPool.query("SELECT tool_id, action, payload, reason FROM audit_events WHERE type = 'tool.denied' AND reason = $1 ORDER BY audit_id", [reason])).rows as never;

const CLOUD = { provider: "anthropic", model: "claude-sonnet-5-5" };
const LOCAL_MODEL = { provider: "gemma_local", model: "gemma3:4b" };
const KNOWN_READS: Array<[string, string, Record<string, unknown>]> = [
  ["finance", "get_kill_switch", { tenant_id: identity.tenant_id }],
  ["finance", "list_vendors", { tenant_id: identity.tenant_id }],
  ["finance_spend", "list_spend_records", { tenant_id: identity.tenant_id }],
  ["finance_stripe", "get_balance", { tenant_id: identity.tenant_id }],
  ["finance_vipps", "list_captures", { tenant_id: identity.tenant_id }],
  ["finance_neonomics", "list_bank_accounts", { tenant_id: identity.tenant_id }],
  ["finance_wallester", "list_cards", { tenant_id: identity.tenant_id }]
];

describe("navnerommene: ÉN kilde (FINANCIAL_NAMESPACES i tool-manifest.ts), ikke en duplisert liste", () => {
  it("isFinancialNamespace: finance og finance_<bokstaver> er finans; alt annet (også lignende navn) er det ikke", () => {
    for (const id of FINANCE_IDS) expect(isFinancialNamespace(id), id).toBe(true);
    for (const id of ["finance_", "finances", "finance2", "finance-x", "finance_x1", "Finance", "xfinance", "executive", "memory", "github", "", "finance_stripe_extra1"]) expect(isFinancialNamespace(id), id).toBe(false);
  });

  it("hvert finansnavnerom i PRODUKSJONSdefinisjonene er dekket (ingen finance*-tool_id faller utenfor låsen), og det er nøyaktig de seks", () => {
    const { definitions } = rig();
    const ids = [...new Set(definitions.map((d) => d.tool_id).filter((id) => id.startsWith("finance")))].sort();
    expect(ids).toEqual(FINANCE_IDS);
    for (const id of ids) expect(isFinancialNamespace(id), id).toBe(true);
    expect(definitions.filter((d) => isFinancialNamespace(d.tool_id)).length).toBeGreaterThan(60);
  });
});

describe("flagg PÅ: skymodell og ukjent modell nektes for HVER finans-handling (transporten kalles aldri)", () => {
  it("en skymodell nektes for alle finansverktøy i produksjonsdefinisjonene - uten gyldige parametre også (låsen kommer før parametervalidering) - og ingen transport kalles", async () => {
    const { gateway, calls, definitions } = rig({ servedLocally });
    const finance = definitions.filter((d) => isFinancialNamespace(d.tool_id));
    for (const def of finance) {
      const result = await run(gateway, def.tool_id, def.action, { tenant_id: identity.tenant_id, probe: "FORTROLIG-PARAMETER-XYZ" }, CLOUD);
      expect(result, `${def.tool_id}.${def.action}`).toEqual({ ok: false, reason: FINANCE_WITHHELD_REASON });
    }
    expect(calls).toEqual([]);
    const rows = await deniedRows(FINANCE_WITHHELD_REASON);
    expect(rows.length).toBeGreaterThanOrEqual(finance.length);
  });

  it("revisjonsraden har kun verktøy, handling og årsakskode - aldri parametre, innhold eller modellnavn", async () => {
    const { gateway } = rig({ servedLocally });
    const before = (await deniedRows(FINANCE_WITHHELD_REASON)).length;
    await run(gateway, "finance_stripe", "get_balance", { tenant_id: identity.tenant_id, probe: "HEMMELIG-NOTAT-ABC" }, CLOUD);
    const rows = (await deniedRows(FINANCE_WITHHELD_REASON)).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool_id: "finance_stripe", action: "get_balance", reason: FINANCE_WITHHELD_REASON });
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain("HEMMELIG-NOTAT-ABC");
    expect(text).not.toContain("anthropic");
    expect(text).not.toContain("claude-sonnet");
  });

  it("ukjent modell nektes: ukjent leverandør, tomt/blankt leverandørnavn, manglende leverandør og en servingModel som ikke er et objekt", async () => {
    const { gateway, calls } = rig({ servedLocally });
    const malformed: unknown[] = [
      { provider: "mystery-model", model: "x" }, { provider: "", model: "x" }, { provider: "   ", model: "x" }, { model: "x" }, { provider: 42, model: "x" }, { provider: null, model: "x" }, null, "gemma_local"
    ];
    for (const servingModel of malformed) {
      const result = await gateway.execute({
        identity, tool_id: "finance_stripe", action: "get_balance", parameters: { tenant_id: identity.tenant_id }, idempotency_key: `k-${randomUUID()}`,
        servingModel: servingModel as never
      });
      expect(result, JSON.stringify(servingModel)).toEqual({ ok: false, reason: FINANCE_WITHHELD_REASON });
    }
    expect(calls).toEqual([]);
  });

  it("FAIL-CLOSED på selve låsen: uten `servedLocally`, med en predikat som kaster, og med en som ikke returnerer eksakt true - også en LOKAL leverandør regnes da som sky", async () => {
    const rigs: Array<[string, FinanceExecutionLock]> = [
      ["ingen predikat", {}],
      ["kaster", { servedLocally: () => { throw new Error("register nede"); } }],
      ["ikke-true (undefined)", { servedLocally: (() => undefined) as unknown as NonNullable<FinanceExecutionLock["servedLocally"]> }],
      ["ikke-true (streng)", { servedLocally: (() => "true") as unknown as NonNullable<FinanceExecutionLock["servedLocally"]> }],
      ["ikke en funksjon", { servedLocally: "ja" as unknown as NonNullable<FinanceExecutionLock["servedLocally"]> }]
    ];
    for (const [name, lock] of rigs) {
      const { gateway, calls } = rig(lock);
      const result = await run(gateway, "finance", "get_kill_switch", { tenant_id: identity.tenant_id }, LOCAL_MODEL);
      expect(result, name).toEqual({ ok: false, reason: FINANCE_WITHHELD_REASON });
      expect(calls, name).toEqual([]);
    }
  });
});

describe("fiks-runde 1 (F-B3 L2): ingen unntak fra låsen - en delegert jobbkontrakt og en medfulgt godkjenning løfter den ikke, og årsakskoden er pinnet", () => {
  const contract = (allowed: string[]) => ({
    task_id: "task-1", owner_person_id: identity.person_id, tenant_id: identity.tenant_id, goal: "g", acceptance_criteria: ["x"],
    input: { data: {}, trust_level: "internal", provenance: "chat:s" }, allowed_tools: allowed, allowed_memory_spaces: ["personal"], allowed_network_targets: [],
    agent_profile: "executive", model_budget_ore: 0, retry_policy: { max_attempts: 1, backoff_seconds: 0 }, max_steps: 1
  });
  const withExtras = (gateway: ToolGateway, extra: Record<string, unknown>, servingModel?: { provider: string; model: string }) =>
    gateway.execute({ identity, tool_id: "finance_stripe", action: "get_balance", parameters: { tenant_id: identity.tenant_id }, idempotency_key: `k-${randomUUID()}`, ...(servingModel ? { servingModel } : {}), ...extra } as never);

  it("R31: en skymodell nektes også når kallet bærer en GYLDIG jobbkontrakt som tillater finansverktøyet; en lokal modell med samme kontrakt får resultatet", async () => {
    for (const allowed of [["finance_stripe"], ["finance_stripe.get_balance"], ["finance_stripe", "github"]]) {
      const { gateway, calls } = rig({ servedLocally });
      expect(await withExtras(gateway, { jobContract: contract(allowed) }, CLOUD), allowed.join(",")).toEqual({ ok: false, reason: FINANCE_WITHHELD_REASON });
      expect(calls, allowed.join(",")).toEqual([]);
      expect((await withExtras(gateway, { jobContract: contract(allowed) }, LOCAL_MODEL)).ok, allowed.join(",")).toBe(true);
    }
  });

  it("R31 (rekkefølge): kontraktens egne avslag kommer FØR låsen (verktøy ikke i kontrakten / feil identitet gir sin egen årsak), og låsen kommer før parametervalidering", async () => {
    const { gateway } = rig({ servedLocally });
    expect(await withExtras(gateway, { jobContract: contract(["github"]) }, CLOUD)).toEqual({ ok: false, reason: "tool_not_in_job_contract" });
    expect(await withExtras(gateway, { jobContract: { ...contract(["finance_stripe"]), owner_person_id: "noen-andre" } }, CLOUD)).toEqual({ ok: false, reason: "job_identity_mismatch" });
    expect(await gateway.execute({ identity, tool_id: "finance_stripe", action: "get_balance", parameters: { garbage: 1 } as never, idempotency_key: `k-${randomUUID()}`, servingModel: CLOUD })).toEqual({ ok: false, reason: FINANCE_WITHHELD_REASON });
  });

  it("R32: en medfulgt godkjenning (`approval`, uansett innhold) løfter ikke låsen for en skymodell - ingen policy-evaluering, ingen transport", async () => {
    const { gateway, calls } = rig({ servedLocally });
    for (const approval of [{ signed: true }, { approval_id: "a-1", nonce: "n", signature: "s" }, "godkjent", 1, true]) {
      expect(await withExtras(gateway, { approval }, CLOUD), JSON.stringify(approval)).toEqual({ ok: false, reason: FINANCE_WITHHELD_REASON });
    }
    expect(calls).toEqual([]);
  });

  it("R35: årsakskoden er NØYAKTIG `finance_withheld_from_cloud_model` (runbookens NAS-SQL søker på den), og audit-raden bruker den bokstavelig", async () => {
    expect(FINANCE_WITHHELD_REASON).toBe("finance_withheld_from_cloud_model");
    const { gateway } = rig({ servedLocally });
    const before = (await deniedRows("finance_withheld_from_cloud_model")).length;
    expect(await run(gateway, "finance_stripe", "get_balance", { tenant_id: identity.tenant_id }, CLOUD)).toEqual({ ok: false, reason: "finance_withheld_from_cloud_model" });
    expect((await deniedRows("finance_withheld_from_cloud_model")).length).toBe(before + 1);
  });
});

describe("flagg PÅ: det som SKAL slippe gjennom, gjør det", () => {
  it("en LOKAL modell får hele resultatet for hvert finansnavnerom (D-378 pkt 2), og transporten ser servingModel", async () => {
    const { gateway, calls } = rig({ servedLocally });
    for (const [tool, action, parameters] of KNOWN_READS) {
      const result = await run(gateway, tool, action, parameters, LOCAL_MODEL);
      expect(result.ok, `${tool}.${action}`).toBe(true);
      expect(JSON.stringify(result)).toContain("FIN-RESULTAT");
    }
    expect(calls.map((c) => c.tool).sort()).toEqual(KNOWN_READS.map((r) => r[0]).sort());
    for (const c of calls) expect(c.context?.servingModel).toEqual(LOCAL_MODEL);
  });

  it("INGEN modell i løkka (eierens egne HTTP-ruter, /control, eier-godkjent bekreftelse) er uendret: også med låsen på får kallet resultatet", async () => {
    const { gateway, calls } = rig({ servedLocally });
    for (const [tool, action, parameters] of KNOWN_READS) {
      const result = await run(gateway, tool, action, parameters);
      expect(result.ok, `${tool}.${action}`).toBe(true);
    }
    expect(calls).toHaveLength(KNOWN_READS.length);
    for (const c of calls) expect("servingModel" in (c.context ?? {})).toBe(false);
  });

  it("ikke-finansverktøy er uberørt av låsen, også fra en skymodell (kun finance/finance_* er låst)", async () => {
    const { gateway, calls } = rig({ servedLocally });
    const result = await run(gateway, "github", "read_issues", { repo: "tsworkflow/jarvisbuild" }, CLOUD);
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.tool)).toEqual(["github"]);
  });
});

describe("flagg AV: gatewayen er identisk med main", () => {
  it("uten `financeExecutionLock` slipper en skymodell gjennom til finansverktøyene (som på main) - og ingen finans-nektelse skrives", async () => {
    const { gateway, calls } = rig();
    const before = (await deniedRows(FINANCE_WITHHELD_REASON)).length;
    for (const [tool, action, parameters] of KNOWN_READS) {
      const result = await run(gateway, tool, action, parameters, CLOUD);
      expect(result.ok, `${tool}.${action}`).toBe(true);
    }
    expect(calls).toHaveLength(KNOWN_READS.length);
    expect((await deniedRows(FINANCE_WITHHELD_REASON)).length).toBe(before);
  });

  it("`financeExecutionLock: undefined` er det samme som utelatt", async () => {
    const { gateway, calls } = rig(undefined);
    expect((await run(gateway, "finance_stripe", "get_balance", { tenant_id: identity.tenant_id }, CLOUD)).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("det modellen får se: kort «holdt tilbake»-merknad uten tall, id-er, tellinger eller leverandørnavn", () => {
  it("forklaringen er norsk, uten sifre og uten navn på finansleverandører (heller ikke tjenestenavnet), og ber modellen ikke prøve igjen", () => {
    for (const tool_id of FINANCE_IDS) {
      const explained = explainToolFailure(FINANCE_WITHHELD_REASON, { tool_id, action: "get_balance", surface: "web_chat" });
      expect(explained.retry).toBe("never");
      expect(explained.message).toMatch(/begrenset|holdes tilbake/);
      expect(explained.message).not.toMatch(/\d/);
      expect(explained.message).not.toMatch(/stripe|vipps|neonomics|wallester|fiken|bank|saldo|konto/i);
      expect(explained.message.length).toBeLessThan(400);
    }
  });

  it("gjennom den EKTE MeshToolExecutor: en skymodells kall (adapter-stemplet leverandør) gir success:false med kategorien og merknaden, og transporten kalles aldri", async () => {
    const { gateway, calls } = rig({ servedLocally });
    const executor = new MeshToolExecutor(gateway, identity, 20_000, allMeshTools(gateway));
    const call = (provider: string) => ({ tool_call_id: `c-${provider}`, tool_name: "finance_neonomics__list_bank_accounts", arguments: { tenant_id: identity.tenant_id }, provider, model: "m" });
    const ctx = { tenant_id: identity.tenant_id, idempotency_key: `k-${randomUUID()}` };

    const cloud = await executor.execute(call("anthropic"), ctx);
    expect(cloud.success).toBe(false);
    expect(cloud.error_category).toBe(FINANCE_WITHHELD_REASON);
    expect(JSON.stringify(cloud.output)).toContain("holdes tilbake");
    expect(JSON.stringify(cloud.output)).not.toMatch(/\d|neonomics/i);
    expect(calls).toEqual([]);

    const unknown = await executor.execute(call("noe-helt-ukjent"), { ...ctx, idempotency_key: `k-${randomUUID()}` });
    expect(unknown.success).toBe(false);
    expect(unknown.error_category).toBe(FINANCE_WITHHELD_REASON);

    const local = await executor.execute(call("gemma_local"), { ...ctx, idempotency_key: `k-${randomUUID()}` });
    expect(local.success).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

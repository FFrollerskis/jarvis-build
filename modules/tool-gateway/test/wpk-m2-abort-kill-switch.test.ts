import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, currentCallSignal, toolCallAbortEnabled, type ToolDefinition, type ToolResult, type ToolTransport } from "../src/index.ts";

/**
 * WP-K review M2: abort-/ambient-mekanismen (JARVIS-018) er på ca. 70 kallesteder «ved konstruksjon» og H1 viste at en så bred endring trenger en nødutgang som ikke krever tilbakerulling av kode.
 * `JARVIS_TOOL_CALL_ABORT=off` (KUN eksakt «off»; standard PÅ) gir gammel oppførsel: ingen `AbortController`, ingen ambient kontekst, ingen eksplisitt signal-parameter, ingen inngangsvakt - mens gatewayens eget
 * tidsavbrudd (avvisning `tool_timeout`, utfall ukjent) er uendret. Ekte embedded Postgres.
 */
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-m2", memory_space_id: "personal", session_id: "sess-m2", device_id: "dev-pc", channel: "api", auth_strength: "active"
};
const secrets = { name: "t", get: async () => "fake-token-for-test" };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpkm2-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpkm2 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpkm2");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-m2','M2','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-m2');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpkm2", password: "pw2" });
  policy = new PolicyGateway({
    devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-m2"] }
  });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

afterEach(() => { vi.unstubAllEnvs(); });

const anySchema = { safeParse: (v: unknown) => ({ success: true, data: v as Record<string, JsonValue> }) } as ToolDefinition["input_schema"];
function readTool(toolId: string, timeoutMs: number, transport: ToolTransport): ToolDefinition {
  return {
    tool_id: toolId, action: "read", description: "test", input_schema: anySchema, capability_class: "A", scopes: [], reversible: true, rollback_procedure: "ingen (lesing)",
    idempotent_external: true, timeout_ms: timeoutMs, rate_limit_per_minute: 600, credential_ref: `${toolId.toUpperCase()}_TOKEN`, output_trust: "internal", transport
  };
}

describe("toolCallAbortEnabled: kun eksakt «off» slår av (standard PÅ)", () => {
  it("usatt, tom og alle andre verdier = PÅ; «off» uavhengig av store/små bokstaver og mellomrom = AV", () => {
    expect(toolCallAbortEnabled({})).toBe(true);
    expect(toolCallAbortEnabled({ JARVIS_TOOL_CALL_ABORT: "" })).toBe(true);
    for (const value of ["on", "true", "1", "0", "false", "no", "disabled", "of", "offf", "off-ish"]) expect(toolCallAbortEnabled({ JARVIS_TOOL_CALL_ABORT: value }), value).toBe(true);
    for (const value of ["off", "OFF", " Off ", "oFf"]) expect(toolCallAbortEnabled({ JARVIS_TOOL_CALL_ABORT: value }), value).toBe(false);
  });

  it("leses ved HVERT kall (ingen modulkonstant): å endre miljøet mellom to kall gir ny oppførsel uten omstart", () => {
    expect(toolCallAbortEnabled()).toBe(true);
    vi.stubEnv("JARVIS_TOOL_CALL_ABORT", "off");
    expect(toolCallAbortEnabled()).toBe(false);
    vi.unstubAllEnvs();
    expect(toolCallAbortEnabled()).toBe(true);
  });
});

async function timeoutScenario(): Promise<{ result: ToolResult; seen: { signal?: AbortSignal | undefined; ambient?: AbortSignal | undefined; ran: boolean } }> {
  const seen: { signal?: AbortSignal | undefined; ambient?: AbortSignal | undefined; ran: boolean } = { ran: false };
  const g = new ToolGateway(appPool, policy, secrets);
  g.register(readTool("m2-slow", 100, {
    invoke: async (_action, _params, _cred, _ctx, signal) => {
      seen.signal = signal;
      seen.ambient = currentCallSignal();
      seen.ran = true;
      await sleep(400);
      return { external_id: "x" };
    }
  }));
  const result = await g.execute({ identity, tool_id: "m2-slow", action: "read", parameters: {} });
  return { result, seen };
}

describe("tidsavbrudd: PÅ (standard) avbryter forespørselen; AV gir gammel oppførsel, og tidsavbruddet er uendret", () => {
  it("PÅ: transporten får et signal (eksplisitt OG ambient, samme objekt) som avbrytes med tool_timeout", async () => {
    const { result, seen } = await timeoutScenario();
    expect(result.ok).toBe(false);
    expect(String((result as { reason: string }).reason)).toContain("tool_timeout");
    expect(seen.signal).toBeDefined();
    expect(seen.ambient).toBe(seen.signal);
    expect(seen.signal!.aborted).toBe(true);
    expect(String((seen.signal!.reason as Error).message)).toBe("tool_timeout");
  });

  it("AV: INGEN signal til transporten (verken eksplisitt eller ambient) og forespørselen avbrytes ikke - men tidsavbruddet avviser fortsatt løftet med tool_timeout (som før WP-K)", async () => {
    vi.stubEnv("JARVIS_TOOL_CALL_ABORT", "off");
    const { result, seen } = await timeoutScenario();
    expect(seen.ran).toBe(true);
    expect(seen.signal).toBeUndefined();
    expect(seen.ambient).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(String((result as { reason: string }).reason)).toContain("tool_timeout");
  });
});

async function nestedScenario(): Promise<{ nested: ToolResult | undefined; innerCalls: number }> {
  const g = new ToolGateway(appPool, policy, secrets);
  let innerCalls = 0;
  let nested: ToolResult | undefined;
  g.register(readTool("m2-inner", 5_000, { invoke: async () => { innerCalls += 1; return { external_id: "inner" }; } }));
  g.register(readTool("m2-outer", 100, {
    invoke: async () => {
      await sleep(350); // det ytre kallet har allerede fått tidsavbrudd når det nøstede kallet forsøkes
      nested = await g.execute({ identity, tool_id: "m2-inner", action: "read", parameters: {} });
      return {};
    }
  }));
  await g.execute({ identity, tool_id: "m2-outer", action: "read", parameters: {} });
  await sleep(600);
  return { nested, innerCalls };
}

describe("inngangsvakten (caller_call_aborted): PÅ nekter et nøstet kall fra et avbrutt kall; AV gjør det ikke", () => {
  it("PÅ: det nøstede kallet nektes og leverandørkallet startes aldri", async () => {
    const { nested, innerCalls } = await nestedScenario();
    expect(nested).toEqual({ ok: false, reason: "caller_call_aborted" });
    expect(innerCalls).toBe(0);
  }, 20_000);

  it("AV: gammel oppførsel - det nøstede kallet kjører (ingen vakt)", async () => {
    vi.stubEnv("JARVIS_TOOL_CALL_ABORT", "off");
    const { nested, innerCalls } = await nestedScenario();
    expect(nested).toMatchObject({ ok: true });
    expect(innerCalls).toBe(1);
  }, 20_000);
});

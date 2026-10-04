import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { canonicalJson, toolCallIdempotencyKey } from "@jarvis/model-gateway";
import { McpZapierTransport } from "../src/mcp-zapier-transport.ts";
import { isRetrySafeStatus } from "../src/url-safety.ts";
import { ToolGateway, firstWaveTools, type SecretProvider, type ToolTransport } from "../src/index.ts";

/**
 * D-392 (JARVIS-004/017/018/022): reserve-then-execute-ledger, kanonisk idempotency-nøkkel og trygg retry-regel.
 * Ekte embedded Postgres: beviser at raden FINNES (som 'reserved') mens leverandørkallet pågår, at ingen pool-forbindelse holdes
 * over nettverket, og at en retry etter timeout/krasj/feil aldri utfører mutasjonen to ganger.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let smallPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-d392", memory_space_id: "personal",
  session_id: "sess-d392", device_id: "jarvis-voice-live", channel: "voice", auth_strength: "active"
};
const secrets: SecretProvider = { name: "test", async get() { return "secret"; } };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-d392-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_d392 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_d392");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-d392','D392','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-d392');
  `);
  appPool = new pg.Pool({ ...base, user: "jarvis_d392", password: "pw2", max: 10 });
  appPool.on("error", () => undefined);
  smallPool = new pg.Pool({ ...base, user: "jarvis_d392", password: "pw2", max: 1 });
  smallPool.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await smallPool?.end();
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

afterEach(() => vi.unstubAllGlobals());

function gatewayWith(pool: pg.Pool, transport: ToolTransport, timeoutMs?: number): ToolGateway {
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(pool), killSwitch: new KillSwitch(),
    authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
  });
  const gateway = new ToolGateway(pool, policy, secrets);
  for (const tool of firstWaveTools({ calendar: transport })) {
    gateway.register(timeoutMs !== undefined && tool.tool_id === "calendar" ? { ...tool, timeout_ms: timeoutMs } : tool);
  }
  return gateway;
}

const params = (): Record<string, JsonValue> => ({
  title: `Møte ${randomUUID().slice(0, 6)}`, start: new Date().toISOString(), end: new Date(Date.now() + 3_600_000).toISOString()
});
const createEvent = (gateway: ToolGateway, parameters: Record<string, JsonValue>, key: string) =>
  gateway.execute({ identity, tool_id: "calendar", action: "create_event", parameters, idempotency_key: key });
const rowOf = async (key: string) =>
  (await adminPool.query("SELECT status, external_id, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0] as
    | { status: string; external_id: string | null; postcondition_reason: string | null } | undefined;

describe("D-392 JARVIS-004/022: reserve-then-execute", () => {
  it("raden står som 'reserved' MENS leverandørkallet pågår, og ingen pool-forbindelse holdes åpen", async () => {
    const key = `k-${randomUUID()}`;
    let during: { status?: string; busy: number } | undefined;
    const transport: ToolTransport = {
      async invoke() {
        const row = await rowOf(key);
        during = { ...(row ? { status: row.status } : {}), busy: appPool.totalCount - appPool.idleCount };
        return { external_id: "evt-1" };
      }
    };
    const result = await createEvent(gatewayWith(appPool, transport), params(), key);
    expect(result.ok).toBe(true);
    expect(during?.status).toBe("reserved");
    expect(during?.busy).toBe(0);
    expect((await rowOf(key))?.status).toBe("succeeded");
    expect((await rowOf(key))?.external_id).toBe("evt-1");
  });

  it("en pool med EN forbindelse deadlocker ikke når transporten selv gjør et nøstet gateway-kall (JARVIS-022)", async () => {
    let nested: Awaited<ReturnType<ToolGateway["execute"]>> | undefined;
    const holder: { gateway?: ToolGateway } = {};
    const transport: ToolTransport = {
      async invoke(action) {
        if (action === "create_event") {
          nested = await holder.gateway!.execute({
            identity, tool_id: "calendar", action: "list_events",
            parameters: { from: new Date().toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() }
          });
        }
        return { external_id: "evt-nested", data: { events: [] } };
      }
    };
    const gateway = gatewayWith(smallPool, transport);
    holder.gateway = gateway;
    const result = await Promise.race([
      createEvent(gateway, params(), `k-${randomUUID()}`),
      new Promise<"deadlock">((resolve) => setTimeout(() => resolve("deadlock"), 8000))
    ]);
    expect(result).not.toBe("deadlock");
    expect(nested).toBeDefined();
  }, 20_000);

  it("tidsavbrudd = utfall ukjent: raden blir 'unverified' og en retry utfører ALDRI mutasjonen på nytt", async () => {
    const key = `k-${randomUUID()}`;
    let calls = 0;
    const transport: ToolTransport = {
      async invoke() { calls += 1; return new Promise(() => undefined); }
    };
    const gateway = gatewayWith(appPool, transport, 60);
    const parameters = params();
    const first = await createEvent(gateway, parameters, key);
    expect(first.ok).toBe(false);
    expect((await rowOf(key))?.status).toBe("unverified");
    const retry = await createEvent(gateway, parameters, key);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.reason).toMatch(/tool_timeout_outcome_unknown/);
    expect(calls).toBe(1);
    const owner = await gateway.reconcile(identity.tenant_id);
    expect(owner.some((r) => r.idempotency_key === key)).toBe(true);
  });

  it("en rad som står igjen som 'reserved' (krasj midt i kallet) blokkerer retry og vises i reconcile etter 5 min", async () => {
    const key = `k-${randomUUID()}`;
    await adminPool.query(
      "INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status) VALUES ('tenant-d392',$1,'calendar','create_event','reserved')",
      [key]
    );
    let calls = 0;
    const gateway = gatewayWith(appPool, { async invoke() { calls += 1; return { external_id: "x" }; } });
    const result = await createEvent(gateway, params(), key);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("execution_in_flight_or_outcome_unknown");
    expect(calls).toBe(0);
    expect((await gateway.reconcile(identity.tenant_id)).some((r) => r.idempotency_key === key)).toBe(false);
    await adminPool.query("UPDATE tool_executions SET executed_at = now() - interval '10 minutes' WHERE idempotency_key = $1", [key]);
    expect((await gateway.reconcile(identity.tenant_id)).some((r) => r.idempotency_key === key)).toBe(true);
  });

  it("leverandørfeil (ikke tidsavbrudd) gir 'failed' og en retry med samme nøkkel KAN utføre mutasjonen", async () => {
    const key = `k-${randomUUID()}`;
    let calls = 0;
    const transport: ToolTransport = {
      async invoke() {
        calls += 1;
        if (calls === 1) throw new Error("calendar_api_error_400:bad_request");
        return { external_id: "evt-ok" };
      }
    };
    const gateway = gatewayWith(appPool, transport);
    const parameters = params();
    const first = await createEvent(gateway, parameters, key);
    expect(first.ok).toBe(false);
    expect((await rowOf(key))?.status).toBe("failed");
    const retry = await createEvent(gateway, parameters, key);
    expect(retry.ok).toBe(true);
    expect(calls).toBe(2);
    expect((await rowOf(key))?.status).toBe("succeeded");
    const again = await createEvent(gateway, parameters, key);
    expect(again.ok && again.deduplicated).toBe(true);
    expect(calls).toBe(2);
  });

  it("to samtidige kall med samme nøkkel: nøyaktig ÉN utfører mutasjonen", async () => {
    const key = `k-${randomUUID()}`;
    let calls = 0;
    const transport: ToolTransport = {
      async invoke() { calls += 1; await new Promise((r) => setTimeout(r, 150)); return { external_id: "evt-race" }; }
    };
    const gateway = gatewayWith(appPool, transport);
    const parameters = params();
    const [a, b] = await Promise.all([createEvent(gateway, parameters, key), createEvent(gateway, parameters, key)]);
    expect(calls).toBe(1);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    if (!loser.ok) expect(loser.reason).toBe("execution_in_flight_or_outcome_unknown");
  });
});

describe("D-392 JARVIS-017: idempotency-nøkkel", () => {
  const input = { tenant_id: "t1", session_id: "s1" };
  it("nøstede argumenter er med i nøkkelen (replacer-arrayen filtrerte dem bort tidligere)", () => {
    const a = toolCallIdempotencyKey(input, { tool_name: "x", arguments: { filter: { id: "A" } } });
    const b = toolCallIdempotencyKey(input, { tool_name: "x", arguments: { filter: { id: "B" } } });
    expect(a).not.toBe(b);
  });
  it("rekkefølgen på nøkler påvirker ikke nøkkelen, på noe nivå", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [2, { y: 2, z: 1 }] }, b: 1 }));
    const a = toolCallIdempotencyKey(input, { tool_name: "x", arguments: { p: { q: 1, r: 2 } } }, 1_000);
    const b = toolCallIdempotencyKey(input, { tool_name: "x", arguments: { p: { r: 2, q: 1 } } }, 1_000);
    expect(a).toBe(b);
  });
  it("samtalebundne nøkler får tidsvindu; oppgavebundne er stabile", () => {
    const call = { tool_name: "x", arguments: { a: 1 } };
    expect(toolCallIdempotencyKey(input, call, 0)).toBe(toolCallIdempotencyKey(input, call, 60_000));
    expect(toolCallIdempotencyKey(input, call, 0)).not.toBe(toolCallIdempotencyKey(input, call, 3 * 3_600_000));
    const task = { tenant_id: "t1", task_id: "task-1" };
    expect(toolCallIdempotencyKey(task, call, 0)).toBe(toolCallIdempotencyKey(task, call, 3 * 3_600_000));
  });
});

describe("D-392 JARVIS-018: retry på mutasjoner", () => {
  it("5xx gjentas bare for lesing; 429 alltid; 4xx aldri", () => {
    expect(isRetrySafeStatus("POST", 503)).toBe(false);
    expect(isRetrySafeStatus("DELETE", 500)).toBe(false);
    expect(isRetrySafeStatus("GET", 503)).toBe(true);
    expect(isRetrySafeStatus(undefined, 502)).toBe(true);
    expect(isRetrySafeStatus("POST", 429)).toBe(true);
    expect(isRetrySafeStatus("GET", 404)).toBe(false);
  });

  it("Zapier tools/call som svarer 503 sendes ÉN gang (ingen dobbel handling); tools/list gjentas", async () => {
    const url = "https://mcp.zapier.com/api/mcp/s/token/mcp";
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 503, headers: new Headers(), text: async () => "" }) as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);
    await expect(new McpZapierTransport().invoke("call_tool", { tool_name: "send", arguments: {} }, url)).rejects.toThrow(/503/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("alle leverandørkall får et avbruddssignal (gateway-timeout avbryter ikke lenger bare løftet)", async () => {
    const { guardedFetch } = await import("../src/url-safety.ts");
    const seen: Array<RequestInit | undefined> = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => { seen.push(init); return { ok: true } as Response; });
    await guardedFetch("https://api.github.com/user");
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

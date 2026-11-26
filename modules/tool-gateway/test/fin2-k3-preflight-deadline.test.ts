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
import { ToolGateway, type ClassDNotification, type ClassDNotifier, type ToolDefinition, type ToolTransport } from "@jarvis/tool-gateway";

/**
 * WP-FIN2 K3 (D-486): preflight og re-arm-lesingen i `ToolGateway.execute` hadde INGEN frist og intet kallsignal (`gateway.ts` `transport.invoke(preflight_action, ...)` uten `withTimeout`/`invokeWithCallSignal`).
 * En hengende lesing holdt kallet for alltid, FØR noe var reservert. Nå: samme `timeout_ms` og signal som selve utførelsen, og tidsavbrudd gir det EKSISTERENDE utfallet av en kastet preflight:
 *   - klasse D: avslag `preflight_failed:tool_timeout` FØR noe reserveres (ingen ledger-rad, ingen mutasjon),
 *   - klasse C: som en kastet preflight (kallet går videre uten før-tilstand),
 *   - re-arm av en feilet rad: avslag + reservasjonen frigis (`failed`, ikke ukjent utfall), ingen mutasjon,
 *   - `JARVIS_TOOL_CALL_ABORT=off`: som før (ingen frist, intet signal).
 * Ekte embedded Postgres (ledger) og ekte `ToolGateway`; ingen nettverk.
 */
class ScriptTransport implements ToolTransport {
  calls: string[] = [];
  readSignals: Array<AbortSignal | undefined> = [];
  state: JsonValue = { phase: "before" };
  /** 1-baserte `read`-kall som henger til signalet avbrytes (uten signal henger de for alltid). */
  hangReads = new Set<number>();
  /** 1-baserte `read`-kall som er trege (svarer etter N ms, uavhengig av signal). */
  slowReads = new Map<number, number>();
  throwReads = new Set<number>();
  private reads = 0;
  async invoke(action: string, _p?: Record<string, JsonValue>, _c?: string, _ctx?: unknown, signal?: AbortSignal): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push(action);
    if (action === "read") {
      this.reads += 1;
      this.readSignals.push(signal);
      if (this.throwReads.has(this.reads)) throw new Error("boom");
      if (this.hangReads.has(this.reads)) {
        return new Promise((_, reject) => {
          if (!signal) return; // uten signal: henger for alltid (den gamle feilen)
          if (signal.aborted) { reject(signal.reason); return; }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      const slow = this.slowReads.get(this.reads);
      if (slow !== undefined) await new Promise((r) => setTimeout(r, slow));
      return { data: this.state };
    }
    if (action === "mutate") {
      this.state = { phase: "after" };
      return { external_id: "ext-1" };
    }
    throw new Error(`unknown_action:${action}`);
  }
  get mutations(): number { return this.calls.filter((c) => c === "mutate").length; }
}

class FakeNotifier implements ClassDNotifier {
  sent: ClassDNotification[] = [];
  ready() { return true; }
  async notify(n: ClassDNotification) { this.sent.push(n); }
}

type Overrides = { [K in keyof ToolDefinition]?: ToolDefinition[K] | undefined };
function def(overrides: Overrides, transport: ToolTransport): ToolDefinition {
  const base: ToolDefinition = {
    tool_id: "fin2-k3", action: "mutate", description: "test",
    input_schema: { safeParse: (v: unknown) => ({ success: true, data: v as Record<string, JsonValue> }) } as ToolDefinition["input_schema"],
    capability_class: "D", scopes: [], reversible: false, rollback_procedure: "manuell rutine",
    idempotent_external: true, timeout_ms: 150, rate_limit_per_minute: 600, credential_ref: "FIN2_STATIC_REF",
    output_trust: "internal", transport, preflight_action: "read", preflight_requires_target: true,
    postcondition_predicate: (after) => (after as { phase?: string }).phase === "after"
  };
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as ToolDefinition;
}

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;
let counter = 0;
const nextKey = (prefix: string) => `${prefix}-${Date.now()}-${(counter += 1)}`;
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-fin2k3", memory_space_id: "home",
  session_id: "sess-fin2k3", device_id: "dev-pc", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fin2-k3-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_fin2k3 LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_fin2k3");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-fin2k3','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias') ON CONFLICT DO NOTHING;
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-fin2k3');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_fin2k3", password: "pw2" });
  policy = new PolicyGateway({ devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch: new KillSwitch(), authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-fin2k3"] } });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);
afterEach(() => { vi.unstubAllEnvs(); });

const secrets = { name: "t", get: async () => "cred" };
function gw(): ToolGateway {
  return new ToolGateway(appPool, policy, secrets, undefined, undefined, { classDPipeline: { enforce: true, notifier: new FakeNotifier() } });
}
const exec = (g: ToolGateway, key: string, parameters: Record<string, JsonValue> = {}) =>
  g.execute({ identity, tool_id: "fin2-k3", action: "mutate", parameters, idempotency_key: key });
const row = async (key: string) => (await adminPool.query("SELECT status, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0] as { status: string; postcondition_reason: string | null } | undefined;

describe("K3: hengende preflight har en frist (ingen mutasjon sendt, ingenting reservert)", () => {
  it("klasse D: avslag `preflight_failed:tool_timeout` innen fristen; ingen mutasjon, INGEN ledger-rad (før reservasjon), og preflight-forespørselen er avbrutt", async () => {
    const t = new ScriptTransport();
    t.hangReads.add(1);
    const g = gw();
    g.register(def({}, t));
    const key = nextKey("k3d");
    const started = Date.now();
    expect(await exec(g, key)).toEqual({ ok: false, reason: "preflight_failed:tool_timeout" });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(t.mutations).toBe(0);
    expect(await row(key)).toBeUndefined();
    expect(t.readSignals[0]).toBeInstanceOf(AbortSignal);
    expect(t.readSignals[0]!.aborted).toBe(true);
  }, 8_000);

  it("klasse C: oppfører seg som en KASTET preflight (kallet går videre uten før-tilstand), og den hengende lesingen er avbrutt", async () => {
    const hung = new ScriptTransport();
    hung.hangReads.add(1);
    const thrown = new ScriptTransport();
    thrown.throwReads.add(1);
    const g = gw();
    g.register(def({ tool_id: "fin2-k3-hung", capability_class: "C", preflight_requires_target: undefined, postcondition_predicate: undefined }, hung));
    g.register(def({ tool_id: "fin2-k3-thrown", capability_class: "C", preflight_requires_target: undefined, postcondition_predicate: undefined }, thrown));
    const hungResult = await g.execute({ identity, tool_id: "fin2-k3-hung", action: "mutate", parameters: {}, idempotency_key: nextKey("k3c-h") });
    const thrownResult = await g.execute({ identity, tool_id: "fin2-k3-thrown", action: "mutate", parameters: {}, idempotency_key: nextKey("k3c-t") });
    expect(hungResult.ok).toBe(true);
    expect(thrownResult.ok).toBe(true);
    expect(hung.mutations).toBe(1);
    expect(thrown.mutations).toBe(1);
    expect(hung.readSignals[0]!.aborted).toBe(true);
  }, 8_000);

  it("re-arm av en feilet rad (replay-peeken så `reserved`): hengende re-validering = avslag `preflight_failed:tool_timeout`, reservasjonen frigis til `failed`, ingen mutasjon", async () => {
    const t = new ScriptTransport();
    t.hangReads.add(2); // 1. lesing = vanlig preflight (ok); 2. lesing = re-valideringen etter re-arm (henger)
    const g = gw();
    g.register(def({ preflight_validator: () => null }, t));
    const target = g as unknown as { peekLedgerStatus: (tenantId: string, key: string) => Promise<string | null> };
    const original = target.peekLedgerStatus.bind(g);
    target.peekLedgerStatus = async (tenantId, key) => { // samtidig kall feiler MELLOM peek og ledger-port: peeken svarer `reserved`, raden settes så til `failed`
      const status = await original(tenantId, key);
      await adminPool.query("UPDATE tool_executions SET status = 'failed' WHERE idempotency_key = $1", [key]);
      return status;
    };
    const key = nextKey("k3r");
    await adminPool.query("INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, before_state) VALUES ('tenant-fin2k3', $1, 'fin2-k3', 'mutate', 'reserved', '{}'::jsonb)", [key]);
    expect(await exec(g, key)).toEqual({ ok: false, reason: "preflight_failed:tool_timeout" });
    expect(t.mutations).toBe(0);
    expect(await row(key)).toEqual({ status: "failed", postcondition_reason: "rearm_preflight_failed:tool_timeout" });
    expect(t.readSignals[1]!.aborted).toBe(true);
  }, 8_000);

  it("en rask preflight påvirkes ikke: signalet er IKKE avbrutt etter suksess, og kallet går gjennom som før", async () => {
    const t = new ScriptTransport();
    const g = gw();
    g.register(def({}, t));
    expect((await exec(g, nextKey("k3ok"))).ok).toBe(true);
    expect(t.mutations).toBe(1);
    expect(t.readSignals[0]).toBeInstanceOf(AbortSignal);
    expect(t.readSignals[0]!.aborted).toBe(false);
  });
});

describe("K3: JARVIS_TOOL_CALL_ABORT=off gir som før (ingen frist og intet signal på preflight)", () => {
  it("PÅ: en treg (250 ms) preflight med 100 ms frist avslås; AV: samme preflight får fullføre uten signal og mutasjonen kjører", async () => {
    const slow = (): ScriptTransport => { const t = new ScriptTransport(); t.slowReads.set(1, 250); return t; };

    const on = slow();
    const gOn = gw();
    gOn.register(def({ timeout_ms: 100 }, on));
    expect(await exec(gOn, nextKey("k3-on"))).toEqual({ ok: false, reason: "preflight_failed:tool_timeout" });
    expect(on.mutations).toBe(0);

    vi.stubEnv("JARVIS_TOOL_CALL_ABORT", "off");
    const off = slow();
    const gOff = gw();
    gOff.register(def({ timeout_ms: 100 }, off));
    expect((await exec(gOff, nextKey("k3-off"))).ok).toBe(true);
    expect(off.mutations).toBe(1);
    expect(off.readSignals[0]).toBeUndefined(); // som før: ingen signal
  }, 10_000);
});

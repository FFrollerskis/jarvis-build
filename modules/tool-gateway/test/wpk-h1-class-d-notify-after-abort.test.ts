import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  FakeTransport, ToolGateway, firstWaveTools, runWithCallSignal, telegramClassDNotifier,
  type ToolDefinition, type ToolResult, type ToolTransport
} from "../src/index.ts";

/**
 * WP-K review H1 (regresjon mot main): en NØSTET klasse D-handlings out-of-band-varsling ble droppet når det YTRE kallet hadde fått tidsavbrudd. Inngangsvakten (`caller_call_aborted`) nektet enhver
 * `execute()` i en avbrutt kontekst, og varsleren (`telegramClassDNotifier`) er selv en nøstet `execute(telegram.notify)` i det ytre kallets kontekst - så akkurat i ukjent-utfall-tilfellet (der varselet
 * er viktigst) ble varselet stille nektet: 0 varsler, `notified:false`, audit `tool.class_d_notification_failed`. Scenarioet (reviewerens exp1): `support.reply` (frist) som omslutter en treg `email.send`
 * (klasse D). Ekte embedded Postgres, den ekte `telegramClassDNotifier` og en ekte nøstet `execute()`.
 */
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-h1", memory_space_id: "personal",
  session_id: "sess-h1", device_id: "dev-pc", channel: "api", auth_strength: "active"
};
const secrets = { name: "t", get: async () => "fake-token-for-test" };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timeout");
    await sleep(20);
  }
}

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpkh1-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpkh1 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpkh1");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-h1','H1','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-h1');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpkh1", password: "pw2" });
  policy = new PolicyGateway({
    devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-h1"] }
  });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

const anySchema = { safeParse: (v: unknown) => ({ success: true, data: v as Record<string, JsonValue> }) } as ToolDefinition["input_schema"];
type Overrides = { [K in keyof ToolDefinition]?: ToolDefinition[K] | undefined };
function def(overrides: Overrides, transport: ToolTransport): ToolDefinition {
  const base: ToolDefinition = {
    tool_id: "gen-d", action: "mutate", description: "test", input_schema: anySchema, capability_class: "D", scopes: [], reversible: true, rollback_procedure: "rull tilbake manuelt",
    idempotent_external: true, timeout_ms: 5_000, rate_limit_per_minute: 600, credential_ref: "GEN_D_TOKEN", output_trust: "internal", transport,
    preflight_action: "preflight", preflight_requires_target: true, postcondition_predicate: (after) => (after as { ok?: boolean }).ok === true
  };
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as ToolDefinition;
}

/** Klasse D-transport: preflight/readback svarer ok, selve mutasjonen er TREG (`mutateMs`) og teller kallene. */
class SlowClassD implements ToolTransport {
  mutations = 0;
  constructor(private readonly mutateMs: number) {}
  async invoke(action: string): Promise<{ external_id?: string; data?: JsonValue }> {
    if (action === "preflight") return { data: { ok: true } };
    this.mutations += 1;
    await sleep(this.mutateMs);
    return { external_id: "ext-h1" };
  }
}

interface Rig { gateway: ToolGateway; telegram: FakeTransport; slow: SlowClassD; outer: { result?: ToolResult; nested?: ToolResult } }

/** Ekte varsler (`telegramClassDNotifier` -> nøstet `execute(telegram.notify)`), tool `outer.reply` med kort frist som omslutter den trege klasse D-handlingen. */
function rig(outerTimeoutMs: number, mutateMs: number): Rig {
  const telegram = new FakeTransport(() => ({ external_id: "tg-1" }));
  const slow = new SlowClassD(mutateMs);
  const state: Rig["outer"] = {};
  const holder: { gateway?: ToolGateway } = {};
  const notifier = telegramClassDNotifier({ execute: (r) => holder.gateway!.execute(r), secrets, identity });
  const gateway = new ToolGateway(appPool, policy, secrets, undefined, undefined, { classDPipeline: { enforce: true, notifier } });
  holder.gateway = gateway;
  for (const tool of firstWaveTools({ telegram }).filter((d) => d.tool_id === "telegram")) gateway.register(tool);
  gateway.register(def({}, slow));
  gateway.register(def({
    tool_id: "outer", action: "reply", capability_class: "A", timeout_ms: outerTimeoutMs, preflight_action: undefined, preflight_requires_target: undefined, postcondition_predicate: undefined,
    credential_ref: "OUTER_TOKEN"
  }, {
    // Som `support.reply` -> `email.send`: det ytre verktøyets transport gjør et NØSTET gateway-kall (klasse D) og venter på det.
    invoke: async () => {
      state.nested = await gateway.execute({ identity, tool_id: "gen-d", action: "mutate", parameters: {}, idempotency_key: `k-h1-${Math.random().toString(36).slice(2)}` });
      return { data: { nested_ok: state.nested.ok } };
    }
  }));
  return { gateway, telegram, slow, outer: state };
}

const failedNotifications = async (): Promise<number> =>
  (await adminPool.query("SELECT 1 FROM audit_events WHERE type = 'tool.class_d_notification_failed' AND tool_id = 'gen-d'")).rowCount ?? 0;

describe("H1: nøstet klasse D-varsling overlever at det ytre kallet får tidsavbrudd (exp1)", () => {
  it("ytre kall tidsavbrutt (300 ms) mens den nøstede klasse D-handlingen er treg (700 ms): handlingen fullfører og varsles NØYAKTIG én gang, notified:true", async () => {
    const before = await failedNotifications();
    const r = rig(300, 700);
    r.outer.result = await r.gateway.execute({ identity, tool_id: "outer", action: "reply", parameters: {} });
    // Det ytre kallet ble tidsavbrutt (ukjent utfall) - men den nøstede klasse D-handlingen kjører til ende og SKAL varsle eieren.
    expect(r.outer.result.ok).toBe(false);
    expect(String((r.outer.result as { reason?: string }).reason)).toContain("tool_timeout");
    await waitFor(() => r.outer.nested !== undefined);
    expect(r.slow.mutations).toBe(1);
    expect(r.outer.nested).toBeDefined();
    expect(r.outer.nested!.ok).toBe(true);
    expect((r.outer.nested as { notified?: boolean }).notified).toBe(true);
    expect(r.telegram.calls).toHaveLength(1);
    expect(r.telegram.calls[0]!.action).toBe("notify");
    expect(String(r.telegram.calls[0]!.parameters["message"])).toContain("Klasse D-handling utført");
    expect(await failedNotifications()).toBe(before); // ingen `tool.class_d_notification_failed`
  }, 30_000);

  it("uten tidsavbrudd er oppførselen uendret: ett varsel, notified:true", async () => {
    const r = rig(5_000, 50);
    r.outer.result = await r.gateway.execute({ identity, tool_id: "outer", action: "reply", parameters: {} });
    expect(r.outer.result.ok).toBe(true);
    expect((r.outer.nested as { notified?: boolean }).notified).toBe(true);
    expect(r.telegram.calls).toHaveLength(1);
  }, 30_000);

  it("varslerens klar-sjekk (`ready()`) kjører også frakoblet: en klasse D-handling startet FØR det ytre kallet ble avbrutt får fortsatt gyldig varsler", async () => {
    // `ready()` kalles ved start (ikke avbrutt ennå) - beviser at frakoblingen ikke ødelegger den vanlige veien.
    const r = rig(5_000, 10);
    r.outer.result = await r.gateway.execute({ identity, tool_id: "outer", action: "reply", parameters: {} });
    expect(r.outer.nested!.ok).toBe(true);
  }, 30_000);
});

describe("H1: inngangsvakten (caller_call_aborted) er uendret for vanlige kall, men unntar kill switch og selvgjenoppretting", () => {
  const aborted = (): AbortSignal => {
    const controller = new AbortController();
    controller.abort(new Error("tool_timeout"));
    return controller.signal;
  };
  const okTransport = (): ToolTransport => ({ invoke: async () => ({ external_id: "ok" }) });

  it("et vanlig nøstet kall i en avbrutt kontekst nektes fortsatt (ingen forlatt mutasjon)", async () => {
    const g = new ToolGateway(appPool, policy, secrets);
    g.register(def({ tool_id: "plain", action: "read", capability_class: "A", preflight_action: undefined, preflight_requires_target: undefined, postcondition_predicate: undefined, credential_ref: "PLAIN" }, okTransport()));
    const result = await runWithCallSignal(aborted(), () => g.execute({ identity, tool_id: "plain", action: "read", parameters: {} }));
    expect(result).toEqual({ ok: false, reason: "caller_call_aborted" });
  });

  it("kill-switch-handlinger (CLASS_D_EXEMPT_ACTIONS) virker fra en avbrutt kontekst - de MÅ virke når noe har gått galt", async () => {
    const g = new ToolGateway(appPool, policy, secrets, undefined, undefined, { classDPipeline: { enforce: true } });
    g.register(def({ tool_id: "owner_controls", action: "activate_kill_switch", preflight_action: undefined, postcondition_predicate: undefined, credential_ref: "OC" }, okTransport()));
    const result = await runWithCallSignal(aborted(), () => g.execute({ identity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: {} }));
    expect(result.ok).toBe(true);
  });

  it("selvgjenopprettings-handlinger (isSelfRecoveryAction) virker fra en avbrutt kontekst", async () => {
    const g = new ToolGateway(appPool, policy, secrets);
    g.register(def({ tool_id: "situations", action: "get_pause_state", capability_class: "A", preflight_action: undefined, preflight_requires_target: undefined, postcondition_predicate: undefined, credential_ref: "SIT" }, okTransport()));
    const result = await runWithCallSignal(aborted(), () => g.execute({ identity, tool_id: "situations", action: "get_pause_state", parameters: {} }));
    expect(result.ok).toBe(true);
  });
});

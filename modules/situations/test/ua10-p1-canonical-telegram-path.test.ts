import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { BUSINESS_INTERNAL_CREDENTIAL_REF, BusinessInternalSecretProvider, OpenLoopService } from "@jarvis/business";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  EnvSecretProvider, FallbackSecretProvider, TelegramTransport, ToolGateway, firstWaveTools, type ToolTransport
} from "@jarvis/tool-gateway";
import { DomainPauseRegistry } from "../src/domain-pause.ts";
import { computeInformNotifyKey, SituationEngine } from "../src/service.ts";
import { runSituationSweep } from "../src/sweep.ts";
import type { Situation } from "../src/types.ts";

/**
 * REGRESJONSVAKT for HOST-FUNN run_id `2105bb7d` (D-160 I, 2026-09-17):
 *
 * Hele PRODUKSJONSKJEDEN for varsling, uten testdobler i kjeden:
 *   runSituationSweep -> SituationEngine.deliverPendingInformNotifications /
 *   actOn -> ToolGateway (EKTE) -> PolicyGateway (EKTE) ->
 *   FallbackSecretProvider(EnvSecretProvider, BusinessInternalSecretProvider)
 *   (PRODUKSJONENS kjede, main.ts) -> KANONISK `telegram.notify` fra
 *   firstWaveTools() -> EKTE TelegramTransport -> `fetch`
 *   (https://api.telegram.org/bot<token>/sendMessage) -> tool_executions ->
 *   inform_delivered_at / stage=act_notify.
 *
 * KUN `globalThis.fetch` er erstattet (ingen nettverk i CI), og den VERIFISERER
 * den faktiske URL-en/body-en: credential i URL-stien, `chat_id` fra
 * JARVIS_TELEGRAM_CHAT_ID (samme default-konstruktør som main.ts), `text` =
 * den frosne meldingsteksten. En URL uten gyldig token svarer 404 - nøyaktig
 * som Telegram gjør for `botundefined`.
 *
 * Host-feilen: akseptanse-wrapperen droppet `credential`-argumentet til
 * `TelegramTransport.invoke` -> `botundefined` -> 404 -> `tool.failed` ->
 * `pending=1`, `errors=[]`, ingen tool_executions-rad, stage forblir `act`.
 * Denne filen beviser (1) at den kanoniske stien leverer INFORM og ACT med
 * credential intakt, og (2) at nøyaktig host-symptomet oppstår hvis noen
 * igjen dropper credential foran transporten.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;
let engine: SituationEngine;
let domainPauses: DomainPauseRegistry;
let openLoops: OpenLoopService;

const TENANT = "tenant-sit-canonical-tg";
const OWNER = "person-tobias-canonical-tg";
const TOKEN = "test-telegram-token-canonical-path";
const CHAT_ID = "chat-canonical-42";

const ownerIdentity: IdentityContext = {
  person_id: OWNER, tenant_id: TENANT, memory_space_id: "business",
  session_id: "sess-canonical-tg", device_id: "jarvis-core", channel: "api", auth_strength: "active"
};
const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

/** Fanger HVER Telegram-HTTP-forespørsel; svarer 200 KUN når token-stien er riktig - ellers 404 (som Telegram for `botundefined`). */
const fetchCalls: Array<{ url: string; body: { chat_id: string; text: string } }> = [];
const originalFetch = globalThis.fetch;
const originalToken = process.env["JARVIS_TELEGRAM_TOKEN"];
const originalChatId = process.env["JARVIS_TELEGRAM_CHAT_ID"];

class FakeActuatorTransport implements ToolTransport {
  calls: string[] = [];
  private done = false;
  async invoke(action: string): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push(action);
    if (action === "read_state") return { data: { done: this.done } };
    if (action === "assign") {
      this.done = true;
      return { external_id: "assign-1", data: { done: true } };
    }
    throw new Error(`unknown_action:${action}`);
  }
}

/**
 * NØYAKTIG den gamle host-wrapperens feil: dropper credential/context foran transporten.
 * TypeScript AVVISER dette kallet (TS2554: 4 argumenter forventet) - feilen slapp
 * gjennom fordi `modules/situations/scripts/` sto utenfor tsconfig-`include` og aldri
 * ble typesjekket (rettet i samme runde: `scripts` er nå med). Cast-en under finnes
 * KUN for å gjenskape host-symptomet i en test.
 */
class CredentialDroppingWrapper implements ToolTransport {
  constructor(private readonly inner: ToolTransport) {}
  async invoke(action: string, parameters: Record<string, JsonValue>): ReturnType<ToolTransport["invoke"]> {
    const twoArgInvoke = this.inner.invoke as unknown as (a: string, p: Record<string, JsonValue>) => ReturnType<ToolTransport["invoke"]>;
    return twoArgInvoke.call(this.inner, action, parameters);
  }
}

let loopSeq = 0;
/** `audit_events` er append-only (trigger) - hver test avgrenser sine audit-spørringer til rader skrevet etter sin egen start. */
let testStartedAt = new Date(0);
async function seedHighPriorityLoop(): Promise<string> {
  loopSeq += 1;
  const id = `ol-${TENANT}-${loopSeq}`;
  await adminPool.query(
    `INSERT INTO business_open_loops (open_loop_id, tenant_id, memory_space_id, loop_type, detection_key, reason, priority, confidence, next_action, status)
     VALUES ($1, $2, 'business', 'overdue_followup', $3, $4, 'high', 0.95, NULL, 'open')`,
    [id, TENANT, `followup:${loopSeq}`, `Oppfølging ${loopSeq} er forfalt`]
  );
  return id;
}

function buildGateway(telegramTransport: ToolTransport, actuator: FakeActuatorTransport): ToolGateway {
  // PRODUKSJONENS secret-kjede (main.ts) - EnvSecretProvider løser JARVIS_TELEGRAM_TOKEN fra env.
  const gateway = new ToolGateway(appPool, policy, new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()));
  // KANONISK definisjon - ikke en parallell kopi.
  for (const tool of firstWaveTools({ telegram: telegramTransport }).filter((t) => t.tool_id === "telegram" && t.action === "notify")) gateway.register(tool);
  gateway.register({
    tool_id: "test_actuator", action: "assign", description: "test", input_schema: record({ open_loop_id: z.string(), assignee: z.string() }),
    capability_class: "D", scopes: [], reversible: true, rollback_procedure: "unassign",
    idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000,
    credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF, output_trust: "internal", transport: actuator,
    preflight_action: "read_state",
    postcondition_predicate: (after) => (after as { done: boolean } | null)?.done === true
  });
  return gateway;
}

const sweep = (gateway: ToolGateway) => runSituationSweep(TENANT, "business", { openLoops, engine, gateway, identity: ownerIdentity });
const situations = (): Promise<Situation[]> => engine.getQueue(TENANT, "business", { statusOpenOnly: false });

beforeAll(async () => {
  process.env["JARVIS_TELEGRAM_TOKEN"] = TOKEN;
  process.env["JARVIS_TELEGRAM_CHAT_ID"] = CHAT_ID;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id: string; text: string };
    fetchCalls.push({ url, body });
    if (!url.startsWith(`https://api.telegram.org/bot${TOKEN}/sendMessage`)) return new Response("Not Found", { status: 404 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: fetchCalls.length } }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-sit-canonical-tg-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leased.postgres;
  PORT = leased.port;
  stopEmbeddedPostgres = leased.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_sit_canonical_tg_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sit_canonical_tg_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Canonical TG','business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sit_canonical_tg_test", password: "pw2" });
  policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new PgApprovalStore(appPool),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT] }
  });
  domainPauses = new DomainPauseRegistry(appPool, { owner_person_id: OWNER });
  await domainPauses.restore();
  engine = new SituationEngine(appPool, domainPauses, { owner_person_id: OWNER });
  openLoops = new OpenLoopService(appPool);
}, 240_000);

beforeEach(async () => {
  fetchCalls.length = 0;
  await adminPool.query(`DELETE FROM situations WHERE tenant_id = '${TENANT}'`);
  await adminPool.query(`DELETE FROM situation_autonomy_policies WHERE tenant_id = '${TENANT}'`);
  await adminPool.query(`DELETE FROM business_open_loops WHERE tenant_id = '${TENANT}'`);
  await adminPool.query(`DELETE FROM tool_executions WHERE tenant_id = '${TENANT}'`);
  testStartedAt = new Date((await adminPool.query("SELECT now() AS t")).rows[0].t as Date);
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env["JARVIS_TELEGRAM_TOKEN"]; else process.env["JARVIS_TELEGRAM_TOKEN"] = originalToken;
  if (originalChatId === undefined) delete process.env["JARVIS_TELEGRAM_CHAT_ID"]; else process.env["JARVIS_TELEGRAM_CHAT_ID"] = originalChatId;
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
});

describe("KANONISK STI: INFORM + ACT når EKTE TelegramTransport med credential i URL, chat_id fra env, frossen tekst", () => {
  it("INFORM: nøyaktig én sendMessage med bot<token>/chat_id/text, evidens (tool_executions succeeded + external_id), inform_delivered_at bokført; replay = 0 nye sends", async () => {
    const actuator = new FakeActuatorTransport();
    const gateway = buildGateway(new TelegramTransport(), actuator); // default-konstruktør = main.ts (chat_id fra env)
    await seedHighPriorityLoop();

    const r = await sweep(gateway);
    expect(r.errors).toEqual([]);
    expect(r.delivery).toMatchObject({ delivered: 1, pending: 0, evidence_mismatch: 0 });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(fetchCalls[0]!.body.chat_id).toBe(CHAT_ID);

    const sit = (await situations())[0]!;
    expect(sit.inform_message).toBeTruthy();
    expect(fetchCalls[0]!.body.text).toBe(sit.inform_message);
    expect(sit.inform_delivered_at).not.toBeNull();
    expect(sit.last_notified_at).not.toBeNull();
    const key = computeInformNotifyKey(sit.situation_id, new Date(sit.last_notified_at!).toISOString(), sit.inform_message!);
    const { rows } = await adminPool.query(
      `SELECT tool_id, action, status, external_id FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2`, [TENANT, key]
    );
    expect(rows).toEqual([{ tool_id: "telegram", action: "notify", status: "succeeded", external_id: "1" }]);

    const again = await sweep(gateway);
    expect(again.delivery).toMatchObject({ delivered: 0, pending: 0, evidence_mismatch: 0 });
    expect(fetchCalls).toHaveLength(1);
  });

  it("ACT: eier-policy -> actOn -> nøyaktig ÉN ekstra sendMessage (act_notify_message) -> stage=act_notify; replay = ingen nye sends", async () => {
    const actuator = new FakeActuatorTransport();
    const gateway = buildGateway(new TelegramTransport(), actuator);
    const loopId = await seedHighPriorityLoop();
    await engine.setAutonomyPolicy(TENANT, "business", {
      domain: "pipeline", tool_id: "test_actuator", action: "assign",
      parameters: { open_loop_id: "{{source_open_loop_id}}", assignee: OWNER }
    }, OWNER);

    const r = await sweep(gateway);
    expect(r.errors).toEqual([]);
    expect(r.auto_act).toEqual({ attempted: 1, succeeded: 1, denied: 0, skipped: 0 });
    expect(actuator.calls).toEqual(["read_state", "assign", "read_state"]);
    const sit = (await situations())[0]!;
    expect(sit.source_open_loop_id).toBe(loopId);
    expect(sit.stage).toBe("act_notify");
    expect(sit.act_result).toBe("succeeded");
    // INFORM + ACT = nøyaktig to HTTP-kall, begge med credential i URL-stien og eierens chat_id.
    expect(fetchCalls).toHaveLength(2);
    for (const call of fetchCalls) {
      expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
      expect(call.body.chat_id).toBe(CHAT_ID);
    }
    expect(fetchCalls[1]!.body.text).toBe(sit.act_notify_message);

    const again = await sweep(gateway);
    expect(again.auto_act).toEqual({ attempted: 0, succeeded: 0, denied: 0, skipped: 0 });
    expect(fetchCalls).toHaveLength(2);
    expect(actuator.calls).toHaveLength(3);
  });
});

describe("HOST-FUNN 2105bb7d REPRODUSERT: en wrapper som dropper credential foran TelegramTransport gir NØYAKTIG host-symptomet", () => {
  it("botundefined -> 404 -> tool.failed i audit, ingen tool_executions-rad, pending=1, errors=[], stage forblir act (ikke act_notify)", async () => {
    const actuator = new FakeActuatorTransport();
    const gateway = buildGateway(new CredentialDroppingWrapper(new TelegramTransport()), actuator);
    await seedHighPriorityLoop();
    await engine.setAutonomyPolicy(TENANT, "business", {
      domain: "pipeline", tool_id: "test_actuator", action: "assign",
      parameters: { open_loop_id: "{{source_open_loop_id}}", assignee: OWNER }
    }, OWNER);

    const r = await sweep(gateway);
    // Motoren sluker gateway-avslaget: `pending`, INGEN feilstreng - nøyaktig som host-loggen.
    expect(r.errors).toEqual([]);
    expect(r.delivery).toMatchObject({ delivered: 0, pending: 1 });
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(fetchCalls[0]!.url).toBe("https://api.telegram.org/botundefined/sendMessage");
    const sit = (await situations())[0]!;
    expect(sit.inform_delivered_at).toBeNull();
    // ACT selv lyktes (aktuator kjørte), men varselet nådde aldri Telegram => stadiet forblir `act`.
    expect(r.auto_act).toEqual({ attempted: 1, succeeded: 1, denied: 0, skipped: 0 });
    expect(sit.stage).toBe("act");
    expect(sit.act_result).toBe("succeeded");
    const { rows: execs } = await adminPool.query(`SELECT count(*)::int AS n FROM tool_executions WHERE tenant_id = $1 AND tool_id = 'telegram'`, [TENANT]);
    expect((execs[0] as { n: number }).n).toBe(0);
    // Den ENESTE sporbare grunnen i produksjon ligger i audit_events (`tool.failed` / `telegram_error_404`).
    const { rows: audit } = await adminPool.query(
      `SELECT DISTINCT type, decision, reason FROM audit_events WHERE tenant_id = $1 AND tool_id = 'telegram' AND at >= $2 ORDER BY 1`,
      [TENANT, testStartedAt]
    );
    expect(audit).toEqual([{ type: "tool.failed", decision: "DENY", reason: "telegram_error_404" }]);
  });
});

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
import { OpenLoopService } from "@jarvis/business";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { DailyScheduler, ToolGateway, type SecretProvider, type ToolTransport } from "@jarvis/tool-gateway";
import { DomainPauseRegistry, DomainPauseUnauthorizedError } from "../src/domain-pause.ts";
import {
  computeInformNotifyKey,
  SituationAutonomyPlaceholderError,
  SituationAutonomyUnauthorizedError,
  SituationEngine,
  SituationEngineValidationError,
  SituationRecoveryUnauthorizedError
} from "../src/service.ts";
import { assertSituationSweepHealthy, runSituationSweep } from "../src/sweep.ts";
import { SituationsTransport, situationsToolDefinitions } from "../src/transport.ts";
import type { Situation } from "../src/types.ts";
import { TEST_BINDABLE, lookupFrom } from "./support/bindable.ts";

/**
 * UA-10 P1 AKTIVERING (D-160): ende-til-ende-bevis for at motoren er LEVENDE -
 * ekte `business_open_loops`-rader -> ekte `OpenLoopService.listOpenLoops()`
 * -> bro -> `SituationEngine` -> ekte `ToolGateway`/`PolicyGateway` for
 * INFORM/SUGGEST-leveranse og auto-ACT. Mot en EKTE NOSUPERUSER/NOBYPASSRLS-
 * rolle. Hver påstand om "ingen duplikat"/"ingen kall" måles på transport-
 * spionene, aldri antatt.
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

const TENANT_A = "tenant-sit-act-a";
const TENANT_B = "tenant-sit-act-b";
const OWNER = "person-tobias-activation";
const OTHER = "person-other-activation";

const ownerIdentity: IdentityContext = {
  person_id: OWNER, tenant_id: TENANT_A, memory_space_id: "business",
  session_id: "sess-situation-sweep", device_id: "jarvis-core", channel: "api", auth_strength: "active"
};
const tenantBIdentity: IdentityContext = { ...ownerIdentity, tenant_id: TENANT_B, session_id: "sess-b" };

const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };
const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

class TelegramSpyTransport implements ToolTransport {
  calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  failNext = 0;
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("telegram_unavailable");
    }
    this.calls.push({ action, parameters });
    return { external_id: `tg-${this.calls.length}` };
  }
}

/** Stateful aktuator: `read_state` (preflight/readback) + `assign` (mutasjon) - registrerer de RENDREDE parametrene. */
class FakeActuatorTransport implements ToolTransport {
  calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  private done = false;
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push({ action, parameters });
    if (action === "read_state") return { data: { done: this.done } };
    if (action === "assign") {
      this.done = true;
      return { external_id: "assign-1", data: { done: true } };
    }
    throw new Error(`unknown_action:${action}`);
  }
}

let telegram: TelegramSpyTransport;
let actuator: FakeActuatorTransport;
let gateway: ToolGateway;
let loopSeq = 0;

async function seedLoop(
  tenantId: string,
  overrides: Partial<{ loop_type: string; priority: string; confidence: number | null; reason: string; next_action: string | null; status: string; detection_key: string }> = {}
): Promise<string> {
  loopSeq += 1;
  const id = `ol-${tenantId}-${loopSeq}`;
  const v = {
    loop_type: "overdue_followup", priority: "normal", confidence: null, reason: `Oppfølging ${loopSeq} er forfalt`,
    next_action: null, status: "open", detection_key: `followup:${loopSeq}`, ...overrides
  };
  await adminPool.query(
    `INSERT INTO business_open_loops (open_loop_id, tenant_id, memory_space_id, loop_type, detection_key, reason, priority, confidence, next_action, status)
     VALUES ($1, $2, 'business', $3, $4, $5, $6, $7, $8, $9)`,
    [id, tenantId, v.loop_type, v.detection_key, v.reason, v.priority, v.confidence, v.next_action, v.status]
  );
  return id;
}

const sweep = (tenantId = TENANT_A, identity = ownerIdentity, now?: () => number) =>
  runSituationSweep(tenantId, "business", { openLoops, engine, gateway, identity, ...(now ? { now } : {}) });

async function situationsOf(tenantId: string): Promise<Situation[]> {
  return engine.getQueue(tenantId, "business", { statusOpenOnly: false });
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-sit-activation-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_sit_activation_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sit_activation_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Activation A','business'), ('${TENANT_B}','Activation B','business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias'), ('${OTHER}','Other');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT_A}'), ('${OWNER}','${TENANT_B}'), ('${OTHER}','${TENANT_A}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sit_activation_test", password: "pw2" });

  policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new PgApprovalStore(appPool),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A, TENANT_B] }
  });
  domainPauses = new DomainPauseRegistry(appPool, { owner_person_id: OWNER });
  await domainPauses.restore();
  // WP-G4b K1: bind-tid-oppslaget mot testens gateway (som `toolGateway.get` i produksjon).
  engine = new SituationEngine(appPool, domainPauses, { owner_person_id: OWNER }, { definitionLookup: lookupFrom(() => gateway) });
  openLoops = new OpenLoopService(appPool);
}, 240_000);

beforeEach(async () => {
  telegram = new TelegramSpyTransport();
  actuator = new FakeActuatorTransport();
  gateway = new ToolGateway(appPool, policy, secrets);
  gateway.register({
    tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }),
    capability_class: "B", scopes: [], reversible: true, rollback_procedure: "send correction",
    idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000,
    credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: telegram, autonomy_bindable: TEST_BINDABLE
  });
  gateway.register({
    tool_id: "test_actuator", action: "assign", description: "test", input_schema: record({ open_loop_id: z.string(), assignee: z.string() }),
    capability_class: "D", scopes: [], reversible: true, rollback_procedure: "unassign",
    idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000,
    credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: actuator,
    preflight_action: "read_state",
    postcondition_predicate: (after) => (after as { done: boolean } | null)?.done === true,
    autonomy_bindable: TEST_BINDABLE
  });
  for (const tool of situationsToolDefinitions(new SituationsTransport(engine, domainPauses))) gateway.register(tool);
  // Ren tilstand per test: kun DENNE testfilens tenants røres.
  await adminPool.query(`DELETE FROM situations WHERE tenant_id IN ('${TENANT_A}','${TENANT_B}')`);
  await adminPool.query(`DELETE FROM situation_autonomy_policies WHERE tenant_id IN ('${TENANT_A}','${TENANT_B}')`);
  await adminPool.query(`DELETE FROM situation_notification_policies WHERE tenant_id IN ('${TENANT_A}','${TENANT_B}')`);
  await adminPool.query(`DELETE FROM business_open_loops WHERE tenant_id IN ('${TENANT_A}','${TENANT_B}')`);
  await adminPool.query(`DELETE FROM tool_executions WHERE tenant_id IN ('${TENANT_A}','${TENANT_B}')`);
  await adminPool.query(`DELETE FROM situation_domain_pauses`);
  await domainPauses.restore();
});

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: INGEST - ekte open loops blir situasjoner, idempotent, med kildepeker og riktig domene", () => {
  it("to loops -> to situasjoner (stage etter prioritet), re-sveip oppretter ingen duplikat", async () => {
    const a = await seedLoop(TENANT_A, { loop_type: "overdue_followup", priority: "normal" });
    const b = await seedLoop(TENANT_A, { loop_type: "finance_spend_unexpected", priority: "high", confidence: 0.9, next_action: "Sjekk fakturaen" });

    const first = await sweep();
    expect(first.ingested).toBe(2);
    expect(first.errors).toEqual([]);
    const rows = await situationsOf(TENANT_A);
    expect(rows).toHaveLength(2);
    const sitA = rows.find((r) => r.source_open_loop_id === a)!;
    const sitB = rows.find((r) => r.source_open_loop_id === b)!;
    expect(sitA.domain).toBe("pipeline");
    expect(sitA.stage).toBe("inform");
    expect(sitA.detection_key).toBe("open_loop:followup:1");
    expect(sitB.domain).toBe("spend");
    expect(sitB.stage).toBe("suggest");
    expect(sitB.reason).toContain("Sjekk fakturaen");
    expect(sitB.inform_message).toContain("Jarvis foreslår handling [spend, high]");
    expect(sitB.owner_person_id).toBeNull();

    const second = await sweep();
    expect(second.ingested).toBe(2);
    expect(await situationsOf(TENANT_A)).toHaveLength(2);
  });

  it("tenant-isolasjon: tenant B sine loops blir aldri situasjoner i A, og A sine aldri i B", async () => {
    await seedLoop(TENANT_A);
    await seedLoop(TENANT_B, { detection_key: "followup:b" });
    await sweep(TENANT_A);
    await sweep(TENANT_B, tenantBIdentity);
    const a = await situationsOf(TENANT_A);
    const b = await situationsOf(TENANT_B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.tenant_id).toBe(TENANT_A);
    expect(b[0]!.tenant_id).toBe(TENANT_B);
  });

  it("kildebasert løsning: en løst loop løser situasjonen; en gjenåpnet loop gjenåpner den", async () => {
    const id = await seedLoop(TENANT_A);
    await sweep();
    await adminPool.query(`UPDATE business_open_loops SET status = 'resolved', resolved_at = now() WHERE open_loop_id = $1`, [id]);
    const r = await sweep();
    expect(r.resolved_from_source).toBe(1);
    expect((await situationsOf(TENANT_A))[0]!.status).toBe("resolved");
    await adminPool.query(`UPDATE business_open_loops SET status = 'open', resolved_at = NULL WHERE open_loop_id = $1`, [id]);
    await sweep();
    const rows = await situationsOf(TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("open");
  });
});

describe("B: DELIVER - ett INFORM/SUGGEST-varsel per syklus, evidens-først, aldri duplikat", () => {
  it("første sveip leverer ETT varsel per nylig aktualisert situasjon; andre sveip leverer null", async () => {
    await seedLoop(TENANT_A, { priority: "normal" });
    await seedLoop(TENANT_A, { priority: "low" }); // remember - varsles ikke
    const first = await sweep();
    expect(first.delivery).toEqual({ delivered: 1, reconciled_from_evidence: 0, pending: 0, evidence_mismatch: 0, deferred: 0, paused: 0 });
    expect(telegram.calls).toHaveLength(1);
    expect(String(telegram.calls[0]!.parameters["message"])).toContain("Jarvis oppdaget [pipeline, normal]");
    const [sit] = (await situationsOf(TENANT_A)).filter((s) => s.stage === "inform");
    expect(sit!.inform_delivered_at).not.toBeNull();
    expect(new Date(sit!.inform_delivered_at!).toISOString()).toBe(new Date(sit!.last_notified_at!).toISOString());
    // Beviset ligger under den deterministiske nøkkelen.
    const key = computeInformNotifyKey(sit!.situation_id, new Date(sit!.last_notified_at!).toISOString(), sit!.inform_message!);
    const { rows } = await adminPool.query(`SELECT tool_id, action, status FROM tool_executions WHERE idempotency_key = $1`, [key]);
    expect(rows[0]).toMatchObject({ tool_id: "telegram", action: "notify", status: "succeeded" });

    const second = await sweep();
    expect(second.delivery.delivered).toBe(0);
    expect(telegram.calls).toHaveLength(1);
  });

  it("krasj mellom bekreftet sending og bokføring: neste sveip rekonsilierer fra bevis UTEN nytt transportkall", async () => {
    await seedLoop(TENANT_A);
    await sweep();
    expect(telegram.calls).toHaveLength(1);
    // Simuler krasj: leveransen ble bekreftet (tool_executions) men bokføringen committet aldri.
    await adminPool.query(`UPDATE situations SET inform_delivered_at = NULL WHERE tenant_id = $1`, [TENANT_A]);
    const r = await sweep();
    expect(r.delivery).toEqual({ delivered: 0, reconciled_from_evidence: 1, pending: 0, evidence_mismatch: 0, deferred: 0, paused: 0 });
    expect(telegram.calls).toHaveLength(1);
    expect((await situationsOf(TENANT_A))[0]!.inform_delivered_at).not.toBeNull();
  });

  it("transportfeil: varselet forblir ventende og leveres på neste sveip - fortsatt nøyaktig ETT vellykket kall", async () => {
    await seedLoop(TENANT_A);
    telegram.failNext = 1;
    const r1 = await sweep();
    expect(r1.delivery.pending).toBe(1);
    expect(r1.delivery.delivered).toBe(0);
    expect((await situationsOf(TENANT_A))[0]!.inform_delivered_at).toBeNull();
    const r2 = await sweep();
    expect(r2.delivery.delivered).toBe(1);
    expect(telegram.calls).toHaveLength(1);
    const r3 = await sweep();
    expect(r3.delivery.delivered).toBe(0);
    expect(telegram.calls).toHaveLength(1);
  });

  it("bevis under nøkkelen som IKKE er telegram/notify: fail-closed - ingen kall, ikke bokført", async () => {
    await seedLoop(TENANT_A);
    // Sveip med et gateway UTEN telegram-transport slik at ankeret settes, men ingenting leveres... enklere: kjør ingest via motoren direkte.
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const { mapOpenLoopToCandidate } = await import("../src/open-loop-bridge.ts");
    const { situation } = await engine.evaluateCandidate(TENANT_A, "business", mapOpenLoopToCandidate(loops[0]!));
    const key = computeInformNotifyKey(situation.situation_id, new Date(situation.last_notified_at!).toISOString(), situation.inform_message!);
    await adminPool.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status) VALUES ($1, $2, 'email', 'send', 'succeeded')`,
      [TENANT_A, key]
    );
    const r = await sweep();
    expect(r.delivery).toEqual({ delivered: 0, reconciled_from_evidence: 0, pending: 0, evidence_mismatch: 1, deferred: 0, paused: 0 });
    expect(telegram.calls).toHaveLength(0);
    expect((await situationsOf(TENANT_A))[0]!.inform_delivered_at).toBeNull();
  });

  it("stille timer: ingen situasjon blir aktuell, ingen leveranse", async () => {
    await engine.setNotificationPolicy(TENANT_A, "business", { quiet_hours_start_utc: 0, quiet_hours_end_utc: 23, actor_person_id: OWNER });
    await seedLoop(TENANT_A, { priority: "high", confidence: 0.99 });
    const r = await sweep(TENANT_A, ownerIdentity, () => Date.UTC(2026, 8, 16, 12, 0, 0));
    expect(r.ingested).toBe(1);
    expect(r.delivery.delivered).toBe(0);
    expect(telegram.calls).toHaveLength(0);
    expect((await situationsOf(TENANT_A))[0]!.stage).toBe("remember");
  });

  it("re-suppress-vinduet åpner: NY syklus = nytt anker + ny frosset tekst = ETT nytt varsel (aldri ett per sveip)", async () => {
    await engine.setNotificationPolicy(TENANT_A, "business", { resuppress_hours: 1, actor_person_id: OWNER });
    const id = await seedLoop(TENANT_A, { reason: "Første grunn" });
    const t0 = Date.UTC(2026, 8, 16, 8, 0, 0);
    await sweep(TENANT_A, ownerIdentity, () => t0);
    expect(telegram.calls).toHaveLength(1);
    await sweep(TENANT_A, ownerIdentity, () => t0 + 30 * 60_000);
    expect(telegram.calls).toHaveLength(1);
    await adminPool.query(`UPDATE business_open_loops SET reason = 'Andre grunn' WHERE open_loop_id = $1`, [id]);
    await sweep(TENANT_A, ownerIdentity, () => t0 + 2 * 3_600_000);
    expect(telegram.calls).toHaveLength(2);
    expect(String(telegram.calls[1]!.parameters["message"])).toContain("Andre grunn");
    await sweep(TENANT_A, ownerIdentity, () => t0 + 2 * 3_600_000 + 60_000);
    expect(telegram.calls).toHaveLength(2);
  });
});

describe("C: AUTO-ACT - ingenting uten eier-policy; med policy nøyaktig én ACT gjennom hele ToolGateway-pipelinen", () => {
  it("uten policy: en 'suggest'-situasjon utløser INGEN handling", async () => {
    await seedLoop(TENANT_A, { priority: "high", confidence: 0.95 });
    const r = await sweep();
    expect((await situationsOf(TENANT_A))[0]!.stage).toBe("suggest");
    expect(r.auto_act).toEqual({ attempted: 0, succeeded: 0, denied: 0, skipped: 0 });
    expect(actuator.calls).toHaveLength(0);
  });

  it("med eier-policy: ETT actOn med RENDREDE plassholdere -> act_notify, preflight/mutasjon/readback, ETT ACT-varsel; neste sveip gjør ingenting", async () => {
    const loopId = await seedLoop(TENANT_A, { priority: "high", confidence: 0.95 });
    await engine.setAutonomyPolicy(TENANT_A, "business", {
      domain: "pipeline", tool_id: "test_actuator", action: "assign",
      parameters: { open_loop_id: "{{source_open_loop_id}}", assignee: OWNER }
    }, OWNER);

    const r = await sweep();
    expect(r.auto_act).toEqual({ attempted: 1, succeeded: 1, denied: 0, skipped: 0 });
    expect(actuator.calls.map((c) => c.action)).toEqual(["read_state", "assign", "read_state"]);
    expect(actuator.calls[1]!.parameters).toEqual({ open_loop_id: loopId, assignee: OWNER });
    const sit = (await situationsOf(TENANT_A))[0]!;
    expect(sit.stage).toBe("act_notify");
    expect(sit.act_result).toBe("succeeded");
    // INFORM-varselet (syklusens) + ACT-varselet = nøyaktig to Telegram-kall, ikke flere.
    expect(telegram.calls).toHaveLength(2);

    const again = await sweep();
    expect(again.auto_act).toEqual({ attempted: 0, succeeded: 0, denied: 0, skipped: 0 });
    expect(actuator.calls).toHaveLength(3);
    expect(telegram.calls).toHaveLength(2);
  });

  it("domene-pause vinner over policy: pauset domene => skipped, ingen transportkall; opphevet pause => handlingen kjøres", async () => {
    await seedLoop(TENANT_A, { priority: "high", confidence: 0.95 });
    await engine.setAutonomyPolicy(TENANT_A, "business", {
      domain: "pipeline", tool_id: "test_actuator", action: "assign", parameters: { open_loop_id: "{{source_open_loop_id}}", assignee: OWNER }
    }, OWNER);
    await domainPauses.pauseDurable("pipeline", "eier pauset", OWNER);
    const paused = await sweep();
    expect(paused.auto_act).toEqual({ attempted: 0, succeeded: 0, denied: 0, skipped: 1 });
    expect(actuator.calls).toHaveLength(0);
    await domainPauses.unpauseDurable("pipeline", OWNER);
    const resumed = await sweep();
    expect(resumed.auto_act.succeeded).toBe(1);
  });

  it("policy uten verdi for en brukt plassholder (kildeløs situasjon) => skipped, aldri et kall med tom streng", async () => {
    await engine.evaluateCandidate(TENANT_A, "business", { domain: "pipeline", detection_key: "manual:1", priority: "high", confidence: 0.95, reason: "Manuell" });
    await engine.setAutonomyPolicy(TENANT_A, "business", {
      domain: "pipeline", tool_id: "test_actuator", action: "assign", parameters: { open_loop_id: "{{source_open_loop_id}}", assignee: OWNER }
    }, OWNER);
    const r = await sweep();
    expect(r.auto_act).toEqual({ attempted: 0, succeeded: 0, denied: 0, skipped: 1 });
    expect(actuator.calls).toHaveLength(0);
  });

  it("policy-autoritet: ikke-eier avvises, uten autoritet avvises, '*'-domene avvises, ukjent plassholder avvises ved binding", async () => {
    const input = { domain: "pipeline", tool_id: "test_actuator", action: "assign", parameters: {} };
    await expect(engine.setAutonomyPolicy(TENANT_A, "business", input, OTHER)).rejects.toBeInstanceOf(SituationAutonomyUnauthorizedError);
    await expect(engine.setAutonomyPolicy(TENANT_A, "business", input, undefined)).rejects.toBeInstanceOf(SituationAutonomyUnauthorizedError);
    const noAuthority = new SituationEngine(appPool, domainPauses);
    await expect(noAuthority.setAutonomyPolicy(TENANT_A, "business", input, OWNER)).rejects.toBeInstanceOf(SituationAutonomyUnauthorizedError);
    await expect(engine.setAutonomyPolicy(TENANT_A, "business", { ...input, domain: "*" }, OWNER)).rejects.toBeInstanceOf(SituationEngineValidationError);
    await expect(
      engine.setAutonomyPolicy(TENANT_A, "business", { ...input, parameters: { x: "{{reason}}" } }, OWNER)
    ).rejects.toBeInstanceOf(SituationAutonomyPlaceholderError);
    expect(await engine.listAutonomyPolicies(TENANT_A, "business")).toEqual([]);
  });

  it("policy er tenant-isolert (RLS): tenant A sin policy utløser aldri en handling i tenant B", async () => {
    await engine.setAutonomyPolicy(TENANT_A, "business", {
      domain: "pipeline", tool_id: "test_actuator", action: "assign", parameters: { open_loop_id: "{{source_open_loop_id}}", assignee: OWNER }
    }, OWNER);
    await seedLoop(TENANT_B, { priority: "high", confidence: 0.95, detection_key: "followup:b-high" });
    const r = await sweep(TENANT_B, tenantBIdentity);
    expect(r.auto_act.attempted).toBe(0);
    expect(actuator.calls).toHaveLength(0);
    expect(await engine.listAutonomyPolicies(TENANT_B, "business")).toEqual([]);
  });

  it("clearAutonomyPolicy fjerner bindingen; disabled policy utløser ingenting", async () => {
    await seedLoop(TENANT_A, { priority: "high", confidence: 0.95 });
    await engine.setAutonomyPolicy(TENANT_A, "business", {
      domain: "pipeline", tool_id: "test_actuator", action: "assign", parameters: { open_loop_id: "{{source_open_loop_id}}", assignee: OWNER }, enabled: false
    }, OWNER);
    expect((await sweep()).auto_act.attempted).toBe(0);
    expect(await engine.clearAutonomyPolicy(TENANT_A, "business", "pipeline", OWNER)).toBe(true);
    expect(await engine.clearAutonomyPolicy(TENANT_A, "business", "pipeline", OWNER)).toBe(false);
    await expect(engine.clearAutonomyPolicy(TENANT_A, "business", "pipeline", OTHER)).rejects.toBeInstanceOf(SituationAutonomyUnauthorizedError);
  });
});

describe("D: KONTROLLFLATEN - `situations`-verktøyet gjennom ekte ToolGateway/PolicyGateway, identitet KUN fra invocation-context", () => {
  it("pause_domain via gateway (eier-identitet fra context) blir varig og overlever restore(); ikke-eier-identitet avvises av motoren", async () => {
    const res = await gateway.execute({
      identity: ownerIdentity, tool_id: "situations", action: "pause_domain",
      parameters: { domain: "spend", reason: "eier pauset via verktøy" },
      idempotency_key: "pause-1"
    });
    expect(res.ok).toBe(true);
    const { rows } = await adminPool.query(`SELECT domain, paused_by FROM situation_domain_pauses WHERE domain = 'spend'`);
    expect(rows[0]).toMatchObject({ domain: "spend", paused_by: OWNER });
    // En NY prosess (nytt register) ser pausen etter restore() - fail-closed over omstart.
    const fresh = new DomainPauseRegistry(appPool, { owner_person_id: OWNER });
    await fresh.restore();
    expect(fresh.isPaused("spend")).toBe(true);

    // Ikke-eier i SAMME tenant: den betrodde identiteten er `OTHER`, og motorens egen eier-port avviser.
    const denied = await gateway.execute({
      identity: { ...ownerIdentity, person_id: OTHER, session_id: "sess-other" }, tool_id: "situations", action: "unpause_domain",
      parameters: { domain: "spend" },
      idempotency_key: "unpause-1"
    });
    expect(denied.ok).toBe(false);
    expect(fresh.isPaused("spend")).toBe(true);
    await expect(domainPauses.unpauseDurable("spend", OTHER)).rejects.toBeInstanceOf(DomainPauseUnauthorizedError);
  });

  it("AUTORITETSFORFALSKNING (review 5229219808 funn 2): identitetsfelter i parametrene avvises av skjemaet FØR transporten nås - og transporten selv ignorerer dem", async () => {
    // 1. Gjennom ToolGateway: `actor_person_id`/`tenant_id`/`identity` i parametrene er IKKE i det strenge skjemaet => invalid_parameters, ingen mutasjon.
    for (const parameters of [
      { domain: "spend", reason: "forfalsket", actor_person_id: OWNER },
      { domain: "spend", reason: "forfalsket", tenant_id: TENANT_A },
      { domain: "spend", reason: "forfalsket", identity: { person_id: OWNER } }
    ]) {
      const res = await gateway.execute({
        identity: { ...ownerIdentity, person_id: OTHER, session_id: "sess-forge" }, tool_id: "situations", action: "pause_domain",
        parameters: parameters as Record<string, JsonValue>, idempotency_key: `forge-${JSON.stringify(Object.keys(parameters))}`
      });
      expect(res.ok).toBe(false);
      expect((res as { reason?: string }).reason).toContain("invalid_parameters");
    }
    expect(domainPauses.isPaused("spend")).toBe(false);

    // 2. Direkte mot transporten (uten skjema): en forfalsket `actor_person_id` i parametrene brukes ALDRI - kun context-identiteten teller.
    const transport = new SituationsTransport(engine, domainPauses);
    await expect(
      transport.invoke("pause_domain", { domain: "spend", reason: "forfalsket", actor_person_id: OWNER }, "cred", {
        identity: { ...ownerIdentity, person_id: OTHER }
      })
    ).rejects.toBeInstanceOf(DomainPauseUnauthorizedError);
    await expect(
      transport.invoke("set_autonomy_policy", { domain: "pipeline", tool_id: "t", action: "a", actor_person_id: OWNER }, "cred", {
        identity: { ...ownerIdentity, person_id: OTHER }
      })
    ).rejects.toBeInstanceOf(SituationAutonomyUnauthorizedError);
    // `release_stuck_act_claim` bygger ALDRI en identitet fra parametrene: en forfalsket `identity` ignoreres, context-identiteten (OTHER) avvises.
    await expect(
      transport.invoke("release_stuck_act_claim", { situation_id: "sit-x", identity: { person_id: OWNER, tenant_id: TENANT_A } }, "cred", {
        identity: { ...ownerIdentity, person_id: OTHER }
      })
    ).rejects.toBeInstanceOf(SituationRecoveryUnauthorizedError);
    expect(domainPauses.isPaused("spend")).toBe(false);
    expect(await engine.listAutonomyPolicies(TENANT_A, "business")).toEqual([]);

    // 3. Manglende context feiler lukket - aldri en stille default-identitet.
    await expect(transport.invoke("get_queue", {}, "cred")).rejects.toThrow(/situations_missing_invocation_context/);
    await expect(transport.invoke("pause_all", { reason: "x" }, "cred", undefined)).rejects.toThrow(/situations_missing_invocation_context/);
  });

  it("tenant/space kommer fra context: eierens identitet i tenant B ser aldri tenant A sin kø", async () => {
    await seedLoop(TENANT_A, { priority: "high", confidence: 0.9 });
    await sweep();
    const queueA = await gateway.execute({ identity: ownerIdentity, tool_id: "situations", action: "get_queue", parameters: {} });
    expect(queueA.ok).toBe(true);
    expect(((queueA as { data?: unknown }).data as Situation[])[0]!.stage).toBe("suggest");
    const queueB = await gateway.execute({ identity: tenantBIdentity, tool_id: "situations", action: "get_queue", parameters: {} });
    expect(queueB.ok).toBe(true);
    expect((queueB as { data?: unknown }).data).toEqual([]);
  });

  it("set_autonomy_policy/list_autonomy_policies/clear via gateway - aktør = context-identiteten", async () => {
    const set = await gateway.execute({
      identity: ownerIdentity, tool_id: "situations", action: "set_autonomy_policy",
      parameters: { domain: "pipeline", tool_id: "test_actuator", action: "assign", parameters: { open_loop_id: "{{source_open_loop_id}}", assignee: OWNER } },
      idempotency_key: "policy-1"
    });
    expect(set.ok).toBe(true);
    const [policy] = await engine.listAutonomyPolicies(TENANT_A, "business");
    expect(policy!.actor_person_id).toBe(OWNER);
    const list = await gateway.execute({ identity: ownerIdentity, tool_id: "situations", action: "list_autonomy_policies", parameters: {} });
    expect(((list as { data?: unknown }).data as unknown[]).length).toBe(1);
    const cleared = await gateway.execute({
      identity: ownerIdentity, tool_id: "situations", action: "clear_autonomy_policy",
      parameters: { domain: "pipeline" }, idempotency_key: "policy-clear-1"
    });
    expect(cleared.ok).toBe(true);
    expect(await engine.listAutonomyPolicies(TENANT_A, "business")).toEqual([]);
  });
});

describe("E: SCHEDULER-GRENSEN (review 5229219808 funn 3) - en mislykket sideeffekt bokføres ALDRI som fullført daglig jobb", () => {
  async function runOnce(jobName: string, deliver: () => Promise<void>): Promise<{ claimed: boolean; completed_at: string | null }> {
    const scheduler = new DailyScheduler(appPool, jobName, 0);
    const timer = scheduler.start(deliver, 20);
    try {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const { rows } = await adminPool.query(`SELECT completed_at FROM scheduler_state WHERE job_name = $1`, [jobName]);
        if (rows[0]) {
          // Gi deliver() tid til å avslutte etter claim - vi venter på et stabilt utfall.
          await new Promise((r) => setTimeout(r, 300));
          const { rows: again } = await adminPool.query(`SELECT completed_at FROM scheduler_state WHERE job_name = $1`, [jobName]);
          return { claimed: true, completed_at: again[0]?.completed_at ? new Date(again[0].completed_at as string).toISOString() : null };
        }
        if (Date.now() > deadline) return { claimed: false, completed_at: null };
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      clearInterval(timer);
    }
  }

  it("evidensmismatch i sveipen => assertSituationSweepHealthy kaster => completed_at forblir NULL (ikke fullført)", async () => {
    await seedLoop(TENANT_A);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const { mapOpenLoopToCandidate } = await import("../src/open-loop-bridge.ts");
    const { situation } = await engine.evaluateCandidate(TENANT_A, "business", mapOpenLoopToCandidate(loops[0]!));
    const key = computeInformNotifyKey(situation.situation_id, new Date(situation.last_notified_at!).toISOString(), situation.inform_message!);
    await adminPool.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status) VALUES ($1, $2, 'email', 'send', 'succeeded')`,
      [TENANT_A, key]
    );
    const jobName = `situation-sweep-test-mismatch-${Date.now()}`;
    const outcome = await runOnce(jobName, async () => {
      const result = await sweep();
      expect(result.delivery.evidence_mismatch).toBe(1);
      assertSituationSweepHealthy({ [TENANT_A]: result });
    });
    expect(outcome.claimed).toBe(true);
    expect(outcome.completed_at).toBeNull();
    expect(telegram.calls).toHaveLength(0);
  });

  it("transportfeil (ulevert varsel) => kastet => completed_at NULL; en SUNN kjøring => completed_at satt", async () => {
    await seedLoop(TENANT_A);
    telegram.failNext = 1;
    const failed = await runOnce(`situation-sweep-test-pending-${Date.now()}`, async () => {
      assertSituationSweepHealthy({ [TENANT_A]: await sweep() });
    });
    expect(failed.claimed).toBe(true);
    expect(failed.completed_at).toBeNull();

    const healthy = await runOnce(`situation-sweep-test-healthy-${Date.now()}`, async () => {
      assertSituationSweepHealthy({ [TENANT_A]: await sweep() });
    });
    expect(healthy.claimed).toBe(true);
    expect(healthy.completed_at).not.toBeNull();
    expect(telegram.calls).toHaveLength(1);
  });
});

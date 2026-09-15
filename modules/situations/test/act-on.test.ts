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
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type SecretProvider, type ToolTransport } from "@jarvis/tool-gateway";
import { DomainPauseRegistry } from "../src/domain-pause.ts";
import { SituationDomainPausedError, SituationEngine } from "../src/service.ts";

/**
 * UA-10 akseptansekriterier: "ACT uses valid owner/delegated authority and
 * logs reason/evidence", "D-class actions create immediate post-action
 * notification and recovery context", "Owner can pause a domain ... instantly".
 * `SituationEngine.actOn()` er en RENT KOMPOSISJONS-lag over den ALLEREDE
 * reviewte `ToolGateway.execute()`-pipelinen (Q-34/D-130) - denne filen
 * beviser IKKE den generiske preflight/postcondition/evidence-pipelinen på
 * nytt (bevist andre steder, se `home-assistant-critical-action.test.ts`),
 * den beviser at `actOn()` KOMPONERER den korrekt: domene-pause FØR
 * `execute()`, `escalate` MED avslagsgrunn på `ok:false` (BÅDE nektet OG
 * ubekreftet), `act_notify` + ETT Telegram-varsel KUN på bekreftet suksess.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;
let engine: SituationEngine;
let domainPauses: DomainPauseRegistry;

const TENANT_OWNER = "tenant-sit-act-owner";
const TENANT_UNAUTHORIZED = "tenant-sit-act-unauth";

const ownerIdentity: IdentityContext = {
  person_id: "person-tobias-sit",
  tenant_id: TENANT_OWNER,
  memory_space_id: "business",
  session_id: "sess-sit-act",
  device_id: "dev-pc",
  channel: "api",
  auth_strength: "active"
};

const unauthorizedIdentity: IdentityContext = {
  person_id: "person-nobody",
  tenant_id: TENANT_UNAUTHORIZED,
  memory_space_id: "business",
  session_id: "sess-sit-act-unauth",
  device_id: "dev-pc",
  channel: "api",
  auth_strength: "active"
};

const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };
const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

/** Stateful test-transport: `read_state` (preflight/readback) og `flip` (mutasjon). `mutationEffective:false` simulerer en handling som "lykkes" på transportnivå, men aldri endrer den faktiske tilstanden (Q-34 sin "silent failure"-klasse). */
class FakeActuatorTransport implements ToolTransport {
  calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  private on = false;
  constructor(private readonly mutationEffective = true) {}
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push({ action, parameters });
    if (action === "read_state") return { data: { on: this.on } };
    if (action === "flip") {
      if (this.mutationEffective) this.on = true;
      return { external_id: "act-1", data: { on: this.on } };
    }
    throw new Error(`unknown_action:${action}`);
  }
}

class TelegramSpyTransport implements ToolTransport {
  calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push({ action, parameters });
    return { external_id: "tg-1" };
  }
}

let actuatorOk: FakeActuatorTransport;
let actuatorIneffective: FakeActuatorTransport;
let telegram: TelegramSpyTransport;
let gateway: ToolGateway;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-sit-act-"));
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
  await adminPool.query("CREATE ROLE jarvis_sit_act_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sit_act_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_OWNER}','Sit Act Owner','person'), ('${TENANT_UNAUTHORIZED}','Sit Act Unauth','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias-sit','Tobias'), ('person-nobody','Nobody');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias-sit','${TENANT_OWNER}'), ('person-nobody','${TENANT_UNAUTHORIZED}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sit_act_test", password: "pw2" });

  policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new PgApprovalStore(appPool),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias-sit", owner_tenants: [TENANT_OWNER] }
  });
  domainPauses = new DomainPauseRegistry();
  engine = new SituationEngine(appPool, domainPauses);
}, 240_000);

beforeEach(() => {
  actuatorOk = new FakeActuatorTransport(true);
  actuatorIneffective = new FakeActuatorTransport(false);
  telegram = new TelegramSpyTransport();
  gateway = new ToolGateway(appPool, policy, secrets);
  gateway.register({
    tool_id: "test_actuator", action: "flip", description: "test", input_schema: record({}),
    capability_class: "D", scopes: [], reversible: true, rollback_procedure: "flip back",
    idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
    credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: actuatorOk,
    preflight_action: "read_state",
    postcondition_predicate: (after) => (after as { on: boolean } | null)?.on === true
  });
  gateway.register({
    tool_id: "test_actuator_ineffective", action: "flip", description: "test", input_schema: record({}),
    capability_class: "D", scopes: [], reversible: true, rollback_procedure: "flip back",
    idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
    credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: actuatorIneffective,
    preflight_action: "read_state",
    postcondition_predicate: (after) => (after as { on: boolean } | null)?.on === true
  });
  gateway.register({
    tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }),
    capability_class: "B", scopes: [], reversible: true, rollback_procedure: "send correction",
    idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
    credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: telegram
  });
});

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: vellykket ACT (gyldig eier-autoritet, bekreftet postcondition) - act_notify + ETT Telegram-varsel", () => {
  it("stage blir 'act_notify', act_result='succeeded', telegram kalt EN gang med reason i meldingen", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:1", priority: "high", confidence: 0.9, reason: "Aktuator henger i feil tilstand"
    });

    const result = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {} },
      gateway, ownerIdentity
    );

    expect(result.tool_result.ok).toBe(true);
    expect(result.situation.stage).toBe("act_notify");
    expect(result.situation.act_result).toBe("succeeded");
    expect(result.situation.act_tool_id).toBe("test_actuator");
    expect(result.situation.act_action).toBe("flip");
    expect(telegram.calls).toHaveLength(1);
    expect(String(telegram.calls[0]?.parameters["message"])).toContain("Aktuator henger i feil tilstand");
    // Selve klasse D-bevismaterialet (before/after/recovery) lever i ToolGateway sin EGEN audit-/tool_executions-pipeline - IKKE duplisert her (peker, aldri kopi).
    expect(actuatorOk.calls.map((c) => c.action)).toEqual(["read_state", "flip", "read_state"]); // preflight -> mutasjon -> readback.
  });
});

describe("B: nektet/ubekreftet ACT (ok:false) - escalate MED avslagsgrunn, ALDRI et falskt suksess-varsel", () => {
  it("policy-nektelse (ugyldig eier-autoritet): stage blir 'escalate', act_result='denied', telegram ALDRI kalt, aktuatorens mutasjon ALDRI forsøkt", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_UNAUTHORIZED, "business", {
      domain: "infra", detection_key: "infra:actuator:2", priority: "high", confidence: 0.9, reason: "Uautorisert forsøk"
    });

    const result = await engine.actOn(
      TENANT_UNAUTHORIZED, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {} },
      gateway, unauthorizedIdentity
    );

    expect(result.tool_result.ok).toBe(false);
    expect(result.situation.stage).toBe("escalate");
    expect(result.situation.act_result).toBe("denied");
    expect(result.situation.reason).toContain("act_denied");
    expect(telegram.calls).toHaveLength(0);
    expect(actuatorOk.calls).toHaveLength(0); // policy nektet FØR transporten i det hele tatt ble kalt.
  });

  it("bekreftet postcondition-svikt (handlingen 'lyktes' på transportnivå, men endret aldri tilstanden): escalate, telegram ALDRI kalt", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:3", priority: "high", confidence: 0.9, reason: "Aktuator svarer, men virker ikke"
    });

    const result = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator_ineffective", action: "flip", parameters: {} },
      gateway, ownerIdentity
    );

    expect(result.tool_result.ok).toBe(false);
    expect(result.situation.stage).toBe("escalate");
    expect(result.situation.act_result).toBe("denied");
    expect(telegram.calls).toHaveLength(0);
  });
});

describe("C: domene-pause blokkerer actOn() FØR gateway.execute() i det hele tatt vurderes", () => {
  it("et paused domene kaster SituationDomainPausedError - INGEN transportkall, INGEN tilstandsendring", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:4", priority: "high", confidence: 0.9, reason: "Skal blokkeres av pause"
    });

    domainPauses.pause("infra", "vedlikeholdsvindu");
    try {
      await expect(
        engine.actOn(TENANT_OWNER, "business", situation.situation_id, { tool_id: "test_actuator", action: "flip", parameters: {} }, gateway, ownerIdentity)
      ).rejects.toThrow(SituationDomainPausedError);

      expect(actuatorOk.calls).toHaveLength(0);
      expect(telegram.calls).toHaveLength(0);
      const queue = await engine.getQueue(TENANT_OWNER, "business", { domain: "infra" });
      const stillPending = queue.find((s) => s.situation_id === situation.situation_id);
      expect(stillPending?.stage).not.toBe("act");
      expect(stillPending?.act_result).toBeNull();
    } finally {
      domainPauses.unpause("infra");
    }
  });

  it("pauseAll() blokkerer ETHVERT domene, ikke bare det eksplisitt navngitte", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "spend", detection_key: "spend:actuator:5", priority: "high", confidence: 0.9, reason: "Skal blokkeres av alt-pause"
    });

    domainPauses.pauseAll("owner fryser alt");
    try {
      await expect(
        engine.actOn(TENANT_OWNER, "business", situation.situation_id, { tool_id: "test_actuator", action: "flip", parameters: {} }, gateway, ownerIdentity)
      ).rejects.toThrow(SituationDomainPausedError);
      expect(actuatorOk.calls).toHaveLength(0);
    } finally {
      domainPauses.unpauseAll();
    }
  });

  it("etter unpause() lykkes samme handling normalt (beviser at C ikke bare feiler alt for alltid)", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:6", priority: "high", confidence: 0.9, reason: "Skal lykkes etter unpause"
    });
    domainPauses.pause("infra", "midlertidig");
    domainPauses.unpause("infra");
    const result = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id, { tool_id: "test_actuator", action: "flip", parameters: {} }, gateway, ownerIdentity
    );
    expect(result.tool_result.ok).toBe(true);
  });
});

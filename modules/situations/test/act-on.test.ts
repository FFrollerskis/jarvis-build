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
import { InMemoryDeviceRegistry, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type SecretProvider, type ToolTransport } from "@jarvis/tool-gateway";
import { DomainPauseRegistry } from "../src/domain-pause.ts";
import {
  buildNotifyMessage,
  computeActOperationFingerprint,
  computeNotifyKey,
  SituationActAlreadyClaimedError,
  SituationActClaimNotReleasableError,
  SituationActInFlightError,
  SituationActNotificationEvidenceMismatchError,
  SituationActOperationMismatchError,
  SituationActScopeMismatchError,
  SituationDomainPausedError,
  SituationEngine,
  SituationRecoveryUnauthorizedError
} from "../src/service.ts";

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
  domainPauses = new DomainPauseRegistry(appPool, { owner_person_id: "person-tobias-sit" });
  engine = new SituationEngine(appPool, domainPauses, { owner_person_id: "person-tobias-sit" });
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

describe("D: Funn 3 (arkitekt-review runde 1, PR #85) - atomisk, eksklusiv claim FØR execute(), eksakt-én-gang ACT", () => {
  it("et ANNET actOn()-kall for SAMME situasjon, startet MENS det FØRSTE fortsatt er i flukt inni selve det eksterne kallet (claimen ALLEREDE committet): VENTER på advisory-låsen (Funn 1+2, arkitekt-review runde 3 - HELE actOn() sin kritiske seksjon holder nå låsen, ikke bare claim-transaksjonen) og fullfører DERETTER trygt som en dedupliserende retry - INGEN dobbel side-effekt", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:concurrent", priority: "high", confidence: 0.9, reason: "Samtidig ACT-forsøk"
    });

    // En "gated" transport som blokkerer selve 'flip'-mutasjonen til testen EKSPLISITT
    // slipper den - dette skaper et DETERMINISTISK (ikke timing-avhengig) vindu der det
    // FØRSTE kallets claim GARANTERT allerede er committet (claimen skjer FØR
    // `gateway.execute()` i det hele tatt kalles - se service.ts sin `actOn()`), men
    // persisteringen av det endelige resultatet IKKE har skjedd ennå - NØYAKTIG det
    // "i flukt"-vinduet Funn 3 sin eksklusive claim skal beskytte.
    let releaseFlip!: () => void;
    const flipGate = new Promise<void>((resolve) => { releaseFlip = resolve; });
    let resolveReachedGate!: () => void;
    const reachedGate = new Promise<void>((resolve) => { resolveReachedGate = resolve; });
    class GatedActuatorTransport implements ToolTransport {
      calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
      private on = false;
      async invoke(action: string, _parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
        this.calls.push({ action, parameters: _parameters });
        if (action === "read_state") return { data: { on: this.on } };
        if (action === "flip") {
          resolveReachedGate();
          await flipGate;
          this.on = true;
          return { external_id: "act-1", data: { on: this.on } };
        }
        throw new Error(`unknown_action:${action}`);
      }
    }
    const gatedTransport = new GatedActuatorTransport();
    const slowGateway = new ToolGateway(appPool, policy, secrets);
    slowGateway.register({
      tool_id: "test_actuator", action: "flip", description: "test", input_schema: record({}),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "flip back",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: gatedTransport,
      preflight_action: "read_state",
      postcondition_predicate: (after) => (after as { on: boolean } | null)?.on === true
    });
    slowGateway.register({
      tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }),
      capability_class: "B", scopes: [], reversible: true, rollback_procedure: "send correction",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: telegram
    });

    const firstPromise = engine.actOn(
      TENANT_OWNER, "business", situation.situation_id, { tool_id: "test_actuator", action: "flip", parameters: {} }, slowGateway, ownerIdentity
    );
    await reachedGate; // det FØRSTE kallets claim er GARANTERT allerede committet, OG det holder NÅ advisory-låsen for "infra".

    let secondSettled = false;
    const secondPromise = engine
      .actOn(TENANT_OWNER, "business", situation.situation_id, { tool_id: "test_actuator", action: "flip", parameters: {} }, gateway, ownerIdentity)
      .finally(() => {
        secondSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Det ANDRE kallet venter FORTSATT på advisory-låsen det FØRSTE holder - IKKE avvist, IKKE fullført ennå.
    expect(secondSettled).toBe(false);

    releaseFlip();
    const first = await firstPromise;
    const second = await secondPromise;
    expect(first.tool_result.ok).toBe(true);
    expect(second.tool_result.ok).toBe(true);
    if (second.tool_result.ok) {
      // Det ANDRE kallet sin ToolGateway-dedupe gjenkjenner FØRSTE kallet sitt allerede skrevne tool_executions-bevis.
      expect(second.tool_result.deduplicated).toBe(true);
    }
    // Den FAKTISKE 'flip'-mutasjonen skjedde KUN ÉN gang - den eksklusive claimen + advisory-låsen (ikke ToolGateway sin egen dedupe alene) beviser eksakt-én-gang.
    expect(gatedTransport.calls.filter((c) => c.action === "flip")).toHaveLength(1);
    expect(actuatorOk.calls.filter((c) => c.action === "flip")).toHaveLength(0);
  });

  it("et EKSPLISITT ULIKT idempotency_key mot en ALLEREDE fullført ACT avvises (SituationActAlreadyClaimedError), FØR noe nytt eksternt kall", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:claim-conflict", priority: "high", confidence: 0.9, reason: "Claim-konflikt"
    });

    const first = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "custom-key-1" },
      gateway, ownerIdentity
    );
    expect(first.tool_result.ok).toBe(true);

    await expect(
      engine.actOn(
        TENANT_OWNER, "business", situation.situation_id,
        { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "custom-key-2" },
        gateway, ownerIdentity
      )
    ).rejects.toThrow(SituationActAlreadyClaimedError);
    // Kun ÉN faktisk 'flip'-mutasjon - det andre forsøket ble avvist FØR noe transportkall.
    expect(actuatorOk.calls.filter((c) => c.action === "flip")).toHaveLength(1);
  });

  it("en SEKVENSIELL retry med SAMME eksplisitte idempotency_key ETTER en allerede FULLFØRT ACT claimer på nytt trygt (krasj-gjenopprettings-simulering) - deduplicated:true, INGEN ny faktisk mutasjon", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:retry-recovery", priority: "high", confidence: 0.9, reason: "Retry etter simulert krasj"
    });

    const first = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "retry-key" },
      gateway, ownerIdentity
    );
    expect(first.tool_result.ok).toBe(true);

    const retry = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "retry-key" },
      gateway, ownerIdentity
    );
    expect(retry.tool_result.ok).toBe(true);
    if (retry.tool_result.ok) {
      expect(retry.tool_result.deduplicated).toBe(true);
    }
    expect(actuatorOk.calls.filter((c) => c.action === "flip")).toHaveLength(1);
  });
});

describe("E: Funn 4 (arkitekt-review runde 1, PR #85) - telegram sin ToolResult.ok SJEKKES eksplisitt, ALDRI kun try/catch", () => {
  it("Telegram returnerer NORMALT {ok:false} (f.eks. policy-/parameter-nektet, INGEN kastet feil): stadiet forblir 'act', IKKE 'act_notify' - selve ACT-handlingen er fortsatt bekreftet vellykket", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:telegram-denied", priority: "high", confidence: 0.9, reason: "Skal lykkes, men telegram nektes uten å kaste"
    });

    const denyingGateway = new ToolGateway(appPool, policy, secrets);
    denyingGateway.register({
      tool_id: "test_actuator", action: "flip", description: "test", input_schema: record({}),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "flip back",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: actuatorOk,
      preflight_action: "read_state",
      postcondition_predicate: (after) => (after as { on: boolean } | null)?.on === true
    });
    denyingGateway.register({
      tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }),
      capability_class: "B", scopes: [], reversible: true, rollback_procedure: "send correction",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: telegram,
      // Simulerer en NORMAL (ikke-kastende) ok:false - f.eks. en policy-/scope-nektelse som skjer FØR transporten kalles.
      parameterAuthorizer: () => ({ allowed: false, reason: "test_telegram_denied" })
    });

    const result = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {} },
      denyingGateway, ownerIdentity
    );

    expect(result.tool_result.ok).toBe(true); // selve ACT-handlingen (flip) lyktes og ble bekreftet.
    expect(result.situation.act_result).toBe("succeeded");
    expect(result.situation.stage).toBe("act"); // IKKE 'act_notify' - telegram-varselet ble ALDRI bekreftet levert.
    expect(telegram.calls).toHaveLength(0); // parameterAuthorizer nektet FØR transporten i det hele tatt ble kalt.
  });
});

describe("F: Funn 1 (arkitekt-review runde 2, PR #85) - operasjons-fingeravtrykk binder claimen til DEN FAKTISKE operasjonen", () => {
  it("SAMME eksplisitte idempotency_key, men et ULIKT parametersett på en retry: avvist (SituationActOperationMismatchError), INGEN nytt transportkall, INGEN feilaktig 'succeeded' for den nye, ANNERLEDES handlingen", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:fingerprint-mismatch", priority: "high", confidence: 0.9, reason: "Fingeravtrykk-mismatch-test"
    });

    const first = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "fp-key" },
      gateway, ownerIdentity
    );
    expect(first.tool_result.ok).toBe(true);

    // Samme nøkkel ("fp-key"), men parameters er nå ANNERLEDES (kunstig - test_actuator sitt
    // input_schema er tomt, så vi bruker en helt annen action/tool-kombinasjon for å garantere
    // et ulikt fingeravtrykk: telegram.notify med SAMME "fp-key").
    await expect(
      engine.actOn(
        TENANT_OWNER, "business", situation.situation_id,
        { tool_id: "telegram", action: "notify", parameters: { message: "et helt annet forsøk" }, idempotency_key: "fp-key" },
        gateway, ownerIdentity
      )
    ).rejects.toThrow(SituationActOperationMismatchError);

    // Situasjonen sitt lagrede resultat er FORTSATT den OPPRINNELIGE, bekreftede 'flip'-handlingen - ALDRI overskrevet av det avviste forsøket.
    const reloaded = await engine.getQueue(TENANT_OWNER, "business", { statusOpenOnly: false });
    const row = reloaded.find((s) => s.situation_id === situation.situation_id);
    expect(row?.act_tool_id).toBe("test_actuator");
    expect(row?.act_action).toBe("flip");
    expect(actuatorOk.calls.filter((c) => c.action === "flip")).toHaveLength(1);
  });

  it("TO ULIKE situasjoner som (uavhengig av hverandre) bruker SAMME eksplisitte idempotency_key kolliderer IKKE - hver situasjon får sin EGEN, faktiske eksekvering (situation_id er ALLTID en del av selve nøkkelen som sendes til ToolGateway)", async () => {
    const a = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:cross-sit-a", priority: "high", confidence: 0.9, reason: "Kryss-situasjon A"
    });
    const b = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:cross-sit-b", priority: "high", confidence: 0.9, reason: "Kryss-situasjon B"
    });

    const sharedKey = "caller-chosen-shared-key";
    const resultA = await engine.actOn(
      TENANT_OWNER, "business", a.situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: sharedKey },
      gateway, ownerIdentity
    );
    const resultB = await engine.actOn(
      TENANT_OWNER, "business", b.situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: sharedKey },
      gateway, ownerIdentity
    );

    expect(resultA.tool_result.ok).toBe(true);
    expect(resultB.tool_result.ok).toBe(true);
    // Situasjon B sitt resultat er IKKE en dedupliserende kopi av A sitt - hver situasjon fikk sin EGEN, faktiske 'flip'-mutasjon.
    if (resultB.tool_result.ok) {
      expect(resultB.tool_result.deduplicated).toBe(false);
    }
    expect(actuatorOk.calls.filter((c) => c.action === "flip")).toHaveLength(2);
  });
});

describe("G: Funn 2 (arkitekt-review runde 2, PR #85) - krasj-gjenopprettings-rekonsiliering mot tool_executions + eksplisitt releaseStuckActClaim()", () => {
  it("en claim med INGEN tool_executions-bevis avvises (SituationActInFlightError); releaseStuckActClaim() frigjør den trygt (INGEN bevis funnet) og en påfølgende actOn() lykkes normalt", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:stuck-claim", priority: "high", confidence: 0.9, reason: "Simulert krasj FØR transportkall"
    });
    const situationId = situation.situation_id;
    const finalKey = `situation:${situationId}:crash-sim-key`;
    const fingerprint = computeActOperationFingerprint(situationId, "test_actuator", "flip", {});
    // Simulerer en PROSESS-KRASJ rett ETTER claimen, men FØR noe transportkall i det hele tatt ble gjort - INGEN tool_executions-rad finnes for nøkkelen.
    await adminPool.query(
      `UPDATE situations SET act_claimed_at = now(), act_idempotency_key = $1, act_operation_fingerprint = $2, act_notify_message = $4 WHERE situation_id = $3`,
      [finalKey, fingerprint, situationId, buildNotifyMessage("Simulert krasj FØR transportkall", "test_actuator", "flip")]
    );

    await expect(
      engine.actOn(TENANT_OWNER, "business", situationId, { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "crash-sim-key" }, gateway, ownerIdentity)
    ).rejects.toThrow(SituationActInFlightError);
    expect(actuatorOk.calls.filter((c) => c.action === "flip")).toHaveLength(0); // ALDRI et nytt transportkall for en floke uten bevis.

    const released = await engine.releaseStuckActClaim(TENANT_OWNER, "business", situationId, ownerIdentity);
    expect(released.act_idempotency_key).toBeNull();
    expect(released.act_claimed_at).toBeNull();

    const retry = await engine.actOn(
      TENANT_OWNER, "business", situationId, { tool_id: "test_actuator", action: "flip", parameters: {} }, gateway, ownerIdentity
    );
    expect(retry.tool_result.ok).toBe(true);
    expect(actuatorOk.calls.filter((c) => c.action === "flip")).toHaveLength(1);
  });

  it("en claim med et FAKTISK tool_executions-bevis (act_result likevel NULL - krasj MELLOM transportkallet og sluttpersisteringen) rekonsilieres AUTOMATISK - INGEN nytt transportkall, releaseStuckActClaim() nekter (SituationActClaimNotReleasableError)", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:evidence-recovery", priority: "high", confidence: 0.9, reason: "Simulert krasj MELLOM execute() og persistering"
    });
    const situationId = situation.situation_id;
    const finalKey = `situation:${situationId}:evidence-sim-key`;
    const fingerprint = computeActOperationFingerprint(situationId, "test_actuator", "flip", {});
    await adminPool.query(
      `UPDATE situations SET act_claimed_at = now(), act_idempotency_key = $1, act_operation_fingerprint = $2, act_notify_message = $4 WHERE situation_id = $3`,
      [finalKey, fingerprint, situationId, buildNotifyMessage("Simulert krasj MELLOM execute() og persistering", "test_actuator", "flip")]
    );
    // releaseStuckActClaim() MÅ nekte NÅR et faktisk bevis finnes - dette er IKKE en fastlåst claim.
    await adminPool.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, external_id, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [TENANT_OWNER, finalKey, "test_actuator", "flip", "act-simulated-evidence", "succeeded"]
    );
    await expect(engine.releaseStuckActClaim(TENANT_OWNER, "business", situationId, ownerIdentity)).rejects.toThrow(SituationActClaimNotReleasableError);

    const recovered = await engine.actOn(
      TENANT_OWNER, "business", situationId, { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "evidence-sim-key" }, gateway, ownerIdentity
    );
    expect(recovered.tool_result.ok).toBe(true);
    if (recovered.tool_result.ok) {
      expect(recovered.tool_result.deduplicated).toBe(true);
    }
    // 'flip' ble ALDRI faktisk invokert her - kun preflight/readback (Q-34) kan ha kalt "read_state", ALDRI "flip" på nytt.
    expect(actuatorOk.calls.filter((c) => c.action === "flip")).toHaveLength(0);
    expect(recovered.situation.act_result).toBe("succeeded");
  });

  it("releaseStuckActClaim() håndhever SAMME scope-sjekk som actOn() (Funn 4) - en kaller fra et ANNET tenant/space avvises (SituationActScopeMismatchError)", async () => {
    await expect(
      engine.releaseStuckActClaim(TENANT_OWNER, "business", "sit-does-not-matter", unauthorizedIdentity)
    ).rejects.toThrow(SituationActScopeMismatchError);
  });
});

describe("H: Funn 3 (arkitekt-review runde 2, PR #85) - Telegram-varselet er SELV idempotent, en actOn()-retry sender ALDRI et duplikat-varsel", () => {
  it("en actOn()-retry med SAMME idempotency_key ETTER en allerede FULLFØRT ACT+NOTIFY sender IKKE et nytt Telegram-varsel", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:notify-dedupe", priority: "high", confidence: 0.9, reason: "Notify-dedupe-test"
    });

    const first = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "notify-dedupe-key" },
      gateway, ownerIdentity
    );
    expect(first.situation.stage).toBe("act_notify");
    expect(telegram.calls).toHaveLength(1);

    const retry = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "notify-dedupe-key" },
      gateway, ownerIdentity
    );
    expect(retry.tool_result.ok).toBe(true);
    expect(retry.situation.stage).toBe("act_notify");
    // INGEN nytt Telegram-varsel - selve varsel-kallet er NÅ SELV idempotent (eget idempotency_key).
    expect(telegram.calls).toHaveLength(1);
    expect(actuatorOk.calls.filter((c) => c.action === "flip")).toHaveLength(1);
  });
});

describe("I: Funn 4 (arkitekt-review runde 2, PR #85) - identitetens EGET scope MÅ matche situasjonens tenant/space, FØR noe DB-/gateway-kall", () => {
  it("identity.tenant_id ulikt det oppgitte tenantId avvises (SituationActScopeMismatchError) - FØR situasjonen i det hele tatt slås opp (en ikke-eksisterende situation_id kaster IKKE SituationNotFoundError her)", async () => {
    await expect(
      engine.actOn(TENANT_OWNER, "business", "sit-does-not-exist", { tool_id: "test_actuator", action: "flip", parameters: {} }, gateway, unauthorizedIdentity)
    ).rejects.toThrow(SituationActScopeMismatchError);
  });

  it("identity.memory_space_id ulikt det oppgitte memorySpace avvises (SituationActScopeMismatchError)", async () => {
    await expect(
      engine.actOn(TENANT_OWNER, "personal", "sit-does-not-exist", { tool_id: "test_actuator", action: "flip", parameters: {} }, gateway, ownerIdentity)
    ).rejects.toThrow(SituationActScopeMismatchError);
  });
});

describe("J: Funn 5 (arkitekt-review runde 2, PR #85) - AUTORITATIV, TRANSAKSJONELL domene-pause-sjekk (ALDRI kun den synkrone in-memory-cachen)", () => {
  it("en pause satt DIREKTE i situation_domain_pauses (aldri gjennom DENNE prosessens in-memory DomainPauseRegistry-instans) blokkerer actOn() likevel - beviser at den EKTE gaten er DB-en, ikke den lokale cachen", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "cross-process-domain", detection_key: "infra:actuator:cross-process-pause", priority: "high", confidence: 0.9, reason: "Skal blokkeres av en pause DENNE prosessen aldri fikk vite om lokalt"
    });
    // `domainPauses` (DENNE testfilens in-memory-registry) vet INGENTING om dette - simulerer en ANNEN worker-prosess som pauset domenet direkte i databasen.
    expect(domainPauses.isPaused("cross-process-domain")).toBe(false);
    await adminPool.query(
      `INSERT INTO situation_domain_pauses (domain, reason) VALUES ($1, $2)`,
      ["cross-process-domain", "pauset av en annen (simulert) prosess"]
    );
    try {
      await expect(
        engine.actOn(TENANT_OWNER, "business", situation.situation_id, { tool_id: "test_actuator", action: "flip", parameters: {} }, gateway, ownerIdentity)
      ).rejects.toThrow(SituationDomainPausedError);
      expect(actuatorOk.calls.filter((c) => c.action === "flip")).toHaveLength(0);
    } finally {
      await adminPool.query(`DELETE FROM situation_domain_pauses WHERE domain = $1`, ["cross-process-domain"]);
    }
  });

  it("en ALL_DOMAINS-pause satt direkte i databasen blokkerer ETHVERT domene, selv et som aldri ble eksplisitt navngitt", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "et-helt-nytt-domene", detection_key: "infra:actuator:cross-process-pause-all", priority: "high", confidence: 0.9, reason: "Skal blokkeres av en global pause"
    });
    await adminPool.query(`INSERT INTO situation_domain_pauses (domain, reason) VALUES ($1, $2)`, ["*", "global pause fra en annen prosess"]);
    try {
      await expect(
        engine.actOn(TENANT_OWNER, "business", situation.situation_id, { tool_id: "test_actuator", action: "flip", parameters: {} }, gateway, ownerIdentity)
      ).rejects.toThrow(SituationDomainPausedError);
    } finally {
      await adminPool.query(`DELETE FROM situation_domain_pauses WHERE domain = $1`, ["*"]);
    }
  });
});

describe("K: Funn 1+2 (arkitekt-review runde 3, PR #85) - EKTE tvers-av-prosess gjensidig utelukkelse (advisory locks), ikke en 'sjekk-så-skriv' som kan race", () => {
  function gatedActuator() {
    let releaseFlip!: () => void;
    const flipGate = new Promise<void>((resolve) => {
      releaseFlip = resolve;
    });
    let resolveReachedGate!: () => void;
    const reachedGate = new Promise<void>((resolve) => {
      resolveReachedGate = resolve;
    });
    class GatedActuatorTransport implements ToolTransport {
      calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
      private on = false;
      async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
        this.calls.push({ action, parameters });
        if (action === "read_state") return { data: { on: this.on } };
        if (action === "flip") {
          resolveReachedGate();
          await flipGate;
          this.on = true;
          return { external_id: "act-1", data: { on: this.on } };
        }
        throw new Error(`unknown_action:${action}`);
      }
    }
    return { transport: new GatedActuatorTransport(), releaseFlip, reachedGate };
  }

  function gatedGateway(transport: ToolTransport): ToolGateway {
    const g = new ToolGateway(appPool, policy, secrets);
    g.register({
      tool_id: "test_actuator", action: "flip", description: "test", input_schema: record({}),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "flip back",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport,
      preflight_action: "read_state",
      postcondition_predicate: (after) => (after as { on: boolean } | null)?.on === true
    });
    g.register({
      tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }),
      capability_class: "B", scopes: [], reversible: true, rollback_procedure: "send correction",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: telegram
    });
    return g;
  }

  it("en pauseDurable() FORSØKT MENS et actOn() er i flukt for SAMME domene MÅ VENTE til actOn() er ferdig - kan ALDRI blokkere et ALLEREDE påbegynt forsøk, men blokkerer PÅLITELIG det NESTE", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "barrier-domain-pause", detection_key: "infra:actuator:barrier-pause", priority: "high", confidence: 0.9, reason: "To-sesjons-barriere-test"
    });
    const { transport, releaseFlip, reachedGate } = gatedActuator();
    const slowGateway = gatedGateway(transport);

    const actOnPromise = engine.actOn(
      TENANT_OWNER, "business", situation.situation_id, { tool_id: "test_actuator", action: "flip", parameters: {} }, slowGateway, ownerIdentity
    );
    await reachedGate; // actOn() holder NÅ advisory-låsen for "barrier-domain-pause" og er midt i det eksterne kallet.

    let pauseResolved = false;
    const pausePromise = domainPauses
      .pauseDurable("barrier-domain-pause", "forsøkt midt i et in-flight actOn()", "person-tobias-sit")
      .then(() => {
        pauseResolved = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 200));
    // pauseDurable() venter FORTSATT på advisory-låsen - beviser at den IKKE kan smyge seg forbi et allerede påbegynt forsøk.
    expect(pauseResolved).toBe(false);

    releaseFlip();
    const result = await actOnPromise;
    expect(result.tool_result.ok).toBe(true); // handlingen FULLFØRTE - pausen kom for SENT til å påvirke DETTE forsøket.

    await pausePromise;
    expect(pauseResolved).toBe(true);

    const { situation: situation2 } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "barrier-domain-pause", detection_key: "infra:actuator:barrier-pause-2", priority: "high", confidence: 0.9, reason: "Skal blokkeres naa"
    });
    await expect(
      engine.actOn(TENANT_OWNER, "business", situation2.situation_id, { tool_id: "test_actuator", action: "flip", parameters: {} }, gateway, ownerIdentity)
    ).rejects.toThrow(SituationDomainPausedError);

    await domainPauses.unpauseDurable("barrier-domain-pause", "person-tobias-sit");
  });

  it("releaseStuckActClaim() FORSØKT MENS et actOn() FORTSATT er i flukt (INGEN tool_executions-bevis skrevet ennå) MÅ VENTE - kan ALDRI observere et falskt 'ingen bevis' midt i et ekte pågående forsøk", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "barrier-domain-release", detection_key: "infra:actuator:barrier-release", priority: "high", confidence: 0.9, reason: "To-sesjons-barriere-release-test"
    });
    const { transport, releaseFlip, reachedGate } = gatedActuator();
    const slowGateway = gatedGateway(transport);

    const actOnPromise = engine.actOn(
      TENANT_OWNER, "business", situation.situation_id, { tool_id: "test_actuator", action: "flip", parameters: {} }, slowGateway, ownerIdentity
    );
    await reachedGate; // claimet, MEN INGEN tool_executions-bevis er skrevet ennå (transporten er FORTSATT inni det gatede kallet).

    let releaseSettled = false;
    const releasePromise = engine
      .releaseStuckActClaim(TENANT_OWNER, "business", situation.situation_id, ownerIdentity)
      .finally(() => {
        releaseSettled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 200));
    // releaseStuckActClaim() venter FORTSATT på advisory-låsen actOn() holder.
    expect(releaseSettled).toBe(false);

    releaseFlip();
    const result = await actOnPromise;
    expect(result.tool_result.ok).toBe(true);

    // NÅ som actOn() er FERDIG (fullt persistert, act_result satt) FØR releaseStuckActClaim() i det hele
    // tatt fikk fortsette forbi advisory-låsen, ser den situasjonen som ALLEREDE fullført normalt - IKKE
    // en fastlåst claim (den tidligere "evidence exists, act_result NULL"-mellomtilstanden testen i
    // runde 2 antok, er nå STRUKTURELT umulig å observere utenfra: en ekstern kaller kan ALDRI se
    // situasjonen midt i actOn() sin persistering, kun FØR (fortsatt låst) eller ETTER (helt ferdig)).
    const released = await releasePromise;
    expect(released.act_result).toBe("succeeded");
    expect(released.act_idempotency_key).not.toBeNull(); // IKKE frigjort - ingenting å frigjøre.
    expect(releaseSettled).toBe(true);
  });

  it("releaseStuckActClaim() krever konfigurert recoveryAuthority PLUSS en identity.person_id som FAKTISK matcher - avvist (SituationRecoveryUnauthorizedError) ellers, INGEN frigjøring", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:recovery-unauthorized", priority: "high", confidence: 0.9, reason: "Uautorisert gjenopprettingsforsøk"
    });
    const imposterIdentity: IdentityContext = { ...ownerIdentity, person_id: "person-tobias-sit-imposter" };
    await expect(
      engine.releaseStuckActClaim(TENANT_OWNER, "business", situation.situation_id, imposterIdentity)
    ).rejects.toThrow(SituationRecoveryUnauthorizedError);

    const engineWithoutAuthority = new SituationEngine(appPool, domainPauses);
    await expect(
      engineWithoutAuthority.releaseStuckActClaim(TENANT_OWNER, "business", situation.situation_id, ownerIdentity)
    ).rejects.toThrow(SituationRecoveryUnauthorizedError);
  });
});

describe("L: Funn 1 (arkitekt-review runde 4, PR #85) - terminal ACT-tilstand er MONOTON: en retry kaller ALDRI gateway.execute() på nytt for en allerede avgjort operasjon, og kan derfor ALDRI bli feilaktig overskrevet av en SENERE, UBESLEKTET port-avvisning (credential/connector/rate-limit)", () => {
  function registerActuatorAndTelegram(g: ToolGateway, transport: ToolTransport, rateLimitPerMinute = 30): void {
    g.register({
      tool_id: "test_actuator", action: "flip", description: "test", input_schema: record({}),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "flip back",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: rateLimitPerMinute,
      credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport,
      preflight_action: "read_state",
      postcondition_predicate: (after) => (after as { on: boolean } | null)?.on === true
    });
    g.register({
      tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }),
      capability_class: "B", scopes: [], reversible: true, rollback_procedure: "send correction",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: telegram
    });
  }

  it("en retry etter en allerede FULLFØRT ACT, MED credentialen TILBAKEKALT i mellomtiden, returnerer det UENDREDE opprinnelige resultatet - INGEN nytt transportkall", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:replay-credential-revoked", priority: "high", confidence: 0.9, reason: "Replay-etter-credential-revocation-test"
    });
    const controls = new OwnerControls(new KillSwitch());
    const localTransport = new FakeActuatorTransport(true);
    const g = new ToolGateway(appPool, policy, secrets, controls);
    registerActuatorAndTelegram(g, localTransport);

    const first = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "replay-cred-key" }, g, ownerIdentity
    );
    expect(first.tool_result.ok).toBe(true);
    expect(first.situation.act_result).toBe("succeeded");
    const callsAfterFirst = localTransport.calls.length;
    expect(localTransport.calls.filter((c) => c.action === "flip")).toHaveLength(1);

    // Simulerer en SENERE, UBESLEKTET tilstandsendring - credentialen er nå tilbakekalt.
    controls.revokeCredential("TEST_ACTUATOR_TOKEN");

    const retry = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "replay-cred-key" }, g, ownerIdentity
    );
    expect(retry.tool_result.ok).toBe(true); // UENDRET - IKKE feilaktig nedgradert til 'denied' av den senere tilbakekallingen.
    expect(retry.situation.act_result).toBe("succeeded");
    expect(retry.situation.stage).toBe(first.situation.stage);
    expect(retry.situation.reason).toBe(first.situation.reason);
    expect(localTransport.calls.length).toBe(callsAfterFirst); // INGEN nytt transportkall i det hele tatt.
  });

  it("en retry etter en allerede FULLFØRT ACT, MED connectoren FRYST i mellomtiden, returnerer det UENDREDE opprinnelige resultatet - INGEN nytt transportkall", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:replay-connector-frozen", priority: "high", confidence: 0.9, reason: "Replay-etter-connector-freeze-test"
    });
    const controls = new OwnerControls(new KillSwitch());
    const localTransport = new FakeActuatorTransport(true);
    const g = new ToolGateway(appPool, policy, secrets, controls);
    registerActuatorAndTelegram(g, localTransport);

    const first = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "replay-frozen-key" }, g, ownerIdentity
    );
    expect(first.tool_result.ok).toBe(true);
    const callsAfterFirst = localTransport.calls.length;

    controls.freezeConnector("test_actuator");

    const retry = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "replay-frozen-key" }, g, ownerIdentity
    );
    expect(retry.tool_result.ok).toBe(true);
    expect(retry.situation.act_result).toBe("succeeded");
    expect(retry.situation.stage).toBe(first.situation.stage);
    expect(localTransport.calls.length).toBe(callsAfterFirst);
  });

  it("en retry etter en allerede FULLFØRT ACT, MED rate-limiten oppbrukt i mellomtiden (rate_limit_per_minute:1), returnerer det UENDREDE opprinnelige resultatet - INGEN nytt transportkall", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:replay-rate-limited", priority: "high", confidence: 0.9, reason: "Replay-etter-rate-limit-test"
    });
    const localTransport = new FakeActuatorTransport(true);
    const g = new ToolGateway(appPool, policy, secrets);
    registerActuatorAndTelegram(g, localTransport, 1); // KUN ett kall per minutt tillatt for dette verktøyet.

    const first = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "replay-rate-key" }, g, ownerIdentity
    );
    expect(first.tool_result.ok).toBe(true);
    const callsAfterFirst = localTransport.calls.length;

    // Rate-limiten (1/min) er nå OPPBRUKT av det FØRSTE kallet - et NYTT execute()-kall for DETTE verktøyet ville blitt avvist av rate-limit-porten.
    const retry = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "replay-rate-key" }, g, ownerIdentity
    );
    expect(retry.tool_result.ok).toBe(true); // UENDRET - rate-limit-porten ble ALDRI konsultert for denne replayen.
    expect(retry.situation.act_result).toBe("succeeded");
    expect(localTransport.calls.length).toBe(callsAfterFirst);
  });

  it("en retry etter en allerede FULLFØRT ACT+NOTIFY, MED Telegram-credentialen tilbakekalt i mellomtiden, beholder stage='act_notify' - ALDRI nedgradert til 'act', INGEN nytt varsel-forsøk", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:replay-notify-credential-revoked", priority: "high", confidence: 0.9, reason: "Replay-etter-notify-credential-revocation-test"
    });
    const controls = new OwnerControls(new KillSwitch());
    const localTransport = new FakeActuatorTransport(true);
    const localTelegram = new TelegramSpyTransport();
    const g = new ToolGateway(appPool, policy, secrets, controls);
    g.register({
      tool_id: "test_actuator", action: "flip", description: "test", input_schema: record({}),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "flip back",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: localTransport,
      preflight_action: "read_state",
      postcondition_predicate: (after) => (after as { on: boolean } | null)?.on === true
    });
    g.register({
      tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }),
      capability_class: "B", scopes: [], reversible: true, rollback_procedure: "send correction",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: localTelegram
    });

    const first = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "replay-notify-key" }, g, ownerIdentity
    );
    expect(first.situation.stage).toBe("act_notify");
    expect(localTelegram.calls).toHaveLength(1);

    controls.revokeCredential("TEST_TELEGRAM_TOKEN");

    const retry = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "replay-notify-key" }, g, ownerIdentity
    );
    expect(retry.situation.stage).toBe("act_notify"); // ALDRI nedgradert til 'act' av den senere, ubeslektede tilbakekallingen.
    expect(localTelegram.calls).toHaveLength(1); // INGEN nytt varsel-forsøk.
    expect(localTransport.calls.filter((c) => c.action === "flip")).toHaveLength(1); // INGEN ny ACT-invokering heller.
  });
});

describe("M: Funn 1 (arkitekt-review runde 5, PR #85) - terminal_replay MÅ rekonsiliere varsel-tilstanden, ALDRI hoppe helt over den", () => {
  it("krasj MELLOM ACT-persistering og selve varsel-forsøket (stage fortsatt 'act', INGEN notify-bevis): en retry forsøker varselet NÅ, for FØRSTE gang, og avanserer til 'act_notify' - INGEN ny ACT-invokering", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:crash-before-notify", priority: "high", confidence: 0.9, reason: "Krasj FØR varsel-forsøket"
    });
    const situationId = situation.situation_id;
    const finalKey = `situation:${situationId}:crash-before-notify-key`;
    const fingerprint = computeActOperationFingerprint(situationId, "test_actuator", "flip", {});
    const notifyMessage = buildNotifyMessage("Krasj FØR varsel-forsøket", "test_actuator", "flip");
    // Simulerer: ACT-en BLE bekreftet og persistert (stage='act', act_result='succeeded'), men prosessen krasjet FØR noe varsel-forsøk i det hele tatt ble gjort.
    await adminPool.query(
      `UPDATE situations
       SET act_claimed_at = now(), act_idempotency_key = $1, act_operation_fingerprint = $2, act_notify_message = $4,
           act_tool_id = 'test_actuator', act_action = 'flip', act_result = 'succeeded', stage = 'act', updated_at = now()
       WHERE situation_id = $3`,
      [finalKey, fingerprint, situationId, notifyMessage]
    );
    await adminPool.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, external_id, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [TENANT_OWNER, finalKey, "test_actuator", "flip", "act-simulated-crash-before-notify", "succeeded"]
    );

    expect(telegram.calls).toHaveLength(0);
    const retry = await engine.actOn(
      TENANT_OWNER, "business", situationId,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "crash-before-notify-key" }, gateway, ownerIdentity
    );
    expect(retry.tool_result.ok).toBe(true);
    expect(retry.situation.stage).toBe("act_notify");
    expect(telegram.calls).toHaveLength(1); // FØRSTE (og eneste) varsel-forsøk.
    expect(actuatorOk.calls.filter((c) => c.action === "flip")).toHaveLength(0); // INGEN ny ACT-invokering.
  });

  it("krasj MELLOM et BEKREFTET varsel-bevis og selve stage-oppdateringen til 'act_notify': en retry selv-helbreder stage UTEN noe nytt transportkall", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:crash-after-notify-evidence", priority: "high", confidence: 0.9, reason: "Krasj MELLOM bekreftet varsel og stage-oppdatering"
    });
    const situationId = situation.situation_id;
    const finalKey = `situation:${situationId}:crash-after-notify-key`;
    const fingerprint = computeActOperationFingerprint(situationId, "test_actuator", "flip", {});
    const notifyMessage = buildNotifyMessage("Krasj MELLOM bekreftet varsel og stage-oppdatering", "test_actuator", "flip");
    await adminPool.query(
      `UPDATE situations
       SET act_claimed_at = now(), act_idempotency_key = $1, act_operation_fingerprint = $2, act_notify_message = $4,
           act_tool_id = 'test_actuator', act_action = 'flip', act_result = 'succeeded', stage = 'act', updated_at = now()
       WHERE situation_id = $3`,
      [finalKey, fingerprint, situationId, notifyMessage]
    );
    await adminPool.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, external_id, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [TENANT_OWNER, finalKey, "test_actuator", "flip", "act-simulated-crash-after-notify", "succeeded"]
    );
    // Varselet ble FAKTISK bekreftet levert (tool_executions-bevis finnes for notify-nøkkelen, bundet til DENNE meldingens fingeravtrykk), men prosessen krasjet FØR stage='act_notify' ble persistert.
    const notifyKey = computeNotifyKey(finalKey, situationId, notifyMessage);
    await adminPool.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, external_id, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [TENANT_OWNER, notifyKey, "telegram", "notify", "tg-simulated-crash", "succeeded"]
    );

    expect(telegram.calls).toHaveLength(0);
    const retry = await engine.actOn(
      TENANT_OWNER, "business", situationId,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "crash-after-notify-key" }, gateway, ownerIdentity
    );
    expect(retry.situation.stage).toBe("act_notify"); // selv-helbredet fra det EKSISTERENDE beviset.
    expect(telegram.calls).toHaveLength(0); // INGEN nytt transportkall - ToolGateway sin egen dedupe gjenkjente det allerede eksisterende beviset.
  });
});

describe("N: Funn 1 (arkitekt-review runde 6, PR #85) - varsel-rekonsiliering leser tool_executions-beviset DIREKTE, FØR ToolGateway sin muterbare autorisasjons-/credential-/rate-limit-pipeline i det hele tatt vurderes", () => {
  async function setupCrashedAfterNotifyEvidence(domain: string, detectionKey: string, keySuffix: string): Promise<string> {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain, detection_key: detectionKey, priority: "high", confidence: 0.9, reason: `Krasj-etter-bekreftet-varsel-bevis-${keySuffix}`
    });
    const situationId = situation.situation_id;
    const finalKey = `situation:${situationId}:${keySuffix}`;
    const fingerprint = computeActOperationFingerprint(situationId, "test_actuator", "flip", {});
    const notifyMessage = buildNotifyMessage(`Krasj-etter-bekreftet-varsel-bevis-${keySuffix}`, "test_actuator", "flip");
    await adminPool.query(
      `UPDATE situations
       SET act_claimed_at = now(), act_idempotency_key = $1, act_operation_fingerprint = $2, act_notify_message = $4,
           act_tool_id = 'test_actuator', act_action = 'flip', act_result = 'succeeded', stage = 'act', updated_at = now()
       WHERE situation_id = $3`,
      [finalKey, fingerprint, situationId, notifyMessage]
    );
    await adminPool.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, external_id, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [TENANT_OWNER, finalKey, "test_actuator", "flip", `act-sim-${keySuffix}`, "succeeded"]
    );
    // Varselet BLE FAKTISK bekreftet levert (tool_executions-bevis finnes for notify-nøkkelen, bundet til DENNE meldingens fingeravtrykk) - prosessen krasjet FØR stage='act_notify' ble persistert.
    const notifyKey = computeNotifyKey(finalKey, situationId, notifyMessage);
    await adminPool.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, external_id, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [TENANT_OWNER, notifyKey, "telegram", "notify", `tg-sim-${keySuffix}`, "succeeded"]
    );
    return situationId;
  }

  it("selv-helbreder til 'act_notify' selv når en FERSK varsel-policy-nektelse (parameterAuthorizer) ville avvist et NYTT forsøk - ZERO nye transportkall", async () => {
    const situationId = await setupCrashedAfterNotifyEvidence("infra", "infra:actuator:reconcile-policy-denied", "reconcile-policy-key");
    const localTelegram = new TelegramSpyTransport();
    const g = new ToolGateway(appPool, policy, secrets);
    g.register({
      tool_id: "test_actuator", action: "flip", description: "test", input_schema: record({}),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "flip back",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: actuatorOk,
      preflight_action: "read_state", postcondition_predicate: (after) => (after as { on: boolean } | null)?.on === true
    });
    g.register({
      tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }),
      capability_class: "B", scopes: [], reversible: true, rollback_procedure: "send correction",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: localTelegram,
      parameterAuthorizer: () => ({ allowed: false, reason: "policy_now_denies_this" })
    });

    const retry = await engine.actOn(
      TENANT_OWNER, "business", situationId, { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "reconcile-policy-key" }, g, ownerIdentity
    );
    expect(retry.situation.stage).toBe("act_notify");
    expect(localTelegram.calls).toHaveLength(0);
  });

  it("selv-helbreder til 'act_notify' selv når Telegram-credentialen er TILBAKEKALT - ZERO nye transportkall", async () => {
    const situationId = await setupCrashedAfterNotifyEvidence("infra", "infra:actuator:reconcile-credential-revoked", "reconcile-cred-key");
    const controls = new OwnerControls(new KillSwitch());
    controls.revokeCredential("TEST_TELEGRAM_TOKEN");
    const localTelegram = new TelegramSpyTransport();
    const g = new ToolGateway(appPool, policy, secrets, controls);
    g.register({
      tool_id: "test_actuator", action: "flip", description: "test", input_schema: record({}),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "flip back",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: actuatorOk,
      preflight_action: "read_state", postcondition_predicate: (after) => (after as { on: boolean } | null)?.on === true
    });
    g.register({
      tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }),
      capability_class: "B", scopes: [], reversible: true, rollback_procedure: "send correction",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: localTelegram
    });

    const retry = await engine.actOn(
      TENANT_OWNER, "business", situationId, { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "reconcile-cred-key" }, g, ownerIdentity
    );
    expect(retry.situation.stage).toBe("act_notify");
    expect(localTelegram.calls).toHaveLength(0);
  });

  it("selv-helbreder til 'act_notify' selv når Telegram-connectoren er FRYST - ZERO nye transportkall", async () => {
    const situationId = await setupCrashedAfterNotifyEvidence("infra", "infra:actuator:reconcile-connector-frozen", "reconcile-frozen-key");
    const controls = new OwnerControls(new KillSwitch());
    controls.freezeConnector("telegram");
    const localTelegram = new TelegramSpyTransport();
    const g = new ToolGateway(appPool, policy, secrets, controls);
    g.register({
      tool_id: "test_actuator", action: "flip", description: "test", input_schema: record({}),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "flip back",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: actuatorOk,
      preflight_action: "read_state", postcondition_predicate: (after) => (after as { on: boolean } | null)?.on === true
    });
    g.register({
      tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }),
      capability_class: "B", scopes: [], reversible: true, rollback_procedure: "send correction",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: localTelegram
    });

    const retry = await engine.actOn(
      TENANT_OWNER, "business", situationId, { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "reconcile-frozen-key" }, g, ownerIdentity
    );
    expect(retry.situation.stage).toBe("act_notify");
    expect(localTelegram.calls).toHaveLength(0);
  });

  it("selv-helbreder til 'act_notify' selv når Telegram-varselets rate limit er OPPBRUKT (rate_limit_per_minute: 0) - ZERO nye transportkall", async () => {
    const situationId = await setupCrashedAfterNotifyEvidence("infra", "infra:actuator:reconcile-rate-limited", "reconcile-rate-key");
    const localTelegram = new TelegramSpyTransport();
    const g = new ToolGateway(appPool, policy, secrets);
    g.register({
      tool_id: "test_actuator", action: "flip", description: "test", input_schema: record({}),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "flip back",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: actuatorOk,
      preflight_action: "read_state", postcondition_predicate: (after) => (after as { on: boolean } | null)?.on === true
    });
    g.register({
      tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }),
      capability_class: "B", scopes: [], reversible: true, rollback_procedure: "send correction",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 0,
      credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: localTelegram
    });

    const retry = await engine.actOn(
      TENANT_OWNER, "business", situationId, { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "reconcile-rate-key" }, g, ownerIdentity
    );
    expect(retry.situation.stage).toBe("act_notify");
    expect(localTelegram.calls).toHaveLength(0);
  });

  it("Funn 1 (arkitekt-review runde 7, PR #85) - en tool_executions-rad UNDER varsel-nøkkelen, men for et ANNET tool_id/action, avvises fail-closed (SituationActNotificationEvidenceMismatchError) - stage kan IKKE avansere til 'act_notify' på det falske beviset", async () => {
    const situationId = await setupCrashedAfterNotifyEvidence("infra", "infra:actuator:reconcile-evidence-mismatch", "reconcile-mismatch-key");
    const finalKey = `situation:${situationId}:reconcile-mismatch-key`;
    const notifyKey = computeNotifyKey(finalKey, situationId, buildNotifyMessage("Krasj-etter-bekreftet-varsel-bevis-reconcile-mismatch-key", "test_actuator", "flip"));
    // Overskriver den GYLDIGE ('telegram'/'notify') raden fra setup-hjelperen med en som IKKE er bundet til varsel-operasjonen.
    await adminPool.query(
      `UPDATE tool_executions SET tool_id = $1, action = $2 WHERE tenant_id = $3 AND idempotency_key = $4`,
      ["test_actuator", "flip", TENANT_OWNER, notifyKey]
    );
    const localTelegram = new TelegramSpyTransport();
    const g = new ToolGateway(appPool, policy, secrets);
    g.register({
      tool_id: "test_actuator", action: "flip", description: "test", input_schema: record({}),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "flip back",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: actuatorOk,
      preflight_action: "read_state", postcondition_predicate: (after) => (after as { on: boolean } | null)?.on === true
    });
    g.register({
      tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }),
      capability_class: "B", scopes: [], reversible: true, rollback_procedure: "send correction",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: localTelegram
    });

    await expect(
      engine.actOn(
        TENANT_OWNER, "business", situationId, { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "reconcile-mismatch-key" }, g, ownerIdentity
      )
    ).rejects.toThrow(SituationActNotificationEvidenceMismatchError);
    expect(localTelegram.calls).toHaveLength(0);
    const { rows } = await adminPool.query(`SELECT stage FROM situations WHERE situation_id = $1`, [situationId]);
    expect((rows[0] as { stage: string }).stage).toBe("act"); // UENDRET - IKKE feilaktig avansert paa det falske beviset.
  });
});

describe("O: Funn 1 (arkitekt-review runde 8, PR #85) - varsel-bevis MÅ bindes til den EKSAKTE meldingsteksten (canonical fingerprint), ikke bare tool_id/action", () => {
  it("en succeeded tool_executions-rad UNDER varsel-nøkkelen for ET ANNET meldingsinnhold (annen 'reason') teller IKKE som bevis for DENNE meldingen - stage avanserer KUN via et FERSKT, FAKTISK varsel-forsøk for DEN RIKTIGE teksten", async () => {
    const REAL_REASON = "Ekte grunn for DENNE ACT-en";
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:reconcile-payload-mismatch", priority: "high", confidence: 0.9, reason: REAL_REASON
    });
    const situationId = situation.situation_id;
    const finalKey = `situation:${situationId}:reconcile-payload-key`;
    const fingerprint = computeActOperationFingerprint(situationId, "test_actuator", "flip", {});
    // Simulerer: ACT-en BLE bekreftet og persistert, men prosessen krasjet FØR stage='act_notify' ble persistert.
    await adminPool.query(
      `UPDATE situations
       SET act_claimed_at = now(), act_idempotency_key = $1, act_operation_fingerprint = $2, act_notify_message = $4,
           act_tool_id = 'test_actuator', act_action = 'flip', act_result = 'succeeded', stage = 'act', updated_at = now()
       WHERE situation_id = $3`,
      [finalKey, fingerprint, situationId, buildNotifyMessage(REAL_REASON, "test_actuator", "flip")]
    );
    await adminPool.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, external_id, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [TENANT_OWNER, finalKey, "test_actuator", "flip", "act-sim-payload-mismatch", "succeeded"]
    );
    // Et "bevist" varsel finnes, men for et HELT ANNET meldingsinnhold (en annen 'reason') enn den situasjonen FAKTISK har -
    // dette produserer en HELT ANNEN fingeravtrykk-nøkkel enn den DENNE meldingen ville brukt.
    const staleNotifyKey = computeNotifyKey(finalKey, situationId, buildNotifyMessage("En HELT ANNEN, ubeslektet grunn fra et tidligere forsøk", "test_actuator", "flip"));
    await adminPool.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, external_id, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [TENANT_OWNER, staleNotifyKey, "telegram", "notify", "tg-sim-stale-payload", "succeeded"]
    );

    const localTelegram = new TelegramSpyTransport();
    const g = new ToolGateway(appPool, policy, secrets);
    g.register({
      tool_id: "test_actuator", action: "flip", description: "test", input_schema: record({}),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "flip back",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: actuatorOk,
      preflight_action: "read_state", postcondition_predicate: (after) => (after as { on: boolean } | null)?.on === true
    });
    g.register({
      tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }),
      capability_class: "B", scopes: [], reversible: true, rollback_procedure: "send correction",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: localTelegram
    });

    expect(localTelegram.calls).toHaveLength(0);
    const retry = await engine.actOn(
      TENANT_OWNER, "business", situationId,
      { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "reconcile-payload-key" }, g, ownerIdentity
    );
    expect(retry.situation.stage).toBe("act_notify");
    // Det STALE beviset (annet innhold) ble IKKE godtatt - ETT ferskt, ekte varsel ble sendt for DENNE meldingen, ikke null.
    expect(localTelegram.calls).toHaveLength(1);
    expect(localTelegram.calls[0]?.parameters.message).toBe(buildNotifyMessage(REAL_REASON, "test_actuator", "flip"));
  });
});

describe("P: Funn 1 (arkitekt-review runde 9, PR #85) - varselteksten/-nøkkelen MÅ være FROSSET ved claimen, ALDRI re-avledet fra den muterbare `reason`", () => {
  function localGateway(): { g: ToolGateway; localTelegram: TelegramSpyTransport } {
    const localTelegram = new TelegramSpyTransport();
    const g = new ToolGateway(appPool, policy, secrets);
    g.register({
      tool_id: "test_actuator", action: "flip", description: "test", input_schema: record({}),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "flip back",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: actuatorOk,
      preflight_action: "read_state", postcondition_predicate: (after) => (after as { on: boolean } | null)?.on === true
    });
    g.register({
      tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }),
      capability_class: "B", scopes: [], reversible: true, rollback_procedure: "send correction",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 30,
      credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: localTelegram
    });
    return { g, localTelegram };
  }

  async function seedSucceededActAt(detectionKey: string, keySuffix: string, reasonA: string): Promise<{ situationId: string; finalKey: string; frozenMessage: string }> {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: detectionKey, priority: "high", confidence: 0.9, reason: reasonA
    });
    const situationId = situation.situation_id;
    const finalKey = `situation:${situationId}:${keySuffix}`;
    const fingerprint = computeActOperationFingerprint(situationId, "test_actuator", "flip", {});
    const frozenMessage = buildNotifyMessage(reasonA, "test_actuator", "flip");
    // ACT bekreftet og persistert (act_result='succeeded', stage='act'), varselteksten frosset ved claimen - som service.ts gjør.
    await adminPool.query(
      `UPDATE situations
       SET act_claimed_at = now(), act_idempotency_key = $1, act_operation_fingerprint = $2, act_notify_message = $4,
           act_tool_id = 'test_actuator', act_action = 'flip', act_result = 'succeeded', stage = 'act', updated_at = now()
       WHERE situation_id = $3`,
      [finalKey, fingerprint, situationId, frozenMessage]
    );
    await adminPool.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, external_id, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [TENANT_OWNER, finalKey, "test_actuator", "flip", `act-sim-${keySuffix}`, "succeeded"]
    );
    return { situationId, finalKey, frozenMessage };
  }

  it("reviewens eksakte sekvens: bekreftet varsel (reason A) + krasj FØR stage-oppdatering + re-deteksjon som endrer reason til B + retry -> ZERO nye transportkall, selv-helbredet til 'act_notify'", async () => {
    const REASON_A = "Reason A - den opprinnelige grunnen ACT-en ble utført for";
    const REASON_B = "Reason B - en SENERE re-deteksjon omformulerte grunnen";
    const { situationId, finalKey, frozenMessage } = await seedSucceededActAt("infra:actuator:frozen-notify-redetect", "frozen-redetect-key", REASON_A);
    // Varselet BLE bekreftet levert under nøkkelen for den FROSNE teksten (reason A) - prosessen krasjet FØR stage='act_notify'.
    await adminPool.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, external_id, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [TENANT_OWNER, computeNotifyKey(finalKey, situationId, frozenMessage), "telegram", "notify", "tg-sim-frozen-redetect", "succeeded"]
    );

    // Re-deteksjon av SAMME situasjon med en ANNEN reason - evaluateCandidate() oppdaterer `reason` selv om stadiet allerede er 'act'.
    const redetected = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:frozen-notify-redetect", priority: "high", confidence: 0.9, reason: REASON_B
    });
    expect(redetected.situation.situation_id).toBe(situationId);
    expect(redetected.situation.reason).toBe(REASON_B); // `reason` ER faktisk mutert ...
    expect(redetected.situation.stage).toBe("act"); // ... mens stadiet holdes (non-regresjon) ...
    expect(redetected.situation.act_notify_message).toBe(frozenMessage); // ... og den FROSNE varselteksten er UENDRET.

    const { g, localTelegram } = localGateway();
    const retry = await engine.actOn(
      TENANT_OWNER, "business", situationId, { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "frozen-redetect-key" }, g, ownerIdentity
    );
    expect(retry.situation.stage).toBe("act_notify"); // selv-helbredet fra beviset under den FROSNE nøkkelen.
    expect(localTelegram.calls).toHaveLength(0); // INGEN duplikat - runde 8 ville regnet ut en annen nøkkel fra reason B og sendt på nytt.
    expect(actuatorOk.calls.filter((c) => c.action === "flip")).toHaveLength(0);
  });

  it("krasj FØR varsel-forsøket + re-deteksjon som endrer reason -> det FØRSTE varselet sendes med den FROSNE teksten (reason A, ikke B), og en påfølgende retry dedupliserer under SAMME nøkkel", async () => {
    const REASON_A = "Reason A - frosset ved claimen";
    const REASON_B = "Reason B - endret etter ACT, FØR varselet";
    const { situationId, finalKey, frozenMessage } = await seedSucceededActAt("infra:actuator:frozen-notify-first-send", "frozen-first-send-key", REASON_A);
    const redetected = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:frozen-notify-first-send", priority: "high", confidence: 0.9, reason: REASON_B
    });
    expect(redetected.situation.reason).toBe(REASON_B);
    expect(redetected.situation.stage).toBe("act");

    const { g, localTelegram } = localGateway();
    const first = await engine.actOn(
      TENANT_OWNER, "business", situationId, { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "frozen-first-send-key" }, g, ownerIdentity
    );
    expect(first.situation.stage).toBe("act_notify");
    expect(localTelegram.calls).toHaveLength(1);
    expect(localTelegram.calls[0]?.parameters.message).toBe(frozenMessage); // teksten fra reason A - ALDRI reason B.
    const { rows } = await adminPool.query(
      `SELECT status FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2`,
      [TENANT_OWNER, computeNotifyKey(finalKey, situationId, frozenMessage)]
    );
    expect((rows[0] as { status: string } | undefined)?.status).toBe("succeeded"); // beviset ligger under den FROSNE nøkkelen.

    // Enda en re-deteksjon (reason C) + retry: nøkkelen er fortsatt den frosne -> ZERO nye transportkall.
    await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:frozen-notify-first-send", priority: "high", confidence: 0.9, reason: "Reason C - enda en omformulering"
    });
    const retry = await engine.actOn(
      TENANT_OWNER, "business", situationId, { tool_id: "test_actuator", action: "flip", parameters: {}, idempotency_key: "frozen-first-send-key" }, g, ownerIdentity
    );
    expect(retry.situation.stage).toBe("act_notify");
    expect(localTelegram.calls).toHaveLength(1); // fortsatt nøyaktig ETT varsel totalt.
  });

  it("en claim UTEN frossen varseltekst er strukturelt umulig - databasen avviser den (situations_act_notify_message_frozen_ck)", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:frozen-notify-check", priority: "high", confidence: 0.9, reason: "CHECK-test"
    });
    await expect(
      adminPool.query(
        `UPDATE situations SET act_claimed_at = now(), act_idempotency_key = $1, act_operation_fingerprint = $2 WHERE situation_id = $3`,
        [`situation:${situation.situation_id}:check-key`, computeActOperationFingerprint(situation.situation_id, "test_actuator", "flip", {}), situation.situation_id]
      )
    ).rejects.toThrow(/situations_act_notify_message_frozen_ck/);
  });

  it("claim-feltene er IMMUTABLE på DB-nivå mens claimen står - en senere UPDATE som endrer act_notify_message (eller nøkkel/fingeravtrykk) avvises (situations_act_claim_immutable), mens frigjøring (alle -> NULL) fortsatt er tillatt", async () => {
    const { situationId } = await seedSucceededActAt("infra:actuator:frozen-notify-immutable", "frozen-immutable-key", "Reason A - immutabel");
    await expect(
      adminPool.query(`UPDATE situations SET act_notify_message = $1 WHERE situation_id = $2`, ["En omskrevet varseltekst", situationId])
    ).rejects.toThrow(/situations_act_claim_immutable/);
    await expect(
      adminPool.query(`UPDATE situations SET act_idempotency_key = $1 WHERE situation_id = $2`, [`situation:${situationId}:annen-key`, situationId])
    ).rejects.toThrow(/situations_act_claim_immutable/);
    await expect(
      adminPool.query(`UPDATE situations SET act_operation_fingerprint = $1 WHERE situation_id = $2`, ["deadbeef", situationId])
    ).rejects.toThrow(/situations_act_claim_immutable/);
    // Ikke-claim-felter kan fortsatt oppdateres (det er dette evaluateCandidate() gjør ved re-deteksjon).
    await adminPool.query(`UPDATE situations SET reason = $1 WHERE situation_id = $2`, ["Reason B - lov aa endre", situationId]);
    // Eksplisitt frigjøring (alle claim-felt -> NULL sammen) er tillatt - samme form som releaseStuckActClaim().
    await adminPool.query(
      `UPDATE situations SET act_claimed_at = NULL, act_idempotency_key = NULL, act_operation_fingerprint = NULL, act_notify_message = NULL WHERE situation_id = $1`,
      [situationId]
    );
    const { rows } = await adminPool.query(`SELECT act_idempotency_key, act_notify_message, reason FROM situations WHERE situation_id = $1`, [situationId]);
    const row = rows[0] as { act_idempotency_key: string | null; act_notify_message: string | null; reason: string };
    expect(row.act_idempotency_key).toBeNull();
    expect(row.act_notify_message).toBeNull();
    expect(row.reason).toBe("Reason B - lov aa endre");
  });

  it("en normal, fersk ACT via actOn() fryser varselteksten fra reason-en ved claimen, og en re-deteksjon etterpå endrer IKKE den frosne teksten", async () => {
    const REASON_A = "Reason A - fersk ACT";
    const { situation } = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:frozen-notify-fresh", priority: "high", confidence: 0.9, reason: REASON_A
    });
    const { g, localTelegram } = localGateway();
    const acted = await engine.actOn(
      TENANT_OWNER, "business", situation.situation_id, { tool_id: "test_actuator", action: "flip", parameters: {} }, g, ownerIdentity
    );
    expect(acted.situation.stage).toBe("act_notify");
    expect(acted.situation.act_notify_message).toBe(buildNotifyMessage(REASON_A, "test_actuator", "flip"));
    expect(localTelegram.calls[0]?.parameters.message).toBe(buildNotifyMessage(REASON_A, "test_actuator", "flip"));

    const redetected = await engine.evaluateCandidate(TENANT_OWNER, "business", {
      domain: "infra", detection_key: "infra:actuator:frozen-notify-fresh", priority: "high", confidence: 0.9, reason: "Reason B - etter ACT+NOTIFY"
    });
    expect(redetected.situation.reason).toBe("Reason B - etter ACT+NOTIFY");
    expect(redetected.situation.act_notify_message).toBe(buildNotifyMessage(REASON_A, "test_actuator", "flip"));
    expect(redetected.situation.stage).toBe("act_notify");
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { PgApprovalStore, createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, homeAssistantTools, type SecretProvider, type ToolTransport } from "@jarvis/tool-gateway";

/**
 * UA-8 akseptansekriterium 3: "kritiske hjemme-/bilhandlinger verifiserer
 * faktisk resulterende tilstand og gjør feil synlige umiddelbart."
 *
 * `ToolGateway.execute()` sin generiske klasse C/D preflight→execute→readback-
 * pipeline er allerede bevist generisk andre steder (se
 * `modules/tool-gateway/test/ua1-p1a-dclass-mesh.test.ts` og
 * `modules/tool-gateway/test/fase9-home.test.ts`, sistnevnte for HA-spesifikk
 * godkjenningsgating). Denne filen beviser IKKE pipelinen på nytt generisk -
 * den beviser den SPESIFIKT for `home-assistant.ts` sine to klasse D-
 * handlinger (`lock_set`, `alarm_set`) med en HA-realistisk fake-transport som
 * har egen tilstand per entity/rom og kan simulere hvert feilpunkt (preflight/
 * mutasjon/readback) uavhengig og entitets-/rom-eksistens.
 *
 * Godkjenningsgating (signert approval kreves for klasse D via tale/enhver
 * kanal) er allerede bevist i fase9-home.test.ts/ua1-p1a-dclass-mesh.test.ts -
 * her brukes derfor en OWNER SOVEREIGN-identitet (ingen delegation_id, eier-
 * tenant i PolicyGateway sin authority-konfig) slik at hver test isolert kan
 * bevise preflight/readback-beviset uten å måtte generere en ny signert
 * godkjenning per scenario.
 */

const PORT = 30000 + Math.floor(Math.random() * 20000);

let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;

const ownerIdentity: IdentityContext = {
  person_id: "person-tobias",
  tenant_id: "tenant-a",
  memory_space_id: "home",
  session_id: "sess-ha-critical",
  device_id: "dev-pc",
  channel: "api",
  auth_strength: "active"
};

const secrets: SecretProvider = { name: "test", async get() { return "ha-token"; } };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pgha-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "pw2" });
  const devices = new InMemoryDeviceRegistry();
  policy = new PolicyGateway({
    devices,
    nonces: new PgApprovalStore(appPool),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-a"] }
  });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

/**
 * HA-realistisk fake-transport: modellerer det ekte `read_state`/`lock_set`/
 * `alarm_set`-handlingskontraktet (INTEGRATIONS.md §5) med egen tilstand per
 * lås-entity og per alarmsone (site_id:room_id), og lar hvert test-scenario
 * simulere et feilpunkt UAVHENGIG (kun preflight, kun mutasjon, kun readback)
 * - noe den delte `FakeTransport` i `integrations.ts` (én global `failWith`
 * som feiler ALLE kall) ikke kan skille mellom. `strictEntityCheck` modellerer
 * hvordan en ekte HA-instans oppfører seg for en ukjent entity/sone: kaster
 * (404/ukjent entity) i stedet for å stille returnere en tom/default-tilstand.
 */
class HaScenarioTransport implements ToolTransport {
  calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  private readonly locks: Map<string, boolean>;
  private readonly alarms: Map<string, boolean>;
  private mutationHappened = false;

  constructor(
    private readonly opts: {
      knownLocks?: Record<string, boolean>;
      knownAlarms?: Record<string, boolean>;
      strictEntityCheck?: boolean;
      failPreflight?: boolean;
      failMutation?: boolean;
      failReadback?: boolean;
    } = {}
  ) {
    this.locks = new Map(Object.entries(opts.knownLocks ?? {}));
    this.alarms = new Map(Object.entries(opts.knownAlarms ?? {}));
  }

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push({ action, parameters });

    if (action === "read_state") {
      const isPreflight = !this.mutationHappened;
      if (isPreflight && this.opts.failPreflight) {
        throw new Error("ha_device_offline");
      }
      if (!isPreflight && this.opts.failReadback) {
        throw new Error("ha_unreachable_after_command");
      }
      const entity = parameters["entity"];
      if (typeof entity === "string") {
        const locked = this.locks.get(entity);
        if (locked === undefined) {
          if (this.opts.strictEntityCheck) throw new Error(`no_such_entity:${entity}`);
          return { data: null };
        }
        return { data: { locked } };
      }
      const roomKey = `${String(parameters["site_id"])}:${String(parameters["room_id"])}`;
      const armed = this.alarms.get(roomKey);
      if (armed === undefined) {
        if (this.opts.strictEntityCheck) throw new Error(`no_such_alarm_zone:${roomKey}`);
        return { data: null };
      }
      return { data: { armed } };
    }

    if (action === "lock_set") {
      this.mutationHappened = true;
      if (this.opts.failMutation) throw new Error("ha_lock_command_rejected");
      const entity = parameters["entity"] as string;
      const locked = parameters["locked"] as boolean;
      this.locks.set(entity, locked);
      return { external_id: `ha-lock-${entity}` };
    }

    if (action === "alarm_set") {
      this.mutationHappened = true;
      if (this.opts.failMutation) throw new Error("ha_alarm_command_rejected");
      const roomKey = `${String(parameters["site_id"])}:${String(parameters["room_id"])}`;
      const armed = parameters["armed"] as boolean;
      this.alarms.set(roomKey, armed);
      return { external_id: `ha-alarm-${roomKey}` };
    }

    throw new Error(`unhandled_ha_action:${action}`);
  }
}

function makeGateway(transport: HaScenarioTransport): ToolGateway {
  const gateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of homeAssistantTools(transport)) gateway.register(tool);
  return gateway;
}

async function lastAudit(toolId: string, action: string, type: string): Promise<{ payload: Record<string, unknown> } | undefined> {
  const result = await adminPool.query(
    `SELECT payload FROM audit_events WHERE tool_id = $1 AND action = $2 AND type = $3 ORDER BY at DESC LIMIT 1`,
    [toolId, action, type]
  );
  return result.rows[0] as { payload: Record<string, unknown> } | undefined;
}

describe("A/E: lock_set og alarm_set - vellykket kall leser faktisk før/etter-tilstand", () => {
  it("lock_set: read_state FØR og ETTER, audit har ekte locked-verdier (ikke placeholder)", async () => {
    const transport = new HaScenarioTransport({ knownLocks: { "lock.ytterdor": true } });
    const gateway = makeGateway(transport);
    const parameters = { site_id: "site-hus", room_id: "rom-gang", entity: "lock.ytterdor", locked: false };

    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "home-assistant", action: "lock_set", parameters
    });

    expect(result.ok).toBe(true);
    expect(transport.calls.map((c) => c.action)).toEqual(["read_state", "lock_set", "read_state"]);

    const audit = await lastAudit("home-assistant", "lock_set", "tool.executed");
    expect(audit).toBeDefined();
    expect(audit!.payload["before_state"]).toEqual({ locked: true });
    expect(audit!.payload["after_state"]).toEqual({ locked: false });
  });

  it("alarm_set: read_state FØR og ETTER, audit har ekte armed-verdier (ikke placeholder)", async () => {
    const transport = new HaScenarioTransport({ knownAlarms: { "site-hus:rom-gang": false } });
    const gateway = makeGateway(transport);
    const parameters = { site_id: "site-hus", room_id: "rom-gang", armed: true };

    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "home-assistant", action: "alarm_set", parameters
    });

    expect(result.ok).toBe(true);
    expect(transport.calls.map((c) => c.action)).toEqual(["read_state", "alarm_set", "read_state"]);

    const audit = await lastAudit("home-assistant", "alarm_set", "tool.executed");
    expect(audit).toBeDefined();
    expect(audit!.payload["before_state"]).toEqual({ armed: false });
    expect(audit!.payload["after_state"]).toEqual({ armed: true });
  });
});

describe("B/E: preflight-feil (HA offline) → fail-closed, INGEN kommando sendt", () => {
  it("lock_set: read_state feiler FØR → DENY, lock_set-handleren ble aldri kalt", async () => {
    const transport = new HaScenarioTransport({ knownLocks: { "lock.ytterdor": true }, failPreflight: true });
    const gateway = makeGateway(transport);
    const parameters = { site_id: "site-hus", room_id: "rom-gang", entity: "lock.ytterdor", locked: false };

    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "home-assistant", action: "lock_set", parameters
    });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/^preflight_failed:/);
    expect(transport.calls.filter((c) => c.action === "lock_set")).toHaveLength(0);
  });

  it("alarm_set: read_state feiler FØR → DENY, alarm_set-handleren ble aldri kalt", async () => {
    const transport = new HaScenarioTransport({ knownAlarms: { "site-hus:rom-gang": false }, failPreflight: true });
    const gateway = makeGateway(transport);
    const parameters = { site_id: "site-hus", room_id: "rom-gang", armed: true };

    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "home-assistant", action: "alarm_set", parameters
    });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/^preflight_failed:/);
    expect(transport.calls.filter((c) => c.action === "alarm_set")).toHaveLength(0);
  });
});

describe("C/E: mutasjonskallet feiler → ok:false umiddelbart + tool.failed-audit, aldri stille svelget", () => {
  it("lock_set: HA returnerer feil på selve lås-kommandoen", async () => {
    const transport = new HaScenarioTransport({ knownLocks: { "lock.ytterdor": true }, failMutation: true });
    const gateway = makeGateway(transport);
    const parameters = { site_id: "site-hus", room_id: "rom-gang", entity: "lock.ytterdor", locked: false };

    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "home-assistant", action: "lock_set", parameters
    });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/^tool_failed:/);
    const audit = await lastAudit("home-assistant", "lock_set", "tool.failed");
    expect(audit).toBeDefined();
    expect(audit!.payload["credential_ref"]).toBe("JARVIS_HA_TOKEN");
  });

  it("alarm_set: HA returnerer feil på selve alarm-kommandoen", async () => {
    const transport = new HaScenarioTransport({ knownAlarms: { "site-hus:rom-gang": false }, failMutation: true });
    const gateway = makeGateway(transport);
    const parameters = { site_id: "site-hus", room_id: "rom-gang", armed: true };

    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "home-assistant", action: "alarm_set", parameters
    });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/^tool_failed:/);
    const audit = await lastAudit("home-assistant", "alarm_set", "tool.failed");
    expect(audit).toBeDefined();
  });
});

describe("D/E: handlingen LYKTES, men readback-lesingen etterpå feiler → ok:true, after_state mangler", () => {
  it("lock_set: dør ble faktisk låst, men post-lesing feiler (HA blir utilgjengelig rett etter)", async () => {
    const transport = new HaScenarioTransport({ knownLocks: { "lock.ytterdor": true }, failReadback: true });
    const gateway = makeGateway(transport);
    const parameters = { site_id: "site-hus", room_id: "rom-gang", entity: "lock.ytterdor", locked: false };

    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "home-assistant", action: "lock_set", parameters
    });

    // Handlingen SKJEDDE (mutasjonskallet gikk gjennom uten feil):
    expect(result.ok).toBe(true);
    expect(transport.calls.map((c) => c.action)).toEqual(["read_state", "lock_set", "read_state"]);

    const audit = await lastAudit("home-assistant", "lock_set", "tool.executed");
    expect(audit).toBeDefined();
    expect(audit!.payload["before_state"]).toEqual({ locked: true });
    // readback-feilen skjuler ALDRI at handlingen skjedde - men den beviser
    // heller ikke en ny tilstand den ikke fikk observert:
    expect(audit!.payload["after_state"]).toBeNull();
  });

  it("alarm_set: alarm ble faktisk endret, men post-lesing feiler", async () => {
    const transport = new HaScenarioTransport({ knownAlarms: { "site-hus:rom-gang": false }, failReadback: true });
    const gateway = makeGateway(transport);
    const parameters = { site_id: "site-hus", room_id: "rom-gang", armed: true };

    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "home-assistant", action: "alarm_set", parameters
    });

    expect(result.ok).toBe(true);
    const audit = await lastAudit("home-assistant", "alarm_set", "tool.executed");
    expect(audit).toBeDefined();
    expect(audit!.payload["before_state"]).toEqual({ armed: false });
    expect(audit!.payload["after_state"]).toBeNull();
  });
});

describe("F: mål-validering (entity/rom som ikke finnes) - viser FAKTISK dagens oppførsel, ikke en påstått kontroll", () => {
  it("STRENG transport (som en ekte HA som feiler på ukjent entity ville gjort): preflight feiler → fail-closed, INGEN kommando sendt", async () => {
    const transport = new HaScenarioTransport({ knownLocks: { "lock.ytterdor": true }, strictEntityCheck: true });
    const gateway = makeGateway(transport);
    const parameters = { site_id: "site-hus", room_id: "rom-ukjent", entity: "lock.finnes-ikke", locked: false };

    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "home-assistant", action: "lock_set", parameters
    });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/^preflight_failed:/);
    expect(transport.calls.filter((c) => c.action === "lock_set")).toHaveLength(0);
  });

  it("STRENG transport, alarm_set mot ukjent sone: preflight feiler → fail-closed", async () => {
    const transport = new HaScenarioTransport({ knownAlarms: { "site-hus:rom-gang": false }, strictEntityCheck: true });
    const gateway = makeGateway(transport);
    const parameters = { site_id: "site-hus", room_id: "rom-ukjent", armed: true };

    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "home-assistant", action: "alarm_set", parameters
    });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/^preflight_failed:/);
    expect(transport.calls.filter((c) => c.action === "alarm_set")).toHaveLength(0);
  });

  /**
   * FUNN (rapporteres, ikke skjult): verken `home-assistant.ts` sitt
   * input-skjema (kun `z.string()` for `entity`/`room_id` - typekontroll, ikke
   * eksistenskontroll) eller `ToolGateway.execute()` sin generiske pipeline
   * gjør noen EGEN sjekk av at `entity`/`room_id` faktisk finnes. Fail-closed
   * for et ukjent mål virker KUN fordi preflight-`read_state`-kallet feiler -
   * altså er mål-validering i dag 100% delegert til at den virkelige HA-
   * transporten (i dag et uverifisert HTTP-skall, se `UnconfiguredHttpTransport`
   * i integrations.ts) faktisk kaster/feiler for et ukjent entity/rom i stedet
   * for å stille returnere en tom/default-tilstand. Testen under beviser at
   * OM transporten IKKE gjør det (en lempelig/naiv reell HA-oppsett, eller en
   * fremtidig transport-bug), rapporterer gatewayen `ok: true` for en
   * lås/alarm-kommando mot et mål som aldri fantes - INGEN uavhengig
   * eksistenskontroll fanger det opp i dag.
   */
  it("LEMPELIG transport (dagens reelle gap): ukjent entity/rom gir INGEN feil → mutasjonen rapporteres ok:true", async () => {
    const transport = new HaScenarioTransport({ knownLocks: { "lock.ytterdor": true }, strictEntityCheck: false });
    const gateway = makeGateway(transport);
    const parameters = { site_id: "site-hus", room_id: "rom-ukjent", entity: "lock.finnes-ikke", locked: false };

    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "home-assistant", action: "lock_set", parameters
    });

    // Dette ER gapet: gatewayen har ingen egen mål-eksistenskontroll, så en
    // lempelig transport lar en kommando mot et oppdiktet mål lykkes.
    expect(result.ok).toBe(true);
    expect(transport.calls.map((c) => c.action)).toEqual(["read_state", "lock_set", "read_state"]);
  });
});

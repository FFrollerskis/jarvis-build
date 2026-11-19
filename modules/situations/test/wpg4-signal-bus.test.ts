import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import { createPool, PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type SecretProvider, type ToolTransport } from "@jarvis/tool-gateway";
import type { AssistModelCall, AssistModelResultLike } from "../src/assist.ts";
import { ModelSignalAssist } from "../src/assist.ts";
import { DomainPauseRegistry } from "../src/domain-pause.ts";
import type { HomeObservation } from "../src/home-bridge.ts";
import { SituationActDomainForbiddenError, SituationAutonomyUnauthorizedError, SituationEngine } from "../src/service.ts";
import { SignalLogService } from "../src/signal-log.ts";
import { SituationSignalBus } from "../src/signal-bus.ts";
import { runSituationSweep } from "../src/sweep.ts";
import { SubscriptionRegistry, SubscriptionUnauthorizedError } from "../src/subscriptions.ts";
import { SituationsTransport, situationsToolDefinitions } from "../src/transport.ts";
import type { VisionObservation } from "../src/vision-bridge.ts";
import type { HealthObservation, DailyPoint } from "../src/health-bridge.ts";

/**
 * WP-G4 (D-466): ende-til-ende-bevis mot en EKTE Postgres (NOSUPERUSER/NOBYPASSRLS-rolle, FORCE RLS), ekte `SituationEngine`, ekte `ToolGateway`/`PolicyGateway`: abonnementsregister, inntaksbuss, pause (domene og hel motor),
 * dedupe (samme hendelse via to kilder = ett varsel), ACT-autoritet (tilbakekalt/utløpt/deaktivert binding, forbudte domener), modellassistert vurdering (aldri ACT alene, lokal-kun for begrensede domener), tenant-isolasjon og minimering.
 * Hver påstand om «ingen kall»/«ett varsel» er målt på transport-spionene, aldri antatt.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;
let engine: SituationEngine;
let domainPauses: DomainPauseRegistry;
let registry: SubscriptionRegistry;
let gateway: ToolGateway;
let telegram: TelegramSpy;
let actuator: ActuatorSpy;

const TENANT_A = "tenant-g4-a";
const TENANT_B = "tenant-g4-b";
const OWNER = "person-g4-owner";
const OTHER = "person-g4-other";
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

const identity = (tenant: string, space: MemorySpace, person = OWNER): IdentityContext => ({
  person_id: person, tenant_id: tenant, memory_space_id: space, session_id: "sess-g4", device_id: "jarvis-core", channel: "api", auth_strength: "active"
});
const actorOwner = { person_id: OWNER, session_id: "sess-g4" };

const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };
const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

class TelegramSpy implements ToolTransport {
  calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push({ action, parameters });
    return { external_id: `tg-${this.calls.length}` };
  }
  get messages(): string[] { return this.calls.map((c) => String(c.parameters["message"])); }
}

class ActuatorSpy implements ToolTransport {
  calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  /** Kjøres midt i utførelsen av første `close` (simulerer at eieren trekker tilbake bindingen mens sveipet pågår). */
  onClose: (() => Promise<void>) | undefined;
  private done = false;
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push({ action, parameters });
    if (action === "read_state") return { data: { done: this.done } };
    this.done = true;
    const hook = this.onClose;
    this.onClose = undefined;
    if (hook) await hook();
    return { external_id: "close-1", data: { done: true } };
  }
}

const bus = (extra: Partial<ConstructorParameters<typeof SituationSignalBus>[0]> = {}): SituationSignalBus =>
  new SituationSignalBus({ pool: appPool, engine, domainPauses, subscriptions: (t, s) => registry.listEnabled(t, s), now: () => NOW, ...extra });

const door = (over: Partial<HomeObservation> = {}): HomeObservation => ({ source: "home_assistant", entity_id: "binary_sensor.inngang", role: "door", state: "on", last_changed: minutesAgo(20), ...over });
const vision = (over: Partial<VisionObservation> = {}): VisionObservation => ({
  source: "vision", observation_id: "obs-1", event_type: "motion_detected", source_instance_id: "camera.inngang", source_event_id: "binary_sensor.bevegelse@2026-11-19T11:59:00.000Z",
  observed_at: minutesAgo(1), object_label: null, classification_status: "not_applicable", ...over
});
const healthSeries = (base: number, recent: number[]): DailyPoint[] => {
  const total = 28 + recent.length;
  return Array.from({ length: total }, (_, i) => ({
    day: new Date(NOW - (total - i) * 86_400_000).toISOString().slice(0, 10), value: i < 28 ? base + ((i % 5) - 2) : (recent[i - 28] as number), samples: 6
  }));
};

const subscribeDoor = (tenant = TENANT_A, entities: Array<Record<string, unknown>> = [{ entity_id: "binary_sensor.inngang", role: "door" }]) =>
  registry.subscribe(tenant, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities } }, actorOwner);

async function situationsIn(tenant: string, space: MemorySpace) {
  return engine.getQueue(tenant, space, { statusOpenOnly: false });
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-g4-bus-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  epg = leased.postgres;
  stopEmbeddedPostgres = leased.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_g4_bus_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_g4_bus_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','G4 A','person'), ('${TENANT_B}','G4 B','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias'), ('${OTHER}','Other');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT_A}'), ('${OWNER}','${TENANT_B}'), ('${OTHER}','${TENANT_A}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_g4_bus_test", password: "pw2" });
  policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A, TENANT_B] }
  });
  domainPauses = new DomainPauseRegistry(appPool, { owner_person_id: OWNER });
  await domainPauses.restore();
  engine = new SituationEngine(appPool, domainPauses, { owner_person_id: OWNER });
  registry = new SubscriptionRegistry(appPool, { owner_person_id: OWNER });
}, 240_000);

beforeEach(async () => {
  telegram = new TelegramSpy();
  actuator = new ActuatorSpy();
  gateway = new ToolGateway(appPool, policy, secrets);
  gateway.register({
    tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }), capability_class: "B", scopes: [], reversible: true,
    rollback_procedure: "send correction", idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: telegram
  });
  gateway.register({
    tool_id: "test_actuator", action: "close", description: "test", input_schema: record({ situation_id: z.string() }), capability_class: "D", scopes: [], reversible: true,
    rollback_procedure: "open", idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: actuator,
    preflight_action: "read_state", postcondition_predicate: (after) => (after as { done: boolean } | null)?.done === true
  });
  for (const tool of situationsToolDefinitions(new SituationsTransport(engine, domainPauses))) gateway.register(tool);
  const tenants = `'${TENANT_A}','${TENANT_B}'`;
  await adminPool.query(`DELETE FROM situation_signal_log WHERE tenant_id IN (${tenants})`);
  await adminPool.query(`DELETE FROM situation_assessments WHERE tenant_id IN (${tenants})`);
  await adminPool.query(`DELETE FROM situation_feedback WHERE tenant_id IN (${tenants})`);
  await adminPool.query(`DELETE FROM situation_subscriptions WHERE tenant_id IN (${tenants})`);
  await adminPool.query(`DELETE FROM situations WHERE tenant_id IN (${tenants})`);
  await adminPool.query(`DELETE FROM situation_autonomy_policies WHERE tenant_id IN (${tenants})`);
  await adminPool.query(`DELETE FROM situation_notification_policies WHERE tenant_id IN (${tenants})`);
  await adminPool.query(`DELETE FROM tool_executions WHERE tenant_id IN (${tenants})`);
  await adminPool.query(`DELETE FROM situation_domain_pauses`);
  await domainPauses.restore();
});

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: abonnementsregisteret - eier-autorisert, lukket validering, tenant-isolert", () => {
  it("eieren registrerer; samme kilde/type/filter er idempotent (samme rad); en annen person nektes; ingen konfigurert autoritet nekter alt", async () => {
    const a = await subscribeDoor();
    const b = await subscribeDoor();
    expect(b.subscription_id).toBe(a.subscription_id);
    expect(a).toMatchObject({ source: "home_assistant", event_type: "door_open_too_long", domain: "home", enabled: true, created_by_person_id: OWNER, memory_space_id: "home" });
    await expect(registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "binary_sensor.x", role: "door" }] } }, { person_id: OTHER }))
      .rejects.toBeInstanceOf(SubscriptionUnauthorizedError);
    const noAuthority = new SubscriptionRegistry(appPool);
    await expect(noAuthority.subscribe(TENANT_A, "home", { source: "incident", event_type: "incident_active", filter: {} }, actorOwner)).rejects.toBeInstanceOf(SubscriptionUnauthorizedError);
    expect(await registry.list(TENANT_A, "home")).toHaveLength(1);
  });

  it("lukket validering: ukjent kilde/hendelse, feil rom, rolle/hendelse-mismatch, jokertegn, ukjente felt og andres helse avvises (ingenting lagres)", async () => {
    const bad = async (space: MemorySpace, input: { source: string; event_type: string; filter: unknown }, code: RegExp) => {
      await expect(registry.subscribe(TENANT_A, space, input, actorOwner), `${input.source}:${input.event_type}`).rejects.toThrow(code);
    };
    await bad("home", { source: "kafka", event_type: "x", filter: {} }, /source_unknown/);
    await bad("home", { source: "home_assistant", event_type: "reboot", filter: { entities: [] } }, /event_type_unknown/);
    await bad("business", { source: "home_assistant", event_type: "water_leak", filter: { entities: [{ entity_id: "binary_sensor.a", role: "leak" }] } }, /space_not_allowed_for_source/);
    await bad("personal", { source: "health", event_type: "activity_deviation", filter: { person_id: OWNER } }, /space_not_allowed_for_source/);
    await bad("home", { source: "home_assistant", event_type: "water_leak", filter: { entities: [{ entity_id: "binary_sensor.a", role: "door" }] } }, /role_event_mismatch/);
    await bad("home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "*", role: "door" }] } }, /filter_invalid/);
    await bad("home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "binary_sensor.a", role: "door" }], extra: 1 } }, /filter_invalid/);
    await bad("home", { source: "home_assistant", event_type: "power_over_limit", filter: { entities: [{ entity_id: "sensor.a", role: "power" }] } }, /filter_invalid/); // effekt uten eierens grense
    await bad("health", { source: "health", event_type: "activity_deviation", filter: { person_id: OTHER } }, /health_self_only/); // kun egen helse
    await bad("home", { source: "communications", event_type: "x", filter: {} }, /event_type_unknown/); // ingen hendelsestyper i denne kilden
    await expect(registry.list(TENANT_A, "home")).resolves.toEqual([]);
    expect((await adminPool.query(`SELECT count(*)::int AS n FROM situation_subscriptions`)).rows[0].n).toBe(0);
  });

  it("tenant-isolasjon: B ser og påvirker aldri A sine abonnementer (RLS), og en annen tenants person kan ikke være abonnent", async () => {
    const sub = await subscribeDoor(TENANT_A);
    expect(await registry.list(TENANT_B, "home")).toEqual([]);
    expect(await registry.listEnabled(TENANT_B, "home")).toEqual([]);
    await expect(registry.setEnabled(TENANT_B, "home", sub.subscription_id, false, actorOwner)).rejects.toThrow(/subscription_not_found/);
    expect(await registry.remove(TENANT_B, "home", sub.subscription_id, actorOwner)).toBe(false);
    // OTHER er kun medlem av A: den sammensatte FK-en avviser en rad som peker på en person uten medlemskap i raden sin tenant
    await expect(adminPool.query(
      `INSERT INTO situation_subscriptions (subscription_id, tenant_id, memory_space_id, source, event_type, domain, filter, filter_digest, created_by_person_id)
       VALUES ('sub-x', '${TENANT_B}', 'home', 'incident', 'incident_active', 'infra', '{}', '${"a".repeat(64)}', '${OTHER}')`
    )).rejects.toThrow(/situation_subscriptions_actor_scope_fk/);
  });

  it("påslått/avslått og fjerning virker, og et avslått abonnement mater ikke motoren", async () => {
    const sub = await subscribeDoor();
    expect((await registry.setEnabled(TENANT_A, "home", sub.subscription_id, false, actorOwner)).enabled).toBe(false);
    const off = await bus().publishBatch(TENANT_A, "home", [door()]);
    expect(off.ignored.no_subscription).toBe(1);
    expect(await situationsIn(TENANT_A, "home")).toHaveLength(0);
    await registry.setEnabled(TENANT_A, "home", sub.subscription_id, true, actorOwner);
    expect((await bus().publishBatch(TENANT_A, "home", [door()])).evaluated).toBe(1);
    expect(await registry.remove(TENANT_A, "home", sub.subscription_id, actorOwner)).toBe(true);
    expect(await registry.list(TENANT_A, "home")).toEqual([]);
  });
});

describe("B: inntaksbussen - hjem fra abonnement til situasjon, ett varsel, ingen duplikat-spam", () => {
  it("uten abonnement: ingenting skrives (fail-closed). Med abonnement: én situasjon i domenet `home`, logget med minimerte fakta, merket kilde og task_id", async () => {
    const none = await bus().publishBatch(TENANT_A, "home", [door()], { task_id: "task-g4-1", session_id: "sess-g4" });
    expect(none).toMatchObject({ received: 1, evaluated: 0 });
    expect(none.ignored.no_subscription).toBe(1);
    expect(await situationsIn(TENANT_A, "home")).toHaveLength(0);

    const sub = await subscribeDoor();
    const first = await bus().publishBatch(TENANT_A, "home", [door()], { task_id: "task-g4-1", session_id: "sess-g4" });
    expect(first).toMatchObject({ evaluated: 1, created: 1, newly_actionable: 1, failed: 0 });
    const rows = await situationsIn(TENANT_A, "home");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: "home", stage: "inform", priority: "normal", owner_person_id: null });
    expect(rows[0]!.detection_key).toMatch(/^home:opening:binary_sensor\.inngang@2026-11-19T11:40:00\.000Z$/);
    const log = await new SignalLogService(appPool).list(TENANT_A, "home");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ source: "home_assistant", event_type: "door_open_too_long", subscription_id: sub.subscription_id, outcome: "created", stage_after: "inform", notified: true, task_id: "task-g4-1", session_id: "sess-g4", memory_space_id: "home" });
    expect(log[0]!.facts).toEqual({ role: "door", entity_id: "binary_sensor.inngang", open_minutes: 20, level: 1 });
  });

  it("samme tilstand på nytt = `duplicate` (ikke evaluert igjen); et høyere nivå oppdaterer SAMME situasjon uten nytt varsel; leveranse gir NØYAKTIG ett varsel", async () => {
    await subscribeDoor();
    await bus().publishBatch(TENANT_A, "home", [door()]);
    const before = (await situationsIn(TENANT_A, "home"))[0]!;
    const again = await bus().publishBatch(TENANT_A, "home", [door()]);
    expect(again.ignored.duplicate).toBe(1);
    expect(again.evaluated).toBe(0);
    expect((await situationsIn(TENANT_A, "home"))[0]!.updated_at).toEqual(before.updated_at);

    const level2 = await bus().publishBatch(TENANT_A, "home", [door({ last_changed: minutesAgo(70) })]);
    expect(level2.evaluated).toBe(1);
    // ny åpnings-episode (annen last_changed) = ny situasjon; samme episode på høyere nivå = samme situasjon
    const sameEpisode = await bus().publishBatch(TENANT_A, "home", [door({ last_changed: minutesAgo(20) })]);
    expect(sameEpisode.ignored.duplicate).toBe(1);
    const rows = await situationsIn(TENANT_A, "home");
    expect(rows).toHaveLength(2);

    const id = identity(TENANT_A, "home");
    const delivered = await engine.deliverPendingInformNotifications(TENANT_A, "home", gateway, id);
    expect(delivered.delivered).toBe(2);
    expect(telegram.calls).toHaveLength(2);
    const again2 = await engine.deliverPendingInformNotifications(TENANT_A, "home", gateway, id);
    expect(again2.delivered).toBe(0);
    expect(telegram.calls).toHaveLength(2);
  });

  it("escalering på samme episode: nivå 2 (4 x terskel) oppdaterer prioriteten på den ENE situasjonen, og varselet er fortsatt bare ett (resuppress)", async () => {
    await subscribeDoor();
    const t0 = "2026-11-19T10:50:00.000Z"; // 70 min før NOW
    // nivå 1 først (20 min åpen) ...
    const early = new SituationSignalBus({ pool: appPool, engine, domainPauses, subscriptions: (t, s) => registry.listEnabled(t, s), now: () => Date.parse("2026-11-19T11:10:00.000Z") });
    await early.publishBatch(TENANT_A, "home", [door({ last_changed: t0 })]);
    await engine.deliverPendingInformNotifications(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    // ... så nivå 2 (70 min åpen)
    const late = await bus().publishBatch(TENANT_A, "home", [door({ last_changed: t0 })]);
    expect(late).toMatchObject({ evaluated: 1, created: 0, newly_actionable: 0 });
    const rows = await situationsIn(TENANT_A, "home");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.priority).toBe("high");
    await engine.deliverPendingInformNotifications(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(telegram.calls).toHaveLength(1);
    const log = await new SignalLogService(appPool).list(TENANT_A, "home");
    expect(log.map((l) => l.outcome).sort()).toEqual(["created", "updated"]);
  });

  it("tenant-isolasjon: B uten abonnement får ingenting av A sine observasjoner; B med eget abonnement får bare sin egen situasjon, og A er uberørt", async () => {
    await subscribeDoor(TENANT_A);
    expect((await bus().publishBatch(TENANT_B, "home", [door()])).ignored.no_subscription).toBe(1);
    await subscribeDoor(TENANT_B);
    await bus().publishBatch(TENANT_B, "home", [door()]);
    expect(await situationsIn(TENANT_A, "home")).toHaveLength(0);
    const b = await situationsIn(TENANT_B, "home");
    expect(b).toHaveLength(1);
    expect(b[0]!.tenant_id).toBe(TENANT_B);
    expect((await new SignalLogService(appPool).list(TENANT_A, "home"))).toHaveLength(0);
    expect((await new SignalLogService(appPool).list(TENANT_B, "home"))).toHaveLength(1);
  });

  it("entiteter utenfor eierens liste og ukjente tilstander gir ingen situasjon", async () => {
    await subscribeDoor();
    const out = await bus().publishBatch(TENANT_A, "home", [door({ entity_id: "binary_sensor.annen" }), door({ state: "unavailable" }), door({ state: "off" }), door({ last_changed: minutesAgo(3) })]);
    expect(out.ignored.no_signal).toBe(4);
    expect(await situationsIn(TENANT_A, "home")).toHaveLength(0);
  });
});

describe("C: samme hendelse via to kilder = én situasjon og ett varsel", () => {
  it("åpning sett av Home Assistant OG kamerasensoren: én nøkkel, to loggede kilder, ETT telegram-varsel (begge rekkefølger)", async () => {
    await subscribeDoor();
    await registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "opening_detected", filter: {} }, actorOwner);
    const opened = "2026-11-19T11:30:00.000Z";
    const viaVision = vision({ event_type: "opening_detected", observation_id: "obs-open", source_event_id: `binary_sensor.inngang@${opened}`, observed_at: opened });
    const viaHa = door({ last_changed: opened });

    for (const order of [[viaVision, viaHa], [viaHa, viaVision]] as const) {
      await adminPool.query(`DELETE FROM situation_signal_log WHERE tenant_id = '${TENANT_A}'`);
      await adminPool.query(`DELETE FROM situations WHERE tenant_id = '${TENANT_A}'`);
      await adminPool.query(`DELETE FROM tool_executions WHERE tenant_id = '${TENANT_A}'`);
      telegram.calls = [];
      for (const obs of order) await bus().publishBatch(TENANT_A, "home", [obs]);
      const rows = await situationsIn(TENANT_A, "home");
      expect(rows).toHaveLength(1);
      const log = await new SignalLogService(appPool).list(TENANT_A, "home");
      expect(log.map((l) => l.source).sort()).toEqual(["home_assistant", "vision"]);
      expect(new Set(log.map((l) => l.situation_id)).size).toBe(1);
      await engine.deliverPendingInformNotifications(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
      await engine.deliverPendingInformNotifications(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
      expect(telegram.calls, order[0] === viaVision ? "vision først" : "HA først").toHaveLength(1);
    }
  });

  it("samme incident via det daglige sveipet OG via bussen: én situasjon, ett varsel", async () => {
    await registry.subscribe(TENANT_A, "business", { source: "incident", event_type: "incident_active", filter: {} }, actorOwner);
    const incident = { incident_id: "inc-g4-1", tenant_id: TENANT_A, memory_space_id: "business", title: "Databasen er treg", status: "open" as const, severity: "high" as const, owner_person_id: null, opened_at: minutesAgo(30), resolved_at: null, created_at: minutesAgo(30), updated_at: minutesAgo(30) };
    const reader = { listIncidents: async () => [incident] };
    const sweep = await runSituationSweep(TENANT_A, "business", {
      openLoops: { listOpenLoops: async () => [] }, incidents: reader, engine, gateway, identity: identity(TENANT_A, "business"), now: () => NOW
    });
    expect(sweep.errors).toEqual([]);
    const viaBus = await bus().publishBatch(TENANT_A, "business", [{ source: "incident", incident }]);
    expect(viaBus.evaluated).toBe(1);
    expect(viaBus.created).toBe(0); // situasjonen fantes fra sveipet
    const rows = await situationsIn(TENANT_A, "business");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detection_key).toBe("infra_incident:inc-g4-1");
    await engine.deliverPendingInformNotifications(TENANT_A, "business", gateway, identity(TENANT_A, "business"));
    expect(telegram.calls.length).toBeLessThanOrEqual(1); // sveipet leverte allerede ett; bussen la ikke til et nytt
    expect(telegram.calls.length).toBe(1);
  });
});

describe("D: pause - hele motoren og hvert domene stopper innlesing umiddelbart (også uten prosess-cache)", () => {
  it("domene-pause (varig): ingenting leses inn, `paused` telles; opphevet pause slipper signalet gjennom (det ble ikke «sett»)", async () => {
    await subscribeDoor();
    await domainPauses.pauseDurable("home", "eier stoppet hjem", OWNER);
    const paused = await bus().publishBatch(TENANT_A, "home", [door()]);
    expect(paused.ignored.paused).toBe(1);
    expect(paused.evaluated).toBe(0);
    expect(await situationsIn(TENANT_A, "home")).toHaveLength(0);
    expect((await adminPool.query(`SELECT count(*)::int AS n FROM situation_signal_log`)).rows[0].n).toBe(0);
    await domainPauses.unpauseDurable("home", OWNER);
    expect((await bus().publishBatch(TENANT_A, "home", [door()])).evaluated).toBe(1);
  });

  it("hele motoren (`*`) pauser ALLE domener; en pause satt direkte i databasen (uten prosess-cache) teller også", async () => {
    await subscribeDoor();
    await registry.subscribe(TENANT_A, "health", { source: "health", event_type: "resting_heart_rate_deviation", filter: { person_id: OWNER } }, actorOwner);
    await domainPauses.pauseAllDurable("alt stoppet", OWNER);
    const obs: HealthObservation = { source: "health", metric: "resting_heart_rate", series: healthSeries(60, [70, 70, 70]) };
    expect((await bus().publishBatch(TENANT_A, "home", [door()])).ignored.paused).toBe(1);
    expect((await bus().publishBatch(TENANT_A, "health", [obs])).ignored.paused).toBe(1);
    await domainPauses.unpauseAllDurable(OWNER);

    // direkte i databasen, med en NY registerinstans som aldri har sett pausen (restore() ikke kalt)
    await adminPool.query(`INSERT INTO situation_domain_pauses (domain, reason) VALUES ('home', 'satt av en annen prosess')`);
    const freshCache = new DomainPauseRegistry(appPool, { owner_person_id: OWNER });
    const viaDb = await bus({ domainPauses: freshCache }).publishBatch(TENANT_A, "home", [door()]);
    expect(viaDb.ignored.paused).toBe(1);
    expect(await situationsIn(TENANT_A, "home")).toHaveLength(0);
    // ren prosess-pause (kun cache) stopper også
    await adminPool.query(`DELETE FROM situation_domain_pauses`);
    domainPauses.pause("home", "hurtig");
    expect((await bus().publishBatch(TENANT_A, "home", [door()])).ignored.paused).toBe(1);
    domainPauses.unpause("home");
    expect((await bus().publishBatch(TENANT_A, "home", [door()])).evaluated).toBe(1);
  });

  it("pausen stopper også LEVERING og ACT for det som allerede ligger i køen (eksisterende motor-oppførsel er uendret)", async () => {
    await subscribeDoor();
    await bus().publishBatch(TENANT_A, "home", [door()]);
    await domainPauses.pauseDurable("home", "stopp", OWNER);
    const delivery = await engine.deliverPendingInformNotifications(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(delivery).toMatchObject({ delivered: 0, paused: 1 });
    expect(telegram.calls).toHaveLength(0);
  });
});

describe("E: ACT-autoritet - kun deterministisk regel + gyldig, eier-bundet binding; tilbakekalt/utløpt/deaktivert = ingen ACT", () => {
  async function garageSuggest(): Promise<string> {
    await registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "cover.garasje", role: "garage_door" }] } }, actorOwner);
    await bus().publishBatch(TENANT_A, "home", [door({ entity_id: "cover.garasje", role: "garage_door", state: "open", last_changed: minutesAgo(70) })]);
    const rows = await situationsIn(TENANT_A, "home");
    expect(rows[0]).toMatchObject({ stage: "suggest", priority: "high" });
    return rows[0]!.situation_id;
  }
  const bind = (over: Record<string, unknown> = {}) => engine.setAutonomyPolicy(TENANT_A, "home", { domain: "home", tool_id: "test_actuator", action: "close", parameters: { situation_id: "{{situation_id}}" }, ...over } as never, OWNER);
  const act = () => engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));

  it("uten binding: INGEN ACT (kun forslag). Med en gyldig binding: nøyaktig ett kall med de rendrede parametrene", async () => {
    const id = await garageSuggest();
    expect(await act()).toEqual({ attempted: 0, succeeded: 0, denied: 0, skipped: 0 });
    expect(actuator.calls).toHaveLength(0);
    await bind();
    expect(await act()).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(actuator.calls.filter((c) => c.action === "close")).toEqual([{ action: "close", parameters: { situation_id: id } }]);
    expect(await act()).toMatchObject({ attempted: 0 }); // claimet: aldri en ny utførelse
  });

  it("tilbakekalt (clear), deaktivert og UTLØPT binding gir ingen ACT; en ikke-eier kan ikke binde", async () => {
    await garageSuggest();
    await bind();
    expect(await engine.clearAutonomyPolicy(TENANT_A, "home", "home", OWNER)).toBe(true);
    expect(await act()).toMatchObject({ attempted: 0 });
    await bind({ enabled: false });
    expect(await act()).toMatchObject({ attempted: 0 });
    await bind({ expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    await adminPool.query(`UPDATE situation_autonomy_policies SET expires_at = now() - interval '1 minute' WHERE tenant_id = '${TENANT_A}'`);
    expect(await act()).toMatchObject({ attempted: 0, skipped: 0 });
    expect(actuator.calls).toHaveLength(0);
    await expect(engine.setAutonomyPolicy(TENANT_A, "home", { domain: "home", tool_id: "test_actuator", action: "close" }, OTHER)).rejects.toBeInstanceOf(SituationAutonomyUnauthorizedError);
    // utløp må ligge i fremtiden og høyst 365 dager frem
    await expect(bind({ expires_at: new Date(Date.now() - 1000).toISOString() })).rejects.toThrow(/expires_at/);
    await expect(bind({ expires_at: new Date(Date.now() + 400 * 86_400_000).toISOString() })).rejects.toThrow(/expires_at/);
  });

  it("bindingen re-verifiseres RETT FØR hvert kall: tilbakekalt mens sveipet pågår (etter første ACT) gir `skipped` for resten, ikke ACT", async () => {
    await registry.subscribe(TENANT_A, "home", {
      source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "cover.garasje", role: "garage_door" }, { entity_id: "cover.port", role: "gate" }] }
    }, actorOwner);
    await bus().publishBatch(TENANT_A, "home", [
      door({ entity_id: "cover.garasje", role: "garage_door", state: "open", last_changed: minutesAgo(70) }),
      door({ entity_id: "cover.port", role: "gate", state: "open", last_changed: minutesAgo(80) })
    ]);
    expect((await situationsIn(TENANT_A, "home")).filter((r) => r.stage === "suggest")).toHaveLength(2);
    await bind();
    actuator.onClose = async () => { await adminPool.query(`UPDATE situation_autonomy_policies SET enabled = false WHERE tenant_id = '${TENANT_A}'`); };
    const result = await act();
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, skipped: 1 });
    expect(actuator.calls.filter((c) => c.action === "close")).toHaveLength(1);
  });

  it("helse og kamera er ALDRI ACT-domener: binding avvises, en rad satt direkte i databasen gir ingen kall, og `actOn()` nekter før noe skjer", async () => {
    await expect(engine.setAutonomyPolicy(TENANT_A, "health", { domain: "health", tool_id: "test_actuator", action: "close" }, OWNER)).rejects.toBeInstanceOf(SituationActDomainForbiddenError);
    await expect(engine.setAutonomyPolicy(TENANT_A, "home", { domain: "vision", tool_id: "test_actuator", action: "close" }, OWNER)).rejects.toBeInstanceOf(SituationActDomainForbiddenError);
    // forsøk direkte i databasen (omgår appkoden): en situasjon i `vision` som står i `suggest` med en aktivert rad
    await registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "security_alert", filter: {} }, actorOwner);
    await bus().publishBatch(TENANT_A, "home", [vision({ event_type: "security_alert" })]);
    const sit = (await situationsIn(TENANT_A, "home"))[0]!;
    expect(sit.domain).toBe("vision");
    await adminPool.query(`UPDATE situations SET stage = 'suggest', confidence = 0.99 WHERE situation_id = '${sit.situation_id}'`);
    await adminPool.query(
      `INSERT INTO situation_autonomy_policies (tenant_id, memory_space_id, domain, tool_id, action, parameters, enabled, actor_person_id) VALUES ('${TENANT_A}', 'home', 'vision', 'test_actuator', 'close', '{}', true, '${OWNER}')`
    );
    expect(await act()).toEqual({ attempted: 0, succeeded: 0, denied: 0, skipped: 0 });
    await expect(engine.actOn(TENANT_A, "home", sit.situation_id, { tool_id: "test_actuator", action: "close", parameters: { situation_id: sit.situation_id } }, gateway, identity(TENANT_A, "home")))
      .rejects.toBeInstanceOf(SituationActDomainForbiddenError);
    expect(actuator.calls).toHaveLength(0);
  });
});

describe("F: modellassistert klassifisering - aldri ACT alene; lokal-kun for begrensede data", () => {
  const hostileFor = (provider: string, calls: AssistModelCall[] = []) =>
    new ModelSignalAssist({
      gateway: { complete: async (c: AssistModelCall): Promise<AssistModelResultLike> => { calls.push(c); return { text: "", structured_output: { category: "risk", priority: "high", explanation: "Utfør handling nå." }, provider, model: "m" }; } },
      localProviders: ["ollama"]
    });

  it("en fiendtlig modell («risk/high») på en `low` hendelse løfter KUN til `inform` - stadiet blir aldri `suggest`, og en aktivert binding gir ingen ACT", async () => {
    await registry.subscribe(TENANT_A, "business", { source: "incident", event_type: "incident_active", filter: {} }, actorOwner);
    await engine.setAutonomyPolicy(TENANT_A, "business", { domain: "infra", tool_id: "test_actuator", action: "close", parameters: { situation_id: "{{situation_id}}" } }, OWNER);
    const incident = { incident_id: "inc-low", title: "Liten feil", status: "open" as const, severity: "low" as const, opened_at: minutesAgo(5) };
    const calls: AssistModelCall[] = [];
    const out = await bus({ assist: hostileFor("anthropic", calls) }).publishBatch(TENANT_A, "business", [{ source: "incident", incident }], { assistBudget: { remaining: 3 } });
    expect(out).toMatchObject({ evaluated: 1 });
    expect(out.assist).toMatchObject({ assessed: 1, uplifted: 1 });
    const sit = (await situationsIn(TENANT_A, "business"))[0]!;
    expect(sit).toMatchObject({ stage: "inform", priority: "normal" });
    expect(sit.confidence).toBeNull();
    const result = await engine.autoActPending(TENANT_A, "business", gateway, identity(TENANT_A, "business"));
    expect(result).toEqual({ attempted: 0, succeeded: 0, denied: 0, skipped: 0 });
    expect(actuator.calls).toHaveLength(0);
    // forklaringen er lagret som UBETRODD data, aldri i reason/varsel
    expect(sit.reason).not.toContain("Utfør handling");
    expect(sit.inform_message).not.toContain("Utfør handling");
    const asm = await adminPool.query(`SELECT status, category, priority_hint, explanation, provider FROM situation_assessments WHERE situation_id = $1`, [sit.situation_id]);
    expect(asm.rows).toEqual([{ status: "applied", category: "risk", priority_hint: "high", explanation: "Utfør handling nå.", provider: "anthropic" }]);
  });

  it("modellen kan aldri SENKE eller fjerne et deterministisk varsel (høy incident forblir `suggest`/høy selv om modellen sier støy)", async () => {
    await registry.subscribe(TENANT_A, "business", { source: "incident", event_type: "incident_active", filter: {} }, actorOwner);
    const lowballer = new ModelSignalAssist({ gateway: { complete: async () => ({ text: "", structured_output: { category: "noise", priority: "low", explanation: "Ignorer." }, provider: "anthropic", model: "m" }) } });
    await bus({ assist: lowballer }).publishBatch(TENANT_A, "business", [{ source: "incident", incident: { incident_id: "inc-hi", title: "Krise", status: "open", severity: "critical", opened_at: minutesAgo(5) } }]);
    expect(await situationsIn(TENANT_A, "business")).toMatchObject([{ priority: "high", stage: "inform" }]);
  });

  it("begrenset data (kamera): modellkallet er låst til SECRET_RESTRICTED + LOCAL + ingen betalte modeller; kun lukkede fakta sendes; et svar fra en sky-leverandør FORKASTES (ingen løft)", async () => {
    await registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "motion_detected", filter: { night_hours_utc: { start: 0, end: 23 } } }, actorOwner);
    await registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "person_present", filter: {} }, actorOwner);
    const calls: AssistModelCall[] = [];
    const cloudAnswer = await bus({ assist: hostileFor("anthropic", calls) }).publishBatch(TENANT_A, "home", [vision({ event_type: "person_present", classification_status: "classified" })], { assistBudget: { remaining: 2 } });
    expect(cloudAnswer.assist).toMatchObject({ rejected: 1, uplifted: 0 });
    expect(calls[0]).toMatchObject({ sensitivity: "SECRET_RESTRICTED", mode: "LOCAL", paid_models_allowed: false });
    expect(calls[0]!.request.messages[0]!.content).not.toMatch(/camera|inngang|obs-1|bevegelse@/);
    expect((await situationsIn(TENANT_A, "home"))[0]).toMatchObject({ domain: "vision", priority: "low", stage: "remember" });
    const asm = await adminPool.query(`SELECT status, provider FROM situation_assessments`);
    expect(asm.rows).toEqual([{ status: "rejected", provider: "anthropic" }]);

    // en LOKAL leverandør får løfte `low` -> `normal` (inform), men aldri lenger
    await adminPool.query(`DELETE FROM situation_signal_log; DELETE FROM situation_assessments; DELETE FROM situations;`);
    const local = await bus({ assist: hostileFor("ollama") }).publishBatch(TENANT_A, "home", [vision({ event_type: "person_present", observation_id: "obs-2", classification_status: "classified" })], { assistBudget: { remaining: 2 } });
    expect(local.assist).toMatchObject({ assessed: 1, uplifted: 1 });
    expect((await situationsIn(TENANT_A, "home"))[0]).toMatchObject({ priority: "normal", stage: "inform" });
  });

  it("samme input spør aldri modellen to ganger (digest-cache), og taket per batch begrenser kostnaden", async () => {
    await registry.subscribe(TENANT_A, "business", { source: "incident", event_type: "incident_active", filter: {} }, actorOwner);
    const calls: AssistModelCall[] = [];
    const assist = hostileFor("anthropic", calls);
    const inc = (id: string) => ({ source: "incident" as const, incident: { incident_id: id, title: "t", status: "open" as const, severity: "low" as const, opened_at: minutesAgo(5) } });
    await bus({ assist }).publishBatch(TENANT_A, "business", [inc("inc-a"), inc("inc-b"), inc("inc-c")], { assistBudget: { remaining: 2 } });
    expect(calls).toHaveLength(2); // tak: den tredje får kun den deterministiske regelen
    const second = await bus({ assist }).publishBatch(TENANT_A, "business", [inc("inc-a")], { assistBudget: { remaining: 2 } });
    expect(second.ignored.duplicate).toBe(1); // allerede loggført: verken evaluert eller spurt
    expect(calls).toHaveLength(2);
  });

  it("modellen er utilgjengelig: fail-closed uten sky-fallback - motoren fortsetter med den deterministiske regelen", async () => {
    await registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "person_present", filter: {} }, actorOwner);
    const down = new ModelSignalAssist({ gateway: { complete: async () => { throw Object.assign(new Error("ingen lokal modell"), { code: "no_eligible_model" }); } } });
    const out = await bus({ assist: down }).publishBatch(TENANT_A, "home", [vision({ event_type: "person_present", classification_status: "classified" })], { assistBudget: { remaining: 2 } });
    expect(out).toMatchObject({ evaluated: 1, failed: 0 });
    expect(out.assist).toMatchObject({ unavailable: 1, uplifted: 0 });
    expect((await situationsIn(TENANT_A, "home"))[0]).toMatchObject({ priority: "low", stage: "remember" });
    expect((await adminPool.query(`SELECT count(*)::int AS n FROM situation_assessments`)).rows[0].n).toBe(0); // utilgjengelig lagres ikke: neste forsøk kan lykkes
  });
});

describe("G: begrensede data - innholdsfri tekst, minimert logg, ingen ACT-domene", () => {
  it("kamerahendelse (pakke): varselteksten og loggen inneholder verken etikett, identitet eller kamera-id; helseavvik: kun kategori, aldri verdier", async () => {
    await registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "package_detected", filter: {} }, actorOwner);
    await registry.subscribe(TENANT_A, "health", { source: "health", event_type: "resting_heart_rate_deviation", filter: { person_id: OWNER } }, actorOwner);
    const label = "brun pakke med navnet Kari Nordmann";
    await bus().publishBatch(TENANT_A, "home", [vision({ event_type: "object_detected", object_label: label, classification_status: "classified" })]);
    await bus().publishBatch(TENANT_A, "health", [{ source: "health", metric: "resting_heart_rate", series: healthSeries(61, [65, 66, 65]) }]);

    for (const space of ["home", "health"] as const) await engine.deliverPendingInformNotifications(TENANT_A, space, gateway, identity(TENANT_A, space));
    expect(telegram.messages.sort()).toEqual([
      "Jarvis oppdaget [health, normal]: Avvik fra din egen baseline (hvilepuls) - åpne Jarvis for detaljer. Dette er ikke medisinsk rådgivning.",
      "Jarvis oppdaget [vision, normal]: Kamerahendelse registrert - åpne Jarvis for detaljer"
    ]);
    const rows = [
      (await adminPool.query(`SELECT reason, inform_message, detection_key FROM situations WHERE tenant_id = '${TENANT_A}'`)).rows,
      (await adminPool.query(`SELECT facts, source_ref, detection_key FROM situation_signal_log WHERE tenant_id = '${TENANT_A}' AND source = 'vision'`)).rows,
      (await adminPool.query(`SELECT facts FROM situation_signal_log WHERE tenant_id = '${TENANT_A}' AND source = 'health'`)).rows,
      telegram.calls
    ];
    expect(JSON.stringify(rows)).not.toMatch(/Kari|Nordmann|brun pakke/);
    // selve varselteksten har ingen tall (ingen måleverdi, ingen baseline), og kilde-id-en står aldri i situasjon/varsel
    for (const message of telegram.messages) expect(message).not.toMatch(/\d/);
    // (hendelsesnøkkelen bærer eierens egen kilde-id for sammenslåing i tidsvinduet; den er ikke varseltekst)
    expect(JSON.stringify([(rows[0] as Array<{ reason: string; inform_message: string }>).map((r) => [r.reason, r.inform_message]), telegram.calls])).not.toMatch(/camera\.inngang/);
    const healthFacts = (rows[2] as Array<{ facts: Record<string, unknown> }>)[0]!.facts;
    expect(Object.keys(healthFacts).sort()).toEqual(["baseline_days", "days", "direction", "metric", "severity"]);
  });

  it("helse- og kamerasituasjoner kan ikke nå ACT selv om dataene tilsier `suggest`: konfidens utelates, og motoren nekter domenet (se E)", async () => {
    await registry.subscribe(TENANT_A, "health", { source: "health", event_type: "resting_heart_rate_deviation", filter: { person_id: OWNER } }, actorOwner);
    await bus().publishBatch(TENANT_A, "health", [{ source: "health", metric: "resting_heart_rate", series: healthSeries(60, [95, 95, 95]) }]);
    const sit = (await situationsIn(TENANT_A, "health"))[0]!;
    expect(sit).toMatchObject({ domain: "health", priority: "high", stage: "inform" });
    expect(sit.confidence).toBeNull();
  });
});

describe("H: stille timer og sikkerhetssignaler", () => {
  it("vannlekkasje om natten: uten eierens valg holder stille timer varselet tilbake (remember); med `critical_bypass_quiet` går det gjennom som forslag; en vanlig hendelse forblir stille", async () => {
    await registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "water_leak", filter: { entities: [{ entity_id: "binary_sensor.kjeller", role: "leak" }] } }, actorOwner);
    await registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "binary_sensor.inngang", role: "door" }] } }, actorOwner);
    await engine.setNotificationPolicy(TENANT_A, "home", { quiet_hours_start_utc: 11, quiet_hours_end_utc: 13 });
    const leak = door({ entity_id: "binary_sensor.kjeller", role: "leak", last_changed: minutesAgo(1) });
    await bus().publishBatch(TENANT_A, "home", [leak]);
    expect((await situationsIn(TENANT_A, "home"))[0]).toMatchObject({ stage: "remember" });
    expect((await engine.getNotificationPolicy(TENANT_A, "home"))?.critical_bypass_quiet).toBe(false);

    await adminPool.query(`DELETE FROM situation_signal_log; DELETE FROM situations;`);
    await expect(engine.setCriticalQuietBypass(TENANT_A, "home", true, OTHER)).rejects.toBeInstanceOf(SituationAutonomyUnauthorizedError);
    expect((await engine.setCriticalQuietBypass(TENANT_A, "home", true, OWNER)).critical_bypass_quiet).toBe(true);
    // stille timer-vinduet er bevart (merge), og bare sikkerhetssignalet bryter det
    expect((await engine.getNotificationPolicy(TENANT_A, "home"))).toMatchObject({ quiet_hours_start_utc: 11, quiet_hours_end_utc: 13 });
    await bus().publishBatch(TENANT_A, "home", [leak, door()]);
    const rows = await situationsIn(TENANT_A, "home");
    expect(rows.find((r) => r.detection_key.startsWith("home:leak:"))).toMatchObject({ stage: "suggest", priority: "high" });
    expect(rows.find((r) => r.detection_key.startsWith("home:opening:"))).toMatchObject({ stage: "remember" });
  });
});

describe("I: signallogg - retensjon og tenant-isolasjon", () => {
  it("opprydding sletter kun gamle innslag (klemt til 7-365 dager), aldri situasjoner, og kun i angitt tenant/space", async () => {
    await subscribeDoor(TENANT_A);
    await subscribeDoor(TENANT_B);
    await bus().publishBatch(TENANT_A, "home", [door()]);
    await bus().publishBatch(TENANT_B, "home", [door()]);
    const svc = new SignalLogService(appPool);
    await adminPool.query(`UPDATE situation_signal_log SET recorded_at = to_timestamp(${Math.floor(NOW / 1000)}) - interval '3 days'`);
    expect(await svc.purge(TENANT_A, "home", 1, NOW)).toBe(0); // 1 dag klemmes til 7: en 3 dager gammel rad overlever
    await adminPool.query(`UPDATE situation_signal_log SET recorded_at = to_timestamp(${Math.floor(NOW / 1000)}) - interval '40 days' WHERE tenant_id = '${TENANT_A}'`);
    expect(await svc.purge(TENANT_A, "home", 30, NOW)).toBe(1);
    expect(await svc.list(TENANT_A, "home")).toHaveLength(0);
    expect(await svc.list(TENANT_B, "home")).toHaveLength(1); // B uberørt
    expect(await situationsIn(TENANT_A, "home")).toHaveLength(1); // situasjonen består
  });
});

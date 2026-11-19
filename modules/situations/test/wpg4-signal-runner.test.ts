import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { HealthObservation, DailyPoint } from "../src/health-bridge.ts";
import type { HomeObservation } from "../src/home-bridge.ts";
import { SituationSignalBus } from "../src/signal-bus.ts";
import { SignalLogService } from "../src/signal-log.ts";
import { SituationSignalRunner, type SignalRunnerDeps, type SignalSourceReaders, type SourceReadContext } from "../src/signal-runner.ts";
import type { VisionObservation } from "../src/vision-bridge.ts";
import { actorOwner, identity, minutesAgo, NOW, OWNER, startG4Db, TENANT_A, TENANT_B, type ActuatorSpy, type G4Db, type TelegramSpy } from "./support/wpg4-db.ts";

/**
 * WP-G4 (D-466), P1a: «sanntids»-løperen mot en EKTE Postgres + ekte `SituationEngine`/`ToolGateway`: kun abonnert data leses, eier-kontroller stanser tikket, én kilde som feiler velter ikke resten, aldri overlappende tikk,
 * kildefrekvens (cadence), levering og auto-ACT gjenbruker motorens egne steg, og signalloggen ryddes daglig. Hver påstand om «ingen kall» er målt på spioner.
 */
let db: G4Db;
let gateway: ToolGateway;
let telegram: TelegramSpy;
let actuator: ActuatorSpy;
let clock = NOW;

const door = (over: Partial<HomeObservation> = {}): HomeObservation => ({ source: "home_assistant", entity_id: "binary_sensor.inngang", role: "door", state: "on", last_changed: minutesAgo(20), ...over });
const motion = (over: Partial<VisionObservation> = {}): VisionObservation => ({
  source: "vision", observation_id: "obs-1", event_type: "doorbell_event", source_instance_id: "camera.inngang", source_event_id: "event.dorklokke@2026-11-19T11:59:00.000Z",
  observed_at: minutesAgo(1), object_label: null, classification_status: "not_applicable", ...over
});
const series = (base: number, recent: number[]): DailyPoint[] => {
  const total = 28 + recent.length;
  return Array.from({ length: total }, (_, i) => ({ day: new Date(NOW - (total - i) * 86_400_000).toISOString().slice(0, 10), value: i < 28 ? base + ((i % 5) - 2) : (recent[i - 28] as number), samples: 5 }));
};

interface Spies {
  home: Array<{ ctx: SourceReadContext; entities: Array<{ entity_id: string; role: string }> }>;
  vision: Array<{ ctx: SourceReadContext; sinceMs: number }>;
  health: Array<{ ctx: SourceReadContext; personId: string; metrics: readonly string[] }>;
}

function makeRunner(readers: Partial<SignalSourceReaders>, over: Partial<SignalRunnerDeps> = {}) {
  const bus = new SituationSignalBus({ pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses, subscriptions: (t, s) => db.registry.listEnabled(t, s), now: () => clock });
  return new SituationSignalRunner({
    pool: db.appPool, bus, engine: db.engine, gateway, readers, subscriptions: (t, s) => db.registry.listEnabled(t, s),
    targets: [{ tenant_id: TENANT_A, memory_space: "home" }, { tenant_id: TENANT_A, memory_space: "health" }, { tenant_id: TENANT_A, memory_space: "business" }],
    identityFor: (t, s) => identity(t, s), guard: { blocked: async () => null }, intervalMs: 60_000, now: () => clock, ...over
  });
}

const subscribeDoor = (entities: Array<Record<string, unknown>> = [{ entity_id: "binary_sensor.inngang", role: "door" }], tenant = TENANT_A) =>
  db.registry.subscribe(tenant, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities } }, actorOwner);

beforeAll(async () => {
  db = await startG4Db("runner");
}, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);
beforeEach(async () => {
  clock = NOW;
  ({ gateway, telegram, actuator } = db.newGateway());
  await db.reset();
});

describe("A: kun abonnert data leses, og uten abonnement leses ingenting", () => {
  it("uten abonnement: ingen leser kalles (null kall), tikket er ok og tomt", async () => {
    const spies: Spies = { home: [], vision: [], health: [] };
    const runner = makeRunner({
      home: async (ctx, entities) => { spies.home.push({ ctx, entities }); return []; }, vision: async (ctx, sinceMs) => { spies.vision.push({ ctx, sinceMs }); return []; },
      health: async (ctx, personId, metrics) => { spies.health.push({ ctx, personId, metrics }); return []; }, incident: async () => []
    });
    const result = await runner.tick();
    expect(result).toMatchObject({ status: "ok", spaces: 0, sources_read: 0, source_failures: 0 });
    expect(spies).toEqual({ home: [], vision: [], health: [] });
  });

  it("leseren får KUN entitetene eieren har abonnert på (union over abonnementer, dedupet) og riktig (tenant, space); en kilde uten leser berøres ikke", async () => {
    await subscribeDoor([{ entity_id: "binary_sensor.inngang", role: "door" }, { entity_id: "cover.garasje", role: "garage_door" }]);
    await db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "water_leak", filter: { entities: [{ entity_id: "binary_sensor.kjeller", role: "leak" }] } }, actorOwner);
    await subscribeDoor([{ entity_id: "binary_sensor.inngang", role: "door" }, { entity_id: "binary_sensor.bakdoer", role: "door" }]); // overlappende, annen digest
    await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "doorbell_event", filter: {} }, actorOwner); // ingen vision-leser konfigurert
    await subscribeDoor([{ entity_id: "binary_sensor.b", role: "door" }], TENANT_B); // annen tenant: aldri lest av en løper for A
    const seen: Spies["home"] = [];
    const runner = makeRunner({ home: async (ctx, entities) => { seen.push({ ctx, entities }); return []; } });
    const result = await runner.tick();
    expect(result).toMatchObject({ status: "ok", spaces: 1, sources_read: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ctx).toMatchObject({ tenant_id: TENANT_A, memory_space: "home" });
    expect(seen[0]!.entities.map((e) => `${e.entity_id}|${e.role}`).sort()).toEqual(["binary_sensor.bakdoer|door", "binary_sensor.inngang|door", "binary_sensor.kjeller|leak", "cover.garasje|garage_door"]);
  });

  it("helse: leseren får kun personen og metrikkene abonnementene ber om; kamera: oppslagsvindu = max(10 min, 3 x intervall)", async () => {
    await db.registry.subscribe(TENANT_A, "health", { source: "health", event_type: "resting_heart_rate_deviation", filter: { person_id: OWNER } }, actorOwner);
    await db.registry.subscribe(TENANT_A, "health", { source: "health", event_type: "activity_deviation", filter: { person_id: OWNER } }, actorOwner);
    await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "doorbell_event", filter: {} }, actorOwner);
    const spies: Spies = { home: [], vision: [], health: [] };
    const runner = makeRunner({
      health: async (ctx, personId, metrics) => { spies.health.push({ ctx, personId, metrics }); return []; }, vision: async (ctx, sinceMs) => { spies.vision.push({ ctx, sinceMs }); return []; }
    }, { intervalMs: 5 * 60_000 });
    await runner.tick();
    expect(spies.health).toHaveLength(1);
    expect(spies.health[0]).toMatchObject({ personId: OWNER, ctx: { memory_space: "health" } });
    expect([...spies.health[0]!.metrics].sort()).toEqual(["resting_heart_rate", "steps"]);
    expect(spies.vision[0]!.sinceMs).toBe(NOW - 15 * 60_000); // 3 x 5 min
  });
});

describe("B: signal -> situasjon -> varsel, i ett tikk, uten duplikater", () => {
  it("hjem: åpen dør leses, evalueres, leveres som ETT telegram-varsel; neste tikk med samme tilstand gir verken ny evaluering eller nytt varsel", async () => {
    await subscribeDoor();
    const runner = makeRunner({ home: async () => [door()] });
    const first = await runner.tick();
    expect(first).toMatchObject({ status: "ok", delivered: 1 });
    expect(first.bus).toMatchObject({ received: 1, evaluated: 1, created: 1, newly_actionable: 1 });
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0]).toMatch(/^Jarvis oppdaget \[home, normal\]: Dør \(binary_sensor\.inngang\) har stått åpen i 20 min$/);
    const second = await runner.tick();
    expect(second.bus.ignored.duplicate).toBe(1);
    expect(second.bus.evaluated).toBe(0);
    expect(second.delivered).toBe(0);
    expect(telegram.calls).toHaveLength(1);
    expect(runner.status()).toMatchObject({ running: false, tick: 2 });
    expect(runner.status().last?.bus.received).toBe(1);
  });

  it("auto-ACT i samme tikk: forslag (garasjeport åpen lenge) + gyldig eier-binding = ETT aktuatorkall; uten binding = ingen", async () => {
    await db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "cover.garasje", role: "garage_door" }] } }, actorOwner);
    const runner = makeRunner({ home: async () => [door({ entity_id: "cover.garasje", role: "garage_door", state: "open", last_changed: minutesAgo(70) })] });
    const noBinding = await runner.tick();
    expect(noBinding.auto_act_attempted).toBe(0);
    expect(actuator.calls).toHaveLength(0);
    await db.engine.setAutonomyPolicy(TENANT_A, "home", { domain: "home", tool_id: "test_actuator", action: "close", parameters: { situation_id: "{{situation_id}}" } }, OWNER);
    const withBinding = await runner.tick();
    expect(withBinding.auto_act_attempted).toBe(1);
    expect(actuator.calls.filter((c) => c.action === "close")).toHaveLength(1);
    await runner.tick();
    expect(actuator.calls.filter((c) => c.action === "close")).toHaveLength(1); // claimet: aldri en ny utførelse
  });

  it("pause (domene) stanser innlesingen: kilden LESES ikke (fiks-runde A-MEDIUM-3; bussens per-observasjon-sjekk er dekket i wpg4-signal-bus), ingenting evalueres, og etter opphevet pause går signalet gjennom", async () => {
    await subscribeDoor();
    let reads = 0;
    const runner = makeRunner({ home: async () => { reads += 1; return [door()]; } });
    await db.domainPauses.pauseDurable("home", "eier stoppet", OWNER);
    const paused = await runner.tick();
    expect(reads).toBe(0);
    expect(paused.sources_skipped_paused).toBe(1);
    expect(paused.bus).toMatchObject({ received: 0, evaluated: 0 });
    expect(paused.delivered).toBe(0);
    expect(telegram.calls).toHaveLength(0);
    await db.domainPauses.unpauseDurable("home", OWNER);
    expect((await runner.tick()).bus.evaluated).toBe(1);
  });
});

describe("C: eier-kontroller, feilisolasjon og samtidighet", () => {
  it("kill switch (guard) stanser FØR første lesing; en kastet guard-feil tolkes som stanset (fail-closed); ingen leser kalles", async () => {
    await subscribeDoor();
    let reads = 0;
    const readers = { home: async () => { reads += 1; return [door()]; } };
    const blocked = await makeRunner(readers, { guard: { blocked: async () => "kill_switch_active" } }).tick();
    expect(blocked).toMatchObject({ status: "blocked", reason: "kill_switch_active" });
    const thrown = await makeRunner(readers, { guard: { blocked: async () => { throw new Error("db nede"); } } }).tick();
    expect(thrown).toMatchObject({ status: "blocked", reason: "guard_error" });
    expect(reads).toBe(0);
    expect(await db.engine.getQueue(TENANT_A, "home")).toHaveLength(0);
  });

  it("én kilde som feiler velter ikke de andre: feilen telles med KODE (aldri innhold), og kameraet leses fortsatt", async () => {
    await subscribeDoor();
    await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "doorbell_event", filter: {} }, actorOwner);
    const runner = makeRunner({ home: async () => { throw new Error("home_source_unavailable"); }, vision: async () => [motion()] });
    const result = await runner.tick();
    expect(result.source_failures).toBe(1);
    expect(result.errors).toEqual(["home_assistant:home_source_unavailable"]);
    expect(result.bus.evaluated).toBe(1);
    expect((await db.engine.getQueue(TENANT_A, "home"))[0]).toMatchObject({ domain: "vision" });
  });

  it("aldri to tikk samtidig: et tikk mens et annet pågår svarer `tick_in_progress` uten å lese", async () => {
    await subscribeDoor();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    const runner = makeRunner({ home: async () => { reads += 1; await gate; return []; } });
    const first = runner.tick();
    await new Promise((r) => setTimeout(r, 50));
    const second = await runner.tick();
    expect(second).toMatchObject({ status: "blocked", reason: "tick_in_progress" });
    release();
    expect((await first).status).toBe("ok");
    expect(reads).toBe(1);
    expect(runner.status().running).toBe(false);
  });

  it("kun konfigurerte (tenant, space) betjenes: abonnement i en annen tenant/space leses aldri", async () => {
    await subscribeDoor([{ entity_id: "binary_sensor.b", role: "door" }], TENANT_B);
    const seen: string[] = [];
    const runner = makeRunner({ home: async (ctx) => { seen.push(`${ctx.tenant_id}|${ctx.memory_space}`); return []; } });
    await runner.tick();
    expect(seen).toEqual([]);
  });

  it("helse leses med kildefrekvens (cadence): første tikk og hvert N-te; ellers ikke", async () => {
    await db.registry.subscribe(TENANT_A, "health", { source: "health", event_type: "resting_heart_rate_deviation", filter: { person_id: OWNER } }, actorOwner);
    const ticks: number[] = [];
    let n = 0;
    const runner = makeRunner({ health: async () => { ticks.push(n); return []; } }, { cadence: { health: 3 } });
    for (n = 1; n <= 7; n += 1) await runner.tick();
    expect(ticks).toEqual([1, 3, 6]);
  });

  it("helse-signal ende til ende: avvik -> én situasjon med innholdsfri tekst -> ETT varsel i `health`-rommet, og ingen ACT-kandidat", async () => {
    await db.registry.subscribe(TENANT_A, "health", { source: "health", event_type: "resting_heart_rate_deviation", filter: { person_id: OWNER } }, actorOwner);
    const obs: HealthObservation = { source: "health", metric: "resting_heart_rate", series: series(61, [65, 66, 65]) };
    const runner = makeRunner({ health: async () => [obs] });
    const result = await runner.tick();
    expect(result).toMatchObject({ delivered: 1, auto_act_attempted: 0 });
    expect(telegram.messages).toEqual(["Jarvis oppdaget [health, normal]: Avvik fra din egen baseline (hvilepuls) - åpne Jarvis for detaljer. Dette er ikke medisinsk rådgivning."]);
    expect(telegram.messages[0]).not.toMatch(/\d/);
  });
});

describe("D: daglig opprydding av signalloggen", () => {
  it("løperen sletter innslag eldre enn oppbevaringen første gang og deretter høyst én gang per døgn", async () => {
    await subscribeDoor();
    const runner = makeRunner({ home: async () => [door()] }, { logRetentionDays: 7 });
    await runner.tick();
    const logs = new SignalLogService(db.appPool);
    expect(await logs.list(TENANT_A, "home")).toHaveLength(1);
    await db.adminPool.query(`UPDATE situation_signal_log SET recorded_at = to_timestamp(${Math.floor(NOW / 1000)}) - interval '20 days'`);
    clock = NOW + 60_000; // under ett døgn siden forrige opprydding (første tikk satte tidtakeren)
    await runner.tick();
    expect(await logs.list(TENANT_A, "home")).toHaveLength(1);
    clock = NOW + 25 * 3_600_000;
    await runner.tick();
    // raden er slettet av oppryddingen; samme tilstand (nytt døgn, samme hendelsesnøkkel) logges på nytt som `updated` (situasjonen finnes)
    const after = await logs.list(TENANT_A, "home");
    expect(after).toHaveLength(1);
    expect(after.every((l) => new Date(l.recorded_at).getTime() > NOW - 10 * 86_400_000)).toBe(true); // den 20 dager gamle raden er borte
  });
});

describe("E: helse- og kamerakilder leser aldri uten eget abonnement (begrensede data)", () => {
  it("abonnement på hjem alene gir ingen helse-/kameralesing, selv om leserne finnes", async () => {
    await subscribeDoor();
    let healthReads = 0;
    let visionReads = 0;
    const runner = makeRunner({ home: async () => [], health: async () => { healthReads += 1; return []; }, vision: async () => { visionReads += 1; return []; } });
    await runner.tick();
    expect({ healthReads, visionReads }).toEqual({ healthReads: 0, visionReads: 0 });
  });

  it("en leser som lekker en observasjon for en kilde uten abonnement blir forkastet av bussen (`no_subscription`), ikke evaluert", async () => {
    await subscribeDoor();
    await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "doorbell_event", filter: {} }, actorOwner);
    const runner = makeRunner({ vision: async () => [motion(), motion({ observation_id: "obs-9", event_type: "security_alert" })] });
    const result = await runner.tick();
    expect(result.bus.ignored.no_subscription).toBe(1); // sikkerhetsvarselet har ikke noe abonnement
    expect(result.bus.evaluated).toBe(1);
  });
});

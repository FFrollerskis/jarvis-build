import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { AssistInput, AssistOutcome, SignalAssist } from "../src/assist.ts";
import type { HomeObservation } from "../src/home-bridge.ts";
import { SituationSignalBus, type PendingAssistEntry } from "../src/signal-bus.ts";
import { SignalLogService } from "../src/signal-log.ts";
import { MAX_ASSIST_CALLS_PER_TICK, SituationSignalRunner, type SignalRunnerDeps, type SignalSourceReaders } from "../src/signal-runner.ts";
import type { VisionObservation } from "../src/vision-bridge.ts";
import { actorOwner, identity, minutesAgo, NOW, OWNER, startG4Db, TENANT_A, type G4Db, type TelegramSpy } from "./support/wpg4-db.ts";

/**
 * WP-G4 (D-466) FIKS-RUNDE, mot en EKTE Postgres + ekte motor + ekte ToolGateway.
 *
 * A-MEDIUM-2 (reviewer A): modellvurderingen kjørte INLINE før evalueringen (60-180 s timeout, 5 kall per tikk): en vannlekkasje kunne komme minutter etter en treg modell. Nå: deterministisk først (evaluer og lever), modellen etterpå
 * som løft med tak per (tenant, rom) og ETT felles vegg-tidsbudsjett per tikk. A-MEDIUM-3: pause stoppet bare bussen, ikke KILDELESINGEN; en pause satt midt i en modellvurdering slapp en observasjon gjennom; leveringen leste pausene bare
 * én gang per kall. Hver påstand er målt (rekkefølgen av transportkall, antall modellkall, leserkall, rader i databasen).
 */
let db: G4Db;
let gateway: ToolGateway;
let telegram: TelegramSpy;
let clock = NOW;
const T = (iso: string): number => Date.parse(iso);

const UPLIFT: AssistOutcome = { status: "assessed", assessment: { category: "attention", priority_hint: "normal", explanation: "Trenger oppmerksomhet", provider: "local_llm", model: "test" } };

/** Modellspion: logger starten i en delt hendelsesliste (for rekkefølge mot varsler), kan være treg eller aldri bli ferdig. */
class FakeAssist implements SignalAssist {
  calls: AssistInput[] = [];
  constructor(private readonly events: string[] = [], private readonly mode: { delayMs?: number; hang?: boolean; outcome?: AssistOutcome; onCall?: () => Promise<void> } = {}) {}
  async assess(input: AssistInput): Promise<AssistOutcome> {
    this.events.push("assess:start");
    this.calls.push(input);
    if (this.mode.onCall) await this.mode.onCall();
    if (this.mode.hang) return new Promise<AssistOutcome>(() => undefined);
    if ((this.mode.delayMs ?? 0) > 0) await new Promise<void>((resolve) => { setTimeout(resolve, this.mode.delayMs).unref(); });
    this.events.push("assess:end");
    return this.mode.outcome ?? UPLIFT;
  }
}

const leak = (over: Partial<HomeObservation> = {}): HomeObservation => ({ source: "home_assistant", entity_id: "binary_sensor.kjeller", role: "leak", state: "on", last_changed: minutesAgo(1), ...over });
const door = (over: Partial<HomeObservation> = {}): HomeObservation => ({ source: "home_assistant", entity_id: "binary_sensor.inngang", role: "door", state: "on", last_changed: minutesAgo(20), ...over });
const cam = (n: number, over: Partial<VisionObservation> = {}): VisionObservation => ({
  source: "vision", observation_id: `obs-${n}`, event_type: "motion_detected", source_instance_id: `camera.k${n}`, source_event_id: `binary_sensor.bevegelse${n}@${new Date(NOW - 60_000).toISOString()}`,
  observed_at: minutesAgo(1), object_label: null, classification_status: "not_applicable", ...over
});

const subLeak = () => db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "water_leak", filter: { entities: [{ entity_id: "binary_sensor.kjeller", role: "leak" }] } }, actorOwner);
const subDoor = () => db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "binary_sensor.inngang", role: "door" }] } }, actorOwner);
const subVision = (eventType: string) => db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: eventType, filter: {} }, actorOwner);

function busWith(assist: SignalAssist | null): SituationSignalBus {
  return new SituationSignalBus({ pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses, subscriptions: (t, s) => db.registry.listEnabled(t, s), assist, now: () => clock });
}
function makeRunner(readers: Partial<SignalSourceReaders>, assist: SignalAssist | null, over: Partial<SignalRunnerDeps> = {}): SituationSignalRunner {
  return new SituationSignalRunner({
    pool: db.appPool, bus: busWith(assist), engine: db.engine, gateway, readers, subscriptions: (t, s) => db.registry.listEnabled(t, s),
    targets: [{ tenant_id: TENANT_A, memory_space: "home" }], identityFor: (t, s) => identity(t, s), guard: { blocked: async () => null }, intervalMs: 60_000, now: () => clock, ...over
  });
}
const logs = () => new SignalLogService(db.appPool).list(TENANT_A, "home", { limit: 200 });
const queue = () => db.engine.getQueue(TENANT_A, "home", { statusOpenOnly: false });
/** Fanger hver Telegram-sending i en delt hendelsesliste (rekkefølge mot modellkall). */
function recordNotices(events: string[]): void {
  const original = telegram.invoke.bind(telegram);
  telegram.invoke = async (action, parameters) => {
    events.push(`notify:${String(parameters["message"]).match(/\[([a-z]+),/)?.[1] ?? "?"}`);
    return original(action, parameters);
  };
}

beforeAll(async () => { db = await startG4Db("fixassist"); }, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);
beforeEach(async () => {
  clock = NOW;
  ({ gateway, telegram } = db.newGateway());
  await db.reset();
});

describe("A-MEDIUM-2: deterministisk først, modellen etterpå (tak + tidsbudsjett)", () => {
  it("vannlekkasjen leveres FØR første modellkall; modellvurderingen kjører etterpå og et løft leveres umiddelbart etter", async () => {
    await subLeak();
    await subVision("motion_detected");
    const events: string[] = [];
    recordNotices(events);
    const assist = new FakeAssist(events, { delayMs: 30 });
    const runner = makeRunner({ home: async () => [leak()], vision: async () => [cam(1)] }, assist);
    const result = await runner.tick();
    expect(result.status).toBe("ok");
    expect(events).toEqual(["notify:home", "assess:start", "assess:end", "notify:vision"]); // lekkasjen først, så modellen, så løftet
    expect(result.delivered).toBe(2);
    expect(result.bus.assist).toMatchObject({ deferred: 1, assessed: 1, uplifted: 1, skipped_cap: 0, skipped_budget: 0 });
    expect(assist.calls).toHaveLength(1);
    expect(telegram.messages[0]).toMatch(/^Jarvis foreslår handling \[home, high\]/);
    expect(telegram.messages[1]).toMatch(/^Jarvis oppdaget \[vision, normal\]/);
    // begge signalene er behandlet og logget (kameraet først i fase 2, `created` bevart); neste tikk er idempotent og kaller ikke modellen igjen
    const rows = await logs();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.source === "vision")).toMatchObject({ outcome: "created", stage_after: "inform", priority: "normal", notified: true, task_id: "situation-signals:vision" });
    expect(rows.find((r) => r.source === "vision")?.facts).toMatchObject({ assist_uplift: true });
    const again = await runner.tick();
    expect(again.bus.ignored.duplicate).toBe(2);
    expect(assist.calls).toHaveLength(1);
    expect(telegram.messages).toHaveLength(2);
  });

  it("samlet tidsbudsjett per tikk: en modell som aldri svarer holder IKKE tikket fast; resten hoppes over; signalene behandles deterministisk og logges (ikke gjenforsøkt neste tikk)", async () => {
    await subVision("motion_detected");
    const assist = new FakeAssist([], { hang: true });
    const runner = makeRunner({ vision: async () => [cam(1), cam(2), cam(3), cam(4)] }, assist, { assistBudgetMs: 120 });
    const started = Date.now();
    const result = await runner.tick();
    expect(Date.now() - started).toBeLessThan(5_000); // uten budsjett ville ETT hengende kall holdt tikket i minutter (60-180 s modell-timeout)
    expect(result.status).toBe("ok");
    expect(result.bus.assist.assessed).toBe(0);
    expect(result.bus.assist.unavailable).toBeGreaterThanOrEqual(1); // første kall: ikke ferdig innen budsjettet
    expect(result.bus.assist.unavailable + result.bus.assist.skipped_budget).toBe(4); // alle fire ble enten avbrutt eller hoppet over
    expect(result.bus.assist.skipped_budget).toBeGreaterThanOrEqual(2); // budsjettet er felles: når det er brukt opp, kalles ikke modellen mer (ikke ett nytt tidsavbrudd per signal)
    expect(assist.calls.length).toBe(result.bus.assist.unavailable);
    expect(result.bus.assist.deferred).toBe(4);
    expect((await queue()).length).toBe(4); // deterministisk evaluert i fase 1
    expect((await logs()).length).toBe(4); // ferdig behandlet etter fase 2 (ikke i fase 1)
    const callsBefore = assist.calls.length;
    const again = await runner.tick();
    expect(again.bus.ignored.duplicate).toBe(4);
    expect(assist.calls.length).toBe(callsBefore);
  });

  it("taket (M32): høyst MAX_ASSIST_CALLS_PER_TICK modellkall per (tenant, rom) og tikk uansett antall signaler; resten behandles deterministisk og logges", async () => {
    await subVision("motion_detected");
    const assist = new FakeAssist();
    const runner = makeRunner({ vision: async () => Array.from({ length: 12 }, (_, i) => cam(i + 1)) }, assist);
    const result = await runner.tick();
    expect(MAX_ASSIST_CALLS_PER_TICK).toBe(5);
    expect(assist.calls).toHaveLength(5);
    expect(result.bus.assist).toMatchObject({ deferred: 12, assessed: 5, uplifted: 5, skipped_cap: 7 });
    expect((await queue()).length).toBe(12);
    expect((await logs()).length).toBe(12);
    expect(telegram.messages).toHaveLength(5); // kun de fem løftede ble varslet
  });

  it("to-faset bussbruk: fase 1 logger IKKE et assist-signal (det venter), uten fase 2 evalueres det på nytt neste gang (idempotent, én situasjon); fase 2 logger med `created` bevart", async () => {
    await subVision("motion_detected");
    const assist = new FakeAssist();
    const bus = busWith(assist);
    const pending: PendingAssistEntry[] = [];
    const first = await bus.publishBatch(TENANT_A, "home", [cam(1)], { assistPhase: "deterministic", pendingAssist: pending });
    expect(first).toMatchObject({ evaluated: 1, created: 1 });
    expect(first.assist.deferred).toBe(1);
    expect(assist.calls).toHaveLength(0); // INGEN modellkall i fase 1
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ created: true });
    expect(await logs()).toHaveLength(0);
    // kræsj imellom fasene: neste fase 1 evaluerer på nytt (ingen duplikat-situasjon) og samler signalet igjen
    const pendingAgain: PendingAssistEntry[] = [];
    const retry = await bus.publishBatch(TENANT_A, "home", [cam(1)], { assistPhase: "deterministic", pendingAssist: pendingAgain });
    expect(retry.ignored.duplicate).toBe(0);
    expect(pendingAgain).toHaveLength(1);
    expect(await queue()).toHaveLength(1);
    const second = await bus.publishPendingAssists(TENANT_A, "home", pending, { assistBudget: { remaining: 5 } });
    expect(second).toMatchObject({ received: 0, evaluated: 0, created: 0, newly_actionable: 1, failed: 0 }); // fase 2 teller kun det den tilfører
    expect(second.assist).toMatchObject({ assessed: 1, uplifted: 1 });
    const rows = await logs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "created", stage_after: "inform", priority: "normal", notified: true, task_id: "situation-signals:vision" });
  });

  it("et løft som holdes av stille timer svelges ikke: vurderingen lagres, signalet logges ikke, og etter stille timer brukes den bufrede vurderingen (modellen kalles én gang) og varselet går ut", async () => {
    await subVision("motion_detected");
    await db.engine.setNotificationPolicy(TENANT_A, "home", { quiet_hours_start_utc: 22, quiet_hours_end_utc: 6 });
    const assist = new FakeAssist();
    const obs = cam(1, { observed_at: "2026-11-19T22:58:00.000Z", source_event_id: "binary_sensor.bevegelse1@2026-11-19T22:58:00.000Z" });
    const runner = makeRunner({ vision: async () => [obs] }, assist);
    clock = T("2026-11-19T23:00:00.000Z");
    const night = await runner.tick();
    expect(night.bus.assist).toMatchObject({ deferred: 1, assessed: 1, uplifted: 1 });
    expect(telegram.messages).toEqual([]);
    expect((await queue())[0]).toMatchObject({ priority: "normal", stage: "remember" }); // løftet, men holdt
    expect(await logs()).toHaveLength(0); // ikke ferdig behandlet
    clock = T("2026-11-20T07:00:00.000Z");
    const morning = await runner.tick();
    expect(morning.bus.ignored.duplicate).toBe(0);
    expect(morning.bus.assist.cached).toBe(1); // den bufrede vurderingen, ikke et nytt modellkall
    expect(assist.calls).toHaveLength(1);
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0]).toMatch(/^Jarvis oppdaget \[vision, normal\]/);
    expect(await logs()).toHaveLength(1);
  });

  it("uten modellassistanse er alt som før: ett steg, ingenting utsatt, signalet logges i fase 1", async () => {
    await subVision("motion_detected");
    const runner = makeRunner({ vision: async () => [cam(1)] }, null);
    const result = await runner.tick();
    expect(result.bus.assist).toMatchObject({ deferred: 0, assessed: 0 });
    expect(await logs()).toHaveLength(1);
    expect(telegram.messages).toEqual([]); // lav prioritet: remember
  });
});

describe("A-MEDIUM-3: pause stopper KILDELESINGEN, og en pause midt i en vurdering/levering slipper ingenting gjennom", () => {
  it("en kilde der alle abonnementsdomener er pauset leses ikke (ingen leserkall); helse leses ikke mens helse er pauset; etter opphevet pause leses den igjen", async () => {
    await subDoor();
    await db.registry.subscribe(TENANT_A, "health", { source: "health", event_type: "resting_heart_rate_deviation", filter: { person_id: OWNER } }, actorOwner);
    let homeReads = 0;
    let healthReads = 0;
    const readers: Partial<SignalSourceReaders> = { home: async () => { homeReads += 1; return [door()]; }, health: async () => { healthReads += 1; return []; } };
    const runner = makeRunner(readers, null, { targets: [{ tenant_id: TENANT_A, memory_space: "home" }, { tenant_id: TENANT_A, memory_space: "health" }], cadence: { health: 1 } });
    await db.domainPauses.pauseDurable("health", "eier stoppet helse", OWNER);
    const first = await runner.tick();
    expect(healthReads).toBe(0); // helsedata leses ikke mens helse er pauset
    expect(homeReads).toBe(1);
    expect(first.sources_skipped_paused).toBe(1);
    await db.domainPauses.unpauseDurable("health", OWNER);
    await db.domainPauses.pauseAllDurable("hele motoren", OWNER);
    clock = NOW + 60_000;
    const second = await runner.tick();
    expect({ homeReads, healthReads }).toEqual({ homeReads: 1, healthReads: 0 }); // hel-motor-pause: ingen lesing i det hele tatt
    expect(second.sources_skipped_paused).toBe(2);
    expect(second.bus.received).toBe(0);
    await db.domainPauses.unpauseAllDurable(OWNER);
    clock = NOW + 120_000;
    const third = await runner.tick();
    expect({ homeReads, healthReads }).toEqual({ homeReads: 2, healthReads: 1 }); // opphevet pause: begge leses igjen
    expect(third.sources_skipped_paused).toBe(0);
  });

  it("delvis pause: kilden leses fortsatt (et domene er ikke pauset), og bussen forkaster kun observasjonene i det pausede domenet (B-LOW-8: `vision` stopper ikke `opening_detected` som er domene `home`)", async () => {
    await subVision("motion_detected");
    await subVision("opening_detected");
    let reads = 0;
    const opening = cam(2, { event_type: "opening_detected", source_event_id: `binary_sensor.inngang@${new Date(NOW - 90_000).toISOString()}` });
    const runner = makeRunner({ vision: async () => { reads += 1; return [cam(1), opening]; } }, null);
    await db.domainPauses.pauseDurable("vision", "eier stoppet kamera", OWNER);
    const result = await runner.tick();
    expect(reads).toBe(1);
    expect(result.sources_skipped_paused).toBe(0);
    expect(result.bus.ignored.paused).toBe(1); // bevegelsen (domene vision)
    expect(result.bus.evaluated).toBe(1); // åpningen (domene home) går gjennom
    expect((await queue()).map((s) => s.domain)).toEqual(["home"]);
  });

  it("`pausedDomains` = prosess-cache OG varig database (en cache-pause uten databaserad teller, og en databaserad uten cache - en annen prosess satte den - teller)", async () => {
    db.domainPauses.pause("infra", "kun i minnet");
    await db.adminPool.query(`INSERT INTO situation_domain_pauses (domain, reason, paused_by) VALUES ('health', 'satt av en annen prosess', NULL)`);
    const set = await busWith(null).pausedDomains(TENANT_A, "home");
    expect([...set].sort()).toEqual(["health", "infra"]);
    db.domainPauses.unpause("infra");
  });

  it("en pause som kun finnes i databasen (satt av en annen prosess) stanser også kildelesingen", async () => {
    await db.registry.subscribe(TENANT_A, "health", { source: "health", event_type: "resting_heart_rate_deviation", filter: { person_id: OWNER } }, actorOwner);
    await db.adminPool.query(`INSERT INTO situation_domain_pauses (domain, reason, paused_by) VALUES ('health', 'satt av en annen prosess', NULL)`);
    let reads = 0;
    const runner = makeRunner({ health: async () => { reads += 1; return []; } }, null, { targets: [{ tenant_id: TENANT_A, memory_space: "health" }] });
    const result = await runner.tick();
    expect(reads).toBe(0);
    expect(result.sources_skipped_paused).toBe(1);
  });

  it("pause satt MIDT i modellvurderingen: observasjonen slipper ikke gjennom (ingen situasjon, ingen logglinje, ingen lagret vurdering) og blir behandlet først etter opphevet pause", async () => {
    await subVision("motion_detected");
    let fired = false;
    const assist = new FakeAssist([], { onCall: async () => { if (fired) return; fired = true; await db.domainPauses.pauseDurable("vision", "satt mens modellen vurderer", OWNER); } });
    const bus = busWith(assist);
    const during = await bus.publishBatch(TENANT_A, "home", [cam(1)], { assistBudget: { remaining: 3 } });
    expect(assist.calls).toHaveLength(1);
    expect(during.ignored.paused).toBe(1);
    expect(during.evaluated).toBe(0);
    expect(await queue()).toHaveLength(0);
    expect(await logs()).toHaveLength(0);
    expect((await db.adminPool.query(`SELECT count(*)::int AS n FROM situation_assessments`)).rows[0].n).toBe(0);
    await db.domainPauses.unpauseDurable("vision", OWNER);
    const after = await bus.publishBatch(TENANT_A, "home", [cam(1)], { assistBudget: { remaining: 3 } });
    expect(after.evaluated).toBe(1);
  });

  it("levering: pausene leses PER VARSEL - en pause satt av første sending stopper det andre varselet (cache + database), som leveres først etter opphevet pause", async () => {
    await subDoor();
    await subVision("doorbell_event");
    const bus = busWith(null);
    await bus.publishBatch(TENANT_A, "home", [door()]);
    await bus.publishBatch(TENANT_A, "home", [cam(1, { event_type: "doorbell_event" })]);
    expect((await queue()).map((s) => s.domain).sort()).toEqual(["home", "vision"]);
    const original = telegram.invoke.bind(telegram);
    telegram.invoke = async (action, parameters) => {
      const domain = String(parameters["message"]).match(/\[([a-z]+),/)?.[1];
      if (telegram.calls.length === 0) await db.domainPauses.pauseDurable(domain === "home" ? "vision" : "home", "satt midt i leveringen", OWNER);
      return original(action, parameters);
    };
    const first = await db.engine.deliverPendingInformNotifications(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(first).toMatchObject({ delivered: 1, paused: 1 });
    expect(telegram.messages).toHaveLength(1);
    await db.domainPauses.unpauseDurable("vision", OWNER);
    await db.domainPauses.unpauseDurable("home", OWNER);
    const second = await db.engine.deliverPendingInformNotifications(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(second.delivered).toBe(1);
    expect(telegram.messages).toHaveLength(2);
  });

  it("levering: en pause som kun finnes i prosess-cachen stanser også varselet (samme «umiddelbart»-regel som `actOn`), og det leveres etter opphevet pause", async () => {
    await subDoor();
    await busWith(null).publishBatch(TENANT_A, "home", [door()]);
    db.domainPauses.pause("home", "kun i minnet");
    const paused = await db.engine.deliverPendingInformNotifications(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(paused).toMatchObject({ delivered: 0, paused: 1 });
    expect(telegram.messages).toEqual([]);
    db.domainPauses.unpause("home");
    expect((await db.engine.deliverPendingInformNotifications(TENANT_A, "home", gateway, identity(TENANT_A, "home"))).delivered).toBe(1);
  });
});

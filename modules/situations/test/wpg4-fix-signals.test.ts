import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HomeObservation } from "../src/home-bridge.ts";
import type { VisionObservation } from "../src/vision-bridge.ts";
import { SituationSignalBus } from "../src/signal-bus.ts";
import { SignalLogService } from "../src/signal-log.ts";
import { MAX_HOME_ENTITIES, SituationSignalRunner, type SignalSourceReaders } from "../src/signal-runner.ts";
import { startG4Db, type G4Db, TENANT_A, OWNER, actorOwner, identity } from "./support/wpg4-db.ts";

/**
 * WP-G4 (D-466) FIKS-RUNDE, signaler mot en EKTE Postgres (NOSUPERUSER/NOBYPASSRLS, FORCE RLS), ekte `SituationEngine`, ekte `ToolGateway`.
 *
 * B-HIGH-1 (reviewer B): stille timer sluket signaler for alltid. Motoren HOLDER en situasjon på `remember` i stille timer (korrekt), men bussen loggførte likevel signalet som «behandlet», så neste tikk (og alle etter)
 * svarte `duplicate` og varselet gikk aldri ut - heller ikke etter at stille timer var over. Nå logges et holdt signal ikke; det evalueres på nytt hvert tikk og varsles første tikk etter stille timer.
 * Hver påstand om «ett varsel»/«ingen varsel» er målt på transport-spionen (aldri antatt).
 */
let db: G4Db;
const T = (iso: string): number => Date.parse(iso);
const bus = (nowMs: number): SituationSignalBus =>
  new SituationSignalBus({ pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses, subscriptions: (t, s) => db.registry.listEnabled(t, s), now: () => nowMs });
const home = (over: Partial<HomeObservation>): HomeObservation => ({ source: "home_assistant", entity_id: "binary_sensor.inngang", role: "door", state: "on", last_changed: "2026-11-19T22:30:00.000Z", ...over });
const vision = (over: Partial<VisionObservation> = {}): VisionObservation => ({
  source: "vision", observation_id: "obs-1", event_type: "motion_detected", source_instance_id: "camera.inngang", source_event_id: "binary_sensor.bevegelse@2026-11-19T22:59:00.000Z",
  observed_at: "2026-11-19T22:59:00.000Z", object_label: null, classification_status: "not_applicable", ...over
});
/** Leverer ventende INFORM/SUGGEST-varsler (ny gateway per kall) og returnerer teksten som faktisk gikk til transporten. */
const deliver = async (): Promise<string[]> => {
  const { gateway, telegram } = db.newGateway();
  await db.engine.deliverPendingInformNotifications(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
  return telegram.messages;
};
const logRows = () => new SignalLogService(db.appPool).list(TENANT_A, "home");
const subscribeLeak = () => db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "water_leak", filter: { entities: [{ entity_id: "binary_sensor.kjeller", role: "leak" }] } }, actorOwner);
const subscribeDoor = () => db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "binary_sensor.inngang", role: "door" }] } }, actorOwner);
const quiet22to06 = () => db.engine.setNotificationPolicy(TENANT_A, "home", { quiet_hours_start_utc: 22, quiet_hours_end_utc: 6 });

beforeAll(async () => { db = await startG4Db("fixsig"); }, 240_000);
beforeEach(async () => { await db.reset(); });
afterAll(async () => { await db?.stop(); }, 120_000);

describe("B-HIGH-1: stille timer holder varselet tilbake, men sluker aldri signalet", () => {
  it("vannlekkasje 23:00 i stille timer (22-06): holdt og ikke logget i natt; evalueres på nytt hvert tikk; ETT varsel første tikk etter stille timer; deretter idempotent", async () => {
    await subscribeLeak();
    await quiet22to06();
    const leak = home({ entity_id: "binary_sensor.kjeller", role: "leak", last_changed: "2026-11-19T22:59:00.000Z" });

    const night1 = await bus(T("2026-11-19T23:00:00.000Z")).publishBatch(TENANT_A, "home", [leak]);
    expect(night1).toMatchObject({ evaluated: 1, created: 1, newly_actionable: 0, held: 1 });
    expect(night1.ignored.duplicate).toBe(0);
    expect(await logRows()).toHaveLength(0); // IKKE «behandlet»: loggen betyr ferdig, ikke «sett mens vi ikke kunne varsle»
    expect(await deliver()).toEqual([]);

    const night2 = await bus(T("2026-11-20T02:00:00.000Z")).publishBatch(TENANT_A, "home", [leak]);
    expect(night2).toMatchObject({ evaluated: 1, created: 0, held: 1 }); // fortsatt stille: evaluert på nytt, ikke `duplicate`
    expect(night2.ignored.duplicate).toBe(0);
    expect(await deliver()).toEqual([]);
    expect(await db.engine.getQueue(TENANT_A, "home", { statusOpenOnly: false })).toHaveLength(1); // fortsatt ÉN situasjon (dedupe på nøkkel)

    const morning = await bus(T("2026-11-20T07:00:00.000Z")).publishBatch(TENANT_A, "home", [leak]);
    expect(morning).toMatchObject({ evaluated: 1, newly_actionable: 1, held: 0 });
    expect(morning.ignored.duplicate).toBe(0);
    const notices = await deliver();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^Jarvis foreslår handling \[home, high\]/);
    const log = await logRows();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ stage_after: "suggest", notified: true, outcome: "updated" });

    const after = await bus(T("2026-11-20T07:15:00.000Z")).publishBatch(TENANT_A, "home", [leak]);
    expect(after.ignored.duplicate).toBe(1); // nå er det ferdig behandlet
    expect(await deliver()).toEqual([]);
    expect(await logRows()).toHaveLength(1);
  });

  it("dør åpnet 22:30, tikk hvert 15. minutt til 09:00: ingen varsel før 06:00, og nøyaktig ETT varsel i alt (første tikk etter stille timer)", async () => {
    await subscribeDoor();
    await quiet22to06();
    const open = home({});
    const noticeTicks: string[] = [];
    for (let t = T("2026-11-19T22:45:00.000Z"); t <= T("2026-11-20T09:00:00.000Z"); t += 15 * 60_000) {
      await bus(t).publishBatch(TENANT_A, "home", [open]);
      noticeTicks.push(...(await deliver()).map(() => new Date(t).toISOString()));
    }
    expect(noticeTicks).toHaveLength(1);
    expect(Date.parse(noticeTicks[0] as string)).toBeGreaterThanOrEqual(T("2026-11-20T06:00:00.000Z"));
    expect(Date.parse(noticeTicks[0] as string)).toBeLessThanOrEqual(T("2026-11-20T06:15:00.000Z"));
    expect(await db.engine.getQueue(TENANT_A, "home", { statusOpenOnly: false })).toHaveLength(1);
  });

  it("`critical_bypass_quiet` er uendret: et sikkerhetssignal (lekkasje) bryter stille timer, logges som varslet; en vanlig hendelse (dør) holdes på samme tikk", async () => {
    await subscribeLeak();
    await subscribeDoor();
    await quiet22to06();
    expect((await db.engine.setCriticalQuietBypass(TENANT_A, "home", true, OWNER)).critical_bypass_quiet).toBe(true);
    const leak = home({ entity_id: "binary_sensor.kjeller", role: "leak", last_changed: "2026-11-19T22:59:00.000Z" });
    const out = await bus(T("2026-11-19T23:15:00.000Z")).publishBatch(TENANT_A, "home", [leak, home({})]);
    expect(out).toMatchObject({ evaluated: 2, newly_actionable: 1, held: 1 });
    expect(await deliver()).toHaveLength(1); // kun lekkasjen
    const log = await logRows();
    expect(log).toHaveLength(1); // lekkasjen er behandlet; døra er holdt (ikke logget)
    expect(log[0]).toMatchObject({ event_type: "water_leak", notified: true, stage_after: "suggest" });
  });

  it("lav prioritet holdes ikke: kamerabevegelse (`low`) i stille timer får stadiet `remember` av PRIORITETEN og logges som vanlig (andre tikk er `duplicate`)", async () => {
    await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "motion_detected", filter: {} }, actorOwner);
    await quiet22to06();
    const first = await bus(T("2026-11-19T23:00:00.000Z")).publishBatch(TENANT_A, "home", [vision()]);
    expect(first).toMatchObject({ evaluated: 1, created: 1, held: 0 });
    expect(await logRows()).toHaveLength(1);
    const second = await bus(T("2026-11-19T23:15:00.000Z")).publishBatch(TENANT_A, "home", [vision()]);
    expect(second.ignored.duplicate).toBe(1);
    expect(second.evaluated).toBe(0);
    expect(await deliver()).toEqual([]);
  });

  it("utenfor stille timer er alt som før (F4): første tikk varsler og logger, neste er `duplicate`, og et varslet signal blir ikke holdt eller varslet to ganger", async () => {
    await subscribeDoor();
    const open = home({ last_changed: "2026-11-19T11:30:00.000Z" });
    const first = await bus(T("2026-11-19T12:00:00.000Z")).publishBatch(TENANT_A, "home", [open]);
    expect(first).toMatchObject({ evaluated: 1, newly_actionable: 1, held: 0 });
    expect(await deliver()).toHaveLength(1);
    const again = await bus(T("2026-11-19T12:01:00.000Z")).publishBatch(TENANT_A, "home", [open]);
    expect(again.ignored.duplicate).toBe(1);
    expect(await deliver()).toEqual([]);
    expect(await logRows()).toHaveLength(1);
  });

  it("et signal som ble varslet FØR stille timer er ferdig behandlet: det forblir `duplicate` gjennom natten (verken holdt eller varslet på nytt)", async () => {
    await subscribeDoor();
    await quiet22to06();
    const open = home({ last_changed: "2026-11-19T20:30:00.000Z" });
    // 21:50: ikke stille ennå -> varslet og logget
    await bus(T("2026-11-19T21:50:00.000Z")).publishBatch(TENANT_A, "home", [open]);
    expect(await deliver()).toHaveLength(1);
    // 23:00 (stille): signalet er allerede logget -> `duplicate`, og aldri et nytt varsel eller en ny holdt evaluering
    const night = await bus(T("2026-11-19T23:00:00.000Z")).publishBatch(TENANT_A, "home", [open]);
    expect(night.ignored.duplicate).toBe(1);
    expect(night.held).toBe(0);
    expect(await deliver()).toEqual([]);
  });
});

describe("B-LOW-6/B-MEDIUM-4: kildeadvarsler og ÉN HA-lesing per tikk (løperen)", () => {
  const runnerWith = (readers: Partial<SignalSourceReaders>) => new SituationSignalRunner({
    pool: db.appPool, bus: bus(T("2026-11-19T12:00:00.000Z")), engine: db.engine, gateway: db.newGateway().gateway, readers, subscriptions: (t, s) => db.registry.listEnabled(t, s),
    targets: [{ tenant_id: TENANT_A, memory_space: "home" }], identityFor: (t, s) => identity(t, s), guard: { blocked: async () => null }, intervalMs: 60_000, now: () => T("2026-11-19T12:00:00.000Z")
  });
  const subMany = (prefix: string, n: number) => db.registry.subscribe(TENANT_A, "home", {
    source: "home_assistant", event_type: "door_open_too_long", filter: { entities: Array.from({ length: n }, (_, i) => ({ entity_id: `binary_sensor.${prefix}${i}`, role: "door" })) }
  }, actorOwner);

  it("HA-lesingen kuttes ikke lenger STILLE til 50 entiteter: leseren får 50, og avkortingen er en synlig advarsel med det totale antallet", async () => {
    await subMany("a", 30);
    await subMany("b", 30);
    let received = 0;
    const result = await runnerWith({ home: async (_ctx, entities) => { received = entities.length; return []; } }).tick();
    expect(MAX_HOME_ENTITIES).toBe(50);
    expect(received).toBe(50);
    expect(result.warnings).toEqual(["home_assistant:home_entities_truncated:60"]);
    // under taket: ingen advarsel
    await db.reset();
    await subMany("c", 30);
    expect((await runnerWith({ home: async () => [] }).tick()).warnings).toEqual([]);
  });

  it("advarsler fra leseren (ukjent/feilende entitet) havner i tikkresultatet med kilde-prefiks, uten duplikater, maks 20 - og er ikke kildefeil", async () => {
    await subMany("a", 3);
    const result = await runnerWith({ home: async (ctx) => { ctx.warnings?.push("home_entities_unknown:2", "home_entities_unknown:2", "home_entities_failed:1"); return []; } }).tick();
    expect(result.warnings).toEqual(["home_assistant:home_entities_unknown:2", "home_assistant:home_entities_failed:1"]);
    expect(result).toMatchObject({ source_failures: 0, sources_read: 1 });
    const many = await runnerWith({ home: async (ctx) => { for (let i = 0; i < 40; i += 1) ctx.warnings?.push(`w${i}`); return []; } }).tick();
    expect(many.warnings).toHaveLength(20);
  });

  it("en leser som kaster etter å ha lagt til advarsler beholder advarslene, og feilen telles som kildefeil", async () => {
    await subMany("a", 2);
    const result = await runnerWith({ home: async (ctx) => { ctx.warnings?.push("home_entities_unknown:1"); throw new Error("home_source_unavailable"); } }).tick();
    expect(result.warnings).toEqual(["home_assistant:home_entities_unknown:1"]);
    expect(result).toMatchObject({ source_failures: 1, errors: ["home_assistant:home_source_unavailable"] });
  });
});

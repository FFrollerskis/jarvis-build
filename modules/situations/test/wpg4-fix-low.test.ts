import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MemorySpace } from "@jarvis/contracts";
import type { DailyPoint, HealthObservation } from "../src/health-bridge.ts";
import type { HomeObservation } from "../src/home-bridge.ts";
import { buildInformMessage } from "../src/service.ts";
import { FLAP_MAX_EPISODES, FLAP_WINDOW_MS, MAX_OBSERVATIONS_PER_BATCH, SituationSignalBus } from "../src/signal-bus.ts";
import { SignalLogService } from "../src/signal-log.ts";
import { DEFAULT_SIGNAL_CADENCE, MIN_VISION_LOOKBACK_MS, SituationSignalRunner, type SignalRunnerDeps, type SignalSourceReaders } from "../src/signal-runner.ts";
import { SimulationService, simulationToolInfoFrom } from "../src/simulation.ts";
import { FeedbackService } from "../src/tuning.ts";
import type { VisionObservation } from "../src/vision-bridge.ts";
import { actorOwner, identity, minutesAgo, NOW, OWNER, startG4Db, TENANT_A, TENANT_B, type G4Db } from "./support/wpg4-db.ts";

/**
 * WP-G4 (D-466) FIKS-RUNDE, LOW/INFO og de overlevende mutantene, mot en EKTE Postgres + ekte motor + ekte ToolGateway.
 *  - A-LOW-6: høyeste prioritet vinner ved sammenslåing av kilder (begrunnelse og konfidens følger vinneren), uendret uten flagget.
 *  - A-LOW-8: flapp-demping (høyst 3 nye episoder per entitet per time for ikke-haste HA-regler; forsinket, aldri tapt; haste aldri).
 *  - B-LOW-6: tak per batch. B-LOW-7: per-bro-tester (stille timer, undertrykking, tenant) for kamera og helse. M27: søvn/skritt gjennom bussen.
 *  - M19/M32: løperens standardkadens for helse og minste kameravindu. M08b/M08c: simulering er REN lesing av ALLE tabeller (inkl. updated_at).
 */
let db: G4Db;
const T = (iso: string): number => Date.parse(iso);
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const busAt = (nowMs: number): SituationSignalBus =>
  new SituationSignalBus({ pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses, subscriptions: (t, s) => db.registry.listEnabled(t, s), now: () => nowMs });
/** Leverer ventende INFORM/SUGGEST-varsler (ny gateway per kall) og returnerer teksten som faktisk gikk til transporten. */
const deliver = async (space: MemorySpace, tenant = TENANT_A): Promise<string[]> => {
  const { gateway, telegram } = db.newGateway();
  await db.engine.deliverPendingInformNotifications(tenant, space, gateway, identity(tenant, space));
  return telegram.messages;
};
const logs = (space: MemorySpace, tenant = TENANT_A) => new SignalLogService(db.appPool).list(tenant, space, { limit: 200 });
const queue = (space: MemorySpace, tenant = TENANT_A) => db.engine.getQueue(tenant, space, { statusOpenOnly: false });
const quiet22to06 = (space: MemorySpace) => db.engine.setNotificationPolicy(TENANT_A, space, { quiet_hours_start_utc: 22, quiet_hours_end_utc: 6 });

const door = (over: Partial<HomeObservation> = {}): HomeObservation => ({ source: "home_assistant", entity_id: "binary_sensor.inngang", role: "door", state: "on", last_changed: minutesAgo(20), ...over });
const power = (sinceMinutesAgo: number, entity = "sensor.ovn"): HomeObservation => ({
  source: "home_assistant", entity_id: entity, role: "power", state: "2300", last_changed: minutesAgo(1), over_limit_ticks: 3, over_limit_since: minutesAgo(sinceMinutesAgo), limit_w: 2000
});
const subscribeDoor = (tenant = TENANT_A) => db.registry.subscribe(tenant, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "binary_sensor.inngang", role: "door" }] } }, actorOwner);
const subscribePower = (entities = ["sensor.ovn"]) =>
  db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "power_over_limit", filter: { entities: entities.map((entity_id) => ({ entity_id, role: "power", limit_w: 2000 })) } }, actorOwner);

beforeAll(async () => { db = await startG4Db("fixlow"); }, 240_000);
beforeEach(async () => { await db.reset(); });
afterAll(async () => { await db?.stop(); }, 120_000);

// ---------------------------------------------------------------------
// A-LOW-6: høyeste prioritet vinner
// ---------------------------------------------------------------------
describe("A-LOW-6: en signalkandidat (`no_downgrade`) senker aldri en åpen situasjon; begrunnelse og konfidens følger vinneren", () => {
  const KEY = "home:opening:binary_sensor.inngang@2026-11-19T11:00:00.000Z";
  const cand = (over: Record<string, unknown>) => ({ domain: "home", detection_key: KEY, priority: "high" as const, reason: "HOY", ...over });
  const row = async () => (await db.engine.findByDetectionKey(TENANT_A, "home", KEY))!;

  it("uten flagget er oppførselen UENDRET (siste vinner) - sveipene som aldri setter flagget påvirkes ikke", async () => {
    await db.engine.evaluateCandidate(TENANT_A, "home", cand({}), NOW);
    await db.engine.evaluateCandidate(TENANT_A, "home", cand({ priority: "normal", reason: "LAV" }), NOW);
    expect(await row()).toMatchObject({ priority: "normal", reason: "LAV" });
  });

  it("med flagget: en lavere kandidat overskriver ikke prioritet, konfidens, begrunnelse eller stadium, og den frosne teksten (ny syklus) kommer fra VINNEREN", async () => {
    const first = await db.engine.evaluateCandidate(TENANT_A, "home", cand({ confidence: 0.9 }), NOW);
    expect(first.situation).toMatchObject({ stage: "suggest", priority: "high" });
    // 25 t senere (utenfor undertrykkelsen): en lavere kandidat fra en annen kilde. Syklusen er ny (nytt anker), og teksten fryses på nytt - fra vinneren.
    const later = await db.engine.evaluateCandidate(TENANT_A, "home", cand({ priority: "normal", reason: "LAV", no_downgrade: true }), NOW + 25 * 3_600_000);
    expect(later.newly_actionable).toBe(true);
    const sit = await row();
    expect(sit).toMatchObject({ priority: "high", reason: "HOY", stage: "suggest" });
    expect(Number(sit.confidence)).toBe(0.9);
    expect(sit.inform_message).toBe(buildInformMessage("home", "high", "suggest", "HOY"));
    expect(sit.inform_message).not.toContain("LAV");
  });

  it("stadiet beregnes fra VINNERENS prioritet og konfidens: en høy/konfident situasjon holdt av stille timer blir `suggest` når en lavere kandidat kommer etter stille timer (ikke `inform`)", async () => {
    await quiet22to06("home");
    const held = await db.engine.evaluateCandidate(TENANT_A, "home", cand({ confidence: 0.9 }), T("2026-11-19T23:00:00.000Z"));
    expect(held.situation).toMatchObject({ stage: "remember", priority: "high" }); // holdt av stille timer
    const morning = await db.engine.evaluateCandidate(TENANT_A, "home", cand({ priority: "normal", reason: "LAV", no_downgrade: true }), T("2026-11-20T07:00:00.000Z"));
    expect(morning.newly_actionable).toBe(true);
    expect(await row()).toMatchObject({ priority: "high", reason: "HOY", stage: "suggest" }); // vinneren (høy, 0,9) gir suggest; den lave kandidaten alene ville gitt inform
    expect(morning.situation.inform_message).toBe(buildInformMessage("home", "high", "suggest", "HOY"));
  });

  it("likt nivå: siste vinner (ferskere begrunnelse); høyere nivå: eskalerer og tar over begrunnelsen", async () => {
    await db.engine.evaluateCandidate(TENANT_A, "home", cand({ priority: "normal", reason: "A", no_downgrade: true }), NOW);
    await db.engine.evaluateCandidate(TENANT_A, "home", cand({ priority: "normal", reason: "B", no_downgrade: true }), NOW);
    expect(await row()).toMatchObject({ priority: "normal", reason: "B" });
    await db.engine.evaluateCandidate(TENANT_A, "home", cand({ priority: "high", reason: "C", no_downgrade: true }), NOW);
    expect(await row()).toMatchObject({ priority: "high", reason: "C" });
    // og en lav kandidat etterpå ødelegger den ikke
    await db.engine.evaluateCandidate(TENANT_A, "home", cand({ priority: "low", reason: "D", no_downgrade: true }), NOW);
    expect(await row()).toMatchObject({ priority: "high", reason: "C" });
  });

  it("en LØST situasjon åpnes på nytt av en lavere kandidat med den NYE prioriteten (ny episode, ingen gammel prioritet henger igjen)", async () => {
    await db.engine.evaluateCandidate(TENANT_A, "home", cand({ confidence: 0.9 }), NOW);
    await db.adminPool.query(`UPDATE situations SET status = 'resolved', resolved_at = now() WHERE detection_key = $1`, [KEY]);
    await db.engine.evaluateCandidate(TENANT_A, "home", cand({ priority: "normal", reason: "NY", no_downgrade: true }), NOW);
    const sit = await row();
    expect(sit).toMatchObject({ status: "open", priority: "normal", reason: "NY" });
    expect(sit.confidence).toBeNull();
  });

  it("bussen: samme åpning via Home Assistant (høy) OG kamerasensoren (lav) - HA først: høy og HA-begrunnelsen består; kamera først: eskalerer; ETT varsel begge veier", async () => {
    await subscribeDoor();
    await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "opening_detected", filter: {} }, actorOwner);
    const changed = minutesAgo(70);
    const ha = door({ last_changed: changed });
    const camera: VisionObservation = {
      source: "vision", observation_id: "o1", event_type: "opening_detected", source_instance_id: "camera.inngang", source_event_id: `binary_sensor.inngang@${changed}`,
      observed_at: minutesAgo(1), object_label: null, classification_status: "not_applicable"
    };
    const key = `home:opening:binary_sensor.inngang@${changed}`;

    // rekkefølge 1: HA (høy), så kamera (lav)
    await busAt(NOW).publishBatch(TENANT_A, "home", [ha]);
    await busAt(NOW).publishBatch(TENANT_A, "home", [camera]);
    let sit = (await db.engine.findByDetectionKey(TENANT_A, "home", key))!;
    expect(sit).toMatchObject({ priority: "high", stage: "inform" });
    expect(sit.reason).toContain("har stått åpen i 70 min"); // HA-begrunnelsen, ikke «Åpning registrert av en sensor»
    expect(sit.reason).not.toContain("Åpning registrert");
    expect((await logs("home")).map((l) => l.source).sort()).toEqual(["home_assistant", "vision"]);
    const first = await deliver("home");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/^Jarvis oppdaget \[home, high\]: .*har stått åpen i 70 min/);

    // rekkefølge 2: kamera (lav, huskes), så HA (høy): eskalerer til høy med HA-begrunnelsen, ett varsel
    await db.reset();
    await subscribeDoor();
    await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "opening_detected", filter: {} }, actorOwner);
    await busAt(NOW).publishBatch(TENANT_A, "home", [camera]);
    expect((await db.engine.findByDetectionKey(TENANT_A, "home", key))).toMatchObject({ priority: "low", stage: "remember" });
    expect(await deliver("home")).toEqual([]);
    await busAt(NOW).publishBatch(TENANT_A, "home", [ha]);
    sit = (await db.engine.findByDetectionKey(TENANT_A, "home", key))!;
    expect(sit).toMatchObject({ priority: "high", stage: "inform" });
    expect(sit.reason).toContain("har stått åpen i 70 min");
    expect(await deliver("home")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// A-LOW-8: flapp-demping
// ---------------------------------------------------------------------
describe("A-LOW-8: flapp-demping - høyst 3 nye episoder per entitet per time for ikke-haste HA-regler", () => {
  it("konstantene: 3 episoder per 60 minutter", () => {
    expect(FLAP_MAX_EPISODES).toBe(3);
    expect(FLAP_WINDOW_MS).toBe(60 * 60_000);
  });

  it("5 episoder: de tre første slippes inn, resten DEMPES (ikke evaluert, ikke logget); de slippes inn av seg selv når tidligere episoder er eldre enn vinduet (forsinket, aldri tapt); fem varsler i alt", async () => {
    await subscribePower();
    const episodes = [50, 40, 30, 20, 10]; // minutter siden hver episode startet
    let admitted = 0;
    for (const since of episodes.slice(0, 3)) {
      const out = await busAt(NOW).publishBatch(TENANT_A, "home", [power(since)]);
      expect(out).toMatchObject({ evaluated: 1, created: 1 });
      admitted += 1;
    }
    for (const since of episodes.slice(3)) {
      const out = await busAt(NOW).publishBatch(TENANT_A, "home", [power(since)]);
      expect(out.ignored.damped, `episode ${since}`).toBe(1);
      expect(out.evaluated).toBe(0);
    }
    expect(await queue("home")).toHaveLength(admitted);
    expect(await logs("home")).toHaveLength(admitted);
    // en dempet episode er IKKE «behandlet»: samme observasjon samme tikk er fortsatt dempet (og ingenting skrives)
    expect((await busAt(NOW).publishBatch(TENANT_A, "home", [power(20)])).ignored).toMatchObject({ damped: 1, duplicate: 0 });
    expect(await queue("home")).toHaveLength(3);

    // 15 min senere: den eldste episoden (50 min siden) er utenfor vinduet -> episode 4 slippes inn, episode 5 dempes fortsatt
    const t15 = NOW + 15 * 60_000;
    const out15 = await busAt(t15).publishBatch(TENANT_A, "home", [power(20), power(10)]);
    expect(out15).toMatchObject({ evaluated: 1, created: 1 });
    expect(out15.ignored.damped).toBe(1);
    // 25 min senere: episode 2 er også utenfor vinduet -> episode 5 slippes inn
    const t25 = NOW + 25 * 60_000;
    const out25 = await busAt(t25).publishBatch(TENANT_A, "home", [power(10)]);
    expect(out25).toMatchObject({ evaluated: 1, created: 1 });
    expect(out25.ignored.damped).toBe(0);
    expect(await queue("home")).toHaveLength(5);
    expect(await deliver("home")).toHaveLength(5); // forsinket, aldri tapt
  });

  it("dempingen er per entitet (en annen entitet er uavhengig), og haste-signaler (lekkasje) dempes ALDRI", async () => {
    await subscribePower(["sensor.ovn", "sensor.annen"]);
    for (const since of [50, 40, 30]) await busAt(NOW).publishBatch(TENANT_A, "home", [power(since)]);
    expect((await busAt(NOW).publishBatch(TENANT_A, "home", [power(20)])).ignored.damped).toBe(1);
    expect(await busAt(NOW).publishBatch(TENANT_A, "home", [power(20, "sensor.annen")])).toMatchObject({ evaluated: 1, created: 1 }); // annen entitet: slippes inn

    await db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "water_leak", filter: { entities: [{ entity_id: "binary_sensor.kjeller", role: "leak" }] } }, actorOwner);
    const leaks = [1, 2, 3, 4, 5, 6].map((n) => door({ entity_id: "binary_sensor.kjeller", role: "leak", last_changed: minutesAgo(n) }));
    const out = await busAt(NOW).publishBatch(TENANT_A, "home", leaks);
    expect(out).toMatchObject({ evaluated: 6, created: 6 });
    expect(out.ignored.damped).toBe(0);
  });

  it("en episode som ALLEREDE er sluppet inn dempes aldri (nytt nivå på samme nøkkel), selv når tre andre episoder fyller vinduet", async () => {
    await subscribeDoor();
    const e1 = door({ last_changed: minutesAgo(20) });
    expect(await busAt(NOW).publishBatch(TENANT_A, "home", [e1])).toMatchObject({ evaluated: 1, created: 1 }); // nivå 1 (20 min)
    // 45 min senere: tre nye episoder (åpne 55-57 min) fyller vinduet; E1 (startet for 65 min siden) er utenfor vinduet
    const later = NOW + 45 * 60_000;
    const others = [10, 11, 12].map((m) => door({ last_changed: minutesAgo(m) }));
    for (const o of others) expect(await busAt(later).publishBatch(TENANT_A, "home", [o])).toMatchObject({ evaluated: 1, created: 1 });
    const out = await busAt(later).publishBatch(TENANT_A, "home", [e1]); // E1 er nå åpen 65 min = nivå 2 (høy)
    expect(out).toMatchObject({ evaluated: 1, created: 0 });
    expect(out.ignored.damped).toBe(0);
    expect((await queue("home")).find((s) => s.detection_key.endsWith(minutesAgo(20)))).toMatchObject({ priority: "high" });
    // en NY fjerde episode i vinduet dempes derimot
    expect((await busAt(later).publishBatch(TENANT_A, "home", [door({ last_changed: minutesAgo(13) })])).ignored.damped).toBe(1);
  });

  it("en episode med to nivåer (to loggrader) teller som ÉN episode i vinduet: med terskel 5 min slippes tre episoder inn (A to nivåer, B, C), og den fjerde (D) dempes", async () => {
    await subscribeDoor();
    const tuned = { thresholds: async () => new Map([["home_assistant:door_open_too_long", 5]]) };
    const tunedBus = (nowMs: number): SituationSignalBus =>
      new SituationSignalBus({ pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses, subscriptions: (t, s) => db.registry.listEnabled(t, s), tuning: tuned, now: () => nowMs });
    const a = door({ last_changed: minutesAgo(21) });
    expect(await tunedBus(NOW - 10 * 60_000).publishBatch(TENANT_A, "home", [a])).toMatchObject({ evaluated: 1, created: 1 }); // nivå 1 (11 min åpen)
    expect(await tunedBus(NOW).publishBatch(TENANT_A, "home", [a])).toMatchObject({ evaluated: 1, created: 0 }); // nivå 2 (21 min åpen = 4 x 5): samme episode, andre loggrad
    expect((await logs("home")).filter((l) => l.detection_key.endsWith(minutesAgo(21)))).toHaveLength(2);
    expect(await tunedBus(NOW).publishBatch(TENANT_A, "home", [door({ last_changed: minutesAgo(10) })])).toMatchObject({ evaluated: 1, created: 1 }); // B
    expect(await tunedBus(NOW).publishBatch(TENANT_A, "home", [door({ last_changed: minutesAgo(9) })])).toMatchObject({ evaluated: 1, created: 1 }); // C: tre DISTINKTE episoder (fire loggrader)
    expect((await tunedBus(NOW).publishBatch(TENANT_A, "home", [door({ last_changed: minutesAgo(8) })])).ignored.damped).toBe(1); // D
  });

  it("dempingen kan konfigureres per bus (egen grense og eget vindu), og `false` slår den av", async () => {
    await subscribePower();
    const busWith = (flapDamping: ConstructorParameters<typeof SituationSignalBus>[0]["flapDamping"]): SituationSignalBus =>
      new SituationSignalBus({ pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses, subscriptions: (t, s) => db.registry.listEnabled(t, s), ...(flapDamping !== undefined ? { flapDamping } : {}), now: () => NOW });
    const one = busWith({ maxEpisodes: 1 });
    expect(await one.publishBatch(TENANT_A, "home", [power(50)])).toMatchObject({ evaluated: 1, created: 1 });
    expect((await one.publishBatch(TENANT_A, "home", [power(40)])).ignored.damped).toBe(1); // grensen er 1
    // av: ingen demping, selv om standardgrensen (3) ville vært nådd (episode 50 + 40 + 30 gir den fjerde, 20, over taket)
    expect(await busWith(false).publishBatch(TENANT_A, "home", [power(40), power(30), power(20)])).toMatchObject({ evaluated: 3, created: 3 });
    // et smalt vindu (10 min): episodene som startet for 50-20 min siden teller ikke, så en ny episode slippes inn selv med grense 1
    expect(await busWith({ windowMs: 10 * 60_000, maxEpisodes: 1 }).publishBatch(TENANT_A, "home", [power(15)])).toMatchObject({ evaluated: 1, created: 1 });
    // og en ugyldig grense (0) klemmes til 1 i stedet for å dempe ALT
    expect(await busWith({ maxEpisodes: 0, windowMs: 5 * 60_000 }).publishBatch(TENANT_A, "home", [power(10)])).toMatchObject({ evaluated: 1, created: 1 });
  });

  it("kamera og helse dempes ikke av denne mekanismen (kamera har sin egen cooldown, helse én nøkkel per døgn)", async () => {
    await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "doorbell_event", filter: {} }, actorOwner);
    const bells: VisionObservation[] = [0, 1, 2, 3, 4].map((n) => {
      const at = iso(NOW - (60 + n * 10) * 60_000); // ulike cooldown-vinduer (2 min)
      return { source: "vision", observation_id: `b${n}`, event_type: "doorbell_event", source_instance_id: "camera.dor", source_event_id: `event.dorklokke@${at}`, observed_at: at, object_label: null, classification_status: "not_applicable" };
    });
    const out = await busAt(NOW).publishBatch(TENANT_A, "home", bells);
    expect(out).toMatchObject({ evaluated: 5, created: 5 });
    expect(out.ignored.damped).toBe(0);
  });
});

// ---------------------------------------------------------------------
// B-LOW-6: tak per batch
// ---------------------------------------------------------------------
describe("B-LOW-6: backpressure - høyst MAX_OBSERVATIONS_PER_BATCH observasjoner per batch", () => {
  it("over taket telles `over_cap` (ikke behandlet); akkurat på taket er alt behandlet", async () => {
    expect(MAX_OBSERVATIONS_PER_BATCH).toBe(500);
    const many = (n: number): HomeObservation[] => Array.from({ length: n }, (_, i) => door({ entity_id: `binary_sensor.d${i}`, last_changed: minutesAgo(20) }));
    const exact = await busAt(NOW).publishBatch(TENANT_A, "home", many(500));
    expect(exact.received).toBe(500);
    expect(exact.ignored).toMatchObject({ no_subscription: 500, over_cap: 0 });
    const over = await busAt(NOW).publishBatch(TENANT_A, "home", many(600));
    expect(over.received).toBe(600);
    expect(over.ignored).toMatchObject({ no_subscription: 500, over_cap: 100 });
  });

  it("de første 500 behandles i rekkefølge (en abonnert observasjon helt til slutt av 600 blir IKKE behandlet; den første blir det)", async () => {
    await subscribeDoor();
    const filler = Array.from({ length: 550 }, (_, i) => door({ entity_id: `binary_sensor.fyll${i}` }));
    const out = await busAt(NOW).publishBatch(TENANT_A, "home", [door({ last_changed: minutesAgo(21) }), ...filler, door({ last_changed: minutesAgo(22) })]);
    expect(out.evaluated).toBe(1); // den første
    expect(out.ignored.over_cap).toBe(552 - 500);
    expect((await queue("home")).map((s) => s.detection_key)).toEqual([`home:opening:binary_sensor.inngang@${minutesAgo(21)}`]);
  });
});

// ---------------------------------------------------------------------
// B-LOW-7 / M27: per-bro-tester for kamera og helse (stille timer, undertrykking, tenant) + søvn/skritt gjennom bussen
// ---------------------------------------------------------------------
describe("B-LOW-7: kamerabroen gjennom bussen - stille timer, undertrykking og tenant-isolasjon", () => {
  const bell = (n: number, atMs: number): VisionObservation => ({
    source: "vision", observation_id: `bell-${n}`, event_type: "doorbell_event", source_instance_id: "camera.dor", source_event_id: `event.dorklokke@${iso(atMs)}`, observed_at: iso(atMs), object_label: null, classification_status: "not_applicable"
  });
  const subscribeBell = (tenant = TENANT_A) => db.registry.subscribe(tenant, "home", { source: "vision", event_type: "doorbell_event", filter: {} }, actorOwner);

  it("stille timer (22-06): dørklokken kl. 23 holdes (ikke logget, ingen varsel), evalueres på nytt, og varsles ETT sted etter stille timer", async () => {
    await subscribeBell();
    await quiet22to06("home");
    const ring = bell(1, T("2026-11-19T22:59:00.000Z"));
    const night = await busAt(T("2026-11-19T23:00:00.000Z")).publishBatch(TENANT_A, "home", [ring]);
    expect(night).toMatchObject({ evaluated: 1, created: 1, newly_actionable: 0, held: 1 });
    expect(await logs("home")).toHaveLength(0);
    expect(await deliver("home")).toEqual([]);
    const morning = await busAt(T("2026-11-20T07:00:00.000Z")).publishBatch(TENANT_A, "home", [ring]);
    expect(morning).toMatchObject({ evaluated: 1, newly_actionable: 1, held: 0 });
    expect(await deliver("home")).toEqual(["Jarvis oppdaget [vision, normal]: Dørklokkehendelse registrert"]);
    expect(await logs("home")).toHaveLength(1);
    expect((await busAt(T("2026-11-20T07:05:00.000Z")).publishBatch(TENANT_A, "home", [ring])).ignored.duplicate).toBe(1);
    expect(await deliver("home")).toEqual([]);
  });

  it("undertrykking: to ringinger i samme cooldown-vindu er ÉN situasjon og ÉN melding (to loggrader, den andre `updated`)", async () => {
    await subscribeBell();
    const base = T("2026-11-19T11:40:00.000Z");
    const out = await busAt(NOW).publishBatch(TENANT_A, "home", [bell(1, base + 10_000), bell(2, base + 50_000)]);
    expect(out).toMatchObject({ evaluated: 2, created: 1, newly_actionable: 1 });
    expect(await queue("home")).toHaveLength(1);
    expect(await deliver("home")).toHaveLength(1);
    expect((await logs("home")).map((l) => l.outcome).sort()).toEqual(["created", "updated"]);
  });

  it("tenant-isolasjon: B uten abonnement får ingenting av A sine observasjoner; B med eget abonnement får kun sin egen situasjon, og A er uberørt", async () => {
    await subscribeBell();
    const ring = bell(1, NOW - 60_000);
    expect(await busAt(NOW).publishBatch(TENANT_B, "home", [ring])).toMatchObject({ evaluated: 0 });
    expect(await queue("home", TENANT_B)).toHaveLength(0);
    await busAt(NOW).publishBatch(TENANT_A, "home", [ring]);
    expect(await queue("home")).toHaveLength(1);
    await subscribeBell(TENANT_B);
    expect(await busAt(NOW).publishBatch(TENANT_B, "home", [bell(9, NOW - 30_000)])).toMatchObject({ evaluated: 1, created: 1 });
    expect(await queue("home", TENANT_B)).toHaveLength(1);
    expect(await queue("home")).toHaveLength(1);
    expect((await logs("home", TENANT_B)).map((l) => l.person_id)).toEqual([OWNER]);
    expect(await deliver("home", TENANT_B)).toHaveLength(1);
  });
});

describe("B-LOW-7/M27: helsebroen gjennom bussen - stille timer, undertrykking, tenant og alle tre metrikker", () => {
  /** Flat baseline (100, sigma 3) over `offset` 1..40 relativt til `nowMs`, med de avvikende døgnene i `recent` (offset -> verdi). */
  function hseries(nowMs: number, recent: Record<number, number>): DailyPoint[] {
    const out: DailyPoint[] = [];
    for (let offset = 40; offset >= 1; offset -= 1) out.push({ day: new Date(nowMs - offset * DAY).toISOString().slice(0, 10), value: recent[offset] ?? 100, samples: 6 });
    return out;
  }
  const obs = (metric: HealthObservation["metric"], nowMs: number, recent: Record<number, number>): HealthObservation => ({ source: "health", metric, series: hseries(nowMs, recent) });
  const subscribeHealth = (eventType: string, tenant = TENANT_A) => db.registry.subscribe(tenant, "health", { source: "health", event_type: eventType, filter: { person_id: OWNER } }, actorOwner);
  const NEUTRAL = "Jarvis oppdaget [health, normal]: Avvik i helsedata fra din egen baseline - åpne Jarvis for detaljer. Dette er ikke medisinsk rådgivning.";

  it("stille timer: helseavviket kl. 23 holdes (ikke logget, ingen varsel) og varsles ETT sted etter stille timer - med nøytral tekst", async () => {
    await subscribeHealth("resting_heart_rate_deviation");
    await quiet22to06("health");
    const night = T("2026-11-19T23:00:00.000Z");
    const o = obs("resting_heart_rate", night, { 3: 107, 2: 107, 1: 107 });
    expect(await busAt(night).publishBatch(TENANT_A, "health", [o])).toMatchObject({ evaluated: 1, created: 1, newly_actionable: 0, held: 1 });
    expect(await logs("health")).toHaveLength(0);
    expect(await deliver("health")).toEqual([]);
    const morning = T("2026-11-20T07:00:00.000Z");
    expect(await busAt(morning).publishBatch(TENANT_A, "health", [obs("resting_heart_rate", morning, { 4: 107, 3: 107, 2: 107, 1: 107 })])).toMatchObject({ evaluated: 1, newly_actionable: 1 });
    expect(await deliver("health")).toEqual([NEUTRAL]);
  });

  it("undertrykking: en skjerpet alvorlighet på samme episode innenfor døgnet er ÉN situasjon og ÉN melding; neste døgn kan den varsles på nytt (`resuppress`)", async () => {
    await subscribeHealth("resting_heart_rate_deviation");
    expect(await busAt(NOW).publishBatch(TENANT_A, "health", [obs("resting_heart_rate", NOW, { 3: 107, 2: 107, 1: 107 })])).toMatchObject({ evaluated: 1, created: 1, newly_actionable: 1 });
    expect(await deliver("health")).toEqual([NEUTRAL]);
    const twoHours = NOW + 2 * 3_600_000;
    const moderate = await busAt(twoHours).publishBatch(TENANT_A, "health", [obs("resting_heart_rate", twoHours, { 3: 110, 2: 110, 1: 110 })]);
    expect(moderate).toMatchObject({ evaluated: 1, created: 0, newly_actionable: 0 }); // ny alvorlighet = ny loggnøkkel, men samme situasjon og ingen ny melding
    expect(await deliver("health")).toEqual([]);
    expect(await queue("health")).toHaveLength(1);
    // neste døgn (utenfor undertrykkelsen): episoden fortsetter og skjerpes -> ny melding, fortsatt samme situasjon
    const nextDay = NOW + 25 * 3_600_000;
    const strong = await busAt(nextDay).publishBatch(TENANT_A, "health", [obs("resting_heart_rate", nextDay, { 4: 120, 3: 120, 2: 120, 1: 120 })]);
    expect(strong).toMatchObject({ evaluated: 1, created: 0, newly_actionable: 1 });
    expect(await queue("health")).toHaveLength(1);
    expect((await deliver("health")).map((m) => m.replace(/\[health, \w+\]/, "[health, X]"))).toEqual([NEUTRAL.replace("[health, normal]", "[health, X]")]);
  });

  it("tenant-isolasjon: B uten abonnement får ingenting; B med eget abonnement får kun sin egen situasjon, og A er uberørt", async () => {
    await subscribeHealth("resting_heart_rate_deviation");
    const o = obs("resting_heart_rate", NOW, { 3: 107, 2: 107, 1: 107 });
    expect(await busAt(NOW).publishBatch(TENANT_B, "health", [o])).toMatchObject({ evaluated: 0 });
    await busAt(NOW).publishBatch(TENANT_A, "health", [o]);
    await subscribeHealth("resting_heart_rate_deviation", TENANT_B);
    expect(await busAt(NOW).publishBatch(TENANT_B, "health", [o])).toMatchObject({ evaluated: 1, created: 1 });
    expect(await queue("health")).toHaveLength(1);
    expect(await queue("health", TENANT_B)).toHaveLength(1);
    expect((await logs("health")).map((l) => l.person_id)).toEqual([OWNER]);
  });

  it("M27: søvn og skritt går gjennom bussen med SINE hendelsestyper (søvn -> sleep_duration_deviation, skritt -> activity_deviation), og et abonnement på feil type matcher ikke", async () => {
    // kun abonnement på aktivitet: en søvnobservasjon (lavere søvn) matcher ikke
    await subscribeHealth("activity_deviation");
    const sleep = obs("sleep_duration_minutes", NOW, { 3: 90, 2: 90, 1: 90 });
    expect(await busAt(NOW).publishBatch(TENANT_A, "health", [sleep])).toMatchObject({ evaluated: 0 });
    expect((await busAt(NOW).publishBatch(TENANT_A, "health", [sleep])).ignored.no_subscription).toBe(1);
    // kun abonnement på søvn: skritt matcher ikke
    await db.reset();
    await subscribeHealth("sleep_duration_deviation");
    const steps = obs("steps", NOW, { 3: 90, 2: 90, 1: 90 });
    expect((await busAt(NOW).publishBatch(TENANT_A, "health", [steps])).ignored.no_subscription).toBe(1);
    // begge abonnementer: hver metrikk får sin egen situasjon, loggrad og hendelsestype
    await subscribeHealth("activity_deviation");
    const out = await busAt(NOW).publishBatch(TENANT_A, "health", [sleep, steps]);
    expect(out).toMatchObject({ evaluated: 2, created: 2 });
    const rows = await logs("health");
    expect(rows.map((r) => `${r.event_type}:${r.detection_key.split(":").slice(0, 3).join(":")}`).sort()).toEqual([
      "activity_deviation:health:steps:below", "sleep_duration_deviation:health:sleep_duration_minutes:below"
    ]);
    expect(rows.every((r) => r.source === "health" && r.person_id === OWNER)).toBe(true);
    const keys = (await queue("health")).map((s) => s.detection_key.split(":").slice(0, 3).join(":")).sort();
    expect(keys).toEqual(["health:sleep_duration_minutes:below", "health:steps:below"]);
  });
});

// ---------------------------------------------------------------------
// M19 / M32: løperens standardkadens og minste oppslagsvindu
// ---------------------------------------------------------------------
describe("M19/M32: løperen leser helse hvert 15. tikk, og kameraet med et vindu på minst 10 minutter (3 x tikkintervall)", () => {
  function runnerFor(space: MemorySpace, readers: Partial<SignalSourceReaders>, over: Partial<SignalRunnerDeps> = {}): SituationSignalRunner {
    const { gateway } = db.newGateway();
    return new SituationSignalRunner({
      pool: db.appPool, bus: busAt(NOW), engine: db.engine, gateway, readers, subscriptions: (t, s) => db.registry.listEnabled(t, s),
      targets: [{ tenant_id: TENANT_A, memory_space: space }], identityFor: (t, s) => identity(t, s), guard: { blocked: async () => null }, intervalMs: 60_000, now: () => NOW, ...over
    });
  }

  it("standardkadensen for helse er 15: lest ved tikk 1, 15 og 30 (ikke hvert tikk); de andre kildene hvert tikk", async () => {
    expect(DEFAULT_SIGNAL_CADENCE).toEqual({ home_assistant: 1, vision: 1, incident: 1, health: 15 });
    await db.registry.subscribe(TENANT_A, "health", { source: "health", event_type: "resting_heart_rate_deviation", filter: { person_id: OWNER } }, actorOwner);
    const readAt: number[] = [];
    let tickNo = 0;
    const runner = runnerFor("health", { health: async () => { readAt.push(tickNo); return []; } });
    for (tickNo = 1; tickNo <= 31; tickNo += 1) await runner.tick();
    expect(readAt).toEqual([1, 15, 30]);
  });

  it("M27 (løper): abonnementets hendelsestype styrer hvilken metrikk som leses (hvilepuls, søvn, skritt) - aldri en annen", async () => {
    const asked: string[][] = [];
    const reader: Partial<SignalSourceReaders> = { health: async (_ctx, _person, metrics) => { asked.push([...metrics]); return []; } };
    for (const [eventType, metric] of [["resting_heart_rate_deviation", "resting_heart_rate"], ["sleep_duration_deviation", "sleep_duration_minutes"], ["activity_deviation", "steps"]] as const) {
      await db.reset();
      await db.registry.subscribe(TENANT_A, "health", { source: "health", event_type: eventType, filter: { person_id: OWNER } }, actorOwner);
      asked.length = 0;
      await runnerFor("health", reader).tick();
      expect(asked, eventType).toEqual([[metric]]);
    }
    // alle tre abonnementene: alle tre metrikkene, i ÉN lesing for eieren
    for (const eventType of ["resting_heart_rate_deviation", "sleep_duration_deviation", "activity_deviation"] as const) {
      await db.registry.subscribe(TENANT_A, "health", { source: "health", event_type: eventType, filter: { person_id: OWNER } }, actorOwner);
    }
    asked.length = 0;
    await runnerFor("health", reader).tick();
    expect(asked).toHaveLength(1);
    expect([...asked[0]!].sort()).toEqual(["resting_heart_rate", "sleep_duration_minutes", "steps"]);
  });

  it("kamera-oppslagsvinduet er max(10 min, 3 x intervall): 10 min ved 60 s, 30 min ved 10 min", async () => {
    expect(MIN_VISION_LOOKBACK_MS).toBe(10 * 60_000);
    await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "motion_detected", filter: {} }, actorOwner);
    const seen: number[] = [];
    const reader: Partial<SignalSourceReaders> = { vision: async (_ctx, sinceMs) => { seen.push(sinceMs); return []; } };
    await runnerFor("home", reader).tick();
    await runnerFor("home", reader, { intervalMs: 600_000 }).tick();
    await runnerFor("home", reader, { intervalMs: 120_000 }).tick(); // 3 x 2 min = 6 min < 10 min: minstevinduet gjelder
    expect(seen).toEqual([NOW - 10 * 60_000, NOW - 30 * 60_000, NOW - 10 * 60_000]);
  });
});

// ---------------------------------------------------------------------
// M08b / M08c: simulering er REN lesing av alle tabeller (også updated_at)
// ---------------------------------------------------------------------
describe("M08b/M08c: simulering rører ingen tabell (alle rader, inkl. updated_at, uendret) og skriver ingen vurdering", () => {
  const TABLES = [
    "situations", "situation_signal_log", "situation_assessments", "situation_feedback", "situation_rule_tuning", "situation_subscriptions", "situation_autonomy_policies",
    "situation_notification_policies", "situation_domain_pauses", "tool_executions"
  ];
  const snapshot = async (): Promise<Record<string, unknown[]>> => {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) out[table] = (await db.adminPool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
    out["audit_events"] = (await db.adminPool.query(`SELECT count(*)::int AS n FROM audit_events`)).rows;
    return out;
  };

  it("hele databasetilstanden før og etter `simulate()` er identisk, og simuleringen kjøres over en situasjon med logg, vurdering, tilbakemelding, tuning og binding", async () => {
    await subscribeDoor();
    const minutes = [16, 17, 18];
    for (const m of minutes) await busAt(NOW).publishBatch(TENANT_A, "home", [door({ last_changed: minutesAgo(m) })]);
    const target = (await queue("home"))[0]!;
    await deliver("home");
    await db.adminPool.query(
      `INSERT INTO situation_assessments (assessment_id, tenant_id, memory_space_id, situation_id, input_digest, status, category, priority_hint, explanation, provider, model, person_id)
       VALUES ('asm-purity', $1, 'home', $2, repeat('a', 64), 'applied', 'attention', 'normal', 'x', 'local_llm', 'gemma', $3)`, [TENANT_A, target.situation_id, OWNER]
    );
    await db.adminPool.query(
      `INSERT INTO situation_rule_tuning (tenant_id, memory_space_id, rule_key, threshold, reason, updated_by_person_id) VALUES ($1, 'home', 'home_assistant:door_open_too_long', 20, 'test', $2)`, [TENANT_A, OWNER]
    );
    await new FeedbackService(db.appPool, { owner_person_id: OWNER }, true, () => NOW).submit(TENANT_A, "home", target.situation_id, "noise", actorOwner);
    await db.engine.setAutonomyPolicy(TENANT_A, "home", { domain: "home", tool_id: "test_actuator", action: "close", parameters: { situation_id: "{{situation_id}}" } }, OWNER);

    const { gateway } = db.newGateway();
    const sim = new SimulationService(db.appPool, simulationToolInfoFrom(gateway), () => NOW);
    const before = await snapshot();
    expect((before["situation_assessments"] as unknown[]).length).toBe(1);
    expect((before["situation_feedback"] as unknown[]).length).toBe(1);
    expect((before["situations"] as unknown[]).length).toBe(3);
    const report = await sim.simulate(TENANT_A, "home", target.situation_id);
    expect(report.situation_id).toBe(target.situation_id);
    expect(await snapshot()).toEqual(before);
  });
});

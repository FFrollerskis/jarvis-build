import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { withDomainAdvisoryLocks } from "../src/advisory-lock.ts";
import type { HomeObservation } from "../src/home-bridge.ts";
import { DEFAULT_QUEUE_LIMIT, SituationActStaleError, SituationAutonomyBindingChangedError } from "../src/service.ts";
import { SituationSignalBus } from "../src/signal-bus.ts";
import { retireSignalSituations, SignalRetentionFailedError, touchSituation } from "../src/signal-retention.ts";
import { PURGE_RETRY_AFTER_FAILURE_MS, SituationSignalRunner, type SignalRunnerDeps, type SignalSourceReaders } from "../src/signal-runner.ts";
import type { VisionObservation } from "../src/vision-bridge.ts";
import { actorOwner, identity, minutesAgo, NOW, OWNER, startG4Db, TENANT_A, TENANT_B, type ActuatorSpy, type G4Db } from "./support/wpg4-db.ts";

/**
 * WP-G4 (D-466) FIKS-RUNDE, livssyklus for signalsituasjoner mot en EKTE Postgres + ekte motor + ekte ToolGateway (klasse D-kjede).
 *
 * A-MEDIUM-4/B-MEDIUM-3: (a) auto-ACT hadde ingen ferskhetsgrense - et forslag fra en måned siden ble UTFØRT da eieren senere bandt domenet; (b) `home`-situasjoner ble aldri løst (port åpen i tre døgn og siden lukket sto fortsatt
 * `open/suggest`); (c) signalsituasjonene ble aldri slettet og omgikk kildenes oppbevaring (en varig kamera-/helse-tidslinje); (d) `getQueue` hadde ingen grense. A-LOW-5: bindingen ble sjekket i en egen transaksjon FØR claimen
 * (en `clear_autonomy_policy` imellom ga ACT); utløpssjekken i re-verifiseringen (M02) var ikke testet.
 */
let db: G4Db;
let gateway: ToolGateway;
let actuator: ActuatorSpy;
let telegramCalls: () => number;

const bus = (): SituationSignalBus => new SituationSignalBus({ pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses, subscriptions: (t, s) => db.registry.listEnabled(t, s), now: () => NOW });
const garage = (over: Partial<HomeObservation> = {}): HomeObservation => ({ source: "home_assistant", entity_id: "cover.garasje", role: "garage_door", state: "open", last_changed: minutesAgo(70), ...over });
const gate = (over: Partial<HomeObservation> = {}): HomeObservation => garage({ entity_id: "cover.port", role: "gate", last_changed: minutesAgo(80), ...over });
const queue = (tenant = TENANT_A, space: "home" | "health" = "home") => db.engine.getQueue(tenant, space, { statusOpenOnly: false });
const bind = (over: Record<string, unknown> = {}) => db.engine.setAutonomyPolicy(TENANT_A, "home", { domain: "home", tool_id: "test_actuator", action: "close", parameters: { situation_id: "{{situation_id}}" }, ...over } as never, OWNER);
const act = (options?: { maxAgeMs?: number }) => db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"), options);
const subGarage = () => db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "cover.garasje", role: "garage_door" }, { entity_id: "cover.port", role: "gate" }] } }, actorOwner);
const age = (key: string, interval: string) => db.adminPool.query(`UPDATE situations SET updated_at = now() - interval '${interval}' WHERE detection_key = $1`, [key]);
const row = async (key: string) => (await db.adminPool.query(`SELECT status, stage, updated_at, resolved_at, act_idempotency_key FROM situations WHERE detection_key = $1`, [key])).rows[0] as { status: string; stage: string; updated_at: Date; resolved_at: Date | null; act_idempotency_key: string | null } | undefined;

/** Antall advisory-låser (innvilget/ventende) i klyngen akkurat nå; brukes til å vente på at en `actOn` faktisk står i kø på domenelåsen. */
const lockCount = (granted: boolean) => db.adminPool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND ${granted ? "" : "NOT "}granted`).then((r) => r.rows[0].n as number);
const untilLocks = async (granted: boolean, atLeast: number): Promise<void> => {
  for (let i = 0; i < 200 && (await lockCount(granted)) < atLeast; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(await lockCount(granted)).toBeGreaterThanOrEqual(atLeast);
};

beforeAll(async () => { db = await startG4Db("fixlife"); }, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);
beforeEach(async () => {
  const made = db.newGateway();
  gateway = made.gateway;
  actuator = made.actuator;
  telegramCalls = () => made.telegram.calls.length;
  await db.reset();
});

describe("A-MEDIUM-4: auto-ACT krever en FERSK observasjon (og bindingen sjekkes i claim-transaksjonen)", () => {
  it("et forslag uten observasjon på 3 timer UTFØRES ikke når eieren binder nå; en fersk observasjon (samme tilstand sett igjen) gjør det aktuelt", async () => {
    await subGarage();
    await bus().publishBatch(TENANT_A, "home", [garage()]);
    const key = (await queue())[0]!.detection_key;
    expect((await queue())[0]).toMatchObject({ stage: "suggest", priority: "high" });
    await age(key, "3 hours");
    await bind();
    expect(await act()).toEqual({ attempted: 0, succeeded: 0, denied: 0, skipped: 0 }); // gammelt forslag: ikke en kandidat
    expect(actuator.calls).toHaveLength(0);
    // tilstanden gjelder fortsatt og sees igjen: samme observasjon er `duplicate`, men bumper «sist sett»
    const again = await bus().publishBatch(TENANT_A, "home", [garage()]);
    expect(again.ignored.duplicate).toBe(1);
    expect(await act()).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(actuator.calls.filter((c) => c.action === "close")).toHaveLength(1);
  });

  it("ferskhetsvinduet er konfigurerbart (`maxAgeMs`): en situasjon sett for 10 minutter siden er en kandidat med 15 minutters vindu, men ikke med 5", async () => {
    await subGarage();
    await bus().publishBatch(TENANT_A, "home", [garage()]);
    await age((await queue())[0]!.detection_key, "10 minutes");
    await bind();
    expect(await act({ maxAgeMs: 5 * 60_000 })).toMatchObject({ attempted: 0, skipped: 0 });
    expect(await act({ maxAgeMs: 15 * 60_000 })).toMatchObject({ attempted: 1 });
  });

  it("claim-vakten (A-LOW-5): en binding som er tilbakekalt, utløpt, deaktivert eller endret mellom utvalg og claim gir INGEN claim og INGET kall; en uendret binding utføres", async () => {
    await subGarage();
    await bus().publishBatch(TENANT_A, "home", [garage()]);
    const sit = (await queue())[0]!;
    const request = { tool_id: "test_actuator", action: "close", parameters: { situation_id: sit.situation_id }, idempotency_key: "auto-act" };
    const guarded = () => db.engine.actOn(TENANT_A, "home", sit.situation_id, request, gateway, identity(TENANT_A, "home"), { autoActGuard: { max_age_seconds: 3600 } });
    // 1) ingen binding (aldri satt / tilbakekalt)
    await expect(guarded()).rejects.toBeInstanceOf(SituationAutonomyBindingChangedError);
    await bind();
    await db.engine.clearAutonomyPolicy(TENANT_A, "home", "home", OWNER);
    await expect(guarded()).rejects.toBeInstanceOf(SituationAutonomyBindingChangedError);
    // 2) deaktivert, 3) utløpt, 4) endret handling/parametre (en annen operasjon enn den som ble valgt)
    await bind({ enabled: false });
    await expect(guarded()).rejects.toBeInstanceOf(SituationAutonomyBindingChangedError);
    await bind({ expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    await db.adminPool.query(`UPDATE situation_autonomy_policies SET expires_at = now() - interval '1 minute' WHERE tenant_id = '${TENANT_A}'`);
    await expect(guarded()).rejects.toBeInstanceOf(SituationAutonomyBindingChangedError);
    await bind({ parameters: { situation_id: "{{situation_id}}", extra: "annet" } as never });
    await expect(guarded()).rejects.toBeInstanceOf(SituationAutonomyBindingChangedError);
    expect(actuator.calls).toHaveLength(0);
    expect((await row(sit.detection_key))?.act_idempotency_key).toBeNull(); // aldri claimet
    // uendret binding: utføres
    await bind();
    const done = await guarded();
    expect(done.tool_result.ok).toBe(true);
    expect(actuator.calls.filter((c) => c.action === "close")).toHaveLength(1);
  });

  it("claim-vakten krever fortsatt åpen/`suggest` og fersk observasjon: løst situasjon og gammel situasjon gir `SituationActStaleError` uten claim", async () => {
    await subGarage();
    await bind();
    await bus().publishBatch(TENANT_A, "home", [garage()]);
    const sit = (await queue())[0]!;
    const request = { tool_id: "test_actuator", action: "close", parameters: { situation_id: sit.situation_id }, idempotency_key: "auto-act" };
    const guarded = () => db.engine.actOn(TENANT_A, "home", sit.situation_id, request, gateway, identity(TENANT_A, "home"), { autoActGuard: { max_age_seconds: 3600 } });
    await age(sit.detection_key, "3 hours");
    await expect(guarded()).rejects.toMatchObject({ name: "SituationActStaleError", reason: "not_fresh" });
    await db.adminPool.query(`UPDATE situations SET updated_at = now(), status = 'resolved', resolved_at = now() WHERE situation_id = $1`, [sit.situation_id]);
    await expect(guarded()).rejects.toBeInstanceOf(SituationActStaleError);
    await expect(guarded()).rejects.toMatchObject({ reason: "not_open_suggest" });
    expect(actuator.calls).toHaveLength(0);
    expect((await row(sit.detection_key))?.act_idempotency_key).toBeNull();
  });

  it("TOCTOU (A-LOW-5): bindingen fjernes MELLOM utvalget og claimen (mens `actOn` står i kø på domenelåsen) -> ingen ACT, situasjonen er `skipped` og aldri claimet", async () => {
    await subGarage();
    await bus().publishBatch(TENANT_A, "home", [garage()]);
    await bind();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const advisory = (granted: boolean) => db.adminPool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND ${granted ? "" : "NOT "}granted`).then((r) => r.rows[0].n as number);
    const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 200 && !(await check()); i += 1) await new Promise((resolve) => setTimeout(resolve, 25)); };
    const holder = withDomainAdvisoryLocks(db.appPool, ["home"], async () => { await gate; }); // en annen holder har domenelåsen (som en pågående set/clear av bindingen)
    await until(async () => (await advisory(true)) >= 1);
    const pending = act(); // utvalg + re-verifisering OK (bindingen finnes), så venter `actOn` på låsen
    await until(async () => (await advisory(false)) >= 1);
    expect(await advisory(false)).toBeGreaterThanOrEqual(1); // `actOn` står faktisk i kø
    await db.adminPool.query(`DELETE FROM situation_autonomy_policies WHERE tenant_id = '${TENANT_A}'`); // eieren tilbakekaller akkurat nå
    release();
    await holder;
    expect(await pending).toMatchObject({ attempted: 0, succeeded: 0, skipped: 1 });
    expect(actuator.calls).toHaveLength(0);
    expect((await queue())[0]?.act_idempotency_key).toBeNull();
  });

  it("`SituationActStaleError` fra claim-vakten (situasjonen løses mens `actOn` står i kø på domenelåsen) er en hoppet-over-situasjon: sveipet fortsetter med neste og kaster ikke (D-INFO-1, delta-review A)", async () => {
    await subGarage();
    await bus().publishBatch(TENANT_A, "home", [garage(), gate()]);
    await bind();
    // sveipet går i rekkefølgen `opened_at`: garasjen først, porten sist
    await db.adminPool.query(`UPDATE situations SET opened_at = now() - interval '2 minutes' WHERE detection_key LIKE 'home:opening:cover.garasje@%'`);
    await db.adminPool.query(`UPDATE situations SET opened_at = now() - interval '1 minute' WHERE detection_key LIKE 'home:opening:cover.port@%'`);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const holder = withDomainAdvisoryLocks(db.appPool, ["home"], async () => { await hold; });
    await untilLocks(true, 1);
    const pending = act(); // utvalg + re-verifisering OK for garasjen, så venter `actOn` på låsen
    await untilLocks(false, 1);
    await db.adminPool.query(`UPDATE situations SET status = 'resolved', resolved_at = now() WHERE detection_key LIKE 'home:opening:cover.garasje@%'`); // garasjen løses mens `actOn` venter
    release();
    await holder;
    expect(await pending).toEqual({ attempted: 1, succeeded: 1, denied: 0, skipped: 1 }); // garasjen: `SituationActStaleError` -> hoppet over; porten: utført
    const closes = actuator.calls.filter((c) => c.action === "close");
    expect(closes).toHaveLength(1);
    const gateSituation = (await queue()).find((s) => s.detection_key.startsWith("home:opening:cover.port@"))!;
    expect(closes[0]!.parameters).toMatchObject({ situation_id: gateSituation.situation_id });
    expect((await queue()).find((s) => s.detection_key.startsWith("home:opening:cover.garasje@"))).toMatchObject({ status: "resolved", act_idempotency_key: null }); // aldri claimet
  });

  it("løperen bruker ferskhetsvinduet: eksplisitt `autoActMaxAgeMs`, og standard = max(1 time, 3 x tikkintervall)", async () => {
    await subGarage();
    await bus().publishBatch(TENANT_A, "home", [garage()]);
    await bind();
    const key = (await queue())[0]!.detection_key;
    const runner = (over: Partial<SignalRunnerDeps>) => new SituationSignalRunner({
      pool: db.appPool, bus: bus(), engine: db.engine, gateway, readers: { home: async () => [] }, subscriptions: (t, s) => db.registry.listEnabled(t, s),
      targets: [{ tenant_id: TENANT_A, memory_space: "home" }], identityFor: (t, s) => identity(t, s), guard: { blocked: async () => null }, intervalMs: 60_000, now: () => NOW, ...over
    });
    await age(key, "10 minutes");
    expect((await runner({ autoActMaxAgeMs: 5 * 60_000 }).tick()).auto_act_attempted).toBe(0); // eksplisitt 5 min: 10 min gammel er for gammel
    await age(key, "3 hours");
    expect((await runner({}).tick()).auto_act_attempted).toBe(0); // standard (tikk 1 min): 1 time
    expect((await runner({ intervalMs: 2 * 3_600_000 }).tick()).auto_act_attempted).toBe(1); // tikk 2 t: vindu 6 t
  });

  it("utløp MIDT i et sveip (M02): to forslag, bindingen utløper under første ACT -> ETT kall, det andre hoppes over (ikke claimet)", async () => {
    await subGarage();
    await bus().publishBatch(TENANT_A, "home", [garage(), gate()]);
    expect((await queue()).filter((s) => s.stage === "suggest")).toHaveLength(2);
    await bind({ expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    actuator.onClose = async () => { await db.adminPool.query(`UPDATE situation_autonomy_policies SET expires_at = now() - interval '1 minute' WHERE tenant_id = '${TENANT_A}'`); };
    const actOnSpy = vi.spyOn(db.engine, "actOn");
    try {
      const result = await act();
      expect(result).toMatchObject({ attempted: 1, succeeded: 1, skipped: 1 });
      // To lag, hver for seg: re-verifiseringen hopper over en utløpt binding FØR `actOn` (ingen lås, ingen claim - `actOn` kalles kun for den første), og claim-vakten fanger den uansett (forsvar i dybden, testet over).
      expect(actOnSpy).toHaveBeenCalledTimes(1);
    } finally {
      actOnSpy.mockRestore();
    }
    expect(actuator.calls.filter((c) => c.action === "close")).toHaveLength(1);
    expect((await queue()).filter((s) => s.act_idempotency_key === null)).toHaveLength(1); // den andre er aldri claimet
  });
});

describe("A-MEDIUM-4: «sist sett» - en observasjon som fortsatt gjelder bumper updated_at (høyst hvert 5. minutt), og rører aldri en løst situasjon", () => {
  it("duplicate innen 5 minutter skriver ikke; eldre enn 5 minutter bumper; løst situasjon og ukjent nøkkel røres ikke", async () => {
    await subGarage();
    await bus().publishBatch(TENANT_A, "home", [garage()]);
    const key = (await queue())[0]!.detection_key;
    const fresh = await row(key);
    await bus().publishBatch(TENANT_A, "home", [garage()]); // duplicate, men < 5 min: ingen skriving
    expect((await row(key))?.updated_at).toEqual(fresh?.updated_at);
    await age(key, "10 minutes");
    const old = (await row(key))!.updated_at;
    expect(await touchSituation(db.appPool, TENANT_A, "home", key)).toBe(true);
    expect((await row(key))!.updated_at.getTime()).toBeGreaterThan(old.getTime() + 9 * 60_000);
    await db.adminPool.query(`UPDATE situations SET status = 'resolved', resolved_at = now(), updated_at = now() - interval '2 hours' WHERE detection_key = $1`, [key]);
    expect(await touchSituation(db.appPool, TENANT_A, "home", key)).toBe(false);
    expect(await touchSituation(db.appPool, TENANT_A, "home", "home:opening:finnes-ikke@x")).toBe(false);
    expect(await touchSituation(db.appPool, TENANT_B, "home", key)).toBe(false); // annen tenant
  });
});

describe("A-MEDIUM-4/B-MEDIUM-3: tilstand normal -> åpne situasjoner for entiteten løses (aldri på gjetning)", () => {
  const door = (over: Partial<HomeObservation> = {}): HomeObservation => ({ source: "home_assistant", entity_id: "binary_sensor.inngang", role: "door", state: "on", last_changed: minutesAgo(20), ...over });
  const leak = (over: Partial<HomeObservation> = {}): HomeObservation => ({ source: "home_assistant", entity_id: "binary_sensor.kjeller", role: "leak", state: "on", last_changed: minutesAgo(5), ...over });
  const alarm = (over: Partial<HomeObservation> = {}): HomeObservation => ({ source: "home_assistant", entity_id: "alarm_control_panel.hus", role: "alarm", state: "triggered", last_changed: minutesAgo(3), ...over });
  const power = (ticks: number, over: Partial<HomeObservation> = {}): HomeObservation => ({
    source: "home_assistant", entity_id: "sensor.ovn", role: "power", state: ticks > 0 ? "2500" : "800", last_changed: minutesAgo(4), limit_w: 2000, over_limit_ticks: ticks, over_limit_since: minutesAgo(4), ...over
  });
  async function subscribeAll(): Promise<void> {
    const sub = (event_type: string, entities: Array<Record<string, unknown>>) => db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type, filter: { entities } }, actorOwner);
    await sub("door_open_too_long", [{ entity_id: "binary_sensor.inngang", role: "door" }]);
    await sub("water_leak", [{ entity_id: "binary_sensor.kjeller", role: "leak" }]);
    await sub("alarm_triggered", [{ entity_id: "alarm_control_panel.hus", role: "alarm" }]);
    await sub("power_over_limit", [{ entity_id: "sensor.ovn", role: "power", limit_w: 2000 }]);
  }
  const openKeys = async () => (await db.engine.getQueue(TENANT_A, "home")).map((s) => s.detection_key.split(":")[1]).sort();

  it("port åpen (suggest) og siden meldt lukket: situasjonen løses, og en ny binding utfører INGEN ACT på den", async () => {
    await subGarage();
    await bus().publishBatch(TENANT_A, "home", [garage()]);
    expect((await queue())[0]).toMatchObject({ stage: "suggest", status: "open" });
    const closed = await bus().publishBatch(TENANT_A, "home", [garage({ state: "closed", last_changed: minutesAgo(1) })]);
    expect(closed.ignored.no_signal).toBe(1);
    const after = (await queue())[0]!;
    expect(after.status).toBe("resolved");
    expect(after.resolved_at).not.toBeNull();
    await bind();
    expect(await act()).toEqual({ attempted: 0, succeeded: 0, denied: 0, skipped: 0 });
    expect(actuator.calls).toHaveLength(0);
  });

  it("hver art løses av sin normale tilstand (dør lukket, sensor tørr, alarm avarmert, effekt under grensen); overgangs-/ukjente tilstander og andre entiteter røres ikke", async () => {
    await subscribeAll();
    await bus().publishBatch(TENANT_A, "home", [door(), leak(), alarm(), power(3)]);
    expect(await openKeys()).toEqual(["alarm", "leak", "opening", "power"]);
    // overgang/ukjent: ingenting løses
    await bus().publishBatch(TENANT_A, "home", [door({ state: "closing" }), door({ state: "unavailable" }), leak({ state: "unavailable" }), alarm({ state: "pending" }), alarm({ state: "unknown" }), { source: "home_assistant", entity_id: "sensor.ovn", role: "power", state: "unavailable", last_changed: minutesAgo(4) }]);
    expect(await openKeys()).toEqual(["alarm", "leak", "opening", "power"]);
    // en annen entitet (ikke abonnert) i normal tilstand løser ingenting
    await bus().publishBatch(TENANT_A, "home", [door({ entity_id: "binary_sensor.annen", state: "off" })]);
    expect(await openKeys()).toEqual(["alarm", "leak", "opening", "power"]);
    // normal tilstand, én art om gangen
    await bus().publishBatch(TENANT_A, "home", [door({ state: "off", last_changed: minutesAgo(1) })]);
    expect(await openKeys()).toEqual(["alarm", "leak", "power"]);
    await bus().publishBatch(TENANT_A, "home", [leak({ state: "off" })]);
    expect(await openKeys()).toEqual(["alarm", "power"]);
    await bus().publishBatch(TENANT_A, "home", [alarm({ state: "disarmed" })]);
    expect(await openKeys()).toEqual(["power"]);
    await bus().publishBatch(TENANT_A, "home", [power(0)]);
    expect(await openKeys()).toEqual([]);
    expect((await queue()).every((s) => s.status === "resolved")).toBe(true);
  });

  it("løsing krever abonnement og at domenet ikke er pauset; samme åpnings-nøkkel fra kamerasensoren løses også, og en NY åpning etter lukking er en ny situasjon", async () => {
    await db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "binary_sensor.inngang", role: "door" }] } }, actorOwner);
    const opened = new Date(NOW - 20 * 60_000).toISOString();
    await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "opening_detected", filter: {} }, actorOwner);
    const visionOpening: VisionObservation = {
      source: "vision", observation_id: "o1", event_type: "opening_detected", source_instance_id: "camera.inngang", source_event_id: `binary_sensor.inngang@${opened}`,
      observed_at: opened, object_label: null, classification_status: "not_applicable"
    };
    await bus().publishBatch(TENANT_A, "home", [visionOpening]);
    expect(await openKeys()).toEqual(["opening"]);
    // pauset domene: ingen løsing
    await db.domainPauses.pauseDurable("home", "eier stoppet", OWNER);
    await bus().publishBatch(TENANT_A, "home", [door({ state: "off" })]);
    expect(await openKeys()).toEqual(["opening"]);
    await db.domainPauses.unpauseDurable("home", OWNER);
    // uten abonnement på døra: ingen løsing (observasjonen er `no_subscription`)
    const sub = (await db.registry.list(TENANT_A, "home")).find((s) => s.source === "home_assistant")!;
    await db.registry.remove(TENANT_A, "home", sub.subscription_id, actorOwner);
    await bus().publishBatch(TENANT_A, "home", [door({ state: "off" })]);
    expect(await openKeys()).toEqual(["opening"]);
    await subscribeAll();
    await bus().publishBatch(TENANT_A, "home", [door({ state: "off" })]);
    expect(await openKeys()).toEqual([]); // kameraets åpning (samme nøkkel `home:opening:<entitet>@<tid>`) er løst
    // ny åpning (ny last_changed) = ny situasjon
    await bus().publishBatch(TENANT_A, "home", [door({ last_changed: minutesAgo(25) })]);
    expect(await openKeys()).toEqual(["opening"]);
  });
});

describe("B-MEDIUM-3: retensjon - gamle åpne signalsituasjoner løses, og signalsituasjoner eldre enn kildedataene slettes", () => {
  async function seed(domain: string, key: string, space: "home" | "health" = "home", tenant = TENANT_A): Promise<void> {
    await db.engine.evaluateCandidate(tenant, space, { domain, detection_key: key, priority: "normal", reason: "r" }, NOW);
  }
  const exists = async (key: string) => (await row(key)) !== undefined;

  it("sletter etter kildens oppbevaring (kamera 7 d, standard 30 d), løser åpne > 48 t uten å forlenge levetiden, og rører aldri claimede, andre domener eller andre tenants", async () => {
    await seed("home", "home:opening:fersk@a");
    await seed("home", "home:opening:tre-dager@a");
    await seed("home", "home:opening:fire-tiar@a");
    await seed("home", "home:leak:losen-fire-tiar@a");
    await seed("vision", "vision:motion_detected:cam:ti-dager");
    await seed("vision", "vision:motion_detected:cam:fem-dager");
    await seed("home", "home:opening:claimet@a");
    await seed("business", "business:open_loop:gammel");
    await seed("business", "home:opening:feil-domene@a"); // signalprefiks, men ikke et signaldomene
    await seed("home", "legacy:gammel"); // signaldomene, men ikke en signalnøkkel
    await seed("home", "home:opening:annen-tenant@a", "home", TENANT_B);
    await age("home:opening:feil-domene@a", "100 days");
    await age("legacy:gammel", "100 days");
    await age("home:opening:tre-dager@a", "3 days");
    await age("home:opening:fire-tiar@a", "40 days");
    await age("home:leak:losen-fire-tiar@a", "40 days");
    await db.adminPool.query(`UPDATE situations SET status = 'resolved', resolved_at = now() - interval '40 days' WHERE detection_key = 'home:leak:losen-fire-tiar@a'`);
    await age("vision:motion_detected:cam:ti-dager", "10 days");
    await age("vision:motion_detected:cam:fem-dager", "5 days");
    await age("home:opening:claimet@a", "100 days");
    await db.adminPool.query(`UPDATE situations SET act_claimed_at = now(), act_idempotency_key = 'k', act_operation_fingerprint = 'f', act_notify_message = 'm' WHERE detection_key = 'home:opening:claimet@a'`);
    await age("business:open_loop:gammel", "100 days");
    await age("home:opening:annen-tenant@a", "100 days");
    // signalloggrad på en situasjon som slettes: skal følge med (kaskade)
    const doomed = (await db.adminPool.query(`SELECT situation_id FROM situations WHERE detection_key = 'home:opening:fire-tiar@a'`)).rows[0].situation_id as string;
    await db.adminPool.query(
      `INSERT INTO situation_signal_log (signal_id, tenant_id, memory_space_id, source, event_type, domain, source_ref, detection_key, situation_id, occurred_at, outcome, stage_after, priority, notified, facts, person_id)
       VALUES ('sig-x', '${TENANT_A}', 'home', 'home_assistant', 'door_open_too_long', 'home', 'home:opening:fire-tiar@a#L1', 'home:opening:fire-tiar@a', $1, now(), 'created', 'inform', 'normal', true, '{}', '${OWNER}')`, [doomed]
    );
    const before = (await row("home:opening:tre-dager@a"))!.updated_at;

    const out = await retireSignalSituations(db.appPool, TENANT_A, "home", { retentionDays: 30, visionDays: 7 });
    expect(out).toEqual({ resolved: 2, deleted: 3 }); // løst: tre-dager + fem-dager (vision); slettet: fire-tiar åpen, fire-tiar løst, vision ti-dager
    expect(await exists("home:opening:fire-tiar@a")).toBe(false);
    expect(await exists("home:leak:losen-fire-tiar@a")).toBe(false);
    expect(await exists("vision:motion_detected:cam:ti-dager")).toBe(false);
    expect((await db.adminPool.query(`SELECT count(*)::int AS n FROM situation_signal_log WHERE signal_id = 'sig-x'`)).rows[0].n).toBe(0);
    expect(await row("home:opening:fersk@a")).toMatchObject({ status: "open" });
    expect(await row("home:opening:tre-dager@a")).toMatchObject({ status: "resolved" });
    expect((await row("home:opening:tre-dager@a"))!.updated_at).toEqual(before); // løsing forlenger ikke levetiden
    expect(await row("vision:motion_detected:cam:fem-dager")).toMatchObject({ status: "resolved" });
    expect(await row("home:opening:claimet@a")).toMatchObject({ status: "open", act_idempotency_key: "k" }); // claimet: røres aldri
    expect(await row("business:open_loop:gammel")).toMatchObject({ status: "open" }); // ikke en signalsituasjon
    expect(await row("home:opening:feil-domene@a")).toMatchObject({ status: "open" }); // domene business: aldri
    expect(await row("legacy:gammel")).toMatchObject({ status: "open" }); // ikke en signalnøkkel: aldri
    expect(await exists("home:opening:annen-tenant@a")).toBe(true); // annen tenant
    // idempotent
    expect(await retireSignalSituations(db.appPool, TENANT_A, "home", { retentionDays: 30, visionDays: 7 })).toEqual({ resolved: 0, deleted: 0 });
  });

  it("kildens oppbevaring kan aldri FORLENGE levetiden utover standard (min), og løsefristen kan konfigureres", async () => {
    await seed("vision", "vision:motion_detected:cam:40-dager");
    await seed("home", "home:opening:fem-timer@a");
    await age("vision:motion_detected:cam:40-dager", "40 days");
    await age("home:opening:fem-timer@a", "5 hours");
    // kameraet vil beholde 90 dager, men standarden er 30: slettes. Løsefrist 4 t: fem-timer løses.
    expect(await retireSignalSituations(db.appPool, TENANT_A, "home", { retentionDays: 30, visionDays: 90, resolveAfterHours: 4 })).toEqual({ resolved: 1, deleted: 1 });
    expect(await exists("vision:motion_detected:cam:40-dager")).toBe(false);
    expect(await row("home:opening:fem-timer@a")).toMatchObject({ status: "resolved" });
  });

  it("helse følger helsedataenes oppbevaring (min av den og standard), også for dato-nøklede situasjoner", async () => {
    await seed("health", "health:resting_heart_rate:high:2026-11-01", "health");
    await seed("health", "health:resting_heart_rate:high:2026-11-10", "health");
    await age("health:resting_heart_rate:high:2026-11-01", "10 days");
    await age("health:resting_heart_rate:high:2026-11-10", "3 days");
    expect(await retireSignalSituations(db.appPool, TENANT_A, "health", { retentionDays: 30, healthDays: 5 })).toEqual({ resolved: 1, deleted: 1 });
    expect(await exists("health:resting_heart_rate:high:2026-11-01")).toBe(false);
    expect(await row("health:resting_heart_rate:high:2026-11-10")).toMatchObject({ status: "resolved" });
    // uten helsepolicy (null) gjelder standard 30 dager
    await seed("health", "health:steps:low:2026-10-01", "health");
    await age("health:steps:low:2026-10-01", "10 days");
    expect(await retireSignalSituations(db.appPool, TENANT_A, "health", { retentionDays: 30, healthDays: null })).toEqual({ resolved: 1, deleted: 0 });
  });

  it("løperens daglige opprydding kjører også UTEN abonnement, bruker kildenes oppbevaring fra injiserte funksjoner (en feilende funksjon gir standard), og høyst én gang per døgn", async () => {
    await seed("vision", "vision:motion_detected:cam:ti-dager");
    await seed("home", "home:opening:fire-tiar@a");
    await age("vision:motion_detected:cam:ti-dager", "10 days");
    await age("home:opening:fire-tiar@a", "40 days");
    let clock = Date.now();
    const runner = new SituationSignalRunner({
      pool: db.appPool, bus: bus(), engine: db.engine, gateway, readers: {} as SignalSourceReaders, subscriptions: (t, s) => db.registry.listEnabled(t, s),
      targets: [{ tenant_id: TENANT_A, memory_space: "home" }], identityFor: (t, s) => identity(t, s), guard: { blocked: async () => null }, intervalMs: 60_000, now: () => clock,
      sourceRetention: { visionDays: async () => 7, healthDays: async () => { throw new Error("helse nede"); } }
    } as SignalRunnerDeps);
    expect(await db.registry.listEnabled(TENANT_A, "home")).toHaveLength(0); // ingen abonnement
    const tick = await runner.tick();
    expect(tick.status).toBe("ok");
    expect(await exists("vision:motion_detected:cam:ti-dager")).toBe(false); // kamera 7 d
    expect(await exists("home:opening:fire-tiar@a")).toBe(false); // standard 30 d
    // høyst én gang per døgn
    await seed("home", "home:opening:ny-gammel@a");
    await age("home:opening:ny-gammel@a", "40 days");
    clock += 60_000;
    await runner.tick();
    expect(await exists("home:opening:ny-gammel@a")).toBe(true);
    clock += 25 * 3_600_000;
    await runner.tick();
    expect(await exists("home:opening:ny-gammel@a")).toBe(false);
    expect(telegramCalls()).toBe(0);
  });
});

describe("B-MEDIUM-3: getQueue har et tak", () => {
  it("standard 500 rader (ikke ubegrenset), eksplisitt `limit` klemmes til 1-2000, og rekkefølgen (høy prioritet først) er bevart", async () => {
    expect(DEFAULT_QUEUE_LIMIT).toBe(500); // pinnet: en stille økning av standardtaket skal feile her
    await db.adminPool.query(
      `INSERT INTO situations (situation_id, tenant_id, memory_space_id, domain, detection_key, stage, priority, reason)
       SELECT 'sit-q-' || g, '${TENANT_A}', 'home', 'home', 'home:opening:q' || g || '@x', 'remember', CASE WHEN g = 7 THEN 'high' ELSE 'low' END, 'r' FROM generate_series(1, 501) AS g`
    );
    const all = await db.engine.getQueue(TENANT_A, "home");
    expect(all).toHaveLength(500);
    expect(all[0]).toMatchObject({ priority: "high", situation_id: "sit-q-7" }); // sortert først, deretter tak
    expect(await db.engine.getQueue(TENANT_A, "home", { limit: 3 })).toHaveLength(3);
    expect(await db.engine.getQueue(TENANT_A, "home", { limit: 0 })).toHaveLength(1);
    expect(await db.engine.getQueue(TENANT_A, "home", { limit: 1_000_000 })).toHaveLength(501);
  });
});

describe("D-MEDIUM-1 (delta-review B): en beslutning som refererer en gammel signalsituasjon velter ikke oppryddingen", () => {
  async function seed(domain: string, key: string, space: "home" | "health" = "home"): Promise<string> {
    return (await db.engine.evaluateCandidate(TENANT_A, space, { domain, detection_key: key, priority: "normal", reason: "r" }, NOW)).situation.situation_id;
  }
  const decide = (decisionId: string, situationId: string, space: "home" | "health" = "home") =>
    db.adminPool.query(
      `INSERT INTO decision_log (decision_id, tenant_id, memory_space_id, title, rationale, decision_maker, related_situation_id) VALUES ($1, $2, $3, 'Ignorer døralarm', 'eierens valg', 'owner', $4)`,
      [decisionId, TENANT_A, space, situationId]
    );
  const decisions = async () => (await db.adminPool.query(`SELECT decision_id, related_situation_id FROM decision_log WHERE tenant_id = $1 ORDER BY decision_id`, [TENANT_A])).rows as Array<{ decision_id: string; related_situation_id: string | null }>;

  it("den refererte situasjonen består (og løses som vanlig) mens alle ANDRE gamle rader slettes/løses i samme sveip - ingen 23503, og beslutningen er urørt", async () => {
    const ref = await seed("home", "home:opening:referert@a");
    await seed("home", "home:opening:gammel@a");
    await seed("home", "home:opening:tre-dager@a");
    await seed("health", "health:steps:low:2026-10-01", "health");
    await age("home:opening:referert@a", "40 days");
    await age("home:opening:gammel@a", "41 days");
    await age("home:opening:tre-dager@a", "3 days");
    await age("health:steps:low:2026-10-01", "40 days");
    await decide("dec-1", ref);

    expect(await retireSignalSituations(db.appPool, TENANT_A, "home", { retentionDays: 30 })).toEqual({ resolved: 2, deleted: 1 }); // løst: referert + tre-dager; slettet: kun den ureferte
    expect(await row("home:opening:gammel@a")).toBeUndefined();
    expect(await row("home:opening:referert@a")).toMatchObject({ status: "resolved" });
    expect(await row("home:opening:tre-dager@a")).toMatchObject({ status: "resolved" });
    expect(await decisions()).toEqual([{ decision_id: "dec-1", related_situation_id: ref }]); // eierens historikk er urørt og peker fortsatt på en eksisterende situasjon
    // idempotent: den refererte raden velter heller ikke neste døgns sveip
    expect(await retireSignalSituations(db.appPool, TENANT_A, "home", { retentionDays: 30 })).toEqual({ resolved: 0, deleted: 0 });
    expect(await row("home:opening:referert@a")).toBeDefined();
    // et annet rom røres aldri av hjem-sveipet
    expect(await row("health:steps:low:2026-10-01")).toBeDefined();
    // unntaket varer kun så lenge beslutningen: er den borte, slettes situasjonen av neste sveip
    await db.adminPool.query(`DELETE FROM decision_log WHERE decision_id = 'dec-1'`);
    expect(await retireSignalSituations(db.appPool, TENANT_A, "home", { retentionDays: 30 })).toEqual({ resolved: 0, deleted: 1 });
    expect(await row("home:opening:referert@a")).toBeUndefined();
  });

  it("helse- og kameradomenene har samme unntak (en referert 40 d gammel helse-/kamerasituasjon blokkerer ikke 7 d-oppbevaringen for de andre)", async () => {
    const health = await seed("health", "health:steps:low:2026-10-01", "health");
    await seed("health", "health:steps:low:2026-10-02", "health");
    const vision = await seed("vision", "vision:motion_detected:cam:referert");
    await seed("vision", "vision:motion_detected:cam:uten-referanse");
    for (const key of ["health:steps:low:2026-10-01", "health:steps:low:2026-10-02", "vision:motion_detected:cam:referert", "vision:motion_detected:cam:uten-referanse"]) await age(key, "40 days");
    await decide("dec-h", health, "health");
    await decide("dec-v", vision, "home");
    expect(await retireSignalSituations(db.appPool, TENANT_A, "health", { retentionDays: 30, healthDays: 7 })).toEqual({ resolved: 1, deleted: 1 });
    expect(await retireSignalSituations(db.appPool, TENANT_A, "home", { retentionDays: 30, visionDays: 7 })).toEqual({ resolved: 1, deleted: 1 });
    expect(await row("health:steps:low:2026-10-01")).toMatchObject({ status: "resolved" });
    expect(await row("health:steps:low:2026-10-02")).toBeUndefined();
    expect(await row("vision:motion_detected:cam:referert")).toMatchObject({ status: "resolved" });
    expect(await row("vision:motion_detected:cam:uten-referanse")).toBeUndefined();
    expect((await decisions()).map((d) => d.decision_id)).toEqual(["dec-h", "dec-v"]);
  });

  it("skjemavakt: den ENESTE fremmednøkkelen mot `situations` uten kaskade er beslutningsloggens (som oppryddingen utelater); en ny slik nøkkel må håndteres i `retireSignalSituations`", async () => {
    const { rows } = await db.adminPool.query(`SELECT conrelid::regclass::text AS child, conname, confdeltype FROM pg_constraint WHERE contype = 'f' AND confrelid = 'situations'::regclass ORDER BY 1, 2`);
    const nonCascading = (rows as Array<{ child: string; conname: string; confdeltype: string }>).filter((r) => r.confdeltype !== "c");
    expect(nonCascading).toEqual([{ child: "decision_log", conname: "decision_log_related_situation_scope_fk", confdeltype: "a" }]);
    // G4s egne barnetabeller kaskaderer (slettingen tar logg, vurderinger og tilbakemeldinger med)
    expect((rows as Array<{ child: string }>).map((r) => r.child)).toEqual(expect.arrayContaining(["situation_signal_log", "situation_assessments", "situation_feedback"]));
  });

  describe("en feilet opprydding er synlig, stopper ikke andre rom, og prøves igjen etter en time (ikke stille hvert døgn)", () => {
    const dropTrigger = async () => {
      await db.adminPool.query(`DROP TRIGGER IF EXISTS g4_block_home_delete_trg ON situations`);
      await db.adminPool.query(`DROP TRIGGER IF EXISTS g4_block_home_update_trg ON situations`);
      await db.adminPool.query(`DROP TRIGGER IF EXISTS g4_block_log_delete_trg ON situation_signal_log`);
      await db.adminPool.query(`DROP FUNCTION IF EXISTS g4_block_home_delete()`);
      await db.adminPool.query(`DROP FUNCTION IF EXISTS g4_block_log_delete()`);
    };
    // en uforutsett feil i DELETE for `home` (stand-in for en fremtidig FK): triggeren avviser sletting av rader i `home`
    const blockHomeDelete = async () => {
      await db.adminPool.query(`CREATE FUNCTION g4_block_home_delete() RETURNS trigger AS $$ BEGIN IF OLD.memory_space_id = 'home' THEN RAISE EXCEPTION 'g4 test: sletting blokkert'; END IF; IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await db.adminPool.query(`CREATE TRIGGER g4_block_home_delete_trg BEFORE DELETE ON situations FOR EACH ROW EXECUTE FUNCTION g4_block_home_delete()`);
    };
    // ... og (i tillegg) i UPDATE for `home`, så begge oppryddingsstegene feiler
    const blockHomeUpdate = async () => {
      await db.adminPool.query(`CREATE TRIGGER g4_block_home_update_trg BEFORE UPDATE ON situations FOR EACH ROW EXECUTE FUNCTION g4_block_home_delete()`);
    };
    const runner = (clock: () => number, over: Partial<SignalRunnerDeps> = {}) => new SituationSignalRunner({
      pool: db.appPool, bus: bus(), engine: db.engine, gateway, readers: {} as SignalSourceReaders, subscriptions: (t, s) => db.registry.listEnabled(t, s),
      targets: [{ tenant_id: TENANT_A, memory_space: "home" }, { tenant_id: TENANT_A, memory_space: "health" }], identityFor: (t, s) => identity(t, s), guard: { blocked: async () => null }, intervalMs: 60_000, now: clock, ...over
    } as SignalRunnerDeps);

    it("SQL-feil i sletting av `home`: tikket teller feilen (`retention_failures`, `errors`), loggen har kode og årsakskode uten innhold, `health` ryddes likevel, 48 t-løsingen i `home` lyktes, og nytt forsøk skjer først etter en time", async () => {
      await seed("home", "home:opening:gammel@a");
      await seed("home", "home:opening:tre-dager@a");
      await seed("health", "health:steps:low:2026-10-01", "health");
      await age("home:opening:gammel@a", "40 days");
      await age("home:opening:tre-dager@a", "3 days");
      await age("health:steps:low:2026-10-01", "40 days");
      await blockHomeDelete();
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      let clock = Date.now();
      try {
        const r = runner(() => clock);
        const first = await r.tick();
        expect(first.status).toBe("ok");
        expect(first.retention_failures).toBe(1);
        expect(first.errors).toEqual(["retention:signal_retention_failed:delete"]); // kort kode, aldri innhold
        const lines = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("situation_signal_retention_failed"));
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!)).toEqual({ msg: "situation_signal_retention_failed", tenant_id: TENANT_A, memory_space_id: "home", code: "signal_retention_failed:delete", cause: "pg_P0001" });
        expect(lines[0]).not.toMatch(/home:opening|binary_sensor|inngang|sletting blokkert/); // verken nøkler, entiteter eller databasens meldingstekst
        // en feil i `home` stopper ikke `health`, og løsingen i `home` lyktes selv om slettingen feilet (egne transaksjoner)
        expect(await row("health:steps:low:2026-10-01")).toBeUndefined();
        expect(await row("home:opening:tre-dager@a")).toMatchObject({ status: "resolved" });
        expect(await row("home:opening:gammel@a")).toMatchObject({ status: "resolved" });
        // neste tikk 30 minutter senere: ikke forsøkt på nytt ennå
        clock += 30 * 60_000;
        errors.mockClear();
        expect((await r.tick()).retention_failures).toBe(0);
        expect(errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("retention_failed"))).toEqual([]);
        // feilen rettes; 61 minutter etter feilen prøves oppryddingen igjen (og lykkes) - ikke først neste døgn
        await dropTrigger();
        expect(await row("home:opening:gammel@a")).toBeDefined();
        clock += 31 * 60_000;
        const third = await r.tick();
        expect(third.retention_failures).toBe(0);
        expect(third.errors).toEqual([]);
        expect(await row("home:opening:gammel@a")).toBeUndefined();
        // etter en VELLYKKET opprydding venter den et døgn igjen
        await seed("home", "home:opening:ny-gammel@a");
        await age("home:opening:ny-gammel@a", "40 days");
        clock += 2 * 3_600_000;
        await r.tick();
        expect(await row("home:opening:ny-gammel@a")).toBeDefined();
        clock += 24 * 3_600_000;
        await r.tick();
        expect(await row("home:opening:ny-gammel@a")).toBeUndefined();
      } finally {
        errors.mockRestore();
        await dropTrigger();
      }
    });

    it("`retireSignalSituations` forsøker ALLTID begge stegene: feiler slettingen, løses likevel de gamle åpne radene, og feilen kastes etterpå med hvilke steg som feilet og hva som lyktes (aldri en tom suksess)", async () => {
      await seed("home", "home:opening:gammel@a");
      await seed("home", "home:opening:tre-dager@a");
      await age("home:opening:gammel@a", "40 days");
      await age("home:opening:tre-dager@a", "3 days");
      await blockHomeDelete();
      try {
        const failure = await retireSignalSituations(db.appPool, TENANT_A, "home", { retentionDays: 30 }).then(() => null, (err: unknown) => err);
        expect(failure).toBeInstanceOf(SignalRetentionFailedError);
        expect(failure).toMatchObject({ message: "signal_retention_failed:delete", steps: ["delete"], deleted: 0, resolved: 2 });
        expect((failure as Error).cause).toMatchObject({ code: "P0001" });
        expect(await row("home:opening:gammel@a")).toMatchObject({ status: "resolved" });
        expect(await row("home:opening:tre-dager@a")).toMatchObject({ status: "resolved" });
      } finally {
        await dropTrigger();
      }
    });

    it("feiler BEGGE steg: meldingen og `steps` nevner begge (`delete.resolve`), ingenting lyktes, og feilen er den første årsaken", async () => {
      await seed("home", "home:opening:gammel@a");
      await seed("home", "home:opening:tre-dager@a");
      await age("home:opening:gammel@a", "40 days");
      await age("home:opening:tre-dager@a", "3 days");
      await blockHomeDelete();
      await blockHomeUpdate();
      try {
        const failure = await retireSignalSituations(db.appPool, TENANT_A, "home", { retentionDays: 30 }).then(() => null, (err: unknown) => err);
        expect(failure).toBeInstanceOf(SignalRetentionFailedError);
        expect(failure).toMatchObject({ message: "signal_retention_failed:delete.resolve", steps: ["delete", "resolve"], deleted: 0, resolved: 0 });
        expect(await row("home:opening:gammel@a")).toMatchObject({ status: "open" });
        expect(await row("home:opening:tre-dager@a")).toMatchObject({ status: "open" });
      } finally {
        await dropTrigger();
      }
    });

    it("SQL-feil i LOGGoppryddingen (`purge`): egen feilkode `purge:<kode>` og egen loggmelding uten innhold, og situasjonsoppryddingen kjører likevel (uavhengige steg)", async () => {
      const fresh = await seed("home", "home:opening:fersk@a");
      await seed("home", "home:opening:gammel@a");
      await age("home:opening:gammel@a", "40 days");
      await db.adminPool.query(
        `INSERT INTO situation_signal_log (signal_id, tenant_id, memory_space_id, source, event_type, domain, source_ref, detection_key, situation_id, occurred_at, outcome, stage_after, priority, notified, facts, person_id, recorded_at)
         VALUES ('sig-gammel', $1, 'home', 'home_assistant', 'door_open_too_long', 'home', 'home:opening:fersk@a#L1', 'home:opening:fersk@a', $2, now() - interval '40 days', 'created', 'inform', 'normal', true, '{}', $3, now() - interval '40 days')`,
        [TENANT_A, fresh, OWNER]
      );
      await db.adminPool.query(`CREATE FUNCTION g4_block_log_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'g4 test: loggsletting blokkert'; END; $$ LANGUAGE plpgsql`);
      await db.adminPool.query(`CREATE TRIGGER g4_block_log_delete_trg BEFORE DELETE ON situation_signal_log FOR EACH ROW EXECUTE FUNCTION g4_block_log_delete()`);
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const tick = await runner(() => Date.now()).tick();
        expect(tick).toMatchObject({ status: "ok", retention_failures: 1, errors: ["purge:pg_P0001"] });
        const lines = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("situation_signal_purge_failed"));
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!)).toEqual({ msg: "situation_signal_purge_failed", tenant_id: TENANT_A, memory_space_id: "home", code: "pg_P0001" });
        expect(lines[0]).not.toMatch(/home:opening|loggsletting blokkert/);
        expect(await row("home:opening:gammel@a")).toBeUndefined(); // situasjonsoppryddingen lyktes selv om loggoppryddingen feilet
        expect((await db.adminPool.query(`SELECT count(*)::int AS n FROM situation_signal_log WHERE signal_id = 'sig-gammel'`)).rows[0].n).toBe(1);
      } finally {
        errors.mockRestore();
        await dropTrigger();
      }
    });

    it("tilbakeføringsfristen etter en feilet opprydding er pinnet til én time", () => {
      expect(PURGE_RETRY_AFTER_FAILURE_MS).toBe(60 * 60_000);
    });
  });
});

describe("D-LOW-3 (delta-review B): retensjonsmålene dekker rom uten påslått kilde (kun opprydding - ingen lesing, ingen levering), og kill switch stanser dem", () => {
  async function seed(domain: string, key: string, space: "home" | "health" | "business", days: number): Promise<void> {
    await db.engine.evaluateCandidate(TENANT_A, space, { domain, detection_key: key, priority: "normal", reason: "r" }, NOW);
    await age(key, `${days} days`);
  }
  const all = [{ tenant_id: TENANT_A, memory_space: "home" as const }, { tenant_id: TENANT_A, memory_space: "health" as const }, { tenant_id: TENANT_A, memory_space: "business" as const }];
  const runner = (over: Partial<SignalRunnerDeps>) => new SituationSignalRunner({
    pool: db.appPool, bus: bus(), engine: db.engine, gateway, readers: {} as SignalSourceReaders, subscriptions: (t, s) => db.registry.listEnabled(t, s),
    targets: [], retentionTargets: all, identityFor: (t, s) => identity(t, s), guard: { blocked: async () => null }, intervalMs: 60_000, now: () => Date.now(), ...over
  } as SignalRunnerDeps);

  it("uten ett eneste mål og uten abonnement ryddes gamle signalsituasjoner (hjem, kamera, helse) i alle retensjonsrom; ingenting leses eller leveres", async () => {
    await seed("home", "home:opening:gammel@a", "home", 40);
    await seed("vision", "vision:motion_detected:cam:gammel", "home", 40);
    await seed("health", "health:steps:low:2026-10-01", "health", 40);
    await seed("home", "home:opening:fersk@a", "home", 1);
    const tick = await runner({}).tick();
    expect(tick).toMatchObject({ status: "ok", spaces: 0, sources_read: 0, delivered: 0, auto_act_attempted: 0, retention_failures: 0, errors: [] });
    expect(await row("home:opening:gammel@a")).toBeUndefined();
    expect(await row("vision:motion_detected:cam:gammel")).toBeUndefined();
    expect(await row("health:steps:low:2026-10-01")).toBeUndefined();
    expect(await row("home:opening:fersk@a")).toMatchObject({ status: "open" });
    expect(telegramCalls()).toBe(0);
  });

  it("uten `retentionTargets` ryddes ingenting for rom uten mål (løpere uten dem oppfører seg som før)", async () => {
    await seed("home", "home:opening:gammel@a", "home", 40);
    const tick = await runner({ retentionTargets: [] }).tick();
    expect(tick).toMatchObject({ status: "ok", spaces: 0, retention_failures: 0 });
    expect(await row("home:opening:gammel@a")).toBeDefined();
  });

  it("kill switch stanser oppryddingen: aktiv ved tikkstart -> `blocked` uten sletting; slått på MIDT i tikket (før første retensjonsmål) -> `blocked` uten sletting", async () => {
    await seed("home", "home:opening:gammel@a", "home", 40);
    const atStart = await runner({ guard: { blocked: async () => "kill_switch_active" } }).tick();
    expect(atStart).toMatchObject({ status: "blocked", reason: "kill_switch_active" });
    expect(await row("home:opening:gammel@a")).toBeDefined();
    let calls = 0;
    const midTick = await runner({ guard: { blocked: async () => (++calls > 1 ? "kill_switch_active" : null) } }).tick();
    expect(midTick).toMatchObject({ status: "blocked", reason: "kill_switch_active" });
    expect(await row("home:opening:gammel@a")).toBeDefined();
  });

  it("påslåtte mål og retensjonsmål overlapper uten problem: hvert rom ryddes (høyst) én gang per døgn", async () => {
    await seed("home", "home:opening:gammel@a", "home", 40);
    await seed("health", "health:steps:low:2026-10-01", "health", 40);
    let clock = Date.now();
    const r = runner({ targets: [all[0]!], now: () => clock });
    expect(await db.registry.listEnabled(TENANT_A, "home")).toHaveLength(0);
    expect((await r.tick()).retention_failures).toBe(0);
    expect(await row("home:opening:gammel@a")).toBeUndefined();
    expect(await row("health:steps:low:2026-10-01")).toBeUndefined();
    await seed("home", "home:opening:ny-gammel@a", "home", 40);
    clock += 60_000;
    await r.tick();
    expect(await row("home:opening:ny-gammel@a")).toBeDefined(); // døgnvakten gjelder også retensjonsmålene
  });
});

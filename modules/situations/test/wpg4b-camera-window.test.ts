import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { orderVisionAscending, SituationSignalBus } from "../src/signal-bus.ts";
import type { SignalObservation } from "../src/signal-bridges.ts";
import { EPISODE_ANCHOR_DIGITS, episodeKeyFor, resolveRuleThreshold, type BridgeContext, type RuleDefinition } from "../src/signal-types.ts";
import { bridgeVisionObservation, type VisionObservation } from "../src/vision-bridge.ts";
import { actorOwner, startG4Db, TENANT_A, TENANT_B, OWNER, type G4Db } from "./support/wpg4-db.ts";

/**
 * WP-G4b K3 (D-484, Q-75 pkt 10, JARVIS-115 b): GLIDENDE kameravindu per (kamera, hendelsestype). En ny hendelse mindre enn vinduet etter ANKERET til forrige episode (hendelsen som åpnet og dermed varslet episoden) er en duplikat;
 * akkurat på grensen (eller etter) starter en NY episode. Tidsstempel for siste varsel, ikke klokkebøtte; en undertrykt duplikat flytter aldri ankeret. Haste (`security_alert`) beholder den faste bøtten.
 *  A (rent): broen foreslår episoden (nøkkel med anker i fast bredde, vindu fra tunet cooldown), haste har ingen episode; `orderVisionAscending`; nøkkelformatet.
 *  B (ekte Postgres, injisert klokke): grensetilfellene deterministisk (N-1 ms, N, N+1 ms), glidende vs. fast bøtte, ikke-forlengelse, omstart, flere kameraer/typer/tenanter, haste uendret, eldre bøttenøkler, prefiks-kollisjon,
 *     rekkefølge innenfor en batch (nyeste først fra leseren) og at episoden holdt av stille timer ikke ødelegger ankeret.
 */
const MIN = 60_000;
const T0 = Date.parse("2026-11-19T10:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const ctx = (thresholds: Record<string, number> = {}): BridgeContext => ({ nowMs: T0 + 24 * 3_600_000, threshold: (rule: RuleDefinition) => thresholds[rule.rule_key] ?? resolveRuleThreshold(rule, null) });
const ev = (over: Partial<VisionObservation> = {}): VisionObservation => ({
  source: "vision", observation_id: "obs", event_type: "motion_detected", source_instance_id: "camera.inngang", source_event_id: "binary_sensor.b@2026-11-19T10:00:00.000Z",
  observed_at: iso(T0), object_label: null, classification_status: "not_applicable", ...over
});

describe("A: rent - broen foreslår episoden; haste har ingen", () => {
  it("episodenøkkelen har ankeret i FAST bredde (tekstsortering = tidssortering) og et kort suffiks er aldri et anker", () => {
    expect(EPISODE_ANCHOR_DIGITS).toBe(13);
    const a = episodeKeyFor("vision:motion_detected:cam:", T0);
    const b = episodeKeyFor("vision:motion_detected:cam:", T0 + 1);
    expect(a).toBe(`vision:motion_detected:cam:${T0}`);
    expect(a.length).toBe("vision:motion_detected:cam:".length + 13);
    expect(a < b).toBe(true);
    expect(episodeKeyFor("p:", 5)).toBe("p:0000000000005"); // pad: aldri kortere enn 13 siffer
    expect(episodeKeyFor("p:", -3)).toBe("p:0000000000000");
    // en gammel bøttenøkkel (7 siffer) har aldri 13 siffer
    expect("vision:motion_detected:cam:2950000".slice("vision:motion_detected:cam:".length)).not.toMatch(/^[0-9]{13}$/);
  });

  it("alle ikke-haste kamerareglene får et glidende vindu = cooldown (tunbar); anker = hendelsestidspunktet", () => {
    for (const [type, minutes] of [["motion_detected", 10], ["person_present", 10], ["doorbell_event", 2]] as const) {
      const r = bridgeVisionObservation(ev({ event_type: type }), {}, ctx());
      expect(r?.episode).toEqual({ key_prefix: `vision:${type}:camera.inngang:`, anchor_ms: T0, window_ms: minutes * MIN });
      expect(r?.candidate.detection_key).toBe(episodeKeyFor(`vision:${type}:camera.inngang:`, T0));
    }
    const pkg = bridgeVisionObservation(ev({ event_type: "object_detected", object_label: "Pakke", classification_status: "classified" }), {}, ctx());
    expect(pkg?.episode).toEqual({ key_prefix: "vision:package_detected:camera.inngang:", anchor_ms: T0, window_ms: 60 * MIN });
    expect(bridgeVisionObservation(ev(), {}, ctx({ "vision:motion_detected": 45 }))?.episode?.window_ms).toBe(45 * MIN);
  });

  it("HASTE (`security_alert`) beholder den faste bøtten uten episode: samme nøkkelformat som før K3; en åpning deler HA-nøkkelen og har ingen episode", () => {
    const alert = bridgeVisionObservation(ev({ event_type: "security_alert" }), {}, ctx());
    expect(alert?.urgent).toBe(true);
    expect(alert?.episode).toBeUndefined();
    expect(alert?.candidate.detection_key).toBe(`vision:security_alert:camera.inngang:${Math.floor(T0 / (10 * MIN))}`);
    const opening = bridgeVisionObservation(ev({ event_type: "opening_detected", source_event_id: "binary_sensor.dor@2026-11-19T09:59:00.000Z" }), {}, ctx());
    expect(opening?.episode).toBeUndefined();
    expect(opening?.candidate.detection_key).toBe("home:opening:binary_sensor.dor@2026-11-19T09:59:00.000Z");
  });

  it("`orderVisionAscending`: kun kamerahendelsene sorteres (stigende, stabilt, ugyldig tid sist); øvrige kilder beholder posisjonen", () => {
    const v = (id: string, at: string): VisionObservation => ev({ observation_id: id, observed_at: at });
    const door: SignalObservation = { source: "home_assistant", entity_id: "binary_sensor.d", role: "door", state: "on", last_changed: iso(T0) };
    const input: SignalObservation[] = [v("c", iso(T0 + 3 * MIN)), door, v("a", iso(T0)), v("x", "ikke-en-tid"), v("b", iso(T0 + MIN)), v("a2", iso(T0))];
    const out = orderVisionAscending(input);
    expect(out.map((o) => (o.source === "vision" ? o.observation_id : "HA"))).toEqual(["a", "HA", "a2", "b", "c", "x"]);
    expect(input.map((o) => (o.source === "vision" ? o.observation_id : "HA"))).toEqual(["c", "HA", "a", "x", "b", "a2"]); // inndata uendret
    // færre enn to kamerahendelser: samme liste
    const one: SignalObservation[] = [door, v("only", iso(T0))];
    expect(orderVisionAscending(one)).toBe(one);
    expect(orderVisionAscending([])).toEqual([]);
  });
});

describe("B: bussen mot ekte Postgres - glidende vindu med injisert klokke", () => {
  let db: G4Db;
  beforeAll(async () => { db = await startG4Db("wpg4b_camera_window"); }, 240_000);
  afterAll(async () => { await db?.stop(); }, 120_000);
  beforeEach(async () => { await db.reset(); });

  /** En NY bussinstans per kall = ingen minnetilstand mellom kallene (omstart). */
  const busAt = (nowMs: number): SituationSignalBus =>
    new SituationSignalBus({ pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses, subscriptions: (t, s) => db.registry.listEnabled(t, s), now: () => nowMs });
  const subscribe = (eventType = "motion_detected", tenant = TENANT_A) =>
    db.registry.subscribe(tenant, "home", { source: "vision", event_type: eventType, filter: {} }, actorOwner);
  const obs = (id: string, atMs: number, over: Partial<VisionObservation> = {}): VisionObservation =>
    ev({ observation_id: id, observed_at: iso(atMs), source_event_id: `binary_sensor.b@${iso(atMs)}`, ...over });
  /** Publiserer observasjonene i én batch med «nå» = like etter den siste. */
  const publish = async (observations: VisionObservation[], tenant = TENANT_A, nowMs?: number) =>
    busAt(nowMs ?? Math.max(...observations.map((o) => Date.parse(o.observed_at))) + 1_000).publishBatch(tenant, "home", observations);
  const keys = async (tenant = TENANT_A): Promise<string[]> =>
    (await db.adminPool.query(`SELECT detection_key FROM situations WHERE tenant_id = $1 AND domain = 'vision' ORDER BY detection_key`, [tenant])).rows.map((r: { detection_key: string }) => r.detection_key);
  const anchorOf = (key: string): number => Number(key.slice(key.lastIndexOf(":") + 1));

  it("kjerneforbedringen: to hendelser med sekunder imellom OVER en gammel bøttegrense er nå ÉN situasjon (før K3: to situasjoner og to varsler)", async () => {
    await subscribe();
    // bøttegrense for 10 min ligger på hele 10-minutt (10:10:00); hendelsene er 20 s fra hverandre, på hver sin side
    const before = T0 + 9 * MIN + 50_000;
    const after = T0 + 10 * MIN + 10_000;
    expect(Math.floor(before / (10 * MIN))).not.toBe(Math.floor(after / (10 * MIN)));
    const out = await publish([obs("a", before), obs("b", after)]);
    expect(out).toMatchObject({ evaluated: 2, created: 1, failed: 0 });
    expect(await keys()).toEqual([episodeKeyFor("vision:motion_detected:camera.inngang:", before)]);
  });

  it("grensetilfeller (cooldown 10 min, ankeret på T0): T0 + N - 1 ms og T0 + N - 1 s er duplikater; akkurat T0 + N og T0 + N + 1 ms starter en NY episode", async () => {
    await subscribe();
    const W = 10 * MIN;
    await publish([obs("anker", T0)]);
    for (const [id, delta] of [["n-1ms", W - 1], ["n-1s", W - 1_000], ["null", 0], ["midt", 5 * MIN]] as const) {
      const out = await publish([obs(id, T0 + delta)]);
      expect(out, id).toMatchObject({ evaluated: 1, created: 0 }); // duplikat: samme episode
    }
    expect(await keys()).toHaveLength(1);
    const exact = await publish([obs("n", T0 + W)]);
    expect(exact).toMatchObject({ evaluated: 1, created: 1 }); // akkurat N etter ankeret: ny episode (strengt `<` for duplikat)
    expect((await keys()).map(anchorOf)).toEqual([T0, T0 + W]);
    // den nye episoden har sitt eget vindu: N - 1 ms etter det nye ankeret er en duplikat, N + 1 ms etter det er en ny episode
    expect(await publish([obs("n2-1ms", T0 + 2 * W - 1)])).toMatchObject({ evaluated: 1, created: 0 });
    expect(await publish([obs("n2+1ms", T0 + 2 * W + 1)])).toMatchObject({ evaluated: 1, created: 1 });
    expect((await keys()).map(anchorOf)).toEqual([T0, T0 + W, T0 + 2 * W + 1]);
  });

  it("IKKE-FORLENGELSE (tidsstempel for siste varsel, ikke siste hendelse): hendelser hvert 4. minutt holder ikke vinduet åpent - episode 2 starter 12 min etter ankeret selv om forrige hendelse var 4 min før", async () => {
    await subscribe();
    // ankere: T0 (e0); e1 (4) og e2 (8) er duplikater; e3 (12) er >= 10 min etter ankeret -> NY episode (en debounce som forlenger med hver hendelse ville ha slukt den);
    // e4 (16) og e5 (20) er < 10 min etter det nye ankeret (12); e6 (22) er akkurat 10 min etter det -> tredje episode.
    const out = await publish([obs("e0", T0), obs("e1", T0 + 4 * MIN), obs("e2", T0 + 8 * MIN), obs("e3", T0 + 12 * MIN), obs("e4", T0 + 16 * MIN), obs("e5", T0 + 20 * MIN), obs("e6", T0 + 22 * MIN)]);
    expect(out).toMatchObject({ evaluated: 7, created: 3 });
    expect((await keys()).map(anchorOf)).toEqual([T0, T0 + 12 * MIN, T0 + 22 * MIN]);
  });

  it("omstart midt i en episode: en NY bussinstans uten minnetilstand fortsetter samme episode (ankeret ligger i situasjonens nøkkel), og vinduet utløper likt", async () => {
    await subscribe();
    await publish([obs("a", T0)]);
    const afterRestart = await busAt(T0 + 6 * MIN).publishBatch(TENANT_A, "home", [obs("b", T0 + 5 * MIN)]);
    expect(afterRestart).toMatchObject({ evaluated: 1, created: 0 });
    const later = await busAt(T0 + 11 * MIN).publishBatch(TENANT_A, "home", [obs("c", T0 + 10 * MIN + 1)]);
    expect(later).toMatchObject({ evaluated: 1, created: 1 });
    expect((await keys()).map(anchorOf)).toEqual([T0, T0 + 10 * MIN + 1]);
  });

  it("per (kamera, hendelsestype): to kameraer og to typer samtidig er fire uavhengige episoder; hver har sitt eget vindu", async () => {
    await subscribe("motion_detected");
    await subscribe("person_present");
    const at = T0;
    const out = await publish([
      obs("m1", at, { source_instance_id: "camera.inngang" }), obs("m2", at, { source_instance_id: "camera.hage" }),
      obs("p1", at, { source_instance_id: "camera.inngang", event_type: "person_present" }), obs("p2", at, { source_instance_id: "camera.hage", event_type: "person_present" }),
      // innenfor vinduet for hver av dem: duplikater
      obs("m1b", at + MIN, { source_instance_id: "camera.inngang" }), obs("p2b", at + MIN, { source_instance_id: "camera.hage", event_type: "person_present" })
    ]);
    expect(out).toMatchObject({ evaluated: 6, created: 4 });
    expect(await keys()).toHaveLength(4);
  });

  it("tenant-isolasjon: en annen tenants episode er aldri et anker (RLS); hver tenant har sin egen episode for samme kamera og tid", async () => {
    await subscribe("motion_detected", TENANT_A);
    await db.registry.subscribe(TENANT_B, "home", { source: "vision", event_type: "motion_detected", filter: {} }, { person_id: OWNER, session_id: "s-b" });
    await publish([obs("a", T0)], TENANT_A);
    const b = await publish([obs("b", T0 + MIN)], TENANT_B);
    expect(b).toMatchObject({ evaluated: 1, created: 1 }); // B har ingen episode å slå seg på, selv om A har en 1 min tidligere
    expect(await keys(TENANT_A)).toHaveLength(1);
    expect(await keys(TENANT_B)).toHaveLength(1);
  });

  it("HASTE: `security_alert` beholder den faste bøtten - to varsler over en bøttegrense gir fortsatt to situasjoner (K3 skjuler aldri et andre sikkerhetsvarsel), og i samme bøtte én", async () => {
    await subscribe("security_alert");
    const boundary = Math.ceil(T0 / (10 * MIN)) * (10 * MIN); // en 10-minuttsgrense
    const out = await publish([obs("s1", boundary - 20_000, { event_type: "security_alert" }), obs("s2", boundary + 20_000, { event_type: "security_alert" }), obs("s3", boundary + 40_000, { event_type: "security_alert" })]);
    expect(out).toMatchObject({ evaluated: 3, created: 2 });
    expect((await keys()).sort()).toEqual([
      `vision:security_alert:camera.inngang:${boundary / (10 * MIN) - 1}`, `vision:security_alert:camera.inngang:${boundary / (10 * MIN)}`
    ]);
  });

  it("eldre bøttenøkler (kort suffiks) tolkes aldri som anker; en annen kamera-id med samme prefiks (`cam` vs `cam:x`) forstyrrer ikke", async () => {
    await subscribe();
    const legacy = `vision:motion_detected:camera.inngang:${Math.floor(T0 / (10 * MIN))}`;
    const collide = episodeKeyFor("vision:motion_detected:camera.inngang:x:", T0 + MIN); // `camera.inngang:x` er en annen kilde
    // en nøkkel med FEIL bredde på suffikset (12 siffer) som likevel sorterer INNENFOR tidsområdet: kun regulært uttrykk (13 siffer) holder den unna
    const shortAnchor = `vision:motion_detected:camera.inngang:${String(T0 + MIN).slice(0, 12)}`;
    expect(shortAnchor > episodeKeyFor("vision:motion_detected:camera.inngang:", T0 - 8 * MIN) && shortAnchor < episodeKeyFor("vision:motion_detected:camera.inngang:", T0 + 2 * MIN)).toBe(true);
    for (const key of [legacy, collide, shortAnchor]) {
      await db.engine.evaluateCandidate(TENANT_A, "home", { domain: "vision", detection_key: key, priority: "normal", reason: "Bevegelse registrert" }, T0);
    }
    const out = await publish([obs("a", T0 + 2 * MIN)]);
    expect(out).toMatchObject({ evaluated: 1, created: 1 }); // ny episode: ingen av de tre er et anker for `camera.inngang`
    const all = await keys();
    expect(all).toContain(episodeKeyFor("vision:motion_detected:camera.inngang:", T0 + 2 * MIN));
    for (const key of [legacy, collide, shortAnchor]) expect(all).toContain(key);
  });

  it("rekkefølge: leseren leverer NYESTE først, men bussen behandler eldste først - ankeret er den eldste hendelsen, og alt innenfor vinduet er én episode", async () => {
    await subscribe();
    const newestFirst = [obs("c", T0 + 8 * MIN), obs("b", T0 + 4 * MIN), obs("a", T0)];
    const out = await publish(newestFirst);
    expect(out).toMatchObject({ evaluated: 3, created: 1 });
    expect((await keys()).map(anchorOf)).toEqual([T0]);
  });

  it("en episode som holdes av stille timer (ikke varslet, ikke logget) er fortsatt et anker, og hendelser innenfor vinduet slås sammen i den", async () => {
    await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "motion_detected", filter: { night_hours_utc: { start: 22, end: 6 } } }, actorOwner);
    await db.engine.setNotificationPolicy(TENANT_A, "home", { quiet_hours_start_utc: 22, quiet_hours_end_utc: 6, actor_person_id: OWNER });
    const night = Date.parse("2026-11-19T23:00:00.000Z");
    const first = await publish([obs("n1", night)], TENANT_A, night + 1_000);
    const second = await publish([obs("n2", night + 3 * MIN)], TENANT_A, night + 3 * MIN + 1_000);
    expect(first).toMatchObject({ evaluated: 1, created: 1, held: 1 });
    expect(second).toMatchObject({ evaluated: 1, created: 0, held: 1 });
    expect(await keys()).toHaveLength(1);
    // holdte signaler logges ikke (B-HIGH-1): de re-evalueres neste tikk, og da finner de samme episode
    expect(Number((await db.adminPool.query(`SELECT count(*)::int AS n FROM situation_signal_log WHERE tenant_id = $1`, [TENANT_A])).rows[0].n)).toBe(0);
    expect(await publish([obs("n1", night), obs("n2", night + 3 * MIN)], TENANT_A, night + 4 * MIN)).toMatchObject({ evaluated: 2, created: 0, held: 2 });
    expect(await keys()).toHaveLength(1);
  });

  it("idempotens: å lese de samme observasjonene på nytt (neste tikk) gir ingen nye episoder og ingen nye loggrader; en duplikat bumper episodens situasjon", async () => {
    await subscribe();
    const batch = [obs("a", T0), obs("b", T0 + 3 * MIN), obs("c", T0 + 12 * MIN)];
    await publish(batch);
    const again = await publish(batch);
    expect(again.ignored.duplicate + again.evaluated).toBe(3);
    expect(again.created).toBe(0);
    expect((await keys()).map(anchorOf)).toEqual([T0, T0 + 12 * MIN]);
    const logged = Number((await db.adminPool.query(`SELECT count(*)::int AS n FROM situation_signal_log WHERE tenant_id = $1`, [TENANT_A])).rows[0].n);
    expect(logged).toBe(3);
  });
});

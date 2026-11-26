import { describe, expect, it } from "vitest";
import {
  CAR_CRITICAL_OPS, HA_CLOCK_SKEW_MS, HA_MEASURED_SKEW_LIMIT_MS, HOME_CRITICAL_OPS, RECONCILE_FAILED_MIN_AGE_MS, decideReconcile, normalizeHomeCriticalState,
  type Params, type PersonalActionIndexEntry, type ReconcileEvidence
} from "../src/index.ts";

/**
 * WP-G2c (D-483, JARVIS-113 b): avgjørelsesfunksjonen for avstemming av `outcome_unknown` er RENT (ingen I/O) og testes uttømmende her. Reglene fra byggeordren:
 *  - `applied` KUN når den ønskede sluttilstanden er bevist (handlingens egen `op.post` på en brukbar, ferdig-settlet, fersk lesing) og ingen nyere handling kan ha forårsaket den;
 *  - `failed` KUN når det er bevist at handlingen ikke skjedde (HAs `last_changed` eldre enn forespørselen minus klokkeskjevhet, eller uendret markør for scene/skript) og fristen er passert; bil kan aldri bli `failed`;
 *  - ellers `unknown` med en kort, stabil begrunnelseskode.
 */
const home = (action: string): PersonalActionIndexEntry => ({ domain: "home", toolId: "home-assistant", op: HOME_CRITICAL_OPS.find((o) => o.action === action)! });
const car = (action: string): PersonalActionIndexEntry => ({ domain: "car", toolId: "car", op: CAR_CRITICAL_OPS.find((o) => o.action === action)! });

const T0 = Date.parse("2026-11-25T10:00:00.000Z"); // forespørselen
const iso = (ms: number): string => new Date(ms).toISOString();
const AFTER_GRACE = T0 + 30_000 + RECONCILE_FAILED_MIN_AGE_MS; // konkludert 30 s etter forespørselen + 5 min

const evidence = (entry: PersonalActionIndexEntry, params: Params, observed: Params, extra: Partial<ReconcileEvidence> = {}): ReconcileEvidence => ({
  entry, params, observed, nowMs: AFTER_GRACE + 60_000, laterAction: false,
  row: { requested_at: iso(T0), completed_at: iso(T0 + 30_000), before_state: { state: "unlocked" } }, ...extra
});

/** En normalisert HA-tilstand (samme normalisering som den ekte lesingen) med `last_changed` en time før forespørselen. */
const ha = (entityId: string, state: string, extra: { last_changed?: string | null; attributes?: Record<string, unknown> } = {}): Params =>
  normalizeHomeCriticalState({ entity_id: entityId, state, attributes: extra.attributes, last_changed: extra.last_changed === undefined ? iso(T0 - 3_600_000) : extra.last_changed });

describe("A: applied - kun når den ønskede sluttilstanden er bevist", () => {
  const cases: Array<[string, Params, Params]> = [
    ["critical_lock", { entity: "lock.front_door", locked: true }, ha("lock.front_door", "locked")],
    ["critical_lock", { entity: "lock.front_door", locked: false }, ha("lock.front_door", "unlocked")],
    ["critical_alarm", { entity: "alarm_control_panel.home", armed: true, mode: "home" }, ha("alarm_control_panel.home", "armed_home")],
    ["critical_alarm", { entity: "alarm_control_panel.home", armed: false }, ha("alarm_control_panel.home", "disarmed")],
    ["critical_cover", { entity: "cover.garage", target: "closed" }, ha("cover.garage", "closed")],
    ["critical_valve", { entity: "valve.main", target: "open" }, ha("valve.main", "open")],
    ["critical_switch", { entity: "switch.heater", on: true }, ha("switch.heater", "on")],
    ["critical_climate_mode", { entity: "climate.living", hvac_mode: "heat" }, ha("climate.living", "heat", { attributes: { hvac_modes: ["off", "heat"] } })]
  ];
  for (const [action, params, observed] of cases) {
    it(`${action} ${JSON.stringify(params)}: observert ${String(observed["state"])} -> applied (postcondition_observed)`, () => {
      expect(decideReconcile(evidence(home(action), params, observed))).toEqual({ resolution: "applied", basis: "postcondition_observed" });
    });
  }

  it("applied krever IKKE at fristen er passert (en bevist sluttilstand trenger ikke ventetid), og endringstidspunktet spiller ingen rolle (utstyret kan ha endret seg ETTER forespørselen - det er nettopp beviset)", () => {
    const observed = ha("lock.front_door", "locked", { last_changed: iso(T0 + 5_000) });
    expect(decideReconcile(evidence(home("critical_lock"), { entity: "lock.front_door", locked: true }, observed, { nowMs: T0 + 1_000 }))).toMatchObject({ resolution: "applied" });
  });

  it("scene/skript: markøren har rykket frem -> applied (marker_advanced); også når skriptet fortsatt kjører (startet er bevist)", () => {
    const scene = normalizeHomeCriticalState({ entity_id: "scene.evening", state: iso(T0 + 2_000), last_changed: iso(T0 + 2_000) });
    expect(decideReconcile(evidence(home("critical_scene"), { entity: "scene.evening", expected_last_activated: iso(T0 - 86_400_000) }, scene))).toEqual({ resolution: "applied", basis: "marker_advanced" });
    const never = normalizeHomeCriticalState({ entity_id: "scene.evening", state: iso(T0 + 2_000) });
    expect(decideReconcile(evidence(home("critical_scene"), { entity: "scene.evening", expected_last_activated: null }, never))).toEqual({ resolution: "applied", basis: "marker_advanced" });
    const running = normalizeHomeCriticalState({ entity_id: "script.night", state: "on", attributes: { last_triggered: iso(T0 + 3_000) } });
    expect(running["running"]).toBe(true);
    expect(decideReconcile(evidence(home("critical_script"), { entity: "script.night", expected_last_triggered: iso(T0 - 1_000) }, running))).toEqual({ resolution: "applied", basis: "marker_advanced" });
  });

  it("en NYERE handling mot samme mål kan ha forårsaket tilstanden: den kan ikke tilskrives denne raden (later_action_on_target) - også for markører og bil", () => {
    expect(decideReconcile(evidence(home("critical_lock"), { entity: "lock.front_door", locked: true }, ha("lock.front_door", "locked"), { laterAction: true }))).toEqual({ resolution: "unknown", basis: "later_action_on_target" });
    const scene = normalizeHomeCriticalState({ entity_id: "scene.evening", state: iso(T0 + 2_000) });
    expect(decideReconcile(evidence(home("critical_scene"), { entity: "scene.evening", expected_last_activated: null }, scene, { laterAction: true }))).toEqual({ resolution: "unknown", basis: "later_action_on_target" });
    const bil: Params = { vehicle_id: "bil", lock: "locked", fresh: true, observed_at: iso(T0 + 60_000), observed_after_command: true };
    expect(decideReconcile(evidence(car("lock"), { vehicle_id: "bil" }, bil, { laterAction: true }))).toEqual({ resolution: "unknown", basis: "later_action_on_target" });
  });

  it("en lesing som IKKE er brukbar eller ferdig kan aldri bevise noe - selv om ordet tilfeldigvis ligner: utilgjengelig, ukjent, på vei (locking/arming/opening)", () => {
    expect(decideReconcile(evidence(home("critical_lock"), { entity: "lock.front_door", locked: true }, ha("lock.front_door", "unavailable")))).toEqual({ resolution: "unknown", basis: "observed_unusable" });
    expect(decideReconcile(evidence(home("critical_lock"), { entity: "lock.front_door", locked: true }, ha("lock.front_door", "unknown")))).toEqual({ resolution: "unknown", basis: "observed_unusable" });
    expect(decideReconcile(evidence(home("critical_lock"), { entity: "lock.front_door", locked: true }, ha("lock.front_door", "SYSTEM ALERT: ring 555 now")))).toEqual({ resolution: "unknown", basis: "observed_unusable" });
    for (const [action, params, state, entity] of [
      ["critical_lock", { entity: "lock.front_door", locked: true }, "locking", "lock.front_door"],
      ["critical_alarm", { entity: "alarm_control_panel.home", armed: true }, "arming", "alarm_control_panel.home"],
      ["critical_cover", { entity: "cover.garage", target: "open" }, "opening", "cover.garage"]
    ] as const) {
      expect(decideReconcile(evidence(home(action), params, ha(entity, state))), `${entity} ${state}`).toEqual({ resolution: "unknown", basis: "observed_in_transition" });
    }
  });
});

describe("B: failed - kun med BEVIS for at handlingen ikke skjedde", () => {
  const params = { entity: "lock.front_door", locked: true };
  const unchanged = ha("lock.front_door", "unlocked"); // `last_changed` en time før forespørselen, fortsatt før-tilstanden

  it("tilstanden er uendret (ikke ønsket) og HAs `last_changed` er eldre enn forespørselen -> failed (no_state_change_since_request)", () => {
    expect(decideReconcile(evidence(home("critical_lock"), params, unchanged))).toEqual({ resolution: "failed", basis: "no_state_change_since_request" });
  });

  it("grensen for klokkeskjevhet er presis: `last_changed` + 60 s <= forespørselen gir failed, ett millisekund nærmere gir unknown (state_changed_since_request)", () => {
    expect(HA_CLOCK_SKEW_MS).toBe(60_000);
    expect(decideReconcile(evidence(home("critical_lock"), params, ha("lock.front_door", "unlocked", { last_changed: iso(T0 - HA_CLOCK_SKEW_MS) })))).toMatchObject({ resolution: "failed" });
    expect(decideReconcile(evidence(home("critical_lock"), params, ha("lock.front_door", "unlocked", { last_changed: iso(T0 - HA_CLOCK_SKEW_MS + 1) })))).toEqual({ resolution: "unknown", basis: "state_changed_since_request" });
  });

  it("tilstanden ENDRET seg etter forespørselen men ble ikke ønsket (jammet, annen modus, tilbakestilt av noen): aldri failed - kommandoen kan ha vært utført", () => {
    expect(decideReconcile(evidence(home("critical_lock"), params, ha("lock.front_door", "jammed", { last_changed: iso(T0 + 4_000) })))).toEqual({ resolution: "unknown", basis: "state_changed_since_request" });
    expect(decideReconcile(evidence(home("critical_lock"), params, ha("lock.front_door", "unlocked", { last_changed: iso(T0 + 90_000) })))).toEqual({ resolution: "unknown", basis: "state_changed_since_request" });
  });

  it("uten endringstidspunkt fra utstyret finnes ingen bevisbar `failed` (change_time_unavailable); et ugyldig/tekstlig tidsstempel regnes som manglende", () => {
    expect(decideReconcile(evidence(home("critical_lock"), params, ha("lock.front_door", "unlocked", { last_changed: null })))).toEqual({ resolution: "unknown", basis: "change_time_unavailable" });
    expect(decideReconcile(evidence(home("critical_lock"), params, ha("lock.front_door", "unlocked", { last_changed: "i går kveld" })))).toEqual({ resolution: "unknown", basis: "change_time_unavailable" });
  });

  it("tilstanden stemmer ikke med før-tilstanden som ble lagret (selv om `last_changed` er gammel): selvmotsigende bevis -> unknown (before_state_differs)", () => {
    const row = { requested_at: iso(T0), completed_at: iso(T0 + 30_000), before_state: { state: "locked" } };
    expect(decideReconcile(evidence(home("critical_lock"), params, unchanged, { row }))).toEqual({ resolution: "unknown", basis: "before_state_differs" });
  });

  it("fiks-runde 1 (LOW-1): MANGLENDE før-tilstand er ikke et bevis - `failed` krever en lagret før-tilstand med et tilstandsord (null, tomt objekt, feil type, ikke-objekt -> before_state_missing)", () => {
    const row = { requested_at: iso(T0), completed_at: iso(T0 + 30_000) };
    for (const before_state of [null, {}, { state: 5 }, { state: null }, { state: ["unlocked"] }, "unlocked", ["unlocked"], 7] as unknown[]) {
      expect(decideReconcile(evidence(home("critical_lock"), params, unchanged, { row: { ...row, before_state } as never })), JSON.stringify(before_state)).toEqual({ resolution: "unknown", basis: "before_state_missing" });
    }
    // og en lagret før-tilstand som stemmer gir som før failed
    expect(decideReconcile(evidence(home("critical_lock"), params, unchanged, { row: { ...row, before_state: { state: "unlocked", settled: true } } }))).toEqual({ resolution: "failed", basis: "no_state_change_since_request" });
  });

  it("fristen: failed først 5 min etter at eksekutoren konkluderte (en sen forespørsel skal ha rukket å dø); `completed_at` mangler -> fristen regnes fra forespørselen", () => {
    expect(RECONCILE_FAILED_MIN_AGE_MS).toBe(300_000);
    const concluded = T0 + 30_000;
    expect(decideReconcile(evidence(home("critical_lock"), params, unchanged, { nowMs: concluded + RECONCILE_FAILED_MIN_AGE_MS }))).toMatchObject({ resolution: "failed" });
    expect(decideReconcile(evidence(home("critical_lock"), params, unchanged, { nowMs: concluded + RECONCILE_FAILED_MIN_AGE_MS - 1 }))).toEqual({ resolution: "unknown", basis: "too_recent_for_failed_proof" });
    const noCompleted = { requested_at: iso(T0), completed_at: null, before_state: { state: "unlocked" } };
    expect(decideReconcile(evidence(home("critical_lock"), params, unchanged, { row: noCompleted, nowMs: T0 + RECONCILE_FAILED_MIN_AGE_MS }))).toMatchObject({ resolution: "failed" });
    expect(decideReconcile(evidence(home("critical_lock"), params, unchanged, { row: noCompleted, nowMs: T0 + RECONCILE_FAILED_MIN_AGE_MS - 1 }))).toMatchObject({ resolution: "unknown" });
  });

  it("en lesing som ikke er brukbar eller ferdig gir aldri failed (utilgjengelig/på vei er ikke et bevis for noe)", () => {
    expect(decideReconcile(evidence(home("critical_lock"), params, ha("lock.front_door", "unavailable")))).toMatchObject({ resolution: "unknown" });
    expect(decideReconcile(evidence(home("critical_lock"), params, ha("lock.front_door", "unlocking")))).toMatchObject({ resolution: "unknown" });
  });

  it("scene: markøren er UENDRET siden forhåndsvisningen (også `null` = aldri aktivert) -> failed (marker_unchanged_since_preflight); en markør som er eldre enn forventet, mangler eller en uleselig forventning -> unknown", () => {
    const expected = iso(T0 - 86_400_000);
    const same = normalizeHomeCriticalState({ entity_id: "scene.evening", state: expected });
    expect(decideReconcile(evidence(home("critical_scene"), { entity: "scene.evening", expected_last_activated: expected }, same))).toEqual({ resolution: "failed", basis: "marker_unchanged_since_preflight" });
    const never = normalizeHomeCriticalState({ entity_id: "scene.evening", state: "unknown" });
    expect(never["last_activated"]).toBeNull();
    expect(decideReconcile(evidence(home("critical_scene"), { entity: "scene.evening", expected_last_activated: null }, never))).toEqual({ resolution: "failed", basis: "marker_unchanged_since_preflight" });
    const older = normalizeHomeCriticalState({ entity_id: "scene.evening", state: iso(T0 - 2 * 86_400_000) });
    expect(decideReconcile(evidence(home("critical_scene"), { entity: "scene.evening", expected_last_activated: expected }, older))).toEqual({ resolution: "unknown", basis: "marker_state_unclear" });
    expect(decideReconcile(evidence(home("critical_scene"), { entity: "scene.evening", expected_last_activated: expected }, never))).toEqual({ resolution: "unknown", basis: "marker_state_unclear" });
    expect(decideReconcile(evidence(home("critical_scene"), { entity: "scene.evening", expected_last_activated: "ikke en dato" }, never))).toEqual({ resolution: "unknown", basis: "marker_param_unparseable" });
    expect(decideReconcile(evidence(home("critical_scene"), { entity: "scene.evening", expected_last_activated: expected }, same, { nowMs: T0 + 30_000 + RECONCILE_FAILED_MIN_AGE_MS - 1 }))).toEqual({ resolution: "unknown", basis: "too_recent_for_failed_proof" });
  });

  it("skript: uendret markør og ikke kjørende -> failed; et skript som KJØRER uten at markøren har rykket frem kan ikke avgjøres (script_running)", () => {
    const expected = iso(T0 - 3_600_000);
    const idle = normalizeHomeCriticalState({ entity_id: "script.night", state: "off", attributes: { last_triggered: expected } });
    expect(decideReconcile(evidence(home("critical_script"), { entity: "script.night", expected_last_triggered: expected }, idle))).toEqual({ resolution: "failed", basis: "marker_unchanged_since_preflight" });
    const running = normalizeHomeCriticalState({ entity_id: "script.night", state: "on", attributes: { last_triggered: expected } });
    expect(decideReconcile(evidence(home("critical_script"), { entity: "script.night", expected_last_triggered: expected }, running))).toEqual({ resolution: "unknown", basis: "script_running" });
  });
});

describe("B2: failed er ALDRI sikkert når målet har en nyere handling eller klokkene er målt til å avvike (fiks-runde 1, LOW-1)", () => {
  const params = { entity: "lock.front_door", locked: true };
  const before = { state: "unlocked" };
  const MIN = 60_000;
  /** Scenarioet fra reviewen: kommandoen KJØRTE (HA: unlocked -> locked), og 90 s senere låste en tredjepart/Jarvis opp igjen. Etter avstemmingens lesing står låsen `unlocked` (= før-tilstanden), og HAs `last_changed` er tidspunktet for OPPLÅSINGEN på HAs egen klokke. */
  const reverted = (haOffsetMs: number, extra: Params = {}): Params => ({ ...ha("lock.front_door", "unlocked", { last_changed: iso(T0 + 90_000 + haOffsetMs) }), ...extra });

  it("en nyere handling mot samme mål (Jarvis selv kan ha reversert kommandoen) gir aldri failed: later_action_on_target - for tilstandshandlinger, scene og skript", () => {
    expect(decideReconcile(evidence(home("critical_lock"), params, ha("lock.front_door", "unlocked"), { laterAction: true }))).toEqual({ resolution: "unknown", basis: "later_action_on_target" });
    expect(decideReconcile(evidence(home("critical_lock"), params, ha("lock.front_door", "unlocked"), { laterAction: false }))).toEqual({ resolution: "failed", basis: "no_state_change_since_request" });
    const expected = iso(T0 - 86_400_000);
    const sceneSame = normalizeHomeCriticalState({ entity_id: "scene.evening", state: expected });
    expect(decideReconcile(evidence(home("critical_scene"), { entity: "scene.evening", expected_last_activated: expected }, sceneSame, { laterAction: true }))).toEqual({ resolution: "unknown", basis: "later_action_on_target" });
    const idle = normalizeHomeCriticalState({ entity_id: "script.night", state: "off", attributes: { last_triggered: expected } });
    expect(decideReconcile(evidence(home("critical_script"), { entity: "script.night", expected_last_triggered: expected }, idle, { laterAction: true }))).toEqual({ resolution: "unknown", basis: "later_action_on_target" });
    expect(decideReconcile(evidence(home("critical_script"), { entity: "script.night", expected_last_triggered: expected }, idle, { laterAction: false }))).toEqual({ resolution: "failed", basis: "marker_unchanged_since_preflight" });
  });

  it("HA-klokken går BAK Jarvis: 30/59/61 s bak gir unknown (last_changed + 60 s er etter forespørselen), men 5 min bak gir FALSK failed uten en måling - terskelen er 60 s pluss reverteringsforsinkelsen (150 s her)", () => {
    for (const behindMs of [0, 30_000, 59_000, 61_000, 149_000]) {
      expect(decideReconcile(evidence(home("critical_lock"), params, reverted(-behindMs), { row: { requested_at: iso(T0), completed_at: iso(T0 + 30_000), before_state: before } })), `${behindMs} ms bak`).toMatchObject({ resolution: "unknown" });
    }
    // uten en målt skjevhet (Date mangler) er oppførselen som før: dokumentert begrensning (runbook, kjente begrensninger)
    expect(decideReconcile(evidence(home("critical_lock"), params, reverted(-5 * MIN)))).toEqual({ resolution: "failed", basis: "no_state_change_since_request" });
    // HA FREM i tid er aldri farlig (last_changed er alltid for ny, ikke for gammel)
    expect(decideReconcile(evidence(home("critical_lock"), params, reverted(5 * MIN)))).toMatchObject({ resolution: "unknown" });
  });

  it("en MÅLT skjevhet over grensen (HTTP-`Date` i HA-svaret) fjerner klokkebeviset: samme scenario med HA 5 min bak (-300 s) gir unknown (ha_clock_skew) - i begge retninger, grensen er presis", () => {
    expect(HA_MEASURED_SKEW_LIMIT_MS).toBe(30_000);
    expect(HA_MEASURED_SKEW_LIMIT_MS).toBeLessThan(HA_CLOCK_SKEW_MS); // marginen: målingen er nøyaktig til ca. ett sekund, og toleransen i beviset er 60 s
    expect(decideReconcile(evidence(home("critical_lock"), params, reverted(-5 * MIN, { clock_skew_ms: -5 * MIN })))).toEqual({ resolution: "unknown", basis: "ha_clock_skew" });
    expect(decideReconcile(evidence(home("critical_lock"), params, ha("lock.front_door", "unlocked", { last_changed: iso(T0 - 3_600_000) }), { row: { requested_at: iso(T0), completed_at: iso(T0 + 30_000), before_state: before } })).resolution).toBe("failed");
    const stale = ha("lock.front_door", "unlocked", { last_changed: iso(T0 - 3_600_000) });
    for (const [skew, want] of [[0, "failed"], [-1_200, "failed"], [HA_MEASURED_SKEW_LIMIT_MS, "failed"], [-HA_MEASURED_SKEW_LIMIT_MS, "failed"], [HA_MEASURED_SKEW_LIMIT_MS + 1, "unknown"], [-HA_MEASURED_SKEW_LIMIT_MS - 1, "unknown"], [10 * MIN, "unknown"]] as const) {
      expect(decideReconcile(evidence(home("critical_lock"), params, { ...stale, clock_skew_ms: skew })).resolution, `skjevhet ${skew} ms`).toBe(want);
    }
    // en måling som mangler (null/utelatt) oppfører seg som før; en måling som er til stede men uleselig er fail-closed
    for (const missing of [null, undefined]) expect(decideReconcile(evidence(home("critical_lock"), params, { ...stale, clock_skew_ms: missing as never })).resolution).toBe("failed");
    for (const garbage of ["0", Number.NaN, Number.POSITIVE_INFINITY, {}, true, [0]] as unknown[]) {
      expect(decideReconcile(evidence(home("critical_lock"), params, { ...stale, clock_skew_ms: garbage as never })), String(garbage)).toEqual({ resolution: "unknown", basis: "ha_clock_skew" });
    }
  });

  it("målt skjevhet påvirker ikke applied (beviset er tilstanden selv, ikke en klokke) og ikke scene/skript-markørene (ingen klokkeavhengighet)", () => {
    expect(decideReconcile(evidence(home("critical_lock"), params, { ...ha("lock.front_door", "locked"), clock_skew_ms: -10 * MIN }))).toEqual({ resolution: "applied", basis: "postcondition_observed" });
    const expected = iso(T0 - 86_400_000);
    const sceneSame = { ...normalizeHomeCriticalState({ entity_id: "scene.evening", state: expected }), clock_skew_ms: -10 * MIN };
    expect(decideReconcile(evidence(home("critical_scene"), { entity: "scene.evening", expected_last_activated: expected }, sceneSame))).toEqual({ resolution: "failed", basis: "marker_unchanged_since_preflight" });
  });
});

describe("C: bil - applied er mulig, failed er IKKE mulig (adapter-kontrakten har ikke noe endringstidspunkt)", () => {
  const params = { vehicle_id: "bil" };
  const fresh = (extra: Params = {}): Params => ({ vehicle_id: "bil", reachable: true, lock: "locked", climate: "off", charging: "stopped", fresh: true, observed_at: iso(T0 + 120_000), observed_after_command: true, ...extra });

  it("levende observasjon som ikke er eldre enn forespørselen og viser ønsket tilstand -> applied (postcondition_observed)", () => {
    expect(decideReconcile(evidence(car("lock"), params, fresh()))).toEqual({ resolution: "applied", basis: "postcondition_observed" });
    expect(decideReconcile(evidence(car("climate_set"), { vehicle_id: "bil", on: true }, fresh({ climate: "on" })))).toMatchObject({ resolution: "applied" });
    expect(decideReconcile(evidence(car("charge_set"), { vehicle_id: "bil", charging: true }, fresh({ charging: "charging" })))).toMatchObject({ resolution: "applied" });
  });

  it("bufret observasjon, manglende/uleselig tidsstempel eller en observasjon ELDRE enn forespørselen bekrefter aldri noe (en bufret «låst» fra før kommandoen)", () => {
    expect(decideReconcile(evidence(car("lock"), params, fresh({ fresh: false })))).toEqual({ resolution: "unknown", basis: "observed_not_fresh" });
    expect(decideReconcile(evidence(car("lock"), params, fresh({ observed_at: null })))).toEqual({ resolution: "unknown", basis: "observed_at_missing" });
    expect(decideReconcile(evidence(car("lock"), params, fresh({ observed_at: "nylig" })))).toEqual({ resolution: "unknown", basis: "observed_at_missing" });
    expect(decideReconcile(evidence(car("lock"), params, fresh({ observed_at: iso(T0 - 1) })))).toEqual({ resolution: "unknown", basis: "observed_before_request" });
    expect(decideReconcile(evidence(car("lock"), params, fresh({ observed_at: iso(T0) })))).toMatchObject({ resolution: "applied" }); // grensen: ikke ELDRE enn forespørselen
  });

  it("bil kan aldri bli failed: feil tilstand, ukjent tilstand eller annen tilstand gir unknown (not_executed_unprovable_for_car), uansett alder", () => {
    for (const lock of ["unlocked", "unknown"]) {
      expect(decideReconcile(evidence(car("lock"), params, fresh({ lock }), { nowMs: T0 + 30 * 86_400_000 }))).toEqual({ resolution: "unknown", basis: "not_executed_unprovable_for_car" });
    }
  });

  it("`op.post` krever `observed_after_command` fra transporten: uten den er ønsket tilstand ikke bevist (unknown)", () => {
    expect(decideReconcile(evidence(car("lock"), params, fresh({ observed_after_command: false })))).toEqual({ resolution: "unknown", basis: "not_executed_unprovable_for_car" });
  });
});

describe("D: invarianter over HELE kombinasjonsrommet (uttømmende oppramsing)", () => {
  it("failed => ikke nådd + brukbar + settlet + endringsbevis + frist + lagret før-tilstand som stemmer + ingen nyere handling; applied => nådd + ingen nyere handling; alt annet unknown; resultatet er alltid en av tre med en gyldig kode", () => {
    const states = ["locked", "unlocked", "locking", "unlocking", "jammed", "unavailable", "unknown", "open", "tull"];
    const changed: Array<string | null> = [iso(T0 - 3_600_000), iso(T0 - HA_CLOCK_SKEW_MS), iso(T0 - HA_CLOCK_SKEW_MS + 1), iso(T0 + 1_000), null, "ugyldig"];
    const befores: Array<string | null> = [null, "locked", "unlocked"];
    const ages = [0, RECONCILE_FAILED_MIN_AGE_MS - 1, RECONCILE_FAILED_MIN_AGE_MS, 10 * RECONCILE_FAILED_MIN_AGE_MS];
    const wanted = [true, false];
    let failed = 0, applied = 0, unknown = 0, total = 0;
    for (const state of states) for (const lastChanged of changed) for (const before of befores) for (const age of ages) for (const locked of wanted) for (const later of [false, true]) {
      const observed = ha("lock.front_door", state, { last_changed: lastChanged });
      const row = { requested_at: iso(T0), completed_at: iso(T0), before_state: before === null ? null : { state: before } };
      const decision = decideReconcile(evidence(home("critical_lock"), { entity: "lock.front_door", locked }, observed, { row, nowMs: T0 + age, laterAction: later }));
      total += 1;
      expect(decision.basis, `${state}/${String(lastChanged)}/${String(before)}/${age}/${String(locked)}/${String(later)}`).toMatch(/^[a-z][a-z0-9_:.-]{0,79}$/);
      const reached = observed["state"] === (locked ? "locked" : "unlocked");
      if (decision.resolution === "failed") {
        failed += 1;
        expect(reached).toBe(false);
        expect(observed["usable"] === true && observed["settled"] === true).toBe(true);
        expect(Date.parse(String(observed["last_changed"])) + HA_CLOCK_SKEW_MS).toBeLessThanOrEqual(T0);
        expect(age).toBeGreaterThanOrEqual(RECONCILE_FAILED_MIN_AGE_MS);
        expect(before, "failed krever en lagret før-tilstand som stemmer med den observerte").toBe(observed["state"]);
        expect(later, "failed krever at ingen nyere handling mot målet finnes").toBe(false);
      } else if (decision.resolution === "applied") {
        applied += 1;
        expect(reached).toBe(true);
        expect(later).toBe(false);
        expect(observed["usable"] === true && observed["settled"] === true).toBe(true);
      } else {
        unknown += 1;
      }
    }
    expect(total).toBe(states.length * changed.length * befores.length * ages.length * 2 * 2);
    expect(failed).toBeGreaterThan(0); // sanity: alle tre utfall forekommer
    expect(applied).toBeGreaterThan(0);
    expect(unknown).toBeGreaterThan(0);
  });

  it("en kastende `op.post` (utvidelseskode) er aldri en bevist sluttilstand: behandles som «ikke nådd» og kan aldri gi applied", () => {
    const throwing: PersonalActionIndexEntry = { domain: "home", toolId: "home-assistant", op: { ...home("critical_lock").op, post: () => { throw new Error("boom"); } } };
    const decision = decideReconcile(evidence(throwing, { entity: "lock.front_door", locked: true }, ha("lock.front_door", "locked", { last_changed: iso(T0 + 1_000) })));
    expect(decision).toEqual({ resolution: "unknown", basis: "state_changed_since_request" });
  });

  it("ugyldig forespørselstid gir unknown (request_time_invalid): aldri en beslutning på et tidspunkt som ikke kan leses", () => {
    expect(decideReconcile(evidence(home("critical_lock"), { entity: "lock.front_door", locked: true }, ha("lock.front_door", "locked"), { row: { requested_at: "ikke tid", completed_at: null, before_state: null } }))).toEqual({ resolution: "unknown", basis: "request_time_invalid" });
  });
});

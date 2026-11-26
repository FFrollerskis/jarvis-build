import { describe, expect, it } from "vitest";
import { CAR_CRITICAL_OPS, HOME_CRITICAL_OPS, carCriticalToolDefinitions, homeCriticalToolDefinitions, normalizeHomeCriticalState, parseCarTargets, zRecord, type ToolDefinition } from "../src/index.ts";

/**
 * WP-G2c fiks-runde 1 (LOW-4): `personal_action_journal.request_params` (migrasjon 144) lagrer parameterne i KLARTEKST - også på `failed`-rader - så de lagrede feltene må være ukapable av å bære fritekst, en kode eller en hemmelighet.
 * Migrasjonens header lover «aldri alarmkode, token eller fritekst», og behandlingsinventaret «ingen hemmeligheter». Det håndheves nå av SKJEMAET (samme skjema som gatewayen og eksekutoren bruker): `expected_state` er kun små bokstaver og
 * understrek (HA-tilstandsord), og scene-/skript-markørene er kun ISO-tidsstempler (eller `null`). Ingen eksisterende, gyldig bruk avvises: alle tilstandsord normalisereren kan gi og alle markører HA gir passerer.
 */
const home: ToolDefinition[] = homeCriticalToolDefinitions({ invoke: async () => ({}) }, { targets: new Set(), settleMs: 20_000, pollMs: 1_000 });
const car: ToolDefinition[] = carCriticalToolDefinitions({ invoke: async () => ({}) }, { targets: parseCarTargets("bil"), settleMs: 10_000, pollMs: 1_000 });
const accepts = (action: string, parameters: Record<string, unknown>): boolean => home.find((d) => d.action === action)!.input_schema.safeParse(parameters).success;

/** Handlingene som har `expected_state`, med minimale gyldige parametre (uten den). */
const WITH_EXPECTED_STATE: Array<[string, Record<string, unknown>, string]> = [
  ["critical_lock", { entity: "lock.front_door", locked: true }, "lock"],
  ["critical_alarm", { entity: "alarm_control_panel.home", armed: true, mode: "away" }, "alarm_control_panel"],
  ["critical_cover", { entity: "cover.garage", target: "open" }, "cover"],
  ["critical_valve", { entity: "valve.main", target: "closed" }, "valve"],
  ["critical_switch", { entity: "switch.heater", on: true }, "switch"],
  ["critical_climate_mode", { entity: "climate.living", hvac_mode: "heat" }, "climate"]
];

describe("expected_state: kun små bokstaver og understrek (HA-tilstandsord), 1-40 tegn", () => {
  for (const [action, base] of WITH_EXPECTED_STATE) {
    it(`${action}: gyldige tilstandsord passerer; kode-/fritekst-lignende verdier avvises`, () => {
      expect(accepts(action, base), "uten expected_state").toBe(true);
      for (const ok of ["locked", "unlocked", "jammed", "disarmed", "armed_away", "armed_custom_bypass", "arming", "open", "closed", "on", "off", "heat_cool", "fan_only", "unavailable", "unknown", "a", "x".repeat(40)]) {
        expect(accepts(action, { ...base, expected_state: ok }), `skal passere: ${ok}`).toBe(true);
      }
      for (const bad of [
        "kode-1234-hemmelig-pin", "1234", "pin1234", "Locked", "LOCKED", "locked ", " locked", "lock ed", "locked\n", "locked;drop", "låst", "locked-", "armed-away", "tok_3n", "a.b", "x".repeat(41), "", "\u0000", "locked\u0000", "\ud800", "😀", "locked‮"
      ]) {
        expect(accepts(action, { ...base, expected_state: bad }), `skal avvises: ${JSON.stringify(bad)}`).toBe(false);
      }
      for (const wrongType of [1234, true, null, ["locked"], { state: "locked" }]) expect(accepts(action, { ...base, expected_state: wrongType }), JSON.stringify(wrongType)).toBe(false);
    });
  }

  it("ingen eksisterende, gyldig bruk avvises: ALLE tilstandsord normalisereren kan gi (lukket liste per domene) passerer som expected_state i handlingene for domenet", () => {
    const rawStates: Record<string, string[]> = {
      lock: ["locked", "unlocked", "locking", "unlocking", "jammed", "open", "opening", "unavailable", "unknown", "tull"],
      alarm_control_panel: ["disarmed", "armed_home", "armed_away", "armed_night", "armed_vacation", "armed_custom_bypass", "pending", "arming", "disarming", "triggered", "unavailable", "unknown", "tull"],
      cover: ["open", "closed", "opening", "closing", "unavailable", "unknown"], valve: ["open", "closed", "opening", "closing", "unavailable", "unknown"],
      switch: ["on", "off", "unavailable", "unknown"], climate: ["off", "heat", "cool", "heat_cool", "auto", "dry", "fan_only", "unavailable", "unknown"]
    };
    let checked = 0;
    for (const [action, base, domain] of WITH_EXPECTED_STATE) {
      for (const raw of rawStates[domain]!) {
        const normalized = normalizeHomeCriticalState({ entity_id: `${domain}.x`, state: raw });
        expect(accepts(action, { ...base, expected_state: normalized["state"] }), `${domain}: ${String(normalized["state"])}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("alle handlinger i det strenge skjemaet (`zRecord` av `op.shape`, det eksekutoren lagrer etter) gir samme svar som verktøydefinisjonen", () => {
    for (const [action, base] of WITH_EXPECTED_STATE) {
      const op = HOME_CRITICAL_OPS.find((o) => o.action === action)!;
      for (const [value, want] of [["unlocked", true], ["kode-1234-hemmelig-pin", false]] as const) expect(zRecord(op.shape).safeParse({ ...base, expected_state: value }).success, `${action}/${value}`).toBe(want);
    }
  });
});

describe("scene-/skript-markørene: kun ISO-tidsstempel eller null", () => {
  const MARKERS: Array<[string, string, Record<string, unknown>]> = [
    ["critical_scene", "expected_last_activated", { entity: "scene.evening" }],
    ["critical_script", "expected_last_triggered", { entity: "script.night" }]
  ];
  for (const [action, field, base] of MARKERS) {
    it(`${action}.${field}: tidsstempler (også HAs mikrosekundformat med +00:00) og null passerer; kode, tekst og dato uten klokkeslett avvises`, () => {
      for (const ok of [null, "2026-11-18T10:00:00.000Z", "2026-11-18T10:00:00Z", "2026-11-18T10:00:00+00:00", "2026-11-18T10:00:00.123456+00:00", "2026-11-18T10:00:00", "2026-11-18T10:00:00.123456789Z", "2026-11-18T12:00:00+01:00"]) {
        expect(accepts(action, { ...base, [field]: ok }), `skal passere: ${String(ok)}`).toBe(true);
      }
      for (const bad of ["kode-1234-hemmelig-pin", "ikke en dato", "1234", "", "2026-11-18", "2026-11-18T10:00", "2026-11-18T10:00:00Z extra", "2026-11-18T10:00:00Z\n", " 2026-11-18T10:00:00Z", "2026-11-18T10:00:00Z;DROP", "token-abc", "x".repeat(65), "\u0000", "2026-11-18T10:00:00\u0000Z"]) {
        expect(accepts(action, { ...base, [field]: bad }), `skal avvises: ${JSON.stringify(bad)}`).toBe(false);
      }
      expect(accepts(action, base), "markøren er fortsatt PÅKREVD (null = aldri aktivert)").toBe(false);
      for (const wrongType of [1234, true, ["2026-11-18T10:00:00Z"], {}]) expect(accepts(action, { ...base, [field]: wrongType }), JSON.stringify(wrongType)).toBe(false);
    });
  }

  it("en markør slik normalisereren leser den fra HA (scene-tilstand, skriptets `last_triggered`) består alltid skjemaet - ellers kunne en bindeverdi fra forhåndsvisningen ikke sendes tilbake", () => {
    const scene = normalizeHomeCriticalState({ entity_id: "scene.evening", state: "2026-11-18T10:00:00.123456+00:00" });
    expect(accepts("critical_scene", { entity: "scene.evening", expected_last_activated: scene["last_activated"] })).toBe(true);
    const script = normalizeHomeCriticalState({ entity_id: "script.night", state: "off", attributes: { last_triggered: "2026-11-18T10:00:00.123456+00:00" } });
    expect(accepts("critical_script", { entity: "script.night", expected_last_triggered: script["last_triggered"] })).toBe(true);
  });
});

describe("hver lagret parameter i ALLE kritiske handlinger har et lukket skjema (hjem og bil)", () => {
  it("ingen handling godtar et fritt tekstfelt: hver streng-parameter er et regex/enum-begrenset felt - fritekst med mellomrom, store bokstaver og tegnsetting avvises uansett felt (identifikator-formede felt, `entity`/`vehicle_id`, er regex-begrensede alias og lagres også for mål som ikke står på eierens liste: dokumentert)", () => {
    const defs = [...home, ...car].filter((d) => HOME_CRITICAL_OPS.some((o) => o.action === d.action) || CAR_CRITICAL_OPS.some((o) => o.action === d.action));
    expect(defs.length).toBeGreaterThanOrEqual(HOME_CRITICAL_OPS.length + CAR_CRITICAL_OPS.length);
    const probe = "Kode 1234: token abc!";
    for (const op of [...HOME_CRITICAL_OPS, ...CAR_CRITICAL_OPS]) {
      const shape = zRecord(op.shape);
      const keys = Object.keys(op.shape);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        // en gyldig basisforespørsel finnes per handling i de andre testene; her holder det å vise at ingen enkelt-felt godtar probeteksten
        const fieldSchema = op.shape[key]!;
        expect(fieldSchema.safeParse(probe).success, `${op.action}.${key} godtar fritekst`).toBe(false);
      }
      expect(shape.safeParse({ [keys[0]!]: probe }).success).toBe(false);
    }
  });
});

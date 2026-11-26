import { describe, expect, it } from "vitest";
import {
  STEPUP_BINDING_NOT_ENFORCED,
  STEPUP_BOUND_FLAG_GROUPS,
  STEPUP_CHANNEL_BINDING_ENV,
  applyStepUpBindingGate,
  describeStepUpBinding,
  parseStepUpBindingMode
} from "../src/index.ts";

/**
 * WP-S1 K4/K5: modusen og den fail-closed koblingen til høyrisiko-flaggene. Registeret over flaggene er skrevet ut for hånd her (uavhengig av implementasjonen), slik at et flagg som legges til/fjernes i registeret
 * uten at denne testen følger med, feiler.
 */
const EXPECTED_FLAGS: Record<string, readonly string[]> = {
  personal: [
    "JARVIS_PERSONAL_HOME_CRITICAL", "JARVIS_PERSONAL_CAR", "JARVIS_PERSONAL_FAMILY", "JARVIS_PERSONAL_HEALTH_INGEST", "JARVIS_PERSONAL_APPLE_DAV", "JARVIS_PERSONAL_FINANCE_READ", "JARVIS_PERSONAL_CONTEXT"
  ],
  growth_write: ["JARVIS_GROWTH_WRITE_PLATFORMS"],
  comms_outbound: ["JARVIS_COMMS_OUTBOUND", "JARVIS_COMMS_VENDOR_READS", "JARVIS_COMMS_CALLS", "JARVIS_COMMS_CONTACTS", "JARVIS_COMMS_MEETINGS"],
  situation_signals: ["JARVIS_SITUATION_SIGNALS"]
};
const ALL_FLAGS = Object.values(EXPECTED_FLAGS).flat();

describe("WP-S1 K4: modusparseren (standard observe, aldri enforce ved en feiltolkning)", () => {
  it("usatt, tom og eksakt `observe` gir observe uten ugyldig verdi", () => {
    for (const raw of [undefined, "", "observe"]) expect(parseStepUpBindingMode(raw)).toEqual({ mode: "observe", enforced: false, invalid_value: null });
  });

  it("eksakt `enforce` gir enforce", () => {
    expect(parseStepUpBindingMode("enforce")).toEqual({ mode: "enforce", enforced: true, invalid_value: null });
  });

  it("alt annet gir observe OG meldes som ugyldig (en skrivefeil kan aldri stille gi enforce, og aldri en krasj)", () => {
    for (const raw of ["enforced", "ENFORCE", "Enforce", " enforce", "enforce ", "enforce\n", "on", "true", "1", "yes", "enforce,observe", "observe ", "off", "0", "strict"]) {
      const s = parseStepUpBindingMode(raw);
      expect(s.mode, raw).toBe("observe");
      expect(s.enforced, raw).toBe(false);
      expect(s.invalid_value, raw).not.toBeNull();
    }
  });

  it("den ugyldige verdien vises avkortet og uten kontrolltegn (kun synlig ASCII), så status/logg ikke kan forfalskes", () => {
    const s = parseStepUpBindingMode("enf\norce\u0007" + "x".repeat(200));
    expect(s.invalid_value).not.toBeNull();
    expect((s.invalid_value as string).length).toBeLessThanOrEqual(40);
    expect(s.invalid_value).toMatch(/^[\x21-\x7e]+$/);
  });
});

describe("WP-S1 K4: den fail-closed porten", () => {
  it("registeret dekker NØYAKTIG de forventede flaggene (verifisert mot koden i apps/api/test/wps1-stepup-gate-wiring.test.ts)", () => {
    const actual = Object.fromEntries(STEPUP_BOUND_FLAG_GROUPS.map((g) => [g.id, g.flags.map((f) => f.name)]));
    expect(actual).toEqual(EXPECTED_FLAGS);
    expect(new Set(ALL_FLAGS).size).toBe(ALL_FLAGS.length);
  });

  it("observe: HVERT flagg som er på blokkeres med årsaken stepup_binding_not_enforced, og fjernes fra den effektive miljø-kopien", () => {
    for (const flag of ALL_FLAGS) {
      const source = { [flag]: flag === "JARVIS_GROWTH_WRITE_PLATFORMS" ? "google_ads,meta_ads" : "on", JARVIS_UNRELATED: "x" };
      const gate = applyStepUpBindingGate(source);
      expect(gate.setting.mode, flag).toBe("observe");
      expect(gate.blocked.map((b) => b.flag), flag).toEqual([flag]);
      expect(gate.blocked[0]?.reason, flag).toBe(STEPUP_BINDING_NOT_ENFORCED);
      expect(gate.env[flag], flag).toBeUndefined();
      expect(flag in gate.env, flag).toBe(false);
      expect(gate.env["JARVIS_UNRELATED"], flag).toBe("x");
      expect(source[flag as keyof typeof source], "originalen røres aldri").toBeDefined();
    }
  });

  it("observe: ALLE flagg på samtidig gir alle blokkert, ingen igjen i den effektive kopien", () => {
    const source: Record<string, string> = Object.fromEntries(ALL_FLAGS.map((f) => [f, f === "JARVIS_GROWTH_WRITE_PLATFORMS" ? "ga4" : "on"]));
    const gate = applyStepUpBindingGate(source);
    expect(gate.blocked.map((b) => b.flag).sort()).toEqual([...ALL_FLAGS].sort());
    for (const f of ALL_FLAGS) expect(f in gate.env).toBe(false);
  });

  it("observe: et `on`-flagg som ikke er eksakt på (usatt, tom, `off`, `true`, `1`, `ON`) er ikke «blokkert» (ingenting var slått på), men fjernes likevel fra den effektive kopien", () => {
    for (const value of [undefined, "", "off", "true", "1", "ON", "yes", "   "]) {
      const gate = applyStepUpBindingGate({ JARVIS_PERSONAL_HOME_CRITICAL: value, JARVIS_SITUATION_SIGNALS: value });
      expect(gate.blocked.map((b) => b.flag), String(value)).toEqual([]);
      expect("JARVIS_PERSONAL_HOME_CRITICAL" in gate.env).toBe(false);
      expect("JARVIS_SITUATION_SIGNALS" in gate.env).toBe(false);
    }
  });

  it("observe: plattformlisten (`list`) regnes som slått på når den er ikke-tom (selv en ukjent plattform: eieren skal se at variabelen står der), men ikke når den er usatt/tom/blank", () => {
    for (const value of [undefined, "", "   "]) {
      const gate = applyStepUpBindingGate({ JARVIS_GROWTH_WRITE_PLATFORMS: value });
      expect(gate.blocked, String(value)).toEqual([]);
      expect("JARVIS_GROWTH_WRITE_PLATFORMS" in gate.env).toBe(false);
    }
    for (const value of ["ga4", " google_ads , meta_ads ", "ukjent"]) {
      const gate = applyStepUpBindingGate({ JARVIS_GROWTH_WRITE_PLATFORMS: value });
      expect(gate.blocked.map((b) => b.flag), value).toEqual(["JARVIS_GROWTH_WRITE_PLATFORMS"]);
      expect("JARVIS_GROWTH_WRITE_PLATFORMS" in gate.env).toBe(false);
    }
  });

  it("observe: `on` med mellomrom i endene (som comms-parseren godtar) regnes som slått på og blokkeres", () => {
    const gate = applyStepUpBindingGate({ JARVIS_COMMS_OUTBOUND: " on ", JARVIS_PERSONAL_CAR: "on " });
    expect(gate.blocked.map((b) => b.flag).sort()).toEqual(["JARVIS_COMMS_OUTBOUND", "JARVIS_PERSONAL_CAR"]);
  });

  it("enforce: ingenting blokkeres, og den effektive kopien er LIK originalen (men et eget objekt)", () => {
    const source = { [STEPUP_CHANNEL_BINDING_ENV]: "enforce", JARVIS_PERSONAL_HOME_CRITICAL: "on", JARVIS_GROWTH_WRITE_PLATFORMS: "ga4", JARVIS_COMMS_OUTBOUND: "on", JARVIS_SITUATION_SIGNALS: "on", JARVIS_X: "1" };
    const gate = applyStepUpBindingGate(source);
    expect(gate.setting.enforced).toBe(true);
    expect(gate.blocked).toEqual([]);
    expect(gate.env).toEqual(source);
    expect(gate.env).not.toBe(source);
  });

  it("ugyldig modusverdi (skrivefeil) gir observe-oppførsel: flaggene blokkeres (aldri en stille effekt), og verdien meldes", () => {
    const gate = applyStepUpBindingGate({ [STEPUP_CHANNEL_BINDING_ENV]: "enforced", JARVIS_PERSONAL_CAR: "on" });
    expect(gate.setting).toEqual({ mode: "observe", enforced: false, invalid_value: "enforced" });
    expect(gate.blocked.map((b) => b.flag)).toEqual(["JARVIS_PERSONAL_CAR"]);
  });

  it("uten noen flagg på (flagg AV): den effektive kopien er LIK originalen bortsett fra at de bundne navnene ikke finnes, og blocked er tom = identisk med main", () => {
    const source = { JARVIS_TENANT_ID: "t", JARVIS_API_PORT: "3010", JARVIS_COMMS_CHANNELS: "slack", JARVIS_SITUATION_HOME: "on" };
    const gate = applyStepUpBindingGate(source);
    expect(gate.blocked).toEqual([]);
    expect(gate.env).toEqual(source);
  });

  it("underflagg som ikke er i registeret røres ikke (JARVIS_SITUATION_HOME gjelder kun under hovedbryteren; JARVIS_COMMS_CHANNELS er ren konfigurasjon)", () => {
    const gate = applyStepUpBindingGate({ JARVIS_SITUATION_HOME: "on", JARVIS_COMMS_CHANNELS: "slack,sms", JARVIS_GROWTH_WRITE_TARGETS: "ga4:123456", JARVIS_PERSONAL_HOME_TARGETS: "lock.x" });
    expect(gate.env).toEqual({ JARVIS_SITUATION_HOME: "on", JARVIS_COMMS_CHANNELS: "slack,sms", JARVIS_GROWTH_WRITE_TARGETS: "ga4:123456", JARVIS_PERSONAL_HOME_TARGETS: "lock.x" });
  });

  it("describeStepUpBinding gir kun modus, ugyldig verdi og blokkerte flaggnavn (ingen verdier)", () => {
    const gate = applyStepUpBindingGate({ JARVIS_PERSONAL_CAR: "on", JARVIS_GROWTH_WRITE_PLATFORMS: "google_ads", JARVIS_GROWTH_WRITE_TARGETS: "google_ads:1234567890" });
    const d = describeStepUpBinding(gate);
    expect(d).toEqual({
      mode: "observe", enforced: false, invalid_value: null,
      blocked: [
        { flag: "JARVIS_PERSONAL_CAR", group: "personal", reason: "stepup_binding_not_enforced" },
        { flag: "JARVIS_GROWTH_WRITE_PLATFORMS", group: "growth_write", reason: "stepup_binding_not_enforced" }
      ]
    });
    expect(JSON.stringify(d)).not.toContain("1234567890");
  });
});

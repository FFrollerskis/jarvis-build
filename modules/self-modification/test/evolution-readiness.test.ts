import { describe, expect, it } from "vitest";
import { EXTERNAL_GATES, READINESS, evaluateAllReadiness, evaluateReadiness, parseDeclaredGates, type DormantEv, type ReadinessFacts } from "../src/index.ts";

/**
 * WP-B (D-452): aktiveringsberedskap for de sovende Evolution-delene. REN logikk som svarer «hva mangler før en navngitt D-beslutning kan vurderes?». Den aktiverer aldri noe (`activation_decision` er alltid false).
 */
const facts = (over: Partial<ReadinessFacts> = {}): ReadinessFacts => ({
  constitution_verified: true, ledger_ok: true, change_freeze_off: true, proven_connectors: 0, job_runner_configured: false, declared_gates: new Set(), ...over
});
const ALL: DormantEv[] = ["EV-6", "EV-11", "EV-13", "EV-14", "EV-15", "EV-18", "EV-20", "EV-22", "EV-23"];
const allGates = new Set<string>(EXTERNAL_GATES);

describe("evaluateReadiness", () => {
  it("dekker nøyaktig de ni sovende delene, hver med tittel, årsak og minst ett krav", () => {
    expect(Object.keys(READINESS).sort()).toEqual([...ALL].sort());
    for (const ev of ALL) {
      expect(READINESS[ev].title_no.length, ev).toBeGreaterThan(3);
      expect(READINESS[ev].why_dormant_no.length, ev).toBeGreaterThan(10);
      expect(READINESS[ev].requirements.length, ev).toBeGreaterThanOrEqual(4);
    }
  });

  it("aktivering er ALDRI besluttet av kode: activation_decision er false selv når alle krav er oppfylt", () => {
    const ready = facts({ proven_connectors: 5, job_runner_configured: true, declared_gates: allGates });
    for (const v of evaluateAllReadiness(ready)) {
      expect(v.activation_decision, v.ev).toBe(false);
      expect(v.ready_for_owner_decision, v.ev).toBe(true);
      expect(v.missing, v.ev).toEqual([]);
    }
  });

  it("uten noe verifisert mangler alle deler noe, og konstitusjon/register/frys er felles grunnkrav", () => {
    const none = facts({ constitution_verified: false, ledger_ok: false, change_freeze_off: false });
    for (const v of evaluateAllReadiness(none)) {
      expect(v.ready_for_owner_decision, v.ev).toBe(false);
      const ids = v.missing.map((m) => m.id);
      for (const base of ["constitution_verified", "ledger_ok", "change_freeze_off"]) expect(ids, `${v.ev} ${base}`).toContain(base);
    }
  });

  it("EV-6 krever bevist worker-isolasjon (D-32) OG at runneren er konfigurert - ett av dem alene holder ikke", () => {
    expect(evaluateReadiness("EV-6", facts({ job_runner_configured: true })).missing.map((m) => m.id)).toEqual(["gate:D-32"]);
    expect(evaluateReadiness("EV-6", facts({ declared_gates: new Set(["D-32"]) })).missing.map((m) => m.id)).toEqual(["job_runner_configured"]);
    expect(evaluateReadiness("EV-6", facts({ job_runner_configured: true, declared_gates: new Set(["D-32"]) })).ready_for_owner_decision).toBe(true);
  });

  it("EV-18 krever minst tre beviste connectorer (målt) og fabrikkporten (erklært)", () => {
    const gates = new Set(["CONNECTOR_FACTORY"]);
    expect(evaluateReadiness("EV-18", facts({ proven_connectors: 2, declared_gates: gates })).missing.map((m) => m.id)).toEqual(["proven_connectors>=3"]);
    expect(evaluateReadiness("EV-18", facts({ proven_connectors: 3, declared_gates: gates })).ready_for_owner_decision).toBe(true);
    expect(evaluateReadiness("EV-18", facts({ proven_connectors: 3 })).missing.map((m) => m.id)).toEqual(["gate:CONNECTOR_FACTORY"]);
  });

  it("EV-14 avhenger av EV-13: uttrykkstilstand krever at begge er koblet", () => {
    const only14 = evaluateReadiness("EV-14", facts({ declared_gates: new Set(["EXPRESSION_STATE_WIRED"]) }));
    expect(only14.missing.map((m) => m.id)).toEqual(["gate:PERSONALITY_SLIDERS_WIRED"]);
  });

  it("EV-22/EV-23 avhenger av kontrollsentrene; EV-20 av off-site restore; EV-15 av UA-10 og kontrollsentrene; EV-11 av utfallssporing og UA-10", () => {
    const only = (ev: DormantEv, gates: string[]) => evaluateReadiness(ev, facts({ declared_gates: new Set(gates) })).ready_for_owner_decision;
    expect(only("EV-22", ["ADMIN_CONTROL_CENTER"])).toBe(true);
    expect(only("EV-23", ["ADMIN_CONTROL_CENTER"])).toBe(true);
    expect(only("EV-20", ["OFFSITE_RESTORE"])).toBe(true);
    expect(only("EV-15", ["UA-10_LIVE"])).toBe(false);
    expect(only("EV-15", ["UA-10_LIVE", "ADMIN_CONTROL_CENTER"])).toBe(true);
    expect(only("EV-11", ["OUTCOME_TRACKING"])).toBe(false);
    expect(only("EV-11", ["OUTCOME_TRACKING", "UA-10_LIVE"])).toBe(true);
  });
});

describe("parseDeclaredGates", () => {
  it("godtar kun kjente porter (trimmet), ignorerer resten, og tom/udefinert gir tomt sett", () => {
    expect([...parseDeclaredGates(" D-32 , OFFSITE_RESTORE ,NOE_UKJENT,, d-32")].sort()).toEqual(["D-32", "OFFSITE_RESTORE"]);
    expect(parseDeclaredGates(undefined).size).toBe(0);
    expect(parseDeclaredGates("").size).toBe(0);
  });
});

/**
 * M2 (gjennomgang av PR #313): readiness for sovende deler kan ALDRI si «klar» når et innsignal er ukjent. Et målt innsignal som ikke kunne måles er `null`; kravet som hviler på det er ikke oppfylt og står i
 * `missing` med `unknown: true`. (Før rettelsen kunne en kill switch som ikke lot seg lese gi `change_freeze_off: true` og «klar for en navngitt D-beslutning».)
 */
describe("evaluateReadiness: ukjente innsignal", () => {
  const MEASURED = ["constitution_verified", "ledger_ok", "change_freeze_off", "proven_connectors"] as const;
  const readyFacts = (over: Partial<ReadinessFacts> = {}): ReadinessFacts => facts({ proven_connectors: 5, job_runner_configured: true, declared_gates: allGates, ...over });

  it("hvert målt innsignal som er ukjent (null, undefined eller feil type) hindrer ALLE deler som hviler på det i å bli klare - og activation_decision er fortsatt false", () => {
    for (const key of MEASURED) {
      for (const unknown of [null, undefined, "ja", Number.NaN]) {
        const verdicts = evaluateAllReadiness(readyFacts({ [key]: unknown } as Partial<ReadinessFacts>));
        for (const v of verdicts) {
          expect(v.activation_decision, `${key}=${String(unknown)} ${v.ev}`).toBe(false);
          const dependsOn = READINESS[v.ev].requirements.some((r) => r.needs?.includes(key));
          if (dependsOn) {
            expect(v.ready_for_owner_decision, `${key}=${String(unknown)} ${v.ev}`).toBe(false);
            expect(v.unknown_signals, `${key}=${String(unknown)} ${v.ev}`).toContain(key);
            expect(v.missing.some((m) => m.unknown), `${key}=${String(unknown)} ${v.ev}`).toBe(true);
          } else {
            expect(v.ready_for_owner_decision, `${key}=${String(unknown)} ${v.ev} (hviler ikke på ${key})`).toBe(true);
          }
        }
      }
    }
  });

  it("de tre grunnkravene gjelder ALLE deler: ukjent konstitusjon, register eller frys gjør hele rekken uklar; ukjent connector-tall rammer kun EV-18", () => {
    for (const key of ["constitution_verified", "ledger_ok", "change_freeze_off"] as const) {
      for (const v of evaluateAllReadiness(readyFacts({ [key]: null }))) expect(v.ready_for_owner_decision, `${key} ${v.ev}`).toBe(false);
    }
    const noConnectorCount = evaluateAllReadiness(readyFacts({ proven_connectors: null }));
    expect(noConnectorCount.filter((v) => !v.ready_for_owner_decision).map((v) => v.ev)).toEqual(["EV-18"]);
  });

  it("ukjent er noe annet enn «målt og ikke oppfylt»: false/0 gir unknown: false, null gir unknown: true", () => {
    const measuredBad = evaluateReadiness("EV-18", readyFacts({ proven_connectors: 0, change_freeze_off: false }));
    expect(measuredBad.missing.map((m) => [m.id, m.unknown])).toEqual([["change_freeze_off", false], ["proven_connectors>=3", false]]);
    expect(measuredBad.unknown_signals).toEqual([]);
    const unknown = evaluateReadiness("EV-18", readyFacts({ proven_connectors: null, change_freeze_off: null }));
    expect(unknown.missing.map((m) => [m.id, m.unknown])).toEqual([["change_freeze_off", true], ["proven_connectors>=3", true]]);
    expect([...unknown.unknown_signals].sort()).toEqual(["change_freeze_off", "proven_connectors"]);
  });

  it("alle innsignal kjent og oppfylt gir klar uten ukjente - og aldri aktivering", () => {
    for (const v of evaluateAllReadiness(readyFacts())) {
      expect(v.ready_for_owner_decision, v.ev).toBe(true);
      expect(v.unknown_signals, v.ev).toEqual([]);
      expect(v.activation_decision, v.ev).toBe(false);
    }
  });
});

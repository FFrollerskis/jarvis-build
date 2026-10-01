import { describe, expect, it } from "vitest";
import { InvalidEnvValueError, envHour, envInt, envPort } from "@jarvis/contracts";

/**
 * Remediering del 1 (JARVIS-027/083/092): `Number(env ?? default)` ga 0 for en tom
 * streng og NaN for søppel. Tom/usatt = eksplisitt default; ugyldig = oppstartsfeil.
 */
describe("envInt / envHour / envPort", () => {
  it("usatt og tom/blank streng gir den eksplisitte defaulten (aldri 0)", () => {
    expect(envHour("X_HOUR", 4, {})).toBe(4);
    expect(envHour("X_HOUR", 4, { X_HOUR: "" })).toBe(4);
    expect(envHour("X_HOUR", 4, { X_HOUR: "   " })).toBe(4);
    expect(envPort("P", 3010, { P: "" })).toBe(3010);
  });

  it("gyldig verdi brukes, også 0 (eksplisitt midnatt er lov)", () => {
    expect(envHour("X_HOUR", 4, { X_HOUR: "0" })).toBe(0);
    expect(envHour("X_HOUR", 4, { X_HOUR: " 23 " })).toBe(23);
    expect(envPort("P", 3010, { P: "8080" })).toBe(8080);
  });

  it("søppel, flyttall og utenfor grensene kaster (oppstartsfeil), aldri NaN/midnatt", () => {
    for (const bad of ["abc", "NaN", "4.5", "24", "-1", "1e1x"]) {
      expect(() => envHour("X_HOUR", 4, { X_HOUR: bad }), bad).toThrow(InvalidEnvValueError);
    }
    expect(() => envPort("P", 3010, { P: "0" })).toThrow(InvalidEnvValueError);
    expect(() => envPort("P", 3010, { P: "70000" })).toThrow(InvalidEnvValueError);
    expect(() => envInt("D", 60, { min: 1, max: 3650 }, { D: "0" })).toThrow(/forventet heltall 1\.\.3650/);
  });

  it("feilmeldingen nevner variabelnavnet og avkorter verdien", () => {
    try {
      envHour("JARVIS_SOME_HOUR", 4, { JARVIS_SOME_HOUR: "x".repeat(200) });
      throw new Error("skulle kastet");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidEnvValueError);
      expect((err as Error).message).toContain("JARVIS_SOME_HOUR");
      expect((err as Error).message.length).toBeLessThan(200);
    }
  });
});

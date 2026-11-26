import { describe, expect, it } from "vitest";
import { GUARD_MODES, GUARD_MODE_ENV, GuardModeError, parseModeValue, resolveGuardMode } from "../src/program/mode.ts";

/**
 * WP-PGA (lead-beslutning 2): HF6-capstone-vaktene (programindeks, gate-staleness, feilkode-dekning) kjører i `report`-modus til eieren navngir adopsjonen
 * (ADR-001 §2.1). Skiftet til `enforce` er ÉN verdi (`guard.mode` i `config/program/manifest.json`). Miljøvariabelen `PROGRAM_INDEX_MODE` kan KUN stramme inn
 * (enforce vinner): en løsning av vakten via miljøet ville vært en stille svekkelse som ingen diff viser. En ugyldig verdi er alltid et høyt brudd, aldri `report`.
 */
describe("parseModeValue", () => {
  it("tom/manglende verdi er «ikke satt» (null), ikke en modus", () => {
    expect(parseModeValue(undefined, "env")).toBeNull();
    expect(parseModeValue("", "env")).toBeNull();
  });

  it("nøyaktig «report» og «enforce» (små bokstaver) godtas", () => {
    expect(parseModeValue("report", "env")).toBe("report");
    expect(parseModeValue("enforce", "env")).toBe("enforce");
  });

  it.each(["Enforce", "REPORT", " enforce", "enforce ", "enforce\n", "enforc", "true", "1", "off", "warn", "enforce,report"])("ugyldig verdi %j kaster GuardModeError (aldri stille report)", (raw) => {
    expect(() => parseModeValue(raw, "env")).toThrow(GuardModeError);
  });
});

describe("resolveGuardMode", () => {
  it("manifest report + ingen env => report", () => {
    expect(resolveGuardMode("report", undefined)).toEqual({ mode: "report", manifest_mode: "report", env_mode: null, raised_by_env: false });
  });

  it("manifest enforce + ingen env => enforce", () => {
    expect(resolveGuardMode("enforce", undefined).mode).toBe("enforce");
  });

  it("env enforce strammer inn et report-manifest (og sier det)", () => {
    expect(resolveGuardMode("report", "enforce")).toEqual({ mode: "enforce", manifest_mode: "report", env_mode: "enforce", raised_by_env: true });
  });

  it("env report KAN IKKE løse opp et enforce-manifest (kun innstramming)", () => {
    const r = resolveGuardMode("enforce", "report");
    expect(r.mode).toBe("enforce");
    expect(r.raised_by_env).toBe(false);
    expect(r.env_mode).toBe("report");
  });

  it("env report + manifest report => report; env enforce + manifest enforce => enforce uten raised_by_env", () => {
    expect(resolveGuardMode("report", "report").mode).toBe("report");
    expect(resolveGuardMode("enforce", "enforce")).toMatchObject({ mode: "enforce", raised_by_env: false });
  });

  it.each([undefined, null, "", "Report", "enforced", 1, true, {}, []])("ugyldig manifestverdi %j kaster (fail-closed)", (bad) => {
    expect(() => resolveGuardMode(bad, undefined)).toThrow(GuardModeError);
  });

  it("ugyldig env kaster selv om manifestet er gyldig", () => {
    expect(() => resolveGuardMode("report", "enforc")).toThrow(GuardModeError);
  });

  it("konstantene er stabile (navnet på miljøvariabelen og de to modusene)", () => {
    expect(GUARD_MODE_ENV).toBe("PROGRAM_INDEX_MODE");
    expect([...GUARD_MODES]).toEqual(["report", "enforce"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  SweepFailedError,
  SweepFailureCollector,
  assertNoSweepFailures,
  describeSweepError,
  failOnSweepFailures
} from "../src/sweep-failures.ts";

describe("D-442 (JARVIS-027): SweepFailureCollector", () => {
  it("registrerer tenant, valgfri delmengde og kortet feiltekst - ingen scope-nøkkel når scope mangler", () => {
    const collector = new SweepFailureCollector();
    collector.record("t1", new Error("boom"));
    collector.record("t2", "ren streng", "gmail");
    expect(collector.failures).toEqual([
      { tenant_id: "t1", error: "boom" },
      { tenant_id: "t2", scope: "gmail", error: "ren streng" }
    ]);
    expect(Object.keys(collector.failures[0]!)).not.toContain("scope");
  });

  it("avkorter lange feiltekster (kan havne i scheduler_state.last_error og logger)", () => {
    expect(describeSweepError(new Error("x".repeat(500))).length).toBe(120);
    expect(describeSweepError(undefined)).toBe("undefined");
  });
});

describe("D-442: assertNoSweepFailures", () => {
  it("tom liste kaster ikke", () => {
    expect(() => assertNoSweepFailures("job", [])).not.toThrow();
  });

  it("kaster SweepFailedError med jobbnavn, antall og første feil; memory_space_id blir scope", () => {
    let caught: unknown;
    try {
      assertNoSweepFailures("memory-retention-sweep", [
        { tenant_id: "t1", memory_space_id: "business", error: "db nede" },
        { tenant_id: "t2", error: "annen feil" }
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SweepFailedError);
    const failed = caught as SweepFailedError;
    expect(failed.job).toBe("memory-retention-sweep");
    expect(failed.failures).toEqual([
      { tenant_id: "t1", scope: "business", error: "db nede" },
      { tenant_id: "t2", error: "annen feil" }
    ]);
    expect(failed.message).toBe("memory-retention-sweep: 2 tenant-feil (t1/business: db nede; t2: annen feil)");
  });

  it("meldingen viser maks 3 feil og teller resten (scheduleren lagrer kun de første 300 tegnene)", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ tenant_id: `t${i}`, error: "e" }));
    expect(() => assertNoSweepFailures("job", many)).toThrow("job: 5 tenant-feil (t0: e; t1: e; t2: e; +2 til)");
  });
});

describe("D-442: failOnSweepFailures", () => {
  it("kjører sveipet for ALLE tenants først og kaster først etterpå (isolasjonen er uendret)", async () => {
    const processed: string[] = [];
    const sweep = async (failures: SweepFailureCollector): Promise<void> => {
      for (const tenant of ["a", "b", "c"]) {
        try {
          if (tenant === "a") throw new Error("a feilet");
          processed.push(tenant);
        } catch (err) {
          failures.record(tenant, err);
        }
      }
    };
    await expect(failOnSweepFailures("demo", sweep)).rejects.toThrow("demo: 1 tenant-feil (a: a feilet)");
    expect(processed).toEqual(["b", "c"]);
  });

  it("ren kjøring kaster ikke", async () => {
    await expect(failOnSweepFailures("demo", async () => ({ ok: true }))).resolves.toBeUndefined();
  });

  it("et unntak fra selve sveipet (for eksempel tenant-oppslaget) går uendret videre", async () => {
    await expect(failOnSweepFailures("demo", async () => { throw new Error("enumerering feilet"); })).rejects.toThrow("enumerering feilet");
  });
});

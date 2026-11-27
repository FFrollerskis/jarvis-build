import { describe, expect, it } from "vitest";
import { backupCoverage } from "../src/evolution-source.ts";

/**
 * WP-OPS2a fiks-runde 1, K4 (review B-L4, B-L5 og testhullet for 5-minuttersgrensen): `backupCoverage` er en REN funksjon (kilde-lesing + klokke inn, dekning ut).
 *  - B-L4: `restore_verify.state = "not_configured"` betyr at restore-verifisering ikke er satt opp: oppgaven har INGEN utfører og er «ikke dekket» (med notat), ikke «dekket men forfalt for alltid».
 *  - B-L5: et tidspunkt som ikke er et tidspunkt (NaN) gir aldri «dekket og fersk» - det er «ikke dekket» med notat.
 *  - Klokketoleransen er nøyaktig 5 min: +300000 ms er dekket, +300001 ms er klokkeavvik.
 */
const NOW = new Date("2026-11-27T12:00:00.000Z");
const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
type Snap = { generated_at: string; restore_verify: { state: string; last_success_at: string | null } };
const snap = (over: Partial<Snap["restore_verify"]> & { generated_at?: string } = {}): Snap => ({
  generated_at: over.generated_at ?? at(-60_000), restore_verify: { state: over.state ?? "ok", last_success_at: over.last_success_at === undefined ? at(-3 * 86_400_000) : over.last_success_at }
});
const read = (s: Snap) => ({ ok: true, v: { kind: "ok", snapshot: s } }) as never;
const cover = (s: Snap) => backupCoverage(read(s), NOW);
const ids = (c: { covered: ReadonlySet<string> }): string[] => [...c.covered].sort();

describe("B-L4: restore_verify.state = not_configured er «ikke dekket» (ikke ATTENTION for alltid)", () => {
  it("not_configured: kun backup_status er dekket; restore har ingen last_run, og notatet sier at restore-verifisering ikke er satt opp", () => {
    const c = cover(snap({ state: "not_configured", last_success_at: null }));
    expect(ids(c)).toEqual(["backup_status"]);
    expect(Object.keys(c.last_run)).toEqual(["backup_status"]);
    expect(c.note).toBe("disaster_recovery_sample_restore er ikke vurdert: restore-verifisering er ikke satt opp (ingen utfører)");
  });

  it("not_configured gjelder også når en gammel vellykket restore-tid ligger i filen (ingen utfører nå): ikke dekket, og den gamle tiden brukes ikke", () => {
    const c = cover(snap({ state: "not_configured", last_success_at: at(-86_400_000) }));
    expect(ids(c)).toEqual(["backup_status"]);
    expect(c.last_run["disaster_recovery_sample_restore"]).toBeUndefined();
    expect(c.note).toContain("ikke satt opp");
  });

  it("de øvrige tilstandene er uendret: never_run (satt opp, aldri kjørt) = dekket uten last_run (forfalt, ærlig); failed uten suksess = det samme; ok = dekket med last_run", () => {
    const never = cover(snap({ state: "never_run", last_success_at: null }));
    expect(ids(never)).toEqual(["backup_status", "disaster_recovery_sample_restore"]);
    expect(never.last_run["disaster_recovery_sample_restore"]).toBeUndefined();
    expect(never.note).toBeNull();
    const failed = cover(snap({ state: "failed", last_success_at: null }));
    expect(ids(failed)).toEqual(["backup_status", "disaster_recovery_sample_restore"]);
    expect(failed.note).toBeNull();
    const ok = cover(snap({ state: "ok" }));
    expect(ids(ok)).toEqual(["backup_status", "disaster_recovery_sample_restore"]);
    expect(ok.last_run["disaster_recovery_sample_restore"]).toBe(at(-3 * 86_400_000));
    expect(ok.note).toBeNull();
  });
});

describe("B-L5: et tidspunkt som ikke er et tidspunkt gir aldri «dekket og fersk»", () => {
  it("ugyldig generated_at (tekst, tom, NaN, umulig dato): INGEN dekning, ingen last_run, og notatet sier ugyldig tidspunkt", () => {
    for (const bad of ["garbage", "", "NaN", "2026-13-45T99:99:99Z", "  "]) {
      const c = cover(snap({ generated_at: bad }));
      expect(c.covered.size, JSON.stringify(bad)).toBe(0);
      expect(c.last_run, JSON.stringify(bad)).toEqual({});
      expect(c.note, JSON.stringify(bad)).toContain("ugyldig tidspunkt");
      expect(c.note, JSON.stringify(bad)).not.toContain("garbage");
    }
  });

  it("ugyldig restore-tid: backup_status er dekket, restore er IKKE dekket (ikke fabrikkert fersk), og notatet sier ugyldig tidspunkt", () => {
    for (const bad of ["garbage", "", "NaN", "2026-13-01T00:00:00Z"]) {
      const c = cover(snap({ state: "ok", last_success_at: bad }));
      expect(ids(c), JSON.stringify(bad)).toEqual(["backup_status"]);
      expect(c.last_run["disaster_recovery_sample_restore"], JSON.stringify(bad)).toBeUndefined();
      expect(c.note, JSON.stringify(bad)).toContain("ugyldig tidspunkt");
      expect(c.note, JSON.stringify(bad)).not.toContain("garbage");
    }
  });
});

describe("manglende generated_at", () => {
  it("en snapshot uten generated_at gir ingen dekning og et eget notat («har ikke noe tidspunkt»), ikke «klokkeavvik» og ikke «ugyldig»", () => {
    const c = backupCoverage({ ok: true, v: { kind: "ok", snapshot: { restore_verify: { state: "ok", last_success_at: null } } } } as never, NOW);
    expect(c.covered.size).toBe(0);
    expect(c.last_run).toEqual({});
    expect(c.note).toContain("har ikke noe tidspunkt");
    expect(c.note).not.toContain("klokkeavvik");
  });
});

describe("klokketoleransen er nøyaktig 5 min (300000 ms): +300000 er dekket, +300001 er klokkeavvik", () => {
  it("generated_at: +300000 ms dekket (begge oppgaver), +300001 ms ikke dekket (klokkeavvik), -300001 ms (gammel) fortsatt dekket", () => {
    expect(ids(cover(snap({ generated_at: at(300_000) })))).toEqual(["backup_status", "disaster_recovery_sample_restore"]);
    const over = cover(snap({ generated_at: at(300_001) }));
    expect(over.covered.size).toBe(0);
    expect(over.note).toContain("klokkeavvik");
    expect(ids(cover(snap({ generated_at: at(-300_001) })))).toEqual(["backup_status", "disaster_recovery_sample_restore"]);
  });

  it("restore last_success_at: +300000 ms dekket med last_run, +300001 ms ikke dekket med klokkeavvik-notat (backup_status er fortsatt dekket)", () => {
    const edge = cover(snap({ state: "ok", last_success_at: at(300_000) }));
    expect(ids(edge)).toEqual(["backup_status", "disaster_recovery_sample_restore"]);
    expect(edge.last_run["disaster_recovery_sample_restore"]).toBe(at(300_000));
    const over = cover(snap({ state: "ok", last_success_at: at(300_001) }));
    expect(ids(over)).toEqual(["backup_status"]);
    expect(over.note).toContain("klokkeavvik");
  });

  it("toleransen er 5 min, ikke 50 min: 10 min og 50 min frem er klokkeavvik", () => {
    expect(cover(snap({ generated_at: at(10 * 60_000) })).covered.size).toBe(0);
    expect(cover(snap({ generated_at: at(50 * 60_000) })).covered.size).toBe(0);
    expect(ids(cover(snap({ generated_at: at(4 * 60_000) })))).toEqual(["backup_status", "disaster_recovery_sample_restore"]);
  });
});

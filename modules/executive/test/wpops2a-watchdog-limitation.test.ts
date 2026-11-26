import { describe, expect, it } from "vitest";
import { buildLimitationRegistry } from "../src/self-model/limitations.ts";

/**
 * WP-OPS2a K1: «jeg ser ikke watchdogens status» er bare sant uten registrerte tikk. Med `watchdogStateReadable` byttes begrensningen ut med en presis (samme id, så ingenting dupliseres) - akkurat som backup-begrensningen (WP-C2).
 * Uten leser står den gamle teksten uendret.
 */
const base = { forbiddenModelToolIds: [], connectors: [], modelProfiles: [], allModelCapabilities: [] };
const ID = "no_cross_process_watchdog_state";

describe("WP-OPS2a K1: begrensningsregisteret om watchdog", () => {
  it("uten leser (standard, også eksplisitt false): den opprinnelige påstanden står uendret", () => {
    for (const input of [base, { ...base, watchdogStateReadable: false }]) {
      const l = buildLimitationRegistry(input).filter((x) => x.id === ID);
      expect(l).toHaveLength(1);
      expect(l[0]?.statement).toBe("Watchdog kjører i en annen prosess (worker) og lagrer ikke siste resultat jeg kan lese - jeg ser ikke watchdogens status herfra.");
      expect(l[0]?.source_ref).toBe("modules/watchdog (worker-main.ts)");
    }
  });

  it("med leser: samme id, ny presis påstand (kun registrerte tikk; kan ikke starte den på nytt), og kilden peker på leseren", () => {
    const reg = buildLimitationRegistry({ ...base, watchdogStateReadable: true });
    const l = reg.filter((x) => x.id === ID);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ kind: "technical" });
    expect(l[0]?.statement).toContain("Jeg ser vakthunden kun slik dens tikk er registrert varig; jeg kan ikke starte den på nytt.");
    expect(l[0]?.statement).not.toContain("lagrer ikke siste resultat");
    expect(l[0]?.source_ref).toContain("apps/api/src/watchdog-status.ts");
    expect(new Set(reg.map((x) => x.id)).size).toBe(reg.length);
  });

  it("watchdog- og backup-bryterne er uavhengige: hver bytter kun sin egen begrensning, de øvrige håndskrevne er uendret", () => {
    const both = buildLimitationRegistry({ ...base, watchdogStateReadable: true, backupStatusReadable: true });
    const onlyWatchdog = buildLimitationRegistry({ ...base, watchdogStateReadable: true });
    const onlyBackup = buildLimitationRegistry({ ...base, backupStatusReadable: true });
    const none = buildLimitationRegistry(base);
    const statement = (reg: ReturnType<typeof buildLimitationRegistry>, id: string) => reg.find((x) => x.id === id)?.statement;
    expect(statement(onlyWatchdog, "no_backup_heartbeat")).toBe(statement(none, "no_backup_heartbeat"));
    expect(statement(onlyBackup, ID)).toBe(statement(none, ID));
    expect(statement(both, ID)).toBe(statement(onlyWatchdog, ID));
    expect(statement(both, "no_backup_heartbeat")).toBe(statement(onlyBackup, "no_backup_heartbeat"));
    expect(both.map((x) => x.id)).toEqual(none.map((x) => x.id)); // ingenting legges til eller fjernes, rekkefølgen er den samme
    expect(both.map((x) => x.id)).toEqual(expect.arrayContaining(["self_modification_frozen", "no_consciousness_claim", "no_own_authority_changes"]));
  });
});

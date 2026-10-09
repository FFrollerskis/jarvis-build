import { describe, expect, it } from "vitest";
import { buildLimitationRegistry } from "../src/self-model/limitations.ts";

/** WP-C2: «jeg ser ikke backup» er bare sant uten en montert statusfil. Med en lesbar statusfil byttes begrensningen ut med en presis (samme id, så ingenting dupliseres). */
const base = { forbiddenModelToolIds: [], connectors: [], modelProfiles: [], allModelCapabilities: [] };

describe("WP-C2: begrensningsregisteret om backup", () => {
  it("uten statusfil (standard) står den opprinnelige påstanden: ingen heartbeat jeg kan lese", () => {
    for (const input of [base, { ...base, backupStatusReadable: false }]) {
      const l = buildLimitationRegistry(input).filter((x) => x.id === "no_backup_heartbeat");
      expect(l).toHaveLength(1);
      expect(l[0]?.statement).toContain("ingen heartbeat jeg kan lese");
    }
  });

  it("med lesbar statusfil: samme id, ny presis påstand (kun det skriptet selv melder; kan ikke ta backup/restore), og kilden peker på skriptet", () => {
    const reg = buildLimitationRegistry({ ...base, backupStatusReadable: true });
    const l = reg.filter((x) => x.id === "no_backup_heartbeat");
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ kind: "technical" });
    expect(l[0]?.statement).toContain("kun slik backup-skriptet selv melder");
    expect(l[0]?.statement).toContain("kan ikke selv ta backup, kjøre en restore eller bevise at kopiene virker");
    expect(l[0]?.source_ref).toContain("ops/backup/schedule.mjs");
    expect(new Set(reg.map((x) => x.id)).size).toBe(reg.length);
    // de øvrige håndskrevne postene er uendret
    expect(reg.map((x) => x.id)).toEqual(expect.arrayContaining(["self_modification_frozen", "no_consciousness_claim", "no_own_authority_changes", "no_cross_process_watchdog_state"]));
  });
});

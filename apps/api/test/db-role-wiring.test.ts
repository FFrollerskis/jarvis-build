import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Q-21 (§10.F/G/H i BO-en): main.ts/worker-main.ts MÅ bruke RUNTIME-config
 * (configFromEnv), migrate-main.ts MÅ bruke ADMIN-config (adminConfigFromEnv).
 * `main.ts`/`worker-main.ts` er top-level side-effekt-skript (kobler til DB og
 * starter en server/lytter idet de importeres) - de kan derfor IKKE trygt
 * importeres direkte i en testfil uten å faktisk starte appen. Denne suiten
 * verifiserer wiringen som en tekst-/regresjonsvakt i stedet: en fremtidig
 * endring som ved et uhell bytter admin/runtime-config i feil fil, skal
 * feile HER - før det noensinne når en ekte host.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("§10.F: apps/api/src/main.ts bruker RUNTIME-config, aldri admin-config", () => {
  const source = readSource("../src/main.ts");

  it("importerer configFromEnv (runtime) for sin pool", () => {
    expect(source).toMatch(/createPool\(configFromEnv\(\)\)/);
  });

  it("importerer ALDRI adminConfigFromEnv", () => {
    expect(source).not.toMatch(/adminConfigFromEnv/);
  });

  it("kaller assertRuntimeCredentialsConfigured og assertRuntimeRoleSafe FØR appen starter normalt (fail-closed)", () => {
    expect(source).toMatch(/assertRuntimeCredentialsConfigured\(\)/);
    expect(source).toMatch(/assertRuntimeRoleSafe\(pool\)/);
  });
});

describe("§10.G: apps/api/src/worker-main.ts bruker RUNTIME-config, aldri admin-config", () => {
  const source = readSource("../src/worker-main.ts");

  it("importerer configFromEnv (runtime) for sin pool", () => {
    expect(source).toMatch(/createPool\(configFromEnv\(\)\)/);
  });

  it("importerer ALDRI adminConfigFromEnv", () => {
    expect(source).not.toMatch(/adminConfigFromEnv/);
  });

  it("kaller assertRuntimeCredentialsConfigured og assertRuntimeRoleSafe FØR jobber prosesseres (fail-closed)", () => {
    expect(source).toMatch(/assertRuntimeCredentialsConfigured\(\)/);
    expect(source).toMatch(/assertRuntimeRoleSafe\(pool\)/);
  });
});

describe("§10.H: apps/api/src/migrate-main.ts bruker ADMIN-config, aldri stille runtime-config for egen tilkobling", () => {
  const source = readSource("../src/migrate-main.ts");

  it("bruker adminConfigFromEnv for sin egen pool (migrasjoner/bootstrap krever admin-privilegier)", () => {
    // Q-21 host-recovery #2: adminConfigFromEnv() sitt resultat caches nå i en
    // variabel (resolvedAdminConfig) FØR createPool - trengs for å kunne logge
    // migrate_effective_db_user FØR runMigrations, uten å kalle adminConfigFromEnv()
    // to ganger. Sjekker derfor at BEGGE fortsatt kobles direkte til hverandre,
    // ikke den eksakte inline-syntaksen.
    expect(source).toMatch(/adminConfigFromEnv\(\)/);
    expect(source).toMatch(/createPool\(resolvedAdminConfig\)/);
  });

  it("bootstrapper runtime-rollen via ensureRuntimeRole (samme admin-tilkobling)", () => {
    expect(source).toMatch(/ensureRuntimeRole\(adminPool/);
  });
});

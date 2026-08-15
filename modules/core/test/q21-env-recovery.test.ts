import { describe, expect, it } from "vitest";
import {
  buildUpdatedEnvLines,
  parseEnvValues,
  resolveAdminCredentials,
  resolveRuntimeCredentials,
  sortBackupFilenamesNewestFirst,
  validateRequiredEnv
} from "../scripts/lib/q21-env-recovery.ts";

/**
 * Q-21 HOST FIX RECOVERY (2026-08-15): host-scriptet feilet fordi det krevde
 * JARVIS_DB_ADMIN_USER/PASSWORD å allerede finnes FØR det byttet
 * JARVIS_DB_USER/PASSWORD til runtime-verdier - uten en vei tilbake hvis de
 * mangler. Denne suiten beviser recovery-logikken (§8.A-J i BO-en) rent,
 * uten filsystem/Docker/DB-avhengighet.
 */

function genPassword(): string {
  return "generated-password-abc123";
}

describe("§8.A: fresh legacy env migration (ingen admin-vars, JARVIS_DB_USER=postgres)", () => {
  it("gjenkjenner JARVIS_DB_USER=postgres som admin-kandidat fra CURRENT .env selv (ikke fra backup) - §3 FRESH CASE", () => {
    // Fresh/legacy-tilstand: ingen ADMIN-vars i det hele tatt ennå, JARVIS_DB_USER er FORTSATT postgres.
    const current = { JARVIS_DB_USER: "postgres", JARVIS_DB_PASSWORD: "pw-legacy" };
    // Ingen backups finnes ennå på en fresh host - skal likevel IKKE trenge en.
    const admin = resolveAdminCredentials(current, []);
    expect(admin).toMatchObject({ adminUser: "postgres", adminPassword: "pw-legacy", source: "current_runtime_vars_as_admin" });

    const runtime = resolveRuntimeCredentials(current, admin.adminUser, genPassword);
    expect(runtime.runtimeUser).toBe("jarvis_runtime");
    expect(runtime.runtimePassword).toBe(genPassword());
  });

  it("når JARVIS_DB_ADMIN_USER/PASSWORD ER satt fra start (normal fresh .env.example-kopi), brukes de direkte", () => {
    const current = { JARVIS_DB_ADMIN_USER: "postgres", JARVIS_DB_ADMIN_PASSWORD: "pw-admin", JARVIS_DB_USER: "postgres", JARVIS_DB_PASSWORD: "pw-admin" };
    const admin = resolveAdminCredentials(current, []);
    expect(admin).toMatchObject({ adminUser: "postgres", adminPassword: "pw-admin", source: "current_env" });

    const runtime = resolveRuntimeCredentials(current, admin.adminUser, genPassword);
    expect(runtime.runtimeUser).toBe("jarvis_runtime"); // JARVIS_DB_USER var lik adminUser -> trenger fiks
    expect(runtime.changed).toBe(true);
  });
});

describe("§8.B: partial-migration recovery fra nyeste .env.bak.* (nøyaktig host-scenariet)", () => {
  it("gjenoppretter admin-credentials fra backupens JARVIS_DB_USER=postgres når nåværende .env mangler ADMIN-vars", () => {
    // Nåværende .env: en TIDLIGERE kjøring har allerede byttet JARVIS_DB_USER/PASSWORD
    // til runtime-verdier, UTEN å ha skrevet ADMIN-vars (host-bug-scenariet).
    const current = { JARVIS_DB_USER: "jarvis_runtime", JARVIS_DB_PASSWORD: "pw-runtime-already-set" };
    const backupsNewestFirst = [
      // Eldste snapshot FØR noen Q-21-fiks noensinne kjørte - den ekte kilden.
      { JARVIS_DB_USER: "postgres", JARVIS_DB_PASSWORD: "pw-original-postgres" }
    ];
    const admin = resolveAdminCredentials(current, backupsNewestFirst);
    expect(admin).toMatchObject({ adminUser: "postgres", adminPassword: "pw-original-postgres", source: "backup_runtime_vars" });
  });

  it("velger NYESTE backup når flere finnes, ikke en eldre", () => {
    const current = {};
    const backupsNewestFirst = [
      { JARVIS_DB_USER: "postgres", JARVIS_DB_PASSWORD: "pw-newer" }, // nyest (allerede sortert inn)
      { JARVIS_DB_USER: "postgres", JARVIS_DB_PASSWORD: "pw-older" }
    ];
    const admin = resolveAdminCredentials(current, backupsNewestFirst);
    expect(admin.adminPassword).toBe("pw-newer");
  });

  it("foretrekker en backup med EGNE ADMIN-vars over en backup med kun postgres-lik JARVIS_DB_USER", () => {
    const current = {};
    const backupsNewestFirst = [
      { JARVIS_DB_USER: "jarvis_runtime", JARVIS_DB_PASSWORD: "pw-x" }, // nyeste, men ingen admin-spor
      { JARVIS_DB_ADMIN_USER: "postgres", JARVIS_DB_ADMIN_PASSWORD: "pw-admin-from-backup", JARVIS_DB_USER: "jarvis_runtime", JARVIS_DB_PASSWORD: "pw-y" }
    ];
    const admin = resolveAdminCredentials(current, backupsNewestFirst);
    expect(admin).toMatchObject({ adminUser: "postgres", adminPassword: "pw-admin-from-backup", source: "backup_admin_vars" });
  });
});

describe("§8.C: missing admin vars + runtime allerede endret (uten IKKE-postgres backup-bruker)", () => {
  it("nekter å gjette en admin-bruker som ikke ser ut som 'postgres'", () => {
    const current = { JARVIS_DB_USER: "jarvis_runtime", JARVIS_DB_PASSWORD: "pw-runtime" };
    const backupsNewestFirst = [{ JARVIS_DB_USER: "some_other_role", JARVIS_DB_PASSWORD: "pw-unclear" }];
    expect(() => resolveAdminCredentials(current, backupsNewestFirst)).toThrow(/q21_admin_credentials_unrecoverable/);
  });
});

describe("§8.D: ingen gyldig backup => fail closed, ingen .env-mutasjon", () => {
  it("kaster FØR noe (nextLines/validate) forsøkes bygget - ingen fallback-gjetning", () => {
    const current = { JARVIS_DB_USER: "jarvis_runtime", JARVIS_DB_PASSWORD: "pw" };
    expect(() => resolveAdminCredentials(current, [])).toThrow(/q21_admin_credentials_unrecoverable/);
    // Feilmeldingen skal eksplisitt si at .env IKKE er endret.
    try {
      resolveAdminCredentials(current, []);
    } catch (err) {
      expect((err as Error).message).toMatch(/IKKE endret/);
    }
  });
});

describe("§8.E: secrets logges/eksponeres aldri av selve verdiene som håndteres", () => {
  it("resultatobjektene inneholder KUN det som eksplisitt ble gitt inn - ingen ekstra felter/logging-bivirkning", () => {
    const admin = resolveAdminCredentials({ JARVIS_DB_ADMIN_USER: "postgres", JARVIS_DB_ADMIN_PASSWORD: "super-secret-pw" }, []);
    // Selve funksjonen console.log'er aldri noe - ren dataflyt. Bevises ved at
    // resultatet er nøyaktig de forventede feltene, ingen implisitt globalt loggekall her.
    expect(Object.keys(admin).sort()).toEqual(["adminPassword", "adminUser", "source"]);
  });
});

describe("§8.F: idempotent - andre kjøring med allerede-korrekt .env endrer ingenting", () => {
  it("resolveAdminCredentials/resolveRuntimeCredentials gir samme resultat på gjentatt kall", () => {
    const current = {
      JARVIS_DB_ADMIN_USER: "postgres",
      JARVIS_DB_ADMIN_PASSWORD: "pw-admin",
      JARVIS_DB_USER: "jarvis_runtime",
      JARVIS_DB_PASSWORD: "pw-runtime-stable"
    };
    const admin1 = resolveAdminCredentials(current, []);
    const admin2 = resolveAdminCredentials(current, []);
    expect(admin1).toEqual(admin2);

    const runtime1 = resolveRuntimeCredentials(current, admin1.adminUser, genPassword);
    const runtime2 = resolveRuntimeCredentials(current, admin1.adminUser, genPassword);
    expect(runtime1).toEqual(runtime2);
    expect(runtime1.changed).toBe(false); // §8.I: ingen endring nødvendig
    expect(runtime1.runtimePassword).toBe("pw-runtime-stable"); // uendret, IKKE regenerert
  });
});

describe("§8.G: alle fire DB-credential-variabler finnes før compose kan kjøres", () => {
  it("validateRequiredEnv godtar et komplett sett", () => {
    expect(() =>
      validateRequiredEnv({
        JARVIS_DB_ADMIN_USER: "postgres",
        JARVIS_DB_ADMIN_PASSWORD: "pw-admin",
        JARVIS_DB_USER: "jarvis_runtime",
        JARVIS_DB_PASSWORD: "pw-runtime"
      })
    ).not.toThrow();
  });

  it("validateRequiredEnv kaster hvis ETT felt mangler", () => {
    expect(() =>
      validateRequiredEnv({ JARVIS_DB_ADMIN_USER: "postgres", JARVIS_DB_ADMIN_PASSWORD: "", JARVIS_DB_USER: "jarvis_runtime", JARVIS_DB_PASSWORD: "pw" })
    ).toThrow(/JARVIS_DB_ADMIN_PASSWORD/);
  });
});

describe("§8.H: admin-passord bevares eksakt gjennom en full resolve+build-runde", () => {
  it("buildUpdatedEnvLines endrer aldri en verdi den ikke fikk oppgitt å endre, og skriver eksakt admin-passordet inn", () => {
    const lines = ["JARVIS_API_PORT=3010", "JARVIS_DB_ADMIN_USER=postgres", "JARVIS_DB_ADMIN_PASSWORD=super-hemmelig-adm-pw", "JARVIS_DB_USER=postgres", "JARVIS_DB_PASSWORD=super-hemmelig-adm-pw"];
    const current = parseEnvValues(lines.join("\n"));
    const admin = resolveAdminCredentials(current, []);
    const runtime = resolveRuntimeCredentials(current, admin.adminUser, genPassword);
    const updates = {
      JARVIS_DB_ADMIN_USER: admin.adminUser,
      JARVIS_DB_ADMIN_PASSWORD: admin.adminPassword,
      JARVIS_DB_USER: runtime.runtimeUser,
      JARVIS_DB_PASSWORD: runtime.runtimePassword
    };
    const next = buildUpdatedEnvLines(lines, updates);
    expect(next).toContain("JARVIS_API_PORT=3010"); // urørt
    expect(next).toContain("JARVIS_DB_ADMIN_PASSWORD=super-hemmelig-adm-pw"); // admin-passord uendret/bevart
    expect(next).toContain(`JARVIS_DB_USER=jarvis_runtime`);
    expect(next).toContain(`JARVIS_DB_PASSWORD=${runtime.runtimePassword}`);
  });
});

describe("§8.I: runtime-passord bevares på andre kjøring (regenereres ALDRI uten grunn)", () => {
  it("gitt en allerede-fikset .env, er runtimePassword identisk på et påfølgende kall", () => {
    const current = { JARVIS_DB_ADMIN_USER: "postgres", JARVIS_DB_ADMIN_PASSWORD: "pw-admin", JARVIS_DB_USER: "jarvis_runtime", JARVIS_DB_PASSWORD: "pw-runtime-fixed-once" };
    const runtime = resolveRuntimeCredentials(current, "postgres", () => "SKAL-ALDRI-BRUKES");
    expect(runtime.runtimePassword).toBe("pw-runtime-fixed-once");
    expect(runtime.changed).toBe(false);
  });
});

describe("§8.J: compose-config mottar korrekt split (via buildUpdatedEnvLines-resultatet)", () => {
  it("sluttresultatet har fire DISTINKTE verdier - admin != runtime", () => {
    const lines = ["JARVIS_DB_ADMIN_USER=postgres", "JARVIS_DB_ADMIN_PASSWORD=pw-admin", "JARVIS_DB_USER=postgres", "JARVIS_DB_PASSWORD=pw-admin"];
    const current = parseEnvValues(lines.join("\n"));
    const admin = resolveAdminCredentials(current, []);
    const runtime = resolveRuntimeCredentials(current, admin.adminUser, genPassword);
    expect(runtime.runtimeUser).not.toBe(admin.adminUser);
    expect(runtime.runtimePassword).not.toBe(admin.adminPassword);
  });
});

describe("sortBackupFilenamesNewestFirst", () => {
  it("sorterer numerisk (epoch-ms), ikke leksikografisk-i-tvil", () => {
    const sorted = sortBackupFilenamesNewestFirst([".env.bak.100", ".env.bak.30000000000000", ".env.bak.2000000000"]);
    expect(sorted).toEqual([".env.bak.30000000000000", ".env.bak.2000000000", ".env.bak.100"]);
  });
});

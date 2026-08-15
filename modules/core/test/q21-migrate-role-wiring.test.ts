import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adminConfigFromEnv, configFromEnv } from "../src/db/pool.ts";
import {
  buildMigrateRunArgs,
  MIGRATE_ADMIN_ENV_KEYS,
  resolveAdminCredentials,
  resolveRuntimeCredentials
} from "../scripts/lib/q21-env-recovery.ts";

/**
 * Q-21 HOST RECOVERY #2 (2026-08-15): migrate autentiserte som `jarvis_runtime`
 * mot Postgres til tross for at `.env` hadde `JARVIS_DB_ADMIN_USER=postgres`
 * korrekt satt (bekreftet av host-scriptets egen log). Denne suiten beviser
 * §9.A-J i BO-en: migrate/api/worker sin rolle-wiring, at admin-credentials nå
 * sendes eksplisitt (ikke via tvetydig .env/env_file-oppløsning) til migrate,
 * riktig operasjonsrekkefølge, idempotens, og at ingen secrets eksponeres.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("§9.A: migrate effective role er ADMIN", () => {
  it("migrate-main.ts skriver migrate_effective_db_user FØR runMigrations, fra adminConfigFromEnv()", () => {
    const source = readSource("../../../apps/api/src/migrate-main.ts");
    const diagIdx = source.indexOf("migrate_effective_db_user");
    const runMigrationsIdx = source.indexOf("await runMigrations(adminPool)");
    expect(diagIdx).toBeGreaterThan(-1);
    expect(runMigrationsIdx).toBeGreaterThan(-1);
    expect(diagIdx).toBeLessThan(runMigrationsIdx);
    expect(source).toMatch(/const resolvedAdminConfig = adminConfigFromEnv\(\)/);
    expect(source).toMatch(/createPool\(resolvedAdminConfig\)/);
  });

  it("expected: migrate_effective_db_user=postgres når JARVIS_DB_ADMIN_USER er default/uendret", () => {
    const cfg = adminConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(cfg.user).toBe("postgres");
  });
});

describe("§9.B/§9.C: api/worker effective role er RUNTIME", () => {
  it("main.ts bruker configFromEnv, aldri adminConfigFromEnv", () => {
    const source = readSource("../../../apps/api/src/main.ts");
    expect(source).toMatch(/createPool\(configFromEnv\(\)\)/);
    expect(source).not.toMatch(/adminConfigFromEnv/);
  });

  it("worker-main.ts bruker configFromEnv, aldri adminConfigFromEnv", () => {
    const source = readSource("../../../apps/api/src/worker-main.ts");
    expect(source).toMatch(/createPool\(configFromEnv\(\)\)/);
    expect(source).not.toMatch(/adminConfigFromEnv/);
  });
});

describe("§9.D/§9.E: admin/runtime config kan ikke resolve hverandres variabler", () => {
  it("adminConfigFromEnv ignorerer JARVIS_DB_USER/PASSWORD helt - faller til default, aldri runtime-verdien", () => {
    const cfg = adminConfigFromEnv({ JARVIS_DB_USER: "jarvis_runtime", JARVIS_DB_PASSWORD: "pw-runtime-only" } as NodeJS.ProcessEnv);
    expect(cfg.user).toBe("postgres");
    expect(cfg.password).toBeUndefined();
  });

  it("configFromEnv ignorerer JARVIS_DB_ADMIN_USER/PASSWORD helt - faller til default, aldri admin-verdien", () => {
    const cfg = configFromEnv({ JARVIS_DB_ADMIN_USER: "postgres", JARVIS_DB_ADMIN_PASSWORD: "pw-admin-only" } as NodeJS.ProcessEnv);
    expect(cfg.user).toBe("jarvis_runtime");
    expect(cfg.password).toBeUndefined();
  });
});

describe("§9.F: docker-compose sin migrate-tjeneste er wired til ADMIN-vars via env_file, ingen runtime-override", () => {
  it("migrate-blokken setter aldri JARVIS_DB_USER/PASSWORD eksplisitt (ville skygget for env_file/admin-config)", () => {
    const compose = readSource("../../../infra/local/docker-compose.yml");
    const lines = compose.split("\n");
    const startIdx = lines.findIndex((l) => /^\s*migrate:\s*$/.test(l));
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = lines.findIndex((l, i) => i > startIdx && /^ {2}\S/.test(l));
    const migrateBlock = lines.slice(startIdx, endIdx === -1 ? undefined : endIdx).join("\n");
    expect(migrateBlock).toMatch(/env_file:\s*\["\.\.\/\.\.\/\.env"\]/);
    expect(migrateBlock).not.toMatch(/JARVIS_DB_USER:/);
    expect(migrateBlock).not.toMatch(/JARVIS_DB_PASSWORD:/);
  });
});

describe("§9.G: partial host rerun (host-feilens eksakte scenario) er idempotent", () => {
  it("gir identisk admin/runtime-resultat på gjentatt kall når .env allerede er korrekt", () => {
    const current = {
      JARVIS_DB_ADMIN_USER: "postgres",
      JARVIS_DB_ADMIN_PASSWORD: "pw-admin-stable",
      JARVIS_DB_USER: "jarvis_runtime",
      JARVIS_DB_PASSWORD: "pw-runtime-stable"
    };
    const admin1 = resolveAdminCredentials(current, []);
    const admin2 = resolveAdminCredentials(current, []);
    expect(admin1).toEqual(admin2);
    const runtime1 = resolveRuntimeCredentials(current, admin1.adminUser, () => "SKAL-ALDRI-BRUKES");
    const runtime2 = resolveRuntimeCredentials(current, admin1.adminUser, () => "SKAL-ALDRI-BRUKES");
    expect(runtime1).toEqual(runtime2);
    expect(runtime1.changed).toBe(false);
  });
});

describe("§9.H/§9.J: full operasjonsrekkefølge i fix-q21-runtime-role.ts er korrekt", () => {
  const source = readSource("../scripts/fix-q21-runtime-role.ts");

  it("admin-tilkoblings-precheck skjer FØR migrate kjøres, som skjer FØR runtime-verifikasjon", () => {
    const adminPrecheckIdx = source.indexOf("admin_connection=PASS");
    const migrateRunIdx = source.indexOf("buildMigrateRunArgs(composeArgs)");
    const runtimeCheckIdx = source.indexOf("runtime_connection=");
    expect(adminPrecheckIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(runtimeCheckIdx).toBeGreaterThan(-1);
    expect(adminPrecheckIdx).toBeLessThan(migrateRunIdx); // §9.H: admin bevist FØR migrate (som setter runtime-passordet)
    expect(migrateRunIdx).toBeLessThan(runtimeCheckIdx); // runtime-passordet er satt (migrate kjørt) FØR vi prøver å autentisere som det
  });

  it("full rekkefølge: .env-resolve → validering → postgres opp → admin-precheck → migrate → api/worker restart → runtime-verifikasjon → ua2-p0-live.ts", () => {
    const idx = (needle: string) => source.indexOf(needle);
    const order = [
      idx("resolveAdminCredentials("),
      idx("resolveRuntimeCredentials("),
      idx("validateRequiredEnv("),
      idx('"up", "-d", "postgres"'),
      idx("admin_connection=PASS"),
      idx("buildMigrateRunArgs(composeArgs)"),
      idx('"--force-recreate", "api", "worker"'),
      idx("runtime_connection="),
      idx("ua2-p0-live.ts")
    ];
    expect(order.every((i) => i > -1)).toBe(true);
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!).toBeGreaterThan(order[i - 1]!);
    }
  });
});

describe("§9.I: safe diagnostics - migrate-credential-passing eksponerer aldri passordverdier", () => {
  it("buildMigrateRunArgs returnerer KUN nøkkelnavn (bar '-e VARNAME'-form), aldri en verdi", () => {
    const args = buildMigrateRunArgs(["compose", "--env-file", "/repo/.env", "-f", "/repo/compose.yml"]);
    expect(args).toEqual([
      "compose",
      "--env-file",
      "/repo/.env",
      "-f",
      "/repo/compose.yml",
      "run",
      "--rm",
      "-e",
      "JARVIS_DB_ADMIN_USER",
      "-e",
      "JARVIS_DB_ADMIN_PASSWORD",
      "migrate"
    ]);
    // Ingen del av args-arrayet inneholder et "=" (som ville indikert en KEY=VALUE-form
    // der en verdi kunne lekket) - kun bare nøkkelnavn.
    expect(args.some((a) => a.includes("="))).toBe(false);
  });

  it("MIGRATE_ADMIN_ENV_KEYS er nøyaktig de to admin-nøklene, ingen andre/uventede felt", () => {
    expect(MIGRATE_ADMIN_ENV_KEYS).toEqual(["JARVIS_DB_ADMIN_USER", "JARVIS_DB_ADMIN_PASSWORD"]);
  });

  it("fix-q21-runtime-role.ts logger aldri en passordverdi direkte - kun via extraEnv, aldri i loggede args", () => {
    const source = readSource("../scripts/fix-q21-runtime-role.ts");
    // run()-funksjonen logger KUN args, aldri extraEnv - passordene når aldri log()/console.
    expect(source).toMatch(/log\(`\$ docker \$\{args\.join\(" "\)\}`\)/);
    expect(source).not.toMatch(/log\([^)]*adminPassword[^)]*\)/);
    expect(source).not.toMatch(/log\([^)]*runtimePassword[^)]*\)/);
  });
});

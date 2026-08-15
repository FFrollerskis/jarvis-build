import { describe, expect, it } from "vitest";
import { adminConfigFromEnv, configFromEnv } from "../src/db/pool.ts";
import { assertRuntimeCredentialsConfigured } from "../src/services/runtime-role.ts";

/**
 * Q-21 (§10.E/H/I i BO-en): admin/runtime-config må forbli to DISTINKTE
 * lesere av to DISTINKTE variabelsett - ingen fallback som stille lar
 * runtime-config lese admin-variabler eller omvendt.
 */
describe("§10.E: configFromEnv() leser RUNTIME-variabler (JARVIS_DB_USER/PASSWORD)", () => {
  it("bruker JARVIS_DB_USER/PASSWORD når satt", () => {
    const cfg = configFromEnv({ JARVIS_DB_USER: "jarvis_runtime", JARVIS_DB_PASSWORD: "pw-runtime" } as NodeJS.ProcessEnv);
    expect(cfg.user).toBe("jarvis_runtime");
    expect(cfg.password).toBe("pw-runtime");
  });

  it("default-brukeren er en ekte bootstrappbar LOGIN-rolle (jarvis_runtime), IKKE jarvis_app-gruppe-rollen", () => {
    const cfg = configFromEnv({} as NodeJS.ProcessEnv);
    expect(cfg.user).toBe("jarvis_runtime");
    expect(cfg.user).not.toBe("jarvis_app");
  });

  it("leser ALDRI JARVIS_DB_ADMIN_USER/PASSWORD selv om de er satt", () => {
    const cfg = configFromEnv({
      JARVIS_DB_USER: "jarvis_runtime",
      JARVIS_DB_PASSWORD: "pw-runtime",
      JARVIS_DB_ADMIN_USER: "postgres",
      JARVIS_DB_ADMIN_PASSWORD: "pw-admin"
    } as NodeJS.ProcessEnv);
    expect(cfg.user).toBe("jarvis_runtime");
    expect(cfg.password).toBe("pw-runtime");
  });
});

describe("§10.H: adminConfigFromEnv() leser ADMIN-variabler (JARVIS_DB_ADMIN_USER/PASSWORD)", () => {
  it("bruker JARVIS_DB_ADMIN_USER/PASSWORD når satt", () => {
    const cfg = adminConfigFromEnv({ JARVIS_DB_ADMIN_USER: "postgres", JARVIS_DB_ADMIN_PASSWORD: "pw-admin" } as NodeJS.ProcessEnv);
    expect(cfg.user).toBe("postgres");
    expect(cfg.password).toBe("pw-admin");
  });

  it("leser ALDRI JARVIS_DB_USER/PASSWORD selv om de er satt", () => {
    const cfg = adminConfigFromEnv({
      JARVIS_DB_USER: "jarvis_runtime",
      JARVIS_DB_PASSWORD: "pw-runtime",
      JARVIS_DB_ADMIN_USER: "postgres",
      JARVIS_DB_ADMIN_PASSWORD: "pw-admin"
    } as NodeJS.ProcessEnv);
    expect(cfg.user).toBe("postgres");
    expect(cfg.password).toBe("pw-admin");
  });
});

describe("§10.I: assertRuntimeCredentialsConfigured() fail-closed", () => {
  it("kaster hvis JARVIS_DB_USER mangler", () => {
    expect(() => assertRuntimeCredentialsConfigured({ JARVIS_DB_PASSWORD: "pw" } as NodeJS.ProcessEnv)).toThrow(
      /jarvis_db_user_missing/
    );
  });

  it("kaster hvis JARVIS_DB_PASSWORD mangler", () => {
    expect(() => assertRuntimeCredentialsConfigured({ JARVIS_DB_USER: "jarvis_runtime" } as NodeJS.ProcessEnv)).toThrow(
      /jarvis_db_password_missing/
    );
  });

  it("kaster hvis JARVIS_DB_USER er identisk med JARVIS_DB_ADMIN_USER (nøyaktig host-blocker-scenariet)", () => {
    expect(() =>
      assertRuntimeCredentialsConfigured({
        JARVIS_DB_USER: "postgres",
        JARVIS_DB_PASSWORD: "pw",
        JARVIS_DB_ADMIN_USER: "postgres",
        JARVIS_DB_ADMIN_PASSWORD: "pw"
      } as NodeJS.ProcessEnv)
    ).toThrow(/jarvis_db_user_equals_admin/);
  });

  it("kaster hvis JARVIS_DB_USER er jarvis_app (NOLOGIN gruppe-rolle)", () => {
    expect(() =>
      assertRuntimeCredentialsConfigured({ JARVIS_DB_USER: "jarvis_app", JARVIS_DB_PASSWORD: "pw" } as NodeJS.ProcessEnv)
    ).toThrow(/jarvis_db_user_is_group_role/);
  });

  it("OK for en korrekt distinkt runtime-konfigurasjon", () => {
    expect(() =>
      assertRuntimeCredentialsConfigured({
        JARVIS_DB_USER: "jarvis_runtime",
        JARVIS_DB_PASSWORD: "pw-runtime",
        JARVIS_DB_ADMIN_USER: "postgres",
        JARVIS_DB_ADMIN_PASSWORD: "pw-admin"
      } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });
});

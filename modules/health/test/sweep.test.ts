import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthService } from "../src/service.ts";
import { runHealthRetentionSweepForAllTenants } from "../src/sweep.ts";

/**
 * Arkitekt-review (D-130, PR #79): "gjør tilsvarende failure-observability
 * for health sweep dersom den fortsatt svelger alle tenant-feil" - den
 * opprinnelige `runHealthRetentionSweepForAllTenants()` hadde en tom
 * `catch {}` som satte `purgedByTenant[tenantId] = 0` for BÅDE "0 rader å
 * slette" OG "purge feilet" - identisk, ikke-skillbart resultat, ALDRI
 * logget. Denne testen beviser den rettede versjonen: strukturert
 * `succeeded`/`purgedByTenant`/`failed`-oppsummering, en `console.error`-
 * logglinje per feilet tenant, OG at per-tenant-isolasjonen (én tenants
 * feil velter aldri resten) forblir uendret. Rent enhets-nivaa-bevis (ingen
 * embedded Postgres nødvendig - ren orkestrerings-/feilisolasjonslogikk,
 * samme mønster som `modules/growth/test/action-recommendation-sweep.test.ts`).
 */
function fakePool(tenantRows: Array<{ tenant_id: string }>): pg.Pool {
  return { query: async () => ({ rows: tenantRows }) } as unknown as pg.Pool;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("A: happy-path - succeeded/purgedByTenant reflekterer faktisk purget antall per tenant, failed er tom", () => {
  it("kaller purgeExpiredObservations(tenantId) for hver tenant og samler antallet", async () => {
    const calls: string[] = [];
    const health = {
      purgeExpiredObservations: async (tenantId: string) => {
        calls.push(tenantId);
        return tenantId === "t-1" ? 3 : 0;
      }
    } as unknown as HealthService;
    const result = await runHealthRetentionSweepForAllTenants(fakePool([{ tenant_id: "t-1" }, { tenant_id: "t-2" }]), health);
    expect(calls).toEqual(["t-1", "t-2"]);
    expect(result.succeeded).toBe(2);
    expect(result.purgedByTenant).toEqual({ "t-1": 3, "t-2": 0 });
    expect(result.failed).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("B: feilisolasjon OG observability - én tenant sin purge-feil velter ALDRI resten, MEN forsvinner ALDRI stille", () => {
  it("en tenant som kaster feil havner i failed[] MED feilmelding, oevrige tenants sitt resultat er upaavirket", async () => {
    const health = {
      purgeExpiredObservations: async (tenantId: string) => {
        if (tenantId === "t-boom") throw new Error("simulert databasefeil");
        return 5;
      }
    } as unknown as HealthService;
    const result = await runHealthRetentionSweepForAllTenants(
      fakePool([{ tenant_id: "t-ok-1" }, { tenant_id: "t-boom" }, { tenant_id: "t-ok-2" }]),
      health
    );
    expect(result.succeeded).toBe(2);
    expect(result.purgedByTenant).toEqual({ "t-ok-1": 5, "t-ok-2": 5 });
    expect(result.purgedByTenant["t-boom"]).toBeUndefined();
    expect(result.failed).toEqual([{ tenant_id: "t-boom", error: "simulert databasefeil" }]);
  });

  it("logger EN strukturert console.error-linje ('health_retention_purge_failed') for den feilede tenanten, ingen linje for de vellykkede", async () => {
    const health = {
      purgeExpiredObservations: async (tenantId: string) => {
        if (tenantId === "t-boom") throw new Error("simulert databasefeil");
        return 0;
      }
    } as unknown as HealthService;
    await runHealthRetentionSweepForAllTenants(fakePool([{ tenant_id: "t-ok" }, { tenant_id: "t-boom" }]), health);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse((errorSpy.mock.calls[0] as unknown[])[0] as string) as Record<string, unknown>;
    expect(logged["msg"]).toBe("health_retention_purge_failed");
    expect(logged["tenant_id"]).toBe("t-boom");
    expect(logged["error"]).toBe("simulert databasefeil");
  });

  it("en ikke-Error-kastet verdi (f.eks. en streng) haandteres ogsaa trygt, uten aa kaste videre fra sveipet selv", async () => {
    const health = {
      purgeExpiredObservations: async (tenantId: string) => {
        if (tenantId === "t-weird") throw "not an Error instance";
        return 0;
      }
    } as unknown as HealthService;
    const result = await runHealthRetentionSweepForAllTenants(fakePool([{ tenant_id: "t-weird" }]), health);
    expect(result.failed).toEqual([{ tenant_id: "t-weird", error: "not an Error instance" }]);
  });
});

describe("C: bounded - kaller listAllTenantIds sin katalogfunksjon med en bounded limit (D-130, 052_tenant_catalog_all.sql)", () => {
  it("kaller jarvis_list_all_tenant_ids($1) med limit=200 - ALDRI en rå spoerring mot tenants", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [] };
      }
    } as unknown as pg.Pool;
    const health = { purgeExpiredObservations: async () => 0 } as unknown as HealthService;
    await runHealthRetentionSweepForAllTenants(pool, health);
    expect(capturedSql).toMatch(/jarvis_list_all_tenant_ids/);
    expect(capturedSql).not.toMatch(/FROM\s+tenants\b/i);
    expect(capturedParams).toEqual([200]);
  });
});

describe("D: tomt tenant-sett gir et tomt, gyldig resultat - ingen feil", () => {
  it("ingen tenants => succeeded=0, purgedByTenant={}, failed=[]", async () => {
    const health = { purgeExpiredObservations: async () => 0 } as unknown as HealthService;
    const result = await runHealthRetentionSweepForAllTenants(fakePool([]), health);
    expect(result).toEqual({ succeeded: 0, purgedByTenant: {}, failed: [] });
  });
});

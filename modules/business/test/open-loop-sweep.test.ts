import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { OpenLoopService } from "../src/open-loop-service.ts";
import { runOpenLoopSweepForAllTenants } from "../src/open-loop-sweep.ts";

/**
 * UA-3 next slice (D-53) §19/§20: rent enhets-nivaa-bevis for sveip-hjelperen
 * som `DailyScheduler` kaller (ingen embedded Postgres noedvendig her - dette
 * er ren orkestrerings-/feilisolasjonslogikk over en injisert pool/service).
 */
function fakePool(tenantRows: Array<{ tenant_id: string }>): pg.Pool {
  return { query: async () => ({ rows: tenantRows }) } as unknown as pg.Pool;
}

describe("A: tenant-scoped - sveiper KUN business-tenants fra spoerringen, en per tenant_id", () => {
  it("kaller runSweep(tenantId, 'business') for hver rad spoerringen returnerer", async () => {
    const calls: string[] = [];
    const openLoops = {
      runSweep: async (tenantId: string) => {
        calls.push(tenantId);
        return { detected: 1, updated: 0, auto_resolved: 0 };
      }
    } as unknown as OpenLoopService;
    const results = await runOpenLoopSweepForAllTenants(fakePool([{ tenant_id: "t-1" }, { tenant_id: "t-2" }]), openLoops);
    expect(calls).toEqual(["t-1", "t-2"]);
    expect(results["t-1"]).toEqual({ detected: 1, updated: 0, auto_resolved: 0 });
    expect(results["t-2"]).toEqual({ detected: 1, updated: 0, auto_resolved: 0 });
  });
});

describe("B: feilisolasjon - én tenant sin sveip-feil velter ALDRI resten", () => {
  it("en tenant som kaster feil faar en nullstilt SweepResult, oevrige tenants paavirkes ikke", async () => {
    const openLoops = {
      runSweep: async (tenantId: string) => {
        if (tenantId === "t-boom") throw new Error("simulert databasefeil");
        return { detected: 2, updated: 1, auto_resolved: 0 };
      }
    } as unknown as OpenLoopService;
    const results = await runOpenLoopSweepForAllTenants(fakePool([{ tenant_id: "t-ok-1" }, { tenant_id: "t-boom" }, { tenant_id: "t-ok-2" }]), openLoops);
    expect(results["t-boom"]).toEqual({ detected: 0, updated: 0, auto_resolved: 0 });
    expect(results["t-ok-1"]).toEqual({ detected: 2, updated: 1, auto_resolved: 0 });
    expect(results["t-ok-2"]).toEqual({ detected: 2, updated: 1, auto_resolved: 0 });
  });
});

describe("C: bounded - kaller den kanoniske RLS-trygge katalogfunksjonen med en bounded limit (Q-27, D-65)", () => {
  it("kaller jarvis_list_business_tenant_ids($1) med limit=200 - ALDRI en rå spoerring mot tenants", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [] };
      }
    } as unknown as pg.Pool;
    const openLoops = { runSweep: async () => ({ detected: 0, updated: 0, auto_resolved: 0 }) } as unknown as OpenLoopService;
    await runOpenLoopSweepForAllTenants(pool, openLoops);
    expect(capturedSql).toMatch(/jarvis_list_business_tenant_ids/);
    expect(capturedSql).not.toMatch(/FROM\s+tenants\b/i);
    expect(capturedParams).toEqual([200]);
  });
});

describe("D: tomt tenant-sett gir et tomt, gyldig resultat - ingen feil", () => {
  it("ingen business-tenants => tomt results-objekt", async () => {
    const openLoops = { runSweep: async () => ({ detected: 0, updated: 0, auto_resolved: 0 }) } as unknown as OpenLoopService;
    const results = await runOpenLoopSweepForAllTenants(fakePool([]), openLoops);
    expect(Object.keys(results)).toHaveLength(0);
  });
});

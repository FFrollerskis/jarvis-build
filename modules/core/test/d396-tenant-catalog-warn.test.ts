import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { listBusinessTenantIds } from "../src/services/tenant-catalog.ts";

/** D-396 (JARVIS-044): en tom business-tenant-katalog skal gi en eksplisitt advarsel (sveipene er da stille no-ops), aldri bare «count:0». */
const poolWith = (ids: string[]) => ({ query: async () => ({ rows: ids.map((tenant_id) => ({ tenant_id })) }) }) as unknown as pg.Pool;

describe("listBusinessTenantIds - tom katalog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("advarer når ingen business-tenants finnes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await listBusinessTenantIds(poolWith([]))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("business_sweeps_no_business_tenants");
  });

  it("advarer ikke når tenants finnes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await listBusinessTenantIds(poolWith(["t1"]))).toEqual(["t1"]);
    expect(warn).not.toHaveBeenCalled();
  });
});

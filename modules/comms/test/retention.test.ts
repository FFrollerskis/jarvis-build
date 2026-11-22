import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemorySpace } from "@jarvis/contracts";
import { InvalidCommsConfigError, RETENTION_INTERVAL_MS, RETENTION_SPACES, retentionTenants, runRetentionSweep, startRetentionSweep } from "../src/index.ts";

/**
 * WP-G1 fiks-runde B-M6: retensjonssveipet kjører UMIDDELBART ved oppstart (ikke først etter 6 timer), dekker riktig(e) tenant(s) - webhook-tenanten MÅ være en av eierens - og alle kommunikasjonsrom, og en feil på ett
 * (tenant, rom) stopper ikke de andre. Før: `setInterval` uten oppstartskjøring (en prosess som restartes oftere enn hver 6. time slettet aldri noe), kun eierens tenants, og oppkoblingen var utestet.
 */
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("retentionTenants: hvilke tenants sveipes", () => {
  it("eierens tenants (uten duplikater); webhook-tenanten er med når den er en av dem; en ukjent webhook-tenant STOPPER oppstarten med fast feil", () => {
    expect(retentionTenants(["t-a", "t-b", "t-a"], null)).toEqual(["t-a", "t-b"]);
    expect(retentionTenants(["t-a", "t-b"], "t-b")).toEqual(["t-a", "t-b"]);
    expect(() => retentionTenants(["t-a"], "t-ukjent")).toThrow(InvalidCommsConfigError);
    try { retentionTenants(["t-a"], "t-ukjent"); } catch (err) {
      expect((err as InvalidCommsConfigError).variable).toBe("JARVIS_COMMS_TENANT_ID");
      expect((err as Error).message).not.toContain("t-a"); // aldri tenant-id-er i feilteksten
    }
  });
});

describe("runRetentionSweep", () => {
  it("dekker hver tenant × hvert kommunikasjonsrom (helse/hjem/gjest aldri), og en feil på ett par stopper ikke resten (logges uten tekst)", async () => {
    const seen: Array<[string, MemorySpace]> = [];
    const warnings: Array<Record<string, unknown>> = [];
    const result = await runRetentionSweep({
      tenants: ["t-a", "t-b"], warn: (w) => warnings.push(w),
      purge: async (tenantId, space) => { seen.push([tenantId, space]); if (tenantId === "t-a" && space === "personal") throw new Error("db nede; hemmelig-detalj ".repeat(10)); }
    });
    expect(RETENTION_SPACES).toEqual(["business", "personal", "project", "shared"]);
    expect(seen).toHaveLength(8);
    expect(new Set(seen.map(([t]) => t))).toEqual(new Set(["t-a", "t-b"]));
    expect(new Set(seen.map(([, s]) => s))).toEqual(new Set(RETENTION_SPACES));
    expect(result).toEqual({ attempted: 8, failed: 1 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!["msg"]).toBe("comms_retention_sweep_failed");
    expect(String(warnings[0]!["error"]).length).toBeLessThanOrEqual(80);
  });
});

describe("startRetentionSweep", () => {
  it("kjører UMIDDELBART ved oppstart (før noen timer har gått), deretter hver 6. time, og stopper når den stoppes", async () => {
    const purge = vi.fn(async () => undefined);
    const handle = startRetentionSweep({ tenants: ["t-a"], purge });
    await handle.first;
    expect(purge).toHaveBeenCalledTimes(RETENTION_SPACES.length); // oppstartskjøringen - uten å vente på intervallet
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS - 1);
    expect(purge).toHaveBeenCalledTimes(RETENTION_SPACES.length);
    await vi.advanceTimersByTimeAsync(1);
    expect(purge).toHaveBeenCalledTimes(2 * RETENTION_SPACES.length);
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);
    expect(purge).toHaveBeenCalledTimes(3 * RETENTION_SPACES.length);
    handle.stop();
    await vi.advanceTimersByTimeAsync(2 * RETENTION_INTERVAL_MS);
    expect(purge).toHaveBeenCalledTimes(3 * RETENTION_SPACES.length);
    expect(RETENTION_INTERVAL_MS).toBe(6 * 3_600_000);
  });

  it("en feilende oppstartskjøring kaster aldri ut av start-kallet (logges), og neste intervall prøver igjen", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    let fail = true;
    const purge = vi.fn(async () => { if (fail) throw new Error("midlertidig feil"); });
    const handle = startRetentionSweep({ tenants: ["t-a"], purge, warn: (w) => warnings.push(w) });
    await expect(handle.first).resolves.toEqual({ attempted: RETENTION_SPACES.length, failed: RETENTION_SPACES.length });
    expect(warnings).toHaveLength(RETENTION_SPACES.length);
    fail = false;
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);
    expect(warnings).toHaveLength(RETENTION_SPACES.length); // ingen nye feil
    expect(purge).toHaveBeenCalledTimes(2 * RETENTION_SPACES.length);
    handle.stop();
  });
});

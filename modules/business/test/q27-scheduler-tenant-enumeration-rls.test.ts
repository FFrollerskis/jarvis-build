import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import type { BusinessEventSyncResult, BusinessEventSyncService } from "../src/business-event-sync.ts";
import { runBusinessEventSyncForAllTenants } from "../src/business-event-sync.ts";
import { runOpenLoopSweepForAllTenants } from "../src/open-loop-sweep.ts";
import type { OpenLoopService } from "../src/open-loop-service.ts";
import type { SweepResult } from "../src/open-loop-types.ts";
import { runScoringSweepForAllTenants } from "../src/scoring-sweep.ts";
import type { ScoringService } from "../src/scoring-service.ts";

/**
 * Q-27 (2026-08-18, D-65): ekte Postgres/RLS-integrasjonsbevis for at ALLE
 * TRE sveip-funksjonene faktisk oppdager bedrifts-tenants gjennom den nye,
 * RLS-trygge `listBusinessTenantIds()`-veien (`@jarvis/core`) mot en EKTE
 * `jarvis_runtime`-lignende, NOSUPERUSER/NOBYPASSRLS-rolle - IKKE bare mot
 * en `fakePool()`-mock (som IKKE kan bevise noe om RLS, se
 * `open-loop-sweep.test.ts` sin egen kommentar om denne begrensningen).
 * Selve forretningslogikken (OpenLoopService/BusinessEventSyncService/
 * ScoringService) er ALLEREDE testet grundig andre steder - denne suiten
 * bruker derfor bevisst enkle, deterministiske fake service-objekter og
 * fokuserer UTELUKKENDE på fan-out-/enumerasjons-laget disse tre
 * funksjonene selv eier.
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const TENANT_A = "tenant-q27-sched-biz-a";
const TENANT_B = "tenant-q27-sched-biz-b";
const TENANT_PERSON = "tenant-q27-sched-person";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-q27-sched-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_q27_sched_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_q27_sched_test");
  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES
       ('${TENANT_A}', 'Q27 Sched Biz A', 'business'),
       ('${TENANT_B}', 'Q27 Sched Biz B', 'business'),
       ('${TENANT_PERSON}', 'Q27 Sched Person', 'person')`
  );
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_q27_sched_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("OpenLoop-sveip: oppdager BEGGE ekte bedrifts-tenants via ekte RLS-rolle, ekskluderer person-tenanten", () => {
  it("runOpenLoopSweepForAllTenants kaller runSweep for TENANT_A og TENANT_B, aldri for person-tenanten", async () => {
    const visited: string[] = [];
    const openLoops = {
      runSweep: async (tenantId: string): Promise<SweepResult> => {
        visited.push(tenantId);
        return { detected: 1, updated: 0, auto_resolved: 0 };
      }
    } as unknown as OpenLoopService;

    const results = await runOpenLoopSweepForAllTenants(appPool, openLoops);

    expect(visited.sort()).toEqual([TENANT_A, TENANT_B].sort());
    expect(visited).not.toContain(TENANT_PERSON);
    expect(results[TENANT_A]).toEqual({ detected: 1, updated: 0, auto_resolved: 0 });
    expect(results[TENANT_B]).toEqual({ detected: 1, updated: 0, auto_resolved: 0 });
  });

  it("én tenant som kaster feil velter ALDRI den andre, selv mot den ekte RLS-katalogen", async () => {
    const openLoops = {
      runSweep: async (tenantId: string): Promise<SweepResult> => {
        if (tenantId === TENANT_A) throw new Error("simulert feil for A");
        return { detected: 3, updated: 1, auto_resolved: 0 };
      }
    } as unknown as OpenLoopService;

    const results = await runOpenLoopSweepForAllTenants(appPool, openLoops);

    expect(results[TENANT_A]).toEqual({ detected: 0, updated: 0, auto_resolved: 0 });
    expect(results[TENANT_B]).toEqual({ detected: 3, updated: 1, auto_resolved: 0 });
  });

  it("gjentatt kjøring (idempotens av selve enumerasjons-stien) finner SAMME to bedrifts-tenants begge ganger", async () => {
    const openLoops = { runSweep: async () => ({ detected: 0, updated: 0, auto_resolved: 0 }) } as unknown as OpenLoopService;
    const first = await runOpenLoopSweepForAllTenants(appPool, openLoops);
    const second = await runOpenLoopSweepForAllTenants(appPool, openLoops);
    expect(Object.keys(first).sort()).toEqual([TENANT_A, TENANT_B].sort());
    expect(Object.keys(second).sort()).toEqual([TENANT_A, TENANT_B].sort());
  });
});

describe("Business-Event-synk: oppdager BEGGE ekte bedrifts-tenants via ekte RLS-rolle, ekskluderer person-tenanten", () => {
  it("runBusinessEventSyncForAllTenants kaller syncTenant for TENANT_A og TENANT_B med korrekt identity, aldri for person-tenanten", async () => {
    const visited: Array<{ tenantId: string; identity: IdentityContext }> = [];
    const zeroResult: BusinessEventSyncResult = {
      gmail: { scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0 },
      calendar: { scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0 },
      open_loops_reevaluated: true
    };
    const syncService = {
      syncTenant: async (tenantId: string, _kind: string, identity: IdentityContext) => {
        visited.push({ tenantId, identity });
        return zeroResult;
      }
    } as unknown as BusinessEventSyncService;

    const results = await runBusinessEventSyncForAllTenants(appPool, syncService);

    expect(visited.map((v) => v.tenantId).sort()).toEqual([TENANT_A, TENANT_B].sort());
    for (const { tenantId, identity } of visited) {
      expect(identity.tenant_id).toBe(tenantId);
      expect(identity.memory_space_id).toBe("business");
    }
    expect(results[TENANT_A]).toEqual(zeroResult);
    expect(results[TENANT_B]).toEqual(zeroResult);
  });

  it("én tenant sin synk-feil velter ALDRI den andre, selv mot den ekte RLS-katalogen", async () => {
    const syncService = {
      syncTenant: async (tenantId: string) => {
        if (tenantId === TENANT_B) throw new Error("simulert Gmail-feil for B");
        return {
          gmail: { scanned: 2, recorded: 2, unmatched: 0, ambiguous: 0 },
          calendar: { scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0 },
          open_loops_reevaluated: true
        };
      }
    } as unknown as BusinessEventSyncService;

    const results = await runBusinessEventSyncForAllTenants(appPool, syncService);

    expect(results[TENANT_B]).toEqual({
      gmail: { scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0 },
      calendar: { scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0 },
      open_loops_reevaluated: false
    });
    expect(results[TENANT_A]?.gmail.scanned).toBe(2);
  });
});

describe("Scoring-sveip: oppdager BEGGE ekte bedrifts-tenants via ekte RLS-rolle, ekskluderer person-tenanten", () => {
  it("runScoringSweepForAllTenants kaller recalculateTenant for TENANT_A og TENANT_B, aldri for person-tenanten", async () => {
    const visited: string[] = [];
    const scoring = {
      recalculateTenant: async (tenantId: string) => {
        visited.push(tenantId);
        return { leads: 2, opportunities: 1 };
      }
    } as unknown as ScoringService;

    const results = await runScoringSweepForAllTenants(appPool, scoring);

    expect(visited.sort()).toEqual([TENANT_A, TENANT_B].sort());
    expect(visited).not.toContain(TENANT_PERSON);
    expect(results[TENANT_A]).toEqual({ leads: 2, opportunities: 1 });
    expect(results[TENANT_B]).toEqual({ leads: 2, opportunities: 1 });
  });

  it("én tenant sin rekalkulerings-feil velter ALDRI den andre, selv mot den ekte RLS-katalogen", async () => {
    const scoring = {
      recalculateTenant: async (tenantId: string) => {
        if (tenantId === TENANT_A) throw new Error("simulert scoring-feil for A");
        return { leads: 5, opportunities: 3 };
      }
    } as unknown as ScoringService;

    const results = await runScoringSweepForAllTenants(appPool, scoring);

    expect(results[TENANT_A]).toEqual({ leads: 0, opportunities: 0 });
    expect(results[TENANT_B]).toEqual({ leads: 5, opportunities: 3 });
  });
});

describe("Rolle-sikkerhet uendret gjennom hele suiten (Q-21)", () => {
  it("jarvis_q27_sched_test forblir NOSUPERUSER/NOBYPASSRLS etter alle sveipene", async () => {
    const { rows } = await adminPool.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'jarvis_q27_sched_test'"
    );
    const role = rows[0] as { rolsuper: boolean; rolbypassrls: boolean };
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });
});

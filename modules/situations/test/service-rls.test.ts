import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { DomainPauseRegistry } from "../src/domain-pause.ts";
import { SituationEngine, SituationEngineValidationError, SituationNotFoundError } from "../src/service.ts";
import type { SituationCandidateInput } from "../src/types.ts";

/**
 * UA-10 Proactive Situation Engine: ekte Postgres/RLS-integrasjonsbevis for
 * `SituationEngine` - multi-space-segregering, tenant-isolasjon, idempotent
 * deteksjon (`detection_key`-dedupe, "No duplicate spam for same event"),
 * stille timer/re-suppress-vindu, stadie-regresjon-forbud etter `act`, og
 * `resolve()` - mot en EKTE NOSUPERUSER/NOBYPASSRLS-rolle.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let engine: SituationEngine;

const TENANT_A = "tenant-sit-svc-a";
const TENANT_B = "tenant-sit-svc-b";

function candidate(overrides: Partial<SituationCandidateInput> = {}): SituationCandidateInput {
  return {
    domain: "spend",
    detection_key: "spend:campaign-1:overspend",
    priority: "normal",
    reason: "Kampanje-forbruk 3x over normalt",
    ...overrides
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-situations-svc-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_sit_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sit_svc_test");
  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Situations Svc A', 'business'), ('${TENANT_B}', 'Situations Svc B', 'business')`
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sit_svc_test", password: "pw2" });
  engine = new SituationEngine(appPool, new DomainPauseRegistry());
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: en NY kandidat skrives med korrekt beregnet stadium", () => {
  it("normal priority -> stage='inform', newly_actionable=true", async () => {
    const { situation, newly_actionable } = await engine.evaluateCandidate(TENANT_A, "business", candidate());
    expect(situation.situation_id).toMatch(/^sit-/);
    expect(situation.stage).toBe("inform");
    expect(situation.status).toBe("open");
    expect(newly_actionable).toBe(true);
    expect(situation.last_notified_at).not.toBeNull();
  });

  it("low priority -> stage='remember', newly_actionable=false (remember varsler aldri)", async () => {
    const { situation, newly_actionable } = await engine.evaluateCandidate(
      TENANT_A, "business", candidate({ detection_key: "spend:campaign-2:minor", priority: "low" })
    );
    expect(situation.stage).toBe("remember");
    expect(newly_actionable).toBe(false);
    expect(situation.last_notified_at).toBeNull();
  });
});

describe("B: idempotent deteksjon (detection_key) - 'No duplicate spam for same event'", () => {
  it("en gjentatt kandidat for SAMME detection_key oppdaterer SAMME rad, oppretter ALDRI en duplikat", async () => {
    const key = "spend:campaign-3:dedupe";
    const first = await engine.evaluateCandidate(TENANT_A, "business", candidate({ detection_key: key }));
    const second = await engine.evaluateCandidate(TENANT_A, "business", candidate({ detection_key: key, reason: "Oppdatert: fortsatt over normalt" }));
    expect(second.situation.situation_id).toBe(first.situation.situation_id);
    expect(second.situation.reason).toBe("Oppdatert: fortsatt over normalt");

    const { rows } = await adminPool.query(`SELECT count(*)::int AS n FROM situations WHERE tenant_id = $1 AND detection_key = $2`, [TENANT_A, key]);
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("en re-deteksjon INNENFOR re-suppress-vinduet er IKKE newly_actionable (ingen duplikat-varsel for samme forhold)", async () => {
    const key = "spend:campaign-4:resuppress";
    const t0 = Date.UTC(2026, 5, 1, 10, 0);
    const first = await engine.evaluateCandidate(TENANT_A, "business", candidate({ detection_key: key }), t0);
    expect(first.newly_actionable).toBe(true);

    const tSoon = t0 + 60_000; // 1 minutt senere - godt innenfor default 24-timers-vinduet.
    const second = await engine.evaluateCandidate(TENANT_A, "business", candidate({ detection_key: key }), tSoon);
    expect(second.newly_actionable).toBe(false);
  });

  it("en re-deteksjon ETTER re-suppress-vinduet ER newly_actionable igjen", async () => {
    const key = "spend:campaign-5:resuppress-expired";
    const t0 = Date.UTC(2026, 5, 1, 10, 0);
    await engine.evaluateCandidate(TENANT_A, "business", candidate({ detection_key: key }), t0);

    const tLater = t0 + 25 * 3_600_000; // 25 timer senere - forbi default 24-timers-vinduet.
    const second = await engine.evaluateCandidate(TENANT_A, "business", candidate({ detection_key: key }), tLater);
    expect(second.newly_actionable).toBe(true);
  });
});

describe("C: stadiet REGRESSERER ALDRI - en re-deteksjon tar det HØYESTE av eksisterende/nytt stadium", () => {
  it("en situasjon som først ble 'inform' (normal) og deretter re-detekteres som 'remember' (low) BEHOLDER 'inform'", async () => {
    const key = "spend:campaign-6:no-regress";
    const first = await engine.evaluateCandidate(TENANT_A, "business", candidate({ detection_key: key, priority: "normal" }));
    expect(first.situation.stage).toBe("inform");

    const second = await engine.evaluateCandidate(TENANT_A, "business", candidate({ detection_key: key, priority: "low" }));
    expect(second.situation.stage).toBe("inform"); // IKKE nedgradert til 'remember'.
  });

  it("en situasjon som har nådd 'act' (satt direkte for testens skyld) beholder 'act' etter en ny lav-prioritets re-deteksjon", async () => {
    const key = "spend:campaign-7:act-frozen";
    await engine.evaluateCandidate(TENANT_A, "business", candidate({ detection_key: key, priority: "high", confidence: 0.9 }));
    await adminPool.query(`UPDATE situations SET stage = 'act' WHERE tenant_id = $1 AND detection_key = $2`, [TENANT_A, key]);

    const { situation, newly_actionable } = await engine.evaluateCandidate(TENANT_A, "business", candidate({ detection_key: key, priority: "low" }));
    expect(situation.stage).toBe("act");
    expect(newly_actionable).toBe(false); // en allerede utført handling skal ALDRI trigge et nytt inform/suggest-varsel.
  });
});

describe("D: stille timer (quiet hours) - eier-konfigurert, holder stadiet på 'remember'", () => {
  it("en normal-prioritets kandidat detektert INNENFOR det konfigurerte vinduet blir 'remember', ikke 'inform'", async () => {
    await engine.setNotificationPolicy(TENANT_A, "personal", { quiet_hours_start_utc: 22, quiet_hours_end_utc: 6 });
    const duringQuiet = Date.UTC(2026, 5, 2, 23, 0);
    const { situation, newly_actionable } = await engine.evaluateCandidate(
      TENANT_A, "personal", candidate({ detection_key: "home:door:1", domain: "home" }), duringQuiet
    );
    expect(situation.stage).toBe("remember");
    expect(newly_actionable).toBe(false);
  });

  it("SAMME konfigurasjon, men UTENFOR vinduet, gir normal 'inform'-oppførsel", async () => {
    const outsideQuiet = Date.UTC(2026, 5, 2, 12, 0);
    const { situation } = await engine.evaluateCandidate(
      TENANT_A, "personal", candidate({ detection_key: "home:door:2", domain: "home" }), outsideQuiet
    );
    expect(situation.stage).toBe("inform");
  });

  it("getNotificationPolicy returnerer null naar ingen policy er konfigurert, ellers den registrerte raden", async () => {
    const tenantId = "tenant-sit-svc-getpolicy";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'GetPolicy', 'business')`);
    expect(await engine.getNotificationPolicy(tenantId, "business")).toBeNull();
    const policy = await engine.setNotificationPolicy(tenantId, "business", { resuppress_hours: 6 });
    expect(policy.resuppress_hours).toBe(6);
    expect(await engine.getNotificationPolicy(tenantId, "business")).not.toBeNull();
  });

  it("kun ETT av quiet_hours_start_utc/quiet_hours_end_utc satt kastes (zod-avvist)", async () => {
    await expect(
      engine.setNotificationPolicy(TENANT_A, "project", { quiet_hours_start_utc: 22 })
    ).rejects.toThrow();
  });
});

describe("E: ugyldig kandidat avvises deterministisk - INGEN rad skrevet", () => {
  it("manglende reason kastes som SituationEngineValidationError", async () => {
    const bad = { ...candidate(), reason: "" };
    await expect(engine.evaluateCandidate(TENANT_A, "business", bad)).rejects.toThrow(SituationEngineValidationError);
  });

  it("confidence utenfor [0,1] kastes", async () => {
    const bad = { ...candidate({ detection_key: "spend:bad-confidence" }), confidence: 1.5 };
    await expect(engine.evaluateCandidate(TENANT_A, "business", bad)).rejects.toThrow(SituationEngineValidationError);
    const { rows } = await adminPool.query(`SELECT 1 FROM situations WHERE tenant_id = $1 AND detection_key = $2`, [TENANT_A, "spend:bad-confidence"]);
    expect(rows).toHaveLength(0);
  });
});

describe("F: tenant-isolasjon (RLS) - TENANT_B ser ALDRI TENANT_A sine situasjoner", () => {
  it("getQueue for TENANT_B returnerer tomt naar data KUN finnes under TENANT_A", async () => {
    await engine.evaluateCandidate(TENANT_A, "business", candidate({ detection_key: "spend:isolation-test" }));
    const fromB = await engine.getQueue(TENANT_B, "business");
    expect(fromB.find((s) => s.detection_key === "spend:isolation-test")).toBeUndefined();
  });
});

describe("G: memory-space-RLS - en sesjon uten det aktuelle spacet ser INGENTING", () => {
  it("en sesjon scopet til KUN 'personal' ser null situasjoner for 'business', selv om rader faktisk finnes", async () => {
    const tenantId = "tenant-sit-svc-space-rls";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'SpaceRls', 'business')`);
    const { situation } = await engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: "spend:space-rls-test" }));

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', 'personal', true)", [tenantId]);
      const visible = await client.query("SELECT situation_id FROM situations WHERE tenant_id = $1 AND situation_id = $2", [tenantId, situation.situation_id]);
      expect(visible.rows).toHaveLength(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    // Kontroll: en sesjon MED 'business' i scope ser raden igjen (beviser at testen over faktisk beviser noe).
    const withSpace = await engine.getQueue(tenantId, "business");
    expect(withSpace.find((s) => s.situation_id === situation.situation_id)).toBeDefined();
  });
});

describe("H: getQueue - kun 'open' status som standard, prioritetsrekkefølge", () => {
  it("returnerer high FØR normal FØR low", async () => {
    const tenantId = "tenant-sit-svc-queue-order";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'QueueOrder', 'business')`);
    await engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: "q:low", priority: "low" }));
    await engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: "q:high", priority: "high", confidence: 0.9 }));
    await engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: "q:normal", priority: "normal" }));

    const queue = await engine.getQueue(tenantId, "business");
    expect(queue.map((s) => s.priority)).toEqual(["high", "normal", "low"]);
  });
});

describe("I: resolve() - lukker en situasjon, den forsvinner fra standard getQueue()", () => {
  it("resolve() setter status='resolved', getQueue() (open-only) viser den ikke lenger", async () => {
    const tenantId = "tenant-sit-svc-resolve";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'Resolve', 'business')`);
    const { situation } = await engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: "spend:resolve-me" }));
    const resolved = await engine.resolve(tenantId, "business", situation.situation_id);
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolved_at).not.toBeNull();

    const queue = await engine.getQueue(tenantId, "business");
    expect(queue.find((s) => s.situation_id === situation.situation_id)).toBeUndefined();
  });

  it("resolve() på en ukjent situation_id kaster SituationNotFoundError", async () => {
    await expect(engine.resolve(TENANT_A, "business", "sit-does-not-exist")).rejects.toThrow(SituationNotFoundError);
  });

  it("en LUKKET situasjon som re-detekteres (samme detection_key) GJENÅPNES", async () => {
    const tenantId = "tenant-sit-svc-reopen";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'Reopen', 'business')`);
    const key = "spend:reopen-me";
    const { situation } = await engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: key }));
    await engine.resolve(tenantId, "business", situation.situation_id);

    const { situation: reopened } = await engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: key }));
    expect(reopened.situation_id).toBe(situation.situation_id);
    expect(reopened.status).toBe("open");
    expect(reopened.resolved_at).toBeNull();
  });
});

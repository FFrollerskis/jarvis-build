import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { DomainPauseRegistry } from "../src/domain-pause.ts";
import { SituationDetectionKeyConflictError, SituationEngine, SituationEngineValidationError, SituationNotFoundError } from "../src/service.ts";
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

describe("J: Funn 1 (arkitekt-review runde 1, PR #85) - atomisk kollisjonsdomene (tenant+space+detection_key)", () => {
  it("SAMME detection_key i TO ULIKE memory spaces (samme tenant) kolliderer IKKE - to uavhengige rader", async () => {
    const tenantId = "tenant-sit-svc-space-dedupe";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'SpaceDedupe', 'business')`);
    const key = "shared-key:space-dedupe";
    const inBusiness = await engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: key }));
    const inPersonal = await engine.evaluateCandidate(tenantId, "personal", candidate({ detection_key: key, domain: "home" }));
    expect(inBusiness.situation.situation_id).not.toBe(inPersonal.situation.situation_id);

    const { rows } = await adminPool.query(`SELECT count(*)::int AS n FROM situations WHERE tenant_id = $1 AND detection_key = $2`, [tenantId, key]);
    expect((rows[0] as { n: number }).n).toBe(2);
  });

  it("TO SAMTIDIGE evaluateCandidate()-kall for en HELT NY detection_key racer TRYGT - ingen ukontrollert unique-constraint-feil, kun ÉN rad opprettes", async () => {
    const tenantId = "tenant-sit-svc-concurrent-new";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'ConcurrentNew', 'business')`);
    const key = "spend:concurrent-race";
    const [first, second] = await Promise.all([
      engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: key })),
      engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: key }))
    ]);
    expect(first.situation.situation_id).toBe(second.situation.situation_id);

    const { rows } = await adminPool.query(`SELECT count(*)::int AS n FROM situations WHERE tenant_id = $1 AND detection_key = $2`, [tenantId, key]);
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("en re-deteksjon for SAMME detection_key med et ANNET domain avvises (SituationDetectionKeyConflictError), overskriver ALDRI stille", async () => {
    const tenantId = "tenant-sit-svc-identity-conflict";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'IdentityConflict', 'business')`);
    const key = "spend:identity-conflict-domain";
    await engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: key, domain: "spend" }));
    await expect(
      engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: key, domain: "pipeline" }))
    ).rejects.toThrow(SituationDetectionKeyConflictError);

    // Den lagrede raden er UENDRET (fortsatt 'spend') - avvisningen skrev INGENTING.
    const { rows } = await adminPool.query(`SELECT domain FROM situations WHERE tenant_id = $1 AND detection_key = $2`, [tenantId, key]);
    expect((rows[0] as { domain: string }).domain).toBe("spend");
  });

  it("en re-deteksjon for SAMME detection_key med en ANNEN owner_person_id avvises (SituationDetectionKeyConflictError)", async () => {
    const tenantId = "tenant-sit-svc-identity-conflict-owner";
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'IdentityConflictOwner', 'business');
      INSERT INTO people (person_id, display_name) VALUES ('person-owner-x', 'X'), ('person-owner-y', 'Y');
      INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-owner-x', '${tenantId}'), ('person-owner-y', '${tenantId}');
    `);
    const key = "spend:identity-conflict-owner";
    await engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: key, owner_person_id: "person-owner-x" }));
    await expect(
      engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: key, owner_person_id: "person-owner-y" }))
    ).rejects.toThrow(SituationDetectionKeyConflictError);
  });
});

describe("K: Funn 2 (arkitekt-review runde 1, PR #85) - source_open_loop_id er scope-safe (sammensatt FK)", () => {
  const TENANT_K1 = "tenant-sit-svc-scope-fk-a";
  const TENANT_K2 = "tenant-sit-svc-scope-fk-b";

  beforeAll(async () => {
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_K1}', 'ScopeFkA', 'business'), ('${TENANT_K2}', 'ScopeFkB', 'business');
      INSERT INTO business_open_loops (open_loop_id, tenant_id, memory_space_id, loop_type, detection_key, reason)
        VALUES
          ('loop-scope-fk-business', '${TENANT_K1}', 'business', 'stalled_opportunity', 'loop:scope-fk-business', 'test loop business'),
          ('loop-scope-fk-personal', '${TENANT_K1}', 'personal', 'stalled_opportunity', 'loop:scope-fk-personal', 'test loop personal'),
          ('loop-scope-fk-other-tenant', '${TENANT_K2}', 'business', 'stalled_opportunity', 'loop:scope-fk-other-tenant', 'test loop other tenant');
    `);
  });

  it("en source_open_loop_id i SAMME tenant+space som situasjonen aksepteres", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_K1, "business", candidate({
      detection_key: "spend:scope-fk-ok", source_open_loop_id: "loop-scope-fk-business"
    }));
    expect(situation.source_open_loop_id).toBe("loop-scope-fk-business");
  });

  it("en source_open_loop_id fra et ANNET tenant avvises av databasen (FK-brudd), INGEN rad skrives", async () => {
    await expect(
      engine.evaluateCandidate(TENANT_K1, "business", candidate({
        detection_key: "spend:scope-fk-cross-tenant", source_open_loop_id: "loop-scope-fk-other-tenant"
      }))
    ).rejects.toThrow();
    const { rows } = await adminPool.query(
      `SELECT 1 FROM situations WHERE tenant_id = $1 AND detection_key = $2`, [TENANT_K1, "spend:scope-fk-cross-tenant"]
    );
    expect(rows).toHaveLength(0);
  });

  it("en source_open_loop_id fra SAMME tenant men et ANNET memory_space avvises av databasen (FK-brudd)", async () => {
    await expect(
      engine.evaluateCandidate(TENANT_K1, "business", candidate({
        detection_key: "spend:scope-fk-cross-space", source_open_loop_id: "loop-scope-fk-personal"
      }))
    ).rejects.toThrow();
    const { rows } = await adminPool.query(
      `SELECT 1 FROM situations WHERE tenant_id = $1 AND detection_key = $2`, [TENANT_K1, "spend:scope-fk-cross-space"]
    );
    expect(rows).toHaveLength(0);
  });
});

describe("L: Funn 5 (arkitekt-review runde 1, PR #85) - stille timer MÅ sjekkes selv naar resuppress-vinduet er ute", () => {
  it("en re-deteksjon ETTER resuppress-vinduet, men INNENFOR et konfigurert stille-timer-vindu, er IKKE newly_actionable", async () => {
    const tenantId = "tenant-sit-svc-quiet-resuppress";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'QuietResuppress', 'business')`);
    await engine.setNotificationPolicy(tenantId, "business", { quiet_hours_start_utc: 22, quiet_hours_end_utc: 6, resuppress_hours: 1 });

    const key = "spend:quiet-during-resuppress";
    const t0 = Date.UTC(2026, 5, 3, 12, 0); // 12:00 UTC - utenfor stille-timer-vinduet.
    const first = await engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: key }), t0);
    expect(first.situation.stage).toBe("inform");
    expect(first.newly_actionable).toBe(true);
    const lastNotifiedAfterFirst = first.situation.last_notified_at;
    expect(lastNotifiedAfterFirst).not.toBeNull();

    // 11 timer senere: LANGT forbi 1-times-resuppress-vinduet (resuppressOpen=true),
    // MEN klokken er nå 23:00 UTC - INNENFOR det konfigurerte 22->6-stille-vinduet.
    // Stadiet forblir 'inform' (non-regresjon - computedStage under stille timer er
    // 'remember', men eksisterende 'inform' er høyere og beholdes) - FØR Funn 5-fiksen
    // ville dette feilaktig blitt newly_actionable=true kun fordi resuppress-vinduet
    // var ute, og stille sendt et varsel midt i eierens konfigurerte stille periode.
    const tQuiet = t0 + 11 * 3_600_000;
    const second = await engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: key }), tQuiet);
    expect(second.situation.stage).toBe("inform");
    expect(second.newly_actionable).toBe(false);
    // last_notified_at UENDRET - INGEN stille varslings-bokføring skjedde under stille timer.
    expect(second.situation.last_notified_at).toEqual(lastNotifiedAfterFirst);

    // Kontroll: SAMME situasjon, re-detektert UTENFOR stille-vinduet OG forbi
    // resuppress-vinduet, ER newly_actionable (beviser testen over faktisk måler noe).
    const tAfterQuiet = t0 + 20 * 3_600_000; // 08:00 UTC neste dag - utenfor 22->6.
    const third = await engine.evaluateCandidate(tenantId, "business", candidate({ detection_key: key }), tAfterQuiet);
    expect(third.newly_actionable).toBe(true);
  });
});

describe("M: Funn 6 (arkitekt-review runde 2, PR #85) - owner_person_id er scope-safe (sammensatt FK mot person_tenants)", () => {
  const TENANT_M1 = "tenant-sit-svc-owner-scope-a";
  const TENANT_M2 = "tenant-sit-svc-owner-scope-b";
  const OWNER_IN_M1 = "person-owner-scope-m1";
  const OWNER_IN_M2_ONLY = "person-owner-scope-m2";

  beforeAll(async () => {
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_M1}', 'OwnerScopeA', 'business'), ('${TENANT_M2}', 'OwnerScopeB', 'business');
      INSERT INTO people (person_id, display_name) VALUES ('${OWNER_IN_M1}', 'M1 Owner'), ('${OWNER_IN_M2_ONLY}', 'M2-only Owner');
      INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER_IN_M1}', '${TENANT_M1}'), ('${OWNER_IN_M2_ONLY}', '${TENANT_M2}');
    `);
  });

  it("en owner_person_id som ER medlem av situasjonens EGET tenant aksepteres", async () => {
    const { situation } = await engine.evaluateCandidate(TENANT_M1, "business", candidate({
      detection_key: "spend:owner-scope-ok", owner_person_id: OWNER_IN_M1
    }));
    expect(situation.owner_person_id).toBe(OWNER_IN_M1);
  });

  it("en owner_person_id som KUN er medlem av et ANNET tenant avvises av databasen (FK-brudd), INGEN rad skrives", async () => {
    await expect(
      engine.evaluateCandidate(TENANT_M1, "business", candidate({
        detection_key: "spend:owner-scope-cross-tenant", owner_person_id: OWNER_IN_M2_ONLY
      }))
    ).rejects.toThrow();
    const { rows } = await adminPool.query(
      `SELECT 1 FROM situations WHERE tenant_id = $1 AND detection_key = $2`, [TENANT_M1, "spend:owner-scope-cross-tenant"]
    );
    expect(rows).toHaveLength(0);
  });
});

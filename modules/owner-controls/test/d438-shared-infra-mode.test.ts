import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InfraExecutionGate, createPgInfraModeStore } from "@jarvis/policy";

/**
 * JARVIS-025 / D-438: infra-modusen (NORMAL/DEGRADED/PAUSED) deles mellom api- og worker-prosessen via `owner_control_state` (kind `infra_mode`).
 * To gate-instanser mot SAMME ekte Postgres simulerer de to prosessene.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-infra-mode-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_infra_mode_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_infra_mode_test");
  await admin.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ('t-im','IM','business'); INSERT INTO people (person_id, display_name) VALUES ('p-im','Owner')");
  app = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_infra_mode_test", password: "pw2" });
  app.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
});

describe("D-438: delt infra-modus mellom to prosesser (ekte Postgres)", () => {
  it("pause i 'api' stanser 'worker' etter synk; degrade overstyrer; resume løser begge", async () => {
    const api = new InfraExecutionGate(undefined, createPgInfraModeStore(app));
    const worker = new InfraExecutionGate(undefined, createPgInfraModeStore(app));
    await worker.refresh();
    expect(worker.check("B")).toBeNull();

    await api.pauseDurable("vedlikehold", "p-im");
    await worker.refresh();
    expect(worker.current()).toMatchObject({ mode: "PAUSED", reason: "vedlikehold" });
    expect(worker.check("B")).toBe("infra_paused");
    expect(worker.check("A")).toBeNull(); // diagnostikk er aldri stanset

    await api.degradeDurable("treg", "p-im");
    await worker.refresh();
    expect(worker.current().mode).toBe("DEGRADED");
    expect(worker.check("B")).toBeNull();
    expect(worker.check("D")).toBe("infra_degraded_blocks_class_d");

    await api.resumeDurable();
    await worker.refresh();
    expect(worker.current().mode).toBe("NORMAL");
  });

  it("en NY prosess (restart) overtar en eksisterende pause ved oppstart", async () => {
    const before = new InfraExecutionGate(undefined, createPgInfraModeStore(app));
    await before.pauseDurable("overlever restart", "p-im");
    const restarted = new InfraExecutionGate(undefined, createPgInfraModeStore(app));
    expect(restarted.current().mode).toBe("NORMAL"); // før første synk
    await restarted.refresh();
    expect(restarted.current()).toMatchObject({ mode: "PAUSED", reason: "overlever restart" });
    await before.resumeDurable();
  });

  it("uleselig/ukjent lagret modus tolkes fail-closed som PAUSED (aldri stille NORMAL)", async () => {
    await admin.query(`INSERT INTO owner_control_state (control_kind, control_target, reason) VALUES ('infra_mode', 'GLOBAL', 'ikke-json')
                       ON CONFLICT (control_kind, control_target) DO UPDATE SET reason = EXCLUDED.reason`);
    const gate = new InfraExecutionGate(undefined, createPgInfraModeStore(app));
    await gate.refresh();
    expect(gate.current()).toMatchObject({ mode: "PAUSED", reason: "infra_mode_state_unreadable" });
    await createPgInfraModeStore(app).clear();
  });

  it("kind 'infra_mode' kan bare ha målet GLOBAL (DB-constraint)", async () => {
    await expect(admin.query(`INSERT INTO owner_control_state (control_kind, control_target, reason) VALUES ('infra_mode', 'annet', 'x')`)).rejects.toThrow(/infra_mode_target_ck/);
  });
});

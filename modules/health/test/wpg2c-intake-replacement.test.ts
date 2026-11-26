import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { HealthIntakeService, type HealthIntakeIdentity } from "../src/intake.ts";
import { HealthService } from "../src/service.ts";

/**
 * WP-G2c (D-483, JARVIS-113 e/5): appens kontrakt for å ERSTATTE prøver (sammenslåtte pulsprøver, søvnsum uten uuid) bevist mot ekte Postgres. Selve begrensningene er `DEFERRED` (serveren ser ikke intervaller eller kilde og gjetter
 * aldri), men mekanismen appen skal bruke - ny/versjonert id + slett den gamle i SAMME batch - må virke, og feilmodusen (samme id med ny verdi) må være synlig, ikke en stille overskriving.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let intake: HealthIntakeService;

const TENANT = "t-hlt-repl";
const P1 = "p-hlt-repl-1";
const who = (person = P1): HealthIntakeIdentity => ({ tenant_id: TENANT, person_id: person, session_id: `sess-${person}`, device_id: "iphone-1", channel: "mobile" });
const recent = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const sid = (name: string): string => `sample-${name}-0000`; // 8-128 tegn, tillatt tegnsett

async function stored(metric?: string): Promise<Array<{ external_sample_id: string; metric_type: string; value: number }>> {
  const { rows } = await admin.query(`SELECT external_sample_id, metric_type, value FROM health_metric_observations WHERE tenant_id = $1 ${metric === undefined ? "" : "AND metric_type = $2"} ORDER BY external_sample_id`, metric === undefined ? [TENANT] : [TENANT, metric]);
  return (rows as Array<{ external_sample_id: string; metric_type: string; value: string }>).map((r) => ({ ...r, value: Number(r.value) }));
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-hlt-repl-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_hlt_repl_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_hlt_repl_test");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Replacement','person');
    INSERT INTO people (person_id, display_name) VALUES ('${P1}','P1');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${P1}','${TENANT}');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_hlt_repl_test", password: "pw2" });
  intake = new HealthIntakeService(app);
  await new HealthService(app).setRetentionPolicy(TENANT, { retention_days: 30, actor_person_id: P1 });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("søvnsum uten uuid: samme id med endret sum er `conflict` (synlig), versjonert id + sletting av forrige i SAMME batch er veien", () => {
  it("samme id, ny sum: `conflict` hver gang, den gamle verdien står, og ingenting overskrives stille (feilmodusen appen MÅ unngå)", async () => {
    const first = await intake.ingestBatch(who(), { samples: [{ metric_type: "sleep_duration_minutes", value: 400, unit: "minutes", observed_at: recent(600), external_sample_id: sid("sleep-night-a") }] });
    expect(first.results).toEqual([{ index: 0, status: "created" }]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const again = await intake.ingestBatch(who(), { samples: [{ metric_type: "sleep_duration_minutes", value: 431, unit: "minutes", observed_at: recent(600), external_sample_id: sid("sleep-night-a") }] });
      expect(again.results).toEqual([{ index: 0, status: "conflict", reason: "sample_id_reused_with_different_content" }]);
      expect(again.counts).toMatchObject({ conflict: 1, created: 0, deleted: 0 });
    }
    expect(await stored("sleep_duration_minutes")).toEqual([{ external_sample_id: sid("sleep-night-a"), metric_type: "sleep_duration_minutes", value: 400 }]);
  });

  it("versjonert id + forrige versjons id i `deleted_external_sample_ids` i SAMME batch: den nye summen erstatter den gamle (én transaksjon), og samme batch på nytt er idempotent", async () => {
    await intake.ingestBatch(who(), { samples: [{ metric_type: "sleep_duration_minutes", value: 380, unit: "minutes", observed_at: recent(500), external_sample_id: sid("sleep-night-b-v1") }] });
    const replace = {
      samples: [{ metric_type: "sleep_duration_minutes", value: 445, unit: "minutes", observed_at: recent(500), external_sample_id: sid("sleep-night-b-v2") }],
      deleted_external_sample_ids: [sid("sleep-night-b-v1")]
    };
    const done = await intake.ingestBatch(who(), replace);
    expect(done.results).toEqual([{ index: 0, status: "created" }]);
    expect(done.counts).toMatchObject({ created: 1, deleted: 1 });
    expect((await stored("sleep_duration_minutes")).filter((r) => r.external_sample_id.startsWith("sample-sleep-night-b"))).toEqual([{ external_sample_id: sid("sleep-night-b-v2"), metric_type: "sleep_duration_minutes", value: 445 }]);
    const replay = await intake.ingestBatch(who(), replace); // appen prøver på nytt etter et nettverksavbrudd
    expect(replay.results).toEqual([{ index: 0, status: "duplicate" }]);
    expect(replay.counts).toMatchObject({ duplicate: 1, created: 0, deleted: 0 });
    expect((await stored("sleep_duration_minutes")).filter((r) => r.external_sample_id.startsWith("sample-sleep-night-b"))).toHaveLength(1);
  });

  it("rekkefølgen er innsettinger FØRST og slettinger SIST: en id i begge listene gir en slettet rad (kontrakten forbyr det, men utfallet er forutsigbart og revisjonen teller begge)", async () => {
    const result = await intake.ingestBatch(who(), {
      samples: [{ metric_type: "sleep_duration_minutes", value: 300, unit: "minutes", observed_at: recent(400), external_sample_id: sid("sleep-night-c") }],
      deleted_external_sample_ids: [sid("sleep-night-c")]
    });
    expect(result.counts).toMatchObject({ created: 1, deleted: 1 });
    expect((await stored("sleep_duration_minutes")).filter((r) => r.external_sample_id === sid("sleep-night-c"))).toEqual([]);
  });
});

describe("sammenslåtte prøver gjelder også puls: erstatning krever at appen sender slettingene; serveren gjetter aldri", () => {
  const hr = (name: string, value: number, minutesAgo: number) => ({ metric_type: "heart_rate", value, unit: "bpm", observed_at: recent(minutesAgo), external_sample_id: sid(name) });

  it("tre pulsprøver slås sammen til én ny uuid: ny prøve + de tre gamle som slettinger gir nøyaktig én rad igjen", async () => {
    await intake.ingestBatch(who(), { samples: [hr("hr-a", 70, 120), hr("hr-b", 72, 119), hr("hr-c", 74, 118)] });
    const merged = await intake.ingestBatch(who(), { samples: [hr("hr-merged", 72, 120)], deleted_external_sample_ids: [sid("hr-a"), sid("hr-b"), sid("hr-c")] });
    expect(merged.counts).toMatchObject({ created: 1, deleted: 3 });
    expect((await stored("heart_rate")).map((r) => r.external_sample_id).filter((id) => id.startsWith("sample-hr-"))).toEqual([sid("hr-merged")]);
  });

  it("uten slettingene (appen mistet HKDeletedObject) beholdes ALLE prøvene: serveren gjetter ikke hva som er slått sammen (DEFERRED: krever intervaller fra appen)", async () => {
    await intake.ingestBatch(who(), { samples: [hr("hr2-a", 60, 90), hr("hr2-b", 62, 89)] });
    const merged = await intake.ingestBatch(who(), { samples: [hr("hr2-merged", 61, 90)] });
    expect(merged.counts).toMatchObject({ created: 1, deleted: 0 });
    expect((await stored("heart_rate")).map((r) => r.external_sample_id).filter((id) => id.startsWith("sample-hr2-")).sort()).toEqual([sid("hr2-a"), sid("hr2-b"), sid("hr2-merged")]);
  });

  it("en sletting av en id som ikke finnes (allerede slettet) er en stille no-op med tellingen 0, aldri en feil (andre personers/tenanters rader dekkes av `intake.test.ts`)", async () => {
    const none = await intake.ingestBatch(who(), { deleted_external_sample_ids: [sid("finnes-ikke-i-det-hele-tatt")] });
    expect(none.counts).toMatchObject({ deleted: 0 });
  });
});

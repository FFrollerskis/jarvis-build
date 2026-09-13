import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";

/**
 * Arkitekt-review MERGE BLOCKER (D-130, PR #79): en enkel
 * `person_id text REFERENCES people (person_id)` beviser KUN at personen
 * eksisterer GLOBALT, ALDRI at personen faktisk er MEDLEM av tenanten raden
 * selv hevder å tilhøre - SAMME feilklasse som D-129
 * (`modules/operations/test/scope-integrity.test.ts`) og SAMME retting/test
 * som `modules/context/test/person-tenant-membership-fk.test.ts`.
 *
 * `051_health.sql` erstatter derfor den enkle FK-en på
 * `health_metric_observations.person_id` med `FOREIGN KEY (person_id,
 * tenant_id) REFERENCES person_tenants (person_id, tenant_id)`. Denne
 * testen beviser BEGGE retninger mot EKTE embedded Postgres via et RÅTT
 * INSERT direkte mot tabellen (IKKE via `HealthService` - dette beviser
 * selve DB-constrainten, uavhengig av applikasjonslaget): (A) et
 * (person, tenant)-par UTEN et faktisk `person_tenants`-medlemskap avvises
 * deterministisk med SQLSTATE 23503 (foreign_key_violation), og (B) et
 * (person, tenant)-par MED et faktisk medlemskap skrives normalt (ingen
 * falsk-positiv avvisning).
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const TENANT_MEMBER = "tenant-hlt-fk-member";
const TENANT_NONMEMBER = "tenant-hlt-fk-nonmember";
const PERSON_ID = "person-hlt-fk-a";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-health-fk-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_hlt_fk_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_hlt_fk_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_MEMBER}', 'Health FK Member', 'person'), ('${TENANT_NONMEMBER}', 'Health FK Nonmember', 'person')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('${PERSON_ID}', 'Person FK A')`);
  // PERSON_ID er BEVISST KUN medlem av TENANT_MEMBER - INGEN person_tenants-rad for TENANT_NONMEMBER.
  await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_ID}', '${TENANT_MEMBER}')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_hlt_fk_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

function rawInsert(client: pg.Pool | pg.PoolClient, observationId: string, tenantId: string) {
  return client.query(
    `INSERT INTO health_metric_observations
       (observation_id, tenant_id, person_id, metric_type, value, unit, source_type, observed_at)
     VALUES ($1, $2, $3, 'heart_rate', 70, 'bpm', 'test', now())`,
    [observationId, tenantId, PERSON_ID]
  );
}

describe("A: (person_id, tenant_id) UTEN et faktisk person_tenants-medlemskap avvises av Postgres selv", () => {
  it("INSERT mot en tenant PERSON_ID IKKE er medlem av feiler med SQLSTATE 23503 (foreign_key_violation)", async () => {
    await expect(rawInsert(adminPool, "hlt-fk-reject-1", TENANT_NONMEMBER)).rejects.toMatchObject({ code: "23503" });
  });
});

describe("B: (person_id, tenant_id) MED et faktisk person_tenants-medlemskap skrives normalt (ingen falsk-positiv avvisning)", () => {
  it("INSERT mot tenanten PERSON_ID FAKTISK er medlem av lykkes", async () => {
    const result = await rawInsert(adminPool, "hlt-fk-accept-1", TENANT_MEMBER);
    expect(result.rowCount).toBe(1);

    const { rows } = await adminPool.query(`SELECT person_id, tenant_id FROM health_metric_observations WHERE observation_id = $1`, [
      "hlt-fk-accept-1"
    ]);
    expect(rows[0]).toMatchObject({ person_id: PERSON_ID, tenant_id: TENANT_MEMBER });
  });

  it("kontroll: samme forsøk via jarvis_app-rollen (appPool, NOSUPERUSER/NOBYPASSRLS) lykkes ogsaa - constrainten er ikke superuser-avhengig", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', 'health', true)", [
        TENANT_MEMBER
      ]);
      const result = await rawInsert(client, "hlt-fk-accept-2", TENANT_MEMBER);
      expect(result.rowCount).toBe(1);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});

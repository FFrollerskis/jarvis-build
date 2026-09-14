import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * Arkitekt-review MERGE BLOCKER (D-130, PR #79): en enkel
 * `person_id text REFERENCES people (person_id)` beviser KUN at personen
 * eksisterer GLOBALT, ALDRI at personen faktisk er MEDLEM av tenanten raden
 * selv hevder å tilhøre - RLS beskytter LESING/SKRIVING av EGNE rader, men
 * gir INGEN garanti om at et (person_id, tenant_id)-par som blir SKREVET
 * faktisk er et ekte medlemskap (samme klasse feil som D-129,
 * `modules/operations/test/scope-integrity.test.ts`).
 *
 * `049_context_engine.sql` erstatter derfor den enkle FK-en med
 * `FOREIGN KEY (person_id, tenant_id) REFERENCES person_tenants (person_id,
 * tenant_id)`. Denne testen beviser BEGGE retninger mot EKTE embedded
 * Postgres (rått INSERT direkte mot tabellen, IKKE via `ContextEngine` -
 * dette er et bevis for selve DB-constrainten, uavhengig av
 * applikasjonslaget): (A) et (person, tenant)-par UTEN et faktisk
 * `person_tenants`-medlemskap avvises deterministisk med SQLSTATE 23503
 * (foreign_key_violation), og (B) et (person, tenant)-par MED et faktisk
 * medlemskap skrives normalt (ingen falsk-positiv avvisning).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const TENANT_MEMBER = "tenant-ctx-fk-member";
const TENANT_NONMEMBER = "tenant-ctx-fk-nonmember";
const PERSON_ID = "person-ctx-fk-a";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-context-fk-"));
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

  await adminPool.query("CREATE ROLE jarvis_ctx_fk_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_ctx_fk_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_MEMBER}', 'Ctx FK Member', 'business'), ('${TENANT_NONMEMBER}', 'Ctx FK Nonmember', 'business')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('${PERSON_ID}', 'Person FK A')`);
  // PERSON_ID er BEVISST KUN medlem av TENANT_MEMBER - INGEN person_tenants-rad for TENANT_NONMEMBER.
  await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_ID}', '${TENANT_MEMBER}')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_ctx_fk_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

function rawInsert(client: pg.Pool | pg.PoolClient, observationId: string, tenantId: string, dimension = "activity") {
  // `dimension` er parameteriserbar KUN for at to separate testkall i samme
  // (tenant, person, space) ikke krasjer mot UNIQUE (tenant_id, person_id,
  // memory_space_id, dimension) - irrelevant for selve FK-beviset denne
  // testen faktisk gjelder.
  return client.query(
    `INSERT INTO context_observations
       (observation_id, tenant_id, person_id, memory_space_id, dimension, value, basis, source_type, observed_at)
     VALUES ($1, $2, $3, 'personal', $4, '{}'::jsonb, 'deterministic', 'test', now())`,
    [observationId, tenantId, PERSON_ID, dimension]
  );
}

describe("A: (person_id, tenant_id) UTEN et faktisk person_tenants-medlemskap avvises av Postgres selv", () => {
  it("INSERT mot en tenant PERSON_ID IKKE er medlem av feiler med SQLSTATE 23503 (foreign_key_violation)", async () => {
    await expect(rawInsert(adminPool, "ctx-fk-reject-1", TENANT_NONMEMBER)).rejects.toMatchObject({ code: "23503" });
  });
});

describe("B: (person_id, tenant_id) MED et faktisk person_tenants-medlemskap skrives normalt (ingen falsk-positiv avvisning)", () => {
  it("INSERT mot tenanten PERSON_ID FAKTISK er medlem av lykkes", async () => {
    const result = await rawInsert(adminPool, "ctx-fk-accept-1", TENANT_MEMBER);
    expect(result.rowCount).toBe(1);

    const { rows } = await adminPool.query(`SELECT person_id, tenant_id FROM context_observations WHERE observation_id = $1`, [
      "ctx-fk-accept-1"
    ]);
    expect(rows[0]).toMatchObject({ person_id: PERSON_ID, tenant_id: TENANT_MEMBER });
  });

  it("kontroll: samme forsøk via jarvis_app-rollen (appPool, NOSUPERUSER/NOBYPASSRLS) lykkes ogsaa - constrainten er ikke superuser-avhengig", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', 'personal', true)", [
        TENANT_MEMBER
      ]);
      const result = await rawInsert(client, "ctx-fk-accept-2", TENANT_MEMBER, "place");
      expect(result.rowCount).toBe(1);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});

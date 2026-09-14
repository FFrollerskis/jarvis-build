import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrator.ts";
import { assertRuntimeRoleSafe, checkRuntimeRoleStatus, ensureRuntimeRole } from "../src/services/runtime-role.ts";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * Q-21 (UA-2 P0 host-blocker, 2026-08-15): host bekreftet at den faktiske
 * runtime-tilkoblingen kjørte som Postgres-superbruker (`postgres`) - RLS-
 * policyene fantes og var FORCE-et, men ble aldri håndhevet. Denne suiten
 * beviser `ensureRuntimeRole`/`assertRuntimeRoleSafe` (§10.A-D/J-K i BO-en).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;

function connectAs(user: string, password: string): pg.Pool {
  return new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user, password, max: 1 });
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-runtime-role-"));
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
}, 240_000);

afterAll(async () => {
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("ensureRuntimeRole (§10.A-D)", () => {
  it("A-D: bootstrapper en ekte LOGIN-rolle, NOSUPERUSER, NOBYPASSRLS, medlem av jarvis_app", async () => {
    const result = await ensureRuntimeRole(adminPool, { user: "jarvis_runtime_test", password: "pw-runtime-1" });
    expect(result).toMatchObject({ role: "jarvis_runtime_test", created: true });

    const runtimePool = connectAs("jarvis_runtime_test", "pw-runtime-1");
    try {
      const status = await checkRuntimeRoleStatus(runtimePool);
      expect(status.canLogin).toBe(true); // A: LOGIN
      expect(status.superuser).toBe(false); // B: NOSUPERUSER
      expect(status.bypassrls).toBe(false); // C: NOBYPASSRLS
      const membership = await adminPool.query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.roleid
           JOIN pg_roles mm ON mm.oid = m.member
           WHERE mm.rolname = 'jarvis_runtime_test' AND r.rolname = 'jarvis_app'
         ) AS is_member`
      );
      expect((membership.rows[0] as { is_member: boolean }).is_member).toBe(true); // D: medlem av jarvis_app
      await expect(assertRuntimeRoleSafe(runtimePool)).resolves.toMatchObject({ superuser: false, bypassrls: false });
    } finally {
      await runtimePool.end();
    }
  }, 30_000);

  it("idempotent: trygt å kjøre om igjen - oppdaterer passord, ingen duplikat-rolle", async () => {
    const first = await ensureRuntimeRole(adminPool, { user: "jarvis_runtime_idem", password: "pw-first-abc" });
    expect(first.created).toBe(true);
    const second = await ensureRuntimeRole(adminPool, { user: "jarvis_runtime_idem", password: "pw-second-xyz" });
    expect(second.created).toBe(false);

    await expect(connectAs("jarvis_runtime_idem", "pw-first-abc").query("SELECT 1")).rejects.toBeDefined();
    const p2 = connectAs("jarvis_runtime_idem", "pw-second-xyz");
    try {
      await expect(p2.query("SELECT 1")).resolves.toBeDefined();
    } finally {
      await p2.end();
    }

    const count = await adminPool.query("SELECT COUNT(*)::int AS n FROM pg_roles WHERE rolname = 'jarvis_runtime_idem'");
    expect((count.rows[0] as { n: number }).n).toBe(1);
  }, 30_000);

  it("nekter å bootstrappe jarvis_app-gruppe-rollen selv som runtime-bruker", async () => {
    await expect(ensureRuntimeRole(adminPool, { user: "jarvis_app", password: "pw" })).rejects.toThrow(/jarvis_app_group_role/);
  });
});

describe("assertRuntimeRoleSafe fail-closed for usikre tilkoblinger", () => {
  it("kaster for en superbruker-tilkobling (root cause for host-blockeren)", async () => {
    await expect(assertRuntimeRoleSafe(adminPool)).rejects.toThrow(/runtime_db_role_unsafe/);
  });
});

describe("§10.J-K: RLS med den bootstrappede runtime-rollen", () => {
  it("J: tenant-RLS - runtime-rollen ser kun sin egen tenant-kontekst", async () => {
    await ensureRuntimeRole(adminPool, { user: "jarvis_runtime_jk", password: "pw-jk-tenant" });
    const runtimePool = connectAs("jarvis_runtime_jk", "pw-jk-tenant");
    try {
      await adminPool.query(
        "INSERT INTO tenants (tenant_id,name,kind) VALUES ('tenant-rr-a','A','person'),('tenant-rr-b','B','person') ON CONFLICT DO NOTHING"
      );
      const client = await runtimePool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('jarvis.tenant_id', 'tenant-rr-a', true)");
        const visible = await client.query("SELECT tenant_id FROM tenants ORDER BY tenant_id");
        expect(visible.rows.map((r: { tenant_id: string }) => r.tenant_id)).toEqual(["tenant-rr-a"]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    } finally {
      await runtimePool.end();
    }
  }, 30_000);

  it("K: memory-space-RLS (knowledge_documents) - runtime-rollen ser kun gyldig space", async () => {
    await ensureRuntimeRole(adminPool, { user: "jarvis_runtime_space", password: "pw-space-runtime" });
    const runtimePool = connectAs("jarvis_runtime_space", "pw-space-runtime");
    try {
      await adminPool.query("INSERT INTO tenants (tenant_id,name,kind) VALUES ('tenant-rr-space','S','person') ON CONFLICT DO NOTHING");
      await adminPool.query(
        `INSERT INTO knowledge_documents
           (knowledge_document_id, tenant_id, memory_space_id, source_type, source_instance_id, external_id,
            canonical_uri, title, content, content_type, content_hash, metadata)
         VALUES
           ('kd-rr-personal','tenant-rr-space','personal','test','fs:rr','p.md','p.md','p','personlig-innhold','text/plain','hash1111111111111111111111111111111111111111111111111111111111','{}'),
           ('kd-rr-business','tenant-rr-space','business','test','fs:rr','b.md','b.md','b','forretnings-innhold','text/plain','hash2222222222222222222222222222222222222222222222222222222222','{}')
         ON CONFLICT DO NOTHING`
      );
      const client = await runtimePool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('jarvis.tenant_id', 'tenant-rr-space', true), set_config('jarvis.memory_spaces', 'personal', true)"
        );
        const visible = await client.query("SELECT knowledge_document_id FROM knowledge_documents ORDER BY knowledge_document_id");
        expect(visible.rows.map((r: { knowledge_document_id: string }) => r.knowledge_document_id)).toEqual(["kd-rr-personal"]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    } finally {
      await runtimePool.end();
    }
  }, 30_000);
});

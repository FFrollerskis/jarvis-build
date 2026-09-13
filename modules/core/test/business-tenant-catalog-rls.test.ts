import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, listBusinessTenantIds, runMigrations } from "../src/index.ts";
import { allocateEmbeddedPostgresPort } from "../src/testing/embedded-postgres-port.ts";

/**
 * Q-27 (2026-08-18, D-65): mekanisk bevis for BÅDE bug-mekanismen OG fiksen
 * bak den nye `jarvis_list_business_tenant_ids()` SECURITY DEFINER-
 * katalogfunksjonen (`023_business_tenant_catalog.sql`). Speiler EKSAKT
 * samme A/B/rolle-sikkerhet/kilde-verifiserings-mønster som
 * `modules/business/test/business-event-sync-audit-rls.test.ts` (D-59) og
 * `modules/business/test/scoring-idempotency-rls.test.ts` (D-62) - samme
 * feilklasse, denne gangen i selve `tenants`-katalogoppslaget som tre
 * produksjons-schedulere er avhengige av (se D-65).
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let outsiderPool: pg.Pool;

const TENANT_BIZ_A = "tenant-q27-catalog-biz-a";
const TENANT_BIZ_B = "tenant-q27-catalog-biz-b";
const TENANT_PERSON = "tenant-q27-catalog-person";

let emptyResultTenantIds: string[] | undefined;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-q27-catalog-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_q27_catalog_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_q27_catalog_test");
  // Utenforstaaende rolle - IKKE medlem av jarvis_app, INGEN eksplisitt GRANT
  // - beviser at REVOKE ALL FROM PUBLIC faktisk stopper en tilfeldig rolle,
  // ikke bare rollen vi allerede har testet.
  await adminPool.query("CREATE ROLE jarvis_q27_outsider_test LOGIN PASSWORD 'pw3' NOSUPERUSER NOBYPASSRLS");

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_q27_catalog_test", password: "pw2" });
  outsiderPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_q27_outsider_test", password: "pw3" });

  // J: FØR noen bedrifts-tenant i det hele tatt finnes - beviser en gyldig
  // TOM mengde (ikke en feil) helt fra starten.
  emptyResultTenantIds = await listBusinessTenantIds(appPool, 200);

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES
       ('${TENANT_BIZ_A}', 'Q27 Catalog Biz A', 'business'),
       ('${TENANT_BIZ_B}', 'Q27 Catalog Biz B', 'business'),
       ('${TENANT_PERSON}', 'Q27 Catalog Person', 'person')`
  );

  // G: en "decoy"-skjema med en falsk tenants-tabell FORAN public i søkeveien
  // - beviser at funksjonens EGEN `SET search_path = public` faktisk
  // beskytter den mot en manipulert kaller-søkevei, ikke bare i teorien.
  await adminPool.query("CREATE SCHEMA decoy_search_path");
  await adminPool.query("CREATE TABLE decoy_search_path.tenants (tenant_id text, name text, kind text)");
  await adminPool.query(
    "INSERT INTO decoy_search_path.tenants (tenant_id, name, kind) VALUES ('evil-decoy-tenant', 'Decoy', 'business')"
  );
  await adminPool.query("GRANT USAGE ON SCHEMA decoy_search_path TO jarvis_app");
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await outsiderPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: RLS-BLIND rå spørring (den opprinnelige Q-27-bugen) reproduseres mekanisk", () => {
  it("en rå appPool.query mot tenants under den ekte non-bypass rollen finner 0 rader, til tross for at radene BEVISLIG finnes (adminPool ser dem)", async () => {
    const viaAdmin = await adminPool.query("SELECT tenant_id FROM tenants WHERE kind = 'business'");
    expect(viaAdmin.rows.length).toBe(2);

    const viaRawRuntimeQuery = await appPool.query("SELECT tenant_id FROM tenants WHERE kind = 'business'");
    // Dette ER selve Q-27-bug-mekanismen - strukturelt 0 rader, ikke fordi dataene mangler.
    expect(viaRawRuntimeQuery.rows.length).toBe(0);
  });
});

describe("B/C/I: jarvis_list_business_tenant_ids() finner KUN bedrifts-tenants, aldri person-tenants", () => {
  it("returnerer begge business-tenant-IDene, ekskluderer person-tenanten", async () => {
    const tenantIds = await listBusinessTenantIds(appPool, 200);
    expect(tenantIds.sort()).toEqual([TENANT_BIZ_A, TENANT_BIZ_B].sort());
    expect(tenantIds).not.toContain(TENANT_PERSON);
  });
});

describe("D: minimal overflate - funksjonen eksponerer KUN tenant_id, ingen andre tenant-kolonner", () => {
  it("rå spørring mot katalogfunksjonen returnerer rader med NØYAKTIG én kolonne (tenant_id)", async () => {
    const result = await appPool.query("SELECT * FROM jarvis_list_business_tenant_ids($1)", [200]);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(Object.keys(row as object)).toEqual(["tenant_id"]);
    }
  });
});

describe("E/F: utenforstaaende rolle (ikke medlem av jarvis_app, ingen eksplisitt GRANT) nektes EXECUTE - PUBLIC har ingen tilgang", () => {
  it("outsiderPool sitt kall mot katalogfunksjonen feiler med permission denied", async () => {
    await expect(outsiderPool.query("SELECT tenant_id FROM jarvis_list_business_tenant_ids($1)", [200])).rejects.toThrow(
      /permission denied/i
    );
  });
});

describe("G: search_path er sikret av funksjonen selv (SET search_path = public), uavhengig av kallerens egen søkevei", () => {
  it("en 'decoy'-tenants-tabell FORAN public i kallerens søkevei korrumperer ALDRI resultatet - funksjonen ser fortsatt KUN de ekte bedrifts-tenantene", async () => {
    const client = await appPool.connect();
    try {
      await client.query("SET search_path TO decoy_search_path, public");
      const result = await client.query("SELECT tenant_id FROM jarvis_list_business_tenant_ids($1)", [200]);
      const tenantIds = (result.rows as Array<{ tenant_id: string }>).map((r) => r.tenant_id).sort();
      expect(tenantIds).toEqual([TENANT_BIZ_A, TENANT_BIZ_B].sort());
      expect(tenantIds).not.toContain("evil-decoy-tenant");
    } finally {
      // Aldri la endret sesjonstilstand lekke til neste test via samme pool-tilkobling.
      await client.query("RESET search_path").catch(() => undefined);
      client.release();
    }
  });
});

describe("H: Q-21 uendret - jarvis_q27_catalog_test forblir NOSUPERUSER/NOBYPASSRLS", () => {
  it("rollen som brukte katalogfunksjonen har fortsatt rolsuper=false og rolbypassrls=false", async () => {
    const { rows } = await adminPool.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'jarvis_q27_catalog_test'"
    );
    const role = rows[0] as { rolsuper: boolean; rolbypassrls: boolean };
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });
});

describe("J: en gyldig TOM bedrifts-tenant-mengde er IKKE en feil (bevist FØR noen tenant fantes)", () => {
  it("listBusinessTenantIds() ga et tomt array, ikke et kastet unntak, da ingen bedrifts-tenants fantes ennå", () => {
    expect(emptyResultTenantIds).toEqual([]);
  });
});

describe("Bounded limit - LIMIT håndheves av funksjonen selv, ikke av kallende TypeScript-kode", () => {
  it("et lavere limit enn antall business-tenants begrenser faktisk resultatet", async () => {
    const tenantIds = await listBusinessTenantIds(appPool, 1);
    expect(tenantIds.length).toBe(1);
  });
});

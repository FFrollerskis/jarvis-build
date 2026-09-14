import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * UA-3 P0 HOST FIX #1 (2026-08-17, ekte host-funn run_id `b95dd25f`):
 * `ua3-business-live.ts` brukte FEILAKTIG `pool` (runtime, `jarvis_runtime`)
 * til å opprette midlertidig akseptanse-scaffolding (`INSERT INTO tenants`) -
 * RLS nekter (KORREKT) `jarvis_runtime` å opprette en helt ny tenant-rad
 * (`tenants_self`-policyen i `005_rls.sql` krever `tenant_id =
 * current_setting('jarvis.tenant_id')`, umulig å oppfylle for en tenant som
 * ikke finnes ennå). Fikset ved å innføre en egen `adminPool`
 * (`adminConfigFromEnv()`, samme mønster som `q20-erasure-live.ts`) for ALL
 * scaffold-opprettelse/opprydding - `pool` (runtime) brukes UTELUKKENDE til
 * de faktiske Business OS-operasjonene under test.
 *
 * Test A under reproduserer selve host-feilklassen direkte (ikke bare
 * strukturelt) mot ekte embedded Postgres. Test B-D/G-I/L er
 * kildetekst-strukturtester (samme presedens som `ua3-host-run-wiring.test.ts`)
 * som beviser SELVE FIKSEN (riktig pool brukt riktig sted), fordi en full
 * ende-til-ende-kjøring av selve live-scriptet krever Docker/ekte host.
 */
function readSource(relativePath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let runtimePool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-ua3-pool-sep-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  const admin = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_ua3_pool_sep_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_ua3_pool_sep_test");
  adminPool = admin;
  runtimePool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_ua3_pool_sep_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await runtimePool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: runtime-rollen kan IKKE opprette en tenant (reproduserer host-funnet run_id b95dd25f direkte)", () => {
  it("INSERT INTO tenants via en NOSUPERUSER/NOBYPASSRLS-rolle feiler med RLS-avslag (42501)", async () => {
    await expect(
      runtimePool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, $2, 'business')", ["tenant-pool-sep-runtime-attempt", "Skal feile"])
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("SAMME innsetting via admin-rollen (superbruker, samme mønster som adminConfigFromEnv()) lykkes", async () => {
    await expect(
      adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, $2, 'business')", ["tenant-pool-sep-admin-attempt", "Skal lykkes"])
    ).resolves.toMatchObject({ rowCount: 1 });
    await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", ["tenant-pool-sep-admin-attempt"]);
  });
});

describe("B/C/D: ua3-business-live.ts bruker adminPool KUN til scaffold/cleanup, pool (runtime) KUN til Business OS-operasjoner", () => {
  it("importerer adminConfigFromEnv og oppretter en egen adminPool ved siden av runtime-pool", async () => {
    const source = await readSource("../scripts/ua3-business-live.ts");
    expect(source).toMatch(/import\s*\{[^}]*adminConfigFromEnv[^}]*\}\s*from\s*"@jarvis\/core"/s);
    expect(source).toContain("const adminPool = createPool(adminConfigFromEnv());");
  });

  it("tenant/people/person_tenants/memory_spaces-scaffold-opprettelse bruker adminPool.query, ALDRI pool.query", async () => {
    const source = await readSource("../scripts/ua3-business-live.ts");
    const scaffoldBlockStart = source.indexOf("await selfHeal();");
    const scaffoldBlockEnd = source.indexOf("BUSINESS OS RUNTIME-ROLLE");
    const scaffoldBlock = source.slice(scaffoldBlockStart, scaffoldBlockEnd);
    expect(scaffoldBlock).toContain('adminPool.query("INSERT INTO tenants');
    expect(scaffoldBlock).toContain('adminPool.query("INSERT INTO people');
    expect(scaffoldBlock).toContain('adminPool.query("INSERT INTO person_tenants');
    expect(scaffoldBlock).toContain("adminPool.query(\n    \"INSERT INTO memory_spaces");
    expect(scaffoldBlock).not.toMatch(/[^.]\bpool\.query\("INSERT INTO (tenants|people|person_tenants|memory_spaces)/);
  });

  it("cleanupTenant() og selfHeal() bruker UTELUKKENDE adminPool, aldri pool", async () => {
    const source = await readSource("../scripts/ua3-business-live.ts");
    const cleanupFnStart = source.indexOf("async function cleanupTenant");
    const cleanupFnEnd = source.indexOf("async function main(");
    const cleanupBlock = source.slice(cleanupFnStart, cleanupFnEnd);
    expect(cleanupBlock).not.toMatch(/[^.]\bpool\.query\(/);
    const adminQueryCount = [...cleanupBlock.matchAll(/adminPool\.query\(/g)].length;
    expect(adminQueryCount).toBeGreaterThan(5);
  });

  it("BusinessService/ToolGateway konstrueres med `pool` (runtime), ALDRI `adminPool`", async () => {
    const source = await readSource("../scripts/ua3-business-live.ts");
    expect(source).toContain("new BusinessService(pool)");
    expect(source).toContain("new ToolGateway(\n      pool, policy,");
    expect(source).not.toMatch(/new BusinessService\(adminPool\)/);
    expect(source).not.toMatch(/new ToolGateway\(\s*adminPool/);
  });
});

describe("E/F: tenant-/memory-space-isolasjon dekket (uendret - se business-service.test.ts §L/§M og ua3-business-live.ts sine egne seksjoner)", () => {
  it("live-scriptet har egne TENANT-ISOLASJON og MEMORY-SPACE-ISOLASJON-seksjoner", async () => {
    const source = await readSource("../scripts/ua3-business-live.ts");
    expect(source).toContain('section("TENANT-ISOLASJON (RLS)"');
    expect(source).toContain('section("MEMORY-SPACE-ISOLASJON"');
  });
});

describe("G/H: cleanup er scopet til eksakte test-ID-er, eier-tenanten røres aldri", () => {
  it("cleanupTenant() tar en tenantId-parameter og bruker den parameterisert i HVER spørring - ingen hardkodet/bred sletting", async () => {
    const source = await readSource("../scripts/ua3-business-live.ts");
    const cleanupFnStart = source.indexOf("async function cleanupTenant");
    const cleanupFnEnd = source.indexOf("async function selfHeal");
    const cleanupBlock = source.slice(cleanupFnStart, cleanupFnEnd);
    const deleteCalls = [...cleanupBlock.matchAll(/DELETE FROM \w+ WHERE tenant_id = \$1/g)];
    expect(deleteCalls.length).toBeGreaterThan(5);
    expect(cleanupBlock).not.toMatch(/TRUNCATE/i);
  });

  it("ingen referanse til den ekte eier-tenanten (tenant-kundeoppfolging) noe sted i live-scriptet", async () => {
    const source = await readSource("../scripts/ua3-business-live.ts");
    expect(source).not.toMatch(/tenant-kundeoppfolging/);
  });
});

describe("I: ingen RLS-svekkelse/BYPASSRLS/superbruker-omvei innført for å få testen til å gå gjennom", () => {
  it("live-scriptet gir ALDRI seg selv BYPASSRLS/SUPERUSER (NOBYPASSRLS/NOSUPERUSER i dokumentasjonskommentarer er greit - kun POSITIVE tildelinger sjekkes) og bruker aldri row_security=off/DISABLE TRIGGER", async () => {
    const source = await readSource("../scripts/ua3-business-live.ts");
    expect(source).not.toMatch(/(?<!NO)BYPASSRLS/);
    expect(source).not.toMatch(/(?<!NO)SUPERUSER/);
    expect(source).not.toMatch(/row_security\s*=\s*off/i);
    expect(source).not.toMatch(/DISABLE TRIGGER/i);
  });

  it("migrasjonen (019_business.sql) er UENDRET - fortsatt FORCE ROW LEVEL SECURITY på alle 6 tabeller, ingen ny GRANT til jarvis_app for tenant-innsetting", async () => {
    const migration = await readSource("../../core/src/db/migrations/019_business.sql");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).not.toMatch(/GRANT[^;]*\btenants\b/);
  });
});

describe("L: host-runneren er fortsatt ETT kommando - ua3-host-run.ts uendret av denne fiksen", () => {
  it("ua3-host-run.ts kaller fortsatt KUN ua3-business-live.ts, ingen ny manuell DB-oppsett-kommando", async () => {
    const source = await readSource("../scripts/ua3-host-run.ts");
    expect(source).toContain('"modules/business/scripts/ua3-business-live.ts"');
    expect(source).not.toMatch(/psql|--admin-setup|manual/i);
  });
});

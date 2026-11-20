import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/index.ts";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * D163/D164 - rekonsiliering av PR #83 (UA-9, `055_vision.sql`) mot en main
 * som allerede har PR #85 (UA-10, `056_situations.sql`).
 *
 * Arkitektens krav (review 5229519184 på PR #86): «bevise at migrasjonsbanene
 * 056→055 og 055→056 er semantisk ekvivalente». To reelle baner finnes:
 *
 *   A  FERSK database (CI, ny host):   ... 054 -> 055_vision -> 056_situations
 *   B  EKSISTERENDE host som allerede kjørte main (uten 055):
 *      ... 054 -> 056_situations, og deretter - når den rekonsilierte branchen
 *      deployes - KUN 055_vision (migratoren hopper over navn som allerede
 *      står i `schema_migrations`).
 *
 * Beviset kjører BEGGE banene mot hver sin EKTE embedded Postgres-klynge (egen
 * klynge per bane fordi migrasjonene oppretter klynge-globale roller) og
 * sammenligner et deterministisk KATALOG-snapshot (kolonner, constraints med
 * definisjon, indekser, RLS-policyer og -flagg, grants, triggere, funksjoner,
 * roller, samt settet av anvendte migrasjonsnavn). Ingen `pg_dump`-avhengighet
 * - den bundlede embedded-postgres-en har ikke binæren, og CI skal ikke være
 * avhengig av en vertsinstallert klient.
 *
 * I tillegg: en ren, DB-fri vakt for at migrasjonskatalogen har ÉN
 * deterministisk rekkefølge (unike 3-sifrede prefikser, 055 rett før 056).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const VISION = "055_vision.sql";
const SITUATIONS = "056_situations.sql";
/**
 * Rekonsiliering av PR #86 (UA-10 P1) mot main etter at PR #83 (UA-9) er merget:
 * katalogen har nå 054 -> 055 -> 056 -> 057. Den tredje reelle banen er en host
 * som allerede kjører main (055 + 056 anvendt) og får KUN 057 ved neste
 * oppstart - den må gi samme skjema som en fersk install av hele katalogen.
 */
const ACTIVATION = "057_situations_activation.sql";

interface SchemaSnapshot {
  columns: unknown[];
  constraints: unknown[];
  indexes: unknown[];
  policies: unknown[];
  rls_flags: unknown[];
  grants: unknown[];
  triggers: unknown[];
  functions: unknown[];
  roles: unknown[];
  applied_migrations: string[];
}

async function snapshotSchema(pool: pg.Pool): Promise<SchemaSnapshot> {
  const q = async (sql: string): Promise<unknown[]> => (await pool.query(sql)).rows;
  return {
    columns: await q(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default,
              character_maximum_length, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`
    ),
    constraints: await q(
      `SELECT conrelid::regclass::text AS table_name, conname, contype, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
        ORDER BY 1, 2`
    ),
    indexes: await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`),
    policies: await q(
      `SELECT tablename, policyname, permissive, roles::text AS roles, cmd, qual, with_check
         FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2`
    ),
    rls_flags: await q(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1`
    ),
    grants: await q(
      `SELECT table_name, grantee, privilege_type, is_grantable
         FROM information_schema.role_table_grants WHERE table_schema = 'public' ORDER BY 1, 2, 3`
    ),
    triggers: await q(
      `SELECT tgrelid::regclass::text AS table_name, tgname, pg_get_triggerdef(oid) AS definition
         FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`
    ),
    functions: await q(
      `SELECT proname, pg_get_function_identity_arguments(oid) AS args, pg_get_functiondef(oid) AS definition, prosecdef
         FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1, 2`
    ),
    roles: await q(
      `SELECT rolname, rolcanlogin, rolbypassrls, rolsuper, rolinherit
         FROM pg_roles WHERE rolname LIKE 'jarvis%' ORDER BY 1`
    ),
    applied_migrations: ((await pool.query(`SELECT name FROM schema_migrations ORDER BY name`)).rows as { name: string }[]).map((r) => r.name)
  };
}

interface Cluster {
  pool: pg.Pool;
  stop: () => Promise<void>;
}

async function startCluster(label: string): Promise<Cluster> {
  const dir = await mkdtemp(join(tmpdir(), `jarvis-pg-migorder-${label}-`));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  await leased.postgres.createDatabase("jarvis_test");
  const pool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  pool.on("error", () => undefined);
  return {
    pool,
    stop: async () => {
      await pool.end();
      await leased.stop();
    }
  };
}

/** En kopi av migrasjonskatalogen, valgfritt uten enkelte filer - migratoren leser kun `dir`. */
async function migrationDirCopy(exclude: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-migrations-copy-"));
  for (const file of await readdir(MIGRATIONS_DIR)) {
    if (exclude.includes(file)) continue;
    await cp(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  return dir;
}

async function sortedMigrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
}

/**
 * WP-G3 (D-465): migrasjoner (133-137: kameraer, bilder, vektorer/inventar, opptak, åpningshendelse) som BYGGER PÅ tabellene 055 oppretter (`vision_*`, kommentarer ignoreres). En host som ikke har kjørt 055
 * kan ikke ha anvendt dem - i bane B følger de derfor med 055 (første kjøring uten dem, andre kjøring legger til 055 og dem i katalogrekkefølge). Uten dette feilet bane B med «relation vision_rooms does not exist».
 */
async function visionDependents(): Promise<string[]> {
  const dependents: string[] = [];
  for (const file of await sortedMigrationFiles()) {
    if (file <= VISION) continue; // kun migrasjoner ETTER 055 kan bygge på den
    const sql = (await readFile(join(MIGRATIONS_DIR, file), "utf8")).split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
    if (/\bvision_[a-z_]+\b/.test(sql)) dependents.push(file);
  }
  return dependents;
}

describe("Migrasjonskatalogen har ÉN deterministisk rekkefølge (ren vakt)", () => {
  it("ingen dupliserte 3-sifrede prefikser; 055_vision står umiddelbart før 056_situations", async () => {
    const files = await sortedMigrationFiles();
    const prefixes = files.map((f) => f.slice(0, 3));
    const duplicates = prefixes.filter((p, i) => prefixes.indexOf(p) !== i);
    expect(duplicates, `dupliserte migrasjons-ID-er: ${duplicates.join(", ")}`).toEqual([]);
    expect(files).toContain(VISION);
    expect(files).toContain(SITUATIONS);
    expect(files).toContain(ACTIVATION);
    expect(files.indexOf(SITUATIONS)).toBe(files.indexOf(VISION) + 1);
    expect(files.indexOf(ACTIVATION)).toBe(files.indexOf(SITUATIONS) + 1);
  });
});

describe("Banene 055->056 (fersk) og 056->055 (eksisterende host) gir samme skjema (ekte Postgres, to klynger)", () => {
  let fresh: Cluster;
  let host: Cluster;
  let freshApplied: string[] = [];
  let hostFirstApplied: string[] = [];
  let hostSecondApplied: string[] = [];
  let dependents: string[] = [];
  const tempDirs: string[] = [];

  beforeAll(async () => {
    fresh = await startCluster("fresh");
    host = await startCluster("host");

    // A: fersk database - hele katalogen i sortert rekkefølge.
    const fullDir = await migrationDirCopy([]);
    tempDirs.push(fullDir);
    freshApplied = await runMigrations(fresh.pool, fullDir);

    // B: en host som allerede kjørte main (uten 055 - og dermed uten migrasjonene som bygger på 055) ...
    dependents = await visionDependents();
    const withoutVision = await migrationDirCopy([VISION, ...dependents]);
    tempDirs.push(withoutVision);
    hostFirstApplied = await runMigrations(host.pool, withoutVision);
    // ... og deretter deployes den rekonsilierte branchen: KUN 055 (og det som bygger på den) legges til.
    hostSecondApplied = await runMigrations(host.pool, fullDir);
  });

  afterAll(async () => {
    await fresh?.stop();
    await host?.stop();
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  });

  it("bane A kjørte 055 rett før 056; bane B kjørte 056 først og deretter NØYAKTIG 055 (pluss migrasjonene som bygger på den) alene", () => {
    expect(freshApplied.indexOf(SITUATIONS)).toBe(freshApplied.indexOf(VISION) + 1);
    expect(hostFirstApplied).toContain(SITUATIONS);
    expect(hostFirstApplied).not.toContain(VISION);
    for (const file of dependents) expect(hostFirstApplied, file).not.toContain(file);
    expect(hostSecondApplied).toEqual([VISION, ...dependents]);
  });

  it("katalog-snapshotene er identiske: kolonner, constraints, indekser, RLS, grants, triggere, funksjoner, roller, anvendte migrasjoner", async () => {
    const a = await snapshotSchema(fresh.pool);
    const b = await snapshotSchema(host.pool);
    // Snapshotet må faktisk inneholde begge domenene - et tomt/blindt snapshot skal aldri passere.
    const tables = new Set((a.columns as { table_name: string }[]).map((c) => c.table_name));
    expect(tables.has("vision_event_observations")).toBe(true);
    expect(tables.has("situations")).toBe(true);
    expect(a.applied_migrations).toContain(VISION);
    expect(a.applied_migrations).toContain(SITUATIONS);
    expect(b).toEqual(a);
  });
});

describe("Banen «main (055+056) så KUN 057» gir samme skjema som fersk install av hele katalogen (ekte Postgres, to klynger)", () => {
  let fresh: Cluster;
  let host: Cluster;
  let freshApplied: string[] = [];
  let hostFirstApplied: string[] = [];
  let hostSecondApplied: string[] = [];
  const tempDirs: string[] = [];

  beforeAll(async () => {
    fresh = await startCluster("fresh057");
    host = await startCluster("host057");

    // A: fersk database - hele katalogen (054 -> 055 -> 056 -> 057) i sortert rekkefølge.
    const fullDir = await migrationDirCopy([]);
    tempDirs.push(fullDir);
    freshApplied = await runMigrations(fresh.pool, fullDir);

    // B: en host som allerede kjører dagens main (055 og 056 anvendt, uten 057) ...
    const withoutActivation = await migrationDirCopy([ACTIVATION]);
    tempDirs.push(withoutActivation);
    hostFirstApplied = await runMigrations(host.pool, withoutActivation);
    // ... og deretter deployes PR #86: KUN 057 legges til.
    hostSecondApplied = await runMigrations(host.pool, fullDir);
  });

  afterAll(async () => {
    await fresh?.stop();
    await host?.stop();
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  });

  it("bane A kjørte 055 -> 056 -> 057 i rekkefølge; bane B kjørte 055+056 først og deretter NØYAKTIG 057 alene", () => {
    expect(freshApplied.indexOf(SITUATIONS)).toBe(freshApplied.indexOf(VISION) + 1);
    expect(freshApplied.indexOf(ACTIVATION)).toBe(freshApplied.indexOf(SITUATIONS) + 1);
    expect(hostFirstApplied).toContain(VISION);
    expect(hostFirstApplied).toContain(SITUATIONS);
    expect(hostFirstApplied).not.toContain(ACTIVATION);
    expect(hostSecondApplied).toEqual([ACTIVATION]);
  });

  it("katalog-snapshotene er identiske og inneholder vision, situations OG aktiveringsflaten (057)", async () => {
    const a = await snapshotSchema(fresh.pool);
    const b = await snapshotSchema(host.pool);
    const tables = new Set((a.columns as { table_name: string }[]).map((c) => c.table_name));
    expect(tables.has("vision_event_observations")).toBe(true);
    expect(tables.has("situations")).toBe(true);
    expect(tables.has("situation_autonomy_policies")).toBe(true);
    const situationColumns = (a.columns as { table_name: string; column_name: string }[])
      .filter((c) => c.table_name === "situations")
      .map((c) => c.column_name);
    expect(situationColumns).toContain("inform_message");
    expect(situationColumns).toContain("inform_delivered_at");
    expect(a.applied_migrations).toContain(ACTIVATION);
    expect(b).toEqual(a);
  });
});

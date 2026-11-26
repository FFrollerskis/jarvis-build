import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@jarvis/core";
import {
  SCHEMA_CLASSES,
  baselineClassMap,
  exceptionKey,
  extractCatalog,
  formatFailures,
  loadManifest,
  readMigrationFiles,
  runSchemaClassChecks,
  startLeasedEmbeddedPostgres,
  summarize,
  violationKey,
  type Manifest
} from "@jarvis/core/testing";

/**
 * WP-MC8a (HF3 MC-8 del a), KATALOGDELEN mot en ekte migrert Postgres: hver tabell har nøyaktig én klasse, og lint-reglene (FORCE RLS, policyer per
 * kommando med WITH CHECK, tenant-FK/indeks, GRANT, DEFINER-allowlist) holder - bortsett fra de kjente, begrunnede og nummererte baseline-unntakene
 * (som kan bare krympe). Uten unntakene må linten finne NØYAKTIG disse bruddene (bevis for at reglene faktisk ser dem).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const FILES = readMigrationFiles(MIGRATIONS_DIR);
const MANIFEST = loadManifest();

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-mc8a-classes-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
}, 240_000);

afterAll(async () => {
  await admin?.end();
  await stop?.();
}, 120_000);

describe("A: skjemaklassifisering + migrasjonslint mot det migrerte skjemaet", () => {
  it("ingen brudd: hver tabell har nøyaktig én klasse og alle ORG_OWNED/USER_OWNED/GLOBAL/PLATFORM-regler holder (modulo kjente unntak)", async () => {
    const result = await runSchemaClassChecks({ files: FILES, manifest: MANIFEST, db: admin });
    console.info(`[mc8a] ${summarize(result).join(" | ")}`);
    expect(formatFailures(result.failures)).toBe("(ingen)");
    expect(result.mode).toBe("static+catalog");
    expect(result.classes.size).toBe(result.catalog?.relations.filter((r) => r.schema === "public" && r.kind === "r").length);
    for (const [table, klass] of baselineClassMap(MANIFEST)) expect(result.classes.get(table)?.class, table).toBe(klass);
  });

  it("uten baseline-unntak finner linten NØYAKTIG de kjente bruddene (ikke flere, ikke færre) - reglene ser dem faktisk", async () => {
    const stripped = { ...MANIFEST, exceptions: [], exception_ceiling: { total: 0, per_rule: {} } } as unknown as Manifest;
    const result = await runSchemaClassChecks({ files: FILES, manifest: stripped, db: admin });
    const found = result.failures.map((f) => violationKey(f)).sort();
    const known = MANIFEST.exceptions.map((e) => exceptionKey(e.rule, e.table, e.detail)).sort();
    expect(found).toEqual(known);
    expect(found.length).toBe(MANIFEST.exceptions.length);
    expect(result.known).toEqual([]);
  });

  it("antall kjente unntak per regel er det manifestet lover (taket), og hvert unntak har funn-ID og begrunnelse", async () => {
    const result = await runSchemaClassChecks({ files: FILES, manifest: MANIFEST, db: admin });
    expect(result.known.length).toBe(MANIFEST.exceptions.length);
    expect(MANIFEST.exceptions.length).toBeLessThanOrEqual(MANIFEST.exception_ceiling.total);
    for (const ex of MANIFEST.exceptions) {
      expect(ex.finding, `${ex.rule}:${ex.table}`).toMatch(/^MC8a-F\d+$/);
      expect(ex.reason.length, `${ex.rule}:${ex.table}`).toBeGreaterThan(30);
    }
  });

  it("katalogutdraget ser runtime-rollen jarvis_app (NOLOGIN, ikke superuser/BYPASSRLS) og alle klasser er i bruk", async () => {
    const catalog = await extractCatalog(admin);
    expect(catalog.runtimeRoleRecord).toMatchObject({ name: "jarvis_app", canLogin: false, superuser: false, bypassRls: false, createDb: false, createRole: false, replication: false });
    expect(catalog.runtimeMembers).toEqual([]);
    expect(catalog.runtimeCanCreateInPublic).toBe(false);
    const result = await runSchemaClassChecks({ files: FILES, manifest: MANIFEST, db: admin });
    for (const klass of SCHEMA_CLASSES) expect(result.counts[klass], klass).toBeGreaterThan(0);
  });
});

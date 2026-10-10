import { copyFile, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { INCIDENT_TRANSITIONS } from "../src/state-machine.ts";

/**
 * WP-E1 (JARVIS-068): migrasjon 096-098 på en EKSISTERENDE database (med data fra før livssyklussporingen og sannhetstype-regimet) - ikke bare en fersk. Bevis:
 *  - bakfyll: hver gammel hendelse får nøyaktig én ærlig «historikk starter her»-rad,
 *  - tidligere selv-påstått «VERIFIED» (bevis og diagnoser) nedgraderes ærlig, mens det som kan bevises (deploy som finnes) beholder VERIFIED med grunnlag,
 *  - de nye begrensningene gjelder etter oppgraderingen, og en ny kjøring er et no-op,
 *  - SQL-ens lovlige overgangspar er identiske med tilstandsmaskinen i TypeScript.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../core/src/db/migrations", import.meta.url));
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let fullDir: string;
const T = "tenant-e1up";

beforeAll(async () => {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const legacyDir = await mkdtemp(join(tmpdir(), "jarvis-e1up-legacy-"));
  fullDir = await mkdtemp(join(tmpdir(), "jarvis-e1up-full-"));
  for (const f of files) {
    await copyFile(join(MIGRATIONS_DIR, f), join(fullDir, f));
    if (Number(f.slice(0, 3)) < 96) await copyFile(join(MIGRATIONS_DIR, f), join(legacyDir, f));
  }
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1up-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);

  // 1) Eksisterende database: alt FØR 096.
  await runMigrations(admin, legacyDir);
  const before = await admin.query(`SELECT to_regclass('incident_transitions') AS t`);
  expect((before.rows[0] as { t: string | null }).t).toBeNull();
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}', 'Up', 'business');
    INSERT INTO incidents (incident_id, tenant_id, memory_space_id, title, status, resolved_at) VALUES
      ('i-open', '${T}', 'business', 'åpen', 'open', NULL),
      ('i-res', '${T}', 'business', 'løst', 'resolved', now()),
      ('i-wf', '${T}', 'business', 'ikke fiks', 'wont_fix', NULL),
      ('i-prog', '${T}', 'project', 'pågår', 'repair_in_progress', NULL);
    INSERT INTO deployments (deployment_id, tenant_id, source, repo, commit_sha, status, deployed_at) VALUES ('dep-1', '${T}', 'manual', 'a/b', 'sha', 'success', now());
    INSERT INTO incident_evidence (evidence_id, tenant_id, memory_space_id, incident_id, source_type, status, source_ref, summary, observed_at) VALUES
      ('e-dep-ok', '${T}', 'business', 'i-open', 'deployment', 'VERIFIED', 'dep-1', 'deploy som finnes', now()),
      ('e-dep-gone', '${T}', 'business', 'i-open', 'deployment', 'VERIFIED', 'dep-borte', 'deploy som ikke finnes', now()),
      ('e-self', '${T}', 'business', 'i-open', 'manual', 'VERIFIED', NULL, 'selv-påstått', now()),
      ('e-prov', '${T}', 'business', 'i-open', 'log', 'PROVISIONAL', NULL, 'sannsynlig', now()),
      ('e-unv', '${T}', 'business', 'i-open', 'log', 'UNVERIFIED', NULL, 'påstått', now());
    INSERT INTO incident_diagnoses (diagnosis_id, tenant_id, memory_space_id, incident_id, conclusion, status, source) VALUES
      ('dx-model', '${T}', 'business', 'i-open', 'c', 'VERIFIED', 'model_assisted'),
      ('dx-owner', '${T}', 'business', 'i-open', 'c', 'VERIFIED', 'owner'),
      ('dx-det-ok', '${T}', 'business', 'i-open', 'c', 'VERIFIED', 'deterministic'),
      ('dx-det-weak', '${T}', 'business', 'i-open', 'c', 'VERIFIED', 'deterministic'),
      ('dx-det-none', '${T}', 'business', 'i-open', 'c', 'VERIFIED', 'deterministic');
    INSERT INTO incident_diagnosis_evidence (tenant_id, diagnosis_id, evidence_id, relation) VALUES
      ('${T}', 'dx-det-ok', 'e-dep-ok', 'supports'), ('${T}', 'dx-det-weak', 'e-self', 'supports');
  `);

  // 2) Oppgrader: 096-098 anvendes på de eksisterende dataene.
  const applied = await runMigrations(admin, fullDir);
  // Senere migrasjoner (099+ fra andre arbeidspakker) anvendes også; testen gjelder at 096-098 kommer først og i rekkefølge.
  expect(applied.map((n) => n.slice(0, 3)).filter((n) => ["096", "097", "098"].includes(n))).toEqual(["096", "097", "098"]);
}, 300_000);

afterAll(async () => {
  await admin?.end();
  await stop?.();
}, 120_000);

describe("WP-E1: oppgradering av en eksisterende database (096-098)", () => {
  it("bakfyll: nøyaktig én ærlig startrad per gammel hendelse (system, fra null, til-status = dagens status)", async () => {
    const { rows } = await admin.query(`SELECT incident_id, from_status, to_status, actor_kind, actor_person_id, reason FROM incident_transitions WHERE tenant_id = $1 ORDER BY incident_id`, [T]);
    expect(rows).toHaveLength(4);
    const byId = Object.fromEntries((rows as Array<{ incident_id: string; to_status: string }>).map((r) => [r.incident_id, r]));
    expect(byId["i-open"]).toMatchObject({ from_status: null, to_status: "open", actor_kind: "system", actor_person_id: null });
    expect(byId["i-res"]?.to_status).toBe("resolved");
    expect(byId["i-wf"]?.to_status).toBe("wont_fix");
    expect(byId["i-prog"]?.to_status).toBe("repair_in_progress");
    expect((rows as Array<{ reason: string }>).every((r) => r.reason.includes("bakfylt"))).toBe(true);
    const incidents = await admin.query(`SELECT incident_id, source_kind, dedupe_key, correlation_id, occurrence_count FROM incidents WHERE tenant_id = $1`, [T]);
    expect((incidents.rows as Array<{ source_kind: string; dedupe_key: string | null; occurrence_count: number }>).every((r) => r.source_kind === "manual" && r.dedupe_key === null && r.occurrence_count === 1)).toBe(true);
  });

  it("selv-påstått VERIFIED bevis nedgraderes ærlig; deploy-bevis som kan bevises beholder VERIFIED med grunnlag", async () => {
    const { rows } = await admin.query(`SELECT evidence_id, status, asserted_by, verified_by, verification_basis, verified_at FROM incident_evidence WHERE tenant_id = $1`, [T]);
    const e = Object.fromEntries((rows as Array<{ evidence_id: string }>).map((r) => [r.evidence_id, r])) as Record<string, Record<string, unknown>>;
    expect(e["e-dep-ok"]).toMatchObject({ status: "VERIFIED", asserted_by: "owner", verified_by: "correlation_deployment_match" });
    expect(String(e["e-dep-ok"]?.["verification_basis"])).toContain("dep-1");
    expect(e["e-dep-ok"]?.["verified_at"]).not.toBeNull();
    expect(e["e-dep-gone"]).toMatchObject({ status: "PROVISIONAL", verified_by: null, verification_basis: null, verified_at: null });
    expect(e["e-self"]).toMatchObject({ status: "PROVISIONAL", verified_by: null });
    expect(e["e-prov"]?.["status"]).toBe("PROVISIONAL");
    expect(e["e-unv"]?.["status"]).toBe("UNVERIFIED");
  });

  it("diagnoser: modell -> UNVERIFIED, eier/uten VERIFIED støtte -> PROVISIONAL; deterministisk med VERIFIED støttebevis forblir VERIFIED", async () => {
    const { rows } = await admin.query(`SELECT diagnosis_id, status FROM incident_diagnoses WHERE tenant_id = $1`, [T]);
    const d = Object.fromEntries((rows as Array<{ diagnosis_id: string; status: string }>).map((r) => [r.diagnosis_id, r.status]));
    expect(d).toEqual({ "dx-model": "UNVERIFIED", "dx-owner": "PROVISIONAL", "dx-det-ok": "VERIFIED", "dx-det-weak": "PROVISIONAL", "dx-det-none": "PROVISIONAL" });
  });

  it("begrensningene gjelder på de eksisterende radene etter oppgraderingen (statusendring uten overgangsrad avvises)", async () => {
    await expect(admin.query(`UPDATE incidents SET status = 'diagnosing' WHERE incident_id = 'i-open'`)).rejects.toThrow(/incident_status_change_without_transition/);
    await expect(admin.query(`UPDATE incident_evidence SET status = 'VERIFIED' WHERE evidence_id = 'e-unv'`)).rejects.toThrow(/incident_evidence_verified_requires_basis/);
    await expect(admin.query(`UPDATE incident_evidence SET summary = 'omskrevet' WHERE evidence_id = 'e-dep-ok'`)).rejects.toThrow(/incident_evidence_content_immutable/);
    expect((await admin.query(`SELECT status FROM incidents WHERE incident_id = 'i-open'`)).rows[0]).toEqual({ status: "open" });
  });

  it("en ny kjøring er et no-op, og alle tre filer er registrert én gang", async () => {
    expect(await runMigrations(admin, fullDir)).toEqual([]);
    const { rows } = await admin.query(`SELECT name FROM schema_migrations WHERE name ~ '^09[678]_' ORDER BY name`);
    expect((rows as Array<{ name: string }>).map((r) => r.name)).toEqual(["096_incident_lifecycle.sql", "097_incident_truth_regime.sql", "098_incident_producer_runs.sql"]);
  });

  it("SQL-ens lovlige overgangspar er identiske med INCIDENT_TRANSITIONS (ingen drift mellom DB og TypeScript)", async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, "096_incident_lifecycle.sql"), "utf8");
    const block = sql.slice(sql.indexOf("ARRAY["), sql.indexOf("])", sql.indexOf("ARRAY[")));
    const inSql = [...block.matchAll(/'([a-z_]+>[a-z_]+)'/g)].map((m) => m[1]!).sort();
    const inCode = Object.entries(INCIDENT_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`)).sort();
    expect(inSql).toEqual(inCode);
  });
});

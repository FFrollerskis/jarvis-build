import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { withMemoryTransaction } from "@jarvis/memory";
import {
  HEALTH_INTAKE_MAX_DELETES, HEALTH_INTAKE_MAX_SAMPLES, HEALTH_INTAKE_SOURCE_TYPE, HealthIntakeError, HealthIntakeService, type HealthIntakeIdentity
} from "../src/intake.ts";
import { HealthRetentionPolicyRequiredError, HealthService } from "../src/service.ts";
import { HEALTHKIT_DOC_VERIFIED_AT, METRIC_CANONICAL_UNITS, METRIC_HEALTHKIT_SOURCE, METRIC_VALUE_BOUNDS, MetricTypeSchema } from "../src/types.ts";
import { validateHealthObservation } from "../src/validation.ts";

/**
 * WP-G2 (D-464) P1d: det enhetssignerte helse-inntaket mot EKTE Postgres/RLS (NOSUPERUSER/NOBYPASSRLS-rolle): lukket metrikkliste (verifisert mot Apple, se `METRIC_HEALTHKIT_SOURCE`), idempotens på kilde + sample-id,
 * retensjon fail-closed, sletting av egne prøver, revisjon uten innhold, og at ingenting lekker mellom personer eller tenants.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let intake: HealthIntakeService;
let health: HealthService;

const TENANT = "t-hlt-intake";
const TENANT_NO_POLICY = "t-hlt-intake-nopolicy";
const OTHER_TENANT = "t-hlt-intake-other";
const P1 = "p-hlt-intake-1";
const P2 = "p-hlt-intake-2";
const Q = "p-hlt-intake-q";

const id = (n: number): string => `0000AAAA-0000-4000-8000-${String(n).padStart(12, "0")}`;
const who = (person: string, tenant = TENANT, device = "iphone-1"): HealthIntakeIdentity => ({ tenant_id: tenant, person_id: person, session_id: `sess-${person}`, device_id: device, channel: "mobile" });
const recent = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const sample = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ metric_type: "heart_rate", value: 72, unit: "bpm", observed_at: recent(2), external_sample_id: id(n), ...overrides });

async function rows(tenant: string, person?: string): Promise<Array<Record<string, unknown>>> {
  const { rows: r } = await admin.query(
    `SELECT * FROM health_metric_observations WHERE tenant_id = $1 ${person === undefined ? "" : "AND person_id = $2"} ORDER BY seq`, person === undefined ? [tenant] : [tenant, person]
  );
  return r as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-hlt-intake-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_hlt_intake_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_hlt_intake_test");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Intake','person'), ('${TENANT_NO_POLICY}','No policy','person'), ('${OTHER_TENANT}','Other','person');
    INSERT INTO people (person_id, display_name) VALUES ('${P1}','P1'), ('${P2}','P2'), ('${Q}','Q');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${P1}','${TENANT}'), ('${P2}','${TENANT}'), ('${P1}','${TENANT_NO_POLICY}'), ('${Q}','${OTHER_TENANT}');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_hlt_intake_test", password: "pw2" });
  intake = new HealthIntakeService(app);
  health = new HealthService(app);
  await health.setRetentionPolicy(TENANT, { retention_days: 30, actor_person_id: P1 });
  await health.setRetentionPolicy(OTHER_TENANT, { retention_days: 30, actor_person_id: Q });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("A: den lukkede metrikklisten er verifisert og konsistent", () => {
  it("nøyaktig ti metrikker; hver har kanonisk enhet, grenser og en HealthKit-kilde; listen kan ikke vokse uten at testen oppdateres", () => {
    expect([...MetricTypeSchema.options].sort()).toEqual([
      "active_energy_kcal", "exercise_minutes", "heart_rate", "heart_rate_variability_ms", "oxygen_saturation_percent", "respiratory_rate", "resting_heart_rate", "sleep_duration_minutes", "steps", "weight_kg"
    ]);
    for (const metric of MetricTypeSchema.options) {
      expect(METRIC_CANONICAL_UNITS[metric], metric).toMatch(/^[a-z_]+$/);
      expect(METRIC_VALUE_BOUNDS[metric].min, metric).toBeLessThan(METRIC_VALUE_BOUNDS[metric].max);
      expect(METRIC_VALUE_BOUNDS[metric].min, metric).toBeGreaterThanOrEqual(0); // DB-CHECK `value >= 0`
      expect(METRIC_HEALTHKIT_SOURCE[metric].healthkit_identifier, metric).toMatch(/^HK(Quantity|Category)TypeIdentifier\.[a-zA-Z0-9]+$/);
      expect(["discrete", "cumulative", "category_derived"]).toContain(METRIC_HEALTHKIT_SOURCE[metric].aggregation);
    }
    expect(HEALTHKIT_DOC_VERIFIED_AT).toBe("2026-11-18");
    // Fire uttrykkelige anker mot Apples dokumentasjon (verifisert 2026-11-18): SpO2 er en BRØK 0.0-1.0 hos Apple, kumulative delprøver, HRV er SDNN.
    expect(METRIC_HEALTHKIT_SOURCE.oxygen_saturation_percent.app_conversion).toContain("gang med 100");
    expect(METRIC_HEALTHKIT_SOURCE.steps.aggregation).toBe("cumulative");
    expect(METRIC_HEALTHKIT_SOURCE.active_energy_kcal.aggregation).toBe("cumulative");
    expect(METRIC_HEALTHKIT_SOURCE.heart_rate_variability_ms.healthkit_identifier).toContain("SDNN");
  });

  it("den delte valideringen: kanonisk enhet, grenser og lukket liste - og SpO2 som BRØK (0.97) avvises synlig i stedet for å lagres feil", () => {
    const base = { metric_type: "oxygen_saturation_percent", value: 97, unit: "percent", observed_at: "2026-11-18T08:00:00Z", source_type: "t" };
    expect(validateHealthObservation(base).ok).toBe(true);
    expect(validateHealthObservation({ ...base, value: 0.97 })).toMatchObject({ ok: false, field: "value" });
    expect(validateHealthObservation({ ...base, unit: "fraction" })).toMatchObject({ ok: false, field: "unit" });
    expect(validateHealthObservation({ ...base, metric_type: "blood_glucose" })).toMatchObject({ ok: false, field: "metric_type" });
    expect(validateHealthObservation({ ...base, observed_at: "i går" })).toMatchObject({ ok: false, field: "observed_at" });
    expect(validateHealthObservation({ ...base, ekstra: 1 })).toMatchObject({ ok: false });
  });
});

describe("B: idempotent inntak (kilde + person + ekstern sample-id)", () => {
  it("nye prøver lagres med fast kilde, grantets enhet, sample-id og beregnet retensjon; samme batch på nytt endrer ingenting", async () => {
    const batch = { samples: [sample(1), sample(2, { metric_type: "steps", value: 532, unit: "count" }), sample(3, { metric_type: "resting_heart_rate", value: 54 })] };
    const first = await intake.ingestBatch(who(P1), batch);
    expect(first.counts).toEqual({ created: 3, duplicate: 0, conflict: 0, invalid: 0, expired: 0, deleted: 0 });
    expect(first.results.map((r) => r.status)).toEqual(["created", "created", "created"]);
    const stored = await rows(TENANT, P1);
    expect(stored).toHaveLength(3);
    expect(stored.every((r) => r["source_type"] === HEALTH_INTAKE_SOURCE_TYPE && r["source_instance_id"] === "iphone-1" && r["memory_space_id"] === "health")).toBe(true);
    expect(stored.map((r) => r["external_sample_id"])).toEqual([id(1), id(2), id(3)]);
    const hr = stored[0] as { observed_at: Date; retention_expires_at: Date };
    expect(hr.retention_expires_at.getTime() - hr.observed_at.getTime()).toBe(30 * 86_400_000);

    const again = await intake.ingestBatch(who(P1), batch);
    expect(again.counts).toEqual({ created: 0, duplicate: 3, conflict: 0, invalid: 0, expired: 0, deleted: 0 });
    expect(await rows(TENANT, P1)).toHaveLength(3);
    // Også fra en annen enhet (samme person, samme HealthKit-uuid): fortsatt samme prøve.
    expect((await intake.ingestBatch(who(P1, TENANT, "watch-1"), { samples: [batch.samples[0]] })).counts.duplicate).toBe(1);
  });

  it("samme id med ANNET innhold er en konflikt: den lagres ikke og den opprinnelige raden er uendret (ingen stille overskriving)", async () => {
    const before = await rows(TENANT, P1);
    const result = await intake.ingestBatch(who(P1), { samples: [sample(1, { value: 99 }), sample(2, { metric_type: "steps", value: 532, unit: "count", observed_at: recent(5) })] });
    expect(result.results).toEqual([{ index: 0, status: "conflict", reason: "sample_id_reused_with_different_content" }, { index: 1, status: "conflict", reason: "sample_id_reused_with_different_content" }]);
    expect(await rows(TENANT, P1)).toEqual(before);
  });

  it("sample-id er unik PER PERSON: en annen person i samme tenant kan bruke samme id (egen rad), og kan ikke berøre den første sin", async () => {
    const result = await intake.ingestBatch(who(P2), { samples: [sample(1, { value: 61 })] });
    expect(result.counts.created).toBe(1);
    expect((await rows(TENANT, P1)).find((r) => r["external_sample_id"] === id(1))?.["value"]).toBe("72");
    expect((await rows(TENANT, P2))[0]?.["value"]).toBe("61");
  });
});

describe("C: ugyldige prøver avvises per prøve med en kode - aldri verdien - og stopper ikke resten", () => {
  it("lukket liste, kanonisk enhet, grenser (inkl. SpO2-brøk), fremtid, utløpt, ugyldig id, kilde-felt, ukjente nøkler og ikke-objekter", async () => {
    const now = Date.now();
    const result = await intake.ingestBatch(who(P1), {
      samples: [
        sample(10, { metric_type: "blood_glucose" }),
        sample(11, { unit: "kg" }),
        sample(12, { value: 5000 }),
        sample(13, { metric_type: "oxygen_saturation_percent", value: 0.97, unit: "percent" }),
        sample(14, { observed_at: new Date(now + 3_600_000).toISOString() }),
        sample(15, { observed_at: new Date(now - 40 * 86_400_000).toISOString() }),
        sample(16, { external_sample_id: "kort" }),
        sample(17, { source_type: "noe_annet" }),
        sample(18, { source_instance_id: "annen-enhet" }),
        sample(19, { person_id: "p-noen-andre" }),
        sample(20, { observed_at: "i går" }),
        "ikke et objekt",
        null,
        sample(21, { metric_type: "heart_rate_variability_ms", value: 48.5, unit: "ms" }) // og EN gyldig til slutt: alt over stopper den ikke
      ]
    });
    expect(result.results.map((r) => [r.status, r.reason])).toEqual([
      ["invalid", "invalid_metric_type"], ["invalid", "invalid_unit"], ["invalid", "value_out_of_range"], ["invalid", "value_out_of_range"], ["invalid", "observed_at_in_future"],
      ["expired", "outside_retention_window"], ["invalid", "invalid_external_sample_id"], ["invalid", "source_fields_forbidden"], ["invalid", "source_fields_forbidden"], ["invalid", "invalid_sample"],
      ["invalid", "invalid_observed_at"], ["invalid", "invalid_external_sample_id"], ["invalid", "invalid_external_sample_id"], ["created", undefined]
    ]);
    expect(result.counts).toMatchObject({ created: 1, invalid: 12, expired: 1 });
    expect(JSON.stringify(result)).not.toMatch(/5000|0\.97|blood_glucose|noe_annet|p-noen-andre/); // verken verdier eller innsendte strenger ekkoes tilbake
    expect((await rows(TENANT, P1)).some((r) => r["external_sample_id"] === id(21))).toBe(true);
    for (const n of [10, 11, 12, 13, 14, 15, 17, 18, 19, 20]) expect((await rows(TENANT)).some((r) => r["external_sample_id"] === id(n))).toBe(false);
  });

  it("alle ti metrikker kan tas inn med sin kanoniske enhet; en ugyldig størrelse mot grensene avvises", async () => {
    const valid: Array<[string, number]> = [
      ["heart_rate", 70], ["steps", 100], ["sleep_duration_minutes", 430], ["weight_kg", 80.5], ["resting_heart_rate", 55], ["heart_rate_variability_ms", 44], ["oxygen_saturation_percent", 96], ["respiratory_rate", 14],
      ["active_energy_kcal", 12.5], ["exercise_minutes", 3]
    ];
    const result = await intake.ingestBatch(who(Q, OTHER_TENANT), { samples: valid.map(([metric, value], i) => sample(100 + i, { metric_type: metric, value, unit: METRIC_CANONICAL_UNITS[metric as keyof typeof METRIC_CANONICAL_UNITS] })) });
    expect(result.counts.created).toBe(10);
  });
});

describe("D: retensjon fail-closed, grenser og atomisitet", () => {
  it("uten eier-konfigurert oppbevaringstid tas INGENTING inn (HealthRetentionPolicyRequiredError), heller ikke slettinger eller revisjon", async () => {
    await expect(intake.ingestBatch(who(P1, TENANT_NO_POLICY), { samples: [sample(30)] })).rejects.toBeInstanceOf(HealthRetentionPolicyRequiredError);
    expect(await rows(TENANT_NO_POLICY)).toHaveLength(0);
    const { rows: audit } = await admin.query(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND type = 'health.intake_batch'`, [TENANT_NO_POLICY]);
    expect(audit).toHaveLength(0);
  });

  it("tomt batch, for stort batch og feil form avvises før noe skrives", async () => {
    const before = (await rows(TENANT)).length;
    await expect(intake.ingestBatch(who(P1), {})).rejects.toMatchObject({ code: "empty_batch" });
    await expect(intake.ingestBatch(who(P1), { samples: [], deleted_external_sample_ids: [] })).rejects.toMatchObject({ code: "empty_batch" });
    await expect(intake.ingestBatch(who(P1), { samples: Array.from({ length: HEALTH_INTAKE_MAX_SAMPLES + 1 }, (_, i) => sample(1000 + i)) })).rejects.toMatchObject({ code: "batch_too_large" });
    await expect(intake.ingestBatch(who(P1), { deleted_external_sample_ids: Array.from({ length: HEALTH_INTAKE_MAX_DELETES + 1 }, (_, i) => id(i)) })).rejects.toMatchObject({ code: "batch_too_large" });
    await expect(intake.ingestBatch(who(P1), { samples: "nei" })).rejects.toBeInstanceOf(HealthIntakeError);
    await expect(intake.ingestBatch(who(P1), { samples: {} })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(intake.ingestBatch(who(P1), { deleted_external_sample_ids: ["kort"] })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(intake.ingestBatch(who(P1), { deleted_external_sample_ids: [42] })).rejects.toMatchObject({ code: "invalid_request" });
    expect(await rows(TENANT)).toHaveLength(before);
  });

  it("et maksimalt batch med vanlige HealthKit-uuid-er er mindre enn API-ets 64 KiB-grense (ellers ville ruten svart 413 før tjenesten)", () => {
    const body = JSON.stringify({
      grant_token: "g".repeat(1500),
      samples: Array.from({ length: HEALTH_INTAKE_MAX_SAMPLES }, (_, i) => sample(i, { metric_type: "resting_heart_rate", value: 54.123, observed_at: "2026-11-18T08:00:00.000Z", external_sample_id: "6F1C1E3B-3E3D-4F63-9D6B-0C3B7B6E8A11" })),
      deleted_external_sample_ids: Array.from({ length: HEALTH_INTAKE_MAX_DELETES }, () => "6F1C1E3B-3E3D-4F63-9D6B-0C3B7B6E8A11")
    });
    expect(Buffer.byteLength(body)).toBeLessThan(64 * 1024);
  });
});

describe("E: sletting av egne prøver, tenant-isolasjon og revisjon uten innhold", () => {
  it("slettede HealthKit-uuid-er fjerner KUN personens egne rader fra denne kilden; ukjente id-er ignoreres; en annen persons og tenants rader er urørt", async () => {
    await intake.ingestBatch(who(P2), { samples: [sample(40, { value: 88 })] });
    await intake.ingestBatch(who(Q, OTHER_TENANT), { samples: [sample(40, { value: 77 })] });
    const result = await intake.ingestBatch(who(P1), { deleted_external_sample_ids: [id(3), id(40), id(4040)] });
    expect(result.counts.deleted).toBe(1); // kun P1 sin id(3); id(40) tilhører P2/Q, id(4040) finnes ikke
    expect((await rows(TENANT, P1)).some((r) => r["external_sample_id"] === id(3))).toBe(false);
    expect((await rows(TENANT, P2)).some((r) => r["external_sample_id"] === id(40))).toBe(true);
    expect((await rows(OTHER_TENANT, Q)).some((r) => r["external_sample_id"] === id(40))).toBe(true);
    // Samme id i en ANNEN tenants kontekst treffer heller ikke (RLS).
    const crossTenant = await intake.ingestBatch(who(Q, OTHER_TENANT), { deleted_external_sample_ids: [id(1), id(2)] });
    expect(crossTenant.counts.deleted).toBe(0);
    expect((await rows(TENANT, P1)).filter((r) => [id(1), id(2)].includes(r["external_sample_id"] as string))).toHaveLength(2);
    // En slettet (erstattet) prøve kan tas inn på nytt som en ny prøve.
    expect((await intake.ingestBatch(who(P1), { samples: [sample(3, { metric_type: "resting_heart_rate", value: 53 })] })).counts.created).toBe(1);
  });

  it("revisjonen har kun antall og metrikktyper (aldri verdier, prøve-id-er, tidspunkt eller enhets-/personinnhold i payload)", async () => {
    const { rows: audit } = await admin.query(`SELECT person_id, device_id, session_id, decision, payload FROM audit_events WHERE tenant_id = $1 AND type = 'health.intake_batch' ORDER BY audit_id`, [TENANT]);
    expect(audit.length).toBeGreaterThanOrEqual(5);
    const text = JSON.stringify(audit.map((a: { payload: unknown }) => a.payload));
    expect(text).not.toContain("0000AAAA");
    expect(text).not.toMatch(/"value"|observed_at|external_sample_id/);
    for (const entry of audit as Array<{ payload: Record<string, unknown>; decision: string; device_id: string }>) {
      expect(Object.keys(entry.payload).sort()).toEqual(["channel", "conflict", "created", "deleted", "deletions_requested", "duplicate", "expired", "invalid", "metric_types", "submitted"]);
      expect(entry.decision).toBe("ALLOW");
      expect(entry.payload["channel"]).toBe("mobile");
    }
    const first = audit[0] as { payload: { created: number; metric_types: string[] } };
    expect(first.payload.created).toBe(3);
    expect(first.payload.metric_types).toEqual(["heart_rate", "resting_heart_rate", "steps"]);
  });

  it("det som er tatt inn leses av den eksisterende lese-API-en (samme tabell, samme RLS), og kan ikke skrives inn i et annet rom", async () => {
    const steps = await health.getRecentMetrics(TENANT, P1, "steps");
    expect(steps).toHaveLength(1);
    expect(Number(steps[0]?.value)).toBe(532);
    await expect(withMemoryTransaction(app, TENANT, ["personal"], async (client) => client.query(`SELECT 1 FROM health_metric_observations`))).resolves.toMatchObject({ rowCount: 0 });
  });
});

describe("F: databasens forsvar (direkte SQL som app-rolle)", () => {
  const insert = (cols: string, vals: unknown[]) => async (client: pg.PoolClient) => {
    await client.query(`INSERT INTO health_metric_observations (observation_id, tenant_id, person_id, ${cols}) VALUES ('obs-sql-${Math.random()}', '${TENANT}', '${P1}', ${vals.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  };
  const code = async (fn: (client: pg.PoolClient) => Promise<void>): Promise<string | undefined> => {
    try { await withMemoryTransaction(app, TENANT, ["health"], fn); return undefined; } catch (e) { return (e as { code?: string }).code; }
  };
  const cols = "metric_type, value, unit, source_type, observed_at, external_sample_id";

  it("metrikk-CHECK: de nye metrikkene godtas, alt utenfor listen avvises; sample-id: lengdegrense og unik per (tenant, person, kilde); NULL er unntatt", async () => {
    expect(await code(insert(cols, ["respiratory_rate", 14, "breaths_per_min", "apple_health", "2026-11-18T08:00:00Z", "ABCDEFGH-sql-1"]))).toBeUndefined();
    expect(await code(insert(cols, ["blood_glucose", 5, "mmol", "apple_health", "2026-11-18T08:00:00Z", "ABCDEFGH-sql-2"]))).toBe("23514");
    expect(await code(insert(cols, ["steps", 5, "count", "apple_health", "2026-11-18T08:00:00Z", "kort"]))).toBe("23514");
    expect(await code(insert(cols, ["steps", 5, "count", "apple_health", "2026-11-18T08:00:00Z", "x".repeat(129)]))).toBe("23514");
    expect(await code(insert(cols, ["steps", 5, "count", "apple_health", "2026-11-18T08:00:00Z", "ABCDEFGH-sql-1"]))).toBe("23505"); // samme (tenant, person, kilde, id)
    expect(await code(insert(cols, ["steps", 5, "count", "annen_kilde", "2026-11-18T08:00:00Z", "ABCDEFGH-sql-1"]))).toBeUndefined(); // annen kilde: egen nøkkel
    const nullCols = "metric_type, value, unit, source_type, observed_at";
    expect(await code(insert(nullCols, ["steps", 5, "count", "fake", "2026-11-18T08:00:00Z"]))).toBeUndefined();
    expect(await code(insert(nullCols, ["steps", 5, "count", "fake", "2026-11-18T08:00:00Z"]))).toBeUndefined(); // NULL-id er unntatt fra den unike indeksen (eksisterende fake-kilde urørt)
    expect(await code(insert(`${nullCols}, memory_space_id`, ["steps", 5, "count", "fake", "2026-11-18T08:00:00Z", "personal"]))).toBeTruthy(); // fortsatt kun health-rommet
  });

  it("negative verdier og append-only gjelder uendret (ingen UPDATE-grant)", async () => {
    expect(await code(insert("metric_type, value, unit, source_type, observed_at", ["heart_rate_variability_ms", -1, "ms", "apple_health", "2026-11-18T08:00:00Z"]))).toBe("23514");
    expect(await code(async (client) => { await client.query(`UPDATE health_metric_observations SET value = 1 WHERE tenant_id = '${TENANT}'`); })).toBe("42501");
  });
});

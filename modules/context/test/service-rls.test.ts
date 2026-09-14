import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { ContextEngine, DEFAULT_MAX_AGE_MS } from "../src/service.ts";

/**
 * UA-8 Personal Digital Twin - Personal Context Engine: ekte Postgres/RLS-
 * integrasjonsbevis for `ContextEngine` mot en EKTE NOSUPERUSER/NOBYPASSRLS-
 * rolle (samme mønster som operations/test/service-rls.test.ts, IKKE en
 * `fakePool()`-mock).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let engine: ContextEngine;

const TENANT_A = "tenant-ctx-svc-a";
const TENANT_B = "tenant-ctx-svc-b";
const PERSON_A = "person-ctx-a";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-context-svc-"));
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

  await adminPool.query("CREATE ROLE jarvis_ctx_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_ctx_svc_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Context Svc A', 'business'), ('${TENANT_B}', 'Context Svc B', 'business')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('${PERSON_A}', 'Person A')`);
  await adminPool.query(
    `INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${TENANT_A}'), ('${PERSON_A}', '${TENANT_B}')`
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_ctx_svc_test", password: "pw2" });
  engine = new ContextEngine(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: registrere en deterministisk observasjon og lese den tilbake", () => {
  it("recordObservation + getCurrentContext returnerer verdien med basis='deterministic', stale=false", async () => {
    const result = await engine.recordObservation({
      tenant_id: TENANT_A,
      person_id: PERSON_A,
      memory_space: "personal",
      dimension: "activity",
      value: { state: "focused_work" },
      basis: "deterministic",
      source_type: "device_sensor",
      source_instance_id: "dev-1"
    });
    expect(result.applied).toBe(true);
    expect(result.observation.basis).toBe("deterministic");

    const ctx = await engine.getCurrentContext(TENANT_A, PERSON_A, "personal");
    expect(ctx.dimensions.activity).not.toBeNull();
    expect(ctx.dimensions.activity?.value["state"]).toBe("focused_work");
    expect(ctx.dimensions.activity?.basis).toBe("deterministic");
    expect(ctx.dimensions.activity?.stale).toBe(false);
    // Ikke-observerte dimensjoner er eksplisitt null, ALDRI en fabrikkert default.
    expect(ctx.dimensions.place).toBeNull();
  });

  it("avviser en ugyldig verdi for dimensjonen (zod-validering)", async () => {
    await expect(
      engine.recordObservation({
        tenant_id: TENANT_A,
        person_id: PERSON_A,
        memory_space: "personal",
        dimension: "device",
        // mangler paakrevd device_id/channel
        value: { not_a_valid_field: true },
        basis: "deterministic",
        source_type: "session"
      })
    ).rejects.toThrow(/invalid_context_observation_value/);
  });
});

describe("B: presedens - 'inferred' overstyrer ALDRI en tilstedeværende 'deterministic' observasjon", () => {
  it("en etterfølgende inferred-observasjon for samme dimensjon blir ignorert", async () => {
    const deterministic = await engine.recordObservation({
      tenant_id: TENANT_A,
      person_id: PERSON_A,
      memory_space: "business",
      dimension: "device",
      value: { device_id: "dev-real", channel: "mobile" },
      basis: "deterministic",
      source_type: "session",
      source_instance_id: "sess-real"
    });
    expect(deterministic.applied).toBe(true);

    const inferredAttempt = await engine.recordObservation({
      tenant_id: TENANT_A,
      person_id: PERSON_A,
      memory_space: "business",
      dimension: "device",
      value: { device_id: "dev-guessed", channel: "web" },
      basis: "inferred",
      source_type: "model_gateway_guess"
    });
    expect(inferredAttempt.applied).toBe(false);
    expect(inferredAttempt.reason).toBe("deterministic_precedence");
    // Returnerer den EKSISTERENDE (uendrede) deterministiske observasjonen, ikke gjetningen.
    expect(inferredAttempt.observation.value["device_id"]).toBe("dev-real");

    const ctx = await engine.getCurrentContext(TENANT_A, PERSON_A, "business");
    expect(ctx.dimensions.device?.value["device_id"]).toBe("dev-real");
    expect(ctx.dimensions.device?.basis).toBe("deterministic");
  });

  it("en inferred-observasjon skrives normalt naar INGEN deterministic-observasjon finnes for dimensjonen ennaa", async () => {
    const first = await engine.recordObservation({
      tenant_id: TENANT_A,
      person_id: PERSON_A,
      memory_space: "guest",
      dimension: "activity",
      value: { state: "away" },
      basis: "inferred",
      source_type: "model_gateway_guess"
    });
    expect(first.applied).toBe(true);
    expect(first.observation.basis).toBe("inferred");

    // En NY inferred-observasjon kan trygt oppdatere en EKSISTERENDE inferred (kun deterministic er beskyttet).
    const second = await engine.recordObservation({
      tenant_id: TENANT_A,
      person_id: PERSON_A,
      memory_space: "guest",
      dimension: "activity",
      value: { state: "commuting" },
      basis: "inferred",
      source_type: "model_gateway_guess"
    });
    expect(second.applied).toBe(true);
    const ctx = await engine.getCurrentContext(TENANT_A, PERSON_A, "guest");
    expect(ctx.dimensions.activity?.value["state"]).toBe("commuting");
  });
});

describe("C: ferskhet - en gammel observasjon flagges 'stale: true' naar den passerer dimensjonens vindu", () => {
  it("place (maks-alder 1t) flagges stale etter 2 timer, en fersk observasjon er stale=false", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    expect(DEFAULT_MAX_AGE_MS.place).toBeLessThan(2 * 60 * 60_000);
    await engine.recordObservation({
      tenant_id: TENANT_A,
      person_id: PERSON_A,
      memory_space: "project",
      dimension: "place",
      value: { label: "Kontoret" },
      basis: "deterministic",
      source_type: "location_service",
      observed_at: twoHoursAgo
    });
    const ctx = await engine.getCurrentContext(TENANT_A, PERSON_A, "project");
    expect(ctx.dimensions.place?.stale).toBe(true);
    expect(ctx.dimensions.place?.value["label"]).toBe("Kontoret");

    await engine.recordObservation({
      tenant_id: TENANT_A,
      person_id: PERSON_A,
      memory_space: "project",
      dimension: "place",
      value: { label: "Hjemme" },
      basis: "deterministic",
      source_type: "location_service"
    });
    const refreshed = await engine.getCurrentContext(TENANT_A, PERSON_A, "project");
    expect(refreshed.dimensions.place?.stale).toBe(false);
    expect(refreshed.dimensions.place?.value["label"]).toBe("Hjemme");
  });
});

describe("D: tenant-isolasjon (RLS) - samme person_id-mønster lekker ALDRI paa tvers av tenants", () => {
  it("en observasjon skrevet i TENANT_A er usynlig for en spørring mot TENANT_B, selv for samme person_id", async () => {
    await engine.recordObservation({
      tenant_id: TENANT_A,
      person_id: PERSON_A,
      memory_space: "shared",
      dimension: "activity",
      value: { state: "in_meeting" },
      basis: "deterministic",
      source_type: "device_sensor"
    });
    const ctxB = await engine.getCurrentContext(TENANT_B, PERSON_A, "shared");
    expect(ctxB.dimensions.activity).toBeNull();

    const ctxA = await engine.getCurrentContext(TENANT_A, PERSON_A, "shared");
    expect(ctxA.dimensions.activity?.value["state"]).toBe("in_meeting");
  });
});

describe("E: memory-space RLS - en 'personal'-rad er usynlig naar sesjonen kun har 'business' tildelt", () => {
  it("en rå spørring UTEN memory_space_id-filter i WHERE ser INGEN rad utenfor tildelt space (ekte RESTRICTIVE-policy, ikke app-filter)", async () => {
    await engine.recordObservation({
      tenant_id: TENANT_A,
      person_id: PERSON_A,
      memory_space: "personal",
      dimension: "place",
      value: { label: "RLS-space-test" },
      basis: "deterministic",
      source_type: "location_service"
    });

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      // Sesjonen faar KUN 'business' tildelt - INGEN memory_space_id-predikat i selve spørringen,
      // slik at ethvert treff kun kan forklares av RLS-policyen selv, ikke app-level filtrering.
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', $2, true)", [
        TENANT_A,
        "business"
      ]);
      const { rows } = await client.query(
        `SELECT * FROM context_observations WHERE tenant_id = $1 AND person_id = $2 AND dimension = 'place'`,
        [TENANT_A, PERSON_A]
      );
      expect(rows).toHaveLength(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    // Kontroll: samme rad ER synlig naar sesjonen faktisk har 'personal' tildelt.
    const ctx = await engine.getCurrentContext(TENANT_A, PERSON_A, "personal");
    expect(ctx.dimensions.place?.value["label"]).toBe("RLS-space-test");
  });
});

describe("F: møte-/kalenderkontekst avledet fra business_activities (EKSISTERENDE Calendar-synk-tabell)", () => {
  it("gjenspeiler en ekte 'meeting'-aktivitetsrad som starter om faa minutter ('starting_soon')", async () => {
    const activityId = "biz-act-ctx-meeting-1";
    const startsAt = new Date(Date.now() + 5 * 60_000);
    await adminPool.query(
      `INSERT INTO business_activities (activity_id, tenant_id, memory_space_id, owner_person_id, activity_type, summary, occurred_at)
       VALUES ($1, $2, 'business', $3, 'meeting', 'Møte: Test', $4)`,
      [activityId, TENANT_A, PERSON_A, startsAt.toISOString()]
    );
    const result = await engine.recordMeetingObservationFromCalendar(TENANT_A, PERSON_A, "business");
    expect(result.applied).toBe(true);
    expect(result.observation.value["status"]).toBe("starting_soon");
    expect(result.observation.value["activity_id"]).toBe(activityId);
    expect(result.observation.value["end_time_known"]).toBe(false);
    expect(result.observation.source_instance_id).toBe(activityId);

    const ctx = await engine.getCurrentContext(TENANT_A, PERSON_A, "business");
    expect(ctx.dimensions.meeting?.value["status"]).toBe("starting_soon");
  });

  it("en aktivitetsrad som startet for 10 minutter siden gir 'recently_started_duration_unknown' (INGEN sluttidspunkt finnes aa sjekke mot)", async () => {
    const activityId = "biz-act-ctx-meeting-2";
    const startedAt = new Date(Date.now() - 10 * 60_000);
    await adminPool.query(
      `INSERT INTO business_activities (activity_id, tenant_id, memory_space_id, owner_person_id, activity_type, summary, occurred_at)
       VALUES ($1, $2, 'business', $3, 'meeting', 'Møte: Test 2', $4)`,
      [activityId, TENANT_A, PERSON_A, startedAt.toISOString()]
    );
    const result = await engine.recordMeetingObservationFromCalendar(TENANT_A, PERSON_A, "business");
    expect(result.observation.value["status"]).toBe("recently_started_duration_unknown");
    expect(result.observation.value["end_time_known"]).toBe(false);
  });

  it("degraderer graasomt til status='none' naar INGEN møteaktivitet finnes naer 'now' - kaster ALDRI, dikter ALDRI opp et møte", async () => {
    const result = await engine.recordMeetingObservationFromCalendar(TENANT_A, PERSON_A, "personal", {
      now: new Date("2030-01-01T00:00:00Z")
    });
    expect(result.applied).toBe(true);
    expect(result.observation.value["status"]).toBe("none");
    expect(result.observation.value["end_time_known"]).toBe(false);
    expect(result.observation.source_instance_id).toBeNull();

    const ctx = await engine.getCurrentContext(TENANT_A, PERSON_A, "personal");
    expect(ctx.dimensions.meeting?.value["status"]).toBe("none");
  });
});

describe("G: enhetskontekst live-avledet fra den EKSISTERENDE sessions-tabellen (SessionService)", () => {
  it("recordDeviceObservationFromSession finner en aktiv sesjon og registrerer den som deterministic", async () => {
    await adminPool.query(
      `INSERT INTO sessions (session_id, tenant_id, person_id, status, last_channel, last_device_id)
       VALUES ('sess-ctx-device-1', $1, $2, 'active', 'mobile', 'device-abc')`,
      [TENANT_A, PERSON_A]
    );
    const result = await engine.recordDeviceObservationFromSession(TENANT_A, PERSON_A, "home");
    expect(result).not.toBeNull();
    expect(result?.observation.value["device_id"]).toBe("device-abc");
    expect(result?.observation.value["channel"]).toBe("mobile");
    expect(result?.observation.basis).toBe("deterministic");
    expect(result?.observation.source_instance_id).toBe("sess-ctx-device-1");
  });

  it("returnerer null naar personen ikke har noen aktiv sesjon i tenanten (intet aa observere, ikke en feil)", async () => {
    const result = await engine.recordDeviceObservationFromSession(TENANT_B, "person-uten-sesjon", "home");
    expect(result).toBeNull();
  });
});

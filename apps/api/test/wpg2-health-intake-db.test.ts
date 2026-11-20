import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { HealthIntakeService, HealthService } from "@jarvis/health";
import { LocationService } from "@jarvis/location";
import { familySharedDataReaders, startOfLocalDayMs } from "../src/personal-family-readers.ts";
import { handlePersonalRoute, type PersonalRouteContext } from "../src/personal-routes.ts";

/**
 * WP-G2 (D-464) P1d: HTTP-handleren for helse-inntaket mot EKTE Postgres med den EKTE `HealthIntakeService` (ingen spioner): 409 uten oppbevaringstid, idempotens, ugyldige prøver uten ekko av verdier, sletting, og at det som er
 * tatt inn kan leses av det delte familie-sammendraget (iPhone-push -> `health`-rommet -> avledet sum), uten at noen verdi finnes i svaret utover tellerne.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let intake: HealthIntakeService;
let health: HealthService;

const TENANT = "t-hlt-route";
const PERSON = "p-hlt-route";
const phone: IdentityContext = { person_id: PERSON, tenant_id: TENANT, memory_space_id: "health", session_id: "s-1", device_id: "iphone-route", channel: "mobile", auth_strength: "signed" };
const NOW = new Date();
const TODAY = new Date(Math.max(NOW.getTime() - 60_000, startOfLocalDayMs(NOW, "Europe/Oslo") + 1000)).toISOString(); // alltid «i dag» (lokal tid), aldri i fremtiden
const id = (n: number): string => `ROUTE-0000-4000-8000-${String(n).padStart(12, "0")}`;
const body = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ metric_type: "steps", value: 1000, unit: "count", observed_at: TODAY, external_sample_id: id(n), ...extra });

async function post(payload: Record<string, unknown>, identity: IdentityContext = phone): Promise<{ status: number; body: Record<string, unknown> }> {
  let out: { status: number; body: Record<string, unknown> } | undefined;
  const ctx: PersonalRouteContext = {
    req: { method: "POST" } as never, res: {} as never, url: new URL("/personal/health/ingest", "http://localhost"), deps: { health: { intake } },
    authed: async () => ({ identity, body: payload }),
    requireOwner: async () => true, stepUpDenial: () => undefined,
    json: (status, b) => { out = { status, body: b as Record<string, unknown> }; }, requestId: () => "req-1",
    fieldString: () => "", fieldOptionalString: () => undefined, fieldRecord: () => ({}), fieldOptionalNumber: () => undefined,
    domainFailure: (status, code) => { out = { status, body: { error: code } }; }
  };
  expect(await handlePersonalRoute(ctx)).toBe(true);
  return out!;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-hlt-route-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_hlt_route_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_hlt_route_test");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Route','person');
    INSERT INTO people (person_id, display_name) VALUES ('${PERSON}','P');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON}','${TENANT}');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_hlt_route_test", password: "pw2" });
  intake = new HealthIntakeService(app);
  health = new HealthService(app);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("handleren med den ekte tjenesten", () => {
  it("uten oppbevaringstid: 409 og INGENTING lagres", async () => {
    const res = await post({ samples: [body(1)] });
    expect(res).toEqual({ status: 409, body: { error: "health_retention_policy_required", request_id: "req-1" } });
    expect((await admin.query(`SELECT count(*)::int AS n FROM health_metric_observations`)).rows[0]).toEqual({ n: 0 });
  });

  it("med oppbevaringstid: opprettet, deretter duplikat; ugyldige prøver gir koder uten ekko av verdier; kun tellere og koder i svaret", async () => {
    await health.setRetentionPolicy(TENANT, { retention_days: 90, actor_person_id: PERSON });
    const first = await post({ samples: [body(1), body(2, { value: 2500 }), body(3, { metric_type: "oxygen_saturation_percent", value: 0.96, unit: "percent" })] });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      source: "apple_health",
      results: [{ index: 0, status: "created" }, { index: 1, status: "created" }, { index: 2, status: "invalid", reason: "value_out_of_range" }],
      counts: { created: 2, duplicate: 0, conflict: 0, invalid: 1, expired: 0, deleted: 0 }
    });
    expect(JSON.stringify(first.body)).not.toMatch(/2500|0\.96|1000/);
    const again = await post({ samples: [body(1), body(2, { value: 2500 })] });
    expect((again.body["counts"] as Record<string, number>)["duplicate"]).toBe(2);
    expect((await admin.query(`SELECT count(*)::int AS n FROM health_metric_observations`)).rows[0]).toEqual({ n: 2 });
  });

  it("det som er tatt inn leses som avledet sammendrag i familie-leseren (skritt i dag = sum), og sletting fjerner prøven fra summen", async () => {
    const readers = familySharedDataReaders({ location: new LocationService(app), health, now: () => NOW });
    expect(await readers.healthSummary(TENANT, PERSON)).toMatchObject({ steps_today: 3500, sleep_minutes_last_night: null });
    const removed = await post({ deleted_external_sample_ids: [id(2)] });
    expect(removed.body["counts"]).toMatchObject({ deleted: 1 });
    expect(await readers.healthSummary(TENANT, PERSON)).toMatchObject({ steps_today: 1000 });
  });

  it("feil identitet (ikke signert / feil kanal / feil rom) rører ikke databasen; tomt batch gir 400", async () => {
    const before = (await admin.query(`SELECT count(*)::int AS n FROM health_metric_observations`)).rows[0];
    for (const identity of [{ ...phone, auth_strength: "active" }, { ...phone, channel: "api" }, { ...phone, memory_space_id: "personal" }] as IdentityContext[]) {
      expect((await post({ samples: [body(9)] }, identity)).status).toBe(403);
    }
    expect((await admin.query(`SELECT count(*)::int AS n FROM health_metric_observations`)).rows[0]).toEqual(before);
    expect(await post({})).toEqual({ status: 400, body: { error: "health_intake_rejected", reason: "empty_batch", request_id: "req-1" } });
  });
});

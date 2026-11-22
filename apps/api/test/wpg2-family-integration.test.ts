import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FamilyService, type FamilyActor } from "@jarvis/context";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { HealthService } from "@jarvis/health";
import { LocationService } from "@jarvis/location";
import { familySharedDataReaders } from "../src/personal-family-readers.ts";

/**
 * WP-G2 (D-464) P1c: ende-til-ende mot EKTE Postgres med de EKTE `LocationService`/`HealthService`: en delt kategori leses fra subjektets EGEN datatenant gjennom `familySharedDataReaders`, KUN etter en deling subjektet selv har gitt,
 * og seeren får kun det avledede (sonenavn; skritt i dag + søvn siste natt) - aldri koordinater, puls, vekt, eller en annen persons data i samme datatenant.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let family: FamilyService;
let location: LocationService;
let health: HealthService;

const CIRCLE = "t-fam-int-circle";
const DATA = "t-fam-int-data";
const OWNER = "p-fam-int-owner";
const ADULT = "p-fam-int-adult";
const OTHER = "p-fam-int-other";
const NOW = new Date("2026-11-18T10:30:00.000Z");

const actor = (person: string): FamilyActor => ({ tenant_id: CIRCLE, person_id: person, memory_space_id: "shared", session_id: `sess-${person}`, device_id: `dev-${person}`, channel: "api", auth_strength: "signed" });
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? `other:${(e as Error).message}`; }
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fam-int-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_fam_int_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_fam_int_test");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${CIRCLE}','Circle','person'), ('${DATA}','Adult data','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Owner'), ('${ADULT}','Adult'), ('${OTHER}','Other');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${CIRCLE}'), ('${ADULT}','${CIRCLE}'), ('${ADULT}','${DATA}'), ('${OTHER}','${DATA}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-fam-int-shared','${CIRCLE}','shared'), ('ms-fam-int-personal','${DATA}','personal'), ('ms-fam-int-health','${DATA}','health');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_fam_int_test", password: "pw2" });
  location = new LocationService(app);
  health = new HealthService(app);
  family = new FamilyService(app, { now: () => NOW, readers: familySharedDataReaders({ location, health, now: () => NOW }) });

  // Subjektets egne data i datatenanten (retensjonspolicy først: begge domenene er fail-closed uten).
  await location.setRetentionPolicy(DATA, "personal", { retention_days: 30, actor_person_id: ADULT });
  await health.setRetentionPolicy(DATA, { retention_days: 365, actor_person_id: ADULT });
  await location.createZone(DATA, "personal", { person_id: ADULT, name: "Hjemme", center_lat: 59.9, center_lon: 10.7, radius_meters: 100 });
  await location.ingestObservation(DATA, "personal", { person_id: ADULT, source_type: "test", lat: 59.9, lon: 10.7, observed_at: "2026-11-18T08:00:00.000Z" });
  const samples: Array<[string, number, string, string]> = [
    ["steps", 1200, "count", "2026-11-18T07:00:00.000Z"], ["steps", 3000, "count", "2026-11-18T09:00:00.000Z"], ["steps", 5000, "count", "2026-11-17T20:00:00.000Z"], // i går (lokal tid): telles ikke
    ["sleep_duration_minutes", 431, "minutes", "2026-11-18T05:45:00.000Z"], ["sleep_duration_minutes", 400, "minutes", "2026-11-16T05:00:00.000Z"], // eldre enn 36 timer: telles ikke
    ["heart_rate", 52, "bpm", "2026-11-18T09:30:00.000Z"], ["weight_kg", 80, "kg", "2026-11-18T06:00:00.000Z"] // lekker aldri
  ];
  for (const [metric, value, unit, at] of samples) await health.ingestObservation(DATA, ADULT, { metric_type: metric as never, value, unit, observed_at: at, source_type: "test" });
  // En ANNEN person i SAMME datatenant: hennes data skal aldri vises via voksens deling.
  await location.createZone(DATA, "personal", { person_id: OTHER, name: "Hos andre", center_lat: 60.5, center_lon: 11.2, radius_meters: 100 });
  await location.ingestObservation(DATA, "personal", { person_id: OTHER, source_type: "test", lat: 60.5, lon: 11.2, observed_at: "2026-11-18T08:30:00.000Z" });
  await health.ingestObservation(DATA, OTHER, { metric_type: "steps", value: 9999, unit: "count", observed_at: "2026-11-18T08:00:00.000Z", source_type: "test" });

  await family.bootstrapOwner(actor(OWNER), OWNER);
  const inv = await family.invite(actor(OWNER), { invitee_person_id: ADULT, role: "adult" });
  await family.acceptInvitation(actor(ADULT), inv.invitation_id, { data_tenant_id: DATA });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("lokasjon og helse leses fra subjektets egen datatenant, kun via en deling, og kun avledet", () => {
  it("uten deling: ingenting leses (ingen rad om zonen/helsen i svaret), med lokasjonsdeling: kun sonenavn og innreisetidspunkt - aldri koordinater", async () => {
    expect(await code(family.readShared(actor(OWNER), ADULT, "location"))).toBe("share_required");
    await family.grantShare(actor(ADULT), { viewer_person_id: OWNER, category: "location" });
    const view = await family.readShared(actor(OWNER), ADULT, "location");
    expect(view).toEqual({ category: "location", zone_name: "Hjemme", observed_at: "2026-11-18T08:00:00.000Z" });
    expect(JSON.stringify(view)).not.toMatch(/59\.9|10\.7|60\.5|11\.2|Hos andre|lat|lon/);
    // En lokasjonsdeling åpner ikke helse.
    expect(await code(family.readShared(actor(OWNER), ADULT, "health_summary"))).toBe("share_required");
  });

  it("helsedeling: skritt i dag (kun dagens, kun denne personen) og søvn siste natt - ikke puls, vekt, gårsdagens skritt, gammel søvn eller en annen persons data", async () => {
    await family.grantShare(actor(ADULT), { viewer_person_id: OWNER, category: "health_summary" });
    const view = await family.readShared(actor(OWNER), ADULT, "health_summary");
    expect(view).toEqual({ category: "health_summary", steps_today: 4200, sleep_minutes_last_night: 431, observed_at: "2026-11-18T09:00:00.000Z" });
    expect(JSON.stringify(view)).not.toMatch(/9999|52|80|5000|400|heart|weight/);
  });

  it("forlater personen sonen, er stedet ukjent (null), ikke «borte» eller et gammelt navn; tilbakekalt deling stopper alt", async () => {
    await location.ingestObservation(DATA, "personal", { person_id: ADULT, source_type: "test", lat: 61.0, lon: 12.0, observed_at: "2026-11-18T10:00:00.000Z" });
    expect(await family.readShared(actor(OWNER), ADULT, "location")).toEqual({ category: "location", zone_name: null, observed_at: null });
    const shares = await family.listShares(actor(ADULT));
    for (const share of shares.granted) await family.revokeShare(actor(ADULT), share.share_id);
    expect(await code(family.readShared(actor(OWNER), ADULT, "location"))).toBe("share_required");
    expect(await code(family.readShared(actor(OWNER), ADULT, "health_summary"))).toBe("share_required");
  });

  it("subjektet leser sitt eget uten deling; en annen persons data i samme datatenant er utilgjengelig for sirkelen (personen er ikke medlem)", async () => {
    expect((await family.readShared(actor(ADULT), ADULT, "health_summary")).category).toBe("health_summary");
    expect(await code(family.readShared(actor(OWNER), OTHER, "health_summary"))).toBe("share_required"); // OTHER er ikke medlem av sirkelen
    expect(await code(family.readShared(actor(ADULT), OTHER, "location"))).toBe("share_required");
  });
});

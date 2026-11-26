import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalHashEmbedding } from "@jarvis/memory";
import { VisionCameraService, type VisionCamera } from "../src/cameras.ts";
import { VisionClassifier } from "../src/classifier.ts";
import { VisionEmbeddingService } from "../src/embeddings.ts";
import { VisionInventoryService } from "../src/inventory.ts";
import { VisionIngestPipeline, type IngestContext } from "../src/pipeline.ts";
import {
  DEFAULT_RETENTION_DAYS, DEFAULT_SNAPSHOT_RETENTION_DAYS, MAX_RETENTION_DAYS, MAX_SNAPSHOT_RETENTION_DAYS, MIN_RETENTION_DAYS, VisionObservationValidationError, VisionRetentionConfirmationRequiredError,
  VisionService, describeRetention, effectiveSnapshotRetentionDays, parseRetentionRequest, retentionShortening, type VisionRetentionView
} from "../src/service.ts";
import { VisionSnapshotService } from "../src/snapshots.ts";
import { LocalFsStorageAdapter } from "../src/storage.ts";
import { runVisionMaintenanceSweepForAllTenants } from "../src/sweep.ts";
import { detectionsJson, makeJpeg, ScriptedGateway, seedTenant, startVisionDb, type VisionDb } from "./support/harness.ts";

/**
 * WP-G3b (D-485), K1: eierens retensjonsvinduer - tjenestelaget (ren validering, forkorting, idempotens, lås, revisjon) mot ekte Postgres (app-rolle, RLS).
 * Rutene over HTTP står i apps/api/test/wpg3b-vision-retention-routes.test.ts.
 *
 * Nøkkelbeviset her er «forankret ved skriving»: en endring av vinduene sletter IKKE eksisterende hendelser, bilder eller inventar (utløpet er satt ved innsetting), og gjelder rader som skrives ETTER endringen. Testen er også en
 * TRIPWIRE: blir utløpet noen gang regnet ut ved sveipet (retroaktivt), feiler den, og forkorting MÅ da behandles som en destruktiv handling (typet bekreftelse finnes allerede; se også wpg3b-vision-retention-routes).
 */
let db: VisionDb;
let T: Awaited<ReturnType<typeof seedTenant>>;
let T2: Awaited<ReturnType<typeof seedTenant>>;
let vision: VisionService;
let cameras: VisionCameraService;
let snapshots: VisionSnapshotService;
let inventory: VisionInventoryService;
let embeddings: VisionEmbeddingService;
let camera: VisionCamera;
let ctx: IngestContext;
let n = 0;

const prov = (over: Record<string, unknown> = {}) => ({ actor_person_id: "" as string, task_id: "g3b-test", session_id: "s-g3b", device_id: "d-g3b", audit: true, ...over });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const scalar = async (sql: string, params: unknown[] = []): Promise<number> => Number(((await db.admin.query(sql, params)).rows[0] as { n: string | number }).n);
const auditRows = async (tenant: string): Promise<Array<{ person_id: string; session_id: string | null; device_id: string | null; decision: string; tool_id: string; action: string; task_id: string | null; payload: Record<string, unknown> }>> =>
  (await db.admin.query(`SELECT person_id, session_id, device_id, decision, tool_id, action, task_id, payload FROM audit_events WHERE tenant_id = $1 AND type = 'vision.retention_set' ORDER BY audit_id`, [tenant])).rows as never;
const policyRow = async (tenant: string, space: string): Promise<Record<string, unknown> | undefined> =>
  (await db.admin.query(`SELECT retention_days, snapshot_retention_days, actor_person_id, updated_at FROM vision_retention_policies WHERE tenant_id = $1 AND memory_space_id = $2`, [tenant, space])).rows[0] as Record<string, unknown> | undefined;
const apply = (tenant: string, space: "home" | "personal" | "guest", retention: unknown, snapshot: unknown, over: Record<string, unknown> = {}) =>
  vision.applyRetentionPolicy(tenant, space, { retention_days: retention, snapshot_retention_days: snapshot }, prov({ actor_person_id: tenant === T.tenant ? T.owner : T2.owner, ...over }));

async function capture(): Promise<{ observation_ids: string[]; snapshot_id: string; label: string }> {
  const gateway = new ScriptedGateway();
  const label = `gjenstand${++n}`;
  gateway.text = detectionsJson([{ event_type: "object_detected", object_label: label, confidence: 0.9 }]);
  const p = new VisionIngestPipeline({ pool: db.app, vision, classifier: new VisionClassifier({ gateway }), snapshots, embeddings, inventory, enabled: true, storeSnapshots: true });
  const out = await p.processCaptured(ctx, camera, {
    source_type: "home_assistant", source_event_id: `binary_sensor.x@g3b-${n}`, base_event_type: "motion_detected", observed_at: new Date().toISOString(), age_ms: 10, skipCooldown: true,
    getImage: async () => ({ bytes: makeJpeg(), declared_type: "image/jpeg" })
  });
  expect(out.status).toBe("recorded");
  return { observation_ids: out.observation_ids, snapshot_id: out.snapshot_id as string, label };
}

beforeAll(async () => {
  db = await startVisionDb("g3bret");
  T = await seedTenant(db, "g3b-t1");
  T2 = await seedTenant(db, "g3b-t2");
  vision = new VisionService(db.app);
  cameras = new VisionCameraService(db.app);
  snapshots = new VisionSnapshotService(db.app, new LocalFsStorageAdapter(await mkdtemp(join(tmpdir(), "jarvis-vision-g3b-"))), vision);
  inventory = new VisionInventoryService(db.app);
  embeddings = new VisionEmbeddingService(db.app, new LocalHashEmbedding());
  const room = (await vision.createRoom(T.tenant, "home", { person_id: T.owner, name: "Stua" })).room_id;
  camera = await cameras.registerCamera(T.tenant, "home", { person_id: T.owner, label: "Inngang", source_type: "home_assistant", source_ref: "camera.inngang", trigger_entities: ["binary_sensor.x"], room_id: room, zone_kind: "home", route_policy: "store_snapshot" });
  ctx = { tenant_id: T.tenant, memory_space: "home", person_id: T.owner, task_id: "task-g3b" };
}, 240_000);

afterAll(async () => {
  await db?.stop();
}, 120_000);

// ---------------------------------------------------------------------------------------------------------------------
// Ren logikk
// ---------------------------------------------------------------------------------------------------------------------
describe("grenser og ren validering (parseRetentionRequest)", () => {
  const fails = (input: { retention_days?: unknown; snapshot_retention_days?: unknown }): { field: string; detail: string; name: string; message: string } => {
    try {
      parseRetentionRequest(input);
    } catch (err) {
      const e = err as VisionObservationValidationError;
      return { field: e.field, detail: e.detail, name: e.name, message: e.message };
    }
    throw new Error("forventet en valideringsfeil");
  };

  it("grensene er dokumentert og låst: 1..365 dager for hendelser, 1..90 for bilder (standard 30 og 7 er uendret)", () => {
    expect([MIN_RETENTION_DAYS, MAX_RETENTION_DAYS, MAX_SNAPSHOT_RETENTION_DAYS]).toEqual([1, 365, 90]);
    expect([DEFAULT_RETENTION_DAYS, DEFAULT_SNAPSHOT_RETENTION_DAYS]).toEqual([30, 7]);
  });

  it("godtar heltall innenfor grensene, `null` bildevindu = standard, og et bildevindu lik hendelsesvinduet", () => {
    expect(parseRetentionRequest({ retention_days: 30, snapshot_retention_days: null })).toEqual({ retention_days: 30, snapshot_retention_days: null });
    expect(parseRetentionRequest({ retention_days: 1, snapshot_retention_days: 1 })).toEqual({ retention_days: 1, snapshot_retention_days: 1 });
    expect(parseRetentionRequest({ retention_days: 365, snapshot_retention_days: 90 })).toEqual({ retention_days: 365, snapshot_retention_days: 90 });
    expect(parseRetentionRequest({ retention_days: 7, snapshot_retention_days: 7 })).toEqual({ retention_days: 7, snapshot_retention_days: 7 });
    expect(parseRetentionRequest({ retention_days: 90, snapshot_retention_days: 90 })).toEqual({ retention_days: 90, snapshot_retention_days: 90 });
    expect(parseRetentionRequest({ retention_days: 1, snapshot_retention_days: null })).toEqual({ retention_days: 1, snapshot_retention_days: null });
  });

  it("begge feltene MÅ oppgis (ingenting nullstilles stille av et utelatt felt)", () => {
    expect(fails({})).toMatchObject({ field: "retention_days", detail: "required" });
    expect(fails({ snapshot_retention_days: null })).toMatchObject({ field: "retention_days", detail: "required" });
    expect(fails({ retention_days: 30 })).toMatchObject({ field: "snapshot_retention_days", detail: "required" });
    expect(fails({ retention_days: 30, snapshot_retention_days: undefined })).toMatchObject({ field: "snapshot_retention_days", detail: "required" });
  });

  it("alt som ikke er et endelig heltall avvises med `not_integer` (strenger, flyttall, NaN, Infinity, boolsk, null, objekter, lister)", () => {
    for (const bad of ["30", "", 30.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, true, false, null, {}, [], [30], 1.0000001]) {
      expect(fails({ retention_days: bad, snapshot_retention_days: null }), `retention_days=${String(bad)}`).toMatchObject({ field: "retention_days", detail: "not_integer" });
    }
    for (const bad of ["7", 7.5, Number.NaN, Number.POSITIVE_INFINITY, true, {}, [], [7]]) {
      expect(fails({ retention_days: 30, snapshot_retention_days: bad }), `snapshot_retention_days=${String(bad)}`).toMatchObject({ field: "snapshot_retention_days", detail: "not_integer" });
    }
  });

  it("under nedre grense gir `below_min` og over øvre grense `above_max` (hendelser 365, bilder 90) - ingen stille klemming", () => {
    for (const bad of [0, -1, -365, -0]) expect(fails({ retention_days: bad, snapshot_retention_days: null }), String(bad)).toMatchObject({ field: "retention_days", detail: "below_min" });
    for (const bad of [366, 1000, 2_147_483_648, 1e21, Number.MAX_SAFE_INTEGER]) expect(fails({ retention_days: bad, snapshot_retention_days: null }), String(bad)).toMatchObject({ field: "retention_days", detail: "above_max" });
    for (const bad of [0, -1]) expect(fails({ retention_days: 30, snapshot_retention_days: bad }), String(bad)).toMatchObject({ field: "snapshot_retention_days", detail: "below_min" });
    for (const bad of [91, 365, 1e9]) expect(fails({ retention_days: 365, snapshot_retention_days: bad }), String(bad)).toMatchObject({ field: "snapshot_retention_days", detail: "above_max" });
  });

  it("et oppgitt bildevindu er aldri lengre enn hendelsesvinduet: `exceeds_retention_days` (også når det ellers er innenfor 1..90)", () => {
    expect(fails({ retention_days: 30, snapshot_retention_days: 31 })).toMatchObject({ field: "snapshot_retention_days", detail: "exceeds_retention_days" });
    expect(fails({ retention_days: 5, snapshot_retention_days: 10 })).toMatchObject({ field: "snapshot_retention_days", detail: "exceeds_retention_days" });
    expect(fails({ retention_days: 1, snapshot_retention_days: 2 })).toMatchObject({ field: "snapshot_retention_days", detail: "exceeds_retention_days" });
    // grensen er skarp: lik er lov
    expect(parseRetentionRequest({ retention_days: 30, snapshot_retention_days: 30 })).toEqual({ retention_days: 30, snapshot_retention_days: 30 });
  });

  it("rekkefølgen er deterministisk (hendelsesvinduet først) og feilen bærer kun felt og kode i en stabil melding", () => {
    expect(fails({ retention_days: 0, snapshot_retention_days: 999 })).toMatchObject({ field: "retention_days", detail: "below_min" });
    expect(fails({ retention_days: "x", snapshot_retention_days: "y" })).toMatchObject({ field: "retention_days", detail: "not_integer" });
    expect(fails({ retention_days: 400, snapshot_retention_days: 400 })).toMatchObject({ field: "retention_days", detail: "above_max" });
    const e = fails({ retention_days: 366, snapshot_retention_days: null });
    expect(e.name).toBe("VisionObservationValidationError");
    expect(e.message).toBe("vision_observation_invalid:retention_days:above_max");
  });
});

describe("effektivt bildevindu og visning (describeRetention)", () => {
  it("effektivt bildevindu = min(konfigurert ?? 7, hendelsesvindu)", () => {
    expect(effectiveSnapshotRetentionDays(30, null)).toBe(7);
    expect(effectiveSnapshotRetentionDays(30, undefined)).toBe(7);
    expect(effectiveSnapshotRetentionDays(3, null)).toBe(3);
    expect(effectiveSnapshotRetentionDays(30, 2)).toBe(2);
    expect(effectiveSnapshotRetentionDays(5, 5)).toBe(5);
    expect(effectiveSnapshotRetentionDays(400, 90)).toBe(90);
  });

  it("uten rad: standardvinduene og `configured: false`; med rad: kun dager og tidspunkt (aldri tenant, aktør eller andre kolonner)", () => {
    expect(describeRetention(null)).toEqual({ configured: false, retention_days: 30, snapshot_retention_days: null, effective_snapshot_retention_days: 7, updated_at: null });
    const view = describeRetention({ retention_days: 14, snapshot_retention_days: 3, updated_at: new Date("2026-11-20T10:00:00.000Z"), ...{ tenant_id: "t", actor_person_id: "p", memory_space_id: "home" } } as never);
    expect(view).toEqual({ configured: true, retention_days: 14, snapshot_retention_days: 3, effective_snapshot_retention_days: 3, updated_at: "2026-11-20T10:00:00.000Z" });
    expect(Object.keys(view).sort()).toEqual(["configured", "effective_snapshot_retention_days", "retention_days", "snapshot_retention_days", "updated_at"]);
    expect(describeRetention({ retention_days: 5, snapshot_retention_days: null, updated_at: "ikke en dato" }).updated_at).toBeNull();
    expect(describeRetention({ retention_days: 5, snapshot_retention_days: null }).effective_snapshot_retention_days).toBe(5);
  });
});

describe("forkorting (retentionShortening): sammenlignet på de EFFEKTIVE vinduene", () => {
  const view = (retention: number, snapshot: number | null): VisionRetentionView => describeRetention({ retention_days: retention, snapshot_retention_days: snapshot, updated_at: null });
  const DEFAULTS = describeRetention(null);
  const cases: Array<[string, VisionRetentionView, { retention_days: number; snapshot_retention_days: number | null }, { retention_days: boolean; snapshot_retention_days: boolean }]> = [
    ["uendret mot standard", DEFAULTS, { retention_days: 30, snapshot_retention_days: null }, { retention_days: false, snapshot_retention_days: false }],
    ["bildevindu 7 uttrykt eksplisitt = standard", DEFAULTS, { retention_days: 30, snapshot_retention_days: 7 }, { retention_days: false, snapshot_retention_days: false }],
    ["kortere bildevindu", DEFAULTS, { retention_days: 30, snapshot_retention_days: 3 }, { retention_days: false, snapshot_retention_days: true }],
    ["kortere hendelsesvindu som ikke klemmer bildene (10 >= 7)", DEFAULTS, { retention_days: 10, snapshot_retention_days: null }, { retention_days: true, snapshot_retention_days: false }],
    ["kortere hendelsesvindu som klemmer bildene (5 < 7)", DEFAULTS, { retention_days: 5, snapshot_retention_days: null }, { retention_days: true, snapshot_retention_days: true }],
    ["lengre hendelser", DEFAULTS, { retention_days: 365, snapshot_retention_days: null }, { retention_days: false, snapshot_retention_days: false }],
    ["lengre bilder", DEFAULTS, { retention_days: 30, snapshot_retention_days: 30 }, { retention_days: false, snapshot_retention_days: false }],
    ["fra konfigurert: samme verdier", view(14, 3), { retention_days: 14, snapshot_retention_days: 3 }, { retention_days: false, snapshot_retention_days: false }],
    ["fra konfigurert: tilbake til standard bildevindu (3 -> 7) forlenger", view(14, 3), { retention_days: 14, snapshot_retention_days: null }, { retention_days: false, snapshot_retention_days: false }],
    ["fra konfigurert: hendelsesvindu 14 -> 2 klemmer bildene 3 -> 2", view(14, 3), { retention_days: 2, snapshot_retention_days: null }, { retention_days: true, snapshot_retention_days: true }],
    ["fra klemt (hendelser 5, bilder effektivt 5): å heve bildevinduet til 7 forkorter ingenting", view(5, null), { retention_days: 5, snapshot_retention_days: 5 }, { retention_days: false, snapshot_retention_days: false }],
    ["fra 365/90 ned til 364/90: kun hendelsene", view(365, 90), { retention_days: 364, snapshot_retention_days: 90 }, { retention_days: true, snapshot_retention_days: false }]
  ];
  for (const [name, previous, next, expected] of cases) {
    it(name, () => {
      expect(retentionShortening(previous, next)).toEqual(expected);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Ekte Postgres
// ---------------------------------------------------------------------------------------------------------------------
describe("applyRetentionPolicy: første setting, gjenspilling, forkorting og forlengelse", () => {
  it("første setting oppretter raden: previous = standardene (configured: false), aktør og tidspunkt lagres, og revisjonsraden bærer kun tall og enums", async () => {
    const out = await apply(T.tenant, "personal", 60, 14);
    expect(out.changed).toBe(true);
    expect(out.shortened).toEqual({ retention_days: false, snapshot_retention_days: false });
    expect(out.previous).toEqual({ configured: false, retention_days: 30, snapshot_retention_days: null, effective_snapshot_retention_days: 7, updated_at: null });
    expect(out.current).toMatchObject({ configured: true, retention_days: 60, snapshot_retention_days: 14, effective_snapshot_retention_days: 14 });
    expect(await policyRow(T.tenant, "personal")).toMatchObject({ retention_days: 60, snapshot_retention_days: 14, actor_person_id: T.owner });
    expect(await vision.getRetentionView(T.tenant, "personal")).toEqual(out.current);

    const rows = (await auditRows(T.tenant)).filter((r) => r.payload["memory_space"] === "personal");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ person_id: T.owner, session_id: "s-g3b", device_id: "d-g3b", decision: "ALLOW", tool_id: "vision", action: "retention_set", task_id: "g3b-test" });
    expect(rows[0]?.payload).toEqual({
      memory_space: "personal", previous_configured: false, previous_retention_days: 30, previous_snapshot_retention_days: null,
      retention_days: 60, snapshot_retention_days: 14, effective_snapshot_retention_days: 14, shortened: [], confirmed: false
    });
    for (const value of Object.values(rows[0]?.payload ?? {})) expect(["string", "number", "boolean", "object"]).toContain(typeof value);
  });

  it("gjenspilling av SAMME forespørsel er en no-op: changed false, raden og `updated_at` er urørt, ingen ny revisjonsrad - også fra en annen aktør", async () => {
    const before = await policyRow(T.tenant, "personal");
    const auditBefore = (await auditRows(T.tenant)).length;
    const again = await apply(T.tenant, "personal", 60, 14);
    expect(again.changed).toBe(false);
    expect(again.shortened).toEqual({ retention_days: false, snapshot_retention_days: false });
    expect(again.current).toEqual(again.previous);
    const other = await apply(T.tenant, "personal", 60, 14, { actor_person_id: T.other });
    expect(other.changed).toBe(false);
    expect(await policyRow(T.tenant, "personal")).toEqual(before); // `actor_person_id` er fortsatt eieren, `updated_at` uendret
    expect((await auditRows(T.tenant)).length).toBe(auditBefore);
  });

  it("forkorting UTEN bekreftelse kastes FØR noe skrives (raden, `updated_at` og revisjonen er urørt) og forteller hvilke vinduer som blir kortere", async () => {
    const before = await policyRow(T.tenant, "personal");
    const auditBefore = (await auditRows(T.tenant)).length;
    for (const confirm of [undefined, false]) {
      const err = await apply(T.tenant, "personal", 20, 14, { confirm_shortening: confirm }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VisionRetentionConfirmationRequiredError);
      expect((err as VisionRetentionConfirmationRequiredError).shortened).toEqual(["retention_days"]);
      expect((err as Error).message).toBe("vision_retention_confirmation_required:retention_days");
    }
    const imagesOnly = await apply(T.tenant, "personal", 60, 3).catch((e: unknown) => e);
    expect((imagesOnly as VisionRetentionConfirmationRequiredError).shortened).toEqual(["snapshot_retention_days"]);
    const both = await apply(T.tenant, "personal", 10, null).catch((e: unknown) => e);
    expect((both as VisionRetentionConfirmationRequiredError).shortened).toEqual(["retention_days", "snapshot_retention_days"]);
    expect(await policyRow(T.tenant, "personal")).toEqual(before);
    expect((await auditRows(T.tenant)).length).toBe(auditBefore);
  });

  it("forkorting MED bekreftelse skrives og revideres (shortened + confirmed + forrige verdier)", async () => {
    const out = await apply(T.tenant, "personal", 20, 14, { confirm_shortening: true });
    expect(out.changed).toBe(true);
    expect(out.shortened).toEqual({ retention_days: true, snapshot_retention_days: false });
    expect(out.previous).toMatchObject({ configured: true, retention_days: 60, snapshot_retention_days: 14 });
    expect(out.current).toMatchObject({ retention_days: 20, snapshot_retention_days: 14 });
    const last = (await auditRows(T.tenant)).filter((r) => r.payload["memory_space"] === "personal").at(-1);
    expect(last?.payload).toMatchObject({ previous_retention_days: 60, previous_snapshot_retention_days: 14, retention_days: 20, snapshot_retention_days: 14, shortened: ["retention_days"], confirmed: true });
  });

  it("forlengelse krever ingen bekreftelse (kun hendelser, kun bilder, begge)", async () => {
    expect(await apply(T.tenant, "personal", 90, 14)).toMatchObject({ changed: true, shortened: { retention_days: false, snapshot_retention_days: false } });
    expect(await apply(T.tenant, "personal", 90, 30)).toMatchObject({ changed: true, shortened: { retention_days: false, snapshot_retention_days: false } });
    expect(await apply(T.tenant, "personal", 120, 30)).toMatchObject({ changed: true, shortened: { retention_days: false, snapshot_retention_days: false } });
  });

  it("å sette bildevinduet tilbake til standard (null) fra et LENGRE bildevindu er en forkorting og krever bekreftelse; fra et kortere er det en forlengelse", async () => {
    // nå: (120, 30). null = standard 7 < 30 -> forkorting
    const err = await apply(T.tenant, "personal", 120, null).catch((e: unknown) => e);
    expect((err as VisionRetentionConfirmationRequiredError).shortened).toEqual(["snapshot_retention_days"]);
    expect(await apply(T.tenant, "personal", 120, null, { confirm_shortening: true })).toMatchObject({ changed: true, shortened: { snapshot_retention_days: true } });
    expect((await policyRow(T.tenant, "personal"))?.["snapshot_retention_days"]).toBeNull();
    // (120, null) -> (120, 5): effektivt 7 -> 5 er en forkorting; (120, 5) -> (120, null) er en forlengelse (5 -> 7)
    await apply(T.tenant, "personal", 120, 5, { confirm_shortening: true });
    expect(await apply(T.tenant, "personal", 120, null)).toMatchObject({ changed: true, shortened: { snapshot_retention_days: false } });
  });

  it("en første setting LIK standardene (30, null) oppretter raden (changed true, ingen bekreftelse); en første setting kortere enn standard krever bekreftelse", async () => {
    const first = await apply(T2.tenant, "home", 30, null);
    expect(first).toMatchObject({ changed: true, previous: { configured: false }, current: { configured: true, retention_days: 30, snapshot_retention_days: null, effective_snapshot_retention_days: 7 } });
    expect(await policyRow(T2.tenant, "home")).toMatchObject({ retention_days: 30, snapshot_retention_days: null });
    expect((await apply(T2.tenant, "home", 30, null)).changed).toBe(false);

    const fresh = await apply(T2.tenant, "personal", 10, null).catch((e: unknown) => e);
    expect((fresh as VisionRetentionConfirmationRequiredError).shortened).toEqual(["retention_days"]); // 30 -> 10, bildene (effektivt 7) er uendret
    expect(await policyRow(T2.tenant, "personal")).toBeUndefined();
    expect(await apply(T2.tenant, "personal", 10, null, { confirm_shortening: true })).toMatchObject({ changed: true, shortened: { retention_days: true, snapshot_retention_days: false } });
  });

  it("ugyldig inndata gir en valideringsfeil FØR noe leses eller skrives - også uten bekreftelse, og bekreftelse redder ingenting", async () => {
    const before = await policyRow(T.tenant, "personal");
    const auditBefore = (await auditRows(T.tenant)).length;
    for (const [retention, snapshot, field, detail] of [[0, null, "retention_days", "below_min"], [366, null, "retention_days", "above_max"], [30, 31, "snapshot_retention_days", "exceeds_retention_days"], [undefined, null, "retention_days", "required"], [30, undefined, "snapshot_retention_days", "required"], ["30", null, "retention_days", "not_integer"]] as const) {
      for (const confirm of [false, true]) {
        const err = await apply(T.tenant, "personal", retention, snapshot, { confirm_shortening: confirm }).catch((e: unknown) => e);
        expect(err, `${String(retention)}/${String(snapshot)}`).toBeInstanceOf(VisionObservationValidationError);
        expect(err).toMatchObject({ field, detail });
      }
    }
    expect(await policyRow(T.tenant, "personal")).toEqual(before);
    expect((await auditRows(T.tenant)).length).toBe(auditBefore);
  });

  it("uten `audit: true` (interne kallere) skrives ingen revisjonsrad, ellers er oppførselen lik", async () => {
    const auditBefore = (await auditRows(T2.tenant)).length;
    await apply(T2.tenant, "home", 45, 10, { audit: undefined });
    expect((await auditRows(T2.tenant)).length).toBe(auditBefore);
    expect(await policyRow(T2.tenant, "home")).toMatchObject({ retention_days: 45, snapshot_retention_days: 10 });
  });

  it("revisjonen er i SAMME transaksjon: feiler revisjonsraden, rulles endringen tilbake (ingen endring uten revisjon)", async () => {
    await db.admin.query(`ALTER TABLE audit_events ADD CONSTRAINT zz_block_vision_retention CHECK (type <> 'vision.retention_set') NOT VALID`);
    try {
      const before = await policyRow(T.tenant, "home");
      await expect(apply(T.tenant, "home", 77, 7)).rejects.toThrow(/zz_block_vision_retention/);
      expect(await policyRow(T.tenant, "home")).toEqual(before);
      // uten revisjon (audit av) er raden ikke blokkert
      await expect(apply(T.tenant, "home", 77, 7, { audit: undefined })).resolves.toMatchObject({ changed: true });
    } finally {
      await db.admin.query(`ALTER TABLE audit_events DROP CONSTRAINT zz_block_vision_retention`);
    }
  });
});

describe("isolasjon: tenant og memory space", () => {
  it("en setting for (tenant, space) rører ikke andre spaces eller andre tenanter, og lesingen er scopet av RLS", async () => {
    await apply(T.tenant, "home", 11, 2, { confirm_shortening: true });
    expect(await vision.getRetentionView(T.tenant, "home")).toMatchObject({ configured: true, retention_days: 11, snapshot_retention_days: 2 });
    expect(await vision.getRetentionView(T.tenant, "personal")).toMatchObject({ configured: true }); // egen rad fra tidligere test (120/null)
    expect((await vision.getRetentionView(T.tenant, "personal")).retention_days).not.toBe(11);
    expect(await vision.getRetentionView(T.tenant, "guest")).toEqual(describeRetention(null)); // aldri satt: standardene
    expect(await vision.getRetentionView(T2.tenant, "guest")).toEqual(describeRetention(null));
    // T2 har sin egen rad i `home` (45/10 fra tidligere test), uberørt av T sin
    expect(await vision.getRetentionView(T2.tenant, "home")).toMatchObject({ retention_days: 45, snapshot_retention_days: 10 });
  });

  it("`getRetentionView` gir kun de fem synlige feltene (ingen tenant, aktør eller rom)", async () => {
    expect(Object.keys(await vision.getRetentionView(T.tenant, "home")).sort()).toEqual(["configured", "effective_snapshot_retention_days", "retention_days", "snapshot_retention_days", "updated_at"]);
  });
});

describe("lås: forkorting avgjøres mot raden som faktisk overskrives (ingen sjekk-så-skriv-glipp)", () => {
  it("tjenesten tar en advisory-lås per (tenant, space) og leser raden ETTER at den har fått låsen; et annet space blokkeres ikke", async () => {
    await apply(T.tenant, "personal", 40, null, { confirm_shortening: true });
    const holder = await db.admin.connect();
    let open = false;
    try {
      await holder.query("BEGIN");
      open = true;
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`vision-retention:${T.tenant}:personal`]);
      let settled = false;
      const pending = apply(T.tenant, "personal", 45, null).then((value) => value, (err: unknown) => err).finally(() => { settled = true; });
      await sleep(500);
      expect(settled, "forespørselen må vente på låsen").toBe(false);
      // et ANNET space (annen lås) blokkeres ikke
      await expect(apply(T.tenant, "guest", 33, null)).resolves.toMatchObject({ changed: true });
      // mens låsen holdes, endrer en annen skriver raden til 60 - lengre enn forespørselens 45
      await holder.query(`UPDATE vision_retention_policies SET retention_days = 60 WHERE tenant_id = $1 AND memory_space_id = 'personal'`, [T.tenant]);
      await holder.query("COMMIT");
      open = false;
      const outcome = await pending;
      // 40 -> 45 var en forlengelse da forespørselen startet, men mot raden den faktisk overskriver (60) er 45 en FORKORTING: den leses etter låsen, så bekreftelse kreves
      expect(outcome).toBeInstanceOf(VisionRetentionConfirmationRequiredError);
      expect(await policyRow(T.tenant, "personal")).toMatchObject({ retention_days: 60 });
    } finally {
      if (open) await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  }, 30_000);

  it("samtidige forespørsler serialiseres: revisjonskjeden henger sammen (hver `previous` er forrige `current`), ingen oppdatering går tapt, og `shortened`/`confirmed` stemmer mot raden som faktisk ble overskrevet", async () => {
    await apply(T.tenant, "guest", 100, null, { confirm_shortening: true });
    const before = (await auditRows(T.tenant)).filter((r) => r.payload["memory_space"] === "guest").length;
    const values = [110, 90, 130, 80, 150, 160];
    const results = await Promise.all(values.map((v) => apply(T.tenant, "guest", v, null, { confirm_shortening: true })));
    expect(results.every((r) => r.changed)).toBe(true);
    const rows = (await auditRows(T.tenant)).filter((r) => r.payload["memory_space"] === "guest").slice(before);
    expect(rows).toHaveLength(values.length);
    let expectedPrevious = 100;
    for (const row of rows) {
      const { previous_retention_days: previous, retention_days: next, shortened, confirmed } = row.payload as { previous_retention_days: number; retention_days: number; shortened: string[]; confirmed: boolean };
      expect(previous, "kjeden er sammenhengende").toBe(expectedPrevious);
      expect(shortened.includes("retention_days"), `${previous} -> ${next}`).toBe(next < previous);
      expect(confirmed).toBe(next < previous);
      expectedPrevious = next;
    }
    expect(rows.map((r) => r.payload["retention_days"]).sort()).toEqual([...values].sort()); // ingen oppdatering gikk tapt
    expect((await policyRow(T.tenant, "guest"))?.["retention_days"]).toBe(rows.at(-1)?.payload["retention_days"]);
  }, 30_000);
});

describe("setRetentionPolicy (eksisterende) er uendret av refaktoreringen", () => {
  it("full erstatning: utelatt bildevindu blir `NULL` (standard), aktør lagres, og ugyldig inndata gir de gamle kodene - ingen revisjon og ingen øvre grense her (grensene gjelder eierveien)", async () => {
    const set = await vision.setRetentionPolicy(T2.tenant, "guest", { retention_days: 25, snapshot_retention_days: 4, actor_person_id: T2.owner });
    expect(set).toMatchObject({ tenant_id: T2.tenant, memory_space_id: "guest", retention_days: 25, snapshot_retention_days: 4, actor_person_id: T2.owner });
    expect(await vision.setRetentionPolicy(T2.tenant, "guest", { retention_days: 26 })).toMatchObject({ retention_days: 26, snapshot_retention_days: null, actor_person_id: null });
    await expect(vision.setRetentionPolicy(T2.tenant, "guest", { retention_days: 0 })).rejects.toMatchObject({ field: "retention_days", detail: "must_be_positive_integer" });
    await expect(vision.setRetentionPolicy(T2.tenant, "guest", { retention_days: 5, snapshot_retention_days: 0 })).rejects.toMatchObject({ field: "snapshot_retention_days", detail: "must_be_positive_integer" });
    expect((await vision.getRetentionPolicy(T2.tenant, "guest"))?.retention_days).toBe(26);
    expect((await auditRows(T2.tenant)).filter((r) => r.payload["memory_space"] === "guest")).toHaveLength(0);
  });
});

describe("TRIPWIRE: en endring av vinduene er FORANKRET VED SKRIVING - den sletter ikke eksisterende hendelser, bilder eller inventar", () => {
  const counts = async (): Promise<{ events: number; snapshots: number; inventory: number }> => ({
    events: await scalar(`SELECT count(*)::int AS n FROM vision_event_observations WHERE tenant_id = $1 AND memory_space_id = 'home'`, [T.tenant]),
    snapshots: await scalar(`SELECT count(*)::int AS n FROM vision_snapshots WHERE tenant_id = $1 AND memory_space_id = 'home'`, [T.tenant]),
    inventory: await scalar(`SELECT count(*)::int AS n FROM vision_inventory_items WHERE tenant_id = $1 AND memory_space_id = 'home'`, [T.tenant])
  });
  const expiries = async (): Promise<string[]> => (await db.admin.query(
    `SELECT 'obs:' || observation_id || ':' || retention_expires_at::text AS e FROM vision_event_observations WHERE tenant_id = $1 AND memory_space_id = 'home'
     UNION ALL SELECT 'snap:' || snapshot_id || ':' || retention_expires_at::text FROM vision_snapshots WHERE tenant_id = $1 AND memory_space_id = 'home'
     UNION ALL SELECT 'inv:' || object_label || ':' || expires_at::text FROM vision_inventory_items WHERE tenant_id = $1 AND memory_space_id = 'home' ORDER BY 1`, [T.tenant])).rows.map((r) => (r as { e: string }).e);
  const days = async (sql: string, id: string): Promise<number> => Number(((await db.admin.query(sql, [id])).rows[0] as { days: string }).days);

  it("forkorting 30/7 -> 1/1 med bekreftelse: ingen eksisterende rad slettes av noen sveipemetode (heller ikke den daglige fulle kjøringen), og utløpene er urørt; nye rader får det nye vinduet", async () => {
    await db.admin.query(`DELETE FROM vision_retention_policies WHERE tenant_id = $1 AND memory_space_id = 'home'`, [T.tenant]);
    const a = await capture();
    const b = await capture();
    const before = await counts();
    expect(before.events).toBeGreaterThanOrEqual(4);
    expect(before.snapshots).toBeGreaterThanOrEqual(2);
    expect(before.inventory).toBeGreaterThanOrEqual(2);
    const expiriesBefore = await expiries();
    expect(await days(`SELECT extract(epoch FROM (retention_expires_at - now())) / 86400 AS days FROM vision_snapshots WHERE snapshot_id = $1`, a.snapshot_id)).toBeCloseTo(7, 1);
    expect(await days(`SELECT min(extract(epoch FROM (retention_expires_at - now())) / 86400) AS days FROM vision_event_observations WHERE observation_id = ANY($1::text[])`, `{${a.observation_ids.join(",")}}`)).toBeCloseTo(30, 1);

    const out = await apply(T.tenant, "home", 1, 1, { confirm_shortening: true });
    expect(out).toMatchObject({ changed: true, shortened: { retention_days: true, snapshot_retention_days: true } });

    // alle sveipene som finnes: hendelser, bilder, inventar og hele vedlikeholdssveipet (full kjøring) - ingenting av det eksisterende er utløpt
    expect(await vision.purgeExpiredObservations(T.tenant, "home")).toBe(0);
    expect(await snapshots.purgeExpiredSnapshots(T.tenant, "home")).toBe(0);
    expect(await inventory.purgeExpired(T.tenant, "home")).toBe(0);
    const swept = await runVisionMaintenanceSweepForAllTenants(db.app, { snapshots, inventory, embeddings });
    expect(swept.failed).toEqual([]);
    expect(swept.snapshots_purged).toBe(0);
    expect(swept.inventory_purged).toBe(0);
    expect(await counts()).toEqual(before);
    expect(await expiries()).toEqual(expiriesBefore);

    // en NY hendelse etter endringen får det nye (1 døgn) vinduet på alle tre tabeller
    const c = await capture();
    expect(await days(`SELECT extract(epoch FROM (retention_expires_at - now())) / 86400 AS days FROM vision_snapshots WHERE snapshot_id = $1`, c.snapshot_id)).toBeCloseTo(1, 1);
    expect(await days(`SELECT max(extract(epoch FROM (retention_expires_at - now())) / 86400) AS days FROM vision_event_observations WHERE observation_id = ANY($1::text[])`, `{${c.observation_ids.join(",")}}`)).toBeCloseTo(1, 1);
    expect(await days(`SELECT extract(epoch FROM (expires_at - now())) / 86400 AS days FROM vision_inventory_items WHERE tenant_id = '${T.tenant}' AND object_label = $1`, c.label)).toBeCloseTo(1, 1);
    // ... og de gamle har fortsatt sine opprinnelige utløp (30 / 7 dager)
    expect(await days(`SELECT extract(epoch FROM (retention_expires_at - now())) / 86400 AS days FROM vision_snapshots WHERE snapshot_id = $1`, b.snapshot_id)).toBeCloseTo(7, 1);
    expect(await days(`SELECT extract(epoch FROM (expires_at - now())) / 86400 AS days FROM vision_inventory_items WHERE tenant_id = '${T.tenant}' AND object_label = $1`, b.label)).toBeCloseTo(30, 1);
  }, 120_000);
});

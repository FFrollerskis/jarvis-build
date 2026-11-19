import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemorySpace } from "@jarvis/contracts";
import { VisionCameraService, type VisionCamera } from "../src/cameras.ts";
import { VisionIngestPipeline } from "../src/pipeline.ts";
import { VisionPoller, startVisionPoller, type VisionPollerGuard } from "../src/poller.ts";
import { VisionService } from "../src/service.ts";
import type { CapturedImage, VisionSource, VisionSourceCamera, VisionSourceEvent } from "../src/source.ts";
import { makeJpeg, seedTenant, startVisionDb, type VisionDb } from "./support/harness.ts";

/**
 * WP-G3 (D-465), P1a: bakgrunnspolleren mot en ekte embedded Postgres. Bevist: alle tenants/spaces/personer polles under kameraets EGEN person_id med merking (task_id/session_id), påslåtte kameraer
 * av riktig kildetype, eier-kontrollene (kill switch m.m.) stopper alt FØR første lesing og mellom spaces (fail-closed ved feil i porten), én feil velter ikke resten, og aldri to runder samtidig.
 */
let db: VisionDb;
let T1: Awaited<ReturnType<typeof seedTenant>>;
let T2: Awaited<ReturnType<typeof seedTenant>>;
let cameras: VisionCameraService;
let BOTH: string[] = [];
let vision: VisionService;
let pipeline: VisionIngestPipeline;
let source: EventPerCameraSource;
let blockedReason: string | null = null;
let counter = 0;

/** Leverer ÉN fersk hendelse per kamera polleren gir den (og et bilde ved forespørsel). */
class EventPerCameraSource implements VisionSource {
  readonly source_type = "home_assistant";
  polls: VisionSourceCamera[][] = [];
  delayMs = 0;
  async pollEvents(cams: readonly VisionSourceCamera[], now: Date): Promise<VisionSourceEvent[]> {
    this.polls.push([...cams]);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return cams.map((c) => ({
      source_type: "home_assistant", source_instance_id: c.camera_id, source_event_id: `${c.source_ref}@${now.toISOString()}`, event_type: "motion_detected" as const,
      observed_at: now.toISOString(), age_ms: 1000, trigger: c.trigger_entities[0] ?? "binary_sensor.x"
    }));
  }
  async fetchSnapshot(): Promise<CapturedImage> {
    return { bytes: makeJpeg(), declared_type: "image/jpeg" };
  }
}

const guard: VisionPollerGuard = {
  blocked: async () => {
    return blockedReason;
  }
};

const reg = (tenant: string, space: MemorySpace, person: string, over: Partial<{ enabled: boolean; source_type: "home_assistant" | "iphone" }> = {}): Promise<VisionCamera> => {
  counter += 1;
  const sourceType = over.source_type ?? "home_assistant";
  return cameras.registerCamera(tenant, space, {
    person_id: person, label: `Kamera ${counter}`, source_type: sourceType, source_ref: sourceType === "iphone" ? `iphone-${counter}` : `camera.p${counter}`,
    ...(sourceType === "home_assistant" ? { trigger_entities: [`binary_sensor.p${counter}`] } : {}), zone_kind: "home", route_policy: "local_only", enabled: over.enabled ?? true
  });
};

beforeAll(async () => {
  db = await startVisionDb("g3poll");
  T1 = await seedTenant(db, "g3p-t1");
  T2 = await seedTenant(db, "g3p-t2");
  BOTH = [T1.tenant, T2.tenant];
  vision = new VisionService(db.app);
  cameras = new VisionCameraService(db.app);
  pipeline = new VisionIngestPipeline({ pool: db.app, vision, enabled: true, storeSnapshots: false });
}, 240_000);

afterAll(async () => {
  await db?.stop();
}, 120_000);

beforeEach(async () => {
  blockedReason = null;
  source = new EventPerCameraSource();
  await db.admin.query(`DELETE FROM vision_event_observations`);
  await db.admin.query(`DELETE FROM vision_cameras`);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("én runde", () => {
  it("polles på tvers av tenants, spaces og personer: hvert kamera behandles under sin EGEN person, med task_id/session_id; deaktiverte og andre kildetyper hoppes over", async () => {
    const a = await reg(T1.tenant, "home", T1.owner);
    const b = await reg(T1.tenant, "home", T1.other);
    const c = await reg(T1.tenant, "personal", T1.owner);
    const d = await reg(T2.tenant, "home", T2.owner);
    await reg(T1.tenant, "home", T1.owner, { enabled: false });
    await reg(T1.tenant, "home", T1.owner, { source_type: "iphone" });

    const result = await new VisionPoller({ pool: db.app, cameras, pipeline, source, guard, tenantIds: BOTH }).tick();
    expect(result).toMatchObject({ status: "ok", spaces_polled: 3, cameras_polled: 4, failed_spaces: 0, summary: { events_seen: 4, recorded: 4, failed: 0 } });

    const rows = (await db.admin.query(`SELECT source_instance_id, tenant_id, memory_space_id, person_id, task_id, session_id, event_type FROM vision_event_observations ORDER BY source_instance_id`)).rows as Array<Record<string, string>>;
    expect(rows).toHaveLength(4);
    const expected = new Map([[a.camera_id, [T1.tenant, "home", T1.owner]], [b.camera_id, [T1.tenant, "home", T1.other]], [c.camera_id, [T1.tenant, "personal", T1.owner]], [d.camera_id, [T2.tenant, "home", T2.owner]]]);
    for (const row of rows) {
      const [tenant, space, person] = expected.get(row["source_instance_id"] as string) as string[];
      expect(row).toMatchObject({ tenant_id: tenant, memory_space_id: space, person_id: person, task_id: "vision-poll:home_assistant", session_id: "vision-poller", event_type: "motion_detected" });
    }
    // Kilden så kun PÅSLÅTTE home_assistant-kameraer (aldri det deaktiverte, aldri iPhone-kameraet), gruppert per (tenant, space, person).
    const seen = source.polls.flat().map((cam) => cam.camera_id).sort();
    expect(seen).toEqual([a.camera_id, b.camera_id, c.camera_id, d.camera_id].sort());
  });

  it("KUN oppgitte tenanter polles: en annen tenants kameraer leses aldri med denne kildens credential (tom liste = ingenting)", async () => {
    const mine = await reg(T1.tenant, "home", T1.owner);
    await reg(T2.tenant, "home", T2.owner);
    const only = await new VisionPoller({ pool: db.app, cameras, pipeline, source, guard, tenantIds: [T1.tenant] }).tick();
    expect(only).toMatchObject({ status: "ok", cameras_polled: 1, summary: { recorded: 1 } });
    expect(source.polls.flat().map((c) => c.camera_id)).toEqual([mine.camera_id]);
    expect(((await db.admin.query(`SELECT count(*)::int AS n FROM vision_event_observations WHERE tenant_id = $1`, [T2.tenant])).rows[0] as { n: number }).n).toBe(0);
    source.polls.length = 0;
    expect(await new VisionPoller({ pool: db.app, cameras, pipeline, source, guard, tenantIds: [] }).tick()).toMatchObject({ status: "ok", spaces_polled: 0, cameras_polled: 0 });
    expect(source.polls).toEqual([]);
  });

  it("en ny runde av samme tilstand er duplikater (idempotens), ikke nye rader", async () => {
    await reg(T1.tenant, "home", T1.owner);
    const poller = new VisionPoller({ pool: db.app, cameras, pipeline, source, guard, tenantIds: BOTH });
    const fixed = new Date();
    source.pollEvents = async (cams) => cams.map((c) => ({ source_type: "home_assistant", source_instance_id: c.camera_id, source_event_id: `${c.source_ref}@fixed`, event_type: "motion_detected" as const, observed_at: fixed.toISOString(), age_ms: 1000, trigger: "binary_sensor.x" }));
    expect(await poller.tick()).toMatchObject({ status: "ok", summary: { recorded: 1, duplicates: 0 } });
    expect(await poller.tick()).toMatchObject({ status: "ok", summary: { recorded: 0, duplicates: 1 } });
    expect(((await db.admin.query(`SELECT count(*)::int AS n FROM vision_event_observations`)).rows[0] as { n: number }).n).toBe(1);
  });

  it("ingen kameraer = en tom, vellykket runde (kilden spørres ikke)", async () => {
    expect(await new VisionPoller({ pool: db.app, cameras, pipeline, source, guard, tenantIds: BOTH }).tick()).toMatchObject({ status: "ok", spaces_polled: 0, cameras_polled: 0 });
    expect(source.polls).toEqual([]);
  });
});

describe("eier-kontroller (fail-closed)", () => {
  it("stanset (kill switch/frosset/tilbakekalt): ingen lesing av kilden, ingen rader - porten sjekkes FØR alt", async () => {
    await reg(T1.tenant, "home", T1.owner);
    blockedReason = "kill_switch_active";
    expect(await new VisionPoller({ pool: db.app, cameras, pipeline, source, guard, tenantIds: BOTH }).tick()).toEqual({ status: "blocked", reason: "kill_switch_active" });
    expect(source.polls).toEqual([]);
    expect(((await db.admin.query(`SELECT count(*)::int AS n FROM vision_event_observations`)).rows[0] as { n: number }).n).toBe(0);
  });

  it("en port som kaster tolkes som stanset (guard_error), aldri som «kjør»", async () => {
    await reg(T1.tenant, "home", T1.owner);
    const broken: VisionPollerGuard = { blocked: async () => { throw new Error("db nede"); } };
    expect(await new VisionPoller({ pool: db.app, cameras, pipeline, source, guard: broken, tenantIds: BOTH }).tick()).toEqual({ status: "blocked", reason: "guard_error" });
    expect(source.polls).toEqual([]);
  });

  it("stanses eieren midt i runden, stopper polleren før neste space (porten sjekkes per space)", async () => {
    await reg(T1.tenant, "home", T1.owner);
    await reg(T1.tenant, "personal", T1.owner);
    await reg(T2.tenant, "home", T2.owner);
    // Eieren stanser systemet så snart den første kilde-lesingen er gjort: resten av spacene (to til med kameraer) polles ikke.
    const flipping: VisionPollerGuard = { blocked: async () => (source.polls.length >= 1 ? "connector_frozen" : null) };
    const result = await new VisionPoller({ pool: db.app, cameras, pipeline, source, guard: flipping, tenantIds: BOTH }).tick();
    expect(result).toEqual({ status: "blocked", reason: "connector_frozen" });
    expect(source.polls).toHaveLength(1);
  });
});

describe("robusthet", () => {
  it("et space som feiler velter ikke resten: telles som failed_spaces og logges med kode", async () => {
    const good = await reg(T2.tenant, "home", T2.owner);
    await reg(T1.tenant, "home", T1.owner);
    const flaky = {
      listEnabledForPolling: async (tenantId: string, space: MemorySpace, sourceType: "home_assistant" | "iphone"): Promise<VisionCamera[]> => {
        if (tenantId === T1.tenant) throw Object.assign(new Error("boom"), { code: "57P01" });
        return cameras.listEnabledForPolling(tenantId, space, sourceType);
      }
    };
    const result = await new VisionPoller({ pool: db.app, cameras: flaky, pipeline, source, guard, tenantIds: BOTH }).tick();
    expect(result).toMatchObject({ status: "ok", cameras_polled: 1, summary: { recorded: 1 } });
    expect((result as { failed_spaces: number }).failed_spaces).toBeGreaterThanOrEqual(1);
    expect(source.polls.flat().map((c) => c.camera_id)).toEqual([good.camera_id]);
  });

  it("kildefeil (HA nede) blir source_error i oppsummeringen - runden kaster aldri", async () => {
    await reg(T1.tenant, "home", T1.owner);
    source.pollEvents = async () => { throw new Error("home_assistant_error_503"); };
    expect(await new VisionPoller({ pool: db.app, cameras, pipeline, source, guard, tenantIds: BOTH }).tick()).toMatchObject({ status: "ok", summary: { source_error: "home_assistant_error_503", recorded: 0 } });
  });

  it("aldri to runder samtidig i prosessen (tick_in_progress)", async () => {
    await reg(T1.tenant, "home", T1.owner);
    source.delayMs = 150;
    const poller = new VisionPoller({ pool: db.app, cameras, pipeline, source, guard, tenantIds: BOTH });
    const [first, second] = await Promise.all([poller.tick(), poller.tick()]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["blocked", "ok"]);
    expect([first, second].find((r) => r.status === "blocked")).toEqual({ status: "blocked", reason: "tick_in_progress" });
    expect(source.polls).toHaveLength(1);
    expect(await poller.tick()).toMatchObject({ status: "ok" }); // løsnet igjen etterpå
  });

  it("en ustøttet kildetype avvises ved konstruksjon", () => {
    const odd = { ...source, source_type: "ftp" } as unknown as VisionSource;
    expect(() => new VisionPoller({ pool: db.app, cameras, pipeline, source: odd, guard, tenantIds: BOTH })).toThrow("vision_poller_unsupported_source");
  });
});

describe("periodisk start", () => {
  it("intervallet klemmes til minst 5 s, første runde kommer etter ett intervall, status viser siste utfall, og stop() avslutter", async () => {
    vi.useFakeTimers();
    try {
      const ticks: string[] = [];
      const stub = { tick: async () => { ticks.push("tick"); return { status: "blocked" as const, reason: "kill_switch_active" }; } } as unknown as VisionPoller;
      const handle = startVisionPoller(stub, 100, () => new Date("2026-11-18T12:00:00.000Z"));
      expect(handle.status()).toEqual({ last_tick_at: null, last_status: null, last_reason: null, last_source_error: null });
      await vi.advanceTimersByTimeAsync(4_900);
      expect(ticks).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(ticks).toHaveLength(1);
      expect(handle.status()).toEqual({ last_tick_at: "2026-11-18T12:00:00.000Z", last_status: "blocked", last_reason: "kill_switch_active", last_source_error: null });
      handle.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(ticks).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

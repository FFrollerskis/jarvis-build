import { describe, expect, it } from "vitest";
import type { MemorySpace } from "@jarvis/contracts";
import { MAX_OBSERVATIONS_PER_BATCH } from "@jarvis/situations";
import { createHealthReader, createVisionReader, HEALTH_ROWS_LIMIT, VISION_READ_LIMIT } from "../src/situation-signals-wiring.ts";

/**
 * WP-G4 (D-466) FIKS-RUNDE, B-LOW-6: tak/backpressure i kildeportene. Kamera- og helselesingen hadde ingen LIMIT (helse: 35 døgn x 3 metrikker hvert 15. tikk, kamera: alle hendelser i vinduet). Nå har hver lesing et tak (de NYESTE
 * radene), og et nådd tak er en synlig kildeadvarsel (aldri et stille tap). Helse: det eldste døgnet i et avkortet utvalg kan være delvis og droppes, så en sum (søvn, skritt) aldri blir feil lav.
 */
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const OWNER = "person-owner";
const ctxWith = (space: MemorySpace, warnings: string[]) => ({ tenant_id: "t-owner", memory_space: space, now: NOW, warnings });

describe("B-LOW-6: kameralesingen har et tak og varsler når det nås", () => {
  const event = (n: number) => ({
    observation_id: `o${n}`, event_type: "motion_detected", source_instance_id: "camera.inngang", source_event_id: `e${n}`, observed_at: new Date(NOW - n * 1000), object_label: null, classification_status: "not_applicable"
  });

  it("taket er bussens batch-tak, og lesingen ber tjenesten om høyst så mange rader", async () => {
    expect(VISION_READ_LIMIT).toBe(MAX_OBSERVATIONS_PER_BATCH);
    expect(VISION_READ_LIMIT).toBe(500);
    const asked: unknown[] = [];
    const read = createVisionReader({ ownerPersonId: OWNER, vision: { getRecentEvents: async (_t, _s, _p, filter) => { asked.push(filter); return []; } } });
    await read(ctxWith("home", []), NOW - 600_000);
    expect(asked).toEqual([{ sinceMs: NOW - 600_000, limit: 500 }]);
  });

  it("under taket: ingen advarsel; akkurat på taket: advarsel `vision_events_truncated:500` (og observasjonene leveres fortsatt)", async () => {
    const warnings: string[] = [];
    const under = createVisionReader({ ownerPersonId: OWNER, vision: { getRecentEvents: async () => Array.from({ length: VISION_READ_LIMIT - 1 }, (_, i) => event(i)) } });
    expect(await under(ctxWith("home", warnings), NOW - 600_000)).toHaveLength(VISION_READ_LIMIT - 1);
    expect(warnings).toEqual([]);
    const at = createVisionReader({ ownerPersonId: OWNER, vision: { getRecentEvents: async () => Array.from({ length: VISION_READ_LIMIT }, (_, i) => event(i)) } });
    expect(await at(ctxWith("home", warnings), NOW - 600_000)).toHaveLength(VISION_READ_LIMIT);
    expect(warnings).toEqual([`vision_events_truncated:${VISION_READ_LIMIT}`]);
  });
});

describe("B-LOW-6: helselesingen har et tak per metrikk, varsler, og dropper det (muligens delvise) eldste døgnet", () => {
  const sample = (day: string, hour: number, value: number) => ({ value, observed_at: `${day}T${String(hour).padStart(2, "0")}:00:00.000Z` });

  it("taket er 20 000 rader og sendes som femte argument sammen med 35-døgnsvinduet", async () => {
    expect(HEALTH_ROWS_LIMIT).toBe(20_000);
    const asked: unknown[] = [];
    const read = createHealthReader({ ownerPersonId: OWNER, health: { getRecentMetrics: async (...args) => { asked.push(args); return []; } } });
    await read(ctxWith("health", []), OWNER, ["steps"]);
    expect(asked).toEqual([["t-owner", OWNER, "steps", NOW - 35 * 86_400_000, 20_000]]);
  });

  it("under taket: alle rader brukes, ingen advarsel", async () => {
    const warnings: string[] = [];
    const read = createHealthReader({ ownerPersonId: OWNER, health: { getRecentMetrics: async () => [sample("2026-11-17", 8, 1000), sample("2026-11-17", 9, 500), sample("2026-11-18", 9, 700)] } });
    const out = await read(ctxWith("health", warnings), OWNER, ["steps"]);
    expect(out).toEqual([{ source: "health", metric: "steps", series: [{ day: "2026-11-17", value: 1500, samples: 2 }, { day: "2026-11-18", value: 700, samples: 1 }] }]);
    expect(warnings).toEqual([]);
  });

  it("på taket: advarsel `health_rows_truncated:<metrikk>`, og det eldste døgnet (kan være delvis, en sum ville blitt feil lav) droppes - de andre døgnene beholdes", async () => {
    const warnings: string[] = [];
    // en tjeneste som leverer akkurat HEALTH_ROWS_LIMIT rader, nyeste først: 19 998 rader for 18. nov, 1 for 17. nov og 1 delvis for 16. nov (det eldste døgnet)
    const rows = [
      ...Array.from({ length: HEALTH_ROWS_LIMIT - 2 }, (_, i) => sample("2026-11-18", 1 + (i % 20), 1)),
      sample("2026-11-17", 12, 5), sample("2026-11-16", 23, 7)
    ];
    expect(rows).toHaveLength(HEALTH_ROWS_LIMIT);
    const read = createHealthReader({ ownerPersonId: OWNER, health: { getRecentMetrics: async () => rows } });
    const out = await read(ctxWith("health", warnings), OWNER, ["steps"]);
    expect(warnings).toEqual(["health_rows_truncated:steps"]);
    const series = (out[0] as unknown as { series: Array<{ day: string; value: number; samples: number }> }).series;
    expect(series.map((p) => p.day)).toEqual(["2026-11-17", "2026-11-18"]); // 16. nov (eldste, muligens delvis) er droppet
    expect(series[1]).toMatchObject({ value: HEALTH_ROWS_LIMIT - 2, samples: HEALTH_ROWS_LIMIT - 2 });
  });

  it("advarselen er per metrikk (to metrikker på taket gir to advarsler), og en metrikk under taket gir ingen", async () => {
    const warnings: string[] = [];
    const full = (value: number) => [...Array.from({ length: HEALTH_ROWS_LIMIT - 1 }, () => sample("2026-11-18", 12, value)), sample("2026-11-17", 12, value)];
    const read = createHealthReader({
      ownerPersonId: OWNER,
      health: { getRecentMetrics: async (_t, _p, metric) => (metric === "resting_heart_rate" ? [sample("2026-11-18", 8, 60)] : full(1)) }
    });
    await read(ctxWith("health", warnings), OWNER, ["resting_heart_rate", "steps", "sleep_duration_minutes"]);
    expect(warnings).toEqual(["health_rows_truncated:steps", "health_rows_truncated:sleep_duration_minutes"]);
  });
});

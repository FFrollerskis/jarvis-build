import { describe, expect, it } from "vitest";
import type pg from "pg";
import { ProviderError, type ModelProviderAdapter, type ModelRequest, type ModelResult } from "@jarvis/provider-adapters";
import { MemoryTraceSink, ModelGateway, ProviderHealthTracker, medianOf } from "../src/index.ts";

/**
 * WP-D4 (JARVIS-033/036/078): hemmelighetsfri leverandørdetalj til `executive.get_ai_mesh_status`. Beviser at helse-sporet skiller parallell delegering fra enkeltkall (kun til målingen),
 * at tellerne ikke lekker (også ved feil), og at detaljvisningen aldri inneholder nøkler eller innhold.
 */
describe("medianOf", () => {
  it("tom liste gir undefined; ellers nærmeste-rang-median (nedre ved partall)", () => {
    expect(medianOf([])).toBeUndefined();
    expect(medianOf([7])).toBe(7);
    expect(medianOf([5, 1, 9])).toBe(5);
    expect(medianOf([4, 1, 3, 2])).toBe(2);
  });

  it("muterer ikke input", () => {
    const input = [3, 1, 2];
    medianOf(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("ProviderHealthTracker.details", () => {
  it("uten historikk: nullstilte tall, ingen valgfrie felt, tilstand fra konfigurasjon", () => {
    const h = new ProviderHealthTracker();
    expect(h.details("kimi", true)).toEqual({ state: "CONFIGURED", success: 0, failures: 0, consecutive_failures: 0, solo_samples: 0, parallel_samples: 0 });
    expect(h.details("kimi", false).state).toBe("NOT_CONFIGURED");
  });

  it("splitter latens i alene/parallell, og p50 for hver gruppe og samlet", () => {
    const h = new ProviderHealthTracker();
    for (const ms of [100, 200, 300]) h.recordSuccess("kimi", ms); // standard = alene (bakoverkompatibelt)
    for (const ms of [500, 700, 900]) h.recordSuccess("kimi", ms, true);
    const d = h.details("kimi", true);
    expect(d).toMatchObject({ state: "LIVE", success: 6, solo_samples: 3, parallel_samples: 3, p50_solo_latency_ms: 200, p50_parallel_latency_ms: 700, p50_latency_ms: 300 });
    expect(d.last_success_at).toBeTypeOf("number");
  });

  it("vinduet er begrenset (50) per gruppe: gamle prøver faller ut", () => {
    const h = new ProviderHealthTracker();
    for (let i = 0; i < 80; i += 1) h.recordSuccess("p", 1000, true);
    for (let i = 0; i < 60; i += 1) h.recordSuccess("p", 10, true);
    const d = h.details("p", true);
    expect(d.parallel_samples).toBe(50);
    expect(d.p50_parallel_latency_ms).toBe(10);
  });

  it("siste feil, feilklasse og tidspunkt følger tilstanden; en senere suksess nullstiller de påfølgende feilene men ikke historikken", () => {
    const h = new ProviderHealthTracker();
    h.recordFailure("kimi", "auth", "kimi_auth_401");
    h.recordFailure("kimi", "timeout", "kimi_timeout");
    expect(h.details("kimi", true)).toMatchObject({ failures: 2, consecutive_failures: 2, last_error: "kimi_timeout", last_error_kind: "timeout" });
    h.recordSuccess("kimi", 120);
    const after = h.details("kimi", true);
    expect(after).toMatchObject({ failures: 2, consecutive_failures: 0, last_error: "kimi_timeout", state: "LIVE" });
    expect(after.last_failure_at).toBeTypeOf("number");
  });

  it("en feilmelding kappes til 200 tegn", () => {
    const h = new ProviderHealthTracker();
    h.recordFailure("p", "server", "x".repeat(500));
    expect(h.details("p", true).last_error).toHaveLength(200);
  });

  it("details() endrer ikke tilstanden", () => {
    const h = new ProviderHealthTracker();
    h.recordSuccess("p", 5);
    const before = JSON.stringify(h.snapshot(new Map([["p", true]])));
    h.details("p", true);
    h.details("ukjent", true);
    expect(JSON.stringify(h.snapshot(new Map([["p", true]])))).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Ekte ModelGateway med fake adaptere
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }),
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}
const REQUEST: ModelRequest = { messages: [{ role: "user", content: "hei" }] };
const result = (provider: string): ModelResult => ({ text: `svar fra ${provider}`, usage: { input_tokens: 3, output_tokens: 4 }, provider, model: "m", finish_reason: "stop" });
const base = { tenant_id: "t1", purpose: "CHAT" as const, sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" as const, request: REQUEST };

function adapter(name: string, opts: { available?: boolean; fail?: ProviderError["kind"]; gate?: Promise<void>; onStart?: () => void } = {}): ModelProviderAdapter {
  return {
    name,
    model: `${name}-model`,
    available: () => opts.available ?? true,
    complete: async () => {
      opts.onStart?.();
      if (opts.gate) await opts.gate;
      if (opts.fail) throw new ProviderError(name, opts.fail, `${name}_${opts.fail}`);
      return result(name);
    }
  };
}

describe("ModelGateway.meshDetails", () => {
  it("lister alle registrerte leverandører (også ikke-konfigurerte) med profil, uten nøkkel eller innhold", () => {
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter("gemma_local"), adapter("gemma_hosted"), adapter("kimi", { available: false })] });
    const details = gateway.meshDetails();
    expect(details.map((d) => d.provider)).toEqual(["gemma_local", "gemma_hosted", "kimi"]);
    const byName = Object.fromEntries(details.map((d) => [d.provider, d]));
    expect(byName["gemma_local"]).toMatchObject({ configured: true, locality: "local", hosted_free_tier: false, state: "CONFIGURED" });
    expect(byName["gemma_hosted"]).toMatchObject({ configured: true, locality: "cloud", hosted_free_tier: true });
    expect(byName["kimi"]).toMatchObject({ configured: false, state: "NOT_CONFIGURED" });
    expect(byName["kimi"]?.capabilities).toContain("tool_calling");
    expect(JSON.stringify(details)).not.toMatch(/api[_-]?key|secret|authorization|bearer|password/i);
  });

  it("tilstanden følger faktiske kall: LIVE etter suksess, feilklasse og kode etter feil (kun adapterkoden)", async () => {
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter("gemma_local"), adapter("kimi", { fail: "auth" })] });
    await gateway.complete({ ...base, providerPreference: ["gemma_local"] });
    await expect(gateway.complete({ ...base, providerPreference: ["kimi"] })).rejects.toBeInstanceOf(ProviderError);
    const byName = Object.fromEntries(gateway.meshDetails().map((d) => [d.provider, d]));
    expect(byName["gemma_local"]).toMatchObject({ state: "LIVE", success: 1, failures: 0 });
    expect(byName["kimi"]).toMatchObject({ failures: 1, last_error: "kimi_auth", last_error_kind: "auth" });
    expect(byName["kimi"]?.state).not.toBe("LIVE");
  });

  it("er konsistent med meshStatus() (samme tilstand og tellere)", async () => {
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter("gemma_local"), adapter("anthropic", { fail: "server" })] });
    await gateway.complete({ ...base, providerPreference: ["gemma_local"] });
    await expect(gateway.complete({ ...base, providerPreference: ["anthropic"] })).rejects.toBeInstanceOf(ProviderError);
    const status = gateway.meshStatus();
    for (const d of gateway.meshDetails()) {
      const s = status.providers.find((p) => p.provider === d.provider);
      expect(s, d.provider).toMatchObject({ state: d.state, success: d.success, failures: d.failures });
    }
  });
});

describe("ModelGateway.meshDetails: eierens pause (WP-H0)", () => {
  it("en pauset leverandør står som ikke brukbar (configured:false, paused:true) men helsen er den faktiske; pausen oppheves uten omstart", async () => {
    const paused = new Set<string>();
    const gateway = new ModelGateway({
      pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter("gemma_local"), adapter("kimi")],
      providerPause: { pausedProviders: async () => new Set(paused) }
    });
    await gateway.complete({ ...base, providerPreference: ["kimi"] });
    paused.add("kimi");
    await gateway.complete({ ...base, providerPreference: ["gemma_local"] }); // hvert kall leser pausen på nytt
    const pausedView = Object.fromEntries(gateway.meshDetails().map((d) => [d.provider, d]));
    expect(pausedView["kimi"]).toMatchObject({ configured: false, paused: true, state: "LIVE", success: 1 });
    expect(pausedView["gemma_local"]).toMatchObject({ configured: true });
    expect(pausedView["gemma_local"]).not.toHaveProperty("paused");
    paused.clear();
    await gateway.complete({ ...base, providerPreference: ["gemma_local"] });
    const resumed = gateway.meshDetails().find((d) => d.provider === "kimi");
    expect(resumed).toMatchObject({ configured: true, state: "LIVE" });
    expect(resumed).not.toHaveProperty("paused");
  });
});

describe("ModelGateway: parallell vs. enkeltkall i latensmålingen", () => {
  it("to kall som overlapper: det første er alene, det andre startet mens et annet pågikk", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter("kimi", { gate, onStart: () => { started += 1; } })] });
    const a = gateway.complete({ ...base, providerPreference: ["kimi"] });
    const b = gateway.complete({ ...base, providerPreference: ["kimi"] });
    // Vent til begge kallene faktisk er inne i adapteren, så slipp dem.
    for (let i = 0; i < 200 && started < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(started).toBe(2);
    release();
    await Promise.all([a, b]);
    const d = gateway.meshDetails().find((x) => x.provider === "kimi");
    expect(d).toMatchObject({ solo_samples: 1, parallel_samples: 1, success: 2 });
  });

  it("sekvensielle kall er alltid alene - også etter en feil (telleren lekker ikke)", async () => {
    const failing = adapter("kimi", { fail: "server" });
    const ok = adapter("hermes");
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [failing, ok] });
    await expect(gateway.complete({ ...base, providerPreference: ["kimi"] })).rejects.toBeInstanceOf(ProviderError); // 2 forsøk (1 retry), begge feiler
    await gateway.complete({ ...base, providerPreference: ["hermes"] });
    await gateway.complete({ ...base, providerPreference: ["hermes"] });
    const d = gateway.meshDetails().find((x) => x.provider === "hermes");
    expect(d).toMatchObject({ solo_samples: 2, parallel_samples: 0 });
  });

  it("et kall som kaster midt i et overlapp frigjør plassen sin (neste kall regnes ikke som parallelt)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    const slowFail: ModelProviderAdapter = {
      name: "kimi", model: "kimi-model", available: () => true,
      complete: async () => { started += 1; await gate; throw new ProviderError("kimi", "auth", "kimi_auth"); }
    };
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [slowFail, adapter("hermes")] });
    const failing = gateway.complete({ ...base, providerPreference: ["kimi"] });
    for (let i = 0; i < 200 && started < 1; i += 1) await new Promise((r) => setTimeout(r, 5));
    release();
    await expect(failing).rejects.toBeInstanceOf(ProviderError);
    await gateway.complete({ ...base, providerPreference: ["hermes"] });
    expect(gateway.meshDetails().find((x) => x.provider === "hermes")).toMatchObject({ solo_samples: 1, parallel_samples: 0 });
  });

  it("det adaptive retry-forsøket (avkortet første svar) arver overlappet fra kallet - begge målingene er parallelle", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    let kimiCalls = 0;
    const truncatedThenOk: ModelProviderAdapter = {
      name: "kimi", model: "kimi-model", available: () => true,
      complete: async () => {
        kimiCalls += 1;
        return kimiCalls === 1 ? { ...result("kimi"), text: "", finish_reason: "length" } : result("kimi");
      }
    };
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter("hermes", { gate, onStart: () => { started += 1; } }), truncatedThenOk] });
    const first = gateway.complete({ ...base, providerPreference: ["hermes"] }); // pågår mens kimi-kallet starter
    for (let i = 0; i < 200 && started < 1; i += 1) await new Promise((r) => setTimeout(r, 5));
    const second = await gateway.complete({ ...base, providerPreference: ["kimi"] });
    release();
    await first;
    expect(second.metadata?.["adaptive_retry"]).toMatchObject({ triggered: true });
    expect(gateway.meshDetails().find((x) => x.provider === "kimi")).toMatchObject({ success: 2, parallel_samples: 2, solo_samples: 0 });
  });

  it("påvirker ikke ruting eller resultat: samme leverandør svarer med og uten overlapp", async () => {
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter("gemma_local")] });
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => gateway.complete({ ...base, providerPreference: ["gemma_local"] })));
    expect([a?.provider, b?.provider, c?.provider]).toEqual(["gemma_local", "gemma_local", "gemma_local"]);
  });
});

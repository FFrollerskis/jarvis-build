import { describe, expect, it } from "vitest";
import type pg from "pg";
import { ProviderError, type ModelProviderAdapter, type ModelRequest, type ModelResult, type StreamEvent, type ToolCallRequest, type ToolResultMessage } from "@jarvis/provider-adapters";
import type { DataSensitivity } from "@jarvis/contracts";
import { AiRouter, CapabilityRegistry, MemoryTraceSink, ModelGateway, NoEligibleProviderError, ProviderHealthTracker, type AttemptFailure, type ToolExecutor } from "../src/index.ts";

/**
 * JARVIS-033 (WP-D4): standardstien kan ha FLERE kandidater (`preferenceFailover`). Beviser at kjeden er en HARD liste der hver port gjelder per medlem (SECRET_RESTRICTED er alltid lokal,
 * `paid_models_allowed=false` respekteres, `mode: LOCAL` gjelder), at failover aldri åpner noe et enkeltvalg ville stengt, og at reservebruk er synlig (`onAttemptFailed`).
 */
const MODELS: Record<string, string> = {
  gemma_local: "gemma-local", local_llm: "local-model", ollama: "llama3.1", gemma_hosted: "gemma-4-26b-a4b-it", anthropic: "claude-sonnet-5-5", openai: "gpt-5", gemini: "gemini-3.6-flash", kimi: "kimi-k3", hermes: "Hermes-4-70B"
};
const LOCAL = new Set(["gemma_local", "local_llm", "ollama"]);
const ALL_NAMES = Object.keys(MODELS);

function runtimes(configured: string[]): Map<string, { configured: boolean; model: string }> {
  return new Map(ALL_NAMES.map((n) => [n, { configured: configured.includes(n), model: MODELS[n] as string }]));
}
function router(): { router: AiRouter; health: ProviderHealthTracker } {
  const health = new ProviderHealthTracker();
  return { router: new AiRouter(new CapabilityRegistry(), health), health };
}

describe("router: preferenceFailover", () => {
  const CHAIN = ["gemma_local", "local_llm", "gemma_hosted", "anthropic"];
  const ALL = ALL_NAMES;

  it("uten flagget er planen UENDRET: ÉN kandidat (første kvalifiserte)", () => {
    const plan = router().router.plan({ providerPreference: CHAIN, sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" }, runtimes(ALL));
    expect(plan.candidates).toEqual([{ provider: "gemma_local", model: "gemma-local" }]);
    expect(plan.reason).toBe("PROVIDER_PREFERENCE");
  });

  it("med flagget returneres ALLE kvalifiserte medlemmer i listerekkefølge, og kun de i listen", () => {
    const plan = router().router.plan({ providerPreference: CHAIN, preferenceFailover: true, sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" }, runtimes(ALL));
    expect(plan.candidates.map((c) => c.provider)).toEqual(["gemma_local", "local_llm", "gemma_hosted", "anthropic"]);
    expect(plan.reason).toBe("PROVIDER_PREFERENCE");
    expect(plan.candidates.map((c) => c.provider)).not.toContain("openai"); // konfigurert og kvalifisert, men ikke i listen
  });

  it("ikke-konfigurerte medlemmer hoppes over, duplikater gir ett forsøk, og rekkefølgen er listens (ikke score)", () => {
    const plan = router().router.plan({ providerPreference: ["anthropic", "gemma_local", "anthropic", "gemma_local"], preferenceFailover: true, sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" }, runtimes(["gemma_local", "anthropic"]));
    expect(plan.candidates.map((c) => c.provider)).toEqual(["anthropic", "gemma_local"]);
  });

  it("SECRET_RESTRICTED: kun lokale medlemmer - ALDRI sky, uansett hva kjeden inneholder", () => {
    const plan = router().router.plan({ providerPreference: [...CHAIN, "openai"], preferenceFailover: true, sensitivity: "SECRET_RESTRICTED" }, runtimes(ALL));
    expect(plan.candidates.map((c) => c.provider)).toEqual(["gemma_local", "local_llm"]);
    expect(() => router().router.plan({ providerPreference: ["gemma_hosted", "anthropic", "openai"], preferenceFailover: true, sensitivity: "SECRET_RESTRICTED" }, runtimes(ALL))).toThrow(NoEligibleProviderError);
  });

  it("PRIVATE: gratis delt sky (gemma_hosted) utelukkes, lokale og betrodd betalt sky beholdes (D-23 uendret)", () => {
    const plan = router().router.plan({ providerPreference: CHAIN, preferenceFailover: true, sensitivity: "PRIVATE" }, runtimes(ALL));
    expect(plan.candidates.map((c) => c.provider)).toEqual(["gemma_local", "local_llm", "anthropic"]);
  });

  it("udefinert sensitivitet utelukker gemma_hosted (D-81 fail-safe) også i en kjede", () => {
    const plan = router().router.plan({ providerPreference: CHAIN, preferenceFailover: true }, runtimes(ALL));
    expect(plan.candidates.map((c) => c.provider)).not.toContain("gemma_hosted");
  });

  it("paid_models_allowed=false: kun lokale medlemmer (gemma_hosted er sky selv om den er gratis)", () => {
    const plan = router().router.plan({ providerPreference: CHAIN, preferenceFailover: true, sensitivity: "PUBLIC_OR_LOW_SENSITIVITY", paid_models_allowed: false }, runtimes(ALL));
    expect(plan.candidates.map((c) => c.provider)).toEqual(["gemma_local", "local_llm"]);
  });

  it("mode LOCAL gjelder nå også i preferansegrenen (tidligere ignorert), med og uten failover", () => {
    for (const preferenceFailover of [false, true]) {
      const plan = router().router.plan({ mode: "LOCAL", providerPreference: ["anthropic", "gemma_local", "openai"], preferenceFailover, sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" }, runtimes(ALL));
      expect(plan.candidates.map((c) => c.provider)).toEqual(["gemma_local"]);
    }
    expect(() => router().router.plan({ mode: "LOCAL", providerPreference: ["anthropic", "openai"], preferenceFailover: true }, runtimes(ALL))).toThrow(/not_local/);
  });

  it("påkrevde capabilities filtrerer medlemmer (ollama mangler streaming og tool_calling)", () => {
    const plan = router().router.plan({ providerPreference: ["ollama", "gemma_local"], preferenceFailover: true, required_capabilities: ["streaming", "tool_calling"] }, runtimes(ALL));
    expect(plan.candidates.map((c) => c.provider)).toEqual(["gemma_local"]);
  });

  it("helse: et UNAVAILABLE medlem (pause) er ikke kandidat; de andre er det", () => {
    const { router: r, health } = router();
    for (let i = 0; i < 3; i += 1) health.recordFailure("gemma_local", "server", "nede");
    const plan = r.plan({ providerPreference: CHAIN, preferenceFailover: true, sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" }, runtimes(ALL));
    expect(plan.candidates.map((c) => c.provider)).toEqual(["local_llm", "gemma_hosted", "anthropic"]);
  });

  it("ingen kvalifiserte medlemmer gir samme provider_preference_exhausted-feil med port per leverandør", () => {
    const err = (() => { try { router().router.plan({ providerPreference: ["gemma_local", "anthropic"], preferenceFailover: true, sensitivity: "SECRET_RESTRICTED" }, runtimes(["anthropic"])); } catch (e) { return e as Error; } return null; })();
    expect(err).toBeInstanceOf(NoEligibleProviderError);
    expect(err?.message).toContain("provider_preference_exhausted");
    expect(err?.message).toContain("gemma_local:not_configured");
    expect(err?.message).toContain("anthropic:sensitivity=SECRET_RESTRICTED");
  });
});

describe("router: failover kan aldri åpne noe et enkeltvalg ville stengt (differensialtest)", () => {
  const SENSITIVITIES: Array<DataSensitivity | undefined> = [undefined, "PUBLIC_OR_LOW_SENSITIVITY", "PRIVATE", "BUSINESS_CONFIDENTIAL", "SECRET_RESTRICTED"];
  const CONFIGS = [ALL_NAMES, ["gemma_local"], ["gemma_local", "gemma_hosted", "anthropic"], ["anthropic", "openai", "gemma_hosted"], ["local_llm", "ollama", "kimi"], []];
  const CHAINS = [
    ["gemma_local", "gemma_hosted"], ["gemma_local", "local_llm", "gemma_hosted", "anthropic"], ["anthropic", "gemma_local"], ["gemma_hosted"], ["openai", "anthropic", "gemini"],
    ["gemma_local", "local_llm", "ollama", "hermes", "kimi"], ["kimi", "hermes"]
  ];
  const MODES = [undefined, "LOCAL", "FAST"] as const;
  const CAPS: Array<Array<"streaming" | "tool_calling"> | undefined> = [undefined, ["streaming"], ["tool_calling"], ["streaming", "tool_calling"]];

  it("for alle kombinasjoner av sensitivitet × betalingspolicy × konfigurasjon × kjede × mode × capabilities", () => {
    let evaluated = 0;
    for (const sensitivity of SENSITIVITIES) for (const paid of [undefined, true, false]) for (const configured of CONFIGS) for (const chain of CHAINS) for (const mode of MODES) for (const caps of CAPS) {
      const base = { providerPreference: chain, ...(sensitivity ? { sensitivity } : {}), ...(paid !== undefined ? { paid_models_allowed: paid } : {}), ...(mode ? { mode } : {}), ...(caps ? { required_capabilities: caps } : {}) };
      const single = (() => { try { return router().router.plan(base, runtimes(configured)); } catch { return null; } })();
      const failover = (() => { try { return router().router.plan({ ...base, preferenceFailover: true }, runtimes(configured)); } catch { return null; } })();
      evaluated += 1;
      const label = JSON.stringify({ base, configured });
      // (f) feiler enkeltvalget, feiler failover også - og omvendt (de har samme kvalifikasjonsmengde).
      expect(failover === null, label).toBe(single === null);
      if (!failover || !single) continue;
      const names = failover.candidates.map((c) => c.provider);
      // (e) failover endrer ikke hvem som går først.
      expect(names[0], label).toBe(single.candidates[0]?.provider);
      // (a) kun medlemmer av kjeden, ingen duplikater, i listerekkefølge.
      expect(names.every((n) => chain.includes(n)), label).toBe(true);
      expect(new Set(names).size, label).toBe(names.length);
      expect(names, label).toEqual(chain.filter((n, i) => chain.indexOf(n) === i && names.includes(n)));
      // (b) SECRET_RESTRICTED, (c) paid_models_allowed=false og (d) mode LOCAL: kun lokale.
      if (sensitivity === "SECRET_RESTRICTED" || paid === false || mode === "LOCAL") expect(names.every((n) => LOCAL.has(n)), label).toBe(true);
      // (g) gratis delt sky kun ved eksplisitt PUBLIC_OR_LOW_SENSITIVITY.
      if (names.includes("gemma_hosted")) expect(sensitivity, label).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    }
    expect(evaluated).toBe(SENSITIVITIES.length * 3 * CONFIGS.length * CHAINS.length * MODES.length * CAPS.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Gateway: ekte ModelGateway med fake adaptere
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
interface Pool { pool: pg.Pool; inserts: unknown[][] }
function fakePool(): Pool {
  const inserts: unknown[][] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && sql.includes("FROM cost_events")) return { rows: [{ spent: 0 }] };
      if (typeof sql === "string" && sql.includes("INSERT INTO cost_events")) inserts.push(params ?? []);
      return { rows: [] };
    },
    release: () => undefined
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, inserts };
}

const REQUEST: ModelRequest = { messages: [{ role: "user", content: "hei" }] };
const ok = (provider: string, text = `svar fra ${provider}`): ModelResult => ({ text, usage: { input_tokens: 5, output_tokens: 5 }, provider, model: MODELS[provider] ?? "m", finish_reason: "stop" });

function adapter(name: string, behaviour: "ok" | ProviderError["kind"] = "ok", calls: string[] = []): ModelProviderAdapter {
  return {
    name, model: MODELS[name] ?? "m", available: () => true,
    complete: async () => {
      calls.push(name);
      if (behaviour !== "ok") throw new ProviderError(name, behaviour, `${name}_${behaviour}`);
      return ok(name);
    },
    stream: async (_req, onEvent) => {
      calls.push(name);
      if (behaviour !== "ok") throw new ProviderError(name, behaviour, `${name}_${behaviour}`);
      onEvent({ type: "start", provider: name, model: MODELS[name] ?? "m", generation_id: "g" });
      onEvent({ type: "text_delta", text: `svar fra ${name}` });
      onEvent({ type: "usage", usage: { input_tokens: 5, output_tokens: 5 } });
      onEvent({ type: "finish", finish_reason: "stop" });
      return ok(name);
    }
  };
}

const base = { tenant_id: "t1", purpose: "CHAT" as const, sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" as const, request: REQUEST };

describe("gateway: kandidatkjede med failover", () => {
  it("primær feiler (server): gatewayen går til neste medlem; resultatet og onAttemptFailed viser reservebruken", async () => {
    const { pool, inserts } = fakePool();
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter("gemma_local", "server", calls), adapter("local_llm", "ok", calls), adapter("anthropic", "ok", calls)] });
    const failures: AttemptFailure[] = [];
    const result = await gateway.complete({ ...base, providerPreference: ["gemma_local", "local_llm", "anthropic"], preferenceFailover: true, onAttemptFailed: (f) => failures.push(f) });
    expect(result.provider).toBe("local_llm");
    expect(calls).toEqual(["gemma_local", "gemma_local", "local_llm"]); // server er transient: ÉN retry på samme leverandør, deretter neste medlem
    expect((result.metadata?.["router"] as { fallback_from?: string[] }).fallback_from).toEqual(["gemma_local"]);
    expect(failures).toEqual([{ provider: "gemma_local", kind: "server" }, { provider: "gemma_local", kind: "server" }]);
    // Kost-/helsespor: fallback-flagget er satt på den vellykkede raden, og gemma_local har fått feilene sine.
    expect(inserts.find((p) => p[3] === "model:local_llm")?.[11]).toBe(true);
    expect(gateway.health.state("gemma_local", true)).toBe("DEGRADED");
    expect(gateway.meshStatus().fallback).toBe("VERIFIED");
  });

  it("uten failover-flagget er oppførselen uendret: primæren feiler → feilen kastes, reserven prøves ikke", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool().pool, trace: new MemoryTraceSink(), providers: [adapter("gemma_local", "server", calls), adapter("local_llm", "ok", calls)] });
    await expect(gateway.complete({ ...base, providerPreference: ["gemma_local", "local_llm"] })).rejects.toMatchObject({ kind: "server", provider: "gemma_local" });
    expect(calls).not.toContain("local_llm");
  });

  it("SECRET_RESTRICTED: feiler den lokale primæren, prøves ALDRI en skyleverandør - feilen kastes ærlig", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({
      pool: fakePool().pool, trace: new MemoryTraceSink(),
      providers: [adapter("gemma_local", "network", calls), adapter("gemma_hosted", "ok", calls), adapter("anthropic", "ok", calls), adapter("openai", "ok", calls)]
    });
    const secret = { ...base, sensitivity: "SECRET_RESTRICTED" as const, providerPreference: ["gemma_local", "gemma_hosted", "anthropic", "openai"], preferenceFailover: true };
    await expect(gateway.complete(secret)).rejects.toMatchObject({ provider: "gemma_local" });
    await expect(gateway.stream(secret, () => undefined)).rejects.toMatchObject({ provider: "gemma_local" });
    expect(calls.filter((c) => c !== "gemma_local")).toEqual([]);
  });

  it("paid_models_allowed=false: betalte/sky-medlemmer prøves aldri, heller ikke som reserve", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool().pool, trace: new MemoryTraceSink(), providers: [adapter("gemma_local", "timeout", calls), adapter("gemma_hosted", "ok", calls), adapter("anthropic", "ok", calls)] });
    await expect(gateway.complete({ ...base, paid_models_allowed: false, providerPreference: ["gemma_local", "gemma_hosted", "anthropic"], preferenceFailover: true })).rejects.toMatchObject({ provider: "gemma_local" });
    expect(calls.every((c) => c === "gemma_local")).toBe(true);
  });

  it("streaming: primæren feiler FØR output → `fallback`-event og reserven strømmer; etter output byttes det aldri stille", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool().pool, trace: new MemoryTraceSink(), providers: [adapter("gemma_local", "network", calls), adapter("local_llm", "ok", calls)] });
    const events: StreamEvent[] = [];
    const result = await gateway.stream({ ...base, providerPreference: ["gemma_local", "local_llm"], preferenceFailover: true }, (e) => events.push(e));
    expect(result.provider).toBe("local_llm");
    expect(events.find((e) => e.type === "fallback")).toMatchObject({ from: "gemma_local", to: "local_llm", reason: "network" });

    // Etter synlig output: stream_interrupted, ingen provider-bytte (§11).
    const partial: ModelProviderAdapter = {
      name: "gemma_local", model: "gemma-local", available: () => true, complete: async () => ok("gemma_local"),
      stream: async (_r, onEvent) => { onEvent({ type: "text_delta", text: "halv" }); throw new ProviderError("gemma_local", "network", "brutt"); }
    };
    const gw2 = new ModelGateway({ pool: fakePool().pool, trace: new MemoryTraceSink(), providers: [partial, adapter("local_llm", "ok", calls)] });
    calls.length = 0;
    await expect(gw2.stream({ ...base, providerPreference: ["gemma_local", "local_llm"], preferenceFailover: true }, () => undefined)).rejects.toMatchObject({ kind: "stream_interrupted" });
    expect(calls).toEqual([]);
  });

  it("onAttemptFailed: ingen feil ved en frisk primær; en lytter som kaster påvirker aldri kallet; criticen og brukeravbrudd rapporteres ikke", async () => {
    const healthy = new ModelGateway({ pool: fakePool().pool, trace: new MemoryTraceSink(), providers: [adapter("gemma_local"), adapter("local_llm")] });
    const failures: AttemptFailure[] = [];
    await healthy.complete({ ...base, providerPreference: ["gemma_local", "local_llm"], preferenceFailover: true, onAttemptFailed: (f) => failures.push(f) });
    expect(failures).toEqual([]);

    // En lytter som kaster er konsumentens feil: kallet lykkes på reserven og feilen logges bare.
    const failing = new ModelGateway({ pool: fakePool().pool, trace: new MemoryTraceSink(), providers: [adapter("gemma_local", "network"), adapter("local_llm")] });
    const out = await failing.complete({ ...base, providerPreference: ["gemma_local", "local_llm"], preferenceFailover: true, onAttemptFailed: () => { throw new Error("lytteren feilet"); } });
    expect(out.provider).toBe("local_llm");

    // Criticen (opt-in) er en EGEN modellkjøring: feiler den, er det ikke chattens reservebruk og rapporteres ikke - og primærsvaret velter ikke.
    const withCritic = new ModelGateway({ pool: fakePool().pool, trace: new MemoryTraceSink(), providers: [adapter("gemma_local"), adapter("anthropic", "server")] });
    const criticFailures: AttemptFailure[] = [];
    const answered = await withCritic.complete({ ...base, purpose: "PLAN", critic: true, providerPreference: ["gemma_local"], onAttemptFailed: (f) => criticFailures.push(f) });
    expect(answered.provider).toBe("gemma_local");
    expect(answered.metadata?.["critic_error"]).toBeTruthy(); // criticen kjørte (og feilet) - men uten å bli rapportert
    expect(criticFailures).toEqual([]);

    // Brukeravbrudd (cancelled) er ingen leverandørfeil.
    const cancelling: ModelProviderAdapter = { name: "gemma_local", model: "gemma-local", available: () => true, complete: async () => ok("gemma_local"), stream: async () => { throw new ProviderError("gemma_local", "cancelled", "gemma_local_cancelled"); } };
    const gw = new ModelGateway({ pool: fakePool().pool, trace: new MemoryTraceSink(), providers: [cancelling] });
    const cancelFailures: AttemptFailure[] = [];
    await expect(gw.stream({ ...base, providerPreference: ["gemma_local"], onAttemptFailed: (f) => cancelFailures.push(f) }, () => undefined)).rejects.toMatchObject({ kind: "cancelled" });
    expect(cancelFailures).toEqual([]);
  });

  it("verktøyløkke med failover: en lokal runde låser resten av løkken lokalt (localStickiness) - skyen i kjeden får aldri se verktøykall eller -resultater", async () => {
    const seen: { cloud: ModelRequest[] } = { cloud: [] };
    const memoryCall = (provider: string): ToolCallRequest => ({ tool_call_id: "c1", tool_name: "search_my_memory", arguments: {}, provider, model: "m" });
    let localRound = 0;
    const local: ModelProviderAdapter = {
      name: "gemma_local", model: "gemma-local", available: () => true,
      complete: async (req) => {
        localRound += 1;
        if (req.tool_exchanges === undefined) return { ...ok("gemma_local"), text: "", finish_reason: "tool_calls", tool_calls: [memoryCall("gemma_local")] };
        throw new ProviderError("gemma_local", "server", "lokal modell døde i runde 2");
      }
    };
    const cloud: ModelProviderAdapter = { name: "anthropic", model: "claude", available: () => true, complete: async (req) => { seen.cloud.push(req); return ok("anthropic"); } };
    const gateway = new ModelGateway({ pool: fakePool().pool, trace: new MemoryTraceSink(), providers: [local, cloud] });
    const executor: ToolExecutor = {
      execute: async (call): Promise<ToolResultMessage> => ({ tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "e1", success: true, at: new Date().toISOString(), output: [{ content: "SPECIAL-HEMMELIG psykiater", sensitivity: "special" }] })
    };
    const tools = [{ name: "search_my_memory", description: "Søk", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } }];
    await expect(
      gateway.completeWithTools({ ...base, providerPreference: ["gemma_local", "anthropic"], preferenceFailover: true }, { tools, executor, localStickiness: true })
    ).rejects.toMatchObject({ provider: "gemma_local" });
    expect(localRound).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(seen.cloud)).not.toContain("SPECIAL-HEMMELIG");
    expect(seen.cloud.every((r) => r.tool_exchanges === undefined)).toBe(true);
  });
});

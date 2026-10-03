import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  ProviderError,
  ScriptedAdapter,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult
} from "@jarvis/provider-adapters";
import {
  AiRouter,
  CapabilityRegistry,
  costOre,
  DEFAULT_PRICING,
  LocalModelUnavailableError,
  MemoryTraceSink,
  ModelGateway,
  NoEligibleProviderError,
  ProviderHealthTracker,
  rateFor
} from "../src/index.ts";

/** Fake pg.Pool: budsjett-SELECT gir 0; alle cost_events-INSERTs fanges for assertions. */
function fakePool(): { pool: pg.Pool; costInserts: unknown[][] } {
  const costInserts: unknown[][] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && sql.includes("FROM cost_events")) {
        return { rows: [{ spent: 0 }] };
      }
      if (typeof sql === "string" && sql.includes("INSERT INTO cost_events")) {
        costInserts.push(params ?? []);
      }
      return { rows: [] };
    },
    release: () => undefined
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, costInserts };
}

function providers(configured: Record<string, boolean>): Map<string, { configured: boolean; model: string }> {
  const models: Record<string, string> = {
    openai: "gpt-5",
    anthropic: "claude-sonnet-5",
    gemini: "gemini-2.5-flash",
    kimi: "kimi-latest",
    ollama: "llama3.1"
  };
  return new Map(Object.entries(configured).map(([name, c]) => [name, { configured: c, model: models[name] ?? "m" }]));
}

const ALL = { openai: true, anthropic: true, gemini: true, kimi: true, ollama: true };

function newRouter(): { router: AiRouter; registry: CapabilityRegistry; health: ProviderHealthTracker } {
  const registry = new CapabilityRegistry();
  const health = new ProviderHealthTracker();
  return { router: new AiRouter(registry, health), registry, health };
}

describe("UA-1 capability registry (§7)", () => {
  it("har profiler for alle P0-providere", () => {
    const registry = new CapabilityRegistry();
    for (const p of ["openai", "anthropic", "gemini", "kimi", "ollama"]) {
      expect(registry.get(p), p).toBeDefined();
    }
  });

  it("ukjent provider får generisk tekstprofil (bakoverkompatibelt)", () => {
    const profile = new CapabilityRegistry().profileOrGeneric("nyprovider", "m1");
    expect(profile.capabilities).toContain("text");
    expect(profile.model).toBe("m1");
  });

  it("D-43 §3: 'vision' står KUN på anthropic - eneste adapter med ekte bilde-mapping denne runden (se capability-registry.ts sin begrunnelse)", () => {
    const registry = new CapabilityRegistry();
    expect(registry.get("anthropic")?.capabilities).toContain("vision");
    expect(registry.get("openai")?.capabilities).not.toContain("vision");
    expect(registry.get("gemini")?.capabilities).not.toContain("vision");
    expect(registry.get("kimi")?.capabilities).not.toContain("vision");
    expect(registry.get("ollama")?.capabilities).not.toContain("vision");
  });

  it("D-106 GEMINI MODEL MIGRATION: registry-metadata for gemini oppdatert til gemini-3.6-flash, provider-navn/capabilities UENDRET (routing er navnebasert, ikke modellstreng-basert)", () => {
    const registry = new CapabilityRegistry();
    const gemini = registry.get("gemini");
    expect(gemini?.provider).toBe("gemini");
    expect(gemini?.model).toBe("gemini-3.6-flash");
    expect(gemini?.capabilities).toEqual(["text", "reasoning", "structured_output"]);
  });
});

describe("UA-1 pricing (§14)", () => {
  it("mest spesifikke rate vinner (provider:model over provider)", () => {
    expect(rateFor(DEFAULT_PRICING, "openai", "gpt-4o-mini").output_per_1k_ore).toBeLessThan(
      rateFor(DEFAULT_PRICING, "openai", "gpt-5").output_per_1k_ore
    );
  });

  it("cached tokens prises rabattert", () => {
    const full = costOre(DEFAULT_PRICING, "anthropic", "claude-sonnet-5", { input_tokens: 10_000, output_tokens: 0 });
    const cached = costOre(DEFAULT_PRICING, "anthropic", "claude-sonnet-5", {
      input_tokens: 10_000,
      output_tokens: 0,
      cached_tokens: 10_000
    });
    expect(cached).toBeLessThan(full);
  });

  it("pricing-tabellen er versjonert med dato", () => {
    expect(DEFAULT_PRICING.version).toBeTruthy();
    expect(DEFAULT_PRICING.updated_at).toBeTruthy();
  });
});

describe("UA-1 provider health (§11)", () => {
  it("CONFIGURED før første kall, LIVE etter suksess - aldri LIVE bare fordi nøkkel finnes", () => {
    const h = new ProviderHealthTracker();
    expect(h.state("openai", true)).toBe("CONFIGURED");
    h.recordSuccess("openai", 500);
    expect(h.state("openai", true)).toBe("LIVE");
  });

  it("DEGRADED ved feil, UNAVAILABLE ved 3+ sammenhengende, restituerer ved suksess", () => {
    const h = new ProviderHealthTracker();
    h.recordSuccess("openai", 500);
    h.recordFailure("openai", "server", "500");
    expect(h.state("openai", true)).toBe("DEGRADED");
    h.recordFailure("openai", "server", "500");
    h.recordFailure("openai", "server", "500");
    expect(h.state("openai", true)).toBe("UNAVAILABLE");
    h.recordSuccess("openai", 400);
    expect(h.state("openai", true)).toBe("LIVE");
  });

  it("429 gir RATE_LIMITED med backoff", () => {
    const h = new ProviderHealthTracker();
    h.recordSuccess("gemini", 300);
    h.recordFailure("gemini", "rate_limit", "429");
    expect(h.state("gemini", true)).toBe("RATE_LIMITED");
  });

  it("NOT_CONFIGURED uten nøkkel", () => {
    expect(new ProviderHealthTracker().state("kimi", false)).toBe("NOT_CONFIGURED");
  });
});

describe("UA-1 router eval-harness (§27)", () => {
  it("simple chat (AUTO): velger konfigurert provider med gyldig reason", () => {
    const { router } = newRouter();
    const plan = router.plan({ purpose: "CHAT" }, providers(ALL));
    expect(plan.mode).toBe("AUTO");
    expect(plan.candidates.length).toBeGreaterThan(1);
  });

  it("summarization (AUTO): fungerer med subset av providere", () => {
    const { router } = newRouter();
    const plan = router.plan({ purpose: "SUMMARIZE" }, providers({ openai: true }));
    expect(plan.candidates[0]?.provider).toBe("openai");
    expect(plan.reason).toBe("ONLY_AVAILABLE");
  });

  it("coding: krever reasoning - ollama (uten reasoning) er aldri kandidat", () => {
    const { router } = newRouter();
    const plan = router.plan({ purpose: "CODE" }, providers(ALL));
    expect(plan.reason).toBe("REASONING_REQUIRED");
    expect(plan.candidates.map((c) => c.provider)).not.toContain("ollama");
  });

  it("deep reasoning (QUALITY): topp-kandidat har quality_class 5", () => {
    const { router, registry } = newRouter();
    const plan = router.plan({ purpose: "REASON", mode: "QUALITY" }, providers(ALL));
    const top = registry.get(plan.candidates[0]?.provider as string);
    expect(top?.quality_class).toBe(5);
  });

  it("structured extraction: alle kandidater har structured_output", () => {
    const { router, registry } = newRouter();
    const plan = router.plan({ purpose: "EXTRACT", needs_structured: true }, providers(ALL));
    expect(plan.reason).toBe("STRUCTURED_REQUIRED");
    for (const c of plan.candidates) {
      expect(registry.get(c.provider)?.capabilities).toContain("structured_output");
    }
  });

  it("vision-required: kun vision-providere, reason VISION_REQUIRED", () => {
    const { router, registry } = newRouter();
    const plan = router.plan({ purpose: "VISION" }, providers(ALL));
    expect(plan.reason).toBe("VISION_REQUIRED");
    for (const c of plan.candidates) {
      expect(registry.get(c.provider)?.capabilities).toContain("vision");
    }
  });

  it("cheap/background classification: reason LOW_COST og billig topp-kandidat", () => {
    const { router, registry } = newRouter();
    const plan = router.plan({ purpose: "QUICK_CLASSIFICATION" }, providers(ALL));
    expect(plan.reason).toBe("LOW_COST");
    expect(registry.get(plan.candidates[0]?.provider as string)?.cost_class).toBeLessThanOrEqual(2);
  });

  it("FAST-mode: reason LOW_LATENCY og fast topp-kandidat", () => {
    const { router, registry } = newRouter();
    const plan = router.plan({ purpose: "CHAT", mode: "FAST" }, providers(ALL));
    expect(plan.reason).toBe("LOW_LATENCY");
    expect(registry.get(plan.candidates[0]?.provider as string)?.latency_class).toBe("fast");
  });

  it("local-required: kun lokal modell; tydelig feil uten lokal - aldri sky bak ryggen (§26)", () => {
    const { router } = newRouter();
    const plan = router.plan({ purpose: "CHAT", mode: "LOCAL" }, providers(ALL));
    expect(plan.candidates.every((c) => c.provider === "ollama")).toBe(true);
    expect(plan.reason).toBe("LOCAL_REQUIRED");
    expect(() => router.plan({ purpose: "CHAT", mode: "LOCAL" }, providers({ openai: true }))).toThrow(
      LocalModelUnavailableError
    );
  });

  it("owner override (§10): eksakt provider, ingen stille fallback", () => {
    const { router } = newRouter();
    const plan = router.plan({ provider: "kimi" }, providers(ALL));
    expect(plan.mode).toBe("SPECIFIC_PROVIDER");
    expect(plan.reason).toBe("OWNER_OVERRIDE");
    expect(plan.candidates).toEqual([{ provider: "kimi", model: "kimi-latest" }]);
    expect(() => router.plan({ provider: "gemini" }, providers({ openai: true, gemini: false }))).toThrow(
      NoEligibleProviderError
    );
  });

  it("provider unhealthy: UNAVAILABLE ekskluderes, reason PRIMARY_UNHEALTHY", () => {
    const { router, health } = newRouter();
    const ideal = router.plan({ purpose: "REASON", mode: "QUALITY" }, providers(ALL)).candidates[0]?.provider as string;
    health.recordFailure(ideal, "server", "500");
    health.recordFailure(ideal, "server", "500");
    health.recordFailure(ideal, "server", "500");
    const plan = router.plan({ purpose: "REASON", mode: "QUALITY" }, providers(ALL));
    expect(plan.candidates.map((c) => c.provider)).not.toContain(ideal);
    expect(plan.reason).toBe("PRIMARY_UNHEALTHY");
  });

  it("provider rate-limited: flyttes bakerst, reason RATE_LIMIT_FALLBACK", () => {
    const { router, health } = newRouter();
    const ideal = router.plan({ purpose: "CHAT" }, providers(ALL)).candidates[0]?.provider as string;
    health.recordSuccess(ideal, 300);
    health.recordFailure(ideal, "rate_limit", "429");
    const plan = router.plan({ purpose: "CHAT" }, providers(ALL));
    expect(plan.candidates[0]?.provider).not.toBe(ideal);
    expect(plan.candidates.at(-1)?.provider).toBe(ideal);
    expect(plan.reason).toBe("RATE_LIMIT_FALLBACK");
  });

  it("critic requested: mode CRITIC gir reason CRITIC_REQUIRED", () => {
    const { router } = newRouter();
    const plan = router.plan({ purpose: "PLAN", mode: "CRITIC" }, providers(ALL));
    expect(plan.reason).toBe("CRITIC_REQUIRED");
  });
});

/** Adapter som feiler med gitt ProviderError-kind et antall ganger. */
class ErrorAdapter implements ModelProviderAdapter {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly kind: "auth" | "rate_limit" | "timeout" | "server" | "invalid_response",
    readonly model: string = "err-model"
  ) {}
  available(): boolean {
    return true;
  }
  async complete(): Promise<ModelResult> {
    this.calls += 1;
    throw new ProviderError(this.name, this.kind, `${this.name}_${this.kind}`);
  }
}

const REQUEST: ModelRequest = { messages: [{ role: "user", content: "test" }] };

describe("UA-1 gateway fallback + cost + critic (§12-§19)", () => {
  it("auth-feil: ingen retry-spam på samme provider, deterministisk fallback, kost sporer fallback", async () => {
    const { pool, costInserts } = fakePool();
    const failing = new ErrorAdapter("openai", "auth");
    const scripted = new ScriptedAdapter(() => "fallback-svar");
    const trace = new MemoryTraceSink();
    const gateway = new ModelGateway({ pool, trace, providers: [failing, scripted] });
    const result = await gateway.complete({ tenant_id: "tenant-a", purpose: "CHAT", request: REQUEST });
    expect(result.provider).toBe("scripted");
    expect(failing.calls).toBe(1); // auth → aldri retry mot samme provider
    const success = costInserts.find((p) => p[3] === "model:scripted");
    expect(success?.[11]).toBe(true); // fallback-flagget
    const failed = costInserts.find((p) => String(p[3]).startsWith("model:failed:auth"));
    expect(failed).toBeDefined();
    expect(failed?.[4]).toBe("openai"); // provider merket på feilforsøket
  });

  it("timeout: én retry på samme provider, deretter fallback", async () => {
    const { pool } = fakePool();
    const failing = new ErrorAdapter("openai", "timeout");
    const scripted = new ScriptedAdapter(() => "ok");
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [failing, scripted] });
    const result = await gateway.complete({ tenant_id: "tenant-a", request: REQUEST });
    expect(result.provider).toBe("scripted");
    expect(failing.calls).toBe(2); // transient → nøyaktig én retry
  });

  it("trace inneholder router-metadata (mode/reason/purpose/fallback) - aldri nøkler", async () => {
    const { pool } = fakePool();
    const trace = new MemoryTraceSink();
    const gateway = new ModelGateway({
      pool,
      trace,
      providers: [new ErrorAdapter("openai", "server"), new ScriptedAdapter(() => "x")]
    });
    await gateway.complete({ tenant_id: "tenant-a", purpose: "SUMMARIZE", request: REQUEST });
    const call = trace.spans.find((r) => r.kind === "model_call");
    const meta = call?.metadata as Record<string, unknown>;
    expect(meta["router_mode"]).toBe("AUTO");
    expect(meta["routing_reason"]).toBeTruthy();
    expect(meta["purpose"]).toBe("SUMMARIZE");
    expect(meta["fallback_from"]).toEqual(["openai"]);
    expect(JSON.stringify(trace.spans)).not.toMatch(/api[_-]?key|bearer/i);
  });

  it("owner override går til eksakt provider med reason OWNER_OVERRIDE", async () => {
    const { pool } = fakePool();
    const trace = new MemoryTraceSink();
    const gateway = new ModelGateway({
      pool,
      trace,
      providers: [new ScriptedAdapter(() => "primær"), new ErrorAdapter("openai", "server")]
    });
    const result = await gateway.complete({ tenant_id: "tenant-a", provider: "scripted", request: REQUEST });
    expect(result.provider).toBe("scripted");
    const meta = trace.spans.find((r) => r.kind === "model_call")?.metadata as Record<string, unknown>;
    expect(meta["router_mode"]).toBe("SPECIFIC_PROVIDER");
    expect(meta["routing_reason"]).toBe("OWNER_OVERRIDE");
  });

  it("critic (opt-in): separat kostrad med critic-flagg, resultat får critique-metadata", async () => {
    const { pool, costInserts } = fakePool();
    const gateway = new ModelGateway({
      pool,
      trace: new MemoryTraceSink(),
      providers: [new ScriptedAdapter(() => "CONFIDENCE: 90 - ingen funn")]
    });
    const result = await gateway.complete({ tenant_id: "tenant-a", purpose: "PLAN", critic: true, request: REQUEST });
    const critic = result.metadata?.["critic"] as { provider: string; critique: string };
    expect(critic.critique).toContain("CONFIDENCE");
    const criticRows = costInserts.filter((p) => p[12] === true);
    expect(criticRows.length).toBe(1); // nøyaktig én critic-kostrad
    const primaryRows = costInserts.filter((p) => p[12] === false && p[3] === "model:scripted");
    expect(primaryRows.length).toBe(1);
  });

  it("critic er ALDRI default (§18): uten opt-in kjøres ingen critic", async () => {
    const { pool, costInserts } = fakePool();
    const gateway = new ModelGateway({
      pool,
      trace: new MemoryTraceSink(),
      providers: [new ScriptedAdapter(() => "svar")]
    });
    await gateway.complete({ tenant_id: "tenant-a", purpose: "CHAT", request: REQUEST });
    expect(costInserts.filter((p) => p[12] === true).length).toBe(0);
  });

  it("critic-feil velter aldri primærsvaret", async () => {
    const { pool } = fakePool();
    const scripted = new ScriptedAdapter(() => "svar");
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [scripted] });
    // Tving critic-planen til å feile ved å gjøre provider utilgjengelig etter primærkallet:
    let calls = 0;
    const flaky: ModelProviderAdapter = {
      name: "scripted",
      model: "scripted-1",
      available: () => true,
      complete: async (req, onToken) => {
        calls += 1;
        if (calls > 1) {
          throw new ProviderError("scripted", "server", "critic_down");
        }
        return scripted.complete(req, onToken);
      }
    };
    const gw2 = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [flaky] });
    const result = await gw2.complete({ tenant_id: "tenant-a", critic: true, request: REQUEST });
    expect(result.text).toBe("svar");
    expect(result.metadata?.["critic_error"]).toBeTruthy();
    void gateway;
  });

  it("Del 3: critic arver sensitivitet - SECRET_RESTRICTED primærinnhold sendes ALDRI til en sky-critic", async () => {
    const { pool } = fakePool();
    let cloudCalls = 0;
    const cloud: ModelProviderAdapter = {
      name: "openai", model: "gpt-test", available: () => true,
      complete: async () => { cloudCalls += 1; return { text: "kritikk", usage: { input_tokens: 1, output_tokens: 1 }, provider: "openai", model: "gpt-test" } as never; }
    };
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [new ScriptedAdapter(() => "svar"), cloud] });
    const result = await gateway.complete({
      tenant_id: "tenant-a", critic: true, sensitivity: "SECRET_RESTRICTED", providerPreference: ["scripted"], request: REQUEST
    });
    expect(result.text).toBe("svar");
    expect(cloudCalls).toBe(0);
    expect(result.metadata?.["critic_error"]).toBeTruthy();
  });

  it("meshStatus: kompakt status uten secrets (§37)", async () => {
    const { pool } = fakePool();
    const gateway = new ModelGateway({
      pool,
      trace: new MemoryTraceSink(),
      providers: [new ScriptedAdapter(() => "x")]
    });
    await gateway.complete({ tenant_id: "tenant-a", request: REQUEST });
    const mesh = gateway.meshStatus();
    expect(mesh.router).toBe("HEALTHY");
    expect(mesh.providers[0]?.state).toBe("LIVE");
    expect(JSON.stringify(mesh)).not.toMatch(/key|token|secret/i);
  });
});

describe("BO-09 runtime-evidensbasert mesh-status (§25)", () => {
  it("fallback=LOGIC_ONLY med kun én reell provider, VERIFIED etter faktisk cross-provider fallback", async () => {
    const { pool } = fakePool();
    const gateway = new ModelGateway({
      pool,
      trace: new MemoryTraceSink(),
      providers: [new ErrorAdapter("openai", "server"), new ScriptedAdapter(() => "x")]
    });
    expect(gateway.meshStatus().fallback).toBe("LOGIC_ONLY"); // scripted teller ikke som reell
    const result = await gateway.complete({ tenant_id: "tenant-a", request: REQUEST });
    expect(result.provider).toBe("scripted");
    expect(gateway.meshStatus().fallback).toBe("VERIFIED"); // openai→scripted faktisk skjedd
    const router = result.metadata?.["router"] as { mode: string; reason: string; fallback_from?: string[] };
    expect(router.mode).toBe("AUTO");
    expect(router.fallback_from).toEqual(["openai"]);
  });

  it("critic=READY_SELECTIVE før kjøring, VERIFIED etter faktisk critic-run", async () => {
    const { pool } = fakePool();
    const gateway = new ModelGateway({
      pool,
      trace: new MemoryTraceSink(),
      providers: [new ScriptedAdapter(() => "svar")]
    });
    expect(gateway.meshStatus().critic).toBe("READY_SELECTIVE");
    await gateway.complete({ tenant_id: "tenant-a", critic: true, request: REQUEST });
    expect(gateway.meshStatus().critic).toBe("VERIFIED");
  });
});

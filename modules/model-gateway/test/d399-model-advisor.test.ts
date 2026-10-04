import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { ModelProviderAdapter, ModelRequest, ModelResult } from "@jarvis/provider-adapters";
import {
  DEFAULT_MODEL_CATALOG, DEFAULT_PRICING, HeuristicRoutingAdvisor, InvalidModelCatalogError, MemoryTraceSink, ModelGateway,
  describeTask, isModelSelectable, modelCatalogFromEnv, parseModelCatalog, pricingFromEnv, selectModelForTier,
  type CatalogModel, type PricingTable
} from "../src/index.ts";

/**
 * D-399 (modellrådgiver): «riktig MODELL, ikke bare riktig AI». Sonnet-klassen når det holder, Fable bare når oppgaven krever det - og aldri uten bekreftet pris.
 */
const req = (text: string, extra: Partial<ModelRequest> = {}): ModelRequest => ({ messages: [{ role: "user", content: text }], ...extra });

const priced = (keys: string[]): PricingTable => ({
  ...DEFAULT_PRICING,
  rates: { ...DEFAULT_PRICING.rates, ...Object.fromEntries(keys.map((k) => [k, { input_per_1k_ore: 1, output_per_1k_ore: 5, pricing_mode: "PAID" as const }])) }
});

describe("describeTask - deterministisk oppgavebeskrivelse", () => {
  it("kort hverdagsspørsmål = chat/low", () => {
    const t = describeTask(req("Hva er klokka i Tokyo nå?"));
    expect(t).toMatchObject({ kind: "chat", complexity: "low", needs_tools: false });
  });
  it("kodeoppgave med flere filer og arkitektur = code/high", () => {
    const t = describeTask(req("Refaktorer hele systemet: flytt autentiseringen til egen modul over flere filer, og vurder sikkerhet og samtidighet. ".repeat(60)), "CODE");
    expect(t.kind).toBe("code");
    expect(t.complexity).toBe("high");
  });
  it("purpose overstyrer gjetting av type", () => {
    expect(describeTask(req("hei"), "PLAN").kind).toBe("planning");
    expect(describeTask(req("hei"), "EXTRACT").kind).toBe("extraction");
  });
  it("verktøy og mange verktøyrunder øker kompleksiteten", () => {
    const ex = Array.from({ length: 3 }, () => ({ calls: [], results: [] }));
    const t = describeTask(req("Finn ut hva som skjedde med kunden", { tools: [{ name: "x", description: "y", input_schema: {} }], tool_exchanges: ex }));
    expect(t.needs_tools).toBe(true);
    expect(t.tool_rounds).toBe(3);
    expect(t.complexity).not.toBe("low");
  });
});

describe("HeuristicRoutingAdvisor", () => {
  const a = new HeuristicRoutingAdvisor();
  it("low→fast, medium→standard, high→heavy - og ALDRI frontier", () => {
    const base = { kind: "chat" as const, size_chars: 10, needs_tools: false, tool_rounds: 0 };
    expect(a.advise({ ...base, complexity: "low" }).tier).toBe("fast");
    expect(a.advise({ ...base, complexity: "medium" }).tier).toBe("standard");
    expect(a.advise({ ...base, complexity: "high" }).tier).toBe("heavy");
    for (const kind of ["code", "planning", "analysis", "research"] as const) {
      for (const complexity of ["low", "medium", "high"] as const) {
        expect(a.advise({ ...base, kind, complexity, needs_tools: true }).tier).not.toBe("frontier");
      }
    }
  });
  it("kode/verktøy løftes fra fast til standard (for svak modell er dyrt i omarbeid)", () => {
    expect(a.advise({ kind: "code", complexity: "low", size_chars: 10, needs_tools: false, tool_rounds: 0 }).tier).toBe("standard");
  });
});

describe("selectModelForTier - billigst som holder", () => {
  const catalog = DEFAULT_MODEL_CATALOG;
  const ctx = (pricing: PricingTable, extra: Record<string, unknown> = {}) => ({
    eligibleProviders: ["anthropic"], providerDefaultModel: (p: string) => (p === "anthropic" ? "claude-sonnet-5" : undefined), pricing, catalog, ...extra
  });

  it("standard => Sonnet 5.5 (har eksplisitt pris), ikke Fable", () => {
    const s = selectModelForTier("standard", ctx(DEFAULT_PRICING));
    expect(s).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", tier: "standard", downgraded: false });
  });
  it("Fable er IKKE valgbar uten bekreftet pris - selv om trinnet ber om det (nærmeste nedover, flagget)", () => {
    const s = selectModelForTier("frontier", ctx(DEFAULT_PRICING));
    expect(s).toMatchObject({ model: "claude-sonnet-5-5", downgraded: true });
  });
  it("med eier-bekreftet Fable-pris velges Fable KUN når frontier etterspørres", () => {
    const p = priced(["anthropic:claude-fable-5-1", "anthropic:claude-opus-5-5"]);
    expect(selectModelForTier("frontier", ctx(p))?.model).toBe("claude-fable-5-1");
    expect(selectModelForTier("heavy", ctx(p))?.model).toBe("claude-opus-5-5");
    expect(selectModelForTier("standard", ctx(p))?.model).toBe("claude-sonnet-5-5");
  });
  it("trinn-tak (budsjett) klemmer ned anbefalingen", () => {
    const p = priced(["anthropic:claude-fable-5-1"]);
    expect(selectModelForTier("frontier", ctx(p, { maxTier: "standard" }))?.model).toBe("claude-sonnet-5-5");
  });
  it("kun ruterens kvalifiserte leverandører er kandidater; ingen valgbar => null", () => {
    expect(selectModelForTier("standard", ctx(DEFAULT_PRICING, { eligibleProviders: ["gemma_local"] }))).toBeNull();
  });
  it("billigste innen samme trinn vinner", () => {
    const cat: CatalogModel[] = [
      { provider: "anthropic", model: "a-dyr", tier: "standard", cost_class: 4 },
      { provider: "anthropic", model: "a-billig", tier: "standard", cost_class: 2 }
    ];
    const p = priced(["anthropic:a-dyr", "anthropic:a-billig"]);
    expect(selectModelForTier("standard", { ...ctx(p), catalog: cat })?.model).toBe("a-billig");
  });
  it("isModelSelectable: pris eller leverandørens standardmodell", () => {
    const e = DEFAULT_MODEL_CATALOG.find((m) => m.model === "claude-haiku-4-5-20251001") as CatalogModel;
    expect(isModelSelectable(e, DEFAULT_PRICING, "claude-sonnet-5")).toBe(false);
    expect(isModelSelectable(e, priced(["anthropic:claude-haiku-4-5-20251001"]), "claude-sonnet-5")).toBe(true);
    expect(isModelSelectable(e, DEFAULT_PRICING, "claude-haiku-4-5-20251001")).toBe(true);
  });
});

describe("katalog og pris fra miljø validerer strengt", () => {
  it("parseModelCatalog avviser ugyldige oppføringer og duplikater", () => {
    expect(() => parseModelCatalog("x")).toThrow(InvalidModelCatalogError);
    expect(() => parseModelCatalog([{ provider: "anthropic", model: "bad model!", tier: "fast", cost_class: 1 }])).toThrow(/model/);
    expect(() => parseModelCatalog([{ provider: "anthropic", model: "m", tier: "ultra", cost_class: 1 }])).toThrow(/tier/);
    const ok = { provider: "anthropic", model: "m", tier: "fast", cost_class: 1 };
    expect(() => parseModelCatalog([ok, ok])).toThrow(/duplikat/);
    expect(parseModelCatalog([ok])).toHaveLength(1);
  });
  it("modelCatalogFromEnv: tom = standard, ugyldig JSON kaster", () => {
    expect(modelCatalogFromEnv({})).toHaveLength(DEFAULT_MODEL_CATALOG.length);
    expect(() => modelCatalogFromEnv({ JARVIS_MODEL_CATALOG: "{ikke json" })).toThrow(InvalidModelCatalogError);
  });
  it("pricingFromEnv fletter over standard og kaster på ugyldig sats/nøkkel", () => {
    const t = pricingFromEnv(DEFAULT_PRICING, { JARVIS_MODEL_PRICING: JSON.stringify({ "anthropic:claude-fable-5-1": { input_per_1k_ore: 20, output_per_1k_ore: 100 } }) });
    expect(t.rates["anthropic:claude-fable-5-1"]?.output_per_1k_ore).toBe(100);
    expect(t.rates["anthropic"]).toBeDefined();
    expect(() => pricingFromEnv(DEFAULT_PRICING, { JARVIS_MODEL_PRICING: JSON.stringify({ fable: { input_per_1k_ore: 1, output_per_1k_ore: 1 } }) })).toThrow(/provider:model/);
    expect(() => pricingFromEnv(DEFAULT_PRICING, { JARVIS_MODEL_PRICING: JSON.stringify({ "a:b": { input_per_1k_ore: -1, output_per_1k_ore: 1 } }) })).toThrow(/satser/);
    expect(pricingFromEnv(DEFAULT_PRICING, {})).toBe(DEFAULT_PRICING);
  });
});

function fakePool(): pg.Pool {
  const client = { query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }), release: () => undefined };
  return { connect: async () => client } as unknown as pg.Pool;
}

/** Leverandør «anthropic» som husker hvilken modell hvert kall ba om. */
function recordingAnthropic(): { adapter: ModelProviderAdapter; models: Array<string | undefined> } {
  const models: Array<string | undefined> = [];
  const adapter: ModelProviderAdapter = {
    name: "anthropic", model: "claude-sonnet-5", available: () => true,
    complete: async (r: ModelRequest): Promise<ModelResult> => {
      models.push(r.model);
      return { text: "ok", provider: "anthropic", model: r.model ?? "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 5 }, latency_ms: 1 } as unknown as ModelResult;
    }
  };
  return { adapter, models };
}

describe("ModelGateway - shadow vs active", () => {
  const catalog: CatalogModel[] = [
    { provider: "anthropic", model: "claude-haiku-4-5-20251001", tier: "fast", cost_class: 1 },
    { provider: "anthropic", model: "claude-sonnet-5", tier: "standard", cost_class: 3 }
  ];
  const pricing = priced(["anthropic:claude-haiku-4-5-20251001", "anthropic:claude-sonnet-5"]);

  it("shadow (standard): logger hva rådgiveren VILLE valgt, men sender ALDRI en overstyrt modell", async () => {
    const { adapter, models } = recordingAnthropic();
    const trace = new MemoryTraceSink();
    const gw = new ModelGateway({ pool: fakePool(), trace, providers: [adapter], catalog, pricing, advisorMode: "shadow" });
    await gw.complete({ tenant_id: "t", purpose: "QUICK_CLASSIFICATION", provider: "anthropic", request: req("Hva er 2+2?") });
    expect(models).toEqual([undefined]);
    const advice = trace.spans.find((s) => s.kind === "model_advice");
    expect(advice?.metadata).toMatchObject({ mode: "shadow", advised_tier: "fast", advised_model: "claude-haiku-4-5-20251001", router_model: "claude-sonnet-5", would_change: true });
  });

  it("active: enkel oppgave får billig modell, vanskelig oppgave beholder Sonnet - og modellen når adapteren per kall", async () => {
    const { adapter, models } = recordingAnthropic();
    const gw = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter], catalog, pricing, advisorMode: "active" });
    await gw.complete({ tenant_id: "t", purpose: "QUICK_CLASSIFICATION", provider: "anthropic", request: req("Hva er 2+2?") });
    await gw.complete({ tenant_id: "t", purpose: "CODE", provider: "anthropic", request: req("Implementer en funksjon som sorterer en liste i TypeScript.") });
    expect(models).toEqual(["claude-haiku-4-5-20251001", undefined]); // kode => standard => ruterens standardmodell (Sonnet), ingen overstyring
  });

  it("off: ingen rådgivning og ingen trace-hendelse", async () => {
    const { adapter, models } = recordingAnthropic();
    const trace = new MemoryTraceSink();
    const gw = new ModelGateway({ pool: fakePool(), trace, providers: [adapter], catalog, pricing, advisorMode: "off" });
    await gw.complete({ tenant_id: "t", purpose: "CHAT", provider: "anthropic", request: req("hei") });
    expect(models).toEqual([undefined]);
    expect(trace.spans.some((s) => s.kind === "model_advice")).toBe(false);
  });

  it("en rådgiver som kaster stopper aldri kallet (faller tilbake til ruterens plan)", async () => {
    const { adapter, models } = recordingAnthropic();
    const gw = new ModelGateway({
      pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter], catalog, pricing, advisorMode: "active",
      advisor: { name: "boom", advise: () => { throw new Error("rådgiver nede"); } }
    });
    const r = await gw.complete({ tenant_id: "t", purpose: "CHAT", provider: "anthropic", request: req("hei") });
    expect(r.text).toBe("ok");
    expect(models).toEqual([undefined]);
  });
});

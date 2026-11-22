import type pg from "pg";
import { describe, expect, it } from "vitest";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { ProviderError, type ModelProviderAdapter, type ModelRequest, type ModelResult } from "@jarvis/provider-adapters";
import { ModelSignalAssist, type AssistInput, type AssistModelGateway } from "@jarvis/situations";

/**
 * WP-G4 (D-466), P1c: utførelsesvern for modellassistert klassifisering MOT DEN EKTE `ModelGateway` med skyspioner. Begrensede domener (helse, kamera, hjem) skal aldri nå en skymodell - heller ikke når den lokale modellen er
 * nede eller svarer feil - og et ikke-begrenset domene (infra) er ikke låst til lokal modell. Ingen ekte nett, ingen ekte modell: adaptere er lokale spioner.
 */
const fakePool = (): pg.Pool => {
  const client = { query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }), release: () => undefined };
  return { connect: async () => client } as unknown as pg.Pool;
};

const ANSWER = { category: "attention", priority: "high", explanation: "Utenfor vanlig tid." };

function spy(name: string, calls: ModelRequest[], behaviour: "ok" | "down" = "ok"): ModelProviderAdapter {
  return {
    name, model: "m", available: () => true,
    async complete(request: ModelRequest): Promise<ModelResult> {
      calls.push(request);
      if (behaviour === "down") throw new ProviderError(name, "server", "nede", 503);
      return { text: JSON.stringify(ANSWER), structured_output: ANSWER, usage: { input_tokens: 1, output_tokens: 1 }, provider: name, model: "m", latency_ms: 1 };
    }
  };
}

const CLOUD = ["anthropic", "openai", "gemini", "gemma_hosted", "kimi", "hermes"];
const input = (over: Partial<AssistInput> = {}): AssistInput => ({
  tenant_id: "t-owner", memory_space: "home", rule_key: "vision:motion_detected", domain: "vision", priority: "low", facts: { event_type: "motion_detected", night: true, classified: false }, detection_key: "vision:motion_detected:x:1", ...over
});
const assistWith = (providers: ModelProviderAdapter[]): ModelSignalAssist =>
  new ModelSignalAssist({ gateway: new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers }) as unknown as AssistModelGateway });

describe("A: begrensede domener går ALDRI til sky (ekte ModelGateway, skyspioner)", () => {
  for (const domain of ["vision", "health", "home"] as const) {
    it(`${domain}: med en lokal modell tilgjengelig brukes KUN den; skyspionene kalles aldri`, async () => {
      const cloudCalls: ModelRequest[] = [];
      const localCalls: ModelRequest[] = [];
      const providers = [...CLOUD.map((n) => spy(n, cloudCalls)), spy("ollama", localCalls)];
      const out = await assistWith(providers).assess(input({ domain }));
      expect(out).toMatchObject({ status: "assessed", assessment: { provider: "ollama", category: "attention" } });
      expect(cloudCalls).toHaveLength(0);
      expect(localCalls).toHaveLength(1);
      // inngangen til modellen er kun den lukkede fakta-mengden
      const content = (localCalls[0]!.messages[0] as { content: string }).content;
      expect(JSON.parse(content)).toEqual({ rule: "vision:motion_detected", domain, priority: "low", facts: { event_type: "motion_detected", night: true, classified: false } });
    });

    it(`${domain}: INGEN lokal modell (kun sky tilgjengelig) = klassifiseringen feiler lukket (unavailable), og skyen kalles aldri`, async () => {
      const cloudCalls: ModelRequest[] = [];
      const out = await assistWith(CLOUD.map((n) => spy(n, cloudCalls))).assess(input({ domain }));
      expect(out.status).toBe("unavailable");
      expect(cloudCalls).toHaveLength(0);
    });

    it(`${domain}: den lokale modellen er NEDE = unavailable uten sky-fallback`, async () => {
      const cloudCalls: ModelRequest[] = [];
      const localCalls: ModelRequest[] = [];
      const out = await assistWith([...CLOUD.map((n) => spy(n, cloudCalls)), spy("ollama", localCalls, "down")]).assess(input({ domain }));
      expect(out.status).toBe("unavailable");
      expect(cloudCalls).toHaveLength(0);
      expect(localCalls.length).toBeGreaterThanOrEqual(1);
    });
  }

  it("modellkallet bærer SECRET_RESTRICTED-låsen i sporet: ingen betalte modeller og kun lokal modus (verifisert på selve gateway-inngangen)", async () => {
    const seen: unknown[] = [];
    const real = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [spy("ollama", [])] });
    const wrapped: AssistModelGateway = { complete: async (call) => { seen.push({ sensitivity: call.sensitivity, mode: call.mode, paid: call.paid_models_allowed, purpose: call.purpose }); return (real as unknown as AssistModelGateway).complete(call); } };
    await new ModelSignalAssist({ gateway: wrapped }).assess(input({ domain: "health", rule_key: "health:resting_heart_rate_deviation", facts: { metric: "resting_heart_rate", direction: "above", severity: "mild", days: 3, baseline_days: 28 } }));
    expect(seen).toEqual([{ sensitivity: "SECRET_RESTRICTED", mode: "LOCAL", paid: false, purpose: "QUICK_CLASSIFICATION" }]);
  });
});

describe("B: ikke-begrensede domener er ikke låst til lokal modell (låsen følger sensitiviteten, ikke et blankt forbud)", () => {
  it("infra: en skymodell kan brukes og svaret godtas (ingen lokal-verifisering for et ikke-begrenset domene)", async () => {
    const cloudCalls: ModelRequest[] = [];
    const out = await assistWith([spy("anthropic", cloudCalls)]).assess(input({ domain: "infra", rule_key: "incident:incident_active", facts: { severity: "high", status: "open" } }));
    expect(out).toMatchObject({ status: "assessed", assessment: { provider: "anthropic" } });
    expect(cloudCalls).toHaveLength(1);
  });
});

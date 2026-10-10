import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { ProviderError, type ModelProviderAdapter, type ModelRequest, type ModelResult, type StreamEvent, type ToolCallRequest, type ToolResultMessage } from "@jarvis/provider-adapters";
import { MemoryTraceSink, ModelGateway, type AttemptFailure, type ToolExecutor } from "../src/index.ts";

/**
 * WP-D4 (gjennomgang av PR #315, M2 + L11): `onAttemptFailed` skal meldes for HVER kandidat som ikke ble den som svarte - ikke bare for kastede feil. Før rettelsen ga et TOMT eller AVKORTET svar fra den første
 * kandidaten stille failover (ingen «Reservemodell brukt»), fordi «Ikke brukbart»-grenene i `executePlan` aldri kalte lytteren. Her mot en ekte `ModelGateway` med fake adaptere; at samtalemotoren faktisk viser merknaden
 * testes i `apps/api/test/wpd4-reserve-visibility.test.ts`.
 */
const MODELS: Record<string, string> = { gemma_local: "gemma-local", local_llm: "local-model", gemma_hosted: "gemma-4-26b-a4b-it", anthropic: "claude-sonnet-5-5" };

function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }),
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

const REQUEST: ModelRequest = { messages: [{ role: "user", content: "hei" }] };
const base = { tenant_id: "t1", purpose: "CHAT" as const, sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" as const, request: REQUEST };

type Step = "ok" | "empty" | "blank" | "truncated" | ProviderError["kind"];
const result = (provider: string, text: string, finish_reason: string): ModelResult => ({ text, usage: { input_tokens: 5, output_tokens: 5 }, provider, model: MODELS[provider] ?? "m", finish_reason });
const outcome = (name: string, step: Step): ModelResult => {
  if (step === "ok") return result(name, `svar fra ${name}`, "stop");
  if (step === "empty") return result(name, "", "stop");
  if (step === "blank") return result(name, "  \n ", "stop");
  if (step === "truncated") return result(name, "", "length");
  throw new ProviderError(name, step, `${name}_${step}`);
};

/** Skriptet adapter: hvert kall bruker neste steg (siste gjentas). Kall telles. */
function scripted(name: string, steps: Step[], calls: string[] = []): ModelProviderAdapter {
  let i = 0;
  const next = (): Step => steps[Math.min(i++, steps.length - 1)] as Step;
  return {
    name, model: MODELS[name] ?? "m", available: () => true,
    complete: async () => { calls.push(name); return outcome(name, next()); },
    stream: async (_req, onEvent: (e: StreamEvent) => void) => {
      calls.push(name);
      const r = outcome(name, next());
      onEvent({ type: "start", provider: name, model: r.model, generation_id: "g" });
      if (r.text.length > 0) onEvent({ type: "text_delta", text: r.text });
      onEvent({ type: "usage", usage: r.usage });
      onEvent({ type: "finish", finish_reason: r.finish_reason ?? "stop" });
      return r;
    }
  };
}

const chain = (...names: string[]) => ({ providerPreference: names, preferenceFailover: true });

// Gatewayen logger hvert mislykket forsøk (`model_attempt_failed`) på stderr - stille i testutskriften.
beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

describe("M2: ubrukelig svar er en mislykket kandidat for onAttemptFailed", () => {
  it.each([["tomt svar", "empty"], ["bare blanke tegn", "blank"]] as const)("%s fra første kandidat: neste svarer, og lytteren får nøyaktig ÉN melding om den første", async (_label, step) => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [scripted("gemma_local", [step], calls), scripted("gemma_hosted", ["ok"], calls)] });
    const failures: AttemptFailure[] = [];
    const out = await gateway.complete({ ...base, ...chain("gemma_local", "gemma_hosted"), onAttemptFailed: (f) => failures.push(f) });
    expect(out.provider).toBe("gemma_hosted");
    expect(calls).toEqual(["gemma_local", "gemma_hosted"]); // et tomt svar (stop) prøves ikke om på samme leverandør
    expect(failures).toEqual([{ provider: "gemma_local", kind: "invalid_response" }]);
    expect((out.metadata?.["router"] as { fallback_from?: string[] }).fallback_from).toEqual(["gemma_local"]);
  });

  it("avkortet svar (finish_reason=length, ingen tekst): ett begrenset retry, så neste kandidat - og kun ÉN melding for kandidaten (ikke én per forsøk)", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [scripted("gemma_local", ["truncated"], calls), scripted("gemma_hosted", ["ok"], calls)] });
    const failures: AttemptFailure[] = [];
    const out = await gateway.complete({ ...base, ...chain("gemma_local", "gemma_hosted"), onAttemptFailed: (f) => failures.push(f) });
    expect(out.provider).toBe("gemma_hosted");
    expect(calls).toEqual(["gemma_local", "gemma_local", "gemma_hosted"]); // første forsøk + det adaptive retry-forsøket (også avkortet)
    expect(failures).toEqual([{ provider: "gemma_local", kind: "invalid_response" }]);
  });

  it("avkortet først, retry KASTER: meldt via feilstien (ikke to ganger)", async () => {
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [scripted("gemma_local", ["truncated", "network"]), scripted("gemma_hosted", ["ok"])] });
    const failures: AttemptFailure[] = [];
    const out = await gateway.complete({ ...base, ...chain("gemma_local", "gemma_hosted"), onAttemptFailed: (f) => failures.push(f) });
    expect(out.provider).toBe("gemma_hosted");
    expect(failures).toEqual([{ provider: "gemma_local", kind: "network" }]);
  });

  it("avkortet først, retry LYKKES: den første kandidaten svarte likevel, ingen melding", async () => {
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [scripted("gemma_local", ["truncated", "ok"]), scripted("gemma_hosted", ["ok"])] });
    const failures: AttemptFailure[] = [];
    const out = await gateway.complete({ ...base, ...chain("gemma_local", "gemma_hosted"), onAttemptFailed: (f) => failures.push(f) });
    expect(out.provider).toBe("gemma_local");
    expect(failures).toEqual([]);
  });

  it("streaming: tomt resultat uten synlig tekst gir samme melding og failover (feilen før første tegn er allerede dekket)", async () => {
    for (const first of ["empty", "truncated", "network", "invalid_response"] as const) {
      const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [scripted("gemma_local", [first]), scripted("gemma_hosted", ["ok"])] });
      const failures: AttemptFailure[] = [];
      const events: StreamEvent[] = [];
      const out = await gateway.stream({ ...base, ...chain("gemma_local", "gemma_hosted"), onAttemptFailed: (f) => failures.push(f) }, (e) => events.push(e));
      expect(out.provider, first).toBe("gemma_hosted");
      expect(failures.length, first).toBeGreaterThanOrEqual(1);
      expect(new Set(failures.map((f) => f.provider)), first).toEqual(new Set(["gemma_local"]));
      expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join(""), first).toBe("svar fra gemma_hosted");
    }
  });

  it("siste kandidat ubrukelig: feilen kastes ærlig (invalid_response) og lytteren har fått begge", async () => {
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [scripted("gemma_local", ["empty"]), scripted("gemma_hosted", ["empty"])] });
    const failures: AttemptFailure[] = [];
    await expect(gateway.complete({ ...base, ...chain("gemma_local", "gemma_hosted"), onAttemptFailed: (f) => failures.push(f) })).rejects.toMatchObject({ kind: "invalid_response", provider: "gemma_hosted" });
    expect(failures).toEqual([{ provider: "gemma_local", kind: "invalid_response" }, { provider: "gemma_hosted", kind: "invalid_response" }]);
  });

  it("criticen rapporteres ikke, og en lytter som kaster stopper aldri failover etter et tomt svar", async () => {
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [scripted("gemma_local", ["empty"]), scripted("gemma_hosted", ["ok"])] });
    const out = await gateway.complete({ ...base, ...chain("gemma_local", "gemma_hosted"), onAttemptFailed: () => { throw new Error("lytteren feilet"); } });
    expect(out.provider).toBe("gemma_hosted");
    expect(vi.mocked(console.error).mock.calls.map((c) => String(c[0])).some((l) => l.includes("attempt_failed_listener_error"))).toBe(true);
  });
});

describe("M2: en kandidat som hoppes over pga. helse (UNAVAILABLE) er også reservebruk", () => {
  it("etter gjentatte feil hoppes primæren over FØR noe kall - og lytteren får beskjed (kind: unavailable) hver gang, så reserven aldri er stille", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [scripted("gemma_local", ["network"], calls), scripted("gemma_hosted", ["ok"], calls)] });
    for (let turn = 0; turn < 2; turn += 1) await gateway.complete({ ...base, ...chain("gemma_local", "gemma_hosted") }); // 2 forsøk per tur ⇒ 4 sammenhengende feil ⇒ UNAVAILABLE
    expect(gateway.health.state("gemma_local", true)).toBe("UNAVAILABLE");
    calls.length = 0;
    const failures: AttemptFailure[] = [];
    const out = await gateway.complete({ ...base, ...chain("gemma_local", "gemma_hosted"), onAttemptFailed: (f) => failures.push(f) });
    expect(out.provider).toBe("gemma_hosted");
    expect(calls).toEqual(["gemma_hosted"]); // gemma_local ble ikke engang forsøkt
    expect(failures).toEqual([{ provider: "gemma_local", kind: "unavailable" }]);
  });

  it("en frisk primær gir ingen melding, og et ikke-konfigurert medlem regnes ikke som reservebruk (det er konfigurasjon, ikke et utfall)", async () => {
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [scripted("gemma_local", ["ok"])] });
    const failures: AttemptFailure[] = [];
    const out = await gateway.complete({ ...base, ...chain("local_llm", "gemma_local"), onAttemptFailed: (f) => failures.push(f) }); // local_llm er ikke registrert
    expect(out.provider).toBe("gemma_local");
    expect(failures).toEqual([]);
  });
});

describe("L11: gatewayen oppgir hvilke leverandører som betjente rundene i en verktøyløkke", () => {
  const call = (provider: string): ToolCallRequest => ({ tool_call_id: "c1", tool_name: "read_calendar", arguments: {}, provider, model: "m" });
  const executor: ToolExecutor = {
    execute: async (c): Promise<ToolResultMessage> => ({ tool_call_id: c.tool_call_id, tool_name: c.tool_name, execution_id: "e1", success: true, at: new Date().toISOString(), output: { ok: true } })
  };
  const tools = [{ name: "read_calendar", description: "Les", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } }];

  it("runde 1 på skyreserven, siste runde på den lokale som kom tilbake: served_providers har begge (i rekkefølge), og lytteren har fått den lokale feilen fra runde 1", async () => {
    let localCalls = 0;
    const local: ModelProviderAdapter = {
      name: "gemma_local", model: "gemma-local", available: () => true,
      complete: async (req) => {
        localCalls += 1;
        if (req.tool_exchanges === undefined) throw new ProviderError("gemma_local", "network", "nede i runde 1");
        return result("gemma_local", "ferdig", "stop");
      }
    };
    const cloud: ModelProviderAdapter = {
      name: "anthropic", model: "claude-sonnet-5-5", available: () => true,
      complete: async (req) => (req.tool_exchanges === undefined ? { ...result("anthropic", "", "tool_calls"), tool_calls: [call("anthropic")] } : result("anthropic", "ferdig fra sky", "stop"))
    };
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [local, cloud] });
    const failures: AttemptFailure[] = [];
    const out = await gateway.completeWithTools(
      { ...base, sensitivity: "PRIVATE", ...chain("gemma_local", "anthropic"), onAttemptFailed: (f) => failures.push(f) },
      { tools, executor }
    );
    expect(out.provider).toBe("gemma_local");
    expect(out.text).toBe("ferdig");
    expect(out.metadata?.["served_providers"]).toEqual(["anthropic", "gemma_local"]);
    expect(failures.map((f) => f.provider)).toEqual(["gemma_local", "gemma_local"]); // to forsøk i runde 1 (network er transient)
    expect(localCalls).toBe(3);
  });

  it("en vanlig tur med én leverandør har uendret metadata (ingen served_providers)", async () => {
    const only: ModelProviderAdapter = {
      name: "gemma_local", model: "gemma-local", available: () => true,
      complete: async (req) => (req.tool_exchanges === undefined ? { ...result("gemma_local", "", "tool_calls"), tool_calls: [call("gemma_local")] } : result("gemma_local", "ferdig", "stop"))
    };
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [only] });
    const out = await gateway.completeWithTools({ ...base, ...chain("gemma_local") }, { tools, executor });
    expect(out.metadata?.["tool_rounds"]).toBe(1);
    expect(out.metadata).not.toHaveProperty("served_providers");
  });
});

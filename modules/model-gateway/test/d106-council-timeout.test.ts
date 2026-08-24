import { describe, expect, it } from "vitest";
import type pg from "pg";
import { ProviderError, type ModelProviderAdapter, type ModelRequest, type ModelResult } from "@jarvis/provider-adapters";
import {
  DEFAULT_MODEL_TIMEOUT_MS,
  InvalidTimeoutError,
  MAX_MODEL_TIMEOUT_MS,
  MemoryTraceSink,
  ModelGateway
} from "../src/index.ts";

/**
 * D-106 Council reliability (§ARCHITECTURE DECISION, 2026-08-24): en
 * konkurrent, kanonisk-identisk Council runde-1-diagnostikk mot ekte
 * produksjonsprovidere viste Kimi fullføre KUN 135ms under den ordinære
 * 60000ms-grensen (59865ms) under ekte fem-medlem-samtidighet - tre
 * FORUTGÅENDE reelle Council-forsøk hadde ALLE feilet nettopp her. Dette
 * bekreftet at Council sin arbeidsmengde (fem samtidige, tunge, strukturerte
 * flermodell-kall) trenger mer tidsmargin enn ordinære enkeltkall, UTEN å
 * bevise noen Kimi-spesifikk defekt. Denne testfilen dekker den GENERISKE
 * `ModelGateway`-timeout-kapabiliteten (validering/anvendelse/grenser) -
 * `council.test.ts` dekker at `AiCouncil` faktisk BRUKER den konsistent for
 * runde 1-3 + syntese, provider-nøytralt.
 */
function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) => {
      if (typeof sql === "string" && sql.includes("FROM cost_events")) return { rows: [{ spent: 0 }] };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

/** Fanger `request.timeoutMs` for hvert kall - ren observasjon, ingen provider-spesifikk logikk. */
class TimeoutCapturingAdapter implements ModelProviderAdapter {
  readonly model = "test-model";
  readonly seenTimeouts: Array<number | undefined> = [];
  constructor(readonly name: string) {}
  available(): boolean {
    return true;
  }
  async complete(request: ModelRequest): Promise<ModelResult> {
    this.seenTimeouts.push(request.timeoutMs);
    return { text: "ok", usage: { input_tokens: 5, output_tokens: 5 }, provider: this.name, model: this.model };
  }
}

/** Skriptet adapter som returnerer en KØ av resultater - for adaptivt retry-scenariet (samme mønster som d106-functional-success.test.ts). */
class QueuedTimeoutCapturingAdapter implements ModelProviderAdapter {
  readonly model = "test-model";
  readonly seenTimeouts: Array<number | undefined> = [];
  constructor(
    readonly name: string,
    private readonly queue: ModelResult[]
  ) {}
  available(): boolean {
    return true;
  }
  async complete(request: ModelRequest): Promise<ModelResult> {
    this.seenTimeouts.push(request.timeoutMs);
    const next = this.queue.shift();
    if (!next) throw new ProviderError(this.name, "server", "queue_exhausted");
    return next;
  }
}

describe("D-106 Council reliability: DEFAULT_MODEL_TIMEOUT_MS/MAX_MODEL_TIMEOUT_MS", () => {
  it("A: DEFAULT_MODEL_TIMEOUT_MS er 60000 (ordinær, UENDRET default)", () => {
    expect(DEFAULT_MODEL_TIMEOUT_MS).toBe(60_000);
  });

  it("B: MAX_MODEL_TIMEOUT_MS er 180000 (hard øvre grense - ingen kaller kan be om ubegrenset kjøretid)", () => {
    expect(MAX_MODEL_TIMEOUT_MS).toBe(180_000);
  });
});

describe("D-106 Council reliability: ordinært kall UTEN eksplisitt timeoutMs er UENDRET", () => {
  it("C: ModelGateway.complete() uten CompleteInput.timeoutMs sender request.timeoutMs=undefined til adapteren (adapterens egen konstruksjonsdefault brukes uendret)", async () => {
    const adapter = new TimeoutCapturingAdapter("anthropic");
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter] });
    await gateway.complete({
      tenant_id: "t1",
      provider: "anthropic",
      request: { messages: [{ role: "user", content: "hei" }] }
    });
    expect(adapter.seenTimeouts).toEqual([undefined]);
  });

  it("D: ModelGateway.stream() uten CompleteInput.timeoutMs er også UENDRET (request.timeoutMs=undefined)", async () => {
    const adapter = new TimeoutCapturingAdapter("anthropic");
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter] });
    await gateway.stream(
      { tenant_id: "t1", provider: "anthropic", request: { messages: [{ role: "user", content: "hei" }] } },
      () => undefined
    );
    expect(adapter.seenTimeouts).toEqual([undefined]);
  });
});

describe("D-106 Council reliability: eksplisitt generisk timeoutMs-overstyring respekteres", () => {
  it("E: et gyldig CompleteInput.timeoutMs når adapteren UENDRET, presist", async () => {
    const adapter = new TimeoutCapturingAdapter("anthropic");
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter] });
    await gateway.complete({
      tenant_id: "t1",
      provider: "anthropic",
      timeoutMs: 90_000,
      request: { messages: [{ role: "user", content: "hei" }] }
    });
    expect(adapter.seenTimeouts).toEqual([90_000]);
  });

  it("F: MAX_MODEL_TIMEOUT_MS (180000) selv er en GYLDIG, akseptert verdi (inklusiv øvre grense)", async () => {
    const adapter = new TimeoutCapturingAdapter("anthropic");
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter] });
    await gateway.complete({
      tenant_id: "t1",
      provider: "anthropic",
      timeoutMs: MAX_MODEL_TIMEOUT_MS,
      request: { messages: [{ role: "user", content: "hei" }] }
    });
    expect(adapter.seenTimeouts).toEqual([180_000]);
  });
});

describe("D-106 Council reliability: ugyldig timeoutMs feiler HØYLYTT - aldri en stille klemming/gjetning", () => {
  const adapter = () => new TimeoutCapturingAdapter("anthropic");

  it("G: timeoutMs > MAX_MODEL_TIMEOUT_MS (180001) kastes som InvalidTimeoutError FØR noe adapterkall", async () => {
    const a = adapter();
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [a] });
    await expect(
      gateway.complete({ tenant_id: "t1", provider: "anthropic", timeoutMs: 180_001, request: { messages: [{ role: "user", content: "hei" }] } })
    ).rejects.toBeInstanceOf(InvalidTimeoutError);
    expect(a.seenTimeouts).toHaveLength(0);
  });

  it("H: timeoutMs=0 kastes som InvalidTimeoutError", async () => {
    const a = adapter();
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [a] });
    await expect(
      gateway.complete({ tenant_id: "t1", provider: "anthropic", timeoutMs: 0, request: { messages: [{ role: "user", content: "hei" }] } })
    ).rejects.toBeInstanceOf(InvalidTimeoutError);
    expect(a.seenTimeouts).toHaveLength(0);
  });

  it("I: negativ timeoutMs kastes som InvalidTimeoutError", async () => {
    const a = adapter();
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [a] });
    await expect(
      gateway.complete({ tenant_id: "t1", provider: "anthropic", timeoutMs: -5000, request: { messages: [{ role: "user", content: "hei" }] } })
    ).rejects.toBeInstanceOf(InvalidTimeoutError);
    expect(a.seenTimeouts).toHaveLength(0);
  });

  it("J: NaN timeoutMs kastes som InvalidTimeoutError (ikke-endelig tall)", async () => {
    const a = adapter();
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [a] });
    await expect(
      gateway.complete({ tenant_id: "t1", provider: "anthropic", timeoutMs: Number.NaN, request: { messages: [{ role: "user", content: "hei" }] } })
    ).rejects.toBeInstanceOf(InvalidTimeoutError);
    expect(a.seenTimeouts).toHaveLength(0);
  });

  it("K: Infinity timeoutMs kastes som InvalidTimeoutError (kaller kan ALDRI be om ubegrenset kjøretid)", async () => {
    const a = adapter();
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [a] });
    await expect(
      gateway.complete({
        tenant_id: "t1",
        provider: "anthropic",
        timeoutMs: Number.POSITIVE_INFINITY,
        request: { messages: [{ role: "user", content: "hei" }] }
      })
    ).rejects.toBeInstanceOf(InvalidTimeoutError);
    expect(a.seenTimeouts).toHaveLength(0);
  });

  it("L: ModelGateway.stream() validerer identisk (InvalidTimeoutError for timeoutMs=-1)", async () => {
    const a = adapter();
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [a] });
    await expect(
      gateway.stream({ tenant_id: "t1", provider: "anthropic", timeoutMs: -1, request: { messages: [{ role: "user", content: "hei" }] } }, () => undefined)
    ).rejects.toBeInstanceOf(InvalidTimeoutError);
    expect(a.seenTimeouts).toHaveLength(0);
  });
});

describe("D-106 Council reliability: overstyringen overlever adaptivt retry og etterlater ordinære kall upåvirket", () => {
  it("M: et adaptivt retry-forsøk (TRUNCATED_NO_USABLE_OUTPUT) arver SAMME timeoutMs som førsteforsøket", async () => {
    const truncated: ModelResult = { text: "", usage: { input_tokens: 10, output_tokens: 200 }, provider: "anthropic", model: "test-model", finish_reason: "length" };
    const usable: ModelResult = { text: "et brukbart svar", usage: { input_tokens: 10, output_tokens: 20 }, provider: "anthropic", model: "test-model", finish_reason: "stop" };
    const adapter = new QueuedTimeoutCapturingAdapter("anthropic", [truncated, usable]);
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter] });
    const result = await gateway.complete({
      tenant_id: "t1",
      provider: "anthropic",
      timeoutMs: 120_000,
      request: { messages: [{ role: "user", content: "hei" }], max_tokens: 200 }
    });
    expect(result.metadata?.["adaptive_retry"]).toMatchObject({ triggered: true });
    expect(adapter.seenTimeouts).toEqual([120_000, 120_000]);
  });

  it("N: ETT kall med eksplisitt timeoutMs forurenser IKKE et senere, ordinært kall UTEN overstyring (ingen global/delt tilstand)", async () => {
    const overridden = new TimeoutCapturingAdapter("anthropic");
    const gatewayWithOverride = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [overridden] });
    await gatewayWithOverride.complete({
      tenant_id: "t1",
      provider: "anthropic",
      timeoutMs: 150_000,
      request: { messages: [{ role: "user", content: "hei" }] }
    });

    const ordinary = new TimeoutCapturingAdapter("anthropic");
    const gatewayOrdinary = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [ordinary] });
    await gatewayOrdinary.complete({
      tenant_id: "t1",
      provider: "anthropic",
      request: { messages: [{ role: "user", content: "hei" }] }
    });

    expect(overridden.seenTimeouts).toEqual([150_000]);
    expect(ordinary.seenTimeouts).toEqual([undefined]);
  });
});

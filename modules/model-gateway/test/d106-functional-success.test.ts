import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  ProviderError,
  ScriptedAdapter,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type StreamHandler
} from "@jarvis/provider-adapters";
import {
  classifyCompletionOutcome,
  computeAdaptiveRetryMaxTokens,
  isFunctionalSuccess,
  MemoryTraceSink,
  ModelGateway
} from "../src/index.ts";

/** D-106 PR #53: samme fakePool-mønster som ua1-mesh.test.ts - budsjett-SELECT
 * kan skriptes til å returnere forskjellige spent_ore-verdier per kall (§4/#13). */
function fakePool(spentOreSequence: number[] = [0]): { pool: pg.Pool; costInserts: unknown[][] } {
  const costInserts: unknown[][] = [];
  let budgetCallIndex = 0;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && sql.includes("FROM cost_events") && sql.includes("sum(amount_ore)")) {
        const idx = Math.min(budgetCallIndex, spentOreSequence.length - 1);
        budgetCallIndex += 1;
        return { rows: [{ spent: spentOreSequence[idx] ?? 0 }] };
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

const REQUEST: ModelRequest = { messages: [{ role: "user", content: "test" }] };

/** D-106: skriptet adapter som returnerer en KØ av forhåndsdefinerte resultater -
 * ett per kall (attempt 1, adaptivt retry, ev. neste kandidat). Sporer hver
 * mottatte request (for å inspisere request.max_tokens på retry-kallet, §4/#9). */
class QueuedResultAdapter implements ModelProviderAdapter {
  calls: ModelRequest[] = [];
  constructor(
    readonly name: string,
    readonly model: string,
    private readonly queue: Array<ModelResult | { throw: ProviderError }>
  ) {}
  available(): boolean {
    return true;
  }
  async complete(request: ModelRequest): Promise<ModelResult> {
    this.calls.push(request);
    const next = this.queue.shift();
    if (!next) {
      throw new ProviderError(this.name, "server", "queue_exhausted");
    }
    if ("throw" in next) {
      throw next.throw;
    }
    return next;
  }
  async stream(request: ModelRequest, onEvent: StreamHandler): Promise<ModelResult> {
    this.calls.push(request);
    const next = this.queue.shift();
    if (!next || "throw" in next) {
      throw (next && "throw" in next ? next.throw : new ProviderError(this.name, "server", "queue_exhausted"));
    }
    onEvent({ type: "start", provider: this.name, model: this.model, generation_id: "gen-1" });
    if (next.text) onEvent({ type: "text_delta", text: next.text });
    onEvent({ type: "usage", usage: next.usage });
    onEvent({ type: "finish", finish_reason: next.finish_reason ?? "stop" });
    return next;
  }
}

function usableResult(overrides: Partial<ModelResult> = {}): ModelResult {
  return {
    text: "et brukbart svar",
    usage: { input_tokens: 50, output_tokens: 20 },
    provider: "queued",
    model: "queued-1",
    finish_reason: "stop",
    ...overrides
  };
}

function emptyStopResult(overrides: Partial<ModelResult> = {}): ModelResult {
  return {
    text: "",
    usage: { input_tokens: 50, output_tokens: 5 },
    provider: "queued",
    model: "queued-1",
    finish_reason: "stop",
    ...overrides
  };
}

function truncatedResult(overrides: Partial<ModelResult> = {}): ModelResult {
  return {
    text: "",
    usage: { input_tokens: 50, output_tokens: 200 },
    provider: "queued",
    model: "queued-1",
    finish_reason: "length",
    ...overrides
  };
}

describe("D-106 PR #53: completion-outcome helpers (§2/§3)", () => {
  it("1) ikke-tom tekst -> USABLE_SUCCESS / functional success", () => {
    const r = usableResult();
    expect(isFunctionalSuccess(r)).toBe(true);
    expect(classifyCompletionOutcome(r)).toBe("USABLE_SUCCESS");
  });

  it("2) kun whitespace i teksten -> IKKE functional success", () => {
    const r = usableResult({ text: "   \n\t  " });
    expect(isFunctionalSuccess(r)).toBe(false);
    expect(classifyCompletionOutcome(r)).toBe("EMPTY_OUTPUT");
  });

  it("3) tom tekst + finish_reason=stop -> IKKE functional success (EMPTY_OUTPUT)", () => {
    const r = emptyStopResult();
    expect(isFunctionalSuccess(r)).toBe(false);
    expect(classifyCompletionOutcome(r)).toBe("EMPTY_OUTPUT");
  });

  it("gyldig tool-call-only -> USABLE_SUCCESS (§6-A, regresjonsvern)", () => {
    const r = usableResult({
      text: "",
      finish_reason: "tool_calls",
      tool_calls: [{ tool_call_id: "c1", tool_name: "x", arguments: {}, provider: "queued", model: "queued-1" }]
    });
    expect(classifyCompletionOutcome(r)).toBe("USABLE_SUCCESS");
  });

  it("structured_output uten tekst -> USABLE_SUCCESS (§6-B, regresjonsvern)", () => {
    const r = usableResult({ text: "", structured_output: { ok: true } });
    expect(classifyCompletionOutcome(r)).toBe("USABLE_SUCCESS");
  });

  it("computeAdaptiveRetryMaxTokens: evidensbasert, klemt mellom gulv og tak", () => {
    const r = truncatedResult({ usage: { input_tokens: 10, output_tokens: 200 } });
    const retryMax = computeAdaptiveRetryMaxTokens(r, { max_tokens: 200 });
    expect(retryMax).toBeGreaterThan(200);
    expect(retryMax).toBeLessThanOrEqual(8192);
  });
});

describe("D-106 PR #53: ModelGateway functional-success-invariant (§2-§7)", () => {
  it("4) tom tekst + finish_reason=length -> ett adaptivt retry-forsøk skjer", async () => {
    const { pool } = fakePool();
    const adapter = new QueuedResultAdapter("queued", "queued-1", [truncatedResult(), usableResult()]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    const result = await gateway.complete({ tenant_id: "t1", request: REQUEST });
    expect(result.text).toBe("et brukbart svar");
    expect(adapter.calls.length).toBe(2);
  });

  it("5) forsøk 1 trunkert/tomt, forsøk 2 brukbart -> endelig suksess med retry-metadata", async () => {
    const { pool } = fakePool();
    const adapter = new QueuedResultAdapter("queued", "queued-1", [truncatedResult(), usableResult()]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    const result = await gateway.complete({ tenant_id: "t1", request: REQUEST });
    const retryMeta = result.metadata?.["adaptive_retry"] as { triggered: boolean; first_attempt_outcome: string };
    expect(retryMeta.triggered).toBe(true);
    expect(retryMeta.first_attempt_outcome).toBe("TRUNCATED_NO_USABLE_OUTPUT");
    // Retry-kallet må ha fått et VESENTLIG høyere max_tokens enn attempt 1 (evidensbasert, §4).
    expect(adapter.calls[1]?.max_tokens).toBeGreaterThan(adapter.calls[0]?.max_tokens ?? 0);
  });

  it("6) begge forsøk trunkert/tomt -> ærlig feil (ingen stille suksess)", async () => {
    const { pool } = fakePool();
    const adapter = new QueuedResultAdapter("queued", "queued-1", [truncatedResult(), truncatedResult()]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    await expect(gateway.complete({ tenant_id: "t1", request: REQUEST })).rejects.toThrow(ProviderError);
    expect(adapter.calls.length).toBe(2); // nøyaktig ett retry, ingen retry-spam
  });

  it("empty text + finish_reason=stop -> ingen retry, går rett til (ærlig) feil/neste kandidat", async () => {
    const { pool } = fakePool();
    const failing = new QueuedResultAdapter("failing", "m", [emptyStopResult()]);
    const fallback = new QueuedResultAdapter("fallback", "m2", [usableResult({ provider: "fallback", model: "m2" })]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [failing, fallback] });
    const result = await gateway.complete({ tenant_id: "t1", request: REQUEST });
    expect(result.provider).toBe("fallback");
    expect(failing.calls.length).toBe(1); // EMPTY_OUTPUT (stop) er ALDRI et retry-kandidat
  });

  it("7) gyldig tool-call-only forblir suksess gjennom hele gateway-løpet", async () => {
    const { pool } = fakePool();
    const adapter = new QueuedResultAdapter("queued", "queued-1", [
      usableResult({ text: "", finish_reason: "tool_calls", tool_calls: [{ tool_call_id: "c1", tool_name: "x", arguments: {}, provider: "queued", model: "queued-1" }] })
    ]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    const result = await gateway.complete({ tenant_id: "t1", request: REQUEST });
    expect(result.tool_calls?.length).toBe(1);
    expect(adapter.calls.length).toBe(1); // ingen retry - dette var alltid suksess
  });

  it("8) structured-output-suksess forblir suksess gjennom hele gateway-løpet", async () => {
    const { pool } = fakePool();
    const adapter = new QueuedResultAdapter("queued", "queued-1", [usableResult({ text: "", structured_output: { a: 1 } })]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    const result = await gateway.complete({ tenant_id: "t1", request: REQUEST });
    expect(result.structured_output).toEqual({ a: 1 });
    expect(adapter.calls.length).toBe(1);
  });

  it("9) retry er begrenset til ETT adaptivt forsøk (ikke retry-spam)", async () => {
    const { pool } = fakePool();
    const adapter = new QueuedResultAdapter("queued", "queued-1", [truncatedResult(), truncatedResult(), truncatedResult()]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    await expect(gateway.complete({ tenant_id: "t1", request: REQUEST })).rejects.toThrow();
    expect(adapter.calls.length).toBe(2); // aldri et 3. forsøk
  });

  it("10) begge (ekte) forsøk er kostnadsført", async () => {
    const { pool, costInserts } = fakePool();
    const adapter = new QueuedResultAdapter("queued", "queued-1", [truncatedResult(), usableResult()]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    await gateway.complete({ tenant_id: "t1", request: REQUEST });
    const rows = costInserts.filter((p) => p[3] === "model:queued");
    expect(rows.length).toBe(2);
    // Ingen av dem er nullkost-"failed"-rader - begge var ekte, billable providerkall.
    for (const row of rows) {
      expect(row[10]).toBe(true); // success-flagget
    }
  });

  it("11) begge forsøk er sporet/auditerbare med ærlig outcome-klassifisering", async () => {
    const { pool } = fakePool();
    const trace = new MemoryTraceSink();
    const adapter = new QueuedResultAdapter("queued", "queued-1", [truncatedResult(), usableResult()]);
    const gateway = new ModelGateway({ pool, trace, providers: [adapter] });
    await gateway.complete({ tenant_id: "t1", request: REQUEST });
    const spans = trace.spans.filter((s) => s.kind === "model_call");
    expect(spans.length).toBe(2);
    const outcomes = spans.map((s) => (s.metadata as Record<string, unknown>)["outcome"]);
    expect(outcomes).toContain("TRUNCATED_NO_USABLE_OUTPUT");
    expect(outcomes).toContain("USABLE_SUCCESS");
    // Ingen rå hemmeligheter/resonnement-tekst i det som persisteres.
    expect(JSON.stringify(spans)).not.toMatch(/api[_-]?key|bearer/i);
  });

  it("12) cancellation forhindrer retry (kastet 'cancelled' når før noe kan klassifiseres)", async () => {
    const { pool } = fakePool();
    const adapter = new QueuedResultAdapter("queued", "queued-1", [
      { throw: new ProviderError("queued", "cancelled", "bruker_avbrutt") }
    ]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    await expect(gateway.complete({ tenant_id: "t1", request: REQUEST })).rejects.toMatchObject({ kind: "cancelled" });
    expect(adapter.calls.length).toBe(1); // ingen retry, ingen fallback for cancellation (§35)
  });

  it("13) budsjett-policy nekter retry (hard_blocked mellom forsøk 1 og retry-sjekken)", async () => {
    // Første evaluate() (i complete()) -> ok (0 øre); andre evaluate() (retry-sjekken) -> hard_blocked.
    const { pool, costInserts } = fakePool([0, 300_000]);
    const adapter = new QueuedResultAdapter("queued", "queued-1", [truncatedResult()]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    await expect(gateway.complete({ tenant_id: "t1", request: REQUEST })).rejects.toThrow(ProviderError);
    expect(adapter.calls.length).toBe(1); // retry ble nektet av budsjettet - ALDRI et 2. kall
    expect(costInserts.filter((p) => p[3] === "model:queued").length).toBe(1); // forsøk 1 er likevel kostnadsført
  });

  it("14) eksplisitt provider-override-semantikk bevares (SPECIFIC_PROVIDER, ingen stille bytte)", async () => {
    const { pool } = fakePool();
    const primary = new QueuedResultAdapter("primary", "m", [truncatedResult({ provider: "primary" }), truncatedResult({ provider: "primary" })]);
    const other = new QueuedResultAdapter("other", "m2", [usableResult({ provider: "other" })]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [primary, other] });
    await expect(gateway.complete({ tenant_id: "t1", provider: "primary", request: REQUEST })).rejects.toThrow();
    expect(other.calls.length).toBe(0); // override -> aldri stille fallback til "other"
  });

  it("15) paid_models_allowed=false bevares (empty/truncated resultat trigger aldri betalt fallback)", async () => {
    const { pool } = fakePool();
    const local = new QueuedResultAdapter("ollama", "llama3.1", [truncatedResult({ provider: "ollama" }), truncatedResult({ provider: "ollama" })]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [local] });
    await expect(
      gateway.complete({ tenant_id: "t1", paid_models_allowed: false, request: REQUEST })
    ).rejects.toThrow();
    // Kun den lokale (allerede eneste kandidat) ble forsøkt - ingen sky-provider fantes å falle tilbake til.
    expect(local.calls.length).toBe(2);
  });

  it("16) provider-helse straffes IKKE av tomt/trunkert innhold (transport lyktes)", async () => {
    const { pool } = fakePool();
    const adapter = new QueuedResultAdapter("queued", "queued-1", [truncatedResult(), truncatedResult()]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    await expect(gateway.complete({ tenant_id: "t1", request: REQUEST })).rejects.toThrow();
    // recordSuccess ble kalt for begge (ekte) transportsuksesser -> LIVE, aldri DEGRADED/UNAVAILABLE.
    expect(gateway.health.state("queued", true)).toBe("LIVE");
  });

  // D-441 (JARVIS-038): D-106 lot et tomt/avkortet stream-resultat gå gjennom som suksess fordi `finish`/`usage` allerede var levert. Nå holdes de tilbake til
  // utfallet er klassifisert, så streaming følger samme ærlige regler som ikke-streaming (retry ved avkorting, neste kandidat, ellers en feil).
  const eventTypes = (events: Array<{ type: string }>): string[] => events.map((e) => e.type);

  it("17a) streaming + avkortet uten tekst: ETT retry (ikke-streamet), konsumenten får en REN sekvens for det brukbare svaret - ingen `finish` fra det avkortede forsøket", async () => {
    const { pool } = fakePool();
    const trace = new MemoryTraceSink();
    // Bruker "openai" som providernavn - kun kjente registry-profiler har "streaming"-capability (generisk fallback har det ikke).
    const adapter = new QueuedResultAdapter("openai", "gpt-5", [truncatedResult({ provider: "openai", model: "gpt-5" }), usableResult({ provider: "openai", model: "gpt-5" })]);
    const gateway = new ModelGateway({ pool, trace, providers: [adapter] });
    const events: Array<{ type: string; text?: string }> = [];
    const result = await gateway.stream({ tenant_id: "t1", request: REQUEST }, (e) => events.push(e as { type: string; text?: string }));
    expect(result.text).toBe("et brukbart svar");
    expect(adapter.calls.length).toBe(2);
    expect(adapter.calls[1]?.max_tokens).toBeGreaterThan(200); // evidensbasert utvidet tak, som i ikke-streaming
    expect(eventTypes(events).filter((t) => t === "finish")).toHaveLength(1);
    expect(eventTypes(events).filter((t) => t === "usage")).toHaveLength(1);
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual(["et brukbart svar"]);
    expect(eventTypes(events).slice(-2)).toEqual(["usage", "finish"]);
  });

  it("17b) streaming + tomt svar (stop) fra eneste kandidat: ærlig FEIL, aldri en tom suksess - og ingen `usage`/`finish` levert til konsumenten", async () => {
    const { pool } = fakePool();
    const trace = new MemoryTraceSink();
    const adapter = new QueuedResultAdapter("openai", "gpt-5", [emptyStopResult({ provider: "openai", model: "gpt-5" })]);
    const gateway = new ModelGateway({ pool, trace, providers: [adapter] });
    const events: Array<{ type: string }> = [];
    await expect(gateway.stream({ tenant_id: "t1", request: REQUEST }, (e) => events.push(e as { type: string }))).rejects.toThrow(/no_usable_output/);
    expect(adapter.calls.length).toBe(1); // en tom `stop` er ikke et retry-kandidat (kun avkorting er det)
    expect(eventTypes(events)).not.toContain("finish");
    expect(eventTypes(events)).not.toContain("usage");
    // Ærlig outcome ble likevel persistert i trace-metadata.
    const span = trace.spans.find((s) => s.kind === "model_call");
    expect((span?.metadata as Record<string, unknown>)["outcome"]).toBe("EMPTY_OUTPUT");
  });

  it("17c) streaming + tomt svar fra første kandidat: faller til neste kandidat med `fallback`-event, og `finish` kommer nøyaktig én gang (fra den andre)", async () => {
    const { pool } = fakePool();
    const first = new QueuedResultAdapter("openai", "gpt-5", [emptyStopResult({ provider: "openai", model: "gpt-5" })]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [first, new ScriptedAdapter(() => "svar fra nr 2")] });
    const events: Array<{ type: string; to?: string }> = [];
    const result = await gateway.stream({ tenant_id: "t1", request: REQUEST }, (e) => events.push(e as { type: string; to?: string }));
    expect(result.text).toBe("svar fra nr 2");
    expect(result.provider).toBe("scripted");
    expect(first.calls.length).toBe(1);
    expect(eventTypes(events).filter((t) => t === "finish")).toHaveLength(1);
    expect(events.find((e) => e.type === "fallback")?.to).toBe("scripted");
  });

  it("17d) regresjon: brukbart stream-svar leverer text_delta, usage og finish i samme rekkefølge som før", async () => {
    const { pool } = fakePool();
    const adapter = new QueuedResultAdapter("openai", "gpt-5", [usableResult({ provider: "openai", model: "gpt-5" })]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    const events: Array<{ type: string }> = [];
    const result = await gateway.stream({ tenant_id: "t1", request: REQUEST }, (e) => events.push(e as { type: string }));
    expect(result.text).toBe("et brukbart svar");
    expect(eventTypes(events)).toEqual(["start", "text_delta", "usage", "finish"]);
    expect(adapter.calls.length).toBe(1);
  });

  it("17e) streaming + kun blanke tegn levert: teller ikke som synlig output, så det behandles som tomt svar (ærlig feil) - ingen `finish`", async () => {
    const { pool } = fakePool();
    const adapter = new QueuedResultAdapter("openai", "gpt-5", [usableResult({ provider: "openai", model: "gpt-5", text: "   " })]);
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    const events: Array<{ type: string }> = [];
    // blanke tegn teller ikke som synlig output, så dette behandles som tomt svar: ærlig feil
    await expect(gateway.stream({ tenant_id: "t1", request: REQUEST }, (e) => events.push(e as { type: string }))).rejects.toThrow(/no_usable_output/);
    expect(eventTypes(events)).not.toContain("finish");
  });

  it("18) tenant-isolasjon: kost/trace-rader er merket med riktig tenant_id for begge forsøk", async () => {
    const { pool, costInserts } = fakePool();
    const trace = new MemoryTraceSink();
    const adapter = new QueuedResultAdapter("queued", "queued-1", [truncatedResult(), usableResult()]);
    const gateway = new ModelGateway({ pool, trace, providers: [adapter] });
    await gateway.complete({ tenant_id: "tenant-x", request: REQUEST });
    const rows = costInserts.filter((p) => p[3] === "model:queued");
    for (const row of rows) {
      expect(row[0]).toBe("tenant-x");
    }
    for (const span of trace.spans.filter((s) => s.kind === "model_call")) {
      expect(span.tenant_id).toBe("tenant-x");
    }
  });

  it("19) ingen hemmeligheter lekkes i retry-metadata/trace for et trunkert forsøk", async () => {
    const { pool } = fakePool();
    const trace = new MemoryTraceSink();
    const adapter = new QueuedResultAdapter("queued", "queued-1", [truncatedResult(), usableResult()]);
    const gateway = new ModelGateway({ pool, trace, providers: [adapter] });
    const result = await gateway.complete({ tenant_id: "t1", request: REQUEST });
    const dump = JSON.stringify({ result, spans: trace.spans });
    expect(dump).not.toMatch(/api[_-]?key|bearer|secret/i);
  });
});

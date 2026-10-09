import { describe, expect, it } from "vitest";
import type pg from "pg";
import { ProviderError, type ModelProviderAdapter, type ModelRequest, type ModelResult, type ToolCallRequest } from "@jarvis/provider-adapters";
import {
  BlockedAdapter, CapabilityRegistry, DEFAULT_PRICING, MemoryTraceSink, ModelGateway, SKIPPED_FALLBACK, SMOKE_PROVIDER_ORDER, SMOKE_TOOL, SmokeCostMeter,
  assertEvidenceHasNoSecrets, defaultBlocked, evaluateSmoke, fallbackChain, inMemoryCostPool, measureParallel, overheadOf, parseSmokeArgs, probeProvider, probeTools,
  redactErrorText, renderSmokeSummaryNo, runFallbackCheck, runSensitivityGateCheck, secretEnvNames,
  type SmokeEvidence, type SmokeFallbackCheck, type SmokeGateCheck, type SmokeProbeRecord
} from "../src/index.ts";

/**
 * WP-D4 (JARVIS-033/036/078): logikken bak eierens akseptansescript `mesh-live-smoke.ts` - kommandolinje, hemmelighetsvern, probe/verktøy/parallell-faser mot fake adaptere, fallback mot den
 * ekte `ModelGateway` med én sperret leverandør og sensitivitetsporten uten nettkall. (Selve skriptet som prosess: `wpd4-mesh-smoke-script.test.ts`.)
 */
const registry = new CapabilityRegistry();
const pricing = DEFAULT_PRICING;
const PLANTED_BEARER = `Bearer ${"a".repeat(32)}`;

describe("parseSmokeArgs", () => {
  const ok = (argv: string[]) => {
    const r = parseSmokeArgs(argv);
    if (!r.ok) throw new Error(r.error);
    return r.options;
  };

  it("standardverdier uten flagg", () => {
    expect(ok([])).toEqual({ providers: null, block: null, tools: false, parallel: false, soloCalls: 3, parallelCalls: 3, maxCostOre: 100, timeoutMs: 30_000, out: null, db: false, tenant: "tenant-personal", help: false });
  });

  it("alle flagg parses", () => {
    const o = ok(["--providers", "kimi,hermes,kimi", "--block", "kimi", "--tools", "--parallel", "--solo-calls", "4", "--parallel-calls", "5", "--max-cost-ore", "250", "--timeout-ms", "5000", "--out", "/tmp/x.json", "--db", "--tenant", "t-1", "--help"]);
    expect(o).toMatchObject({ providers: ["kimi", "hermes"], block: "kimi", tools: true, parallel: true, soloCalls: 4, parallelCalls: 5, maxCostOre: 250, timeoutMs: 5000, out: "/tmp/x.json", db: true, tenant: "t-1", help: true });
  });

  it("ukjent flagg, manglende verdi, løse argumenter og et flagg som verdi avvises (aldri en stille standard)", () => {
    for (const argv of [["--ukjent"], ["--out"], ["--out", "--tools"], ["kimi"], ["--providers"], ["--tools=1"]]) {
      expect(parseSmokeArgs(argv).ok, JSON.stringify(argv)).toBe(false);
    }
  });

  it("tall utenfor grensene eller ikke-heltall avvises", () => {
    for (const argv of [["--max-cost-ore", "0"], ["--max-cost-ore", "10001"], ["--max-cost-ore", "1.5"], ["--max-cost-ore", "-3"], ["--solo-calls", "1"], ["--solo-calls", "11"], ["--parallel-calls", "7"], ["--timeout-ms", "999"], ["--timeout-ms", "120001"], ["--max-cost-ore", "abc"]]) {
      expect(parseSmokeArgs(argv).ok, JSON.stringify(argv)).toBe(false);
    }
  });

  it("ukjente eller ugyldige leverandørnavn avvises i --providers og --block; også scripted og navn med spesialtegn", () => {
    for (const argv of [["--providers", "kimi,finnesikke"], ["--providers", "scripted"], ["--block", "../etc"], ["--block", "KIMI"], ["--providers", "kimi;rm"], ["--block", "scripted"]]) {
      expect(parseSmokeArgs(argv).ok, JSON.stringify(argv)).toBe(false);
    }
  });

  it("--out må ende på .json (ingen overskriving av vilkårlige filer), --tenant må ha gyldig format", () => {
    for (const argv of [["--out", "/etc/passwd"], ["--out", "evidens.txt"], ["--out", "a\0.json"], ["--tenant", "a b"], ["--tenant", "x".repeat(65)], ["--tenant", ""]]) {
      expect(parseSmokeArgs(argv).ok, JSON.stringify(argv)).toBe(false);
    }
  });

  it("alle kjente leverandører i kanonisk rekkefølge er gyldige", () => {
    expect(ok(["--providers", SMOKE_PROVIDER_ORDER.join(",")]).providers).toEqual([...SMOKE_PROVIDER_ORDER]);
  });
});

describe("redaktering og hemmelighetsvern", () => {
  it("redactErrorText: kode uendret, hemmeligheter/URL-er/linjeskift fjernet, kappet", () => {
    expect(redactErrorText(undefined)).toBeNull();
    expect(redactErrorText("  ")).toBeNull();
    expect(redactErrorText("kimi_auth_401")).toBe("kimi_auth_401");
    const out = redactErrorText(`feil\nhos https://api.example.test/x?key=${"c".repeat(20)} ${PLANTED_BEARER}`) ?? "";
    expect(out).not.toMatch(/a{16}|c{10}|https:\/\/|\n/);
    expect(out).toContain("[url]");
    expect(redactErrorText("x".repeat(400))).toHaveLength(120);
  });

  it("secretEnvNames: kun hemmelighetsliknende navn med verdi på minst 8 tegn - og aldri verdiene", () => {
    const names = secretEnvNames({ KIMI_API_KEY: "x".repeat(12), PATH: "/usr/bin", SHORT_TOKEN: "abc", JARVIS_DB_PASSWORD: "y".repeat(10), HERMES_API_KEY: "", OTHER: "z".repeat(20) });
    expect(names.sort()).toEqual(["JARVIS_DB_PASSWORD", "KIMI_API_KEY"]);
  });

  it("assertEvidenceHasNoSecrets: kaster på kjente nøkkelformater og på verdien av en hemmelighetsliknende miljøvariabel, uten å nevne verdien", () => {
    expect(() => assertEvidenceHasNoSecrets('{"verdikt":"PASS"}', { KIMI_API_KEY: "ikke-en-ekte-kimi-nokkel" })).not.toThrow();
    expect(() => assertEvidenceHasNoSecrets(`{"x":"${PLANTED_BEARER}"}`, {})).toThrow(/evidence_contains_secret:bearer_token/);
    let message = "";
    try {
      assertEvidenceHasNoSecrets('{"feil":"ugyldig ikke-en-ekte-kimi-nokkel brukt"}', { KIMI_API_KEY: "ikke-en-ekte-kimi-nokkel" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("evidence_contains_env_value:KIMI_API_KEY");
    expect(message).not.toContain("ikke-en-ekte-kimi-nokkel");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Fake adaptere
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const result = (provider: string, over: Partial<ModelResult> = {}): ModelResult => ({ text: "OK", usage: { input_tokens: 5, output_tokens: 1 }, provider, model: `${provider}-m`, finish_reason: "stop", ...over });

interface FakeOpts { available?: boolean; text?: string; fail?: ProviderError["kind"]; latency?: number; delay?: number; finish?: string; tool?: "ok" | "none" | "wrong" | "invalid" | "fail"; stream?: boolean; roundtrip?: "ok" | "empty" | "fail"; calls?: ModelRequest[] }
function fake(name: string, o: FakeOpts = {}): ModelProviderAdapter {
  const call = (req: ModelRequest, id: string): ToolCallRequest => ({ tool_call_id: id, tool_name: o.tool === "wrong" ? "annet_verktoy" : SMOKE_TOOL.name, arguments: { timezone: "Europe/Oslo" }, provider: name, model: `${name}-m` });
  const adapter: ModelProviderAdapter = {
    name, model: `${name}-m`, available: () => o.available ?? true,
    complete: async (req) => {
      o.calls?.push(req);
      if (o.delay) await new Promise((r) => setTimeout(r, o.delay));
      if (o.fail) throw new ProviderError(name, o.fail, `${name}_${o.fail}`);
      if (req.tools?.length) {
        if (req.tool_exchanges?.length) {
          if (o.roundtrip === "fail") throw new ProviderError(name, "server", `${name}_server`);
          return result(name, { text: o.roundtrip === "empty" ? "" : "klokka er tolv" });
        }
        if (o.tool === "fail") throw new ProviderError(name, "server", `${name}_server`);
        if (o.tool === "invalid") throw new ProviderError(name, "invalid_tool_call", `${name}_invalid_tool_call:unknown_tool`);
        if (o.tool === "none") return result(name, { text: "Klokka er tolv." });
        return result(name, { text: "", tool_calls: [call(req, "c1")], finish_reason: "tool_calls" });
      }
      return result(name, { text: o.text ?? "OK", ...(o.latency !== undefined ? { latency_ms: o.latency } : {}), ...(o.finish ? { finish_reason: o.finish } : {}) });
    }
  };
  if (o.stream) {
    adapter.stream = async (req, onEvent) => {
      const c = call(req, "s1");
      onEvent({ type: "start", provider: name, model: `${name}-m`, generation_id: "g" });
      onEvent({ type: "tool_call_start", tool_call_id: "s1", tool_name: c.tool_name });
      onEvent({ type: "tool_call_complete", call: c });
      onEvent({ type: "finish", finish_reason: "tool_calls" });
      return result(name, { text: "", tool_calls: [c], finish_reason: "tool_calls" });
    };
  }
  return adapter;
}
const meter = (cap = 1000) => new SmokeCostMeter(cap);

describe("probeProvider (fase 1)", () => {
  it("LIVE krever synlig tekst; tall og kost fra svaret", async () => {
    const r = await probeProvider(fake("kimi", { latency: 321 }), { pricing, registry, meter: meter() });
    expect(r).toMatchObject({ provider: "kimi", configured: true, status: "LIVE", latency_ms: 321, input_tokens: 5, output_tokens: 1, locality: "cloud", error_kind: null });
    expect(r.cost_ore).toBeGreaterThanOrEqual(0);
  });

  it("tomt svar er EMPTY_OUTPUT (transportsuksess er ikke live, D-106) og beholder finish_reason", async () => {
    const r = await probeProvider(fake("kimi", { text: "   ", finish: "length" }), { pricing, registry, meter: meter() });
    expect(r).toMatchObject({ status: "EMPTY_OUTPUT", finish_reason: "length" });
  });

  it("feil gir FAILED med klasse og redigert kode - kaster aldri", async () => {
    const r = await probeProvider(fake("kimi", { fail: "auth" }), { pricing, registry, meter: meter() });
    expect(r).toMatchObject({ status: "FAILED", error_kind: "auth", error_code: "kimi_auth" });
  });

  it("ikke-konfigurert: NOT_CONFIGURED uten kall; lokal leverandør klassifiseres som lokal", async () => {
    const calls: ModelRequest[] = [];
    const r = await probeProvider(fake("gemma_local", { available: false, calls }), { pricing, registry, meter: meter() });
    expect(r).toMatchObject({ configured: false, status: "NOT_CONFIGURED", locality: "local" });
    expect(calls).toHaveLength(0);
  });

  it("kostnadstaket stopper: når taket er nådd gjøres ingen flere kall (SKIPPED_COST_CAP)", async () => {
    const calls: ModelRequest[] = [];
    const m = meter(1);
    m.add(5);
    const r = await probeProvider(fake("kimi", { calls }), { pricing, registry, meter: m });
    expect(r.status).toBe("SKIPPED_COST_CAP");
    expect(calls).toHaveLength(0);
    expect(m.capHit).toBe(true);
  });

  it("sender en liten forespørsel med temperatur 0 og uten verktøy", async () => {
    const calls: ModelRequest[] = [];
    await probeProvider(fake("kimi", { calls }), { pricing, registry, meter: meter() });
    expect(calls[0]).toMatchObject({ temperature: 0, max_tokens: 256 });
    expect(calls[0]?.tools).toBeUndefined();
    expect(calls[0]?.messages).toHaveLength(1);
  });
});

describe("probeTools (fase 3)", () => {
  it("kall → rundtur → streaming: alt OK, og rundturen sender verktøyresultatet som tool_exchanges (med oppringerens eget kall)", async () => {
    const calls: ModelRequest[] = [];
    const r = await probeTools(fake("kimi", { stream: true, calls }), { pricing, meter: meter(), streaming: true, now: () => new Date("2026-10-15T12:00:00.000Z") });
    expect(r).toMatchObject({ provider: "kimi", call: "TOOL_CALL_OK", roundtrip: "ROUNDTRIP_OK", stream: "STREAM_TOOL_CALL_OK", error_codes: [] });
    const second = calls.find((c) => c.tool_exchanges?.length);
    expect(second?.tool_exchanges?.[0]?.calls[0]?.tool_call_id).toBe("c1");
    expect(second?.tool_exchanges?.[0]?.results[0]).toMatchObject({ tool_call_id: "c1", success: true, trust: "trusted", output: { now: "2026-10-15T12:00:00.000Z" } });
    expect(calls[0]?.tools?.map((t) => t.name)).toEqual([SMOKE_TOOL.name]);
  });

  it("modellen svarer med tekst i stedet for verktøy: NO_TOOL_CALL og ingen rundtur", async () => {
    const calls: ModelRequest[] = [];
    const r = await probeTools(fake("hermes", { tool: "none", calls }), { pricing, meter: meter(), streaming: false });
    expect(r).toMatchObject({ call: "NO_TOOL_CALL", roundtrip: "SKIPPED", stream: "SKIPPED" });
    expect(calls).toHaveLength(1);
  });

  it("ukjent verktøynavn er WRONG_TOOL - og utløser aldri en rundtur", async () => {
    const calls: ModelRequest[] = [];
    const r = await probeTools(fake("kimi", { tool: "wrong", calls }), { pricing, meter: meter(), streaming: false });
    expect(r).toMatchObject({ call: "WRONG_TOOL", roundtrip: "SKIPPED" });
    expect(calls).toHaveLength(1);
  });

  it("invalid_tool_call fra adapteren (Hermes-parseren) vises som INVALID_TOOL_CALL med redigert kode", async () => {
    const r = await probeTools(fake("hermes", { tool: "invalid" }), { pricing, meter: meter(), streaming: false });
    expect(r.call).toBe("INVALID_TOOL_CALL");
    expect(r.error_codes).toEqual(["hermes_invalid_tool_call:unknown_tool"]);
    expect(r.roundtrip).toBe("SKIPPED");
  });

  it("rundtur uten sluttekst er NO_FINAL_TEXT; rundtur som feiler er FAILED", async () => {
    expect((await probeTools(fake("kimi", { roundtrip: "empty" }), { pricing, meter: meter(), streaming: false })).roundtrip).toBe("NO_FINAL_TEXT");
    expect((await probeTools(fake("kimi", { roundtrip: "fail" }), { pricing, meter: meter(), streaming: false })).roundtrip).toBe("FAILED");
  });

  it("streaming hoppes over uten at registeret oppgir streaming (eller uten stream-metode)", async () => {
    expect((await probeTools(fake("hermes", { stream: true }), { pricing, meter: meter(), streaming: false })).stream).toBe("SKIPPED");
    expect((await probeTools(fake("hermes"), { pricing, meter: meter(), streaming: true })).stream).toBe("SKIPPED");
  });

  it("en strøm som leverer resultatet uten tool_call_complete-hendelse er FAILED (ikke OK)", async () => {
    const a = fake("kimi");
    a.stream = async (_req, onEvent) => {
      onEvent({ type: "finish", finish_reason: "tool_calls" });
      return result("kimi", { text: "", tool_calls: [{ tool_call_id: "s1", tool_name: SMOKE_TOOL.name, arguments: {}, provider: "kimi", model: "kimi-m" }] });
    };
    const r = await probeTools(a, { pricing, meter: meter(), streaming: true });
    expect(r.stream).toBe("FAILED");
    expect(r.error_codes.join(" ")).toContain("tool_call_complete");
  });

  it("kostnadstaket nådd før start: alt SKIPPED og ingen kall", async () => {
    const calls: ModelRequest[] = [];
    const m = meter(1);
    m.add(2);
    const r = await probeTools(fake("kimi", { calls }), { pricing, meter: m, streaming: true });
    expect(r).toMatchObject({ call: "SKIPPED", roundtrip: "SKIPPED", stream: "SKIPPED" });
    expect(calls).toHaveLength(0);
  });
});

describe("measureParallel / overheadOf (fase 4)", () => {
  it("overheadOf: p50 samtidig minus p50 alene; null med færre enn tre prøver", () => {
    expect(overheadOf([100, 200, 300], [500, 600, 700])).toEqual({ p50_solo: 200, p50_parallel: 600, overhead: 400 });
    expect(overheadOf([100, 200], [500, 600, 700]).overhead).toBeNull();
    expect(overheadOf([], []).p50_solo).toBeNull();
  });

  it("kjører N alene og M samtidige kall med lik forespørsel og teller prøvene", async () => {
    const calls: ModelRequest[] = [];
    const r = await measureParallel(fake("kimi", { calls, delay: 5 }), { pricing, meter: meter(), soloCalls: 3, parallelCalls: 4 });
    expect(calls).toHaveLength(7);
    expect(new Set(calls.map((c) => JSON.stringify(c))).size).toBe(1);
    expect(r).toMatchObject({ provider: "kimi", solo_samples: 3, parallel_samples: 4, failed_calls: 0 });
    expect(r.overhead_ms).not.toBeNull();
  });

  it("med bare to samtidige prøver er overhead ukjent og notatet sier hvorfor", async () => {
    const r = await measureParallel(fake("kimi"), { pricing, meter: meter(), soloCalls: 3, parallelCalls: 2 });
    expect(r.overhead_ms).toBeNull();
    expect(r.note).toContain("for få vellykkede prøver");
  });

  it("feilede og tomme svar teller som feil, ikke som prøver", async () => {
    const r = await measureParallel(fake("kimi", { fail: "server" }), { pricing, meter: meter(), soloCalls: 2, parallelCalls: 2 });
    expect(r).toMatchObject({ solo_samples: 0, parallel_samples: 0, failed_calls: 4, overhead_ms: null });
  });

  it("kostnadstaket stopper midt i måleserien", async () => {
    const calls: ModelRequest[] = [];
    const m = meter(1);
    const a = fake("kimi", { calls });
    const original = a.complete.bind(a);
    a.complete = async (req, onToken) => { const out = await original(req, onToken); m.add(5); return out; };
    const r = await measureParallel(a, { pricing, meter: m, soloCalls: 3, parallelCalls: 3 });
    expect(calls).toHaveLength(1);
    expect(r.note).toBe("stoppet av kostnadstaket");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Fallback og sensitivitetsport mot den ekte ModelGateway
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe("fallbackChain / defaultBlocked", () => {
  it("den sperrede først, så øvrige live i kanonisk rekkefølge (uavhengig av innsendt rekkefølge)", () => {
    expect(fallbackChain(["hermes", "kimi", "gemma_local", "anthropic"], "kimi")).toEqual(["kimi", "gemma_local", "hermes", "anthropic"]);
    expect(defaultBlocked(["hermes", "anthropic", "gemma_local"])).toBe("gemma_local");
    expect(defaultBlocked(["openai", "kimi"])).toBe("kimi");
    expect(defaultBlocked([])).toBeNull();
  });
});

function gatewayFor(providers: ModelProviderAdapter[], pool: pg.Pool = inMemoryCostPool().pool): ModelGateway {
  return new ModelGateway({ pool, trace: new MemoryTraceSink(), providers });
}

describe("runFallbackCheck (ekte ModelGateway, én leverandør sperret)", () => {
  it("PROVEN: den sperrede forsøkes, en annen svarer, og svaret er merket som fallback", async () => {
    const blockedAdapter = new BlockedAdapter(fake("gemma_local"));
    const chain = ["gemma_local", "kimi", "hermes"];
    const gateway = gatewayFor([blockedAdapter, fake("kimi"), fake("hermes")]);
    const r = await runFallbackCheck({ gateway, blocked: "gemma_local", chain, blockedAdapter, tenantId: "t1", taskId: "smoke-1" });
    expect(r).toMatchObject({ status: "PROVEN", blocked: "gemma_local", served_by: "kimi", fallback_from: ["gemma_local"], gateway_state: "VERIFIED", reason: null });
    expect(r.blocked_attempts).toBeGreaterThan(0);
  });

  it("kostraden hentes ut: pool-innsettingen har fallback=true og provider = reserven", async () => {
    const { pool, inserts } = inMemoryCostPool();
    const blockedAdapter = new BlockedAdapter(fake("gemma_local"));
    const gateway = gatewayFor([blockedAdapter, fake("kimi")], pool);
    await runFallbackCheck({ gateway, blocked: "gemma_local", chain: ["gemma_local", "kimi"], blockedAdapter, tenantId: "t1", taskId: "smoke-2" });
    const row = inserts.find((p) => p[3] === "model:kimi");
    expect(row?.[2]).toBe("smoke-2");
    expect(row?.[11]).toBe(true);
  });

  it("--db: manglende kostrad (null) er IKKE bevist; fallback=false er IKKE bevist; true er bevist", async () => {
    const make = () => { const b = new BlockedAdapter(fake("gemma_local")); return { b, gateway: gatewayFor([b, fake("kimi")]) }; };
    for (const [row, status, reason] of [[null, "NOT_PROVEN", /ble ikke funnet/], [false, "NOT_PROVEN", /mangler fallback-flagget/], [true, "PROVEN", null]] as const) {
      const { b, gateway } = make();
      const r = await runFallbackCheck({ gateway, blocked: "gemma_local", chain: ["gemma_local", "kimi"], blockedAdapter: b, tenantId: "t1", taskId: "s", readCostRowFallback: async () => row });
      expect(r.status).toBe(status);
      if (reason) expect(r.reason).toMatch(reason);
      else expect(r.cost_row_fallback).toBe(true);
    }
  });

  it("NOT_PROVEN når reserven også feiler (ingen falsk PASS) - med feilklasse i årsaken", async () => {
    const blockedAdapter = new BlockedAdapter(fake("gemma_local"));
    const gateway = gatewayFor([blockedAdapter, fake("kimi", { fail: "auth" })]);
    const r = await runFallbackCheck({ gateway, blocked: "gemma_local", chain: ["gemma_local", "kimi"], blockedAdapter, tenantId: "t1", taskId: "s" });
    expect(r.status).toBe("NOT_PROVEN");
    expect(r.reason).toContain("kallet feilet");
  });

  it("NOT_PROVEN når den sperrede aldri ble forsøkt (kjeden startet ikke med den)", async () => {
    const blockedAdapter = new BlockedAdapter(fake("gemma_local"));
    const gateway = gatewayFor([blockedAdapter, fake("kimi")]);
    const r = await runFallbackCheck({ gateway, blocked: "gemma_local", chain: ["kimi", "gemma_local"], blockedAdapter, tenantId: "t1", taskId: "s" });
    expect(r.status).toBe("NOT_PROVEN");
    expect(r.reason).toMatch(/aldri forsøkt/);
  });

  it("BlockedAdapter rører aldri den indre adapteren og teller forsøk", async () => {
    const calls: ModelRequest[] = [];
    const inner = fake("kimi", { calls });
    const blocked = new BlockedAdapter(inner);
    await expect(blocked.complete()).rejects.toMatchObject({ kind: "network", provider: "kimi" });
    await expect(blocked.stream()).rejects.toMatchObject({ kind: "network" });
    expect(blocked.attempts).toBe(2);
    expect(calls).toHaveLength(0);
    expect(blocked.available()).toBe(true);
    expect(new BlockedAdapter(fake("x", { available: false })).available()).toBe(false);
  });
});

describe("runSensitivityGateCheck (SECRET_RESTRICTED, frakoblet)", () => {
  const makeGateway = (providers: ModelProviderAdapter[]) => gatewayFor(providers);

  it("PASS: med lokal leverandør konfigurert besvares kallet lokalt og ingen skyleverandør kalles - selv om skyen står først i kjeden", async () => {
    const adapters = [fake("anthropic"), fake("kimi"), fake("hermes"), fake("gemma_local")];
    const r = await runSensitivityGateCheck({ adapters, registry, makeGateway, tenantId: "t1" });
    expect(r).toMatchObject({ status: "PASS", outcome: "SERVED_LOCAL", cloud_calls: 0 });
    expect(r.local_calls).toBeGreaterThan(0);
    expect(r.chain.slice(0, 3).sort()).toEqual(["anthropic", "hermes", "kimi"]); // verste tilfelle: sky først
  });

  it("PASS: uten lokal leverandør avvises kallet (REFUSED), fortsatt uten skykall", async () => {
    const r = await runSensitivityGateCheck({ adapters: [fake("anthropic"), fake("kimi")], registry, makeGateway, tenantId: "t1" });
    expect(r).toMatchObject({ status: "PASS", outcome: "REFUSED", cloud_calls: 0, local_calls: 0 });
  });

  it("FAIL hvis en gateway noensinne kaller en skyleverandør for SECRET_RESTRICTED (porten er brutt)", async () => {
    const leaky = (providers: ModelProviderAdapter[]) => ({
      complete: async () => {
        // simulerer en ødelagt port: kaller en sky-tripwire direkte
        const cloud = providers.find((p) => p.name === "kimi") as ModelProviderAdapter;
        return cloud.complete({ messages: [{ role: "user", content: "x" }] });
      }
    });
    const r = await runSensitivityGateCheck({ adapters: [fake("kimi"), fake("gemma_local")], registry, makeGateway: leaky, tenantId: "t1" });
    expect(r.status).toBe("FAIL");
    expect(r.cloud_calls).toBeGreaterThan(0);
    expect(r.detail).toContain("skyleverandør");
  });

  it("SKIPPED uten konfigurerte leverandører", async () => {
    const r = await runSensitivityGateCheck({ adapters: [fake("kimi", { available: false })], registry, makeGateway, tenantId: "t1" });
    expect(r.status).toBe("SKIPPED");
  });

  it("stubbene rører aldri de ekte adapterne (ingen nettkall)", async () => {
    const calls: ModelRequest[] = [];
    await runSensitivityGateCheck({ adapters: [fake("anthropic", { calls }), fake("gemma_local", { calls })], registry, makeGateway, tenantId: "t1" });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Verdikt og sammendrag
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const probe = (provider: string, status: SmokeProbeRecord["status"] = "LIVE", over: Partial<SmokeProbeRecord> = {}): SmokeProbeRecord => ({
  provider, model: `${provider}-m`, locality: provider.startsWith("gemma_l") ? "local" : "cloud", configured: status !== "NOT_CONFIGURED", status,
  latency_ms: status === "LIVE" ? 400 : null, input_tokens: status === "LIVE" ? 5 : null, output_tokens: status === "LIVE" ? 1 : null, cost_ore: status === "LIVE" ? 1 : null, finish_reason: null, error_kind: null, error_code: null, ...over
});
const proven: SmokeFallbackCheck = { status: "PROVEN", blocked: "gemma_local", chain: ["gemma_local", "kimi"], served_by: "kimi", fallback_from: ["gemma_local"], blocked_attempts: 2, gateway_state: "VERIFIED", cost_row_fallback: null, reason: null };
const gatePass: SmokeGateCheck = { status: "PASS", outcome: "SERVED_LOCAL", chain: [], cloud_calls: 0, local_calls: 1, detail: null };
const gateFail: SmokeGateCheck = { ...gatePass, status: "FAIL", outcome: "SERVED_CLOUD", cloud_calls: 1, detail: "SECRET_RESTRICTED nådde en skyleverandør" };

describe("evaluateSmoke", () => {
  const three = [probe("gemma_local"), probe("kimi"), probe("hermes")];

  it("PASS: tre live, fallback bevist, porten holdt", () => {
    const e = evaluateSmoke({ probes: three, fallback: proven, gate: gatePass, costCapHit: false });
    expect(e).toMatchObject({ verdict: "PASS", reasons: [], live: ["gemma_local", "kimi", "hermes"] });
  });

  it("FAIL: tre konfigurert, men bare to live - sier hvilken som feilet og hvorfor", () => {
    const e = evaluateSmoke({ probes: [probe("gemma_local"), probe("kimi"), probe("hermes", "FAILED", { error_kind: "auth" })], fallback: proven, gate: gatePass, costCapHit: false });
    expect(e.verdict).toBe("FAIL");
    expect(e.reasons.join(" ")).toContain("hermes=FAILED(auth)");
  });

  it("INCOMPLETE (ikke FAIL): færre enn tre konfigurerte - eieren må legge inn nøkler", () => {
    const e = evaluateSmoke({ probes: [probe("gemma_local"), probe("kimi"), probe("hermes", "NOT_CONFIGURED")], fallback: proven, gate: gatePass, costCapHit: false });
    expect(e.verdict).toBe("INCOMPLETE");
    expect(e.reasons.join(" ")).toContain("Bare 2 konfigurerte");
  });

  it("FAIL: tre live uten bevist fallback (aldri PASS uten fallback)", () => {
    for (const fb of [{ ...proven, status: "NOT_PROVEN" as const, reason: "reserven feilet" }, { ...SKIPPED_FALLBACK }]) {
      const e = evaluateSmoke({ probes: three, fallback: fb, gate: gatePass, costCapHit: false });
      expect(e.verdict, fb.status).not.toBe("PASS");
    }
    expect(evaluateSmoke({ probes: three, fallback: { ...proven, status: "NOT_PROVEN", reason: "x" }, gate: gatePass, costCapHit: false }).verdict).toBe("FAIL");
  });

  it("SIKKERHET: brutt sensitivitetsport gir FAIL uansett hvor mange som er live", () => {
    const e = evaluateSmoke({ probes: three, fallback: proven, gate: gateFail, costCapHit: false });
    expect(e.verdict).toBe("FAIL");
    expect(e.reasons[0]).toContain("SIKKERHET");
    // også når for få er konfigurert: sikkerhetsbruddet maskeres ikke av INCOMPLETE
    expect(evaluateSmoke({ probes: [probe("kimi")], fallback: SKIPPED_FALLBACK, gate: gateFail, costCapHit: false }).verdict).toBe("FAIL");
  });

  it("INCOMPLETE når kostnadstaket stoppet kjøringen - aldri PASS", () => {
    const e = evaluateSmoke({ probes: [probe("gemma_local"), probe("kimi"), probe("hermes", "SKIPPED_COST_CAP")], fallback: proven, gate: gatePass, costCapHit: true });
    expect(e.verdict).toBe("INCOMPLETE");
    expect(e.reasons.join(" ")).toContain("Kostnadstaket");
  });

  it("EMPTY_OUTPUT teller ikke som live", () => {
    const e = evaluateSmoke({ probes: [probe("gemma_local"), probe("kimi"), probe("hermes", "EMPTY_OUTPUT")], fallback: proven, gate: gatePass, costCapHit: false });
    expect(e.live).toEqual(["gemma_local", "kimi"]);
    expect(e.verdict).toBe("FAIL");
  });

  it("merknad om delt leverandør når både gemini og gemma_hosted er live", () => {
    const e = evaluateSmoke({ probes: [probe("gemini"), probe("gemma_hosted"), probe("kimi")], fallback: proven, gate: gatePass, costCapHit: false });
    expect(e.verdict).toBe("PASS");
    expect(e.notes.join(" ")).toContain("samme leverandør (Google)");
  });
});

describe("renderSmokeSummaryNo", () => {
  it("viser verdikt, leverandører, fallback, porten og kost - uten hemmeligheter", () => {
    const ev: SmokeEvidence = {
      schema: "jarvis.mesh-smoke/1", started_at: "2026-10-15T12:00:00.000Z", finished_at: "2026-10-15T12:00:05.000Z", node: "v22.0.0", mode: "no_db",
      options: { providers: null, block: null, tools: false, parallel: false, max_cost_ore: 100, timeout_ms: 30_000, tenant: null },
      providers: [probe("gemma_local"), probe("kimi"), probe("hermes", "FAILED", { error_kind: "auth", error_code: "hermes_auth" }), probe("openai", "NOT_CONFIGURED")],
      fallback: proven, sensitivity_gate: gatePass,
      tools: [{ provider: "kimi", call: "TOOL_CALL_OK", roundtrip: "ROUNDTRIP_OK", stream: "STREAM_TOOL_CALL_OK", error_codes: [], cost_ore: 2 }],
      parallel: [{ provider: "kimi", solo_samples: 3, parallel_samples: 3, p50_solo_ms: 300, p50_parallel_ms: 450, overhead_ms: 150, failed_calls: 0, note: null }],
      cost: { spent_ore: 4, cap_ore: 100, cap_hit: false }, live_providers: ["gemma_local", "kimi"], verdict: "FAIL", reasons: ["Bare 2 av 3 nødvendige leverandører er live."], notes: []
    };
    const text = renderSmokeSummaryNo(ev);
    expect(text).toContain("røyktest (uten database): FAIL");
    expect(text).toContain("hermes       sky    FAILED - auth hermes_auth");
    expect(text).toContain("openai       sky    IKKE KONFIGURERT");
    expect(text).toContain("fallback: PROVEN (gemma_local sperret → svart av kimi)");
    expect(text).toContain("sensitivitetsport (SECRET_RESTRICTED): PASS (SERVED_LOCAL, skykall 0)");
    expect(text).toContain("verktøy kimi: kall=TOOL_CALL_OK rundtur=ROUNDTRIP_OK streaming=STREAM_TOOL_CALL_OK");
    expect(text).toContain("overhead +150 ms");
    expect(text).toContain("kostnad: 4 av 100 øre");
    expect(text).toContain("- Bare 2 av 3");
  });
});

describe("inMemoryCostPool", () => {
  it("svarer på budsjettspørringen og samler innsettinger uten å røre en database", async () => {
    const { pool, inserts } = inMemoryCostPool();
    const client = await pool.connect();
    expect((await client.query("SELECT coalesce(sum(amount_ore),0) FROM cost_events")).rows[0]).toEqual({ spent: 0 });
    await client.query("INSERT INTO cost_events (a) VALUES ($1)", ["x"]);
    expect(inserts).toEqual([["x"]]);
    client.release();
  });
});

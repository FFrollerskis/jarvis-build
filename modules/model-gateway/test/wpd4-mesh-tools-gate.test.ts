import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { ProviderError, type ModelProviderAdapter, type ModelResult, type StreamEvent } from "@jarvis/provider-adapters";
import {
  AiRouter,
  CapabilityRegistry,
  DEFAULT_PROFILES,
  MemoryTraceSink,
  ModelGateway,
  NoEligibleProviderError,
  ProviderHealthTracker,
  meshToolsVerifiedFromEnv,
  parseMeshToolsVerified,
  type ToolExecutor
} from "../src/index.ts";

/**
 * WP-D4 (gjennomgang av PR #315, M3): Kimi og Hermes påstår `tool_calling` (Kimi også `streaming`) i registeret, men det er bare bevist mot fake servere. AUTO-ruting skal derfor IKKE velge dem til verktøyløkker (eller Kimi til
 * streaming-reserve) før eieren har kjørt `mesh-live-smoke.ts --tools` og erklært det med `JARVIS_MESH_TOOLS_VERIFIED=<leverandør>`. Eksplisitte valg (`provider`, `providerPreference`/`JARVIS_CHAT_CANDIDATES`) påvirkes ikke, og
 * erklæringen åpner aldri en annen port (sensitivitet, betaling, LOCAL, helse).
 */
const MODELS: Record<string, string> = {
  gemma_local: "gemma-local", gemma_hosted: "gemma-4-26b-a4b-it", anthropic: "claude-sonnet-5-5", openai: "gpt-5", kimi: "kimi-k3", hermes: "Hermes-4-70B"
};
const ALL = Object.keys(MODELS);
const runtimes = (configured: string[] = ALL) => new Map(ALL.map((n) => [n, { configured: configured.includes(n), model: MODELS[n] as string }]));
const router = (verified: string[] = []) => new AiRouter(new CapabilityRegistry(), new ProviderHealthTracker(), new Set(verified));
const order = (r: AiRouter, input: Parameters<AiRouter["plan"]>[0], configured?: string[]) => r.plan(input, runtimes(configured)).candidates.map((c) => c.provider);
const TOOLS = { required_capabilities: ["tool_calling" as const] };

describe("registeret påstår fortsatt støtten - AUTO bruker den bare på eierens erklæring", () => {
  const profile = (name: string) => DEFAULT_PROFILES.find((p) => p.provider === name);
  it("kimi: påstår tool_calling + streaming og markerer dem uverifisert; hermes: tool_calling; ingen andre profiler er markert", () => {
    expect(profile("kimi")?.capabilities).toEqual(expect.arrayContaining(["tool_calling", "streaming"]));
    expect(profile("kimi")?.live_unverified).toEqual(["tool_calling", "streaming"]);
    expect(profile("hermes")?.capabilities).toContain("tool_calling");
    expect(profile("hermes")?.live_unverified).toEqual(["tool_calling"]);
    expect(DEFAULT_PROFILES.filter((p) => (p.live_unverified ?? []).length > 0).map((p) => p.provider).sort()).toEqual(["hermes", "kimi"]);
  });
});

describe("AUTO-ruting for verktøyløkker (reviewerens rekkefølger)", () => {
  it("BACKGROUND/PRIVATE: uten erklæring velges aldri kimi/hermes; rekkefølgen er den etablerte uten dem", () => {
    const input = { ...TOOLS, purpose: "BACKGROUND" as const, sensitivity: "PRIVATE" as const };
    const established = order(router(["kimi", "hermes"]), input);
    expect(established).toContain("kimi");
    expect(established).toContain("hermes");
    expect(established.indexOf("hermes")).toBeLessThan(established.indexOf("openai")); // reviewerens funn: høyere enn openai/anthropic
    const gated = order(router(), input);
    expect(gated).not.toContain("kimi");
    expect(gated).not.toContain("hermes");
    expect(gated).toEqual(established.filter((p) => p !== "kimi" && p !== "hermes"));
    expect(gated).toEqual(["gemma_local", "openai", "anthropic"]);
  });

  it("CHAT/PRIVATE: samme - kimi (som sist i rekkefølgen) og hermes er borte uten erklæring", () => {
    const input = { ...TOOLS, purpose: "CHAT" as const, sensitivity: "PRIVATE" as const };
    const established = order(router(["kimi", "hermes"]), input);
    const gated = order(router(), input);
    expect(established).toEqual(expect.arrayContaining(["kimi", "hermes"]));
    expect(gated).toEqual(established.filter((p) => p !== "kimi" && p !== "hermes"));
    expect(gated).toEqual(["gemma_local", "openai", "anthropic"]);
  });

  it("erklæringen er per leverandør: kun kimi erklært → kimi inn, hermes fortsatt ute (og omvendt)", () => {
    const input = { ...TOOLS, purpose: "BACKGROUND" as const, sensitivity: "PRIVATE" as const };
    const onlyKimi = order(router(["kimi"]), input);
    expect(onlyKimi).toContain("kimi");
    expect(onlyKimi).not.toContain("hermes");
    const onlyHermes = order(router(["hermes"]), input);
    expect(onlyHermes).toContain("hermes");
    expect(onlyHermes).not.toContain("kimi");
  });

  it("med erklæring settes de inn igjen på sine etablerte plasser; en erklæring for en ukjent leverandør gjør ingenting", () => {
    const input = { ...TOOLS, purpose: "BACKGROUND" as const, sensitivity: "PRIVATE" as const };
    const withBoth = order(router(["kimi", "hermes"]), input);
    expect(order(router(["kimi", "hermes", "ukjent_leverandor"]), input)).toEqual(withBoth);
    expect(order(router(["ukjent_leverandor"]), input)).toEqual(order(router(), input));
  });

  it("uten verktøykrav er rekkefølgen UENDRET av porten: kimi/hermes kan fortsatt velges til vanlig tekst", () => {
    const input = { purpose: "BACKGROUND" as const, sensitivity: "PRIVATE" as const };
    expect(order(router(), input)).toEqual(order(router(["kimi", "hermes"]), input));
    expect(order(router(), input)).toEqual(expect.arrayContaining(["kimi", "hermes"]));
  });

  it("streaming: kimi er ikke siste reserve for PRIVATE streaming-chat uten erklæring (og kommer inn igjen med den)", () => {
    const input = { required_capabilities: ["streaming" as const], purpose: "CHAT" as const, sensitivity: "PRIVATE" as const };
    expect(order(router(), input)).not.toContain("kimi");
    expect(order(router(["kimi"]), input)).toContain("kimi");
    expect(order(router(["kimi"]), input)).toEqual([...order(router(), input), "kimi"]); // etablert plass: sist
    // hermes påstår ikke streaming, så en erklæring for hermes endrer ingenting her
    expect(order(router(["hermes"]), input)).toEqual(order(router(), input));
  });

  it("kun kimi konfigurert, ingen erklæring: NoEligibleProviderError som NAVNGIR hvorfor og hva eieren gjør (ikke en generisk «ingen provider»)", () => {
    expect(() => router().plan({ ...TOOLS }, runtimes(["kimi"]))).toThrow(NoEligibleProviderError);
    expect(() => router().plan({ ...TOOLS }, runtimes(["kimi"]))).toThrow(/ikke live-verifisert.*kimi:tool_calling.*JARVIS_MESH_TOOLS_VERIFIED/);
    expect(() => router().plan({ ...TOOLS }, runtimes(["hermes", "kimi"]))).toThrow(/(kimi:tool_calling, hermes:tool_calling|hermes:tool_calling, kimi:tool_calling)/);
    expect(order(router(["kimi"]), { ...TOOLS }, ["kimi"])).toEqual(["kimi"]);
    // tekst uten verktøy: kimi alene er fortsatt kvalifisert
    expect(order(router(), {}, ["kimi"])).toEqual(["kimi"]);
  });

  it("D-404-omkjøringen (excludeProviders) og bakgrunnsjobber følger samme port: kjeden er forsøkt, kimi/hermes velges ikke på tillit", () => {
    const rerun = { ...TOOLS, purpose: "CHAT" as const, sensitivity: "PRIVATE" as const, excludeProviders: ["gemma_local", "gemma_hosted"] };
    expect(order(router(), rerun)).toEqual(["openai", "anthropic"]);
    expect(order(router(["hermes", "kimi"]), rerun)).toEqual(expect.arrayContaining(["hermes", "kimi", "openai", "anthropic"]));
    // alt annet er forsøkt, bare uverifisert kimi/hermes igjen → feil (samtalemotoren kaster da den OPPRINNELIGE feilen), aldri et stille valg av kimi/hermes
    expect(() => router().plan({ ...rerun, excludeProviders: ["gemma_local", "gemma_hosted", "openai", "anthropic"] }, runtimes())).toThrow(/already_attempted/);
  });
});

describe("eierens eksplisitte valg påvirkes ikke", () => {
  it("eksakt provider (kimi/hermes) med tool_calling/streaming → valgt som før", () => {
    expect(order(router(), { provider: "kimi", ...TOOLS })).toEqual(["kimi"]);
    expect(order(router(), { provider: "hermes", ...TOOLS })).toEqual(["hermes"]);
    expect(order(router(), { provider: "kimi", required_capabilities: ["streaming"] })).toEqual(["kimi"]);
  });

  it("providerPreference / JARVIS_CHAT_CANDIDATES (med failover) tar kimi/hermes i listerekkefølge, også uten erklæring", () => {
    expect(order(router(), { providerPreference: ["kimi", "hermes", "anthropic"], preferenceFailover: true, ...TOOLS })).toEqual(["kimi", "hermes", "anthropic"]);
    expect(order(router(), { providerPreference: ["kimi"], preferenceFailover: true, required_capabilities: ["streaming"] })).toEqual(["kimi"]);
  });
});

describe("erklæringen åpner aldri en annen port", () => {
  it("SECRET_RESTRICTED: kimi/hermes er sky og forblir ute selv når de er erklært", () => {
    const input = { ...TOOLS, sensitivity: "SECRET_RESTRICTED" as const };
    expect(order(router(["kimi", "hermes"]), input)).toEqual(["gemma_local"]);
  });
  it("paid_models_allowed=false og mode LOCAL: kun lokale, uansett erklæring", () => {
    expect(order(router(["kimi", "hermes"]), { ...TOOLS, paid_models_allowed: false })).toEqual(["gemma_local"]);
    expect(order(router(["kimi", "hermes"]), { ...TOOLS, mode: "LOCAL" })).toEqual(["gemma_local"]);
  });
  it("helse: en UNAVAILABLE leverandør er fortsatt ute selv når den er erklært", () => {
    const health = new ProviderHealthTracker();
    for (let i = 0; i < 3; i++) health.recordFailure("hermes", "network", "hermes_network");
    const r = new AiRouter(new CapabilityRegistry(), health, new Set(["hermes", "kimi"]));
    const got = r.plan({ ...TOOLS, purpose: "BACKGROUND", sensitivity: "PRIVATE" }, runtimes()).candidates.map((c) => c.provider);
    expect(got).toContain("kimi");
    expect(health.state("hermes", true)).toBe("UNAVAILABLE");
    expect(got).not.toContain("hermes");
  });
});

describe("parseMeshToolsVerified / meshToolsVerifiedFromEnv (fail-closed)", () => {
  it.each([[undefined], [""], ["   "]])("usatt/tom (%j) = ingen erklært, gyldig", (raw) => {
    expect(parseMeshToolsVerified(raw)).toEqual({ providers: new Set(), valid: true });
  });
  it("kommaliste med mellomrom parses; duplikater slås sammen", () => {
    expect([...parseMeshToolsVerified("kimi").providers]).toEqual(["kimi"]);
    expect([...parseMeshToolsVerified(" kimi , hermes ").providers]).toEqual(["kimi", "hermes"]);
    expect([...parseMeshToolsVerified("kimi,kimi").providers]).toEqual(["kimi"]);
  });
  it.each([["Kimi"], ["kimi,"], [",kimi"], ["kimi,,hermes"], ["kimi;hermes"], ["kimi hermes"], ["1kimi"], ["kimi-x"], ["kimi/../x"], ["*"], ["on,"], [`a${"b".repeat(40)}`], [Array.from({ length: 17 }, (_, i) => `p${i}`).join(",")]])(
    "ugyldig verdi %j gir TOM liste (aldri en halvparset) og valid=false",
    (raw) => {
      const parsed = parseMeshToolsVerified(raw);
      expect(parsed.valid).toBe(false);
      expect(parsed.providers.size).toBe(0);
    }
  );
  it("«on»/«true» er syntaktisk gyldige NAVN (ingen leverandør heter det): aksepteres, men aktiverer ingenting", () => {
    expect([...parseMeshToolsVerified("on").providers]).toEqual(["on"]);
    expect(order(router(["on", "true"]), { ...TOOLS, purpose: "BACKGROUND", sensitivity: "PRIVATE" })).toEqual(["gemma_local", "openai", "anthropic"]);
  });
  it("fra miljøet: ugyldig verdi → tom liste + én logglinje uten selve verdien; gyldig → lista", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect([...meshToolsVerifiedFromEnv({ JARVIS_MESH_TOOLS_VERIFIED: "Kimi; DROP" })]).toEqual([]);
    expect(err).toHaveBeenCalledTimes(1);
    const line = String(err.mock.calls[0]?.[0]);
    expect(line).toContain("mesh_tools_verified_invalid");
    expect(line).not.toContain("DROP");
    expect([...meshToolsVerifiedFromEnv({ JARVIS_MESH_TOOLS_VERIFIED: "kimi,hermes" })]).toEqual(["kimi", "hermes"]);
    expect([...meshToolsVerifiedFromEnv({})]).toEqual([]);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

// --- gjennom en EKTE ModelGateway ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }),
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}
const reply = (provider: string): ModelResult => ({ text: `svar fra ${provider}`, usage: { input_tokens: 5, output_tokens: 5 }, provider, model: MODELS[provider] ?? "m", finish_reason: "stop" });
function stub(name: string, calls: string[], failWith?: ProviderError["kind"]): ModelProviderAdapter {
  const run = (): ModelResult => {
    calls.push(name);
    if (failWith) throw new ProviderError(name, failWith, `${name}_${failWith}`);
    return reply(name);
  };
  return {
    name, model: MODELS[name] ?? "m", available: () => true,
    complete: async () => run(),
    stream: async (_req, onEvent: (e: StreamEvent) => void) => {
      const r = run();
      onEvent({ type: "start", provider: name, model: r.model, generation_id: "g" });
      onEvent({ type: "text_delta", text: r.text });
      onEvent({ type: "finish", finish_reason: "stop" });
      return r;
    }
  };
}
const executor: ToolExecutor = { execute: async () => { throw new Error("skal ikke kjøres"); } };
const WEATHER = { name: "get_weather", description: "Hent været", input_schema: { type: "object" as const, properties: {}, additionalProperties: false } };
const base = { tenant_id: "t1", purpose: "BACKGROUND" as const, sensitivity: "PRIVATE" as const, request: { messages: [{ role: "user" as const, content: "hei" }] } };

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("ModelGateway.completeWithTools (bakgrunnsjobber og D-404-omkjøringen går hit)", () => {
  const providers = (calls: string[]) => ["hermes", "kimi", "openai", "anthropic"].map((n) => stub(n, calls));

  it("uten erklæring betjenes løkka av openai - kimi og hermes får aldri et kall", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: providers(calls) });
    const out = await gateway.completeWithTools(base, { tools: [WEATHER], executor });
    expect(out.provider).toBe("openai");
    expect(calls).toEqual(["openai"]);
  });

  it("med meshToolsVerified: hermes tar løkka (den etablerte plassen over openai/anthropic)", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: providers(calls), meshToolsVerified: ["hermes", "kimi"] });
    const out = await gateway.completeWithTools(base, { tools: [WEATHER], executor });
    expect(out.provider).toBe("hermes");
    expect(calls).toEqual(["hermes"]);
  });

  it("kun erklært kimi: hermes hoppes fortsatt over", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: providers(calls), meshToolsVerified: ["kimi"] });
    const out = await gateway.completeWithTools(base, { tools: [WEATHER], executor });
    expect(["kimi", "openai"]).toContain(out.provider);
    expect(calls).not.toContain("hermes");
  });

  it("JARVIS_MESH_TOOLS_VERIFIED i miljøet er standardkilden (samme i api og worker): satt = erklært, usatt = ikke, ugyldig = ikke", async () => {
    const run = async (value: string | undefined) => {
      if (value === undefined) vi.stubEnv("JARVIS_MESH_TOOLS_VERIFIED", ""); else vi.stubEnv("JARVIS_MESH_TOOLS_VERIFIED", value);
      const calls: string[] = [];
      const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: providers(calls) });
      await gateway.completeWithTools(base, { tools: [WEATHER], executor });
      return calls;
    };
    expect(await run(undefined)).toEqual(["openai"]);
    expect(await run("hermes")).toEqual(["hermes"]);
    expect(await run("Hermes")).toEqual(["openai"]); // ugyldig (stor bokstav) = tom liste
    // en eksplisitt tom liste i konstruktøren vinner over miljøet
    vi.stubEnv("JARVIS_MESH_TOOLS_VERIFIED", "hermes");
    const calls: string[] = [];
    const gw = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: providers(calls), meshToolsVerified: [] });
    await gw.completeWithTools(base, { tools: [WEATHER], executor });
    expect(calls).toEqual(["openai"]);
  });

  it("kun kimi konfigurert og uerklært: løkka feiler lukket med NoEligibleProviderError, og kimi får ikke et eneste kall", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [stub("kimi", calls)] });
    await expect(gateway.completeWithTools(base, { tools: [WEATHER], executor })).rejects.toThrow(/ikke live-verifisert/);
    expect(calls).toEqual([]);
  });

  it("eksplisitt provider: «bruk Kimi» virker uten erklæring", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: providers(calls) });
    const out = await gateway.completeWithTools({ ...base, provider: "kimi" }, { tools: [WEATHER], executor });
    expect(out.provider).toBe("kimi");
    expect(calls).toEqual(["kimi"]);
  });
});

describe("ModelGateway.stream: Kimi som siste reserve for PRIVATE streaming-chat", () => {
  const chat = { ...base, purpose: "CHAT" as const };
  it("uten erklæring: når openai feiler er kimi IKKE reserven - feilen kastes og kimi får ikke et kall", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [stub("openai", calls, "auth"), stub("kimi", calls)], meshToolsVerified: [] });
    await expect(gateway.stream(chat, () => undefined)).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toEqual(["openai"]);
  });

  it("med erklæring for kimi er den reserven som før (openai feiler → kimi svarer)", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [stub("openai", calls, "auth"), stub("kimi", calls)], meshToolsVerified: ["kimi"] });
    const out = await gateway.stream(chat, () => undefined);
    expect(out.provider).toBe("kimi");
    expect(calls).toEqual(["openai", "kimi"]);
  });

  it("JARVIS_CHAT_CANDIDATES-stien (eksplisitt liste med failover) tar kimi uten erklæring - eierens valg", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [stub("openai", calls, "auth"), stub("kimi", calls)] });
    const out = await gateway.stream({ ...chat, providerPreference: ["openai", "kimi"], preferenceFailover: true }, () => undefined);
    expect(out.provider).toBe("kimi");
    expect(calls).toEqual(["openai", "kimi"]);
  });
});

describe("meshDetails() viser hva AUTO ikke bruker på tillit", () => {
  it("kimi/hermes: auto_unverified står oppført uten erklæring og er tom med; øvrige leverandører har alltid tom liste", () => {
    const without = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [stub("kimi", []), stub("hermes", []), stub("openai", [])] });
    const byName = (g: ModelGateway) => Object.fromEntries(g.meshDetails().map((d) => [d.provider, d.auto_unverified]));
    expect(byName(without)["kimi"]).toEqual(["tool_calling", "streaming"]);
    expect(byName(without)["hermes"]).toEqual(["tool_calling"]);
    expect(byName(without)["openai"]).toEqual([]);
    const withBoth = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [stub("kimi", []), stub("hermes", []), stub("openai", [])], meshToolsVerified: ["kimi"] });
    expect(byName(withBoth)["kimi"]).toEqual([]);
    expect(byName(withBoth)["hermes"]).toEqual(["tool_calling"]);
  });
});

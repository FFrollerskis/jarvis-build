import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  ProviderError,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type ToolCallRequest,
  type ToolResultMessage
} from "@jarvis/provider-adapters";
import {
  AiRouter, CapabilityRegistry, CouncilAutoTriggerLimiter, MemoryTraceSink, ModelGateway, NoEligibleProviderError, ProviderHealthTracker, unavailableCooldownMs,
  type ProviderPauseSource, type ToolExecutor
} from "../src/index.ts";

/**
 * WP-H0 / JARVIS-087: eierens pause/tilbakekall av en MODELLLEVERANDØR i `ModelGateway`-rutingen.
 *  1. pausen virker LIVE (kilden leses ved hvert kall, ingen omstart) og angres uten omstart;
 *  2. en pauset leverandør er «ikke konfigurert» overalt: AUTO, eksplisitt override, preferanseliste, fallback, verktøyløkke (mellom rundene), streaming;
 *  3. sensitivitetsrutingen er UENDRET: SECRET_RESTRICTED slipper kun lokale, så en pauset lokal leverandør gir fail-closed og aldri en sky-fallback;
 *  4. lesefeil: første lesing feiler = fail-closed; senere feil = siste kjente tilstand; pausen skriver aldri kostrader;
 *  5. synlighet: meshStatus/providerOverview viser pause, lokalitet og kretstilstand uten feilmeldinger.
 */
interface Counters { calls: Record<string, number>; costInserts: number }

function fakePool(counters: Counters): pg.Pool {
  const client = {
    query: async (sql: string) => {
      if (typeof sql === "string" && sql.includes("FROM cost_events")) return { rows: [{ spent: 0 }] };
      if (typeof sql === "string" && sql.includes("INSERT INTO cost_events")) counters.costInserts += 1;
      return { rows: [] };
    },
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

const ok = (provider: string, model: string, extra: Partial<ModelResult> = {}): ModelResult => ({ text: `svar fra ${provider}`, usage: { input_tokens: 1, output_tokens: 1 }, provider, model, finish_reason: "stop", ...extra });

function adapter(name: string, model: string, counters: Counters, behaviour: (req: ModelRequest) => ModelResult | Error = () => ok(name, model)): ModelProviderAdapter {
  return {
    name, model, available: () => true,
    complete: async (req) => {
      counters.calls[name] = (counters.calls[name] ?? 0) + 1;
      const out = behaviour(req);
      if (out instanceof Error) throw out;
      return out;
    }
  };
}

class MutablePause implements ProviderPauseSource {
  paused = new Set<string>();
  failNext: Error | null = null;
  failAlways: Error | null = null;
  reads = 0;
  async pausedProviders(): Promise<ReadonlySet<string>> {
    this.reads += 1;
    if (this.failAlways) throw this.failAlways;
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    return new Set(this.paused);
  }
}

function build(opts: { pause?: MutablePause | null; behaviours?: Record<string, (req: ModelRequest) => ModelResult | Error> } = {}): { gateway: ModelGateway; counters: Counters; pause: MutablePause } {
  const counters: Counters = { calls: {}, costInserts: 0 };
  const pause = opts.pause ?? new MutablePause();
  const b = opts.behaviours ?? {};
  const gateway = new ModelGateway({
    pool: fakePool(counters), trace: new MemoryTraceSink(),
    providers: [adapter("anthropic", "claude-x", counters, b["anthropic"]), adapter("openai", "gpt-x", counters, b["openai"]), adapter("gemma_local", "gemma3", counters, b["gemma_local"])],
    ...(opts.pause === null ? {} : { providerPause: pause })
  });
  return { gateway, counters, pause };
}

const REQUEST: ModelRequest = { messages: [{ role: "user", content: "hei" }] };
const base = { tenant_id: "t1", purpose: "CHAT" as const, request: REQUEST };

describe("pausen virker live og uten omstart", () => {
  it("uten pausekilde er oppførselen uendret (ingen leverandør er pauset)", async () => {
    const { gateway, counters } = build({ pause: null });
    const r = await gateway.complete({ ...base, provider: "anthropic" });
    expect(r.provider).toBe("anthropic");
    expect(counters.calls["anthropic"]).toBe(1);
  });

  it("en eksplisitt override til en pauset leverandør feiler som not_configured FØR noe kall og uten kostrad; etter gjenopptak virker den samme gatewayen igjen", async () => {
    const { gateway, counters, pause } = build();
    pause.paused.add("anthropic");
    const err = await gateway.complete({ ...base, provider: "anthropic" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ provider: "anthropic", kind: "not_configured", message: "anthropic_paused_by_owner" });
    expect(counters.calls["anthropic"] ?? 0).toBe(0);
    expect(counters.costInserts).toBe(0);
    pause.paused.delete("anthropic");
    const r = await gateway.complete({ ...base, provider: "anthropic" });
    expect(r.provider).toBe("anthropic");
    expect(counters.calls["anthropic"]).toBe(1);
  });

  it("pausen leses ved HVERT kall (ingen cache som forsinker et stopp)", async () => {
    const { gateway, pause } = build();
    await gateway.complete({ ...base, provider: "openai" });
    await gateway.complete({ ...base, provider: "openai" });
    expect(pause.reads).toBe(2);
  });
});

describe("en pauset leverandør er «ikke konfigurert» i all ruting", () => {
  it("AUTO og QUALITY velger aldri en pauset leverandør, og den kalles aldri", async () => {
    const { gateway, counters, pause } = build();
    pause.paused.add("anthropic");
    for (const mode of ["AUTO", "QUALITY", "FAST", "CHEAP"] as const) {
      const r = await gateway.complete({ ...base, mode });
      expect(r.provider, mode).not.toBe("anthropic");
    }
    expect(counters.calls["anthropic"] ?? 0).toBe(0);
  });

  it("en preferanseliste der alle er pauset gir provider_preference_exhausted og NEVNER pausen (så D-354-fallbacken i chatten kan ta over)", async () => {
    const { gateway, counters, pause } = build();
    pause.paused.add("gemma_local");
    const err = await gateway.complete({ ...base, providerPreference: ["gemma_local", "gemma_hosted"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoEligibleProviderError);
    expect((err as Error).message).toContain("provider_preference_exhausted");
    expect((err as Error).message).toContain("gemma_local:paused_by_owner");
    expect(counters.calls["gemma_local"] ?? 0).toBe(0);
  });

  it("hvis den primære leverandøren feiler, hoppes en PAUSET fallback-kandidat over (ingen sky-omvei via en pauset leverandør)", async () => {
    const { gateway, counters, pause } = build({ behaviours: { gemma_local: () => new ProviderError("gemma_local", "server", "nede"), anthropic: () => ok("anthropic", "claude-x") } });
    pause.paused.add("openai");
    const r = await gateway.complete({ ...base, mode: "LOCAL" as const }).catch((e: unknown) => e);
    // LOCAL: kun gemma_local er kandidat, den feiler, og de pausede/skyleverandørene blir aldri brukt
    expect(r).toBeInstanceOf(ProviderError);
    expect(counters.calls["openai"] ?? 0).toBe(0);
    expect(counters.calls["anthropic"] ?? 0).toBe(0);
  });

  it("streaming sjekker pausen på samme måte (før noe strømmes)", async () => {
    const { gateway, counters, pause } = build();
    pause.paused.add("anthropic");
    const events: unknown[] = [];
    const err = await gateway.stream({ ...base, provider: "anthropic" }, (e) => events.push(e)).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "not_configured", provider: "anthropic" });
    expect(events).toEqual([]);
    expect(counters.calls["anthropic"] ?? 0).toBe(0);
  });

  it("en pause som settes MIDT i en verktøyløkke gjelder fra neste runde (ruten planlegges på nytt hver runde)", async () => {
    const callTool = (): ToolCallRequest => ({ tool_call_id: "c1", tool_name: "ping", arguments: {}, provider: "anthropic", model: "claude-x" });
    const { gateway, counters, pause } = build({
      behaviours: {
        anthropic: (req) => (req.tool_exchanges === undefined ? ok("anthropic", "claude-x", { finish_reason: "tool_calls", tool_calls: [callTool()], text: "" }) : ok("anthropic", "claude-x")),
        openai: () => ok("openai", "gpt-x", { text: "ferdig fra openai" }),
        gemma_local: () => ok("gemma_local", "gemma3", { text: "ferdig fra gemma" })
      }
    });
    const executor: ToolExecutor = {
      execute: async (call): Promise<ToolResultMessage> => {
        pause.paused.add("anthropic"); // eieren pauser leverandøren mens verktøyet kjører
        return { tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "e1", success: true, at: new Date().toISOString(), output: { ok: true } };
      }
    };
    const tools = [{ name: "ping", description: "ping", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } }];
    const out = await gateway.completeWithTools({ ...base, mode: "QUALITY" }, { tools, executor });
    expect(counters.calls["anthropic"]).toBe(1); // kun runde 1
    expect(out.provider).not.toBe("anthropic");
  });
});

describe("sensitivitetsrutingen er uendret: pauset lokal leverandør gir fail-closed, aldri sky", () => {
  it("SECRET_RESTRICTED + pauset lokal leverandør: ingen kvalifisert leverandør, og INGEN sky-leverandør kalles", async () => {
    const { gateway, counters, pause } = build();
    pause.paused.add("gemma_local");
    const err = await gateway.complete({ ...base, sensitivity: "SECRET_RESTRICTED" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoEligibleProviderError);
    expect((err as Error).message).toContain("pauset av eier: gemma_local");
    expect(counters.calls["anthropic"] ?? 0).toBe(0);
    expect(counters.calls["openai"] ?? 0).toBe(0);
    expect(counters.calls["gemma_local"] ?? 0).toBe(0);
  });

  it("SECRET_RESTRICTED uten pause går til den lokale leverandøren som før; etter gjenopptak virker den igjen", async () => {
    const { gateway, counters, pause } = build();
    const first = await gateway.complete({ ...base, sensitivity: "SECRET_RESTRICTED" });
    expect(first.provider).toBe("gemma_local");
    pause.paused.add("gemma_local");
    await expect(gateway.complete({ ...base, sensitivity: "SECRET_RESTRICTED" })).rejects.toBeInstanceOf(NoEligibleProviderError);
    pause.paused.delete("gemma_local");
    const again = await gateway.complete({ ...base, sensitivity: "SECRET_RESTRICTED" });
    expect(again.provider).toBe("gemma_local");
    expect(counters.calls["gemma_local"]).toBe(2);
  });

  it("en eksplisitt skyoverride for SECRET_RESTRICTED feiler fortsatt (uendret), pause eller ikke", async () => {
    const { gateway, counters } = build();
    await expect(gateway.complete({ ...base, provider: "anthropic", sensitivity: "SECRET_RESTRICTED" })).rejects.toBeInstanceOf(NoEligibleProviderError);
    expect(counters.calls["anthropic"] ?? 0).toBe(0);
  });
});

describe("lesefeil på pausekilden", () => {
  it("første lesing feiler: kallet nektes (fail-closed) uten at noen leverandør kalles og uten kostrad", async () => {
    const pause = new MutablePause();
    pause.failAlways = new Error("connect ECONNREFUSED 10.0.0.9:5432 password=hemmelig");
    const { gateway, counters } = build({ pause });
    const err = await gateway.complete({ ...base }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "not_configured", provider: "router", message: "provider_pause_state_unavailable" });
    expect(JSON.stringify(err)).not.toContain("10.0.0.9");
    expect(Object.values(counters.calls).reduce((a, b) => a + b, 0)).toBe(0);
    expect(counters.costInserts).toBe(0);
  });

  it("etter en vellykket lesing brukes siste kjente tilstand ved en senere feil (en pause kan ikke endres mens databasen er nede)", async () => {
    const pause = new MutablePause();
    const { gateway, counters } = build({ pause });
    pause.paused.add("anthropic");
    await gateway.complete({ ...base }); // vellykket lesing: anthropic er pauset
    pause.failAlways = new Error("db nede");
    const r = await gateway.complete({ ...base, mode: "QUALITY" });
    expect(r.provider).not.toBe("anthropic");
    await expect(gateway.complete({ ...base, provider: "anthropic" })).rejects.toMatchObject({ kind: "not_configured", message: "anthropic_paused_by_owner" });
    expect(counters.calls["anthropic"] ?? 0).toBe(0);
  });
});

describe("synlighet: meshStatus og providerOverview", () => {
  it("meshStatus markerer pauset leverandør (health uendret), router/fallback regnes uten den, og listConfiguredProviders utelater den", async () => {
    const { gateway, pause } = build();
    await gateway.complete({ ...base, provider: "openai" }); // gir openai en helsemåling
    pause.paused.add("openai");
    await gateway.complete({ ...base, provider: "anthropic" }); // oppdaterer øyeblikksbildet
    const mesh = gateway.meshStatus();
    const openai = mesh.providers.find((p) => p.provider === "openai");
    expect(openai).toMatchObject({ paused: true, state: "LIVE", success: 1 });
    expect(mesh.providers.find((p) => p.provider === "anthropic")?.paused).toBeUndefined();
    expect(gateway.listConfiguredProviders()).not.toContain("openai");
    expect(gateway.listConfiguredProviders()).toContain("anthropic");
  });

  it("providerOverview gir lokalitet, konfigurasjon og helse (kategori, ikke melding)", async () => {
    const { gateway } = build({ behaviours: { openai: () => new ProviderError("openai", "auth", "openai_auth_401 Bearer sk-ant-api03-ABCDEFGHIJKLMNOP") } });
    await gateway.complete({ ...base, provider: "openai" }).catch(() => undefined);
    const rows = gateway.providerOverview();
    const byName = new Map(rows.map((r) => [r.provider, r]));
    expect(byName.get("gemma_local")).toMatchObject({ locality: "local", configured: true, hosted_free_tier: false });
    expect(byName.get("anthropic")).toMatchObject({ locality: "cloud", configured: true });
    expect(byName.get("openai")?.health).toMatchObject({ failures: 1, consecutive_failures: 1, last_error_kind: "auth", circuit: "closed" });
    expect(JSON.stringify(rows)).not.toContain("sk-ant");
    expect(JSON.stringify(rows)).not.toContain("Bearer");
  });
});

describe("kretsens tilstand (D-393) i ProviderHealthTracker.detail", () => {
  it("lukket → åpen etter 3 sammenhengende feil → halv-åpen etter pausen → lukket etter ett vellykket prøvekall", () => {
    let now = 1_000_000;
    const t = new ProviderHealthTracker(() => now);
    expect(t.detail("p", true)).toMatchObject({ circuit: "closed", state: "CONFIGURED", consecutive_failures: 0 });
    for (let i = 0; i < 3; i += 1) t.recordFailure("p", "server", "melding med hemmelig tekst");
    const open = t.detail("p", true);
    expect(open).toMatchObject({ circuit: "open", state: "UNAVAILABLE", consecutive_failures: 3, last_error_kind: "server" });
    expect(open.retry_after_ms).toBe(unavailableCooldownMs(3));
    expect(JSON.stringify(open)).not.toContain("hemmelig");
    now += unavailableCooldownMs(3) + 1;
    expect(t.detail("p", true)).toMatchObject({ circuit: "half_open", state: "DEGRADED" });
    t.recordSuccess("p", 120);
    expect(t.detail("p", true)).toMatchObject({ circuit: "closed", state: "LIVE", consecutive_failures: 0, avg_latency_ms: 120 });
  });

  it("en ukonfigurert leverandør har aldri åpen krets, og rate-begrensning vises med sluttidspunkt", () => {
    let now = 5_000_000;
    const t = new ProviderHealthTracker(() => now);
    for (let i = 0; i < 4; i += 1) t.recordFailure("p", "timeout", "x");
    expect(t.detail("p", false)).toMatchObject({ circuit: "closed", state: "NOT_CONFIGURED" });
    t.recordFailure("q", "rate_limit", "x");
    const q = t.detail("q", true);
    expect(q.state).toBe("RATE_LIMITED");
    expect(q.rate_limited_until).toBe(new Date(now + 60_000).toISOString());
    now += 61_000;
    expect(t.detail("q", true).rate_limited_until).toBeUndefined();
  });
});

describe("ruteren sier hvorfor", () => {
  const reg = new CapabilityRegistry();
  const health = new ProviderHealthTracker();
  const router = new AiRouter(reg, health);
  const runtimes = (paused: string[]) => new Map([
    ["anthropic", { configured: !paused.includes("anthropic"), paused: paused.includes("anthropic"), model: "claude-x" }],
    ["gemma_local", { configured: !paused.includes("gemma_local"), paused: paused.includes("gemma_local"), model: "gemma3" }]
  ]);

  it("eksplisitt override til pauset leverandør: «pauset av eier», ikke «ikke konfigurert»", () => {
    expect(() => router.plan({ provider: "anthropic" }, runtimes(["anthropic"]))).toThrow(/pauset av eier/);
    expect(() => router.plan({ provider: "anthropic" }, new Map())).toThrow(/ikke konfigurert/);
  });

  it("en pauset leverandør er aldri kandidat, og SECRET_RESTRICTED slipper aldri skyen inn når den lokale er pauset", () => {
    const plan = router.plan({ mode: "AUTO" }, runtimes(["anthropic"]));
    expect(plan.candidates.map((c) => c.provider)).toEqual(["gemma_local"]);
    expect(() => router.plan({ sensitivity: "SECRET_RESTRICTED" }, runtimes(["gemma_local"]))).toThrow(NoEligibleProviderError);
  });
});

describe("CouncilAutoTriggerLimiter.usage (parallell-delegasjonsoverhead)", () => {
  it("teller brukte plasser i vinduet og gitt/nektet siden oppstart, uten å forbruke noe selv", () => {
    let t = 1_000;
    const limiter = new CouncilAutoTriggerLimiter(2, 60_000, () => t);
    expect(limiter.usage("a")).toEqual({ max_per_window: 2, window_ms: 60_000, used_in_window: 0, acquired_total: 0, denied_total: 0 });
    expect(limiter.tryAcquire("a")).toBe(true);
    expect(limiter.tryAcquire("a")).toBe(true);
    expect(limiter.tryAcquire("a")).toBe(false);
    expect(limiter.usage("a")).toEqual({ max_per_window: 2, window_ms: 60_000, used_in_window: 2, acquired_total: 2, denied_total: 1 });
    expect(limiter.usage("a").used_in_window).toBe(2); // usage() forbruker ingenting
    expect(limiter.usage("b").used_in_window).toBe(0);
    t += 61_000;
    expect(limiter.usage("a").used_in_window).toBe(0);
  });
});

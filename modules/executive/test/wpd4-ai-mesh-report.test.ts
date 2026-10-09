import { describe, expect, it } from "vitest";
import type { ToolGateway } from "@jarvis/tool-gateway";
import {
  ExecutiveService, ExecutiveTransport, composeAiMeshReport, evaluateAcceptance, executiveToolDefinitions, parallelOverheadMs, renderAiMeshReportNo,
  type AiMeshProvider, type AiMeshUsage7d
} from "../src/index.ts";

/**
 * WP-D4 (JARVIS-033/036/078): AI Mesh-rapportens komposisjon, akseptanse («≥3 live providers med fallback») og eksponering som kun-lesende ToolGateway-verktøy
 * (`executive.get_ai_mesh_status`). Ærlighet er testet: konfigurert er ikke bevist, ukjent er ikke frisk, og rapporten gjør aldri noe.
 */
const gateway = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;

const usage = (over: Partial<AiMeshUsage7d> = {}): AiMeshUsage7d => ({ calls: 0, ok_calls: 0, failed_calls: 0, fallback_ok_calls: 0, cost_ore: 0, tokens_in: 0, tokens_out: 0, p50_latency_ms: null, last_success_at: null, ...over });
const provider = (name: string, over: Partial<AiMeshProvider> = {}): AiMeshProvider => ({
  provider: name,
  model: `${name}-model`,
  locality: "cloud",
  hosted_free_tier: false,
  capabilities: ["text"],
  configured: true,
  state: "CONFIGURED",
  healthy: false,
  runtime: { success: 0, failures: 0, consecutive_failures: 0, p50_latency_ms: null, avg_latency_ms: null, p50_solo_latency_ms: null, p50_parallel_latency_ms: null, solo_samples: 0, parallel_samples: 0, parallel_overhead_ms: null },
  last_error: null,
  usage_7d: usage(),
  ...over
});
const live = (name: string, over: Partial<AiMeshProvider> = {}): AiMeshProvider => provider(name, { state: "LIVE", healthy: true, usage_7d: usage({ calls: 4, ok_calls: 4, p50_latency_ms: 800 }), ...over });
const AS_OF = "2026-10-15T12:00:00.000Z";

describe("parallelOverheadMs", () => {
  it("p50 parallell minus p50 alene, avrundet; negativt tall er lov", () => {
    expect(parallelOverheadMs({ p50_solo: 1000, p50_parallel: 1450.4, solo_samples: 3, parallel_samples: 3 })).toBe(450);
    expect(parallelOverheadMs({ p50_solo: 1000, p50_parallel: 900, solo_samples: 5, parallel_samples: 5 })).toBe(-100);
  });

  it("færre enn tre prøver i en av gruppene (eller manglende p50) gir null - aldri et tall av støy", () => {
    expect(parallelOverheadMs({ p50_solo: 1000, p50_parallel: 2000, solo_samples: 2, parallel_samples: 9 })).toBeNull();
    expect(parallelOverheadMs({ p50_solo: 1000, p50_parallel: 2000, solo_samples: 9, parallel_samples: 2 })).toBeNull();
    expect(parallelOverheadMs({ p50_solo: null, p50_parallel: 2000, solo_samples: 9, parallel_samples: 9 })).toBeNull();
    expect(parallelOverheadMs({ solo_samples: 9, parallel_samples: 9 })).toBeNull();
  });
});

describe("evaluateAcceptance (≥3 live providers med fallback)", () => {
  it("MET når tre konfigurerte leverandører er bevist live OG fallback er observert (7 døgn)", () => {
    const a = evaluateAcceptance([live("a"), live("b"), live("c", { usage_7d: usage({ calls: 2, ok_calls: 2, fallback_ok_calls: 1 }) })], { fallback_verified_in_process: false });
    expect(a).toMatchObject({ verdict: "MET", live_providers: 3, fallback_ok_calls_7d: 1, missing: [] });
    expect(a.live).toEqual(["a", "b", "c"]);
  });

  it("MET også med fallback bevist kun i denne prosessen", () => {
    expect(evaluateAcceptance([live("a"), live("b"), live("c")], { fallback_verified_in_process: true }).verdict).toBe("MET");
  });

  it("NOT_MET uten fallback-bevis, selv med tre live: sier hva som mangler", () => {
    const a = evaluateAcceptance([live("a"), live("b"), live("c")], { fallback_verified_in_process: false });
    expect(a.verdict).toBe("NOT_MET");
    expect(a.missing.join(" ")).toContain("Ingen vellykket fallback");
  });

  it("NOT_MET med bare to live: konfigurert-men-aldri-bevist teller ikke og navngis", () => {
    const a = evaluateAcceptance([live("a"), live("b"), provider("c")], { fallback_verified_in_process: true });
    expect(a.verdict).toBe("NOT_MET");
    expect(a.live_providers).toBe(2);
    expect(a.missing.join(" ")).toContain("Bare 2 av 3");
    expect(a.missing.join(" ")).toContain("aldri bevist: c");
  });

  it("en leverandør som ble live for flere dager siden men er UNAVAILABLE nå, teller ut fra bevist suksess siste 7 døgn", () => {
    const a = evaluateAcceptance([live("a"), live("b"), provider("c", { state: "UNAVAILABLE", usage_7d: usage({ calls: 3, ok_calls: 2, failed_calls: 1 }) })], { fallback_verified_in_process: true });
    expect(a.live).toContain("c");
    expect(a.verdict).toBe("MET");
  });

  it("testdobler (scripted) og ikke-konfigurerte leverandører teller aldri", () => {
    const a = evaluateAcceptance(
      [live("a"), live("b"), live("scripted"), provider("c", { configured: false, state: "NOT_CONFIGURED", usage_7d: usage({ calls: 9, ok_calls: 9 }) })],
      { fallback_verified_in_process: true }
    );
    expect(a.live_providers).toBe(2);
    expect(a.verdict).toBe("NOT_MET");
  });

  it("ingen konfigurerte leverandører: NOT_MET med tydelig årsak", () => {
    const a = evaluateAcceptance([provider("a", { configured: false, state: "NOT_CONFIGURED" })], { fallback_verified_in_process: false });
    expect(a.verdict).toBe("NOT_MET");
    expect(a.missing[0]).toBe("Ingen leverandør er konfigurert.");
  });

  it("ulesbar database (usage_7d null overalt) uten annet bevis gir UKJENT - aldri MET og aldri en gjetning om feil", () => {
    const a = evaluateAcceptance([provider("a", { usage_7d: null }), provider("b", { usage_7d: null })], { fallback_verified_in_process: false });
    expect(a.verdict).toBe("UNKNOWN");
    expect(a.missing.join(" ")).toContain("Databasen kunne ikke leses");
  });

  it("ulesbar database, men tre LIVE i prosessen og fallback bevist i prosessen: MET (beviset er reelt)", () => {
    const l = (n: string) => live(n, { usage_7d: null });
    expect(evaluateAcceptance([l("a"), l("b"), l("c")], { fallback_verified_in_process: true }).verdict).toBe("MET");
  });
});

describe("composeAiMeshReport", () => {
  it("acts er alltid false; summary_no er norsk, deterministisk og skjuler ikke hva som ikke er målt", () => {
    const report = composeAiMeshReport({
      as_of: AS_OF,
      router: "DEGRADED",
      chain: { candidates: ["gemma_local", "gemma_hosted"], auto_fallback: true },
      providers: [
        live("gemma_local", { locality: "local", usage_7d: usage({ calls: 10, ok_calls: 10, p50_latency_ms: 450 }) }),
        provider("kimi", { state: "UNAVAILABLE", last_error: { kind: "auth", message: "kimi_auth_401", at: "2026-10-15T11:00:00.000Z" }, usage_7d: usage({ calls: 2, failed_calls: 2 }) }),
        provider("hermes", { configured: false, state: "NOT_CONFIGURED" }),
        live("scripted")
      ],
      fallback_verified_in_process: false
    });
    expect(report.acts).toBe(false);
    expect(report.summary_no).toContain("1 av 3 nødvendige leverandører er bevist live");
    expect(report.summary_no).toContain("IKKE OPPFYLT ennå");
    expect(report.summary_no).toContain("gemma_local → gemma_hosted");
    expect(report.summary_no).toContain("- kimi (sky): UTILGJENGELIG");
    expect(report.summary_no).toContain("- hermes (sky): ikke konfigurert");
    expect(report.summary_no).toContain("Siste feil: kimi: auth (kimi_auth_401) 2026-10-15 11:00");
    expect(report.summary_no).toContain("Ikke målt:");
    expect(report.summary_no).not.toContain("scripted");
    expect(report.not_measured.length).toBeGreaterThanOrEqual(4);
    expect(report.summary_no).toBe(renderAiMeshReportNo(report));
  });

  it("kostnad og feil vises per leverandør, og ukjent database sies som ukjent (ikke 0 kall)", () => {
    const report = composeAiMeshReport({
      as_of: AS_OF,
      router: "HEALTHY",
      providers: [live("anthropic", { usage_7d: usage({ calls: 12, ok_calls: 11, failed_calls: 1, cost_ore: 12345, p50_latency_ms: 2100 }) }), live("kimi", { usage_7d: null })],
      fallback_verified_in_process: false
    });
    expect(report.summary_no).toContain("7 døgn: 12 kall, 1 feil, 123,45 kr");
    expect(report.summary_no).toContain("p50 2100 ms");
    expect(report.summary_no).toContain("- kimi (sky): LIVE · 7 døgn: ukjent (databasen kunne ikke leses)");
  });

  it("parallell-overhead vises med fortegn bare når den er målt", () => {
    const withOverhead = provider("kimi", { state: "LIVE", healthy: true, runtime: { ...provider("x").runtime, parallel_overhead_ms: 320 } });
    expect(composeAiMeshReport({ as_of: AS_OF, router: "HEALTHY", providers: [withOverhead], fallback_verified_in_process: false }).summary_no).toContain("parallell-overhead +320 ms");
    expect(composeAiMeshReport({ as_of: AS_OF, router: "HEALTHY", providers: [live("kimi")], fallback_verified_in_process: false }).summary_no).not.toContain("parallell-overhead");
  });

  it("unknown_reason gir UKJENT (ikke «ikke oppfylt») når målekilden mangler", () => {
    const report = composeAiMeshReport({ as_of: AS_OF, router: "UNAVAILABLE", providers: [], fallback_verified_in_process: false, unknown_reason: "Ingen kilde." });
    expect(report.acceptance).toMatchObject({ verdict: "UNKNOWN", missing: ["Ingen kilde."] });
    expect(report.summary_no).toContain("Akseptansen «≥3 live providers med fallback»: UKJENT");
  });

  it("unknown_reason overstyrer aldri et reelt MET", () => {
    const report = composeAiMeshReport({ as_of: AS_OF, router: "HEALTHY", providers: [live("a"), live("b"), live("c")], fallback_verified_in_process: true, unknown_reason: "x" });
    expect(report.acceptance.verdict).toBe("MET");
  });
});

describe("ExecutiveService.getAiMeshStatus", () => {
  it("uten kilde: ærlig «ikke koblet inn» - ingen leverandør, akseptansen UKJENT, router UNAVAILABLE", async () => {
    const report = await new ExecutiveService(gateway).getAiMeshStatus();
    expect(report.acts).toBe(false);
    expect(report.providers).toEqual([]);
    expect(report.router).toBe("UNAVAILABLE");
    expect(report.acceptance.verdict).toBe("UNKNOWN");
    expect(report.summary_no).toContain("Ingen kilde er koblet inn");
  });

  it("med kilde: returnerer kildens rapport uendret", async () => {
    const injected = composeAiMeshReport({ as_of: AS_OF, router: "HEALTHY", providers: [live("a")], fallback_verified_in_process: false });
    expect(await new ExecutiveService(gateway, { aiMesh: { report: async () => injected } }).getAiMeshStatus()).toBe(injected);
  });
});

describe("executive.get_ai_mesh_status som verktøy", () => {
  const injected = composeAiMeshReport({ as_of: AS_OF, router: "HEALTHY", providers: [live("a")], fallback_verified_in_process: false });
  const transport = new ExecutiveTransport(new ExecutiveService(gateway, { aiMesh: { report: async () => injected } }));
  const context = { identity: { tenant_id: "t1", person_id: "p1", memory_space_id: "personal" } } as never;

  it("er registrert som lesing (klasse A), uten parametre og uten skrive-scope", () => {
    const def = executiveToolDefinitions(transport).find((d) => d.action === "get_ai_mesh_status");
    expect(def).toBeDefined();
    expect(def!.capability_class).toBe("A");
    expect(def!.scopes.join(",")).not.toContain("write");
    expect(def!.input_schema.safeParse({}).success).toBe(true);
    expect(def!.description).toContain("KUN lesing");
  });

  it("transporten returnerer rapporten med acts:false og norsk oppsummering", async () => {
    const result = await transport.invoke("get_ai_mesh_status", {}, "", context);
    const data = result.data as unknown as { acts: boolean; summary_no: string };
    expect(data.acts).toBe(false);
    expect(data.summary_no).toContain("AI Mesh");
  });

  it("rapporten er ren JSON uten nøkkelfelt (kun presence-flagget configured)", async () => {
    const result = await transport.invoke("get_ai_mesh_status", {}, "", context);
    const text = JSON.stringify(result.data);
    expect(text).not.toMatch(/api[_-]?key|secret|authorization|bearer/i);
  });
});

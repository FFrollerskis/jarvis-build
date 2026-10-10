import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  CHAT_READ_TIER, MemorySearchTransport, ModelSurfaceViolationError, SURFACE_TOOL_GRANTS, assertChatReadTier, assertManifestInvariants, buildToolManifest, firstWaveTools, homeAssistantTools,
  KnowledgeSearchTransport, knowledgeToolDefinitions, memoryToolDefinitions, selectSurfaceTools, type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";
import { PRODUCTION_SURFACE } from "./support/fast-path-harness.ts";

/**
 * WP-E1 (UA-5, JARVIS-068): `executive.get_infra_status` er ren lesing på chat-flaten (og ikke på bakgrunn/koding), valgt kun når eieren spør om drift/hendelser, og tilgjengelig over HTTP kun via en
 * EGEN lese-rute med eget allowlist (`/executive/query` forblir låst til fire handlinger). Tekstvakter for main.ts/server.ts (de starter en server idet de importeres).
 */
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const mainSource = read("../src/main.ts");
const serverSource = read("../src/server.ts");
const KEY = "executive.get_infra_status";

function productionDefinitions(): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw))),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never)),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never))
    ]
  });
}
const defs = productionDefinitions();
const gw = { list: () => defs } as unknown as ToolGateway;

describe("A: executive.get_infra_status er ren lesing på chat-flaten - og ingen andre steder", () => {
  it("står i chattens lese-nivå, og nivå-, manifest- og klasse-invariantene holder (klasse A, effekt read)", () => {
    expect(CHAT_READ_TIER.filter((g) => `${g.tool_id}.${g.action}` === KEY)).toHaveLength(1);
    expect(() => assertChatReadTier(gw)).not.toThrow();
    expect(() => assertManifestInvariants(buildToolManifest(defs))).not.toThrow();
    expect(buildToolManifest(defs).get(KEY)).toMatchObject({ tool_id: "executive", effect: "read", risk: "A" });
  });

  it("står på web-chatten (eier + signert økt, som kontrollsentrene) og ikke på tale (gjennomgang av PR #324, L4), Telegram, bakgrunn eller koding", () => {
    const manifest = buildToolManifest(defs);
    expect(manifest.get(KEY)?.surfaces).toEqual(["web_chat"]);
    expect(manifest.get("executive.get_slo_report")?.surfaces).toContain("voice");
    for (const s of ["voice", "telegram", "background", "coding"] as const) expect(SURFACE_TOOL_GRANTS[s].some((g) => `${g.tool_id}.${g.action}` === KEY), s).toBe(false);
  });

  it("endres definisjonen til skriving (klasse B), stopper oppstarten lukket", () => {
    const mutated = defs.map((d) => (d.tool_id === "executive" && d.action === "get_infra_status" ? { ...d, capability_class: "B" as const } : d));
    expect(() => assertChatReadTier({ list: () => mutated } as unknown as ToolGateway)).toThrow(ModelSurfaceViolationError);
  });

  it("er med i produksjonsflaten for chat, og utvalget tar det med kun når eieren spør om drift/hendelser/skyen", () => {
    expect(PRODUCTION_SURFACE.some((m) => `${m.tool_id}.${m.action}` === KEY)).toBe(true);
    const picked = (text: string): string[] => selectSurfaceTools("web_chat", text, PRODUCTION_SURFACE).selected.map((m) => `${m.tool_id}.${m.action}`);
    for (const text of ["har vi noen åpne hendelser?", "hva er status på driften", "er noe nede akkurat nå", "gi meg skystatus", "hvordan går det med skyen", "vis driftsstatus", "var det en feilet utrulling i natt"]) {
      expect(picked(text), text).toContain(KEY);
    }
    for (const text of ["hei", "hva er været i morgen", "send en e-post til Ola om møtet", "sjekk kalenderen min", "hva koster du"]) {
      expect(picked(text), text).not.toContain(KEY);
    }
  });

  it("modellen kan ikke nå skymålene selv: kun den lesende driftsstatusen, ingen cloudflare/postgres_ops/infisical/langfuse-handling på modellflaten", () => {
    for (const toolId of ["cloudflare", "postgres_ops", "infisical", "langfuse"]) {
      expect(PRODUCTION_SURFACE.some((m) => m.tool_id === toolId), toolId).toBe(false);
      expect(CHAT_READ_TIER.some((g) => g.tool_id === toolId), toolId).toBe(false);
    }
  });
});

describe("B: HTTP - egen lese-rute med eget allowlist; /executive/query er uendret", () => {
  it("/infra/overview tillater kun get_infra_status, avviser andre handlinger FØR grantet løses, og sender aldri parametre fra kroppen videre", () => {
    expect(serverSource).toMatch(/const INFRA_OVERVIEW_ACTIONS = \["get_infra_status"\] as const;/);
    const route = serverSource.indexOf('url.pathname === "/infra/overview"');
    expect(route).toBeGreaterThan(-1);
    const block = serverSource.slice(route, route + 1400);
    expect(block.indexOf("INFRA_OVERVIEW_ACTIONS")).toBeLessThan(block.indexOf("resolveFromGrant("));
    expect(block).toContain('tool_id: "executive", action, parameters: {}');
    expect(block).not.toMatch(/parsedBody\["parameters"\]/);
    const match = serverSource.match(/const EXECUTIVE_QUERY_ACTIONS = \[([\s\S]*?)\] as const;/);
    expect((match?.[1] ?? "")).not.toContain("get_infra_status");
  });

  it("main.ts kobler driftsstatus-kilden og produsent-status inn i ExecutiveService (kun lesing)", () => {
    expect(mainSource).toContain("createInfraStatusSource(pool)");
    expect(mainSource).toContain("producers_enabled: incidentProducerConfig.enabled");
    expect(mainSource).toContain("producer_names: INCIDENT_PRODUCER_NAMES");
  });
});

import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { CONTROL_CENTER_IDS, ControlCenterRegistry, ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  CHAT_ACT_TIER, CHAT_DELEGATE_TIER, CHAT_READ_TIER, MODEL_SURFACE_ALLOWLIST, MemorySearchTransport, SURFACE_TOOL_GRANTS, assertChatReadTier, assertManifestInvariants,
  buildToolManifest, chatReadTierMeshTools, firstWaveTools, homeAssistantTools, inferEffect, memoryToolDefinitions, resolveModelToolSurface, scopeFieldsOf, selectSurfaceTools,
  type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";

/**
 * WP-H0: `executive.get_control_center` er ETT klasse A chat-lese-verktøy (parameter `center`), sensitivitetsmerket `private`, med eier-kun port - og står IKKE på det minimale
 * `MODEL_SURFACE_ALLOWLIST` (som er låst til fem handlinger). Handlingene eieren kan ta fra kontrollsentrene peker på eier-rutene og er aldri modellverktøy.
 */
const KEY = "executive.get_control_center";
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };

function productionDefinitions(registry?: ControlCenterRegistry): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, registry ? { controlCenters: registry } : {}))),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never))
    ]
  });
}
const defs = productionDefinitions();
const gw = { list: () => defs } as unknown as ToolGateway;
const def = defs.find((d) => `${d.tool_id}.${d.action}` === KEY) as ToolDefinition;

describe("registrering og risiko", () => {
  it("er registrert som klasse A, ren lesing, uten identitetsfelt i skjemaet", () => {
    expect(def).toBeDefined();
    expect(def.capability_class).toBe("A");
    expect(def.reversible).toBe(true);
    expect(inferEffect(def.tool_id, def.action)).toBe("read");
    expect(scopeFieldsOf(def)).toEqual([]);
  });

  it("skjemaet er strengt: kun `center` (en av de ti kjente id-ene), ingenting annet", () => {
    const parse = (p: Record<string, unknown>) => def.input_schema.safeParse(p).success;
    expect(parse({})).toBe(true);
    for (const id of CONTROL_CENTER_IDS) expect(parse({ center: id }), id).toBe(true);
    for (const bad of [{ center: "billing" }, { center: "" }, { center: 5 }, { center: null }, { center: "ai", extra: 1 }, { tenant_id: "t" }, { person_id: "p" }, { action: "freeze_connector" }]) {
      expect(parse(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("modellen ser en enum av de ti id-ene og additionalProperties:false", () => {
    const mapping = chatReadTierMeshTools(defs, CHAT_READ_TIER, "read").find((m) => `${m.tool_id}.${m.action}` === KEY);
    expect(mapping?.def.name).toBe("executive__get_control_center");
    const schema = mapping?.def.input_schema as { properties: { center: { enum: string[] } }; additionalProperties: boolean };
    expect(schema.properties.center.enum).toEqual([...CONTROL_CENTER_IDS]);
    expect(schema.additionalProperties).toBe(false);
    expect(mapping?.def.description.startsWith("[lesing]")).toBe(true);
  });
});

describe("modellflaten: chat-lese-nivået, ikke det minimale settet", () => {
  it("står i CHAT_READ_TIER (én gang) - og ikke i MODEL_SURFACE_ALLOWLIST, handlingsnivået eller delegeringsnivået", () => {
    expect(CHAT_READ_TIER.filter((g) => `${g.tool_id}.${g.action}` === KEY)).toHaveLength(1);
    for (const tier of [MODEL_SURFACE_ALLOWLIST, CHAT_ACT_TIER, CHAT_DELEGATE_TIER]) expect(tier.some((g) => `${g.tool_id}.${g.action}` === KEY)).toBe(false);
    expect(MODEL_SURFACE_ALLOWLIST).toHaveLength(5);
  });

  it("lese-nivået og manifestet består sine boot-invarianter med verktøyet på plass", () => {
    expect(() => assertChatReadTier(gw)).not.toThrow();
    expect(() => assertManifestInvariants(buildToolManifest(defs))).not.toThrow();
    expect(() => resolveModelToolSurface(gw, { includeChatReadTier: true })).not.toThrow();
  });

  it("manifestet merker det `private` og bare chat/tale har det (aldri Telegram, bakgrunn eller koding)", () => {
    const entry = buildToolManifest(defs).get(KEY);
    expect(entry).toMatchObject({ risk: "A", effect: "read", owner: "jarvis_core", sensitivity: "private", data_zone: "internal" });
    expect(entry?.surfaces.sort()).toEqual(["voice", "web_chat"]);
    for (const surface of ["telegram", "background", "coding"] as const) expect(SURFACE_TOOL_GRANTS[surface].some((g) => `${g.tool_id}.${g.action}` === KEY), surface).toBe(false);
  });

  it("de øvrige executive-lesingene beholder sine merker (kun kontrollsenteret er hevet til private)", () => {
    const manifest = buildToolManifest(defs);
    expect(manifest.get("executive.get_slo_report")?.sensitivity).toBe("public");
    expect(manifest.get("executive.get_control_center")?.sensitivity).toBe("private");
  });
});

describe("utvalg per melding", () => {
  const surface = resolveModelToolSurface(gw, { includeChatReadTier: true });
  const picked = (text: string) => selectSurfaceTools("web_chat", text, surface).selected.map((m) => `${m.tool_id}.${m.action}`);

  it("«vis kontrollsentrene» / «kontrollpanelet» / «hva kan jeg stoppe» gir executive-lesingene inkludert kontrollsenteret", () => {
    for (const msg of ["vis kontrollsentrene", "hva sier kontrollpanelet", "hva kan jeg stoppe akkurat nå", "åpne admin-senteret", "Hva kan jeg pause?"]) {
      expect(picked(msg), msg).toContain(KEY);
    }
  });

  it("småprat og urelaterte meldinger får ikke kontrollsenteret", () => {
    for (const msg of ["hei", "hva er klokka", "snakk om været", "hvem er kunden min"]) expect(picked(msg), msg).not.toContain(KEY);
  });
});

describe("eier-kun port i verktøydefinisjonen", () => {
  const ownerOnly = new ControlCenterRegistry({ isOwner: (i) => i.person_id === "person-owner" && i.delegation_id === undefined });

  it("med registeret: eieren slipper gjennom, en annen person og en delegat nektes - parameterAuthorizer kalles av ToolGateway FØR transporten", () => {
    const d = productionDefinitions(ownerOnly).find((x) => `${x.tool_id}.${x.action}` === KEY) as ToolDefinition;
    expect(d.parameterAuthorizer?.({}, owner)).toEqual({ allowed: true, reason: "owner" });
    expect(d.parameterAuthorizer?.({}, { ...owner, person_id: "person-other" })).toEqual({ allowed: false, reason: "control_center_owner_only" });
    expect(d.parameterAuthorizer?.({}, { ...owner, delegation_id: "deleg" })).toEqual({ allowed: false, reason: "control_center_owner_only" });
  });

  it("registeret uten eier-predikat nekter alle (fail-closed)", () => {
    const d = productionDefinitions(new ControlCenterRegistry()).find((x) => `${x.tool_id}.${x.action}` === KEY) as ToolDefinition;
    expect(d.parameterAuthorizer?.({}, owner)).toEqual({ allowed: false, reason: "control_center_owner_check_not_configured" });
  });

  it("ingen andre executive-lesinger har fått en slik port ved et uhell", () => {
    for (const d of defs.filter((x) => x.tool_id === "executive" && x.action !== "get_control_center")) expect(d.parameterAuthorizer, d.action).toBeUndefined();
  });
});

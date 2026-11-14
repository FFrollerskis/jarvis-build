import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { CONTROL_CENTER_READ_ACTIONS, ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  CHAT_READ_TIER, MemorySearchTransport, SURFACE_TOOL_GRANTS, assertManifestInvariants, buildToolManifest, firstWaveTools, homeAssistantTools, KnowledgeSearchTransport, knowledgeToolDefinitions, memoryToolDefinitions,
  resolveModelToolSurface, selectSurfaceTools, type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { createControlCenterRegistry } from "../src/control-center/register.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";

/**
 * Gjennomgang av PR #324 (L4 + M3): `executive.get_infra_status` var ÅPEN på tale og chat for enhver identitet. Utdata har hendelsestitler med repo/gren, jobbnavn og skymål-tilstand - eierens driftsbilde -
 * og strømmer til modellen som betjener turen. `get_control_center` er allerede låst (H0 L-4); driftsstatusen får SAMME mønster: (1) ikke på tale (`VOICE_EXCLUDED_KEYS`), (2) sensitivitet `private`,
 * (3) lese-porten i verktøydefinisjonen = eier OG enhetssignert økt (`authorizeRead`), fail-closed også uten register - avslaget er en vanlig `tool.denied`-revisjonsrad FØR noe leses, uansett vei
 * (`/infra/overview`, chat). Det er DET SAMME eier-predikatet kontrollsentrene bruker (`createControlCenterRegistry`).
 */
const KEY = "executive.get_infra_status";
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };

function definitionsWith(registry?: ReturnType<typeof createControlCenterRegistry>): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, registry ? { controlCenters: registry } : {}))),
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
const ownerOnly = createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] } });
const withRegistry = definitionsWith(ownerOnly);
const target = (defs: ToolDefinition[]): ToolDefinition => defs.find((d) => `${d.tool_id}.${d.action}` === KEY) as ToolDefinition;

describe("flate og sensitivitet", () => {
  it("står på web-chatten, men IKKE på tale, Telegram, bakgrunn eller koding - mens de øvrige executive-lesingene beholder tale", () => {
    expect(CHAT_READ_TIER.filter((g) => `${g.tool_id}.${g.action}` === KEY)).toHaveLength(1);
    const manifest = buildToolManifest(withRegistry);
    expect(manifest.get(KEY)?.surfaces).toEqual(["web_chat"]);
    for (const surface of ["voice", "telegram", "background", "coding"] as const) expect(SURFACE_TOOL_GRANTS[surface].some((g) => `${g.tool_id}.${g.action}` === KEY), surface).toBe(false);
    expect(manifest.get("executive.get_slo_report")?.surfaces).toContain("voice");
    expect(() => assertManifestInvariants(manifest)).not.toThrow();
  });

  it("sensitivitet `private` (ikke `public`), klasse A, ren lesing", () => {
    expect(buildToolManifest(withRegistry).get(KEY)).toMatchObject({ risk: "A", effect: "read", sensitivity: "private", owner: "jarvis_core", data_zone: "internal" });
  });

  it("en stemmeflate som velger verktøy per melding får ikke driftsstatusen, uansett hva som sies; web-chatten får den", () => {
    const gw = { list: () => withRegistry } as unknown as ToolGateway;
    const surface = resolveModelToolSurface(gw, { includeChatReadTier: true });
    const pick = (s: "voice" | "web_chat", text: string): string[] => selectSurfaceTools(s, text, surface).selected.map((m) => `${m.tool_id}.${m.action}`);
    for (const text of ["hva er status på driften", "har vi åpne hendelser", "er noe nede akkurat nå", "gi meg skystatus"]) {
      expect(pick("voice", text), `voice: ${text}`).not.toContain(KEY);
      expect(pick("web_chat", text), `web_chat: ${text}`).toContain(KEY);
    }
  });
});

describe("lese-porten i verktøydefinisjonen: eier OG signert enhetsøkt, fail-closed", () => {
  const d = target(withRegistry);

  it("eieren fra en signert enhetsøkt slipper gjennom", () => {
    expect(d.parameterAuthorizer?.({}, owner)).toEqual({ allowed: true, reason: "owner" });
  });

  it("eieren uten signert økt (passiv/aktiv, også på tale/Telegram) nektes med en tydelig årsak", () => {
    for (const auth_strength of ["passive", "active"] as const) {
      for (const channel of ["web", "voice", "telegram", "api"] as const) {
        expect(d.parameterAuthorizer?.({}, { ...owner, auth_strength, channel }), `${auth_strength}/${channel}`).toEqual({ allowed: false, reason: "control_center_requires_signed_device_session" });
      }
    }
  });

  it("alle ikke-eier-kategoriene nektes (annen person, delegat, gjest, annen tenant, annen person i annen tenant) - selv med signert økt", () => {
    for (const [label, identity] of [
      ["annen person i eierens tenant", { ...owner, person_id: "person-member" }],
      ["delegat", { ...owner, delegation_id: "deleg-1" }],
      ["gjest", { ...owner, person_id: "person-guest", memory_space_id: "guest" }],
      ["eierens person i annen tenant", { ...owner, tenant_id: "tenant-annen" }],
      ["annen person i annen tenant", { ...owner, person_id: "person-x", tenant_id: "tenant-y" }]
    ] as const) {
      expect(d.parameterAuthorizer?.({}, identity), label).toEqual({ allowed: false, reason: "control_center_owner_only" });
    }
  });

  it("FAIL-CLOSED uten eier-register: driftsstatusen blir aldri åpen for alle fordi registeret mangler (i motsetning til get_control_center)", () => {
    const bare = target(definitionsWith());
    expect(bare.parameterAuthorizer?.({}, owner)).toEqual({ allowed: false, reason: "control_center_owner_check_not_configured" });
  });

  it("registeret uten eier-predikat nekter alle", () => {
    const strict = target(definitionsWith(createControlCenterRegistry({ authority: { owner_person_id: "andre", owner_tenants: ["tenant-owner"] } })));
    expect(strict.parameterAuthorizer?.({}, owner)).toEqual({ allowed: false, reason: "control_center_owner_only" });
  });

  it("de øvrige executive-lesingene (f.eks. get_slo_report) har ingen slik port - kun driftsstatusen (og kontrollsenteret/avbryt fra H0) er låst", () => {
    // WP-H1/H2: de per-senter lese-verktøyene har samme lese-port (se wph1-control-tools.test.ts) - listen kommer fra CONTROL_CENTER_READ_TOOLS.
    for (const x of withRegistry.filter((y) => y.tool_id === "executive" && !["get_control_center", "cancel_task", "get_infra_status"].includes(y.action) && !CONTROL_CENTER_READ_ACTIONS.has(y.action))) {
      expect(x.parameterAuthorizer, x.action).toBeUndefined();
    }
  });
});

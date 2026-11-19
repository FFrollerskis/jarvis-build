// REVIEWER A DELTA (midlertidig): oppstartsporten slik main.ts kjører den - HELE produksjonsregisteret + comms-definisjoner for alle 16 flaggkombinasjoner, UTEN `ignoreUnregisteredGrants`.
import { describe, expect, it } from "vitest";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  KnowledgeSearchTransport, MemorySearchTransport, assertManifestInvariants, buildToolManifest, firstWaveTools, homeAssistantTools, knowledgeToolDefinitions, memoryToolDefinitions, resolveModelToolSurface,
  type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { commsToolDefinitions, parseCommsConfig } from "@jarvis/comms";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";

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

const FL = ["JARVIS_COMMS_VENDOR_READS", "JARVIS_COMMS_CALLS", "JARVIS_COMMS_CONTACTS", "JARVIS_COMMS_MEETINGS"];
const base = productionDefinitions();
const surfaceOf = (defs: ToolDefinition[]) => resolveModelToolSurface({ list: () => defs }, { onlyRegistered: true, includeChatReadTier: true, includeChatActTier: true, includeChatDelegateTier: true });

describe("oppstartsporten med hele produksjonsregisteret + comms (alle 16 flaggkombinasjoner)", () => {
  it("kontroll: produksjonsregisteret alene (comms AV) består og gir en modellflate uten comms", () => {
    expect(() => assertManifestInvariants(buildToolManifest(base))).not.toThrow();
    expect(surfaceOf(base).some((m) => m.tool_id === "comms")).toBe(false);
  });

  it.each(Array.from({ length: 16 }, (_, mask) => mask))("maske %i: assertManifestInvariants (uten ignoreUnregisteredGrants) og modellflaten holder; ingen comms-handling på noen modellflate", (mask) => {
    const env: Record<string, string> = { JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "slack,sms,phone,whatsapp" };
    FL.forEach((f, i) => { if (mask & (1 << i)) env[f] = "on"; });
    const c = parseCommsConfig(env);
    const comms = commsToolDefinitions({ transport: { invoke: async () => ({}) } as never, store: {} as never, vendorReads: c.vendor_reads, calls: c.calls, contacts: c.contacts, meetings: c.meetings });
    const all = [...base, ...comms];
    const manifest = buildToolManifest(all);
    expect(() => assertManifestInvariants(manifest)).not.toThrow();
    const surface = surfaceOf(all);
    expect(surface.filter((m) => m.tool_id === "comms")).toEqual([]);
    for (const e of manifest.values()) if (e.key.startsWith("comms.")) expect(e.surfaces, e.key).toEqual([]);
    // ingen ikke-comms-oppføring har endret effekt/risiko av at comms er registrert (sammenlignet med kontrollen)
    const ref = buildToolManifest(base);
    for (const [k, e] of ref) { const m2 = manifest.get(k)!; expect(`${m2.risk}/${m2.effect}`, k).toBe(`${e.risk}/${e.effect}`); }
  });
});

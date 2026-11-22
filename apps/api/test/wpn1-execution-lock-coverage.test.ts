import { describe, expect, it } from "vitest";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  KnowledgeSearchTransport, MemorySearchTransport, buildToolManifest, firstWaveTools, homeAssistantTools, isFinancialNamespace, isSelectionLockedTool, knowledgeToolDefinitions, memoryToolDefinitions,
  type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";

/**
 * WP-N1 (K6): utførelseslåsen i ToolGateway dekker NØYAKTIG finansverktøyene som H1-invarianten (`wph1-restricted-tools-invariant.test.ts`) har akseptert som «valg-kun-lås» - ingen glipp mellom de to.
 * H1 godtok `/^finance(_[a-z]+)?$/` som kjent valg-kun-lås fra main; K6 lukker det med `isFinancialNamespace` (samme mønster som manifestet bruker for `restricted`/`financial`). Her låses at de to er like over HELE
 * produksjonsmanifestet, slik at et nytt `finance*`-navnerom som låses i utvalget men glipper forbi utførelseslåsen (eller omvendt) feiler en test i stedet for å bli en stille svakhet.
 */
const ACCEPTED_SELECTION_ONLY = /^finance(_[a-z]+)?$/;

function productionManifest() {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  const defs: ToolDefinition[] = firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, {}))),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never)),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never))
    ]
  });
  return { defs, manifest: buildToolManifest(defs) };
}

describe("utførelseslåsen (isFinancialNamespace) dekker nøyaktig de finansverktøyene H1 aksepterte som valg-kun-lås", () => {
  const { defs, manifest } = productionManifest();
  const entries = [...manifest.values()];

  it("hvert produksjonsverktøy hvis navnerom begynner med «finance» er et finansnavnerom (ingen glipp via siffer, bindestrek eller lignende)", () => {
    const financeLike = defs.filter((d) => d.tool_id.startsWith("finance"));
    expect(financeLike.length).toBeGreaterThan(60);
    for (const d of financeLike) expect(isFinancialNamespace(d.tool_id), `${d.tool_id}.${d.action}`).toBe(true);
  });

  it("de to mønstrene er like over produksjonsmanifestet: H1-listen (ACCEPTED_SELECTION_ONLY) og låsen peker på samme verktøy, og hvert slikt verktøy er `restricted` og låst i utvalget", () => {
    for (const e of entries) {
      expect(isFinancialNamespace(e.tool_id), `${e.key}`).toBe(ACCEPTED_SELECTION_ONLY.test(e.tool_id));
      if (isFinancialNamespace(e.tool_id)) {
        expect(e.sensitivity, e.key).toBe("restricted");
        expect(e.data_zone, e.key).toBe("financial");
        expect(isSelectionLockedTool(e.tool_id, e.action), e.key).toBe(true);
      }
    }
  });

  it("finansverktøyene på en modellflate (lese-nivået på web-chat) er alle dekket - ingen restricted finance*-handling står uten både utvalgslås og utførelseslås", () => {
    const onSurface = entries.filter((e) => isFinancialNamespace(e.tool_id) && e.surfaces.length > 0);
    expect(onSurface.length).toBeGreaterThan(20);
    for (const e of onSurface) {
      expect(isSelectionLockedTool(e.tool_id, e.action), e.key).toBe(true);
      expect(isFinancialNamespace(e.tool_id), e.key).toBe(true);
    }
  });
});

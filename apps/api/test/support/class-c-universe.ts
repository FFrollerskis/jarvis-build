import { ALL_CONTROL_CENTER_IDS, ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationSignalsTransport, SituationsTransport, situationSignalsToolDefinitions, situationsToolDefinitions } from "@jarvis/situations";
import { GROWTH_WRITE_PROVIDERS, growthExperimentToolDefinitions, growthWriteToolDefinitions } from "@jarvis/growth";
import { commsToolDefinitions } from "@jarvis/comms";
import {
  KnowledgeSearchTransport, MemorySearchTransport, carCriticalToolDefinitions, cloudControlToolDefinitions, firstWaveTools, homeAssistantTools, homeCriticalToolDefinitions,
  knowledgeToolDefinitions, memoryToolDefinitions, type ToolDefinition, type ToolGateway, type ToolTransport
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../../src/chat-jobs.ts";
import { RunRateTransport, runRateToolDefinitions } from "../../src/run-rate.ts";

/**
 * WP-AUTH2a: HELE verktøyregisteret slik produksjonen kan registrere det - ALLE flaggstyrte sett er med, med flaggene PÅ (kontrollsentre, golden-suite, autonomi-tilbakekall, evolusjonsavgjørelse, signaler med tilbakemelding,
 * kunnskapspåstander, alle åtte vekst-skriveplattformer, eksperimentregister, comms med leverandørlesing/kontakter/møter/samtaler, de kontrollerte skymålene, personlige hjem-/bilhandlinger). Ingen transport brukes: kun definisjonene.
 * Dekningsvakten og runbook-drift-testen bruker dette ene settet; en NY handling i en av fabrikkene dukker dermed opp der uten at noen må huske å legge den til.
 */
export function productionClassCUniverse(): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  const t = {} as unknown as ToolTransport;
  const growthTransports = Object.fromEntries(GROWTH_WRITE_PROVIDERS.map((p) => [p, t]));
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw)), { controlCenters: [...ALL_CONTROL_CENTER_IDS], goldenSuite: true, autonomyRevoke: true, evolutionApproval: true }),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never), { autonomyExpiry: true, autonomyScope: true }),
      ...situationSignalsToolDefinitions(new SituationSignalsTransport({} as never), { feedback: true }),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never), { claimWrites: true } as never),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never)),
      ...cloudControlToolDefinitions({}, {}),
      ...growthWriteToolDefinitions({ platforms: new Set(GROWTH_WRITE_PROVIDERS), targets: new Map(), creativeHosts: new Set() }, growthTransports as never),
      ...growthExperimentToolDefinitions(t),
      ...commsToolDefinitions({ transport: t, store: {} as never, vendorReads: true, contacts: true, meetings: true, calls: true }),
      ...homeCriticalToolDefinitions(t, { targets: new Set(), settleMs: 1, pollMs: 1 }),
      ...carCriticalToolDefinitions(t, { targets: new Set(), settleMs: 1, pollMs: 1 })
    ]
  });
}

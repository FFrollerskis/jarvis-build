import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions, type ExecutiveToolOptions } from "@jarvis/executive";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { KnowledgeSearchTransport, firstWaveTools, homeAssistantTools, knowledgeToolDefinitions, type ToolDefinition, type ToolGateway } from "@jarvis/tool-gateway";

/**
 * WP-H0: de REELLE verktøydefinisjonene produksjonen registrerer (første bølge + Home Assistant + executive + owner_controls + kunnskapssøk, WP-D1), uten nettverk (tomme transporter). Kontrollsenter-testene bruker dem slik at
 * connector-kartleggingen, risikoklassene og credential-refs som testes er de samme som i drift - ikke håndlagde etterlikninger.
 */
/** `options` (WP-H2): slår på de to flaggstyrte executive-verktøyene (`run_golden_suite`, `revoke_autonomy_binding`) slik produksjonen gjør med flaggene PÅ; standard er uendret (begge AV). */
export function productionToolDefinitions(options: ExecutiveToolOptions = {}): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw)), options),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never))
    ]
  });
}

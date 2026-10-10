import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { KnowledgeSearchTransport, firstWaveTools, homeAssistantTools, knowledgeToolDefinitions, type ToolDefinition, type ToolGateway } from "@jarvis/tool-gateway";

/**
 * WP-H0: de REELLE verktøydefinisjonene produksjonen registrerer (første bølge + Home Assistant + executive + owner_controls + kunnskapssøk, WP-D1), uten nettverk (tomme transporter). Kontrollsenter-testene bruker dem slik at
 * connector-kartleggingen, risikoklassene og credential-refs som testes er de samme som i drift - ikke håndlagde etterlikninger.
 */
export function productionToolDefinitions(): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw))),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never))
    ]
  });
}

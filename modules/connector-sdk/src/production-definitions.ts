import {
  cloudControlToolDefinitions, firstWaveTools, homeAssistantTools,
  type ToolDefinition
} from "@jarvis/tool-gateway";

/**
 * WP-I (D-472): de registrerte CONNECTOR-verktøydefinisjonene slik produksjonen registrerer dem (`apps/api/src/main.ts`, den ENE `toolGateway.register(tool)`-løkken), men uten transporter:
 * `firstWaveTools` (alle leverandørverktøy), Home Assistant og de kontrollerte skymålene (Cloudflare/Langfuse/Infisical/Postgres-drift). Alle faktaene manifestene beskriver (klasse, effekt,
 * tidsavbrudd, rate limit, credential, skjema) er uavhengige av transporten, så uten-transport-varianten gir NØYAKTIG samme fakta. Ingen nettverk, ingen DB, ingen secrets.
 *
 * Jarvis-interne domenenavnerom (business/support/growth/executive/owner_controls/...) er IKKE connectorer og er bevisst utelatt: de bruker den interne credentialen og tilhører ingen registeroppføring.
 * Drift-testen i apps/api (`wpi-connector-sdk-drift.test.ts`) sjekker at dette settet gir samme handlinger per connector som Integrasjonssenteret ser med SAMME sett (samme liste til begge sider).
 *
 * DEFERRED RISIKO (review M5): dette er et HÅNDFØRT SPEIL av hva `apps/api/src/main.ts` registrerer i den ene `toolGateway.register(tool)`-løkken (`firstWaveTools(...)` + `additionalTools`). Drift-testen kan ikke se at main.ts får en ny
 * connector-bundet verktøyfamilie som ikke er med her, fordi begge sider får denne listen. Delvis dekning som finnes: `derive.test.ts` feller en NY BYGD registeroppføring som ikke får en eneste handling herfra
 * («bygde connectorer har handlinger»). IKKE dekket: en ny verktøyfamilie bundet til en EKSISTERENDE connectors credential. Lukkes først når main.ts og SDK-et deler ÉN liste (en delt fabrikkfunksjon i
 * @jarvis/tool-gateway som begge kaller) - en endring i kjøretidskoden som WP-I bevisst ikke gjør. Se runbook §11.
 */
export function productionConnectorDefinitions(): ToolDefinition[] {
  return [...firstWaveTools({}), ...homeAssistantTools(), ...cloudControlToolDefinitions({}, {})];
}

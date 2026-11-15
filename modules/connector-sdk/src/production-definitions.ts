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
 * Drift-testen i apps/api (`wpi-connector-sdk-drift.test.ts`) sjekker at dette settet gir samme handlinger per connector som Integrasjonssenteret ser med hele produksjonssettet.
 */
export function productionConnectorDefinitions(): ToolDefinition[] {
  return [...firstWaveTools({}), ...homeAssistantTools(), ...cloudControlToolDefinitions({}, {})];
}

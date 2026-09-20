import type { JsonValue } from "@jarvis/contracts";
import type { ToolGateway } from "./gateway.ts";

/**
 * Task #119 (integrasjons-dashboard, D-211): kanonisk, eier-vendt liste over
 * hver leverandør-tilkobling `docs/INTEGRATIONS.md` (§3 "første bølge") og de
 * allerede bygde finans-connectorene (`.env.example`) nevner. RENT DATA -
 * ingen egen kallelogikk her utover selve statuskomposisjonen under.
 *
 * `live_test` er BEVISST kun satt for de tre leverandørene som allerede har
 * en bevist, trygg, klasse A-lesehandling UTEN sideeffekt gjennom
 * `ToolGateway` (samme handlinger som `mesh-bridge.ts` sin `MESH_TOOLS`
 * allerede stoler på for chat-verktøy) - GitHub/Calendar/Gmail. Resten
 * rapporterer KUN presence (er credential-referansen konfigurert eller ikke)
 * - BEVISST AVGRENSET, ikke stille utelatt: å utvide `live_test` til flere
 * connectorer (Drive/Vercel/Telegram/finans/modell-leverandører) er egen,
 * senere oppgave (se D-211).
 */
export interface ConnectorDefinition {
  id: string;
  display_name: string;
  category: "tool_gateway" | "model_provider" | "finance" | "infra";
  /** Secret-referanser (env/vault-nøkler) DENNE connectoren trenger - ALDRI verdiene selv. */
  credential_refs: string[];
  /**
   * `parameters` er en FUNKSJON (samme presedens som `MeshToolMapping.
   * parameters` i `mesh-bridge.ts`), IKKE en statisk verdi - for
   * tidsvinduer (f.eks. kalender sin "i dag") må parametrene bygges FRISKT
   * ved selve testkallet, ikke frosset til modul-lastetidspunktet.
   */
  live_test?: { tool_id: string; action: string; parameters: () => Record<string, JsonValue> };
}

export const CONNECTOR_REGISTRY: ConnectorDefinition[] = [
  {
    id: "github", display_name: "GitHub", category: "tool_gateway",
    credential_refs: ["JARVIS_GITHUB_TOKEN"],
    live_test: { tool_id: "github", action: "read_issues", parameters: () => ({ repo: process.env["JARVIS_GITHUB_REPO"] ?? "tsworkflow/jarvisbuild" }) }
  },
  {
    id: "google_calendar", display_name: "Google Calendar", category: "tool_gateway",
    credential_refs: ["JARVIS_GOOGLE_TOKEN"],
    // SAMME "dagens hendelser"-vindu som `mesh-bridge.ts` sin `read_calendar_today` allerede bygger.
    live_test: {
      tool_id: "calendar", action: "read_events",
      parameters: () => {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000).toISOString() };
      }
    }
  },
  {
    id: "gmail", display_name: "Gmail", category: "tool_gateway",
    credential_refs: ["JARVIS_EMAIL_TOKEN"],
    live_test: { tool_id: "email", action: "read_inbox", parameters: () => ({ max: 1 }) }
  },
  { id: "google_drive", display_name: "Google Drive/Docs", category: "tool_gateway", credential_refs: ["JARVIS_GOOGLE_TOKEN"] },
  { id: "telegram", display_name: "Telegram", category: "tool_gateway", credential_refs: ["JARVIS_TELEGRAM_TOKEN"] },
  { id: "vercel", display_name: "Vercel", category: "tool_gateway", credential_refs: ["JARVIS_VERCEL_TOKEN"] },
  { id: "anthropic", display_name: "Anthropic API", category: "model_provider", credential_refs: ["ANTHROPIC_API_KEY"] },
  { id: "openai", display_name: "OpenAI API", category: "model_provider", credential_refs: ["OPENAI_API_KEY"] },
  { id: "gemini", display_name: "Gemini API", category: "model_provider", credential_refs: ["GEMINI_API_KEY"] },
  { id: "fiken", display_name: "Fiken", category: "finance", credential_refs: ["JARVIS_FIKEN_CLIENT_ID", "JARVIS_FIKEN_CLIENT_SECRET", "JARVIS_FIKEN_REFRESH_TOKEN"] },
  { id: "stripe", display_name: "Stripe", category: "finance", credential_refs: ["JARVIS_STRIPE_SECRET_KEY"] },
  { id: "vipps", display_name: "Vipps", category: "finance", credential_refs: ["JARVIS_VIPPS_CLIENT_ID", "JARVIS_VIPPS_CLIENT_SECRET", "JARVIS_VIPPS_SUBSCRIPTION_KEY"] },
  { id: "neonomics", display_name: "Neonomics", category: "finance", credential_refs: ["JARVIS_NEONOMICS_CLIENT_ID", "JARVIS_NEONOMICS_CLIENT_SECRET"] },
  { id: "wallester", display_name: "Wallester", category: "finance", credential_refs: ["JARVIS_WALLESTER_API_KEY", "JARVIS_WALLESTER_PRIVATE_KEY_PEM"] }
];

export interface ConnectorStatus {
  id: string;
  display_name: string;
  category: ConnectorDefinition["category"];
  /** true kun når ALLE påkrevde credential-referanser er konfigurert. */
  configured: boolean;
  /** Per-referanse presence, i SAMME rekkefølge som `credential_refs` - ALDRI selve verdien. */
  credentials: Array<{ ref: string; configured: boolean }>;
  test_method: "live" | "presence_only";
  health: { state: string; at: string; detail?: string } | null;
}

/**
 * `gateway` brukes UTELUKKENDE for `hasSecret()` (presence, aldri verdi) og
 * det allerede eksponerte `health`-kartet (BO-03) - INGEN nye kall gjøres her,
 * `live_test` er metadata for en SENERE, eksplisitt "test connector"-handling
 * (egen oppgave, se filhode).
 */
export async function listConnectorStatus(
  gateway: Pick<ToolGateway, "hasSecret" | "health">
): Promise<ConnectorStatus[]> {
  return Promise.all(
    CONNECTOR_REGISTRY.map(async (def) => {
      const credentials = await Promise.all(
        def.credential_refs.map(async (ref) => ({ ref, configured: await gateway.hasSecret(ref) }))
      );
      return {
        id: def.id, display_name: def.display_name, category: def.category,
        configured: credentials.every((c) => c.configured),
        credentials,
        test_method: def.live_test ? "live" : "presence_only",
        health: gateway.health.get(def.live_test?.tool_id ?? def.id) ?? null
      };
    })
  );
}

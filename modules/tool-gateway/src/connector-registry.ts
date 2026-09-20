import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type { ToolGateway } from "./gateway.ts";

/**
 * Task #119 (integrasjons-dashboard, D-211): kanonisk, eier-vendt liste over
 * hver leverandør-tilkobling `docs/INTEGRATIONS.md` (§3 "første bølge") og de
 * allerede bygde finans-connectorene (`.env.example`) nevner. RENT DATA -
 * ingen egen kallelogikk her utover selve statuskomposisjonen under.
 *
 * Task #122 (D-213) utvidet `live_test` til 8 av 14 connectorer - GitHub/
 * Calendar/Gmail (D-211, uendret) + Google Drive/Vercel/Telegram/Neonomics/
 * Wallester (nye, hver en allerede eksisterende, verifisert klasse A/
 * side-effektfri lesehandling gjennom `ToolGateway` - Telegrams
 * `get_bot_info` (`getMe`) ble lagt til AKKURAT for dette formålet, siden
 * `telegram.notify` sender en EKTE melding og derfor aldri kunne vært en
 * trygg test). **BEVISST FORTSATT presence_only, eksplisitt avgrenset:**
 * Fiken/Stripe/Vipps mangler en eksisterende ToolGateway-lesehandling UTEN
 * enten en Stripe/Vipps-side-effekt (create_payment_intent er en reell
 * providerobjekt-opprettelse, selv om idempotent) eller en forhåndsbetingelse
 * (eksisterende samtykke/kort) - å bygge én er en EGEN, senere oppgave, ikke
 * gjettet frem her. Anthropic/OpenAI/Gemini konsumeres via `ModelGateway`,
 * en HELT ANNEN kallevei enn `ToolGateway` (ingen tool_id/action finnes for
 * dem) - et "test denne modell-nøkkelen"-probe hører hjemme i
 * `ModelGateway` selv, ikke tvunget inn i dette connector-test-mønsteret.
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
   * ved selve testkallet, ikke frosset til modul-lastetidspunktet. Task #122:
   * tar nå (valgfritt brukt) den KALLENDE identiteten - noen leverandør-
   * lesinger (Neonomics/Wallester) er tenant-scopet og trenger
   * `identity.tenant_id`, som ALDRI kan være en modul-lastetidspunkt-konstant.
   */
  live_test?: { tool_id: string; action: string; parameters: (identity: IdentityContext) => Record<string, JsonValue> };
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
  {
    id: "google_drive", display_name: "Google Drive/Docs", category: "tool_gateway",
    credential_refs: ["JARVIS_GOOGLE_TOKEN"],
    // Uten `folder_id` lister `drive.list_files` roten av driven - samme
    // trygge, side-effektfrie klasse A-lesing `drive-source.ts` allerede bruker.
    live_test: { tool_id: "drive", action: "list_files", parameters: () => ({}) }
  },
  {
    id: "telegram", display_name: "Telegram", category: "tool_gateway", credential_refs: ["JARVIS_TELEGRAM_TOKEN"],
    // `telegram.notify` er en EKTE meldingsutsendelse (klasse B) - aldri
    // trygg som test. `get_bot_info` (Telegram Bot API sin `getMe`, lagt til
    // i live-transports.ts AKKURAT for dette formålet) krever kun boten sin
    // egen token, ingen chat_id, og har INGEN sideeffekt.
    live_test: { tool_id: "telegram", action: "get_bot_info", parameters: () => ({}) }
  },
  {
    id: "vercel", display_name: "Vercel", category: "tool_gateway", credential_refs: ["JARVIS_VERCEL_TOKEN"],
    live_test: { tool_id: "vercel", action: "read_deployments", parameters: () => ({}) }
  },
  { id: "anthropic", display_name: "Anthropic API", category: "model_provider", credential_refs: ["ANTHROPIC_API_KEY"] },
  { id: "openai", display_name: "OpenAI API", category: "model_provider", credential_refs: ["OPENAI_API_KEY"] },
  { id: "gemini", display_name: "Gemini API", category: "model_provider", credential_refs: ["GEMINI_API_KEY"] },
  { id: "fiken", display_name: "Fiken", category: "finance", credential_refs: ["JARVIS_FIKEN_CLIENT_ID", "JARVIS_FIKEN_CLIENT_SECRET", "JARVIS_FIKEN_REFRESH_TOKEN"] },
  { id: "stripe", display_name: "Stripe", category: "finance", credential_refs: ["JARVIS_STRIPE_SECRET_KEY"] },
  { id: "vipps", display_name: "Vipps", category: "finance", credential_refs: ["JARVIS_VIPPS_CLIENT_ID", "JARVIS_VIPPS_CLIENT_SECRET", "JARVIS_VIPPS_SUBSCRIPTION_KEY"] },
  {
    id: "neonomics", display_name: "Neonomics", category: "finance",
    credential_refs: ["JARVIS_NEONOMICS_CLIENT_ID", "JARVIS_NEONOMICS_CLIENT_SECRET"],
    // Katalogoppslag (bankene Neonomics dekker) - krever INGEN eksisterende
    // banksamtykke, kun gyldige API-credentials. Ren lesing, klasse A.
    live_test: { tool_id: "finance_neonomics", action: "list_banks", parameters: (identity) => ({ tenant_id: identity.tenant_id }) }
  },
  {
    id: "wallester", display_name: "Wallester", category: "finance",
    credential_refs: ["JARVIS_WALLESTER_API_KEY", "JARVIS_WALLESTER_PRIVATE_KEY_PEM"],
    // Leverandørkontosaldo - "read-only provider-tilstand", uavhengig av om
    // noe kort faktisk er utstedt ennå. Ren lesing, klasse A.
    live_test: { tool_id: "finance_wallester", action: "get_provider_balance", parameters: (identity) => ({ tenant_id: identity.tenant_id }) }
  }
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

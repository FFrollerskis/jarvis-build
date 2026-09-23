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
 *
 * D-232 (2026-09-22, Tobias direkte chat-instruks: "Legg de til i dashbordet
 * selv om de ikke er klare for tilkobling så de er der"): la til de 50
 * `NY_BACKLOG`-punktene fra D-231/`docs/INTEGRATIONS.md` §4 som SYNLIGE, men
 * strukturelt "ikke bygget"-oppføringer - `category: "backlog"` (44 stk) og
 * `category: "backlog_d64_gate"` (de seks D-64-port-krevende CRM-/
 * prosjektstyrings-leverandørene: HubSpot/Pipedrive/Linear/Jira/Trello/
 * Todoist, jf. CLAUDE.md regel 12/D-64 sitt eget Zendesk-eksempel) er to NYE
 * `category`-verdier, bevisst adskilt fra de fire ekte, bygde kategoriene
 * over - `listConnectorStatus()`/dashboardet trenger INGEN kodeendring for
 * dette (kategorien rendres allerede som en ren `escapeHtml(c.category)`-
 * pill, se `apps/web/dashboard.html`), men verdien selv gjør skillet
 * "bygget vs. backlog" synlig for et menneske uten å oppfinne en ny visuell
 * tilstand. INGEN av de 50 har `live_test` (ingen ToolGateway-handling
 * finnes for dem ennå - et testforsøk ville feile forvirrende, ikke gi en
 * ærlig "ikke bygget"-melding) - de rendrer derfor automatisk identisk med
 * en eksisterende `presence_only`, ukonfigurert connector (Fiken/Stripe/
 * Vipps-mønsteret). BEVISST UTELATT (se D-231/D-232 i
 * DECISIONS_AND_ASSUMPTIONS.md for full begrunnelse): Supabase (Q-36),
 * Neo4j (Q-37), 1Password (Q-38) - åpne, uavklarte spørsmål, en registrering
 * nå ville sett ut som en stille godkjenning; Windows/macOS (Q-39) - eksplisitt
 * `IKKE EN CONNECTOR`, ingen ekstern leverandør-API i ToolGateway-forstand.
 * Dette er en RENT SYNLIGHETS-tiltak - INGEN D-64-Core-vs-Adapter-port er
 * kjørt for noen av disse 50, INGEN kode/credential-oppsett er gjort, D-108
 * (`EXTERNAL_CREDENTIAL_SETUP_POLICY=DEFER_UNTIL_FINAL_INTEGRATION_PHASE`)
 * gjelder uendret.
 */
export interface ConnectorDefinition {
  id: string;
  display_name: string;
  category: "tool_gateway" | "model_provider" | "finance" | "infra" | "backlog" | "backlog_d64_gate";
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
  // D-246: `JARVIS_VIPPS_MSN` (merchant serial number) lagt til - samme
  // "credential_refs ufullstendig relativt til getCredentials()"-bug-klasse
  // som D-245 fant for Neonomics sin DEVICE_ID.
  { id: "vipps", display_name: "Vipps", category: "finance", credential_refs: ["JARVIS_VIPPS_CLIENT_ID", "JARVIS_VIPPS_CLIENT_SECRET", "JARVIS_VIPPS_SUBSCRIPTION_KEY", "JARVIS_VIPPS_MSN"] },
  {
    // D-245 (2026-09-23, funnet LIVE av Tobias): `neonomicsCredentialsProvider.
    // getCredentials()` (apps/api/src/main.ts) har ALLTID krevd
    // `JARVIS_NEONOMICS_DEVICE_ID` (en Jarvis-generert, stabil enhets-UUID -
    // `x-device-id`-headeren Neonomics knytter samtykke/sesjon til, IKKE noe
    // Tobias henter FRA Neonomics) i tillegg til CLIENT_ID/SECRET - men denne
    // listen manglet den, så dashbordets "lim inn ny verdi"-felt ble ALDRI
    // vist for den. Testknappen kunne derfor ALDRI lykkes uansett hvilken
    // CLIENT_ID/SECRET som ble limt inn (`neonomics_credentials_unavailable`
    // uavhengig av dem). Samme "kravt credential mangler i registeret"-
    // klasse som D-236 (tom streng behandlet som satt) - her manglet
    // referansen helt. Fiks: DEVICE_ID lagt til i `credential_refs`.
    id: "neonomics", display_name: "Neonomics", category: "finance",
    credential_refs: ["JARVIS_NEONOMICS_CLIENT_ID", "JARVIS_NEONOMICS_CLIENT_SECRET", "JARVIS_NEONOMICS_DEVICE_ID"],
    // Katalogoppslag (bankene Neonomics dekker) - krever INGEN eksisterende
    // banksamtykke, kun gyldige API-credentials. Ren lesing, klasse A.
    live_test: { tool_id: "finance_neonomics", action: "list_banks", parameters: (identity) => ({ tenant_id: identity.tenant_id }) }
  },
  {
    // D-246: `JARVIS_WALLESTER_API_BASE_URL`/`JARVIS_WALLESTER_ACCOUNT_ID`
    // lagt til - samme bug-klasse som D-245/Vipps over.
    id: "wallester", display_name: "Wallester", category: "finance",
    credential_refs: ["JARVIS_WALLESTER_API_KEY", "JARVIS_WALLESTER_PRIVATE_KEY_PEM", "JARVIS_WALLESTER_API_BASE_URL", "JARVIS_WALLESTER_ACCOUNT_ID"],
    // Leverandørkontosaldo - "read-only provider-tilstand", uavhengig av om
    // noe kort faktisk er utstedt ennå. Ren lesing, klasse A.
    live_test: { tool_id: "finance_wallester", action: "get_provider_balance", parameters: (identity) => ({ tenant_id: identity.tenant_id }) }
  },

  // --- D-232 backlog-synlighet (D-231 `NY_BACKLOG`, `docs/INTEGRATIONS.md` §4) ---------------
  // INGEN `live_test` for noen oppføring under - se filhode-kommentaren for full begrunnelse.
  // Rekkefølge følger `docs/INTEGRATIONS.md` §4 sine underseksjoner (4.3->4.15).

  // §4.3 Kunnskap / dokumenter
  { id: "notion", display_name: "Notion", category: "backlog", credential_refs: ["JARVIS_NOTION_API_KEY"] },
  { id: "onedrive", display_name: "OneDrive", category: "backlog", credential_refs: ["JARVIS_ONEDRIVE_TOKEN"] },
  { id: "dropbox", display_name: "Dropbox", category: "backlog", credential_refs: ["JARVIS_DROPBOX_TOKEN"] },
  { id: "google_sheets", display_name: "Google Sheets", category: "backlog", credential_refs: ["JARVIS_GOOGLE_SHEETS_TOKEN"] },

  // §4.4 Produktivitet / e-post / kalender
  { id: "microsoft_outlook", display_name: "Microsoft Outlook", category: "backlog", credential_refs: ["JARVIS_OUTLOOK_TOKEN"] },
  { id: "microsoft_365", display_name: "Microsoft 365", category: "backlog", credential_refs: ["JARVIS_MICROSOFT_365_TOKEN"] },

  // §4.5 Kode / dev / infra
  { id: "google_cloud", display_name: "Google Cloud", category: "backlog", credential_refs: ["JARVIS_GOOGLE_CLOUD_API_KEY"] },

  // §4.6 Søk / browser
  { id: "brave_search", display_name: "Brave Search", category: "backlog", credential_refs: ["JARVIS_BRAVE_SEARCH_API_KEY"] },
  { id: "tavily", display_name: "Tavily", category: "backlog", credential_refs: ["JARVIS_TAVILY_API_KEY"] },
  { id: "exa", display_name: "Exa", category: "backlog", credential_refs: ["JARVIS_EXA_API_KEY"] },
  { id: "playwright", display_name: "Playwright", category: "backlog", credential_refs: ["JARVIS_PLAYWRIGHT_API_KEY"] },

  // §4.7 Tale / video / media-AI
  { id: "openai_realtime", display_name: "OpenAI Realtime", category: "backlog", credential_refs: ["JARVIS_OPENAI_REALTIME_API_KEY"] },
  { id: "elevenlabs", display_name: "ElevenLabs", category: "backlog", credential_refs: ["JARVIS_ELEVENLABS_API_KEY"] },
  { id: "deepgram", display_name: "Deepgram", category: "backlog", credential_refs: ["JARVIS_DEEPGRAM_API_KEY"] },
  { id: "livekit", display_name: "LiveKit", category: "backlog", credential_refs: ["JARVIS_LIVEKIT_API_KEY"] },
  { id: "telnyx", display_name: "Telnyx", category: "backlog", credential_refs: ["JARVIS_TELNYX_API_KEY"] },
  { id: "twilio", display_name: "Twilio", category: "backlog", credential_refs: ["JARVIS_TWILIO_ACCOUNT_SID", "JARVIS_TWILIO_AUTH_TOKEN"] },
  { id: "whatsapp", display_name: "WhatsApp", category: "backlog", credential_refs: ["JARVIS_WHATSAPP_TOKEN"] },
  { id: "slack", display_name: "Slack", category: "backlog", credential_refs: ["JARVIS_SLACK_BOT_TOKEN"] },
  { id: "discord", display_name: "Discord", category: "backlog", credential_refs: ["JARVIS_DISCORD_BOT_TOKEN"] },
  { id: "higgsfield", display_name: "Higgsfield", category: "backlog", credential_refs: ["JARVIS_HIGGSFIELD_API_KEY"] },
  { id: "runway", display_name: "Runway", category: "backlog", credential_refs: ["JARVIS_RUNWAY_API_KEY"] },
  { id: "kling", display_name: "Kling", category: "backlog", credential_refs: ["JARVIS_KLING_API_KEY"] },
  { id: "google_veo", display_name: "Google Veo", category: "backlog", credential_refs: ["JARVIS_GOOGLE_VEO_API_KEY"] },
  { id: "openai_images", display_name: "OpenAI Images", category: "backlog", credential_refs: ["JARVIS_OPENAI_IMAGES_API_KEY"] },

  // §4.8 Musikk
  { id: "spotify", display_name: "Spotify", category: "backlog", credential_refs: ["JARVIS_SPOTIFY_CLIENT_ID", "JARVIS_SPOTIFY_CLIENT_SECRET"] },
  { id: "apple_music", display_name: "Apple Music", category: "backlog", credential_refs: ["JARVIS_APPLE_MUSIC_TOKEN"] },

  // §4.9 Automatisering / workflow
  { id: "n8n", display_name: "n8n", category: "backlog", credential_refs: ["JARVIS_N8N_API_KEY"] },
  { id: "zapier", display_name: "Zapier", category: "backlog", credential_refs: ["JARVIS_ZAPIER_API_KEY"] },
  { id: "make", display_name: "Make", category: "backlog", credential_refs: ["JARVIS_MAKE_API_KEY"] },
  { id: "apple_shortcuts", display_name: "Apple Shortcuts", category: "backlog", credential_refs: ["JARVIS_APPLE_SHORTCUTS_TOKEN"] },

  // §4.10 Smart hjem
  { id: "homekit", display_name: "HomeKit", category: "backlog", credential_refs: ["JARVIS_HOMEKIT_TOKEN"] },
  { id: "philips_hue", display_name: "Philips Hue", category: "backlog", credential_refs: ["JARVIS_PHILIPS_HUE_API_KEY"] },

  // §4.11 Finans / CRM / ads / prosjektstyring
  { id: "folio", display_name: "Folio", category: "backlog", credential_refs: ["JARVIS_FOLIO_API_KEY"] },
  // D-64-port påkrevd (CLAUDE.md regel 12) - synlighet her er IKKE en avgjort domeneeier-status.
  { id: "hubspot", display_name: "HubSpot", category: "backlog_d64_gate", credential_refs: ["JARVIS_HUBSPOT_API_KEY"] },
  { id: "pipedrive", display_name: "Pipedrive", category: "backlog_d64_gate", credential_refs: ["JARVIS_PIPEDRIVE_API_KEY"] },
  { id: "meta_ads", display_name: "Meta Ads", category: "backlog", credential_refs: ["JARVIS_META_ADS_TOKEN"] },
  { id: "linear", display_name: "Linear", category: "backlog_d64_gate", credential_refs: ["JARVIS_LINEAR_API_KEY"] },
  { id: "jira", display_name: "Jira", category: "backlog_d64_gate", credential_refs: ["JARVIS_JIRA_API_TOKEN"] },
  { id: "trello", display_name: "Trello", category: "backlog_d64_gate", credential_refs: ["JARVIS_TRELLO_API_KEY", "JARVIS_TRELLO_TOKEN"] },
  { id: "todoist", display_name: "Todoist", category: "backlog_d64_gate", credential_refs: ["JARVIS_TODOIST_API_TOKEN"] },

  // §4.12 Kart
  { id: "google_maps", display_name: "Google Maps", category: "backlog", credential_refs: ["JARVIS_GOOGLE_MAPS_API_KEY"] },
  { id: "google_places", display_name: "Google Places", category: "backlog", credential_refs: ["JARVIS_GOOGLE_PLACES_API_KEY"] },
  { id: "google_routes", display_name: "Google Routes", category: "backlog", credential_refs: ["JARVIS_GOOGLE_ROUTES_API_KEY"] },

  // §4.13 Observability
  { id: "sentry", display_name: "Sentry", category: "backlog", credential_refs: ["JARVIS_SENTRY_API_TOKEN"] },
  { id: "grafana", display_name: "Grafana", category: "backlog", credential_refs: ["JARVIS_GRAFANA_API_KEY"] },
  { id: "prometheus", display_name: "Prometheus", category: "backlog", credential_refs: ["JARVIS_PROMETHEUS_TOKEN"] },

  // §4.15 OS / enhet (Windows/macOS er BEVISST UTELATT - IKKE EN CONNECTOR, Q-39)
  { id: "apns", display_name: "Apple Push Notification service", category: "backlog", credential_refs: ["JARVIS_APNS_AUTH_KEY"] },
  { id: "ios_shortcuts", display_name: "iOS Shortcuts", category: "backlog", credential_refs: ["JARVIS_IOS_SHORTCUTS_TOKEN"] },
  { id: "apple_watch", display_name: "Apple Watch", category: "backlog", credential_refs: ["JARVIS_APPLE_WATCH_TOKEN"] }
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

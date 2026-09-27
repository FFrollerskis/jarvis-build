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
 * trygg test).
 *
 * D-242 (2026-09-22, Tobias direkte chat-instruks: "du skal bygge det for
 * absolutt alle som tester en gang om dagen så vi vet om credentials
 * fungerer eller ikke hele tiden") utvidet `live_test` videre til 11 av 14
 * - `vercel` fikk ENDELIG en ekte transport (`live-transports.ts` sin
 * `VercelTransport` - `live_test` eksisterte siden D-213, men falt HELE
 * TIDEN gjennom til `UnconfiguredHttpTransport` fordi `main.ts`/
 * `worker-main.ts` aldri koblet inn en ekte transport, se doc-kommentaren
 * der for full begrunnelse), og Fiken/Stripe/Vipps fikk hver sin NYE, trygge
 * klasse A-probe (`finance.list_companies`/`finance_stripe.get_balance`/
 * `finance_vipps.check_credentials` - alle GET/token-sjekk-baserte, INGEN
 * mutasjon, se `service.ts` sine `listFikenCompanies()`/`getStripeBalance()`/
 * `checkVippsCredentials()`-doc-kommentarer). En ny `ConnectorHealthSweep`
 * (`connector-health-sweep.ts`) kjører NÅ `test_connector`-EKVIVALENTE kall
 * mot HVER av disse 11 daglig via `DailyScheduler` (`main.ts`), slik at
 * `ToolGateway.health` (BO-03, allerede lest av `listConnectorStatus()`
 * under) er FRISK selv for en connector ingen annen reell trafikk nylig
 * brukte - IKKE et nytt persisteringslag, gjenbruker BEVISST den samme
 * BO-03-mekanismen `test_connector` allerede skriver til, samme "ett sted
 * eier helsetilstanden"-disiplin. **BEVISST FORTSATT presence_only, eksplisitt
 * avgrenset:** Anthropic/OpenAI/Gemini konsumeres via `ModelGateway`, en
 * HELT ANNEN kallevei enn `ToolGateway` (ingen tool_id/action finnes for
 * dem) - et "test denne modell-nøkkelen"-probe hører hjemme i
 * `ModelGateway` selv, ikke tvunget inn i dette connector-test-mønsteret;
 * dette er en EGEN, senere oppgave, ikke gjettet frem her.
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
 *
 * D-292 (2026-09-26, Tobias direkte i chat: "jeg vil at alt i planen skal
 * bygges og fullføres"): `slack` er FØRSTE av disse 50 backlog-punktene som
 * faktisk er bygget - oppføringen ble oppdatert I PLACE (samme id, flyttet
 * fra `category: "backlog"` til `"tool_gateway"` med en ny `live_test`),
 * ALDRI duplisert som en ny, separat oppføring - se `connector-registry.
 * test.ts` sitt unikhetskrav.
 *
 * D-294 (2026-09-27, samme brede ordre, andre slice): `discord` bygget og
 * flyttet ut av backlogen SAMME MÅTE - oppdatert i place, ikke duplisert
 * (D-293 sin lærdom fra Slack-PR-en - en tidligere PR-CI-regresjon fra
 * nettopp DENNE feilen, alltid `grep` for en eksisterende id FØRST).
 *
 * D-295 (2026-09-27, samme brede ordre, tredje slice): `twilio` bygget og
 * flyttet ut av backlogen SAMME MÅTE.
 *
 * D-296 (2026-09-27, samme brede ordre, fjerde slice): `brave_search` bygget
 * og flyttet ut av backlogen SAMME MÅTE - FØRSTE rent lesende (klasse A-kun)
 * connector i denne rekken, D-41 sitt read-only-unntak ærlig oppfylt (Brave
 * Search sitt API tilbyr genuint ingen skrivehandling).
 *
 * D-297 (2026-09-27, samme brede ordre, femte slice): `sentry` bygget og
 * flyttet ut av backlogen SAMME MÅTE. **Merk:** dette øktens miljø blokkerer
 * utgående nettverkstrafikk til eksterne dokumentasjonsdomener (bekreftet via
 * `WebFetch` under bygging - se D-297 i DECISIONS_AND_ASSUMPTIONS.md) - API-
 * formen er derfor basert på trent kunnskap om Sentry sitt offentlige, stabile
 * REST-API v0, IKKE en denne-økten-bekreftet kilde slik D-292/D-294/D-295/
 * D-296 kunne. `SENTRY_LIVE_GATE` krever derfor en ekte live-test med et ekte
 * token FØR `LIVE_VERIFIED` kan påstås, sterkere enn de forrige fire.
 *
 * D-298 (2026-09-27, samme brede ordre, sjette slice): `google_maps` bygget
 * og flyttet ut av backlogen SAMME MÅTE - BEVISST AVGRENSET til KUN
 * Geocoding, `google_places`/`google_routes` forblir separate, ubygde
 * backlog-punkter. Samme D-297-forbehold gjelder (trent kunnskap, ikke
 * denne-økten-bekreftet).
 *
 * D-299 (2026-09-27, samme brede ordre, syvende slice): `google_sheets`
 * bygget og flyttet ut av backlogen SAMME MÅTE - gjenbruker EKSISTERENDE
 * `googleAccessToken()`-OAuth-vei (Gmail/Calendar/Drive), men med sin EGEN
 * `credential_ref` (Sheets krever den dedikerte `spreadsheets`-scopen, Drive
 * sin bredere scope dekker den ikke). D-41 sitt "maksimal nyttig kapabilitet"
 * fulgt - EKTE skrivehandlinger (`update_range`/`append_row`), ikke kunstig
 * innsnevret til read-only.
 *
 * D-300 (2026-09-27, samme økt, Tobias direkte i chat etter live telefontest:
 * "husker han ingenting... vi trodde det fungerte fungerte det ikke"): INGEN
 * connector-endring - kritisk minnefiks, `RuleBasedExtractor` erstattet av
 * `LlmExtractionAdapter` i `apps/api/src/main.ts`, se `modules/memory/src/
 * extraction.ts`. Nevnt her kun for kronologisk sporbarhet i denne filens
 * D-nummer-rekke.
 *
 * D-301 (2026-09-27, samme brede ordre, åttende slice): `tavily` bygget og
 * flyttet ut av backlogen SAMME MÅTE - andre rent lesende (klasse A-kun)
 * connector (samme D-41 read-only-unntak som Brave Search: Tavily sitt API
 * tilbyr genuint ingen skrivehandling). Samme D-297-forbehold gjelder (trent
 * kunnskap om ett kjent endepunkt, `POST /search`, ikke denne-økten-
 * bekreftet). De resterende 42 backlog-punktene er fortsatt uendret; samme
 * oppdater-i-place-disiplin gjelder for hver av dem når de bygges.
 *
 * D-302 (2026-09-27, samme brede ordre, niende slice, Tobias direkte i chat:
 * "fortsett og jobbe ikke vent på ci"): `exa` bygget og flyttet ut av
 * backlogen SAMME MÅTE - tredje rent lesende (klasse A-kun) connector (samme
 * D-41 read-only-unntak som Brave Search/Tavily). Exa sitt nevrale søke-API
 * har TO separate, egne endepunkter (`POST /search` og `POST /findSimilar`),
 * ULIK Tavily (som deler ETT endepunkt via et body-felt) - `find_similar` er
 * derfor et EGET kall, ikke en variant av `web_search`. Samme D-297-forbehold
 * gjelder (trent kunnskap, ikke denne-økten-bekreftet). De resterende 41
 * backlog-punktene er fortsatt uendret; samme oppdater-i-place-disiplin
 * gjelder for hver av dem når de bygges.
 *
 * D-303 (2026-09-27, samme brede ordre, tiende slice, bygget parallelt mens
 * D-302 sin CI kjørte): `google_places` bygget og flyttet ut av backlogen
 * SAMME MÅTE - BEVISST samme D-64-domenevurdering som Google Maps (D-298):
 * stateless tredjeparts-stedoppslag, IKKE eierens egen posisjon/geofence
 * (`modules/location`). Bruker det ELDRE, langvarig stabile Places-API-et
 * (`key`-query-parameter), SAMME autentiseringsform som `GoogleMapsTransport`
 * - bevisst IKKE det nyere v1 Places-API-et (felt-maske-/header-basert auth,
 * en helt annen kallform). Samme D-297-forbehold gjelder (trent kunnskap,
 * ikke denne-økten-bekreftet). De resterende 40 backlog-punktene er fortsatt
 * uendret; samme oppdater-i-place-disiplin gjelder for hver av dem når de
 * bygges.
 *
 * D-304 (2026-09-27, samme brede ordre, ellevte slice, bygget parallelt mens
 * D-303 sin CI kjørte, Tobias direkte i chat gjentatt: "fortsett og jobbe
 * ikke vent på ci"): `google_routes` bygget og flyttet ut av backlogen SAMME
 * MÅTE - fullfører "Google-lokasjons-trioen" (Maps/Places/Routes) med SAMME
 * D-64-domenevurdering som de to foregående: stateless tredjeparts-rute-
 * oppslag, IKKE eierens egen posisjon/geofence. Bruker det ELDRE, langvarig
 * stabile Directions-API-et (`key`-query-parameter), SAMME autentiseringsform
 * som `GoogleMapsTransport`/`GooglePlacesTransport` - bevisst IKKE det nyere
 * v2 Routes-API-et (`routes.googleapis.com`, felt-maske-/header-basert auth).
 * Samme D-297-forbehold gjelder (trent kunnskap, ikke denne-økten-bekreftet).
 * De resterende 39 backlog-punktene er fortsatt uendret; samme oppdater-i-
 * place-disiplin gjelder for hver av dem når de bygges.
 *
 * D-305 (2026-09-27, samme brede ordre, tolvte slice, bygget parallelt mens
 * D-304 sin CI kjørte, Tobias direkte i chat gjentatt: "fortsett og jobbe
 * ikke vent på ci"): `grafana` bygget og flyttet ut av backlogen SAMME MÅTE -
 * FØRSTE connector i denne rekken som er TYPISK selv-hostet (ingen fast
 * SaaS-domene som sentry.io/api.tavily.com) - `JARVIS_GRAFANA_API_BASE_URL`
 * lagt til `credential_refs` (samme "credential_refs må liste ALLE
 * nødvendige verdier"-disiplin som D-245/D-246). Bearer-token-auth mot
 * Grafana sitt HTTP-API (`/api/search`/`/api/dashboards/uid/{uid}`). To
 * handlinger - `search_dashboards`/`get_dashboard` - begge klasse A, INGEN
 * skrivehandling finnes for denne connectoren i det hele tatt (D-41 sitt
 * read-only-unntak ærlig oppfylt). Samme D-297-forbehold gjelder (trent
 * kunnskap, ikke denne-økten-bekreftet). De resterende 38 backlog-punktene
 * er fortsatt uendret; samme oppdater-i-place-disiplin gjelder for hver av
 * dem når de bygges.
 *
 * D-306 (2026-09-27, samme brede ordre, trettende slice, bygget parallelt
 * mens D-305 sin CI kjørte, Tobias direkte i chat gjentatt: "fortsett og
 * jobbe ikke vent på ci"): `prometheus` bygget og flyttet ut av backlogen
 * SAMME MÅTE - SAMME "typisk selv-hostet"-struktur som Grafana (D-305):
 * `JARVIS_PROMETHEUS_API_BASE_URL` lagt til `credential_refs`, injisert som
 * resolver-closure. Bearer-token-auth mot Prometheus sitt HTTP-API
 * (`/api/v1/query`/`/api/v1/query_range`, PromQL). To handlinger -
 * `query`/`query_range` - begge klasse A, INGEN skrivehandling finnes for
 * denne connectoren i det hele tatt (D-41 sitt read-only-unntak ærlig
 * oppfylt - Prometheus sitt HTTP-API tilbyr uansett ingen skrive-endepunkt
 * for metrikkdata). Samme D-297-forbehold gjelder (trent kunnskap, ikke
 * denne-økten-bekreftet). De resterende 37 backlog-punktene er fortsatt
 * uendret; samme oppdater-i-place-disiplin gjelder for hver av dem når de
 * bygges.
 *
 * D-307 (2026-09-27, samme brede ordre, fjortende slice, bygget parallelt
 * mens D-306 sin CI kjørte, Tobias direkte i chat gjentatt: "fortsett og
 * jobbe ikke vent på ci"): `dropbox` bygget og flyttet ut av backlogen SAMME
 * MÅTE - `Authorization: Bearer`-header mot Dropbox API v2, ETT langvarig
 * access-token (INGEN OAuth-refresh-flyt nødvendig, ULIK Google-familien).
 * To handlinger - `list_folder` (klasse A, lesing) og `create_folder`
 * (klasse B, EKTE skrivehandling) - D-41 sitt "maksimal nyttig
 * kapabilitet"-prinsipp fulgt, ikke kunstig innsnevret til read-only.
 * BEVISST AVGRENSET fra fil-INNHOLD-opplasting/nedlasting (Dropbox sitt
 * separate `content.dropboxapi.com`-vertsnavn med binær body/spesielle
 * `Dropbox-API-Arg`-headere - en STRUKTURELT ulik kallform enn de øvrige
 * JSON-RPC-handlingene, bevisst utsatt til en egen, senere utvidelse i
 * stedet for gjettet frem her). Samme D-297-forbehold gjelder (trent
 * kunnskap, ikke denne-økten-bekreftet). De resterende 36 backlog-punktene
 * er fortsatt uendret; samme oppdater-i-place-disiplin gjelder for hver av
 * dem når de bygges.
 *
 * D-308 (2026-09-27, samme brede ordre, femtende slice, bygget parallelt
 * mens D-307 sin CI kjørte, Tobias direkte i chat gjentatt, niende gang:
 * "fortsett og jobbe ikke vent på ci"): `notion` bygget og flyttet ut av
 * backlogen SAMME MÅTE - `Authorization: Bearer`-header PLUSS en fast
 * `Notion-Version`-header mot Notion sitt REST-API v1. To handlinger -
 * `search` (klasse A, lesing) og `create_page` (klasse B, EKTE
 * skrivehandling) - D-41 sitt "maksimal nyttig kapabilitet"-prinsipp
 * fulgt, ikke kunstig innsnevret til read-only. `create_page` sin
 * `rollback_procedure` er manuell arkivering i Notion sitt UI (INGEN
 * dedikert arkiver-endepunkt bygget her ennå - samme DEFERRED-disiplin som
 * Dropbox sin fil-innhold-begrensning, D-41 eksplisitt merket). Samme
 * D-297-forbehold gjelder (trent kunnskap, ikke denne-økten-bekreftet).
 * **D-64-sjekk:** ingen kanonisk dokument-/kunnskaps-domenemodell finnes
 * noe sted i Jarvis (samme reasonering som Google Drive/Sheets/Dropbox) -
 * rent leverandør-adapter, EXTERNAL_CANONICAL. De resterende 35
 * backlog-punktene er fortsatt uendret; samme oppdater-i-place-disiplin
 * gjelder for hver av dem når de bygges.
 *
 * D-309 (2026-09-27, samme brede ordre, sekstende slice, bygget parallelt
 * mens D-308 sin CI kjørte, Tobias direkte i chat gjentatt, tiende gang:
 * "fortsett og jobbe ikke vent på ci"): `onedrive` bygget og flyttet ut av
 * backlogen SAMME MÅTE - `Authorization: Bearer`-header mot Microsoft
 * Graph v1.0. To handlinger - `list_folder` (klasse A, lesing) og
 * `create_folder` (klasse B, EKTE skrivehandling) - D-41 sitt "maksimal
 * nyttig kapabilitet"-prinsipp fulgt, ikke kunstig innsnevret til
 * read-only. SAMME "fil-lagring"-domenestatus som Dropbox (D-307) -
 * `create_folder` sin `rollback_procedure` er manuell sletting. Samme
 * D-297-forbehold gjelder (trent kunnskap, ikke denne-økten-bekreftet).
 * **D-64-sjekk:** ingen kanonisk fil-lagrings-domenemodell finnes noe sted
 * i Jarvis (samme reasonering som Google Drive/Dropbox) - rent
 * leverandør-adapter, EXTERNAL_CANONICAL. De resterende 34
 * backlog-punktene er fortsatt uendret; samme oppdater-i-place-disiplin
 * gjelder for hver av dem når de bygges.
 *
 * D-310 (2026-09-27, FØRSTE slice ETTER at PR #190 - D-301 til D-309 - ble
 * merget til `main` under D-192 - ett-connector-per-PR-mønsteret
 * gjenopptas her): `microsoft_outlook` bygget og flyttet ut av backlogen -
 * `Authorization: Bearer`-header mot Microsoft Graph v1.0 (SAMME
 * vertsnavn/auth-mønster som OneDrive D-309). To handlinger -
 * `list_messages` (klasse A, lesing) og `send_mail` (klasse D - BEVISST
 * SAMME klassifisering som Gmail sin `email.send`: sending av e-post er
 * ikke reverserbar). `PolicyGateway`/`ToolGateway.execute()` sin generiske
 * klasse D-håndtering (CLAUDE.md regel 2 - deterministisk kode, aldri kun
 * promptregler) dekker denne handlingen identisk til `email.send` uten
 * egen per-connector-kode. Samme D-297-forbehold gjelder (trent kunnskap,
 * ikke denne-økten-bekreftet). **D-64-sjekk:** Jarvis har allerede
 * canonical e-post-håndtering via Gmail (`email.*`), men Outlook er en
 * genuint separat leverandør-konto (Microsoft-basert postkasse) - IKKE en
 * konkurrerende domenemodell, samme presedens som Slack+Discord+Twilio som
 * separate meldingsleverandører. De resterende 33 backlog-punktene er
 * fortsatt uendret; samme oppdater-i-place-disiplin gjelder for hver av
 * dem når de bygges.
 *
 * D-311 (2026-09-27, attende slice, Tobias direkte i chat gjentatt,
 * ellevte gang: "fortsett og jobbe ikke vent på ci"): `n8n` bygget og
 * flyttet ut av backlogen - `X-N8N-API-KEY`-header (IKKE `Authorization:
 * Bearer` - n8n sitt eget API-nøkkel-headernavn) mot n8n sitt REST-API v1.
 * n8n er TYPISK selv-hostet (SAMME "typisk selv-hostet"-mønster som
 * Grafana D-305/Prometheus D-306) - base-URL-en må konfigureres via
 * `JARVIS_N8N_API_BASE_URL`, resolver-closure. To handlinger -
 * `list_workflows` (klasse A, lesing) og `activate_workflow` (klasse B,
 * EKTE skrivehandling) - D-41 sitt "maksimal nyttig kapabilitet"-prinsipp
 * fulgt. `activate_workflow` sin `rollback_procedure` er manuell
 * deaktivering (dedikert `deactivate_workflow`-handling DEFERRED, D-41
 * eksplisitt merket, samme disiplin som Dropbox/Notion). Samme
 * D-297-forbehold gjelder (trent kunnskap, ikke denne-økten-bekreftet).
 * **D-64-sjekk:** ingen kanonisk workflow-/automasjons-domenemodell finnes
 * noe sted i Jarvis - rent leverandør-adapter, EXTERNAL_CANONICAL. De
 * resterende 32 backlog-punktene er fortsatt uendret; samme
 * oppdater-i-place-disiplin gjelder for hver av dem når de bygges.
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
    id: "telegram", display_name: "Telegram", category: "tool_gateway",
    // D-247: `JARVIS_TELEGRAM_CHAT_ID` lagt til - `get_bot_info` (live_test
    // under) trenger den ikke, men selve `telegram.notify` (ekte utsendelse,
    // inkl. Daily Brief og watchdog-nødvarsel) gjør, og feltet var usynlig
    // for eieren i dashbordet uten denne oppføringen - samme bug-klasse som
    // D-245/D-246.
    credential_refs: ["JARVIS_TELEGRAM_TOKEN", "JARVIS_TELEGRAM_CHAT_ID"],
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
  {
    id: "fiken", display_name: "Fiken", category: "finance",
    credential_refs: ["JARVIS_FIKEN_CLIENT_ID", "JARVIS_FIKEN_CLIENT_SECRET", "JARVIS_FIKEN_REFRESH_TOKEN"],
    // D-242: `FikenTransport.listCompanies()` - Fiken sin egen dokumenterte
    // "hent companySlug"-inngang, INGEN mutasjon. Tidligere `presence_only`
    // (ingen sikker lesing fantes) - se filhode for historikk.
    live_test: { tool_id: "finance", action: "list_companies", parameters: (identity) => ({ tenant_id: identity.tenant_id }) }
  },
  {
    id: "stripe", display_name: "Stripe", category: "finance",
    credential_refs: ["JARVIS_STRIPE_SECRET_KEY"],
    // D-242: `GET /v1/balance` - offisielt dokumentert, INGEN parametre,
    // INGEN mutasjon. Tidligere `presence_only` - se filhode for historikk.
    live_test: { tool_id: "finance_stripe", action: "get_balance", parameters: (identity) => ({ tenant_id: identity.tenant_id }) }
  },
  {
    id: "vipps", display_name: "Vipps", category: "finance",
    // D-246: `JARVIS_VIPPS_MSN` (merchant serial number) lagt til - samme
    // "credential_refs ufullstendig relativt til getCredentials()"-bug-klasse
    // som D-245 fant for Neonomics sin DEVICE_ID.
    credential_refs: ["JARVIS_VIPPS_CLIENT_ID", "JARVIS_VIPPS_CLIENT_SECRET", "JARVIS_VIPPS_SUBSCRIPTION_KEY", "JARVIS_VIPPS_MSN"],
    // D-242: `POST /accesstoken/get` (SAMME kall enhver ekte Vipps-handling
    // uansett gjør FØRST) - INGEN parameterløs "whoami"-lesing finnes i
    // ePayment-API-et, men selve token-hentingen ER INGEN mutasjon og
    // feiler umiddelbart på ugyldige credentials. Tidligere `presence_only`
    // - se filhode for historikk.
    live_test: { tool_id: "finance_vipps", action: "check_credentials", parameters: (identity) => ({ tenant_id: identity.tenant_id }) }
  },
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
  {
    // D-308 (bygget, flyttet ut av backlog): Notion REST-API v1 (fast
    // `Notion-Version`-header i tillegg til `Authorization: Bearer`). D-41
    // sitt "maksimal nyttig kapabilitet"-prinsipp fulgt - EKTE
    // skrivehandling (`create_page`), ikke kunstig innsnevret til
    // read-only. Oppdatert i place (var en D-232 backlog-plassholder) -
    // ALDRI en ny, separat oppføring med samme id (D-293-disiplinen).
    id: "notion", display_name: "Notion", category: "tool_gateway", credential_refs: ["JARVIS_NOTION_API_KEY"],
    live_test: { tool_id: "notion", action: "search", parameters: () => ({}) }
  },
  {
    // D-309 (bygget, flyttet ut av backlog): Microsoft Graph v1.0
    // (`Authorization: Bearer`-header). D-41 sitt "maksimal nyttig
    // kapabilitet"-prinsipp fulgt - EKTE skrivehandling (`create_folder`),
    // ikke kunstig innsnevret til read-only. Oppdatert i place (var en
    // D-232 backlog-plassholder) - ALDRI en ny, separat oppføring med samme
    // id (D-293-disiplinen).
    id: "onedrive", display_name: "OneDrive", category: "tool_gateway", credential_refs: ["JARVIS_ONEDRIVE_TOKEN"],
    live_test: { tool_id: "onedrive", action: "list_folder", parameters: () => ({}) }
  },
  {
    // D-307 (bygget, flyttet ut av backlog): Dropbox API v2 - `Authorization:
    // Bearer`-header, ETT langvarig access-token (INGEN OAuth-refresh-flyt
    // nødvendig, ULIK Google-familien). D-41 sitt "maksimal nyttig
    // kapabilitet"-prinsipp fulgt - EKTE skrivehandling (`create_folder`),
    // ikke kunstig innsnevret til read-only. Oppdatert i place (var en
    // D-232 backlog-plassholder) - ALDRI en ny, separat oppføring med samme
    // id (D-293-lærdommen).
    id: "dropbox", display_name: "Dropbox", category: "tool_gateway",
    credential_refs: ["JARVIS_DROPBOX_TOKEN"],
    live_test: { tool_id: "dropbox", action: "list_folder", parameters: () => ({ path: "" }) }
  },
  {
    // D-299 (bygget, flyttet ut av backlog): SYVENDE slice. Gjenbruker den
    // EKSISTERENDE `googleAccessToken()`-OAuth-veien, MEN med sin EGEN
    // credential_ref (Sheets krever `spreadsheets`-scope, Drive sin bredere
    // `auth/drive`-scope dekker den ikke). `live_test` trenger et faktisk
    // regneark-id (INGEN universell "list mine regneark"-handling finnes i
    // Sheets-API-et selv, kun i Drive-API-et) - samme etablerte "les fra en
    // egen konfig-env-variabel"-mønster som GitHub sin `JARVIS_GITHUB_REPO`
    // over (IKKE en secret, derfor IKKE i `credential_refs`). Oppdatert i
    // place (var en D-232 backlog-plassholder) - ALDRI en ny, separat
    // oppføring med samme id (D-293-lærdommen).
    id: "google_sheets", display_name: "Google Sheets", category: "tool_gateway",
    credential_refs: ["JARVIS_GOOGLE_SHEETS_TOKEN"],
    live_test: {
      tool_id: "google_sheets", action: "list_sheets",
      parameters: () => ({ spreadsheet_id: process.env["JARVIS_GOOGLE_SHEETS_TEST_SPREADSHEET_ID"] ?? "" })
    }
  },

  // §4.4 Produktivitet / e-post / kalender
  {
    // D-310 (bygget, flyttet ut av backlog): Microsoft Graph v1.0 (SAMME
    // vertsnavn/auth-mønster som OneDrive D-309). `send_mail` er BEVISST
    // klasse D (samme begrunnelse som Gmail sin `email.send`) - ikke
    // reverserbar. Oppdatert i place (var en D-232 backlog-plassholder) -
    // ALDRI en ny, separat oppføring med samme id (D-293-disiplinen).
    id: "microsoft_outlook", display_name: "Microsoft Outlook", category: "tool_gateway", credential_refs: ["JARVIS_OUTLOOK_TOKEN"],
    live_test: { tool_id: "microsoft_outlook", action: "list_messages", parameters: () => ({ max: 5 }) }
  },
  { id: "microsoft_365", display_name: "Microsoft 365", category: "backlog", credential_refs: ["JARVIS_MICROSOFT_365_TOKEN"] },

  // §4.5 Kode / dev / infra
  { id: "google_cloud", display_name: "Google Cloud", category: "backlog", credential_refs: ["JARVIS_GOOGLE_CLOUD_API_KEY"] },

  // §4.6 Søk / browser
  {
    // D-296 (bygget, flyttet ut av backlog): STRUKTURELT ULIK Telegram/Slack/
    // Discord/Twilio over - INGEN "notify er ekte utsendelse"-handling finnes,
    // Brave Search tilbyr genuint bare lesing. `live_test` bruker `web_search`
    // DIREKTE (allerede sideeffekt-fritt, ingen egen tilkoblingstest-handling
    // trengs). Oppdatert i place (var en D-232 backlog-plassholder) - ALDRI
    // en ny, separat oppføring med samme id (D-293-lærdommen).
    id: "brave_search", display_name: "Brave Search", category: "tool_gateway",
    credential_refs: ["JARVIS_BRAVE_SEARCH_API_KEY"],
    live_test: { tool_id: "brave_search", action: "web_search", parameters: () => ({ query: "ping" }) }
  },
  {
    // D-301 (bygget, flyttet ut av backlog): samme "genuint bare lesing"-
    // struktur som Brave Search (D-296) rett over - Tavily tilbyr ett kjent
    // endepunkt (POST /search) som web_search/news_search begge bruker,
    // differensiert kun via et `topic`-felt i request-body. Oppdatert i
    // place (var en D-232 backlog-plassholder) - ALDRI en ny, separat
    // oppføring med samme id (D-293-lærdommen).
    id: "tavily", display_name: "Tavily", category: "tool_gateway",
    credential_refs: ["JARVIS_TAVILY_API_KEY"],
    live_test: { tool_id: "tavily", action: "web_search", parameters: () => ({ query: "ping" }) }
  },
  {
    // D-302 (bygget, flyttet ut av backlog): samme "genuint bare lesing"-
    // struktur som Brave Search (D-296)/Tavily (D-301) - Exa sitt nevrale
    // søke-API (`POST /search`) tilbyr genuint bare lesing. `find_similar`
    // bruker et EGET, separat dokumentert endepunkt (`POST /findSimilar`),
    // IKKE samme kall som web_search med en annen body-form. Oppdatert i
    // place (var en D-232 backlog-plassholder) - ALDRI en ny, separat
    // oppføring med samme id (D-293-lærdommen).
    id: "exa", display_name: "Exa", category: "tool_gateway",
    credential_refs: ["JARVIS_EXA_API_KEY"],
    live_test: { tool_id: "exa", action: "web_search", parameters: () => ({ query: "ping" }) }
  },
  { id: "playwright", display_name: "Playwright", category: "backlog", credential_refs: ["JARVIS_PLAYWRIGHT_API_KEY"] },

  // §4.7 Tale / video / media-AI
  { id: "openai_realtime", display_name: "OpenAI Realtime", category: "backlog", credential_refs: ["JARVIS_OPENAI_REALTIME_API_KEY"] },
  { id: "elevenlabs", display_name: "ElevenLabs", category: "backlog", credential_refs: ["JARVIS_ELEVENLABS_API_KEY"] },
  { id: "deepgram", display_name: "Deepgram", category: "backlog", credential_refs: ["JARVIS_DEEPGRAM_API_KEY"] },
  { id: "livekit", display_name: "LiveKit", category: "backlog", credential_refs: ["JARVIS_LIVEKIT_API_KEY"] },
  { id: "telnyx", display_name: "Telnyx", category: "backlog", credential_refs: ["JARVIS_TELNYX_API_KEY"] },
  {
    // D-295 (bygget, flyttet ut av backlog): samme "notify er ekte utsendelse,
    // get_account_info er trygg tilkoblingstest"-disiplin som Telegram/Slack/
    // Discord over. Oppdatert i place (var en D-232 backlog-plassholder) -
    // ALDRI en ny, separat oppføring med samme id (D-293-lærdommen). MERK:
    // `JARVIS_TWILIO_FROM_NUMBER` lagt til her - samme "credential_refs må
    // liste ALLE nødvendige verdier, ikke bare de som gateway.execute() selv
    // slår opp" - bug-klasse som D-245/D-246 (Vipps MSN/Wallester ACCOUNT_ID).
    id: "twilio", display_name: "Twilio", category: "tool_gateway",
    credential_refs: ["JARVIS_TWILIO_ACCOUNT_SID", "JARVIS_TWILIO_AUTH_TOKEN", "JARVIS_TWILIO_FROM_NUMBER"],
    live_test: { tool_id: "twilio", action: "get_account_info", parameters: () => ({}) }
  },
  {
    // D-314 (bygget, flyttet ut av backlog): `credential_refs` utvidet med
    // PHONE_NUMBER_ID (Jarvis sin egen avsenderidentitet, SAMME rolle som
    // Telegram sin chat_id). Oppdatert i place (var en D-232
    // backlog-plassholder) - ALDRI en ny, separat oppføring med samme id
    // (D-293-disiplinen).
    id: "whatsapp", display_name: "WhatsApp", category: "tool_gateway",
    credential_refs: ["JARVIS_WHATSAPP_TOKEN", "JARVIS_WHATSAPP_PHONE_NUMBER_ID"],
    live_test: { tool_id: "whatsapp", action: "get_phone_number_info", parameters: () => ({}) }
  },
  {
    // D-292 (bygget, flyttet ut av backlog): "notify er ekte utsendelse,
    // get_bot_info er trygg tilkoblingstest"-disiplin, samme som Telegram
    // over. Oppdatert i place (var en D-232 backlog-plassholder) - ALDRI
    // en ny, separat oppføring med samme id (se filhode: unikhetskravet
    // i connector-registry.test.ts).
    id: "slack", display_name: "Slack", category: "tool_gateway",
    credential_refs: ["JARVIS_SLACK_BOT_TOKEN"],
    live_test: { tool_id: "slack", action: "get_bot_info", parameters: () => ({}) }
  },
  {
    // D-294 (bygget, flyttet ut av backlog): samme "notify er ekte utsendelse,
    // get_bot_info er trygg tilkoblingstest"-disiplin som Telegram/Slack over.
    // Oppdatert i place (var en D-232 backlog-plassholder) - ALDRI en ny,
    // separat oppføring med samme id (D-293-lærdommen fra Slack-PR-en).
    id: "discord", display_name: "Discord", category: "tool_gateway",
    credential_refs: ["JARVIS_DISCORD_BOT_TOKEN"],
    live_test: { tool_id: "discord", action: "get_bot_info", parameters: () => ({}) }
  },
  { id: "higgsfield", display_name: "Higgsfield", category: "backlog", credential_refs: ["JARVIS_HIGGSFIELD_API_KEY"] },
  { id: "runway", display_name: "Runway", category: "backlog", credential_refs: ["JARVIS_RUNWAY_API_KEY"] },
  { id: "kling", display_name: "Kling", category: "backlog", credential_refs: ["JARVIS_KLING_API_KEY"] },
  { id: "google_veo", display_name: "Google Veo", category: "backlog", credential_refs: ["JARVIS_GOOGLE_VEO_API_KEY"] },
  { id: "openai_images", display_name: "OpenAI Images", category: "backlog", credential_refs: ["JARVIS_OPENAI_IMAGES_API_KEY"] },

  // §4.8 Musikk
  {
    // D-313 (bygget, flyttet ut av backlog): `credential_refs` utvidet med
    // REFRESH_TOKEN (den faktiske, roterte secreten - CLIENT_ID/SECRET er
    // delt app-konfig, SAMME oppdeling som Google-familien). Oppdatert i
    // place (var en D-232 backlog-plassholder) - ALDRI en ny, separat
    // oppføring med samme id (D-293-disiplinen).
    id: "spotify", display_name: "Spotify", category: "tool_gateway",
    credential_refs: ["JARVIS_SPOTIFY_CLIENT_ID", "JARVIS_SPOTIFY_CLIENT_SECRET", "JARVIS_SPOTIFY_REFRESH_TOKEN"],
    live_test: { tool_id: "spotify", action: "get_currently_playing", parameters: () => ({}) }
  },
  { id: "apple_music", display_name: "Apple Music", category: "backlog", credential_refs: ["JARVIS_APPLE_MUSIC_TOKEN"] },

  // §4.9 Automatisering / workflow
  {
    // D-311 (bygget, flyttet ut av backlog): `X-N8N-API-KEY`-header (IKKE
    // Bearer) mot n8n sitt REST-API v1. TYPISK selv-hostet (SAMME mønster
    // som Grafana D-305/Prometheus D-306) - base-URL må konfigureres.
    // `activate_workflow` er en EKTE klasse B-skrivehandling (D-41).
    // Oppdatert i place (var en D-232 backlog-plassholder) - ALDRI en ny,
    // separat oppføring med samme id (D-293-disiplinen).
    id: "n8n", display_name: "n8n", category: "tool_gateway", credential_refs: ["JARVIS_N8N_API_KEY", "JARVIS_N8N_API_BASE_URL"],
    live_test: { tool_id: "n8n", action: "list_workflows", parameters: () => ({}) }
  },
  { id: "zapier", display_name: "Zapier", category: "backlog", credential_refs: ["JARVIS_ZAPIER_API_KEY"] },
  {
    // D-315 (bygget, flyttet ut av backlog): `credential_refs` utvidet med
    // API_BASE_URL (zone-spesifikk, SAMME "list alle nødvendige
    // verdier"-disiplin som n8n D-311). Oppdatert i place (var en D-232
    // backlog-plassholder) - ALDRI en ny, separat oppføring med samme id
    // (D-293-disiplinen).
    id: "make", display_name: "Make", category: "tool_gateway",
    credential_refs: ["JARVIS_MAKE_API_KEY", "JARVIS_MAKE_API_BASE_URL"],
    live_test: { tool_id: "make", action: "get_current_user", parameters: () => ({}) }
  },
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
  {
    // D-298 (bygget, flyttet ut av backlog): SJETTE slice. BEVISST AVGRENSET
    // til KUN Geocoding - `google_places`/`google_routes` er separate,
    // fortsatt ubygde id-er med egne credential_refs, IKKE konflatert inn
    // her. `geocode` brukes som `live_test` (Google sitt eget kjente
    // eksempel-adresse, trygt, sideeffekt-fritt). Oppdatert i place (var en
    // D-232 backlog-plassholder) - ALDRI en ny, separat oppføring med samme
    // id (D-293-lærdommen).
    id: "google_maps", display_name: "Google Maps", category: "tool_gateway",
    credential_refs: ["JARVIS_GOOGLE_MAPS_API_KEY"],
    live_test: { tool_id: "google_maps", action: "geocode", parameters: () => ({ address: "1600 Amphitheatre Parkway, Mountain View, CA" }) }
  },
  {
    // D-303 (bygget, flyttet ut av backlog): samme domenesjekk allerede kjørt
    // for Google Maps (D-298) - stateless tredjeparts-stedoppslag, IKKE
    // eierens egen posisjon/geofence (`modules/location`). Bruker det
    // ELDRE, langvarig stabile Places-API-et (`maps.googleapis.com/maps/api/
    // place/...`, `key`-query-parameter), SAMME autentiseringsform som
    // `GoogleMapsTransport` - IKKE det nyere v1 Places-API-et (som krever et
    // helt annet felt-maske-/header-basert auth-mønster). Oppdatert i place
    // (var en D-232 backlog-plassholder) - ALDRI en ny, separat oppføring
    // med samme id (D-293-lærdommen).
    id: "google_places", display_name: "Google Places", category: "tool_gateway",
    credential_refs: ["JARVIS_GOOGLE_PLACES_API_KEY"],
    live_test: { tool_id: "google_places", action: "search_places", parameters: () => ({ query: "Eiffel Tower" }) }
  },
  {
    // D-304 (bygget, flyttet ut av backlog): samme domenesjekk allerede kjørt
    // for Google Maps (D-298)/Google Places (D-303) - stateless tredjeparts-
    // rute-oppslag, IKKE eierens egen posisjon/geofence (`modules/location`).
    // Bruker det ELDRE, langvarig stabile Directions-API-et
    // (`maps.googleapis.com/maps/api/directions/...`, `key`-query-parameter),
    // SAMME autentiseringsform som `GoogleMapsTransport`/`GooglePlacesTransport`
    // - IKKE det nyere v2 Routes-API-et (`routes.googleapis.com`, felt-maske-/
    // header-basert auth). Oppdatert i place (var en D-232 backlog-
    // plassholder) - ALDRI en ny, separat oppføring med samme id
    // (D-293-lærdommen).
    id: "google_routes", display_name: "Google Routes", category: "tool_gateway",
    credential_refs: ["JARVIS_GOOGLE_ROUTES_API_KEY"],
    live_test: { tool_id: "google_routes", action: "get_directions", parameters: () => ({ origin: "Paris, France", destination: "Versailles, France" }) }
  },

  // §4.13 Observability
  {
    // D-297 (bygget, flyttet ut av backlog): FEMTE slice. Organisasjons-slug
    // (`JARVIS_SENTRY_ORG_SLUG`) lagt til her - samme "credential_refs må
    // liste ALLE nødvendige verdier" som Twilio (D-295) sin From-nummer-
    // regel. `update_issue` er skrivehandlingen (klasse B - status-endring,
    // reversibel/idempotent, ALDRI en ekte tilkoblingstest). `list_projects`
    // brukes som `live_test` - trygt, sideeffekt-fritt, krever ingen
    // forhåndskjent issue-id. Oppdatert i place (var en D-232 backlog-
    // plassholder) - ALDRI en ny, separat oppføring med samme id
    // (D-293-lærdommen).
    id: "sentry", display_name: "Sentry", category: "tool_gateway",
    credential_refs: ["JARVIS_SENTRY_API_TOKEN", "JARVIS_SENTRY_ORG_SLUG"],
    live_test: { tool_id: "sentry", action: "list_projects", parameters: () => ({}) }
  },
  {
    // D-305 (bygget, flyttet ut av backlog): Grafana er TYPISK selv-hostet
    // (ingen fast SaaS-domene som sentry.io) - `JARVIS_GRAFANA_API_BASE_URL`
    // lagt til `credential_refs` (samme "credential_refs må liste ALLE
    // nødvendige verdier"-disiplin som D-245/D-246 sine Vipps MSN/Wallester
    // ACCOUNT_ID). Oppdatert i place (var en D-232 backlog-plassholder) -
    // ALDRI en ny, separat oppføring med samme id (D-293-lærdommen).
    id: "grafana", display_name: "Grafana", category: "tool_gateway",
    credential_refs: ["JARVIS_GRAFANA_API_KEY", "JARVIS_GRAFANA_API_BASE_URL"],
    live_test: { tool_id: "grafana", action: "search_dashboards", parameters: () => ({}) }
  },
  {
    // D-306 (bygget, flyttet ut av backlog): SAMME "typisk selv-hostet"-
    // struktur som Grafana (D-305) - `JARVIS_PROMETHEUS_API_BASE_URL` lagt
    // til `credential_refs` (samme "credential_refs må liste ALLE nødvendige
    // verdier"-disiplin). Oppdatert i place (var en D-232 backlog-
    // plassholder) - ALDRI en ny, separat oppføring med samme id
    // (D-293-lærdommen).
    id: "prometheus", display_name: "Prometheus", category: "tool_gateway",
    credential_refs: ["JARVIS_PROMETHEUS_TOKEN", "JARVIS_PROMETHEUS_API_BASE_URL"],
    live_test: { tool_id: "prometheus", action: "query", parameters: () => ({ query: "up" }) }
  },

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
 * `live_test` er metadata BÅDE den eksplisitte "test connector"-handlingen
 * (`owner_controls.test_connector`, D-213) OG `ConnectorHealthSweep`
 * (`connector-health-sweep.ts`, D-242) bruker for å avgjøre hva de faktisk
 * skal kalle - selve kallet/skrivingen til `health`-kartet skjer ALLTID
 * inne i `ToolGateway.execute()` selv (SAMME sted for BEGGE kallerne), aldri
 * her.
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

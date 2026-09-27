# Jarvis – integrasjoner

**Status:** Utkast v1.0. Ved motstrid gjelder [CANONICAL_SPEC.md](CANONICAL_SPEC.md).

## 1. Prinsipper

1. **Alt går gjennom Tool Gateway.** Ingen modul kaller eksterne API-er direkte; hvert verktøy er
   registrert med skjema, capability-klasse, scopes, rate limit og audit.
2. **Offisielt API foretrekkes** fremfor nettleserautomatisering. Nettleser er siste utvei og kjører da i
   sandbox med egne begrensninger.
3. **Egne credentials per integrasjon** med minst mulig scope, lagret i vault, aldri i kode.
4. **MCP-servere er ubetrodde inntil verifisert:** låses til eksplisitte skjemaer, minst mulig tilgang,
   output behandles som Ingestion Zone-innhold.
5. **Alle integrasjoner er utbyttbare:** Gmail↔Outlook, Google↔Proton osv. bak samme interne kontrakt.

## 2. Verktøyregister (Tool Gateway)

Hvert verktøy registreres med:

```
{ tool_id, navn, beskrivelse, json-skjema (input/output), capability_klasse (A–D),
  scopes, tillatte_datasoner, nettverksmål, rate_limit, kostnadsmodell,
  rollback_prosedyre, eier, credential_referanse }
```

Policy Gateway bruker registeret ved autorisasjon; Orchestrator bruker det ved planlegging.
Prompt injection-test er obligatorisk før et verktøy med klasse C/D aktiveres.

## 3. Første bølge (fase 7, rekkefølge etter verdi/risiko)

| Integrasjon | Formål | Klasse (typisk) | Merknad |
|---|---|---|---|
| GitHub | Kode, PR-er, issues for Coding Worker | B/C | Issues/PR-tekst = ubetrodd innhold |
| Google Calendar | Lese/foreslå avtaler | A (lese), C (skrive) | Skriving krever mandat |
| Gmail | Lese, utkast, sende | A (lese), C/D (sende) | Sending alltid med godkjenning i starten |
| Google Drive/Docs | Dokumenter - full read/write/permissions (D-41, 2026-08-16) | A (les), C (opprett/oppdater/omdøp/flytt/papirkurv), D (permanent slett, deling/tilgangsstyring) | Ingestion-kilden (`GoogleDriveKnowledgeSource`) er separat og alltid READ ONLY; se DECISIONS_AND_ASSUMPTIONS.md D-41 |
| Telegram | Varsling + fjern-godkjenning + chat-kanal | B | Første varslingskanal |
| Supabase/Postgres | Egen datalagring | – | Intern, ikke via Tool Gateway |
| Vercel | Deploy av web | C | |
| Google Cloud | Ev. sky-ressurser | C | Kun ved behov |
| Claude Code / Codex | Kodeagenter i sandbox | via Worker | Se SECURITY_MODEL §5 |
| OpenAI / Anthropic API | Modeller via Model Gateway | – | Ikke et «verktøy», men provider |
| Home Assistant | Enhetsbuss (se §5) | A/B/C, sikkerhet=D | |

## 4. Andre bølge (etter fase 7) — Tobias sin kuraterte integrasjonsliste (D-231, 2026-09-22)

**Kilde:** Tobias ga 2026-09-22, direkte i chat under D-192-standingfullmakt, en eksplisitt kuratert
liste på 73 navngitte integrasjoner ordrett: «Dette er det vi skal ha legg det inn som en plan å en
del av master planen vi gjør nå.» Full kryssjekk mot faktisk bygget tilstand, konfliktflagg og
begrunnelse: **D-231 i `DECISIONS_AND_ASSUMPTIONS.md`**. Denne tabellen ERSTATTER de tidligere vage
plassholderne i denne paragrafen (kundeoppfølging/Dennis-CRM-plassholderen dekkes nå eksplisitt av
D-64-CRM/prosjektstyring-raden under; nettsideovervåking/kostnad/SLA og bil-/hvitevare-API-er er
IKKE del av Tobias sin 2026-09-22-liste og forblir uendret utenfor scope her).

**VIKTIG - dette er en BACKLOG-REGISTRERING, IKKE en start på implementering.**
`EXTERNAL_CREDENTIAL_SETUP_POLICY=DEFER_UNTIL_FINAL_INTEGRATION_PHASE` (D-108) gjelder UENDRET for
HVERT `NY_BACKLOG`-punkt under. Hver ny leverandør krever i tillegg sin EGEN D-64 Core-vs-Adapter-
beslutningsport (§11.2 i `ARCHITECTURE.md`) OG D-41-scope-verifisering (aldri gjettet, alltid mot
offisiell dokumentasjon) FØR faktisk kode skrives for den - ingenting under er en blankofullmakt.

**Statuskoder:** `ALLEREDE_BYGGET` (kode finnes, med D-ID/kilde) · `ALLEREDE_DEKKET` (dekkes av en
allerede bygget, bredere connector) · `NY_BACKLOG` (ingen kode ennå) · `NY_BACKLOG – D-64-PORT
PÅKREVD` (masterplan-kapabilitetsnavn som IKKE er blankofullmakt-godkjent til å velge en ekstern
domeneeier, jf. CLAUDE.md regel 12/D-64) · `NY_BACKLOG – Q-XX FLAGGET` (kolliderer med en eksisterende
ufravikelig regel eller beslutning; avklares FØR backlog-status kan bli endelig).

### 4.1 LLM / lokal modell

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| OpenAI | `ALLEREDE_BYGGET` | Model Gateway-provider; D-108 credential-policy; STT/TTS-databehandler-status `VERIFIED` (Q-32 pkt 1, D-226) |
| Anthropic Claude | `ALLEREDE_BYGGET` | Model Gateway-provider (`connector-registry.ts` id `anthropic`) |
| Google Gemini | `ALLEREDE_BYGGET` | Model Gateway-provider (id `gemini`); credentials fortsatt ukonfigurert i nåværende driftsmiljø (D-108-utsatt, kode ferdig) |
| Ollama (lokal modell) | `ALLEREDE_BYGGET` | `packages/provider-adapters/src/ollama.ts`+`local-llm.ts`; `gemma_local`-first routing (D-80/D-81/D-106) - Tobias sin RTX 4070-vert foretrukket backend når helsetilstand OK |

### 4.2 Data-/infrastrukturlag

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| Supabase | `Q-36 LUKKET (D-233) – DRIFTSVALG, IKKE CONNECTOR` | Tobias bekreftet: kun Postgres-hosting, aldri Supabase-spesifikke API-er - ingen konflikt med regel 9, ingen ny ToolGateway-connector, ingen oppføring i `connector-registry.ts`. Se D-233 i `DECISIONS_AND_ASSUMPTIONS.md` |
| Neo4j | `DROPPET (D-234)` | Tobias bekreftet at Business Graph (UA-3), allerede `PRODUCTION_VERIFIED` på ren Postgres, dekker behovet. Se D-234 i `DECISIONS_AND_ASSUMPTIONS.md` |

### 4.3 Kunnskap / dokumenter

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| Notion | `NY_BACKLOG` | Kun eksplisitt navngitt i FRAVÆRS-kommentarer (`modules/operations`, migrasjon `048_operations.sql`) - «ingen Notion-referanse/-credential» bevisst dokumentert, ikke bygget |
| Obsidian | `ALLEREDE_BYGGET` | `ObsidianVaultKnowledgeSource` (`modules/knowledge/src/obsidian-source.ts`), UA-2 P1A - kun `.md`, `.obsidian/`-config ekskludert som default |
| Google Drive | `ALLEREDE_BYGGET` | `connector-registry.ts` id `google_drive`; D-41 full read/opprett/oppdater/omdøp/flytt/papirkurv/deling; ingestion-kilden er separat og alltid READ ONLY |
| OneDrive | `NY_BACKLOG` | Ingen kode funnet |
| Dropbox | `NY_BACKLOG` | Ingen kode funnet |
| Google Docs | `ALLEREDE_DEKKET` | Dekkes av Google Drive/Docs-connectoren (`read_document`-eksport i `modules/tool-gateway/src/live-transports.ts`) - ingen egen connector nødvendig |
| Google Sheets | `ALLEREDE_BYGGET (D-299)` | `GoogleSheetsTransport` (`live-transports.ts`) - Sheets API v4, gjenbruker eksisterende `googleAccessToken()`-OAuth-vei men med EGEN `JARVIS_GOOGLE_SHEETS_TOKEN` (Sheets krever `spreadsheets`-scope, Drive sin bredere scope dekker den ikke). D-41 "maksimal nyttig kapabilitet" fulgt: `list_sheets`/`read_range` (A) + `update_range`/`append_row` (B, EKTE skrivehandlinger). `GOOGLE_SHEETS_LIVE_GATE=PENDING_CREDENTIALS`. Se D-299 i DECISIONS_AND_ASSUMPTIONS.md. |

### 4.4 Produktivitet / e-post / kalender

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| Gmail | `ALLEREDE_BYGGET` | `connector-registry.ts` id `gmail`; D-34 primær e-postplattform (Q-07 lukket) |
| Google Kalender | `ALLEREDE_BYGGET` | `connector-registry.ts` id `google_calendar`; D-34 primær kalender |
| Microsoft Outlook | `NY_BACKLOG` | Q-07 (lukket, D-34): eksplisitt utsatt til senere, Gmail er primær i v1. Leverandørnøytral kontrakt finnes, ingen Outlook-transport bygget |
| Microsoft 365 | `NY_BACKLOG` | Samme utsettelse som Outlook (D-34) - ingen kode |

### 4.5 Kode / dev / infra

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| GitHub | `ALLEREDE_BYGGET` | `connector-registry.ts` id `github`; D-94, 23-handlings D-41-matrise (10×A/9×B/2×C/2×D) |
| GitHub Actions | `ALLEREDE_DEKKET` | Del av D-94-matrisen: `list_workflow_runs`/`get_workflow_run`/`list_workflow_jobs` (A), `rerun_workflow_run`/`cancel_workflow_run` (B), `dispatch_workflow` (C) - ingen egen connector nødvendig |
| Vercel | `ALLEREDE_BYGGET` (delvis) | `connector-registry.ts` id `vercel`, `live_test: read_deployments` (D-213), NÅ med en ekte `VercelTransport` faktisk koblet inn i `main.ts`/`worker-main.ts` (D-242 - `live_test` eksisterte siden D-213 men falt ALLTID gjennom til en uconfigured stub før dette, samme "kode eksisterer != koblet inn"-funn som D-211/D-212). **Merk (D-41-gap, eksplisitt markert, ikke stille utelatt):** kun `read_deployments` er registrert i `integrations.ts` i dag - full D-41-kapabilitet (deploy/redeploy/miljøvariabel-styring) er fortsatt `NY_BACKLOG` |
| Google Cloud | `NY_BACKLOG` | D-105-audit (2026-08-22) bekreftet eksplisitt «GCP/Cloudflare fortsatt fullstendig fraværende» - ingen kode siden |
| Docker | `ALLEREDE_BYGGET` | D-105 `docker`-transport (`modules/tool-gateway/src/docker-transport.ts`): `list_containers`/`inspect_container`/`get_logs` (A), `stop_container`/`start_container` (produksjonsmutasjon reachable), `redeploy_container` (D, eksplisitt `DEFERRED` for produksjon, sentinel-only i akseptanse jf. D-41-korreksjon). Lokal infra, ikke i `connector-registry.ts` sine 14 (ingen ekstern credential-helsesjekk) |

### 4.6 Søk / browser

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| Brave Search | `ALLEREDE_BYGGET (D-296)` | `BraveSearchTransport` (`live-transports.ts`) - `web_search`/`news_search` (GET mot Brave Search API, `X-Subscription-Token`-header). STRUKTURELT ULIK Telegram/Slack/Discord/Twilio: INGEN skrivehandling finnes - leverandøren tilbyr genuint bare lesing. `live_test: web_search` (brukt direkte, ingen egen tilkoblingstest-handling nødvendig). `BRAVE_SEARCH_LIVE_GATE=PENDING_CREDENTIALS` (`JARVIS_BRAVE_SEARCH_API_KEY`) |
| Tavily | `ALLEREDE_BYGGET (D-301)` | `TavilyTransport` (`live-transports.ts`) - `web_search`/`news_search` (POST `https://api.tavily.com/search`, `api_key` som felt i JSON-body, IKKE en header). Kun ÉTT reelt dokumentert endepunkt - handlingene skiller seg kun på `topic`-body-feltet (general/news). STRUKTURELT LIK Brave Search: INGEN skrivehandling finnes - leverandøren tilbyr genuint bare lesing. `live_test: web_search` (query "ping"). `TAVILY_LIVE_GATE=PENDING_CREDENTIALS` (`JARVIS_TAVILY_API_KEY`) |
| Exa | `ALLEREDE_BYGGET (D-302)` | `ExaTransport` (`live-transports.ts`) - `web_search`/`find_similar`. TO separate endepunkter (`POST /search`/`POST /findSimilar`, `x-api-key`-header), ULIK Tavily sitt delte endepunkt. STRUKTURELT LIK Brave Search/Tavily: INGEN skrivehandling finnes - leverandøren tilbyr genuint bare lesing. `live_test: web_search` (query "ping"). `EXA_LIVE_GATE=PENDING_CREDENTIALS` (`JARVIS_EXA_API_KEY`) |
| Playwright | `NY_BACKLOG` | Ingen kode/dependency funnet. Jf. §1 punkt 2: nettleserautomatisering er siste utvei, kjører i sandbox med egne begrensninger når bygget |

### 4.7 Tale / video / media-AI

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| OpenAI Realtime | `NY_BACKLOG` | Ingen kode funnet (lokal whisper.cpp/piper er bygget og verifisert separat, D-217/D-223, men det er ikke OpenAI Realtime) |
| ElevenLabs | `NY_BACKLOG` | Ingen kode funnet |
| Deepgram | `NY_BACKLOG` | Ingen kode funnet |
| LiveKit | `NY_BACKLOG` | Ingen kode funnet (Q-03 fortsatt ikke avgjort ved benchmark) |
| Telnyx | `NY_BACKLOG` | Ingen kode funnet |
| Twilio | `ALLEREDE_BYGGET (D-295)` | `TwilioTransport` (`live-transports.ts`) - `notify`/`get_account_info`/`read_messages` (POST/GET mot Twilio REST API, `Basic`-autentisering AccountSid:AuthToken), `channel: "twilio"` lagt til `ChannelSchema`. `live_test: get_account_info` (`GET /Accounts/{sid}.json`, ingen sideeffekt). `TWILIO_LIVE_GATE=PENDING_CREDENTIALS` (`JARVIS_TWILIO_ACCOUNT_SID`/`JARVIS_TWILIO_AUTH_TOKEN`/`JARVIS_TWILIO_FROM_NUMBER`) |
| Telegram | `ALLEREDE_BYGGET` | `connector-registry.ts` id `telegram`; D-119/D-125, LIVE+VERIFIED (eier-kanal, daglig brief, `/brief`/`/status`) |
| WhatsApp | `NY_BACKLOG` | Kun kanal-enum i `046_conversation_graph.sql` (§UA-7) - bevisst IKKE bygget («no big-bang all-providers-at-once», D-108) |
| Slack | `ALLEREDE_BYGGET (D-292)` | `SlackTransport` (`live-transports.ts`) - `notify`/`get_bot_info`/`list_channels`/`read_channel_history` (chat.postMessage/auth.test/conversations.list/conversations.history), `channel: "slack"` lagt til `ChannelSchema`. `live_test: get_bot_info` (auth.test, ingen sideeffekt). `SLACK_LIVE_GATE=PENDING_CREDENTIALS` (`JARVIS_SLACK_BOT_TOKEN`) |
| Discord | `ALLEREDE_BYGGET (D-294)` | `DiscordTransport` (`live-transports.ts`) - `notify`/`get_bot_info`/`list_channels`/`read_channel_history` (POST/GET mot Discord REST API v10 `/channels/{id}/messages`, `/users/@me`, `/guilds/{id}/channels`, `/channels/{id}/messages`), `channel: "discord"` lagt til `ChannelSchema`. `live_test: get_bot_info` (`GET /users/@me`, ingen sideeffekt). `DISCORD_LIVE_GATE=PENDING_CREDENTIALS` (`JARVIS_DISCORD_BOT_TOKEN`) |
| Higgsfield | `NY_BACKLOG` | Ingen kode funnet |
| Runway | `NY_BACKLOG` | Ingen kode funnet |
| Kling | `NY_BACKLOG` | Ingen kode funnet |
| Google Veo | `NY_BACKLOG` | Ingen kode funnet |
| OpenAI Images | `NY_BACKLOG` | Ingen kode funnet |

### 4.8 Musikk

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| Spotify | `NY_BACKLOG` | Ingen kode funnet |
| Apple Music | `NY_BACKLOG` | Ingen kode funnet |

### 4.9 Automatisering / workflow

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| n8n | `NY_BACKLOG` | Ingen kode funnet |
| Zapier | `NY_BACKLOG` | Ingen kode funnet |
| Make | `NY_BACKLOG` | Ingen kode funnet |
| Apple Shortcuts | `NY_BACKLOG` | Ingen kode funnet - henger sammen med D-36 Apple-runtime-sporet (se §4.14) |

### 4.10 Smart hjem

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| Home Assistant | `ALLEREDE_BYGGET` (kode), live-evidens `BLOCKED_EXTERNAL` | `modules/tool-gateway/src/home-assistant.ts`; enhetsbuss jf. §5 under. Live-verifisering krever ekte HA-instans+token (HA-RUNTIME, D-108-utsatt) |
| HomeKit | `NY_BACKLOG` | Ingen kode funnet - henger sammen med D-36 Apple-runtime-sporet |
| Philips Hue | `NY_BACKLOG` | Ingen kode funnet - i Jarvis sin arkitektur går enhetsstyring normalt via Home Assistant (§5), ikke en direkte Hue-connector; avklares ved faktisk byggeordre |

### 4.11 Finans / CRM / ads / prosjektstyring

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| Fiken | `ALLEREDE_BYGGET` | `connector-registry.ts` id `fiken`; D-107, UA-6 første slice. `FIKEN_LIVE_GATE=PENDING_CREDENTIALS`. `live_test: list_companies` lagt til D-242 (gjenbruker `FikenTransport.listCompanies()`, `GET /companies` - tidligere `presence_only`) |
| Folio | `NY_BACKLOG` | Ingen kode funnet (kun tidligere vag plassholder i denne paragrafen) |
| Stripe | `ALLEREDE_BYGGET` | `connector-registry.ts` id `stripe`; D-109. `STRIPE_LIVE_GATE=PASS_PENDING_ARCHITECT_REVIEW` (D-228, faktisk host-kjørt og grønt, venter uavhengig arkitektgjennomgang). `live_test: get_balance` lagt til D-242 (`GET /v1/balance` - tidligere `presence_only`) |
| HubSpot | `NY_BACKLOG – klar for bygging som adapter (D-291)` | D-64-porten er ALLEREDE kjørt og avgjort for CRM (Business OS, D-49, se "Flere CRM-integrasjoner Q-16"-raden §11) - HubSpot ville KUN vært en synk-adapter INN i Business OS, aldri domeneeier. Ingen ny port nødvendig, se D-291 |
| Pipedrive | `NY_BACKLOG – klar for bygging som adapter (D-291)` | Samme som HubSpot |
| Google Ads | `ALLEREDE_BYGGET` | UA-4, D-83/D-84 (merget PR #23). COMPLETE for lesing/rapportering; mutate utsatt bak UA-6. `GOOGLE_ADS_LIVE_VERIFICATION=DEFERRED_TO_FINAL_INTEGRATION_PHASE` (D-86) |
| Meta Ads | `NY_BACKLOG` | Eksplisitt bekreftet fraværende i `modules/growth` sin egen transport-wiring-test («ZERO annonseplattform-leverandør-avhengighet ... ingen Meta Ads-credential-referanse») |
| Linear | `NY_BACKLOG – klar for bygging som adapter (D-291)` | D-64-porten er ALLEREDE kjørt og avgjort for prosjektstyring/tickets (Operations Core, D-129, `OperationsTask` - status/prioritet/owner_person_id/frist) - Linear ville KUN vært en synk-adapter, aldri domeneeier. Ingen ny port nødvendig, se D-291 |
| Jira | `NY_BACKLOG – klar for bygging som adapter (D-291)` | Samme som Linear |
| Trello | `NY_BACKLOG – klar for bygging som adapter (D-291)` | Samme som Linear |
| Todoist | `NY_BACKLOG – klar for bygging som adapter (D-291)` | Samme som Linear |

**D-64-notat (RETTET av D-291, 2026-09-26 - se DECISIONS_AND_ASSUMPTIONS.md):** CRM/prosjektstyring
(HubSpot/Pipedrive/Linear/Jira/Trello/Todoist) sto tidligere som `D-64-PORT PÅKREVD` her - men porten
var ALLEREDE kjørt og avgjort for begge kapabilitetskategoriene FØR D-231 listet disse seks: CRM via
Business OS (D-49, se "Flere CRM-integrasjoner Q-16"-raden i `ARCHITECTURE.md` §11), prosjektstyring/
tickets via Operations Core (D-129, `OperationsTask`). Begge er allerede EKSPLISITT `JARVIS_CANONICAL`
med en dokumentert "ekstern leverandør = valgfri synk-adapter, ALDRI domeneeier"-grense - nøyaktig
samme mønster som Support/tickets sin Zendesk-presedens. Ingen NY Core-vs-Adapter-port er nødvendig
for disse seks - de er nå ordinær `NY_BACKLOG` (adapter-bygging), ikke portblokkert. Uendret av D-291,
til referanse - full port-metodikk for FREMTIDIGE, faktisk uavgjorte kapabiliteter (`ARCHITECTURE.md`
§11.2: kapabilitet → kanonisk Jarvis-tilstand → hva krever faktisk et eksternt system → portabilitets-/
utfalls-/dataeierskapstest →
system-of-record-klassifisering) FØR noe velges eller bygges. Blir en av dem vurdert som en CORE
DEPENDENCY under den porten: `CORE_DEPENDENCY_DECISION_REQUIRED=true` rapporteres til Tobias FØR noe
velges - se D-64 i `DECISIONS_AND_ASSUMPTIONS.md`. Alle øvrige punkter i denne paragrafen (rene
utførelses-/transportadaptere som Slack/Discord/Twilio/Telnyx/WhatsApp/Spotify/Higgsfield/Runway osv.)
er derimot naturlige `EXTERNAL_CANONICAL`-adaptere UTEN denne konflikten.

### 4.12 Kart

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| Google Maps | `ALLEREDE_BYGGET (D-298)` | `GoogleMapsTransport` (`live-transports.ts`) - KUN Geocoding-API (`geocode`/`reverse_geocode`), API-nøkkel som `key`-query-parameter. D-64-sjekk kjørt eksplisitt FØR bygging: `modules/location` sin kanoniske lokasjons-/geofence-modell er UBERØRT (stateless adresse-oppslag, ikke personens posisjon over tid). `google_places`/`google_routes` under forblir separate, ubygde backlog-punkter. `GOOGLE_MAPS_LIVE_GATE=PENDING_CREDENTIALS`. Se D-298 i DECISIONS_AND_ASSUMPTIONS.md. |
| Google Places | `ALLEREDE_BYGGET (D-303)` | `GooglePlacesTransport` (`live-transports.ts`) - `search_places`/`get_place_details` (GET mot det eldre, stabile Places-API-et, `key`-query-parameter, samme mønster som Google Maps). SAMME D-64-domenevurdering som Google Maps: stateless tredjeparts-stedoppslag, IKKE eierens egen posisjon/geofence. STRUKTURELT LIK Google Maps: INGEN skrivehandling finnes - leverandøren tilbyr genuint bare lesing. `live_test: search_places` (query "Eiffel Tower"). `GOOGLE_PLACES_LIVE_GATE=PENDING_CREDENTIALS` (`JARVIS_GOOGLE_PLACES_API_KEY`) |
| Google Routes | `NY_BACKLOG` | Ingen kode funnet |

### 4.13 Observability

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| Sentry | `ALLEREDE_BYGGET (D-297)` | `SentryTransport` (`live-transports.ts`) - organisasjonsscopet REST-API v0, `Authorization: Bearer`. D-64-sjekk kjørt eksplisitt FØR bygging (denne radens tidligere advarsel): `Incident`/`IncidentEvidence` (`modules/incidents`) er FORTSATT Jarvis sin egen kanoniske tilstandsmaskin, UBERØRT av denne connectoren - `sentry.update_issue` endrer kun Sentry sitt EGET issue-status-felt, aldri `Incident.status`. Samme "tynt API-gjennomtrekk, ikke en konkurrerende domenemodell"-rolle som Docker/D-105 (som OGSÅ er både en `docker`-ToolGateway-connector OG en evidenskilde for `Deployment.source`). `SENTRY_LIVE_GATE=PENDING_CREDENTIALS`. Se D-297 i DECISIONS_AND_ASSUMPTIONS.md. |
| Grafana | `NY_BACKLOG` | Ingen kode funnet |
| Prometheus | `NY_BACKLOG` | Ingen kode funnet |

### 4.14 Sikkerhet

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| 1Password | `DROPPET (D-234)` | Tobias bekreftet at Infisical, allerede PRIMÆR `SecretProvider` (Q-05/D-211, skriving D-213), dekker behovet. Se D-234 i `DECISIONS_AND_ASSUMPTIONS.md` |

### 4.15 OS / enhet

| Integrasjon | Status | Referanse/merknad |
|---|---|---|
| Apple Push Notification service | `NY_BACKLOG` | Del av det eksisterende, `BLOCKED_EXTERNAL` D-36 Apple-runtime-sporet (krever Mac mini/Xcode/Developer-konto, se `docs/APPLE_PHASE8_CHECKLIST.md`) - ikke en isolert ny connector |
| iOS Shortcuts | `NY_BACKLOG` | Samme D-36-spor som APNs |
| Apple Watch | `NY_BACKLOG` | Samme D-36-spor - fysisk klokke-test er selv et navngitt D-36-akseptansepunkt |
| Windows | `IKKE EN CONNECTOR – ALLEREDE DEKKET (D-290)` | Operativsystemet Tobias sin PC/lokale Docker-drift kjører på (CLAUDE.md regel 9) - fullt dekket, ingen ny kapabilitet mangler. Se D-290: en EVENTUELL fremtidig ny evne (skrivebords-/prosessautomatisering PÅ Windows-PC-en) er IKKE dekket av denne raden og krever en egen, ennå ikke reist forespørsel |
| macOS | `IKKE EN CONNECTOR – ALLEREDE DEKKET (D-290)` | Henger sammen med det eksisterende, uendrede D-36 Apple-runtime-sporet - ikke en isolert ny connector. Se D-290 |

## 5. Home Assistant (spesialrolle)

- HA er **enhetsbuss og kontrollag** for fysiske enheter – aldri samtalemotor, aldri Jarvis-identitet.
- Jarvis → HA: via HA sitt API som registrert verktøy (klasse B for lys/klima; **klasse D for lås, alarm og
  sikkerhetsfunksjoner**).
- Sikkerhetsautomasjoner (frostsikring, lekkasjestopp, alarm) ligger deterministisk i HA og virker uten
  sky, uten Jarvis og uten LLM.
- HA Assist beholdes som lokal reservevei for grunnkommandoer når Voice Gateway er nede.
- Per sted (hus, hytte): egen HA-instans med rommetadata (`site_id`, `room_id`) som mappes til
  identitetsmodellen.

## 6. Modell-leverandører (via Model Gateway, ikke Tool Gateway)

- OpenAI, Anthropic, OpenRouter og lokale modeller bak felles adapter: egne TS-adaptere først,
  LiteLLM-proxy som mulig sidecar senere (se DECISIONS D-14 og OPEN_QUESTIONS Q-04).
- Per leverandør dokumenteres: region, databehandleravtale, trenings-/retensjonsvilkår, og hvilke
  memory spaces som er tillatt å sende dit (f.eks. `health` → kun lokal modell eller sterkt minimert).
- STT/TTS-leverandører følger samme regime og velges via benchmark i fase 5.

## 7. Feilhåndtering og robusthet

- Hver integrasjon har: helsesjekk, retry-policy med backoff, rate limit-håndtering, tokenutløpsvarsling
  (via watchdog) og dokumentert rollback.
- Integrasjonsfeil skal degradere funksjonalitet – aldri ta ned Core.
- All output fra integrasjoner går inn som hendelser i eventloggen med kilde og tillitsklasse.

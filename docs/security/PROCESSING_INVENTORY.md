# Jarvis – behandlingsoversikt og DPIA-trigger-matrise (UA0-PRIVACY)

**Status: UTKAST (D-420, 2026-10-06). IKKE juridisk gjennomgått og IKKE godkjent av eier.** Dette er den samlede
behandlingsoversikten som UA0-PRIVACY-porten manglet: hvilke data Jarvis lagrer, hvorfor, hvem som kan se dem, hvor lenge,
og hvilken DPIA som dekker dem. Den erstatter ikke de enkelte DPIA-ene (`docs/UA2_KNOWLEDGE_DPIA.md`, `UA3_BUSINESS_DPIA.md`,
`UA7_COMMUNICATIONS_DPIA.md`, `UA8_PERSONAL_TWIN_DPIA.md`, `UA9_VISION_DPIA.md`, `docs/security/DPIA_DRAFT.md`,
`docs/security/DPIA_VOICE.md`), men peker til dem. Behandlerstatus er ærlig: «IKKE VERIFISERT» betyr at region,
databehandleravtale, treningsvilkår og leverandør-retensjon ikke er kontrollert (krever eier/juridisk handling, jf. Q-32) - det er
aldri det samme som «godkjent».

**Vakt:** `modules/core/test/d420-processing-inventory.test.ts` feiler CI hvis (1) en tabell i migrasjonene mangler her, (2) en connector
i `CONNECTOR_REGISTRY` mangler her, (3) en modellleverandør i `capability-registry.ts` mangler her eller en skyleverandør står som verifisert
uten at det er gjort, eller (4) en DPIA-henvisning peker på en fil som ikke finnes. Ny tabell/connector/leverandør uten rad her = rød CI.

## 1. Datakategorier og tabeller

### Identitet, enheter og tilgang

- **Formål:** Hvem eieren er og hvilke enheter/sesjoner som har tilgang
- **Memory space/tenant:** personal/system (alle tabeller tenant-skopet med FORCE RLS unntatt dokumenterte globale: `scheduler_state`, `capabilities`, `evolution_change_ledger`, `self_modification_requests`, `github_rate_limit_state`, `telegram_poll_state`)
- **Datakategori:** Personopplysninger (navn, enhets-ID, offentlige nøkler)
- **Retensjon:** Utløpte/revokerte sesjoner, godkjenninger og påmeldingsbilletter slettes automatisk etter karens (≥ 7 dager, standard 30; migrasjon 073). Resten: så lenge kontoen finnes.
- **Eksterne mottakere:** Ingen (kun eget system)
- **Tabeller:** `action_confirmations`, `approvals`, `device_enrollment_tickets`, `devices`, `finance_kill_switch`, `organizations`, `owner_control_state`, `people`, `person_tenants`, `revoked_device_keys`, `session_grants`, `sessions`, `tenants`

### Samtaler og minne

- **Formål:** Samtalehistorikk, langtidsminne, kunnskapsgrafen og vektorer
- **Memory space/tenant:** personal/business/project/home/shared (health isolert; guest) (alle tabeller tenant-skopet med FORCE RLS unntatt dokumenterte globale: `scheduler_state`, `capabilities`, `evolution_change_ledger`, `self_modification_requests`, `github_rate_limit_state`, `telegram_poll_state`)
- **Datakategori:** Fritekst fra eieren, avledede fakta, embeddings (kan inneholde særlige kategorier)
- **Retensjon:** messages: ingen automatisk sletting ennå (prune-funksjonen i 073 rører ikke samtaler). Minne: bitemporalt (`valid_to`), versjoner beholdes; sletting/eksport via `docs/DATA_ERASURE.md` (erasure-inngang ikke koblet i produksjon, JARVIS-060).
- **Eksterne mottakere:** LLM-leverandører ser utdrag per tur etter sensitivitetsregelen (se behandlere); embeddings lokalt (bge-m3 via Ollama) når konfigurert
- **Tabeller:** `artifacts`, `brief_seen`, `commitments`, `deadlines`, `decisions`, `embeddings`, `entities`, `events`, `memory_episodes`, `memory_item_entities`, `memory_items`, `memory_links`, `memory_profiles`, `memory_sources`, `memory_spaces`, `memory_vectors`, `memory_versions`, `messages`, `relations`, `summaries`

### Kunnskapslag (dokumenter)

- **Formål:** Indekserte dokumenter fra tilkoblede kilder
- **Memory space/tenant:** per kilde/space (alle tabeller tenant-skopet med FORCE RLS unntatt dokumenterte globale: `scheduler_state`, `capabilities`, `evolution_change_ledger`, `self_modification_requests`, `github_rate_limit_state`, `telegram_poll_state`)
- **Datakategori:** Dokumentinnhold og chunk-embeddings fra eierens egne kilder
- **Retensjon:** Tombstones ved sletting i kilden; ellers så lenge kilden er koblet (UA2-DPIA).
- **Eksterne mottakere:** Kilden (f.eks. Drive) + embedding lokalt
- **Tabeller:** `knowledge_documents`, `knowledge_embeddings`

### Jobber, verktøy og revisjon

- **Formål:** Bevis på hva Jarvis har gjort, og durable jobbkø
- **Memory space/tenant:** system (alle tabeller tenant-skopet med FORCE RLS unntatt dokumenterte globale: `scheduler_state`, `capabilities`, `evolution_change_ledger`, `self_modification_requests`, `github_rate_limit_state`, `telegram_poll_state`)
- **Datakategori:** Parametere/utfall for verktøykall (hemmeligheter fjernes før lagring), jobbkontrakter og resultater
- **Retensjon:** tool_executions: ferdige rader slettes etter ≥ 30 dager (standard 180; `unverified`/`reserved` slettes aldri automatisk). audit_events/events/memory_versions er append-only og beholdes (oppbevaringspolicy er eierbeslutning). tasks: ingen automatisk sletting.
- **Eksterne mottakere:** Ingen
- **Tabeller:** `audit_events`, `capabilities`, `deployments`, `evolution_change_ledger`, `github_rate_limit_state`, `scheduler_state`, `self_modification_requests`, `tasks`, `telegram_poll_state`, `tool_executions`

### Kostnad og modellbruk

- **Formål:** Run-rate og modellkostnad; vedlikeholdstid per connector (`connector_maintenance_log`, append-only, kun metadata)
- **Memory space/tenant:** system (alle tabeller tenant-skopet med FORCE RLS unntatt dokumenterte globale: `scheduler_state`, `capabilities`, `evolution_change_ledger`, `self_modification_requests`, `github_rate_limit_state`, `telegram_poll_state`)
- **Datakategori:** Antall tokens, tidsbruk, leverandør, kostnad (ikke innhold)
- **Retensjon:** Ingen automatisk sletting ennå (egen indeks i 073; aggregeres til run-rate).
- **Eksterne mottakere:** Ingen
- **Tabeller:** `connector_maintenance_log`, `cost_events`

### Forretning (CRM, support, avtaler, drift)

- **Formål:** Kunder, leads, saker, avtaler og åpne forpliktelser
- **Memory space/tenant:** business (alle tabeller tenant-skopet med FORCE RLS unntatt dokumenterte globale: `scheduler_state`, `capabilities`, `evolution_change_ledger`, `self_modification_requests`, `github_rate_limit_state`, `telegram_poll_state`)
- **Datakategori:** Personopplysninger om kunder/kontakter (UA3-DPIA)
- **Retensjon:** Følger kundeforholdet; sletting via erasure-flyten (ikke koblet i produksjon).
- **Eksterne mottakere:** Gmail/Calendar m.fl. som kilder; ingen sending uten bekreftelse
- **Tabeller:** `business_activities`, `business_companies`, `business_contacts`, `business_followups`, `business_leads`, `business_open_loops`, `business_opportunities`, `business_scores`, `contract_events`, `contract_obligations`, `contract_versions`, `contracts`, `conversation_channel_links`, `conversation_identities`, `conversation_identity_merges`, `decision_log`, `goal_key_results`, `goals`, `operations_runbooks`, `operations_task_events`, `operations_tasks`, `operations_vendors`, `product_item_events`, `product_items`, `projects`, `risks`, `scenarios`, `support_ticket_events`, `support_tickets`

### Vekst og markedsføring

- **Formål:** Kampanjer, attribusjon og samtykke
- **Memory space/tenant:** business (alle tabeller tenant-skopet med FORCE RLS unntatt dokumenterte globale: `scheduler_state`, `capabilities`, `evolution_change_ledger`, `self_modification_requests`, `github_rate_limit_state`, `telegram_poll_state`)
- **Datakategori:** Kampanjedata, UTM/click-id (pseudonym), samtykkevalg
- **Retensjon:** Følger kampanjens levetid; samtykke er egen policy (consent-modulen).
- **Eksterne mottakere:** Annonseplattformer (Google Ads/Meta) kun når credentials er satt
- **Tabeller:** `consent_decisions`, `consent_enforcement_events`, `consent_enforcement_policies`, `marketing_attributions`, `marketing_campaign_action_recommendations`, `marketing_campaign_events`, `marketing_campaign_execution_commands`, `marketing_campaign_observations`, `marketing_campaign_tracking_tags`, `marketing_campaigns`, `marketing_experiments`, `marketing_spend_events`

### Økonomi og betaling

- **Formål:** Leverandører, forpliktelser, bank- og kortdata, samt deterministisk avstemming av pengebevegelser (WP-F1, D-462)
- **Memory space/tenant:** business/personal (alle tabeller tenant-skopet med FORCE RLS unntatt dokumenterte globale: `scheduler_state`, `capabilities`, `evolution_change_ledger`, `self_modification_requests`, `github_rate_limit_state`, `telegram_poll_state`)
- **Datakategori:** Finansdata (konto, transaksjoner, kort - særlig sensitivt; kun lokal modell, SECRET_RESTRICTED)
- **Retensjon:** Følger regnskapskrav (ikke avklart som sletteregel); webhook-hendelser: ingen automatisk sletting.
- **Eksterne mottakere:** Stripe, Vipps, Neonomics, Wallester, Fiken - kun etter eierens oppsett
- **Tabeller:** `bank_account_balances`, `bank_accounts`, `bank_consents`, `bank_transactions`, `card_authorizations`, `card_events`, `card_spend_policies`, `card_transactions`, `finance_procurement_items`, `finance_reconciliation_findings`, `finance_reconciliation_runs`, `finance_recurring_commitments`, `finance_spend_records`, `finance_spend_sync_cursors`, `finance_vendor_provider_bindings`, `finance_vendors`, `neonomics_webhook_events`, `payment_intent_events`, `payment_intents`, `provider_cards`, `stripe_refunds`, `stripe_webhook_events`, `vipps_captures`, `vipps_refunds`, `vipps_webhook_events`, `wallester_webhook_events`
- **Avstemming (`finance_reconciliation_findings`, `finance_reconciliation_runs`, migrasjon 100, WP-F1):** datakategori: REDIGERTE observasjoner (beløp, valuta, intensjons-/leverandør-id-er, tilstander, kontrollstatus per sjekk) - aldri kontonummer, KID, kortdata eller rå leverandørnyttelast. Formål: oppdage manglende/ekstra/uoverensstemmende beløp, ukjent utfall og mistenkt dobbeltbetaling mellom intensjon, leverandørutfall og Fiken-bilag (observasjon og varsel, aldri automatisk korreksjon). Retensjon: følger regnskapskravene som resten av økonomitabellene (løste funn og tidligere kjøringer beholdes som revisjonsspor; ingen automatisk sletting). Tilgang: tenant-policy + RESTRICTIVE space-policy med FORCE RLS; leses kun via `finance.get_reconciliation_status` (klasse A, eier-eksklusivt navnerom) og eierens `/finance/actions`. Sletting: registrert i erasure-planen (`modules/erasure/src/plan.ts`) før `payment_intents` (barn-FK før forelder). Leverandør: ingen ekstern prosessor - tabellene ligger i lokal Postgres; Fiken-lesing av bilag (kun med eierens credentials) lagrer ikke rå bilagsinnhold her.

### Hendelser og infrastruktur

- **Formål:** Hendelser, diagnoser og infrastrukturkjøringer
- **Memory space/tenant:** system (alle tabeller tenant-skopet med FORCE RLS unntatt dokumenterte globale: `scheduler_state`, `capabilities`, `evolution_change_ledger`, `self_modification_requests`, `github_rate_limit_state`, `telegram_poll_state`)
- **Datakategori:** Tekniske data (logger, diagnoser); kan inneholde stedsnavn/IP
- **Retensjon:** Følger hendelsen; ingen automatisk sletting ennå.
- **Eksterne mottakere:** Sentry/Grafana m.fl. kun hvis koblet
- **Tabeller:** `incident_diagnoses`, `incident_diagnosis_evidence`, `incident_evidence`, `incident_repair_tasks`, `incidents`, `infra_executions`, `infra_recovery_actions`

### Situasjonsmotor og kontroll

- **Formål:** Prioriterte situasjoner og pauser
- **Memory space/tenant:** personal/business (alle tabeller tenant-skopet med FORCE RLS unntatt dokumenterte globale: `scheduler_state`, `capabilities`, `evolution_change_ledger`, `self_modification_requests`, `github_rate_limit_state`, `telegram_poll_state`)
- **Datakategori:** Avledede situasjoner fra eierens egne data
- **Retensjon:** Løste situasjoner beholdes for forklarbarhet.
- **Eksterne mottakere:** Ingen
- **Tabeller:** `situation_autonomy_policies`, `situation_domain_pauses`, `situation_notification_policies`, `situations`

### Sted, helse, kontekst og rom

- **Formål:** Personlig digital tvilling (kun fake-kilder i dag)
- **Memory space/tenant:** health/home/personal (alle tabeller tenant-skopet med FORCE RLS unntatt dokumenterte globale: `scheduler_state`, `capabilities`, `evolution_change_ledger`, `self_modification_requests`, `github_rate_limit_state`, `telegram_poll_state`)
- **Datakategori:** Lokasjon og helsedata (særlige kategorier; helse alltid isolert og lokal behandling) - UA8-DPIA
- **Retensjon:** Retensjonspolicy-tabellene er fail-closed; ingen produsenter koblet i produksjon.
- **Eksterne mottakere:** Ingen (lokalt)
- **Tabeller:** `context_observations`, `health_metric_observations`, `health_retention_policies`, `location_observations`, `location_retention_policies`, `location_zone_visits`, `location_zones`, `rooms`, `sites`

### Syn og fysisk verden

- **Formål:** Romscope og hendelser fra kamera (kun syntetiske kilder i dag)
- **Memory space/tenant:** home (alle tabeller tenant-skopet med FORCE RLS unntatt dokumenterte globale: `scheduler_state`, `capabilities`, `evolution_change_ledger`, `self_modification_requests`, `github_rate_limit_state`, `telegram_poll_state`)
- **Datakategori:** Bilder/hendelser fra kamera (UA9-DPIA)
- **Retensjon:** Retensjonspolicy fail-closed; ingen produsenter koblet.
- **Eksterne mottakere:** Ingen (lokalt)
- **Tabeller:** `vision_event_observations`, `vision_retention_policies`, `vision_rooms`

### Sletting og personvern

- **Formål:** Sporing av slettekrav
- **Memory space/tenant:** system (alle tabeller tenant-skopet med FORCE RLS unntatt dokumenterte globale: `scheduler_state`, `capabilities`, `evolution_change_ledger`, `self_modification_requests`, `github_rate_limit_state`, `telegram_poll_state`)
- **Datakategori:** Fingeravtrykk (hash) av slettede poster for å hindre gjeninnføring
- **Retensjon:** Beholdes (bevis på at sletting skjedde).
- **Eksterne mottakere:** Ingen
- **Tabeller:** `erasure_fingerprints`, `erasure_requests`

## 2. Eksterne behandlere av innhold

### 2a. Modellleverandører (LLM) - erstatter `TBD`-raden i `PROCESSOR_REGION_MATRIX.md`
Sensitivitetsregelen (`isSensitivityEligible`, D-79/D-81): `SECRET_RESTRICTED` (helse, finans, hemmeligheter) går **kun** til lokale leverandører;
`PRIVATE`/`BUSINESS_CONFIDENTIAL` går aldri til gratis/delt sky. Standard chat prefererer lokal modell (Gemma/Ollama).

| Leverandør (`provider`) | Lokalitet | Region | DPA | Trener på data? | Retensjon hos leverandør | Status |
|---|---|---|---|---|---|---|
| `gemma_local` (Ollama på eierens PC) | lokal | eierens eget nett | ikke relevant | nei | ingen | I BRUK; tillatt for alle spaces inkl. health |
| `local_llm` (OpenAI-kompatibel lokal server) | lokal | eierens eget nett | ikke relevant | nei | ingen | tilgjengelig; alle spaces |
| `ollama` (lokal) | lokal | eierens eget nett | ikke relevant | nei | ingen | tilgjengelig; alle spaces |
| `scripted` (test) | lokal | - | - | - | - | kun test |
| `anthropic` | sky | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | NAVNGITT, IKKE VERIFISERT; aldri `SECRET_RESTRICTED` |
| `openai` | sky | **IKKE VERIFISERT** (LLM; STT/TTS er egen rad i matrisen) | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | NAVNGITT, IKKE VERIFISERT; aldri `SECRET_RESTRICTED` |
| `gemini` | sky | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | NAVNGITT, IKKE VERIFISERT; aldri `SECRET_RESTRICTED` |
| `gemma_hosted` (gratis-tier) | sky | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | kun `PUBLIC_OR_LOW_SENSITIVITY`; aldri `SECRET_RESTRICTED` |
| `kimi` | sky | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | NAVNGITT, IKKE VERIFISERT; aldri `SECRET_RESTRICTED` |
| `hermes` | sky | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | NAVNGITT, IKKE VERIFISERT; aldri `SECRET_RESTRICTED` |

Embeddings: lokalt (`bge-m3` via Ollama, `JARVIS_EMBEDDING_PROVIDER=ollama`); ellers hash-fallback uten semantikk. Ingen sky-embeddings.
Tale (STT/TTS) og Telegram: egne rader i `docs/security/PROCESSOR_REGION_MATRIX.md` (OpenAI STT/TTS er verifisert av eier 2026-09-22; Deepgram, ElevenLabs og Telegram er IKKE VERIFISERT).

### 2b. Connectors (`CONNECTOR_REGISTRY`)
Eierens egne kontoer hos hver leverandør; data forlater huset først når eieren har satt credential og en handling kalles. Vilkårene (region, DPA,
trening, retensjon) er **IKKE VERIFISERT** for alle skyleverandører under, med mindre annet er oppgitt. `backlog` = ikke i bruk.

| Connector (`id`) | Navn | Kategori | Behandler |
|---|---|---|---|
| `github` | GitHub | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `google_calendar` | Google Calendar | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `gmail` | Gmail | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `google_drive` | Google Drive/Docs | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `telegram` | Telegram | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `vercel` | Vercel | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `anthropic` | Anthropic API | model_provider | se 2a; IKKE VERIFISERT |
| `openai` | OpenAI API | model_provider | se 2a; IKKE VERIFISERT |
| `gemini` | Gemini API | model_provider | se 2a; IKKE VERIFISERT |
| `fiken` | Fiken | finance | ekstern finansleverandør (SECRET_RESTRICTED: kun lokal modell ser data); IKKE VERIFISERT |
| `stripe` | Stripe | finance | ekstern finansleverandør (SECRET_RESTRICTED: kun lokal modell ser data); IKKE VERIFISERT |
| `vipps` | Vipps | finance | ekstern finansleverandør (SECRET_RESTRICTED: kun lokal modell ser data); IKKE VERIFISERT |
| `neonomics` | Neonomics | finance | ekstern finansleverandør (SECRET_RESTRICTED: kun lokal modell ser data); IKKE VERIFISERT |
| `wallester` | Wallester | finance | ekstern finansleverandør (SECRET_RESTRICTED: kun lokal modell ser data); IKKE VERIFISERT |
| `notion` | Notion | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `onedrive` | OneDrive | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `dropbox` | Dropbox | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `google_sheets` | Google Sheets | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `microsoft_outlook` | Microsoft Outlook | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `brave_search` | Brave Search | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `tavily` | Tavily | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `exa` | Exa | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `playwright` | Playwright (lokal nettleserautomasjon, kun read-only) | tool_gateway | lokalt (kun read-only nettleserautomasjon i egen container) |
| `telnyx` | Telnyx | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `twilio` | Twilio | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `whatsapp` | WhatsApp | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `slack` | Slack | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `discord` | Discord | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `higgsfield` | Higgsfield | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `todoist` | Todoist | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `trello` | Trello | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `jira` | Jira | tool_gateway | eierens egen instans eller leverandørsky (URL settes av eier); IKKE VERIFISERT |
| `linear` | Linear | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `hubspot` | HubSpot | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `pipedrive` | Pipedrive | tool_gateway | eierens egen instans eller leverandørsky (URL settes av eier); IKKE VERIFISERT |
| `runway` | Runway | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `kling` | Kling | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `google_veo` | Google Veo | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `openai_images` | OpenAI Images | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `spotify` | Spotify | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `apple_music` | Apple Music | backlog | IKKE I BRUK (backlog) |
| `n8n` | n8n | tool_gateway | eierens egen instans eller leverandørsky (URL settes av eier); IKKE VERIFISERT |
| `zapier` | Zapier (MCP) | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `make` | Make | tool_gateway | eierens egen instans eller leverandørsky (URL settes av eier); IKKE VERIFISERT |
| `apple_shortcuts` | Apple Shortcuts | backlog | IKKE I BRUK (backlog) |
| `home_assistant` | Home Assistant | tool_gateway | eierens egen Home Assistant (lokalt nett) |
| `homekit` | HomeKit | backlog | IKKE I BRUK (backlog) |
| `folio` | Folio | backlog | IKKE I BRUK (backlog) |
| `google_maps` | Google Maps | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `google_places` | Google Places | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `google_routes` | Google Routes | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `sentry` | Sentry | tool_gateway | ekstern leverandør (eierens konto); IKKE VERIFISERT |
| `grafana` | Grafana | tool_gateway | eierens egen instans eller leverandørsky (URL settes av eier); IKKE VERIFISERT |
| `prometheus` | Prometheus | tool_gateway | eierens egen instans eller leverandørsky (URL settes av eier); IKKE VERIFISERT |
| `apns` | Apple Push Notification service | backlog | IKKE I BRUK (backlog) |
| `ios_shortcuts` | iOS Shortcuts | backlog | IKKE I BRUK (backlog) |
| `apple_watch` | Apple Watch | backlog | IKKE I BRUK (backlog) |

## 3. DPIA-trigger-matrise
En ny funksjon/kilde som treffer minst én trigger MÅ ha (eller oppdatere) tilhørende DPIA FØR den får data i produksjon (fase-/porten gjelder).

| Trigger | Eksempel | Krever | DPIA-dokument | Status |
|---|---|---|---|---|
| Særlige kategorier (helse) | Apple Health, helsemålinger | DPIA + isolert `health`-space + lokal behandling | `docs/UA8_PERSONAL_TWIN_DPIA.md`, `docs/security/DPIA_DRAFT.md` | UTKAST, ikke godkjent; ingen produsenter koblet |
| Lokasjon | soner, besøk, kjøretøy | DPIA + retensjonspolicy (fail-closed) | `docs/UA8_PERSONAL_TWIN_DPIA.md` | UTKAST; kun fake-kilder |
| Kamera/bilder/syn | HA-kamera, dørklokke | DPIA + rom-scope + retensjon | `docs/UA9_VISION_DPIA.md` | UTKAST; ingen produsenter |
| Stemme/lydopptak | STT/TTS, rå lyd | DPIA + ingen rå-lyd-lagring som standard | `docs/security/DPIA_VOICE.md` | UTKAST; rå-lyd-dump av som standard (JARVIS-080 åpen) |
| Kundedata/CRM | kontakter, leads, saker | DPIA + sletteflyt | `docs/UA3_BUSINESS_DPIA.md` | UTKAST; ingen business-tenant på NAS |
| Kommunikasjon på tvers av kanaler | e-post, Telegram, identitetsoppløsning | DPIA + reversibel identitetsoppløsning | `docs/UA7_COMMUNICATIONS_DPIA.md` | UTKAST |
| Kunnskapskilder (dokumenter, e-postvedlegg) | Drive, Obsidian, GitHub | DPIA + tombstones/sletting | `docs/UA2_KNOWLEDGE_DPIA.md` | UTKAST; én kilde i produksjon |
| Ny ekstern behandler uten verifiserte vilkår | ny LLM/STT/connector | rad i denne filen + `PROCESSOR_REGION_MATRIX.md`; ingen sensitive spaces før VERIFISERT | `docs/security/PROCESSOR_REGION_MATRIX.md` | løpende |
| Finansdata | bank, kort, betaling | `SECRET_RESTRICTED` (kun lokal modell) + klasse D-kjede | `docs/security/DPIA_DRAFT.md` | UTKAST; D-kjede ikke ferdig (D-375) |
| Automatiserte beslutninger med rettsvirkning/betydelig effekt | autonom utsendelse, betaling | menneske i løkka (bekreftelse), klasse D-pipeline | `docs/security/DPIA_DRAFT.md` | håndhevet i kode; DPIA ikke godkjent |
| Deling på tvers av memory spaces | personal -> business | eksplisitt policy + juridisk/privacy-port (ingen cross-space-læring som standard) | `docs/security/TENANT_MODEL.md` | policy i kode; ikke gjennomgått |

## 4. Åpne punkter (ikke løst av dette dokumentet)
1. Eier/jurist må gjennomgå og godkjenne DPIA-ene og vilkårene for skyleverandørene (Q-32) - ingen av dem er flippet til VERIFISERT.
2. Erasure-inngangen (`ErasureService`) er ikke koblet i produksjon (JARVIS-060); sletting på tvers av alle tabeller er ikke bevist.
3. `messages`, `tasks`, `cost_events` og webhook-tabeller har ingen automatisk sletting ennå (kun indeks/oppbevaringsgrunnlag).
4. Dokumentet er skrevet ut fra kode og eksisterende DPIA-er; det er ikke kontrollert mot faktisk drift på NAS.


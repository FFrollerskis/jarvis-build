# Eier-handlinger for å lukke HF1/HF2 (WP-J3)

Alt Claude kan bygge og teste uten deg er bygget (se [CLOSURE_MATRIX_HF1_HF2.md](CLOSURE_MATRIX_HF1_HF2.md)). Det som står igjen for å **verifisere og lukke** kan bare du gjøre: velge, levere nøkler, utføre ting på verten eller i den fysiske verden. Dette dokumentet er den ene listen. Den erstatter ikke matrisens §8, men gjør den til en sjekkliste med hvem/hva/hvorfor/hvor.
Statusdokument (ADR-001 nivå 6), ikke et krav. Økten som bruker listen: [runbooks/VERIFICATION_SESSION_HF1_HF2.md](runbooks/VERIFICATION_SESSION_HF1_HF2.md).

**Regler:** Aldri lim nøkler, tokens, `.env` eller PEM-filer i chat – skriv dem rett inn på NAS-en (vault/`.env`) og si bare «satt». Et generelt «ja» velger ikke leverandør (CLAUDE.md regel 12): leverandørvalg er egne beslutninger. Lemping av en sikkerhetsregel krever en navngitt D-beslutning (ingen stille unntak).
**Typer:** `BESLUTNING` (bare du kan velge) · `CREDENTIAL` (konto/nøkkel bare du kan skaffe) · `VERT` (må gjøres på NAS/maskin) · `FYSISK` (enhet/person) · `GJENNOMGANG` (du leser/godkjenner).

## 1. Gjør først (mest effekt, minst arbeid)

| # | Handling | Type | Låser opp |
|---|---|---|---|
| 1 | Oppdater NAS-en etter [runbooks/NAS_UPDATE_HF1_HF2.md](runbooks/NAS_UPDATE_HF1_HF2.md) (backup først) og kjør `ops/acceptance/nas-hf1-hf2-gate.sh` | VERT | Alt annet: uten baseline vet vi ikke hva vi måler |
| 2 | Signer Safety Constitution offline og fest fingeravtrykket i NAS-`.env` ([runbooks/EV0_CONSTITUTION_SIGNING.md](runbooks/EV0_CONSTITUTION_SIGNING.md)); vurder budsjettlåser; øv break-glass ([runbooks/EV0_BREAK_GLASS.md](runbooks/EV0_BREAK_GLASS.md)) | VERT + BESLUTNING | EV-0 (`constitution_unsigned`-WARN forsvinner); forutsetning for alt som senere kan få lov å endre seg selv |
| 3 | Rotér Infisical-nøklene som ble limt i chat tidligere (Q-47e) og sett `JARVIS_DESTINATION_HOST_ALLOWLIST` (Q-47c) | CREDENTIAL + VERT | Lukker kjente hemmelighetsrester før noe nytt kobles på |
| 4 | Ta beslutningene i §2 (særlig Q-48 og F1) | BESLUTNING | Business OS, planlagte jobber i bedrifts-tenant |
| 5 | Velg off-site-mål og heartbeat-monitor for backup (§3) | BESLUTNING + CREDENTIAL | EV-20, Fase 10, restore-drill |

## 2. Beslutninger (bare du kan velge)

| # | Beslutning | Hvorfor den trengs | Standard hvis du ikke velger |
|---|---|---|---|
| B1 | **Q-48:** hvordan skal de planlagte jobbene som kjører som `system` (`business-events-sync`, `conversation-graph-sync`, `support-inbox-sync`) få Gmail/Kalender-credentials i en bedrifts-tenant: **A** la planlagte LESE-jobber kjøre som eier-identitet i dine tenanter (enklest; slik ukebrief og situasjonssveip allerede kjører), **B** en egen «system»-prinsipal i `credentialBinding` med smal tillatelse (kun klasse A, kun dine tenanter; ryddigere, mer arbeid) eller **C** vent på tenant-topologien (JARVIS-044) | Jobbene avvises i dag med `credential_not_bound_to_identity` og vises som feilet (ærlig, D-442/D-443). En bedrifts-tenant som ikke er den primære krever uansett at `owner_tenants` utvides (`JARVIS_OWNER_EXTRA_TENANTS`) | **C nå** (D-450): uendret oppførsel, avvist og synlig. Anbefaling: A eller B sammen med topologibeslutningen. **Eier 2026-10-10 (D-468):** avtales med Jarvis når temaet blir aktuelt; C gjelder inntil da |
| B2 | **Q-54 (F1, PR #326):** skal `JARVIS_OWNER_EXTRA_TENANTS` gi suverenitet også til eierens EGNE planlagte jobber (ukentlig forretningsbrief, situasjonssveip) – slik det virker nå, fordi autoriteten avgjøres av person + tenant, ikke kanal – eller bare til signerte økter? | Med dagens valg kan situasjonssveipet auto-ACT klasse C/D i bedrifts-tenanten (avgrenset av din autonomi-policy). «Bare signerte økter» er én linje i `resolveAuthorityMode`, men da trenger sveip og brief Q-48 først | Dagens valg (dokumentert og låst av test); flagget er dormant og påvirker ingenting før du setter det. **Eier 2026-10-10 (D-468):** avtales med Jarvis når temaet blir aktuelt; dagens valg gjelder inntil da |
| B3 | **Q-55 (E1 M2, PR #324):** er «strengest» riktig standard for skymål-mutasjoner (Cloudflare DNS/WAF/SSL/cache, Postgres-økter, Infisical-rotasjon): enhetssignert økt kreves, aldri tale/Telegram/system? Evt. lempe per handling (da navngitt D-beslutning, D-41/D-192-avveining) | Å kreve signert økt er tryggest; å lempe gjør rutinearbeid (f.eks. cache-purge) enklere | **Besluttet A 2026-10-10 (D-468, «kjør på»):** strengest beholdes |
| B4 | **SLO-målene** (EV-2) – godkjenn forslagene eller endre dem | Uten dem måler rapporten mot forslag, ikke mot mål du har valgt | Forslag gjelder (merket som forslag) |
| B5 | **Churn-/SLA-terskler** (`JARVIS_SUPPORT_SLA_HOURS`, churn-signalene i WPD2 §4) og om en autonomi-policy bundet til domenet `retention` noensinne skal få lov til å handle automatisk | Churn-signaler handler aldri mot kunder; bare open-loop, og auto-ACT kun via din policy | Ingen policy = ingen auto-ACT; ugyldig SLA-verdi stopper oppstart (fail closed) |
| B6 | **Q-56 (F5, PR #326) `business_change_log`:** egen sletterolle/trigger eller akseptere at app-rollen har DELETE (trengs for erasure/oppbevaring)? | Historikken kan omskrives av en kompromittert app-prosess; den uforanderlige revisjonen er `audit_events` | **Besluttet A 2026-10-10 (D-468, «beholde»):** dokumentert og akseptert |
| B7 | **Kunnskapskilder:** hvilke mapper/rom/Drive-mapper, og sensitivitetsgulv/-tak per kilde (D1) | Systemet kan ikke gjette hva som er privat; helse/`special` holdes uansett tilbake fra sky | Ingen kilder (`JARVIS_KNOWLEDGE_SOURCES` tom) |
| B8 | **Radar-kilder** (`JARVIS_RADAR_SOURCES`, https og vanlig vertsnavn) | EV-3 henter bare fra kilder du eier/velger | Inert (ingen nettverkskall) |
| B9 | **Leverandørvalg som ikke er tatt (CLAUDE.md regel 12):** e-sign (Q-28 B), bil-provider (Q-13), Pieces (Q-22, ingen kjent API), hosting-/stack-valg (Q-42) | «X løser dette allerede» er ikke nok til å gjøre X til domenekjernen; Core-vs-Adapter-porten må først gå | Ikke bygget/valgt |
| B10 | **Aktivering av selvendring (V3/EV-6):** kommer ikke i dette programmet | Selvmodifikasjon er frosset (D-397); D-32, EV-0, worker-isolasjon og din navngitte D-beslutning kreves | `activation_decision` er alltid `false` |
| B11 | **Sensitivitet-resensitize:** sett `JARVIS_MEMORY_RESENSITIZE=apply` etter å ha sett tallet i EV-10-rapporten | Nattlig sveip rydder gamle minnerader | `report` (kun rapport) |

## 3. Nøkler, konti og tilgang (bare du kan skaffe dem – aldri i chat)

| # | Hva | Brukes av | Hvor står trinnene | Merknad |
|---|---|---|---|---|
| C1 | **Kimi- og Hermes-nøkler** + at `gemma_local` svarer; sett `JARVIS_MESH_TOOLS_VERIFIED` først etter røyktesten | D4 AI Mesh | [runbooks/AI_MESH_ACCEPTANCE.md](runbooks/AI_MESH_ACCEPTANCE.md) §1–§3 | Røyktesten koster noen øre |
| C2 | **GitHub App** (opprett, installer på ETT repo, privatnøkkel i vaulten) + et eget tomt test-repo | C3, C1 | [runbooks/GITHUB_APP.md](runbooks/GITHUB_APP.md) steg 1–6 | Produksjonsrepoet brukes aldri til akseptanse |
| C3 | **Vertsinstallasjon av job-runner** (Docker-gruppe, tjeneste, brannmur/egress-proxy, fine-grained PAT for ETT sandbox-repo, `ACCEPTANCE_REPO`) | C1 | [runbooks/JOB_RUNNER.md](runbooks/JOB_RUNNER.md) §3–§5 | `sudo` på verten; ekte Claude-kjøring (J13) koster noen øre |
| C4 | **Off-site-mål** (rclone-remote, rsync+ssh-nøkkel eller lokal sti) og **heartbeat-URL** hos en ekstern monitor; cron-oppføring; montering av backup-statusmappen | C2 | [remediation/BACKUP_RESTORE_RUNBOOK.md](remediation/BACKUP_RESTORE_RUNBOOK.md) | `BLOCKED_EXTERNAL` til du har valgt |
| C5 | **Cloudflare API-token** med minste nødvendige rettigheter + konto-id + sandbox-sone-id | E1 | [runbooks/CLOUDFLARE_CONNECTOR.md](runbooks/CLOUDFLARE_CONNECTOR.md) §3–§4 | Token-tillatelsene er lest via søk, ikke fra nedlastet dokumentasjon: bekreft hver linje i token-dialogen |
| C6 | **Langfuse/Infisical** (eksisterende variabler) og evt. rotasjons-id-er i `JARVIS_INFISICAL_ROTATION_IDS` (helst mot en test-nøkkel) | E1 | [runbooks/INFRA_CONTROLLED_TARGETS.md](runbooks/INFRA_CONTROLLED_TARGETS.md) §3, §5 | – |
| C7 | **Stripe testnøkkel** (`JARVIS_STRIPE_TEST_SECRET_KEY`); egne konti for Vipps, Neonomics, Wallester, Fiken | F1 | [runbooks/FINANCE_D_CHAIN.md](runbooks/FINANCE_D_CHAIN.md) §5, §8 | Alle leverandører utenom Stripe test er `BLOCKED_EXTERNAL`. **Sett aldri** `JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE=true` for en test |
| C8 | **Google OAuth/Drive** (Docs/Slides/Sheets) og monteringsstier for Obsidian-vault, filmapper og transkripter | D1 | [runbooks/KNOWLEDGE_SOURCES.md](runbooks/KNOWLEDGE_SOURCES.md) §2–§5 | Start med én testmappe |
| C9 | **Bedrifts-tenant** (`ops/nas/provision-business-tenant.sh`, innrullert enhet i tenanten) og evt. **webhook-hemmelighet** for produktbruk (≥ 32 tegn) og avsenderens HMAC-oppsett | D2 | [runbooks/WPD2_BUSINESS_OS.md](runbooks/WPD2_BUSINESS_OS.md) §1, §3 | Avsenderen må hashe konto-/bruker-id-er selv; masken oppdager ikke navn-lignende verdier |
| C10 | **Telegram** (finnes) – kontroller at varsler når deg; **feature-flagg** du velger å slå på etter hver blokk | C4, E1, F1 | [runbooks/NAS_UPDATE_HF1_HF2.md](runbooks/NAS_UPDATE_HF1_HF2.md) §4 | Ett flagg om gangen |
| C11 | Senere (ikke bygget ennå): Google Ads developer token, Meta-verifisering, Apple Developer-konto/Mac (D-36), Home Assistant-instans + token, bil-provider, e-sign-leverandør | Growth/Comms/Personal/Vision | matrisen §4 | Trengs først når byggingen når dit |

## 4. Verts- og fysiske handlinger

| # | Handling | Hvor |
|---|---|---|
| V1 | Branch protection på `main` (PR kreves, CI grønn, ingen force-push) – `BLOCKED_EXTERNAL` | GitHub-innstillinger |
| V2 | Sett eier-miljøet før redeploy (Q-45e) og kontroller at `.env` aldri havner i git | NAS |
| V3 | Kjør `ops/backup/acceptance-ops.sh nas …` og `drill … --from-offsite` (på maskinen med privatnøkkelen) og fyll inn RTO/RPO | [remediation/BACKUP_RESTORE_RUNBOOK.md](remediation/BACKUP_RESTORE_RUNBOOK.md) |
| V4 | ≥ 100 norske lydprøver og måling av WER, P50/P95 (D-30) | [VOICE_BENCHMARK.md](VOICE_BENCHMARK.md) |
| V5 | Xcode/iPhone/Watch/TestFlight (D-36) | [APPLE_PHASE8_CHECKLIST.md](APPLE_PHASE8_CHECKLIST.md) |
| V6 | Ekte Home Assistant-instans med romkart og state-readback-øvelse | matrisen §3 (HA-RUNTIME) |
| V7 | Legg HF6-filen (Q-43) og HF2-PDF-en i `docs/input/` hvis planenes egne akseptansekriterier skal måles | matrisen §8 |

## 5. Gjennomganger du må lese/godkjenne

| # | Hva | Hvorfor |
|---|---|---|
| G1 | **DPIA-ene** ([UA2](UA2_KNOWLEDGE_DPIA.md), [UA3](UA3_BUSINESS_DPIA.md), UA7/UA8/UA9 når de bygges) | UA0-PRIVACY krever at eier har godkjent dem |
| G2 | **Smale uavhengige re-reviewer** før aktivering (anbefalt, ikke blokkerende for merge): F1 pengekjeden, C1 job-runner, C4 V2-push, C2 globals-filter, H0/B2, D1 filleser + skyskjerm, D2 fixes, D4, E1 step-up/eier-port/WAF-roundtrip | Rettelsene etter hver review er ikke selv re-reviewet |
| G3 | **Evidensfilene** før de committes (redigering er mønsterbasert) | En hemmelighet uten kjent form fanges ikke |
| G4 | **Samlet docs-PR** (PR #328: D-IDer for C1, D1, D2, D4, E1, F1, H0 m.fl., matriseradene, Q-54…Q-56 og statusfilen) | Beslutningene føres først når koden er merget |

## 6. Hva som IKKE venter på deg

Alt `DORMANT` er av til du slår det på og ødelegger derfor ingenting ved å ligge. Ingen kodeblokkering står på en eier-handling bortsett fra radene markert `BLOCKED_EXTERNAL` i matrisen. Kodeprogrammene som var satt på byggepause (D-468) er bygget etter at du opphevet pausen (D-470): Growth-skriving, Comms, Personal, Vision, Situation-broer, Connector SDK, kontrollsentrene, kostmodell EV-22/23 og kredittpacing (D-476). Alt er `DORMANT`/AV og `NOT VERIFIED`; se §7.

## 7. Etter byggeprogrammet D-470 (K, H1/H2, I, B3, D3, B4, G1–G4 og N1)

Alt under er bygget som `DORMANT`/AV og `NOT VERIFIED`. Spørsmålene Q-63..Q-76 i [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) har hver en anbefaling; et samlet «ja til anbefalingene» holder for å komme videre. Status per del: [CLOSURE_MATRIX_HF1_HF2.md](CLOSURE_MATRIX_HF1_HF2.md) §4.

| # | Handling | Type | Låser opp |
|---|---|---|---|
| N1 | **Koble GitHub på nytt** (claude.ai Settings → Connectors), bekreft e-posten på GitHub og sjekk Actions-kvoten (tidligere `startup_failure`) | `HARD_EXTERNAL_BLOCKER` + CREDENTIAL | Push, PR-er, CI og merge av alle lokale grener (rekkefølge i PROJECT_STATUS) |
| N2 | **Ta beslutningene Q-63..Q-75** (K, H1/H2, I, D3, B3, B4, G1–G4; alle har anbefaling) | BESLUTNING | Aktivering av hver del; Q-67 (kredittens fornyelse den 15., hard stopp med lokal fallback) er allerede besluttet |
| N3 | **Navngitt D-beslutning om JARVIS-111/Q-71** (enhetstype → tillatte kanaler for step-up; innrullering) og start av WP-S1 | BESLUTNING | At «tale, Telegram og klokke kan ikke åpne dør» også gjelder uærlige klienter; krever endring i kjerne-autentisering |
| N4 | **Sett `JARVIS_CLAUDE_BUDGET_USD`** (anbefalt 95 til tempoet er kalibrert) etter NAS-verifisering ([runbook](runbooks/WPB4_CLAUDE_BUDGET_PACING.md)) | VERT | Månedlig Claude-kreditt (D-476) og tempostyring |
| N5 | **Eksterne forutsetninger per del:** Google Ads developer token, Meta-verifisering og test-sandbox-kontoer (UA-4); Meta app review, Teams delegert samtykke, Google Contacts re-samtykke, Twilio/Telnyx-numre og Reservasjonsregisteret/samtykkeregister (UA-7); iPhone/Watch-app, bil-leverandør og test-Apple-ID eller selv-hostet CalDAV (UA-8); kamera, egen HA-bruker med minimale rettigheter og lokal visjonsmodell (UA-9); lokal modell og NAS for å observere ACT (UA-10) | CREDENTIAL + FYSISK + BESLUTNING | Live-verifisering av hver del (alt er `NOT VERIFIED` til da) |
| N6 | **Juridisk gjennomgang av DPIA-utkastene** [UA4](UA4_GROWTH_DPIA.md), [UA7](UA7_COMMUNICATIONS_DPIA.md), [UA8](UA8_PERSONAL_TWIN_DPIA.md) og [UA9](UA9_VISION_DPIA.md) (UA-10 følger [UA10_SITUATION_ENGINE_DESIGN.md](UA10_SITUATION_ENGINE_DESIGN.md)) | GJENNOMGANG | Aktivering av Comms (utgående), Personal (helse, barn, DAV), Vision (lagring) og Growth |
| N7 | **NAS-verifisering steg for steg** per runbook: [K](runbooks/WPK_LEDGER_REMNANTS.md), [H0–H2](runbooks/WPH1_CONTROL_CENTERS.md), [I](runbooks/WPI_CONNECTOR_SDK.md), [B3](runbooks/WPB3_EVOLUTION_CENTERS.md), [D3](runbooks/WPD3_GROWTH_WRITES.md), [B4](runbooks/WPB4_CLAUDE_BUDGET_PACING.md), [G1](runbooks/WPG1_COMMS.md), [G2](runbooks/WPG2_PERSONAL.md), [G3](runbooks/WPG3_VISION.md), [G4](runbooks/WPG4_SITUATION_BRIDGES.md), [N1](runbooks/WPN1_RESTRICTED_HISTORY.md) | VERT | Fra `NOT VERIFIED` til `VERIFIED` (med evidensfil) |
| N8 | **Utgående sending (G1):** JARVIS-112 (a) må rettes før `JARVIS_COMMS_OUTBOUND` slås på | BESLUTNING (bygg først) | Utgående meldinger og AI-ringing |
| N9 | **WP-N1 (D-477):** ta beslutningene i Q-76 (smitte, AI-kost-bryter, backfill, jobber før aktivering, avledet finansmetadata) og si fra hvis du vil nedlegge veto mot begrenset-merkingen (Q-66 alternativ B). Aktivering: `JARVIS_RESTRICTED_CONTEXT_GUARD=on` først etter NAS-verifiseringen ([runbook](runbooks/WPN1_RESTRICTED_HISTORY.md) steg 1-8 og 7b-7e), før eller sammen med `JARVIS_CONTROL_CENTER_FINANCE` og `_VALUE` | BESLUTNING + VERT | Finans- og Verdi-sentrene (D-473/D-474) og at et låst svar aldri følger historikken til en skytur |

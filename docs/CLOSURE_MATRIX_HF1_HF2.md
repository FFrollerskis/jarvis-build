# Lukkingsmatrise HF1 (Sovereign Autonomy v4.0) og HF2 (Evolution v1.2)

**Formål (D-450, Tobias 2026-10-09: «… får vi gjennom for å få verifisert og lukket alt»):** ett sted som viser, per punkt i de to masterplanene, hva som er **bygget**, hva som er **koblet til kjøretiden**, hva som er **sovende** (bygget, bevisst ikke aktivert), hva som **ikke** er bygget og hvorfor, og nøyaktig hva som gjenstår for å **verifisere og lukke**. Dette er en statusoversikt, ikke et krav (ADR-001 nivå 6). Detaljene bor i `DECISIONS_AND_ASSUMPTIONS.md`, `RUNTIME_GATES.md` og `remediation/FINDINGS_LEDGER.md`.

**Kilder:** UA-gap-audit 2026-10-05 (HEAD `7f859e2`) + D-420…D-449 + PR-ene i bygge-programmet etter D-450. Raden oppdateres i samme PR som endrer den.

**Statusord (ADR-001 §2.4 + bygge-status):** `WIRED` = bygget og koblet til kjøretiden · `DORMANT` = bygget og testet, bevisst ikke aktivert (aktivering krever navngitt D-beslutning) · `BUILT_UNWIRED` = bygget som kode/ren logikk, ikke koblet · `NOT_BUILT` = ikke bygget (årsak oppgitt) · `CODE_FIXED`/`VERIFIED`/`BLOCKED_EXTERNAL`/`DEFERRED` som i ADR-001. **Ingenting under er `VERIFIED` før et artefakt (kommando-output/host-kjøring på gjeldende kode) er lenket.** Siste NAS-observasjon: 2026-10-08, akseptansegate 10 PASS / 2 WARN / 0 UNKNOWN / 0 FAIL.

## 1. HF2 Evolution v1.2 (EV-0 … EV-23)

HF2-PDF-en ligger ikke i repoet; radene bygger på beslutningsloggen D-406…D-419, D-452 og koden. **Alle `WIRED`-rader er observasjon (`acts: false`): ingenting skrives eller utføres, selvendring er frosset (D-397), og ingenting er `VERIFIED` før det er observert på NAS.**

| EV | Innhold | Kode | Status | For å verifisere/aktivere |
|---|---|---|---|---|
| EV-0 | Safety Constitution (Ed25519, E0–E3), endringsregister (hash-kjede, migr. 075), budsjettlåser, break-glass, oppstartssjekk | `modules/self-modification/src/{constitution,change-ledger,budget-lock}.ts`, `ops/break-glass/`, `apps/api/src/ev0-boot.ts`; rapportseksjon `evolution-source.ts` (EV-0/EV-8) | `DORMANT` (oppstartssjekken og endringsgrensene er `WIRED` som observasjon) | **Tobias:** generer nøkkel offline, signer, fest fingeravtrykk i NAS-`.env` (`EV0_CONSTITUTION_SIGNING.md`); vurder budsjettlås-utkast; øv break-glass (`EV0_BREAK_GLASS.md`). NAS viser `constitution_unsigned` (WARN). |
| EV-1 | Selvmodell: selvdiagnose, begrensningsregister, confidence-gate | `modules/executive/src/self-model/` | `WIRED` (chat «hva er galt med deg», `executive.get_self_diagnosis`) | Observer svaret i chat på NAS. |
| EV-2 | Telemetri, SLO, drift, dataskvalitet | `modules/executive/src/slo/`, `apps/api/src/slo-source.ts` | `WIRED` (chat «hvor bra yter du», `executive.get_slo_report`) | **Tobias:** godkjenn SLO-målene (forslag). |
| EV-3 | Radar: innhenting fra eierens egne kilder gjennom sikkerhetssonen (ubetrodd forskning, karantene, sikkerhetshendelse) | `evolution/radar.ts` (sone), `apps/api/src/evolution-radar.ts` (henting), rapportseksjon EV-3 | `WIRED` (D-452 B2; **inert uten `JARVIS_RADAR_SOURCES`** - ingen nettverkskall; kun status per kilde, aldri innhold) | **Tobias:** velg kildene (https, vanlig vertsnavn) i `JARVIS_RADAR_SOURCES`; observer første sveip i rapporten. |
| EV-4 | Gylden suite (regresjonsport) | `apps/api/src/golden-suite.ts` (~32 deterministiske oppgaver med proveniens og suite-digest), `evolution/evals.ts` | `WIRED` (rapportseksjon; en deterministisk selvtest av Jarvis' egne regler, IKKE en LLM-basert eval) | Golden-task-bibliotek fra ekte oppgaver (blind A/B krever modellkjøring - ikke bygget). |
| EV-5 | Forslagsskjema | `evolution/proposal.ts`, `evolution_change_ledger` | `WIRED` (rapportseksjon: forslag og endringsregister) | Eier gjennomgår første forslag. |
| EV-6 | Selvkoding | `readiness.ts` (kun beredskap) | `DORMANT` (beredskapsvisning; `activation_decision` er ALLTID false; selvendring er frosset, D-397) | D-32 må være `VERIFIED` først, så navngitt D-beslutning. |
| EV-7 | Avhengighetsport | `evolution/supply-chain.ts`, `ops/evolution/dependency-check.ts` | `WIRED` som skript (kjøres av en person eller CI mellom to commits; exit 1 ved treff - aldri av Jarvis selv) | Kjør skriptet i CI/før merge. |
| EV-8 | Utrulling shadow→staging→canary→full, tilbakerulling | `evolution/release-gate.ts`; change freeze i rapporten | `WIRED` (change freeze fra oppstartssjekk, SLO, kill switch og åpne hendelser) | Shadow/canary-infrastruktur finnes ikke ennå. |
| EV-9 | Selvhelbredelse H0–H4, hendelsesløkke | `evolution/heal.ts`, rapportseksjon EV-9 | `WIRED` som visning (stigen mot ekte funn; ingen reparasjon utføres) | H2 krever forhåndsgodkjenning (`JARVIS_EV_PREAPPROVED_FAILOVER`) og UA-port live. |
| EV-10 | Minnevedlikehold (ferskhet, kildekvalitet, forgiftning, sensitivitetsdrift) | `evolution/memory-maintenance.ts`, rapportseksjon EV-10 (leser som app-rolle, helse/gjest utelatt) | `WIRED` (observasjon; ingenting slettes eller slås sammen) | Se «sensitivitetsdrift» og sett `JARVIS_MEMORY_RESENSITIZE=apply` etter å ha sett tallet. |
| EV-11 | Utfallslæring | `readiness.ts` | `DORMANT` (beredskap) | Sporbare utfall fra UA-3/4/7 må finnes. |
| EV-12 | Modellruting innen eierens allowlist | `evolution/model-autopilot.ts` (+ modellrådgiveren D-399 i shadow), `meshStatus()` | `WIRED` i skygge (velger/ruter ingenting) | Bake-off (D-439) kjøres. |
| EV-13 | Personlighet som versjonert tone-lag | `evolution/personality.ts`, `readiness.ts` | `DORMANT` (beredskap) | – |
| EV-14 | Uttrykkstilstand | `evolution/expression-state.ts`, `readiness.ts` | `DORMANT` (beredskap) | – |
| EV-15 | Mål-autonomi | `readiness.ts` | `DORMANT` (beredskap; venter UA-10/11) | – |
| EV-16 | Ressurs-/kostprognose | `evolution/resource.ts`, `cost_events` | `WIRED` (rapportseksjon: avvik og månedsprognose) | – |
| EV-17 | Credential-vurdering | `evolution/credentials.ts`, connector-registeret | `WIRED` (rapportseksjon; utløpsdato er IKKE målt) | – |
| EV-18 | Connector-fabrikk | `readiness.ts` | `DORMANT` (beredskap; etter 3–5 beviste connectors) | Connectors må være beviste (`JARVIS_EV_VERIFIED_GATES=CONNECTOR_FACTORY`). |
| EV-19 | Vedlikeholdsplan | `evolution/maintenance-schedule.ts`, `scheduler_state` | `WIRED` (rapportseksjon, ærlig dekning av hvilke oppgaver som har en utfører) | – |
| EV-20 | Uavhengig nødtilbakekall / off-site | `readiness.ts` | `DORMANT` (beredskap; venter bevist off-site-restore, WP-C2) | Off-site restore må være bevist (`OFFSITE_RESTORE`). |
| EV-21 | Sikkerhetstilpasning, red-team-dom | `evolution/security-adaptation.ts`, `golden-suite.ts` (gruppert på angrepsklasse) | `WIRED` (red-team-lite: deterministisk selvtest av KJENTE angrepsklasser, ikke en LLM-red-team-agent) | Red-team-korpus fra ekte hendelser. |
| EV-22 / EV-23 | Bygger på Admin Control Center | `readiness.ts` | `DORMANT` (beredskap; avhenger av kontrollsentrene, WP-H) | – |

## 2. HF1 grunnprogrammet, Fase 0–10 (kap. 6)

| Fase | Bygget | Gjenstår å bygge | Verifisering (Tobias/host) |
|---|---|---|---|
| 0 Etablering | ja | CLAUDE.md «Fase 0»-linjen merket utdatert (gjort); v4.0 aldri formelt adoptert (ADR-001) | Branch protection (`BLOCKED_EXTERNAL`) |
| 1 Sikkerhetsfundament | ja | – | Signert klasse D-godkjenning fra ekte enhet; kill switch på NAS |
| 2 Identitet og data | ja (063–084) | – | 078–084 bekreftet anvendt og api/worker startet |
| 3 Core/tekst-MVP | ja | – | Langfuse-trace mot `cost_events` (D-27); Gemma-først-ruting målt |
| 4 Hybridminne | delvis | `ErasureService`/`ContextEngine`/`MemoryExporter` kobles (JARVIS-060), `contextFor` flere rom (077), memory_items-unikhet (Q-45d) | pgvector/HNSW på NAS (D-28) |
| 5 Voice | delvis | AEC/NS er hooks; rå-lyd-dump av som standard | D-30: ≥100 norske prøver, WER, P50/P95 |
| 6 Workers | delvis | Vertsside job-runner + jobbimage (D-32/Q-45a) → WP-C | Ekte branch/PR fra NAS |
| 7 Første integrasjoner | ja | – | Google OAuth/Gmail/Drive/GitHub live fra NAS (D-35) |
| 8 Mobil/Watch | delvis | APNs-kontrakt, Swift-konfig i stedet for hardkodet identitet (Q-46) → WP-G | Xcode, signering, fysisk iPhone/Watch, TestFlight (D-36) |
| 9 Home Assistant | ja | Romkart, state-readback-øvelse | Ekte HA-instans + token |
| 10 Operations | delvis | Planlagt backup + restore-verify + off-site + ekstern heartbeat → WP-C | Off-site-kopi, restore-drill, RTO/RPO |

## 3. HF1 åpne runtime-/produksjonsporter (kap. 7)

| Port | Bygget | Gjenstår å bygge | Verifisering |
|---|---|---|---|
| D-27 Langfuse | `LangfuseTraceSink`, akseptansescript (D-422) | – | Trace-round-trip på NAS mot `cost_events` |
| D-28 pgvector/HNSW | migr. 014/068, eval-skript | – | Kjør `ops/memory/embedding-eval-live.ts` på NAS |
| D-30 Voice-benchmark | `benchmark.ts` | – | ≥100 norske lydprøver |
| D-32 Worker Docker/GitHub | policy, `DockerJobSandboxRunner`, `pr-publisher` | Vertsside runner + jobbimage + egress → WP-C | Ekte branch/PR, ressurs-/nettverksisolasjon |
| D-35 Vault + live | Infisical i compose, `oauth-refresh`, host-skript | GitHub-App-autentisering (Q-45b) → WP-C | Machine identity, rotasjon, Google OAuth live |
| D-36 Apple | skjelett | Swift-konfig, APNs-kontrakt → WP-G | Mac/Xcode/enhet |
| HA-RUNTIME | HA-transport | – | Fysisk HA |
| OPS-RUNTIME | backup/restore-skript, watchdog | Planlagt drift + ekstern overvåking → WP-C | Off-site, drill, uptime |
| UA0-AUTHORITY | `authority.ts`, klasse D-pipeline | Fullfør D-kjede for finans/Zapier/Outlook bak step-up → WP-F | Pause/revoke/preflight/recovery i NAS-runtime |
| UA0-PRIVACY | `PROCESSING_INVENTORY.md` + CI-vakt (D-420) | – | DPIA godkjent av eier |
| UA0-RUNRATE | run-rate-rapport + maintenance ledger (D-421) | Value-loop-bruksmetrikk → WP-C | Se tallene i dashbordet på NAS |

## 4. HF1 UA-0 … UA-11 (kap. 8) – hva som gjenstår å bygge

| UA | Gjenstår å bygge (kode) | Gjenstår å verifisere |
|---|---|---|
| UA-0 | Job-runner, backup-drift/uptime, Value Center-metrikk, V2/V3/V4/V5-løkker | D-gatene over |
| UA-1 AI Mesh | Standard med flere kandidater (033), kimi/hermes-verktøy (036), råd-bekreftelse (078) | ≥3 live providers med fallback og kost-synlighet |
| UA-2 Knowledge | Flere kilder i produksjon, `KnowledgeRetriever` i chat, Docs/Sheets/Slides, møtetranskripter, entitetsgraf, Q-26 (truth promotion), Pieces (ingen kjent API) | Fem kilder i samme retrieval, cross-tenant=0 |
| UA-3 Business OS | Business-tenant-provisjonering (044, topologi: Q-48), lead/opportunity-oppdatering, churn/product usage | Kjøring mot ekte kundedata |
| UA-4 Growth | Skriveaksjoner (idempotent, før/etter) mot Ads, GA4/Search Console/GBP/LinkedIn/YouTube/TikTok, eksperiment/kreativ-intelligens | Google Ads developer token, Meta-verifisering |
| UA-5 Dev/Cloud | Cloudflare, Langfuse/Infisical/Postgres som mål, incident-produsenter, GitHub App | Live GitHub/Vercel/GCP/Cloudflare |
| UA-6 Finance | D-kjede for betaling/refund/capture bak step-up, Wallester-/banking-webhooks, avstemming | Live Vipps/Neonomics/Wallester, BankID/KYC |
| UA-7 Comms | Contacts, Teams, Messenger/Instagram, møtetranskripsjon-pipeline, utgående AI-ringing (regler), push-oppfølging | Identitet mot ekte data |
| UA-8 Personal | Lokalagenter (Mac/Windows), Apple Calendar/Reminders/Contacts/Health-inntak, bil (provider-nøytral), familie/delte rom, personlig økonomi-lesing | Fysisk iPhone/Watch/bil |
| UA-9 Vision | Kamera-produsenter (HA/iPhone), objekt-/hendelses-embeddings, inventar | Fysiske kameraer |
| UA-10 Situation | Sanntids-abonnement, helse/hjem/vision-bro, modellassistert klassifisering, simulering/feedback | ACT/ACT+NOTIFY observert på NAS |
| UA-11 Executive | Ti kontrollsentre (kap. 21), provider-/agent-dekning i ett panel (087) | «Ett panel»-bevis på NAS |

## 5. Value Track (kap. 9)

| Løkke | Status | Gjenstår |
|---|---|---|
| V1 Daily Executive Brief | `WIRED` (Daily Brief, `DailyScheduler`) | Bruksmetrikk; observere daglig bruk |
| V2 Unified Follow-up | `BUILT_UNWIRED` (conversation-graph, pull) | Push-levering → WP-C |
| V3 Builder Loop | `NOT_BUILT` (selvmodifikasjon frosset, D-397) | Sovende løkke bak D-32 og EV-0 → WP-B/C |
| V4 Business Operating Loop | delvis | Business-tenant (Q-48) → WP-E |
| V5 Autonomous Operations | `NOT_BUILT` | Bak bekreftelse/step-up → WP-C/F |

## 6. Definition of Done, kap. 28 (15 punkter)

Per audit 2026-10-05: DONE_IN_CODE 2 (Situation Engine, Executive Mode), PARTIAL 13. Etter D-420…D-449 er punkt 14 (run-rate/maintenance) bygget i kode. Alle 15 forblir uverifisert på NAS til verifiseringsøkten. Oppdateres i takt med byggingen.

## 7. Åpne Q ↔ disposisjon (D-450)

| Q | Disposisjon |
|---|---|
| Q-53 | **A** (ja): håndhev D-431 minne-only-unntaket → `CODE_FIXED` i WP-A (D-451) |
| Q-52 | **A** (ja): utvid mønstre; tvetydige ord kun målt → `CODE_FIXED` i WP-A (D-451); nattlig resensitize-sveip (`report`) rydder gamle minnerader |
| Q-51 | **D** (ja): hold sensitive meldinger (+ par + hale) utenfor skybundet tur → `CODE_FIXED` i WP-A (D-451) |
| Q-50 B | **ja**: repo-lås med eier-opt-out → `CODE_FIXED` i WP-A (D-451) |
| Q-48 | **C nå**; A/B avgjøres med tenant-topologien (JARVIS-044) |
| Q-47 (a) | akseptert: D-klasse utilgjengelig for modellen til kjeden er komplett (WP-F bygger kjeden bak step-up) |
| Q-47 (c)(e), Q-45 (b), Q-43, Q-23 | **eier-handling** (env, nøkkelrotasjon, GitHub App, HF6-fil, testkonto) |
| Q-28 B, Q-42, Q-13, Q-22 | **eier-valg** (leverandør/stack) – et generelt ja velger ikke leverandør (CLAUDE.md regel 12) |
| Q-03/04/06/09/10/11/12/19 | **måling** (verifiseringsøkten) |

## 8. Samlet liste: dette må Tobias gjøre (fysisk/valg) for å lukke

1. Signere Safety Constitution offline, feste fingeravtrykk i NAS-`.env`; vurdere budsjettlåser; øve break-glass.
2. Godkjenne SLO-målene.
3. Rotere Infisical-nøklene som ble limt i chat (Q-47e); sette `JARVIS_DESTINATION_HOST_ALLOWLIST` (Q-47c); sette eier-env før redeploy (Q-45e).
4. Levere/bekrefte: GitHub-token og evt. GitHub App (Q-45b), Google Ads developer token, Meta-verifisering, Cloudflare-token, Apple Developer/Mac (D-36), HA-instans + token, bil-provider (Q-13), e-sign-leverandør (Q-28 B).
5. Fysiske kjøringer: ≥100 norske lydprøver (D-30), off-site backup + restore-drill, uptime-overvåking, Xcode/iPhone/Watch.
6. HF6-filen (Q-43) og HF2-PDF-en i `docs/input/` hvis planens egne akseptansekriterier skal måles.
7. Kjøre akseptansegaten (`ops/acceptance/nas-ua0-gate.sh`) og verifiseringspakken (WP-J) sammen med meg.

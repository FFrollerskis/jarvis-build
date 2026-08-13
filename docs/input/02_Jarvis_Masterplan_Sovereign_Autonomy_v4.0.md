# Jarvis Masterplan — Sovereign Autonomy v4.0

> **Canonical source of truth** for retning, arkitektur, autonomimodell og implementeringsrekkefolge
> for Jarvis v4.0 (erstatter/overstyrer masterplan v2.1 der de er i konflikt - v2.1 beholdes som historikk).
>
> Konvertert automatisk fra `HF1_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.pdf` (tekstuttrekk,
> sidemarkorer beholdt). PDF-en er originalkilden ved tvil om formatering.



---

<!-- side 1 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
JARVIS
MASTERPLAN - SOVEREIGN AUTONOMY
Fra AI-assistent til personlig og bedriftsdekkende AI-operativsystem med maksimal 
handleevne
Felt Verdi
Versjon 4.0 - endelig autonomi- og gjennomføringsversjon
Dato 13. august 2026
Status Styrende masterplan etter v3.2 + execution/value review
Eier Tobias / Jarvis-programmet
Klassifisering Privat - intern arkitektur- og byggeplan
North Star
Jarvis skal være ett operativt kontrollag over hele den digitale og fysiske flaten eieren kobler til. Når en 
capability er tilgjengelig gjennom lovlig/legitim tilgang, skal Jarvis som standard kunne lese, forstå, planlegge 
og handle autonomt - uten unødvendige godkjenningssteg. Sikkerhetsarkitekturen skal primært gi 
observability, skadebegrensning, rollback, recovery og owner override; den skal ikke gjøre Jarvis kunstig 
passiv.
Kjerneprinsipp: Maximum capability. Minimum friction. Full observability. Fast 
recovery.

---

<!-- side 2 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
V4.0. Kontrollendring fra v3.2
V4.0 endrer ikke kjernen i Jarvis-arkitekturen. Den endrer autonomimodellen og gjennomføringsmodellen. De 
tekniske fundamentene fra v3.2 beholdes, men approval-gating er ikke lenger standard for eierens egen Jarvis-
tenant.
Endring Bindende konsekvens
Sovereign Autonomy er standard Eierkoblet tilgang innebærer som utgangspunkt autorisasjon til 
autonom lesing og handling. Jarvis skal ikke stoppe ved A/B/C/D 
bare fordi risikoklassen er høy.
A-D blir risikoklasser, ikke tillatelsesklasser Klassene bestemmer preflight, logging, snapshot, rollback, 
varsling og recovery - ikke automatisk menneskelig godkjenning.
Human sovereignty redefineres Menneskelig kontroll betyr stop/revoke/override og innsyn i 
etterkant, ikke at eieren må godkjenne hver kritiske handling.
Finance Gateway endres Gatewayen skal sikre integritet, idempotency, reconciliation, 
provenance og optional owner guardrails. Ingen hard intern 
beløpsgrense er påkrevd i Sovereign Mode.
Value Track bygges parallelt Daily Executive Brief, Unified Follow-up og Jarvis Builder Loop 
skal landes tidlig mens UA-0 lukkes.
Connector-gjeld styres eksplisitt Ingen connector bygges bare fordi den er mulig. Den må støtte en 
aktiv verdiløkke eller kritisk kontrollflate; maintenance-budget 
måles.
Run-rate fra dag én AI/API, voice, cloud, storage og connector maintenance føres som 
driftsposter fra første live-dag.
Eksterne krav respekteres BankID/KYC, plattform-review, samtykke, eksterne 
brukerrettigheter og lovkrav kan fortsatt kreve handling fra 
menneske eller tredjepart. Det er eksterne constraints, ikke 
Jarvis-interne kunstige sperrer.
Styringsregel
En intern sikkerhetsmekanisme er god bare hvis den reduserer skade eller forbedrer recovery uten å ødelegge 
Jarvis sin handleevne. Standardvalget er autonom utførelse; friksjon må begrunnes konkret.

---

<!-- side 3 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
0. Innhold
1. Formål, scope og Definition of Done
2. Nåstatus etter Fase 0-10
3. North Star og produktprinsipper
4. Målarkitektur
5. Sovereign Autonomy, tilgang og kontroll
6. Grunnprogrammet Fase 0-10
7. Åpne runtime- og produksjonsporter
8. Universal Access UA-0 til UA-11
9. Value Track og Minimum Lovable Jarvis
10. Connector Factory og maintenance model
11. Universal AI Mesh
12. Universal Knowledge og Memory Graph
13. Business Operating System
14. Growth & Marketing Control Plane
15. Developer, Cloud & Infrastructure Control Plane
16. Finance & Spend Integrity Gateway
17. Communications Hub
18. Personal Digital Twin, Home, Health & Mobility
19. Vision & Physical World
20. Proactive Situation Engine & Executive Mode
21. Admin Control Center, Observability & SOC
22. Testing, evals, privacy, recovery & production evidence
23. Hardware, deployment & driftsmodell
24. Implementeringsrekkefølge, 90-dagers plan, tid og kost
25. Integrasjonskatalog
26. Credentials og eksterne forutsetninger
27. Plattformbegrensninger
28. Definition of Done - Universal Access
Appendiks A - Prioritert backlog
Appendiks B - Connector acceptance R/A
Appendiks C - Owner autonomy configuration
Appendiks D - Compliance/data gates
Appendiks E - Scoret risikoregister

---

<!-- side 4 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
1. Formål, scope og Definition of Done
Denne masterplanen er det styrende målbildet for Jarvis etter at grunnarkitekturen er bygget. Den beskriver både 
det som allerede er implementert, det som skal produksjonsverifiseres, og den langsiktige Universal Access-
utbyggingen.
 Én Jarvis-identitet: samme assistent, minne, oppgaver, kontekst og kontrollflate på web, mobil, Watch, voice, 
desktop og fremtidige satellitter.
 Alle relevante AI-er: Jarvis velger og delegerer mellom cloud- og lokale modeller uten at brukeren må bytte 
app.
 Hele bedriften: CRM, kunder, salg, økonomi, markedsføring, annonser, support, kode, cloud, nettsider, drift og 
dokumenter kobles til samme operativsystem.
 Hele privatlivet - segmentert for datakvalitet og eierrettigheter, men tilgjengelig for Jarvis når eieren har koblet 
det inn.
 Handling, ikke bare chat: Jarvis skal som standard utføre handlinger autonomt når capability og legitime 
credentials finnes.
 Proaktivitet: Jarvis skal oppdage problemer, muligheter, frister og unormal aktivitet uten å vente på spørsmål.
 Recovery-first: før/etter-spor, snapshots, reversible handlinger, backups, idempotency og kill switch prioriteres 
foran approval-friksjon.
Definition of Done
Jarvis Universal Access er ferdig når nye tjenester kan kobles inn via standardisert Connector SDK, data kan 
forstås gjennom én sikker kunnskaps-/relasjonsmodell, Jarvis kan handle autonomt på tvers av eierens 
tilkoblede systemer, og systemet tåler feil gjennom audit, recovery, rollback, credential-isolasjon og owner 
override. Eksterne lov- og plattformkrav skal respekteres uten at Jarvis innfører ekstra intern friksjon som 
ikke har en konkret begrunnelse.
2. Nåstatus etter Fase 0-10
Steg Område Status Resultat / rest
Fase 0 Spesifikasjon, GitHub, arkitektur FERDIG Styrende dokumenthierarki og 
beslutningslogg etablert
Fase 1 Sikkerhetsfundament PASS Policy Gateway, approvals, kill 
switch, contracts
Fase 2 Identitet og data PASS Postgres, RLS, session/device, 
audit/events
Fase 3 Core og tekst-MVP PASS* Chat, Model Gateway, tasks, SSE, 
budgets; Langfuse runtime åpen
Fase 4 Hybridminne PASS* Structured memory, FTS/vector, 
provenance; pgvector runtime 
åpen
Fase 5 Voice Gateway PASS* Full duplex prototype, barge-in; 
provider benchmark åpen
Fase 6 Isolerte workers PASS* Durable jobs, coding worker, 
sandbox; Docker/GitHub gate 
åpen

---

<!-- side 5 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
Steg Område Status Resultat / rest
Fase 7 Første integrasjoner PASS* Gmail/Calendar/Drive/GitHub/
Telegram/Vercel 
adaptergrunnlag; live 
OAuth/vault åpen
Fase 8 Mobil, Watch, kontinuitet IMPLEMENTERT* SwiftUI-kode/device auth; fysisk 
Xcode/APNs/Secure Enclave gate 
åpen
Fase 9 Home Assistant PASS* HA Tool Gateway og romrouting; 
fysisk HA runtime åpen
Fase 10 Operations PASS* Watchdog, backup/restore, cost 
controls, runbooks; 
driftsskala/off-site gjenstår
* PASS/implementert betyr at kode og testgrunnlag er godkjent, men eksplisitte runtime-porter kan fortsatt stå åpne. Production 
evidence kan ikke erstattes av statusord.
3. North Star og produktprinsipper
Prinsipp Konsekvens
Jarvis er kontrollaget Ingen ekstern modell skal eie identitet, permanent minne, 
credentials eller system authority.
Maximum capability Når eieren har koblet til en capability, skal Jarvis kunne bruke 
den fullt ut innen tekniske og eksterne rammer.
Minimum friction Intern approval er unntaket. Standard er autonom handling med 
korrekt logging og recovery.
Observability over permission theatre Audit, provenance, alerts og diffs skal gjøre handlinger 
forståelige uten å gjøre eieren til flaskehals.
Recovery over paralysis Snapshot, rollback, idempotency og restore er førstevalg for 
risikoreduksjon.
Adapters over hardkoding Leverandører ligger bak stabile interne kontrakter slik at de kan 
byttes.
Postgres er autoritativ Kritisk state har én logisk autoritet med replikering/backup; 
autoritativ betyr ikke eneste kopi.
Minne er kildebevisst Viktig minne kan spores til kilde, tidspunkt, space og tillitsnivå.
Secrets utenfor modellen Credentials brukes via Tool/Secret Gateway og injiseres aldri som 
rå verdier i model context.
Human sovereignty Eieren kan alltid stoppe, revoke, overstyre og rekonfigurere 
Jarvis. Sovereignty er ultimate control, ikke løpende 
micromanagement.
Value before completeness Arkitekturen skal bygges riktig, men reell daglig verdi må landes 
parallelt.
Evidence over statusord Production readiness bestemmes av målt evidens.

---

<!-- side 6 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
4. Målarkitektur
Lag Ansvar
Experience Layer Webchat, iPhone, Watch, Voice, desktop, notifications, 
dashboards, satellitter
Identity & Continuity Tenant, user, device, session, channel, room/location context, 
owner authority
Jarvis Core / Orchestrator Conversation engine, Fast Router, Context Builder, planning, 
delegation, task state
Universal AI Mesh OpenAI, Claude, Gemini, Kimi, local models, 
coding/research/vision/audio specialists
Memory & Knowledge Graph Events, structured memory, vector/FTS, entities, relationships, 
summaries, provenance
Universal Tool & Connector Layer Connector SDK, Tool Gateway, adapters, webhooks, sync, rate 
limits, idempotency
Autonomy & Integrity Layer Risk classes, execution policy, deterministic preflight, finance 
integrity, recovery hooks, owner override
Durable Workers & Agents Isolated containers, coding/research jobs, resumability, artifacts, 
long-running autonomy
Situation Engine Event correlation, proactive triggers, anomaly detection, 
autonomous actions
Operations, Privacy & Security Infisical, audit, tracing, backups, monitoring, privacy/data rules, 
cost controls, runbooks
Arkitekturregel
Ingen provider, connector eller agent får en snarvei rundt identity, audit, secret boundary eller recovery 
hooks. Disse mekanismene skal følge handlingen - ikke blokkere handlingen uten en konkret grunn.

---

<!-- side 7 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
5. Sovereign Autonomy, tilgang og kontroll
Sovereign Mode er standard for Tobias sin eier-tenant. Å koble en konto, enhet eller tjeneste til Jarvis betyr som 
utgangspunkt at Jarvis kan lese og handle gjennom den. Risk classification beholdes for å bestemme hvor mye 
verifikasjon og recovery en handling får.
Space Eksempler Sovereign-regel
personal Kalender, filer, kontakter, reise, preferanser Full eierautonomi; data behandles 
kildebevisst og etter retention-policy
business Kunder, salg, økonomi, markedsføring, drift Full owner-authority der eieren faktisk har 
virksomhetsrettighetene; tenant-audit 
beholdes
project Kode, roadmap, dokumenter, beslutninger Full autonomi innen repo/project authority
health Apple Health, søvn, trening, user-imported 
health
Tilgjengelig for Jarvis når koblet; strengere 
dataminimering/provenance, ikke 
nødvendigvis approval
home Home Assistant, sensorer, klima, låser, alarm, 
kamera
Autonomt med fysisk preflight, state check og 
immediate audit/notification for kritiske 
endringer
family/shared Delte ressurser Kun rettigheter eieren faktisk har i det delte 
systemet; ingen overstyring av andre 
personers tilgang
guest/external Midlertidige brukere/andre eiere Eksplisitt delegert authority. Her kan 
approval eller scoped mandate være 
nødvendig fordi authority ikke tilhører 
Tobias alene.
5.1 A-D er risikoklasser - ikke stoppskilt
Klasse Eksempler Sovereign execution treatment
A - Read/observe Søk, status, datahenting Utfør direkte. Normal audit.
B - Low-risk reversible Lys, metadata, oppgaver, interne updates Utfør direkte. Reversibility metadata og 
normal audit.
C - Material/reversible PR, møtebooking, kampanjeendring, deploy 
rollback
Utfør autonomt. Deterministisk preflight, 
before/after diff, rollback-plan, enhanced 
audit.
D - Critical Penger, DNS/IAM/WAF/secrets, lås/alarm, 
publisering, destruktive endringer
Utfør autonomt i Sovereign Mode når 
capability er legitimt tilgjengelig. Krev state 
re-read, deterministic validation, 
snapshot/checkpoint når mulig, idempotency, 
immediate notification og recovery path. 
Human approval er bare påkrevd hvis eieren 
selv konfigurerer det eller ekstern 
tjeneste/lov krever det.
5.2 Execution Authority Engine
 Sovereign owner grant: eierens tilkoblede accounts/capabilities kan ha varig autonomous authority uten 
interne beløps- eller handlingstak.
 Scoped delegation: brukes for andre brukere, andre selskapseiere, midlertidige agents eller tredjepartsspaces.

---

<!-- side 8 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
 Capability proof: før handling verifiseres aktiv credential, rett konto/tenant, target resource og aktuell state.
 Preflight: D-handlinger kjører deterministic sanity checks; LLM alene avgjør ikke parameter validity.
 Recovery hook: snapshot, backup, rollback, compensating action eller recovery runbook knyttes til handlingen 
når provider støtter det.
 Owner override: global pause, per-connector freeze, credential revoke, agent stop og force-degraded mode er 
alltid tilgjengelig.
 Optional guardrails: beløpsgrenser, vendor allowlists og human approval kan konfigureres av eier, men er ikke 
default i Sovereign Mode.
Regel for credentials og penger
Jarvis kan bruke betalings- og driftscredentials gjennom dedikerte gateways, men rå bank-, kort- eller vault-
hemmeligheter legges ikke i model prompt. Finance-integritet skal hindre tekniske feil som dobbeltbetaling og 
feil target; den skal ikke automatisk stoppe en legitim owner-authorized handling bare fordi beløpet er stort.
6. Grunnprogrammet Fase 0-10
Fase Leveranse
0 - Etablering Canonical spec, architecture, decisions, private repo, hardware-
retning
1 - Security foundation Policy Gateway, signed approvals (beholdes som valgfri 
mekanisme), replay-beskyttelse, kill switch, contracts
2 - Identity & data Postgres/RLS, tenant/session, append-only event/audit, 
device/identity primitives
3 - Core & text MVP API/webchat, streaming, router, Context Builder, Model Gateway, 
budgets, tracing, tasks
4 - Hybrid memory Structured memory, FTS/vector, relations, summaries, 
bitemporality, provenance
5 - Voice Gateway Full-duplex, STT/TTS adapters, VAD, AEC/NS hooks, barge-in, 
continuity
6 - Workers Durable leases/checkpoints/retry/cancel, isolated workspace, 
coding workflow
7 - First integrations Gmail, Calendar, Drive, GitHub, Telegram, Vercel adapters; 
Infisical selected
8 - Mobile & Watch Device registration, challenge auth, SwiftUI iPhone/Watch, APNs 
contract
9 - Home Assistant HA device bus, room/site routing, light/climate/lock/alarm 
capability
10 - Operations Watchdog, backup/restore, cost explosion protection, runbooks, 
recovery tests

---

<!-- side 9 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
7. Åpne runtime- og produksjonsporter
Port Område Må bevises Status
D-27 Langfuse runtime Real traces: 
session/task/provider/model/latency
/token/cost kryssjekket mot cost 
events
ÅPEN
D-28 pgvector/HNSW Real vector migration + 
eval/RLS/bitemporal/performance
ÅPEN
D-30 Voice benchmark Minst 100 representative norske 
prøver; WER, latency, P50/P95, 
barge-in
ÅPEN
D-32 Worker Docker/GitHub Disposable container, 
resource/network isolation, real 
branch/PR flow
ÅPEN
D-35 Vault + live integrations Infisical, machine identity, 
rotation/revocation, Google OAuth, 
core connectors live
ÅPEN
D-36 Apple runtime Xcode/signing, physical 
iPhone/Watch, APNs, locked-phone 
continuity, TestFlight
ÅPEN
HA-RUNTIME Home Assistant physical Physical routing, lock/alarm state 
verification, offline/fallback, 
recovery drill
ÅPEN
OPS-RUNTIME Driftsskala Off-site encrypted backup, restore 
drill, uptime monitoring, measured 
RTO/RPO
ÅPEN
UA0-AUTHORITY Sovereign authority runtime Owner authority resolution, D 
preflight, snapshot/recovery hooks, 
audit, pause/revoke tested
NY - ÅPEN
UA0-PRIVACY Privacy baseline Processing inventory, retention 
principles, DPIA trigger matrix
ÅPEN
UA0-RUNRATE Cost/maintenance baseline AI/API/cloud/voice/storage run-rate 
and connector maintenance time 
visible
NY - ÅPEN
Gate policy
Åpne porter betyr at funksjonen ikke er produksjonsverifisert, men de skal ikke brukes som en generell grunn 
til å holde Jarvis passiv. Live capabilities kan tas i bruk gradvis når deres egen credential-, state-, audit- og 
recovery-path er bevist. Eksterne og irreversible handlinger får høyere preflight, ikke automatisk human 
approval.

---

<!-- side 10 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
8. Universal Access-programmet UA-0 til UA-11
UA-fasene er produktutvidelser oppå den eksisterende arkitekturen. Execution og Value Track kan overlappe 
fasene når en connector allerede er trygg nok til reell bruk.
UA-0 - Production Foundation & Sovereign Runtime
NESTE - ÅPEN | 6-8 effort-uker
Mål: Gjør grunnplattformen fysisk og produksjonsverifisert samtidig som Jarvis begynner å levere daglig verdi.
Bygges
 Docker/UGREEN runtime, network zones, Infisical machine identities, Langfuse, pgvector/HNSW.
 Real isolated workers + GitHub PR flow; Google OAuth + core live integrations.
 Execution Authority Engine: owner authority, D preflight, snapshots/recovery, optional approvals but no 
default owner gating.
 Privacy baseline, run-rate dashboard og connector maintenance ledger.
 Physical Apple runtime, Home Assistant, voice benchmark, off-site backup, monitoring.
 Google Ads developer access og Meta Business/App verification startes tidlig.
 Value Track starter parallelt: Daily Brief, Unified Follow-up og Jarvis Builder Loop.
Acceptance criteria
 Core runtime gates lukket med evidens eller eksplisitt dokumentert partial-production status.
 Ingen raw secrets i repo/log/model context.
 Kill switch, pause/revoke, recovery, backup/restore og D preflight testet i ekte runtime.
 Minst én value loop brukes i praksis hver dag før UA-0 regnes som operativt vellykket.
 Run-rate og maintenance time er synlig.
UA-1 - Universal AI Mesh
PLANLAGT | 4-6 uker
Mål: Gjør Jarvis modellagnostisk og i stand til å bruke flere AI-er uten å miste context eller kontroll.
Bygges
 Provider Registry: OpenAI, Claude, Gemini, Kimi, Ollama/local P0; andre senere.
 Coding/research/vision/image/video/STT/TTS specialist adapters.
 Dynamic routing etter capability, privacy, quality, latency, cost og availability.
 Single-provider default for effektivitet; parallel critic/consensus brukes når forventet verdi forsvarer 
kostnaden.
 Provider health, fallback, circuit breakers og per-task cost attribution.
Acceptance criteria
 Minst tre providers kan utføre samme task family; fallback beholder context.
 Kostnad per provider/model/task og parallel overhead er synlig.
 Ingen provider eier permanent Jarvis Memory eller raw secrets.
UA-2 - Universal Knowledge Layer
PLANLAGT | 5-8 uker
Mål: Gjør relevant kunnskap søkbar gjennom ett Jarvis-grensesnitt med provenance og freshness.
Bygges
 Obsidian/Pieces, Drive/Docs/Sheets/Slides, NAS/local files, GitHub, email attachments, meeting transcripts.

---

<!-- side 11 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
 Incremental sync, dedupe, versioning, deletes/tombstones.
 Entity extraction + Knowledge Graph; FTS + vector + graph retrieval.
 Live references for system-of-record data; permanent memory only when durable value exists.
Acceptance criteria
 Minst fem source systems i samme retrieval flow.
 All retrieved knowledge har source pointer/freshness/trust.
 Cross-tenant leakage = 0; delete/revoke propagated.
 DPIA/processing inventory updated for new data categories.
UA-3 - Business Operating System
PLANLAGT | 6-10 uker
Mål: Bygg en samlet operativ modell av bedriften og fremtidige tenants.
Bygges
 Business Graph: person, company, lead, conversation, meeting, offer, contract, invoice, revenue.
 CRM/pipeline, customer lifecycle, communication linking, product usage, churn, support, tasks, vendors.
 Daily/weekly business brief og open-loop detection.
 Identity/tenant model supports multiple companies without mixing accounts, credentials or financial state.
Acceptance criteria
 "Hva skjer med kunde X?" gir complete source-backed timeline.
 "Hvordan går bedriften?" kombinerer sales, product, finance, marketing, operations.
 Open loops detected automatically.
 Profiling/scoring used with documented legal/human controls where required.
UA-4 - Growth & Marketing Control Plane
PLANLAGT | 5-8 uker
Mål: La Jarvis analysere og autonomt optimalisere growth fra spend til revenue.
Bygges
 Google Ads, Meta Ads, GA4, Search Console, GBP, LinkedIn/YouTube/TikTok where relevant.
 Attribution: spend -> click -> lead -> meeting -> customer -> revenue.
 Experiment registry, anomaly detection, creative intelligence og marketing memory.
 Jarvis kan endre budgets, bids, campaigns, keywords og creatives autonomt når platform permission finnes.
 Finance Integrity Gateway brukes for audit/reconciliation, ikke som obligatorisk spend cap.
Acceptance criteria
 CAC/ROAS knyttes til real CRM/revenue.
 Tracking/campaign anomalies detected and actionable.
 Write actions are idempotent, auditable and have before/after state.
 Consent/cookie/data-processing requirements are documented for production tracking.
UA-5 - Developer & Cloud Control Plane
PLANLAGT | 5-8 uker
Mål: Gi Jarvis operativ kontroll over software, deploy og cloud.
Bygges
 GitHub, Vercel, Google Cloud, Cloudflare, Docker/UGREEN, Postgres, Infisical, Langfuse, Sentry/uptime.
 Incident correlation -> diagnostic worker -> fix -> tests -> PR/deploy/rollback depending authority.

---

<!-- side 12 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
 DNS/IAM/WAF/secrets actions are D-class: autonomous in Sovereign Mode with target re-read, backup/snapshot 
where possible, deterministic preflight and immediate notification.
 No direct model access to root credentials; tools mediate execution.
Acceptance criteria
 Production incident can be traced to deploy/log/DB state.
 Jarvis can produce and apply a tested fix according to owner authority.
 Critical infra actions produce full before/after audit and tested recovery path.
 Infrastructure pause/degraded mode works.
UA-6 - Finance & Spend Integrity Gateway
PLANLAGT | 5-9 uker
Mål: Gi Jarvis reell økonomisk handleevne med transaksjonsintegritet og sporbarhet - ikke kunstige interne 
beløpsgrenser.
Bygges
 Canonical Payment/Spend Intent, idempotency, provider refs, reconciliation and anomaly detection.
 Fiken primary accounting connector; bank-read/payment only through official/legal providers.
 Stripe and Vipps merchant flows; Ads/cloud/API spend sync; subscriptions/procurement.
 Programmatic company card/wallet can be added if provider/KYC allows.
 Owner may enable budgets/caps/allowlists as optional policies, but Sovereign Mode supports no internal cap.
Acceptance criteria
 Retry cannot double-pay.
 Every money action maps intent -> provider request -> outcome -> accounting/reconciliation.
 Wrong account/vendor/amount-format and duplicate intents are deterministically caught.
 External BankID/KYC/PSD2 controls are respected; no bypassing regulated requirements.
 Finance kill switch stops new transactions immediately if owner invokes it.
UA-7 - Communications Hub
PLANLAGT | 5-8 uker
Mål: Samle communication per person/project/customer and make follow-up executable.
Bygges
 Gmail, Calendar, Contacts, SIP/voice, Telegram, Slack, Teams, WhatsApp Business, Messenger/Instagram 
Business, Discord, SMS where supported.
 Meeting transcription and Conversation Graph.
 Identity resolution with confidence + reversible split/merge; quality matures with real data.
 Jarvis can draft and send autonomously in owner-authorized channels; high-impact outbound gets enhanced 
audit, not mandatory approval.
 Outbound AI calling obeys marketing/reservation/disclosure/platform rules.
Acceptance criteria
 Open commitments and next actions visible across channels.
 Untrusted messages cannot directly exfiltrate unrelated private data or raw secrets.
 Identity merges are reversible and confidence-tracked.
 Transcription/call processing has documented retention and legal basis where required.
UA-8 - Personal Digital Twin
PLANLAGT | 5-8 uker

---

<!-- side 13 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
Mål: Koble Jarvis til personlig kontekst, devices, home, health and mobility.
Bygges
 iPhone/Watch production apps, Mac/Windows local agents, Apple Calendar/Reminders/Contacts where 
available.
 Location/geofencing, travel, personal finance read, Apple Health, Home Assistant expansion, car APIs, 
family/shared spaces.
 Context engine: place, time, device, meeting, activity.
 Critical home/car actions can execute autonomously with current-state readback, target validation and post-
action confirmation.
Acceptance criteria
 Session continuity across web/phone/Watch/voice.
 Health/location data follows configured data-routing and retention rules.
 Home/car critical actions verify actual resulting state and surface failures immediately.
 DPIA/processing inventory updated where required.
UA-9 - Vision & Physical World
PLANLAGT | 4-7 uker
Mål: Gi Jarvis visuell forståelse av objects, rooms and events.
Bygges
 iPhone camera on demand, HA camera events, doorbell/security events.
 Object/event embeddings, temporal memory, room association, inventory recognition.
 Event snapshots by default instead of continuous raw video.
 Biometric face identification remains outside this masterplan unless separately decided and lawfully 
implemented.
Acceptance criteria
 Object identification and "last seen" workflows work when event data exists.
 Retention/delete rules enforced.
 Sensitive camera streams are routed according to data policy.
UA-10 - Proactive Situation Engine
PLANLAGT | 5-8 uker
Mål: Gjør Jarvis proaktiv and action-oriented across events.
Bygges
 Unified event subscriptions; rules + model-assisted classification.
 State machine: IGNORE -> REMEMBER -> INFORM -> SUGGEST -> ACT -> ACT+NOTIFY -> ESCALATE.
 Priority/confidence/suppression/dedupe/quiet hours.
 Anomaly detection for spend, pipeline, infra, deadlines, home/health.
 Counterfactual/simulation for material actions where useful; feedback learning.
Acceptance criteria
 No duplicate spam for same event.
 ACT uses valid owner/delegated authority and logs reason/evidence.
 D-class actions create immediate post-action notification and recovery context.
 Owner can pause a domain or entire Situation Engine instantly.

---

<!-- side 14 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
UA-11 - Executive Mode
PLANLAGT | 4-6 uker
Mål: Gjør Jarvis til det operative oversikts- og beslutningslaget for bedrift and private life.
Bygges
 Executive dashboard, daily brief, attention ranking.
 Business health: cash, revenue, pipeline, churn, marketing, operations.
 Personal: schedule, travel, home, key tasks, health signals.
 Decision log, scenarios, risk register, goals/OKRs, delegation board.
 One-tap pause/override/revoke instead of approval-centric UI.
Acceptance criteria
 Top priorities are source-backed and actionable.
 Jarvis explains why something was prioritized or executed.
 Owner can stop/revoke/reconfigure any connector, provider, agent or autonomy domain from one control 
surface.

---

<!-- side 15 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
9. Value Track og Minimum Lovable Jarvis
Architecture Track og Value Track kjører samtidig. UA-faser må ikke bli en katedral som utsetter daglig verdi. 
Jarvis skal brukes mens den bygges.
Verdiløkke Første leveranse Målbar verdi
V1 - Daily Executive Brief Gmail + Calendar + tasks + GitHub/project 
status
Hver morgen: hva trenger 
oppmerksomhet, hva venter på meg, hva 
har endret seg, hva er neste beste 
handling.
V2 - Unified Follow-up Email + meetings + contacts + task 
extraction
Jarvis finner ubesvarte tråder, løfter, 
follow-ups og møteforberedelser og 
utfører/forbereder neste steg.
V3 - Jarvis Builder Loop GitHub + tests + runtime status + agents Jarvis følger sitt eget prosjekt, finner 
feil/gates, delegerer coding work og holder 
status kontinuerlig oppdatert.
V4 - Business Operating Loop CRM + communications + marketing + 
finance read
Daglig business health, open loops, 
pipeline, CAC/ROAS, customer risks.
V5 - Autonomous Operations Write-capable connectors across 
business/cloud/finance/home
Jarvis utfører endringer og dokumenterer 
before/after/recovery uten at eieren må 
være operatør.
Verdiregel
P0 for arkitekturen og P0 for daglig verdi er to forskjellige prioritetslister. Minst én value loop skal være live og 
nyttig mens UA-0 pågår.
10. Connector Factory og maintenance model
Målet er ikke å ha 100 live integrasjoner for tallets skyld. Målet er at kjernen kan støtte 50-100+ uten redesig, mens 
bare connectors med aktiv verdi holdes live.
 Første 3-5 connectors bygges manuelt etter samme contract-standard. Factory abstraheres etter at mønsteret er 
bevist.
 Connector must have owner, capability manifest, auth strategy, trust class, idempotency, recovery semantics, 
health check, audit and runbook.
 Connector debt is measured: auth failures, API changes, maintenance hours, incident count, sync lag and 
deprecation risk.
 No connector because "it might be useful". It must support an active Value Loop, a control plane or a concrete 
roadmap dependency.
 Read-only connectors can use Acceptance Level R; write/action connectors use Level A.
 Credential health dashboard shows expiry, scope drift, auth failures and provider deprecation.
Manifest-felt Krav
identity name, vendor, version, owner, environment
auth OAuth/API key/service account/mTLS/device token, scopes, rotation
capabilities read/write/actions/webhooks/sync/search
authority owner/delegated authority, tenant, risk class, optional approval policy

---

<!-- side 16 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
Manifest-felt Krav
reversibility rollback method, compensating action, destructive flag, snapshot 
support
idempotency dedupe key, retry semantics, exactly-once target
limits provider rate limits/quotas; owner caps optional
trust trusted/untrusted output, injection exposure, sanitization
data schemas, provenance, freshness, retention, delete semantics
operations health check, timeout, circuit breaker, metrics, runbook, maintenance 
owner
secrets vault refs only; never values in model context
tests fake adapter, contract tests, live smoke, authority/recovery/security 
tests
11. Universal AI Mesh
Provider Rolle Mode Prioritet
OpenAI Reasoning, coding, multimodal, 
tools
Cloud P0
Anthropic / Claude Reasoning, long context, coding Cloud P0
Claude Code / Codex Repository coding agents Worker/headless P0
Gemini Reasoning, multimodal, Google 
ecosystem
Cloud P0
Kimi Long context / reasoning 
specialist
Cloud P1
Ollama/local Private/offline/local workloads Local P0
Grok Optional specialist/research Cloud P2
Mistral Provider diversity / EU optional Cloud/local P2
DeepSeek Cost/specialist optional Cloud/local P2
Perplexity/research Web/research specialist Cloud P2
Image/video models Generation/edit/analysis Cloud/local P1/P2
STT/TTS providers Norwegian voice Cloud/local P0
11.1 Router-policy
 Capability first: coding, vision, speech, long-context and realtime route only to capable models.
 Privacy/data-routing is a policy input, not a blanket ban. Owner can authorize cloud processing per space.
 Reliability, cost and latency are scored continuously.
 Single-provider is default for cost/latency. Critic/consensus activates when expected value, risk or explicit 
owner policy justifies it.
 No raw secrets in prompt. Tool calls receive only the minimum credential handle/secret reference needed.
 Provider failure never changes system authority; fallback receives task context, not permanent memory 
ownership.

---

<!-- side 17 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
12. Universal Knowledge og Memory Graph
Lag Innhold
Source layer Drive, Obsidian, Pieces, NAS, GitHub, mail, meetings, images, 
systems
Ingestion Sync/webhooks, parsing, normalization, trust classification, 
quarantine
Structured memory Facts, preferences, decisions, commitments, summaries, tasks
Entity graph People, companies, projects, assets, places, campaigns, accounts, 
devices
Retrieval FTS + pgvector/HNSW + graph expansion + recency + 
authority/data policy
Evidence Source pointer, timestamp, version, confidence, trust, deletion 
state
Kritisk designvalg
Jarvis skal ikke kopiere hele verden inn i permanent minne. System-of-record data kan ligge som live 
references, cached facts eller durable memories. Dette reduserer stale data, storage growth og connector lock-
in samtidig som Jarvis kan bruke informasjonen on demand.
13. Business Operating System
Modul Bygg
Customer 360 Customer, contacts, communication, meetings, product usage, 
support, invoices, sentiment, next action
Sales OS Lead intake, enrichment, scoring, pipeline, follow-up, meeting prep, 
proposals, forecast
Customer Success Onboarding, health, churn, renewal, expansion, SLA
Support Messages/tickets -> root cause -> knowledge -> product issue -> 
customer update
Product/Engineering Roadmap, bugs, usage, GitHub, deploys, customer requests, releases
Operations Tasks, owners, deadlines, suppliers, runbooks, escalations
Contracts & Legal Templates, obligations, renewals, deviations, signatures, owner/legal 
controls where required
HR/Recruiting Applicants, interviews, onboarding, policies, internal knowledge 
when needed
Procurement Request, quote comparison, purchase, delivery, invoice matching
14. Growth, Ads og Marketing Control Plane
 Google Ads, Meta Ads, GA4, Search Console, GBP, YouTube, LinkedIn, TikTok where relevant.

---

<!-- side 18 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
 Creative intelligence links creative -> audience -> landing page -> lead quality -> revenue.
 Marketing memory stores what was tried, why, result, learning and decision.
 Experiment engine tracks hypothesis, variants, duration, guardrails, lift and stop conditions.
 Autonomy: Observe, Recommend and Execute are all available in Sovereign Mode once connector write access 
is live. Risk class only changes preflight/recovery/audit.
 Large spend changes are not internally blocked by default, but Finance Integrity records intent/outcome and 
can alert on anomalies.
15. Developer, Cloud og Infrastructure Control Plane
Domene Tilgang / autonomi
Source control GitHub repos, branches, PRs, Actions, issues, releases, security 
findings; Jarvis can create/merge/deploy per owner authority
Deployment Vercel previews/production, rollback, domains, build logs
Cloud GCP resources, service health, logs, billing, IAM read/write 
through tools
Edge/DNS Cloudflare DNS, WAF, cache, tunnels, SSL; D-class with 
preflight/snapshot where possible
Compute UGREEN services, Docker, future RTX server, local model runners
Data Postgres, pgvector, backups, migrations, capacity, replication
Observability Langfuse, Sentry, metrics, traces, logs, uptime, alerts
Secrets Infisical machine identities, rotation, revocation, audit; raw 
values never enter model context
Autonomous coding rule
Jarvis may analyse issues, create branches, run coding agents, tests, review, merge and deploy according to 
owner authority. Protected branches remain useful as operational controls, but human merge is not a 
permanent architectural requirement in Sovereign Mode.
16. Finance & Spend Integrity Gateway
Finance Gateway protects transaction correctness and traceability. It is not a default internal spending limiter.
Komponent Funksjon
Payment/Spend Intent Canonical idempotent request: amount, currency, purpose, vendor, 
invoice/ref, target account, authority
Account/Vendor Resolver Verifies correct tenant, account, recipient and provider before 
execution
Idempotency & Replay Guard Prevents duplicate payment/refill/order on retry or replay
Preflight Validates currency/amount formats, balance/readback when 
available, destination and current state
Reconciliation Matches intended spend to provider/bank/invoice/accounting 
outcome

---

<!-- side 19 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
Komponent Funksjon
Anomaly Detection Flags duplicate, sudden spend, unusual vendor/time/geography, failed 
refunds - alerts do not necessarily block
Accounting Fiken first; transaction evidence links to accounting records
Emergency Controls Owner-invoked finance kill switch, freeze 
vendor/account/agent/category
Optional Guardrails Owner may enable caps, allowlists or approval thresholds, but 
Sovereign Mode does not require them
17. Communications Hub
Kanal System Jarvis-rolle
Email Gmail first; Outlook/M365 later Read/search/draft/send, attachments, labels, 
threading
Calendar Google first; Apple/M365 where relevant Read/create/update, availability, meeting 
prep
Phone SIP/telephony + Voice Gateway Inbound/outbound, transcript, summary, 
CRM link
Messaging Telegram, Slack, Teams, Discord Read/notify/respond autonomously per 
owner authority
Meta messaging WhatsApp Business, Messenger/Instagram 
Business
Official business flows/permissions only
Meetings Meet/Zoom/Teams transcript adapters Agenda, notes, commitments, follow-up
Identity resolution is confidence-based and reversible. The system supports manual split/merge for incorrect 
profiles, and match quality is treated as a continuous operational metric rather than a one-time sprint deliverable.
18. Personal Digital Twin, Home, Health og Mobility
 iPhone: primary mobile Jarvis, voice, notifications, location, camera-on-demand, owner override and share 
sheet.
 Apple Watch: thin client for quick voice, context, alerts, pause/revoke/override.
 Mac/Windows local agents: files, processes and device integrations where legitimate APIs/permissions allow.
 Home Assistant: lights, climate, sensors, power, locks, alarm, cameras, room context; autonomous control with 
state confirmation.
 Apple Health/fitness: connected when owner authorizes it; retention/data-routing controlled separately.
 Travel: flights, hotels, rentals, tickets, documents, weather, maps, itineraries.
 Vehicle: status, charging, location, climate, trips and controls where specific vehicle/provider exposes legitimate 
APIs.
 Family/shared: Jarvis uses only the permissions actually delegated in shared resources.

---

<!-- side 20 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
19. Vision og fysisk verden
Steg Design
Capture On-demand iPhone camera, HA camera event, doorbell, optional 
workspace camera
Classify Object, text, event, room, safety, inventory - no biometric identity 
in this plan
Minimize Event snapshot/metadata by default instead of continuous raw 
video
Link Attach object/event to place, time, project or asset
Act Notify, create task, update inventory or trigger automation 
autonomously according to owner authority
20. Proactive Situation Engine og Executive Mode
State Atferd
IGNORE No value; retain only according to retention policy
REMEMBER Store relevant fact/event without interrupting
INFORM Notify because awareness matters
SUGGEST Recommend concrete action with expected effect
ACT Execute autonomously within owner/delegated authority
ACT + NOTIFY Execute higher-risk action and immediately surface what 
changed, why and recovery option
ESCALATE External block, ambiguity of authority, impossible recovery or 
legal/platform requirement needs human/third-party 
involvement
 Lead unanswered for three days -> ACT follow-up if channel and identity confidence are sufficient.
 Meta CPA rises 60% and lead quality drops -> change budget/bids/creative based on strategy; record 
before/after and expected effect.
 Production error after deploy -> diagnose, patch, test and rollback/redeploy as necessary.
 Backup failure -> remediate safe infrastructure steps; surface critical alert if recovery cannot be verified.
 Meeting in 20 minutes -> generate brief automatically and surface open commitments.
 Critical D-class actions -> execute with deterministic preflight and post-action notification, not mandatory pre-
approval.

---

<!-- side 21 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
21. Admin Control Center, observability og SOC
Modul Innhold
Integration Center Connector status, auth health, scopes, sync lag, API version, 
deprecations, maintenance owner/time
Authority Center Owner/delegated authority, risk classes, optional approvals/caps, 
pause/revoke, external constraints
AI Center Providers, routing, health, costs, evals, parallel-delegation overhead
Finance Center Intents, spend, anomalies, vendors/accounts, reconciliation, finance 
kill switch
Memory Center Sources, sync, memories, provenance, delete/export, 
conflict/quarantine
Agent Center Workers, jobs, leases, artifacts, retries, cancellations, network scopes
Operations Center Health, incidents, runbooks, backups, restore drills, uptime, capacity
Value Center Daily value loops, usage frequency, tasks closed, time saved, owner 
corrections
Privacy Center Processing inventory, retention, DPIA status, deletion evidence
Security Center Audit, credential events, suspicious injection/exfiltration, recovery 
actions
22. Testing, evals, privacy, recovery og production evidence
Testlag Må bevises
Unit/contract Schemas, transforms, signing, idempotency, connector contracts
DB/RLS Real Postgres, tenant/space isolation, append-only, concurrency
Authority Correct owner/tenant/target, delegated authority, optional policies, 
pause/revoke
Prompt injection Untrusted input cannot directly obtain raw secrets or silently redirect 
high-impact tool targets
Connector live smoke Real account/sandbox, reversible production case where possible, 
before/after evidence
Model evals Accuracy, hallucination, tool choice, cost, latency, regression
Voice evals Norwegian WER, dialects, numbers/names, latency, barge-in
Worker isolation Container/network/filesystem/credentials/cancellation/crash/reclaim
Finance integrity Double-pay prevention, wrong-target tests, reconciliation, replay, kill 
switch
D-class recovery Preflight, state readback, snapshot/backup/compensating action, 
immediate notification
Privacy/compliance Processing inventory, retention/delete, consent/disclosure where 
required
Chaos/recovery DB/service/provider outage, queue recovery, fallback, degraded mode
Backup/DR Encrypted off-site copy, restore fresh environment, measured 
RTO/RPO

---

<!-- side 22 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
Testlag Må bevises
Value evidence Daily usage, completed loops, correction rate, latency and owner-
perceived usefulness
23. Hardware, deployment og driftsmodell
Komponent Rolle
UGREEN NAS / 24/7 base Postgres/data host where chosen, Docker services, 
HA/infrastructure, websites/files/backups. Never the only copy of 
critical data.
Authoritative Postgres One logical authority with tested backup/off-site copy and 
optional replica; UGREEN can host it but does not replace disaster 
recovery.
RTX 4070 PC Development, local GPU work and benchmark while building.
Mac mini / Apple build node Xcode, iOS/watchOS builds, signing, simulator/device tests; 
optional Apple-local agents.
Future RTX 5080-class server Heavy local inference/vision/voice/agents when measured load 
justifies it.
Network Trust zones/VLAN where practical, TLS, no direct public DB, 
firewall/allowlists, VPN/tunnel for admin.
Backup Local snapshots + encrypted off-site + restore drills; secrets 
backup handled separately.
24. Implementeringsrekkefølge, 90-dagers plan, tid og kost
24.1 To parallelle spor
Spor Sekvens Suksessmål
Architecture Track UA-0 -> UA-1/2 -> UA-3/7 -> UA-4/5 -> UA-6 
-> UA-8/9 -> UA-10/11
Production-capable platform with 
evidence, autonomy and recovery
Value Track V1 Daily Brief -> V2 Follow-up -> V3 
Builder -> V4 Business Loop -> V5 
Autonomous Operations
Jarvis becomes useful every week, not 
only after architecture is complete
24.2 Første 90 dager
Periode Architecture Value / live usage Exit evidence
Dag 1-30 UA-0A: runtime, vault, pgvector, 
tracing, live 
Gmail/Calendar/Drive/GitHub/Teleg
ram, authority runtime
V1 Daily Executive Brief live. Start 
V3 Builder Loop. Jarvis used daily.
Core live connectors, audit, 
pause/revoke, first off-site backup, 
run-rate visible.
Dag 31-60 UA-0B physical: Apple, HA, voice 
benchmark, worker isolation, 
recovery drills. Begin UA-1 Mesh.
V2 Unified Follow-up live. Jarvis 
executes low/medium-risk 
communications/tasks.
At least 2 value loops used weekly, 
D preflight/recovery tested, 
voice/HA physical evidence.

---

<!-- side 23 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
Periode Architecture Value / live usage Exit evidence
Dag 61-90 Close remaining UA-0 gates. UA-1 P0 
providers + UA-2 first knowledge 
sources. Start Business Graph 
skeleton.
V3 Builder Loop autonomous 
branch/test/fix workflow; first 
Business Brief. Expand write 
actions where connector is ready.
UA-0 production evidence, 3+ live 
providers, 5 source systems 
searchable, daily value metrics and 
maintenance baseline.
24.3 Effort-estimat
Fase Effort-uker Merknad
UA-0 6-8 Runtime + physical + authority + value 
track overlap
UA-1 4-6 P0 provider mesh
UA-2 5-8 Knowledge sources + graph retrieval
UA-3 6-10 Business Graph/domain logic
UA-4 5-8 Marketing connectors + attribution + write
UA-5 5-8 Cloud control + recovery
UA-6 5-9 Finance integration/reconciliation
UA-7 5-8 Comms + identity resolution
UA-8 5-8 Personal/device ecosystem
UA-9 4-7 Vision/physical
UA-10 5-8 Situation Engine
UA-11 4-6 Executive layer
Total engineering effort remains approximately 59-94 effort-weeks before ongoing maintenance. Calendar time depends on weekly 
hours, parallelism and connector lead times. The plan no longer treats ongoing connector maintenance as free.
24.4 Run-rate og maintenance budget
Kostnadsområde Måles fra dag én Styringsmål
AI/API Tokens, calls, parallel overhead, provider 
subscriptions
Cost per useful task/value loop; routing 
optimization
Voice STT/TTS minutes, realtime sessions Cost per active voice hour and latency quality
Cloud/infra Compute, storage, bandwidth, monitoring Monthly baseline + growth driver
Backups Local/off-site storage and restore time Restore success + cost
Connectors Maintenance hours, auth incidents, API 
migrations
Hours per connector/month; retire low-value 
connectors
Human correction Owner corrections, failed actions, reversals Correction rate should trend down
Maintenance rule
A connector that repeatedly costs more maintenance than the value loop it supports should be simplified, 
replaced or retired. The architecture can support 100+ connectors; operations should not be forced to maintain 
100+ active connectors.

---

<!-- side 24 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
25. Integrasjonskatalog
Startkatalogen er bred. P0/P1/P2 expresses priority, not mandatory simultaneous activation. Write/action access is 
enabled when the connector itself is production-ready and owner authority exists.
AI & Knowledge
System Tilgang Fase Pri
OpenAI / ChatGPT models read/act API UA-1 P0
Anthropic / Claude read/act API UA-1 P0
Claude Code / Codex coding worker UA-1/5 P0
Gemini read/act API UA-1 P0
Kimi read/act API UA-1 P1
Ollama/local local inference UA-1 P0
Grok/Mistral/DeepSeek optional providers UA-1 P2
Perplexity/research research specialist UA-1/2 P2
Obsidian read/write/sync UA-2 P0
Pieces context bridge UA-2 P1
Google Drive/Docs/Sheets/Slides read/write/sync UA-2 P0/P1
UGREEN/NAS files read/write/watch UA-2 P0
Windows/Mac local files read/write agent UA-2/8 P1
Business, Growth & Finance
System Tilgang Fase Pri
Internal CRM / Sales pipeline full internal UA-3 P0
Support/tickets read/write UA-3 P1
Contracts/e-sign read/draft/act where permitted UA-3 P1
Procurement/inventory read/act UA-3/6 P1
Google Ads read/write spend UA-4/6 P0
Meta Ads read/write spend UA-4/6 P0
GA4 / Search Console read/analysis UA-4 P0
Google Business Profile read/write UA-4 P1
LinkedIn/YouTube/TikTok analytics/write where allowed UA-4 P1/P2
Fiken accounting data/actions UA-6 P0
Bank/open banking provider read/payment if officially supported UA-6 P1
Stripe payments/subscriptions UA-6 P1
Vipps MobilePay merchant payments/business data UA-6 P1

---

<!-- side 25 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
System Tilgang Fase Pri
Programmable business card/wallet autonomous spend where 
provider/KYC allows
UA-6 P2
Cloud, Communications & Personal
System Tilgang Fase Pri
GitHub read/branch/PR/merge/actions UA-0/5 P0
Vercel read/deploy/control UA-0/5 P0
Google Cloud read/control UA-5 P0
Cloudflare DNS/WAF/control UA-5 P1
Docker/UGREEN local control UA-0/5 P0
Langfuse/Infisical tracing/secrets runtime UA-0/5 P0
Gmail read/draft/send UA-0/7 P0
Google Calendar read/write UA-0/7 P0
Telegram notify/read/write UA-0/7 P0
Slack/Teams/Discord read/write UA-7 P1/P2
WhatsApp Business / Meta 
messaging
business messaging UA-7 P1/P2
SIP/telephony calls/voice UA-7 P0
iPhone / Apple Watch native clients, context, override UA-0/8 P0
Apple Health / Location personal context UA-8 P1
Home Assistant read/control UA-0/8 P0
Vehicle APIs read/control per provider UA-8 P2
Cameras / iPhone vision events/on-demand vision UA-9 P0/P1
26. Credentials og eksterne forutsetninger
Område Forutsetning Fase
Apple Developer Team, signing, bundle IDs, APNs, 
provisioning, Xcode
UA-0/8
AI providers API projects/keys/billing/limits for chosen 
models
UA-1
Google Workspace OAuth client, redirects, Gmail/Calendar/Drive 
scopes
UA-0/2/7
Google Ads Developer/OAuth/customer access and account 
verification
UA-0/4
Meta Business App, token, permissions, business/ad account 
verification
UA-0/4/7
Google Cloud Service accounts/IAM/billing access UA-5
GitHub GitHub App/PAT minimum scopes + branch 
settings
UA-0/5

---

<!-- side 26 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
Område Forutsetning Fase
Vercel / Cloudflare Scoped tokens/project/team/domain refs UA-0/5
Telegram Bot token/chat config UA-0/7
Home Assistant Base URL + chosen auth token UA-0/8
Infisical Bootstrap/admin, machine identity, 
projects/envs, backup/restore
UA-0
Voice Chosen STT/TTS keys + local candidates UA-0/1
Finance Provider/KYC/account access, payment scopes, 
cards/wallet where applicable
UA-6
Monitoring Sentry/uptime/alert delivery credentials UA-5/10
27. Plattformbegrensninger og hva vi ikke skal late som er mulig
Begrensning Prinsipp
iOS root/full device control Normal app does not get unrestricted root. Use official entitlements, 
App Intents, push, share sheet and local agents.
Private iMessage history Do not build around unofficial full Messages DB extraction. Use user-
mediated/official flows.
Consumer app histories ChatGPT/Claude/Gemini consumer history may not be exposed by 
APIs. Jarvis owns its own memory and API interactions.
Bank/open banking Payment initiation may require regulated TPP/provider/KYC/BankID. 
Use lawful providers; do not bypass bank controls.
Platform-specific APIs WhatsApp, Meta, LinkedIn, vehicle/public-sector APIs have 
scope/review/partner limits that must be checked at implementation.
Browser automation Last resort for legitimate workflows, not a way to bypass platform 
restrictions.
Other people / other companies Jarvis cannot assume authority that the owner does not actually 
possess. Shared/external rights remain governed by those systems 
and owners.
Physical reality A software permission does not guarantee safe mechanical/physical 
outcome. Critical physical actions require state sensing and post-
action verification where feasible.
28. Definition of Done for Jarvis Universal Access
 UA-0 runtime, authority, privacy, cost and recovery gates have real evidence.
 At least one Daily Value Loop is used every day; Value Track metrics show sustained usefulness.
 Connector framework is standard path for new integrations; first 3-5 patterns are proven before heavy Factory 
abstraction.
 At least four AI provider families + local provider can route/fallback with cost/latency visibility.
 Knowledge retrieval works across business, Drive, NAS, notes and code with provenance and tenant/data 
isolation.
 Business Graph can explain customer lifecycle, open loops and KPIs across 
communications/finance/marketing/product.

---

<!-- side 27 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
 Growth stack connects Ads + analytics + CRM/revenue and can execute autonomous optimizations with 
before/after evidence.
 Developer/Cloud plane can triage incidents and autonomously repair/deploy according to owner authority with 
tested recovery.
 Finance Gateway can execute real owner-authorized transactions through lawful providers with idempotency, 
reconciliation and complete audit.
 Communications Hub resolves identity across channels and can autonomously follow up without leaking raw 
secrets or unrelated data.
 iPhone/Watch/voice/web maintain continuity; Home/Personal/Health integrations are live according to owner 
data policy.
 Situation Engine performs autonomous ACT/ACT+NOTIFY with explainability, dedupe and owner pause/revoke.
 Executive Mode gives one source-backed prioritized view of business and private life.
 Backups, restore drills, monitoring, credential rotation/revocation, run-rate and maintenance metrics are 
production-verified.
 Owner can from one control panel pause/revoke a connector, device, provider, agent, finance domain or the 
entire Jarvis system.
Sluttmål
Jarvis er ferdig når den ikke bare kan svare og anbefale, men faktisk kan drive eierens tilkoblede digitale 
systemer autonomt - med så lite friksjon som mulig og med nok observability, integrity og recovery til at feil 
kan oppdages, forstås og rettes.

---

<!-- side 28 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
Appendiks A. Prioritert start-backlog
# Arbeid Leveranse Hvorfor
1 Daily Value Loop Gmail + Calendar + tasks + GitHub 
brief
Beviser daglig verdi mens UA-0 
bygges
2 UA-0 runtime UGREEN/Docker/Infisical/
Langfuse/pgvector
Gjør systemet ekte 24/7
3 Authority runtime Sovereign owner authority + D 
preflight + recovery
Maks autonomi uten approval-
flaskehals
4 Core live connectors Gmail/Calendar/Drive/GitHub/
Telegram/Vercel
Gir Jarvis faktisk tilgang
5 Builder Loop GitHub status -> issue -> agent -> 
tests -> change
Lar Jarvis hjelpe med å bygge seg 
selv
6 AI Mesh P0 OpenAI + Claude + Gemini + Kimi + 
local
Modellagnostisk core
7 Knowledge P0 Drive + NAS + GitHub + notes Bred kontekst
8 Business P0 Customer/Lead/Conversation Graph Operativ forretningsverdi
9 Growth P0 Ads + GA4 + CRM attribution Growth visibility/action
10 Cloud P0 GitHub + Vercel + GCP + Cloudflare Technical operations
11 Finance integrity Intent + idempotency + 
reconciliation + Fiken
Real economic actions safely 
executed
12 Situation Engine Cross-system events + autonomous 
ACT
Jarvis becomes proactive
Appendiks B. Connector acceptance nivå R / A
Nivå R - Read / Sync
 Official/current API docs and terms checked
 Minimal auth scopes and vault refs
 Data schema/provenance/freshness/retention
 Fake adapter + contract tests
 Prompt-injection classification for untrusted content
 Live read/sync smoke
 Audit without secret values
 Health/retry/circuit breaker/runbook
 Delete/revoke/reauth tested
 Cost/maintenance measurement
Nivå A - Write / Action
 All Level R requirements
 Owner/delegated authority and target-account resolution
 Risk class A-D
 Deterministic parameter validation and state readback
 Idempotency/replay protection
 Before/after evidence

---

<!-- side 29 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
 Rollback/compensating action or documented no-rollback recovery
 D-class snapshot/checkpoint where possible + immediate notification
 Finance reconciliation for money-affecting actions
 Pause/revoke/kill-switch tested
 Live reversible action smoke in real environment
Appendiks C. Owner autonomy configuration
Dette er eierkonfigurasjon, ikke obligatoriske begrensninger. Sovereign Mode defaults are intentionally 
permissive.
Innstilling Sovereign default Kan eier endre?
Owner write authority Enabled for connected owner accounts Ja
Human approval before D Off Ja
Finance hard caps Off Ja
Vendor allowlist Optional / off unless useful Ja
Autonomous outbound messaging On for owner-authorized channels Ja
Autonomous cloud changes On with D preflight/recovery Ja
Autonomous home/car critical actions On with state readback/confirmation Ja
Parallel AI critic Off by default for cost; policy-triggered Ja
Health/private cloud routing Per data policy; not blanket disabled Ja
Immediate D-action notification On Ja
Global kill switch Always available Nei - system invariant
Raw secret exposure to model Never Nei - system invariant
Appendiks D. Compliance- og data-gates
Område Data/handling Gate før production
UA-2 Knowledge Documents, meetings, mixed sources Processing inventory, retention/delete, source 
authority
UA-3 Business Customer graph, profiling/scoring Legal basis/processing inventory; 
human/legal control where automated 
decisions have regulated effect
UA-4 Growth GA4, ads tracking, attribution Consent/cookie handling where required, 
processor agreements, data minimization
UA-7 Communications Call recording/transcripts, outbound AI calls Disclosure/legal basis/retention; 
marketing/reservation/platform rules
UA-8 Personal Health, location, family/shared Processing/retention and appropriate data-
routing; shared authority
UA-9 Vision Cameras/events Retention, zones, workplace/home rules; no 
biometric identity in this plan
UA-6 Finance Payments/accounts Official provider/KYC/PSD2/BankID 
constraints where applicable

---

<!-- side 30 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
Appendiks E. Scoret risikoregister
Risiko Sannsynlighet Konsekvens Score Kontroll / beslutning
Connector maintenance 
consumes roadmap
Høy Høy 9/10 Maintenance ledger, retire 
low-value connectors, 
value-loop rule
Single builder / bus factor Høy Høy 9/10 Runbooks, recovery docs, 
reproducible deploy, 
external backup, no 
undocumented manual 
state
Credential compromise / 
target concentration
Middels Svært høy 9/10 Vault/machine identity, 
least credential exposure, 
audit, rapid revoke, tenant 
isolation, kill switch
Autonomous high-impact 
mistake
Middels Høy 8/10 D-class preflight, state 
readback, snapshots, 
idempotency, immediate 
notification, recovery
Value arrives too late Middels Høy 8/10 Value Track parallel with 
UA-0; daily usage 
requirement
AI/cloud run-rate grows 
unnoticed
Høy Middels 7/10 Run-rate dashboard from 
day one; cost per value loop
Platform/API change breaks 
connector
Høy Middels 7/10 Health/version monitoring, 
adapter isolation, circuit 
breaker, maintenance 
owner
Identity resolution errors Middels Høy 7/10 Confidence, reversible 
split/merge, real-data 
quality metrics
Data concentration/privacy 
exposure
Middels Høy 7/10 Space/tenant isolation, 
provenance, retention, 
source-on-demand, 
minimize durable copies
Hardware/server outage Middels Middels 5/10 Off-site backup, restore 
drill, degraded mode, 
cloud/provider fallback

---

<!-- side 31 -->

JARVIS MASTERPLAN | SOVEREIGN AUTONOMY | v4.0
Jarvis Program - Internal Architecture & Execution Plan | 13 August 2026
JARVIS
Én identitet. Én hukommelse. Mange modeller. Alle systemer. Full 
autonomi under eierens ultimate kontroll.
Neste konkrete steg
Start UA-0A og Value Track samtidig. Koble core accounts live, få Daily Executive Brief i daglig bruk, lukk 
runtime/authority/recovery gates med ekte evidens, og utvid deretter autonom write/act capability connector 
for connector. Ikke vent med å bruke Jarvis til hele arkitekturen er ferdig.
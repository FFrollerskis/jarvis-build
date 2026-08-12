# Jarvis – autoritativ masterplan

**Hjernen, identiteten, minnet, agentene, sikkerheten og den ti-delte byggeplanen**

Autoritativ plan – versjon 2.1 – 12. august 2026

> Planen innarbeider ekstern fagkritikk, sluttrapportens siste kontroll og prosjektets beslutninger.
> Full-duplex Voice Gateway, segmentert minne, deterministisk sikkerhet og mål-før-kjøp er nå grunnkrav.
> Produktversjoner, kompatibilitet og priser kontrolleres på nytt ved implementasjon eller kjøp.
>
> TOBIAS / JARVIS

> **Merknad:** Dette dokumentet er konvertert fra `01_Jarvis_Masterplan_v2.1.pdf` (12 sider) til markdown.
> PDF-en er kilden; denne filen er arbeidskopien i repoet.

## Dokumentets rolle

Dette er den autoritative planen for Jarvis som AI-system. Den erstatter tidligere arkitekturantakelser der
Home Assistant var samtalebro og der full-duplex tale var utsatt. Dokumentet samler beslutningene fra
prosjektet, korrigeringene fra første eksterne gjennomgang og de seks operative forbedringene fra
sluttrapporten. Serverplattform og livsintegrasjon beskrives i egne dokumenter.

Versjon 2.1 er laget for Tobias, Claude Code, Codex, tekniske rådgivere og andre AI-er som skal
implementere, kontrollere eller kritisere systemet. V2.1 endrer ikke hovedarkitekturen: Del 1 til 4 er
godkjent som byggegrunnlag, mens Del 5 har en måleport for norsk tale, personvern, failover og
innsatsramme.

## 1. Visjon og absolutte krav

Jarvis skal være Tobias sin langsiktige digitale partner, operative assistent og eksterne hukommelse. Den
samme identiteten skal være tilgjengelig fra mobil, PC, rommikrofoner, AirPods, Apple Watch, bil, hus,
hytte og arbeidssteder.

Krav som ikke kan forhandles bort:

- Én Jarvis-identitet på tvers av alle terminaler.
- Ett logisk minnesystem med strengt adskilte sikkerhetsområder.
- Samme samtale, prosjekter og arbeidskø på tvers av enheter.
- Full-duplex tale, streaming og avbrytelse bygges inn fra første talepilot.
- Lange jobber fortsetter etter at samtalen eller terminalen avsluttes.
- Jarvis kan delegere til Claude Code, Codex og spesialiserte agentprofiler.
- Home Assistant er kontrollag for fysiske enheter, ikke samtalemotor eller Jarvis-hjerne.
- Modeller, taleleverandører, lagring og maskinvare kan byttes gjennom adaptere.
- Ubetrodd innhold kan aldri samtidig få fri tilgang til privat data og utgående handlinger.
- Kritiske handlinger håndheves av kode og kryptografiske godkjenninger utenfor LLM-en.
- Alle beslutninger, handlinger, kilder og resultater kan spores.
- Systemet skal kunne starte billig og flyttes mellom sky, lokal maskin og egen server.

## 2. Målarkitektur

Jarvis bygges som en modulær monolitt med noen få tydelige prosesser, ikke som mange mikrotjenester
fra første dag.

### 2.1 Kjørende hovedkomponenter

- **Jarvis API/Core:** identitet, sesjoner, kontekst, dialog, policy og oppgaver.
- **Jarvis Voice Gateway:** sanntidslyd, VAD, STT, TTS, barge-in og romsesjoner.
- **Durable workflow/worker:** bakgrunnsjobber, retries, checkpoints og artefakter.
- **PC-worker:** isolert Claude Code/Codex-kjøring på Lenovo.
- **Data:** Supabase/Postgres, objektlagring og krypterte backupkopier.
- **Edge:** Home Assistant og lokal fallback per fysisk sted.
- **Watchdog:** ekstern og lokal deterministisk overvåking.

Logiske lag kan ligge i samme kodebase selv om de har ulike ansvarsområder. Antall
produksjonsprosesser i første versjon skal normalt være tre til fem, ikke én prosess per mappe.

### 2.2 Normal samtaleflyt

1. En terminal sender lyd eller tekst med identitets- og stedsmetadata.
2. Voice Gateway eller API oppretter eller gjenopptar riktig session_id.
3. Den raske ruteren vurderer om forespørselen er enkel, samtalebasert eller en kompleks jobb.
4. Kontekstbyggeren henter autorisert minne fra riktige minneområder.
5. Enkel handling går direkte til et deterministisk verktøy.
6. Samtale går til valgt modell gjennom modellgatewayen.
7. Kompleks oppgave opprettes som en varig jobb for orkestrator og worker.
8. Policy Gateway kontrollerer alle verktøykall før utførelse.
9. Resultat, kilde, kostnad, verifikasjon og artefakter lagres.
10. Svaret streames tilbake, mens langvarig arbeid fortsetter i bakgrunnen.

## 3. Identitet, sesjoner og sikkerhetsområder

Samme Jarvis betyr ikke at alle data skal ligge ubeskyttet i samme kontekst.

### 3.1 Identitetsmodell

Hver forespørsel bærer minst:

- `person_id`
- `tenant_id`
- `memory_space_id`
- `session_id`
- `device_id`
- `site_id`
- `room_id`
- `channel`
- `auth_strength`
- `delegation_id` når en agent handler på vegne av Tobias

### 3.2 Minneområder

- **personal:** privat liv, planer, preferanser og personlige dokumenter.
- **business:** Kundeoppfølging AS og andre virksomheter.
- **project:** prosjektspesifikk kontekst, kode, krav og beslutninger.
- **health:** helse og andre særlig sensitive opplysninger.
- **home:** hus, hytte, energi, vedlikehold og enhetstilstand.
- **guest:** begrenset, kortvarig kontekst uten tilgang til Tobias sitt private minne.
- **shared:** uttrykkelig delte data mellom personer eller systemer.

Jarvis oppleves som én identitet, men Context Builder må ha en eksplisitt tillatelse for hvert område den
åpner. Bedriftsdata får egne nøkler, tilgangsregler og revisjonslogger. Helseområdet skal som designregel
behandles lokalt eller sterkt minimert og aldri blandes inn i generelle agentjobber.

## 4. Jarvis Core

### 4.1 Kjerneansvar

- **Identity Service:** personer, enheter, tenants og autorisasjon.
- **Session Service:** kontinuitet mellom kanaler og aktiv samtaletilstand.
- **Context Builder:** hybrid retrieval innen tillatt område og tokenbudsjett.
- **Conversation Engine:** dialog, tur-taking, svarstil og avbrytelse.
- **Fast Router:** millisekundruting av kjente intensjoner og lokale handlinger.
- **Task Service:** bakgrunnsjobber, status, artefakter og varsling.
- **Orchestrator:** planlegging av komplekse flertrinnsoppgaver.
- **Policy Gateway:** hard kontroll av alle verktøy og handlinger.
- **Model Gateway:** provideradaptere, budsjett, fallback og rate limits.
- **Memory Writer:** uttrekk, deduplisering, relasjoner og versjonering.
- **Notification Service:** Telegram, push, e-post og Watch-godkjenning.

### 4.2 Rask bane og intelligent bane

Rask bane brukes til kjente, begrensede handlinger:

- Lys, klima, avspillingskontroll og enkel status.
- Kalenderlesing og andre godkjente lesekall.
- Systemstatus og oppgavestatus.
- Korte regler som kan avgjøres uten en stor språkmodell.

Intelligent bane brukes til:

- Vanlig samtale og rådgivning.
- Minnebaserte spørsmål.
- Prosjektarbeid og analyse.
- Planlegging med flere verktøy.
- Agentjobber som trenger checkpoints og verifikasjon.

En full LLM-orkestrator skal ikke være obligatorisk før en enkel kommando. Ruting, policykontroll og en
eventuell kort bekreftelseslyd kan kjøres parallelt med kontekstinnhenting.

## 5. Orkestrator, agentprofiler og jobber

### 5.1 MVP-agentene

Første versjon starter med fire profiler:

- **Jarvis Executive:** dialog, prioritering og sluttsvar.
- **Coding Worker:** Claude Code/Codex, tester og pull requests.
- **Research Worker:** kildekritisk research og sammenligning.
- **Verifier:** maskinelle kontroller og uavhengig kvalitetssjekk.

Fremtidige roller som chief of staff, business operations, produktleder, økonomi, kommunikasjon, hjem og
memory curator beholdes som målbilde. De introduseres først som prompt- og verktøyprofiler, ikke egne
tjenester.

### 5.2 Jobbkontrakt

Alle jobber må ha:

- `task_id`, eier og tenant.
- Mål og maskinelle akseptansekriterier.
- Inngangsdata med tillitsnivå og proveniens.
- Tillatte verktøy, datasoner og nettverksmål.
- Agentprofil og modellbudsjett.
- Tidsfrist, retry-policy og maks antall steg.
- Artefakter, logger og kostnad.
- Verifikasjon, menneskelig godkjenning ved behov og sluttstatus.

### 5.3 Workflow-teknologi

Start med en administrert durable workflow-løsning som Trigger.dev, eller Hatchet dersom selvhosting
blir viktig. Teknologien skjules bak et internt WorkflowAdapter. Temporal vurderes bare dersom målt
volum, komplekse langtidsprosesser eller et større team forsvarer driftsbyrden.

## 6. Livslangt minnesystem

Minnet bygges som et hybridsystem. Verken mapper, pgvector eller en kunnskapsgraf er tilstrekkelig
alene.

### 6.1 Minnelag

1. **Rå hendelseslogg:** originale meldinger, møter, dokumenter, verktøyoutput og endringer.
2. **Strukturert sannhet:** personer, organisasjoner, prosjekter, beslutninger, oppgaver og frister i Postgres.
3. **Fulltekstsøk:** eksakte navn, uttrykk, datoer og dokumentinnhold.
4. **Vektorsøk:** semantisk lignende minner og samtaler.
5. **Relasjonslag:** noder og kanter mellom personer, prosjekter, avtaler og hendelser.
6. **Sammendragslag:** daglige, ukentlige, prosjektvise og langsiktige sammendrag.
7. **Reranking:** kombinerer tekst, vektor, relasjon, tid, kilde og autoritet.

Relasjonslaget implementeres først med Postgres-tabellene `entities` og `relations`. En egen grafdatabase
innføres bare dersom evalueringsdata viser at flerhopp-spørringer ikke løses godt nok.

### 6.2 Minnetyper

- Working memory
- Episodisk minne
- Semantisk minne
- Prosedyreminne
- Preferanseminne
- Relasjonsminne
- Prosjektminne
- Operativt minne
- Beslutninger og forpliktelser
- Arkiv

### 6.3 Datamodell

Viktige tabeller:

- `people`, `organizations`, `tenants`, `projects`
- `sessions`, `messages`, `events`
- `memory_spaces`, `memory_items`, `memory_versions`, `memory_sources`
- `entities`, `relations`, `summaries`, `embeddings`
- `decisions`, `commitments`, `deadlines`
- `tasks`, `task_runs`, `agent_runs`, `tool_calls`, `artifacts`
- `devices`, `sites`, `rooms`, `capabilities`, `approvals`
- `audit_events`, `security_incidents`, `cost_events`

Hvert minne har minst eier, tenant, område, kilde, tidsstempel, gyldighetsperiode, sensitivitet, tillitsnivå,
konfidens, versjon, relasjoner og retensjonsregel.

### 6.4 Skriveflyt og minnekarantene

1. Rådata lagres med kilde og tillitsklasse.
2. Ubetrodd verktøyoutput legges i karantene.
3. Memory Writer foreslår ADD, UPDATE, INVALIDATE eller NOOP.
4. Kandidaten sammenlignes med eksisterende fakta og relasjoner.
5. Motstrid markeres og versjoneres, ikke skjules.
6. Sensitivitet og minneområde fastsettes før lagring.
7. Embedding og søkeindeks opprettes.
8. Viktige fakta krever sterkere kilde eller menneskelig godkjenning.
9. Gamle hendelser komprimeres uten å ødelegge råkilden.

### 6.5 Menneskelesbar eksport

Databasen er autoritativ. Følgende mappevisning genereres for mennesker og backup:

- `memory/people/tobias/profile/`
- `memory/people/tobias/personal/`
- `memory/people/tobias/health/`
- `memory/people/tobias/business/<company_id>/`
- `memory/people/tobias/projects/<project_id>/`
- `memory/people/tobias/decisions/`
- `memory/people/tobias/commitments/`
- `memory/sites/<site_id>/`
- `memory/conversations/<year>/<month>/`
- `memory/archive/`

### 6.6 Evaluering

Før minnet får høy autoritet bygges et eget eval-sett med minst 50 til 100 spørsmål fra Tobias sin faktiske
historikk. Det skal måle korrekthet, kilde, tidsforståelse, tilgangsgrenser, gjenfinning av motstrid og
fravær av kryss-tenant-lekkasje.

## 7. Modell- og leverandørstrategi

### 7.1 Modellgateway

Start med LiteLLM eller tilsvarende gateway for å standardisere OpenAI, Anthropic, OpenRouter og lokale
modeller. Egen rutingkode begrenses til Jarvis-spesifikke regler.

Rutingen vurderer:

- Oppgavetype og kvalitetskrav.
- Forsinkelsesbudsjett.
- Sensitivitet og tillatt region.
- Kontekstmengde.
- Kostnadstak.
- Verktøybehov.
- Tilgjengelighet og fallback.

### 7.2 Kostnadskontroll

- Budsjett per jobb og agentprofil.
- Kostnadsvarsel ved 1 000 kroner samlet API- og skyforbruk per måned i startfasen.
- Aktiv godkjenning ved 2 000 kroner per måned.
- Midlertidig hardgrense ved 3 000 kroner per måned, med signert manuell overstyring.
- Kostnad knyttet til `task_id`.
- Automatisk stopp ved løkker eller avvik.
- Billig modell for klassifisering og enkel strukturering.
- Frontier-modell bare når oppgaven krever det.
- Lokal modell brukes når personvern, latens, offlinebehov eller målt økonomi forsvarer det.

Beløpene er startgrenser, ikke permanente budsjetter. De gjennomgås etter 30 dager og håndheves av
Model Gateway/Policy Gateway, ikke bare av et dashboard.

## 8. Integrasjoner

### 8.1 Første bølge

- Supabase/Postgres
- GitHub
- Vercel
- Google Cloud
- Claude Code og Codex
- OpenAI og Anthropic API
- Gmail eller Outlook gjennom offisielt API
- Google eller Outlook Calendar
- Google Drive/Docs
- Telegram
- Home Assistant

### 8.2 Andre bølge

- Kundeoppfølging/Dennis og CRM
- Slack/Teams og møtesystemer
- Telefoni, SMS og VoIP
- Fiken/Folio og økonomidata gjennom avgrensede grensesnitt
- Nettsideovervåking, kostnader og SLA
- Bil- og hvitevare-API-er
- Apple Health gjennom kontrollert mobilintegrasjon

Alle integrasjoner går gjennom Tool Gateway. Offisielt API foretrekkes fremfor nettleserautomatisering.
MCP-servere må verifiseres, låses til eksplisitte skjemaer og få minst mulig tilgang.

## 9. Sikkerhetsarkitektur – Del 0

Sikkerhet bygges før Jarvis kobles til e-post, web, GitHub, privat minne eller eksterne handlinger.

### 9.1 Tillitszoner

- **Ingestion Zone:** e-post, nettsider, dokumenter, GitHub-issues og annet ubetrodd innhold.
- **Reasoning Zone:** planlegging på sanitert, strukturert innhold.
- **Memory Zone:** autoritativt minne med proveniens og karantene.
- **Execution Zone:** deterministisk Policy Gateway og tillatte verktøy.
- **Secret Zone:** vault og kortlivede credentials som LLM-en aldri leser direkte.

En sesjon som analyserer ubetrodd innhold får ikke samtidig fri tilgang til private minner og utgående
verktøy. Sanitert output må passere skjema- og policykontroll før neste sone.

### 9.2 Capability- og godkjenningsmodell

Alle verktøy klassifiseres:

- **Klasse A:** lesing og ufarlig analyse.
- **Klasse B:** reversible interne handlinger.
- **Klasse C:** eksterne handlinger innen uttrykkelig mandat.
- **Klasse D:** betaling, kontrakt, sletting, publisering, lås, alarm og tilgangsendring.

Klasse D krever et signert godkjenningsobjekt med handling, parametere, utløpstid, engangs-ID og
godkjennende enhet. LLM-en kan be om godkjenning, men kan ikke lage eller omgå den.

### 9.3 Worker-sikkerhet

- Linux/WSL2 eller VM-basert container per jobb.
- Kastbart filsystem og separat arbeidskatalog.
- Nettverksallowlist.
- Repo- og jobbspesifikke tokens.
- Ingen hovednøkler i miljøet.
- Ingen farlig tillatelsesoverstyring utenfor kastbar test.
- Pull request, automatiske tester og menneskelig merge-gate for produksjon.

### 9.4 Secrets, audit og nødstopp

- Infisical, OpenBao eller annen sentral vault.
- Kortlivede identiteter og planlagt rotasjon.
- SOPS bare for krypterte konfigurasjonsfiler i Git.
- Append-only audit-logg utenfor agentprosessen.
- Kill switch som stopper verktøy, tilbakekaller tokens og fryser køer.
- Dokumentert nødtilgang og kontinuitetsplan for selskapet.

## 10. Personvern og datastyring

Før bedrifts-, gjeste- eller helsedata kobles inn skal følgende finnes:

- Behandlingsoversikt og formål per datakategori.
- DPIA for behandlinger med sannsynlig høy risiko.
- Databehandleravtale og region-/retensjonsmatrise per modell-, STT-, TTS- og realtime-leverandør.
- Separate tenants, nøkler og Row Level Security.
- Retensjonsregler, innsyn, retting, eksport og sletting.
- Pseudonymisering og dataminimering før eksterne modellkall.
- Ingen kontinuerlig lagring av rå romlyd.
- Gjestemodus, fysisk mute og synlig lytteindikator.

Talelyd behandles som personopplysninger. Stemme er ikke automatisk biometriske artikkel 9-data; det
blir biometriske særkategoridata når den behandles for entydig identifisering. Lyd kan likevel avsløre
helse og andre sensitive forhold. DPIA-en skal derfor beskrive formål, behandlingsgrunnlag, region,
retensjon, eventuell modelltrening, sletting, kryptering og om rå lyd forlater huset. Stemmeprofil brukes
aldri alene som godkjenning for en kritisk handling.

Samme Jarvis-opplevelse bevares gjennom identitet og kontekstbygger, ikke ved å blande alle
personopplysninger.

## 11. Observability, watchdog og recovery

### 11.1 Observability

Langfuse eller tilsvarende brukes til traces, modellkall, kostnad, latency, evals og kobling til `task_id`.
Systemmetrics samles separat.

### 11.2 Deterministisk watchdog først

- Uptime og P95-latency.
- Database, kø, lagring og backupstatus.
- Fastlåste jobber og agentløkker.
- Tokenutløp og integrasjonsfeil.
- Disk, RAM, GPU, temperatur og UPS.
- Home Assistant og Voice Gateway per sted.
- Telegram-varsel med alvorlighetsgrad og runbook.

Første watchdog får bare utføre eksplisitte, reversible handlinger som restart av én tjeneste. LLM-en kan
forklare logger og foreslå tiltak, men autonom reparasjon kommer senere gjennom signerte runbooks
med precheck, tidsavbrudd, rollback og maks antall forsøk.

### 11.3 RTO og RPO

- **Tier 1, identitet og autoritativ database:** mål RPO maksimalt 15 minutter til 2 timer, RTO maksimalt 4 timer.
- **Tier 2, oppgaver og aktive prosjekter:** RPO maksimalt 4 timer, RTO samme arbeidsdag.
- **Tier 3, arkiv og mediefiler:** daglig eller ukentlig kopi, RTO flere dager.

Restore testes med faktisk tidtaking. Backup som aldri er gjenopprettet regnes ikke som verifisert.

## 12. Repository

Foreslått monorepo:

- `apps/api`
- `apps/web`
- `apps/mobile`
- `apps/desktop`
- `modules/core`
- `modules/voice`
- `modules/memory`
- `modules/tasks`
- `modules/policy`
- `modules/notifications`
- `workers/coding`
- `workers/research`
- `integrations/home-assistant`
- `integrations/github`
- `integrations/vercel`
- `integrations/supabase`
- `integrations/google`
- `packages/contracts`
- `packages/provider-adapters`
- `packages/observability`
- `infra/cloud`, `infra/local`, `infra/edge`
- `docs/architecture`, `docs/decisions`, `docs/security`, `docs/runbooks`

Dette er en logisk struktur. Den betyr ikke at hver mappe skal deployes separat.

## 13. Ti-delt byggeplan

### Del 1 – Sikkerhets- og personvernfundament

Estimert innsats: 1 til 2 uker. Lag trusselmodell, tillitszoner, capability-klasser, DPIA-utkast inkludert
talelyd, tenantmodell, secrets-strategi, auditkrav, kill switch og akseptansekriterier. Ferdig når
policytester avviser uautorisert klasse D-handling og databehandler-/regionmatrisen har eksplisitte felt
for LLM, STT, TTS og realtime.

### Del 2 – Identitet, kontrakter og datafundament

Estimert innsats: 1 til 2 uker. Definer `person_id`, tenant, minneområder, sesjoner, oppgaver,
verktøyskjemaer og hendelsesformat. Opprett Supabase og RLS. Ferdig når automatiske tester beviser
tenant-isolasjon, idempotente hendelser og gyldig sesjonsgjenopptak.

### Del 3 – Jarvis Core og tekst-MVP

Estimert innsats: 2 til 3 uker. Bygg modulær monolitt, webchat, modellgateway, kontekstbygger, rask
ruter, streaming tekst og observability. Ferdig når en samtale kan opprette og følge en jobb, kostnader
spores, og kritiske verktøy blokkeres uten gyldig godkjenning.

### Del 4 – Hybridminne v1

Estimert innsats: 2 til 4 uker. Bygg rå eventlogg, strukturert minne, fulltekst, pgvector, relasjoner,
sammendrag, karantene, menneskelesbar eksport og eval-sett. Ferdig når eval-settet gir kilder, håndterer
tid og motstrid og viser null kryss-tenant-lekkasje.

### Del 5 – Voice Gateway vertikal prototype

Timebox: to sprinter på to uker. Før låsing gjennomføres norsk provider-benchmark på minst 100
lydprøver, taledelen av DPIA fullføres og reserveveien defineres. Bygg terminal til Voice Gateway til
streaming STT til Jarvis til streaming TTS til terminal. Inkluder VAD, AEC, støyreduksjon, barge-in,
sesjonsgjenopptak og avbrytelse før flere rom. Etter fire uker tas stop/go-beslutning for valgt satellitt og
provider; full-duplexarkitekturen beholdes selv om maskinvare eller transport må byttes.

### Del 6 – Oppgaver og isolerte workers

Estimert innsats: 2 til 4 uker. Koble durable workflow, agentprofiler og PC-worker. Krev container per jobb,
tillatte nettverksmål, PR, tester og verifikasjon. Ferdig når en jobb overlever klientfrakobling, kan stoppes
og gjenopptas og aldri får produksjonsmerge uten gate.

### Del 7 – Første integrasjoner

Estimert innsats: 2 til 4 uker for første bølge. Koble GitHub, Vercel, Supabase, Google, kalender, e-post og
Telegram gjennom Tool Gateway og egne credentials. Ferdig når hvert verktøy har scopes, audit, rate
limit, rollback og test av prompt injection.

### Del 8 – Mobil, Watch og kontinuitet

Estimert innsats: 4 til 8 uker avhengig av Apple-begrensninger. Bygg native iPhone-app, App Intents,
Action Button/Control, push, Live Activity, AirPods og Watch-godkjenninger med samme sesjon. Ferdig når
aktiv samtale og godkjenning fungerer på låst telefon innenfor tillatte API-er.

### Del 9 – Home Assistant, hus og steder

Estimert innsats: 2 til 6 uker for første sted, deretter per rom/sted. Koble Home Assistant som verktøy.
Legg til lokale hurtigkommandoer, rommetadata, flere satellitter, huset og senere hytta.
Sikkerhetsfunksjoner forblir deterministiske. Ferdig når huset tåler skybrudd og en romfeil uten at kritiske
automasjoner stopper.

### Del 10 – Drift, skalering og egen infrastruktur

Kontinuerlig driftsspor etter første produksjonsversjon. Fullfør watchdog, restoreøvelser, kostnadsanalyse
og 30 til 90 dagers måling. Flytt passende tjenester til alltid-på node, NAS eller GPU-server bare når tall
og personvernbehov forsvarer det. Ferdig-definisjonen er dokumentert restore, failover, kostnadstak,
alarmer og eierskap for alle Tier 1-tjenester.

## 14. Akseptansekriterier for første reelle Jarvis

- Samme samtale fortsetter mellom web, telefon, PC og én romsatellitt.
- Første vertikale talepilot har ekte barge-in og stopper avspilling innen 250 ms ved ren tale.
- En enkel lokal kommando trenger ikke stor LLM.
- Vanlig talerespons begynner under 1,5 sekunder i median og måles i P95.
- Norsk STT/TTS-benchmark omfatter minst 100 lydprøver og sammenligner kvalitet, P50/P95, pris og datavilkår.
- Voice Gateway kan gjenoppta samme sesjon etter lokal-/skyfailover uten doble verktøyhandlinger.
- Jarvis henter korrekt prosjektminne med kilde og riktig tenant.
- Minne-eval har ingen kryss-tenant-lekkasje.
- En kodejobb kjører isolert, lager branch/PR, tester og rapporterer artefakter.
- Kritisk handling avvises uten gyldig signert godkjenning.
- Prompt injection-test får ikke eksfiltrere secrets eller sende data ut.
- Alle verktøykall kan spores til person, jobb, policy og credential.
- Watchdog oppdager simulert feil og varsler Telegram.
- Tier 1-data gjenopprettes innen dokumentert RTO/RPO.
- Kostnad kan vises per modell, agent, tenant og oppgave.
- Startfasens varsling, godkjenning og hardgrense på 1 000/2 000/3 000 kroner håndheves og testes.

## 15. Beslutninger og valideringspunkter

**Besluttet:**

- Én Jarvis-identitet med segmenterte minneområder.
- Modulær monolitt og få produksjonsprosesser.
- Hybridminne med Postgres, fulltekst, vektor og relasjoner.
- Full-duplex Voice Gateway fra første talepilot.
- Home Assistant som verktøy og enhetsbuss.
- Home Assistant Assist som kjørbar reservevei, aldri separat identitet eller autoritativ samtalemotor.
- Deterministisk Policy Gateway og fysisk godkjenning for kritiske handlinger.
- Sandboxede workers og menneskelig merge-gate.
- Hybrid sky/lokal drift med måling før store kjøp.

**Skal måles eller valideres:**

- Beste satellittmaskinvare og transport for full-duplex.
- Norsk wake-word, STT, TTS og P95-latency.
- Fire ukers stop/go-port for første romsatellitt og taleprovider.
- Sesjonsgjenopptak og idempotens ved lokal-/skyfailover.
- Trigger.dev mot Hatchet etter første bakgrunnsjobber.
- LiteLLM/OpenRouter/providerkombinasjon og databehandlerkrav.
- Relasjonstabeller mot egen grafdatabase etter minne-eval.
- Lokal modelløkonomi etter 30 til 90 dager.

## 16. Referanser for implementasjon

- Home Assistant voice pipelines: https://developers.home-assistant.io/docs/voice/pipelines/
- Home Assistant conversation: https://developers.home-assistant.io/docs/core/entity/conversation/
- Home Assistant LLM API: https://developers.home-assistant.io/docs/core/llm/
- Apple App Intents: https://developer.apple.com/documentation/AppIntents/app-intents
- Apple CarPlay: https://developer.apple.com/carplay/
- OpenAI API data controls: https://platform.openai.com/docs/models/default-usage-policies-by-endpoint
- Datatilsynet DPIA: https://www.datatilsynet.no/rettigheter-og-plikter/virksomhetenes-plikter/vurdering-av-personvernkonsekvenser/
- EDPB om behandlingsgrunnlag og sensitive data: https://www.edpb.europa.eu/sme/be-compliant/process-personal-data-lawfully_en
- Supabase Queues: https://supabase.com/docs/guides/queues/pgmq
- Langfuse: https://langfuse.com/docs
- LiteLLM: https://docs.litellm.ai/

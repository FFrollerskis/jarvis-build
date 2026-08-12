# Jarvis – beslutninger, antakelser og kritisk gjennomgang

**Status:** Utkast v1.0. Dette dokumentet er logg over (a) beslutninger arvet fra masterplan v2.1,
(b) beslutninger tatt i spesifikasjonsarbeidet, (c) funn fra kritisk gjennomgang av kildedokumentene, og
(d) antakelser som må bekreftes av Tobias.

## A. Arvede beslutninger (fra masterplan v2.1 – bekreftet videreført)

| ID | Beslutning |
|---|---|
| D-01 | Én Jarvis-identitet med segmenterte memory spaces |
| D-02 | Modulær monolitt; 3–5 produksjonsprosesser |
| D-03 | Hybridminne: Postgres + fulltekst + pgvector + relasjonstabeller + sammendrag + reranking |
| D-04 | Full-duplex Voice Gateway som egen prosess fra første talepilot |
| D-05 | Home Assistant som verktøy/enhetsbuss; HA Assist kun som reservevei |
| D-06 | Deterministisk Policy Gateway + signerte godkjenninger for klasse D |
| D-07 | Workflow-motor bak `WorkflowAdapter`; Temporal kun ved målt behov |
| D-08 | Sandboxede workers + menneskelig merge-gate |
| D-09 | Hybrid sky/lokal med måling før kjøp; startgrenser 1 000/2 000/3 000 kr/mnd |
| D-10 | Norsk tale-benchmark (≥100 prøver) + tale-DPIA før leverandørvalg låses; 4 ukers stop/go |

## B. Nye beslutninger i spesifikasjonsarbeidet

| ID | Beslutning | Begrunnelse |
|---|---|---|
| D-11 | **Fase 1 omdefinert til «kjørbart fundament»:** masterplanens Del 1 (sikkerhetsdokumenter) + repo-skjelett, kontrakter, policy-skjelett med kjørende tester | Brukerkravet sier at fase 1 skal være et lite, *fungerende* fundament. Masterplanens Del 1 er ren dokumentleveranse; uten kjørende policytester kan ikke Del 1s eget akseptansekriterium («policytester avviser uautorisert klasse D») oppfylles |
| D-12 | **Ren PostgreSQL er kravet; Supabase er en distribusjon av det.** Lokal Postgres-container i trinn 0–1; Supabase (sky eller selvhostet) er valgfritt senere | Lokal-først-prinsippet (regel 12). Alt som brukes (RLS, pgvector, tsvector, pgmq) er ren Postgres og flytter uendret |
| D-13 | **Workflow starter Postgres-basert (pg-boss-klasse) bak `WorkflowAdapter`** i fase 3; Trigger.dev/Hatchet evalueres i fase 6 når reelle jobbmønstre finnes | Masterplanen foreslår administrert Trigger.dev først – det strider mot lokal-først og gir skyavhengighet i kjernen før det trengs. Adapteren gjør bytte billig |
| D-14 | **TypeScript (Node 22) som primærspråk for Core/Worker/web; Python tillatt kun i Voice Gateway hvis taleøkosystemet krever det** | Ett språk i kjernen gir delte typede kontrakter (`packages/contracts`), enklere vedlikehold for én utvikler + AI-agenter. Se teknologistack i IMPLEMENTATION_PLAN |
| D-15 | **`apps/mobile`/`apps/desktop` opprettes først i fase 8** | Tomme mapper gir falsk fremdrift; monorepo-strukturen tåler tillegg senere |
| D-16 | **Secrets i fase 1: SOPS + age for kryptert konfig, `.env` kun lokalt og git-ignorert, `.env.example` uten secrets, gitleaks i CI, dokumentert secrets-strategi – ingen kjørende vault. Sentral vault (Infisical/OpenBao) innføres når flere tjenester/prosesser faktisk trenger delte secrets, og senest før eksterne integrasjoner gjør det nødvendig (fase 7). Valget Infisical vs. OpenBao står åpent (Q-05)** | Full vault fra dag én er tung for én maskin; SOPS-kravet finnes allerede i masterplanen. Prinsippet «aldri secrets i kode» gjelder fra første commit |
| D-17 | Dokumenthierarki: CANONICAL_SPEC > øvrige docs > masterplan-PDF > eldre notater | Én autoritativ kilde ved motstrid |
| D-18 | **Masterplan v2.1 er eneste tilgjengelige kildedokument nå.** Sluttrapport/serverplattform-/livsintegrasjonsdokumentene finnes ikke i repoet. Nye eksplisitte beslutninger fra Tobias kan oppdatere/overstyre tidligere antakelser når de dokumenteres i CANONICAL_SPEC/DECISIONS (lukker Q-01 og bekrefter A-01, Tobias 2026-08-12) | Unngår spesifikasjonsstopp på manglende dokumenter; endringsvei er definert |
| D-19 | **Norsk er primærspråk** for Jarvis (tale/tekst/dokumentasjon); kode, scripts og tekniske navn kan være engelsk (bekrefter A-02, Tobias 2026-08-12) | Styrer benchmark-design og promptstrategi |
| D-20 | **Maskinvareplan (erstatter A-03):** UGREEN DXP4800 Plus (NAS) er 24/7-basen for Jarvis-data, databaser, Home Assistant, Docker-tjenester, nettsider, filer og backup. Eksisterende PC (RTX 4070) brukes til utvikling og tyngre AI/GPU-arbeid i startfasen. Kraftigere dedikert AI-server (f.eks. RTX 5080-klasse) bygges først når behovet er dokumentert. Mac mini/NUC er ikke del av startplanen (Tobias 2026-08-12) | Lokal-først beholdes; 24/7-drift flyttes fra ustabil PC til NAS uten arkitekturendring (alt er containerisert og flyttbart) |
| D-21 | **Kundeoppfølging AS er eneste bedrifts-tenant i v1**; arkitekturen skal fortsatt støtte flere tenants uten større redesign (bekrefter A-04, Tobias 2026-08-12) | Tenant-modellen i fase 2 dimensjoneres deretter |
| D-22 | **iPhone + Apple Watch er mobilplattformen i v1**; Android er ikke krav (bekrefter A-05, Tobias 2026-08-12) | Fase 8 bygger kun Apple-økosystemet |
| D-23 | **Skybaserte frontier-modeller kan brukes for ikke-sensitive data.** Sensitive spaces/data følger sikkerhets- og personvernreglene og kan kreve lokal behandling eller sterk dataminimering (bekrefter A-06, Tobias 2026-08-12) | Model Gateway-ruting per space fra fase 3 |
| D-24 | **Webchat i fase 3 er en lettvekts statisk side i `apps/web` servert av API-et – ikke Next.js.** Next.js-klasse rammeverk vurderes når web-appen får reelle behov (auth-flyt, flere sider) | Én HTML-side trenger ikke et rammeverk; unngår stor avhengighetsflate og CI-tid; SSE-streaming fungerer med ren fetch (fase 3, 2026-08-12) |
| D-25 | **Runtime uten build-steg: Node `--experimental-transform-types` + relative imports med `.ts`-utvidelse** i hele monorepoet | Reell kjøring avdekket at strip-types ikke støtter parameter properties og at `.js`-imports ikke resolves; transform-types kjører full TS-syntaks direkte. Build-steg innføres når produksjonskrav (fase 6+) tilsier det |
| D-26 | **Kø-claiming på tvers av tenants skjer via én smal SECURITY DEFINER-funksjon (`claim_next_task`, migrasjon 007)** – app-rollen får aldri generell RLS-bypass | Workeren er systemintern og må claime uansett tenant; en funksjon eid av migrasjonsbruker gir minst mulig privilegium i stedet for privilegert app-rolle (fase 3, 2026-08-12) |
| D-29 | **Voice-piloten bruker WebSocket-transport; WebRTC-stack (LiveKit-kandidat) besluttes i stop/go-porten.** Eneste nye avhengighet er `ws` (de facto standard, null native deps). Full-duplex-arkitekturen (streaming STT/TTS, VAD, barge-in, sesjonskontinuitet) er transportuavhengig og beholdes uansett transportvalg | WebRTC-stacker krever native bygg/medieserver som ikke kan verifiseres i dev-miljøet; WS beviser hele den vertikale kjeden reelt nå, og VOICE_ARCHITECTURE §3 definerer allerede WS som fallback-transport (fase 5, 2026-08-13) |
| D-28 | **Embeddings lagres i fase 4 som portabel `real[]` med cosine-funksjon i SQL; pgvector/HNSW-konvertering er bindende port ved første Docker-miljø** (sammen med D-27-porten): egen migrasjon konverterer kolonnen til `vector` + HNSW-indeks og retrieval-spørringen byttes til pgvector-operatorer, med ytelsesmåling før/etter | Embedded test-Postgres (og enhver vanilla Postgres) mangler pgvector-utvidelsen; `real[]`-varianten kjører identisk overalt og er rask nok på personlig skala (P95 < 300 ms bevist i test). Compose-imaget (`pgvector/pgvector:pg16`) har utvidelsen klar (fase 4, 2026-08-13) |
| D-27 | **Faktisk Langfuse-visning utsettes til første tilgjengelige Docker-miljø** (besluttet av Tobias/ekstern arkitekt 2026-08-13; lukker fase 3-akseptanse 2 som «PASS by explicit deferment»). **Bindende fremtidig port – må IKKE glemmes eller permanent waives:** ved første Docker-miljø som etableres for Jarvis skal følgende utføres FØR miljøet regnes som ferdig: (1) start Langfuse med prosjektets støttede lokale konfigurasjon; (2) kjør minst ett faktisk eller kontrollert modellkall gjennom ModelGateway; (3) verifiser i Langfuse at tracen er synlig; (4) verifiser at tracen inneholder korrekt `session_id`, `task_id` der relevant, provider/modell, latency, token-/bruksmåling der tilgjengelig og beregnet kostnad; (5) kryssjekk kostnaden mot `cost_events` i PostgreSQL; (6) dokumenter resultatet i PROJECT_STATUS.md; (7) fungerer ikke Langfuse-integrasjonen behandles det som en feil som rettes før Docker-/driftsmiljøet godkjennes | Fase 3 har bevist at `cost_events` persisteres i PostgreSQL, at trace-spans har korrekt `session_id`/`task_id`-korrelasjon og kostnadsdata, at TraceSink/Langfuse-integrasjonen er implementert, og at budsjettkontroll og provider-flyt er verifisert. Eneste uverifiserte delkrav er visning i kjørende Langfuse-instans; utviklingsmiljøet mangler Docker, og det er ikke forholdsmessig å introdusere ny lokal infrastruktur kun for én observability-verifikasjon |

## C. Funn fra kritisk gjennomgang av masterplan v2.1

| ID | Funn | Type | Håndtering |
|---|---|---|---|
| K-01 | Masterplanens Del 1–2 leverer ingen kjørende programvare, mens brukerkravet krever et «lite, fungerende fundament» i fase 1 | Motstrid | Løst ved D-11: fase 1 = Del 1 + kjørbart skjelett |
| K-02 | «Lokal drift først» vs. første bølge-integrasjoner som er skytjenester (Vercel, Google Cloud, Supabase-sky) og administrert Trigger.dev | Spenning | Løst ved D-12/D-13: skytjenester er valgfrie/utsatt; kjernen kjører lokalt |
| K-03 | Masterplanen sier både «Supabase/Postgres» som datalag og «flyttes mellom sky, lokal og egen server uten omskriving» – Supabase-spesifikke API-er (auth, storage, edge functions) ville låst oss | Risiko | D-12: bruk kun Postgres-kompatible funksjoner; Supabase-APIer unngås i kjernen |
| K-04 | LiteLLM (Python-proxy) anbefales, men resten av stacken peker mot TypeScript (Trigger.dev, Vercel, Supabase) – språkmiks er ikke adressert i planen | Svakhet | D-14 + Q-04: LiteLLM kjøres ev. som egen container (ikke bibliotek), eller erstattes av TS-adapter; avgjøres i fase 3 |
| K-05 | Kostnadsgrenser (1 000/2 000/3 000 kr) skal «håndheves av Model Gateway/Policy Gateway» – men skykostnader (Vercel, Google Cloud) går utenom disse gateways og kan ikke håndheves der, kun overvåkes | Unøyaktighet | Presisert i DEPLOYMENT §6: API-kost håndheves; infrakost overvåkes av watchdog |
| K-06 | Worker-sikkerhet krever «Linux/WSL2 eller VM-basert container per jobb» – planen nevner ikke at Docker Desktop/WSL2 på Windows 11 Home har begrensninger (ingen Hyper-V isolasjon) | Hull | Notert i OPEN_QUESTIONS Q-06; WSL2-backend er akseptabel start, VM-isolasjon vurderes ved behov |
| K-07 | Barge-in ≤250 ms og talerespons <1,5 s median er ambisiøse mål med sky-STT/TTS fra Norge; planen har riktignok benchmark-port, men ingen definert fallback hvis ingen leverandør når målet | Risiko | Q-03: stop/go-porten i fase 5 skal også kunne konkludere «lokal STT/TTS» eller «justerte mål» |
| K-08 | Masterplanen refererer «sluttrapportens seks operative forbedringer» og egne dokumenter for «serverplattform og livsintegrasjon» – disse finnes ikke i docs/input | Manglende kilde | Q-01: be Tobias om dokumentene eller bekrefte at masterplanen er eneste kilde |
| K-09 | Eval-settet (50–100 spørsmål) krever «Tobias sin faktiske historikk» – som ikke finnes i systemet før fase 4+; kaldstartproblem | Svakhet | Fase 4 starter med syntetisk + manuelt kuratert sett; utvides løpende med reell historikk |
| K-10 | Identitetsmodellen har `delegation_id`, men planen definerer ikke hvordan delegasjonskjeder revideres (agent A delegerer til agent B) | Hull | Tas inn i fase 2-kontraktene: delegasjoner er en kjede med maks dybde, alle ledd i audit |
| K-11 | «Kostnadsvarsel … i startfasen» er datert (beløp i NOK, august 2026); priser og produktversjoner må sjekkes på nytt ved implementering – planen sier dette selv | Påminnelse | Videreført som stående regel i CANONICAL_SPEC §7 |
| K-12 | pgmq (Supabase Queues) nevnes i referansene, men workflow-kapittelet peker på Trigger.dev/Hatchet – planen er tvetydig om kø vs. workflow | Tvetydighet | Avklart: pgmq/pg-boss-klasse er kø-/jobbfundament (D-13); «durable workflow» med checkpoints er laget over; full motor vurderes i fase 6 |

## D. Antakelser (alle avklart av Tobias 2026-08-12 – Q-02 lukket)

| ID | Antakelse | Utfall |
|---|---|---|
| A-01 | Masterplan v2.1 eneste hovedkilde | **Bekreftet** → D-18 |
| A-02 | Norsk primærspråk | **Bekreftet** → D-19 |
| A-03 | Jarvis starter kun på eksisterende PC | **Avkreftet/erstattet** → D-20 (UGREEN DXP4800 Plus som 24/7-base; PC til utvikling/GPU; AI-server senere ved dokumentert behov) |
| A-04 | Kundeoppfølging AS eneste bedrifts-tenant i v1 | **Bekreftet** → D-21 |
| A-05 | iPhone/Apple Watch som mobilplattform | **Bekreftet** → D-22 |
| A-06 | Sky-frontier-modeller OK for ikke-sensitive data | **Bekreftet** → D-23 |

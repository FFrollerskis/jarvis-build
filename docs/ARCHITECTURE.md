# Jarvis – arkitektur

**Status:** Utkast v1.0. Autoritativt hierarki: [CANONICAL_SPEC.md](CANONICAL_SPEC.md) gjelder ved motstrid.

## 1. Arkitekturprinsipper

1. **Modulær monolitt, få prosesser.** Logiske moduler i én kodebase; 3–5 produksjonsprosesser totalt.
   Moduler kommuniserer via typede interne kontrakter, slik at en modul senere kan skilles ut uten omskriving.
2. **Adapter foran alle leverandører.** LLM, STT, TTS, workflow-motor, lagring, varsling og
   hjemmestyring nås kun gjennom interne adaptere (`ModelGateway`, `SpeechAdapter`, `WorkflowAdapter`,
   `StorageAdapter`, `NotifyAdapter`, `HomeAdapter`). Ingen modul importerer en leverandør-SDK direkte.
3. **Deterministisk der det er mulig, LLM der det trengs.** Ruting av kjente intensjoner, policy-håndheving,
   godkjenninger og watchdog er ren kode. LLM brukes til samtale, analyse og planlegging.
4. **Alt er sporbart.** Hver handling knyttes til person, tenant, sesjon, jobb, policybeslutning, credential og kostnad.
5. **Flyttbarhet.** Alt kjører i containere med konfigurasjon via miljø; ingen komponent antar en bestemt
   maskin, region eller skyleverandør.

## 2. Prosesstopologi

```
                    ┌────────────────────────────────────────────────┐
 Terminaler         │                JARVIS CORE (API)               │
 ──────────         │                                                │
 Web-chat ────HTTP──▶  Identity │ Session │ Fast Router │ Context   │
 Mobil/Watch──HTTP──▶  Builder │ Conversation │ Task │ Orchestrator │
                    │  Policy Gateway │ Model Gateway │ Memory      │
 Rom-satellitt      │  Writer │ Notification                        │
   │ lyd (WebRTC)   └──────▲─────────────────────────▲──────────────┘
   ▼                       │ intern kontrakt         │
 ┌──────────────────┐      │                  ┌──────┴─────────┐
 │  VOICE GATEWAY   │──────┘                  │     WORKER     │
 │ VAD·AEC·STT·TTS  │                         │ durable jobs · │
 │ barge-in·rom     │                         │ agentprofiler ·│
 └──────────────────┘                         │ sandbox-kjøring│
                                              └──────┬─────────┘
        ┌──────────────────────────────────────────┐ │
        │ DATA: PostgreSQL (autoritativ) · objekt- │◀┘
        │ lagring · krypterte backuper             │
        └──────────────────────────────────────────┘
 Edge per sted: Home Assistant (enhetsbuss) · lokal fallback
 Sidekar: Watchdog (egen prosess) · Langfuse · vault
```

Prosesser i første produksjonsversjon: **Core**, **Voice Gateway**, **Worker**, **Watchdog** (+ database).
Voice Gateway er en egen prosess fordi sanntidslyd har helt andre latens-, oppetids- og skaleringsbehov
enn resten, og fordi en krasj i talekjeden aldri skal ta ned Core.

## 3. Moduler i Core

| Modul | Ansvar | Viktige grensesnitt |
|---|---|---|
| Identity Service | Personer, enheter, tenants, auth_strength, delegasjoner | `resolveIdentity(request) → IdentityContext` |
| Session Service | Sesjonskontinuitet på tvers av kanaler, aktiv tilstand, gjenopptak | `resumeOrCreate(identity, channel) → Session` |
| Fast Router | Deterministisk intensjonsruting (<100 ms), ingen LLM for kjente kommandoer | `route(input) → FastAction \| ConversationTurn \| JobRequest` |
| Context Builder | Hybrid retrieval fra autoriserte memory spaces innen tokenbudsjett | `build(session, query, budget) → Context` |
| Conversation Engine | Dialog, tur-taking, svarstil, avbrytelse, streaming | `converse(context) → TokenStream` |
| Task Service | Jobb-livssyklus, status, artefakter, varsling | `create/get/cancel/resume(task)` |
| Orchestrator | Planlegging av flertrinnsjobber, delegering til agentprofiler | `plan(job) → Steps`, `dispatch(step)` |
| Policy Gateway | Kontroll av ALLE verktøykall: capability-klasse, mandat, godkjenning, rate | `authorize(toolCall, identity) → Allow \| Deny \| NeedsApproval` |
| Model Gateway | Provideradaptere, modellvalg, budsjett, fallback, rate limits | `complete(request) → Stream`, `embed(texts)` |
| Memory Writer | Uttrekk, dedup, karantene, versjonering, relasjonsbygging | `propose(rawEvent) → ADD\|UPDATE\|INVALIDATE\|NOOP` |
| Notification Service | Telegram, push, e-post, Watch-godkjenninger | `notify(target, message, severity)` |

**Regel:** Alle verktøykall – også fra rask bane – går gjennom Policy Gateway. Rask bane hopper over
LLM-en, aldri over policyen.

## 4. Voice Gateway (egen prosess)

Ansvar: WebRTC-/WebSocket-transport, VAD, ekkokansellering, støyreduksjon, streaming STT inn,
streaming TTS ut, barge-in (≤250 ms stopp av avspilling), romsesjoner og sesjonsgjenopptak etter
failover. Kommuniserer med Core over en typet intern kontrakt (tekst + metadata inn, tekststream +
handlinger ut). Detaljer: [VOICE_ARCHITECTURE.md](VOICE_ARCHITECTURE.md).

## 5. Worker og sandboxing

Worker-prosessen kjører durable jobber bak `WorkflowAdapter`. Agentkjøring (Claude Code/Codex) skjer i
kastbar container per jobb (WSL2/Docker på PC-en): eget filsystem, nettverksallowlist, jobbspesifikke
tokens, ingen hovednøkler. Produksjonsendringer krever PR + tester + menneskelig merge-gate.
Detaljer: [SECURITY_MODEL.md](SECURITY_MODEL.md).

## 6. Dataflyt og lagring

PostgreSQL er den autoritative databasen: identitet, sesjoner, hendelseslogg, minne (alle lag), jobber,
policy, audit og kostnad. Objektlagring for artefakter, lyd-snutter (kun der DPIA tillater) og eksporter.
Menneskelesbar minneeksport genereres fra databasen – aldri motsatt vei.
Detaljer: [MEMORY_ARCHITECTURE.md](MEMORY_ARCHITECTURE.md).

## 7. Edge og steder

Per fysisk sted (hus, hytte): Home Assistant som enhetsbuss + lokal fallback for kritiske
hurtigkommandoer når sky/nett er nede. Sikkerhetsautomasjoner (lås, alarm, varme) er deterministiske i
HA og avhenger aldri av LLM eller skytilkobling. Detaljer: [INTEGRATIONS.md](INTEGRATIONS.md).

## 8. Observability

- **Langfuse** (selvhostet): traces for modellkall, kostnad, latency, evals – alt koblet til `task_id`.
- **Strukturert logging** (JSON) med correlation-ID = `session_id`/`task_id`.
- **Systemmetrics** separat (container-helse, disk, RAM, GPU, temperatur).
- **Watchdog** (egen prosess, også ekstern sjekk): uptime, P95, kø, backup, fastlåste jobber, tokenutløp.
  Kun eksplisitte, reversible tiltak (restart av én tjeneste). Varsling til Telegram med alvorlighetsgrad og runbook.

## 9. Repostruktur (monorepo)

```
jarvis/
├── apps/
│   ├── api/            # Core-prosessen (modulær monolitt)
│   ├── web/            # Webchat-klient
│   └── voice-gateway/  # Egen sanntidsprosess
├── modules/            # Logiske moduler brukt av apps/api
│   ├── core/  memory/  tasks/  policy/  notifications/
├── workers/
│   ├── runner/         # Durable worker-prosess
│   └── profiles/       # Agentprofiler (executive, coding, research, verifier)
├── integrations/       # home-assistant, github, google, telegram, ...
├── packages/
│   ├── contracts/      # Typede kontrakter, skjemaer, hendelsesformat (delt av alt)
│   ├── provider-adapters/
│   └── observability/
├── infra/              # docker-compose (local), senere cloud/edge
└── docs/               # Denne dokumentasjonen
```

Logisk struktur – ikke én deploy per mappe. `packages/contracts` er den eneste delte avhengigheten alle
moduler kan importere fritt; alt annet går via definerte grensesnitt.

## 10. Bevisste avvik fra masterplanen

Se [DECISIONS_AND_ASSUMPTIONS.md](DECISIONS_AND_ASSUMPTIONS.md) for full liste. Viktigst:

- `apps/mobile` og `apps/desktop` opprettes først i fase 8 – ikke tomme mapper fra dag én.
- Workflow-motor starter Postgres-basert (pg-boss el.l.) bak `WorkflowAdapter`; administrert
  Trigger.dev-sky strider mot lokal-først-prinsippet og vurderes først i fase 6.
- Supabase-sky er valgfritt; kravet er ren PostgreSQL med RLS, pgvector, tsvector og pgmq – som kjører
  identisk lokalt i Docker.

## 11. Core Ownership / Adapter Boundary (D-64, permanent styringsinvariant)

**Bakgrunn:** en tidligere utforskende Zendesk-connector (draft-PR #13, aldri merget) ble bygget ved å
tolke masterplanens kapabilitetsnavn "Support/tickets" direkte som "velg en ekstern SaaS-leverandør og
la den eie ticket-domenet". Tobias har eksplisitt overstyrt den arkitekturen: **Support/tickets-
domenet skal være `JARVIS_CANONICAL` (en Native Jarvis Support Core), Zendesk kan senere kobles inn
som en valgfri utførelsesadapter - IKKE motsatt.** Denne seksjonen gjør selve LÆRDOMMEN (kapabilitet ≠
leverandørkrav) permanent, uavhengig av det konkrete Zendesk-utfallet. Se CLAUDE.md regel 12 for den
ufravikelige kortformen, D-64 i DECISIONS_AND_ASSUMPTIONS.md for full beslutningstekst.

### 11.1 Invarianten

Jarvis skal eie den kanoniske domenemodellen, operasjonell tilstand, orkestrering, policy,
minne/proveniens og tverr-domene-resonnering for kapabiliteter som er intrinsic til Jarvis
(`JARVIS_CANONICAL`). Eksterne tjenester skal normalt være kilder/sluk/transporter/adaptere/
utførelsesleverandører (`EXTERNAL_CANONICAL`, med Jarvis-normaliserte pekere/tilstand) - ALDRI stedet
der Jarvis sin kjerneintelligens/domenearkitektur faktisk bor.

Et masterplan-kapabilitetsnavn antyder ALDRI automatisk en leverandør:

- "Support/tickets" betyr IKKE "Zendesk er påkrevd." (Support/tickets ER `JARVIS_CANONICAL` - se §11.9.)
- "Contracts" betyr IKKE automatisk "DocuSign/PandaDoc eier kontraktsdomenet."
- "CRM" betyr IKKE automatisk "HubSpot/Salesforce eier Jarvis sin CRM."

**Dette er IKKE et "bygg alt selv"-prinsipp.** Jarvis skal ikke gjenoppbygge infrastruktur/tjenester
der den eksterne grensen er intrinsic, regulert, standardisert, eller økonomisk irrasjonell å
reprodusere (eksempler: e-postlevering/mailbox-leverandør, betalings-/bankrails, juridisk anerkjent
e-signatur, grunnmodell-leverandører, telefonioperatører, Git-hosting, skyinfrastruktur, HA/
enhetsprotokoll-økosystemet, identitetsleverandører der relevant). Selv i disse tilfellene skal Jarvis
fortsatt eie den leverandør-nøytrale operasjonelle modellen der det er nyttig (Gmail → adapter, Jarvis
Communication Core → kanonisk logikk; Google Calendar → adapter, Jarvis sin planleggingsmodell →
kanonisk orkestrering; OpenAI/Anthropic → modell-leverandører, AI Mesh → kanonisk ruting/policy/kost/
fallback). Målet er **MAKSIMAL SOVEREIGN KONTROLL DER DET FAKTISK BETYR NOE** - ikke maksimal
selv-hosting uansett kostnad.

### 11.2 Core-vs-Adapter-beslutningsport (obligatorisk FØR enhver ny leverandør/connector/SaaS)

Før Claude velger eller implementerer NOEN ny ekstern leverandør, connector eller SaaS, kjøres denne
porten og besvares eksplisitt:

A. Hvilken forretnings-/domenekapabilitet forsøker vi faktisk å tilby?
B. Hvilken kanonisk tilstand skal Jarvis eie?
C. Hvilken del krever faktisk et eksternt system?
D. Kunne Jarvis tilby kjernekapabiliteten uten leverandøren?
E. Hvis leverandøren forsvant i morgen - hvilke Jarvis-kapabiliteter ville stoppe?
F. Kan en annen leverandør substitueres uten å endre Jarvis sin kanoniske domenemodell?
G. Er den foreslåtte leverandøren: CORE DEPENDENCY / OPTIONAL ADAPTER / SOURCE / SINK / TRANSPORT /
   EXECUTION PROVIDER / EXTERNAL SYSTEM OF RECORD?
H. Hvorfor er den klassifiseringen korrekt?
I. Finnes et juridisk/regulatorisk/nettverkseffekt-forhold som gjør ekstern eierskap nødvendig?
J. Hva er drifts-/vedlikeholdskostnaden ved å eie kjernen selv?
K. Betaler vi ved et uhell en leverandør for å eie domenelogikk Jarvis allerede har infrastruktur til
   å eie selv?

Ingen leverandørimplementering starter før denne porten er fullført og dokumentert.

**Trinnrekkefølge (kan IKKE hoppes fra trinn 1 rett til trinn 6):**

1. Identifiser domenekapabilitet.
2. Kjør Core-vs-Adapter-porten.
3. Definer system-of-record.
4. Definer leverandør-nøytral grense (interface).
5. Avgjør om Tobias-godkjenning kreves (§11.3).
6. FØRST DA: leverandør-research/-valg.
7. FØRST DA: anvend D-41 full nyttig kapasitet.

### 11.3 Eksplisitt Tobias-beslutning for nye CORE DEPENDENCIES

Hvis den foreslåtte eksterne tjenesten ville bli en **CORE DEPENDENCY** for Jarvis: STOPP.
Rapporter `CORE_DEPENDENCY_DECISION_REQUIRED=true` og forklar: hva Jarvis ville bli avhengig av, hva
som stopper å fungere hvis leverandøren forsvinner, lock-in, kostnad, migrasjonsvei, og det
native-kjerne-alternativet. Krev deretter Tobias sin eksplisitte beslutning FØR implementering. Velg
ALDRI leverandøren stille.

En **OPTIONAL ADAPTER** krever IKKE samme arkitektoniske eskalering når kjernen allerede fungerer
uavhengig av den.

**Forbudte begrunnelser for å gjøre en leverandør til domenekjernen** (bekvemmelighet/popularitet er
input til ADAPTER-valg, ALDRI tilstrekkelig grunn til å eksternalisere kjernen):

- "Zendesk løser allerede dette, derfor bruk Zendesk [som kjerne]."
- "HubSpot er populær, derfor bruk HubSpot [som kjerne]."
- "DocuSign er standard, derfor gjør det til kjernen."

### 11.4 Forhold til D-41 (Owner Connector Capability Invariant)

D-41 og D-64 er to SEPARATE beslutninger som IKKE skal forveksles:

1. **BØR denne leverandøren være en del av arkitekturen i det hele tatt, og med hvilken rolle?**
   (D-64 sitt spørsmål - kjøres FØRST.)
2. **HVIS JA (leverandør-/connector-grense akseptert): hvor fullstendig skal connectoren være?**
   (D-41 sitt spørsmål - full nyttig les/skriv/slett/tilgangsstyring, ALDRI read-only som standard.)

D-41 er ALDRI en begrunnelse for å gjøre en leverandør til Jarvis sin kanoniske domenekjerne - D-41
forutsetter at grensen allerede er akseptert av D-64-porten.

### 11.5 System-of-record-klassifisering

Hvert domene klassifiseres eksplisitt til én av:

- **JARVIS_CANONICAL** - Jarvis eier den autoritative tilstanden/domenemodellen.
- **EXTERNAL_CANONICAL** - leverandøren er autoritativ kilde; Jarvis holder normaliserte
  pekere/avledet tilstand, ALDRI en konkurrerende full kopi.
- **HYBRID_WITH_CLEAR_AUTHORITY** - deler av domenet er Jarvis-autoritativt, andre deler
  leverandør-autoritative, med en EKSPLISITT, dokumentert grense mellom dem (ALDRI tvetydig
  dobbel-eierskap).

### 11.6 Portabilitets- og utfallstest (gjenbrukbar sjekkliste)

**Portabilitetstest:** "Kan vi erstatte leverandør X uten å skrive om domenekjernen?" For en
adapter-basert integrasjon er ønsket svar JA (Gmail → Microsoft 365; OpenAI → Anthropic/lokal; en
fremtidig Support Core sin Zendesk-adapter → en annen support-leverandør; Vercel → et annet
deploy-mål). Krever substitusjon en FULL omskriving av domenemodellen, flagg
`PROVIDER_LOCK_IN_ARCHITECTURE_RISK` og krev eksplisitt begrunnelse.

**Utfallstest:** "Hva skjer hvis denne leverandøren er utilgjengelig i 24 timer?" Klassifiser
`DEGRADED` / `FEATURE_UNAVAILABLE` / `CORE_SYSTEM_DOWN`. Jarvis skal unngå unødvendige
`CORE_SYSTEM_DOWN`-forhold - der mulig skal et leverandørutfall gi degradert kapasitet mens Jarvis sin
kanoniske tilstand og resonnering fortsetter å fungere.

**Dataeierskapstest:** for hver leverandør: hvilke data finnes KUN der? Hvilken metadata/tilstand må
Jarvis beholde? Kan Jarvis eksportere/migrere? Ødelegger leverandør-sletting Jarvis sin operasjonelle
kontinuitet? Kopieres for mye leverandørdata inn (peker foretrekkes fremfor kopi)? Hvordan fungerer
Q-20-utslettelse? Hvem er autoritativ når tilstandene er i konflikt?

### 11.7 AI/kunnskap - spesialtilfelle (kobling til Q-26)

Søkemotorer, nettsider, eksterne API-er og LLM-er er KILDER. De skal ALDRI bli Jarvis sin kanoniske
sannhetslag. Et eksternt forskningsfunn ≠ verifisert Jarvis-kunnskap. Q-26 (Knowledge Verification /
Truth Promotion Invariant, registrert D-63) forblir den kanoniske FREMTIDIGE løsningen for å håndheve
dette skillet permanent - IKKE implementert i denne runden (D-64 kobler eksplisitt til Q-26 uten å
utvide den).

### 11.8 Leverandørbeslutningsmal (obligatorisk for hver fremtidig ny connector-byggeordre)

```
CAPABILITY=
JARVIS_CORE=
EXTERNAL_ROLE=
SYSTEM_OF_RECORD=
WHY_EXTERNAL=
CAN_RUN_WITHOUT_PROVIDER=
REPLACEMENT_PATH=
OUTAGE_BEHAVIOR=
DATA_AUTHORITY=
Q20_IMPACT=
Q21_IMPACT=
D41_SCOPE=
LOCK_IN_RISK=
TOBIAS_APPROVAL_REQUIRED=
```

### 11.9 Masterplan-avhengighetsaudit (engangs, 2026-08-18, D-64)

Repo-sannhet revidert (ikke gjettet) mot faktisk connector-/adapterkode PÅ `origin/main`. Ingen endring
implementert i denne runden - klassifisering + handling-påkrevd-flagg only.

| Domene | Nåværende leverandør | Rolle | System-of-record | Core dep? | Bør Jarvis eie kjerne? | Bør provider være valgfri adapter? | Portabilitet | Utfall (24t) | Lock-in | Handling påkrevd |
|---|---|---|---|---|---|---|---|---|---|---|
| E-post | Gmail | Adapter (`GmailTransport`) | EXTERNAL_CANONICAL (mailbox-innhold) | Nei | Nei (mailbox-protokoll er intrinsic ekstern) | Ja, allerede adapter | JA (M365 substituerbar) | DEGRADED | LAV | Ingen - allerede korrekt grense |
| Kalender | Google Calendar | Adapter (`GoogleCalendarTransport`) | EXTERNAL_CANONICAL (arrangement-data) | Nei | Nei | Ja, allerede adapter | JA | DEGRADED | LAV | Ingen - allerede korrekt grense |
| Filer/kunnskap | Google Drive | Adapter (`GoogleDriveTransport`, én av flere `KnowledgeSource`) | EXTERNAL_CANONICAL (fil-innhold); Jarvis eier `knowledge_documents` som kanonisk kunnskapslag | Nei | Delvis allerede (Jarvis eier kunnskapsarkitekturen, Drive er KUN en kilde blant flere) | Ja, allerede adapter | JA | DEGRADED | LAV | Ingen - allerede korrekt grense |
| Kildekode/CI | GitHub | Adapter (delvis, PARTIAL-connector) | EXTERNAL_CANONICAL (repo/PR er intrinsic Git-hosting) | Nei | Nei (Git-hosting er standardisert/økonomisk irrasjonelt å reprodusere) | Ja | JA (GitLab/etc. substituerbar) | FEATURE_UNAVAILABLE | LAV | Ingen - korrekt grense, kun kapabilitetsgap (D-41-backlog, se PROJECT_STATUS.md) |
| Varsling | Telegram | Adapter (PARTIAL-connector) | N/A (transport, ingen domenetilstand) | Nei | N/A | Ja | JA | FEATURE_UNAVAILABLE | LAV | Ingen |
| Deploy | Vercel | Adapter (READ_ONLY-connector) | EXTERNAL_CANONICAL (deploy-status) | Nei | Nei | Ja | JA | FEATURE_UNAVAILABLE | LAV | Ingen |
| Enhetsstyring | Home Assistant | Enhetsbuss (CLAUDE.md-regel 5, ALDRI samtalemotor) | EXTERNAL_CANONICAL (enhetstilstand) | Nei | Nei (protokoll-økosystem er intrinsic ekstern) | Ja, allerede korrekt rolle | JA | DEGRADED | LAV | Ingen - allerede korrekt grense |
| AI-modeller | OpenAI/Anthropic/Gemini/Kimi/Ollama | Modell-leverandører bak `ModelGateway` | N/A (grunnmodell er intrinsic ekstern for alle utenom lokal Ollama) | Delvis (foundation-modeller generelt er en bransjebred avhengighet) | Nei for selve modellen; JA for ruting/policy/kost/fallback (allerede eid av AI Mesh/`ModelGateway`) | Ja, allerede adapter-mønster (`ModelProvider`-abstraksjon) | JA (bevist - flere providere allerede kablet) | DEGRADED (fallback-kjede) | LAV (multi-provider by design) | Ingen - dette ER referanse-eksempelet på korrekt grense (§11.1) |
| Tale (STT/TTS) | (Q-03, ikke endelig valgt) | Planlagt adapter (`SpeechAdapter`, CLAUDE.md-regel 3) | EXTERNAL_CANONICAL (lyd-transkripsjon/-syntese er intrinsic leverandørkapasitet) | Nei | Nei | Ja, allerede designet som adapter | JA (Q-03 sitt eget krav) | DEGRADED (fallback lokal STT/TTS eksplisitt i utfallsrommet) | LAV | Ingen - allerede korrekt grense, kun leverandørvalg gjenstår (Q-03) |
| **Support/tickets** | **INGEN ekstern leverandør canonical** (tidligere utforskende Zendesk-connector, draft-PR #13, ALDRI merget - se §11.10) | **Native Jarvis Support Core** (JARVIS_CANONICAL, EKSPLISITT Tobias-beslutning 2026-08-18) - Zendesk (eller en annen provider) kan senere kobles inn som en VALGFRI utførelses-/kanaladapter, ALDRI som domeneeier | **JARVIS_CANONICAL** - ticket-entitet, livssyklus/tilstandsmaskin, motpart-kobling, Business OS-integrasjon eies av Jarvis, uavhengig av om/hvilken ekstern kanal-adapter senere kobles inn | Nei (nettopp FORDI kjernen nå er Jarvis-egen) | **JA - allerede besluttet, IKKE implementert i denne runden** (egen fremtidig slice) | Ja - enhver fremtidig ekstern support-kanal (Zendesk eller annet) kobles inn KUN som en utskiftbar utførelsesadapter bak et leverandør-nøytralt grensesnitt | JA (per design - domenekjernen er leverandør-nøytral fra dag én) | Ikke relevant før en adapter faktisk finnes | LAV (per design) | **Bygg Native Jarvis Support Core som EGEN, fremtidig, eksplisitt godkjent slice - IKKE i denne governance-runden** (se §11.10, Q-27 for det uavhengige RLS-produksjonsfunnet fra samme kildebranch) |
| Kontrakter/e-signatur | (ingen, ikke bygget) | Ikke bygget | Ikke besluttet | Sannsynligvis delvis (se §11.11) | JA for kontraktsdomenet (motpart/versjon/status/frist/forpliktelse/kobling til Business OS) | JA for selve SIGNATUR-UTFØRELSEN (identitetsverifisering/juridisk-anerkjent signatur/bevis) | Ikke besluttet ennå | Ikke besluttet ennå | Ikke besluttet ennå | Se §11.11 - forebyggende grenseanalyse, INGEN leverandør velges i denne runden |
| Finans/regnskap (fremtidig UA-6) | (ingen, ikke bygget) | Ikke bygget | Sannsynlig HYBRID (banktransaksjon EXTERNAL_CANONICAL, Jarvis sine avledede projeksjoner/varsler JARVIS_CANONICAL) | Ukjent til UA-6 designes | Delvis (Jarvis bør eie avledet tilstand/varsling, ALDRI selve bankledgeren) | Ja for selve bank-/betalingsrailen | Ikke besluttet ennå | Ikke besluttet ennå | Ikke besluttet ennå | Egen D-64-port kjøres FØR UA-6 starter - ingen leverandør navngitt noe sted i dagens docs |
| Betalinger (fremtidig) | (ingen, ikke bygget) | Ikke bygget | EXTERNAL_CANONICAL (betalingsrails er intrinsic regulert ekstern) | Sannsynlig JA for selve betalingsutførelsen | Nei for selve railen; JA for Jarvis sin avledede tilstand/varsling | Ja | Ikke besluttet ennå | Ikke besluttet ennå | Ikke besluttet ennå | Egen D-64-port kjøres FØR noe bygges |
| Flere CRM-integrasjoner (Q-16, "andre bølge") | (ingen, ikke bygget, kun Business OS i dag) | Ikke bygget | JARVIS_CANONICAL (Business OS, D-49, allerede etablert) | Nei | JA - ALLEREDE korrekt (Business OS er Jarvis sin egen CRM-kjerne, ikke HubSpot/Salesforce) | N/A - eksterne CRM-er (Dennis m.fl., Q-16) ville KUN vært synk-adaptere INN i Business OS, aldri erstatte den | Ikke relevant - Business OS er allerede kjernen | Ikke relevant | LAV (Business OS er allerede Jarvis-eid) | Ingen - dette ER et allerede-korrekt eksempel, samme mønster ønsket for fremtidige CRM-synk-adaptere |
| Meldingskanaler (fremtidig, Slack/Teams, Q-16) | (ingen, ikke bygget) | Planlagt adapter-mønster (samme som Telegram) | N/A (transport) | Nei | N/A | Ja | Sannsynlig JA | FEATURE_UNAVAILABLE | LAV | Ingen umiddelbar - følg samme mønster som Telegram når bygget |
| Observability | Langfuse (D-27, IMPLEMENTED_NOT_VERIFIED) | Trace-sink bak `LangfuseTraceSink` | EXTERNAL_CANONICAL for selve trace-lagringen; Jarvis sin egen `audit_events`/`cost_events` er UAVHENGIG kanonisk (ikke avhengig av Langfuse for korrekthet) | Nei | Nei - allerede korrekt (audit/cost er Jarvis-egne tabeller, Langfuse er et EKSTRA observability-lag) | Ja, allerede adapter-mønster | JA | DEGRADED (audit/cost fortsetter uavhengig) | LAV | Ingen - allerede korrekt grense |
| Secret-håndtering | SOPS/age i dag; Infisical/OpenBao planlagt (Q-05) | `SecretProvider`-abstraksjon | JARVIS_CANONICAL (secret-TILGANGSMØNSTERET er Jarvis sitt eget; selve vaulten er utskiftbar bak `SecretProvider`) | Nei | JA - allerede korrekt (`SecretProvider` er allerede leverandør-nøytral) | Ja, allerede adapter-mønster | JA (Q-05 sitt eget valgspørsmål viser dette) | Ikke relevant (lokal fil-basert i dag) | LAV | Ingen - allerede korrekt grense |

### 11.10 Zendesk-historikk og pre-eksisterende RLS-produksjonsfunn (draft-PR #13, IKKE merget)

**Zendesk-connectoren (draft-PR #13, branch `claude/ua3-zendesk-support-connector`) er SUPERSEDED /
UNMERGED EXPERIMENTAL IMPLEMENTATION.** Den ble bygget som om Zendesk skulle eie hele
ticket-livssyklusen (opprettelse/svar/status/sletting utført direkte hos Zendesk, Jarvis lagret kun en
peker) - nøyaktig det mønsteret §11.1 nå eksplisitt forbyr. Tobias har besluttet at Support/tickets
skal være `JARVIS_CANONICAL` (§11.9) - PR #13 merges IKKE. Branchen/historikken bevares (IKKE slettet)
som en mulig fremtidig referanse for en Zendesk-adapter DEN DAGEN en Native Jarvis Support Core faktisk
kobler inn en ekstern kanal.

**Ekte, uavhengig funn fra samme kildebranch - re-verifisert direkte mot `origin/main` sin faktiske
kildekode i DENNE runden (IKKE tatt for gitt fra PR #13 sin tekst):** tre EKSISTERENDE, allerede-i-
produksjon funksjoner bruker en rå, uskopet spørring mot `tenants`-tabellen som strukturelt ALLTID
returnerer 0 rader:

- `runOpenLoopSweepForAllTenants()` (`modules/business/src/open-loop-sweep.ts:15-20`, D-53)
- `runBusinessEventSyncForAllTenants()` (`modules/business/src/business-event-sync.ts:288-293`, D-57)
- `runScoringSweepForAllTenants()` (`modules/business/src/scoring-sweep.ts:14-19`, D-61)

Alle tre kjører `pool.query("SELECT tenant_id FROM tenants WHERE kind = 'business' ORDER BY tenant_id LIMIT 200")`
direkte mot DEN DELTE runtime-`pool`-en (`apps/api/src/main.ts` sin `createPool(configFromEnv())`,
verifisert `assertRuntimeRoleSafe`-bevoktet - `jarvis_runtime`, NOSUPERUSER/NOBYPASSRLS) - UTEN å sette
`jarvis.tenant_id` FØRST. `tenants`-tabellen har `FORCE ROW LEVEL SECURITY` med policyen
`tenant_id = current_setting('jarvis.tenant_id', true)` (`005_rls.sql`); uten en satt
`jarvis.tenant_id` evaluerer denne ALDRI til true for noen rad. Verifisert direkte i kildekoden på
`origin/main` (ikke gjettet, ikke tatt fra den forkastede branchen sin egen tekst) at INGEN av de tre
har en test som fanger dette: `runOpenLoopSweepForAllTenants` har `modules/business/test/
open-loop-sweep.test.ts`, men den bruker en `fakePool()` som er en ren in-memory-mock
(`{ query: async () => ({ rows: tenantRows }) }`) - den omgår RLS FULLSTENDIG i stedet for å bevise
noe om RLS. `runBusinessEventSyncForAllTenants`/`runScoringSweepForAllTenants` har INGEN test som
kaller dem direkte i det hele tatt. Alle tre er `DailyScheduler`-trigget i produksjon
(`apps/api/src/main.ts`, job_names `business-open-loop-sweep`/`business-events-sync`/
`business-scoring-recalc`) og har derfor sannsynligvis ALDRI oppdaget en eneste tenant når de faktisk
har kjørt siden hver ble satt i drift. **Registrert som Q-27 - se OPEN_QUESTIONS.md. IKKE fikset i
denne governance-runden** (denne runden er dokumentasjon/styring, ikke en kodefiks-runde) - fiksmønsteret
(en `SECURITY DEFINER`-katalogfunksjon som eksponerer KUN `tenant_id`/`kind`, samme prinsipp som
allerede prototypet i den forkastede Zendesk-branchen) er kjent og klart for en egen, liten,
eksplisitt godkjent BO.

### 11.11 Contracts/e-sign - forebyggende grenseanalyse (IKKE en leverandørbeslutning, IKKE bygget)

Contracts/e-sign er den neste konkrete risikoen for å gjenta Zendesk-feilen. FØR noen
Contracts/e-sign-leverandør velges, skilles eksplisitt:

- **CONTRACT CORE (sannsynlig JARVIS_CANONICAL):** kontrakt, motpart, versjon, status, fornyelse,
  frist, forpliktelse, kildedokument, godkjenningstilstand, Business OS-kobling, open loops - dette er
  domenetilstand Jarvis bør eie uavhengig av hvilken signaturleverandør som til slutt brukes.
- **SIGNATURE EXECUTION PROVIDER (nødvendigvis ekstern, juridisk/regulatorisk grense - §11.1
  eksempel-kategori):** identitetsverifisering, juridisk-anerkjent signatur, signatur-bevis,
  signatur-levering/-utførelse. Dette er en av de tilfellene der ekstern eierskap er begrunnet
  (juridisk anerkjennelse er en nettverkseffekt/regulatorisk grense Jarvis ikke kan reprodusere selv).

**Ingen leverandør velges i denne runden.** Når Contracts/e-sign faktisk bygges, kjøres §11.2-porten
FØRST - kontraktskjernen designes som Jarvis-egen domenemodell, og signaturleverandøren (f.eks.
DocuSign/Dropbox Sign - kun eksempler) kobles inn KUN som en utskiftbar
SIGNATURE-EXECUTION-adapter bak et leverandør-nøytralt grensesnitt, ALDRI som eier av selve
kontraktsdomenet. Registrert som Q-28 - se OPEN_QUESTIONS.md.
